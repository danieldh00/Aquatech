// Tests van de controles van de bewaking (platform/monitoring-checks.js) met nepafhankelijkheden: elke controle
// ok, waarschuwing, fout en overslaan, de drempels, de cache van dure externe controles en geen geheimen in meldingen.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createMonitoringChecks, thresholdsOf, DEFAULT_THRESHOLDS } = require('../src/platform/monitoring-checks');
const { createErrorCounter } = require('../src/platform/error-report');

const NOW = Date.parse('2026-11-13T12:00:00Z');
const HOUR = 3600 * 1000;
const TENANT = 't1';

/**
 * Zoekt een controle op sleutel en voert hem uit.
 * @param {object[]} checks De controles.
 * @param {string} key De sleutel.
 * @param {object} [config] De instelling `monitoring`.
 * @param {number} [now] Het tijdstip in ms.
 * @returns {Promise<object>} De uitkomst.
 */
const runCheck = (checks, key, config = {}, now = NOW) => {
  const check = checks.find((entry) => entry.key === key);
  assert.ok(check, `controle ${key} bestaat`);
  return check.run({ tenantId: TENANT, scope: check.scope, config, now: () => now });
};

/**
 * Nep-instellingen van een omgeving.
 * @param {object} values Waarden per sleutel.
 * @returns {object} Object met get.
 */
const settingsOf = (values) => ({ get: (key) => values[key] });

test('thresholdsOf valt terug op de standaard bij ontbrekende of onbruikbare waarden', () => {
  assert.deepStrictEqual(thresholdsOf({}), DEFAULT_THRESHOLDS);
  assert.strictEqual(thresholdsOf({ thresholds: { backupMaxHours: 12 } }).backupMaxHours, 12);
  assert.strictEqual(thresholdsOf({ thresholds: { backupMaxHours: 'x' } }).backupMaxHours, DEFAULT_THRESHOLDS.backupMaxHours);
});

test('zonder afhankelijkheden worden controles niet aangemaakt', () => {
  assert.deepStrictEqual(createMonitoringChecks({ runtimeStats: false }), []);
});

test('database: ok, trage reactie en fout', async () => {
  const db = openDb();
  const checks = createMonitoringChecks({ db, runtimeStats: false });
  assert.deepStrictEqual(await runCheck(checks, 'database'), { ok: true });
  let tick = 0;
  const slow = checks.find((check) => check.key === 'database');
  const result = await slow.run({ tenantId: TENANT, scope: 'platform', config: {}, now: () => (tick += 5000) });
  assert.strictEqual(result.severity, 'waarschuwing');
  const broken = createMonitoringChecks({ db: { prepare: () => { throw new Error('weg met password=geheim99'); } }, runtimeStats: false });
  const failed = await runCheck(broken, 'database');
  assert.strictEqual(failed.severity, 'fout');
  assert.ok(!/geheim99/.test(failed.message));
});

test('schijf: ruim genoeg, weinig ruimte en erg weinig ruimte; ontbrekende map = overslaan', async () => {
  /**
   * Een nepmeting van de schijf.
   * @param {*} freePct Percentage vrij.
   * @returns {*} De meting.
   */
  const space = (freePct) => ({ bsize: 4096, blocks: 1000000, bavail: Math.round(10000 * freePct) });
  /**
   * Maakt de schijfcontrole met een nepmeting.
   * @param {*} freePct Percentage vrij.
   * @returns {*} De controles.
   */
  const make = (freePct) => createMonitoringChecks({ dataDir: '/data', statfs: () => space(freePct), runtimeStats: false });
  assert.deepStrictEqual(await runCheck(make(50), 'schijf'), { ok: true });
  const low = await runCheck(make(8), 'schijf', { thresholds: { diskMinFreeMb: 0 } });
  assert.strictEqual(low.severity, 'waarschuwing');
  const veryLow = await runCheck(make(2), 'schijf', { thresholds: { diskMinFreeMb: 0 } });
  assert.strictEqual(veryLow.severity, 'fout');
  const missing = createMonitoringChecks({ dataDir: '/weg', statfs: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, runtimeStats: false });
  assert.deepStrictEqual(await runCheck(missing, 'schijf'), { skip: true });
});

