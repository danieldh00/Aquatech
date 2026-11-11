// Deel 3 van de facturen: koppeling met Visma eAccounting. Verbinden via
// OAuth2 (nagebootst), debiteur → klant, factuur → verkoopfactuur, artikel
// per omzetcategorie, vernieuwen van het access token, en rechten/scheiding.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { splitAddress, invoiceBody, sanitizeVismaApp, sanitizeVisma, describeConnection, SCOPES } = require('../src/verkoop/visma');
const { createVismaLog } = require('../src/verkoop/visma-log');
const { listen, createLogin } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const ART = { producten: '11111111-1111-1111-1111-111111111111', arbeid: '22222222-2222-2222-2222-222222222222' };
const TERMS = '33333333-3333-3333-3333-333333333333';

/**
 * Nagebootste Visma: identity (token) en de API.
 * @returns {object} Opgeslagen aanroepen, klanten, facturen en tokenverzoeken, plus fetchImpl.
 */
function fakeVisma() {
  const visma = { calls: [], customers: [], invoices: [], tokenCalls: [], revocations: [], failRevocation: false, expireNext: false, access: 'acc-1' };
  let refreshCount = 0;
  /**
   * Een fetch-antwoord met JSON.
   * @param {number} status HTTP-status.
   * @param {*} body De inhoud.
   * @returns {object} Antwoord zoals fetch het geeft.
   */
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  /**
   * Beantwoordt één verzoek: token, bedrijfsgegevens, artikelen, betaaltermijnen, klanten of facturen.
   * @param {string} url Adres van het verzoek.
   * @param {object} [init] Fetch-opties (method, headers, body).
   * @returns {Promise<object>} Antwoord zoals fetch het geeft.
   */
  visma.fetchImpl = async (url, init = {}) => {
    const requestUrl = new URL(url);
    const method = init.method || 'GET';
    if (requestUrl.pathname === '/connect/revocation') {
      if (visma.onRevocationStart) visma.onRevocationStart();
      if (visma.holdRevocation) await visma.holdRevocation;
      if (visma.failRevocation) return reply(500, { error: 'server_error' });
      visma.revocations.push({ form: Object.fromEntries(new URLSearchParams(init.body)), auth: init.headers.Authorization });
      return reply(200, {});
    }
    if (requestUrl.pathname === '/connect/token') {
      const form = new URLSearchParams(init.body);
      visma.tokenCalls.push({ form: Object.fromEntries(form), auth: init.headers.Authorization });
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'goede-code') return reply(400, { error: 'invalid_grant' });
        return reply(200, { access_token: visma.access, refresh_token: 'refresh-geheim-1', expires_in: 3600, scope: 'ea:api ea:sales offline_access' });
      }
      if (form.get('refresh_token') !== 'refresh-geheim-1' && form.get('refresh_token') !== 'refresh-geheim-2') return reply(400, { error: 'invalid_grant' });
      visma.access = `acc-${++refreshCount + 1}`;
      return reply(200, { access_token: visma.access, refresh_token: 'refresh-geheim-2', expires_in: 3600 });
    }
    const apiPath = requestUrl.pathname.replace(/^\/v2/, '');
    visma.calls.push({ method, path: apiPath, query: Object.fromEntries(requestUrl.searchParams), body: init.body ? JSON.parse(init.body) : null });
    if (init.headers.Authorization !== `Bearer ${visma.access}` || visma.expireNext) {
      visma.expireNext = false;
      return reply(401, { Message: 'Unauthorized' });
    }
    if (apiPath === '/companysettings') return reply(200, { Name: 'AquaTech Service' });
    if (apiPath === '/articles') {
      return reply(200, { Meta: { TotalNumberOfPages: 1 }, Data: [
        { Id: ART.producten, Number: '1', Name: 'Verkoop producten hoog', IsActive: true },
        { Id: ART.arbeid, Number: '2', Name: 'Arbeid hoog', IsActive: true },
        { Id: '44444444-4444-4444-4444-444444444444', Number: '3', Name: 'Oud', IsActive: false },
      ] });
    }
    if (apiPath === '/termsofpayments') return reply(200, { Meta: { TotalNumberOfPages: 1 }, Data: [{ Id: TERMS, Name: '14 dagen', NumberOfDays: 14 }] });
    if (apiPath === '/customers' && method === 'GET') {
      const match = /CustomerNumber eq '(\d+)'/.exec(requestUrl.searchParams.get('$filter') || '');
      return reply(200, { Meta: { TotalNumberOfPages: 1 }, Data: visma.customers.filter((customer) => match && customer.CustomerNumber === match[1]) });
    }
    if (apiPath === '/customers' && method === 'POST') {
      if (visma.onCustomerPost) await visma.onCustomerPost();
      const customer = { ...JSON.parse(init.body), Id: `cust-${visma.customers.length + 1}` };
      visma.customers.push(customer);
      return reply(201, customer);
    }
    if (apiPath === '/customerinvoices' && method === 'POST') {
      const inv = { ...JSON.parse(init.body), Id: `inv-${visma.invoices.length + 1}`, InvoiceNumber: String(500 + visma.invoices.length) };
      visma.invoices.push(inv);
      return reply(201, inv);
    }
    return reply(404, { Message: 'Niet gevonden' });
  };
  return visma;
}

/**
 * Hoofdtenant met beheerders, plus een testserver met de nagebootste Visma.
 * @returns {Promise<object>} db, app, server, as (inloggen), visma en main.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'anna', displayName: 'Anna', role: 'beheerder', password: PW });
  const visma = fakeVisma();
  const app = createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db, vismaFetch: visma.fetchImpl });
  const { server, base } = await listen(app);
  const as = createLogin(base, { password: PW, clientOptions: { followRedirects: false } });
  return { db, app, server, as, visma, main };
}

/**
 * Verbindt de omgeving van deze gebruiker met de nagebootste Visma.
 * @param {object} client Ingelogde client (recht facturen).
 * @returns {Promise<string>} Doorverwijzing na de callback.
 */
