// Adres invullen bij postcode + huisnummer: de opzoekdienst (PDOK nagebootst),
// de API in de app, de route in de webshop, het afrekenformulier en de
// gedeelde frontendcomponent (geladen in een sandbox).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createAddressLookup, normalizePostcode, normalizeHouseNumber, normalizeSuffix } = require('../src/platform/address-lookup');
const { setup } = require('./helpers/webshop-world');
const { createClient, postForm } = require('./helpers/http-client');

const ADDRESS_LOOKUP_FILE = path.join(__dirname, '..', '..', 'frontend', 'shared', 'address-lookup.js');

/**
 * Nagebootste PDOK Locatieserver met een paar adressen.
 * @returns {{ fetchImpl: Function, calls: string[], down: { on: boolean } }} fetchImpl voor createAddressLookup, de opgevraagde adressen en down.on om PDOK onbereikbaar te maken.
 */
function createPdokFake() {
  const calls = [];
  const down = { on: false };
  const documents = {
    '8071AB|1': [{ straatnaam: 'Tuinstraat', huisnummer: 1, postcode: '8071AB', woonplaatsnaam: 'Nunspeet' }],
    '8071AB|12': [
      { straatnaam: 'Tuinstraat', huisnummer: 12, huisletter: 'A', postcode: '8071AB', woonplaatsnaam: 'Nunspeet' },
      { straatnaam: 'Tuinstraat', huisnummer: 12, postcode: '8071AB', woonplaatsnaam: 'Nunspeet' },
      { straatnaam: 'Tuinstraat', huisnummer: 12, huisnummertoevoeging: '2', postcode: '8071AB', woonplaatsnaam: 'Nunspeet' },
    ],
  };
  /**
   * Doet alsof dit PDOK is.
   * @param {string} url Het opgevraagde adres.
   * @returns {Promise<{ ok: boolean, status: number, json: Function }>} Het antwoord.
   */
  const fetchImpl = async (url) => {
    calls.push(url);
    if (down.on) throw new Error('netwerk weg');
    const parsed = new URL(url);
    assert.strictEqual(parsed.origin + parsed.pathname, 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free');
    const filters = parsed.searchParams.getAll('fq');
    const postcode = filters.find((filter) => filter.startsWith('postcode:')).slice(9);
    const houseNumber = filters.find((filter) => filter.startsWith('huisnummer:')).slice(11);
    return { ok: true, status: 200, json: async () => ({ response: { docs: documents[`${postcode}|${houseNumber}`] || [] } }) };
  };
  return { fetchImpl, calls, down };
}

test('invoer schoonmaken: postcode, huisnummer en toevoeging', () => {
  assert.strictEqual(normalizePostcode(' 8071 ab '), '8071AB');
  assert.strictEqual(normalizePostcode('0123AB'), '');
  assert.strictEqual(normalizePostcode('1234SS'), '');
  assert.strictEqual(normalizePostcode('12345'), '');
  assert.strictEqual(normalizeHouseNumber('012'), '12');
  assert.strictEqual(normalizeHouseNumber('12a'), '');
  assert.strictEqual(normalizeHouseNumber('0'), '');
  assert.strictEqual(normalizeSuffix(' a-1 '), 'A1');
});

test('opzoeken: straat en plaats, toevoeging, geen treffer en onthouden', async () => {
  const pdok = createPdokFake();
  const service = createAddressLookup({ fetchImpl: pdok.fetchImpl });
  assert.deepStrictEqual(await service.lookup({ postcode: '8071ab', houseNumber: '1' }), { found: true, street: 'Tuinstraat', houseNumber: '1', suffix: '', suffixRequired: false, postcode: '8071 AB', city: 'Nunspeet' });
  assert.strictEqual((await service.lookup({ postcode: '8071AB', houseNumber: '12', suffix: 'a' })).suffix, 'A');
  assert.strictEqual((await service.lookup({ postcode: '8071AB', houseNumber: '12', suffix: '2' })).suffix, '2');
  assert.strictEqual((await service.lookup({ postcode: '8071AB', houseNumber: '12' })).suffixRequired, false, 'er is ook een adres zonder toevoeging');
  assert.deepStrictEqual(await service.lookup({ postcode: '8071AB', houseNumber: '12', suffix: 'Q' }), { found: false, suffixUnknown: true });
  assert.deepStrictEqual(await service.lookup({ postcode: '8071AB', houseNumber: '99' }), { found: false });
  assert.strictEqual(pdok.calls.length, 3, 'dezelfde postcode en hetzelfde huisnummer worden onthouden');
  await assert.rejects(service.lookup({ postcode: 'abc', houseNumber: '1' }), { code: 'invalid' });
});

test('opzoeken: PDOK onbereikbaar geeft een duidelijke fout', async () => {
  const pdok = createPdokFake();
  pdok.down.on = true;
  await assert.rejects(createAddressLookup({ fetchImpl: pdok.fetchImpl }).lookup({ postcode: '8071AB', houseNumber: '1' }), { code: 'unavailable' });
  const failing = createAddressLookup({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await assert.rejects(failing.lookup({ postcode: '8071AB', houseNumber: '1' }), { code: 'unavailable' });
});

test('API in de app: alleen ingelogd, ongeldige invoer 400, storing 502', async () => {
  const pdok = createPdokFake();
  const world = await setup({ addressFetch: pdok.fetchImpl });
  const anonymous = createClient(world.base);
  const found = await world.admin.get('/api/address-lookup?postcode=8071AB&huisnummer=12&toevoeging=a');
  assert.strictEqual(found.status, 200);
  assert.strictEqual(found.body.street, 'Tuinstraat');
  assert.strictEqual(found.body.suffix, 'A');
  assert.strictEqual((await world.admin.get('/api/address-lookup?postcode=8071AB&huisnummer=99')).body.found, false);
  assert.strictEqual((await world.admin.get('/api/address-lookup?postcode=foutje&huisnummer=1')).status, 400);
  assert.strictEqual((await world.admin.get('/api/address-lookup?postcode=8071AB')).status, 400);
  const plain = await world.admin.get('/api/address-lookup?postcode=8071AB&huisnummer=1');
  assert.match(plain.headers.get('cache-control'), /no-store/);
  pdok.down.on = true;
  const down = await world.admin.get('/api/address-lookup?postcode=8071AB&huisnummer=5');
  assert.strictEqual(down.status, 502);
  assert.match(down.body.message, /zelf in/);
  await world.admin.put('/api/admin/settings', { guestAccess: false });
  assert.strictEqual((await anonymous.get('/api/address-lookup?postcode=8071AB&huisnummer=1')).status, 401);
});

test('webshop: route /winkel/adres/, CSP en afrekenformulier', async () => {
  const pdok = createPdokFake();
  const world = await setup({ addressFetch: pdok.fetchImpl });
  const customer = world.shoppers[0].client;
  const route = await customer.get('/winkel/adres/?postcode=8071AB&huisnummer=1');
  assert.strictEqual(route.status, 200);
  assert.strictEqual(route.body.city, 'Nunspeet');
  assert.strictEqual((await customer.get('/winkel/adres/?postcode=x&huisnummer=1')).status, 400);
  assert.match(route.headers.get('content-security-policy'), /connect-src 'self'/);
  const script = await customer.get('/winkel/assets/adres.js');
  assert.strictEqual(script.status, 200);
  assert.match(script.type, /javascript/);
  await postForm(world.base, world.shoppers[0].client, '/winkel/winkelwagen/', { action: 'add', code: 'BUS', qty: '1' });
  const checkout = await customer.get('/winkel/afrekenen/');
  assert.strictEqual(checkout.status, 200);
  assert.match(checkout.text, /data-address-endpoint="\.\.\/adres\/"/);
  assert.match(checkout.text, /<div class="address-lookup" data-address-row hidden>/);
  assert.match(checkout.text, /role="status" aria-live="polite"/);
  assert.ok(checkout.text.indexOf('name="postcode"') < checkout.text.indexOf('name="street"'), 'postcode staat boven de straat');
  assert.ok(checkout.text.indexOf('adres.js') < checkout.text.indexOf('afrekenen.js'));
  assert.strictEqual((await world.admin.get('/api/address-lookup?postcode=8071AB&huisnummer=1')).status, 200);
});

/**
 * Laadt de gedeelde frontendcomponent in een sandbox.
 * @returns {object} De component (AddressLookup).
 */
function loadComponent() {
  const sandbox = { window: {}, document: { readyState: 'complete', querySelectorAll: () => [] }, console, AbortController, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ADDRESS_LOOKUP_FILE, 'utf8'), sandbox);
  return sandbox.window.AddressLookup;
}

test('frontendcomponent: postcode en huisnummer controleren, adres opmaken', () => {
  const lookup = loadComponent();
  assert.strictEqual(lookup.parsePostcode('8071ab'), '8071 AB');
  assert.strictEqual(lookup.parsePostcode('8071'), '');
  assert.strictEqual(lookup.parseHouseNumber(' 12 '), '12');
  assert.strictEqual(lookup.parseHouseNumber('12a'), '');
  const address = { street: 'Tuinstraat', houseNumber: '12', suffix: 'A', postcode: '8071 AB', city: 'Nunspeet' };
  assert.strictEqual(lookup.streetLine(address), 'Tuinstraat 12A');
  assert.strictEqual(lookup.fullAddress(address, '\n'), 'Tuinstraat 12A\n8071 AB Nunspeet');
});

test('frontendcomponent: alleen tekstvakken en invoervelden met data-address-lookup worden uitgebreid', () => {
  const selectors = [];
  const sandbox = { window: {}, document: { readyState: 'complete', querySelectorAll: (selector) => { selectors.push(selector); return []; } }, console, AbortController, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ADDRESS_LOOKUP_FILE, 'utf8'), sandbox);
  assert.deepStrictEqual(selectors, ['textarea[data-address-lookup], input[data-address-lookup]']);
});

test('frontendcomponent: vult bij een treffer, meldt een storing en wacht op geldige invoer', async () => {
  const lookup = loadComponent();
  /**
   * Eenvoudig invoerveld met gebeurtenissen.
   * @param {string} value Beginwaarde.
   * @returns {object} Het nagebootste veld.
   */
  const makeInput = (value) => {
    const handlers = {};
    return { value, addEventListener: (name, handler) => { handlers[name] = handler; }, fire: (name) => handlers[name]() };
  };
  const postcodeInput = makeInput('');
  const numberInput = makeInput('');
  const statusElement = { textContent: '', dataset: {} };
  const found = [];
  const requests = [];
  let down = false;
  const component = lookup.attach({
    postcodeInput, numberInput, statusElement, endpoint: 'adres/', onFound: (address) => found.push(address),
    fetchImpl: async (url) => {
      requests.push(url);
      if (down) throw new Error('weg');
      return { ok: true, status: 200, json: async () => ({ found: true, street: 'Tuinstraat', houseNumber: '1', suffix: '', suffixRequired: false, postcode: '8071 AB', city: 'Nunspeet' }) };
    },
  });
  postcodeInput.value = '8071 AB';
  await component.check();
  assert.strictEqual(requests.length, 0, 'zonder huisnummer wordt niets opgevraagd');
  numberInput.value = '1';
  await component.check();
  assert.strictEqual(requests.length, 1);
  assert.match(requests[0], /^adres\/\?postcode=8071\+AB&huisnummer=1&toevoeging=$/);
  assert.strictEqual(found[0].city, 'Nunspeet');
  assert.strictEqual(statusElement.dataset.kind, 'ok');
  await component.check();
  assert.strictEqual(requests.length, 1, 'dezelfde invoer vult het adres niet nog eens in');
  down = true;
  numberInput.value = '2';
  await component.check();
  assert.strictEqual(statusElement.dataset.kind, 'error');
  assert.match(statusElement.textContent, /zelf in/);
  assert.strictEqual(found.length, 1, 'bij een storing verandert er niets aan het formulier');
});

test('opzoeken: huisnummer met alleen toevoegingen vraagt om een toevoeging; gelijktijdig en leeg', async () => {
  let calls = 0;
  let found = true;
  const flats = createAddressLookup({ fetchImpl: async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ response: { docs: found ? [{ straatnaam: 'Kerkstraat', huisnummer: 5, huisletter: 'A', woonplaatsnaam: 'Elburg' }, { straatnaam: 'Kerkstraat', huisnummer: 5, huisletter: 'B', woonplaatsnaam: 'Elburg' }] : [] } }) };
  } });
  const [first, second] = await Promise.all([flats.lookup({ postcode: '8081AB', houseNumber: '5' }), flats.lookup({ postcode: '8081AB', houseNumber: '5' })]);
  assert.strictEqual(calls, 1, 'gelijktijdige vragen delen één aanroep');
  assert.deepStrictEqual([first.found, first.suffixRequired, second.suffix], [true, true, '']);
  assert.strictEqual((await flats.lookup({ postcode: '8081AB', houseNumber: '5', suffix: 'B' })).suffixRequired, false);
  found = false;
  assert.strictEqual((await flats.lookup({ postcode: '8082AB', houseNumber: '1' })).found, false);
});

