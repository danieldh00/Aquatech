// Nieuws: berichten van de organisatie en wat is nieuw (versielogboek).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');
const { sanitizeNews, unreadCount, Releases } = require('../src/news');

const SECRET = 'n'.repeat(64);
const PW = 'Tuin-Plan-2026!';

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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

async function setup(opts = {}) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW, email: 'baas@voorbeeld.nl' }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW });
  for (const [u, email] of [['kees', 'kees@voorbeeld.nl'], ['klaas', 'klaas@voorbeeld.nl']]) {
    const row = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
    store.updateProfile(row.id, { email });
  }
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db, ...opts }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, org) => {
    const c = client(base);
    const r = await c.post('/api/auth/login', { username, password: PW, tenant: org });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return c;
  };
  return { db, store, server, base, as, main };
}

test('nieuws: invoer opschonen', () => {
  assert.ok(sanitizeNews({ title: '', body: 'x' }).error);
  assert.ok(sanitizeNews({ title: 'x', body: '' }).error);
  assert.ok(sanitizeNews({ title: 'x'.repeat(121), body: 'x' }).error);
  const ok = sanitizeNews({ title: '  Hallo   team ', body: 'a\r\n\r\n\r\n\r\nb\u0007', audience: 'hackers', pinned: 'ja' }).value;
  assert.deepStrictEqual(ok, { title: 'Hallo team', body: 'a\n\nb', audience: 'medewerkers', pinned: false });
});

test('wat is nieuw: huidige versie staat erin, nieuwste bovenaan, punten per recht', () => {
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  assert.strictEqual(Releases.latest, version, 'zet de nieuwe versie bovenaan in frontend/nieuws/releases.js');
  for (let i = 1; i < Releases.RELEASES.length; i++) assert.ok(Releases.compare(Releases.RELEASES[i - 1].version, Releases.RELEASES[i].version) > 0);
  const changelog = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
  for (const r of Releases.RELEASES) {
    assert.match(r.date, /^\d{4}-\d\d-\d\d$/);
    assert.ok(changelog.includes(`## ${r.version}\n`), `versie ${r.version} staat niet in CHANGELOG.md`);
  }
  const klant = Releases.visibleFor(['plannen', 'offertes.klant', 'portaal']);
  const text = JSON.stringify(klant);
  assert.ok(!/Beheer → Rollen|Uitbesteden|Planner/.test(text), 'een klant ziet geen nieuws over beheer of planning');
  assert.ok(klant.some((r) => r.version === '0.37.0'), 'wel over zijn portaal');
  assert.ok(Releases.visibleFor(['beheer']).some((r) => r.version === '0.49.0'));
  assert.strictEqual(Releases.compare('0.10.0', '0.9.9') > 0, true);
});

test('nieuw sinds het vorige bezoek: telling', () => {
  const user = { id: 'u1', created_at: '2026-01-01T00:00:00.000Z' };
  const marks = [
    { created_at: '2026-03-02T00:00:00.000Z', audience: 'medewerkers', author_id: 'u2' },
    { created_at: '2026-03-01T00:00:00.000Z', audience: 'iedereen', author_id: 'u2' },
    { created_at: '2026-02-01T00:00:00.000Z', audience: 'iedereen', author_id: 'u1' },
  ];
  const latest = Releases.latest;
  const seenAll = { newsSeenAt: '2026-02-15T00:00:00.000Z', seenRelease: latest };
  assert.strictEqual(unreadCount({ marks, prefs: seenAll, user, rights: ['werkorders'], customer: false }), 2);
  assert.strictEqual(unreadCount({ marks, prefs: seenAll, user, rights: ['portaal'], customer: true }), 1, 'klant: alleen berichten voor iedereen');
  // Eigen berichten tellen niet; zonder vorig bezoek alleen de laatste versie.
  assert.strictEqual(unreadCount({ marks, prefs: { newsSeenAt: '', seenRelease: '' }, user, rights: [], customer: false }), 3);
  const since48 = Releases.visibleFor(['beheer']).filter((r) => Releases.compare(r.version, '0.48.0') > 0).length;
  assert.ok(since48 >= 2);
  assert.strictEqual(unreadCount({ marks: [], prefs: { newsSeenAt: '', seenRelease: '0.48.0' }, user, rights: ['beheer'], customer: false }), since48);
});

