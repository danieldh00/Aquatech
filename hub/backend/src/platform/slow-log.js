// Log van trage verzoeken, trage achtergrondtaken en stilstand van de server (event loop). Per verzoek komen duur,
// methode, genormaliseerd pad (id's en tokens vervangen, geen querystring), status, omgeving, het aantal databasequeries
// en hun totale tijd (database/query-stats.js) en de externe aanroepen in het logboek zodra de drempel wordt gehaald.
// Nooit lichamen, koppen, cookies, querystrings of gebruikersgegevens. Het logboek staat in het geheugen (laatste
// `capacity` regels) en elke regel gaat ook met het voorvoegsel [traag] of [stilstand] naar de console.
//
// Drempels: SLOW_REQUEST_MS (standaard 1000) voor verzoeken en taken, SLOW_STALL_MS (standaard 1000) voor stilstand van
// de hoofdthread. Een stilstand die geen verzoek als oorzaak heeft (bijvoorbeeld een synchrone achtergrondtaak) is
// zo toch te zien, samen met de verzoeken en taken die op dat moment liepen.
const { createStats, runWithStats, recordExternal } = require('../database/query-stats');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^\d+$/;
const TOKEN = /^[A-Za-z0-9_.-]{20,}$/;
const MAX_ACTIVE_LISTED = 10;

/**
 * Vervangt wat in een pad per bezoeker verschilt (id's, nummers, tokens, e-mailadressen) door een vaste aanduiding, zodat
 * het log groepeert en geen persoonsgegevens of geheimen bevat. De querystring gaat weg.
 * @param {string} rawUrl Het adres van het verzoek (met of zonder querystring).
 * @returns {string} Het genormaliseerde pad, bijv. '/app/api/quotes/:id'.
 */
function normalizePath(rawUrl) {
  const pathOnly = String(rawUrl || '').split('?')[0].split('#')[0];
  return pathOnly.split('/').map((segment) => {
    if (!segment) return segment;
    if (UUID.test(segment) || NUMBER.test(segment)) return ':id';
    if (/[@%]/.test(segment)) return ':waarde';
    if (TOKEN.test(segment) && (/\d/.test(segment) || segment.length >= 32)) return ':token';
    return segment.length > 60 ? ':waarde' : segment;
  }).join('/') || '/';
}

/**
 * Rondt een aantal milliseconden af op één decimaal.
 * @param {number} value Milliseconden.
 * @returns {number} Het afgeronde getal.
 */
const round = (value) => Math.round(value * 10) / 10;

/**
 * Maakt het logboek voor trage verzoeken, taken en stilstand.
 * @param {{ thresholdMs?: number, stallMs?: number, capacity?: number, write?: Function, now?: Function, onRecord?: Function, onTaskError?: Function }} [options]
 *   thresholdMs: vanaf hoeveel ms een verzoek of taak wordt vastgelegd; stallMs: vanaf hoeveel ms stilstand van de
 *   hoofdthread; capacity: aantal regels in het geheugen; write: schrijft een regel (standaard console.warn); now: klok in ms;
 *   onRecord(regel): krijgt elke vastgelegde regel (voor het centrale logboek); onTaskError(naam, fout): een taak die faalt;
 *   ignoreRequest(verzoek, antwoord): geeft true voor een verzoek dat bewust traag is en niet gelogd hoeft te worden.
 * @returns {object} `middleware`, `trackTask`, `startStallWatch`, `entries`, `record`, `thresholdMs`.
 */
