// Zakelijke klanten in de eigen webshop: aanvragen bij het registreren of vanaf
// "Mijn account", goedkeuren door een beheerder, bedrijfsgegevens, en prijzen
// excl. btw (met de regel incl. btw) in de hele shop voor een zakelijke klant.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeBusinessProfile, wantsBusiness } = require('../src/webshop/business-profile');
const { buildCatalog } = require('../src/webshop/storefront-data');
const { createLogin, createClient, listen, postForm } = require('./helpers/http-client');

const SECRET = 'd'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/** Geldige bedrijfsgegevens voor het aanvragen van een zakelijk account. */
const COMPANY = { companyName: 'Tuinbedrijf De Groene Duim BV', kvkNumber: '12345678', vatNumber: 'NL123456789B01' };

/**
 * Hoofdtenant met beheerder, een andere organisatie en artikelen (met en zonder zakelijke prijs) in de shop.
 * @returns {Promise<object>} base, store, main, admin, vreemd, db en shopper() om een klant te registreren.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  await admin.put('/app/api/admin/settings', { storefront: true, shopOrdering: true });
  await admin.post('/app/api/stock/items', { code: 'BUS', name: 'Sproeier zakelijk', onHand: 50, salePrice: 10, businessPrice: 8 });
  await admin.post('/app/api/stock/items', { code: 'GEEN', name: 'Zonder zakelijke prijs', onHand: 50, salePrice: 5 });
  let counter = 0;
  /**
   * Registreert een klant in de shop (met de gegeven extra velden).
   * @param {object} [extra] Extra formuliervelden, bijvoorbeeld de bedrijfsgegevens.
   * @returns {Promise<object>} client, id van het account en het antwoord op het registreren.
   */
  const shopper = async (extra = {}) => {
    counter += 1;
    const client = createClient(base);
    const done = await postForm(base, client, '/registreren/', { displayName: `Klant ${counter}`, email: `k${counter}@voorbeeld.nl`, password: PW, password2: PW, website: '', ...extra });
    const users = (await admin.get('/app/api/admin/users')).body.items;
    const user = users.find((candidate) => candidate.email === `k${counter}@voorbeeld.nl`);
    return { client, id: user ? user.id : null, done };
  };
  return { base, db, store, main, admin, vreemd: await createLogin(base, { password: PW })('vreemd', 'ander'), shopper };
}

/**
 * Zoekt de verwijzing naar het product 'Sproeier zakelijk' op een overzichtspagina.
 * @param {object} client De client.
 * @returns {Promise<string>} Het pad van de productpagina.
 */
async function productPath(client) {
  const search = await client.get('/zoeken/?q=zakelijk');
  const found = search.text.match(/href="\.\.\/product\/([^"]+)"/);
  assert.ok(found, 'product gevonden');
  return `/product/${found[1]}`;
}

test('bedrijfsgegevens: KvK-nummer van 8 cijfers, geldig btw-nummer, bedrijfsnaam verplicht', () => {
  assert.deepStrictEqual(sanitizeBusinessProfile({ companyName: ' Duim  BV ', kvkNumber: '1234 5678', vatNumber: 'nl 1234.56.789 b01' }).profile,
    { companyName: 'Duim BV', kvkNumber: '12345678', vatNumber: 'NL123456789B01' });
  assert.strictEqual(sanitizeBusinessProfile({ companyName: '', kvkNumber: '12345678' }).field, 'companyName');
  assert.strictEqual(sanitizeBusinessProfile({ companyName: 'X', kvkNumber: '1234567' }).field, 'kvkNumber');
  assert.strictEqual(sanitizeBusinessProfile({ companyName: 'X', kvkNumber: '12345678', vatNumber: 'NL123' }).field, 'vatNumber');
  assert.strictEqual(sanitizeBusinessProfile({ companyName: 'X', kvkNumber: '12345678' }).profile.vatNumber, '', 'btw-nummer is optioneel');
  assert.ok(wantsBusiness('1') && wantsBusiness('on') && !wantsBusiness('') && !wantsBusiness(undefined));
});

test('catalogus: zakelijke prijs excl. btw (valt terug op de verkoopprijs) en incl. btw', () => {
  const catalog = buildCatalog([
    { code: 'A', name: 'Met zakelijke prijs', unit: 'st', on_hand: 1, sale_price: 10, business_price: 8, vat_rate: 21, categories: '[]', image: '' },
    { code: 'B', name: 'Zonder', unit: 'st', on_hand: 1, sale_price: 5, business_price: null, vat_rate: 21, categories: '[]', image: '' },
  ]);
  const [withBusiness, without] = catalog.products;
  assert.strictEqual(withBusiness.priceBusiness, 8);
  assert.strictEqual(withBusiness.priceBusinessIncl, 9.68);
  assert.strictEqual(without.priceBusiness, 5);
  assert.strictEqual(without.priceIncl, 6.05);
});

