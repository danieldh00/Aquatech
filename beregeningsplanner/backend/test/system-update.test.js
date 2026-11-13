// Systeemupdate vanuit de app (platform/system-update.js + system-update-routes.js): statusbestanden van de host
// saneren, de aanvraag klaarzetten, wie mag updaten (alleen de hoofdtenant, met wachtwoord), limiet, auditlog en de
// onderhoudsmodus (schrijfverzoeken 503). Het hostscript zelf: update-script.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createSystemUpdate, compareVersions, sanitizeReleases, MAINTENANCE_MAX_MS } = require('../src/platform/system-update');
const { releaseInfo } = require('../tools/release-info');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const SECRET = 'u'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const RUNNING = require('../package.json').version;

/**
 * Een versie die nieuwer is dan de draaiende (patch + 1).
 * @param {number} [step] Hoeveel patches verder.
 * @returns {string} Bijv. '1.14.2'.
 */
function nextVersion(step = 1) {
  const [major, minor, patch] = RUNNING.split('.').map(Number);
  return `${major}.${minor}.${patch + step}`;
}

/**
 * Maakt een statusmap en een aanvraagmap.
 * @returns {{ statusDir: string, requestDir: string }} De mappen.
 */
function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aqt-sysupd-'));
  const statusDir = path.join(root, 'status');
  const requestDir = path.join(root, 'request');
  fs.mkdirSync(statusDir);
  fs.mkdirSync(requestDir);
  return { root, statusDir, requestDir };
}

/**
 * Zet statusbestanden neer zoals de host dat doet.
 * @param {string} statusDir De statusmap.
 * @param {object} files Bestandsnaam → inhoud (object).
 * @returns {void}
 */
function hostWrites(statusDir, files) {
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(statusDir, name), JSON.stringify(value));
}

test('compareVersions en release-info', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.strictEqual(compareVersions('1.2.3', '1.2.3'), 0);
  const info = releaseInfo('');
  assert.strictEqual(info.version, RUNNING);
  assert.ok(info.releases.length > 0 && info.releases.length <= 30);
  assert.ok(info.releases.every((release) => release.items.every((item) => typeof item.text === 'string' && !('for' in item))));
  assert.deepStrictEqual(releaseInfo(RUNNING).releases, [], 'niets nieuwer dan de eigen versie');
});

test('sanitizeReleases: rare invoer wordt weggefilterd of afgekapt', () => {
  const out = sanitizeReleases({ version: '1.2.3', releases: [
    { version: '1.2.3', title: 'x'.repeat(500), date: '2026-11-13', items: [{ text: 'a\u0000b' }, 42, { text: '' }] },
    { version: '../../etc', title: 'kwaad', items: [] },
    'tekst',
  ] });
  assert.strictEqual(out.releases.length, 1);
  assert.strictEqual(out.releases[0].title.length, 200);
  assert.deepStrictEqual(out.releases[0].items, ['a b']);
  assert.deepStrictEqual(sanitizeReleases(null), { version: null, releases: [] });
});

