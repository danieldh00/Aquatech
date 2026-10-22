// Tekening indienen zonder inloggen en controle van plannen: een plan van een
// klant is nooit meteen definitief, een installateur keurt het goed; een
// offerte kan alleen uit een goedgekeurd plan.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeSubmission, PER_IP_HOUR } = require('../src/beregening/drawings');
const { createClient, listen } = require('./helpers/http-client');

const SECRET = 'd'.repeat(64);
const PW = 'Tuin-Plan-2026!';

const plan = (name = 'Tuin') => ({
  meta: { name }, settings: {}, elements: [], sprinklers: [], zones: [],
  areas: [{ id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }] }],
});
const submission = (extra = {}) => ({
  name: 'Mark Jansen', email: 'Jansen@Voorbeeld.test', phone: '06 1234 5678', address: 'Vierhouterweg 31, Vierhouten',
  question: 'Kan dit gecontroleerd worden?', consent: true, website: '', data: { ...plan('Mijn tuin'), serverId: 'x', calc: { big: true } }, ...extra,
});

async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant();
  await store.createAccount(main.id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW });
  await store.createAccount(main.id, { username: 'kees', displayName: 'Kees Installateur', role: 'installateur', password: PW });
  await store.createAccount(main.id, { username: 'klaas', displayName: 'Klaas Klant', role: 'klant', password: PW });
  const groen = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant;
  await store.createAccount(groen.id, { username: 'gerrit', displayName: 'Gerrit', role: 'installateur', password: PW });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  return { db, store, main, groen, server, base };
}

test('invoer van het indienformulier wordt gecontroleerd en opgeschoond', () => {
  assert.match(sanitizeSubmission(submission({ consent: false })).error, /toestemming/);
  assert.match(sanitizeSubmission(submission({ email: 'geen-mail' })).error, /e-mailadres/);
  assert.match(sanitizeSubmission(submission({ name: ' ' })).error, /naam/);
  assert.match(sanitizeSubmission(submission({ phone: '<script>' })).error, /telefoon/i);
  assert.match(sanitizeSubmission(submission({ data: { ...plan(), areas: [] } })).error, /vlak/);
  const ok = sanitizeSubmission(submission({ question: `a\u0000b${'x'.repeat(3000)}` })).value;
  assert.strictEqual(ok.email, 'jansen@voorbeeld.test');
  assert.strictEqual(ok.question.length, 2000);
  assert.ok(!ok.question.includes('\u0000'));
  assert.ok(!('serverId' in ok.data) && !('calc' in ok.data), 'interne velden van de planner gaan niet mee');
});

test('planner zonder inloggen: alleen met ?tekenen, de code wel, andere modules niet', async () => {
  const { server, base } = await setup();
  try {
    const anon = createClient(base);
    const page = await anon.get('/beregening/?tekenen');
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /id="review-bar"/);
    assert.match(page.text, /id="submit-form"/);
    assert.strictEqual((await anon.get('/beregening/')).status, 401, 'zonder ?tekenen de inlogpagina');
    for (const f of ['/beregening/js/app.js', '/beregening/css/app.css', '/shared/common.js', '/dashboard/modules.js']) assert.strictEqual((await anon.get(f)).status, 200, f);
    for (const f of ['/beheer/', '/beheer/beheer.js', '/plannen/plannen.js', '/beregening/../beheer/beheer.js']) assert.strictEqual((await anon.get(f)).status, 401, f);
    // Zonder account bewaart de planner niets op de server.
    assert.strictEqual((await anon.post('/api/plans', { data: plan() })).status, 401);
    // De inlogpagina heeft de knop.
    assert.match((await anon.get('/login')).text, /Direct een tekening maken/);
  } finally {
    server.close();
  }
});

