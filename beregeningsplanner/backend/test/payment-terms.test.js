// Betaaltermijn per klant: opslaan op de klantkaart, invullen op de offerte (klant of standaard), vastleggen bij het
// akkoord en doorgeven aan de vervaldatum van de factuur.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, listen } = require('./helpers/http-client');
const { createPdokFake } = require('./helpers/pdok-fake');
const { signaturePng } = require('../src/platform/test-data');

const QuoteCore = require(path.join(__dirname, '..', '..', 'frontend', 'offertes', 'quote-core.js'));
const InvoiceCore = require(path.join(__dirname, '..', '..', 'frontend', 'facturen', 'invoice-core.js'));
const SECRET = 'p'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, installateur en een testserver.
 * @returns {Promise<object>} db, store, main, as (inloggen), admin en installer.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, addressFetch: createPdokFake().fetchImpl, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  return { db, store, main, as, admin: await as('baas'), installer: await as('monteur') };
}

/**
 * Een offerte-inhoud met één regel.
 * @param {object} [extra] Extra velden (bijvoorbeeld paymentDays).
 * @returns {object} De offertegegevens.
 */
const quoteData = (extra = {}) => ({ title: 'Aanleg', customer: { name: 'Fam. Jansen' }, lines: [{ section: 'materiaal', description: 'PE-buis', qty: 10, unit: 'm', price: 2, vat: 21 }], ...extra });

test('Kern: betaaltermijn van de offerte is een heel aantal dagen of leeg', () => {
  assert.strictEqual(QuoteCore.sanitizePaymentDays(30), 30);
  assert.strictEqual(QuoteCore.sanitizePaymentDays('14'), 14);
  assert.strictEqual(QuoteCore.sanitizePaymentDays(0), 0);
  assert.strictEqual(QuoteCore.sanitizePaymentDays(''), null);
  assert.strictEqual(QuoteCore.sanitizePaymentDays(null), null);
  assert.strictEqual(QuoteCore.sanitizePaymentDays('abc'), null);
  assert.strictEqual(QuoteCore.sanitizePaymentDays(9999), 365);
  assert.strictEqual(QuoteCore.sanitizePaymentDays(-5), 0);
  assert.strictEqual(QuoteCore.sanitize({}).paymentDays, null);
  assert.strictEqual(QuoteCore.sanitize({ paymentDays: 21 }).paymentDays, 21);
});

test('Kern: een factuur met eigen betaaltermijn krijgt daar de vervaldatum en de tekst van', () => {
  const settings = InvoiceCore.sanitizeSettings({ paymentDays: 14 });
  assert.strictEqual(InvoiceCore.sanitize({ date: '2026-10-01' }, settings).dueDate, '2026-10-15');
  const own = InvoiceCore.sanitize({ date: '2026-10-01', paymentDays: 30 }, settings);
  assert.strictEqual(own.dueDate, '2026-10-31');
  assert.strictEqual(own.paymentDays, 30);
  assert.strictEqual(InvoiceCore.sanitize({ date: '2026-10-01', paymentDays: 0 }, settings).dueDate, '2026-10-01');
  assert.strictEqual(InvoiceCore.sanitize({ date: '2026-10-01', paymentDays: 'x' }, settings).paymentDays, null);
  assert.match(InvoiceCore.paymentText(settings, { number: 'F1', days: 30 }), /30 dagen/);
  assert.match(InvoiceCore.paymentText(settings, { number: 'F1' }), /14 dagen/);
});

test('klantkaart: betaaltermijn opslaan, leegmaken en afkeuren; ook bij aanmaken', async () => {
  const { installer, db, main } = await setup();
  const made = await installer.post('/app/api/customers', { displayName: 'Jansen Tuinen', paymentDays: 30 });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.strictEqual(made.body.customer.paymentDays, 30);
  const id = made.body.customer.id;
  assert.strictEqual((await installer.post('/app/api/customers', { displayName: 'Zonder termijn' })).body.customer.paymentDays, null);
  assert.strictEqual((await installer.post('/app/api/customers', { displayName: 'Te lang', paymentDays: 400 })).status, 400);
  assert.strictEqual((await installer.post('/app/api/customers', { displayName: 'Halve dag', paymentDays: 2.5 })).status, 400);

  const changed = await installer.patch(`/app/api/customers/${id}`, { paymentDays: 45 });
  assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
  assert.strictEqual(changed.body.customer.paymentDays, 45);
  assert.strictEqual(db.prepare('SELECT payment_days FROM users WHERE tenant_id = ? AND id = ?').get(main, id).payment_days, 45);
  const bad = await installer.patch(`/app/api/customers/${id}`, { paymentDays: -1 });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await installer.patch(`/app/api/customers/${id}`, { paymentDays: 'veel' })).status, 400);
  assert.strictEqual((await installer.get(`/app/api/customers/${id}`)).body.customer.paymentDays, 45, 'een foute waarde verandert niets');
  assert.strictEqual((await installer.get(`/app/api/customers/${id}`)).body.defaultPaymentDays, 14);
  const cleared = await installer.patch(`/app/api/customers/${id}`, { paymentDays: '' });
  assert.strictEqual(cleared.body.customer.paymentDays, null);
  // 0 dagen (direct betalen) is een geldige termijn en iets anders dan leeg.
  assert.strictEqual((await installer.patch(`/app/api/customers/${id}`, { paymentDays: 0 })).body.customer.paymentDays, 0);
});

