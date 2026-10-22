// Deel 3 van de facturen: koppeling met Visma eAccounting. Verbinden via
// OAuth2 (nagebootst), debiteur → klant, factuur → verkoopfactuur, artikel
// per omzetcategorie, vernieuwen van het access token, en rechten/scheiding.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { splitAddress, invoiceBody, sanitizeVismaApp, sanitizeVisma } = require('../src/verkoop/visma');
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
  const visma = { calls: [], customers: [], invoices: [], tokenCalls: [], expireNext: false, access: 'acc-1' };
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
    if (requestUrl.pathname === '/connect/token') {
      const form = new URLSearchParams(init.body);
      visma.tokenCalls.push({ form: Object.fromEntries(form), auth: init.headers.Authorization });
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'goede-code') return reply(400, { error: 'invalid_grant' });
        return reply(200, { access_token: visma.access, refresh_token: 'refresh-geheim-1', expires_in: 3600 });
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
  const app = createApp({ secret: SECRET, db, vismaFetch: visma.fetchImpl });
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
  const response = await client.post('/api/visma/connect', {});
  assert.strictEqual(response.status, 200, JSON.stringify(response.body));
  const state = new URL(response.body.url).searchParams.get('state');
  const cb = await client.get(`/api/visma/callback?code=goede-code&state=${encodeURIComponent(state)}`);
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
  const inv = (await client.post('/api/invoices', { data: { customer, lines } })).body;
  const fin = await client.post(`/api/invoices/${inv.id}/finalize`, {});
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
    customer: { name: 'Jan', address: 'Dorpsweg 1\n8071 AB Nunspeet' }, lines: [{ description: 'Sproeier', code: 'SPR', qty: 2, price: 10, vat: 21, group: 'producten' }] } };
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
    assert.strictEqual((await baas.post('/api/visma/connect', {})).status, 409);
    // Alleen een hoofdbeheerder stelt de app in; het secret komt nooit terug.
    const anna = await as('anna');
    assert.strictEqual((await anna.get('/api/platform/visma')).status, 403);
    assert.strictEqual((await anna.put('/api/platform/visma', { clientId: 'x' })).status, 403);
    const put = await baas.put('/api/platform/visma', { clientId: 'aquatech-test', environment: 'sandbox', clientSecret: 'heel-geheim-secret' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.secretSet, true);
    assert.ok(!put.text.includes('heel-geheim'));
    // Via Beheer > Instellingen kunnen de Visma-velden niet.
    for (const field of ['visma', 'vismaRefreshToken', 'vismaApp', 'vismaClientSecret']) {
      assert.strictEqual((await baas.put('/api/admin/settings', { [field]: field === 'visma' || field === 'vismaApp' ? {} : 'abcdefghij' })).status, 400, field);
    }

    // Verbinden: verkeerde state wordt geweigerd, de juiste levert tokens op.
    const start = await baas.post('/api/visma/connect', {});
    const url = new URL(start.body.url);
    assert.strictEqual(url.origin, 'https://identity-sandbox.test.vismaonline.com');
    assert.strictEqual(url.searchParams.get('client_id'), 'aquatech-test');
    assert.match(url.searchParams.get('scope'), /offline_access/);
    const wrong = await baas.get('/api/visma/callback?code=goede-code&state=verkeerd');
    assert.match(wrong.location, /visma=fout&reden=invalid_state/);
    // Een andere gebruiker kan de state van een ander niet gebruiken.
    const stolen = await anna.get(`/api/visma/callback?code=goede-code&state=${url.searchParams.get('state')}`);
    assert.match(stolen.location, /visma=fout/);
    assert.match(await connect(baas), /^\.\.\/\.\.\/facturen\/\?visma=verbonden#visma$/);
    assert.strictEqual(visma.tokenCalls[0].auth, `Basic ${Buffer.from('aquatech-test:heel-geheim-secret').toString('base64')}`);
    const st = (await baas.get('/api/visma')).body;
    assert.strictEqual(st.connected, true);
    assert.strictEqual(st.settings.companyName, 'AquaTech Service');
    // Het refresh token staat versleuteld in de database.
    const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'vismaRefreshToken'").get(main);
    assert.ok(row && !row.value.includes('refresh-geheim'));
    assert.strictEqual((await baas.get('/api/admin/settings')).body.settings.vismaRefreshToken.set, true);

    // Keuzes uit Visma: alleen actieve artikelen.
    const opts = (await baas.get('/api/visma/options')).body;
    assert.deepStrictEqual(opts.articles.map((article) => article.name), ['Verkoop producten hoog', 'Arbeid hoog']);
    assert.strictEqual(opts.terms[0].days, 14);
    await baas.put('/api/visma/settings', { articles: { 'producten:21': ART.producten }, termsOfPaymentId: TERMS });

    // Factuur met arbeid zonder gekozen artikel: fout bij de factuur, niets naar Visma.
    const one = await finalInvoice(baas, { name: 'Jan de Vries', address: 'Dorpsweg 1\n8071 AB Nunspeet', email: 'jan@voorbeeld.test' },
      [{ description: 'Sproeier', qty: 2, price: 10 }, { description: 'Aanleg', qty: 1, price: 50, group: 'arbeid' }]);
    const miss = await baas.post(`/api/visma/invoices/${one.id}`, {});
    assert.strictEqual(miss.status, 409);
    assert.strictEqual(miss.body.error, 'no_article');
    assert.match((await baas.get(`/api/invoices/${one.id}`)).body.vismaError, /Omzet diensten hoog tarief/);
    assert.strictEqual(visma.invoices.length, 0);

    // Artikel gekozen: klant aangemaakt met het debiteurnummer, factuur doorgestuurd.
    await baas.put('/api/visma/settings', { articles: { 'producten:21': ART.producten, 'arbeid:21': ART.arbeid }, termsOfPaymentId: TERMS });
    const ok = await baas.post(`/api/visma/invoices/${one.id}`, {});
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
    await baas.post(`/api/visma/invoices/${one.id}`, {});
    assert.strictEqual(visma.invoices.length, 1);

    // Tweede factuur voor dezelfde klant: geen nieuwe klant. Access token verlopen: vernieuwd.
    const two = await finalInvoice(baas, { name: 'Jan de Vries', email: 'jan@voorbeeld.test' }, [{ description: 'Sproeier', qty: 1, price: 10 }]);
    visma.expireNext = true;
    const tokensBefore = visma.tokenCalls.length;
    const sync = await baas.post('/api/visma/sync', {});
    assert.strictEqual(sync.status, 200, JSON.stringify(sync.body));
    assert.strictEqual(sync.body.sent, 1);
    assert.strictEqual(visma.tokenCalls.length, tokensBefore + 1);
    assert.strictEqual(visma.tokenCalls.at(-1).form.grant_type, 'refresh_token');
    assert.strictEqual(visma.customers.length, 1);
    assert.strictEqual((await baas.get(`/api/invoices/${two.id}`)).body.vismaNumber, '501');
    assert.strictEqual(sync.body.status.pending, 0);

    // Klantnummer bestaat in Visma al voor een ander: niet koppelen.
    visma.customers.push({ Id: 'vreemd', CustomerNumber: '1001', Name: 'Iemand anders' });
    const three = await finalInvoice(baas, { name: 'Petra', email: 'petra@voorbeeld.test' }, [{ description: 'Sproeier', qty: 1, price: 10 }]);
    const taken = await baas.post(`/api/visma/invoices/${three.id}`, {});
    assert.strictEqual(taken.status, 409);
    assert.strictEqual(taken.body.error, 'number_taken');

    // Creditfactuur verwijst naar de doorgestuurde factuur.
    const cr = (await baas.post(`/api/invoices/${one.id}/credit`, {})).body;
    await baas.post(`/api/invoices/${cr.id}/finalize`, {});
    assert.strictEqual((await baas.post(`/api/visma/invoices/${cr.id}`, {})).status, 200);
    assert.strictEqual(visma.invoices.at(-1).IsCreditInvoice, true);
    assert.strictEqual(visma.invoices.at(-1).CreditedInvoiceId, 'inv-1');

    // Concept kan niet; verbreken wist het token.
    const concept = (await baas.post('/api/invoices', { data: { customer: { name: 'X' }, lines: [{ description: 'X', qty: 1, price: 1 }] } })).body;
    assert.strictEqual((await baas.post(`/api/visma/invoices/${concept.id}`, {})).status, 409);
    const off = await baas.post('/api/visma/disconnect', {});
    assert.strictEqual(off.body.connected, false);
    assert.strictEqual((await baas.post('/api/visma/sync', {})).status, 409);
  } finally {
    server.close();
  }
});

