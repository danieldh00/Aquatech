// Bestellen in de eigen webshop: winkelwagen, afrekenen op rekening, voorraad
// reserveren en afboeken, statussen, mail, tenant- en rechtencontrole.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
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
 * @returns {Promise<object>} app, base, db, main, admin, vreemd (beheerder van een andere organisatie), sent (verstuurde mails) en shopper() dat een nieuwe klant registreert.
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
  const app = createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db, mailerFor });
  const { server, base } = await listen(app);
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  assert.strictEqual((await admin.put('/app/api/admin/settings', { storefront: true, shopOrdering: true, shopPayment: { online: false, publicUrl: `${base}/` } })).status, 200);
  for (const item of [
    { code: 'SPR-1', name: 'Sproeier Pro', onHand: 5, salePrice: 10 },
    { code: 'BUIS-25', name: 'PE buis 25 mm', onHand: 100, salePrice: 1.5 },
    { code: 'INTERN', name: 'Alleen intern', onHand: 1 },
  ]) assert.strictEqual((await admin.post('/app/api/stock/items', item)).status, 201);
  let counter = 0;
  /**
   * Registreert een nieuwe klant in de shop en geeft zijn client terug.
   * @returns {Promise<object>} De ingelogde client.
   */
  const shopper = async () => {
    counter += 1;
    const client = createClient(base);
    const done = await postForm(base, client, '/registreren/', { displayName: `Klant ${counter}`, email: `klant${counter}@voorbeeld.nl`, password: PW, password2: PW, website: '' });
    assert.strictEqual(done.status, 303);
    return client;
  };
  const vreemd = await createLogin(base, { password: PW })('vreemd', 'ander');
  return { app, base, db, main, admin, vreemd, sent, shopper };
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
  const done = await postForm(base, client, '/winkelwagen/', { action: 'add', code, qty: String(qty) });
  assert.strictEqual(done.status, 303);
}

/**
 * Het artikel uit de voorraadlijst.
 * @param {object} admin Ingelogde beheerder.
 * @param {string} code Artikelcode.
 * @returns {Promise<object>} Het artikel (onHand, reserved, available).
 */
async function stockOf(admin, code) {
  const list = await admin.get('/app/api/stock');
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
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  await admin.put('/app/api/admin/settings', { storefront: true });
  await admin.post('/app/api/stock/items', { code: 'SPR-1', name: 'Sproeier Pro', onHand: 5, salePrice: 10 });
  const visitor = createClient(base);
  assert.strictEqual((await visitor.get('/winkelwagen/')).status, 404);
  assert.strictEqual((await visitor.get('/afrekenen/')).status, 404);
  const product = await visitor.get('/product/sproeier-pro-spr-1/');
  assert.match(product.text, /Online bestellen volgt binnenkort/);
  const post = await postForm(base, visitor, '/winkelwagen/', { action: 'add', code: 'SPR-1', qty: '1' });
  assert.strictEqual(post.status, 404);
});