test('offerte: de klantkeuze geeft de termijn van de klant of de standaard, en een lege termijn wordt de standaard', async () => {
  const { installer, admin } = await setup();
  const own = (await installer.post('/app/api/customers', { displayName: 'Maandklant', paymentDays: 30 })).body.customer;
  await installer.post('/app/api/customers', { displayName: 'Standaardklant' });
  const found = (await installer.get('/app/api/quote-customers?q=klant')).body.items;
  assert.strictEqual(found.find((item) => item.displayName === 'Maandklant').paymentDays, 30);
  assert.strictEqual(found.find((item) => item.displayName === 'Standaardklant').paymentDays, 14, 'de standaard uit de factuurinstellingen');

  assert.strictEqual((await admin.put('/app/api/admin/settings', { invoicing: { paymentDays: 21 } })).status, 200);
  assert.strictEqual((await installer.get('/app/api/quote-customers?q=Standaardklant')).body.items[0].paymentDays, 21);

  const empty = await installer.post('/app/api/quotes', { data: quoteData(), customerId: own.id });
  assert.strictEqual(empty.status, 201, JSON.stringify(empty.body));
  assert.strictEqual(empty.body.data.paymentDays, 21, 'leeg wordt de standaard');
  const chosen = await installer.post('/app/api/quotes', { data: quoteData({ paymentDays: 30 }) });
  assert.strictEqual(chosen.body.data.paymentDays, 30);
  const zero = await installer.post('/app/api/quotes', { data: quoteData({ paymentDays: 0 }) });
  assert.strictEqual(zero.body.data.paymentDays, 0, '0 dagen blijft 0');
  // Opslaan zonder termijn (oude offerte of leeg veld) vult de standaard in; een gekozen termijn blijft staan.
  const saved = await installer.put(`/app/api/quotes/${chosen.body.id}`, { data: { ...chosen.body.data, paymentDays: '' } });
  assert.strictEqual(saved.body.data.paymentDays, 21);
  assert.strictEqual((await installer.put(`/app/api/quotes/${chosen.body.id}`, { status: 'verzonden' })).body.data.paymentDays, 21, 'alleen de status wijzigen laat de termijn staan');
});

test('akkoord legt de betaaltermijn vast en de factuur uit de werkorder krijgt die vervaldatum', async () => {
  const { installer, admin } = await setup();
  const quote = (await installer.post('/app/api/quotes', { data: quoteData({ paymentDays: 30 }) })).body;
  assert.strictEqual((await installer.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' })).status, 200);
  const workOrder = (await installer.post('/app/api/workorders', { quoteId: quote.id })).body;
  const invoice = (await admin.post('/app/api/invoices', { workOrderId: workOrder.id })).body;
  assert.strictEqual(invoice.data.paymentDays, 30);
  assert.strictEqual(invoice.data.dueDate, InvoiceCore.addDays(invoice.data.date, 30));
  // Een offerte zonder eigen termijn geeft de standaard van de organisatie (14 dagen).
  const plain = (await installer.post('/app/api/quotes', { data: quoteData() })).body;
  assert.strictEqual(plain.data.paymentDays, 14);
});

test('akkoord door de klant legt de betaaltermijn vast in het bewijs', async () => {
  const { installer, store, main, as } = await setup();
  await store.createAccount(main, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW }, { mustChangePassword: false });
  const klaas = await as('klaas');
  const customerId = (await klaas.get('/app/api/me')).body.user.id;
  const quote = (await installer.post('/app/api/quotes', { data: quoteData({ paymentDays: 21 }), customerId })).body;
  assert.strictEqual((await installer.put(`/app/api/quotes/${quote.id}`, { status: 'verzonden' })).status, 200);
  const accepted = await klaas.post(`/app/api/quotes/${quote.id}/respond`, { answer: 'akkoord', name: 'Klaas Jansen', terms: true, signature: signaturePng() });
  assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.body));
  assert.strictEqual(accepted.body.acceptance.paymentDays, 21);
  assert.strictEqual((await installer.get(`/app/api/quotes/${quote.id}`)).body.acceptance.paymentDays, 21);
  // Na het akkoord ligt de offerte vast: ook de termijn.
  assert.strictEqual((await installer.put(`/app/api/quotes/${quote.id}`, { data: { ...accepted.body.data, paymentDays: 60 } })).status, 409);
});
