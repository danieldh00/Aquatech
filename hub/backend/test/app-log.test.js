// Tests van het centrale logboek (platform/app-log.js): request-id, gebufferd schrijven, samenvoegen van herhalingen,
// begrenzing per minuut, redactie van geheimen en persoonsgegevens, bewaartermijn en tenant-scheiding.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createAppLog, cleanText, cleanData } = require('../src/platform/app-log');

const MAIN = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

/**
 * Maakt een database met twee omgevingen en een logboek met een nepklok.
 * @param {object} [options] Extra opties voor createAppLog.
 * @returns {{ db: object, appLog: object, clock: object, rows: Function }} De onderdelen; `rows` leest alle regels.
 */
function setup(options = {}) {
  const db = openDb();
  for (const [id, slug] of [[MAIN, 'hoofd'], [OTHER, 'ander']]) {
    db.prepare("INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, '2026-01-01')").run(id, slug, slug);
  }
  const clock = { time: Date.parse('2026-11-19T10:00:00Z') };
  const appLog = createAppLog({ db, mainTenantId: MAIN, flushMs: 0, now: () => clock.time, write: () => {}, ...options });
  /**
   * Schrijft de buffer weg en leest alle regels.
   * @returns {object[]} De regels.
   */
  const rows = () => { appLog.flush(); return db.prepare('SELECT tenant_id, scope, level, source, request_id, error_code, message, data, repeat_count, created_at FROM app_logs ORDER BY created_at, message').all(); };
  return { db, appLog, clock, rows };
}

test('middleware: elk verzoek krijgt een eigen request-id en een kop; een id van buiten wordt niet overgenomen', () => {
  const { appLog } = setup();
  const headers = {};
  const req = { headers: { 'x-request-id': 'zelf-verzonnen' } };
  let called = false;
  appLog.middleware(req, { setHeader: (name, value) => { headers[name] = value; } }, () => { called = true; });
  assert.ok(called);
  assert.match(req.requestId, /^[0-9a-f]{12}$/);
  assert.strictEqual(headers['X-Request-Id'], req.requestId);
});

test('regels worden gebufferd en in één keer weggeschreven; platformregels staan onder de hoofdtenant', () => {
  const { appLog, rows } = setup();
  appLog.error('fout', 'POST /app/api/quotes', { tenantId: OTHER, requestId: 'abc', errorCode: 'a1b2c3d4', durationMs: 12.6 });
  appLog.warn('stilstand', 'Hoofdthread stond 1500 ms stil');
  assert.strictEqual(appLog.pending(), 2);
  const result = rows();
  assert.strictEqual(appLog.pending(), 0);
  assert.strictEqual(result.length, 2);
  const error = result.find((row) => row.source === 'fout');
  assert.deepStrictEqual([error.tenant_id, error.scope, error.level, error.request_id, error.error_code], [OTHER, 'tenant', 'error', 'abc', 'a1b2c3d4']);
  const platform = result.find((row) => row.source === 'stilstand');
  assert.deepStrictEqual([platform.tenant_id, platform.scope], [MAIN, 'platform']);
});

test('identieke regels in de buffer worden één regel met een teller', () => {
  const { appLog, rows } = setup();
  for (let i = 0; i < 5; i += 1) appLog.warn('traag', 'GET /app/api/x (200)', { tenantId: MAIN });
  const result = rows();
  assert.strictEqual(result.length, 1);
  assert.strictEqual(Number(result[0].repeat_count), 5);
});

test('per bron hoogstens perMinuteLimit regels per minuut; een minuut later weer ruimte', () => {
  const { appLog, clock, rows } = setup({ perMinuteLimit: 3 });
  for (let i = 0; i < 10; i += 1) appLog.warn('traag', `regel ${i}`, { tenantId: MAIN });
  appLog.warn('fout', 'andere bron', { tenantId: MAIN });
  assert.strictEqual(rows().length, 4);
  clock.time += 61000;
  appLog.warn('traag', 'nieuwe minuut', { tenantId: MAIN });
  assert.strictEqual(rows().length, 5);
});

