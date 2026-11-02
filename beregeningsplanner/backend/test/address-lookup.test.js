// Adres invullen bij postcode + huisnummer: de opzoekdienst (PDOK nagebootst),
// de API in de app, de route in de webshop, het afrekenformulier en de
// gedeelde frontendcomponent (geladen in een sandbox).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createAddressLookup, createAddressGuard, addressCandidates, normalizePostcode, normalizeHouseNumber, normalizeSuffix } = require('../src/platform/address-lookup');
const { setup } = require('./helpers/webshop-world');
const { createPdokFake } = require('./helpers/pdok-fake');
const { createClient, postForm, postCheckout } = require('./helpers/http-client');

const ADDRESS_LOOKUP_FILE = path.join(__dirname, '..', '..', 'frontend', 'shared', 'address-lookup.js');

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
  assert.match(down.body.message, /later opnieuw/);
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
  const sandbox = { window: {}, document: { readyState: 'complete', querySelectorAll: () => [] }, console, setTimeout: () => 0, clearTimeout: () => {}, AbortController, URLSearchParams };
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
  assert.match(statusElement.textContent, /later opnieuw/);
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
  assert.deepStrictEqual([first.found, first.suffixRequired, second.found, second.street], [false, true, false, undefined], 'zonder toevoeging wordt niets ingevuld');
  assert.strictEqual((await flats.lookup({ postcode: '8081AB', houseNumber: '5', suffix: 'B' })).found, true);
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

test('frontendcomponent: een eerder ingevuld adres wordt gewist als de nieuwe invoer om een toevoeging vraagt', async () => {
  const lookup = loadComponent();
  /**
   * Eenvoudig invoerveld.
   * @param {string} value Beginwaarde.
   * @returns {object} Het nagebootste veld.
   */
  const makeInput = (value) => ({ value, addEventListener: () => {} });
  const statusElement = { textContent: '', dataset: {} };
  const numberInput = makeInput('1');
  let address = '';
  let cleared = 0;
  const component = lookup.attach({
    postcodeInput: makeInput('8071 AB'), numberInput, statusElement, endpoint: 'adres/', getDestination: () => address,
    onFound: (found) => { address = found.street; },
    onClear: () => { cleared += 1; address = ''; },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => (numberInput.value === '1' ? { found: true, street: 'Tuinstraat', houseNumber: '1', suffix: '', postcode: '8071 AB', city: 'Nunspeet' } : { found: false, suffixRequired: true }) }),
  });
  await component.check();
  assert.strictEqual(address, 'Tuinstraat');
  numberInput.value = '5';
  await component.check();
  assert.strictEqual(cleared, 1, 'het verouderde adres is gewist');
  assert.match(statusElement.textContent, /toevoeging/);
  numberInput.value = '1';
  await component.check();
  assert.strictEqual(address, 'Tuinstraat', 'terug naar de eerdere combinatie zoekt opnieuw op en toont niet de oude melding');
});

test('adrestekst ontleden: alle verdelingen van huisnummer en toevoeging', () => {
  assert.deepStrictEqual(addressCandidates('Tuinstraat 12A\n8071 AB Nunspeet').map((candidate) => `${candidate.postcode}|${candidate.houseNumber}|${candidate.suffix}`), ['8071AB|12|A', '8071AB|1|2A']);
  assert.deepStrictEqual(addressCandidates('Tuinstraat 122, 8071ab Nunspeet').map((candidate) => `${candidate.houseNumber}|${candidate.suffix}`), ['122|', '12|2', '1|22']);
  assert.deepStrictEqual(addressCandidates('Tuinstraat, 8071 AB Nunspeet'), [], 'zonder huisnummer');
  assert.deepStrictEqual(addressCandidates('Dorpsstraat 1, Nunspeet'), [], 'zonder postcode');
});

