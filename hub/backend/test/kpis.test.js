// Kengetallen voor het beheerdersdashboard: bedragen en aantallen per omgeving, en welk recht bij welke tegel hoort.
const test = require('node:test');
const express = require('express');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { buildKpis, weekOf, registerKpiRoutes } = require('../src/platform/kpis');
const { sanitizeDashboardKpis, describeCatalog, rangeOf } = require('../src/platform/kpi-catalog');

/**
 * Maakt een instelling waarin alleen deze KPI's aan staan, in deze volgorde.
 * @param {string[]} keys De sleutels.
 * @returns {object} De instelling.
 */
const only = (keys) => ({ items: [...keys.map((key) => ({ key, enabled: true })), ...sanitizeDashboardKpis({}).items.filter((item) => !keys.includes(item.key)).map((item) => ({ key: item.key, enabled: false }))], period: 'maand' });
/** De vier tegels van de eerste versie (met bezetting). */
const FIRST = only(['openstaand', 'vervallen', 'offertes', 'bezetting']);
/** Instelling met alle KPI's aan (zoals een beheerder die alles aanzet). */
const ALL_ON = { items: sanitizeDashboardKpis({}).items.map((item) => ({ key: item.key, enabled: true })), period: 'maand' };
const { createClient, listen } = require('./helpers/http-client');

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
  ).run(randomUUID(), tenantId, number, status, kind, '2026-10-01', due, total, '{}', '2026-10-01', '2026-10-01');
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
  ).run(randomUUID(), tenantId, owner, number, status, total, '{}', '2026-11-01', '2026-11-01', deletedAt);
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
  ).run(randomUUID(), tenantId, owner, number, status, planned, owner, '{}', '2026-11-01', '2026-11-01');
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
  const main = buildKpis({ user: admin, tenantId: mainId }, { db, today: TODAY, config: FIRST });
  assert.deepStrictEqual(values(main), { openstaand: 342, vervallen: 1, offertes: 2, bezetting: 2 });
  assert.match(main.find((tile) => tile.key === 'offertes').detail, /€ 1\.500,00/);
  const other = buildKpis({ user: admin, tenantId: otherId }, { db, today: TODAY, config: FIRST });
  assert.deepStrictEqual(values(other), { openstaand: 7777, vervallen: 1, offertes: 1, bezetting: 1 });
});

test('elke tegel hoort bij een recht en zonder beheer is er niets', () => {
  const { db, mainId } = setup();
  /**
   * Geeft de sleutels van de tegels die deze rechten zien.
   * @param {string[]} rights De rechten.
   * @returns {string[]} De sleutels.
   */
  const keys = (rights) => buildKpis({ user: { rights }, tenantId: mainId }, { db, today: TODAY, config: FIRST }).map((tile) => tile.key);
  assert.deepStrictEqual(keys(['beheer']), []);
  assert.deepStrictEqual(keys(['beheer', 'facturen']), ['openstaand', 'vervallen']);
  assert.deepStrictEqual(keys(['beheer', 'offertes']), ['offertes']);
  assert.deepStrictEqual(keys(['beheer', 'planning']), ['bezetting']);
  assert.deepStrictEqual(keys(['facturen', 'offertes', 'planning']), [], 'zonder beheer geen kengetallen');
});

test('standaard staat bezetting uit en zijn de basiskengetallen aan', () => {
  const { db, mainId } = setup();
  const admin = { rights: ['beheer', 'facturen', 'offertes', 'planning', 'werkorders', 'voorraad'] };
  const tiles = buildKpis({ user: admin, tenantId: mainId }, { db, today: TODAY });
  assert.deepStrictEqual(tiles.map((tile) => tile.key), ['openstaand', 'vervallen', 'omzet', 'offertes']);
  assert.strictEqual(tiles.find((tile) => tile.key === 'omzet').period, 'Deze maand');
});

test('instelling: volgorde, uitzetten, onbekende sleutels weg en nieuwe KPI achteraan', () => {
  const clean = sanitizeDashboardKpis({ items: [{ key: 'offertes', enabled: true }, { key: 'bestaat-niet', enabled: true }, { key: 'offertes', enabled: false }, { key: 'openstaand', enabled: false }], period: 'kwartaal' });
  assert.deepStrictEqual(clean.items.slice(0, 2), [{ key: 'offertes', enabled: true }, { key: 'openstaand', enabled: false }]);
  assert.strictEqual(clean.period, 'maand', 'onbekende periode valt terug op de standaard');
  assert.ok(clean.items.some((item) => item.key === 'bezetting' && item.enabled === false), 'ontbrekende KPI komt terug met zijn standaardstand');
  assert.strictEqual(new Set(clean.items.map((item) => item.key)).size, clean.items.length);
  const { db, mainId } = setup();
  const admin = { rights: ['beheer', 'facturen', 'offertes'] };
  const tiles = buildKpis({ user: admin, tenantId: mainId }, { db, today: TODAY, config: only(['offertes', 'openstaand']) });
  assert.deepStrictEqual(tiles.map((tile) => tile.key), ['offertes', 'openstaand'], 'volgorde van de instelling');
});

