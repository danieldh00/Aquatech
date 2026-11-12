// Kortingen per productcategorie voor zakelijke klanten: de instelling en de zoekfunctie (diepste categorie wint), de
// rangorde met een eigen zakelijke prijs, verpakkingen en groothandelskortingen, de prijzen in de catalogus en de
// winkelwagen/bestelling, de beheerroutes (rechten, controle, tenantgrens) en de uitkomst op de factuur.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeCategoryDiscounts, resolverFor, flatten } = require('../src/webshop/category-discounts');
const Wholesale = require('../src/webshop/wholesale');
const { buildCatalog } = require('../src/webshop/storefront-data');
const { DEFAULT_TREE } = require('../src/webshop/category-tree');
const { createLogin, createClient, listen, postForm, postCheckout } = require('./helpers/http-client');

const SECRET = 'e'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/** Bedrijfsgegevens voor een zakelijke klant. */
const COMPANY = { companyName: 'Bouwbedrijf Vos BV', kvkNumber: '12345678', vatNumber: 'NL123456789B01' };
/** Afrekengegevens voor ophalen. */
const PICKUP = { name: 'Pieter', company: '', email: 'pieter@voorbeeld.nl', phone: '', street: '', postcode: '', city: '', note: '', shippingMethod: 'ophalen', country: 'NL', action: 'place', paymentMethod: 'rekening' };
/** De hoofdcategorie en haar subcategorie in de standaardboom. */
const PARENT = { slug: 'druppelslang-toebehoren', name: 'Druppelslangen & toebehoren' };
const CHILD = { slug: 'driptape-koppelingen', name: 'Driptape koppelingen' };
const OTHER = { slug: 'beregeningscomputers-en-regensensors', name: 'Beregeningscomputers & regensensors' };

test('instelling: alleen geldige regels, één per categorie, op categorie gesorteerd', () => {
  assert.deepStrictEqual(sanitizeCategoryDiscounts(undefined), { rules: [] });
  assert.deepStrictEqual(sanitizeCategoryDiscounts({ rules: 'x' }), { rules: [] });
  const clean = sanitizeCategoryDiscounts({ rules: [
    { categorySlug: 'b', discountPct: '12.345' }, { categorySlug: 'a', discountPct: 10 }, { categorySlug: 'a', discountPct: 15 },
    { categorySlug: 'c', discountPct: 0 }, { categorySlug: 'f', discountPct: 0.004 }, { categorySlug: 'd', discountPct: 91 }, { categorySlug: '', discountPct: 5 }, { categorySlug: 'e', discountPct: 'veel' }, null,
  ] });
  assert.deepStrictEqual(clean.rules, [{ categorySlug: 'a', discountPct: 15 }, { categorySlug: 'b', discountPct: 12.35 }]);
  assert.strictEqual(sanitizeCategoryDiscounts({ rules: [{ categorySlug: 'x', discountPct: 90 }] }).rules.length, 1, '90% mag nog');
});

test('zoeken: de diepste categorie met een korting wint, anders de bovenliggende; onbekend = geen korting', () => {
  const tree = [{ name: 'Root', slug: 'root', children: [{ name: 'Mid', slug: 'mid', children: [{ name: 'Leaf', slug: 'leaf' }, { name: 'Leaf2', slug: 'leaf2' }] }, { name: 'Side', slug: 'side' }] }];
  const find = resolverFor(tree, { rules: [{ categorySlug: 'mid', discountPct: 10 }, { categorySlug: 'leaf2', discountPct: 25 }] });
  assert.strictEqual(find('leaf'), 10, 'erft van de middelste');
  assert.strictEqual(find('leaf2'), 25, 'eigen korting gaat voor');
  assert.strictEqual(find('mid'), 10);
  assert.strictEqual(find('side'), 0, 'zusje zonder korting');
  assert.strictEqual(find('root'), 0);
  assert.strictEqual(find('onbekend'), 0);
  assert.strictEqual(find(undefined), 0);
  assert.strictEqual(resolverFor(tree, {})('leaf'), 0);
  assert.deepStrictEqual(flatten(tree).map((node) => [node.slug, node.depth, node.parentSlug, node.path]), [
    ['root', 0, '', 'Root'], ['mid', 1, 'root', 'Root › Mid'], ['leaf', 2, 'mid', 'Root › Mid › Leaf'], ['leaf2', 2, 'mid', 'Root › Mid › Leaf2'], ['side', 1, 'root', 'Root › Side'],
  ]);
});

