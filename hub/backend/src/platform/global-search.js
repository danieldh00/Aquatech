// Globaal zoeken: één zoekveld dat klanten, offertes, werkorders, facturen en artikelen tegelijk doorzoekt
// (GET /api/search?q=). Per soort geldt hetzelfde recht als in de eigen module: wie dat recht niet heeft krijgt
// die groep niet te zien. Elke groep is begrensd en filtert op de omgeving van de gebruiker; er komt alleen een
// korte regel per resultaat terug (titel, omschrijving en een link met ?id=), nooit de hele inhoud.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');

const Roles = require(path.join(FRONTEND_DIR, 'shared', 'roles.js'));
const Core = require(path.join(FRONTEND_DIR, 'offertes', 'quote-core.js'));
const InvoiceCore = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));

const MIN_LENGTH = 2;
const MAX_LENGTH = 80;
const MAX_WORDS = 5;
const PER_GROUP = 5;

/**
 * Splitst de zoektekst in woorden (kleine letters, hoogstens vijf).
 * @param {*} text De invoer.
 * @returns {string[]} De woorden.
 */
function wordsOf(text) {
  return String(text || '').trim().slice(0, MAX_LENGTH).toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
}

/**
 * Bouwt het WHERE-deel dat elk woord in minstens één van de kolommen zoekt (zonder hoofdletters).
 * @param {string[]} words De woorden.
 * @param {string[]} columns De kolommen (vaste namen uit deze module, nooit invoer).
 * @returns {{ sql: string, args: string[] }} De voorwaarde (met AND ervoor) en de waarden.
 */
function matchClause(words, columns) {
  const args = [];
  const parts = words.map((word) => {
    const pattern = `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    args.push(...columns.map(() => pattern));
    return `(${columns.map((column) => `lower(${column}) LIKE ? ESCAPE '\\'`).join(' OR ')})`;
  });
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', args };
}

/**
 * Maakt de zoekfunctie.
 * @param {object} db De database.
 * @param {{ searchCustomers: Function }} options searchCustomers(user, text, limit) → klanten (items) van de omgeving van de gebruiker.
 * @returns {{ search: Function }} De zoekfunctie.
 */
function createGlobalSearch(db, { searchCustomers }) {
  /**
   * Zoekt in alle soorten waar de gebruiker bij mag.
   * @param {object} user De ingelogde gebruiker (tenant_id = de actieve omgeving).
   * @param {string} text De zoektekst.
   * @returns {{ groups: { key: string, title: string, items: { id: string, title: string, subtitle: string, href: string }[] }[] }} De groepen met resultaten (lege groepen weggelaten).
   */
  function search(user, text) {
    const words = wordsOf(text);
    const query = words.join(' ');
    if (query.length < MIN_LENGTH) return { groups: [] };
    const tenantId = user.tenant_id;
    const groups = [];
    /**
     * Voegt een groep toe als er resultaten zijn.
     * @param {string} key Sleutel van de groep.
     * @param {string} title Titel van de groep.
     * @param {object[]} items De resultaten.
     * @returns {void}
     */
    const add = (key, title, items) => { if (items.length) groups.push({ key, title, items }); };
    /**
     * Zet kolommen om in een regel.
     * @param {string} href Link met ?id=.
     * @param {string} id Id.
     * @param {string} title Titel.
     * @param {string[]} parts Delen van de omschrijving (lege worden weggelaten).
     * @returns {object} Het resultaat.
     */
    const item = (href, id, title, parts) => ({ id, title, subtitle: parts.filter(Boolean).join(' · '), href: `${href}?id=${encodeURIComponent(id)}` });
    /**
     * ORDER BY-deel: het nummer dat precies gelijk is aan de zoektekst staat bovenaan.
     * @param {string} column De kolom (vaste naam uit deze module).
     * @returns {string} Het SQL-deel (met één ?-parameter).
     */
    const exactFirst = (column) => `CASE WHEN lower(${column}) = ? THEN 0 ELSE 1 END`;

    if (Roles.can(user, 'klanten')) {
      const customers = searchCustomers(user, query, PER_GROUP);
      add('klanten', 'Klanten', customers.map((customer) => item('klanten/', customer.id, customer.displayName || customer.username, [customer.companyName, customer.email, customer.phone])));
    }
    if (Roles.can(user, 'offertes')) {
      const own = Roles.can(user, 'offertes.alle') ? { sql: '', args: [] } : { sql: ' AND owner_id = ?', args: [user.id] };
      const match = matchClause(words, ['number', 'title', 'customer']);
      const rows = db.prepare(`SELECT id, number, title, customer, status FROM quotes WHERE tenant_id = ? AND deleted_at IS NULL${own.sql}${match.sql}
        ORDER BY ${exactFirst('number')}, updated_at DESC LIMIT ${PER_GROUP}`).all(tenantId, ...own.args, ...match.args, query);
      add('offertes', 'Offertes', rows.map((row) => item('offertes/', row.id, row.number, [row.title, row.customer, Core.STATUSES[row.status]])));
    }
    if (Roles.can(user, 'werkorders')) {
      const match = matchClause(words, ['number', 'title', 'customer', 'address']);
      const rows = db.prepare(`SELECT id, number, title, customer, address FROM work_orders WHERE tenant_id = ? AND deleted_at IS NULL${match.sql}
        ORDER BY ${exactFirst('number')}, updated_at DESC LIMIT ${PER_GROUP}`).all(tenantId, ...match.args, query);
      add('werkorders', 'Werkorders', rows.map((row) => item('werkorders/', row.id, row.number, [row.title, row.customer, row.address])));
    }
    if (Roles.can(user, 'facturen')) {
      const match = matchClause(words, ['number', 'customer_name']);
      const rows = db.prepare(`SELECT id, number, customer_name, status, total FROM invoices WHERE tenant_id = ?${match.sql}
        ORDER BY ${exactFirst('number')}, invoice_date DESC LIMIT ${PER_GROUP}`).all(tenantId, ...match.args, query);
      add('facturen', 'Facturen', rows.map((row) => item('facturen/', row.id, row.number || 'Concept', [row.customer_name, InvoiceCore.STATUSES[row.status], Number(row.total).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' })])));
    }
    if (Roles.can(user, 'voorraad')) {
      const match = matchClause(words, ['code', 'name', 'ean']);
      const rows = db.prepare(`SELECT id, code, name, location FROM stock_items WHERE tenant_id = ? AND archived = 0${match.sql}
        ORDER BY ${exactFirst('code')}, lower(name) LIMIT ${PER_GROUP}`).all(tenantId, ...match.args, query);
      add('artikelen', 'Artikelen', rows.map((row) => item('artikelen/', row.id, `${row.code} ${row.name}`.trim(), [row.location])));
    }
    return { groups };
  }
  return { search };
}

/**
 * Registreert GET /api/search (alleen ingelogd, met een limiet per gebruiker).
 * @param {object} app De Express-app.
 * @param {{ search: Function, identify: Function, limiter: Function }} ctx De zoekfunctie, identify(req) en de limietmiddleware.
 * @returns {void}
 */
function registerSearchRoutes(app, { search, identify, limiter }) {
  app.get('/api/search', limiter, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    res.json(search(user, req.query.q));
  });
}

module.exports = { createGlobalSearch, registerSearchRoutes, wordsOf, matchClause };
