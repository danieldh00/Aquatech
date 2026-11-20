// Hersteltest van de back-up op Google Drive (Beheer > Systeem > Hersteltest Google Drive), los van de lokale hersteltest
// (platform/restore-test.js). De Drive-kopieën zijn app-back-ups (backup.js) die alleen de app kan ophalen en lezen, dus deze test
// draait in de app zelf: de nieuwste back-up van Drive ophalen, ontsleutelen, inlezen in een tijdelijk schema naast de echte
// database (`openBackup`), de inhoud vergelijken met de actieve database en alles weer opruimen. De uitslag (laatste 12 runs)
// staat in de instelling `driveRestoreTest` (internal, liveOnly); er wordt niets in de actieve database geschreven.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { asSystem } = require('../database/tenant-scope');
const { listTables, schemaVersion } = require('../database/db');
const { isBackupName } = require('../backup');
const { openBackup } = require('./backup-restore');
const { DriveError } = require('./drive-backup');
const { sanitizeRun, sanitizePolicy, nextRunAt } = require('./restore-test');

const MAX_RUNS = 12;
const DEFAULT_TIME = '04:30';
const ROW_MARGIN_PCT = 0.25;
const ROW_MARGIN_MIN = 20;
const STALE_BACKUP_MS = 36 * 3600 * 1000;
const RUNNING_MAX_MS = 60 * 60 * 1000;
const TABLE_LIMIT = 10;

/**
 * Saneert de bewaarde instelling: beleid (aan/uit, dag, tijd) en de laatste runs.
 * @param {*} raw De ruwe waarde uit de database of een PUT.
 * @returns {{ enabled: boolean, day: number, time: string, runs: object[] }} De instelling met alleen bekende, begrensde velden.
 */
function sanitizeDriveRestoreTest(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const validTime = typeof input.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time);
  const policy = sanitizePolicy({ ...input, time: validTime ? input.time : DEFAULT_TIME });
  return { ...policy, runs: (Array.isArray(input.runs) ? input.runs : []).map(sanitizeRun).filter(Boolean).slice(0, MAX_RUNS) };
}

/**
 * Het laatste geplande moment van de test dat al voorbij is.
 * @param {{ day: number, time: string }} policy Het beleid.
 * @param {number} nowMs Nu (ms).
 * @returns {number} Tijdstip in ms.
 */
function lastDueAt(policy, nowMs) {
  const [hours, minutes] = policy.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(nowMs);
    candidate.setDate(candidate.getDate() - offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getDay() === policy.day && candidate.getTime() <= nowMs) return candidate.getTime();
  }
  return nowMs;
}

/**
 * Telt de rijen per tabel van een database.
 * @param {object} db Databaseverbinding (de actieve of een ingelezen back-up).
 * @param {string[]} tables Tabelnamen uit listTables (komen uit de catalogus, nooit uit invoer).
 * @returns {Object<string, number>} Aantal rijen per tabel.
 */
function countRows(db, tables) {
  const counts = {};
  for (const table of tables) counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n) || 0;
  return counts;
}

/**
 * Vergelijkt een ingelezen back-up met de actieve database en geeft de uitslag.
 * @param {object} backupDb De ingelezen back-up (tijdelijk schema).
 * @param {object} liveDb De actieve database.
 * @param {{ name: string, bytes: number, createdAt: string }} backup Gegevens van het Drive-bestand.
 * @param {number} nowMs Nu (ms).
 * @returns {object} Het resultaat: state, message, schemaVersion, tables, rows en sanity (zonder tijden).
 */
