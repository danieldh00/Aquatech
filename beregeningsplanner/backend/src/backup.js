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

const keyOf = (vault) => vault.derive('back-ups');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

async function encryptFile(src, dest, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, Buffer.from([VERSION]), iv]));
  await pipeline(fs.createReadStream(src), cipher, out, { end: false });
  await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve())));
}

async function decryptFile(src, dest, key) {
  const { size } = fs.statSync(src);
  if (size < HEADER + TAG) throw new Error('Geen geldige back-up (te klein).');
  const fd = fs.openSync(src, 'r');
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  try {
    fs.readSync(fd, head, 0, HEADER, 0);
    fs.readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.subarray(0, 4).equals(MAGIC) || head[4] !== VERSION) throw new Error('Geen Aquatech-back-up of onbekende versie.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(5));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const tmp = `${dest}.part`;
  try {
    // De tag wordt pas aan het eind gecontroleerd; daarom eerst naar .part.
    await pipeline(fs.createReadStream(src, { start: HEADER, end: size - TAG - 1 }), decipher, fs.createWriteStream(tmp, { mode: 0o600 }));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Ontsleutelen mislukt (verkeerde hoofdsleutel of beschadigde back-up): ${err.message}`);
  }
  fs.renameSync(tmp, dest);
}

/** Maakt een versleutelde back-up in `dir`; geeft { name, size, createdAt }. */
async function createBackup({ db, dir, vault }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `aquatech-${stamp()}.db.enc`;
  const tmp = path.join(dir, `.tmp-${crypto.randomUUID()}.db`);
  const part = path.join(dir, `${name}.part`);
  try {
    if (isPg(db)) {
      // PostgreSQL: alle rijen naar een nieuw SQLite-bestand (zelfde schema),
      // zodat een back-up altijd hetzelfde formaat heeft en terug te zetten is.
      const copy = openSqlite(tmp);
      try { copyDatabase(db, copy); } finally { copy.close(); }
    } else {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    }
    await encryptFile(tmp, part, keyOf(vault));
    fs.renameSync(part, path.join(dir, name));
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(part, { force: true });
  }
  const st = fs.statSync(path.join(dir, name));
  return { name, size: st.size, createdAt: st.mtime.toISOString() };
}

function listBackups(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => NAME.test(n));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { name, size: st.size, createdAt: st.mtime.toISOString() };
  }).sort((a, b) => b.name.localeCompare(a.name));
}

/** Verwijdert back-ups ouder dan keepDays; de nieuwste blijft altijd staan. */
function pruneBackups(dir, keepDays) {
  const cutoff = Date.now() - keepDays * 86400000;
  const removed = [];
  for (const b of listBackups(dir).slice(1)) {
    if (Date.parse(b.createdAt) < cutoff) {
      fs.rmSync(path.join(dir, b.name), { force: true });
      removed.push(b.name);
    }
  }
  return removed;
}

const isBackupName = (name) => NAME.test(String(name));

module.exports = { createBackup, listBackups, pruneBackups, decryptFile, isBackupName, keyOf };

if (require.main === module) {
  const [cmd, src, dest] = process.argv.slice(2);
  if (!(cmd === 'decrypt' && src && dest) && cmd !== 'create') {
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
  if (cmd === 'create') {
    const { openDatabase } = require('./database/db');
    const dir = src || process.env.BACKUP_DIR || path.join(dataDir, 'backups');
    createBackup({ db: openDatabase(dataDir), dir, vault })
      .then((b) => { console.log(`Back-up gemaakt: ${path.join(dir, b.name)} (${b.size} bytes)`); process.exit(0); })
      .catch((err) => { console.error(`Back-up mislukt: ${err.message}`); process.exit(1); });
  } else if (fs.existsSync(dest)) {
    console.error(`${dest} bestaat al; kies een ander doel of verplaats het eerst.`);
    process.exit(1);
  } else {
    decryptFile(src, dest, keyOf(vault))
      .then(() => console.log(`Teruggezet naar ${dest}. Zet dit bestand als aquatech.db in de datamap (app gestopt), of kopieer het met migrate-to-postgres.js naar PostgreSQL.`))
      .catch((err) => { console.error(err.message); process.exit(1); });
  }
}
