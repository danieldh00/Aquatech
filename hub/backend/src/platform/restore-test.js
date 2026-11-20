// Wekelijkse hersteltest van de back-up (Beheer > Systeem > Hersteltest). De app voert de test niet zelf uit: het
// hostscript deploy/apps01/restore-test.sh zet de nieuwste PostgreSQL-dump terug in een wegwerp-Docker-container,
// controleert de uitkomst en schrijft de uitslag. Gegevens lopen via dezelfde twee mappen als de systeemupdate:
//
// - statusmap (UPDATE_STATUS_DIR, alleen-lezen): `restore-test.json` met de lopende run en de historie;
// - aanvraagmap (UPDATE_REQUEST_DIR, alleen deze is schrijfbaar): `restore-test.json` (instelling: aan/uit, dag, tijd)
//   en `restore-test-now.json` (het signaal "nu testen"; een path-unit op de host start het script).
//
// Alles uit de statusmap wordt gesaneerd; het hostscript vertrouwt de aanvraagmap evenmin.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJsonFile, writeJsonFile, cleanTime, cleanText } = require('./system-update');

const STATES = ['bezig', 'geslaagd', 'waarschuwing', 'mislukt'];
const TRIGGERS = ['schema', 'handmatig'];
const DEFAULT_POLICY = { enabled: true, day: 0, time: '03:30' };
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const RUNNING_MAX_MS = 60 * 60 * 1000;
const MAX_RUNS = 12;
const LIMITS = { name: 120, message: 300, table: 64, list: 10 };

/**
 * Een niet-negatief geheel getal, anders 0.
 * @param {*} value Invoer.
 * @returns {number} Het getal.
 */
function cleanCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), 1e12) : 0;
}

/**
 * Een tabelnaam in het vaste formaat, anders null.
 * @param {*} value Invoer.
 * @returns {string|null} De naam.
 */
function cleanTable(value) {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) ? value : null;
}

/**
 * Saneert één run uit restore-test.json van de host.
 * @param {object|null} raw De ruwe run.
 * @returns {object|null} De run met alleen bekende, begrensde velden, of null.
 */
function sanitizeRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const state = STATES.includes(raw.state) ? raw.state : null;
  const startedAt = cleanTime(raw.startedAt);
  if (!state || !startedAt) return null;
  const backup = raw.backup && typeof raw.backup === 'object' ? raw.backup : {};
  const versions = raw.schemaVersion && typeof raw.schemaVersion === 'object' ? raw.schemaVersion : {};
  const tables = raw.tables && typeof raw.tables === 'object' ? raw.tables : {};
  const rows = raw.rows && typeof raw.rows === 'object' ? raw.rows : {};
  return {
    state,
    trigger: TRIGGERS.includes(raw.trigger) ? raw.trigger : 'schema',
    startedAt,
    finishedAt: cleanTime(raw.finishedAt),
    durationSec: cleanCount(raw.durationSec),
    backup: { name: cleanText(backup.name, LIMITS.name), bytes: cleanCount(backup.bytes), createdAt: cleanTime(backup.createdAt) },
    schemaVersion: { backup: cleanCount(versions.backup), production: cleanCount(versions.production) },
    tables: {
      backup: cleanCount(tables.backup),
      production: cleanCount(tables.production),
      missing: (Array.isArray(tables.missing) ? tables.missing : []).map(cleanTable).filter(Boolean).slice(0, LIMITS.list),
    },
    rows: {
      checked: cleanCount(rows.checked),
      deviating: (Array.isArray(rows.deviating) ? rows.deviating : [])
        .map((item) => ({ table: cleanTable(item && item.table), backup: cleanCount(item && item.backup), production: cleanCount(item && item.production) }))
        .filter((item) => item.table)
        .slice(0, LIMITS.list),
    },
    sanity: (Array.isArray(raw.sanity) ? raw.sanity : [])
      .map((item) => ({ name: cleanText(item && item.name, LIMITS.name), value: cleanCount(item && item.value), ok: Boolean(item && item.ok === true) }))
      .filter((item) => item.name)
      .slice(0, LIMITS.list),
    message: cleanText(raw.message, LIMITS.message),
  };
}

/**
 * Saneert de instelling uit de aanvraagmap (of de standaard).
 * @param {object|null} raw De ruwe instelling.
 * @returns {{ enabled: boolean, day: number, time: string }} De instelling (dag 0 = zondag … 6 = zaterdag).
 */
function sanitizePolicy(raw) {
  const policy = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: policy.enabled !== false,
    day: Number.isInteger(policy.day) && policy.day >= 0 && policy.day <= 6 ? policy.day : DEFAULT_POLICY.day,
    time: typeof policy.time === 'string' && TIME_PATTERN.test(policy.time) ? policy.time : DEFAULT_POLICY.time,
  };
}

