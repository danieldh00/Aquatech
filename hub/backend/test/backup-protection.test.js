// Back-up en herstel, audit-thema 2: opruimen van resten (B-01), herbevestiging bij verwijderen en Drive verbreken (B-17),
// de bewakingscontroles voor de tenantafscherming (B-27) en een handmatig verwijderde back-up, en de bewaarde geopende back-up (T-09).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createVault } = require('../src/beveiliging/vault');
const { createBackup, sweepLeftovers, decryptFile, keyOf } = require('../src/backup');
const { dropStaleScratch, openScratch, dropScratch } = require('../src/database/pgdb');
const { createBackupOpenCache } = require('../src/platform/backup-open-cache');
const { createMonitoringChecks } = require('../src/platform/monitoring-checks');
const { listen, createClient } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';
const BASE = '/app/api/admin/backups';

/**
 * Zet een leeg back-upbestand met een naam in de map, met een bepaalde leeftijd.
 * @param {string} dir De map.
 * @param {string} stamp Het tijdstip in de naam (JJJJMMDD-UUMMSS).
 * @returns {string} De bestandsnaam.
 */
function addBackup(dir, stamp) {
  const name = `aquatech-${stamp}.db.enc`;
  fs.writeFileSync(path.join(dir, name), 'x');
  const date = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
  fs.utimesSync(path.join(dir, name), date, date);
  return name;
}

/**
 * Start een app met een back-upmap, een hoofdbeheerder en drie back-ups.
 * @returns {Promise<object>} dir, baas, db, server en cleanup().
 */
