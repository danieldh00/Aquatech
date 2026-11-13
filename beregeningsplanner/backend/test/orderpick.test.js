// Orderpick-app (webshop/orderpick.js, shipping-labels.js, pakbon per zending): de rol Picker mag alleen picken, de lijst en het detail
// bevatten geen prijzen of adressen, de regels staan op volgorde van magazijnlocatie met de juiste scancodes, afmelden verzendt de gepickte
// aantallen (minder = backorder), de pakbon klopt met wat echt gepickt is en het DPD-label heeft een nette haak.
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/platform/store');
const { createLogin } = require('./helpers/http-client');
const { postForm, postCheckout } = require('./helpers/http-client');
const { setup, PERSON, PW } = require('./helpers/webshop-world');
const { byLocation } = require('../src/webshop/orderpick');
const { orderForShipment } = require('../src/webshop/packing-slips');

const EAN_ITEM = '4006381333931';
const EAN_BOX = '5901234123457';

/**
 * Wereld met een picker, een tweede artikel met locatie en EAN en een doos van het eerste artikel.
 * @param {object} [options] Opties voor setup (appOptions).
 * @returns {Promise<object>} De wereld met `picker` (ingelogde client), `world.admin` en de artikelen.
 */
async function pickWorld(options = {}) {
  const world = await setup(options);
  const { admin, db } = world;
  const store = createStore(db);
  const main = db.prepare('SELECT id FROM tenants WHERE slug = ?').get('default') || db.prepare('SELECT id FROM tenants LIMIT 1').get();
  await store.createAccount(main.id, { username: 'piet', displayName: 'Piet Picker', role: 'picker', password: PW, mustChangePassword: false });
  world.picker = await createLogin(world.base, { password: PW })('piet');
  const bus = db.prepare("SELECT id FROM stock_items WHERE code = 'BUS'").get();
  assert.strictEqual((await admin.put(`/app/api/stock/items/${bus.id}`, { location: 'B-10', ean: EAN_ITEM })).status, 200);
  const saved = await admin.put(`/app/api/stock/items/${bus.id}/packagings`, { packagings: [{ code: 'DOOS', name: 'Doos', factor: 10, salePrice: 95, audience: 'iedereen', ean: EAN_BOX }] });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const made = await admin.post('/app/api/stock/items', { code: 'PIJP', name: 'Pijp', onHand: 20, salePrice: 3, location: 'A-2' });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const pijp = made.body;
    world.busId = bus.id;
  world.pijpId = pijp.id;
  return world;
}

/**
 * Plaatst een bestelling met regels uit de wagen.
 * @param {object} world De wereld.
 * @param {string[][]} cart Paren [code, aantal].
 * @param {object} [fields] Andere afrekengegevens.
 * @returns {Promise<string>} Id van de bestelling.
 */
async function placeOrder(world, cart, fields = {}) {
  const shopper = world.shoppers[0];
  for (const [code, qty] of cart) await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code, qty });
  const placed = await postCheckout(world.base, shopper.client, { ...PERSON, shippingMethod: 'ophalen', ...fields });
  assert.strictEqual(placed.status, 303, placed.text);
  const listed = await world.admin.get('/app/api/admin/web-orders');
  assert.ok(listed.body.items && listed.body.items.length, `bestelling niet geplaatst: ${JSON.stringify(Object.keys(placed))} ${placed.location} ${String(placed.text).slice(0, 200)} ${JSON.stringify(listed.body).slice(0, 300)}`);
  return listed.body.items[0].id;
}

test('byLocation: natuurlijke volgorde, zonder locatie onderaan', () => {
  const lines = [{ location: 'A-10', name: 'b' }, { location: '', name: 'a' }, { location: 'A-2', name: 'z' }, { location: 'A-2', name: 'c' }];
  assert.deepStrictEqual(lines.sort(byLocation).map((line) => `${line.location}/${line.name}`), ['A-2/c', 'A-2/z', 'A-10/b', '/a']);
});

