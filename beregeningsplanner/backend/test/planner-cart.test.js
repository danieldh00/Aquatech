// Materiaal uit de planner in de winkelwagen van de eigen webshop (POST /winkelwagen/planner)
// en de link terug naar de webshop (api/config → shop).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { setCartLines, plannedLinesFrom } = require('../src/webshop/storefront-cart');
const { createLogin, createClient, listen, postForm } = require('./helpers/http-client');

const SECRET = 'f'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, een andere organisatie en drie artikelen (één zonder voorraad).
 * @returns {Promise<{ base: string, admin: object, vreemd: object }>} De server en de ingelogde beheerders.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  await admin.post('/app/api/stock/items', { code: 'PE-32', name: 'PE-buis 32 mm', unit: 'm', onHand: 500, salePrice: 2 });
  await admin.post('/app/api/stock/items', { code: 'ROT-1', name: 'Rotator', onHand: 40, salePrice: 12.5 });
  await admin.post('/app/api/stock/items', { code: 'LEEG', name: 'Uitverkocht ding', onHand: 0, salePrice: 3 });
  await admin.post('/app/api/stock/items', { code: 'PAK', name: 'Pakartikel', onHand: 5000, salePrice: 1, packSize: 25, orderMinQty: 50 });
  return { base, admin, vreemd: await createLogin(base, { password: PW })('vreemd', 'ander') };
}

test('setCartLines: zet het aantal uit het plan (niet erbij) en meldt wat niet past', () => {
  const current = [{ code: 'A', qty: 2 }, { code: 'B', qty: 1 }];
  const once = setCartLines(current, [{ code: 'A', qty: 5 }, { code: 'C', qty: 3 }]);
  assert.deepStrictEqual(once.lines, [{ code: 'A', qty: 5 }, { code: 'B', qty: 1 }, { code: 'C', qty: 3 }]);
  assert.deepStrictEqual(setCartLines(once.lines, [{ code: 'A', qty: 5 }, { code: 'C', qty: 3 }]).lines, once.lines, 'nogmaals dezelfde regels verdubbelt niets');
  assert.deepStrictEqual(current, [{ code: 'A', qty: 2 }, { code: 'B', qty: 1 }], 'de invoer blijft ongewijzigd');
  const many = setCartLines([], Array.from({ length: 70 }, (_, index) => ({ code: `ART-${index}`, qty: 1 })));
  assert.strictEqual(many.lines.length, 60);
  assert.strictEqual(many.skipped.length, 10);
});

test('plannedLinesFrom: kommagetallen naar boven, ongeldige regels vallen af', () => {
  assert.deepStrictEqual(plannedLinesFrom({ 'q:pe-32': '12.2', 'q:ROT-1': '3', 'q:NUL': '0', 'q:KAPOT': 'x', 'q:': '4', overig: '9', 'q:PE-32 ': '1' }),
    [{ code: 'PE-32', qty: 13 }, { code: 'ROT-1', qty: 3 }]);
  assert.deepStrictEqual(plannedLinesFrom(null), []);
  assert.strictEqual(plannedLinesFrom({ 'q:A': '99999' })[0].qty, 9999);
});

test('api/config: de webshop-link alleen bij de hoofdtenant met een webshop die aan staat', async () => {
  const { admin, vreemd } = await setup();
  assert.strictEqual((await admin.get('/app/api/config')).body.shop, null, 'webshop uit');
  await admin.put('/app/api/admin/settings', { storefront: true });
  assert.deepStrictEqual((await admin.get('/app/api/config')).body.shop, { ordering: false });
  await admin.put('/app/api/admin/settings', { shopOrdering: true });
  assert.deepStrictEqual((await admin.get('/app/api/config')).body.shop, { ordering: true });
  assert.strictEqual((await vreemd.get('/app/api/config')).body.shop, null, 'andere organisatie');
});

