// Inloggen en sessies: sessie-cookies (token op de server in tabel sessions),
// de toegangscode, gastcookies, ondertekende cookies en het IP-adres van de
// bezoeker achter de Cloudflare-tunnel.

const crypto = require('crypto');
const { fingerprintOf } = require('../platform/store');

const COOKIE_NAME = 'aquatech_session';

const net = require('net');
const { isPublicAddress } = require('./netguard');

/**
 * Haalt het IPv4-adres uit een IPv4-in-IPv6-notatie (::ffff:1.2.3.4).
 * @param {string} raw Het adres zoals de socket het geeft.
 * @returns {string} Het gewone IPv4-adres, of het adres ongewijzigd.
 */
const plainIp = (raw) => (raw.startsWith('::ffff:') && net.isIPv4(raw.slice(7)) ? raw.slice(7) : raw);

/**
 * Het IP-adres van de bezoeker. Komt het verzoek van een proxy in het eigen
 * netwerk (de Cloudflare-tunnel draait als container naast de app), dan is het
 * socketadres voor iedereen hetzelfde: gebruik dan het adres dat de proxy
 * doorgeeft (CF-Connecting-IP, anders het laatste X-Forwarded-For). Zo gelden
 * de limieten (inloggen, openbare links) per bezoeker. Van een openbaar
 * socketadres worden die koppen genegeerd (niet te vervalsen door rechtstreeks
 * met de app te praten). Het resultaat wordt per verzoek onthouden.
 * @param {object} req Het Express-verzoek.
 * @returns {string} Het IP-adres van de bezoeker.
 */
function remoteIp(req) {
  if (req._remoteIp !== undefined) return req._remoteIp;
  const socketIp = plainIp(req.socket?.remoteAddress || '');
  let ip = socketIp;
  if (socketIp && !isPublicAddress(socketIp)) {
    const cloudflareIp = String(req.headers?.['cf-connecting-ip'] || '').trim();
    const forwardedIp = String(req.headers?.['x-forwarded-for'] || '').split(',').map((part) => part.trim()).filter(Boolean).pop() || '';
    const proxiedIp = net.isIP(cloudflareIp) ? cloudflareIp : net.isIP(forwardedIp) ? forwardedIp : '';
    if (proxiedIp) ip = plainIp(proxiedIp);
  }
  if (req && typeof req === 'object') req._remoteIp = ip;
  return ip;
}

/**
 * Leest de Cookie-kop uit tot een object naam → waarde (URL-gedecodeerd waar dat kan).
 * @param {string} header De Cookie-kop.
 * @returns {Object<string, string>} De cookies.
 */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 0) continue;
    const key = part.slice(0, separatorIndex).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(separatorIndex + 1).trim());
    } catch {
      out[key] = part.slice(separatorIndex + 1).trim();
    }
  }
  return out;
}

/**
 * HMAC-SHA256 van een waarde met het geheim van de app.
 * @param {string} secret Het geheim.
 * @param {string} value De waarde.
 * @returns {string} De handtekening in base64url.
 */
function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

/**
 * Vergelijkt twee teksten in constante tijd (geen informatie via de looptijd).
 * @param {string} left Eerste tekst.
 * @param {string} right Tweede tekst.
 * @returns {boolean} true als ze gelijk zijn.
 */
function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

const GUEST_COOKIE = 'aquatech_guest';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Maakt de inlog- en sessiefuncties. Sessies staan op de server (tabel
 * sessions, zie store.js): de cookie bevat alleen een willekeurig token.
 * Uitloggen, een nieuw wachtwoord, uitschakelen of een nieuwe toegangscode
 * beëindigt een sessie dus meteen. Een sessie verloopt na idleDays() zonder
 * gebruik en hoe dan ook na maxDays().
 * @param {object} options secret (geheim voor handtekeningen), store, tenantId (hoofdtenant), getAccessCode, idleDays en maxDays (functies, dagen).
 * @returns {object} De functies voor sessies, cookies, gasten en de toegangscode.
 */
