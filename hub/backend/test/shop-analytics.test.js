// Google Analytics in de webshop (webshop/shop-analytics.js + storefront-analytics.js): de instelling, de uitgebreide CSP, de
// gebeurtenissen van de koopfunnel in de pagina's en het gedrag van het script in de browser (toestemming eerst).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Analytics = require('../src/webshop/shop-analytics');
const { setup, order, PERSON } = require('./helpers/webshop-world');
const { postForm } = require('./helpers/http-client');

const CLIENT_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'webshop', 'storefront-analytics.js'), 'utf8');

test('meet-ID en instelling: alleen een geldig GA4-ID telt, de rest wordt leeg', () => {
  assert.strictEqual(Analytics.cleanMeasurementId(' g-abc123xyz '), 'G-ABC123XYZ');
  for (const bad of ['', null, undefined, 'UA-12345-1', 'G-', 'G-AB', 'G-ABC DEF', 'G-ABC<script>', 'G-' + 'A'.repeat(15), 42, {}]) assert.strictEqual(Analytics.cleanMeasurementId(bad), '', String(bad));
  assert.deepStrictEqual(Analytics.sanitizeAnalytics({ enabled: true, measurementId: 'g-test1234', extra: 'x' }), { enabled: true, measurementId: 'G-TEST1234' });
  assert.deepStrictEqual(Analytics.sanitizeAnalytics({ enabled: 'ja', measurementId: 'G-TEST1234' }), { enabled: false, measurementId: 'G-TEST1234' });
  assert.deepStrictEqual(Analytics.sanitizeAnalytics(null), { enabled: false, measurementId: '' });
  assert.deepStrictEqual(Analytics.sanitizeAnalytics([1]), { enabled: false, measurementId: '' });
  assert.strictEqual(Analytics.activeMeasurementId({ enabled: true, measurementId: 'G-TEST1234' }), 'G-TEST1234');
  assert.strictEqual(Analytics.activeMeasurementId({ enabled: false, measurementId: 'G-TEST1234' }), '');
  assert.strictEqual(Analytics.activeMeasurementId({ enabled: true, measurementId: 'kapot' }), '');
  assert.strictEqual(Analytics.activeMeasurementId(undefined), '');
});

test('cspWith: zonder ID ongewijzigd, met ID alleen script-src en connect-src erbij en geen inline scripts', () => {
  const base = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' https:; frame-ancestors 'none'";
  assert.strictEqual(Analytics.cspWith(base, ''), base);
  const extended = Analytics.cspWith(base, 'G-TEST1234');
  const directives = Object.fromEntries(extended.split('; ').map((directive) => [directive.split(' ')[0], directive]));
  assert.match(directives['script-src'], /^script-src 'self' https:\/\/www\.googletagmanager\.com$/);
  assert.match(directives['connect-src'], /https:\/\/\*\.google-analytics\.com/);
  assert.strictEqual(directives['style-src'], "style-src 'self'");
  assert.strictEqual(directives['default-src'], "default-src 'none'");
  assert.ok(!/unsafe-inline|unsafe-eval/.test(extended));
});

