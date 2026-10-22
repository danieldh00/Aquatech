// Werkorders: opbouw uit een offerte (werkstappen, materialen, zones) en de API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const QuoteCore = require('../../frontend/offertes/quote-core.js');
const W = require('../../frontend/werkorders/workorder-core.js');
const { createClient } = require('./helpers/http-client');

const FRONT = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['geometry.js', 'sprinklerlib.js', 'catalog.js', 'hydraulics.js', 'bom.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, f), 'utf8'), sandbox);
const lib = { Catalog: sandbox.window.Catalog, Hydraulics: sandbox.window.Hydraulics, BOM: sandbox.window.BOM };
const plain = (v) => JSON.parse(JSON.stringify(v));

const garden = () => ({
  meta: { name: 'Tuin Jansen', customer: 'Fam. Jansen', address: 'Dorpsstraat 1, Nunspeet' },
  settings: { level: 'expert', pressure: 3.5, flow: 2 },
  areas: [
    { id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 8 }, { x: 0, y: 8 }] },
    { id: 'a2', type: 'bed', pts: [{ x: 0, y: 9 }, { x: 12, y: 9 }, { x: 12, y: 10.5 }, { x: 0, y: 10.5 }] },
  ],
  sprinklers: [
    { id: 's1', type: 'rotator', x: 0, y: 0, r: 6, arc: 90, start: 0 },
    { id: 's2', type: 'rotator', x: 12, y: 0, r: 6, arc: 90, start: 90 },
    { id: 's3', type: 'rotator', x: 12, y: 8, r: 6, arc: 90, start: 180 },
    { id: 's4', type: 'rotator', x: 0, y: 8, r: 6, arc: 90, start: 270 },
    { id: 's5', type: 'rotator', x: 6, y: 0, r: 6, arc: 180, start: 0 },
    { id: 's6', type: 'rotator', x: 6, y: 8, r: 6, arc: 180, start: 180 },
  ],
  zones: [],
  elements: [
    { id: 'e1', kind: 'source', x: -2, y: 4 },
    { id: 'e2', kind: 'valvebox', x: -1, y: 5 },
    { id: 'e3', kind: 'controller', x: -3, y: 6 },
  ],
});

const quoteFromGarden = () => {
  const built = plain(QuoteCore.fromPlan(garden(), lib, { hourlyRate: 55, callOutFee: 35 }));
  return { id: 'q1', number: 'OF-2026-0007', data: QuoteCore.sanitize({ title: 'Aanleg beregening', customer: { name: 'Fam. Jansen', address: 'Dorpsstraat 1\nNunspeet' }, planId: 'p1', lines: built.lines }) };
};

test('werkorder uit offerte: materialen zonder prijzen, arbeid als werkstappen in uitvoeringsvolgorde', () => {
  const quote = quoteFromGarden();
  const { data } = W.fromQuote(quote);
  const mat = quote.data.lines.filter((l) => l.section === 'materiaal');
  assert.strictEqual(data.materials.length, mat.length);
  assert.ok(data.materials.every((m) => !('price' in m) && m.picked === false));
  assert.deepStrictEqual(data.materials.map((m) => m.code), mat.map((l) => l.code));
  const labor = quote.data.lines.filter((l) => l.section === 'arbeid');
  const fromLabor = data.steps.filter((s) => labor.some((l) => l.description === s.title));
  assert.strictEqual(fromLabor.length, labor.length, 'elke arbeidsregel wordt een stap');
  assert.strictEqual(W.progress(data).hours, QuoteCore.round2(labor.reduce((s, l) => s + l.qty, 0)), 'uren gelijk aan de offerte');
  const titles = data.steps.map((s) => s.title);
  const idx = (re) => titles.findIndex((t) => re.test(t));
  assert.ok(idx(/Wateraansluiting/) < idx(/Sleuven/) && idx(/Sleuven/) < idx(/Sproeiers plaatsen/) && idx(/Sproeiers plaatsen/) < idx(/Inregelen/), 'logische volgorde');
  assert.strictEqual(data.steps[0].phase, 'voorbereiding');
  assert.strictEqual(data.steps.find((s) => /Inregelen/.test(s.title)).phase, 'oplevering');
  assert.ok(!titles.includes('Voorrijkosten'), 'overige regels zijn geen werkstap');
  assert.strictEqual(data.quoteNumber, 'OF-2026-0007');
  assert.strictEqual(data.customer.name, 'Fam. Jansen');
  assert.deepStrictEqual(data.zones, [], 'zonder plan geen zones');
});

