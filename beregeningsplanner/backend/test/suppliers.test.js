// Leveranciers en de leveranciers per artikel (artikelen/suppliers.js): controle van de invoer, de routes,
// het archiveren, het meeverhuizen met een artikel, rechten en scheiding tussen organisaties.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeSupplier, sanitizeItemSuppliers } = require('../src/artikelen/suppliers');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Hoofdtenant met beheerder, installateur, planner en klant, plus een testserver.
 * @returns {Promise<object>} db, server en as (inloggen).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'pien', displayName: 'Pien', role: 'planner', password: PW });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db }));
  return { db, server, as: createLogin(base, { password: PW }) };
}

test('leveranciers: invoer opschonen en controleren', () => {
  assert.deepStrictEqual(sanitizeSupplier({ name: '  Groothandel  ', email: 'inkoop@x.nl', phone: '0341\n1' }).value,
    { name: 'Groothandel', contactName: '', email: 'inkoop@x.nl', phone: '0341 1', address: '', notes: '' });
  assert.strictEqual(sanitizeSupplier({ name: ' ' }).field, 'name');
  assert.strictEqual(sanitizeSupplier({ name: 'X', email: 'geen-adres' }).field, 'email');
  assert.deepStrictEqual(sanitizeSupplier({ phone: '1' }, { partial: true }).value, { phone: '1' });

  const lines = sanitizeItemSuppliers([{ supplierId: 'a', costPrice: '1.23456', orderQty: '25' }, { supplierId: 'b', preferred: true }, { supplierId: 'c', preferred: true }]).value;
  assert.deepStrictEqual(lines.map((line) => [line.supplierId, line.costPrice, line.orderQty, line.preferred]), [['a', 1.2346, 25, false], ['b', null, 1, true], ['c', null, 1, false]]);
  // Zonder voorkeur is de eerste leverancier het.
  assert.deepStrictEqual(sanitizeItemSuppliers([{ supplierId: 'a' }, { supplierId: 'b' }]).value.map((line) => line.preferred), [true, false]);
  assert.strictEqual(sanitizeItemSuppliers([{ supplierId: 'a' }, { supplierId: 'a' }]).field, 'supplierId');
  assert.strictEqual(sanitizeItemSuppliers([{ supplierId: '' }]).field, 'supplierId');
  assert.strictEqual(sanitizeItemSuppliers([{ supplierId: 'a', costPrice: -1 }]).field, 'costPrice');
  assert.strictEqual(sanitizeItemSuppliers([{ supplierId: 'a', orderQty: 0 }]).field, 'orderQty');
  assert.strictEqual(sanitizeItemSuppliers('niets').field, 'suppliers');
  assert.deepStrictEqual(sanitizeItemSuppliers([]).value, []);
});

test('leveranciers: aanmaken, wijzigen, koppelen aan een artikel, archiveren en verwijderen', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const created = await kees.post('/app/api/suppliers', { name: 'Tuintechniek', email: 'inkoop@tuintechniek.nl' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.strictEqual(created.body.itemCount, 0);
    // Dezelfde naam (ook met andere hoofdletters) mag niet twee keer.
    const double = await kees.post('/app/api/suppliers', { name: 'TUINTECHNIEK' });
    assert.strictEqual(double.status, 409);
    assert.strictEqual(double.body.field, 'name');
    assert.strictEqual((await kees.post('/app/api/suppliers', { name: '' })).status, 400);
    const other = (await kees.post('/app/api/suppliers', { name: 'Import BV' })).body;

    const renamed = await kees.patch(`/app/api/suppliers/${created.body.id}`, { phone: '0341 1' });
    assert.strictEqual(renamed.body.phone, '0341 1');
    assert.strictEqual(renamed.body.name, 'Tuintechniek');
    assert.strictEqual((await kees.patch(`/app/api/suppliers/${created.body.id}`, { name: 'import bv' })).status, 409);

    // Twee artikelen; het eerste krijgt twee leveranciers.
    const itemA = (await kees.post('/app/api/stock/items', { code: 'SUP-A', name: 'Artikel A', onHand: 1, costPrice: 2 })).body;
    const itemB = (await kees.post('/app/api/stock/items', { code: 'SUP-B', name: 'Artikel B' })).body;
    const linked = await kees.put(`/app/api/stock/items/${itemA.id}/suppliers`, { suppliers: [
      { supplierId: created.body.id, supplierSku: 'TT-100', orderQty: 25 },
      { supplierId: other.id, supplierSku: 'IM-7', costPrice: 1.5, preferred: true }] });
    assert.strictEqual(linked.status, 200, JSON.stringify(linked.body));
    assert.deepStrictEqual(linked.body.items.map((line) => [line.supplierName, line.supplierSku, line.costPrice, line.orderQty, line.preferred]),
      [['Import BV', 'IM-7', 1.5, 1, true], ['Tuintechniek', 'TT-100', null, 25, false]]);
    assert.strictEqual((await kees.get(`/app/api/stock/items/${itemA.id}/suppliers`)).body.items.length, 2);
    assert.strictEqual((await kees.put(`/app/api/stock/items/${itemB.id}/suppliers`, { suppliers: [{ supplierId: created.body.id }] })).status, 200);
    const counts = Object.fromEntries((await kees.get('/app/api/suppliers')).body.items.map((supplier) => [supplier.name, supplier.itemCount]));
    assert.deepStrictEqual(counts, { 'Import BV': 1, Tuintechniek: 2 });

    // Onbekende leverancier of artikel.
    assert.strictEqual((await kees.put(`/app/api/stock/items/${itemB.id}/suppliers`, { suppliers: [{ supplierId: 'bestaat-niet' }] })).status, 404);
    assert.strictEqual((await kees.put('/app/api/stock/items/bestaat-niet/suppliers', { suppliers: [] })).status, 404);
    assert.strictEqual((await kees.put(`/app/api/stock/items/${itemB.id}/suppliers`, { suppliers: [{ supplierId: created.body.id, orderQty: 'veel' }] })).status, 400);

    // Een leverancier met artikelen wordt gearchiveerd en komt terug met archived=1; terugzetten kan.
    const archived = await kees.del(`/app/api/suppliers/${created.body.id}`);
    assert.deepStrictEqual(archived.body, { archived: true });
    assert.deepStrictEqual((await kees.get('/app/api/suppliers')).body.items.map((supplier) => supplier.name), ['Import BV']);
    assert.strictEqual((await kees.get('/app/api/suppliers?archived=1')).body.items.length, 2);
    assert.strictEqual((await kees.get(`/app/api/stock/items/${itemB.id}/suppliers`)).body.items[0].supplierArchived, true);
    // Een gearchiveerde leverancier komt niet nieuw bij een artikel; een bestaande koppeling mag blijven.
    const itemC = (await kees.post('/app/api/stock/items', { code: 'SUP-C', name: 'Artikel C' })).body;
    assert.strictEqual((await kees.put(`/app/api/stock/items/${itemC.id}/suppliers`, { suppliers: [{ supplierId: created.body.id }] })).status, 409);
    assert.strictEqual((await kees.put(`/app/api/stock/items/${itemB.id}/suppliers`, { suppliers: [{ supplierId: created.body.id, supplierSku: 'blijft' }] })).status, 200);
    assert.strictEqual((await kees.patch(`/app/api/suppliers/${created.body.id}`, { archived: false })).body.archived, false);

    // Een artikel verwijderen (zonder mutaties) haalt zijn koppelingen weg; een leverancier zonder koppelingen gaat echt weg.
    assert.deepStrictEqual((await kees.del(`/app/api/stock/items/${itemB.id}`)).body.deleted, true);
    assert.strictEqual((await kees.get(`/app/api/stock/items/${itemB.id}/suppliers`)).status, 404);
    assert.deepStrictEqual((await baas.del(`/app/api/suppliers/${other.id}`)).body, { archived: true });
    assert.strictEqual((await kees.put(`/app/api/stock/items/${itemA.id}/suppliers`, { suppliers: [] })).status, 200);
    assert.deepStrictEqual((await kees.del(`/app/api/suppliers/${created.body.id}`)).body, { deleted: true });
    assert.strictEqual((await kees.del(`/app/api/suppliers/${created.body.id}`)).status, 404);
  } finally {
    server.close();
  }
});

