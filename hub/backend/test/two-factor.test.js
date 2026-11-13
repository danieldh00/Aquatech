// Tweestapsverificatie (5 uit de audit van 1.7.3): de TOTP-rekenkern tegen de testvectoren van RFC 6238, de QR-code,
// aanzetten op het profiel, inloggen met code / herstelcode, geen hergebruik van een code, uitzetten door de gebruiker
// en door een beheerder (andere tenant 404, zonder recht 403), en een account met 2FA logt niet via de winkel in.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const Totp = require('../src/beveiliging/totp');
const QrCode = require('../../frontend/shared/qr-code');
const { createClient, createLogin, listen, postForm } = require('./helpers/http-client');

const SECRET = 't'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, installateur en klant, en een andere organisatie met een eigen beheerder.
 * @returns {Promise<{ base: string, store: object, main: string, login: Function }>} Adres, opslag, hoofdtenant en inlogfunctie.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW, mustChangePassword: false });
  await store.createAccount(main, { username: 'piet', displayName: 'Piet', role: 'installateur', password: PW, mustChangePassword: false });
  await store.createAccount(main, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW, mustChangePassword: false });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, loginDelayMs: 0 }));
  servers.push(server);
  return { base, store, main, login: createLogin(base, { password: PW }) };
}

/**
 * Zet tweestapsverificatie aan voor een ingelogde client.
 * @param {object} client De ingelogde client.
 * @returns {Promise<{ secret: string, recoveryCodes: string[] }>} Het geheim en de herstelcodes.
 */
async function enable(client) {
  const started = await client.post('/app/api/account/totp/setup', {});
  assert.strictEqual(started.status, 200, JSON.stringify(started.body));
  assert.match(started.body.uri, /^otpauth:\/\/totp\/AquaTech%3A/);
  const confirmed = await client.post('/app/api/account/totp/confirm', { code: Totp.codeAt(started.body.secret, Totp.stepOf()) });
  assert.strictEqual(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.strictEqual(confirmed.body.enabled, true);
  return { secret: started.body.secret, recoveryCodes: confirmed.body.recoveryCodes };
}

test('TOTP volgt de testvectoren van RFC 6238 en weigert hergebruik', () => {
  const secret = Totp.toBase32(Buffer.from('12345678901234567890'));
  assert.strictEqual(Totp.codeAt(secret, Math.floor(59 / 30)), '287082');
  assert.strictEqual(Totp.codeAt(secret, Math.floor(1111111109 / 30)), '081804');
  const now = 1111111109 * 1000;
  const checked = Totp.verify(secret, '081 804', { now });
  assert.deepStrictEqual(checked, { ok: true, step: Math.floor(1111111109 / 30) });
  assert.strictEqual(Totp.verify(secret, '081804', { now, lastStep: checked.step }).ok, false);
  assert.strictEqual(Totp.verify(secret, '000000', { now }).ok, false);
  assert.strictEqual(Totp.verify(secret, 'abc', { now }).ok, false);
  const recovery = Totp.newRecoveryCodes();
  assert.strictEqual(recovery.codes.length, Totp.RECOVERY_COUNT);
  assert.strictEqual(Totp.matchRecovery(recovery.hashes, recovery.codes[3].toLowerCase()), 3);
  assert.strictEqual(Totp.matchRecovery(recovery.hashes, 'AAAAA-AAAAA'), -1);
});

test('QR-code: vierkant met vinderpatronen en een SVG', () => {
  const modules = QrCode.matrix('otpauth://totp/AquaTech%3Abaas?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&issuer=AquaTech');
  assert.ok(modules.length >= 21 && modules.length === modules[0].length);
  assert.strictEqual((modules.length - 17) % 4, 0);
  assert.ok(modules[0].slice(0, 7).every(Boolean) && modules[6].slice(0, 7).every(Boolean));
  const image = QrCode.svg('test', { label: 'QR <code>' });
  assert.match(image, /^<svg[^>]*role="img"/);
  assert.doesNotMatch(image, /<code>/);
});

test('inloggen met tweestapsverificatie: code nodig, geen hergebruik, herstelcode één keer', async () => {
  const { base, login } = await setup();
  const piet = await login('piet');
  assert.strictEqual((await piet.get('/app/api/account/totp')).body.enabled, false);
  const { secret, recoveryCodes } = await enable(piet);
  assert.strictEqual(recoveryCodes.length, 10);
  assert.strictEqual((await piet.post('/app/api/account/totp/setup', {})).status, 409);

  const client = createClient(base);
  const missing = await client.post('/app/api/auth/login', { username: 'piet', password: PW });
  assert.strictEqual(missing.status, 401);
  assert.strictEqual(missing.body.error, 'totp_required');
  assert.strictEqual((await client.get('/app/api/me')).body.user?.username, undefined);
  const wrong = await client.post('/app/api/auth/login', { username: 'piet', password: PW, totp: '000000' });
  assert.strictEqual(wrong.body.error, 'totp_wrong');
  // Met een verkeerd wachtwoord komt de vraag om een code niet (verraadt niets over 2FA).
  assert.strictEqual((await client.post('/app/api/auth/login', { username: 'piet', password: 'Fout-Wachtwoord-1', totp: '123456' })).body.error, 'wrong_login');

  const next = Totp.codeAt(secret, Totp.stepOf() + 1);
  assert.strictEqual((await client.post('/app/api/auth/login', { username: 'piet', password: PW, totp: next })).status, 200);
  const replay = await createClient(base).post('/app/api/auth/login', { username: 'piet', password: PW, totp: next });
  assert.strictEqual(replay.body.error, 'totp_wrong');

  const viaRecovery = createClient(base);
  assert.strictEqual((await viaRecovery.post('/app/api/auth/login', { username: 'piet', password: PW, totp: recoveryCodes[0] })).status, 200);
  assert.strictEqual((await viaRecovery.get('/app/api/account/totp')).body.recoveryLeft, 9);
  assert.strictEqual((await createClient(base).post('/app/api/auth/login', { username: 'piet', password: PW, totp: recoveryCodes[0] })).body.error, 'totp_wrong');

  // Zelf uitzetten: wachtwoord én code nodig.
  assert.strictEqual((await viaRecovery.post('/app/api/account/totp/disable', { password: PW, code: '' })).status, 400);
  assert.strictEqual((await viaRecovery.post('/app/api/account/totp/disable', { password: 'Fout-Wachtwoord-1', code: recoveryCodes[1] })).status, 400);
  const off = await viaRecovery.post('/app/api/account/totp/disable', { password: PW, code: recoveryCodes[1] });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.enabled, false);
  assert.strictEqual((await createClient(base).post('/app/api/auth/login', { username: 'piet', password: PW })).status, 200);
});