async function connect(client) {
  const response = await client.post('/app/api/visma/connect', {});
  assert.strictEqual(response.status, 200, JSON.stringify(response.body));
  const state = new URL(response.body.url).searchParams.get('state');
  const cb = await client.get(`/app/api/visma/callback?code=goede-code&state=${encodeURIComponent(state)}`);
  assert.strictEqual(cb.status, 303);
  return cb.location;
}

/**
 * Maakt een factuur en maakt hem definitief.
 * @param {object} client Ingelogde client (recht facturen).
 * @param {object} customer Klantgegevens.
 * @param {object[]} lines Factuurregels.
 * @returns {Promise<object>} De definitieve factuur.
 */
async function finalInvoice(client, customer, lines) {
  const inv = (await client.post('/app/api/invoices', { data: { customer, lines } })).body;
  const fin = await client.post(`/app/api/invoices/${inv.id}/finalize`, {});
  assert.strictEqual(fin.status, 200, JSON.stringify(fin.body));
  return fin.body;
}

test('visma: adres splitsen, instellingen saneren, factuur opbouwen', () => {
  assert.deepStrictEqual(splitAddress('Kerkstraat 12\n8071cd Nunspeet'), { address1: 'Kerkstraat 12', address2: '', postal: '8071 CD', city: 'Nunspeet', country: 'NL' });
  assert.deepStrictEqual(splitAddress('Postbus 1\nAfdeling X\n1000 Brussel\nBE'), { address1: 'Postbus 1', address2: 'Afdeling X', postal: '1000', city: 'Brussel', country: 'BE' });
  assert.strictEqual(sanitizeVismaApp({ redirectUri: 'http://evil.test/api/visma/callback' }).redirectUri, 'https://aquatech.den-hollander.com/api/visma/callback');
  assert.strictEqual(sanitizeVismaApp({ redirectUri: 'https://x.test/pre/api/visma/callback?a=1' }).redirectUri, 'https://x.test/pre/api/visma/callback');
  assert.strictEqual(sanitizeVismaApp({ environment: 'iets' }).environment, 'sandbox');
  const conf = sanitizeVisma({ articles: { 'producten:21': ART.producten, 'onzin:21': ART.arbeid, 'arbeid:21': 'geen-guid' }, autoSync: 'ja' });
  assert.deepStrictEqual(conf.articles, { 'producten:21': ART.producten });
  assert.strictEqual(conf.autoSync, false);

  const inv = { number: 'F2026-0001', kind: 'factuur', data: { date: '2026-10-21', dueDate: '2026-11-04', discountPct: 10, reference: 'Tuin',
    customer: { name: 'Jan', address: 'Tuinstraat 1\n8071 AB Nunspeet' }, lines: [{ description: 'Sproeier', code: 'SPR', qty: 2, price: 10, vat: 21, group: 'producten' }] } };
  const out = invoiceBody(inv, 'c1', conf, null);
  assert.strictEqual(out.body.Rows[0].IsTextRow, true);
  assert.match(out.body.Rows[0].Text, /Factuur F2026-0001 – Tuin/);
  assert.deepStrictEqual({ ...out.body.Rows[1] }, { LineNumber: 1, ArticleId: ART.producten, IsTextRow: false, Text: 'Sproeier (SPR)', UnitPrice: 10, Quantity: 2, DiscountPercentage: 0.1 });
  assert.strictEqual(out.body.InvoicePostalCode, '8071 AB');
  assert.strictEqual(out.body.IncludesVat, false);
  inv.data.lines.push({ description: 'Arbeid', qty: 1, price: 50, vat: 21, group: 'arbeid' });
  assert.match(invoiceBody(inv, 'c1', conf, null).error, /Omzet diensten hoog tarief/);
});

