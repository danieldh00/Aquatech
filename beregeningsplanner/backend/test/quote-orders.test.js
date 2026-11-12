// Offerte omzetten naar bestelling: regels, prijzen, korting, afleveradres, voorraadreservering, link naar beide kanten,
// één keer omzetten (ook bij twee gelijktijdige verzoeken), rechten en tenantisolatie.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake, KNOWN_ADDRESS } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { parseAddress, orderLinesOf, orderTotalsOf } = require('../src/verkoop/quote-orders');
const { fromWebOrder } = require('../src/verkoop/web-order-invoices');
const { totalsOf } = require('../src/webshop/web-orders');
const Core = require('../../frontend/offertes/quote-core.js');
const InvoiceCore = require('../../frontend/facturen/invoice-core.js');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 'd'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

const OTHER_ADDRESS = 'Tuinstraat 2\n8071 AB Nunspeet';

/**
 * Hoofdtenant met beheerder, installateur en een klant, een andere organisatie, en artikelen.
 * @returns {Promise<object>} base, db, admin, installer, vreemd, customerId.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW, mustChangePassword: false });
  const customer = await store.createAccount(main, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW, mustChangePassword: false });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const app = createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db });
  const { server, base } = await listen(app);
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  const installer = await createLogin(base, { password: PW })('kees');
  const vreemd = await createLogin(base, { password: PW })('vreemd', 'ander');
  for (const item of [{ code: 'SPR-1', name: 'Sproeier Pro', onHand: 5, salePrice: 10 }, { code: 'BUIS-25', name: 'PE buis 25 mm', onHand: 100, salePrice: 1.5 }]) {
    assert.strictEqual((await admin.post('/app/api/stock/items', item)).status, 201);
  }
  return { base, db, admin, installer, vreemd, customerId: customer.user ? customer.user.id : customer.id };
}

/**
 * Maakt een geaccordeerde offerte met een artikel, een vrije regel, korting, een betaaltermijn en een afwijkend afleveradres.
 * @param {object} client De client van de beheerder.
 * @param {object} [extra] Velden die de offertegegevens aanvullen of overschrijven.
 * @param {string} [status] De status na het aanmaken.
 * @returns {Promise<object>} De offerte.
 */
