// Overstap van SQLite naar PostgreSQL (Supabase): kopieert de hele database
// één op één en controleert daarna per tabel het aantal rijen en een
// SHA-256 over alle waarden. Het SQLite-bestand blijft ongewijzigd staan
// (terugvallen kan dus altijd: DATABASE_URL weer weghalen).
//
// Gebruik (met de app gestopt, anders mis je wijzigingen van daarna):
//   DATABASE_URL=postgres://... node src/migrate-to-postgres.js [opties]
//   (of DATABASE_URL_FILE=/run/secrets/database-url)
//
// Opties:
//   --from <bestand>   SQLite-database (standaard DATA_DIR/aquatech.db)
//   --schema <naam>    schema in PostgreSQL (standaard DATABASE_SCHEMA of aquatech)
//   --check            niets kopiëren, alleen beide kanten vergelijken
const fs = require('fs');
const path = require('path');
const { openSqlite, databaseUrl, schemaVersion } = require('./database/db');
const { openPg } = require('./database/pgdb');
const { copyDatabase, fingerprint, describe } = require('./database/db-copy');

/**
 * Leest de opties van de opdrachtregel.
 * @param {string[]} argv De argumenten na de bestandsnaam.
 * @returns {{ check: boolean, from?: string, schema?: string }} De opties.
 * @throws {Error} Bij een onbekende optie.
 */
function parseArgs(argv) {
  const out = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--check') out.check = true;
    else if (argument === '--from' || argument === '--schema') out[argument.slice(2)] = argv[++i];
    else throw new Error(`Onbekende optie: ${argument}`);
  }
  return out;
}

/**
 * Vergelijkt de vingerafdrukken van SQLite en PostgreSQL per tabel.
 * @param {object} sqlitePrints Vingerafdrukken van de SQLite-database.
 * @param {object} postgresPrints Vingerafdrukken van de PostgreSQL-database.
 * @returns {{ rows: object[], ok: boolean }} Per tabel de aantallen en of ze gelijk zijn, en of alles gelijk is.
 */
function compare(sqlitePrints, postgresPrints) {
  const names = [...new Set([...Object.keys(sqlitePrints), ...Object.keys(postgresPrints)])].sort();
  const rows = names.map((name) => ({ table: name, sqlite: sqlitePrints[name]?.rows ?? '-', postgres: postgresPrints[name]?.rows ?? '-', same: Boolean(sqlitePrints[name] && postgresPrints[name] && sqlitePrints[name].rows === postgresPrints[name].rows && sqlitePrints[name].sha256 === postgresPrints[name].sha256) }));
  return { rows, ok: rows.every((row) => row.same) };
}

/**
 * Voert de overstap uit (of met --check alleen de vergelijking) en drukt per tabel het resultaat af.
 * @param {string[]} [argv] Opties van de opdrachtregel.
 * @param {object} [env] Omgevingsvariabelen.
 * @param {Function} [log] Functie voor de uitvoer.
 * @returns {{ rows: object[], ok: boolean }} Het resultaat van de vergelijking.
 */
function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const options = parseArgs(argv);
  const url = databaseUrl(env);
  if (!url) throw new Error('Zet DATABASE_URL of DATABASE_URL_FILE (verbindings-URL van Supabase, Session pooler).');
  const dataDir = env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data');
  const file = options.from || path.join(dataDir, 'aquatech.db');
  if (!fs.existsSync(file)) throw new Error(`SQLite-database niet gevonden: ${file}`);
  const schema = options.schema || env.DATABASE_SCHEMA || 'aquatech';

  const from = openSqlite(file);
  const to = openPg(url, { schema });
  log(`Bron: ${file} (schemaversie ${schemaVersion(from)})`);
  log(`Doel: PostgreSQL, schema ${schema} (schemaversie ${schemaVersion(to)})`);

  let prints;
  if (options.check) {
    const tables = describe(from);
    prints = [fingerprint(from, tables), fingerprint(to, tables)];
  } else {
    const startedAt = Date.now();
    const copy = copyDatabase(from, to, { log: (line) => log(`  gekopieerd ${line}`) });
    log(`Kopiëren klaar in ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`);
    prints = [copy.source, copy.target];
  }
  const result = compare(...prints);
  log('');
  log('Tabel                 SQLite   PostgreSQL   gelijk');
  for (const row of result.rows) log(`${row.table.padEnd(20)} ${String(row.sqlite).padStart(7)} ${String(row.postgres).padStart(12)}   ${row.same ? 'ja' : 'NEE'}`);
  log('');
  log(result.ok
    ? 'Alles is één op één gelijk (aantallen en SHA-256 per tabel). Zet nu DATABASE_URL in de app en start hem opnieuw.'
    : 'Er zijn verschillen: gebruik PostgreSQL nog niet.');
  from.close();
  return result;
}

module.exports = { main };

if (require.main === module) {
  try {
    const { ok } = main();
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`Overstap mislukt: ${err.message}`);
    process.exit(1);
  }
}