test('de rol Picker heeft alleen het recht orderpick; andere rollen en klanten komen er niet in', async () => {
  const world = await pickWorld();
  const { picker, admin, shoppers, base } = world;
  const me = (await picker.get('/app/api/me')).body;
  assert.deepStrictEqual(me.rights, ['orderpick']);
  assert.strictEqual((await picker.get('/app/api/orderpick/orders')).status, 200);
  assert.strictEqual((await admin.get('/app/api/orderpick/orders')).status, 200, 'een beheerder mag ook picken');
  for (const url of ['/app/api/admin/web-orders', '/app/api/admin/web-orders/to-pick', '/app/api/stock/reorder', '/app/api/admin/settings']) {
    assert.strictEqual((await picker.get(url)).status, 403, url);
  }
  assert.strictEqual((await picker.post('/app/api/admin/web-orders/x/ship', {})).status, 403, 'de picker verzendt alleen via de orderpick-app');
  assert.strictEqual((await shoppers[0].client.get('/app/api/orderpick/orders')).status, 403, 'een winkelklant (rol klant) mag niet picken');
  const anonymous = await fetch(`${base}/app/api/orderpick/orders`);
  assert.strictEqual(anonymous.status, 401);
});

test('lijst en detail: geen prijzen of adres, regels op locatie, scancodes van artikel en verpakking', async () => {
  const world = await pickWorld();
  const { picker } = world;
  const id = await placeOrder(world, [['BUS', '3'], ['PIJP', '2'], ['BUS@DOOS', '1']], { note: 'Opmerking-met-telefoon 0612345678' });
  const list = (await picker.get('/app/api/orderpick/orders')).body;
  assert.strictEqual(list.items.length, 1);
  const entry = list.items[0];
  assert.deepStrictEqual([entry.id, entry.lineCount, entry.pieces, entry.pickup], [id, 3, 6, true]);
  assert.ok(!('customerName' in entry) && !('address' in entry) && !('totals' in entry) && !('note' in entry));
  assert.ok(!JSON.stringify(list).includes('Opmerking-met-telefoon'), 'de vrije opmerking van de klant blijft weg');

  const detail = (await picker.get(`/app/api/orderpick/orders/${id}`)).body.order;
  assert.deepStrictEqual(detail.lines.map((line) => [line.code, line.location]), [['PIJP', 'A-2'], ['BUS', 'B-10'], ['BUS@DOOS', 'B-10']]);
  const byCode = Object.fromEntries(detail.lines.map((line) => [line.code, line]));
  assert.deepStrictEqual(byCode.BUS.scanCodes, [EAN_ITEM, 'BUS']);
  assert.deepStrictEqual(byCode['BUS@DOOS'].scanCodes, [EAN_BOX, 'BUS@DOOS'], 'een verpakking scant met de eigen EAN, niet met die van het artikel');
  assert.strictEqual(byCode['BUS@DOOS'].packaging.factor, 10);
  assert.deepStrictEqual(byCode.PIJP.scanCodes, ['PIJP']);
  const text = JSON.stringify(detail);
  for (const secret of ['Opmerking-met-telefoon', 'unitExcl', 'lineTotal', 'Tuinstraat', 'els@bakker', 'Els Bakker', 'totals']) assert.ok(!text.includes(secret), `${secret} hoort niet in het detail`);
  assert.strictEqual(detail.shipmentCount, 0);
  assert.deepStrictEqual(detail.label, { required: false, available: false, carrier: '' });
});