test('bestelling plaatsen reserveert de voorraad en stuurt een bevestiging', async () => {
  const { base, admin, sent, shopper } = await setup();
  const customer = await shopper();
  const product = await customer.get('/product/sproeier-pro-spr-1/');
  assert.match(product.text, /name="action" value="add"/);
  await addToCart(base, customer, 'SPR-1', 2);
  await addToCart(base, customer, 'BUIS-25', 4);
  const cart = await customer.get('/winkelwagen/');
  assert.strictEqual(cart.status, 200);
  assert.match(cart.text, /Sproeier Pro/);
  assert.match(cart.text, /€ 31,48/, 'totaal: 2 × 12,10 + 4 × 1,82');
  const checkout = await customer.get('/afrekenen/');
  assert.strictEqual(checkout.status, 200);
  const bad = await postCheckout(base, customer, { ...CHECKOUT, postcode: 'x' });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.text, /geldige postcode/);
  const placed = await postCheckout(base, customer, CHECKOUT);
  assert.strictEqual(placed.status, 303);
  assert.match(placed.location, /^\.\.\/bestelling\/[0-9a-f-]{36}\/\?bedankt=1$/);
  const page = await customer.get(`/${placed.location.slice(3)}`);
  assert.match(page.text, /WEB-\d{4}-0001/);
  assert.match(page.text, /Graag bellen|Afleveradres/);
  assert.match((await customer.get('/winkelwagen/')).text, /leeg/, 'de winkelwagen is leeg na het bestellen');
  const spr = await stockOf(admin, 'SPR-1');
  assert.strictEqual(spr.onHand, 5);
  assert.strictEqual(spr.reserved, 2);
  assert.strictEqual(spr.available, 3);
  const orderMails = sent.filter((message) => /bestelling/i.test(message.subject));
  assert.strictEqual(orderMails.length, 1, 'bevestiging aan de klant (geen bedrijfsadres ingesteld)');
  assert.strictEqual(orderMails[0].to, 'klant1@voorbeeld.nl', 'naar het adres van het account, niet het ingevulde (W-08)');
  assert.match(orderMails[0].subject, /WEB-\d{4}-0001/);
  assert.ok(sent.some((message) => message.subject === 'Bevestig je e-mailadres' && message.to === 'klant1@voorbeeld.nl'), 'bevestigingsmail na registreren (A-02)');
  const list = await admin.get('/app/api/admin/web-orders');
  assert.strictEqual(list.body.total, 1);
  assert.strictEqual(list.body.items[0].status, 'nieuw');
  assert.strictEqual(list.body.counts.nieuw, 1);
  const detail = await admin.get(`/app/api/admin/web-orders/${list.body.items[0].id}`);
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
  const orders = (await admin.get('/app/api/admin/web-orders')).body.items;
  assert.strictEqual(orders.length, 2);
  assert.strictEqual((await stockOf(admin, 'SPR-1')).reserved, 3);
  const [second, first] = orders;
  const shipped = await admin.post(`/app/api/admin/web-orders/${first.id}/status`, { status: 'verzonden' });
  assert.strictEqual(shipped.status, 200);
  const afterShip = await stockOf(admin, 'SPR-1');
  assert.strictEqual(afterShip.onHand, 3);
  assert.strictEqual(afterShip.reserved, 1);
  const cancelled = await admin.post(`/app/api/admin/web-orders/${second.id}/status`, { status: 'geannuleerd' });
  assert.strictEqual(cancelled.status, 200);
  const afterCancel = await stockOf(admin, 'SPR-1');
  assert.strictEqual(afterCancel.onHand, 3);
  assert.strictEqual(afterCancel.reserved, 0);
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${first.id}/status`, { status: 'geannuleerd' })).status, 409, 'verzonden kan niet meer geannuleerd');
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${first.id}/status`, { status: 'afgerond' })).status, 200);
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${first.id}/status`, { status: 'bestaatniet' })).status, 400);
  const filtered = await admin.get('/app/api/admin/web-orders?status=afgerond');
  assert.strictEqual(filtered.body.total, 1);
  const excel = await admin.get('/app/api/admin/web-orders?lines=1');
  assert.strictEqual(excel.body.items[0].lines[0].code, 'SPR-1');
});

test('te weinig voorraad en artikelen die niet te koop zijn houden de bestelling tegen', async () => {
  const { base, admin, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 6);
  assert.match((await customer.get('/winkelwagen/')).text, /Nog maar 5 beschikbaar/);
  const toCart = await customer.get('/afrekenen/');
  assert.match(toCart.text, /Winkelwagen/, 'doorgestuurd naar de winkelwagen');
  const refused = await postCheckout(base, customer, CHECKOUT);
  assert.strictEqual(refused.status, 303);
  assert.match(refused.location, /winkelwagen/);
  assert.strictEqual((await admin.get('/app/api/admin/web-orders')).body.total, 0);
  assert.strictEqual((await stockOf(admin, 'SPR-1')).reserved, 0);
  await postForm(base, customer, '/winkelwagen/', { action: 'clear' });
  await addToCart(base, customer, 'INTERN', 1);
  const cart = await customer.get('/winkelwagen/');
  assert.match(cart.text, /Niet meer te koop/);
  assert.ok(!/Naar afrekenen/.test(cart.text));
});

test('wijzigen en verwijderen in de winkelwagen', async () => {
  const { base, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 1);
  await addToCart(base, customer, 'BUIS-25', 1);
  await postForm(base, customer, '/winkelwagen/', { action: 'set', code: 'SPR-1', qty: '3' });
  assert.match((await customer.get('/winkelwagen/')).text, /€ 38,12/);
  await postForm(base, customer, '/winkelwagen/', { action: 'remove', code: 'SPR-1' });
  const cart = await customer.get('/winkelwagen/');
  assert.ok(!/Sproeier Pro/.test(cart.text));
  assert.match(cart.text, /PE buis/);
});

test('zonder account niet afrekenen; een andere klant ziet de bestelling niet', async () => {
  const { base, shopper } = await setup();
  const customer = await shopper();
  const visitor = createClient(base);
  await addToCart(base, visitor, 'SPR-1', 1);
  const login = await visitor.get('/afrekenen/');
  assert.match(login.text, /volgende=afrekenen/);
  assert.strictEqual((await postForm(base, visitor, '/afrekenen/', CHECKOUT)).location, './');
  await addToCart(base, customer, 'SPR-1', 1);
  const placed = await postCheckout(base, customer, CHECKOUT);
  const other = await shopper();
  assert.strictEqual((await other.get(`/${placed.location.slice(3)}`)).status, 404);
  assert.strictEqual((await visitor.get(`/${placed.location.slice(3)}`)).status, 200, 'zonder sessie naar het inlogscherm');
  assert.match((await visitor.get(`/${placed.location.slice(3)}`)).text, /Inloggen/);
});

test('inloggen met volgende=afrekenen gaat terug naar het afrekenen', async () => {
  const { base, shopper } = await setup();
  await shopper();
  const email = 'klant1@voorbeeld.nl';
  const visitor = createClient(base);
  const page = await visitor.get('/inloggen/?volgende=afrekenen');
  assert.match(page.text, /name="volgende" value="afrekenen"/);
  const done = await postForm(base, visitor, '/inloggen/', { login: email, password: PW, volgende: 'afrekenen' });
  assert.strictEqual(done.status, 303);
  assert.strictEqual(done.location, '../afrekenen/');
});

test('rechten: Beheer-API alleen voor beheerders, andere organisatie 404, formulier van een andere site geweigerd', async () => {
  const { base, admin, vreemd, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 1);
  assert.strictEqual((await postCheckout(base, customer, CHECKOUT, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.strictEqual((await postForm(base, customer, '/winkelwagen/', { action: 'clear' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const placed = await postCheckout(base, customer, CHECKOUT);
  assert.strictEqual(placed.status, 303);
  assert.strictEqual((await customer.get('/app/api/admin/web-orders')).status, 403);
  const orderId = (await admin.get('/app/api/admin/web-orders')).body.items[0].id;
  assert.strictEqual((await customer.get(`/app/api/admin/web-orders/${orderId}`)).status, 403);
  assert.strictEqual((await customer.post(`/app/api/admin/web-orders/${orderId}/status`, { status: 'verzonden' })).status, 403);
  // Een beheerder van een andere organisatie ziet de bestelling niet.
  assert.strictEqual((await vreemd.get('/app/api/admin/web-orders')).body.total, 0);
  assert.strictEqual((await vreemd.get(`/app/api/admin/web-orders/${orderId}`)).status, 404);
  assert.strictEqual((await vreemd.post(`/app/api/admin/web-orders/${orderId}/status`, { status: 'verzonden' })).status, 404);
  assert.strictEqual((await admin.get(`/app/api/admin/web-orders/${orderId}`)).status, 200);
  const unknown = await admin.get('/app/api/admin/web-orders/00000000-0000-0000-0000-000000000000');
  assert.strictEqual(unknown.status, 404);
});

test('een klant met bestellingen kan worden verwijderd; de bestelling blijft staan', async () => {
  const { base, admin, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 1);
  assert.strictEqual((await postCheckout(base, customer, CHECKOUT)).status, 303);
  const users = (await admin.get('/app/api/admin/users')).body.items;
  const klant = users.find((user) => user.username !== 'baas' && user.role === 'klant');
  const removed = await admin.del(`/app/api/admin/users/${klant.id}`);
  assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
  assert.strictEqual((await admin.get('/app/api/admin/web-orders')).body.total, 1);
});

test('een artikel op een open bestelling kan niet worden verwijderd of gearchiveerd; daarna wel', async () => {
  const { base, admin, vreemd, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 2);
  assert.strictEqual((await postCheckout(base, customer, CHECKOUT)).status, 303);
  const [placed] = (await admin.get('/app/api/admin/web-orders')).body.items;
  const item = await stockOf(admin, 'SPR-1');

  const removed = await admin.request('DELETE', `/app/api/stock/items/${item.id}`);
  assert.strictEqual(removed.status, 409);
  assert.strictEqual(removed.body.error, 'reserved_by_order');
  assert.deepStrictEqual(removed.body.orders, [placed.number]);
  assert.strictEqual((await admin.put(`/app/api/stock/items/${item.id}`, { archived: true })).status, 409);
  assert.strictEqual((await stockOf(admin, 'SPR-1')).reserved, 2, 'de reservering blijft staan');
  // Een andere organisatie ziet het artikel niet.
  assert.strictEqual((await vreemd.request('DELETE', `/app/api/stock/items/${item.id}`)).status, 404);

  // Na verzenden houdt de bestelling het artikel niet meer vast.
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${placed.id}/status`, { status: 'verzonden' })).status, 200);
  const gone = await admin.request('DELETE', `/app/api/stock/items/${item.id}`);
  assert.strictEqual(gone.status, 200);
  assert.strictEqual(gone.body.archived, true);
});

