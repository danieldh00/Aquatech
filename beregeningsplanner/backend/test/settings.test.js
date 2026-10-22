const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const PG = Boolean(process.env.TEST_DATABASE_URL); // testsuite tegen PostgreSQL

const { createStore } = require('../src/platform/store');
const { createSettings, SettingsError } = require('../src/platform/settings');
const { createVault } = require('../src/beveiliging/vault');
const crypto = require('crypto');
const { createClient } = require('./helpers/http-client');

const SECRET = 'z'.repeat(64);
const KEY = 'sk-ant-test-0123456789abcdefWXYZ';

// Nep-AI: geen echte aanroepen; available volgt de sleutel zoals de echte.
function fakeAnalyzerFactory(calls = []) {
  return ({ apiKey }) => ({
    available: Boolean(apiKey),
    analyze: async () => ({ scale: {}, areas: [], elements: [], notes: '' }),
    check: async () => { calls.push(apiKey); return { ok: true, model: 'test' }; },
  });
}

function start(opts = {}) {
  return new Promise((resolve) => {
    const app = createApp({ accessCode: 'geheim', secret: SECRET, db: openDb(), createAnalyzer: fakeAnalyzerFactory(), ...opts });
    const server = app.listen(0, () => resolve({ app, server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function admin(base, code = 'geheim') {
  const c = createClient(base);
  const r = await c.post('/api/auth/login', { code });
  assert.strictEqual(r.status, 200);
  return c;
}

function freshSettings(opts = {}) {
  const db = openDb();
  const tenant = createStore(db).ensureTenant();
  return createSettings({ db, tenantId: tenant.id, ...opts });
}

test('volgorde: database > omgeving > standaard', () => {
  const s = freshSettings({ env: { AI_DAILY_LIMIT: '12', ANTHROPIC_API_KEY: 'uit-env-1234567890abcdef' } });
  assert.strictEqual(s.get('aiDailyLimit'), 12);
  assert.strictEqual(s.view().aiDailyLimit.source, 'omgeving');
  assert.strictEqual(s.get('guestAccess'), false);
  assert.strictEqual(s.get('anthropicApiKey'), 'uit-env-1234567890abcdef');
  assert.strictEqual(s.view().anthropicApiKey.source, 'omgeving');
  assert.strictEqual(s.get('aiHourlyPerIp'), 10);
  assert.strictEqual(s.get('aiEnabled'), true);
  s.update({ aiDailyLimit: 40 });
  assert.strictEqual(s.get('aiDailyLimit'), 40);
  assert.strictEqual(s.view().aiDailyLimit.source, 'instellingen');
  assert.strictEqual(s.get('aiDailyLimit', true), 12);
  s.update({ reset: ['aiDailyLimit'] });
  assert.strictEqual(s.get('aiDailyLimit'), 12);
});

test('geheimen komen nooit volledig in het overzicht', () => {
  const s = freshSettings();
  s.update({ anthropicApiKey: KEY, accessCode: 'abcd1234' });
  const view = JSON.stringify(s.view());
  assert.ok(!view.includes(KEY));
  assert.ok(!view.includes('abcd1234'));
  assert.deepStrictEqual(s.view().anthropicApiKey, { set: true, source: 'instellingen', hint: '…WXYZ' });
  assert.deepStrictEqual(s.view().accessCode, { set: true, source: 'instellingen' });
  // Leegmaken is een bewuste waarde en gaat voor op de startwaarde.
  s.update({ anthropicApiKey: '' });
  assert.strictEqual(s.view().anthropicApiKey.set, false);
});

test('ongeldige waarden worden geweigerd', () => {
  const s = freshSettings();
  assert.throws(() => s.update({ aiDailyLimit: 9999 }), SettingsError);
  assert.throws(() => s.update({ aiDailyLimit: '5' }), SettingsError);
  assert.throws(() => s.update({ accessCode: 'ab' }), SettingsError);
  assert.throws(() => s.update({ aiEnabled: 'ja' }), SettingsError);
  assert.throws(() => s.update({ onbekend: 1 }), SettingsError);
  assert.strictEqual(s.get('aiDailyLimit'), 30);
});

test('instellingen blijven bewaard na een herstart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-settings-'));
  const file = path.join(dir, 'aquatech.db');
  try {
    const vault = createVault(crypto.randomBytes(32));
    let db = openDb(file);
    let tenant = createStore(db).ensureTenant();
    createSettings({ db, tenantId: tenant.id, vault }).update({ anthropicApiKey: KEY, modules: { planning: false } });
    // De sleutel staat versleuteld in de database, niet als leesbare tekst.
    assert.ok(!db.prepare('SELECT value FROM settings').all().some((r) => r.value.includes(KEY)));
    db.close();
    if (!PG) assert.ok(!fs.readFileSync(file).includes(KEY));
    db = openDb(file);
    tenant = createStore(db).ensureTenant();
    // Met een andere hoofdsleutel is het geheim onbruikbaar (en wordt het genegeerd).
    assert.strictEqual(createSettings({ db, tenantId: tenant.id, vault: createVault(crypto.randomBytes(32)) }).get('anthropicApiKey'), '');
    const s = createSettings({ db, tenantId: tenant.id, vault });
    assert.strictEqual(s.get('anthropicApiKey'), KEY);
    assert.deepStrictEqual(s.get('modules'), { planning: false });
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('instellingen-API alleen voor beheerders', async () => {
  const { server, base } = await start();
  try {
    const anon = createClient(base);
    assert.strictEqual((await anon.get('/api/admin/settings')).status, 401);
    assert.strictEqual((await anon.put('/api/admin/settings', { aiEnabled: false })).status, 401);
    const a = await admin(base);
    // Een gewoon gebruikersaccount mag het niet.
    const u = await a.post('/api/admin/users', { username: 'jan', displayName: 'Jan', role: 'gebruiker', password: 'Tuin-Plan-2026!', mustChangePassword: false });
    assert.strictEqual(u.status, 201);
    const jan = createClient(base);
    assert.strictEqual((await jan.post('/api/auth/login', { username: 'jan', password: 'Tuin-Plan-2026!' })).status, 200);
    assert.strictEqual((await jan.get('/api/admin/settings')).status, 403);
    const r = await a.get('/api/admin/settings');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.settings.accessCode.set, true);
    assert.strictEqual(r.body.via, 'code');
  } finally {
    server.close();
  }
});

test('API-sleutel instellen werkt meteen en gaat nooit terug naar de browser', async () => {
  const calls = [];
  const { server, base } = await start({ createAnalyzer: fakeAnalyzerFactory(calls) });
  try {
    const a = await admin(base);
    assert.strictEqual((await a.get('/api/plan/status')).body.available, false);
    const r = await a.put('/api/admin/settings', { anthropicApiKey: `  ${KEY}  ` });
    assert.strictEqual(r.status, 200);
    assert.ok(!r.text.includes(KEY));
    assert.strictEqual(r.body.settings.anthropicApiKey.hint, '…WXYZ');
    assert.deepStrictEqual(r.body.changed, ['anthropicApiKey']);
    assert.ok(!(await a.get('/api/admin/settings')).text.includes(KEY));
    assert.strictEqual((await a.get('/api/plan/status')).body.available, true);
    assert.strictEqual((await a.get('/api/config')).body.ai, true);
    const t = await a.post('/api/admin/settings/test-ai');
    assert.strictEqual(t.status, 200);
    assert.deepStrictEqual(calls, [KEY]);
    // AI uitzetten: status zegt niet beschikbaar en analyseren wordt geweigerd.
    await a.put('/api/admin/settings', { aiEnabled: false });
    assert.strictEqual((await a.get('/api/plan/status')).body.available, false);
    const img = { image: 'data:image/png;base64,iVBORw0KGgo=', width: 10, height: 10 };
    const an = await a.post('/api/plan/analyze', img);
    assert.strictEqual(an.status, 409);
    assert.strictEqual(an.body.error, 'disabled');
  } finally {
    server.close();
  }
});

test('daglimiet uit de instellingen geldt meteen', async () => {
  const { server, base } = await start({ anthropicApiKey: KEY });
  try {
    const a = await admin(base);
    assert.strictEqual((await a.put('/api/admin/settings', { aiDailyLimit: 1 })).status, 200);
    const img = { image: 'data:image/png;base64,iVBORw0KGgo=', width: 10, height: 10 };
    assert.strictEqual((await a.post('/api/plan/analyze', img)).status, 200);
    const second = await a.post('/api/plan/analyze', { ...img, fresh: true });
    assert.strictEqual(second.status, 429);
    assert.strictEqual(second.body.error, 'daily_limit');
    // dezelfde tekening nog eens: bewaarde herkenning, telt niet mee voor de daglimiet
    const again = await a.post('/api/plan/analyze', img);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.recognition.cached, true);
    const bad = await a.put('/api/admin/settings', { aiDailyLimit: 100000 });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.field, 'aiDailyLimit');
  } finally {
    server.close();
  }
});

test('nieuwe toegangscode: andere toestellen uit, de beheerder blijft ingelogd', async () => {
  const { server, base } = await start();
  try {
    const a = await admin(base);
    const other = await admin(base);
    const r = await a.put('/api/admin/settings', { accessCode: 'nieuwecode' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await a.get('/api/admin/settings')).status, 200);
    assert.strictEqual((await other.get('/api/admin/settings')).status, 401);
    assert.strictEqual((await createClient(base).post('/api/auth/login', { code: 'geheim' })).status, 401);
    assert.strictEqual((await createClient(base).post('/api/auth/login', { code: 'nieuwecode' })).status, 200);
  } finally {
    server.close();
  }
});

test('wie met de toegangscode beheert, kan die niet leegmaken', async () => {
  const { server, base } = await start();
  try {
    const a = await admin(base);
    const r = await a.put('/api/admin/settings', { accessCode: '' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.field, 'accessCode');
    const reset = await a.put('/api/admin/settings', { reset: ['accessCode'] });
    // Startwaarde is 'geheim' (uit de opstartparameters), dus terugzetten mag.
    assert.strictEqual(reset.status, 200);
    // Met een beheerdersaccount mag het wel.
    await a.post('/api/admin/users', { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!', mustChangePassword: false });
    const baas = createClient(base);
    await baas.post('/api/auth/login', { username: 'baas', password: 'Tuin-Plan-2026!' });
    assert.strictEqual((await baas.put('/api/admin/settings', { accessCode: '' })).status, 200);
    assert.strictEqual((await createClient(base).get('/api/auth/status')).body.configured, false);
  } finally {
    server.close();
  }
});

test('modules aan/uit via /api/config', async () => {
  const { server, base } = await start();
  try {
    const a = await admin(base);
    assert.deepStrictEqual((await a.get('/api/config')).body.modules, {});
    await a.put('/api/admin/settings', { modules: { planning: false } });
    await a.put('/api/admin/settings', { modules: { voorraad: false } });
    assert.deepStrictEqual((await a.get('/api/config')).body.modules, { planning: false, voorraad: false });
    const bad = await a.put('/api/admin/settings', { modules: ['x'] });
    assert.strictEqual(bad.status, 400);
  } finally {
    server.close();
  }
});
