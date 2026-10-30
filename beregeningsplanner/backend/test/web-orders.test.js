// Bestellen in de eigen webshop: winkelwagen, afrekenen op rekening, voorraad
// reserveren en afboeken, statussen, mail, tenant- en rechtencontrole.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { totalsOf, sanitizeCheckout } = require('../src/webshop/web-orders');
const { createLogin, createClient, listen, postForm, postCheckout } = require('./helpers/http-client');

const SECRET = 'd'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/** Gegevens van het afrekenformulier die kloppen. */
const CHECKOUT = { name: 'Piet Tuin', company: '', email: 'piet@voorbeeld.nl', phone: '0612345678', street: 'Tuinstraat 1', postcode: '8071ab', city: 'Nunspeet', note: 'Graag bellen', shippingMethod: 'dpd', country: 'NL' };

/**
 * Hoofdtenant met beheerder, de webshop met bestellen aan en een paar artikelen.
 * @returns {Promise<object>} base, db, main, admin, vreemd (beheerder van een andere organisatie), sent (verstuurde mails) en shopper() dat een nieuwe klant registreert.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const sent = [];
  /**
   * Nep-mailserver die de berichten bewaart.
   * @returns {{ configured: Function, send: Function }} De mailfuncties.
   */
  const mailerFor = () => ({ configured: () => true, send: async (message) => { sent.push(message); } });
  const { server, base } = await listen(createApp({ secret: SECRET, db, mailerFor }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  assert.strictEqual((await admin.put('/api/admin/settings', { storefront: true, shopOrdering: true })).status, 200);
  for (const item of [
    { code: 'SPR-1', name: 'Sproeier Pro', onHand: 5, salePrice: 10 },
    { code: 'BUIS-25', name: 'PE buis 25 mm', onHand: 100, salePrice: 1.5 },
    { code: 'INTERN', name: 'Alleen intern', onHand: 1 },
  ]) assert.strictEqual((await admin.post('/api/stock/items', item)).status, 201);
  let counter = 0;
  /**
   * Registreert een nieuwe klant in de shop en geeft zijn client terug.
   * @returns {Promise<object>} De ingelogde client.
   */
  const shopper = async () => {
    counter += 1;
    const client = createClient(base);
    const done = await postForm(base, client, '/winkel/registreren/', { displayName: `Klant ${counter}`, email: `klant${counter}@voorbeeld.nl`, password: PW, password2: PW, website: '' });
    assert.strictEqual(done.status, 303);
    return client;
  };
  const vreemd = await createLogin(base, { password: PW })('vreemd', 'ander');
  return { base, db, main, admin, vreemd, sent, shopper };
}

/**
 * Legt een artikel in de winkelwagen van een klant.
 * @param {string} base Adres van de testserver.
 * @param {object} client De client.
 * @param {string} code Artikelcode.
 * @param {number} qty Aantal.
 * @returns {Promise<void>}
 */
async function addToCart(base, client, code, qty) {
  const done = await postForm(base, client, '/winkel/winkelwagen/', { action: 'add', code, qty: String(qty) });
  assert.strictEqual(done.status, 303);
}

/**
 * Het artikel uit de voorraadlijst.
 * @param {object} admin Ingelogde beheerder.
 * @param {string} code Artikelcode.
 * @returns {Promise<object>} Het artikel (onHand, reserved, available).
 */
async function stockOf(admin, code) {
  const list = await admin.get('/api/stock');
  return list.body.items.find((item) => item.code === code);
}

test('totalsOf en sanitizeCheckout: btw per tarief en controle van het adres', () => {
  const totals = totalsOf([{ vatRate: 21, lineTotal: 12.1 }, { vatRate: 9, lineTotal: 10.9 }, { vatRate: 21, lineTotal: 12.1 }]);
  assert.strictEqual(totals.total, 35.1);
  assert.deepStrictEqual(totals.byRate.map((row) => [row.rate, row.incl, row.vat, row.excl]), [[21, 24.2, 4.2, 20], [9, 10.9, 0.9, 10]]);
  assert.strictEqual(sanitizeCheckout(CHECKOUT).value.postcode, '8071 AB');
  assert.strictEqual(sanitizeCheckout({ ...CHECKOUT, postcode: '12' }).field, 'postcode');
  assert.strictEqual(sanitizeCheckout({ ...CHECKOUT, email: 'geen' }).field, 'email');
  assert.strictEqual(sanitizeCheckout({ ...CHECKOUT, name: '' }).field, 'name');
});

test('bestellen staat standaard uit: geen winkelwagen en knop uitgeschakeld', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  await admin.put('/api/admin/settings', { storefront: true });
  await admin.post('/api/stock/items', { code: 'SPR-1', name: 'Sproeier Pro', onHand: 5, salePrice: 10 });
  const visitor = createClient(base);
  assert.strictEqual((await visitor.get('/winkel/winkelwagen/')).status, 404);
  assert.strictEqual((await visitor.get('/winkel/afrekenen/')).status, 404);
  const product = await visitor.get('/winkel/product/sproeier-pro-spr-1/');
  assert.match(product.text, /Online bestellen volgt binnenkort/);
  const post = await postForm(base, visitor, '/winkel/winkelwagen/', { action: 'add', code: 'SPR-1', qty: '1' });
  assert.strictEqual(post.status, 404);
});