test('groothandelsprijs: de hoogste van staffel, klant en categorie; nooit opgeteld', () => {
  const tiers = [{ minQty: 10, discountPct: 10 }];
  assert.deepStrictEqual(Wholesale.wholesalePrice(10, 1, tiers, 0, 0), { unitExcl: 10, discountPct: 0, source: '' });
  assert.deepStrictEqual(Wholesale.wholesalePrice(10, 1, tiers, 0, 25), { unitExcl: 7.5, discountPct: 25, source: 'categorie' });
  assert.deepStrictEqual(Wholesale.wholesalePrice(10, 10, tiers, 5, 25), { unitExcl: 7.5, discountPct: 25, source: 'categorie' });
  assert.deepStrictEqual(Wholesale.wholesalePrice(10, 10, tiers, 30, 25), { unitExcl: 7, discountPct: 30, source: 'klant' });
  assert.strictEqual(Wholesale.wholesalePrice(10, 10, tiers, 5, 10).source, 'staffel', 'bij gelijk gaat de staffel voor');
  assert.strictEqual(Wholesale.wholesalePrice(10, 1, tiers, 10, 10).source, 'klant', 'bij gelijk gaat de klant voor de categorie');
});

test('catalogus: zakelijke prijs na korting, eigen zakelijke prijs blijft, varianten volgen het hoofdartikel', () => {
  const rows = [
    { id: 'a', code: 'A', name: 'Koppeling', unit: 'st', on_hand: 5, sale_price: 10, vat_rate: 21, categories: JSON.stringify([CHILD.name]) },
    { id: 'b', code: 'B', name: 'Met eigen prijs', unit: 'st', on_hand: 5, sale_price: 20, business_price: 15, vat_rate: 21, categories: JSON.stringify([CHILD.name]) },
    { id: 'c', code: 'C', name: 'Computer', unit: 'st', on_hand: 5, sale_price: 100, vat_rate: 21, categories: JSON.stringify([OTHER.name]) },
    { id: 'p', code: 'P', name: 'Hoofd', unit: 'st', has_variants: 1, attributes: '[{"name":"Maat","values":["16","20"]}]', sale_price: null, vat_rate: 21, categories: JSON.stringify([PARENT.name]) },
    { id: 'v1', code: 'P16', name: 'Hoofd 16', unit: 'st', on_hand: 5, parent_id: 'p', variant_values: '{"Maat":"16"}', sale_price: 8, vat_rate: 21 },
    { id: 'v2', code: 'P20', name: 'Hoofd 20', unit: 'st', on_hand: 5, parent_id: 'p', variant_values: '{"Maat":"20"}', sale_price: 12, business_price: 11, vat_rate: 21 },
  ];
  const config = { rules: [{ categorySlug: PARENT.slug, discountPct: 10 }, { categorySlug: CHILD.slug, discountPct: 25 }] };
  const catalog = buildCatalog(rows, new Map(), DEFAULT_TREE, config);
  const byCode = new Map([...catalog.products, ...catalog.variantProducts].map((product) => [product.code, product]));
  assert.deepStrictEqual([byCode.get('A').priceBusinessList, byCode.get('A').priceBusiness, byCode.get('A').categoryDiscountPct, byCode.get('A').priceBusinessIncl], [10, 7.5, 25, 9.07]);
  assert.strictEqual(byCode.get('A').priceIncl, 12.1, 'particuliere prijs ongewijzigd');
  assert.deepStrictEqual([byCode.get('B').priceBusiness, byCode.get('B').categoryDiscountPct], [15, 0], 'eigen zakelijke prijs gaat voor');
  assert.deepStrictEqual([byCode.get('C').priceBusiness, byCode.get('C').categoryDiscountPct], [100, 0]);
  assert.deepStrictEqual([byCode.get('P16').priceBusiness, byCode.get('P16').categoryDiscountPct], [7.2, 10], 'variant: 10% van de hoofdcategorie');
  assert.deepStrictEqual([byCode.get('P20').priceBusiness, byCode.get('P20').categoryDiscountPct], [11, 0]);
  assert.strictEqual(byCode.get('P').priceBusiness, 7.2, 'laagste zakelijke prijs van de varianten');
  assert.deepStrictEqual([...catalog.discountByCode], [['A', 25], ['P16', 10]]);
  assert.strictEqual(buildCatalog(rows, new Map(), DEFAULT_TREE).discountByCode.size, 0, 'zonder instelling geen kortingen');
});

