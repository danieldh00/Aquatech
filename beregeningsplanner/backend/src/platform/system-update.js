// Systeemupdate vanuit de app: Beheer toont welke versie klaarstaat (met de releasenotes) en een beheerder van de
// hoofdtenant start met "Nu updaten" de uitrol. De app zelf rolt niets uit: ze heeft geen Docker-socket en geen
// rootrechten. Ze praat met het hostscript (deploy/apps01/update.sh) via twee gedeelde mappen:
//
// - statusmap (UPDATE_STATUS_DIR, in de container alleen-lezen): het hostscript schrijft hier
//   `status.json` (draaiende en beschikbare versie, laatst gecontroleerd), `run.json` (stand van de laatste uitrol),
//   `releases.json` (releasenotes van de beschikbare versie, uit het nieuwe image) en `maintenance.json` (bestaat
//   zolang de uitrol loopt).
// - aanvraagmap (UPDATE_REQUEST_DIR, alleen deze map is voor de app schrijfbaar): de app schrijft hier
//   `request.json` (het signaal "installeer versie X") en `policy.json` (automatisch bijwerken aan/uit).
//   Een systemd-path-unit op de host start het script zodra `request.json` verschijnt.
//
// De app vertrouwt de statusbestanden niet blind (alles wordt gesaneerd) en het hostscript vertrouwt de aanvraag
// niet: het installeert alleen de versie die het zelf uit GHCR heeft gehaald, en leest geen symlinks.
// Onderhoudsmodus: zolang `maintenance.json` bestaat, weigert de server schrijfverzoeken (503), zodat er tijdens
// het wisselen van de container niets half wordt opgeslagen. Een vergeten bestand telt na MAINTENANCE_MAX_MS niet meer.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const STATES = ['idle', 'bezig', 'geslaagd', 'mislukt', 'geweigerd'];
const STEPS = ['ophalen', 'onderhoud', 'back-up', 'herstarten', 'controleren', 'terugzetten', 'klaar'];
const MAX_FILE_BYTES = 256 * 1024;
const MAINTENANCE_MAX_MS = 30 * 60 * 1000;
const CACHE_MS = 2000;
const LIMITS = { releases: 30, items: 20, title: 200, text: 1000, message: 300 };

/**
 * Vergelijkt twee versienummers ('1.9.0' < '1.10.0').
 * @param {string} left Eerste versie.
 * @param {string} right Tweede versie.
 * @returns {number} Negatief, 0 of positief (zoals bij sort).
 */