async function acceptedQuote(client, extra = {}, status = 'akkoord') {
  const data = {
    title: 'Beregening', customer: { name: 'Tuinen BV', contact: 'Jan Tuin', address: KNOWN_ADDRESS, email: 'jan@voorbeeld.nl', phone: '0612345678' },
    delivery: { same: false, address: OTHER_ADDRESS }, paymentDays: 30, language: 'en', discountType: 'pct', discountPct: 10, discountNote: 'Seizoensactie',
    internalNote: 'Niet aan de klant laten zien',
    lines: [
      { id: 'a', section: 'materiaal', code: 'SPR-1', description: 'Sproeier Pro', qty: 2, unit: 'st', price: 9.5, vat: 21, note: 'twijfel' },
      { id: 'b', section: 'arbeid', code: '', description: 'Aanleg', qty: 3, unit: 'uur', price: 50, vat: 9 },
      { id: 'c', section: 'overig', code: 'BUIS-25', description: 'Optionele buis', qty: 10, unit: 'm', price: 1.2, vat: 21, optional: true, selected: false },
    ],
    ...extra,
  };
  const created = await client.post('/app/api/quotes', { data, status });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

test('parseAddress: straat, postcode en plaats, eventueel een land', () => {
  assert.deepStrictEqual(parseAddress('Tuinstraat 1\n8071 AB  Nunspeet'), { street: 'Tuinstraat 1', postcode: '8071 AB', city: 'Nunspeet', country: 'NL' });
  assert.deepStrictEqual(parseAddress('Rue 5\n1000 Bruxelles\nBE').country, 'BE');
  assert.deepStrictEqual(parseAddress(''), { street: '', postcode: '', city: '', country: '' });
});

test('orderLinesOf: het totaal van de bestelling is dat van de offerte (korting, twee btw-tarieven, opties, verlegd)', () => {
  const data = Core.sanitize({
    lines: [{ qty: 3, price: 33.33, vat: 21, description: 'a' }, { qty: 2, price: 7.77, vat: 9, description: 'b' }, { qty: 1, price: 5, vat: 21, optional: true, selected: false, description: 'optie' }],
    discountType: 'pct', discountPct: 7.5,
  });
  const lines = orderLinesOf(data, 'Korting');
  assert.strictEqual(lines.length, 4, 'twee regels en een kortingsregel per tarief, de niet gekozen optie niet');
  assert.ok(Math.abs(totalsOf(lines).total - Core.totals(data).total) < 0.011, 'de regels komen op hoogstens een cent na op het offertetotaal');
  assert.strictEqual(orderTotalsOf(data).total, Core.totals(data).total);
  const amount = Core.sanitize({ lines: [{ qty: 1, price: 100, vat: 21, description: 'a' }], discountType: 'amount', discountAmount: 12.34 });
  assert.strictEqual(totalsOf(orderLinesOf(amount, 'Korting')).total, Core.totals(amount).total);
  assert.deepStrictEqual(orderTotalsOf(amount).byRate.map((row) => [row.rate, row.excl, row.vat]), [[21, 87.66, 18.41]]);
  const shifted = Core.sanitize({ lines: [{ qty: 1, price: 100, vat: 21, description: 'a' }], vatShift: { on: true, number: 'DE123456789', status: 'geldig' } });
  const shiftedLines = orderLinesOf(shifted, 'Korting');
  assert.strictEqual(shiftedLines[0].vatRate, 0);
  assert.strictEqual(totalsOf(shiftedLines).total, 100);
});

test('omzetten: bestelling met regels, korting, adressen, termijn en taal; offerte staat op Omgezet en ligt vast', async () => {
  const { admin } = await setup();
  const quote = await acceptedQuote(admin);
  const expected = Core.totals(quote.data);
  const converted = await admin.post(`/app/api/quotes/${quote.id}/convert`);
  assert.strictEqual(converted.status, 201, JSON.stringify(converted.body));
  assert.match(converted.body.order.number, /^WEB-\d{4}-0001$/);
  assert.strictEqual(converted.body.order.total, expected.total);
  assert.deepStrictEqual(converted.body.shortages, []);

  const detail = (await admin.get(`/app/api/admin/web-orders/${converted.body.order.id}`)).body.order;
  assert.strictEqual(detail.status, 'nieuw');
  assert.deepStrictEqual(detail.quote, { id: quote.id, number: quote.number });
  assert.strictEqual(detail.paymentDays, 30);
  assert.strictEqual(detail.language, 'en');
  assert.strictEqual(detail.deliverySame, false);
  assert.strictEqual(detail.address.street, 'Tuinstraat 2', 'aflevering = afwijkend adres van de offerte');
  assert.strictEqual(detail.billingAddress.street, 'Tuinstraat 1', 'factuuradres = adres van de klant');
  assert.deepStrictEqual([detail.customer.company, detail.customer.name, detail.customer.email], ['Tuinen BV', 'Jan Tuin', 'jan@voorbeeld.nl']);
  assert.strictEqual(detail.note, '');
  assert.ok(!JSON.stringify(detail).includes('Niet aan de klant'), 'de interne notitie gaat niet mee');
  assert.ok(!JSON.stringify(detail).includes('twijfel'), 'ook de notitie per regel niet');
  assert.deepStrictEqual(detail.lines.slice(0, 2).map((line) => [line.code, line.qty, line.unitExcl]), [['SPR-1', 2, 9.5], ['', 3, 50]]);
  assert.strictEqual(detail.lines.length, 4, 'twee regels en een kortingsregel per btw-tarief');
  assert.ok(detail.lines.slice(2).every((line) => line.itemId === '' && line.unitExcl < 0 && /Discount/.test(line.name)), 'korting per btw-tarief in de taal van het document');
  assert.ok(detail.lines[0].itemId, 'artikelregel met voorraad');
  assert.strictEqual(detail.lines[1].itemId, '', 'vrije regel zonder voorraad');

  // Voorraad: alleen de artikelregel is gereserveerd (de optie die niet gekozen is niet).
  const stock = (await admin.get('/app/api/stock')).body.items;
  assert.strictEqual(stock.find((item) => item.code === 'SPR-1').reserved, 2);
  assert.strictEqual(stock.find((item) => item.code === 'BUIS-25').reserved, 0);

  // Link naar beide kanten, status Omgezet en vergrendeld.
  const list = (await admin.get('/app/api/quotes')).body.items.find((item) => item.id === quote.id);
  assert.deepStrictEqual([list.status, list.order.id, list.order.number], ['akkoord', converted.body.order.id, converted.body.order.number]);
  const full = (await admin.get(`/app/api/quotes/${quote.id}`)).body;
  assert.strictEqual(full.order.number, converted.body.order.number);
  const locked = await admin.put(`/app/api/quotes/${quote.id}`, { status: 'concept' });
  assert.strictEqual(locked.status, 409);
  assert.strictEqual(locked.body.error, 'locked');
  assert.strictEqual((await admin.put(`/app/api/quotes/${quote.id}`, { data: quote.data })).status, 409);
  const removed = await admin.del(`/app/api/quotes/${quote.id}`, { confirm: quote.number });
  assert.deepStrictEqual([removed.status, removed.body.error], [409, 'converted'], 'een omgezette offerte wordt niet verwijderd');
  assert.strictEqual((await admin.del(`/app/api/admin/quotes/${quote.id}`)).status, 409, 'wissen vraagt de bevestiging met het offertenummer');

  // De factuur bij de bestelling krijgt de termijn en taal van de offerte.
  const invoice = fromWebOrder(detail, {}, InvoiceCore.sanitizeSettings({}));
  assert.strictEqual(invoice.paymentDays, 30);
  assert.strictEqual(invoice.language, 'en');
  assert.match(invoice.reference, new RegExp(quote.number));
  assert.strictEqual(InvoiceCore.totals(invoice, InvoiceCore.sanitizeSettings({})).total, expected.total, 'factuurbedrag = offertebedrag');
});

test('omzetten kan maar één keer, ook niet bij twee gelijktijdige verzoeken', async () => {
  const { admin } = await setup();
  const quote = await acceptedQuote(admin);
  const results = await Promise.all([admin.post(`/app/api/quotes/${quote.id}/convert`), admin.post(`/app/api/quotes/${quote.id}/convert`)]);
  assert.deepStrictEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.strictEqual(results.find((result) => result.status === 409).body.error, 'already_converted');
  assert.strictEqual((await admin.post(`/app/api/quotes/${quote.id}/convert`)).body.error, 'already_converted');
  const orders = (await admin.get('/app/api/admin/web-orders')).body;
  assert.strictEqual(orders.total, 1, 'er is precies één bestelling');
  assert.strictEqual((await admin.get('/app/api/stock')).body.items.find((item) => item.code === 'SPR-1').reserved, 2, 'de voorraad is één keer gereserveerd');
});

test('omzetten: alleen een geaccordeerde offerte, gelijk afleveradres, tekort aan voorraad en lege offerte', async () => {
  const { admin } = await setup();
  const concept = await acceptedQuote(admin, {}, 'concept');
  const refused = await admin.post(`/app/api/quotes/${concept.id}/convert`);
  assert.deepStrictEqual([refused.status, refused.body.error], [409, 'not_accepted']);
  assert.strictEqual((await admin.get('/app/api/admin/web-orders')).body.total, 0);

  const same = await acceptedQuote(admin, { delivery: { same: true, address: '' }, discountPct: 0, language: 'nl', paymentDays: null,
    lines: [{ id: 'a', section: 'materiaal', code: 'SPR-1', description: 'Sproeier Pro', qty: 9, unit: 'st', price: 9.5, vat: 21 }] });
  const converted = await admin.post(`/app/api/quotes/${same.id}/convert`);
  assert.strictEqual(converted.status, 201);
  assert.deepStrictEqual(converted.body.shortages.map((item) => item.name), ['Sproeier Pro'], 'meer besteld dan er ligt: een waarschuwing, geen weigering');
  const detail = (await admin.get(`/app/api/admin/web-orders/${converted.body.order.id}`)).body.order;
  assert.strictEqual(detail.deliverySame, true);
  assert.strictEqual(detail.address.street, 'Tuinstraat 1');
  assert.strictEqual(detail.billingAddress, null);
  assert.strictEqual(detail.paymentDays, 14, 'de standaardtermijn die de offerte zelf al invulde');
  assert.strictEqual(detail.language, 'nl');

  const empty = await acceptedQuote(admin, { lines: [] });
  assert.strictEqual((await admin.post(`/app/api/quotes/${empty.id}/convert`)).body.error, 'empty');
});

test('omzetten: rechten en tenantisolatie', async () => {
  const { admin, installer, vreemd } = await setup();
  const quote = await acceptedQuote(admin);
  assert.strictEqual((await installer.post(`/app/api/quotes/${quote.id}/convert`)).status, 403, 'een installateur is geen beheerder');
  assert.strictEqual((await vreemd.post(`/app/api/quotes/${quote.id}/convert`)).status, 404, 'een andere organisatie vindt de offerte niet');
  assert.strictEqual((await admin.post('/app/api/quotes/bestaat-niet/convert')).status, 404);
  assert.strictEqual((await admin.get('/app/api/admin/web-orders')).body.total, 0);
});

test('een klant ziet niet dat de offerte is omgezet', async () => {
  const { admin, base, customerId } = await setup();
  const quote = await acceptedQuote(admin, { delivery: { same: true, address: '' } }, 'verzonden');
  assert.strictEqual((await admin.put(`/app/api/quotes/${quote.id}`, { customerId, status: 'akkoord' })).status, 200);
  assert.strictEqual((await admin.post(`/app/api/quotes/${quote.id}/convert`)).status, 201);
  const klaas = await createLogin(base, { password: PW })('klaas');
  const own = (await klaas.get('/app/api/quotes')).body.items;
  assert.strictEqual(own.length, 1);
  assert.ok(!('order' in own[0]));
  const detail = await klaas.get(`/app/api/quotes/${quote.id}`);
  assert.strictEqual(detail.status, 200);
  assert.ok(!('order' in detail.body));
  assert.ok(!JSON.stringify(detail.body).includes('web_orders'));
});