test('visma: app instellen (hoofdbeheerder), verbinden, doorsturen, token vernieuwen', async () => {
  const { db, server, as, visma, main } = await setup();
  try {
    const baas = await as('baas');
    // Zonder app-registratie kan verbinden niet.
    assert.strictEqual((await baas.post('/app/api/visma/connect', {})).status, 409);
    // Elke organisatie stelt haar eigen app in (recht facturen); het secret komt nooit terug.
    const anna = await as('anna');
    const installer = await as('kees');
    assert.strictEqual((await installer.get('/app/api/visma/app')).status, 403, 'zonder recht facturen');
    assert.strictEqual((await installer.put('/app/api/visma/app', { clientId: 'x' })).status, 403);
    assert.strictEqual((await baas.get('/app/api/platform/visma')).status, 404, 'niet meer platformbreed');
    const put = await baas.put('/app/api/visma/app', { clientId: 'aquatech-test', environment: 'sandbox', clientSecret: 'heel-geheim-secret' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.secretSet, true);
    assert.ok(!put.text.includes('heel-geheim'));
    // Via Beheer > Instellingen kunnen de Visma-velden niet.
    for (const field of ['visma', 'vismaRefreshToken', 'vismaApp', 'vismaClientSecret']) {
      assert.strictEqual((await baas.put('/app/api/admin/settings', { [field]: field === 'visma' || field === 'vismaApp' ? {} : 'abcdefghij' })).status, 400, field);
    }

    // Verbinden: verkeerde state wordt geweigerd, de juiste levert tokens op.
    const start = await baas.post('/app/api/visma/connect', {});
    const url = new URL(start.body.url);
    assert.strictEqual(url.origin, 'https://identity-sandbox.test.vismaonline.com');
    assert.strictEqual(url.searchParams.get('client_id'), 'aquatech-test');
    assert.match(url.searchParams.get('scope'), /offline_access/);
    const wrong = await baas.get('/app/api/visma/callback?code=goede-code&state=verkeerd');
    assert.match(wrong.location, /visma=fout&reden=invalid_state/);
    // Een andere gebruiker kan de state van een ander niet gebruiken.
    const stolen = await anna.get(`/app/api/visma/callback?code=goede-code&state=${url.searchParams.get('state')}`);
    assert.match(stolen.location, /visma=fout/);
    assert.match(await connect(baas), /^\.\.\/\.\.\/facturen\/\?visma=verbonden#visma$/);
    assert.strictEqual(visma.tokenCalls[0].auth, `Basic ${Buffer.from('aquatech-test:heel-geheim-secret').toString('base64')}`);
    const st = (await baas.get('/app/api/visma')).body;
    assert.strictEqual(st.connected, true);
    assert.strictEqual(st.settings.companyName, 'AquaTech Service');
    // Het refresh token staat versleuteld in de database.
    const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'vismaRefreshToken'").get(main);
    assert.ok(row && !row.value.includes('refresh-geheim'));
    assert.strictEqual((await baas.get('/app/api/admin/settings')).body.settings.vismaRefreshToken.set, true);

    // Keuzes uit Visma: alleen actieve artikelen.
    const opts = (await baas.get('/app/api/visma/options')).body;
    assert.deepStrictEqual(opts.articles.map((article) => article.name), ['Verkoop producten hoog', 'Arbeid hoog']);
    assert.strictEqual(opts.terms[0].days, 14);
    await baas.put('/app/api/visma/settings', { articles: { 'producten:21': ART.producten }, termsOfPaymentId: TERMS });

    // Factuur met arbeid zonder gekozen artikel: fout bij de factuur, niets naar Visma.
    const one = await finalInvoice(baas, { name: 'Jan de Vries', address: 'Tuinstraat 1\n8071 AB Nunspeet', email: 'jan@voorbeeld.test' },
      [{ description: 'Sproeier', qty: 2, price: 10 }, { description: 'Aanleg', qty: 1, price: 50, group: 'arbeid' }]);
    const miss = await baas.post(`/app/api/visma/invoices/${one.id}`, {});
    assert.strictEqual(miss.status, 409);
    assert.strictEqual(miss.body.error, 'no_article');
    assert.match((await baas.get(`/app/api/invoices/${one.id}`)).body.vismaError, /Omzet diensten hoog tarief/);
    assert.strictEqual(visma.invoices.length, 0);

    // Artikel gekozen: klant aangemaakt met het debiteurnummer, factuur doorgestuurd.
    await baas.put('/app/api/visma/settings', { articles: { 'producten:21': ART.producten, 'arbeid:21': ART.arbeid }, termsOfPaymentId: TERMS });
    const ok = await baas.post(`/app/api/visma/invoices/${one.id}`, {});
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.vismaNumber, '500');
    assert.strictEqual(ok.body.vismaError, '');
    assert.strictEqual(visma.customers.length, 1);
    assert.strictEqual(visma.customers[0].CustomerNumber, '1000');
    assert.strictEqual(visma.customers[0].InvoicePostalCode, '8071 AB');
    assert.strictEqual(visma.customers[0].TermsOfPaymentId, TERMS);
    const sentInv = visma.invoices[0];
    assert.strictEqual(sentInv.CustomerId, 'cust-1');
    assert.strictEqual(sentInv.OurReference, one.number);
    assert.deepStrictEqual(sentInv.Rows.slice(1).map((row) => [row.ArticleId, row.Quantity, row.UnitPrice]), [[ART.producten, 2, 10], [ART.arbeid, 1, 50]]);
    // Nogmaals doorsturen doet niets.
    await baas.post(`/app/api/visma/invoices/${one.id}`, {});
    assert.strictEqual(visma.invoices.length, 1);

    // Tweede factuur voor dezelfde klant: geen nieuwe klant. Access token verlopen: vernieuwd.
    const two = await finalInvoice(baas, { name: 'Jan de Vries', email: 'jan@voorbeeld.test' }, [{ description: 'Sproeier', qty: 1, price: 10 }]);
    visma.expireNext = true;
    const tokensBefore = visma.tokenCalls.length;
    const sync = await baas.post('/app/api/visma/sync', {});
    assert.strictEqual(sync.status, 200, JSON.stringify(sync.body));
    assert.strictEqual(sync.body.sent, 1);
    assert.strictEqual(visma.tokenCalls.length, tokensBefore + 1);
    assert.strictEqual(visma.tokenCalls.at(-1).form.grant_type, 'refresh_token');
    assert.strictEqual(visma.customers.length, 1);
    assert.strictEqual((await baas.get(`/app/api/invoices/${two.id}`)).body.vismaNumber, '501');
    assert.strictEqual(sync.body.status.pending, 0);

    // Klantnummer bestaat in Visma al voor een ander: niet koppelen.
    visma.customers.push({ Id: 'vreemd', CustomerNumber: '1001', Name: 'Iemand anders' });
    const three = await finalInvoice(baas, { name: 'Petra', email: 'petra@voorbeeld.test' }, [{ description: 'Sproeier', qty: 1, price: 10 }]);
    const taken = await baas.post(`/app/api/visma/invoices/${three.id}`, {});
    assert.strictEqual(taken.status, 409);
    assert.strictEqual(taken.body.error, 'number_taken');

    // Creditfactuur verwijst naar de doorgestuurde factuur.
    const cr = (await baas.post(`/app/api/invoices/${one.id}/credit`, {})).body;
    await baas.post(`/app/api/invoices/${cr.id}/finalize`, {});
    assert.strictEqual((await baas.post(`/app/api/visma/invoices/${cr.id}`, {})).status, 200);
    assert.strictEqual(visma.invoices.at(-1).IsCreditInvoice, true);
    assert.strictEqual(visma.invoices.at(-1).CreditedInvoiceId, 'inv-1');

    // Concept kan niet; verbreken wist het token.
    const concept = (await baas.post('/app/api/invoices', { data: { customer: { name: 'X' }, lines: [{ description: 'X', qty: 1, price: 1 }] } })).body;
    assert.strictEqual((await baas.post(`/app/api/visma/invoices/${concept.id}`, {})).status, 409);
    const off = await baas.post('/app/api/visma/disconnect', {});
    assert.strictEqual(off.body.connected, false);
    assert.strictEqual((await baas.post('/app/api/visma/sync', {})).status, 409);
  } finally {
    server.close();
  }
});

test('visma: automatisch doorsturen alleen als het aan staat, vanaf de gekozen datum', async () => {
  const { app, server, as, visma } = await setup();
  try {
    const baas = await as('baas');
    await baas.put('/app/api/visma/app', { clientId: 'aquatech-test', clientSecret: 'heel-geheim-secret' });
    await connect(baas);
    await baas.put('/app/api/visma/settings', { articles: { 'producten:21': ART.producten }, termsOfPaymentId: TERMS });
    const old = (await baas.post('/app/api/invoices', { data: { date: '2026-01-05', customer: { name: 'Oud' }, lines: [{ description: 'X', qty: 1, price: 1 }] } })).body;
    await baas.post(`/app/api/invoices/${old.id}/finalize`, {});
    // Automatisch uit: het vangnet doet niets.
    await app.locals.vismaAll();
    assert.strictEqual(visma.invoices.length, 0);
    // Aan zonder datum: vanaf vandaag, dus de oude factuur blijft staan.
    const st = (await baas.put('/app/api/visma/settings', { articles: { 'producten:21': ART.producten }, termsOfPaymentId: TERMS, autoSync: true })).body;
    assert.strictEqual(st.settings.since.length, 10);
    await finalInvoice(baas, { name: 'Nieuw' }, [{ description: 'X', qty: 1, price: 1 }]);
    await app.locals.vismaAll();
    assert.strictEqual(visma.invoices.length, 1);
    assert.strictEqual(visma.invoices[0].InvoiceCustomerName, 'Nieuw');
  } finally {
    server.close();
  }
});

test('visma: rechten en scheiding tussen organisaties', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    await baas.put('/app/api/visma/app', { clientId: 'aquatech-test', clientSecret: 'heel-geheim-secret' });
    await connect(baas);
    const inv = await finalInvoice(baas, { name: 'Jan' }, [{ description: 'X', qty: 1, price: 1 }]);
    const kees = await as('kees');
    for (const [method, urlPath] of [['get', '/app/api/visma'], ['get', '/app/api/visma/app'], ['put', '/app/api/visma/app'], ['get', '/app/api/visma/options'], ['put', '/app/api/visma/settings'], ['post', '/app/api/visma/connect'],
      ['get', '/app/api/visma/callback?code=a&state=b'], ['post', '/app/api/visma/disconnect'], ['post', '/app/api/visma/sync'], ['post', `/app/api/visma/invoices/${inv.id}`]]) {
      assert.strictEqual((await kees[method](urlPath, method === 'get' ? undefined : {})).status, 403, urlPath);
    }
    await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    const piet = await as('piet', 'groen');
    // Eigen verbinding per organisatie: Groen BV is niet verbonden.
    const st = (await piet.get('/app/api/visma')).body;
    assert.strictEqual(st.connected, false);
    assert.strictEqual(st.configured, false, 'de app van Aquatech geldt niet voor Groen BV');
    assert.strictEqual((await piet.post('/app/api/visma/connect', {})).status, 409);
    assert.strictEqual((await piet.get('/app/api/visma/app')).body.secretSet, false);
    assert.strictEqual((await piet.post(`/app/api/visma/invoices/${inv.id}`, {})).status, 404);
    // Groen BV heeft een eigen app: een eigen client ID, dat de app van Aquatech niet raakt.
    const own = await piet.put('/app/api/visma/app', { clientId: 'groen-app', environment: 'production', clientSecret: 'ander-geheim-secret' });
    assert.strictEqual(own.status, 200, JSON.stringify(own.body));
    assert.strictEqual(own.body.app.clientId, 'groen-app');
    assert.ok(!own.text.includes('ander-geheim'));
    const connectUrl = new URL((await piet.post('/app/api/visma/connect', {})).body.url);
    assert.strictEqual(connectUrl.searchParams.get('client_id'), 'groen-app');
    assert.strictEqual((await baas.get('/app/api/visma/app')).body.app.clientId, 'aquatech-test', 'Aquatech ongewijzigd');
    // Bij een bestaande verbinding kan de app pas na verbreken worden gewijzigd (de tokens horen bij de oude app).
    await connect(baas);
    const blocked = await baas.put('/app/api/visma/app', { clientId: 'andere-app', clientSecret: 'nieuw-geheim-secret' });
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.body.error, 'disconnect_first');
    assert.strictEqual((await baas.get('/app/api/visma/app')).body.app.clientId, 'aquatech-test');
    assert.strictEqual((await baas.put('/app/api/visma/app', { clientId: 'aquatech-test', environment: 'sandbox' })).status, 200, 'zelfde app opslaan mag');
    assert.strictEqual((await baas.post('/app/api/visma/disconnect', {})).status, 200);
    assert.strictEqual((await baas.put('/app/api/visma/app', { clientId: 'andere-app', clientSecret: 'nieuw-geheim-secret' })).status, 200);
    assert.strictEqual((await piet.get('/app/api/visma')).body.environment, 'production');
  } finally {
    server.close();
  }
});

