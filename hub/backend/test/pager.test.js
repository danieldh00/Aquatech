// Tests voor de gedeelde paginering (frontend/shared/pager.js): het bereik per pagina, het bij elkaar houden van groepen en dat elke pagina met een lijst het onderdeel laadt.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Pager = require('../../frontend/shared/pager.js');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

test('windowOf: bereik per pagina, afgekapt op het laatste en eerste', () => {
  assert.deepStrictEqual(Pager.windowOf(120, 3, 50), { page: 3, pages: 3, start: 100, end: 120 });
  assert.deepStrictEqual(Pager.windowOf(120, 9, 50), { page: 3, pages: 3, start: 100, end: 120 });
  assert.deepStrictEqual(Pager.windowOf(120, -4, 50), { page: 1, pages: 3, start: 0, end: 50 });
  assert.deepStrictEqual(Pager.windowOf(0, 1, 50), { page: 1, pages: 1, start: 0, end: 0 });
  assert.deepStrictEqual(Pager.windowOf(120, 2, 0), { page: 1, pages: 1, start: 0, end: 120 }, '0 = alles');
});

test('groupRows: een rij die bij de vorige hoort blijft in dezelfde groep', () => {
  const rows = [{ id: 1 }, { id: 2, sub: true }, { id: 3, sub: true }, { id: 4 }];
  const groups = Pager.groupRows(rows, (row) => row.sub);
  assert.deepStrictEqual(groups.map((group) => group.map((row) => row.id)), [[1, 2, 3], [4]]);
});

test('de keuzes en de bewaarsleutel zijn die van de artikellijst', () => {
  assert.deepStrictEqual(Pager.PAGE_SIZES, [25, 50, 100, 300, 0]);
  assert.strictEqual(Pager.PAGE_SIZE_KEY, 'aquatech_artikelen_paginagrootte');
});

test('elke pagina met een lijst laadt pager.js en pager.css', () => {
  const pages = fs.readdirSync(FRONTEND).filter((name) => fs.existsSync(path.join(FRONTEND, name, 'index.html')));
  for (const name of pages) {
    const html = fs.readFileSync(path.join(FRONTEND, name, 'index.html'), 'utf8');
    const scripts = fs.readdirSync(path.join(FRONTEND, name)).filter((file) => file.endsWith('.js')).map((file) => fs.readFileSync(path.join(FRONTEND, name, file), 'utf8'));
    const hasList = /<table[^>]*class="[^"]*\bgrid\b/.test(html) || scripts.some((code) => /<table[^>]*class="[^"]*\bgrid\b/.test(code));
    if (!hasList) continue;
    assert.ok(html.includes('../shared/pager.js'), `${name}: laadt shared/pager.js niet`);
    assert.ok(html.includes('../shared/pager.css'), `${name}: laadt shared/pager.css niet`);
  }
});
