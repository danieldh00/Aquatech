// Debugmodus en foutmeldingen (platform/error-report.js): foutcode voor iedereen, details alleen voor
// beheerders met de debugmodus aan, geen geheimen, en async routes die niet blijven hangen.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createErrorReport, catchAsync, withCause, describeError, redact, ownFrames } = require('../src/platform/error-report');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const SECRET = 'd'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Kleine Express-app met de foutafhandeling zoals in server.js, en routes die op verschillende manieren falen.
 * @param {object} [options] { debug: of details mee mogen, logs: lijst voor de logregels }.
 * @returns {object} De app.
 */
function miniApp({ debug = false, logs = [] } = {}) {
  const app = catchAsync(express());
  const report = createErrorReport({ debugFor: () => debug, log: (line, detail) => logs.push({ line, detail }) });
  app.use(report.attach);
  app.use(express.json({ limit: '1kb' }));
  app.get('/sync', () => { throw new Error('kapot in sync'); });
  app.get('/async', async () => { throw Object.assign(new Error('UNIQUE constraint failed: quotes.number'), { code: 'ERR_SQLITE_ERROR', errcode: 2067 }); });
  app.get('/geheim', async () => { throw new Error('verbinding postgres://aquatech:Super-Geheim-99@db.example:5432/x mislukt, Bearer abcdefghijkl123'); });
  app.get('/eigen', (req, res) => withCause(res, new Error('SMTP 535 login mislukt')).status(502).json({ error: 'send_failed', message: 'Versturen mislukt.' }));
  app.get('/goed', (req, res) => res.json({ ok: true }));
  app.post('/body', (req, res) => res.json({ ok: true }));
  app.get('/na-versturen', async (req, res) => { res.json({ ok: true }); throw new Error('te laat'); });
  app.use(report.handler);
  return app;
}

test('foutafhandeling: foutcode in antwoord en log, geen details zonder debugmodus', async () => {
  const logs = [];
  const { server, base } = await listen(miniApp({ logs }));
  try {
    const client = createClient(base);
    const sync = await client.get('/sync');
    assert.strictEqual(sync.status, 500);
    assert.strictEqual(sync.body.error, 'internal_error');
    assert.match(sync.body.errorId, /^[0-9a-f]{8}$/);
    assert.ok(sync.body.message.includes(sync.body.errorId), 'de foutcode staat in de melding');
    assert.strictEqual(sync.body.debug, undefined);
    assert.strictEqual(sync.headers.get('x-aquatech-debug'), null);
    assert.ok(logs[0].line.includes(`[fout ${sync.body.errorId}] GET /sync`), 'de foutcode staat in het log');
    assert.match(logs[0].detail, /kapot in sync/, 'de stacktrace staat in het log');

    // Ook in het serverlog gaan geheimen eruit.
    await client.get('/geheim');
    const secretLog = logs[logs.length - 1].detail;
    assert.ok(!secretLog.includes('Super-Geheim-99') && !secretLog.includes('abcdefghijkl123'), 'geen geheimen in het log');
    assert.match(secretLog, /postgres:\/\/aquatech:\*\*\*@db\.example/);

    // Een async route die faalt blijft niet hangen maar geeft ook een 500.
    const failing = await client.get('/async');
    assert.strictEqual(failing.status, 500);
    assert.ok(!failing.text.includes('UNIQUE'), 'geen SQL-melding zonder debugmodus');
    assert.ok(!failing.text.includes('.js'), 'geen stacktrace zonder debugmodus');

    const own = await client.get('/eigen');
    assert.strictEqual(own.status, 502);
    assert.deepStrictEqual(own.body, { error: 'send_failed', message: 'Versturen mislukt.' });

    // Kapotte JSON en te grote verzoeken: eigen, begrijpelijke melding.
    const broken = await fetch(`${base}/body`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{kapot' });
    assert.strictEqual(broken.status, 400);
    assert.strictEqual((await broken.json()).error, 'invalid_json');
    const large = await fetch(`${base}/body`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(5000) }) });
    assert.strictEqual(large.status, 413);
    assert.strictEqual((await large.json()).error, 'too_large');

    // Een fout na het versturen verandert het antwoord niet.
    const late = await client.get('/na-versturen');
    assert.strictEqual(late.status, 200);
    assert.deepStrictEqual(late.body, { ok: true });
  } finally {
    server.close();
  }
});

