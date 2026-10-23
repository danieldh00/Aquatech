// Alle gegevens één op één van de ene database naar de andere kopiëren
// (SQLite → PostgreSQL bij de overstap naar Supabase, PostgreSQL → SQLite
// voor de versleutelde back-ups) en daarna controleren dat beide kanten
// exact gelijk zijn: per tabel het aantal rijen en een SHA-256 over alle
// waarden, op volgorde van de primaire sleutel.
//
// Er wordt niets omgezet of opnieuw versleuteld: id's (UUID's), tenant_id's,
// wachtwoord-hashes, sessie-hashes en versleutelde geheimen (vault, met de
// tenant in de AAD) gaan ongewijzigd over. De hoofdsleutel blijft dus nodig.
const crypto = require('crypto');
const { transaction, listTables, tableColumns, deferForeignKeys, schemaVersion, isPg } = require('./db');

const BATCH = 200;
// Tabellen met grote rijen (foto's) in kleinere porties, zodat het geheugen klein blijft.
const BATCH_OF = { work_order_photos: 10 };

/**
 * Beschrijft alle tabellen van een database: de kolommen en de volgorde (primaire sleutel, anders alle kolommen).
 * @param {object} db Databaseverbinding.
 * @returns {Object<string, { columns: string[], order: string[], keyed: boolean }>} Per tabelnaam de kolommen, de sorteervolgorde en of die een primaire sleutel is.
 */
function describe(db) {
  const tables = {};
  for (const name of listTables(db)) {
    const columnInfo = tableColumns(db, name);
    const primaryKey = columnInfo.filter((column) => column.pk).map((column) => column.name);
    tables[name] = { columns: columnInfo.map((column) => column.name), order: primaryKey.length ? primaryKey : columnInfo.map((column) => column.name), keyed: primaryKey.length > 0 };
  }
  return tables;
}

/**
 * Loopt alle rijen van een tabel door in porties, op volgorde van de primaire
 * sleutel. Elke portie gaat verder na de laatste sleutel van de vorige
 * (keyset), zodat de database eerdere rijen niet steeds opnieuw overslaat;
 * alleen een tabel zonder primaire sleutel gebruikt OFFSET.
 * @param {object} db Databaseverbinding.
 * @param {string} table Naam van de tabel.
 * @param {{ columns: string[], order: string[], keyed?: boolean }} description Kolommen, volgorde en of die een primaire sleutel is (uit describe).
 * @returns {Generator<object>} De rijen, één voor één.
 */
function* rowsOf(db, table, { columns, order, keyed = false }) {
  const size = BATCH_OF[table] || BATCH;
  const base = `SELECT ${columns.join(', ')} FROM ${table}`;
  const ordering = `ORDER BY ${order.join(', ')} LIMIT ?`;
  if (!keyed) {
    const statement = db.prepare(`${base} ${ordering} OFFSET ?`);
    for (let offset = 0; ; offset += size) {
      const batch = statement.all(size, offset);
      for (const row of batch) yield row;
      if (batch.length < size) return;
    }
  }
  const key = order.length === 1 ? order[0] : `(${order.join(', ')})`;
  const marks = order.length === 1 ? '?' : `(${order.map(() => '?').join(', ')})`;
  const first = db.prepare(`${base} ${ordering}`);
  const after = db.prepare(`${base} WHERE ${key} > ${marks} ${ordering}`);
  let batch = first.all(size);
  for (;;) {
    for (const row of batch) yield row;
    if (batch.length < size) return;
    const last = batch[batch.length - 1];
    batch = after.all(...order.map((column) => last[column]), size);
  }
}

/**
 * Voert een functie uit binnen één leestransactie, zodat alles uit hetzelfde moment komt.
 * @param {object} db Databaseverbinding.
 * @param {Function} callback De functie die de database leest.
 * @returns {*} Wat de functie teruggeeft.
 */