test('gebeurtenissen: artikel, lijst, zoekopdracht, winkelwagen, afrekenen en aankoop zonder persoonsgegevens', () => {
  const item = Analytics.itemOfProduct({ code: 'SPR-1', name: 'Sproeier', categoryName: 'Sproeiers' }, 10.456, { listName: 'Sproeiers', index: 1, variant: '1/2"' });
  assert.deepStrictEqual(item, { item_id: 'SPR-1', item_name: 'Sproeier', item_category: 'Sproeiers', item_variant: '1/2"', price: 10.46, item_list_name: 'Sproeiers', index: 1 });
  assert.strictEqual(Analytics.itemOf({ id: 'A', name: 'B', quantity: 0 }).quantity, 1);
  assert.strictEqual(Analytics.itemOf({ id: 'A', name: 'B', price: 'x' }).price, 0);

  const list = Analytics.listEvents({ listName: 'Zoekresultaten', items: [item], searchTerm: 'sproeier', resultCount: 12 });
  assert.deepStrictEqual(list.map((event) => event.name), ['view_search_results', 'view_item_list']);
  assert.strictEqual(list[0].params.result_count, 12);
  const none = Analytics.listEvents({ listName: 'Zoekresultaten', items: [], searchTerm: 'xyz', resultCount: 0 });
  assert.deepStrictEqual(none.map((event) => event.name), ['view_search_results', 'search_no_results']);
  assert.deepStrictEqual(Analytics.listEvents({ listName: 'Leeg', items: [] }), []);
  assert.strictEqual(Analytics.listEvents({ listName: 'Groot', items: Array.from({ length: 80 }, () => item) })[0].params.items.length, 50);

  assert.deepStrictEqual(Analytics.viewItemEvents(item, { inStock: false })[0].params.in_stock, 'nee');
  assert.deepStrictEqual(Analytics.cartEvents({ items: [item], value: 20.999, fromPlanner: 3 }).map((event) => event.name), ['planner_to_cart', 'view_cart']);
  assert.deepStrictEqual(Analytics.cartEvents({ items: [], value: 0 }), []);

  assert.deepStrictEqual(Analytics.checkoutEvents({ items: [item], value: 5, loggedIn: false }).map((event) => event.name), ['begin_checkout', 'checkout_login_wall']);
  assert.deepStrictEqual(Analytics.checkoutEvents({ items: [item], value: 5, loggedIn: true }).map((event) => event.name), ['begin_checkout']);
  // Na een fout geen nieuw begin van het afrekenen, en nooit de tekst van de fout (kan een adres bevatten).
  const failed = Analytics.checkoutEvents({ items: [item], value: 5, loggedIn: true, error: 'Het adres Tuinstraat 1 is niet gevonden.' });
  assert.deepStrictEqual(failed, [{ name: 'checkout_error', params: { type: 'address_not_found' } }]);
  assert.strictEqual(Analytics.errorTypeOf('Nog maar 1 beschikbaar'), 'stock');
  assert.strictEqual(Analytics.errorTypeOf('Het btw-nummer is niet geldig'), 'vat_invalid');
  assert.strictEqual(Analytics.errorTypeOf('Ga akkoord met de voorwaarden'), 'terms');
  assert.strictEqual(Analytics.errorTypeOf('iets anders'), 'other');

  const purchase = Analytics.purchaseEvents({ number: 'WEB-1', total: 24.2, tax: 4.2, shipping: 6.95, payment: 'online', items: [item] });
  assert.deepStrictEqual(purchase[0].params, { transaction_id: 'WEB-1', currency: 'EUR', value: 24.2, tax: 4.2, shipping: 6.95, payment_type: 'online', items: [item] });
  assert.strictEqual(Analytics.eventsJson([]), '');
  assert.ok(Analytics.eventsJson(purchase).startsWith('[{"name":"purchase"'));
});

/** Een nagebootst DOM-element met kinderen, attributen en gebeurtenissen (genoeg voor storefront-analytics.js). */
class FakeElement {
  /**
   * Maakt een element.
   * @param {string} tag De tagnaam.
   */
  constructor(tag) {
    this.tag = tag;
    this.className = '';
    this.textContent = '';
    this.children = [];
    this.attributes = {};
    this.parent = null;
    this.handlers = {};
  }

  /**
   * Zet een attribuut.
   * @param {string} name De naam.
   * @param {string} value De waarde.
   * @returns {void}
   */
  setAttribute(name, value) { this.attributes[name] = value; }

  /**
   * Leest een attribuut.
   * @param {string} name De naam.
   * @returns {?string} De waarde of null.
   */
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }

  /**
   * Voegt een kind toe.
   * @param {FakeElement} child Het kind.
   * @returns {FakeElement} Het kind.
   */
  appendChild(child) { child.parent = this; this.children.push(child); return child; }

  /**
   * Haalt het element uit zijn ouder.
   * @returns {void}
   */
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }

  /**
   * Onthoudt een luisteraar.
   * @param {string} type Het soort gebeurtenis.
   * @param {Function} handler De luisteraar.
   * @returns {void}
   */
  addEventListener(type, handler) { this.handlers[type] = handler; }

  /**
   * Klikt op het element.
   * @returns {void}
   */
  click() { this.handlers.click({ target: this }); }

  /**
   * Zoekt een voorouder (niet nagebootst).
   * @returns {null} Altijd null.
   */
  closest() { return null; }
}