test('createSystemUpdate: niet ingericht, status lezen, symlinks en te grote bestanden negeren', () => {
  assert.deepStrictEqual(createSystemUpdate({ currentVersion: RUNNING }).view(), { configured: false, running: RUNNING });
  assert.strictEqual(createSystemUpdate({ currentVersion: RUNNING }).maintenance().active, false);

  const { root, statusDir, requestDir } = makeDirs();
  const update = createSystemUpdate({ statusDir, requestDir, currentVersion: RUNNING });
  let view = update.view();
  assert.strictEqual(view.configured, true);
  assert.strictEqual(view.newer, false);
  assert.strictEqual(view.status.state, 'idle');
  assert.strictEqual(view.auto, true, 'standaard automatisch');

  const next = nextVersion(2);
  hostWrites(statusDir, {
    'status.json': { current: RUNNING, available: next, checkedAt: '2026-11-13T08:00:00Z' },
    'run.json': { state: 'onzin', step: 'rm -rf', version: 'x', message: 'a'.repeat(1000) },
    'releases.json': { version: next, releases: [
      { version: next, title: 'Twee', items: [{ text: 'b' }] },
      { version: nextVersion(1), title: 'Een', items: [{ text: 'a' }] },
      { version: RUNNING, title: 'Al geïnstalleerd', items: [{ text: 'oud' }] },
    ] },
  });
  view = update.view();
  assert.strictEqual(view.available, next);
  assert.strictEqual(view.newer, true);
  assert.deepStrictEqual(view.releases.map((release) => release.title), ['Twee', 'Een'], 'alleen versies na de draaiende');
  assert.strictEqual(view.status.state, 'idle', 'onbekende stand telt als idle');
  assert.strictEqual(view.status.step, null);
  assert.strictEqual(view.status.version, null);
  assert.strictEqual(view.status.message.length, 300);

  // Releasenotes van een andere versie dan de beschikbare tonen we niet.
  hostWrites(statusDir, { 'releases.json': { version: nextVersion(1), releases: [{ version: nextVersion(1), title: 'Een', items: [{ text: 'a' }] }] } });
  assert.deepStrictEqual(update.view().releases, []);

  // Een symlink of te groot bestand telt als afwezig.
  fs.rmSync(path.join(statusDir, 'status.json'));
  const elsewhere = path.join(root, 'elders.json');
  fs.writeFileSync(elsewhere, JSON.stringify({ available: next }));
  fs.symlinkSync(elsewhere, path.join(statusDir, 'status.json'));
  assert.strictEqual(update.view().available, null);
  fs.rmSync(path.join(statusDir, 'status.json'));
  fs.writeFileSync(path.join(statusDir, 'status.json'), JSON.stringify({ available: next, pad: 'x'.repeat(300 * 1024) }));
  assert.strictEqual(update.view().available, null);
  fs.writeFileSync(path.join(statusDir, 'status.json'), '{kapot');
  assert.strictEqual(update.view().available, null);
});

test('createSystemUpdate: aanvraag, intrekken, automatisch en afgeronde uitrol', () => {
  const { statusDir, requestDir } = makeDirs();
  const update = createSystemUpdate({ statusDir, requestDir, currentVersion: RUNNING });
  assert.strictEqual(update.request({ version: RUNNING }).error, 'no_update');

  const next = nextVersion();
  hostWrites(statusDir, { 'status.json': { current: RUNNING, available: next } });
  assert.strictEqual(update.request({ version: nextVersion(5) }).error, 'version_changed');
  assert.strictEqual(update.request({ version: '../x' }).error, 'version_changed');
  const out = update.request({ version: next, userId: 'u1', byName: 'Baas' });
  assert.ok(out.request.id);
  const written = JSON.parse(fs.readFileSync(path.join(requestDir, 'request.json'), 'utf8'));
  assert.strictEqual(written.version, next);
  assert.strictEqual(written.id, out.request.id);
  assert.strictEqual(update.view().pending.version, next);
  assert.strictEqual(update.request({ version: next }).error, 'pending');
  assert.deepStrictEqual(fs.readdirSync(requestDir), ['request.json'], 'geen tijdelijke bestanden achtergebleven');

  assert.strictEqual(update.cancel(), true);
  assert.strictEqual(update.cancel(), false);
  assert.strictEqual(update.view().pending, null);

  hostWrites(statusDir, { 'run.json': { state: 'bezig', step: 'back-up', version: next, startedAt: new Date().toISOString() } });
  assert.strictEqual(update.request({ version: next }).error, 'busy');

  update.setAuto(false);
  assert.strictEqual(update.auto(), false);
  update.setAuto(true);
  assert.strictEqual(update.auto(), true);

  assert.strictEqual(update.finishedRun(), null, 'nog bezig');
  hostWrites(statusDir, { 'run.json': { state: 'geslaagd', step: 'klaar', version: next, finishedAt: '2026-11-13T09:00:00Z', automatic: true, message: 'Versie draait.' } });
  const finished = update.finishedRun();
  assert.strictEqual(finished.state, 'geslaagd');
  assert.strictEqual(finished.automatic, true);
  assert.strictEqual(update.finishedRun(), null, 'maar één keer');
});

