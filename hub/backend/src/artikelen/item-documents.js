// PDF's bij artikelen (tabel item_documents, migratie 105): productinformatie van de leverancier of fabrikant.
//
// - Bij het uploaden controleert en herbouwt de server de PDF (inspectSlip uit order-slips.js: echte PDF, niet beveiligd, zonder
//   annotaties, paginaacties en metadata; de controle draait in een werkthread). Hoogstens 10 MB, 40 pagina's en 5 PDF's per artikel.
// - Bewaard wordt de schone PDF, versleuteld met vault.sealBytes (AAD = omgeving + document), dus ook in back-ups.
// - Dezelfde inhoud twee keer bij hetzelfde artikel wordt één keer bewaard. `public` bepaalt of de PDF op de productpagina te downloaden is.
const crypto = require('crypto');
const express = require('express');
const { inspectSlip } = require('../webshop/order-slips');

/** Hoogstens zoveel bytes en pagina's per PDF, en zoveel PDF's per artikel. */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_PAGES = 40;
const MAX_PER_ITEM = 5;
const DOCUMENT_ID_PATTERN = /^[0-9a-f-]{36}$/;

/**
 * Een leesbare bestandsnaam voor een PDF (zonder pad, ingekort, altijd op .pdf).
 * @param {string} name De opgegeven naam.
 * @returns {string} De naam.
 */
function cleanName(name) {
  const base = String(name || '').replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f<>"]/g, '').replace(/\.pdf$/i, '').trim().slice(0, 80);
  return `${base || 'Productinformatie'}.pdf`;
}

/**
 * Maakt de opslag voor PDF's bij artikelen.
 * @param {object} db De database.
 * @param {{ vault: object }} options vault = de kluis (sealBytes/openBytes).
 * @returns {{ add: Function, seed: Function, list: Function, file: Function, bodies: Function, setPublic: Function, remove: Function }} De functies.
 */
