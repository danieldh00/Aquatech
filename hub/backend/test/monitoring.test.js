// Tests van de bewaking (platform/monitoring.js): levenscyclus van incidenten, meldingen (mail, webhook, heartbeat),
// herinneringen, herstel, dempen, tijdslimiet, tenant-isolatie en dat er geen geheimen in meldingen komen.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createMonitor } = require('../src/platform/monitoring');

const MAIN = 'main';
const OTHER = 'other';
const HOUR = 3600 * 1000;

/**
 * Bouwt een monitor met een eigen database, een nepklok, een nepmailer en een nepfetch.
 * @param {object} [options] mainConfig (instelling van de hoofdtenant), otherConfig, mailBroken en webhookStatus.
 * @returns {object} monitor, clock (met advance), mails, requests en setConfig.
 */
function setup({ mainConfig = {}, otherConfig = {}, mailBroken = false, webhookStatus = 200 } = {}) {
  const db = openDb();
  for (const [id, slug] of [[MAIN, 'hoofd'], [OTHER, 'ander']]) {
    db.prepare("INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, '2026-01-01')").run(id, slug, slug);
  }
  const configs = { [MAIN]: { recipients: ['beheer@example.nl'], ...mainConfig }, [OTHER]: { recipients: ['ander@example.nl'], ...otherConfig } };
  const clock = { time: Date.parse('2026-11-13T10:00:00Z'), advance(ms) { this.time += ms; } };
  const mails = [];
  const requests = [];
  const monitor = createMonitor({
    db, mainTenantId: MAIN, listTenantIds: () => [MAIN, OTHER],
    settingsFor: (id) => ({ get: (key) => (key === 'monitoring' ? configs[id] : undefined) }),
    mailerFor: () => ({
      configured: () => true,
      /** Nepmailer. @param {object} message Het bericht. @returns {Promise<void>} Klaar. */
      send: async (message) => { if (mailBroken) throw new Error('smtp weg'); mails.push(message); },
    }),
    fetchImpl: async (url, init) => { requests.push({ url, method: init.method, body: init.body }); return { ok: webhookStatus < 400, status: webhookStatus }; },
    resolveHost: async () => '93.184.216.34',
    now: () => clock.time, log: { warn() {}, error() {} }, startGraceMs: 0,
  });
  return { db, monitor, clock, mails, requests, configs };
}

/**
 * Een controle die de ingestelde uitkomst geeft.
 * @param {string} key De sleutel.
 * @param {object} state Object met `result`; wijzig state.result om de uitkomst te veranderen.
 * @param {string} [scope] 'platform' of 'tenant'.
 * @returns {object} De controle.
 */
const fakeCheck = (key, state, scope = 'tenant') => ({ key, scope, title: `Controle ${key}`, intervalMinutes: 1, run: async () => state.result });

test('een falende controle opent één incident en meldt het één keer', async () => {
  const { monitor, mails, requests, configs } = setup();
  configs[MAIN].webhookUrl = 'https://hooks.example.nl/x';
  const state = { result: { ok: false, severity: 'fout', message: 'Database weg' } };
  monitor.register(fakeCheck('db', state, 'platform'));
  const first = await monitor.runAll({ force: true });
  assert.deepStrictEqual([first.ran, first.opened], [1, 1]);
  await monitor.runAll({ force: true });
  const open = monitor.list(MAIN, { state: 'open' });
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].occurrences, 2);
  assert.strictEqual(mails.length, 1, 'één mail, geen tweede bij herhaling');
  assert.match(mails[0].subject, /Database|Storing/i);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].method, 'POST');
  assert.strictEqual(JSON.parse(requests[0].body).ernst, 'fout');
});

test('herstel sluit het incident en meldt het (en niet als notifyRecovery uit staat)', async () => {
  for (const notifyRecovery of [true, false]) {
    const { monitor, mails } = setup({ mainConfig: { notifyRecovery } });
    const state = { result: { ok: false, severity: 'waarschuwing', message: 'Traag' } };
    monitor.register(fakeCheck('trage-db', state, 'platform'));
    await monitor.runAll({ force: true });
    state.result = { ok: true };
    const out = await monitor.runAll({ force: true });
    assert.strictEqual(out.resolved, 1);
    assert.strictEqual(monitor.list(MAIN, { state: 'open' }).length, 0);
    assert.strictEqual(monitor.list(MAIN, { state: 'opgelost' }).length, 1);
    assert.strictEqual(mails.length, notifyRecovery ? 2 : 1);
  }
});

test('overslaan sluit een open incident zonder herstelmelding', async () => {
  const { monitor, mails } = setup();
  const state = { result: { ok: false, severity: 'fout', message: 'kapot' } };
  monitor.register(fakeCheck('koppeling', state));
  await monitor.runAll({ force: true });
  state.result = { skip: true };
  await monitor.runAll({ force: true });
  assert.strictEqual(monitor.list(MAIN, { state: 'open' }).length, 0);
  assert.strictEqual(mails.length, 2, 'één melding per omgeving die faalt (hoofd en ander), geen herstelmelding');
});

