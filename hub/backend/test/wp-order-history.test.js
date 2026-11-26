// Orderhistorie uit de oude WordPress-webshop (webshop/wp-order-history.js): ophalen zonder iets terug te schrijven, koppelen aan artikelen (ook na het
// samenvoegen tot variabele producten), opnieuw ophalen zonder dubbelingen, handmatig koppelen en meetellen in Vaak samen besteld.
process.env.SHOP_ALLOW_INSECURE = '1';
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createStockStore } = require('../src/artikelen/stock');
const { createRelatedStore } = require('../src/artikelen/related-items');
const { createWpOrderHistory, linesOf, orderedAtOf, customerOf } = require('../src/webshop/wp-order-history');

/**
 * Een WooCommerce-bestelling met de regels die de test nodig heeft.
 * @param {number} id Bestelnummer.
 * @param {object[]} items De regels (product_id, variation_id, sku, name, quantity).
 * @param {object} [extra] Velden die de standaard overschrijven.
 * @returns {object} De bestelling.
 */
const wcOrder = (id, items, extra = {}) => ({
  id, status: 'completed', date_created_gmt: `2026-10-${String(1 + (id % 25)).padStart(2, '0')}T09:00:00`, date_modified_gmt: `2026-10-26T08:${String(Math.floor(id / 60)).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}`,
  line_items: items.map((item, index) => ({ id: id * 10 + index, quantity: 1, product_id: 0, variation_id: 0, sku: '', name: '', ...item })), ...extra,
});

/**
 * Nagebootste WooCommerce die alleen bestellingen kent en elk verzoek bijhoudt.
 * @param {object[]} orders Alle bestellingen.
 * @returns {{ fetchImpl: Function, calls: object[] }} De nagebootste fetch en de gedane verzoeken.
 */