test('visma: automatisch doorsturen alleen als het aan staat, vanaf de gekozen datum', async () => {
  const { app, server, as, visma } = await setup();
  try {
    const baas = await as('baas');
    await baas.put('/api/platform/visma', { clientId: 'aquatech-test', clientSecret: 'heel-geheim-secret' });
    await connect(baas);
    await baas.put('/api/visma/settings', { articles: { 'producten:21': ART.producten }, termsOfPaymentId: TERMS });
    const old = (await baas.post('/api/invoices', { data: { date: '2026-01-05', customer: { name: 'Oud' }, lines: [{ description: 'X', qty: 1, price: 1 }] } })).body;
    await baas.post(`/api/invoices/${old.id}/finalize`, {});
    // Automatisch uit: het vangnet doet niets.
    await app.locals.vismaAll();
    assert.strictEqual(visma.invoices.length, 0);
    // Aan zonder datum: vanaf vandaag, dus de oude factuur blijft staan.
    const st = (await baas.put('/api/visma/settings', { articles: { 'producten:21': ART.producten }, termsOfPaymentId: TERMS, autoSync: true })).body;
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
    await baas.put('/api/platform/visma', { clientId: 'aquatech-test', clientSecret: 'heel-geheim-secret' });
    await connect(baas);
    const inv = await finalInvoice(baas, { name: 'Jan' }, [{ description: 'X', qty: 1, price: 1 }]);
    const kees = await as('kees');
    for (const [method, urlPath] of [['get', '/api/visma'], ['get', '/api/visma/options'], ['put', '/api/visma/settings'], ['post', '/api/visma/connect'],
      ['get', '/api/visma/callback?code=a&state=b'], ['post', '/api/visma/disconnect'], ['post', '/api/visma/sync'], ['post', `/api/visma/invoices/${inv.id}`]]) {
      assert.strictEqual((await kees[method](urlPath, method === 'get' ? undefined : {})).status, 403, urlPath);
    }
    await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    const piet = await as('piet', 'groen');
    // Eigen verbinding per organisatie: Groen BV is niet verbonden.
    const st = (await piet.get('/api/visma')).body;
    assert.strictEqual(st.connected, false);
    assert.strictEqual(st.configured, true);
    assert.strictEqual((await piet.post(`/api/visma/invoices/${inv.id}`, {})).status, 404);
    assert.strictEqual((await piet.get('/api/platform/visma')).status, 403);
  } finally {
    server.close();
  }
});
