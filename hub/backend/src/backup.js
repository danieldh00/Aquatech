// Versleutelde back-ups van de database.
//
// Een back-up bevat alle rijen van alle tabellen uit één consistente leestransactie (werkt terwijl de app draait),
// als gzip-gecomprimeerde regels JSON (zie database/table-rows.js), versleuteld met AES-256-GCM met een eigen, van de
// hoofdsleutel afgeleide sleutel. Formaat: "AQBK" + versie (1 byte, nu 2) + IV (12) + versleutelde inhoud +
// authenticatietag (16). Zonder de hoofdsleutel is een back-up dus waardeloos; kopieën buiten de server zijn veilig te
// bewaren. (Versie 1 was een SQLite-bestand; dat formaat wordt niet meer gelezen.)
//
// Terugzetten van losse records gaat in de app (Beheer > Systeem > Terugzetten uit back-up, platform/backup-restore.js);
// de hele database terugzetten gaat met de PostgreSQL-dump (deploy/apps01/pve/db-local.sh restore).
//
// Maken (ook terwijl de app draait; volgens DATABASE_URL):
//   node src/backup.js create [map]        (standaard BACKUP_DIR of DATA_DIR/backups)
// Controleren/uitpakken naar leesbare regels (JSON, gzip):
//   node src/backup.js decrypt <back-up.db.enc> <doel.ndjson.gz>
// De hoofdsleutel komt net als in de app uit AQUATECH_MASTER_KEY_FILE,
// AQUATECH_MASTER_KEY of DATA_DIR/master-key.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { exportLines } = require('./database/table-rows');

const MAGIC = Buffer.from('AQBK');
const VERSION = 2;
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
 * Ontsleutelt een back-up naar een bestand met de gecomprimeerde regels. De tag wordt pas aan het eind
 * gecontroleerd; daarom eerst naar <doel>.part en pas daarna hernoemen.
 * @param {string} source Pad van de back-up (.db.enc).
 * @param {string} target Pad van het nieuwe bestand (.ndjson.gz).
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
  if (!header.subarray(0, 4).equals(MAGIC)) throw new Error('Geen Aquatech-back-up.');
  if (header[4] === 1) throw new Error('Deze back-up heeft het oude SQLite-formaat, dat niet meer wordt ondersteund. Zet hem terug met een PostgreSQL-dump of maak een nieuwe back-up.');
  if (header[4] !== VERSION) throw new Error('Onbekende versie van de back-up.');
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
 * @param {{ db: object, dir: string, vault: object, runId?: string }} options De database, de map voor back-ups, de kluis en optioneel een run-id dat in de namen van de tijdelijke bestanden komt (zo kan alleen de eigenaar ze opruimen).
 * @returns {Promise<{ name: string, size: number, createdAt: string }>} Naam, grootte en tijdstip van de back-up.
 */
async function createBackup({ db, dir, vault, runId = '' }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `aquatech-${stamp()}.db.enc`;
  const tag = runId ? `${runId}-` : '';
  const tempFile = path.join(dir, `.tmp-${tag}${crypto.randomUUID()}.db`);
  const part = path.join(dir, `${name}.${runId ? `${runId}.` : ''}part`);
  try {
    // Alle rijen als regels JSON, gecomprimeerd naar een tijdelijk bestand, en dat daarna versleuteld.
    await pipeline(Readable.from(exportLines(db)), zlib.createGzip(), fs.createWriteStream(tempFile, { mode: 0o600 }));
    await encryptFile(tempFile, part, keyOf(vault));
    fs.renameSync(part, path.join(dir, name));
  } finally {
    fs.rmSync(tempFile, { force: true });
    fs.rmSync(part, { force: true });
  }
  const stats = fs.statSync(path.join(dir, name));
  return { name, size: stats.size, createdAt: stats.mtime.toISOString() };
}

/** Prioriteit (nice) van het kindproces dat een back-up maakt: hoger = minder voorrang op de server zelf. */
const CHILD_NICE = 10;
/** Hoogstens zoveel milliseconden mag het back-upproces duren; daarna wordt het gestopt, zodat een hangend proces niets blokkeert. */
const CHILD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Ruimt de tijdelijke bestanden op die één afgebroken back-up (herkenbaar aan zijn run-id) achterliet: de onversleutelde
 * kopie `.tmp-<run-id>-<uuid>.db` en `<naam>.<run-id>.part`. Bestanden van andere back-ups (bijvoorbeeld die van update.sh) blijven staan.
 * @param {string} dir De map met back-ups.
 * @param {string} runId Het run-id van het gestopte proces.
 * @returns {void}
 */