test('herinnering pas na reminderHours; 0 = nooit', async () => {
  const { monitor, mails, clock } = setup({ mainConfig: { reminderHours: 2 } });
  const state = { result: { ok: false, severity: 'fout', message: 'kapot' } };
  monitor.register(fakeCheck('x', state, 'platform'));
  await monitor.runAll({ force: true });
  clock.advance(HOUR);
  await monitor.runAll({ force: true });
  assert.strictEqual(mails.length, 1);
  clock.advance(HOUR + 1000);
  await monitor.runAll({ force: true });
  assert.strictEqual(mails.length, 2);
  assert.match(mails[1].subject, /herinnering/i);

  const never = setup({ mainConfig: { reminderHours: 0 } });
  never.monitor.register(fakeCheck('x', state, 'platform'));
  await never.monitor.runAll({ force: true });
  never.clock.advance(100 * HOUR);
  await never.monitor.runAll({ force: true });
  assert.strictEqual(never.mails.length, 1);
});

test('waarschuwing die fout wordt, geeft een nieuwe melding', async () => {
  const { monitor, mails } = setup();
  const state = { result: { ok: false, severity: 'waarschuwing', message: 'iets' } };
  monitor.register(fakeCheck('x', state, 'platform'));
  await monitor.runAll({ force: true });
  state.result = { ok: false, severity: 'fout', message: 'erger' };
  await monitor.runAll({ force: true });
  assert.strictEqual(mails.length, 2);
  assert.strictEqual(monitor.list(MAIN, { state: 'open' })[0].severity, 'fout');
});

test('gedempte controle en uitgezette bewaking melden niets, maar het incident blijft zichtbaar', async () => {
  for (const mainConfig of [{ muted: ['x'] }, { enabled: false }]) {
    const { monitor, mails } = setup({ mainConfig });
    monitor.register(fakeCheck('x', { result: { ok: false, severity: 'fout', message: 'kapot' } }, 'platform'));
    await monitor.runAll({ force: true });
    assert.strictEqual(mails.length, 0);
    assert.strictEqual(monitor.list(MAIN, { state: 'open' }).length, 1);
  }
});

test('een controle die gooit of te lang duurt wordt een waarschuwing, geen crash', async () => {
  const { db } = setup();
  const monitor = createMonitor({
    db, mainTenantId: MAIN, listTenantIds: () => [], settingsFor: () => ({ get: () => ({}) }), mailerFor: () => ({ configured: () => false }),
    log: { warn() {}, error() {} }, startGraceMs: 0, checkTimeoutMs: 30,
  });
  monitor.register({ key: 'gooit', scope: 'platform', title: 'Gooit', run: async () => { throw new Error('boem met wachtwoord=geheim123'); } });
  monitor.register({ key: 'traag', scope: 'platform', title: 'Traag', run: () => new Promise(() => {}) });
  await monitor.runAll({ force: true });
  const rows = monitor.list(MAIN, { state: 'open' });
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every((row) => row.severity === 'waarschuwing'));
  assert.ok(rows.every((row) => !/geheim123/.test(row.message)), 'geen geheimen in de melding');
});

test('startgrace slaat controles over, force niet', async () => {
  const { db } = setup();
  const monitor = createMonitor({
    db, mainTenantId: MAIN, listTenantIds: () => [], settingsFor: () => ({ get: () => ({}) }), mailerFor: () => ({ configured: () => false }),
    log: { warn() {}, error() {} }, startGraceMs: 10 * 60 * 1000,
  });
  monitor.register({ key: 'x', scope: 'platform', title: 'X', run: async () => ({ ok: true }) });
  assert.strictEqual((await monitor.runAll({})).ran, 0);
  assert.strictEqual((await monitor.runAll({ force: true })).ran, 1);
});

test('interval: een controle die net gelopen heeft is nog niet weer aan de beurt', async () => {
  const { monitor, clock } = setup();
  monitor.register({ key: 'x', scope: 'platform', title: 'X', intervalMinutes: 5, run: async () => ({ ok: true }) });
  assert.strictEqual((await monitor.runAll({})).ran, 1);
  assert.strictEqual((await monitor.runAll({})).ran, 0);
  clock.advance(6 * 60 * 1000);
  assert.strictEqual((await monitor.runAll({})).ran, 1);
});

test('gebeurtenissen via report openen en sluiten een incident', async () => {
  const { monitor, mails } = setup();
  const incident = await monitor.report(OTHER, 'mail', { ok: false, severity: 'fout', title: 'Mail faalt', message: 'smtp: token=abc123def' });
  assert.strictEqual(incident.state, 'open');
  assert.ok(!/abc123def/.test(incident.message));
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to[0], 'ander@example.nl');
  await monitor.report(OTHER, 'mail', { ok: true });
  assert.strictEqual(monitor.list(OTHER, { state: 'open' }).length, 0);
});

