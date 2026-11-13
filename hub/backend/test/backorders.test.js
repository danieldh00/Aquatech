// Backorders en deelleveringen (webshop/fulfilment.js, web-orders.js ship, pakbon en mail): de verdeling van de voorraad over open
// bestellingen (FIFO), de verwachte datum uit inkoop, deels verzenden, Deellevering toestaan, de pakbon met backorder,
// de mail en de markering na een ontvangst.
const test = require('node:test');
const assert = require('node:assert');
const { allocate, assignExpected, remainingOf, createFulfilment } = require('../src/webshop/fulfilment');
const { slipLines } = require('../src/webshop/packing-slips');
const { openDb } = require('../src/database/db');
const { postForm, postCheckout } = require('./helpers/http-client');
const { setup, until, mailsWith, PERSON } = require('./helpers/webshop-world');

test('allocate: de oudste bestelling krijgt als eerste, de rest wat overblijft', () => {
  const given = allocate(7, [{ orderId: 'a', qty: 5 }, { orderId: 'b', qty: 5 }, { orderId: 'c', qty: 1 }]);
  assert.deepStrictEqual([given.get('a'), given.get('b'), given.get('c')], [5, 2, 0]);
  assert.strictEqual(allocate(-3, [{ orderId: 'a', qty: 2 }]).get('a'), 0, 'negatieve voorraad deelt niets uit');
});

test('assignExpected: een tekort krijgt de datum van de inkoopregel die het dekt, zonder datum onderaan', () => {
  const incoming = [{ date: '2026-12-01', qty: 4 }, { date: '2026-12-15', qty: 10 }, { date: '', qty: 100 }];
  const result = assignExpected(incoming, [{ orderId: 'a', qty: 3 }, { orderId: 'b', qty: 3 }, { orderId: 'c', qty: 20 }]);
  assert.deepStrictEqual([result.get('a'), result.get('b'), result.get('c')], ['2026-12-01', '2026-12-15', ''], 'c wordt pas gedekt door de order zonder datum');
  assert.strictEqual(assignExpected([], [{ orderId: 'a', qty: 1 }]).get('a'), '', 'geen inkoop = onbekend');
});

test('remainingOf telt geleverd mee en wordt nooit negatief', () => {
  assert.strictEqual(remainingOf({ qty: 10, shippedQty: 4 }), 6);
  assert.strictEqual(remainingOf({ qty: 10 }), 10);
  assert.strictEqual(remainingOf({ qty: 2, shippedQty: 5 }), 0);
});

test('plan: FIFO over twee bestellingen, pakketten in hele stuks, artikelen zonder voorraadbeheer altijd leverbaar', () => {
  const db = openDb();
  const tenant = db.prepare('SELECT id FROM tenants LIMIT 1').get();
  const tenantId = tenant ? tenant.id : 't';
  if (!tenant) db.prepare("INSERT INTO tenants (id, slug, name, created_at) VALUES ('t', 'hoofd', 'Hoofd', '2026-01-01')").run();
  const now = '2026-11-01T10:00:00.000Z';
  const insertItem = db.prepare('INSERT INTO stock_items (id, tenant_id, code, name, unit, on_hand, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insertItem.run('i1', tenantId, 'A', 'Artikel A', 'st', 12, now, now);
  insertItem.run('i2', tenantId, 'B', 'Artikel B', 'st', 25, now, now);
  const plan = createFulfilment(db).plan(tenantId, [
    { id: 'old', number: 'W1', createdAt: '2026-11-01T09:00:00.000Z', status: 'nieuw', lines: [{ itemId: 'i1', qty: 10 }, { itemId: 'i2', qty: 1, stockPer: 10, shippedQty: 0 }, { itemId: '', qty: 3 }] },
    { id: 'new', number: 'W2', createdAt: '2026-11-02T09:00:00.000Z', status: 'nieuw', allowPartial: false, lines: [{ itemId: 'i1', qty: 5 }] },
  ]);
  const old = plan.get('old');
  assert.strictEqual(old.lines[0].ready, 10, 'de oudste krijgt eerst');
  assert.strictEqual(old.lines[1].ready, 1);
  assert.strictEqual(old.lines[2].ready, 3, 'een vrije regel is altijd leverbaar');
  assert.strictEqual(old.complete, true);
  const young = plan.get('new');
  assert.deepStrictEqual([young.lines[0].ready, young.lines[0].backorder], [2, 3], 'de jongste krijgt wat overblijft (12 - 10)');
  assert.strictEqual(young.backorder, true);
  assert.strictEqual(young.canShip, false, 'zonder Deellevering toestaan wacht de bestelling op de rest');
});

test('slipLines: met leverstatus staat nu, besteld en backorder erbij', () => {
  const order = { lines: [{ itemId: '1', code: 'X', name: 'Een', qty: 10, unit: 'st' }], fulfilment: { lines: [{ index: 0, ordered: 10, shipped: 2, ready: 5, backorder: 3, expected: '2026-12-01' }] } };
  const [line] = slipLines(order, new Map());
  assert.deepStrictEqual([line.ordered, line.shipped, line.qty, line.backorder, line.expected], [10, 2, 5, 3, '2026-12-01']);
  assert.strictEqual(slipLines({ lines: order.lines }, new Map())[0].qty, 10, 'zonder leverstatus gaat alles mee');
});

/**
 * Plaatst een bestelling van tien sproeiers (BUS) door de eerste klant.
 * @param {object} world De testwereld.
 * @param {number} [which] Welke klant (0 of 1).
 * @param {string} [qty] Het aantal.
 * @returns {Promise<string>} Id van de bestelling.
 */
async function orderTen(world, which = 0, qty = '10') {
  const shopper = world.shoppers[which];
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty });
  const placed = await postCheckout(world.base, shopper.client, { ...PERSON, shippingMethod: 'ophalen' });
  assert.strictEqual(placed.status, 303, placed.text);
  return (await world.admin.get('/app/api/admin/web-orders')).body.items[0].id;
}

