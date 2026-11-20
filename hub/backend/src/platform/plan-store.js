// Historie van aanvragen en plannen (opslaan, controle, tekeningen indienen), los van de rest van de gegevenslaag.
const crypto = require('crypto');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { transaction, jsonWithout, jsonDigest } = require('../database/db');
const { currentTimestamp, newId } = require('./store-ids');
const { summarize, metaOf, withoutBackground } = require('./plan-summary');

const Roles = require(path.join(FRONTEND_DIR, 'shared', 'roles.js'));

// Opeenvolgende wijzigingen van één gebruiker aan één plan binnen dit venster
// vormen één regel in de historie (anders levert automatisch opslaan honderden
// regels per plan op).
const HISTORY_MERGE_MS = 30 * 60 * 1000;
const REVIEW_STATUSES = ['concept', 'ter_controle', 'goedgekeurd'];

/**
 * Maakt de opslag van historie en plannen.
 * @param {object} db Databaseverbinding.
 * @param {object} deps insertUser (gebruiker toevoegen, voor de gast bij een ingediende tekening).
 * @returns {object} record, listHistory, getHistory, listPlans, getPlan, savePlan, deletePlan, purgePlan, planReviewStatus, requestReview, reviewPlan, getPlanReview, submitDrawing, pendingDrawingChars, purgeStaleDrawings.
 */
