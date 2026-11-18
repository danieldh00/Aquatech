// Log van trage verzoeken (platform/slow-log.js): drempel, normalisatie van paden zonder gegevens of geheimen,
// tellers voor databasequeries en externe aanroepen, trage taken, stilstand van de hoofdthread, begrensd logboek,
// en de back-up in een eigen proces (backup.js createBackupInChild).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb, openDatabase } = require('../src/database/db');
const { createSlowLog, normalizePath, timedFetch } = require('../src/platform/slow-log');
const { createStats, runWithStats, recordQuery } = require('../src/database/query-stats');
const { createStore } = require('../src/platform/store');
const { createBackupInChild, listBackups, decryptFile, keyOf } = require('../src/backup');
const { createVault, loadOrCreateMasterKey } = require('../src/beveiliging/vault');
const { listen } = require('./helpers/http-client');

const onPostgres = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Maakt een logboek met een nepklok die je met `tick` laat doorlopen en een lijst voor de geschreven regels.
 * @param {object} [options] Extra opties voor createSlowLog.
 * @returns {{ log: object, lines: string[], advance: Function }} Het logboek, de regels en een functie om de klok vooruit te zetten.
 */
function fakeLog(options = {}) {
  const lines = [];
  let clock = 0;
  const log = createSlowLog({ thresholdMs: 100, write: (line) => lines.push(line), now: () => clock, ...options });
  return { log, lines, advance: (ms) => { clock += ms; } };
}

/**
 * Een nep-verzoek en -antwoord waarmee de middleware is aan te sturen.
 * @param {object} [request] Velden van het verzoek (method, originalUrl, tenantId).
 * @returns {{ req: object, res: object }} Verzoek en antwoord (een EventEmitter met statusCode).
 */
function fakeExchange(request = {}) {
  const { EventEmitter } = require('events');
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableFinished = true;
  return { req: { method: 'GET', originalUrl: '/app/api/x', ...request }, res };
}

test('normalizePath: id\'s, tokens en e-mailadressen weg, geen querystring', () => {
  assert.strictEqual(normalizePath('/app/api/quotes/123?token=geheim&x=1'), '/app/api/quotes/:id');
  assert.strictEqual(normalizePath('/app/api/plans/0f8fad5b-d9cb-469f-a165-70867728950e/history'), '/app/api/plans/:id/history');
  assert.strictEqual(normalizePath('/bestelling/9/?k=abcdefghijklmnopqrstuvwx1234'), '/bestelling/:id/');
  assert.strictEqual(normalizePath('/x/abcdefghijklmnopqrstuvwx1234'), '/x/:token');
  assert.strictEqual(normalizePath('/zoeken/jan%40example.nl'), '/zoeken/:waarde');
  assert.strictEqual(normalizePath('/app/api/users/jan@example.nl'), '/app/api/users/:waarde');
  assert.strictEqual(normalizePath('/groep/beregening/'), '/groep/beregening/');
  assert.strictEqual(normalizePath(''), '/');
  assert.strictEqual(normalizePath(undefined), '/');
});

test('middleware: alleen verzoeken vanaf de drempel, met tellers en zonder gegevens', () => {
  const { log, lines, advance } = fakeLog();
  const fast = fakeExchange();
  log.middleware(fast.req, fast.res, () => { advance(99); });
  fast.res.emit('finish');
  assert.strictEqual(log.entries().length, 0);

  const slow = fakeExchange({ originalUrl: '/app/api/quotes/42?secret=abc', tenantId: 'tenant-1' });
  slow.res.statusCode = 500;
  log.middleware(slow.req, slow.res, () => {
    recordQuery(30);
    recordQuery(20.04);
    advance(250);
  });
  slow.res.emit('finish');
  slow.res.emit('close');
  const [entry] = log.entries();
  assert.strictEqual(log.entries().length, 1, 'finish en close samen leggen één regel vast');
  assert.deepStrictEqual({ kind: entry.kind, method: entry.method, path: entry.path, status: entry.status, durationMs: entry.durationMs, tenantId: entry.tenantId, queries: entry.queries, dbMs: entry.dbMs }, {
    kind: 'verzoek', method: 'GET', path: '/app/api/quotes/:id', status: 500, durationMs: 250, tenantId: 'tenant-1', queries: 2, dbMs: 50,
  });
  assert.ok(lines[0].startsWith('[traag]'));
  assert.ok(!JSON.stringify(entry).includes('secret'), 'de querystring staat niet in het logboek');
});

