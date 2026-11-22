// Test: heen en weer wisselen tussen Picken, Ontvangen en Tellen in de orderpick-pagina laat altijd precies één scherm zien.
// De twee scripts (orderpick.js en receiving.js) draaien in een vm-sandbox met een minimale nagebootste pagina.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = path.join(__dirname, '..', '..', 'frontend', 'orderpick');
const SECTIONS = ['#op-list', '#op-order', '#op-done', '#rc-list', '#rc-order', '#rc-done', '#ct-list', '#ct-location'];

/**
 * Maakt een nagebootst element dat elke eigenschap en methode accepteert.
 * @param {string} selector De selector waarmee het element werd opgevraagd.
 * @returns {object} Het element.
 */
function fakeElement(selector) {
  const data = { hidden: !selector.match(/^#(op-list)$/) && /^#(op|rc|ct)-(list|order|done|location)$/.test(selector), dataset: {}, value: '', innerHTML: '', textContent: '' };
  return new Proxy(data, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (key === 'closest') return () => null;
      // Bewaart luisteraars, zodat een test op een knop kan klikken.
      if (key === 'addEventListener') return (type, handler) => { (target.listeners = target.listeners || {})[type] = (target.listeners[type] || []).concat(handler); };
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

/**
 * Bouwt de pagina en laadt de vier scripts.
 * @returns {Promise<{ page: object, visible: () => string[] }>} De pagina en een hulpfunctie die de zichtbare schermen geeft.
 */
async function loadPage() {
  const elements = {};
  const listeners = {};
  const document = {
    hidden: false,
    /**
     * Zoekt (en onthoudt) het nagebootste element bij een selector.
     * @param {string} selector De selector.
     * @returns {object} Het element.
     */
    querySelector(selector) { return elements[selector] || (elements[selector] = fakeElement(selector)); },
    /**
     * Bewaart een luisteraar op de pagina.
     * @param {string} type Soort gebeurtenis.
     * @param {Function} handler De luisteraar.
     */
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
  };
  const pushed = [];
  /**
   * Zet pad, zoekdeel en hash van de nagebootste pagina volgens een adres.
   * @param {string} url Het adres, bijvoorbeeld '?id=1' of '/app/orderpick/#tellen'.
   */
  const setAddress = (url) => {
    const [beforeHash, hash] = String(url).split('#');
    const [pathPart, search] = beforeHash.split('?');
    if (pathPart) sandbox.location.pathname = pathPart;
    sandbox.location.search = search ? `?${search}` : '';
    sandbox.location.hash = hash ? `#${hash}` : '';
  };
  const sandbox = {
    document, console, URLSearchParams, Promise, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Number, String, Array, Object,
    navigator: {},
    location: { pathname: '/app/orderpick/', search: '', hash: '' },
    history: {
      /**
       * Zet het adres zoals de browser (zonder nieuwe geschiedenisregel).
       * @param {*} _state Bewaarde stand (niet gebruikt).
       * @param {string} _title Titel (niet gebruikt).
       * @param {string} url Het nieuwe adres.
       */
      replaceState(_state, _title, url) { setAddress(url); },
      /**
       * Zet het adres zoals de browser en onthoudt de nieuwe geschiedenisregel.
       * @param {*} _state Bewaarde stand (niet gebruikt).
       * @param {string} _title Titel (niet gebruikt).
       * @param {string} url Het nieuwe adres.
       */
      pushState(state, _title, url) { pushed.push(String(url)); sandbox.history.state = state; setAddress(url); },
      state: null,
      /**
       * Gaat een geschiedenisregel terug zoals de browser: de eigen regel verdwijnt en popstate volgt.
       */
      back() { sandbox.history.state = null; setAddress('/app/orderpick/'); for (const handler of windowListeners.popstate || []) handler({}); },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    /**
     * Geeft een lege lijst terug, behalve voor bestelling order-1.
     * @param {string} url Het adres van het verzoek.
     * @returns {Promise<object>} Het nagebootste antwoord.
     */
    fetch: async (url) => ({ ok: true, status: 200, json: async () => (/orders\/order-1/.test(String(url)) ? { order: { id: 'order-1', number: 'B-1', shipmentCount: 0, lines: [{ index: 0, ready: 1, scanCodes: ['X1'] }] } } : { items: [], orders: [] }), headers: { get: () => '' } }),
    AquatechAccount: { load: async () => ({ user: { kind: 'account' }, rights: ['orderpick'] }) },
    AquatechCommon: { ownerOf: () => 'test@live', onReturn() {}, statusMessage: (status) => `fout ${status}` },
    AquatechOffline: { headers: () => ({}), prefetch: async () => {}, on() {}, pending: async () => [] },
  };
  sandbox.window = sandbox;
  const windowListeners = {};
  /**
   * Bewaart een luisteraar op het venster (zoals hashchange).
   * @param {string} type Soort gebeurtenis.
   * @param {Function} handler De luisteraar.
   */
  sandbox.addEventListener = (type, handler) => { (windowListeners[type] = windowListeners[type] || []).push(handler); };
  vm.createContext(sandbox);
  for (const file of ['orderpick-core.js', 'orderpick.js', 'receiving-core.js', 'receiving.js', 'counting-core.js', 'counting.js']) {
    vm.runInContext(fs.readFileSync(path.join(DIR, file), 'utf8'), sandbox, { filename: file });
  }
  await sandbox.OrderpickUi.ready;
  await new Promise((resolve) => setTimeout(resolve, 20));
  /**
   * Klikt op een van de knoppen Picken/Ontvangen.
   * @param {string} mode 'pick' of 'receive'.
   */
  const clickMode = (mode) => {
    const target = { closest: () => ({ dataset: { mode } }) };
    for (const handler of listeners.click || []) handler({ target });
  };
  /**
   * Geeft de selectors van de schermen die nu zichtbaar zijn.
   * @returns {string[]} De zichtbare schermen.
   */
  const visible = () => SECTIONS.filter((selector) => !document.querySelector(selector).hidden);
  /**
   * Zet de hash zoals een klik op een zijbalklink op dezelfde pagina doet en roept de luisteraars aan.
   * @param {string} hash De nieuwe hash, bijvoorbeeld '#ontvangst'.
   */
  const navigateHash = (hash) => {
    sandbox.location.hash = hash;
    for (const handler of windowListeners.hashchange || []) handler();
  };
  /**
   * Roept de luisteraars van de terugknop van de browser aan (het adres is dan al terug gezet).
   */
  const popState = () => { for (const handler of windowListeners.popstate || []) handler({}); };
  return { clickMode, navigateHash, popState, pushed, visible, sandbox };
}

test('wisselen tussen Picken, Ontvangen en Tellen toont steeds precies één scherm', async () => {
  const { clickMode, visible } = await loadPage();
  assert.deepStrictEqual(visible(), ['#op-list']);
  for (let round = 0; round < 3; round += 1) {
    clickMode('receive');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepStrictEqual(visible(), ['#rc-list'], `ronde ${round}: ontvangen`);
    clickMode('count');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepStrictEqual(visible(), ['#ct-list'], `ronde ${round}: tellen`);
    clickMode('receive');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepStrictEqual(visible(), ['#rc-list'], `ronde ${round}: weer ontvangen`);
    clickMode('pick');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepStrictEqual(visible(), ['#op-list'], `ronde ${round}: picken`);
  }
});

test('een zijbalklink naar #ontvangst of #tellen op dezelfde pagina opent dat tabblad', async () => {
  const { navigateHash, visible } = await loadPage();
  assert.deepStrictEqual(visible(), ['#op-list']);
  navigateHash('#ontvangst');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepStrictEqual(visible(), ['#rc-list']);
  navigateHash('#tellen');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepStrictEqual(visible(), ['#ct-list']);
});

test('de terugknop van de browser gaat van een bestelling terug naar de lijst', async () => {
  const { sandbox, popState, pushed, visible } = await loadPage();
  // Een bestelling openen zet een eigen geschiedenisregel.
  const open = sandbox.OrderpickUi.openOrder;
  assert.strictEqual(typeof open, 'function');
  await open('order-1');
  assert.deepStrictEqual(pushed, ['?id=order-1']);
  assert.deepStrictEqual(visible(), ['#op-order']);
  // Terug: het adres is weer het pad zonder ?id.
  sandbox.location.search = '';
  popState();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepStrictEqual(visible(), ['#op-list']);
  // De knop Terug in de app gebruikt dezelfde geschiedenisregel (geen dubbele lijstregel).
  await open('order-1');
  assert.deepStrictEqual(visible(), ['#op-order']);
  for (const handler of sandbox.document.querySelector('#op-back').listeners.click) handler({});
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepStrictEqual(visible(), ['#op-list']);
  assert.strictEqual(sandbox.history.state, null, 'de eigen geschiedenisregel is weg (terug, niet een extra lijstregel)');
  // Vooruit: de bestelling gaat weer open.
  sandbox.location.search = '?id=order-1';
  popState();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepStrictEqual(visible(), ['#op-order']);
});
