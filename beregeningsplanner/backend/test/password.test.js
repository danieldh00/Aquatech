// Eigen wachtwoord wijzigen en "wachtwoord wijzigen na eerste aanmelding".
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

async function start() {
  const db = openDb();
  const store = createStore(db);
  await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  return new Promise((resolve) => {
    const app = createApp({ secret: SECRET, db });
    const server = app.listen(0, () => resolve({ store, server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

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
      if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i)); else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* geen JSON */ }
    return { status: res.status, body: json, text };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

async function login(base, username, password) {
  const c = client(base);
  const r = await c.post('/api/auth/login', { username, password });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return c;
}

test('gebruiker wijzigt zelf het wachtwoord; andere sessies vervallen', async () => {
  const { server, base } = await start();
  try {
    const baas = await login(base, 'baas', PW);
    await baas.post('/api/admin/users', { username: 'jan', displayName: 'Jan', role: 'installateur', password: 'Gras-Pomp-2027!', mustChangePassword: false });
    const jan = await login(base, 'jan', 'Gras-Pomp-2027!');
    const tweede = await login(base, 'jan', 'Gras-Pomp-2027!');
    assert.strictEqual((await jan.get('/api/me')).body.user.mustChangePassword, false);
    assert.match((await jan.get('/wachtwoord')).text, /Wachtwoord wijzigen/);

    assert.strictEqual((await jan.post('/api/account/password', { currentPassword: 'fout', newPassword: 'Haag-Slang-2028!' })).status, 401);
    assert.strictEqual((await jan.post('/api/account/password', { currentPassword: 'Gras-Pomp-2027!', newPassword: 'kort' })).status, 400);
    assert.strictEqual((await jan.post('/api/account/password', { currentPassword: 'Gras-Pomp-2027!', newPassword: 'Gras-Pomp-2027!' })).status, 400);
    const ok = await jan.post('/api/account/password', { currentPassword: 'Gras-Pomp-2027!', newPassword: 'Haag-Slang-2028!' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    // Dit toestel blijft ingelogd, het andere niet; het oude wachtwoord werkt niet meer.
    assert.strictEqual((await jan.get('/api/me')).body.user.username, 'jan');
    assert.strictEqual((await tweede.get('/api/me')).body.user, null);
    assert.strictEqual((await client(base).post('/api/auth/login', { username: 'jan', password: 'Gras-Pomp-2027!' })).status, 401);
    await login(base, 'jan', 'Haag-Slang-2028!');
    const audit = (await baas.get('/api/admin/audit')).body.items.map((a) => a.action);
    assert.ok(audit.includes('wachtwoord_gewijzigd'));

    // Met de toegangscode of als gast is er geen eigen wachtwoord.
    assert.strictEqual((await client(base).post('/api/account/password', { currentPassword: 'x', newPassword: 'Haag-Slang-2028!' })).status, 400);
  } finally {
    server.close();
  }
});

test('nieuw account en reset door beheerder: eerst zelf een wachtwoord kiezen', async () => {
  const { server, base } = await start();
  try {
    const baas = await login(base, 'baas', PW);
    // Standaard aan bij een nieuw account.
    const piet = (await baas.post('/api/admin/users', { username: 'piet', displayName: 'Piet', role: 'installateur', password: 'Gras-Pomp-2027!' })).body;
    assert.strictEqual(piet.mustChangePassword, true);
    const p = await login(base, 'piet', 'Gras-Pomp-2027!');
    assert.strictEqual((await p.get('/api/me')).body.user.mustChangePassword, true);
    // Alles is dicht behalve de wachtwoordpagina.
    const blocked = await p.get('/api/plans');
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.body.error, 'password_change_required');
    assert.strictEqual((await p.get('/beregening/api/plans')).status, 403);
    for (const page of ['/', '/beregening/', '/offertes/index.html']) assert.match((await p.get(page)).text, /id="new1"/, page);
    assert.strictEqual((await p.get('/api/health')).status, 200);

    assert.strictEqual((await p.post('/api/account/password', { currentPassword: 'Gras-Pomp-2027!', newPassword: 'Haag-Slang-2028!' })).status, 200);
    assert.strictEqual((await p.get('/api/me')).body.user.mustChangePassword, false);
    assert.strictEqual((await p.get('/api/plans')).status, 200);
    assert.doesNotMatch((await p.get('/')).text, /id="new1"/);

    // Reset door de beheerder zet de optie weer aan, tenzij die uit wordt gezet.
    assert.strictEqual((await baas.patch(`/api/admin/users/${piet.id}`, { password: 'Bloem-Perk-2029!' })).body.mustChangePassword, true);
    assert.strictEqual((await baas.patch(`/api/admin/users/${piet.id}`, { mustChangePassword: false })).body.mustChangePassword, false);
    const p2 = await login(base, 'piet', 'Bloem-Perk-2029!');
    assert.strictEqual((await p2.get('/api/plans')).status, 200);
    assert.strictEqual((await baas.patch(`/api/admin/users/${piet.id}`, { password: 'Vijver-Mos-2030!', mustChangePassword: false })).body.mustChangePassword, false);
    // Aan/uit zetten zonder reset (lopende sessies blijven, maar moeten nu eerst wijzigen).
    const p3 = await login(base, 'piet', 'Vijver-Mos-2030!');
    await baas.patch(`/api/admin/users/${piet.id}`, { mustChangePassword: true });
    assert.strictEqual((await p3.get('/api/plans')).status, 403);

    // Uit bij het aanmaken.
    const kees = (await baas.post('/api/admin/users', { username: 'kees', role: 'klant', password: 'Gras-Pomp-2027!', mustChangePassword: false })).body;
    assert.strictEqual(kees.mustChangePassword, false);
    // Ook via het hoofdbeheer: nieuwe tenant met beheerder, standaard aan.
    const made = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'anna', password: 'Haag-Slang-2028!' } })).body;
    const users = (await baas.get(`/api/platform/tenants/${made.tenant.id}/users`)).body.items;
    assert.strictEqual(users.find((u) => u.username === 'anna').mustChangePassword, true);
    const audit = (await baas.get('/api/admin/audit')).body.items.find((a) => a.action === 'gebruiker_gewijzigd');
    assert.ok(!JSON.stringify(audit).includes('Vijver'), 'nooit het wachtwoord in de audit');
  } finally {
    server.close();
  }
});