test('createSystemUpdate: onderhoudsmodus met cache en een maximum van een half uur', () => {
  const { statusDir, requestDir } = makeDirs();
  let clock = Date.parse('2026-11-13T10:00:00Z');
  const update = createSystemUpdate({ statusDir, requestDir, currentVersion: RUNNING, now: () => clock });
  assert.strictEqual(update.maintenance().active, false);
  hostWrites(statusDir, { 'maintenance.json': { since: new Date(clock).toISOString(), version: nextVersion() } });
  assert.strictEqual(update.maintenance().active, false, 'twee seconden uit de cache');
  clock += 2500;
  assert.strictEqual(update.maintenance().active, true);
  assert.strictEqual(update.maintenance().version, nextVersion());
  clock += MAINTENANCE_MAX_MS;
  assert.strictEqual(update.maintenance().active, false, 'een achtergebleven bestand sluit de site niet blijvend af');
  hostWrites(statusDir, { 'maintenance.json': { since: 'gisteren' } });
  clock += 2500;
  assert.strictEqual(update.maintenance().active, false, 'zonder geldig tijdstip niet');
});

test('createSystemUpdate: een vastgelopen uitrol (bezig) telt na een half uur als onderbroken', () => {
  const { statusDir, requestDir } = makeDirs();
  let clock = Date.parse('2026-11-13T10:00:00Z');
  const update = createSystemUpdate({ statusDir, requestDir, currentVersion: RUNNING, now: () => clock });
  const next = nextVersion();
  hostWrites(statusDir, {
    'status.json': { current: RUNNING, available: next },
    'run.json': { state: 'bezig', step: 'herstarten', version: next, startedAt: new Date(clock).toISOString() },
  });
  assert.strictEqual(update.request({ version: next }).error, 'busy');
  clock += MAINTENANCE_MAX_MS + 1000;
  const view = update.view();
  assert.strictEqual(view.status.state, 'mislukt');
  assert.match(view.status.message, /onderbroken/);
  assert.ok(update.request({ version: next }).request, 'daarna kan een nieuwe aanvraag');
  assert.strictEqual(update.finishedRun().state, 'mislukt', 'en de onderbreking komt in het auditlog');
  // Zonder begintijd telt bezig ook niet als lopend.
  hostWrites(statusDir, { 'run.json': { state: 'bezig', step: 'ophalen', version: next } });
  assert.strictEqual(update.view().status.state, 'mislukt');
  assert.strictEqual(update.finishedRun().state, 'mislukt');
  clock += 60 * 1000;
  update.view();
  assert.strictEqual(update.finishedRun(), null, 'vaste eindtijd: niet bij elke vraag opnieuw in het auditlog');
  assert.ok(!update.view().status.finishedAt.startsWith('1970'), 'een echte tijd (wijzigingstijd van run.json) voor het scherm');
});

/**
 * Testserver met updatemappen: hoofdbeheerder 'baas', beheerder 'bert' en installateur 'kees' in de hoofdtenant,
 * en een tweede organisatie met beheerder 'gerda'.
 * @param {object} [options] multitenancy aan/uit, configured (mappen meegeven).
 * @returns {Promise<object>} server, base, as, store, db, statusDir en requestDir.
 */
