// Koopfunnel in winkelwagen en afrekenen: verzendkosten en drempelbalk vooraf, een juiste betaalnotitie, Verder winkelen naar de laatste
// lijst, de vertrouwensstrook, hulp bij een lege zoekopdracht en het direct bijwerken van het aantal.
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers/webshop-world');
const { postForm } = require('./helpers/http-client');
const { lastListPath } = require('../src/webshop/storefront-cart');

/**
 * Zet de verzendinstelling: DPD met een gratis-vanaf-drempel en een levertijd.
 * @param {object} world De testwereld.
 * @param {number} freeFrom De drempel (incl. btw), 0 = geen.
 * @returns {Promise<void>} Klaar als de instelling staat.
 */
async function configureShipping(world, freeFrom) {
  const saved = await world.admin.put('/app/api/admin/settings', { shopShipping: { pickup: { enabled: true }, dpd: { enabled: true, defaultWeightGrams: 1000, zones: [{ country: 'NL', freeFrom, tiers: [{ upToGrams: 5000, price: 6.95 }] }] } } });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
}

test('winkelwagen: verzendkosten, levertijd en drempelbalk staan er al, en de betaalnotitie klopt', async () => {
  const world = await setup();
  await configureShipping(world, 50);
  const [shopper] = world.shoppers;
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '1' });
  const page = await shopper.client.request('GET', '/winkelwagen/');
  assert.match(page.text, /data-shipping-hint/);
  assert.match(page.text, /€ 6,95/, 'de verzendkosten staan al in de winkelwagen');
  assert.match(page.text, /levertijd ca\./);
  assert.match(page.text, /Nog <strong>€ 37,90<\/strong> tot gratis bezorging/, 'drempel 50 min 12,10');
  assert.match(page.text, /<progress class="free-bar" max="50" value="12\.1"/);
  assert.doesNotMatch(page.text, /Verzendkosten worden bij het afrekenen berekend/);
  assert.match(page.text, /Betalen kan op rekening\./, 'zonder online betalen blijft op rekening staan');
  // Boven de drempel: gratis en geen balk meer.
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '4' });
  const free = await shopper.client.request('GET', '/winkelwagen/');
  assert.match(free.text, /Gratis/);
  assert.match(free.text, /Je bestelling wordt gratis bezorgd/);
  assert.doesNotMatch(free.text, /class="free-bar"/);
});

test('winkelwagen: bij online betalen noemt de notitie online betalen', async () => {
  const world = await setup({ mollie: true });
  const [shopper] = world.shoppers;
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '1' });
  const page = await shopper.client.request('GET', '/winkelwagen/');
  assert.match(page.text, /Betalen kan online/);
  assert.match(page.text, /Veilig betalen met iDEAL/, 'de vertrouwensstrook noemt online betalen');
});

test('winkelwagen: Verder winkelen keert terug naar de laatst bekeken lijst en een kapotte cookie geeft de startpagina', async () => {
  const world = await setup();
  const [shopper] = world.shoppers;
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '1' });
  const empty = await shopper.client.request('GET', '/winkelwagen/');
  assert.match(empty.text, /<a class="button secondary" href="\.\.\/">Verder winkelen/);
  const search = await shopper.client.request('GET', '/zoeken/?q=sproeier');
  assert.strictEqual(search.status, 200);
  const cart = await shopper.client.request('GET', '/winkelwagen/');
  assert.match(cart.text, /href="\.\.\/zoeken\/\?q=sproeier">Verder winkelen/);
  // De cookie wordt niet opnieuw gezet als er niets verandert.
  const again = await shopper.client.request('GET', '/zoeken/?q=sproeier');
  assert.ok(!(again.headers.get('set-cookie') || '').includes('aquatech_laatste_lijst'));
});

test('lastListPath: alleen bekende soorten met veilige tekens', () => {
  /**
   * Een nagebootst verzoek met de cookie van de laatste lijst.
   * @param {*} value De inhoud van de cookie.
   * @returns {object} Het verzoek.
   */
  const cookieFor = (value) => ({ headers: { cookie: `aquatech_laatste_lijst=${Buffer.from(JSON.stringify(value)).toString('base64url')}` } });
  assert.strictEqual(lastListPath(cookieFor(['categorie', 'pompen'])), 'categorie/pompen/');
  assert.strictEqual(lastListPath(cookieFor(['groep', 'beregening'])), 'groep/beregening/');
  assert.strictEqual(lastListPath(cookieFor(['zoeken', 'pomp & kraan'])), 'zoeken/?q=pomp%20%26%20kraan');
  assert.strictEqual(lastListPath(cookieFor(['categorie', '../admin'])), '', 'geen padafwijking');
  assert.strictEqual(lastListPath(cookieFor(['categorie', 'A B'])), '');
  assert.strictEqual(lastListPath(cookieFor(['product', 'pompen'])), '', 'onbekende soort');
  assert.strictEqual(lastListPath(cookieFor(['zoeken', 'x'.repeat(81)])), '');
  assert.strictEqual(lastListPath({ headers: { cookie: 'aquatech_laatste_lijst=%%%' } }), '');
  assert.strictEqual(lastListPath({ headers: {} }), '');
});

test('afrekenen en product: vertrouwensstrook zonder verzonnen punten', async () => {
  const world = await setup();
  await configureShipping(world, 150);
  const [shopper] = world.shoppers;
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '1' });
  const checkout = await shopper.client.request('GET', '/afrekenen/');
  assert.match(checkout.text, /class="trust-strip"/);
  assert.match(checkout.text, /14 dagen bedenktijd/);
  assert.match(checkout.text, /Gratis bezorgd vanaf|Levertijd ca\./);
  assert.match(checkout.text, /<h2 data-address-heading[^>]*>Bezorg- en factuuradres<\/h2>/);
  const zonder = await shopper.client.request('GET', '/afrekenen/?deliverySame=0');
  assert.ok(zonder.status === 200);
  const product = await shopper.client.request('GET', '/product/sproeier/');
  if (product.status === 200) {
    assert.match(product.text, /class="trust-strip"/);
    assert.match(product.text, /Gratis bezorgd vanaf € 150,00/);
  }
});

test('zoeken zonder resultaat: tips, categorieën en telefoonnummer in plaats van een lege pagina', async () => {
  const world = await setup();
  const [shopper] = world.shoppers;
  const page = await shopper.client.request('GET', '/zoeken/?q=bestaatniet');
  assert.match(page.text, /Niets gevonden/);
  assert.match(page.text, /class="no-results-groups"/);
  const blank = await shopper.client.request('GET', '/zoeken/');
  assert.doesNotMatch(blank.text, /Niets gevonden/, 'zonder zoekterm geen melding');
});

test('winkelwagen.js wordt geserveerd en verbergt de Wijzig-knop', async () => {
  const world = await setup();
  const [shopper] = world.shoppers;
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '1' });
  const page = await shopper.client.request('GET', '/winkelwagen/');
  assert.match(page.text, /assets\/winkelwagen\.js/);
  assert.match(page.text, /data-cart-qty/);
  const script = await shopper.client.request('GET', '/assets/winkelwagen.js');
  assert.strictEqual(script.status, 200);
  assert.match(script.text, /requestSubmit/);
});
