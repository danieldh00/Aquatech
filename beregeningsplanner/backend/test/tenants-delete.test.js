// Organisaties verwijderen (alles met tenant_id, ook testomgevingen) en geaccordeerde offertes alleen met bevestiging.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb, isPg, listTables, tableColumns } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createClient, listen } = require('./helpers/http-client');

const SECRET = 'z'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Start een testserver op de gegeven database.
 * @param {object} db De database.
 * @param {object} [opts] Extra opties voor createApp.
 * @returns {Promise<{ server: import('http').Server, base: string }>} De server en zijn adres.
 */
function start(db, opts = {}) {
  return listen(createApp({ secret: SECRET, db, ...opts }));
}

/**
 * Maakt een eenvoudig plan met één gazon.
 * @param {string} name Naam van het plan.
 * @returns {object} De plangegevens.
 */
const plan = (name) => ({
  meta: { name, customer: 'Fam. Jansen', address: 'Dorpsstraat 1' },
  areas: [{ id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }] }],
  sprinklers: [], zones: [], elements: [],
});

/**
 * Platform met een hoofdbeheerder ('baas') in de hoofdtenant.
 * @returns {Promise<object>} De database.
 */
async function platformDb() {
  const db = openDb();
  const store = createStore(db);
  await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  return db;
}

/**
 * Alle tabellen met een kolom tenant_id.
 * @param {object} db De database.
 * @returns {string[]} De tabelnamen.
 */
const tenantTables = (db) => listTables(db).filter((table) => tableColumns(db, table).some((column) => column.name === 'tenant_id'));