test('registreren als zakelijke klant: aanvraag open, tot goedkeuring prijzen incl. btw', async () => {
  const { admin, shopper } = await setup();
  const applicant = await shopper({ business: '1', ...COMPANY });
  assert.strictEqual(applicant.done.status, 303, applicant.done.text);
  const user = (await admin.get('/app/api/admin/users')).body.items.find((candidate) => candidate.id === applicant.id);
  assert.strictEqual(user.customerGroup, '');
  assert.strictEqual(user.businessRequest, 'aangevraagd');
  assert.strictEqual(user.companyName, COMPANY.companyName);
  assert.strictEqual(user.kvkNumber, '12345678');
  assert.strictEqual(user.vatNumber, 'NL123456789B01');
  const page = await applicant.client.get(await productPath(applicant.client));
  assert.match(page.text, /incl\. 21% btw/);
  assert.doesNotMatch(page.text, /excl\. 21% btw/);
  const account = await applicant.client.get('/account/');
  assert.match(account.text, /wordt beoordeeld/);
  assert.doesNotMatch(account.text, /Zakelijk bestellen\?/, 'geen tweede aanvraag zolang de eerste openstaat');
});

test('registreren als zakelijk met ongeldig KvK-nummer: foutmelding, geen account', async () => {
  const { admin, shopper } = await setup();
  const applicant = await shopper({ business: '1', ...COMPANY, kvkNumber: '123' });
  assert.strictEqual(applicant.done.status, 400);
  assert.match(applicant.done.text, /geldig KvK-nummer/);
  assert.match(applicant.done.text, /value="Tuinbedrijf De Groene Duim BV"/, 'ingevulde waarden blijven staan');
  assert.strictEqual(applicant.id, null);
  assert.strictEqual((await admin.get('/app/api/admin/users')).body.items.filter((user) => user.kind === 'account').length, 1);
});

test('registreren zonder het zakelijk-vakje: gewone particuliere klant, bedrijfsvelden genegeerd', async () => {
  const { admin, shopper } = await setup();
  const person = await shopper({ ...COMPANY });
  assert.strictEqual(person.done.status, 303);
  const user = (await admin.get('/app/api/admin/users')).body.items.find((candidate) => candidate.id === person.id);
  assert.strictEqual(user.businessRequest, '');
  assert.strictEqual(user.companyName, '');
});

test('beheerder keurt goed: zakelijke klant ziet overal excl. btw met de regel incl. btw', async () => {
  const { admin, shopper } = await setup();
  const applicant = await shopper({ business: '1', ...COMPANY });
  const approved = await admin.patch(`/app/api/admin/users/${applicant.id}`, { customerGroup: 'zakelijk' });
  assert.strictEqual(approved.status, 200);
  const user = (await admin.get('/app/api/admin/users')).body.items.find((candidate) => candidate.id === applicant.id);
  assert.strictEqual(user.customerGroup, 'zakelijk');
  assert.strictEqual(user.businessRequest, '', 'de aanvraag is gesloten');
  const path = await productPath(applicant.client);
  const product = await applicant.client.get(path);
  assert.match(product.text, /€\s8,00/);
  assert.match(product.text, /excl\. 21% btw/);
  assert.match(product.text, /incl\. btw €\s9,68/);
  assert.doesNotMatch(product.text, /€\s12,10/, 'de prijs incl. btw van de gewone verkoopprijs staat er niet');
  assert.match(product.text, /alle prijzen zijn exclusief btw/);
  assert.match(product.headers.get('cache-control') || '', /private/);
  const search = await applicant.client.get('/zoeken/?q=zakelijk');
  assert.match(search.text, /€\s8,00 <small class="price-vat">excl\. btw<\/small> <small class="price-incl">\(incl\. btw €\s9,68\)/);
  const account = await applicant.client.get('/account/');
  assert.match(account.text, /Zakelijk account/);
  assert.match(account.text, /KvK 12345678/);
});

test('particulier en niet-ingelogde bezoeker zien de prijs incl. btw', async () => {
  const { base, shopper } = await setup();
  const person = await shopper();
  const visitor = createClient(base);
  for (const client of [person.client, visitor]) {
    const product = await client.get(await productPath(client));
    assert.match(product.text, /€\s12,10/);
    assert.match(product.text, /incl\. 21% btw/);
    assert.doesNotMatch(product.text, /excl\. 21% btw/);
    assert.match(product.text, /Alle prijzen zijn inclusief btw/);
  }
});

