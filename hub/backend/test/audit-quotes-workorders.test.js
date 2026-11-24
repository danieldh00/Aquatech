// Auditthema offertes en werkorders: profiel en eigenaar naar klanten (B-24, B-25), offertebedragen in dossiers (B-23),
// planning via het gewone opslaan van een werkorder (B-32), sjablonen boven 16 kB (T-12) en een mislukte mail (T-13).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createClient, createLogin, listen } = require('./helpers/http-client');
const { createPdokFake } = require('./helpers/pdok-fake');
const { scopeKey } = require('../src/database/tenant-scope');

const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, installateur, planner, een rol zonder planning en een klant, plus een app.
 * @param {object} [options] mailerFor voor een eigen mailer.
 * @returns {Promise<object>} base, as (inloggen), customerId en de verzonden mails.
 */
async function setup({ mailerFor } = {}) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  const role = store.roles.create(main, { label: 'Alleen werkorders', rights: ['werkorders'] });
  assert.ok(!role.error, JSON.stringify(role));
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'planner1', displayName: 'Planner', role: 'planner', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'uitvoerder', displayName: 'Uitvoerder', role: role.role.key, password: PW }, { mustChangePassword: false });
  const customer = await store.createAccount(main, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { APP_PUBLIC_URL: 'https://aquatech.example/' }, secret: 'e'.repeat(64), db, addressFetch: createPdokFake().fetchImpl, loginDelayMs: 0, ...(mailerFor ? { mailerFor } : {}) }));
  servers.push(server);
  return { base, as: createLogin(base, { password: PW }), customerId: customer.id || customer.user.id };
}

/**
 * Offertegegevens met een klant.
 * @returns {object} De gegevens voor POST /api/quotes.
 */
const quoteData = () => ({ title: 'Beregening', customer: { name: 'Fam. Jansen', email: 'jansen@klant.test' },
  lines: [{ id: 'r1', section: 'materiaal', description: 'Sproeier', qty: 4, unit: 'st', price: 10, vat: 21 }] });

test('B-24 en B-25: klant en openbare link krijgen alleen documentgegevens en geen eigenaar; medewerkers houden alles', async () => {
  const { base, as, customerId } = await setup();
  const baas = await as('baas'), monteur = await as('monteur'), klaas = await as('klaas');
  assert.strictEqual((await baas.put('/app/api/quote-profile', { profile: { companyName: 'AquaTech', markupPct: 35, hourlyRate: 77, callOutFee: 45, email: 'info@aquatech.test', iban: 'NL00TEST0123456789' } })).status, 200);
  const quote = (await monteur.post('/app/api/quotes', { data: quoteData(), customerId })).body;
  assert.ok((await monteur.get('/app/api/quotes')).body.items[0].owner, 'medewerker ziet de eigenaar');
  assert.strictEqual((await monteur.get('/app/api/quote-profile')).body.profile.hourlyRate, 77, 'medewerker houdt het uurtarief');
  const shared = (await monteur.post(`/app/api/quotes/${quote.id}/share`, { url: `${base}/app/openbaar/offerte.html` })).body;
  const token = shared.share.url.split('#t=')[1];

  const profile = (await klaas.get('/app/api/quote-profile')).body.profile;
  assert.strictEqual(profile.companyName, 'AquaTech');
  assert.strictEqual(profile.iban, 'NL00TEST0123456789');
  for (const field of ['markupPct', 'hourlyRate', 'hourlyCost', 'callOutFee', 'terms', 'intro']) assert.strictEqual(profile[field], undefined, `${field} niet naar de klant`);
  const list = (await klaas.get('/app/api/quotes')).body.items;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].owner, undefined, 'geen inlognaam van de medewerker in de lijst');
  assert.strictEqual((await klaas.get(`/app/api/quotes/${quote.id}`)).body.owner, undefined);
  assert.strictEqual(JSON.stringify((await klaas.get('/app/api/portal')).body).includes('monteur'), false, 'ook niet in het portaal');

  const open = await fetch(`${base}/app/api/public/quote`, { headers: { 'X-Offerte-Token': token } });
  const body = await open.json();
  assert.strictEqual(open.status, 200);
  for (const field of ['markupPct', 'hourlyRate', 'hourlyCost', 'callOutFee']) assert.strictEqual(body.profile[field], undefined, `${field} niet via de openbare link`);
  assert.strictEqual(body.profile.companyName, 'AquaTech');
});