/**
 * Zet de voorraad van BUS (de fysieke stand) op een aantal.
 * @param {object} db De database.
 * @param {number} onHand De stand.
 * @returns {void}
 */
const setStock = (db, onHand) => db.prepare("UPDATE stock_items SET on_hand = ? WHERE code = 'BUS'").run(onHand);

/**
 * Boekt een ontvangst van BUS via een inkooporder (zo komt de markering voor backorders tot stand).
 * @param {object} world De testwereld.
 * @param {number} qty Het ontvangen aantal.
 * @returns {Promise<void>}
 */
async function receive(world, qty) {
  const supplier = (await world.admin.post('/app/api/suppliers', { name: `Leverancier ${qty}` })).body;
  const item = world.db.prepare("SELECT id FROM stock_items WHERE code = 'BUS'").get();
  const made = await world.admin.post('/app/api/purchase-orders', { supplierId: supplier.id, receiveNow: true, lines: [{ itemId: item.id, qty, unitCost: 4 }] });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
}

test('deels verzenden: de rest blijft op backorder, de voorraad en reservering volgen, en de mail noemt de backorder', async () => {
  const world = await setup();
  const { admin, db, sent } = world;
  const id = await orderTen(world);
  setStock(db, 4);
  const detail = (await admin.get(`/app/api/admin/web-orders/${id}`)).body.order;
  assert.deepStrictEqual([detail.fulfilment.lines[0].ready, detail.fulfilment.lines[0].backorder, detail.fulfilment.canShip, detail.allowPartial], [4, 6, true, true]);
  const list = (await admin.get('/app/api/admin/web-orders/to-pick')).body;
  assert.strictEqual(list.items.length, 1);
  assert.deepStrictEqual([list.items[0].pieces, list.items[0].partial], [4, true]);

  const shipped = await admin.post(`/app/api/admin/web-orders/${id}/ship`, {});
  assert.strictEqual(shipped.status, 200, JSON.stringify(shipped.body));
  assert.strictEqual(shipped.body.complete, false);
  assert.strictEqual(shipped.body.order.status, 'nieuw');
  assert.strictEqual(shipped.body.order.lines[0].shippedQty, 4);
  assert.strictEqual(shipped.body.order.shipments.length, 1);
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 0);
  assert.strictEqual(Number(db.prepare("SELECT SUM(qty) AS n FROM stock_reservations WHERE work_order_id = ?").get(`order:${id}`).n), 6, 'de reservering krimpt tot de backorder');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n, 0, 'nog geen factuur zolang niet alles is geleverd');
  const mail = await until(() => mailsWith(sent, /Een deel van je bestelling/)[0]);
  assert.match(mail.text, /4 × Sproeier/);
  assert.match(mail.text, /Nog niet geleverd[\s\S]*6 × Sproeier/);

  // Er is niets leverbaar: geen tweede (lege) zending.
  const again = await admin.post(`/app/api/admin/web-orders/${id}/ship`, {});
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.body.error, 'nothing_to_ship');
  const waiting = (await admin.get('/app/api/admin/web-orders/to-pick')).body;
  assert.deepStrictEqual([waiting.items.length, waiting.waitingForStock.length], [0, 1]);
  const overview = (await admin.get('/app/api/admin/web-orders/backorders')).body;
  assert.strictEqual(overview.items.length, 1);
  assert.strictEqual(overview.items[0].fulfilment.lines[0].backorder, 6);
});

