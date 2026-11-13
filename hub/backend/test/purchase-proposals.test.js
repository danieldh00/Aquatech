// Automatische bestelvoorstellen (purchaseOrders.autoPropose en de routes onder /api/purchase-orders/proposals): maken,
// bijwerken en opruimen, onderweg, bewerkte voorstellen, afwijzen en herstellen, goedkeuren, backorders, bestelveelvoud,
// rechten, scheiding tussen organisaties en twee rondes tegelijk.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const ZEROS = { created: 0, updated: 0, removed: 0 };

/**
 * Hoofdtenant met beheerder, installateur en klant, plus een testserver.
 * @returns {Promise<object>} db, main (id van de hoofdtenant), server en as (inloggen).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db }));
  return { db, main, server, as: createLogin(base, { password: PW }) };
}

/**
 * Een leverancier met twee artikelen onder het minimum: pijp (bestellen per 25, leveranciersprijs) en klep (zonder leverancier).
 * @param {object} client De ingelogde client.
 * @returns {Promise<object>} supplier, pipe en valve.
 */
async function seed(client) {
  const supplier = (await client.post('/app/api/suppliers', { name: 'Tuintechniek' })).body;
  const pipe = (await client.post('/app/api/stock/items', { code: 'PIJP', name: 'Pijp 25 mm', costPrice: 2, minQty: 10 })).body;
  const valve = (await client.post('/app/api/stock/items', { code: 'KLEP', name: 'Klep', costPrice: 10, minQty: 5 })).body;
  await client.put(`/app/api/stock/items/${pipe.id}/suppliers`, { suppliers: [{ supplierId: supplier.id, supplierSku: 'TT-PIJP', costPrice: 1.5, orderQty: 25, preferred: true }] });
  return { supplier, pipe, valve };
}

/**
 * Draait de taak nu (vernieuwen) en geeft de samenvatting.
 * @param {object} client De ingelogde client.
 * @returns {Promise<object>} { created, updated, removed, skipped, dismissedSkipped }.
 */
async function refresh(client) {
  const out = await client.post('/app/api/purchase-orders/proposals/refresh');
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  return out.body;
}

/**
 * Alleen de tellers van wat er is geschreven.
 * @param {object} summary De samenvatting van de taak.
 * @returns {{ created: number, updated: number, removed: number }} De drie tellers.
 */
const writes = (summary) => ({ created: summary.created, updated: summary.updated, removed: summary.removed });

/**
 * Het overzicht van de voorstellen.
 * @param {object} client De ingelogde client.
 * @returns {Promise<object>} { orders, dismissed, withoutSupplier, enabled }.
 */
async function proposals(client) {
  const out = await client.get('/app/api/purchase-orders/proposals');
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  return out.body;
}

test('voorstellen: maken met bestelveelvoud, idempotent en zonder leverancier overgeslagen', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const { supplier, pipe } = await seed(kees);
    assert.deepStrictEqual(await refresh(kees), { created: 1, updated: 0, removed: 0, skipped: 1, dismissedSkipped: 0 });
    const view = await proposals(kees);
    assert.strictEqual(view.enabled, true);
    assert.strictEqual(view.withoutSupplier, 1);
    assert.deepStrictEqual(view.dismissed, []);
    assert.strictEqual(view.orders.length, 1);
    const [order] = view.orders;
    assert.deepStrictEqual([order.origin, order.status, order.supplierId, order.notes, order.createdBy], ['voorstel', 'concept', supplier.id, 'Automatisch voorstel', 'Kees']);
    assert.match(order.number, /^IO\d{4}-0001$/);
    // Tekort 20 (2× minimum), afgerond op de verpakking van 25, tegen de leveranciersprijs.
    assert.deepStrictEqual(order.lines.map((line) => [line.itemId, line.qty, line.unitCost, line.supplierSku]), [[pipe.id, 25, 1.5, 'TT-PIJP']]);
    assert.strictEqual(order.total, 37.5);
    // De order zelf heeft ook het veld origin, in de lijst en los.
    assert.strictEqual((await kees.get(`/app/api/purchase-orders/${order.id}`)).body.origin, 'voorstel');
    assert.strictEqual((await kees.get('/app/api/purchase-orders')).body.items[0].origin, 'voorstel');

    // Nog een keer: niets te doen, de order blijft dezelfde (ook updated_at) en het nummer loopt niet op.
    assert.deepStrictEqual(writes(await refresh(kees)), ZEROS);
    assert.deepStrictEqual(writes(await refresh(kees)), ZEROS);
    const again = (await proposals(kees)).orders;
    assert.deepStrictEqual(again.map((row) => [row.id, row.number, row.updatedAt]), [[order.id, order.number, order.updatedAt]]);
    // Een order uit het bestelvoorstel (handmatig) maakt niets dubbel: het voorstel is al onderweg.
    assert.strictEqual((await kees.post('/app/api/purchase-orders/from-proposal')).body.orders.length, 0);
  } finally {
    server.close();
  }
});

