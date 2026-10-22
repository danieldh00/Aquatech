// Historie van aanvragen, gasten, accounts, beheer van plannen en sessies.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../src/server');
const { openDb, MIGRATIONS, schemaVersion } = require('../src/database/db');
const { COOKIE_NAME } = require('../src/beveiliging/auth');
const { createClient, listen } = require('./helpers/http-client');

const SECRET = 'y'.repeat(64);
const GUESTS = { accessCode: '', env: { GUEST_ACCESS: 'true' } };

/**
 * Start een testserver met toegangscode 'geheim' en een eigen database.
 * @param {object} [opts] Extra opties voor createApp.
 * @returns {Promise<{ server: import('http').Server, base: string }>} De server en zijn adres.
 */
function start(opts = {}) {
  return listen(createApp({ accessCode: 'geheim', secret: SECRET, db: openDb(), ...opts }));
}

/**
 * Maakt een plan met één gazon en twee sproeiers.
 * @param {string} name Naam van het plan.
 * @param {object} [extra] Velden die de standaard aanvullen of overschrijven.
 * @returns {object} De plangegevens.
 */
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
    const firstGuest = createClient(base), secondGuest = createClient(base);
    assert.strictEqual((await firstGuest.get('/api/me')).body.guest, true);
    const created = await firstGuest.post('/api/plans', { data: plan('Tuin A') });
    assert.strictEqual(created.status, 201);
    assert.ok(firstGuest.jar.has('aquatech_guest'), 'gast-cookie gezet');
    const me = (await firstGuest.get('/api/me')).body;
    assert.strictEqual(me.user.role, 'klant', 'een gast is een klant');
    assert.strictEqual(me.user.kind, 'gast');

    assert.strictEqual((await firstGuest.get('/api/plans')).body.items.length, 1);
    assert.strictEqual((await firstGuest.get(`/api/plans/${created.body.id}`)).body.data.meta.name, 'Tuin A');

    // Andere browser: ziet het plan niet en kan het niet wijzigen of wissen.
    assert.deepStrictEqual((await secondGuest.get('/api/plans')).body.items, []);
    assert.strictEqual((await secondGuest.get(`/api/plans/${created.body.id}`)).status, 404);
    await secondGuest.post('/api/plans', { data: plan('Tuin B') });
    assert.strictEqual((await secondGuest.put(`/api/plans/${created.body.id}`, { data: plan('Gekaapt') })).status, 404);
    assert.strictEqual((await secondGuest.del(`/api/plans/${created.body.id}`)).status, 404);
    assert.strictEqual((await secondGuest.get('/api/plans')).body.items.length, 1);

    // Historie en gebruikers zijn alleen voor beheerders.
    for (const urlPath of ['/api/admin/history', '/api/admin/users', '/api/admin/plans']) {
      assert.strictEqual((await firstGuest.get(urlPath)).status, 403, urlPath);
    }
    assert.strictEqual((await createClient(base).get('/api/admin/history')).status, 401);

    // Vervalste gast-cookie telt niet.
    const client = createClient(base);
    client.jar.set('aquatech_guest', `${me.user.id}.nep`);
    assert.deepStrictEqual((await client.get('/api/plans')).body.items, []);
  } finally {
    server.close();
  }
});