test('planner → winkelwagen: alles in één keer, voorraad en onbekende codes gemeld, nogmaals klikken verdubbelt niets', async () => {
  const { base, admin } = await setup();
  await admin.put('/app/api/admin/settings', { storefront: true, shopOrdering: true });
  const client = createClient(base);
  const sent = await postForm(base, client, '/winkelwagen/planner/', { 'q:PE-32': '47.5', 'q:ROT-1': '4', 'q:LEEG': '2', 'q:NIET-IN-SHOP': '1' });
  assert.strictEqual(sent.status, 303);
  assert.strictEqual(sent.location, '../?plan=3&niet=NIET-IN-SHOP');
  const cart = (await client.get('/winkelwagen/?plan=3&niet=NIET-IN-SHOP')).text;
  assert.match(cart, /Het materiaal uit je plan staat in je winkelwagen \(3 artikelen\)/);
  assert.match(cart, /niet in de webshop te bestellen: NIET-IN-SHOP/);
  assert.match(cart, /name="qty" value="48"/, '47,5 meter wordt 48');
  assert.match(cart, /Niet meer op voorraad/);
  await postForm(base, client, '/winkelwagen/planner/', { 'q:PE-32': '47.5', 'q:ROT-1': '4' });
  const again = (await client.get('/winkelwagen/')).text;
  assert.match(again, /name="qty" value="48"/);
  assert.doesNotMatch(again, /value="96"/);
  assert.strictEqual((await postForm(base, client, '/winkelwagen/planner/', {})).location, '../', 'zonder regels niets te doen');
  const nothing = await postForm(base, createClient(base), '/winkelwagen/planner/', { 'q:ONBEKEND': '1' });
  assert.strictEqual(nothing.location, '../?plan=0&niet=ONBEKEND');
});

test('planner → winkelwagen: geen bestellen = geen winkelwagen, andere site geweigerd, gewone klant krijgt precies het aantal', async () => {
  const { base, admin } = await setup();
  const guest = createClient(base);
  assert.strictEqual((await postForm(base, guest, '/winkelwagen/planner/', { 'q:PE-32': '1' })).status, 404, 'webshop uit');
  await admin.put('/app/api/admin/settings', { storefront: true });
  assert.strictEqual((await postForm(base, guest, '/winkelwagen/planner/', { 'q:PE-32': '1' })).status, 404, 'bestellen uit');
  await admin.put('/app/api/admin/settings', { shopOrdering: true });
  assert.strictEqual((await postForm(base, guest, '/winkelwagen/planner/', { 'q:PE-32': '1' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  await postForm(base, guest, '/winkelwagen/planner/', { 'q:PAK': '30' });
  assert.match((await guest.get('/winkelwagen/')).text, /name="qty" value="30"/, 'gewone klant: precies het gevraagde aantal');
});

test('planner → winkelwagen: een groothandelsklant krijgt aantallen die bij de verpakkingseenheid passen', async () => {
  const { base, admin } = await setup();
  await admin.put('/app/api/admin/settings', { storefront: true, shopOrdering: true });
  const client = createClient(base);
  await postForm(base, client, '/registreren/', { displayName: 'Groot', email: 'groot@voorbeeld.nl', password: PW, password2: PW, website: '' });
  const user = (await admin.get('/app/api/admin/users')).body.items.find((candidate) => candidate.email === 'groot@voorbeeld.nl');
  await admin.patch(`/app/api/admin/users/${user.id}`, { customerGroup: 'zakelijk', companyName: 'Groothandel Tuinzaken BV', kvkNumber: '12345678', vatNumber: 'NL123456789B01' });
  assert.strictEqual((await admin.patch(`/app/api/admin/users/${user.id}`, { wholesale: true })).status, 200);
  const sent = await postForm(base, client, '/winkelwagen/planner/', { 'q:PAK': '30' });
  assert.strictEqual(sent.location, '../?plan=1');
  const cart = (await client.get('/winkelwagen/')).text;
  assert.match(cart, /name="qty" value="50"/, '30 wordt het minimum van 50');
  assert.doesNotMatch(cart, /Minimaal 50 stuks/);
  // Afgerond boven het maximum (9999 met verpakkingseenheid 25 wordt 10000): niet toevoegen, bestaande regel blijft.
  await postForm(base, client, '/winkelwagen/planner/', { 'q:PAK': '60' });
  const over = await postForm(base, client, '/winkelwagen/planner/', { 'q:PAK': '9999' });
  assert.strictEqual(over.location, '../?plan=0&niet=PAK');
  assert.match((await client.get('/winkelwagen/')).text, /name="qty" value="75"/);
});
