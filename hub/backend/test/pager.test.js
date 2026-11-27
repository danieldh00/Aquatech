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

test('shownIds: "alles selecteren" raakt alleen de rijen op de huidige pagina', () => {
  /**
   * Maakt een nagebootste tabelrij.
   * @param {string} id Het data-id.
   * @param {boolean} off Of de rij door de paginering verborgen is.
   * @returns {object} De rij.
   */
  const makeRow = (id, off) => ({ hidden: false, classList: { contains: (name) => name === 'pager-off' && off }, getAttribute: () => id });
  const table = { querySelectorAll: () => [makeRow('a', false), makeRow('b', false), makeRow('c', true), makeRow('d', true)] };
  assert.deepStrictEqual(Pager.shownIds(table), ['a', 'b']);
});

test('sortOrder: getallen en datums op waarde, tekst Nederlands, lege cellen altijd laatst', () => {
  assert.deepStrictEqual(Pager.sortOrder(['€ 1.234,50', '€ 99,00', '–', '€ 100,00'], 1), [1, 3, 0, 2], 'bedragen oplopend, leeg laatst');
  assert.deepStrictEqual(Pager.sortOrder(['€ 1.234,50', '€ 99,00', '–', '€ 100,00'], -1), [0, 3, 1, 2], 'aflopend houdt leeg laatst');
  assert.deepStrictEqual(Pager.sortOrder(['10', '9', '2'], 1), [2, 1, 0], '10 komt na 9');
  assert.deepStrictEqual(Pager.sortOrder(['27-11-2026', '3-1-2027', '01-12-2025'], 1), [2, 0, 1], 'datums dd-mm-jjjj');
  assert.deepStrictEqual(Pager.sortOrder(['27 nov. 2026, 10:15', '27 nov. 2026, 09:00', '2 jan. 2026'], 1), [2, 1, 0], 'datums met Nederlandse maand');
  assert.deepStrictEqual(Pager.sortOrder(['Zand', 'appel', 'Äpfel', 'b10', 'b9'], 1).map((index) => ['Zand', 'appel', 'Äpfel', 'b10', 'b9'][index]), ['Äpfel', 'appel', 'b9', 'b10', 'Zand'], 'tekst zonder hoofdlettergevoel, getallen in de tekst op waarde');
  assert.deepStrictEqual(Pager.sortOrder(['b', 'a', 'a'], 1), [1, 2, 0], 'gelijke waarden houden hun volgorde');
  assert.deepStrictEqual(Pager.sortOrder(['12', 'abc', '3'], 1).map((index) => ['12', 'abc', '3'][index]), ['3', '12', 'abc'], 'gemengd: als tekst met getallen op waarde');
});

test('parseNumber en parseDate: herkennen alleen echte getallen en datums', () => {
  assert.strictEqual(Pager.parseNumber('€ 1.234,56'), 1234.56);
  assert.strictEqual(Pager.parseNumber('-12,5 m'), -12.5);
  assert.strictEqual(Pager.parseNumber('45%'), 45);
  assert.strictEqual(Pager.parseNumber('12 van 30 opgeleverd'), null);
  assert.strictEqual(Pager.parseNumber('UD.KBI.20.12'), null);
  assert.strictEqual(Pager.parseDate('2026-11-27'), Date.UTC(2026, 10, 27));
  assert.strictEqual(Pager.parseDate('nu'), null);
});
