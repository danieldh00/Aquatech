// Bewaking (platform/monitoring.js): de instelling `monitoring` (saneren en standaarden) en het versturen van meldingen:
// mail aan de ontvangers via de mailserver van de omgeving, een webhook (POST met JSON) en de heartbeat (GET op een
// adres van een dienst als healthchecks.io, die alarm slaat als de pings uitblijven).
// Webhook en heartbeat gaan alleen naar openbare https-adressen: de naam wordt eerst opgezocht (netguard.js) en de
// verbinding gaat naar precies dat adres (pinned-fetch.js), zonder omleidingen. Meldingen bevatten nooit geheimen
// (redact uit error-report.js) en een mislukte melding gooit nooit: de uitkomst komt terug als { ok, message }.
const { validEmail, mailFailure } = require('./mailer');
const { redact } = require('./error-report');
const { publicAddress, privateAllowed } = require('../beveiliging/netguard');
const { pinnedFetch, readLimited } = require('../beveiliging/pinned-fetch');

/** Hoogstens zoveel ontvangers per omgeving. */
const MAX_RECIPIENTS = 5;
/** Maximale lengte van een webhook- of heartbeatadres. */
const MAX_URL_LENGTH = 500;
/** Hoogstens zoveel gedempte controles. */
const MAX_MUTED = 50;
/** Tijdslimiet voor één webhook- of heartbeatverzoek. */
const SEND_TIMEOUT_MS = 10000;
/** Zoveel bytes van een antwoord worden hoogstens gelezen (alleen om de verbinding netjes af te sluiten). */
const MAX_RESPONSE_BYTES = 4096;

/** Drempels van de platformcontroles: standaard, minimum en maximum. */
const THRESHOLDS = {
  backupMaxHours: { default: 36, min: 1, max: 720 },
  diskMinFreePct: { default: 10, min: 0, max: 90 },
  diskMinFreeMb: { default: 1024, min: 0, max: 1048576 },
  errorsPerHour: { default: 20, min: 1, max: 100000 },
  dbSlowMs: { default: 2000, min: 50, max: 60000 },
};

/** De standaardinstelling van de bewaking. */
const MONITORING_DEFAULTS = Object.freeze({
  enabled: true,
  recipients: [],
  webhookUrl: '',
  heartbeatUrl: '',
  notifyRecovery: true,
  reminderHours: 24,
  muted: [],
  thresholds: Object.freeze(Object.fromEntries(Object.entries(THRESHOLDS).map(([key, limits]) => [key, limits.default]))),
});

/** Een controle-sleutel: kleine letters, cijfers en - _ . : (zoals 'database' of 'drive-backup'). */
const CHECK_KEY = /^[a-z0-9][a-z0-9_.:-]{0,59}$/;

/**
 * Maakt een webadres veilig voor de bewaking: alleen https, met een hostnaam, zonder gebruikersnaam of wachtwoord in
 * het adres en niet langer dan 500 tekens. Of de host openbaar is, wordt pas bij het versturen gecontroleerd.
 * @param {*} value Het ingevoerde adres.
 * @returns {string} Het adres, of '' als het niet bruikbaar is.
 */
function cleanHttpsUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > MAX_URL_LENGTH) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return '';
  return url.href;
}

/**
 * Een geheel getal binnen grenzen; iets anders dan een getal wordt de standaardwaarde.
 * @param {*} value De ruwe waarde.
 * @param {{ default: number, min: number, max: number }} limits Standaard, minimum en maximum.
 * @returns {number} Het getal.
 */
function boundedInteger(value, limits) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, Math.round(number)));
}

/**
 * Saneert de instelling `monitoring` (settings.js): ontvangers (geldige e-mailadressen, hoogstens 5, zonder dubbele),
 * webhook- en heartbeatadres (https), herstelmelding, herinnering na zoveel uur (0 = geen, anders 1-168), gedempte
 * controles en de drempels van de platformcontroles. Ontbrekende of ongeldige velden krijgen de standaardwaarde.
 * @param {*} raw De opgeslagen of ingevoerde waarde.
 * @returns {{ enabled: boolean, recipients: string[], webhookUrl: string, heartbeatUrl: string, notifyRecovery: boolean, reminderHours: number, muted: string[], thresholds: object }} De gesaneerde instelling.
 */
