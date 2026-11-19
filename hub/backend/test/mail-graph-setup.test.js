// Automatische inrichting van Graph-mail: inloggen met een Microsoft-code, daarna app, machtiging en geheim aanmaken.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createGraphSetup, loginProblem } = require('../src/platform/mail-graph-setup');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 'test-secret-graph-setup-0123456789';
const TENANT = '11111111-2222-3333-4444-555555555555';
const APP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ROLE_ID = 'b633e1c5-b582-4048-a93e-9f11b44c7e96';

/**
 * Nagebootst Microsoft voor de inrichting.
 * @param {{ pendingPolls?: number, existingApp?: boolean, denyAssignment?: boolean, tokenError?: string, slowDown?: boolean, foreignApp?: boolean, failPassword?: boolean }} [plan] Wat Microsoft doet.
 * @returns {{ fetchImpl: Function, calls: object[] }} De fetch en de aanroepen.
 */
function fakeMicrosoft(plan = {}) {
  const calls = [];
  let polls = 0;
  /**
   * Een nagebootst antwoord.
   * @param {number} status De statuscode.
   * @param {object} body Het JSON-antwoord.
   * @returns {{ status: number, json: Function }} Het antwoord.
   */
  const reply = (status, body) => ({ status, json: async () => body });
  /**
   * De nagebootste fetch.
   * @param {string} url Het adres.
   * @param {object} init De opties.
   * @returns {Promise<object>} Het antwoord.
   */
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.endsWith('/devicecode')) return reply(200, { device_code: 'dc-geheim', user_code: 'ABCD1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
    if (url.endsWith('/oauth2/v2.0/token')) {
      polls += 1;
      if (plan.tokenError) return reply(400, { error: plan.tokenError });
      if (plan.slowDown && polls === 1) return reply(400, { error: 'slow_down' });
      if (polls <= (plan.pendingPolls || 0)) return reply(400, { error: 'authorization_pending' });
      return reply(200, { access_token: 'admin-token' });
    }
    const path = url.replace('https://graph.microsoft.com/v1.0', '');
    const method = init.method || 'GET';
    if (path.startsWith('/organization')) return reply(200, { value: [{ id: TENANT, displayName: 'Bedrijf BV' }] });
    if (method === 'GET' && path.includes(`appId eq '00000003`)) return reply(200, { value: [{ id: 'graph-sp', appRoles: [{ id: ROLE_ID, value: 'Mail.Send', allowedMemberTypes: ['Application'] }, { id: 'x', value: 'Mail.Read', allowedMemberTypes: ['Application'] }] }] });
    if (method === 'GET' && path.startsWith('/applications?')) return reply(200, { value: plan.foreignApp ? [{ id: 'andere', appId: 'x', tags: [] }] : plan.existingApp ? [{ id: 'app-object', appId: APP_ID, tags: ['aquatech-hub-mail'] }] : [] });
    if (method === 'POST' && path === '/applications') return reply(201, { id: 'app-object', appId: APP_ID });
    if (method === 'GET' && path.startsWith('/servicePrincipals?')) return reply(200, { value: plan.existingApp ? [{ id: 'app-sp' }] : [] });
    if (method === 'POST' && path === '/servicePrincipals') return reply(201, { id: 'app-sp' });
    if (path.endsWith('/appRoleAssignedTo')) return plan.denyAssignment ? reply(403, { error: { code: 'Authorization_RequestDenied' } }) : reply(201, {});
    if (path.endsWith('/sendMail')) return reply(202, {});
    if (path.endsWith('/addPassword') && plan.failPassword && !plan.passwordTried) { plan.passwordTried = true; return reply(500, {}); }
    if (path.endsWith('/addPassword')) return reply(200, { secretText: 'Nieuw-Clientgeheim~42' });
    return reply(404, {});
  };
  return { fetchImpl, calls };
}

