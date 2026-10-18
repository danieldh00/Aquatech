const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/server');
const { openDb, MIGRATIONS } = require('../src/db');
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

test('migratie: bestaande beheerders worden hoofdbeheerder, gebruikers niet', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-')), 'aquatech.db');
  const old = new DatabaseSync(file);
  old.exec(MIGRATIONS[0]);
  old.exec(MIGRATIONS[1]);
  old.exec(MIGRATIONS[2]);
  old.exec('PRAGMA user_version = 3');
  const t = new Date().toISOString();
  old.prepare("INSERT INTO tenants (id, slug, name, created_at) VALUES ('t1', 'default', 'Aquatech', ?)").run(t);
  old.prepare("INSERT INTO users (id, tenant_id, username, display_name, role, kind, created_at) VALUES ('u1', 't1', 'daniel', 'Daniël', 'beheerder', 'account', ?)").run(t);
  old.prepare("INSERT INTO users (id, tenant_id, username, display_name, role, kind, created_at) VALUES ('u2', 't1', 'jan', 'Jan', 'gebruiker', 'account', ?)").run(t);
  old.close();

  const db = openDb(file);
  const store = createStore(db);
  assert.strictEqual(store.getUser('u1').platform_admin, 1);
  assert.strictEqual(store.getUser('u2').platform_admin, 0);
  assert.strictEqual(store.getTenant('t1').environment, 'live');
  db.close();
});

test('eerste beheerder via het instelscherm is hoofdbeheerder', async () => {
  const { server, base } = await start(openDb(), { setupCode: 'ABCD-EFGH-JKLM' });
  try {
    const c = client(base);
    assert.strictEqual((await c.post('/api/setup', { username: 'eigenaar', password: 'Tuin-Plan-2026!', code: 'ABCD-EFGH-JKLM' })).status, 201);
    const me = await c.get('/api/me');
    assert.strictEqual(me.body.platformAdmin, true);
    assert.strictEqual((await c.get('/api/platform/tenants')).status, 200);
  } finally {
    server.close();
  }
});

test('hoofdbeheerder maakt een tenant met beheerder; tenants zien elkaars data niet', async () => {
  const { server, base } = await start(await platformDb());
  try {
    const baas = client(base);
    assert.strictEqual((await baas.login('baas', 'Tuin-Plan-2026!')).status, 200);
    assert.strictEqual((await baas.post('/api/plans', { data: plan('Plan van Aquatech') })).status, 201);

    const made = await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: 'Gras-Pomp-2027!' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body.admin.username, 'piet');

    // Dubbele code of gebruikersnaam: geweigerd, en dan ook geen halve tenant.
    assert.strictEqual((await baas.post('/api/platform/tenants', { name: 'Groen 2', slug: 'groen' })).status, 400);
    const dup = await baas.post('/api/platform/tenants', { name: 'Blauw BV', slug: 'blauw', admin: { username: 'baas', password: 'Haag-Slang-2028!' } });
    assert.strictEqual(dup.status, 400);
    assert.ok(!(await baas.get('/api/platform/tenants')).body.items.some((t) => t.slug === 'blauw'));

    // Piet logt in op dezelfde URL met alleen gebruikersnaam en wachtwoord.
    const piet = client(base);
    assert.strictEqual((await piet.login('piet', 'Gras-Pomp-2027!')).status, 200);
    const me = (await piet.get('/api/me')).body;
    assert.strictEqual(me.tenant.slug, 'groen');
    assert.strictEqual(me.platformAdmin, false);
    assert.strictEqual((await piet.get('/api/platform/tenants')).status, 403);
    assert.deepStrictEqual((await piet.get('/api/admin/plans')).body.items, []);
    assert.deepStrictEqual((await piet.get('/api/admin/users')).body.items.map((u) => u.username), ['piet']);
    assert.strictEqual((await piet.post('/api/plans', { data: plan('Plan van Groen') })).status, 201);

    // Aquatech ziet het plan van Groen niet.
    const titles = (await baas.get('/api/admin/plans')).body.items.map((p) => p.title);
    assert.deepStrictEqual(titles, ['Plan van Aquatech']);

    const list = (await baas.get('/api/platform/tenants')).body.items;
    const groen = list.find((t) => t.slug === 'groen');
    assert.strictEqual(groen.userCount, 1);
    assert.strictEqual(groen.planCount, 1);
  } finally {
    server.close();
  }
});

