// Alle rijen van alle tabellen als regels tekst (JSON) uitvoeren en weer inlezen: de basis van de versleutelde
// back-ups (backup.js) en daarna van terugzetten uit een back-up (backup-restore.js). Plus een vingerafdruk per tabel
// (aantal rijen + SHA-256 over alle waarden, op volgorde van de primaire sleutel) om twee databases te vergelijken.
//
// Regels: eerst een kop {"format","version","schemaVersion"}, dan per tabel {"table","columns"} gevolgd door één
// regel per rij (een array met de waarden in de volgorde van "columns"). Er wordt niets omgezet of opnieuw
// versleuteld: id's (UUID's), tenant_id's, wachtwoord-hashes, sessie-hashes en versleutelde geheimen (vault, met de
// tenant in de AAD) gaan ongewijzigd mee. De hoofdsleutel blijft dus nodig.
const crypto = require('crypto');
const { listTables, tableColumns, schemaVersion, deferForeignKeys } = require('./db');

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
    const keyColumns = columnInfo.filter((column) => column.pk);
    const primaryKey = keyColumns.map((column) => column.name);
    tables[name] = {
      columns: columnInfo.map((column) => column.name),
      order: primaryKey.length ? primaryKey : columnInfo.map((column) => column.name),
      keyed: primaryKey.length > 0,
    };
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
  db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
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

/** Naam en versie van het formaat in de kop van een export. */
const FORMAT = 'aquatech-backup';
const FORMAT_VERSION = 2;

/**
 * Alle rijen van de database als regels tekst (zie de kop van dit bestand), uit één leestransactie, dus
 * consistent. Een generator, zodat de aanroeper de regels kan wegschrijven zonder alles in het geheugen te houden.
 * Sluit de transactie ook als de aanroeper eerder stopt.
 * @param {object} db Databaseverbinding.
 * @returns {Generator<string>} De regels, elk eindigend op een nieuwe regel.
 */
function* exportLines(db) {
  const tables = describe(db);
  db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    yield `${JSON.stringify({ format: FORMAT, version: FORMAT_VERSION, schemaVersion: schemaVersion(db) })}\n`;
    for (const [name, table] of Object.entries(tables)) {
      yield `${JSON.stringify({ table: name, columns: table.columns })}\n`;
      for (const row of rowsOf(db, name, table)) yield `${JSON.stringify(table.columns.map((column) => value(row[column])))}\n`;
    }
  } finally {
    db.exec('COMMIT');
  }
}

/**
 * Leest een export (exportLines) in een lege database met hetzelfde of een nieuwer schema (ook een tijdelijk schema zonder sleutels, zie openScratch). Kolommen die in de
 * export staan maar niet meer bestaan worden overgeslagen, nieuwe kolommen krijgen hun standaardwaarde; een export
 * van een nieuwer schema dan dat van de database wordt geweigerd.
 * @param {object} db De (lege, gemigreerde) doeldatabase.
 * @param {AsyncIterable<string>|Iterable<string>} lines De regels van de export (zonder het einde van de regel).
 * @param {{ deferForeignKeys?: boolean }} [options] deferForeignKeys: foreign keys pas bij COMMIT controleren (nodig bij een echt schema met verwijzingen; een tijdelijk schema heeft die niet).
 * @returns {Promise<{ tables: Object<string, number> }>} Aantal ingelezen rijen per tabel.
 * @throws {Error} Bij een onbekend formaat, een nieuwer schema of een beschadigde regel.
 */
async function importLines(db, lines, options = {}) {
  let header = null;
  const counts = {};
  let insert = null;
  let currentTable = '';
  let positions = [];
  let splitReservationOwner = false;
  db.exec('BEGIN');
  try {
    if (options.deferForeignKeys) deferForeignKeys(db);
    const tables = describe(db);
    for await (const line of lines) {
      if (!line) continue;
      const parsed = JSON.parse(line);
      if (!header) {
        header = parsed;
        if (header.format !== FORMAT || header.version !== FORMAT_VERSION) throw new Error('Geen back-up in het huidige formaat.');
        if (header.schemaVersion > schemaVersion(db)) throw new Error(`Back-up is van een nieuwere versie van de app (schema ${header.schemaVersion}, deze app ${schemaVersion(db)}).`);
        continue;
      }
      if (!Array.isArray(parsed)) {
        const target = tables[parsed.table];
        insert = null;
        if (!target) continue;
        // Alleen de kolommen die in beide bestaan, op hun plek in de regels van de export.
        positions = parsed.columns.map((column, index) => ({ column, index })).filter((entry) => target.columns.includes(entry.column));
        // Reserveringen uit een back-up van vóór migratie 96 hadden één kolom: `order:<id>` voor een webshopbestelling.
        splitReservationOwner = parsed.table === 'stock_reservations' && !parsed.columns.includes('web_order_id') && positions.some((entry) => entry.column === 'work_order_id');
        const columnNames = positions.map((entry) => entry.column);
        if (splitReservationOwner) columnNames.push('web_order_id');
        insert = db.prepare(`INSERT INTO ${parsed.table} (${columnNames.join(', ')}) VALUES (${columnNames.map(() => '?').join(', ')})`);
        currentTable = parsed.table;
        counts[currentTable] = 0;
        continue;
      }
      if (!insert) continue;
      const values = positions.map((entry) => parsed[entry.index]);
      if (splitReservationOwner) {
        const ownerAt = positions.findIndex((entry) => entry.column === 'work_order_id');
        const owner = String(values[ownerAt] ?? '');
        values.push(owner.startsWith('order:') ? owner.slice(6) : null);
        if (owner.startsWith('order:')) values[ownerAt] = null;
      }
      insert.run(...values);
      counts[currentTable]++;
    }
    if (!header) throw new Error('Lege back-up.');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { tables: counts };
}

module.exports = { exportLines, importLines, fingerprint, describe, rowsOf };
