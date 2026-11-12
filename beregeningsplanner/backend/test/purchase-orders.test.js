// Inkooporders (artikelen/purchase-orders.js): invoer, de statusovergangen, ontvangen met voorraad en kostprijs,
// onderweg in het bestelvoorstel, een order uit het bestelvoorstel, rechten en scheiding tussen organisaties.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeOrder } = require('../src/artikelen/purchase-orders');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Hoofdtenant met beheerder, installateur en klant, plus een testserver.
 * @returns {Promise<object>} db, server en as (inloggen).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db }));
  return { db, server, as: createLogin(base, { password: PW }) };
}

/**
 * Maakt een leverancier en twee artikelen met een leverancierskoppeling.
 * @param {object} client De ingelogde client.
 * @returns {Promise<object>} supplier, pipe (met leveranciersprijs) en valve (zonder).
 */
async function seed(client) {
  const supplier = (await client.post('/app/api/suppliers', { name: 'Tuintechniek' })).body;
  const pipe = (await client.post('/app/api/stock/items', { code: 'PIJP', name: 'Pijp 25 mm', costPrice: 2 })).body;
  const valve = (await client.post('/app/api/stock/items', { code: 'KLEP', name: 'Klep', costPrice: 10, minQty: 5 })).body;
  await client.put(`/app/api/stock/items/${pipe.id}/suppliers`, { suppliers: [{ supplierId: supplier.id, supplierSku: 'TT-PIJP', costPrice: 1.5, orderQty: 25, preferred: true }] });
  return { supplier, pipe, valve };
}

test('inkooporders: invoer opschonen en controleren', () => {
  const ok = sanitizeOrder({ supplierId: 'a', expectedDate: '2026-12-01', notes: ' x\n', lines: [{ itemId: 'i', qty: '2.0004', unitCost: '1.23456' }, { itemId: 'j', qty: 1 }] }).value;
  assert.deepStrictEqual([ok.expectedDate, ok.notes, ok.lines[0].qty, ok.lines[0].unitCost, ok.lines[1].unitCost], ['2026-12-01', 'x', 2, 1.2346, null]);
  assert.strictEqual(sanitizeOrder({ lines: [] }).field, 'supplierId');
  assert.strictEqual(sanitizeOrder({ supplierId: 'a', lines: 'x' }).field, 'lines');
  assert.strictEqual(sanitizeOrder({ supplierId: 'a', expectedDate: '2026-13-45', lines: [] }).field, 'expectedDate');
  assert.strictEqual(sanitizeOrder({ supplierId: 'a', lines: [{ itemId: '', qty: 1 }] }).field, 'itemId');
  assert.strictEqual(sanitizeOrder({ supplierId: 'a', lines: [{ itemId: 'i', qty: 0 }] }).field, 'qty');
  assert.strictEqual(sanitizeOrder({ supplierId: 'a', lines: [{ itemId: 'i', qty: 1, unitCost: -1 }] }).field, 'unitCost');
  assert.strictEqual(sanitizeOrder({ supplierId: 'a', lines: [{ itemId: 'i', qty: 1 }, { itemId: 'i', qty: 2 }] }).field, 'itemId');
  assert.deepStrictEqual(sanitizeOrder({ supplierId: 'a', lines: [] }).value.lines, []);
});