test('voorstellen: bijwerken bij gewijzigde voorraad en weg als de voorraad weer klopt', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const { pipe } = await seed(kees);
    await refresh(kees);
    const order = (await proposals(kees)).orders[0];
    // Hoger minimum: 60 nodig, per 25 → 75; dezelfde order wordt bijgewerkt.
    await kees.put(`/app/api/stock/items/${pipe.id}`, { minQty: 30 });
    assert.deepStrictEqual(writes(await refresh(kees)), { created: 0, updated: 1, removed: 0 });
    const updated = (await proposals(kees)).orders;
    assert.deepStrictEqual(updated.map((row) => [row.id, row.number, row.lines[0].qty]), [[order.id, order.number, 75]]);
    // Een nieuwe leveranciersprijs komt ook in het voorstel.
    await kees.put(`/app/api/stock/items/${pipe.id}/suppliers`, { suppliers: [{ supplierId: updated[0].supplierId, supplierSku: 'TT-PIJP', costPrice: 1.25, orderQty: 25, preferred: true }] });
    assert.deepStrictEqual(writes(await refresh(kees)), { created: 0, updated: 1, removed: 0 });
    assert.strictEqual((await proposals(kees)).orders[0].lines[0].unitCost, 1.25);
    // Voorraad aangevuld: het voorstel verdwijnt.
    assert.strictEqual((await kees.post(`/app/api/stock/items/${pipe.id}/movements`, { kind: 'ontvangst', qty: 100, note: 'Pakbon' })).status, 201);
    assert.deepStrictEqual(writes(await refresh(kees)), { created: 0, updated: 0, removed: 1 });
    assert.deepStrictEqual((await proposals(kees)).orders, []);
    assert.strictEqual((await kees.get(`/app/api/purchase-orders/${order.id}`)).status, 404);
    assert.deepStrictEqual(writes(await refresh(kees)), ZEROS);
  } finally {
    server.close();
  }
});

test('voorstellen: handmatige orders tellen als onderweg, een bewerkt voorstel blijft met rust', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const { supplier, pipe } = await seed(kees);
    // Een handmatig concept dekt het tekort: geen voorstel.
    const manual = (await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [{ itemId: pipe.id, qty: 25 }] })).body;
    assert.strictEqual(manual.origin, 'handmatig');
    assert.deepStrictEqual(writes(await refresh(kees)), ZEROS);
    // Besteld telt ook.
    await kees.post(`/app/api/purchase-orders/${manual.id}/place`);
    assert.deepStrictEqual(writes(await refresh(kees)), ZEROS);
    // Geannuleerd telt niet meer.
    await kees.post(`/app/api/purchase-orders/${manual.id}/cancel`);
    assert.deepStrictEqual(writes(await refresh(kees)), { created: 1, updated: 0, removed: 0 });
    const proposal = (await proposals(kees)).orders[0];

    // Bewerken maakt het voorstel handmatig; de taak raakt hem daarna niet meer aan en telt hem als onderweg.
    const edited = await kees.put(`/app/api/purchase-orders/${proposal.id}`, { supplierId: supplier.id, notes: 'Eerst een paar', lines: [{ itemId: pipe.id, qty: 5 }] });
    assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
    assert.strictEqual(edited.body.origin, 'handmatig');
    // Onderweg 5: nog 15 nodig, per 25 → een nieuw voorstel van 25 naast de bewerkte order.
    assert.deepStrictEqual(writes(await refresh(kees)), { created: 1, updated: 0, removed: 0 });
    const view = (await proposals(kees)).orders;
    assert.strictEqual(view.length, 1);
    assert.notStrictEqual(view[0].id, proposal.id);
    assert.deepStrictEqual(view[0].lines.map((line) => line.qty), [25]);
    const kept = (await kees.get(`/app/api/purchase-orders/${proposal.id}`)).body;
    assert.deepStrictEqual([kept.origin, kept.notes, kept.lines[0].qty], ['handmatig', 'Eerst een paar', 5]);
    assert.deepStrictEqual(writes(await refresh(kees)), ZEROS);
  } finally {
    server.close();
  }
});