test('nieuws: beheerder plaatst, collega en klant lezen, melding en gezien', async () => {
  const sent = [];
  const mailerFor = () => ({ configured: () => true, send: async (m) => { sent.push(m); } });
  const { server, as, db } = await setup({ mailerFor });
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const klaas = await as('klaas');
    // Account van voor deze versie: krijgt één melding voor de laatste versie.
    assert.strictEqual((await kees.get('/api/me')).body.news, 1);

    const intern = await baas.post('/api/news', { title: 'Teamoverleg', body: 'Vrijdag 8:00 in de werkplaats.\nhttps://voorbeeld.nl/agenda', mail: true });
    assert.strictEqual(intern.status, 201, JSON.stringify(intern.body));
    assert.strictEqual(intern.body.mailed.sent, 1, 'alleen collega\'s met een e-mailadres, niet de afzender of klanten');
    assert.deepStrictEqual(sent.map((m) => m.to), ['kees@voorbeeld.nl']);
    assert.match(sent[0].subject, /Nieuws: Teamoverleg/);
    const open = await baas.post('/api/news', { title: 'Zomerstop', body: 'Van 1 tot 14 augustus zijn we dicht.', audience: 'iedereen', pinned: true });
    assert.strictEqual(open.status, 201);

    // Kees ziet beide berichten (vastgezet eerst), Klaas alleen het openbare.
    const kn = (await kees.get('/api/news')).body;
    assert.deepStrictEqual(kn.items.map((i) => i.title), ['Zomerstop', 'Teamoverleg']);
    assert.strictEqual(kn.canPost, false);
    assert.ok(kn.releases.length > 0);
    const cn = (await klaas.get('/api/news')).body;
    assert.deepStrictEqual(cn.items.map((i) => i.title), ['Zomerstop']);
    assert.ok(!JSON.stringify(cn.releases).includes('Uitbesteden'));

    // Melding: Kees 2 berichten + laatste versie, Klaas 1 bericht + versie, Baas geen eigen berichten.
    assert.strictEqual((await kees.get('/api/me')).body.news, 3);
    assert.strictEqual((await klaas.get('/api/me')).body.news, 2);
    assert.strictEqual((await baas.get('/api/me')).body.news, 1);

    // Pagina bekeken: alles gezien, zonder auditregel.
    assert.strictEqual((await kees.post('/api/news/seen', {})).status, 200);
    assert.strictEqual((await kees.get('/api/me')).body.news, 0);
    const prefs = (await kees.get('/api/me')).body.preferences;
    assert.strictEqual(prefs.seenRelease, Releases.latest);
    assert.ok(prefs.newsSeenAt);
    // Het profielformulier laat de stand van Nieuws staan.
    await kees.put('/api/account/profile', { preferences: { startPage: 'planning', mailCopy: false } });
    assert.strictEqual((await kees.get('/api/me')).body.preferences.seenRelease, Releases.latest);

    // Bewerken, vastzetten en verwijderen.
    const id = intern.body.item.id;
    const upd = await baas.put(`/api/news/${id}`, { pinned: true, title: 'Teamoverleg (verzet)' });
    assert.strictEqual(upd.status, 200);
    assert.strictEqual(upd.body.item.pinned, true);
    assert.strictEqual(upd.body.item.body, intern.body.item.body);
    assert.strictEqual((await baas.put(`/api/news/${id}`, { title: '' })).status, 400);
    assert.strictEqual((await baas.del(`/api/news/${open.body.item.id}`)).status, 200);
    assert.strictEqual((await baas.del(`/api/news/${open.body.item.id}`)).status, 404);

    // Auditlog zonder de inhoud van het bericht.
    const audit = db.prepare("SELECT action, detail FROM audit WHERE action LIKE 'nieuws_%'").all();
    assert.deepStrictEqual(audit.map((a) => a.action).sort(), ['nieuws_geplaatst', 'nieuws_geplaatst', 'nieuws_gewijzigd', 'nieuws_verwijderd']);
    assert.ok(!audit.some((a) => /werkplaats|augustus/.test(a.detail)));

  } finally {
    server.close();
  }
});

test('nieuws: rechten en tenantscheiding', async () => {
  const { server, as, base } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const klaas = await as('klaas');
    // Zonder inloggen niets.
    assert.strictEqual((await client(base).get('/api/news')).status, 401);
    // Zonder het recht nieuws geen plaatsen, wijzigen of verwijderen.
    assert.strictEqual((await kees.post('/api/news', { title: 'x', body: 'y' })).status, 403);
    assert.strictEqual((await klaas.post('/api/news', { title: 'x', body: 'y' })).status, 403);
    const item = (await baas.post('/api/news', { title: 'Intern', body: 'Alleen voor ons.' })).body.item;
    assert.strictEqual((await kees.put(`/api/news/${item.id}`, { title: 'z' })).status, 403);
    assert.strictEqual((await kees.del(`/api/news/${item.id}`)).status, 403);

    // Een andere organisatie ziet en wijzigt het bericht niet.
    const made = await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const piet = await as('piet', 'groen');
    assert.deepStrictEqual((await piet.get('/api/news')).body.items, []);
    assert.strictEqual((await piet.put(`/api/news/${item.id}`, { title: 'gekaapt' })).status, 404);
    assert.strictEqual((await piet.del(`/api/news/${item.id}`)).status, 404);
    assert.strictEqual((await piet.get('/api/me')).body.news <= 1, true);

    // De pagina zelf.
    const page = await kees.get('/nieuws/');
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /nieuws\.js/);
  } finally {
    server.close();
  }
});
