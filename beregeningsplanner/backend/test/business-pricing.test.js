// Zakelijke klanten in de eigen webshop: klantgroep, zakelijke prijs excl. btw,
// bedrijfsnaam en btw-nummer, btw verleggen binnen de EU en de rechten daarop.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const Vat = require('../src/webshop/vat');
const { totalsOf } = require('../src/webshop/web-orders');
const { createLogin, createClient, listen, postForm, postCheckout } = require('./helpers/http-client');

const SECRET = 'f'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/** Afrekengegevens van een bedrijf in Nederland. */
const COMPANY = { name: 'Els Bakker', company: 'Bakker Tuinen BV', email: 'els@bakker.example', phone: '', street: 'Tuinstraat 1', postcode: '8071 AB', city: 'Nunspeet', note: '', shippingMethod: 'dpd', country: 'NL', action: 'place' };

test('btw-nummer: formaat, landvoorvoegsel en verleggen', () => {
  assert.strictEqual(Vat.normalizeVatNumber(' be 0123.456.789 '), 'BE0123456789');
  assert.ok(Vat.validVatNumber('BE0123456789') && Vat.validVatNumber('NL123456789B01') && Vat.validVatNumber('DE123456789') && Vat.validVatNumber('EL123456789'));
  assert.ok(!Vat.validVatNumber(Vat.normalizeVatNumber('SE123456789012XYZ')), 'te lang wordt niet afgekapt tot geldig');
  assert.ok(!Vat.validVatNumber('BE12') && !Vat.validVatNumber('XX123456789') && !Vat.validVatNumber(''));
  assert.ok(Vat.vatShifted({ group: 'zakelijk', method: 'dpd', country: 'BE', vatNumber: 'BE0123456789' }));
  assert.ok(Vat.vatShifted({ group: 'zakelijk', method: 'dpd', country: 'GR', vatNumber: 'EL123456789' }), 'Griekenland gebruikt EL');
  assert.ok(!Vat.vatShifted({ group: 'zakelijk', method: 'dpd', country: 'EL', vatNumber: 'EL123456789' }), 'EL is geen bestemmingscode');
  assert.ok(!Vat.vatShifted({ group: 'zakelijk', method: 'dpd', country: 'NL', vatNumber: 'NL123456789B01' }), 'Nederland: gewoon btw');
  assert.ok(!Vat.vatShifted({ group: 'zakelijk', method: 'dpd', country: 'BE', vatNumber: 'DE123456789' }), 'nummer van een ander land');
  assert.ok(!Vat.vatShifted({ group: 'zakelijk', method: 'ophalen', country: 'NL', vatNumber: 'BE0123456789' }), 'ophalen is een levering in Nederland');
  assert.ok(!Vat.vatShifted({ group: '', method: 'dpd', country: 'BE', vatNumber: 'BE0123456789' }), 'particulier');
});

test('totalsOf rekent vanuit het bedrag excl. btw als alle regels dat hebben', () => {
  const totals = totalsOf([{ vatRate: 21, lineExcl: 16, lineTotal: 19.36 }, { vatRate: 21, lineExcl: 5.74, lineTotal: 6.95 }]);
  assert.deepStrictEqual(totals.byRate, [{ rate: 21, excl: 21.74, vat: 4.57, incl: 26.31 }]);
  assert.strictEqual(totalsOf([{ vatRate: 21, lineTotal: 12.1 }]).byRate[0].excl, 10);
});

/**
 * Hoofdtenant met beheerder, een artikel met zakelijke prijs en een zakelijke en particuliere klant.
 * @returns {Promise<object>} base, admin, vreemd, klant (zakelijk), particulier en users.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ secret: SECRET, db, mailerFor: () => ({ configured: () => false, send: async () => {} }) }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  await admin.put('/api/admin/settings', { storefront: true, shopOrdering: true, shopShipping: {
    pickup: { enabled: true }, dpd: { enabled: true, defaultWeightGrams: 1000, zones: [
      { country: 'NL', tiers: [{ upToGrams: 2000, price: 6.95 }] }, { country: 'BE', tiers: [{ upToGrams: 5000, price: 14.5 }] },
    ] },
  } });
  assert.strictEqual((await admin.post('/api/stock/items', { code: 'BUS', name: 'Sproeier zakelijk', onHand: 50, salePrice: 10, businessPrice: 8, weightGrams: 400 })).status, 201);
  assert.strictEqual((await admin.post('/api/stock/items', { code: 'GEEN', name: 'Zonder zakelijke prijs', onHand: 50, salePrice: 5, weightGrams: 100 })).status, 201);
  let counter = 0;
  /**
   * Registreert een klant in de shop.
   * @returns {Promise<object>} client en het gebruikers-id.
   */
  const shopper = async () => {
    counter += 1;
    const client = createClient(base);
    await postForm(base, client, '/winkel/registreren/', { displayName: `Klant ${counter}`, email: `k${counter}@voorbeeld.nl`, password: PW, password2: PW, website: '' });
    const users = (await admin.get('/api/admin/users')).body.items;
    return { client, id: users.find((user) => user.email === `k${counter}@voorbeeld.nl`).id };
  };
  const business = await shopper();
  assert.strictEqual((await admin.patch(`/api/admin/users/${business.id}`, { customerGroup: 'zakelijk' })).status, 200);
  const private1 = await shopper();
  return { base, admin, vreemd: await createLogin(base, { password: PW })('vreemd', 'ander'), business, private1 };
}

