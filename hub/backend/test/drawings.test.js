// Tekening indienen zonder inloggen en controle van plannen: een plan van een
// klant is nooit meteen definitief, een installateur keurt het goed; een
// offerte kan alleen uit een goedgekeurd plan.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeSubmission, PER_IP_HOUR, RETENTION_DAYS } = require('../src/beregening/drawings');
const { createSettings } = require('../src/platform/settings');
const { createClient, listen } = require('./helpers/http-client');

const SECRET = 'd'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Maakt een plan met één gazon.
 * @param {string} [name] Naam van het plan.
 * @returns {object} De plangegevens.
 */
const plan = (name = 'Tuin') => ({
  meta: { name }, settings: {}, elements: [], sprinklers: [], zones: [],
  areas: [{ id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }] }],
});
/**
 * Een ingediende tekening zoals het formulier hem verstuurt.
 * @param {object} [extra] Velden die de standaard overschrijven.
 * @returns {object} De body voor POST /api/public/drawing.
 */
const submission = (extra = {}) => ({
  name: 'Mark Jansen', email: 'Jansen@Voorbeeld.test', phone: '06 1234 5678', address: 'Vierhouterweg 31, Vierhouten',
  question: 'Kan dit gecontroleerd worden?', consent: true, website: '', data: { ...plan('Mijn tuin'), serverId: 'x', calc: { big: true } }, ...extra,
});

/**
 * Hoofdtenant met beheerder, installateur en klant, organisatie Groen met een installateur, plus een testserver.
 * @param {object} [vault] Eigen kluis voor de app (standaard een nieuwe).
 * @returns {Promise<object>} db, store, main, groen, server en base.
 */
async function setup(vault) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant();
  await store.createAccount(main.id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW });
  await store.createAccount(main.id, { username: 'kees', displayName: 'Kees Installateur', role: 'installateur', password: PW });
  await store.createAccount(main.id, { username: 'klaas', displayName: 'Klaas Klant', role: 'klant', password: PW });
  const groen = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant;
  await store.createAccount(groen.id, { username: 'gerrit', displayName: 'Gerrit', role: 'installateur', password: PW });
  // Tekening indienen staat standaard uit (T-03); hier aan voor beide organisaties.
  for (const tenantId of [main.id, groen.id]) createSettings({ db, tenantId }).update({ drawingRequests: true });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, ...(vault ? { vault } : {}) }));
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
    const page = await anon.get('/app/beregening/?tekenen');
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /id="review-bar"/);
    assert.match(page.text, /id="submit-form"/);
    assert.strictEqual((await anon.get('/app/beregening/')).status, 401, 'zonder ?tekenen de inlogpagina');
    for (const file of ['/app/beregening/js/app.js', '/app/beregening/css/app.css', '/app/shared/common.js', '/app/dashboard/modules.js']) assert.strictEqual((await anon.get(file)).status, 200, file);
    for (const file of ['/app/beheer/', '/app/beheer/beheer.js', '/app/plannen/plannen.js', '/app/beregening/../beheer/beheer.js']) assert.strictEqual((await anon.get(file)).status, 401, file);
    // Zonder account bewaart de planner niets op de server.
    assert.strictEqual((await anon.post('/app/api/plans', { data: plan() })).status, 401);
    // De inlogpagina heeft de knop.
    assert.match((await anon.get('/app/login')).text, /Direct een tekening maken/);
  } finally {
    server.close();
  }
});