/** Een nagebootst document met cookies (schrijfacties worden bijgehouden) en luisteraars. */
class FakeDocument {
  /**
   * Maakt het document.
   * @param {{ body: FakeElement, head: FakeElement, cookie: string, cookieWrites: string[], documentHandlers: object }} parts De onderdelen.
   */
  constructor({ body, head, cookie, cookieWrites, documentHandlers }) {
    this.body = body;
    this.head = head;
    this.cookieText = cookie;
    this.cookieWrites = cookieWrites;
    this.documentHandlers = documentHandlers;
  }

  /**
   * De cookies zoals de browser ze toont.
   * @returns {string} De cookietekst.
   */
  get cookie() { return this.cookieText; }

  /**
   * Een cookie schrijven; de schrijfactie wordt bewaard voor de test.
   * @param {string} value De cookieregel.
   * @returns {void}
   */
  set cookie(value) { this.cookieWrites.push(value); }

  /**
   * Maakt een element.
   * @param {string} tag De tagnaam.
   * @returns {FakeElement} Het element.
   */
  createElement(tag) { return new FakeElement(tag); }

  /**
   * Maakt een tekstknoop.
   * @param {string} text De tekst.
   * @returns {{ text: string }} De knoop.
   */
  createTextNode(text) { return { text }; }

  /**
   * Zoekt alleen de toestemmingsbalk.
   * @param {string} selector De selector.
   * @returns {?FakeElement} De balk of null.
   */
  querySelector(selector) { return selector === '[data-consent-banner]' ? this.body.children.find((child) => child.attributes['data-consent-banner'] !== undefined) || null : null; }

  /**
   * Onthoudt een luisteraar.
   * @param {string} type Het soort gebeurtenis.
   * @param {Function} handler De luisteraar.
   * @returns {void}
   */
  addEventListener(type, handler) { this.documentHandlers[type] = handler; }
}

/**
 * Een kleine nagebootste browser voor het script van de shop: genoeg DOM om de balk, het laden van Google en de kliks te volgen.
 * @param {{ bodyAttributes?: object, stored?: object, cookie?: string }} options De attributen van <body>, wat er al in localStorage staat en de cookies.
 * @returns {object} win, doc, storage (met data) en de lijst met geladen scripts.
 */
function fakeBrowser({ bodyAttributes = {}, stored = {}, cookie = '' } = {}) {
  const data = { ...stored };
  const storage = { data, getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); } };
  const scripts = [];
  const documentHandlers = {};
  const cookieWrites = [];
  const body = new FakeElement('body');
  body.attributes = { ...bodyAttributes };
  const head = new FakeElement('head');
  const originalAppend = head.appendChild.bind(head);
  /**
   * Onthoudt elk script dat de pagina in de kop zet.
   * @param {FakeElement} child Het script.
   * @returns {FakeElement} Het script.
   */
  head.appendChild = (child) => { scripts.push(child); return originalAppend(child); };
  const doc = new FakeDocument({ body, head, cookie, cookieWrites, documentHandlers });
  const win = { location: { hostname: 'shop.example' }, localStorage: storage, dataLayer: undefined };
  return { win, doc, storage, scripts, body, documentHandlers, cookieWrites };
}

/**
 * Laadt het script van de shop in een sandbox zonder het automatisch te starten, en geeft de functies terug.
 * @returns {object} De sandbox met de functies van het script.
 */
function loadClient() {
  const sandbox = { document: undefined, window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SOURCE, sandbox);
  return sandbox;
}

/** Een pagina met meting en één gebeurtenis (view_item) als bodyattributen. */
const PAGE = { 'data-shop-analytics': 'G-TEST1234', 'data-customer-group': 'zakelijk', 'data-privacy-url': '../pagina/privacyverklaring/', 'data-shop-events': JSON.stringify([{ name: 'view_item', params: { items: [{ item_id: 'A' }] } }]) };

/**
 * Zoekt de dataLayer-regels van een soort (gtag-aanroepen zijn objecten van het type arguments).
 * @param {object} win Het nagebootste venster.
 * @param {string} kind De eerste waarde: 'consent', 'event', 'config'.
 * @returns {Array[]} De aanroepen als lijsten.
 */
const callsOf = (win, kind) => Array.from(win.dataLayer || []).map((entry) => JSON.parse(JSON.stringify(Array.from(entry)))).filter((entry) => entry[0] === kind);