test('bestelling plaatsen reserveert de voorraad en stuurt een bevestiging', async () => {
  const { base, admin, sent, shopper } = await setup();
  const customer = await shopper();
  const product = await customer.get('/winkel/product/sproeier-pro-spr-1/');
  assert.match(product.text, /name="action" value="add"/);
  await addToCart(base, customer, 'SPR-1', 2);
  await addToCart(base, customer, 'BUIS-25', 4);
  const cart = await customer.get('/winkel/winkelwagen/');
  assert.strictEqual(cart.status, 200);
  assert.match(cart.text, /Sproeier Pro/);
  assert.match(cart.text, /€ 31,48/, 'totaal: 2 × 12,10 + 4 × 1,82');
  const checkout = await customer.get('/winkel/afrekenen/');
  assert.strictEqual(checkout.status, 200);
  const bad = await postCheckout(base, customer, { ...CHECKOUT, postcode: 'x' });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.text, /geldige postcode/);
  const placed = await postCheckout(base, customer, CHECKOUT);
  assert.strictEqual(placed.status, 303);
  assert.match(placed.location, /^\.\.\/bestelling\/[0-9a-f-]{36}\/$/);
  const page = await customer.get(`/winkel/${placed.location.slice(3)}`);
  assert.match(page.text, /WEB-\d{4}-0001/);
  assert.match(page.text, /Graag bellen|Afleveradres/);
  assert.match((await customer.get('/winkel/winkelwagen/')).text, /leeg/, 'de winkelwagen is leeg na het bestellen');
  const spr = await stockOf(admin, 'SPR-1');
  assert.strictEqual(spr.onHand, 5);
  assert.strictEqual(spr.reserved, 2);
  assert.strictEqual(spr.available, 3);
  assert.strictEqual(sent.length, 1, 'bevestiging aan de klant (geen bedrijfsadres ingesteld)');
  assert.strictEqual(sent[0].to, 'piet@voorbeeld.nl');
  assert.match(sent[0].subject, /WEB-\d{4}-0001/);
  const list = await admin.get('/api/admin/web-orders');
  assert.strictEqual(list.body.total, 1);
  assert.strictEqual(list.body.items[0].status, 'nieuw');
  assert.strictEqual(list.body.counts.nieuw, 1);
  const detail = await admin.get(`/api/admin/web-orders/${list.body.items[0].id}`);
  assert.strictEqual(detail.body.order.total, 43.43, '31,48 artikelen + 11,95 DPD (6 kg met standaardgewicht)');
  assert.strictEqual(detail.body.order.address.postcode, '8071 AB');
  assert.strictEqual(detail.body.order.mail.sent, true);
});

