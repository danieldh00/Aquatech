// WAN-IP van deze server: het openbare IPv4-adres waarmee de server naar
// buiten verbindt (dus niet het Cloudflare-adres van de website). Een
// Exchange Online-connector op IP-basis moet precies dit adres vertrouwen.
// Opzoeken bij een externe dienst, met de uitkomst een uur in het geheugen;
// WAN_IP in de omgeving gaat voor (vast adres, of als opzoeken niet mag).
const https = require('https');
const net = require('net');
const { isPublicAddress } = require('./netguard');

// Alleen IPv4: een Exchange-connector accepteert geen IPv6-adressen.
const SOURCES = ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://v4.ident.me'];
const TTL = 60 * 60 * 1000;
const MIN_REFRESH = 60 * 1000;

/** Haalt de tekst van een korte https-pagina op, via IPv4, met tijdslimiet. */
function fetchText(url, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { family: 4, timeout, headers: { 'User-Agent': 'aquatech' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 100) req.destroy(new Error('te lang')); });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('time-out')));
    req.on('error', reject);
  });
}

const validIp = (v) => net.isIPv4(v) && isPublicAddress(v);

/**
 * get({ refresh }) → { ip, source: 'omgeving'|'opgezocht', checkedAt }.
 * Gooit een fout met code 'unavailable' als geen enkele dienst antwoordt.
 */
function createWanIp({ fetch = fetchText, env = process.env, now = Date.now, sources = SOURCES } = {}) {
  let cached = null;
  let pending = null;

  async function lookup() {
    for (const url of sources) {
      try {
        const ip = String(await fetch(url)).trim();
        if (validIp(ip)) return ip;
      } catch (err) { /* volgende dienst */ }
    }
    throw Object.assign(new Error('Het WAN-IP kon niet worden bepaald.'), { code: 'unavailable' });
  }

  async function get({ refresh = false } = {}) {
    const fixed = String(env.WAN_IP || '').trim();
    if (validIp(fixed)) return { ip: fixed, source: 'omgeving', checkedAt: null };
    const age = cached ? now() - cached.at : Infinity;
    if (cached && age < (refresh ? MIN_REFRESH : TTL)) return { ip: cached.ip, source: 'opgezocht', checkedAt: new Date(cached.at).toISOString() };
    if (!pending) {
      pending = lookup()
        .then((ip) => { cached = { ip, at: now() }; return ip; })
        .finally(() => { pending = null; });
    }
    await pending;
    return { ip: cached.ip, source: 'opgezocht', checkedAt: new Date(cached.at).toISOString() };
  }

  return { get };
}

module.exports = { createWanIp, fetchText };