test('middleware: de routeaanduiding gaat voor het werkelijke adres', () => {
  const { log, advance } = fakeLog();
  const exchange = fakeExchange({ originalUrl: '/app/api/quotes/42', baseUrl: '/app/api', route: { path: '/quotes/:id' } });
  log.middleware(exchange.req, exchange.res, () => { advance(500); });
  exchange.res.emit('close');
  assert.strictEqual(log.entries()[0].path, '/app/api/quotes/:id');
});

test('middleware: een afgebroken verbinding wordt gemarkeerd', () => {
  const { log, advance } = fakeLog();
  const exchange = fakeExchange();
  exchange.res.writableFinished = false;
  log.middleware(exchange.req, exchange.res, () => { advance(500); });
  exchange.res.emit('close');
  assert.strictEqual(log.entries()[0].aborted, true);
});

test('logboek: begrensd op het aantal regels', () => {
  const { log } = fakeLog({ capacity: 3 });
  for (let i = 0; i < 5; i++) log.record({ kind: 'verzoek', path: `/p${i}` });
  assert.deepStrictEqual(log.entries().map((entry) => entry.path), ['/p2', '/p3', '/p4']);
});

test('trackTask: synchroon, met belofte en bij een fout', async () => {
  const { log, advance } = fakeLog();
  assert.strictEqual(log.trackTask('snel', () => { advance(10); return 'a'; }), 'a');
  assert.strictEqual(log.trackTask('traag', () => { recordQuery(40); advance(300); return 'b'; }), 'b');
  assert.strictEqual(await log.trackTask('belofte', async () => { advance(200); return 'c'; }), 'c');
  assert.throws(() => log.trackTask('stuk', () => { advance(150); throw new Error('stuk'); }), /stuk/);
  await assert.rejects(log.trackTask('afgewezen', async () => { advance(150); throw new Error('afgewezen'); }), /afgewezen/);
  const tasks = log.entries().map((entry) => entry.task);
  assert.deepStrictEqual(tasks, ['traag', 'belofte', 'stuk', 'afgewezen']);
  assert.strictEqual(log.entries()[0].queries, 1);
});

test('stilstand: een te late timer geeft een regel met wat er liep', () => {
  const { log, lines, advance } = fakeLog({ stallMs: 1000 });
  const watch = log.startStallWatch({ intervalMs: 250 });
  try {
    const exchange = fakeExchange({ originalUrl: '/app/api/admin/backups/12' });
    log.middleware(exchange.req, exchange.res, () => {});
    advance(250);
    watch.tick();
    assert.strictEqual(log.entries().length, 0, 'een tik op tijd is geen stilstand');
    advance(250 + 4000);
    watch.tick();
    const [entry] = log.entries();
    assert.strictEqual(entry.kind, 'stilstand');
    assert.strictEqual(entry.stalledMs, 4000);
    assert.deepStrictEqual(entry.runningDuring, ['GET /app/api/admin/backups/:id']);
    assert.ok(lines[0].startsWith('[stilstand]'));
    advance(250);
    watch.tick();
    assert.strictEqual(log.entries().length, 1, 'na het herstel komt er geen nieuwe regel');
  } finally {
    watch.stop();
  }
});

test('timedFetch: telt externe aanroepen mee bij de teller, ook bij een fout', async () => {
  const stats = createStats();
  const fetchImpl = timedFetch(async (url) => { if (url === 'fout') throw new Error('stuk'); return 'ok'; });
  await runWithStats(stats, async () => {
    assert.strictEqual(await fetchImpl('https://x.example'), 'ok');
    await assert.rejects(fetchImpl('fout'));
  });
  assert.strictEqual(stats.externalCalls, 2);
  assert.strictEqual(await fetchImpl('https://x.example'), 'ok', 'buiten een verzoek werkt hij gewoon');
});

