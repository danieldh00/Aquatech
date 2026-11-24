// Bewaakt dat een testschema dat uit het sjabloon is gekopieerd (database/test-template.js) precies gelijk is aan een
// schema dat echt alle migraties heeft doorlopen: kolommen, controles, sleutels, indexen, verwijzingen, afscherming,
// rechten en de rijen die de migraties zelf aanmaken. Zo test de suite nooit tegen een afwijkend schema.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { openDb } = require('../src/database/db');
const { openPg, dropSchemas } = require('../src/database/pgdb');
const { ensureTemplate, templateName } = require('../src/database/test-template');

const url = process.env.TEST_DATABASE_URL;

/** Catalogusvragen die samen het schema beschrijven; `$S` is de schemanaam. */
const FACETS = {
  kolommen: `SELECT table_name, ordinal_position, column_name, data_type, udt_name, collation_name, column_default, is_nullable,
      character_maximum_length, numeric_precision, numeric_scale, is_generated, is_identity
    FROM information_schema.columns WHERE table_schema = '$S' ORDER BY table_name, ordinal_position`,
  beperkingen: `SELECT c.relname, k.conname, k.contype, k.condeferrable, k.condeferred, k.convalidated,
      replace(pg_get_constraintdef(k.oid), '$S.', '') AS def
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '$S' ORDER BY c.relname, k.conname`,
  indexen: `SELECT tablename, indexname, replace(indexdef, '$S.', '') AS def FROM pg_indexes WHERE schemaname = '$S' ORDER BY tablename, indexname`,
  afscherming: `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relkind, c.relpersistence
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '$S' AND c.relkind IN ('r', 'S', 'v', 'm', 'p') ORDER BY c.relname`,
  policies: `SELECT tablename, policyname, permissive, roles::text AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = '$S' ORDER BY tablename, policyname`,
  rechten: `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = '$S' ORDER BY table_name, grantee, privilege_type`,
  functies: `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '$S' ORDER BY p.proname`,
  triggers: `SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '$S' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`,
};

/**
 * Beschrijft een schema: de uitkomst van elke catalogusvraag plus de inhoud van elke tabel.
 * @param {object} db Een database (de vragen noemen het schema zelf).
 * @param {string} schema De schemanaam.
 * @returns {object} Per onderdeel de rijen.
 */
function describe(db, schema) {
  const picture = {};
  for (const [name, sql] of Object.entries(FACETS)) picture[name] = db.prepare(sql.replaceAll('$S', schema)).all();
  picture.rijen = {};
  for (const table of new Set(picture.kolommen.map((column) => column.table_name))) {
    picture.rijen[table] = db.prepare(`SELECT to_jsonb(r)::text AS line FROM "${schema}"."${table}" r ORDER BY 1`).all().map((row) => row.line);
  }
  return picture;
}

test('testschema uit het sjabloon is gelijk aan een echt gemigreerd schema', () => {
  const migratedName = `aqt_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const migrated = openPg(url, { schema: migratedName });
  const copy = openDb();
  try {
    assert.notStrictEqual(copy.schema, templateName());
    const expected = describe(migrated, migratedName);
    const actual = describe(copy, copy.schema);
    assert.ok(expected.kolommen.length > 500, 'het gemigreerde schema heeft tabellen');
    assert.ok(expected.beperkingen.some((row) => row.contype === 'f'), 'er zijn verwijzingen om te vergelijken');
    assert.ok(expected.policies.length > 50, 'er zijn policies om te vergelijken');
    for (const facet of Object.keys(expected)) assert.deepStrictEqual(actual[facet], expected[facet], `verschil in ${facet}`);
    // Het sjabloon zelf is ook een echt gemigreerd schema en blijft onaangeroerd.
    assert.deepStrictEqual(describe(migrated, ensureTemplate(url)), expected);
  } finally {
    dropSchemas(url, migratedName);
  }
});

test('een testdatabase op een vast pad migreert echt en houdt zijn schema', () => {
  const file = `/tmp/aquatech-vast-${crypto.randomUUID()}.db`;
  const first = openDb(file);
  try {
    assert.strictEqual(openDb(file).schema, first.schema);
    assert.ok(first.prepare('SELECT version FROM schema_version').get().version > 12);
  } finally {
    dropSchemas(url, first.schema);
  }
});
