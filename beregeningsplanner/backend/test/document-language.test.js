// Documenttaal per klant (Nederlands of Engels): de vertaaltabel, de klantkaart, de offerte (weergave, mail), de factuur
// (PDF en mail) en de rechten op de nieuwe velden.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const path = require('path');
const vm = require('node:vm');
const fs = require('fs');
const zlib = require('zlib');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, listen } = require('./helpers/http-client');
const { createPdokFake } = require('./helpers/pdok-fake');
const { invoicePdf } = require('../src/verkoop/invoice-pdf');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const DocText = require(path.join(FRONTEND, 'shared', 'doc-text.js'));
const QuoteCore = require(path.join(FRONTEND, 'offertes', 'quote-core.js'));
const InvoiceCore = require(path.join(FRONTEND, 'facturen', 'invoice-core.js'));
const SECRET = 'd'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, installateur, planner en een andere organisatie.
 * @returns {Promise<object>} as (inloggen), admin, installer en planner.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'planner1', displayName: 'Planner', role: 'planner', password: PW }, { mustChangePassword: false });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, addressFetch: createPdokFake().fetchImpl, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  return { as, admin: await as('baas'), installer: await as('monteur'), planner: await as('planner1') };
}

/**
 * Laadt de offerteweergave in een vm-sandbox (zoals de browser) en geeft QuoteView terug.
 * @returns {object} QuoteView.
 */
function loadQuoteView() {
  const sandbox = { QuoteCore, DocText };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'offertes', 'quote-view.js'), 'utf8'), sandbox);
  return sandbox.QuoteView;
}

/**
 * De tekst op de pagina's van een PDF (de samengedrukte inhoudsstromen worden uitgepakt).
 * @param {Buffer} buffer De PDF.
 * @returns {string} Alle tekst van de pagina's achter elkaar.
 */