test('uitgeschakelde tenant: inloggen geweigerd en bestaande sessie vervalt; hoofdtenant blijft aan', async () => {
  const { server, base } = await start(await platformDb());
  try {
    const baas = client(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    const t = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!' } })).body.tenant;
    const piet = client(base);
    await piet.login('piet', 'Gras-Pomp-2027!');
    assert.ok((await piet.get('/api/me')).body.user);

    assert.strictEqual((await baas.patch(`/api/platform/tenants/${t.id}`, { disabled: true })).status, 200);
    assert.strictEqual((await piet.get('/api/me')).body.user, null);
    assert.strictEqual((await client(base).login('piet', 'Gras-Pomp-2027!')).status, 403);

    const main = (await baas.get('/api/platform/tenants')).body.mainTenantId;
    assert.strictEqual((await baas.patch(`/api/platform/tenants/${main}`, { disabled: true })).status, 409);

    await baas.patch(`/api/platform/tenants/${t.id}`, { disabled: false, name: 'Groen Beregening' });
    assert.strictEqual((await client(base).login('piet', 'Gras-Pomp-2027!')).status, 200);
  } finally {
    server.close();
  }
});

test('testomgeving: los van live, wisselen zonder opnieuw inloggen', async () => {
  const { server, base } = await start(await platformDb());
  try {
    const baas = client(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    const t = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!' } })).body.tenant;
    await baas.post(`/api/platform/tenants/${t.id}/users`, { username: 'jan', role: 'gebruiker', password: 'Haag-Slang-2028!' });

    const piet = client(base);
    await piet.login('piet', 'Gras-Pomp-2027!');
    await piet.post('/api/plans', { data: plan('Live plan') });
    assert.strictEqual((await piet.put('/api/admin/settings', { aiDailyLimit: 7, anthropicApiKey: `sk-ant-${'k'.repeat(30)}` })).status, 200);

    const env = await baas.post(`/api/platform/tenants/${t.id}/environments`, { name: 'Acceptatie', copyPlans: true });
    assert.strictEqual(env.status, 201);
    assert.strictEqual(env.body.copied, 1);
    assert.strictEqual(env.body.tenant.environment, 'test');

    // Piet (beheerder van Groen) ziet live en de testomgeving en wisselt.
    const envs = (await piet.get('/api/environments')).body.items;
    assert.deepStrictEqual(envs.map((e) => e.environment).sort(), ['live', 'test']);
    assert.strictEqual((await piet.post('/api/environment', { tenantId: env.body.tenant.id })).status, 200);
    assert.ok(piet.jar.get('aquatech_env_hint'));
    const me = (await piet.get('/api/me')).body;
    assert.strictEqual(me.tenant.environment, 'test');
    assert.strictEqual(me.tenant.parentName, 'Groen BV');

    // Gekopieerde plannen en instellingen; wijzigingen raken live niet.
    assert.deepStrictEqual((await piet.get('/api/plans')).body.items.map((p) => p.title), ['Live plan']);
    const envSettings = (await piet.get('/api/admin/settings')).body.settings;
    assert.strictEqual(envSettings.aiDailyLimit.value, 7);
    // De versleutelde API-sleutel is opnieuw versleuteld voor de testomgeving overgenomen.
    assert.strictEqual(envSettings.anthropicApiKey.set, true);
    assert.strictEqual(envSettings.anthropicApiKey.hint, '…kkkk');
    await piet.post('/api/plans', { data: plan('Test plan') });
    await piet.put('/api/admin/settings', { aiDailyLimit: 3 });
    assert.deepStrictEqual((await piet.get('/api/admin/users')).body.items.map((u) => u.username).sort(), ['jan', 'piet']);

    // Terug naar live.
    assert.strictEqual((await piet.post('/api/environment', { tenantId: t.id })).status, 200);
    assert.ok(!piet.jar.get('aquatech_env_hint'));
    assert.deepStrictEqual((await piet.get('/api/plans')).body.items.map((p) => p.title), ['Live plan']);
    assert.strictEqual((await piet.get('/api/admin/settings')).body.settings.aiDailyLimit.value, 7);

    // Een gewone gebruiker komt niet in de testomgeving, ook niet met een gekopieerde cookie.
    const jan = client(base);
    await jan.login('jan', 'Haag-Slang-2028!');
    assert.strictEqual((await jan.get('/api/environments')).body.items.length, 1);
    assert.strictEqual((await jan.post('/api/environment', { tenantId: env.body.tenant.id })).status, 404);
    await piet.post('/api/environment', { tenantId: env.body.tenant.id });
    jan.jar.set('aquatech_env', piet.jar.get('aquatech_env'));
    assert.strictEqual((await jan.get('/api/me')).body.tenant.environment, 'live');

    // Leegmaken en verwijderen; live blijft staan. Wie in de verwijderde
    // omgeving werkte, valt terug op live.
    assert.strictEqual((await baas.post(`/api/platform/tenants/${env.body.tenant.id}/reset`)).status, 200);
    assert.deepStrictEqual((await piet.get('/api/plans')).body.items, []);
    assert.strictEqual((await baas.post(`/api/platform/tenants/${t.id}/reset`)).status, 409);
    assert.strictEqual((await baas.del(`/api/platform/tenants/${t.id}`)).status, 409);
    assert.strictEqual((await baas.del(`/api/platform/tenants/${env.body.tenant.id}`)).status, 200);
    const back = (await piet.get('/api/me')).body;
    assert.strictEqual(back.tenant.environment, 'live');
    assert.ok(!piet.jar.get('aquatech_env_hint'));
    assert.deepStrictEqual((await piet.get('/api/plans')).body.items.map((p) => p.title), ['Live plan']);
  } finally {
    server.close();
  }
});

test('hoofdbeheerder opent een andere tenant en werkt daar als beheerder', async () => {
  const { server, base } = await start(await platformDb());
  try {
    const baas = client(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    const t = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!' } })).body.tenant;
    assert.strictEqual((await baas.post('/api/environment', { tenantId: t.id })).status, 200);
    assert.strictEqual((await baas.get('/api/me')).body.tenant.slug, 'groen');
    assert.deepStrictEqual((await baas.get('/api/admin/users')).body.items.map((u) => u.username), ['piet']);
    // Een gewone beheerder kan een andere tenant niet openen.
    const piet = client(base);
    await piet.login('piet', 'Gras-Pomp-2027!');
    const main = (await baas.get('/api/platform/tenants')).body.mainTenantId;
    assert.strictEqual((await piet.post('/api/environment', { tenantId: main })).status, 404);
  } finally {
    server.close();
  }
});

test('de laatste hoofdbeheerder kan niet worden uitgeschakeld', async () => {
  const db = await platformDb();
  const { server, base } = await start(db);
  try {
    const baas = client(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    await baas.post('/api/admin/users', { username: 'tweede', role: 'beheerder', password: 'Vijver-Mos-2029!' });
    const users = (await baas.get('/api/admin/users')).body.items;
    const me = users.find((u) => u.username === 'baas');
    assert.strictEqual((await baas.patch(`/api/admin/users/${me.id}`, { disabled: true })).status, 409);
  } finally {
    server.close();
  }
});