function compare(backupDb, liveDb, backup, nowMs) {
  const backupTables = listTables(backupDb);
  const liveTables = listTables(liveDb);
  const missing = liveTables.filter((table) => !backupTables.includes(table));
  const shared = liveTables.filter((table) => backupTables.includes(table));
  const backupCounts = countRows(backupDb, shared);
  const liveCounts = countRows(liveDb, shared);
  const deviating = shared
    .filter((table) => Math.abs(backupCounts[table] - liveCounts[table]) > Math.max(ROW_MARGIN_MIN, liveCounts[table] * ROW_MARGIN_PCT))
    .map((table) => ({ table, backup: backupCounts[table], production: liveCounts[table] }));
  const versions = { backup: schemaVersion(backupDb), production: schemaVersion(liveDb) };
  const sanity = [
    { name: 'Organisaties in de back-up', value: backupCounts.tenants || 0 },
    { name: 'Accounts in de back-up', value: backupCounts.users || 0 },
    { name: 'Schemaversie van de back-up', value: versions.backup },
  ].map((item) => ({ ...item, ok: item.value > 0 }));
  const remarks = [];
  let state = 'geslaagd';
  if (versions.backup > versions.production) { state = 'mislukt'; remarks.push('De back-up is van een nieuwere versie dan deze server.'); }
  if (sanity.some((item) => !item.ok)) { state = 'mislukt'; remarks.push('De teruggezette back-up mist basisgegevens.'); }
  if (state !== 'mislukt') {
    if (versions.backup < versions.production) remarks.push('De back-up heeft een oudere schemaversie.');
    if (missing.length) remarks.push(`${missing.length} tabel(len) ontbreken in de back-up.`);
    if (deviating.length) remarks.push(`${deviating.length} tabel(len) wijken sterk af van de actieve database.`);
    if (backup.createdAt && nowMs - Date.parse(backup.createdAt) > STALE_BACKUP_MS) remarks.push('De nieuwste back-up op Google Drive is ouder dan 36 uur.');
    if (remarks.length) state = 'waarschuwing';
  }
  return {
    state,
    message: remarks.length ? remarks.join(' ') : 'De back-up van Google Drive is ontsleuteld, ingelezen en komt overeen met de actieve database.',
    schemaVersion: versions,
    tables: { backup: backupTables.length, production: liveTables.length, missing: missing.slice(0, TABLE_LIMIT) },
    rows: { checked: shared.length, deviating: deviating.slice(0, TABLE_LIMIT) },
    sanity,
  };
}

/**
 * Maakt de hersteltest van de Google Drive-back-ups.
 * @param {object} options settings (instellingen van de hoofdtenant), driveBackup (platform/drive-backup.js), backupDir, vault, database (actieve database), now (alleen tests) en log.
 * @returns {object} view, setPolicy, run, due en tick.
 */
