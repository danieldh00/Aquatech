// Tests voor de routes van Beheer > Systeem > Bewaking (platform/monitoring-routes.js) tegen een nagebootste monitor
// op een kleine Express-app: rechten, tenant-isolatie van incidenten, platformbewaking alleen met canPlatform,
// limieten, saneren van de instelling en een auditlog zonder geheime adressen.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { registerMonitoringRoutes } = require('../src/platform/monitoring-routes');
const { catchAsync } = require('../src/platform/error-report');
const { createClient, listen } = require('./helpers/http-client');

const MAIN = 'tenant-hoofd';
const OTHER = 'tenant-ander';

/**
 * Een nagebootste monitor met vaste controles en incidenten per omgeving.
 * @returns {object} De monitor met calls (aanroepen) en configs (instelling per omgeving).
 */
function createFakeMonitor() {
  const calls = [];
  const configs = new Map();
  const incidents = [
    { id: 'p1', tenantId: MAIN, scope: 'platform', checkKey: 'database', severity: 'fout', state: 'open', title: 'Database bereikbaar', message: 'Geen verbinding', lastAt: '2026-11-13T10:00:00.000Z' },
    { id: 'm1', tenantId: MAIN, scope: 'tenant', checkKey: 'mail', severity: 'waarschuwing', state: 'open', title: 'E-mail', message: 'Mailserver weigert', lastAt: '2026-11-13T09:00:00.000Z' },
    { id: 'o1', tenantId: OTHER, scope: 'tenant', checkKey: 'mollie', severity: 'fout', state: 'open', title: 'Mollie', message: 'Sleutel ongeldig', lastAt: '2026-11-13T08:00:00.000Z' },
    { id: 'o2', tenantId: OTHER, scope: 'tenant', checkKey: 'visma', severity: 'waarschuwing', state: 'opgelost', title: 'Visma', message: 'Weer goed', lastAt: '2026-11-12T08:00:00.000Z' },
  ];
  /**
   * De standaardinstelling.
   * @returns {object} De instelling.
   */
  const defaults = () => ({ enabled: true, recipients: [], webhookUrl: '', heartbeatUrl: '', notifyRecovery: true, reminderHours: 24, muted: [],
    thresholds: { backupMaxHours: 36, diskMinFreePct: 10, diskMinFreeMb: 1024, errorsPerHour: 20, dbSlowMs: 2000 } });
  return {
    calls,
    configs,
    /**
     * De instelling van een omgeving.
     * @param {string} tenantId De omgeving.
     * @returns {object} De instelling.
     */
    config: (tenantId) => configs.get(tenantId) || defaults(),
    /**
     * De controles van een omgeving.
     * @param {string} tenantId De omgeving.
     * @param {string} scope platform of tenant.
     * @returns {object[]} De controles.
     */
    checkStates: (tenantId, scope) => (scope === 'platform'
      ? [{ key: 'database', title: 'Database bereikbaar', scope: 'platform', status: 'open', severity: 'fout' }, { key: 'schijf', title: 'Schijfruimte', scope: 'platform', status: 'ok' }]
      : [{ key: 'mail', title: 'E-mail', scope: 'tenant', status: tenantId === MAIN ? 'open' : 'ok' }, { key: 'mollie', title: 'Mollie', scope: 'tenant', status: 'overgeslagen' }]),
    /**
     * De incidenten van een omgeving, nieuwste eerst.
     * @param {string} tenantId De omgeving.
     * @param {object} options state, limit en before.
     * @returns {object[]} De incidenten.
     */
    list: (tenantId, { state, limit = 50, before } = {}) => {
      calls.push(['list', tenantId, state || '', before || '']);
      return incidents.filter((incident) => incident.tenantId === tenantId && (!state || incident.state === state) && (!before || incident.lastAt < before)).slice(0, limit);
    },
    /**
     * Voert de controles uit.
     * @param {object} options force, tenantId en platform.
     * @returns {Promise<object>} De uitkomst.
     */
    runAll: async (options) => { calls.push(['runAll', options]); return { ran: 3, opened: 0, resolved: 0 }; },
    /**
     * Verstuurt een testmelding.
     * @param {string} tenantId De omgeving.
     * @returns {Promise<object>} De uitkomst per kanaal.
     */
    sendTest: async (tenantId) => { calls.push(['sendTest', tenantId]); return { mail: { ok: true, message: 'Verstuurd' }, webhook: { ok: false, message: 'Geen webhook' }, heartbeat: { ok: true, message: 'Ping gelukt' } }; },
  };
}