function createItemDocumentStore(db, { vault }) {
  /**
   * De AAD waaronder een PDF wordt versleuteld.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van het document.
   * @returns {string} De context.
   */
  const aadOf = (tenantId, id) => `${tenantId}:artikel-pdf:${id}`;

  /**
   * Controleert en bewaart een PDF bij een artikel.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {Buffer} raw De ontvangen bytes.
   * @param {{ name?: string }} [options] De bestandsnaam.
   * @returns {Promise<{ document?: object, error?: string, message?: string, status?: number }>} Het bewaarde document (zonder inhoud), of een fout.
   */
  async function add(tenantId, itemId, raw, { name = '' } = {}) {
    const item = db.prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, String(itemId));
    if (!item) return { error: 'not_found', message: 'Artikel niet gevonden.', status: 404 };
    // De hash is die van het ontvangen bestand: de schone PDF krijgt bij elke controle een nieuw aanmaaktijdstip en zou nooit gelijk zijn.
    const contentHash = crypto.createHash('sha256').update(raw).digest('hex');
    /**
     * Of er nog plek is voor deze PDF bij het artikel en hij er nog niet staat.
     * @returns {?{ error: string, message: string, status: number }} Een fout, of null als de PDF erbij mag.
     */
    const refusal = () => {
      const count = Number(db.prepare('SELECT COUNT(*) AS n FROM item_documents WHERE tenant_id = ? AND item_id = ?').get(tenantId, item.id).n);
      if (count >= MAX_PER_ITEM) return { error: 'too_many', message: `Een artikel heeft hoogstens ${MAX_PER_ITEM} PDF's.`, status: 409 };
      if (db.prepare('SELECT id FROM item_documents WHERE tenant_id = ? AND item_id = ? AND content_hash = ?').get(tenantId, item.id, contentHash)) return { error: 'duplicate', message: 'Deze PDF staat al bij dit artikel.', status: 409 };
      return null;
    };
    // Eerst goedkoop weigeren, vóór de zware controle; na de controle (een await) opnieuw, want een gelijktijdige upload kan intussen zijn bewaard.
    const early = refusal();
    if (early) return early;
    const checked = await inspectSlip(raw, { maxBytes: MAX_DOCUMENT_BYTES, maxPages: MAX_DOCUMENT_PAGES, label: 'De PDF' });
    if (checked.busy) return { error: 'busy', message: checked.error, status: 429 };
    if (checked.error) return { error: 'invalid_pdf', message: checked.error, status: 400 };
    // Vanaf hier tot de INSERT zit geen await meer: controle en opslag zijn één stap.
    const late = refusal();
    if (late) return late;
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare('INSERT INTO item_documents (id, tenant_id, item_id, name, pages, size, content_hash, public, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, tenantId, item.id, cleanName(name), checked.pages, checked.bytes.length, contentHash, vault.sealBytes(checked.bytes, aadOf(tenantId, id)), timestamp);
    return { document: { id, name: cleanName(name), pages: checked.pages, size: checked.bytes.length, public: true, createdAt: timestamp } };
  }

  /**
   * Bewaart een PDF zonder controle (alleen voor testdata, waar de server de PDF zelf maakt).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {Buffer} bytes De PDF.
   * @param {{ name: string, pages: number }} details Bestandsnaam en aantal pagina's.
   * @returns {string} Id van het document.
   */
  function seed(tenantId, itemId, bytes, { name, pages }) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO item_documents (id, tenant_id, item_id, name, pages, size, content_hash, public, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, tenantId, itemId, cleanName(name), pages, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), vault.sealBytes(bytes, aadOf(tenantId, id)), new Date().toISOString());
    return id;
  }

  /**
   * De PDF's van een artikel (zonder inhoud), oudste eerst.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {{ id: string, name: string, pages: number, size: number, public: boolean, createdAt: string }[]} De PDF's.
   */
  function list(tenantId, itemId) {
    return db.prepare('SELECT id, name, pages, size, public, created_at FROM item_documents WHERE tenant_id = ? AND item_id = ? ORDER BY created_at, id').all(tenantId, String(itemId))
      .map((row) => ({ id: row.id, name: row.name, pages: Number(row.pages), size: Number(row.size), public: Number(row.public) === 1, createdAt: row.created_at }));
  }

  /**
   * De inhoud van een PDF.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} documentId Id van het document.
   * @param {{ publicOnly?: boolean }} [options] publicOnly = alleen als hij op de productpagina getoond mag worden.
   * @returns {?{ name: string, body: Buffer }} De PDF, of null als hij niet bestaat, niet openbaar is (ook niet als het artikel gearchiveerd is) of niet te lezen is.
   */
  function file(tenantId, documentId, { publicOnly = false } = {}) {
    if (!DOCUMENT_ID_PATTERN.test(String(documentId))) return null;
    const row = db.prepare('SELECT d.name, d.public, d.data, i.archived FROM item_documents d JOIN stock_items i ON i.tenant_id = d.tenant_id AND i.id = d.item_id WHERE d.tenant_id = ? AND d.id = ?').get(tenantId, String(documentId));
    if (!row || (publicOnly && (Number(row.public) !== 1 || Number(row.archived) === 1))) return null;
    try { return { name: row.name, body: vault.openBytes(row.data, aadOf(tenantId, String(documentId))) }; } catch (error) { return null; }
  }

  /**
   * De inhoud van alle PDF's van een artikel (voor het lezen door de AI), met unieke bestandsnamen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {{ id: string, name: string, body: Buffer }[]} De PDF's; een PDF die niet te lezen is wordt overgeslagen.
   */
  function bodies(tenantId, itemId) {
    const used = new Set();
    const out = [];
    for (const entry of list(tenantId, itemId)) {
      const found = file(tenantId, entry.id);
      if (!found) continue;
      let name = found.name;
      for (let number = 2; used.has(name); number += 1) name = found.name.replace(/\.pdf$/i, ` (${number}).pdf`);
      used.add(name);
      out.push({ id: entry.id, name, body: found.body });
    }
    return out;
  }

  /**
   * Zet een PDF wel of niet op de productpagina.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} documentId Id van het document.
   * @param {boolean} isPublic Wel (true) of niet (false) tonen.
   * @returns {boolean} false als het document niet bestaat.
   */
  function setPublic(tenantId, documentId, isPublic) {
    if (!DOCUMENT_ID_PATTERN.test(String(documentId))) return false;
    const result = db.prepare('UPDATE item_documents SET public = ? WHERE tenant_id = ? AND id = ?').run(isPublic ? 1 : 0, tenantId, String(documentId));
    return Number(result.changes) > 0;
  }

  /**
   * Verwijdert een PDF.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} documentId Id van het document.
   * @returns {boolean} false als het document niet bestaat.
   */
  function remove(tenantId, documentId) {
    if (!DOCUMENT_ID_PATTERN.test(String(documentId))) return false;
    const result = db.prepare('DELETE FROM item_documents WHERE tenant_id = ? AND id = ?').run(tenantId, String(documentId));
    return Number(result.changes) > 0;
  }

  return { add, seed, list, file, bodies, setPublic, remove };
}