test('foutafhandeling: met debugmodus details, zonder geheimen', async () => {
  const { server, base } = await listen(miniApp({ debug: true, logs: [] }));
  try {
    const client = createClient(base);
    const failing = await client.get('/async');
    assert.strictEqual(failing.status, 500);
    assert.strictEqual(failing.headers.get('x-aquatech-debug'), '1');
    const { debug } = failing.body;
    assert.strictEqual(debug.status, 500);
    assert.strictEqual(debug.method, 'GET');
    assert.strictEqual(debug.path, '/async');
    assert.strictEqual(debug.errorId, failing.body.errorId);
    assert.strictEqual(debug.cause.message, 'UNIQUE constraint failed: quotes.number');
    assert.strictEqual(debug.cause.code, 'ERR_SQLITE_ERROR');
    // De plek in de code: dit testbestand valt buiten src/, dus geen eigen regels; de vorm klopt wel.
    assert.ok(Array.isArray(debug.cause.stack));

    const secret = await client.get('/geheim');
    assert.ok(!secret.text.includes('Super-Geheim-99'), 'wachtwoord in een URL gaat eruit');
    assert.ok(!secret.text.includes('abcdefghijkl123'), 'token gaat eruit');
    assert.match(secret.body.debug.cause.message, /postgres:\/\/aquatech:\*\*\*@db\.example/);

    const own = await client.get('/eigen');
    assert.strictEqual(own.status, 502);
    assert.strictEqual(own.body.message, 'Versturen mislukt.');
    assert.strictEqual(own.body.debug.cause.message, 'SMTP 535 login mislukt');

    // Goede antwoorden krijgen niets extra.
    const good = await client.get('/goed');
    assert.deepStrictEqual(good.body, { ok: true });
    assert.strictEqual(good.headers.get('x-aquatech-debug'), null);
  } finally {
    server.close();
  }
});

test('foutafhandeling: een fout in de controle van de debugmodus geeft geen details en geen tweede fout', async () => {
  const app = catchAsync(express());
  const report = createErrorReport({ debugFor: () => { throw new Error('controle kapot'); }, log: () => {} });
  app.use(report.attach);
  app.get('/sync', () => { throw new Error('kapot'); });
  app.use(report.handler);
  const { server, base } = await listen(app);
  try {
    const response = await createClient(base).get('/sync');
    assert.strictEqual(response.status, 500);
    assert.strictEqual(response.body.debug, undefined);
  } finally {
    server.close();
  }
});