test('inkooporders: maken, wijzigen, bestellen, ontvangen en afsluiten', async () => {
  const { db, server, as } = await setup();
  try {
    const kees = await as('kees');
    const { supplier, pipe, valve } = await seed(kees);
    // Prijs en artikelnummer komen uit de leverancierskoppeling, anders uit het artikel; een eigen prijs gaat voor.
    const created = await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, expectedDate: '2026-12-01', lines: [{ itemId: pipe.id, qty: 50 }, { itemId: valve.id, qty: 4 }] });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const order = created.body;
    assert.match(order.number, /^IO\d{4}-0001$/);
    assert.strictEqual(order.status, 'concept');
    assert.deepStrictEqual(order.lines.map((line) => [line.code, line.supplierSku, line.unitCost, line.amount]), [['PIJP', 'TT-PIJP', 1.5, 75], ['KLEP', '', 10, 40]]);
    assert.strictEqual(order.total, 115);
    assert.match((await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [] })).body.number, /-0002$/);

    // Een concept is te wijzigen, een bestelde order niet meer.
    const changed = await kees.put(`/app/api/purchase-orders/${order.id}`, { supplierId: supplier.id, notes: 'Op de bouw leveren', lines: [{ itemId: pipe.id, qty: 50, unitCost: 1.4 }, { itemId: valve.id, qty: 4 }] });
    assert.strictEqual(changed.body.notes, 'Op de bouw leveren');
    assert.strictEqual(changed.body.lines[0].unitCost, 1.4);
    // Zonder regels is er niets te bestellen.
    const empty = (await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [] })).body;
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${empty.id}/place`)).status, 409);
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${order.id}/receive`, { lines: [{ lineId: order.lines[0].id, qty: 1 }] })).status, 409);
    const placed = await kees.post(`/app/api/purchase-orders/${order.id}/place`);
    assert.strictEqual(placed.body.status, 'besteld');
    assert.ok(placed.body.orderedAt);
    assert.strictEqual((await kees.put(`/app/api/purchase-orders/${order.id}`, { supplierId: supplier.id, lines: [] })).status, 409);
    assert.strictEqual((await kees.del(`/app/api/purchase-orders/${order.id}`)).status, 409);

    // Deels ontvangen: de voorraad gaat omhoog en het logboek noemt de order.
    const [pipeLine, valveLine] = placed.body.lines;
    const partial = await kees.post(`/app/api/purchase-orders/${order.id}/receive`, { lines: [{ lineId: pipeLine.id, qty: 30 }] });
    assert.strictEqual(partial.status, 200, JSON.stringify(partial.body));
    assert.strictEqual(partial.body.status, 'deels_ontvangen');
    assert.deepStrictEqual(partial.body.lines.map((line) => [line.receivedQty, line.openQty]), [[30, 20], [0, 4]]);
    const afterPartial = (await kees.get(`/app/api/stock/items/${pipe.id}`)).body;
    assert.strictEqual(afterPartial.onHand, 30);
    // De ontvangen partij komt als laag met de inkoopprijs van de regel in de voorraad (FIFO).
    const layers = db.prepare('SELECT qty, unit_cost FROM stock_layers WHERE item_id = ?').all(pipe.id);
    assert.deepStrictEqual(layers.map((layer) => [layer.qty, layer.unit_cost]), [[30, 1.4]]);
    const movement = (await kees.get('/app/api/stock/movements')).body.items.find((row) => row.itemId === pipe.id || row.item_id === pipe.id);
    assert.deepStrictEqual([movement.kind, movement.source, movement.qty], ['ontvangst', `inkoop:${order.number}`, 30]);

    // Alles of niets: een foute regel in dezelfde ontvangst boekt niets.
    const bad = await kees.post(`/app/api/purchase-orders/${order.id}/receive`, { lines: [{ lineId: pipeLine.id, qty: 5 }, { lineId: 'bestaat-niet', qty: 1 }] });
    assert.strictEqual(bad.status, 404);
    assert.strictEqual((await kees.get(`/app/api/stock/items/${pipe.id}`)).body.onHand, 30);
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${order.id}/receive`, { lines: [{ lineId: pipeLine.id, qty: 0 }] })).status, 400);
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${order.id}/receive`, { lines: [] })).status, 400);
    // Annuleren kan niet meer, afsluiten wel: wat nog niet geleverd is vervalt.
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${order.id}/cancel`)).status, 409);

    // Meer ontvangen dan besteld mag; de order is ontvangen zodra elke regel is gehaald.
    const done = await kees.post(`/app/api/purchase-orders/${order.id}/receive`, { lines: [{ lineId: pipeLine.id, qty: 25 }, { lineId: valveLine.id, qty: 4 }] });
    assert.strictEqual(done.body.status, 'ontvangen');
    assert.ok(done.body.closedAt);
    assert.strictEqual((await kees.get(`/app/api/stock/items/${pipe.id}`)).body.onHand, 55);
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${order.id}/close`)).status, 409);

    // Afsluiten van een deels ontvangen order.
    const second = (await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [{ itemId: valve.id, qty: 10 }] })).body;
    await kees.post(`/app/api/purchase-orders/${second.id}/place`);
    await kees.post(`/app/api/purchase-orders/${second.id}/receive`, { lines: [{ lineId: second.lines[0].id, qty: 6 }] });
    const closed = await kees.post(`/app/api/purchase-orders/${second.id}/close`);
    assert.strictEqual(closed.body.status, 'ontvangen');
    assert.strictEqual(closed.body.openQty, 4);
    assert.strictEqual((await kees.get('/app/api/purchase-orders/incoming')).body.items.length, 0);

    // Lijst met filters.
    const all = (await kees.get('/app/api/purchase-orders')).body.items;
    assert.strictEqual(all.length, 4);
    assert.deepStrictEqual((await kees.get('/app/api/purchase-orders?status=ontvangen')).body.items.map((row) => row.number).sort(), [order.number, second.number].sort());
    assert.strictEqual((await kees.get('/app/api/purchase-orders?status=open')).body.items.length, 2);
    assert.strictEqual((await kees.get('/app/api/purchase-orders?supplierId=onbekend')).body.items.length, 0);
    assert.deepStrictEqual([all.find((row) => row.id === order.id).lineCount, all.find((row) => row.id === order.id).total], [2, 110]);
  } finally {
    server.close();
  }
});

