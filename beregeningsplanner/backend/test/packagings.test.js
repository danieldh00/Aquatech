// Verpakkingseenheden per artikel (artikelen/packagings.js): opslaan, controles, unieke code en EAN, zichtbaarheid per
// klantcategorie, opruimen bij een hoofdartikel, rechten en scheiding tussen organisaties.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizePackagings, visibleFor } = require('../src/artikelen/packagings');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 'e'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, planner en klant, en een tweede organisatie.
 * @returns {Promise<object>} admin, planner, customer, outsider.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'planner1', displayName: 'Planner', role: 'planner', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'klant1', displayName: 'Klant', role: 'klant', password: PW }, { mustChangePassword: false });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  return { admin: await as('baas'), planner: await as('planner1'), customer: await as('klant1'), outsider: await as('vreemd', 'ander') };
}

const PALLET = { code: 'pal', name: 'Pallet', factor: 144, salePrice: '', businessPrice: 1200, ean: '8712345678906', audience: 'zakelijk' };

test('controles op een verpakking', () => {
  assert.strictEqual(sanitizePackagings('x').field, 'packagings');
  assert.strictEqual(sanitizePackagings([{ ...PALLET, code: 'a b' }]).field, 'code');
  assert.strictEqual(sanitizePackagings([PALLET, PALLET]).field, 'code');
  assert.strictEqual(sanitizePackagings([{ ...PALLET, name: ' ' }]).field, 'name');
  for (const factor of [1, 2.5, 'abc', 0, -4, 1e9]) assert.strictEqual(sanitizePackagings([{ ...PALLET, factor }]).field, 'factor', String(factor));
  assert.strictEqual(sanitizePackagings([{ ...PALLET, salePrice: -1 }]).field, 'salePrice');
  assert.strictEqual(sanitizePackagings([{ ...PALLET, ean: '8712345678907' }]).field, 'ean');
  assert.strictEqual(sanitizePackagings([PALLET, { ...PALLET, code: 'DOOS', factor: 12 }]).field, 'ean', 'dezelfde EAN twee keer');
  assert.strictEqual(sanitizePackagings(Array.from({ length: 11 }, (_, i) => ({ ...PALLET, code: `P${i}`, ean: '' }))).field, 'packagings');
  assert.strictEqual(sanitizePackagings([{ ...PALLET, salePrice: '   ', businessPrice: null }]).value[0].salePrice, null, 'spaties zijn een lege prijs, geen 0 euro');
  assert.strictEqual(sanitizePackagings([{ ...PALLET, salePrice: 0 }]).value[0].salePrice, 0, 'een echte 0 blijft 0');
  const ok = sanitizePackagings([{ ...PALLET, audience: 'onzin', salePrice: '99,5' }]).value[0];
  assert.deepStrictEqual([ok.code, ok.audience, ok.salePrice, ok.businessPrice, ok.active], ['PAL', 'iedereen', 99.5, 1200, true]);
});

test('zichtbaarheid per klantcategorie', () => {
  assert.ok(visibleFor('iedereen', {}));
  assert.ok(!visibleFor('zakelijk', { group: '' }));
  assert.ok(visibleFor('zakelijk', { group: 'zakelijk' }));
  assert.ok(!visibleFor('groothandel', { group: 'zakelijk', wholesale: false }));
  assert.ok(visibleFor('groothandel', { group: 'zakelijk', wholesale: true }));
  assert.ok(!visibleFor('groothandel', { group: '', wholesale: true }));
});

