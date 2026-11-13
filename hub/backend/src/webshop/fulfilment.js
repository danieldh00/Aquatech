// Leverstatus van webshopbestellingen (punt 15, backorders en deelleveringen): per orderregel besteld, geleverd, nu leverbaar
// en backorder, plus de verwachte leverdatum uit de openstaande inkooporders. De voorraad wordt eerst-besteld-eerst-geleverd
// (FIFO) over de open bestellingen verdeeld: de oudste bestelling krijgt als eerste wat er fysiek ligt. Alles wordt berekend
// uit de huidige voorraad en reserveringen; er staat niets extra in de database.

/**
 * Rondt een aantal af op drie decimalen (buis per meter).
 * @param {*} value Het aantal.
 * @returns {number} Het afgeronde aantal.
 */
const round3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;

/**
 * Het aantal basiseenheden dat één eenheid van een bestelregel van de voorraad vraagt.
 * @param {{ stockPer?: number }} line De orderregel.
 * @returns {number} De factor (1 voor de basiseenheid).
 */
const factorOf = (line) => (Number(line.stockPer) > 1 ? Number(line.stockPer) : 1);

/**
 * Het nog te leveren aantal van een regel (besteld min al geleverd).
 * @param {{ qty: number, shippedQty?: number }} line De orderregel.
 * @returns {number} Het aantal, nooit negatief.
 */
function remainingOf(line) {
  return Math.max(0, round3((Number(line.qty) || 0) - (Number(line.shippedQty) || 0)));
}

/**
 * Verdeelt de fysieke voorraad van één artikel over de bestellingen die erop wachten, de oudste eerst.
 * @param {number} pool De vrije fysieke voorraad (basiseenheid).
 * @param {{ orderId: string, qty: number }[]} queue De vraag per bestelling in volgorde van voorrang (basiseenheid).
 * @returns {Map<string, number>} Per bestelling wat er nu geleverd kan worden (basiseenheid).
 */
function allocate(pool, queue) {
  const given = new Map();
  let left = Math.max(0, pool);
  for (const entry of queue) {
    const take = Math.min(entry.qty, left);
    given.set(entry.orderId, round3((given.get(entry.orderId) || 0) + take));
    left = round3(left - take);
  }
  return given;
}

/**
 * Wijst de verwachte levering (inkoop) toe aan de bestellingen met een tekort, de oudste eerst.
 * @param {{ date: string, qty: number }[]} incoming De openstaande inkoopregels, op datum (zonder datum onderaan).
 * @param {{ orderId: string, qty: number }[]} shortages Het tekort per bestelling in volgorde van voorrang (basiseenheid).
 * @returns {Map<string, string>} Per bestelling de datum waarop het hele tekort gedekt is (leeg = onbekend of niet gedekt).
 */
function assignExpected(incoming, shortages) {
  const result = new Map();
  let cumulative = 0;
  for (const entry of shortages) {
    cumulative = round3(cumulative + entry.qty);
    let covered = null;
    let total = 0;
    for (const arrival of incoming) {
      total = round3(total + arrival.qty);
      if (total >= cumulative) { covered = arrival; break; }
    }
    result.set(entry.orderId, covered ? covered.date : '');
  }
  return result;
}

/**
 * Maakt de berekening van de leverstatus.
 * @param {object} db De database.
 * @returns {{ plan: Function }} De functies.
 */