function removeLeftovers(dir, runId) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if ((entry.startsWith(`.tmp-${runId}-`) && entry.endsWith('.db')) || (entry.startsWith('aquatech-') && entry.endsWith(`.db.enc.${runId}.part`))) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
}

/**
 * Maakt een versleutelde back-up in een eigen proces (`node src/backup.js create <map>`), zodat het kopiëren van de hele
 * database de hoofdthread van de server niet stilzet. Het proces draait met lagere prioriteit; de uitkomst is dezelfde
 * als bij createBackup. Het proces opent zelf de database (DATABASE_URL of DATA_DIR uit `env`).
 * @param {{ dir: string, env?: object, script?: string, timeoutMs?: number }} options De map voor back-ups, de omgevingsvariabelen, (voor tests) het script en de maximale duur (standaard 30 minuten, daarna wordt het proces gestopt).
 * @returns {Promise<{ name: string, size: number, createdAt: string }>} Naam, grootte en tijdstip van de back-up.
 * @throws {Error} Als het proces mislukt; de melding bevat het laatste stuk van de foutuitvoer.
 */
function createBackupInChild({ dir, env = process.env, script = __filename, timeoutMs = CHILD_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const runId = crypto.randomUUID();
    const child = spawn(process.execPath, [script, 'create', dir], { env: { ...env, AQUATECH_BACKUP_RUN: runId }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-2000); });
    try {
      if (child.pid) os.setPriority(child.pid, CHILD_NICE);
    } catch {
      // Zonder rechten om de prioriteit te zetten draait het proces gewoon met de normale prioriteit.
    }
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`Back-upproces starten mislukt: ${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        removeLeftovers(dir, runId);
        return reject(new Error(`Back-upproces gestopt na ${Math.round(timeoutMs / 1000)} seconden zonder resultaat.`));
      }
      if (code !== 0) return reject(new Error(`Back-upproces mislukt (code ${code}): ${errors.trim() || output.trim()}`));
      const match = /Back-up gemaakt: (.+) \(\d+ bytes\)/.exec(output);
      const name = match && path.basename(match[1]);
      if (!name || !NAME.test(name)) return reject(new Error('Back-upproces gaf geen bestandsnaam terug.'));
      try {
        const stats = fs.statSync(path.join(dir, name));
        resolve({ name, size: stats.size, createdAt: stats.mtime.toISOString() });
      } catch (error) {
        reject(error);
      }
    });
  });
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

module.exports = { createBackup, createBackupInChild, listBackups, pruneBackups, decryptFile, isBackupName, keyOf };

if (require.main === module) {
  const [command, source, target] = process.argv.slice(2);
  if (!(command === 'decrypt' && source && target) && !(command === 'restore-into' && source) && command !== 'create') {
    console.error('Gebruik: node src/backup.js create [map]\n       node src/backup.js decrypt <back-up.db.enc> <doel.ndjson.gz>\n       node src/backup.js restore-into <back-up.db.enc>   (alleen hersteltest, met AQUATECH_RESTORE_TEST=1: leegt de database)');
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
    createBackup({ db: openDatabase(), dir, vault, runId: /^[0-9a-f-]{36}$/.test(process.env.AQUATECH_BACKUP_RUN || '') ? process.env.AQUATECH_BACKUP_RUN : '' })
      .then((backup) => { console.log(`Back-up gemaakt: ${path.join(dir, backup.name)} (${backup.size} bytes)`); process.exit(0); })
      .catch((err) => { console.error(`Back-up mislukt: ${err.message}`); process.exit(1); });
  } else if (command === 'restore-into') {
    // Hersteltest van de Google Drive-back-up: zet de hele back-up terug in de (lege, gemigreerde) wegwerpdatabase van DATABASE_URL.
    const { openDatabase } = require('./database/db');
    require('./platform/backup-restore-all').restoreAll({ db: openDatabase(), file: source, vault })
      .then((result) => { console.log(`Teruggezet: ${Object.keys(result.tables).length} tabellen, ${Object.values(result.tables).reduce((sum, rows) => sum + rows, 0)} rijen.`); process.exit(0); })
      .catch((err) => { console.error(`Terugzetten mislukt: ${err.message}`); process.exit(1); });
  } else if (fs.existsSync(target)) {
    console.error(`${target} bestaat al; kies een ander doel of verplaats het eerst.`);
    process.exit(1);
  } else {
    decryptFile(source, target, keyOf(vault))
      .then(() => console.log(`Uitgepakt naar ${target} (gzip, één JSON-regel per tabelkop of rij).`))
      .catch((err) => { console.error(err.message); process.exit(1); });
  }
}
