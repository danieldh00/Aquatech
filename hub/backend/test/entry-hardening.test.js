// Toegangscode en gastentoegang alleen door een hoofdbeheerder, back-ups alleen voor hoofdbeheerders, en de
// Permissions-Policy laat de camera toe voor de eigen site (scannen in de orderpick-app).
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createClient, listen } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';

/**
 * Start een testserver met hoofdbeheerder 'baas' en gewone beheerder 'bea'.
 * @returns {Promise<{ server: object, base: string }>} Server en adres.
 */
async function start() {
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  await store.createAccount(tenantId, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(tenantId, { username: 'bea', displayName: 'Bea', role: 'beheerder', password: PW, mustChangePassword: false });
  return listen(createApp({ env: { MULTITENANCY: '1' }, secret: 's'.repeat(64), db }));
}

/**
 * Logt een account in.
 * @param {string} base Adres van de testserver.
 * @param {string} username Gebruikersnaam.
 * @returns {Promise<object>} De ingelogde client.
 */
async function login(base, username) {
  const client = createClient(base, { emptyJsonBody: false });
  const response = await client.post('/app/api/auth/login', { username, password: PW });
  assert.strictEqual(response.status, 200, JSON.stringify(response.body));
  return client;
}

test('een gewone beheerder kan de toegangscode en gastentoegang niet wijzigen, een hoofdbeheerder wel', async () => {
  const { server, base } = await start();
  try {
    const bea = await login(base, 'bea');
    for (const patch of [{ accessCode: 'een-lange-toegangscode' }, { guestAccess: true }, { reset: ['accessCode'] }]) {
      const refused = await bea.put('/app/api/admin/settings', patch);
      assert.strictEqual(refused.status, 403, JSON.stringify(patch));
      assert.strictEqual(refused.body.error, 'forbidden');
    }
    const baas = await login(base, 'baas');
    assert.strictEqual((await baas.put('/app/api/admin/settings', { guestAccess: true })).status, 200);
    assert.strictEqual((await baas.put('/app/api/admin/settings', { accessCode: 'een-lange-toegangscode' })).status, 200);
  } finally {
    server.close();
  }
});

test('back-ups zijn alleen voor hoofdbeheerders', async () => {
  const { server, base } = await start();
  try {
    assert.strictEqual((await (await login(base, 'bea')).get('/app/api/admin/backups')).status, 403);
    assert.strictEqual((await (await login(base, 'baas')).get('/app/api/admin/backups')).status, 200);
  } finally {
    server.close();
  }
});

test('Permissions-Policy: camera alleen voor de eigen site, de rest uit', async () => {
  const { server, base } = await start();
  try {
    const response = await createClient(base).get('/app/api/health');
    const policy = response.headers.get('permissions-policy');
    assert.match(policy, /camera=\(self\)/);
    for (const feature of ['geolocation', 'microphone', 'payment', 'usb']) assert.match(policy, new RegExp(`${feature}=\\(\\)`));
  } finally {
    server.close();
  }
});
