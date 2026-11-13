// Bewaakt de codestijlregels uit CLAUDE.md ("Codestijl"): duidelijke namen
// (geen namen van één letter) en een commentaarblok bij elke functie. Bestanden
// in tools/codestyle-baseline.json worden nog overgeslagen; die lijst wordt per
// opschoonronde korter en er mag niets bij.
const test = require('node:test');
const assert = require('node:assert');
const codestyle = require('../tools/codestyle');

const baseline = codestyle.readBaseline();
const allFiles = codestyle.listSourceFiles();

test('elk bestand buiten de uitzonderingslijst voldoet aan de codestijl', () => {
  const skipped = new Set(baseline);
  const report = [];
  for (const file of allFiles) {
    if (skipped.has(file)) continue;
    for (const violation of codestyle.checkFile(file)) report.push(`${file}:${violation.line}  ${violation.message}`);
  }
  assert.deepStrictEqual(report, [], `Codestijl (zie CLAUDE.md, "Codestijl"; controle met npm run codestyle):\n${report.join('\n')}`);
});

test('de uitzonderingslijst bevat alleen bestaande bestanden die nog niet voldoen', () => {
  const existing = new Set(allFiles);
  const missing = baseline.filter((file) => !existing.has(file));
  assert.deepStrictEqual(missing, [], 'Verwijder deze bestanden uit tools/codestyle-baseline.json (ze bestaan niet meer)');
  const clean = baseline.filter((file) => codestyle.checkFile(file).length === 0);
  assert.deepStrictEqual(clean, [], 'Deze bestanden voldoen al: haal ze uit tools/codestyle-baseline.json');
});

test('de controle herkent korte namen en ontbrekende commentaarblokken', () => {
  const source = [
    'function zonderUitleg(a) { return a; }',
    '/**',
    ' * Telt twee getallen op.',
    ' * @param {number} first Eerste getal.',
    ' * @param {number} second Tweede getal.',
    ' * @returns {number} De som.',
    ' */',
    'function add(first, second) { return first + second; }',
    'const list = [1, 2].map((value) => value * 2);',
    'for (let i = 0; i < 2; i++) add(i, i);',
  ].join('\n');
  const messages = codestyle.checkSource(source).map((violation) => violation.message);
  assert.deepStrictEqual(messages, [
    "parameter 'a' heeft een naam van één letter",
    "functie 'zonderUitleg' heeft geen commentaarblok (/** ... */)",
  ]);
  const incomplete = '/** Doet iets. */\nconst half = (value, factor) => value / factor;';
  assert.deepStrictEqual(codestyle.checkSource(incomplete).map((violation) => violation.message), [
    "functie 'half': @param ontbreekt (2 parameter(s), 0 beschreven)",
    "functie 'half': @returns ontbreekt",
  ]);
});