function sanitizeMonitoring(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const recipientList = Array.isArray(input.recipients) ? input.recipients
    : typeof input.recipients === 'string' ? input.recipients.split(/[\s,;]+/) : [];
  const recipients = [];
  for (const entry of recipientList) {
    const address = typeof entry === 'string' ? entry.trim() : '';
    if (!validEmail(address) || recipients.some((known) => known.toLowerCase() === address.toLowerCase())) continue;
    recipients.push(address);
    if (recipients.length >= MAX_RECIPIENTS) break;
  }
  const muted = [];
  for (const entry of Array.isArray(input.muted) ? input.muted : []) {
    const key = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (CHECK_KEY.test(key) && !muted.includes(key)) muted.push(key);
    if (muted.length >= MAX_MUTED) break;
  }
  const rawThresholds = input.thresholds && typeof input.thresholds === 'object' ? input.thresholds : {};
  const thresholds = {};
  for (const [key, limits] of Object.entries(THRESHOLDS)) thresholds[key] = boundedInteger(rawThresholds[key], limits);
  const reminderHours = boundedInteger(input.reminderHours, { default: MONITORING_DEFAULTS.reminderHours, min: 0, max: 168 });
  return {
    enabled: input.enabled !== false,
    recipients,
    webhookUrl: cleanHttpsUrl(input.webhookUrl),
    heartbeatUrl: cleanHttpsUrl(input.heartbeatUrl),
    notifyRecovery: input.notifyRecovery !== false,
    reminderHours,
    muted,
    thresholds,
  };
}

/** Kopjes per soort melding (onderwerp van de mail en de tekst in de webhook). */
const KIND_LABELS = {
  open: 'Storing',
  herinnering: 'Herinnering: nog steeds een storing',
  opgelost: 'Opgelost',
  test: 'Testmelding',
};

/**
 * Stelt de inhoud van een melding samen: onderwerp en tekst voor de mail en de JSON voor de webhook. Titel en bericht
 * gaan door redact, zodat er geen geheimen in staan.
 * @param {{ kind: 'open'|'herinnering'|'opgelost'|'test', title: string, message?: string, severity?: string, checkKey?: string, environment?: string, link?: string, at: string }} details Soort, titel, bericht, ernst, controle, naam van de omgeving, link naar Beheer en tijdstip (ISO).
 * @returns {{ subject: string, text: string, payload: object }} De mail en de webhook-inhoud.
 */
function composeNotice({ kind, title, message = '', severity = '', checkKey = '', environment = '', link = '', at }) {
  const cleanTitle = redact(title || checkKey || 'Bewaking', 200).replace(/[\r\n]+/g, ' ');
  const cleanMessage = redact(message, 500);
  const cleanEnvironment = redact(environment, 120).replace(/[\r\n]+/g, ' ');
  const label = KIND_LABELS[kind] || KIND_LABELS.open;
  const severityText = severity === 'fout' ? 'Fout' : severity === 'waarschuwing' ? 'Waarschuwing' : '';
  const subject = `[AquaTech Hub] ${label}: ${cleanTitle}${cleanEnvironment ? ` (${cleanEnvironment})` : ''}`;
  const lines = [
    kind === 'test' ? 'Dit is een testmelding van de bewaking. Er is niets aan de hand.' : `${label}: ${cleanTitle}`,
    '',
  ];
  if (cleanMessage) lines.push(cleanMessage, '');
  if (severityText) lines.push(`Ernst: ${severityText}`);
  if (cleanEnvironment) lines.push(`Omgeving: ${cleanEnvironment}`);
  lines.push(`Tijdstip: ${at}`);
  if (link) lines.push('', `Bekijk de bewaking: ${link}`);
  if (kind !== 'test') lines.push('', 'Deze melding komt van Beheer > Systeem > Bewaking. Daar stel je de ontvangers en herinneringen in.');
  const payload = {
    titel: cleanTitle, bericht: cleanMessage, ernst: severity || '', status: kind, controle: checkKey || '',
    omgeving: cleanEnvironment, tijdstip: at, link: link || '',
    // Voor chatdiensten die alleen een tekstveld lezen (zoals Slack en Mattermost).
    text: `${label}: ${cleanTitle}${cleanMessage ? ` - ${cleanMessage}` : ''}`,
  };
  if (kind === 'test') payload.test = true;
  return { subject, text: lines.join('\n'), payload };
}

/**
 * Maakt het verzendgedeelte van de bewaking: mail, webhook en heartbeat. Gooit nooit; elke functie geeft
 * { ok, message, skipped? } terug.
 * @param {{ mailerFor: Function, fetchImpl?: Function|null, resolveHost?: Function, log?: object, timeoutMs?: number }} options De mailer per instellingen, een eigen fetch (tests; zonder: pinned-fetch naar het opgezochte adres), de functie die een hostnaam naar een openbaar adres opzoekt, het log en de tijdslimiet per verzoek.
 * @returns {{ mail: Function, webhook: Function, ping: Function }} De verzendfuncties.
 */
