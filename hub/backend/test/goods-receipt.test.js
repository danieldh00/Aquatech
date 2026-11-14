// Goederenontvangst in de orderpick-app (artikelen/goods-receipt.js): de rol Picker mag ontvangen maar ziet geen prijzen, een order kiezen of scannen
// (ordernummer, leveranciersreferentie, artikel), deelontvangst, meer dan besteld alleen met bevestiging, een herhaalde of verouderde ontvangst boekt
// nooit dubbel, de voorraad en FIFO-laag volgen, een backorder wordt vrijgegeven, rechten, andere organisatie en een uitgezette module.
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/platform/store');
const { createLogin, postForm, postCheckout } = require('./helpers/http-client');
const { setup, PERSON, PW } = require('./helpers/webshop-world');
const { normalizeScan } = require('../src/artikelen/goods-receipt');

const EAN = '4006381333931';

/**
 * Wereld met een picker, een leverancier, een bestelde inkooporder met twee regels (sproeier BUS met EAN en locatie, pijp PIJP) en een concept-order.
 * @returns {Promise<object>} De wereld met `picker`, `order` (besteld), `draft` (concept), `busId` en `pijpId`.
 */
async function receiptWorld() {
  const world = await setup();
  const { admin, db } = world;
  const store = createStore(db);
  const mainId = store.ensureTenant().id;
  await store.createAccount(mainId, { username: 'piet', displayName: 'Piet Picker', role: 'picker', password: PW, mustChangePassword: false });
  world.picker = await createLogin(world.base, { password: PW })('piet');
  const bus = db.prepare("SELECT id FROM stock_items WHERE code = 'BUS'").get();
  assert.strictEqual((await admin.put(`/app/api/stock/items/${bus.id}`, { location: 'B-10', ean: EAN })).status, 200);
  const made = await admin.post('/app/api/stock/items', { code: 'PIJP', name: 'Pijp', onHand: 0, salePrice: 3, location: 'A-2' });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  world.busId = bus.id;
  world.pijpId = made.body.id;
  const supplier = (await admin.post('/app/api/suppliers', { name: 'Tuintechniek' })).body;
  world.supplier = supplier;
  const created = await admin.post('/app/api/purchase-orders', {
    supplierId: supplier.id, supplierReference: 'LEV-778', expectedDate: '2026-12-01',
    lines: [{ itemId: bus.id, qty: 10, unitCost: 4, supplierSku: 'TT-BUS' }, { itemId: world.pijpId, qty: 20, unitCost: 1.5 }],
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  assert.strictEqual((await admin.post(`/app/api/purchase-orders/${created.body.id}/place`, {})).status, 200);
  world.order = (await admin.get(`/app/api/purchase-orders/${created.body.id}`)).body;
  const draft = await admin.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [{ itemId: bus.id, qty: 1 }] });
  world.draft = draft.body;
  return world;
}

/**
 * De regel van een inkooporder bij een artikelcode.
 * @param {object} order De order met regels.
 * @param {string} code De artikelcode.
 * @returns {object} De regel.
 */
const lineOf = (order, code) => order.lines.find((line) => line.code === code);

test('normalizeScan: stuurtekens weg, hoofdletters, begrensd', () => {
  assert.strictEqual(normalizeScan(' io2026-0001\r\n'), 'IO2026-0001');
  assert.strictEqual(normalizeScan(null), '');
  assert.strictEqual(normalizeScan('x'.repeat(200)).length, 80);
});

