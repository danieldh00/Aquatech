// Eigen webshop (alleen lezen): openbare pagina's op winkel/ voor artikelen uit
// de voorraad, uit tot de instelling aan staat, zonder interne gegevens.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { buildCatalog, slugify, groupOf } = require('../src/webshop/storefront-data');
const { decodeHtmlEntities } = require('../src/webshop/html-entities');
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
  assert.deepStrictEqual(catalog.products.map((product) => product.slug), ['sproeier-a', 'sproeier-b']);
  const longName = 'A'.repeat(76);
  const longSlugs = buildCatalog([
    { code: 'SPR-1', name: longName, unit: 'st', on_hand: 1, sale_price: 10, vat_rate: 21, categories: '[]', image: '' },
    { code: 'SPR-2', name: longName, unit: 'st', on_hand: 1, sale_price: 10, vat_rate: 21, categories: '[]', image: '' },
  ]).products.map((product) => product.slug);
  assert.ok(longSlugs[0].endsWith('-spr-1') && longSlugs[1].endsWith('-spr-2'), 'code blijft buiten de afkapping');
  assert.ok(longSlugs.every((slug) => slug.length <= 80));
  assert.strictEqual(catalog.products[0].priceIncl, 12.1);
  assert.strictEqual(catalog.products[1].priceIncl, 21.8);
  assert.strictEqual(catalog.products[1].categoryName, 'Overig');
  assert.strictEqual(catalog.products[1].image, '');
  assert.strictEqual(catalog.products[0].image, 'https://x.nl/a.jpg');
  assert.strictEqual(catalog.categories.length, 2);
  catalog.categories.forEach((category, index) => assert.match(category.slug, [/^overig-[0-9a-f]{6}$/, /^sproeiers-[0-9a-f]{6}$/][index]));
  const clash = buildCatalog([
    { code: 'C', name: 'x', on_hand: 1, reserved: 1, sale_price: 1, vat_rate: 21, categories: '["Tuin & huis"]' },
    { code: 'D', name: 'y', on_hand: 3, reserved: 1, sale_price: 1, vat_rate: 21, categories: '["Tuin en huis"]' },
  ]);
  assert.strictEqual(new Set(clash.categories.map((category) => category.slug)).size, 2);
  assert.ok(clash.categories.every((category) => /^tuin-en-huis-[0-9a-f]{6}$/.test(category.slug)));
  const reversed = buildCatalog([
    { code: 'D', name: 'y', on_hand: 3, reserved: 1, sale_price: 1, vat_rate: 21, categories: '["Tuin en huis"]' },
    { code: 'C', name: 'x', on_hand: 1, reserved: 1, sale_price: 1, vat_rate: 21, categories: '["Tuin & huis"]' },
  ]);
  /**
   * De slug van een categorie op naam.
   * @param {object} catalog De catalogus.
   * @param {string} name De categorienaam.
   * @returns {string} De slug.
   */
  const slugOf = (catalog, name) => catalog.categories.find((category) => category.name === name).slug;
  assert.strictEqual(slugOf(clash, 'Tuin & huis'), slugOf(reversed, 'Tuin & huis'), 'slug onafhankelijk van volgorde');
  const single = buildCatalog([{ code: 'C', name: 'x', on_hand: 1, sale_price: 1, vat_rate: 21, categories: '["Tuin & huis"]' }]);
  assert.strictEqual(slugOf(single, 'Tuin & huis'), slugOf(clash, 'Tuin & huis'), 'slug blijft gelijk na catalogusgroei');
  assert.strictEqual(buildCatalog([{ code: 'E', name: 'z', on_hand: 0.8, reserved: 0.8000000001, sale_price: 1, vat_rate: 21, categories: '[]' }]).products[0].inStock, false);
  assert.deepStrictEqual(clash.products.map((product) => product.inStock), [false, true], 'beschikbaar = stand min reserveringen');
});

