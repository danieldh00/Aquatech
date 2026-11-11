// Interne notitie per offerte: bewaard en getoond voor medewerkers, nooit voor de klant (portaal, openbare link, document),
// en overgenomen naar de werkorder (alleen medewerkers).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createClient, createLogin, listen } = require('./helpers/http-client');
const { createPdokFake } = require('./helpers/pdok-fake');

const QuoteCore = require(path.join(__dirname, '..', '..', 'frontend', 'offertes', 'quote-core.js'));
const WorkOrderCore = require(path.join(__dirname, '..', '..', 'frontend', 'werkorders', 'workorder-core.js'));
const PW = 'Tuin-Plan-2026!';
const NOTE = 'Klant wil korting als de gevel klaar is - NIET delen';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met een installateur en een klant, plus een app en het inloggen.
 * @returns {Promise<object>} base, as (inloggen), installer, customer en customerId.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  const customerAccount = await store.createAccount(main, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ secret: 'e'.repeat(64), db, addressFetch: createPdokFake().fetchImpl, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  return { base, as, installer: await as('monteur'), customer: await as('klaas'), customerId: customerAccount.id || customerAccount.user.id };
}

/**
 * Offertegegevens met interne notitie.
 * @param {object} [extra] Aanvullende velden.
 * @returns {object} De gegevens voor POST /api/quotes.
 */
function quoteData(extra = {}) {
  return { title: 'Beregening', customer: { name: 'Fam. Jansen', email: 'jansen@klant.test' }, internalNote: NOTE,
    lines: [{ id: 'r1', section: 'materiaal', description: 'Sproeier', qty: 4, unit: 'st', price: 10, vat: 21 }, { id: 'r2', section: 'arbeid', description: 'Montage', qty: 1, unit: 'uur', price: 60, vat: 21 }], ...extra };
}

test('de kern: de notitie wordt opgeschoond en begrensd', () => {
  assert.strictEqual(QuoteCore.sanitize({}).internalNote, '');
  assert.strictEqual(QuoteCore.sanitize({ internalNote: NOTE }).internalNote, NOTE);
  assert.strictEqual(QuoteCore.sanitize({ internalNote: 'x'.repeat(5000) }).internalNote.length, 2000);
  assert.strictEqual(WorkOrderCore.fromQuote({ data: { internalNote: NOTE, lines: [] } }).data.internalNote, NOTE);
  assert.strictEqual(WorkOrderCore.fromQuote({ data: { lines: [] } }).data.internalNote, '');
});

test('medewerker bewaart en leest de notitie; de klant ziet hem nergens', async () => {
  const { base, installer, customer, customerId } = await setup();
  const quote = (await installer.post('/app/api/quotes', { data: quoteData(), customerId })).body;
  assert.strictEqual(quote.data.internalNote, NOTE);
  assert.strictEqual((await installer.get(`/app/api/quotes/${quote.id}`)).body.data.internalNote, NOTE);
  // Aanpassen en leegmaken.
  const changed = (await installer.put(`/app/api/quotes/${quote.id}`, { data: { ...quote.data, internalNote: 'Nieuwe notitie' } })).body;
  assert.strictEqual(changed.data.internalNote, 'Nieuwe notitie');
  const restored = (await installer.put(`/app/api/quotes/${quote.id}`, { data: { ...quote.data, internalNote: NOTE } })).body;
  assert.strictEqual(restored.data.internalNote, NOTE);
  // De klant (portaal): pas zichtbaar als de offerte verzonden is, en dan zonder notitie.
  assert.strictEqual((await installer.put(`/app/api/quotes/${quote.id}`, { status: 'verzonden' })).status, 200);
  const portal = await customer.get('/app/api/portal');
  assert.strictEqual(portal.status, 200);
  assert.strictEqual(portal.body.quotes.length, 1, 'de klant ziet de verzonden offerte');
  assert.ok(!JSON.stringify(portal.body).includes(NOTE), 'portaal zonder notitie');
  const own = await customer.get(`/app/api/quotes/${quote.id}`);
  if (own.status === 200) assert.ok(!JSON.stringify(own.body).includes(NOTE), 'eigen offerte zonder notitie');
  // De openbare link.
  const token = (await installer.post(`/app/api/quotes/${quote.id}/share`, { url: 'https://aquatech.example/pad/openbaar/offerte.html' })).body.share.url.split('#t=')[1];
  const publicQuote = await fetch(`${base}/app/api/public/quote`, { headers: { 'X-Offerte-Token': token } });
  assert.strictEqual(publicQuote.status, 200);
  assert.ok(!(await publicQuote.text()).includes(NOTE), 'openbare offerte zonder notitie');
  // Zonder inloggen kan niemand de offerte lezen.
  assert.notStrictEqual((await createClient(base).get(`/app/api/quotes/${quote.id}`)).status, 200);
});

test('werkorder uit de offerte neemt de notitie over; de klant ziet hem daar niet', async () => {
  const { installer, customer, customerId } = await setup();
  const quote = (await installer.post('/app/api/quotes', { data: quoteData(), customerId })).body;
  assert.strictEqual((await installer.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' })).status, 200);
  const workOrder = (await installer.post('/app/api/workorders', { quoteId: quote.id })).body;
  assert.strictEqual(workOrder.data.internalNote, NOTE);
  // Aanpasbaar in de werkorder; de offerte zelf blijft zoals hij was.
  const updated = (await installer.put(`/app/api/workorders/${workOrder.id}`, { data: { ...workOrder.data, internalNote: 'Alleen voor de ploeg' } })).body;
  assert.strictEqual(updated.data.internalNote, 'Alleen voor de ploeg');
  assert.strictEqual((await installer.get(`/app/api/quotes/${quote.id}`)).body.data.internalNote, NOTE);
  // Klantportaal: lijst en detail zonder notitie.
  const portal = await customer.get('/app/api/portal');
  assert.ok(!JSON.stringify(portal.body).includes('Alleen voor de ploeg') && !JSON.stringify(portal.body).includes(NOTE));
  const detail = await customer.get(`/app/api/portal/workorders/${workOrder.id}`);
  assert.strictEqual(detail.status, 200);
  assert.ok(!JSON.stringify(detail.body).includes('Alleen voor de ploeg') && !JSON.stringify(detail.body).includes(NOTE));
});