test('werkorder uit offerte: niet gekozen opties vallen weg', () => {
  const quote = { id: 'q2', number: 'OF-2026-0008', data: { lines: [
    { id: 'a', section: 'materiaal', description: 'Sproeier', qty: 4, unit: 'st' },
    { id: 'b', section: 'materiaal', description: 'Regensensor', qty: 1, unit: 'st', optional: true, selected: false },
    { id: 'c', section: 'materiaal', description: 'Wifi-module', qty: 1, unit: 'st', optional: true, selected: true },
    { id: 'd', section: 'arbeid', description: 'Regensensor monteren', qty: 0.5, unit: 'uur', optional: true },
  ] } };
  const { data } = W.fromQuote(quote);
  assert.deepStrictEqual(data.materials.map((m) => m.description), ['Sproeier', 'Wifi-module']);
  assert.ok(!data.steps.some((s) => /Regensensor/.test(s.title)));
});

test('werkorder met plan: zone-indeling met onderdelen, debiet en druk', () => {
  const { data, warnings } = plain(W.fromQuote(quoteFromGarden(), garden(), lib));
  assert.ok(data.zones.length >= 2);
  const lawn = data.zones.filter((z) => /Gazon/.test(z.kind));
  assert.strictEqual(lawn.reduce((s, z) => s + Number(/(\d+)× Rotator/.exec(z.parts)[1]), 0), 6, 'alle sproeiers verdeeld');
  assert.ok(data.zones.some((z) => /druppelslang \(beplanting/.test(z.parts)), 'druppelzone voor de border');
  assert.ok(data.zones.every((z) => z.flowLph > 0 && z.pipeM > 0 && z.pressureBar > 0));
  assert.strictEqual(data.design.sprinklers, 6);
  assert.strictEqual(data.design.lawnM2, 96);
  assert.match(data.design.mainPipe, /^PE \d+ mm/);
  assert.ok(Array.isArray(warnings));
  // afstelling per kop: kop, sector, sproeihoek, worp en linkerrand zoals in het plan
  assert.strictEqual(data.heads.length, 6);
  const h1 = data.heads.find((h) => h.nr === 1);
  assert.deepStrictEqual([h1.nozzle, h1.sector, h1.arc, h1.r, h1.leftText], ['MP2000', '90–210°', 90, 6, '0° (rechts)']);
  const h6 = data.heads.find((h) => h.nr === 6);
  assert.strictEqual(h6.leftText, '180° (links)');
  assert.ok(data.heads.every((h) => /^Zone/.test(h.zone)), 'elke kop heeft een zone');
  const clean = W.sanitize({ heads: [{ nr: 'x', arc: 999, nozzle: '<b>'.repeat(50) }] }).heads[0];
  assert.strictEqual(clean.arc, 360);
  assert.ok(clean.nozzle.length <= 60);
});

test('planning: werkdagen, moment en opschonen van tijden en dagen', () => {
  // Vrijdag 6 november 2026 + 3 werkdagen = vr, ma, di.
  assert.deepStrictEqual(W.workDays('2026-11-06', 3), ['2026-11-06', '2026-11-09', '2026-11-10']);
  assert.deepStrictEqual(W.workDays('2026-11-07', 2), ['2026-11-07', '2026-11-09'], 'start in het weekend telt mee');
  assert.deepStrictEqual(W.workDays('', 2), []);
  assert.strictEqual(W.addDays('2026-12-31', 1), '2027-01-01');
  const d = W.sanitize({ plannedDate: '2026-11-06', startTime: '08:00', endTime: '16:30', days: 99 });
  assert.deepStrictEqual([d.endTime, d.days], ['16:30', W.MAX_DAYS]);
  assert.strictEqual(W.sanitize({ days: 'x' }).days, 1);
  assert.notStrictEqual(W.momentKey(W.moment(d)), W.momentKey(W.moment({ ...d, endTime: '17:00' })), 'andere eindtijd = ander moment');
  // Blok uit de geplande uren: meer dan een werkdag = verdeeld over gelijke dagen.
  assert.deepStrictEqual(W.fitHours('10:00', 5), { endTime: '15:00', days: 1 });
  assert.deepStrictEqual(W.fitHours('08:00', 8), { endTime: '16:00', days: 1 });
  assert.deepStrictEqual(W.fitHours('08:00', 12), { endTime: '14:00', days: 2 });
  assert.deepStrictEqual(W.fitHours('08:00', 6.4), { endTime: '14:30', days: 1 }, 'afgerond op een kwartier');
  assert.strictEqual(W.fitHours('', 4), null);
  assert.strictEqual(W.fitHours('08:00', 0), null);
});

test('korte omschrijving voor de planning', () => {
  const steps = [
    { phase: 'voorbereiding', title: 'Materialen laden' },
    { phase: 'uitvoering', title: 'Sleuven graven' },
    { phase: 'uitvoering', title: 'Sproeiers plaatsen' },
    { phase: 'oplevering', title: 'Opruimen' },
  ];
  assert.strictEqual(W.summary({ design: { zones: 3, sprinklers: 1, lawnM2: 120.4 }, steps }),
    '3 zones, 1 sproeier, 120 m² gazon: Sleuven graven, Sproeiers plaatsen');
  assert.strictEqual(W.summary({ instructions: '\n  Alleen de achtertuin aanleggen.\nSleutel bij de buren.', steps }), 'Alleen de achtertuin aanleggen.', 'instructies gaan voor');
  assert.strictEqual(W.summary({ instructions: 'x'.repeat(300) }, 20).length, 20);
  assert.strictEqual(W.summary({}), '');
});

test('opschonen en voortgang', () => {
  const d = W.sanitize({ plannedDate: 'morgen', startTime: '25:00', steps: [{ phase: 'x', hours: -3, done: 1, actualHours: '2.5' }, { done: false, hours: 1 }], materials: [{ qty: 'a', picked: 'ja' }] });
  assert.strictEqual(d.plannedDate, '');
  assert.strictEqual(d.startTime, '');
  assert.deepStrictEqual([d.steps[0].phase, d.steps[0].hours, d.steps[0].done, d.steps[0].actualHours], ['uitvoering', 0, true, 2.5]);
  assert.strictEqual(d.steps[1].actualHours, null);
  assert.deepStrictEqual([d.materials[0].qty, d.materials[0].picked], [0, true]);
  assert.deepStrictEqual(W.progress(d), { steps: 2, done: 1, pct: 50, hours: 1, actualHours: 2.5, materials: 1, picked: 1 });
});

// ---------- API ----------
const SECRET = 'z'.repeat(64);

async function setup(appOpts = {}) {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!' });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: 'Tuin-Plan-2026!' });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: 'Tuin-Plan-2026!' });
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db, ...appOpts }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username) => {
    const c = createClient(base);
    assert.strictEqual((await c.post('/api/auth/login', { username, password: 'Tuin-Plan-2026!' })).status, 200);
    return c;
  };
  return { server, base, as };
}