async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-protect-'));
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  await store.createAccount(tenantId, { username: 'baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const names = [addBackup(dir, '20261111-030000'), addBackup(dir, '20261112-030000'), addBackup(dir, '20261113-030000')];
  const app = createApp({ secret: 's'.repeat(64), db, loginDelayMs: 0, backupDir: dir });
  const { server, base } = await listen(app);
  const baas = createClient(base, { followRedirects: false });
  await baas.post('/app/api/auth/login', { username: 'baas', password: PW });
  return { dir, db, baas, names, server, cleanup() { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('een back-up verwijderen vraagt het wachtwoord, de nieuwste blijft staan en het komt in het auditlog', async () => {
  const world = await start();
  try {
    const [oldest, , newest] = world.names;
    assert.strictEqual((await world.baas.del(`${BASE}/${oldest}`, {})).status, 401);
    assert.strictEqual((await world.baas.del(`${BASE}/${oldest}`, { password: 'Fout-wachtwoord-2026!' })).status, 401);
    assert.ok(fs.existsSync(path.join(world.dir, oldest)), 'zonder goed wachtwoord blijft hij staan');
    const refused = await world.baas.del(`${BASE}/${newest}`, { password: PW });
    assert.strictEqual(refused.status, 409);
    assert.strictEqual(refused.body.error, 'newest_backup');
    assert.ok(fs.existsSync(path.join(world.dir, newest)));
    assert.strictEqual((await world.baas.del(`${BASE}/${oldest}`, { password: PW })).status, 200);
    assert.ok(!fs.existsSync(path.join(world.dir, oldest)));
    const actions = (await world.baas.get('/app/api/admin/audit')).body.items.map((entry) => entry.action);
    assert.ok(actions.includes('backup_verwijderd') && actions.includes('backup_beheer_wachtwoord_fout'));
  } finally { world.cleanup(); }
});

test('de Drive-koppeling verbreken, opnieuw koppelen en de kopie uitzetten vragen het wachtwoord', async () => {
  const world = await start();
  try {
    assert.strictEqual((await world.baas.post(`${BASE}/drive/disconnect`, {})).status, 401);
    assert.strictEqual((await world.baas.post(`${BASE}/drive/connect`, {})).status, 401);
    assert.strictEqual((await world.baas.post(`${BASE}/drive/disconnect`, { password: 'Fout-wachtwoord-2026!' })).status, 401);
  } finally { world.cleanup(); }
});

test('resten van een afgebroken back-up of terugzetten worden na een uur gewist, echte back-ups nooit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-sweep-'));
  try {
    const old = Date.now() - 2 * 3600 * 1000;
    const stale = ['.tmp-abc.db', 'aquatech-20261101-010101.db.enc.run.part', '.restore-x.ndjson.gz'];
    for (const name of stale) { fs.writeFileSync(path.join(dir, name), 'rest'); fs.utimesSync(path.join(dir, name), old / 1000, old / 1000); }
    fs.mkdirSync(path.join(dir, '.drive-restore-test-abc'));
    fs.utimesSync(path.join(dir, '.drive-restore-test-abc'), old / 1000, old / 1000);
    fs.writeFileSync(path.join(dir, '.tmp-vers.db'), 'bezig');
    const backup = addBackup(dir, '20200101-000000');
    assert.strictEqual(sweepLeftovers(dir).length, 4);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['.tmp-vers.db', backup].sort());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('een back-up wordt meteen versleuteld geschreven: geen onversleutelde kopie, en hij is te ontsleutelen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-stream-'));
  const db = openDb();
  try {
    createStore(db).ensureTenant();
    const vault = createVault(crypto.randomBytes(32));
    const made = await createBackup({ db, dir, vault });
    assert.deepStrictEqual(fs.readdirSync(dir), [made.name]);
    const target = path.join(dir, 'uit.ndjson.gz');
    await decryptFile(path.join(dir, made.name), target, keyOf(vault));
    assert.ok(fs.statSync(target).size > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tijdelijke schema\'s van een afgebroken proces worden verwijderd, die in gebruik niet', () => {
  const db = openDb();
  const scratch = openScratch(db);
  /**
   * De namen van alle tijdelijke schema's.
   * @returns {string[]} De namen.
   */
  const names = () => db.prepare('SELECT nspname FROM pg_namespace WHERE starts_with(nspname, ?)').all('aqt_scratch_').map((row) => row.nspname);
  try {
    const orphan = `aqt_scratch_${(Date.now() - 2 * 3600 * 1000).toString(16)}_${'a'.repeat(20)}`;
    const legacy = `aqt_scratch_${'b'.repeat(20)}`;
    const young = `aqt_scratch_${Date.now().toString(16)}_${'c'.repeat(20)}`;
    for (const name of [orphan, legacy, young]) db.exec(`CREATE SCHEMA "${name}"`);
    const removed = dropStaleScratch(db);
    assert.deepStrictEqual(removed.sort(), [legacy, orphan].sort());
    assert.ok(names().includes(scratch.schema), 'schema in gebruik blijft');
    assert.ok(names().includes(young), 'een jong schema blijft');
    db.exec(`DROP SCHEMA "${young}"`);
  } finally { dropScratch(scratch); }
});

test('bewaking: tenantafscherming uit = fout met multitenancy, anders waarschuwing', async () => {
  let rls = false;
  let multi = true;
  const checks = createMonitoringChecks({ tenantIsolation: { rlsOn: () => rls, multitenancyOn: () => multi }, runtimeStats: false });
  const check = checks.find((entry) => entry.key === 'tenantafscherming');
  assert.ok(check);
  assert.strictEqual((await check.run({})).severity, 'fout');
  multi = false;
  assert.strictEqual((await check.run({})).severity, 'waarschuwing');
  rls = true;
  assert.deepStrictEqual(await check.run({}), { ok: true });
});

test('bewaking: een handmatig verwijderde back-up geeft 24 uur een waarschuwing', async () => {
  const db = openDb();
  const tenantId = createStore(db).ensureTenant().id;
  const check = createMonitoringChecks({ db, backupDir: os.tmpdir(), runtimeStats: false }).find((entry) => entry.key === 'backup-verwijderd');
  assert.ok(check);
  const now = Date.now();
  /**
   * Voert de controle uit op een tijdstip.
   * @param {number} at Het tijdstip in ms.
   * @returns {Promise<object>} De uitkomst.
   */
  const run = (at) => check.run({ tenantId, now: () => at });
  assert.deepStrictEqual(await run(now), { ok: true });
  db.prepare("INSERT INTO audit (id, tenant_id, action, detail, created_at) VALUES (?, ?, 'backup_verwijderd', '{}', ?)").run(crypto.randomUUID(), tenantId, new Date(now).toISOString());
  assert.strictEqual((await run(now)).severity, 'waarschuwing');
  assert.deepStrictEqual(await run(now + 25 * 3600 * 1000), { ok: true });
});

test('een geopende back-up wordt hergebruikt, blijft bij gebruik staan en wordt na de bewaartijd gesloten', async () => {
  let clock = 1000;
  const cache = createBackupOpenCache({ ttlMs: 100, sweepMs: 3600 * 1000, now: () => clock });
  let opened = 0;
  let closed = 0;
  /**
   * Nep-opening van een back-up.
   * @returns {Promise<object>} Een geopende back-up.
   */
  const open = async () => { opened += 1; return { db: {}, close: () => { closed += 1; } }; };
  try {
    await cache.use('a', open, async () => {});
    await cache.use('a', open, async () => {});
    assert.strictEqual(opened, 1);
    clock += 50; cache.sweep();
    assert.strictEqual(closed, 0);
    clock += 100;
    await cache.use('a', open, async () => { clock += 500; cache.sweep(); assert.strictEqual(closed, 0, 'in gebruik'); });
    clock += 500; cache.sweep();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(closed, 1);
    await assert.rejects(cache.use('kapot', async () => { throw new Error('stuk'); }, async () => {}), /stuk/);
    assert.strictEqual(cache.size(), 0, 'een mislukte opening wordt niet bewaard');
  } finally { cache.close(); }
});
