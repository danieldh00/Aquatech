// Testdata voor testomgevingen: opbouw (tuinen, offertes) en de API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb, listTables, tableColumns } = require('../src/db');
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
    login: (username, password, tenant) => call('POST', '/api/auth/login', { username, password, tenant }),
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
  assert.deepStrictEqual(set.accounts.map((a) => a.role).sort(), ['beheerder', 'installateur', 'installateur', 'klant', 'klant', 'klant', 'klant', 'planner']);
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
    const t = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!', mustChangePassword: false } })).body.tenant;
    const env = (await baas.post(`/api/platform/tenants/${t.id}/environments`, { name: 'Test' })).body.tenant;

    // Nooit in live, en alleen voor hoofdbeheerders.
    assert.strictEqual((await baas.post(`/api/platform/tenants/${t.id}/testdata`)).status, 409);
    const piet = client(base);
    await piet.login('piet', 'Gras-Pomp-2027!', 'groen');
    assert.strictEqual((await piet.post(`/api/platform/tenants/${env.id}/testdata`)).status, 403);

    const out = await baas.post(`/api/platform/tenants/${env.id}/testdata`);
    assert.strictEqual(out.status, 201);
    const { password, accounts, counts } = out.body;
    assert.strictEqual(accounts.length, 8);
    assert.ok(counts.plans >= 6 && counts.quotes === 6);
    const name = (suffix) => accounts.find((a) => a.username.endsWith(`.${suffix}`)).username;

    // Een testklant komt direct in de testomgeving en ziet alleen het eigene.
    const klant = client(base);
    assert.strictEqual((await klant.login(name('klant2'), password, 'groen')).status, 200);
    const me = (await klant.get('/api/me')).body;
    assert.strictEqual(me.tenant.id, env.id);
    assert.strictEqual(me.user.role, 'klant');
    const mine = (await klant.get('/api/quotes')).body.items;
    assert.deepStrictEqual(mine.map((q) => q.status), ['verzonden']);
    assert.strictEqual((await klant.post(`/api/quotes/${mine[0].id}/respond`, { answer: 'afgewezen', name: 'Testklant', reason: 'test' })).status, 200, 'akkoord vraagt een handtekening; afwijzen niet');
    assert.strictEqual((await klant.get('/api/admin/users')).status, 403);

    // Klantportaal: klant1 heeft een opgeleverde werkorder, klant4 een ingeplande.
    const devries = client(base);
    await devries.login(name('klant1'), password, 'groen');
    const p1 = (await devries.get('/api/portal')).body;
    assert.deepStrictEqual(p1.workorders.map((w) => w.status), ['gereed']);
    const dossier = (await devries.get(`/api/portal/workorders/${p1.workorders[0].id}`)).body;
    assert.ok(dossier.report.notes && dossier.report.completedOn && dossier.steps.every((st) => st.done));
    const vanberg = client(base);
    await vanberg.login(name('klant4'), password, 'groen');
    const p4 = (await vanberg.get('/api/portal')).body;
    assert.deepStrictEqual(p4.workorders.map((w) => w.status), ['gepland']);
    assert.ok(p4.workorders[0].plannedDate > new Date().toISOString().slice(0, 10), 'afspraak in de toekomst');
    assert.strictEqual(p4.workorders[0].appointment.state, 'ander_moment', 'reactie uit de planning zichtbaar');

    // De installateur ziet alle plannen en offertes van de testomgeving.
    const inst = client(base);
    await inst.login(name('installateur'), password, env.slug);
    assert.strictEqual((await inst.get('/api/plans?all=1')).body.items.length, counts.plans);
    assert.strictEqual((await inst.get('/api/quotes?all=1')).body.items.length, 6);
    const customers = (await inst.get('/api/quote-customers')).body.items;
    assert.strictEqual(customers.length, 4, 'de testklanten om een offerte aan te koppelen');

    // De testbeheerder beheert alleen de testaccounts, nooit live.
    const bea = client(base);
    await bea.login(name('beheerder'), password, 'groen');
    const users = (await bea.get('/api/admin/users')).body.items.map((u) => u.username);
    assert.strictEqual(users.length, 8);
    assert.ok(!users.includes('piet'));
    // Rollen gelden voor de hele organisatie: een testaccount kan ze niet wijzigen.
    assert.strictEqual((await bea.get('/api/admin/roles')).body.editable, false);
    assert.strictEqual((await bea.patch('/api/admin/roles/planner', { label: 'X' })).status, 403);
    const pietId = (await baas.get(`/api/platform/tenants/${t.id}/users`)).body.items[0].id;
    assert.strictEqual((await bea.patch(`/api/admin/users/${pietId}`, { disabled: true })).status, 404);
    assert.deepStrictEqual((await bea.get('/api/environments')).body.items.map((e) => e.id), [env.id]);

    // Live blijft leeg; de beheerder van live ziet de testaccounts niet.
    assert.deepStrictEqual((await piet.get('/api/admin/users')).body.items.map((u) => u.username), ['piet']);
    assert.deepStrictEqual((await piet.get('/api/admin/plans')).body.items, []);
    const list = (await baas.get('/api/platform/tenants')).body.items.find((x) => x.id === t.id);
    assert.strictEqual(list.userCount, 1);
    assert.strictEqual(list.environments[0].userCount, 8);
    assert.strictEqual((await baas.get(`/api/platform/tenants/${env.id}/users`)).body.items.length, 8);

    // Opnieuw vullen: zelfde gebruikersnamen, nieuw wachtwoord, oude sessies weg.
    const again = await baas.post(`/api/platform/tenants/${env.id}/testdata`);
    assert.strictEqual(again.status, 201);
    assert.notStrictEqual(again.body.password, password);
    assert.strictEqual((await klant.get('/api/me')).body.user, null);
    assert.strictEqual((await client(base).login(name('klant2'), again.body.password, 'groen')).status, 200);

    // Leegmaken ruimt de testaccounts op.
    assert.strictEqual((await baas.post(`/api/platform/tenants/${env.id}/reset`)).status, 200);
    assert.strictEqual((await client(base).login(name('klant2'), again.body.password, 'groen')).status, 401);
    assert.strictEqual((await baas.get('/api/platform/tenants')).body.items.find((x) => x.id === t.id).environments[0].planCount, 0);
  } finally {
    server.close();
  }
});