test('B-23: dossiers tonen offertes met totaal alleen met het recht offertes', async () => {
  const { as, customerId } = await setup();
  const monteur = await as('monteur'), planner = await as('planner1');
  const quote = (await monteur.post('/app/api/quotes', { data: quoteData(), customerId })).body;
  await monteur.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' });
  // Het akkoord heeft automatisch een werkorder klaargezet (V-01).
  const workOrder = (await monteur.get('/app/api/workorders')).body.items[0];
  assert.ok(workOrder.id);
  const withRight = (await monteur.get(`/app/api/dossiers/a-${customerId}`)).body;
  assert.strictEqual(withRight.quotes.length, 1);
  assert.ok(withRight.quotes[0].totalIncl > 0);
  const without = await planner.get(`/app/api/dossiers/a-${customerId}`);
  assert.strictEqual(without.status, 200);
  assert.deepStrictEqual(without.body.quotes, [], 'planner ziet geen offertes of totalen');
  assert.strictEqual(without.body.installations.length, 1, 'de installaties blijven zichtbaar');
  const locationKey = (await monteur.get('/app/api/locations')).body.items[0]?.key;
  if (locationKey) {
    assert.ok((await monteur.get(`/app/api/locations/${locationKey}`)).body.quotes.every((item) => item.totalIncl !== undefined));
    assert.deepStrictEqual((await planner.get(`/app/api/locations/${locationKey}`)).body.quotes, []);
  }
});

test('B-32: zonder het recht planning verplaatst het gewone opslaan geen afspraak en wijzigt de uitvoerder niet', async () => {
  const { as, customerId } = await setup();
  const monteur = await as('monteur'), uitvoerder = await as('uitvoerder');
  const quote = (await monteur.post('/app/api/quotes', { data: quoteData(), customerId })).body;
  await monteur.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' });
  const workOrder = (await monteur.post('/app/api/workorders', { quoteId: quote.id })).body;
  const monteurId = (await monteur.get('/app/api/me')).body.user.id;
  assert.strictEqual((await monteur.post(`/app/api/workorders/${workOrder.id}/schedule`, { plannedDate: '2031-05-01', startTime: '08:00', endTime: '12:00', assigneeId: monteurId })).status, 200);
  const current = (await uitvoerder.get(`/app/api/workorders/${workOrder.id}`)).body;
  const moved = await uitvoerder.put(`/app/api/workorders/${workOrder.id}`, { data: { ...current.data, plannedDate: '2031-06-09', startTime: '13:00', endTime: '17:00', days: 3, instructions: 'Bijgewerkt' }, assigneeId: null });
  assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
  assert.strictEqual(moved.body.data.plannedDate, '2031-05-01');
  assert.strictEqual(moved.body.data.startTime, '08:00');
  assert.strictEqual(moved.body.assigneeId, monteurId, 'uitvoerder blijft zoals hij was');
  assert.strictEqual(moved.body.data.instructions, 'Bijgewerkt', 'de rest wordt wel opgeslagen');
  // Met het recht planning kan het gewone opslaan het nog wel.
  const again = await monteur.put(`/app/api/workorders/${workOrder.id}`, { data: { ...current.data, plannedDate: '2031-06-09' } });
  assert.strictEqual(again.body.data.plannedDate, '2031-06-09');
});

test('T-12: een offertesjabloon van meer dan 16 kB wordt bewaard', async () => {
  const { as } = await setup();
  const baas = await as('baas');
  const lines = Array.from({ length: 60 }, (_, index) => ({ description: `Regel ${index} ${'x'.repeat(200)}`, qty: 1, price: 10, vat: 21 }));
  const template = { name: 'Groot sjabloon', intro: 'i'.repeat(4000), terms: 't'.repeat(6000), lines };
  assert.ok(JSON.stringify({ template }).length > 17000);
  const saved = await baas.put('/app/api/quote-templates', { template });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.strictEqual(saved.body.template.lines.length, 60);
});

test('T-13: een mislukte mail laat de offerte een concept en trekt de afspraaklink in', async () => {
  /**
   * Mailer waarvan elke verzending mislukt.
   * @returns {object} De mailer.
   */
  const mailerFor = () => ({ configured: () => true, send: async () => { throw new Error('smtp weg'); } });
  const { base, as, customerId } = await setup({ mailerFor });
  const monteur = await as('monteur');
  const quote = (await monteur.post('/app/api/quotes', { data: quoteData(), customerId })).body;
  const failed = await monteur.post(`/app/api/quotes/${quote.id}/send`, { to: 'jansen@klant.test', url: `${base}/app/openbaar/offerte.html` });
  assert.strictEqual(failed.status, 502);
  const after = (await monteur.get(`/app/api/quotes/${quote.id}`)).body;
  assert.strictEqual(after.status, 'concept', 'terug naar concept');
  assert.strictEqual(after.share.active, false, 'geen actieve link zonder verzonden mail');

  await monteur.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' });
  const workOrder = (await monteur.post('/app/api/workorders', { quoteId: quote.id })).body;
  await monteur.post(`/app/api/workorders/${workOrder.id}/schedule`, { plannedDate: '2031-05-01' });
  const page = await monteur.post(`/app/api/workorders/${workOrder.id}/send`, { to: 'jansen@klant.test', url: `${base}/app/openbaar/afspraak.html` });
  assert.strictEqual(page.status, 502);
  assert.strictEqual((await monteur.get(`/app/api/workorders/${workOrder.id}`)).body.share.active, false, 'link ingetrokken');
});