function fakeWordPress(orders) {
  const calls = [];
  /**
   * Beantwoordt één verzoek met een pagina bestellingen (gefilterd op modified_after).
   * @param {string} url Adres van het verzoek.
   * @param {object} [options] fetch-opties (voor de methode).
   * @returns {Promise<object>} Antwoord zoals fetch het geeft.
   */
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = new URL(url);
    calls.push({ method: (options.method || 'GET').toUpperCase(), path: requestUrl.pathname });
    const after = requestUrl.searchParams.get('modified_after') || '';
    const page = Number(requestUrl.searchParams.get('page') || 1);
    const matching = orders.filter((order) => !after || order.date_modified_gmt > after).sort((left, right) => (left.date_modified_gmt < right.date_modified_gmt ? -1 : 1));
    const body = matching.slice((page - 1) * 100, page * 100);
    return { ok: true, status: 200, headers: new Headers({ 'x-wp-totalpages': String(Math.max(1, Math.ceil(matching.length / 100))) }), text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

/**
 * Een omgeving met twee samengevoegde artikelen (oude webshop-id's 55 en 56), een variatie-koppeling en losse artikelen.
 * @param {object[]} orders De bestellingen van de nagebootste WordPress.
 * @returns {object} db, tenantId, history, stock, related, wordpress en de artikelen.
 */
function world(orders) {
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  const stock = createStockStore(db);
  const user = { id: null, display_name: 'Test' };
  /**
   * Maakt een artikel.
   * @param {string} code Artikelcode.
   * @param {string} name Omschrijving.
   * @returns {object} Het artikel.
   */
  const make = (code, name) => stock.create(tenantId, user, { code, name, unit: 'st' }).item;
  const pe16 = make('PE-16', 'PE-buis 16 mm');
  const pe20 = make('PE-20', 'PE-buis 20 mm');
  db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE id = ?').run('55', pe16.id);
  db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE id = ?').run('56', pe20.id);
  const merged = stock.mergeIntoVariants(tenantId, { ids: [pe16.id, pe20.id], code: 'PE', name: 'PE-buis', attributeName: 'Maat', values: { [pe16.id]: '16 mm', [pe20.id]: '20 mm' } });
  const sproeier = make('SP-1', 'Sproeier');
  const kraan = make('KR-1', 'Kraan');
  const filter = make('FI-1', 'Filter');
  const other = make('OV-1', 'Overig product');
  db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE id = ?').run('900', kraan.id);
  const wordpress = fakeWordPress(orders);
  const settings = { get: (key) => ({ shopSource: { url: 'http://wp.test', mode: 'rest' }, shopConsumerKey: 'ck_test_1234567890', shopConsumerSecret: 'cs_test_1234567890' })[key] };
  const related = createRelatedStore(db);
  const history = createWpOrderHistory({ db, settingsFor: () => settings, fetchImpl: wordpress.fetchImpl, afterImport: (id) => related.refreshTogether(id), customers: store });
  return { store, db, tenantId, history, stock, related, wordpress, pe16, pe20, parentId: merged.parentId, sproeier, kraan, filter, other };
}

/**
 * Wacht tot de serverjob klaar is.
 * @param {object} history De opslag.
 * @param {string} tenantId Id van de omgeving.
 * @returns {Promise<void>}
 */
async function finished(history, tenantId) {
  for (let attempt = 0; attempt < 200 && history.status(tenantId).running; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(history.status(tenantId).running, false);
}

test('regels en datum: nul-id\'s worden leeg, onbruikbare aantallen vallen weg, GMT-datum wordt UTC', () => {
  const lines = linesOf(wcOrder(1, [{ product_id: 5, variation_id: 0, sku: ' A ', name: 'Een', quantity: 2 }, { product_id: 6, quantity: 0 }, { product_id: 7, quantity: 'x' }]));
  assert.deepStrictEqual(lines, [{ lineId: '10', productId: '5', variationId: '', sku: 'A', name: 'Een', qty: 2 }]);
  assert.strictEqual(orderedAtOf({ date_created_gmt: '2026-10-20T09:00:00' }), '2026-10-20T09:00:00.000Z');
  assert.strictEqual(orderedAtOf({ date_created_gmt: '' }), null);
});

test('koppelen: variatie, nieuw en oud product-id (na het samenvoegen), sku, en wat niet past blijft over', async () => {
  const orders = [wcOrder(1, [
    { product_id: 55, name: 'PE-buis 16 mm' }, { product_id: 900, variation_id: 0, name: 'Kraan' }, { sku: 'sp-1', name: 'Sproeier' },
    { product_id: 4321, name: 'Onbekend ding' },
  ]), wcOrder(2, [{ product_id: 3000, name: 'Cadeaubon' }], { status: 'cancelled' }), wcOrder(3, [{ product_id: 3001, name: 'Concept' }], { status: 'pending' })];
  const scene = world(orders);
  const outcome = await scene.history.importOrders(scene.tenantId);
  assert.strictEqual(outcome.orders, 1, 'alleen afgeronde en lopende bestellingen tellen');
  const byKey = Object.fromEntries(scene.db.prepare('SELECT product_id, item_id, matched_by FROM wp_order_lines WHERE tenant_id = ?').all(scene.tenantId).map((row) => [row.product_id || 'sku', row]));
  assert.strictEqual(String(byKey['55'].item_id), String(scene.pe16.id), 'oud product-id naar de variant');
  assert.strictEqual(byKey['55'].matched_by, 'oud-product');
  assert.strictEqual(byKey['900'].matched_by, 'product');
  assert.strictEqual(byKey.sku.matched_by, 'sku');
  assert.strictEqual(byKey['4321'].item_id, null);
  assert.strictEqual(scene.history.unmatched(scene.tenantId).length, 1);
  assert.ok(scene.wordpress.calls.every((call) => call.method === 'GET'), 'er wordt niets naar WordPress teruggeschreven');
  // Geen echte bestelling, voorraadmutatie of factuur.
  for (const table of ['web_orders', 'invoices', 'stock_movements']) assert.strictEqual(Number(scene.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(scene.tenantId).n), 0, table);
});

test('opnieuw ophalen geeft geen dubbelingen en een handmatige koppeling blijft staan', async () => {
  const scene = world([wcOrder(1, [{ product_id: 4321, name: 'Onbekend ding' }, { sku: 'SP-1' }])]);
  await scene.history.importOrders(scene.tenantId);
  const group = scene.history.unmatched(scene.tenantId)[0];
  assert.deepStrictEqual(scene.history.link(scene.tenantId, group, scene.other.id), { updated: 1 });
  assert.strictEqual(scene.history.link(scene.tenantId, group, '00000000-0000-4000-8000-000000000000').status, 404);
  scene.db.prepare("UPDATE wp_order_import SET orders_after = NULL WHERE tenant_id = ?").run(scene.tenantId);
  const again = await scene.history.importOrders(scene.tenantId);
  assert.strictEqual(again.lines, 0, 'niets nieuws weggeschreven');
  assert.strictEqual(Number(scene.db.prepare('SELECT COUNT(*) AS n FROM wp_order_lines WHERE tenant_id = ?').get(scene.tenantId).n), 2);
  assert.strictEqual(scene.history.unmatched(scene.tenantId).length, 0);
  assert.strictEqual(scene.history.status(scene.tenantId).matched, 2);
  // Een artikel dat later bijkomt koppelt via rematch.
  scene.db.prepare("UPDATE wp_order_lines SET item_id = NULL, matched_by = '' WHERE tenant_id = ? AND sku = 'SP-1'").run(scene.tenantId);
  assert.strictEqual(scene.history.rematch(scene.tenantId), 1);
});

test('serverjob: start geeft meteen antwoord, zet uurlijks bijwerken aan en Vaak samen besteld telt de historie mee (varianten als hoofdartikel)', async () => {
  // 7 bestellingen met buis (variant) + sproeier samen, en losse bestellingen van kraan en filter: een duidelijk paar.
  const orders = [];
  for (let id = 1; id <= 7; id++) orders.push(wcOrder(id, [{ product_id: id % 2 ? 55 : 56, name: 'PE-buis' }, { sku: 'SP-1', name: 'Sproeier' }]));
  for (let id = 8; id <= 12; id++) orders.push(wcOrder(id, [{ product_id: 900, name: 'Kraan' }]));
  for (let id = 13; id <= 17; id++) orders.push(wcOrder(id, [{ sku: 'FI-1', name: 'Filter' }]));
  const scene = world(orders);
  assert.strictEqual(scene.history.status(scene.tenantId).enabled, false);
  const started = scene.history.start(scene.tenantId, { months: 24 });
  assert.strictEqual(started.started, true);
  assert.strictEqual(scene.history.start(scene.tenantId).started, false, 'een tweede start tijdens de ronde doet niets');
  await finished(scene.history, scene.tenantId);
  const status = scene.history.status(scene.tenantId);
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.error, '');
  assert.strictEqual(status.orders, 17);
  assert.strictEqual(status.unmatched, 0);
  const partners = scene.db.prepare('SELECT item_id, other_id, orders_both FROM item_together WHERE tenant_id = ?').all(scene.tenantId);
  assert.ok(partners.some((row) => String(row.item_id) === String(scene.parentId) && String(row.other_id) === String(scene.sproeier.id) && Number(row.orders_both) === 7), 'buis (hoofdartikel) en sproeier horen bij elkaar');
  // De uurlijkse ronde slaat omgevingen over waar het uit staat.
  scene.history.stop(scene.tenantId);
  assert.deepStrictEqual(await scene.history.runAll([scene.tenantId]), {});
  scene.history.start(scene.tenantId);
  await finished(scene.history, scene.tenantId);
  assert.deepStrictEqual(Object.keys(await scene.history.runAll([scene.tenantId])), [scene.tenantId]);
});

test('zonder REST-koppeling mislukt het ophalen met een duidelijke melding en blijft de fout bewaard', async () => {
  const db = openDb();
  const tenantId = createStore(db).ensureTenant().id;
  const history = createWpOrderHistory({ db, settingsFor: () => ({ get: () => ({}) }) });
  history.start(tenantId);
  await finished(history, tenantId);
  assert.match(history.status(tenantId).error, /niet gekoppeld/);
});

test('klanten: elke bestelling met een e-mailadres maakt een klant (zonder inlog), een bestaand adres blijft ongemoeid en opnieuw ophalen maakt er geen bij', async () => {
  /**
   * Factuurgegevens van een bestelling.
   * @param {string} first Voornaam.
   * @param {string} email E-mailadres.
   * @param {object} [extra] Velden die de standaard overschrijven.
   * @returns {object} De factuurgegevens.
   */
  const billing = (first, email, extra = {}) => ({ first_name: first, last_name: 'Jansen', company: '', address_1: 'Kerkstraat 12', postcode: '8071 CD', city: 'Nunspeet', country: 'NL', email, phone: '0612345678', ...extra });
  const orders = [
    wcOrder(1, [{ sku: 'SP-1' }], { billing: billing('Petra', 'Petra@Voorbeeld.test') }),
    wcOrder(2, [{ sku: 'SP-1' }], { billing: billing('Petra', 'petra@voorbeeld.test') }),
    wcOrder(3, [{ sku: 'SP-1' }], { billing: billing('Jan', 'jan@voorbeeld.test', { company: 'Tuin BV', country: 'BE' }) }),
    wcOrder(4, [{ sku: 'SP-1' }], { billing: billing('Bestaand', 'bestaand@voorbeeld.test') }),
    wcOrder(5, [{ sku: 'SP-1' }], { billing: billing('Zonder', '') }),
    wcOrder(6, [{ sku: 'SP-1' }], { billing: billing('Geannuleerd', 'weg@voorbeeld.test'), status: 'cancelled' }),
  ];
  const scene = world(orders);
  const existing = scene.store.createCustomer(scene.tenantId, { displayName: 'Bestaande klant', email: 'bestaand@voorbeeld.test' }).user;
  const outcome = await scene.history.importOrders(scene.tenantId);
  assert.strictEqual(outcome.customers, 2, 'Petra (één keer, hoofdletters tellen niet) en Tuin BV');
  const petra = scene.db.prepare("SELECT id, display_name, phone, address, password_hash FROM users WHERE tenant_id = ? AND email = 'petra@voorbeeld.test'").get(scene.tenantId);
  assert.strictEqual(petra.display_name, 'Petra Jansen');
  assert.strictEqual(petra.address, 'Kerkstraat 12\n8071 CD  Nunspeet');
  assert.strictEqual(petra.password_hash, null, 'geen inlog');
  const company = scene.db.prepare("SELECT display_name, address FROM users WHERE tenant_id = ? AND email = 'jan@voorbeeld.test'").get(scene.tenantId);
  assert.strictEqual(company.display_name, 'Tuin BV');
  assert.match(company.address, /BE$/);
  assert.strictEqual(scene.db.prepare("SELECT display_name FROM users WHERE tenant_id = ? AND id = ?").get(scene.tenantId, existing.id).display_name, 'Bestaande klant', 'bestaande klant blijft zoals hij was');
  assert.strictEqual(Number(scene.db.prepare("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND email = 'weg@voorbeeld.test'").get(scene.tenantId).n), 0, 'geannuleerd maakt geen klant');
  scene.db.prepare('UPDATE wp_order_import SET orders_after = NULL WHERE tenant_id = ?').run(scene.tenantId);
  assert.strictEqual((await scene.history.importOrders(scene.tenantId)).customers, 0);
  assert.strictEqual(scene.history.status(scene.tenantId).customers, 2);
  assert.strictEqual(customerOf({ billing: { email: 'geen-adres', first_name: 'X' } }), null);
});

test('routes: rechten, andere organisatie, limiet en module uit', async () => {
  const { setup: webshopSetup } = require('./helpers/webshop-world');
  const world = await webshopSetup();
  const { admin, vreemd } = world;
  const shopper = world.shoppers[0].client;
  const own = (await admin.post('/app/api/stock/items', { code: 'WP-1', name: 'Eigen artikel', onHand: 1, salePrice: 5 })).body;
  const foreign = (await vreemd.post('/app/api/stock/items', { code: 'WP-2', name: 'Vreemd artikel', onHand: 1, salePrice: 5 })).body;
  const base = '/app/api/stock/related/wp-orders';
  const tenantId = world.db.prepare("SELECT id FROM tenants WHERE slug = 'default' OR parent_id IS NULL ORDER BY created_at LIMIT 1").get().id;
  world.db.prepare("INSERT INTO wp_order_lines (id, tenant_id, wp_order_id, wp_line_id, ordered_at, product_id, name, qty) VALUES (?, ?, '1', '1', now(), '77', 'Onbekend', 1)").run(require('crypto').randomUUID(), tenantId);
  // Zonder recht voorraad: geen toegang.
  assert.strictEqual((await shopper.get(base)).status, 403);
  assert.strictEqual((await shopper.post(`${base}/start`, {})).status, 403);
  assert.strictEqual((await shopper.post(`${base}/stop`, {})).status, 403);
  assert.strictEqual((await shopper.post(`${base}/link`, { productId: '77', name: 'Onbekend', itemId: own.id })).status, 403);
  // Een andere organisatie ziet de regels niet en kan er geen artikel van een ander aan koppelen.
  const foreignView = await vreemd.get(base);
  assert.strictEqual(foreignView.status, 200);
  assert.strictEqual(foreignView.body.status.lines, 0);
  assert.strictEqual(foreignView.body.unmatched.length, 0);
  assert.strictEqual((await admin.post(`${base}/link`, { productId: '77', name: 'Onbekend', itemId: foreign.id })).status, 404, 'artikel van een andere organisatie');
  const linked = await admin.post(`${base}/link`, { productId: '77', name: 'Onbekend', itemId: own.id });
  assert.strictEqual(linked.status, 200);
  assert.strictEqual(linked.body.updated, 1);
  // Starten zonder REST-koppeling geeft meteen 202; de fout staat daarna in de stand. De limiet is 10 per uur.
  const started = await admin.post(`${base}/start`, {});
  assert.strictEqual(started.status, 202);
  for (let attempt = 0; attempt < 9; attempt++) await admin.post(`${base}/start`, {});
  assert.strictEqual((await admin.post(`${base}/start`, {})).status, 429);
  assert.strictEqual((await admin.post(`${base}/stop`, {})).status, 200);
  // Module uit: ook deze adressen zijn dicht.
  assert.strictEqual((await admin.put('/app/api/admin/modules', { flags: { 'gerelateerde-artikelen': false } })).status, 200);
  assert.strictEqual((await admin.get(base)).status, 409);
  assert.strictEqual((await admin.post(`${base}/start`, {})).status, 409);
});

test('kopgegevens voor de lijst: alle echte statussen, bijgewerkt bij opnieuw ophalen, en de lijst toont ze alleen lezen met bronfilter', async () => {
  const orders = [
    wcOrder(1, [{ product_id: 4321, name: 'Onbekend ding' }], { number: '1001', total: '123.45', billing: { first_name: 'Petra', last_name: 'Jansen', email: 'petra@voorbeeld.test' }, payment_method_title: 'iDEAL' }),
    wcOrder(2, [{ product_id: 3000, name: 'Cadeaubon' }], { status: 'cancelled', total: '10.00', billing: { company: 'Tuin BV', email: 'jan@voorbeeld.test' } }),
    wcOrder(3, [], { status: 'checkout-draft', total: '5' }),
  ];
  const scene = world(orders);
  await scene.history.importOrders(scene.tenantId);
  const heads = scene.db.prepare('SELECT number, status, customer_name, total FROM wp_orders WHERE tenant_id = ? ORDER BY number').all(scene.tenantId);
  assert.deepStrictEqual(heads.map((row) => [row.number, row.status, row.customer_name, Number(row.total)]), [['1001', 'completed', 'Petra Jansen', 123.45], ['2', 'cancelled', 'Tuin BV', 10]]);
  // Opnieuw ophalen werkt de status bij en maakt geen dubbele rij.
  orders[0].status = 'refunded';
  orders[0].date_modified_gmt = '2026-10-27T08:00:00';
  scene.db.prepare('UPDATE wp_order_import SET orders_after = NULL WHERE tenant_id = ?').run(scene.tenantId);
  await scene.history.importOrders(scene.tenantId);
  assert.strictEqual(Number(scene.db.prepare('SELECT COUNT(*) AS n FROM wp_orders WHERE tenant_id = ?').get(scene.tenantId).n), 2);
  assert.strictEqual(scene.db.prepare("SELECT status FROM wp_orders WHERE tenant_id = ? AND wp_order_id = '1'").get(scene.tenantId).status, 'refunded');
  // De lijst bij Webshopbestellingen: bronfilter, statusfilter, zoeken en detail; er verandert niets aan voorraad, facturen of mail.
  const { createWebOrderStore } = require('../src/webshop/web-orders');
  const webOrders = createWebOrderStore(scene.db, { stock: scene.stock });
  assert.strictEqual(webOrders.list(scene.tenantId, {}).total, 0, 'standaard alleen de eigen webshop');
  const all = webOrders.list(scene.tenantId, { source: 'alle' });
  assert.strictEqual(all.total, 2);
  assert.ok(all.items.every((order) => order.source === 'wordpress' && order.number.startsWith('WP-')));
  assert.strictEqual(all.wordpress, 2);
  assert.strictEqual(webOrders.list(scene.tenantId, { source: 'systeem' }).wordpress, 2);
  assert.strictEqual(webOrders.list(scene.tenantId, { source: 'alle', status: 'wp-cancelled' }).items[0].customerName, 'Tuin BV');
  assert.strictEqual(webOrders.list(scene.tenantId, { source: 'alle', status: 'nieuw' }).total, 0, 'een eigen status sluit WordPress uit');
  assert.strictEqual(webOrders.list(scene.tenantId, { source: 'alle', query: 'petra' }).total, 1);
  assert.strictEqual(webOrders.list(scene.tenantId, { source: 'alle', archive: 'alleen' }).total, 0, 'WordPress heeft geen archief');
  assert.strictEqual(webOrders.list(scene.tenantId, { source: 'wordpress', limit: 1 }).items.length, 1);
  const detail = webOrders.getWordPress(scene.tenantId, all.items.find((order) => order.statusLabel === 'Terugbetaald').id);
  assert.strictEqual(detail.lines[0].name, 'Onbekend ding');
  assert.strictEqual(webOrders.getWordPress(scene.tenantId, '00000000-0000-4000-8000-000000000000'), null);
  assert.strictEqual(webOrders.getWordPress('00000000-0000-4000-8000-000000000001', all.items[0].id), null, 'andere organisatie');
  for (const table of ['web_orders', 'invoices', 'stock_movements']) assert.strictEqual(Number(scene.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(scene.tenantId).n), 0, table);
});

test('lijst bij Webshopbestellingen via de API: bronfilter, rechten en andere organisatie', async () => {
  const { setup: webshopSetup } = require('./helpers/webshop-world');
  const world = await webshopSetup();
  const { admin, vreemd } = world;
  const shopper = world.shoppers[0].client;
  const tenantId = world.db.prepare("SELECT id FROM tenants WHERE slug = 'default' OR parent_id IS NULL ORDER BY created_at LIMIT 1").get().id;
  const wpId = require('crypto').randomUUID();
  world.db.prepare(`INSERT INTO wp_orders (id, tenant_id, wp_order_id, number, status, ordered_at, customer_name, email, total) VALUES (?, ?, '5', '1005', 'completed', now(), 'Oude Klant', 'oud@voorbeeld.test', 42)`).run(wpId, tenantId);
  const listed = await admin.get('/app/api/admin/web-orders?bron=alle');
  assert.strictEqual(listed.status, 200);
  assert.strictEqual(listed.body.items.find((order) => order.source === 'wordpress').number, 'WP-1005');
  assert.strictEqual(listed.body.wordpress, 1);
  assert.strictEqual((await admin.get('/app/api/admin/web-orders?bron=systeem')).body.items.some((order) => order.source === 'wordpress'), false);
  assert.strictEqual((await admin.get('/app/api/admin/web-orders')).body.items.some((order) => order.source === 'wordpress'), false, 'zonder bron alleen de eigen webshop');
  assert.strictEqual((await admin.get(`/app/api/admin/web-orders/wordpress/${wpId}`)).body.order.customerName, 'Oude Klant');
  assert.strictEqual((await vreemd.get(`/app/api/admin/web-orders/wordpress/${wpId}`)).status, 404);
  assert.strictEqual((await vreemd.get('/app/api/admin/web-orders?bron=alle')).body.wordpress, 0);
  assert.strictEqual((await shopper.get(`/app/api/admin/web-orders/wordpress/${wpId}`)).status, 403);
  assert.strictEqual((await shopper.get('/app/api/admin/web-orders?bron=alle')).status, 403);
});