test('visma-logboek: opslaan, herhaalde fouten samenvoegen, pagineren, bewaartermijn en scheiding', () => {
  const db = openDb();
  const store = createStore(db);
  const first = store.ensureTenant().id;
  const second = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant.id;
  const vismaLog = createVismaLog(db);
  /** Wacht tot de klok een milliseconde verder is, zodat regels een vaste volgorde hebben. */
  const tick = () => { const start = Date.now(); while (Date.now() === start) { /* wachten */ } };
  // Een herhaalde fout (zelfde onderdeel, verwijzing en melding) wordt één regel met een teller.
  vismaLog.record(first, { kind: 'factuur', direction: 'naar', ok: false, source: 'handmatig', actor: 'Baas', reference: 'F2026-0001', message: 'Visma: foutje' });
  tick();
  vismaLog.record(first, { kind: 'factuur', direction: 'naar', ok: false, reference: 'F2026-0001', message: 'Visma: foutje' });
  tick();
  vismaLog.record(first, { kind: 'factuur', direction: 'naar', ok: false, reference: 'F2026-0001', message: 'Visma: andere fout' });
  tick();
  assert.strictEqual(vismaLog.list(first).items.length, 2);
  assert.strictEqual(vismaLog.list(first).items.find((entry) => entry.message === 'Visma: foutje').count, 2);
  assert.strictEqual(vismaLog.list(first).items.find((entry) => entry.message === 'Visma: foutje').source, 'handmatig', 'een automatische herhaling overschrijft de bron niet');
  assert.strictEqual(vismaLog.list(first).items.find((entry) => entry.message === 'Visma: foutje').actor, 'Baas', 'en ook de naam niet');
  // Na een succes begint een nieuwe fout weer een eigen regel.
  vismaLog.record(first, { kind: 'factuur', direction: 'naar', ok: true, reference: 'F2026-0001', message: 'Verkoopfactuur aangemaakt in Visma' });
  tick();
  vismaLog.record(first, { kind: 'factuur', direction: 'naar', ok: false, reference: 'F2026-0001', message: 'Visma: andere fout' });
  assert.strictEqual(vismaLog.list(first).items.length, 4);
  // Een geslaagde leesactie kort na een vorige wordt niet nog eens gelogd.
  assert.ok(vismaLog.record(first, { kind: 'opties', direction: 'van', ok: true, message: '2 artikelen' }));
  assert.strictEqual(vismaLog.record(first, { kind: 'opties', direction: 'van', ok: true, message: '2 artikelen' }), null);
  // Onbekend soort, rare invoer en lange teksten: afgekapt of geweigerd.
  assert.throws(() => vismaLog.record(first, { kind: 'onzin', ok: true }));
  tick();
  vismaLog.record(first, { kind: 'verbonden', direction: 'zijwaarts', ok: true, source: 'iets', actor: 'x'.repeat(500), message: `regel\neinde ${'y'.repeat(900)}` });
  const odd = vismaLog.list(first).items[0];
  assert.strictEqual(odd.direction, '');
  assert.strictEqual(odd.source, 'automatisch');
  assert.strictEqual(odd.actor.length, 120);
  assert.ok(odd.message.length <= 300 && !odd.message.includes('\n'));
  // Alleen fouten.
  assert.ok(vismaLog.list(first, { onlyErrors: true }).items.every((entry) => !entry.ok));
  // Paginering met een cursor: alles precies één keer, nieuwste eerst.
  for (let index = 0; index < 120; index++) vismaLog.record(first, { kind: 'klant', direction: 'naar', ok: true, reference: `Debiteur ${index}`, message: 'Klant aangemaakt in Visma' });
  const seen = [];
  let cursor = '';
  let pages = 0;
  do {
    const page = vismaLog.list(first, { limit: 50, before: cursor });
    seen.push(...page.items.map((entry) => entry.id));
    cursor = page.next || '';
    pages++;
  } while (cursor && pages < 10);
  assert.strictEqual(seen.length, 126);
  assert.strictEqual(new Set(seen).size, seen.length);
  assert.strictEqual(vismaLog.list(first, { limit: 5000 }).items.length, 100, 'hooguit 100 per pagina');
  assert.strictEqual(vismaLog.list(first, { limit: 'x' }).items.length, 50);
  assert.strictEqual(vismaLog.list(first, { before: 'rommel' }).items.length, 50, 'een ongeldige cursor wordt genegeerd');
  // Een andere organisatie ziet niets en kan niets weggooien.
  assert.strictEqual(vismaLog.list(second).items.length, 0);
  assert.strictEqual(vismaLog.prune(second, 0), 0);
  // Bewaartermijn.
  db.prepare("UPDATE visma_log SET created_at = '2020-01-01T00:00:00.000Z', last_at = '2020-01-01T00:00:00.000Z' WHERE tenant_id = ? AND kind = 'klant'").run(first);
  assert.strictEqual(vismaLog.prune(first, 90), 120);
  assert.strictEqual(vismaLog.list(first, { limit: 100 }).items.length, 6);
});

