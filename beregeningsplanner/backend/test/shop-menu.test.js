// Menuboom van de webshop aanpassen (1.7.0): saneren van de boom, concept/publiceren,
// voorbeeld, hernoemen zonder de indeling te breken, niet-ingedeelde categorieën en rechten.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { normalizeTree } = require('../src/webshop/shop-content');
const { DEFAULT_TREE } = require('../src/webshop/category-tree');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, klant en een webshop met twee producten.
 * @returns {Promise<object>} admin, customer en anonymous.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'jan.klant', displayName: 'Jan', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: 'f'.repeat(64), db }));
  servers.push(server);
  const login = createLogin(base, { password: PW });
  const admin = await login('baas');
  assert.strictEqual((await admin.put('/app/api/admin/settings', { storefront: true })).status, 200);
  const items = [['E1', ['Eindkap tyleenkoppeling']], ['X1', ['Iets nieuws']]];
  for (const [index, [code, categories]] of items.entries()) {
    assert.strictEqual((await admin.post('/app/api/stock/items', { code, name: `Artikel ${code}`, onHand: 5, salePrice: 10 })).status, 201);
    db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(main, String(index + 1), code, '', JSON.stringify(categories));
    db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND code = ?').run(String(index + 1), main, code);
  }
  return { admin, customer: await login('jan.klant'), anonymous: createClient(base) };
}

/**
 * Een kopie van de standaardboom waarin één categorie is hernoemd.
 * @param {string} slug De slug van de categorie.
 * @param {string} name De nieuwe naam.
 * @returns {object[]} De boom.
 */
function renamed(slug, name) {
  const tree = JSON.parse(JSON.stringify(DEFAULT_TREE));
  /**
   * Zoekt de categorie en hernoemt haar.
   * @param {object} node De knoop.
   * @returns {void}
   */
  const visit = (node) => { if (node.slug === slug) { node.match = [node.name]; node.name = name; } (node.children || []).forEach(visit); };
  tree.forEach(visit);
  return tree;
}

test('menu-editor: een nieuwe categorie en een toegevoegde losse categorie krijgen de juiste indeling', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/beheer/webshop-menu.js'), 'utf8');
  const addLine = source.split('\n').find((line) => line.includes("action === 'add'"));
  assert.ok(addLine && !addLine.includes('entry'), "de knop + gebruikt geen variabele 'entry' (die bestaat in change() niet)");
  assert.ok(addLine.includes('match: []'), 'een nieuwe categorie begint zonder indeling');
  const placeLine = source.split('\n').find((line) => line.includes('heading.children.push'));
  assert.ok(placeLine.includes('match: [entry.name]'), 'een toegevoegde losse categorie houdt zijn webshopnaam als indeling');
});

test('catalogus: de volgorde uit de menuboom blijft staan (niet alfabetisch)', () => {
  const { buildCatalog } = require('../src/webshop/storefront-data');
  const tree = normalizeTree([{ group: 'beregening', name: 'Beregening', children: [{ name: 'Zeta', match: ['Zeta'] }, { name: 'Alfa', match: ['Alfa'] }] }], []);
  /**
   * Maakt een artikelrij voor de catalogus.
   * @param {string} id Het id.
   * @param {string} category De webshopcategorie.
   * @returns {object} De rij.
   */
  const row = (id, category) => ({ id, code: `C${id}`, name: `Artikel ${id}`, unit: 'stuk', on_hand: 5, stock_managed: 1, sale_price: 10, vat_rate: 21, categories: JSON.stringify([category]) });
  const catalog = buildCatalog([row('1', 'Alfa'), row('2', 'Zeta')], new Map(), tree);
  const group = catalog.groups.find((entry) => entry.slug === 'beregening');
  assert.deepStrictEqual(group.categories.map((category) => category.name), ['Zeta', 'Alfa']);
});