test('leveranciers: hoofdartikel zonder eigen leverancier, rechten en andere organisatie', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const pien = await as('pien');
    const klant = await as('klant');
    const supplier = (await baas.post('/app/api/suppliers', { name: 'Tuintechniek' })).body;

    // Een artikel met leverancier dat hoofdartikel wordt, verliest zijn koppeling; een hoofdartikel krijgt er geen.
    const item = (await baas.post('/app/api/stock/items', { code: 'SLANG', name: 'Slang' })).body;
    assert.strictEqual((await baas.put(`/app/api/stock/items/${item.id}/suppliers`, { suppliers: [{ supplierId: supplier.id }] })).status, 200);
    assert.strictEqual((await baas.put(`/app/api/stock/items/${item.id}/variants`, { attributes: [{ name: 'Lengte', values: ['15 m', '25 m'] }] })).status, 200);
    assert.deepStrictEqual((await baas.get(`/app/api/stock/items/${item.id}/suppliers`)).body.items, []);
    const blocked = await baas.put(`/app/api/stock/items/${item.id}/suppliers`, { suppliers: [{ supplierId: supplier.id }] });
    assert.strictEqual(blocked.status, 409);

    // Zonder recht voorraad: planner en klant.
    for (const client of [pien, klant]) {
      assert.strictEqual((await client.get('/app/api/suppliers')).status, 403);
      assert.strictEqual((await client.post('/app/api/suppliers', { name: 'X' })).status, 403);
      assert.strictEqual((await client.patch(`/app/api/suppliers/${supplier.id}`, { name: 'Y' })).status, 403);
      assert.strictEqual((await client.del(`/app/api/suppliers/${supplier.id}`)).status, 403);
      assert.strictEqual((await client.put(`/app/api/stock/items/${item.id}/suppliers`, { suppliers: [] })).status, 403);
    }

    // Een andere organisatie ziet niets en kan niets wijzigen.
    await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    const piet = await as('piet', 'groen');
    assert.deepStrictEqual((await piet.get('/app/api/suppliers')).body.items, []);
    assert.strictEqual((await piet.patch(`/app/api/suppliers/${supplier.id}`, { name: 'Gekaapt' })).status, 404);
    assert.strictEqual((await piet.del(`/app/api/suppliers/${supplier.id}`)).status, 404);
    assert.strictEqual((await piet.get(`/app/api/stock/items/${item.id}/suppliers`)).status, 404);
    const ownItem = (await piet.post('/app/api/stock/items', { code: 'EIGEN', name: 'Eigen', onHand: 1 })).body;
    assert.strictEqual((await piet.put(`/app/api/stock/items/${ownItem.id}/suppliers`, { suppliers: [{ supplierId: supplier.id }] })).status, 404);
    // Dezelfde naam mag in de andere organisatie.
    assert.strictEqual((await piet.post('/app/api/suppliers', { name: 'Tuintechniek' })).status, 201);
    assert.strictEqual((await baas.get(`/app/api/suppliers`)).body.items[0].name, 'Tuintechniek');
  } finally {
    server.close();
  }
});
