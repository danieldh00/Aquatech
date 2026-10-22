const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/server');
const { openDb, MIGRATIONS } = require('../src/database/db');
const PG = Boolean(process.env.TEST_DATABASE_URL); // testsuite tegen PostgreSQL

const { createStore } = require('../src/platform/store');
const { createClient } = require('./helpers/http-client');

const SECRET = 'z'.repeat(64);

function start(db, opts = {}) {
  return new Promise((resolve) => {
    const server = createApp({ secret: SECRET, db, ...opts }).listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
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

test('migratie: bestaande beheerders worden hoofdbeheerder, gebruikers niet', { skip: PG && 'SQLite-migraties' }, () => {
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

test('migratie rollen: gebruiker wordt installateur, gast wordt klant; verwijzingen blijven heel', { skip: PG && 'SQLite-migraties' }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-')), 'aquatech.db');
  const old = new DatabaseSync(file);
  old.exec('PRAGMA foreign_keys = ON');
  for (let v = 0; v < 5; v++) old.exec(MIGRATIONS[v]);
  old.exec('PRAGMA user_version = 5');
  const t = new Date().toISOString();
  old.prepare("INSERT INTO tenants (id, slug, name, created_at) VALUES ('t1', 'default', 'Aquatech', ?)").run(t);
  const user = old.prepare('INSERT INTO users (id, tenant_id, username, display_name, role, kind, created_at, platform_admin) VALUES (?, \'t1\', ?, ?, ?, ?, ?, ?)');
  user.run('u1', 'daniel', 'Daniël', 'beheerder', 'account', t, 1);
  user.run('u2', 'jan', 'Jan', 'gebruiker', 'account', t, 0);
  user.run('u3', 'gast-1234', 'Gast 1234', 'gebruiker', 'gast', t, 0);
  old.prepare("INSERT INTO plans (id, tenant_id, owner_id, title, data, created_at, updated_at) VALUES ('p1', 't1', 'u2', 'Tuin', '{}', ?, ?)").run(t, t);
  old.prepare("INSERT INTO sessions (id_hash, tenant_id, user_id, via, fingerprint, created_at, last_seen_at, expires_at) VALUES ('h', 't1', 'u2', 'user', 'f', ?, ?, ?)").run(t, t, t);
  old.prepare("INSERT INTO quotes (id, tenant_id, owner_id, number, data, created_at, updated_at) VALUES ('q1', 't1', 'u2', 'OF-1', '{}', ?, ?)").run(t, t);
  old.close();

  const db = openDb(file);
  const store = createStore(db);
  assert.deepStrictEqual(['u1', 'u2', 'u3'].map((id) => store.getUser(id).role), ['beheerder', 'installateur', 'klant']);
  assert.strictEqual(store.getUser('u1').platform_admin, 1);
  assert.strictEqual(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys weer aan');
  assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.strictEqual(db.prepare("SELECT owner_id FROM plans WHERE id = 'p1'").get().owner_id, 'u2');
  assert.strictEqual(db.prepare("SELECT customer_id FROM quotes WHERE id = 'q1'").get().customer_id, null);
  // Sinds migratie 16 (rollen per organisatie) is de rol een vrije sleutel;
  // verwijzingen worden weer bewaakt.
  assert.throws(() => db.prepare("INSERT INTO plans (id, tenant_id, owner_id, title, data, created_at, updated_at) VALUES ('p2', 't1', 'niemand', 'x', '{}', ?, ?)").run(t, t));
  db.close();
});

test('eerste beheerder via het instelscherm is hoofdbeheerder', async () => {
  const { server, base } = await start(openDb(), { setupCode: 'ABCD-EFGH-JKLM' });
  try {
    const c = createClient(base);
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
    const baas = createClient(base);
    assert.strictEqual((await baas.login('baas', 'Tuin-Plan-2026!')).status, 200);
    assert.strictEqual((await baas.post('/api/plans', { data: plan('Plan van Aquatech') })).status, 201);

    const made = await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: 'Gras-Pomp-2027!', mustChangePassword: false } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body.admin.username, 'piet');

    // Dubbele code: geweigerd. Een ongeldig account: dan ook geen halve tenant.
    assert.strictEqual((await baas.post('/api/platform/tenants', { name: 'Groen 2', slug: 'groen' })).status, 400);
    const bad = await baas.post('/api/platform/tenants', { name: 'Blauw BV', slug: 'blauw', admin: { username: 'x', password: 'Haag-Slang-2028!', mustChangePassword: false } });
    assert.strictEqual(bad.status, 400);
    assert.ok(!(await baas.get('/api/platform/tenants')).body.items.some((t) => t.slug === 'blauw'));

    // Piet logt in op dezelfde URL met de organisatiecode van Groen.
    const piet = createClient(base);
    assert.strictEqual((await piet.login('piet', 'Gras-Pomp-2027!', 'groen')).status, 200);
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
    const baas = createClient(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    const t = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!', mustChangePassword: false } })).body.tenant;
    const piet = createClient(base);
    await piet.login('piet', 'Gras-Pomp-2027!', 'groen');
    assert.ok((await piet.get('/api/me')).body.user);

    assert.strictEqual((await baas.patch(`/api/platform/tenants/${t.id}`, { disabled: true })).status, 200);
    assert.strictEqual((await piet.get('/api/me')).body.user, null);
    assert.strictEqual((await createClient(base).login('piet', 'Gras-Pomp-2027!', 'groen')).status, 403);

    const main = (await baas.get('/api/platform/tenants')).body.mainTenantId;
    assert.strictEqual((await baas.patch(`/api/platform/tenants/${main}`, { disabled: true })).status, 409);

    await baas.patch(`/api/platform/tenants/${t.id}`, { disabled: false, name: 'Groen Beregening' });
    assert.strictEqual((await createClient(base).login('piet', 'Gras-Pomp-2027!', 'groen')).status, 200);
  } finally {
    server.close();
  }
});

test('testomgeving: los van live, wisselen zonder opnieuw inloggen', async () => {
  const { server, base } = await start(await platformDb());
  try {
    const baas = createClient(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    const t = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!', mustChangePassword: false } })).body.tenant;
    await baas.post(`/api/platform/tenants/${t.id}/users`, { username: 'jan', role: 'gebruiker', password: 'Haag-Slang-2028!', mustChangePassword: false });

    const piet = createClient(base);
    await piet.login('piet', 'Gras-Pomp-2027!', 'groen');
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
    const jan = createClient(base);
    await jan.login('jan', 'Haag-Slang-2028!', 'groen');
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
    // Een live-tenant verwijderen vraagt de tenantcode (zie tenants-delete.test.js).
    assert.strictEqual((await baas.del(`/api/platform/tenants/${t.id}`)).body.error, 'confirm_required');
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
    const baas = createClient(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    const t = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!', mustChangePassword: false } })).body.tenant;
    assert.strictEqual((await baas.post('/api/environment', { tenantId: t.id })).status, 200);
    assert.strictEqual((await baas.get('/api/me')).body.tenant.slug, 'groen');
    assert.deepStrictEqual((await baas.get('/api/admin/users')).body.items.map((u) => u.username), ['piet']);
    // Een gewone beheerder kan een andere tenant niet openen.
    const piet = createClient(base);
    await piet.login('piet', 'Gras-Pomp-2027!', 'groen');
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
    const baas = createClient(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    await baas.post('/api/admin/users', { username: 'tweede', role: 'beheerder', password: 'Vijver-Mos-2029!', mustChangePassword: false });
    const users = (await baas.get('/api/admin/users')).body.items;
    const me = users.find((u) => u.username === 'baas');
    assert.strictEqual((await baas.patch(`/api/admin/users/${me.id}`, { disabled: true })).status, 409);
  } finally {
    server.close();
  }
});

test('hoofdbeheerders aanmaken, intrekken en beschermen', async () => {
  const { server, base } = await start(await platformDb());
  try {
    const baas = createClient(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    const { items, mainTenantId } = (await baas.get('/api/platform/tenants')).body;
    const groen = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen' })).body.tenant;
    assert.ok(items.length);

    // Nieuwe hoofdbeheerder in de hoofdtenant; altijd met de rol beheerder.
    const made = await baas.post(`/api/platform/tenants/${mainTenantId}/users`, { username: 'anna', displayName: 'Anna', role: 'klant', password: 'Vijver-Mos-2029!', platformAdmin: true, mustChangePassword: false });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body.platformAdmin, true);
    assert.strictEqual(made.body.role, 'beheerder');
    const anna = createClient(base);
    assert.strictEqual((await anna.login('anna', 'Vijver-Mos-2029!')).status, 200);
    assert.strictEqual((await anna.get('/api/platform/tenants')).status, 200);
    // Ook met een andere (onthouden) organisatiecode of de naam van de hoofdtenant.
    for (const org of ['groen', 'aquatech']) {
      const c = createClient(base);
      const r = await c.login('anna', 'Vijver-Mos-2029!', org);
      assert.strictEqual(r.status, 200, org);
      assert.strictEqual(r.body.tenant, '');
      assert.strictEqual((await c.get('/api/platform/tenants')).status, 200);
    }

    // Alleen in de hoofdtenant.
    assert.strictEqual((await baas.post(`/api/platform/tenants/${groen.id}/users`, { username: 'kees', role: 'beheerder', password: 'Vijver-Mos-2029!', platformAdmin: true })).status, 400);
    const kees = (await baas.post(`/api/platform/tenants/${groen.id}/users`, { username: 'kees', role: 'beheerder', password: 'Vijver-Mos-2029!', mustChangePassword: false })).body;
    assert.strictEqual((await baas.patch(`/api/platform/tenants/${groen.id}/users/${kees.id}`, { platformAdmin: true })).status, 400);

    // Een gewone beheerder van de hoofdtenant kan geen hoofdbeheerder wijzigen.
    const jan = (await baas.post('/api/admin/users', { username: 'jan', role: 'beheerder', password: 'Haag-Slang-2028!', mustChangePassword: false })).body;
    const janc = createClient(base);
    // Een gewone gebruiker van de hoofdtenant komt niet binnen met een andere code.
    assert.strictEqual((await createClient(base).login('jan', 'Haag-Slang-2028!', 'groen')).status, 401);
    await janc.login('jan', 'Haag-Slang-2028!');
    assert.strictEqual((await janc.patch(`/api/admin/users/${made.body.id}`, { disabled: true })).status, 403);
    assert.strictEqual((await janc.patch(`/api/admin/users/${made.body.id}`, { password: 'Bloem-Perk-2029!', mustChangePassword: false })).status, 403);
    assert.strictEqual((await janc.patch(`/api/admin/users/${made.body.id}`, { platformAdmin: false })).status, 403);
    assert.strictEqual((await janc.post(`/api/admin/users/${made.body.id}/logout`)).status, 403);
    // Ook niet zichzelf promoveren via de beheer-API (veld wordt genegeerd).
    await janc.patch(`/api/admin/users/${jan.id}`, { platformAdmin: true });
    assert.strictEqual((await janc.get('/api/platform/tenants')).status, 403);

    // Bestaande gebruiker promoveren en weer intrekken.
    assert.strictEqual((await baas.patch(`/api/platform/tenants/${mainTenantId}/users/${jan.id}`, { platformAdmin: true })).body.platformAdmin, true);
    assert.strictEqual((await janc.get('/api/platform/tenants')).status, 200);
    assert.strictEqual((await baas.patch(`/api/platform/tenants/${mainTenantId}/users/${jan.id}`, { platformAdmin: false })).body.platformAdmin, false);
    assert.strictEqual((await janc.get('/api/platform/tenants')).status, 403);

    // De laatste actieve hoofdbeheerder blijft.
    const baasId = (await baas.get('/api/me')).body.user.id;
    assert.strictEqual((await anna.patch(`/api/platform/tenants/${mainTenantId}/users/${baasId}`, { platformAdmin: false })).status, 200);
    const annaSelf = await anna.patch(`/api/platform/tenants/${mainTenantId}/users/${made.body.id}`, { platformAdmin: false });
    assert.strictEqual(annaSelf.status, 409);
    assert.strictEqual((await anna.patch(`/api/platform/tenants/${mainTenantId}/users/${made.body.id}`, { disabled: true })).status, 409);
  } finally {
    server.close();
  }
});

// Inloggen vanaf een eigen bronadres (127.0.x.y): de limiet per IP (10 per
// kwartier) hoort niet bij wat deze test controleert.
const http = require('http');
function loginFrom(base, ip, username, password, tenant) {
  const url = new URL('/api/auth/login', base);
  const body = JSON.stringify({ username, password, tenant });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', localAddress: ip,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        const cookie = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
        let json = null;
        try { json = JSON.parse(text); } catch { /* geen JSON */ }
        resolve({ status: res.statusCode, body: json, cookie });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('gebruikersnamen zijn uniek per tenant; de organisatiecode kiest de tenant', async () => {
  const { server, base } = await start(await platformDb());
  let n = 1;
  const nextIp = () => `127.0.1.${n++}`;
  // Ingelogde client: de sessiecookie uit een inlog vanaf een eigen adres.
  const as = async (username, password, tenant) => {
    const r = await loginFrom(base, nextIp(), username, password, tenant);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const c = createClient(base);
    for (const kv of r.cookie.split('; ').filter(Boolean)) { const k = kv.indexOf('='); c.jar.set(kv.slice(0, k), kv.slice(k + 1)); }
    return Object.assign(c, { loginBody: r.body });
  };
  try {
    const baas = await as('baas', 'Tuin-Plan-2026!');
    assert.strictEqual(baas.loginBody.tenant, '');
    const groen = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!', mustChangePassword: false } })).body.tenant;
    // Dezelfde voornaam in een andere tenant (ook gelijk aan de hoofdbeheerder) mag.
    const blauw = await baas.post('/api/platform/tenants', { name: 'Blauw BV', slug: 'blauw', admin: { username: 'piet', password: 'Haag-Slang-2028!', mustChangePassword: false } });
    assert.strictEqual(blauw.status, 201, JSON.stringify(blauw.body));
    assert.strictEqual((await baas.post(`/api/platform/tenants/${groen.id}/users`, { username: 'baas', role: 'installateur', password: 'Bloem-Perk-2029!', mustChangePassword: false })).status, 201);
    // Binnen één tenant blijft een gebruikersnaam uniek.
    assert.strictEqual((await baas.post(`/api/platform/tenants/${groen.id}/users`, { username: 'piet', role: 'installateur', password: 'Bloem-Perk-2029!', mustChangePassword: false })).status, 400);

    // Twee Pieten met elk een eigen id, elk in de eigen tenant.
    const a = await as('piet', 'Gras-Pomp-2027!', 'groen');
    const b = await as('piet', 'Haag-Slang-2028!', ' Blauw ');
    assert.strictEqual(b.loginBody.tenant, 'blauw');
    const ma = (await a.get('/api/me')).body;
    const mb = (await b.get('/api/me')).body;
    assert.notStrictEqual(ma.user.id, mb.user.id);
    assert.deepStrictEqual([ma.tenant.slug, mb.tenant.slug, ma.loginCode, mb.loginCode], ['groen', 'blauw', 'groen', 'blauw']);

    // Verkeerde code of geen code: niet ingelogd (zonder code = de hoofdtenant).
    for (const code of ['blauw', undefined, '', 'bestaatniet']) {
      assert.strictEqual((await loginFrom(base, nextIp(), 'piet', 'Gras-Pomp-2027!', code)).status, 401, String(code));
    }

    // De hoofdbeheerder logt in zonder code; 'baas' van Groen met de code.
    assert.strictEqual((await baas.get('/api/me')).body.platformAdmin, true);
    const g = await as('baas', 'Bloem-Perk-2029!', 'groen');
    assert.strictEqual((await g.get('/api/me')).body.platformAdmin, false);

    // De code van een testomgeving logt in bij de live-tenant.
    const env = (await baas.post(`/api/platform/tenants/${groen.id}/environments`, { name: 'Acceptatie' })).body.tenant;
    const c = await as('piet', 'Gras-Pomp-2027!', env.slug);
    assert.strictEqual((await c.get('/api/me')).body.tenant.slug, 'groen');

    // Binnen de organisatie (live plus testomgevingen) is een naam uniek.
    assert.strictEqual((await baas.post(`/api/platform/tenants/${env.id}/users`, { username: 'tester', role: 'klant', password: 'Bloem-Perk-2029!', mustChangePassword: false })).status, 201);
    assert.strictEqual((await baas.post(`/api/platform/tenants/${groen.id}/users`, { username: 'tester', role: 'klant', password: 'Bloem-Perk-2029!', mustChangePassword: false })).status, 400);
    const tester = await as('tester', 'Bloem-Perk-2029!', 'groen');
    assert.strictEqual((await tester.get('/api/me')).body.tenant.id, env.id);

    // Blokkade na te veel fouten geldt per tenant: de Piet van Blauw kan nog in.
    for (let i = 0; i < 10; i++) assert.strictEqual((await loginFrom(base, '127.0.2.1', 'piet', 'fout', 'groen')).status, 401);
    assert.strictEqual((await loginFrom(base, nextIp(), 'piet', 'Gras-Pomp-2027!', 'groen')).status, 429);
    assert.strictEqual((await loginFrom(base, nextIp(), 'piet', 'Haag-Slang-2028!', 'blauw')).status, 200);
  } finally {
    server.close();
  }
});

test('migratie: de globale index op gebruikersnaam vervalt, uniek per tenant blijft', () => {
  const db = openDb();
  const idx = (PG ? db.prepare("SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'users'")
    : db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users'")).all().map((r) => r.name);
  assert.ok(!idx.includes('users_username'));
  const store = createStore(db);
  const t1 = store.ensureTenant().id;
  const t2 = store.createTenant({ name: 'Groen', slug: 'groen' }).tenant.id;
  db.prepare("INSERT INTO users (id, tenant_id, username, display_name, role, kind, created_at) VALUES ('u1', ?, 'jan', 'Jan', 'klant', 'account', '')").run(t1);
  db.prepare("INSERT INTO users (id, tenant_id, username, display_name, role, kind, created_at) VALUES ('u2', ?, 'jan', 'Jan', 'klant', 'account', '')").run(t2);
  assert.throws(() => db.prepare("INSERT INTO users (id, tenant_id, username, display_name, role, kind, created_at) VALUES ('u3', ?, 'jan', 'Jan', 'klant', 'account', '')").run(t2));
});
