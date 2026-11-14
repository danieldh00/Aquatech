// Bestellen als gast in de eigen webshop (zonder account): wie toegang heeft tot de bestelling.
// Een gast krijgt bij het plaatsen een willekeurig toegangstoken. In de bestelling staat alleen de SHA-256 ervan (voor de controle) en
// het versleutelde token (vault, zodat de mails over de bestelling de persoonlijke link kunnen bevatten). De browser waarmee is besteld
// onthoudt het token in een httpOnly-cookie; op een ander apparaat werkt de link uit de mail (`?k=…`), die direct tegen een cookie wordt
// ingewisseld en doorstuurt naar het adres zonder token, zodat het token niet in de adresbalk, de browsergeschiedenis, de Referer of
// Google Analytics belandt. Een link verloopt zoals andere klantlinks (platform/public-links.js).

const crypto = require('node:crypto');
const { parseCookies } = require('../beveiliging/auth');
const { linkExpired } = require('../platform/public-links');

/** Naam van de cookie met de toegangstokens van de bestellingen die deze browser mag bekijken. */
const GUEST_COOKIE = 'aquatech_gastbestelling';
/** Hoeveel bestellingen één browser onthoudt (de oudste valt eruit). */
const MAX_REMEMBERED = 5;
/** Hoe lang (s) de browser een token onthoudt: gelijk aan het verlopen van een klantlink (180 dagen). */
const COOKIE_MAX_AGE = 180 * 24 * 60 * 60;
/** Een token: 32 willekeurige bytes als base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Een bestellings-id (UUID). */
const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * De SHA-256 van een token als hexadecimale tekst.
 * @param {string} token Het token.
 * @returns {string} De hash.
 */
const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Vergelijkt twee hexadecimale hashes in constante tijd.
 * @param {string} left De ene hash.
 * @param {string} right De andere hash.
 * @returns {boolean} true als ze gelijk zijn.
 */
function sameHash(left, right) {
  const first = Buffer.from(String(left), 'utf8');
  const second = Buffer.from(String(right), 'utf8');
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

/**
 * Of het verzoek via https binnenkomt (achter de Cloudflare-tunnel de kop X-Forwarded-Proto).
 * @param {object} req Het verzoek.
 * @returns {boolean} true bij https.
 */
const isSecure = (req) => req.headers['x-forwarded-proto'] === 'https';

/**
 * De naam van de cookie: over https met voorvoegsel `__Host-` (alleen voor dit domein, altijd Secure, pad /).
 * @param {object} req Het verzoek.
 * @returns {string} De cookienaam.
 */
const cookieNameOf = (req) => (isSecure(req) ? `__Host-${GUEST_COOKIE}` : GUEST_COOKIE);

/**
 * Leest de onthouden toegangstokens uit de cookie (`<bestelling>.<token>` gescheiden door `~`); ongeldige delen vallen weg.
 * @param {object} req Het verzoek.
 * @returns {Map<string, string>} Het token per bestellings-id.
 */
function readGrants(req) {
  const grants = new Map();
  const raw = parseCookies(req.headers.cookie)[cookieNameOf(req)];
  if (!raw || raw.length > 1000) return grants;
  for (const part of raw.split('~').slice(0, MAX_REMEMBERED)) {
    const [orderId, token, extra] = part.split('.');
    if (extra === undefined && ORDER_ID_PATTERN.test(orderId || '') && TOKEN_PATTERN.test(token || '')) grants.set(orderId, token);
  }
  return grants;
}

/**
 * Onthoudt het token van een bestelling in de cookie van het antwoord (de nieuwste voorop, hoogstens vijf bestellingen).
 * @param {object} req Het verzoek (voor de bestaande cookie en https-detectie).
 * @param {object} res Het antwoord.
 * @param {string} orderId Id van de bestelling.
 * @param {string} token Het toegangstoken.
 * @returns {void}
 */
function rememberGrant(req, res, orderId, token) {
  const grants = readGrants(req);
  grants.delete(orderId);
  const entries = [[orderId, token], ...grants].slice(0, MAX_REMEMBERED);
  const attributes = [`${cookieNameOf(req)}=${entries.map(([id, value]) => `${id}.${value}`).join('~')}`, 'Path=/', `Max-Age=${COOKIE_MAX_AGE}`, 'HttpOnly', 'SameSite=Lax'];
  if (isSecure(req)) attributes.push('Secure');
  const previous = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), attributes.join('; ')]);
}