test('hoofdbeheerder verwijdert een tenant met testomgevingen en al zijn gegevens', async () => {
  const db = await platformDb();
  const { server, base } = await start(db);
  try {
    const baas = createClient(base);
    await baas.login('baas', PW);
    assert.strictEqual((await baas.post('/app/api/plans', { data: plan('Plan van Aquatech') })).status, 201);
    const tenant = (await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!', mustChangePassword: false } })).body.tenant;
    const piet = createClient(base);
    assert.strictEqual((await piet.login('piet', 'Gras-Pomp-2027!', 'groen')).status, 200);
    assert.strictEqual((await piet.post('/app/api/plans', { data: plan('Tuin van Groen') })).status, 201);
    const env = (await baas.post(`/app/api/platform/tenants/${tenant.id}/environments`, { name: 'Test', copyPlans: true })).body.tenant;
    assert.strictEqual((await baas.post(`/app/api/platform/tenants/${env.id}/testdata`)).status, 201);

    // Alleen hoofdbeheerders; de beheerder van de tenant zelf niet.
    assert.strictEqual((await piet.del(`/app/api/platform/tenants/${tenant.id}`, { confirm: 'groen' })).status, 403);
    // Zonder (of met een verkeerde) tenantcode gebeurt er niets.
    assert.strictEqual((await baas.del(`/app/api/platform/tenants/${tenant.id}`)).body.error, 'confirm_required');
    assert.strictEqual((await baas.del(`/app/api/platform/tenants/${tenant.id}`, { confirm: 'groen-bv' })).status, 400);
    assert.ok(createStore(db).getTenant(tenant.id));

    const out = await baas.del(`/app/api/platform/tenants/${tenant.id}`, { confirm: 'Groen ' });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.strictEqual(out.body.environments, 1);

    for (const table of tenantTables(db)) {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id IN (?, ?)`).get(tenant.id, env.id).n;
      assert.strictEqual(count, 0, `${table} is leeg na verwijderen`);
    }
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM tenants WHERE id IN (?, ?)').get(tenant.id, env.id).n, 0);
    // PostgreSQL controleert foreign keys altijd (een fout had de COMMIT laten mislukken).
    if (!isPg(db)) {
      assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.strictEqual(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    }

    // Gebruikers en sessies zijn weg; de hoofdtenant is ongemoeid.
    assert.deepStrictEqual((await piet.get('/app/api/plans')).body.items, []);
    assert.strictEqual((await piet.get('/app/api/admin/users')).status, 401);
    assert.strictEqual((await piet.login('piet', 'Gras-Pomp-2027!', 'groen')).status, 401);
    assert.strictEqual((await baas.get('/app/api/plans')).body.items.length, 1);
    const tenants = (await baas.get('/app/api/platform/tenants')).body.items;
    assert.deepStrictEqual(tenants.map((x) => x.slug), ['default']);
    assert.ok((await baas.get('/app/api/admin/audit')).body.items.some((entry) => entry.action === 'tenant_verwijderd'));
  } finally {
    server.close();
  }
});

test('de hoofdtenant kan niet worden verwijderd', async () => {
  const db = await platformDb();
  const { server, base } = await start(db);
  try {
    const baas = createClient(base);
    await baas.login('baas', PW);
    const main = (await baas.get('/app/api/platform/tenants')).body.items[0];
    const out = await baas.del(`/app/api/platform/tenants/${main.id}`, { confirm: 'default' });
    assert.strictEqual(out.status, 409);
    assert.strictEqual((await baas.get('/app/api/me')).status, 200);
  } finally {
    server.close();
  }
});

test('geaccordeerde offerte alleen verwijderen met het offertenummer', async () => {
  const db = await platformDb();
  const { server, base } = await start(db);
  try {
    const baas = createClient(base);
    await baas.login('baas', PW);
    const tenant = (await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen' })).body.tenant;
    const env = (await baas.post(`/app/api/platform/tenants/${tenant.id}/environments`, { name: 'Test' })).body.tenant;
    assert.strictEqual((await baas.post(`/app/api/platform/tenants/${env.id}/testdata`)).status, 201);
    assert.strictEqual((await baas.post('/app/api/environment', { tenantId: env.id })).status, 200);
    const items = (await baas.get('/app/api/quotes?all=1')).body.items;
    const accepted = items.find((quote) => quote.status === 'akkoord');
    const other = items.find((quote) => quote.status === 'concept');
    assert.ok(accepted && other);

    const no = await baas.del(`/app/api/quotes/${accepted.id}`);
    assert.strictEqual(no.status, 409);
    assert.strictEqual(no.body.number, accepted.number);
    assert.strictEqual((await baas.del(`/app/api/admin/quotes/${accepted.id}`, { confirm: 'fout' })).status, 409);
    assert.strictEqual((await baas.del(`/app/api/quotes/${accepted.id}`, { confirm: accepted.number })).status, 200);
    assert.strictEqual((await baas.del(`/app/api/admin/quotes/${accepted.id}`, { confirm: accepted.number })).status, 200);
    // Een gewone offerte vraagt geen extra bevestiging.
    assert.strictEqual((await baas.del(`/app/api/quotes/${other.id}`)).status, 200);
  } finally {
    server.close();
  }
});

test('hoofdbeheerder verwijdert een back-up; ongeldige namen niet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-bkdel-'));
  const db = await platformDb();
  const { server, base } = await start(db, { backupDir: dir });
  try {
    const baas = createClient(base);
    await baas.login('baas', PW);
    const made = await baas.post('/app/api/admin/backups');
    assert.strictEqual(made.status, 201);
    assert.strictEqual((await baas.del('/app/api/admin/backups/..%2Fmaster-key')).status, 404);
    assert.strictEqual((await baas.del(`/app/api/admin/backups/${made.body.name}`)).status, 200);
    assert.strictEqual((await baas.get('/app/api/admin/backups')).body.items.length, 0);
    assert.ok(!fs.existsSync(path.join(dir, made.body.name)));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('testomgeving met bestellingen, meldingen en andere latere tabellen is te verwijderen en leeg te maken', async () => {
  const db = await platformDb();
  const { server, base } = await start(db);
  try {
    const baas = createClient(base);
    await baas.login('baas', PW);
    const tenant = (await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen' })).body.tenant;
    const env = (await baas.post(`/app/api/platform/tenants/${tenant.id}/environments`, { name: 'Test' })).body.tenant;
    assert.strictEqual((await baas.post(`/app/api/platform/tenants/${env.id}/testdata`)).status, 201);
    const users = db.prepare('SELECT id FROM users WHERE tenant_id = ?').all(env.id);
    assert.ok(users.length > 0);

    // Een rij in elke tabel met tenant_id die het wissen vroeger miste, met een verwijzing naar een testgebruiker.
    const seeded = seedLateTables(db, env.id, users[0].id);
    assert.ok(seeded.length > 0, 'minstens één tabel gevuld');

    const reset = await baas.post(`/app/api/platform/tenants/${env.id}/reset`);
    assert.strictEqual(reset.status, 200, JSON.stringify(reset.body));
    for (const table of seeded) {
      assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(env.id).n, 0, `${table} leeg na leegmaken`);
    }

    assert.strictEqual((await baas.post(`/app/api/platform/tenants/${env.id}/testdata`)).status, 201);
    seedLateTables(db, env.id, db.prepare('SELECT id FROM users WHERE tenant_id = ?').get(env.id).id);
    const out = await baas.del(`/app/api/platform/tenants/${env.id}`);
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    for (const table of tenantTables(db)) {
      assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(env.id).n, 0, `${table} leeg na verwijderen`);
    }
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM tenants WHERE id = ?').get(env.id).n, 0);
    // De live-tenant en zijn gegevens blijven.
    assert.ok(createStore(db).getTenant(tenant.id));
  } finally {
    server.close();
  }
});

test('verwijderen weigert de omgeving waar je nu in werkt', async () => {
  const db = await platformDb();
  const { server, base } = await start(db);
  try {
    const baas = createClient(base);
    await baas.login('baas', PW);
    const tenant = (await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen' })).body.tenant;
    const env = (await baas.post(`/app/api/platform/tenants/${tenant.id}/environments`, { name: 'Test' })).body.tenant;
    assert.strictEqual((await baas.post('/app/api/environment', { tenantId: env.id })).status, 200);
    const own = await baas.del(`/app/api/platform/tenants/${env.id}`);
    assert.strictEqual(own.status, 409);
    assert.strictEqual(own.body.error, 'current_tenant');
    const parent = await baas.del(`/app/api/platform/tenants/${tenant.id}`, { confirm: 'groen' });
    assert.strictEqual(parent.status, 409);
    assert.ok(createStore(db).getTenant(env.id));
  } finally {
    server.close();
  }
});

test('een mislukte verwijdering geeft een duidelijke melding en wist niets', async () => {
  const db = await platformDb();
  const store = createStore(db);
  const tenant = store.createTenant({ name: 'Groen BV', slug: 'groen' });
  const env = store.createEnvironment(tenant.tenant?.id || tenant.id, { name: 'Test' }).tenant;
  // Een rij in de hoofdtenant die verplicht naar de testomgeving verwijst: blokkeert het wissen.
  const original = db.prepare.bind(db);
  /**
   * Laat het laatste DELETE van de tenantrij mislukken, alsof een foreign key nog naar de omgeving verwijst.
   * @param {string} sql De query.
   * @returns {object} Het statement.
   */
  db.prepare = function failOnTenantDelete(sql) {
    return /DELETE FROM tenants WHERE id = \?/.test(sql) ? { run() { throw new Error('foreign key constraint failed'); } } : original(sql);
  };
  const out = store.deleteEnvironment(env.id);
  db.prepare = original;
  assert.strictEqual(out.status, 500);
  assert.match(out.error, /Testomgeving verwijderen is mislukt; er is niets gewist\. Oorzaak: foreign key constraint failed/);
  assert.ok(store.getTenant(env.id), 'omgeving staat er nog');
});

/**
 * Vult elke tabel met tenant_id die niet door de oude lijst werd gewist met één rij, voor zover dat zonder
 * verplichte kolommen kan, en laat een nullable kolom naar de gegeven gebruiker verwijzen.
 * @param {object} db De database.
 * @param {string} tenantId De omgeving.
 * @param {string} userId Een gebruiker uit die omgeving.
 * @returns {string[]} De tabellen waarin een rij is gezet.
 */
function seedLateTables(db, tenantId, userId) {
  const filled = [];
  for (const table of ['roles', 'service_requests', 'stock_merges', 'stock_units', 'web_orders', 'web_returns']) {
    const columns = tableColumns(db, table);
    const values = {};
    for (const column of columns) {
      if (column.name === 'tenant_id') values[column.name] = tenantId;
      else if (column.name === 'id') values[column.name] = `test-${table}-${Date.now()}`;
      else if (/user|customer|owner|created_by/.test(column.name) && column.name.endsWith('id')) values[column.name] = userId;
      else if (column.notnull && column.dflt_value == null && !column.pk) values[column.name] = /_at$|^created|^updated/.test(column.name) ? 1 : (/(qty|total|amount|count|number|price|rank|position)/.test(column.name) ? 1 : 'x');
    }
    try {
      db.prepare(`INSERT INTO ${table} (${Object.keys(values).join(', ')}) VALUES (${Object.keys(values).map(() => '?').join(', ')})`).run(...Object.values(values));
      filled.push(table);
    } catch (error) { /* een tabel met strengere verplichte velden slaan we over */ }
  }
  return filled;
}