function createPlanStore(db, { insertUser }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL met ?-parameters.
   * @returns {object} Het voorbereide statement.
   */
  const prepare = (sql) => db.prepare(sql);

  // ---------- Historie ----------
  /**
   * Legt een actie op een plan vast in de historie. Met merge worden
   * wijzigingen van dezelfde gebruiker binnen 30 minuten samengevoegd.
   * @param {object} entry tenantId, userId, planId, action, data (het plan), summary, title, ip en merge.
   * @returns {string} Id van de historieregel.
   */
  function record({ tenantId, userId, planId = null, action, data = null, summary: extra = null, title = '', ip = '', merge = false }) {
    const timestamp = currentTimestamp();
    const meta = data ? metaOf(data) : { title, customer: '', address: '' };
    const summary = JSON.stringify(extra || (data ? summarize(data) : {}));
    const snapshot = data ? JSON.stringify(withoutBackground(data)) : null;
    if (merge && planId) {
      const since = new Date(Date.now() - HISTORY_MERGE_MS).toISOString();
      const last = prepare(`SELECT id FROM history WHERE tenant_id = ? AND plan_id = ? AND user_id = ?
        AND action IN ('aangemaakt', 'bijgewerkt') AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1`).get(tenantId, planId, userId, since);
      if (last) {
        prepare('UPDATE history SET title = ?, customer = ?, address = ?, summary = ?, snapshot = ?, ip = ?, updated_at = ? WHERE id = ?')
          .run(meta.title, meta.customer, meta.address, summary, snapshot, ip, timestamp, last.id);
        return last.id;
      }
    }
    const id = newId();
    prepare(`INSERT INTO history (id, tenant_id, user_id, plan_id, action, title, customer, address, summary, snapshot, ip, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, userId, planId, action, meta.title, meta.customer, meta.address, summary, snapshot, ip, timestamp, timestamp);
    return id;
  }

  /**
   * Zet een historierij om naar het formaat van de API.
   * @param {object} entry De rij uit HISTORY_SELECT.
   * @param {boolean} withSnapshot Ook de kopie van het plan meegeven.
   * @returns {object} De historieregel.
   */
  function historyRow(entry, withSnapshot) {
    const out = {
      id: entry.id, planId: entry.plan_id, action: entry.action, title: entry.title, customer: entry.customer, address: entry.address,
      summary: JSON.parse(entry.summary || '{}'), ip: entry.ip, createdAt: entry.created_at, updatedAt: entry.updated_at,
      user: entry.user_id ? { id: entry.user_id, username: entry.username, displayName: entry.display_name, role: entry.role, kind: entry.kind } : null,
      planDeleted: entry.plan_id ? !entry.plan_exists : false,
      hasSnapshot: Boolean(entry.has_snapshot),
    };
    if (withSnapshot) out.snapshot = entry.snapshot ? JSON.parse(entry.snapshot) : null;
    return out;
  }

  const HISTORY_SELECT = `
    SELECT h.id, h.plan_id, h.user_id, h.action, h.title, h.customer, h.address, h.summary, h.ip, h.created_at, h.updated_at,
      h.snapshot IS NOT NULL AS has_snapshot,
      u.username, u.display_name, u.role, u.kind,
      EXISTS (SELECT 1 FROM plans p WHERE p.id = h.plan_id AND p.deleted_at IS NULL) AS plan_exists`;

  /**
   * Bladert door de historie van een tenant, laatst gewijzigd eerst.
   * @param {string} tenantId Id van de tenant.
   * @param {object} [options] limit, offset en de filters userId, search, action en planId.
   * @returns {{ total: number, items: object[] }} Totaal aantal en de regels van deze pagina.
   */
  function listHistory(tenantId, { limit = 100, offset = 0, userId = '', search = '', action = '', planId = '' } = {}) {
    const where = ['h.tenant_id = ?'];
    const args = [tenantId];
    if (planId) { where.push('h.plan_id = ?'); args.push(String(planId)); }
    if (userId) { where.push('h.user_id = ?'); args.push(String(userId)); }
    if (action) { where.push('h.action = ?'); args.push(String(action)); }
    if (search) {
      // lower(): LIKE is in PostgreSQL hoofdlettergevoelig.
      const cols = ['h.title', 'h.customer', 'h.address', 'u.display_name', 'u.username'];
      where.push(`(${cols.map((column) => `lower(${column}) LIKE lower(?) ESCAPE '\\'`).join(' OR ')})`);
      const like = `%${String(search).replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      args.push(like, like, like, like, like);
    }
    const from = `FROM history h LEFT JOIN users u ON u.id = h.user_id WHERE ${where.join(' AND ')}`;
    const total = prepare(`SELECT COUNT(*) AS n ${from}`).get(...args).n;
    const pageSize = Math.max(1, Math.min(1000, Math.floor(Number(limit)) || 100));
    const skip = Math.max(0, Math.floor(Number(offset)) || 0);
    const rows = prepare(`${HISTORY_SELECT} ${from} ORDER BY h.updated_at DESC, h.id LIMIT ? OFFSET ?`).all(...args, pageSize, skip);
    return { total, items: rows.map((entry) => historyRow(entry, false)) };
  }

  /**
   * Eén historieregel met de kopie van het plan.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de historieregel.
   * @returns {object|null} De regel, of null.
   */
  function getHistory(tenantId, id) {
    const entry = prepare(`${HISTORY_SELECT}, h.snapshot FROM history h LEFT JOIN users u ON u.id = h.user_id WHERE h.tenant_id = ? AND h.id = ?`).get(tenantId, String(id));
    return entry ? historyRow(entry, true) : null;
  }

  // ---------- Plannen ----------
  // Controle (migratie 19): concept -> ter_controle -> goedgekeurd. Alleen
  // wie het recht plannen.goedkeuren heeft keurt goed; wijzigt een klant een
  // goedgekeurd plan, dan gaat het opnieuw ter controle.
  const REVIEW_COLS = 'p.review_status, p.review_question, p.review_requested_at, p.reviewed_at, p.submitted_via, p.reviewed_by, r.display_name AS reviewer_name';
  const REVIEW_JOIN = 'LEFT JOIN users r ON r.id = p.reviewed_by';
  /**
   * Zet de controlekolommen van een plan om naar een object.
   * @param {object} plan Planrij met REVIEW_COLS.
   * @returns {object} status, question, requestedAt, reviewedAt, reviewedBy en via.
   */
  function reviewOf(plan) {
    return {
      status: plan.review_status || 'concept',
      question: plan.review_question || '',
      requestedAt: plan.review_requested_at || null,
      reviewedAt: plan.reviewed_at || null,
      reviewedBy: plan.reviewed_by ? plan.reviewer_name || 'Verwijderde gebruiker' : null,
      via: plan.submitted_via || '',
    };
  }

  /**
   * Zet een planrij om naar het formaat van de API; welke velden er zijn hangt
   * af van de kolommen in de rij.
   * @param {object} plan De planrij.
   * @param {boolean} withData Ook het volledige plan meegeven.
   * @returns {object} Het plan.
   */
  function planRow(plan, withData) {
    const out = { id: plan.id, title: plan.title, customer: plan.customer, address: plan.address, createdAt: plan.created_at, updatedAt: plan.updated_at };
    if (plan.owner_name !== undefined) {
      out.owner = { id: plan.owner_id, username: plan.owner_username, displayName: plan.owner_name, kind: plan.owner_kind };
      // Contactgegevens van wie een tekening zonder account indiende.
      if (plan.owner_kind === 'gast') Object.assign(out.owner, { email: plan.owner_email || '', phone: plan.owner_phone || '' });
    }
    if (plan.review_status !== undefined) out.review = reviewOf(plan);
    if (plan.lite !== undefined) {
      let data = null;
      try { data = JSON.parse(plan.lite); } catch { /* beschadigd plan: lege samenvatting */ }
      out.summary = summarize(data);
      out.deletedAt = plan.deleted_at || null;
    }
    if (plan.history_count !== undefined) out.historyCount = plan.history_count;
    if (withData) out.data = JSON.parse(plan.data);
    return out;
  }

  /**
   * Plannen van een tenant met samenvatting (vlakken, m², sproeiers, zones)
   * voor de overzichten; de grote achtergrondafbeelding blijft in de database.
   * @param {string} tenantId Id van de tenant.
   * @param {object} [options] ownerId, includeDeleted, withHistory (aantal historieregels, voor beheerders) en reviewStatus.
   * @returns {object[]} De plannen, laatst gewijzigd eerst.
   */
  function listPlans(tenantId, { ownerId = null, includeDeleted = false, withHistory = false, reviewStatus = null } = {}) {
    const args = [tenantId];
    let sql = `SELECT p.id, p.title, p.customer, p.address, p.created_at, p.updated_at, p.deleted_at, p.owner_id,
        ${jsonDigest(db, 'p.data', { values: ['areas'], counts: ['sprinklers', 'zones', 'elements'] })} AS lite,
        ${withHistory ? '(SELECT COUNT(*) FROM history h WHERE h.tenant_id = p.tenant_id AND h.plan_id = p.id) AS history_count,' : ''}
        u.username AS owner_username, u.display_name AS owner_name, u.kind AS owner_kind, u.email AS owner_email, u.phone AS owner_phone,
        ${REVIEW_COLS}
      FROM plans p JOIN users u ON u.id = p.owner_id ${REVIEW_JOIN} WHERE p.tenant_id = ?${includeDeleted ? '' : ' AND p.deleted_at IS NULL'}`;
    if (ownerId) { sql += ' AND p.owner_id = ?'; args.push(ownerId); }
    if (REVIEW_STATUSES.includes(reviewStatus)) { sql += ' AND p.review_status = ?'; args.push(reviewStatus); }
    return prepare(`${sql} ORDER BY p.updated_at DESC, p.id`).all(...args).map((plan) => planRow(plan, false));
  }

  /**
   * Zoekt een plan op dat de gebruiker mag zien: de eigenaar, of wie het recht
   * plannen.alle heeft, binnen de eigen tenant.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van het plan.
   * @param {string} [cols] Alleen de kolommen die nodig zijn (bij opslaan niet het hele plan met achtergrond).
   * @returns {object|null} De planrij, of null.
   */
  function findPlan(user, id, cols = '*') {
    const plan = prepare(`SELECT ${cols} FROM plans WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`).get(user.tenant_id, String(id));
    if (!plan) return null;
    if (plan.owner_id !== user.id && !Roles.can(user, 'plannen.alle')) return null;
    return plan;
  }

  /**
   * Een plan met de volledige inhoud, voor de planner.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van het plan.
   * @returns {object|null} Het plan, of null.
   */
  function getPlan(user, id) {
    const plan = findPlan(user, id, `id, owner_id, title, customer, address, data, created_at, updated_at,
      review_status, review_question, review_requested_at, reviewed_at, submitted_via, reviewed_by`);
    if (!plan) return null;
    if (plan.reviewed_by) plan.reviewer_name = prepare('SELECT display_name FROM users WHERE id = ?').get(plan.reviewed_by)?.display_name;
    return planRow(plan, true);
  }

  /**
   * Controlestatus van een plan binnen de tenant.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van het plan.
   * @returns {string|null} De status, of null als het plan niet bestaat of verwijderd is.
   */
  function planReviewStatus(tenantId, id) {
    return prepare('SELECT review_status FROM plans WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, String(id || ''))?.review_status || null;
  }

  /**
   * Biedt een plan ter controle aan (eigenaar of wie alle plannen mag
   * bewerken), met een vraag aan de installateur.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van het plan.
   * @param {string} question De vraag bij de aanvraag.
   * @returns {object|null} De nieuwe controlestand, of null.
   */
  function requestReview(user, id, question) {
    return transaction(db, () => {
      const plan = findPlan(user, id, 'id, owner_id, submitted_via');
      if (!plan) return null;
      const timestamp = currentTimestamp();
      prepare(`UPDATE plans SET review_status = 'ter_controle', review_question = ?, review_requested_at = ?, reviewed_by = NULL, reviewed_at = NULL,
          submitted_via = ? WHERE id = ?`).run(String(question || '').trim().slice(0, 2000), timestamp, plan.submitted_via || 'account', plan.id);
      return getPlanReview(user.tenant_id, plan.id);
    });
  }

  /**
   * Keurt een plan goed of trekt de goedkeuring in (terug naar concept). Het
   * recht plannen.goedkeuren controleert server.js.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van het plan.
   * @param {string} action 'approve' of iets anders (intrekken).
   * @returns {object|null} De nieuwe controlestand, of null.
   */
  function reviewPlan(user, id, action) {
    return transaction(db, () => {
      const plan = findPlan(user, id, 'id, owner_id');
      if (!plan) return null;
      if (action === 'approve') {
        prepare("UPDATE plans SET review_status = 'goedgekeurd', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(user.id, currentTimestamp(), plan.id);
      } else {
        prepare("UPDATE plans SET review_status = 'concept', reviewed_by = NULL, reviewed_at = NULL WHERE id = ?").run(plan.id);
      }
      return getPlanReview(user.tenant_id, plan.id);
    });
  }

  /**
   * De controlestand van een plan.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van het plan.
   * @returns {object|null} De controlestand, of null.
   */
  function getPlanReview(tenantId, id) {
    const plan = prepare(`SELECT p.id, ${REVIEW_COLS} FROM plans p ${REVIEW_JOIN} WHERE p.tenant_id = ? AND p.id = ?`).get(tenantId, id);
    return plan ? reviewOf(plan) : null;
  }

  /**
   * Slaat een tekening op die zonder account is ingediend (openbare planner):
   * een gast met de contactgegevens wordt eigenaar, het plan staat meteen ter controle.
   * @param {string} tenantId Id van de tenant.
   * @param {object} drawing name, email, phone, address, question, data (het plan) en ip.
   * @returns {{ id: string, title: string, reference: string }} Het plan en het kenmerk voor de indiener.
   */
  function submitDrawing(tenantId, { name, email, phone, address, question, data, ip }) {
    return transaction(db, () => {
      const tag = crypto.randomBytes(4).toString('hex');
      const guest = insertUser(tenantId, { username: `aanvraag-${tag}`, displayName: name, role: 'klant', kind: 'gast' });
      prepare('UPDATE users SET email = ?, phone = ? WHERE id = ?').run(email, phone, guest.id);
      const meta = { ...(data.meta || {}) };
      if (!String(meta.customer || '').trim()) meta.customer = name;
      if (address) meta.address = address;
      if (!String(meta.name || '').trim()) meta.name = `Tekening van ${name}`;
      const plan = { ...data, meta };
      const planMeta = metaOf(plan);
      const planId = newId();
      const timestamp = currentTimestamp();
      prepare(`INSERT INTO plans (id, tenant_id, owner_id, title, customer, address, data, created_at, updated_at,
          review_status, review_question, review_requested_at, submitted_via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ter_controle', ?, ?, 'openbaar')`)
        .run(planId, tenantId, guest.id, planMeta.title, planMeta.customer, planMeta.address, JSON.stringify(plan), timestamp, timestamp, question, timestamp);
      record({ tenantId, userId: guest.id, planId: planId, action: 'aangemaakt', data: plan, ip });
      return { id: planId, title: planMeta.title, reference: planId.slice(0, 8).toUpperCase() };
    });
  }

  /**
   * Hoeveel tekens openbaar ingediende tekeningen die nog op een controle
   * wachten samen in de database innemen (begrenzing per organisatie, T-03).
   * @param {string} tenantId Id van de omgeving.
   * @returns {number} Aantal tekens JSON.
   */
  function pendingDrawingChars(tenantId) {
    const row = prepare(`SELECT COALESCE(SUM(LENGTH(data)), 0) AS chars FROM plans
      WHERE tenant_id = ? AND submitted_via = 'openbaar' AND review_status = 'ter_controle' AND deleted_at IS NULL`).get(tenantId);
    return Number(row.chars) || 0;
  }

  /**
   * Ruimt openbaar ingediende tekeningen op die na een termijn nog steeds op
   * een controle wachten (niemand heeft ze behandeld): plan en historie-inhoud
   * weg, de contactgegevens van de aanvrager gewist (AVG, T-03).
   * @param {string} tenantId Id van de omgeving.
   * @param {number} days Bewaartermijn in dagen.
   * @returns {number} Aantal opgeruimde tekeningen.
   */
  function purgeStaleDrawings(tenantId, days) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return transaction(db, () => {
      const stale = prepare(`SELECT id, owner_id FROM plans
        WHERE tenant_id = ? AND submitted_via = 'openbaar' AND review_status = 'ter_controle' AND review_requested_at < ?`).all(tenantId, cutoff);
      if (!stale.length) return 0;
      const planIds = stale.map((row) => row.id);
      const ownerIds = [...new Set(stale.map((row) => row.owner_id).filter(Boolean))];
      const planMarks = planIds.map(() => '?').join(', ');
      prepare(`UPDATE history SET snapshot = NULL, title = 'Gewist plan', customer = '', address = '', summary = '{}', ip = ''
        WHERE tenant_id = ? AND plan_id IN (${planMarks})`).run(tenantId, ...planIds);
      prepare(`DELETE FROM plans WHERE tenant_id = ? AND id IN (${planMarks})`).run(tenantId, ...planIds);
      if (ownerIds.length) {
        prepare(`UPDATE users SET email = '', phone = '', display_name = 'Gewiste aanvrager' WHERE tenant_id = ? AND kind = 'gast' AND id IN (${ownerIds.map(() => '?').join(', ')})`)
          .run(tenantId, ...ownerIds);
      }
      return planIds.length;
    });
  }

  /**
   * Maakt een nieuw plan aan (zonder id) of slaat een bestaand plan op. Past
   * een klant een goedgekeurd plan aan, dan gaat het opnieuw ter controle.
   * @param {object} user De ingelogde gebruiker.
   * @param {string|null} id Id van het plan, of leeg voor een nieuw plan.
   * @param {object} data Het plan.
   * @param {string} ip IP-adres voor de historie.
   * @returns {object|null} Het plan met reviewStatus, of null als het niet gevonden is.
   */
  function savePlan(user, id, data, ip) {
    return transaction(db, () => {
      const meta = metaOf(data);
      const timestamp = currentTimestamp();
      const json = JSON.stringify(data);
      if (!id) {
        const planId = newId();
        prepare(`INSERT INTO plans (id, tenant_id, owner_id, title, customer, address, data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(planId, user.tenant_id, user.id, meta.title, meta.customer, meta.address, json, timestamp, timestamp);
        record({ tenantId: user.tenant_id, userId: user.id, planId: planId, action: 'aangemaakt', data, ip });
        return { ...planRow({ id: planId, ...meta, created_at: timestamp, updated_at: timestamp }, false), reviewStatus: 'concept' };
      }
      const plan = findPlan(user, id, 'id, owner_id, created_at, review_status');
      if (!plan) return null;
      prepare('UPDATE plans SET title = ?, customer = ?, address = ?, data = ?, updated_at = ? WHERE id = ?')
        .run(meta.title, meta.customer, meta.address, json, timestamp, plan.id);
      // Een klant past een goedgekeurd plan aan: opnieuw ter controle.
      if (plan.review_status === 'goedgekeurd' && !Roles.can(user, 'plannen.goedkeuren')) {
        prepare("UPDATE plans SET review_status = 'ter_controle', review_requested_at = ?, reviewed_by = NULL, reviewed_at = NULL WHERE id = ?").run(timestamp, plan.id);
      }
      const reviewStatus = plan.review_status === 'goedgekeurd' && !Roles.can(user, 'plannen.goedkeuren') ? 'ter_controle' : plan.review_status;
      record({ tenantId: user.tenant_id, userId: user.id, planId: plan.id, action: 'bijgewerkt', data, ip, merge: true });
      return { ...planRow({ id: plan.id, ...meta, created_at: plan.created_at, updated_at: timestamp }, false), reviewStatus };
    });
  }

  /**
   * Wist een plan definitief (AVG-verzoek): het plan zelf en de
   * persoonsgegevens in de historie (kopie, klant, adres, titel, IP). De regels
   * blijven staan als spoor, zonder inhoud. Werkt ook voor verwijderde plannen.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van het plan.
   * @returns {{ plan: boolean, history: number }|null} Wat er gewist is, of null als er niets was.
   */
  function purgePlan(tenantId, id) {
    return transaction(db, () => {
      const plan = prepare('SELECT id FROM plans WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
      const clearedHistory = prepare(`UPDATE history SET snapshot = NULL, title = 'Gewist plan', customer = '', address = '', summary = '{}', ip = ''
        WHERE tenant_id = ? AND plan_id = ?`).run(tenantId, String(id)).changes;
      if (!plan && !clearedHistory) return null;
      if (plan) prepare('DELETE FROM plans WHERE id = ?').run(plan.id);
      return { plan: Boolean(plan), history: clearedHistory };
    });
  }

  /**
   * Verwijdert een plan (zacht: deleted_at) en legt het vast in de historie.
   * @param {object} user De ingelogde gebruiker.
   * @param {string} id Id van het plan.
   * @param {string} ip IP-adres voor de historie.
   * @returns {boolean} Of het plan gevonden en verwijderd is.
   */
  function deletePlan(user, id, ip) {
    return transaction(db, () => {
      // De historie bewaart het plan zonder achtergrond: die hoeft niet mee.
      const plan = findPlan(user, id, `id, owner_id, ${jsonWithout(db, 'data', 'background')} AS data`);
      if (!plan) return false;
      prepare('UPDATE plans SET deleted_at = ? WHERE id = ?').run(currentTimestamp(), plan.id);
      record({ tenantId: user.tenant_id, userId: user.id, planId: plan.id, action: 'verwijderd', data: JSON.parse(plan.data), ip });
      return true;
    });
  }

  return { record, listHistory, getHistory, listPlans, getPlan, savePlan, deletePlan, purgePlan,
    planReviewStatus, requestReview, reviewPlan, getPlanReview, submitDrawing, pendingDrawingChars, purgeStaleDrawings };
}

module.exports = { createPlanStore };