/**
 * Start een testapp met de routes. Wie er inlogt, staat in de koppen x-user, x-tenant, x-rights en x-platform.
 * @returns {Promise<object>} server, base, monitor, audits, saved (opgeslagen instellingen) en client(koppen).
 */
async function start() {
  const app = express();
  catchAsync(app);
  const monitor = createFakeMonitor();
  const audits = [];
  const saved = [];
  app.use((req, _res, next) => {
    req.user = { id: req.headers['x-user'] || 'u1', rights: String(req.headers['x-rights'] || '').split(',') };
    req.tenantId = req.headers['x-tenant'] || MAIN;
    next();
  });
  app.use('/api/admin', (req, res, next) => (req.user.rights.includes('beheer') ? next() : res.status(403).json({ error: 'forbidden' })));
  registerMonitoringRoutes(app, {
    monitor,
    mainTenantId: MAIN,
    /**
     * Nagebootste instellingen: alleen de mailserver en het opslaan van monitoring.
     * @param {string} tenantId De omgeving.
     * @returns {object} get en update.
     */
    settingsFor: (tenantId) => ({
      get: (key) => (key === 'mailServer' && tenantId === MAIN ? { host: 'smtp.example.nl', from: 'app@example.nl' } : {}),
      update: (patch, userId) => { saved.push({ tenantId, patch, userId }); monitor.configs.set(tenantId, patch.monitoring); },
    }),
    audit: (req, action, detail) => audits.push({ tenantId: req.tenantId, action, detail }),
    requireJson: (req, res, next) => (req.is('application/json') ? next() : res.status(415).json({ error: 'json_required' })),
    canPlatform: (req) => req.headers['x-platform'] === '1',
  });
  app.use((error, _req, res, _next) => res.status(500).json({ error: 'internal', message: String(error && error.message) }));
  const { server, base } = await listen(app);
  /**
   * Een client die zich voordoet als een bepaalde gebruiker.
   * @param {object} headers De koppen (x-user, x-tenant, x-rights, x-platform).
   * @returns {object} get, put en post met die koppen.
   */
  const client = (headers) => {
    const http = createClient(base);
    return {
      get: (urlPath) => http.get(urlPath, headers),
      put: (urlPath, body) => http.request('PUT', urlPath, body, headers),
      post: (urlPath, body) => http.post(urlPath, body, headers),
    };
  };
  return { server, base, monitor, audits, saved, client };
}

const platformAdmin = { 'x-user': 'hoofd', 'x-tenant': MAIN, 'x-rights': 'beheer', 'x-platform': '1' };
const mainAdmin = { 'x-user': 'beheer-hoofd', 'x-tenant': MAIN, 'x-rights': 'beheer' };
const otherAdmin = { 'x-user': 'beheer-ander', 'x-tenant': OTHER, 'x-rights': 'beheer' };

test('zonder recht beheer: 403 op elke route', async () => {
  const world = await start();
  try {
    const noRight = world.client({ 'x-rights': 'werkorders' });
    assert.strictEqual((await noRight.get('/api/admin/monitoring')).status, 403);
    assert.strictEqual((await noRight.put('/api/admin/monitoring/config', { enabled: false })).status, 403);
    assert.strictEqual((await noRight.post('/api/admin/monitoring/run')).status, 403);
    assert.strictEqual((await noRight.post('/api/admin/monitoring/test')).status, 403);
    assert.strictEqual((await noRight.get('/api/admin/monitoring/incidents')).status, 403);
    assert.strictEqual(world.monitor.calls.length, 0);
  } finally {
    world.server.close();
  }
});

