// Test van beheer/collapse-list.js: inklappen van lange lijsten met een knop "Toon alle".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'beheer', 'collapse-list.js'), 'utf8');
const sandbox = { window: {}, document: { addEventListener() {} } };
vm.runInNewContext(source, sandbox);
const { render, isExpanded } = sandbox.window.BeheerCollapse;
/**
 * Maakt een aantal testregels.
 * @param {number} count Aantal regels.
 * @returns {string[]} De regels als `<li>`-HTML.
 */
const rows = (count) => Array.from({ length: count }, (_, index) => `<li>regel ${index + 1}</li>`);

test('vijf regels of minder: geen knop en niets verborgen', () => {
  const html = render(rows(5));
  assert.ok(!html.includes('data-collapse-toggle'));
  assert.ok(!html.includes('hidden'));
});

test('zes regels: één verborgen regel en een knop met het totaal', () => {
  const html = render(rows(6));
  assert.strictEqual((html.match(/data-collapsed hidden/g) || []).length, 1);
  assert.ok(html.includes('data-total="6"'));
  assert.ok(html.includes('Toon alle (6)'));
});

test('uitgeklapt: niets verborgen en de knop toont Toon minder', () => {
  const html = render(rows(8), { expanded: true });
  assert.ok(!html.includes('data-collapsed hidden'));
  assert.strictEqual((html.match(/data-collapsed/g) || []).length, 3);
  assert.ok(html.includes('aria-expanded="true"') && html.includes('Toon minder'));
});

test('isExpanded leest de stand uit het element', () => {
  const container = { querySelector: (selector) => (selector.includes('"true"') ? {} : null) };
  assert.strictEqual(isExpanded(container), true);
  assert.strictEqual(isExpanded(null), false);
});
