// Routes voor Beheer > Systeem > Bewaking en meldingen (/api/admin/monitoring; de map /api/admin eist al het recht
// beheer). De bewaking zelf (checks uitvoeren, incidenten, mail/webhook/heartbeat) staat in monitoring.js; hier staan
// wie wat mag zien en wijzigen, de invoercontrole van de instelling `monitoring`, de limieten en het auditlog.
// Tenant-isolatie: de omgeving komt altijd uit req.tenantId. Platformbewaking (server, database, schijf, back-ups,
// update) staat onder de hoofdtenant en is alleen zichtbaar en instelbaar voor wie canPlatform(req) is.
const express = require('express');
const { createRateLimiter } = require('../beveiliging/rate-limit');

const BASE = '/api/admin/monitoring';
const MAX_RECIPIENTS = 5;
const MAX_URL = 500;
const MAX_MUTED = 50;
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const INCIDENT_STATES = ['open', 'opgelost'];

/** De drempels van de platformchecks met hun toegestane bereik (alleen wijzigbaar met canPlatform). */
const THRESHOLDS = {
  backupMaxHours: { min: 1, max: 720, label: 'Back-up maximaal oud (uren)' },
  diskMinFreePct: { min: 1, max: 90, label: 'Minimaal vrij op de schijf (%)' },
  diskMinFreeMb: { min: 0, max: 1000000, label: 'Minimaal vrij op de schijf (MB)' },
  errorsPerHour: { min: 1, max: 10000, label: 'Serverfouten per uur' },
  dbSlowMs: { min: 50, max: 60000, label: 'Database traag vanaf (ms)' },
};

/**
 * Een leesbare invoerfout (wordt 400 met de melding).
 * @param {string} field Het veld waar het om gaat.
 * @param {string} message De melding voor de gebruiker.
 * @returns {Error} De fout met status 400 en field.
 */
function inputError(field, message) {
  return Object.assign(new Error(message), { status: 400, field });
}

/**
 * Controleert een webadres voor een webhook of heartbeat: leeg mag, anders https, zonder gebruikersnaam/wachtwoord in
 * het adres en hoogstens 500 tekens. Of de host openbaar is, controleert de monitor bij het versturen (netguard).
 * @param {*} raw De invoer.
 * @param {string} field Naam van het veld (voor de melding).
 * @returns {string} Het adres, of een lege tekst.
 * @throws {Error} Bij een ongeldig adres.
 */
function cleanUrl(raw, field) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.length > MAX_URL) throw inputError(field, `Het adres is te lang (hoogstens ${MAX_URL} tekens).`);
  let parsed;
  try { parsed = new URL(value); } catch (error) { throw inputError(field, 'Dit is geen geldig webadres.'); }
  if (parsed.protocol !== 'https:') throw inputError(field, 'Het adres moet met https:// beginnen.');
  if (parsed.username || parsed.password) throw inputError(field, 'Zet geen gebruikersnaam of wachtwoord in het adres.');
  if (parsed.port && parsed.port !== '443') throw inputError(field, 'Gebruik het standaardadres zonder poortnummer.');
  return parsed.toString();
}

/**
 * Controleert de ontvangers: een lijst of tekst met e-mailadressen (gescheiden door komma, puntkomma of regel).
 * @param {*} raw De invoer.
 * @returns {string[]} Unieke adressen, hoogstens vijf.
 * @throws {Error} Bij een ongeldig adres of te veel adressen.
 */
function cleanRecipients(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,;]+/);
  const addresses = [];
  for (const entry of list) {
    const address = String(entry ?? '').trim().toLowerCase();
    if (!address) continue;
    if (address.length > 254 || !EMAIL_PATTERN.test(address)) throw inputError('recipients', `Geen geldig e-mailadres: ${address.slice(0, 60)}`);
    if (!addresses.includes(address)) addresses.push(address);
  }
  if (addresses.length > MAX_RECIPIENTS) throw inputError('recipients', `Hoogstens ${MAX_RECIPIENTS} ontvangers.`);
  return addresses;
}