test('afmelden: alles gepickt verzendt de bestelling en boekt af; de pakbon heeft de gepickte aantallen', async () => {
  const world = await pickWorld();
  const { picker, db } = world;
  const id = await placeOrder(world, [['BUS', '3'], ['PIJP', '2']]);
  const detail = (await picker.get(`/app/api/orderpick/orders/${id}`)).body.order;
  const parts = detail.lines.map((line) => ({ index: line.index, qty: line.ready }));
  const done = await picker.post(`/app/api/orderpick/orders/${id}/pick`, { lines: parts, shipmentCount: 0 });
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  assert.deepStrictEqual([done.body.complete, done.body.status], [true, 'verzonden']);
  assert.ok(!('order' in done.body), 'de picker krijgt de bestelling zelf niet terug');
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 47);
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'PIJP'").get().on_hand, 18);
  const slip = await picker.post(`/app/api/orderpick/orders/${id}/shipments/${done.body.shipment.id}/packing-slip`, {});
  assert.strictEqual(slip.status, 200);
  assert.strictEqual(slip.raw.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.strictEqual((await picker.get(`/app/api/orderpick/orders/${id}`)).status, 409, 'verzonden: niet meer te picken');
  assert.strictEqual((await picker.get('/app/api/orderpick/orders')).body.items.length, 0);
  const audit = db.prepare("SELECT action FROM audit WHERE action LIKE 'orderpick_%' ORDER BY created_at").all().map((row) => row.action);
  assert.deepStrictEqual(audit, ['orderpick_gepickt', 'orderpick_pakbon']);
});

test('minder gepickt of niet aanwezig: het verschil blijft op backorder en de pakbon toont besteld, nu en backorder', async () => {
  const world = await pickWorld();
  const { picker, admin, db } = world;
  const id = await placeOrder(world, [['BUS', '10'], ['PIJP', '2']]);
  const detail = (await picker.get(`/app/api/orderpick/orders/${id}`)).body.order;
  const bus = detail.lines.find((line) => line.code === 'BUS');
  const pijp = detail.lines.find((line) => line.code === 'PIJP');
  // BUS: 6 van de 10 in het schap; PIJP niet aanwezig (aantal 0).
  const part = await picker.post(`/app/api/orderpick/orders/${id}/pick`, { lines: [{ index: bus.index, qty: 6 }, { index: pijp.index, qty: 0 }], shipmentCount: 0 });
  assert.strictEqual(part.status, 200, JSON.stringify(part.body));
  assert.deepStrictEqual([part.body.complete, part.body.status], [false, 'nieuw']);
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 44);
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'PIJP'").get().on_hand, 20, 'niet aanwezig = niet afgeboekt');
  assert.strictEqual(Number(db.prepare('SELECT SUM(qty) AS n FROM stock_reservations WHERE work_order_id = ?').get(`order:${id}`).n), 6, 'reservering: 4 BUS + 2 PIJP');
  const order = (await admin.get(`/app/api/admin/web-orders/${id}`)).body.order;
  assert.deepStrictEqual(order.lines.map((line) => line.shippedQty), [6, 0]);
  assert.strictEqual(order.shipments.length, 1);
  // De bestelling is nog te picken (de rest staat leverbaar): de picker ziet alleen wat nog moet en het nieuwe aantal zendingen.
  const again = (await picker.get(`/app/api/orderpick/orders/${id}`)).body.order;
  assert.strictEqual(again.shipmentCount, 1);
  assert.deepStrictEqual(again.lines.map((line) => [line.code, line.ordered, line.shipped, line.remaining]), [['PIJP', 2, 0, 2], ['BUS', 10, 6, 4]]);

  const slip = await picker.post(`/app/api/orderpick/orders/${id}/shipments/${part.body.shipment.id}/packing-slip`, {});
  assert.strictEqual(slip.status, 200);
});

