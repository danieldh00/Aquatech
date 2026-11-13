// Bewaking in de echte app: routes onder /app/api/admin/monitoring, controles die echt draaien (database, schijf)
// en rechten (installateur krijgt 403).
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createApp } = require('../src/server');
const { createClient, listen } = require('./helpers/http-client');

const PASSWORD = 'Tuin-Plan-2026!';
const SECRET = 'test-secret-test-secret-test-secret';

test('bewaking in de app: overzicht, controle nu, instelling bewaren, testmelding en rechten', async () => {
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  await store.createAccount(tenantId, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PASSWORD, mustChangePassword: false });
  await store.createAccount(tenantId, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PASSWORD, mustChangePassword: false });
  const { server, base } = await listen(createApp({ secret: SECRET, db, loginDelayMs: 0 }));
  try {
    const admin = createClient(base);
    assert.strictEqual((await admin.post('/app/api/auth/login', { username: 'baas', password: PASSWORD })).status, 200);
    const overview = await admin.get('/app/api/admin/monitoring');
    assert.strictEqual(overview.status, 200);
    assert.strictEqual(overview.body.canPlatform, true);
    const keys = overview.body.checks.map((check) => check.key);
    assert.ok(keys.includes('database'), 'platformcontroles staan erin');

    const run = await admin.post('/app/api/admin/monitoring/run', {});
    assert.strictEqual(run.status, 200);
    const after = await admin.get('/app/api/admin/monitoring');
    const database = after.body.checks.find((check) => check.key === 'database');
    assert.strictEqual(database.status, 'ok');

    const insecure = await admin.request('PUT', '/app/api/admin/monitoring/config', { webhookUrl: 'http://onveilig.example.nl/x' });
    assert.strictEqual(insecure.status, 400, 'een http-webhook wordt geweigerd');
    const saved = await admin.request('PUT', '/app/api/admin/monitoring/config', { recipients: ['beheer@example.nl'], reminderHours: 12 });
    assert.strictEqual(saved.status, 200);
    const again = await admin.get('/app/api/admin/monitoring');
    assert.deepStrictEqual(again.body.config.recipients, ['beheer@example.nl']);
    assert.strictEqual(again.body.config.reminderHours, 12);

    const test = await admin.post('/app/api/admin/monitoring/test', {});
    assert.strictEqual(test.status, 200);
    assert.strictEqual(test.body.mail.ok, false, 'zonder mailserver geen mail, wel een duidelijke uitkomst');

    const staff = createClient(base);
    assert.strictEqual((await staff.post('/app/api/auth/login', { username: 'monteur', password: PASSWORD })).status, 200);
    assert.strictEqual((await staff.get('/app/api/admin/monitoring')).status, 403);
    assert.strictEqual((await createClient(base).get('/app/api/admin/monitoring')).status, 401);
  } finally {
    server.close();
  }
});
