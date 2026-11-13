// Excel-rapporten van de AI-koppeling: de AI-app krijgt alleen tekst terug, dus een rapport wacht even in het geheugen van de server
// en de gebruiker haalt hem op via een link terwijl hij in AquaTech is ingelogd.
// - Het bestand hoort bij één gebruiker in één omgeving; een ander account of een andere omgeving krijgt 404.
// - Het wacht 15 minuten en verdwijnt bij een herstart (er staat niets op schijf of in de database).
// - Het token (32 willekeurige bytes) staat alleen in de link; de link zonder inlog geeft niets.
const crypto = require('crypto');

/** Hoelang een rapport klaarstaat. */
const TTL_MS = 15 * 60 * 1000;
/** Hoeveel rapporten één gebruiker tegelijk klaar heeft staan. */
const MAX_PER_USER = 10;
/** Hoeveel bytes één rapport hoogstens is. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Hoeveel bytes de rapporten van één gebruiker samen hoogstens innemen (één gebruiker vult de gedeelde ruimte nooit). */
const MAX_USER_BYTES = 10 * 1024 * 1024;
/** Hoeveel bytes alle rapporten samen hoogstens innemen. */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/** De inhoudstype van een .xlsx-bestand. */
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Maakt een bestandsnaam veilig voor de download.
 * @param {string} name De gewenste naam.
 * @returns {string} De naam met alleen letters, cijfers en - _ . (eindigt op .xlsx).
 */
function safeFileName(name) {
  const base = String(name || 'rapport').replace(/\.xlsx$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'rapport';
  return `${base}.xlsx`;
}

/**
 * De opslag van klaarstaande rapporten.
 * @param {{ now?: Function, ttlMs?: number }} [options] Tijdbron en levensduur (voor tests).
 * @returns {{ put: Function, get: Function, size: Function }} De opslag.
 */
function createDownloadStore({ now = () => Date.now(), ttlMs = TTL_MS } = {}) {
  /** @type {Map<string, { tenantId: string, userId: string, fileName: string, buffer: Buffer, expiresAt: number }>} */
  const entries = new Map();

  /**
   * Ruimt verlopen rapporten op.
   * @returns {void}
   */
  function sweep() {
    const current = now();
    for (const [token, entry] of entries) if (entry.expiresAt <= current) entries.delete(token);
  }

  /**
   * Totaal aantal bytes dat nu klaarstaat.
   * @returns {number} Bytes.
   */
  const totalBytes = () => { let sum = 0; for (const entry of entries.values()) sum += entry.buffer.length; return sum; };

  /**
   * Zet een rapport klaar; de oudste van deze gebruiker gaat weg als er te veel zijn.
   * @param {string} tenantId De omgeving.
   * @param {string} userId De gebruiker.
   * @param {string} fileName De bestandsnaam.
   * @param {Buffer} buffer Het bestand.
   * @returns {{ token: string, expiresAt: number, fileName: string }|null} Het token, of null als er geen ruimte is.
   */
  function put(tenantId, userId, fileName, buffer) {
    sweep();
    if (buffer.length > MAX_FILE_BYTES) return null;
    const own = [...entries.entries()].filter(([, entry]) => entry.tenantId === tenantId && entry.userId === userId);
    let ownBytes = own.reduce((sum, [, entry]) => sum + entry.buffer.length, 0);
    while (own.length && (own.length >= MAX_PER_USER || ownBytes + buffer.length > MAX_USER_BYTES)) {
      const [oldToken, oldEntry] = own.shift();
      ownBytes -= oldEntry.buffer.length;
      entries.delete(oldToken);
    }
    if (totalBytes() + buffer.length > MAX_TOTAL_BYTES) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const entry = { tenantId, userId, fileName: safeFileName(fileName), buffer, expiresAt: now() + ttlMs };
    entries.set(token, entry);
    return { token, expiresAt: entry.expiresAt, fileName: entry.fileName };
  }

  /**
   * Haalt een rapport op, alleen voor de gebruiker en omgeving waarvoor het is gemaakt.
   * @param {string} token Het token uit de link.
   * @param {string} tenantId De omgeving van de aanvrager.
   * @param {string} userId De gebruiker.
   * @returns {{ fileName: string, buffer: Buffer }|null} Het rapport, of null.
   */
  function get(token, tenantId, userId) {
    sweep();
    const entry = entries.get(String(token));
    if (!entry || entry.tenantId !== tenantId || entry.userId !== userId) return null;
    return { fileName: entry.fileName, buffer: entry.buffer };
  }

  return { put, get, size: () => entries.size };
}

/**
 * Registreert de downloadroute voor klaargezette rapporten (alleen voor ingelogde gebruikers).
 * @param {object} app De Express-app.
 * @param {{ downloads: object, requireUser: Function, audit: Function }} ctx De opslag, de inlogcontrole en het auditlog.
 * @returns {void}
 */
function registerDownloadRoute(app, ctx) {
  app.get('/api/mcp-download/:token', ctx.requireUser, (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const found = ctx.downloads.get(req.params.token, req.tenantId, req.user.id);
    if (!found) return res.status(404).json({ error: 'not_found', message: 'Dit rapport staat niet meer klaar. Vraag het opnieuw aan via de AI-koppeling.' });
    ctx.audit(req, 'rapport_gedownload', { bestand: found.fileName });
    res.set({ 'Content-Type': XLSX_TYPE, 'Content-Disposition': `attachment; filename="${found.fileName}"`, 'X-Content-Type-Options': 'nosniff' });
    return res.send(found.buffer);
  });
}

module.exports = { createDownloadStore, registerDownloadRoute, safeFileName, XLSX_TYPE, TTL_MS };