test('tekening indienen zonder account: komt ter controle bij de juiste organisatie', async () => {
  const { db, store, main, groen, server, base } = await setup();
  try {
    const anon = createClient(base);
    assert.deepStrictEqual((await anon.get('/app/api/public/drawing')).body.enabled, true);
    assert.strictEqual((await anon.get('/app/api/public/drawing?org=bestaat-niet')).body.enabled, false);

    assert.strictEqual((await anon.post('/app/api/public/drawing', submission({ consent: false }))).status, 400);
    assert.strictEqual((await anon.post('/app/api/public/drawing', submission({ org: 'bestaat-niet' }))).status, 404);
    // Honeypot: lijkt gelukt, maar er komt niets binnen.
    const bot = await anon.post('/app/api/public/drawing', submission({ website: 'https://spam.example' }));
    assert.strictEqual(bot.status, 201);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 0);

    const out = await anon.post('/app/api/public/drawing', submission());
    assert.strictEqual(out.status, 201);
    assert.match(out.body.reference, /^[0-9A-F]{8}$/);
    const groenSubmission = await anon.post('/app/api/public/drawing', submission({ org: 'groen', name: 'Piet Groen' }));
    assert.strictEqual(groenSubmission.status, 201);

    // Gast met contactgegevens is eigenaar, plan staat ter controle; geen persoonsgegevens in het auditlog.
    const row = db.prepare(`SELECT p.review_status, p.review_question, p.submitted_via, p.customer, u.kind, u.email, u.phone
      FROM plans p JOIN users u ON u.id = p.owner_id WHERE p.tenant_id = ?`).get(main.id);
    assert.deepStrictEqual({ ...row }, { review_status: 'ter_controle', review_question: 'Kan dit gecontroleerd worden?', submitted_via: 'openbaar',
      customer: 'Mark Jansen', kind: 'gast', email: 'jansen@voorbeeld.test', phone: '06 1234 5678' });
    const audit = db.prepare("SELECT detail FROM audit WHERE action = 'tekening_ingediend'").all().map((row) => row.detail).join(' ');
    assert.ok(audit && !/jansen|Mark/i.test(audit));

    // De installateur ziet hem ter controle, met contactgegevens; de andere organisatie niet.
    const kees = createClient(base);
    await kees.login('kees', PW);
    const items = (await kees.get('/app/api/plans?all=1&review=ter_controle')).body.items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].owner.email, 'jansen@voorbeeld.test');
    assert.strictEqual(items[0].review.via, 'openbaar');
    const gerrit = createClient(base);
    await gerrit.login('gerrit', PW, 'groen');
    const theirs = (await gerrit.get('/app/api/plans?all=1')).body.items;
    assert.deepStrictEqual(theirs.map((plan) => plan.customer), ['Piet Groen']);
    assert.strictEqual((await gerrit.post(`/app/api/plans/${items[0].id}/review`, { action: 'approve' })).status, 404, 'andere tenant');
    assert.strictEqual((await gerrit.get(`/app/api/plans/${items[0].id}`)).status, 404);

    // Instelling uit: geen knop en geen indiening meer.
    const baas = createClient(base);
    await baas.login('baas', PW);
    assert.strictEqual((await baas.put('/app/api/admin/settings', { drawingRequests: false })).status, 200);
    assert.strictEqual((await anon.get('/app/api/public/drawing')).body.enabled, false);
    assert.strictEqual((await anon.post('/app/api/public/drawing', submission())).status, 404);
    // Uitgeschakelde organisatie ontvangt ook niets.
    store.updateTenant(groen.id, { disabled: true });
    assert.strictEqual((await anon.post('/app/api/public/drawing', submission({ org: 'groen' }))).status, 404);
  } finally {
    server.close();
  }
});

test('indienen is per IP-adres begrensd', async () => {
  const { server, base } = await setup();
  try {
    const anon = createClient(base);
    for (let i = 0; i < PER_IP_HOUR; i++) assert.strictEqual((await anon.post('/app/api/public/drawing', submission({ consent: false }))).status, 400);
    assert.strictEqual((await anon.post('/app/api/public/drawing', submission())).status, 429);
  } finally {
    server.close();
  }
});

