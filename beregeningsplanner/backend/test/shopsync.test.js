// Tweerichtingssynchronisatie voorraad <-> WooCommerce tegen een nagebootste
// webshop: koppelen op code/sku, prijs en voorraad terugschrijven, verkopen
// in de webshop afboeken, prijswijziging in de webshop overnemen.
process.env.SHOP_ALLOW_INSECURE = '1';
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');
const { createStockStore } = require('../src/stock');
const { createShopStore } = require('../src/shop');
const { createShopSync } = require('../src/shopsync');
const { sanitizeShop } = require('../src/woocommerce');

// Nagebootste WooCommerce REST API v3: producten in een map, prijzen incl. btw.
function fakeShop(products) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method || 'GET', path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null });
    const json = (body) => ({ ok: true, status: 200, headers: new Headers({ 'x-wp-totalpages': '1' }), text: async () => JSON.stringify(body) });
    if (!opts.headers || !String(opts.headers.Authorization || '').startsWith('Basic ')) return { ok: false, status: 401, headers: new Headers(), text: async () => '{}' };
    if (u.pathname.endsWith('/products/batch')) {
      const body = JSON.parse(opts.body);
      return json({ update: body.update.map((p) => {
        const cur = products.get(String(p.id));
        if (!cur) return { id: p.id, error: { message: 'Onbekend product' } };
        if (p.regular_price !== undefined) cur.regular_price = p.regular_price;
        if (p.stock_quantity !== undefined) { cur.stock_quantity = p.stock_quantity; cur.manage_stock = true; }
        return cur;
      }) });
    }
    const include = u.searchParams.get('include');
    const list = [...products.values()].filter((p) => !include || include.split(',').includes(String(p.id)));
    return json(list.map((p) => ({ ...p, price: p.regular_price })));
  };
  return { fetchImpl, calls, products };
}

function setup(products, source) {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  const settings = new Map(Object.entries({ shopSource: sanitizeShop(source), shopConsumerKey: 'ck_test_1234567890', shopConsumerSecret: 'cs_test_1234567890' }));
  const stock = createStockStore(db);
  const shop = createShopStore(db);
  const fake = fakeShop(products);
  const sync = createShopSync({ db, shop, stock, settingsFor: () => ({ get: (k) => settings.get(k) }), fetchImpl: fake.fetchImpl, log: { warn() {} } });
  return { db, tid, stock, sync, fake, settings };
}

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
  let p = stock.get(tid, pe.id);
  assert.strictEqual(p.onHand, 7);
  assert.strictEqual(p.salePrice, 2);
  assert.strictEqual(p.shop.productId, '11');
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
  p = stock.get(tid, pe.id);
  assert.strictEqual(p.onHand, 5);
  assert.ok(p.movements.some((m) => m.source === 'webshop' && m.qty === -2));
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
