// Afbeeldingen bij artikelen (tabel item_images, kolom stock_items.image_id, migratie 41).
//
// - Een artikel heeft hoogstens één afbeelding. De browser verkleint hem; de
//   server controleert het formaat op inhoud (JPEG, PNG of WebP), haalt bij JPEG
//   de metadata weg en bewaart hem versleuteld in de database (vault.sealBytes,
//   AAD = tenant + afbeelding-id). Zo gaat hij mee in de back-ups en in
//   PostgreSQL, en wist het verwijderen van een tenant hem ook.
// - Dezelfde foto (SHA-256 van de inhoud) wordt één keer bewaard en door meerdere
//   artikelen gedeeld, bijvoorbeeld de varianten van een product.
// - Overnemen uit de oude webshop: artikelen zonder eigen afbeelding waarvan het
//   gekoppelde webshopproduct een afbeelding op een https-adres heeft, worden in
//   porties gedownload (alleen openbare adressen, zonder omleidingen, met een
//   grens in bytes) en daarna als eigen afbeelding gebruikt. Opnieuw uitvoeren
//   neemt alleen over wat nog ontbreekt.
// - De openbare shop toont de afbeelding via `winkel/artikelfoto/<id>`; het
//   beheer via `/api/stock/images/<id>`.
const crypto = require('crypto');
const { inspectImage, fromBase64, MAX_IMAGE_BYTES, MAX_SIDE } = require('../uitvoering/photos');
const { publicAddress } = require('../beveiliging/netguard');
const { pinnedFetch, readBytesLimited } = require('../beveiliging/pinned-fetch');

const DOWNLOAD_TIMEOUT_MS = 10000;
const IMPORT_PAGE_SIZE = 25;
const IMPORT_CONCURRENCY = 5;
const IMAGE_ID_PATTERN = /^[0-9a-f-]{36}$/;

/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * Een leesbare bestandsnaam voor een afbeelding (zonder pad, ingekort).
 * @param {string} name De opgegeven naam of het adres.
 * @returns {string} De naam, of 'afbeelding' als er niets overblijft.
 */
function cleanName(name) {
  const text = String(name || '').split('?')[0].replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f<>"]/g, '').trim();
  return text.slice(0, 80) || 'afbeelding';
}

/**
 * Of een adres een afbeelding is die we mogen ophalen: https (of http/lokaal alleen in de tests).
 * @param {string} text Het adres.
 * @returns {URL|null} Het adres als URL, of null.
 */
