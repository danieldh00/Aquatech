// Verpakkingen in de winkelwagen en bestelling van de eigen webshop (CODE@PAL): prijs per verpakking, zichtbaarheid per
// klantcategorie, beschikbaarheid in hele verpakkingen, voorraad in de basiseenheid en samen tellen met losse stuks.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { stockQtyOf, splitCartCode } = require('../src/webshop/web-orders');
const { createLogin, createClient, listen, postForm, postCheckout } = require('./helpers/http-client');

const SECRET = 'd'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/** Bedrijfsgegevens voor een zakelijke klant. */
const COMPANY = { companyName: 'Bouwbedrijf Vos BV', kvkNumber: '12345678', vatNumber: 'NL123456789B01' };
/** Afrekengegevens voor ophalen. */
const PICKUP = { name: 'Pieter', company: '', email: 'pieter@voorbeeld.nl', phone: '', street: '', postcode: '', city: '', note: '', shippingMethod: 'ophalen', country: 'NL', action: 'place', paymentMethod: 'rekening' };

/**
 * Winkel met een klinker op voorraad (300 stuks) met een doos (iedereen) en een pallet (alleen zakelijk).
 * @returns {Promise<object>} base, admin, itemId, vreemd en shopper() om een klant te registreren.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  await admin.put('/app/api/admin/settings', { storefront: true, shopOrdering: true });
  const item = (await admin.post('/app/api/stock/items', { code: 'KLINK', name: 'Klinker', unit: 'st', onHand: 300, salePrice: 10, businessPrice: 9, vatRate: 21 })).body;
  const saved = await admin.put(`/app/api/stock/items/${item.id}/packagings`, { packagings: [
    { code: 'DOOS', name: 'Doos', factor: 10, salePrice: 95, audience: 'iedereen' },
    { code: 'PAL', name: 'Pallet', factor: 144, salePrice: '', businessPrice: 1200, audience: 'zakelijk' },
  ] });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  let counter = 0;
  /**
   * Registreert een klant in de shop, optioneel als zakelijke klant.
   * @param {{ business?: boolean }} [options] Welke klantgroep de klant krijgt.
   * @returns {Promise<object>} client van de klant.
   */
  const shopper = async ({ business = false } = {}) => {
    counter += 1;
    const client = createClient(base);
    await postForm(base, client, '/registreren/', { displayName: `Klant ${counter}`, email: `p${counter}@voorbeeld.nl`, password: PW, password2: PW, website: '' });
    const user = (await admin.get('/app/api/admin/users')).body.items.find((candidate) => candidate.email === `p${counter}@voorbeeld.nl`);
    if (business) await admin.patch(`/app/api/admin/users/${user.id}`, { customerGroup: 'zakelijk', ...COMPANY });
    return { client };
  };
  return { base, admin, itemId: item.id, shopper };
}

/**
 * Status van de afrekenpagina zonder redirects te volgen (302 = terug naar de winkelwagen omdat er iets niet klopt).
 * @param {string} base Adres van de server.
 * @param {object} client De client van de klant.
 * @returns {Promise<number>} De HTTP-status.
 */
async function checkoutStatus(base, client) {
  return (await createClient(base, { jar: client.jar, followRedirects: false }).get('/afrekenen/')).status;
}

test('hulpfuncties: code splitsen en voorraadaantal in de basiseenheid', () => {
  assert.deepStrictEqual(splitCartCode('KLINK@PAL'), { baseCode: 'KLINK', packCode: 'PAL' });
  assert.deepStrictEqual(splitCartCode('KLINK'), { baseCode: 'KLINK', packCode: '' });
  assert.strictEqual(stockQtyOf({ qty: 2, stockPer: 144 }), 288);
  assert.strictEqual(stockQtyOf({ qty: 5 }), 5);
});