test('tweede stap: hooguit 10 verkeerde codes per account, ook bij gelijktijdige pogingen', async () => {
  const { base, login } = await setup();
  await enable(await login('piet'));
  // Elke poging van een eigen adres, zodat alleen de accountbrede grens telt (niet de grens per bezoeker).
  /**
   * Een inlogpoging met een verkeerde code vanaf een eigen bezoekeradres.
   * @param {number} index Volgnummer van de poging (bepaalt het adres).
   * @returns {Promise<object>} Het antwoord.
   */
  const attempt = (index) => createClient(base).request('POST', '/app/api/auth/login', { username: 'piet', password: PW, totp: '000000' }, { 'X-Forwarded-For': `198.51.100.${index + 1}` });
  const attempts = await Promise.all(Array.from({ length: 14 }, (_, index) => attempt(index)));
  const wrong = attempts.filter((answer) => answer.body.error === 'totp_wrong').length;
  assert.strictEqual(wrong, 10, `${wrong} codes gecontroleerd`);
  const after = await attempt(50);
  assert.strictEqual(after.status, 429);
  assert.strictEqual(after.body.error, 'locked');
});

test('beheerder zet tweestapsverificatie van een collega uit; andere tenant 404, zonder recht 403', async () => {
  const { store, main, login } = await setup();
  const piet = await login('piet');
  await enable(piet);
  const pietId = store.listUsers(main).find((user) => user.username === 'piet').id;
  const admin = await login('baas');
  const listed = (await admin.get('/app/api/admin/users')).body.items.find((user) => user.id === pietId);
  assert.strictEqual(listed.twoFactor, true);
  assert.strictEqual((await piet.del(`/app/api/admin/users/${pietId}/totp`)).status, 403);
  assert.strictEqual((await (await login('vreemd', 'ander')).del(`/app/api/admin/users/${pietId}/totp`)).status, 404);
  const reset = await admin.del(`/app/api/admin/users/${pietId}/totp`);
  assert.deepStrictEqual(reset.body, { ok: true, changed: true });
  assert.strictEqual((await piet.get('/app/api/account/totp')).body.enabled, false);
});

test('een klant met tweestapsverificatie logt niet via de winkel in', async () => {
  const { base, login } = await setup();
  const admin = await login('baas');
  await admin.put('/app/api/admin/settings', { storefront: true });
  const klaas = await login('klaas');
  await enable(klaas);
  const shop = createClient(base);
  const answer = await postForm(base, shop, '/inloggen/', { login: 'klaas', password: PW });
  assert.notStrictEqual(answer.status, 303);
  assert.match(answer.text, /tweestapsverificatie/);
});