test('controle: klant biedt aan, installateur keurt goed, pas dan een offerte', async () => {
  const { server, base } = await setup();
  try {
    const klaas = createClient(base);
    await klaas.login('klaas', PW);
    const created = await klaas.post('/app/api/plans', { data: plan('Voortuin Klaas') });
    assert.strictEqual(created.body.reviewStatus, 'concept');
    const id = created.body.id;
    // Een klant mag niet goedkeuren.
    assert.strictEqual((await klaas.post(`/app/api/plans/${id}/review`, { action: 'approve' })).status, 403);
    const req = await klaas.post(`/app/api/plans/${id}/review-request`, { question: 'Klopt dit?' });
    assert.strictEqual(req.status, 200);
    assert.deepStrictEqual([req.body.review.status, req.body.review.question, req.body.review.via], ['ter_controle', 'Klopt dit?', 'account']);

    const kees = createClient(base);
    await kees.login('kees', PW);
    /**
     * Maakt als installateur een offerte uit een plan.
     * @param {string} planId Id van het plan.
     * @returns {Promise<object>} Het antwoord.
     */
    const quote = (planId) => kees.post('/app/api/quotes', { data: { title: 'Offerte', planId, customer: { name: 'Klaas' }, lines: [] } });
    const blocked = await quote(id);
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.body.error, 'plan_not_approved');
    assert.strictEqual((await kees.post(`/app/api/plans/${id}/review`, { action: 'nee' })).status, 400);
    const ok = await kees.post(`/app/api/plans/${id}/review`, { action: 'approve' });
    assert.deepStrictEqual([ok.body.review.status, ok.body.review.reviewedBy], ['goedgekeurd', 'Kees Installateur']);
    assert.strictEqual((await quote(id)).status, 201);
    assert.strictEqual((await klaas.get(`/app/api/plans/${id}`)).body.review.status, 'goedgekeurd');

    // Past de klant daarna iets aan, dan gaat het plan opnieuw ter controle.
    const edit = await klaas.put(`/app/api/plans/${id}`, { data: plan('Voortuin Klaas, met haag') });
    assert.strictEqual(edit.body.reviewStatus, 'ter_controle');
    assert.strictEqual((await kees.get(`/app/api/plans/${id}`)).body.review.status, 'ter_controle');

    // Een installateur keurt zijn eigen plan in één keer goed; wijzigen houdt het goedgekeurd.
    const own = (await kees.post('/app/api/plans', { data: plan('Tuin van Kees') })).body.id;
    assert.strictEqual((await kees.post(`/app/api/plans/${own}/review`, { action: 'approve' })).body.review.status, 'goedgekeurd');
    assert.strictEqual((await kees.put(`/app/api/plans/${own}`, { data: plan('Tuin van Kees 2') })).body.reviewStatus, 'goedgekeurd');
    assert.strictEqual((await kees.post(`/app/api/plans/${own}/review`, { action: 'reopen' })).body.review.status, 'concept');

    // Een plan van een ander kan de klant niet aanbieden.
    assert.strictEqual((await klaas.post(`/app/api/plans/${own}/review-request`, { question: 'x' })).status, 404);
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
    const id = (await klaas.post('/app/api/plans', { data: plan('Tuin Klaas') })).body.id;
    const kees = createClient(base);
    await kees.login('kees', PW);
    // nog niet goedgekeurd
    assert.strictEqual((await kees.post('/app/api/plan/learn', { planId: id, samples })).status, 404);
    await kees.post(`/app/api/plans/${id}/review`, { action: 'approve' });
    // klant mist het recht
    assert.strictEqual((await klaas.post('/app/api/plan/learn', { planId: id, samples })).status, 403);
    // andere organisatie
    const gerrit = createClient(base);
    await gerrit.login('gerrit', PW, 'groen');
    assert.strictEqual((await gerrit.post('/app/api/plan/learn', { planId: id, samples })).status, 404);
    assert.strictEqual((await kees.post('/app/api/plan/learn', { planId: id, samples })).status, 200);
    // opnieuw goedkeuren vervangt, telt dubbel (door een mens gecontroleerd)
    assert.strictEqual((await kees.post('/app/api/plan/learn', { planId: id, samples })).status, 200);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM plan_recognitions WHERE tenant_id = ?').get(main.id).n, 1);
    const learned = (await kees.get('/app/api/plan/learned')).body;
    assert.deepStrictEqual([learned.examples, learned.bins['10'][1]], [1, 200]);
    assert.strictEqual((await gerrit.get('/app/api/plan/learned')).body.examples, 0, 'andere organisatie leert niet mee');
  } finally {
    server.close();
  }
});