test('adrescontrole: alleen het adres dat PDOK bij postcode en huisnummer geeft', async () => {
  const pdok = createPdokFake();
  const guard = createAddressGuard(createAddressLookup({ fetchImpl: pdok.fetchImpl }));
  assert.deepStrictEqual(await guard.verify(''), { ok: true }, 'geen adres is geen fout');
  assert.deepStrictEqual(await guard.verify('Tuinstraat 1\n8071 AB Nunspeet'), { ok: true });
  assert.deepStrictEqual(await guard.verify('tuinstraat 1, 8071ab nunspeet'), { ok: true }, 'hoofdletters en scheiding doen er niet toe');
  assert.deepStrictEqual(await guard.verify('Tuinstraat 12A\n8071 AB Nunspeet'), { ok: true });
  assert.deepStrictEqual(await guard.verify('Tuinstraat 122\n8071 AB Nunspeet'), { ok: true }, 'huisnummer 12 met toevoeging 2');
  for (const tampered of ['Dorpsstraat 1\n8071 AB Nunspeet', 'Tuinstraat 1\n8071 AB Amsterdam', 'Tuinstraat 1\nNunspeet', 'Tuinstraat 99\n8071 AB Nunspeet']) {
    const out = await guard.verify(tampered);
    assert.strictEqual(out.ok, false, tampered);
    assert.strictEqual(out.status, 400);
  }
  const legacy = 'Dorpsstraat 1, Nunspeet';
  assert.strictEqual((await guard.verify(legacy)).ok, false, 'een nieuw adres zonder postcode mag niet');
  assert.deepStrictEqual(await guard.verify(legacy, { previous: () => legacy }), { ok: true }, 'een ongewijzigd ouder adres blijft geldig');
  assert.deepStrictEqual(await guard.verify(legacy, { previous: () => ['ander adres', legacy] }), { ok: true });
  pdok.down.on = true;
  const fresh = createAddressGuard(createAddressLookup({ fetchImpl: pdok.fetchImpl }));
  const unavailable = await fresh.verify('Tuinstraat 1\n8071 AB Nunspeet');
  assert.strictEqual(unavailable.status, 503, 'bij een storing wordt niets zonder controle opgeslagen');
  assert.deepStrictEqual(await fresh.verify(legacy, { previous: () => legacy }), { ok: true }, 'ook bij een storing blijft een ongewijzigd adres opslaan');
});

test('offerte en melding: het adres moet kloppen met postcode en huisnummer (server vertrouwt de browser niet)', async () => {
  const world = await setup();
  const { admin } = world;
  const lines = [{ section: 'materiaal', code: 'SPR', description: 'Sproeier', qty: 1, unit: 'st', price: 20, vat: 21 }];
  /**
   * Een offerte met dit klantadres.
   * @param {string} address Het adres.
   * @returns {object} De body voor POST /api/quotes.
   */
  const quoteWith = (address) => ({ data: { title: 'Aanleg', customer: { name: 'Fam. Jansen', address }, lines } });
  const wrongCity = await admin.post('/api/quotes', quoteWith('Tuinstraat 1\n8071 AB Amsterdam'));
  assert.strictEqual(wrongCity.status, 400);
  assert.strictEqual(wrongCity.body.error, 'invalid_address');
  assert.strictEqual((await admin.post('/api/quotes', quoteWith('Dorpsstraat 1, Nunspeet'))).status, 400, 'geen postcode');
  const good = await admin.post('/api/quotes', quoteWith('Tuinstraat 1\n8071 AB Nunspeet'));
  assert.strictEqual(good.status, 201);
  assert.strictEqual((await admin.post('/api/quotes', quoteWith(''))).status, 201, 'zonder adres kan het nog');
  const tampered = await admin.put(`/api/quotes/${good.body.id}`, quoteWith('Tuinstraat 1\n8071 AB Elburg'));
  assert.strictEqual(tampered.status, 400);
  assert.strictEqual((await admin.put(`/api/quotes/${good.body.id}`, quoteWith('Tuinstraat 1\n8071 AB Nunspeet'))).status, 200);
});

