// Verzending in de eigen webshop: tarieven en opties (shipping.js) en het
// bestellen met ophalen of DPD (gewicht, gratis vanaf, volgcode, rechten).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const Shipping = require('../src/webshop/shipping');
const { createLogin, createClient, listen, postForm, postCheckout } = require('./helpers/http-client');

const SECRET = 'e'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/** Afrekengegevens die kloppen (zonder verzending). */
const FIELDS = { name: 'Piet Tuin', company: '', email: 'piet@voorbeeld.nl', phone: '', street: 'Tuinstraat 1', postcode: '8071 AB', city: 'Nunspeet', note: '' };

test('sanitizeShipping: lege invoer geeft de startwaarden, rommel wordt opgeschoond', () => {
  assert.deepStrictEqual(Shipping.sanitizeShipping({}), Shipping.DEFAULT_CONFIG);
  assert.deepStrictEqual(Shipping.sanitizeShipping('x'), Shipping.DEFAULT_CONFIG);
  const config = Shipping.sanitizeShipping({
    pickup: { enabled: false, label: '  Afhalen  ', note: 'Maandag open' },
    dpd: { enabled: true, defaultWeightGrams: 500, zones: [
      { country: 'be', name: '', freeFrom: '200', tiers: [{ upToGrams: 5000, price: 9 }, { upToGrams: 2000, price: 7.5 }, { upToGrams: 2000, price: 1 }, { upToGrams: -1, price: 1 }, { upToGrams: 100, price: -2 }] },
      { country: 'BE', name: 'dubbel', tiers: [] }, { country: 'x1', tiers: [] },
    ] },
  });
  assert.strictEqual(config.pickup.enabled, false);
  assert.strictEqual(config.pickup.label, 'Afhalen');
  assert.strictEqual(config.dpd.zones.length, 1);
  assert.deepStrictEqual(config.dpd.zones[0], { country: 'BE', name: 'België', freeFrom: 200, tiers: [{ upToGrams: 2000, price: 7.5 }, { upToGrams: 5000, price: 9 }] });
});

test('optionsFor: tarief per gewicht, gratis vanaf, te zwaar en onbekend land', () => {
  const config = Shipping.DEFAULT_CONFIG;
  /**
   * De DPD-optie voor een winkelwagen.
   * @param {object} basket Land, gewicht en bedrag.
   * @returns {object} De DPD-optie.
   */
  const dpd = (basket) => Shipping.optionsFor(config, basket).find((option) => option.method === 'dpd');
  assert.strictEqual(Shipping.optionsFor(config, { country: 'NL', weightGrams: 100, subtotal: 10 })[0].method, 'ophalen');
  assert.strictEqual(dpd({ country: 'NL', weightGrams: 1500, subtotal: 10 }).price, 6.95);
  assert.strictEqual(dpd({ country: 'NL', weightGrams: 2001, subtotal: 10 }).price, 8.95);
  assert.strictEqual(dpd({ country: 'NL', weightGrams: 2001, subtotal: 150 }).free, true);
  assert.strictEqual(dpd({ country: 'NL', weightGrams: 2001, subtotal: 150 }).price, 0);
  const heavy = dpd({ country: 'NL', weightGrams: 30000, subtotal: 10 });
  assert.strictEqual(heavy.available, false);
  assert.match(heavy.reason, /te zwaar/);
  assert.strictEqual(dpd({ country: 'DE', weightGrams: 100, subtotal: 10 }).available, false);
});

test('weightOf, validPostcode en trackingOf', () => {
  const config = Shipping.DEFAULT_CONFIG;
  assert.strictEqual(Shipping.weightOf([{ qty: 2, weightGrams: 300 }, { qty: 1, weightGrams: null }], config), 1600);
  assert.ok(Shipping.validPostcode('NL', '8071 AB') && !Shipping.validPostcode('NL', '8071'));
  assert.ok(Shipping.validPostcode('BE', '9000') && !Shipping.validPostcode('DE', '123'));
  assert.deepStrictEqual(Shipping.trackingOf(' 01 5 0123456 78 '), { code: '015012345678', url: 'https://tracking.dpd.de/status/nl_NL/parcel/015012345678' });
  assert.strictEqual(Shipping.trackingOf('12'), null);
  assert.strictEqual(Shipping.trackingOf('<script>'), null);
});