function createDriveRestoreTest({ settings, driveBackup, backupDir, vault, database, now = () => Date.now(), log = console }) {
  let running = null;
  /**
   * De bewaarde instelling.
   * @returns {object} Zie sanitizeDriveRestoreTest.
   */
  const stored = () => sanitizeDriveRestoreTest(settings.get('driveRestoreTest'));
  /**
   * Of de test kan draaien: een back-upmap en een gekoppelde Google Drive.
   * @returns {boolean} True als gekoppeld.
   */
  const configured = () => Boolean(backupDir && driveBackup.connected());

  /**
   * Alles voor het scherm en de bewaking.
   * @returns {object} configured, policy, nextRunAt, running, latest en runs.
   */
  function view() {
    const { runs, ...policy } = stored();
    return { configured: configured(), policy, nextRunAt: nextRunAt(policy, now()), running: running ? sanitizeRun(running) : null, latest: runs[0] || null, runs };
  }

  /**
   * Bewaart het beleid (de runs blijven staan).
   * @param {object} input enabled (boolean), day (0-6) en time ('HH:MM').
   * @returns {{ policy: object }|{ error: string, status: number, message: string }} Het beleid of een fout.
   */
  function setPolicy(input) {
    const body = input || {};
    if (typeof body.enabled !== 'boolean') return { error: 'invalid', status: 400, message: 'Geef aan of de test aan of uit staat.' };
    if (!Number.isInteger(body.day) || body.day < 0 || body.day > 6) return { error: 'invalid', status: 400, message: 'Kies een dag van de week.' };
    if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) return { error: 'invalid', status: 400, message: 'Geef een tijd als UU:MM.' };
    const current = stored();
    settings.update({ driveRestoreTest: { ...current, enabled: body.enabled, day: body.day, time: body.time } });
    return { policy: { enabled: body.enabled, day: body.day, time: body.time } };
  }

  /**
   * Bewaart een afgeronde run vooraan in de lijst.
   * @param {object} run De run.
   * @returns {object} De gesaneerde run.
   */
  function record(run) {
    const current = stored();
    const clean = sanitizeRun(run);
    settings.update({ driveRestoreTest: { ...current, runs: [clean, ...current.runs].slice(0, MAX_RUNS) } });
    return clean;
  }

  /**
   * Haalt de nieuwste Drive-back-up op, leest hem in een tijdelijk schema en vergelijkt hem met de actieve database.
   * @param {{ trigger: string }} options trigger: 'schema' of 'handmatig'.
   * @returns {Promise<object>} De bewaarde run (nooit een gooiende fout: een mislukking wordt een run met state mislukt).
   */
  async function execute({ trigger }) {
    const startedAt = new Date(now()).toISOString();
    const base = { state: 'mislukt', trigger, startedAt, backup: { name: '', bytes: 0, createdAt: '' } };
    let directory = '';
    let opened = null;
    try {
      const items = (await driveBackup.remote()).filter((item) => isBackupName(item.name)).sort((left, right) => right.name.localeCompare(left.name));
      if (!items.length) return record({ ...base, finishedAt: new Date(now()).toISOString(), message: 'Er staat geen back-up op Google Drive.' });
      const newest = items[0];
      directory = fs.mkdtempSync(path.join(backupDir, '.drive-restore-test-'));
      const file = await driveBackup.download(newest.name, directory);
      const backup = { name: newest.name, bytes: file.size, createdAt: file.createdTime };
      const outcome = await asSystem(async () => {
        opened = await openBackup({ dir: directory, name: newest.name, vault, current: database });
        return compare(opened.db, database, backup, now());
      });
      const finishedAt = new Date(now()).toISOString();
      return record({ ...base, ...outcome, backup, finishedAt, durationSec: Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000) });
    } catch (error) {
      const readable = error instanceof DriveError ? error.message : 'De back-up van Google Drive kon niet worden teruggezet (beschadigd bestand of verkeerde sleutel).';
      log.warn(`Hersteltest Google Drive mislukt: ${error && error.message}`);
      return record({ ...base, finishedAt: new Date(now()).toISOString(), message: readable });
    } finally {
      if (opened) { try { opened.close(); } catch (error) { log.warn(`Hersteltest Google Drive: tijdelijk schema wissen mislukt: ${error.message}`); } }
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  /**
   * Start een test op de achtergrond (één tegelijk).
   * @param {object} [options] trigger ('schema' of 'handmatig').
   * @returns {{ started: true, done: Promise<object> }|{ error: string, status: number, message: string }} De lopende test of een fout.
   */
  function run({ trigger = 'handmatig' } = {}) {
    if (!configured()) return { error: 'not_configured', status: 409, message: 'Google Drive is niet gekoppeld.' };
    if (running && now() - Date.parse(running.startedAt) < RUNNING_MAX_MS) return { error: 'busy', status: 409, message: 'Er loopt al een hersteltest van Google Drive.' };
    const mine = { state: 'bezig', trigger, startedAt: new Date(now()).toISOString() };
    running = mine;
    const done = execute({ trigger })
      .catch((error) => { log.warn(`Hersteltest Google Drive: ${error.message}`); return null; })
      .finally(() => { if (running === mine) running = null; });
    return { started: true, done };
  }

  /**
   * Of er nu een geplande test aan de beurt is: aan, Drive gekoppeld, niet al bezig en sinds het laatste geplande moment nog niet gedraaid.
   * @returns {boolean} True als er gedraaid moet worden.
   */
  function due() {
    const { runs, ...policy } = stored();
    if (!policy.enabled || !configured() || running) return false;
    if (!runs.length) return true;
    return Date.parse(runs[0].startedAt) < lastDueAt(policy, now());
  }

  /**
   * Draait de test als hij aan de beurt is (uurlijks vanuit het onderhoud).
   * @returns {Promise<object|null>} De run, of null als er niets te doen was.
   */
  async function tick() {
    if (!due()) return null;
    const out = run({ trigger: 'schema' });
    return out.done || null;
  }

  return { view, setPolicy, run, due, tick };
}

module.exports = { createDriveRestoreTest, sanitizeDriveRestoreTest, lastDueAt };