test('lijst en detail: alleen bestelde orders, geen prijzen, regels op locatie met de juiste scancodes', async () => {
  const world = await receiptWorld();
  const { picker, order, draft } = world;
  const list = (await picker.get('/app/api/orderpick/receipts')).body;
  assert.deepStrictEqual(list.items.map((entry) => entry.number), [order.number], 'het concept staat er niet in');
  const entry = list.items[0];
  assert.deepStrictEqual([entry.supplierName, entry.supplierReference, entry.lineCount, entry.openQty, entry.partial, entry.expectedDate], ['Tuintechniek', 'LEV-778', 2, 30, false, '2026-12-01']);
  const detail = (await picker.get(`/app/api/orderpick/receipts/${order.id}`)).body.order;
  assert.deepStrictEqual(detail.lines.map((line) => [line.code, line.location, line.ordered, line.received, line.openQty]), [['PIJP', 'A-2', 20, 0, 20], ['BUS', 'B-10', 10, 0, 10]]);
  assert.deepStrictEqual(lineOf(detail, 'BUS').scanCodes, [EAN, 'BUS', 'TT-BUS']);
  const text = JSON.stringify({ list, detail });
  for (const secret of ['unitCost', 'amount', 'total', '"4"', '1.5']) assert.ok(!text.includes(secret), `${secret} hoort niet in het antwoord`);
  const notReady = await picker.get(`/app/api/orderpick/receipts/${draft.id}`);
  assert.strictEqual(notReady.status, 409);
  assert.strictEqual(notReady.body.error, 'not_receivable');
  assert.strictEqual((await picker.get('/app/api/orderpick/receipts/bestaat-niet')).status, 404);
});

test('opzoeken: ordernummer, leveranciersreferentie of artikel; zonder treffer niets', async () => {
  const world = await receiptWorld();
  const { picker, order, admin } = world;
  for (const code of [order.number, order.number.toLowerCase(), 'lev-778']) {
    const found = (await picker.get(`/app/api/orderpick/receipts/lookup?code=${encodeURIComponent(code)}`)).body;
    assert.deepStrictEqual([found.kind, found.orders.map((entry) => entry.id)], ['order', [order.id]], code);
  }
  for (const code of [EAN, 'PIJP', 'tt-bus']) {
    const found = (await picker.get(`/app/api/orderpick/receipts/lookup?code=${encodeURIComponent(code)}`)).body;
    assert.deepStrictEqual([found.kind, found.orders.map((entry) => entry.id)], ['article', [order.id]], code);
  }
  assert.deepStrictEqual((await picker.get('/app/api/orderpick/receipts/lookup?code=onbekend')).body, { kind: 'none', orders: [] });
  assert.deepStrictEqual((await picker.get('/app/api/orderpick/receipts/lookup')).body, { kind: 'none', orders: [] });
  // Een volledig ontvangen regel telt niet meer mee bij het zoeken op artikel.
  const pijp = lineOf(order, 'PIJP');
  assert.strictEqual((await admin.post(`/app/api/orderpick/receipts/${order.id}/receive`, { lines: [{ lineId: pijp.id, qty: 20, seen: 0 }] })).status, 200);
  assert.strictEqual((await picker.get('/app/api/orderpick/receipts/lookup?code=PIJP')).body.kind, 'none');
});

