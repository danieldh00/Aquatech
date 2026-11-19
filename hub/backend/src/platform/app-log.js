// Centraal applicatielogboek (tabel app_logs): één plek voor fouten, trage verzoeken, stilstand, mislukte taken en
// bewakingsincidenten, met een request-id waarmee alles van één verzoek terug te vinden is.
//
// - Schrijven gebeurt gebufferd (elke 2 s of bij 50 regels) en nooit in het verzoekpad; een databasefout breekt nooit
//   een verzoek: de regels gaan dan alleen naar de console.
// - Begrenzing: identieke regels in de buffer worden één regel met een teller, per bron hoogstens 600 regels per minuut
//   en per omgeving een harde bovengrens aan het aantal rijen (trim, oudste eerst weg).
// - Privacy: elke tekst gaat door `redact` (geheimen) en daarna door de e-mail- en IBAN-filter; sleutels als password,
//   token, cookie of authorization krijgen nooit hun waarde mee; nooit lichamen, koppen of querystrings.
// - Platformregels (geen omgeving, bijvoorbeeld stilstand van de server) staan onder de hoofdtenant met scope 'platform'.
const crypto = require('crypto');
const { redact } = require('./error-report');
const { asSystem } = require('../database/tenant-scope');
const { transaction } = require('../database/db');

const LEVELS = ['info', 'warn', 'error'];
const MAX_MESSAGE = 500;
const MAX_DATA = 2000;
const MAX_STACK = 1200;
const MAX_ROWS_PER_TENANT = 100000;
const SENSITIVE_KEY = /pass|wachtwoord|token|secret|authorization|cookie|api[_-]?key|iban|email|e-mail/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;

/**
 * Haalt geheimen, e-mailadressen en IBAN's uit een tekst en kort hem in.
 * @param {*} value De tekst (andere waarden worden tekst).
 * @param {number} [maxLength] Maximale lengte.
 * @returns {string} De schone tekst.
 */
function cleanText(value, maxLength = MAX_MESSAGE) {
  return redact(value, maxLength * 2).replace(EMAIL, '***@***').replace(IBAN, 'IBAN-***').slice(0, maxLength);
}

/**
 * Maakt een object veilig voor het logboek: tekstwaarden gaan door cleanText, gevoelige sleutels krijgen '***', diepte en
 * lengte zijn begrensd.
 * @param {*} value De waarde.
 * @param {number} [depth] Resterende diepte.
 * @param {number} [maxText] Maximale lengte van een tekstwaarde (een stacktrace onder de sleutel `stack` mag MAX_STACK tekens).
 * @returns {*} De schone kopie.
 */
function cleanData(value, depth = 3, maxText = 300) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return cleanText(value, maxText);
  if (depth <= 0) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => cleanData(item, depth - 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) out[key] = SENSITIVE_KEY.test(key) ? '***' : cleanData(item, depth - 1, key === 'stack' ? MAX_STACK : maxText);
    return out;
  }
  return cleanText(String(value), 100);
}

/**
 * Leest het JSON-veld `data` van een regel (een kapotte waarde wordt een leeg object).
 * @param {string} text De JSON-tekst.
 * @returns {object} De gegevens.
 */
function parseData(text) {
  try { return JSON.parse(text) || {}; } catch { return {}; }
}

/**
 * Maakt het logboek.
 * @param {object} options Opties.
 * @param {object} options.db De database (db.prepare).
 * @param {string} options.mainTenantId De hoofdtenant (eigenaar van platformregels).
 * @param {number} [options.flushMs] Hoe vaak de buffer naar de database gaat (standaard 2000; 0 = alleen met flush()).
 * @param {number} [options.batchSize] Bij zoveel regels in de buffer volgt een wegschrijfbeurt (na het huidige verzoek, nooit midden erin).
 * @param {number} [options.perMinuteLimit] Hoogstens zoveel regels per bron per minuut.
 * @param {Function} [options.now] Klok in ms.
 * @param {Function} [options.write] Terugval als de database faalt (standaard console.error).
 * @returns {object} `middleware`, `log`, `info`, `warn`, `error`, `flush`, `prune`, `stop`, `pending`.
 */