test('normalizeTree: grens van 600 telt de koppen niet mee en weigert in plaats van in te korten', () => {
  /**
   * Maakt een lijst met genummerde categorieën.
   * @param {number} count Aantal categorieën.
   * @returns {object[]} De categorieën.
   */
  const many = (count) => Array.from({ length: count }, (_, index) => ({ name: `Cat ${index}` }));
  const full = normalizeTree([{ group: 'beregening', name: 'A', children: many(599) }, { group: 'elektra', name: 'B', children: many(1) }], [], { strict: true });
  assert.strictEqual(full.find((root) => root.group === 'beregening').children.length, 599);
  assert.ok(full.find((root) => root.group === 'elektra').children.length === 1, 'latere groepen vallen niet weg');
  assert.throws(() => normalizeTree([{ group: 'beregening', name: 'A', children: many(601) }], [], { strict: true }), (error) => error.code === 'tree_too_large');
});

test('normalizeTree: lange namen krijgen toch unieke adressen binnen 60 tekens', () => {
  const longName = 'x'.repeat(100);
  const tree = normalizeTree([{ group: 'beregening', name: 'A', children: [{ name: longName }, { name: longName }, { name: longName }] }]);
  const slugs = tree.find((root) => root.group === 'beregening').children.map((node) => node.slug);
  assert.strictEqual(new Set(slugs).size, 3);
  assert.ok(slugs.every((slug) => slug.length <= 60));
});

test('normalizeTree: vaste koppen, unieke adressen, grenzen en geen rommel', () => {
  const tree = normalizeTree([
    { group: 'beregening', name: '  Sproeiers  ', children: [{ name: 'Nieuw', children: [{ name: 'Nieuw' }] }, { name: 'Met adres', slug: 'Bad Slug!' }, { name: '' }] },
    { group: 'bestaat-niet', name: 'Vreemd' },
  ]);
  assert.deepStrictEqual(tree.map((root) => root.group), ['beregening', 'elektra', 'pomp-techniek', 'leidingen-toebehoren'].filter((group) => tree.some((root) => root.group === group)));
  const root = tree.find((entry) => entry.group === 'beregening');
  assert.strictEqual(root.name, 'Sproeiers');
  assert.strictEqual(root.children.length, 2, 'een categorie zonder naam valt weg');
  const slugs = [];
  /**
   * Verzamelt de adressen van een categorie en haar kinderen.
   * @param {object} node De knoop.
   * @returns {void}
   */
  const collect = (node) => { slugs.push(node.slug); (node.children || []).forEach(collect); };
  tree.forEach((root) => (root.children || []).forEach(collect));
  assert.strictEqual(new Set(slugs).size, slugs.length, 'adressen uniek');
  assert.ok(slugs.every((slug) => /^[a-z0-9_-]{1,60}$/.test(slug)));
  assert.ok(!tree.some((entry) => entry.name === 'Vreemd'));
});

