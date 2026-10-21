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

function createIdempotency({ ttlMs = 24 * 3600 * 1000, maxEntries = 5000, maxBytes = 32 * 1024 * 1024, maxBody = 512 * 1024, now = () => Date.now() } = {}) {
  const done = new Map(); // hash -> { at, status, body (tekst), size }
  const running = new Set();
  let bytes = 0;

  function drop(hash) {
    const e = done.get(hash);
    if (!e) return;
    bytes -= e.size;
    done.delete(hash);
  }
  function prune() {
    const t = now();
    // Map houdt de volgorde van toevoegen aan: de oudste staan vooraan.
    for (const [hash, e] of done) {
      if (t - e.at <= ttlMs && done.size <= maxEntries && bytes <= maxBytes) break;
      drop(hash);
    }
  }

  /** scopeOf(req) -> tekst die de gebruiker + omgeving aanwijst, of null (dan geen idempotentie). */
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
      const finish = () => running.delete(hash);
      res.on('finish', finish);
      res.on('close', finish);
      next();
    };
  }

  return { middleware, size: () => done.size };
}

/** De basis van een offline wijziging (X-Aquatech-If-Base), of null. */
function ifBaseOf(req) {
  const v = req.get('X-Aquatech-If-Base');
  return v && v.length <= 64 ? v : null;
}

module.exports = { createIdempotency, ifBaseOf };