test('orderForShipment: de pakbon van een zending telt eerdere zendingen mee en laat zien wat nog op backorder staat', () => {
  const order = {
    lines: [{ qty: 10, shippedQty: 8, name: 'Sproeier' }, { qty: 2, shippedQty: 0, name: 'Pijp' }],
    shipments: [{ id: 'a', lines: [{ index: 0, qty: 2 }] }, { id: 'b', lines: [{ index: 0, qty: 6 }] }],
  };
  const first = orderForShipment(order, order.shipments[0], new Map([[0, '2026-12-01'], [1, '2026-12-02']])).fulfilment.lines;
  assert.deepStrictEqual([first[0].ordered, first[0].shipped, first[0].ready, first[0].backorder, first[0].expected], [10, 0, 2, 8, '2026-12-01'], 'de eerste zending: 2 nu, 8 nog te gaan');
  assert.deepStrictEqual([first[1].ready, first[1].backorder, first[1].expected], [0, 2, '2026-12-02'], 'een regel die nog niet is gepickt blijft backorder');
  const second = orderForShipment(order, order.shipments[1], new Map()).fulfilment;
  assert.deepStrictEqual([second.lines[0].shipped, second.lines[0].ready, second.lines[0].backorder], [2, 6, 2]);
  assert.strictEqual(second.complete, false);
  const whole = orderForShipment({ lines: [{ qty: 3, shippedQty: 3 }], shipments: [{ id: 'x', lines: [{ index: 0, qty: 3 }] }] }, { id: 'x', lines: [{ index: 0, qty: 3 }] }, new Map());
  assert.deepStrictEqual([whole.fulfilment.complete, whole.fulfilment.backorder], [true, false]);
});

test('controle: een verouderde afmelding, ongeldige aantallen en een onbekende of andere organisatie worden geweigerd', async () => {
  const world = await pickWorld();
  const { picker, db, base } = world;
  const id = await placeOrder(world, [['BUS', '4']]);
  const url = `/app/api/orderpick/orders/${id}/pick`;
  assert.strictEqual((await picker.post(url, {})).status, 400, 'zonder regels (nooit "alles")');
  assert.strictEqual((await picker.post(url, { lines: null, shipmentCount: 0 })).status, 400);
  assert.strictEqual((await picker.post(url, { lines: [{ index: 0, qty: 4 }] })).status, 400, 'zonder aantal bekende zendingen');
  assert.strictEqual((await picker.post(url, { lines: [{ index: 0, qty: 5 }], shipmentCount: 0 })).status, 400, 'meer dan besteld');
  assert.strictEqual((await picker.post(url, { lines: [{ index: 0, qty: -1 }], shipmentCount: 0 })).status, 400);
  assert.strictEqual((await picker.post(url, { lines: [{ index: 9, qty: 1 }], shipmentCount: 0 })).status, 400);
  assert.strictEqual((await picker.post(url, { lines: [{ index: 0, qty: null }], shipmentCount: 0 })).status, 400, 'NaN komt als null aan');
  assert.strictEqual((await picker.post(url, { lines: [{ index: 0, qty: '2' }], shipmentCount: 0 })).status, 400, 'een tekst is geen aantal');
  assert.strictEqual((await picker.post(url, { lines: [{ index: 0, qty: 1 }, { index: 0, qty: 1 }], shipmentCount: 0 })).status, 400, 'dezelfde regel twee keer');
  assert.strictEqual((await picker.post(url, { lines: Array.from({ length: 300 }, (_, index) => ({ index, qty: 1 })), shipmentCount: 0 })).status, 400, 'te veel regels');
  assert.strictEqual((await picker.post(url, { lines: [{ index: 0, qty: 0 }], shipmentCount: 0 })).status, 409, 'alles niet aanwezig = niets gepickt');
  db.prepare("UPDATE stock_items SET on_hand = 3 WHERE code = 'BUS'").run();
  const over = await picker.post(url, { lines: [{ index: 0, qty: 4 }], shipmentCount: 0 });
  assert.strictEqual(over.status, 400, 'de picker mag nooit meer dan leverbaar, ook niet met ignoreStock');
  assert.strictEqual((await picker.post(url, { lines: [{ index: 0, qty: 4 }], shipmentCount: 0, ignoreStock: true })).status, 400);
  const first = await picker.post(url, { lines: [{ index: 0, qty: 3 }], shipmentCount: 0 });
  assert.strictEqual(first.status, 200);
  const stale = await picker.post(url, { lines: [{ index: 0, qty: 1 }], shipmentCount: 0 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.body.error, 'changed');
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 0, 'niet dubbel afgeboekt');
  assert.strictEqual((await picker.get('/app/api/orderpick/orders/onbekend')).status, 404);
  assert.strictEqual((await picker.post('/app/api/orderpick/orders/onbekend/pick', { lines: [], shipmentCount: 0 })).status, 404);
  // Een picker van een andere organisatie ziet deze bestelling niet.
  const other = createStore(db);
  const foreignTenant = db.prepare("SELECT id FROM tenants WHERE slug = 'ander'").get();
  await other.createAccount(foreignTenant.id, { username: 'vreemdepicker', displayName: 'Vreemde', role: 'picker', password: PW, mustChangePassword: false });
  const stranger = await createLogin(base, { password: PW })('vreemdepicker', 'ander');
  assert.strictEqual((await stranger.get(`/app/api/orderpick/orders/${id}`)).status, 404);
  assert.strictEqual((await stranger.post(url, { lines: [{ index: 0, qty: 1 }], shipmentCount: 0 })).status, 404);
  assert.strictEqual((await stranger.get('/app/api/orderpick/orders')).body.items.length, 0);
});