test('redactie: geheimen, e-mailadressen, IBAN en gevoelige sleutels komen nergens in de tabel', () => {
  const { appLog, db } = setup();
  appLog.error('fout', 'Mislukt voor jan@voorbeeld.nl met password=Geheim123 en Bearer abcdefghijklmnop', {
    tenantId: MAIN,
    data: { wachtwoord: 'Tuin-Plan-2026!', token: 'aqt_abcdefghijklmnopqrstuvwxyz', cookie: 'sessie=1', nested: { authorization: 'Basic aGVsbG93b3JsZA==', note: 'rekening NL91 ABNA 0417 1643 00 van piet@x.nl' }, url: 'postgres://gebruiker:geheimwoord@host/db' },
  });
  appLog.flush();
  const stored = JSON.stringify(db.prepare('SELECT message, data FROM app_logs').all());
  for (const secret of ['jan@voorbeeld.nl', 'piet@x.nl', 'Geheim123', 'abcdefghijklmnop', 'Tuin-Plan-2026', 'aqt_abcdef', 'sessie=1', 'aGVsbG93b3JsZA', 'NL91', 'geheimwoord']) {
    assert.ok(!stored.includes(secret), `${secret} staat in het logboek`);
  }
});

test('cleanText en cleanData kappen af en begrenzen de diepte', () => {
  assert.strictEqual(cleanText('x'.repeat(900)).length, 500);
  assert.strictEqual(cleanData({ a: { b: { c: { d: 1 } } } }).a.b.c, '…');
});

test('een databasefout breekt niets: de regels gaan naar de terugval', () => {
  const lines = [];
  const brokenDb = { prepare: () => { throw new Error('weg'); }, exec: () => { throw new Error('weg'); } };
  const appLog = createAppLog({ db: brokenDb, mainTenantId: MAIN, flushMs: 0, write: (line) => lines.push(line) });
  appLog.error('fout', 'iets');
  assert.doesNotThrow(() => appLog.flush());
  assert.strictEqual(lines.length, 1);
});

test('een onbekende omgeving laat de andere regels van de batch niet verloren gaan', () => {
  const { appLog, rows } = setup();
  appLog.warn('traag', 'goed', { tenantId: MAIN });
  appLog.warn('traag', 'onbekend', { tenantId: 'bestaat-niet' });
  appLog.warn('traag', 'ook goed', { tenantId: OTHER });
  assert.deepStrictEqual(rows().map((row) => row.message).sort(), ['goed', 'ook goed']);
});

