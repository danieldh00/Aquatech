// Werkorders: opslag (tabel work_orders) en de API-routes. Een werkorder
// ontstaat uit een geaccordeerde offerte en bevat het uitvoeringsplan
// (werkstappen met uren, zone-indeling) en de benodigde materialen. De
// opbouw zelf staat in frontend/werkorders/workorder-core.js en is gedeeld
// met de browser. Alleen voor beheerders en installateurs (recht
// 'werkorders'); een klant ziet geen werkorders.
const path = require('path');
const crypto = require('crypto');
const { transaction } = require('./db');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'werkorders', 'workorder-core.js'));

const STATUSES = Object.keys(Core.STATUSES);
const PREFIX = 'WO-';
const now = () => new Date().toISOString();

function createWorkOrderStore(db) {
  const q = (sql) => db.prepare(sql);

  function row(r, withData) {
    const data = JSON.parse(r.data);
    const out = {
      id: r.id, number: r.number, status: r.status, title: r.title, customer: r.customer, address: r.address,
      quoteId: r.quote_id || null, quoteNumber: data.quoteNumber || '', planId: r.plan_id || null,
      plannedDate: r.planned_date || '', startTime: data.startTime || '',
      assigneeId: r.assignee_id || null, assignee: r.assignee_id ? { id: r.assignee_id, displayName: r.assignee_name || '' } : null,
      progress: Core.progress(data), createdAt: r.created_at, updatedAt: r.updated_at,
    };
    if (r.owner_name !== undefined) out.owner = { id: r.owner_id, displayName: r.owner_name };
    if (withData) out.data = data;
    return out;
  }

  const SELECT = `SELECT w.*, o.display_name AS owner_name, a.display_name AS assignee_name
    FROM work_orders w JOIN users o ON o.id = w.owner_id LEFT JOIN users a ON a.id = w.assignee_id`;

  function list(tenantId, { quoteId = null } = {}) {
    const args = [tenantId];
    let sql = `${SELECT} WHERE w.tenant_id = ? AND w.deleted_at IS NULL`;
    if (quoteId) { sql += ' AND w.quote_id = ?'; args.push(String(quoteId)); }
    return q(`${sql} ORDER BY w.updated_at DESC`).all(...args).map((r) => row(r, false));
  }

  const find = (tenantId, id) => q('SELECT * FROM work_orders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, String(id));
  const fullRow = (id) => row(q(`${SELECT} WHERE w.id = ?`).get(id), true);

  function get(tenantId, id) {
    const r = find(tenantId, id);
    return r ? fullRow(r.id) : null;
  }

  // De offerte waaruit een werkorder ontstaat: bestaand, niet verwijderd, in deze omgeving.
  function quoteOf(tenantId, id) {
    const r = q('SELECT id, number, status, plan_id, data FROM quotes WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, String(id));
    return r ? { id: r.id, number: r.number, status: r.status, planId: r.plan_id, data: JSON.parse(r.data) } : null;
  }

  // Werkordernummer per tenant en jaar: WO-<jaar>-0001, oplopend; een nummer komt nooit terug.
  function nextNumber(tenantId, year) {
    const head = `${PREFIX}${year}-`;
    let max = 0;
    for (const r of q('SELECT number FROM work_orders WHERE tenant_id = ? AND substr(number, 1, ?) = ?').all(tenantId, head.length, head)) {
      const n = Number(r.number.slice(head.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  const fields = (data) => ({
    title: data.title.trim() || 'Werkorder',
    customer: data.customer.name.trim(),
    address: data.customer.address.replace(/\s*\n\s*/g, ', ').trim(),
    plannedDate: data.plannedDate || null,
  });

  // Medewerkers aan wie een werkorder kan worden toegewezen (beheerders en
  // installateurs van de opgegeven tenants).
  function staff(tenantIds) {
    const ids = [...new Set(tenantIds)];
    return q(`SELECT id, username, display_name, role FROM users WHERE tenant_id IN (${ids.map(() => '?').join(',')})
      AND kind = 'account' AND role IN ('beheerder', 'installateur') AND disabled = 0 ORDER BY lower(display_name)`)
      .all(...ids).map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role }));
  }

  /**
   * Nieuwe werkorder bij een offerte. Zonder data bouwt de server die zelf op
   * uit de offerteregels (zonder zone-indeling; die komt uit de browser, waar
   * de plannerbibliotheken geladen zijn). De koppeling met offerte en plan
   * komt altijd uit de offerte zelf.
   */
  function create(user, quote, rawData, { assigneeId = null } = {}) {
    const base = Core.fromQuote(quote).data;
    const data = rawData ? Core.sanitize(rawData) : base;
    data.quoteId = quote.id;
    data.quoteNumber = quote.number;
    data.planId = quote.planId || '';
    if (!data.customer.name) data.customer = base.customer;
    if (!data.title) data.title = base.title;
    const f = fields(data);
    return transaction(db, () => {
      const id = crypto.randomUUID();
      const ts = now();
      const number = nextNumber(user.tenant_id, ts.slice(0, 4));
      q(`INSERT INTO work_orders (id, tenant_id, owner_id, quote_id, plan_id, number, status, title, customer, address, planned_date, assignee_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, user.tenant_id, user.id, quote.id, quote.planId || null, number, data.plannedDate ? 'gepland' : 'open',
          f.title, f.customer, f.address, f.plannedDate, assigneeId || null, JSON.stringify(data), ts, ts);
      return fullRow(id);
    });
  }

  // assigneeId: undefined = ongewijzigd, null = niemand.
  function update(tenantId, id, rawData, status, assigneeId) {
    return transaction(db, () => {
      const r = find(tenantId, id);
      if (!r) return null;
      const old = JSON.parse(r.data);
      const data = rawData === undefined ? old : Core.sanitize(rawData);
      // De koppeling met offerte en plan ligt vast.
      data.quoteId = old.quoteId;
      data.quoteNumber = old.quoteNumber;
      data.planId = old.planId;
      const f = fields(data);
      const st = STATUSES.includes(status) ? status : r.status;
      const aid = assigneeId === undefined ? r.assignee_id : assigneeId || null;
      q(`UPDATE work_orders SET status = ?, title = ?, customer = ?, address = ?, planned_date = ?, assignee_id = ?, data = ?, updated_at = ? WHERE id = ?`)
        .run(st, f.title, f.customer, f.address, f.plannedDate, aid, JSON.stringify(data), now(), r.id);
      return fullRow(r.id);
    });
  }

  function remove(tenantId, id) {
    const r = find(tenantId, id);
    if (!r) return false;
    q('UPDATE work_orders SET deleted_at = ? WHERE id = ?').run(now(), r.id);
    return true;
  }

  // Definitief wissen (AVG-verzoek): ook al verwijderde werkorders.
  function purge(tenantId, id) {
    return transaction(db, () => {
      q('DELETE FROM work_order_photos WHERE tenant_id = ? AND work_order_id = ?').run(tenantId, String(id));
      return q('DELETE FROM work_orders WHERE tenant_id = ? AND id = ?').run(tenantId, String(id)).changes > 0;
    });
  }

  return { list, get, quoteOf, staff, create, update, remove, purge, nextNumber };
}

/**
 * API-routes. ctx: { workorders, staffTenantsOf(req), requireRight,
 * requireAdmin, requireJson, audit }. Alles achter het recht 'werkorders'
 * (beheerder, installateur); gegevens per omgeving via req.tenantId.
 */
function registerWorkOrderRoutes(app, ctx) {
  const { workorders, requireRight, requireAdmin, requireJson, staffTenantsOf, audit } = ctx;
  const requireWo = requireRight('werkorders');
  const tid = (req) => req.tenantId || req.user.tenant_id;
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Werkorder niet gevonden.' });
  const validData = (d) => d && typeof d === 'object' && !Array.isArray(d);
  const validStatus = (s) => s === undefined || STATUSES.includes(s);

  function assigneeOf(req, raw) {
    if (raw === undefined) return { value: undefined };
    if (raw === null || raw === '') return { value: null };
    return workorders.staff(staffTenantsOf(req)).some((u) => u.id === String(raw)) ? { value: String(raw) } : { error: true };
  }
  const badAssignee = (res) => res.status(400).json({ error: 'invalid_assignee', message: 'Onbekende medewerker.' });

  // Medewerkers om een werkorder aan toe te wijzen.
  app.get('/api/workorder-staff', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: workorders.staff(staffTenantsOf(req)) });
  });

  // Alle werkorders van de omgeving (de ploeg werkt samen); ?quote=<id> voor één offerte.
  app.get('/api/workorders', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: workorders.list(tid(req), { quoteId: req.query.quote || null }) });
  });

  app.get('/api/workorders/:id', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const wo = workorders.get(tid(req), req.params.id);
    if (!wo) return notFound(res);
    res.json(wo);
  });

  // Alleen vanuit een offerte met status akkoord.
  app.post('/api/workorders', requireJson, requireWo, (req, res) => {
    const { quoteId, data } = req.body || {};
    if (!quoteId || (data !== undefined && !validData(data))) return res.status(400).json({ error: 'invalid_workorder', message: 'Kies een offerte.' });
    const quote = workorders.quoteOf(tid(req), quoteId);
    if (!quote) return res.status(404).json({ error: 'quote_not_found', message: 'Offerte niet gevonden.' });
    if (quote.status !== 'akkoord') return res.status(409).json({ error: 'not_accepted', message: 'Een werkorder kan alleen worden gemaakt van een offerte met status Akkoord.' });
    const aid = assigneeOf(req, req.body.assigneeId);
    if (aid.error) return badAssignee(res);
    const wo = workorders.create(req.user, quote, data, { assigneeId: aid.value });
    audit(req, 'werkorder_aangemaakt', { workOrderId: wo.id, number: wo.number, quoteId: quote.id });
    res.status(201).json(wo);
  });

  app.put('/api/workorders/:id', requireJson, requireWo, (req, res) => {
    const { data, status } = req.body || {};
    if ((data !== undefined && !validData(data)) || !validStatus(status)) return res.status(400).json({ error: 'invalid_workorder', message: 'Ongeldige werkorder.' });
    const aid = assigneeOf(req, req.body.assigneeId);
    if (aid.error) return badAssignee(res);
    const wo = workorders.update(tid(req), req.params.id, data, status, aid.value);
    if (!wo) return notFound(res);
    res.json(wo);
  });

  app.delete('/api/workorders/:id', requireWo, (req, res) => {
    if (!workorders.remove(tid(req), req.params.id)) return notFound(res);
    audit(req, 'werkorder_verwijderd', { workOrderId: req.params.id });
    res.json({ ok: true });
  });

  app.delete('/api/admin/workorders/:id', requireAdmin, (req, res) => {
    if (!workorders.purge(tid(req), req.params.id)) return notFound(res);
    audit(req, 'werkorder_gewist', { workOrderId: req.params.id });
    res.json({ ok: true });
  });
}

module.exports = { createWorkOrderStore, registerWorkOrderRoutes, Core };