test('een andere omgeving ziet alleen haar eigen incidenten en geen platformbewaking', async () => {
  const world = await start();
  try {
    const view = (await world.client(otherAdmin).get('/api/admin/monitoring')).body;
    assert.strictEqual(view.canPlatform, false);
    assert.deepStrictEqual(view.incidents.map((incident) => incident.id), ['o1', 'o2']);
    assert.deepStrictEqual(view.open, { fout: 1, waarschuwing: 0 });
    assert.ok(view.checks.every((check) => check.scope === 'tenant'));
    assert.strictEqual(view.config.heartbeatUrl, undefined);
    assert.strictEqual(view.config.thresholds, undefined);
    assert.strictEqual(view.mailConfigured, false);
    assert.ok(world.monitor.calls.every((call) => call[0] !== 'list' || call[1] === OTHER), 'nooit de lijst van een andere omgeving opvragen');
    const list = (await world.client(otherAdmin).get('/api/admin/monitoring/incidents?state=open')).body;
    assert.deepStrictEqual(list.incidents.map((incident) => incident.id), ['o1']);
  } finally {
    world.server.close();
  }
});

test('platformincidenten alleen met canPlatform, ook in de hoofdtenant', async () => {
  const world = await start();
  try {
    const plain = (await world.client(mainAdmin).get('/api/admin/monitoring')).body;
    assert.deepStrictEqual(plain.incidents.map((incident) => incident.id), ['m1']);
    assert.deepStrictEqual(plain.open, { fout: 0, waarschuwing: 1 });
    assert.ok(!plain.checks.some((check) => check.scope === 'platform'));
    const history = (await world.client(mainAdmin).get('/api/admin/monitoring/incidents')).body;
    assert.deepStrictEqual(history.incidents.map((incident) => incident.id), ['m1']);

    const platform = (await world.client(platformAdmin).get('/api/admin/monitoring')).body;
    assert.strictEqual(platform.canPlatform, true);
    assert.deepStrictEqual(platform.incidents.map((incident) => incident.id), ['p1', 'm1']);
    assert.deepStrictEqual(platform.open, { fout: 1, waarschuwing: 1 });
    assert.deepStrictEqual(platform.checks.filter((check) => check.scope === 'platform').map((check) => check.key), ['database', 'schijf']);
    assert.strictEqual(platform.config.heartbeatUrl, '');
    assert.strictEqual(platform.mailConfigured, true);
  } finally {
    world.server.close();
  }
});

test('opslaan saneert de invoer en weigert ongeldige waarden', async () => {
  const world = await start();
  try {
    const admin = world.client(otherAdmin);
    const ok = await admin.put('/api/admin/monitoring/config', {
      recipients: 'Beheer@Voorbeeld.nl; beheer@voorbeeld.nl, tweede@voorbeeld.nl', webhookUrl: 'https://hooks.example.com/abc', reminderHours: '12',
      notifyRecovery: false, muted: ['mollie', 'bestaat-niet', 'database'], onbekend: 'x',
    });
    assert.strictEqual(ok.status, 200);
    const stored = world.saved.at(-1);
    assert.strictEqual(stored.tenantId, OTHER);
    assert.strictEqual(stored.userId, 'beheer-ander');
    assert.deepStrictEqual(stored.patch.monitoring.recipients, ['beheer@voorbeeld.nl', 'tweede@voorbeeld.nl']);
    assert.strictEqual(stored.patch.monitoring.webhookUrl, 'https://hooks.example.com/abc');
    assert.strictEqual(stored.patch.monitoring.reminderHours, 12);
    assert.strictEqual(stored.patch.monitoring.notifyRecovery, false);
    assert.deepStrictEqual(stored.patch.monitoring.muted, ['mollie'], 'onbekende sleutels en platformchecks vallen weg');
    assert.strictEqual(stored.patch.monitoring.onbekend, undefined);

    const cases = [
      { recipients: ['geen-adres'] },
      { recipients: ['a@b.nl', 'c@d.nl', 'e@f.nl', 'g@h.nl', 'i@j.nl', 'k@l.nl'] },
      { webhookUrl: 'http://hooks.example.com/abc' },
      { webhookUrl: 'https://gebruiker:geheim@hooks.example.com/' },
      { webhookUrl: 'javascript:alert(1)' },
      { webhookUrl: `https://hooks.example.com/${'a'.repeat(500)}` },
      { reminderHours: 169 },
      { reminderHours: 1.5 },
      { enabled: 'ja' },
      { muted: 'mollie' },
    ];
    for (const body of cases) {
      const response = await admin.put('/api/admin/monitoring/config', body);
      assert.strictEqual(response.status, 400, JSON.stringify(body));
      assert.ok(response.body.message);
    }
    assert.strictEqual((await world.client(otherAdmin).put('/api/admin/monitoring/config', [1, 2])).status, 400);
  } finally {
    world.server.close();
  }
});

