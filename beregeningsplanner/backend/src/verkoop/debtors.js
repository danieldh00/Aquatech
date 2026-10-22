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
const now = () => new Date().toISOString();

const str = (v, max) => String(v == null ? '' : v).slice(0, max).trim();
/** Herkenning: e-mailadres, anders de naam (hoofdletters en spaties maken niet uit). */
function matchKey(c) {
  const email = str(c.email, 200).toLowerCase();
  if (email) return `e:${email}`;
  const name = str(c.name, 200).toLowerCase().replace(/\s+/g, ' ');
  return name ? `n:${name}` : '';
}

function sanitizeDebtor(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [k, max] of Object.entries(FIELDS)) out[k] = str(r[k], max);
  return out;
}

function createDebtorStore(db) {
  const q = (sql) => db.prepare(sql);
  const shape = (r) => ({
    id: r.id, number: Number(r.number), name: r.name, contact: r.contact, address: r.address, email: r.email, phone: r.phone,
    vatNumber: r.vat_number, customerId: r.customer_id || null, shopCustomerId: r.shop_customer_id || null, source: r.source,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });

  function nextNumber(tenantId, start) {
    const r = q('SELECT MAX(number) AS n FROM debtors WHERE tenant_id = ?').get(tenantId);
    return Math.max(Number(r && r.n) || 0, (Number(start) || 1000) - 1) + 1;
  }

  /**
   * Zoekt de debiteur bij deze klant of maakt hem aan; werkt de gegevens bij
   * met wat er nu bekend is. customer: { name, contact, address, email, phone, vatNumber }.
   * Hoort binnen een transactie te lopen (factuur definitief maken).
   */
  function ensure(tenantId, customer, { customerId = null, shopCustomerId = null, source = 'factuur', start = 1000 } = {}) {
    const c = sanitizeDebtor(customer);
    const key = matchKey(c);
    if (!key && !customerId && !shopCustomerId) return null;
    let r = null;
    if (customerId) r = q(`SELECT ${COLS} FROM debtors WHERE tenant_id = ? AND customer_id = ?`).get(tenantId, String(customerId));
    if (!r && shopCustomerId) r = q(`SELECT ${COLS} FROM debtors WHERE tenant_id = ? AND shop_customer_id = ?`).get(tenantId, String(shopCustomerId));
    if (!r && key) r = q(`SELECT ${COLS} FROM debtors WHERE tenant_id = ? AND match_key = ? ORDER BY number LIMIT 1`).get(tenantId, key);
    const ts = now();
    if (!r) {
      const id = crypto.randomUUID();
      q(`INSERT INTO debtors (id, tenant_id, number, name, contact, address, email, phone, vat_number, match_key, customer_id, shop_customer_id, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, nextNumber(tenantId, start), c.name, c.contact, c.address, c.email, c.phone, c.vatNumber, key,
          customerId ? String(customerId) : null, shopCustomerId ? String(shopCustomerId) : null, SOURCES[source] ? source : 'factuur', ts, ts);
      return get(tenantId, id);
    }
    // Bijwerken: alleen ingevulde velden overschrijven, koppelingen aanvullen.
    const next = {
      name: c.name || r.name, contact: c.contact || r.contact, address: c.address || r.address,
      email: c.email || r.email, phone: c.phone || r.phone, vatNumber: c.vatNumber || r.vat_number,
    };
    const changed = next.name !== r.name || next.contact !== r.contact || next.address !== r.address || next.email !== r.email
      || next.phone !== r.phone || next.vatNumber !== r.vat_number
      || (customerId && !r.customer_id) || (shopCustomerId && !r.shop_customer_id);
    if (changed) {
      q(`UPDATE debtors SET name = ?, contact = ?, address = ?, email = ?, phone = ?, vat_number = ?, match_key = ?,
          customer_id = COALESCE(customer_id, ?), shop_customer_id = COALESCE(shop_customer_id, ?), updated_at = ?
         WHERE tenant_id = ? AND id = ?`)
        .run(next.name, next.contact, next.address, next.email, next.phone, next.vatNumber, matchKey(next) || r.match_key,
          customerId ? String(customerId) : null, shopCustomerId ? String(shopCustomerId) : null, ts, tenantId, r.id);
      return get(tenantId, r.id);
    }
    return shape(r);
  }

  function get(tenantId, id) {
    const r = q(`SELECT ${COLS} FROM debtors WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));
    return r ? shape(r) : null;
  }

  /** Overzicht met per debiteur het aantal facturen en het openstaande bedrag (één query). */
  function list(tenantId, { search = '' } = {}) {
    const args = [tenantId, tenantId];
    let sql = `SELECT d.id, d.number, d.name, d.contact, d.address, d.email, d.phone, d.vat_number, d.customer_id, d.shop_customer_id, d.source,
        d.created_at, d.updated_at, COALESCE(i.n, 0) AS invoice_count, COALESCE(i.open, 0) AS open_total, i.last_date
      FROM debtors d
      LEFT JOIN (SELECT debtor_id, COUNT(*) AS n, SUM(CASE WHEN status = 'definitief' THEN total ELSE 0 END) AS open, MAX(invoice_date) AS last_date
        FROM invoices WHERE tenant_id = ? AND debtor_id IS NOT NULL GROUP BY debtor_id) i ON i.debtor_id = d.id
      WHERE d.tenant_id = ?`;
    const s = str(search, 100).toLowerCase();
    if (s) {
      sql += ' AND (lower(d.name) LIKE ? OR lower(d.email) LIKE ? OR CAST(d.number AS TEXT) = ?)';
      args.push(`%${s}%`, `%${s}%`, s);
    }
    return q(`${sql} ORDER BY d.number DESC LIMIT ${LIST_LIMIT}`).all(...args).map((r) => ({
      ...shape(r), invoiceCount: Number(r.invoice_count), openTotal: Math.round(Number(r.open_total) * 100) / 100, lastInvoice: r.last_date || null,
    }));
  }

  /** Nummers bij een reeks id's (voor de export), één query. */
  function numbers(tenantId, ids) {
    const list0 = [...new Set(ids.filter(Boolean).map(String))];
    const out = new Map();
    for (let i = 0; i < list0.length; i += 500) {
      const part = list0.slice(i, i + 500);
      for (const r of q(`SELECT id, number FROM debtors WHERE tenant_id = ? AND id IN (${part.map(() => '?').join(',')})`).all(tenantId, ...part)) out.set(r.id, Number(r.number));
    }
    return out;
  }

  function update(tenantId, id, raw) {
    const r = get(tenantId, id);
    if (!r) return null;
    const c = sanitizeDebtor({ ...r, ...(raw && typeof raw === 'object' ? raw : {}) });
    if (!c.name) return { error: 'Vul de naam van de debiteur in.', field: 'name', status: 400 };
    q(`UPDATE debtors SET name = ?, contact = ?, address = ?, email = ?, phone = ?, vat_number = ?, match_key = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
      .run(c.name, c.contact, c.address, c.email, c.phone, c.vatNumber, matchKey(c), now(), tenantId, r.id);
    return { debtor: get(tenantId, r.id) };
  }

  return { ensure, get, list, numbers, update, nextNumber };
}

/** Routes: GET /api/debtors, GET|PUT /api/debtors/:id (recht facturen). */
function registerDebtorRoutes(app, { debtors, requireRight, requireJson, audit }) {
  const requireInvoices = requireRight('facturen');
  const tid = (req) => req.tenantId || req.user.tenant_id;
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Debiteur niet gevonden.' });

  app.get('/api/debtors', requireInvoices, (req, res) => {
    res.json({ items: debtors.list(tid(req), { search: String(req.query.q || '') }), sources: SOURCES });
  });
  app.get('/api/debtors/:id', requireInvoices, (req, res) => {
    const d = debtors.get(tid(req), req.params.id);
    if (!d) return notFound(res);
    res.json(d);
  });
  app.put('/api/debtors/:id', requireJson, requireInvoices, (req, res) => {
    const out = debtors.update(tid(req), req.params.id, req.body);
    if (!out) return notFound(res);
    if (out.error) return res.status(out.status).json({ error: 'invalid', field: out.field, message: out.error });
    audit(req, 'debiteur_gewijzigd', { debtorId: out.debtor.id });
    res.json(out.debtor);
  });
}

module.exports = { createDebtorStore, registerDebtorRoutes, matchKey, sanitizeDebtor, SOURCES };