/**
 * Vervangt console.warn zodat de [traag]-regels van de test de testuitvoer niet vullen.
 * @returns {void}
 */
function silence() {}

test('app: een verzoek boven de drempel staat in het logboek, zonder querystring', async () => {
  const db = openDb();
  createStore(db).ensureTenant();
  const app = createApp({ secret: 's'.repeat(64), db, loginDelayMs: 0, env: { SLOW_REQUEST_MS: '0.001' } });
  const originalWarn = console.warn;
  console.warn = silence;
  const { server, base } = await listen(app);
  try {
    const response = await fetch(`${base}/api/health?wachtwoord=geheim123`);
    assert.strictEqual(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    console.warn = originalWarn;
    server.close();
  }
  const entry = app.locals.slowLog.entries().find((candidate) => candidate.path === '/api/health');
  assert.ok(entry, 'het verzoek staat in het logboek');
  assert.strictEqual(entry.status, 200);
  assert.ok(!JSON.stringify(app.locals.slowLog.entries()).includes('geheim123'));
  // Met PostgreSQL tellen de queries van de synchrone brug mee.
  if (onPostgres) assert.ok(entry.queries >= 0);
});

test('query-stats: telt queries van de synchrone brug bij het lopende verzoek (PostgreSQL)', { skip: !onPostgres && 'alleen tegen PostgreSQL' }, async () => {
  const db = openDb();
  const stats = createStats();
  await runWithStats(stats, async () => {
    db.prepare('SELECT 1 AS one').get();
    await db.async.get('SELECT 1 AS one');
  });
  assert.strictEqual(stats.queries, 2);
  assert.ok(stats.dbMs > 0);
  db.prepare('SELECT 1 AS one').get();
  assert.strictEqual(stats.queries, 2, 'buiten de context verandert de teller niet');
});

test('back-up in een eigen proces: dezelfde uitkomst als in het proces zelf', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-child-'));
  const dir = path.join(dataDir, 'backups');
  const env = { ...process.env, DATA_DIR: dataDir };
  delete env.DATABASE_URL;
  delete env.DATABASE_URL_FILE;
  delete env.TEST_DATABASE_URL;
  try {
    const vault = createVault(loadOrCreateMasterKey(dataDir).key);
    const db = openDatabase(dataDir);
    createStore(db).ensureTenant();
    db.close();
    const backup = await createBackupInChild({ dir, env });
    assert.match(backup.name, /^aquatech-\d{8}-\d{6}\.db\.enc$/);
    assert.ok(backup.size > 0);
    assert.deepStrictEqual(listBackups(dir).map((item) => item.name), [backup.name]);
    const restored = path.join(dataDir, 'terug.db');
    await decryptFile(path.join(dir, backup.name), restored, keyOf(vault));
    assert.ok(fs.statSync(restored).size > 0);
    // Zonder hoofdsleutel mislukt het proces met een leesbare melding en blijft er niets achter.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-child-leeg-'));
    await assert.rejects(createBackupInChild({ dir: path.join(emptyDir, 'b'), env: { ...env, DATA_DIR: emptyDir, AQUATECH_MASTER_KEY: '', AQUATECH_MASTER_KEY_FILE: '' } }), /Back-upproces mislukt.*hoofdsleutel/);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('back-up in een eigen proces: een script dat niets teruggeeft wordt een fout', async () => {
  const script = path.join(os.tmpdir(), `aquatech-nep-${process.pid}.js`);
  fs.writeFileSync(script, "console.log('niets nuttigs');");
  try {
    await assert.rejects(createBackupInChild({ dir: os.tmpdir(), script }), /geen bestandsnaam/);
    fs.writeFileSync(script, "console.error('kapot'); process.exit(3);");
    await assert.rejects(createBackupInChild({ dir: os.tmpdir(), script }), /code 3.*kapot/s);
  } finally {
    fs.rmSync(script, { force: true });
  }
});