test('B-12: de openbare offerte- en afspraaklinks en hun antwoorden draaien binnen de organisatie van de gevonden rij', async () => {
  const sent = [];
  /**
   * Mailer die niets verstuurt maar elk bericht bewaart.
   * @returns {object} De mailer.
   */
  const mailerFor = () => ({ configured: () => true, send: async (message) => { sent.push(message); } });
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  const customer = await store.createAccount(main, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { APP_PUBLIC_URL: 'https://aquatech.example/' }, secret: 'e'.repeat(64), db, addressFetch: createPdokFake().fetchImpl, loginDelayMs: 0, mailerFor }));
  servers.push(server);
  const monteur = await createLogin(base, { password: PW })('monteur');
  const quote = (await monteur.post('/app/api/quotes', { data: quoteData(), customerId: customer.id || customer.user.id })).body;
  const openQuote = (await monteur.post('/app/api/quotes', { data: quoteData(), customerId: customer.id || customer.user.id })).body;
  const quoteToken = (await monteur.post(`/app/api/quotes/${openQuote.id}/share`, { url: `${base}/app/openbaar/offerte.html` })).body.share.url.split('#t=')[1];
  await monteur.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' });
  const workOrder = (await monteur.post('/app/api/workorders', { quoteId: quote.id })).body;
  await monteur.post(`/app/api/workorders/${workOrder.id}/schedule`, { plannedDate: '2031-05-01' });
  const appointmentToken = (await monteur.post(`/app/api/workorders/${workOrder.id}/share`, { url: `${base}/app/openbaar/afspraak.html` })).body.share.url.split('#t=')[1];

  const keys = [];
  const queries = [];
  const originalPrepare = db.prepare.bind(db);
  /**
   * Onthoudt de scope waarmee elke query wordt voorbereid, en geeft de query door.
   * @param {string} sql De query.
   * @returns {object} Het voorbereide statement.
   */
  db.prepare = (sql) => { keys.push(scopeKey()); queries.push({ sql: String(sql).trim(), key: scopeKey() }); return originalPrepare(sql); };
  try {
    const expected = store.familyIds(main).join(',');
    /**
     * Doet een openbaar verzoek en geeft de scope waarmee de laatste query liep.
     * @param {string} urlPath Pad onder /app/api/public.
     * @param {string} header Naam van de tokenkop.
     * @param {string} token Het token.
     * @param {object} [body] JSON-body (dan een POST).
     * @returns {Promise<{ status: number, key: string }>} Status en scope van de laatste query.
     */
    const call = async (urlPath, header, token, body) => {
      keys.length = 0;
      queries.length = 0;
      const res = await fetch(`${base}/app/api/public/${urlPath}`, { method: body ? 'POST' : 'GET', headers: { [header]: token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, key: keys[keys.length - 1], keys: [...new Set(keys)] };
    };
    /**
     * De scopes van alle schrijfopdrachten (UPDATE/INSERT) van het laatste verzoek.
     * @returns {string[]} De scopes, zonder dubbelen.
     */
    const writeScopes = () => [...new Set(queries.filter((query) => /^(UPDATE|INSERT)/i.test(query.sql)).map((query) => query.key))];
    const quoteView = await call('quote', 'X-Offerte-Token', quoteToken);
    assert.deepStrictEqual([quoteView.status, quoteView.key], [200, expected]);
    const quoteAnswer = await call('quote/respond', 'X-Offerte-Token', quoteToken, { answer: 'afgewezen', reason: 'test' });
    assert.strictEqual(quoteAnswer.status, 200);
    assert.ok(queries.some((query) => /^UPDATE quotes/i.test(query.sql)), 'het akkoord is opgeslagen');
    assert.deepStrictEqual(queries.filter((query) => /^UPDATE quotes/i.test(query.sql)).map((query) => query.key), queries.filter((query) => /^UPDATE quotes/i.test(query.sql)).map(() => expected), 'het antwoord op de offerte schrijft binnen de organisatie');
    const appointmentView = await call('appointment', 'X-Afspraak-Token', appointmentToken);
    assert.deepStrictEqual([appointmentView.status, appointmentView.key], [200, expected]);
    const appointmentAnswer = await call('appointment/respond', 'X-Afspraak-Token', appointmentToken, { answer: 'bevestigd', name: 'Klaas Jansen' });
    assert.strictEqual(appointmentAnswer.status, 200);
    assert.ok(writeScopes().length > 0);
    assert.ok(queries.filter((query) => /^UPDATE work_orders/i.test(query.sql)).every((query) => query.key === expected), 'het antwoord op de afspraak schrijft binnen de organisatie');
    // Een onbekend token geeft 404 en laat niets van een andere organisatie zien.
    assert.strictEqual((await call('quote', 'X-Offerte-Token', 'x'.repeat(32))).status, 404);
    assert.strictEqual((await call('appointment', 'X-Afspraak-Token', 'x'.repeat(32))).status, 404);
  } finally {
    db.prepare = originalPrepare;
  }
});