test('inrichting: wachten op inlog, dan app, service principal, machtiging Mail.Send en geheim', async () => {
  const microsoft = fakeMicrosoft({ pendingPolls: 1 });
  let time = 1_000_000;
  const setup = createGraphSetup({ fetchImpl: microsoft.fetchImpl, now: () => time });
  const owner = { tenantKey: 't1', userId: 'u1' };
  const login = await setup.start({ ...owner, from: 'offerte@bedrijf.nl' });
  assert.strictEqual(login.userCode, 'ABCD1234');
  assert.ok(!JSON.stringify(login).includes('dc-geheim'), 'device code blijft op de server');
  assert.deepStrictEqual(await setup.poll({ id: login.id, ...owner }), { status: 'pending' });
  assert.deepStrictEqual(await setup.poll({ id: login.id, ...owner }), { status: 'pending' }, 'te snel vragen: wachten');
  time += 6000;
  const done = await setup.poll({ id: login.id, ...owner });
  assert.strictEqual(done.status, 'done');
  assert.strictEqual(done.result.tenantId, TENANT);
  assert.strictEqual(done.result.clientId, APP_ID);
  assert.strictEqual(done.result.secret, 'Nieuw-Clientgeheim~42');
  assert.strictEqual(done.result.from, 'offerte@bedrijf.nl');
  const created = JSON.parse(microsoft.calls.find((call) => call.method === 'POST' && call.url.endsWith('/applications')).body);
  assert.strictEqual(created.signInAudience, 'AzureADMyOrg');
  assert.deepStrictEqual(created.requiredResourceAccess[0].resourceAccess, [{ id: ROLE_ID, type: 'Role' }]);
  const assigned = JSON.parse(microsoft.calls.find((call) => call.url.endsWith('/appRoleAssignedTo')).body);
  assert.deepStrictEqual(assigned, { principalId: 'app-sp', resourceId: 'graph-sp', appRoleId: ROLE_ID });
  assert.strictEqual((await setup.poll({ id: login.id, ...owner })).status, 'done', 'resultaat blijft tot finish');
  setup.finish({ id: login.id, ...owner });
  assert.strictEqual((await setup.poll({ id: login.id, ...owner })).status, 'expired', 'sessie is afgesloten');
});

test('inrichting: twee polls tegelijk richten niets dubbel in', async () => {
  const microsoft = fakeMicrosoft({ failPassword: true });
  let time = 1_000_000;
  const setup = createGraphSetup({ fetchImpl: microsoft.fetchImpl, now: () => time });
  const owner = { tenantKey: 't1', userId: 'u1' };
  const login = await setup.start({ ...owner, from: 'offerte@bedrijf.nl' });
  time += 6000;
  await setup.poll({ id: login.id, ...owner }).catch(() => null);
  /**
   * Telt hoeveel apps er zijn aangemaakt.
   * @returns {number} Het aantal aanroepen.
   */
  const created = () => microsoft.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/applications')).length;
  const before = created();
  const both = await Promise.all([setup.poll({ id: login.id, ...owner }), setup.poll({ id: login.id, ...owner })]);
  assert.deepStrictEqual(both.map((item) => item.status), ['done', 'done']);
  assert.strictEqual(both[0].result.secret, both[1].result.secret);
  assert.ok(created() - before <= 1, 'hoogstens één nieuwe app');
});

test('inrichting: slow_down vertraagt, geweigerde of verlopen inlog en een onbereikbaar Microsoft geven een leesbare uitkomst', async () => {
  let time = 1_000_000;
  const slow = createGraphSetup({ fetchImpl: fakeMicrosoft({ slowDown: true, pendingPolls: 1 }).fetchImpl, now: () => time });
  const owner = { tenantKey: 't1', userId: 'u1' };
  const login = await slow.start(owner);
  assert.deepStrictEqual(await slow.poll({ id: login.id, ...owner }), { status: 'pending' });
  time += 6000;
  assert.deepStrictEqual(await slow.poll({ id: login.id, ...owner }), { status: 'pending' }, 'interval is met 5 s verlengd');
  const declined = createGraphSetup({ fetchImpl: fakeMicrosoft({ tokenError: 'authorization_declined' }).fetchImpl });
  const first = await declined.start(owner);
  assert.strictEqual((await declined.poll({ id: first.id, ...owner })).status, 'denied');
  const expired = createGraphSetup({ fetchImpl: fakeMicrosoft({ tokenError: 'expired_token' }).fetchImpl });
  const second = await expired.start(owner);
  assert.strictEqual((await expired.poll({ id: second.id, ...owner })).status, 'expired');
  const offline = createGraphSetup({ fetchImpl: async () => { throw new Error('netwerk'); } });
  await assert.rejects(offline.start(owner), /Microsoft is niet bereikbaar/);
});

