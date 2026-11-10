// Controle op het tenantfilter (T-02 uit de audit van 1.7.3): de scheiding tussen
// organisaties zit in de applicatiecode ('WHERE tenant_id = ?'), niet in de
// database. Dit hulpmiddel zoekt in backend/src elke SQL-tekst (string of
// template) die een tabel met de kolom tenant_id leest of wijzigt zonder dat
// 'tenant_id' in de tekst staat. Bestaande uitzonderingen (bijna altijd een
// opzoeking op een uniek id uit een rij die al op de tenant is gefilterd, of op
// een token-hash) staan in tenant-filter-baseline.json; die lijst wordt alleen
// korter. Een nieuwe query zonder tenantfilter laat test/tenant-filter.test.js falen.
// Gebruik: `node tools/tenant-filter.js` (toont de nieuwe vondsten) of
// `node tools/tenant-filter.js --update` (schrijft de lijst opnieuw; alleen na controle).
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const { openDb, listTables, tableColumns } = require('../src/database/db');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(BACKEND_ROOT, 'src');
const BASELINE_FILE = path.join(__dirname, 'tenant-filter-baseline.json');
/** Bestanden die het schema zelf beheren (migraties, kopiëren, overstappen): daar hoort geen tenantfilter. */
const SKIP_FILES = new Set(['database/db.js', 'database/pgschema.js', 'database/pgdb.js', 'database/pgdb-worker.js', 'database/db-copy.js', 'migrate-to-postgres.js', 'backup.js']);

/**
 * De tabellen met een kolom tenant_id, gelezen uit een verse database met alle migraties.
 * @returns {Set<string>} De tabelnamen.
 */
function tenantTables() {
  const db = openDb();
  try {
    return new Set(listTables(db).filter((table) => tableColumns(db, table).some((column) => column.name === 'tenant_id')));
  } finally {
    if (typeof db.close === 'function') db.close();
  }
}

/**
 * Zoekt recursief de .js-bestanden onder backend/src.
 * @returns {string[]} Paden relatief aan backend/src, met '/' als scheidingsteken.
 */
function listSourceFiles() {
  const found = [];
  /**
   * Loopt één map door en voegt de .js-bestanden toe aan `found`.
   * @param {string} directory Absolute map.
   * @returns {void}
   */
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.name.endsWith('.js')) found.push(path.relative(SOURCE_DIR, fullPath).split(path.sep).join('/'));
    }
  };
  visit(SOURCE_DIR);
  return found.sort();
}

/**
 * Maakt een SQL-tekst vergelijkbaar: witruimte samengevoegd en ingekort.
 * @param {string} sql De SQL.
 * @returns {string} De genormaliseerde tekst.
 */
const normalizeSql = (sql) => sql.replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Zoekt in de broncode van één bestand de SQL-teksten op tabellen met tenant_id zonder tenantfilter.
 * @param {string} relativeFile Pad relatief aan backend/src (voor de melding).
 * @param {string} source De broncode.
 * @param {Set<string>} tables De tabellen met tenant_id.
 * @returns {{ file: string, line: number, sql: string }[]} De vondsten.
 */
function scanSource(relativeFile, source, tables) {
  const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true });
  const findings = [];
  /**
   * Beoordeelt één tekst uit de code.
   * @param {string} text De tekst (bij een template de vaste delen met ${} ertussen).
   * @param {object} node Het knooppunt (voor het regelnummer).
   * @returns {void}
   */
  const check = (text, node) => {
    if (!/\b(SELECT|UPDATE|DELETE|INSERT)\b/.test(text)) return;
    const touched = [...text.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_]+)/g)].map((match) => match[1]).filter((table) => tables.has(table));
    if (!touched.length || /tenant_id/.test(text)) return;
    findings.push({ file: relativeFile, line: node.loc.start.line, sql: normalizeSql(text) });
  };
  walk.full(tree, (node) => {
    if (node.type === 'Literal' && typeof node.value === 'string') check(node.value, node);
    else if (node.type === 'TemplateLiteral') check(node.quasis.map((quasi) => quasi.value.cooked || '').join('${}'), node);
  });
  return findings;
}

/**
 * Doorzoekt alle bestanden onder backend/src.
 * @returns {{ file: string, line: number, sql: string }[]} Alle vondsten.
 */
function scanAll() {
  const tables = tenantTables();
  return listSourceFiles().filter((file) => !SKIP_FILES.has(file)).flatMap((file) => scanSource(file, fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8'), tables));
}

/**
 * De bekende uitzonderingen.
 * @returns {{ file: string, sql: string }[]} De lijst (leeg als het bestand ontbreekt).
 */
function readBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).exceptions || []; } catch { return []; }
}

/**
 * Vergelijkt de vondsten met de bekende uitzonderingen.
 * @param {{ file: string, sql: string }[]} findings De vondsten.
 * @param {{ file: string, sql: string }[]} baseline De bekende uitzonderingen.
 * @returns {{ added: object[], gone: object[] }} Nieuwe vondsten en uitzonderingen die niet meer voorkomen.
 */
function compare(findings, baseline) {
  /**
   * Sleutel van een vondst of uitzondering: bestand en SQL (zonder regelnummer, zodat verschuiven niets uitmaakt).
   * @param {{ file: string, sql: string }} entry De vondst.
   * @returns {string} De sleutel.
   */
  const keyOf = (entry) => `${entry.file}|${entry.sql}`;
  const known = new Set(baseline.map(keyOf));
  const present = new Set(findings.map(keyOf));
  return { added: findings.filter((entry) => !known.has(keyOf(entry))), gone: baseline.filter((entry) => !present.has(keyOf(entry))) };
}

if (require.main === module) {
  const findings = scanAll();
  if (process.argv.includes('--update')) {
    const unique = [...new Map(findings.map((entry) => [`${entry.file}|${entry.sql}`, { file: entry.file, sql: entry.sql }])).values()];
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ note: 'Queries zonder tenant_id in de tekst, gecontroleerd in de audit van 1.7.3 (opzoeking op een uniek id uit een rij die al op de tenant is gefilterd, een token-hash of een opdracht over alle omgevingen). Deze lijst wordt alleen korter.', exceptions: unique }, null, 2)}\n`);
    console.log(`${unique.length} uitzonderingen vastgelegd.`);
  } else {
    const { added, gone } = compare(findings, readBaseline());
    for (const entry of added) console.log(`NIEUW ${entry.file}:${entry.line}: ${entry.sql}`);
    for (const entry of gone) console.log(`WEG   ${entry.file}: ${entry.sql}`);
    process.exitCode = added.length ? 1 : 0;
  }
}

module.exports = { scanAll, scanSource, readBaseline, compare, normalizeSql };