test('bewaartermijn: info en waarschuwingen na de termijn weg, fouten pas na de foutentermijn, per omgeving', () => {
  const { appLog, clock, db, rows } = setup();
  appLog.warn('traag', 'oud', { tenantId: MAIN });
  appLog.error('fout', 'oude fout', { tenantId: MAIN });
  appLog.warn('traag', 'oud andere omgeving', { tenantId: OTHER });
  rows();
  clock.time += 20 * 86400000;
  appLog.warn('traag', 'nieuw', { tenantId: MAIN });
  appLog.flush();
  assert.strictEqual(appLog.prune(MAIN, 14, 30), 1);
  assert.deepStrictEqual(db.prepare('SELECT message FROM app_logs WHERE tenant_id = ? ORDER BY message').all(MAIN).map((row) => row.message), ['nieuw', 'oude fout']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM app_logs WHERE tenant_id = ?').get(OTHER).n, 1);
  clock.time += 15 * 86400000;
  assert.strictEqual(appLog.prune(MAIN, 14, 30), 2);
});

test('de limiet per minuut geldt per omgeving en bron; fouten hebben een eigen, dubbele grens', () => {
  const { appLog, rows } = setup({ perMinuteLimit: 2 });
  for (let i = 0; i < 6; i += 1) appLog.warn('traag', `a ${i}`, { tenantId: MAIN });
  for (let i = 0; i < 6; i += 1) appLog.warn('traag', `b ${i}`, { tenantId: OTHER });
  for (let i = 0; i < 6; i += 1) appLog.error('fout', `fout ${i}`, { tenantId: MAIN });
  const result = rows();
  assert.strictEqual(result.filter((row) => row.tenant_id === MAIN && row.source === 'traag').length, 2);
  assert.strictEqual(result.filter((row) => row.tenant_id === OTHER).length, 2);
  assert.strictEqual(result.filter((row) => row.source === 'fout').length, 4);
});

test('een stacktrace onder de sleutel stack mag 1200 tekens zijn, andere tekst 300', () => {
  const cleaned = cleanData({ stack: 'x'.repeat(2000), note: 'y'.repeat(2000) });
  assert.strictEqual(cleaned.stack.length, 1200);
  assert.strictEqual(cleaned.note.length, 300);
});

test('bij een volle buffer volgt het wegschrijven na het huidige verzoek, niet erin', async () => {
  const { appLog, db } = setup({ batchSize: 3 });
  for (let i = 0; i < 3; i += 1) appLog.warn('traag', `regel ${i}`, { tenantId: MAIN });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM app_logs').get().n, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM app_logs').get().n, 3);
});

test('herhalingen na het wegschrijven werken dezelfde regel bij: teller, laatste tijdstip, eerste tijdstip en langste duur', () => {
  const { appLog, clock, db, rows } = setup();
  appLog.warn('taak', 'Trage taak: webshopsynchronisatie', { durationMs: 1200 });
  appLog.warn('stilstand', 'Hoofdthread stond stil', { durationMs: 1500 });
  assert.strictEqual(rows().length, 2);
  for (let i = 0; i < 35; i += 1) {
    clock.time += 5 * 60 * 1000;
    appLog.warn('taak', 'Trage taak: webshopsynchronisatie', { durationMs: 900 + i * 100, data: { vraag: i } });
    rows();
  }
  const row = db.prepare("SELECT repeat_count, created_at, first_at, duration_ms FROM app_logs WHERE source = 'taak'").all();
  assert.strictEqual(row.length, 1);
  assert.strictEqual(Number(row[0].repeat_count), 36);
  assert.strictEqual(row[0].first_at, '2026-11-19T10:00:00.000Z');
  assert.strictEqual(row[0].created_at, new Date(clock.time).toISOString());
  assert.strictEqual(Number(row[0].duration_ms), 4300);
  assert.deepStrictEqual(JSON.parse(db.prepare("SELECT data FROM app_logs WHERE source = 'taak'").get().data), { vraag: 34 }, 'details van de langste keer');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS aantal FROM app_logs WHERE source = 'stilstand'").get().aantal, 1);
  const item = appLog.list(MAIN, { includePlatform: true }).items.find((entry) => entry.source === 'taak');
  assert.strictEqual(item.repeat, 36);
  assert.strictEqual(item.firstAt, '2026-11-19T10:00:00.000Z');
});

test('na meer dan een uur stilte of na 24 uur begint een nieuwe regel; fouten worden nooit samengevoegd', () => {
  const { appLog, clock, rows } = setup();
  appLog.warn('taak', 'Trage taak: x');
  rows();
  clock.time += 61 * 60 * 1000;
  appLog.warn('taak', 'Trage taak: x');
  assert.strictEqual(rows().filter((row) => row.source === 'taak').length, 2);
  appLog.error('fout', 'GET /app/api/x', { tenantId: OTHER, errorCode: 'e1' });
  rows();
  appLog.error('fout', 'GET /app/api/x', { tenantId: OTHER, errorCode: 'e1' });
  assert.strictEqual(rows().filter((row) => row.source === 'fout').length, 2);
});
