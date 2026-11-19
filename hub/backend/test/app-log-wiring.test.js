// Integratietest van het centrale logboek in createApp: een 500 geeft een request-id en een regel met foutcode en omgeving,
// stilstand en mislukte taken komen erin, bewakingsincidenten komen erin en het onderhoud ruimt oude regels per omgeving op.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, listen } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';

/**
 * Start de app met één beheerder.
 * @returns {Promise<{ db: object, app: object, main: string, baas: object, close: Function }>} De onderdelen.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const app = createApp({ secret: 'd'.repeat(64), db });
  const { server, base } = await listen(app);
  const baas = await createLogin(base, { password: PW })('baas');
  return { db, app, main, baas, close: () => server.close() };
}

test('een 500 krijgt een request-id en een regel in het logboek met foutcode en omgeving', async () => {
  const { db, app, main, baas, close } = await setup();
  try {
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => { if (/FROM news\b/.test(sql)) throw new Error('kapot voor de test met password=Geheim123'); return prepare(sql); };
    const response = await baas.get('/app/api/news');
    db.prepare = prepare;
    assert.strictEqual(response.status, 500);
    assert.match(response.headers.get('x-request-id'), /^[0-9a-f]{12}$/);
    assert.strictEqual(response.body.requestId, response.headers.get('x-request-id'));
    app.locals.appLog.flush();
    const row = db.prepare('SELECT tenant_id, level, source, request_id, error_code, data FROM app_logs WHERE error_code = ?').get(response.body.errorId);
    assert.deepStrictEqual([row.tenant_id, row.level, row.source, row.request_id], [main, 'error', 'fout', response.body.requestId]);
    assert.ok(!row.data.includes('Geheim123'));
  } finally { close(); }
});

test('stilstand, trage en mislukte taken en bewakingsincidenten komen in het logboek', async () => {
  const { db, app, main, close } = await setup();
  try {
    app.locals.slowLog.record({ kind: 'stilstand', stalledMs: 2500, runningDuring: ['GET /x'] });
    await assert.rejects(app.locals.slowLog.trackTask('proeftaak', async () => { throw new Error('mislukt'); }));
    await app.locals.monitor.report(main, 'proef', { ok: false, severity: 'fout', title: 'Proefcontrole', message: 'het werkt niet' });
    app.locals.appLog.flush();
    const rows = db.prepare('SELECT scope, level, source, message FROM app_logs WHERE tenant_id = ?').all(main);
    assert.ok(rows.some((row) => row.source === 'stilstand' && row.scope === 'platform'));
    assert.ok(rows.some((row) => row.source === 'taak' && row.level === 'error' && row.message.includes('proeftaak')));
    assert.ok(rows.some((row) => row.source === 'bewaking' && row.level === 'error' && row.message.includes('Proefcontrole')));
  } finally { close(); }
});

test('het onderhoud ruimt oude logregels op volgens de bewaartermijn van de omgeving', async () => {
  const { db, app, main, close } = await setup();
  try {
    const old = new Date(Date.now() - 20 * 86400000).toISOString();
    const insert = db.prepare("INSERT INTO app_logs (id, tenant_id, scope, created_at, level, source, message) VALUES (?, ?, 'tenant', ?, ?, 'traag', 'oud')");
    insert.run('oud-warn', main, old, 'warn');
    insert.run('oud-fout', main, old, 'error');
    app.locals.maintenance();
    const left = db.prepare('SELECT id FROM app_logs WHERE tenant_id = ?').all(main).map((row) => row.id);
    assert.ok(!left.includes('oud-warn'), 'waarschuwing na 14 dagen weg');
    assert.ok(left.includes('oud-fout'), 'fout blijft 30 dagen');
  } finally { close(); }
});