/**
 * Een kleine geldige PNG (4 × 4 pixels, wit).
 * @returns {string} De PNG als data-URL.
 */
function tinyPng() {
  const zlib = require('zlib');
  /**
   * Eén PNG-blok met lengte en controlegetal.
   * @param {string} type De bloknaam.
   * @param {Buffer} body De inhoud.
   * @returns {Buffer} Het blok.
   */
  const chunk = (type, body) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), body])) >>> 0);
    return Buffer.concat([head, Buffer.from(type), body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(4, 0); header.writeUInt32BE(4, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: 4 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(12, 255)])));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

test('meetcorpus: standaard uit, alleen goedgekeurd plan door wie mag goedkeuren, eigen omgeving, versleuteld en weg met het plan', async () => {
  const { createVault } = require('../src/beveiliging/vault');
  const vault = createVault(Buffer.alloc(32, 3));
  const { server, base, db, main, groen } = await setup(vault);
  try {
    const { sanitizeFinalPlan } = require('../src/beregening/recognitions');
    const image = tinyPng();
    const final = { areas: [{ type: 'lawn', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }] }], elements: [{ kind: 'source', x: 1, y: 1 }], metersPerPixel: 0.05 };
    const klaas = createClient(base);
    await klaas.login('klaas', PW);
    const kees = createClient(base);
    await kees.login('kees', PW);
    const baas = createClient(base);
    await baas.login('baas', PW);
    const id = (await klaas.post('/app/api/plans', { data: plan('Tuin Klaas') })).body.id;
    await kees.post(`/app/api/plans/${id}/review`, { action: 'approve' });
    // staat standaard uit, ook voor de config van de planner
    assert.strictEqual((await kees.get('/app/api/config')).body.planCorpus, false);
    assert.strictEqual((await kees.post('/app/api/plan/corpus', { planId: id, image, final })).status, 409);
    assert.strictEqual((await baas.put('/app/api/admin/settings', { planCorpus: true })).status, 200);
    assert.strictEqual((await kees.get('/app/api/config')).body.planCorpus, true);
    // rechten, plan en invoer
    assert.strictEqual((await klaas.post('/app/api/plan/corpus', { planId: id, image, final })).status, 403, 'klant mag niet');
    assert.strictEqual((await kees.post('/app/api/plan/corpus', { planId: 'onbekend', image, final })).status, 404);
    const gerrit = createClient(base);
    await gerrit.login('gerrit', PW, 'groen');
    assert.strictEqual((await gerrit.post('/app/api/plan/corpus', { planId: id, image, final })).status, 409, 'andere organisatie heeft het corpus uit');
    createSettings({ db, tenantId: groen.id }).update({ planCorpus: true });
    assert.strictEqual((await gerrit.post('/app/api/plan/corpus', { planId: id, image, final })).status, 404, 'plan van een andere organisatie is onvindbaar, ook met het corpus aan');
    assert.strictEqual((await kees.post('/app/api/plan/corpus', { planId: id, image: 'data:image/png;base64,AAAA', final })).status, 400, 'geen echte afbeelding');
    assert.strictEqual((await kees.post('/app/api/plan/corpus', { planId: id, image, final: { areas: [{ type: 'lawn', points: [{ x: 'a', y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] }] } })).status, 400);
    assert.strictEqual((await kees.post('/app/api/plan/corpus', { planId: id, image, final: { areas: [] } })).status, 400);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM plan_recognitions WHERE tenant_id = ? AND corpus_image <> ''`).get(main.id).n, 0);
    // bewaren, opnieuw bewaren vervangt
    assert.strictEqual((await kees.post('/app/api/plan/corpus', { planId: id, image, final })).status, 200);
    assert.strictEqual((await kees.post('/app/api/plan/corpus', { planId: id, image, final })).status, 200);
    const row = db.prepare(`SELECT corpus_image, corpus_width, corpus_height, corpus_final FROM plan_recognitions WHERE tenant_id = ? AND plan_id = ?`).all(main.id, id);
    assert.strictEqual(row.length, 1);
    assert.ok(row[0].corpus_image.startsWith('f1:'), 'versleuteld opgeslagen');
    assert.deepStrictEqual([row[0].corpus_width, row[0].corpus_height], [4, 4]);
    assert.strictEqual(JSON.parse(row[0].corpus_final).metersPerPixel, 0.05);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM plan_recognitions WHERE tenant_id = ? AND corpus_image <> ''`).get(groen.id).n, 0);
    // export: ontsleutelt met de hoofdsleutel van de omgeving en schrijft png + json voor de testbank
    const fs = require('fs'), os = require('os'), path = require('path');
    const { exportCorpus } = require('../tools/corpus-export');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
    // een andere sleutel kan niets openen
    assert.deepStrictEqual(exportCorpus({ db, vault: createVault(Buffer.alloc(32, 7)), directory }), { written: 0, skipped: 1 });
    assert.deepStrictEqual(exportCorpus({ db, vault, directory }), { written: 1, skipped: 0 });
    const files = fs.readdirSync(directory).sort();
    assert.deepStrictEqual(files.map((file) => path.extname(file)), ['.json', '.png']);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8')).areas[0].type, 'lawn');
    assert.strictEqual(fs.readFileSync(path.join(directory, files[1])).subarray(1, 4).toString(), 'PNG');
    fs.rmSync(directory, { recursive: true, force: true });
    // het corpus verdwijnt als het plan definitief wordt gewist (AVG)
    assert.strictEqual((await baas.del(`/app/api/admin/plans/${id}`)).status, 200);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM plan_recognitions WHERE tenant_id = ? AND plan_id = ?`).get(main.id, id).n, 0);
    // opschonen van het eindplan
    assert.strictEqual(sanitizeFinalPlan({ areas: [{ type: 'lawn', points: [{ x: 1e9, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] }] }, 100, 100), null);
    assert.deepStrictEqual(sanitizeFinalPlan({ areas: final.areas, elements: [{ kind: 'boom', x: 1, y: 1 }, { kind: 'valvebox', x: 1.234, y: 2 }] }, 100, 100).elements, [{ kind: 'valvebox', x: 1.23, y: 2 }]);
  } finally {
    server.close();
  }
});

test('tekening indienen staat standaard uit (T-03)', async () => {
  const db = openDb();
  const store = createStore(db);
  store.ensureTenant();
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db }));
  try {
    const anon = createClient(base);
    assert.strictEqual((await anon.get('/app/api/public/drawing')).body.enabled, false);
    assert.strictEqual((await anon.post('/app/api/public/drawing', submission())).status, 404);
  } finally {
    server.close();
  }
});

test('te grote tekening geweigerd; onbehandelde tekeningen na de termijn opgeruimd (T-03)', async () => {
  const { db, store, main, server, base } = await setup();
  try {
    const anon = createClient(base);
    const huge = submission({ data: { ...plan('Groot'), background: { dataUrl: `data:image/jpeg;base64,${'A'.repeat(2 * 1024 * 1024)}`, scale: 0.01 } } });
    assert.strictEqual((await anon.post('/app/api/public/drawing', huge)).status, 413);
    assert.strictEqual((await anon.post('/app/api/public/drawing', submission())).status, 201);
    assert.ok(store.pendingDrawingChars(main.id) > 0);
    assert.strictEqual(store.purgeStaleDrawings(main.id, RETENTION_DAYS), 0, 'een verse aanvraag blijft staan');
    const old = new Date(Date.now() - (RETENTION_DAYS + 1) * 86400000).toISOString();
    db.prepare('UPDATE plans SET review_requested_at = ? WHERE tenant_id = ?').run(old, main.id);
    assert.strictEqual(store.purgeStaleDrawings(main.id, RETENTION_DAYS), 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM plans WHERE tenant_id = ?').get(main.id).n, 0);
    const guest = db.prepare("SELECT email, phone, display_name FROM users WHERE tenant_id = ? AND kind = 'gast'").get(main.id);
    assert.deepStrictEqual({ ...guest }, { email: '', phone: '', display_name: 'Gewiste aanvrager' });
    assert.strictEqual(store.pendingDrawingChars(main.id), 0);
  } finally {
    server.close();
  }
});