/**
 * Het eerstvolgende geplande moment van de test.
 * @param {{ enabled: boolean, day: number, time: string }} policy De instelling.
 * @param {number} nowMs Nu (ms).
 * @returns {string|null} ISO-tijdstip, of null als de test uit staat.
 */
function nextRunAt(policy, nowMs) {
  if (!policy.enabled) return null;
  const [hours, minutes] = policy.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(nowMs);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getDay() === policy.day && candidate.getTime() > nowMs) return candidate.toISOString();
  }
  return null;
}

/**
 * Koppeling met het hostscript van de hersteltest.
 * @param {object} options statusDir, requestDir en now (functie, alleen voor tests).
 * @returns {object} configured, view, setPolicy, requestRun en policy.
 */
function createRestoreTest({ statusDir = '', requestDir = '', now = () => Date.now() } = {}) {
  const configured = Boolean(statusDir && requestDir);

  /**
   * De instelling uit de aanvraagmap.
   * @returns {{ enabled: boolean, day: number, time: string }} De instelling.
   */
  function policy() {
    return sanitizePolicy(configured ? readJsonFile(requestDir, 'restore-test.json') : null);
  }

  /**
   * Alles voor het scherm en de bewaking.
   * @returns {object} configured, policy, nextRunAt, running, latest, runs en requested.
   */
  function view() {
    const current = policy();
    if (!configured) return { configured: false, policy: current, nextRunAt: null, running: null, latest: null, runs: [], requested: false };
    const raw = readJsonFile(statusDir, 'restore-test.json') || {};
    const runs = (Array.isArray(raw.runs) ? raw.runs : []).map(sanitizeRun).filter(Boolean).slice(0, MAX_RUNS);
    let running = sanitizeRun(raw.running);
    // Hard gestopt script (stroomuitval): de run blijft op bezig staan. Na een uur telt dat als onderbroken.
    if (running && running.state === 'bezig' && now() - Date.parse(running.startedAt) > RUNNING_MAX_MS) {
      runs.unshift({ ...running, state: 'mislukt', finishedAt: new Date(Date.parse(running.startedAt) + RUNNING_MAX_MS).toISOString(), message: 'De hersteltest is onderbroken. Controleer de server.' });
      running = null;
    }
    const requested = fs.existsSync(path.join(requestDir, 'restore-test-now.json'));
    return { configured: true, policy: current, nextRunAt: nextRunAt(current, now()), running, latest: runs[0] || null, runs, requested };
  }

  /**
   * Bewaart de instelling voor het hostscript.
   * @param {object} input enabled (boolean), day (0-6) en time ('HH:MM').
   * @returns {{ policy: object }|{ error: string, status: number, message: string }} De instelling of een fout.
   */
  function setPolicy(input) {
    if (!configured) return { error: 'not_configured', status: 501, message: 'De hersteltest is op deze server niet ingericht (servertaak).' };
    const body = input || {};
    if (typeof body.enabled !== 'boolean') return { error: 'invalid', status: 400, message: 'Geef aan of de hersteltest aan of uit staat.' };
    if (!Number.isInteger(body.day) || body.day < 0 || body.day > 6) return { error: 'invalid', status: 400, message: 'Kies een dag van de week.' };
    if (typeof body.time !== 'string' || !TIME_PATTERN.test(body.time)) return { error: 'invalid', status: 400, message: 'Geef een tijd als UU:MM.' };
    const next = { enabled: body.enabled, day: body.day, time: body.time };
    writeJsonFile(requestDir, 'restore-test.json', next);
    return { policy: next };
  }

  /**
   * Vraagt de host om nu een hersteltest te draaien.
   * @param {object} input userId en byName (wie).
   * @returns {{ requested: true }|{ error: string, status: number, message: string }} Gelukt of een fout.
   */
  function requestRun({ userId, byName } = {}) {
    if (!configured) return { error: 'not_configured', status: 501, message: 'De hersteltest is op deze server niet ingericht (servertaak).' };
    const current = view();
    if (current.running || current.requested) return { error: 'busy', status: 409, message: 'Er loopt al een hersteltest of er staat er een aangevraagd.' };
    writeJsonFile(requestDir, 'restore-test-now.json', { id: crypto.randomUUID(), requestedAt: new Date(now()).toISOString(), by: String(userId || ''), byName: cleanText(byName, 80) });
    return { requested: true };
  }

  return { configured, view, policy, setPolicy, requestRun };
}

module.exports = { createRestoreTest, sanitizeRun, sanitizePolicy, nextRunAt, DEFAULT_POLICY };
