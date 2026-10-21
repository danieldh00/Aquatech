// Werkregistratie: de uren en het materiaalverbruik die de ploeg op een
// werkorder boekt (tabellen work_order_hours en work_order_materials). De
// regels zelf opschonen en de totalen staan in
// frontend/werkorders/worklog-core.js (gedeeld met de browser).
//
// - Iedereen met het recht 'werkorders' boekt zijn eigen uren en materiaal en
//   wijzigt of verwijdert zijn eigen regels.
// - Met het recht 'planning' (beheerder, planner) boek je ook voor een
//   collega, wijzig je alle regels en werk je een afgeronde werkorder bij;
//   anders ligt een werkorder met status Gereed of Geannuleerd vast.
// - Een regel met een clientId (UUID uit de browser) telt één keer, ook als
//   hij opnieuw wordt verstuurd (geen netwerk op locatie, later
//   synchroniseren).
// - Materiaalverbruik: positief = verbruikt, negatief = retour. Na elke
//   wijziging roept de opslag onMaterialUsed(tenantId, rij, gebruiker) aan
//   (voorraadbeheer boekt dan af en geeft het id van de mutatie terug, dat in
//   stock_movement_id komt).
const path = require('path');
const crypto = require('crypto');
const { transaction } = require('./db');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'werkorders', 'worklog-core.js'));

const LOCKED = ['gereed', 'geannuleerd'];
const MAX_RANGE_DAYS = 400;
const now = () => new Date().toISOString();
// Vandaag in Nederland; boeken kan tot en met morgen (tijdzones, nachtwerk).
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const H_COLS = `h.id, h.work_order_id, h.user_id, h.user_name, h.work_date, h.start_time, h.end_time, h.break_minutes, h.minutes,
  h.kind, h.step_id, h.note, h.client_id, h.created_by, h.created_at, h.updated_at, u.display_name AS current_name`;
const M_COLS = `m.id, m.work_order_id, m.user_id, m.user_name, m.used_on, m.code, m.description, m.unit, m.qty, m.material_id,
  m.note, m.client_id, m.stock_movement_id, m.created_by, m.created_at, m.updated_at, u.display_name AS current_name`;
const WO_COLS = 'w.number AS wo_number, w.customer AS wo_customer, w.address AS wo_address, w.title AS wo_title';

const userOf = (r) => ({ id: r.user_id || null, displayName: r.current_name || r.user_name || 'Verwijderde gebruiker' });
const woOf = (r) => (r.wo_number === undefined ? undefined : { number: r.wo_number, customer: r.wo_customer, address: r.wo_address, title: r.wo_title });

function hoursOut(r) {
  const out = {
    id: r.id, clientId: r.client_id || null, workOrderId: r.work_order_id, user: userOf(r), createdBy: r.created_by || null,
    workDate: r.work_date, startTime: r.start_time, endTime: r.end_time, breakMinutes: Number(r.break_minutes), minutes: Number(r.minutes),
    kind: r.kind, stepId: r.step_id, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at,
  };
  const wo = woOf(r);
  if (wo) out.workOrder = wo;
  return out;
}

