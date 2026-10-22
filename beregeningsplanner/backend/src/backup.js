// Versleutelde back-ups van de database.
//
// Een back-up is een consistente kopie als SQLite-bestand (VACUUM INTO, of
// bij PostgreSQL een kopie van alle rijen via db-copy.js; werkt terwijl de app
// draait), versleuteld met AES-256-GCM met een eigen, van de hoofdsleutel
// afgeleide sleutel. Formaat: "AQBK" + versie (1 byte) + IV (12) +
// versleutelde database + authenticatietag (16). Zonder de hoofdsleutel is een
// back-up dus waardeloos; kopieën buiten de server zijn veilig te bewaren.
//
// Maken (ook terwijl de app draait; SQLite of PostgreSQL volgens DATABASE_URL):
//   node src/backup.js create [map]        (standaard BACKUP_DIR of DATA_DIR/backups)
// Terugzetten (met de app gestopt):
//   node src/backup.js decrypt <back-up.db.enc> <aquatech.db>
// De hoofdsleutel komt net als in de app uit AQUATECH_MASTER_KEY_FILE,
// AQUATECH_MASTER_KEY of DATA_DIR/master-key.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { isPg, openSqlite } = require('./database/db');
const { copyDatabase } = require('./database/db-copy');

const MAGIC = Buffer.from('AQBK');
const VERSION = 1;
const HEADER = MAGIC.length + 1 + 12;
const TAG = 16;
const NAME = /^aquatech-\d{8}-\d{6}\.db\.enc$/;

/**
 * De sleutel voor back-ups, afgeleid van de hoofdsleutel.
 * @param {object} vault De kluis (createVault).
 * @returns {Buffer} De back-upsleutel.
 */
const keyOf = (vault) => vault.derive('back-ups');

/**
 * Tijdstempel voor de bestandsnaam van een back-up (UTC), bijv. 20261022-045953.
 * @param {Date} [date] Het moment (standaard nu).
 * @returns {string} 'JJJJMMDD-UUMMSS'.
 */
function stamp(date = new Date()) {
  /**
   * Vult een getal aan tot twee cijfers.
   * @param {number} number Het getal.
   * @returns {string} Bijv. '07'.
   */
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/**
 * Versleutelt een bestand naar het back-upformaat (kop + versleutelde inhoud + tag).
 * @param {string} source Pad van het onversleutelde bestand.
 * @param {string} target Pad van de versleutelde back-up.
 * @param {Buffer} key De back-upsleutel.
 * @returns {Promise<void>}
 */
async function encryptFile(source, target, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const output = fs.createWriteStream(target, { mode: 0o600 });
  output.write(Buffer.concat([MAGIC, Buffer.from([VERSION]), iv]));
  await pipeline(fs.createReadStream(source), cipher, output, { end: false });
  await new Promise((resolve, reject) => output.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve())));
}

/**
 * Ontsleutelt een back-up naar een SQLite-bestand. De tag wordt pas aan het eind
 * gecontroleerd; daarom eerst naar <doel>.part en pas daarna hernoemen.
 * @param {string} source Pad van de back-up (.db.enc).
 * @param {string} target Pad van het nieuwe databasebestand.
 * @param {Buffer} key De back-upsleutel.
 * @returns {Promise<void>}
 * @throws {Error} Bij een verkeerde sleutel, een beschadigde of onbekende back-up.
 */
