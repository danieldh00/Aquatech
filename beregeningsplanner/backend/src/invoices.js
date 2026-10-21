// Facturen: opslag (tabel invoices, migratie 26), de factuurinstellingen
// (instelling invoicing: nummering, betaaltermijn, omzetcategorieën met
// grootboekrekening) en de API-routes. De berekening staat in
// frontend/facturen/invoice-core.js en is gedeeld met de browser.
//
// - Een factuur begint als concept (zonder nummer) en wordt definitief met
//   een doorlopend nummer per jaar (<voorvoegsel><jaar>-0001). Daarna ligt
//   hij vast; corrigeren gaat met een creditfactuur.
// - Uit een werkorder: de offerteregels plus meerwerk, of het geboekte
//   materiaal en de geboekte uren (InvoiceCore.fromWorkOrder).
// - Een losse verkoop (zonder werkorder) boekt bij definitief de artikelen
//   af van de voorraad (bron factuur:<id>); een creditfactuur daarvan boekt
//   ze terug. Bij een werkorder doet de werkorder dat al.
// - Export naar de boekhouding (Visma eAccounting): per factuur per
//   omzetcategorie een regel, als Excel in de browser; exported_at onthoudt
//   wat al is geëxporteerd.
// Alles per omgeving (req.tenantId); recht 'facturen'.
const path = require('path');
const crypto = require('crypto');
const { transaction } = require('./db');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'facturen', 'invoice-core.js'));

const LIST_COLS = `id, number, status, kind, credit_of, customer_id, customer_name, work_order_id, quote_id, invoice_date, due_date,
  subtotal, vat_total, total, stock_booked, finalized_at, paid_at, credited_at, exported_at, created_at, updated_at`;
const LIST_LIMIT = 1000;
const EXPORT_LIMIT = 5000;
const now = () => new Date().toISOString();
const marks = (n) => Array.from({ length: n }, () => '?').join(',');

