// Organisaties verwijderen (alles met tenant_id, ook testomgevingen) en geaccordeerde offertes alleen met bevestiging.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
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
  return listen(createApp({ secret: SECRET, db, env: { MULTITENANCY: '1' }, ...opts }));
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
    assert.deepStrictEqual(seeded, ['roles', 'service_requests', 'stock_merges', 'stock_units', 'web_orders', 'web_returns']);

    const reset = await baas.post(`/app/api/platform/tenants/${env.id}/reset`);
    assert.strictEqual(reset.status, 200, JSON.stringify(reset.body));
    // Leegmaken wist alles behalve de instellingen en de rollen van de omgeving.
    for (const table of seeded) {
      const expected = table === 'roles' ? 1 : 0;
      assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(env.id).n, expected, `${table} na leegmaken`);
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
 * Zet in elke tabel die de oude wislijst miste één geldige rij, met verwijzingen naar een testgebruiker (en
 * web_returns naar de bestelling). Een mislukte insert laat de test falen, zodat geen tabel stilzwijgend wordt overgeslagen.
 * @param {object} db De database.
 * @param {string} tenantId De omgeving.
 * @param {string} userId Een gebruiker uit die omgeving.
 * @returns {string[]} De tabellen waarin een rij is gezet.
 */
function seedLateTables(db, tenantId, userId) {
  const suffix = `${tenantId.slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}`;
  const rows = {
    roles: { tenant_id: tenantId, role_key: `eigen-${suffix}`, label: 'Eigen rol', description: '', kind: 'medewerker', rights: '[]', created_at: 1, updated_at: 1 },
    service_requests: { id: `sr-${suffix}`, tenant_id: tenantId, number: `M-${suffix}`, customer_id: userId, customer_name: 'Klant', kind: 'storing', urgent: 0, subject: 'Storing', description: '', address: '', phone: '', email: '', preferred: '', status: 'nieuw', reply: '', note: '', handled_by: userId, handled_by_name: '', created_at: 1, updated_at: 1 },
    stock_merges: { id: `sm-${suffix}`, tenant_id: tenantId, parent_id: `p-${suffix}`, parent_code: 'P', parent_name: 'Hoofdartikel', snapshot: '{}', created_by: userId, created_at: 1 },
    stock_units: { id: `su-${suffix}`, tenant_id: tenantId, name: 'doos', created_at: 1 },
    web_orders: { id: `wo-${suffix}`, tenant_id: tenantId, number: `W-${suffix}`, user_id: userId, status: 'nieuw', customer_name: 'Klant', email: 'klant@example.nl', total: 100, data: '{}', created_at: 1, updated_at: 1 },
    web_returns: { id: `wr-${suffix}`, tenant_id: tenantId, order_id: `wo-${suffix}`, user_id: userId, number: `R-${suffix}`, status: 'nieuw', data: '{}', created_at: 1, updated_at: 1 },
  };
  for (const [table, values] of Object.entries(rows)) {
    const names = Object.keys(values);
    db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...Object.values(values));
  }
  return Object.keys(rows);
}