/**
 * Winkel met artikelen in categorieën, een beheerder, een andere organisatie en een zakelijke klant, groothandelsklant en particulier.
 * @returns {Promise<object>} base, admin, vreemd, db, main en shopper(opties).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  const admin = await as('baas');
  const vreemd = await as('vreemd', 'ander');
  assert.strictEqual((await admin.put('/app/api/admin/settings', { storefront: true, shopOrdering: true })).status, 200);
  const items = [
    { code: 'DRIP1', salePrice: 10, category: CHILD }, { code: 'GRON', salePrice: 20, businessPrice: 15, category: CHILD },
    { code: 'LOS', salePrice: 10, category: PARENT }, { code: 'NONE', salePrice: 10, category: OTHER }, { code: 'PACK', salePrice: 10, category: CHILD },
  ];
  const ids = {};
  for (const [index, item] of items.entries()) {
    const made = await admin.post('/app/api/stock/items', { code: item.code, name: `Artikel ${item.code}`, unit: 'st', onHand: 5000, salePrice: item.salePrice, businessPrice: item.businessPrice, vatRate: 21 });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    ids[item.code] = made.body.id;
    db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(main, String(index + 1), item.code, '', JSON.stringify([item.category.name]));
    db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND code = ?').run(String(index + 1), main, item.code);
  }
  const packs = await admin.put(`/app/api/stock/items/${ids.PACK}/packagings`, { packagings: [
    { code: 'DOOS', name: 'Doos', factor: 10, salePrice: '', audience: 'iedereen' },
    { code: 'PAL', name: 'Pallet', factor: 100, salePrice: '', businessPrice: 700, audience: 'zakelijk' },
  ] });
  assert.strictEqual(packs.status, 200, JSON.stringify(packs.body));
  let counter = 0;
  /**
   * Registreert een klant in de shop.
   * @param {{ business?: boolean, wholesaleDiscount?: number }} [options] business = zakelijke klantgroep; wholesaleDiscount = groothandelsklant met die vaste korting.
   * @returns {Promise<object>} client van de klant.
   */
  const shopper = async ({ business = false, wholesaleDiscount } = {}) => {
    counter += 1;
    const client = createClient(base);
    await postForm(base, client, '/registreren/', { displayName: `Klant ${counter}`, email: `k${counter}@voorbeeld.nl`, password: PW, password2: PW, website: '' });
    const user = (await admin.get('/app/api/admin/users')).body.items.find((candidate) => candidate.email === `k${counter}@voorbeeld.nl`);
    if (business) assert.strictEqual((await admin.patch(`/app/api/admin/users/${user.id}`, { customerGroup: 'zakelijk', ...COMPANY, ...(wholesaleDiscount !== undefined ? { wholesale: true, wholesaleDiscount } : {}) })).status, 200);
    return client;
  };
  return { base, admin, vreemd, db, main, shopper, ids };
}

/**
 * Zet de kortingen: 10% op de hoofdcategorie en 25% op de subcategorie.
 * @param {object} admin De client van de beheerder.
 * @returns {Promise<void>}
 */
async function setDiscounts(admin) {
  const saved = await admin.put('/app/api/admin/category-discounts', { rules: [{ categorySlug: PARENT.slug, discountPct: 10 }, { categorySlug: CHILD.slug, discountPct: 25 }] });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
}

/**
 * Plaatst een bestelling met de gegeven wagen en geeft de regels per code terug.
 * @param {object} world De testwereld.
 * @param {object} client De klant.
 * @param {Object<string, number>} cart Aantal per wagencode.
 * @returns {Promise<{ lines: Object<string, object>, order: object }>} De regels van de bestelling per code en de bestelling.
 */
async function orderLines(world, client, cart) {
  for (const [code, qty] of Object.entries(cart)) await postForm(world.base, client, '/winkelwagen/', { action: 'add', code, qty: String(qty) });
  const placed = await postCheckout(world.base, client, { ...PICKUP, company: COMPANY.companyName, vatNumber: COMPANY.vatNumber });
  assert.strictEqual(placed.status, 303, placed.text.slice(0, 400));
  const orderId = (await world.admin.get('/app/api/admin/web-orders')).body.items[0].id;
  const order = (await world.admin.get(`/app/api/admin/web-orders/${orderId}`)).body.order;
  return { lines: Object.fromEntries(order.lines.map((line) => [line.code, line])), order };
}

