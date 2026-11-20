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
  const sandbox = {
    document, console, URLSearchParams, Promise, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Number, String, Array, Object,
    navigator: {},
    location: { pathname: '/app/orderpick/', search: '', hash: '' },
    history: { replaceState(_state, _title, url) { const [, hash] = String(url).split('#'); sandbox.location.hash = hash ? `#${hash}` : ''; } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    /**
     * Geeft een lege lijst terug voor elk verzoek.
     * @returns {Promise<object>} Het nagebootste antwoord.
     */
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ items: [], orders: [] }), headers: { get: () => '' } }),
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
  return { clickMode, navigateHash, visible, sandbox };
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