test('visma: overzicht van toestemmingen en onderdelen in gewone taal', () => {
  // Elke toestemming die de koppeling vraagt heeft een uitleg.
  const requested = describeConnection('');
  assert.deepStrictEqual(requested.scopes.map((scope) => scope.key), SCOPES.split(' '));
  assert.ok(requested.scopes.every((scope) => scope.title && scope.text && !scope.text.includes('niet kent')));
  assert.deepStrictEqual(describeConnection('ea:api bijzonder').scopes.map((scope) => scope.key), ['ea:api', 'bijzonder']);
  assert.match(describeConnection('bijzonder').scopes[0].text, /niet kent/);
  assert.deepStrictEqual(requested.parts.map((part) => part.key), ['customers', 'invoices', 'options', 'company']);
  assert.ok(requested.parts.every((part) => ['naar', 'van'].includes(part.direction)));
  assert.match(requested.notDone, /wijzigt of verwijdert niets/);
  assert.strictEqual(sanitizeVisma({ scopes: 'ea:api <script> ea:sales' }).scopes, 'ea:api ea:sales');
});

test('visma: logboek via de API – verbinden, doorsturen, fouten, verbreken, rechten en scheiding', async () => {
  const { db, server, as, visma } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    await baas.put('/app/api/visma/app', { clientId: 'aquatech-test', clientSecret: 'heel-geheim-secret' });
    // Verbinden mislukt (verkeerde state) en lukt daarna: beide staan in het logboek, de toestemmingen zijn die van Visma.
    assert.match((await baas.get('/app/api/visma/callback?code=goede-code&state=verkeerd')).location, /visma=fout/);
    await connect(baas);
    const status = (await baas.get('/app/api/visma')).body;
    assert.deepStrictEqual(status.overview.scopes.map((scope) => scope.key), ['ea:api', 'ea:sales', 'offline_access']);
    assert.strictEqual(status.settings.scopes, 'ea:api ea:sales offline_access');
    await baas.get('/app/api/visma/options');
    await baas.put('/app/api/visma/settings', { articles: { 'producten:21': ART.producten }, termsOfPaymentId: TERMS });
    const good = await finalInvoice(baas, { name: 'Jan', email: 'jan@voorbeeld.test' }, [{ description: 'Sproeier', qty: 1, price: 10 }]);
    const bad = await finalInvoice(baas, { name: 'Piet' }, [{ description: 'Aanleg', qty: 1, price: 50, group: 'arbeid' }]);
    const sync = await baas.post('/app/api/visma/sync', {});
    assert.strictEqual(sync.body.sent, 1);
    assert.strictEqual(sync.body.failed, 1);
    await baas.post('/app/api/visma/sync', {});
    await baas.post('/app/api/visma/sync', {});
    const log = (await baas.get('/app/api/visma/log')).body;
    /**
     * De logregels van één soort.
     * @param {string} kind Soort regel.
     * @returns {object[]} De regels.
     */
    const byKind = (kind) => log.items.filter((entry) => entry.kind === kind);
    assert.strictEqual(byKind('aanmelding').length, 1);
    assert.strictEqual(byKind('verbonden')[0].source, 'handmatig');
    assert.strictEqual(byKind('verbonden')[0].actor, 'Baas');
    assert.match(byKind('verbonden')[0].message, /AquaTech Service/);
    assert.strictEqual(byKind('opties').length, 1);
    assert.strictEqual(byKind('klant')[0].reference, 'Debiteur 1000');
    const okInvoice = byKind('factuur').find((entry) => entry.ok);
    assert.strictEqual(okInvoice.reference, good.number);
    assert.match(okInvoice.message, /nummer 500/);
    // De mislukte factuur staat één keer, met een teller van het aantal pogingen.
    const failed = byKind('factuur').filter((entry) => !entry.ok);
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].reference, bad.number);
    assert.strictEqual(failed[0].count, 3);
    assert.match(failed[0].message, /Kies in Facturen/);
    assert.strictEqual((await baas.get('/app/api/visma/log?errors=1')).body.items.every((entry) => !entry.ok), true);
    // Pagina's en cursor.
    const page = (await baas.get('/app/api/visma/log?limit=2')).body;
    assert.strictEqual(page.items.length, 2);
    assert.ok(page.next);
    const rest = (await baas.get(`/app/api/visma/log?limit=100&before=${encodeURIComponent(page.next)}`)).body;
    assert.strictEqual(page.items.length + rest.items.length, log.items.length);
    // Geen geheimen in het logboek.
    const raw = JSON.stringify(db.prepare('SELECT actor, reference, message FROM visma_log').all());
    for (const secret of ['heel-geheim-secret', 'refresh-geheim', 'acc-1']) assert.ok(!raw.includes(secret), secret);
    // Verbreken staat erin.
    await baas.post('/app/api/visma/disconnect', {});
    const afterOff = (await baas.get('/app/api/visma/log?limit=1')).body.items[0];
    assert.strictEqual(afterOff.kind, 'verbroken');
    assert.strictEqual((await baas.get('/app/api/visma')).body.settings.scopes, '');
    // Rechten: zonder recht facturen geen logboek; andere organisatie ziet het niet.
    assert.strictEqual((await kees.get('/app/api/visma/log')).status, 403);
    await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    const piet = await as('piet', 'groen');
    assert.deepStrictEqual((await piet.get('/app/api/visma/log')).body, { items: [], next: null });
  } finally {
    server.close();
  }
});

