const crypto = require('crypto');
const { fingerprintOf } = require('./store');

const COOKIE_NAME = 'aquatech_session';

function remoteIp(req) {
  const raw = req.socket?.remoteAddress || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const GUEST_COOKIE = 'aquatech_guest';
const DAY_MS = 24 * 60 * 60 * 1000;

// Sessies staan op de server (tabel sessions, zie store.js): de cookie bevat
// alleen een willekeurig token. Uitloggen, een nieuw wachtwoord, uitschakelen
// of een nieuwe toegangscode beëindigt een sessie dus meteen. Een sessie
// verloopt na `idleDays()` zonder gebruik en hoe dan ook na `maxDays()`.
function createAuth({ secret, store, tenantId, getAccessCode, idleDays = () => 14, maxDays = () => 30 }) {
  const codeFingerprint = () => hmac(secret, `code:${getAccessCode()}`).slice(0, 22);
  const userFingerprint = (u) => fingerprintOf(u.password_hash);

  // Maakt een sessie aan; geeft het token voor de cookie terug.
  function issue(subject = 'code', req = null) {
    let userId, fingerprint;
    if (subject === 'code') {
      userId = store.systemUser(tenantId, 'beheerder', 'Beheerder (toegangscode)').id;
      fingerprint = codeFingerprint();
    } else {
      const u = store.getUser(subject);
      if (!u) throw new Error('onbekende gebruiker');
      userId = u.id;
      fingerprint = userFingerprint(u);
    }
    // Een account-sessie hoort bij de eigen tenant van het account (multitenant).
    const sessionTenant = subject === 'code' ? tenantId : store.getUser(userId).tenant_id;
    return store.createSession({
      tenantId: sessionTenant, userId, via: subject === 'code' ? 'code' : 'user', fingerprint, maxMs: maxDays() * DAY_MS,
      ip: req ? remoteIp(req) : '', userAgent: req?.headers?.['user-agent'] || '',
    });
  }

  // Geeft { subject: 'code', row } of { subject: 'user', user, row } terug, of null.
  function verifySession(token) {
    // Sessie, gebruiker en tenant in één query (dit gebeurt bij elk verzoek).
    const found = store.findSessionWithUser(token);
    if (!found) return null;
    const { row } = found;
    // Toegangscode: alleen de hoofdtenant; een account: alleen de eigen tenant.
    if (row.via === 'code' && row.tenant_id !== tenantId) return null;
    const t = Date.now();
    const expired = Date.parse(row.expires_at) <= t
      || Date.parse(row.created_at) + maxDays() * DAY_MS <= t
      || Date.parse(row.last_seen_at) + idleDays() * DAY_MS <= t;
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

  const verify = (token) => Boolean(verifySession(token));

  function checkCode(code) {
    const expected = getAccessCode();
    if (!expected) return false;
    // Vergelijk hashes, zodat de looptijd niets over de lengte verraadt.
    return safeEqual(hmac(secret, `try:${code}`), hmac(secret, `try:${expected}`));
  }

  // Eén keer per verzoek uitrekenen.
  function session(req) {
    if (req._session !== undefined) return req._session;
    const s = verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
    req._session = !s ? null : s.subject === 'code' ? { via: 'code', row: s.row } : { via: 'user', user: s.user, row: s.row };
    return req._session;
  }

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
  const assetKey = (token) => crypto.createHash('sha256').update(`asset:${token}`).digest('base64url');
  function isAuthenticatedForAsset(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return isAuthenticated(req);
    const key = assetKey(token);
    if ((assetSessions.get(key) || 0) > Date.now()) return true;
    const ok = isAuthenticated(req);
    if (ok) {
      if (assetSessions.size > 5000) {
        for (const [k, until] of assetSessions) if (until <= Date.now()) assetSessions.delete(k);
        if (assetSessions.size > 5000) assetSessions.clear();
      }
      assetSessions.set(key, Date.now() + ASSET_TTL_MS);
    } else assetSessions.delete(key);
    return ok;
  }

  function requireAccess(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
  }

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

  function appendCookie(res, cookie) {
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), cookie]);
  }

  // Nieuwe sessie bij elke inlog (een eventuele oude sessie in dit toestel
  // vervalt: geen sessie-fixatie).
  function setCookie(req, res, subject = 'code') {
    const old = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (old) { store.deleteSession(old); assetSessions.delete(assetKey(old)); }
    req._session = undefined;
    appendCookie(res, cookieAttrs(req, COOKIE_NAME, issue(subject, req), maxDays() * DAY_MS));
  }

  // Uitloggen: de sessie verdwijnt ook op de server.
  function clearCookie(req, res) {
    const old = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (old) { store.deleteSession(old); assetSessions.delete(assetKey(old)); }
    appendCookie(res, `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  }

  // Gasten (openbare planner zonder toegangscode) krijgen per browser een
  // eigen anonieme gebruiker, zodat ze alleen hun eigen plannen zien.
  function guestId(req) {
    const raw = parseCookies(req.headers.cookie)[GUEST_COOKIE];
    if (typeof raw !== 'string') return null;
    const idx = raw.lastIndexOf('.');
    if (idx < 1) return null;
    const id = raw.slice(0, idx);
    return safeEqual(raw.slice(idx + 1), hmac(secret, `guest:${id}`)) ? id : null;
  }

  function setGuestCookie(req, res, id) {
    appendCookie(res, cookieAttrs(req, GUEST_COOKIE, `${id}.${hmac(secret, `guest:${id}`)}`, 365 * DAY_MS));
  }

  // Losse ondertekende cookie voor een doel (bijv. de gekozen omgeving): de
  // waarde is leesbaar, maar niet te vervalsen. httpOnly: false alleen voor
  // waarden die de frontend mag lezen en die niets beveiligen.
  function readSigned(req, name, purpose) {
    const raw = parseCookies(req.headers.cookie)[name];
    if (typeof raw !== 'string') return null;
    const idx = raw.lastIndexOf('.');
    if (idx < 1) return null;
    const value = raw.slice(0, idx);
    return safeEqual(raw.slice(idx + 1), hmac(secret, `${purpose}:${value}`)) ? value : null;
  }

  function setSigned(req, res, name, value, purpose, opts) {
    appendCookie(res, cookieAttrs(req, name, `${value}.${hmac(secret, `${purpose}:${value}`)}`, maxDays() * DAY_MS, opts));
  }

  function setPlain(req, res, name, value, opts) {
    appendCookie(res, cookieAttrs(req, name, value, maxDays() * DAY_MS, opts));
  }

  function clearNamed(res, name) {
    appendCookie(res, `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
  }

  return { readSigned, setSigned, setPlain, clearNamed, requireAccess, isAuthenticated, isAuthenticatedForAsset, session, checkCode, setCookie, clearCookie, verify, issue, guestId, setGuestCookie, safeEqual };
}

module.exports = { createAuth, remoteIp, parseCookies, COOKIE_NAME, GUEST_COOKIE };