test('wacht op voorraad: niet te picken en niet af te melden', async () => {
  const world = await pickWorld();
  const { picker, admin, db } = world;
  const id = await placeOrder(world, [['BUS', '4']]);
  db.prepare("UPDATE stock_items SET on_hand = 0 WHERE code = 'BUS'").run();
  const detail = await picker.get(`/app/api/orderpick/orders/${id}`);
  assert.strictEqual(detail.status, 409);
  assert.strictEqual(detail.body.error, 'waiting_for_stock');
  assert.strictEqual((await picker.get('/app/api/orderpick/orders')).body.waitingForStock, 1);
  const refused = await picker.post(`/app/api/orderpick/orders/${id}/pick`, { lines: [{ index: 0, qty: 1 }], shipmentCount: 0 });
  assert.strictEqual(refused.status, 400, 'er is niets leverbaar, dus ook niet 1 stuk');
  assert.strictEqual(db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 0);
  assert.ok(admin);
});

test('verzendlabel: zonder DPD-koppeling een nette melding, met koppeling het label en de volgcode bij de bestelling', async () => {
  const calls = [];
  const provider = { configured: () => true, create: async (tenantId, { order, shipment }) => { calls.push([order.number, shipment.id]); return { pdf: Buffer.from('%PDF-label'), trackingCode: 'DPD123456' }; } };
  const world = await pickWorld({ appOptions: { shippingLabelProviders: { dpd: provider } } });
  const { picker, admin } = world;
  const id = await placeOrder(world, [['BUS', '2']], { shippingMethod: 'dpd' });
  const detail = (await picker.get(`/app/api/orderpick/orders/${id}`)).body.order;
  assert.deepStrictEqual(detail.label, { required: true, available: true, carrier: 'dpd' });
  const done = await picker.post(`/app/api/orderpick/orders/${id}/pick`, { lines: [{ index: 0, qty: 2 }], shipmentCount: 0 });
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  assert.deepStrictEqual(done.body.label, { required: true, available: true, carrier: 'dpd' });
  const label = await picker.post(`/app/api/orderpick/orders/${id}/shipments/${done.body.shipment.id}/label`, {});
  assert.strictEqual(label.status, 200);
  assert.strictEqual(label.raw.toString('latin1'), '%PDF-label');
  assert.strictEqual(calls.length, 1);
  const second = await picker.post(`/app/api/orderpick/orders/${id}/shipments/${done.body.shipment.id}/label`, {});
  assert.strictEqual(second.status, 409);
  assert.strictEqual(second.body.error, 'label_exists');
  assert.match(second.body.message, /DPD123456/);
  assert.strictEqual(calls.length, 1, 'de vervoerder is maar één keer gebeld');
  assert.strictEqual((await admin.get(`/app/api/admin/web-orders/${id}`)).body.order.packingSlip, null, 'een zendingspakbon telt niet als afgedrukt in Te picken');
  const order = (await admin.get(`/app/api/admin/web-orders/${id}`)).body.order;
  assert.strictEqual(order.shipping.tracking.code, 'DPD123456');
  assert.strictEqual((await picker.post(`/app/api/orderpick/orders/${id}/shipments/onbekend/label`, {})).status, 404);

  const plain = await pickWorld();
  const otherId = await placeOrder(plain, [['BUS', '2']], { shippingMethod: 'dpd' });
  const sent = await plain.picker.post(`/app/api/orderpick/orders/${otherId}/pick`, { lines: [{ index: 0, qty: 2 }], shipmentCount: 0 });
  assert.deepStrictEqual(sent.body.label, { required: true, available: false, carrier: 'dpd' });
  const none = await plain.picker.post(`/app/api/orderpick/orders/${otherId}/shipments/${sent.body.shipment.id}/label`, {});
  assert.strictEqual(none.status, 409);
  assert.strictEqual(none.body.error, 'label_not_configured');
});

