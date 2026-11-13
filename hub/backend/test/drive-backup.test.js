// Back-ups naar Google Drive: instellen, verbinden (OAuth, nagebootst), uploaden als stroom, opruimen, terugvallen bij fouten,
// verbinding verbreken, rechten en geheimen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeDriveBackup, sanitizeDriveState } = require('../src/platform/drive-backup');
const { listen, createClient } = require('./helpers/http-client');
const { createGoogleFake } = require('./helpers/google-fake');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const REDIRECT = 'https://hub.example.nl/app/api/admin/backups/drive/callback';
const BASE = '/app/api/admin/backups';

/**
 * Wacht tot een voorwaarde waar is (achtergrondwerk van de server).
 * @param {Function} check Geeft true als klaar (mag async zijn).
 * @returns {Promise<void>}
 */
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('voorwaarde niet bereikt');
}

/**
 * Start een app met een back-upmap, een nagebootste Google en een hoofdbeheerder.
 * @returns {Promise<object>} app, base, store, google, dir, baas (ingelogde client) en cleanup().
 */
async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-drive-'));
  const db = openDb();
  const store = createStore(db);
  await store.createAccount(store.ensureTenant().id, { username: 'baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const google = await createGoogleFake();
  const app = createApp({ secret: SECRET, db, loginDelayMs: 0, env: { MULTITENANCY: '1' }, backupDir: dir, googleFetch: google.fetchImpl });
  const { server, base } = await listen(app);
  const baas = createClient(base, { followRedirects: false });
  await baas.post('/app/api/auth/login', { username: 'baas', password: PW });
  return {
    app, base, store, google, dir, baas, server,
    /**
     * Stopt de server, de nagebootste Google en ruimt de map op.
     * @returns {Promise<void>}
     */
    async cleanup() { server.close(); await google.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * Zet een nepbestand als back-up in de map.
 * @param {string} dir De back-upmap.
 * @param {string} stamp JJJJMMDD-UUMMSS.
 * @param {string} content De inhoud.
 * @returns {string} De bestandsnaam.
 */
function addBackup(dir, stamp, content) {
  const name = `aquatech-${stamp}.db.enc`;
  fs.writeFileSync(path.join(dir, name), content);
  return name;
}

/**
 * Stelt de Google-app in en verbindt (volledige OAuth-ronde).
 * @param {object} world De uitkomst van start().
 * @param {object} [extra] Extra instellingen voor de PUT.
 * @returns {Promise<void>}
 */
async function connect(world, extra = {}) {
  const saved = await world.baas.put(`${BASE}/drive`, { clientId: 'client-123', clientSecret: 'geheim-van-google-app', redirectUri: REDIRECT, ...extra });
  assert.strictEqual(saved.status, 200);
  const started = await world.baas.post(`${BASE}/drive/connect`);
  assert.strictEqual(started.status, 200);
  const url = new URL(started.body.url);
  assert.strictEqual(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.strictEqual(url.searchParams.get('access_type'), 'offline');
  const back = await world.baas.get(`${BASE}/drive/callback?code=goede-code&state=${encodeURIComponent(url.searchParams.get('state'))}`);
  assert.strictEqual(back.status, 303);
  assert.match(back.location, /beheer\/\?drive=verbonden#backup-drive$/);
}

test('instellingen worden opgeschoond: https-redirect, bewaaraantal en mapnaam', () => {
  assert.strictEqual(sanitizeDriveBackup({ redirectUri: 'http://x.nl/app/api/admin/backups/drive/callback' }).redirectUri, '');
  assert.strictEqual(sanitizeDriveBackup({ redirectUri: 'https://x.nl/ergens-anders' }).redirectUri, '');
  assert.strictEqual(sanitizeDriveBackup({ redirectUri: REDIRECT }).redirectUri, REDIRECT);
  assert.strictEqual(sanitizeDriveBackup({ keepCount: 0 }).keepCount, 30);
  assert.strictEqual(sanitizeDriveBackup({ keepCount: 9999 }).keepCount, 30);
  assert.strictEqual(sanitizeDriveBackup({}).folderName, 'AquaTech back-ups');
  assert.strictEqual(sanitizeDriveState({ events: Array.from({ length: 80 }, () => ({ at: 'x', ok: true, kind: 'upload', message: 'm' })) }).events.length, 40);
});

test('rechten: alleen een hoofdbeheerder', async () => {
  const world = await start();
  try {
    assert.strictEqual((await createClient(world.base).get(`${BASE}/drive`)).status, 401);
    await world.store.createAccount(world.store.ensureTenant().id, { username: 'tweede', role: 'beheerder', password: PW });
    const tweede = createClient(world.base);
    await tweede.post('/app/api/auth/login', { username: 'tweede', password: PW });
    assert.strictEqual((await tweede.get(`${BASE}/drive`)).status, 403);
    assert.strictEqual((await tweede.put(`${BASE}/drive`, { clientId: 'x' })).status, 403);
    assert.strictEqual((await tweede.post(`${BASE}/drive/connect`)).status, 403);
    assert.strictEqual((await tweede.post(`${BASE}/drive/sync`)).status, 403);
  } finally { await world.cleanup(); }
});

test('verbinden, uploaden als stroom, opruimen en verbreken', async () => {
  const world = await start();
  try {
    const oldest = addBackup(world.dir, '20261111-030000', 'oudste');
    addBackup(world.dir, '20261112-030000', Buffer.alloc(300000, 7));
    const newest = addBackup(world.dir, '20261113-030000', 'nieuwste');
    // Aanzetten kan pas na verbinden; connect zonder gegevens kan ook niet.
    assert.strictEqual((await world.baas.post(`${BASE}/drive/connect`)).status, 409);
    assert.strictEqual((await world.baas.put(`${BASE}/drive`, { enabled: true, clientId: 'c', clientSecret: 'geheim-van-google-app', redirectUri: REDIRECT })).status, 409);
    assert.strictEqual((await world.baas.put(`${BASE}/drive`, { clientId: 'c', redirectUri: 'http://onveilig/callback' })).status, 400);

    await connect(world, { keepCount: 2 });
    assert.strictEqual((await world.baas.put(`${BASE}/drive`, { enabled: true })).status, 200);
    await until(async () => (await world.baas.get(`${BASE}/drive`)).body.items.filter((item) => item.onDrive).length === 2);
    let status = (await world.baas.get(`${BASE}/drive?remote=1`)).body;
    assert.strictEqual(status.connected, true);
    assert.strictEqual(status.account, 'beheer@example.nl');
    assert.deepStrictEqual(status.remote.map((file) => file.name), [newest, 'aquatech-20261112-030000.db.enc']);
    // De gestreamde upload kwam helemaal aan, met de juiste lengtekop.
    const big = [...world.google.files.values()].find((file) => file.name === 'aquatech-20261112-030000.db.enc');
    assert.ok(big.body.equals(Buffer.alloc(300000, 7)));
    const put = world.google.calls.find((call) => call.method === 'PUT' && call.size === 300000);
    assert.strictEqual(put.length, '300000');
    assert.ok(status.items.find((item) => item.name === oldest && !item.onDrive), 'de oudste valt buiten het bewaaraantal');
    // Geheimen komen nooit terug.
    const raw = JSON.stringify(status);
    assert.doesNotMatch(raw, /refresh-1|geheim-van-google-app/);
    assert.strictEqual(status.secretSet, true);

    // Nog een back-up: Drive houdt er twee, de oudste verdwijnt daar.
    addBackup(world.dir, '20261114-030000', 'volgende');
    const out = (await world.baas.post(`${BASE}/drive/sync`)).body;
    assert.deepStrictEqual(out.uploaded, ['aquatech-20261114-030000.db.enc']);
    assert.deepStrictEqual(out.removed, ['aquatech-20261112-030000.db.enc']);
    status = (await world.baas.get(`${BASE}/drive?remote=1`)).body;
    assert.deepStrictEqual(status.remote.map((file) => file.name), ['aquatech-20261114-030000.db.enc', newest]);
    assert.ok(status.events.some((event) => event.kind === 'upload' && event.ok));

    // De Google-gegevens wijzigen kan pas na verbreken.
    assert.strictEqual((await world.baas.put(`${BASE}/drive`, { clientId: 'andere' })).status, 409);
    assert.strictEqual((await world.baas.put(`${BASE}/drive`, { keepCount: 5 })).status, 200);
    const gone = (await world.baas.post(`${BASE}/drive/disconnect`)).body;
    assert.strictEqual(gone.revoked, true);
    assert.deepStrictEqual(world.google.revoked, ['refresh-1']);
    assert.strictEqual(gone.connected, false);
    assert.strictEqual((await world.baas.post(`${BASE}/drive/sync`)).status, 409);
    assert.strictEqual((await world.baas.put(`${BASE}/drive`, { clientId: 'andere' })).status, 200);
    const actions = (await world.baas.get('/app/api/admin/audit')).body.items.map((entry) => entry.action);
    assert.ok(actions.includes('backup_drive_verbonden') && actions.includes('backup_drive_verbroken'));
  } finally { await world.cleanup(); }
});

test('een nieuwe back-up wordt automatisch gekopieerd en de uurlijkse ronde slaat uit/ontkoppeld over', async () => {
  const world = await start();
  try {
    assert.strictEqual((await world.app.locals.driveBackupSync()).skipped, 'not_connected');
    await connect(world);
    await until(async () => !(await world.baas.get(`${BASE}/drive`)).body.running);
    assert.strictEqual((await world.app.locals.driveBackupSync()).skipped, 'disabled');
    await world.baas.put(`${BASE}/drive`, { enabled: true });
    const made = await world.baas.post(BASE);
    assert.strictEqual(made.status, 201);
    await until(async () => (await world.baas.get(`${BASE}/drive`)).body.items.some((item) => item.name === made.body.name && item.onDrive));
  } finally { await world.cleanup(); }
});

test('fouten: Drive vol of niet bereikbaar, wachttijd na een fout, ingetrokken toegang vraagt opnieuw verbinden', async () => {
  const world = await start();
  try {
    await connect(world);
    assert.strictEqual((await world.baas.put(`${BASE}/drive`, { enabled: true })).status, 200);
    await until(async () => !(await world.baas.get(`${BASE}/drive`)).body.running);
    addBackup(world.dir, '20261120-030000', 'x');
    world.google.failUploads = { status: 403, reason: 'storageQuotaExceeded' };
    const failed = (await world.baas.post(`${BASE}/drive/sync`)).body;
    assert.strictEqual(failed.code, 'quota');
    assert.match(failed.error, /vol/);
    let status = (await world.baas.get(`${BASE}/drive`)).body;
    assert.ok(status.lastFailAt);
    assert.strictEqual(status.events[0].ok, false);
    // Automatisch wacht na een fout, handmatig probeert het meteen opnieuw.
    assert.strictEqual((await world.app.locals.driveBackupSync()).skipped, 'backoff');
    world.google.failUploads = null;
    assert.deepStrictEqual((await world.baas.post(`${BASE}/drive/sync`)).body.uploaded, ['aquatech-20261120-030000.db.enc']);
    // Toegang ingetrokken bij Google.
    world.google.tokenRevoked = true;
    await world.baas.post(`${BASE}/drive/test`);
    status = (await world.baas.get(`${BASE}/drive`)).body;
    assert.strictEqual(status.needsReconnect, true);
    assert.strictEqual((await world.app.locals.driveBackupSync()).skipped, 'backoff');
    assert.doesNotMatch(JSON.stringify(status), /refresh-1/);
  } finally { await world.cleanup(); }
});

test('terugkeer van Google: onbekende of herhaalde state, geweigerd en een ontbrekend refresh token', async () => {
  const world = await start();
  try {
    await world.baas.put(`${BASE}/drive`, { clientId: 'c', clientSecret: 'geheim-van-google-app', redirectUri: REDIRECT });
    assert.match((await world.baas.get(`${BASE}/drive/callback?code=goede-code&state=verzonnen`)).location, /drive=fout&reden=invalid_state/);
    assert.match((await world.baas.get(`${BASE}/drive/callback?error=access_denied`)).location, /drive=geweigerd/);
    const state = new URL((await world.baas.post(`${BASE}/drive/connect`)).body.url).searchParams.get('state');
    world.google.nextRefreshToken = '';
    assert.match((await world.baas.get(`${BASE}/drive/callback?code=goede-code&state=${state}`)).location, /reden=no_refresh_token/);
    // Een state is eenmalig.
    assert.match((await world.baas.get(`${BASE}/drive/callback?code=goede-code&state=${state}`)).location, /reden=invalid_state/);
    assert.strictEqual((await world.baas.get(`${BASE}/drive`)).body.connected, false);
    // De state hoort bij de gebruiker die verbindt.
    await world.store.createAccount(world.store.ensureTenant().id, { username: 'tweede', role: 'beheerder', password: PW }, { platformAdmin: true });
    const tweede = createClient(world.base, { followRedirects: false });
    await tweede.post('/app/api/auth/login', { username: 'tweede', password: PW });
    world.google.nextRefreshToken = 'refresh-1';
    const other = new URL((await world.baas.post(`${BASE}/drive/connect`)).body.url).searchParams.get('state');
    assert.match((await tweede.get(`${BASE}/drive/callback?code=goede-code&state=${other}`)).location, /reden=invalid_state/);
  } finally { await world.cleanup(); }
});

test('verbreken wacht op een lopende upload en laat geen stand van het oude account achter', async () => {
  const world = await start();
  try {
    await connect(world);
    addBackup(world.dir, '20261130-030000', Buffer.alloc(1000, 1));
    const syncing = world.baas.post(`${BASE}/drive/sync`);
    await until(async () => (await world.baas.get(`${BASE}/drive`)).body.running);
    const gone = (await world.baas.post(`${BASE}/drive/disconnect`)).body;
    await syncing;
    assert.strictEqual(gone.connected, false);
    assert.deepStrictEqual(gone.items.filter((item) => item.onDrive), []);
    const status = (await world.baas.get(`${BASE}/drive`)).body;
    assert.strictEqual(status.folderId, '');
    assert.strictEqual(status.needsReconnect, false);
  } finally { await world.cleanup(); }
});