function compareVersions(left, right) {
  const leftParts = String(left || '0').split('.').map(Number);
  const rightParts = String(right || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((leftParts[i] || 0) !== (rightParts[i] || 0)) return (leftParts[i] || 0) - (rightParts[i] || 0);
  return 0;
}

/**
 * Een versienummer als het geldig is, anders null.
 * @param {*} value Invoer.
 * @returns {string|null} Bijv. '1.14.2'.
 */
function cleanVersion(value) {
  return typeof value === 'string' && VERSION.test(value) ? value : null;
}

/**
 * Een ISO-tijdstip als het geldig is, anders null.
 * @param {*} value Invoer.
 * @returns {string|null} Tijdstip als ISO-tekst.
 */
function cleanTime(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * Korte tekst zonder stuurtekens, afgekapt.
 * @param {*} value Invoer.
 * @param {number} max Maximale lengte.
 * @returns {string} De tekst (leeg bij geen tekst).
 */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/**
 * Leest een klein JSON-bestand uit een gedeelde map. Een symlink, een te groot of kapot bestand telt als afwezig.
 * @param {string} dir De map.
 * @param {string} name Bestandsnaam.
 * @returns {object|null} De inhoud, of null.
 */
function readJsonFile(dir, name) {
  const file = path.join(dir, name);
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

/**
 * Schrijft een JSON-bestand in één keer (eerst een tijdelijk bestand, dan hernoemen), zodat de host nooit een half
 * bestand leest.
 * @param {string} dir De map.
 * @param {string} name Bestandsnaam.
 * @param {object} value De inhoud.
 * @returns {void}
 */
function writeJsonFile(dir, name, value) {
  const temp = path.join(dir, `.${name}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temp, path.join(dir, name));
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Saneert de releasenotes die de host uit het nieuwe image heeft gehaald (zie tools/release-info.js).
 * @param {object|null} raw Inhoud van releases.json.
 * @returns {{ version: string|null, releases: object[] }} Versie waarvoor de notes gelden en de versies (nieuwste eerst).
 */
function sanitizeReleases(raw) {
  const list = raw && Array.isArray(raw.releases) ? raw.releases : [];
  const releases = list.slice(0, LIMITS.releases).map((release) => ({
    version: cleanVersion(release && release.version),
    date: cleanText(release && release.date, 10),
    title: cleanText(release && release.title, LIMITS.title),
    items: (release && Array.isArray(release.items) ? release.items : []).slice(0, LIMITS.items)
      .map((item) => cleanText(item && typeof item === 'object' ? item.text : item, LIMITS.text)).filter(Boolean),
  })).filter((release) => release.version);
  return { version: cleanVersion(raw && raw.version), releases };
}

/**
 * Saneert de stand van de host (status.json en run.json samen).
 * @param {object|null} raw Inhoud van status.json met die van run.json eroverheen.
 * @returns {object} current, available, checkedAt, state, step, version, requestId, startedAt, finishedAt, message, automatic.
 */
function sanitizeStatus(raw) {
  const source = raw || {};
  return {
    current: cleanVersion(source.current),
    available: cleanVersion(source.available),
    checkedAt: cleanTime(source.checkedAt),
    state: STATES.includes(source.state) ? source.state : 'idle',
    step: STEPS.includes(source.step) ? source.step : null,
    version: cleanVersion(source.version),
    requestId: typeof source.requestId === 'string' && /^[0-9a-f-]{36}$/.test(source.requestId) ? source.requestId : null,
    startedAt: cleanTime(source.startedAt),
    finishedAt: cleanTime(source.finishedAt),
    message: cleanText(source.message, LIMITS.message),
    automatic: source.automatic === true,
  };
}

/**
 * Maakt de koppeling met het hostscript.
 * @param {object} options statusDir en requestDir (leeg = niet ingericht op deze server), currentVersion (de draaiende
 *   versie volgens package.json) en now (klok, voor tests).
 * @returns {object} configured, maintenance, view, request, cancel, setAuto, auto en finishedRun.
 */
function createSystemUpdate({ statusDir = '', requestDir = '', currentVersion, now = () => Date.now() }) {
  const configured = Boolean(statusDir && requestDir);
  let maintenanceCache = { at: 0, value: { active: false } };

  /**
   * Leest status.json (controle) en run.json (laatste uitrol) van de host en saneert ze samen.
   * @returns {object} Zie sanitizeStatus.
   */
  function hostStatus() {
    return sanitizeStatus({ ...(readJsonFile(statusDir, 'status.json') || {}), ...(readJsonFile(statusDir, 'run.json') || {}) });
  }

  /**
   * De onderhoudsmodus: aan zolang de host maintenance.json heeft neergezet (en dat niet ouder is dan een half uur).
   * Twee seconden in het geheugen, want elke schrijfactie vraagt erom.
   * @returns {{ active: boolean, since?: string, version?: string|null }} De stand.
   */
  function maintenance() {
    if (!configured) return { active: false };
    const time = now();
    if (time - maintenanceCache.at < CACHE_MS) return maintenanceCache.value;
    const raw = readJsonFile(statusDir, 'maintenance.json');
    let value = { active: false };
    if (raw) {
      const since = cleanTime(raw.since);
      // Zonder geldig tijdstip of te oud: een achtergebleven bestand (host vastgelopen) zet de site niet blijvend op slot.
      if (since && time - Date.parse(since) < MAINTENANCE_MAX_MS) value = { active: true, since, version: cleanVersion(raw.version) };
    }
    maintenanceCache = { at: time, value };
    return value;
  }

  /**
   * De openstaande aanvraag van de app (nog niet door de host opgepakt).
   * @returns {object|null} id, version, requestedAt, by (naam), of null.
   */
  function pending() {
    if (!configured) return null;
    const raw = readJsonFile(requestDir, 'request.json');
    if (!raw || !cleanVersion(raw.version)) return null;
    return { id: String(raw.id || ''), version: raw.version, requestedAt: cleanTime(raw.requestedAt), by: cleanText(raw.byName, 80) };
  }

  /**
   * Automatisch bijwerken (de timer installeert een nieuwe versie zelf): standaard aan, zoals vroeger.
   * @returns {boolean} true als het aan staat.
   */
  function auto() {
    if (!configured) return true;
    const raw = readJsonFile(requestDir, 'policy.json');
    return !(raw && raw.auto === false);
  }

  /**
   * Alles voor het scherm in Beheer.
   * @returns {object} configured, running, available, newer, releases, status, pending, auto en maintenance.
   */
  function view() {
    if (!configured) return { configured: false, running: currentVersion };
    const status = hostStatus();
    const notes = sanitizeReleases(readJsonFile(statusDir, 'releases.json'));
    const newer = Boolean(status.available && compareVersions(status.available, currentVersion) > 0);
    // Alleen de notes van de versies tussen de draaiende en de beschikbare versie.
    const releases = newer && notes.version === status.available
      ? notes.releases.filter((release) => compareVersions(release.version, currentVersion) > 0 && compareVersions(release.version, status.available) <= 0)
      : [];
    return { configured: true, running: currentVersion, available: status.available, newer, releases, status, pending: pending(), auto: auto(), maintenance: maintenance() };
  }

  /**
   * Zet de aanvraag "installeer deze versie" klaar voor de host.
   * @param {object} input version (moet de beschikbare versie zijn), userId en byName (wie).
   * @returns {{ request: object }|{ error: string, status: number, message: string }} De aanvraag of een fout.
   */
  function request({ version, userId, byName }) {
    if (!configured) return { error: 'not_configured', status: 501, message: 'Updaten vanuit de app is op deze server niet ingericht.' };
    const current = view();
    if (current.maintenance.active || current.status.state === 'bezig') return { error: 'busy', status: 409, message: 'Er loopt al een update.' };
    if (current.pending) return { error: 'pending', status: 409, message: 'De update is al aangevraagd en start zo.' };
    if (!current.newer) return { error: 'no_update', status: 409, message: 'Er is geen nieuwere versie beschikbaar.' };
    if (cleanVersion(version) !== current.available) return { error: 'version_changed', status: 409, message: 'Er staat intussen een andere versie klaar. Vernieuw de pagina.' };
    const entry = { id: crypto.randomUUID(), version: current.available, requestedAt: new Date(now()).toISOString(), by: String(userId || ''), byName: cleanText(byName, 80) };
    writeJsonFile(requestDir, 'request.json', entry);
    return { request: entry };
  }

  /**
   * Trekt een aanvraag in die de host nog niet heeft opgepakt.
   * @returns {boolean} true als er een aanvraag was.
   */
  function cancel() {
    if (!configured || !pending()) return false;
    fs.rmSync(path.join(requestDir, 'request.json'), { force: true });
    return true;
  }

  /**
   * Zet automatisch bijwerken aan of uit (de host leest policy.json bij elke ronde).
   * @param {boolean} enabled true = aan.
   * @returns {void}
   */
  function setAuto(enabled) {
    if (!configured) throw Object.assign(new Error('Updaten vanuit de app is op deze server niet ingericht.'), { status: 501 });
    writeJsonFile(requestDir, 'policy.json', { auto: enabled === true });
  }

  /**
   * Een afgeronde uitrol die nog niet in het auditlog staat (één keer per afronding; de app onthoudt in de
   * aanvraagmap welke al is vastgelegd).
   * @returns {object|null} De status van die uitrol, of null.
   */
  function finishedRun() {
    if (!configured) return null;
    const status = hostStatus();
    if (!['geslaagd', 'mislukt', 'geweigerd'].includes(status.state) || !status.finishedAt) return null;
    const key = `${status.finishedAt}|${status.requestId || ''}`;
    const seen = readJsonFile(requestDir, 'audited.json');
    if (seen && seen.key === key) return null;
    try {
      writeJsonFile(requestDir, 'audited.json', { key });
    } catch (error) {
      return null; // niet kunnen onthouden: liever niet vastleggen dan bij elke vraag opnieuw
    }
    return status;
  }

  return { configured, maintenance, view, request, cancel, setAuto, auto, finishedRun };
}

module.exports = { createSystemUpdate, compareVersions, sanitizeStatus, sanitizeReleases, MAINTENANCE_MAX_MS };
