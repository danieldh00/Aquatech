// Gebruikers verwijderen: door een beheerder in de eigen tenant en door een hoofdbeheerder.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');
const { createApp } = require('../src/server');

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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

async function setup() {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  const ids = {};
  for (const [username, role, platformAdmin] of [['hoofd', 'beheerder', true], ['baas', 'beheerder'], ['ina', 'installateur'], ['klaas', 'klant']]) {
    ids[username] = (await store.createAccount(tid, { username, displayName: username, role, password: PW }, { platformAdmin })).user.id;
  }
  const server = await new Promise((resolve) => { const s = createApp({ secret: 'x'.repeat(64), db }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, org) => {
    const c = client(base);
    assert.strictEqual((await c.post('/api/auth/login', { username, password: PW, ...(org ? { org } : {}) })).status, 200);
    return c;
  };
  return { server, as, store, db, tid, ids };
}

test('beheerder verwijdert een gebruiker; plannen en offertes blijven bewaard', async () => {
  const { server, as, store, db, tid, ids } = await setup();
  try {
    const baas = await as('baas'), ina = await as('ina'), klaas = await as('klaas');
    const p = (await ina.post('/api/plans', { data: plan('Tuin Ina') })).body;
    const qt = (await ina.post('/api/quotes', { data: {} })).body;
    assert.ok(p.id && qt.id);

    // Een installateur mag niet verwijderen.
    assert.strictEqual((await klaas.del(`/api/admin/users/${ids.ina}`)).status, 403);
    assert.strictEqual((await ina.del(`/api/admin/users/${ids.klaas}`)).status, 403);

    const out = await baas.del(`/api/admin/users/${ids.ina}`);
    assert.strictEqual(out.status, 200);
    assert.deepStrictEqual(out.body.moved, { plans: 1, quotes: 1, work_orders: 0 });
    assert.strictEqual(store.getUser(ids.ina), null);
    assert.strictEqual((await ina.get('/api/me')).body.user, null, 'sessie is weg');
    assert.strictEqual((await client(`http://127.0.0.1:${server.address().port}`).post('/api/auth/login', { username: 'ina', password: PW })).status, 401);

    // Plan en offerte staan nu op naam van "Verwijderde gebruiker".
    const heir = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND username = 'verwijderd~'").get(tid);
    assert.strictEqual(heir.kind, 'systeem');
    assert.strictEqual(db.prepare('SELECT owner_id FROM plans WHERE id = ?').get(p.id).owner_id, heir.id);
    assert.strictEqual(db.prepare('SELECT owner_id FROM quotes WHERE id = ?').get(qt.id).owner_id, heir.id);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM history WHERE user_id = ?').get(ids.ina).n, 0);
    const users = (await baas.get('/api/admin/users')).body.items;
    assert.ok(!users.some((u) => u.username === 'ina'));
    assert.strictEqual(users.find((u) => u.username === 'verwijderd~').planCount, 1);
    const audit = (await baas.get('/api/admin/audit')).body.items.find((a) => a.action === 'gebruiker_verwijderd');
    assert.strictEqual(audit.detail.username, 'ina');

    // Nog een keer: niet gevonden. Systeemgebruikers zijn niet te verwijderen.
    assert.strictEqual((await baas.del(`/api/admin/users/${ids.ina}`)).status, 404);
    assert.strictEqual((await baas.del(`/api/admin/users/${heir.id}`)).status, 409);
  } finally {
    server.close();
  }
});

test('niet jezelf, niet de laatste beheerder en een hoofdbeheerder alleen door een hoofdbeheerder', async () => {
  const { server, as, store, tid, ids } = await setup();
  try {
    const baas = await as('baas'), hoofd = await as('hoofd');
    assert.strictEqual((await baas.del(`/api/admin/users/${ids.baas}`)).status, 409, 'zichzelf');
    assert.strictEqual((await baas.del(`/api/admin/users/${ids.hoofd}`)).status, 403, 'beheerder kan hoofdbeheerder niet verwijderen');
    assert.strictEqual((await hoofd.del(`/api/platform/tenants/${tid}/users/${ids.hoofd}`)).status, 409, 'zichzelf via hoofdbeheer');

    // Laatste actieve hoofdbeheerder: ook een tweede hoofdbeheerder kan die niet weghalen als die de enige actieve is.
    const tweede = (await store.createAccount(tid, { username: 'hoofd2', displayName: 'Hoofd 2', role: 'beheerder', password: PW }, { platformAdmin: true })).user;
    const h2 = await as('hoofd2');
    assert.strictEqual((await hoofd.patch(`/api/platform/tenants/${tid}/users/${tweede.id}`, { disabled: true })).status, 200);
    assert.strictEqual((await h2.get('/api/me')).body.user, null);
    // hoofd2 is uitgeschakeld; hoofd is nu de enige actieve: door de store geweigerd.
    assert.strictEqual(store.deleteAccount(tid, ids.hoofd).status, 409);
    // Een uitgeschakelde hoofdbeheerder kan wel weg.
    assert.strictEqual((await hoofd.del(`/api/platform/tenants/${tid}/users/${tweede.id}`)).status, 200);

    // Laatste actieve beheerder van een andere tenant.
    const klant = (await hoofd.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'gerrit', displayName: 'Gerrit', password: PW } }));
    assert.strictEqual(klant.status, 201, JSON.stringify(klant.body));
    const gt = klant.body.tenant.id;
    const gbUsers = (await hoofd.get(`/api/platform/tenants/${gt}/users`)).body.items;
    const gb = gbUsers.find((u) => u.username === 'gerrit');
    assert.strictEqual((await hoofd.del(`/api/platform/tenants/${gt}/users/${gb.id}`)).status, 409, 'laatste beheerder');
    const ext = await hoofd.post(`/api/platform/tenants/${gt}/users`, { username: 'gerda', displayName: 'Gerda', role: 'beheerder', password: PW });
    assert.strictEqual(ext.status, 201);
    assert.strictEqual((await hoofd.del(`/api/platform/tenants/${gt}/users/${gb.id}`)).status, 200);
    // Een beheerder van de hoofdtenant kan geen gebruiker van een andere tenant verwijderen.
    assert.strictEqual((await baas.del(`/api/admin/users/${ext.body.id}`)).status, 404);
    assert.strictEqual((await baas.del(`/api/platform/tenants/${gt}/users/${ext.body.id}`)).status, 403);
  } finally {
    server.close();
  }
});
