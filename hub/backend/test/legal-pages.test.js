// Tests van de juridische pagina's van de eigen webshop: standaardteksten,
// links in de voet, een eigen versie uit Beheer, en het verplichte akkoord bij afrekenen.
const test = require('node:test');
const assert = require('node:assert');
const { setup, order, PERSON } = require('./helpers/webshop-world');
const { postCheckout, postForm } = require('./helpers/http-client');
const { LEGAL_SLUGS, WITHDRAWAL_DAYS } = require('../src/webshop/legal-pages');
const { cookieBody, ALL_SERVICES } = require('../src/webshop/cookie-notice');
const { RETURN_DAYS } = require('../src/webshop/web-returns');

test('de termijn in de teksten is gelijk aan de retourtermijn', () => {
  assert.strictEqual(WITHDRAWAL_DAYS, RETURN_DAYS);
});

test('standaardpagina\'s en links in de voet', async () => {
  const world = await setup();
  const visitor = world.shoppers[0].client;
  const home = await visitor.get('/');
  for (const slug of LEGAL_SLUGS) assert.match(home.text, new RegExp(`href="pagina/${slug}/"`), `voet linkt naar ${slug}`);
  const terms = await visitor.get('/pagina/algemene-voorwaarden/');
  assert.strictEqual(terms.status, 200);
  assert.match(terms.text, /<h1>Algemene voorwaarden<\/h1>/);
  assert.match(terms.text, /Oenenburgweg 218/, 'bedrijfsgegevens uit Beheer');
  const privacy = await visitor.get('/pagina/privacyverklaring/');
  assert.match(privacy.text, /Autoriteit Persoonsgegevens/);
  const withdrawal = await visitor.get('/pagina/herroepingsrecht/');
  assert.match(withdrawal.text, /Modelformulier voor herroeping/);
  assert.strictEqual((await visitor.get('/pagina/bestaat-niet/')).status, 404);
});

test('een eigen pagina uit Beheer gaat voor op de standaardtekst', async () => {
  const world = await setup();
  const saved = await world.admin.put('/app/api/admin/shop-content/pages/algemene-voorwaarden', { title: 'Onze voorwaarden', body: '<p>Eigen tekst</p>' });
  assert.ok(saved.status < 300, JSON.stringify(saved.body));
  assert.strictEqual((await world.admin.post('/app/api/admin/shop-content/pages/algemene-voorwaarden/publish', {})).status < 300, true);
  const page = await world.shoppers[0].client.get('/pagina/algemene-voorwaarden/');
  assert.match(page.text, /Eigen tekst/);
  assert.doesNotMatch(page.text, /Wie zijn wij/);
  assert.match(page.text, /Onze voorwaarden/, 'de titel in de voet volgt de eigen pagina');
  const view = await world.admin.get('/app/api/admin/shop-content');
  assert.ok(view.body.defaults.legal['privacyverklaring'].body.includes('Verwerkingsverantwoordelijke'), 'Beheer krijgt de standaardtekst');
});

test('bestellen kan alleen met akkoord op de voorwaarden', async () => {
  const world = await setup();
  const [customer] = world.shoppers;
  await postForm(world.base, customer.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '2' });
  const page = await customer.client.get('/afrekenen/');
  assert.match(page.text, /name="terms"/);
  assert.match(page.text, /pagina\/algemene-voorwaarden\//);
  const refused = await postCheckout(world.base, customer.client, { ...PERSON, terms: '' });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.text, /Ga akkoord met de algemene voorwaarden/);
  assert.strictEqual((await world.admin.get('/app/api/admin/web-orders')).body.items.length, 0, 'niets geplaatst');
  const id = await order(world, customer);
  const placed = (await world.admin.get(`/app/api/admin/web-orders/${id}`)).body.order;
  assert.strictEqual(placed.consent.terms, true);
  assert.ok(placed.consent.at, 'tijdstip van het akkoord');
});

test('cookieverklaring: zonder diensten alleen de noodzakelijke cookies, geen Google of Microsoft', async () => {
  const world = await setup();
  const visitor = world.shoppers[0].client;
  const home = await visitor.get('/');
  assert.match(home.text, /href="pagina\/cookieverklaring\/"/, 'link in de voet');
  const page = await visitor.get('/pagina/cookieverklaring/');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /aquatech_winkelwagen/);
  assert.match(page.text, /geen analytische diensten/);
  assert.doesNotMatch(page.text, /Google Analytics|Microsoft Clarity|_clck|reCAPTCHA|aquatech_shop_consent/);
  const privacy = await visitor.get('/pagina/privacyverklaring/');
  assert.doesNotMatch(privacy.text, /Google Analytics|Microsoft Clarity/);
  assert.match(privacy.text, /cookieverklaring/);
});

test('cookieverklaring: Google Analytics en Clarity staan er alleen in als ze aan staan', async () => {
  const world = await setup();
  const visitor = world.shoppers[0].client;
  await world.admin.put('/app/api/admin/settings', { shopAnalytics: { enabled: true, measurementId: 'G-TEST1234' } });
  let page = await visitor.get('/pagina/cookieverklaring/');
  assert.match(page.text, /Google Analytics 4/);
  assert.match(page.text, /policies\.google\.com\/privacy/);
  assert.match(page.text, /aquatech_shop_consent/);
  assert.doesNotMatch(page.text, /Microsoft Clarity/);
  await world.admin.put('/app/api/admin/settings', { shopClarity: { enabled: true, projectId: 'zgjek0q90a' } });
  page = await visitor.get('/pagina/cookieverklaring/');
  assert.match(page.text, /Microsoft Clarity/);
  assert.match(page.text, /_clck/);
  assert.match(page.text, /privacy\.microsoft\.com/);
  assert.match((await visitor.get('/pagina/privacyverklaring/')).text, /Google Analytics en Microsoft Clarity/);
  await world.admin.put('/app/api/admin/settings', { shopAnalytics: { enabled: false, measurementId: 'G-TEST1234' }, shopClarity: { enabled: false, projectId: 'zgjek0q90a' } });
  assert.doesNotMatch((await visitor.get('/pagina/cookieverklaring/')).text, /Google Analytics|Microsoft Clarity/);
});

test('cookieverklaring: elke dienst heeft aanbieder, doel, bewaartermijn, doorgifte en privacybeleid', () => {
  const html = cookieBody({ email: 'info@example.nl' }, ALL_SERVICES);
  for (const label of ['Aanbieder', 'Doel', 'Bewaartermijn', 'Buiten de EU', 'Privacybeleid', 'Categorie']) assert.ok(html.includes(`<strong>${label}:</strong>`), label);
  for (const name of ['Google Analytics 4', 'Microsoft Clarity', 'Google reCAPTCHA', 'Mollie', 'aquatech_gastbestelling', '_ga', '_clsk']) assert.ok(html.includes(name), name);
  assert.match(html, /info@example\.nl/);
  assert.doesNotMatch(cookieBody({}, {}), /Mollie|reCAPTCHA|aquatech_gastbestelling/);
});