test('voorstellen: afwijzen, herstellen en afwijzingen opruimen', async () => {
  const { db, main, server, as } = await setup();
  try {
    const kees = await as('kees');
    const { supplier, pipe, valve } = await seed(kees);
    await kees.put(`/app/api/stock/items/${valve.id}/suppliers`, { suppliers: [{ supplierId: supplier.id, orderQty: 1, preferred: true }] });
    await refresh(kees);
    const order = (await proposals(kees)).orders[0];
    assert.deepStrictEqual(order.lines.map((line) => line.code), ['KLEP', 'PIJP']);

    // Foute invoer en verkeerde orders.
    assert.strictEqual((await kees.post('/app/api/purchase-orders/proposals/dismiss', { orderId: order.id, itemIds: [] })).status, 400);
    assert.strictEqual((await kees.post('/app/api/purchase-orders/proposals/dismiss', { orderId: order.id, itemIds: 'x' })).status, 400);
    assert.strictEqual((await kees.post('/app/api/purchase-orders/proposals/dismiss', { orderId: order.id, itemIds: ['niet-op-order'] })).status, 404);
    assert.strictEqual((await kees.post('/app/api/purchase-orders/proposals/dismiss', { orderId: 'onbekend' })).status, 404);
    const manual = (await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [] })).body;
    assert.strictEqual((await kees.post('/app/api/purchase-orders/proposals/dismiss', { orderId: manual.id })).status, 409);
    await kees.del(`/app/api/purchase-orders/${manual.id}`);

    // Eén regel afwijzen: de order blijft met de rest, de taak zet de regel niet terug.
    const one = await kees.post('/app/api/purchase-orders/proposals/dismiss', { orderId: order.id, itemIds: [valve.id] });
    assert.strictEqual(one.status, 200, JSON.stringify(one.body));
    assert.deepStrictEqual([one.body.removed, one.body.dismissed, one.body.order.lines.map((line) => line.code)], [false, 1, ['PIJP']]);
    assert.deepStrictEqual(await refresh(kees), { created: 0, updated: 0, removed: 0, skipped: 0, dismissedSkipped: 1 });
    assert.deepStrictEqual((await proposals(kees)).dismissed.map((row) => [row.itemId, row.code, row.name, Boolean(row.dismissedAt)]), [[valve.id, 'KLEP', 'Klep', true]]);

    // De hele order afwijzen: hij verdwijnt en komt niet terug.
    const whole = await kees.post('/app/api/purchase-orders/proposals/dismiss', { orderId: order.id });
    assert.deepStrictEqual([whole.body.removed, whole.body.order], [true, null]);
    assert.strictEqual((await kees.get(`/app/api/purchase-orders/${order.id}`)).status, 404);
    assert.deepStrictEqual(await refresh(kees), { created: 0, updated: 0, removed: 0, skipped: 0, dismissedSkipped: 2 });

    // Herstellen: de pijp komt bij de volgende ronde terug.
    assert.strictEqual((await kees.post('/app/api/purchase-orders/proposals/restore', { itemIds: [] })).status, 400);
    assert.deepStrictEqual((await kees.post('/app/api/purchase-orders/proposals/restore', { itemIds: [pipe.id] })).body, { restored: 1 });
    assert.deepStrictEqual(writes(await refresh(kees)), { created: 1, updated: 0, removed: 0 });
    assert.deepStrictEqual((await proposals(kees)).orders[0].lines.map((line) => line.code), ['PIJP']);

    // Weer genoeg voorraad (hier: minimum 0) ruimt de afwijzing op; later onder het minimum komt het artikel gewoon terug.
    await kees.put(`/app/api/stock/items/${valve.id}`, { minQty: 0 });
    await refresh(kees);
    assert.deepStrictEqual((await proposals(kees)).dismissed, []);
    await kees.put(`/app/api/stock/items/${valve.id}`, { minQty: 5 });
    assert.deepStrictEqual(writes(await refresh(kees)), { created: 0, updated: 1, removed: 0 });
    assert.deepStrictEqual((await proposals(kees)).orders[0].lines.map((line) => line.code), ['KLEP', 'PIJP']);

    // Een afgewezen artikel zonder boekingen is gewoon te verwijderen; de afwijzing gaat mee.
    const extra = (await kees.post('/app/api/stock/items', { code: 'LOS', name: 'Los', minQty: 2 })).body;
    await kees.put(`/app/api/stock/items/${extra.id}/suppliers`, { suppliers: [{ supplierId: supplier.id, orderQty: 1, preferred: true }] });
    await refresh(kees);
    const current = (await proposals(kees)).orders[0];
    await kees.post('/app/api/purchase-orders/proposals/dismiss', { orderId: current.id, itemIds: [extra.id] });
    const deleted = await kees.del(`/app/api/stock/items/${extra.id}`);
    assert.strictEqual(deleted.status, 200, JSON.stringify(deleted.body));
    assert.strictEqual(deleted.body.deleted, true);
    assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS n FROM purchase_proposal_dismissals WHERE tenant_id = ?').get(main).n), 0);
  } finally {
    server.close();
  }
});