test('back-up: recent ok, te oud fout, geen back-up fout, uitgezet = overslaan', async () => {
  /**
   * Maakt de back-upcontrole met nepback-ups.
   * @param {*} backups De lijst back-ups.
   * @param {*} keepDays Instelling backupKeepDays.
   * @returns {*} De controles.
   */
  const build = (backups, keepDays = 14) => createMonitoringChecks({
    backupDir: '/b', listBackups: () => backups, settingsFor: () => settingsOf({ backupKeepDays: keepDays }), runtimeStats: false,
  });
  const fresh = [{ name: 'a', createdAt: new Date(NOW - 5 * HOUR).toISOString() }];
  const old = [{ name: 'a', createdAt: new Date(NOW - 80 * HOUR).toISOString() }];
  assert.deepStrictEqual(await runCheck(build(fresh), 'backup'), { ok: true });
  assert.strictEqual((await runCheck(build(old), 'backup')).severity, 'fout');
  assert.strictEqual((await runCheck(build([]), 'backup')).severity, 'fout');
  assert.deepStrictEqual(await runCheck(build(old, 0), 'backup'), { skip: true });
  assert.deepStrictEqual(await runCheck(build(old), 'backup', { thresholds: { backupMaxHours: 100 } }), { ok: true });
});

test('update: mislukt = fout, geweigerd recent = waarschuwing, niet ingericht = overslaan', async () => {
  /**
   * Maakt de updatecontrole met een nepweergave.
   * @param {*} view De weergave van de systeemupdate.
   * @returns {*} De controles.
   */
  const build = (view) => createMonitoringChecks({ systemUpdate: { view: () => view }, runtimeStats: false });
  assert.deepStrictEqual(await runCheck(build({ configured: false }), 'update'), { skip: true });
  assert.strictEqual((await runCheck(build({ configured: true, status: { state: 'mislukt', version: '1.2.3', message: 'x' } }), 'update')).severity, 'fout');
  const refused = { configured: true, status: { state: 'geweigerd', finishedAt: new Date(NOW - HOUR).toISOString() } };
  assert.strictEqual((await runCheck(build(refused), 'update')).severity, 'waarschuwing');
  const stale = { configured: true, status: { state: 'ok', checkedAt: new Date(NOW - 30 * HOUR).toISOString() } };
  assert.strictEqual((await runCheck(build(stale), 'update')).severity, 'waarschuwing');
  const fine = { configured: true, status: { state: 'ok', checkedAt: new Date(NOW - HOUR).toISOString() } };
  assert.deepStrictEqual(await runCheck(build(fine), 'update'), { ok: true });
});

test('runtime en serverfouten gebruiken de drempels', async () => {
  /**
   * Maakt de runtimecontrole met nepmetingen.
   * @param {*} stats De metingen.
   * @returns {*} De controles.
   */
  const runtime = (stats) => createMonitoringChecks({ runtimeStats: () => stats });
  assert.deepStrictEqual(await runCheck(runtime({ eventLoopP99Ms: 10, heapUsedPct: 20 }), 'runtime'), { ok: true });
  assert.strictEqual((await runCheck(runtime({ eventLoopP99Ms: 5000, heapUsedPct: 20 }), 'runtime')).severity, 'waarschuwing');
  assert.strictEqual((await runCheck(runtime({ eventLoopP99Ms: 1, heapUsedPct: 95 }), 'runtime')).severity, 'waarschuwing');
  const counter = createErrorCounter();
  const checks = createMonitoringChecks({ errorCounter: counter, runtimeStats: false });
  assert.deepStrictEqual(await runCheck(checks, 'serverfouten', { thresholds: { errorsPerHour: 5 } }, Date.now()), { ok: true });
  for (let i = 0; i < 8; i++) counter.add();
  assert.strictEqual((await runCheck(checks, 'serverfouten', { thresholds: { errorsPerHour: 5 } }, Date.now())).severity, 'waarschuwing');
  for (let i = 0; i < 20; i++) counter.add();
  assert.strictEqual((await runCheck(checks, 'serverfouten', { thresholds: { errorsPerHour: 5 } }, Date.now())).severity, 'fout');
});

test('drive: opnieuw verbinden, mislukte upload, verouderd, ok en uit', async () => {
  /**
   * Maakt de Drive-controle met een nepstatus.
   * @param {*} status De status van de Drive-back-up.
   * @returns {*} De controles.
   */
  const build = (status) => createMonitoringChecks({ driveBackup: { status: () => status }, runtimeStats: false });
  const base = { config: { enabled: true }, connected: true };
  assert.deepStrictEqual(await runCheck(build({ config: { enabled: false }, connected: false }), 'drive'), { skip: true });
  assert.strictEqual((await runCheck(build({ ...base, needsReconnect: true }), 'drive')).severity, 'fout');
  assert.strictEqual((await runCheck(build({ ...base, lastFailAt: '2026-11-13T10:00:00Z', lastOkAt: '2026-11-12T10:00:00Z' }), 'drive')).severity, 'waarschuwing');
  assert.strictEqual((await runCheck(build({ ...base, lastFailAt: '2026-11-13T10:00:00Z', lastOkAt: '2026-11-10T10:00:00Z', stale: true }), 'drive')).severity, 'fout');
  assert.strictEqual((await runCheck(build({ ...base, stale: true }), 'drive')).severity, 'waarschuwing');
  assert.deepStrictEqual(await runCheck(build({ ...base, lastOkAt: '2026-11-13T10:00:00Z' }), 'drive'), { ok: true });
});