test('heartbeat-URL en drempels alleen met canPlatform; anders genegeerd', async () => {
  const world = await start();
  try {
    world.monitor.configs.set(MAIN, { ...world.monitor.config(MAIN), heartbeatUrl: 'https://hc.example.com/oud', muted: ['database'] });
    const response = await world.client(mainAdmin).put('/api/admin/monitoring/config', {
      heartbeatUrl: 'https://hc.example.com/nieuw', thresholds: { backupMaxHours: 2 }, muted: ['mail'],
    });
    assert.strictEqual(response.status, 200);
    const stored = world.saved.at(-1).patch.monitoring;
    assert.strictEqual(stored.heartbeatUrl, 'https://hc.example.com/oud');
    assert.strictEqual(stored.thresholds.backupMaxHours, 36);
    assert.deepStrictEqual(stored.muted.sort(), ['database', 'mail'], 'het dempen van een platformcheck blijft staan');
    assert.strictEqual(response.body.config.heartbeatUrl, undefined);

    const platform = await world.client(platformAdmin).put('/api/admin/monitoring/config', {
      heartbeatUrl: 'https://hc.example.com/nieuw', thresholds: { backupMaxHours: 48, dbSlowMs: '3000' }, muted: [],
    });
    assert.strictEqual(platform.status, 200);
    const next = world.saved.at(-1).patch.monitoring;
    assert.strictEqual(next.heartbeatUrl, 'https://hc.example.com/nieuw');
    assert.strictEqual(next.thresholds.backupMaxHours, 48);
    assert.strictEqual(next.thresholds.dbSlowMs, 3000);
    assert.deepStrictEqual(next.muted, []);
    assert.strictEqual((await world.client(platformAdmin).put('/api/admin/monitoring/config', { thresholds: { diskMinFreePct: 0 } })).status, 400);
    assert.strictEqual((await world.client(platformAdmin).put('/api/admin/monitoring/config', { heartbeatUrl: 'ftp://hc.example.com' })).status, 400);
  } finally {
    world.server.close();
  }
});

