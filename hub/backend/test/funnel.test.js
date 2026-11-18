// Eigen koopfunneltelling van de webshop: tellers per stap in het geheugen, wegschrijven naar de database, het overzicht per periode
// en wat niet meetelt (medewerkers, robots, voorbeelden, onbekende stappen).
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers/webshop-world');
const { postForm, createClient } = require('./helpers/http-client');
const { openDb } = require('../src/database/db');
const { createFunnel, looksLikeBot, dayOf, STEPS } = require('../src/webshop/funnel');

/**
 * Maakt een voorraadartikel en zet het als webshopproduct in de catalogus.
 * @param {object} world De testwereld.
 * @param {string} code De artikelcode.
 * @returns {Promise<string>} Het adres van de productpagina.
 */
async function addProduct(world, code) {
  const made = await world.admin.post('/app/api/stock/items', { code, name: `Artikel ${code}`, unit: 'st', onHand: 20, salePrice: 5, weightGrams: 100, vatRate: 21 });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const tenantId = world.db.prepare('SELECT tenant_id FROM stock_items WHERE code = ?').get(code).tenant_id;
  world.db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(tenantId, code, code, '', JSON.stringify(['Overig']));
  world.db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND code = ?').run(code, tenantId, code);
  // De catalogus onthoudt zijn gegevens 30 seconden; een kortingsinstelling geeft meteen een nieuwe.
  await world.admin.put('/app/api/admin/category-discounts', { rules: [{ categorySlug: 'beregening_nieuw', discountPct: 5 }] });
  return `/product/artikel-${code.toLowerCase()}-${code.toLowerCase()}/`;
}

/**
 * Maakt in een lege database een omgeving en geeft het id.
 * @param {object} db De database.
 * @returns {string} Het id van de omgeving.
 */
function tenantOf(db) {
  db.prepare("INSERT INTO tenants (id, slug, name, created_at) VALUES ('t', 'hoofd', 'Hoofd', '2026-01-01')").run();
  return 't';
}

/**
 * De totalen per stap uit het overzicht.
 * @param {object} world De testwereld.
 * @param {number} [days] Periode in dagen.
 * @returns {Promise<object>} Sleutel van de stap naar het aantal.
 */
async function totals(world, days = 30) {
  const report = await world.admin.get(`/app/api/admin/shop-funnel?days=${days}`);
  assert.strictEqual(report.status, 200);
  return Object.fromEntries([...report.body.steps, ...report.body.extra].map((step) => [step.key, step.count]));
}

test('looksLikeBot: robots en een lege User-Agent tellen niet mee', () => {
  /**
   * Een nagebootst verzoek met een User-Agent.
   * @param {string} agent De User-Agent.
   * @returns {{ get: Function }} Het verzoek.
   */
  const requestWith = (agent) => ({ get: () => agent });
  assert.strictEqual(looksLikeBot(requestWith('')), true);
  assert.strictEqual(looksLikeBot(requestWith('Googlebot/2.1 (+http://www.google.com/bot.html)')), true);
  assert.strictEqual(looksLikeBot(requestWith('Mozilla/5.0 (compatible; bingbot/2.0)')), true);
  assert.strictEqual(looksLikeBot(requestWith('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1')), false);
});

test('telling: onbekende stap telt niet, flush telt op en het overzicht rekent het aandeel van de vorige stap', () => {
  const db = openDb(':memory:');
  const funnel = createFunnel(db);
  const tenantId = tenantOf(db);
  assert.strictEqual(funnel.count(tenantId, 'onzin'), false);
  assert.strictEqual(funnel.count('', 'product'), false);
  for (let index = 0; index < 10; index += 1) funnel.count(tenantId, 'product');
  for (let index = 0; index < 4; index += 1) funnel.count(tenantId, 'cart_add');
  assert.strictEqual(funnel.flush(), 2);
  assert.strictEqual(funnel.flush(), 0, 'niets meer te schrijven');
  // Een tweede ronde telt op bij dezelfde dag.
  funnel.count(tenantId, 'product');
  funnel.flush();
  const report = funnel.report(tenantId, 7);
  const byKey = Object.fromEntries(report.steps.map((step) => [step.key, step]));
  assert.strictEqual(byKey.product.count, 11);
  assert.strictEqual(byKey.product.ofPrevious, null, 'eerste stap heeft geen vorige');
  assert.strictEqual(byKey.cart_add.ofPrevious, 36.4);
  assert.strictEqual(byKey.cart.count, 0);
  assert.strictEqual(byKey.cart.ofPrevious, 0);
  assert.strictEqual(byKey.checkout.ofPrevious, null, 'delen door nul geeft geen percentage');
  assert.strictEqual(report.steps.length, STEPS.length);
  assert.strictEqual(report.perDay.length, 1);
  assert.strictEqual(report.perDay[0].day, dayOf());
  assert.strictEqual(report.perDay[0].product, 11);
  // Een andere omgeving ziet niets, een rare periode valt terug op 30 dagen en 1 is het minimum.
  assert.strictEqual(funnel.report('andere-omgeving', 7).steps[0].count, 0);
  assert.strictEqual(funnel.report(tenantId, 'abc').days, 30);
  assert.strictEqual(funnel.report(tenantId, 0).days, 30);
  assert.strictEqual(funnel.report(tenantId, 99999).days, 366);
});

