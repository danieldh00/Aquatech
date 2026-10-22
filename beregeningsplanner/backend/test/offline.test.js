// Offline werken (installeerbare app): regels van de wachtrij
// (frontend/shared/offline-core.js), openbare bestanden van de app,
// Idempotency-Key tegen dubbele verzoeken en de conflictcontrole bij werkorders.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createIdempotency } = require('../src/beveiliging/idempotency');
const { sitePhotoPng } = require('../src/platform/test-data');
const Core = require('../../frontend/shared/offline-core.js');
const { createClient } = require('./helpers/http-client');

const FRONT = path.join(__dirname, '..', '..', 'frontend');
const SECRET = 'o'.repeat(64);
const pw = 'Tuin-Plan-2026!';
const H = Core.HEADERS;

// ---------- Regels (zonder browser) ----------

test('offline-core: alleen werkordergegevens komen in de cache', () => {
  for (const ok of ['api/me', 'api/config', 'api/my-day', 'api/my-day?date=2026-10-21&all=1', 'api/workorders', 'api/workorders/abc-123',
    'api/workorders/abc-123/photos', 'api/workorders/abc-123/worklog', 'api/workorders/abc/photos/def?thumb=1', 'api/workorder-staff', 'api/quote-profile']) {
    assert.ok(Core.cacheable(ok), ok);
  }
  for (const no of ['api/quotes', 'api/quotes/1', 'api/admin/users', 'api/portal', 'api/workorders/abc/photos/def', 'api/plans', 'api/workorders?quote=1',
    'api/workorders/../admin/users', 'api/dossiers', 'api/platform/tenants', 'api/me/x']) {
    assert.ok(!Core.cacheable(no), no);
  }
});

test('offline-core: offline werken alleen voor een eigen account met werkorders, niet tijdens impersonatie', () => {
  const me = (over = {}) => ({ user: { id: 'u1', kind: 'account', tenantId: 't1' }, tenant: { id: 't2' }, rights: ['werkorders'], ...over });
  assert.strictEqual(Core.ownerOf(me()), 'u1@t2', 'actieve omgeving telt mee');
  assert.ok(Core.offlineAllowed(me()));
  assert.ok(!Core.offlineAllowed(me({ rights: ['portaal'] })), 'klant');
  assert.ok(!Core.offlineAllowed(me({ impersonation: { by: 'X' } })), 'impersonatie');
  assert.ok(!Core.offlineAllowed(me({ user: { id: 'g', kind: 'gast' } })), 'gast');
  assert.strictEqual(Core.ownerOf({ user: null }), null);
  assert.ok(!Core.offlineAllowed(null));
});

test('offline-core: antwoorden uit de wachtrij beoordelen', () => {
  assert.strictEqual(Core.classify(200, {}), 'done');
  assert.strictEqual(Core.classify(201, {}), 'done');
  for (const s of [502, 503, 504, 522, 429]) assert.strictEqual(Core.classify(s, {}), 'retry', String(s));
  assert.strictEqual(Core.classify(409, { error: 'in_progress' }), 'retry');
  assert.strictEqual(Core.classify(401, {}), 'auth');
  assert.strictEqual(Core.classify(403, { error: 'password_change_required' }), 'auth');
  assert.strictEqual(Core.classify(409, { error: 'conflict' }), 'conflict');
  for (const s of [400, 403, 404, 413, 500]) assert.strictEqual(Core.classify(s, {}), 'failed', String(s));
});

