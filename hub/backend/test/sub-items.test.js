// Artikelen met subartikelen: artikelgroep met kenmerken, subartikelen met eigen
// code/prijs/voorraad, reserveren op werkorders (eerst een maat kiezen), de
// keuzelijst voor werkorder en offerte, en WooCommerce-variaties in beide
// richtingen tegen een nagebootste webshop.
process.env.SHOP_ALLOW_INSECURE = '1';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createStockStore, sanitizeAttributes, combinations } = require('../src/artikelen/stock');
const { createShopStore } = require('../src/webshop/shop');
const { createShopSync } = require('../src/webshop/shop-sync');
const { sanitizeShop, createVariations } = require('../src/webshop/woocommerce');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const USER = { id: null, display_name: 'Test' };

test('subartikelen: kenmerken opschonen en combinaties', () => {
  assert.deepStrictEqual(sanitizeAttributes([{ name: ' Maat ', values: '16 mm, 20 mm, 16 MM,' }]).value, [{ name: 'Maat', values: ['16 mm', '20 mm'] }]);
  assert.strictEqual(sanitizeAttributes([{ name: '', values: ['a'] }]).field, 'attributes');
  assert.strictEqual(sanitizeAttributes([{ name: 'Maat', values: [] }]).field, 'attributes');
  assert.strictEqual(sanitizeAttributes([{ name: 'Maat', values: ['a'] }, { name: 'maat', values: ['b'] }]).field, 'attributes');
  assert.strictEqual(sanitizeAttributes('Maat').field, 'attributes');
  assert.ok(sanitizeAttributes([1, 2, 3, 4].map((index) => ({ name: `K${index}`, values: ['a'] }))).error);
  assert.deepStrictEqual(sanitizeAttributes([]).value, []);
  assert.deepStrictEqual(combinations([{ name: 'Maat', values: ['16', '20'] }, { name: 'Kleur', values: ['zwart'] }]), [{ Maat: '16', Kleur: 'zwart' }, { Maat: '20', Kleur: 'zwart' }]);
});