test('API: werkorder alleen uit een geaccordeerde offerte, alleen voor beheerder en installateur', async () => {
  const { server, base, as } = await setup();
  try {
    assert.strictEqual((await createClient(base).get('/api/workorders')).status, 401);
    const kees = await as('kees'), baas = await as('baas'), klaas = await as('klaas');
    const quote = quoteFromGarden();
    const q = (await kees.post('/api/quotes', { data: quote.data })).body;

    assert.strictEqual((await kees.post('/api/workorders', { quoteId: q.id })).status, 409, 'concept: nog geen akkoord');
    assert.strictEqual((await kees.post('/api/workorders', { quoteId: 'bestaat-niet' })).status, 404);
    await kees.put(`/api/quotes/${q.id}`, { status: 'akkoord' });

    assert.strictEqual((await klaas.get('/api/workorders')).status, 403, 'klant ziet geen werkorders');
    assert.strictEqual((await klaas.post('/api/workorders', { quoteId: q.id })).status, 403);

    // Zonder data bouwt de server de werkorder zelf uit de offerte.
    const a = await kees.post('/api/workorders', { quoteId: q.id });
    assert.strictEqual(a.status, 201);
    const year = new Date().getFullYear();
    assert.strictEqual(a.body.number, `WO-${year}-0001`);
    assert.strictEqual(a.body.status, 'open');
    assert.strictEqual(a.body.quoteId, q.id);
    assert.strictEqual(a.body.customer, 'Fam. Jansen');
    assert.strictEqual(a.body.address, 'Dorpsstraat 1, Nunspeet');
    assert.strictEqual(a.body.data.quoteNumber, q.number);
    assert.strictEqual(a.body.data.materials.length, quote.data.lines.filter((l) => l.section === 'materiaal').length);

    // Met data uit de browser (zones); de koppeling komt altijd uit de offerte.
    const built = plain(W.fromQuote(q, garden(), lib)).data;
    const b = await baas.post('/api/workorders', { quoteId: q.id, data: { ...built, quoteId: 'nep', quoteNumber: 'nep', plannedDate: `${year}-05-01` } });
    assert.strictEqual(b.body.number, `WO-${year}-0002`);
    assert.strictEqual(b.body.status, 'gepland', 'met datum meteen gepland');
    assert.strictEqual(b.body.data.quoteId, q.id);
    assert.strictEqual(b.body.data.quoteNumber, q.number);
    assert.ok(b.body.data.zones.length >= 2);

    assert.deepStrictEqual((await kees.get(`/api/workorders?quote=${q.id}`)).body.items.map((w) => w.number).sort(), [a.body.number, b.body.number]);

    // Toewijzen: alleen aan beheerders en installateurs.
    const staff = (await kees.get('/api/workorder-staff')).body.items;
    assert.deepStrictEqual(staff.map((u) => u.displayName), ['Baas', 'Kees']);
    const keesId = staff.find((u) => u.displayName === 'Kees').id;
    const klaasId = (await klaas.get('/api/me')).body.user.id;
    assert.strictEqual((await kees.put(`/api/workorders/${a.body.id}`, { assigneeId: klaasId })).status, 400);
    const steps = a.body.data.steps.map((s, i) => ({ ...s, done: i === 0, actualHours: i === 0 ? 0.5 : null }));
    const u = await kees.put(`/api/workorders/${a.body.id}`, { assigneeId: keesId, status: 'bezig', data: { ...a.body.data, steps, quoteId: 'nep' } });
    assert.strictEqual(u.status, 200);
    assert.strictEqual(u.body.assignee.displayName, 'Kees');
    assert.strictEqual(u.body.status, 'bezig');
    assert.strictEqual(u.body.progress.done, 1);
    assert.strictEqual(u.body.progress.actualHours, 0.5);
    assert.strictEqual(u.body.data.quoteId, q.id, 'koppeling ligt vast');
    assert.strictEqual((await kees.put(`/api/workorders/${a.body.id}`, { status: 'weg' })).status, 400);

    // Verwijderen; definitief wissen alleen door een beheerder.
    assert.strictEqual((await kees.del(`/api/workorders/${a.body.id}`)).status, 200);
    assert.strictEqual((await kees.get(`/api/workorders/${a.body.id}`)).status, 404);
    assert.strictEqual((await kees.del(`/api/admin/workorders/${b.body.id}`)).status, 403);
    assert.strictEqual((await baas.del(`/api/admin/workorders/${b.body.id}`)).status, 200);
    const c = await kees.post('/api/workorders', { quoteId: q.id });
    assert.strictEqual(c.body.number, `WO-${year}-0002`, 'na definitief wissen telt alleen het hoogste bestaande nummer');
  } finally {
    server.close();
  }
});

