// Database van de app: PostgreSQL (pgdb.js, schema en migraties in pgschema.js).
// De interface is synchroon (prepare/get/all/run/exec); losse leesqueries kunnen
// ook als Promise via db.async. Er is geen andere database: zonder DATABASE_URL
// start de app niet.
//
// Multitenant: elke tabel heeft een tenant_id en elke query filtert daarop.
// De hoofdtenant ("default") bestaat altijd; andere tenants en hun
// testomgevingen (eigen tenant met parent_id) maakt een hoofdbeheerder aan.
// Id's zijn willekeurige UUID's (niet te raden en zonder hernummeren over te
// zetten naar een andere database).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Opent een database voor de tests: een eigen schema in de PostgreSQL van
 * TEST_DATABASE_URL, per database (een bestandspad geeft steeds hetzelfde schema).
 * @param {string} [file] ':memory:' (elke keer een nieuw schema) of een pad (steeds hetzelfde schema).
 * @returns {object} De geopende en gemigreerde database.
 * @throws {Error} Zonder TEST_DATABASE_URL.
 */
function openDb(file = ':memory:') {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL ontbreekt: de tests draaien tegen PostgreSQL (bijv. postgres://postgres:postgres@127.0.0.1:5432/postgres).');
  }
  return openTestPg(process.env.TEST_DATABASE_URL, file);
}

/**
 * Opent voor de testsuite een eigen schema in PostgreSQL per database.
 * @param {string} url De test-database-URL.
 * @param {string} file ':memory:' (elke keer een nieuw schema) of een pad (steeds hetzelfde schema).
 * @returns {object} De database in PostgreSQL.
 */