test('deelontvangst, daarna de rest: voorraad en FIFO-laag volgen, status en lijst kloppen, audit zonder bedragen', async () => {
  const world = await receiptWorld();
  const { picker, order, db } = world;
  const bus = lineOf(order, 'BUS');
  const pijp = lineOf(order, 'PIJP');
  const first = await picker.post(`/app/api/orderpick/receipts/${order.id}/receive`, { lines: [{ lineId: bus.id, qty: 4, seen: 0 }] });
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));
  assert.deepStrictEqual([first.body.status, first.body.complete, first.body.pieces, first.body.releasedOrders], ['deels_ontvangen', false, 4, 0]);
  assert.ok(!('order' in first.body) && !JSON.stringify(first.body).includes('unitCost'));
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 54);
  const listed = (await picker.get('/app/api/orderpick/receipts')).body.items[0];
  assert.deepStrictEqual([listed.partial, listed.openQty], [true, 26]);
  const detail = (await picker.get(`/app/api/orderpick/receipts/${order.id}`)).body.order;
  assert.deepStrictEqual([lineOf(detail, 'BUS').received, lineOf(detail, 'BUS').openQty], [4, 6]);
  const layer = db.prepare("SELECT unit_cost FROM stock_layers WHERE item_id = ? ORDER BY created_at DESC LIMIT 1").get(world.busId);
  assert.strictEqual(Number(layer.unit_cost), 4, 'de inkoopprijs van de regel komt in de FIFO-laag');

  const second = await picker.post(`/app/api/orderpick/receipts/${order.id}/receive`, { lines: [{ lineId: bus.id, qty: 6, seen: 4 }, { lineId: pijp.id, qty: 20, seen: 0 }] });
  assert.strictEqual(second.status, 200, JSON.stringify(second.body));
  assert.deepStrictEqual([second.body.status, second.body.complete], ['ontvangen', true]);
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'PIJP'").get().on_hand, 20);
  assert.deepStrictEqual((await picker.get('/app/api/orderpick/receipts')).body.items, []);
  assert.strictEqual((await picker.get(`/app/api/orderpick/receipts/${order.id}`)).status, 409, 'afgerond: niet meer te ontvangen');
  const audits = db.prepare("SELECT detail FROM audit WHERE action = 'orderpick_ontvangen' ORDER BY created_at").all().map((row) => JSON.parse(row.detail));
  assert.deepStrictEqual(audits.map((entry) => [entry.number, entry.status, entry.pieces]), [[order.number, 'deels_ontvangen', 4], [order.number, 'ontvangen', 26]]);
  assert.ok(!JSON.stringify(audits).includes('unitCost'));
});

test('veilig tegen dubbel boeken: verouderde stand, dubbel verzonden verzoek en meer dan besteld', async () => {
  const world = await receiptWorld();
  const { picker, order, db } = world;
  const bus = lineOf(order, 'BUS');
  const url = `/app/api/orderpick/receipts/${order.id}/receive`;
  assert.strictEqual((await picker.post(url, { lines: [{ lineId: bus.id, qty: 4, seen: 0 }] })).status, 200);
  const stale = await picker.post(url, { lines: [{ lineId: bus.id, qty: 4, seen: 0 }] });
  assert.deepStrictEqual([stale.status, stale.body.error], [409, 'changed'], 'dezelfde tik nogmaals (of een tweede scherm) boekt niets');
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 54);
  const over = await picker.post(url, { lines: [{ lineId: bus.id, qty: 7, seen: 4 }] });
  assert.deepStrictEqual([over.status, over.body.error], [409, 'over_received']);
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 54);
  const confirmed = await picker.post(url, { lines: [{ lineId: bus.id, qty: 7, seen: 4 }], allowOver: true });
  assert.strictEqual(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 61);
  assert.strictEqual(confirmed.body.status, 'deels_ontvangen', 'de pijp is nog niet binnen');
});

test('ongeldige invoer wordt geweigerd en laat de voorraad ongemoeid', async () => {
  const world = await receiptWorld();
  const { picker, order, db, draft } = world;
  const bus = lineOf(order, 'BUS');
  const url = `/app/api/orderpick/receipts/${order.id}/receive`;
  const bad = [
    [{}, 400], [{ lines: [] }, 400], [{ lines: 'x' }, 400],
    [{ lines: [{ lineId: bus.id, qty: 0, seen: 0 }] }, 400], [{ lines: [{ lineId: bus.id, qty: -1, seen: 0 }] }, 400],
    [{ lines: [{ lineId: bus.id, qty: '2', seen: 0 }] }, 400], [{ lines: [{ lineId: bus.id, qty: 2 }] }, 400],
    [{ lines: [{ lineId: bus.id, qty: 2, seen: 0 }, { lineId: bus.id, qty: 1, seen: 0 }] }, 400],
    [{ lines: [{ lineId: 'vreemd', qty: 1, seen: 0 }] }, 404],
  ];
  for (const [body, status] of bad) assert.strictEqual((await picker.post(url, body)).status, status, JSON.stringify(body));
  assert.strictEqual((await picker.post(`/app/api/orderpick/receipts/${draft.id}/receive`, { lines: [{ lineId: draft.lines[0].id, qty: 1, seen: 0 }] })).status, 409, 'een concept is niet te ontvangen');
  assert.strictEqual((await picker.post('/app/api/orderpick/receipts/bestaat-niet/receive', { lines: [{ lineId: 'x', qty: 1, seen: 0 }] })).status, 404);
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 50);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'orderpick_ontvangen'").get().n, 0);
});

