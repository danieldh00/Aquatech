// Artikelen met varianten: hoofdartikel met kenmerken, varianten met eigen
// code/prijs/voorraad, reserveren op werkorders (eerst een maat kiezen), de
// keuzelijst voor werkorder en offerte, en WooCommerce-variaties in beide
// richtingen tegen een nagebootste webshop.
process.env.SHOP_ALLOW_INSECURE = '1';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createStockStore, sanitizeAttributes, combinations } = require('../src/voorraad/stock');
const { createShopStore } = require('../src/webshop/shop');
const { createShopSync } = require('../src/webshop/shop-sync');
const { sanitizeShop } = require('../src/webshop/woocommerce');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const USER = { id: null, display_name: 'Test' };

test('varianten: kenmerken opschonen en combinaties', () => {
  assert.deepStrictEqual(sanitizeAttributes([{ name: ' Maat ', values: '16 mm, 20 mm, 16 MM,' }]).value, [{ name: 'Maat', values: ['16 mm', '20 mm'] }]);
  assert.strictEqual(sanitizeAttributes([{ name: '', values: ['a'] }]).field, 'attributes');
  assert.strictEqual(sanitizeAttributes([{ name: 'Maat', values: [] }]).field, 'attributes');
  assert.strictEqual(sanitizeAttributes([{ name: 'Maat', values: ['a'] }, { name: 'maat', values: ['b'] }]).field, 'attributes');
  assert.strictEqual(sanitizeAttributes('Maat').field, 'attributes');
  assert.ok(sanitizeAttributes([1, 2, 3, 4].map((index) => ({ name: `K${index}`, values: ['a'] }))).error);
  assert.deepStrictEqual(sanitizeAttributes([]).value, []);
  assert.deepStrictEqual(combinations([{ name: 'Maat', values: ['16', '20'] }, { name: 'Kleur', values: ['zwart'] }]), [{ Maat: '16', Kleur: 'zwart' }, { Maat: '20', Kleur: 'zwart' }]);
});

