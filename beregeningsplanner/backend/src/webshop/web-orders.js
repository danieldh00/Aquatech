// Bestellingen in de eigen webshop (storefront.js): een klant met een account
// plaatst een bestelling op rekening. De prijzen en de voorraad komen bij het
// afrekenen opnieuw uit de database (nooit uit de winkelwagen van de klant);
// bij het plaatsen reserveert de bestelling de voorraad (stock.reserveOrder),
// bij Verzonden boekt hij de artikelen af en bij Geannuleerd vervalt de
// reservering. Tabel web_orders (migratie 37); beheer via /api/admin/web-orders
// (Beheer > Bestellingen). Alles per omgeving (tenantId).
const crypto = require('crypto');
const { transaction } = require('../database/db');
const { validEmail } = require('../platform/mailer');

/** Statussen van een bestelling met hun weergavenaam. */
const STATUSES = { nieuw: 'Nieuw', verzonden: 'Verzonden', afgerond: 'Afgerond', geannuleerd: 'Geannuleerd' };
/** Welke status op welke mag volgen. */
const TRANSITIONS = { nieuw: ['verzonden', 'geannuleerd'], verzonden: ['afgerond'], afgerond: [], geannuleerd: [] };
/** Hoogstens zoveel regels in een winkelwagen. */
const MAX_LINES = 40;
/** Hoogstens zoveel stuks van één artikel per bestelling. */
const MAX_QTY = 99;
/** Hoogstens zoveel bestellingen per pagina in Beheer. */
const PAGE_LIMIT = 200;
/** Hoogstens zoveel bestellingen in één export. */
const EXPORT_LIMIT = 2000;

/**
 * Rondt af op twee decimalen.
 * @param {*} value Het bedrag.
 * @returns {number} Het afgeronde bedrag.
 */
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * Maakt een invoer tot getrimde tekst van hoogstens een bepaalde lengte.
 * @param {*} value De invoer.
 * @param {number} max Maximale lengte (tekens).
 * @returns {string} De opgeschoonde tekst.
 */
const clean = (value, max) => Array.from(String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, max).join('');

/**
 * Berekent de totalen van de regels: totaal incl. btw en per btw-tarief het
 * bedrag excl., de btw en het bedrag incl.
 * @param {{ vatRate: number, lineTotal: number }[]} lines De regels (lineTotal = incl. btw).
 * @returns {{ total: number, byRate: { rate: number, excl: number, vat: number, incl: number }[] }} De totalen.
 */
function totalsOf(lines) {
  const byRate = new Map();
  for (const line of lines) byRate.set(line.vatRate, round2((byRate.get(line.vatRate) || 0) + line.lineTotal));
  const rows = [...byRate].sort((left, right) => right[0] - left[0]).map(([rate, incl]) => {
    const vat = round2(incl - incl / (1 + rate / 100));
    return { rate, excl: round2(incl - vat), vat, incl };
  });
  return { total: round2(rows.reduce((sum, row) => sum + row.incl, 0)), byRate: rows };
}

/**
 * Controleert de gegevens die de klant bij het afrekenen invult.
 * @param {object} raw De invoer (name, company, email, phone, street, postcode, city, note).
 * @returns {{ value?: object, error?: string, field?: string }} De opgeschoonde gegevens of een foutmelding.
 */
function sanitizeCheckout(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const value = {
    name: clean(input.name, 80), company: clean(input.company, 80), email: clean(input.email, 200).toLowerCase(), phone: clean(input.phone, 30),
    street: clean(input.street, 120), postcode: clean(input.postcode, 10).toUpperCase(), city: clean(input.city, 60),
    note: Array.from(String(input.note == null ? '' : input.note).replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim()).slice(0, 500).join(''),
  };
  if (value.name.length < 2) return { error: 'Vul je naam in.', field: 'name' };
  if (!validEmail(value.email)) return { error: 'Vul een geldig e-mailadres in.', field: 'email' };
  if (value.street.length < 3) return { error: 'Vul je straat en huisnummer in.', field: 'street' };
  if (!/^[0-9]{4}\s?[A-Z]{2}$/.test(value.postcode)) return { error: 'Vul een geldige postcode in, bijvoorbeeld 8071 AB.', field: 'postcode' };
  if (value.city.length < 2) return { error: 'Vul je woonplaats in.', field: 'city' };
  value.postcode = value.postcode.replace(/^([0-9]{4})\s?([A-Z]{2})$/, '$1 $2');
  return { value };
}