function importableUrl(text) {
  let url;
  try { url = new URL(String(text || '').trim()); } catch (error) { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url;
  return process.env.SHOP_ALLOW_INSECURE === '1' && url.protocol === 'http:' ? url : null;
}

/**
 * Maakt de opslag voor artikelafbeeldingen.
 * @param {object} db De database.
 * @param {{ vault: object, fetchImpl?: Function|null, resolveHost?: Function }} options vault = de kluis (sealBytes/openBytes), fetchImpl = eigen fetch (tests), resolveHost = zoekt een hostnaam op (alleen openbare adressen).
 * @returns {{ setForItem: Function, clearForItem: Function, file: Function, importFromShop: Function, prune: Function, pendingImport: Function, library: Function }} De functies.
 */
function createItemImageStore(db, { vault, fetchImpl = null, resolveHost = publicAddress }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * De AAD waaronder een afbeelding wordt versleuteld.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de afbeelding.
   * @returns {string} De context.
   */
  const aadOf = (tenantId, id) => `${tenantId}:artikel-afbeelding:${id}`;

  /**
   * Verwijdert afbeeldingen waar geen artikel meer naar verwijst.
   * @param {string} tenantId Id van de omgeving.
   * @returns {void}
   */
  function prune(tenantId) {
    prepare('DELETE FROM item_images WHERE tenant_id = ? AND NOT EXISTS (SELECT 1 FROM stock_items i WHERE i.tenant_id = ? AND i.image_id = item_images.id)').run(tenantId, tenantId);
  }

  /**
   * Controleert en bewaart een afbeelding; dezelfde inhoud wordt hergebruikt.
   * @param {string} tenantId Id van de omgeving.
   * @param {Buffer} raw De bytes van het bestand.
   * @param {{ name?: string, sourceUrl?: string|null }} [origin] Bestandsnaam en het adres waarvan hij komt.
   * @returns {{ imageId?: string, error?: string, message?: string, status?: number }} Het id van de afbeelding, of een fout.
   */
  function storeImage(tenantId, raw, { name = '', sourceUrl = null } = {}) {
    if (!raw || !raw.length) return { error: 'invalid_image', message: 'Dit is geen geldige afbeelding.', status: 400 };
    if (raw.length > MAX_IMAGE_BYTES) return { error: 'too_large', message: `De afbeelding is te groot (maximaal ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`, status: 413 };
    const image = inspectImage(raw);
    if (!image || image.width > MAX_SIDE || image.height > MAX_SIDE) return { error: 'invalid_image', message: 'Alleen JPEG, PNG of WebP tot 8000 pixels.', status: 400 };
    const contentHash = crypto.createHash('sha256').update(image.body).digest('hex');
    const existing = prepare('SELECT id FROM item_images WHERE tenant_id = ? AND content_hash = ?').get(tenantId, contentHash);
    if (existing) return { imageId: existing.id };
    const id = crypto.randomUUID();
    prepare('INSERT INTO item_images (id, tenant_id, name, mime, width, height, size, content_hash, source_url, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, tenantId, cleanName(name), image.mime, image.width, image.height, image.body.length, contentHash, sourceUrl ? String(sourceUrl).slice(0, 1000) : null,
        vault.sealBytes(image.body, aadOf(tenantId, id)), currentTimestamp());
    return { imageId: id };
  }

  /**
   * Zet de afbeelding van een artikel (vervangt de vorige).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {{ name?: string, data?: string }} input Bestandsnaam en base64-inhoud (eventueel als data-URL).
   * @returns {{ imageId?: string, error?: string, message?: string, status?: number }} Het id van de afbeelding, of een fout.
   */
  function setForItem(tenantId, itemId, input) {
    const item = prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, String(itemId));
    if (!item) return { error: 'not_found', message: 'Artikel niet gevonden.', status: 404 };
    const stored = storeImage(tenantId, fromBase64(input && input.data), { name: input && input.name });
    if (stored.error) return stored;
    prepare('UPDATE stock_items SET image_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(stored.imageId, currentTimestamp(), tenantId, item.id);
    prune(tenantId);
    return { imageId: stored.imageId };
  }

  /**
   * Haalt de afbeelding bij een artikel weg.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {boolean} false als het artikel niet bestaat.
   */
  function clearForItem(tenantId, itemId) {
    const item = prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, String(itemId));
    if (!item) return false;
    prepare('UPDATE stock_items SET image_id = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?').run(currentTimestamp(), tenantId, item.id);
    prune(tenantId);
    return true;
  }

  /**
   * De inhoud van een afbeelding.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} imageId Id van de afbeelding.
   * @returns {{ mime: string, body: Buffer }|null} De afbeelding, of null als hij niet bestaat of niet te lezen is.
   */
  function file(tenantId, imageId) {
    if (!IMAGE_ID_PATTERN.test(String(imageId))) return null;
    const row = prepare('SELECT mime, data FROM item_images WHERE tenant_id = ? AND id = ?').get(tenantId, String(imageId));
    if (!row) return null;
    try { return { mime: row.mime, body: vault.openBytes(row.data, aadOf(tenantId, String(imageId))) }; } catch (error) { return null; }
  }

  /**
   * Downloadt een afbeelding van een https-adres (alleen openbare adressen, geen omleidingen, begrensd).
   * @param {string} imageUrl Het adres.
   * @returns {Promise<Buffer>} De bytes.
   * @throws {Error} Met een leesbare melding als het niet lukt.
   */
  async function download(imageUrl) {
    const url = importableUrl(imageUrl);
    if (!url) throw new Error('Geen geldig https-adres.');
    let send = fetchImpl;
    if (!send) {
      try {
        send = pinnedFetch(await resolveHost(url.hostname));
      } catch (error) {
        throw new Error('Adres is niet openbaar of niet gevonden.');
      }
    }
    let response;
    try {
      response = await send(url.href, { headers: { Accept: 'image/jpeg,image/png,image/webp' }, redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(error && error.name === 'TimeoutError' ? 'Time-out bij het ophalen.' : 'Niet bereikbaar (of doorgestuurd naar een ander adres).');
    }
    if (!response.ok) throw new Error(`Status ${response.status}.`);
    try {
      return await readBytesLimited(response, MAX_IMAGE_BYTES);
    } catch (error) {
      throw new Error(error && error.code === 'too_large' ? 'Afbeelding is te groot.' : 'Lezen is mislukt.');
    }
  }

  const CANDIDATES_SQL = `FROM stock_items i
    JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id
    WHERE i.tenant_id = ? AND i.archived = 0 AND i.image_id IS NULL AND p.image IS NOT NULL AND p.image <> ''`;

  /**
   * Hoeveel artikelen nog een afbeelding van de webshop kunnen krijgen.
   * @param {string} tenantId Id van de omgeving.
   * @returns {number} Het aantal.
   */
  function pendingImport(tenantId) {
    return Number(prepare(`SELECT COUNT(*) AS n ${CANDIDATES_SQL}`).get(tenantId).n);
  }

  /**
   * Neemt één portie afbeeldingen over uit de webshop: zoekt de volgende artikelen
   * (op id, na `after`) zonder eigen afbeelding, haalt elk adres één keer op en
   * koppelt de afbeelding aan alle artikelen met dat adres.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ after?: string }} [options] Het laatste artikel-id van de vorige portie ('' = begin).
   * @returns {Promise<{ processed: number, imported: number, reused: number, failed: { code: string, url: string, reason: string }[], next: string|null, pending: number }>} Het resultaat; `next` is het cursor-id voor de volgende portie of null als alles gehad is.
   */
  async function importFromShop(tenantId, { after = '' } = {}) {
    const rows = prepare(`SELECT i.id, i.code, p.image ${CANDIDATES_SQL} AND i.id > ? ORDER BY i.id LIMIT ${IMPORT_PAGE_SIZE}`).all(tenantId, String(after || ''));
    const known = new Map(prepare('SELECT id, source_url FROM item_images WHERE tenant_id = ? AND source_url IS NOT NULL').all(tenantId).map((row) => [row.source_url, row.id]));
    const byUrl = new Map();
    for (const row of rows) byUrl.set(row.image, [...(byUrl.get(row.image) || []), row]);
    const result = { processed: rows.length, imported: 0, reused: 0, failed: [], next: rows.length === IMPORT_PAGE_SIZE ? rows[rows.length - 1].id : null, pending: 0 };
    const queue = [...byUrl.keys()];
    /**
     * Neemt adressen uit de wachtrij en koppelt de afbeelding aan de artikelen.
     * @returns {Promise<void>} Klaar als de wachtrij leeg is.
     */
    async function worker() {
      while (queue.length) {
        const url = queue.shift();
        const items = byUrl.get(url);
        let imageId = known.get(url) || null;
        // Een bekende afbeelding kan intussen opgeruimd zijn (artikel verwijderd tijdens het overnemen): dan opnieuw ophalen.
        if (imageId && !prepare('SELECT 1 AS present FROM item_images WHERE tenant_id = ? AND id = ?').get(tenantId, imageId)) {
          known.delete(url);
          imageId = null;
        }
        if (imageId) {
          result.reused += items.length;
        } else {
          try {
            const stored = storeImage(tenantId, await download(url), { name: url, sourceUrl: url });
            if (stored.error) throw new Error(stored.message);
            imageId = stored.imageId;
            known.set(url, imageId);
            result.imported += items.length;
          } catch (error) {
            for (const item of items) result.failed.push({ code: item.code, url, reason: String(error.message || 'Mislukt.').slice(0, 120) });
            continue;
          }
        }
        for (const item of items) prepare('UPDATE stock_items SET image_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND image_id IS NULL').run(imageId, currentTimestamp(), tenantId, item.id);
      }
    }
    await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, queue.length) }, worker));
    prune(tenantId);
    result.pending = pendingImport(tenantId);
    return result;
  }

  /**
   * De mediabibliotheek: alle afbeeldingen van de omgeving (zonder inhoud) met de artikelen
   * die ze gebruiken, plus de actieve artikelen zonder afbeelding. Twee queries, geen query per afbeelding.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ images: object[], missing: object[] }} images = [{ id, name, mime, width, height, size, sourceUrl, createdAt, items: [{ id, code, name }] }], missing = [{ id, code, name }].
   */
  function library(tenantId) {
    const images = prepare('SELECT id, name, mime, width, height, size, source_url, created_at FROM item_images WHERE tenant_id = ? ORDER BY created_at DESC, id').all(tenantId);
    const itemRows = prepare('SELECT id, code, name, image_id, archived FROM stock_items WHERE tenant_id = ? ORDER BY code').all(tenantId);
    const usedBy = new Map();
    const missing = [];
    for (const item of itemRows) {
      if (item.image_id) {
        if (!usedBy.has(item.image_id)) usedBy.set(item.image_id, []);
        usedBy.get(item.image_id).push({ id: item.id, code: item.code, name: item.name });
      }
      else if (!Number(item.archived)) missing.push({ id: item.id, code: item.code, name: item.name });
    }
    return {
      images: images.map((row) => ({ id: row.id, name: row.name, mime: row.mime, width: row.width, height: row.height, size: Number(row.size), sourceUrl: row.source_url || '', createdAt: row.created_at, items: usedBy.get(row.id) || [] })),
      missing,
    };
  }

  return { setForItem, clearForItem, file, importFromShop, prune, pendingImport, library };
}