test('varianten: hoofdartikel, totalen, mutaties alleen op een variant, bestelvoorstel', () => {
  const db = openDb();
  const tenantId = createStore(db).ensureTenant().id;
  const stock = createStockStore(db);
  const parent = stock.create(tenantId, USER, { code: 'PE-BUIS', name: 'PE-buis', unit: 'm', costPrice: 0.5, salePrice: 1.2, vatRate: 9 }).item;
  const made = stock.setVariants(tenantId, parent.id, [{ name: 'Maat', values: ['16 mm', '20 mm'] }]);
  assert.strictEqual(made.created, 2);
  assert.deepStrictEqual(made.item.variants.map((variant) => [variant.code, variant.name, variant.unit, variant.salePrice, variant.vatRate, variant.values]), [
    ['PE-BUIS-16MM', 'PE-buis 16 mm', 'm', 1.2, 9, { Maat: '16 mm' }],
    ['PE-BUIS-20MM', 'PE-buis 20 mm', 'm', 1.2, 9, { Maat: '20 mm' }],
  ]);
  const [small, large] = made.item.variants;

  // Eigen prijs, voorraad en minimum per variant; het hoofdartikel telt op.
  stock.update(tenantId, small.id, { salePrice: 0.95, minQty: 50 });
  stock.move(tenantId, USER, small.id, { kind: 'ontvangst', qty: 20 });
  stock.move(tenantId, USER, large.id, { kind: 'ontvangst', qty: 100 });
  const listed = stock.list(tenantId);
  const listedParent = listed.find((item) => item.id === parent.id);
  assert.strictEqual(listedParent.hasVariants, true);
  assert.strictEqual(listedParent.variantCount, 2);
  assert.strictEqual(listedParent.onHand, 120);
  assert.strictEqual(listedParent.low, true);
  assert.strictEqual(listed.find((item) => item.id === small.id).parentId, parent.id);
  assert.strictEqual(stock.get(tenantId, small.id).parent.code, 'PE-BUIS');
  assert.strictEqual(stock.get(tenantId, small.id).salePrice, 0.95);
  assert.strictEqual(stock.move(tenantId, USER, parent.id, { kind: 'ontvangst', qty: 1 }).status, 409);
  assert.deepStrictEqual(stock.reorderProposal(tenantId).items.map((item) => [item.code, item.orderQty]), [['PE-BUIS-16MM', 80]]);

  // Waarde erbij: alleen de nieuwe variant; kenmerk hernoemen mag niet meer.
  const more = stock.setVariants(tenantId, parent.id, [{ name: 'Maat', values: ['16 mm', '20 mm', '25 mm'] }]);
  assert.strictEqual(more.created, 1);
  assert.strictEqual(more.item.variants.length, 3);
  assert.strictEqual(stock.setVariants(tenantId, parent.id, [{ name: 'Diameter', values: ['16 mm'] }]).status, 409);
  assert.strictEqual(stock.setVariants(tenantId, parent.id, []).status, 409);

  // Waarde weghalen: die variant gaat weg (zonder boekingen echt verwijderd).
  const fewer = stock.setVariants(tenantId, parent.id, [{ name: 'Maat', values: ['16 mm', '20 mm'] }]);
  assert.strictEqual(fewer.removed, 1);
  assert.deepStrictEqual(fewer.item.variants.map((variant) => variant.code), ['PE-BUIS-16MM', 'PE-BUIS-20MM']);

  // Eenheid en btw volgen het hoofdartikel; archiveren neemt de varianten mee.
  stock.update(tenantId, parent.id, { unit: 'rol', vatRate: 21 });
  assert.ok(stock.get(tenantId, parent.id).variants.every((variant) => variant.unit === 'rol' && variant.vatRate === 21));
  // Terugzetten brengt alleen de varianten terug die met het hoofdartikel mee gingen, niet een los verwijderde.
  assert.deepStrictEqual(stock.remove(tenantId, large.id), { archived: true, code: 'PE-BUIS-20MM' });
  stock.update(tenantId, parent.id, { archived: true });
  assert.ok(stock.get(tenantId, parent.id).variants.every((variant) => variant.archived));
  assert.strictEqual(stock.update(tenantId, small.id, { archived: false }).status, 409);
  stock.update(tenantId, parent.id, { archived: false });
  assert.deepStrictEqual(stock.get(tenantId, parent.id).variants.map((variant) => [variant.code, variant.archived]), [['PE-BUIS-16MM', false], ['PE-BUIS-20MM', true]]);

  // Een artikel met voorraad kan geen hoofdartikel worden; een variant ook niet.
  const used = stock.create(tenantId, USER, { code: 'SLANG', name: 'Slang', onHand: 3 }).item;
  assert.strictEqual(stock.setVariants(tenantId, used.id, [{ name: 'Lengte', values: ['15 m'] }]).status, 409);
  assert.strictEqual(stock.setVariants(tenantId, small.id, [{ name: 'Kleur', values: ['zwart'] }]).status, 409);

  // Verwijderen: varianten met mutaties worden gearchiveerd, het hoofdartikel blijft (gearchiveerd).
  assert.deepStrictEqual(stock.remove(tenantId, parent.id), { archived: true, code: 'PE-BUIS' });
  assert.strictEqual(stock.get(tenantId, more.item.variants[2].id), null);
  const fresh = stock.create(tenantId, USER, { code: 'DRUPPELAAR', name: 'Druppelaar' }).item;
  stock.setVariants(tenantId, fresh.id, [{ name: 'Afgifte', values: ['2 l/u', '4 l/u'] }]);
  assert.deepStrictEqual(stock.remove(tenantId, fresh.id), { deleted: true, code: 'DRUPPELAAR' });
  assert.strictEqual(stock.list(tenantId, { archived: true }).filter((item) => item.code.startsWith('DRUPPELAAR')).length, 0);
});