test('inkooporders: annuleren, weggooien en gearchiveerde leverancier of artikel', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const { supplier, pipe } = await seed(kees);
    const draft = (await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [{ itemId: pipe.id, qty: 5 }] })).body;
    assert.strictEqual((await kees.del(`/app/api/purchase-orders/${draft.id}`)).status, 200);
    assert.strictEqual((await kees.get(`/app/api/purchase-orders/${draft.id}`)).status, 404);

    const order = (await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [{ itemId: pipe.id, qty: 5 }] })).body;
    await kees.post(`/app/api/purchase-orders/${order.id}/place`);
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${order.id}/cancel`)).body.status, 'geannuleerd');
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${order.id}/place`)).status, 409);

    // Een leverancier met orders wordt gearchiveerd (ook zonder artikelkoppeling) en kan geen nieuwe order meer krijgen.
    const lone = (await kees.post('/app/api/suppliers', { name: 'Alleen order' })).body;
    const loneOrder = (await kees.post('/app/api/purchase-orders', { supplierId: lone.id, lines: [{ itemId: pipe.id, qty: 1 }] })).body;
    assert.deepStrictEqual((await kees.del(`/app/api/suppliers/${lone.id}`)).body, { archived: true });
    assert.strictEqual((await kees.post('/app/api/purchase-orders', { supplierId: lone.id, lines: [] })).status, 409);
    // Een bestaand concept van die leverancier blijft wijzigbaar.
    assert.strictEqual((await kees.put(`/app/api/purchase-orders/${loneOrder.id}`, { supplierId: lone.id, lines: [{ itemId: pipe.id, qty: 2 }] })).status, 200);

    // Een artikel op een order wordt gearchiveerd in plaats van verwijderd; een hoofdartikel of onbekend artikel kan niet.
    assert.deepStrictEqual((await kees.del(`/app/api/stock/items/${pipe.id}`)).body.archived, true);
    assert.strictEqual((await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [{ itemId: pipe.id, qty: 1 }] })).status, 409);
    assert.strictEqual((await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [{ itemId: 'onbekend', qty: 1 }] })).status, 404);
    assert.strictEqual((await kees.post('/app/api/purchase-orders', { supplierId: 'onbekend', lines: [] })).status, 404);
  } finally {
    server.close();
  }
});

