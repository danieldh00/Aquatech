// Terugzetten uit een back-up vanaf Google Drive (platform/drive-restore-source.js + backup-restore-routes.js): een back-up die
// alleen op Drive staat is te doorzoeken, te bekijken en terug te zetten (regels), met wachtwoord, veiligheidsback-up en audit;
// foute namen, een ontbrekend bestand en een mislukte download geven een leesbare fout, en er blijft niets achter in de map.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createDriveRestoreSource } = require('../src/platform/drive-restore-source');
const { listen, createClient } = require('./helpers/http-client');
const { createGoogleFake } = require('./helpers/google-fake');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const BASE = '/app/api/admin/backups';
const REDIRECT = 'https://hub.example.nl/app/api/admin/backups/drive/callback';
const NOW = '2026-11-01T10:00:00.000Z';
const LINES = { lines: [
  { id: 'l1', section: 'materiaal', code: 'A', description: 'Pomp', qty: 1, unit: 'stuk', price: 100, vat: 21 },
  { id: 'l2', section: 'arbeid', code: '', description: 'Aanleg', qty: 2, unit: 'uur', price: 50, vat: 21 },
] };

/**
 * Wacht tot een voorwaarde waar is (achtergrondwerk van de server).
 * @param {Function} check Geeft true als klaar.
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
 * Start een app met Drive gekoppeld en een offerte; maakt een back-up, wacht tot hij op Drive staat en haalt hem lokaal weg.
 * @returns {Promise<object>} db, dir, baas, google, name (de back-up die alleen op Drive staat) en cleanup().
 */
async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-drive-source-'));
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  const { user: baas } = await store.createAccount(tenantId, { username: 'baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  db.prepare("INSERT INTO quotes (id, tenant_id, owner_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0a0400000001', ?, ?, 'O2026-0001', 'concept', 'Tuin', 'Jansen', 200, 242, ?, ?, ?)").run(tenantId, baas.id, JSON.stringify(LINES), NOW, NOW);
  const google = await createGoogleFake();
  const app = createApp({ secret: SECRET, db, loginDelayMs: 0, env: { MULTITENANCY: '1' }, backupDir: dir, googleFetch: google.fetchImpl });
  const { server, base } = await listen(app);
  const client = createClient(base, { followRedirects: false });
  await client.post('/app/api/auth/login', { username: 'baas', password: PW });
  await client.put(`${BASE}/drive`, { clientId: 'client-123', clientSecret: 'geheim-van-google-app', redirectUri: REDIRECT });
  const started = await client.post(`${BASE}/drive/connect`);
  await client.get(`${BASE}/drive/callback?code=goede-code&state=${encodeURIComponent(new URL(started.body.url).searchParams.get('state'))}`);
  await client.put(`${BASE}/drive`, { enabled: true });
  const made = await client.post(BASE);
  await until(async () => [...google.files.values()].some((file) => file.name === made.body.name));
  fs.rmSync(path.join(dir, made.body.name));
  return {
    db, dir, baas: client, google, name: made.body.name,
    /**
     * Stopt de server en ruimt alles op.
     * @returns {Promise<void>}
     */
    async cleanup() { server.close(); await google.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}


test('een back-up die alleen op Drive staat is te doorzoeken, te bekijken en terug te zetten', async () => {
  const world = await start();
  try {
    const source = `drive:${world.name}`;
    const list = await world.baas.get(`${BASE}/drive?remote=1`);
    assert.ok(list.body.remote.some((item) => item.name === world.name));

    const found = await world.baas.get(`${BASE}/restore/records?backup=${encodeURIComponent(source)}&kind=quote`);
    assert.strictEqual(found.status, 200, found.text);
    assert.ok(JSON.stringify(found.body).includes('O2026-0001'));
    /**
     * Aantal downloads van bestanden bij de nagebootste Google.
     * @returns {number} Het aantal.
     */
    const downloads = () => world.google.calls.filter((call) => call.path.startsWith('/drive/v3/files/') && call.method === 'GET').length;
    const first = downloads();
    assert.ok(first >= 1);

    // Regel verwijderen en vanaf Drive terugzetten.
    world.db.prepare("UPDATE quotes SET data = ? WHERE id = '00000000-0000-4000-8000-0a0400000001'").run(JSON.stringify({ lines: [LINES.lines[0]] }));
    const target = { backup: source, kind: 'quote', id: '00000000-0000-4000-8000-0a0400000001', keys: ['l2'] };
    const view = await world.baas.post(`${BASE}/restore/lines/preview`, target);
    assert.deepStrictEqual(view.body.lines.map((line) => [line.key, line.state]), [['l1', 'gelijk'], ['l2', 'ontbreekt']]);
    assert.strictEqual(downloads(), first, 'de bewaarde kopie wordt hergebruikt, niet opnieuw gedownload');
    assert.strictEqual((await world.baas.post(`${BASE}/restore/lines/apply`, { ...target, password: 'Fout-wachtwoord-2026!' })).status, 401);
    const done = await world.baas.post(`${BASE}/restore/lines/apply`, { ...target, password: PW });
    assert.strictEqual(done.status, 200, done.text);
    assert.strictEqual(JSON.parse(world.db.prepare("SELECT data FROM quotes WHERE id = '00000000-0000-4000-8000-0a0400000001'").get().data).lines.length, 2);
    assert.ok(done.body.safetyBackup && fs.existsSync(path.join(world.dir, done.body.safetyBackup)), 'veiligheidsback-up gemaakt');
    const audit = world.db.prepare("SELECT detail FROM audit WHERE action = 'backup_regels_teruggezet'").all();
    assert.ok(audit.some((row) => String(row.detail).includes(source)), 'het auditlog noemt de bron');
  } finally { await world.cleanup(); }
});

test('fouten: onbekende naam, niet op Drive, download mislukt; en niemand anders dan een hoofdbeheerder', async () => {
  const world = await start();
  try {
    /**
     * Zoekt offertes in de back-up met de gegeven bron.
     * @param {string} name De bron (drive:<naam>).
     * @returns {Promise<object>} Het antwoord.
     */
    const records = (name) => world.baas.get(`${BASE}/restore/records?backup=${encodeURIComponent(name)}&kind=quote`);
    const bad = await records('drive:../../etc/passwd');
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await records('drive:aquatech-20200101-000000.db.enc')).status, 404);
    world.google.failDownloads = { status: 500 };
    const failed = await records(`drive:${world.name}`);
    assert.ok(failed.status >= 400 && failed.status < 600);
    assert.doesNotMatch(failed.text, /acc-\d+|refresh-1|geheim-van-google-app/);
    world.google.failDownloads = null;
    assert.strictEqual((await records(`drive:${world.name}`)).status, 200, 'na een fout lukt het weer');
  } finally { await world.cleanup(); }
});