test('adres niet gevonden: met "zelf invullen" toch bestellen, gemarkeerd als niet gecontroleerd (W-11); mislukte pogingen tellen niet voor de limiet (W-12)', async () => {
  const { base, admin, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 1);
  const newBuild = { ...CHECKOUT, street: 'Nieuwbouwlaan 7', postcode: '8071 ZZ', city: 'Nunspeet' };
  // Een klant die zijn adres een paar keer probeert, loopt niet tegen de bestellimiet aan.
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const refused = await postCheckout(base, customer, newBuild);
    assert.strictEqual(refused.status, 400);
    assert.match(refused.text, /zelf invult/);
  }
  assert.strictEqual((await postCheckout(base, customer, { ...newBuild, addressManual: 'ja', city: '' })).status, 400, 'zonder woonplaats niet');
  const placed = await postCheckout(base, customer, { ...newBuild, addressManual: 'ja' });
  assert.strictEqual(placed.status, 303);
  const list = (await admin.get('/app/api/admin/web-orders')).body.items;
  assert.strictEqual(list.length, 1);
  assert.match(list[0].number, /^WEB-\d{4}-0001$/);
  const detail = (await admin.get(`/app/api/admin/web-orders/${list[0].id}`)).body.order;
  assert.strictEqual(detail.address.street, 'Nieuwbouwlaan 7');
  assert.strictEqual(detail.address.unverified, true);
  // Een gevonden adres krijgt geen markering, en het volgnummer loopt door.
  await addToCart(base, customer, 'SPR-1', 1);
  assert.strictEqual((await postCheckout(base, customer, { ...CHECKOUT, addressManual: 'ja' })).status, 303);
  const second = (await admin.get('/app/api/admin/web-orders')).body.items.find((order) => order.id !== list[0].id);
  assert.match(second.number, /-0002$/);
  assert.strictEqual((await admin.get(`/app/api/admin/web-orders/${second.id}`)).body.order.address.unverified, undefined);
});