async function setup({ multitenancy = false, configured = true } = {}) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { mustChangePassword: false, platformAdmin: true });
  await store.createAccount(main, { username: 'bert', displayName: 'Bert', role: 'beheerder', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW }, { mustChangePassword: false });
  const groen = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant;
  await store.createAccount(groen.id, { username: 'gerda', displayName: 'Gerda', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const dirs = makeDirs();
  const env = { ...(multitenancy ? { MULTITENANCY: '1' } : {}), ...(configured ? { UPDATE_STATUS_DIR: dirs.statusDir, UPDATE_REQUEST_DIR: dirs.requestDir } : {}) };
  const app = createApp({ secret: SECRET, db, env, loginDelayMs: 0 });
  const { server, base } = await listen(app);
  return { server, base, as: createLogin(base, { password: PW }), store, db, main, ...dirs };
}

/**
 * De acties in het auditlog van de hoofdtenant.
 * @param {object} store De store.
 * @param {string} tenantId De hoofdtenant.
 * @returns {string[]} De acties, nieuwste eerst.
 */
const auditActions = (store, tenantId) => store.listAudit(tenantId, { limit: 50 }).items.map((row) => row.action);

test('API: alleen de beheerder van de hoofdtenant, met wachtwoord, en alles in het auditlog', async () => {
  const { server, base, as, store, main, statusDir, requestDir } = await setup();
  try {
    const next = nextVersion();
    hostWrites(statusDir, {
      'status.json': { current: RUNNING, available: next, checkedAt: new Date().toISOString() },
      'releases.json': { version: next, releases: [{ version: next, title: 'Nieuw', items: [{ text: 'Punt' }] }] },
    });
    const bert = await as('bert');
    const kees = await as('kees');
    const anonymous = createClient(base);

    assert.strictEqual((await bert.get('/app/api/me')).body.systemUpdate, true, 'zonder multitenancy mag de beheerder van de hoofdtenant');
    assert.strictEqual((await kees.get('/app/api/me')).body.systemUpdate, false);
    assert.strictEqual((await kees.get('/app/api/admin/system-update')).status, 403);
    assert.strictEqual((await anonymous.get('/app/api/admin/system-update')).status, 401);
    assert.strictEqual((await kees.post('/app/api/admin/system-update', { version: next, password: PW })).status, 403);

    const view = await bert.get('/app/api/admin/system-update');
    assert.strictEqual(view.status, 200);
    assert.strictEqual(view.body.running, RUNNING);
    assert.strictEqual(view.body.available, next);
    assert.strictEqual(view.body.newer, true);
    assert.strictEqual(view.body.releases[0].items[0], 'Punt');

    const wrong = await bert.post('/app/api/admin/system-update', { version: next, password: 'Fout-Wachtwoord-1!' });
    assert.strictEqual(wrong.status, 401);
    assert.ok(!fs.existsSync(path.join(requestDir, 'request.json')));
    const started = await bert.post('/app/api/admin/system-update', { version: next, password: PW });
    assert.strictEqual(started.status, 202, JSON.stringify(started.body));
    assert.strictEqual(started.body.pending.version, next);
    assert.strictEqual(started.body.pending.by, 'Bert');
    assert.ok(fs.existsSync(path.join(requestDir, 'request.json')));
    assert.strictEqual((await bert.post('/app/api/admin/system-update', { version: next, password: PW })).body.error, 'pending');

    const cancelled = await bert.del('/app/api/admin/system-update/request');
    assert.strictEqual(cancelled.status, 200);
    assert.strictEqual(cancelled.body.pending, null);
    assert.strictEqual((await bert.del('/app/api/admin/system-update/request')).status, 404);

    assert.strictEqual((await bert.put('/app/api/admin/system-update/auto', { auto: 'nee' })).status, 400);
    const auto = await bert.put('/app/api/admin/system-update/auto', { auto: false });
    assert.strictEqual(auto.body.auto, false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(requestDir, 'policy.json'), 'utf8')), { auto: false });

    // Een afgeronde uitrol komt één keer in het auditlog.
    hostWrites(statusDir, { 'run.json': { state: 'mislukt', step: 'klaar', version: next, finishedAt: new Date().toISOString(), message: 'Terug naar de vorige versie.' } });
    await bert.get('/app/api/admin/system-update');
    await bert.get('/app/api/admin/system-update');
    const actions = auditActions(store, main);
    for (const action of ['update_wachtwoord_fout', 'update_aangevraagd', 'update_ingetrokken', 'update_automatisch', 'update_mislukt']) {
      assert.ok(actions.includes(action), `${action} staat in het auditlog`);
    }
    assert.strictEqual(actions.filter((action) => action === 'update_mislukt').length, 1);
  } finally {
    server.close();
  }
});