test('verzonden boekt af en annuleren geeft de reservering vrij', async () => {
  const { base, admin, shopper } = await setup();
  const customer = await shopper();
  for (const qty of [2, 1]) {
    await addToCart(base, customer, 'SPR-1', qty);
    assert.strictEqual((await postCheckout(base, customer, CHECKOUT)).status, 303);
  }
  const orders = (await admin.get('/api/admin/web-orders')).body.items;
  assert.strictEqual(orders.length, 2);
  assert.strictEqual((await stockOf(admin, 'SPR-1')).reserved, 3);
  const [second, first] = orders;
  const shipped = await admin.post(`/api/admin/web-orders/${first.id}/status`, { status: 'verzonden' });
  assert.strictEqual(shipped.status, 200);
  const afterShip = await stockOf(admin, 'SPR-1');
  assert.strictEqual(afterShip.onHand, 3);
  assert.strictEqual(afterShip.reserved, 1);
  const cancelled = await admin.post(`/api/admin/web-orders/${second.id}/status`, { status: 'geannuleerd' });
  assert.strictEqual(cancelled.status, 200);
  const afterCancel = await stockOf(admin, 'SPR-1');
  assert.strictEqual(afterCancel.onHand, 3);
  assert.strictEqual(afterCancel.reserved, 0);
  assert.strictEqual((await admin.post(`/api/admin/web-orders/${first.id}/status`, { status: 'geannuleerd' })).status, 409, 'verzonden kan niet meer geannuleerd');
  assert.strictEqual((await admin.post(`/api/admin/web-orders/${first.id}/status`, { status: 'afgerond' })).status, 200);
  assert.strictEqual((await admin.post(`/api/admin/web-orders/${first.id}/status`, { status: 'bestaatniet' })).status, 400);
  const filtered = await admin.get('/api/admin/web-orders?status=afgerond');
  assert.strictEqual(filtered.body.total, 1);
  const excel = await admin.get('/api/admin/web-orders?lines=1');
  assert.strictEqual(excel.body.items[0].lines[0].code, 'SPR-1');
});

test('te weinig voorraad en artikelen die niet te koop zijn houden de bestelling tegen', async () => {
  const { base, admin, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 6);
  assert.match((await customer.get('/winkel/winkelwagen/')).text, /Nog maar 5 beschikbaar/);
  const toCart = await customer.get('/winkel/afrekenen/');
  assert.match(toCart.text, /Winkelwagen/, 'doorgestuurd naar de winkelwagen');
  const refused = await postCheckout(base, customer, CHECKOUT);
  assert.strictEqual(refused.status, 303);
  assert.match(refused.location, /winkelwagen/);
  assert.strictEqual((await admin.get('/api/admin/web-orders')).body.total, 0);
  assert.strictEqual((await stockOf(admin, 'SPR-1')).reserved, 0);
  await postForm(base, customer, '/winkel/winkelwagen/', { action: 'clear' });
  await addToCart(base, customer, 'INTERN', 1);
  const cart = await customer.get('/winkel/winkelwagen/');
  assert.match(cart.text, /Niet meer te koop/);
  assert.ok(!/Naar afrekenen/.test(cart.text));
});

test('wijzigen en verwijderen in de winkelwagen', async () => {
  const { base, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 1);
  await addToCart(base, customer, 'BUIS-25', 1);
  await postForm(base, customer, '/winkel/winkelwagen/', { action: 'set', code: 'SPR-1', qty: '3' });
  assert.match((await customer.get('/winkel/winkelwagen/')).text, /€ 38,12/);
  await postForm(base, customer, '/winkel/winkelwagen/', { action: 'remove', code: 'SPR-1' });
  const cart = await customer.get('/winkel/winkelwagen/');
  assert.ok(!/Sproeier Pro/.test(cart.text));
  assert.match(cart.text, /PE buis/);
});