test('auditlog zonder geheime adressen; niets gewijzigd = geen opslag', async () => {
  const world = await start();
  try {
    await world.client(platformAdmin).put('/api/admin/monitoring/config', { webhookUrl: 'https://hooks.example.com/services/GEHEIM-TOKEN', heartbeatUrl: 'https://hc.example.com/ping/GEHEIM-UUID', recipients: ['a@voorbeeld.nl'] });
    const entry = world.audits.find((item) => item.action === 'bewaking_instellingen');
    assert.ok(entry);
    const detail = JSON.stringify(entry.detail);
    assert.doesNotMatch(detail, /GEHEIM|hooks\.example|hc\.example|a@voorbeeld/);
    assert.strictEqual(entry.detail.webhook, true);
    assert.strictEqual(entry.detail.heartbeat, true);
    assert.strictEqual(entry.detail.ontvangers, 1);
    const savedBefore = world.saved.length;
    const auditsBefore = world.audits.length;
    assert.strictEqual((await world.client(platformAdmin).put('/api/admin/monitoring/config', { recipients: ['a@voorbeeld.nl'] })).status, 200);
    assert.strictEqual(world.saved.length, savedBefore);
    assert.strictEqual(world.audits.length, auditsBefore);
    assert.strictEqual((await createClient(world.base).request('PUT', '/api/admin/monitoring/config', undefined, { 'x-rights': 'beheer', 'content-type': 'text/plain' })).status, 415);
  } finally {
    world.server.close();
  }
});

test('nu controleren: alleen de eigen omgeving (platform alleen met canPlatform), limiet 6 per 10 minuten', async () => {
  const world = await start();
  try {
    const admin = world.client(otherAdmin);
    const first = await admin.post('/api/admin/monitoring/run');
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.ran, 3);
    assert.deepStrictEqual(world.monitor.calls.find((call) => call[0] === 'runAll')[1], { force: true, tenantId: OTHER, platform: false });
    for (let i = 0; i < 5; i += 1) assert.strictEqual((await admin.post('/api/admin/monitoring/run')).status, 200);
    assert.strictEqual((await admin.post('/api/admin/monitoring/run')).status, 429);
    // De limiet geldt per gebruiker.
    const platform = await world.client(platformAdmin).post('/api/admin/monitoring/run');
    assert.strictEqual(platform.status, 200);
    assert.deepStrictEqual(world.monitor.calls.filter((call) => call[0] === 'runAll').at(-1)[1], { force: true, tenantId: MAIN, platform: true });
  } finally {
    world.server.close();
  }
});

test('testmelding: eigen omgeving, heartbeat alleen met canPlatform, limiet 5 per 10 minuten', async () => {
  const world = await start();
  try {
    const admin = world.client(otherAdmin);
    const result = await admin.post('/api/admin/monitoring/test');
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(world.monitor.calls.find((call) => call[0] === 'sendTest'), ['sendTest', OTHER]);
    assert.strictEqual(result.body.mail.ok, true);
    assert.strictEqual(result.body.heartbeat, undefined);
    assert.ok(world.audits.some((item) => item.action === 'bewaking_testmelding' && item.tenantId === OTHER));
    for (let i = 0; i < 4; i += 1) assert.strictEqual((await admin.post('/api/admin/monitoring/test')).status, 200);
    assert.strictEqual((await admin.post('/api/admin/monitoring/test')).status, 429);
    const platform = await world.client(platformAdmin).post('/api/admin/monitoring/test');
    assert.strictEqual(platform.body.heartbeat.ok, true);
  } finally {
    world.server.close();
  }
});

test('geschiedenis: filter op stand, limiet en cursor; onzin in de query wordt genegeerd', async () => {
  const world = await start();
  try {
    const admin = world.client(otherAdmin);
    const firstPage = (await admin.get('/api/admin/monitoring/incidents?limit=1')).body;
    assert.deepStrictEqual(firstPage.incidents.map((incident) => incident.id), ['o1']);
    assert.strictEqual(firstPage.next, '2026-11-13T08:00:00.000Z');
    const secondPage = (await admin.get(`/api/admin/monitoring/incidents?limit=1&before=${encodeURIComponent(firstPage.next)}`)).body;
    assert.deepStrictEqual(secondPage.incidents.map((incident) => incident.id), ['o2']);
    const odd = await admin.get('/api/admin/monitoring/incidents?state=alles&before=%27%20OR%201%3D1&limit=-5');
    assert.strictEqual(odd.status, 200);
    assert.deepStrictEqual(world.monitor.calls.at(-1), ['list', OTHER, '', '']);
  } finally {
    world.server.close();
  }
});
