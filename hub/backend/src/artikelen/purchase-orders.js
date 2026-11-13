// Inkooporders (tabellen purchase_orders en purchase_order_lines, migratie 61).
//
// - Een inkooporder is een bestelling bij één leverancier met regels (artikel, aantal, inkoopprijs).
//   Status: concept (nog te wijzigen of weg te gooien), besteld, deels_ontvangen, ontvangen, geannuleerd.
//   Nummer IO<jaar>-0001 per omgeving.
// - De regels bewaren een momentopname van code, naam, eenheid en het artikelnummer van de leverancier,
//   zodat de order leesbaar blijft als het artikel later verandert.
// - Een ontvangst boekt per regel de voorraad bij via stock.book (soort 'ontvangst', bron inkoop:<nummer>)
//   met de inkoopprijs van de regel, dus de FIFO-lagen en de kostprijs volgen vanzelf. Meer ontvangen dan
//   besteld mag (leveranciers leveren weleens extra); de order is ontvangen zodra elke regel is gehaald.
// - "Onderweg" (incomingByItem): het aantal dat nog niet is ontvangen van orders in concept, besteld of
//   deels ontvangen. Het bestelvoorstel telt dat mee, zodat niets dubbel wordt besteld; het is ook de
//   bron voor het verwachte aantal bij backorders (later).
// - Automatische bestelvoorstellen (autoPropose, migratie 71): een achtergrondtaak houdt per voorkeursleverancier één
//   concept-order met origin 'voorstel' bij, met precies de regels van het verse bestelvoorstel. Er wordt nooit zonder
//   goedkeuring besteld: goedkeuren = place. Afwijzen haalt regels uit het voorstel en onthoudt dat per artikel
//   (purchase_proposal_dismissals) tot het artikel weer boven het minimum zit of wordt hersteld. Een voorstel dat iemand
//   bewerkt wordt handmatig (origin 'handmatig') en is daarna gewoon een order die als onderweg meetelt.
const crypto = require('crypto');
const { transaction } = require('../database/db');
const { createRateLimiter } = require('../beveiliging/rate-limit');

const STATUSES = ['concept', 'besteld', 'deels_ontvangen', 'ontvangen', 'geannuleerd'];
const OPEN_STATUSES = ['concept', 'besteld', 'deels_ontvangen'];
const MAX_LINES = 500;
const MAX_QTY = 1000000;
const MAX_COST_PRICE = 1000000;
const MAX_LIST = 500;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ORIGIN_MANUAL = 'handmatig';
const ORIGIN_PROPOSAL = 'voorstel';
const PROPOSAL_NOTE = 'Automatisch voorstel';
const MAX_APPROVE = 100;
const WITHOUT_SUPPLIER_TTL_MS = 30 * 1000;
const AUTOMATIC_USER = { id: '', name: 'Automatisch' };

/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * Maakt tekst schoon: stuurtekens weg, spaties aan de randen af, ingekort.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximale lengte.
 * @returns {string} De schone tekst.
 */
const cleanText = (value, maxLength) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);

/**
 * Rondt een aantal af op drie decimalen.
 * @param {number} value Het aantal.
 * @returns {number} Het afgeronde aantal.
 */
const round3 = (value) => Math.round(value * 1000) / 1000;

/**
 * Rondt een prijs af op vier decimalen.
 * @param {number} value De prijs.
 * @returns {number} De afgeronde prijs.
 */
const round4 = (value) => Math.round(value * 10000) / 10000;

/**
 * Rondt een bedrag af op centen.
 * @param {number} value Het bedrag.
 * @returns {number} Het afgeronde bedrag.
 */
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Maakt een rij `?, ?, ?` voor een IN-lijst.
 * @param {number} count Aantal waarden.
 * @returns {string} De plaatshouders.
 */
const placeholders = (count) => new Array(count).fill('?').join(', ');

/**
 * Controleert een lijst id's uit de invoer: tekst, zonder dubbele, niet leeg en niet te lang.
 * @param {*} raw De invoer.
 * @param {number} max Het hoogste aantal.
 * @returns {string[]|null} De schone id's, of null als de lijst niet geldig is.
 */
function cleanIds(raw, max) {
  if (!Array.isArray(raw) || !raw.length || raw.length > max) return null;
  const ids = [...new Set(raw.map((value) => cleanText(value, 60)))];
  return ids.every(Boolean) ? ids : null;
}

/**
 * Vergelijkt de regels van een order met de regels die er zouden moeten staan.
 * @param {object[]} current De huidige regels (lineOf).
 * @param {object[]} wanted De gewenste regels (prepareLines).
 * @returns {boolean} true als artikel, aantal, prijs en momentopname gelijk zijn, in dezelfde volgorde.
 */
function sameLines(current, wanted) {
  if (current.length !== wanted.length) return false;
  return current.every((line, index) => {
    const other = wanted[index];
    return line.itemId === other.itemId && line.qty === round3(other.qty) && (line.unitCost == null ? null : round4(line.unitCost)) === (other.unitCost == null ? null : round4(other.unitCost))
      && line.code === other.code && line.name === other.name && line.unit === other.unit && line.supplierSku === other.supplierSku;
  });
}

/**
 * Controleert en schoont de invoer van een inkooporder.
 * @param {object} input De invoer: { supplierId, expectedDate, notes, lines: [{ itemId, qty, unitCost }] }.
 * @returns {{ value?: object, error?: string, field?: string }} De schone velden, of een fout.
 */
function sanitizeOrder(input) {
  const source = input && typeof input === 'object' ? input : {};
  const supplierId = cleanText(source.supplierId, 60);
  if (!supplierId) return { error: 'Kies een leverancier.', field: 'supplierId' };
  const expectedDate = cleanText(source.expectedDate, 10);
  if (expectedDate && (!DATE_PATTERN.test(expectedDate) || Number.isNaN(Date.parse(`${expectedDate}T00:00:00Z`)))) return { error: 'De verwachte leverdatum is niet geldig.', field: 'expectedDate' };
  if (!Array.isArray(source.lines)) return { error: 'Geef de regels als lijst.', field: 'lines' };
  if (source.lines.length > MAX_LINES) return { error: `Een inkooporder heeft hoogstens ${MAX_LINES} regels.`, field: 'lines' };
  const seen = new Set();
  const lines = [];
  for (const entry of source.lines) {
    const itemId = cleanText(entry && entry.itemId, 60);
    if (!itemId) return { error: 'Kies een artikel op elke regel.', field: 'itemId' };
    if (seen.has(itemId)) return { error: 'Een artikel staat al op deze order.', field: 'itemId' };
    seen.add(itemId);
    const qty = Number(entry.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY) return { error: 'Het aantal moet groter zijn dan 0.', field: 'qty' };
    let unitCost = null;
    if (entry.unitCost !== undefined && entry.unitCost !== null && entry.unitCost !== '') {
      unitCost = Number(entry.unitCost);
      if (!Number.isFinite(unitCost) || unitCost < 0 || unitCost > MAX_COST_PRICE) return { error: 'De inkoopprijs is niet geldig.', field: 'unitCost' };
      unitCost = round4(unitCost);
    }
    lines.push({ itemId, qty: round3(qty), unitCost, supplierSku: cleanText(entry.supplierSku, 80) });
  }
  return { value: { supplierId, expectedDate, notes: cleanText(source.notes, 2000), supplierReference: cleanText(source.supplierReference, 60), rememberSkus: source.rememberSkus === true, lines } };
}

