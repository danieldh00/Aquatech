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

/**
 * Leest een hoofdsleutel uit tekst: 64 hex-tekens of 32 bytes in base64.
 * @param {string} raw De sleutel als tekst.
 * @returns {Buffer} De sleutel van 32 bytes.
 * @throws {Error} Als de sleutel niet 32 bytes is.
 */
function parseKey(raw) {
  const text = String(raw || '').trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  const decoded = Buffer.from(text, 'base64');
  if (decoded.length === 32) return decoded;
  throw new Error('De hoofdsleutel moet 32 bytes zijn (64 hex-tekens of base64).');
}

/**
 * Laadt de hoofdsleutel uit AQUATECH_MASTER_KEY_FILE, AQUATECH_MASTER_KEY of
 * het bestand master-key in de datamap; bestaat geen van drieën, dan wordt een
 * nieuw sleutelbestand aangemaakt (alleen leesbaar voor de eigenaar).
 * @param {string} dataDir Map met de gegevens van de app.
 * @param {object} [env] Omgevingsvariabelen (standaard process.env).
 * @returns {{ key: Buffer, source: string }} De sleutel en waar hij vandaan kwam (voor het logboek).
 */
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

/**
 * Maakt de kluis voor versleutelen en ontsleutelen met sleutels die van de hoofdsleutel zijn afgeleid.
 * @param {Buffer} [masterKey] Hoofdsleutel van 32 bytes; zonder sleutel een willekeurige (alleen voor tests).
 * @returns {{ seal: Function, open: Function, isSealed: Function, derive: Function, sealBytes: Function, openBytes: Function }} De kluisfuncties.
 */
function createVault(masterKey) {
  const master = masterKey || crypto.randomBytes(32);
  if (master.length !== 32) throw new Error('Hoofdsleutel moet 32 bytes zijn.');
  /**
   * Leidt met HKDF een eigen sleutel af voor één doel (bijv. 'velden', 'bestanden', 'back-ups').
   * @param {string} purpose Het doel van de sleutel.
   * @returns {Buffer} Afgeleide sleutel van 32 bytes.
   */
  const derive = (purpose) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `aquatech:${purpose}`, 32));
  const fieldKey = derive('velden');

  /**
   * Versleutelt een tekst met AES-256-GCM; `context` (bijv. tenant + veldnaam)
   * wordt meegewogen (AAD), zodat de waarde niet naar een ander veld te kopiëren is.
   * @param {string} plaintext De te versleutelen tekst.
   * @param {string} [context] Context die bij het ontsleutelen hetzelfde moet zijn.
   * @returns {string} 'v1:iv:tag:versleuteld' in base64url.
   */
  function seal(plaintext, context = '') {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', fieldKey, iv);
    cipher.setAAD(Buffer.from(String(context)));
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
  }

  /**
   * Ontsleutelt een met seal versleutelde tekst.
   * @param {string} sealed De versleutelde waarde ('v1:...').
   * @param {string} [context] Dezelfde context als bij het versleutelen.
   * @returns {string} De oorspronkelijke tekst.
   * @throws {Error} Bij een verkeerde sleutel, context of geknoei.
   */
  function open(sealed, context = '') {
    const [version, iv, tag, ciphertext] = String(sealed).split(':');
    if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw new Error('Onbekend versleutelingsformaat.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', fieldKey, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(String(context)));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }

  // Bestanden (foto's): eigen afgeleide sleutel, binaire inhoud, als tekst
  // ("f1:iv:tag:inhoud" in base64url) zodat het in elke database past.
  const fileKey = derive('bestanden');

  /**
   * Versleutelt binaire inhoud (bijv. een foto) met de bestandssleutel.
   * @param {Buffer} bytes De inhoud.
   * @param {string} [context] Context als AAD (bijv. tenant + bestands-id).
   * @returns {string} 'f1:iv:tag:versleuteld' in base64url, zodat het in elke database als tekst past.
   */
  function sealBytes(bytes, context = '') {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, iv);
    cipher.setAAD(Buffer.from(String(context)));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return ['f1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
  }

  /**
   * Ontsleutelt binaire inhoud die met sealBytes is versleuteld.
   * @param {string} sealed De versleutelde waarde ('f1:...').
   * @param {string} [context] Dezelfde context als bij het versleutelen.
   * @returns {Buffer} De oorspronkelijke inhoud.
   * @throws {Error} Bij een verkeerde sleutel, context of geknoei.
   */
  function openBytes(sealed, context = '') {
    const [version, iv, tag, ciphertext] = String(sealed).split(':');
    if (version !== 'f1' || !iv || !tag || ciphertext === undefined) throw new Error('Onbekend versleutelingsformaat.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(String(context)));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
  }

  /**
   * Of een waarde eruitziet als een met seal versleutelde tekst.
   * @param {*} value De waarde.
   * @returns {boolean} true bij 'v1:iv:tag:versleuteld'.
   */
  const isSealed = (value) => typeof value === 'string' && /^v1:[\w-]+:[\w-]+:[\w-]*$/.test(value);

  return { seal, open, isSealed, derive, sealBytes, openBytes };
}

module.exports = { createVault, loadOrCreateMasterKey, parseKey, KEY_FILE };