test('visma: bediening – pauzeren, onderdelen aan/uit, klanten niet aanmaken en intrekken bij verbreken', async () => {
  const { server, as, visma, app } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    await baas.put('/app/api/visma/app', { clientId: 'aquatech-test', clientSecret: 'heel-geheim-secret' });
    await connect(baas);
    await baas.put('/app/api/visma/settings', { articles: { 'producten:21': ART.producten }, termsOfPaymentId: TERMS, autoSync: true, since: '2020-01-01' });
    const known = await finalInvoice(baas, { name: 'Jan', email: 'jan@voorbeeld.test' }, [{ description: 'Sproeier', qty: 1, price: 10 }]);
    assert.strictEqual((await baas.post(`/app/api/visma/invoices/${known.id}`, {})).status, 200);
    const status = (await baas.get('/app/api/visma')).body;
    assert.strictEqual(status.settings.paused, false);
    assert.deepStrictEqual(status.settings.parts, { invoices: true, credits: true, customers: true });

    // Rechten en invoer.
    assert.strictEqual((await kees.put('/app/api/visma/controls', { paused: true })).status, 403);
    const ignored = await baas.put('/app/api/visma/controls', { paused: 'ja', parts: { invoices: 'nee', onzin: false } });
    assert.strictEqual(ignored.status, 200);
    assert.strictEqual(ignored.body.settings.paused, false, 'alleen een echte boolean telt');
    assert.deepStrictEqual(ignored.body.settings.parts, { invoices: true, credits: true, customers: true });

    // Pauzeren: niets gaat naar Visma, ook niet met de knop of het vangnet; hervatten herstelt dat.
    const waiting = await finalInvoice(baas, { name: 'Jan', email: 'jan@voorbeeld.test' }, [{ description: 'Sproeier', qty: 2, price: 10 }]);
    assert.strictEqual((await baas.put('/app/api/visma/controls', { paused: true })).body.settings.paused, true);
    const blocked = await baas.post('/app/api/visma/sync', {});
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.body.error, 'paused');
    assert.strictEqual((await baas.post(`/app/api/visma/invoices/${waiting.id}`, {})).body.error, 'paused');
    await app.locals.vismaAll();
    assert.strictEqual(visma.invoices.length, 1);
    assert.strictEqual((await baas.put('/app/api/visma/controls', { paused: false })).body.settings.paused, false);
    assert.strictEqual((await baas.post('/app/api/visma/sync', {})).body.sent, 1);

    // Creditfacturen uit: invoices gaan, credits blijven wachten en tellen niet mee als wachtend.
    const credit = (await baas.post(`/app/api/invoices/${known.id}/credit`, {})).body;
    await baas.post(`/app/api/invoices/${credit.id}/finalize`, {});
    assert.strictEqual((await baas.get('/app/api/visma')).body.pending, 1);
    await baas.put('/app/api/visma/controls', { parts: { credits: false } });
    assert.strictEqual((await baas.get('/app/api/visma')).body.pending, 0);
    assert.strictEqual((await baas.post('/app/api/visma/sync', {})).body.sent, 0);
    const partOff = await baas.post(`/app/api/visma/invoices/${credit.id}`, {});
    assert.strictEqual(partOff.status, 409);
    assert.strictEqual(partOff.body.error, 'part_off');
    await baas.put('/app/api/visma/controls', { parts: { credits: true, invoices: false } });
    assert.strictEqual((await baas.post('/app/api/visma/sync', {})).body.sent, 1, 'alleen de creditfactuur gaat nu mee');
    assert.strictEqual(visma.invoices.at(-1).IsCreditInvoice, true);
    await baas.put('/app/api/visma/controls', { parts: { invoices: true } });

    // Klanten aanmaken uit: een debiteur die al in Visma staat kan nog, een nieuwe niet.
    await baas.put('/app/api/visma/controls', { parts: { customers: false } });
    const customersBefore = visma.customers.length;
    const again = await finalInvoice(baas, { name: 'Jan', email: 'jan@voorbeeld.test' }, [{ description: 'Sproeier', qty: 3, price: 10 }]);
    assert.strictEqual((await baas.post(`/app/api/visma/invoices/${again.id}`, {})).status, 200);
    const fresh = await finalInvoice(baas, { name: 'Nieuwe Klant' }, [{ description: 'Sproeier', qty: 1, price: 10 }]);
    const noCustomer = await baas.post(`/app/api/visma/invoices/${fresh.id}`, {});
    assert.strictEqual(noCustomer.status, 409);
    assert.strictEqual(noCustomer.body.error, 'customers_off');
    assert.strictEqual(visma.customers.length, customersBefore);
    // Het doorsturen in bulk slaat zo'n factuur over (geen herhaalde fouten, geen geblokkeerde batch) en telt hem niet als wachtend.
    const bulk = await baas.post('/app/api/visma/sync', {});
    assert.deepStrictEqual([bulk.body.sent, bulk.body.failed], [0, 0]);
    assert.strictEqual(bulk.body.status.pending, 0);
    assert.strictEqual(bulk.body.status.held, 1, 'de status laat zien dat er een factuur wacht omdat een onderdeel uit staat');

    // Elke wijziging staat in het logboek, met naam.
    const log = (await baas.get('/app/api/visma/log?limit=100')).body.items.filter((entry) => entry.kind === 'instelling');
    const messages = log.map((entry) => entry.message);
    assert.ok(messages.some((message) => /gepauzeerd/.test(message)) && messages.some((message) => /hervat/.test(message)));
    assert.ok(messages.includes('Klanten aanmaken in Visma: uit'));
    assert.ok(log.every((entry) => entry.actor === 'Baas' && entry.source === 'handmatig'));
    // Een ongewijzigde stand maakt geen logregel.
    const logged = log.length;
    await baas.put('/app/api/visma/controls', { parts: { customers: false } });
    assert.strictEqual((await baas.get('/app/api/visma/log?limit=100')).body.items.filter((entry) => entry.kind === 'instelling').length, logged);

    // Een andere organisatie kan de bediening van deze niet wijzigen en heeft een eigen stand.
    await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    const piet = await as('piet', 'groen');
    const before = (await baas.get('/app/api/visma')).body.settings;
    assert.strictEqual((await piet.put('/app/api/visma/controls', { paused: true, parts: { invoices: false, credits: false, customers: false } })).body.settings.paused, true);
    const after = (await baas.get('/app/api/visma')).body.settings;
    assert.deepStrictEqual([after.paused, after.parts], [before.paused, before.parts], 'de stand van de eerste organisatie is niet veranderd');
    assert.strictEqual((await piet.get('/app/api/visma/log')).body.items.filter((entry) => entry.kind === 'instelling').length, 4, 'en de wijzigingen staan in het logboek van de eigen organisatie');

    // Verbreken trekt het refresh token in bij Visma.
    const off = await baas.post('/app/api/visma/disconnect', {});
    assert.strictEqual(off.body.revoked, true);
    assert.strictEqual(off.body.connected, false);
    assert.strictEqual(visma.revocations.length, 1);
    assert.strictEqual(visma.revocations[0].form.token, 'refresh-geheim-1');
    assert.strictEqual(visma.revocations[0].form.token_type_hint, 'refresh_token');
    assert.strictEqual(visma.revocations[0].auth, `Basic ${Buffer.from('aquatech-test:heel-geheim-secret').toString('base64')}`);
    assert.strictEqual((await baas.get('/app/api/visma/log?limit=1')).body.items[0].ok, true);
    // Lukt intrekken niet, dan wordt er toch verbroken en meldt het logboek dat.
    await connect(baas);
    visma.failRevocation = true;
    const failedRevoke = await baas.post('/app/api/visma/disconnect', {});
    assert.strictEqual(failedRevoke.body.revoked, false);
    assert.strictEqual(failedRevoke.body.connected, false);
    const last = (await baas.get('/app/api/visma/log?limit=1')).body.items[0];
    assert.strictEqual(last.kind, 'verbroken');
    assert.strictEqual(last.ok, false);
    assert.match(last.message, /intrekken bij Visma lukte niet/);
  } finally {
    server.close();
  }
});