test('offline-core: wijzigingen met dezelfde sleutel samenvoegen, oudste basis blijft', () => {
  const older = { id: 'a', seq: 1, createdAt: 1, key: 'wo:1', headers: { [H.ifBase]: 'T0' }, body: JSON.stringify({ data: { x: 1 }, status: 'bezig' }), baseDoc: { v: 0 }, state: 'pending' };
  const newer = { id: 'b', seq: 2, createdAt: 2, key: 'wo:1', headers: { [H.ifBase]: 'T5', 'content-type': 'application/json' }, body: JSON.stringify({ data: { x: 2 } }), state: 'pending' };
  const m = Core.merge(older, newer);
  assert.strictEqual(m.id, 'a');
  assert.strictEqual(m.seq, 1, 'plek in de wachtrij blijft');
  assert.strictEqual(m.headers[H.ifBase], 'T0');
  assert.deepStrictEqual(JSON.parse(m.body), { data: { x: 2 }, status: 'bezig' }, 'per veld, nieuw wint');
  assert.deepStrictEqual(m.baseDoc, { v: 0 });

  // Na versturen bouwen latere wijzigingen voort op het antwoord.
  const later = { id: 'c', key: 'wo:1', headers: { [H.ifBase]: 'T0' }, baseDoc: { v: 0 } };
  const other = { id: 'd', key: 'wo:2', headers: { [H.ifBase]: 'T0' } };
  const changed = Core.rebase([m, later, other], m, { updatedAt: 'T9', v: 9 });
  assert.deepStrictEqual(changed.map((x) => x.id), ['c']);
  assert.strictEqual(later.headers[H.ifBase], 'T9');
  assert.deepStrictEqual(later.baseDoc, { updatedAt: 'T9', v: 9 });
  assert.strictEqual(other.headers[H.ifBase], 'T0');

  assert.deepStrictEqual(Core.applyPatch({ id: 'w', status: 'open', data: { a: 1 } }, JSON.stringify({ data: { a: 2 }, status: 'bezig' })), { id: 'w', status: 'bezig', data: { a: 2 } });
  assert.deepStrictEqual(Core.keepHeaders((k) => ({ 'content-type': 'application/json', [H.base]: 'T1', cookie: 'geheim' })[k]), { 'content-type': 'application/json', [H.ifBase]: 'T1' }, 'geen cookies of andere koppen bewaren');
});

test('offline-core: drieweg samenvoegen per veld en per werkstap', () => {
  const base = { status: 'gepland', data: { siteNotes: '', instructions: '', steps: [{ id: 's1', done: false, title: 'A' }, { id: 's2', done: false, title: 'B' }], materials: [{ id: 'm1', picked: false }] } };
  const mine = { status: 'bezig', data: { siteNotes: 'Hond', instructions: '', steps: [{ id: 's1', done: true, title: 'A' }, { id: 's2', done: false, title: 'B' }, { id: 's3', done: false, title: 'Extra' }], materials: [{ id: 'm1', picked: true }] } };
  const theirs = { status: 'gepland', updatedAt: 'T2', data: { siteNotes: '', instructions: 'Eerst bellen', steps: [{ id: 's1', done: false, title: 'A' }, { id: 's2', done: true, title: 'B' }], materials: [] } };
  const out = Core.rebaseBody(JSON.stringify(mine), base, theirs);
  const v = JSON.parse(out.body);
  assert.strictEqual(v.status, 'bezig');
  assert.strictEqual(v.data.siteNotes, 'Hond');
  assert.strictEqual(v.data.instructions, 'Eerst bellen', 'wijziging van kantoor blijft');
  assert.deepStrictEqual(v.data.steps.map((s) => [s.id, s.done]), [['s1', true], ['s2', true], ['s3', false]]);
  // Kantoor haalde materiaal m1 weg, ik vinkte het af: dat is een echte botsing.
  assert.deepStrictEqual(out.conflicts, ['data.materials[m1]']);
  assert.deepStrictEqual(Core.fieldNames(out.conflicts), ['materialen']);

  const both = Core.rebaseBody(JSON.stringify({ data: { siteNotes: 'Hond' } }), { data: { siteNotes: '' } }, { data: { siteNotes: 'Kat' } });
  assert.deepStrictEqual(both.conflicts, ['data.siteNotes']);
  const sameChange = Core.rebaseBody(JSON.stringify({ data: { siteNotes: 'Hond' } }), { data: { siteNotes: '' } }, { data: { siteNotes: 'Hond' } });
  assert.deepStrictEqual(sameChange.conflicts, []);
  assert.strictEqual(Core.rebaseBody('geen json', {}, {}), null);
});

// ---------- Openbare bestanden en pagina's ----------

async function setup() {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: pw });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: pw });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: pw });
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, org = '') => {
    const c = createClient(base);
    assert.strictEqual((await c.post('/api/auth/login', { username, password: pw, organization: org })).status, 200);
    return c;
  };
  return { db, store, server, base, as };
}

