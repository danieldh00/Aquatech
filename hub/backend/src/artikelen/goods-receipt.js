// Goederenontvangst in de orderpick-app: het magazijn kiest een bestelde inkooporder (of scant het ordernummer, de leveranciersreferentie of een
// artikel), scant de artikelen en bevestigt de aantallen. Boeken gaat via `purchaseOrders.receive` (voorraad, FIFO-laag met de inkoopprijs van de
// regel, deelontvangst); daarna worden backorders van webshopbestellingen die nu leverbaar zijn vrijgegeven (Te picken).
// De magazijnmedewerker krijgt bewust geen prijzen, bedragen of leveranciersvoorwaarden te zien, alleen wat nodig is om te tellen en te scannen.
// Alles loopt per omgeving (tenant); de aantallen en wat de medewerker eerder zag worden op de server gecontroleerd.

const { createRateLimiter } = require('../beveiliging/rate-limit');

const RECEIVABLE = ['besteld', 'deels_ontvangen'];
const MAX_LINES = 500;
const MAX_QTY = 1000000;
const MAX_LOOKUP = 20;
const CHUNK = 200;

/**
 * Rondt een aantal af op drie decimalen (zoals de voorraad rekent).
 * @param {number} value Het aantal.
 * @returns {number} Het afgeronde aantal.
 */
const round3 = (value) => Math.round(value * 1000) / 1000;

/**
 * Maakt een gescande of ingetypte code vergelijkbaar: stuurtekens weg, spaties aan de rand weg, hoofdletters.
 * @param {*} value De code.
 * @returns {string} De code (leeg als er niets bruikbaars staat).
 */
function normalizeScan(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().toUpperCase().slice(0, 80);
}

/**
 * Sorteert regels op magazijnlocatie (natuurlijke volgorde); regels zonder locatie en regels die klaar zijn komen onderaan.
 * @param {{ location: string, name: string, openQty: number }} left De ene regel.
 * @param {{ location: string, name: string, openQty: number }} right De andere regel.
 * @returns {number} Negatief, nul of positief.
 */
function byLocationOpenFirst(left, right) {
  const leftDone = Number(left.openQty <= 0);
  const rightDone = Number(right.openQty <= 0);
  if (leftDone !== rightDone) return leftDone - rightDone;
  if (left.location && !right.location) return -1;
  if (!left.location && right.location) return 1;
  return left.location.localeCompare(right.location, 'nl', { numeric: true }) || left.name.localeCompare(right.name, 'nl');
}

/**
 * Maakt de opslag voor goederenontvangst.
 * @param {object} db De database.
 * @param {{ purchaseOrders: object, release: Function }} deps De inkooporders (artikelen/purchase-orders.js) en `release(tenantId, itemIds)`, dat backorders vrijgeeft en de nu vrijgegeven bestellingen teruggeeft.
 * @returns {{ list: Function, detail: Function, lookup: Function, receive: Function }} De functies.
 */