test('subartikelen: artikelgroep, totalen, mutaties alleen op een subartikel, bestelvoorstel', () => {
  const db = openDb();
  const tenantId = createStore(db).ensureTenant().id;
  const stock = createStockStore(db);
  const articleGroup = stock.create(tenantId, USER, { code: 'PE-BUIS', name: 'PE-buis', unit: 'm', costPrice: 0.5, salePrice: 1.2, vatRate: 9 }).item;
  const made = stock.setSubItems(tenantId, articleGroup.id, [{ name: 'Maat', values: ['16 mm', '20 mm'] }]);
  assert.strictEqual(made.created, 2);
  assert.deepStrictEqual(made.item.subItems.map((subItem) => [subItem.code, subItem.name, subItem.unit, subItem.salePrice, subItem.vatRate, subItem.values]), [
    ['PE-BUIS-16MM', 'PE-buis 16 mm', 'm', 1.2, 9, { Maat: '16 mm' }],
    ['PE-BUIS-20MM', 'PE-buis 20 mm', 'm', 1.2, 9, { Maat: '20 mm' }],
  ]);
  const [small, large] = made.item.subItems;

  // Eigen prijs, voorraad en minimum per subartikel; de artikelgroep telt op.
  stock.update(tenantId, small.id, { salePrice: 0.95, minQty: 50 });
  stock.move(tenantId, USER, small.id, { kind: 'ontvangst', qty: 20 });
  stock.move(tenantId, USER, large.id, { kind: 'ontvangst', qty: 100 });
  const listed = stock.list(tenantId);
  const listedGroup = listed.find((item) => item.id === articleGroup.id);
  assert.strictEqual(listedGroup.isGroup, true);
  assert.strictEqual(listedGroup.subItemCount, 2);
  assert.strictEqual(listedGroup.onHand, 120);
  assert.strictEqual(listedGroup.low, true);
  assert.strictEqual(listed.find((item) => item.id === small.id).groupId, articleGroup.id);
  assert.strictEqual(stock.get(tenantId, small.id).articleGroup.code, 'PE-BUIS');
  assert.strictEqual(stock.get(tenantId, small.id).salePrice, 0.95);
  assert.strictEqual(stock.move(tenantId, USER, articleGroup.id, { kind: 'ontvangst', qty: 1 }).status, 409);
  assert.deepStrictEqual(stock.reorderProposal(tenantId).items.map((item) => [item.code, item.orderQty]), [['PE-BUIS-16MM', 80]]);

  // Waarde erbij: alleen de nieuwe subartikel; kenmerk hernoemen mag niet meer.
  const more = stock.setSubItems(tenantId, articleGroup.id, [{ name: 'Maat', values: ['16 mm', '20 mm', '25 mm'] }]);
  assert.strictEqual(more.created, 1);
  assert.strictEqual(more.item.subItems.length, 3);
  assert.strictEqual(stock.setSubItems(tenantId, articleGroup.id, [{ name: 'Diameter', values: ['16 mm'] }]).status, 409);
  assert.strictEqual(stock.setSubItems(tenantId, articleGroup.id, []).status, 409);

  // Waarde weghalen: dat subartikel gaat weg (zonder boekingen echt verwijderd).
  const fewer = stock.setSubItems(tenantId, articleGroup.id, [{ name: 'Maat', values: ['16 mm', '20 mm'] }]);
  assert.strictEqual(fewer.removed, 1);
  assert.deepStrictEqual(fewer.item.subItems.map((subItem) => subItem.code), ['PE-BUIS-16MM', 'PE-BUIS-20MM']);

  // Eenheid en btw volgen de artikelgroep; archiveren neemt de subartikelen mee.
  stock.update(tenantId, articleGroup.id, { unit: 'rol', vatRate: 21 });
  assert.ok(stock.get(tenantId, articleGroup.id).subItems.every((subItem) => subItem.unit === 'rol' && subItem.vatRate === 21));
  // Terugzetten brengt alleen de subartikelen terug die met de artikelgroep mee gingen, niet een los verwijderde.
  assert.deepStrictEqual(stock.remove(tenantId, large.id), { archived: true, code: 'PE-BUIS-20MM' });
  stock.update(tenantId, articleGroup.id, { archived: true });
  assert.ok(stock.get(tenantId, articleGroup.id).subItems.every((subItem) => subItem.archived));
  assert.strictEqual(stock.update(tenantId, small.id, { archived: false }).status, 409);
  stock.update(tenantId, articleGroup.id, { archived: false });
  assert.deepStrictEqual(stock.get(tenantId, articleGroup.id).subItems.map((subItem) => [subItem.code, subItem.archived]), [['PE-BUIS-16MM', false], ['PE-BUIS-20MM', true]]);

  // Een artikel met voorraad kan geen artikelgroep worden; een subartikel ook niet.
  const used = stock.create(tenantId, USER, { code: 'SLANG', name: 'Slang', onHand: 3 }).item;
  assert.strictEqual(stock.setSubItems(tenantId, used.id, [{ name: 'Lengte', values: ['15 m'] }]).status, 409);
  assert.strictEqual(stock.setSubItems(tenantId, small.id, [{ name: 'Kleur', values: ['zwart'] }]).status, 409);

  // Verwijderen: subartikelen met mutaties worden gearchiveerd, de artikelgroep blijft (gearchiveerd).
  assert.deepStrictEqual(stock.remove(tenantId, articleGroup.id), { archived: true, code: 'PE-BUIS' });
  assert.strictEqual(stock.get(tenantId, more.item.subItems[2].id), null);
  const fresh = stock.create(tenantId, USER, { code: 'DRUPPELAAR', name: 'Druppelaar' }).item;
  stock.setSubItems(tenantId, fresh.id, [{ name: 'Afgifte', values: ['2 l/u', '4 l/u'] }]);
  assert.deepStrictEqual(stock.remove(tenantId, fresh.id), { deleted: true, code: 'DRUPPELAAR' });
  assert.strictEqual(stock.list(tenantId, { archived: true }).filter((item) => item.code.startsWith('DRUPPELAAR')).length, 0);
});

