const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');
const Theme = require('../../frontend/shared/theme.js');

const SECRET = 'z'.repeat(64);
const PW = 'Tuin-Plan-2026!';

function start(db) {
  return new Promise((resolve) => {
    const server = createApp({ secret: SECRET, db }).listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Client met cookies; geeft zowel tekst als JSON terug.
function client(base) {
  const jar = new Map();
  async function call(method, p, body) {
    const headers = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const v = kv.slice(i + 1);
      if (v) jar.set(kv.slice(0, i), v); else jar.delete(kv.slice(0, i));
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* geen JSON */ }
    return { status: res.status, text, body: json, type: res.headers.get('content-type') || '' };
  }
  return {
    get: (p) => call('GET', p),
    put: (p, b) => call('PUT', p, b),
    login: (username, password, tenant) => call('POST', '/api/auth/login', { username, password, tenant }),
  };
}

test('thema-kern: standaard, afleiding, contrast en opschonen', () => {
  assert.strictEqual(Theme.css({}), '', 'standaardthema geeft geen extra CSS');
  assert.deepStrictEqual(Theme.vars({}), {
    '--at-navy': '#172f5e', '--at-green': '#19924f', '--at-green-dark': '#137a41', '--at-green-soft': '#e7f5ed', '--at-green-light': '#5fd08f', '--at-teal': '#2cb0c0',
  });
  assert.deepStrictEqual(Theme.sanitize({ navy: '#ABC', green: 'rood', teal: '2cb0c0', extra: '#000000' }), { navy: '#aabbcc', teal: '#2cb0c0' });
  assert.deepStrictEqual(Theme.sanitize('x'), {});
  // Afgeleid donker groen is leesbaar op het lichte vlak.
  for (const g of ['#2a7de1', '#8a6d00', '#3c9d3c', '#b03060']) {
    const d = Theme.derive(g);
    assert.ok(Theme.contrast(d.greenDark, d.greenSoft) >= 4.5, `${g}: ${d.greenDark} op ${d.greenSoft}`);
  }
  assert.strictEqual(Theme.problems({}).length, 0, 'de huisstijl voldoet zelf');
  const bad = Theme.problems({ navy: '#88aaff', green: '#a0e0b0' });
  assert.deepStrictEqual(bad.map((p) => p.field), ['navy', 'green']);
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
    const anon = client(base);
    let r = await anon.get('/shared/theme.css');
    assert.strictEqual(r.status, 200, 'ook zonder inloggen bereikbaar');
    assert.match(r.type, /text\/css/);
    assert.doesNotMatch(r.text, /--at-navy/, 'standaard: geen overschrijving');
    assert.strictEqual((await anon.get('/api/platform/theme')).status, 401);

    const baas = client(base);
    assert.strictEqual((await baas.login('baas', PW)).status, 200);
    r = await baas.get('/api/platform/theme');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.defaults, Theme.DEFAULTS);
    assert.deepStrictEqual(r.body.global, {});

    // Ongeldig of te licht: geweigerd.
    r = await baas.put('/api/platform/theme', { colors: { navy: 'blauw' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.field, 'navy');
    r = await baas.put('/api/platform/theme', { colors: { green: '#9be7b5' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.message, /te licht/);
    r = await baas.put('/api/platform/theme', { colors: { onbekend: '#000000' } });
    assert.strictEqual(r.status, 400);

    // Standaardthema voor iedereen.
    r = await baas.put('/api/platform/theme', { colors: { navy: '#203040', green: '#1a6fb0' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.theme, { navy: '#203040', green: '#1a6fb0', teal: '#2cb0c0' });
    r = await anon.get('/shared/theme.css');
    assert.match(r.text, /--at-navy: #203040;/);
    assert.match(r.text, /--at-green: #1a6fb0;/);
    r = await anon.get('/login');
    assert.match(r.text, /<style>:root \{[^<]*--at-navy: #203040;/, 'inlogpagina in het thema');

    // Via Beheer > Instellingen kan het niet.
    r = await baas.put('/api/admin/settings', { theme: { navy: '#000000' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.field, 'theme');

    // Eigen thema voor een tenant; een andere tenant volgt de standaard.
    const groen = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant;
    const blauw = store.createTenant({ name: 'Blauw BV', slug: 'blauw' }).tenant;
    await store.createAccount(groen.id, { username: 'piet', displayName: 'Piet', role: 'beheerder', password: PW });
    await store.createAccount(blauw.id, { username: 'kees', displayName: 'Kees', role: 'beheerder', password: PW });
    r = await baas.put('/api/platform/theme', { tenantId: groen.id, colors: { navy: '#0b3d2e', green: '#2e7d32', teal: '#f5a623' } });
    assert.strictEqual(r.status, 200);
    const env = store.createEnvironment(groen.id, { name: 'Test' }).tenant;
    assert.strictEqual((await baas.put('/api/platform/theme', { tenantId: env.id, colors: { navy: '#000000' } })).status, 404, 'testomgeving volgt de tenant');

    const piet = client(base);
    assert.strictEqual((await piet.login('piet', PW, 'groen')).status, 200);
    assert.match((await piet.get('/shared/theme.css')).text, /--at-navy: #0b3d2e;/);
    assert.strictEqual((await piet.get('/api/platform/theme')).status, 403, 'alleen hoofdbeheerders');
    const kees = client(base);
    assert.strictEqual((await kees.login('kees', PW, 'blauw')).status, 200);
    assert.match((await kees.get('/shared/theme.css')).text, /--at-navy: #203040;/);

    r = await baas.get('/api/platform/theme');
    assert.deepStrictEqual(r.body.tenants.find((t) => t.id === groen.id).theme, { navy: '#0b3d2e', green: '#2e7d32', teal: '#f5a623' });
    assert.deepStrictEqual(r.body.tenants.find((t) => t.id === blauw.id).theme, {});

    // Terugzetten: tenant terug naar de standaard, standaard terug naar de huisstijl.
    assert.strictEqual((await baas.put('/api/platform/theme', { tenantId: groen.id, colors: null })).status, 200);
    assert.match((await piet.get('/shared/theme.css')).text, /--at-navy: #203040;/);
    r = await baas.put('/api/platform/theme', { colors: null });
    assert.deepStrictEqual(r.body.theme, {});
    assert.doesNotMatch((await anon.get('/shared/theme.css')).text, /--at-navy/);
    assert.doesNotMatch((await anon.get('/login')).text, /<style>:root/);
    // De huisstijl expliciet kiezen is hetzelfde als terugzetten.
    r = await baas.put('/api/platform/theme', { colors: { ...Theme.DEFAULTS } });
    assert.deepStrictEqual(r.body.theme, {});
  } finally {
    server.close();
    db.close();
  }
});
