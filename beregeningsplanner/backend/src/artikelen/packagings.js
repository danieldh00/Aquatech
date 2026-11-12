// Verpakkingseenheden per artikel (tabel item_packagings, migratie 63): naast de basiseenheid (bijvoorbeeld 1 stuk) kan een
// artikel in een grotere eenheid worden verkocht, zoals een doos of een pallet van 144 stuks.
//
// - De voorraad blijft altijd in de basiseenheid staan; een verpakking heeft alleen een factor (aantal basiseenheden).
// - Een verpakking heeft een korte code (bijvoorbeeld PAL, in de winkelwagen CODE@PAL), een naam, een eigen prijs
//   (leeg = factor × de prijs van het artikel), een eigen zakelijke prijs en een eigen EAN voor de streepjescode.
// - `audience` bepaalt voor welke klantcategorie de verpakking zichtbaar is: iedereen, zakelijk of groothandel.
// - Een hoofdartikel (met varianten) heeft zelf geen verpakkingen: die horen bij de varianten.
// - De EAN is uniek over artikelen én verpakkingen, gecontroleerd vóór het schrijven; de unieke indexen vangen alleen een
//   botsing binnen één tabel op. Een artikel en een verpakking die gelijktijdig dezelfde EAN krijgen kan dus (heel zelden)
//   allebei slagen; wie later op EAN zoekt behandelt een dubbele treffer als fout.
const crypto = require('crypto');
const path = require('path');
const { transaction } = require('../database/db');
const { FRONTEND_DIR } = require('../paths');
const Barcode = require(path.join(FRONTEND_DIR, 'shared', 'barcode.js'));

const MAX_PER_ITEM = 10;
const MAX_FACTOR = 1000000;
const MAX_PRICE = 1000000;
/** Wie de verpakking ziet, van breed naar smal. */
const AUDIENCES = ['iedereen', 'zakelijk', 'groothandel'];
const CODE_PATTERN = /^[A-Z0-9]{1,12}$/;

/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * Maakt tekst schoon: stuurtekens weg, spaties aan de randen af, ingekort.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximale lengte.
 * @returns {string} De schone tekst.
 */
const cleanText = (value, maxLength) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);

/**
 * Leest een optionele prijs (excl. btw): leeg = null.
 * @param {*} value De invoer.
 * @returns {{ value?: (number|null), error?: boolean }} De prijs op twee decimalen, null als hij leeg is, of een fout.
 */
function priceOf(value) {
  if (value === null || value === undefined || value === '') return { value: null };
  const number = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(number) || number < 0 || number > MAX_PRICE) return { error: true };
  return { value: Math.round(number * 100) / 100 };
}

/**
 * Controleert en schoont de verpakkingen van een artikel.
 * @param {*} entries De regels: [{ code, name, factor, salePrice, businessPrice, ean, audience, active }].
 * @returns {{ value?: object[], error?: string, field?: string }} De schone regels, of een fout.
 */
function sanitizePackagings(entries) {
  if (!Array.isArray(entries)) return { error: 'Geef de verpakkingen als lijst.', field: 'packagings' };
  if (entries.length > MAX_PER_ITEM) return { error: `Een artikel heeft hoogstens ${MAX_PER_ITEM} verpakkingen.`, field: 'packagings' };
  const value = [];
  const codes = new Set();
  const eans = new Set();
  for (const entry of entries) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const code = cleanText(source.code, 12).toUpperCase();
    if (!CODE_PATTERN.test(code)) return { error: 'Geef een korte code van letters en cijfers (hoogstens 12), bijvoorbeeld PAL.', field: 'code' };
    if (codes.has(code)) return { error: `De code ${code} staat er twee keer in.`, field: 'code' };
    codes.add(code);
    const name = cleanText(source.name, 40);
    if (!name) return { error: 'Vul de naam van de verpakking in, bijvoorbeeld Pallet.', field: 'name' };
    const factor = Number(source.factor);
    if (!Number.isInteger(factor) || factor < 2 || factor > MAX_FACTOR) return { error: 'Het aantal per verpakking is een heel getal van 2 of meer.', field: 'factor' };
    const salePrice = priceOf(source.salePrice);
    const businessPrice = priceOf(source.businessPrice);
    if (salePrice.error || businessPrice.error) return { error: 'Geef een prijs van 0 of meer, of laat hem leeg.', field: 'salePrice' };
    let ean = null;
    if (source.ean !== undefined && source.ean !== null && String(source.ean).trim() !== '') {
      ean = Barcode.cleanEan(source.ean);
      if (!ean) return { error: 'Dit is geen geldige EAN (controlecijfer klopt niet).', field: 'ean' };
      if (eans.has(ean)) return { error: 'Dezelfde EAN staat bij twee verpakkingen.', field: 'ean' };
      eans.add(ean);
    }
    const audience = AUDIENCES.includes(source.audience) ? source.audience : 'iedereen';
    value.push({ code, name, factor, salePrice: salePrice.value, businessPrice: businessPrice.value, ean, audience, active: source.active === undefined ? true : Boolean(source.active) });
  }
  return { value };
}