/**
 * Hoofdtenant met beheerder, installateur en klant, plus een testserver.
 * @returns {Promise<object>} server, db en as (inloggen).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'pien', displayName: 'Pien', role: 'planner', password: PW });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db }));
  return { server, db, as: createLogin(base, { password: PW }) };
}

test('subartikelen via de API: kenmerken, keuzelijst, werkorder kiest eerst een maat, rechten en andere organisatie', async () => {
  const { server, db: stockDb, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const pien = await as('pien');
    const klant = await as('klant');
    const articleGroup = (await kees.post('/app/api/stock/items', { code: 'SLANG', name: 'Tuinslang', salePrice: 20, costPrice: 12 })).body;
    const made = await kees.put(`/app/api/stock/items/${articleGroup.id}/sub-items`, { attributes: [{ name: 'Lengte', values: ['15 m', '25 m'] }] });
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(made.body.created, 2);
    assert.strictEqual((await kees.put(`/app/api/stock/items/${articleGroup.id}/sub-items`, { attributes: [{ name: '', values: ['x'] }] })).status, 400);
    assert.strictEqual((await kees.post(`/app/api/stock/items/${articleGroup.id}/movements`, { kind: 'ontvangst', qty: 1 })).status, 409);

    // Keuzelijst: artikelgroep met subartikelen, zonder inkoopprijs; ook voor de planner (werkorders).
    const picker = (await pien.get('/app/api/stock/articles')).body.items;
    const hose = picker.find((article) => article.code === 'SLANG');
    assert.deepStrictEqual(hose.subItems.map((subItem) => [subItem.code, subItem.values.Lengte]), [['SLANG-15M', '15 m'], ['SLANG-25M', '25 m']]);
    assert.ok(!JSON.stringify(picker).includes('costPrice'));
    assert.strictEqual((await klant.get('/app/api/stock/articles')).status, 403);
    assert.strictEqual((await pien.put(`/app/api/stock/items/${articleGroup.id}/sub-items`, { attributes: [] })).status, 403);
    assert.strictEqual((await pien.post(`/app/api/stock/items/${articleGroup.id}/publish`, {})).status, 403);
    const unlinked = await kees.post(`/app/api/stock/items/${articleGroup.id}/publish`, {});
    assert.strictEqual(unlinked.status, 409);
    assert.strictEqual(unlinked.body.error, 'not_configured');

    // Werkorder met de code van de artikelgroep: eerst een maat kiezen; met het subartikel wordt er gereserveerd.
    const quote = (await kees.post('/app/api/quotes', { data: { title: 'Slang', customer: { name: 'Fam. Jansen' },
      lines: [{ section: 'materiaal', code: 'SLANG', description: 'Tuinslang', qty: 2, unit: 'st', price: 20 }] } })).body;
    await kees.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' });
    const workOrder = (await kees.post('/app/api/workorders', { quoteId: quote.id })).body;
    let stockOfOrder = (await kees.get(`/app/api/stock/workorders/${workOrder.id}`)).body;
    assert.deepStrictEqual(stockOfOrder.chooseSubItem.map((line) => [line.code, line.qty]), [['SLANG', 2]]);
    assert.deepStrictEqual(stockOfOrder.notInStock, []);
    assert.strictEqual(stockOfOrder.lines.length, 0);
    const full = (await kees.get(`/app/api/workorders/${workOrder.id}`)).body;
    full.data.materials[0].code = 'SLANG-25M';
    assert.strictEqual((await kees.put(`/app/api/workorders/${workOrder.id}`, { data: full.data })).status, 200);
    stockOfOrder = (await kees.get(`/app/api/stock/workorders/${workOrder.id}`)).body;
    assert.deepStrictEqual(stockOfOrder.chooseSubItem, []);
    assert.deepStrictEqual(stockOfOrder.lines.map((line) => [line.code, line.reserved]), [['SLANG-25M', 2]]);

    // Twee maten op dezelfde werkorder: de artikelgroep telt één werkorder.
    full.data.materials.push({ ...full.data.materials[0], code: 'SLANG-15M', qty: 1 });
    assert.strictEqual((await kees.put(`/app/api/workorders/${workOrder.id}`, { data: full.data })).status, 200);
    assert.strictEqual((await kees.get(`/app/api/stock/items/${articleGroup.id}`)).body.orders, 1);
    assert.strictEqual((await kees.get('/app/api/stock')).body.items.find((item) => item.id === articleGroup.id).orders, 1);
    full.data.materials.pop();
    assert.strictEqual((await kees.put(`/app/api/workorders/${workOrder.id}`, { data: full.data })).status, 200);

    // Losse factuur met de code van de artikelgroep: niets afgeboekt op de artikelgroep.
    const invoice = (await baas.post('/app/api/invoices', { data: { customer: { name: 'Balieklant' }, lines: [{ code: 'SLANG', description: 'Tuinslang', qty: 1, price: 20 }] } })).body;
    assert.strictEqual((await baas.post(`/app/api/invoices/${invoice.id}/finalize`, {})).status, 200);
    const groupAfter = (await kees.get(`/app/api/stock/items/${articleGroup.id}`)).body;
    assert.strictEqual(groupAfter.onHand, 0);
    assert.deepStrictEqual(groupAfter.movements, []);
    assert.strictEqual(stockDb.prepare('SELECT on_hand FROM stock_items WHERE id = ?').get(articleGroup.id).on_hand, 0);

    // Andere organisatie: 404 op de artikelgroep, eigen lege keuzelijst.
    const created = await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const piet = await as('piet', 'groen');
    assert.strictEqual((await piet.put(`/app/api/stock/items/${articleGroup.id}/sub-items`, { attributes: [{ name: 'Lengte', values: ['50 m'] }] })).status, 404);
    assert.strictEqual((await piet.post(`/app/api/stock/items/${articleGroup.id}/publish`, {})).status, 404);
    assert.deepStrictEqual((await piet.get('/app/api/stock/articles')).body.items, []);
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
        if (!product) return { id: update.id, error: { message: 'Onbekend product' } };
        if (update.regular_price !== undefined) product.regular_price = update.regular_price;
        if (update.stock_quantity !== undefined) { product.stock_quantity = update.stock_quantity; product.manage_stock = true; }
        if (update.status !== undefined) product.status = update.status;
        if (update.sku !== undefined) product.sku = update.sku;
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

test('subartikelen en WooCommerce: variabel product wordt artikelgroep, prijs en voorraad per variatie, nieuwe subartikel naar de webshop', async () => {
  const products = new Map([['70', { id: 70, type: 'variable', sku: 'KOPPELING', name: 'Koppeling', status: 'publish', regular_price: '', meta_data: [],
    attributes: [{ id: 1, name: 'Maat', options: ['20 mm', '25 mm'], variation: true, visible: true, position: 0 }, { id: 2, name: 'Merk', options: ['Aquatech'], variation: false, visible: true, position: 1 }] }]]);
  const variations = new Map([['70', [variation(71, 'KOP-20', '20 mm', '2.42', 10), variation(72, 'KOP-25', '25 mm', '3.63', 4)]]]);
  const { tenantId, stock, sync, shop, calls } = setupShop(products, variations, { url: 'http://shop.test', mode: 'rest', push: true, pricesIncludeTax: true, vatRate: 21 });

  // Webshop → Aquatech: artikelgroep met het kenmerk Maat, subartikelen met prijs en stand.
  const first = await sync.run(tenantId);
  assert.strictEqual(first.created, 3);
  const articleGroup = stock.list(tenantId).find((item) => item.code === 'KOPPELING');
  assert.deepStrictEqual(articleGroup.attributes, [{ name: 'Maat', values: ['20 mm', '25 mm'] }]);
  let full = stock.get(tenantId, articleGroup.id);
  assert.deepStrictEqual(full.subItems.map((item) => [item.code, item.values.Maat, item.salePrice, item.onHand, item.shop.productId]), [
    ['KOP-20', '20 mm', 2, 10, '71'], ['KOP-25', '25 mm', 3, 4, '72'],
  ]);
  assert.strictEqual(shop.products(tenantId).find((product) => product.id === '71').parentId, '70');
  // Het type wordt bewaard: ook een variabel product zonder variaties blijft variabel.
  const stored = { sku: 'LEEG', name: 'Leeg', price: null, currency: 'EUR', url: '', image: '', inStock: true, code: '', categories: [], attributes: [] };
  shop.replaceProducts(tenantId, [{ ...stored, id: '99', type: 'variable' }], new Date().toISOString());
  assert.strictEqual(shop.products(tenantId)[0].type, 'variable');

  // Aquatech → webshop: prijs van één subartikel via de variatie-batch.
  stock.update(tenantId, full.subItems[0].id, { salePrice: 2.5 });
  calls.length = 0;
  await sync.run(tenantId, { full: false });
  assert.ok(calls.some((call) => call.path.endsWith('/products/70/variations') && call.method === 'GET'));
  assert.ok(calls.some((call) => call.path.endsWith('/products/70/variations/batch')));
  assert.strictEqual(variations.get('70')[0].regular_price, '3.03');

  // Verkocht in de webshop: afgeboekt op het subartikel.
  variations.get('70')[1].stock_quantity = 3;
  const second = await sync.run(tenantId);
  assert.strictEqual(second.soldInShop, 1);
  assert.strictEqual(stock.get(tenantId, full.subItems[1].id).onHand, 3);

  // Nieuwe maat in Aquatech: de variatie en de waarde komen in de webshop (andere kenmerken blijven).
  stock.setSubItems(tenantId, articleGroup.id, [{ name: 'Maat', values: ['20 mm', '25 mm', '32 mm'] }]);
  full = stock.get(tenantId, articleGroup.id);
  const added = full.subItems.find((item) => item.values.Maat === '32 mm');
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

  // Product weg uit de webshop terwijl er een nieuwe maat is: de ronde loopt door, het subartikel krijgt een melding.
  products.delete('70');
  stock.setSubItems(tenantId, articleGroup.id, [{ name: 'Maat', values: ['20 mm', '25 mm', '32 mm', '40 mm'] }]);
  const newest = stock.get(tenantId, articleGroup.id).subItems.find((item) => item.values.Maat === '40 mm');
  await sync.run(tenantId);
  assert.match(stock.get(tenantId, newest.id).shop.error, /Variatie niet aangemaakt/);
});

test('subartikelen en WooCommerce: artikel en artikelgroep uit Aquatech als nieuw product in de webshop', async () => {
  const products = new Map();
  const variations = new Map();
  const { tenantId, stock, sync } = setupShop(products, variations, { url: 'http://shop.test', mode: 'rest', push: true, mirror: false, pricesIncludeTax: true, vatRate: 21 });
  const simple = stock.create(tenantId, USER, { code: 'VENTIEL', name: 'Ventiel', salePrice: 40, onHand: 5 }).item;
  const articleGroup = stock.create(tenantId, USER, { code: 'SPROEIER', name: 'Sproeier', salePrice: 10 }).item;
  stock.setSubItems(tenantId, articleGroup.id, [{ name: 'Worp', values: ['4 m', '8 m'] }]);

  const plain = await sync.publish(tenantId, simple.id);
  assert.ok(plain.productId);
  const createdSimple = products.get(plain.productId);
  assert.strictEqual(createdSimple.type, 'simple');
  assert.strictEqual(createdSimple.regular_price, '48.40');
  assert.strictEqual(createdSimple.stock_quantity, 5);
  assert.strictEqual((await sync.publish(tenantId, simple.id)).status, 409);

  // Een ander, al gekoppeld artikelgroep met een ontbrekende variatie telt niet mee bij deze publicatie.
  const other = stock.create(tenantId, USER, { code: 'DOP', name: 'Dop' }).item;
  stock.setSubItems(tenantId, other.id, [{ name: 'Maat', values: ['1/2"'] }]);
  const otherProduct = await sync.publish(tenantId, other.id);
  stock.setSubItems(tenantId, other.id, [{ name: 'Maat', values: ['1/2"', '3/4"'] }]);
  const variable = await sync.publish(tenantId, articleGroup.id);
  assert.strictEqual(variable.variations, 2);
  assert.strictEqual(variable.warning, null);
  assert.strictEqual(variations.get(otherProduct.productId).length, 1);
  assert.ok(!stock.get(tenantId, other.id).subItems.find((item) => item.values.Maat === '3/4"').shop.productId);
  assert.strictEqual(products.get(variable.productId).type, 'variable');
  assert.deepStrictEqual(variations.get(variable.productId).map((entry) => [entry.sku, entry.attributes[0].option, entry.regular_price]), [['SPROEIER-4M', '4 m', '12.10'], ['SPROEIER-8M', '8 m', '12.10']]);
  const subItem = stock.get(tenantId, articleGroup.id).subItems[0];
  assert.strictEqual((await sync.publish(tenantId, subItem.id)).status, 409);

  // Een volle ronde daarna koppelt alles zonder iets dubbel aan te maken; alleen de ontbrekende maat van DOP komt erbij.
  const round = await sync.run(tenantId);
  assert.strictEqual(round.createdVariations, 1);
  assert.strictEqual(variations.get(otherProduct.productId).length, 2);
  assert.strictEqual(variations.get(variable.productId).length, 2);
  assert.ok(stock.get(tenantId, articleGroup.id).subItems.every((item) => item.shop.productId && !item.shop.error));
});

test('subartikelen en WooCommerce: een eerder als gewoon artikel overgenomen variabel product wordt artikelgroep (zonder voorraad)', async () => {
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
  assert.strictEqual(promoted.isGroup, true);
  assert.deepStrictEqual(promoted.subItems.map((item) => [item.code, item.values.Maat]), [['KOP-20', '20 mm']]);
  const kept = stock.get(tenantId, used.id);
  assert.strictEqual(kept.isGroup, false);
  assert.strictEqual(kept.onHand, 3);
  assert.match(kept.shop.error, /voorraad of boekingen/);
});

test('subartikelen en WooCommerce: type van vóór de migratie is onbekend, variatiekenmerken na het tiende blijven bewaard', () => {
  const db = openDb();
  const tenantId = createStore(db).ensureTenant().id;
  const stock = createStockStore(db);
  const shop = createShopStore(db);
  const base = { sku: '', name: '', price: 1, currency: 'EUR', url: '', image: '', inStock: true, code: '', categories: [] };
  const extra = Array.from({ length: 11 }, (_, index) => ({ name: `Extra ${index}`, variation: false, options: ['x'] }));
  shop.replaceProducts(tenantId, [
    { ...base, id: '10', sku: 'DOP', name: 'Dop', type: 'variable', attributes: [...extra, { name: 'Maat', variation: true, options: ['1/2"', '3/4"'] }] },
    { ...base, id: '11', sku: 'LOS', name: 'Los', type: 'simple' },
  ], new Date().toISOString());
  const products = shop.products(tenantId);
  const dop = products.find((product) => product.id === '10');
  assert.ok(dop.attributes.some((attribute) => attribute.name === 'Maat' && attribute.variation), 'variatiekenmerk na het tiende kenmerk bewaard');
  assert.strictEqual(products.find((product) => product.id === '11').type, 'simple');

  // Een rij zonder type (zoals na migratie 33 voor oude producten) is onbekend en wordt niet overgenomen.
  db.prepare("UPDATE shop_products SET type = '' WHERE tenant_id = ? AND id = '11'").run(tenantId);
  const unknown = shop.products(tenantId).find((product) => product.id === '11');
  assert.strictEqual(unknown.type, 'unknown');
  const refused = stock.importShop(tenantId, shop.products(tenantId), ['11']);
  assert.match(refused.error, /Synchroniseer eerst/);
  assert.ok(!stock.findCode(tenantId, 'LOS'));
});

test('subartikelen en WooCommerce: mislukt een latere batch, dan blijven de eerder aangemaakte variaties bewaard', async () => {
  let batch = 0;
  /**
   * Nagebootste webshop: de eerste batch slaagt, de tweede geeft een serverfout.
   * @param {string} url Adres van het verzoek.
   * @param {object} options Fetch-opties (body).
   * @returns {Promise<object>} Antwoord zoals fetch het geeft.
   */
  const fetchImpl = async (url, options) => {
    batch++;
    if (batch > 1) return { ok: false, status: 500, headers: new Headers(), text: async () => '{"message":"Serverfout"}' };
    const body = JSON.parse(options.body);
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ create: body.create.map((_, index) => ({ id: 1000 + index })) }) };
  };
  const shopConfig = { ...sanitizeShop({ url: 'http://shop.test', mode: 'rest' }), consumerKey: 'ck_test_1234567890', consumerSecret: 'cs_test_1234567890' };
  const variations = Array.from({ length: 101 }, (_, index) => ({ sku: `V-${index}`, code: `V-${index}`, values: { Maat: String(index) } }));
  const results = await createVariations(shopConfig, '70', variations, { fetchImpl, allowInsecure: true });
  assert.strictEqual(results.length, 101);
  assert.strictEqual(results.filter((result) => result.ok).length, 100);
  assert.strictEqual(results[100].ok, false);
});

