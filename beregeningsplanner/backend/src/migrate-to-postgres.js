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
const { openSqlite, databaseUrl, schemaVersion } = require('./db');
const { openPg } = require('./pgdb');
const { copyDatabase, fingerprint, describe } = require('./dbcopy');

function parseArgs(argv) {
  const out = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--from' || a === '--schema') out[a.slice(2)] = argv[++i];
    else throw new Error(`Onbekende optie: ${a}`);
  }
  return out;
}

function compare(a, b) {
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const rows = names.map((n) => ({ table: n, sqlite: a[n]?.rows ?? '-', postgres: b[n]?.rows ?? '-', same: Boolean(a[n] && b[n] && a[n].rows === b[n].rows && a[n].sha256 === b[n].sha256) }));
  return { rows, ok: rows.every((r) => r.same) };
}

function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const opts = parseArgs(argv);
  const url = databaseUrl(env);
  if (!url) throw new Error('Zet DATABASE_URL of DATABASE_URL_FILE (verbindings-URL van Supabase, Session pooler).');
  const dataDir = env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data');
  const file = opts.from || path.join(dataDir, 'aquatech.db');
  if (!fs.existsSync(file)) throw new Error(`SQLite-database niet gevonden: ${file}`);
  const schema = opts.schema || env.DATABASE_SCHEMA || 'aquatech';

  const from = openSqlite(file);
  const to = openPg(url, { schema });
  log(`Bron: ${file} (schemaversie ${schemaVersion(from)})`);
  log(`Doel: PostgreSQL, schema ${schema} (schemaversie ${schemaVersion(to)})`);

  let prints;
  if (opts.check) {
    const tables = describe(from);
    prints = [fingerprint(from, tables), fingerprint(to, tables)];
  } else {
    const t0 = Date.now();
    const copy = copyDatabase(from, to, { log: (line) => log(`  gekopieerd ${line}`) });
    log(`Kopiëren klaar in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
    prints = [copy.source, copy.target];
  }
  const result = compare(...prints);
  log('');
  log('Tabel                 SQLite   PostgreSQL   gelijk');
  for (const r of result.rows) log(`${r.table.padEnd(20)} ${String(r.sqlite).padStart(7)} ${String(r.postgres).padStart(12)}   ${r.same ? 'ja' : 'NEE'}`);
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