test('redact, describeError en ownFrames', () => {
  assert.strictEqual(redact('postgresql://user:pw@host/db'), 'postgresql://user:***@host/db');
  assert.strictEqual(redact('sleutel sk-ant-api03-abcdefghij'), 'sleutel sk-ant-***');
  assert.strictEqual(redact('mollie live_abcdefghijklmnopqrstuvwxyz'), 'mollie live_***');
  assert.strictEqual(redact('ck_0123456789abcdef0123456789abcdef'), 'ck_***');
  assert.strictEqual(redact('password=hunter2 rest'), 'password=*** rest');
  assert.strictEqual(redact('{"token": "abc123def"}'), '{"token": "***"}');
  assert.strictEqual(redact('refresh_token=abc'), 'refresh_token=***');
  assert.strictEqual(redact('X-API-KEY: geheim'), 'X-API-KEY: ***');
  // Lange invoer zonder scheidingstekens blijft snel (geen terugzoeken over de hele tekst).
  const started = Date.now();
  redact(`/api/${'a'.repeat(200000)}`, 300000);
  redact('token'.repeat(40000), 300000);
  redact('a-'.repeat(100000), 300000);
  redact('a://b:'.repeat(40000), 300000);
  assert.ok(Date.now() - started < 500, 'redact moet lineair blijven op lange invoer');
  assert.strictEqual(redact('client_secret: geheim'), 'client_secret: ***');
  assert.strictEqual(redact('x'.repeat(30), 10), `${'x'.repeat(10)}…`);
  assert.strictEqual(redact(undefined), '');

  const source = path.join(__dirname, '..', 'src', 'verkoop', 'quotes.js');
  const stack = [
    'Error: kapot',
    `    at sanitize (${source}:412:13)`,
    `    at ${path.join(__dirname, '..', 'node_modules', 'express', 'lib', 'router', 'layer.js')}:95:5`,
    '    at node:internal/process/task_queues:95:5',
    `    at ${source}:500:1`,
  ].join('\n');
  assert.deepStrictEqual(ownFrames(stack), ['verkoop/quotes.js:412:13 (sanitize)', 'verkoop/quotes.js:500:1']);

  const pgError = Object.assign(new Error('duplicate key value violates unique constraint "quotes_number"'), {
    name: 'DatabaseError', code: '23505', detail: 'Key (tenant_id, number)=(t1, OF2026-0001) already exists.', constraint: 'quotes_number', table: 'quotes', stack,
  });
  const described = describeError(pgError);
  assert.strictEqual(described.name, 'DatabaseError');
  assert.strictEqual(described.code, '23505');
  assert.strictEqual(described.constraint, 'quotes_number');
  assert.strictEqual(described.table, 'quotes');
  assert.strictEqual(described.where, 'verkoop/quotes.js:412:13 (sanitize)');
  assert.deepStrictEqual(describeError('tekst'), { name: 'Fout', message: 'tekst', stack: [] });
  assert.strictEqual(describeError(new Error('buiten', { cause: new Error('binnen') })).cause.message, 'binnen');
});

test('catchAsync: instellingen lezen, foutafhandelaars en sub-routers blijven werken', async () => {
  const app = catchAsync(express());
  app.set('titel', 'proef');
  assert.strictEqual(app.get('titel'), 'proef');
  const router = catchAsync(express.Router());
  router.get('/binnen', async () => { throw new Error('in router'); });
  app.use('/r', router);
  app.use((error, req, res, next) => res.status(500).json({ caught: error.message, hasNext: typeof next === 'function' }));
  const { server, base } = await listen(app);
  try {
    const response = await createClient(base).get('/r/binnen');
    assert.deepStrictEqual(response.body, { caught: 'in router', hasNext: true });
  } finally {
    server.close();
  }
});