/**
 * Controleert een geheel getal binnen een bereik.
 * @param {*} raw De invoer (getal of tekst met cijfers).
 * @param {string} field Naam van het veld.
 * @param {number} min Kleinste waarde.
 * @param {number} max Grootste waarde.
 * @param {string} label Omschrijving voor de melding.
 * @returns {number} Het getal.
 * @throws {Error} Als het geen geheel getal in het bereik is.
 */
function cleanInt(raw, field, min, max, label) {
  const number = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
    throw inputError(field, `${label}: kies een geheel getal van ${min} tot ${max}.`);
  }
  return number;
}

/**
 * Saneert een wijziging van de instelling `monitoring` en legt hem over de huidige instelling. Alleen meegestuurde
 * velden veranderen. Zonder canPlatform blijven de heartbeat-URL, de drempels en het dempen van platformchecks zoals
 * ze waren (wordt stil genegeerd, net als in het scherm, dat die velden dan niet toont).
 * @param {object} current De huidige (gesaneerde) instelling.
 * @param {object} input De invoer uit de browser.
 * @param {{ platform: boolean, knownKeys: Set<string>, platformKeys: Set<string> }} options Of de gebruiker de
 *   platformbewaking mag instellen, welke checksleutels er bestaan en welke daarvan platformchecks zijn.
 * @returns {{ next: object, changed: string[] }} De nieuwe instelling en de namen van de gewijzigde velden.
 * @throws {Error} Met status 400 bij ongeldige invoer.
 */
function mergeConfig(current, input, { platform, knownKeys, platformKeys }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw inputError('', 'Ongeldige invoer.');
  const next = { ...current, thresholds: { ...(current.thresholds || {}) }, muted: [...(current.muted || [])], recipients: [...(current.recipients || [])] };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw inputError('enabled', 'Ongeldige waarde voor bewaking aan/uit.');
    next.enabled = input.enabled;
  }
  if (input.notifyRecovery !== undefined) {
    if (typeof input.notifyRecovery !== 'boolean') throw inputError('notifyRecovery', 'Ongeldige waarde voor de herstelmelding.');
    next.notifyRecovery = input.notifyRecovery;
  }
  if (input.recipients !== undefined) next.recipients = cleanRecipients(input.recipients);
  if (input.webhookUrl !== undefined) next.webhookUrl = cleanUrl(input.webhookUrl, 'webhookUrl');
  if (input.reminderHours !== undefined) next.reminderHours = cleanInt(input.reminderHours, 'reminderHours', 0, 168, 'Herinnering na (uren)');
  if (platform && input.heartbeatUrl !== undefined) next.heartbeatUrl = cleanUrl(input.heartbeatUrl, 'heartbeatUrl');
  if (platform && input.thresholds !== undefined) {
    if (!input.thresholds || typeof input.thresholds !== 'object' || Array.isArray(input.thresholds)) throw inputError('thresholds', 'Ongeldige drempels.');
    for (const [key, range] of Object.entries(THRESHOLDS)) {
      if (input.thresholds[key] !== undefined) next.thresholds[key] = cleanInt(input.thresholds[key], `thresholds.${key}`, range.min, range.max, range.label);
    }
  }
  if (input.muted !== undefined) {
    if (!Array.isArray(input.muted)) throw inputError('muted', 'Ongeldige lijst met gedempte controles.');
    const wanted = [...new Set(input.muted.map((key) => String(key ?? '').slice(0, 60)))].filter((key) => knownKeys.has(key));
    // Platformchecks dempen mag alleen met canPlatform; anders blijft hun stand zoals hij was.
    const kept = platform ? [] : next.muted.filter((key) => platformKeys.has(key));
    const own = platform ? wanted : wanted.filter((key) => !platformKeys.has(key));
    next.muted = [...new Set([...kept, ...own])].slice(0, MAX_MUTED);
  }
  const changed = ['enabled', 'notifyRecovery', 'recipients', 'webhookUrl', 'reminderHours', 'heartbeatUrl', 'thresholds', 'muted']
    .filter((key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]));
  return { next, changed };
}

/**
 * Het tijdstip waarop een incident het laatst is gezien (de monitor kan camelCase of de kolomnaam gebruiken).
 * @param {object} incident Het incident.
 * @returns {string} ISO-tijdstip, of een lege tekst.
 */
