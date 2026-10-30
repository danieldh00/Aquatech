// Accounts in de webshop: registreren en inloggen vanuit winkel/ gebruiken
// dezelfde accounts (rol klant) als de planner, met dezelfde sessie.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, createClient, listen, storeCookies } = require('./helpers/http-client');

const SECRET = 'e'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder en de webshop aan.
 * @returns {Promise<object>} base (adres), db, store, main (tenant-id) en admin (ingelogd).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  assert.strictEqual((await admin.put('/api/admin/settings', { storefront: true })).status, 200);
  return { base, db, store, main, admin };
}

/**
 * Verstuurt een formulier zoals een browser (urlencoded) met de cookies van een client.
 * @param {string} base Adres van de testserver.
 * @param {object} client De client (cookiepot).
 * @param {string} urlPath Pad van het formulier.
 * @param {object} fields De velden.
 * @param {object} [headers] Extra koppen.
 * @returns {Promise<{ status: number, location: string, text: string }>} Het antwoord.
 */
async function postForm(base, client, urlPath, fields, headers = {}) {
  const cookie = [...client.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const response = await fetch(base + urlPath, { method: 'POST', redirect: 'manual', body: new URLSearchParams(fields),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...headers } });
  storeCookies(client.jar, response.headers.getSetCookie());
  return { status: response.status, location: response.headers.get('location') || '', text: await response.text() };
}

test('registreren in de shop maakt een klantaccount en logt in', async () => {
  const { base, store, main, admin } = await setup();
  const visitor = createClient(base);
  const page = await visitor.get('/winkel/registreren/');
  assert.strictEqual(page.status, 200);
  assert.ok(!/<script/i.test(page.text));
  const done = await postForm(base, visitor, '/winkel/registreren/', { displayName: 'Piet Tuin', email: 'Piet@Voorbeeld.nl', password: PW, password2: PW, website: '' });
  assert.strictEqual(done.status, 303);
  const me = await visitor.get('/api/me');
  assert.strictEqual(me.body.user.role, 'klant');
  assert.strictEqual(me.body.user.tenantId, main);
  assert.strictEqual(store.accountIdsByEmail(main, 'piet@voorbeeld.nl').length, 1);
  const account = await visitor.get('/winkel/account/');
  assert.match(account.text, /Piet Tuin/);
  assert.match(account.text, /href="\.\.\/\.\.\/beregening\/"/, 'knop naar de planner');
  assert.match(account.text, /href="\.\.\/\.\.\/portaal\/"/);
  const users = (await admin.get('/api/admin/users')).body;
  assert.ok(JSON.stringify(users).includes('piet'));
});

test('registreren: dubbel e-mailadres, zwak of ongelijk wachtwoord, valstrik en andere site', async () => {
  const { base, store, main } = await setup();
  const fields = { displayName: 'Anna', email: 'anna@voorbeeld.nl', password: PW, password2: PW, website: '' };
  assert.strictEqual((await postForm(base, createClient(base), '/winkel/registreren/', fields)).status, 303);
  const twice = await postForm(base, createClient(base), '/winkel/registreren/', fields);
  assert.strictEqual(twice.status, 400);
  assert.match(twice.text, /al een account met dit e-mailadres/);
  assert.strictEqual((await postForm(base, createClient(base), '/winkel/registreren/', { ...fields, email: 'b@voorbeeld.nl', password: 'kort', password2: 'kort' })).status, 400);
  const different = await postForm(base, createClient(base), '/winkel/registreren/', { ...fields, email: 'c@voorbeeld.nl', password2: 'anders' });
  assert.match(different.text, /niet gelijk/);
  const trap = await postForm(base, createClient(base), '/winkel/registreren/', { ...fields, email: 'bot@voorbeeld.nl', website: 'http://spam' });
  assert.strictEqual(trap.status, 303);
  assert.strictEqual(store.accountIdsByEmail(main, 'bot@voorbeeld.nl').length, 0);
  const foreign = await postForm(base, createClient(base), '/winkel/registreren/', { ...fields, email: 'd@voorbeeld.nl' }, { 'sec-fetch-site': 'cross-site' });
  assert.strictEqual(foreign.status, 403);
  assert.strictEqual(store.accountIdsByEmail(main, 'd@voorbeeld.nl').length, 0);
});