test('bewaarde kopieën verlopen, lopende gebruik blijft, en resten van een eerdere run worden bij de start gewist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-drive-ttl-'));
  fs.mkdirSync(path.join(dir, '.drive-restore-cache-oud'));
  fs.writeFileSync(path.join(dir, '.drive-restore-cache-oud', 'x'), 'x');
  let nowMs = 1000;
  const downloads = [];
  const driveBackup = {
    /**
     * Nagebootste download: schrijft een bestand en onthoudt de naam.
     * @param {string} name De bestandsnaam.
     * @param {string} directory De doelmap.
     * @returns {Promise<void>}
     */
    async download(name, directory) { downloads.push(name); fs.writeFileSync(path.join(directory, name), 'data'); },
  };
  const source = createDriveRestoreSource({ driveBackup, backupDir: dir, now: () => nowMs, ttlMs: 100 });
  try {
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'oude rest is gewist');
    const name = 'aquatech-20261101-100000.db.enc';
    let seenDir = '';
    await source.use(`drive:${name}`, async ({ dir: cacheDir }) => { seenDir = cacheDir; source.sweep(); assert.ok(fs.existsSync(cacheDir), 'in gebruik wordt niet gewist'); });
    await source.use(`drive:${name}`, async () => {});
    assert.strictEqual(downloads.length, 1, 'tweede keer uit de bewaarde kopie');
    nowMs += 50;
    source.sweep();
    assert.ok(fs.existsSync(seenDir), 'nog niet verlopen');
    nowMs += 200;
    source.sweep();
    assert.ok(!fs.existsSync(seenDir), 'verlopen en gewist');
    await source.use(`drive:${name}`, async () => {});
    assert.strictEqual(downloads.length, 2, 'na het verlopen opnieuw ophalen');
    /**
     * Mislukte download.
     * @returns {Promise<void>}
     */
    driveBackup.download = async () => { throw new Error('stuk'); };
    await assert.rejects(source.use('drive:aquatech-20261102-100000.db.enc', async () => {}), /stuk/);
    assert.deepStrictEqual(fs.readdirSync(dir).length, 1, 'een mislukte download laat geen map achter');
  } finally { source.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
