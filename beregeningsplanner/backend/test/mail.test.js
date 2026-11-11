// E-mailinstellingen in Beheer: SMTP of Exchange Online-connector, en het
// WAN-IP van de server voor de connector.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createMailer, sanitizeMail, mailFailure } = require('../src/platform/mailer');
const { createWanIp } = require('../src/platform/wan-ip');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const SECRET = 'test-secret-mail-0123456789abcdef';

test('WAN-IP: omgeving gaat voor, opzoeken met terugval, onthouden en alleen openbaar IPv4', async () => {
  let currentTime = 1_000_000;
  const calls = [];
  const answers = { a: 'geen ip', b: '203.0.113.9', c: '93.184.215.14\n' };
  /**
   * Nagebootste fetch: 'x' faalt, de rest geeft het vaste antwoord.
   * @param {string} url Bron.
   * @returns {Promise<string>} Het antwoord.
   */
  const fakeFetch = async (url) => { calls.push(url); if (url === 'x') throw new Error('weg'); return answers[url]; };
  const wan = createWanIp({ fetch: fakeFetch, env: {}, now: () => currentTime, sources: ['x', 'a', 'b', 'c'] });
  const first = await wan.get();
  assert.strictEqual(first.ip, '93.184.215.14', 'ongeldig en documentatieadres overgeslagen');
  assert.strictEqual(first.source, 'opgezocht');
  assert.deepStrictEqual(calls, ['x', 'a', 'b', 'c']);
  currentTime += 30_000;
  await wan.get({ refresh: true });
  assert.strictEqual(calls.length, 4, 'niet vaker dan eens per minuut opnieuw');
  currentTime += 60_000;
  await wan.get({ refresh: true });
  assert.strictEqual(calls.length, 8);
  assert.strictEqual((await createWanIp({ fetch: fakeFetch, env: { WAN_IP: '8.8.4.4' } }).get()).source, 'omgeving');
  await assert.rejects(createWanIp({ fetch: async () => '192.168.2.251', env: {} }).get(), { code: 'unavailable' });
});

test('mailer: Exchange-connector zonder inlog, met verplichte TLS', async () => {
  const conf = sanitizeMail({ mode: 'connector', host: 'bedrijf-nl.mail.protection.outlook.com', port: 25, user: 'blijft-leeg', from: 'info@bedrijf.nl' });
  assert.strictEqual(conf.mode, 'connector');
  assert.strictEqual(conf.user, '');
  assert.strictEqual(sanitizeMail({ mode: 'iets' }).mode, 'smtp');
  let used = null;
  const settings = { get: (key) => (key === 'mailServer' ? { ...conf, user: 'x' } : 'wachtwoord') };
  const mailer = createMailer(settings, { resolveHost: async () => '52.101.1.1', createTransport: (options) => { used = options; return { sendMail: async () => ({}) }; } });
  await mailer.send({ to: 'klant@example.nl', subject: 's', text: 't' });
  assert.strictEqual(used.auth, undefined, 'geen inlog bij de connector');
  assert.strictEqual(used.requireTLS, true);
  assert.strictEqual(used.port, 25);
});

test('API: e-mail en WAN-IP alleen voor beheerders, wachtwoord nooit terug', async () => {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!', mustChangePassword: false });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: 'Tuin-Plan-2026!', mustChangePassword: false });
  let lookups = 0;
  const wanIp = createWanIp({ fetch: async () => { lookups++; return '93.184.215.14'; }, env: {} });
  const sent = [];
  /**
   * Mailer die niets verstuurt maar elk bericht (met inlog) bewaart.
   * @param {object} settings Instellingen van de omgeving.
   * @returns {object} De mailer.
   */
  const mailerFor = (settings) => createMailer(settings, { resolveHost: async (host) => host, createTransport: (options) => ({ sendMail: async (message) => { sent.push({ ...message, auth: options.auth }); return {}; } }) });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, wanIp, mailerFor }));
  const as = createLogin(base, { password: 'Tuin-Plan-2026!' });
  try {
    const baas = await as('baas'), kees = await as('kees');
    assert.strictEqual((await createClient(base).get('/app/api/admin/wan-ip')).status, 401);
    assert.strictEqual((await kees.get('/app/api/admin/wan-ip')).status, 403);
    assert.strictEqual((await kees.put('/app/api/admin/mail', { config: { host: 'smtp.x' } })).status, 403);
    const ip = await baas.get('/app/api/admin/wan-ip');
    assert.strictEqual(ip.status, 200);
    assert.strictEqual(ip.body.ip, '93.184.215.14');
    await baas.get('/app/api/admin/wan-ip');
    assert.strictEqual(lookups, 1, 'onthouden');

    const put = await baas.put('/app/api/admin/mail', { config: { mode: 'smtp', host: 'smtp.bedrijf.nl', port: 587, user: 'info', from: 'info@bedrijf.nl' }, password: 'geheim-wachtwoord' });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.passwordSet, true);
    assert.ok(!JSON.stringify(put.body).includes('geheim-wachtwoord'));
    assert.ok(!JSON.stringify((await baas.get('/app/api/admin/settings')).body).includes('geheim-wachtwoord'));

    const conn = await baas.put('/app/api/admin/mail', { config: { mode: 'connector', host: 'bedrijf-nl.mail.protection.outlook.com', port: 25, from: 'info@bedrijf.nl' } });
    assert.strictEqual(conn.body.config.mode, 'connector');
    assert.strictEqual(conn.body.config.user, '');
    assert.strictEqual((await baas.post('/app/api/admin/mail/test', { to: 'info@bedrijf.nl' })).status, 200);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].auth, undefined);
  } finally {
    server.close();
  }
});