test('subartikelen: een artikelgroep zonder mutaties wordt met zijn subartikelen echt verwijderd (FK stock_items.group_id)', () => {
  const db = openDb();
  const tenantId = createStore(db).ensureTenant().id;
  const stock = createStockStore(db);
  const articleGroup = stock.create(tenantId, USER, { code: 'LOSBUIS', name: 'Losse buis', unit: 'm' }).item;
  stock.setSubItems(tenantId, articleGroup.id, [{ name: 'Maat', values: ['16 mm', '20 mm'] }]);
  assert.deepStrictEqual(stock.remove(tenantId, articleGroup.id), { deleted: true, code: 'LOSBUIS' });
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM stock_items WHERE tenant_id = ? AND code LIKE 'LOSBUIS%'").get(tenantId).n, 0);
});

test('samenvoegen en WooCommerce: oude producten krijgen een lege sku en gaan op concept, de artikelgroep wordt één variabel product', async () => {
  const products = new Map([
    ['11', { id: 11, type: 'simple', sku: 'BUS-32', name: 'Steunbus 32 mm', status: 'publish', regular_price: '1.21', meta_data: [], attributes: [] }],
    ['12', { id: 12, type: 'simple', sku: 'BUS-40', name: 'Steunbus 40 mm', status: 'publish', regular_price: '1.21', meta_data: [], attributes: [] }],
  ]);
  const variations = new Map();
  const { tenantId, stock, sync, calls } = setupShop(products, variations, { url: 'http://shop.test', mode: 'rest', push: true, pricesIncludeTax: true, vatRate: 21 });
  assert.strictEqual(sync.canPublish(tenantId), true);
  const first = stock.create(tenantId, USER, { code: 'BUS-32', name: 'Steunbus 32 mm', salePrice: 1, onHand: 3 }).item;
  const second = stock.create(tenantId, USER, { code: 'BUS-40', name: 'Steunbus 40 mm', salePrice: 1, onHand: 2 }).item;
  stock.update(tenantId, first.id, { shopSync: true });
  stock.update(tenantId, second.id, { shopSync: true });
  const merged = stock.mergeIntoGroup(tenantId, { ids: [first.id, second.id], code: 'BUS', name: 'Steunbus', attributeName: 'Maat', values: { [first.id]: '32 mm', [second.id]: '40 mm' } }, {
    shopMatchOf: sync.matcher([{ id: '11', sku: 'BUS-32' }, { id: '12', sku: 'BUS-40' }]),
  });
  assert.ok(!merged.error, JSON.stringify(merged));
  assert.deepStrictEqual(merged.shopProductIds.sort(), ['11', '12']);

  const result = await sync.exclusive(tenantId, () => sync.publishMergedNow(tenantId, merged.groupId, merged.shopProductIds));
  assert.ok(!result.error, JSON.stringify(result));
  assert.strictEqual(result.hidden, 2);
  assert.strictEqual(result.variations, 2);
  assert.strictEqual(result.warning, null);
  assert.strictEqual(products.get('11').status, 'draft');
  assert.strictEqual(products.get('11').sku, '');
  assert.strictEqual(products.get('12').status, 'draft');
  const created = [...products.values()].find((product) => product.type === 'variable');
  assert.strictEqual(created.status, 'publish');
  assert.deepStrictEqual(variations.get(String(created.id)).map((entry) => entry.sku).sort(), ['BUS-32', 'BUS-40']);
  assert.ok(calls.some((call) => call.path.endsWith('/products/batch')));
});