/**
 * Registreert de routes voor artikelafbeeldingen (recht `voorraad`, per omgeving).
 * @param {object} app De Express-app.
 * @param {{ images: object, requireRight: Function, requireJson: Function, audit: Function, importLimiter?: Function }} ctx images = createItemImageStore, importLimiter = begrenzing van het overnemen.
 * @returns {void}
 */
function registerItemImageRoutes(app, { images, requireRight, requireJson, audit, importLimiter = (req, res, next) => next() }) {
  const requireStock = requireRight('voorraad');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;

  app.put('/api/stock/items/:id/image', requireJson, requireStock, (req, res) => {
    const out = images.setForItem(tenantOf(req), req.params.id, req.body);
    if (out.error) return res.status(out.status || 400).json({ error: out.error, message: out.message });
    audit(req, 'voorraad_afbeelding_gezet', { itemId: req.params.id });
    res.json({ imageId: out.imageId });
  });

  app.delete('/api/stock/items/:id/image', requireStock, (req, res) => {
    if (!images.clearForItem(tenantOf(req), req.params.id)) return res.status(404).json({ error: 'not_found', message: 'Artikel niet gevonden.' });
    audit(req, 'voorraad_afbeelding_verwijderd', { itemId: req.params.id });
    res.json({ imageId: null });
  });

  // Voorbeeld in het beheer; de openbare shop heeft zijn eigen route (winkel/artikelfoto).
  app.get('/api/stock/images/:id', requireStock, (req, res) => {
    const file = images.file(tenantOf(req), req.params.id);
    if (!file) return res.status(404).end();
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type(file.mime).send(file.body);
  });

  // Mediabibliotheek: alle afbeeldingen met de artikelen die ze gebruiken, en de artikelen zonder afbeelding.
  app.get('/api/stock/images', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(images.library(tenantOf(req)));
  });

  app.get('/api/stock/images-import', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ pending: images.pendingImport(tenantOf(req)) });
  });

  // Eén portie overnemen uit de webshop; de browser herhaalt met `after` = `next` tot die leeg is.
  app.post('/api/stock/images-import', requireJson, requireStock, importLimiter, async (req, res) => {
    const after = typeof req.body?.after === 'string' ? req.body.after.slice(0, 64) : '';
    try {
      const out = await images.importFromShop(tenantOf(req), { after });
      audit(req, 'voorraad_afbeeldingen_overgenomen', { imported: out.imported, reused: out.reused, failed: out.failed.length });
      res.json(out);
    } catch (error) {
      res.status(500).json({ error: 'import_failed', message: 'Afbeeldingen overnemen is mislukt.' });
    }
  });
}

module.exports = { createItemImageStore, registerItemImageRoutes };