/**
 * Testserver met een beheerder en een installateur in de hoofdtenant, een tweede organisatie met een
 * beheerder, en een WAN-IP-dienst die faalt met een geheim in de melding.
 * @returns {Promise<object>} server, base en as (inloggen).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW }, { mustChangePassword: false });
  const groen = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant;
  await store.createAccount(groen.id, { username: 'gerda', displayName: 'Gerda', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const wanIp = { get: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND api.ipify.org (token=abc123geheim)'), { code: 'ENOTFOUND' }); } };
  const app = createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, wanIp });
  const { server, base } = await listen(app);
  return { server, base, as: createLogin(base, { password: PW }) };
}

test('debugmodus in de app: schakelaar per omgeving, details alleen voor beheerders', async () => {
  const { server, base, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const gerda = await as('gerda', 'groen');

    // Standaard uit: wel een begrijpelijke melding, geen details.
    let failing = await baas.get('/app/api/admin/wan-ip');
    assert.strictEqual(failing.status, 502);
    assert.strictEqual(failing.body.debug, undefined);
    assert.strictEqual((await baas.get('/app/api/admin/settings')).body.settings.debugMode.value, false);

    // Alleen een beheerder zet hem aan.
    assert.strictEqual((await kees.put('/app/api/admin/settings', { debugMode: true })).status, 403);
    const saved = await baas.put('/app/api/admin/settings', { debugMode: true });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body.changed, ['debugMode']);
    assert.strictEqual(saved.body.settings.debugMode.value, true);
    assert.strictEqual((await baas.put('/app/api/admin/settings', { debugMode: 'ja' })).status, 400);

    failing = await baas.get('/app/api/admin/wan-ip');
    assert.strictEqual(failing.status, 502);
    assert.strictEqual(failing.headers.get('x-aquatech-debug'), '1');
    assert.strictEqual(failing.body.debug.path, '/app/api/admin/wan-ip');
    assert.strictEqual(failing.body.debug.cause.code, 'ENOTFOUND');
    assert.ok(failing.body.debug.cause.where.startsWith('server.js:'), `plek in de code: ${failing.body.debug.cause.where}`);
    assert.ok(!failing.text.includes('abc123geheim'), 'geheim gaat eruit');

    // Ook een 4xx van de server krijgt het verzoek en de foutsoort mee.
    const invalid = await baas.put('/app/api/admin/settings', { bestaatNiet: 1 });
    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(invalid.body.debug.error, 'invalid_setting');

    // Een installateur ziet nooit details, ook niet met de modus aan.
    const forbidden = await kees.get('/app/api/admin/wan-ip');
    assert.strictEqual(forbidden.status, 403);
    assert.strictEqual(forbidden.body.debug, undefined);
    const lookup = await kees.get('/app/api/me');
    assert.strictEqual(lookup.body.debug, undefined);

    // De schakelaar geldt per omgeving: de beheerder van een andere organisatie ziet niets.
    const other = await gerda.get('/app/api/admin/wan-ip');
    assert.strictEqual(other.status, 502);
    assert.strictEqual(other.body.debug, undefined);

    // Niet ingelogd: geen details.
    const anonymous = await createClient(base).get('/app/api/admin/wan-ip');
    assert.ok(anonymous.status === 401 || anonymous.status === 403);
    assert.strictEqual(anonymous.body && anonymous.body.debug, undefined);

    // Weer uit: geen details meer.
    await baas.put('/app/api/admin/settings', { debugMode: false });
    assert.strictEqual((await baas.get('/app/api/admin/wan-ip')).body.debug, undefined);
  } finally {
    server.close();
  }
});

const fs = require('fs');
const vm = require('vm');
const FRONT = path.join(__dirname, '..', '..', 'frontend');

/**
 * Een heel klein nep-DOM: genoeg voor shared/common.js en shared/debug-panel.js.
 * @returns {object} { window, document, added } met `added` = elementen die in de kop zijn gezet.
 */
function fakeDom() {
  const added = [];
  /**
   * Een nep-element dat kinderen, tekst en attributen bijhoudt.
   * @param {string} tag De tag.
   * @returns {object} Het element.
   */
  const makeElement = (tag) => {
    const node = { tag, children: [], attributes: {}, textContent: '', className: '', isConnected: false, listeners: {} };
    /**
     * Hangt een kind onder dit element.
     * @param {object} child Het kind.
     * @param {boolean} [first] Vooraan in plaats van achteraan.
     * @returns {object} Het kind.
     */
    const attachChild = (child, first = false) => {
      if (first) node.children.unshift(child); else node.children.push(child);
      Object.assign(child, { parent: node, isConnected: true });
      return child;
    };
    Object.assign(node, {
      setAttribute: (name, value) => { node.attributes[name] = value; },
      appendChild: (child) => attachChild(child),
      append: (...items) => items.forEach((child) => attachChild(child)),
      prepend: (child) => attachChild(child, true),
      remove: () => { if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node); node.isConnected = false; },
      addEventListener: (type, listener) => { node.listeners[type] = listener; },
    });
    Object.defineProperty(node, 'lastElementChild', { get: () => node.children[node.children.length - 1] });
    return node;
  };
  /**
   * Nep-querySelector: vindt nooit iets.
   * @returns {null} Geen element.
   */
  const nothing = () => null;
  /**
   * Doet niets (luisteraars die de test niet nodig heeft).
   * @returns {void}
   */
  const ignore = () => {};
  const document = {
    currentScript: { src: 'https://app.example/app/shared/common.js?v=1.8.1' },
    head: { appendChild: (child) => { added.push(child); return child; } },
    body: makeElement('body'),
    createElement: makeElement,
    querySelector: nothing,
    addEventListener: ignore,
  };
  const window = { document, location: { protocol: 'https:', pathname: '/app/beheer/' }, navigator: {}, addEventListener: ignore, isSecureContext: false, sessionStorage: { getItem: nothing, setItem: ignore }, URL, Promise, setTimeout, clearTimeout };
  window.window = window;
  return { window, document, added };
}