/**
 * Zet een regel uit purchase_order_lines om naar het formaat van de API.
 * @param {object} row De rij.
 * @returns {object} De regel met het nog te ontvangen aantal en het bedrag.
 */
function lineOf(row) {
  const qty = round3(Number(row.qty));
  const receivedQty = round3(Number(row.received_qty));
  const unitCost = row.unit_cost == null ? null : Number(row.unit_cost);
  return {
    id: row.id, itemId: row.item_id, code: row.code, name: row.name, unit: row.unit, supplierSku: row.supplier_sku,
    qty, receivedQty, openQty: Math.max(0, round3(qty - receivedQty)), unitCost, amount: unitCost == null ? null : round2(qty * unitCost),
  };
}

/**
 * Telt de bedragen van een lijst regels op.
 * @param {object[]} lines De regels (uit lineOf).
 * @returns {number|null} Het totaal, of null als geen enkele regel een prijs heeft.
 */
function totalOf(lines) {
  let total = null;
  for (const line of lines) if (line.amount != null) total = round2((total || 0) + line.amount);
  return total;
}

/** Een fout uit het direct inboeken van een order, gegooid om de transactie terug te draaien. */
class ReceiveFailed extends Error {
  /**
   * Onthoudt de uitkomst die de aanroeper terugkrijgt.
   * @param {{ error: string, field?: string, status?: number }} outcome De foutuitkomst om terug te geven.
   */
  constructor(outcome) {
    super(outcome.error);
    this.outcome = outcome;
  }
}

/**
 * Maakt de opslag voor inkooporders.
 * @param {object} db De database.
 * @param {{ stock: object, suppliers: object }} parts De voorraadopslag (book, reorderProposal) en de leveranciersopslag (preferredByItem).
 * @returns {object} list, get, create, createReceived, update, place, receive, close, cancel, remove, incomingByItem, fromProposal,
 *   autoPropose, proposals, approve, dismiss, restore.
 */
