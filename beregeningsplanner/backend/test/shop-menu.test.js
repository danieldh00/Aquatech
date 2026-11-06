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
  const { server, base } = await listen(createApp({ secret: 'f'.repeat(64), db }));
  servers.push(server);
  const login = createLogin(base, { password: PW });
  const admin = await login('baas');
  assert.strictEqual((await admin.put('/api/admin/settings', { storefront: true })).status, 200);
  const items = [['E1', ['Eindkap tyleenkoppeling']], ['X1', ['Iets nieuws']]];
  for (const [index, [code, categories]] of items.entries()) {
    assert.strictEqual((await admin.post('/api/stock/items', { code, name: `Artikel ${code}`, onHand: 5, salePrice: 10 })).status, 201);
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
  const first = await admin.get('/api/admin/shop-content');
  assert.strictEqual(first.body.menu.isDefault, true);
  assert.ok(first.body.defaults.menu.roots.length >= 4);
  assert.deepStrictEqual(first.body.unplaced.map((entry) => entry.name), ['Iets nieuws']);

  const roots = renamed('eindkap-tyleen', 'Eindkappen');
  const saved = await admin.put('/api/admin/shop-content/menu', { roots });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(!(await anonymous.get('/winkel/')).text.includes('Eindkappen'), 'concept is niet live');
  const preview = await admin.get('/winkel/?voorbeeld=1');
  assert.ok(preview.text.includes('Eindkappen'), 'voorbeeld toont het concept');
  assert.match(preview.text, /href="categorie\/eindkap-tyleen\/\?voorbeeld=1"/, 'links in het voorbeeld blijven in het voorbeeld');
  assert.doesNotMatch((await admin.get('/winkel/')).text, /voorbeeld=1/);
  assert.doesNotMatch(preview.text, /nav-flip/, 'submenu\'s klappen standaard naar rechts');
  assert.match(preview.text, /src="assets\/menu\.js/);
  assert.strictEqual((await admin.get('/winkel/assets/menu.js')).status, 200);
  assert.ok(!(await anonymous.get('/winkel/?voorbeeld=1')).text.includes('Eindkappen'), 'bezoeker ziet nooit het voorbeeld');

  assert.strictEqual((await admin.post('/api/admin/shop-content/menu/publish', {})).status, 200);
  const live = (await anonymous.get('/winkel/')).text;
  assert.ok(live.includes('Eindkappen'));
  assert.strictEqual((await anonymous.get('/winkel/categorie/eindkap-tyleen/')).status, 200, 'adres blijft gelijk');
  assert.ok((await anonymous.get('/winkel/categorie/eindkap-tyleen/')).text.includes('Artikel E1'), 'product blijft in de categorie');

  assert.strictEqual((await admin.put('/api/admin/shop-content/menu', { roots: renamed('eindkap-tyleen', 'Kapjes') })).status, 200);
  assert.strictEqual((await admin.post('/api/admin/shop-content/menu/publish', {})).status, 200);
  assert.ok((await anonymous.get('/winkel/')).text.includes('Kapjes'));
  assert.strictEqual((await admin.post('/api/admin/shop-content/menu/revert', {})).status, 200);
  const back = (await anonymous.get('/winkel/')).text;
  assert.ok(back.includes('Eindkappen') && !back.includes('Kapjes'), 'vorige versie terug');
});

test('menuboom: concept weggooien en rechten', async () => {
  const { admin, customer, anonymous } = await setup();
  assert.strictEqual((await admin.put('/api/admin/shop-content/menu', { roots: renamed('eindkap-tyleen', 'Eindkappen') })).status, 200);
  const discarded = await admin.post('/api/admin/shop-content/menu/discard', {});
  assert.strictEqual(discarded.status, 200);
  assert.strictEqual(discarded.body.menu.hasDraft, false);
  for (const [client, expected] of [[customer, 403], [anonymous, 401]]) {
    assert.strictEqual((await client.put('/api/admin/shop-content/menu', { roots: [] })).status, expected);
    for (const action of ['publish', 'discard', 'revert']) {
      assert.strictEqual((await client.post(`/api/admin/shop-content/menu/${action}`, {})).status, expected);
    }
  }
});