test('met toegangscode: geen gasten, plannen alleen na inloggen', async () => {
  const { server, base } = await start();
  try {
    const anon = createClient(base);
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
    const admin = createClient(base);
    assert.strictEqual((await admin.post('/api/auth/login', { code: 'geheim' })).status, 200);
    assert.strictEqual((await admin.get('/api/me')).body.user.role, 'beheerder');

    assert.strictEqual((await admin.post('/api/admin/users', { username: 'x', role: 'gebruiker', password: 'kort', mustChangePassword: false })).status, 400);
    const piet = await admin.post('/api/admin/users', { username: 'piet', displayName: 'Piet', role: 'gebruiker', password: 'Tuin-Plan-2026!', mustChangePassword: false });
    assert.strictEqual(piet.status, 201);
    assert.strictEqual((await admin.post('/api/admin/users', { username: 'piet', role: 'gebruiker', password: 'Tuin-Plan-2026!', mustChangePassword: false })).status, 400);
    await admin.post('/api/admin/users', { username: 'kees', role: 'klant', password: 'Gras-Pomp-2027!', mustChangePassword: false });

    const pietClient = createClient(base), keesClient = createClient(base);
    assert.strictEqual((await pietClient.post('/api/auth/login', { username: 'piet', password: 'fout-fout' })).status, 401);
    assert.strictEqual((await pietClient.post('/api/auth/login', { username: 'Piet', password: 'Tuin-Plan-2026!' })).status, 200);
    await keesClient.post('/api/auth/login', { username: 'kees', password: 'Gras-Pomp-2027!' });
    assert.strictEqual((await pietClient.get('/api/admin/history')).status, 403);

    const bg = { dataUrl: 'data:image/png;base64,AAAA' };
    const made = await pietClient.post('/api/plans', { data: plan('Tuin Piet', { background: bg }) });
    assert.strictEqual(made.status, 201);
    // Snel achter elkaar opslaan = één historieregel.
    await pietClient.put(`/api/plans/${made.body.id}`, { data: plan('Tuin Piet v2', { background: bg }) });
    await pietClient.put(`/api/plans/${made.body.id}`, { data: plan('Tuin Piet v3', { background: bg }) });
    await keesClient.post('/api/plans', { data: plan('Tuin Kees') });

    // Kees (klant) ziet Piets plan niet.
    assert.strictEqual((await keesClient.get(`/api/plans/${made.body.id}`)).status, 404);

    let hist = (await admin.get('/api/admin/history')).body;
    assert.strictEqual(hist.total, 2);
    const row = hist.items.find((entry) => entry.planId === made.body.id);
    assert.strictEqual(row.action, 'aangemaakt');
    assert.strictEqual(row.title, 'Tuin Piet v3');
    assert.strictEqual(row.customer, 'Fam. Jansen');
    assert.strictEqual(row.user.displayName, 'Piet');
    assert.deepStrictEqual([row.summary.areas, row.summary.totalM2, row.summary.sprinklers], [1, 50, 2]);

    const detail = (await admin.get(`/api/admin/history/${row.id}`)).body;
    assert.strictEqual(detail.snapshot.meta.name, 'Tuin Piet v3');
    assert.strictEqual(detail.snapshot.background, undefined, 'geen achtergrond in de historie');
    // Het plan zelf houdt de achtergrond wel.
    assert.deepStrictEqual((await pietClient.get(`/api/plans/${made.body.id}`)).body.data.background, bg);
    // De beheerder kan elk plan openen.
    assert.strictEqual((await admin.get(`/api/admin/plans/${made.body.id}`)).status, 200);
    assert.strictEqual((await admin.get('/api/admin/plans')).body.items.length, 2);

    // Filter en zoeken.
    assert.strictEqual((await admin.get(`/api/admin/history?user=${piet.body.id}`)).body.total, 1);
    assert.strictEqual((await admin.get('/api/admin/history?q=kees')).body.total, 1);
    assert.strictEqual((await admin.get('/api/admin/history?q=%25')).body.total, 0);

    // Verwijderen: het plan verdwijnt voor de gebruiker, de historie blijft.
    assert.strictEqual((await pietClient.del(`/api/plans/${made.body.id}`)).status, 200);
    assert.deepStrictEqual((await pietClient.get('/api/plans')).body.items, []);
    hist = (await admin.get(`/api/admin/history?user=${piet.body.id}`)).body;
    assert.deepStrictEqual(hist.items.map((entry) => entry.action), ['verwijderd', 'aangemaakt']);
    assert.ok(hist.items.every((entry) => entry.planDeleted));

    const users = (await admin.get('/api/admin/users')).body.items;
    assert.ok(users.some((user) => user.username === 'beheerder' && user.kind === 'systeem'));
    assert.strictEqual(users.find((user) => user.username === 'piet').historyCount, 2);
  } finally {
    server.close();
  }
});