/**
 * Hoofdtenant met beheerder, installateur en klant, plus een testserver.
 * @returns {Promise<object>} server en as (inloggen).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'pien', displayName: 'Pien', role: 'planner', password: PW });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  return { server, as: createLogin(base, { password: PW }) };
}

test('varianten via de API: kenmerken, keuzelijst, werkorder kiest eerst een maat, rechten en andere organisatie', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const pien = await as('pien');
    const klant = await as('klant');
    const parent = (await kees.post('/api/stock/items', { code: 'SLANG', name: 'Tuinslang', salePrice: 20, costPrice: 12 })).body;
    const made = await kees.put(`/api/stock/items/${parent.id}/variants`, { attributes: [{ name: 'Lengte', values: ['15 m', '25 m'] }] });
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(made.body.created, 2);
    assert.strictEqual((await kees.put(`/api/stock/items/${parent.id}/variants`, { attributes: [{ name: '', values: ['x'] }] })).status, 400);
    assert.strictEqual((await kees.post(`/api/stock/items/${parent.id}/movements`, { kind: 'ontvangst', qty: 1 })).status, 409);

    // Keuzelijst: hoofdartikel met varianten, zonder inkoopprijs; ook voor de planner (werkorders).
    const picker = (await pien.get('/api/stock/articles')).body.items;
    const hose = picker.find((article) => article.code === 'SLANG');
    assert.deepStrictEqual(hose.variants.map((variant) => [variant.code, variant.values.Lengte]), [['SLANG-15M', '15 m'], ['SLANG-25M', '25 m']]);
    assert.ok(!JSON.stringify(picker).includes('costPrice'));
    assert.strictEqual((await klant.get('/api/stock/articles')).status, 403);
    assert.strictEqual((await pien.put(`/api/stock/items/${parent.id}/variants`, { attributes: [] })).status, 403);
    assert.strictEqual((await pien.post(`/api/stock/items/${parent.id}/publish`, {})).status, 403);
    const unlinked = await kees.post(`/api/stock/items/${parent.id}/publish`, {});
    assert.strictEqual(unlinked.status, 409);
    assert.strictEqual(unlinked.body.error, 'not_configured');

    // Werkorder met de code van het hoofdartikel: eerst een maat kiezen; met de variant wordt er gereserveerd.
    const quote = (await kees.post('/api/quotes', { data: { title: 'Slang', customer: { name: 'Fam. Jansen' },
      lines: [{ section: 'materiaal', code: 'SLANG', description: 'Tuinslang', qty: 2, unit: 'st', price: 20 }] } })).body;
    await kees.put(`/api/quotes/${quote.id}`, { status: 'akkoord' });
    const workOrder = (await kees.post('/api/workorders', { quoteId: quote.id })).body;
    let stockOfOrder = (await kees.get(`/api/stock/workorders/${workOrder.id}`)).body;
    assert.deepStrictEqual(stockOfOrder.chooseVariant.map((line) => [line.code, line.qty]), [['SLANG', 2]]);
    assert.deepStrictEqual(stockOfOrder.notInStock, []);
    assert.strictEqual(stockOfOrder.lines.length, 0);
    const full = (await kees.get(`/api/workorders/${workOrder.id}`)).body;
    full.data.materials[0].code = 'SLANG-25M';
    assert.strictEqual((await kees.put(`/api/workorders/${workOrder.id}`, { data: full.data })).status, 200);
    stockOfOrder = (await kees.get(`/api/stock/workorders/${workOrder.id}`)).body;
    assert.deepStrictEqual(stockOfOrder.chooseVariant, []);
    assert.deepStrictEqual(stockOfOrder.lines.map((line) => [line.code, line.reserved]), [['SLANG-25M', 2]]);

    // Andere organisatie: 404 op het hoofdartikel, eigen lege keuzelijst.
    const created = await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const piet = await as('piet', 'groen');
    assert.strictEqual((await piet.put(`/api/stock/items/${parent.id}/variants`, { attributes: [{ name: 'Lengte', values: ['50 m'] }] })).status, 404);
    assert.strictEqual((await piet.post(`/api/stock/items/${parent.id}/publish`, {})).status, 404);
    assert.deepStrictEqual((await piet.get('/api/stock/articles')).body.items, []);
  } finally {
    server.close();
  }
});

/**
 * Nagebootste WooCommerce REST API v3 met variabele producten en variaties
 * (prijzen incl. btw).
 * @param {Map<string, object>} products Producten op id (variabel: type 'variable').
 * @param {Map<string, object[]>} variations Variaties per product-id.
 * @returns {{ fetchImpl: Function, calls: object[] }} Nagebootste fetch en de gedane verzoeken.
 */