function createPurchaseOrderStore(db, { stock, suppliers }) {
  /**
   * Maakt een query klaar.
   * @param {string} sql De query.
   * @returns {object} De voorbereide query.
   */
  const prepare = (sql) => db.prepare(sql);
  const ORDER_COLS = 'o.id, o.number, o.supplier_id, o.status, o.expected_date, o.notes, o.supplier_reference, o.origin, o.created_by, o.created_at, o.updated_at, o.ordered_at, o.closed_at, s.name AS supplier_name';
  const LINE_COLS = 'id, item_id, code, name, unit, supplier_sku, qty, unit_cost, received_qty';

  /**
   * Zet een orderrij om naar het formaat van de API.
   * @param {object} row De rij met ORDER_COLS.
   * @returns {object} De order zonder regels.
   */
  const orderOf = (row) => ({
    id: row.id, number: row.number, supplierId: row.supplier_id, supplierName: row.supplier_name, status: row.status,
    expectedDate: row.expected_date, notes: row.notes, supplierReference: row.supplier_reference, origin: row.origin, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    orderedAt: row.ordered_at || null, closedAt: row.closed_at || null,
  });

  /**
   * Zoekt één order van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de order.
   * @returns {object|undefined} De rij.
   */
  const findRow = (tenantId, id) => prepare(`SELECT ${ORDER_COLS} FROM purchase_orders o JOIN suppliers s ON s.tenant_id = o.tenant_id AND s.id = o.supplier_id
    WHERE o.tenant_id = ? AND o.id = ?`).get(tenantId, String(id || ''));

  /**
   * De regels van een order, in volgorde.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de order.
   * @returns {object[]} De regels.
   */
  const linesOf = (tenantId, orderId) => prepare(`SELECT ${LINE_COLS} FROM purchase_order_lines WHERE tenant_id = ? AND order_id = ? ORDER BY position, id`)
    .all(tenantId, orderId).map(lineOf);

  /**
   * De volledige order met regels en totaal.
   * @param {object} row De orderrij.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} De order.
   */
  const fullOrder = (row, tenantId) => {
    const lines = linesOf(tenantId, row.id);
    return { ...orderOf(row), lines, total: totalOf(lines), openQty: round3(lines.reduce((sum, line) => sum + line.openQty, 0)) };
  };

  /**
   * Het volgende ordernummer van dit jaar.
   * @param {string} tenantId Id van de omgeving.
   * @returns {string} Bijvoorbeeld IO2026-0001.
   */
  function nextNumber(tenantId) {
    const year = new Date().getFullYear();
    const prefix = `IO${year}-`;
    const last = prepare('SELECT number FROM purchase_orders WHERE tenant_id = ? AND number LIKE ? ORDER BY number DESC LIMIT 1').get(tenantId, `${prefix}%`);
    const sequence = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(sequence).padStart(4, '0')}`;
  }

  /**
   * Controleert leverancier en artikelen van een order en maakt de regels klaar.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} value De schone invoer (sanitizeOrder).
   * @param {{ allowArchivedSupplierId?: string }} [options] Een leverancier die al op de order staat mag gearchiveerd zijn.
   * @returns {{ rows?: object[], supplier?: object, error?: string, field?: string, status?: number }} De regels met momentopname, of een fout.
   */
  function prepareLines(tenantId, value, { allowArchivedSupplierId = null } = {}) {
    const supplier = prepare('SELECT id, name, archived FROM suppliers WHERE tenant_id = ? AND id = ?').get(tenantId, value.supplierId);
    if (!supplier) return { error: 'Leverancier niet gevonden.', field: 'supplierId', status: 404 };
    if (Number(supplier.archived) && supplier.id !== allowArchivedSupplierId) return { error: 'Deze leverancier is gearchiveerd.', field: 'supplierId', status: 409 };
    const ids = value.lines.map((line) => line.itemId);
    const items = ids.length
      ? prepare(`SELECT id, code, name, unit, cost_price, has_variants, archived FROM stock_items WHERE tenant_id = ? AND id IN (${placeholders(ids.length)})`).all(tenantId, ...ids)
      : [];
    const itemById = new Map(items.map((item) => [item.id, item]));
    const links = ids.length
      ? prepare(`SELECT item_id, supplier_sku, cost_price FROM item_suppliers WHERE tenant_id = ? AND supplier_id = ? AND item_id IN (${placeholders(ids.length)})`).all(tenantId, supplier.id, ...ids)
      : [];
    const linkByItem = new Map(links.map((link) => [link.item_id, link]));
    const rows = [];
    for (const line of value.lines) {
      const item = itemById.get(line.itemId);
      if (!item) return { error: 'Een artikel op deze order bestaat niet.', field: 'itemId', status: 404 };
      if (Number(item.has_variants)) return { error: `${item.code} is een hoofdartikel: bestel een maat of variant.`, field: 'itemId', status: 409 };
      if (Number(item.archived)) return { error: `${item.code} is gearchiveerd.`, field: 'itemId', status: 409 };
      const link = linkByItem.get(item.id);
      let unitCost = line.unitCost;
      if (unitCost == null) unitCost = link && link.cost_price != null ? Number(link.cost_price) : item.cost_price == null ? null : Number(item.cost_price);
      rows.push({ itemId: item.id, code: item.code, name: item.name, unit: item.unit, supplierSku: line.supplierSku || (link ? link.supplier_sku : ''), qty: line.qty, unitCost });
    }
    return { rows, supplier };
  }

  /**
   * Schrijft de regels van een order (vervangt de bestaande).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de order.
   * @param {object[]} rows De regels uit prepareLines.
   * @returns {void}
   */
  function writeLines(tenantId, orderId, rows) {
    prepare('DELETE FROM purchase_order_lines WHERE tenant_id = ? AND order_id = ?').run(tenantId, orderId);
    rows.forEach((row, position) => {
      prepare(`INSERT INTO purchase_order_lines (id, tenant_id, order_id, item_id, position, code, name, unit, supplier_sku, qty, unit_cost, received_qty)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
        .run(crypto.randomUUID(), tenantId, orderId, row.itemId, position, row.code, row.name, row.unit, row.supplierSku, row.qty, row.unitCost);
    });
  }

  /**
   * De orders van een omgeving, nieuwste eerst, met aantal regels, totaal en wat nog openstaat.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ status?: string, supplierId?: string }} [filter] Alleen deze status of leverancier ('open' = concept, besteld en deels ontvangen).
   * @returns {object[]} De orders zonder regels.
   */
  function list(tenantId, { status = '', supplierId = '' } = {}) {
    const where = [];
    const params = [tenantId];
    if (status === 'open') { where.push(`o.status IN (${placeholders(OPEN_STATUSES.length)})`); params.push(...OPEN_STATUSES); }
    else if (STATUSES.includes(status)) { where.push('o.status = ?'); params.push(status); }
    if (supplierId) { where.push('o.supplier_id = ?'); params.push(String(supplierId)); }
    const rows = prepare(`SELECT ${ORDER_COLS} FROM purchase_orders o JOIN suppliers s ON s.tenant_id = o.tenant_id AND s.id = o.supplier_id
      WHERE o.tenant_id = ?${where.map((condition) => ` AND ${condition}`).join('')} ORDER BY o.created_at DESC, o.number DESC LIMIT ${MAX_LIST}`).all(...params);
    if (!rows.length) return [];
    const sums = prepare(`SELECT l.order_id, COUNT(*) AS line_count, SUM(l.qty) AS qty, SUM(l.received_qty) AS received,
        SUM(CASE WHEN l.unit_cost IS NULL THEN 0 ELSE l.qty * l.unit_cost END) AS amount,
        SUM(CASE WHEN l.unit_cost IS NULL THEN 0 ELSE 1 END) AS priced
      FROM purchase_order_lines l WHERE l.tenant_id = ? AND l.order_id IN (${placeholders(rows.length)}) GROUP BY l.order_id`).all(tenantId, ...rows.map((row) => row.id));
    const sumByOrder = new Map(sums.map((sum) => [sum.order_id, sum]));
    return rows.map((row) => {
      const sum = sumByOrder.get(row.id);
      return {
        ...orderOf(row), lineCount: sum ? Number(sum.line_count) : 0,
        total: sum && Number(sum.priced) ? round2(Number(sum.amount)) : null,
        openQty: sum ? Math.max(0, round3(Number(sum.qty) - Number(sum.received))) : 0,
      };
    });
  }

  /**
   * Eén order met regels.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de order.
   * @returns {object|null} De order, of null als hij niet bestaat.
   */
  function get(tenantId, id) {
    const row = findRow(tenantId, id);
    return row ? fullOrder(row, tenantId) : null;
  }

  /**
   * Onthoudt de artikelnummers van de leverancier bij de artikelen (binnen de transactie van de aanroeper),
   * zodat een volgend document van deze leverancier die regels meteen herkent.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} supplierId Id van de leverancier.
   * @param {Array<{ itemId: string, supplierSku: string }>} rows De regels van de order.
   * @returns {void}
   */
  function rememberSkus(tenantId, supplierId, rows) {
    suppliers.rememberSkus(tenantId, supplierId, rows);
  }

  /**
   * Schrijft een nieuwe order met regels (binnen een transactie van de aanroeper).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} user Wie hem maakt.
   * @param {object} value De schone invoer (sanitizeOrder).
   * @param {{ origin?: string, prepared?: object }} [options] origin = 'handmatig' (standaard) of 'voorstel'; prepared = al gecontroleerde regels (prepareLines).
   * @returns {{ order?: object, error?: string, field?: string, status?: number }} De order, of een fout.
   */
  function insertOrder(tenantId, user, value, { origin = ORIGIN_MANUAL, prepared: ready = null } = {}) {
    const prepared = ready || prepareLines(tenantId, value);
    if (prepared.error) return prepared;
    const id = crypto.randomUUID();
    const now = currentTimestamp();
    prepare(`INSERT INTO purchase_orders (id, tenant_id, number, supplier_id, status, expected_date, notes, supplier_reference, origin, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'concept', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, nextNumber(tenantId), prepared.supplier.id, value.expectedDate, value.notes, value.supplierReference, origin === ORIGIN_PROPOSAL ? ORIGIN_PROPOSAL : ORIGIN_MANUAL,
        cleanText(user && (user.display_name || user.displayName || user.name), 120), now, now);
    writeLines(tenantId, id, prepared.rows);
    if (value.rememberSkus) rememberSkus(tenantId, prepared.supplier.id, prepared.rows);
    return { order: fullOrder(findRow(tenantId, id), tenantId) };
  }

  /**
   * Maakt een inkooporder (concept).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} user Wie hem maakt.
   * @param {object} raw De invoer.
   * @returns {{ order?: object, error?: string, field?: string, status?: number }} De order, of een fout.
   */
  function create(tenantId, user, raw) {
    const checked = sanitizeOrder(raw);
    if (checked.error) return checked;
    return transaction(db, () => insertOrder(tenantId, user, checked.value));
  }

  /**
   * Wijzigt een inkooporder in concept (leverancier, datum, notitie en regels). Een automatisch voorstel wordt
   * daarmee handmatig: de achtergrondtaak laat hem daarna met rust.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de order.
   * @param {object} raw De invoer (zelfde velden als bij maken).
   * @returns {{ order?: object, error?: string, field?: string, status?: number }} De order, of een fout.
   */
  function update(tenantId, id, raw) {
    const checked = sanitizeOrder(raw);
    if (checked.error) return checked;
    return transaction(db, () => {
      const row = findRow(tenantId, id);
      if (!row) return { error: 'not_found', status: 404 };
      if (row.status !== 'concept') return { error: 'Alleen een concept is te wijzigen.', status: 409 };
      const prepared = prepareLines(tenantId, checked.value, { allowArchivedSupplierId: row.supplier_id });
      if (prepared.error) return prepared;
      prepare('UPDATE purchase_orders SET supplier_id = ?, expected_date = ?, notes = ?, supplier_reference = ?, origin = ?, updated_at = ? WHERE tenant_id = ? AND id = ?')
        .run(prepared.supplier.id, checked.value.expectedDate, checked.value.notes, checked.value.supplierReference, ORIGIN_MANUAL, currentTimestamp(), tenantId, row.id);
      writeLines(tenantId, row.id, prepared.rows);
      if (checked.value.rememberSkus) rememberSkus(tenantId, prepared.supplier.id, prepared.rows);
      return { order: fullOrder(findRow(tenantId, row.id), tenantId) };
    });
  }

  /**
   * Zet een concept op besteld.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de order.
   * @returns {{ order?: object, error?: string, status?: number }} De order, of een fout.
   */
  function place(tenantId, id) {
    return transaction(db, () => {
      const row = findRow(tenantId, id);
      if (!row) return { error: 'not_found', status: 404 };
      if (row.status !== 'concept') return { error: 'Alleen een concept is te bestellen.', status: 409 };
      const count = prepare('SELECT COUNT(*) AS n FROM purchase_order_lines WHERE tenant_id = ? AND order_id = ?').get(tenantId, row.id).n;
      if (!Number(count)) return { error: 'Een order zonder regels is niet te bestellen.', status: 409 };
      const now = currentTimestamp();
      prepare("UPDATE purchase_orders SET status = 'besteld', ordered_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(now, now, tenantId, row.id);
      return { order: fullOrder(findRow(tenantId, row.id), tenantId) };
    });
  }

  /**
   * Boekt een ontvangst voor een bestelde order, binnen de transactie van de aanroeper: per opgegeven
   * regel gaat de voorraad omhoog met de inkoopprijs van de regel. Eerst wordt alles gecontroleerd, dan
   * pas geboekt, zodat een fout niets half achterlaat.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} row De orderrij (status besteld of deels ontvangen).
   * @param {object} user Wie ontvangt.
   * @param {Array<{ lineId: string, qty: number }>} entries De ontvangen aantallen per regel.
   * @returns {{ order?: object, error?: string, field?: string, status?: number }} De order, of een fout.
   */
  function receiveRows(tenantId, row, user, entries) {
    if (!Array.isArray(entries) || !entries.length) return { error: 'Geef op wat er is ontvangen.', field: 'lines' };
    if (entries.length > MAX_LINES) return { error: 'Te veel regels.', field: 'lines' };
    const lines = prepare(`SELECT ${LINE_COLS} FROM purchase_order_lines WHERE tenant_id = ? AND order_id = ?`).all(tenantId, row.id);
    const lineById = new Map(lines.map((line) => [line.id, line]));
    const seen = new Set();
    const checked = [];
    for (const entry of entries) {
      const lineId = cleanText(entry && entry.lineId, 60);
      const line = lineById.get(lineId);
      if (!line) return { error: 'Een regel hoort niet bij deze order.', field: 'lineId', status: 404 };
      if (seen.has(lineId)) return { error: 'Een regel staat dubbel.', field: 'lineId' };
      seen.add(lineId);
      const qty = Number(entry.qty);
      if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY) return { error: 'Het ontvangen aantal moet groter zijn dan 0.', field: 'qty' };
      checked.push({ line, qty: round3(qty) });
    }
    const now = currentTimestamp();
    for (const { line, qty } of checked) {
      stock.book(tenantId, line.item_id, qty, {
        kind: 'ontvangst', source: `inkoop:${row.number}`, note: `Inkooporder ${row.number}`, user, at: now,
        unitCost: line.unit_cost == null ? undefined : Number(line.unit_cost),
      });
      prepare('UPDATE purchase_order_lines SET received_qty = received_qty + ? WHERE tenant_id = ? AND id = ?').run(qty, tenantId, line.id);
    }
    const after = linesOf(tenantId, row.id);
    const complete = after.every((line) => line.receivedQty >= line.qty);
    prepare('UPDATE purchase_orders SET status = ?, closed_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?')
      .run(complete ? 'ontvangen' : 'deels_ontvangen', complete ? now : null, now, tenantId, row.id);
    return { order: fullOrder(findRow(tenantId, row.id), tenantId), number: row.number };
  }

  /**
   * Boekt een ontvangst op een bestelde order (alles of niets).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de order.
   * @param {object} user Wie ontvangt.
   * @param {Array<{ lineId: string, qty: number }>} entries De ontvangen aantallen per regel.
   * @returns {{ order?: object, error?: string, field?: string, status?: number }} De order, of een fout.
   */
  function receive(tenantId, id, user, entries) {
    return transaction(db, () => {
      const row = findRow(tenantId, id);
      if (!row) return { error: 'not_found', status: 404 };
      if (row.status !== 'besteld' && row.status !== 'deels_ontvangen') return { error: 'Alleen een bestelde order is te ontvangen.', status: 409 };
      return receiveRows(tenantId, row, user, entries);
    });
  }

  /**
   * Maakt een order en boekt hem meteen helemaal in (voor een pakbon of factuur van goederen die er al zijn).
   * Alles of niets: bij een fout wordt ook de order niet gemaakt.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} user Wie het doet.
   * @param {object} raw De invoer (zoals bij maken).
   * @returns {{ order?: object, error?: string, field?: string, status?: number }} De ontvangen order, of een fout.
   */
  function createReceived(tenantId, user, raw) {
    const checked = sanitizeOrder(raw);
    if (checked.error) return checked;
    // Direct inboeken legt de kostprijs vast: een prijs die niemand heeft ingevuld of gezien wordt niet geraden.
    if (checked.value.lines.some((line) => line.unitCost == null)) return { error: 'Vul bij elke regel de inkoopprijs in om direct in te boeken.', field: 'unitCost', status: 400 };
    // Een teruggegeven fout rolt de transactie niet terug: daarom wordt hij binnen gegooid (alles terug) en buiten weer teruggegeven.
    try {
      return transaction(db, () => {
        const made = insertOrder(tenantId, user, checked.value);
        if (made.error) throw new ReceiveFailed(made);
        if (!made.order.lines.length) throw new ReceiveFailed({ error: 'Een order zonder regels is niet in te boeken.', field: 'lines', status: 409 });
        const now = currentTimestamp();
        prepare("UPDATE purchase_orders SET status = 'besteld', ordered_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(now, now, tenantId, made.order.id);
        const received = receiveRows(tenantId, findRow(tenantId, made.order.id), user, made.order.lines.map((line) => ({ lineId: line.id, qty: line.qty })));
        if (received.error) throw new ReceiveFailed(received);
        return received;
      });
    } catch (error) {
      if (error instanceof ReceiveFailed) return error.outcome;
      throw error;
    }
  }

  /**
   * Sluit een deels ontvangen order af: wat nog niet is geleverd vervalt.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de order.
   * @returns {{ order?: object, error?: string, status?: number }} De order, of een fout.
   */
  function close(tenantId, id) {
    return transaction(db, () => {
      const row = findRow(tenantId, id);
      if (!row) return { error: 'not_found', status: 404 };
      if (row.status !== 'deels_ontvangen') return { error: 'Alleen een deels ontvangen order is af te sluiten.', status: 409 };
      const now = currentTimestamp();
      prepare("UPDATE purchase_orders SET status = 'ontvangen', closed_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(now, now, tenantId, row.id);
      return { order: fullOrder(findRow(tenantId, row.id), tenantId) };
    });
  }

  /**
   * Annuleert een order die nog niets heeft ontvangen (concept of besteld).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de order.
   * @returns {{ order?: object, error?: string, status?: number }} De order, of een fout.
   */
  function cancel(tenantId, id) {
    return transaction(db, () => {
      const row = findRow(tenantId, id);
      if (!row) return { error: 'not_found', status: 404 };
      if (row.status !== 'concept' && row.status !== 'besteld') return { error: 'Alleen een concept of bestelde order is te annuleren; sluit een deels ontvangen order af.', status: 409 };
      const now = currentTimestamp();
      prepare("UPDATE purchase_orders SET status = 'geannuleerd', closed_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(now, now, tenantId, row.id);
      return { order: fullOrder(findRow(tenantId, row.id), tenantId) };
    });
  }

  /**
   * Gooit een concept weg (met zijn regels).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de order.
   * @returns {{ number?: string, error?: string, status?: number }} Het nummer, of een fout.
   */
  function remove(tenantId, id) {
    return transaction(db, () => {
      const row = findRow(tenantId, id);
      if (!row) return { error: 'not_found', status: 404 };
      if (row.status !== 'concept') return { error: 'Alleen een concept is weg te gooien; annuleer een bestelde order.', status: 409 };
      prepare('DELETE FROM purchase_order_lines WHERE tenant_id = ? AND order_id = ?').run(tenantId, row.id);
      prepare('DELETE FROM purchase_orders WHERE tenant_id = ? AND id = ?').run(tenantId, row.id);
      return { number: row.number };
    });
  }

  /**
   * Het aantal dat nog onderweg is per artikel (orders in concept, besteld of deels ontvangen).
   * @param {string} tenantId Id van de omgeving.
   * @param {{ excludeProposals?: boolean }} [options] excludeProposals: automatische voorstellen in concept tellen niet mee.
   * @returns {Map<string, number>} Artikel-id naar het nog niet ontvangen aantal.
   */
  function incomingByItem(tenantId, { excludeProposals = false } = {}) {
    const withoutProposals = excludeProposals ? " AND NOT (o.status = 'concept' AND o.origin = ?)" : '';
    const params = excludeProposals ? [tenantId, ...OPEN_STATUSES, ORIGIN_PROPOSAL] : [tenantId, ...OPEN_STATUSES];
    const rows = prepare(`SELECT l.item_id, SUM(l.qty - l.received_qty) AS open_qty
      FROM purchase_order_lines l JOIN purchase_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
      WHERE l.tenant_id = ? AND o.status IN (${placeholders(OPEN_STATUSES.length)})${withoutProposals} GROUP BY l.item_id`).all(...params);
    const out = new Map();
    for (const row of rows) {
      const openQty = round3(Number(row.open_qty));
      if (openQty > 0) out.set(row.item_id, openQty);
    }
    return out;
  }

  /**
   * Maakt uit het bestelvoorstel per voorkeursleverancier een concept-order. Artikelen zonder
   * leverancier blijven buiten beeld; wat al onderweg is staat niet meer in het voorstel.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} user Wie het doet.
   * @returns {{ orders: object[], skipped: number }} De nieuwe orders (zonder regels) en het aantal voorstelregels zonder leverancier.
   */
  function fromProposal(tenantId, user) {
    return transaction(db, () => {
      const proposal = stock.reorderProposal(tenantId, { preferred: suppliers.preferredByItem(tenantId), incoming: incomingByItem(tenantId) });
      const bySupplier = new Map();
      let skipped = 0;
      for (const item of proposal.items) {
        if (!item.supplierId) { skipped += 1; continue; }
        if (!bySupplier.has(item.supplierId)) bySupplier.set(item.supplierId, []);
        bySupplier.get(item.supplierId).push({ itemId: item.id, qty: item.orderQty, unitCost: item.costPrice });
      }
      const orders = [];
      for (const [supplierId, lines] of bySupplier) {
        const out = insertOrder(tenantId, user, { supplierId, expectedDate: '', notes: '', supplierReference: '', rememberSkus: false, lines });
        if (out.error) throw Object.assign(new Error(out.error), { status: out.status || 400 });
        orders.push({ ...out.order, lines: undefined });
      }
      return { orders, skipped };
    });
  }

  /**
   * Het verse bestelvoorstel zonder de automatische voorstellen als onderweg (die worden juist opnieuw opgebouwd).
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} Het voorstel van stock.reorderProposal.
   */
  // Het aantal artikelen zonder voorkeursleverancier kost een volledig bestelvoorstel: 30 s onthouden per omgeving.
  const withoutSupplierCache = new Map();
  /**
   * Het verse bestelvoorstel van de hele omgeving, zonder de voorstel-orders zelf als onderweg te tellen.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ items: object[], total: number|null, suppliers: object[] }} Het bestelvoorstel (stock.reorderProposal).
   */
  const freshProposal = (tenantId) => stock.reorderProposal(tenantId, { preferred: suppliers.preferredByItem(tenantId), incoming: incomingByItem(tenantId, { excludeProposals: true }) });

  /**
   * De automatische voorstellen (concept, origin voorstel) van een omgeving, oudste eerst.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object[]} De orderrijen (ORDER_COLS).
   */
  const proposalRows = (tenantId) => prepare(`SELECT ${ORDER_COLS} FROM purchase_orders o JOIN suppliers s ON s.tenant_id = o.tenant_id AND s.id = o.supplier_id
    WHERE o.tenant_id = ? AND o.status = 'concept' AND o.origin = ? ORDER BY o.created_at, o.number`).all(tenantId, ORIGIN_PROPOSAL);

  /**
   * De regels van een aantal orders in één query.
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} orderIds De orders.
   * @returns {Map<string, object[]>} Order-id naar zijn regels (lineOf), in volgorde.
   */
  function linesByOrder(tenantId, orderIds) {
    const out = new Map(orderIds.map((id) => [id, []]));
    if (!orderIds.length) return out;
    const rows = prepare(`SELECT order_id, ${LINE_COLS} FROM purchase_order_lines WHERE tenant_id = ? AND order_id IN (${placeholders(orderIds.length)}) ORDER BY position, id`)
      .all(tenantId, ...orderIds);
    for (const row of rows) out.get(row.order_id).push(lineOf(row));
    return out;
  }

  /**
   * Gooit een order met zijn regels weg (binnen de transactie van de aanroeper).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de order.
   * @returns {void}
   */
  function deleteOrder(tenantId, orderId) {
    prepare('DELETE FROM purchase_order_lines WHERE tenant_id = ? AND order_id = ?').run(tenantId, orderId);
    prepare('DELETE FROM purchase_orders WHERE tenant_id = ? AND id = ?').run(tenantId, orderId);
  }

  /**
   * Werkt de automatische bestelvoorstellen bij: per voorkeursleverancier één concept met origin voorstel en precies
   * de regels van het verse bestelvoorstel. Artikelen zonder voorkeursleverancier en afgewezen artikelen komen er niet
   * op; een afwijzing vervalt zodra het artikel niet meer in het bestelvoorstel staat (weer genoeg voorraad, of
   * gearchiveerd of weg). Een voorstel dat al klopt blijft onaangeroerd; een leeg voorstel verdwijnt. Eén transactie,
   * en alles wordt eerst gecontroleerd voordat er iets wordt geschreven.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} [user] Wie het doet (standaard de achtergrondtaak).
   * @returns {{ created: number, updated: number, removed: number, skipped: number, dismissedSkipped: number }} Nieuwe, bijgewerkte en verwijderde voorstellen, regels zonder voorkeursleverancier en afgewezen regels.
   */
  function autoPropose(tenantId, user = AUTOMATIC_USER) {
    return transaction(db, () => {
      const proposal = freshProposal(tenantId);
      const inProposal = new Set(proposal.items.map((item) => item.id));
      const dismissed = new Set(prepare('SELECT item_id FROM purchase_proposal_dismissals WHERE tenant_id = ?').all(tenantId).map((row) => row.item_id));
      const outcome = { created: 0, updated: 0, removed: 0, skipped: 0, dismissedSkipped: 0 };
      const bySupplier = new Map();
      for (const item of proposal.items) {
        if (dismissed.has(item.id)) { outcome.dismissedSkipped += 1; continue; }
        if (!item.supplierId) { outcome.skipped += 1; continue; }
        if (!(item.orderQty > 0)) continue;
        if (!bySupplier.has(item.supplierId)) bySupplier.set(item.supplierId, []);
        bySupplier.get(item.supplierId).push({ itemId: item.id, qty: round3(item.orderQty), unitCost: item.costPrice == null ? null : round4(item.costPrice), supplierSku: '' });
      }
      // Eerst alles controleren, dan pas schrijven. Een leverancier waarvan de regels niet kloppen (kan alleen bij een
      // gelijktijdige wijziging) slaat deze ronde over; zijn regels tellen als overgeslagen.
      const plans = [];
      for (const [supplierId, lines] of bySupplier) {
        const value = { supplierId, expectedDate: '', notes: PROPOSAL_NOTE, supplierReference: '', rememberSkus: false, lines };
        const prepared = prepareLines(tenantId, value);
        if (prepared.error) { outcome.skipped += lines.length; continue; }
        plans.push({ supplierId, value, prepared });
      }
      const existing = proposalRows(tenantId);
      const currentLines = linesByOrder(tenantId, existing.map((row) => row.id));
      const existingBySupplier = new Map();
      for (const row of existing) {
        if (!existingBySupplier.has(row.supplier_id)) existingBySupplier.set(row.supplier_id, row);
        else { deleteOrder(tenantId, row.id); outcome.removed += 1; }
      }
      const planned = new Set(plans.map((plan) => plan.supplierId));
      for (const [supplierId, row] of existingBySupplier) {
        if (planned.has(supplierId)) continue;
        deleteOrder(tenantId, row.id);
        outcome.removed += 1;
      }
      for (const plan of plans) {
        const row = existingBySupplier.get(plan.supplierId);
        if (!row) {
          insertOrder(tenantId, user, plan.value, { origin: ORIGIN_PROPOSAL, prepared: plan.prepared });
          outcome.created += 1;
          continue;
        }
        if (sameLines(currentLines.get(row.id), plan.prepared.rows)) continue;
        writeLines(tenantId, row.id, plan.prepared.rows);
        prepare('UPDATE purchase_orders SET updated_at = ? WHERE tenant_id = ? AND id = ?').run(currentTimestamp(), tenantId, row.id);
        outcome.updated += 1;
      }
      // Een afwijzing vervalt pas als de werkelijke voorraad (stand min reserveringen) weer op of boven het minimum zit,
      // niet al als wat besteld of onderweg is het artikel tijdelijk uit het voorstel haalt.
      const stale = prepare(`SELECT d.item_id FROM purchase_proposal_dismissals d
        JOIN stock_items i ON i.tenant_id = d.tenant_id AND i.id = d.item_id
        WHERE d.tenant_id = ? AND (i.archived = 1 OR i.has_variants = 1
          OR i.on_hand - (SELECT COALESCE(SUM(r.qty), 0) FROM stock_reservations r WHERE r.tenant_id = i.tenant_id AND r.item_id = i.id) >= i.min_qty)`)
        .all(tenantId).map((row) => row.item_id);
      for (let start = 0; start < stale.length; start += 500) {
        const chunk = stale.slice(start, start + 500);
        prepare(`DELETE FROM purchase_proposal_dismissals WHERE tenant_id = ? AND item_id IN (${placeholders(chunk.length)})`).run(tenantId, ...chunk);
      }
      withoutSupplierCache.delete(tenantId);
      return outcome;
    });
  }

  /**
   * Het overzicht van de automatische voorstellen: de voorstel-orders met regels, de afgewezen artikelen en hoeveel
   * artikelen onder het minimum geen voorkeursleverancier hebben (die komen nooit in een voorstel).
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ orders: object[], dismissed: object[], withoutSupplier: number }} Het overzicht.
   */
  function proposals(tenantId) {
    const rows = proposalRows(tenantId);
    const lines = linesByOrder(tenantId, rows.map((row) => row.id));
    const orders = rows.map((row) => {
      const orderLines = lines.get(row.id);
      return { ...orderOf(row), lines: orderLines, total: totalOf(orderLines), openQty: round3(orderLines.reduce((sum, line) => sum + line.openQty, 0)) };
    });
    const dismissed = prepare(`SELECT d.item_id, d.dismissed_at, i.code, i.name FROM purchase_proposal_dismissals d
      JOIN stock_items i ON i.tenant_id = d.tenant_id AND i.id = d.item_id WHERE d.tenant_id = ? ORDER BY i.code`).all(tenantId)
      .map((row) => ({ itemId: row.item_id, code: row.code, name: row.name, dismissedAt: row.dismissed_at }));
    let cached = withoutSupplierCache.get(tenantId);
    if (!cached || Date.now() - cached.at > WITHOUT_SUPPLIER_TTL_MS) {
      cached = { at: Date.now(), count: freshProposal(tenantId).items.filter((item) => !item.supplierId).length };
      withoutSupplierCache.set(tenantId, cached);
    }
    return { orders, dismissed, withoutSupplier: cached.count };
  }

  /**
   * Keurt concept-orders goed: elke order wordt besteld (place), elk in een eigen transactie.
   * @param {string} tenantId Id van de omgeving.
   * @param {*} rawIds De id's van de orders (hoogstens 100).
   * @returns {{ placed?: object[], failed?: object[], error?: string, field?: string }} Bestelde orders (id, nummer) en mislukte (id, melding), of een fout in de invoer.
   */
  function approve(tenantId, rawIds) {
    const ids = cleanIds(rawIds, MAX_APPROVE);
    if (!ids) return { error: `Geef 1 tot ${MAX_APPROVE} orders.`, field: 'ids' };
    const placed = [];
    const failed = [];
    for (const id of ids) {
      const out = place(tenantId, id);
      if (out.error) failed.push({ id, message: out.error === 'not_found' ? 'Inkooporder niet gevonden.' : out.error });
      else placed.push({ id: out.order.id, number: out.order.number });
    }
    return { placed, failed };
  }

  /**
   * Haalt regels (of zonder itemIds de hele order) uit een automatisch voorstel en onthoudt de afwijzing per artikel,
   * zodat de taak ze niet terugzet. Een voorstel zonder regels verdwijnt.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de voorstel-order.
   * @param {*} [rawItemIds] De artikelen om af te wijzen (leeg = alle regels).
   * @returns {{ order?: object|null, number?: string, removed?: boolean, dismissed?: number, error?: string, field?: string, status?: number }} De order (null als hij weg is), of een fout.
   */
  function dismiss(tenantId, orderId, rawItemIds) {
    const whole = rawItemIds === undefined || rawItemIds === null;
    const itemIds = whole ? null : cleanIds(rawItemIds, MAX_LINES);
    if (!whole && !itemIds) return { error: 'Geef de artikelen als lijst.', field: 'itemIds' };
    return transaction(db, () => {
      const row = findRow(tenantId, orderId);
      if (!row) return { error: 'not_found', status: 404 };
      if (row.status !== 'concept' || row.origin !== ORIGIN_PROPOSAL) return { error: 'Alleen een automatisch voorstel in concept is af te wijzen.', status: 409 };
      const lines = linesOf(tenantId, row.id);
      const onOrder = new Set(lines.map((line) => line.itemId));
      if (itemIds && itemIds.some((itemId) => !onOrder.has(itemId))) return { error: 'Een artikel staat niet op dit voorstel.', field: 'itemIds', status: 404 };
      const targets = itemIds || [...onOrder];
      const now = currentTimestamp();
      const upsert = prepare(`INSERT INTO purchase_proposal_dismissals (tenant_id, item_id, dismissed_at) VALUES (?, ?, ?)
        ON CONFLICT (tenant_id, item_id) DO UPDATE SET dismissed_at = excluded.dismissed_at`);
      for (const itemId of targets) upsert.run(tenantId, itemId, now);
      if (targets.length >= onOrder.size) {
        deleteOrder(tenantId, row.id);
        return { order: null, number: row.number, removed: true, dismissed: targets.length };
      }
      prepare(`DELETE FROM purchase_order_lines WHERE tenant_id = ? AND order_id = ? AND item_id IN (${placeholders(targets.length)})`).run(tenantId, row.id, ...targets);
      prepare('UPDATE purchase_orders SET updated_at = ? WHERE tenant_id = ? AND id = ?').run(now, tenantId, row.id);
      return { order: fullOrder(findRow(tenantId, row.id), tenantId), number: row.number, removed: false, dismissed: targets.length };
    });
  }

  /**
   * Haalt afwijzingen weg: de artikelen komen bij de volgende ronde van de taak (of vernieuwen) weer in het voorstel.
   * @param {string} tenantId Id van de omgeving.
   * @param {*} rawItemIds De artikelen.
   * @returns {{ restored?: number, error?: string, field?: string }} Het aantal weggehaalde afwijzingen, of een fout.
   */
  function restore(tenantId, rawItemIds) {
    const itemIds = cleanIds(rawItemIds, MAX_LINES);
    if (!itemIds) return { error: 'Geef de artikelen als lijst.', field: 'itemIds' };
    const out = prepare(`DELETE FROM purchase_proposal_dismissals WHERE tenant_id = ? AND item_id IN (${placeholders(itemIds.length)})`).run(tenantId, ...itemIds);
    return { restored: Number(out.changes) || 0 };
  }

  return { list, get, create, createReceived, update, place, receive, close, cancel, remove, incomingByItem, fromProposal, autoPropose, proposals, approve, dismiss, restore };
}

/**
 * Hangt de routes voor inkooporders aan de app (recht voorraad).
 * @param {object} app De Express-app.
 * @param {{ purchaseOrders: object, requireRight: Function, requireJson: Function, audit: Function, afterReceive?: Function, proposalsEnabled?: Function }} ctx De opslag en hulpfuncties van de server; afterReceive(tenantId, itemIds) draait na een ontvangst (backorders die nu leverbaar zijn); proposalsEnabled(tenantId) zegt of de automatische voorstellen aan staan (instelling purchaseProposals).
 * @returns {void}
 */
function registerPurchaseOrderRoutes(app, ctx) {
  const { purchaseOrders, requireRight, requireJson, audit, afterReceive = () => {}, proposalsEnabled = () => true } = ctx;
  const requireStock = requireRight('voorraad');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Stuurt het antwoord van een opslagfunctie: de fout (404, 409 of 400 met het veld) of het resultaat.
   * @param {object} res Het antwoord.
   * @param {object} out Het resultaat van de opslag.
   * @param {Function} onSuccess Maakt het antwoord als er geen fout is.
   * @returns {void}
   */
  const respond = (res, out, onSuccess) => {
    if (!out.error) return onSuccess(out);
    if (out.status === 404) return res.status(404).json({ error: 'not_found', message: out.error === 'not_found' ? 'Inkooporder niet gevonden.' : out.error, field: out.field });
    return res.status(out.status || 400).json({ error: out.status === 409 ? 'conflict' : 'invalid', message: out.error, field: out.field });
  };

  app.get('/api/purchase-orders', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: purchaseOrders.list(tenantOf(req), { status: String(req.query.status || ''), supplierId: String(req.query.supplierId || '') }) });
  });

  app.get('/api/purchase-orders/incoming', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: [...purchaseOrders.incomingByItem(tenantOf(req))].map(([itemId, qty]) => ({ itemId, qty })) });
  });

  app.post('/api/purchase-orders/from-proposal', requireStock, (req, res) => {
    const out = purchaseOrders.fromProposal(tenantOf(req), req.user);
    audit(req, 'inkooporders_uit_bestelvoorstel', { count: out.orders.length });
    res.status(201).json(out);
  });

  // Automatische bestelvoorstellen: bekijken, nu vernieuwen, goedkeuren (= bestellen), afwijzen en afwijzingen herstellen.
  app.get('/api/purchase-orders/proposals', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const tenantId = tenantOf(req);
    res.json({ ...purchaseOrders.proposals(tenantId), enabled: Boolean(proposalsEnabled(tenantId)) });
  });

  const refreshLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20, keyFn: (req) => `proposals-refresh:${tenantOf(req)}:${req.user && req.user.id}` });
  app.post('/api/purchase-orders/proposals/refresh', requireStock, refreshLimiter, (req, res) => {
    if (!proposalsEnabled(tenantOf(req))) return res.status(409).json({ error: 'proposals_off', message: 'Automatische bestelvoorstellen staan uit (Beheer > Instellingen).' });
    const out = purchaseOrders.autoPropose(tenantOf(req), req.user);
    audit(req, 'inkoopvoorstel_vernieuwd', { created: out.created, updated: out.updated, removed: out.removed });
    res.json(out);
  });

  app.post('/api/purchase-orders/proposals/approve', requireJson, requireStock, (req, res) => {
    const out = purchaseOrders.approve(tenantOf(req), req.body && req.body.ids);
    respond(res, out, () => {
      if (out.placed.length) audit(req, 'inkoopvoorstel_goedgekeurd', { numbers: out.placed.map((order) => order.number) });
      res.json(out);
    });
  });

  app.post('/api/purchase-orders/proposals/dismiss', requireJson, requireStock, (req, res) => {
    const body = req.body || {};
    const out = purchaseOrders.dismiss(tenantOf(req), body.orderId, body.itemIds);
    respond(res, out, () => {
      audit(req, 'inkoopvoorstel_afgewezen', { number: out.number, count: out.dismissed, removed: out.removed });
      res.json({ order: out.order, removed: out.removed, dismissed: out.dismissed });
    });
  });

  app.post('/api/purchase-orders/proposals/restore', requireJson, requireStock, (req, res) => {
    const out = purchaseOrders.restore(tenantOf(req), req.body && req.body.itemIds);
    respond(res, out, () => {
      audit(req, 'inkoopvoorstel_hersteld', { count: out.restored });
      res.json(out);
    });
  });

  app.get('/api/purchase-orders/:id', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const order = purchaseOrders.get(tenantOf(req), req.params.id);
    if (!order) return res.status(404).json({ error: 'not_found', message: 'Inkooporder niet gevonden.' });
    res.json(order);
  });

  app.post('/api/purchase-orders', requireJson, requireStock, (req, res) => {
    const receiveNow = Boolean(req.body && req.body.receiveNow === true);
    const out = receiveNow ? purchaseOrders.createReceived(tenantOf(req), req.user, req.body) : purchaseOrders.create(tenantOf(req), req.user, req.body);
    respond(res, out, () => {
      audit(req, receiveNow ? 'inkooporder_ingeboekt' : 'inkooporder_aangemaakt', { number: out.order.number });
      if (receiveNow) afterReceive(tenantOf(req), out.order.lines.map((line) => line.itemId));
      res.status(201).json(out.order);
    });
  });

  app.put('/api/purchase-orders/:id', requireJson, requireStock, (req, res) => {
    const out = purchaseOrders.update(tenantOf(req), req.params.id, req.body);
    respond(res, out, () => {
      audit(req, 'inkooporder_gewijzigd', { number: out.order.number });
      res.json(out.order);
    });
  });

  app.post('/api/purchase-orders/:id/place', requireStock, (req, res) => {
    const out = purchaseOrders.place(tenantOf(req), req.params.id);
    respond(res, out, () => {
      audit(req, 'inkooporder_besteld', { number: out.order.number });
      res.json(out.order);
    });
  });

  app.post('/api/purchase-orders/:id/receive', requireJson, requireStock, (req, res) => {
    const out = purchaseOrders.receive(tenantOf(req), req.params.id, req.user, req.body && req.body.lines);
    respond(res, out, () => {
      audit(req, 'inkooporder_ontvangen', { number: out.order.number, status: out.order.status });
      afterReceive(tenantOf(req), out.order.lines.map((line) => line.itemId));
      res.json(out.order);
    });
  });

  app.post('/api/purchase-orders/:id/close', requireStock, (req, res) => {
    const out = purchaseOrders.close(tenantOf(req), req.params.id);
    respond(res, out, () => {
      audit(req, 'inkooporder_afgesloten', { number: out.order.number });
      res.json(out.order);
    });
  });

  app.post('/api/purchase-orders/:id/cancel', requireStock, (req, res) => {
    const out = purchaseOrders.cancel(tenantOf(req), req.params.id);
    respond(res, out, () => {
      audit(req, 'inkooporder_geannuleerd', { number: out.order.number });
      res.json(out.order);
    });
  });

  app.delete('/api/purchase-orders/:id', requireStock, (req, res) => {
    const out = purchaseOrders.remove(tenantOf(req), req.params.id);
    respond(res, out, () => {
      audit(req, 'inkooporder_verwijderd', { number: out.number });
      res.json({ deleted: true });
    });
  });
}

module.exports = { createPurchaseOrderStore, registerPurchaseOrderRoutes, sanitizeOrder };