test('afrekenen: straat en woonplaats komen uit PDOK, niet uit de browser', async () => {
  const world = await setup();
  const { base } = world;
  const customer = world.shoppers[0].client;
  await postForm(base, customer, '/winkel/winkelwagen/', { action: 'add', code: 'BUS', qty: '1' });
  const fields = { name: 'Piet Tuin', email: 'piet@voorbeeld.nl', shippingMethod: 'dpd', country: 'NL', terms: 'ja', postcode: '8071ab', street: 'tuinstraat 1', city: 'Amsterdam' };
  const wrongStreet = await postCheckout(base, customer, { ...fields, street: 'Dorpsstraat 1' });
  assert.strictEqual(wrongStreet.status, 400);
  assert.match(wrongStreet.text, /klopt niet met de postcode/);
  const placed = await postCheckout(base, customer, fields);
  assert.strictEqual(placed.status, 303, 'de verkeerde woonplaats uit de browser wordt vervangen');
  const list = await world.admin.get('/api/admin/web-orders');
  const detail = await world.admin.get(`/api/admin/web-orders/${list.body.items[0].id}`);
  assert.deepStrictEqual([detail.body.order.address.street, detail.body.order.address.postcode, detail.body.order.address.city], ['Tuinstraat 1', '8071 AB', 'Nunspeet']);
});

test('frontendcomponent: het adresveld is alleen-lezen en een mislukte opzoeking wist het en blokkeert het formulier', async () => {
  const sandbox = { window: {}, document: { readyState: 'complete', querySelectorAll: () => [], getElementById: () => ({}) }, console, AbortController, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ADDRESS_LOOKUP_FILE, 'utf8'), sandbox);
  const lookup = sandbox.window.AddressLookup;
  /**
   * Eenvoudig invoerveld.
   * @param {string} value Beginwaarde.
   * @returns {object} Het nagebootste veld.
   */
  const makeInput = (value) => ({ value, addEventListener: () => {} });
  const statusElement = { textContent: '', dataset: {} };
  let cleared = 0;
  let status = 200;
  const component = lookup.attach({
    postcodeInput: makeInput('8071 AB'), numberInput: makeInput('1'), statusElement, endpoint: 'adres/', onFound: () => {}, onClear: () => { cleared += 1; },
    fetchImpl: async () => ({ ok: status === 200, status, json: async () => ({ found: false }) }),
  });
  assert.strictEqual(component.hasProblem(), false);
  await component.check();
  assert.strictEqual(cleared, 1, 'geen treffer wist het adres');
  assert.strictEqual(component.hasProblem(), true, 'zonder adres geen verzending');
  assert.doesNotMatch(statusElement.textContent, /zelf in/);
  const source = fs.readFileSync(ADDRESS_LOOKUP_FILE, 'utf8');
  assert.match(source, /field\.readOnly = true/);
});

test('adrestekst ontleden: cijfers in de straatnaam tellen niet mee en een losse toevoeging hoort bij het huisnummer', () => {
  assert.strictEqual(addressCandidates('Plein 1940-1945 12, 8071 AB Nunspeet')[0].houseNumber, '12');
  const split = addressCandidates('Tuinstraat 12 A, 8071 AB Nunspeet')[0];
  assert.deepStrictEqual([split.houseNumber, split.suffix], ['12', 'A']);
});

test('adrescontrole: een adres dat geen tekst is wordt geweigerd', async () => {
  const world = await setup();
  const rejected = await world.admin.post('/api/quotes', { data: { title: 'Aanleg', customer: { name: 'Fam. Jansen', address: ['Dorpsstraat 1, Amsterdam'] }, lines: [] } });
  assert.strictEqual(rejected.status, 400);
});