test('beheer: lezen, controleren, opslaan, rechten en tenantgrens', async () => {
  const world = await setup();
  const empty = await world.admin.get('/app/api/admin/category-discounts');
  assert.strictEqual(empty.status, 200);
  assert.deepStrictEqual(empty.body.rules, []);
  const known = empty.body.categories.find((category) => category.slug === CHILD.slug);
  assert.deepStrictEqual([known.name, known.depth, known.parentSlug, known.path], [CHILD.name, 2, PARENT.slug, `Beregening › ${PARENT.name} › ${CHILD.name}`]);
  const bad = [
    [{ rules: [{ categorySlug: 'bestaat-niet', discountPct: 5 }] }, 'onbekende categorie'],
    [{ rules: [{ categorySlug: CHILD.slug, discountPct: 0 }] }, 'nul procent'],
    [{ rules: [{ categorySlug: CHILD.slug, discountPct: 91 }] }, 'boven 90'],
    [{ rules: [{ categorySlug: CHILD.slug, discountPct: 'veel' }] }, 'geen getal'],
    [{ rules: [{ categorySlug: CHILD.slug, discountPct: 0.004 }] }, 'wordt na afronden nul'],
    [{ rules: [{ categorySlug: CHILD.slug, discountPct: 5 }, { categorySlug: CHILD.slug, discountPct: 6 }] }, 'dubbel'],
    [{ regels: [] }, 'verkeerde vorm'],
  ];
  for (const [body, why] of bad) {
    const refused = await world.admin.put('/app/api/admin/category-discounts', body);
    assert.strictEqual(refused.status, 400, why);
    assert.ok(refused.body.message, why);
  }
  await setDiscounts(world.admin);
  const read = (await world.admin.get('/app/api/admin/category-discounts')).body;
  assert.deepStrictEqual(read.rules, [{ categorySlug: CHILD.slug, discountPct: 25 }, { categorySlug: PARENT.slug, discountPct: 10 }]);
  assert.strictEqual((await world.admin.put('/app/api/admin/category-discounts', { rules: [] })).body.rules.length, 0, 'lege lijst haalt alles weg');
  await setDiscounts(world.admin);
  const customer = await world.shopper({ business: true });
  assert.strictEqual((await customer.get('/app/api/admin/category-discounts')).status, 403, 'klant');
  assert.strictEqual((await customer.put('/app/api/admin/category-discounts', { rules: [] })).status, 403, 'klant schrijft niet');
  assert.strictEqual((await createClient(world.base).get('/app/api/admin/category-discounts')).status, 401, 'niet ingelogd');
  assert.deepStrictEqual((await world.vreemd.get('/app/api/admin/category-discounts')).body.rules, [], 'andere organisatie ziet de kortingen niet');
  const audit = (await world.admin.get('/app/api/admin/audit')).body;
  assert.ok(JSON.stringify(audit).includes('categoriekortingen_gewijzigd'), 'wijziging staat in het auditlog');
});

test('winkelwagen en bestelling: zakelijk met korting, eigen prijs gaat voor, verpakkingen, particulier niet', async () => {
  const world = await setup();
  await setDiscounts(world.admin);
  const business = await world.shopper({ business: true });
  const { lines, order } = await orderLines(world, business, { DRIP1: 2, GRON: 1, LOS: 1, NONE: 1, 'PACK@DOOS': 1, 'PACK@PAL': 1 });
  assert.strictEqual(lines.DRIP1.unitExcl, 7.5, '25% van de subcategorie');
  assert.strictEqual(lines.DRIP1.lineExcl, 15);
  assert.strictEqual(lines.GRON.unitExcl, 15, 'eigen zakelijke prijs: geen categoriekorting');
  assert.strictEqual(lines.LOS.unitExcl, 9, '10% van de hoofdcategorie');
  assert.strictEqual(lines.NONE.unitExcl, 10, 'categorie zonder korting');
  assert.strictEqual(lines['PACK@DOOS'].unitExcl, 75, 'doos zonder eigen prijs: 10 × 10 met 25%');
  assert.strictEqual(lines['PACK@PAL'].unitExcl, 700, 'pallet met eigen zakelijke prijs: geen korting');
  assert.strictEqual(order.totals.byRate[0].excl, 15 + 15 + 9 + 10 + 75 + 700);

  const consumer = await world.shopper();
  const plain = await orderLines(world, consumer, { DRIP1: 2, LOS: 1 });
  assert.deepStrictEqual([plain.lines.DRIP1.unitExcl, plain.lines.DRIP1.unitIncl, plain.lines.LOS.unitExcl], [10, 12.1, 10], 'particulier: geen korting');
});

