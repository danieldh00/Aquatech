// Eigen webshop (alleen lezen): openbare pagina's op winkel/ voor artikelen uit
// de voorraad, uit tot de instelling aan staat, zonder interne gegevens.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { buildCatalog, slugify } = require('../src/webshop/storefront-data');
const { createLogin, createClient, listen } = require('./helpers/http-client');

const SECRET = 'f'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, testserver en een paar artikelen in de voorraad.
 * @returns {Promise<object>} db, base (adres), admin (ingelogd), anonymous (niet ingelogd), main (tenant-id).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  const anonymous = createClient(base);
  const created = [];
  for (const item of [
    { code: 'SPR-1', name: 'Sproeier <b>Pro</b>', onHand: 5, costPrice: 4.5, salePrice: 10, location: 'Magazijn A', notes: 'GEHEIM' },
    { code: 'SPR-2', name: 'Sproeier Pro', onHand: 0, salePrice: 20 },
    { code: 'BUIS-25', name: 'PE buis 25 mm', onHand: 100, salePrice: 1.5 },
    { code: 'INTERN', name: 'Alleen intern', onHand: 1 },
    { code: 'NIETSHOP', name: 'Niet naar de shop', onHand: 1, salePrice: 5, shopSync: false },
  ]) created.push((await admin.post('/api/stock/items', item)).body);
  return { db, base, admin, anonymous, main, created };
}

test('slugify: accenten, tekens en lengte', () => {
  assert.strictEqual(slugify('Sproeier Pro & Co – 25 mm'), 'sproeier-pro-en-co-25-mm');
  assert.strictEqual(slugify('Café'), 'cafe');
  assert.strictEqual(slugify('***'), '');
  assert.ok(slugify('a'.repeat(200)).length <= 80);
});

test('catalogus: unieke slugs, categorieën en prijs incl. btw', () => {
  const catalog = buildCatalog([
    { code: 'A', name: 'Sproeier', unit: 'st', on_hand: 1, sale_price: 10, vat_rate: 21, categories: '["Sproeiers"]', image: 'https://x.nl/a.jpg' },
    { code: 'B', name: 'Sproeier', unit: 'st', on_hand: 0, sale_price: 20, vat_rate: 9, categories: 'kapot', image: 'javascript:alert(1)' },
  ]);
  assert.deepStrictEqual(catalog.products.map((product) => product.slug), ['sproeier', 'sproeier-b']);
  assert.strictEqual(catalog.products[0].priceIncl, 12.1);
  assert.strictEqual(catalog.products[1].priceIncl, 21.8);
  assert.strictEqual(catalog.products[1].categoryName, 'Overig');
  assert.strictEqual(catalog.products[1].image, '');
  assert.strictEqual(catalog.products[0].image, 'https://x.nl/a.jpg');
  assert.deepStrictEqual(catalog.categories.map((category) => category.slug), ['overig', 'sproeiers']);
});

test('webshop staat standaard uit en dan is niets bereikbaar', async () => {
  const { anonymous } = await setup();
  for (const urlPath of ['/winkel/', '/winkel/product/pe-buis-25-mm/', '/winkel/assets/winkel.css']) {
    assert.strictEqual((await anonymous.get(urlPath)).status, 404, urlPath);
  }
});

test('webshop aan: start, categorie en product zonder inloggen, zonder interne gegevens', async () => {
  const { db, anonymous, admin, main } = await setup();
  assert.strictEqual((await admin.put('/api/admin/settings', { storefront: true })).status, 200);
  db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(main, '77', 'x', 'https://shop.test/buis.jpg', '["Leidingen"]');
  db.prepare("UPDATE stock_items SET shop_product_id = '77' WHERE tenant_id = ? AND code = 'BUIS-25'").run(main);

  const home = await anonymous.get('/winkel/');
  assert.strictEqual(home.status, 200);
  assert.match(home.type, /text\/html/);
  assert.match(home.text, /Leidingen/);
  assert.match(home.text, /product\/pe-buis-25-mm\//);
  assert.ok(!home.text.includes('Alleen intern') && !home.text.includes('Niet naar de shop'));
  assert.match(home.headers.get('content-security-policy'), /default-src 'none'/);
  assert.ok(!/<script/i.test(home.text));

  const category = await anonymous.get('/winkel/categorie/leidingen/');
  assert.strictEqual(category.status, 200);
  assert.match(category.text, /PE buis 25 mm/);

  const product = await anonymous.get('/winkel/product/pe-buis-25-mm/');
  assert.strictEqual(product.status, 200);
  assert.match(product.text, /€ 1,82/);
  assert.match(product.text, /Op voorraad/);
  assert.match(product.text, /https:\/\/shop\.test\/buis\.jpg/);
  assert.match(product.text, /Artikelnummer: BUIS-25/);

  const spr = await anonymous.get('/winkel/product/sproeier-pro/');
  assert.strictEqual(spr.status, 200);
  assert.ok(!/GEHEIM|Magazijn A|4,5/.test(spr.text), 'geen interne gegevens');
  assert.match(spr.text, /&lt;b&gt;Pro&lt;\/b&gt;|Sproeier/);
  assert.ok(!spr.text.includes('<b>Pro</b>'), 'HTML in namen wordt ontsnapt');
});

test('webshop: assets, doorverwijzing, 404 en alleen lezen', async () => {
  const { base, admin, anonymous } = await setup();
  await admin.put('/api/admin/settings', { storefront: true });
  const noSlash = await createClient(base, { followRedirects: false }).get('/winkel/product/pe-buis-25-mm');
  assert.strictEqual(noSlash.status, 302);
  assert.strictEqual(noSlash.location, 'pe-buis-25-mm/');
  const root = await createClient(base, { followRedirects: false }).get('/winkel');
  assert.strictEqual(root.status, 302);
  assert.strictEqual(root.location, 'winkel/');

  assert.strictEqual((await anonymous.get('/winkel/assets/winkel.css')).status, 200);
  assert.strictEqual((await anonymous.get('/winkel/assets/brand.css')).status, 200);
  assert.strictEqual((await anonymous.get('/winkel/assets/logo-white.png')).status, 200);
  assert.strictEqual((await anonymous.get('/winkel/assets/fonts/montserrat-latin-400-normal.woff2')).status, 200);
  assert.strictEqual((await anonymous.get('/winkel/assets/fonts/..%2F..%2Fserver.js')).status, 404);
  assert.strictEqual((await anonymous.get('/winkel/assets/constructor')).status, 404);

  const missing = await anonymous.get('/winkel/product/bestaat-niet/');
  assert.strictEqual(missing.status, 404);
  assert.match(missing.text, /Pagina niet gevonden/);
  assert.strictEqual((await anonymous.get('/winkel/categorie/bestaat-niet/')).status, 404);
  assert.strictEqual((await anonymous.get('/winkel/onzin/pad')).status, 404);

  assert.strictEqual((await anonymous.post('/winkel/', {})).status, 405);
});