function createNotifier({ mailerFor, fetchImpl = null, resolveHost = publicAddress, log = console, timeoutMs = SEND_TIMEOUT_MS }) {
  /**
   * Doet een HTTP-verzoek naar een openbaar https-adres van de instelling. Lokale adressen alleen met
   * ALLOW_PRIVATE_HOSTS=1 (tests/ontwikkelen).
   * @param {string} url Het adres.
   * @param {{ method: string, headers?: object, body?: string }} init Methode, koppen en inhoud.
   * @returns {Promise<{ ok: boolean, message: string }>} De uitkomst.
   */
  async function request(url, init) {
    const cleanUrl = cleanHttpsUrl(url);
    if (!cleanUrl) return { ok: false, message: 'Geen geldig https-adres.' };
    let send = fetchImpl;
    try {
      const address = privateAllowed() ? null : await resolveHost(new URL(cleanUrl).hostname);
      if (!send) send = address ? pinnedFetch(address) : fetch;
    } catch (error) {
      return { ok: false, message: error && error.code === 'private_host' ? 'Het adres is geen openbaar adres.' : 'Het adres is niet gevonden.' };
    }
    let response;
    try {
      response = await send(cleanUrl, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return { ok: false, message: error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'Geen antwoord binnen de tijd.' : 'Niet bereikbaar (of doorgestuurd naar een ander adres).' };
    }
    // De inhoud doet er niet toe; begrensd lezen sluit de verbinding netjes af.
    if (response && response.body) await readLimited(response, MAX_RESPONSE_BYTES).catch(() => {});
    if (!response || !response.ok) return { ok: false, message: `Het adres gaf status ${response ? response.status : 'onbekend'}.` };
    return { ok: true, message: 'Verstuurd.' };
  }

  /**
   * Mailt een melding aan de ontvangers via de mailserver van de omgeving. Zonder mailserver of ontvangers wordt er
   * niets verstuurd (skipped).
   * @param {object} settings De instellingen van de omgeving (voor mailerFor).
   * @param {string[]} recipients De ontvangers.
   * @param {{ subject: string, text: string }} notice De mail (uit composeNotice).
   * @returns {Promise<{ ok: boolean, message: string, skipped?: boolean }>} De uitkomst.
   */
  async function mail(settings, recipients, notice) {
    if (!recipients || !recipients.length) return { ok: false, skipped: true, message: 'Geen ontvangers ingesteld.' };
    let mailer;
    try {
      mailer = mailerFor(settings);
      if (!mailer || !mailer.configured()) return { ok: false, skipped: true, message: 'Er is geen mailserver ingesteld.' };
    } catch (error) {
      log.warn('[bewaking] Mailserver niet te gebruiken:', redact(error && error.message, 200));
      return { ok: false, message: 'De mailserver is niet te gebruiken.' };
    }
    try {
      await mailer.send({ to: recipients, subject: notice.subject, text: notice.text });
      return { ok: true, message: `Verstuurd naar ${recipients.length} ${recipients.length === 1 ? 'ontvanger' : 'ontvangers'}.` };
    } catch (error) {
      return { ok: false, message: redact(mailFailure(error), 300) };
    }
  }

  /**
   * Stuurt de melding als JSON naar de webhook. Zonder adres wordt er niets verstuurd (skipped).
   * @param {string} url Het webhookadres.
   * @param {object} payload De JSON-inhoud (uit composeNotice).
   * @returns {Promise<{ ok: boolean, message: string, skipped?: boolean }>} De uitkomst.
   */
  async function webhook(url, payload) {
    if (!url) return { ok: false, skipped: true, message: 'Geen webhook ingesteld.' };
    return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'AquaTech-Hub-Bewaking' }, body: JSON.stringify(payload) });
  }

  /**
   * Stuurt een heartbeat: een GET op het adres (of op <adres>/fail om een storing door te geven).
   * @param {string} url Het heartbeatadres.
   * @param {{ fail?: boolean }} [options] fail = storing doorgeven.
   * @returns {Promise<{ ok: boolean, message: string, skipped?: boolean }>} De uitkomst.
   */
  async function ping(url, { fail = false } = {}) {
    const cleanUrl = cleanHttpsUrl(url);
    if (!cleanUrl) return { ok: false, skipped: true, message: 'Geen heartbeat-adres ingesteld.' };
    const target = new URL(cleanUrl);
    if (fail) target.pathname = `${target.pathname.replace(/\/+$/, '')}/fail`;
    return request(target.href, { method: 'GET', headers: { 'User-Agent': 'AquaTech-Hub-Bewaking' } });
  }

  return { mail, webhook, ping };
}

module.exports = { sanitizeMonitoring, cleanHttpsUrl, composeNotice, createNotifier, MONITORING_DEFAULTS, THRESHOLDS, CHECK_KEY };
