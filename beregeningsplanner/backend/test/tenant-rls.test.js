// Tenantafscherming in PostgreSQL (2 uit de audit van 1.7.3): policies op elke tabel met tenant_id laten binnen een
// verzoek van een gebruiker alleen rijen van de eigen organisatie door, ook als een query het tenantfilter vergeet.
// Alleen met TEST_DATABASE_URL (SQLite kent geen policies); de rekenregels van tenant-scope.js gelden altijd.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const crypto = require('crypto');
const { createApp } = require('../src/server');
const { openDb, listTables, tableColumns } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { withScope, limitTo, asSystem, scopeKey } = require('../src/database/tenant-scope');
const { createLogin, listen } = require('./helpers/http-client');

const needPg = { skip: !process.env.TEST_DATABASE_URL && 'zet TEST_DATABASE_URL voor tests tegen PostgreSQL' };
const SECRET = 'r'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

test('scopeKey: leeg buiten een verzoek en als systeem, anders de omgevingen zonder dubbelen', () => {
  assert.strictEqual(scopeKey(), '');
  withScope(() => {
    assert.strictEqual(scopeKey(), '');
    limitTo(['a', 'b', 'a', '', 'x,y']);
    assert.strictEqual(scopeKey(), 'a,b');
    assert.strictEqual(asSystem(() => scopeKey()), '');
    assert.strictEqual(scopeKey(), 'a,b');
    limitTo([]);
    assert.strictEqual(scopeKey(), '');
  });
});

test('policy: een query zonder tenantfilter ziet in een verzoek alleen de eigen organisatie', needPg, () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  const other = store.createTenant({ slug: `rls${crypto.randomBytes(3).toString('hex')}`, name: 'Ander BV' }).tenant.id;
  const insert = db.prepare("INSERT INTO settings (tenant_id, key, value, updated_at) VALUES (?, 'rlsTest', ?, ?)");
  const now = new Date().toISOString();
  insert.run(main, 'Plan hoofdtenant', now);
  insert.run(other, 'Plan ander', now);
  /**
   * De testwaarden die deze verbinding nu ziet.
   * @returns {string[]} De waarden, op volgorde.
   */
  const names = () => db.prepare("SELECT value AS name FROM settings WHERE key = 'rlsTest' ORDER BY value").all().map((row) => row.name);
  assert.deepStrictEqual(names(), ['Plan ander', 'Plan hoofdtenant']);
  withScope(() => {
    limitTo([other]);
    assert.deepStrictEqual(names(), ['Plan ander']);
    // Ook schrijven raakt geen rijen van een ander.
    assert.strictEqual(db.prepare("UPDATE settings SET value = 'gekaapt' WHERE key = 'rlsTest'").run().changes, 1);
    assert.deepStrictEqual(asSystem(names), ['Plan hoofdtenant', 'gekaapt']);
    // Na een teruggedraaide transactie geldt de beperking nog steeds.
    db.exec('BEGIN');
    db.exec('ROLLBACK');
    assert.deepStrictEqual(names(), ['gekaapt']);
  });
  assert.deepStrictEqual(names(), ['Plan hoofdtenant', 'gekaapt']);
});

test('policy op elke tabel (met tenant_id beperkt, behalve bewust gedeelde)', needPg, () => {
  const db = openDb();
  const withTenant = listTables(db).filter((table) => tableColumns(db, table).some((column) => column.name === 'tenant_id'));
  const policies = new Set(db.prepare("SELECT tablename FROM pg_policies WHERE schemaname = current_schema() AND policyname = 'aquatech_tenant'").all().map((row) => row.tablename));
  for (const table of withTenant) {
    if (table === 'work_order_offers') continue;
    assert.ok(policies.has(table), table);
  }
});

test('via de app: een beheerder van een andere organisatie ziet geen plannen van de hoofdtenant', needPg, async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW, mustChangePassword: false });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, loginDelayMs: 0 }));
  servers.push(server);
  const login = createLogin(base, { password: PW });
  const baas = await login('baas');
  assert.strictEqual((await baas.post('/app/api/plans', { name: 'Tuin hoofdtenant', data: { areas: [] } })).status, 201);
  const vreemd = await login('vreemd', 'ander');
  assert.deepStrictEqual((await vreemd.get('/app/api/admin/plans')).body.items, []);
  assert.strictEqual((await baas.get('/app/api/admin/plans')).body.items.length, 1);
});
