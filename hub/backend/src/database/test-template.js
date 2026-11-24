// Snelle testdatabases: de testsuite opent honderden keren een leeg schema. Alle migraties opnieuw draaien kost per
// schema seconden (vooral de migraties die elke tabel herschrijven). Daarom migreert de suite één keer een
// sjabloonschema en kopieert hij dat daarna per test: tabellen, standaardwaarden, controles, sleutels, indexen,
// verwijzingen en de rijen die de migraties zelf aanmaken. Afscherming (row level security en policies) zet dezelfde
// code als in productie erop. `test/test-template.test.js` bewaakt dat een kopie gelijk is aan een gemigreerd schema.
// Alleen voor tests: de app zelf migreert altijd echt.
const crypto = require('crypto');
const { PG_BASE, PG_BASE_VERSION, PG_MIGRATIONS } = require('./pgschema');

/** Sjabloonschema per database-URL dat in dit proces al is gecontroleerd. */
const ready = new Map();

/**
 * Naam van het sjabloonschema: hangt af van het basisschema en alle migraties, zodat een nieuwe migratie vanzelf een
 * nieuw sjabloon geeft.
 * @returns {string} De schemanaam.
 */
function templateName() {
  const digest = crypto.createHash('sha256').update([PG_BASE, ...PG_MIGRATIONS].join('\n--\n')).digest('hex');
  return `aqt_sjabloon_${digest.slice(0, 20)}`;
}

/**
 * Zorgt dat het sjabloonschema bestaat en volledig gemigreerd is. Processen die tegelijk starten wachten op elkaar
 * (advisory lock), zodat het sjabloon één keer wordt gebouwd.
 * @param {string} url De test-database-URL.
 * @returns {string} De naam van het sjabloonschema.
 */
function ensureTemplate(url) {
  if (ready.has(url)) return ready.get(url);
  const { PgDatabase, bridgeFor, openPg } = require('./pgdb');
  const name = templateName();
  const lobby = new PgDatabase(bridgeFor(url), 'public');
  lobby.prepare('SELECT pg_advisory_lock(hashtext(?))').get(name);
  try {
    const newest = lobby.prepare('SELECT to_regclass(?) IS NOT NULL AS found').get(`${name}.schema_version`).found
      ? lobby.prepare(`SELECT version FROM "${name}".schema_version`).get()?.version
      : 0;
    if (Number(newest) !== PG_BASE_VERSION + PG_MIGRATIONS.length) openPg(url, { schema: name });
  } finally {
    lobby.prepare('SELECT pg_advisory_unlock(hashtext(?))').get(name);
  }
  ready.set(url, name);
  return name;
}

/**
 * Vult het (lege) schema van deze database met een kopie van het sjabloonschema. Namen van sleutels, indexen en
 * verwijzingen blijven gelijk aan die in het sjabloon.
 * @param {object} db De database met het lege doelschema.
 * @param {string} template De naam van het sjabloonschema.
 * @returns {void}
 */
function cloneSchema(db, template) {
  db.exec(`DO $clone$
DECLARE
  item record;
  source text := '${template}';
  target text := current_schema();
  source_prefix text := quote_ident('${template}') || '.';
  target_prefix text := quote_ident(current_schema()) || '.';
BEGIN
  FOR item IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = source AND c.relkind = 'r' ORDER BY c.relname LOOP
    EXECUTE format('CREATE TABLE %I.%I (LIKE %I.%I INCLUDING ALL EXCLUDING INDEXES EXCLUDING CONSTRAINTS)', target, item.relname, source, item.relname);
    EXECUTE format('INSERT INTO %I.%I TABLE %I.%I', target, item.relname, source, item.relname);
  END LOOP;
  FOR item IN SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = source AND k.contype IN ('c', 'p', 'u', 'x') ORDER BY c.relname, k.conname LOOP
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', target, item.relname, item.conname, replace(item.def, source_prefix, target_prefix));
  END LOOP;
  FOR item IN SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = source AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype IN ('p', 'u', 'x'))
      ORDER BY i.indexrelid LOOP
    EXECUTE replace(item.def, source_prefix, target_prefix);
  END LOOP;
  FOR item IN SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = source AND k.contype = 'f' ORDER BY c.relname, k.conname LOOP
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', target, item.relname, item.conname, replace(item.def, source_prefix, target_prefix));
  END LOOP;
END $clone$`);
}

/**
 * Bouwt een testschema als kopie van het sjabloon, in één transactie, met dezelfde afscherming als na een migratie.
 * @param {object} db De database met het lege doelschema.
 * @param {string} template De naam van het sjabloonschema.
 * @returns {void}
 */
function buildFromTemplate(db, template) {
  const { lockDown } = require('./pgdb');
  db.exec('BEGIN');
  try {
    cloneSchema(db, template);
    lockDown(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Opent een nieuw testschema als kopie van het sjabloonschema.
 * @param {string} url De test-database-URL.
 * @param {string} schema De naam van het nieuwe schema.
 * @returns {object} De database.
 */
function openFromTemplate(url, schema) {
  const { openPg } = require('./pgdb');
  const template = ensureTemplate(url);
  return openPg(url, { schema, build: (db) => buildFromTemplate(db, template) });
}

module.exports = { templateName, ensureTemplate, cloneSchema, openFromTemplate };