function createGoodsReceipt(db, { purchaseOrders, release }) {
  /**
   * Leest locatie, EAN en code van artikelen (één query per 200 artikelen).
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} itemIds De artikel-id's.
   * @returns {Map<string, { ean: string, code: string, location: string }>} Per artikel-id de gegevens.
   */
  function scanData(tenantId, itemIds) {
    const items = new Map();
    for (let start = 0; start < itemIds.length; start += CHUNK) {
      const chunk = itemIds.slice(start, start + CHUNK);
      const marks = chunk.map(() => '?').join(', ');
      for (const row of db.prepare(`SELECT id, code, ean, location FROM stock_items WHERE tenant_id = ? AND id IN (${marks})`).all(tenantId, ...chunk)) {
        items.set(String(row.id), { ean: String(row.ean || ''), code: String(row.code || ''), location: String(row.location || '') });
      }
    }
    return items;
  }

  /**
   * De samenvatting van een order voor de lijst, zonder bedragen.
   * @param {object} order Een order uit purchaseOrders.list of purchaseOrders.get.
   * @param {number} lineCount Het aantal regels.
   * @returns {object} id, nummer, leverancier, referentie, verwachte datum, aantal regels, nog te ontvangen stuks en of er al iets is ontvangen.
   */
  const summaryOf = (order, lineCount) => ({
    id: order.id, number: order.number, supplierName: order.supplierName, supplierReference: order.supplierReference || '',
    expectedDate: order.expectedDate || '', orderedAt: order.orderedAt || '', lineCount, openQty: order.openQty, partial: order.status === 'deels_ontvangen',
  });

  /**
   * De bestelde orders die ontvangen kunnen worden: eerst de orders met de vroegste verwachte datum, daarna de rest op besteldatum.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ items: object[] }} De orders (zonder prijzen).
   */
  function list(tenantId) {
    const orders = RECEIVABLE.flatMap((status) => purchaseOrders.list(tenantId, { status }));
    orders.sort((left, right) => {
      const leftDate = left.expectedDate || '9999-12-31';
      const rightDate = right.expectedDate || '9999-12-31';
      return leftDate.localeCompare(rightDate) || String(left.orderedAt || '').localeCompare(String(right.orderedAt || '')) || left.number.localeCompare(right.number);
    });
    return { items: orders.map((order) => summaryOf(order, order.lineCount)) };
  }

  /**
   * Eén order om te ontvangen: de regels met wat besteld, ontvangen en nog open is, de magazijnlocatie en de codes waarmee gescand wordt.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de inkooporder.
   * @returns {{ order?: object, error?: string, code?: string, status?: number }} De order of een foutmelding (404 onbekend, 409 niet te ontvangen).
   */
  function detail(tenantId, id) {
    const order = purchaseOrders.get(tenantId, id);
    if (!order) return { error: 'Inkooporder niet gevonden.', code: 'not_found', status: 404 };
    if (!RECEIVABLE.includes(order.status)) return { error: 'Deze inkooporder staat niet open voor ontvangst (nog een concept, al ontvangen of geannuleerd).', code: 'not_receivable', status: 409 };
    const items = scanData(tenantId, [...new Set(order.lines.map((line) => String(line.itemId || '')).filter(Boolean))]);
    const lines = order.lines.map((line) => {
      const item = items.get(String(line.itemId || '')) || { ean: '', code: '', location: '' };
      const scanCodes = [item.ean, line.code || item.code, line.supplierSku].filter(Boolean);
      return {
        id: line.id, code: String(line.code || ''), name: String(line.name || line.code || '-'), unit: String(line.unit || ''), supplierSku: String(line.supplierSku || ''),
        location: item.location, ordered: line.qty, received: line.receivedQty, openQty: line.openQty, scanCodes, scannable: scanCodes.length > 0,
      };
    }).sort(byLocationOpenFirst);
    return { order: { ...summaryOf(order, order.lines.length), lines } };
  }

  /**
   * Zoekt de open orders bij een gescande code: eerst op ordernummer of leveranciersreferentie, anders op artikel (EAN, artikelcode of leveranciersnummer) met nog openstaande aantallen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} scanned De gescande of ingetypte code.
   * @returns {{ kind: string, orders: object[] }} `order`, `article` of `none` met de gevonden orders (hoogstens 20).
   */
  function lookup(tenantId, scanned) {
    const code = normalizeScan(scanned);
    if (!code) return { kind: 'none', orders: [] };
    const marks = RECEIVABLE.map(() => '?').join(', ');
    const direct = db.prepare(`SELECT o.id FROM purchase_orders o WHERE o.tenant_id = ? AND o.status IN (${marks}) AND (upper(o.number) = ? OR upper(o.supplier_reference) = ?) LIMIT ${MAX_LOOKUP}`)
      .all(tenantId, ...RECEIVABLE, code, code).map((row) => row.id);
    let kind = 'order';
    let ids = direct;
    if (!ids.length) {
      kind = 'article';
      ids = db.prepare(`SELECT DISTINCT o.id FROM purchase_order_lines l
        JOIN purchase_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
        LEFT JOIN stock_items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
        WHERE l.tenant_id = ? AND o.status IN (${marks}) AND l.received_qty < l.qty AND (upper(i.ean) = ? OR upper(l.code) = ? OR upper(l.supplier_sku) = ?)
        LIMIT ${MAX_LOOKUP}`).all(tenantId, ...RECEIVABLE, code, code, code).map((row) => row.id);
    }
    if (!ids.length) return { kind: 'none', orders: [] };
    const orders = ids.map((orderId) => purchaseOrders.get(tenantId, orderId)).filter(Boolean).map((order) => summaryOf(order, order.lines.length));
    return { kind, orders };
  }

  /**
   * Boekt een ontvangst. De medewerker meldt per regel hoeveel er binnen is (`qty`) en wat hij eerder zag als al ontvangen (`seen`): is de order intussen
   * door iemand anders (deels) ontvangen, dan gebeurt er niets (409 `changed`), zodat een tweede scherm of een herhaalde tik nooit dubbel boekt.
   * Meer dan nog openstaat mag alleen met `allowOver` (een leverancier die méér stuurt). De controle en het boeken volgen elkaar synchroon op, dus er kan
   * geen ander verzoek tussen komen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de inkooporder.
   * @param {{ lines?: { lineId: string, qty: number, seen: number }[], allowOver?: boolean }} body De ontvangen regels.
   * @param {object} user De medewerker.
   * @returns {{ result?: object, error?: string, code?: string, status?: number }} Het resultaat of een foutmelding.
   */
  function receive(tenantId, id, body, user) {
    if (!body || !Array.isArray(body.lines) || !body.lines.length) return { error: 'Geef op wat er is ontvangen.', code: 'invalid', status: 400 };
    if (body.lines.length > MAX_LINES) return { error: 'Te veel regels.', code: 'invalid', status: 400 };
    const order = purchaseOrders.get(tenantId, id);
    if (!order) return { error: 'Inkooporder niet gevonden.', code: 'not_found', status: 404 };
    if (!RECEIVABLE.includes(order.status)) return { error: 'Deze inkooporder staat niet open voor ontvangst.', code: 'not_receivable', status: 409 };
    const lineById = new Map(order.lines.map((line) => [line.id, line]));
    const seenIds = new Set();
    const entries = [];
    for (const part of body.lines) {
      const lineId = String(part && part.lineId || '');
      const line = lineById.get(lineId);
      if (!line) return { error: 'Een regel hoort niet bij deze inkooporder.', code: 'not_found', status: 404 };
      if (seenIds.has(lineId)) return { error: 'Een regel staat dubbel.', code: 'invalid', status: 400 };
      seenIds.add(lineId);
      if (typeof part.qty !== 'number' || !Number.isFinite(part.qty) || part.qty <= 0 || part.qty > MAX_QTY) return { error: 'Het ontvangen aantal moet groter zijn dan 0.', code: 'invalid', status: 400 };
      if (typeof part.seen !== 'number' || !Number.isFinite(part.seen) || part.seen < 0) return { error: 'Geef op hoeveel er eerder was ontvangen.', code: 'invalid', status: 400 };
      if (round3(part.seen) !== line.receivedQty) return { error: 'De inkooporder is intussen gewijzigd of ontvangen. Open hem opnieuw.', code: 'changed', status: 409 };
      const qty = round3(part.qty);
      if (qty > line.openQty && body.allowOver !== true) return { error: `Van ${line.name} staat nog ${line.openQty} open; meer ontvangen vraagt om een bevestiging.`, code: 'over_received', status: 409 };
      entries.push({ lineId, qty });
    }
    const out = purchaseOrders.receive(tenantId, id, user, entries);
    if (out.error) return { error: out.error === 'not_found' ? 'Inkooporder niet gevonden.' : out.error, code: out.status === 404 ? 'not_found' : out.status === 409 ? 'not_receivable' : 'invalid', status: out.status || 400 };
    const itemIds = entries.map((entry) => lineById.get(entry.lineId).itemId);
    let released = [];
    try { released = release(tenantId, itemIds) || []; } catch (error) { console.warn(`Backorders na ontvangst: ${error.message}`); }
    return {
      result: {
        number: out.order.number, status: out.order.status, complete: out.order.status === 'ontvangen',
        lines: entries, pieces: round3(entries.reduce((sum, entry) => sum + entry.qty, 0)), releasedOrders: released.length,
      },
    };
  }

  return { list, detail, lookup, receive };
}