function fakeShop(products, variations) {
  const calls = [];
  let nextId = 900;
  /**
   * Beantwoordt één verzoek van de koppeling.
   * @param {string} url Adres van het verzoek.
   * @param {object} [options] Fetch-opties (method, body).
   * @returns {Promise<object>} Antwoord zoals fetch het geeft.
   */
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = new URL(url);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, path: requestUrl.pathname, body });
    /**
     * Een geslaagd JSON-antwoord.
     * @param {*} content De inhoud.
     * @returns {object} Antwoord zoals fetch het geeft.
     */
    const json = (content) => ({ ok: true, status: 200, headers: new Headers({ 'x-wp-totalpages': '1' }), text: async () => JSON.stringify(content) });
    const path = requestUrl.pathname.replace('/wp-json/wc/v3', '');
    const include = requestUrl.searchParams.get('include');
    let match = path.match(/^\/products\/(\d+)\/variations\/batch$/);
    if (match) {
      const list = variations.get(match[1]) || [];
      variations.set(match[1], list);
      return json({
        create: (body.create || []).map((create) => {
          if (list.some((variation) => variation.sku === create.sku)) return { id: 0, error: { message: 'Dubbele sku' } };
          const variation = { id: nextId++, sku: create.sku, regular_price: create.regular_price || '', manage_stock: Boolean(create.manage_stock), stock_quantity: create.stock_quantity ?? null, attributes: create.attributes, meta_data: create.meta_data };
          list.push(variation);
          return variation;
        }),
        update: (body.update || []).map((update) => {
          const variation = list.find((entry) => String(entry.id) === String(update.id));
          if (!variation) return { id: update.id, error: { message: 'Onbekend' } };
          if (update.regular_price !== undefined) variation.regular_price = update.regular_price;
          if (update.stock_quantity !== undefined) { variation.stock_quantity = update.stock_quantity; variation.manage_stock = true; }
          return variation;
        }),
      });
    }
    match = path.match(/^\/products\/(\d+)\/variations$/);
    if (match) return json((variations.get(match[1]) || []).filter((variation) => !include || include.split(',').includes(String(variation.id))).map((variation) => ({ ...variation, price: variation.regular_price })));
    match = path.match(/^\/products\/(\d+)$/);
    if (match) {
      const product = products.get(match[1]);
      if (!product) return { ok: false, status: 404, headers: new Headers(), text: async () => '{}' };
      if (method === 'PUT') product.attributes = body.attributes.map((attribute, index) => ({ id: attribute.id || 50 + index, ...attribute }));
      return json(product);
    }
    if (path === '/products' && method === 'POST') {
      const product = { id: nextId++, status: 'publish', regular_price: '', meta_data: [], ...body, attributes: (body.attributes || []).map((attribute, index) => ({ id: 60 + index, ...attribute })) };
      products.set(String(product.id), product);
      return json(product);
    }
    if (path === '/products/batch') {
      return json({ update: body.update.map((update) => {
        const product = products.get(String(update.id));
        if (update.regular_price !== undefined) product.regular_price = update.regular_price;
        if (update.stock_quantity !== undefined) { product.stock_quantity = update.stock_quantity; product.manage_stock = true; }
        return product;
      }) });
    }
    return json([...products.values()].filter((product) => !include || include.split(',').includes(String(product.id))).map((product) => ({ ...product, price: product.regular_price })));
  };
  return { fetchImpl, calls };
}

/**
 * Database met voorraad en synchronisatie tegen de nagebootste webshop.
 * @param {Map<string, object>} products Producten in de webshop.
 * @param {Map<string, object[]>} variations Variaties per product-id.
 * @param {object} source Instelling shopSource.
 * @returns {object} tenantId, stock, sync, shop en calls.
 */
function setupShop(products, variations, source) {
  const db = openDb();
  const tenantId = createStore(db).ensureTenant().id;
  const settings = new Map(Object.entries({ shopSource: sanitizeShop(source), shopConsumerKey: 'ck_test_1234567890', shopConsumerSecret: 'cs_test_1234567890' }));
  const stock = createStockStore(db);
  const shop = createShopStore(db);
  const fake = fakeShop(products, variations);
  const sync = createShopSync({ db, shop, stock, settingsFor: () => ({ get: (key) => settings.get(key) }), fetchImpl: fake.fetchImpl, log: { warn() {} } });
  return { tenantId, stock, sync, shop, calls: fake.calls };
}

/**
 * Een variatie zoals WooCommerce hem stuurt.
 * @param {number} id Id van de variatie.
 * @param {string} sku Sku.
 * @param {string} size Waarde van het kenmerk Maat.
 * @param {string} price Prijs incl. btw.
 * @param {number} stockQty Voorraad in de webshop.
 * @returns {object} De variatie.
 */
const variation = (id, sku, size, price, stockQty) => ({ id, sku, regular_price: price, manage_stock: true, stock_quantity: stockQty, attributes: [{ id: 1, name: 'Maat', option: size }], meta_data: [] });

