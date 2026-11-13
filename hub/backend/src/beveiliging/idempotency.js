// Offline werken (frontend/sw.js): een wijziging uit de wachtrij van een
// telefoon kan twee keer aankomen, bijvoorbeeld als de verbinding wegvalt
// nadat de server het verzoek al had verwerkt. Met de kop `Idempotency-Key`
// geeft een herhaling hetzelfde antwoord terug in plaats van het opnieuw uit
// te voeren (geen dubbele foto's, uren of materiaalregels).
//
// - De sleutel geldt per gebruiker + omgeving + methode + pad; een andere
//   gebruiker met dezelfde sleutel krijgt dus nooit andermans antwoord.
// - Alleen geslaagde JSON-antwoorden (2xx) worden onthouden, 24 uur, in het
//   geheugen (begrensd in aantal en bytes). Na een herstart van de server is
//   het geheugen leeg; de wachtrij verstuurt meestal binnen seconden opnieuw.
// - Komt dezelfde sleutel binnen terwijl het eerste verzoek nog loopt: 409
//   `in_progress` (de wachtrij probeert het later opnieuw).
//
// Daarnaast `ifBaseOf(req)`: de kop `X-Aquatech-If-Base` (de updatedAt waarop
// een offline wijziging was gebaseerd). Een route die dat ondersteunt weigert
// met 409 `conflict` als het item intussen door een ander is gewijzigd.
const crypto = require('node:crypto');

const KEY = /^[A-Za-z0-9-]{8,100}$/;
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Maakt het geheugen voor herhaalde verzoeken met de kop Idempotency-Key.
 * @param {object} [options] ttlMs (bewaartijd), maxEntries (aantal), maxBytes (totale grootte), maxBody (grootste antwoord) en now (klok, voor tests).
 * @returns {{ middleware: Function, size: Function }} De middleware-fabriek en het aantal onthouden antwoorden.
 */
function createIdempotency({ ttlMs = 24 * 3600 * 1000, maxEntries = 5000, maxBytes = 32 * 1024 * 1024, maxBody = 512 * 1024, now = () => Date.now() } = {}) {
  const done = new Map(); // hash -> { at, status, body (tekst), size }
  const running = new Set();
  let bytes = 0;

  /**
   * Vergeet een onthouden antwoord.
   * @param {string} hash Sleutel van het antwoord.
   * @returns {void}
   */
  function drop(hash) {
    const entry = done.get(hash);
    if (!entry) return;
    bytes -= entry.size;
    done.delete(hash);
  }
  /**
   * Ruimt verlopen antwoorden op en houdt het geheugen binnen het maximale aantal en de maximale grootte (oudste eerst).
   * @returns {void}
   */
  function prune() {
    const currentTime = now();
    // Map houdt de volgorde van toevoegen aan: de oudste staan vooraan.
    for (const [hash, entry] of done) {
      if (currentTime - entry.at <= ttlMs && done.size <= maxEntries && bytes <= maxBytes) break;
      drop(hash);
    }
  }

  /**
   * Middleware: een herhaald schrijfverzoek met dezelfde Idempotency-Key krijgt
   * het onthouden antwoord terug in plaats van opnieuw te worden uitgevoerd.
   * @param {Function} scopeOf (req) => tekst die gebruiker + omgeving aanwijst, of null (dan geen idempotentie).
   * @returns {Function} De Express-middleware (req, res, next).
   */
  function middleware(scopeOf) {
    return (req, res, next) => {
      if (!WRITE.has(req.method)) return next();
      const raw = req.get('Idempotency-Key');
      if (!raw) return next();
      if (!KEY.test(raw)) return res.status(400).json({ error: 'invalid_idempotency_key', message: 'Ongeldige Idempotency-Key.' });
      const scope = scopeOf(req);
      if (!scope) return next();
      const hash = crypto.createHash('sha256').update(`${scope}|${req.method}|${req.baseUrl}${req.path}|${raw}`).digest('hex');
      prune();
      const hit = done.get(hash);
      if (hit) {
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(hit.status).type('json').send(hit.body);
      }
      if (running.has(hash)) return res.status(409).json({ error: 'in_progress', message: 'Dit verzoek wordt al verwerkt.' });
      running.add(hash);
      const json = res.json.bind(res);
      /**
       * Vervangt res.json: onthoudt een geslaagd antwoord (2xx) voordat het wordt verstuurd.
       * @param {*} body Het antwoord.
       * @returns {object} Het Express-antwoord.
       */
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const text = JSON.stringify(body);
          if (text !== undefined && text.length <= maxBody) {
            drop(hash);
            done.set(hash, { at: now(), status: res.statusCode, body: text, size: text.length });
            bytes += text.length;
            prune();
          }
        }
        return json(body);
      };
      /**
       * Markeert het verzoek als afgerond (ook bij een afgebroken verbinding).
       * @returns {boolean} Of het verzoek nog liep.
       */
      const finish = () => running.delete(hash);
      res.on('finish', finish);
      res.on('close', finish);
      next();
    };
  }

  return { middleware, size: () => done.size };
}

/**
 * De basis van een offline wijziging: de kop X-Aquatech-If-Base (updatedAt waarop de wijziging was gebaseerd).
 * @param {object} req Het Express-verzoek.
 * @returns {string|null} De basis, of null als de kop ontbreekt of te lang is.
 */
function ifBaseOf(req) {
  const base = req.get('X-Aquatech-If-Base');
  return base && base.length <= 64 ? base : null;
}

module.exports = { createIdempotency, ifBaseOf };