function createAppLog({ db, mainTenantId, flushMs = 2000, batchSize = 50, perMinuteLimit = 600, now = Date.now, write = (line) => console.error(line) }) {
  let buffer = [];
  const bySource = new Map();
  let timer = null;
  let flushScheduled = false;

  /**
   * Express-middleware: geeft elk verzoek een request-id (req.requestId en kop X-Request-Id). Een id van buiten wordt nooit overgenomen.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next Volgende afhandeling.
   * @returns {void}
   */
  function middleware(req, res, next) {
    req.requestId = crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', req.requestId);
    next();
  }

  /**
   * Of deze bron in deze omgeving de grens per minuut al haalt (en telt mee). Fouten hebben een dubbele grens en tellen apart.
   * @param {string} owner De omgeving.
   * @param {string} source De bron.
   * @param {string} level Het niveau.
   * @returns {boolean} true als de regel weggelaten moet worden.
   */
  function limited(owner, source, level) {
    const minute = Math.floor(now() / 60000);
    const key = `${owner}|${source}|${level === 'error' ? 'error' : 'overig'}`;
    const state = bySource.get(key);
    if (!state || state.minute !== minute) {
      bySource.set(key, { minute, count: 1 });
      if (bySource.size > 2000) for (const [oldKey, oldState] of bySource) if (oldState.minute !== minute) bySource.delete(oldKey);
      return false;
    }
    state.count += 1;
    return state.count > (level === 'error' ? perMinuteLimit * 2 : perMinuteLimit);
  }

  /**
   * Legt een regel vast (gebufferd).
   * @param {'info'|'warn'|'error'} level Niveau.
   * @param {string} source Bron, bijv. 'fout', 'traag', 'stilstand', 'taak', 'bewaking'.
   * @param {string} message Korte melding (wordt geschoond en op 500 tekens afgekapt).
   * @param {{ tenantId?: string|null, requestId?: string, errorCode?: string, durationMs?: number, data?: object }} [details] tenantId leeg = platformregel.
   * @returns {void}
   */
  function log(level, source, message, { tenantId = null, requestId = '', errorCode = '', durationMs = 0, data = null } = {}) {
    try {
      const cleanLevel = LEVELS.includes(level) ? level : 'info';
      const cleanSource = String(source || 'app').slice(0, 40);
      const owner = tenantId || mainTenantId;
      if (limited(owner, cleanSource, cleanLevel)) return;
      const text = cleanText(message);
      const scope = tenantId ? 'tenant' : 'platform';
      const key = `${owner}|${cleanSource}|${cleanLevel}|${errorCode}|${text}`;
      const same = buffer.find((row) => row.key === key);
      if (same) { same.repeat += 1; return; }
      let json = data ? JSON.stringify(cleanData(data)) : '{}';
      if (json.length > MAX_DATA) json = JSON.stringify({ afgekapt: true });
      buffer.push({
        key, id: crypto.randomUUID(), owner, scope, at: new Date(now()).toISOString(), level: cleanLevel, source: cleanSource,
        requestId: String(requestId || '').slice(0, 32), errorCode: String(errorCode || '').slice(0, 32), message: text,
        data: json, durationMs: Math.max(0, Math.round(Number(durationMs) || 0)), repeat: 1,
      });
      if (buffer.length >= batchSize && !flushScheduled) {
        flushScheduled = true;
        setImmediate(() => { flushScheduled = false; flush(); });
      }
    } catch { /* logging mag nooit een verzoek of taak breken */ }
  }

  /**
   * Schrijft de buffer naar de database, in één transactie. Een regel die niet kan (bijvoorbeeld een onbekende omgeving)
   * wordt overgeslagen; faalt de hele database, dan gaan de regels naar de console.
   * @returns {number} Aantal weggeschreven regels.
   */
  function flush() {
    if (!buffer.length) return 0;
    const rows = buffer;
    buffer = [];
    const insertSql = `INSERT INTO app_logs (id, tenant_id, scope, created_at, level, source, request_id, error_code, message, data, duration_ms, repeat_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    /**
     * Schrijft één regel.
     * @param {object} row De regel uit de buffer.
     * @returns {void}
     */
    const insertRow = (row) => db.prepare(insertSql).run(row.id, row.owner, row.scope, row.at, row.level, row.source, row.requestId, row.errorCode, row.message, row.data, row.durationMs, row.repeat);
    try {
      return asSystem(() => {
        try {
          transaction(db, () => { for (const row of rows) insertRow(row); });
          return rows.length;
        } catch {
          // Eén onbruikbare regel (bijvoorbeeld een onbekende omgeving) mag de rest niet meenemen: regel voor regel opnieuw.
          let written = 0;
          for (const row of rows) {
            try { insertRow(row); written += 1; } catch { /* overslaan */ }
          }
          if (!written) throw new Error('niets weggeschreven');
          return written;
        }
      });
    } catch {
      for (const row of rows) write(`[logboek] ${row.at} ${row.level} ${row.source} ${row.message}`);
      return 0;
    }
  }

  if (flushMs > 0) {
    timer = setInterval(flush, flushMs);
    timer.unref();
  }

  /**
   * Bewaartermijn: verwijdert regels van een omgeving ouder dan `days` dagen (fouten pas na `errorDays`) en houdt hoogstens
   * MAX_ROWS_PER_TENANT regels over (oudste eerst weg).
   * @param {string} tenantId De omgeving.
   * @param {number} days Bewaartermijn voor info en waarschuwingen.
   * @param {number} errorDays Bewaartermijn voor fouten.
   * @returns {number} Aantal verwijderde regels.
   */
  function prune(tenantId, days, errorDays) {
    const before = new Date(now() - days * 86400000).toISOString();
    const errorBefore = new Date(now() - Math.max(days, errorDays) * 86400000).toISOString();
    let removed = db.prepare(`DELETE FROM app_logs WHERE tenant_id = ? AND level <> 'error' AND created_at < ?`).run(tenantId, before).changes;
    removed += db.prepare(`DELETE FROM app_logs WHERE tenant_id = ? AND level = 'error' AND created_at < ?`).run(tenantId, errorBefore).changes;
    const edge = db.prepare('SELECT created_at FROM app_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET ?').get(tenantId, MAX_ROWS_PER_TENANT);
    if (edge) removed += db.prepare('DELETE FROM app_logs WHERE tenant_id = ? AND created_at <= ?').run(tenantId, edge.created_at).changes;
    return removed;
  }

  /**
   * Zoekt regels van één omgeving, nieuwste eerst, met een cursor voor de volgende pagina.
   * @param {string} tenantId De omgeving (altijd verplicht; elke query filtert erop).
   * @param {{ levels?: string[], source?: string, search?: string, from?: string, to?: string, before?: string, includePlatform?: boolean, limit?: number }} [filter]
   *   levels: toegestane niveaus (leeg = alle); search: tekst in de melding of precies een request-id/foutcode; from/to: ISO-tijdstippen;
   *   before: cursor `<tijdstip>|<id>` van de laatste regel van de vorige pagina; includePlatform: ook platformregels.
   * @returns {{ items: object[], next: string|null }} De regels en de cursor (null = geen volgende pagina).
   */
  function list(tenantId, { levels = [], source = '', search = '', from = '', to = '', before = '', includePlatform = false, limit = 50 } = {}) {
    const pageSize = Math.min(Math.max(Math.floor(Number(limit)) || 50, 1), 500);
    const where = ['tenant_id = ?'];
    const args = [tenantId];
    if (!includePlatform) where.push("scope = 'tenant'");
    const wanted = levels.filter((level) => LEVELS.includes(level));
    if (wanted.length) { where.push(`level IN (${wanted.map(() => '?').join(', ')})`); args.push(...wanted); }
    if (source) { where.push('source = ?'); args.push(String(source).slice(0, 40)); }
    if (from) { where.push('created_at >= ?'); args.push(from); }
    if (to) { where.push('created_at <= ?'); args.push(to); }
    const text = String(search || '').trim().slice(0, 100);
    if (text) {
      where.push("(request_id = ? OR error_code = ? OR lower(message) LIKE lower(?) ESCAPE '\\')");
      args.push(text, text, `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
    }
    const [cursorAt, cursorId] = String(before || '').split('|');
    if (cursorAt && cursorId) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      args.push(cursorAt, cursorAt, cursorId);
    }
    const rows = db.prepare(`SELECT id, scope, created_at, level, source, request_id, error_code, message, data, duration_ms, repeat_count
      FROM app_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, pageSize);
    const items = rows.map((row) => ({
      id: row.id, scope: row.scope, at: row.created_at, level: row.level, source: row.source, requestId: row.request_id,
      errorCode: row.error_code, message: row.message, data: parseData(row.data), durationMs: Number(row.duration_ms) || 0, repeat: Number(row.repeat_count) || 1,
    }));
    const last = rows[rows.length - 1];
    return { items, next: rows.length === pageSize && last ? `${last.created_at}|${last.id}` : null };
  }

  /**
   * De bronnen die in de omgeving voorkomen (voor de keuzelijst).
   * @param {string} tenantId De omgeving.
   * @param {boolean} includePlatform Ook platformregels meetellen.
   * @returns {string[]} De bronnen, alfabetisch.
   */
  function sources(tenantId, includePlatform) {
    const rows = db.prepare(`SELECT DISTINCT source FROM app_logs WHERE tenant_id = ?${includePlatform ? '' : " AND scope = 'tenant'"} ORDER BY source`).all(tenantId);
    return rows.map((row) => row.source);
  }

  /**
   * Legt een regel met niveau info vast.
   * @param {string} source Bron.
   * @param {string} message Melding.
   * @param {object} [details] Zie log.
   * @returns {void}
   */
  const info = (source, message, details) => log('info', source, message, details);
  /**
   * Legt een regel met niveau warn vast.
   * @param {string} source Bron.
   * @param {string} message Melding.
   * @param {object} [details] Zie log.
   * @returns {void}
   */
  const warn = (source, message, details) => log('warn', source, message, details);
  /**
   * Legt een regel met niveau error vast.
   * @param {string} source Bron.
   * @param {string} message Melding.
   * @param {object} [details] Zie log.
   * @returns {void}
   */
  const error = (source, message, details) => log('error', source, message, details);
  /**
   * Stopt de timer en schrijft wat nog in de buffer staat weg.
   * @returns {void}
   */
  const stop = () => { if (timer) clearInterval(timer); flush(); };
  /**
   * Aantal regels dat nog op wegschrijven wacht.
   * @returns {number} Het aantal.
   */
  const pending = () => buffer.length;

  return { middleware, log, flush, prune, list, sources, info, warn, error, stop, pending };
}

module.exports = { createAppLog, cleanText, cleanData };
