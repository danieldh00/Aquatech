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
const crypto = require('crypto');
const { transaction } = require('./db');
const { createVault } = require('./vault');
const { createMailer, validEmail } = require('./mailer');
const { preferencesOf } = require('./store');

// Kopie (bcc) van een verstuurde mail naar de afzender, als die dat in Mijn
// profiel heeft aangezet en een e-mailadres heeft.
const copyTo = (user) => (user && preferencesOf(user).mailCopy && validEmail(user.email) ? user.email : undefined);
const { validShareBase, mailBody } = require('./quotes');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'werkorders', 'workorder-core.js'));

const STATUSES = Object.keys(Core.STATUSES);
const PREFIX = 'WO-';
const PAGE = 'afspraak.html';
const ANSWERS = ['bevestigd', 'ander_moment'];
const now = () => new Date().toISOString();
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const parseLog = (v) => {
  try { const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch { return []; }
};
// Vandaag in Nederland (de afspraken zijn lokale datums).
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

/**
 * Stand van de afspraak: de laatste reactie van de klant telt alleen als die
 * over het huidige moment (datum, tijden, dagen) ging; is de planning daarna
 * verschoven, dan moet de klant opnieuw bevestigen.
 */
function appointmentOf(r, data) {
  const log = parseLog(r.appointment);
  const last = log.length ? log[log.length - 1] : null;
  const cur = Core.moment(data);
  const current = Boolean(last && Core.momentKey(last.moment || {}) === Core.momentKey(cur));
  let state;
  if (!cur.date) state = 'geen';
  else if (current) state = last.answer;
  else state = r.share_hash ? 'wacht' : 'niet_gedeeld';
  const response = last ? { answer: last.answer, name: last.name, at: last.at, reason: last.reason || '', moment: last.moment, current } : null;
  return { state, response };
}

function createWorkOrderStore(db, { vault = createVault(), staffRoles = () => ['beheerder', 'installateur'] } = {}) {
  const q = (sql) => db.prepare(sql);
  const tokenCtx = (r) => `${r.tenant_id}:afspraaklink:${r.id}`;

  function shareOf(r) {
    let url = null;
    if (r.share_hash && r.share_token && r.share_url) {
      try { url = `${r.share_url}#t=${vault.open(r.share_token, tokenCtx(r))}`; } catch { url = null; }
    }
    return { active: Boolean(r.share_hash), url, sharedAt: r.shared_at || null, viewedAt: r.viewed_at || null, sentAt: r.sent_at || null, sentTo: r.sent_to || null };
  }

  function row(r, withData) {
    const data = JSON.parse(r.data);
    const out = {
      id: r.id, number: r.number, status: r.status, title: r.title, customer: r.customer, address: r.address,
      quoteId: r.quote_id || null, quoteNumber: data.quoteNumber || '', planId: r.plan_id || null,
      plannedDate: r.planned_date || '', startTime: data.startTime || '', endTime: data.endTime || '', days: data.days || 1,
      crew: data.crew || '',
      summary: Core.summary(data),
      assigneeId: r.assignee_id || null, assignee: r.assignee_id ? { id: r.assignee_id, displayName: r.assignee_name || '' } : null,
      appointment: appointmentOf(r, data),
      progress: Core.progress(data), createdAt: r.created_at, updatedAt: r.updated_at,
    };
    if (r.owner_name !== undefined) out.owner = { id: r.owner_id, displayName: r.owner_name };
    if (withData) {
      out.data = data;
      out.share = shareOf(r);
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
  // Werkorders van een klantaccount: via een niet-concept-offerte aan dat account.
  const OF_CUSTOMER = ` AND EXISTS (SELECT 1 FROM quotes qu WHERE qu.id = w.quote_id AND qu.tenant_id = w.tenant_id
    AND qu.deleted_at IS NULL AND qu.customer_id = ? AND qu.status <> 'concept')`;

  // customerId: alleen de werkorders van dat klantaccount, met de data erbij
  // (het klantportaal toont daaruit de oplevering).
  function list(tenantId, { quoteId = null, customerId = null } = {}) {
    const args = [tenantId];
    let sql = `${LIST_SELECT} WHERE w.tenant_id = ? AND w.deleted_at IS NULL`;
    if (quoteId) { sql += ' AND w.quote_id = ?'; args.push(String(quoteId)); }
    if (customerId) { sql += OF_CUSTOMER; args.push(String(customerId)); }
    return q(`${sql} ORDER BY w.updated_at DESC`).all(...args).map((r) => {
      const out = row(r, false);
      if (customerId) out.data = JSON.parse(r.data);
      return out;
    });
  }

  // Controle vooraf (bestaat, deze omgeving, niet verwijderd): alleen de
  // kolommen die de aanroeper nodig heeft.
  const find = (tenantId, id, cols = 'id, tenant_id, status, assignee_id, share_hash') =>
    q(`SELECT ${cols} FROM work_orders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`).get(tenantId, String(id));
  const fullRow = (id) => row(q(`${SELECT} WHERE w.id = ?`).get(id), true);

  // Eén query; customerId: alleen als de werkorder bij dat klantaccount hoort.
  function get(tenantId, id, { customerId = null } = {}) {
    const args = [tenantId, String(id)];
    let sql = `${SELECT} WHERE w.tenant_id = ? AND w.id = ? AND w.deleted_at IS NULL`;
    if (customerId) { sql += OF_CUSTOMER; args.push(String(customerId)); }
    const r = q(sql).get(...args);
    return r ? row(r, true) : null;
  }

  // De offerte waaruit een werkorder ontstaat: bestaand, niet verwijderd, in deze omgeving.
  function quoteOf(tenantId, id) {
    const r = q('SELECT id, number, status, plan_id, data FROM quotes WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, String(id));
    return r ? { id: r.id, number: r.number, status: r.status, planId: r.plan_id, data: JSON.parse(r.data) } : null;
  }

  /**
   * Wat er op een dag gepland staat (startscherm van de installateur): elke
   * werkdag van een meerdaagse klus telt mee, gesorteerd op starttijd. Met
   * userId alleen de klussen van die uitvoerder; `next` is dan diens
   * eerstvolgende klus na deze dag. Geannuleerde werkorders vallen weg.
   */
  // photoCounts: { werkorder-id: aantal } of een functie (ids) => dat object,
  // zodat alleen de foto's van de klussen van deze dag geteld worden.
  function day(tenantId, date, { userId = null, photoCounts = {} } = {}) {
    // Een klus van MAX_DAYS werkdagen beslaat hooguit zoveel kalenderdagen.
    const from = Core.addDays(date, -(Math.ceil(Core.MAX_DAYS * 7 / 5) + 2));
    const args = [tenantId, from, date];
    let sql = `${LIST_SELECT} WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.status <> 'geannuleerd'
      AND w.planned_date IS NOT NULL AND w.planned_date >= ? AND w.planned_date <= ?`;
    if (userId) { sql += ' AND w.assignee_id = ?'; args.push(String(userId)); }
    const items = [];
    for (const r of q(sql).all(...args)) {
      const data = JSON.parse(r.data);
      const days = Core.workDays(r.planned_date, data.days || 1);
      const idx = days.indexOf(date);
      if (idx < 0) continue;
      const c = data.customer || {};
      items.push({
        ...row(r, false), dayNumber: idx + 1, totalDays: days.length,
        contact: c.contact || '', phone: c.phone || '',
        instructions: data.instructions || '', siteNotes: data.siteNotes || '',
      });
    }
    const counts = typeof photoCounts === 'function' ? (items.length ? photoCounts(items.map((i) => i.id)) : {}) : photoCounts;
    for (const i of items) i.photos = counts[i.id] || 0;
    items.sort((a, b) => (a.startTime || '99').localeCompare(b.startTime || '99') || a.number.localeCompare(b.number));
    let next = null;
    if (userId) {
      const n = q(`${LIST_SELECT} WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.status IN ('open', 'gepland', 'bezig')
        AND w.assignee_id = ? AND w.planned_date > ? ORDER BY w.planned_date, w.number LIMIT 1`).get(tenantId, String(userId), date);
      if (n) next = row(n, false);
    }
    return { date, items, next };
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

  // Medewerkers aan wie een werkorder kan worden toegewezen: accounts met een
  // rol met het recht 'uitvoerder' (staffRoles, zie roles.js), in de
  // opgegeven tenants (één organisatie).
  function staff(tenantIds) {
    const ids = [...new Set(tenantIds)];
    const keys = staffRoles(ids[0]);
    if (!keys.length) return [];
    return q(`SELECT id, username, display_name, role FROM users WHERE tenant_id IN (${ids.map(() => '?').join(',')})
      AND kind = 'account' AND role IN (${keys.map(() => '?').join(',')}) AND disabled = 0 ORDER BY lower(display_name)`)
      .all(...ids, ...keys).map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role }));
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

  /**
   * Werkorder zonder offerte: de kopie van een uitbestede opdracht in de
   * omgeving van de organisatie die hem heeft aangenomen (outsourcing.js).
   * Draait binnen de transactie van de aanroeper (acceptatie).
   */
  function createReceived(user, rawData) {
    const data = Core.sanitize(rawData);
    data.quoteId = '';
    data.quoteNumber = '';
    data.planId = '';
    data.planTitle = '';
    const f = fields(data);
    const id = crypto.randomUUID();
    const ts = now();
    const number = nextNumber(user.tenant_id, ts.slice(0, 4));
    q(`INSERT INTO work_orders (id, tenant_id, owner_id, quote_id, plan_id, number, status, title, customer, address, planned_date, assignee_id, data, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
      .run(id, user.tenant_id, user.id, number, data.plannedDate ? 'gepland' : 'open',
        f.title, f.customer, f.address, f.plannedDate, JSON.stringify(data), ts, ts);
    return fullRow(id);
  }

  // assigneeId: undefined = ongewijzigd, null = niemand.
  function update(tenantId, id, rawData, status, assigneeId) {
    return transaction(db, () => {
      const r = find(tenantId, id, 'id, status, assignee_id, data');
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

  /**
   * Inplannen vanuit de planning: datum, tijden, aantal dagen en uitvoerder,
   * zonder de rest van de werkorder mee te sturen. Een nieuwe werkorder met
   * een datum wordt Gepland; zonder datum gaat Gepland terug naar Nieuw.
   * patch: { plannedDate, startTime, endTime, days } (alleen wat meekomt);
   * assigneeId: undefined = ongewijzigd, null = niemand.
   */
  function schedule(tenantId, id, patch, assigneeId) {
    return transaction(db, () => {
      const r = find(tenantId, id, 'id, status, assignee_id, data');
      if (!r) return null;
      const data = JSON.parse(r.data);
      for (const k of ['plannedDate', 'startTime', 'endTime', 'days']) if (patch[k] !== undefined) data[k] = patch[k];
      const clean = Core.sanitize(data);
      Object.assign(data, { plannedDate: clean.plannedDate, startTime: clean.startTime, endTime: clean.endTime, days: clean.days });
      let st = r.status;
      if (data.plannedDate && st === 'open') st = 'gepland';
      if (!data.plannedDate && st === 'gepland') st = 'open';
      const aid = assigneeId === undefined ? r.assignee_id : assigneeId || null;
      q('UPDATE work_orders SET status = ?, planned_date = ?, assignee_id = ?, data = ?, updated_at = ? WHERE id = ?')
        .run(st, data.plannedDate || null, aid, JSON.stringify(data), now(), r.id);
      return fullRow(r.id);
    });
  }

  // ---------- Klantlink (afspraak) ----------
  function share(tenantId, id, url) {
    const base = validShareBase(url, PAGE);
    if (!base) return { error: 'invalid_url' };
    return transaction(db, () => {
      const r = find(tenantId, id);
      if (!r) return { error: 'not_found' };
      if (r.share_hash) {
        // Bestaande link houden (de klant heeft hem misschien al).
        q('UPDATE work_orders SET share_url = ? WHERE id = ?').run(base, r.id);
      } else {
        const token = crypto.randomBytes(24).toString('base64url');
        q('UPDATE work_orders SET share_hash = ?, share_token = ?, share_url = ?, shared_at = ?, viewed_at = NULL WHERE id = ?')
          .run(sha256(token), vault.seal(token, tokenCtx(r)), base, now(), r.id);
      }
      return { workOrder: fullRow(r.id) };
    });
  }

  function unshare(tenantId, id) {
    const r = find(tenantId, id);
    if (!r) return null;
    q('UPDATE work_orders SET share_hash = NULL, share_token = NULL, shared_at = NULL WHERE id = ?').run(r.id);
    return fullRow(r.id);
  }

  function markSent(id, to) {
    q('UPDATE work_orders SET sent_at = ?, sent_to = ? WHERE id = ?').run(now(), String(to).slice(0, 400), id);
  }

  // Zoeken op token (over alle tenants; het token is het enige geheim).
  function byToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return q(`SELECT ${PUBLIC_COLS} FROM work_orders WHERE share_hash = ? AND deleted_at IS NULL`).get(sha256(token)) || null;
  }

  function markViewed(r) {
    q('UPDATE work_orders SET viewed_at = COALESCE(viewed_at, ?) WHERE id = ?').run(now(), r.id);
  }

  const shareLink = (r) => shareOf(r).url;

  // Wat de klant via de link ziet: de afspraak, niet het uitvoeringsplan.
  // r: de volledige rij (byToken, respond), dus niet opnieuw lezen.
  function publicView(r) {
    const w = row(r, false);
    const d = JSON.parse(r.data);
    return {
      number: w.number, status: w.status, title: d.title, customer: d.customer.name, address: d.customer.address,
      plannedDate: d.plannedDate, startTime: d.startTime, endTime: d.endTime, days: d.days, dates: Core.workDays(d.plannedDate, d.days),
      quoteNumber: d.quoteNumber, appointment: w.appointment, today: today(),
    };
  }

  /**
   * Reactie van de klant op de afspraak: bevestigen of een ander moment
   * vragen (met toelichting). Alleen voor een geplande, nog niet uitgevoerde
   * klus die niet in het verleden ligt, en één keer per moment.
   * who = { ip, forwardedFor, userAgent, via ('link' of 'account'), userId }.
   */
  function respond(r, answer, input, who) {
    if (!ANSWERS.includes(answer)) return { error: 'invalid', message: 'Kies bevestigen of een ander moment.' };
    const name = String(input.name || '').trim().slice(0, 120);
    const reason = String(input.reason || '').trim().slice(0, 1000);
    if (name.length < 2) return { error: 'invalid', message: 'Vul uw naam in.' };
    if (answer === 'ander_moment' && reason.length < 3) return { error: 'invalid', message: 'Laat weten welk moment u beter uitkomt.' };
    return transaction(db, () => {
      const cur = q(`SELECT ${PUBLIC_COLS} FROM work_orders WHERE id = ? AND deleted_at IS NULL`).get(r.id);
      if (!cur) return { error: 'not_found' };
      const data = JSON.parse(cur.data);
      const m = Core.moment(data);
      if (!m.date || !['open', 'gepland'].includes(cur.status)) return { error: 'closed', status: cur.status };
      if (m.date < today()) return { error: 'past' };
      if (appointmentOf(cur, data).response?.current) return { error: 'answered' };
      const log = parseLog(cur.appointment).slice(-49);
      log.push({
        answer, name, reason: answer === 'ander_moment' ? reason : '', at: now(), moment: m, via: who.via || 'link', userId: who.userId || null,
        ip: who.ip || '', forwardedFor: String(who.forwardedFor || '').slice(0, 100), userAgent: String(who.userAgent || '').slice(0, 300),
      });
      q('UPDATE work_orders SET appointment = ? WHERE id = ?').run(JSON.stringify(log), cur.id);
      return { row: q(`SELECT ${PUBLIC_COLS} FROM work_orders WHERE id = ?`).get(cur.id) };
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
      q('DELETE FROM work_order_offers WHERE tenant_id = ? AND work_order_id = ?').run(tenantId, String(id));
      q('DELETE FROM stock_reservations WHERE tenant_id = ? AND work_order_id = ?').run(tenantId, String(id));
      return q('DELETE FROM work_orders WHERE tenant_id = ? AND id = ?').run(tenantId, String(id)).changes > 0;
    });
  }

  return { list, get, day, quoteOf, staff, create, createReceived, update, schedule, share, unshare, markSent, byToken, markViewed, shareLink, publicView, respond, remove, purge, nextNumber };
}

const wrapAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' });

/** De afspraak in woorden, bijv. "dinsdag 3 november 2026, 08:00–16:00 uur (2 werkdagen)". */
function momentText(m) {
  if (!m || !m.date) return '';
  const time = m.startTime ? `, ${m.startTime}${m.endTime ? `–${m.endTime}` : ''} uur` : '';
  const days = m.days > 1 ? ` (${m.days} werkdagen, t/m ${longDate(Core.workDays(m.date, m.days).pop())})` : '';
  return `${longDate(m.date)}${time}${days}`;
}

/**
 * API-routes. ctx: { workorders, staffTenantsOf(req), requireRight,
 * requireAdmin, requireJson, audit, settingsOf(req), settingsForTenant(id),
 * tenantActive(id), mailerFor(settings), remoteIp(req), publicLimiter }.
 * Alles achter het recht 'werkorders' (beheerder, installateur); gegevens per
 * omgeving via req.tenantId. De klantlink (/api/public/appointment) is
 * openbaar: de tenant volgt uit de werkorder bij het token.
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
  // Na aanmaken, opslaan of verwijderen (voorraad: reserveren en afboeken).
  // Een fout daar mag het opslaan van de werkorder niet tegenhouden.
  const changed = (req, id) => {
    if (!ctx.onChange) return;
    try { ctx.onChange(tid(req), id, req.user); } catch (err) { console.warn(`Voorraad bij werkorder ${id} niet bijgewerkt: ${err.message}`); }
  };
  const requireWo = requireRight('werkorders');
  // Inplannen en de afspraak met de klant (planning of de werkorder zelf).
  const requirePlanning = requireRight('planning');
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

  // Startscherm: wat er vandaag (of ?date=JJJJ-MM-DD) gepland staat voor de
  // ingelogde medewerker; ?all=1 voor de hele ploeg.
  app.get('/api/my-day', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const date = req.query.date === undefined || req.query.date === '' ? today() : String(req.query.date);
    if (!Core.isDate(date)) return res.status(400).json({ error: 'invalid_date', message: 'Ongeldige datum.' });
    const all = req.query.all === '1';
    // Alleen de foto's van de klussen die op deze dag staan tellen.
    const photoCounts = ctx.photoCounts ? (ids) => ctx.photoCounts(tid(req), ids) : {};
    res.json({ ...workorders.day(tid(req), date, { userId: all ? null : req.user.id, photoCounts }), today: today(), all });
  });

  // Alle werkorders van de omgeving (de ploeg werkt samen); ?quote=<id> voor één offerte.
  app.get('/api/workorders', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const marks = outsourcingOf(tid(req));
    res.json({ items: workorders.list(tid(req), { quoteId: req.query.quote || null }).map((w) => ({ ...w, outsourcing: marks[w.id] || null })) });
  });

  app.get('/api/workorders/:id', requireWo, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const wo = workorders.get(tid(req), req.params.id);
    if (!wo) return notFound(res);
    res.json({ ...wo, outsourcing: outsourcingOf(tid(req))[wo.id] || null });
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
    changed(req, wo.id);
    res.status(201).json(wo);
  });

  app.put('/api/workorders/:id', requireJson, requireWo, (req, res) => {
    const { data, status } = req.body || {};
    if ((data !== undefined && !validData(data)) || !validStatus(status)) return res.status(400).json({ error: 'invalid_workorder', message: 'Ongeldige werkorder.' });
    const aid = assigneeOf(req, req.body.assigneeId);
    if (aid.error) return badAssignee(res);
    const wo = workorders.update(tid(req), req.params.id, data, status, aid.value);
    if (!wo) return notFound(res);
    changed(req, wo.id);
    res.json(wo);
  });

  // Inplannen vanuit de planning (alleen datum, tijden, dagen en uitvoerder).
  app.post('/api/workorders/:id/schedule', requireJson, requireWo, requirePlanning, (req, res) => {
    const b = req.body || {};
    const bad = (b.plannedDate !== undefined && b.plannedDate !== '' && !Core.isDate(b.plannedDate))
      || (b.startTime !== undefined && b.startTime !== '' && !Core.isTime(b.startTime))
      || (b.endTime !== undefined && b.endTime !== '' && !Core.isTime(b.endTime))
      || (b.days !== undefined && !(Number.isInteger(b.days) && b.days >= 1 && b.days <= Core.MAX_DAYS));
    if (bad) return res.status(400).json({ error: 'invalid_schedule', message: 'Ongeldige datum, tijd of aantal dagen.' });
    const aid = assigneeOf(req, b.assigneeId);
    if (aid.error) return badAssignee(res);
    const wo = workorders.schedule(tid(req), req.params.id, b, aid.value);
    if (!wo) return notFound(res);
    res.json(wo);
  });

  // ---------- Klantlink: de klant ziet en bevestigt de afspraak ----------
  app.post('/api/workorders/:id/share', requireJson, requireWo, requirePlanning, (req, res) => {
    const out = workorders.share(tid(req), req.params.id, req.body?.url);
    if (out.error === 'invalid_url') return res.status(400).json({ error: 'invalid_url', message: 'Ongeldig adres voor de link.' });
    if (out.error) return notFound(res);
    audit(req, 'afspraaklink_gemaakt', { workOrderId: out.workOrder.id, number: out.workOrder.number });
    res.json(out.workOrder);
  });

  app.delete('/api/workorders/:id/share', requireWo, requirePlanning, (req, res) => {
    const wo = workorders.unshare(tid(req), req.params.id);
    if (!wo) return notFound(res);
    audit(req, 'afspraaklink_ingetrokken', { workOrderId: wo.id, number: wo.number });
    res.json(wo);
  });

  // Afspraak per e-mail naar de klant, met de link (maakt die zo nodig aan).
  app.post('/api/workorders/:id/send', requireJson, requireWo, requirePlanning, wrapAsync(async (req, res) => {
    const { to, subject, message, url } = req.body || {};
    const list = String(to || '').split(/[,;\s]+/).filter(Boolean);
    if (!list.length || list.length > 5 || !list.every(validEmail)) return res.status(400).json({ error: 'invalid_to', message: 'Vul een of meer geldige e-mailadressen in.' });
    const current = workorders.get(tid(req), req.params.id);
    if (!current) return notFound(res);
    if (!current.data.plannedDate) return res.status(409).json({ error: 'not_planned', message: 'Plan eerst een datum in.' });
    const settings = settingsOf(req);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return res.status(409).json({ error: 'not_configured', message: 'Er is geen mailserver ingesteld (Beheer → Instellingen → E-mail).' });
    const shared = workorders.share(tid(req), req.params.id, url);
    if (shared.error === 'invalid_url') return res.status(400).json({ error: 'invalid_url', message: 'Ongeldig adres voor de link.' });
    if (shared.error) return notFound(res);
    const wo = shared.workOrder;
    const p = settings.get('quoteProfile');
    const text = String(message || '').slice(0, 5000);
    try {
      await mailer.send({
        to: list, replyTo: p.email, bcc: copyTo(req.user),
        subject: String(subject || `Uw afspraak met ${p.companyName}`).slice(0, 300),
        ...mailBody(p, text.split(/\n{2,}/), { label: 'Afspraak bekijken en bevestigen', href: wo.share.url }),
      });
    } catch (err) {
      console.warn(`Afspraak ${wo.number} niet verstuurd: ${err.message}`);
      return res.status(502).json({ error: 'send_failed', message: `Versturen mislukt: ${err.message}` });
    }
    workorders.markSent(wo.id, list.join(', '));
    audit(req, 'afspraak_verstuurd', { workOrderId: wo.id, number: wo.number, recipients: list.length });
    res.json(workorders.get(tid(req), wo.id));
  }));

  // De klant opent de link; het token komt in een kop mee (niet in de URL).
  const tokenOf = (req) => String(req.headers['x-afspraak-token'] || '');
  function publicWorkOrder(req, res) {
    const r = workorders.byToken(tokenOf(req));
    if (!r || !tenantActive(r.tenant_id)) {
      res.status(404).json({ error: 'not_found', message: 'Deze afspraak is niet (meer) beschikbaar. Neem contact op met de afzender.' });
      return null;
    }
    return r;
  }
  const publicProfile = (tenantId) => {
    const p = settingsForTenant(tenantId).get('quoteProfile');
    return { companyName: p.companyName, phone: p.phone, email: p.email, website: p.website };
  };

  app.get('/api/public/appointment', publicLimiter, (req, res) => {
    const r = publicWorkOrder(req, res);
    if (!r) return;
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.preview !== '1') workorders.markViewed(r);
    res.json({ appointment: workorders.publicView(r), profile: publicProfile(r.tenant_id), theme: themeOf(r.tenant_id) });
  });

  app.post('/api/public/appointment/respond', publicLimiter, requireJson, (req, res) => {
    const r = publicWorkOrder(req, res);
    if (!r) return;
    const answer = req.body?.answer;
    const out = workorders.respond(r, answer, req.body || {}, {
      ip: remoteIp(req),
      forwardedFor: req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
      userAgent: req.headers['user-agent'] || '',
    });
    if (out.error === 'not_found') return res.status(404).json({ error: 'not_found', message: 'Deze afspraak is niet (meer) beschikbaar.' });
    if (out.error === 'answered') return res.status(409).json({ error: 'answered', message: 'U heeft al gereageerd op deze afspraak.' });
    if (out.error === 'past') return res.status(409).json({ error: 'past', message: 'Deze afspraak ligt in het verleden.' });
    if (out.error === 'closed') return res.status(409).json({ error: 'closed', message: out.status === 'geannuleerd' ? 'Deze afspraak is geannuleerd.' : 'Deze afspraak kan niet meer worden gewijzigd.' });
    if (out.error) return res.status(400).json({ error: 'invalid', message: out.message || 'Ongeldige invoer.' });
    audit(req, answer === 'bevestigd' ? 'afspraak_bevestigd' : 'afspraak_ander_moment', { workOrderId: r.id, number: r.number, via: 'link' }, null, r.tenant_id);
    notifyResponse(r.tenant_id, out.row);
    res.json({ appointment: workorders.publicView(out.row) });
  });

  // Bericht naar het bedrijf als de klant reageert (als er een mailserver is).
  function notifyResponse(tenantId, row) {
    const settings = settingsForTenant(tenantId);
    const mailer = mailerFor(settings);
    const p = settings.get('quoteProfile');
    if (!mailer.configured() || !validEmail(p.email)) return;
    const data = JSON.parse(row.data);
    const log = JSON.parse(row.appointment);
    const a = log[log.length - 1];
    const when = momentText(a.moment);
    const who = `${a.name}${data.customer.name && data.customer.name !== a.name ? ` (${data.customer.name})` : ''}`;
    const lines = a.answer === 'bevestigd'
      ? [`${who} heeft de afspraak voor werkorder ${row.number} bevestigd: ${when}.`]
      : [`${who} vraagt een ander moment voor werkorder ${row.number} (nu gepland: ${when}).`, `Toelichting: ${a.reason}`];
    mailer.send({ to: p.email, subject: a.answer === 'bevestigd' ? `Afspraak ${row.number} bevestigd` : `Afspraak ${row.number}: ander moment gevraagd`, ...mailBody(p, lines, null) })
      .catch((err) => console.warn(`Bericht over afspraak ${row.number} niet verstuurd: ${err.message}`));
  }

  app.delete('/api/workorders/:id', requireWo, (req, res) => {
    if (!workorders.remove(tid(req), req.params.id)) return notFound(res);
    changed(req, req.params.id);
    audit(req, 'werkorder_verwijderd', { workOrderId: req.params.id });
    res.json({ ok: true });
  });

  app.delete('/api/admin/workorders/:id', requireAdmin, (req, res) => {
    if (!workorders.purge(tid(req), req.params.id)) return notFound(res);
    audit(req, 'werkorder_gewist', { workOrderId: req.params.id });
    res.json({ ok: true });
  });
}

module.exports = { createWorkOrderStore, registerWorkOrderRoutes, Core, momentText };