test('menuboom: concept is alleen een voorbeeld, publiceren zet hem live, hernoemen houdt de indeling', async () => {
  const { admin, anonymous } = await setup();
  const first = await admin.get('/app/api/admin/shop-content');
  assert.strictEqual(first.body.menu.isDefault, true);
  assert.ok(first.body.defaults.menu.roots.length >= 4);
  assert.deepStrictEqual(first.body.unplaced.map((entry) => entry.name), ['Iets nieuws']);

  const roots = renamed('eindkap-tyleen', 'Eindkappen');
  const saved = await admin.put('/app/api/admin/shop-content/menu', { roots });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(!(await anonymous.get('/')).text.includes('Eindkappen'), 'concept is niet live');
  const preview = await admin.get('/?voorbeeld=1');
  assert.ok(preview.text.includes('Eindkappen'), 'voorbeeld toont het concept');
  assert.match(preview.text, /href="categorie\/eindkap-tyleen\/\?voorbeeld=1"/, 'links in het voorbeeld blijven in het voorbeeld');
  assert.match(preview.text, /<form class="shop-search"[^>]*><input type="hidden" name="voorbeeld" value="1">/, 'zoeken houdt het voorbeeld vast');
  assert.doesNotMatch((await admin.get('/')).text, /voorbeeld=1/);
  assert.doesNotMatch(preview.text, /nav-flip/, 'submenu\'s klappen standaard naar rechts');
  assert.match(preview.text, /src="assets\/menu\.js/);
  assert.strictEqual((await admin.get('/assets/menu.js')).status, 200);
  assert.ok(!(await anonymous.get('/?voorbeeld=1')).text.includes('Eindkappen'), 'bezoeker ziet nooit het voorbeeld');

  assert.strictEqual((await admin.post('/app/api/admin/shop-content/menu/publish', {})).status, 200);
  const live = (await anonymous.get('/')).text;
  assert.ok(live.includes('Eindkappen'));
  assert.strictEqual((await anonymous.get('/categorie/eindkap-tyleen/')).status, 200, 'adres blijft gelijk');
  assert.ok((await anonymous.get('/categorie/eindkap-tyleen/')).text.includes('Artikel E1'), 'product blijft in de categorie');

  assert.strictEqual((await admin.put('/app/api/admin/shop-content/menu', { roots: renamed('eindkap-tyleen', 'Kapjes') })).status, 200);
  assert.strictEqual((await admin.post('/app/api/admin/shop-content/menu/publish', {})).status, 200);
  assert.ok((await anonymous.get('/')).text.includes('Kapjes'));
  assert.strictEqual((await admin.post('/app/api/admin/shop-content/menu/revert', {})).status, 200);
  const back = (await anonymous.get('/')).text;
  assert.ok(back.includes('Eindkappen') && !back.includes('Kapjes'), 'vorige versie terug');
});

test('menuboom: concept weggooien en rechten', async () => {
  const { admin, customer, anonymous } = await setup();
  assert.strictEqual((await admin.put('/app/api/admin/shop-content/menu', { roots: renamed('eindkap-tyleen', 'Eindkappen') })).status, 200);
  const discarded = await admin.post('/app/api/admin/shop-content/menu/discard', {});
  assert.strictEqual(discarded.status, 200);
  assert.strictEqual(discarded.body.menu.hasDraft, false);
  const tooMany = await admin.put('/app/api/admin/shop-content/menu', { roots: [{ group: 'beregening', name: 'A', children: Array.from({ length: 601 }, (_, index) => ({ name: `Cat ${index}` })) }] });
  assert.strictEqual(tooMany.status, 400, 'te grote boom wordt geweigerd');
  assert.strictEqual(tooMany.body.error, 'tree_too_large');
  const nameless = await admin.put('/app/api/admin/shop-content/menu', { roots: [{ group: 'beregening', name: 'A', children: [{ name: '  ', children: [{ name: 'Kind' }] }] }] });
  assert.strictEqual(nameless.status, 400, 'categorie zonder naam wordt geweigerd in plaats van stil verwijderd');
  assert.strictEqual(nameless.body.error, 'invalid_name');
  for (const [client, expected] of [[customer, 403], [anonymous, 401]]) {
    assert.strictEqual((await client.put('/app/api/admin/shop-content/menu', { roots: [] })).status, expected);
    for (const action of ['publish', 'discard', 'revert']) {
      assert.strictEqual((await client.post(`/app/api/admin/shop-content/menu/${action}`, {})).status, expected);
    }
  }
});

/**
 * Regressietest: een aangeleverde kop met lege naam laat de kop uit de basis (de gepubliceerde) staan.
 */
test('menuboom: een lege koptekst laat de gepubliceerde kop staan', () => {
  const base = normalizeTree([{ group: 'beregening', name: 'Eigen kop', children: [] }], []);
  const result = normalizeTree([{ group: 'beregening', name: '   ', children: [] }], base);
  assert.equal(result.find((root) => root.group === 'beregening').name, 'Eigen kop');
});

/**
 * Bronnencontrole: een hernoemde kop (ook een hoofdcategorie) onthoudt zijn oude naam in `match`, en de editor meldt niet-opgeslagen wijzigingen.
 */
test('menu-editor: hernoemen van een kop houdt de indeling en wijzigingen worden herkend', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/beheer/webshop-menu.js'), 'utf8');
  assert.ok(!/path\.length > 1 && !node\.match\.length/.test(source), 'ook een kop krijgt zijn oude naam als match');
  assert.ok(source.includes('hasChanges'), 'editor meldt niet-opgeslagen wijzigingen');
});
