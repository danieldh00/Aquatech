// Overdracht van de Drive-hersteltest aan het hostscript (platform/drive-restore-app-check.js) en het samenvoegen van de uitslag
// (mergeAppCheck): de back-up wordt klaargezet, de uitslag van het script gelezen, alles opgeruimd en een stil script is een waarschuwing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDriveAppCheck, sanitizeStatus } = require('../src/platform/drive-restore-app-check');
const { mergeAppCheck } = require('../src/platform/drive-restore-test');

/**
 * Maakt een statusmap, een aanvraagmap en een back-upbestand.
 * @returns {{ root: string, statusDir: string, requestDir: string, file: string }} De paden.
 */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-app-check-'));
  const statusDir = path.join(root, 'status');
  const requestDir = path.join(root, 'request');
  fs.mkdirSync(statusDir);
  fs.mkdirSync(requestDir);
  const file = path.join(root, 'aquatech-20261120-040000.db.enc');
  fs.writeFileSync(file, 'versleutelde inhoud');
  return { root, statusDir, requestDir, file };
}

/**
 * Een nagebootst hostscript: pakt de aanvraag op en schrijft de uitslag.
 * @param {{ statusDir: string, requestDir: string }} dirs De mappen.
 * @param {object} reply Wat het script meldt (zonder id).
 * @returns {Function} sleep-vervanger voor createDriveAppCheck.
 */
function fakeHost(dirs, reply) {
  return async () => {
    const request = path.join(dirs.requestDir, 'drive-restore', 'request.json');
    if (!fs.existsSync(request)) return;
    const { id } = JSON.parse(fs.readFileSync(request, 'utf8'));
    assert.ok(fs.existsSync(path.join(dirs.requestDir, 'drive-restore', 'backup.db.enc')), 'de back-up staat klaar');
    fs.rmSync(request);
    fs.writeFileSync(path.join(dirs.statusDir, 'drive-restore-app.json'), JSON.stringify({ id, ...reply }));
  };
}

test('de uitslag van het hostscript komt terug en de overdracht wordt opgeruimd', async () => {
  const dirs = setup();
  const sanity = [{ name: 'Inloggen als beheerder', value: 1, ok: true }];
  const check = createDriveAppCheck({ ...dirs, pollMs: 1, sleep: fakeHost(dirs, { state: 'klaar', message: 'goed', sanity }) });
  const result = await check.run({ file: dirs.file, name: 'aquatech-20261120-040000.db.enc' });
  assert.deepStrictEqual(result, { ran: true, ok: true, message: 'goed', sanity });
  assert.deepStrictEqual(fs.readdirSync(path.join(dirs.requestDir, 'drive-restore')), []);
});

test('een mislukte controle van het script blijft mislukt', async () => {
  const dirs = setup();
  const check = createDriveAppCheck({ ...dirs, pollMs: 1, sleep: fakeHost(dirs, { state: 'mislukt', message: 'Inloggen faalde', sanity: [{ name: 'Inloggen', value: 0, ok: false }] }) });
  const result = await check.run({ file: dirs.file, name: 'x.db.enc' });
  assert.strictEqual(result.ran, true);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.message, 'Inloggen faalde');
});

test('een stil hostscript geeft ran=false en ruimt de overdracht op', async () => {
  const dirs = setup();
  const check = createDriveAppCheck({ ...dirs, pickupMs: 5, pollMs: 2 });
  const result = await check.run({ file: dirs.file, name: 'x.db.enc' });
  assert.strictEqual(result.ran, false);
  assert.match(result.message, /servertaak 007/);
  assert.deepStrictEqual(fs.readdirSync(path.join(dirs.requestDir, 'drive-restore')), []);
});

test('een uitslag van een eerdere aanvraag telt niet', async () => {
  const dirs = setup();
  fs.writeFileSync(path.join(dirs.statusDir, 'drive-restore-app.json'), JSON.stringify({ id: '11111111-1111-1111-1111-111111111111', state: 'klaar', message: 'oud', sanity: [] }));
  const result = await createDriveAppCheck({ ...dirs, pickupMs: 5, pollMs: 2 }).run({ file: dirs.file, name: 'x.db.enc' });
  assert.strictEqual(result.ran, false);
});

test('zonder mappen is de controle niet beschikbaar; onbruikbare status wordt genegeerd', async () => {
  const check = createDriveAppCheck({});
  assert.strictEqual(check.available, false);
  assert.strictEqual((await check.run({ file: 'x', name: 'x' })).ran, false);
  assert.strictEqual(sanitizeStatus({ id: 'geen-uuid', state: 'klaar' }), null);
  assert.strictEqual(sanitizeStatus({ id: '11111111-1111-1111-1111-111111111111', state: 'raar' }), null);
});

test('mergeAppCheck: mislukt bij een mislukte app, waarschuwing zonder uitslag, anders geslaagd', () => {
  const outcome = { state: 'geslaagd', message: 'ok', sanity: [{ name: 'a', value: 1, ok: true }] };
  assert.strictEqual(mergeAppCheck(outcome, { ran: true, ok: false, message: 'kapot', sanity: [] }).state, 'mislukt');
  const silent = mergeAppCheck(outcome, { ran: false, ok: true, message: 'draaide niet', sanity: [] });
  assert.strictEqual(silent.state, 'waarschuwing');
  assert.strictEqual(silent.message, 'draaide niet');
  const good = mergeAppCheck(outcome, { ran: true, ok: true, message: '', sanity: [{ name: 'b', value: 1, ok: true }] });
  assert.strictEqual(good.state, 'geslaagd');
  assert.strictEqual(good.sanity.length, 2);
});