test('visma: pauze of onderdeel uit tijdens het aanmaken van de klant houdt de factuur tegen, en een niet-booleaanse pauze doet niets', async () => {
  const { server, as, visma } = await setup();
  try {
    const baas = await as('baas');
    await baas.put('/app/api/visma/app', { clientId: 'aquatech-test', clientSecret: 'heel-geheim-secret' });
    await connect(baas);
    await baas.put('/app/api/visma/settings', { articles: { 'producten:21': ART.producten }, termsOfPaymentId: TERMS });

    // Een bestaande pauze blijft staan bij een waarde die geen boolean is.
    assert.strictEqual((await baas.put('/app/api/visma/controls', { paused: true })).body.settings.paused, true);
    for (const value of ['ja', 'false', 0, null, {}]) {
      assert.strictEqual((await baas.put('/app/api/visma/controls', { paused: value })).body.settings.paused, true, `paused: ${JSON.stringify(value)}`);
    }
    assert.strictEqual((await baas.put('/app/api/visma/controls', { paused: false })).body.settings.paused, false);

    // Pauzeren terwijl de klant wordt aangemaakt: de factuur gaat niet naar Visma, en dat is geen fout van de factuur.
    const invoice = await finalInvoice(baas, { name: 'Nieuwe Klant' }, [{ description: 'Sproeier', qty: 1, price: 10 }]);
    /** Pauzeert de koppeling precies op het moment dat Visma de nieuwe klant aanmaakt. */
    visma.onCustomerPost = async () => { visma.onCustomerPost = null; await baas.put('/app/api/visma/controls', { paused: true }); };
    const blocked = await baas.post(`/app/api/visma/invoices/${invoice.id}`, {});
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.body.error, 'paused');
    assert.strictEqual(visma.invoices.length, 0, 'niets verstuurd');
    const listed = (await baas.get('/app/api/invoices')).body.items.find((item) => item.id === invoice.id);
    assert.ok(!listed.vismaError, 'pauze komt niet als fout bij de factuur');
    assert.ok(!(await baas.get('/app/api/visma/log?limit=100')).body.items.some((entry) => entry.kind === 'factuur' && entry.ok === false), 'en niet als fout in het logboek');

    // Hetzelfde voor een onderdeel dat tijdens het aanmaken van de klant uitgaat.
    await baas.put('/app/api/visma/controls', { paused: false });
    const other = await finalInvoice(baas, { name: 'Tweede Klant' }, [{ description: 'Sproeier', qty: 1, price: 10 }]);
    /** Zet verkoopfacturen uit precies op het moment dat Visma de nieuwe klant aanmaakt. */
    visma.onCustomerPost = async () => { visma.onCustomerPost = null; await baas.put('/app/api/visma/controls', { parts: { invoices: false } }); };
    const off = await baas.post(`/app/api/visma/invoices/${other.id}`, {});
    assert.strictEqual(off.body.error, 'part_off');
    assert.strictEqual(visma.invoices.length, 0);
  } finally {
    server.close();
  }
});