function createAuth({ secret, store, tenantId, getAccessCode, idleDays = () => 14, maxDays = () => 30 }) {
  /**
   * Vingerafdruk van de huidige toegangscode; een nieuwe code maakt bestaande codesessies ongeldig.
   * @returns {string} De vingerafdruk.
   */
  const codeFingerprint = () => hmac(secret, `code:${getAccessCode()}`).slice(0, 22);
  /**
   * Vingerafdruk van het wachtwoord van een gebruiker; een nieuw wachtwoord maakt bestaande sessies ongeldig.
   * @param {object} user De gebruiker (met password_hash).
   * @returns {string} De vingerafdruk.
   */
  const userFingerprint = (user) => fingerprintOf(user.password_hash);

  /**
   * Maakt een sessie aan voor de toegangscode of een gebruiker.
   * @param {string} [subject] 'code' of het id van de gebruiker.
   * @param {object} [req] Het verzoek (voor IP-adres en browser in het sessieoverzicht).
   * @returns {string} Het token voor de cookie.
   */
  function issue(subject = 'code', req = null) {
    let userId, fingerprint;
    if (subject === 'code') {
      userId = store.systemUser(tenantId, 'beheerder', 'Beheerder (toegangscode)').id;
      fingerprint = codeFingerprint();
    } else {
      const user = store.getUser(subject);
      if (!user) throw new Error('onbekende gebruiker');
      userId = user.id;
      fingerprint = userFingerprint(user);
    }
    // Een account-sessie hoort bij de eigen tenant van het account (multitenant).
    const sessionTenant = subject === 'code' ? tenantId : store.getUser(userId).tenant_id;
    return store.createSession({
      tenantId: sessionTenant, userId, via: subject === 'code' ? 'code' : 'user', fingerprint, maxMs: maxDays() * DAY_MS,
      ip: req ? remoteIp(req) : '', userAgent: req?.headers?.['user-agent'] || '',
    });
  }

  /**
   * Controleert een sessietoken: bestaat de sessie, is hij niet verlopen en klopt
   * de vingerafdruk nog. Een ongeldige sessie wordt meteen verwijderd.
   * @param {string} token Het token uit de cookie.
   * @returns {{ subject: 'code', row: object }|{ subject: 'user', user: object, row: object }|null} De sessie, of null.
   */
  function verifySession(token) {
    // Sessie, gebruiker en tenant in één query (dit gebeurt bij elk verzoek).
    const found = store.findSessionWithUser(token);
    if (!found) return null;
    const { row } = found;
    // Toegangscode: alleen de hoofdtenant; een account: alleen de eigen tenant.
    if (row.via === 'code' && row.tenant_id !== tenantId) return null;
    const currentTime = Date.now();
    const expired = Date.parse(row.expires_at) <= currentTime
      || Date.parse(row.created_at) + maxDays() * DAY_MS <= currentTime
      || Date.parse(row.last_seen_at) + idleDays() * DAY_MS <= currentTime;
    if (expired) { store.dropSession(row); return null; }
    if (row.via === 'code') {
      if (!getAccessCode() || !safeEqual(row.fingerprint, codeFingerprint())) { store.dropSession(row); return null; }
      store.touchSession(row);
      return { subject: 'code', row };
    }
    const user = found.user;
    if (!user || user.disabled || user.kind !== 'account' || user.tenant_id !== row.tenant_id || !safeEqual(row.fingerprint, userFingerprint(user))) { store.dropSession(row); return null; }
    store.touchSession(row);
    return { subject: 'user', user, row };
  }

  /**
   * Of een token bij een geldige sessie hoort.
   * @param {string} token Het token.
   * @returns {boolean} true bij een geldige sessie.
   */
  const verify = (token) => Boolean(verifySession(token));

  /**
   * Controleert een ingevoerde toegangscode (vergelijkt hashes, zodat de looptijd niets over de lengte verraadt).
   * @param {string} code De ingevoerde code.
   * @returns {boolean} true als de code klopt.
   */
  function checkCode(code) {
    const expected = getAccessCode();
    if (!expected) return false;
    // Vergelijk hashes, zodat de looptijd niets over de lengte verraadt.
    return safeEqual(hmac(secret, `try:${code}`), hmac(secret, `try:${expected}`));
  }

  /**
   * De sessie van een verzoek (één keer per verzoek uitgerekend).
   * @param {object} req Het Express-verzoek.
   * @returns {{ via: 'code'|'user', user?: object, row: object }|null} De sessie, of null als er geen geldige is.
   */
  function session(req) {
    if (req._session !== undefined) return req._session;
    const found = verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
    req._session = !found ? null : found.subject === 'code' ? { via: 'code', row: found.row } : { via: 'user', user: found.user, row: found.row };
    return req._session;
  }

  /**
   * Of het verzoek een geldige sessie heeft.
   * @param {object} req Het Express-verzoek.
   * @returns {boolean} true als iemand is ingelogd.
   */
  function isAuthenticated(req) {
    return Boolean(session(req));
  }

  // Statische bestanden (scripts, stylesheets, afbeeldingen) achter de login:
  // een pagina laadt er tientallen tegelijk, en elke controle is een query
  // (met PostgreSQL een rondgang). Een sessie die net volledig is
  // gecontroleerd, geldt daarom ASSET_TTL_MS lang voor zulke bestanden zonder
  // nieuwe query. Alleen voor bestanden zonder gegevens; de API controleert
  // altijd tegen de database. Uitloggen wist het meteen.
  const ASSET_TTL_MS = 30 * 1000;
  const assetSessions = new Map();
  /**
   * Sleutel voor de sessiecache van statische bestanden (hash van het token, nooit het token zelf).
   * @param {string} token Het sessietoken.
   * @returns {string} De sleutel.
   */
  const assetKey = (token) => crypto.createHash('sha256').update(`asset:${token}`).digest('base64url');
  /**
   * Of een verzoek voor een statisch bestand (script, stylesheet, afbeelding) achter
   * de login mag. Een pagina laadt er tientallen tegelijk en elke controle is een
   * query; een sessie die net volledig is gecontroleerd geldt daarom ASSET_TTL_MS
   * lang zonder nieuwe query. Alleen voor bestanden zonder gegevens; de API
   * controleert altijd tegen de database.
   * @param {object} req Het Express-verzoek.
   * @returns {boolean} true als het bestand mag worden geleverd.
   */
  function isAuthenticatedForAsset(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return isAuthenticated(req);
    const key = assetKey(token);
    if ((assetSessions.get(key) || 0) > Date.now()) return true;
    const ok = isAuthenticated(req);
    if (ok) {
      if (assetSessions.size > 5000) {
        for (const [sessionKey, until] of assetSessions) if (until <= Date.now()) assetSessions.delete(sessionKey);
        if (assetSessions.size > 5000) assetSessions.clear();
      }
      assetSessions.set(key, Date.now() + ASSET_TTL_MS);
    } else assetSessions.delete(key);
    return ok;
  }

  /**
   * Middleware: alleen door met een geldige sessie, anders 401.
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord.
   * @param {Function} next Volgende middleware.
   * @returns {void}
   */
  function requireAccess(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
  }

  /**
   * Bouwt de Set-Cookie-tekst voor een cookie. 'Secure' alleen als het verzoek
   * via https binnenkwam (de tunnel zet X-Forwarded-Proto); lokaal testen via
   * http://ip:3300 moet ook werken.
   * @param {object} req Het Express-verzoek.
   * @param {string} name Naam van de cookie.
   * @param {string} value Waarde van de cookie.
   * @param {number} maxAgeMs Geldigheid in milliseconden.
   * @param {{ httpOnly?: boolean }} [options] httpOnly: false voor een cookie die de frontend mag lezen.
   * @returns {string} De Set-Cookie-waarde.
   */
  function cookieAttrs(req, name, value, maxAgeMs, { httpOnly = true } = {}) {
    // 'Secure' alleen als het verzoek via https binnenkwam (de tunnel zet
    // X-Forwarded-Proto); lokaal testen via http://ip:3300 moet ook werken.
    const attrs = [
      `${name}=${encodeURIComponent(value)}`,
      'Path=/',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
      ...(httpOnly ? ['HttpOnly'] : []),
      'SameSite=Lax',
    ];
    if (req.headers['x-forwarded-proto'] === 'https') attrs.push('Secure');
    return attrs.join('; ');
  }

  /**
   * Voegt een cookie toe aan de Set-Cookie-kop van het antwoord (naast eerder gezette cookies).
   * @param {object} res Het Express-antwoord.
   * @param {string} cookie De Set-Cookie-waarde.
   * @returns {void}
   */
  function appendCookie(res, cookie) {
    const previous = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), cookie]);
  }

  /**
   * Logt in: maakt een nieuwe sessie en zet de cookie. Een eventuele oude sessie
   * in dit toestel vervalt (geen sessie-fixatie).
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord.
   * @param {string} [subject] 'code' of het id van de gebruiker.
   * @returns {void}
   */
  function setCookie(req, res, subject = 'code') {
    const old = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (old) { store.deleteSession(old); assetSessions.delete(assetKey(old)); }
    req._session = undefined;
    appendCookie(res, cookieAttrs(req, COOKIE_NAME, issue(subject, req), maxDays() * DAY_MS));
  }

  /**
   * Logt uit: de sessie verdwijnt ook op de server en de cookie wordt gewist.
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord.
   * @returns {void}
   */
  function clearCookie(req, res) {
    const old = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (old) { store.deleteSession(old); assetSessions.delete(assetKey(old)); }
    appendCookie(res, `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  }

  /**
   * Id van de anonieme gast van deze browser (openbare planner zonder
   * toegangscode), als de ondertekende gastcookie klopt.
   * @param {object} req Het Express-verzoek.
   * @returns {string|null} Het gast-id, of null.
   */
  function guestId(req) {
    const raw = parseCookies(req.headers.cookie)[GUEST_COOKIE];
    if (typeof raw !== 'string') return null;
    const separatorIndex = raw.lastIndexOf('.');
    if (separatorIndex < 1) return null;
    const id = raw.slice(0, separatorIndex);
    return safeEqual(raw.slice(separatorIndex + 1), hmac(secret, `guest:${id}`)) ? id : null;
  }

  /**
   * Zet de ondertekende gastcookie (een jaar geldig).
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord.
   * @param {string} id Het id van de gastgebruiker.
   * @returns {void}
   */
  function setGuestCookie(req, res, id) {
    appendCookie(res, cookieAttrs(req, GUEST_COOKIE, `${id}.${hmac(secret, `guest:${id}`)}`, 365 * DAY_MS));
  }

  /**
   * Leest een losse ondertekende cookie voor een doel (bijv. de gekozen omgeving):
   * de waarde is leesbaar, maar niet te vervalsen.
   * @param {object} req Het Express-verzoek.
   * @param {string} name Naam van de cookie.
   * @param {string} purpose Doel; hoort bij de handtekening.
   * @returns {string|null} De waarde, of null als de cookie ontbreekt of de handtekening niet klopt.
   */
  function readSigned(req, name, purpose) {
    const raw = parseCookies(req.headers.cookie)[name];
    if (typeof raw !== 'string') return null;
    const separatorIndex = raw.lastIndexOf('.');
    if (separatorIndex < 1) return null;
    const value = raw.slice(0, separatorIndex);
    return safeEqual(raw.slice(separatorIndex + 1), hmac(secret, `${purpose}:${value}`)) ? value : null;
  }

  /**
   * Zet een ondertekende cookie (zie readSigned).
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord.
   * @param {string} name Naam van de cookie.
   * @param {string} value De waarde.
   * @param {string} purpose Doel; hoort bij de handtekening.
   * @param {{ httpOnly?: boolean }} [options] httpOnly: false alleen voor waarden die de frontend mag lezen en die niets beveiligen.
   * @returns {void}
   */
  function setSigned(req, res, name, value, purpose, options) {
    appendCookie(res, cookieAttrs(req, name, `${value}.${hmac(secret, `${purpose}:${value}`)}`, maxDays() * DAY_MS, options));
  }

  /**
   * Zet een gewone (niet ondertekende) cookie.
   * @param {object} req Het Express-verzoek.
   * @param {object} res Het Express-antwoord.
   * @param {string} name Naam van de cookie.
   * @param {string} value De waarde.
   * @param {{ httpOnly?: boolean }} [options] Cookie-opties.
   * @returns {void}
   */
  function setPlain(req, res, name, value, options) {
    appendCookie(res, cookieAttrs(req, name, value, maxDays() * DAY_MS, options));
  }

  /**
   * Wist een cookie.
   * @param {object} res Het Express-antwoord.
   * @param {string} name Naam van de cookie.
   * @returns {void}
   */
  function clearNamed(res, name) {
    appendCookie(res, `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
  }

  return { readSigned, setSigned, setPlain, clearNamed, requireAccess, isAuthenticated, isAuthenticatedForAsset, session, checkCode, setCookie, clearCookie, verify, issue, guestId, setGuestCookie, safeEqual };
}

module.exports = { createAuth, remoteIp, parseCookies, COOKIE_NAME, GUEST_COOKIE };