test('testdata vult alle features: klantlinks, akkoord met handtekening, werkorders en webshop', async () => {
  const db = await platformDb();
  const { server, base } = await start(db);
  try {
    const baas = client(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    const t = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!' } })).body.tenant;
    const env = (await baas.post(`/api/platform/tenants/${t.id}/environments`, { name: 'Test' })).body.tenant;
    const out = await baas.post(`/api/platform/tenants/${env.id}/testdata`, { shareBase: 'https://app.voorbeeld.nl/openbaar/offerte.html' });
    assert.strictEqual(out.status, 201);
    const { password, accounts, counts } = out.body;
    assert.strictEqual(counts.links, 5);
    assert.strictEqual(counts.responses, 4);
    assert.strictEqual(counts.workOrders, 3);
    assert.strictEqual(counts.appointmentLinks, 3);
    assert.strictEqual(counts.appointments, 3);
    assert.ok(counts.products > 40);

    const inst = client(base);
    await inst.login(accounts.find((a) => a.username.endsWith('.installateur')).username, password, 'groen');
    const list = (await inst.get('/api/quotes?all=1')).body.items;
    assert.deepStrictEqual([...new Set(list.map((q) => q.status))].sort(), ['afgewezen', 'akkoord', 'concept', 'verzonden']);
    for (const item of list) {
      const q = (await inst.get(`/api/quotes/${item.id}`)).body;
      if (q.status === 'concept') { assert.strictEqual(q.share.active, false); continue; }
      // De klantlink is zichtbaar voor de installateur en werkt zonder inlog.
      assert.match(q.share.url, /^https:\/\/app\.voorbeeld\.nl\/openbaar\/offerte\.html#t=[A-Za-z0-9_-]{20,}$/);
      assert.ok(q.share.viewCount > 0 && q.share.sentAt);
      const pub = await fetch(`${base}/api/public/quote`, { headers: { 'X-Offerte-Token': q.share.url.split('#t=')[1] } });
      assert.strictEqual(pub.status, 200);
      if (q.status === 'akkoord') {
        assert.ok(q.acceptance.signature.startsWith('data:image/png;base64,') && q.acceptance.termsAccepted);
        assert.strictEqual((await inst.put(`/api/quotes/${q.id}`, { data: q.data })).status, 409, 'geaccordeerd = vast');
      }
      if (q.status === 'afgewezen') assert.ok(q.acceptance.reason);
    }
    assert.ok(list.length === 6);

    const wos = (await inst.get('/api/workorders')).body.items;
    assert.deepStrictEqual(wos.map((w) => w.status).sort(), ['bezig', 'gepland', 'gereed']);
    for (const w of wos) {
      const full = (await inst.get(`/api/workorders/${w.id}`)).body;
      assert.ok(full.assignee && full.plannedDate && full.data.zones.length > 0 && full.data.materials.length > 0);
      if (w.status === 'gereed') assert.strictEqual(full.progress.pct, 100);
      if (w.status === 'bezig') assert.ok(full.progress.pct > 0 && full.progress.pct < 100);
      // Afspraaklink met een reactie van de klant op het geplande moment.
      assert.match(full.share.url, /^https:\/\/app\.voorbeeld\.nl\/openbaar\/afspraak\.html#t=[A-Za-z0-9_-]{20,}$/);
      assert.strictEqual(full.appointment.response.current, true);
      const pub = await fetch(`${base}/api/public/appointment?preview=1`, { headers: { 'X-Afspraak-Token': full.share.url.split('#t=')[1] } });
      assert.strictEqual(pub.status, 200);
    }
    assert.deepStrictEqual(wos.map((w) => w.appointment.state).sort(), ['ander_moment', 'bevestigd', 'bevestigd']);

    const cat = (await inst.get('/api/catalog')).body;
    assert.ok(cat.configured && cat.syncedAt);
    assert.ok(Object.values(cat.articles).some((a) => a.via === 'mapping') && Object.values(cat.articles).some((a) => a.via === 'code'));
    assert.ok(cat.unmatched.length > 0, 'een paar artikelen staan niet in de nepwebshop');

    // Elke tabel met gegevens per tenant heeft testdata. Een nieuwe tabel?
    // Dan hoort die in testdata.js (of, als het echt geen testdata is, hier
    // in de uitzonderingen met de reden).
    const NO_TESTDATA = {
      sessions: 'ontstaan bij inloggen',
      audit: 'ontstaat vanzelf bij handelingen',
      settings: 'instellingen kiest de beheerder zelf (alleen de nepwebshop wordt gezet)',
      support_grants: 'meekijken is een handeling, geen data',
      impersonations: 'meekijken is een handeling, geen data',
      roles: 'rollen horen bij de organisatie (live-tenant); een testomgeving gebruikt die van live',
    };
    const tables = listTables(db).filter((n) => tableColumns(db, n).some((c) => c.name === 'tenant_id'));
    for (const n of tables) {
      if (NO_TESTDATA[n]) continue;
      const c = db.prepare(`SELECT COUNT(*) AS n FROM ${n} WHERE tenant_id = ?`).get(env.id).n;
      assert.ok(c > 0, `tabel ${n} heeft geen testdata: vul hem in testdata.js`);
    }
  } finally {
    server.close();
  }
});
