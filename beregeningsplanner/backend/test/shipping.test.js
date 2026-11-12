// Verzending in de eigen webshop: tarieven en opties (shipping.js) en het
// bestellen met ophalen of DPD (gewicht, gratis vanaf, volgcode, rechten).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
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
  assert.deepStrictEqual(Shipping.optionsFor(config, { country: 'NL', weightGrams: 100, subtotal: 10 }).map((option) => option.method), ['dpd', 'ophalen'], 'afhalen staat achteraan');
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
 * @param {?object} [shipping] De verzendinstelling; zonder de standaardinstelling van deze tests (afhalen en DPD in Nederland en België).
 * @returns {Promise<object>} base, admin, vreemd en shopper().
 */
async function setup(shipping = null) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db, mailerFor: () => ({ configured: () => false, send: async () => {} }) }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  const saved = await admin.put('/app/api/admin/settings', { storefront: true, shopOrdering: true, shopShipping: shipping || {
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
  ]) assert.strictEqual((await admin.post('/app/api/stock/items', item)).status, 201);
  let counter = 0;
  /**
   * Registreert een klant en geeft zijn client terug.
   * @returns {Promise<object>} De ingelogde client.
   */
  const shopper = async () => {
    counter += 1;
    const client = createClient(base);
    await postForm(base, client, '/registreren/', { displayName: `Klant ${counter}`, email: `k${counter}@voorbeeld.nl`, password: PW, password2: PW, website: '' });
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
  assert.strictEqual((await postForm(base, client, '/winkelwagen/', { action: 'add', code, qty: String(qty) })).status, 303);
}

test('afrekenen: ophalen, DPD met tarief, gratis vanaf, te zwaar en ander land', async () => {
  const { base, admin, shopper } = await setup();
  const customer = await shopper();
  await addToCart(base, customer, 'LICHT', 2);
  const page = await customer.get('/afrekenen/');
  assert.match(page.text, /Ophalen in Nunspeet/);
  assert.match(page.text, /Ma-vr 8-17 uur/);
  assert.match(page.text, /€ 6,95/);
  assert.match(page.text, /Gratis bezorging vanaf €\s100,00/);
  assert.match(page.text, /name="country"/);
  // Per verzendmethode de totalen voor het script, zodat een andere keuze het overzicht direct bijwerkt.
  assert.match(page.text, /data-ship-label="[^"]*\(incl\. btw\)"/, 'verzendkosten met btw-vermelding');
  assert.match(page.text, /data-total="\d+(\.\d+)?"/);
  assert.match(page.text, /afrekenen\.js/);
  assert.match(page.text, /data-expected-total/);
  const script = await customer.get('/assets/afrekenen.js');
  assert.strictEqual(script.status, 200);
  assert.match(script.text, /showChosenShipping/);
  assert.match(page.text, /data-shipping-options/, 'de verzendopties staan in een eigen onderdeel dat op de achtergrond wordt ververst');
  assert.match(script.text, /refreshTotals/, 'land en btw-nummer werken het totaal op de achtergrond bij');
  assert.match(script.text, /getAttribute\('action'\)/, 'form.action zou de knop met naam action teruggeven in plaats van het adres');
  // De achtergrondberekening stuurt alleen land, methode en btw-nummer en gebruikt alleen de onderdelen uit het antwoord.
  const background = await postForm(base, customer, '/afrekenen/', { action: 'update', country: 'BE', shippingMethod: 'dpd' });
  assert.strictEqual(background.status, 200);
  assert.match(background.text, /data-shipping-options/);
  assert.match(background.text, /value="\d+(\.\d+)?" data-expected-total/);
  const be = await postForm(base, customer, '/afrekenen/', { ...FIELDS, action: 'update', country: 'BE' });
  assert.strictEqual(be.status, 200);
  assert.match(be.text, /€ 14,50/);
  // Ophalen: geen adres nodig, gratis.
  const pickup = await postCheckout(base, customer, { name: 'Piet Tuin', email: 'piet@voorbeeld.nl', shippingMethod: 'ophalen', country: 'NL', action: 'place' });
  assert.strictEqual(pickup.status, 303, pickup.text);
  const pickupOrder = (await admin.get('/app/api/admin/web-orders')).body.items[0];
  const pickupDetail = (await admin.get(`/app/api/admin/web-orders/${pickupOrder.id}`)).body.order;
  assert.strictEqual(pickupDetail.total, 24.2);
  assert.strictEqual(pickupDetail.shipping.method, 'ophalen');
  assert.strictEqual(pickupDetail.address.street, '');
  // DPD binnen Nederland: 800 g valt in de klasse t/m 2 kg.
  await addToCart(base, customer, 'LICHT', 2);
  const dpd = await postCheckout(base, customer, { ...FIELDS, shippingMethod: 'dpd', country: 'NL', action: 'place' });
  assert.strictEqual(dpd.status, 303, dpd.text);
  const dpdOrder = (await admin.get('/app/api/admin/web-orders')).body.items.find((order) => order.id !== pickupOrder.id);
  const dpdDetail = (await admin.get(`/app/api/admin/web-orders/${dpdOrder.id}`)).body.order;
  assert.strictEqual(dpdDetail.total, 31.15, '2 × 12,10 + 6,95 verzending');
  assert.deepStrictEqual([dpdDetail.shipping.price, dpdDetail.shipping.free, dpdDetail.shipping.weightGrams], [6.95, false, 800]);
  assert.strictEqual(dpdDetail.address.country, 'NL');
  // Gratis vanaf € 100.
  await addToCart(base, customer, 'LICHT', 10);
  const free = await postCheckout(base, customer, { ...FIELDS, shippingMethod: 'dpd', country: 'NL', action: 'place' });
  assert.strictEqual(free.status, 303);
  const freeOrder = (await admin.get('/app/api/admin/web-orders')).body.items.find((order) => order.total === 121);
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
  const orderId = (await admin.get('/app/api/admin/web-orders')).body.items[0].id;
  const tracking = `/app/api/admin/web-orders/${orderId}/tracking`;
  assert.strictEqual((await admin.post(tracking, { trackingCode: '015012345678' })).status, 409, 'nog niet verzonden');
  const bad = await admin.post(`/app/api/admin/web-orders/${orderId}/status`, { status: 'verzonden', trackingCode: '<x>' });
  assert.strictEqual(bad.status, 400);
  const shipped = await admin.post(`/app/api/admin/web-orders/${orderId}/status`, { status: 'verzonden', trackingCode: '015012345678' });
  assert.strictEqual(shipped.status, 200);
  assert.strictEqual(shipped.body.order.shipping.tracking.code, '015012345678');
  const page = await customer.get(`/${placed.location.slice(3)}`);
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
  const pickupId = (await admin.get('/app/api/admin/web-orders')).body.items.find((order) => order.id !== orderId).id;
  await admin.post(`/app/api/admin/web-orders/${pickupId}/status`, { status: 'verzonden' });
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${pickupId}/tracking`, { trackingCode: '015012345678' })).status, 409);
});

test('verzendinstelling: alleen de hoofdtenant en het gewicht van een artikel', async () => {
  const { admin, vreemd } = await setup();
  const item = (await admin.get('/app/api/stock')).body.items.find((entry) => entry.code === 'ZWAAR');
  assert.strictEqual(item.weightGrams, 12000);
  assert.strictEqual((await admin.put(`/app/api/stock/items/${item.id}`, { weightGrams: 9000 })).body.weightGrams, 9000);
  assert.strictEqual((await admin.put(`/app/api/stock/items/${item.id}`, { weightGrams: -5 })).status, 400);
  const own = await vreemd.put('/app/api/admin/settings', { shopShipping: { pickup: { enabled: false }, dpd: { enabled: false } } });
  assert.notStrictEqual(own.status, 200, 'een andere organisatie mag de webshopverzending niet instellen');
});

test('sanitizeShipping: pallet en eigen transport staan uit, afhalen heet standaard Afhalen in Nunspeet', () => {
  const defaults = Shipping.sanitizeShipping({});
  assert.strictEqual(defaults.pickup.label, 'Afhalen in Nunspeet');
  assert.deepStrictEqual([defaults.dpd.enabled, defaults.pallet.enabled, defaults.eigen.enabled], [true, false, false]);
  // Alleen afhalen ingevuld: DPD blijft aan (zoals altijd), pallet en eigen transport alleen als ze expres aan gaan.
  const partial = Shipping.sanitizeShipping({ pickup: { enabled: true, label: '  ' }, pallet: { enabled: true, label: ' Pallet Nunspeet ', zones: [{ country: 'nl', freeFrom: 0, tiers: [{ upToGrams: 500000, price: 95 }] }] }, eigen: { enabled: 'ja' } });
  assert.strictEqual(partial.pickup.label, 'Afhalen in Nunspeet');
  assert.strictEqual(partial.dpd.enabled, true);
  assert.strictEqual(partial.pallet.label, 'Pallet Nunspeet');
  assert.deepStrictEqual(partial.pallet.zones, [{ country: 'NL', name: 'Nederland', freeFrom: 0, tiers: [{ upToGrams: 500000, price: 95 }] }]);
  assert.strictEqual(partial.eigen.enabled, false, 'alleen echt true zet een methode aan');
  // Het standaardgewicht staat op het hoogste niveau en valt terug op de oude plek bij DPD.
  assert.strictEqual(Shipping.sanitizeShipping({ defaultWeightGrams: 250, pickup: {} }).defaultWeightGrams, 250);
  assert.strictEqual(Shipping.sanitizeShipping({ dpd: { defaultWeightGrams: 300 } }).defaultWeightGrams, 300);
  assert.strictEqual(Shipping.sanitizeShipping({ pickup: {}, defaultWeightGrams: -4 }).defaultWeightGrams, 1000);
});

test('optionsFor, countriesOf en defaultMethod met meer bezorgmethodes', () => {
  const config = Shipping.sanitizeShipping({
    pickup: { enabled: true },
    dpd: { enabled: true, zones: [{ country: 'NL', freeFrom: 150, tiers: [{ upToGrams: 5000, price: 8 }] }] },
    pallet: { enabled: true, zones: [{ country: 'NL', tiers: [{ upToGrams: 500000, price: 95 }] }, { country: 'DE', tiers: [{ upToGrams: 500000, price: 140 }] }] },
    eigen: { enabled: true, label: 'Eigen transport Veluwe', zones: [{ country: 'NL', freeFrom: 500, tiers: [{ upToGrams: 100000, price: 45 }] }] },
  });
  assert.deepStrictEqual(Shipping.countriesOf(config).map((country) => country.code), ['NL', 'DE'], 'elk land één keer, ook als meer methodes er komen');
  const nl = Shipping.optionsFor(config, { country: 'NL', weightGrams: 20000, subtotal: 600 });
  assert.deepStrictEqual(nl.map((option) => option.method), ['dpd', 'pallet', 'eigen', 'ophalen'], 'afhalen staat achteraan');
  const byMethod = Object.fromEntries(nl.map((option) => [option.method, option]));
  assert.strictEqual(byMethod.dpd.available, false);
  assert.match(byMethod.dpd.reason, /te zwaar/);
  assert.deepStrictEqual([byMethod.pallet.price, byMethod.pallet.free], [95, false]);
  assert.deepStrictEqual([byMethod.eigen.price, byMethod.eigen.free, byMethod.eigen.label], [0, true, 'Eigen transport Veluwe'], 'gratis vanaf geldt per methode');
  assert.deepStrictEqual([byMethod.ophalen.price, byMethod.ophalen.available], [0, true]);
  const de = Shipping.optionsFor(config, { country: 'DE', weightGrams: 1000, subtotal: 10 });
  assert.deepStrictEqual(de.filter((option) => option.available).map((option) => option.method), ['pallet', 'ophalen']);
  // Afhalen is nooit de voorkeur zolang er een bezorgmethode kan; wat de klant al koos blijft staan.
  assert.strictEqual(Shipping.defaultMethod(nl), 'pallet', 'DPD kan niet, dus de volgende bezorgmethode');
  assert.strictEqual(Shipping.defaultMethod(nl, 'ophalen'), 'ophalen');
  assert.strictEqual(Shipping.defaultMethod(nl, 'dpd'), 'pallet', 'een gevraagde methode die niet kan wordt genegeerd');
  assert.strictEqual(Shipping.defaultMethod(nl, 'onzin'), 'pallet');
  assert.strictEqual(Shipping.defaultMethod([{ method: 'ophalen', available: true }]), 'ophalen', 'alleen afhalen mogelijk');
  assert.strictEqual(Shipping.defaultMethod([{ method: 'dpd', available: false }]), '');
  assert.strictEqual(Shipping.defaultMethod([]), '');
});

test('afrekenen: keuzelijst met verzendmethodes, afhalen niet vooraf gekozen', async () => {
  const { base, shopper } = await setup({
    pickup: { enabled: true, note: 'Ma-vr 8-17 uur' },
    dpd: { enabled: true, zones: [{ country: 'NL', freeFrom: 0, tiers: [{ upToGrams: 5000, price: 8 }] }] },
    pallet: { enabled: true, zones: [{ country: 'NL', freeFrom: 0, tiers: [{ upToGrams: 500000, price: 95 }] }] },
    eigen: { enabled: true, zones: [{ country: 'NL', freeFrom: 0, tiers: [{ upToGrams: 500000, price: 45 }] }] },
  });
  const customer = await shopper();
  await addToCart(base, customer, 'LICHT', 2);
  const page = await customer.get('/afrekenen/');
  const select = /<select name="shippingMethod" required>([\s\S]*?)<\/select>/.exec(page.text);
  assert.ok(select, 'een keuzelijst in plaats van keuzerondjes');
  assert.doesNotMatch(page.text, /type="radio" name="shippingMethod"/);
  const values = [...select[1].matchAll(/<option value="([a-z]+)"([^>]*)>([^<]*)</g)];
  assert.deepStrictEqual(values.map((match) => match[1]), ['dpd', 'pallet', 'eigen', 'ophalen']);
  assert.deepStrictEqual(values.filter((match) => /\bselected\b/.test(match[2])).map((match) => match[1]), ['dpd'], 'afhalen is niet vooraf gekozen');
  assert.match(values[3][3], /Afhalen in Nunspeet – Gratis/);
  assert.match(values[1][3], /Bezorging per pallet – € 95,00/);
  assert.match(values[2][3], /Eigen transport – € 45,00/);
  assert.match(page.text, /data-method-note="Ma-vr 8-17 uur"/, 'de toelichting van afhalen staat bij die optie');
  // Een eerdere keuze van de klant blijft staan, ook afhalen.
  const keeps = await postForm(base, customer, '/afrekenen/', { action: 'update', country: 'NL', shippingMethod: 'ophalen' });
  assert.match(keeps.text, /<option value="ophalen" selected/);
  const eigen = await postForm(base, customer, '/afrekenen/', { action: 'update', country: 'NL', shippingMethod: 'eigen' });
  assert.match(eigen.text, /<option value="eigen" selected/);
  assert.match(eigen.text, /data-total="\d+(\.\d+)?"/);
  // Een onbekende of niet beschikbare methode geeft de eerste bezorgmethode, nooit afhalen.
  const unknown = await postForm(base, customer, '/afrekenen/', { action: 'update', country: 'NL', shippingMethod: 'post' });
  assert.match(unknown.text, /<option value="dpd" selected/);
  const script = await customer.get('/assets/afrekenen.js');
  assert.doesNotMatch(script.text, /input\[name="shippingMethod"\]/, 'het script leest de keuzelijst, niet de keuzerondjes');
});

test('afrekenen: alleen afhalen mogelijk geeft afhalen als enige keuze', async () => {
  const { base, shopper } = await setup({ pickup: { enabled: true }, dpd: { enabled: false } });
  const customer = await shopper();
  await addToCart(base, customer, 'LICHT', 1);
  const page = await customer.get('/afrekenen/');
  assert.match(page.text, /<option value="ophalen" selected/);
  assert.doesNotMatch(page.text, /<option value="dpd"/);
});

test('bestellen met pallet en eigen transport: tarief, verzendregel, adres verplicht en geen volgcode', async () => {
  const { base, admin, shopper } = await setup({
    pickup: { enabled: true },
    dpd: { enabled: true, zones: [{ country: 'NL', freeFrom: 0, tiers: [{ upToGrams: 2000, price: 6.95 }] }] },
    pallet: { enabled: true, label: 'Pallet', zones: [{ country: 'NL', freeFrom: 1000, tiers: [{ upToGrams: 20000, price: 95 }, { upToGrams: 500000, price: 120 }] }, { country: 'DE', freeFrom: 0, tiers: [{ upToGrams: 500000, price: 140 }] }] },
    eigen: { enabled: true, label: 'Eigen transport', zones: [{ country: 'NL', freeFrom: 0, tiers: [{ upToGrams: 100000, price: 45 }] }] },
  });
  const customer = await shopper();
  // Pallet: 5 × 12 kg = 60 kg valt in de zwaardere klasse (€ 120 incl. btw); DPD kan niet meer.
  await addToCart(base, customer, 'ZWAAR', 5);
  const refused = await postCheckout(base, customer, { ...FIELDS, shippingMethod: 'dpd', country: 'NL', action: 'place' });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.text, /te zwaar/);
  const pallet = await postCheckout(base, customer, { ...FIELDS, shippingMethod: 'pallet', country: 'NL', action: 'place' });
  assert.strictEqual(pallet.status, 303, pallet.text);
  const palletOrder = (await admin.get('/app/api/admin/web-orders')).body.items[0];
  const palletDetail = (await admin.get(`/app/api/admin/web-orders/${palletOrder.id}`)).body.order;
  assert.deepStrictEqual([palletDetail.shipping.method, palletDetail.shipping.label, palletDetail.shipping.price, palletDetail.shipping.free, palletDetail.shipping.weightGrams], ['pallet', 'Pallet', 120, false, 60000]);
  assert.strictEqual(palletDetail.total, 5 * 20 * 1.21 + 120, 'artikelen incl. btw plus de verzendregel');
  assert.strictEqual(palletDetail.address.street, 'Tuinstraat 1', 'bij pallet is een afleveradres nodig');
  assert.strictEqual(palletDetail.shipping.tracking, null);
  // Eigen transport zonder straat: het adres is verplicht, afhalen niet.
  await addToCart(base, customer, 'LICHT', 1);
  const noAddress = await postCheckout(base, customer, { name: 'Piet Tuin', email: 'piet@voorbeeld.nl', shippingMethod: 'eigen', country: 'NL', action: 'place' });
  assert.strictEqual(noAddress.status, 400);
  const eigen = await postCheckout(base, customer, { ...FIELDS, shippingMethod: 'eigen', country: 'NL', action: 'place' });
  assert.strictEqual(eigen.status, 303, eigen.text);
  const eigenOrder = (await admin.get('/app/api/admin/web-orders')).body.items.find((order) => order.id !== palletOrder.id);
  const eigenDetail = (await admin.get(`/app/api/admin/web-orders/${eigenOrder.id}`)).body.order;
  assert.deepStrictEqual([eigenDetail.shipping.method, eigenDetail.shipping.price], ['eigen', 45]);
  assert.strictEqual(eigenDetail.total, 12.1 + 45);
  // Een volgcode hoort alleen bij DPD.
  await admin.post(`/app/api/admin/web-orders/${eigenOrder.id}/status`, { status: 'verzonden' });
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${eigenOrder.id}/tracking`, { trackingCode: '015012345678' })).status, 409);
  // Een land met alleen pallet staat in de landenlijst; een methode zonder tarief voor het land kan niet.
  await addToCart(base, customer, 'LICHT', 1);
  const german = await customer.get('/afrekenen/');
  assert.match(german.text, /<option value="DE"/);
  const noRate = await postCheckout(base, customer, { ...FIELDS, postcode: '10115', shippingMethod: 'eigen', country: 'DE', action: 'place' });
  assert.strictEqual(noRate.status, 400);
  assert.match(noRate.text, /niet mogelijk/);
  const abroad = await postCheckout(base, customer, { ...FIELDS, postcode: '10115', shippingMethod: 'pallet', country: 'DE', action: 'place' });
  assert.strictEqual(abroad.status, 303, abroad.text);
  // Het factuuradres in een ander land mag alleen een land zijn waarnaar bezorgd wordt, ook bij pallet.
  await addToCart(base, customer, 'LICHT', 1);
  const strangeBilling = await postCheckout(base, customer, { ...FIELDS, shippingMethod: 'pallet', country: 'NL', deliveryForm: '1', billingCountry: 'FR', deliveryStreet: 'Tuinstraat 1', deliveryPostcode: '8071 AB', deliveryCity: 'Nunspeet', action: 'place' });
  assert.strictEqual(strangeBilling.status, 400);
  assert.match(strangeBilling.text, /land voor het factuuradres/);
});