function createInvoiceStore(db, { stock = null } = {}) {
  const q = (sql) => db.prepare(sql);

  const shape = (r) => ({
    id: r.id, number: r.number || '', status: r.status, kind: r.kind, creditOf: r.credit_of || null,
    customerId: r.customer_id || null, customer: r.customer_name, workOrderId: r.work_order_id || null, quoteId: r.quote_id || null,
    date: r.invoice_date, dueDate: r.due_date, subtotal: Number(r.subtotal), vatTotal: Number(r.vat_total), total: Number(r.total),
    stockBooked: Boolean(Number(r.stock_booked)), finalizedAt: r.finalized_at || null, paidAt: r.paid_at || null,
    creditedAt: r.credited_at || null, exportedAt: r.exported_at || null, createdAt: r.created_at, updatedAt: r.updated_at,
    overdue: r.status === 'definitief' && r.kind === 'factuur' && r.due_date < Core.today(),
  });

  const find = (tenantId, id, cols = LIST_COLS) => q(`SELECT ${cols} FROM invoices WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));

  function list(tenantId, { status = '', from = '', to = '', workOrderId = '' } = {}) {
    const args = [tenantId];
    let sql = `SELECT ${LIST_COLS} FROM invoices WHERE tenant_id = ?`;
    if (Core.STATUSES[status]) { sql += ' AND status = ?'; args.push(status); }
    if (Core.isDate(from)) { sql += ' AND invoice_date >= ?'; args.push(from); }
    if (Core.isDate(to)) { sql += ' AND invoice_date <= ?'; args.push(to); }
    if (workOrderId) { sql += ' AND work_order_id = ?'; args.push(String(workOrderId)); }
    return q(`${sql} ORDER BY invoice_date DESC, created_at DESC LIMIT ${LIST_LIMIT}`).all(...args).map(shape);
  }

  function get(tenantId, id) {
    const r = find(tenantId, id, `${LIST_COLS}, data`);
    if (!r) return null;
    return { ...shape(r), data: JSON.parse(r.data) };
  }

  // Factuurnummer per tenant en jaar: <voorvoegsel><jaar>-0001, oplopend.
  function nextNumber(tenantId, prefix, year) {
    const head = `${prefix}${year}-`;
    let max = 0;
    for (const r of q('SELECT number FROM invoices WHERE tenant_id = ? AND number IS NOT NULL AND substr(number, 1, ?) = ?').all(tenantId, head.length, head)) {
      const n = Number(r.number.slice(head.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  function create(tenantId, user, rawData, settings, { workOrderId = null, quoteId = null, customerId = null, kind = 'factuur', creditOf = null } = {}) {
    const data = Core.sanitize(rawData, settings);
    const t = Core.totals(data, settings);
    const id = crypto.randomUUID();
    const ts = now();
    q(`INSERT INTO invoices (id, tenant_id, number, status, kind, credit_of, customer_id, customer_name, work_order_id, quote_id, invoice_date, due_date,
        subtotal, vat_total, total, data, stock_booked, created_by, created_at, updated_at)
       VALUES (?, ?, NULL, 'concept', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
      .run(id, tenantId, kind === 'credit' ? 'credit' : 'factuur', creditOf, customerId, data.customer.name.trim(), workOrderId, quoteId,
        data.date, data.dueDate, t.net, t.vatTotal, t.total, JSON.stringify(data), user ? user.id : null, ts, ts);
    return get(tenantId, id);
  }

  function update(tenantId, id, rawData, settings) {
    const r = find(tenantId, id);
    if (!r) return null;
    if (r.status !== 'concept') return { locked: true };
    const data = Core.sanitize(rawData, settings);
    const t = Core.totals(data, settings);
    q(`UPDATE invoices SET customer_name = ?, invoice_date = ?, due_date = ?, subtotal = ?, vat_total = ?, total = ?, data = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'concept'`)
      .run(data.customer.name.trim(), data.date, data.dueDate, t.net, t.vatTotal, t.total, JSON.stringify(data), now(), tenantId, r.id);
    return get(tenantId, r.id);
  }

  /** Definitief maken: nummer, vastleggen, en bij een losse verkoop de voorraad. */
  function finalize(tenantId, user, id, settings) {
    return transaction(db, () => {
      const r = find(tenantId, id, `${LIST_COLS}, data`);
      if (!r) return null;
      if (r.status !== 'concept') return { error: 'Deze factuur is al definitief.', status: 409 };
      const data = JSON.parse(r.data);
      if (!data.customer.name.trim()) return { error: 'Vul de naam van de klant in.', field: 'customer', status: 400 };
      if (!data.lines.length) return { error: 'Een factuur zonder regels kan niet definitief worden.', field: 'lines', status: 400 };
      const number = nextNumber(tenantId, settings.prefix, data.date.slice(0, 4));
      const ts = now();
      let booked = 0;
      if (stock && !r.work_order_id) {
        const wantCredit = r.kind === 'credit';
        // Een creditfactuur boekt alleen terug wat de oorspronkelijke factuur heeft afgeboekt.
        const orig = wantCredit && r.credit_of ? find(tenantId, r.credit_of) : null;
        if (!wantCredit || (orig && Number(orig.stock_booked))) {
          for (const l of data.lines) {
            const it = l.code ? stock.findCode(tenantId, l.code) : null;
            if (!it || it.archived || !l.qty) continue;
            stock.book(tenantId, it.id, -l.qty, {
              kind: l.qty > 0 ? 'afboeking' : 'retour', source: `factuur:${r.id}`, user,
              note: `${wantCredit ? 'Creditfactuur' : 'Factuur'} ${number}`,
            });
            booked++;
          }
        }
      }
      q(`UPDATE invoices SET number = ?, status = 'definitief', finalized_at = ?, stock_booked = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
        .run(number, ts, booked ? 1 : 0, ts, tenantId, r.id);
      if (r.kind === 'credit' && r.credit_of) q('UPDATE invoices SET credited_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(ts, ts, tenantId, r.credit_of);
      return { invoice: get(tenantId, r.id), booked };
    });
  }

  function setPaid(tenantId, id, paid, date) {
    const r = find(tenantId, id);
    if (!r) return null;
    if (r.status === 'concept') return { error: 'Maak de factuur eerst definitief.', status: 409 };
    const at = paid ? (Core.isDate(date) ? `${date}T12:00:00.000Z` : now()) : null;
    q('UPDATE invoices SET status = ?, paid_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(paid ? 'betaald' : 'definitief', at, now(), tenantId, r.id);
    return { invoice: get(tenantId, r.id) };
  }

  function credit(tenantId, user, id, settings) {
    const r = get(tenantId, id);
    if (!r) return null;
    if (r.status === 'concept') return { error: 'Een concept kun je gewoon aanpassen of verwijderen.', status: 409 };
    if (r.kind === 'credit') return { error: 'Een creditfactuur kun je niet crediteren.', status: 409 };
    const open = q("SELECT id FROM invoices WHERE tenant_id = ? AND credit_of = ? AND status = 'concept'").get(tenantId, r.id);
    if (open) return { invoice: get(tenantId, open.id), existing: true };
    return {
      invoice: create(tenantId, user, Core.creditOf(r), settings, {
        workOrderId: r.workOrderId, quoteId: r.quoteId, customerId: r.customerId, kind: 'credit', creditOf: r.id,
      }),
    };
  }

  function remove(tenantId, id) {
    const r = find(tenantId, id);
    if (!r) return null;
    if (r.status !== 'concept') return { error: 'Een definitieve factuur kan niet weg (bewaarplicht); maak een creditfactuur.', status: 409 };
    q("DELETE FROM invoices WHERE tenant_id = ? AND id = ? AND status = 'concept'").run(tenantId, r.id);
    return { deleted: true };
  }

  /** Definitieve facturen met regels voor de export, oudste eerst. */
  function exportList(tenantId, { from = '', to = '', onlyNew = false } = {}) {
    const args = [tenantId];
    let sql = `SELECT ${LIST_COLS}, data FROM invoices WHERE tenant_id = ? AND status <> 'concept'`;
    if (Core.isDate(from)) { sql += ' AND invoice_date >= ?'; args.push(from); }
    if (Core.isDate(to)) { sql += ' AND invoice_date <= ?'; args.push(to); }
    if (onlyNew) sql += ' AND exported_at IS NULL';
    return q(`${sql} ORDER BY invoice_date, number LIMIT ${EXPORT_LIMIT}`).all(...args).map((r) => ({ ...shape(r), data: JSON.parse(r.data) }));
  }

  function markExported(tenantId, ids) {
    const list0 = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, EXPORT_LIMIT);
    if (!list0.length) return 0;
    const ts = now();
    let n = 0;
    for (let i = 0; i < list0.length; i += 500) {
      const part = list0.slice(i, i + 500);
      n += Number(q(`UPDATE invoices SET exported_at = ? WHERE tenant_id = ? AND status <> 'concept' AND id IN (${marks(part.length)})`).run(ts, tenantId, ...part).changes || 0);
    }
    return n;
  }

  // Bronnen voor een factuur uit een werkorder (alleen binnen de eigen omgeving).
  function workOrder(tenantId, id) {
    const r = q('SELECT id, number, quote_id, data FROM work_orders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, String(id));
    if (!r) return null;
    // Werkorder uit een melding: de klant van de melding.
    const sr = q('SELECT customer_id FROM service_requests WHERE tenant_id = ? AND work_order_id = ?').get(tenantId, r.id);
    return { id: r.id, number: r.number, quoteId: r.quote_id || null, data: JSON.parse(r.data), customerId: (sr && sr.customer_id) || null };
  }
  function quote(tenantId, id) {
    const r = q("SELECT id, number, status, customer_id, data FROM quotes WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL").get(tenantId, String(id));
    return r ? { id: r.id, number: r.number, status: r.status, customerId: r.customer_id || null, data: JSON.parse(r.data) } : null;
  }

  return { list, get, create, update, finalize, setPaid, credit, remove, exportList, markExported, nextNumber, workOrder, quote };
}

/**
 * API-routes. ctx: { invoices, requireRight, requireJson, audit, settingsOf(req),
 * loggedOf(tid, woId), articlesOf(tid), catalog() }.
 */
function registerInvoiceRoutes(app, ctx) {
  const { invoices, requireRight, requireJson, audit, settingsOf } = ctx;
  const requireInvoices = requireRight('facturen');
  const tid = (req) => req.tenantId || req.user.tenant_id;
  const conf = (req) => Core.sanitizeSettings(settingsOf(req).get('invoicing'));
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Factuur niet gevonden.' });
  const fail = (res, out) => res.status(out.status || 400).json({ error: out.status === 409 ? 'conflict' : 'invalid', message: out.error, field: out.field });
  const validData = (d) => d && typeof d === 'object' && !Array.isArray(d);

  app.get('/api/invoices', requireInvoices, (req, res) => {
    res.json({ items: invoices.list(tid(req), { status: String(req.query.status || ''), from: String(req.query.from || ''), to: String(req.query.to || ''), workOrderId: String(req.query.workOrderId || '') }) });
  });

  // Instellingen en artikelen vóór /:id.
  app.get('/api/invoices/settings', requireInvoices, (req, res) => {
    const p = settingsOf(req).get('quoteProfile');
    res.json({ settings: conf(req), profile: p, groups: Core.GROUPS, rates: Core.VAT_RATES });
  });

  app.put('/api/invoices/settings', requireJson, requireInvoices, (req, res) => {
    const value = Core.sanitizeSettings(req.body);
    try {
      settingsOf(req).update({ invoicing: value }, req.user.id);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_setting', field: err.field, message: err.message });
    }
    audit(req, 'instellingen_gewijzigd', { fields: ['invoicing'] });
    res.json({ settings: conf(req) });
  });

  app.get('/api/invoices/articles', requireInvoices, (req, res) => {
    res.json({ articles: ctx.articlesOf(tid(req)) });
  });

  app.get('/api/invoices/export', requireInvoices, (req, res) => {
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if ((from && !Core.isDate(from)) || (to && !Core.isDate(to))) return res.status(400).json({ error: 'invalid_date', message: 'Ongeldige datum.' });
    const items = invoices.exportList(tid(req), { from, to, onlyNew: req.query.new === '1' });
    res.json({ items, settings: conf(req), limit: EXPORT_LIMIT });
  });

  app.post('/api/invoices/export/mark', requireJson, requireInvoices, (req, res) => {
    const n = invoices.markExported(tid(req), req.body && req.body.ids);
    if (n) audit(req, 'facturen_geexporteerd', { count: n });
    res.json({ marked: n });
  });

  app.get('/api/invoices/:id', requireInvoices, (req, res) => {
    const inv = invoices.get(tid(req), req.params.id);
    if (!inv) return notFound(res);
    res.json(inv);
  });

  // Nieuw: { workOrderId } (uit de werkorder; force = ook als er al een is) of { data }.
  app.post('/api/invoices', requireJson, requireInvoices, (req, res) => {
    const b = req.body || {};
    const t = tid(req);
    const settings = conf(req);
    if (b.workOrderId) {
      const wo = invoices.workOrder(t, String(b.workOrderId));
      if (!wo) return res.status(404).json({ error: 'not_found', message: 'Werkorder niet gevonden.' });
      const existing = invoices.list(t, { workOrderId: wo.id }).filter((i) => i.kind === 'factuur');
      if (existing.length && !b.force) {
        return res.status(409).json({ error: 'exists', message: `Voor deze werkorder bestaat al factuur ${existing[0].number || '(concept)'}.`, invoiceId: existing[0].id });
      }
      const quote = wo.quoteId ? invoices.quote(t, wo.quoteId) : null;
      const built = Core.fromWorkOrder(wo, {
        quote, logged: ctx.loggedOf(t, wo.id), articles: ctx.articlesOf(t), catalog: ctx.catalog(),
        hourlyRate: settingsOf(req).get('quoteProfile').hourlyRate, settings,
      });
      const inv = invoices.create(t, req.user, built.data, settings, { workOrderId: wo.id, quoteId: quote ? quote.id : null, customerId: (quote && quote.customerId) || wo.customerId || null });
      audit(req, 'factuur_aangemaakt', { invoiceId: inv.id, workOrderId: wo.id });
      return res.status(201).json({ ...inv, warnings: built.warnings });
    }
    if (b.data !== undefined && !validData(b.data)) return res.status(400).json({ error: 'invalid_invoice', message: 'Ongeldige factuur.' });
    const inv = invoices.create(t, req.user, b.data || {}, settings);
    audit(req, 'factuur_aangemaakt', { invoiceId: inv.id });
    res.status(201).json(inv);
  });

  app.put('/api/invoices/:id', requireJson, requireInvoices, (req, res) => {
    if (!validData(req.body && req.body.data)) return res.status(400).json({ error: 'invalid_invoice', message: 'Ongeldige factuur.' });
    const out = invoices.update(tid(req), req.params.id, req.body.data, conf(req));
    if (!out) return notFound(res);
    if (out.locked) return res.status(409).json({ error: 'locked', message: 'Een definitieve factuur kan niet meer veranderen; maak een creditfactuur.' });
    res.json(out);
  });

  app.post('/api/invoices/:id/finalize', requireJson, requireInvoices, (req, res) => {
    const out = invoices.finalize(tid(req), req.user, req.params.id, conf(req));
    if (!out) return notFound(res);
    if (out.error) return fail(res, out);
    audit(req, 'factuur_definitief', { invoiceId: out.invoice.id, number: out.invoice.number, total: out.invoice.total });
    res.json(out.invoice);
  });

  app.post('/api/invoices/:id/paid', requireJson, requireInvoices, (req, res) => {
    const out = invoices.setPaid(tid(req), req.params.id, req.body && req.body.paid !== false, req.body && req.body.date);
    if (!out) return notFound(res);
    if (out.error) return fail(res, out);
    res.json(out.invoice);
  });

  app.post('/api/invoices/:id/credit', requireJson, requireInvoices, (req, res) => {
    const out = invoices.credit(tid(req), req.user, req.params.id, conf(req));
    if (!out) return notFound(res);
    if (out.error) return fail(res, out);
    if (!out.existing) audit(req, 'creditfactuur_aangemaakt', { invoiceId: out.invoice.id, creditOf: req.params.id });
    res.status(out.existing ? 200 : 201).json(out.invoice);
  });

  app.delete('/api/invoices/:id', requireInvoices, (req, res) => {
    const out = invoices.remove(tid(req), req.params.id);
    if (!out) return notFound(res);
    if (out.error) return fail(res, out);
    audit(req, 'factuur_verwijderd', { invoiceId: req.params.id });
    res.json(out);
  });
}

module.exports = { createInvoiceStore, registerInvoiceRoutes, sanitizeInvoicing: Core.sanitizeSettings };
