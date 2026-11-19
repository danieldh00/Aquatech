// Kengetallen voor het beheerdersdashboard: bedragen en aantallen per omgeving, en welk recht bij welke tegel hoort.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { buildKpis, weekOf } = require('../src/platform/kpis');

const TODAY = '2026-11-19'; // donderdag

/**
 * Maakt een database met twee omgevingen en voorbeeldgegevens.
 * @returns {{ db: object, mainId: string, otherId: string }} De database en de omgevings-id's.
 */
function setup() {
  const db = openDb();
  const store = createStore(db);
  const mainId = store.ensureTenant('kpi-hoofd', 'Hoofd').id;
  const otherId = store.ensureTenant('kpi-ander', 'Ander').id;
  const mainUser = store.systemUser(mainId, 'kpi-systeem', 'Systeem').id;
  const otherUser = store.systemUser(otherId, 'kpi-systeem', 'Systeem').id;
  /**
   * Voegt een factuur toe.
   * @param {string} tenantId De omgeving.
   * @param {string} number Het factuurnummer.
   * @param {{ status: string, kind?: string, due: string, total: number }} fields Status, soort, vervaldatum en totaal.
   * @returns {void}
   */
  const invoice = (tenantId, number, { status, kind = 'factuur', due, total }) => db.prepare(
    'INSERT INTO invoices (id, tenant_id, number, status, kind, invoice_date, due_date, total, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(`${tenantId}-${number}`, tenantId, number, status, kind, '2026-10-01', due, total, '{}', '2026-10-01', '2026-10-01');
  invoice(mainId, 'F1', { status: 'definitief', due: '2026-11-01', total: 121 });
  invoice(mainId, 'F2', { status: 'definitief', due: '2026-12-01', total: 242 });
  invoice(mainId, 'F3', { status: 'betaald', due: '2026-11-01', total: 500 });
  invoice(mainId, 'F4', { status: 'concept', due: '2026-11-01', total: 900 });
  invoice(mainId, 'C1', { status: 'definitief', kind: 'credit', due: '2026-11-01', total: -21 });
  invoice(otherId, 'X1', { status: 'definitief', due: '2026-11-01', total: 7777 });
  /**
   * Voegt een offerte toe.
   * @param {string} tenantId De omgeving.
   * @param {string} owner De eigenaar.
   * @param {string} number Het nummer.
   * @param {string} status De status.
   * @param {number} total Het totaal excl. btw.
   * @param {string|null} deletedAt Verwijderdatum of null.
   * @returns {void}
   */
  const quote = (tenantId, owner, number, status, total, deletedAt = null) => db.prepare(
    'INSERT INTO quotes (id, tenant_id, owner_id, number, status, total_excl, data, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(`${tenantId}-${number}`, tenantId, owner, number, status, total, '{}', '2026-11-01', '2026-11-01', deletedAt);
  quote(mainId, mainUser, 'O1', 'verzonden', 1000);
  quote(mainId, mainUser, 'O2', 'verzonden', 500);
  quote(mainId, mainUser, 'O3', 'verzonden', 99, '2026-11-02');
  quote(mainId, mainUser, 'O4', 'akkoord', 300);
  quote(otherId, otherUser, 'O5', 'verzonden', 4000);
  /**
   * Voegt een werkorder toe.
   * @param {string} tenantId De omgeving.
   * @param {string} owner De eigenaar en uitvoerder.
   * @param {string} number Het nummer.
   * @param {string} status De status.
   * @param {string|null} planned De geplande datum.
   * @returns {void}
   */
  const workOrder = (tenantId, owner, number, status, planned) => db.prepare(
    'INSERT INTO work_orders (id, tenant_id, owner_id, number, status, planned_date, assignee_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(`${tenantId}-${number}`, tenantId, owner, number, status, planned, owner, '{}', '2026-11-01', '2026-11-01');
  workOrder(mainId, mainUser, 'W1', 'gepland', '2026-11-16');
  workOrder(mainId, mainUser, 'W2', 'bezig', '2026-11-22');
  workOrder(mainId, mainUser, 'W3', 'gepland', '2026-11-23');
  workOrder(mainId, mainUser, 'W4', 'geannuleerd', '2026-11-18');
  workOrder(mainId, mainUser, 'W5', 'open', null);
  workOrder(otherId, otherUser, 'W6', 'gepland', '2026-11-17');
  return { db, mainId, otherId };
}

/**
 * Zet de tegels om naar sleutel en waarde.
 * @param {object[]} tiles De tegels.
 * @returns {object} Sleutel → waarde.
 */
const values = (tiles) => Object.fromEntries(tiles.map((tile) => [tile.key, tile.value]));

test('weekOf geeft maandag tot zondag', () => {
  assert.deepStrictEqual(weekOf('2026-11-19'), { from: '2026-11-16', to: '2026-11-22' });
  assert.deepStrictEqual(weekOf('2026-11-22'), { from: '2026-11-16', to: '2026-11-22' });
  assert.deepStrictEqual(weekOf('2026-11-16'), { from: '2026-11-16', to: '2026-11-22' });
});

test('kengetallen tellen alleen de eigen omgeving en negeren concepten, betaalde, verwijderde en geannuleerde', () => {
  const { db, mainId, otherId } = setup();
  const admin = { rights: ['beheer', 'facturen', 'offertes', 'planning'] };
  const main = buildKpis({ user: admin, tenantId: mainId }, { db, today: TODAY });
  assert.deepStrictEqual(values(main), { openstaand: 342, vervallen: 1, offertes: 2, bezetting: 2 });
  assert.match(main.find((tile) => tile.key === 'offertes').detail, /1500,00 euro/);
  const other = buildKpis({ user: admin, tenantId: otherId }, { db, today: TODAY });
  assert.deepStrictEqual(values(other), { openstaand: 7777, vervallen: 1, offertes: 1, bezetting: 1 });
});

test('elke tegel hoort bij een recht en zonder beheer is er niets', () => {
  const { db, mainId } = setup();
  /**
   * Geeft de sleutels van de tegels die deze rechten zien.
   * @param {string[]} rights De rechten.
   * @returns {string[]} De sleutels.
   */
  const keys = (rights) => buildKpis({ user: { rights }, tenantId: mainId }, { db, today: TODAY }).map((tile) => tile.key);
  assert.deepStrictEqual(keys(['beheer']), []);
  assert.deepStrictEqual(keys(['beheer', 'facturen']), ['openstaand', 'vervallen']);
  assert.deepStrictEqual(keys(['beheer', 'offertes']), ['offertes']);
  assert.deepStrictEqual(keys(['beheer', 'planning']), ['bezetting']);
  assert.deepStrictEqual(keys(['facturen', 'offertes', 'planning']), [], 'zonder beheer geen kengetallen');
});