/**
 * Een fout zoals nodemailer hem gooit.
 * @param {string} code De code (EAUTH, EENVELOPE, ...).
 * @param {object} [extra] Extra velden (response, command).
 * @returns {Error} De fout.
 */
const smtpError = (code, extra = {}) => Object.assign(new Error(`SMTP-fout ${code}`), { code, ...extra });

test('mailFailure: leesbare melding per soort fout, met het antwoord van de mailserver', () => {
  assert.strictEqual(mailFailure(smtpError('EAUTH', { response: '535 5.7.3\r\n Authentication unsuccessful' })),
    'Versturen mislukt: de mailserver weigert de inloggegevens. Controleer gebruikersnaam en wachtwoord (bij Microsoft 365 of Gmail vaak een app-wachtwoord) in Beheer → Integraties → E-mail. (mailserver: 535 5.7.3 Authentication unsuccessful)');
  assert.match(mailFailure(smtpError('ETIMEDOUT')), /^Versturen mislukt: de mailserver is niet bereikbaar\. Controleer server en poort/);
  assert.match(mailFailure(smtpError('ECONNECTION')), /niet bereikbaar/);
  assert.match(mailFailure(Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'ESOCKET' })), /beveiligde verbinding \(TLS\)/);
  assert.match(mailFailure(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ESOCKET' })), /niet bereikbaar/);
  assert.match(mailFailure(new Error('unable to verify the first certificate')), /beveiligde verbinding \(TLS\)/);
  assert.match(mailFailure(smtpError('EENVELOPE', { command: 'MAIL FROM', response: '550 5.7.1 Client does not have permissions to send as this sender' })), /weigert het afzenderadres.*\(mailserver: 550 5\.7\.1/);
  assert.match(mailFailure(smtpError('EENVELOPE', { command: 'RCPT TO', response: '550 5.1.1 User unknown' })), /weigert het adres van de ontvanger/);
  assert.match(mailFailure(smtpError('EMESSAGE', { response: '552 Message size exceeds' })), /weigert het bericht/);
  assert.strictEqual(mailFailure(Object.assign(new Error('De mailserver moet een openbaar adres hebben.'), { code: 'invalid_host' })), 'Versturen mislukt: De mailserver moet een openbaar adres hebben.');
  // Een onbekende fout: geen interne melding, wel het antwoord van de server als dat er is.
  assert.strictEqual(mailFailure(new TypeError('Cannot read properties of undefined')), 'Versturen mislukt: de mailserver gaf een fout.');
  assert.ok(mailFailure(smtpError('EAUTH', { response: 'x'.repeat(1000) })).length < 450, 'antwoord ingekort');
});

test('API: mislukte mail geeft een leesbare melding, de oorzaak alleen in de debugmodus', async () => {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!', mustChangePassword: false });
  /**
   * Mailer waarvan de mailserver de inlog weigert.
   * @param {object} settings Instellingen van de omgeving.
   * @returns {object} De mailer.
   */
  const mailerFor = (settings) => createMailer(settings, { resolveHost: async (host) => host, createTransport: () => ({ sendMail: async () => { throw smtpError('EAUTH', { response: '535 5.7.3 Authentication unsuccessful', command: 'AUTH PLAIN' }); } }) });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, mailerFor }));
  try {
    const baas = await createLogin(base, { password: 'Tuin-Plan-2026!' })('baas');
    await baas.put('/app/api/admin/mail', { config: { mode: 'smtp', host: 'smtp.bedrijf.nl', port: 587, user: 'info', from: 'info@bedrijf.nl' }, password: 'geheim-wachtwoord' });
    let response = await baas.post('/app/api/admin/mail/test', { to: 'info@bedrijf.nl' });
    assert.strictEqual(response.status, 502);
    assert.match(response.body.message, /^Versturen mislukt: de mailserver weigert de inloggegevens\..*\(mailserver: 535 5\.7\.3 Authentication unsuccessful\)$/);
    assert.strictEqual(response.body.debug, undefined);

    await baas.put('/app/api/admin/settings', { debugMode: true });
    response = await baas.post('/app/api/admin/mail/test', { to: 'info@bedrijf.nl' });
    assert.strictEqual(response.status, 502);
    assert.strictEqual(response.body.debug.cause.message, 'SMTP-fout EAUTH');
    assert.strictEqual(response.body.debug.cause.code, 'EAUTH');
    assert.ok(!JSON.stringify(response.body).includes('geheim-wachtwoord'), 'nooit het wachtwoord');
  } finally {
    server.close();
  }
});