/**
 * Maakt de opslag voor bestellingen van de eigen webshop.
 * @param {object} db De database.
 * @param {{ stock: object }} deps De voorraadopslag (reserveren en afboeken).
 * @returns {{ priceCart: Function, place: Function, get: Function, getForUser: Function, list: Function, setStatus: Function, updateData: Function }} De functies.
 */
function createWebOrderStore(db, { stock }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Prijst een winkelwagen met de gegevens van nu: verkoopprijs, btw en de
   * beschikbare voorraad (stand min gereserveerd). Alleen artikelen die in de
   * webshop staan (Naar webshop aan, met verkoopprijs) tellen mee.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ code: string, qty: number }[]} wanted De gewenste artikelen en aantallen.
   * @returns {{ lines: object[], missing: string[], totals: object, ok: boolean }} De regels (itemId, code, name, unit, qty, available, unitExcl, vatRate, unitIncl, lineTotal, enough), de codes die niet (meer) te koop zijn, de totalen en of er besteld kan worden.
   */
  function priceCart(tenantId, wanted) {
    const unique = new Map();
    for (const line of wanted) {
      const code = String(line.code || '').trim().toUpperCase();
      const qty = Math.floor(Number(line.qty));
      if (code && qty >= 1) unique.set(code, Math.min(MAX_QTY, (unique.get(code) || 0) + qty));
    }
    const codes = [...unique.keys()].slice(0, MAX_LINES);
    const rows = codes.length ? prepare(`SELECT i.id, i.code, i.name, i.unit, i.on_hand, i.sale_price, i.vat_rate, i.variant_values, p.name AS parent_name, COALESCE(r.qty, 0) AS reserved
      FROM stock_items i
      LEFT JOIN stock_items p ON p.tenant_id = i.tenant_id AND p.id = i.parent_id
      LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_reservations WHERE tenant_id = ? GROUP BY item_id) r ON r.item_id = i.id
      WHERE i.tenant_id = ? AND i.archived = 0 AND i.has_variants = 0 AND i.shop_sync = 1 AND i.sale_price IS NOT NULL
        AND i.code IN (${codes.map(() => '?').join(', ')})`).all(tenantId, tenantId, ...codes) : [];
    const byCode = new Map(rows.map((row) => [row.code, row]));
    const lines = [];
    const missing = [];
    for (const code of codes) {
      const row = byCode.get(code);
      if (!row) { missing.push(code); continue; }
      let values = {};
      try { values = JSON.parse(row.variant_values || '{}') || {}; } catch { values = {}; }
      const label = Object.values(values).join(' / ');
      const qty = unique.get(code);
      const vatRate = Number(row.vat_rate ?? 21);
      const unitExcl = Number(row.sale_price);
      const unitIncl = round2(unitExcl * (1 + vatRate / 100));
      const available = Math.round((Number(row.on_hand) - Number(row.reserved)) * 1000) / 1000;
      lines.push({
        itemId: row.id, code: row.code, name: row.parent_name && label ? `${row.parent_name} (${label})` : row.name, unit: row.unit || 'st', qty, available,
        unitExcl, vatRate, unitIncl, lineTotal: round2(unitIncl * qty), enough: available >= qty,
      });
    }
    return { lines, missing, totals: totalsOf(lines), ok: lines.length > 0 && !missing.length && lines.every((line) => line.enough) };
  }

  /**
   * Volgnummer van de bestelling: WEB-<jaar>-0001, per omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} year Het jaar.
   * @returns {string} Het nummer.
   */
  function nextNumber(tenantId, year) {
    const head = `WEB-${year}-`;
    let max = 0;
    for (const row of prepare('SELECT number FROM web_orders WHERE tenant_id = ? AND substr(number, 1, ?) = ?').all(tenantId, head.length, head)) {
      const sequence = Number(row.number.slice(head.length));
      if (Number.isInteger(sequence) && sequence > max) max = sequence;
    }
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  /**
   * Zet een rij om naar het formaat van de API (zonder regels).
   * @param {object} row Rij met id, number, user_id, status, customer_name, email, total, created_at en updated_at.
   * @returns {object} De bestelling.
   */
  const shape = (row) => ({
    id: row.id, number: row.number, userId: row.user_id || null, status: row.status, statusLabel: STATUSES[row.status] || row.status,
    customerName: row.customer_name, email: row.email, total: Number(row.total), createdAt: row.created_at, updatedAt: row.updated_at,
  });
  /**
   * Zet een rij met data om naar de volledige bestelling.
   * @param {object} row De rij, met data.
   * @returns {object} De bestelling met regels, adres, opmerking, totalen en verloop.
   */
  const shapeFull = (row) => {
    const data = JSON.parse(row.data);
    return { ...shape(row), lines: data.lines, customer: data.customer, address: data.address, note: data.note, totals: data.totals, history: data.history, mail: data.mail || null };
  };
  const COLUMNS = 'id, number, user_id, status, customer_name, email, total, created_at, updated_at';

  /**
   * Plaatst een bestelling: controleert prijzen en voorraad opnieuw, legt de
   * bestelling vast en reserveert de voorraad, alles in één transactie.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string }} user De klant die bestelt.
   * @param {object} rawFields De gegevens van het afrekenformulier (zie sanitizeCheckout).
   * @param {{ code: string, qty: number }[]} wanted De winkelwagen.
   * @returns {{ order?: object, error?: string, field?: string, status?: number, cart?: object }} De bestelling, of een foutmelding (met de actuele winkelwagen bij een probleem met prijs of voorraad).
   */
  function place(tenantId, user, rawFields, wanted) {
    const checked = sanitizeCheckout(rawFields);
    if (checked.error) return { error: checked.error, field: checked.field, status: 400 };
    return transaction(db, () => {
      const cart = priceCart(tenantId, wanted);
      if (!cart.lines.length) return { error: 'Je winkelwagen is leeg.', status: 409, cart };
      if (!cart.ok) return { error: 'Een artikel in je winkelwagen is niet meer in de gevraagde hoeveelheid beschikbaar. Controleer je winkelwagen.', status: 409, cart };
      const fields = checked.value;
      const timestamp = currentTimestamp();
      const id = crypto.randomUUID();
      const number = nextNumber(tenantId, timestamp.slice(0, 4));
      const data = {
        lines: cart.lines.map((line) => ({ itemId: line.itemId, code: line.code, name: line.name, unit: line.unit, qty: line.qty, unitExcl: line.unitExcl, vatRate: line.vatRate, unitIncl: line.unitIncl, lineTotal: line.lineTotal })),
        customer: { name: fields.name, company: fields.company, email: fields.email, phone: fields.phone },
        address: { street: fields.street, postcode: fields.postcode, city: fields.city, country: 'NL' },
        note: fields.note, totals: cart.totals, payment: 'op rekening',
        history: [{ at: timestamp, status: 'nieuw', by: fields.name }],
      };
      prepare(`INSERT INTO web_orders (id, tenant_id, number, user_id, status, customer_name, email, total, data, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'nieuw', ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, number, user.id, fields.company || fields.name, fields.email, cart.totals.total, JSON.stringify(data), timestamp, timestamp);
      stock.reserveOrder(tenantId, id, cart.lines.map((line) => ({ itemId: line.itemId, qty: line.qty })));
      return { order: shapeFull(prepare(`SELECT ${COLUMNS}, data FROM web_orders WHERE tenant_id = ? AND id = ?`).get(tenantId, id)) };
    });
  }

  /**
   * Eén bestelling met regels.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @returns {object|null} De bestelling, of null.
   */
  function get(tenantId, id) {
    const row = prepare(`SELECT ${COLUMNS}, data FROM web_orders WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));
    return row ? shapeFull(row) : null;
  }

  /**
   * Eén bestelling van een klant (een ander account krijgt niets).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} userId Id van de klant.
   * @param {string} id Id van de bestelling.
   * @returns {object|null} De bestelling, of null.
   */
  function getForUser(tenantId, userId, id) {
    const row = prepare(`SELECT ${COLUMNS}, data FROM web_orders WHERE tenant_id = ? AND user_id = ? AND id = ?`).get(tenantId, String(userId), String(id));
    return row ? shapeFull(row) : null;
  }

  /**
   * Bestellingen voor Beheer, nieuwste eerst, met een telling per status.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ status?: string, query?: string, limit?: number, offset?: number, withLines?: boolean }} [options] Filter op status en zoekterm (nummer, naam of e-mail), paginering en of de regels meekomen (export).
   * @returns {{ total: number, items: object[], counts: Object<string, number> }} Aantal, bestellingen en aantal per status.
   */
  function list(tenantId, { status = '', query = '', limit = 50, offset = 0, withLines = false } = {}) {
    const where = ['tenant_id = ?'];
    const args = [tenantId];
    if (STATUSES[status]) { where.push('status = ?'); args.push(status); }
    const words = String(query || '').replace(/[%_\\]/g, ' ').trim().toLowerCase().slice(0, 80);
    if (words) { where.push('(lower(number) LIKE ? OR lower(customer_name) LIKE ? OR lower(email) LIKE ?)'); args.push(`%${words}%`, `%${words}%`, `%${words}%`); }
    const cap = withLines ? EXPORT_LIMIT : PAGE_LIMIT;
    const size = Math.min(cap, Math.max(1, Math.floor(Number(limit)) || 50));
    const start = Math.max(0, Math.floor(Number(offset)) || 0);
    const clause = where.join(' AND ');
    const total = Number(prepare(`SELECT COUNT(*) AS n FROM web_orders WHERE ${clause}`).get(...args).n);
    const rows = prepare(`SELECT ${COLUMNS}${withLines ? ', data' : ''} FROM web_orders WHERE ${clause} ORDER BY created_at DESC, number DESC LIMIT ? OFFSET ?`).all(...args, size, start);
    const counts = Object.fromEntries(Object.keys(STATUSES).map((key) => [key, 0]));
    for (const row of prepare('SELECT status, COUNT(*) AS n FROM web_orders WHERE tenant_id = ? GROUP BY status').all(tenantId)) counts[row.status] = Number(row.n);
    return { total, items: rows.map((row) => (withLines ? shapeFull(row) : shape(row))), counts };
  }

  /**
   * Zet een bestelling op een nieuwe status. Verzonden boekt de artikelen af
   * van de voorraad, Geannuleerd laat de reservering vervallen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {string} status De nieuwe status.
   * @param {{ id: string, display_name?: string }|null} user Wie de status wijzigt.
   * @returns {{ order?: object, error?: string, status?: number }} De bijgewerkte bestelling of een foutmelding.
   */
  function setStatus(tenantId, id, status, user) {
    if (!STATUSES[status]) return { error: 'Onbekende status.', status: 400 };
    return transaction(db, () => {
      const row = prepare(`SELECT ${COLUMNS}, data FROM web_orders WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));
      if (!row) return { error: 'Bestelling niet gevonden.', status: 404 };
      if (!TRANSITIONS[row.status].includes(status)) return { error: `Een bestelling met status ${STATUSES[row.status]} kan niet naar ${STATUSES[status]}.`, status: 409 };
      const data = JSON.parse(row.data);
      const timestamp = currentTimestamp();
      if (status === 'verzonden') stock.issueOrder(tenantId, { id: row.id, number: row.number }, data.lines.map((line) => ({ itemId: line.itemId, qty: line.qty })), user);
      if (status === 'geannuleerd') stock.releaseOrder(tenantId, row.id);
      data.history.push({ at: timestamp, status, by: user ? user.display_name || user.displayName || '' : '' });
      prepare('UPDATE web_orders SET status = ?, data = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(status, JSON.stringify(data), timestamp, tenantId, row.id);
      return { order: get(tenantId, row.id) };
    });
  }

  /**
   * Bewaart een uitkomst bij de bestelling (bijvoorbeeld of de bevestigingsmail is verstuurd).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {object} patch Velden die in de data worden bijgewerkt (nu: mail).
   * @returns {void}
   */
  function updateData(tenantId, id, patch) {
    const row = prepare('SELECT data FROM web_orders WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
    if (!row) return;
    prepare('UPDATE web_orders SET data = ? WHERE tenant_id = ? AND id = ?').run(JSON.stringify({ ...JSON.parse(row.data), ...patch }), tenantId, String(id));
  }

  return { priceCart, place, get, getForUser, list, setStatus, updateData };
}

/**
 * Registreert de API-routes van Beheer voor bestellingen (recht `beheer`,
 * door de poort van /api/admin; alles per omgeving van de beheerder).
 * @param {object} app De Express-app.
 * @param {{ orders: object, requireJson: Function, audit: Function }} ctx De opslag en hulpfuncties van de server.
 * @returns {void}
 */
function registerWebOrderRoutes(app, { orders, requireJson, audit }) {
  app.get('/api/admin/web-orders', (req, res) => {
    const out = orders.list(req.tenantId, {
      status: String(req.query.status || ''), query: String(req.query.q || ''), limit: req.query.limit, offset: req.query.offset, withLines: req.query.lines === '1',
    });
    res.json({ ...out, statuses: STATUSES });
  });

  app.get('/api/admin/web-orders/:id', (req, res) => {
    const order = orders.get(req.tenantId, req.params.id);
    if (!order) return res.status(404).json({ error: 'not_found', message: 'Bestelling niet gevonden.' });
    res.json({ order });
  });

  app.post('/api/admin/web-orders/:id/status', requireJson, (req, res) => {
    const out = orders.setStatus(req.tenantId, req.params.id, String(req.body?.status || ''), req.user);
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid_status', message: out.error });
    audit(req, 'webshop_bestelling_status', { number: out.order.number, status: out.order.status });
    res.json({ order: out.order });
  });
}

module.exports = { createWebOrderStore, registerWebOrderRoutes, sanitizeCheckout, totalsOf, STATUSES, TRANSITIONS, MAX_QTY, MAX_LINES };