test('dropshipping zonder pakbon van de klant staat niet in de lijst en is niet te picken', async () => {
  const world = await pickWorld();
  const { picker } = world;
  const id = await placeOrder(world, [['BUS', '2']], { shippingMethod: 'dpd', dropshipping: 'ja', dropshipProofEmail: 'afleverbewijs@klant.example' });
  assert.strictEqual((await picker.get('/app/api/orderpick/orders')).body.items.length, 0);
  const detail = await picker.get(`/app/api/orderpick/orders/${id}`);
  assert.strictEqual(detail.status, 409);
  assert.strictEqual(detail.body.error, 'not_pickable');
  const pick = await picker.post(`/app/api/orderpick/orders/${id}/pick`, { lines: [{ index: 0, qty: 2 }], shipmentCount: 0 });
  assert.strictEqual(pick.status, 409);
  assert.strictEqual(world.db.prepare("SELECT on_hand FROM stock_items WHERE code = 'BUS'").get().on_hand, 50);
});

test('label: gelijktijdige aanvragen voor een zending (label_busy) en twee zendingen tegelijk houden de eerste volgcode', async () => {
  let counter = 0;
  const provider = {
    configured: () => true,
    create: async () => { counter += 1; await new Promise((resolve) => setTimeout(resolve, 300)); return { pdf: Buffer.from('%PDF-label'), trackingCode: `DPD00000${counter}` }; },
  };
  const world = await pickWorld({ appOptions: { shippingLabelProviders: { dpd: provider } } });
  const { picker, admin, db } = world;
  const id = await placeOrder(world, [['BUS', '4']], { shippingMethod: 'dpd' });
  // Twee zendingen: eerst 2, dan de rest.
  const first = await picker.post(`/app/api/orderpick/orders/${id}/pick`, { lines: [{ index: 0, qty: 2 }], shipmentCount: 0 });
  const second = await picker.post(`/app/api/orderpick/orders/${id}/pick`, { lines: [{ index: 0, qty: 2 }], shipmentCount: 1 });
  assert.deepStrictEqual([first.status, second.status, second.body.complete], [200, 200, true]);
  const urlOf = (shipment) => `/app/api/orderpick/orders/${id}/shipments/${shipment.body.shipment.id}/label`;
  // Dezelfde zending twee keer tegelijk: één label, de ander wacht.
  const [one, two] = await Promise.all([picker.post(urlOf(first), {}), picker.post(urlOf(first), {})]);
  assert.deepStrictEqual([one.status, two.status].sort(), [200, 409]);
  assert.ok([one, two].some((response) => response.body && response.body.error === 'label_busy'));
  assert.strictEqual(counter, 1, 'de vervoerder is één keer gebeld');
  // Een tweede zending krijgt ook een label, maar de volgcode van de bestelling verandert niet meer (onlyIfEmpty in de transactie).
  const second2 = await picker.post(urlOf(second), {});
  assert.strictEqual(second2.status, 200);
  const order = (await admin.get(`/app/api/admin/web-orders/${id}`)).body.order;
  assert.strictEqual(order.shipping.tracking.code, 'DPD000001', 'de eerste volgcode blijft staan');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM web_orders').get().n, 1);
});

