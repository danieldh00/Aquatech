// Testdata voor testomgevingen: opbouw (tuinen, offertes) en de API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');

const SECRET = 'z'.repeat(64);

function start(db, opts = {}) {
  return new Promise((resolve) => {
    const server = createApp({ secret: SECRET, db, ...opts }).listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// Kleine client die cookies onthoudt (zoals een browser).
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
    return { status: res.status, body: json };
  }
  return {
    jar,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
    login: (username, password) => call('POST', '/api/auth/login', { username, password }),
  };
}

const plan = (name) => ({
  meta: { name, customer: 'Fam. Jansen', address: 'Dorpsstraat 1' },
  areas: [{ id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }] }],
  sprinklers: [], zones: [], elements: [],
});

// Platform met een hoofdbeheerder ('baas') in de hoofdtenant.
async function platformDb() {
  const db = openDb();
  const store = createStore(db);
  await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!' }, { platformAdmin: true });
  return db;
}

const { buildTestData, lawnHeads } = require('../src/testdata');
const { summarize } = require('../src/store');

test('testdata: tuinen met zones, offertes met regels en geldige gebruikersnamen', () => {
  const set = buildTestData({ slug: 'groen-test', profile: { hourlyRate: 55, vatRate: 21, validDays: 30 }, today: new Date('2026-10-18T12:00:00Z') });
  assert.deepStrictEqual(set.accounts.map((a) => a.role).sort(), ['beheerder', 'installateur', 'installateur', 'klant', 'klant', 'klant']);
  for (const a of set.accounts) assert.match(a.username, /^groen-test\.[a-z0-9]+$/);
  assert.ok(set.plans.length >= 6);
  for (const p of set.plans) {
    const s = summarize(p.data);
    assert.ok(s.totalM2 > 50 && s.sprinklers > 0, p.data.meta.name);
    assert.ok(set.accounts.some((a) => a.key === p.owner));
  }
  assert.ok(set.plans.filter((p) => p.owner !== 'klant1').every((p) => p.data.zones.length > 0 && p.data.sprinklers.every((s) => s.zone)), 'zones ingedeeld');
  assert.deepStrictEqual([...new Set(set.quotes.map((q) => q.status))].sort(), ['afgewezen', 'akkoord', 'concept', 'verzonden']);
  for (const q of set.quotes) {
    assert.ok(q.data.lines.some((l) => l.section === 'materiaal') && q.data.lines.some((l) => l.section === 'arbeid'));
    assert.ok(q.totalIncl > q.totalExcl && q.totalExcl > 100);
  }
});

test('sproeiers kop-aan-kop: hoeken 90°, randen 180°, midden 360°', () => {
  const heads = lawnHeads(0, 0, 12, 12, 'rotator', 6);
  assert.strictEqual(heads.length, 9);
  assert.deepStrictEqual(heads.map((h) => h.arc).sort((a, b) => a - b), [90, 90, 90, 90, 180, 180, 180, 180, 360]);
  assert.ok(heads.every((h) => h.r === 6));
});

test('testomgeving vullen: testaccounts per rol, alleen in test, opnieuw vullen en leegmaken', async () => {
  const { server, base } = await start(await platformDb());
  try {
    const baas = client(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    const t = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!' } })).body.tenant;
    const env = (await baas.post(`/api/platform/tenants/${t.id}/environments`, { name: 'Test' })).body.tenant;

    // Nooit in live, en alleen voor hoofdbeheerders.
    assert.strictEqual((await baas.post(`/api/platform/tenants/${t.id}/testdata`)).status, 409);
    const piet = client(base);
    await piet.login('piet', 'Gras-Pomp-2027!');
    assert.strictEqual((await piet.post(`/api/platform/tenants/${env.id}/testdata`)).status, 403);

    const out = await baas.post(`/api/platform/tenants/${env.id}/testdata`);
    assert.strictEqual(out.status, 201);
    const { password, accounts, counts } = out.body;
    assert.strictEqual(accounts.length, 6);
    assert.ok(counts.plans >= 6 && counts.quotes === 5);
    const name = (suffix) => accounts.find((a) => a.username.endsWith(`.${suffix}`)).username;

    // Een testklant komt direct in de testomgeving en ziet alleen het eigene.
    const klant = client(base);
    assert.strictEqual((await klant.login(name('klant2'), password)).status, 200);
    const me = (await klant.get('/api/me')).body;
    assert.strictEqual(me.tenant.id, env.id);
    assert.strictEqual(me.user.role, 'klant');
    const mine = (await klant.get('/api/quotes')).body.items;
    assert.deepStrictEqual(mine.map((q) => q.status), ['verzonden']);
    assert.strictEqual((await klant.post(`/api/quotes/${mine[0].id}/respond`, { answer: 'afgewezen', name: 'Testklant', reason: 'test' })).status, 200, 'akkoord vraagt een handtekening; afwijzen niet');
    assert.strictEqual((await klant.get('/api/admin/users')).status, 403);

    // De installateur ziet alle plannen en offertes van de testomgeving.
    const inst = client(base);
    await inst.login(name('installateur'), password);
    assert.strictEqual((await inst.get('/api/plans?all=1')).body.items.length, counts.plans);
    assert.strictEqual((await inst.get('/api/quotes?all=1')).body.items.length, 5);
    const customers = (await inst.get('/api/quote-customers')).body.items;
    assert.strictEqual(customers.length, 3, 'de testklanten om een offerte aan te koppelen');

    // De testbeheerder beheert alleen de testaccounts, nooit live.
    const bea = client(base);
    await bea.login(name('beheerder'), password);
    const users = (await bea.get('/api/admin/users')).body.items.map((u) => u.username);
    assert.strictEqual(users.length, 6);
    assert.ok(!users.includes('piet'));
    const pietId = (await baas.get(`/api/platform/tenants/${t.id}/users`)).body.items[0].id;
    assert.strictEqual((await bea.patch(`/api/admin/users/${pietId}`, { disabled: true })).status, 404);
    assert.deepStrictEqual((await bea.get('/api/environments')).body.items.map((e) => e.id), [env.id]);

    // Live blijft leeg; de beheerder van live ziet de testaccounts niet.
    assert.deepStrictEqual((await piet.get('/api/admin/users')).body.items.map((u) => u.username), ['piet']);
    assert.deepStrictEqual((await piet.get('/api/admin/plans')).body.items, []);
    const list = (await baas.get('/api/platform/tenants')).body.items.find((x) => x.id === t.id);
    assert.strictEqual(list.userCount, 1);
    assert.strictEqual(list.environments[0].userCount, 6);
    assert.strictEqual((await baas.get(`/api/platform/tenants/${env.id}/users`)).body.items.length, 6);

    // Opnieuw vullen: zelfde gebruikersnamen, nieuw wachtwoord, oude sessies weg.
    const again = await baas.post(`/api/platform/tenants/${env.id}/testdata`);
    assert.strictEqual(again.status, 201);
    assert.notStrictEqual(again.body.password, password);
    assert.strictEqual((await klant.get('/api/me')).body.user, null);
    assert.strictEqual((await client(base).login(name('klant2'), again.body.password)).status, 200);

    // Leegmaken ruimt de testaccounts op.
    assert.strictEqual((await baas.post(`/api/platform/tenants/${env.id}/reset`)).status, 200);
    assert.strictEqual((await client(base).login(name('klant2'), again.body.password)).status, 401);
    assert.strictEqual((await baas.get('/api/platform/tenants')).body.items.find((x) => x.id === t.id).environments[0].planCount, 0);
  } finally {
    server.close();
  }
});