test('inrichting: bestaande app krijgt alleen een nieuw geheim; andere gebruiker of omgeving ziet de sessie niet; weigering leesbaar', async () => {
  const existing = fakeMicrosoft({ existingApp: true });
  const setup = createGraphSetup({ fetchImpl: existing.fetchImpl, now: () => 5_000_000 });
  const result = await setup.provision('admin-token');
  assert.strictEqual(result.clientId, APP_ID);
  assert.ok(!existing.calls.some((call) => call.method === 'POST' && call.url.endsWith('/applications')), 'geen tweede app');
  assert.ok(existing.calls.some((call) => call.url.endsWith('/addPassword')));

  const login = await setup.start({ tenantKey: 't1', userId: 'u1' });
  assert.strictEqual((await setup.poll({ id: login.id, tenantKey: 't2', userId: 'u1' })).status, 'expired');
  assert.strictEqual((await setup.poll({ id: login.id, tenantKey: 't1', userId: 'u2' })).status, 'expired');
  setup.cancel({ id: login.id, tenantKey: 't2', userId: 'u1' });
  setup.cancel({ id: login.id, tenantKey: 't1', userId: 'u1' });
  assert.strictEqual((await setup.poll({ id: login.id, tenantKey: 't1', userId: 'u1' })).status, 'expired');

  const foreign = createGraphSetup({ fetchImpl: fakeMicrosoft({ foreignApp: true }).fetchImpl });
  await assert.rejects(foreign.provision('t'), (error) => error.status === 409 && /niet door AquaTech is aangemaakt/.test(error.message));
  const denied = createGraphSetup({ fetchImpl: fakeMicrosoft({ denyAssignment: true }).fetchImpl });
  await assert.rejects(denied.provision('t'), (error) => /weigerde het verlenen van de machtiging Mail\.Send \(Authorization_RequestDenied\).*Globale beheerder/.test(error.message));
});

test('inrichting: een mislukte stap houdt de sessie; opnieuw vragen herhaalt zonder opnieuw in te loggen', async () => {
  const microsoft = fakeMicrosoft({ failPassword: true, existingApp: true });
  const setup = createGraphSetup({ fetchImpl: microsoft.fetchImpl });
  const owner = { tenantKey: 't1', userId: 'u1' };
  const login = await setup.start(owner);
  await assert.rejects(setup.poll({ id: login.id, ...owner }), /Microsoft gaf een fout bij het aanmaken van het clientgeheim/);
  const retry = await setup.poll({ id: login.id, ...owner });
  assert.strictEqual(retry.status, 'done');
  assert.strictEqual(microsoft.calls.filter((call) => call.url.endsWith('/oauth2/v2.0/token')).length, 1, 'geen tweede inlog nodig');
  assert.strictEqual((await setup.poll({ id: login.id, ...owner })).status, 'done', 'uitkomst blijft tot finish');
  setup.finish({ id: login.id, ...owner });
  assert.strictEqual((await setup.poll({ id: login.id, ...owner })).status, 'expired');
});