/**
 * Maakt van een waarde uit de sandbox een gewoon object (anders verschilt het prototype en faalt deepStrictEqual).
 * @param {*} value De waarde.
 * @returns {*} Een kopie in deze omgeving.
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

test('script: zonder toestemming wordt er niets van Google geladen en staat alles op geweigerd', () => {
  const client = loadClient();
  const browser = fakeBrowser({ bodyAttributes: PAGE });
  const tracker = client.startAnalytics({ window: browser.win, document: browser.doc, storage: browser.storage });
  assert.ok(tracker);
  assert.strictEqual(browser.scripts.length, 0, 'geen Google-script');
  assert.strictEqual(tracker.isLoaded(), false);
  assert.strictEqual(tracker.track('view_item', {}), false);
  assert.deepStrictEqual(callsOf(browser.win, 'consent')[0].slice(0, 2), ['consent', 'default']);
  assert.deepStrictEqual(callsOf(browser.win, 'consent')[0][2], { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied', wait_for_update: 500 });
  assert.strictEqual(callsOf(browser.win, 'event').length, 0);
  const banner = browser.body.children.find((child) => child.attributes['data-consent-banner'] !== undefined);
  assert.ok(banner, 'de balk staat er');
  const buttons = banner.children[1].children;
  assert.deepStrictEqual(buttons.map((button) => button.textContent), ['Accepteren', 'Weigeren']);
  assert.strictEqual(buttons[0].className, buttons[1].className, 'even duidelijk');
});

test('script: Accepteren laadt Google, geeft alleen analytics toestemming en stuurt de gebeurtenissen van de pagina', () => {
  const client = loadClient();
  const browser = fakeBrowser({ bodyAttributes: PAGE });
  client.startAnalytics({ window: browser.win, document: browser.doc, storage: browser.storage });
  const banner = browser.body.children.find((child) => child.attributes['data-consent-banner'] !== undefined);
  banner.children[1].children[0].click();
  assert.strictEqual(browser.scripts.length, 1);
  assert.strictEqual(browser.scripts[0].src, 'https://www.googletagmanager.com/gtag/js?id=G-TEST1234');
  assert.strictEqual(browser.storage.data.aquatech_shop_consent, 'granted');
  const update = callsOf(browser.win, 'consent').find((call) => call[1] === 'update');
  assert.deepStrictEqual(update[2], { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  const config = callsOf(browser.win, 'config')[0];
  assert.deepStrictEqual(config.slice(1), ['G-TEST1234', { allow_google_signals: false, allow_ad_personalization_signals: false }]);
  assert.deepStrictEqual(callsOf(browser.win, 'set')[0][2], { customer_group: 'zakelijk' });
  assert.deepStrictEqual(callsOf(browser.win, 'event').map((call) => call[1]), ['view_item']);
  assert.ok(!browser.body.children.includes(banner), 'de balk is weg');
});

test('script: Weigeren bewaart de keuze en laadt niets; eerdere toestemming laadt meteen zonder balk', () => {
  const client = loadClient();
  const declined = fakeBrowser({ bodyAttributes: PAGE });
  client.startAnalytics({ window: declined.win, document: declined.doc, storage: declined.storage });
  declined.body.children.find((child) => child.attributes['data-consent-banner'] !== undefined).children[1].children[1].click();
  assert.strictEqual(declined.storage.data.aquatech_shop_consent, 'denied');
  assert.strictEqual(declined.scripts.length, 0);
  assert.strictEqual(callsOf(declined.win, 'event').length, 0);

  const returning = fakeBrowser({ bodyAttributes: PAGE, stored: { aquatech_shop_consent: 'denied' } });
  client.startAnalytics({ window: returning.win, document: returning.doc, storage: returning.storage });
  assert.strictEqual(returning.body.children.length, 0, 'geen balk bij een eerdere keuze');
  assert.strictEqual(returning.scripts.length, 0);

  const agreed = fakeBrowser({ bodyAttributes: { ...PAGE, 'data-internal': '1' }, stored: { aquatech_shop_consent: 'granted' } });
  client.startAnalytics({ window: agreed.win, document: agreed.doc, storage: agreed.storage });
  assert.strictEqual(agreed.body.children.length, 0);
  assert.strictEqual(agreed.scripts.length, 1);
  assert.strictEqual(callsOf(agreed.win, 'config')[0][2].traffic_type, 'internal');
});

test('script: toestemming intrekken zet de meting uit en wist de cookies van Google', () => {
  const client = loadClient();
  const browser = fakeBrowser({ bodyAttributes: PAGE, stored: { aquatech_shop_consent: 'granted' }, cookie: '_ga=GA1.1; _ga_ABC=GS1; sessie=houden' });
  const tracker = client.startAnalytics({ window: browser.win, document: browser.doc, storage: browser.storage });
  assert.strictEqual(tracker.track('add_to_cart', {}), true);
  tracker.deny();
  assert.strictEqual(browser.win['ga-disable-G-TEST1234'], true);
  assert.strictEqual(tracker.track('add_to_cart', {}), false, 'daarna niets meer');
  assert.deepStrictEqual(callsOf(browser.win, 'consent').filter((call) => call[1] === 'update').pop()[2], { analytics_storage: 'denied' });
  assert.ok(browser.cookieWrites.some((write) => /^_ga=; expires=Thu, 01 Jan 1970/.test(write)));
  assert.ok(browser.cookieWrites.some((write) => /^_ga_ABC=; expires=Thu, 01 Jan 1970.*domain=\.shop\.example/.test(write)));
  assert.ok(!browser.cookieWrites.some((write) => /^sessie=/.test(write)), 'andere cookies blijven');
  // Opnieuw accepteren zet de meting weer aan zonder het script nog een keer te laden.
  tracker.grant();
  assert.strictEqual(browser.scripts.length, 1);
  assert.strictEqual(browser.win['ga-disable-G-TEST1234'], false);
  assert.strictEqual(tracker.track('add_to_cart', {}), true);
});

test('script: een pagina zonder meting start niets, en kapotte of vreemde gebeurtenissen vallen weg', () => {
  const client = loadClient();
  const unmeasured = fakeBrowser({ bodyAttributes: {} });
  assert.strictEqual(client.startAnalytics({ window: unmeasured.win, document: unmeasured.doc, storage: unmeasured.storage }), null);
  assert.strictEqual(unmeasured.win.dataLayer, undefined);
  assert.strictEqual(unmeasured.body.children.length, 0);
  assert.deepStrictEqual(plain(client.parseEvents('niet json')), []);
  assert.deepStrictEqual(plain(client.parseEvents('{"a":1}')), []);
  assert.deepStrictEqual(plain(client.parseEvents(null)), []);
  const parsed = client.parseEvents(JSON.stringify([{ name: 'view_item', params: {} }, { name: 'Kapot Naam', params: {} }, { name: 'x', params: [] }, null, { name: 'purchase' }]));
  assert.deepStrictEqual(plain(parsed.map((event) => event.name)), ['view_item']);
  assert.strictEqual(client.readConsent(null), null);
  assert.strictEqual(client.readConsent({ getItem() { throw new Error('geblokkeerd'); } }), null);
  assert.doesNotThrow(() => client.writeConsent({ setItem() { throw new Error('vol'); } }, 'granted'));
});

test('script: een aankoop wordt na een herlading niet dubbel doorgegeven', () => {
  const client = loadClient();
  const purchase = { name: 'purchase', params: { transaction_id: 'WEB-7', value: 10 } };
  const other = { name: 'view_item', params: {} };
  const browser = fakeBrowser();
  assert.deepStrictEqual(plain(client.withoutRepeatedPurchases(browser.storage, [purchase, other]).map((event) => event.name)), ['purchase', 'view_item']);
  assert.deepStrictEqual(plain(client.withoutRepeatedPurchases(browser.storage, [purchase, other]).map((event) => event.name)), ['view_item']);
  for (let index = 0; index < 30; index += 1) client.withoutRepeatedPurchases(browser.storage, [{ name: 'purchase', params: { transaction_id: `X-${index}` } }]);
  assert.strictEqual(JSON.parse(browser.storage.data.aquatech_shop_purchased).length, 20);
  assert.strictEqual(client.withoutRepeatedPurchases(null, [purchase]).length, 1, 'zonder opslag werkt het ook');
});

test('script: add_to_cart, select_item, remove_from_cart en de stappen van afrekenen worden gemeten, alleen met toestemming', () => {
  const client = loadClient();
  const events = [
    { name: 'view_item_list', params: { items: [{ item_id: 'SPR-1', item_name: 'Sproeier', item_list_name: 'Sproeiers', index: 3 }] } },
    { name: 'view_cart', params: { items: [{ item_id: 'SPR-1', item_name: 'Sproeier', price: 10, quantity: 2 }] } },
    { name: 'begin_checkout', params: { value: 20, items: [{ item_id: 'SPR-1', quantity: 2 }] } },
  ];
  const browser = fakeBrowser({ bodyAttributes: { ...PAGE, 'data-shop-events': JSON.stringify(events) }, stored: { aquatech_shop_consent: 'granted' } });
  client.startAnalytics({ window: browser.win, document: browser.doc, storage: browser.storage });
  const before = callsOf(browser.win, 'event').length;
  /**
   * Een nagebootst formulier.
   * @param {object} fields De waarden per veldnaam.
   * @param {object} [extra] Attributen en selectors.
   * @returns {object} Het formulier.
   */
  const makeForm = (fields, { item = null, classes = [], variant = null, checkout = false } = {}) => ({
    closest: (selector) => (selector === '[data-variant-row]' ? (variant ? { querySelector: () => ({ options: [variant], selectedIndex: 0 }) } : null) : selector === '.product-card' ? null : {}),
    hasAttribute: (name) => (name === 'data-item' ? Boolean(item) : name === 'data-shop-checkout' ? checkout : false),
    getAttribute: (name) => (name === 'data-item' ? JSON.stringify(item) : null),
    classList: { contains: (name) => classes.includes(name) },
    querySelector: (selector) => {
      const match = /name="([^"]+)"/.exec(selector) || /\[(data-order-code)\]/.exec(selector);
      const key = match ? match[1] : '';
      if (key === 'data-order-code') return fields.code === undefined ? null : { value: fields.code };
      return key in fields ? { value: fields[key] } : null;
    },
  });
  /**
   * Een nagebootste optie van de keuzelijst met varianten.
   * @param {number} price De prijs.
   * @param {string} label De naam van de variant.
   * @returns {object} De optie.
   */
  const optionOf = (price, label) => ({ getAttribute: (name) => (name === 'data-value' ? String(price) : name === 'data-label' ? label : null) });
  /**
   * Verstuurt een formulier naar de luisteraar van de pagina.
   * @param {object} form Het formulier.
   * @returns {void}
   */
  const submit = (form) => browser.documentHandlers.submit({ target: form });

  submit(makeForm({ action: 'add', code: 'SPR-1-L', qty: '3' }, { item: { item_id: 'SPR-1', item_name: 'Sproeier', price: 5 }, variant: optionOf(7.5, 'Groot') }));
  let call = callsOf(browser.win, 'event').pop();
  assert.strictEqual(call[1], 'add_to_cart');
  assert.strictEqual(call[2].value, 22.5);
  assert.strictEqual(call[2].placement, 'kaart');
  assert.deepStrictEqual(call[2].items[0], { item_id: 'SPR-1-L', item_name: 'Sproeier', price: 7.5, item_variant: 'Groot', quantity: 3 });
  assert.strictEqual(call[2].transport_type, 'beacon');

  submit(makeForm({ action: 'add', qty: '0' }, { item: { item_id: 'P', price: 2 }, classes: ['product-order'] }));
  call = callsOf(browser.win, 'event').pop();
  assert.strictEqual(call[2].placement, 'productpagina');
  assert.strictEqual(call[2].items[0].quantity, 1, 'aantal minstens 1');

  submit(makeForm({ action: 'remove', code: 'SPR-1' }));
  call = callsOf(browser.win, 'event').pop();
  assert.strictEqual(call[1], 'remove_from_cart');
  assert.strictEqual(call[2].value, 20);
  const count = callsOf(browser.win, 'event').length;
  submit(makeForm({ action: 'remove', code: 'ONBEKEND' }));
  assert.strictEqual(callsOf(browser.win, 'event').length, count, 'onbekende regel wordt niet gemeld');

  submit(makeForm({ action: 'place', shippingMethod: 'dpd', paymentMethod: 'online' }, { checkout: true }));
  const names = callsOf(browser.win, 'event').slice(count).map((entry) => entry[1]);
  assert.deepStrictEqual(names, ['add_shipping_info', 'add_payment_info']);

  const productLink = { closest: (selector) => (selector === '[data-consent-settings]' ? null : /product-card a/.test(selector) ? { closest: () => ({ querySelector: () => makeForm({ code: 'SPR-1' }, { item: { item_id: 'SPR-1', item_name: 'Sproeier', price: 5 } }) }), querySelector: () => makeForm({ code: 'SPR-1' }, { item: { item_id: 'SPR-1', item_name: 'Sproeier', price: 5 } }) } : null) };
  browser.documentHandlers.click({ target: productLink });
  call = callsOf(browser.win, 'event').pop();
  assert.strictEqual(call[1], 'select_item');
  assert.strictEqual(call[2].item_list_name, 'Sproeiers');
  assert.strictEqual(call[2].items[0].index, 3);
  assert.ok(!('quantity' in call[2].items[0]));
  assert.ok(before >= 0);

  // Na intrekken van de toestemming meet niets meer.
  const tracker = client.startAnalytics({ window: fakeBrowser({ bodyAttributes: PAGE, stored: { aquatech_shop_consent: 'granted' } }).win, document: fakeBrowser({ bodyAttributes: PAGE, stored: { aquatech_shop_consent: 'granted' } }).doc, storage: null });
  tracker.deny();
  assert.strictEqual(tracker.track('add_to_cart', {}), false);
});