test('samenvoegen en WooCommerce: lukt de artikelgroep niet, dan komen de sku\'s terug en meldt de functie revert', async () => {
  const products = new Map([
    ['21', { id: 21, type: 'simple', sku: 'KAP-1', name: 'Kap 1', status: 'publish', regular_price: '1.21', meta_data: [], attributes: [] }],
  ]);
  const { tenantId, stock, sync } = setupShop(products, new Map(), { url: 'http://shop.test', mode: 'rest', push: true, pricesIncludeTax: true, vatRate: 21 });
  // Een artikelgroep dat niet naar de webshop mag (shop_sync uit) laat publishNow een fout geven.
  const articleGroup = stock.create(tenantId, USER, { code: 'KAP', name: 'Kap' }).item;
  stock.update(tenantId, articleGroup.id, { shopSync: false });
  const result = await sync.exclusive(tenantId, () => sync.publishMergedNow(tenantId, articleGroup.id, ['21']));
  assert.strictEqual(result.revert, true);
  assert.ok(result.error);
  assert.strictEqual(products.get('21').sku, 'KAP-1', 'de sku is teruggezet');
  assert.strictEqual(products.get('21').status, 'publish');
});

test('samenvoegen en WooCommerce: zonder schrijfrechten kan Aquatech de webshop niet bijwerken', async () => {
  const { tenantId, sync } = setupShop(new Map(), new Map(), { url: 'http://shop.test', mode: 'rest', push: false, vatRate: 21 });
  assert.strictEqual(sync.canPublish(tenantId), false);
  const result = await sync.exclusive(tenantId, () => sync.publishMergedNow(tenantId, 'x', ['1']));
  assert.strictEqual(result.revert, true);
  assert.strictEqual(result.code, 'no_push');
});