/**
 * Registreert de routes voor PDF's bij artikelen (recht `voorraad`, per omgeving).
 * @param {object} app De Express-app.
 * @param {{ documents: object, requireRight: Function, requireJson: Function, audit: Function, uploadLimiter?: Function }} ctx documents = createItemDocumentStore, uploadLimiter = begrenzing van het uploaden.
 * @returns {void}
 */
function registerItemDocumentRoutes(app, { documents, requireRight, requireJson, audit, uploadLimiter = (req, res, next) => next() }) {
  const requireStock = requireRight('voorraad');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Leest de PDF uit het verzoek (type application/pdf, hoogstens 10 MB); bij een fout een JSON-melding.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next Volgende stap als de PDF is gelezen.
   * @returns {void}
   */
  const readPdfBody = (req, res, next) => {
    express.raw({ type: 'application/pdf', limit: MAX_DOCUMENT_BYTES })(req, res, (failure) => {
      if (failure) return res.status(failure.status === 413 ? 413 : 400).json({ error: 'invalid_pdf', message: failure.status === 413 ? `De PDF is te groot (hoogstens ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB).` : 'De PDF kon niet worden gelezen.' });
      next();
    });
  };

  app.get('/api/stock/items/:id/documents', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ documents: documents.list(tenantOf(req), req.params.id) });
  });

  // De bestandsnaam staat URL-gecodeerd in de kop X-Bestandsnaam; de PDF zelf is de body (application/pdf).
  app.post('/api/stock/items/:id/documents', requireStock, uploadLimiter, readPdfBody, async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(415).json({ error: 'invalid_pdf', message: 'Stuur een PDF-bestand (application/pdf).' });
    let name = '';
    try { name = decodeURIComponent(String(req.get('X-Bestandsnaam') || '')); } catch (error) { name = ''; }
    // Een eigen kopie van de bytes: de PDF is hier zeker een Buffer, nooit een tekst of rij uit het verzoek.
    const out = await documents.add(tenantOf(req), req.params.id, Buffer.from(req.body), { name });
    if (out.error) {
      if (out.status === 429) res.setHeader('Retry-After', '10');
      return res.status(out.status || 400).json({ error: out.error, message: out.message });
    }
    audit(req, 'voorraad_pdf_toegevoegd', { itemId: req.params.id, documentId: out.document.id });
    res.status(201).json(out.document);
  });

  app.patch('/api/stock/documents/:id', requireJson, requireStock, (req, res) => {
    if (typeof (req.body && req.body.public) !== 'boolean') return res.status(400).json({ error: 'invalid', message: 'Geef public op als true of false.' });
    if (!documents.setPublic(tenantOf(req), req.params.id, req.body.public)) return res.status(404).json({ error: 'not_found', message: 'PDF niet gevonden.' });
    audit(req, 'voorraad_pdf_gewijzigd', { documentId: req.params.id, public: req.body.public });
    res.json({ public: req.body.public });
  });

  app.delete('/api/stock/documents/:id', requireStock, (req, res) => {
    if (!documents.remove(tenantOf(req), req.params.id)) return res.status(404).json({ error: 'not_found', message: 'PDF niet gevonden.' });
    audit(req, 'voorraad_pdf_verwijderd', { documentId: req.params.id });
    res.json({ ok: true });
  });

  // Downloaden in het beheer; de openbare shop krijgt zijn eigen route.
  app.get('/api/stock/documents/:id', requireStock, (req, res) => {
    const found = documents.file(tenantOf(req), req.params.id);
    if (!found) return res.status(404).end();
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${found.name.replace(/[^\w.\- ]/g, '_')}"`);
    res.type('application/pdf').send(found.body);
  });
}

module.exports = { createItemDocumentStore, registerItemDocumentRoutes, MAX_DOCUMENT_BYTES, MAX_PER_ITEM };