test('API: inrichten zet mailServer en het versleutelde geheim; alleen beheerder; geheim nooit in het antwoord', async () => {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!', mustChangePassword: false });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: 'Tuin-Plan-2026!', mustChangePassword: false });
  const microsoft = fakeMicrosoft();
  const graphSetup = createGraphSetup({ fetchImpl: microsoft.fetchImpl });
  const { server, base } = await listen(createApp({ env: {}, secret: SECRET, db, graphFetch: microsoft.fetchImpl, graphSetup }));
  const as = createLogin(base, { password: 'Tuin-Plan-2026!' });
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    assert.strictEqual((await kees.post('/app/api/admin/mail/graph-setup', {})).status, 403);
    const started = await baas.post('/app/api/admin/mail/graph-setup', { from: 'AquaTech <offerte@bedrijf.nl>' });
    assert.strictEqual(started.status, 200);
    assert.strictEqual(started.body.userCode, 'ABCD1234');
    assert.strictEqual((await kees.post(`/app/api/admin/mail/graph-setup/${started.body.id}/poll`, {})).status, 403);
    const polled = await baas.post(`/app/api/admin/mail/graph-setup/${started.body.id}/poll`, {});
    assert.strictEqual(polled.body.status, 'done');
    assert.strictEqual(polled.body.clientId, APP_ID);
    assert.ok(!JSON.stringify(polled.body).includes('Nieuw-Clientgeheim'), 'geheim niet naar de browser');
    const mail = (await baas.get('/app/api/admin/mail')).body;
    assert.strictEqual(mail.config.mode, 'graph');
    assert.strictEqual(mail.config.graphTenantId, TENANT);
    assert.strictEqual(mail.config.graphClientId, APP_ID);
    assert.strictEqual(mail.config.from, 'AquaTech <offerte@bedrijf.nl>');
    assert.strictEqual(mail.graphSecretSet, true);
    assert.match(mail.config.graphSecretExpires, /^\d{4}-\d{2}-\d{2}$/, 'vervaldatum van het geheim bewaard');
    assert.ok(!JSON.stringify((await baas.get('/app/api/admin/settings')).body).includes('Nieuw-Clientgeheim'));
    assert.strictEqual((await baas.post('/app/api/admin/mail/test', { to: 'info@bedrijf.nl' })).status, 200, 'testmail met het nieuwe geheim');
    assert.strictEqual((await baas.post(`/app/api/admin/mail/graph-setup/${started.body.id}/poll`, {})).body.status, 'expired', 'sessie is afgesloten');
    assert.strictEqual((await baas.del(`/app/api/admin/mail/graph-setup/${started.body.id}`)).status, 200);
  } finally {
    server.close();
  }
  const row = db.prepare("SELECT value FROM settings WHERE key = 'mailGraphSecret'").get();
  assert.ok(row && !row.value.includes('Nieuw-Clientgeheim'), 'geheim versleuteld opgeslagen');
});

test('inrichting: gebruikt de Graph PowerShell-client en toont inlogfouten in het Nederlands met verwijzing naar de handleiding', async () => {
  const microsoft = fakeMicrosoft();
  const setup = createGraphSetup({ fetchImpl: microsoft.fetchImpl });
  await setup.start({ tenantKey: 't1', userId: 'u1' });
  const deviceRequest = microsoft.calls.find((call) => call.url.endsWith('/devicecode'));
  assert.match(deviceRequest.body, /client_id=14d82eec-204b-4c2f-b7e8-296a70dab67e/);
  assert.ok(!deviceRequest.body.includes('04b07795'), 'niet meer de Azure CLI-client');
  const blocked = loginProblem({ error: 'invalid_grant', error_description: 'AADSTS65002: Consent between first party application ...' });
  assert.match(blocked, /AADSTS65002/);
  assert.match(blocked, /handleiding hieronder/);
  assert.match(loginProblem({ error: 'invalid_grant', error_description: 'AADSTS90094: admin consent' }), /Globale beheerder/);
  assert.match(loginProblem({}), /handleiding hieronder/);
  const failing = createGraphSetup({ fetchImpl: async () => ({ status: 400, json: async () => ({ error: 'unauthorized_client', error_description: 'AADSTS700016: x' }) }) });
  await assert.rejects(failing.start({ tenantKey: 't1', userId: 'u1' }), /AADSTS700016.*handleiding hieronder/);
});
