// Mijn profiel: eigen naam, contactgegevens en voorkeuren.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore, preferencesOf } = require('../src/store');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

async function start() {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW });
  return new Promise((resolve) => {
    const app = createApp({ secret: SECRET, db, accessCode: 'Toegang-Code-2026!' });
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

async function login(base, username, password = PW) {
  const c = client(base);
  const r = await c.post('/api/auth/login', { username, password });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return c;
}

test('voorkeuren: alleen bekende sleutels, altijd compleet', () => {
  assert.deepStrictEqual(preferencesOf({ preferences: '{"startPage":"planning","mailCopy":true,"x":1}' }), { startPage: 'planning', mailCopy: true, newsSeenAt: '', seenRelease: '' });
  assert.deepStrictEqual(preferencesOf({ preferences: 'kapot' }), { startPage: '', mailCopy: false, newsSeenAt: '', seenRelease: '' });
  assert.deepStrictEqual(preferencesOf({ preferences: '{"startPage":"../x","mailCopy":"ja"}' }), { startPage: '', mailCopy: false, newsSeenAt: '', seenRelease: '' });
});

test('Mijn profiel: gegevens en voorkeuren wijzigen', async () => {
  const { server, base } = await start();
  try {
    const klaas = await login(base, 'klaas');
    const p = await klaas.get('/api/account/profile');
    assert.strictEqual(p.status, 200);
    assert.deepStrictEqual(p.body.preferences, { startPage: '', mailCopy: false, newsSeenAt: '', seenRelease: '' });
    assert.strictEqual(p.body.user.email, '');
    assert.deepStrictEqual((await klaas.get('/api/me')).body.preferences, { startPage: '', mailCopy: false, newsSeenAt: '', seenRelease: '' });

    // Ongeldige invoer: niets opgeslagen, met het veld erbij.
    const bad = await klaas.put('/api/account/profile', { email: 'geen-adres' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.field, 'email');
    assert.strictEqual((await klaas.put('/api/account/profile', { phone: 'bel me' })).body.field, 'phone');
    assert.strictEqual((await klaas.put('/api/account/profile', { displayName: '   ' })).body.field, 'displayName');
    assert.strictEqual((await klaas.put('/api/account/profile', { displayName: 'x'.repeat(81) })).status, 400);

    const ok = await klaas.put('/api/account/profile', { displayName: '  Klaas   Vaak ', email: 'Klaas@Voorbeeld.TEST', phone: '+31 (0)6 12-34 56 78', preferences: { startPage: 'portaal', onbekend: true } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.user.displayName, 'Klaas Vaak');
    assert.strictEqual(ok.body.user.email, 'klaas@voorbeeld.test');
    assert.strictEqual(ok.body.user.phone, '+31 (0)6 12-34 56 78');
    assert.deepStrictEqual(ok.body.preferences, { startPage: 'portaal', mailCopy: false, newsSeenAt: '', seenRelease: '' });
    // Alleen meegegeven velden veranderen; voorkeuren worden samengevoegd.
    const more = await klaas.put('/api/account/profile', { preferences: { mailCopy: true } });
    assert.deepStrictEqual(more.body.preferences, { startPage: 'portaal', mailCopy: true, newsSeenAt: '', seenRelease: '' });
    assert.strictEqual(more.body.user.email, 'klaas@voorbeeld.test');
    const me = (await klaas.get('/api/me')).body;
    assert.strictEqual(me.user.displayName, 'Klaas Vaak');
    assert.strictEqual(me.preferences.startPage, 'portaal');
    // Leegmaken mag.
    assert.strictEqual((await klaas.put('/api/account/profile', { email: '', phone: '' })).body.user.email, '');

    // Logboek: welke velden, nooit de waarden.
    const baas = await login(base, 'baas');
    const items = (await baas.get('/api/admin/audit')).body.items.filter((a) => a.action === 'profiel_gewijzigd');
    assert.ok(items.length >= 3);
    assert.ok(!JSON.stringify(items).includes('voorbeeld.test') && !JSON.stringify(items).includes('12-34'), 'geen persoonsgegevens in het logboek');
    // De beheerder ziet de contactgegevens in het gebruikersoverzicht.
    await klaas.put('/api/account/profile', { email: 'klaas@voorbeeld.test' });
    const users = (await baas.get('/api/admin/users')).body;
    const list = users.items || users;
    assert.strictEqual(list.find((u) => u.username === 'klaas').email, 'klaas@voorbeeld.test');
  } finally {
    server.close();
  }
});

test('Mijn profiel: niet zonder eigen account, pagina bereikbaar', async () => {
  const { server, base } = await start();
  try {
    assert.strictEqual((await client(base).get('/api/account/profile')).status, 400);
    // Met de toegangscode is er geen eigen profiel.
    const code = client(base);
    assert.strictEqual((await code.post('/api/auth/login', { code: 'Toegang-Code-2026!' })).status, 200);
    assert.strictEqual((await code.get('/api/account/profile')).status, 400);
    assert.strictEqual((await code.put('/api/account/profile', { displayName: 'X' })).status, 400);
    assert.strictEqual((await code.get('/api/me')).body.preferences, null);

    const klaas = await login(base, 'klaas');
    const page = await klaas.get('/profiel/');
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /Mijn profiel/);
    assert.match(page.text, /profiel\.js/);
  } finally {
    server.close();
  }
});

test('startpagina: het dashboard krijgt hem mee, alleen als de module er voor de gebruiker is', async () => {
  const { server, base } = await start();
  try {
    const klaas = await login(base, 'klaas');
    const meta = (html) => (/<meta name="aquatech-start" content="([^"]*)">/.exec(html) || [])[1] || null;
    assert.strictEqual(meta((await klaas.get('/')).text), null);
    await klaas.put('/api/account/profile', { preferences: { startPage: 'portaal' } });
    assert.strictEqual(meta((await klaas.get('/')).text), 'portaal/');
    // Alleen op het dashboard, niet op andere pagina's.
    assert.strictEqual(meta((await klaas.get('/plannen/')).text), null);
    // Een module waar de klant geen recht op heeft: geen doorverwijzing.
    await klaas.put('/api/account/profile', { preferences: { startPage: 'planning' } });
    assert.strictEqual(meta((await klaas.get('/')).text), null);
  } finally {
    server.close();
  }
});
