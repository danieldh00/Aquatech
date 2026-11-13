// Asynchrone database (db.async, async-db.js en pg-pool.js): dezelfde SQL als db.prepare met een Promise, geen
// transacties, en met PostgreSQL een pool die de hoofdthread niet stilzet, queries tegelijk uitvoert en de
// tenantafscherming per verzoek volgt. Ook: de webshopcatalogus warm maken via de pool.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { withScope, limitTo } = require('../src/database/tenant-scope');
const { createStorefrontData } = require('../src/webshop/storefront-data');

const onPostgres = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Opent een database met twee organisaties.
 * @returns {{ db: object, mine: string, theirs: string }} De database en de id's van de twee organisaties.
 */
function openWithTenants() {
  const db = openDb();
  const store = createStore(db);
  const mine = store.ensureTenant().id;
  const theirs = store.createTenant({ slug: `ander${crypto.randomBytes(3).toString('hex')}`, name: 'Ander BV' }).tenant.id;
  return { db, mine, theirs };
}

/**
 * Voegt een instelling toe voor een omgeving (een tabel met tenant_id, voor de afscherming).
 * @param {object} db De database.
 * @param {string} tenantId De omgeving.
 * @param {string} key De sleutel.
 * @returns {void}
 */
function addSetting(db, tenantId, key) {
  db.prepare('INSERT INTO settings (tenant_id, key, value, updated_at) VALUES (?, ?, ?, ?)').run(tenantId, key, '"x"', new Date().toISOString());
}

test('db.async: get, all en run met ?-parameters, transacties geweigerd', async () => {
  const { db, mine: tenantId } = openWithTenants();
  const changed = await db.async.run('INSERT INTO settings (tenant_id, key, value, updated_at) VALUES (?, ?, ?, ?)', tenantId, 'a', '"1"', new Date().toISOString());
  assert.strictEqual(changed.changes, 1);
  assert.strictEqual((await db.async.get('SELECT key FROM settings WHERE tenant_id = ? AND key = ?', tenantId, 'a')).key, 'a');
  assert.strictEqual((await db.async.all('SELECT key FROM settings WHERE tenant_id = ?', tenantId)).length, 1);
  assert.strictEqual(await db.async.get('SELECT key FROM settings WHERE tenant_id = ? AND key = ?', tenantId, 'geen'), undefined);
  for (const sql of ['BEGIN', ' begin immediate', 'COMMIT', 'ROLLBACK', 'SAVEPOINT x']) await assert.rejects(db.async.run(sql), /Transacties/);
  // Een fout van de database komt als afgewezen Promise terug.
  await assert.rejects(db.async.get('SELECT nietbestaand FROM settings'));
  assert.strictEqual(db.async.pooled, onPostgres);
});

test('db.async in PostgreSQL: queries tegelijk, hoofdthread loopt door', { skip: !onPostgres && 'alleen tegen PostgreSQL' }, async () => {
  const db = openDb();
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  const startedAt = Date.now();
  try {
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => db.async.get('SELECT pg_sleep(0.3), ? AS i', i)));
    assert.deepStrictEqual(results.map((row) => Number(row.i)), [0, 1, 2, 3]);
  } finally {
    clearInterval(timer);
  }
  // Vier keer 0,3 s na elkaar zou 1,2 s zijn; via de pool lopen ze tegelijk.
  assert.ok(Date.now() - startedAt < 1000, `${Date.now() - startedAt} ms`);
  assert.ok(ticks >= 5, `de timer liep ${ticks} keer`);
});

test('db.async in PostgreSQL: volgt de tenantafscherming van het verzoek en het eigen schema', { skip: !onPostgres && 'alleen tegen PostgreSQL' }, async () => {
  const { db, mine, theirs } = openWithTenants();
  const { db: other, mine: otherMain } = openWithTenants();
  addSetting(db, mine, 'eigen');
  addSetting(db, theirs, 'vreemd');
  addSetting(other, otherMain, 'ander-schema');
  /**
   * De sleutels van de testinstellingen die deze database (via de pool) laat zien.
   * @param {object} database De database.
   * @returns {Promise<string[]>} De sleutels, gesorteerd.
   */
  const keysOf = async (database) => (await database.async.all("SELECT key FROM settings WHERE key IN ('eigen', 'vreemd', 'ander-schema') ORDER BY key")).map((row) => row.key);
  assert.deepStrictEqual(await keysOf(db), ['eigen', 'vreemd']);
  assert.deepStrictEqual(await keysOf(other), ['ander-schema']);
  if (db.tenantRls) {
    await withScope(async () => {
      limitTo([mine]);
      assert.deepStrictEqual(await keysOf(db), ['eigen']);
      assert.strictEqual((await db.async.run('UPDATE settings SET value = ? WHERE key = ?', '"y"', 'vreemd')).changes, 0);
    });
  }
  // Daarna (zonder beperking) weer alles, ook op dezelfde verbindingen.
  assert.deepStrictEqual(await keysOf(db), ['eigen', 'vreemd']);
});

test('webshop: warm vult de catalogus via db.async, daarna geen query meer', async () => {
  const { db, mine: tenantId } = openWithTenants();
  const data = createStorefrontData(db);
  let syncQueries = 0;
  const prepare = db.prepare.bind(db);
  /**
   * Telt elke synchrone query.
   * @param {string} sql De SQL.
   * @returns {object} Het statement.
   */
  db.prepare = (sql) => { syncQueries++; return prepare(sql); };
  await Promise.all([data.warm(tenantId), data.warm(tenantId)]);
  const catalog = data.catalogOf(tenantId);
  assert.ok(Array.isArray(catalog.products));
  assert.strictEqual(syncQueries, 0);
  // Na wissen haalt de volgende pagina hem weer op.
  data.clearCache();
  data.catalogOf(tenantId);
  assert.strictEqual(syncQueries, 2);
});
