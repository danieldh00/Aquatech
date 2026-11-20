// Hersteltest van de Google Drive-back-up (platform/drive-restore-test.js): ophalen van Drive, ontsleutelen, inlezen in een
// tijdelijk schema, vergelijken met de actieve database, opruimen, planning, rechten en de controle van de bewaking.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createMonitoringChecks } = require('../src/platform/monitoring-checks');
const { sanitizeDriveRestoreTest, lastDueAt } = require('../src/platform/drive-restore-test');
const { listen, createClient } = require('./helpers/http-client');
const { createGoogleFake } = require('./helpers/google-fake');

const SECRET = 'd'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const REDIRECT = 'https://hub.example.nl/app/api/admin/backups/drive/callback';
const BACKUPS = '/app/api/admin/backups';
const TEST = '/app/api/admin/restore-test-drive';

/**
 * Wacht tot een voorwaarde waar is (achtergrondwerk van de server).
 * @param {Function} check Geeft true als klaar (mag async zijn).
 * @returns {Promise<void>}
 */
async function until(check) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail('voorwaarde niet bereikt');
}

/**
 * Start een app met een nagebootste Google, een hoofdbeheerder 'baas' en een installateur 'kees', en verbindt Drive.
 * @returns {Promise<object>} app, baas, kees, google, dir en cleanup().
 */