const lines = [{ id: 'a', section: 'materiaal', description: 'Sproeier', qty: 4, unit: 'st', price: 10 }, { id: 'b', section: 'arbeid', description: 'Sproeiers plaatsen', qty: 2, unit: 'uur', price: 50 }];
async function workOrder(c) {
  const q = (await c.post('/api/quotes', { data: { title: 'Aanleg', customer: { name: 'Fam. Jansen' }, lines } })).body;
  await c.put(`/api/quotes/${q.id}`, { status: 'akkoord' });
  return (await c.post('/api/workorders', { quoteId: q.id })).body;
}

test('app: manifest, service worker en iconen zonder inloggen, zonder gegevens', async () => {
  const { server, base } = await setup();
  try {
    const anon = createClient(base);
    const man = await anon.get('/manifest.json');
    assert.strictEqual(man.status, 200);
    assert.strictEqual(man.body.start_url, './', 'relatief (padprefix achter een proxy)');
    assert.strictEqual(man.body.scope, './');
    assert.strictEqual(man.body.display, 'standalone');
    for (const icon of man.body.icons) {
      assert.ok(!icon.src.startsWith('/'), icon.src);
      const r = await fetch(`${base}/${icon.src}`);
      assert.strictEqual(r.status, 200, icon.src);
      assert.match(r.headers.get('content-type'), /image\/png/);
    }
    assert.ok(man.body.icons.some((i) => i.purpose === 'maskable'));
    const sw = await anon.get('/sw.js');
    assert.strictEqual(sw.status, 200);
    assert.match(sw.headers.get('content-type'), /javascript/);
    assert.match(sw.headers.get('cache-control'), /no-cache/, 'nieuwe versie altijd ophalen');
    assert.match(sw.text, /importScripts\(`shared\/offline-core\.js/);
    assert.strictEqual((await anon.get('/shared/offline-core.js')).status, 200);
    assert.strictEqual((await anon.get('/shared/icons/apple-touch-icon.png')).status, 200);
    // Andere bestanden blijven achter de login.
    assert.strictEqual((await anon.get('/shared/offline.js')).status, 401);
    assert.strictEqual((await anon.get('/werkorders/werkorders.js')).status, 401);
    assert.strictEqual((await anon.get('/shared/icons/../roles.js')).status, 401);
  } finally {
    server.close();
  }
});

test('app: pagina\'s laden de offline-onderdelen, common.js registreert de service worker', () => {
  const common = fs.readFileSync(path.join(FRONT, 'shared', 'common.js'), 'utf8');
  assert.match(common, /serviceWorker\.register\(fromApp\(`sw\.js\$\{version\}`\)\)/);
  assert.match(common, /rel: 'manifest'/);
  for (const page of ['index.html', 'werkorders/index.html']) {
    const html = fs.readFileSync(path.join(FRONT, page), 'utf8');
    const core = html.indexOf('shared/offline-core.js');
    const off = html.indexOf('shared/offline.js');
    assert.ok(core > 0 && off > core, `${page}: offline-core.js en daarna offline.js`);
    assert.ok(html.includes('shared/offline.css'), page);
  }
  // De service worker gebruikt alleen relatieve adressen binnen de app.
  const sw = fs.readFileSync(path.join(FRONT, 'sw.js'), 'utf8');
  assert.ok(!/fetch\(['"`]\//.test(sw), 'geen absolute paden');
  assert.match(sw, /caches\.delete\(DATA\)/, 'gegevens worden gewist');
});

// ---------- Idempotency-Key ----------

test('Idempotency-Key: herhaalde foto-upload wordt niet dubbel opgeslagen, per gebruiker', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees'), baas = await as('baas');
    const wo = await workOrder(kees);
    const photo = { image: sitePhotoPng('voor', 1).toString('base64'), kind: 'voor' };
    const key = { 'Idempotency-Key': 'f0e1d2c3-b4a5-4697-8899-aabbccddeeff' };
    const a = await kees.post(`/api/workorders/${wo.id}/photos`, photo, key);
    assert.strictEqual(a.status, 201);
    const b = await kees.post(`/api/workorders/${wo.id}/photos`, photo, key);
    assert.strictEqual(b.status, 201);
    assert.strictEqual(b.body.id, a.body.id, 'zelfde antwoord');
    assert.strictEqual(b.headers.get('idempotent-replayed'), 'true');
    // Dezelfde sleutel van een andere gebruiker is een ander verzoek.
    const c = await baas.post(`/api/workorders/${wo.id}/photos`, photo, key);
    assert.notStrictEqual(c.body.id, a.body.id);
    // Zonder sleutel gewoon opnieuw.
    await kees.post(`/api/workorders/${wo.id}/photos`, photo);
    assert.strictEqual((await kees.get(`/api/workorders/${wo.id}/photos`)).body.items.length, 3);
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/photos`, photo, { 'Idempotency-Key': 'te kort' })).status, 400);
    // Een geweigerd verzoek wordt niet onthouden.
    const bad = { 'Idempotency-Key': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/photos`, { image: 'eA==' }, bad)).status, 400);
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/photos`, photo, bad)).status, 201);
  } finally {
    server.close();
  }
});

test('Idempotency-Key: begrensd in aantal en tijd, lopend verzoek geeft in_progress', async () => {
  let t = 0;
  const idem = createIdempotency({ ttlMs: 1000, maxEntries: 2, now: () => t });
  const mw = idem.middleware(() => 'u1@t1');
  const run = (key, finish = true) => new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200, headers, ended: null, handlers: {},
      setHeader(k, v) { headers[k] = v; }, status(s) { this.statusCode = s; return this; }, type() { return this; },
      send(b) { this.ended = b; resolve({ replay: true, res: this }); return this; },
      json(b) { this.ended = b; resolve({ replay: false, res: this }); return this; },
      on(ev, fn) { this.handlers[ev] = fn; },
    };
    const req = { method: 'POST', baseUrl: '/api', path: '/x', get: (k) => (k === 'Idempotency-Key' ? key : undefined) };
    mw(req, res, () => {
      if (finish) { res.status(201).json({ n: Math.random() }); res.handlers.finish(); } else resolve({ next: true, res });
    });
  });
  const first = await run('k1-aaaaaaaa');
  const again = await run('k1-aaaaaaaa');
  assert.ok(again.replay);
  assert.strictEqual(again.res.ended, JSON.stringify(first.res.ended));
  await run('k2-aaaaaaaa');
  await run('k3-aaaaaaaa');
  assert.ok(idem.size() <= 2, 'oudste valt weg');
  t = 5000;
  assert.ok(!(await run('k3-aaaaaaaa')).replay, 'verlopen');
  const open = await run('k4-aaaaaaaa', false);
  assert.ok(open.next);
  const dup = await run('k4-aaaaaaaa');
  assert.strictEqual(dup.res.statusCode, 409);
  assert.match(dup.res.ended && JSON.stringify(dup.res.ended), /in_progress/);
});

// ---------- Conflictcontrole ----------

test('werkorder: offline wijziging op een oude basis geeft 409 conflict, met de juiste basis of zonder controle gaat het door', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees'), baas = await as('baas'), klaas = await as('klaas');
    const wo = await workOrder(kees);
    const base = wo.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const office = await baas.put(`/api/workorders/${wo.id}`, { data: { ...wo.data, instructions: 'Kantoor' } });
    assert.strictEqual(office.status, 200);
    assert.notStrictEqual(office.body.updatedAt, base);

    const stale = await kees.put(`/api/workorders/${wo.id}`, { data: { ...wo.data, siteNotes: 'Hond' } }, { [H.ifBase]: base });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.error, 'conflict');
    assert.strictEqual(stale.body.updatedAt, office.body.updatedAt);
    assert.strictEqual((await kees.get(`/api/workorders/${wo.id}`)).body.data.instructions, 'Kantoor', 'niets overschreven');

    const fresh = await kees.put(`/api/workorders/${wo.id}`, { data: { ...office.body.data, siteNotes: 'Hond' } }, { [H.ifBase]: office.body.updatedAt });
    assert.strictEqual(fresh.status, 200);
    assert.strictEqual(fresh.body.data.siteNotes, 'Hond');
    // Zonder kop (gewoon online opslaan) blijft het zoals het was.
    assert.strictEqual((await kees.put(`/api/workorders/${wo.id}`, { data: fresh.body.data }, { [H.base]: 'oud' })).status, 200);
    // Rechten en tenant blijven gelden.
    assert.strictEqual((await klaas.put(`/api/workorders/${wo.id}`, { data: fresh.body.data }, { [H.ifBase]: 'x' })).status, 403);
    assert.strictEqual((await kees.put('/api/workorders/bestaat-niet', { data: fresh.body.data }, { [H.ifBase]: 'x' })).status, 404);
  } finally {
    server.close();
  }
});