test('webshop staat standaard uit en dan is niets bereikbaar', async () => {
  const { anonymous } = await setup();
  for (const urlPath of ['/winkel/', '/winkel/product/pe-buis-25-mm-buis-25/', '/winkel/assets/winkel.css']) {
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
  assert.match(home.text, /product\/pe-buis-25-mm-buis-25\//);
  assert.ok(!home.text.includes('Alleen intern') && !home.text.includes('Niet naar de shop'));
  assert.match(home.headers.get('content-security-policy'), /default-src 'none'/);
  assert.ok(!/<script/i.test(home.text));

  const categorySlug = home.text.match(/href="categorie\/(leidingen-[0-9a-f]{6})\//)[1];
  const category = await anonymous.get(`/winkel/categorie/${categorySlug}/`);
  assert.strictEqual(category.status, 200);
  assert.match(category.text, /PE buis 25 mm/);

  const product = await anonymous.get('/winkel/product/pe-buis-25-mm-buis-25/');
  assert.strictEqual(product.status, 200);
  assert.match(product.text, /€ 1,82/);
  assert.match(product.text, /Op voorraad/);
  assert.match(product.text, /https:\/\/shop\.test\/buis\.jpg/);
  assert.match(product.text, /Artikelnummer: BUIS-25/);

  const spr = await anonymous.get('/winkel/product/sproeier-b-pro-b-spr-1/');
  assert.strictEqual(spr.status, 200);
  assert.ok(!/GEHEIM|Magazijn A|4,5/.test(spr.text), 'geen interne gegevens');
  assert.match(spr.text, /&lt;b&gt;Pro&lt;\/b&gt;|Sproeier/);
  assert.ok(!spr.text.includes('<b>Pro</b>'), 'HTML in namen wordt ontsnapt');
});

test('webshop: assets, doorverwijzing, 404 en alleen lezen', async () => {
  const { base, admin, anonymous } = await setup();
  await admin.put('/api/admin/settings', { storefront: true });
  const noSlash = await createClient(base, { followRedirects: false }).get('/winkel/product/pe-buis-25-mm-buis-25');
  assert.strictEqual(noSlash.status, 302);
  assert.strictEqual(noSlash.location, 'pe-buis-25-mm-buis-25/');
  const root = await createClient(base, { followRedirects: false }).get('/winkel');
  assert.strictEqual(root.status, 302);
  assert.strictEqual(root.location, 'winkel/');

  assert.strictEqual((await anonymous.get('/winkel/assets/winkel.css')).status, 200);
  assert.strictEqual((await anonymous.get('/winkel/assets/brand.css')).status, 200);
  assert.strictEqual((await anonymous.get('/winkel/assets/aquatechshop-logo.png')).status, 200);
  assert.strictEqual((await anonymous.get('/winkel/assets/favicon.png')).status, 200);
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

test('webshop-instelling alleen in de hoofdtenant', async () => {
  const { base, db, admin } = await setup();
  assert.strictEqual((await admin.get('/api/admin/settings')).body.storefrontAllowed, true);
  const store = createStore(db);
  const groen = store.createTenant({ name: 'Groen', slug: 'groen' }).tenant.id;
  await store.createAccount(groen, { username: 'tuinman', displayName: 'Tuinman', role: 'beheerder', password: PW });
  const other = await createLogin(base, { password: PW })('tuinman', 'groen');
  const view = await other.get('/api/admin/settings');
  assert.strictEqual(view.body.storefrontAllowed, false);
  assert.ok(!('storefront' in view.body.settings), 'veld niet in de response van andere tenants');
  const refused = await other.put('/api/admin/settings', { storefront: true });
  assert.strictEqual(refused.status, 400);
  assert.strictEqual(refused.body.field, 'storefront');
  const saved = await other.put('/api/admin/settings', { drawingRequests: false });
  assert.strictEqual(saved.status, 200);
  assert.ok(!('storefront' in saved.body.settings), 'veld ook niet in de PUT-response');
  assert.strictEqual((await admin.put('/api/admin/settings', { storefront: true })).status, 200);
});

test('HTML-tekens in namen worden gelezen, niet dubbel getoond', () => {
  assert.strictEqual(decodeHtmlEntities('Leidingen &amp; Slangen'), 'Leidingen & Slangen');
  assert.strictEqual(decodeHtmlEntities('4&#8243; pomp &#x2013; DAB &eacute;'), '4″ pomp – DAB é');
  assert.strictEqual(decodeHtmlEntities('Rain Bird&reg; &AMP; Co &Eacute;'), 'Rain Bird® & Co É');
  assert.strictEqual(decodeHtmlEntities('&onbekend; &#99999999; 5 &lt; 6'), '&onbekend; &#99999999; 5 < 6');
  const catalog = buildCatalog([{ code: 'K', name: 'Kraan &amp; koppeling', unit: 'st', on_hand: 1, sale_price: 1, vat_rate: 21, categories: '["(kogel) kranen &amp; toebehoren"]' }]);
  assert.strictEqual(catalog.categories[0].name, '(kogel) kranen & toebehoren');
  assert.strictEqual(catalog.products[0].name, 'Kraan & koppeling');
});

test('categorieën worden in hoofdcategorieën gegroepeerd', () => {
  const expected = {
    'Pop-up sproeiers': 'beregening', 'Druppelslang insteek koppelingen': 'beregening', 'Beregeningscomputers & regensensors': 'beregening',
    'Elektra': 'elektra', '4" Franklin Electric bronpomp motoren': 'pomp-techniek', 'Expansievaten & toebehoren': 'pomp-techniek',
    'Unidelta knie binnendraad tyleen koppeling': 'leidingen-toebehoren', '(kogel) kranen & toebehoren': 'leidingen-toebehoren',
    'Leidingen & Slangen': 'leidingen-toebehoren', 'Iets anders': 'overig',
  };
  for (const [name, slug] of Object.entries(expected)) assert.strictEqual(groupOf(name).slug, slug, name);
  const catalog = buildCatalog([
    { code: 'A', name: 'Sproeier', on_hand: 1, sale_price: 1, vat_rate: 21, categories: '["Pop-up sproeiers"]', image: 'https://x.nl/a.jpg' },
    { code: 'B', name: 'Pomp', on_hand: 1, sale_price: 1, vat_rate: 21, categories: '["Dompelpompen"]', image: 'https://x.nl/b.jpg' },
    { code: 'C', name: 'Zonder foto', on_hand: 1, sale_price: 1, vat_rate: 21, categories: '["Dompelpompen"]' },
    { code: 'D', name: 'Leeg', on_hand: 0, sale_price: 1, vat_rate: 21, categories: '["Elektra"]', image: 'https://x.nl/d.jpg' },
  ]);
  assert.deepStrictEqual(catalog.groups.map((group) => group.slug), ['beregening', 'elektra', 'pomp-techniek']);
  assert.strictEqual(catalog.groups.find((group) => group.slug === 'pomp-techniek').count, 2);
  assert.deepStrictEqual(catalog.featured.map((product) => product.code), ['B', 'A'], 'alleen met foto en op voorraad, om en om per groep');
});

test('webshop: hoofdcategorie, zoeken, kop en voet', async () => {
  const { db, anonymous, admin, main } = await setup();
  await admin.put('/api/admin/settings', { storefront: true });
  db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(main, '77', 'x', 'https://shop.test/buis.jpg', '["Leidingen &amp; Slangen"]');
  db.prepare("UPDATE stock_items SET shop_product_id = '77' WHERE tenant_id = ? AND code = 'BUIS-25'").run(main);

  const home = await anonymous.get('/winkel/');
  assert.match(home.text, /assets\/aquatechshop-logo\.png/);
  assert.match(home.text, /rel="icon"/);
  assert.match(home.text, /action="zoeken\/"/);
  assert.match(home.text, /Leidingen &amp; Slangen/);
  assert.ok(!home.text.includes('&amp;amp;'), 'geen dubbel gecodeerde tekens');
  assert.match(home.text, /Uitgelichte producten/);
  assert.match(home.text, /https:\/\/shop\.test\/buis\.jpg/);

  const group = await anonymous.get('/winkel/groep/leidingen-toebehoren/');
  assert.strictEqual(group.status, 200);
  assert.match(group.text, /Leidingen &amp; toebehoren/);
  assert.match(group.text, /Leidingen &amp; Slangen/);
  assert.strictEqual((await anonymous.get('/winkel/groep/bestaat-niet/')).status, 404);

  const found = await anonymous.get('/winkel/zoeken/?q=buis%2025');
  assert.strictEqual(found.status, 200);
  assert.match(found.text, /PE buis 25 mm/);
  assert.ok(!found.text.includes('Sproeier'), 'alleen producten die passen');
  const byCode = await anonymous.get('/winkel/zoeken/?q=spr-1');
  assert.match(byCode.text, /Sproeier/);
  assert.ok(!byCode.text.includes('Alleen intern'));
  const scripted = await anonymous.get('/winkel/zoeken/?q=%3Cscript%3Ealert(1)%3C/script%3E');
  assert.ok(!scripted.text.includes('<script>'), 'zoekterm wordt ontsnapt');
  assert.strictEqual((await anonymous.get('/winkel/zoeken/')).status, 200);
});