function createFulfilment(db) {
  /**
   * Maakt een query klaar.
   * @param {string} sql De query.
   * @returns {object} De voorbereide query.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Leest per artikel de fysieke voorraad, de reserveringen van werkorders, de reserveringen van webbestellingen (oudste eerst)
   * en de openstaande inkoop. Vier queries, ongeacht het aantal bestellingen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} itemIds De artikelen.
   * @returns {{ items: Map<string, object>, queues: Map<string, object[]>, incoming: Map<string, object[]> }} De gegevens per artikel.
   */
  function load(tenantId, itemIds) {
    const items = new Map();
    const workOrderReserved = new Map();
    const queues = new Map();
    const incoming = new Map();
    for (let start = 0; start < itemIds.length; start += 200) {
      const chunk = itemIds.slice(start, start + 200);
      const marks = chunk.map(() => '?').join(', ');
      for (const row of prepare(`SELECT id, on_hand, stock_managed FROM stock_items WHERE tenant_id = ? AND id IN (${marks})`).all(tenantId, ...chunk)) {
        items.set(String(row.id), { onHand: Number(row.on_hand) || 0, managed: row.stock_managed === undefined || row.stock_managed === null || Boolean(Number(row.stock_managed)) });
      }
      for (const row of prepare(`SELECT item_id, SUM(qty) AS qty FROM stock_reservations WHERE tenant_id = ? AND item_id IN (${marks}) AND work_order_id NOT LIKE 'order:%' GROUP BY item_id`).all(tenantId, ...chunk)) {
        workOrderReserved.set(String(row.item_id), Number(row.qty) || 0);
      }
      const reservations = prepare(`SELECT r.item_id, r.qty, r.work_order_id, o.created_at, o.number FROM stock_reservations r
        JOIN web_orders o ON o.tenant_id = r.tenant_id AND o.id = substr(r.work_order_id, 7)
        WHERE r.tenant_id = ? AND r.item_id IN (${marks}) AND r.work_order_id LIKE 'order:%' AND o.status = 'nieuw'`).all(tenantId, ...chunk);
      for (const row of reservations) {
        const queue = queues.get(String(row.item_id)) || [];
        queue.push({ orderId: String(row.work_order_id).slice(6), qty: Number(row.qty) || 0, createdAt: row.created_at, number: row.number });
        queues.set(String(row.item_id), queue);
      }
      const lines = prepare(`SELECT l.item_id, l.qty, l.received_qty, p.expected_date FROM purchase_order_lines l
        JOIN purchase_orders p ON p.tenant_id = l.tenant_id AND p.id = l.order_id
        WHERE l.tenant_id = ? AND l.item_id IN (${marks}) AND p.status IN ('besteld', 'deels_ontvangen')`).all(tenantId, ...chunk);
      for (const row of lines) {
        const open = round3((Number(row.qty) || 0) - (Number(row.received_qty) || 0));
        if (open <= 0) continue;
        const list = incoming.get(String(row.item_id)) || [];
        list.push({ date: String(row.expected_date || ''), qty: open });
        incoming.set(String(row.item_id), list);
      }
    }
    for (const [itemId, item] of items) item.pool = Math.max(0, round3(item.onHand - (workOrderReserved.get(itemId) || 0)));
    for (const list of incoming.values()) list.sort((left, right) => (left.date && !right.date ? -1 : !left.date && right.date ? 1 : left.date.localeCompare(right.date)));
    return { items, queues, incoming };
  }

  /**
   * Berekent van open bestellingen per regel wat er nu geleverd kan worden en wat op backorder staat.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, number: string, createdAt: string, status: string, lines: object[], allowPartial?: boolean }[]} orders De bestellingen (regels met itemId, qty, shippedQty, stockPer).
   * @returns {Map<string, { lines: object[], canShip: boolean, complete: boolean, backorder: boolean }>} Per bestelling-id de leverstatus: per regel
   *   { index, ordered, shipped, remaining, ready, backorder, expected }; `complete` = alles wat nog moet kan nu mee, `canShip` = er mag nu iets
   *   verzonden worden (alles, of bij toegestane deellevering een deel), `backorder` = er blijft iets achter.
   */
  function plan(tenantId, orders) {
    const result = new Map();
    const itemIds = [...new Set(orders.flatMap((order) => (order.lines || []).filter((line) => line.itemId && remainingOf(line) > 0).map((line) => String(line.itemId))))];
    const data = itemIds.length ? load(tenantId, itemIds) : { items: new Map(), queues: new Map(), incoming: new Map() };
    // Per artikel: de volgorde van voorrang. Bestellingen met een reservering gaan voor, de rest (vrijgegeven reservering) sluit achteraan aan.
    const allocated = new Map();
    const shortage = new Map();
    for (const itemId of itemIds) {
      const item = data.items.get(itemId);
      if (!item || !item.managed) continue;
      const queue = (data.queues.get(itemId) || []).slice();
      const queued = new Set(queue.map((entry) => entry.orderId));
      for (const order of orders) {
        if (queued.has(order.id)) continue;
        const need = round3((order.lines || []).filter((line) => String(line.itemId) === itemId).reduce((sum, line) => sum + remainingOf(line) * factorOf(line), 0));
        if (need > 0) queue.push({ orderId: order.id, qty: need, createdAt: order.createdAt, number: order.number, late: true });
      }
      queue.sort((left, right) => (Number(Boolean(left.late)) - Number(Boolean(right.late))) || String(left.createdAt).localeCompare(String(right.createdAt)) || String(left.number).localeCompare(String(right.number)));
      const given = allocate(item.pool, queue);
      allocated.set(itemId, given);
      const short = queue.map((entry) => ({ orderId: entry.orderId, qty: round3(entry.qty - (given.get(entry.orderId) || 0)) })).filter((entry) => entry.qty > 0);
      shortage.set(itemId, assignExpected(data.incoming.get(itemId) || [], short));
    }
    for (const order of orders) {
      // Per artikel krijgen de regels van deze bestelling achter elkaar wat er voor de bestelling is toegewezen.
      const left = new Map();
      for (const itemId of itemIds) if (allocated.has(itemId) && allocated.get(itemId).has(order.id)) left.set(itemId, allocated.get(itemId).get(order.id));
      const lines = (order.lines || []).map((line, index) => {
        const remaining = remainingOf(line);
        const base = { index, ordered: Number(line.qty) || 0, shipped: Number(line.shippedQty) || 0, remaining };
        const itemId = String(line.itemId || '');
        const item = data.items.get(itemId);
        // Vrije regels en artikelen zonder voorraadbeheer zijn altijd leverbaar.
        if (!remaining || !itemId || !item || !item.managed) return { ...base, ready: remaining, backorder: 0, expected: '' };
        const factor = factorOf(line);
        const available = left.get(itemId) || 0;
        const ready = Math.min(remaining, factor > 1 ? Math.floor(available / factor) : round3(available));
        left.set(itemId, round3(available - ready * factor));
        const backorder = round3(remaining - ready);
        return { ...base, ready, backorder, expected: backorder > 0 && shortage.has(itemId) ? shortage.get(itemId).get(order.id) || '' : '' };
      });
      const open = lines.filter((entry) => entry.remaining > 0);
      const complete = open.every((entry) => entry.backorder === 0);
      const backorder = open.some((entry) => entry.backorder > 0);
      const canShip = open.length > 0 && (complete || (order.allowPartial !== false && open.some((entry) => entry.ready > 0)));
      result.set(order.id, { lines, canShip, complete, backorder });
    }
    return result;
  }

  return { plan };
}

module.exports = { createFulfilment, remainingOf, allocate, assignExpected, factorOf };
