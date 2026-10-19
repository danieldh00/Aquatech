// Rollen: hoofdbeheerder, beheerder, installateur en klant (shared/roles.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');
const { createApp } = require('../src/server');
const Roles = require(path.join(__dirname, '..', '..', 'frontend', 'shared', 'roles.js'));

const PW = 'Tuin-Plan-2026!';
const plan = (name) => ({ meta: { name }, areas: [], elements: [], sprinklers: [], zones: [] });

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
      if (kv.slice(i + 1)) jar.set(kv.slice(0, i), kv.slice(i + 1)); else jar.delete(kv.slice(0, i));
    }
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { /* geen JSON */ }
    return { status: res.status, body: json };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

async function setup() {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'hoofd', displayName: 'Hoofd', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW });
  await store.createAccount(tid, { username: 'ina', displayName: 'Ina', role: 'installateur', password: PW });
  await store.createAccount(tid, { username: 'ivo', displayName: 'Ivo', role: 'installateur', password: PW });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW });
  const server = await new Promise((resolve) => { const s = createApp({ secret: 'x'.repeat(64), db }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username) => {
    const c = client(base);
    assert.strictEqual((await c.post('/api/auth/login', { username, password: PW })).status, 200);
    return c;
  };
  return { server, as };
}

test('rechten per rol; een hoofdbeheerder mag alles', () => {
  assert.ok(Roles.can({ role: 'klant', platform_admin: 1 }, 'hoofdbeheer'));
  assert.ok(Roles.can({ role: 'beheerder' }, 'beheer'));
  assert.ok(!Roles.can({ role: 'beheerder' }, 'hoofdbeheer'));
  assert.ok(Roles.can({ role: 'installateur' }, 'offertes'));
  assert.ok(!Roles.can({ role: 'installateur' }, 'beheer'));
  assert.deepStrictEqual(Roles.rightsOf({ role: 'klant' }), ['plannen', 'offertes.klant']);
  assert.ok(Roles.can({ role: 'gebruiker' }, 'offertes'), 'oude rolnaam = installateur');
  assert.deepStrictEqual(Roles.rightsOf({ role: 'onbekend' }), []);
});

test('API: elke rol ziet alleen wat bij die rol hoort', async () => {
  const { server, as } = await setup();
  try {
    const hoofd = await as('hoofd'), baas = await as('baas'), ina = await as('ina'), ivo = await as('ivo'), klaas = await as('klaas');
    assert.ok((await hoofd.get('/api/me')).body.rights.includes('hoofdbeheer'));
    assert.deepStrictEqual((await klaas.get('/api/me')).body.rights, ['plannen', 'offertes.klant']);
    assert.ok(!(await ina.get('/api/me')).body.rights.includes('beheer'));

    // Plannen: iedereen maakt eigen plannen; installateurs zien die van de organisatie.
    const p1 = (await ina.post('/api/plans', { data: plan('Tuin Ina') })).body;
    const pk = (await klaas.post('/api/plans', { data: plan('Tuin Klaas') })).body;
    assert.ok(p1.id && pk.id);
    assert.strictEqual((await ivo.get('/api/plans?all=1')).body.items.length, 2);
    assert.strictEqual((await ivo.get(`/api/plans/${p1.id}`)).status, 200);
    assert.strictEqual((await klaas.get('/api/plans?all=1')).body.items.length, 1, 'klant: alleen eigen plannen');
    assert.strictEqual((await klaas.get(`/api/plans/${p1.id}`)).status, 404);
    assert.strictEqual((await klaas.put(`/api/plans/${p1.id}`, { data: plan('x') })).status, 404);

    // Beheer: alleen beheerders (en de hoofdbeheerder).
    for (const c of [ina, klaas]) {
      for (const url of ['/api/admin/users', '/api/admin/settings', '/api/admin/history', '/api/admin/plans', '/api/admin/audit']) {
        assert.strictEqual((await c.get(url)).status, 403, url);
      }
      assert.strictEqual((await c.get('/api/platform/tenants')).status, 403);
    }
    assert.strictEqual((await baas.get('/api/admin/users')).status, 200);
    assert.strictEqual((await baas.get('/api/platform/tenants')).status, 403, 'beheerder is geen hoofdbeheerder');
    assert.strictEqual((await hoofd.get('/api/admin/users')).status, 200);
    assert.strictEqual((await hoofd.get('/api/platform/tenants')).status, 200);

    // Offertes opstellen: niet voor een klant.
    assert.strictEqual((await ina.post('/api/quotes', { data: {} })).status, 201);
    assert.strictEqual((await klaas.post('/api/quotes', { data: {} })).status, 403);
    assert.strictEqual((await klaas.get('/api/quote-customers')).status, 403);
    assert.strictEqual((await ina.put('/api/quote-profile', { profile: { hourlyRate: 1 } })).status, 403);

    // Rollen toekennen; de oude naam 'gebruiker' wordt installateur.
    const users = (await baas.get('/api/admin/users')).body.items;
    const ivoId = users.find((u) => u.username === 'ivo').id;
    assert.strictEqual((await baas.patch(`/api/admin/users/${ivoId}`, { role: 'klant' })).body.role, 'klant');
    assert.strictEqual((await ivo.get('/api/plans?all=1')).body.items.length, 0, 'rechten gelden meteen');
    assert.strictEqual((await baas.patch(`/api/admin/users/${ivoId}`, { role: 'gebruiker' })).body.role, 'installateur');
    assert.strictEqual((await baas.patch(`/api/admin/users/${ivoId}`, { role: 'koning' })).status, 400);
    assert.strictEqual((await baas.post('/api/admin/users', { username: 'kim', role: 'klant', password: PW, mustChangePassword: false })).body.role, 'klant');
  } finally {
    server.close();
  }
});
