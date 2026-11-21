// Reserveringen horen bij een werkorder óf een webshopbestelling, elk met een echte verwijzing (migratie 96).
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createStockStore } = require('../src/artikelen/stock');
const { importLines } = require('../src/database/table-rows');

/** Vaste uuid's van de werkorder, de bestelling en een onbekende order. */
const WORK_ORDER_ID = '00000000-0000-4000-8000-0000000000a1';
const WEB_ORDER_ID = '00000000-0000-4000-8000-0000000000a2';
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ff';

/**
 * Maakt een omgeving met een artikel, een werkorder en een webshopbestelling.
 * @returns {{ db: object, tenantId: string, itemId: string, workOrderId: string }} De opzet.
 */
function scene() {
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  const owner = store.createCustomer(tenantId, { displayName: 'Eigenaar' }).user;
  const item = createStockStore(db).create(tenantId, { id: null, display_name: 'Test' }, { code: 'A-1', name: 'Artikel' }).item;
  const now = '2026-11-21T10:00:00Z';
  db.prepare("INSERT INTO work_orders (id, tenant_id, owner_id, number, status, data, created_at, updated_at) VALUES (?, ?, ?, 'W-A', 'open', '{}', ?, ?)").run(WORK_ORDER_ID, tenantId, owner.id, now, now);
  db.prepare("INSERT INTO web_orders (id, tenant_id, number, status, customer_name, email, total, data, created_at, updated_at) VALUES (?, ?, 'B-A', 'nieuw', 'Klant', 'k@example.nl', 1, '{}', ?, ?)").run(WEB_ORDER_ID, tenantId, now, now);
  return { db, tenantId, itemId: item.id, workOrderId: WORK_ORDER_ID };
}

test('een reservering heeft precies één eigenaar en verwijst naar een bestaande order', () => {
  const { db, tenantId, itemId } = scene();
  /**
   * Zet een reservering van 1 stuk met de gegeven eigenaren.
   * @param {?string} workOrderId Werkorder, of null.
   * @param {?string} webOrderId Webshopbestelling, of null.
   * @returns {object} Het resultaat van de insert.
   */
  const put = (workOrderId, webOrderId) => db.prepare('INSERT INTO stock_reservations (tenant_id, work_order_id, web_order_id, item_id, qty, updated_at) VALUES (?, ?, ?, ?, 1, ?)').run(tenantId, workOrderId, webOrderId, itemId, '2026-11-21T10:00:00Z');
  assert.throws(() => put(null, null), /one_owner|check/i, 'zonder eigenaar mag niet');
  assert.throws(() => put(WORK_ORDER_ID, WEB_ORDER_ID), /one_owner|check/i, 'twee eigenaars mag niet');
  assert.throws(() => put(UNKNOWN_ID, null), /foreign key|fkey|violates/i, 'een onbekende werkorder mag niet');
  assert.throws(() => put(null, UNKNOWN_ID), /foreign key|fkey|violates/i, 'een onbekende bestelling mag niet');
  put(WORK_ORDER_ID, null);
  assert.throws(() => put(WORK_ORDER_ID, null), /unique|duplicate/i, 'een artikel eenmaal per werkorder');
});

test('een reservering verdwijnt mee met haar order', () => {
  const { db, tenantId, itemId } = scene();
  const stock = createStockStore(db);
  stock.reserveOrder(tenantId, WEB_ORDER_ID, [{ itemId, qty: 2 }]);
  db.prepare('INSERT INTO stock_reservations (tenant_id, work_order_id, item_id, qty, updated_at) VALUES (?, ?, ?, 1, ?)').run(tenantId, WORK_ORDER_ID, itemId, '2026-11-21T10:00:00Z');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stock_reservations').get().n, 2);
  db.prepare("DELETE FROM web_orders WHERE id = ?").run(WEB_ORDER_ID);
  db.prepare("DELETE FROM work_orders WHERE id = ?").run(WORK_ORDER_ID);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stock_reservations').get().n, 0);
});

test('een back-up van vóór migratie 96 (order:<id> in work_order_id) wordt gesplitst teruggezet', async () => {
  const { db, tenantId, itemId } = scene();
  const header = JSON.stringify({ format: 'aquatech-backup', version: 2, schemaVersion: 1 });
  const columns = JSON.stringify({ table: 'stock_reservations', columns: ['tenant_id', 'work_order_id', 'item_id', 'qty', 'updated_at'] });
  const rows = [[tenantId, `order:${WEB_ORDER_ID}`, itemId, 3, '2026-11-21T10:00:00Z'], [tenantId, WORK_ORDER_ID, itemId, 1, '2026-11-21T10:00:00Z']].map((row) => JSON.stringify(row));
  // Alleen de reserveringen komen uit het bestand; de orders bestaan al in deze database.
  /**
   * De regels van het nagebootste bestand, één voor één.
   * @returns {AsyncGenerator<string>} De regels.
   */
  async function* lines() { for (const line of [header, columns, ...rows]) yield line; }
  db.prepare('DELETE FROM stock_reservations').run();
  await importLines(db, lines());
  const stored = db.prepare('SELECT work_order_id, web_order_id, qty FROM stock_reservations ORDER BY qty').all();
  assert.deepStrictEqual(stored.map((row) => [row.work_order_id, row.web_order_id, Number(row.qty)]), [[WORK_ORDER_ID, null, 1], [null, WEB_ORDER_ID, 3]]);
});
