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
const WorkOrderCore = require('../../frontend/werkorders/workorder-core.js');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const FRONT = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const file of ['geometry.js', 'sprinklerlib.js', 'catalog.js', 'hydraulics.js', 'bom.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, file), 'utf8'), sandbox);
const lib = { Catalog: sandbox.window.Catalog, Hydraulics: sandbox.window.Hydraulics, BOM: sandbox.window.BOM };
/**
 * Kopie zonder verwijzingen naar de sandbox (ander realm).
 * @param {*} value De waarde.
 * @returns {*} Een JSON-kopie.
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * Een tuin met gazon, border en zes rotators.
 * @returns {object} De plangegevens.
 */
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

/**
 * Een offerte uit de tuin (via de rekenkern van de offertes).
 * @returns {object} De offerte (id, number, data).
 */
const quoteFromGarden = () => {
  const built = plain(QuoteCore.fromPlan(garden(), lib, { hourlyRate: 55, callOutFee: 35 }));
  return { id: 'q1', number: 'OF-2026-0007', data: QuoteCore.sanitize({ title: 'Aanleg beregening', customer: { name: 'Fam. Jansen', address: 'Dorpsstraat 1\nNunspeet' }, planId: 'p1', lines: built.lines }) };
};

test('werkorder uit offerte: materialen zonder prijzen, arbeid als werkstappen in uitvoeringsvolgorde', () => {
  const quote = quoteFromGarden();
  const { data } = WorkOrderCore.fromQuote(quote);
  const materialLines = quote.data.lines.filter((line) => line.section === 'materiaal');
  assert.strictEqual(data.materials.length, materialLines.length);
  assert.ok(data.materials.every((material) => !('price' in material) && material.picked === false));
  assert.deepStrictEqual(data.materials.map((material) => material.code), materialLines.map((line) => line.code));
  const labor = quote.data.lines.filter((line) => line.section === 'arbeid');
  const fromLabor = data.steps.filter((step) => labor.some((line) => line.description === step.title));
  assert.strictEqual(fromLabor.length, labor.length, 'elke arbeidsregel wordt een stap');
  assert.strictEqual(WorkOrderCore.progress(data).hours, QuoteCore.round2(labor.reduce((sum, line) => sum + line.qty, 0)), 'uren gelijk aan de offerte');
  const titles = data.steps.map((step) => step.title);
  /**
   * Positie van de eerste werkstap waarvan de titel past.
   * @param {RegExp} pattern Patroon voor de titel.
   * @returns {number} Index, of -1.
   */
  const indexOf = (pattern) => titles.findIndex((title) => pattern.test(title));
  assert.ok(indexOf(/Wateraansluiting/) < indexOf(/Sleuven/) && indexOf(/Sleuven/) < indexOf(/Sproeiers plaatsen/) && indexOf(/Sproeiers plaatsen/) < indexOf(/Inregelen/), 'logische volgorde');
  assert.strictEqual(data.steps[0].phase, 'voorbereiding');
  assert.strictEqual(data.steps.find((step) => /Inregelen/.test(step.title)).phase, 'oplevering');
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
  const { data } = WorkOrderCore.fromQuote(quote);
  assert.deepStrictEqual(data.materials.map((material) => material.description), ['Sproeier', 'Wifi-module']);
  assert.ok(!data.steps.some((step) => /Regensensor/.test(step.title)));
});

test('werkorder met plan: zone-indeling met onderdelen, debiet en druk', () => {
  const { data, warnings } = plain(WorkOrderCore.fromQuote(quoteFromGarden(), garden(), lib));
  assert.ok(data.zones.length >= 2);
  const lawn = data.zones.filter((zone) => /Gazon/.test(zone.kind));
  assert.strictEqual(lawn.reduce((sum, zone) => sum + Number(/(\d+)× Rotator/.exec(zone.parts)[1]), 0), 6, 'alle sproeiers verdeeld');
  assert.ok(data.zones.some((zone) => /druppelslang \(beplanting/.test(zone.parts)), 'druppelzone voor de border');
  assert.ok(data.zones.every((zone) => zone.flowLph > 0 && zone.pipeM > 0 && zone.pressureBar > 0));
  assert.strictEqual(data.design.sprinklers, 6);
  assert.strictEqual(data.design.lawnM2, 96);
  assert.match(data.design.mainPipe, /^PE \d+ mm/);
  assert.ok(Array.isArray(warnings));
  // afstelling per kop: kop, sector, sproeihoek, worp en linkerrand zoals in het plan
  assert.strictEqual(data.heads.length, 6);
  const h1 = data.heads.find((head) => head.nr === 1);
  assert.deepStrictEqual([h1.nozzle, h1.sector, h1.arc, h1.r, h1.leftText], ['MP2000', '90–210°', 90, 6, '0° (rechts)']);
  const h6 = data.heads.find((head) => head.nr === 6);
  assert.strictEqual(h6.leftText, '180° (links)');
  assert.ok(data.heads.every((head) => /^Zone/.test(head.zone)), 'elke kop heeft een zone');
  const clean = WorkOrderCore.sanitize({ heads: [{ nr: 'x', arc: 999, nozzle: '<b>'.repeat(50) }] }).heads[0];
  assert.strictEqual(clean.arc, 360);
  assert.ok(clean.nozzle.length <= 60);
});

test('planning: werkdagen, moment en opschonen van tijden en dagen', () => {
  // Vrijdag 6 november 2026 + 3 werkdagen = vr, ma, di.
  assert.deepStrictEqual(WorkOrderCore.workDays('2026-11-06', 3), ['2026-11-06', '2026-11-09', '2026-11-10']);
  assert.deepStrictEqual(WorkOrderCore.workDays('2026-11-07', 2), ['2026-11-07', '2026-11-09'], 'start in het weekend telt mee');
  assert.deepStrictEqual(WorkOrderCore.workDays('', 2), []);
  assert.strictEqual(WorkOrderCore.addDays('2026-12-31', 1), '2027-01-01');
  const sanitized = WorkOrderCore.sanitize({ plannedDate: '2026-11-06', startTime: '08:00', endTime: '16:30', days: 99 });
  assert.deepStrictEqual([sanitized.endTime, sanitized.days], ['16:30', WorkOrderCore.MAX_DAYS]);
  assert.strictEqual(WorkOrderCore.sanitize({ days: 'x' }).days, 1);
  assert.notStrictEqual(WorkOrderCore.momentKey(WorkOrderCore.moment(sanitized)), WorkOrderCore.momentKey(WorkOrderCore.moment({ ...sanitized, endTime: '17:00' })), 'andere eindtijd = ander moment');
  // Blok uit de geplande uren: meer dan een werkdag = verdeeld over gelijke dagen.
  assert.deepStrictEqual(WorkOrderCore.fitHours('10:00', 5), { endTime: '15:00', days: 1 });
  assert.deepStrictEqual(WorkOrderCore.fitHours('08:00', 8), { endTime: '16:00', days: 1 });
  assert.deepStrictEqual(WorkOrderCore.fitHours('08:00', 12), { endTime: '14:00', days: 2 });
  assert.deepStrictEqual(WorkOrderCore.fitHours('08:00', 6.4), { endTime: '14:30', days: 1 }, 'afgerond op een kwartier');
  assert.strictEqual(WorkOrderCore.fitHours('', 4), null);
  assert.strictEqual(WorkOrderCore.fitHours('08:00', 0), null);
});

test('korte omschrijving voor de planning', () => {
  const steps = [
    { phase: 'voorbereiding', title: 'Materialen laden' },
    { phase: 'uitvoering', title: 'Sleuven graven' },
    { phase: 'uitvoering', title: 'Sproeiers plaatsen' },
    { phase: 'oplevering', title: 'Opruimen' },
  ];
  assert.strictEqual(WorkOrderCore.summary({ design: { zones: 3, sprinklers: 1, lawnM2: 120.4 }, steps }),
    '3 zones, 1 sproeier, 120 m² gazon: Sleuven graven, Sproeiers plaatsen');
  assert.strictEqual(WorkOrderCore.summary({ instructions: '\n  Alleen de achtertuin aanleggen.\nSleutel bij de buren.', steps }), 'Alleen de achtertuin aanleggen.', 'instructies gaan voor');
  assert.strictEqual(WorkOrderCore.summary({ instructions: 'x'.repeat(300) }, 20).length, 20);
  assert.strictEqual(WorkOrderCore.summary({}), '');
});

test('opschonen en voortgang', () => {
  const sanitized = WorkOrderCore.sanitize({ plannedDate: 'morgen', startTime: '25:00', steps: [{ phase: 'x', hours: -3, done: 1, actualHours: '2.5' }, { done: false, hours: 1 }], materials: [{ qty: 'a', picked: 'ja' }] });
  assert.strictEqual(sanitized.plannedDate, '');
  assert.strictEqual(sanitized.startTime, '');
  assert.deepStrictEqual([sanitized.steps[0].phase, sanitized.steps[0].hours, sanitized.steps[0].done, sanitized.steps[0].actualHours], ['uitvoering', 0, true, 2.5]);
  assert.strictEqual(sanitized.steps[1].actualHours, null);
  assert.deepStrictEqual([sanitized.materials[0].qty, sanitized.materials[0].picked], [0, true]);
  assert.deepStrictEqual(WorkOrderCore.progress(sanitized), { steps: 2, done: 1, pct: 50, hours: 1, actualHours: 2.5, materials: 1, picked: 1 });
});

// ---------- API ----------
const SECRET = 'z'.repeat(64);

/**
 * Tenant met beheerder, installateur en klant, plus een testserver.
 * @param {object} [appOpts] Extra opties voor createApp.
 * @returns {Promise<object>} server, base en as (inloggen).
 */
async function setup(appOpts = {}) {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!' });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: 'Tuin-Plan-2026!' });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: 'Tuin-Plan-2026!' });
  const { server, base } = await listen(createApp({ secret: SECRET, db, ...appOpts }));
  const as = createLogin(base, { password: 'Tuin-Plan-2026!' });
  return { server, base, as };
}

test('API: werkorder alleen uit een geaccordeerde offerte, alleen voor beheerder en installateur', async () => {
  const { server, base, as } = await setup();
  try {
    assert.strictEqual((await createClient(base).get('/api/workorders')).status, 401);
    const kees = await as('kees'), baas = await as('baas'), klaas = await as('klaas');
    const quote = quoteFromGarden();
    const savedQuote = (await kees.post('/api/quotes', { data: quote.data })).body;

    assert.strictEqual((await kees.post('/api/workorders', { quoteId: savedQuote.id })).status, 409, 'concept: nog geen akkoord');
    assert.strictEqual((await kees.post('/api/workorders', { quoteId: 'bestaat-niet' })).status, 404);
    await kees.put(`/api/quotes/${savedQuote.id}`, { status: 'akkoord' });

    assert.strictEqual((await klaas.get('/api/workorders')).status, 403, 'klant ziet geen werkorders');
    assert.strictEqual((await klaas.post('/api/workorders', { quoteId: savedQuote.id })).status, 403);

    // Zonder data bouwt de server de werkorder zelf uit de offerte.
    const firstOrder = await kees.post('/api/workorders', { quoteId: savedQuote.id });
    assert.strictEqual(firstOrder.status, 201);
    const year = new Date().getFullYear();
    assert.strictEqual(firstOrder.body.number, `WO-${year}-0001`);
    assert.strictEqual(firstOrder.body.status, 'open');
    assert.strictEqual(firstOrder.body.quoteId, savedQuote.id);
    assert.strictEqual(firstOrder.body.customer, 'Fam. Jansen');
    assert.strictEqual(firstOrder.body.address, 'Dorpsstraat 1, Nunspeet');
    assert.strictEqual(firstOrder.body.data.quoteNumber, savedQuote.number);
    assert.strictEqual(firstOrder.body.data.materials.length, quote.data.lines.filter((line) => line.section === 'materiaal').length);

    // Met data uit de browser (zones); de koppeling komt altijd uit de offerte.
    const built = plain(WorkOrderCore.fromQuote(savedQuote, garden(), lib)).data;
    const secondOrder = await baas.post('/api/workorders', { quoteId: savedQuote.id, data: { ...built, quoteId: 'nep', quoteNumber: 'nep', plannedDate: `${year}-05-01` } });
    assert.strictEqual(secondOrder.body.number, `WO-${year}-0002`);
    assert.strictEqual(secondOrder.body.status, 'gepland', 'met datum meteen gepland');
    assert.strictEqual(secondOrder.body.data.quoteId, savedQuote.id);
    assert.strictEqual(secondOrder.body.data.quoteNumber, savedQuote.number);
    assert.ok(secondOrder.body.data.zones.length >= 2);

    assert.deepStrictEqual((await kees.get(`/api/workorders?quote=${savedQuote.id}`)).body.items.map((workOrder) => workOrder.number).sort(), [firstOrder.body.number, secondOrder.body.number]);

    // Toewijzen: alleen aan beheerders en installateurs.
    const staff = (await kees.get('/api/workorder-staff')).body.items;
    assert.deepStrictEqual(staff.map((user) => user.displayName), ['Baas', 'Kees']);
    const keesId = staff.find((user) => user.displayName === 'Kees').id;
    const klaasId = (await klaas.get('/api/me')).body.user.id;
    assert.strictEqual((await kees.put(`/api/workorders/${firstOrder.body.id}`, { assigneeId: klaasId })).status, 400);
    const steps = firstOrder.body.data.steps.map((step, i) => ({ ...step, done: i === 0, actualHours: i === 0 ? 0.5 : null }));
    const updated = await kees.put(`/api/workorders/${firstOrder.body.id}`, { assigneeId: keesId, status: 'bezig', data: { ...firstOrder.body.data, steps, quoteId: 'nep' } });
    assert.strictEqual(updated.status, 200);
    assert.strictEqual(updated.body.assignee.displayName, 'Kees');
    assert.strictEqual(updated.body.status, 'bezig');
    assert.strictEqual(updated.body.progress.done, 1);
    assert.strictEqual(updated.body.progress.actualHours, 0.5);
    assert.strictEqual(updated.body.data.quoteId, savedQuote.id, 'koppeling ligt vast');
    assert.strictEqual((await kees.put(`/api/workorders/${firstOrder.body.id}`, { status: 'weg' })).status, 400);

    // Verwijderen; definitief wissen alleen door een beheerder.
    assert.strictEqual((await kees.del(`/api/workorders/${firstOrder.body.id}`)).status, 200);
    assert.strictEqual((await kees.get(`/api/workorders/${firstOrder.body.id}`)).status, 404);
    assert.strictEqual((await kees.del(`/api/admin/workorders/${secondOrder.body.id}`)).status, 403);
    assert.strictEqual((await baas.del(`/api/admin/workorders/${secondOrder.body.id}`)).status, 200);
    const thirdOrder = await kees.post('/api/workorders', { quoteId: savedQuote.id });
    assert.strictEqual(thirdOrder.body.number, `WO-${year}-0002`, 'na definitief wissen telt alleen het hoogste bestaande nummer');
  } finally {
    server.close();
  }
});

test('API: inplannen en klantlink: de klant ziet de afspraak en bevestigt of vraagt een ander moment', async () => {
  const sent = [];
  /**
   * Mailer die niets verstuurt maar elk bericht bewaart.
   * @returns {object} De mailer.
   */
  const mailerFor = () => ({ configured: () => true, send: async (message) => { sent.push(message); } });
  const { server, base, as } = await setup({ mailerFor });
  try {
    const kees = await as('kees'), klaas = await as('klaas'), baas = await as('baas');
    assert.strictEqual((await baas.put('/api/quote-profile', { profile: { email: 'info@example.com' } })).status, 200);
    const quote = quoteFromGarden();
    const savedQuote = (await kees.post('/api/quotes', { data: { ...quote.data, customer: { ...quote.data.customer, email: 'jansen@example.com' } } })).body;
    await kees.put(`/api/quotes/${savedQuote.id}`, { status: 'akkoord' });
    const wo = (await kees.post('/api/workorders', { quoteId: savedQuote.id })).body;
    assert.strictEqual(wo.appointment.state, 'geen');
    const page = `${base}/openbaar/afspraak.html`;

    // Zonder datum geen afspraak om te versturen.
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/send`, { to: 'jansen@example.com', url: page })).status, 409);

    // Inplannen vanuit de planning: datum + uitvoerder, status gaat naar Gepland.
    const keesId = (await kees.get('/api/me')).body.user.id;
    /**
     * Datum een aantal dagen vanaf vandaag.
     * @param {number} days Aantal dagen.
     * @returns {string} JJJJ-MM-DD.
     */
    const future = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/schedule`, { plannedDate: 'morgen' })).status, 400);
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/schedule`, { days: 0 })).status, 400);
    assert.strictEqual((await klaas.post(`/api/workorders/${wo.id}/schedule`, { plannedDate: future(10) })).status, 403);
    let scheduled = await kees.post(`/api/workorders/${wo.id}/schedule`, { plannedDate: future(10), startTime: '08:00', endTime: '12:00', assigneeId: keesId });
    assert.strictEqual(scheduled.status, 200);
    assert.deepStrictEqual([scheduled.body.status, scheduled.body.plannedDate, scheduled.body.endTime, scheduled.body.assignee.displayName, scheduled.body.appointment.state], ['gepland', future(10), '12:00', 'Kees', 'niet_gedeeld']);
    assert.strictEqual(scheduled.body.data.title, wo.data.title, 'de rest van de werkorder blijft staan');

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
    for (const file of ['/openbaar/afspraak.html', '/openbaar/afspraak.js', '/openbaar/afspraak.css', '/werkorders/workorder-core.js']) {
      assert.strictEqual((await fetch(base + file)).status, 200, file);
    }
    assert.strictEqual((await fetch(`${base}/werkorders/werkorders.js`)).status, 401, 'de rest van de module niet');

    /**
     * Verzoek aan de openbare afspraak-API met het token in de kop.
     * @param {string} method GET (bekijken) of POST (reageren).
     * @param {string} urlPath Pad na /api/public/appointment.
     * @param {object} [body] JSON-body.
     * @param {string} [tokenValue] Token (standaard dat van de werkorder).
     * @returns {Promise<{ status: number, body: * }>} Status en JSON.
     */
    const publicRequest = (method, urlPath, body, tokenValue = token) => fetch(`${base}/api/public/appointment${urlPath}`, {
      method, headers: { 'X-Afspraak-Token': tokenValue, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert.strictEqual((await publicRequest('GET', '', null, 'x'.repeat(32))).status, 404);
    let appointment = await publicRequest('GET', '');
    assert.strictEqual(appointment.status, 200);
    assert.deepStrictEqual([appointment.body.appointment.number, appointment.body.appointment.plannedDate, appointment.body.appointment.startTime, appointment.body.appointment.appointment.state], [wo.number, future(10), '08:00', 'wacht']);
    assert.strictEqual(appointment.body.appointment.steps, undefined, 'geen uitvoeringsplan voor de klant');
    assert.strictEqual(appointment.body.appointment.materials, undefined);
    assert.strictEqual(JSON.stringify(appointment.body).includes('Kees'), false, 'geen namen van medewerkers');
    assert.ok((await kees.get(`/api/workorders/${wo.id}`)).body.share.viewedAt, 'geopend wordt bijgehouden');

    // Reageren: naam verplicht, bij een ander moment ook een toelichting.
    assert.strictEqual((await publicRequest('POST', '/respond', { answer: 'bevestigd', name: '' })).status, 400);
    assert.strictEqual((await publicRequest('POST', '/respond', { answer: 'ander_moment', name: 'Jan Jansen' })).status, 400);
    assert.strictEqual((await publicRequest('POST', '/respond', { answer: 'misschien', name: 'Jan Jansen' })).status, 400);
    const r1 = await publicRequest('POST', '/respond', { answer: 'ander_moment', name: 'Jan Jansen', reason: 'Liever de week erna.' });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.body.appointment.appointment.state, 'ander_moment');
    assert.strictEqual((await publicRequest('POST', '/respond', { answer: 'bevestigd', name: 'Jan Jansen' })).status, 409, 'één reactie per moment');
    assert.ok(sent.some((message) => /ander moment/.test(message.subject)), 'bericht naar het bedrijf');
    const view = (await kees.get(`/api/workorders/${wo.id}`)).body;
    assert.deepStrictEqual([view.appointment.state, view.appointment.response.reason], ['ander_moment', 'Liever de week erna.']);

    // Verschuiven: de klant moet het nieuwe moment opnieuw bevestigen.
    scheduled = await kees.post(`/api/workorders/${wo.id}/schedule`, { plannedDate: future(17), days: 2 });
    assert.strictEqual(scheduled.body.appointment.state, 'wacht');
    assert.strictEqual(scheduled.body.appointment.response.current, false);
    const r2 = await publicRequest('POST', '/respond', { answer: 'bevestigd', name: 'Jan Jansen' });
    assert.strictEqual(r2.status, 200);
    assert.deepStrictEqual(r2.body.appointment.dates.length, 2);
    assert.strictEqual((await kees.get('/api/workorders')).body.items[0].appointment.state, 'bevestigd');
    // Alleen de tijd veranderen is ook een ander moment.
    scheduled = await kees.post(`/api/workorders/${wo.id}/schedule`, { startTime: '09:00' });
    assert.strictEqual(scheduled.body.appointment.state, 'wacht');
    await kees.post(`/api/workorders/${wo.id}/schedule`, { startTime: '08:00' });
    assert.strictEqual((await kees.get(`/api/workorders/${wo.id}`)).body.appointment.state, 'bevestigd', 'terug naar het bevestigde moment');

    // Geannuleerd: niet meer te bevestigen; uit de planning = terug naar Nieuw.
    await kees.put(`/api/workorders/${wo.id}`, { status: 'geannuleerd' });
    await kees.post(`/api/workorders/${wo.id}/schedule`, { startTime: '10:00' });
    assert.strictEqual((await publicRequest('POST', '/respond', { answer: 'bevestigd', name: 'Jan Jansen' })).status, 409);
    await kees.put(`/api/workorders/${wo.id}`, { status: 'gepland' });
    scheduled = await kees.post(`/api/workorders/${wo.id}/schedule`, { plannedDate: '' });
    assert.deepStrictEqual([scheduled.body.status, scheduled.body.appointment.state], ['open', 'geen']);

    // Ingetrokken link: niets meer te zien.
    assert.strictEqual((await publicRequest('GET', '')).status, 200);
    assert.strictEqual((await kees.del(`/api/workorders/${wo.id}/share`)).status, 200);
    assert.strictEqual((await publicRequest('GET', '')).status, 404);
  } finally {
    server.close();
  }
});

test('API: startscherm (my-day): klussen van de dag per uitvoerder, meerdaagse klussen per werkdag', async () => {
  const { server, base, as } = await setup();
  try {
    const kees = await as('kees'), baas = await as('baas'), klaas = await as('klaas');
    const quote = quoteFromGarden();
    const savedQuote = (await kees.post('/api/quotes', { data: { ...quote.data, customer: { ...quote.data.customer, phone: '06 12345678', contact: 'Jan Jansen' } } })).body;
    await kees.put(`/api/quotes/${savedQuote.id}`, { status: 'akkoord' });
    /**
     * Maakt een werkorder uit de geaccordeerde offerte.
     * @returns {Promise<object>} De werkorder.
     */
    const createWorkOrder = async () => (await kees.post('/api/workorders', { quoteId: savedQuote.id })).body;
    const keesId = (await kees.get('/api/me')).body.user.id;
    const baasId = (await baas.get('/api/me')).body.user.id;
    const [orderA, orderB, orderC, orderD] = [await createWorkOrder(), await createWorkOrder(), await createWorkOrder(), await createWorkOrder()];
    // Vrijdag 11 jan 2030, 2 werkdagen: vrijdag en maandag 14 jan.
    await kees.post(`/api/workorders/${orderA.id}/schedule`, { plannedDate: '2030-01-11', startTime: '10:00', endTime: '16:00', days: 2, assigneeId: keesId });
    await kees.post(`/api/workorders/${orderB.id}/schedule`, { plannedDate: '2030-01-14', startTime: '08:00', assigneeId: keesId });
    await kees.post(`/api/workorders/${orderC.id}/schedule`, { plannedDate: '2030-01-14', startTime: '09:00', assigneeId: baasId });
    await kees.post(`/api/workorders/${orderD.id}/schedule`, { plannedDate: '2030-01-21', assigneeId: keesId });

    assert.strictEqual((await klaas.get('/api/my-day')).status, 403, 'klant heeft geen startscherm');
    assert.strictEqual((await kees.get('/api/my-day?date=morgen')).status, 400);
    const now = (await kees.get('/api/my-day')).body;
    assert.match(now.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(now.date, now.today, 'zonder datum: vandaag');

    let day = (await kees.get('/api/my-day?date=2030-01-14')).body;
    assert.deepStrictEqual(day.items.map((item) => item.number), [orderB.number, orderA.number], 'op starttijd');
    const second = day.items.find((item) => item.id === orderA.id);
    assert.strictEqual(second.dayNumber, 2);
    assert.strictEqual(second.totalDays, 2);
    assert.strictEqual(second.phone, '06 12345678');
    assert.strictEqual(second.contact, 'Jan Jansen');
    assert.strictEqual(second.address, 'Dorpsstraat 1, Nunspeet');
    assert.strictEqual(second.photos, 0);
    assert.strictEqual(day.next.id, orderD.id, 'eerstvolgende klus na deze dag');

    assert.deepStrictEqual((await kees.get('/api/my-day?date=2030-01-12')).body.items, [], 'zaterdag telt niet als werkdag');
    day = (await kees.get('/api/my-day?date=2030-01-14&all=1')).body;
    assert.deepStrictEqual(day.items.map((item) => item.number), [orderB.number, orderC.number, orderA.number], 'hele ploeg, op starttijd');
    assert.strictEqual(day.next, null);
    assert.deepStrictEqual((await baas.get('/api/my-day?date=2030-01-14')).body.items.map((item) => item.id), [orderC.id]);

    // Geannuleerd valt weg.
    await kees.put(`/api/workorders/${orderB.id}`, { status: 'geannuleerd' });
    assert.deepStrictEqual((await kees.get('/api/my-day?date=2030-01-14')).body.items.map((item) => item.id), [orderA.id]);
  } finally {
    server.close();
  }
});
