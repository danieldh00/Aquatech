// Terugzetten uit een back-up via de API: alleen hoofdbeheerders, wachtwoord opnieuw, veiligheidsback-up en audit, en een record
// van een andere organisatie is niet te zien of terug te zetten.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { listen, createClient } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const BASE = '/app/api/admin/backups';
const NOW = '2026-11-01T10:00:00.000Z';

/**
 * De regels van de offerte voor de tests (twee regels).
 * @returns {object} De gegevens van de offerte.
 */
function quoteData() {
  return { lines: [
    { id: 'l1', section: 'materiaal', code: 'A', description: 'Pomp', qty: 1, unit: 'stuk', price: 100, vat: 21 },
    { id: 'l2', section: 'arbeid', code: '', description: 'Aanleg', qty: 2, unit: 'uur', price: 50, vat: 21 },
  ] };
}

/**
 * Start een app met een back-upmap, een hoofdbeheerder, een gewone beheerder en een offerte in de eigen en in een andere organisatie.
 * @returns {Promise<object>} db, dir, baas (hoofdbeheerder), jan (beheerder), base, server en cleanup().
 */
async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-restore-routes-'));
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  const { user: baas } = await store.createAccount(tenantId, { username: 'baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(tenantId, { username: 'jan', role: 'beheerder', password: PW });
  const otherTenantId = 'andere-organisatie';
  db.prepare("INSERT INTO tenants (id, slug, name, created_at, environment) VALUES (?, 'ander', 'Ander', ?, 'live')").run(otherTenantId, NOW);
  const data = JSON.stringify(quoteData());
  db.prepare("INSERT INTO quotes (id, tenant_id, owner_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at) VALUES ('qa', ?, ?, 'O2026-0001', 'concept', 'Tuin', 'Jansen', 200, 242, ?, ?, ?)").run(tenantId, baas.id, data, NOW, NOW);
  db.prepare("INSERT INTO quotes (id, tenant_id, owner_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at) VALUES ('qx', ?, ?, 'O-ANDER-1', 'concept', 'Elders', 'X', 200, 242, ?, ?, ?)").run(otherTenantId, baas.id, data, NOW, NOW);
  const app = createApp({ secret: SECRET, db, loginDelayMs: 0, env: { MULTITENANCY: '1' }, backupDir: dir });
  const { server, base } = await listen(app);
  const baasClient = createClient(base, { followRedirects: false });
  await baasClient.post('/app/api/auth/login', { username: 'baas', password: PW });
  const janClient = createClient(base, { followRedirects: false });
  await janClient.post('/app/api/auth/login', { username: 'jan', password: PW });
  return { db, dir, base, baas: baasClient, jan: janClient, server, cleanup() { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * Het aantal regels van offerte qa.
 * @param {object} world De uitkomst van start().
 * @returns {number} Het aantal regels.
 */
function lineCount(world) {
  return JSON.parse(world.db.prepare("SELECT data FROM quotes WHERE id = 'qa'").get().data).lines.length;
}

test('alleen een hoofdbeheerder mag de regelroutes gebruiken', async () => {
  const world = await start();
  try {
    const made = await world.baas.post(BASE);
    assert.strictEqual(made.status, 201);
    const body = { backup: made.body.name, kind: 'quote', id: 'qa' };
    assert.strictEqual((await world.jan.post(`${BASE}/restore/lines/preview`, body)).status, 403);
    assert.strictEqual((await world.jan.post(`${BASE}/restore/lines/apply`, { ...body, keys: ['l1'], password: PW })).status, 403);
    assert.strictEqual((await world.jan.get(`${BASE}/restore/kinds`)).status, 403);
    const anonymous = createClient(world.base, { followRedirects: false });
    assert.ok([401, 403].includes((await anonymous.post(`${BASE}/restore/lines/preview`, body)).status));
  } finally { world.cleanup(); }
});

test('een verkeerd wachtwoord wijzigt niets; het goede zet de regel terug, met veiligheidsback-up en audit', async () => {
  const world = await start();
  try {
    const made = await world.baas.post(BASE);
    const data = quoteData();
    data.lines.pop();
    world.db.prepare("UPDATE quotes SET data = ? WHERE id = 'qa'").run(JSON.stringify(data));
    const target = { backup: made.body.name, kind: 'quote', id: 'qa', keys: ['l2'] };
    const view = await world.baas.post(`${BASE}/restore/lines/preview`, target);
    assert.deepStrictEqual(view.body.lines.map((line) => [line.key, line.state]), [['l1', 'gelijk'], ['l2', 'ontbreekt']]);
    const wrong = await world.baas.post(`${BASE}/restore/lines/apply`, { ...target, password: 'Fout-wachtwoord-2026!' });
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(lineCount(world), 1, 'niets gewijzigd');
    const before = fs.readdirSync(world.dir).length;
    const done = await world.baas.post(`${BASE}/restore/lines/apply`, { ...target, password: PW });
    assert.strictEqual(done.status, 200, done.text);
    assert.strictEqual(done.body.restored, 1);
    assert.strictEqual(lineCount(world), 2);
    assert.ok(fs.readdirSync(world.dir).length > before, 'er is vooraf een nieuwe back-up gemaakt');
    assert.ok(done.body.safetyBackup);
    const audit = world.db.prepare("SELECT action FROM audit WHERE action IN ('backup_regels_teruggezet', 'backup_terugzetten_wachtwoord_fout')").all().map((row) => row.action).sort();
    assert.deepStrictEqual(audit, ['backup_regels_teruggezet', 'backup_terugzetten_wachtwoord_fout']);
  } finally { world.cleanup(); }
});

test('een record van een andere organisatie is niet te zien en niet terug te zetten', async () => {
  const world = await start();
  try {
    const made = await world.baas.post(BASE);
    world.db.prepare("UPDATE quotes SET data = '{\"lines\":[]}' WHERE id = 'qx'").run();
    const target = { backup: made.body.name, kind: 'quote', id: 'qx', keys: ['l1'] };
    const view = await world.baas.post(`${BASE}/restore/lines/preview`, target);
    assert.strictEqual(view.status, 200);
    assert.match(view.body.blocked, /niet in de back-up/);
    assert.deepStrictEqual(view.body.lines, []);
    const done = await world.baas.post(`${BASE}/restore/lines/apply`, { ...target, password: PW });
    assert.strictEqual(done.status, 409);
    assert.strictEqual(JSON.parse(world.db.prepare("SELECT data FROM quotes WHERE id = 'qx'").get().data).lines.length, 0, 'de andere organisatie is ongemoeid');
  } finally { world.cleanup(); }
});