/**
 * Een nep-antwoord van fetch.
 * @param {number} status De status.
 * @param {object} body De JSON-body.
 * @param {object} [headers] De koppen.
 * @returns {object} Iets dat op een Response lijkt.
 */
const fakeResponse = (status, body, headers = {}) => ({
  status, ok: status < 400,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
  clone() { return fakeResponse(status, body, headers); },
});

test('frontend: common.js laadt het debugpaneel alleen bij een foutantwoord met debugkop', async () => {
  const { window, document, added } = fakeDom();
  const answers = [];
  /**
   * Nep-fetch: geeft het volgende klaargezette antwoord.
   * @returns {Promise<object>} Het antwoord.
   */
  window.fetch = async () => answers.shift();
  const context = vm.createContext({ ...window, window, document, navigator: window.navigator, location: window.location, console });
  vm.runInContext(fs.readFileSync(path.join(FRONT, 'shared', 'common.js'), 'utf8'), context);
  const before = added.length;
  /**
   * De elementen van het debugpaneel die in de kop zijn gezet.
   * @returns {object[]} Script en stylesheet van het paneel.
   */
  const panelFiles = () => added.filter((node) => String(node.src || node.href || '').includes('debug-panel'));

  answers.push(fakeResponse(500, { error: 'internal_error', message: 'mis' }));
  assert.strictEqual((await context.window.fetch('api/x')).status, 500);
  answers.push(fakeResponse(200, { ok: true }, { 'x-aquatech-debug': '1' }));
  await context.window.fetch('api/x');
  assert.strictEqual(added.length, before, 'zonder debugkop of bij een goed antwoord laadt er niets');
  assert.strictEqual(panelFiles().length, 0);

  const body = { error: 'internal_error', message: 'Er ging iets mis (foutcode abcd1234).', debug: { status: 500, method: 'GET', path: '/app/api/x', errorId: 'abcd1234', cause: { name: 'Error', message: 'kapot', where: 'server.js:1:1', stack: ['server.js:1:1'] } } };
  answers.push(fakeResponse(500, body, { 'x-aquatech-debug': '1' }));
  const response = await context.window.fetch('api/x');
  assert.strictEqual(response.status, 500, 'de module krijgt het antwoord ongewijzigd');
  const script = panelFiles().find((node) => node.tag === 'script');
  const style = panelFiles().find((node) => node.tag === 'link');
  assert.strictEqual(script.src, 'https://app.example/app/shared/debug-panel.js?v=1.8.1');
  assert.strictEqual(style.href, 'https://app.example/app/shared/debug-panel.css?v=1.8.1');

  // Het paneel zelf: laden en tonen, tekst alleen als textContent.
  vm.runInContext(fs.readFileSync(path.join(FRONT, 'shared', 'debug-panel.js'), 'utf8'), context);
  script.onload();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const panel = document.body.children[0];
  assert.strictEqual(panel.className, 'debug-panel');
  assert.strictEqual(panel.children.length, 1);
  const text = context.window.AquatechDebug.asText(body);
  assert.match(text, /Foutcode: abcd1234/);
  assert.match(text, /Waar: server\.js:1:1/);
  assert.match(text, /Aanroepketen:\n {2}server\.js:1:1/);
  for (let i = 0; i < 7; i++) context.window.AquatechDebug.show(body);
  assert.strictEqual(panel.children.length, 5, 'hoogstens vijf kaarten');
});