const lastSeenOf = (incident) => String(incident.lastAt || incident.last_at || incident.firstAt || incident.first_at || '');

/**
 * Of een incident een platformincident is.
 * @param {object} incident Het incident.
 * @returns {boolean} true bij scope 'platform'.
 */
const isPlatform = (incident) => incident.scope === 'platform';

/**
 * Registreert de routes van de bewaking onder /api/admin/monitoring.
 * @param {import('express').Express} app De app.
 * @param {object} deps monitor (createMonitor), settingsFor (tenantId → instellingen met get/update), audit (req, actie,
 *   detail), requireJson (middleware), canPlatform (req → boolean: mag de platformbewaking zien en instellen),
 *   mainTenantId (de hoofdtenant, waar de platformincidenten staan) en optioneel mailerFor (instellingen → mailer met
 *   configured(); zonder: kijkt naar host en afzender van mailServer).
 * @returns {void}
 */
function registerMonitoringRoutes(app, { monitor, settingsFor, audit, requireJson, canPlatform, mainTenantId, mailerFor }) {
  const runLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 6, keyFn: (req) => `bewaking-run:${req.user ? req.user.id : ''}` });
  const testLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 5, keyFn: (req) => `bewaking-test:${req.user ? req.user.id : ''}` });
  const saveLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, keyFn: (req) => `bewaking-opslaan:${req.user ? req.user.id : ''}` });

  /**
   * Of deze gebruiker de platformbewaking mag zien (nooit gooien: een fout telt als nee).
   * @param {object} req Het verzoek.
   * @returns {boolean} true als het mag.
   */
  const platformFor = (req) => {
    try { return Boolean(canPlatform(req)) && Boolean(mainTenantId); } catch (error) { return false; }
  };

  /**
   * Of de omgeving een mailserver heeft (anders worden meldingen alleen in de app getoond).
   * @param {string} tenantId De omgeving.
   * @returns {boolean} true als er gemaild kan worden.
   */
  const mailConfigured = (tenantId) => {
    try {
      const tenantSettings = settingsFor(tenantId);
      if (mailerFor) return Boolean(mailerFor(tenantSettings).configured());
      const server = tenantSettings.get('mailServer') || {};
      return Boolean(server.host && server.from);
    } catch (error) {
      return false;
    }
  };

  /**
   * De gesaneerde instelling voor het scherm; zonder canPlatform zonder heartbeat-URL en drempels.
   * @param {string} tenantId De omgeving.
   * @param {boolean} platform Of de gebruiker de platformbewaking mag zien.
   * @returns {Promise<object>} De instelling.
   */
  const configView = async (tenantId, platform) => {
    const config = { ...(await monitor.config(tenantId)) };
    if (!platform) {
      delete config.heartbeatUrl;
      delete config.thresholds;
    }
    return config;
  };

  /**
   * De controles die deze gebruiker ziet: die van de omgeving en, met canPlatform, die van het platform.
   * @param {object} req Het verzoek.
   * @param {boolean} platform Of de gebruiker de platformbewaking mag zien.
   * @returns {Promise<object[]>} De controles met hun stand.
   */
  const checksFor = async (req, platform) => {
    const own = (await monitor.checkStates(req.tenantId, 'tenant')) || [];
    const platformChecks = platform ? ((await monitor.checkStates(mainTenantId, 'platform')) || []) : [];
    return [...platformChecks, ...own];
  };

  /**
   * De incidenten die deze gebruiker mag zien, nieuwste eerst: die van de eigen omgeving (zonder platformincidenten,
   * ook niet als de omgeving de hoofdtenant is) en met canPlatform de platformincidenten van de hoofdtenant.
   * @param {object} req Het verzoek.
   * @param {boolean} platform Of de gebruiker de platformbewaking mag zien.
   * @param {{ state?: string, limit?: number, before?: string }} options Filter.
   * @returns {Promise<object[]>} De incidenten.
   */
  const incidentsFor = async (req, platform, { state, limit = 50, before } = {}) => {
    const query = { limit, ...(state ? { state } : {}), ...(before ? { before } : {}) };
    const own = ((await monitor.list(req.tenantId, query)) || []).filter((incident) => (platform && req.tenantId === mainTenantId) || !isPlatform(incident));
    const extra = platform && req.tenantId !== mainTenantId ? ((await monitor.list(mainTenantId, query)) || []).filter(isPlatform) : [];
    return [...own, ...extra].sort((left, right) => lastSeenOf(right).localeCompare(lastSeenOf(left))).slice(0, limit);
  };

  /**
   * Het hele overzicht voor het scherm.
   * @param {object} req Het verzoek.
   * @returns {Promise<object>} config, mailConfigured, canPlatform, checks, open en incidents.
   */
  const overview = async (req) => {
    const platform = platformFor(req);
    const [config, checks, openIncidents, incidents] = await Promise.all([
      configView(req.tenantId, platform), checksFor(req, platform), incidentsFor(req, platform, { state: 'open', limit: 200 }), incidentsFor(req, platform, { limit: 50 }),
    ]);
    const open = { fout: 0, waarschuwing: 0 };
    for (const incident of openIncidents) if (open[incident.severity] !== undefined) open[incident.severity] += 1;
    return { config, mailConfigured: mailConfigured(req.tenantId), canPlatform: platform, checks, open, incidents };
  };

  app.use(BASE, express.json({ limit: '8kb' }), (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.tenantId) return res.status(403).json({ error: 'forbidden', message: 'Geen omgeving.' });
    next();
  });

  app.get(BASE, async (req, res) => {
    res.json(await overview(req));
  });

  app.put(`${BASE}/config`, saveLimiter, requireJson, async (req, res) => {
    const platform = platformFor(req);
    const current = await monitor.config(req.tenantId);
    const checks = await checksFor(req, true);
    const knownKeys = new Set(checks.map((check) => check.key));
    const platformKeys = new Set(checks.filter((check) => check.scope === 'platform').map((check) => check.key));
    let merged;
    try {
      merged = mergeConfig(current, req.body, { platform, knownKeys, platformKeys });
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: 'invalid', field: error.field, message: error.message });
      throw error;
    }
    if (merged.changed.length) {
      try {
        settingsFor(req.tenantId).update({ monitoring: merged.next }, req.user ? req.user.id : null);
      } catch (error) {
        if (error && error.name === 'SettingsError') return res.status(400).json({ error: 'invalid', message: error.message });
        throw error;
      }
      // Nooit de adressen zelf in het auditlog: een webhook- of heartbeat-adres bevat vaak een geheim token.
      audit(req, 'bewaking_instellingen', {
        velden: merged.changed, aan: merged.next.enabled !== false, ontvangers: merged.next.recipients.length,
        webhook: Boolean(merged.next.webhookUrl), ...(platform ? { heartbeat: Boolean(merged.next.heartbeatUrl) } : {}),
        gedempt: merged.next.muted,
      });
    }
    res.json(await overview(req));
  });

  app.post(`${BASE}/run`, runLimiter, requireJson, async (req, res) => {
    const platform = platformFor(req);
    const result = await monitor.runAll({ force: true, tenantId: req.tenantId, includePlatform: platform });
    res.json({ ran: result ? result.ran : 0, ...(await overview(req)) });
  });

  app.post(`${BASE}/test`, testLimiter, requireJson, async (req, res) => {
    const platform = platformFor(req);
    const result = { ...((await monitor.sendTest(req.tenantId, { platform })) || {}) };
    if (!platform) delete result.heartbeat;
    audit(req, 'bewaking_testmelding', { mail: Boolean(result.mail && result.mail.ok), webhook: Boolean(result.webhook && result.webhook.ok) });
    res.json(result);
  });

  app.get(`${BASE}/incidents`, async (req, res) => {
    const state = INCIDENT_STATES.includes(req.query.state) ? req.query.state : undefined;
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const beforeRaw = String(req.query.before || '').slice(0, 40);
    const before = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(beforeRaw) ? beforeRaw : undefined;
    const incidents = await incidentsFor(req, platformFor(req), { state, limit, before });
    res.json({ incidents, next: incidents.length === limit ? lastSeenOf(incidents[incidents.length - 1]) : null });
  });
}

module.exports = { registerMonitoringRoutes, mergeConfig, THRESHOLDS };
