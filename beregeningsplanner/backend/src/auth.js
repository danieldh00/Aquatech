const crypto = require('crypto');

const COOKIE_NAME = 'aquatech_session';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// Vast IP van de Supervisor op het interne hassio-netwerk. De ingress-proxy
// verbindt altijd vanaf dit adres; verkeer via de Cloudflare-tunnel komt van
// de Cloudflared-add-on (een ander 172.30.33.x-adres) en een client kan het
// TCP-bronadres niet vervalsen. Alleen de combinatie header + IP telt dus als
// ingress -- de header alleen is door iedereen mee te sturen.
const SUPERVISOR_IPS = new Set(['172.30.32.2']);

function remoteIp(req) {
  const raw = req.socket?.remoteAddress || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function isIngress(req) {
  return Boolean(req.headers['x-ingress-path']) && SUPERVISOR_IPS.has(remoteIp(req));
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

function createAuth({ secret, getAccessCode }) {
  // De toegangscode zit in de handtekening: wijzig je de code in de
  // add-on-opties, dan zijn alle eerder gekoppelde toestellen meteen uitgelogd.
  const codeFingerprint = () => hmac(secret, `code:${getAccessCode()}`).slice(0, 16);

  function issue() {
    const payload = `${Date.now()}.${codeFingerprint()}`;
    return `${payload}.${hmac(secret, payload)}`;
  }

  function verify(token) {
    if (!getAccessCode() || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [issuedAt, fingerprint, signature] = parts;
    if (!safeEqual(signature, hmac(secret, `${issuedAt}.${fingerprint}`))) return false;
    if (!safeEqual(fingerprint, codeFingerprint())) return false;
    const age = Date.now() - Number(issuedAt);
    return Number.isFinite(age) && age >= 0 && age < COOKIE_MAX_AGE_MS;
  }

  function checkCode(code) {
    const expected = getAccessCode();
    if (!expected) return false;
    // Vergelijk hashes, zodat de looptijd niets over de lengte verraadt.
    return safeEqual(hmac(secret, `try:${code}`), hmac(secret, `try:${expected}`));
  }

  function isAuthenticated(req) {
    if (isIngress(req)) return true;
    return verify(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  }

  function requireAccess(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in met de toegangscode.' });
  }

  function setCookie(req, res) {
    // 'Secure' alleen als het verzoek via https binnenkwam (de tunnel zet
    // X-Forwarded-Proto); lokaal testen via http://ip:3300 moet ook werken.
    const secure = req.headers['x-forwarded-proto'] === 'https';
    const attrs = [
      `${COOKIE_NAME}=${encodeURIComponent(issue())}`,
      'Path=/',
      `Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`,
      'HttpOnly',
      'SameSite=Lax',
    ];
    if (secure) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
  }

  function clearCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  }

  return { requireAccess, isAuthenticated, checkCode, setCookie, clearCookie, verify, issue };
}

module.exports = { createAuth, isIngress, remoteIp, parseCookies, COOKIE_NAME };