test('API: inplannen en klantlink: de klant ziet de afspraak en bevestigt of vraagt een ander moment', async () => {
  const sent = [];
  const mailerFor = () => ({ configured: () => true, send: async (m) => { sent.push(m); } });
  const { server, base, as } = await setup({ mailerFor });
  try {
    const kees = await as('kees'), klaas = await as('klaas'), baas = await as('baas');
    assert.strictEqual((await baas.put('/api/quote-profile', { profile: { email: 'info@example.com' } })).status, 200);
    const quote = quoteFromGarden();
    const q = (await kees.post('/api/quotes', { data: { ...quote.data, customer: { ...quote.data.customer, email: 'jansen@example.com' } } })).body;
    await kees.put(`/api/quotes/${q.id}`, { status: 'akkoord' });
    const wo = (await kees.post('/api/workorders', { quoteId: q.id })).body;
    assert.strictEqual(wo.appointment.state, 'geen');
    const page = `${base}/openbaar/afspraak.html`;

    // Zonder datum geen afspraak om te versturen.
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/send`, { to: 'jansen@example.com', url: page })).status, 409);

    // Inplannen vanuit de planning: datum + uitvoerder, status gaat naar Gepland.
    const keesId = (await kees.get('/api/me')).body.user.id;
    const future = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/schedule`, { plannedDate: 'morgen' })).status, 400);
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/schedule`, { days: 0 })).status, 400);
    assert.strictEqual((await klaas.post(`/api/workorders/${wo.id}/schedule`, { plannedDate: future(10) })).status, 403);
    let s = await kees.post(`/api/workorders/${wo.id}/schedule`, { plannedDate: future(10), startTime: '08:00', endTime: '12:00', assigneeId: keesId });
    assert.strictEqual(s.status, 200);
    assert.deepStrictEqual([s.body.status, s.body.plannedDate, s.body.endTime, s.body.assignee.displayName, s.body.appointment.state], ['gepland', future(10), '12:00', 'Kees', 'niet_gedeeld']);
    assert.strictEqual(s.body.data.title, wo.data.title, 'de rest van de werkorder blijft staan');

    // Link: alleen naar de afspraakpagina.
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/share`, { url: `${base}/openbaar/offerte.html` })).status, 400);
    const sh = await kees.post(`/api/workorders/${wo.id}/send`, { to: 'jansen@example.com', subject: 'Uw afspraak', message: 'Beste familie Jansen', url: page });
    assert.strictEqual(sh.status, 200);
    assert.strictEqual(sh.body.appointment.state, 'wacht');
    assert.strictEqual(sh.body.share.sentTo, 'jansen@example.com');
    assert.ok(sh.body.share.url.startsWith(`${page}#t=`));
    assert.ok(sent[0].text.includes(sh.body.share.url), 'link staat in de e-mail');
    const token = sh.body.share.url.split('#t=')[1];
    // Dezelfde link bij opnieuw delen.
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/share`, { url: page })).body.share.url, sh.body.share.url);

    // De openbare pagina en haar bestanden zijn zonder inlog bereikbaar.
    for (const f of ['/openbaar/afspraak.html', '/openbaar/afspraak.js', '/openbaar/afspraak.css', '/werkorders/workorder-core.js']) {
      assert.strictEqual((await fetch(base + f)).status, 200, f);
    }
    assert.strictEqual((await fetch(`${base}/werkorders/werkorders.js`)).status, 401, 'de rest van de module niet');

    const pub = (method, p, body, t = token) => fetch(`${base}/api/public/appointment${p}`, {
      method, headers: { 'X-Afspraak-Token': t, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.strictEqual((await pub('GET', '', null, 'x'.repeat(32))).status, 404);
    let g = await pub('GET', '');
    assert.strictEqual(g.status, 200);
    assert.deepStrictEqual([g.body.appointment.number, g.body.appointment.plannedDate, g.body.appointment.startTime, g.body.appointment.appointment.state], [wo.number, future(10), '08:00', 'wacht']);
    assert.strictEqual(g.body.appointment.steps, undefined, 'geen uitvoeringsplan voor de klant');
    assert.strictEqual(g.body.appointment.materials, undefined);
    assert.strictEqual(JSON.stringify(g.body).includes('Kees'), false, 'geen namen van medewerkers');
    assert.ok((await kees.get(`/api/workorders/${wo.id}`)).body.share.viewedAt, 'geopend wordt bijgehouden');

    // Reageren: naam verplicht, bij een ander moment ook een toelichting.
    assert.strictEqual((await pub('POST', '/respond', { answer: 'bevestigd', name: '' })).status, 400);
    assert.strictEqual((await pub('POST', '/respond', { answer: 'ander_moment', name: 'Jan Jansen' })).status, 400);
    assert.strictEqual((await pub('POST', '/respond', { answer: 'misschien', name: 'Jan Jansen' })).status, 400);
    const r1 = await pub('POST', '/respond', { answer: 'ander_moment', name: 'Jan Jansen', reason: 'Liever de week erna.' });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.body.appointment.appointment.state, 'ander_moment');
    assert.strictEqual((await pub('POST', '/respond', { answer: 'bevestigd', name: 'Jan Jansen' })).status, 409, 'één reactie per moment');
    assert.ok(sent.some((m) => /ander moment/.test(m.subject)), 'bericht naar het bedrijf');
    const view = (await kees.get(`/api/workorders/${wo.id}`)).body;
    assert.deepStrictEqual([view.appointment.state, view.appointment.response.reason], ['ander_moment', 'Liever de week erna.']);

    // Verschuiven: de klant moet het nieuwe moment opnieuw bevestigen.
    s = await kees.post(`/api/workorders/${wo.id}/schedule`, { plannedDate: future(17), days: 2 });
    assert.strictEqual(s.body.appointment.state, 'wacht');
    assert.strictEqual(s.body.appointment.response.current, false);
    const r2 = await pub('POST', '/respond', { answer: 'bevestigd', name: 'Jan Jansen' });
    assert.strictEqual(r2.status, 200);
    assert.deepStrictEqual(r2.body.appointment.dates.length, 2);
    assert.strictEqual((await kees.get('/api/workorders')).body.items[0].appointment.state, 'bevestigd');
    // Alleen de tijd veranderen is ook een ander moment.
    s = await kees.post(`/api/workorders/${wo.id}/schedule`, { startTime: '09:00' });
    assert.strictEqual(s.body.appointment.state, 'wacht');
    await kees.post(`/api/workorders/${wo.id}/schedule`, { startTime: '08:00' });
    assert.strictEqual((await kees.get(`/api/workorders/${wo.id}`)).body.appointment.state, 'bevestigd', 'terug naar het bevestigde moment');

    // Geannuleerd: niet meer te bevestigen; uit de planning = terug naar Nieuw.
    await kees.put(`/api/workorders/${wo.id}`, { status: 'geannuleerd' });
    await kees.post(`/api/workorders/${wo.id}/schedule`, { startTime: '10:00' });
    assert.strictEqual((await pub('POST', '/respond', { answer: 'bevestigd', name: 'Jan Jansen' })).status, 409);
    await kees.put(`/api/workorders/${wo.id}`, { status: 'gepland' });
    s = await kees.post(`/api/workorders/${wo.id}/schedule`, { plannedDate: '' });
    assert.deepStrictEqual([s.body.status, s.body.appointment.state], ['open', 'geen']);

    // Ingetrokken link: niets meer te zien.
    assert.strictEqual((await pub('GET', '')).status, 200);
    assert.strictEqual((await kees.del(`/api/workorders/${wo.id}/share`)).status, 200);
    assert.strictEqual((await pub('GET', '')).status, 404);
  } finally {
    server.close();
  }
});

test('API: startscherm (my-day): klussen van de dag per uitvoerder, meerdaagse klussen per werkdag', async () => {
  const { server, base, as } = await setup();
  try {
    const kees = await as('kees'), baas = await as('baas'), klaas = await as('klaas');
    const quote = quoteFromGarden();
    const q = (await kees.post('/api/quotes', { data: { ...quote.data, customer: { ...quote.data.customer, phone: '06 12345678', contact: 'Jan Jansen' } } })).body;
    await kees.put(`/api/quotes/${q.id}`, { status: 'akkoord' });
    const mk = async () => (await kees.post('/api/workorders', { quoteId: q.id })).body;
    const keesId = (await kees.get('/api/me')).body.user.id;
    const baasId = (await baas.get('/api/me')).body.user.id;
    const [a, b, c, d] = [await mk(), await mk(), await mk(), await mk()];
    // Vrijdag 11 jan 2030, 2 werkdagen: vrijdag en maandag 14 jan.
    await kees.post(`/api/workorders/${a.id}/schedule`, { plannedDate: '2030-01-11', startTime: '10:00', endTime: '16:00', days: 2, assigneeId: keesId });
    await kees.post(`/api/workorders/${b.id}/schedule`, { plannedDate: '2030-01-14', startTime: '08:00', assigneeId: keesId });
    await kees.post(`/api/workorders/${c.id}/schedule`, { plannedDate: '2030-01-14', startTime: '09:00', assigneeId: baasId });
    await kees.post(`/api/workorders/${d.id}/schedule`, { plannedDate: '2030-01-21', assigneeId: keesId });

    assert.strictEqual((await klaas.get('/api/my-day')).status, 403, 'klant heeft geen startscherm');
    assert.strictEqual((await kees.get('/api/my-day?date=morgen')).status, 400);
    const now = (await kees.get('/api/my-day')).body;
    assert.match(now.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(now.date, now.today, 'zonder datum: vandaag');

    let r = (await kees.get('/api/my-day?date=2030-01-14')).body;
    assert.deepStrictEqual(r.items.map((w) => w.number), [b.number, a.number], 'op starttijd');
    const second = r.items.find((w) => w.id === a.id);
    assert.strictEqual(second.dayNumber, 2);
    assert.strictEqual(second.totalDays, 2);
    assert.strictEqual(second.phone, '06 12345678');
    assert.strictEqual(second.contact, 'Jan Jansen');
    assert.strictEqual(second.address, 'Dorpsstraat 1, Nunspeet');
    assert.strictEqual(second.photos, 0);
    assert.strictEqual(r.next.id, d.id, 'eerstvolgende klus na deze dag');

    assert.deepStrictEqual((await kees.get('/api/my-day?date=2030-01-12')).body.items, [], 'zaterdag telt niet als werkdag');
    r = (await kees.get('/api/my-day?date=2030-01-14&all=1')).body;
    assert.deepStrictEqual(r.items.map((w) => w.number), [b.number, c.number, a.number], 'hele ploeg, op starttijd');
    assert.strictEqual(r.next, null);
    assert.deepStrictEqual((await baas.get('/api/my-day?date=2030-01-14')).body.items.map((w) => w.id), [c.id]);

    // Geannuleerd valt weg.
    await kees.put(`/api/workorders/${b.id}`, { status: 'geannuleerd' });
    assert.deepStrictEqual((await kees.get('/api/my-day?date=2030-01-14')).body.items.map((w) => w.id), [a.id]);
  } finally {
    server.close();
  }
});