function materialOut(r) {
  const out = {
    id: r.id, clientId: r.client_id || null, workOrderId: r.work_order_id, user: userOf(r), createdBy: r.created_by || null,
    usedOn: r.used_on, code: r.code, description: r.description, unit: r.unit, qty: Number(r.qty), materialId: r.material_id,
    note: r.note, stockMovementId: r.stock_movement_id || null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
  const wo = woOf(r);
  if (wo) out.workOrder = wo;
  return out;
}

function createWorkLogStore(db, { onMaterialUsed = null } = {}) {
  const q = (sql) => db.prepare(sql);
  // Voorraadbeheer kan zich later aanmelden (zie hook()).
  let materialHook = onMaterialUsed;

  const workOrder = (tenantId, id) => q('SELECT id, number, status FROM work_orders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
    .get(tenantId, String(id));

  const hoursRow = (tenantId, id) => q(`SELECT ${H_COLS} FROM work_order_hours h LEFT JOIN users u ON u.id = h.user_id
    WHERE h.tenant_id = ? AND h.id = ?`).get(tenantId, String(id));
  const materialRow = (tenantId, id) => q(`SELECT ${M_COLS} FROM work_order_materials m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = ? AND m.id = ?`).get(tenantId, String(id));

  /** Alle geboekte regels van één werkorder (twee queries, oudste eerst). */
  function list(tenantId, workOrderId) {
    const id = String(workOrderId);
    return {
      hours: q(`SELECT ${H_COLS} FROM work_order_hours h LEFT JOIN users u ON u.id = h.user_id
        WHERE h.tenant_id = ? AND h.work_order_id = ? ORDER BY h.work_date, h.start_time, h.created_at`).all(tenantId, id).map(hoursOut),
      materials: q(`SELECT ${M_COLS} FROM work_order_materials m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = ? AND m.work_order_id = ? ORDER BY m.used_on, m.created_at`).all(tenantId, id).map(materialOut),
    };
  }

  const count = (table, tenantId, woId) => Number(q(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ? AND work_order_id = ?`).get(tenantId, woId).n);
  const byClient = (table, tenantId, clientId) => (Core.isClientId(clientId)
    ? q(`SELECT id, work_order_id FROM ${table} WHERE tenant_id = ? AND client_id = ?`).get(tenantId, clientId) : null);
  const futureCheck = (date) => (date > addDays(today(), 1) ? 'Boeken op een datum in de toekomst kan niet.' : null);

  /**
   * Uren boeken. actor = wie boekt (req.user), forUser = voor wie
   * ({ id, displayName }). Bestaat er al een regel met deze clientId, dan
   * komt die terug (existing: true) en wordt er niets dubbel geboekt.
   */
  function addHours(tenantId, workOrderId, input, { actor, forUser }) {
    const wo = workOrder(tenantId, workOrderId);
    if (!wo) return { error: 'not_found', status: 404, message: 'Werkorder niet gevonden.' };
    const dup = byClient('work_order_hours', tenantId, input.clientId);
    if (dup) {
      if (dup.work_order_id !== wo.id) return { error: 'conflict', status: 409, message: 'Deze regel hoort bij een andere werkorder.' };
      return { entry: hoursOut(hoursRow(tenantId, dup.id)), existing: true };
    }
    const c = Core.cleanHours(input);
    if (c.error) return { error: 'invalid_hours', status: 400, message: c.error };
    const future = futureCheck(c.entry.workDate);
    if (future) return { error: 'invalid_hours', status: 400, message: future };
    if (count('work_order_hours', tenantId, wo.id) >= Core.MAX_ENTRIES) return { error: 'too_many', status: 409, message: 'Maximum aantal urenregels bereikt.' };
    const e = c.entry;
    const id = crypto.randomUUID();
    const ts = now();
    q(`INSERT INTO work_order_hours (id, tenant_id, work_order_id, user_id, user_name, work_date, start_time, end_time, break_minutes, minutes,
        kind, step_id, note, client_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, wo.id, forUser.id, String(forUser.displayName || '').slice(0, 200), e.workDate, e.startTime, e.endTime, e.breakMinutes, e.minutes,
        e.kind, e.stepId, e.note, Core.isClientId(input.clientId) ? input.clientId : null, actor.id, ts, ts);
    return { entry: hoursOut(hoursRow(tenantId, id)), workOrder: wo };
  }

  function updateHours(tenantId, id, input, { forUser = null } = {}) {
    const r = hoursRow(tenantId, id);
    if (!r) return { error: 'not_found', status: 404, message: 'Urenregel niet gevonden.' };
    const c = Core.cleanHours({ ...hoursOut(r), hours: undefined, ...input });
    if (c.error) return { error: 'invalid_hours', status: 400, message: c.error };
    const future = futureCheck(c.entry.workDate);
    if (future) return { error: 'invalid_hours', status: 400, message: future };
    const e = c.entry;
    const uid = forUser ? forUser.id : r.user_id;
    const uname = forUser ? String(forUser.displayName || '').slice(0, 200) : r.user_name;
    q(`UPDATE work_order_hours SET user_id = ?, user_name = ?, work_date = ?, start_time = ?, end_time = ?, break_minutes = ?, minutes = ?,
        kind = ?, step_id = ?, note = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
      .run(uid, uname, e.workDate, e.startTime, e.endTime, e.breakMinutes, e.minutes, e.kind, e.stepId, e.note, now(), tenantId, r.id);
    return { entry: hoursOut(hoursRow(tenantId, r.id)) };
  }

  const removeHours = (tenantId, id) => q('DELETE FROM work_order_hours WHERE tenant_id = ? AND id = ?').run(tenantId, String(id)).changes > 0;

  // Voorraad bijwerken na een wijziging (in dezelfde transactie).
  function syncStock(tenantId, r, actor, deleted = false) {
    if (!materialHook) return;
    const movement = materialHook(tenantId, { id: r.id, work_order_id: r.work_order_id, code: r.code, qty: Number(r.qty), deleted }, actor);
    if (!deleted && movement !== undefined) {
      q('UPDATE work_order_materials SET stock_movement_id = ? WHERE tenant_id = ? AND id = ?').run(movement || null, tenantId, r.id);
    }
  }

  function addMaterial(tenantId, workOrderId, input, { actor, forUser }) {
    const wo = workOrder(tenantId, workOrderId);
    if (!wo) return { error: 'not_found', status: 404, message: 'Werkorder niet gevonden.' };
    const dup = byClient('work_order_materials', tenantId, input.clientId);
    if (dup) {
      if (dup.work_order_id !== wo.id) return { error: 'conflict', status: 409, message: 'Deze regel hoort bij een andere werkorder.' };
      return { entry: materialOut(materialRow(tenantId, dup.id)), existing: true };
    }
    const c = Core.cleanMaterial(input);
    if (c.error) return { error: 'invalid_material', status: 400, message: c.error };
    const future = futureCheck(c.entry.usedOn);
    if (future) return { error: 'invalid_material', status: 400, message: future };
    if (count('work_order_materials', tenantId, wo.id) >= Core.MAX_ENTRIES) return { error: 'too_many', status: 409, message: 'Maximum aantal materiaalregels bereikt.' };
    const e = c.entry;
    return transaction(db, () => {
      const id = crypto.randomUUID();
      const ts = now();
      q(`INSERT INTO work_order_materials (id, tenant_id, work_order_id, user_id, user_name, used_on, code, description, unit, qty, material_id,
          note, client_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, wo.id, forUser.id, String(forUser.displayName || '').slice(0, 200), e.usedOn, e.code, e.description, e.unit, e.qty,
          e.materialId, e.note, Core.isClientId(input.clientId) ? input.clientId : null, actor.id, ts, ts);
      syncStock(tenantId, materialRow(tenantId, id), actor);
      return { entry: materialOut(materialRow(tenantId, id)), workOrder: wo };
    });
  }

  function updateMaterial(tenantId, id, input, { actor, forUser = null }) {
    const r = materialRow(tenantId, id);
    if (!r) return { error: 'not_found', status: 404, message: 'Materiaalregel niet gevonden.' };
    const c = Core.cleanMaterial({ ...materialOut(r), ...input });
    if (c.error) return { error: 'invalid_material', status: 400, message: c.error };
    const future = futureCheck(c.entry.usedOn);
    if (future) return { error: 'invalid_material', status: 400, message: future };
    const e = c.entry;
    return transaction(db, () => {
      q(`UPDATE work_order_materials SET user_id = ?, user_name = ?, used_on = ?, code = ?, description = ?, unit = ?, qty = ?, material_id = ?,
          note = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
        .run(forUser ? forUser.id : r.user_id, forUser ? String(forUser.displayName || '').slice(0, 200) : r.user_name,
          e.usedOn, e.code, e.description, e.unit, e.qty, e.materialId, e.note, now(), tenantId, r.id);
      syncStock(tenantId, materialRow(tenantId, r.id), actor);
      return { entry: materialOut(materialRow(tenantId, r.id)) };
    });
  }

  function removeMaterial(tenantId, id, actor) {
    return transaction(db, () => {
      const r = materialRow(tenantId, id);
      if (!r) return false;
      syncStock(tenantId, r, actor, true);
      return q('DELETE FROM work_order_materials WHERE tenant_id = ? AND id = ?').run(tenantId, r.id).changes > 0;
    });
  }

  /**
   * Urenstaat en verbruik over een periode (alle werkorders van de omgeving,
   * verwijderde werkorders niet). userId: alleen die medewerker.
   */
  function period(tenantId, { from, to, userId = null }) {
    const hArgs = [tenantId, from, to];
    const mArgs = [tenantId, from, to];
    let hWhere = '';
    let mWhere = '';
    if (userId) { hWhere = ' AND h.user_id = ?'; mWhere = ' AND m.user_id = ?'; hArgs.push(String(userId)); mArgs.push(String(userId)); }
    return {
      hours: q(`SELECT ${H_COLS}, ${WO_COLS} FROM work_order_hours h JOIN work_orders w ON w.id = h.work_order_id AND w.tenant_id = h.tenant_id
        LEFT JOIN users u ON u.id = h.user_id WHERE h.tenant_id = ? AND h.work_date >= ? AND h.work_date <= ? AND w.deleted_at IS NULL${hWhere}
        ORDER BY h.work_date, h.start_time, w.number`).all(...hArgs).map(hoursOut),
      materials: q(`SELECT ${M_COLS}, ${WO_COLS} FROM work_order_materials m JOIN work_orders w ON w.id = m.work_order_id AND w.tenant_id = m.tenant_id
        LEFT JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.used_on >= ? AND m.used_on <= ? AND w.deleted_at IS NULL${mWhere}
        ORDER BY m.used_on, w.number`).all(...mArgs).map(materialOut),
    };
  }

  /** Verbruikt per artikelcode op een werkorder: { code: aantal } (voorraadbeheer). */
  function usedByCode(tenantId, workOrderId) {
    const out = {};
    for (const r of q(`SELECT code, SUM(qty) AS qty FROM work_order_materials WHERE tenant_id = ? AND work_order_id = ? AND code <> ''
      GROUP BY code`).all(tenantId, String(workOrderId))) out[r.code] = Math.round(Number(r.qty) * 100) / 100;
    return out;
  }

  /** Geboekte uren (minuten) en verbruiksregels per werkorder, voor overzichten. */
  function counts(tenantId, ids = null) {
    const out = {};
    if (ids && !ids.length) return out;
    const only = ids ? ` AND work_order_id IN (${ids.map(() => '?').join(', ')})` : '';
    const args = [tenantId, ...(ids || []).map(String)];
    // Eén query (UNION): de som van de minuten en het aantal materiaalregels.
    for (const r of q(`SELECT work_order_id, 'h' AS k, SUM(minutes) AS n FROM work_order_hours WHERE tenant_id = ?${only} GROUP BY work_order_id
      UNION ALL SELECT work_order_id, 'm' AS k, COUNT(*) AS n FROM work_order_materials WHERE tenant_id = ?${only} GROUP BY work_order_id`).all(...args, ...args)) {
      const o = out[r.work_order_id] = out[r.work_order_id] || { minutes: 0, materials: 0 };
      o[r.k === 'h' ? 'minutes' : 'materials'] = Number(r.n);
    }
    return out;
  }

  return {
    workOrder, list, addHours, updateHours, removeHours, hoursRow: (t, id) => { const r = hoursRow(t, id); return r ? hoursOut(r) : null; },
    addMaterial, updateMaterial, removeMaterial, materialRow: (t, id) => { const r = materialRow(t, id); return r ? materialOut(r) : null; },
    period, usedByCode, counts, hook: (fn) => { materialHook = fn; },
  };
}

/**
 * API-routes. ctx: { worklog, requireRight, requireJson, audit, staffOf(req)
 * (medewerkers aan wie geboekt kan worden: [{ id, displayName }]),
 * canManage(user) }.
 */
function registerWorkLogRoutes(app, ctx) {
  const { worklog, requireRight, requireJson, audit } = ctx;
  const requireWo = requireRight('werkorders');
  const tid = (req) => req.tenantId || req.user.tenant_id;
  const canManage = (req) => Boolean(ctx.canManage(req.user));
  const fail = (res, out) => res.status(out.status).json({ error: out.error, message: out.message });
  const notFound = (res, what) => res.status(404).json({ error: 'not_found', message: `${what} niet gevonden.` });
  const forbidden = (res, message) => res.status(403).json({ error: 'forbidden', message });
  const locked = (res) => res.status(409).json({ error: 'locked', message: 'Deze werkorder is afgerond; vraag de planner of beheerder om de registratie aan te passen.' });
  const self = (req) => ({ id: req.user.id, displayName: req.user.display_name });

  // Voor wie wordt geboekt: jezelf, of (met het recht planning) een collega.
  function forUserOf(req, raw) {
    if (raw === undefined || raw === null || raw === '' || String(raw) === req.user.id) return { user: self(req) };
    if (!canManage(req)) return { error: 'forbidden' };
    const u = ctx.staffOf(req).find((s) => s.id === String(raw));
    return u ? { user: { id: u.id, displayName: u.displayName } } : { error: 'invalid_user' };
  }
  function checkFor(req, res, raw) {
    const f = forUserOf(req, raw);
    if (f.error === 'forbidden') { forbidden(res, 'Je boekt alleen je eigen uren en materiaal.'); return null; }
    if (f.error) { res.status(400).json({ error: 'invalid_user', message: 'Onbekende medewerker.' }); return null; }
    return f.user;
  }
  // Werkorder bestaat in deze omgeving en is (voor wie niet mag beheren) niet afgerond.
  function openWorkOrder(req, res) {
    const wo = worklog.workOrder(tid(req), req.params.id);
    if (!wo) { notFound(res, 'Werkorder'); return null; }
    if (LOCKED.includes(wo.status) && !canManage(req)) { locked(res); return null; }
    return wo;
  }
  // Een bestaande regel: van deze werkorder, en eigen regel tenzij je mag beheren.
  function ownEntry(req, res, entry, what) {
    if (!entry || entry.workOrderId !== String(req.params.id)) { notFound(res, what); return false; }
    const mine = entry.user.id === req.user.id || entry.createdBy === req.user.id;
    if (!mine && !canManage(req)) { forbidden(res, 'Je wijzigt alleen je eigen regels.'); return false; }
    return true;
  }

  app.get('/api/workorders/:id/worklog', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const wo = worklog.workOrder(tid(req), req.params.id);
    if (!wo) return notFound(res, 'Werkorder');
    const manage = canManage(req);
    res.json({
      ...worklog.list(tid(req), wo.id), kinds: Core.KINDS, canManage: manage,
      locked: LOCKED.includes(wo.status) && !manage, me: self(req), today: today(),
    });
  });

  // ---------- Uren ----------
  app.post('/api/workorders/:id/hours', requireJson, requireWo, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const wo = openWorkOrder(req, res);
    if (!wo) return;
    const forUser = checkFor(req, res, body.userId);
    if (!forUser) return;
    const out = worklog.addHours(tid(req), wo.id, body, { actor: req.user, forUser });
    if (out.error) return fail(res, out);
    if (!out.existing) audit(req, 'uren_geboekt', { workOrderId: wo.id, number: wo.number, entryId: out.entry.id, minutes: out.entry.minutes, forUserId: forUser.id });
    res.status(out.existing ? 200 : 201).json(out.entry);
  });

  app.put('/api/workorders/:id/hours/:eid', requireJson, requireWo, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!openWorkOrder(req, res)) return;
    if (!ownEntry(req, res, worklog.hoursRow(tid(req), req.params.eid), 'Urenregel')) return;
    let forUser = null;
    if (body.userId !== undefined) { forUser = checkFor(req, res, body.userId); if (!forUser) return; }
    const out = worklog.updateHours(tid(req), req.params.eid, body, { forUser });
    if (out.error) return fail(res, out);
    res.json(out.entry);
  });

  app.delete('/api/workorders/:id/hours/:eid', requireWo, (req, res) => {
    if (!openWorkOrder(req, res)) return;
    const entry = worklog.hoursRow(tid(req), req.params.eid);
    if (!ownEntry(req, res, entry, 'Urenregel')) return;
    worklog.removeHours(tid(req), entry.id);
    audit(req, 'uren_verwijderd', { workOrderId: entry.workOrderId, entryId: entry.id, minutes: entry.minutes });
    res.json({ ok: true });
  });

  // ---------- Materiaalverbruik ----------
  app.post('/api/workorders/:id/materials', requireJson, requireWo, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const wo = openWorkOrder(req, res);
    if (!wo) return;
    const forUser = checkFor(req, res, body.userId);
    if (!forUser) return;
    const out = worklog.addMaterial(tid(req), wo.id, body, { actor: req.user, forUser });
    if (out.error) return fail(res, out);
    if (!out.existing) audit(req, 'materiaal_geboekt', { workOrderId: wo.id, number: wo.number, entryId: out.entry.id, code: out.entry.code, qty: out.entry.qty });
    res.status(out.existing ? 200 : 201).json(out.entry);
  });

  app.put('/api/workorders/:id/materials/:eid', requireJson, requireWo, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!openWorkOrder(req, res)) return;
    if (!ownEntry(req, res, worklog.materialRow(tid(req), req.params.eid), 'Materiaalregel')) return;
    let forUser = null;
    if (body.userId !== undefined) { forUser = checkFor(req, res, body.userId); if (!forUser) return; }
    const out = worklog.updateMaterial(tid(req), req.params.eid, body, { actor: req.user, forUser });
    if (out.error) return fail(res, out);
    res.json(out.entry);
  });

  app.delete('/api/workorders/:id/materials/:eid', requireWo, (req, res) => {
    if (!openWorkOrder(req, res)) return;
    const entry = worklog.materialRow(tid(req), req.params.eid);
    if (!ownEntry(req, res, entry, 'Materiaalregel')) return;
    worklog.removeMaterial(tid(req), entry.id, req.user);
    audit(req, 'materiaal_verwijderd', { workOrderId: entry.workOrderId, entryId: entry.id, code: entry.code, qty: entry.qty });
    res.json({ ok: true });
  });

  // ---------- Urenstaat over een periode (Excel in de browser) ----------
  // Met het recht planning: iedereen (of ?user=<id>); anders alleen jezelf.
  app.get('/api/worklog', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!Core.isDate(from) || !Core.isDate(to) || from > to) return res.status(400).json({ error: 'invalid_range', message: 'Kies een geldige periode.' });
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS) return res.status(400).json({ error: 'invalid_range', message: `Kies een periode van hooguit ${MAX_RANGE_DAYS} dagen.` });
    const manage = canManage(req);
    const user = req.query.user ? String(req.query.user) : null;
    if (user && user !== req.user.id && !manage) return forbidden(res, 'Je ziet alleen je eigen uren.');
    const userId = manage ? user : req.user.id;
    res.json({ from, to, userId, canManage: manage, kinds: Core.KINDS, ...worklog.period(tid(req), { from, to, userId }) });
  });
}

module.exports = { createWorkLogStore, registerWorkLogRoutes, Core };