test('inloggen in de shop: e-mailadres of gebruikersnaam, bestaand planneraccount, uitloggen', async () => {
  const { base, store, main } = await setup();
  await store.createAccount(main, { username: 'jan.klant', displayName: 'Jan', role: 'klant', password: PW });
  const viaName = createClient(base);
  assert.strictEqual((await postForm(base, viaName, '/winkel/inloggen/', { login: 'jan.klant', password: PW })).location, '../account/');
  assert.strictEqual((await viaName.get('/api/me')).body.user.username, 'jan.klant');
  assert.match((await viaName.get('/winkel/inloggen/')).location || '', /|/);
  await postForm(base, viaName, '/winkel/uitloggen/', {});
  assert.strictEqual((await viaName.get('/winkel/account/')).status, 200, 'redirect gevolgd naar inlogpagina');
  assert.strictEqual((await viaName.get('/api/me')).body.user, null);

  const registered = createClient(base);
  await postForm(base, registered, '/winkel/registreren/', { displayName: 'Els', email: 'els@voorbeeld.nl', password: PW, password2: PW, website: '' });
  const viaEmail = createClient(base);
  assert.strictEqual((await postForm(base, viaEmail, '/winkel/inloggen/', { login: 'ELS@voorbeeld.nl', password: PW })).status, 303);
  assert.strictEqual((await viaEmail.get('/api/me')).body.user.role, 'klant');
});

test('inloggen in de shop: fout wachtwoord en blokkering', async () => {
  const { base, store, main } = await setup();
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'klant', password: PW });
  const visitor = createClient(base);
  const wrong = await postForm(base, visitor, '/winkel/inloggen/', { login: 'kees', password: 'fout-wachtwoord-123' });
  assert.strictEqual(wrong.status, 401);
  assert.match(wrong.text, /Onjuist/);
  assert.strictEqual((await visitor.get('/api/me')).body.user, null);
  for (let attempt = 0; attempt < 10; attempt += 1) await postForm(base, createClient(base), '/winkel/inloggen/', { login: 'kees', password: 'fout-wachtwoord-123' });
  assert.strictEqual((await postForm(base, createClient(base), '/winkel/inloggen/', { login: 'kees', password: PW })).status, 429);
});

test('shop-accounts: uit als de webshop uit staat en alleen GET op de overige paden', async () => {
  const { base, admin } = await setup();
  await admin.put('/api/admin/settings', { storefront: false });
  assert.strictEqual((await postForm(base, createClient(base), '/winkel/registreren/', { displayName: 'X', email: 'x@y.nl', password: PW, password2: PW })).status, 404);
  await admin.put('/api/admin/settings', { storefront: true });
  assert.strictEqual((await postForm(base, createClient(base), '/winkel/zoeken/', {})).status, 405);
});

test('kopje Planner: aanmelden met drie velden, doorsturen naar de planner, uit te zetten in Beheer', async () => {
  const { base, store, main, admin } = await setup();
  const visitor = createClient(base);
  const home = await visitor.get('/winkel/');
  assert.match(home.text, /href="planner\/">Planner</, 'kopje in de navigatie');
  const page = await visitor.get('/winkel/planner/');
  assert.strictEqual(page.status, 200);
  assert.ok(!/password2/.test(page.text), 'geen herhaalveld');
  const done = await postForm(base, visitor, '/winkel/planner/', { displayName: 'Lotte', email: 'lotte@voorbeeld.nl', password: PW, website: '' });
  assert.strictEqual(done.location, '../../beregening/');
  assert.strictEqual((await visitor.get('/api/me')).body.user.role, 'klant');
  assert.strictEqual(store.accountIdsByEmail(main, 'lotte@voorbeeld.nl').length, 1);
  assert.strictEqual((await visitor.request('GET', '/winkel/planner/')).status, 200, 'ingelogd: doorverwezen naar de planner');
  const login = createClient(base);
  assert.strictEqual((await postForm(base, login, '/winkel/inloggen/', { login: 'lotte@voorbeeld.nl', password: PW, volgende: 'planner' })).location, '../../beregening/');

  assert.strictEqual((await admin.put('/api/admin/settings', { shopPlanner: false })).status, 200);
  assert.ok(!/planner\/"/.test((await createClient(base).get('/winkel/')).text), 'kopje verborgen');
  assert.strictEqual((await createClient(base).get('/winkel/planner/')).status, 404);
  assert.strictEqual((await postForm(base, createClient(base), '/winkel/planner/', { displayName: 'Z', email: 'z@voorbeeld.nl', password: PW })).status, 404);
  assert.strictEqual(store.accountIdsByEmail(main, 'z@voorbeeld.nl').length, 0);
});
