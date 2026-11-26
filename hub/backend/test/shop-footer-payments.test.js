// Betaalmethoden in de voet van de webshop: instelling saneren en kaartjes tonen.
const test = require('node:test');
const assert = require('node:assert');
const { sanitizePayment } = require('../src/webshop/mollie');
const { layout, renderWith } = require('../src/webshop/storefront-pages');
const { DEFAULT_SITE } = require('../src/webshop/shop-content');

/**
 * Bouwt een pagina met de opgegeven methoden in de voet.
 * @param {?string[]} footerMethods De methoden (null = niet ingesteld).
 * @returns {string} De HTML van de pagina.
 */
function pageWith(footerMethods) {
  const content = { site: DEFAULT_SITE, pages: [] };
  return renderWith(content, () => layout({ root: './', title: 'Test', description: '', body: '', groups: [] }), { ordering: false, cartCount: 0, footerMethods });
}

test('footerMethods: onbekende sleutels vallen weg, niet ingesteld blijft null', () => {
  assert.strictEqual(sanitizePayment({}).footerMethods, null);
  assert.deepStrictEqual(sanitizePayment({ footerMethods: ['bitcoin', 'nep', 'ideal'] }).footerMethods, ['ideal', 'bitcoin']);
  assert.deepStrictEqual(sanitizePayment({ footerMethods: [] }).footerMethods, []);
});

test('de voet toont alleen de aangevinkte methoden, incl. Bitcoin', () => {
  const html = pageWith(['ideal', 'bitcoin']);
  assert.match(html, /class="foot-pay"/);
  assert.match(html, />iDEAL</);
  assert.match(html, />Bitcoin</);
  assert.doesNotMatch(html, />PayPal</);
});

test('niet ingesteld = vaste plaatje, leeg = niets', () => {
  assert.match(pageWith(null), /betaalmethoden\.png/);
  const empty = pageWith([]);
  assert.doesNotMatch(empty, /betaalmethoden\.png/);
  assert.doesNotMatch(empty, /foot-pay/);
});