function snapshot(db, callback) {
  db.exec(isPg(db) ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
  try {
    return callback();
  } finally {
    db.exec('COMMIT');
  }
}

/**
 * Maakt een waarde uit de database vergelijkbaar: undefined wordt null, BigInt wordt een gewoon getal.
 * @param {*} raw De waarde uit de database.
 * @returns {*} De genormaliseerde waarde.
 */
const value = (raw) => (raw === null || raw === undefined ? null : typeof raw === 'bigint' ? Number(raw) : raw);

/**
 * Vingerafdruk van alle tabellen: per tabel het aantal rijen en een SHA-256 over
 * alle waarden (met hun type: "1" en 1 zijn niet hetzelfde).
 * @param {object} db Databaseverbinding.
 * @param {object} [tables] Beschrijving van de tabellen (standaard describe(db)).
 * @returns {Object<string, { rows: number, sha256: string }>} Per tabelnaam aantal en hash.
 */
function fingerprint(db, tables = describe(db)) {
  return snapshot(db, () => {
    const out = {};
    for (const [name, table] of Object.entries(tables)) {
      const hash = crypto.createHash('sha256');
      let rows = 0;
      for (const row of rowsOf(db, name, table)) {
        hash.update(JSON.stringify(table.columns.map((column) => {
          const cell = value(row[column]);
          // Type meenemen: "1" (tekst) en 1 (getal) zijn niet hetzelfde.
          return cell === null ? null : [typeof cell, cell];
        })));
        hash.update('\n');
        rows++;
      }
      out[name] = { rows, sha256: hash.digest('hex') };
    }
    return out;
  });
}

/**
 * Kopieert alle rijen van de ene database naar de andere en controleert daarna
 * met de vingerafdrukken dat beide kanten exact gelijk zijn. Het doel moet
 * hetzelfde schema (dezelfde versie) hebben en leeg zijn.
 * @param {object} from Brondatabase.
 * @param {object} to Doeldatabase.
 * @param {{ log?: Function }} [options] Functie voor voortgangsregels.
 * @returns {{ tables: Object<string, number>, source: object, target: object }} Aantallen per tabel en de vingerafdrukken van beide kanten.
 * @throws {Error} Bij een ander schema, een niet-lege doeldatabase of een verschil na het kopiëren.
 */
function copyDatabase(from, to, { log = () => {} } = {}) {
  if (from === to || (from.bridge && from.bridge === to.bridge)) throw new Error('Bron en doel moeten verschillende databases zijn.');
  const sourceVersion = schemaVersion(from);
  const targetVersion = schemaVersion(to);
  if (sourceVersion !== targetVersion) throw new Error(`Schemaversie verschilt: bron ${sourceVersion}, doel ${targetVersion}. Werk eerst beide bij naar dezelfde versie van de app.`);
  const sourceTables = describe(from);
  const targetTables = describe(to);
  const names = Object.keys(sourceTables).sort();
  if (names.join() !== Object.keys(targetTables).sort().join()) {
    throw new Error(`Tabellen verschillen: bron [${names.join(', ')}], doel [${Object.keys(targetTables).sort().join(', ')}].`);
  }
  for (const name of names) {
    if (sourceTables[name].columns.join() !== targetTables[name].columns.join()) throw new Error(`Kolommen van ${name} verschillen: bron [${sourceTables[name].columns}], doel [${targetTables[name].columns}].`);
    const filled = to.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n;
    if (filled) throw new Error(`Doeldatabase is niet leeg (${name}: ${filled} rijen). Kopieer alleen naar een lege database.`);
  }

  const counts = {};
  snapshot(from, () => transaction(to, () => {
    // Volgorde van tabellen doet er niet toe: foreign keys pas bij COMMIT.
    deferForeignKeys(to);
    for (const name of names) {
      const { columns } = sourceTables[name];
      const insert = to.prepare(`INSERT INTO ${name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
      let rows = 0;
      for (const row of rowsOf(from, name, sourceTables[name])) {
        insert.run(...columns.map((column) => value(row[column])));
        rows++;
      }
      counts[name] = rows;
      log(`${name}: ${rows} rij(en)`);
    }
  }));

  const sourcePrints = fingerprint(from, sourceTables);
  const targetPrints = fingerprint(to, sourceTables);
  const diff = names.filter((name) => sourcePrints[name].rows !== targetPrints[name].rows || sourcePrints[name].sha256 !== targetPrints[name].sha256);
  if (diff.length) {
    throw new Error(`Controle mislukt, verschil in: ${diff.map((name) => `${name} (bron ${sourcePrints[name].rows}, doel ${targetPrints[name].rows} rijen)`).join(', ')}.`);
  }
  return { tables: counts, source: sourcePrints, target: targetPrints };
}

module.exports = { copyDatabase, fingerprint, describe };
