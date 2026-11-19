// Mail via Microsoft Graph: verzenden, foutmeldingen, instellingen (geheim versleuteld) en de testmail in Beheer.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createMailer, sanitizeMail, mailFailure } = require('../src/platform/mailer');
const { createGraphSender, parseSender } = require('../src/platform/mail-graph');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 'test-secret-graph-0123456789abcdef';
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/**
 * Nagebootst Microsoft: een token-adres en sendMail; `plan` kiest de uitkomst.
 * @param {{ token?: number, send?: number, sendBody?: object, tokenBody?: object }} plan Statuscodes en antwoorden.
 * @returns {{ fetchImpl: Function, calls: object[] }} De fetch en de vastgelegde aanroepen.
 */
function fakeMicrosoft(plan = {}) {
  const calls = [];
  /**
   * De nagebootste fetch.
   * @param {string} url Het adres.
   * @param {object} init De opties.
   * @returns {Promise<object>} Een antwoord met status en json().
   */
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const isToken = url.includes('/oauth2/v2.0/token');
    const status = isToken ? plan.token || 200 : plan.send || 202;
    const body = isToken ? plan.tokenBody || (status === 200 ? { access_token: 'tok', expires_in: 3600 } : {}) : plan.sendBody || {};
    return { status, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('sanitizeMail: soort graph met geldige id\'s, ongeldige waarden worden leeg', () => {
  const ok = sanitizeMail({ mode: 'graph', graphTenantId: TENANT, graphClientId: CLIENT, from: 'a@b.nl', user: 'x' });
  assert.strictEqual(ok.mode, 'graph');
  assert.strictEqual(ok.graphTenantId, TENANT);
  assert.strictEqual(ok.graphClientId, CLIENT);
  assert.strictEqual(ok.user, '');
  assert.strictEqual(sanitizeMail({ mode: 'graph', graphTenantId: 'x/../y', graphClientId: 'nee' }).graphTenantId, '');
  assert.strictEqual(sanitizeMail({ mode: 'graph', graphTenantId: 'bedrijf.onmicrosoft.com' }).graphTenantId, 'bedrijf.onmicrosoft.com');
  assert.strictEqual(sanitizeMail({ mode: 'graph', graphClientId: 'nee' }).graphClientId, '');
  assert.strictEqual(sanitizeMail({ mode: 'graph', graphSecretExpires: '2027-05-31' }).graphSecretExpires, '2027-05-31');
  assert.strictEqual(sanitizeMail({ mode: 'graph', graphSecretExpires: '31-05-2027' }).graphSecretExpires, '');
  assert.strictEqual(sanitizeMail({ mode: 'graph', graphSecretExpires: '2027-13-45' }).graphSecretExpires, '');
});

test('parseSender: naam en adres', () => {
  assert.deepStrictEqual(parseSender('AquaTech Service <offerte@bedrijf.nl>'), { address: 'offerte@bedrijf.nl', name: 'AquaTech Service' });
  assert.deepStrictEqual(parseSender('offerte@bedrijf.nl'), { address: 'offerte@bedrijf.nl', name: '' });
});

test('Graph: token + sendMail met ontvangers, bijlage en inline afbeelding; token wordt onthouden', async () => {
  const { fetchImpl, calls } = fakeMicrosoft();
  const sender = createGraphSender({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'cs-uniek-1', from: 'AquaTech <offerte@bedrijf.nl>' }, { fetchImpl });
  const payload = { to: ['klant@x.nl'], bcc: 'kopie@bedrijf.nl', replyTo: 'info@bedrijf.nl', subject: 'Offerte', html: '<p>Hoi</p>', attachments: [{ filename: 'o.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' }, { filename: 'a.png', content: Buffer.from('png'), contentType: 'image/png', cid: 'afbeelding1@aquatech' }] };
  await sender.send(payload);
  await sender.send(payload);
  assert.strictEqual(calls.filter((call) => call.url.includes('/token')).length, 1, 'token onthouden');
  const [tokenCall, sendCall] = calls;
  assert.ok(tokenCall.url.startsWith(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`));
  assert.match(tokenCall.init.body, /grant_type=client_credentials/);
  assert.strictEqual(sendCall.url, 'https://graph.microsoft.com/v1.0/users/offerte%40bedrijf.nl/sendMail');
  assert.strictEqual(sendCall.init.headers.authorization, 'Bearer tok');
  const body = JSON.parse(sendCall.init.body);
  assert.strictEqual(body.saveToSentItems, true);
  assert.strictEqual(body.message.body.contentType, 'HTML');
  assert.deepStrictEqual(body.message.toRecipients, [{ emailAddress: { address: 'klant@x.nl' } }]);
  assert.deepStrictEqual(body.message.from, { emailAddress: { address: 'offerte@bedrijf.nl', name: 'AquaTech' } });
  assert.strictEqual(body.message.attachments[0].contentBytes, Buffer.from('pdf').toString('base64'));
  assert.strictEqual(body.message.attachments[1].isInline, true);
  assert.strictEqual(body.message.attachments[1].contentId, 'afbeelding1@aquatech');
});

test('Graph: foutmeldingen per soort, nooit het clientgeheim', async () => {
  /**
   * Verstuurt met een nagebootste fout en geeft de melding.
   * @param {object} plan De uitkomst van de nagebootste Microsoft.
   * @param {string} secret Een uniek geheim (het token wordt per geheim onthouden).
   * @returns {Promise<string>} De melding van mailFailure.
   */
  const failure = async (plan, secret) => {
    const sender = createGraphSender({ tenantId: TENANT, clientId: CLIENT, clientSecret: secret, from: 'offerte@bedrijf.nl' }, { fetchImpl: fakeMicrosoft(plan).fetchImpl });
    try { await sender.send({ to: ['k@x.nl'], subject: 's', text: 't' }); } catch (error) { return mailFailure(error); }
    return '';
  };
  const auth = await failure({ token: 401, tokenBody: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided. Trace ID: abc' } }, 'cs-uniek-2');
  assert.match(auth, /weigert de aanmelding.*tenant-ID, client-ID en het clientgeheim.*AADSTS7000215: Invalid client secret provided\./);
  assert.ok(!auth.includes('cs-uniek-2') && !auth.includes('Trace ID'));
  assert.match(await failure({ send: 403, sendBody: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } }, 'cs-uniek-3'), /weigert de app toegang.*Mail\.Send.*Application Access Policy.*ErrorAccessDenied/);
  assert.match(await failure({ send: 404, sendBody: { error: { code: 'ErrorInvalidUser', message: 'x' } } }, 'cs-uniek-4'), /mailbox is niet gevonden/);
  assert.match(await failure({ send: 429 }, 'cs-uniek-5'), /beperkt het versturen/);
  assert.match(await failure({ send: 500 }, 'cs-uniek-6'), /Microsoft Graph gaf een fout/);
  const unreachable = createGraphSender({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'cs-uniek-7', from: 'a@b.nl' }, { fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { name: 'TimeoutError' }); } });
  await assert.rejects(unreachable.verify(), (error) => {
    assert.match(mailFailure(error), /login\.microsoftonline\.com:443 is niet bereikbaar \(HTTPS\)/);
    return true;
  });
  const big = createGraphSender({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'cs-uniek-8', from: 'a@b.nl' }, { fetchImpl: fakeMicrosoft().fetchImpl });
  await assert.rejects(big.send({ to: ['k@x.nl'], subject: 's', text: 't', attachments: [{ filename: 'g.bin', content: Buffer.alloc(4 * 1024 * 1024) }] }), (error) => /te groot/.test(mailFailure(error)));
  // Twee bijlagen die elk apart klein genoeg lijken, maar samen (als base64) boven de grens van Graph komen.
  const two = createGraphSender({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'cs-uniek-9', from: 'a@b.nl' }, { fetchImpl: fakeMicrosoft().fetchImpl });
  await assert.rejects(two.send({ to: ['k@x.nl'], subject: 's', text: 't', attachments: [{ filename: 'a.bin', content: Buffer.alloc(2 * 1024 * 1024) }, { filename: 'b.bin', content: Buffer.alloc(2 * 1024 * 1024) }] }), (error) => /het bericht met bijlagen is te groot/.test(mailFailure(error)));
  assert.match(await failure({ send: 413 }, 'cs-uniek-10'), /te groot/);
  const one = createGraphSender({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'cs-uniek-11', from: 'a@b.nl' }, { fetchImpl: fakeMicrosoft().fetchImpl });
  await one.send({ to: ['k@x.nl'], subject: 's', text: 't', attachments: [{ filename: 'a.bin', content: Buffer.alloc(2 * 1024 * 1024) }] });
});

test('API: Graph-instellingen met versleuteld geheim, configured, verify en testmail', async () => {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!', mustChangePassword: false });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: 'Tuin-Plan-2026!', mustChangePassword: false });
  const microsoft = fakeMicrosoft();
  const { server, base } = await listen(createApp({ env: {}, secret: SECRET, db, graphFetch: microsoft.fetchImpl }));
  const as = createLogin(base, { password: 'Tuin-Plan-2026!' });
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    assert.strictEqual((await kees.put('/app/api/admin/mail', { config: { mode: 'graph' }, graphSecret: 'x'.repeat(20) })).status, 403);
    let response = await baas.post('/app/api/admin/mail/test', { to: 'info@bedrijf.nl' });
    assert.strictEqual(response.status, 409, 'nog niet ingesteld');
    const put = await baas.put('/app/api/admin/mail', { config: { mode: 'graph', graphTenantId: TENANT, graphClientId: CLIENT, from: 'AquaTech <offerte@bedrijf.nl>' }, graphSecret: 'Geheim-Graph-Waarde~1' });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.graphSecretSet, true);
    assert.strictEqual(put.body.config.mode, 'graph');
    assert.ok(!JSON.stringify(put.body).includes('Geheim-Graph-Waarde'));
    assert.ok(!JSON.stringify((await baas.get('/app/api/admin/settings')).body).includes('Geheim-Graph-Waarde'));
    assert.strictEqual((await baas.get('/app/api/admin/mail')).body.graphSecretSet, true);
    response = await baas.post('/app/api/admin/mail/test', { to: 'info@bedrijf.nl' });
    assert.strictEqual(response.status, 200);
    const sendCall = microsoft.calls.find((call) => call.url.endsWith('/sendMail'));
    assert.ok(sendCall, 'sendMail aangeroepen');
    assert.strictEqual(JSON.parse(sendCall.init.body).message.toRecipients[0].emailAddress.address, 'info@bedrijf.nl');
  } finally {
    server.close();
  }
  const settingsRow = db.prepare("SELECT value FROM settings WHERE key = 'mailGraphSecret'").get();
  assert.ok(settingsRow && !settingsRow.value.includes('Geheim-Graph-Waarde'), 'geheim versleuteld opgeslagen');
});

test('createMailer: graph is pas ingesteld met tenant, client, afzender en geheim', () => {
  const values = { mailServer: { mode: 'graph', graphTenantId: TENANT, graphClientId: CLIENT, from: 'a@b.nl' }, mailGraphSecret: '' };
  const settings = { get: (key) => values[key] };
  const mailer = createMailer(settings, { fetchImpl: fakeMicrosoft().fetchImpl });
  assert.strictEqual(mailer.configured(), false);
  values.mailGraphSecret = 'Geheim-Graph-Waarde~1';
  assert.strictEqual(mailer.configured(), true);
});
