// WAN-IP van deze server: het openbare IPv4-adres waarmee de server naar
// buiten verbindt (dus niet het Cloudflare-adres van de website). Een
// Exchange Online-connector op IP-basis moet precies dit adres vertrouwen.
// Opzoeken bij een externe dienst, met de uitkomst een uur in het geheugen;
// WAN_IP in de omgeving gaat voor (vast adres, of als opzoeken niet mag).
const https = require('https');
const net = require('net');
const { isPublicAddress } = require('../beveiliging/netguard');

// Alleen IPv4: een Exchange-connector accepteert geen IPv6-adressen.
const SOURCES = ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://v4.ident.me'];
const TTL = 60 * 60 * 1000;
const MIN_REFRESH = 60 * 1000;

/**
 * Haalt de tekst van een korte https-pagina op, via IPv4, met tijdslimiet.
 * @param {string} url Adres van de pagina.
 * @param {{ timeout?: number }} [options] Tijdslimiet in ms.
 * @returns {Promise<string>} De inhoud (hoogstens ruim 100 tekens).
 */
function fetchText(url, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { family: 4, timeout, headers: { 'User-Agent': 'aquatech' } }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; if (body.length > 100) request.destroy(new Error('te lang')); });
      response.on('end', () => resolve(body));
    });
    request.on('timeout', () => request.destroy(new Error('time-out')));
    request.on('error', reject);
  });
}

/**
 * Of een waarde een openbaar IPv4-adres is.
 * @param {string} value De waarde.
 * @returns {boolean} true bij een openbaar IPv4-adres.
 */
const validIp = (value) => net.isIPv4(value) && isPublicAddress(value);

/**
 * Maakt de opzoeker van het WAN-IP: WAN_IP uit de omgeving gaat voor, anders
 * een externe dienst, met de uitkomst een uur in het geheugen.
 * @param {object} [options] fetch, env, now en sources (te vervangen in tests).
 * @returns {{ get: Function }} get({ refresh }) → { ip, source: 'omgeving'|'opgezocht', checkedAt }.
 */
function createWanIp({ fetch = fetchText, env = process.env, now = Date.now, sources = SOURCES } = {}) {
  let cached = null;
  let pending = null;

  /**
   * Vraagt de diensten één voor één om het IPv4-adres.
   * @returns {Promise<string>} Het eerste geldige openbare adres.
   * @throws {Error} Met code 'unavailable' als geen enkele dienst antwoordt.
   */
  async function lookup() {
    for (const url of sources) {
      try {
        const ip = String(await fetch(url)).trim();
        if (validIp(ip)) return ip;
      } catch (err) { /* volgende dienst */ }
    }
    throw Object.assign(new Error('Het WAN-IP kon niet worden bepaald.'), { code: 'unavailable' });
  }

  /**
   * Het WAN-IP: uit de omgeving, uit het geheugen (een uur), of opnieuw opgezocht.
   * Met refresh wordt opnieuw opgezocht, maar hoogstens eens per minuut.
   * @param {{ refresh?: boolean }} [options] Opnieuw opzoeken.
   * @returns {Promise<{ ip: string, source: string, checkedAt: string|null }>} Het adres, de bron en wanneer het is opgezocht.
   */
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
