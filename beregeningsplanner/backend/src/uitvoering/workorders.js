// Werkorders: opslag (tabel work_orders) en de API-routes. Een werkorder
// ontstaat uit een geaccordeerde offerte en bevat het uitvoeringsplan
// (werkstappen met uren, zone-indeling) en de benodigde materialen. De
// opbouw zelf staat in frontend/werkorders/workorder-core.js en is gedeeld
// met de browser. Alleen voor beheerders en installateurs (recht
// 'werkorders'); een klant ziet geen werkorders, wel de afspraak: via een
// openbare link (openbaar/afspraak.html#t=<token>, zoals de digitale offerte)
// ziet hij wanneer de klus gepland staat en bevestigt hij die of vraagt hij
// een ander moment.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const crypto = require('crypto');
const { transaction } = require('../database/db');
const { createVault } = require('../beveiliging/vault');
const { createMailer, validEmail } = require('../platform/mailer');
const { preferencesOf } = require('../platform/store');
const { ifBaseOf } = require('../beveiliging/idempotency');

/**
 * Kopie (bcc) van een verstuurde mail naar de afzender, als die dat in Mijn
 * profiel heeft aangezet en een e-mailadres heeft.
 * @param {object} user De ingelogde gebruiker.
 * @returns {string|undefined} Het e-mailadres, of undefined.
 */
const copyTo = (user) => (user && preferencesOf(user).mailCopy && validEmail(user.email) ? user.email : undefined);
const { validShareBase, mailBody } = require('../verkoop/quotes');

const Core = require(path.join(FRONTEND_DIR, 'werkorders', 'workorder-core.js'));

const STATUSES = Object.keys(Core.STATUSES);
const PREFIX = 'WO-';
const PAGE = 'afspraak.html';
const ANSWERS = ['bevestigd', 'ander_moment'];
/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * SHA-256 van een tekst.
 * @param {string} value De tekst.
 * @returns {string} De hash als hex.
 */
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
/**
 * Leest het afspraaklogboek (JSON); bij lege of kapotte invoer een lege lijst.
 * @param {string|null} value JSON uit work_orders.appointment.
 * @returns {object[]} De reacties van de klant.
 */