/**
 * Hoofdtenant met beheerder, webshop met bestellen aan en artikelen met gewicht.
 * @returns {Promise<object>} base, admin, vreemd en shopper().
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
  const saved = await admin.put('/api/admin/settings', { storefront: true, shopOrdering: true, shopShipping: {
    pickup: { enabled: true, label: 'Ophalen in Nunspeet', note: 'Ma-vr 8-17 uur' },
    dpd: { enabled: true, defaultWeightGrams: 1000, zones: [
      { country: 'NL', name: 'Nederland', freeFrom: 100, tiers: [{ upToGrams: 2000, price: 6.95 }, { upToGrams: 10000, price: 11.95 }] },
      { country: 'BE', name: 'België', freeFrom: 0, tiers: [{ upToGrams: 5000, price: 14.5 }] },
    ] },
  } });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  for (const item of [
    { code: 'LICHT', name: 'Licht artikel', onHand: 50, salePrice: 10, weightGrams: 400 },
    { code: 'ZWAAR', name: 'Zware pomp', onHand: 5, salePrice: 20, weightGrams: 12000 },
  ]) assert.strictEqual((await admin.post('/api/stock/items', item)).status, 201);
  let counter = 0;
  /**
   * Registreert een klant en geeft zijn client terug.
   * @returns {Promise<object>} De ingelogde client.
   */
  const shopper = async () => {
    counter += 1;
    const client = createClient(base);
    await postForm(base, client, '/winkel/registreren/', { displayName: `Klant ${counter}`, email: `k${counter}@voorbeeld.nl`, password: PW, password2: PW, website: '' });
    return client;
  };
  return { base, admin, vreemd: await createLogin(base, { password: PW })('vreemd', 'ander'), shopper };
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

test('afrekenen: ophalen, DPD met tarief, gratis vanaf, te zwaar en ander land', async () => {
  const { base, admin, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'LICHT', 2);
  const page = await customer.get('/winkel/afrekenen/');
  assert.match(page.text, /Ophalen in Nunspeet/);
  assert.match(page.text, /Ma-vr 8-17 uur/);
  assert.match(page.text, /€ 6,95/);
  assert.match(page.text, /Gratis bezorging vanaf €\s100,00/);
  assert.match(page.text, /name="country"/);
  const be = await postForm(base, customer, '/winkel/afrekenen/', { ...FIELDS, action: 'update', country: 'BE' });
  assert.strictEqual(be.status, 200);
  assert.match(be.text, /€ 14,50/);
  // Ophalen: geen adres nodig, gratis.
  const pickup = await postCheckout(base, customer, { name: 'Piet Tuin', email: 'piet@voorbeeld.nl', shippingMethod: 'ophalen', country: 'NL', action: 'place' });
  assert.strictEqual(pickup.status, 303, pickup.text);
  const pickupOrder = (await admin.get('/api/admin/web-orders')).body.items[0];
  const pickupDetail = (await admin.get(`/api/admin/web-orders/${pickupOrder.id}`)).body.order;
  assert.strictEqual(pickupDetail.total, 24.2);
  assert.strictEqual(pickupDetail.shipping.method, 'ophalen');
  assert.strictEqual(pickupDetail.address.street, '');
  // DPD binnen Nederland: 800 g valt in de klasse t/m 2 kg.
  await addToCart(base, customer, 'LICHT', 2);
  const dpd = await postCheckout(base, customer, { ...FIELDS, shippingMethod: 'dpd', country: 'NL', action: 'place' });
  assert.strictEqual(dpd.status, 303, dpd.text);
  const dpdOrder = (await admin.get('/api/admin/web-orders')).body.items.find((order) => order.id !== pickupOrder.id);
  const dpdDetail = (await admin.get(`/api/admin/web-orders/${dpdOrder.id}`)).body.order;
  assert.strictEqual(dpdDetail.total, 31.15, '2 × 12,10 + 6,95 verzending');
  assert.deepStrictEqual([dpdDetail.shipping.price, dpdDetail.shipping.free, dpdDetail.shipping.weightGrams], [6.95, false, 800]);
  assert.strictEqual(dpdDetail.address.country, 'NL');
  // Gratis vanaf € 100.
  await addToCart(base, customer, 'LICHT', 10);
  const free = await postCheckout(base, customer, { ...FIELDS, shippingMethod: 'dpd', country: 'NL', action: 'place' });
  assert.strictEqual(free.status, 303);
  const freeOrder = (await admin.get('/api/admin/web-orders')).body.items.find((order) => order.total === 121);
  assert.ok(freeOrder, 'geen verzendkosten boven € 100');
  // Te zwaar voor DPD in België, een postcode die niet bij het land past en een onbekende methode.
  await addToCart(base, customer, 'ZWAAR', 1);
  const heavy = await postCheckout(base, customer, { ...FIELDS, postcode: '9000', shippingMethod: 'dpd', country: 'BE', action: 'place' });
  assert.strictEqual(heavy.status, 400);
  assert.match(heavy.text, /te zwaar/);
  assert.strictEqual((await postCheckout(base, customer, { ...FIELDS, shippingMethod: 'dpd', country: 'FR', action: 'place' })).status, 400, 'geen tarief voor Frankrijk');
  assert.strictEqual((await postCheckout(base, customer, { ...FIELDS, shippingMethod: 'post', action: 'place' })).status, 400);
  assert.strictEqual((await postCheckout(base, customer, { ...FIELDS, postcode: '9000', shippingMethod: 'dpd', country: 'NL', action: 'place' })).status, 400, 'Belgische postcode in Nederland');
});

