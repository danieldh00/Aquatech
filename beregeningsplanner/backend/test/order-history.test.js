// Verzendmail met volgcode van DPD, bestelhistorie in het klantaccount en de
// factuur als PDF bij een eigen bestelling in de eigen webshop.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, createClient, listen, postForm, postCheckout } = require('./helpers/http-client');

const SECRET = 'f'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/** Afrekengegevens van een particulier in Nederland. */
const PERSON = { name: 'Els Bakker', company: '', email: 'els@bakker.example', phone: '', street: 'Tuinstraat 1', postcode: '8071 AB', city: 'Nunspeet', note: '', shippingMethod: 'dpd', country: 'NL', action: 'place' };

/**
 * Wacht tot een voorwaarde waar is (de mails gaan los van het antwoord weg).
 * @param {Function} check Geeft iets waars zodra het klaar is.
 * @returns {Promise<*>} De waarde van check.
 */
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Voorwaarde niet bereikt.');
}

/**
 * Hoofdtenant met beheerder, een artikel, een tweede organisatie en twee klanten; mails worden onderschept.
 * @returns {Promise<object>} base, admin, vreemd, sent (verstuurde mails) en shoppers (twee klanten).
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
   * Mailserver die elk bericht onderschept.
   * @returns {{ configured: Function, send: Function }} De nagebootste mailserver.
   */
  const mailerFor = () => ({ configured: () => true, send: async (message) => { sent.push(message); } });
  const { server, base } = await listen(createApp({ secret: SECRET, db, mailerFor }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  await admin.put('/api/admin/settings', { storefront: true, shopOrdering: true, shopShipping: {
    pickup: { enabled: true }, dpd: { enabled: true, defaultWeightGrams: 1000, zones: [{ country: 'NL', tiers: [{ upToGrams: 2000, price: 6.95 }] }] },
  } });
  assert.strictEqual((await admin.post('/api/stock/items', { code: 'BUS', name: 'Sproeier', onHand: 50, salePrice: 10, weightGrams: 400 })).status, 201);
  let counter = 0;
  /**
   * Registreert een klant in de shop.
   * @returns {Promise<object>} De client.
   */
  const shopper = async () => {
    counter += 1;
    const client = createClient(base);
    await postForm(base, client, '/winkel/registreren/', { displayName: `Klant ${counter}`, email: `k${counter}@voorbeeld.nl`, password: PW, password2: PW, website: '' });
    return { client };
  };
  return { base, admin, vreemd: await createLogin(base, { password: PW })('vreemd', 'ander'), sent, shoppers: [await shopper(), await shopper()] };
}

/**
 * Bestelt twee sproeiers en geeft het id van de nieuwste bestelling.
 * @param {object} world Het resultaat van setup.
 * @param {object} shopper De klant.
 * @param {object} [fields] Andere afrekengegevens (bijvoorbeeld ophalen).
 * @returns {Promise<string>} Id van de bestelling.
 */
async function order(world, shopper, fields = {}) {
  await postForm(world.base, shopper.client, '/winkel/winkelwagen/', { action: 'add', code: 'BUS', qty: '2' });
  const placed = await postCheckout(world.base, shopper.client, { ...PERSON, ...fields });
  assert.strictEqual(placed.status, 303, placed.text);
  return (await world.admin.get('/api/admin/web-orders')).body.items[0].id;
}

/**
 * Zoekt de verzonden mails voor een onderwerp.
 * @param {object[]} sent Alle onderschepte mails.
 * @param {RegExp} subject Het onderwerp.
 * @returns {object[]} De mails.
 */
const mailsWith = (sent, subject) => sent.filter((message) => subject.test(message.subject));

test('Verzonden met volgcode: de klant krijgt een mail met de DPD-link', async () => {
  const world = await setup();
  const id = await order(world, world.shoppers[0]);
  assert.strictEqual((await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden', trackingCode: 'abc123456789' })).status, 200);
  const [mail] = await until(() => { const found = mailsWith(world.sent, /onderweg/); return found.length ? found : null; });
  assert.strictEqual(mail.to, 'els@bakker.example');
  assert.match(mail.subject, /volgcode abc123456789/);
  assert.match(mail.text, /tracking\.dpd\.de\/status\/nl_NL\/parcel\/abc123456789/);
  const detail = (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order;
  await until(async () => (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order.shipMail);
  assert.strictEqual(detail.shipping.tracking.code, 'abc123456789');
});

test('volgcode later: één extra mail, niet bij dezelfde code', async () => {
  const world = await setup();
  const id = await order(world, world.shoppers[0]);
  await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' });
  await until(() => mailsWith(world.sent, /onderweg/).length === 1);
  assert.doesNotMatch(mailsWith(world.sent, /onderweg/)[0].text, /tracking\.dpd\.de/);
  await world.admin.post(`/api/admin/web-orders/${id}/tracking`, { trackingCode: 'abc123456789' });
  await until(() => mailsWith(world.sent, /onderweg/).length === 2);
  assert.match(mailsWith(world.sent, /onderweg/)[1].text, /abc123456789/);
  await world.admin.post(`/api/admin/web-orders/${id}/tracking`, { trackingCode: 'abc123456789' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(mailsWith(world.sent, /onderweg/).length, 2, 'dezelfde code geeft geen nieuwe mail');
  const shipMail = await until(async () => (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order.shipMail);
  assert.strictEqual(shipMail.sent, true);
});

test('ophalen: mail dat de bestelling klaarstaat', async () => {
  const world = await setup();
  const id = await order(world, world.shoppers[0], { shippingMethod: 'ophalen' });
  await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' });
  const [mail] = await until(() => { const found = mailsWith(world.sent, /staat klaar/); return found.length ? found : null; });
  assert.match(mail.text, /klaar om op te halen/);
});

test('bestelhistorie: alleen eigen bestellingen, niet zonder inloggen', async () => {
  const world = await setup();
  const [first, second] = world.shoppers;
  await order(world, first);
  await order(world, second);
  const own = await first.client.get('/winkel/bestellingen/');
  assert.strictEqual(own.status, 200);
  assert.match(own.text, /WEB-\d{4}-0001/);
  assert.doesNotMatch(own.text, /WEB-\d{4}-0002/, 'de bestelling van een ander staat er niet tussen');
  assert.match((await first.client.get('/winkel/account/')).text, /Mijn bestellingen/);
  const anonymous = await createClient(world.base).get('/winkel/bestellingen/');
  assert.match(anonymous.text, /Inloggen/, 'zonder sessie naar het inlogscherm');
  assert.doesNotMatch(anonymous.text, /WEB-\d{4}-0001/);
});

test('factuur als PDF: eigen bestelling na Verzonden, niet van een ander, niet als concept', async () => {
  const world = await setup();
  const [owner, stranger] = world.shoppers;
  const id = await order(world, owner);
  const url = `/winkel/bestelling/${id}/factuur.pdf`;
  assert.strictEqual((await owner.client.get(url)).status, 404, 'nog geen factuur');
  assert.doesNotMatch((await owner.client.get(`/winkel/bestelling/${id}/`)).text, /factuur\.pdf/);
  await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' });
  const page = await owner.client.get(`/winkel/bestelling/${id}/`);
  assert.match(page.text, /href="factuur\.pdf"/);
  const pdf = await owner.client.get(url);
  assert.strictEqual(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  assert.match(pdf.headers.get('content-disposition'), /attachment; filename="[A-Za-z0-9._-]+\.pdf"/);
  assert.strictEqual((await stranger.client.get(url)).status, 404);
  const anonymous = await createClient(world.base).get(url);
  assert.notStrictEqual(anonymous.type, 'application/pdf', 'zonder sessie geen PDF');
  assert.match(anonymous.text, /Inloggen/);
});

test('een conceptfactuur is niet te downloaden door de klant', async () => {
  const world = await setup();
  await world.admin.put('/api/invoices/settings', { webOrders: { enabled: true, finalize: false } });
  const id = await order(world, world.shoppers[0]);
  await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' });
  assert.strictEqual((await world.shoppers[0].client.get(`/winkel/bestelling/${id}/factuur.pdf`)).status, 404);
  assert.doesNotMatch((await world.shoppers[0].client.get(`/winkel/bestelling/${id}/`)).text, /factuur\.pdf/);
});