test('catalogus en winkelwagenpagina: zakelijk ziet de kortingsprijs en het etiket, particulier niet', async () => {
  const world = await setup();
  await setDiscounts(world.admin);
  const business = await world.shopper({ business: true });
  const consumer = await world.shopper();
  const businessPage = (await business.get(`/categorie/${CHILD.slug}/`)).text;
  const consumerPage = (await consumer.get(`/categorie/${CHILD.slug}/`)).text;
  assert.match(businessPage, /7,50/, 'zakelijke prijs na 25% korting');
  assert.doesNotMatch(consumerPage, /7,50/);
  assert.match(consumerPage, /12,10/);
  await postForm(world.base, business, '/winkelwagen/', { action: 'add', code: 'DRIP1', qty: '2' });
  const cart = (await business.get('/winkelwagen/')).text;
  assert.match(cart, /7,50/);
  assert.match(cart, /25% categoriekorting/);
  // De korting wijzigt direct de prijzen (ook binnen de cache van de catalogus).
  assert.strictEqual((await world.admin.put('/app/api/admin/category-discounts', { rules: [] })).status, 200);
  const after = (await business.get(`/categorie/${CHILD.slug}/`)).text;
  assert.doesNotMatch(after, /7,50/);
  assert.doesNotMatch((await business.get('/winkelwagen/')).text, /categoriekorting/);
});

test('groothandelsklant: de hoogste korting telt, ze worden niet opgeteld', async () => {
  const world = await setup();
  await setDiscounts(world.admin);
  const small = await world.shopper({ business: true, wholesaleDiscount: 5 });
  await postForm(world.base, small, '/winkelwagen/', { action: 'add', code: 'DRIP1', qty: '2' });
  await postForm(world.base, small, '/winkelwagen/', { action: 'add', code: 'PACK@DOOS', qty: '1' });
  const cart = (await small.get('/winkelwagen/')).text;
  assert.match(cart, /25% categoriekorting/, 'categorie (25%) wint van de klant (5%)');
  assert.match(cart, /7,50/);
  const big = await world.shopper({ business: true, wholesaleDiscount: 40 });
  const placed = await orderLines(world, big, { DRIP1: 2, LOS: 1 });
  assert.strictEqual(placed.lines.DRIP1.unitExcl, 6, '40% van de klant wint van 25%, niet 65%');
  assert.strictEqual(placed.lines.LOS.unitExcl, 6);
  // Een afgeleide verpakking (doos zonder eigen prijs) krijgt ook hier de hoogste korting; een pallet met eigen prijs geen enkele.
  const packs = await orderLines(world, big, { 'PACK@DOOS': 1, 'PACK@PAL': 1 });
  assert.strictEqual(packs.lines['PACK@DOOS'].unitExcl, 60, '10 × 10 met 40% van de klant (niet 25%)');
  assert.strictEqual(packs.lines['PACK@PAL'].unitExcl, 700, 'eigen prijs: geen korting');
  const mid = await world.shopper({ business: true, wholesaleDiscount: 5 });
  assert.strictEqual((await orderLines(world, mid, { 'PACK@DOOS': 1 })).lines['PACK@DOOS'].unitExcl, 75, '25% van de categorie wint van 5%');
});

test('factuur: de kortingsprijs staat op de factuur van de bestelling', async () => {
  const world = await setup();
  await setDiscounts(world.admin);
  assert.strictEqual((await world.admin.put('/app/api/invoices/settings', { webOrders: { enabled: true, finalize: false } })).status, 200);
  const business = await world.shopper({ business: true });
  const { order } = await orderLines(world, business, { DRIP1: 4 });
  const shipped = await world.admin.post(`/app/api/admin/web-orders/${order.id}/status`, { status: 'verzonden' });
  assert.strictEqual(shipped.status, 200, JSON.stringify(shipped.body));
  const detail = (await world.admin.get(`/app/api/invoices/${shipped.body.invoice.id}`)).body;
  assert.deepStrictEqual(detail.data.lines.map((line) => [line.code, line.qty, line.price]), [['DRIP1', 4, 7.5]]);
  assert.strictEqual(shipped.body.invoice.total, 36.3, '4 × 7,50 × 1,21');
});
