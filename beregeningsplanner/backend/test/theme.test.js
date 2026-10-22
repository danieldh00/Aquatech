// Kleurthema: rekenkern (shared/theme.js) en de API per organisatie.

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const Theme = require('../../frontend/shared/theme.js');
const { createClient, listen } = require('./helpers/http-client');

const SECRET = 'z'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Start een testserver op de gegeven database.
 * @param {object} db De database.
 * @returns {Promise<{ server: import('http').Server, base: string }>} De server en zijn adres.
 */
function start(db) {
  return listen(createApp({ secret: SECRET, db }));
}

test('thema-kern: standaard, afleiding, contrast en opschonen', () => {
  assert.strictEqual(Theme.css({}), '', 'standaardthema geeft geen extra CSS');
  assert.deepStrictEqual(Theme.vars({}), {
    '--at-navy': '#172f5e', '--at-green': '#19924f', '--at-green-dark': '#137a41', '--at-green-soft': '#e7f5ed', '--at-green-light': '#5fd08f', '--at-teal': '#2cb0c0',
  });
  assert.deepStrictEqual(Theme.sanitize({ navy: '#ABC', green: 'rood', teal: '2cb0c0', extra: '#000000' }), { navy: '#aabbcc', teal: '#2cb0c0' });
  assert.deepStrictEqual(Theme.sanitize('x'), {});
  // Afgeleid donker groen is leesbaar op het lichte vlak.
  for (const green of ['#2a7de1', '#8a6d00', '#3c9d3c', '#b03060']) {
    const derived = Theme.derive(green);
    assert.ok(Theme.contrast(derived.greenDark, derived.greenSoft) >= 4.5, `${green}: ${derived.greenDark} op ${derived.greenSoft}`);
  }
  assert.strictEqual(Theme.problems({}).length, 0, 'de huisstijl voldoet zelf');
  const bad = Theme.problems({ navy: '#88aaff', green: '#a0e0b0' });
  assert.deepStrictEqual(bad.map((problem) => problem.field), ['navy', 'green']);
  assert.match(bad[0].message, /te licht/);
  assert.ok(Math.abs(Theme.contrast('#000000', '#ffffff') - 21) < 1e-9);
});

test('hoofdbeheerder kiest kleuren: standaard, per tenant, terugzetten', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant();
  await store.createAccount(main.id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const { server, base } = await start(db);
  try {
    const anon = createClient(base);
    let response = await anon.get('/shared/theme.css');
    assert.strictEqual(response.status, 200, 'ook zonder inloggen bereikbaar');
    assert.match(response.type, /text\/css/);
    assert.doesNotMatch(response.text, /--at-navy/, 'standaard: geen overschrijving');
    assert.strictEqual((await anon.get('/api/platform/theme')).status, 401);

    const baas = createClient(base);
    assert.strictEqual((await baas.login('baas', PW)).status, 200);
    response = await baas.get('/api/platform/theme');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body.defaults, Theme.DEFAULTS);
    assert.deepStrictEqual(response.body.global, {});

    // Ongeldig of te licht: geweigerd.
    response = await baas.put('/api/platform/theme', { colors: { navy: 'blauw' } });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.field, 'navy');
    response = await baas.put('/api/platform/theme', { colors: { green: '#9be7b5' } });
    assert.strictEqual(response.status, 400);
    assert.match(response.body.message, /te licht/);
    response = await baas.put('/api/platform/theme', { colors: { onbekend: '#000000' } });
    assert.strictEqual(response.status, 400);

    // Standaardthema voor iedereen.
    response = await baas.put('/api/platform/theme', { colors: { navy: '#203040', green: '#1a6fb0' } });
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.deepStrictEqual(response.body.theme, { navy: '#203040', green: '#1a6fb0', teal: '#2cb0c0' });
    response = await anon.get('/shared/theme.css');
    assert.match(response.text, /--at-navy: #203040;/);
    assert.match(response.text, /--at-green: #1a6fb0;/);
    response = await anon.get('/login');
    assert.match(response.text, /<style>:root \{[^<]*--at-navy: #203040;/, 'inlogpagina in het thema');

    // Via Beheer > Instellingen kan het niet.
    response = await baas.put('/api/admin/settings', { theme: { navy: '#000000' } });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.field, 'theme');

    // Eigen thema voor een tenant; een andere tenant volgt de standaard.
    const groen = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant;
    const blauw = store.createTenant({ name: 'Blauw BV', slug: 'blauw' }).tenant;
    await store.createAccount(groen.id, { username: 'piet', displayName: 'Piet', role: 'beheerder', password: PW });
    await store.createAccount(blauw.id, { username: 'kees', displayName: 'Kees', role: 'beheerder', password: PW });
    response = await baas.put('/api/platform/theme', { tenantId: groen.id, colors: { navy: '#0b3d2e', green: '#2e7d32', teal: '#f5a623' } });
    assert.strictEqual(response.status, 200);
    const env = store.createEnvironment(groen.id, { name: 'Test' }).tenant;
    assert.strictEqual((await baas.put('/api/platform/theme', { tenantId: env.id, colors: { navy: '#000000' } })).status, 404, 'testomgeving volgt de tenant');

    const piet = createClient(base);
    assert.strictEqual((await piet.login('piet', PW, 'groen')).status, 200);
    assert.match((await piet.get('/shared/theme.css')).text, /--at-navy: #0b3d2e;/);
    assert.strictEqual((await piet.get('/api/platform/theme')).status, 403, 'alleen hoofdbeheerders');
    const kees = createClient(base);
    assert.strictEqual((await kees.login('kees', PW, 'blauw')).status, 200);
    assert.match((await kees.get('/shared/theme.css')).text, /--at-navy: #203040;/);

    response = await baas.get('/api/platform/theme');
    assert.deepStrictEqual(response.body.tenants.find((tenant) => tenant.id === groen.id).theme, { navy: '#0b3d2e', green: '#2e7d32', teal: '#f5a623' });
    assert.deepStrictEqual(response.body.tenants.find((tenant) => tenant.id === blauw.id).theme, {});

    // Terugzetten: tenant terug naar de standaard, standaard terug naar de huisstijl.
    assert.strictEqual((await baas.put('/api/platform/theme', { tenantId: groen.id, colors: null })).status, 200);
    assert.match((await piet.get('/shared/theme.css')).text, /--at-navy: #203040;/);
    response = await baas.put('/api/platform/theme', { colors: null });
    assert.deepStrictEqual(response.body.theme, {});
    assert.doesNotMatch((await anon.get('/shared/theme.css')).text, /--at-navy/);
    assert.doesNotMatch((await anon.get('/login')).text, /<style>:root/);
    // De huisstijl expliciet kiezen is hetzelfde als terugzetten.
    response = await baas.put('/api/platform/theme', { colors: { ...Theme.DEFAULTS } });
    assert.deepStrictEqual(response.body.theme, {});
  } finally {
    server.close();
    db.close();
  }
});