test('verpakkingen opslaan, vervangen, EAN-botsingen en rechten', async () => {
  const { admin, planner, customer, outsider } = await setup();
  const item = (await admin.post('/app/api/stock/items', { code: 'KLINK', name: 'Klinker', unit: 'st', salePrice: 1.5, vatRate: 21 })).body;
  const other = (await admin.post('/app/api/stock/items', { code: 'KEI', name: 'Kei', unit: 'st', salePrice: 2, vatRate: 21, ean: '96385074' })).body;
  const url = `/app/api/stock/items/${item.id}/packagings`;
  assert.deepStrictEqual((await admin.get(url)).body.items, []);
  const saved = await admin.put(url, { packagings: [PALLET, { code: 'DOOS', name: 'Doos', factor: 12 }] });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.deepStrictEqual(saved.body.items.map((line) => [line.code, line.factor, line.audience, line.salePrice, line.businessPrice]), [['DOOS', 12, 'iedereen', null, null], ['PAL', 144, 'zakelijk', null, 1200]]);
  // Vervangen: de oude regels verdwijnen.
  const replaced = await admin.put(url, { packagings: [{ code: 'DOOS', name: 'Doos', factor: 10, salePrice: 14 }] });
  assert.deepStrictEqual(replaced.body.items.map((line) => [line.code, line.factor, line.salePrice]), [['DOOS', 10, 14]]);
  await admin.put(url, { packagings: [PALLET] });
  // Dezelfde EAN bij een ander artikel of als EAN van een artikel kan niet; niets half bewaard.
  const otherUrl = `/app/api/stock/items/${other.id}/packagings`;
  const clash = await admin.put(otherUrl, { packagings: [{ code: 'DOOS', name: 'Doos', factor: 6 }, PALLET] });
  assert.strictEqual(clash.status, 409);
  assert.match(clash.body.message, /KLINK/);
  assert.deepStrictEqual((await admin.get(otherUrl)).body.items, []);
  const stockClash = await admin.put(otherUrl, { packagings: [{ ...PALLET, ean: '96385074' }] });
  assert.strictEqual(stockClash.status, 409);
  assert.match(stockClash.body.message, /KEI/);
  // En andersom: een artikel krijgt niet de EAN van een verpakking.
  const reverse = await admin.put(`/app/api/stock/items/${other.id}`, { ean: '8712345678906' });
  assert.strictEqual(reverse.status, 409);
  assert.match(reverse.body.message, /verpakking van artikel KLINK/);
  // Rechten en scheiding.
  assert.strictEqual((await customer.get(url)).status, 403);
  assert.strictEqual((await customer.put(url, { packagings: [] })).status, 403);
  assert.strictEqual((await planner.get(url)).status, 403);
  assert.strictEqual((await outsider.get(url)).status, 404);
  assert.strictEqual((await outsider.put(url, { packagings: [] })).status, 404);
  assert.strictEqual((await admin.get('/app/api/stock/items/bestaat-niet/packagings')).status, 404);
  assert.strictEqual((await admin.put(url, { packagings: 'x' })).status, 400);
});

test('een hoofdartikel heeft geen verpakkingen en verwijderen ruimt ze op', async () => {
  const { admin } = await setup();
  const item = (await admin.post('/app/api/stock/items', { code: 'TEGEL', name: 'Tegel', unit: 'st', salePrice: 3, vatRate: 21 })).body;
  const url = `/app/api/stock/items/${item.id}/packagings`;
  await admin.put(url, { packagings: [{ code: 'PAL', name: 'Pallet', factor: 100 }] });
  const variants = await admin.put(`/app/api/stock/items/${item.id}/variants`, { attributes: [{ name: 'Maat', values: ['S', 'M'] }] });
  assert.ok(variants.status < 300, JSON.stringify(variants.body));
  assert.deepStrictEqual((await admin.get(url)).body.items, [], 'verpakkingen weg zodra het een hoofdartikel wordt');
  const refused = await admin.put(url, { packagings: [{ code: 'PAL', name: 'Pallet', factor: 100 }] });
  assert.strictEqual(refused.status, 409);
  const plain = (await admin.post('/app/api/stock/items', { code: 'LOSSE', name: 'Los', unit: 'st' })).body;
  await admin.put(`/app/api/stock/items/${plain.id}/packagings`, { packagings: [{ code: 'DOOS', name: 'Doos', factor: 5 }] });
  assert.strictEqual((await admin.del(`/app/api/stock/items/${plain.id}`)).status, 200);
  // Een gearchiveerd artikel (heeft voorraadbeweging) weigert wijzigingen op de server.
  const moved = (await admin.post('/app/api/stock/items', { code: 'OUD', name: 'Oud', unit: 'st', onHand: 5 })).body;
  await admin.del(`/app/api/stock/items/${moved.id}`);
  const archived = await admin.put(`/app/api/stock/items/${moved.id}/packagings`, { packagings: [{ code: 'DOOS', name: 'Doos', factor: 5 }] });
  assert.strictEqual(archived.status, 409, JSON.stringify(archived.body));
});
