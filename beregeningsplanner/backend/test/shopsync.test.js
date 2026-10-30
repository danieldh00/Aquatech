// Tweerichtingssynchronisatie voorraad <-> WooCommerce tegen een nagebootste
// webshop: koppelen op code/sku, prijs en voorraad terugschrijven, verkopen
// in de webshop afboeken, prijswijziging in de webshop overnemen.
process.env.SHOP_ALLOW_INSECURE = '1';
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createStockStore } = require('../src/artikelen/stock');
const { createShopStore } = require('../src/webshop/shop');
const { createShopSync } = require('../src/webshop/shop-sync');
const { sanitizeShop } = require('../src/webshop/woocommerce');

/**
 * Nagebootste WooCommerce REST API v3: producten in een map, prijzen incl. btw.
 * @param {Map<string, object>} products Producten op id.
 * @returns {{ fetchImpl: Function, calls: object[], products: Map }} Nagebootste fetch, gedane verzoeken en de producten.
 */
function fakeShop(products) {
  const calls = [];
  /**
   * Beantwoordt één verzoek: batch-wijziging of productenlijst (met include).
   * @param {string} url Adres van het verzoek.
   * @param {object} [options] Fetch-opties (method, headers, body).
   * @returns {Promise<object>} Antwoord zoals fetch het geeft.
   */
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = new URL(url);
    calls.push({ method: options.method || 'GET', path: requestUrl.pathname, body: options.body ? JSON.parse(options.body) : null });
    /**
     * Een geslaagd JSON-antwoord.
     * @param {*} body De inhoud.
     * @returns {object} Antwoord zoals fetch het geeft.
     */
    const json = (body) => ({ ok: true, status: 200, headers: new Headers({ 'x-wp-totalpages': '1' }), text: async () => JSON.stringify(body) });
    if (!options.headers || !String(options.headers.Authorization || '').startsWith('Basic ')) return { ok: false, status: 401, headers: new Headers(), text: async () => '{}' };
    if (requestUrl.pathname.endsWith('/products/batch')) {
      const body = JSON.parse(options.body);
      return json({ update: body.update.map((update) => {
        const current = products.get(String(update.id));
        if (!current) return { id: update.id, error: { message: 'Onbekend product' } };
        if (update.regular_price !== undefined) current.regular_price = update.regular_price;
        if (update.stock_quantity !== undefined) { current.stock_quantity = update.stock_quantity; current.manage_stock = true; }
        return current;
      }) });
    }
    const include = requestUrl.searchParams.get('include');
    const list = [...products.values()].filter((product) => !include || include.split(',').includes(String(product.id)));
    return json(list.map((product) => ({ ...product, price: product.regular_price })));
  };
  return { fetchImpl, calls, products };
}

/**
 * Database met voorraad, webshopkoppeling en synchronisatie tegen de nagebootste webshop.
 * @param {Map<string, object>} products Producten in de webshop.
 * @param {object} source Instelling shopSource.
 * @returns {object} db, tid, stock, sync, fake (webshop) en settings.
 */
function setup(products, source) {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  const settings = new Map(Object.entries({ shopSource: sanitizeShop(source), shopConsumerKey: 'ck_test_1234567890', shopConsumerSecret: 'cs_test_1234567890' }));
  const stock = createStockStore(db);
  const shop = createShopStore(db);
  const fake = fakeShop(products);
  const sync = createShopSync({ db, shop, stock, settingsFor: () => ({ get: (key) => settings.get(key) }), fetchImpl: fake.fetchImpl, log: { warn() {} } });
  return { db, tid, stock, sync, fake, settings };
}

/**
 * Een WooCommerce-product als [id, product] voor een Map.
 * @param {number} id Product-id.
 * @param {string} sku Sku (= artikelcode).
 * @param {string} regular Prijs incl. btw.
 * @param {number|null} stockQty Voorraad in de webshop (null = niet bijgehouden).
 * @returns {Array} [id als tekst, product].
 */
const product = (id, sku, regular, stockQty) => [String(id), { id, sku, name: sku, regular_price: String(regular), manage_stock: stockQty != null, stock_quantity: stockQty, status: 'publish', meta_data: [] }];

