// Menuboom van de webshop aanpassen (1.7.0): saneren van de boom, concept/publiceren,
// voorbeeld, hernoemen zonder de indeling te breken, niet-ingedeelde categorieën en rechten.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
  roots[0].children.push({ name: 'Alleen concept', slug: 'alleen-concept', match: ['Iets nieuws'] });
  const saved = await admin.put('/api/admin/shop-content/menu', { roots });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(!(await anonymous.get('/winkel/')).text.includes('Eindkappen'), 'concept is niet live');
  const preview = await admin.get('/winkel/?voorbeeld=1');
  assert.ok(preview.text.includes('Eindkappen'), 'voorbeeld toont het concept');
  assert.strictEqual((await anonymous.get('/winkel/categorie/alleen-concept/')).status, 404);
  assert.match(preview.text, /href="categorie\/alleen-concept\/\?voorbeeld=1"/);
  assert.strictEqual((await admin.get('/winkel/categorie/alleen-concept/?voorbeeld=1')).status, 200);
  assert.match(preview.text, /href="groep\/beregening\/\?voorbeeld=1"/);
  const links = [...preview.text.matchAll(/href="(categorie\/eindkap-tyleen\/[^"]*)"/g)];
  assert.ok(links.length >= 3, 'desktopmenu, zoekmenu en mobiel menu');
  for (const [, href] of links) {
    assert.strictEqual(href, 'categorie/eindkap-tyleen/?voorbeeld=1');
    assert.ok((await admin.get(`/winkel/${href}`)).text.includes('Eindkappen'));
  }
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
  for (const client of [customer, anonymous]) {
    const expected = client === customer ? 403 : 401;
    assert.strictEqual((await client.put('/api/admin/shop-content/menu', { roots: [] })).status, expected);
    for (const action of ['publish', 'discard', 'revert']) {
      assert.strictEqual((await client.post(`/api/admin/shop-content/menu/${action}`, {})).status, expected);
    }
  }
});


test('menu-editor neemt na elke opslag de genormaliseerde boom over en behoudt schermvlaggen', async () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/beheer/webshop-menu.js'), 'utf8'), { window });
  const roots = [{ group: 'beregening', name: 'Beregening', children: [{ name: '  Kapjes  ', slug: 'kapjes', children: [{ name: 'Nieuw', slug: '' }, { name: '', slug: '' }] }] }];
  let view = { menu: { draft: { roots } }, defaults: { menu: { roots } }, assets: [], images: [] };
  const sent = [];
  const errorBox = { textContent: '' };
  const host = { innerHTML: '', querySelector: () => errorBox };
  /**
   * Neemt het antwoord over zoals het beheerscherm dat doet.
   * @param {object} response De nieuwe serverstand.
   * @returns {void}
   */
  const adopt = (response) => { view = response; };
  /**
   * Geeft de overgenomen serverstand terug aan de editor.
   * @returns {object} De huidige stand.
   */
  adopt.current = () => view;
  window.BeheerWebshopMenu.mount(host, {
    view, adopt, toast: () => {},
    api: async (_, options) => {
      sent.push(JSON.parse(JSON.stringify(options.body.roots)));
      return { ...view, menu: { draft: { roots: normalizeTree(options.body.roots) } } };
    },
  });
  /**
   * Bedient een knop via de publieke klikafhandeling van de editor.
   * @param {string} action De knopactie.
   * @param {string} nodePath Het indexpad van de categorie.
   * @returns {Promise<void>} Afgeronde klik.
   */
  const click = (action, nodePath = '0.0') => host.onclick({ target: { closest: () => ({ dataset: { m: action }, closest: () => ({ dataset: { path: nodePath } }) }) } });
  await click('fold');
  await click('detail');
  await click('save');
  assert.strictEqual(errorBox.textContent, '');
  assert.match(host.innerHTML, /value="Kapjes"/);
  assert.doesNotMatch(host.innerHTML, /value="  Kapjes  "/);
  assert.match(host.innerHTML, /class="btn small primary" data-m="detail" aria-expanded="true"/);
  assert.match(host.innerHTML, /value="Nieuw"/, 'opengevouwen kinderen blijven zichtbaar');
  await click('save');
  assert.strictEqual(errorBox.textContent, '');
  assert.strictEqual(sent[1][0].children[0].name, 'Kapjes');
  assert.strictEqual(sent[1][0].children[0].children.length, 1, 'lege knoop is verwijderd');
  assert.ok(sent[1][0].children[0].children[0].slug, 'gegenereerd adres wordt opnieuw verstuurd');
});