test('voorstellen: goedkeuren bestelt, ook met mislukte ids', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const { supplier, pipe } = await seed(kees);
    await refresh(kees);
    const proposal = (await proposals(kees)).orders[0];
    const placedBefore = (await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [{ itemId: pipe.id, qty: 1 }] })).body;
    await kees.post(`/app/api/purchase-orders/${placedBefore.id}/place`);
    const empty = (await kees.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [] })).body;

    assert.strictEqual((await kees.post('/app/api/purchase-orders/proposals/approve', { ids: [] })).status, 400);
    assert.strictEqual((await kees.post('/app/api/purchase-orders/proposals/approve', { ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) })).status, 400);
    const out = await kees.post('/app/api/purchase-orders/proposals/approve', { ids: [proposal.id, 'onbekend', placedBefore.id, empty.id] });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.deepStrictEqual(out.body.placed, [{ id: proposal.id, number: proposal.number }]);
    assert.deepStrictEqual(out.body.failed.map((row) => row.id), ['onbekend', placedBefore.id, empty.id]);
    assert.strictEqual(out.body.failed[0].message, 'Inkooporder niet gevonden.');
    const placed = (await kees.get(`/app/api/purchase-orders/${proposal.id}`)).body;
    assert.deepStrictEqual([placed.status, placed.origin], ['besteld', 'voorstel']);
    // Het bestelde voorstel is onderweg: geen nieuw voorstel, en de taak raakt hem niet aan.
    assert.deepStrictEqual(writes(await refresh(kees)), ZEROS);
    assert.deepStrictEqual((await proposals(kees)).orders, []);
    // Een besteld voorstel is niet meer af te wijzen.
    assert.strictEqual((await kees.post('/app/api/purchase-orders/proposals/dismiss', { orderId: proposal.id })).status, 409);
  } finally {
    server.close();
  }
});