test('varianten en WooCommerce: variabel product wordt hoofdartikel, prijs en voorraad per variatie, nieuwe variant naar de webshop', async () => {
  const products = new Map([['70', { id: 70, type: 'variable', sku: 'KOPPELING', name: 'Koppeling', status: 'publish', regular_price: '', meta_data: [],
    attributes: [{ id: 1, name: 'Maat', options: ['20 mm', '25 mm'], variation: true, visible: true, position: 0 }, { id: 2, name: 'Merk', options: ['Aquatech'], variation: false, visible: true, position: 1 }] }]]);
  const variations = new Map([['70', [variation(71, 'KOP-20', '20 mm', '2.42', 10), variation(72, 'KOP-25', '25 mm', '3.63', 4)]]]);
  const { tenantId, stock, sync, shop, calls } = setupShop(products, variations, { url: 'http://shop.test', mode: 'rest', push: true, pricesIncludeTax: true, vatRate: 21 });

  // Webshop → Aquatech: hoofdartikel met het kenmerk Maat, varianten met prijs en stand.
  const first = await sync.run(tenantId);
  assert.strictEqual(first.created, 3);
  const parent = stock.list(tenantId).find((item) => item.code === 'KOPPELING');
  assert.deepStrictEqual(parent.attributes, [{ name: 'Maat', values: ['20 mm', '25 mm'] }]);
  let full = stock.get(tenantId, parent.id);
  assert.deepStrictEqual(full.variants.map((item) => [item.code, item.values.Maat, item.salePrice, item.onHand, item.shop.productId]), [
    ['KOP-20', '20 mm', 2, 10, '71'], ['KOP-25', '25 mm', 3, 4, '72'],
  ]);
  assert.strictEqual(shop.products(tenantId).find((product) => product.id === '71').parentId, '70');

  // Aquatech → webshop: prijs van één variant via de variatie-batch.
  stock.update(tenantId, full.variants[0].id, { salePrice: 2.5 });
  calls.length = 0;
  await sync.run(tenantId, { full: false });
  assert.ok(calls.some((call) => call.path.endsWith('/products/70/variations') && call.method === 'GET'));
  assert.ok(calls.some((call) => call.path.endsWith('/products/70/variations/batch')));
  assert.strictEqual(variations.get('70')[0].regular_price, '3.03');

  // Verkocht in de webshop: afgeboekt op de variant.
  variations.get('70')[1].stock_quantity = 3;
  const second = await sync.run(tenantId);
  assert.strictEqual(second.soldInShop, 1);
  assert.strictEqual(stock.get(tenantId, full.variants[1].id).onHand, 3);

  // Nieuwe maat in Aquatech: de variatie en de waarde komen in de webshop (andere kenmerken blijven).
  stock.setVariants(tenantId, parent.id, [{ name: 'Maat', values: ['20 mm', '25 mm', '32 mm'] }]);
  full = stock.get(tenantId, parent.id);
  const added = full.variants.find((item) => item.values.Maat === '32 mm');
  stock.update(tenantId, added.id, { salePrice: 5 });
  stock.move(tenantId, USER, added.id, { kind: 'ontvangst', qty: 7 });
  const third = await sync.run(tenantId);
  assert.strictEqual(third.createdVariations, 1);
  const created = variations.get('70').find((entry) => entry.sku === 'KOPPELING-32MM');
  assert.ok(created, 'variatie aangemaakt');
  assert.strictEqual(created.regular_price, '6.05');
  assert.strictEqual(created.stock_quantity, 7);
  assert.deepStrictEqual(products.get('70').attributes.map((attribute) => [attribute.name, attribute.options]), [['Maat', ['20 mm', '25 mm', '32 mm']], ['Merk', ['Aquatech']]]);
  assert.strictEqual(stock.get(tenantId, added.id).shop.productId, String(created.id));
  assert.strictEqual(stock.list(tenantId, { archived: true }).filter((item) => item.archived).length, 0);

  // Product weg uit de webshop terwijl er een nieuwe maat is: de ronde loopt door, de variant krijgt een melding.
  products.delete('70');
  stock.setVariants(tenantId, parent.id, [{ name: 'Maat', values: ['20 mm', '25 mm', '32 mm', '40 mm'] }]);
  const newest = stock.get(tenantId, parent.id).variants.find((item) => item.values.Maat === '40 mm');
  await sync.run(tenantId);
  assert.match(stock.get(tenantId, newest.id).shop.error, /Variatie niet aangemaakt/);
});