test('tekening indienen zonder account: komt ter controle bij de juiste organisatie', async () => {
  const { db, store, main, groen, server, base } = await setup();
  try {
    const anon = createClient(base);
    assert.deepStrictEqual((await anon.get('/api/public/drawing')).body.enabled, true);
    assert.strictEqual((await anon.get('/api/public/drawing?org=bestaat-niet')).body.enabled, false);

    assert.strictEqual((await anon.post('/api/public/drawing', submission({ consent: false }))).status, 400);
    assert.strictEqual((await anon.post('/api/public/drawing', submission({ org: 'bestaat-niet' }))).status, 404);
    // Honeypot: lijkt gelukt, maar er komt niets binnen.
    const bot = await anon.post('/api/public/drawing', submission({ website: 'https://spam.example' }));
    assert.strictEqual(bot.status, 201);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 0);

    const out = await anon.post('/api/public/drawing', submission());
    assert.strictEqual(out.status, 201);
    assert.match(out.body.reference, /^[0-9A-F]{8}$/);
    const g = await anon.post('/api/public/drawing', submission({ org: 'groen', name: 'Piet Groen' }));
    assert.strictEqual(g.status, 201);

    // Gast met contactgegevens is eigenaar, plan staat ter controle; geen persoonsgegevens in het auditlog.
    const row = db.prepare(`SELECT p.review_status, p.review_question, p.submitted_via, p.customer, u.kind, u.email, u.phone
      FROM plans p JOIN users u ON u.id = p.owner_id WHERE p.tenant_id = ?`).get(main.id);
    assert.deepStrictEqual({ ...row }, { review_status: 'ter_controle', review_question: 'Kan dit gecontroleerd worden?', submitted_via: 'openbaar',
      customer: 'Mark Jansen', kind: 'gast', email: 'jansen@voorbeeld.test', phone: '06 1234 5678' });
    const audit = db.prepare("SELECT detail FROM audit WHERE action = 'tekening_ingediend'").all().map((a) => a.detail).join(' ');
    assert.ok(audit && !/jansen|Mark/i.test(audit));

    // De installateur ziet hem ter controle, met contactgegevens; de andere organisatie niet.
    const kees = createClient(base);
    await kees.login('kees', PW);
    const items = (await kees.get('/api/plans?all=1&review=ter_controle')).body.items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].owner.email, 'jansen@voorbeeld.test');
    assert.strictEqual(items[0].review.via, 'openbaar');
    const gerrit = createClient(base);
    await gerrit.login('gerrit', PW, 'groen');
    const theirs = (await gerrit.get('/api/plans?all=1')).body.items;
    assert.deepStrictEqual(theirs.map((p) => p.customer), ['Piet Groen']);
    assert.strictEqual((await gerrit.post(`/api/plans/${items[0].id}/review`, { action: 'approve' })).status, 404, 'andere tenant');
    assert.strictEqual((await gerrit.get(`/api/plans/${items[0].id}`)).status, 404);

    // Instelling uit: geen knop en geen indiening meer.
    const baas = createClient(base);
    await baas.login('baas', PW);
    assert.strictEqual((await baas.put('/api/admin/settings', { drawingRequests: false })).status, 200);
    assert.strictEqual((await anon.get('/api/public/drawing')).body.enabled, false);
    assert.strictEqual((await anon.post('/api/public/drawing', submission())).status, 404);
    // Uitgeschakelde organisatie ontvangt ook niets.
    store.updateTenant(groen.id, { disabled: true });
    assert.strictEqual((await anon.post('/api/public/drawing', submission({ org: 'groen' }))).status, 404);
  } finally {
    server.close();
  }
});

test('indienen is per IP-adres begrensd', async () => {
  const { server, base } = await setup();
  try {
    const anon = createClient(base);
    for (let i = 0; i < PER_IP_HOUR; i++) assert.strictEqual((await anon.post('/api/public/drawing', submission({ consent: false }))).status, 400);
    assert.strictEqual((await anon.post('/api/public/drawing', submission())).status, 429);
  } finally {
    server.close();
  }
});

