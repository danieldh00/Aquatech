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
const { FRONTEND_DIR } = require('../paths');
const crypto = require('crypto');
const { transaction } = require('../database/db');

const Core = require(path.join(FRONTEND_DIR, 'werkorders', 'worklog-core.js'));

const LOCKED = ['gereed', 'geannuleerd'];
const MAX_RANGE_DAYS = 400;
/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * De datum van vandaag in Nederland; boeken kan tot en met morgen (tijdzones, nachtwerk).
 * @returns {string} Datum als JJJJ-MM-DD.
 */
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
/**
 * Telt dagen op bij een datum.
 * @param {string} iso Datum als JJJJ-MM-DD.
 * @param {number} days Aantal dagen (negatief = terug).
 * @returns {string} De nieuwe datum als JJJJ-MM-DD.
 */
const addDays = (iso, days) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

const H_COLS = `h.id, h.work_order_id, h.user_id, h.user_name, h.work_date, h.start_time, h.end_time, h.break_minutes, h.minutes,
  h.kind, h.step_id, h.note, h.client_id, h.created_by, h.created_at, h.updated_at, u.display_name AS current_name`;
const M_COLS = `m.id, m.work_order_id, m.user_id, m.user_name, m.used_on, m.code, m.description, m.unit, m.qty, m.material_id,
  m.note, m.client_id, m.stock_movement_id, m.created_by, m.created_at, m.updated_at, u.display_name AS current_name`;
const WO_COLS = 'w.number AS wo_number, w.customer AS wo_customer, w.address AS wo_address, w.title AS wo_title';

/**
 * De medewerker van een regel; de huidige naam gaat voor de bewaarde naam.
 * @param {object} row Uren- of materiaalrij met user_id, user_name en current_name.
 * @returns {{ id: string|null, displayName: string }} De medewerker.
 */
const userOf = (row) => ({ id: row.user_id || null, displayName: row.current_name || row.user_name || 'Verwijderde gebruiker' });
/**
 * De werkordergegevens die een periode-overzicht meegeeft (WO_COLS).
 * @param {object} row Uren- of materiaalrij.
 * @returns {object|undefined} Nummer, klant, adres en titel, of undefined zonder die kolommen.
 */
const workOrderInfoOf = (row) => (row.wo_number === undefined ? undefined : { number: row.wo_number, customer: row.wo_customer, address: row.wo_address, title: row.wo_title });

/**
 * Zet een urenrij om naar het formaat van de API.
 * @param {object} row Rij met H_COLS (en eventueel WO_COLS).
 * @returns {object} De urenregel.
 */
function hoursOut(row) {
  const out = {
    id: row.id, clientId: row.client_id || null, workOrderId: row.work_order_id, user: userOf(row), createdBy: row.created_by || null,
    workDate: row.work_date, startTime: row.start_time, endTime: row.end_time, breakMinutes: Number(row.break_minutes), minutes: Number(row.minutes),
    kind: row.kind, stepId: row.step_id, note: row.note, createdAt: row.created_at, updatedAt: row.updated_at,
  };
  const order = workOrderInfoOf(row);
  if (order) out.workOrder = order;
  return out;
}

/**
 * Zet een materiaalrij om naar het formaat van de API.
 * @param {object} row Rij met M_COLS (en eventueel WO_COLS).
 * @returns {object} De materiaalregel.
 */