test('volgcode: bij verzonden of achteraf, alleen bij DPD; rechten en andere organisatie', async () => {
  const { base, admin, vreemd, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'LICHT', 1);
  const placed = await postCheckout(base, customer, { ...FIELDS, shippingMethod: 'dpd', country: 'NL', action: 'place' });
  assert.strictEqual(placed.status, 303);
  const orderId = (await admin.get('/api/admin/web-orders')).body.items[0].id;
  const tracking = `/api/admin/web-orders/${orderId}/tracking`;
  assert.strictEqual((await admin.post(tracking, { trackingCode: '015012345678' })).status, 409, 'nog niet verzonden');
  const bad = await admin.post(`/api/admin/web-orders/${orderId}/status`, { status: 'verzonden', trackingCode: '<x>' });
  assert.strictEqual(bad.status, 400);
  const shipped = await admin.post(`/api/admin/web-orders/${orderId}/status`, { status: 'verzonden', trackingCode: '015012345678' });
  assert.strictEqual(shipped.status, 200);
  assert.strictEqual(shipped.body.order.shipping.tracking.code, '015012345678');
  const page = await customer.get(`/winkel/${placed.location.slice(3)}`);
  assert.match(page.text, /tracking\.dpd\.de\/status\/nl_NL\/parcel\/015012345678/);
  const changed = await admin.post(tracking, { trackingCode: 'ABCDEF123456' });
  assert.strictEqual(changed.body.order.shipping.tracking.code, 'ABCDEF123456');
  assert.strictEqual((await admin.post(tracking, { trackingCode: '' })).body.order.shipping.tracking, null);
  assert.strictEqual((await admin.post(tracking, { trackingCode: '1' })).status, 400);
  assert.strictEqual((await customer.post(tracking, { trackingCode: '015012345678' })).status, 403);
  assert.strictEqual((await vreemd.post(tracking, { trackingCode: '015012345678' })).status, 404);
  // Ophalen heeft geen volgcode.
  await addToCart(base, customer, 'LICHT', 1);
  await postCheckout(base, customer, { name: 'Piet Tuin', email: 'piet@voorbeeld.nl', shippingMethod: 'ophalen', action: 'place' });
  const pickupId = (await admin.get('/api/admin/web-orders')).body.items.find((order) => order.id !== orderId).id;
  await admin.post(`/api/admin/web-orders/${pickupId}/status`, { status: 'verzonden' });
  assert.strictEqual((await admin.post(`/api/admin/web-orders/${pickupId}/tracking`, { trackingCode: '015012345678' })).status, 409);
});

test('verzendinstelling: alleen de hoofdtenant en het gewicht van een artikel', async () => {
  const { admin, vreemd } = await setup();
  const item = (await admin.get('/api/stock')).body.items.find((entry) => entry.code === 'ZWAAR');
  assert.strictEqual(item.weightGrams, 12000);
  assert.strictEqual((await admin.put(`/api/stock/items/${item.id}`, { weightGrams: 9000 })).body.weightGrams, 9000);
  assert.strictEqual((await admin.put(`/api/stock/items/${item.id}`, { weightGrams: -5 })).status, 400);
  const own = await vreemd.put('/api/admin/settings', { shopShipping: { pickup: { enabled: false }, dpd: { enabled: false } } });
  assert.notStrictEqual(own.status, 200, 'een andere organisatie mag de webshopverzending niet instellen');
});
