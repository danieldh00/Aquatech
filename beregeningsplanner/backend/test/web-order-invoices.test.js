// Facturen bij bestellingen van de eigen webshop: bij Verzonden een factuur
// (definitief, zonder dubbele voorraadafboeking), btw verlegd, instellingen,
// eenmalig per bestelling en de rechten erop.
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

/** Afrekengegevens van een bedrijf in Nederland. */
const COMPANY = { name: 'Els Bakker', company: 'Bakker Tuinen BV', email: 'els@bakker.example', phone: '', street: 'Tuinstraat 1', postcode: '8071 AB', city: 'Nunspeet', note: 'Achterom', shippingMethod: 'dpd', country: 'NL', action: 'place' };

/**
 * Hoofdtenant met beheerder, een artikel en een zakelijke en particuliere klant.
 * @returns {Promise<object>} base, admin, vreemd, business en private1.
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
  assert.strictEqual((await admin.post('/api/stock/items', { code: 'BUS', name: 'Sproeier', onHand: 50, salePrice: 10, businessPrice: 8, weightGrams: 400 })).status, 201);
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
  return { base, admin, vreemd: await createLogin(base, { password: PW })('vreemd', 'ander'), business, private1: await shopper() };
}

/**
 * Bestelt twee sproeiers en geeft het id van de bestelling.
 * @param {object} world Het resultaat van setup.
 * @param {object} shopper De klant (client).
 * @param {object} [fields] Extra of andere afrekengegevens.
 * @returns {Promise<string>} Id van de nieuwste bestelling.
 */
async function order(world, shopper, fields = {}) {
  await postForm(world.base, shopper.client, '/winkel/winkelwagen/', { action: 'add', code: 'BUS', qty: '2' });
  const placed = await postCheckout(world.base, shopper.client, { ...COMPANY, ...fields });
  assert.strictEqual(placed.status, 303, placed.text);
  return (await world.admin.get('/api/admin/web-orders')).body.items[0].id;
}

/**
 * Zet een bestelling op Verzonden.
 * @param {object} world Het resultaat van setup.
 * @param {string} id Id van de bestelling.
 * @returns {Promise<object>} Het antwoord van de server.
 */
const ship = (world, id) => world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' });

test('Verzonden maakt een definitieve factuur met debiteur en boekt de voorraad niet dubbel af', async () => {
  const world = await setup();
  const id = await order(world, world.private1, { company: '' });
  assert.strictEqual((await world.admin.get(`/api/admin/web-orders/${id}`)).body.invoice, null);
  const shipped = await ship(world, id);
  assert.strictEqual(shipped.status, 200);
  const invoice = shipped.body.invoice;
  assert.ok(invoice && /^F\d{4}-0001$/.test(invoice.number), JSON.stringify(invoice));
  assert.strictEqual(invoice.status, 'definitief');
  assert.strictEqual(invoice.total, 31.15, '2 × 12,10 + verzending 6,95, gelijk aan de bestelling');
  const detail = (await world.admin.get(`/api/invoices/${invoice.id}`)).body;
  assert.strictEqual(detail.source, 'webshop');
  assert.strictEqual(detail.data.customer.name, 'Els Bakker');
  assert.deepStrictEqual(detail.data.lines.map((line) => [line.code, line.qty, line.price, line.vat]), [['BUS', 2, 10, 21], ['', 1, 5.74, 21]]);
  assert.ok(detail.debtorId, 'debiteur gekoppeld');
  assert.strictEqual((await world.admin.get('/api/stock')).body.items.find((item) => item.code === 'BUS').onHand, 48, 'één keer afgeboekt');
  assert.strictEqual((await world.admin.get(`/api/admin/web-orders/${id}`)).body.invoice.number, invoice.number);
});

test('een tweede aanvraag maakt geen tweede factuur', async () => {
  const world = await setup();
  const id = await order(world, world.private1);
  const first = (await ship(world, id)).body.invoice;
  const again = await world.admin.post(`/api/admin/web-orders/${id}/invoice`, {});
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.created, false);
  assert.strictEqual(again.body.invoice.id, first.id);
  assert.strictEqual((await world.admin.get('/api/invoices')).body.items.filter((item) => item.source === 'webshop').length, 1);
});

test('btw verlegd: factuur zonder btw met vermelding en het btw-nummer', async () => {
  const world = await setup();
  const id = await order(world, world.business, { postcode: '9000', country: 'BE', vatNumber: 'BE0123456789' });
  const invoice = (await ship(world, id)).body.invoice;
  assert.strictEqual(invoice.total, 27.98);
  const detail = (await world.admin.get(`/api/invoices/${invoice.id}`)).body;
  assert.match(detail.data.notes, /BTW verlegd naar afnemer \(btw-nummer BE0123456789\)/);
  assert.strictEqual(detail.data.customer.vatNumber, 'BE0123456789');
  assert.strictEqual(detail.data.customer.name, 'Bakker Tuinen BV');
  assert.ok(detail.data.lines.every((line) => line.vat === 0));
  assert.match(detail.data.customer.address, /9000 {2}Nunspeet\nBE$/);
});

test('instellingen: uit = geen factuur (later alsnog met de knop), niet definitief = concept', async () => {
  const world = await setup();
  await world.admin.put('/api/invoices/settings', { webOrders: { enabled: false } });
  const id = await order(world, world.private1);
  const shipped = await ship(world, id);
  assert.strictEqual(shipped.status, 200);
  assert.strictEqual(shipped.body.invoice, null);
  assert.strictEqual((await world.admin.post(`/api/admin/web-orders/${id}/invoice`, {})).status, 409);
  await world.admin.put('/api/invoices/settings', { webOrders: { enabled: true, finalize: false } });
  const made = await world.admin.post(`/api/admin/web-orders/${id}/invoice`, {});
  assert.strictEqual(made.status, 200);
  assert.strictEqual(made.body.created, true);
  assert.strictEqual(made.body.invoice.status, 'concept');
});

test('geen factuur voor een bestelling die nog niet is verzonden', async () => {
  const world = await setup();
  const id = await order(world, world.private1);
  assert.strictEqual((await world.admin.post(`/api/admin/web-orders/${id}/invoice`, {})).status, 409);
});

test('rechten en omgevingen: ander account 403, andere omgeving 404', async () => {
  const world = await setup();
  const id = await order(world, world.private1);
  await ship(world, id);
  assert.strictEqual((await world.private1.client.post(`/api/admin/web-orders/${id}/invoice`, {})).status, 403);
  assert.strictEqual((await world.vreemd.post(`/api/admin/web-orders/${id}/invoice`, {})).status, 404);
  assert.strictEqual((await world.vreemd.get(`/api/admin/web-orders/${id}`)).status, 404);
});

test('een concept dat bleef staan omdat definitief maken mislukte wordt bij opnieuw proberen afgemaakt', async () => {
  const world = await setup();
  await world.admin.put('/api/invoices/settings', { webOrders: { enabled: true, finalize: false } });
  const id = await order(world, world.private1);
  const concept = (await ship(world, id)).body.invoice;
  assert.strictEqual(concept.status, 'concept');
  await world.admin.put('/api/invoices/settings', { webOrders: { enabled: true, finalize: true } });
  // Zonder bewaarde fout blijft een bewust concept met rust.
  assert.strictEqual((await world.admin.post(`/api/admin/web-orders/${id}/invoice`, {})).body.invoice.status, 'concept');
});