/**
 * Zet een rij uit item_packagings om naar het formaat van de API.
 * @param {object} row De rij.
 * @returns {object} De verpakking.
 */
const packagingOf = (row) => ({
  id: row.id, itemId: row.item_id, code: row.code, name: row.name, factor: Number(row.factor),
  salePrice: row.sale_price == null ? null : Number(row.sale_price), businessPrice: row.business_price == null ? null : Number(row.business_price),
  ean: row.ean || null, audience: row.audience, active: Boolean(Number(row.active)),
});

/**
 * Of een klant van deze categorie de verpakking mag zien.
 * @param {string} audience Doelgroep van de verpakking (iedereen, zakelijk of groothandel).
 * @param {{ group?: string, wholesale?: boolean }} customer De klant: groep ('' of 'zakelijk') en of hij groothandelsklant is.
 * @returns {boolean} true als de verpakking zichtbaar is.
 */
function visibleFor(audience, customer = {}) {
  if (audience === 'iedereen') return true;
  if (audience === 'zakelijk') return customer.group === 'zakelijk';
  return customer.group === 'zakelijk' && Boolean(customer.wholesale);
}

/**
 * Maakt de opslag voor verpakkingseenheden.
 * @param {object} db De database.
 * @returns {object} forItem, setForItem, byCodes, removeForItem.
 */
