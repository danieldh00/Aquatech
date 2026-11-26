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
