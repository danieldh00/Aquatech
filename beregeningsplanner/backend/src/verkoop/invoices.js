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
// - Definitief maken koppelt de factuur aan een debiteur (debtors.js).
// - Versturen: per e-mail met de factuur als PDF (invoice-pdf.js), met de
//   knop of automatisch bij definitief (instelling autoSend).
// - Uit de webshop: shop-orders.js maakt van een afgeronde bestelling een
//   factuur (shop_order_id); de voorraad volgt dan uit de webshopsynchronisatie.
// Alles per omgeving (req.tenantId); recht 'facturen'.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const crypto = require('crypto');
const { transaction } = require('../database/db');
const { validEmail } = require('../platform/mailer');
const { preferencesOf } = require('../platform/store');
const { invoiceFileName } = require('./invoice-pdf');
const { SourceError } = require('../webshop/woocommerce');

const Core = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));

const LIST_COLS = `id, number, status, kind, credit_of, customer_id, customer_name, work_order_id, quote_id, invoice_date, due_date,
  subtotal, vat_total, total, stock_booked, finalized_at, paid_at, credited_at, exported_at, created_at, updated_at,
  debtor_id, shop_order_id, sent_at, sent_to, send_error, visma_invoice_id, visma_number, visma_synced_at, visma_error`;
// Debiteurnummer erbij (één query, geen opzoeking per factuur).
const DEBTOR_NUMBER = '(SELECT d.number FROM debtors d WHERE d.tenant_id = invoices.tenant_id AND d.id = invoices.debtor_id) AS debtor_number';
const LIST_LIMIT = 1000;
const EXPORT_LIMIT = 5000;
const now = () => new Date().toISOString();
const wrapAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Kopie aan de medewerker zelf (voorkeur mailCopy in Mijn profiel).
const copyTo = (user) => (user && preferencesOf(user).mailCopy && validEmail(user.email) ? user.email : undefined);
const marks = (n) => Array.from({ length: n }, () => '?').join(',');