/**
 * Hangt de routes van de goederenontvangst aan de app, onder /api/orderpick/receipts (recht `orderpick`: de poort staat al op /api/orderpick).
 * @param {object} app De Express-app.
 * @param {{ receipts: object, requireJson: Function, audit: Function }} deps De opslag, de JSON-controle en het auditlogboek.
 * @returns {void}
 */
function registerGoodsReceiptRoutes(app, { receipts, requireJson, audit }) {
  const lookupLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120, keyFn: (req) => `receipt-lookup:${req.tenantId}:${req.user && req.user.id}` });

  app.get('/api/orderpick/receipts', (req, res) => {
    res.json(receipts.list(req.tenantId));
  });

  app.get('/api/orderpick/receipts/lookup', lookupLimiter, (req, res) => {
    res.json(receipts.lookup(req.tenantId, req.query.code));
  });

  app.get('/api/orderpick/receipts/:id', (req, res) => {
    const out = receipts.detail(req.tenantId, req.params.id);
    if (out.error) return res.status(out.status || 400).json({ error: out.code || 'not_found', message: out.error });
    res.json({ order: out.order });
  });

  app.post('/api/orderpick/receipts/:id/receive', requireJson, (req, res) => {
    const out = receipts.receive(req.tenantId, req.params.id, req.body, req.user);
    if (out.error) return res.status(out.status || 400).json({ error: out.code || 'receive_failed', message: out.error });
    audit(req, 'orderpick_ontvangen', { number: out.result.number, status: out.result.status, lines: out.result.lines.length, pieces: out.result.pieces, released: out.result.releasedOrders });
    res.json(out.result);
  });
}

module.exports = { createGoodsReceipt, registerGoodsReceiptRoutes, normalizeScan };