function pdfText(buffer) {
  const raw = buffer.toString('latin1');
  let text = '';
  for (const match of raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    try { text += zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'); } catch { /* geen samengedrukte tekst */ }
  }
  return text;
}

/**
 * Een offerte-inhoud met één regel.
 * @param {object} [extra] Extra velden.
 * @returns {object} De offertegegevens.
 */
const quoteData = (extra = {}) => ({ title: 'Aanleg', customer: { name: 'Fam. Jansen' }, lines: [{ section: 'materiaal', description: 'PE-buis', qty: 10, unit: 'm', price: 2.5, vat: 21 }], ...extra });

test('vertaaltabel: elke sleutel in beide talen, onbekende taal valt terug op Nederlands, waarden worden ingevuld', () => {
  assert.deepStrictEqual(Object.keys(DocText.TEXTS.en).sort(), Object.keys(DocText.TEXTS.nl).sort(), 'beide talen hebben dezelfde sleutels');
  assert.strictEqual(DocText.clean('EN'), 'en');
  assert.strictEqual(DocText.clean('fr'), 'nl');
  assert.strictEqual(DocText.clean(undefined), 'nl');
  assert.strictEqual(DocText.text('en', 'quote.title'), 'Quotation');
  assert.strictEqual(DocText.text('xx', 'quote.title'), 'Offerte');
  assert.strictEqual(DocText.text('en', 'bestaat.niet'), 'bestaat.niet');
  assert.strictEqual(DocText.text('en', 'invoice.page', { page: 2, count: 3 }), 'Page 2 of 3');
  assert.strictEqual(DocText.localeOf('en'), 'en-GB');
  for (const language of ['nl', 'en']) {
    for (const [key, value] of Object.entries(DocText.TEXTS[language])) {
      const placeholders = (value.match(/\{(\w+)\}/g) || []).sort().join();
      const other = (DocText.TEXTS[language === 'nl' ? 'en' : 'nl'][key].match(/\{(\w+)\}/g) || []).sort().join();
      assert.strictEqual(placeholders, other, `zelfde invulvelden in ${key}`);
    }
  }
});

test('offerte: de taal wordt opgeschoond en het document staat in die taal', () => {
  assert.strictEqual(QuoteCore.sanitize({}).language, 'nl');
  assert.strictEqual(QuoteCore.sanitize({ language: 'en' }).language, 'en');
  assert.strictEqual(QuoteCore.sanitize({ language: '<script>' }).language, 'nl');
  const view = loadQuoteView();
  /**
   * Een offerte in de gevraagde taal.
   * @param {string} language 'nl' of 'en'.
   * @returns {object} De offerte voor de weergave.
   */
  const quote = (language) => ({ number: 'OF-2026-0001', acceptance: null, data: QuoteCore.sanitize({ ...quoteData({ language, paymentDays: 30, date: '2026-11-11', validUntil: '2026-12-11' }) }) });
  const english = view.documentHtml(quote('en'), { companyName: 'AquaTech' });
  assert.match(english, /Quotation/);
  assert.match(english, /Materials/);
  assert.match(english, /Valid until/);
  assert.match(english, /30 days/);
  assert.match(english, /Total incl\. VAT/);
  assert.match(english, /€25\.00/, 'bedragen in Engelse notatie');
  assert.match(english, /11 November 2026/);
  assert.doesNotMatch(english, /Offerte|Materialen|Geldig tot/);
  const dutch = view.documentHtml(quote('nl'), { companyName: 'AquaTech' });
  assert.match(dutch, /Offerte/);
  assert.match(dutch, /Materialen/);
  assert.match(dutch, /30 dagen/);
  assert.match(dutch, /€\s?25,00/);
  assert.doesNotMatch(dutch, /Quotation/);
});

test('offerte: het akkoord en het afgewezen-blok staan in de taal van het document', () => {
  const view = loadQuoteView();
  const base = { number: 'OF-1', data: QuoteCore.sanitize(quoteData({ language: 'en' })) };
  const accepted = view.documentHtml({ ...base, acceptance: { answer: 'akkoord', name: 'John', at: '2026-11-11T10:00:00Z', via: 'link', totalIncl: 30.25, signature: null } }, {});
  assert.match(accepted, /Accepted digitally/);
  assert.match(accepted, /<b>John<\/b>/);
  assert.match(accepted, /Via the quotation link/);
  const declined = view.documentHtml({ ...base, acceptance: { answer: 'afgewezen', name: 'John', at: '2026-11-11T10:00:00Z', reason: 'Too expensive' } }, {});
  assert.match(declined, /Declined/);
  assert.match(declined, /Reason: Too expensive/);
});

test('klantkaart: documenttaal opslaan, standaard Nederlands, ongeldige taal geweigerd, rechten en organisaties', async () => {
  const { installer, planner, as } = await setup();
  const made = await installer.post('/app/api/customers', { displayName: 'Müller GmbH', documentLanguage: 'en' });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.strictEqual(made.body.customer.documentLanguage, 'en');
  const plain = (await installer.post('/app/api/customers', { displayName: 'Jansen' })).body.customer;
  assert.strictEqual(plain.documentLanguage, 'nl');
  assert.strictEqual((await installer.post('/app/api/customers', { displayName: 'Frans', documentLanguage: 'fr' })).status, 400);
  const id = made.body.customer.id;
  assert.strictEqual((await installer.patch(`/app/api/customers/${id}`, { documentLanguage: 'nl' })).body.customer.documentLanguage, 'nl');
  assert.strictEqual((await installer.patch(`/app/api/customers/${id}`, { documentLanguage: 'fr' })).status, 400);
  assert.strictEqual((await installer.patch(`/app/api/customers/${id}`, { documentLanguage: 5 })).status, 400);
  assert.strictEqual((await installer.get(`/app/api/customers/${id}`)).body.customer.documentLanguage, 'nl', 'een foute waarde verandert niets');
  // Rechten: een planner heeft geen recht op klanten; een andere organisatie ziet de klant niet.
  assert.strictEqual((await planner.patch(`/app/api/customers/${id}`, { documentLanguage: 'en', paymentDays: 5 })).status, 403);
  const stranger = await as('vreemd', 'ander');
  assert.strictEqual((await stranger.patch(`/app/api/customers/${id}`, { documentLanguage: 'en', paymentDays: 5 })).status, 404);
  assert.strictEqual((await installer.get(`/app/api/customers/${id}`)).body.customer.paymentDays, null);
  // De klantkeuze in de offerte geeft de taal mee.
  await installer.patch(`/app/api/customers/${id}`, { documentLanguage: 'en' });
  const found = (await installer.get('/app/api/quote-customers?q=ller')).body.items;
  assert.strictEqual(found[0].documentLanguage, 'en');
});

test('offerte en factuur: de taal gaat van de offerte naar de factuur, de PDF en de mail', async () => {
  const { installer, admin } = await setup();
  const quote = (await installer.post('/app/api/quotes', { data: quoteData({ language: 'en', paymentDays: 30 }) })).body;
  assert.strictEqual(quote.data.language, 'en');
  assert.strictEqual((await installer.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' })).status, 200);
  const workOrder = (await installer.post('/app/api/workorders', { quoteId: quote.id })).body;
  const invoice = (await admin.post('/app/api/invoices', { workOrderId: workOrder.id })).body;
  assert.strictEqual(invoice.data.language, 'en');
  // De factuur-PDF in het Engels.
  const english = pdfText(invoicePdf({ ...invoice, number: 'F2026-0001', status: 'definitief' }, { profile: { companyName: 'AquaTech', iban: 'NL00BANK0123456789' } }));
  assert.match(english, /Invoice/);
  assert.match(english, /Due date/);
  assert.match(english, /Please transfer the total amount within 30 days/);
  assert.doesNotMatch(english, /Vervaldatum|Factuurnummer/);
  const dutch = pdfText(invoicePdf({ ...invoice, number: 'F2026-0001', status: 'definitief', data: { ...invoice.data, language: 'nl' } }, { profile: { companyName: 'AquaTech', iban: 'NL00BANK0123456789' } }));
  assert.match(dutch, /Vervaldatum/);
  assert.doesNotMatch(dutch, /Due date/);
  // Het mailconcept: Engels, met de Engelse betaaltekst.
  const draft = (await admin.get(`/app/api/invoices/${invoice.id}/mail`)).body;
  assert.match(draft.subject, /^Invoice .* from /);
  assert.match(draft.message, /^Dear /);
  assert.match(draft.message, /Please find attached invoice/);
  assert.match(draft.message, /Please transfer the total amount within 30 days/);
  // Een Nederlandse offerte geeft een Nederlandse factuur en mail.
  const dutchQuote = (await installer.post('/app/api/quotes', { data: quoteData() })).body;
  assert.strictEqual((await installer.put(`/app/api/quotes/${dutchQuote.id}`, { status: 'akkoord' })).status, 200);
  const dutchOrder = (await installer.post('/app/api/workorders', { quoteId: dutchQuote.id })).body;
  const dutchInvoice = (await admin.post('/app/api/invoices', { workOrderId: dutchOrder.id })).body;
  assert.strictEqual(dutchInvoice.data.language, 'nl');
  assert.match((await admin.get(`/app/api/invoices/${dutchInvoice.id}/mail`)).body.message, /^Beste /);
  // De creditfactuur erft de taal.
  assert.strictEqual(InvoiceCore.sanitize(InvoiceCore.creditOf({ number: 'F1', data: invoice.data })).language, 'en');
});