function createSlowLog({ thresholdMs = 1000, stallMs = 1000, capacity = 500, write = (line) => console.warn(line), now = () => performance.now(), onRecord = null, onTaskError = null, ignoreRequest = null } = {}) {
  const entries = [];
  const activeRequests = new Map();
  const activeTasks = new Map();
  let nextId = 0;

  /**
   * Bewaart een regel in het geheugen en schrijft hem naar de log.
   * @param {object} entry De regel (soort, duur en details).
   * @returns {object} De bewaarde regel.
   */
  function record(entry) {
    const stored = { at: new Date().toISOString(), ...entry };
    entries.push(stored);
    if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    const { at, kind, ...details } = stored;
    write(`[${kind === 'stilstand' ? 'stilstand' : 'traag'}] ${at} ${kind} ${JSON.stringify(details)}`);
    if (onRecord) { try { onRecord(stored); } catch { /* het centrale logboek mag dit log nooit breken */ } }
    return stored;
  }

  /**
   * Namen van wat nu loopt (verzoeken en taken), voor bij een stilstand.
   * @returns {string[]} Hoogstens MAX_ACTIVE_LISTED aanduidingen.
   */
  const runningNow = () => [
    ...[...activeRequests.values()].map((request) => `${request.method} ${request.path}`),
    ...[...activeTasks.values()].map((task) => `taak ${task}`),
  ].slice(0, MAX_ACTIVE_LISTED);

  /**
   * Express-middleware: meet elk verzoek en legt het vast als het de drempel haalt. Hoort vóór de routes.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next De volgende afhandeling.
   * @returns {void}
   */
  function middleware(req, res, next) {
    const startedAt = now();
    const stats = createStats();
    const id = ++nextId;
    activeRequests.set(id, { method: req.method, path: normalizePath(req.originalUrl || req.url) });
    let finished = false;
    /**
     * Sluit de meting af (bij klaar of bij een afgebroken verbinding), één keer per verzoek.
     * @returns {void}
     */
    const finish = () => {
      if (finished) return;
      finished = true;
      activeRequests.delete(id);
      const durationMs = now() - startedAt;
      if (durationMs < thresholdMs) return;
      if (ignoreRequest && ignoreRequest(req, res)) return;
      const routePath = req.route && typeof req.route.path === 'string' ? `${req.baseUrl || ''}${req.route.path}` : null;
      record({
        kind: 'verzoek',
        method: req.method,
        path: routePath ? normalizePath(routePath) : normalizePath(req.originalUrl || req.url),
        status: res.statusCode,
        aborted: !res.writableFinished,
        durationMs: round(durationMs),
        tenantId: req.tenantId || null,
        requestId: req.requestId || undefined,
        queries: stats.queries,
        dbMs: round(stats.dbMs),
        externalCalls: stats.externalCalls,
        externalMs: round(stats.externalMs),
      });
    };
    res.on('finish', finish);
    res.on('close', finish);
    runWithStats(stats, next);
  }

  /**
   * Voert een achtergrondtaak uit en legt hem vast als hij de drempel haalt. Geeft het resultaat ongewijzigd terug
   * (ook een belofte of een fout).
   * @param {string} name Naam van de taak, bijv. 'onderhoud'.
   * @param {Function} task De taak (synchroon of een belofte).
   * @returns {*} Wat de taak teruggeeft.
   */
  function trackTask(name, task) {
    const startedAt = now();
    const stats = createStats();
    const id = ++nextId;
    activeTasks.set(id, name);
    /**
     * Sluit de meting van de taak af.
     * @returns {void}
     */
    const done = () => {
      activeTasks.delete(id);
      const durationMs = now() - startedAt;
      if (durationMs >= thresholdMs) {
        record({ kind: 'taak', task: name, durationMs: round(durationMs), queries: stats.queries, dbMs: round(stats.dbMs), externalCalls: stats.externalCalls, externalMs: round(stats.externalMs) });
      }
    };
    /**
     * Meldt een mislukte taak aan het centrale logboek.
     * @param {Error} error De fout.
     * @returns {void}
     */
    const failed = (error) => {
      if (onTaskError) { try { onTaskError(name, error); } catch { /* negeren */ } }
    };
    let result;
    try {
      result = runWithStats(stats, task);
    } catch (error) {
      done();
      failed(error);
      throw error;
    }
    if (result && typeof result.then === 'function') {
      return result.then((value) => { done(); return value; }, (error) => { done(); failed(error); throw error; });
    }
    done();
    return result;
  }

  /**
   * Begint de stilstandsbewaking: een timer die vaker afgaat dan de drempel; komt hij veel te laat, dan stond de
   * hoofdthread stil en komt er een regel met wat er liep.
   * @param {{ intervalMs?: number }} [options] intervalMs: hoe vaak de timer afgaat (standaard 250).
   * @returns {{ stop: Function, tick: Function }} `stop` beëindigt de bewaking; `tick` is de controle (voor tests).
   */
  function startStallWatch({ intervalMs = 250 } = {}) {
    let expected = now() + intervalMs;
    let previouslyRunning = [];
    /**
     * Eén controle: vergelijkt het verwachte met het werkelijke moment.
     * @returns {void}
     */
    const tick = () => {
      const current = now();
      const lagMs = current - expected;
      if (lagMs >= stallMs) {
        record({ kind: 'stilstand', stalledMs: round(lagMs), runningDuring: [...new Set([...previouslyRunning, ...runningNow()])].slice(0, MAX_ACTIVE_LISTED) });
      }
      previouslyRunning = runningNow();
      expected = current + intervalMs;
    };
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    return { stop: () => clearInterval(timer), tick };
  }

  return { middleware, trackTask, startStallWatch, entries: () => entries.slice(), record, thresholdMs };
}

/**
 * Wikkelt een fetch-functie zodat elke externe aanroep meetelt bij het lopende verzoek (`externalCalls`/`externalMs`).
 * @param {Function} fetchImpl De te wikkelen fetch.
 * @returns {Function} Een fetch met dezelfde werking.
 */
function timedFetch(fetchImpl) {
  return async (...args) => {
    const startedAt = performance.now();
    try {
      return await fetchImpl(...args);
    } finally {
      recordExternal(performance.now() - startedAt);
    }
  };
}

module.exports = { createSlowLog, normalizePath, timedFetch };