test('API: limiet op starten (ook tegen wachtwoord raden)', async () => {
  const { server, as, statusDir } = await setup();
  try {
    hostWrites(statusDir, { 'status.json': { current: RUNNING, available: nextVersion() } });
    const bert = await as('bert');
    for (let i = 0; i < 5; i++) assert.strictEqual((await bert.post('/app/api/admin/system-update', { version: nextVersion(), password: 'Fout-Wachtwoord-1!' })).status, 401);
    assert.strictEqual((await bert.post('/app/api/admin/system-update', { version: nextVersion(), password: PW })).status, 429);
  } finally {
    server.close();
  }
});

test('API: met multitenancy alleen een hoofdbeheerder; andere organisatie nooit', async () => {
  const { server, as } = await setup({ multitenancy: true });
  try {
    const baas = await as('baas');
    const bert = await as('bert');
    const gerda = await as('gerda', 'groen');
    assert.strictEqual((await baas.get('/app/api/admin/system-update')).status, 200);
    assert.strictEqual((await bert.get('/app/api/admin/system-update')).status, 403);
    assert.strictEqual((await gerda.get('/app/api/admin/system-update')).status, 403);
    assert.strictEqual((await gerda.get('/app/api/me')).body.systemUpdate, false);
  } finally {
    server.close();
  }
});

test('API: niet ingericht op deze server', async () => {
  const { server, as } = await setup({ configured: false });
  try {
    const bert = await as('bert');
    assert.deepStrictEqual((await bert.get('/app/api/admin/system-update')).body.configured, false);
    assert.strictEqual((await bert.post('/app/api/admin/system-update', { version: nextVersion(), password: PW })).status, 501);
    assert.strictEqual((await bert.put('/app/api/admin/system-update/auto', { auto: false })).status, 501);
  } finally {
    server.close();
  }
});

test('onderhoudsmodus: lezen werkt, schrijven 503, in- en uitloggen en health blijven werken', async () => {
  const { server, base, as, statusDir } = await setup();
  try {
    const bert = await as('bert');
    hostWrites(statusDir, { 'maintenance.json': { since: new Date().toISOString(), version: nextVersion() } });
    await new Promise((resolve) => { setTimeout(resolve, 2100); }); // cache van twee seconden

    const me = await bert.get('/app/api/me');
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.headers.get('x-aquatech-maintenance'), '1');
    const health = await createClient(base).get('/api/health');
    assert.strictEqual(health.body.maintenance, true);
    assert.strictEqual(health.body.ok, true);

    const write = await bert.put('/app/api/account/profile', { email: 'bert@example.nl' });
    assert.strictEqual(write.status, 503);
    assert.strictEqual(write.body.error, 'maintenance');
    assert.strictEqual(write.headers.get('retry-after'), '60');
    const login = await createClient(base).login('kees', PW);
    assert.strictEqual(login.status, 200, 'inloggen blijft werken (de beheerder volgt de voortgang)');
    const shopForm = await fetch(`${base}/winkelwagen/toevoegen`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'code=X' });
    assert.strictEqual(shopForm.status, 503);
    assert.match(shopForm.headers.get('content-type'), /html/);

    const logout = await bert.post('/app/api/auth/logout');
    assert.notStrictEqual(logout.status, 503);

    fs.rmSync(path.join(statusDir, 'maintenance.json'));
    await new Promise((resolve) => { setTimeout(resolve, 2100); });
    const after = await createClient(base).login('kees', PW);
    assert.strictEqual(after.status, 200);
    assert.strictEqual(after.headers.get('x-aquatech-maintenance'), null);
  } finally {
    server.close();
  }
});