test('een ontvangst geeft de backorder van een webshopbestelling vrij (Te picken)', async () => {
  const world = await receiptWorld();
  const { picker, admin, order, db } = world;
  const shopper = world.shoppers[0];
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '10' });
  const placed = await postCheckout(world.base, shopper.client, { ...PERSON, shippingMethod: 'ophalen' });
  assert.strictEqual(placed.status, 303, placed.text);
  const id = (await admin.get('/app/api/admin/web-orders')).body.items[0].id;
  // Een telverschil laat maar 4 van de 10 over: dat deel gaat weg, de rest wordt een backorder.
  db.prepare("UPDATE stock_items SET on_hand = 4 WHERE code = 'BUS'").run();
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${id}/ship`, {})).status, 200);
  assert.strictEqual((await picker.get('/app/api/orderpick/orders')).body.items.length, 0, 'de rest wacht op voorraad');
  const bus = lineOf(order, 'BUS');
  const received = await picker.post(`/app/api/orderpick/receipts/${order.id}/receive`, { lines: [{ lineId: bus.id, qty: 6, seen: 0 }] });
  assert.strictEqual(received.status, 200, JSON.stringify(received.body));
  assert.strictEqual(received.body.releasedOrders, 1);
  const toPick = (await picker.get('/app/api/orderpick/orders')).body;
  assert.deepStrictEqual([toPick.items.length, toPick.items[0].pieces, toPick.items[0].hadShipments], [1, 6, true], 'de rest staat weer in Te picken');
  assert.ok((await admin.get(`/app/api/admin/web-orders/${id}`)).body.order.backorderReadyAt);
});

test('rechten en scheiding: zonder recht 403, andere organisatie 404, uitgezette module weigert schrijven', async () => {
  const world = await receiptWorld();
  const { picker, order, shoppers, base, vreemd, admin } = world;
  assert.strictEqual((await shoppers[0].client.get('/app/api/orderpick/receipts')).status, 403, 'een winkelklant mag niet ontvangen');
  assert.strictEqual((await fetch(`${base}/app/api/orderpick/receipts`)).status, 401);
  assert.strictEqual((await picker.get('/app/api/purchase-orders')).status, 403, 'de picker beheert geen inkooporders');
  assert.strictEqual((await picker.post('/app/api/purchase-orders/x/receive', { lines: [] })).status, 403);
  // Een beheerder van een andere organisatie ziet deze order niet.
  assert.deepStrictEqual((await vreemd.get('/app/api/orderpick/receipts')).body.items, []);
  assert.strictEqual((await vreemd.get(`/app/api/orderpick/receipts/${order.id}`)).status, 404);
  const bus = lineOf(order, 'BUS');
  assert.strictEqual((await vreemd.post(`/app/api/orderpick/receipts/${order.id}/receive`, { lines: [{ lineId: bus.id, qty: 1, seen: 0 }] })).status, 404);
  assert.deepStrictEqual((await vreemd.get('/app/api/orderpick/receipts/lookup?code=PIJP')).body, { kind: 'none', orders: [] });
  // Module Voorraad uit: lezen blijft, boeken niet.
  assert.strictEqual((await admin.put('/app/api/admin/settings', { modules: { voorraad: false } })).status, 200);
  const blocked = await picker.post(`/app/api/orderpick/receipts/${order.id}/receive`, { lines: [{ lineId: bus.id, qty: 1, seen: 0 }] });
  assert.deepStrictEqual([blocked.status, blocked.body.error], [409, 'module_off']);
  assert.strictEqual((await picker.get('/app/api/orderpick/receipts')).status, 200);
});
