// Categorieboom van de webshop (1.6.9): producten in de diepste categorie, menu met
// flyouts zonder link op de kop, en de categoriepagina met zijbalk, blokken, filter en sortering.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { buildCatalog } = require('../src/webshop/storefront-data');
const { DEFAULT_TREE, normalizeName, placeIn } = require('../src/webshop/category-tree');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Een artikelrij voor buildCatalog.
 * @param {string} code Artikelcode.
 * @param {string[]} categories Categorienamen van het webshopproduct.
 * @param {object} [extra] Andere velden (bijv. on_hand, sale_price).
 * @returns {object} De rij.
 */
function row(code, categories, extra = {}) {
  return { code, name: `Artikel ${code}`, unit: 'st', on_hand: 1, sale_price: 10, vat_rate: 21, categories: JSON.stringify(categories), ...extra };
}

/**
 * Hoofdtenant met beheerder en een webshop die aan staat, met artikelen in categorieën uit de boom.
 * @param {Array<[string, string[], number?]>} items Artikelcode, categorienamen en eventueel de prijs.
 * @returns {Promise<{ anonymous: object }>} Een client zonder inlog.
 */
async function setup(items) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const { server, base } = await listen(createApp({ secret: 'f'.repeat(64), db }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  assert.strictEqual((await admin.put('/app/api/admin/settings', { storefront: true })).status, 200);
  for (const [index, [code, categories, price]] of items.entries()) {
    assert.strictEqual((await admin.post('/app/api/stock/items', { code, name: `Artikel ${code}`, onHand: 5, salePrice: price ?? 10 })).status, 201);
    db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(main, String(index + 1), code, '', JSON.stringify(categories));
    db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND code = ?').run(String(index + 1), main, code);
  }
  return { anonymous: createClient(base) };
}

test('boom: slugs uniek, afbeeldingen aanwezig, elke hoofdcategorie met bekende groep', () => {
  const slugs = new Set();
  const groups = new Set();
  /**
   * Controleert een knoop en zijn kinderen.
   * @param {object} node De knoop.
   * @returns {void}
   */
  const check = (node) => {
    assert.ok(node.name && /^[a-z0-9_-]+$/.test(node.slug), node.slug);
    assert.ok(!slugs.has(node.slug), `dubbele slug ${node.slug}`);
    slugs.add(node.slug);
    if (node.image) assert.ok(fs.existsSync(path.join(__dirname, '../src/webshop/assets', node.image.replace(/^asset:/, ''))), node.image);
    (node.children || []).forEach(check);
  };
  for (const root of DEFAULT_TREE) { groups.add(root.group); check(root); }
  assert.deepStrictEqual([...groups].sort(), ['beregening', 'elektra', 'leidingen-toebehoren', 'pomp-techniek']);
  assert.ok(slugs.size > 90);
  assert.strictEqual(normalizeName('PE – tyleenleidingen'), normalizeName('PE - Tyleenleidingen'));
  assert.strictEqual(placeIn(DEFAULT_TREE, ['Tyleen & koppelingen', 'Eindkap tyleenkoppeling']).node.slug, 'eindkap-tyleen', 'de diepste categorie wint');
});

test('catalogus: product in de diepste categorie, tellingen inclusief subcategorieën', () => {
  const catalog = buildCatalog([
    row('A', ['Tyleen & koppelingen', 'Tyleen koppelingen', 'Eindkap tyleenkoppeling']),
    row('B', ['Eindkap tyleenkoppeling']),
    row('C', ['Tyleen & koppelingen']),
    row('D', ['Beregening']),
    row('E', ['Beregening oud']),
    row('F', ['Iets anders']),
  ]);
  const tyleen = catalog.categories.find((category) => category.slug === 'tyleen-en-koppelingen');
  assert.strictEqual(tyleen.count, 3, 'telt de subcategorieën mee');
  assert.strictEqual(tyleen.ownCount, 1);
  assert.strictEqual(tyleen.depth, 1);
  assert.strictEqual(tyleen.parentSlug, '');
  assert.deepStrictEqual(tyleen.children.map((child) => child.slug), ['tyleenkoppelingen']);
  const eindkap = catalog.categories.find((category) => category.slug === 'eindkap-tyleen');
  assert.strictEqual(eindkap.count, 2);
  assert.strictEqual(eindkap.parentSlug, 'tyleenkoppelingen');
  assert.strictEqual(eindkap.depth, 3);
  assert.strictEqual(catalog.products.find((product) => product.code === 'A').categorySlug, 'eindkap-tyleen');
  assert.ok(!catalog.categories.some((category) => category.slug === 'binnendraad-tyleenkoppeling'), 'lege categorieën ontbreken');
  const leidingen = catalog.groups.find((group) => group.slug === 'leidingen-toebehoren');
  assert.match(leidingen.intro, /^Ontdek ons ruime leidingen en slangen assortiment/);
  assert.deepStrictEqual(leidingen.categories.map((category) => category.name), ['Tyleen & koppelingen']);
  const beregening = catalog.groups.find((group) => group.slug === 'beregening');
  assert.deepStrictEqual(beregening.categories.map((category) => category.name).sort(), ['Beregening oud', 'Overig'], 'alleen de hoofdcategorie genoemd: Overig');
  assert.strictEqual(beregening.categories.find((category) => category.name === 'Beregening oud').hidden, true);
  assert.ok(catalog.groups.find((group) => group.slug === 'overig'), 'onbekende categorie blijft een losse categorie');
});

test('webshop: koppen zonder link, flyouts per niveau en categoriepagina', async () => {
  const items = [
    ['E1', ['Tyleen & koppelingen', 'Tyleen koppelingen', 'Eindkap tyleenkoppeling'], 5],
    ['E2', ['Eindkap tyleenkoppeling'], 15],
    ['E3', ['Eindkap tyleenkoppeling'], 25],
    ['P1', ['Pop-up sproeiers'], 8],
  ];
  const { anonymous } = await setup(items);
  const home = (await anonymous.get('/')).text;
  assert.ok(!/<a [^>]*href="groep\/[^"]*"[^>]*>(Leidingen|Beregening)/.test(home.split('<main')[0]), 'koppen in het menu zijn geen link');
  const nav = home.split('<main')[0];
  assert.match(nav, /<span class="nav-heading" tabindex="0">Leidingen &amp; toebehoren<\/span><ul class="nav-drop">/);
  assert.match(nav, /<li class="has-sub"><a href="categorie\/tyleen-en-koppelingen\/">Tyleen &amp; koppelingen<\/a><ul class="nav-drop nav-fly">/, 'flyout bij een categorie met subcategorieën');
  assert.match(nav, /<li class="has-sub"><a href="categorie\/tyleenkoppelingen\/">Tyleen koppelingen<\/a><ul class="nav-drop nav-fly"><li><a href="categorie\/eindkap-tyleen\/">Eindkap tyleenkoppeling<\/a><\/li>/, 'tweede flyout');
  assert.match(nav, /<summary>Tyleen &amp; koppelingen<\/summary>/, 'ingeklapte niveaus in het smalle menu');
  assert.ok(!/Beregening oud/.test(nav), 'verborgen categorie niet in het menu');

  const group = await anonymous.get('/groep/leidingen-toebehoren/');
  assert.strictEqual(group.status, 200);
  assert.match(group.text, /<h1>Leidingen &amp; toebehoren<\/h1>/);
  assert.match(group.text, /Ontdek ons ruime leidingen en slangen assortiment/);
  assert.match(group.text, /class="cat-block" href="..\/..\/categorie\/tyleen-en-koppelingen\/"/);
  assert.match(group.text, />3 producten</);
  assert.match(group.text, /<h2>Categorie<\/h2>/);

  const category = await anonymous.get('/categorie/eindkap-tyleen/');
  assert.strictEqual(category.status, 200);
  assert.match(category.text, /Shop<\/a> › <a href="..\/..\/groep\/leidingen-toebehoren\/">Leidingen &amp; toebehoren<\/a> › <a href="..\/..\/categorie\/tyleen-en-koppelingen\/">Tyleen &amp; koppelingen<\/a> › <a href="..\/..\/categorie\/tyleenkoppelingen\/">Tyleen koppelingen<\/a> › <span>Eindkap tyleenkoppeling<\/span>/);
  assert.match(category.text, /<h2>Prijs<\/h2>/);
  assert.match(category.text, /Resultaat 1–3 van de 3 resultaten/);
  assert.match(category.text, /aria-current="page">Eindkap tyleenkoppeling/, 'huidige categorie in de zijbalk');
  assert.ok(!category.text.includes('cat-blocks'), 'een categorie zonder subcategorieën heeft geen blokken');

  const parent = await anonymous.get('/categorie/tyleenkoppelingen/');
  assert.match(parent.text, /class="cat-block" href="..\/..\/categorie\/eindkap-tyleen\/"/);
  assert.match(parent.text, /Eindkap tyleenkoppeling<\/strong><span>3 producten/);
  assert.ok(!/class="product-card"/.test(parent.text), 'geen producten rechtstreeks in de categorie');

  const filtered = await anonymous.get('/categorie/eindkap-tyleen/?min=10&max=20');
  assert.match(filtered.text, /Resultaat 1–1 van de 1 resultaat/);
  assert.match(filtered.text, /Artikel E2/);
  assert.ok(!filtered.text.includes('Artikel E1'));
  const cheapFirst = (await anonymous.get('/categorie/eindkap-tyleen/?sorteer=prijs-hoog')).text;
  assert.ok(cheapFirst.indexOf('Artikel E3') < cheapFirst.indexOf('Artikel E1'), 'prijs hoog - laag');
  assert.strictEqual((await anonymous.get('/categorie/eindkap-tyleen/?min=abc&pagina=999&sorteer=x')).status, 200);
  assert.strictEqual((await anonymous.get('/categorie/bestaat-niet/')).status, 404);
});

test('webshop: lange lijsten staan op meerdere pagina\'s', async () => {
  const { anonymous } = await setup(Array.from({ length: 30 }, (_, index) => [`K${index}`, ['Eindkap tyleenkoppeling'], 1 + index]));
  const first = (await anonymous.get('/categorie/eindkap-tyleen/')).text;
  assert.match(first, /Resultaat 1–24 van de 30 resultaten/);
  assert.match(first, /<nav class="pager"/);
  const second = (await anonymous.get('/categorie/eindkap-tyleen/?pagina=2')).text;
  assert.match(second, /Resultaat 25–30 van de 30 resultaten/);
});
