// Een hele app-back-up (backup.js, `.db.enc`) terugzetten in een lege, gemigreerde database. Twee toepassingen:
// - de hersteltest van de Google Drive-back-up (deploy/apps01/restore-test-drive.sh): in een wegwerpcontainer met een
//   wegwerpdatabase (host `db`), met de schakelaar AQUATECH_RESTORE_TEST=1;
// - noodherstel (`node src/backup.js noodherstel`, deploy/apps01/localdb/local-db.sh restore-app): na verlies van de server
//   een nieuwe, lege database vullen uit de Drive-kopie, met de schakelaar AQUATECH_EMERGENCY_RESTORE=1 en alleen als er nog
//   geen enkel account in de database staat (nooit over echte gegevens heen).
// Beide leegmaken alle tabellen, dus beide weigeren zonder hun bewuste schakelaar.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { decryptFile, keyOf } = require('../backup');
const { listTables } = require('../database/db');
const { importLines } = require('../database/table-rows');

// Het enige dat een vers gemigreerde database mag bevatten: de rij van de hoofdtenant (door de eerste start aangemaakt).
const SEED_TABLES = ['tenants'];

/**
 * Telt de rijen in alle tabellen behalve die van een vers gemigreerde database (de hoofdtenant).
 * @param {object} db De database.
 * @returns {Object<string, number>} Alleen de tabellen met minstens één rij, met hun aantal; leeg = een lege database.
 */
function realDataOf(db) {
  const found = {};
  for (const table of listTables(db)) {
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
    const count = Number(total);
    if (count > (SEED_TABLES.includes(table) ? 1 : 0)) found[table] = count;
  }
  return found;
}

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
 * @param {{ db: object, file: string, vault: object, env?: object, tempDir?: string, emergency?: boolean }} options De database, het back-upbestand, de kluis, de omgeving, een map voor het ontsleutelde tussenbestand en of het noodherstel is (lege echte database i.p.v. de wegwerpdatabase van de hersteltest).
 * @returns {Promise<{ tables: Object<string, number> }>} Aantal ingelezen rijen per tabel.
 * @throws {Error} Zonder de schakelaar (AQUATECH_RESTORE_TEST=1, bij noodherstel AQUATECH_EMERGENCY_RESTORE=1), bij noodherstel in een database met gegevens, bij een onbekende of beschadigde back-up of een verkeerde sleutel.
 */
async function restoreAll({ db, file, vault, env = process.env, tempDir = os.tmpdir(), emergency = false }) {
  if (emergency) {
    if (env.AQUATECH_EMERGENCY_RESTORE !== '1') throw new Error('Noodherstel vraagt de bewuste schakelaar AQUATECH_EMERGENCY_RESTORE=1; dit leegt alle tabellen.');
    // Tweede slot (faalt gesloten): alleen in een database zonder accounts of andere echte gegevens.
    const found = realDataOf(db);
    if (Object.keys(found).length) {
      throw new Error(`Noodherstel mag alleen in een lege database; er staan al gegevens in (${Object.entries(found).map(([table, total]) => `${table}: ${total}`).join(', ')}).`);
    }
  } else {
    if (env.AQUATECH_RESTORE_TEST !== '1') throw new Error('Terugzetten van een hele back-up is alleen voor de hersteltest (AQUATECH_RESTORE_TEST=1); dit leegt alle tabellen.');
    // Tweede slot (faalt gesloten): de hersteltest-container bereikt de wegwerpdatabase altijd onder de naam `db` op een intern netwerk.
    let host = '';
    try {
      const url = env.DATABASE_URL || (env.DATABASE_URL_FILE ? fs.readFileSync(env.DATABASE_URL_FILE, 'utf8').trim() : '');
      host = new URL(url).hostname;
    } catch { host = ''; }
    if (host !== 'db') throw new Error('Terugzetten van een hele back-up mag alleen in de wegwerpdatabase (host `db`), niet in deze database.');
  }
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

module.exports = { restoreAll, clearTables, realDataOf };