function openTestPg(url, file) {
  const id = file === ':memory:' ? crypto.randomUUID() : path.resolve(file);
  const schema = `aqt_test_${crypto.createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
  // Een nieuw schema is een kopie van het sjabloon (snel); een schema op een vast pad kan al bestaan en migreert echt.
  if (file === ':memory:' && process.env.TEST_DB_TEMPLATE !== '0') return require('./test-template').openFromTemplate(url, schema);
  return require('./pgdb').openPg(url, { schema });
}

/**
 * De URL van PostgreSQL uit DATABASE_URL_FILE of DATABASE_URL.
 * @param {object} [env] Omgevingsvariabelen.
 * @returns {string} De URL, of '' als er geen is.
 */
function databaseUrl(env = process.env) {
  if (env.DATABASE_URL_FILE) return fs.readFileSync(env.DATABASE_URL_FILE, 'utf8').trim();
  return String(env.DATABASE_URL || '').trim();
}

/**
 * De database van de server: PostgreSQL volgens DATABASE_URL of DATABASE_URL_FILE.
 * @param {object} [env] Omgevingsvariabelen.
 * @returns {object} De database.
 * @throws {Error} Zonder database-URL: PostgreSQL is de enige ondersteunde database.
 */
function openDatabase(env = process.env) {
  const url = databaseUrl(env);
  if (!url) {
    throw new Error('Geen database ingesteld: zet DATABASE_URL (of DATABASE_URL_FILE) naar een PostgreSQL-database. Zie docker-compose.yml voor een voorbeeld met een eigen PostgreSQL-container.');
  }
  return require('./pgdb').openPg(url, { schema: env.DATABASE_SCHEMA || 'aquatech' });
}

/**
 * Voert een functie uit binnen één transactie: COMMIT als hij slaagt, ROLLBACK bij een fout.
 * @param {object} db De database.
 * @param {Function} callback De functie met de wijzigingen.
 * @returns {*} Wat de functie teruggeeft.
 */
function transaction(db, callback) {
  db.exec('BEGIN');
  try {
    const out = callback();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- Hulpfuncties voor PostgreSQL ----------
/**
 * Schemaversie: het aantal uitgevoerde migraties.
 * @param {object} db De database.
 * @returns {number} De versie.
 */
function schemaVersion(db) {
  return require('./pgdb').pgVersion(db);
}

/**
 * Namen van de tabellen van de app (zonder interne tabellen).
 * @param {object} db De database.
 * @returns {string[]} Tabelnamen, alfabetisch.
 */
function listTables(db) {
  return db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_version' ORDER BY table_name")
    .all().map((row) => row.name);
}

/**
 * Kolommen van een tabel, in volgorde.
 * @param {object} db De database.
 * @param {string} table Naam van de tabel.
 * @returns {{ name: string, notnull: boolean, pk: boolean }[]} De kolommen.
 */
function tableColumns(db, table) {
  // pg_catalog is veel sneller dan information_schema (dat telt per tabel mee in een back-up).
  return db.prepare(`SELECT a.attname AS name, a.attnotnull AS notnull, COALESCE(a.attnum = ANY (i.indkey), false) AS pk
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
    WHERE n.nspname = current_schema() AND c.relname = ? AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`)
    .all(table).map((column) => ({ name: column.name, notnull: Boolean(column.notnull), pk: Boolean(column.pk) }));
}

/**
 * Foreign keys van een tabel.
 * @param {object} db De database.
 * @param {string} table Naam van de tabel.
 * @returns {{ from: string, table: string }[]} Per foreign key de kolom en de doeltabel.
 */
function foreignKeys(db, table) {
  return db.prepare(`SELECT a.attname AS "from", cf.relname AS "table"
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_class cf ON cf.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND n.nspname = current_schema() AND cl.relname = ?`).all(table);
}

/**
 * Laat foreign keys binnen de lopende transactie pas bij COMMIT controleren.
 * @param {object} db De database.
 * @returns {void}
 */
function deferForeignKeys(db) {
  db.exec('SET CONSTRAINTS ALL DEFERRED');
}

/**
 * SQL-expressie voor de tekstwaarde van een veld uit een JSON-kolom.
 * @param {object} _db De database (niet meer nodig; blijft in de aanroep voor de leesbaarheid).
 * @param {string} expr SQL-expressie van de JSON-kolom.
 * @param {string} key Vaste veldnaam uit de code.
 * @returns {string} De SQL-expressie.
 */
const jsonField = (_db, expr, key) => `((${expr})::jsonb ->> '${key}')`;

/**
 * SQL-expressie voor de JSON-kolom zonder dit veld (als tekst).
 * @param {object} _db De database (niet meer nodig).
 * @param {string} expr SQL-expressie van de JSON-kolom.
 * @param {string} key Vaste veldnaam uit de code.
 * @returns {string} De SQL-expressie.
 */
const jsonWithout = (_db, expr, key) => `(((${expr})::jsonb - '${key}')::text)`;

/**
 * SQL-expressie voor een klein JSON-object (als tekst) uit een grote JSON-kolom,
 * zodat een overzicht niet het hele document ophaalt. Sleutels zijn vaste
 * namen uit de code.
 * @param {object} _db De database (niet meer nodig).
 * @param {string} expr SQL-expressie van de JSON-kolom.
 * @param {{ values?: string[], counts?: string[] }} [fields] values = velden die meegaan zoals ze zijn; counts = arrays waarvan alleen de lengte meegaat (0 als het geen array is).
 * @returns {string} De SQL-expressie.
 */
function jsonDigest(_db, expr, { values = [], counts = [] } = {}) {
  const parts = [
    ...values.map((key) => `'${key}', j -> '${key}'`),
    ...counts.map((key) => `'${key}', CASE WHEN jsonb_typeof(j -> '${key}') = 'array' THEN jsonb_array_length(j -> '${key}') ELSE 0 END`),
  ];
  // OFFSET 0: anders vouwt PostgreSQL de subquery in en zet hij de kolom per
  // veld opnieuw om naar jsonb (bij een plan met achtergrond: megabytes).
  return `(SELECT jsonb_build_object(${parts.join(', ')})::text FROM (SELECT (${expr})::jsonb AS j OFFSET 0) AS digest)`;
}

module.exports = {
  openDb, openDatabase, databaseUrl, transaction,
  schemaVersion, listTables, tableColumns, foreignKeys, deferForeignKeys, jsonField, jsonWithout, jsonDigest,
};
