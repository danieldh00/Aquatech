// Uitgaande HTTP(S)-verzoeken naar een adres dat netguard.js al heeft
// goedgekeurd. De gewone fetch zoekt de naam bij het verbinden opnieuw op; een
// DNS-antwoord dat intussen naar het eigen netwerk wijst (DNS-rebinding) komt
// dan toch binnen. Hier gaat de verbinding naar precies het goedgekeurde
// IP-adres, terwijl de hostnaam blijft gelden voor het certificaat (SNI) en
// de Host-kop. Ook leest readLimited een antwoord met een grens op het aantal
// bytes ná het uitpakken, zodat een klein gecomprimeerd antwoord niet
// ongemerkt heel groot wordt.
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const { Readable, pipeline } = require('stream');

class ResponseTooLargeError extends Error {
  /**
   * Fout als een antwoord groter is dan toegestaan (code 'too_large').
   * @param {number} maxBytes De grens in bytes.
   */
  constructor(maxBytes) {
    super(`Antwoord groter dan ${maxBytes} bytes.`);
    this.code = 'too_large';
  }
}

/**
 * Pakt een antwoord uit volgens Content-Encoding (gzip, deflate of br).
 * @param {object} message Het binnenkomende antwoord (http.IncomingMessage).
 * @returns {object} Een leesbare stroom met de uitgepakte inhoud.
 */
function decoded(message) {
  const encoding = String(message.headers['content-encoding'] || '').trim().toLowerCase();
  let decoder = null;
  if (encoding === 'gzip' || encoding === 'x-gzip') decoder = zlib.createGunzip();
  else if (encoding === 'deflate') decoder = zlib.createInflate();
  else if (encoding === 'br') decoder = zlib.createBrotliDecompress();
  if (!decoder) return message;
  // pipeline geeft fouten en afbreken in beide richtingen door (pipe niet).
  pipeline(message, decoder, () => {});
  return decoder;
}

/**
 * Een fetch die verbindt met een vast IP-adres. Volgt geen omleidingen (een
 * 3xx geeft een fout, net als fetch met redirect: 'error').
 * @param {string} address Het goedgekeurde IP-adres.
 * @returns {Function} fetch(url, { method, headers, body, signal }) → Promise<Response>.
 */
function pinnedFetch(address) {
  const family = net.isIP(address);
  if (!family) throw new Error('Geen geldig IP-adres.');
  /**
   * Doet het verzoek naar het vaste adres.
   * @param {string} url Het adres (met hostnaam).
   * @param {{ method?: string, headers?: object, body?: string, signal?: AbortSignal }} [init] Methode, koppen, body en afbreeksignaal.
   * @returns {Promise<Response>} Het antwoord (inhoud als stroom).
   */
  return function fetchPinned(url, { method = 'GET', headers = {}, body, signal } = {}) {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = client.request(target, {
        method, signal,
        headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers },
        // De naam niet opnieuw opzoeken: altijd het goedgekeurde adres.
        lookup: (hostname, options, callback) => {
          if (options && options.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
      }, (message) => {
        if (message.statusCode >= 300 && message.statusCode < 400) {
          message.resume();
          reject(new TypeError('Omleiding geweigerd.'));
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(message.headers)) {
          if (name === 'content-encoding' || name === 'content-length') continue;
          responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
        }
        const status = message.statusCode >= 200 && message.statusCode <= 599 ? message.statusCode : 502;
        const stream = Readable.toWeb(decoded(message));
        resolve(new Response(status === 204 || status === 205 || status === 304 ? null : stream, { status, headers: responseHeaders }));
      });
      request.on('error', reject);
      if (body !== undefined && body !== null) request.write(body);
      request.end();
    });
  };
}

/**
 * Leest de inhoud van een antwoord als tekst, met een grens op het aantal
 * bytes (na uitpakken). Bij te veel wordt het lezen meteen afgebroken.
 * @param {Response|object} response Het antwoord (een Response, of iets met text()).
 * @param {number} maxBytes De grens in bytes.
 * @returns {Promise<string>} De tekst.
 * @throws {ResponseTooLargeError} Als het antwoord groter is dan maxBytes.
 */
async function readLimited(response, maxBytes) {
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new ResponseTooLargeError(maxBytes);
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = { pinnedFetch, readLimited, ResponseTooLargeError };