/**
 * Legt een artikel in de winkelwagen.
 * @param {string} base Adres van de testserver.
 * @param {object} client De client.
 * @param {string} code Artikelcode.
 * @param {number} qty Aantal.
 * @returns {Promise<void>}
 */
async function addToCart(base, client, code, qty) {
  assert.strictEqual((await postForm(base, client, '/winkel/winkelwagen/', { action: 'add', code, qty: String(qty) })).status, 303);
}

test('zakelijke klant ziet prijzen excl. btw en betaalt de zakelijke prijs; particulier niet', async () => {
  const { base, admin, business, private1 } = await setup();
  await addToCart(base, business.client, 'BUS', 2);
  await addToCart(base, business.client, 'GEEN', 1);
  const cart = await business.client.get('/winkel/winkelwagen/');
  assert.match(cart.text, /Prijs excl\. btw/);
  assert.match(cart.text, /€\s8,00/, 'zakelijke prijs');
  assert.match(cart.text, /€\s5,00/, 'zonder zakelijke prijs geldt de verkoopprijs');
  assert.match(cart.text, /Totaal excl\. btw/);
  await addToCart(base, private1.client, 'BUS', 2);
  const own = await private1.client.get('/winkel/winkelwagen/');
  assert.doesNotMatch(own.text, /excl\. btw/);
  assert.match(own.text, /€\s12,10/);
  assert.strictEqual((await admin.get('/api/stock')).body.items.find((item) => item.code === 'BUS').businessPrice, 8);
});

test('zakelijke bestelling: bedrijfsnaam verplicht, btw-nummer gecontroleerd en btw in Nederland gewoon berekend', async () => {
  const { base, admin, business } = await setup();
  await addToCart(base, business.client, 'BUS', 2);
  assert.strictEqual((await postCheckout(base, business.client, { ...COMPANY, company: '' })).status, 400);
  const badVat = await postCheckout(base, business.client, { ...COMPANY, vatNumber: 'ABC' });
  assert.strictEqual(badVat.status, 400);
  assert.match(badVat.text, /btw-nummer/);
  const placed = await postCheckout(base, business.client, { ...COMPANY, vatNumber: 'nl 1234.56789 b01' });
  assert.strictEqual(placed.status, 303, placed.text);
  const orderId = (await admin.get('/api/admin/web-orders')).body.items[0].id;
  const order = (await admin.get(`/api/admin/web-orders/${orderId}`)).body.order;
  assert.strictEqual(order.customerGroup, 'zakelijk');
  assert.deepStrictEqual(order.vat, { number: 'NL123456789B01', shifted: false });
  assert.strictEqual(order.total, 26.31, '2 × 8,00 + DPD 6,95 incl. btw');
  assert.strictEqual(order.lines[0].lineExcl, 16);
  assert.strictEqual(order.totals.byRate[0].excl, 21.74);
  const page = await business.client.get(`/winkel/${placed.location.slice(3)}`);
  assert.match(page.text, /Totaal excl\. btw/);
});

