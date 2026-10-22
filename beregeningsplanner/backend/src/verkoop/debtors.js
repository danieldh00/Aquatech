// Debiteuren: de klanten van de facturen, met een eigen nummer per omgeving
// (zoals in de boekhouding). Een debiteur ontstaat vanzelf bij een
// definitieve factuur of een webshopbestelling en wordt herkend aan het
// klantaccount, de webshopklant, het e-mailadres of anders de naam
// (match_key). Gegevens van de laatste factuur werken de debiteur bij.
// Later (deel 3) ook de koppeling met Visma eAccounting.
// Alles per omgeving (req.tenantId); recht 'facturen'.
const crypto = require('crypto');

const COLS = 'id, number, name, contact, address, email, phone, vat_number, customer_id, shop_customer_id, source, created_at, updated_at';
const LIST_LIMIT = 2000;
const SOURCES = { factuur: 'Factuur', webshop: 'Webshop', handmatig: 'Handmatig' };
const FIELDS = { name: 200, contact: 200, address: 400, email: 200, phone: 40, vatNumber: 30 };
/**
 * Huidig tijdstip als ISO-tekst, voor created_at/updated_at.
 * @returns {string} Tijdstip in ISO 8601.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * Maakt van een willekeurige invoerwaarde nette tekst: leeg bij null/undefined, ingekort en zonder spaties aan de randen.
 * @param {*} value De invoerwaarde.
 * @param {number} maxLength Maximaal aantal tekens.
 * @returns {string} De opgeschoonde tekst.
 */
const cleanText = (value, maxLength) => String(value == null ? '' : value).slice(0, maxLength).trim();
/**
 * Herkenningssleutel van een debiteur: het e-mailadres, anders de naam
 * (hoofdletters en dubbele spaties maken niet uit).
 * @param {{ email?: string, name?: string }} customer Klantgegevens.
 * @returns {string} 'e:<e-mail>', 'n:<naam>' of '' als beide leeg zijn.
 */
function matchKey(customer) {
  const email = cleanText(customer.email, 200).toLowerCase();
  if (email) return `e:${email}`;
  const name = cleanText(customer.name, 200).toLowerCase().replace(/\s+/g, ' ');
  return name ? `n:${name}` : '';
}

/**
 * Schoont de invoer van een debiteur op: alleen de bekende velden, als tekst en ingekort tot hun maximale lengte.
 * @param {object} raw De ruwe invoer (bijv. de body van een verzoek).
 * @returns {{ name: string, contact: string, address: string, email: string, phone: string, vatNumber: string }} De opgeschoonde velden.
 */
function sanitizeDebtor(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [field, maxLength] of Object.entries(FIELDS)) out[field] = cleanText(input[field], maxLength);
  return out;
}

/**
 * Maakt de opslag voor debiteuren (tabel debtors) bovenop de database.
 * @param {object} db Databaseverbinding (node:sqlite of pgdb, zelfde interface).
 * @returns {{ ensure: Function, get: Function, list: Function, numbers: Function, update: Function, nextNumber: Function }} De opslagfuncties.
 */
