// Tests van de juridische pagina's van de eigen webshop: standaardteksten,
// links in de voet, een eigen versie uit Beheer, en het verplichte akkoord bij afrekenen.
const test = require('node:test');
const assert = require('node:assert');
const { setup, order, PERSON } = require('./helpers/webshop-world');
const { postCheckout, postForm } = require('./helpers/http-client');
const { LEGAL_SLUGS, WITHDRAWAL_DAYS } = require('../src/webshop/legal-pages');
const { RETURN_DAYS } = require('../src/webshop/web-returns');

test('de termijn in de teksten is gelijk aan de retourtermijn', () => {
  assert.strictEqual(WITHDRAWAL_DAYS, RETURN_DAYS);
});

test('standaardpagina\'s en links in de voet', async () => {
  const world = await setup();
  const visitor = world.shoppers[0].client;
  const home = await visitor.get('/winkel/');
  for (const slug of LEGAL_SLUGS) assert.match(home.text, new RegExp(`href="pagina/${slug}/"`), `voet linkt naar ${slug}`);
  const terms = await visitor.get('/winkel/pagina/algemene-voorwaarden/');
  assert.strictEqual(terms.status, 200);
  assert.match(terms.text, /<h1>Algemene voorwaarden<\/h1>/);
  assert.match(terms.text, /Oenenburgweg 218/, 'bedrijfsgegevens uit Beheer');
  const privacy = await visitor.get('/winkel/pagina/privacyverklaring/');
  assert.match(privacy.text, /Autoriteit Persoonsgegevens/);
  const withdrawal = await visitor.get('/winkel/pagina/herroepingsrecht/');
  assert.match(withdrawal.text, /Modelformulier voor herroeping/);
  assert.strictEqual((await visitor.get('/winkel/pagina/bestaat-niet/')).status, 404);
});

test('een eigen pagina uit Beheer gaat voor op de standaardtekst', async () => {
  const world = await setup();
  const saved = await world.admin.put('/api/admin/shop-content/pages/algemene-voorwaarden', { title: 'Onze voorwaarden', body: '<p>Eigen tekst</p>' });
  assert.ok(saved.status < 300, JSON.stringify(saved.body));
  assert.strictEqual((await world.admin.post('/api/admin/shop-content/pages/algemene-voorwaarden/publish', {})).status < 300, true);
  const page = await world.shoppers[0].client.get('/winkel/pagina/algemene-voorwaarden/');
  assert.match(page.text, /Eigen tekst/);
  assert.doesNotMatch(page.text, /Wie zijn wij/);
  assert.match(page.text, /Onze voorwaarden/, 'de titel in de voet volgt de eigen pagina');
  const view = await world.admin.get('/api/admin/shop-content');
  assert.ok(view.body.defaults.legal['privacyverklaring'].body.includes('Verwerkingsverantwoordelijke'), 'Beheer krijgt de standaardtekst');
});

test('bestellen kan alleen met akkoord op de voorwaarden', async () => {
  const world = await setup();
  const [customer] = world.shoppers;
  await postForm(world.base, customer.client, '/winkel/winkelwagen/', { action: 'add', code: 'BUS', qty: '2' });
  const page = await customer.client.get('/winkel/afrekenen/');
  assert.match(page.text, /name="terms"/);
  assert.match(page.text, /pagina\/algemene-voorwaarden\//);
  const refused = await postCheckout(world.base, customer.client, { ...PERSON, terms: '' });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.text, /Ga akkoord met de algemene voorwaarden/);
  assert.strictEqual((await world.admin.get('/api/admin/web-orders')).body.items.length, 0, 'niets geplaatst');
  const id = await order(world, customer);
  const placed = (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order;
  assert.strictEqual(placed.consent.terms, true);
  assert.ok(placed.consent.at, 'tijdstip van het akkoord');
});
