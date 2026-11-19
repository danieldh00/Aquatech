// Bewaakt het gedeelde tabelpatroon voor smalle schermen: rasterkolommen mogen op een telefoon niet breder worden dan het
// scherm, elke pagina met een tabel laadt de gedeelde tabelregels en het artikelscherm bevat het blok Producttekst.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { FRONTEND_DIR } = require('../src/paths');

/**
 * Alle bestanden met een bepaalde extensie onder de frontend, zonder vendor-mappen.
 * @param {string} directory De map om te doorzoeken.
 * @param {string} extension De extensie, bijvoorbeeld '.css'.
 * @returns {string[]} De paden.
 */
function filesWith(directory, extension) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesWith(full, extension));
    else if (entry.name.endsWith(extension)) found.push(full);
  }
  return found;
}

test('rasterkolommen met een vaste minimumbreedte krimpen mee op een smal scherm', () => {
  const offenders = [];
  for (const file of filesWith(FRONTEND_DIR, '.css')) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (/auto-(fit|fill)/.test(line) && /minmax\(\s*(\d{3,})px\s*,\s*1fr\s*\)/.test(line)) offenders.push(`${path.relative(FRONTEND_DIR, file)}:${index + 1}`);
    });
  }
  assert.deepStrictEqual(offenders, [], 'gebruik minmax(min(100%, Npx), 1fr)');
});

test('elke pagina met een tabel laadt de gedeelde tabelregels (.tablewrap scrolt binnen de kaart)', () => {
  const shared = fs.readFileSync(path.join(FRONTEND_DIR, 'beheer', 'beheer.css'), 'utf8');
  assert.match(shared, /\.tablewrap\s*\{[^}]*overflow-x:\s*auto[^}]*max-width:\s*100%/);
  assert.match(shared, /\.cols > \*[^{]*\{\s*min-width:\s*0/);
  for (const file of filesWith(FRONTEND_DIR, '.html')) {
    const html = fs.readFileSync(file, 'utf8');
    if (/<table|tablewrap/.test(html)) assert.ok(/beheer\/beheer\.css|href="beheer\.css/.test(html), `${path.relative(FRONTEND_DIR, file)} laadt beheer.css niet`);
  }
});

test('het artikelscherm bevat het blok Producttekst en het tabblad Teksten niet meer', () => {
  const html = fs.readFileSync(path.join(FRONTEND_DIR, 'artikelen', 'index.html'), 'utf8');
  const itemView = html.slice(html.indexOf('id="v-item"'));
  assert.ok(itemView.includes('id="tx-detail"'));
  const textsTab = html.slice(html.indexOf('id="tab-texts"'), html.indexOf('id="tab-reorder"'));
  assert.ok(!textsTab.includes('id="tx-detail"'));
});
