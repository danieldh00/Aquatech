// Multitenancy-schakelaar: uit (standaard) = één organisatie met testomgevingen; aan = meer organisaties naast elkaar.

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createClient, listen } = require('./helpers/http-client');

const SECRET = 'z'.repeat(64);
const PASSWORD = 'Tuin-Plan-2026!';

/**
 * Start een testserver met een hoofdbeheerder ('baas') in de hoofdtenant.
 * @param {object} [options] env voor createApp en eventueel een bestaande database.
 * @returns {Promise<{ app: object, db: object, store: object, server: object, base: string }>} De server en zijn onderdelen.
 */
async function start({ env = {}, db = openDb() } = {}) {
  const store = createStore(db);
  const mainId = store.ensureTenant().id;
  if (!store.listUsers(mainId).some((user) => user.username === 'baas')) {
    await store.createAccount(mainId, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PASSWORD }, { platformAdmin: true });
  }
  const app = createApp({ secret: SECRET, db, loginDelayMs: 0, env });
  return { app, db, store, ...(await listen(app)) };
}

/**
 * Logt in en geeft de client terug.
 * @param {string} base Adres van de server.
 * @param {string} username Gebruikersnaam.
 * @param {string} [organization] Organisatiecode.
 * @returns {Promise<object>} De ingelogde client.
 */
async function login(base, username, organization = '') {
  const client = createClient(base);
  const res = await client.login(username, PASSWORD, organization);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return client;
}

test('standaard uit: tenant aanmaken geweigerd, lijst alleen de hoofdtenant, /api/me meldt het', async () => {
  const { server, base } = await start();
  const baas = await login(base, 'baas');
  assert.strictEqual((await baas.get('/app/api/me')).body.multitenancy, false);
  const created = await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen' });
  assert.strictEqual(created.status, 409);
  assert.strictEqual(created.body.error, 'multitenancy_off');
  const list = await baas.get('/app/api/platform/tenants');
  assert.strictEqual(list.body.multitenancy, false);
  assert.deepStrictEqual(list.body.items.map((item) => item.slug), ['default']);
  server.close();
});

test('uit: testomgevingen van de hoofdtenant blijven werken, wisselen kan', async () => {
  const { server, base } = await start();
  const baas = await login(base, 'baas');
  const main = (await baas.get('/app/api/platform/tenants')).body.mainTenantId;
  const env = await baas.post(`/app/api/platform/tenants/${main}/environments`, { name: 'Proef' });
  assert.strictEqual(env.status, 201);
  const environments = await baas.get('/app/api/environments');
  assert.strictEqual(environments.body.items.length, 2);
  const switched = await baas.post('/app/api/environment', { tenantId: env.body.tenant.id });
  assert.strictEqual(switched.status, 200);
  server.close();
});

test('uit: organisatiecode bij het inloggen telt niet; andere organisatie is onbereikbaar, gegevens blijven', async () => {
  const db = openDb();
  const on = await start({ env: { MULTITENANCY: '1' }, db });
  const baas = await login(on.base, 'baas');
  const created = await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: PASSWORD, mustChangePassword: false } });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  await login(on.base, 'piet', 'groen');
  on.server.close();

  const off = await start({ db });
  const attempt = await createClient(off.base).login('piet', PASSWORD, 'groen');
  assert.strictEqual(attempt.status, 401);
  // Een ingevulde code voor de hoofdtenant-gebruiker wordt genegeerd.
  assert.strictEqual((await createClient(off.base).login('baas', PASSWORD, 'groen')).status, 200);
  const adminClient = await login(off.base, 'baas');
  const tenantId = created.body.tenant.id;
  assert.strictEqual((await adminClient.get(`/app/api/platform/tenants/${tenantId}/users`)).status, 409);
  assert.strictEqual((await adminClient.patch(`/app/api/platform/tenants/${tenantId}`, { name: 'X' })).status, 409);
  assert.ok(off.store.getTenant(tenantId), 'gegevens blijven staan');
  off.server.close();
});

test('uit: de inlogpagina verbergt de organisatiecode, aan: niet', async () => {
  const off = await start();
  const hidden = await fetch(`${off.base}/app/login`).then((res) => res.text());
  assert.ok(hidden.includes('[data-multi]{display:none!important}'));
  off.server.close();
  const on = await start({ env: { MULTITENANCY: '1' } });
  const shown = await fetch(`${on.base}/app/login`).then((res) => res.text());
  assert.ok(!shown.includes('[data-multi]{display:none'));
  on.server.close();
});

test('aanzetten via Hoofdbeheer werkt direct; uitzetten met andere organisaties vraagt bevestiging', async () => {
  const { server, base } = await start();
  const baas = await login(base, 'baas');
  const turnOn = await baas.put('/app/api/platform/multitenancy', { enabled: true });
  assert.strictEqual(turnOn.status, 200);
  assert.strictEqual(turnOn.body.enabled, true);
  assert.strictEqual((await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen' })).status, 201);
  const refused = await baas.put('/app/api/platform/multitenancy', { enabled: false });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.body.error, 'confirm_required');
  assert.strictEqual((await baas.get('/app/api/platform/multitenancy')).body.enabled, true);
  const done = await baas.put('/app/api/platform/multitenancy', { enabled: false, acknowledge: true });
  assert.strictEqual(done.status, 200);
  assert.strictEqual((await baas.get('/app/api/me')).body.multitenancy, false);
  assert.strictEqual((await baas.put('/app/api/platform/multitenancy', { enabled: 'ja' })).status, 400);
  server.close();
});

test('alleen een hoofdbeheerder wijzigt multitenancy; Beheer > Instellingen weigert het veld', async () => {
  const { server, base, store } = await start();
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'gewone', displayName: 'Gewone', role: 'beheerder', password: PASSWORD }, {});
  const plain = await login(base, 'gewone');
  assert.strictEqual((await plain.put('/app/api/platform/multitenancy', { enabled: true })).status, 403);
  const settings = await plain.put('/app/api/admin/settings', { multitenancy: true });
  assert.strictEqual(settings.status, 400);
  server.close();
});

test('uit: uitbesteden is dicht en de module staat uit in /api/config; aan: open', async () => {
  const off = await start();
  const baas = await login(off.base, 'baas');
  assert.strictEqual((await baas.get('/app/api/outsourcing')).status, 409);
  assert.strictEqual((await baas.get('/app/api/config')).body.modules.uitbesteden, false);
  off.server.close();
  const on = await start({ env: { MULTITENANCY: '1' } });
  const baasOn = await login(on.base, 'baas');
  assert.notStrictEqual((await baasOn.get('/app/api/outsourcing')).status, 409);
  on.server.close();
});
