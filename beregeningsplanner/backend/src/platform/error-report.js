// Foutmeldingen van de API en de debugmodus (Beheer > Instellingen > Foutopsporing).
//
// - Elke onverwachte fout (500) krijgt een korte foutcode. Die staat in het antwoord
//   ("foutcode a1b2c3d4") en in het serverlog, zodat een beheerder de fout terugvindt.
// - Staat de debugmodus van de omgeving aan en is de ingelogde gebruiker beheerder, dan
//   krijgt elk foutantwoord (status 400 en hoger) een blok `debug` met details: soort
//   fout, melding, databasecode, de plek in de code en de aanroepketen. De kop
//   `X-Aquatech-Debug: 1` laat de frontend (shared/common.js) het debugpaneel tonen.
// - Staat de modus uit, of is de gebruiker geen beheerder, dan gaan er nooit details mee:
//   geen stacktrace, geen SQL-melding, geen geheimen.
// - Ook in de debugmodus gaan bekende soorten geheimen er eerst uit (`redact`).
// - `catchAsync(app)` zorgt dat een async route die een fout gooit bij de foutafhandeling
//   uitkomt, in plaats van een verzoek dat blijft hangen.
const crypto = require('crypto');
const path = require('path');

const SOURCE_DIR = path.join(__dirname, '..');
const MAX_TEXT = 2000;
const MAX_FRAMES = 12;
const ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];

