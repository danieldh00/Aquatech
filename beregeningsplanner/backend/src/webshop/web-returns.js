// Retouren van bestellingen in de eigen webshop. De klant vraagt binnen 14 dagen
// na verzending een retour aan (regels, aantallen en reden); een beheerder keurt
// hem goed of wijst hem af, en zet hem op Afgerond als de artikelen terug zijn.
// Daarbij gaan de artikelen terug op voorraad (kind 'retour', bron
// retour:<nummer>) en maakt web-order-invoices.js de creditnota. Tabel
// web_returns (migratie 40); beheer via /api/admin/web-returns (Beheer >
// Retouren). Alles per omgeving (tenantId).
const crypto = require('crypto');
const { transaction, isPg } = require('../database/db');

/** Status van een retour met de tekst voor de klant en Beheer. */
const STATUSES = { aangevraagd: 'Aangevraagd', goedgekeurd: 'Goedgekeurd', afgewezen: 'Afgewezen', ingetrokken: 'Ingetrokken', afgerond: 'Afgerond' };
/** Welke status op welke mag volgen. */
const TRANSITIONS = { aangevraagd: ['goedgekeurd', 'afgewezen', 'ingetrokken'], goedgekeurd: ['afgerond'], afgewezen: [], ingetrokken: [], afgerond: [] };
/** De redenen die de klant kan kiezen. */
const REASONS = { niet_nodig: 'Niet meer nodig', verkeerd: 'Verkeerd besteld', defect: 'Defect of beschadigd', anders: 'Anders' };
/** Het aantal dagen na verzending waarbinnen een retour kan worden aangevraagd (herroepingstermijn). */
const RETURN_DAYS = 14;
/** Retouren die nog of al meetellen voor wat er van een bestelling terug kan. */
const COUNTING = ['aangevraagd', 'goedgekeurd', 'afgerond'];
/** Hoogstens zoveel retouren per pagina in Beheer. */
const PAGE_LIMIT = 200;
const COLUMNS = 'id, order_id, user_id, number, status, created_at, updated_at';

/**
 * Het huidige tijdstip als ISO-tekst.
 * @returns {string} Het tijdstip.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * Maakt een invoer tot getrimde tekst van hoogstens een bepaalde lengte.
 * @param {*} value De invoer.
 * @param {number} max Maximale lengte (tekens).
 * @returns {string} De opgeschoonde tekst.
 */
const clean = (value, max) => Array.from(String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, max).join('');

/**
 * Maakt de opslag voor retouren van webshopbestellingen.
 * @param {object} db De database.
 * @param {{ orders: object, stock: object }} deps De bestelopslag en de voorraadopslag (artikelen terugboeken).
 * @returns {{ returnableLines: Function, eligibility: Function, request: Function, withdraw: Function, decide: Function, complete: Function, get: Function, getForUser: Function, listForOrder: Function, list: Function, updateData: Function, onRequested: Function, onDecided: Function }} De functies.
 */