test('telling: een dag buiten de periode telt niet mee en oude dagen worden gewist', () => {
  const db = openDb(':memory:');
  const funnel = createFunnel(db);
  const tenantId = tenantOf(db);
  const insert = db.prepare('INSERT INTO shop_funnel_days (tenant_id, day, step, hits) VALUES (?, ?, ?, ?)');
  insert.run(tenantId, dayOf(new Date(Date.now() - 20 * 86400000)), 'product', 5);
  insert.run(tenantId, dayOf(new Date(Date.now() - 500 * 86400000)), 'product', 7);
  assert.strictEqual(funnel.report(tenantId, 7).steps[0].count, 0);
  assert.strictEqual(funnel.report(tenantId, 30).steps[0].count, 5);
  assert.strictEqual(funnel.purgeOld(tenantId), 1, 'alleen de dag van meer dan 400 dagen geleden');
  assert.strictEqual(funnel.report(tenantId, 366).steps[0].count, 5);
});

test('funnel in de winkel: bezoeker telt, medewerker, robot en voorbeeld niet', async () => {
  const world = await setup();
  const path = await addProduct(world, 'FUN');
  const [shopper] = world.shoppers;
  // Twee klanten hebben zich geregistreerd bij het opzetten.
  assert.strictEqual((await totals(world)).signup, 2);
  assert.strictEqual((await shopper.client.get(path)).status, 200);
  assert.strictEqual((await shopper.client.get(path)).status, 200);
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'FUN', qty: '2' });
  // Een wijziging van het aantal is geen toevoeging.
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'set', code: 'FUN', qty: '3' });
  assert.strictEqual((await shopper.client.get('/winkelwagen/')).status, 200);
  assert.strictEqual((await shopper.client.get('/afrekenen/')).status, 200);
  // Zonder wagen telt de winkelwagenpagina niet; de afrekenpagina stuurt dan terug.
  const visitor = createClient(world.base);
  await visitor.get('/winkelwagen/');
  await visitor.get('/afrekenen/');
  // Een bezoeker met wagen maar zonder account ziet de inlogmuur.
  await postForm(world.base, visitor, '/winkelwagen/', { action: 'add', code: 'FUN', qty: '1' });
  assert.strictEqual((await visitor.get('/afrekenen/')).status, 200);
  // Robot, medewerker en voorbeeld tellen niet.
  await visitor.get(path, { 'user-agent': 'Googlebot/2.1' });
  await world.admin.get(path);
  await world.admin.get(`${path}?voorbeeld=1`);
  const counted = await totals(world);
  assert.strictEqual(counted.product, 2);
  assert.strictEqual(counted.cart_add, 2, 'twee toevoegingen (klant en bezoeker), de aantalwijziging telt niet');
  assert.strictEqual(counted.cart, 1);
  assert.strictEqual(counted.checkout, 1);
  assert.strictEqual(counted.checkout_login, 1);
  assert.strictEqual(counted.order, 0);
  assert.strictEqual(counted.paid, 0);
});

test('funnel in de winkel: een bestelling telt als bestelling en alleen beheerders zien het overzicht', async () => {
  const world = await setup();
  const [shopper, other] = world.shoppers;
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '2' });
  const placed = await postForm(world.base, shopper.client, '/afrekenen/', { name: 'Els Bakker', email: 'els@bakker.example', phone: '', street: 'Tuinstraat 1', postcode: '8071 AB', city: 'Nunspeet', note: '', shippingMethod: 'ophalen', country: 'NL', action: 'place', payment: 'rekening' });
  assert.ok([200, 303].includes(placed.status), `status ${placed.status}`);
  const counted = await totals(world);
  assert.strictEqual(counted.order, world.db.prepare('SELECT COUNT(*) AS n FROM web_orders').get().n);
  // Een klant en een bezoeker krijgen het overzicht niet.
  assert.ok([401, 403].includes((await other.client.get('/app/api/admin/shop-funnel')).status));
  assert.ok([401, 403].includes((await createClient(world.base).get('/app/api/admin/shop-funnel')).status));
  // De tellers staan na het opvragen in de database.
  assert.ok(world.db.prepare('SELECT COUNT(*) AS n FROM shop_funnel_days').get().n > 0);
});