test('controle: klant biedt aan, installateur keurt goed, pas dan een offerte', async () => {
  const { server, base } = await setup();
  try {
    const klaas = createClient(base);
    await klaas.login('klaas', PW);
    const created = await klaas.post('/api/plans', { data: plan('Voortuin Klaas') });
    assert.strictEqual(created.body.reviewStatus, 'concept');
    const id = created.body.id;
    // Een klant mag niet goedkeuren.
    assert.strictEqual((await klaas.post(`/api/plans/${id}/review`, { action: 'approve' })).status, 403);
    const req = await klaas.post(`/api/plans/${id}/review-request`, { question: 'Klopt dit?' });
    assert.strictEqual(req.status, 200);
    assert.deepStrictEqual([req.body.review.status, req.body.review.question, req.body.review.via], ['ter_controle', 'Klopt dit?', 'account']);

    const kees = createClient(base);
    await kees.login('kees', PW);
    const quote = (planId) => kees.post('/api/quotes', { data: { title: 'Offerte', planId, customer: { name: 'Klaas' }, lines: [] } });
    const blocked = await quote(id);
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.body.error, 'plan_not_approved');
    assert.strictEqual((await kees.post(`/api/plans/${id}/review`, { action: 'nee' })).status, 400);
    const ok = await kees.post(`/api/plans/${id}/review`, { action: 'approve' });
    assert.deepStrictEqual([ok.body.review.status, ok.body.review.reviewedBy], ['goedgekeurd', 'Kees Installateur']);
    assert.strictEqual((await quote(id)).status, 201);
    assert.strictEqual((await klaas.get(`/api/plans/${id}`)).body.review.status, 'goedgekeurd');

    // Past de klant daarna iets aan, dan gaat het plan opnieuw ter controle.
    const edit = await klaas.put(`/api/plans/${id}`, { data: plan('Voortuin Klaas, met haag') });
    assert.strictEqual(edit.body.reviewStatus, 'ter_controle');
    assert.strictEqual((await kees.get(`/api/plans/${id}`)).body.review.status, 'ter_controle');

    // Een installateur keurt zijn eigen plan in één keer goed; wijzigen houdt het goedgekeurd.
    const own = (await kees.post('/api/plans', { data: plan('Tuin van Kees') })).body.id;
    assert.strictEqual((await kees.post(`/api/plans/${own}/review`, { action: 'approve' })).body.review.status, 'goedgekeurd');
    assert.strictEqual((await kees.put(`/api/plans/${own}`, { data: plan('Tuin van Kees 2') })).body.reviewStatus, 'goedgekeurd');
    assert.strictEqual((await kees.post(`/api/plans/${own}/review`, { action: 'reopen' })).body.review.status, 'concept');

    // Een plan van een ander kan de klant niet aanbieden.
    assert.strictEqual((await klaas.post(`/api/plans/${own}/review-request`, { question: 'x' })).status, 404);
    // Zonder plan (losse offerte) blijft een offerte gewoon mogelijk.
    assert.strictEqual((await quote(undefined)).status, 201);
  } finally {
    server.close();
  }
});

test('leren van een goedgekeurd plan: recht plannen.goedkeuren, eigen tenant, alleen goedgekeurd', async () => {
  const { server, base, db, main } = await setup();
  try {
    const samples = { v: 1, bins: { 10: [0, 100, 0, 0, 0, 0] } };
    const klaas = createClient(base);
    await klaas.login('klaas', PW);
    const id = (await klaas.post('/api/plans', { data: plan('Tuin Klaas') })).body.id;
    const kees = createClient(base);
    await kees.login('kees', PW);
    // nog niet goedgekeurd
    assert.strictEqual((await kees.post('/api/plan/learn', { planId: id, samples })).status, 404);
    await kees.post(`/api/plans/${id}/review`, { action: 'approve' });
    // klant mist het recht
    assert.strictEqual((await klaas.post('/api/plan/learn', { planId: id, samples })).status, 403);
    // andere organisatie
    const gerrit = createClient(base);
    await gerrit.login('gerrit', PW, 'groen');
    assert.strictEqual((await gerrit.post('/api/plan/learn', { planId: id, samples })).status, 404);
    assert.strictEqual((await kees.post('/api/plan/learn', { planId: id, samples })).status, 200);
    // opnieuw goedkeuren vervangt, telt dubbel (door een mens gecontroleerd)
    assert.strictEqual((await kees.post('/api/plan/learn', { planId: id, samples })).status, 200);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM plan_recognitions WHERE tenant_id = ?').get(main.id).n, 1);
    const learned = (await kees.get('/api/plan/learned')).body;
    assert.deepStrictEqual([learned.examples, learned.bins['10'][1]], [1, 200]);
    assert.strictEqual((await gerrit.get('/api/plan/learned')).body.examples, 0, 'andere organisatie leert niet mee');
  } finally {
    server.close();
  }
});