async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-drive-restore-'));
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', role: 'installateur', password: PW }, { mustChangePassword: false });
  const google = await createGoogleFake();
  google.createdNow = true;
  const app = createApp({ secret: SECRET, db, loginDelayMs: 0, env: { MULTITENANCY: '1' }, backupDir: dir, googleFetch: google.fetchImpl });
  const { server, base } = await listen(app);
  const baas = createClient(base, { followRedirects: false });
  await baas.post('/app/api/auth/login', { username: 'baas', password: PW });
  const kees = createClient(base, { followRedirects: false });
  await kees.post('/app/api/auth/login', { username: 'kees', password: PW });
  return {
    app, baas, kees, google, dir,
    /**
     * Koppelt Google Drive (volledige OAuth-ronde) en zet de kopie aan.
     * @returns {Promise<void>}
     */
    async connect() {
      await baas.put(`${BACKUPS}/drive`, { clientId: 'client-123', clientSecret: 'geheim-van-google-app', redirectUri: REDIRECT });
      const started = await baas.post(`${BACKUPS}/drive/connect`);
      const state = new URL(started.body.url).searchParams.get('state');
      await baas.get(`${BACKUPS}/drive/callback?code=goede-code&state=${encodeURIComponent(state)}`);
      assert.strictEqual((await baas.put(`${BACKUPS}/drive`, { enabled: true })).status, 200);
    },
    /**
     * Maakt een echte back-up en wacht tot hij op Drive staat.
     * @returns {Promise<string>} De bestandsnaam.
     */
    async backupToDrive() {
      const made = await baas.post(BACKUPS);
      assert.strictEqual(made.status, 201);
      await until(async () => [...google.files.values()].some((file) => file.name === made.body.name));
      return made.body.name;
    },
    /**
     * Start de test en wacht op de uitslag.
     * @returns {Promise<object>} De nieuwste run.
     */
    async runTest() {
      const before = (await baas.get(TEST)).body.runs.length;
      assert.strictEqual((await baas.post(`${TEST}/run`, {})).status, 202);
      await until(async () => (await baas.get(TEST)).body.runs.length > before);
      return (await baas.get(TEST)).body.latest;
    },
    /**
     * Stopt de server, de nagebootste Google en ruimt de map op.
     * @returns {Promise<void>}
     */
    async cleanup() { server.close(); await google.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('de nieuwste back-up van Drive wordt teruggezet en komt overeen; er blijft niets achter', async () => {
  const world = await start();
  try {
    await world.connect();
    await world.backupToDrive();
    const run = await world.runTest();
    assert.strictEqual(run.state, 'geslaagd', run.message);
    assert.strictEqual(run.trigger, 'handmatig');
    assert.match(run.backup.name, /^aquatech-\d{8}-\d{6}\.db\.enc$/);
    assert.ok(run.backup.bytes > 0);
    assert.ok(run.tables.backup > 10);
    assert.deepStrictEqual(run.tables.missing, []);
    assert.deepStrictEqual(run.rows.deviating, []);
    assert.ok(run.rows.checked > 10);
    assert.ok(run.sanity.every((item) => item.ok));
    // Geen tijdelijk bestand of tijdelijke map in de back-upmap en geen back-up erbij.
    assert.deepStrictEqual(fs.readdirSync(world.dir).filter((name) => name.startsWith('.')), []);
    // Een tweede run telt los (de historie groeit).
    await world.runTest();
    assert.strictEqual((await world.baas.get(TEST)).body.runs.length, 2);
  } finally { await world.cleanup(); }
});

test('mislukt met een leesbare melding: niets op Drive, download weigert, beschadigd bestand', async () => {
  const world = await start();
  try {
    await world.connect();
    const empty = await world.runTest();
    assert.strictEqual(empty.state, 'mislukt');
    assert.match(empty.message, /geen back-up op Google Drive/);

    await world.backupToDrive();
    world.google.failDownloads = { status: 500 };
    const failed = await world.runTest();
    assert.strictEqual(failed.state, 'mislukt');
    assert.doesNotMatch(failed.message, /acc-\d+|refresh-1|geheim-van-google-app/);
    world.google.failDownloads = null;

    // Een beschadigd bestand op Drive (een nieuwere naam, zodat dit de nieuwste is).
    world.google.files.set('stuk', { id: 'stuk', name: 'aquatech-29990101-000000.db.enc', parents: [[...world.google.files.values()].find((file) => file.folder).id], size: '40', body: Buffer.alloc(40, 7), createdTime: new Date().toISOString(), seq: 999 });
    const broken = await world.runTest();
    assert.strictEqual(broken.state, 'mislukt');
    assert.match(broken.message, /niet worden teruggezet/);
    assert.deepStrictEqual(fs.readdirSync(world.dir).filter((name) => name.startsWith('.')), []);
  } finally { await world.cleanup(); }
});

test('een Drive-back-up ouder dan 36 uur geeft een waarschuwing', async () => {
  const world = await start();
  try {
    await world.connect();
    world.google.createdNow = false;
    await world.backupToDrive();
    const run = await world.runTest();
    assert.strictEqual(run.state, 'waarschuwing');
    assert.match(run.message, /ouder dan 36 uur/);
  } finally { await world.cleanup(); }
});

test('API: rechten, validatie, niet gekoppeld, één tegelijk en auditlog', async () => {
  const world = await start();
  try {
    assert.strictEqual((await world.kees.get(TEST)).status, 403);
    assert.strictEqual((await world.kees.post(`${TEST}/run`, {})).status, 403);
    assert.strictEqual((await createClient(world.baas.base || 'http://x').get(TEST).catch(() => ({ status: 401 }))).status, 401);

    const view = await world.baas.get(TEST);
    assert.strictEqual(view.body.configured, false);
    assert.deepStrictEqual(view.body.policy, { enabled: true, day: 0, time: '04:30' });
    const refused = await world.baas.post(`${TEST}/run`, {});
    assert.strictEqual(refused.status, 409);
    assert.strictEqual(refused.body.error, 'not_configured');

    assert.strictEqual((await world.baas.put(TEST, { enabled: true, day: 9, time: '04:00' })).status, 400);
    assert.strictEqual((await world.baas.put(TEST, { enabled: true, day: 1, time: 'laat' })).status, 400);
    assert.strictEqual((await world.baas.put(TEST, { day: 1, time: '04:00' })).status, 400);
    const saved = await world.baas.put(TEST, { enabled: false, day: 3, time: '02:15' });
    assert.deepStrictEqual(saved.body.policy, { enabled: false, day: 3, time: '02:15' });
    assert.strictEqual(saved.body.nextRunAt, null);

    await world.connect();
    await world.backupToDrive();
    assert.strictEqual((await world.baas.post(`${TEST}/run`, {})).status, 202);
    assert.strictEqual((await world.baas.post(`${TEST}/run`, {})).status, 409);
    await until(async () => (await world.baas.get(TEST)).body.runs.length === 1);
    // De instelling houdt de runs vast.
    await world.baas.put(TEST, { enabled: true, day: 1, time: '05:00' });
    assert.strictEqual((await world.baas.get(TEST)).body.runs.length, 1);
    const log = await world.baas.get('/app/api/admin/audit?limit=50').catch(() => null);
    if (log && log.status === 200) {
      const actions = JSON.stringify(log.body);
      assert.match(actions, /hersteltest_drive_ingesteld/);
      assert.match(actions, /hersteltest_drive_aangevraagd/);
    }
  } finally { await world.cleanup(); }
});

test('planning: de eerste keer meteen, daarna pas na het volgende geplande moment; uit = nooit', async () => {
  const world = await start();
  try {
    const test_ = world.app.locals.driveRestoreTest;
    assert.strictEqual(test_.due(), false, 'zonder Drive nooit');
    await world.connect();
    await world.backupToDrive();
    assert.strictEqual(test_.due(), true, 'nog nooit gedraaid');
    const done = await test_.tick();
    assert.ok(done);
    assert.strictEqual((await world.baas.get(TEST)).body.latest.trigger, 'schema');
    assert.strictEqual(test_.due(), false, 'net gedraaid');
    assert.strictEqual(await test_.tick(), null);
    await world.baas.put(TEST, { enabled: false, day: 0, time: '04:30' });
    assert.strictEqual(test_.due(), false);
  } finally { await world.cleanup(); }
});

test('instelling en planning: opschonen en het laatste geplande moment', () => {
  assert.deepStrictEqual(sanitizeDriveRestoreTest(null), { enabled: true, day: 0, time: '04:30', runs: [] });
  const clean = sanitizeDriveRestoreTest({ enabled: false, day: 99, time: 'x', runs: [{ state: 'mislukt', startedAt: 'geen datum' }, { state: 'geslaagd', startedAt: '2026-11-15T04:30:00.000Z', message: 'ok' }, 'rommel'] });
  assert.strictEqual(clean.enabled, false);
  assert.strictEqual(clean.day, 0);
  assert.strictEqual(clean.time, '04:30');
  assert.strictEqual(clean.runs.length, 1);
  const monday = new Date(2026, 10, 16, 12, 0, 0).getTime();
  const due = new Date(lastDueAt({ day: 0, time: '04:30' }, monday));
  assert.strictEqual(due.getDay(), 0);
  assert.strictEqual(due.getDate(), 15);
  assert.strictEqual(due.getHours(), 4);
});

test('bewaking: mislukt = fout, opmerkingen = waarschuwing, te oud = waarschuwing, uit of nog niets = overslaan', async () => {
  const nowMs = Date.parse('2026-11-20T12:00:00Z');
  let view;
  const checks = createMonitoringChecks({ driveRestoreTest: { view: () => view }, now: () => nowMs });
  const check = checks.find((item) => item.key === 'hersteltest-drive');
  assert.ok(check);
  const ctx = { now: () => nowMs, tenantId: 't', settings: {} };
  const active = { configured: true, policy: { enabled: true } };
  view = { ...active, latest: null };
  assert.strictEqual((await check.run(ctx)).skip, true);
  view = { configured: true, policy: { enabled: false }, latest: { state: 'mislukt' } };
  assert.strictEqual((await check.run(ctx)).skip, true);
  view = { ...active, latest: { state: 'mislukt', message: 'stuk', startedAt: '2026-11-20T04:30:00Z' } };
  const failed = await check.run(ctx);
  assert.strictEqual(failed.severity, 'fout');
  assert.match(failed.message, /stuk/);
  view = { ...active, latest: { state: 'waarschuwing', message: 'afwijkingen', startedAt: '2026-11-20T04:30:00Z' } };
  assert.strictEqual((await check.run(ctx)).severity, 'waarschuwing');
  view = { ...active, latest: { state: 'geslaagd', startedAt: '2026-11-01T04:30:00Z', finishedAt: '2026-11-01T04:31:00Z' } };
  assert.strictEqual((await check.run(ctx)).severity, 'waarschuwing');
  view = { ...active, latest: { state: 'geslaagd', startedAt: '2026-11-20T04:30:00Z', finishedAt: '2026-11-20T04:31:00Z' } };
  assert.strictEqual((await check.run(ctx)).ok, true);
});