test('afwijzen: de klant blijft particulier en kan opnieuw aanvragen vanaf Mijn account', async () => {
  const { base, admin, shopper } = await setup();
  const applicant = await shopper({ business: '1', ...COMPANY });
  assert.strictEqual((await admin.patch(`/app/api/admin/users/${applicant.id}`, { customerGroup: '' })).status, 200);
  const user = (await admin.get('/app/api/admin/users')).body.items.find((candidate) => candidate.id === applicant.id);
  assert.strictEqual(user.businessRequest, '');
  const account = await applicant.client.get('/account/');
  assert.match(account.text, /Zakelijk bestellen\?/);
  const again = await postForm(base, applicant.client, '/account/zakelijk/', COMPANY);
  assert.strictEqual(again.status, 303);
  assert.match(again.location, /aangevraagd=1/);
  const after = (await admin.get('/app/api/admin/users')).body.items.find((candidate) => candidate.id === applicant.id);
  assert.strictEqual(after.businessRequest, 'aangevraagd');
});

test('aanvragen vanaf Mijn account: validatie, alleen ingelogd, niet voor een zakelijke klant', async () => {
  const { base, admin, shopper } = await setup();
  const person = await shopper();
  const invalid = await postForm(base, person.client, '/account/zakelijk/', { ...COMPANY, kvkNumber: 'abc' });
  assert.strictEqual(invalid.status, 400);
  assert.match(invalid.text, /geldig KvK-nummer/);
  const anonymous = await postForm(base, createClient(base), '/account/zakelijk/', COMPANY);
  assert.strictEqual(anonymous.status, 303);
  assert.match(anonymous.location, /inloggen/);
  const staff = await postForm(base, (await (async () => { const client = createClient(base); await postForm(base, client, '/inloggen/', { login: 'baas', password: PW }); return client; })()), '/account/zakelijk/', COMPANY);
  assert.strictEqual(staff.status, 403, 'een medewerker is geen klant');
  const crossSite = await postForm(base, person.client, '/account/zakelijk/', COMPANY, { 'sec-fetch-site': 'cross-site' });
  assert.strictEqual(crossSite.status, 403);
  await admin.patch(`/app/api/admin/users/${person.id}`, { customerGroup: 'zakelijk' });
  assert.strictEqual((await postForm(base, person.client, '/account/zakelijk/', COMPANY)).status, 409);
});

test('beheer: bedrijfsgegevens wijzigen, validatie, andere organisatie 404, klant zelf 403', async () => {
  const { admin, vreemd, shopper } = await setup();
  const person = await shopper();
  const saved = await admin.patch(`/app/api/admin/users/${person.id}`, COMPANY);
  assert.strictEqual(saved.status, 200);
  const user = (await admin.get('/app/api/admin/users')).body.items.find((candidate) => candidate.id === person.id);
  assert.strictEqual(user.companyName, COMPANY.companyName);
  assert.strictEqual(user.businessRequest, '', 'bedrijfsgegevens alleen opslaan vraagt niets aan');
  const invalid = await admin.patch(`/app/api/admin/users/${person.id}`, { ...COMPANY, kvkNumber: '1' });
  assert.strictEqual(invalid.status, 400);
  assert.strictEqual(invalid.body.field, 'kvkNumber');
  const partial = await admin.patch(`/app/api/admin/users/${person.id}`, { vatNumber: 'NL999999999B01' });
  assert.strictEqual(partial.status, 200, 'alleen het btw-nummer wijzigen vult het bestaande profiel aan');
  const merged = (await admin.get('/app/api/admin/users')).body.items.find((candidate) => candidate.id === person.id);
  assert.strictEqual(merged.vatNumber, 'NL999999999B01');
  assert.strictEqual(merged.companyName, COMPANY.companyName);
  assert.strictEqual((await vreemd.patch(`/app/api/admin/users/${person.id}`, COMPANY)).status, 404);
  assert.strictEqual((await person.client.patch(`/app/api/admin/users/${person.id}`, COMPANY)).status, 403);
});

test('afrekenen: zakelijke klant krijgt bedrijfsnaam en btw-nummer vooraf ingevuld', async () => {
  const { base, admin, shopper } = await setup();
  const applicant = await shopper({ business: '1', ...COMPANY });
  await admin.patch(`/app/api/admin/users/${applicant.id}`, { customerGroup: 'zakelijk' });
  assert.strictEqual((await postForm(base, applicant.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '2' })).status, 303);
  const checkout = await applicant.client.get('/afrekenen/');
  assert.match(checkout.text, /name="company"[^>]*value="Tuinbedrijf De Groene Duim BV"/);
  assert.match(checkout.text, /name="vatNumber"[^>]*value="NL123456789B01"/);
});