test('een module die uit staat geeft geen tegels en is niet beschikbaar in het keuzescherm', () => {
  const { db, mainId } = setup();
  const admin = { rights: ['beheer', 'facturen', 'offertes'] };
  /**
   * Nep-moduleschakelaar: alleen facturen staat uit.
   * @param {string} moduleId De module.
   * @returns {boolean} Of de module aan staat.
   */
  const isModuleOn = (moduleId) => moduleId !== 'facturen';
  const tiles = buildKpis({ user: admin, tenantId: mainId }, { db, today: TODAY, config: ALL_ON, isModuleOn });
  assert.ok(tiles.length > 0 && tiles.every((tile) => !['openstaand', 'vervallen', 'omzet'].includes(tile.key)));
  const described = describeCatalog(undefined, isModuleOn);
  assert.strictEqual(described.items.find((item) => item.key === 'openstaand').available, false);
  assert.strictEqual(described.items.find((item) => item.key === 'offertes').available, true);
});

test('periodes en nieuwe kengetallen rekenen per omgeving', () => {
  assert.deepStrictEqual(rangeOf('maand', TODAY), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepStrictEqual(rangeOf('30dagen', TODAY), { from: '2026-10-21', to: '2026-11-19' });
  assert.deepStrictEqual(rangeOf('jaar', TODAY), { from: '2026-01-01', to: '2026-12-31' });
  const { db, mainId, otherId } = setup();
  db.prepare("INSERT INTO invoices (id, tenant_id, number, status, kind, invoice_date, due_date, subtotal, total, data, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000000c1', ?, 'V1', 'definitief', 'factuur', '2026-11-05', '2026-12-05', 100, 121, '{}', '2026-11-05', '2026-11-05')").run(mainId);
  db.prepare("INSERT INTO web_orders (id, tenant_id, number, status, customer_name, email, total, data, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000000c2', ?, 'W1', 'nieuw', 'A', 'a@example.nl', 50, '{}', '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z')").run(mainId);
  db.prepare("INSERT INTO web_orders (id, tenant_id, number, status, customer_name, email, total, data, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000000c3', ?, 'W2', 'geannuleerd', 'B', 'b@example.nl', 70, '{}', '2026-11-11T10:00:00.000Z', '2026-11-11T10:00:00.000Z')").run(mainId);
  db.prepare("INSERT INTO web_orders (id, tenant_id, number, status, customer_name, email, total, data, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000000c4', ?, 'W3', 'nieuw', 'C', 'c@example.nl', 999, '{}', '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z')").run(otherId);
  const admin = { rights: ['beheer', 'facturen', 'offertes', 'werkorders', 'voorraad'] };
  const tiles = buildKpis({ user: admin, tenantId: mainId }, { db, today: TODAY, config: ALL_ON });
  const byKey = Object.fromEntries(tiles.map((tile) => [tile.key, tile]));
  assert.strictEqual(byKey.omzet.value, 100, 'alleen de factuur van deze maand');
  assert.strictEqual(byKey.webshop_omzet.value, 50, 'geannuleerd en andere omgeving tellen niet mee');
  assert.strictEqual(byKey.webshop_nieuw.value, 1);
  assert.strictEqual(byKey.werkorders_open.unit, 'aantal');
  assert.strictEqual(byKey.voorraad_minimum.value, 0);
  assert.strictEqual(byKey.inkooporders_open.value, 0);
  assert.ok(!byKey.bezetting, 'zonder recht planning geen bezetting');
  const year = buildKpis({ user: admin, tenantId: mainId }, { db, today: TODAY, config: { ...ALL_ON, period: 'jaar' } });
  assert.match(year.find((tile) => tile.key === 'omzet').detail, /5 documenten/);
});

test('route: zonder inlog 401, zonder beheer 403, alleen de eigen omgeving, vier queries', async () => {
  const { db, mainId, otherId } = setup();
  let queries = 0;
  const prepare = db.prepare.bind(db);
  /**
   * Telt elke query en geeft het statement door.
   * @param {string} sql De SQL.
   * @returns {object} Het statement.
   */
  db.prepare = (sql) => { queries += 1; return prepare(sql); };
  const app = express();
  app.use((req, _res, next) => { req.tenantId = req.headers['x-tenant']; next(); });
  /**
   * Nep-identificatie: de gebruiker komt uit de testkop.
   * @param {object} req Het verzoek.
   * @returns {object|null} De gebruiker met rechten, of null.
   */
  const identify = (req) => (req.headers['x-rights'] ? { rights: String(req.headers['x-rights']).split(',') } : null);
  registerKpiRoutes(app, { identify, db });
  const { server, base } = await listen(app);
  try {
    const http = createClient(base);
    /**
     * Vraagt de kengetallen op als een gebruiker met deze rechten.
     * @param {string} tenant De omgeving.
     * @param {string} [rights] De rechten, komma-gescheiden (leeg = niet ingelogd).
     * @returns {Promise<object>} Het antwoord.
     */
    const get = (tenant, rights) => http.get('/api/kpis', { 'x-tenant': tenant, ...(rights ? { 'x-rights': rights } : {}) });
    assert.strictEqual((await get(mainId)).status, 401);
    assert.strictEqual((await get(mainId, 'facturen,offertes,planning')).status, 403, 'zonder beheer geen kengetallen');
    queries = 0;
    const main = await get(mainId, 'beheer,facturen,offertes,planning');
    assert.strictEqual(main.status, 200);
    assert.strictEqual(queries, 4, 'één query per tegel');
    assert.deepStrictEqual(main.body.kpis.map((tile) => tile.key), ['openstaand', 'vervallen', 'omzet', 'offertes']);
    const other = await get(otherId, 'beheer,facturen');
    assert.strictEqual(other.body.kpis.find((tile) => tile.key === 'openstaand').value, 7777, 'andere omgeving ziet alleen zijn eigen bedragen');
  } finally { server.close(); }
});