function createDebtorStore(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL met ?-parameters.
   * @returns {object} Het voorbereide statement.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * Zet een databaserij om naar het debiteurobject voor de API.
   * @param {object} row Rij uit de tabel debtors.
   * @returns {object} De debiteur met camelCase-velden.
   */
  const toDebtor = (row) => ({
    id: row.id, number: Number(row.number), name: row.name, contact: row.contact, address: row.address, email: row.email, phone: row.phone,
    vatNumber: row.vat_number, customerId: row.customer_id || null, shopCustomerId: row.shop_customer_id || null, source: row.source,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });

  /**
   * Volgend vrij debiteurnummer in deze omgeving: één hoger dan het hoogste, maar minimaal het startnummer.
   * @param {string} tenantId De omgeving.
   * @param {number} start Eerste nummer uit de instellingen (standaard 1000).
   * @returns {number} Het nieuwe debiteurnummer.
   */
  function nextNumber(tenantId, start) {
    const row = prepare('SELECT MAX(number) AS n FROM debtors WHERE tenant_id = ?').get(tenantId);
    return Math.max(Number(row && row.n) || 0, (Number(start) || 1000) - 1) + 1;
  }

  /**
   * Zoekt de debiteur bij deze klant of maakt hem aan, en werkt de gegevens bij
   * met wat er nu bekend is. Zoekt op klantaccount, webshopklant en anders op de
   * herkenningssleutel (e-mail of naam). Hoort binnen een transactie te lopen
   * (factuur definitief maken).
   * @param {string} tenantId De omgeving.
   * @param {{ name, contact, address, email, phone, vatNumber }} customer Klantgegevens van de factuur.
   * @param {object} [options] Koppelingen: customerId (klantaccount), shopCustomerId (webshopklant), source ('factuur'|'webshop'|'handmatig') en start (eerste debiteurnummer).
   * @returns {object|null} De debiteur, of null als er niets is om hem aan te herkennen.
   */
  function ensure(tenantId, customer, { customerId = null, shopCustomerId = null, source = 'factuur', start = 1000 } = {}) {
    const cleaned = sanitizeDebtor(customer);
    const key = matchKey(cleaned);
    if (!key && !customerId && !shopCustomerId) return null;
    let row = null;
    if (customerId) row = prepare(`SELECT ${COLS} FROM debtors WHERE tenant_id = ? AND customer_id = ?`).get(tenantId, String(customerId));
    if (!row && shopCustomerId) row = prepare(`SELECT ${COLS} FROM debtors WHERE tenant_id = ? AND shop_customer_id = ?`).get(tenantId, String(shopCustomerId));
    if (!row && key) row = prepare(`SELECT ${COLS} FROM debtors WHERE tenant_id = ? AND match_key = ? ORDER BY number LIMIT 1`).get(tenantId, key);
    const timestamp = currentTimestamp();
    if (!row) {
      const id = crypto.randomUUID();
      prepare(`INSERT INTO debtors (id, tenant_id, number, name, contact, address, email, phone, vat_number, match_key, customer_id, shop_customer_id, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, nextNumber(tenantId, start), cleaned.name, cleaned.contact, cleaned.address, cleaned.email, cleaned.phone, cleaned.vatNumber, key,
          customerId ? String(customerId) : null, shopCustomerId ? String(shopCustomerId) : null, SOURCES[source] ? source : 'factuur', timestamp, timestamp);
      return get(tenantId, id);
    }
    // Bijwerken: alleen ingevulde velden overschrijven, koppelingen aanvullen.
    const next = {
      name: cleaned.name || row.name, contact: cleaned.contact || row.contact, address: cleaned.address || row.address,
      email: cleaned.email || row.email, phone: cleaned.phone || row.phone, vatNumber: cleaned.vatNumber || row.vat_number,
    };
    const changed = next.name !== row.name || next.contact !== row.contact || next.address !== row.address || next.email !== row.email
      || next.phone !== row.phone || next.vatNumber !== row.vat_number
      || (customerId && !row.customer_id) || (shopCustomerId && !row.shop_customer_id);
    if (changed) {
      prepare(`UPDATE debtors SET name = ?, contact = ?, address = ?, email = ?, phone = ?, vat_number = ?, match_key = ?,
          customer_id = COALESCE(customer_id, ?), shop_customer_id = COALESCE(shop_customer_id, ?), updated_at = ?
         WHERE tenant_id = ? AND id = ?`)
        .run(next.name, next.contact, next.address, next.email, next.phone, next.vatNumber, matchKey(next) || row.match_key,
          customerId ? String(customerId) : null, shopCustomerId ? String(shopCustomerId) : null, timestamp, tenantId, row.id);
      return get(tenantId, row.id);
    }
    return toDebtor(row);
  }

  /**
   * Haalt één debiteur op.
   * @param {string} tenantId De omgeving.
   * @param {string} id Id van de debiteur.
   * @returns {object|null} De debiteur, of null als hij niet bestaat in deze omgeving.
   */
  function get(tenantId, id) {
    const row = prepare(`SELECT ${COLS} FROM debtors WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));
    return row ? toDebtor(row) : null;
  }

  /**
   * Overzicht van de debiteuren met per debiteur het aantal facturen en het openstaande bedrag (één query).
   * @param {string} tenantId De omgeving.
   * @param {{ search?: string }} [options] Zoektekst op naam, e-mail of debiteurnummer.
   * @returns {object[]} Debiteuren met invoiceCount, openTotal en lastInvoice, hoogste nummer eerst.
   */
  function list(tenantId, { search = '' } = {}) {
    const args = [tenantId, tenantId];
    let sql = `SELECT d.id, d.number, d.name, d.contact, d.address, d.email, d.phone, d.vat_number, d.customer_id, d.shop_customer_id, d.source,
        d.created_at, d.updated_at, COALESCE(i.n, 0) AS invoice_count, COALESCE(i.open, 0) AS open_total, i.last_date
      FROM debtors d
      LEFT JOIN (SELECT debtor_id, COUNT(*) AS n, SUM(CASE WHEN status = 'definitief' THEN total ELSE 0 END) AS open, MAX(invoice_date) AS last_date
        FROM invoices WHERE tenant_id = ? AND debtor_id IS NOT NULL GROUP BY debtor_id) i ON i.debtor_id = d.id
      WHERE d.tenant_id = ?`;
    const searchText = cleanText(search, 100).toLowerCase();
    if (searchText) {
      sql += ' AND (lower(d.name) LIKE ? OR lower(d.email) LIKE ? OR CAST(d.number AS TEXT) = ?)';
      args.push(`%${searchText}%`, `%${searchText}%`, searchText);
    }
    return prepare(`${sql} ORDER BY d.number DESC LIMIT ${LIST_LIMIT}`).all(...args).map((row) => ({
      ...toDebtor(row), invoiceCount: Number(row.invoice_count), openTotal: Math.round(Number(row.open_total) * 100) / 100, lastInvoice: row.last_date || null,
    }));
  }

  /**
   * Debiteurnummers bij een reeks id's (voor de export), in blokken van 500 per query.
   * @param {string} tenantId De omgeving.
   * @param {string[]} ids Id's van debiteuren (lege waarden worden overgeslagen).
   * @returns {Map<string, number>} Debiteurnummer per id.
   */
  function numbers(tenantId, ids) {
    const uniqueIds = [...new Set(ids.filter(Boolean).map(String))];
    const out = new Map();
    for (let i = 0; i < uniqueIds.length; i += 500) {
      const part = uniqueIds.slice(i, i + 500);
      for (const row of prepare(`SELECT id, number FROM debtors WHERE tenant_id = ? AND id IN (${part.map(() => '?').join(',')})`).all(tenantId, ...part)) out.set(row.id, Number(row.number));
    }
    return out;
  }

  /**
   * Wijzigt de gegevens van een debiteur.
   * @param {string} tenantId De omgeving.
   * @param {string} id Id van de debiteur.
   * @param {object} raw Nieuwe waarden (velden die ontbreken blijven gelijk).
   * @returns {{ debtor: object }|{ error: string, field: string, status: number }|null} De bijgewerkte debiteur, een foutmelding, of null als hij niet bestaat.
   */
  function update(tenantId, id, raw) {
    const existing = get(tenantId, id);
    if (!existing) return null;
    const customer = sanitizeDebtor({ ...existing, ...(raw && typeof raw === 'object' ? raw : {}) });
    if (!customer.name) return { error: 'Vul de naam van de debiteur in.', field: 'name', status: 400 };
    prepare(`UPDATE debtors SET name = ?, contact = ?, address = ?, email = ?, phone = ?, vat_number = ?, match_key = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
      .run(customer.name, customer.contact, customer.address, customer.email, customer.phone, customer.vatNumber, matchKey(customer), currentTimestamp(), tenantId, existing.id);
    return { debtor: get(tenantId, existing.id) };
  }

  return { ensure, get, list, numbers, update, nextNumber };
}

/**
 * Registreert de routes GET /api/debtors en GET|PUT /api/debtors/:id (recht facturen).
 * @param {object} app De Express-app.
 * @param {object} context Afhankelijkheden: debtors (opslag), requireRight, requireJson en audit.
 * @returns {void}
 */
function registerDebtorRoutes(app, { debtors, requireRight, requireJson, audit }) {
  const requireInvoices = requireRight('facturen');
  /**
   * Omgeving van het verzoek.
   * @param {object} req Het Express-verzoek.
   * @returns {string} Id van de actieve omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Stuurt 404 'debiteur niet gevonden'.
   * @param {object} res Het Express-antwoord.
   * @returns {object} Het antwoord.
   */
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Debiteur niet gevonden.' });

  app.get('/api/debtors', requireInvoices, (req, res) => {
    res.json({ items: debtors.list(tenantOf(req), { search: String(req.query.q || '') }), sources: SOURCES });
  });
  app.get('/api/debtors/:id', requireInvoices, (req, res) => {
    const debtor = debtors.get(tenantOf(req), req.params.id);
    if (!debtor) return notFound(res);
    res.json(debtor);
  });
  app.put('/api/debtors/:id', requireJson, requireInvoices, (req, res) => {
    const out = debtors.update(tenantOf(req), req.params.id, req.body);
    if (!out) return notFound(res);
    if (out.error) return res.status(out.status).json({ error: 'invalid', field: out.field, message: out.error });
    audit(req, 'debiteur_gewijzigd', { debtorId: out.debtor.id });
    res.json(out.debtor);
  });
}

module.exports = { createDebtorStore, registerDebtorRoutes, matchKey, sanitizeDebtor, SOURCES };