test('varianten en WooCommerce: artikel en hoofdartikel uit Aquatech als nieuw product in de webshop', async () => {
  const products = new Map();
  const variations = new Map();
  const { tenantId, stock, sync } = setupShop(products, variations, { url: 'http://shop.test', mode: 'rest', push: true, mirror: false, pricesIncludeTax: true, vatRate: 21 });
  const simple = stock.create(tenantId, USER, { code: 'VENTIEL', name: 'Ventiel', salePrice: 40, onHand: 5 }).item;
  const parent = stock.create(tenantId, USER, { code: 'SPROEIER', name: 'Sproeier', salePrice: 10 }).item;
  stock.setVariants(tenantId, parent.id, [{ name: 'Worp', values: ['4 m', '8 m'] }]);

  const plain = await sync.publish(tenantId, simple.id);
  assert.ok(plain.productId);
  const createdSimple = products.get(plain.productId);
  assert.strictEqual(createdSimple.type, 'simple');
  assert.strictEqual(createdSimple.regular_price, '48.40');
  assert.strictEqual(createdSimple.stock_quantity, 5);
  assert.strictEqual((await sync.publish(tenantId, simple.id)).status, 409);

  // Een ander hoofdartikel met een ontbrekende variatie telt niet mee bij deze publicatie.
  const other = stock.create(tenantId, USER, { code: 'DOP', name: 'Dop' }).item;
  stock.setVariants(tenantId, other.id, [{ name: 'Maat', values: ['1/2"'] }]);
  const variable = await sync.publish(tenantId, parent.id);
  assert.strictEqual(variable.variations, 2);
  assert.strictEqual(variable.warning, null);
  assert.ok(stock.get(tenantId, other.id).variants.every((item) => !item.shop.productId));
  assert.strictEqual(products.get(variable.productId).type, 'variable');
  assert.deepStrictEqual(variations.get(variable.productId).map((entry) => [entry.sku, entry.attributes[0].option, entry.regular_price]), [['SPROEIER-4M', '4 m', '12.10'], ['SPROEIER-8M', '8 m', '12.10']]);
  const variant = stock.get(tenantId, parent.id).variants[0];
  assert.strictEqual((await sync.publish(tenantId, variant.id)).status, 409);

  // Een volle ronde daarna koppelt alles zonder iets dubbel aan te maken.
  const round = await sync.run(tenantId);
  assert.strictEqual(round.createdVariations, 0);
  assert.strictEqual(variations.get(variable.productId).length, 2);
  assert.ok(stock.get(tenantId, parent.id).variants.every((item) => item.shop.productId && !item.shop.error));
});

test('varianten en WooCommerce: een eerder als gewoon artikel overgenomen variabel product wordt hoofdartikel (zonder voorraad)', async () => {
  const products = new Map([
    ['70', { id: 70, type: 'variable', sku: 'KOPPELING', name: 'Koppeling', status: 'publish', regular_price: '', meta_data: [],
      attributes: [{ id: 1, name: 'Maat', options: ['20 mm'], variation: true, visible: true, position: 0 }] }],
    ['80', { id: 80, type: 'variable', sku: 'KNIE', name: 'Knie', status: 'publish', regular_price: '', meta_data: [],
      attributes: [{ id: 1, name: 'Maat', options: ['20 mm'], variation: true, visible: true, position: 0 }] }],
  ]);
  const variations = new Map([['70', [variation(71, 'KOP-20', '20 mm', '2.42', 10)]], ['80', [variation(81, 'KNIE-20', '20 mm', '1.21', 5)]]]);
  const { tenantId, stock, sync } = setupShop(products, variations, { url: 'http://shop.test', mode: 'rest', push: true, pricesIncludeTax: true, vatRate: 21 });
  const empty = stock.create(tenantId, USER, { code: 'KOPPELING', name: 'Koppeling' }).item;
  const used = stock.create(tenantId, USER, { code: 'KNIE', name: 'Knie', onHand: 3 }).item;

  await sync.run(tenantId);
  const promoted = stock.get(tenantId, empty.id);
  assert.strictEqual(promoted.hasVariants, true);
  assert.deepStrictEqual(promoted.variants.map((item) => [item.code, item.values.Maat]), [['KOP-20', '20 mm']]);
  const kept = stock.get(tenantId, used.id);
  assert.strictEqual(kept.hasVariants, false);
  assert.strictEqual(kept.onHand, 3);
  assert.match(kept.shop.error, /voorraad of boekingen/);
});