test('visma: tijdens het verbreken start er niets nieuws naar Visma en is het intrekken niet te omzeilen', async () => {
  const { server, as, visma } = await setup();
  try {
    const baas = await as('baas');
    await baas.put('/app/api/visma/app', { clientId: 'aquatech-test', clientSecret: 'heel-geheim-secret' });
    await connect(baas);
    await baas.put('/app/api/visma/settings', { articles: { 'producten:21': ART.producten }, termsOfPaymentId: TERMS });
    const invoice = await finalInvoice(baas, { name: 'Jan', email: 'jan@voorbeeld.test' }, [{ description: 'Sproeier', qty: 1, price: 10 }]);

    let release;
    let started;
    const hasStarted = new Promise((resolve) => { started = resolve; });
    visma.holdRevocation = new Promise((resolve) => { release = resolve; });
    visma.onRevocationStart = started;
    const disconnecting = baas.post('/app/api/visma/disconnect', {});
    await hasStarted;
    const during = await baas.post(`/app/api/visma/invoices/${invoice.id}`, {});
    assert.strictEqual(during.status, 409);
    assert.strictEqual(during.body.error, 'not_connected');
    assert.strictEqual((await baas.post('/app/api/visma/sync', {})).body.failed, 1, 'doorsturen tijdens het verbreken mislukt netjes');
    assert.strictEqual(visma.invoices.length, 0, 'niets naar Visma tijdens het verbreken');
    release();
    const off = await disconnecting;
    assert.strictEqual(off.body.revoked, true);
    assert.strictEqual(off.body.connected, false);
    assert.strictEqual(visma.invoices.length, 0);
    assert.strictEqual(visma.revocations.length, 1);

    // Na het verbreken kan opnieuw verbonden en doorgestuurd worden (de blokkade is weg).
    visma.holdRevocation = null;
    await connect(baas);
    assert.strictEqual((await baas.post(`/app/api/visma/invoices/${invoice.id}`, {})).status, 200);
  } finally {
    server.close();
  }
});

test('visma: wijzigen van de app-gegevens komt in het logboek, zonder het secret', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    assert.strictEqual((await baas.put('/app/api/visma/app', { clientId: 'aquatech-test', environment: 'sandbox', clientSecret: 'heel-geheim-secret' })).status, 200);
    const entries = (await baas.get('/app/api/visma/log?limit=100')).body.items.filter((entry) => entry.kind === 'instelling');
    assert.strictEqual(entries.length, 1);
    assert.match(entries[0].message, /clientId/);
    assert.match(entries[0].message, /clientSecret/);
    assert.ok(!entries[0].message.includes('heel-geheim-secret') && !entries[0].message.includes('aquatech-test'), 'alleen veldnamen, geen waarden');
    assert.strictEqual(entries[0].actor, 'Baas');
    assert.strictEqual(entries[0].source, 'handmatig');
    // Ongewijzigd opslaan geeft geen nieuwe regel.
    await baas.put('/app/api/visma/app', { clientId: 'aquatech-test', environment: 'sandbox' });
    assert.strictEqual((await baas.get('/app/api/visma/log?limit=100')).body.items.filter((entry) => entry.kind === 'instelling').length, 1);
  } finally {
    server.close();
  }
});