test('uitgeschakelde gebruiker of nieuw wachtwoord: sessie vervalt', async () => {
  const { server, base } = await start();
  try {
    const admin = createClient(base);
    await admin.post('/api/auth/login', { code: 'geheim' });
    const anna = (await admin.post('/api/admin/users', { username: 'anna', role: 'gebruiker', password: 'Tuin-Plan-2026!', mustChangePassword: false })).body;
    const annaClient = createClient(base);
    await annaClient.post('/api/auth/login', { username: 'anna', password: 'Tuin-Plan-2026!' });
    assert.strictEqual((await annaClient.get('/api/me')).body.user.username, 'anna');

    await admin.patch(`/api/admin/users/${anna.id}`, { password: 'Nieuw-Sproei-88', mustChangePassword: false });
    assert.strictEqual((await annaClient.get('/api/me')).body.user, null);
    await annaClient.post('/api/auth/login', { username: 'anna', password: 'Nieuw-Sproei-88' });
    assert.strictEqual((await annaClient.get('/api/me')).body.user.username, 'anna');

    await admin.patch(`/api/admin/users/${anna.id}`, { disabled: true });
    assert.strictEqual((await annaClient.get('/api/me')).body.user, null);
    assert.strictEqual((await annaClient.post('/api/auth/login', { username: 'anna', password: 'Nieuw-Sproei-88' })).status, 401);

    // Rol wijzigen naar beheerder geeft toegang tot de historie.
    await admin.patch(`/api/admin/users/${anna.id}`, { disabled: false, role: 'beheerder' });
    await annaClient.post('/api/auth/login', { username: 'anna', password: 'Nieuw-Sproei-88' });
    assert.strictEqual((await annaClient.get('/api/admin/history')).status, 200);

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
    /**
     * Ondertekent een waarde zoals de oude sessie-cookie dat deed.
     * @param {string} value De waarde.
     * @returns {string} De HMAC als base64url.
     */
    const hmac = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
    const payload = `${Date.now()}.${hmac('code:geheim').slice(0, 16)}`;
    const client = createClient(base);
    client.jar.set(COOKIE_NAME, `${payload}.${hmac(payload)}`);
    assert.strictEqual((await client.get('/api/me')).body.user, null);
    assert.strictEqual((await client.get('/api/admin/history')).status, 401);
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
    const annaClient = createClient(base);
    const made = await annaClient.post('/beregening/api/plans', { data: plan('Via module') });
    assert.strictEqual(made.status, 201);
    assert.strictEqual((await annaClient.get('/beheer/api/plans')).body.items[0].id, made.body.id);
    assert.strictEqual((await annaClient.get('/beheer/api/admin/history')).status, 403);
    // Geen module: geen API (gewoon het dashboard).
    assert.strictEqual((await annaClient.get('/onbekend/api/plans')).body, null);
  } finally {
    server.close();
  }
});

test('plannenoverzicht: samenvatting per plan; beheerder ziet alles plus historie', async () => {
  const { server, base } = await start();
  try {
    const admin = createClient(base);
    await admin.post('/api/auth/login', { code: 'geheim' });
    await admin.post('/api/admin/users', { username: 'joop', displayName: 'Joop', role: 'gebruiker', password: 'Tuin-Plan-2026!', mustChangePassword: false });
    const joop = createClient(base);
    await joop.post('/api/auth/login', { username: 'joop', password: 'Tuin-Plan-2026!' });
    const planA = (await joop.post('/api/plans', { data: plan('Tuin A', { background: { dataUrl: 'data:image/png;base64,AAAA' } }) })).body;
    const planB = (await joop.post('/api/plans', { data: plan('Tuin B') })).body;
    await joop.del(`/api/plans/${planB.id}`);

    const own = (await joop.get('/api/plans')).body.items;
    assert.strictEqual(own.length, 1);
    assert.deepStrictEqual([own[0].title, own[0].summary.areas, own[0].summary.m2ByType.lawn, own[0].summary.sprinklers], ['Tuin A', 1, 50, 2]);
    assert.strictEqual(own[0].historyCount, undefined, 'gebruikers zien geen historie');
    assert.strictEqual((await joop.get(`/api/admin/plans/${planA.id}/history`)).status, 403);

    const all = (await admin.get('/api/admin/plans')).body.items;
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].owner.displayName, 'Joop');
    assert.strictEqual(all[0].historyCount, 1);
    const withDeleted = (await admin.get('/api/admin/plans?deleted=1')).body.items;
    assert.strictEqual(withDeleted.length, 2);
    assert.ok(withDeleted.find((plan) => plan.id === planB.id).deletedAt);

    const hist = (await admin.get(`/api/admin/plans/${planB.id}/history`)).body;
    assert.deepStrictEqual(hist.items.map((entry) => entry.action), ['verwijderd', 'aangemaakt']);
  } finally {
    server.close();
  }
});
