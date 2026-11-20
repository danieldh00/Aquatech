// Een hele app-back-up (backup.js, `.db.enc`) terugzetten in een lege, gemigreerde database. Alleen bedoeld voor de
// hersteltest van de Google Drive-back-up (deploy/apps01/restore-test-drive.sh): daar draait dit in een wegwerpcontainer
// met een wegwerpdatabase, waarna een wegwerp-app op de teruggezette gegevens wordt gestart. Het leegt alle tabellen, dus
// het weigert te draaien zonder de bewuste schakelaar AQUATECH_RESTORE_TEST=1 (nooit tegen de echte database).
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { decryptFile, keyOf } = require('../backup');
const { listTables } = require('../database/db');
const { importLines } = require('../database/table-rows');

/**
 * Leegt alle tabellen van de database.
 * @param {object} db De (gemigreerde) wegwerpdatabase.
 * @returns {number} Aantal geleegde tabellen.
 */
function clearTables(db) {
  const tables = listTables(db);
  if (tables.length) db.exec(`TRUNCATE TABLE ${tables.map((table) => `"${table}"`).join(', ')} CASCADE`);
  return tables.length;
}

/**
 * Zet een back-up volledig terug: ontsleutelen, tabellen leegmaken en alle rijen inlezen.
 * @param {{ db: object, file: string, vault: object, env?: object, tempDir?: string }} options De wegwerpdatabase, het back-upbestand, de kluis, de omgeving en een map voor het ontsleutelde tussenbestand.
 * @returns {Promise<{ tables: Object<string, number> }>} Aantal ingelezen rijen per tabel.
 * @throws {Error} Zonder AQUATECH_RESTORE_TEST=1, bij een onbekende of beschadigde back-up of een verkeerde sleutel.
 */
async function restoreAll({ db, file, vault, env = process.env, tempDir = os.tmpdir() }) {
  if (env.AQUATECH_RESTORE_TEST !== '1') throw new Error('Terugzetten van een hele back-up is alleen voor de hersteltest (AQUATECH_RESTORE_TEST=1); dit leegt alle tabellen.');
  const plain = path.join(tempDir, `restore-all-${process.pid}.ndjson.gz`);
  try {
    await decryptFile(file, plain, keyOf(vault));
    clearTables(db);
    const lines = readline.createInterface({ input: fs.createReadStream(plain).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    return await importLines(db, lines, { deferForeignKeys: true });
  } finally {
    fs.rmSync(plain, { force: true });
  }
}

module.exports = { restoreAll, clearTables };