test('een ontvangst maakt de backorder leverbaar: markering, Te picken, nieuwe pakbon en afronden', async () => {
  const world = await setup();
  const { admin, db, sent } = world;
  const id = await orderTen(world);
  setStock(db, 4);
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${id}/ship`, {})).status, 200);
  assert.strictEqual((await admin.get(`/app/api/admin/web-orders/${id}`)).body.order.backorderReadyAt, null);
  await receive(world, 6);
  const marked = (await admin.get(`/app/api/admin/web-orders/${id}`)).body.order;
  assert.ok(marked.backorderReadyAt, 'de bestelling is gemarkeerd als klaar');
  const list = (await admin.get('/app/api/admin/web-orders/to-pick')).body;
  assert.deepStrictEqual([list.items.length, list.items[0].pieces, list.items[0].hadShipments, !!list.items[0].backorderReadyAt], [1, 6, true, true]);
  const slip = await admin.post(`/app/api/admin/web-orders/${id}/packing-slip`, {});
  assert.strictEqual(slip.status, 200);
  assert.strictEqual(slip.raw.subarray(0, 5).toString('latin1'), '%PDF-');

  const done = await admin.post(`/app/api/admin/web-orders/${id}/ship`, {});
  assert.strictEqual(done.status, 200);
  assert.strictEqual(done.body.complete, true);
  assert.strictEqual(done.body.order.status, 'verzonden');
  assert.strictEqual(done.body.order.shipments.length, 2);
  assert.strictEqual(done.body.order.backorderReadyAt, null);
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM stock_reservations WHERE work_order_id = ?").get(`order:${id}`).n, 0, 'geen reservering meer');
  await until(() => db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n === 1);
  const shippedMail = await until(() => mailsWith(sent, /is onderweg|staat klaar/).filter((message) => !/Een deel/.test(message.subject))[0]);
  assert.match(shippedMail.text, /6 × Sproeier/);
  assert.doesNotMatch(shippedMail.text, /10 × Sproeier/, 'de laatste zending noemt alleen wat nu komt');
});

test('de verwachte datum komt uit de openstaande inkooporder', async () => {
  const world = await setup();
  const { admin, db } = world;
  const id = await orderTen(world);
  setStock(db, 4);
  const supplier = (await admin.post('/app/api/suppliers', { name: 'Tuintechniek' })).body;
  const item = db.prepare("SELECT id FROM stock_items WHERE code = 'BUS'").get();
  const made = await admin.post('/app/api/purchase-orders', { supplierId: supplier.id, expectedDate: '2026-12-01', lines: [{ itemId: item.id, qty: 20, unitCost: 4 }] });
  assert.strictEqual(made.status, 201);
  assert.strictEqual((await admin.get(`/app/api/admin/web-orders/${id}`)).body.order.fulfilment.lines[0].expected, '', 'een concept telt niet mee');
  assert.strictEqual((await admin.post(`/app/api/purchase-orders/${made.body.id}/place`, {})).status, 200);
  assert.strictEqual((await admin.get(`/app/api/admin/web-orders/${id}`)).body.order.fulfilment.lines[0].expected, '2026-12-01');
});

test('zonder Deellevering toestaan wacht de bestelling op voorraad; aanzetten laat hem vrij', async () => {
  const world = await setup();
  const { admin, db } = world;
  const id = await orderTen(world);
  setStock(db, 4);
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${id}/allow-partial`, { allow: false })).status, 200);
  const waiting = (await admin.get('/app/api/admin/web-orders/to-pick')).body;
  assert.deepStrictEqual([waiting.items.length, waiting.waitingForStock.map((entry) => entry.id)], [0, [id]]);
  const slip = await admin.post(`/app/api/admin/web-orders/${id}/packing-slip`, {});
  assert.strictEqual(slip.status, 409);
  assert.match(slip.body.message, /Wacht op voorraad/);
  const refused = await admin.post(`/app/api/admin/web-orders/${id}/ship`, { lines: [{ index: 0, qty: 4 }], ignoreStock: false });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.body.error, 'partial_not_allowed');
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 4, 'niets afgeboekt');
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${id}/allow-partial`, { allow: true })).status, 200);
  assert.strictEqual((await admin.get('/app/api/admin/web-orders/to-pick')).body.items.length, 1);
});

test('minder gepickt dan leverbaar (orderpick): het verschil blijft op backorder; meer dan leverbaar mag alleen met ignoreStock', async () => {
  const world = await setup();
  const { admin, db } = world;
  const id = await orderTen(world);
  /**
   * De invoer om een aantal van de eerste regel te verzenden.
   * @param {number} qty Het aantal.
   * @returns {object} De body.
   */
  const lines = (qty) => ({ lines: [{ index: 0, qty }] });
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${id}/ship`, lines(11))).status, 400, 'meer dan besteld');
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${id}/ship`, lines(-1))).status, 400);
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${id}/ship`, { lines: [{ index: 3, qty: 1 }] })).status, 400, 'onbekende regel');
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${id}/ship`, { lines: [{ index: 0, qty: 1 }, { index: 0, qty: 1 }] })).status, 400, 'dezelfde regel twee keer');
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${id}/ship`, { lines: 'alles' })).status, 400);
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${id}/ship`, lines(0))).status, 409, '0 stuks is niets verzenden');
  const part = await admin.post(`/app/api/admin/web-orders/${id}/ship`, lines(7));
  assert.strictEqual(part.status, 200, JSON.stringify(part.body));
  assert.strictEqual(part.body.order.lines[0].shippedQty, 7);
  assert.strictEqual(part.body.order.fulfilment.lines[0].remaining, 3);
  // De voorraad staat nu op 43; 5 meer dan de 3 die nog moeten kan niet, en een stand lager dan het gevraagde alleen met ignoreStock.
  setStock(db, 1);
  const tooMuch = await admin.post(`/app/api/admin/web-orders/${id}/ship`, lines(3));
  assert.strictEqual(tooMuch.status, 400);
  assert.match(tooMuch.body.message, /nu maar 1 leverbaar/);
  const forced = await admin.post(`/app/api/admin/web-orders/${id}/ship`, { ...lines(3), ignoreStock: true });
  assert.strictEqual(forced.status, 200);
  assert.strictEqual(forced.body.order.status, 'verzonden');
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, -2, 'negatieve stand wordt een telverschil');
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${id}/ship`, {})).status, 409, 'een verzonden bestelling kan niet nog eens');
});

