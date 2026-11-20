// Routes van de hersteltest (platform/restore-test-routes.js): wie mag, validatie, aanvragen, auditlog, niet
// ingericht en de controle van de bewaking.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createMonitoringChecks } = require('../src/platform/monitoring-checks');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const SECRET = 'r'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Testserver met statusmap en aanvraagmap: beheerder 'bert' en installateur 'kees' in de hoofdtenant.
 * @param {boolean} [configured] Mappen meegeven.
 * @returns {Promise<object>} server, base, as, store, main, statusDir en requestDir.
 */
async function setup(configured = true) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'bert', displayName: 'Bert', role: 'beheerder', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW }, { mustChangePassword: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aqt-rtroutes-'));
  const statusDir = path.join(root, 'status');
  const requestDir = path.join(root, 'request');
  fs.mkdirSync(statusDir);
  fs.mkdirSync(requestDir);
  const env = configured ? { UPDATE_STATUS_DIR: statusDir, UPDATE_REQUEST_DIR: requestDir } : {};
  const app = createApp({ secret: SECRET, db, env, loginDelayMs: 0 });
  const { server, base } = await listen(app);
  return { server, base, as: createLogin(base, { password: PW }), store, main, statusDir, requestDir };
}

test('API: alleen de hoofdbeheerder, validatie, aanvragen en auditlog', async () => {
  const { server, base, as, store, main, statusDir, requestDir } = await setup();
  try {
    const bert = await as('bert');
    const kees = await as('kees');
    assert.strictEqual((await createClient(base).get('/app/api/admin/restore-test')).status, 401);
    assert.strictEqual((await kees.get('/app/api/admin/restore-test')).status, 403);
    assert.strictEqual((await kees.put('/app/api/admin/restore-test', { enabled: true, day: 1, time: '04:00' })).status, 403);
    assert.strictEqual((await kees.post('/app/api/admin/restore-test/run', {})).status, 403);

    const view = await bert.get('/app/api/admin/restore-test');
    assert.strictEqual(view.status, 200);
    assert.strictEqual(view.body.configured, true);
    assert.deepStrictEqual(view.body.policy, { enabled: true, day: 0, time: '03:30' });
    assert.ok(view.body.nextRunAt);

    assert.strictEqual((await bert.put('/app/api/admin/restore-test', { enabled: true, day: 9, time: '04:00' })).status, 400);
    assert.strictEqual((await bert.put('/app/api/admin/restore-test', { enabled: true, day: 1, time: 'laat' })).status, 400);
    const saved = await bert.put('/app/api/admin/restore-test', { enabled: true, day: 1, time: '04:00' });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body.policy, { enabled: true, day: 1, time: '04:00' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(requestDir, 'restore-test.json'), 'utf8')), { enabled: true, day: 1, time: '04:00' });

    const started = await bert.post('/app/api/admin/restore-test/run', {});
    assert.strictEqual(started.status, 202);
    assert.strictEqual(started.body.requested, true);
    assert.ok(fs.existsSync(path.join(requestDir, 'restore-test-now.json')));
    assert.strictEqual((await bert.post('/app/api/admin/restore-test/run', {})).status, 409);

    fs.writeFileSync(path.join(statusDir, 'restore-test.json'), JSON.stringify({ runs: [{ state: 'geslaagd', startedAt: '2026-11-15T03:30:00Z', finishedAt: '2026-11-15T03:33:00Z', durationSec: 180 }] }));
    assert.strictEqual((await bert.get('/app/api/admin/restore-test')).body.latest.state, 'geslaagd');

    const actions = store.listAudit(main, { limit: 50 }).items.map((row) => row.action);
    assert.ok(actions.includes('hersteltest_ingesteld') && actions.includes('hersteltest_aangevraagd'));
  } finally {
    server.close();
  }
});

test('API: niet ingericht geeft 501 bij wijzigen en een lege stand bij lezen', async () => {
  const { server, as } = await setup(false);
  try {
    const bert = await as('bert');
    const view = await bert.get('/app/api/admin/restore-test');
    assert.strictEqual(view.body.configured, false);
    assert.strictEqual((await bert.put('/app/api/admin/restore-test', { enabled: true, day: 1, time: '04:00' })).status, 501);
    assert.strictEqual((await bert.post('/app/api/admin/restore-test/run', {})).status, 501);
  } finally {
    server.close();
  }
});

test('bewaking: mislukt = fout, opmerkingen = waarschuwing, te oud = waarschuwing, uit of nog niets = overslaan', async () => {
  const NOW = Date.parse('2026-11-20T12:00:00Z');
  /**
   * Voert de controle uit met een nepstand.
   * @param {object} view De stand van de hersteltest.
   * @returns {Promise<object>} De uitkomst.
   */
  const run = (view) => {
    const checks = createMonitoringChecks({ restoreTest: { view: () => view }, runtimeStats: false });
    const check = checks.find((entry) => entry.key === 'hersteltest');
    return check.run({ tenantId: 't1', scope: 'platform', config: {}, now: () => NOW });
  };
  const policy = { enabled: true, day: 0, time: '03:30' };
  /**
   * Een nepstand met de laatste run.
   * @param {string} state Uitslag.
   * @param {string} finishedAt Afgerond op.
   * @param {string} [message] Melding.
   * @returns {object} De stand.
   */
  const latest = (state, finishedAt, message = '') => ({ configured: true, policy, latest: { state, startedAt: finishedAt, finishedAt, message } });
  assert.deepStrictEqual(await run(latest('geslaagd', '2026-11-18T03:33:00Z')), { ok: true });
  assert.strictEqual((await run(latest('mislukt', '2026-11-18T03:33:00Z', 'Terugzetten gaf 2 fouten'))).severity, 'fout');
  assert.match((await run(latest('mislukt', '2026-11-18T03:33:00Z', 'Terugzetten gaf 2 fouten'))).message, /Terugzetten gaf 2 fouten/);
  assert.strictEqual((await run(latest('waarschuwing', '2026-11-18T03:33:00Z'))).severity, 'waarschuwing');
  assert.strictEqual((await run(latest('geslaagd', '2026-11-05T03:33:00Z'))).severity, 'waarschuwing');
  assert.ok((await run({ configured: true, policy, latest: null })).skip);
  assert.ok((await run({ configured: true, policy: { ...policy, enabled: false }, latest: { state: 'mislukt', startedAt: '2026-11-18T03:30:00Z' } })).skip);
  assert.ok((await run({ configured: false })).skip);
});