test('webshop: Aquatech is de bron voor prijs en voorraad, verkopen in de webshop komen terug', async () => {
  const products = new Map([product(11, 'PE-25', '2.42', 7), product(12, 'VAL-24V', '48.40', null), product(13, 'ANDER', '1.00', 3)]);
  const { tid, stock, sync, fake } = setup(products, { url: 'http://shop.test', mode: 'rest', push: true, pricesIncludeTax: true, vatRate: 21 });
  const user = { id: null, display_name: 'Test' };
  // PE-25 is nieuw (stand 0): neemt de webshopvoorraad en -prijs over.
  const pe = stock.create(tid, user, { code: 'PE-25', name: 'PE-buis', unit: 'm' }).item;
  // VAL-24V heeft een eigen prijs en stand: die gaan naar de webshop.
  const val = stock.create(tid, user, { code: 'VAL-24V', name: 'Ventiel', salePrice: 45, vatRate: 21, onHand: 6 }).item;
  // Niet meesturen.
  stock.create(tid, user, { code: 'ANDER', name: 'Ander', salePrice: 9, shopSync: false });

  const s1 = await sync.run(tid);
  assert.strictEqual(s1.linked, 2);
  let item = stock.get(tid, pe.id);
  assert.strictEqual(item.onHand, 7);
  assert.strictEqual(item.salePrice, 2);
  assert.strictEqual(item.shop.productId, '11');
  assert.strictEqual(stock.get(tid, val.id).shop.pending, false);
  assert.strictEqual(products.get('12').regular_price, '54.45');
  assert.strictEqual(products.get('12').stock_quantity, 6);
  assert.strictEqual(products.get('13').regular_price, '1.00');

  // Verkocht in de webshop: 2 PE-25. Prijs in Aquatech gewijzigd voor het ventiel.
  products.get('11').stock_quantity = 5;
  stock.update(tid, val.id, { salePrice: 50 });
  assert.strictEqual(stock.get(tid, val.id).shop.pending, true);
  const s2 = await sync.run(tid);
  assert.strictEqual(s2.soldInShop, 2);
  item = stock.get(tid, pe.id);
  assert.strictEqual(item.onHand, 5);
  assert.ok(item.movements.some((movement) => movement.source === 'webshop' && movement.qty === -2));
  assert.strictEqual(products.get('12').regular_price, '60.50');

  // Snelle ronde: alleen gewijzigde artikelen, eerst hun stand opvragen.
  products.get('11').stock_quantity = 4; // nog een verkoop
  stock.move(tid, user, pe.id, { kind: 'ontvangst', qty: 20 });
  fake.calls.length = 0;
  await sync.run(tid, { full: false });
  assert.ok(fake.calls[0].path.endsWith('/products'));
  assert.strictEqual(stock.get(tid, pe.id).onHand, 24);
  assert.strictEqual(products.get('11').stock_quantity, 24);

  // Prijs in de webshop aangepast, in Aquatech niet: Aquatech neemt hem over.
  products.get('12').regular_price = '72.60';
  await sync.run(tid);
  assert.strictEqual(stock.get(tid, val.id).salePrice, 60);

  // Gereserveerd voor een werkorder telt niet als beschikbaar in de webshop.
  assert.strictEqual(products.get('12').stock_quantity, 6);
});

test('webshop: zonder terugschrijven blijft de webshop leidend; fouten blijven zichtbaar', async () => {
  const products = new Map([product(21, 'PE-25', '2.42', 7)]);
  const { tid, stock, sync, settings } = setup(products, { url: 'http://shop.test', mode: 'rest', push: false, pricesIncludeTax: true, vatRate: 21 });
  const it = stock.create(tid, null, { code: 'PE-25', name: 'PE-buis', salePrice: 9, onHand: 1 }).item;
  await sync.run(tid);
  assert.strictEqual(stock.get(tid, it.id).salePrice, 2);
  assert.strictEqual(products.get('21').stock_quantity, 7);
  assert.deepStrictEqual(await sync.run(tid, { full: false }), { skipped: 'no_push' });

  // Terugschrijven aan met verkeerde sleutels: artikel blijft 'nog te versturen' met de fout.
  settings.set('shopSource', sanitizeShop({ url: 'http://shop.test', mode: 'rest', push: true }));
  stock.update(tid, it.id, { salePrice: 3 });
  settings.set('shopConsumerKey', '');
  await assert.rejects(sync.run(tid), /consumer key/);
  settings.set('shopConsumerKey', 'ck_test_1234567890');
  await sync.run(tid);
  assert.strictEqual(products.get('21').regular_price, '3.63');
  assert.strictEqual(stock.get(tid, it.id).shop.error, '');
});

test('webshop: alles uit de webshop wordt voorraad, rest gearchiveerd en weer teruggezet', async () => {
  const products = new Map([product(21, 'PE-25', '2.42', 4), product(22, '', '10.00', null)]);
  const { tid, stock, sync } = setup(products, { url: 'http://shop.test', mode: 'rest', push: false, pricesIncludeTax: true, vatRate: 21 });
  const user = { id: null, display_name: 'Test' };
  const oud = stock.create(tid, user, { code: 'OUD-1', name: 'Oud artikel' }).item;

  const first = await sync.run(tid);
  assert.strictEqual(first.created, 2);
  assert.strictEqual(first.archived, 1);
  assert.strictEqual(stock.get(tid, oud.id).archived, true);
  const codes = stock.list(tid).map((item) => item.code).sort();
  assert.deepStrictEqual(codes, ['PE-25', 'WC-22']);

  // Tweede ronde: niets nieuw, product zonder sku blijft op dezelfde regel.
  const second = await sync.run(tid);
  assert.strictEqual(second.created, 0);
  assert.strictEqual(second.archived, 0);

  // Product verdwijnt uit de webshop: gearchiveerd; komt terug: hersteld.
  const gone = products.get('21');
  products.delete('21');
  assert.strictEqual((await sync.run(tid)).archived, 1);
  products.set('21', gone);
  assert.strictEqual((await sync.run(tid)).restored, 1);
  assert.deepStrictEqual(stock.list(tid).map((item) => item.code).sort(), ['PE-25', 'WC-22']);
});

test('webshop: nieuwe artikelen krijgen normale prijs en btw van de koppeling; product zonder voorraadbeheer blijft zo', async () => {
  const products = new Map([product(31, 'ACT-1', '12.10', null)]);
  products.get('31').sale_price = '9.99';
  const { tid, stock, sync, fake } = setup(products, { url: 'http://shop.test', mode: 'rest', push: true, pricesIncludeTax: true, vatRate: 9 });
  const first = await sync.run(tid);
  assert.strictEqual(first.created, 1);
  assert.strictEqual(first.skippedProducts, 0);
  const item = stock.list(tid).find((entry) => entry.code === 'ACT-1');
  assert.strictEqual(item.vatRate, 9);
  assert.strictEqual(item.salePrice, 11.1);
  assert.strictEqual(products.get('31').manage_stock, false, 'voorraadbeheer in de webshop blijft uit');
  assert.ok(!fake.calls.some((call) => call.method === 'POST'), 'niets teruggeschreven');
});