test('voorstellen: een backorder (reservering groter dan de voorraad) geeft een voorstel', async () => {
  const { db, main, server, as } = await setup();
  try {
    const kees = await as('kees');
    const supplier = (await kees.post('/app/api/suppliers', { name: 'Groothandel' })).body;
    const item = (await kees.post('/app/api/stock/items', { code: 'SPROEIER', name: 'Sproeier', costPrice: 4, minQty: 0, onHand: 2 })).body;
    await kees.put(`/app/api/stock/items/${item.id}/suppliers`, { suppliers: [{ supplierId: supplier.id, orderQty: 1, preferred: true }] });
    assert.deepStrictEqual(writes(await refresh(kees)), ZEROS);
    // Een bestelling reserveert 5 terwijl er 2 liggen: 3 tekort.
    db.prepare('INSERT INTO stock_reservations (tenant_id, work_order_id, item_id, qty, updated_at) VALUES (?, ?, ?, ?, ?)').run(main, 'order:test', item.id, 5, new Date().toISOString());
    assert.deepStrictEqual(writes(await refresh(kees)), { created: 1, updated: 0, removed: 0 });
    assert.deepStrictEqual((await proposals(kees)).orders[0].lines.map((line) => [line.code, line.qty, line.unitCost]), [['SPROEIER', 3, 4]]);
  } finally {
    server.close();
  }
});

test('voorstellen: rechten en andere organisatie', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const { pipe } = await seed(kees);
    await refresh(kees);
    const order = (await proposals(kees)).orders[0];

    const klant = await as('klant');
    for (const [method, path, body] of [['get', '/app/api/purchase-orders/proposals'], ['post', '/app/api/purchase-orders/proposals/refresh'],
      ['post', '/app/api/purchase-orders/proposals/approve', { ids: [order.id] }], ['post', '/app/api/purchase-orders/proposals/dismiss', { orderId: order.id }],
      ['post', '/app/api/purchase-orders/proposals/restore', { itemIds: [pipe.id] }]]) {
      assert.strictEqual((await klant[method](path, body)).status, 403, `${method} ${path}`);
    }

    await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    const piet = await as('piet', 'groen');
    assert.deepStrictEqual(await proposals(piet), { orders: [], dismissed: [], withoutSupplier: 0, enabled: true });
    assert.deepStrictEqual(await refresh(piet), { created: 0, updated: 0, removed: 0, skipped: 0, dismissedSkipped: 0 });
    const approve = (await piet.post('/app/api/purchase-orders/proposals/approve', { ids: [order.id] })).body;
    assert.deepStrictEqual([approve.placed, approve.failed.map((row) => row.id)], [[], [order.id]]);
    assert.strictEqual((await piet.post('/app/api/purchase-orders/proposals/dismiss', { orderId: order.id })).status, 404);
    // Afwijzen in de eigen organisatie; herstellen vanuit de andere organisatie raakt die afwijzing niet.
    await kees.post('/app/api/purchase-orders/proposals/dismiss', { orderId: order.id });
    assert.deepStrictEqual((await piet.post('/app/api/purchase-orders/proposals/restore', { itemIds: [pipe.id] })).body, { restored: 0 });
    assert.strictEqual((await proposals(kees)).dismissed.length, 1);
    assert.strictEqual((await kees.get(`/app/api/purchase-orders/${order.id}`)).status, 404);
  } finally {
    server.close();
  }
});

test('voorstellen: rondes tegelijk maken geen dubbele orders', async () => {
  const { db, main, server, as } = await setup();
  try {
    const kees = await as('kees');
    const baas = await as('baas');
    await seed(kees);
    const results = await Promise.all([refresh(kees), refresh(baas), refresh(kees)]);
    assert.strictEqual(results.reduce((sum, result) => sum + result.created, 0), 1);
    assert.strictEqual((await proposals(kees)).orders.length, 1);
    // De database houdt ook zelf hoogstens één voorstel-concept per leverancier aan.
    const row = db.prepare("SELECT id, number, supplier_id, created_at FROM purchase_orders WHERE tenant_id = ? AND origin = 'voorstel'").get(main);
    assert.throws(() => db.prepare(`INSERT INTO purchase_orders (id, tenant_id, number, supplier_id, status, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'concept', 'voorstel', ?, ?)`).run('dubbel', main, `${row.number}-x`, row.supplier_id, row.created_at, row.created_at));
  } finally {
    server.close();
  }
});