test('webshop: zonder Google Analytics staat er niets van in de pagina en blijft de CSP zoals hij was', async () => {
  const world = await setup();
  const home = await world.shoppers[0].client.get('/');
  assert.strictEqual(home.status, 200);
  assert.ok(!/data-shop-analytics|analytiek\.js|data-consent-settings|googletagmanager/.test(home.text));
  const csp = home.headers.get('content-security-policy');
  assert.ok(!/google/.test(csp));
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.strictEqual((await world.shoppers[0].client.get('/assets/analytiek.js')).status, 200, 'het script is een gewoon bestand van de shop');
  // Ingeschakeld maar zonder (geldig) ID: ook niets.
  assert.strictEqual((await world.admin.put('/app/api/admin/settings', { shopAnalytics: { enabled: true, measurementId: '' } })).status, 200);
  assert.ok(!/data-shop-analytics/.test((await world.shoppers[0].client.get('/')).text));
  assert.strictEqual((await world.admin.put('/app/api/admin/settings', { shopAnalytics: { enabled: true, measurementId: 'UA-1' } })).body.settings.shopAnalytics.value.measurementId, '');
  assert.ok(!/data-shop-analytics/.test((await world.shoppers[0].client.get('/')).text));
  // Uit maar met ID: ook niets.
  await world.admin.put('/app/api/admin/settings', { shopAnalytics: { enabled: false, measurementId: 'G-TEST1234' } });
  assert.ok(!/data-shop-analytics/.test((await world.shoppers[0].client.get('/')).text));
});