function createWebReturnStore(db, { orders, stock }) {
  const requestedHooks = [];
  const decidedHooks = [];
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Zet een rij om naar het formaat van de API.
   * @param {object} row De rij, met data.
   * @returns {object} De retour met regels, reden, afhandeling en verloop.
   */
  const shape = (row) => {
    const data = JSON.parse(row.data);
    return {
      id: row.id, orderId: row.order_id, userId: row.user_id || null, number: row.number, status: row.status, statusLabel: STATUSES[row.status] || row.status,
      createdAt: row.created_at, updatedAt: row.updated_at, orderNumber: data.orderNumber, customerName: data.customerName, email: data.email,
      lines: data.lines, reason: data.reason, reasonLabel: REASONS[data.reason] || '', note: data.note || '', decisionNote: data.decisionNote || '',
      restock: Boolean(data.restock), history: data.history, credit: data.credit || null, creditError: data.creditError || '', mail: data.mail || null,
    };
  };

  /**
   * Het moment waarop de bestelling is verzonden (laatste Verzonden in het verloop).
   * @param {object} order De bestelling.
   * @returns {string|null} Het tijdstip, of null als hij nog niet is verzonden.
   */
  function shippedAt(order) {
    const shipped = (order.history || []).filter((entry) => entry.status === 'verzonden');
    return shipped.length ? shipped[shipped.length - 1].at : null;
  }

  /**
   * Wat er van een bestelling nog terug kan: per regel het verzonden aantal
   * min wat in andere (lopende of afgeronde) retouren zit.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De bestelling (met regels).
   * @returns {{ itemId: string, code: string, name: string, unit: string, qty: number, unitExcl: number, vatRate: number }[]} De regels met een resterend aantal groter dan nul.
   */
  function returnableLines(tenantId, order) {
    if (!['verzonden', 'afgerond'].includes(order.status)) return [];
    const used = new Map();
    for (const row of prepare('SELECT status, data FROM web_returns WHERE tenant_id = ? AND order_id = ?').all(tenantId, order.id)) {
      if (!COUNTING.includes(row.status)) continue;
      for (const line of JSON.parse(row.data).lines) used.set(line.code, (used.get(line.code) || 0) + line.qty);
    }
    return order.lines
      .map((line) => ({ itemId: line.itemId, code: line.code, name: line.name, unit: line.unit, qty: line.qty - (used.get(line.code) || 0), unitExcl: line.unitExcl, vatRate: line.vatRate }))
      .filter((line) => line.qty > 0);
  }

  /**
   * Of er voor de bestelling nog een retour kan worden aangevraagd en wat er terug kan.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De bestelling (met regels en verloop).
   * @returns {{ shipped: boolean, open: boolean, until: ?string, lines: object[] }} shipped: de bestelling is verzonden; open: binnen de termijn; until: laatste moment; lines: wat er nog terug kan (leeg buiten de termijn).
   */
  function eligibility(tenantId, order) {
    const sent = ['verzonden', 'afgerond'].includes(order.status) ? shippedAt(order) : null;
    if (!sent) return { shipped: false, open: false, until: null, lines: [] };
    const until = new Date(new Date(sent).getTime() + RETURN_DAYS * 86400000).toISOString();
    const open = Date.now() <= new Date(until).getTime();
    return { shipped: true, open, until, lines: open ? returnableLines(tenantId, order) : [] };
  }

  /**
   * Volgnummer van de retour: <bestelnummer>-R1, -R2 enzovoort.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De bestelling.
   * @returns {string} Het nummer.
   */
  function nextNumber(tenantId, order) {
    const count = prepare('SELECT COUNT(*) AS total FROM web_returns WHERE tenant_id = ? AND order_id = ?').get(tenantId, order.id).total;
    return `${order.number}-R${Number(count) + 1}`;
  }

  /**
   * Vergrendelt de bestelling tot het einde van de transactie (PostgreSQL), zodat twee gelijktijdige aanvragen niet samen meer terugsturen dan er is verzonden.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @returns {void}
   */
  function lockOrder(tenantId, orderId) {
    if (isPg(db)) prepare('SELECT id FROM web_orders WHERE tenant_id = ? AND id = ? FOR UPDATE').get(tenantId, orderId);
  }

  /**
   * Leest een retour voor een wijziging; onder PostgreSQL met een rijslot tot het einde van de transactie.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de retour.
   * @returns {object|undefined} De rij, met data.
   */
  function readForUpdate(tenantId, id) {
    return prepare(`SELECT ${COLUMNS}, data FROM web_returns WHERE tenant_id = ? AND id = ?${isPg(db) ? ' FOR UPDATE' : ''}`).get(tenantId, String(id));
  }

  /**
   * Een klant vraagt een retour aan voor (een deel van) zijn eigen bestelling.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, display_name?: string, displayName?: string }} user De klant.
   * @param {string} orderId Id van de bestelling.
   * @param {{ lines?: { code: string, qty: * }[], reason?: string, note?: string }} raw De gekozen regels, de reden en een toelichting.
   * @returns {{ return?: object, error?: string, status?: number }} De aangevraagde retour of een foutmelding.
   */
  function request(tenantId, user, orderId, raw) {
    const result = transaction(db, () => {
      const order = orders.getForUser(tenantId, user.id, orderId);
      if (!order) return { error: 'Bestelling niet gevonden.', status: 404 };
      lockOrder(tenantId, order.id);
      const eligible = eligibility(tenantId, order);
      if (!eligible.shipped) return { error: 'Een retour kan pas als de bestelling is verzonden.', status: 409 };
      if (!eligible.open) return { error: `Een retour moet binnen ${RETURN_DAYS} dagen na verzending worden aangevraagd.`, status: 409 };
      const reason = REASONS[raw && raw.reason] ? raw.reason : null;
      if (!reason) return { error: 'Kies een reden voor de retour.', status: 400 };
      const available = new Map(eligible.lines.map((line) => [line.code, line]));
      const wanted = new Map();
      for (const entry of Array.isArray(raw && raw.lines) ? raw.lines : []) {
        const qty = Math.floor(Number(entry && entry.qty));
        if (!(qty > 0)) continue;
        wanted.set(String(entry.code || ''), (wanted.get(String(entry.code || '')) || 0) + qty);
      }
      if (!wanted.size) return { error: 'Kies minstens één artikel om terug te sturen.', status: 400 };
      const lines = [];
      for (const [code, qty] of wanted) {
        const line = available.get(code);
        if (!line) return { error: `Artikel ${code} kan niet (meer) terug.`, status: 409 };
        if (qty > line.qty) return { error: `Van ${line.name} kunnen nog ${line.qty} terug.`, status: 409 };
        lines.push({ ...line, qty });
      }
      const timestamp = currentTimestamp();
      const id = crypto.randomUUID();
      const data = {
        orderNumber: order.number, customerName: order.customer.company || order.customer.name, email: order.email, lines, reason, note: clean(raw.note, 1000),
        history: [{ at: timestamp, status: 'aangevraagd', by: order.customer.name }],
      };
      const number = nextNumber(tenantId, order);
      prepare('INSERT INTO web_returns (id, tenant_id, order_id, user_id, number, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, tenantId, order.id, user.id, number, 'aangevraagd', JSON.stringify(data), timestamp, timestamp);
      return { return: get(tenantId, id) };
    });
    if (result.return) runHooks(requestedHooks, tenantId, result.return);
    return result;
  }

  /**
   * Roept haken aan zonder dat een fout de wijziging terugdraait.
   * @param {Function[]} hooks De haken.
   * @param {...*} args De argumenten voor elke haak.
   * @returns {void}
   */
  function runHooks(hooks, ...args) {
    for (const hook of hooks) {
      try { Promise.resolve(hook(...args)).catch((error) => console.warn(`Na retour: ${error.message}`)); } catch (error) { console.warn(`Na retour: ${error.message}`); }
    }
  }

  /**
   * Leest één retour.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de retour.
   * @returns {object|null} De retour, of null.
   */
  function get(tenantId, id) {
    const row = prepare(`SELECT ${COLUMNS}, data FROM web_returns WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));
    return row ? shape(row) : null;
  }

  /**
   * Eén retour van een klant (een ander account krijgt niets).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} userId Id van de klant.
   * @param {string} id Id van de retour.
   * @returns {object|null} De retour, of null.
   */
  function getForUser(tenantId, userId, id) {
    const row = prepare(`SELECT ${COLUMNS}, data FROM web_returns WHERE tenant_id = ? AND user_id = ? AND id = ?`).get(tenantId, String(userId), String(id));
    return row ? shape(row) : null;
  }

  /**
   * De retouren van één bestelling, oudste eerst.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @returns {object[]} De retouren.
   */
  function listForOrder(tenantId, orderId) {
    return prepare(`SELECT ${COLUMNS}, data FROM web_returns WHERE tenant_id = ? AND order_id = ? ORDER BY created_at, number`).all(tenantId, String(orderId)).map(shape);
  }

  /**
   * Retouren voor Beheer, nieuwste eerst.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ status?: string, limit?: number, offset?: number }} [filters] Alleen deze status en de pagina.
   * @returns {{ items: object[], total: number }} De retouren van deze pagina en het totaal aantal.
   */
  function list(tenantId, { status = '', limit = 50, offset = 0 } = {}) {
    const size = Math.min(PAGE_LIMIT, Math.max(1, Math.floor(Number(limit)) || 50));
    const start = Math.max(0, Math.floor(Number(offset)) || 0);
    const where = STATUSES[status] ? ' AND status = ?' : '';
    const params = STATUSES[status] ? [tenantId, status] : [tenantId];
    const total = prepare(`SELECT COUNT(*) AS total FROM web_returns WHERE tenant_id = ?${where}`).get(...params).total;
    const items = prepare(`SELECT ${COLUMNS}, data FROM web_returns WHERE tenant_id = ?${where} ORDER BY created_at DESC, number DESC LIMIT ? OFFSET ?`).all(...params, size, start).map(shape);
    return { items, total: Number(total) };
  }

  /**
   * Legt een nieuwe status vast in één transactie.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de retour.
   * @param {string} status De nieuwe status.
   * @param {object|null} user Wie de status wijzigt.
   * @param {(row: object, data: object) => void} [apply] Past de data of de voorraad aan binnen dezelfde transactie.
   * @param {string|null} [onlyUserId] Alleen als de retour van deze klant is.
   * @returns {{ return?: object, error?: string, status?: number }} De bijgewerkte retour of een foutmelding.
   */
  function move(tenantId, id, status, user, apply = null, onlyUserId = null) {
    return transaction(db, () => {
      const row = readForUpdate(tenantId, id);
      if (!row || (onlyUserId && row.user_id !== onlyUserId)) return { error: 'Retour niet gevonden.', status: 404 };
      if (!TRANSITIONS[row.status].includes(status)) return { error: `Een retour met status ${STATUSES[row.status]} kan niet naar ${STATUSES[status]}.`, status: 409 };
      const data = JSON.parse(row.data);
      const timestamp = currentTimestamp();
      if (apply) apply(row, data);
      data.history.push({ at: timestamp, status, by: user ? user.display_name || user.displayName || '' : data.customerName });
      prepare('UPDATE web_returns SET status = ?, data = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(status, JSON.stringify(data), timestamp, tenantId, row.id);
      return { return: get(tenantId, row.id) };
    });
  }

  /**
   * De klant trekt een aangevraagde retour in.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, display_name?: string, displayName?: string }} user De klant.
   * @param {string} id Id van de retour.
   * @returns {{ return?: object, error?: string, status?: number }} De ingetrokken retour of een foutmelding.
   */
  function withdraw(tenantId, user, id) {
    return move(tenantId, id, 'ingetrokken', user, null, user.id);
  }

  /**
   * Een beheerder keurt een aangevraagde retour goed of wijst hem af.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de retour.
   * @param {boolean} approve Goedkeuren (true) of afwijzen (false).
   * @param {string} note Toelichting voor de klant (verplicht bij afwijzen).
   * @param {object|null} user De beheerder.
   * @returns {{ return?: object, error?: string, status?: number }} De bijgewerkte retour of een foutmelding.
   */
  function decide(tenantId, id, approve, note, user) {
    const text = clean(note, 1000);
    if (!approve && !text) return { error: 'Geef een reden voor de afwijzing.', status: 400 };
    const out = move(tenantId, id, approve ? 'goedgekeurd' : 'afgewezen', user, (row, data) => { data.decisionNote = text; });
    if (out.return) runHooks(decidedHooks, tenantId, out.return);
    return out;
  }

  /**
   * De artikelen zijn terug: de retour wordt afgerond en, als gevraagd, gaan de artikelen terug op voorraad.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de retour.
   * @param {boolean} restock Artikelen terugboeken op voorraad (niet bij beschadigd).
   * @param {object|null} user De beheerder.
   * @returns {{ return?: object, error?: string, status?: number }} De afgeronde retour of een foutmelding.
   */
  function complete(tenantId, id, restock, user) {
    const out = move(tenantId, id, 'afgerond', user, (row, data) => {
      data.restock = Boolean(restock);
      if (!restock) return;
      const known = new Set(prepare(`SELECT id FROM stock_items WHERE tenant_id = ? AND id IN (${data.lines.map(() => '?').join(', ')})`).all(tenantId, ...data.lines.map((line) => line.itemId)).map((item) => item.id));
      for (const line of data.lines) {
        if (known.has(line.itemId)) stock.book(tenantId, line.itemId, line.qty, { kind: 'retour', source: `retour:${row.number}`, note: `Retour ${row.number}`, user });
      }
    });
    return out;
  }

  /**
   * Bewaart een uitkomst bij de retour (de creditnota of de uitkomst van een mail).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de retour.
   * @param {object} patch Velden die in de data worden bijgewerkt.
   * @returns {void}
   */
  function updateData(tenantId, id, patch) {
    transaction(db, () => {
      const row = readForUpdate(tenantId, id);
      if (!row) return;
      prepare('UPDATE web_returns SET data = ? WHERE tenant_id = ? AND id = ?').run(JSON.stringify({ ...JSON.parse(row.data), ...patch }), tenantId, row.id);
    });
  }

  /**
   * Registreert een haak die na een nieuwe aanvraag wordt aangeroepen.
   * @param {Function} hook Functie (tenantId, retour); fouten worden alleen gelogd.
   * @returns {void}
   */
  const onRequested = (hook) => { requestedHooks.push(hook); };
  /**
   * Registreert een haak die na goedkeuren of afwijzen wordt aangeroepen.
   * @param {Function} hook Functie (tenantId, retour); fouten worden alleen gelogd.
   * @returns {void}
   */
  const onDecided = (hook) => { decidedHooks.push(hook); };
  return { returnableLines, eligibility, request, withdraw, decide, complete, get, getForUser, listForOrder, list, updateData, onRequested, onDecided };
}

/**
 * Registreert de API-routes van Beheer voor retouren (recht `beheer`, door de
 * poort van /api/admin; alles per omgeving van de beheerder).
 * @param {object} app De Express-app.
 * @param {{ returns: object, requireJson: Function, audit: Function, credits?: object, mail?: object }} ctx De opslag en hulpfuncties van de server; met credits (web-order-invoices.js) maakt Beheer de creditnota en met mail (web-returns-mail.js) krijgt de klant bericht als de retour is afgerond.
 * @returns {void}
 */
function registerWebReturnRoutes(app, { returns, requireJson, audit, credits = null, mail = null }) {
  const sendingCompletion = new Set();
  /**
   * Geeft een afwijzing van een async handler door aan Express.
   * @param {Function} handler De async handler (req, res).
   * @returns {Function} De handler voor Express.
   */
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  app.get('/api/admin/web-returns', (req, res) => {
    res.json({ ...returns.list(req.tenantId, { status: String(req.query.status || ''), limit: req.query.limit, offset: req.query.offset }), statuses: STATUSES });
  });

  app.get('/api/admin/web-returns/:id', (req, res) => {
    const found = returns.get(req.tenantId, req.params.id);
    if (!found) return res.status(404).json({ error: 'not_found', message: 'Retour niet gevonden.' });
    res.json({ return: found });
  });

  app.post('/api/admin/web-returns/:id/decision', requireJson, (req, res) => {
    const approve = req.body?.approve === true;
    const out = returns.decide(req.tenantId, req.params.id, approve, String(req.body?.note || ''), req.user);
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid_decision', message: out.error });
    audit(req, approve ? 'webshop_retour_goedgekeurd' : 'webshop_retour_afgewezen', { number: out.return.number });
    res.json({ return: out.return });
  });

  app.post('/api/admin/web-returns/:id/complete', requireJson, wrap(async (req, res) => {
    const out = returns.complete(req.tenantId, req.params.id, req.body?.restock !== false, req.user);
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid_complete', message: out.error });
    audit(req, 'webshop_retour_afgerond', { number: out.return.number, restock: out.return.restock });
    const credited = credits ? await credits.creditReturn(req.tenantId, out.return.id, req.user) : null;
    const finished = returns.get(req.tenantId, out.return.id);
    if (mail) mail.sendCompleted(req.tenantId, finished).catch((error) => console.warn(`Na retour: ${error.message}`));
    res.json({ return: finished, credit: credited });
  }));

  app.post('/api/admin/web-returns/:id/completion-mail', requireJson, wrap(async (req, res) => {
    if (!mail) return res.status(404).json({ error: 'not_found', message: 'E-mail staat niet aan.' });
    const found = returns.get(req.tenantId, req.params.id);
    if (!found) return res.status(404).json({ error: 'not_found', message: 'Retour niet gevonden.' });
    if (found.status !== 'afgerond') return res.status(409).json({ error: 'not_completed', message: 'Rond de retour eerst af.' });
    if (found.mail && found.mail.kind === 'afgerond' && found.mail.sent) return res.status(409).json({ error: 'already_sent', message: 'De mail over de afgeronde retour is al verstuurd.' });
    // Eén verzendpoging tegelijk per retour: de database is synchroon en dit is één proces, dus een set is genoeg als claim.
    const claim = `${req.tenantId}:${found.id}`;
    if (sendingCompletion.has(claim)) return res.status(409).json({ error: 'in_progress', message: 'De mail wordt al verstuurd.' });
    sendingCompletion.add(claim);
    try { await mail.sendCompleted(req.tenantId, found); } finally { sendingCompletion.delete(claim); }
    const updated = returns.get(req.tenantId, found.id);
    if (!updated.mail || updated.mail.kind !== 'afgerond' || !updated.mail.sent) return res.status(502).json({ error: 'mail_failed', message: (updated.mail && updated.mail.kind === 'afgerond' && updated.mail.error) || 'Versturen mislukt.' });
    res.json({ return: updated });
  }));

  app.post('/api/admin/web-returns/:id/credit', requireJson, wrap(async (req, res) => {
    if (!credits) return res.status(404).json({ error: 'not_found', message: 'Facturen staan niet aan.' });
    const found = returns.get(req.tenantId, req.params.id);
    if (!found) return res.status(404).json({ error: 'not_found', message: 'Retour niet gevonden.' });
    if (found.status !== 'afgerond') return res.status(409).json({ error: 'not_completed', message: 'Maak de creditnota nadat de retour is afgerond.' });
    const out = await credits.creditReturn(req.tenantId, found.id, req.user);
    if (out.error) return res.status(out.status || 400).json({ error: 'credit_failed', message: out.error });
    res.json({ return: returns.get(req.tenantId, found.id), credit: out });
  }));
}

module.exports = { createWebReturnStore, registerWebReturnRoutes, STATUSES, TRANSITIONS, REASONS, RETURN_DAYS };
