// Voorraadmelding en "Nog N op voorraad" in de eigen webshop: tekst bij een kleine voorraad, het formulier bij een uitverkocht artikel,
// één mail zodra het weer te bestellen is, en het wissen van het adres daarna.
const test = require('node:test');
const assert = require('node:assert');
const { setup, mailsWith } = require('./helpers/webshop-world');
const { postForm } = require('./helpers/http-client');
const { stockText } = require('../src/webshop/storefront-pages');
const { createStockAlerts, MAX_PER_EMAIL } = require('../src/webshop/stock-alerts');

/**
 * Het adres van de productpagina van een testartikel (zoals het assortiment het slug maakt).
 * @param {string} code De artikelcode.
 * @returns {string} Het adres van de productpagina.
 */
const productPath = (code) => `/product/artikel-${code.toLowerCase()}-${code.toLowerCase()}/`;

/**
 * Maakt een voorraadartikel en zet het als webshopproduct in de catalogus.
 * @param {object} world De testwereld.
 * @param {string} code De artikelcode.
 * @param {number} onHand De voorraad.
 * @returns {Promise<void>} Klaar als het artikel bestaat.
 */
async function addProduct(world, code, onHand) {
  const made = await world.admin.post('/app/api/stock/items', { code, name: `Artikel ${code}`, unit: 'st', onHand, salePrice: 5, weightGrams: 100, vatRate: 21 });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const tenantId = world.db.prepare('SELECT tenant_id FROM stock_items WHERE code = ?').get(code).tenant_id;
  world.db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(tenantId, code, code, '', JSON.stringify(['Overig']));
  world.db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND code = ?').run(code, tenantId, code);
}

test('stockText: kleine voorraad toont het aantal', () => {
  assert.strictEqual(stockText(true, 3), 'Nog 3 op voorraad');
  assert.strictEqual(stockText(true, 5), 'Nog 5 op voorraad');
  assert.strictEqual(stockText(true, 6), 'Op voorraad');
  assert.strictEqual(stockText(true, null), 'Op voorraad');
  assert.strictEqual(stockText(false, 0), 'Niet op voorraad');
});

test('voorraadmelding: formulier, aanmelden, één mail bij terugkeer en adres gewist', async () => {
  const world = await setup();
  await addProduct(world, 'KLEIN', 3);
  await addProduct(world, 'LEEG', 0);
  // De catalogus onthoudt zijn gegevens 30 seconden; een kortingsinstelling geeft meteen een nieuwe catalogus.
  assert.strictEqual((await world.admin.put('/app/api/admin/category-discounts', { rules: [{ categorySlug: 'beregeningscomputers-en-regensensors', discountPct: 1 }] })).status, 200);
  const [shopper] = world.shoppers;
  const small = await shopper.client.request('GET', productPath('KLEIN'));
  assert.match(small.text, /Nog 3 op voorraad/);
  assert.doesNotMatch(small.text, /voorraadmelding/);
  const path = productPath('LEEG');
  const page = await shopper.client.request('GET', path);
  assert.match(page.text, /Niet op voorraad/);
  assert.match(page.text, /class="stock-alert"/);
  // Een geldig adres, twee keer: één rij.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const posted = await postForm(world.base, shopper.client, '/voorraadmelding/', { code: 'LEEG', email: 'Wacht@Voorbeeld.nl', website: '' });
    assert.strictEqual(posted.status, 303);
    assert.match(posted.location, /melding=ja/);
  }
  assert.strictEqual(world.db.prepare('SELECT COUNT(*) AS n FROM stock_alerts').get().n, 1);
  assert.strictEqual(world.db.prepare('SELECT email FROM stock_alerts').get().email, 'wacht@voorbeeld.nl');
  // Ongeldig adres, robot en op voorraad: niets bewaard.
  const bad = await postForm(world.base, shopper.client, '/voorraadmelding/', { code: 'LEEG', email: 'geen-adres', website: '' });
  assert.match(bad.location, /melding=fout/);
  await postForm(world.base, shopper.client, '/voorraadmelding/', { code: 'LEEG', email: 'robot@voorbeeld.nl', website: 'http://spam' });
  const inStock = await postForm(world.base, shopper.client, '/voorraadmelding/', { code: 'BUS', email: 'ander@voorbeeld.nl', website: '' });
  assert.match(inStock.location, /\.\.\/|melding=fout/);
  assert.strictEqual(world.db.prepare('SELECT COUNT(*) AS n FROM stock_alerts').get().n, 1);
  // Nog geen voorraad: geen mail.
  assert.deepStrictEqual(await world.app.locals.stockAlertsRun(), { sent: 0, purged: 0 });
  assert.strictEqual(mailsWith(world.sent, /weer op voorraad/).length, 0);
  // Voorraad komt terug: precies één mail, daarna is het adres gewist.
  const item = world.db.prepare("SELECT id FROM stock_items WHERE code = 'LEEG'").get();
  world.db.prepare('UPDATE stock_items SET on_hand = 4 WHERE id = ?').run(item.id);
  assert.deepStrictEqual(await world.app.locals.stockAlertsRun(), { sent: 1, purged: 0 });
  const mails = mailsWith(world.sent, /weer op voorraad/);
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'wacht@voorbeeld.nl');
  assert.strictEqual(world.db.prepare('SELECT COUNT(*) AS n FROM stock_alerts').get().n, 0);
  assert.deepStrictEqual(await world.app.locals.stockAlertsRun(), { sent: 0, purged: 0 });
});