function materialOut(row) {
  const out = {
    id: row.id, clientId: row.client_id || null, workOrderId: row.work_order_id, user: userOf(row), createdBy: row.created_by || null,
    usedOn: row.used_on, code: row.code, description: row.description, unit: row.unit, qty: Number(row.qty), materialId: row.material_id,
    note: row.note, stockMovementId: row.stock_movement_id || null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
  const order = workOrderInfoOf(row);
  if (order) out.workOrder = order;
  return out;
}

/**
 * Maakt de opslag voor geboekte uren en materiaalverbruik.
 * @param {object} db De database.
 * @param {{ onMaterialUsed?: Function }} [options] Aanroep na elke materiaalwijziging (voorraadbeheer).
 * @returns {object} workOrder, list, addHours, updateHours, removeHours, hoursRow, addMaterial, updateMaterial, removeMaterial, materialRow, period, usedByCode, counts en hook.
 */
function createWorkLogStore(db, { onMaterialUsed = null } = {}) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  // Voorraadbeheer kan zich later aanmelden (zie hook()).
  let materialHook = onMaterialUsed;

  /**
   * Zoekt een (niet verwijderde) werkorder van de omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de werkorder.
   * @returns {object|undefined} id, number en status.
   */
  const workOrder = (tenantId, id) => prepare('SELECT id, number, status FROM work_orders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
    .get(tenantId, String(id));

  /**
   * Eén urenrij met de huidige naam van de medewerker.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de urenregel.
   * @returns {object|undefined} De rij.
   */
  const hoursRow = (tenantId, id) => prepare(`SELECT ${H_COLS} FROM work_order_hours h LEFT JOIN users u ON u.id = h.user_id
    WHERE h.tenant_id = ? AND h.id = ?`).get(tenantId, String(id));
  /**
   * Eén materiaalrij met de huidige naam van de medewerker.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de materiaalregel.
   * @returns {object|undefined} De rij.
   */
  const materialRow = (tenantId, id) => prepare(`SELECT ${M_COLS} FROM work_order_materials m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = ? AND m.id = ?`).get(tenantId, String(id));

  /**
   * Alle geboekte regels van één werkorder (twee queries, oudste eerst).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} workOrderId Id van de werkorder.
   * @returns {{ hours: object[], materials: object[] }} Uren- en materiaalregels.
   */
  function list(tenantId, workOrderId) {
    const id = String(workOrderId);
    return {
      hours: prepare(`SELECT ${H_COLS} FROM work_order_hours h LEFT JOIN users u ON u.id = h.user_id
        WHERE h.tenant_id = ? AND h.work_order_id = ? ORDER BY h.work_date, h.start_time, h.created_at`).all(tenantId, id).map(hoursOut),
      materials: prepare(`SELECT ${M_COLS} FROM work_order_materials m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = ? AND m.work_order_id = ? ORDER BY m.used_on, m.created_at`).all(tenantId, id).map(materialOut),
    };
  }

  /**
   * Aantal regels van een werkorder in een tabel.
   * @param {string} table work_order_hours of work_order_materials.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} workOrderId Id van de werkorder.
   * @returns {number} Het aantal.
   */
  const count = (table, tenantId, workOrderId) => Number(prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ? AND work_order_id = ?`).get(tenantId, workOrderId).n);
  /**
   * Zoekt een eerder verstuurde regel met dezelfde clientId (dubbel versturen).
   * @param {string} table work_order_hours of work_order_materials.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} clientId UUID uit de browser.
   * @returns {object|null|undefined} id en work_order_id, of leeg.
   */
  const byClient = (table, tenantId, clientId) => (Core.isClientId(clientId)
    ? prepare(`SELECT id, work_order_id FROM ${table} WHERE tenant_id = ? AND client_id = ?`).get(tenantId, clientId) : null);
  /**
   * Controleert dat een datum niet verder dan morgen ligt.
   * @param {string} date Datum als JJJJ-MM-DD.
   * @returns {string|null} Foutmelding, of null als het goed is.
   */
  const futureCheck = (date) => (date > addDays(today(), 1) ? 'Boeken op een datum in de toekomst kan niet.' : null);

  /**
   * Uren boeken. Bestaat er al een regel met deze clientId, dan komt die terug
   * (existing: true) en wordt er niets dubbel geboekt.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} workOrderId Id van de werkorder.
   * @param {object} input De urenregel uit het verzoek.
   * @param {{ actor: object, forUser: { id: string, displayName: string } }} who Wie boekt (req.user) en voor wie.
   * @returns {object} { entry, workOrder } of { entry, existing: true }, of { error, status, message }.
   */
  function addHours(tenantId, workOrderId, input, { actor, forUser }) {
    const order = workOrder(tenantId, workOrderId);
    if (!order) return { error: 'not_found', status: 404, message: 'Werkorder niet gevonden.' };
    const duplicate = byClient('work_order_hours', tenantId, input.clientId);
    if (duplicate) {
      if (duplicate.work_order_id !== order.id) return { error: 'conflict', status: 409, message: 'Deze regel hoort bij een andere werkorder.' };
      return { entry: hoursOut(hoursRow(tenantId, duplicate.id)), existing: true };
    }
    const cleaned = Core.cleanHours(input);
    if (cleaned.error) return { error: 'invalid_hours', status: 400, message: cleaned.error };
    const future = futureCheck(cleaned.entry.workDate);
    if (future) return { error: 'invalid_hours', status: 400, message: future };
    if (count('work_order_hours', tenantId, order.id) >= Core.MAX_ENTRIES) return { error: 'too_many', status: 409, message: 'Maximum aantal urenregels bereikt.' };
    const entry = cleaned.entry;
    const id = crypto.randomUUID();
    const timestamp = currentTimestamp();
    prepare(`INSERT INTO work_order_hours (id, tenant_id, work_order_id, user_id, user_name, work_date, start_time, end_time, break_minutes, minutes,
        kind, step_id, note, client_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, order.id, forUser.id, String(forUser.displayName || '').slice(0, 200), entry.workDate, entry.startTime, entry.endTime, entry.breakMinutes, entry.minutes,
        entry.kind, entry.stepId, entry.note, Core.isClientId(input.clientId) ? input.clientId : null, actor.id, timestamp, timestamp);
    return { entry: hoursOut(hoursRow(tenantId, id)), workOrder: order };
  }

  /**
   * Wijzigt een urenregel.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de urenregel.
   * @param {object} input De gewijzigde velden.
   * @param {{ forUser?: object }} [options] Andere medewerker voor de regel.
   * @returns {object} { entry }, of { error, status, message }.
   */
  function updateHours(tenantId, id, input, { forUser = null } = {}) {
    const row = hoursRow(tenantId, id);
    if (!row) return { error: 'not_found', status: 404, message: 'Urenregel niet gevonden.' };
    const cleaned = Core.cleanHours({ ...hoursOut(row), hours: undefined, ...input });
    if (cleaned.error) return { error: 'invalid_hours', status: 400, message: cleaned.error };
    const future = futureCheck(cleaned.entry.workDate);
    if (future) return { error: 'invalid_hours', status: 400, message: future };
    const entry = cleaned.entry;
    const userId = forUser ? forUser.id : row.user_id;
    const userName = forUser ? String(forUser.displayName || '').slice(0, 200) : row.user_name;
    prepare(`UPDATE work_order_hours SET user_id = ?, user_name = ?, work_date = ?, start_time = ?, end_time = ?, break_minutes = ?, minutes = ?,
        kind = ?, step_id = ?, note = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
      .run(userId, userName, entry.workDate, entry.startTime, entry.endTime, entry.breakMinutes, entry.minutes, entry.kind, entry.stepId, entry.note, currentTimestamp(), tenantId, row.id);
    return { entry: hoursOut(hoursRow(tenantId, row.id)) };
  }

  /**
   * Verwijdert een urenregel.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de urenregel.
   * @returns {boolean} true als er iets is verwijderd.
   */
  const removeHours = (tenantId, id) => prepare('DELETE FROM work_order_hours WHERE tenant_id = ? AND id = ?').run(tenantId, String(id)).changes > 0;

  /**
   * Voorraad bijwerken na een wijziging (in dezelfde transactie).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} row De materiaalrij.
   * @param {object} actor Wie de wijziging doet.
   * @param {boolean} [deleted] true als de regel wordt verwijderd.
   * @returns {void}
   */
  function syncStock(tenantId, row, actor, deleted = false) {
    if (!materialHook) return;
    const movement = materialHook(tenantId, { id: row.id, work_order_id: row.work_order_id, code: row.code, qty: Number(row.qty), deleted }, actor);
    if (!deleted && movement !== undefined) {
      prepare('UPDATE work_order_materials SET stock_movement_id = ? WHERE tenant_id = ? AND id = ?').run(movement || null, tenantId, row.id);
    }
  }

  /**
   * Materiaalverbruik boeken (en de voorraad bijwerken). Een dubbel
   * verstuurde regel (zelfde clientId) komt terug met existing: true.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} workOrderId Id van de werkorder.
   * @param {object} input De materiaalregel uit het verzoek.
   * @param {{ actor: object, forUser: { id: string, displayName: string } }} who Wie boekt en voor wie.
   * @returns {object} { entry, workOrder } of { entry, existing: true }, of { error, status, message }.
   */
  function addMaterial(tenantId, workOrderId, input, { actor, forUser }) {
    const order = workOrder(tenantId, workOrderId);
    if (!order) return { error: 'not_found', status: 404, message: 'Werkorder niet gevonden.' };
    const duplicate = byClient('work_order_materials', tenantId, input.clientId);
    if (duplicate) {
      if (duplicate.work_order_id !== order.id) return { error: 'conflict', status: 409, message: 'Deze regel hoort bij een andere werkorder.' };
      return { entry: materialOut(materialRow(tenantId, duplicate.id)), existing: true };
    }
    const cleaned = Core.cleanMaterial(input);
    if (cleaned.error) return { error: 'invalid_material', status: 400, message: cleaned.error };
    const future = futureCheck(cleaned.entry.usedOn);
    if (future) return { error: 'invalid_material', status: 400, message: future };
    if (count('work_order_materials', tenantId, order.id) >= Core.MAX_ENTRIES) return { error: 'too_many', status: 409, message: 'Maximum aantal materiaalregels bereikt.' };
    const entry = cleaned.entry;
    return transaction(db, () => {
      const id = crypto.randomUUID();
      const timestamp = currentTimestamp();
      prepare(`INSERT INTO work_order_materials (id, tenant_id, work_order_id, user_id, user_name, used_on, code, description, unit, qty, material_id,
          note, client_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, order.id, forUser.id, String(forUser.displayName || '').slice(0, 200), entry.usedOn, entry.code, entry.description, entry.unit, entry.qty,
          entry.materialId, entry.note, Core.isClientId(input.clientId) ? input.clientId : null, actor.id, timestamp, timestamp);
      syncStock(tenantId, materialRow(tenantId, id), actor);
      return { entry: materialOut(materialRow(tenantId, id)), workOrder: order };
    });
  }

  /**
   * Wijzigt een materiaalregel (en de voorraad).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de materiaalregel.
   * @param {object} input De gewijzigde velden.
   * @param {{ actor: object, forUser?: object }} who Wie wijzigt; eventueel andere medewerker voor de regel.
   * @returns {object} { entry }, of { error, status, message }.
   */
  function updateMaterial(tenantId, id, input, { actor, forUser = null }) {
    const row = materialRow(tenantId, id);
    if (!row) return { error: 'not_found', status: 404, message: 'Materiaalregel niet gevonden.' };
    const cleaned = Core.cleanMaterial({ ...materialOut(row), ...input });
    if (cleaned.error) return { error: 'invalid_material', status: 400, message: cleaned.error };
    const future = futureCheck(cleaned.entry.usedOn);
    if (future) return { error: 'invalid_material', status: 400, message: future };
    const entry = cleaned.entry;
    return transaction(db, () => {
      prepare(`UPDATE work_order_materials SET user_id = ?, user_name = ?, used_on = ?, code = ?, description = ?, unit = ?, qty = ?, material_id = ?,
          note = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
        .run(forUser ? forUser.id : row.user_id, forUser ? String(forUser.displayName || '').slice(0, 200) : row.user_name,
          entry.usedOn, entry.code, entry.description, entry.unit, entry.qty, entry.materialId, entry.note, currentTimestamp(), tenantId, row.id);
      syncStock(tenantId, materialRow(tenantId, row.id), actor);
      return { entry: materialOut(materialRow(tenantId, row.id)) };
    });
  }

  /**
   * Verwijdert een materiaalregel en zet de voorraad terug.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de materiaalregel.
   * @param {object} actor Wie verwijdert.
   * @returns {boolean} true als er iets is verwijderd.
   */
  function removeMaterial(tenantId, id, actor) {
    return transaction(db, () => {
      const row = materialRow(tenantId, id);
      if (!row) return false;
      syncStock(tenantId, row, actor, true);
      return prepare('DELETE FROM work_order_materials WHERE tenant_id = ? AND id = ?').run(tenantId, row.id).changes > 0;
    });
  }

  /**
   * Urenstaat en verbruik over een periode (alle werkorders van de omgeving,
   * verwijderde werkorders niet).
   * @param {string} tenantId Id van de omgeving.
   * @param {{ from: string, to: string, userId?: string }} range Eerste en laatste datum; alleen die medewerker.
   * @returns {{ hours: object[], materials: object[] }} Regels met werkordergegevens.
   */
  function period(tenantId, { from, to, userId = null }) {
    const hArgs = [tenantId, from, to];
    const mArgs = [tenantId, from, to];
    let hWhere = '';
    let mWhere = '';
    if (userId) { hWhere = ' AND h.user_id = ?'; mWhere = ' AND m.user_id = ?'; hArgs.push(String(userId)); mArgs.push(String(userId)); }
    return {
      hours: prepare(`SELECT ${H_COLS}, ${WO_COLS} FROM work_order_hours h JOIN work_orders w ON w.id = h.work_order_id AND w.tenant_id = h.tenant_id
        LEFT JOIN users u ON u.id = h.user_id WHERE h.tenant_id = ? AND h.work_date >= ? AND h.work_date <= ? AND w.deleted_at IS NULL${hWhere}
        ORDER BY h.work_date, h.start_time, w.number`).all(...hArgs).map(hoursOut),
      materials: prepare(`SELECT ${M_COLS}, ${WO_COLS} FROM work_order_materials m JOIN work_orders w ON w.id = m.work_order_id AND w.tenant_id = m.tenant_id
        LEFT JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.used_on >= ? AND m.used_on <= ? AND w.deleted_at IS NULL${mWhere}
        ORDER BY m.used_on, w.number`).all(...mArgs).map(materialOut),
    };
  }

  /**
   * Verbruikt per artikelcode op een werkorder (voorraadbeheer).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} workOrderId Id van de werkorder.
   * @returns {Object<string, number>} Aantal per artikelcode.
   */
  function usedByCode(tenantId, workOrderId) {
    const out = {};
    for (const row of prepare(`SELECT code, SUM(qty) AS qty FROM work_order_materials WHERE tenant_id = ? AND work_order_id = ? AND code <> ''
      GROUP BY code`).all(tenantId, String(workOrderId))) out[row.code] = Math.round(Number(row.qty) * 100) / 100;
    return out;
  }

  /**
   * Geboekte uren (minuten) en verbruiksregels per werkorder, voor overzichten.
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]|null} [ids] Alleen deze werkorders (null = alle).
   * @returns {Object<string, { minutes: number, materials: number }>} Totalen per werkorder-id.
   */
  function counts(tenantId, ids = null) {
    const out = {};
    if (ids && !ids.length) return out;
    const only = ids ? ` AND work_order_id IN (${ids.map(() => '?').join(', ')})` : '';
    const args = [tenantId, ...(ids || []).map(String)];
    // Eén query (UNION): de som van de minuten en het aantal materiaalregels.
    for (const row of prepare(`SELECT work_order_id, 'h' AS k, SUM(minutes) AS n FROM work_order_hours WHERE tenant_id = ?${only} GROUP BY work_order_id
      UNION ALL SELECT work_order_id, 'm' AS k, COUNT(*) AS n FROM work_order_materials WHERE tenant_id = ?${only} GROUP BY work_order_id`).all(...args, ...args)) {
      const totals = out[row.work_order_id] = out[row.work_order_id] || { minutes: 0, materials: 0 };
      totals[row.k === 'h' ? 'minutes' : 'materials'] = Number(row.n);
    }
    return out;
  }

  /**
   * Eén urenregel in het formaat van de API.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de urenregel.
   * @returns {object|null} De regel, of null.
   */
  function hoursEntry(tenantId, id) {
    const row = hoursRow(tenantId, id);
    return row ? hoursOut(row) : null;
  }

  /**
   * Eén materiaalregel in het formaat van de API.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de materiaalregel.
   * @returns {object|null} De regel, of null.
   */
  function materialEntry(tenantId, id) {
    const row = materialRow(tenantId, id);
    return row ? materialOut(row) : null;
  }

  /**
   * Meldt voorraadbeheer aan voor materiaalwijzigingen (vervangt onMaterialUsed).
   * @param {Function} handler Aanroep (tenantId, regel, gebruiker), geeft het id van de voorraadmutatie terug.
   * @returns {void}
   */
  function hook(handler) {
    materialHook = handler;
  }

  return {
    workOrder, list, addHours, updateHours, removeHours, hoursRow: hoursEntry,
    addMaterial, updateMaterial, removeMaterial, materialRow: materialEntry,
    period, usedByCode, counts, hook,
  };
}

/**
 * API-routes voor uren en materiaalverbruik.
 * @param {object} app De Express-app.
 * @param {object} ctx { worklog, requireRight, requireJson, audit, staffOf(req) (medewerkers aan wie geboekt kan worden: [{ id, displayName }]), canManage(user) }.
 * @returns {void}
 */
function registerWorkLogRoutes(app, ctx) {
  const { worklog, requireRight, requireJson, audit } = ctx;
  const requireWorkOrders = requireRight('werkorders');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Mag de gebruiker alle regels beheren (recht planning)?
   * @param {object} req Het verzoek.
   * @returns {boolean} true als dat mag.
   */
  const canManage = (req) => Boolean(ctx.canManage(req.user));
  /**
   * Stuurt een foutantwoord uit de opslag terug.
   * @param {object} res Het antwoord.
   * @param {{ status: number, error: string, message: string }} out De fout.
   * @returns {void}
   */
  const fail = (res, out) => res.status(out.status).json({ error: out.error, message: out.message });
  /**
   * Stuurt 404 terug.
   * @param {object} res Het antwoord.
   * @param {string} what Wat niet gevonden is (bijv. 'Werkorder').
   * @returns {void}
   */
  const notFound = (res, what) => res.status(404).json({ error: 'not_found', message: `${what} niet gevonden.` });
  /**
   * Stuurt 403 terug.
   * @param {object} res Het antwoord.
   * @param {string} message De melding.
   * @returns {void}
   */
  const forbidden = (res, message) => res.status(403).json({ error: 'forbidden', message });
  /**
   * Stuurt 409 terug: de werkorder is afgerond.
   * @param {object} res Het antwoord.
   * @returns {void}
   */
  const locked = (res) => res.status(409).json({ error: 'locked', message: 'Deze werkorder is afgerond; vraag de planner of beheerder om de registratie aan te passen.' });
  /**
   * De ingelogde gebruiker als medewerker.
   * @param {object} req Het verzoek.
   * @returns {{ id: string, displayName: string }} De medewerker.
   */
  const self = (req) => ({ id: req.user.id, displayName: req.user.display_name });

  /**
   * Voor wie wordt geboekt: jezelf, of (met het recht planning) een collega.
   * @param {object} req Het verzoek.
   * @param {*} raw userId uit de invoer.
   * @returns {{ user?: object, error?: string }} De medewerker, of 'forbidden'/'invalid_user'.
   */
  function forUserOf(req, raw) {
    if (raw === undefined || raw === null || raw === '' || String(raw) === req.user.id) return { user: self(req) };
    if (!canManage(req)) return { error: 'forbidden' };
    const colleague = ctx.staffOf(req).find((member) => member.id === String(raw));
    return colleague ? { user: { id: colleague.id, displayName: colleague.displayName } } : { error: 'invalid_user' };
  }
  /**
   * Bepaalt voor wie wordt geboekt en stuurt bij een fout zelf het antwoord.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {*} raw userId uit de invoer.
   * @returns {object|null} De medewerker, of null (antwoord al verstuurd).
   */
  function checkFor(req, res, raw) {
    const target = forUserOf(req, raw);
    if (target.error === 'forbidden') { forbidden(res, 'Je boekt alleen je eigen uren en materiaal.'); return null; }
    if (target.error) { res.status(400).json({ error: 'invalid_user', message: 'Onbekende medewerker.' }); return null; }
    return target.user;
  }
  /**
   * Werkorder bestaat in deze omgeving en is (voor wie niet mag beheren) niet afgerond.
   * @param {object} req Het verzoek (params.id).
   * @param {object} res Het antwoord.
   * @returns {object|null} De werkorder, of null (antwoord al verstuurd).
   */
  function openWorkOrder(req, res) {
    const order = worklog.workOrder(tenantOf(req), req.params.id);
    if (!order) { notFound(res, 'Werkorder'); return null; }
    if (LOCKED.includes(order.status) && !canManage(req)) { locked(res); return null; }
    return order;
  }
  /**
   * Een bestaande regel: van deze werkorder, en eigen regel tenzij je mag beheren.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {object|null} entry De regel.
   * @param {string} what 'Urenregel' of 'Materiaalregel' (voor de melding).
   * @returns {boolean} true als de regel gewijzigd mag worden.
   */
  function ownEntry(req, res, entry, what) {
    if (!entry || entry.workOrderId !== String(req.params.id)) { notFound(res, what); return false; }
    const mine = entry.user.id === req.user.id || entry.createdBy === req.user.id;
    if (!mine && !canManage(req)) { forbidden(res, 'Je wijzigt alleen je eigen regels.'); return false; }
    return true;
  }

  app.get('/api/workorders/:id/worklog', requireWorkOrders, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const order = worklog.workOrder(tenantOf(req), req.params.id);
    if (!order) return notFound(res, 'Werkorder');
    const manage = canManage(req);
    res.json({
      ...worklog.list(tenantOf(req), order.id), kinds: Core.KINDS, canManage: manage,
      locked: LOCKED.includes(order.status) && !manage, me: self(req), today: today(),
    });
  });

  // ---------- Uren ----------
  app.post('/api/workorders/:id/hours', requireJson, requireWorkOrders, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const order = openWorkOrder(req, res);
    if (!order) return;
    const forUser = checkFor(req, res, body.userId);
    if (!forUser) return;
    const out = worklog.addHours(tenantOf(req), order.id, body, { actor: req.user, forUser });
    if (out.error) return fail(res, out);
    if (!out.existing) audit(req, 'uren_geboekt', { workOrderId: order.id, number: order.number, entryId: out.entry.id, minutes: out.entry.minutes, forUserId: forUser.id });
    res.status(out.existing ? 200 : 201).json(out.entry);
  });

  app.put('/api/workorders/:id/hours/:eid', requireJson, requireWorkOrders, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!openWorkOrder(req, res)) return;
    if (!ownEntry(req, res, worklog.hoursRow(tenantOf(req), req.params.eid), 'Urenregel')) return;
    let forUser = null;
    if (body.userId !== undefined) { forUser = checkFor(req, res, body.userId); if (!forUser) return; }
    const out = worklog.updateHours(tenantOf(req), req.params.eid, body, { forUser });
    if (out.error) return fail(res, out);
    res.json(out.entry);
  });

  app.delete('/api/workorders/:id/hours/:eid', requireWorkOrders, (req, res) => {
    if (!openWorkOrder(req, res)) return;
    const entry = worklog.hoursRow(tenantOf(req), req.params.eid);
    if (!ownEntry(req, res, entry, 'Urenregel')) return;
    worklog.removeHours(tenantOf(req), entry.id);
    audit(req, 'uren_verwijderd', { workOrderId: entry.workOrderId, entryId: entry.id, minutes: entry.minutes });
    res.json({ ok: true });
  });

  // ---------- Materiaalverbruik ----------
  app.post('/api/workorders/:id/materials', requireJson, requireWorkOrders, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const order = openWorkOrder(req, res);
    if (!order) return;
    const forUser = checkFor(req, res, body.userId);
    if (!forUser) return;
    const out = worklog.addMaterial(tenantOf(req), order.id, body, { actor: req.user, forUser });
    if (out.error) return fail(res, out);
    if (!out.existing) audit(req, 'materiaal_geboekt', { workOrderId: order.id, number: order.number, entryId: out.entry.id, code: out.entry.code, qty: out.entry.qty });
    res.status(out.existing ? 200 : 201).json(out.entry);
  });

  app.put('/api/workorders/:id/materials/:eid', requireJson, requireWorkOrders, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!openWorkOrder(req, res)) return;
    if (!ownEntry(req, res, worklog.materialRow(tenantOf(req), req.params.eid), 'Materiaalregel')) return;
    let forUser = null;
    if (body.userId !== undefined) { forUser = checkFor(req, res, body.userId); if (!forUser) return; }
    const out = worklog.updateMaterial(tenantOf(req), req.params.eid, body, { actor: req.user, forUser });
    if (out.error) return fail(res, out);
    res.json(out.entry);
  });

  app.delete('/api/workorders/:id/materials/:eid', requireWorkOrders, (req, res) => {
    if (!openWorkOrder(req, res)) return;
    const entry = worklog.materialRow(tenantOf(req), req.params.eid);
    if (!ownEntry(req, res, entry, 'Materiaalregel')) return;
    worklog.removeMaterial(tenantOf(req), entry.id, req.user);
    audit(req, 'materiaal_verwijderd', { workOrderId: entry.workOrderId, entryId: entry.id, code: entry.code, qty: entry.qty });
    res.json({ ok: true });
  });

  // ---------- Urenstaat over een periode (Excel in de browser) ----------
  // Met het recht planning: iedereen (of ?user=<id>); anders alleen jezelf.
  app.get('/api/worklog', requireWorkOrders, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!Core.isDate(from) || !Core.isDate(to) || from > to) return res.status(400).json({ error: 'invalid_range', message: 'Kies een geldige periode.' });
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS) return res.status(400).json({ error: 'invalid_range', message: `Kies een periode van hooguit ${MAX_RANGE_DAYS} dagen.` });
    const manage = canManage(req);
    const user = req.query.user ? String(req.query.user) : null;
    if (user && user !== req.user.id && !manage) return forbidden(res, 'Je ziet alleen je eigen uren.');
    const userId = manage ? user : req.user.id;
    res.json({ from, to, userId, canManage: manage, kinds: Core.KINDS, ...worklog.period(tenantOf(req), { from, to, userId }) });
  });
}

module.exports = { createWorkLogStore, registerWorkLogRoutes, Core };