// Bekende vormen van geheimen die in een foutmelding terecht kunnen komen.
const SECRET_PATTERNS = [
  // Wachtwoord in een verbindings-URL: postgres://gebruiker:wachtwoord@host
  [/(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^:/?#\s@]*:)[^@/\s]+@/gi, '$1***@'],
  // Autorisatiekoppen en tokens.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 ***'],
  // API-sleutels van Anthropic, Mollie en WooCommerce.
  [/\bsk-ant-[A-Za-z0-9_-]{6,}/g, 'sk-ant-***'],
  [/\b(live|test)_[A-Za-z0-9]{20,}/g, '$1_***'],
  [/\b(ck|cs)_[a-f0-9]{20,}/gi, '$1_***'],
  // Velden als password=..., secret: "...", token=... (ook met voorvoegsel, zoals refresh_token). Het voorvoegsel
  // hoeft niet in het patroon: de waarde na het trefwoord wordt vervangen en het voorvoegsel blijft staan. Zo
  // blijft de regex lineair, ook op lange invoer.
  [/(password|passwd|wachtwoord|secret|token|api[_-]?key|access[_-]?code)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1$2***'],
];

/**
 * Haalt bekende geheimen (wachtwoorden in URL's, tokens, API-sleutels) uit een tekst en kort hem in.
 * @param {*} value De tekst (andere waarden worden tekst).
 * @param {number} [maxLength] Maximale lengte.
 * @returns {string} De tekst zonder geheimen.
 */
function redact(value, maxLength = MAX_TEXT) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * De regels van een stacktrace die bij de eigen code horen, met paden vanaf backend/src
 * (zonder node_modules en de interne Node-regels).
 * @param {string} stack De stacktrace van de fout.
 * @returns {string[]} De regels, bijv. "verkoop/quotes.js:412:13 (sanitize)".
 */
function ownFrames(stack) {
  const frames = [];
  for (const line of String(stack || '').split('\n')) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!match) continue;
    const [, functionName, file, lineNumber, column] = match;
    if (!file.startsWith(SOURCE_DIR + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    const relative = path.relative(SOURCE_DIR, file).split(path.sep).join('/');
    frames.push(`${relative}:${lineNumber}:${column}${functionName ? ` (${functionName})` : ''}`);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

/**
 * Beschrijft een fout voor de debugmodus: soort, melding, databasecode en plek in de code, zonder geheimen.
 * @param {Error|*} error De fout.
 * @returns {object} { name, message, code?, detail?, constraint?, table?, where?, stack[] }.
 */
function describeError(error) {
  if (!error || typeof error !== 'object') return { name: 'Fout', message: redact(error), stack: [] };
  const description = { name: redact(error.name || 'Error', 80), message: redact(error.message || '(geen melding)') };
  // Databasefouten: PostgreSQL (code, detail, constraint, table) en node:sqlite (errcode, errstr).
  const code = error.code ?? error.errcode;
  if (code !== undefined && code !== null && code !== '') description.code = redact(code, 80);
  for (const field of ['detail', 'constraint', 'table', 'errstr']) {
    if (typeof error[field] === 'string' && error[field]) description[field] = redact(error[field], 500);
  }
  const frames = ownFrames(error.stack);
  if (frames.length) description.where = frames[0];
  description.stack = frames;
  if (error.cause && error.cause !== error) {
    const cause = error.cause;
    description.cause = { name: redact(cause.name || 'Error', 80), message: redact(cause.message || cause) };
  }
  return description;
}

/**
 * Bewaart de oorzaak bij een eigen foutantwoord (bijv. 502 "versturen mislukt"), zodat de debugmodus hem toont.
 * Zonder debugmodus gaat de oorzaak nergens heen.
 * @param {object} res Het antwoord.
 * @param {Error} error De oorzaak.
 * @returns {object} Het antwoord (voor withCause(res, error).status(502).json(...)).
 */
function withCause(res, error) {
  res.locals.errorCause = error;
  return res;
}

/**
 * Het pad van het verzoek zoals de browser het aanriep (met /app/ als server.js dat eraf haalde), zonder query.
 * @param {object} req Het verzoek.
 * @returns {string} Het pad.
 */
const requestPath = (req) => redact(`${req.inApp ? '/app' : ''}${String(req.originalUrl || req.url || '').split('?')[0]}`, 300);

/**
 * Een nieuwe foutcode: 8 tekens, genoeg om één fout in het log terug te vinden.
 * @returns {string} De foutcode.
 */
const newErrorId = () => crypto.randomBytes(4).toString('hex');

/**
 * Zorgt dat een async handler die een fout gooit (afgewezen Promise) bij next(error) uitkomt. Express 4
 * doet dat zelf niet: zonder dit blijft zo'n verzoek hangen. Werkt op een app of router; foutafhandelaars
 * (4 parameters), sub-apps en routers blijven ongemoeid.
 * @param {object} target De Express-app of router.
 * @returns {object} Dezelfde app of router.
 */
function catchAsync(target) {
  /**
   * Verpakt één handler (of een lijst handlers) zodat een afgewezen Promise naar next gaat.
   * @param {*} handler De handler, een lijst handlers of iets anders (pad, instelling).
   * @returns {*} De verpakte handler, of de waarde zelf.
   */
  const wrap = (handler) => {
    if (Array.isArray(handler)) return handler.map(wrap);
    if (typeof handler !== 'function' || handler.length >= 4 || handler.handle || handler.stack) return handler;
    /**
     * Roept de handler aan en stuurt een afgewezen Promise naar de foutafhandeling.
     * @param {object} req Het verzoek.
     * @param {object} res Het antwoord.
     * @param {Function} next Volgende handler.
     * @returns {*} Wat de handler teruggeeft.
     */
    const safeHandler = function safeHandler(req, res, next) {
      const result = handler.call(this, req, res, next);
      if (result && typeof result.then === 'function') result.then(undefined, next);
      return result;
    };
    return safeHandler;
  };
  for (const method of ROUTE_METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    /**
     * Registreert routes zoals Express, met elke handler verpakt (zie wrap).
     * @param {...*} args Pad en handlers.
     * @returns {*} Wat Express teruggeeft.
     */
    target[method] = function routeWithCatch(...args) {
      // app.get('instelling') leest een instelling uit en registreert niets.
      if (method === 'get' && args.length === 1 && typeof args[0] === 'string') return original.apply(this, args);
      return original.apply(this, args.map(wrap));
    };
  }
  return target;
}

/**
 * Bouwt de foutafhandeling van de app.
 * @param {object} options Opties.
 * @param {(req: object) => boolean} options.debugFor Of dit verzoek details mag krijgen (debugmodus aan + beheerder).
 * @param {(line: string, detail: string) => void} [options.log] Schrijft een fout naar het log (standaard console.error); detail = de stacktrace of melding, zonder geheimen.
 * @returns {{ attach: Function, handler: Function }} Middleware (vroeg plaatsen) en foutafhandelaar (als laatste).
 */
function createErrorReport({ debugFor, log = (line, detail) => console.error(line, detail) }) {
  /**
   * Of dit verzoek details mag zien; een fout bij die controle betekent nee.
   * @param {object} req Het verzoek.
   * @returns {boolean} true als details mee mogen.
   */
  const allowed = (req) => {
    try { return Boolean(debugFor(req)); } catch { return false; }
  };

  /**
   * Het debugblok voor een foutantwoord.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {object} body Het foutantwoord ({ error, message }).
   * @returns {object} De details.
   */
  const debugBlock = (req, res, body) => {
    const block = {
      status: res.statusCode,
      error: body.error || null,
      method: req.method,
      path: requestPath(req),
      time: new Date().toISOString(),
    };
    if (res.locals.errorId) block.errorId = res.locals.errorId;
    if (res.locals.errorCause) block.cause = describeError(res.locals.errorCause);
    return block;
  };

  /**
   * Middleware (vroeg in de keten): voegt bij een foutantwoord als JSON het debugblok toe als dat mag.
   * Goede antwoorden kosten niets extra: alleen bij status 400+ wordt er iets gecontroleerd.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next Volgende handler.
   * @returns {void}
   */
  function attach(req, res, next) {
    const json = res.json.bind(res);
    /**
     * Stuurt JSON; een foutantwoord krijgt het debugblok als dat mag.
     * @param {*} body Het antwoord.
     * @returns {object} Het antwoord-object van Express.
     */
    res.json = (body) => {
      if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body) && !body.debug && allowed(req)) {
        res.setHeader('X-Aquatech-Debug', '1');
        return json({ ...body, debug: debugBlock(req, res, body) });
      }
      return json(body);
    };
    next();
  }

  /**
   * Laatste foutafhandelaar: kapotte JSON en te grote verzoeken krijgen een eigen melding; elke andere fout
   * komt met een foutcode in het log en als 500 met die foutcode terug.
   * @param {Error} error De fout.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next Volgende handler (alleen als het antwoord al deels verstuurd is).
   * @returns {void}
   */
  function handler(error, req, res, next) {
    if (res.headersSent) return next(error);
    res.locals.errorCause = error;
    if (error && error.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'Ongeldige JSON: het verzoek kon niet worden gelezen.' });
    if (error && error.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'Het verzoek is te groot (bijvoorbeeld een te grote afbeelding).' });
    const errorId = newErrorId();
    res.locals.errorId = errorId;
    const who = req.user ? ` gebruiker ${req.user.id}` : '';
    const where = req.tenantId ? ` omgeving ${req.tenantId}` : '';
    log(`[fout ${errorId}] ${req.method} ${requestPath(req)}${who}${where}`, redact(error && error.stack ? error.stack : error, 8000));
    return res.status(500).json({
      error: 'internal_error',
      errorId,
      message: `Er ging iets mis op de server (foutcode ${errorId}). Probeer het opnieuw; blijft het gebeuren, geef de foutcode door aan de beheerder.`,
    });
  }

  return { attach, handler };
}

module.exports = { createErrorReport, catchAsync, withCause, describeError, redact, ownFrames };