test('particulier: doos met eigen prijs, pallet is niet te koop; voorraad gaat in stuks', async () => {
  const { base, admin, itemId, shopper } = await setup();
  const { client } = await shopper();
  await postForm(base, client, '/winkelwagen/', { action: 'add', code: 'KLINK@DOOS', qty: '2' });
  await postForm(base, client, '/winkelwagen/', { action: 'add', code: 'KLINK@PAL', qty: '1' });
  const cart = (await client.get('/winkelwagen/')).text;
  assert.match(cart, /Klinker – Doos \(10 st\)/);
  assert.match(cart, /Niet meer te koop: KLINK@PAL/, 'een pallet is alleen voor zakelijke klanten');
  await postForm(base, client, '/winkelwagen/', { action: 'remove', code: 'KLINK@PAL' });
  const placed = await postCheckout(base, client, PICKUP);
  assert.strictEqual(placed.status, 303, placed.text.slice(0, 300));
  const orderId = (await admin.get('/app/api/admin/web-orders')).body.items[0].id;
  const order = (await admin.get(`/app/api/admin/web-orders/${orderId}`)).body.order;
  assert.strictEqual(order.lines.length, 1);
  assert.deepStrictEqual([order.lines[0].code, order.lines[0].qty, order.lines[0].unit, order.lines[0].unitExcl, order.lines[0].stockPer], ['KLINK@DOOS', 2, 'Doos', 95, 10]);
  assert.strictEqual(order.total, 229.9, '2 × 95 × 1,21');
  const reserved = (await admin.get(`/app/api/stock/items/${itemId}`)).body;
  assert.strictEqual(reserved.reserved, 20, 'twee dozen van 10 stuks gereserveerd');
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${orderId}/status`, { status: 'verzonden' })).status, 200);
  assert.strictEqual((await admin.get(`/app/api/stock/items/${itemId}`)).body.onHand, 280, 'afgeboekt in stuks');
});

test('zakelijk: pallet tegen de zakelijke prijs, beschikbaar in hele pallets en samen met losse stuks', async () => {
  const { base, admin, shopper } = await setup();
  const { client } = await shopper({ business: true });
  await postForm(base, client, '/winkelwagen/', { action: 'add', code: 'KLINK@PAL', qty: '2' });
  const cart = (await client.get('/winkelwagen/')).text;
  assert.match(cart, /Klinker – Pallet \(144 st\)/);
  assert.match(cart, /1\.?200,00/);
  // 300 stuks = 2 hele pallets: 3 pallets kan niet.
  await postForm(base, client, '/winkelwagen/', { action: 'set', code: 'KLINK@PAL', qty: '3' });
  assert.strictEqual(await checkoutStatus(base, client), 302, 'te weinig voorraad voor 3 pallets');
  // 2 pallets (288) + 20 losse stuks = 308 > 300.
  await postForm(base, client, '/winkelwagen/', { action: 'set', code: 'KLINK@PAL', qty: '2' });
  await postForm(base, client, '/winkelwagen/', { action: 'add', code: 'KLINK', qty: '20' });
  assert.strictEqual(await checkoutStatus(base, client), 302, 'pallet en stuks samen zijn te veel');
  await postForm(base, client, '/winkelwagen/', { action: 'set', code: 'KLINK', qty: '12' });
  const placed = await postCheckout(base, client, { ...PICKUP, company: COMPANY.companyName, vatNumber: COMPANY.vatNumber });
  assert.strictEqual(placed.status, 303, placed.text.slice(0, 300));
  const orderId = (await admin.get('/app/api/admin/web-orders')).body.items[0].id;
  const order = (await admin.get(`/app/api/admin/web-orders/${orderId}`)).body.order;
  assert.strictEqual(order.lines.length, 2);
  const pallet = order.lines.find((line) => line.code === 'KLINK@PAL');
  assert.deepStrictEqual([pallet.qty, pallet.unitExcl, pallet.lineExcl, pallet.stockPer], [2, 1200, 2400, 144]);
});