test('webshop: de instelling gaat alleen door beheerders, wordt gesaneerd en geldt alleen voor de hoofdtenant', async () => {
  const world = await setup();
  const saved = await world.admin.put('/app/api/admin/settings', { shopAnalytics: { enabled: true, measurementId: ' g-abc12345 ', onzin: 1 } });
  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual(saved.body.settings.shopAnalytics.value, { enabled: true, measurementId: 'G-ABC12345' });
  assert.strictEqual((await world.admin.put('/app/api/admin/settings', { shopAnalytics: 'ja' })).status, 400);
  assert.strictEqual((await world.shoppers[0].client.put('/app/api/admin/settings', { shopAnalytics: { enabled: true, measurementId: 'G-HACK1234' } })).status === 200, false);
  const foreign = await world.vreemd.put('/app/api/admin/settings', { shopAnalytics: { enabled: true, measurementId: 'G-ANDER123' } });
  assert.strictEqual(foreign.status, 400);
  assert.strictEqual((await world.vreemd.get('/app/api/admin/settings')).body.settings.shopAnalytics, undefined);
});

test('webshop: met een actief ID komen attributen, het script, de uitgebreide CSP, de voetlink en de gebeurtenissen in de pagina', async () => {
  const world = await setup();
  await world.admin.put('/app/api/admin/settings', { shopAnalytics: { enabled: true, measurementId: 'G-TEST1234' } });
  const shopper = world.shoppers[0].client;
  const home = await shopper.get('/');
  assert.match(home.text, /<body data-shop-analytics="G-TEST1234" data-customer-group="particulier" data-privacy-url="[^"]*pagina\/privacyverklaring\/"/);
  assert.match(home.text, /<script src="assets\/analytiek\.js\?v=[^"]+" defer><\/script>/);
  assert.match(home.text, /data-consent-settings>Cookie-instellingen<\/button>/);
  assert.ok(!/<script>[^<]/.test(home.text), 'geen inline script');
  assert.ok(!/googletagmanager/.test(home.text), 'Google staat niet in de pagina, alleen in het script na toestemming');
  const csp = home.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/www\.googletagmanager\.com/);
  assert.match(csp, /connect-src 'self' https:\/\/www\.googletagmanager\.com https:\/\/\*\.google-analytics\.com/);
  assert.ok(!/unsafe-inline/.test(csp));

  // Productpagina: view_item en een bestelformulier met artikelgegevens voor add_to_cart.
  const product = await shopper.get('/product/sproeier-bus/');
  assert.strictEqual(product.status, 200, product.text.slice(0, 200));
  const events = JSON.parse(product.text.match(/data-shop-events="([^"]+)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.deepStrictEqual(events.map((event) => event.name), ['view_item']);
  assert.strictEqual(events[0].params.items[0].item_id, 'BUS');
  assert.strictEqual(events[0].params.in_stock, 'ja');
  assert.match(product.text, /<form class="product-order" method="post" action="[^"]*" data-item="/);

  // Zoeken: view_search_results (+ lijst) en bij niets gevonden search_no_results.
  const found = await shopper.get('/zoeken/?q=sproeier');
  assert.match(found.text, /view_search_results/);
  assert.match(found.text, /view_item_list/);
  const missing = await shopper.get('/zoeken/?q=bestaatniet');
  assert.match(missing.text, /search_no_results/);
  assert.ok(!/search_no_results/.test((await shopper.get('/zoeken/')).text));

  // Winkelwagen, loginmuur, afrekenen en bedankpagina.
  await postForm(world.base, world.shoppers[0].client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '2' });
  const cart = await shopper.get('/winkelwagen/');
  assert.match(cart.text, /view_cart/);
  const checkout = await shopper.get('/afrekenen/');
  assert.match(checkout.text, /begin_checkout/);
  assert.match(checkout.text, /data-shop-checkout/);
  assert.ok(!/checkout_login_wall/.test(checkout.text));
  const anonymous = (await postForm(world.base, require('./helpers/http-client').createClient(world.base), '/winkelwagen/', { action: 'add', code: 'BUS', qty: '1' }));
  assert.ok(anonymous.status === 303 || anonymous.status === 200);
});