test('frontendcomponent: land wijzigt tijdens het opzoeken, of het adres is intussen vervangen', async () => {
  const lookup = loadComponent();
  /**
   * Eenvoudig invoerveld met gebeurtenissen.
   * @param {string} value Beginwaarde.
   * @returns {object} Het nagebootste veld.
   */
  const makeInput = (value) => ({ value, addEventListener: () => {} });
  const statusElement = { textContent: '', dataset: {} };
  const found = [];
  let active = true;
  let current = true;
  const component = lookup.attach({
    postcodeInput: makeInput('8071 AB'), numberInput: makeInput('1'), statusElement, endpoint: 'adres/', isActive: () => active, isCurrent: () => current, onFound: (address) => found.push(address),
    fetchImpl: async () => { active = false; return { ok: true, status: 200, json: async () => ({ found: true, street: 'Tuinstraat', houseNumber: '1', suffix: '', postcode: '8071 AB', city: 'Nunspeet' }) }; },
  });
  await component.check();
  assert.strictEqual(found.length, 0, 'een antwoord na een landwijziging vult niets in');
  active = true;
  await component.check();
  assert.strictEqual(found.length, 0, 'fetchImpl zet het land weer uit');
});

test('frontendcomponent: antwoord wordt genegeerd als het adresveld tijdens het opzoeken is aangepast, ook bij een fout', async () => {
  const lookup = loadComponent();
  /**
   * Eenvoudig invoerveld.
   * @param {string} value Beginwaarde.
   * @returns {object} Het nagebootste veld.
   */
  const makeInput = (value) => ({ value, addEventListener: () => {} });
  const statusElement = { textContent: '', dataset: {} };
  const found = [];
  let destination = 'a';
  let failure = false;
  const component = lookup.attach({
    postcodeInput: makeInput('8071 AB'), numberInput: makeInput('1'), statusElement, endpoint: 'adres/', getDestination: () => destination, onFound: (address) => found.push(address),
    fetchImpl: async () => {
      destination = 'handmatig aangepast';
      if (failure) throw new Error('weg');
      return { ok: true, status: 200, json: async () => ({ found: true, street: 'Tuinstraat', houseNumber: '1', suffix: '', postcode: '8071 AB', city: 'Nunspeet' }) };
    },
  });
  await component.check();
  assert.strictEqual(found.length, 0, 'een handmatige aanpassing blijft staan');
  assert.strictEqual(statusElement.textContent, '');
  destination = 'a';
  failure = true;
  await component.check();
  assert.strictEqual(statusElement.textContent, '', 'ook een foutmelding verschijnt niet meer');
});