async function decryptFile(source, target, key) {
  const { size } = fs.statSync(source);
  if (size < HEADER + TAG) throw new Error('Geen geldige back-up (te klein).');
  const fileHandle = fs.openSync(source, 'r');
  const header = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  try {
    fs.readSync(fileHandle, header, 0, HEADER, 0);
    fs.readSync(fileHandle, tag, 0, TAG, size - TAG);
  } finally {
    fs.closeSync(fileHandle);
  }
  if (!header.subarray(0, 4).equals(MAGIC) || header[4] !== VERSION) throw new Error('Geen Aquatech-back-up of onbekende versie.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(5));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const partFile = `${target}.part`;
  try {
    // De tag wordt pas aan het eind gecontroleerd; daarom eerst naar .part.
    await pipeline(fs.createReadStream(source, { start: HEADER, end: size - TAG - 1 }), decipher, fs.createWriteStream(partFile, { mode: 0o600 }));
  } catch (err) {
    fs.rmSync(partFile, { force: true });
    throw new Error(`Ontsleutelen mislukt (verkeerde hoofdsleutel of beschadigde back-up): ${err.message}`);
  }
  fs.renameSync(partFile, target);
}

/**
 * Maakt een versleutelde back-up van de database (ook terwijl de app draait).
 * @param {{ db: object, dir: string, vault: object }} options De database, de map voor back-ups en de kluis.
 * @returns {Promise<{ name: string, size: number, createdAt: string }>} Naam, grootte en tijdstip van de back-up.
 */
async function createBackup({ db, dir, vault }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `aquatech-${stamp()}.db.enc`;
  const tempFile = path.join(dir, `.tmp-${crypto.randomUUID()}.db`);
  const part = path.join(dir, `${name}.part`);
  try {
    if (isPg(db)) {
      // PostgreSQL: alle rijen naar een nieuw SQLite-bestand (zelfde schema),
      // zodat een back-up altijd hetzelfde formaat heeft en terug te zetten is.
      const copy = openSqlite(tempFile);
      try { copyDatabase(db, copy); } finally { copy.close(); }
    } else {
      db.exec(`VACUUM INTO '${tempFile.replace(/'/g, "''")}'`);
    }
    await encryptFile(tempFile, part, keyOf(vault));
    fs.renameSync(part, path.join(dir, name));
  } finally {
    fs.rmSync(tempFile, { force: true });
    fs.rmSync(part, { force: true });
  }
  const stats = fs.statSync(path.join(dir, name));
  return { name, size: stats.size, createdAt: stats.mtime.toISOString() };
}

/**
 * De back-ups in een map, nieuwste eerst.
 * @param {string} dir De map met back-ups.
 * @returns {{ name: string, size: number, createdAt: string }[]} De back-ups (leeg als de map niet bestaat).
 */
function listBackups(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((entry) => NAME.test(entry));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.map((name) => {
    const stats = fs.statSync(path.join(dir, name));
    return { name, size: stats.size, createdAt: stats.mtime.toISOString() };
  }).sort((left, right) => right.name.localeCompare(left.name));
}

/**
 * Verwijdert back-ups ouder dan keepDays; de nieuwste blijft altijd staan.
 * @param {string} dir De map met back-ups.
 * @param {number} keepDays Bewaartermijn in dagen.
 * @returns {string[]} Namen van de verwijderde back-ups.
 */
function pruneBackups(dir, keepDays) {
  const cutoff = Date.now() - keepDays * 86400000;
  const removed = [];
  for (const backup of listBackups(dir).slice(1)) {
    if (Date.parse(backup.createdAt) < cutoff) {
      fs.rmSync(path.join(dir, backup.name), { force: true });
      removed.push(backup.name);
    }
  }
  return removed;
}

/**
 * Of een naam de vorm van een back-upbestand heeft (aquatech-JJJJMMDD-UUMMSS.db.enc).
 * @param {string} name De bestandsnaam.
 * @returns {boolean} true bij een geldige naam.
 */
const isBackupName = (name) => NAME.test(String(name));

module.exports = { createBackup, listBackups, pruneBackups, decryptFile, isBackupName, keyOf };

if (require.main === module) {
  const [command, source, target] = process.argv.slice(2);
  if (!(command === 'decrypt' && source && target) && command !== 'create') {
    console.error('Gebruik: node src/backup.js create [map]\n       node src/backup.js decrypt <back-up.db.enc> <doelbestand.db>');
    process.exit(2);
  }
  const { createVault, loadOrCreateMasterKey } = require('./beveiliging/vault');
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data');
  // Nooit een nieuwe hoofdsleutel maken: dan is de back-up met de echte sleutel niet te lezen.
  if (!process.env.AQUATECH_MASTER_KEY_FILE && !process.env.AQUATECH_MASTER_KEY && !fs.existsSync(path.join(dataDir, 'master-key'))) {
    console.error('Geen hoofdsleutel gevonden (AQUATECH_MASTER_KEY_FILE, AQUATECH_MASTER_KEY of DATA_DIR/master-key).');
    process.exit(1);
  }
  const vault = createVault(loadOrCreateMasterKey(dataDir).key);
  if (command === 'create') {
    const { openDatabase } = require('./database/db');
    const dir = source || process.env.BACKUP_DIR || path.join(dataDir, 'backups');
    createBackup({ db: openDatabase(dataDir), dir, vault })
      .then((backup) => { console.log(`Back-up gemaakt: ${path.join(dir, backup.name)} (${backup.size} bytes)`); process.exit(0); })
      .catch((err) => { console.error(`Back-up mislukt: ${err.message}`); process.exit(1); });
  } else if (fs.existsSync(target)) {
    console.error(`${target} bestaat al; kies een ander doel of verplaats het eerst.`);
    process.exit(1);
  } else {
    decryptFile(source, target, keyOf(vault))
      .then(() => console.log(`Teruggezet naar ${target}. Zet dit bestand als aquatech.db in de datamap (app gestopt), of kopieer het met migrate-to-postgres.js naar PostgreSQL.`))
      .catch((err) => { console.error(err.message); process.exit(1); });
  }
}