function createInvoiceStore(db, { stock = null, debtors = null } = {}) {
  const q = (sql) => db.prepare(sql);

  const shape = (r) => ({
    id: r.id, number: r.number || '', status: r.status, kind: r.kind, creditOf: r.credit_of || null,
    customerId: r.customer_id || null, customer: r.customer_name, workOrderId: r.work_order_id || null, quoteId: r.quote_id || null,
    date: r.invoice_date, dueDate: r.due_date, subtotal: Number(r.subtotal), vatTotal: Number(r.vat_total), total: Number(r.total),
    stockBooked: Boolean(Number(r.stock_booked)), finalizedAt: r.finalized_at || null, paidAt: r.paid_at || null,
    creditedAt: r.credited_at || null, exportedAt: r.exported_at || null, createdAt: r.created_at, updatedAt: r.updated_at,
    debtorId: r.debtor_id || null, shopOrderId: r.shop_order_id || null,
    source: r.shop_order_id ? 'webshop' : r.work_order_id ? 'werkorder' : 'los',
    sentAt: r.sent_at || null, sentTo: r.sent_to || null, sendError: r.send_error || '',
    vismaInvoiceId: r.visma_invoice_id || null, vismaNumber: r.visma_number || null, vismaSyncedAt: r.visma_synced_at || null, vismaError: r.visma_error || '',
    ...(r.debtor_number !== undefined ? { debtorNumber: r.debtor_number == null ? null : Number(r.debtor_number) } : {}),
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
    const r = find(tenantId, id, `${LIST_COLS}, ${DEBTOR_NUMBER}, data`);
    if (!r) return null;
    return { ...shape(r), data: JSON.parse(r.data) };
  }

  /** Factuur bij een webshopbestelling (of null). */
  function byShopOrders(tenantId, orderIds) {
    const ids = [...new Set(orderIds.map(String))];
    const out = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const r of q(`SELECT id, shop_order_id FROM invoices WHERE tenant_id = ? AND shop_order_id IN (${marks(part.length)})`).all(tenantId, ...part)) out.set(r.shop_order_id, r.id);
    }
    return out;
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

  function create(tenantId, user, rawData, settings, { workOrderId = null, quoteId = null, customerId = null, kind = 'factuur', creditOf = null, shopOrderId = null, debtorId = null } = {}) {
    const data = Core.sanitize(rawData, settings);
    const t = Core.totals(data, settings);
    const id = crypto.randomUUID();
    const ts = now();
    q(`INSERT INTO invoices (id, tenant_id, number, status, kind, credit_of, customer_id, customer_name, work_order_id, quote_id, invoice_date, due_date,
        subtotal, vat_total, total, data, stock_booked, created_by, created_at, updated_at, shop_order_id, debtor_id)
       VALUES (?, ?, NULL, 'concept', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, kind === 'credit' ? 'credit' : 'factuur', creditOf, customerId, data.customer.name.trim(), workOrderId, quoteId,
        data.date, data.dueDate, t.net, t.vatTotal, t.total, JSON.stringify(data), user ? user.id : null, ts, ts,
        shopOrderId ? String(shopOrderId) : null, debtorId);
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

  /**
   * Definitief maken: nummer, debiteur, vastleggen, en bij een losse verkoop
   * de voorraad. skipStock: niet afboeken (webshopbestelling waarvan de
   * voorraad al via de webshopsynchronisatie is afgeboekt).
   */
  // Na definitief (buiten de transactie), bijv. doorsturen naar Visma.
  const finalizedHooks = [];
  const onFinalized = (fn) => { finalizedHooks.push(fn); };
  function finalize(tenantId, user, id, settings, opts) {
    const out = finalizeTx(tenantId, user, id, settings, opts);
    if (out && out.invoice) {
      for (const fn of finalizedHooks) {
        try { fn(tenantId, out.invoice); } catch (err) { console.warn(`Na definitief: ${err.message}`); }
      }
    }
    return out;
  }
  function finalizeTx(tenantId, user, id, settings, { skipStock = false } = {}) {
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
      if (stock && !r.work_order_id && !(r.shop_order_id && skipStock)) {
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
      // Debiteur: dezelfde als bij de vorige factuur van deze klant, of een nieuwe.
      let debtorId = r.debtor_id || null;
      if (debtors && !debtorId) {
        const deb = debtors.ensure(tenantId, data.customer, { customerId: r.customer_id, source: r.shop_order_id ? 'webshop' : 'factuur', start: settings.debtorStart });
        if (deb) debtorId = deb.id;
      }
      q(`UPDATE invoices SET number = ?, status = 'definitief', finalized_at = ?, stock_booked = ?, debtor_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
        .run(number, ts, booked ? 1 : 0, debtorId, ts, tenantId, r.id);
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
        workOrderId: r.workOrderId, quoteId: r.quoteId, customerId: r.customerId, kind: 'credit', creditOf: r.id, debtorId: r.debtorId,
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
    let sql = `SELECT ${LIST_COLS}, ${DEBTOR_NUMBER}, data FROM invoices WHERE tenant_id = ? AND status <> 'concept'`;
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

  /** Na versturen per e-mail (of de fout als dat mislukte). */
  function markSent(tenantId, id, to, error = '') {
    if (error) q('UPDATE invoices SET send_error = ? WHERE tenant_id = ? AND id = ?').run(String(error).slice(0, 300), tenantId, String(id));
    else q("UPDATE invoices SET sent_at = ?, sent_to = ?, send_error = '' WHERE tenant_id = ? AND id = ?").run(now(), String(to).slice(0, 400), tenantId, String(id));
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

  return { list, get, create, update, finalize, onFinalized, setPaid, credit, remove, exportList, markExported, nextNumber, workOrder, quote, byShopOrders, markSent };
}

/**
 * API-routes. ctx: { invoices, requireRight, requireJson, audit, settingsOf(req),
 * loggedOf(tid, woId), articlesOf(tid), catalog(), sender (invoice-mail.js),
 * shopOrders (shop-orders.js), mailConfigured(req), shopOf(req), syncLimiter }.
 */
function registerInvoiceRoutes(app, ctx) {
  const { invoices, requireRight, requireJson, audit, settingsOf, sender, shopOrders } = ctx;
  const syncLimiter = ctx.syncLimiter || ((req, res, next) => next());
  // Voorraad van een webshopfactuur: al afgeboekt als de voorraad naar de webshop gaat (shop-sync.js).
  const shopStockSynced = (req) => {
    const s = ctx.shopOf ? ctx.shopOf(req) : {};
    return Boolean(s.push && s.pushStock !== false && s.mode === 'rest');
  };
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
    const shop = ctx.shopOf ? ctx.shopOf(req) : {};
    res.json({
      settings: conf(req), profile: p, groups: Core.GROUPS, rates: Core.VAT_RATES, shopStatuses: Core.SHOP_STATUSES,
      mail: ctx.mailConfigured ? ctx.mailConfigured(req) : false,
      shop: { url: shop.url || '', rest: shop.mode === 'rest', stockSynced: shopStockSynced(req), orders: shopOrders ? shopOrders.status(tid(req)) : null },
    });
  });

  app.put('/api/invoices/settings', requireJson, requireInvoices, (req, res) => {
    const value = Core.sanitizeSettings(req.body);
    // Bestellingen ophalen aangezet zonder datum: vanaf vandaag (oudere zijn al gefactureerd).
    if (value.shopOrders.enabled && !value.shopOrders.since) value.shopOrders.since = Core.today();
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

  // Webshopbestellingen nu ophalen (anders elke 10 minuten vanzelf).
  app.post('/api/invoices/shop-orders/sync', requireJson, requireInvoices, syncLimiter, wrapAsync(async (req, res) => {
    if (!shopOrders) return res.status(404).json({ error: 'not_found', message: 'Niet beschikbaar.' });
    try {
      const out = await shopOrders.run(tid(req), { user: req.user });
      if (out.skipped === 'disabled') return res.status(409).json({ error: 'disabled', message: 'Zet eerst het ophalen van webshopbestellingen aan (Instellingen).' });
      if (out.skipped === 'not_configured') return res.status(409).json({ error: 'not_configured', message: 'Er is geen webshop gekoppeld (Beheer → Webshop).' });
      if (out.imported) audit(req, 'webshopbestellingen_gefactureerd', { count: out.imported });
      res.json({ ...out, status: shopOrders.status(tid(req)) });
    } catch (err) {
      if (err instanceof SourceError) return res.status(err.status || 502).json({ error: err.code, message: err.message });
      throw err;
    }
  }));

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

  app.post('/api/invoices/:id/finalize', requireJson, requireInvoices, wrapAsync(async (req, res) => {
    const out = invoices.finalize(tid(req), req.user, req.params.id, conf(req), { skipStock: shopStockSynced(req) });
    if (!out) return notFound(res);
    if (out.error) return fail(res, out);
    audit(req, 'factuur_definitief', { invoiceId: out.invoice.id, number: out.invoice.number, total: out.invoice.total });
    // Automatisch versturen (instelling); mislukt dat, dan staat dat op de factuur.
    const mail = sender ? await sender.autoSend(tid(req), out.invoice.id) : { sent: false };
    if (mail.sent) audit(req, 'factuur_verstuurd', { invoiceId: out.invoice.id, number: out.invoice.number, auto: true });
    res.json({ ...invoices.get(tid(req), out.invoice.id), autoSent: mail.sent });
  }));

  // De factuur als PDF (dezelfde als de bijlage van de e-mail).
  app.get('/api/invoices/:id/pdf', requireInvoices, (req, res) => {
    const inv = invoices.get(tid(req), req.params.id);
    if (!inv || !sender) return notFound(res);
    const pdf = sender.pdfOf(tid(req), inv);
    const name = invoiceFileName(inv);
    res.set({
      'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store',
      'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    res.send(pdf);
  });

  // Voorstel voor de e-mail (adres, onderwerp, tekst uit de instellingen).
  app.get('/api/invoices/:id/mail', requireInvoices, (req, res) => {
    const inv = invoices.get(tid(req), req.params.id);
    if (!inv || !sender) return notFound(res);
    res.json({ ...sender.draft(tid(req), inv), configured: ctx.mailConfigured ? ctx.mailConfigured(req) : false });
  });

  // Versturen per e-mail met de PDF als bijlage.
  app.post('/api/invoices/:id/send', requireJson, requireInvoices, wrapAsync(async (req, res) => {
    if (!sender) return notFound(res);
    const b = req.body || {};
    const to = String(b.to || '').split(/[,;\s]+/).filter(Boolean);
    if (!to.length || to.length > 5 || !to.every(validEmail)) return res.status(400).json({ error: 'invalid_to', message: 'Vul een of meer geldige e-mailadressen in.' });
    try {
      const inv = await sender.send(tid(req), req.params.id, {
        to, subject: typeof b.subject === 'string' ? b.subject : '', message: typeof b.message === 'string' ? b.message : '', bcc: copyTo(req.user),
      });
      audit(req, 'factuur_verstuurd', { invoiceId: inv.id, number: inv.number, recipients: to.length });
      res.json(inv);
    } catch (err) {
      if (err.code === 'not_found') return notFound(res);
      const status = { not_final: 409, not_configured: 409, invalid_to: 400, send_failed: 502 }[err.code];
      if (!status) throw err;
      res.status(status).json({ error: err.code, message: err.message });
    }
  }));

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
