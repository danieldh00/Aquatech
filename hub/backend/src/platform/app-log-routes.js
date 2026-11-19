// Routes voor Beheer > Systeem > Logboek (GET /api/admin/logs; de map /api/admin eist al het recht beheer).
// Wie wat ziet: een beheerder alleen de regels van de eigen omgeving (req.tenantId); platformregels (stilstand, taken zonder
// omgeving) en het kiezen van een andere omgeving alleen met canPlatform. Elke query filtert op tenant_id.
const { createRateLimiter } = require('../beveiliging/rate-limit');

const BASE = '/api/admin/logs';
const LEVELS = ['info', 'warn', 'error'];
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/**
 * Leest een tijdstip uit de query: een datum (JJJJ-MM-DD) of een ISO-tijdstip; ongeldig = leeg.
 * @param {*} raw De invoer.
 * @param {boolean} endOfDay Bij een losse datum: het einde van die dag in plaats van het begin.
 * @returns {string} ISO-tijdstip of een lege tekst.
 */
function timeOf(raw, endOfDay) {
  const text = String(raw || '').slice(0, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text))) return `${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
  return ISO.test(text) ? text : '';
}

/**
 * Registreert de logboekroutes.
 * @param {object} app De Express-app.
 * @param {{ appLog: object, canPlatform: Function, environmentIds: Function }} deps appLog (platform/app-log.js), canPlatform(req) en environmentIds() (alle omgevingen, voor de keuze van een platformbeheerder).
 * @returns {void}
 */
function registerAppLogRoutes(app, { appLog, canPlatform, environmentIds }) {
  const readLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 300, keyFn: (req) => `logboek:${req.user ? req.user.id : ''}` });

  /**
   * Of deze gebruiker platformregels en andere omgevingen mag zien (een fout telt als nee).
   * @param {object} req Het verzoek.
   * @returns {boolean} true als het mag.
   */
  const platformFor = (req) => {
    try { return Boolean(canPlatform(req)); } catch { return false; }
  };

  app.get(BASE, readLimiter, (req, res) => {
    const platform = platformFor(req);
    let tenantId = req.tenantId;
    const asked = String(req.query.tenant || '').slice(0, 64);
    if (asked && asked !== tenantId) {
      if (!platform || !environmentIds().includes(asked)) return res.status(404).json({ error: 'not_found', message: 'Deze omgeving bestaat niet.' });
      tenantId = asked;
    }
    appLog.flush();
    const levels = String(req.query.level || '').split(',').filter((level) => LEVELS.includes(level));
    const result = appLog.list(tenantId, {
      levels, source: String(req.query.source || '').slice(0, 40), search: req.query.q, from: timeOf(req.query.from, false), to: timeOf(req.query.to, true),
      before: String(req.query.before || '').slice(0, 80), includePlatform: platform, limit: req.query.limit,
    });
    return res.json({ ...result, sources: appLog.sources(tenantId, platform), canPlatform: platform, tenantId, environments: platform ? environmentIds() : [] });
  });
}

module.exports = { registerAppLogRoutes };
