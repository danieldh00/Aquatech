const crypto = require('crypto');

const COOKIE_NAME = 'aquatech_session';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

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

// Sessie-cookie: `<tijd>.<subject>.<vingerafdruk>.<handtekening>`. Subject is
// `code` (ingelogd met de toegangscode = beheerder) of een gebruikers-id. De
// vingerafdruk hangt aan de toegangscode resp. de wachtwoord-hash: een nieuwe
// code of een nieuw wachtwoord logt alle toestellen van die inlog uit.
// Oude cookies (`<tijd>.<vingerafdruk>.<handtekening>`, van voor de
// gebruikersaccounts) gelden nog als inlog met de toegangscode.
function createAuth({ secret, getAccessCode, getUser = () => null }) {
  const codeFingerprint = () => hmac(secret, `code:${getAccessCode()}`).slice(0, 16);
  const userFingerprint = (u) => hmac(secret, `pw:${u.password_hash || ''}`).slice(0, 16);

  function issue(subject = 'code') {
    let fp;
    if (subject === 'code') fp = codeFingerprint();
    else {
      const u = getUser(subject);
      if (!u) throw new Error('onbekende gebruiker');
      fp = userFingerprint(u);
    }
    const payload = `${Date.now()}.${subject}.${fp}`;
    return `${payload}.${hmac(secret, payload)}`;
  }

  // Geeft { subject: 'code' } of { subject: 'user', user } terug, of null.
  function verifySession(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length === 3) parts.splice(1, 0, 'code');
    if (parts.length !== 4) return null;
    const [issuedAt, subject, fingerprint, signature] = parts;
    const payload = token.split('.').length === 3 ? `${issuedAt}.${fingerprint}` : `${issuedAt}.${subject}.${fingerprint}`;
    if (!safeEqual(signature, hmac(secret, payload))) return null;
    const age = Date.now() - Number(issuedAt);
    if (!(Number.isFinite(age) && age >= 0 && age < COOKIE_MAX_AGE_MS)) return null;
    if (subject === 'code') {
      if (!getAccessCode() || !safeEqual(fingerprint, codeFingerprint())) return null;
      return { subject: 'code' };
    }
    const user = getUser(subject);
    if (!user || user.disabled || user.kind !== 'account' || !safeEqual(fingerprint, userFingerprint(user))) return null;
    return { subject: 'user', user };
  }

  const verify = (token) => Boolean(verifySession(token));

  function checkCode(code) {
    const expected = getAccessCode();
    if (!expected) return false;
    // Vergelijk hashes, zodat de looptijd niets over de lengte verraadt.
    return safeEqual(hmac(secret, `try:${code}`), hmac(secret, `try:${expected}`));
  }

  // { via: 'code' | 'user', user? } of null.
  function session(req) {
    const s = verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
    if (!s) return null;
    return s.subject === 'code' ? { via: 'code' } : { via: 'user', user: s.user };
  }

  function isAuthenticated(req) {
    return Boolean(session(req));
  }

  function requireAccess(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in met de toegangscode.' });
  }

  function cookieAttrs(req, name, value, { httpOnly = true } = {}) {
    // 'Secure' alleen als het verzoek via https binnenkwam (de tunnel zet
    // X-Forwarded-Proto); lokaal testen via http://ip:3300 moet ook werken.
    const attrs = [
      `${name}=${encodeURIComponent(value)}`,
      'Path=/',
      `Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`,
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

  function setCookie(req, res, subject = 'code') {
    appendCookie(res, cookieAttrs(req, COOKIE_NAME, issue(subject)));
  }

  function clearCookie(res) {
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
    appendCookie(res, cookieAttrs(req, GUEST_COOKIE, `${id}.${hmac(secret, `guest:${id}`)}`));
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
    appendCookie(res, cookieAttrs(req, name, `${value}.${hmac(secret, `${purpose}:${value}`)}`, opts));
  }

  function setPlain(req, res, name, value, opts) {
    appendCookie(res, cookieAttrs(req, name, value, opts));
  }

  function clearNamed(res, name) {
    appendCookie(res, `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
  }

  return { readSigned, setSigned, setPlain, clearNamed, requireAccess, isAuthenticated, session, checkCode, setCookie, clearCookie, verify, issue, guestId, setGuestCookie };
}

module.exports = { createAuth, remoteIp, parseCookies, COOKIE_NAME, GUEST_COOKIE };