test('inkooporders: onderweg telt mee in het bestelvoorstel en een order uit het voorstel', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const { supplier, pipe } = await seed(kees);
    // Tekort 20 (minimum 10, 2× minimum = 20), bestelhoeveelheid 25 → 25 stuks.
    await kees.put(`/app/api/stock/items/${pipe.id}`, { minQty: 10 });
    await kees.post('/app/api/stock/items', { code: 'LOS', name: 'Zonder leverancier', minQty: 2 });
    const first = (await kees.get('/app/api/stock/reorder')).body;
    assert.deepStrictEqual(first.items.map((item) => [item.code, item.orderQty, item.incoming]).sort(), [['KLEP', 10, 0], ['LOS', 4, 0], ['PIJP', 25, 0]]);

    const made = await kees.post('/app/api/purchase-orders/from-proposal');
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body.orders.length, 1);
    assert.strictEqual(made.body.skipped, 2);
    const order = (await kees.get(`/app/api/purchase-orders/${made.body.orders[0].id}`)).body;
    assert.deepStrictEqual(order.lines.map((line) => [line.code, line.qty, line.unitCost, line.supplierSku]), [['PIJP', 25, 1.5, 'TT-PIJP']]);
    assert.strictEqual(order.supplierId, supplier.id);

    // Wat onderweg is (ook een concept) staat niet meer in het voorstel; een tweede klik maakt niets dubbel.
    assert.deepStrictEqual((await kees.get('/app/api/purchase-orders/incoming')).body.items, [{ itemId: pipe.id, qty: 25 }]);
    assert.deepStrictEqual((await kees.get('/app/api/stock/reorder')).body.items.map((item) => item.code), ['KLEP', 'LOS']);
    assert.strictEqual((await kees.post('/app/api/purchase-orders/from-proposal')).body.orders.length, 0);

    // Na annuleren is het weer nodig; na een ontvangst telt de voorraad.
    await kees.post(`/app/api/purchase-orders/${order.id}/cancel`);
    assert.deepStrictEqual((await kees.get('/app/api/stock/reorder')).body.items.map((item) => item.code).sort(), ['KLEP', 'LOS', 'PIJP']);
    const again = (await kees.post('/app/api/purchase-orders/from-proposal')).body.orders[0];
    await kees.post(`/app/api/purchase-orders/${again.id}/place`);
    const lineId = (await kees.get(`/app/api/purchase-orders/${again.id}`)).body.lines[0].id;
    await kees.post(`/app/api/purchase-orders/${again.id}/receive`, { lines: [{ lineId, qty: 25 }] });
    assert.deepStrictEqual((await kees.get('/app/api/stock/reorder')).body.items.map((item) => item.code), ['KLEP', 'LOS']);
  } finally {
    server.close();
  }
});

test('inkooporders: rechten en andere organisatie', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const { supplier, pipe } = await seed(kees);
    const order = (await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [{ itemId: pipe.id, qty: 5 }] })).body;

    const klant = await as('klant');
    for (const [method, path] of [['get', '/app/api/purchase-orders'], ['get', `/app/api/purchase-orders/${order.id}`], ['get', '/app/api/purchase-orders/incoming'],
      ['post', '/app/api/purchase-orders/from-proposal'], ['post', `/app/api/purchase-orders/${order.id}/place`], ['del', `/app/api/purchase-orders/${order.id}`]]) {
      assert.strictEqual((await klant[method](path)).status, 403, `${method} ${path}`);
    }

    await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    const piet = await as('piet', 'groen');
    assert.deepStrictEqual((await piet.get('/app/api/purchase-orders')).body.items, []);
    assert.strictEqual((await piet.get(`/app/api/purchase-orders/${order.id}`)).status, 404);
    for (const path of ['place', 'cancel', 'close']) assert.strictEqual((await piet.post(`/app/api/purchase-orders/${order.id}/${path}`)).status, 404, path);
    assert.strictEqual((await piet.post(`/app/api/purchase-orders/${order.id}/receive`, { lines: [{ lineId: 'x', qty: 1 }] })).status, 404);
    assert.strictEqual((await piet.put(`/app/api/purchase-orders/${order.id}`, { supplierId: supplier.id, lines: [] })).status, 404);
    assert.strictEqual((await piet.del(`/app/api/purchase-orders/${order.id}`)).status, 404);
    // Leverancier en artikel van de andere organisatie zijn onbereikbaar.
    assert.strictEqual((await piet.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [] })).status, 404);
    const own = (await piet.post('/app/api/suppliers', { name: 'Eigen' })).body;
    assert.strictEqual((await piet.post('/app/api/purchase-orders', { supplierId: own.id, lines: [{ itemId: pipe.id, qty: 1 }] })).status, 404);
    assert.deepStrictEqual((await piet.get('/app/api/purchase-orders/incoming')).body.items, []);
  } finally {
    server.close();
  }
});