test('tenant-isolatie: incidenten van een andere omgeving blijven buiten beeld', async () => {
  const { monitor } = setup();
  await monitor.report(OTHER, 'mollie', { ok: false, severity: 'fout', message: 'sleutel ongeldig' });
  assert.strictEqual(monitor.list(MAIN).length, 0);
  assert.strictEqual(monitor.list(OTHER).length, 1);
  assert.deepStrictEqual(monitor.openCount(MAIN), { fout: 0, waarschuwing: 0 });
  assert.strictEqual(monitor.openCount(OTHER).fout, 1);
});

test('platformincidenten staan onder de hoofdtenant, ook als een andere omgeving ze vraagt', async () => {
  const { monitor } = setup();
  await monitor.report(OTHER, 'schijf', { ok: false, severity: 'fout', message: 'vol', scope: 'platform' });
  assert.strictEqual(monitor.list(MAIN)[0].scope, 'platform');
  assert.strictEqual(monitor.list(OTHER).length, 0);
});

test('mail- en webhookfouten raken niets en worden vastgelegd', async () => {
  const { monitor, configs } = setup({ mailBroken: true, webhookStatus: 500 });
  configs[MAIN].webhookUrl = 'https://hooks.example.nl/x';
  monitor.register(fakeCheck('x', { result: { ok: false, severity: 'fout', message: 'kapot' } }, 'platform'));
  await monitor.runAll({ force: true });
  const row = monitor.list(MAIN, { state: 'open' })[0];
  assert.ok(row.notifyError.includes('Mail') && row.notifyError.includes('Webhook'));
  assert.ok(row.notifiedAt, 'ook een mislukte melding telt als poging');
});

test('heartbeat: gewoon adres zonder storing, /fail bij een open platformfout', async () => {
  const { monitor, requests, configs } = setup();
  configs[MAIN].heartbeatUrl = 'https://hc.example.nl/ping/abc';
  const state = { result: { ok: true } };
  monitor.register(fakeCheck('x', state, 'platform'));
  await monitor.runAll({ force: true });
  assert.strictEqual(requests.at(-1).url, 'https://hc.example.nl/ping/abc');
  assert.strictEqual(requests.at(-1).method, 'GET');
  state.result = { ok: false, severity: 'fout', message: 'kapot' };
  await monitor.runAll({ force: true });
  assert.strictEqual(requests.at(-1).url, 'https://hc.example.nl/ping/abc/fail');
});

test('testmelding gaat naar mail, webhook en heartbeat zonder incident op te slaan', async () => {
  const { monitor, configs, mails } = setup();
  configs[MAIN].webhookUrl = 'https://hooks.example.nl/x';
  configs[MAIN].heartbeatUrl = 'https://hc.example.nl/ping/abc';
  const out = await monitor.sendTest(MAIN);
  assert.ok(out.mail.ok && out.webhook.ok && out.heartbeat.ok);
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(monitor.list(MAIN).length, 0);
});

test('webhook naar een niet-https of lokaal adres wordt geweigerd', async () => {
  const { monitor, configs } = setup();
  configs[MAIN].webhookUrl = 'http://hooks.example.nl/x';
  assert.strictEqual((await monitor.sendTest(MAIN)).webhook.skipped, true, 'niet-https wordt bij het saneren weggelaten');
});

test('prune verwijdert alleen opgeloste incidenten ouder dan de bewaartermijn', async () => {
  const { monitor, clock } = setup();
  await monitor.report(MAIN, 'oud', { ok: false, severity: 'fout', message: 'x' });
  await monitor.report(MAIN, 'oud', { ok: true });
  await monitor.report(MAIN, 'open-oud', { ok: false, severity: 'fout', message: 'x' });
  clock.advance(40 * 24 * HOUR);
  assert.strictEqual(monitor.prune(MAIN, 30), 1);
  assert.strictEqual(monitor.list(MAIN).length, 1, 'het open incident blijft');
});

test('checkStates toont onbekend, ok en open per scope', async () => {
  const { monitor } = setup();
  monitor.register(fakeCheck('a', { result: { ok: true } }));
  monitor.register(fakeCheck('b', { result: { ok: false, severity: 'fout', message: 'kapot' } }));
  assert.ok(monitor.checkStates(MAIN, 'tenant').every((entry) => entry.status === 'onbekend'));
  await monitor.runAll({ force: true });
  const byKey = Object.fromEntries(monitor.checkStates(MAIN, 'tenant').map((entry) => [entry.key, entry.status]));
  assert.deepStrictEqual(byKey, { a: 'ok', b: 'open' });
  assert.strictEqual(monitor.checkStates(MAIN, 'platform').length, 0);
});