test('voorraadmelding: mislukte mail blijft staan, limiet per adres, verlopen en onbekende artikelen worden gewist', async () => {
  const world = await setup();
  const tenantId = world.db.prepare('SELECT id FROM tenants ORDER BY created_at LIMIT 1').get().id;
  for (let number = 0; number <= MAX_PER_EMAIL; number += 1) {
    assert.strictEqual((await world.admin.post('/app/api/stock/items', { code: `L${number}`, name: `Leeg ${number}`, onHand: 0, salePrice: 5 })).status, 201);
  }
  const alerts = createStockAlerts(world.db);
  for (let number = 0; number < MAX_PER_EMAIL; number += 1) assert.deepStrictEqual(alerts.subscribe(tenantId, { code: `L${number}`, email: 'veel@voorbeeld.nl' }), { ok: true });
  assert.strictEqual(alerts.subscribe(tenantId, { code: `L${MAX_PER_EMAIL}`, email: 'veel@voorbeeld.nl' }).status, 429);
  assert.strictEqual(alerts.subscribe(tenantId, { code: 'BESTAATNIET', email: 'x@voorbeeld.nl' }).status, 404);
  assert.strictEqual(alerts.subscribe(tenantId, { code: 'BUS', email: 'x@voorbeeld.nl' }).status, 409);
  assert.deepStrictEqual(alerts.waitingByItem(tenantId).slice(0, 1), [{ code: 'L0', name: 'Leeg 0', waiting: 1 }]);
  // Mislukte mail: de melding blijft voor de volgende ronde.
  world.db.prepare("UPDATE stock_items SET on_hand = 2 WHERE code = 'L0'").run();
  world.mailFailing.on = true;
  assert.strictEqual((await world.app.locals.stockAlertsRun()).sent, 0);
  assert.strictEqual(alerts.due(tenantId).length, 1);
  world.mailFailing.on = false;
  assert.strictEqual((await world.app.locals.stockAlertsRun()).sent, 1);
  // Verlopen meldingen gaan weg.
  world.db.prepare("UPDATE stock_alerts SET created_at = '2000-01-01T00:00:00.000Z'").run();
  assert.strictEqual(alerts.purgeOld(tenantId), MAX_PER_EMAIL - 1);
});

test('voorraadmelding: van een andere omgeving telt niet mee', async () => {
  const world = await setup();
  const alerts = createStockAlerts(world.db);
  const other = world.db.prepare("SELECT id FROM tenants WHERE slug = 'ander'").get().id;
  assert.strictEqual(alerts.subscribe(other, { code: 'BUS', email: 'x@voorbeeld.nl' }).status, 404);
  assert.deepStrictEqual(alerts.due(other), []);
});