test('label: lukt het vastleggen niet, dan geeft een nieuwe tik hetzelfde label terug en belt de vervoerder niet opnieuw', async () => {
  let calls = 0;
  const provider = { configured: () => true, create: async () => { calls += 1; return { pdf: Buffer.from('%PDF-label'), trackingCode: 'DPD777' }; } };
  const world = await pickWorld({ appOptions: { shippingLabelProviders: { dpd: provider } } });
  const { picker, db } = world;
  const id = await placeOrder(world, [['BUS', '2']], { shippingMethod: 'dpd' });
  const done = await picker.post(`/app/api/orderpick/orders/${id}/pick`, { lines: [{ index: 0, qty: 2 }], shipmentCount: 0 });
  const url = `/app/api/orderpick/orders/${id}/shipments/${done.body.shipment.id}/label`;
  // Het vastleggen van het label faalt (bijvoorbeeld een time-out): alle UPDATE's op de bestelling gooien.
  const realPrepare = db.prepare.bind(db);
  let failing = true;
  db.prepare = (sql, ...rest) => {
    if (failing && /^\s*UPDATE web_orders SET data/i.test(sql)) throw new Error('time-out');
    return realPrepare(sql, ...rest);
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const first = await picker.post(url, {});
    assert.strictEqual(first.status, 200);
    const again = await picker.post(url, {});
    assert.strictEqual(again.status, 200, 'het label uit het geheugen, geen label_exists en geen tweede label');
    assert.strictEqual(again.raw.toString('latin1'), '%PDF-label');
    assert.strictEqual(calls, 1, 'de vervoerder is maar één keer gebeld');
    // Daarna herstelt de database: de volgende tik legt het label alsnog vast en daarna geldt label_exists.
    failing = false;
    assert.strictEqual((await picker.post(url, {})).status, 200);
    assert.strictEqual((await picker.post(url, {})).body.error, 'label_exists');
    assert.strictEqual(calls, 1);
  } finally {
    console.warn = warn;
    db.prepare = realPrepare;
  }
});

test('label van een deelzending: de volgcode gaat bij de laatste zending naar de bestelling', async () => {
  const provider = { configured: () => true, create: async () => ({ pdf: Buffer.from('%PDF-label'), trackingCode: 'DPD555123' }) };
  const world = await pickWorld({ appOptions: { shippingLabelProviders: { dpd: provider } } });
  const { picker, admin } = world;
  const id = await placeOrder(world, [['BUS', '4']], { shippingMethod: 'dpd' });
  const first = await picker.post(`/app/api/orderpick/orders/${id}/pick`, { lines: [{ index: 0, qty: 2 }], shipmentCount: 0 });
  assert.strictEqual((await picker.post(`/app/api/orderpick/orders/${id}/shipments/${first.body.shipment.id}/label`, {})).status, 200);
  assert.ok(!(await admin.get(`/app/api/admin/web-orders/${id}`)).body.order.shipping.tracking, 'bestelling nog nieuw: nog geen volgcode');
  const second = await picker.post(`/app/api/orderpick/orders/${id}/pick`, { lines: [{ index: 0, qty: 2 }], shipmentCount: 1 });
  assert.strictEqual(second.body.complete, true);
  assert.strictEqual((await admin.get(`/app/api/admin/web-orders/${id}`)).body.order.shipping.tracking.code, 'DPD555123');
});
