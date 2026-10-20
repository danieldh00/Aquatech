// Versleuteling van gegevens in rust (AES-256-GCM, ingebouwd in Node).
//
// De hoofdsleutel komt, in deze volgorde, uit:
//   1. AQUATECH_MASTER_KEY_FILE  (bijv. een Docker-secret onder /run/secrets)
//   2. AQUATECH_MASTER_KEY       (64 hex-tekens of 32 bytes base64)
//   3. <datamap>/master-key      (bij de eerste start willekeurig aangemaakt, 0600)
// Met 1 of 2 staat de sleutel los van de database: wie alleen het
// databasebestand of een back-up in handen krijgt, kan de geheimen en de
// back-ups niet lezen. Kwijt = geheimen en back-ups onbruikbaar; bewaar een
// kopie op een veilige plek (wachtwoordkluis).
//
// Van de hoofdsleutel worden per doel aparte sleutels afgeleid (HKDF), zodat
// bijvoorbeeld een back-upsleutel niets zegt over de sleutel voor instellingen.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_FILE = 'master-key';

function parseKey(raw) {
  const s = String(raw || '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'base64');
  if (b.length === 32) return b;
  throw new Error('De hoofdsleutel moet 32 bytes zijn (64 hex-tekens of base64).');
}

/** Geeft { key, source } terug; maakt zo nodig een sleutelbestand aan. */
function loadOrCreateMasterKey(dataDir, env = process.env) {
  if (env.AQUATECH_MASTER_KEY_FILE) {
    return { key: parseKey(fs.readFileSync(env.AQUATECH_MASTER_KEY_FILE, 'utf8')), source: 'bestand (AQUATECH_MASTER_KEY_FILE)' };
  }
  if (env.AQUATECH_MASTER_KEY) return { key: parseKey(env.AQUATECH_MASTER_KEY), source: 'omgeving (AQUATECH_MASTER_KEY)' };
  const file = path.join(dataDir, KEY_FILE);
  try {
    return { key: parseKey(fs.readFileSync(file, 'utf8')), source: `datamap (${KEY_FILE})` };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  return { key, source: `datamap (${KEY_FILE}, nieuw aangemaakt)` };
}

function createVault(masterKey) {
  const master = masterKey || crypto.randomBytes(32);
  if (master.length !== 32) throw new Error('Hoofdsleutel moet 32 bytes zijn.');
  const derive = (purpose) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `aquatech:${purpose}`, 32));
  const fieldKey = derive('velden');

  /** Versleutelt een tekst; `context` (bijv. tenant + veldnaam) wordt meegewogen (AAD). */
  function seal(plaintext, context = '') {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', fieldKey, iv);
    c.setAAD(Buffer.from(String(context)));
    const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
  }

  /** Ontsleutelt; gooit een fout bij een verkeerde sleutel, context of geknoei. */
  function open(sealed, context = '') {
    const [v, iv, tag, ct] = String(sealed).split(':');
    if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Onbekend versleutelingsformaat.');
    const d = crypto.createDecipheriv('aes-256-gcm', fieldKey, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(String(context)));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  // Bestanden (foto's): eigen afgeleide sleutel, binaire inhoud, als tekst
  // ("f1:iv:tag:inhoud" in base64url) zodat het in elke database past.
  const fileKey = derive('bestanden');

  /** Versleutelt een Buffer; `context` (bijv. tenant + bestands-id) als AAD. */
  function sealBytes(buf, context = '') {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', fileKey, iv);
    c.setAAD(Buffer.from(String(context)));
    const ct = Buffer.concat([c.update(buf), c.final()]);
    return ['f1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
  }

  /** Ontsleutelt naar een Buffer; gooit een fout bij een verkeerde sleutel, context of geknoei. */
  function openBytes(sealed, context = '') {
    const [v, iv, tag, ct] = String(sealed).split(':');
    if (v !== 'f1' || !iv || !tag || ct === undefined) throw new Error('Onbekend versleutelingsformaat.');
    const d = crypto.createDecipheriv('aes-256-gcm', fileKey, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(String(context)));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
  }

  const isSealed = (v) => typeof v === 'string' && /^v1:[\w-]+:[\w-]+:[\w-]*$/.test(v);

  return { seal, open, isSealed, derive, sealBytes, openBytes };
}

module.exports = { createVault, loadOrCreateMasterKey, parseKey, KEY_FILE };