test('een bestelling op rekening houdt de voorraad zo lang vast als ingesteld en geeft hem daarna vrij; verzenden kan nog (8)', async () => {
  const { app, base, db, admin, shopper } = await setup();
  assert.strictEqual((await admin.put('/app/api/admin/settings', { shopPayment: { online: false, publicUrl: `${base}/`, accountHoldDays: 3 } })).status, 200);
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 2);
  assert.strictEqual((await postCheckout(base, customer, CHECKOUT)).status, 303);
  const [placed] = (await admin.get('/app/api/admin/web-orders')).body.items;
  const detail = (await admin.get(`/app/api/admin/web-orders/${placed.id}`)).body.order;
  const days = (Date.parse(detail.reservedUntil) - Date.parse(detail.createdAt)) / 86400000;
  assert.ok(Math.abs(days - 3) < 0.001, 'drie dagen na het bestellen');
  assert.deepStrictEqual(app.locals.webOrdersRelease(), { released: 0 }, 'nog binnen de termijn');
  assert.strictEqual((await stockOf(admin, 'SPR-1')).reserved, 2);
  const data = JSON.parse(db.prepare('SELECT data FROM web_orders WHERE id = ?').get(placed.id).data);
  data.reservedUntil = new Date(Date.now() - 1000).toISOString();
  db.prepare('UPDATE web_orders SET data = ? WHERE id = ?').run(JSON.stringify(data), placed.id);
  assert.deepStrictEqual(app.locals.webOrdersRelease(), { released: 1 });
  assert.deepStrictEqual(app.locals.webOrdersRelease(), { released: 0 }, 'niet twee keer');
  assert.strictEqual((await stockOf(admin, 'SPR-1')).reserved, 0, 'voorraad weer vrij');
  const released = (await admin.get(`/app/api/admin/web-orders/${placed.id}`)).body.order;
  assert.strictEqual(released.status, 'nieuw', 'de bestelling blijft staan');
  assert.ok(released.reservationReleasedAt);
  assert.match(released.history.at(-1).note, /vrijgegeven/);
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${placed.id}/status`, { status: 'verzonden' })).status, 200);
  assert.strictEqual((await stockOf(admin, 'SPR-1')).onHand, 3, 'verzenden boekt gewoon af');
});

test('een vrijgegeven bestelling verzenden kan niet als de voorraad intussen aan een ander is toegezegd (8)', async () => {
  const { app, base, db, admin, shopper } = await setup();
  assert.strictEqual((await admin.put('/app/api/admin/settings', { shopPayment: { online: false, publicUrl: `${base}/`, accountHoldDays: 3 } })).status, 200);
  const first = await shopper();
  await addToCart(base, first, 'SPR-1', 2);
  assert.strictEqual((await postCheckout(base, first, CHECKOUT)).status, 303);
  const [placed] = (await admin.get('/app/api/admin/web-orders')).body.items;
  const data = JSON.parse(db.prepare('SELECT data FROM web_orders WHERE id = ?').get(placed.id).data);
  data.reservedUntil = new Date(Date.now() - 1000).toISOString();
  db.prepare('UPDATE web_orders SET data = ? WHERE id = ?').run(JSON.stringify(data), placed.id);
  assert.deepStrictEqual(app.locals.webOrdersRelease(), { released: 1 });
  const second = await shopper();
  await addToCart(base, second, 'SPR-1', 4);
  assert.strictEqual((await postCheckout(base, second, CHECKOUT)).status, 303);
  const refused = await admin.post(`/app/api/admin/web-orders/${placed.id}/status`, { status: 'verzonden' });
  assert.strictEqual(refused.status, 409, 'nog maar één stuk vrij');
  assert.strictEqual((await stockOf(admin, 'SPR-1')).onHand, 5, 'niets afgeboekt');
});

test('met 0 dagen blijft een bestelling op rekening gereserveerd tot verzenden of annuleren (8)', async () => {
  const { app, base, admin, shopper } = await setup();
  assert.strictEqual((await admin.put('/app/api/admin/settings', { shopPayment: { online: false, publicUrl: `${base}/`, accountHoldDays: 0 } })).status, 200);
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 1);
  assert.strictEqual((await postCheckout(base, customer, CHECKOUT)).status, 303);
  const [placed] = (await admin.get('/app/api/admin/web-orders')).body.items;
  assert.strictEqual((await admin.get(`/app/api/admin/web-orders/${placed.id}`)).body.order.reservedUntil, null);
  assert.deepStrictEqual(app.locals.webOrdersRelease(), { released: 0 });
  assert.strictEqual((await stockOf(admin, 'SPR-1')).reserved, 1);
});

test('afleveradres: standaard gelijk aan het factuuradres; een afwijkend adres wordt apart opgeslagen en gecontroleerd', async () => {
  const { base, admin, sent, shopper } = await setup();
  const customer = await shopper();
  // De pagina toont het vinkje standaard aan en verbergt het tweede adres.
  await addToCart(base, customer, 'SPR-1', 1);
  const page = await customer.get('/afrekenen/');
  assert.match(page.text, /name="deliverySame" value="ja" data-delivery-same checked/);
  assert.match(page.text, /data-address-block="delivery" hidden/);
  assert.match(page.text, /name="deliveryForm" value="1"/);

  // Gelijk (vinkje aan): beide adressen zijn hetzelfde.
  assert.strictEqual((await postCheckout(base, customer, { ...CHECKOUT, deliveryForm: '1', deliverySame: 'ja' })).status, 303);
  const [first] = (await admin.get('/app/api/admin/web-orders')).body.items;
  const same = (await admin.get(`/app/api/admin/web-orders/${first.id}`)).body.order;
  assert.strictEqual(same.deliverySame, true);
  assert.strictEqual(same.address.street, 'Tuinstraat 1');
  assert.deepStrictEqual({ street: same.billingAddress.street, postcode: same.billingAddress.postcode, city: same.billingAddress.city, country: same.billingAddress.country }, { street: 'Tuinstraat 1', postcode: '8071 AB', city: 'Nunspeet', country: 'NL' });

  // Afwijkend: vinkje uit, eigen velden voor het afleveradres.
  await addToCart(base, customer, 'SPR-1', 1);
  const different = { ...CHECKOUT, street: 'Tuinstraat 3', deliveryForm: '1', deliveryStreet: 'Tuinstraat 2', deliveryPostcode: '8071ab', deliveryCity: 'Nunspeet' };
  assert.strictEqual((await postCheckout(base, customer, { ...different, deliveryStreet: '' })).status, 400, 'afleveradres is verplicht als het afwijkt');
  const missing = await postCheckout(base, customer, { ...different, deliveryPostcode: '' });
  assert.strictEqual(missing.status, 400);
  assert.match(missing.text, /postcode in/);
  const unknown = await postCheckout(base, customer, { ...different, deliveryStreet: 'Onbekendlaan 9', deliveryPostcode: '8071 ZZ' });
  assert.strictEqual(unknown.status, 400);
  assert.match(unknown.text, /afleveradres niet gevonden/);
  const mailsBefore = sent.length;
  assert.strictEqual((await postCheckout(base, customer, different)).status, 303);
  const placed = (await admin.get('/app/api/admin/web-orders')).body.items.find((order) => order.id !== first.id);
  const detail = (await admin.get(`/app/api/admin/web-orders/${placed.id}`)).body.order;
  assert.strictEqual(detail.deliverySame, false);
  assert.strictEqual(detail.address.street, 'Tuinstraat 2', 'afleveradres = verzendadres');
  assert.strictEqual(detail.billingAddress.street, 'Tuinstraat 3');
  assert.strictEqual(detail.address.unverified, undefined);
  const confirmation = sent.slice(mailsBefore).map((message) => message.text).find((text) => /Afleveradres/.test(text));
  assert.match(confirmation, /Afleveradres:[\s\S]*Tuinstraat 2[\s\S]*Factuuradres:[\s\S]*Tuinstraat 3/);
  const orderPage = await customer.get(`/bestelling/${placed.id}/`);
  assert.match(orderPage.text, /<strong>Afleveradres<\/strong><br>[^]*Tuinstraat 2/);
  assert.match(orderPage.text, /<strong>Factuuradres<\/strong><br>[^]*Tuinstraat 3/);
});

test('afleveradres: een niet gevonden afleveradres kan met "zelf invullen" en krijgt alleen zelf de markering niet gecontroleerd', async () => {
  const { base, admin, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 1);
  const fields = { ...CHECKOUT, deliveryForm: '1', deliveryStreet: 'Nieuwbouwlaan 7', deliveryPostcode: '8071 ZZ', deliveryCity: 'Nunspeet', deliveryAddressManual: 'ja' };
  assert.strictEqual((await postCheckout(base, customer, fields)).status, 303);
  const [item] = (await admin.get('/app/api/admin/web-orders')).body.items;
  const order = (await admin.get(`/app/api/admin/web-orders/${item.id}`)).body.order;
  assert.strictEqual(order.address.street, 'Nieuwbouwlaan 7');
  assert.strictEqual(order.address.unverified, true);
  assert.strictEqual(order.billingAddress.unverified, undefined, 'het factuuradres is wel gevonden');
});

test('afleveradres: bij ophalen is geen adres nodig; sanitizeCheckout en een oudere aanroep zonder veld gelden als gelijk', () => {
  const base = { name: 'Piet', email: 'piet@voorbeeld.nl', street: 'Tuinstraat 1', postcode: '8071 AB', city: 'Nunspeet' };
  assert.strictEqual(sanitizeCheckout(base).value.deliverySame, true, 'zonder deliveryForm: gelijk');
  assert.strictEqual(sanitizeCheckout({ ...base, deliveryForm: '1' }).error, 'Vul de straat en het huisnummer van het afleveradres in.');
  assert.strictEqual(sanitizeCheckout({ ...base, deliveryForm: '1', deliverySame: 'ja' }).value.deliverySame, true);
  assert.strictEqual(sanitizeCheckout({ name: 'Piet', email: 'piet@voorbeeld.nl', deliveryForm: '1' }, { method: 'ophalen' }).value.deliverySame, false, 'bij ophalen wordt niets gevraagd');
  const foreign = sanitizeCheckout({ ...base, postcode: '1000', deliveryForm: '1', deliveryStreet: 'Rue 1', deliveryPostcode: '1000', deliveryCity: 'Brussel' }, { country: 'BE', billingCountry: 'BE' });
  assert.strictEqual(foreign.value.deliveryStreet, 'Rue 1');
  const badCountry = sanitizeCheckout({ ...base, deliveryForm: '1', deliveryStreet: 'Rue 1', deliveryPostcode: 'x', deliveryCity: 'Brussel' }, { country: 'BE', billingCountry: 'NL' });
  assert.strictEqual(badCountry.field, 'deliveryPostcode');
});

test('afleveradres: factuuradres in Nederland (PDOK) met een afleveradres in België (zelf getypt); een ander factuurland moet bij de bezorgbare landen horen', async () => {
  const { base, admin, shopper } = await setup();
  assert.strictEqual((await admin.put('/app/api/admin/settings', { shopShipping: { pickup: { enabled: true }, dpd: { enabled: true, defaultWeightGrams: 1000, zones: [
    { country: 'NL', tiers: [{ upToGrams: 2000, price: 6.95 }] }, { country: 'BE', tiers: [{ upToGrams: 5000, price: 14.5 }] },
  ] } } })).status, 200);
  const customer = await shopper();
  await addToCart(base, customer, 'SPR-1', 1);
  const fields = { ...CHECKOUT, street: 'Tuinstraat 1', deliveryForm: '1', country: 'BE', billingCountry: 'NL', deliveryStreet: 'Rue de la Loi 16', deliveryPostcode: '1000', deliveryCity: 'Brussel' };
  const refused = await postCheckout(base, customer, { ...fields, billingCountry: 'XX' });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.text, /land voor het factuuradres/);
  assert.strictEqual((await postCheckout(base, customer, fields)).status, 303);
  const [item] = (await admin.get('/app/api/admin/web-orders')).body.items;
  const order = (await admin.get(`/app/api/admin/web-orders/${item.id}`)).body.order;
  assert.strictEqual(order.deliverySame, false);
  assert.strictEqual(order.address.country, 'BE');
  assert.strictEqual(order.address.street, 'Rue de la Loi 16');
  assert.strictEqual(order.billingAddress.country, 'NL');
  assert.strictEqual(order.billingAddress.postcode, '8071 AB', 'het Nederlandse factuuradres is bij PDOK gecontroleerd');
});