test('na een deellevering is annuleren niet meer mogelijk; Verzonden zetten levert de rest', async () => {
  const world = await setup();
  const { admin, db } = world;
  const id = await orderTen(world);
  setStock(db, 4);
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${id}/ship`, {})).status, 200);
  const cancel = await admin.post(`/app/api/admin/web-orders/${id}/status`, { status: 'geannuleerd' });
  assert.strictEqual(cancel.status, 409);
  assert.match(cancel.body.message, /al \(een deel van\) deze bestelling verzonden/);
  const rest = await admin.post(`/app/api/admin/web-orders/${id}/status`, { status: 'verzonden' });
  assert.strictEqual(rest.status, 200);
  const order = rest.body.order;
  assert.strictEqual(order.lines[0].shippedQty, 10);
  assert.deepStrictEqual(order.shipments.map((shipment) => shipment.lines[0].qty), [4, 6]);
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, -6, 'de rest is afgeboekt, de stand is een telverschil');
});

test('FIFO tussen twee bestellingen: de oudste krijgt de voorraad, de jongste staat op backorder', async () => {
  const world = await setup();
  const { admin, db } = world;
  const first = await orderTen(world, 0, '6');
  const second = await orderTen(world, 1, '6');
  setStock(db, 8);
  const older = (await admin.get(`/app/api/admin/web-orders/${first}`)).body.order.fulfilment;
  const younger = (await admin.get(`/app/api/admin/web-orders/${second}`)).body.order.fulfilment;
  assert.deepStrictEqual([older.lines[0].ready, older.complete], [6, true]);
  assert.deepStrictEqual([younger.lines[0].ready, younger.lines[0].backorder], [2, 4]);
  const overview = (await admin.get('/app/api/admin/web-orders/backorders')).body.items;
  assert.deepStrictEqual(overview.map((order) => order.id), [second]);
});

test('rechten en organisaties: een klant en een andere organisatie kunnen niet verzenden of backorders zien', async () => {
  const world = await setup();
  const { admin, vreemd, shoppers } = world;
  const id = await orderTen(world);
  const path = `/app/api/admin/web-orders/${id}`;
  assert.strictEqual((await vreemd.post(`${path}/ship`, {})).status, 404);
  assert.strictEqual((await vreemd.post(`${path}/allow-partial`, { allow: false })).status, 404);
  assert.deepStrictEqual((await vreemd.get('/app/api/admin/web-orders/backorders')).body.items, []);
  for (const route of ['ship', 'allow-partial']) assert.ok([401, 403].includes((await shoppers[0].client.post(`${path}/${route}`, {})).status));
  assert.ok([401, 403].includes((await shoppers[0].client.get('/app/api/admin/web-orders/backorders')).status));
  assert.strictEqual((await admin.get(path)).body.order.allowPartial, true, 'niets gewijzigd door de afgewezen verzoeken');
});

test('plan: het aantal queries hangt niet af van het aantal bestellingen of regels (geen N+1)', () => {
  const db = openDb();
  db.prepare("INSERT INTO tenants (id, slug, name, created_at) VALUES ('tq', 'tq', 'TQ', '2026-01-01')").run();
  const insertItem = db.prepare('INSERT INTO stock_items (id, tenant_id, code, name, unit, on_hand, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 20; i++) insertItem.run(`q${i}`, 'tq', `Q${i}`, `Artikel ${i}`, 'st', 5, '2026-01-01', '2026-01-01');
  let queries = 0;
  const prepare = db.prepare.bind(db);
  /**
   * Telt elke query van het statement.
   * @param {string} sql De SQL.
   * @returns {object} Het statement, met getelde get/all/run.
   */
  db.prepare = (sql) => {
    const statement = prepare(sql);
    return new Proxy(statement, { get: (target, property) => (['get', 'all', 'run'].includes(property) ? (...args) => { queries += 1; return target[property](...args); } : target[property]) });
  };
  /**
   * Maakt open bestellingen van vijf regels elk.
   * @param {number} count Het aantal bestellingen.
   * @returns {object[]} De bestellingen.
   */
  const build = (count) => Array.from({ length: count }, (_, position) => ({ id: `o${position}`, number: `W${position}`, createdAt: `2026-02-${String(position + 1).padStart(2, '0')}`, status: 'nieuw', lines: Array.from({ length: 5 }, (__, offset) => ({ itemId: `q${(position + offset) % 20}`, qty: 2 })) }));
  createFulfilment(db).plan('tq', build(1));
  const single = queries;
  queries = 0;
  const plan = createFulfilment(db).plan('tq', build(25));
  assert.strictEqual(queries, single, 'zelfde aantal queries voor 25 bestellingen als voor 1');
  assert.ok(single <= 4, `hoogstens vier queries per groep van 200 artikelen (${single})`);
  assert.strictEqual(plan.size, 25);
});

test('een tekort door een telverschil wordt onthouden en na een ontvangst gemarkeerd, zonder eerdere deellevering', async () => {
  const world = await setup();
  const { admin, db } = world;
  const id = await orderTen(world);
  assert.strictEqual((await admin.get(`/app/api/admin/web-orders/${id}`)).body.order.backorderSince, null, 'nog geen tekort');
  setStock(db, 4);
  await admin.get('/app/api/admin/web-orders/to-pick');
  assert.ok((await admin.get(`/app/api/admin/web-orders/${id}`)).body.order.backorderSince, 'het tekort is onthouden bij het bekijken van Te picken');
  await receive(world, 6);
  assert.ok((await admin.get(`/app/api/admin/web-orders/${id}`)).body.order.backorderReadyAt, 'na de ontvangst gemarkeerd als klaar');
});
