// Wachtwoorden: scrypt-hashes, controle, wachtwoordbeleid en de vingerafdruk voor sessies.
const crypto = require('crypto');

// Parameters volgens de OWASP-aanbeveling voor scrypt (N=2^17, r=8, p=1:
// 128 MiB geheugen per berekening). Asynchroon, zodat de server tijdens het
// rekenen andere verzoeken blijft beantwoorden. Oudere, lichtere hashes worden
// bij de eerstvolgende geslaagde inlog vervangen (needsRehash).
const SCRYPT_PRODUCTION_N = 2 ** 17;

/**
 * Bepaalt de scrypt-kosten. Alleen de testrun (`npm test` zet AQUATECH_TEST_SCRYPT_N) mag ze verlagen, zodat honderden
 * testaccounts niet elk een volle OWASP-hash kosten; in productie (NODE_ENV=production) of zonder die variabele geldt altijd 2^17.
 * @param {object} [env] De omgevingsvariabelen (standaard process.env).
 * @returns {{ N: number, r: number, p: number, keylen: number }} De scrypt-parameters.
 */
function scryptParams(env = process.env) {
  const testCost = Number(env.AQUATECH_TEST_SCRYPT_N);
  const allowed = env.NODE_ENV !== 'production' && Number.isInteger(testCost) && testCost >= 1024 && testCost < SCRYPT_PRODUCTION_N && (testCost & (testCost - 1)) === 0;
  return { N: allowed ? testCost : SCRYPT_PRODUCTION_N, r: 8, p: 1, keylen: 32 };
}

const SCRYPT = scryptParams();
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/**
 * scrypt als Promise.
 * @param {string} password Het wachtwoord.
 * @param {Buffer} salt Het zout.
 * @param {number} keylen Lengte van de sleutel in bytes.
 * @param {{ N: number, r: number, p: number }} params Kosten (N), blokgrootte (r) en parallellisatie (p); de namen N/r/p zijn die van scrypt zelf.
 * @returns {Promise<Buffer>} De afgeleide sleutel.
 */
function scrypt(password, salt, keylen, { N: cost, r: blockSize, p: parallelization }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen, { N: cost, r: blockSize, p: parallelization, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Maakt een hash van een wachtwoord met scrypt (OWASP-parameters) en een willekeurig zout.
 * @param {string} password Het wachtwoord.
 * @returns {Promise<string>} 'scrypt$N$r$p$zout$hash'.
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/**
 * Controleert een wachtwoord tegen een opgeslagen hash (in constante tijd).
 * @param {string} password Het ingevoerde wachtwoord.
 * @param {string} stored De opgeslagen hash.
 * @returns {Promise<boolean>} true als het wachtwoord klopt.
 */
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, cost, blockSize, parallelization, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: +cost, r: +blockSize, p: +parallelization });
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Of een hash met oudere, lichtere parameters is gemaakt (dan bij de volgende inlog vervangen).
 * @param {string} stored De opgeslagen hash.
 * @returns {boolean} true als de hash opnieuw moet.
 */
function needsRehash(stored) {
  const [, cost, blockSize, parallelization] = String(stored || '').split('$');
  return +cost !== SCRYPT.N || +blockSize !== SCRYPT.r || +parallelization !== SCRYPT.p;
}

// Veelgebruikte (delen van) wachtwoorden; vergeleken zonder cijfers en tekens,
// dus 'Wachtwoord2024!' valt er ook onder.
const COMMON = new Set(`
  wachtwoord password paswoord passwoord welkom welkomwelkom geheim geheimpje qwerty qwertyuiop azerty asdfgh
  asdfghjkl zxcvbn abcdef abcdefgh abc letmein admin administrator beheerder gebruiker iloveyou monkey dragon
  football voetbal ajax feyenoord psv sunshine princess zomer winter lente herfst voorjaar najaar maandag
  aquatech aquatechservice beregening beregeningsplanner tuin tuinman sproeier water nunspeet nederland holland
  amsterdam rotterdam utrecht test testtest changeme default master login secret trustno
`.split(/\s+/).filter(Boolean));

/**
 * Wachtwoordbeleid (OWASP ASVS): lengte boven complexiteitsregels; geen
 * gebruikersnaam en geen veelgebruikte of herhalende wachtwoorden.
 * @param {string} password Het wachtwoord.
 * @param {string} [username] De gebruikersnaam.
 * @returns {string|null} De foutmelding, of null als het wachtwoord voldoet.
 */
function passwordProblem(password, username = '') {
  const text = String(password || '');
  if (text.length < 12) return 'Wachtwoord: minimaal 12 tekens.';
  if (text.length > 128) return 'Wachtwoord: maximaal 128 tekens.';
  const lower = text.toLowerCase();
  const user = String(username || '').toLowerCase();
  if (user.length >= 3 && lower.includes(user)) return 'Het wachtwoord mag je gebruikersnaam niet bevatten.';
  const core = lower.replace(/[^a-zà-ÿ]/g, '');
  if (COMMON.has(core) || COMMON.has(lower) || new Set(lower).size < 5 || /^(.{1,4})\1+$/.test(lower)) {
    return 'Dit wachtwoord is te voorspelbaar. Kies bijvoorbeeld een zin van een paar woorden.';
  }
  return null;
}

let dummyHash;
/**
 * Een hash van een willekeurig wachtwoord, zodat inloggen met een onbekende naam even lang duurt (eenmalig berekend).
 * @returns {Promise<string>} De hash.
 */
const getDummyHash = async () => (dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex')));

module.exports = { hashPassword, scryptParams, verifyPassword, needsRehash, passwordProblem, getDummyHash };