/**
 * Maakt de toegangsfuncties voor gastbestellingen.
 * @param {{ orders: object, vault: { seal: Function, open: Function } }} deps De bestelopslag (web-orders.js: guestAccessOf) en de kluis voor het versleutelde token.
 * @returns {{ newAccess: Function, hasAccess: Function, tokenFor: Function, linkOf: Function, grantedToken: Function }} De functies.
 */
function createGuestOrders({ orders, vault }) {
  /**
   * De context (AAD) waarmee het token van een bestelling versleuteld is.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @returns {string} De context.
   */
  const contextOf = (tenantId, orderId) => `${tenantId}:gastbestelling:${orderId}`;

  /**
   * Maakt een nieuw toegangstoken voor een bestelling die nog geplaatst moet worden.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ token: string, hash: string, sealFor: Function }} Het token (alleen voor de klant), de hash en `sealFor(orderId)`, dat het versleutelde token voor die bestelling geeft.
   */
  function newAccess(tenantId) {
    const token = crypto.randomBytes(32).toString('base64url');
    return { token, hash: hashOf(token), sealFor: (orderId) => vault.seal(token, contextOf(tenantId, orderId)) };
  }

  /**
   * Of een token toegang geeft tot de bestelling: het is een gastbestelling, de hash klopt en de link is niet verlopen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @param {*} token Het aangeboden token.
   * @returns {boolean} true bij toegang.
   */
  function hasAccess(tenantId, orderId, token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token) || !ORDER_ID_PATTERN.test(String(orderId))) return false;
    const access = orders.guestAccessOf(tenantId, orderId);
    return Boolean(access) && sameHash(access.hash, hashOf(token)) && !linkExpired({ sharedAt: access.createdAt, referenceDate: access.updatedAt });
  }

  /**
   * Het token waarmee deze browser (cookie) de bestelling mag bekijken, als dat klopt.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} req Het verzoek.
   * @param {string} orderId Id van de bestelling.
   * @returns {string|null} Het token, of null als de cookie geen geldige toegang geeft.
   */
  function grantedToken(tenantId, req, orderId) {
    const token = readGrants(req).get(String(orderId));
    return token && hasAccess(tenantId, orderId, token) ? token : null;
  }

  /**
   * Ontsleutelt het token van een gastbestelling (voor de link in een mail).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @returns {string|null} Het token, of null als het geen gastbestelling is of het token niet te lezen is.
   */
  function tokenFor(tenantId, orderId) {
    const access = orders.guestAccessOf(tenantId, orderId);
    if (!access || !access.sealed) return null;
    try { return vault.open(access.sealed, contextOf(tenantId, orderId)); } catch { return null; }
  }

  /**
   * De persoonlijke link naar een gastbestelling, voor in een mail.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, guest?: boolean }} order De bestelling.
   * @param {string} baseUrl Het webadres van de shop uit Beheer (met slash achteraan); leeg = geen link.
   * @returns {string} De link, of een lege tekst (geen gastbestelling, geen webadres of geen leesbaar token).
   */
  function linkOf(tenantId, order, baseUrl) {
    if (!order || !order.guest || !baseUrl) return '';
    const token = tokenFor(tenantId, order.id);
    return token ? `${baseUrl}bestelling/${order.id}/?k=${token}` : '';
  }

  return { newAccess, hasAccess, tokenFor, linkOf, grantedToken };
}

module.exports = { createGuestOrders, rememberGrant, readGrants, hashOf, GUEST_COOKIE, TOKEN_PATTERN, ORDER_ID_PATTERN };
