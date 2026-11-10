// Tweestapsverificatie met een authenticator-app (TOTP, RFC 6238; 5 uit de audit van 1.7.3).
// Zuivere functies zonder bibliotheek: geheim maken (base32), de code van een moment berekenen
// (HMAC-SHA1, 30 seconden, 6 cijfers), een ingevoerde code controleren met één stap speling en
// zonder hergebruik (`lastStep`), en herstelcodes maken en controleren (alleen SHA-256 bewaard).
// De opslag (versleuteld geheim in users.totp_secret) zit in platform/store.js.
const crypto = require('crypto');

/** Het base32-alfabet (RFC 4648) waarin authenticator-apps het geheim verwachten. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Seconden per code. */
const STEP_SECONDS = 30;
/** Cijfers per code. */
const DIGITS = 6;
/** Zoveel stappen voor en na het huidige moment tellen nog (klok van de telefoon loopt iets mis). */
const WINDOW = 1;
/** Zoveel herstelcodes krijgt een gebruiker bij het aanzetten. */
const RECOVERY_COUNT = 10;

/**
 * Zet bytes om naar base32 (zonder opvulling).
 * @param {Buffer} bytes De bytes.
 * @returns {string} De base32-tekst.
 */
function toBase32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Zet base32 om naar bytes (spaties, streepjes en opvulling worden genegeerd, kleine letters mogen).
 * @param {string} text De base32-tekst.
 * @returns {Buffer} De bytes (leeg bij ongeldige tekens).
 */
function fromBase32(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) return Buffer.alloc(0);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Maakt een nieuw geheim van 20 willekeurige bytes (160 bits, zoals RFC 4226 aanraadt).
 * @returns {string} Het geheim in base32.
 */
function newSecret() {
  return toBase32(crypto.randomBytes(20));
}

/**
 * De code bij een tijdstap (HOTP, RFC 4226).
 * @param {string} secret Het geheim in base32.
 * @param {number} step De tijdstap (seconden sinds 1970 gedeeld door 30, naar beneden afgerond).
 * @returns {string} De code van zes cijfers.
 */
function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(number).padStart(DIGITS, '0');
}

/**
 * De tijdstap van een moment.
 * @param {number} [now] Het moment in milliseconden (standaard nu).
 * @returns {number} De tijdstap.
 */
const stepOf = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * Controleert een ingevoerde code: geldig binnen één stap voor of na nu, en alleen als die stap later is dan de laatst
 * gebruikte (een afgekeken of onderschepte code werkt dus geen tweede keer).
 * @param {string} secret Het geheim in base32.
 * @param {*} input De ingevoerde code (spaties worden genegeerd).
 * @param {{ lastStep?: number|null, now?: number }} [options] lastStep = de stap van de vorige geslaagde code; now = het moment (tests).
 * @returns {{ ok: boolean, step?: number }} ok met de gebruikte stap (om op te slaan als lastStep).
 */
function verify(secret, input, { lastStep = null, now = Date.now() } = {}) {
  const code = String(input ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code) || !secret) return { ok: false };
  const current = stepOf(now);
  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const step = current + offset;
    if (lastStep != null && step <= Number(lastStep)) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return { ok: true, step };
  }
  return { ok: false };
}

/**
 * Het adres dat een authenticator-app inleest (als QR-code of als link op de telefoon).
 * @param {{ secret: string, account: string, issuer: string }} input Geheim, accountnaam (bijv. gebruikersnaam) en uitgever (naam van de app).
 * @returns {string} Het otpauth://-adres.
 */
function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/**
 * De hash van een herstelcode (hoofdletterongevoelig, zonder spaties of streepjes).
 * @param {string} code De herstelcode.
 * @returns {string} SHA-256 in hex.
 */
const recoveryHash = (code) => crypto.createHash('sha256').update(String(code || '').toUpperCase().replace(/[\s-]/g, '')).digest('hex');

/**
 * Maakt nieuwe herstelcodes: tien codes van tien tekens (als XXXXX-XXXXX), alleen de hashes worden bewaard.
 * @returns {{ codes: string[], hashes: string[] }} De codes (één keer tonen) en hun hashes (opslaan).
 */
function newRecoveryCodes() {
  const codes = Array.from({ length: RECOVERY_COUNT }, () => {
    const raw = toBase32(crypto.randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map(recoveryHash) };
}

/**
 * Zoekt een ingevoerde herstelcode in de bewaarde hashes.
 * @param {string[]} hashes De bewaarde hashes.
 * @param {*} input De ingevoerde code.
 * @returns {number} De plek van de code in de lijst, of -1 als hij er niet in staat.
 */
function matchRecovery(hashes, input) {
  const code = String(input ?? '').replace(/[\s-]/g, '');
  if (!/^[A-Za-z2-7]{10}$/.test(code)) return -1;
  const wanted = Buffer.from(recoveryHash(code), 'hex');
  let found = -1;
  (Array.isArray(hashes) ? hashes : []).forEach((hash, index) => {
    const stored = Buffer.from(String(hash), 'hex');
    if (stored.length === wanted.length && crypto.timingSafeEqual(stored, wanted) && found < 0) found = index;
  });
  return found;
}

module.exports = { toBase32, fromBase32, newSecret, codeAt, stepOf, verify, otpauthUri, newRecoveryCodes, matchRecovery, recoveryHash, STEP_SECONDS, DIGITS, RECOVERY_COUNT };