test('btw verlegd naar een bedrijf met btw-nummer in een ander EU-land', async () => {
  const { base, admin, business } = await setup();
  await addToCart(base, business.client, 'BUS', 2);
  const preview = await postForm(base, business.client, '/winkel/afrekenen/', { ...COMPANY, postcode: '9000', country: 'BE', vatNumber: 'BE0123456789', action: 'update' });
  assert.strictEqual(preview.status, 200);
  assert.match(preview.text, /Btw verlegd/);
  const placed = await postCheckout(base, business.client, { ...COMPANY, postcode: '9000', country: 'BE', vatNumber: 'BE0123456789' });
  assert.strictEqual(placed.status, 303, placed.text);
  const orderId = (await admin.get('/api/admin/web-orders')).body.items[0].id;
  const order = (await admin.get(`/api/admin/web-orders/${orderId}`)).body.order;
  assert.strictEqual(order.vat.shifted, true);
  assert.match((await business.client.get(`/winkel/${placed.location.slice(3)}`)).text, /Totaal \(btw verlegd\)/);
  assert.strictEqual(order.total, 27.98, '2 × 8,00 + verzending 11,98 zonder btw');
  assert.deepStrictEqual(order.totals.byRate.map((row) => [row.rate, row.vat]), [[0, 0]]);
  assert.strictEqual(order.lines[0].vatRate, 0);
  // Zonder btw-nummer van België geen verlegging.
  await addToCart(base, business.client, 'BUS', 2);
  const plain = await postCheckout(base, business.client, { ...COMPANY, postcode: '9000', country: 'BE' });
  assert.strictEqual(plain.status, 303);
  const second = (await admin.get('/api/admin/web-orders')).body.items.find((item) => item.id !== orderId);
  assert.strictEqual((await admin.get(`/api/admin/web-orders/${second.id}`)).body.order.vat.shifted, false);
});

test('verouderd totaal: eerst opnieuw tonen, pas daarna bestellen', async () => {
  const { base, admin, business } = await setup();
  await addToCart(base, business.client, 'BUS', 2);
  const fields = { ...COMPANY, postcode: '9000', country: 'BE', vatNumber: 'BE0123456789' };
  const stale = await postForm(base, business.client, '/winkel/afrekenen/', { ...fields, expectedTotal: '38.7' });
  assert.strictEqual(stale.status, 200, 'niet geplaatst');
  assert.match(stale.text, /Het totaal is bijgewerkt/);
  assert.strictEqual((await admin.get('/api/admin/web-orders')).body.items.length, 0);
  const missing = await postForm(base, business.client, '/winkel/afrekenen/', fields);
  assert.strictEqual(missing.status, 200, 'zonder totaal ook niet geplaatst');
  const invalid = await postForm(base, business.client, '/winkel/afrekenen/', { ...fields, expectedTotal: 'abc' });
  assert.strictEqual(invalid.status, 200, 'ongeldig totaal ook niet geplaatst');
  const shown = stale.text.match(/name="expectedTotal" value="([^"]+)"/);
  assert.ok(shown, 'actueel totaal ontbreekt in het formulier');
  assert.strictEqual(shown[1], '27.98');
  const placed = await postForm(base, business.client, '/winkel/afrekenen/', { ...fields, expectedTotal: shown[1] });
  assert.strictEqual(placed.status, 303, placed.text);
});

test('particulier met btw-nummer in het formulier: genegeerd, gewoon btw', async () => {
  const { base, admin, private1 } = await setup();
  await addToCart(base, private1.client, 'BUS', 2);
  const placed = await postCheckout(base, private1.client, { ...COMPANY, company: '', postcode: '9000', country: 'BE', vatNumber: 'BE0123456789' });
  assert.strictEqual(placed.status, 303, placed.text);
  const orderId = (await admin.get('/api/admin/web-orders')).body.items[0].id;
  const order = (await admin.get(`/api/admin/web-orders/${orderId}`)).body.order;
  assert.strictEqual(order.customerGroup, '');
  assert.strictEqual(order.vat, null);
  assert.strictEqual(order.total, 38.7, '2 × 12,10 + DPD België 14,50');
});

test('klantgroep wijzigen: alleen met recht, geldige waarde, andere organisatie 404', async () => {
  const { admin, vreemd, business, private1 } = await setup();
  assert.strictEqual((await admin.patch(`/api/admin/users/${private1.id}`, { customerGroup: 'vip' })).status, 400);
  assert.strictEqual((await private1.client.patch(`/api/admin/users/${private1.id}`, { customerGroup: 'zakelijk' })).status, 403, 'een klant kiest zijn groep niet zelf');
  assert.strictEqual((await vreemd.patch(`/api/admin/users/${business.id}`, { customerGroup: '' })).status, 404);
  assert.strictEqual((await admin.patch(`/api/admin/users/${business.id}`, { customerGroup: '' })).body.customerGroup, '');
});