test('samenvoegen via de API: gekoppelde artikelen worden één variabel webshopproduct, zonder schrijfrechten wordt dat geweigerd en bij een webshopfout draait alles terug', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const products = new Map([
    ['11', { id: 11, type: 'simple', sku: 'BUS-32', name: 'Steunbus 32 mm', status: 'publish', regular_price: '1.21', meta_data: [], attributes: [] }],
    ['12', { id: 12, type: 'simple', sku: 'BUS-40', name: 'Steunbus 40 mm', status: 'publish', regular_price: '1.21', meta_data: [], attributes: [] }],
  ]);
  const variations = new Map();
  const fake = fakeShop(products, variations);
  let failBatch = false;
  const { server, base } = await listen(createApp({ env: { AUTO_WORK_ORDER: '0' }, secret: SECRET, db, shopFetch: async (url, options) => {
    if (failBatch && String(url).endsWith('/products/batch')) return { ok: false, status: 500, headers: new Headers(), text: async () => 'kapot' };
    return fake.fetchImpl(url, options);
  } }));
  try {
    const baas = await createLogin(base, { password: PW })('baas');
    /**
     * Zet de webshopkoppeling met de nagebootste webshop.
     * @param {object} extra Wat afwijkt (bijv. push).
     * @returns {Promise<object>} Het antwoord.
     */
    const shopSettings = (extra) => baas.put('/app/api/admin/shop', { url: 'http://shop.test', mode: 'rest', consumerKey: 'ck_test_1234567890', consumerSecret: 'cs_test_1234567890', pricesIncludeTax: true, vatRate: 21, mirror: true, ...extra });
    const first = (await baas.post('/app/api/stock/items', { code: 'BUS-32', name: 'Steunbus 32 mm', unit: 'st', salePrice: 1, onHand: 3 })).body;
    const second = (await baas.post('/app/api/stock/items', { code: 'BUS-40', name: 'Steunbus 40 mm', unit: 'st', salePrice: 1, onHand: 2 })).body;
    db.prepare('UPDATE stock_items SET shop_product_id = ?, shop_sync = 1 WHERE id = ?').run('11', first.id);
    db.prepare('UPDATE stock_items SET shop_product_id = ?, shop_sync = 1 WHERE id = ?').run('12', second.id);
    const body = { ids: [first.id, second.id], code: 'BUS', name: 'Steunbus', attributeName: 'Maat', values: { [first.id]: '32 mm', [second.id]: '40 mm' } };

    // De webshop bepaalt de lijst, maar Aquatech mag niet schrijven: geweigerd en het voorstel meldt dat.
    assert.strictEqual((await shopSettings({ push: false })).status, 200);
    assert.deepStrictEqual((await baas.get('/app/api/stock/merge-suggestions')).body.shop, { publishes: false, blocked: true });
    const refused = await baas.post('/app/api/stock/merge', body);
    assert.strictEqual(refused.status, 409);
    assert.match(refused.body.message, /Aquatech is de bron/);

    // Met schrijfrechten: een webshopfout draait de samenvoeging terug en laat de sku's staan.
    assert.strictEqual((await shopSettings({ push: true })).status, 200);
    assert.deepStrictEqual((await baas.get('/app/api/stock/merge-suggestions')).body.shop, { publishes: true, blocked: false });
    failBatch = true;
    const failed = await baas.post('/app/api/stock/merge', body);
    assert.strictEqual(failed.status, 502, JSON.stringify(failed.body));
    assert.match(failed.body.message, /^Niet samengevoegd/);
    failBatch = false;
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stock_items WHERE is_group = 1').get().n, 0, 'geen artikelgroep achtergebleven');
    assert.strictEqual(db.prepare('SELECT shop_product_id FROM stock_items WHERE id = ?').get(first.id).shop_product_id, '11', 'de koppeling is terug');
    assert.strictEqual(products.get('11').sku, 'BUS-32');

    const merged = await baas.post('/app/api/stock/merge', body);
    assert.strictEqual(merged.status, 201, JSON.stringify(merged.body));
    assert.strictEqual(merged.body.shop.hidden, 2);
    assert.strictEqual(merged.body.shop.warning, null);
    assert.strictEqual(products.get('11').status, 'draft');
    assert.strictEqual(products.get('12').sku, '');
    const variable = [...products.values()].find((product) => product.type === 'variable');
    assert.strictEqual(variable.status, 'publish');
    assert.strictEqual(variations.get(String(variable.id)).length, 2);
    assert.strictEqual(db.prepare('SELECT shop_product_id FROM stock_items WHERE id = ?').get(merged.body.item.id).shop_product_id, String(variable.id));
  } finally { server.close(); }
});