function createPackagingStore(db) {
  /**
   * Maakt een query klaar.
   * @param {string} sql De query.
   * @returns {object} De voorbereide query.
   */
  const prepare = (sql) => db.prepare(sql);
  const COLUMNS = 'id, item_id, code, name, factor, sale_price, business_price, ean, audience, active';

  /**
   * De verpakkingen van één artikel (kleinste eerst).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {object[]|null} De verpakkingen, of null als het artikel niet bestaat.
   */
  function forItem(tenantId, itemId) {
    const item = prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, String(itemId || ''));
    if (!item) return null;
    return prepare(`SELECT ${COLUMNS} FROM item_packagings WHERE tenant_id = ? AND item_id = ? ORDER BY factor, code`).all(tenantId, item.id).map(packagingOf);
  }

  /**
   * Vervangt de verpakkingen van een artikel door de opgegeven lijst.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {*} entries De regels (zie sanitizePackagings).
   * @returns {{ packagings?: object[], error?: string, field?: string, status?: number }} De nieuwe lijst, of een fout.
   */
  function setForItem(tenantId, itemId, entries) {
    const checked = sanitizePackagings(entries);
    if (checked.error) return checked;
    try {
      return transaction(db, () => {
        const item = prepare('SELECT id, has_variants, archived FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, String(itemId || ''));
        if (!item) return { error: 'not_found', status: 404 };
        if (Number(item.archived)) return { error: 'Dit artikel is gearchiveerd; zet het eerst terug om de verpakkingen te wijzigen.', field: 'packagings', status: 409 };
        if (Number(item.has_variants) && checked.value.length) return { error: 'Een hoofdartikel heeft geen eigen verpakkingen; stel die in bij de varianten.', field: 'packagings', status: 409 };
        // Valideer alles vóór de eerste schrijfactie: een fout die als waarde terugkomt wordt door transaction() niet teruggedraaid.
        for (const entry of checked.value.filter((candidate) => candidate.ean)) {
          const stockOwner = prepare('SELECT code FROM stock_items WHERE tenant_id = ? AND ean = ?').get(tenantId, entry.ean);
          if (stockOwner) return { error: `Deze EAN hoort al bij artikel ${stockOwner.code}.`, field: 'ean', status: 409 };
          const packagingOwner = prepare('SELECT i.code AS code FROM item_packagings p JOIN stock_items i ON i.tenant_id = p.tenant_id AND i.id = p.item_id WHERE p.tenant_id = ? AND p.ean = ? AND p.item_id <> ?')
            .get(tenantId, entry.ean, item.id);
          if (packagingOwner) return { error: `Deze EAN hoort al bij een verpakking van artikel ${packagingOwner.code}.`, field: 'ean', status: 409 };
        }
        prepare('DELETE FROM item_packagings WHERE tenant_id = ? AND item_id = ?').run(tenantId, item.id);
        const timestamp = currentTimestamp();
        for (const entry of checked.value) {
          prepare(`INSERT INTO item_packagings (id, tenant_id, item_id, code, name, factor, sale_price, business_price, ean, audience, active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(crypto.randomUUID(), tenantId, item.id, entry.code, entry.name, entry.factor, entry.salePrice, entry.businessPrice, entry.ean, entry.audience, entry.active ? 1 : 0, timestamp);
        }
        return { packagings: forItem(tenantId, item.id) };
      });
    } catch (error) {
      // Twee gelijktijdige aanvragen met dezelfde EAN: de unieke index vangt de tweede op.
      if (/item_packagings_ean|item_packagings\.ean/.test(String(error && error.message))) return { error: 'Deze EAN hoort al bij een andere verpakking.', field: 'ean', status: 409 };
      throw error;
    }
  }

  /**
   * Zoekt actieve verpakkingen op artikel-id (voor de winkelwagen: één query voor alle regels).
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} itemIds De artikel-id's.
   * @returns {Map<string, object[]>} Artikel-id naar zijn actieve verpakkingen.
   */
  function byItemIds(tenantId, itemIds) {
    const ids = [...new Set(itemIds)];
    const map = new Map();
    if (!ids.length) return map;
    const rows = prepare(`SELECT ${COLUMNS} FROM item_packagings WHERE tenant_id = ? AND active = 1 AND item_id IN (${ids.map(() => '?').join(', ')}) ORDER BY factor, code`).all(tenantId, ...ids);
    for (const row of rows) {
      if (!map.has(row.item_id)) map.set(row.item_id, []);
      map.get(row.item_id).push(packagingOf(row));
    }
    return map;
  }

  return { forItem, setForItem, byItemIds };
}

/**
 * Hangt de routes voor verpakkingseenheden aan de app (recht voorraad).
 * @param {object} app De Express-app.
 * @param {{ packagings: object, requireRight: Function, requireJson: Function, audit: Function }} ctx De opslag en hulpfuncties van de server.
 * @returns {void}
 */
function registerPackagingRoutes(app, ctx) {
  const { packagings, requireRight, requireJson, audit } = ctx;
  const requireStock = requireRight('voorraad');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;

  app.get('/api/stock/items/:id/packagings', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const rows = packagings.forItem(tenantOf(req), req.params.id);
    if (!rows) return res.status(404).json({ error: 'not_found', message: 'Artikel niet gevonden.' });
    res.json({ items: rows });
  });

  app.put('/api/stock/items/:id/packagings', requireJson, requireStock, (req, res) => {
    const out = packagings.setForItem(tenantOf(req), req.params.id, req.body && req.body.packagings);
    if (out.error) {
      if (out.status === 404) return res.status(404).json({ error: 'not_found', message: 'Artikel niet gevonden.' });
      return res.status(out.status || 400).json({ error: out.status === 409 ? 'conflict' : 'invalid', message: out.error, field: out.field });
    }
    audit(req, 'artikel_verpakkingen_gewijzigd', { itemId: req.params.id, count: out.packagings.length });
    res.json({ items: out.packagings });
  });
}

module.exports = { createPackagingStore, registerPackagingRoutes, sanitizePackagings, visibleFor, AUDIENCES };