test('afrekenen: een ongeldige postcode of lege straat geeft een foutmelding in plaats van ongecontroleerd opslaan', async () => {
  const world = await setup();
  const customer = world.shoppers[0].client;
  await postForm(world.base, customer, '/winkel/winkelwagen/', { action: 'add', code: 'BUS', qty: '1' });
  const fields = { name: 'Piet Tuin', email: 'piet@voorbeeld.nl', shippingMethod: 'dpd', country: 'NL', terms: 'ja', street: 'Verzonnenlaan 1', city: 'Nergens' };
  const bad = await postCheckout(world.base, customer, { ...fields, postcode: '0000AB' });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.text, /geldige postcode/);
});

test('adrestekst ontleden: twee losse getallen en zeer lange cijferreeksen', () => {
  const readings = addressCandidates('Tuinstraat 12 2, 8071 AB Nunspeet').map((candidate) => `${candidate.houseNumber}|${candidate.suffix}`);
  assert.ok(readings.includes('12|2'), 'huisnummer 12 met toevoeging 2');
  assert.ok(readings.includes('2|'), 'ook alleen huisnummer 2');
  const long = addressCandidates(`Tuinstraat ${'1'.repeat(5000)}, 8071 AB Nunspeet`);
  assert.ok(long.length <= 10 && long.every((candidate) => candidate.houseNumber.length <= 5 && candidate.suffix.length <= 6));
});

test('adrestekst ontleden: beide lezingen blijven behouden', () => {
  const readings = addressCandidates('Tuinstraat 12 123, 8071 AB Nunspeet').map((candidate) => `${candidate.houseNumber}|${candidate.suffix}`);
  assert.ok(readings.includes('12|123'));
});

test('adrescontrole: alleen leestekens is geen adres', async () => {
  const guard = createAddressGuard(createAddressLookup({ fetchImpl: createPdokFake().fetchImpl }));
  assert.strictEqual((await guard.verify(',')).ok, false);
  assert.strictEqual((await guard.verify(' - ,', { previous: () => '' })).ok, false);
  assert.strictEqual((await guard.verify('   ')).ok, true, 'alleen spaties telt als geen adres');
});

test('frontendcomponent: typen wist het adres niet en bij een inactieve opzoeking blijft alles ongemoeid', () => {
  const lookup = loadComponent();
  const listeners = [];
  const postcodeInput = { value: '8071 AB', addEventListener: (name, handler) => { if (name === 'input') listeners.push(handler); } };
  const numberInput = { value: '1', addEventListener: () => {} };
  const statusElement = { textContent: '', dataset: {} };
  let active = true;
  let cleared = 0;
  const component = lookup.attach({ postcodeInput, numberInput, statusElement, endpoint: 'adres/', isActive: () => active, onFound: () => {}, onClear: () => { cleared += 1; } });
  listeners[0]();
  assert.strictEqual(cleared, 0, 'typen wist het opgeslagen adres niet');
  assert.strictEqual(component.hasProblem(), true, 'maar verzenden kan pas na een treffer');
  active = false;
  component.reset();
  listeners[0]();
  assert.strictEqual(cleared, 0);
});

test('frontendcomponent: onvolledige invoer na een adres houdt het formulier geblokkeerd', async () => {
  const lookup = loadComponent();
  const listeners = [];
  const postcodeInput = { value: '80', addEventListener: (name, handler) => { if (name === 'input') listeners.push(handler); } };
  const statusElement = { textContent: '', dataset: {} };
  const component = lookup.attach({ postcodeInput, numberInput: { value: '1', addEventListener: () => {} }, statusElement, endpoint: 'adres/', onFound: () => {} });
  listeners[0]();
  await component.check();
  assert.strictEqual(component.hasProblem(), true, 'zonder nieuwe treffer blijft verzenden geblokkeerd');
  assert.match(statusElement.textContent, /postcode en huisnummer/);
});