test('mail: verify wordt hoogstens eens per uur gedaan en een fout is een melding', async () => {
  let verifies = 0;
  let fail = false;
  const mailer = { configured: () => true, verify: async () => { verifies++; if (fail) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ESOCKET' }); } };
  const checks = createMonitoringChecks({ settingsFor: () => settingsOf({ mailServer: { host: 'mail.example.nl' } }), mailerFor: () => mailer, runtimeStats: false });
  assert.deepStrictEqual(await runCheck(checks, 'mail'), { ok: true });
  await runCheck(checks, 'mail', {}, NOW + 10 * 60000);
  assert.strictEqual(verifies, 1, 'binnen een uur uit de cache');
  fail = true;
  const failed = await runCheck(checks, 'mail', {}, NOW + 2 * HOUR);
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.severity, 'fout');
  const unconfigured = createMonitoringChecks({ settingsFor: () => settingsOf({}), mailerFor: () => ({ configured: () => false, verify: async () => {} }), runtimeStats: false });
  assert.deepStrictEqual(await runCheck(unconfigured, 'mail'), { skip: true });
});

test('mollie: uit = overslaan, sleutel geweigerd = fout, onbereikbaar = waarschuwing, cache per sleutel', async () => {
  let calls = 0;
  let mode = 'ok';
  const mollie = {
    /**
     * Nep-Mollie: controleert de sleutel en geeft de ingestelde uitkomst.
     * @returns {*} Niets, of een fout.
     */
    checkKey: async () => {
      calls++;
      if (mode === 'auth') throw Object.assign(new Error('x'), { status: 401 });
      if (mode === 'down') throw Object.assign(new Error('x'), { status: 0 });
    },
  };
  const settings = { shopPayment: { online: true, publicUrl: 'https://shop.example.nl' }, mollieApiKey: 'test_abcdefghijklmnopqrstuvwxyz123456' };
  const checks = createMonitoringChecks({ settingsFor: () => settingsOf(settings), mollie, runtimeStats: false });
  assert.deepStrictEqual(await runCheck(checks, 'mollie'), { ok: true });
  await runCheck(checks, 'mollie', {}, NOW + 1000);
  assert.strictEqual(calls, 1);
  mode = 'auth';
  assert.strictEqual((await runCheck(checks, 'mollie', {}, NOW + 2 * HOUR)).severity, 'fout');
  mode = 'down';
  assert.strictEqual((await runCheck(checks, 'mollie', {}, NOW + 4 * HOUR)).severity, 'waarschuwing');
  const off = createMonitoringChecks({ settingsFor: () => settingsOf({}), mollie, runtimeStats: false });
  assert.deepStrictEqual(await runCheck(off, 'mollie'), { skip: true });
  const noKey = createMonitoringChecks({ settingsFor: () => settingsOf({ shopPayment: { online: true } }), mollie, runtimeStats: false });
  assert.strictEqual((await runCheck(noKey, 'mollie')).severity, 'fout');
});

test('visma: aanmeldfout, herhaalde fouten, hersteld en tenant-filter', async () => {
  const db = openDb();
  for (const [id, slug] of [[TENANT, 'a'], ['t2', 'b']]) db.prepare("INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, '2026-01-01')").run(id, slug, slug);
  let sequence = 0;
  /**
   * Voegt een regel aan het Visma-logboek toe.
   * @param {*} tenantId De omgeving.
   * @param {*} kind Soort regel.
   * @param {*} ok Of het gelukt is.
   * @param {*} hoursAgo Hoeveel uur geleden.
   * @param {*} reference Verwijzing.
   * @param {*} repeat Aantal herhalingen.
   * @returns {*} Het resultaat van de insert.
   */
  const log = (tenantId, kind, ok, hoursAgo, reference = '', repeat = 1) => db.prepare(
    'INSERT INTO visma_log (id, tenant_id, created_at, last_at, kind, ok, reference, message, repeat_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(`l${sequence++}`, tenantId, new Date(NOW - hoursAgo * HOUR).toISOString(), new Date(NOW - hoursAgo * HOUR).toISOString(), kind, ok ? 1 : 0, reference, 'fout', repeat);
  const checks = createMonitoringChecks({ db, visma: { connected: (id) => id === TENANT }, runtimeStats: false });
  assert.deepStrictEqual(await runCheck(checks, 'visma'), { ok: true });
  log(TENANT, 'factuur', false, 2, 'F1', 3);
  assert.strictEqual((await runCheck(checks, 'visma')).severity, 'waarschuwing');
  log(TENANT, 'factuur', true, 1, 'F1');
  assert.deepStrictEqual(await runCheck(checks, 'visma'), { ok: true }, 'daarna gelukt voor hetzelfde onderdeel');
  log(TENANT, 'aanmelding', false, 0.5);
  assert.strictEqual((await runCheck(checks, 'visma')).severity, 'fout');
  const other = await checks.find((check) => check.key === 'visma').run({ tenantId: 't2', scope: 'tenant', config: {}, now: () => NOW });
  assert.deepStrictEqual(other, { skip: true });
});

test('webshop: nooit gesynchroniseerd, fout, te oud en ok', async () => {
  /**
   * Maakt de webshopcontrole met een nepstatus.
   * @param {*} status De syncstatus.
   * @param {*} source De instelling shopSource.
   * @returns {*} De controles.
   */
  const build = (status, source = { url: 'https://shop.example.nl' }) => createMonitoringChecks({
    settingsFor: () => settingsOf({ shopSource: source }), shop: { status: () => status }, runtimeStats: false,
  });
  assert.deepStrictEqual(await runCheck(build(null, {}), 'webshop'), { skip: true });
  assert.deepStrictEqual(await runCheck(build({ syncedAt: new Date(NOW - HOUR).toISOString(), lastError: null }), 'webshop'), { ok: true });
  assert.strictEqual((await runCheck(build({ syncedAt: new Date(NOW - 5 * HOUR).toISOString(), lastError: null }), 'webshop')).severity, 'waarschuwing');
  assert.strictEqual((await runCheck(build({ syncedAt: new Date(NOW - 30 * HOUR).toISOString(), lastError: null }), 'webshop')).severity, 'fout');
  assert.strictEqual((await runCheck(build({ syncedAt: new Date(NOW - HOUR).toISOString(), lastError: 'timeout' }), 'webshop')).severity, 'waarschuwing');
});

test('ai: zonder sleutel overslaan, sleutel geweigerd = fout, drie mislukte aanroepen = waarschuwing, tenant-filter', async () => {
  const db = openDb();
  for (const [id, slug] of [[TENANT, 'a'], ['t2', 'b']]) db.prepare("INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, '2026-01-01')").run(id, slug, slug);
  let sequence = 0;
  /**
   * Voegt een AI-aanroep toe aan de gebruikslog.
   * @param {*} tenantId De omgeving.
   * @param {*} status De uitkomst van de aanroep.
   * @param {*} minutesAgo Hoeveel minuten geleden.
   * @returns {*} Het resultaat van de insert.
   */
  const usage = (tenantId, status, minutesAgo) => db.prepare(
    "INSERT INTO ai_usage (id, tenant_id, feature, model, status, created_at) VALUES (?, ?, 'plan_analyse', 'm', ?, ?)",
  ).run(`u${sequence++}`, tenantId, status, new Date(NOW - minutesAgo * 60000).toISOString());
  let key = '';
  const checks = createMonitoringChecks({ db, settingsFor: () => settingsOf({ anthropicApiKey: key }), runtimeStats: false });
  assert.deepStrictEqual(await runCheck(checks, 'ai'), { skip: true });
  key = 'sk-ant-xxxxxxxx';
  assert.deepStrictEqual(await runCheck(checks, 'ai'), { ok: true });
  usage('t2', 'auth', 1);
  assert.deepStrictEqual(await runCheck(checks, 'ai'), { ok: true }, 'andere omgeving telt niet mee');
  for (const minutes of [30, 20, 10]) usage(TENANT, 'api_error', minutes);
  assert.strictEqual((await runCheck(checks, 'ai')).severity, 'waarschuwing');
  usage(TENANT, 'no_credit', 1);
  const noCredit = await runCheck(checks, 'ai');
  assert.strictEqual(noCredit.severity, 'fout');
  assert.ok(!/sk-ant/.test(noCredit.message));
});
