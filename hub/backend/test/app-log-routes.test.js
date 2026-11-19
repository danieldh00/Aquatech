// Tests voor de routes van Beheer > Systeem > Logboek (platform/app-log-routes.js) op een kleine Express-app met een echt
// logboek: rechten, tenant-isolatie, platformregels alleen met canPlatform, filters, zoeken, paginering en limieten.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { openDb } = require('../src/database/db');
const { createAppLog } = require('../src/platform/app-log');
const { registerAppLogRoutes } = require('../src/platform/app-log-routes');
const { createClient, listen } = require('./helpers/http-client');

const MAIN = 'tenant-hoofd';
const OTHER = 'tenant-ander';

/**
 * Bouwt een testserver met een logboek met voorbeeldregels in twee omgevingen.
 * @returns {Promise<{ http: object, appLog: object, close: Function }>} Client, logboek en afsluiter.
 */
async function setup() {
  const db = openDb();
  for (const [id, slug] of [[MAIN, 'hoofd'], [OTHER, 'ander']]) db.prepare("INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, '2026-01-01')").run(id, slug, slug);
  let clock = Date.parse('2026-11-19T10:00:00Z');
  const appLog = createAppLog({ db, mainTenantId: MAIN, flushMs: 0, now: () => { clock += 1000; return clock; }, write: () => {} });
  appLog.error('fout', 'POST /app/api/quotes', { tenantId: MAIN, requestId: 'aaaa1111bbbb', errorCode: 'e1e2e3e4' });
  appLog.warn('traag', 'GET /app/api/plans (200)', { tenantId: MAIN, durationMs: 1500 });
  appLog.warn('traag', 'GET /app/api/orders (200)', { tenantId: OTHER });
  appLog.warn('stilstand', 'Hoofdthread stond 2000 ms stil');
  appLog.info('bewaking', 'Opgelost: Mail', { tenantId: MAIN });
  appLog.flush();
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: req.headers['x-user'] || 'u1', rights: String(req.headers['x-rights'] || 'beheer').split(',') };
    req.tenantId = req.headers['x-tenant'] || MAIN;
    req.platform = req.headers['x-platform'] === '1';
    next();
  });
  app.use('/api/admin', (req, res, next) => (req.user.rights.includes('beheer') ? next() : res.status(403).json({ error: 'forbidden' })));
  registerAppLogRoutes(app, { appLog, canPlatform: (req) => req.platform, environmentIds: () => [MAIN, OTHER] });
  const { server, base } = await listen(app);
  return { http: createClient(base), appLog, close: () => server.close() };
}

test('zonder recht beheer: 403', async () => {
  const { http, close } = await setup();
  try {
    assert.strictEqual((await http.get('/api/admin/logs', { 'x-rights': 'klanten' })).status, 403);
  } finally { close(); }
});

test('een beheerder ziet alleen regels van de eigen omgeving, zonder platformregels', async () => {
  const { http, close } = await setup();
  try {
    const result = await http.get('/api/admin/logs');
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body.items.map((item) => item.source).sort(), ['bewaking', 'fout', 'traag']);
    assert.ok(result.body.items.every((item) => item.scope === 'tenant'));
    assert.deepStrictEqual(result.body.environments, []);
    const other = await http.get('/api/admin/logs', { 'x-tenant': OTHER });
    assert.deepStrictEqual(other.body.items.map((item) => item.message), ['GET /app/api/orders (200)']);
  } finally { close(); }
});

test('een andere omgeving kiezen of platformregels zien kan alleen met canPlatform', async () => {
  const { http, close } = await setup();
  try {
    assert.strictEqual((await http.get(`/api/admin/logs?tenant=${OTHER}`)).status, 404);
    const platform = await http.get('/api/admin/logs', { 'x-platform': '1' });
    assert.ok(platform.body.items.some((item) => item.source === 'stilstand'));
    assert.deepStrictEqual(platform.body.environments, [MAIN, OTHER]);
    const other = await http.get(`/api/admin/logs?tenant=${OTHER}`, { 'x-platform': '1' });
    assert.deepStrictEqual(other.body.items.map((item) => item.source), ['traag']);
    assert.strictEqual((await http.get('/api/admin/logs?tenant=bestaat-niet', { 'x-platform': '1' })).status, 404);
  } finally { close(); }
});

test('filters op niveau en bron, zoeken op tekst, request-id en foutcode', async () => {
  const { http, close } = await setup();
  try {
    assert.deepStrictEqual((await http.get('/api/admin/logs?level=error')).body.items.map((item) => item.source), ['fout']);
    assert.deepStrictEqual((await http.get('/api/admin/logs?level=warn,error')).body.items.length, 2);
    assert.deepStrictEqual((await http.get('/api/admin/logs?source=bewaking')).body.items.length, 1);
    assert.strictEqual((await http.get('/api/admin/logs?q=aaaa1111bbbb')).body.items.length, 1);
    assert.strictEqual((await http.get('/api/admin/logs?q=e1e2e3e4')).body.items[0].source, 'fout');
    assert.strictEqual((await http.get('/api/admin/logs?q=PLANS')).body.items.length, 1);
    assert.strictEqual((await http.get('/api/admin/logs?q=100%25')).body.items.length, 0);
    assert.strictEqual((await http.get('/api/admin/logs?from=2999-01-01')).body.items.length, 0);
  } finally { close(); }
});

test('paginering met een cursor geeft elke regel één keer, nieuwste eerst', async () => {
  const { http, close } = await setup();
  try {
    const first = await http.get('/api/admin/logs?limit=2');
    assert.strictEqual(first.body.items.length, 2);
    assert.ok(first.body.next);
    const second = await http.get(`/api/admin/logs?limit=2&before=${encodeURIComponent(first.body.next)}`);
    assert.strictEqual(second.body.items.length, 1);
    assert.strictEqual(second.body.next, null);
    const all = [...first.body.items, ...second.body.items];
    assert.strictEqual(new Set(all.map((item) => item.id)).size, 3);
    assert.deepStrictEqual(all.map((item) => item.at), [...all.map((item) => item.at)].sort().reverse());
  } finally { close(); }
});