const parseLog = (value) => {
  try { const parsed = value ? JSON.parse(value) : []; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};
/**
 * Vandaag in Nederland (de afspraken zijn lokale datums).
 * @returns {string} Datum als JJJJ-MM-DD.
 */
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

/**
 * Stand van de afspraak: de laatste reactie van de klant telt alleen als die
 * over het huidige moment (datum, tijden, dagen) ging; is de planning daarna
 * verschoven, dan moet de klant opnieuw bevestigen.
 * @param {object} workOrderRow Rij met appointment en share_hash.
 * @param {object} data De werkorderdata.
 * @returns {{ state: string, response: object|null }} geen | niet_gedeeld | wacht | bevestigd | ander_moment, en de laatste reactie.
 */
function appointmentOf(workOrderRow, data) {
  const log = parseLog(workOrderRow.appointment);
  const last = log.length ? log[log.length - 1] : null;
  const currentMoment = Core.moment(data);
  const current = Boolean(last && Core.momentKey(last.moment || {}) === Core.momentKey(currentMoment));
  let state;
  if (!currentMoment.date) state = 'geen';
  else if (current) state = last.answer;
  else state = workOrderRow.share_hash ? 'wacht' : 'niet_gedeeld';
  const response = last ? { answer: last.answer, name: last.name, at: last.at, reason: last.reason || '', moment: last.moment, current } : null;
  return { state, response };
}

/**
 * Maakt de opslag voor werkorders en de afspraaklink.
 * @param {object} db De database.
 * @param {{ vault?: object, staffRoles?: Function }} [options] Kluis voor het token; rollen die een werkorder kunnen uitvoeren (per tenant).
 * @returns {object} list, get, day, quoteOf, staff, create, createReceived, update, schedule, share, unshare, markSent, byToken, markViewed, shareLink, publicView, respond, remove, purge en nextNumber.
 */
function createWorkOrderStore(db, { vault = createVault(), staffRoles = () => ['beheerder', 'installateur'] } = {}) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * Context (AAD) voor het versleutelde token van de afspraaklink.
   * @param {object} workOrderRow Rij met tenant_id en id.
   * @returns {string} De context.
   */
  const tokenContext = (workOrderRow) => `${workOrderRow.tenant_id}:afspraaklink:${workOrderRow.id}`;

  /**
   * De klantlink van een werkorder (met het token ontsleuteld in de URL).
   * @param {object} workOrderRow Rij met de share-kolommen.
   * @returns {object} active, url, sharedAt, viewedAt, sentAt en sentTo.
   */
  function shareOf(workOrderRow) {
    let url = null;
    if (workOrderRow.share_hash && workOrderRow.share_token && workOrderRow.share_url) {
      try { url = `${workOrderRow.share_url}#t=${vault.open(workOrderRow.share_token, tokenContext(workOrderRow))}`; } catch { url = null; }
    }
    return { active: Boolean(workOrderRow.share_hash), url, sharedAt: workOrderRow.shared_at || null, viewedAt: workOrderRow.viewed_at || null, sentAt: workOrderRow.sent_at || null, sentTo: workOrderRow.sent_to || null };
  }

  /**
   * Zet een werkorderrij om naar het formaat van de API.
   * @param {object} workOrderRow Rij met SELECT of LIST_SELECT.
   * @param {boolean} withData Ook de volledige data en de klantlink.
   * @returns {object} De werkorder.
   */
  function toWorkOrder(workOrderRow, withData) {
    const data = JSON.parse(workOrderRow.data);
    const out = {
      id: workOrderRow.id, number: workOrderRow.number, status: workOrderRow.status, title: workOrderRow.title, customer: workOrderRow.customer, address: workOrderRow.address,
      quoteId: workOrderRow.quote_id || null, quoteNumber: data.quoteNumber || '', planId: workOrderRow.plan_id || null,
      plannedDate: workOrderRow.planned_date || '', startTime: data.startTime || '', endTime: data.endTime || '', days: data.days || 1,
      crew: data.crew || '',
      summary: Core.summary(data),
      assigneeId: workOrderRow.assignee_id || null, assignee: workOrderRow.assignee_id ? { id: workOrderRow.assignee_id, displayName: workOrderRow.assignee_name || '' } : null,
      appointment: appointmentOf(workOrderRow, data),
      progress: Core.progress(data), createdAt: workOrderRow.created_at, updatedAt: workOrderRow.updated_at,
    };
    if (workOrderRow.owner_name !== undefined) out.owner = { id: workOrderRow.owner_id, displayName: workOrderRow.owner_name };
    if (withData) {
      out.data = data;
      out.share = shareOf(workOrderRow);
    }
    return out;
  }

  const FROM = 'FROM work_orders w JOIN users o ON o.id = w.owner_id LEFT JOIN users a ON a.id = w.assignee_id';
  // Volledig (detail, met de klantlink) en voor overzichten: zonder de
  // versleutelde link en de verzendgegevens, die alleen het detail toont.
  const SELECT = `SELECT w.id, w.tenant_id, w.owner_id, w.quote_id, w.plan_id, w.number, w.status, w.title, w.customer, w.address,
      w.planned_date, w.assignee_id, w.data, w.created_at, w.updated_at, w.share_hash, w.share_token, w.share_url, w.shared_at,
      w.viewed_at, w.sent_at, w.sent_to, w.appointment, o.display_name AS owner_name, a.display_name AS assignee_name ${FROM}`;
  // Wat de openbare afspraakpagina en de reactie van de klant nodig hebben.
  const PUBLIC_COLS = 'id, tenant_id, number, status, data, appointment, share_hash';
  const LIST_SELECT = `SELECT w.id, w.tenant_id, w.owner_id, w.quote_id, w.plan_id, w.number, w.status, w.title, w.customer, w.address,
      w.planned_date, w.assignee_id, w.data, w.created_at, w.updated_at, w.share_hash, w.appointment,
      o.display_name AS owner_name, a.display_name AS assignee_name ${FROM}`;
  // Werkorders van een klantaccount: via een niet-concept-offerte aan dat
  // account, of gemaakt uit een melding van dat account (service-requests.js).
  // Twee parameters: twee keer het klant-id.
  const OF_CUSTOMER = ` AND (EXISTS (SELECT 1 FROM quotes qu WHERE qu.id = w.quote_id AND qu.tenant_id = w.tenant_id
    AND qu.deleted_at IS NULL AND qu.customer_id = ? AND qu.status <> 'concept')
    OR EXISTS (SELECT 1 FROM service_requests sr WHERE sr.tenant_id = w.tenant_id AND sr.work_order_id = w.id AND sr.customer_id = ?))`;

  /**
   * Alle werkorders van de omgeving, laatst gewijzigd eerst.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ quoteId?: string, customerId?: string }} [filters] Alleen van die offerte; alleen van dat klantaccount, met de data erbij (het klantportaal toont daaruit de oplevering).
   * @returns {object[]} De werkorders.
   */
  function list(tenantId, { quoteId = null, customerId = null } = {}) {
    const args = [tenantId];
    let sql = `${LIST_SELECT} WHERE w.tenant_id = ? AND w.deleted_at IS NULL`;
    if (quoteId) { sql += ' AND w.quote_id = ?'; args.push(String(quoteId)); }
    if (customerId) { sql += OF_CUSTOMER; args.push(String(customerId), String(customerId)); }
    return prepare(`${sql} ORDER BY w.updated_at DESC`).all(...args).map((workOrderRow) => {
      const out = toWorkOrder(workOrderRow, false);
      if (customerId) out.data = JSON.parse(workOrderRow.data);
      return out;
    });
  }

  /**
   * Controle vooraf (bestaat, deze omgeving, niet verwijderd): alleen de
   * kolommen die de aanroeper nodig heeft.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de werkorder.
   * @param {string} [cols] De kolommen.
   * @returns {object|undefined} De rij.
   */
  const find = (tenantId, id, cols = 'id, tenant_id, status, assignee_id, share_hash') =>
    prepare(`SELECT ${cols} FROM work_orders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`).get(tenantId, String(id));
  /**
   * Leest een werkorder volledig (na een wijziging, zonder tenantcontrole).
   * @param {string} id Id van de werkorder.
   * @returns {object} De werkorder met data en klantlink.
   */
  const fullRow = (id) => toWorkOrder(prepare(`${SELECT} WHERE w.id = ?`).get(id), true);

  /**
   * Eén werkorder met data en klantlink (één query).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de werkorder.
   * @param {{ customerId?: string }} [options] Alleen als de werkorder bij dat klantaccount hoort.
   * @returns {object|null} De werkorder, of null.
   */
  function get(tenantId, id, { customerId = null } = {}) {
    const args = [tenantId, String(id)];
    let sql = `${SELECT} WHERE w.tenant_id = ? AND w.id = ? AND w.deleted_at IS NULL`;
    if (customerId) { sql += OF_CUSTOMER; args.push(String(customerId), String(customerId)); }
    const workOrderRow = prepare(sql).get(...args);
    return workOrderRow ? toWorkOrder(workOrderRow, true) : null;
  }

  /**
   * De offerte waaruit een werkorder ontstaat: bestaand, niet verwijderd, in deze omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de offerte.
   * @returns {object|null} id, number, status, planId en data, of null.
   */
  function quoteOf(tenantId, id) {
    const quoteRow = prepare('SELECT id, number, status, plan_id, data FROM quotes WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, String(id));
    return quoteRow ? { id: quoteRow.id, number: quoteRow.number, status: quoteRow.status, planId: quoteRow.plan_id, data: JSON.parse(quoteRow.data) } : null;
  }

  /**
   * Wat er op een dag gepland staat (startscherm van de installateur): elke
   * werkdag van een meerdaagse klus telt mee, gesorteerd op starttijd. Met
   * userId alleen de klussen van die uitvoerder; `next` is dan diens
   * eerstvolgende klus na deze dag. Geannuleerde werkorders vallen weg.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} date Datum als JJJJ-MM-DD.
   * @param {{ userId?: string, photoCounts?: object|Function }} [options] Alleen deze uitvoerder; fototelling per werkorder-id, of een functie (ids) => dat object zodat alleen de klussen van deze dag geteld worden.
   * @returns {{ date: string, items: object[], next: object|null }} De klussen van de dag en de volgende klus.
   */
  function day(tenantId, date, { userId = null, photoCounts = {} } = {}) {
    // Een klus van MAX_DAYS werkdagen beslaat hooguit zoveel kalenderdagen.
    const from = Core.addDays(date, -(Math.ceil(Core.MAX_DAYS * 7 / 5) + 2));
    const args = [tenantId, from, date];
    let sql = `${LIST_SELECT} WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.status <> 'geannuleerd'
      AND w.planned_date IS NOT NULL AND w.planned_date >= ? AND w.planned_date <= ?`;
    if (userId) { sql += ' AND w.assignee_id = ?'; args.push(String(userId)); }
    const items = [];
    for (const workOrderRow of prepare(sql).all(...args)) {
      const data = JSON.parse(workOrderRow.data);
      const days = Core.workDays(workOrderRow.planned_date, data.days || 1);
      const dayIndex = days.indexOf(date);
      if (dayIndex < 0) continue;
      const customer = data.customer || {};
      items.push({
        ...toWorkOrder(workOrderRow, false), dayNumber: dayIndex + 1, totalDays: days.length,
        contact: customer.contact || '', phone: customer.phone || '',
        instructions: data.instructions || '', siteNotes: data.siteNotes || '',
      });
    }
    const counts = typeof photoCounts === 'function' ? (items.length ? photoCounts(items.map((i) => i.id)) : {}) : photoCounts;
    for (const item of items) item.photos = counts[item.id] || 0;
    items.sort((left, right) => (left.startTime || '99').localeCompare(right.startTime || '99') || left.number.localeCompare(right.number));
    let next = null;
    if (userId) {
      const nextRow = prepare(`${LIST_SELECT} WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.status IN ('open', 'gepland', 'bezig')
        AND w.assignee_id = ? AND w.planned_date > ? ORDER BY w.planned_date, w.number LIMIT 1`).get(tenantId, String(userId), date);
      if (nextRow) next = toWorkOrder(nextRow, false);
    }
    return { date, items, next };
  }

  /**
   * Werkordernummer per tenant en jaar: WO-<jaar>-0001, oplopend; een nummer komt nooit terug.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} year Het jaar.
   * @returns {string} Het nieuwe nummer.
   */
  function nextNumber(tenantId, year) {
    const head = `${PREFIX}${year}-`;
    let max = 0;
    for (const numberRow of prepare('SELECT number FROM work_orders WHERE tenant_id = ? AND substr(number, 1, ?) = ?').all(tenantId, head.length, head)) {
      const sequence = Number(numberRow.number.slice(head.length));
      if (Number.isInteger(sequence) && sequence > max) max = sequence;
    }
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  /**
   * De losse kolommen van een werkorder uit de data.
   * @param {object} data De opgeschoonde werkorderdata.
   * @returns {{ title: string, customer: string, address: string, plannedDate: string|null }} De kolomwaarden.
   */
  const fields = (data) => ({
    title: data.title.trim() || 'Werkorder',
    customer: data.customer.name.trim(),
    address: data.customer.address.replace(/\s*\n\s*/g, ', ').trim(),
    plannedDate: data.plannedDate || null,
  });

  /**
   * Medewerkers aan wie een werkorder kan worden toegewezen: accounts met een
   * rol met het recht 'uitvoerder' (staffRoles, zie roles.js), in de
   * opgegeven tenants (één organisatie).
   * @param {string[]} tenantIds Ids van de tenants.
   * @returns {object[]} id, username, displayName en role.
   */
  function staff(tenantIds) {
    const ids = [...new Set(tenantIds)];
    const keys = staffRoles(ids[0]);
    if (!keys.length) return [];
    return prepare(`SELECT id, username, display_name, role FROM users WHERE tenant_id IN (${ids.map(() => '?').join(',')})
      AND kind = 'account' AND role IN (${keys.map(() => '?').join(',')}) AND disabled = 0 ORDER BY lower(display_name)`)
      .all(...ids, ...keys).map((account) => ({ id: account.id, username: account.username, displayName: account.display_name, role: account.role }));
  }

  /**
   * Nieuwe werkorder bij een offerte. Zonder data bouwt de server die zelf op
   * uit de offerteregels (zonder zone-indeling; die komt uit de browser, waar
   * de plannerbibliotheken geladen zijn). De koppeling met offerte en plan
   * komt altijd uit de offerte zelf.
   * @param {object} user Wie hem maakt (eigenaar).
   * @param {object} quote De offerte (quoteOf).
   * @param {object|undefined} rawData Werkorderdata uit de browser.
   * @param {{ assigneeId?: string|null }} [options] Uitvoerder.
   * @returns {object} De nieuwe werkorder.
   */
  function create(user, quote, rawData, { assigneeId = null } = {}) {
    const base = Core.fromQuote(quote).data;
    const data = rawData ? Core.sanitize(rawData) : base;
    data.quoteId = quote.id;
    data.quoteNumber = quote.number;
    data.planId = quote.planId || '';
    if (!data.customer.name) data.customer = base.customer;
    if (!data.title) data.title = base.title;
    const columns = fields(data);
    return transaction(db, () => {
      const id = crypto.randomUUID();
      const timestamp = currentTimestamp();
      const number = nextNumber(user.tenant_id, timestamp.slice(0, 4));
      prepare(`INSERT INTO work_orders (id, tenant_id, owner_id, quote_id, plan_id, number, status, title, customer, address, planned_date, assignee_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, user.tenant_id, user.id, quote.id, quote.planId || null, number, data.plannedDate ? 'gepland' : 'open',
          columns.title, columns.customer, columns.address, columns.plannedDate, assigneeId || null, JSON.stringify(data), timestamp, timestamp);
      return fullRow(id);
    });
  }

  /**
   * Werkorder zonder offerte: de kopie van een uitbestede opdracht in de
   * omgeving van de organisatie die hem heeft aangenomen (outsourcing.js), of
   * een klus uit een melding van een klant (service-requests.js). Draait
   * binnen de transactie van de aanroeper.
   * @param {object} user Wie hem maakt (eigenaar).
   * @param {object} rawData De werkorderdata.
   * @param {{ assigneeId?: string|null }} [options] Uitvoerder.
   * @returns {object} De nieuwe werkorder.
   */
  function createReceived(user, rawData, { assigneeId = null } = {}) {
    const data = Core.sanitize(rawData);
    data.quoteId = '';
    data.quoteNumber = '';
    data.planId = '';
    data.planTitle = '';
    const columns = fields(data);
    const id = crypto.randomUUID();
    const timestamp = currentTimestamp();
    const number = nextNumber(user.tenant_id, timestamp.slice(0, 4));
    prepare(`INSERT INTO work_orders (id, tenant_id, owner_id, quote_id, plan_id, number, status, title, customer, address, planned_date, assignee_id, data, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, user.tenant_id, user.id, number, data.plannedDate ? 'gepland' : 'open',
        columns.title, columns.customer, columns.address, columns.plannedDate, assigneeId || null, JSON.stringify(data), timestamp, timestamp);
    return fullRow(id);
  }

  /**
   * Slaat een werkorder op.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de werkorder.
   * @param {object|undefined} rawData Nieuwe data (undefined = ongewijzigd).
   * @param {string|undefined} status Nieuwe status (onbekend = ongewijzigd).
   * @param {string|null|undefined} assigneeId undefined = ongewijzigd, null = niemand.
   * @param {{ ifBase?: string|null }} [options] Alleen opslaan als de werkorder nog op die updatedAt staat (offline wijziging uit de wachtrij).
   * @returns {object|null} De werkorder, { conflict: true, current }, of null als hij niet bestaat.
   */
  function update(tenantId, id, rawData, status, assigneeId, { ifBase = null } = {}) {
    return transaction(db, () => {
      const existing = find(tenantId, id, 'id, status, assignee_id, data, updated_at');
      if (!existing) return null;
      if (ifBase && existing.updated_at !== ifBase) return { conflict: true, current: fullRow(existing.id) };
      const old = JSON.parse(existing.data);
      const data = rawData === undefined ? old : Core.sanitize(rawData);
      // De koppeling met offerte en plan ligt vast.
      data.quoteId = old.quoteId;
      data.quoteNumber = old.quoteNumber;
      data.planId = old.planId;
      const columns = fields(data);
      const newStatus = STATUSES.includes(status) ? status : existing.status;
      const assignee = assigneeId === undefined ? existing.assignee_id : assigneeId || null;
      prepare(`UPDATE work_orders SET status = ?, title = ?, customer = ?, address = ?, planned_date = ?, assignee_id = ?, data = ?, updated_at = ? WHERE id = ?`)
        .run(newStatus, columns.title, columns.customer, columns.address, columns.plannedDate, assignee, JSON.stringify(data), currentTimestamp(), existing.id);
      return fullRow(existing.id);
    });
  }

  /**
   * Inplannen vanuit de planning: datum, tijden, aantal dagen en uitvoerder,
   * zonder de rest van de werkorder mee te sturen. Een nieuwe werkorder met
   * een datum wordt Gepland; zonder datum gaat Gepland terug naar Nieuw.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de werkorder.
   * @param {{ plannedDate?: string, startTime?: string, endTime?: string, days?: number }} patch Alleen wat meekomt.
   * @param {string|null|undefined} assigneeId undefined = ongewijzigd, null = niemand.
   * @returns {object|null} De werkorder, of null.
   */
  function schedule(tenantId, id, patch, assigneeId) {
    return transaction(db, () => {
      const existing = find(tenantId, id, 'id, status, assignee_id, data');
      if (!existing) return null;
      const data = JSON.parse(existing.data);
      for (const key of ['plannedDate', 'startTime', 'endTime', 'days']) if (patch[key] !== undefined) data[key] = patch[key];
      const clean = Core.sanitize(data);
      Object.assign(data, { plannedDate: clean.plannedDate, startTime: clean.startTime, endTime: clean.endTime, days: clean.days });
      let newStatus = existing.status;
      if (data.plannedDate && newStatus === 'open') newStatus = 'gepland';
      if (!data.plannedDate && newStatus === 'gepland') newStatus = 'open';
      const assignee = assigneeId === undefined ? existing.assignee_id : assigneeId || null;
      prepare('UPDATE work_orders SET status = ?, planned_date = ?, assignee_id = ?, data = ?, updated_at = ? WHERE id = ?')
        .run(newStatus, data.plannedDate || null, assignee, JSON.stringify(data), currentTimestamp(), existing.id);
      return fullRow(existing.id);
    });
  }

  // ---------- Klantlink (afspraak) ----------
  /**
   * Maakt de afspraaklink (of houdt de bestaande en werkt alleen het adres bij).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de werkorder.
   * @param {string} url Adres van openbaar/afspraak.html.
   * @returns {{ workOrder?: object, error?: string }} De werkorder, of 'invalid_url'/'not_found'.
   */
  function share(tenantId, id, url) {
    const base = validShareBase(url, PAGE);
    if (!base) return { error: 'invalid_url' };
    return transaction(db, () => {
      const existing = find(tenantId, id);
      if (!existing) return { error: 'not_found' };
      if (existing.share_hash) {
        // Bestaande link houden (de klant heeft hem misschien al).
        prepare('UPDATE work_orders SET share_url = ? WHERE id = ?').run(base, existing.id);
      } else {
        const token = crypto.randomBytes(24).toString('base64url');
        prepare('UPDATE work_orders SET share_hash = ?, share_token = ?, share_url = ?, shared_at = ?, viewed_at = NULL WHERE id = ?')
          .run(sha256(token), vault.seal(token, tokenContext(existing)), base, currentTimestamp(), existing.id);
      }
      return { workOrder: fullRow(existing.id) };
    });
  }

  /**
   * Trekt de afspraaklink in.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de werkorder.
   * @returns {object|null} De werkorder, of null.
   */
  function unshare(tenantId, id) {
    const existing = find(tenantId, id);
    if (!existing) return null;
    prepare('UPDATE work_orders SET share_hash = NULL, share_token = NULL, shared_at = NULL WHERE id = ?').run(existing.id);
    return fullRow(existing.id);
  }

  /**
   * Legt vast dat de afspraak per mail is verstuurd.
   * @param {string} id Id van de werkorder.
   * @param {string} to De ontvangers.
   * @returns {void}
   */
  function markSent(id, to) {
    prepare('UPDATE work_orders SET sent_at = ?, sent_to = ? WHERE id = ?').run(currentTimestamp(), String(to).slice(0, 400), id);
  }

  /**
   * Zoeken op token (over alle tenants; het token is het enige geheim).
   * @param {string} token Het token uit de link.
   * @returns {object|null} Rij met PUBLIC_COLS, of null.
   */
  function byToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return prepare(`SELECT ${PUBLIC_COLS} FROM work_orders WHERE share_hash = ? AND deleted_at IS NULL`).get(sha256(token)) || null;
  }

  /**
   * Legt vast dat de klant de link voor het eerst heeft geopend.
   * @param {object} workOrderRow De rij (byToken).
   * @returns {void}
   */
  function markViewed(workOrderRow) {
    prepare('UPDATE work_orders SET viewed_at = COALESCE(viewed_at, ?) WHERE id = ?').run(currentTimestamp(), workOrderRow.id);
  }

  /**
   * De volledige URL van de afspraaklink.
   * @param {object} workOrderRow Rij met de share-kolommen.
   * @returns {string|null} De URL, of null.
   */
  const shareLink = (workOrderRow) => shareOf(workOrderRow).url;

  /**
   * Wat de klant via de link ziet: de afspraak, niet het uitvoeringsplan.
   * @param {object} workOrderRow De volledige rij (byToken, respond), dus niet opnieuw lezen.
   * @returns {object} Nummer, status, klant, adres, planning en de stand van de afspraak.
   */
  function publicView(workOrderRow) {
    const view = toWorkOrder(workOrderRow, false);
    const data = JSON.parse(workOrderRow.data);
    return {
      number: view.number, status: view.status, title: data.title, customer: data.customer.name, address: data.customer.address,
      plannedDate: data.plannedDate, startTime: data.startTime, endTime: data.endTime, days: data.days, dates: Core.workDays(data.plannedDate, data.days),
      quoteNumber: data.quoteNumber, appointment: view.appointment, today: today(),
    };
  }

  /**
   * Reactie van de klant op de afspraak: bevestigen of een ander moment
   * vragen (met toelichting). Alleen voor een geplande, nog niet uitgevoerde
   * klus die niet in het verleden ligt, en één keer per moment.
   * @param {object} workOrderRow De rij (byToken).
   * @param {string} answer 'bevestigd' of 'ander_moment'.
   * @param {{ name: string, reason?: string }} input Naam en toelichting.
   * @param {{ ip?: string, forwardedFor?: string, userAgent?: string, via?: string, userId?: string }} who Herkomst; via 'link' of 'account'.
   * @returns {object} { row } met de bijgewerkte rij, of { error }.
   */
  function respond(workOrderRow, answer, input, who) {
    if (!ANSWERS.includes(answer)) return { error: 'invalid', message: 'Kies bevestigen of een ander moment.' };
    const name = String(input.name || '').trim().slice(0, 120);
    const reason = String(input.reason || '').trim().slice(0, 1000);
    if (name.length < 2) return { error: 'invalid', message: 'Vul uw naam in.' };
    if (answer === 'ander_moment' && reason.length < 3) return { error: 'invalid', message: 'Laat weten welk moment u beter uitkomt.' };
    return transaction(db, () => {
      const latest = prepare(`SELECT ${PUBLIC_COLS} FROM work_orders WHERE id = ? AND deleted_at IS NULL`).get(workOrderRow.id);
      if (!latest) return { error: 'not_found' };
      const data = JSON.parse(latest.data);
      const moment = Core.moment(data);
      if (!moment.date || !['open', 'gepland'].includes(latest.status)) return { error: 'closed', status: latest.status };
      if (moment.date < today()) return { error: 'past' };
      if (appointmentOf(latest, data).response?.current) return { error: 'answered' };
      const log = parseLog(latest.appointment).slice(-49);
      log.push({
        answer, name, reason: answer === 'ander_moment' ? reason : '', at: currentTimestamp(), moment, via: who.via || 'link', userId: who.userId || null,
        ip: who.ip || '', forwardedFor: String(who.forwardedFor || '').slice(0, 100), userAgent: String(who.userAgent || '').slice(0, 300),
      });
      prepare('UPDATE work_orders SET appointment = ? WHERE id = ?').run(JSON.stringify(log), latest.id);
      return { row: prepare(`SELECT ${PUBLIC_COLS} FROM work_orders WHERE id = ?`).get(latest.id) };
    });
  }

  /**
   * Verwijdert een werkorder (zacht, deleted_at).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de werkorder.
   * @returns {boolean} true als hij bestond.
   */
  function remove(tenantId, id) {
    const existing = find(tenantId, id);
    if (!existing) return false;
    prepare('UPDATE work_orders SET deleted_at = ? WHERE id = ?').run(currentTimestamp(), existing.id);
    return true;
  }

  /**
   * Definitief wissen (AVG-verzoek): ook al verwijderde werkorders, met foto's, uren, materiaal, uitbesteding en reserveringen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de werkorder.
   * @returns {boolean} true als er iets is gewist.
   */
  function purge(tenantId, id) {
    return transaction(db, () => {
      prepare('DELETE FROM work_order_photos WHERE tenant_id = ? AND work_order_id = ?').run(tenantId, String(id));
      prepare('DELETE FROM work_order_hours WHERE tenant_id = ? AND work_order_id = ?').run(tenantId, String(id));
      prepare('DELETE FROM work_order_materials WHERE tenant_id = ? AND work_order_id = ?').run(tenantId, String(id));
      prepare('DELETE FROM work_order_offers WHERE tenant_id = ? AND work_order_id = ?').run(tenantId, String(id));
      prepare('DELETE FROM stock_reservations WHERE tenant_id = ? AND work_order_id = ?').run(tenantId, String(id));
      return prepare('DELETE FROM work_orders WHERE tenant_id = ? AND id = ?').run(tenantId, String(id)).changes > 0;
    });
  }

  return { list, get, day, quoteOf, staff, create, createReceived, update, schedule, share, unshare, markSent, byToken, markViewed, shareLink, publicView, respond, remove, purge, nextNumber };
}

/**
 * Laat een fout uit een async route-handler doorlopen naar Express.
 * @param {Function} handler De async handler.
 * @returns {Function} Middleware.
 */
const wrapAsync = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
/**
 * Een datum voluit, bijv. "dinsdag 3 november 2026".
 * @param {string} iso Datum als JJJJ-MM-DD.
 * @returns {string} De datum in woorden.
 */
const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' });

/**
 * De afspraak in woorden, bijv. "dinsdag 3 november 2026, 08:00–16:00 uur (2 werkdagen)".
 * @param {{ date: string, startTime?: string, endTime?: string, days?: number }} moment Het moment.
 * @returns {string} De tekst (leeg zonder datum).
 */
function momentText(moment) {
  if (!moment || !moment.date) return '';
  const time = moment.startTime ? `, ${moment.startTime}${moment.endTime ? `–${moment.endTime}` : ''} uur` : '';
  const days = moment.days > 1 ? ` (${moment.days} werkdagen, t/m ${longDate(Core.workDays(moment.date, moment.days).pop())})` : '';
  return `${longDate(moment.date)}${time}${days}`;
}

/**
 * API-routes voor werkorders. Alles achter het recht 'werkorders' (beheerder,
 * installateur); gegevens per omgeving via req.tenantId. De klantlink
 * (/api/public/appointment) is openbaar: de tenant volgt uit de werkorder bij het token.
 * @param {object} app De Express-app.
 * @param {object} ctx { workorders, staffTenantsOf(req), requireRight, requireAdmin, requireJson, audit, settingsOf(req), settingsForTenant(id), tenantActive(id), mailerFor(settings), remoteIp(req), publicLimiter }.
 * @returns {void}
 */
function registerWorkOrderRoutes(app, ctx) {
  const { workorders, requireRight, requireAdmin, requireJson, staffTenantsOf, audit } = ctx;
  // Kleurthema van de tenant voor de openbare pagina (CSS-variabelen).
  const themeOf = ctx.themeOf || (() => null);
  const settingsOf = ctx.settingsOf;
  const settingsForTenant = ctx.settingsForTenant;
  const tenantActive = ctx.tenantActive || (() => true);
  const mailerFor = ctx.mailerFor || ((settings) => createMailer(settings));
  const remoteIp = ctx.remoteIp || ((req) => req.socket?.remoteAddress || '');
  const publicLimiter = ctx.publicLimiter || ((req, res, next) => next());
  // Uitbesteed of aangenomen (outsourcing.js): per werkorder-id.
  const outsourcingOf = ctx.outsourcingOf || (() => ({}));
  /**
   * Na aanmaken, opslaan of verwijderen (voorraad: reserveren en afboeken).
   * Een fout daar mag het opslaan van de werkorder niet tegenhouden.
   * @param {object} req Het verzoek.
   * @param {string} id Id van de werkorder.
   * @returns {void}
   */
  const changed = (req, id) => {
    if (!ctx.onChange) return;
    try { ctx.onChange(tenantOf(req), id, req.user); } catch (error) { console.warn(`Voorraad bij werkorder ${id} niet bijgewerkt: ${error.message}`); }
  };
  const loggedOf = ctx.loggedOf || (() => ({}));
  const requireWo = requireRight('werkorders');
  // Inplannen en de afspraak met de klant (planning of de werkorder zelf).
  const requirePlanning = requireRight('planning');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Stuurt 404 terug.
   * @param {object} res Het antwoord.
   * @returns {void}
   */
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Werkorder niet gevonden.' });
  /**
   * Is de werkorderdata een object?
   * @param {*} data De invoer.
   * @returns {boolean} true als het een object is.
   */
  const validData = (data) => data && typeof data === 'object' && !Array.isArray(data);
  /**
   * Is de status leeg of bekend?
   * @param {*} status De invoer.
   * @returns {boolean} true als hij geldig is.
   */
  const validStatus = (status) => status === undefined || STATUSES.includes(status);

  /**
   * Controleert de gekozen uitvoerder.
   * @param {object} req Het verzoek.
   * @param {*} raw assigneeId uit de invoer.
   * @returns {{ value?: string|null, error?: boolean }} undefined = ongewijzigd, null = niemand, of een fout.
   */
  function assigneeOf(req, raw) {
    if (raw === undefined) return { value: undefined };
    if (raw === null || raw === '') return { value: null };
    return workorders.staff(staffTenantsOf(req)).some((member) => member.id === String(raw)) ? { value: String(raw) } : { error: true };
  }
  /**
   * Stuurt 400 terug: onbekende medewerker.
   * @param {object} res Het antwoord.
   * @returns {void}
   */
  const badAssignee = (res) => res.status(400).json({ error: 'invalid_assignee', message: 'Onbekende medewerker.' });

  // Medewerkers om een werkorder aan toe te wijzen.
  app.get('/api/workorder-staff', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: workorders.staff(staffTenantsOf(req)) });
  });

  // Startscherm: wat er vandaag (of ?date=JJJJ-MM-DD) gepland staat voor de
  // ingelogde medewerker; ?all=1 voor de hele ploeg.
  app.get('/api/my-day', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const date = req.query.date === undefined || req.query.date === '' ? today() : String(req.query.date);
    if (!Core.isDate(date)) return res.status(400).json({ error: 'invalid_date', message: 'Ongeldige datum.' });
    const all = req.query.all === '1';
    // Alleen de foto's van de klussen die op deze dag staan tellen.
    const photoCounts = ctx.photoCounts ? (ids) => ctx.photoCounts(tenantOf(req), ids) : {};
    res.json({ ...workorders.day(tenantOf(req), date, { userId: all ? null : req.user.id, photoCounts }), today: today(), all });
  });

  // Alle werkorders van de omgeving (de ploeg werkt samen); ?quote=<id> voor één offerte.
  app.get('/api/workorders', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const marks = outsourcingOf(tenantOf(req));
    // Geboekte uren en materiaalregels per werkorder (één query, zie worklog.js).
    const logged = loggedOf(tenantOf(req));
    res.json({ items: workorders.list(tenantOf(req), { quoteId: req.query.quote || null }).map((workOrder) => ({ ...workOrder, outsourcing: marks[workOrder.id] || null, logged: logged[workOrder.id] || null })) });
  });

  app.get('/api/workorders/:id', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const workOrder = workorders.get(tenantOf(req), req.params.id);
    if (!workOrder) return notFound(res);
    res.json({ ...workOrder, outsourcing: outsourcingOf(tenantOf(req))[workOrder.id] || null });
  });

  // Alleen vanuit een offerte met status akkoord.
  app.post('/api/workorders', requireJson, requireWo, (req, res) => {
    const { quoteId, data } = req.body || {};
    if (!quoteId || (data !== undefined && !validData(data))) return res.status(400).json({ error: 'invalid_workorder', message: 'Kies een offerte.' });
    const quote = workorders.quoteOf(tenantOf(req), quoteId);
    if (!quote) return res.status(404).json({ error: 'quote_not_found', message: 'Offerte niet gevonden.' });
    if (quote.status !== 'akkoord') return res.status(409).json({ error: 'not_accepted', message: 'Een werkorder kan alleen worden gemaakt van een offerte met status Akkoord.' });
    const assignee = assigneeOf(req, req.body.assigneeId);
    if (assignee.error) return badAssignee(res);
    const workOrder = workorders.create(req.user, quote, data, { assigneeId: assignee.value });
    audit(req, 'werkorder_aangemaakt', { workOrderId: workOrder.id, number: workOrder.number, quoteId: quote.id });
    changed(req, workOrder.id);
    res.status(201).json(workOrder);
  });

  app.put('/api/workorders/:id', requireJson, requireWo, (req, res) => {
    const { data, status } = req.body || {};
    if ((data !== undefined && !validData(data)) || !validStatus(status)) return res.status(400).json({ error: 'invalid_workorder', message: 'Ongeldige werkorder.' });
    const assignee = assigneeOf(req, req.body.assigneeId);
    if (assignee.error) return badAssignee(res);
    const workOrder = workorders.update(tenantOf(req), req.params.id, data, status, assignee.value, { ifBase: ifBaseOf(req) });
    if (!workOrder) return notFound(res);
    // Offline gemaakt terwijl een ander de werkorder wijzigde: de gebruiker kiest.
    if (workOrder.conflict) return res.status(409).json({ error: 'conflict', message: `Werkorder ${workOrder.current.number} is intussen door iemand anders gewijzigd.`, updatedAt: workOrder.current.updatedAt });
    changed(req, workOrder.id);
    res.json(workOrder);
  });

  // Inplannen vanuit de planning (alleen datum, tijden, dagen en uitvoerder).
  app.post('/api/workorders/:id/schedule', requireJson, requireWo, requirePlanning, (req, res) => {
    const body = req.body || {};
    const bad = (body.plannedDate !== undefined && body.plannedDate !== '' && !Core.isDate(body.plannedDate))
      || (body.startTime !== undefined && body.startTime !== '' && !Core.isTime(body.startTime))
      || (body.endTime !== undefined && body.endTime !== '' && !Core.isTime(body.endTime))
      || (body.days !== undefined && !(Number.isInteger(body.days) && body.days >= 1 && body.days <= Core.MAX_DAYS));
    if (bad) return res.status(400).json({ error: 'invalid_schedule', message: 'Ongeldige datum, tijd of aantal dagen.' });
    const assignee = assigneeOf(req, body.assigneeId);
    if (assignee.error) return badAssignee(res);
    const workOrder = workorders.schedule(tenantOf(req), req.params.id, body, assignee.value);
    if (!workOrder) return notFound(res);
    res.json(workOrder);
  });

  // ---------- Klantlink: de klant ziet en bevestigt de afspraak ----------
  app.post('/api/workorders/:id/share', requireJson, requireWo, requirePlanning, (req, res) => {
    const out = workorders.share(tenantOf(req), req.params.id, req.body?.url);
    if (out.error === 'invalid_url') return res.status(400).json({ error: 'invalid_url', message: 'Ongeldig adres voor de link.' });
    if (out.error) return notFound(res);
    audit(req, 'afspraaklink_gemaakt', { workOrderId: out.workOrder.id, number: out.workOrder.number });
    res.json(out.workOrder);
  });

  app.delete('/api/workorders/:id/share', requireWo, requirePlanning, (req, res) => {
    const workOrder = workorders.unshare(tenantOf(req), req.params.id);
    if (!workOrder) return notFound(res);
    audit(req, 'afspraaklink_ingetrokken', { workOrderId: workOrder.id, number: workOrder.number });
    res.json(workOrder);
  });

  // Afspraak per e-mail naar de klant, met de link (maakt die zo nodig aan).
  app.post('/api/workorders/:id/send', requireJson, requireWo, requirePlanning, wrapAsync(async (req, res) => {
    const { to, subject, message, url } = req.body || {};
    const list = String(to || '').split(/[,;\s]+/).filter(Boolean);
    if (!list.length || list.length > 5 || !list.every(validEmail)) return res.status(400).json({ error: 'invalid_to', message: 'Vul een of meer geldige e-mailadressen in.' });
    const current = workorders.get(tenantOf(req), req.params.id);
    if (!current) return notFound(res);
    if (!current.data.plannedDate) return res.status(409).json({ error: 'not_planned', message: 'Plan eerst een datum in.' });
    const settings = settingsOf(req);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return res.status(409).json({ error: 'not_configured', message: 'Er is geen mailserver ingesteld (Beheer → Integraties → E-mail).' });
    const shared = workorders.share(tenantOf(req), req.params.id, url);
    if (shared.error === 'invalid_url') return res.status(400).json({ error: 'invalid_url', message: 'Ongeldig adres voor de link.' });
    if (shared.error) return notFound(res);
    const workOrder = shared.workOrder;
    const profile = settings.get('quoteProfile');
    const text = String(message || '').slice(0, 5000);
    try {
      await mailer.send({
        to: list, replyTo: profile.email, bcc: copyTo(req.user),
        subject: String(subject || `Uw afspraak met ${profile.companyName}`).slice(0, 300),
        ...mailBody(profile, text.split(/\n{2,}/), { label: 'Afspraak bekijken en bevestigen', href: workOrder.share.url }),
      });
    } catch (error) {
      console.warn(`Afspraak ${workOrder.number} niet verstuurd: ${error.message}`);
      return res.status(502).json({ error: 'send_failed', message: `Versturen mislukt: ${error.message}` });
    }
    workorders.markSent(workOrder.id, list.join(', '));
    audit(req, 'afspraak_verstuurd', { workOrderId: workOrder.id, number: workOrder.number, recipients: list.length });
    res.json(workorders.get(tenantOf(req), workOrder.id));
  }));

  /**
   * Het token van de afspraaklink; komt in een kop mee (niet in de URL).
   * @param {object} req Het verzoek.
   * @returns {string} Het token.
   */
  const tokenOf = (req) => String(req.headers['x-afspraak-token'] || '');
  /**
   * De werkorder bij het token; stuurt zelf 404 als die er niet (meer) is.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {object|null} De rij, of null (antwoord al verstuurd).
   */
  function publicWorkOrder(req, res) {
    const workOrderRow = workorders.byToken(tokenOf(req));
    if (!workOrderRow || !tenantActive(workOrderRow.tenant_id)) {
      res.status(404).json({ error: 'not_found', message: 'Deze afspraak is niet (meer) beschikbaar. Neem contact op met de afzender.' });
      return null;
    }
    return workOrderRow;
  }
  /**
   * Contactgegevens van het bedrijf voor de openbare pagina.
   * @param {string} tenantId Id van de tenant.
   * @returns {object} companyName, phone, email en website.
   */
  const publicProfile = (tenantId) => {
    const profile = settingsForTenant(tenantId).get('quoteProfile');
    return { companyName: profile.companyName, phone: profile.phone, email: profile.email, website: profile.website };
  };

  app.get('/api/public/appointment', publicLimiter, (req, res) => {
    const workOrderRow = publicWorkOrder(req, res);
    if (!workOrderRow) return;
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.preview !== '1') workorders.markViewed(workOrderRow);
    res.json({ appointment: workorders.publicView(workOrderRow), profile: publicProfile(workOrderRow.tenant_id), theme: themeOf(workOrderRow.tenant_id) });
  });

  app.post('/api/public/appointment/respond', publicLimiter, requireJson, (req, res) => {
    const workOrderRow = publicWorkOrder(req, res);
    if (!workOrderRow) return;
    const answer = req.body?.answer;
    const out = workorders.respond(workOrderRow, answer, req.body || {}, {
      ip: remoteIp(req),
      forwardedFor: req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
      userAgent: req.headers['user-agent'] || '',
    });
    if (out.error === 'not_found') return res.status(404).json({ error: 'not_found', message: 'Deze afspraak is niet (meer) beschikbaar.' });
    if (out.error === 'answered') return res.status(409).json({ error: 'answered', message: 'U heeft al gereageerd op deze afspraak.' });
    if (out.error === 'past') return res.status(409).json({ error: 'past', message: 'Deze afspraak ligt in het verleden.' });
    if (out.error === 'closed') return res.status(409).json({ error: 'closed', message: out.status === 'geannuleerd' ? 'Deze afspraak is geannuleerd.' : 'Deze afspraak kan niet meer worden gewijzigd.' });
    if (out.error) return res.status(400).json({ error: 'invalid', message: out.message || 'Ongeldige invoer.' });
    audit(req, answer === 'bevestigd' ? 'afspraak_bevestigd' : 'afspraak_ander_moment', { workOrderId: workOrderRow.id, number: workOrderRow.number, via: 'link' }, null, workOrderRow.tenant_id);
    notifyResponse(workOrderRow.tenant_id, out.row);
    res.json({ appointment: workorders.publicView(out.row) });
  });

  /**
   * Bericht naar het bedrijf als de klant reageert (als er een mailserver is).
   * @param {string} tenantId Id van de tenant.
   * @param {object} row De bijgewerkte rij.
   * @returns {void}
   */
  function notifyResponse(tenantId, row) {
    const settings = settingsForTenant(tenantId);
    const mailer = mailerFor(settings);
    const profile = settings.get('quoteProfile');
    if (!mailer.configured() || !validEmail(profile.email)) return;
    const data = JSON.parse(row.data);
    const log = JSON.parse(row.appointment);
    const latest = log[log.length - 1];
    const when = momentText(latest.moment);
    const who = `${latest.name}${data.customer.name && data.customer.name !== latest.name ? ` (${data.customer.name})` : ''}`;
    const lines = latest.answer === 'bevestigd'
      ? [`${who} heeft de afspraak voor werkorder ${row.number} bevestigd: ${when}.`]
      : [`${who} vraagt een ander moment voor werkorder ${row.number} (nu gepland: ${when}).`, `Toelichting: ${latest.reason}`];
    mailer.send({ to: profile.email, subject: latest.answer === 'bevestigd' ? `Afspraak ${row.number} bevestigd` : `Afspraak ${row.number}: ander moment gevraagd`, ...mailBody(profile, lines, null) })
      .catch((error) => console.warn(`Bericht over afspraak ${row.number} niet verstuurd: ${error.message}`));
  }

  app.delete('/api/workorders/:id', requireWo, (req, res) => {
    if (!workorders.remove(tenantOf(req), req.params.id)) return notFound(res);
    changed(req, req.params.id);
    audit(req, 'werkorder_verwijderd', { workOrderId: req.params.id });
    res.json({ ok: true });
  });

  app.delete('/api/admin/workorders/:id', requireAdmin, (req, res) => {
    if (!workorders.purge(tenantOf(req), req.params.id)) return notFound(res);
    audit(req, 'werkorder_gewist', { workOrderId: req.params.id });
    res.json({ ok: true });
  });
}

module.exports = { createWorkOrderStore, registerWorkOrderRoutes, Core, momentText };