test('zonder account niet afrekenen; een andere klant ziet de bestelling niet', async () => {
  const { base, shopper } = await setup();
  const customer = await shopper();
  const visitor = createClient(base);
  await addToCart(base, visitor, 'SPR-1', 1);
  const login = await visitor.get('/winkel/afrekenen/');
  assert.match(login.text, /volgende=afrekenen/);
  assert.strictEqual((await postForm(base, visitor, '/winkel/afrekenen/', CHECKOUT)).location, './');
  await addToCart(base, customer, 'SPR-1', 1);
  const placed = await postCheckout(base, customer, CHECKOUT);
  const other = await shopper();
  assert.strictEqual((await other.get(`/winkel/${placed.location.slice(3)}`)).status, 404);
  assert.strictEqual((await visitor.get(`/winkel/${placed.location.slice(3)}`)).status, 200, 'zonder sessie naar het inlogscherm');
  assert.match((await visitor.get(`/winkel/${placed.location.slice(3)}`)).text, /Inloggen/);
});

test('inloggen met volgende=afrekenen gaat terug naar het afrekenen', async () => {
  const { base, shopper } = await setup();
  await shopper();
  const email = 'klant1@voorbeeld.nl';
  const visitor = createClient(base);
  const page = await visitor.get('/winkel/inloggen/?volgende=afrekenen');
  assert.match(page.text, /name="volgende" value="afrekenen"/);
  const done = await postForm(base, visitor, '/winkel/inloggen/', { login: email, password: PW, volgende: 'afrekenen' });
  assert.strictEqual(done.status, 303);
  assert.strictEqual(done.location, '../afrekenen/');
});

test('rechten: Beheer-API alleen voor beheerders, andere organisatie 404, formulier van een andere site geweigerd', async () => {
  const { base, admin, vreemd, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 1);
  assert.strictEqual((await postCheckout(base, customer, CHECKOUT, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.strictEqual((await postForm(base, customer, '/winkel/winkelwagen/', { action: 'clear' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const placed = await postCheckout(base, customer, CHECKOUT);
  assert.strictEqual(placed.status, 303);
  assert.strictEqual((await customer.get('/api/admin/web-orders')).status, 403);
  const orderId = (await admin.get('/api/admin/web-orders')).body.items[0].id;
  assert.strictEqual((await customer.get(`/api/admin/web-orders/${orderId}`)).status, 403);
  assert.strictEqual((await customer.post(`/api/admin/web-orders/${orderId}/status`, { status: 'verzonden' })).status, 403);
  // Een beheerder van een andere organisatie ziet de bestelling niet.
  assert.strictEqual((await vreemd.get('/api/admin/web-orders')).body.total, 0);
  assert.strictEqual((await vreemd.get(`/api/admin/web-orders/${orderId}`)).status, 404);
  assert.strictEqual((await vreemd.post(`/api/admin/web-orders/${orderId}/status`, { status: 'verzonden' })).status, 404);
  assert.strictEqual((await admin.get(`/api/admin/web-orders/${orderId}`)).status, 200);
  const unknown = await admin.get('/api/admin/web-orders/00000000-0000-0000-0000-000000000000');
  assert.strictEqual(unknown.status, 404);
});

test('een klant met bestellingen kan worden verwijderd; de bestelling blijft staan', async () => {
  const { base, admin, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 1);
  assert.strictEqual((await postCheckout(base, customer, CHECKOUT)).status, 303);
  const users = (await admin.get('/api/admin/users')).body.items;
  const klant = users.find((user) => user.username !== 'baas' && user.role === 'klant');
  const removed = await admin.del(`/api/admin/users/${klant.id}`);
  assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
  assert.strictEqual((await admin.get('/api/admin/web-orders')).body.total, 1);
});
