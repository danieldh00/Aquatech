const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../src/server');
const { openDb, MIGRATIONS, schemaVersion } = require('../src/db');
const { COOKIE_NAME } = require('../src/auth');

const SECRET = 'y'.repeat(64);
const GUESTS = { accessCode: '', env: { GUEST_ACCESS: 'true' } };

function start(opts = {}) {
  return new Promise((resolve) => {
    const server = createApp({ accessCode: 'geheim', secret: SECRET, db: openDb(), ...opts }).listen(0, () => {
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
  };
}

const plan = (name, extra = {}) => ({
  meta: { name, customer: 'Fam. Jansen', address: 'Dorpsstraat 1' },
  areas: [{ id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }] }],
  sprinklers: [{ id: 's1' }, { id: 's2' }],
  zones: [],
  elements: [],
  ...extra,
});

test('zonder toegangscode: elke gast ziet alleen de eigen plannen, geen historie', async () => {
  const { server, base } = await start(GUESTS);
  try {
    const a = client(base), b = client(base);
    assert.strictEqual((await a.get('/api/me')).body.guest, true);
    const created = await a.post('/api/plans', { data: plan('Tuin A') });
    assert.strictEqual(created.status, 201);
    assert.ok(a.jar.has('aquatech_guest'), 'gast-cookie gezet');
    const me = (await a.get('/api/me')).body;
    assert.strictEqual(me.user.role, 'klant', 'een gast is een klant');
    assert.strictEqual(me.user.kind, 'gast');

    assert.strictEqual((await a.get('/api/plans')).body.items.length, 1);
    assert.strictEqual((await a.get(`/api/plans/${created.body.id}`)).body.data.meta.name, 'Tuin A');

    // Andere browser: ziet het plan niet en kan het niet wijzigen of wissen.
    assert.deepStrictEqual((await b.get('/api/plans')).body.items, []);
    assert.strictEqual((await b.get(`/api/plans/${created.body.id}`)).status, 404);
    await b.post('/api/plans', { data: plan('Tuin B') });
    assert.strictEqual((await b.put(`/api/plans/${created.body.id}`, { data: plan('Gekaapt') })).status, 404);
    assert.strictEqual((await b.del(`/api/plans/${created.body.id}`)).status, 404);
    assert.strictEqual((await b.get('/api/plans')).body.items.length, 1);

    // Historie en gebruikers zijn alleen voor beheerders.
    for (const p of ['/api/admin/history', '/api/admin/users', '/api/admin/plans']) {
      assert.strictEqual((await a.get(p)).status, 403, p);
    }
    assert.strictEqual((await client(base).get('/api/admin/history')).status, 401);

    // Vervalste gast-cookie telt niet.
    const c = client(base);
    c.jar.set('aquatech_guest', `${me.user.id}.nep`);
    assert.deepStrictEqual((await c.get('/api/plans')).body.items, []);
  } finally {
    server.close();
  }
});

test('met toegangscode: geen gasten, plannen alleen na inloggen', async () => {
  const { server, base } = await start();
  try {
    const anon = client(base);
    assert.strictEqual((await anon.post('/api/plans', { data: plan('X') })).status, 401);
    assert.ok(!anon.jar.has('aquatech_guest'));
    assert.deepStrictEqual((await anon.get('/api/plans')).body.items, []);
  } finally {
    server.close();
  }
});

test('beheerder maakt gebruikers aan en ziet de historie van alle aanvragen', async () => {
  const { server, base } = await start();
  try {
    const admin = client(base);
    assert.strictEqual((await admin.post('/api/auth/login', { code: 'geheim' })).status, 200);
    assert.strictEqual((await admin.get('/api/me')).body.user.role, 'beheerder');

    assert.strictEqual((await admin.post('/api/admin/users', { username: 'x', role: 'gebruiker', password: 'kort', mustChangePassword: false })).status, 400);
    const piet = await admin.post('/api/admin/users', { username: 'piet', displayName: 'Piet', role: 'gebruiker', password: 'Tuin-Plan-2026!', mustChangePassword: false });
    assert.strictEqual(piet.status, 201);
    assert.strictEqual((await admin.post('/api/admin/users', { username: 'piet', role: 'gebruiker', password: 'Tuin-Plan-2026!', mustChangePassword: false })).status, 400);
    await admin.post('/api/admin/users', { username: 'kees', role: 'klant', password: 'Gras-Pomp-2027!', mustChangePassword: false });

    const p = client(base), k = client(base);
    assert.strictEqual((await p.post('/api/auth/login', { username: 'piet', password: 'fout-fout' })).status, 401);
    assert.strictEqual((await p.post('/api/auth/login', { username: 'Piet', password: 'Tuin-Plan-2026!' })).status, 200);
    await k.post('/api/auth/login', { username: 'kees', password: 'Gras-Pomp-2027!' });
    assert.strictEqual((await p.get('/api/admin/history')).status, 403);

    const bg = { dataUrl: 'data:image/png;base64,AAAA' };
    const made = await p.post('/api/plans', { data: plan('Tuin Piet', { background: bg }) });
    assert.strictEqual(made.status, 201);
    // Snel achter elkaar opslaan = één historieregel.
    await p.put(`/api/plans/${made.body.id}`, { data: plan('Tuin Piet v2', { background: bg }) });
    await p.put(`/api/plans/${made.body.id}`, { data: plan('Tuin Piet v3', { background: bg }) });
    await k.post('/api/plans', { data: plan('Tuin Kees') });

    // Kees (klant) ziet Piets plan niet.
    assert.strictEqual((await k.get(`/api/plans/${made.body.id}`)).status, 404);

    let hist = (await admin.get('/api/admin/history')).body;
    assert.strictEqual(hist.total, 2);
    const row = hist.items.find((h) => h.planId === made.body.id);
    assert.strictEqual(row.action, 'aangemaakt');
    assert.strictEqual(row.title, 'Tuin Piet v3');
    assert.strictEqual(row.customer, 'Fam. Jansen');
    assert.strictEqual(row.user.displayName, 'Piet');
    assert.deepStrictEqual([row.summary.areas, row.summary.totalM2, row.summary.sprinklers], [1, 50, 2]);

    const detail = (await admin.get(`/api/admin/history/${row.id}`)).body;
    assert.strictEqual(detail.snapshot.meta.name, 'Tuin Piet v3');
    assert.strictEqual(detail.snapshot.background, undefined, 'geen achtergrond in de historie');
    // Het plan zelf houdt de achtergrond wel.
    assert.deepStrictEqual((await p.get(`/api/plans/${made.body.id}`)).body.data.background, bg);
    // De beheerder kan elk plan openen.
    assert.strictEqual((await admin.get(`/api/admin/plans/${made.body.id}`)).status, 200);
    assert.strictEqual((await admin.get('/api/admin/plans')).body.items.length, 2);

    // Filter en zoeken.
    assert.strictEqual((await admin.get(`/api/admin/history?user=${piet.body.id}`)).body.total, 1);
    assert.strictEqual((await admin.get('/api/admin/history?q=kees')).body.total, 1);
    assert.strictEqual((await admin.get('/api/admin/history?q=%25')).body.total, 0);

    // Verwijderen: het plan verdwijnt voor de gebruiker, de historie blijft.
    assert.strictEqual((await p.del(`/api/plans/${made.body.id}`)).status, 200);
    assert.deepStrictEqual((await p.get('/api/plans')).body.items, []);
    hist = (await admin.get(`/api/admin/history?user=${piet.body.id}`)).body;
    assert.deepStrictEqual(hist.items.map((h) => h.action), ['verwijderd', 'aangemaakt']);
    assert.ok(hist.items.every((h) => h.planDeleted));

    const users = (await admin.get('/api/admin/users')).body.items;
    assert.ok(users.some((u) => u.username === 'beheerder' && u.kind === 'systeem'));
    assert.strictEqual(users.find((u) => u.username === 'piet').historyCount, 2);
  } finally {
    server.close();
  }
});

test('uitgeschakelde gebruiker of nieuw wachtwoord: sessie vervalt', async () => {
  const { server, base } = await start();
  try {
    const admin = client(base);
    await admin.post('/api/auth/login', { code: 'geheim' });
    const u = (await admin.post('/api/admin/users', { username: 'anna', role: 'gebruiker', password: 'Tuin-Plan-2026!', mustChangePassword: false })).body;
    const a = client(base);
    await a.post('/api/auth/login', { username: 'anna', password: 'Tuin-Plan-2026!' });
    assert.strictEqual((await a.get('/api/me')).body.user.username, 'anna');

    await admin.patch(`/api/admin/users/${u.id}`, { password: 'Nieuw-Sproei-88', mustChangePassword: false });
    assert.strictEqual((await a.get('/api/me')).body.user, null);
    await a.post('/api/auth/login', { username: 'anna', password: 'Nieuw-Sproei-88' });
    assert.strictEqual((await a.get('/api/me')).body.user.username, 'anna');

    await admin.patch(`/api/admin/users/${u.id}`, { disabled: true });
    assert.strictEqual((await a.get('/api/me')).body.user, null);
    assert.strictEqual((await a.post('/api/auth/login', { username: 'anna', password: 'Nieuw-Sproei-88' })).status, 401);

    // Rol wijzigen naar beheerder geeft toegang tot de historie.
    await admin.patch(`/api/admin/users/${u.id}`, { disabled: false, role: 'beheerder' });
    await a.post('/api/auth/login', { username: 'anna', password: 'Nieuw-Sproei-88' });
    assert.strictEqual((await a.get('/api/admin/history')).status, 200);

    // Systeemgebruikers zijn niet aan te passen.
    const sys = (await admin.get('/api/admin/users')).body.items.find((x) => x.kind === 'systeem');
    assert.strictEqual((await admin.patch(`/api/admin/users/${sys.id}`, { role: 'gebruiker' })).status, 409);
  } finally {
    server.close();
  }
});

test('oude ondertekende sessie-cookie (van voor de serversessies) geeft geen toegang meer', async () => {
  const { server, base } = await start();
  try {
    const hmac = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
    const payload = `${Date.now()}.${hmac('code:geheim').slice(0, 16)}`;
    const c = client(base);
    c.jar.set(COOKIE_NAME, `${payload}.${hmac(payload)}`);
    assert.strictEqual((await c.get('/api/me')).body.user, null);
    assert.strictEqual((await c.get('/api/admin/history')).status, 401);
  } finally {
    server.close();
  }
});

test('schrijven vereist JSON', async () => {
  const { server, base } = await start(GUESTS);
  try {
    const res = await fetch(`${base}/api/plans`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"data":{"areas":[]}}' });
    assert.strictEqual(res.status, 415);
  } finally {
    server.close();
  }
});

test('database blijft bewaard na herstart en migreert niet dubbel', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-db-'));
  const file = path.join(dir, 'aquatech.db');
  try {
    let db = openDb(file);
    db.prepare("INSERT INTO tenants (id, slug, name, created_at) VALUES ('t', 'x', 'X', 'nu')").run();
    db.close();
    db = openDb(file);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n, 1);
    assert.strictEqual(schemaVersion(db), MIGRATIONS.length);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('API is ook relatief vanuit een module bereikbaar (beregening/api/...)', async () => {
  const { server, base } = await start(GUESTS);
  try {
    const a = client(base);
    const made = await a.post('/beregening/api/plans', { data: plan('Via module') });
    assert.strictEqual(made.status, 201);
    assert.strictEqual((await a.get('/beheer/api/plans')).body.items[0].id, made.body.id);
    assert.strictEqual((await a.get('/beheer/api/admin/history')).status, 403);
    // Geen module: geen API (gewoon het dashboard).
    assert.strictEqual((await a.get('/onbekend/api/plans')).body, null);
  } finally {
    server.close();
  }
});

test('plannenoverzicht: samenvatting per plan; beheerder ziet alles plus historie', async () => {
  const { server, base } = await start();
  try {
    const admin = client(base);
    await admin.post('/api/auth/login', { code: 'geheim' });
    await admin.post('/api/admin/users', { username: 'joop', displayName: 'Joop', role: 'gebruiker', password: 'Tuin-Plan-2026!', mustChangePassword: false });
    const j = client(base);
    await j.post('/api/auth/login', { username: 'joop', password: 'Tuin-Plan-2026!' });
    const a = (await j.post('/api/plans', { data: plan('Tuin A', { background: { dataUrl: 'data:image/png;base64,AAAA' } }) })).body;
    const b = (await j.post('/api/plans', { data: plan('Tuin B') })).body;
    await j.del(`/api/plans/${b.id}`);

    const own = (await j.get('/api/plans')).body.items;
    assert.strictEqual(own.length, 1);
    assert.deepStrictEqual([own[0].title, own[0].summary.areas, own[0].summary.m2ByType.lawn, own[0].summary.sprinklers], ['Tuin A', 1, 50, 2]);
    assert.strictEqual(own[0].historyCount, undefined, 'gebruikers zien geen historie');
    assert.strictEqual((await j.get(`/api/admin/plans/${a.id}/history`)).status, 403);

    const all = (await admin.get('/api/admin/plans')).body.items;
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].owner.displayName, 'Joop');
    assert.strictEqual(all[0].historyCount, 1);
    const withDeleted = (await admin.get('/api/admin/plans?deleted=1')).body.items;
    assert.strictEqual(withDeleted.length, 2);
    assert.ok(withDeleted.find((p) => p.id === b.id).deletedAt);

    const hist = (await admin.get(`/api/admin/plans/${b.id}/history`)).body;
    assert.deepStrictEqual(hist.items.map((h) => h.action), ['verwijderd', 'aangemaakt']);
  } finally {
    server.close();
  }
});