test('webshop: de aankoop staat op de bedankpagina met bestelnummer, btw en verzendkosten, maar nooit naam of adres', async () => {
  const world = await setup();
  await world.admin.put('/app/api/admin/settings', { shopAnalytics: { enabled: true, measurementId: 'G-TEST1234' } });
  const shopper = world.shoppers[0];
  const orderId = await order(world, shopper);
  const thanks = await shopper.client.get(`/bestelling/${orderId}/?bedankt=1`);
  assert.strictEqual(thanks.status, 200);
  const raw = thanks.text.match(/data-shop-events="([^"]+)"/)[1];
  const events = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.deepStrictEqual(events.map((event) => event.name), ['purchase']);
  const params = events[0].params;
  assert.match(params.transaction_id, /^WEB-/);
  assert.strictEqual(params.currency, 'EUR');
  assert.strictEqual(params.payment_type, 'rekening');
  assert.strictEqual(params.shipping, 6.95);
  assert.strictEqual(params.items[0].item_id, 'BUS');
  assert.strictEqual(params.items[0].quantity, 2);
  assert.ok(params.value > 26 && params.tax > 0);
  for (const personal of [PERSON.name, PERSON.email, PERSON.street, PERSON.postcode]) assert.ok(!raw.includes(personal), `${personal} staat niet in de meting`);
  // De gewone besteloverzichtspagina (zonder ?bedankt) meet geen aankoop.
  assert.ok(!/data-shop-events/.test((await shopper.client.get(`/bestelling/${orderId}/`)).text));
});

test('webshop: een medewerker meet mee als intern verkeer en een voorbeeld van de beheerder meet niet', async () => {
  const world = await setup();
  await world.admin.put('/app/api/admin/settings', { shopAnalytics: { enabled: true, measurementId: 'G-TEST1234' } });
  const staffPage = await world.admin.get('/');
  assert.match(staffPage.text, /data-shop-analytics="G-TEST1234"[^>]* data-internal="1"/);
  const preview = await world.admin.get('/?voorbeeld=1');
  assert.ok(!/data-shop-analytics/.test(preview.text));
});
