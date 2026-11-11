// AI-koppeling (mcp/): OAuth 2.1 (ontdekken, registreren, toestemming met PKCE, tokens, vernieuwen, intrekken) en de
// MCP-server met de tools zoek_klant, maak_klant, zoek_artikelen en maak_concept_offerte. Ook de beveiliging: alleen
// bekende AI-apps, geen hergebruik van codes, rechten van de rol, scheiding tussen organisaties, uitzetten en intrekken.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const crypto = require('crypto');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, createClient, listen, postForm } = require('./helpers/http-client');
const { createPdokFake } = require('./helpers/pdok-fake');
const { searchArticles, findArticle } = require('../src/mcp/mcp-tools');
const { allowedRedirect, parseScope } = require('../src/mcp/oauth-server');
const { pkceMatches, parseToken } = require('../src/mcp/oauth-grants');

const SECRET = 'm'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, installateur, klant, een andere organisatie en een paar artikelen; de AI-koppeling staat aan.
 * @returns {Promise<object>} base, db, store, main, other, as (login), admin en installer.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'klant1', displayName: 'Klant Eén', role: 'klant', password: PW }, { mustChangePassword: false });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, addressFetch: createPdokFake().fetchImpl, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW, clientOptions: { followRedirects: false } });
  const admin = await as('baas');
  assert.strictEqual((await admin.put('/app/api/admin/settings', { aiConnector: true, quoteProfile: { hourlyRate: 60, vatRate: 21, numberPrefix: 'OF-', validDays: 30 } })).status, 200);
  for (const item of [
    { code: 'SPR-POP-10', name: 'Pop-up sproeier 10 cm', unit: 'st', salePrice: 12.5, vatRate: 21, onHand: 40 },
    { code: 'PE-25', name: 'PE-buis 25 mm', unit: 'm', salePrice: 1.2, vatRate: 21, onHand: 300 },
    { code: 'COMP-6', name: 'Beregeningscomputer 6 zones', unit: 'st', salePrice: 189, vatRate: 21, onHand: 2 },
  ]) assert.strictEqual((await admin.post('/app/api/stock/items', item)).status, 201);
  return { base, db, store, main, other, as, admin, installer: await as('monteur') };
}

/**
 * Een PKCE-paar (verifier en S256-challenge).
 * @returns {{ verifier: string, challenge: string }} Het paar.
 */
function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * Registreert een AI-app zoals Claude dat doet.
 * @param {string} base Adres van de testserver.
 * @param {object} [extra] Andere velden in het registratieverzoek.
 * @returns {Promise<object>} Het antwoord.
 */
const register = (base, extra = {}) => createClient(base).post('/app/oauth/register', { client_name: 'Claude', redirect_uris: [REDIRECT], ...extra });

/**
 * Het adres van het toestemmingsscherm.
 * @param {object} params De parameters (client_id, code_challenge, ...).
 * @returns {string} Het pad met de query.
 */
const authorizeUrl = (params) => `/app/oauth/authorize?${new URLSearchParams({ response_type: 'code', redirect_uri: REDIRECT, code_challenge_method: 'S256', state: 'st-1', ...params })}`;

/**
 * Leest het verzoek-id en de CSRF-code uit het toestemmingsscherm.
 * @param {string} html De pagina.
 * @returns {{ request: string, csrf: string }} De verborgen velden.
 */
function consentFields(html) {
  return { request: /name="request" value="([^"]+)"/.exec(html)[1], csrf: /name="csrf" value="([^"]+)"/.exec(html)[1] };
}

/**
 * Een token aanvragen bij het tokeneindpunt (formulier, zoals een AI-app dat doet).
 * @param {string} base Adres van de testserver.
 * @param {object} fields De velden.
 * @returns {Promise<{ status: number, body: object }>} Het antwoord.
 */
async function token(base, fields) {
  const response = await fetch(`${base}/app/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  return { status: response.status, body: await response.json() };
}

/**
 * Koppelt een AI-app aan een ingelogde gebruiker: registreren, toestaan en de code inwisselen.
 * @param {string} base Adres van de testserver.
 * @param {object} client De ingelogde client (cookies).
 * @param {{ scope?: string }} [options] Gevraagde rechten.
 * @returns {Promise<{ clientId: string, accessToken: string, refreshToken: string, code: string, verifier: string, scope: string }>} De koppeling.
 */
async function connect(base, client, { scope } = {}) {
  const clientId = (await register(base)).body.client_id;
  const { verifier, challenge } = pkcePair();
  const page = await client.get(authorizeUrl({ client_id: clientId, code_challenge: challenge, resource: `${base}/app/mcp`, ...(scope ? { scope } : {}) }));
  assert.strictEqual(page.status, 200, page.text.slice(0, 300));
  const answer = await postForm(base, client, '/app/oauth/authorize', { ...consentFields(page.text), decision: 'allow' });
  assert.strictEqual(answer.status, 302);
  const back = new URL(answer.location);
  assert.strictEqual(back.origin + back.pathname, REDIRECT);
  assert.strictEqual(back.searchParams.get('state'), 'st-1');
  const code = back.searchParams.get('code');
  const tokens = await token(base, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${base}/app/mcp` });
  assert.strictEqual(tokens.status, 200, JSON.stringify(tokens.body));
  return { clientId, accessToken: tokens.body.access_token, refreshToken: tokens.body.refresh_token, code, verifier, scope: tokens.body.scope };
}

/**
 * Stuurt een JSON-RPC-bericht naar de MCP-server.
 * @param {string} base Adres van de testserver.
 * @param {string|null} accessToken Het token (null = zonder).
 * @param {object} message Het bericht (jsonrpc en id worden aangevuld).
 * @param {object} [headers] Extra koppen.
 * @returns {Promise<{ status: number, body: object|null, headers: Headers }>} Het antwoord.
 */
async function mcp(base, accessToken, message, headers = {}) {
  const response = await fetch(`${base}/app/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

/**
 * Roept een tool aan en geeft de gestructureerde uitkomst.
 * @param {string} base Adres van de testserver.
 * @param {string} accessToken Het token.
 * @param {string} name De tool.
 * @param {object} args De invoer.
 * @returns {Promise<object>} De uitkomst (result).
 */
async function callTool(base, accessToken, name, args) {
  const response = await mcp(base, accessToken, { method: 'tools/call', params: { name, arguments: args } });
  assert.strictEqual(response.status, 200, JSON.stringify(response.body));
  return response.body.result;
}

test('ontdekken: metadata van de bron en de autorisatieserver, 401 wijst de weg', async () => {
  const { base } = await setup();
  const resource = await createClient(base).get('/.well-known/oauth-protected-resource/app/mcp');
  assert.strictEqual(resource.status, 200);
  assert.strictEqual(resource.body.resource, `${base}/app/mcp`);
  assert.deepStrictEqual(resource.body.authorization_servers, [base]);
  const server = await createClient(base).get('/.well-known/oauth-authorization-server');
  assert.strictEqual(server.body.issuer, base);
  assert.strictEqual(server.body.token_endpoint, `${base}/app/oauth/token`);
  assert.deepStrictEqual(server.body.code_challenge_methods_supported, ['S256']);
  const anonymous = await mcp(base, null, { method: 'initialize', params: {} });
  assert.strictEqual(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource/app/mcp"`));
  const wrong = await mcp(base, 'aqt_at_x.' + 'a'.repeat(43), { method: 'initialize', params: {} });
  assert.strictEqual(wrong.status, 401);
  assert.match(wrong.headers.get('www-authenticate'), /error="invalid_token"/);
  assert.strictEqual((await fetch(`${base}/app/mcp`)).status, 405);
});

test('registreren: alleen bekende AI-apps of de eigen computer', async () => {
  const { base } = await setup();
  const ok = await register(base);
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.body.token_endpoint_auth_method, 'none');
  assert.match(ok.body.client_id, /^aqtc_/);
  for (const uri of ['https://evil.example/cb', 'http://claude.ai/cb', 'https://claude.ai.evil.example/cb', 'https://claude.ai:8443/cb', 'https://user@claude.ai/cb', 'javascript:alert(1)']) {
    assert.strictEqual((await register(base, { redirect_uris: [uri] })).status, 400, uri);
  }
  assert.strictEqual((await register(base, { redirect_uris: ['http://127.0.0.1:33418/callback'] })).status, 201);
  assert.strictEqual((await register(base, { redirect_uris: [] })).status, 400);
  assert.strictEqual((await register(base, { grant_types: ['client_credentials'] })).status, 400);
});

test('de hele weg: toestaan, tools gebruiken en een concept-offerte met notities maken', async () => {
  const { base, admin, store, main } = await setup();
  // Niet ingelogd: eerst de inlogpagina op hetzelfde adres.
  const clientId = (await register(base)).body.client_id;
  const login = await createClient(base).get(authorizeUrl({ client_id: clientId, code_challenge: pkcePair().challenge }));
  assert.strictEqual(login.status, 401);
  assert.match(login.text, /api\/auth\/login|Inloggen/i);
  // Het toestemmingsscherm noemt de app, het account en de omgeving, en laat het formulier alleen naar claude.ai doorsturen.
  const { challenge } = pkcePair();
  const page = await admin.get(authorizeUrl({ client_id: clientId, code_challenge: challenge }));
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Claude koppelen aan AquaTech/);
  assert.match(page.text, /claude\.ai/);
  assert.match(page.headers.get('content-security-policy'), /form-action 'self' https:\/\/claude\.ai/);
  assert.match(page.headers.get('x-frame-options'), /DENY/);

  const connection = await connect(base, admin);
  assert.strictEqual(connection.scope, 'klanten.lezen klanten.aanmaken artikelen.lezen offertes.concept');
  const init = await mcp(base, connection.accessToken, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.strictEqual(init.body.result.protocolVersion, '2025-06-18');
  assert.ok(init.body.result.capabilities.tools);
  assert.strictEqual((await mcp(base, connection.accessToken, { method: 'notifications/initialized', id: undefined })).status, 202);
  const tools = (await mcp(base, connection.accessToken, { method: 'tools/list' })).body.result.tools.map((tool) => tool.name);
  assert.deepStrictEqual(tools, ['zoek_klant', 'maak_klant', 'zoek_artikelen', 'maak_concept_offerte']);
  assert.strictEqual((await mcp(base, connection.accessToken, { method: 'bestaat/niet' })).body.error.code, -32601);

  const articles = await callTool(base, connection.accessToken, 'zoek_artikelen', { zoekterm: 'sproeier pop-up' });
  assert.deepStrictEqual(articles.structuredContent.artikelen.map((item) => item.code), ['SPR-POP-10']);
  assert.strictEqual(articles.structuredContent.artikelen[0].prijsExclBtw, 12.5);

  const customer = await callTool(base, connection.accessToken, 'maak_klant', { naam: 'Piet de Vries', email: 'piet@example.nl', postcode: '8071 ab', huisnummer: '1' });
  assert.strictEqual(customer.isError, false, JSON.stringify(customer));
  assert.strictEqual(customer.structuredContent.adres, 'Tuinstraat 1, 8071 AB Nunspeet');
  const twice = await callTool(base, connection.accessToken, 'maak_klant', { naam: 'piet de vries' });
  assert.strictEqual(twice.isError, true);
  assert.strictEqual(twice.structuredContent.bestaand[0].id, customer.structuredContent.id);
  assert.strictEqual((await callTool(base, connection.accessToken, 'maak_klant', { naam: 'X', postcode: '8071AB', huisnummer: '99' })).isError, true);
  const found = await callTool(base, connection.accessToken, 'zoek_klant', { zoekterm: 'vries' });
  assert.deepStrictEqual(found.structuredContent.klanten.map((item) => item.id), [customer.structuredContent.id]);

  const made = await callTool(base, connection.accessToken, 'maak_concept_offerte', {
    klantId: customer.structuredContent.id, titel: 'Beregening achtertuin',
    regels: [
      { artikelcode: 'spr-pop-10', aantal: 8, prijsExclBtw: 9 },
      { artikelcode: 'PE-25', aantal: 40, twijfel: true, notitie: 'Klant zei "zo\'n 40 meter"' },
      { artikelcode: 'VERZONNEN-1', aantal: 1 },
      { omschrijving: 'Aanleg en afstellen', soort: 'arbeid', aantal: 6 },
      { omschrijving: 'Afvoer grond', aantal: 1, prijsExclBtw: 75 },
    ],
  });
  assert.strictEqual(made.isError, false, JSON.stringify(made));
  const result = made.structuredContent;
  assert.strictEqual(result.status, 'concept');
  assert.match(result.nummer, /^OF-\d{4}-0001$/);
  assert.strictEqual(result.link, `${base}/app/offertes/?id=${result.offerteId}`);
  assert.deepStrictEqual(result.aandachtspunten.map((point) => point.regel), [1, 2, 3]);

  const quote = (await admin.get(`/app/api/quotes/${result.offerteId}`)).body;
  assert.strictEqual(quote.status, 'concept');
  assert.strictEqual(quote.customerId, customer.structuredContent.id);
  assert.strictEqual(quote.data.customer.address, 'Tuinstraat 1\n8071 AB Nunspeet');
  const [sprinklers, pipe, unknown, labor, disposal] = quote.data.lines;
  assert.deepStrictEqual([sprinklers.code, sprinklers.price, sprinklers.unit, sprinklers.description], ['SPR-POP-10', 12.5, 'st', 'Pop-up sproeier 10 cm']);
  assert.match(sprinklers.note, /wijkt af van de artikelprijs/);
  assert.match(pipe.note, /AI twijfelt · Klant zei/);
  assert.deepStrictEqual([unknown.code, unknown.price], ['', 0]);
  assert.match(unknown.note, /VERZONNEN-1 niet gevonden/);
  assert.deepStrictEqual([labor.section, labor.unit, labor.price, labor.note], ['arbeid', 'uur', 60, '']);
  assert.deepStrictEqual([disposal.price, disposal.note], [75, '']);
  assert.strictEqual(quote.totalExcl, Math.round((8 * 12.5 + 40 * 1.2 + 6 * 60 + 75) * 100) / 100);
  // Het auditlog legt vast dat de offerte via de AI-koppeling kwam.
  const actions = store.listAudit(main, { limit: 100 });
  const rows = Array.isArray(actions) ? actions : actions.items;
  assert.ok(rows.some((row) => row.action === 'offerte_concept_via_ai'), 'auditregel ontbreekt');
  assert.ok(rows.some((row) => row.action === 'ai_koppeling_toegestaan'));
});

test('de interne notitie per regel gaat nooit naar de klant', async () => {
  const { base, admin, store, main, as } = await setup();
  const klant = store.listCustomers([main]).find((customer) => customer.username === 'klant1');
  const connection = await connect(base, admin);
  const made = await callTool(base, connection.accessToken, 'maak_concept_offerte', { klantId: klant.id, regels: [{ artikelcode: 'PE-25', aantal: 10, twijfel: true, notitie: 'geheim voor intern' }] });
  const id = made.structuredContent.offerteId;
  assert.strictEqual((await admin.put(`/app/api/quotes/${id}`, { status: 'verzonden' })).status, 200);
  const seen = await (await as('klant1')).get(`/app/api/quotes/${id}`);
  assert.strictEqual(seen.status, 200);
  assert.strictEqual(seen.body.data.lines.length, 1);
  assert.strictEqual(seen.body.data.lines[0].note, undefined);
  assert.ok(!seen.text.includes('geheim voor intern'));
  // Met de opmaak "totaal per onderdeel" ook niet.
  const quote = (await admin.get(`/app/api/quotes/${id}`)).body;
  assert.strictEqual((await admin.put(`/app/api/quotes/${id}`, { data: { ...quote.data, layout: 'totaal' } })).status, 200);
  assert.ok(!(await (await as('klant1')).get(`/app/api/quotes/${id}`)).text.includes('geheim voor intern'));
  // Gecontroleerd in de editor: de notitie kan weg (lege notitie blijft leeg).
  const cleared = await admin.put(`/app/api/quotes/${id}`, { data: { ...quote.data, lines: quote.data.lines.map((line) => ({ ...line, note: '' })) } });
  assert.strictEqual(cleared.body.data.lines[0].note, '');
});

test('code, PKCE en terugkeeradres worden streng gecontroleerd; een code werkt één keer', async () => {
  const { base, admin } = await setup();
  const clientId = (await register(base)).body.client_id;
  // Een vervalst of onbekend client_id en een ander terugkeeradres geven een foutpagina, geen doorsturen.
  const forged = await admin.get(authorizeUrl({ client_id: clientId.replace(/.$/, (last) => (last === 'a' ? 'b' : 'a')), code_challenge: pkcePair().challenge }));
  assert.strictEqual(forged.status, 400);
  assert.strictEqual(forged.location, '');
  const otherRedirect = await admin.get(authorizeUrl({ client_id: clientId, code_challenge: pkcePair().challenge, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect' }));
  assert.strictEqual(otherRedirect.status, 400);
  // Zonder PKCE of met plain: terug naar de app met een fout.
  const plain = await admin.get(authorizeUrl({ client_id: clientId, code_challenge: 'x'.repeat(43), code_challenge_method: 'plain' }));
  assert.strictEqual(plain.status, 302);
  assert.strictEqual(new URL(plain.location).searchParams.get('error'), 'invalid_request');
  const otherResource = await admin.get(authorizeUrl({ client_id: clientId, code_challenge: pkcePair().challenge, resource: 'https://elders.example/mcp' }));
  assert.strictEqual(new URL(otherResource.location).searchParams.get('error'), 'invalid_target');
  const badScope = await admin.get(authorizeUrl({ client_id: clientId, code_challenge: pkcePair().challenge, scope: 'alles' }));
  assert.strictEqual(new URL(badScope.location).searchParams.get('error'), 'invalid_scope');

  // Verkeerde verifier: geen tokens.
  const { challenge, verifier } = pkcePair();
  const page = await admin.get(authorizeUrl({ client_id: clientId, code_challenge: challenge }));
  const code = new URL((await postForm(base, admin, '/app/oauth/authorize', { ...consentFields(page.text), decision: 'allow' })).location).searchParams.get('code');
  const base64Verifier = pkcePair().verifier;
  assert.strictEqual((await token(base, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: base64Verifier })).body.error, 'invalid_grant');
  // Andere app (ander client_id) met dezelfde code: geweigerd.
  const otherClient = (await register(base, { redirect_uris: [REDIRECT, 'http://127.0.0.1:9/cb'] })).body.client_id;
  assert.strictEqual((await token(base, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: otherClient, code_verifier: verifier })).body.error, 'invalid_grant');
  const first = await token(base, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.token_type, 'Bearer');
  // Dezelfde code nog eens: geweigerd, en de hele koppeling vervalt (de code is uitgelekt).
  assert.strictEqual((await token(base, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })).body.error, 'invalid_grant');
  assert.strictEqual((await mcp(base, first.body.access_token, { method: 'ping' })).status, 401);
  assert.strictEqual((await token(base, { grant_type: 'client_credentials', client_id: clientId })).body.error, 'unsupported_grant_type');
  assert.strictEqual((await token(base, { grant_type: 'authorization_code', client_id: 'aqtc_nep.x' })).status, 401);
});

test('gelijktijdig inwisselen van één code geeft hoogstens één set tokens', async () => {
  const { base, admin } = await setup();
  const clientId = (await register(base)).body.client_id;
  const { challenge, verifier } = pkcePair();
  const page = await admin.get(authorizeUrl({ client_id: clientId, code_challenge: challenge }));
  const code = new URL((await postForm(base, admin, '/app/oauth/authorize', { ...consentFields(page.text), decision: 'allow' })).location).searchParams.get('code');
  const fields = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier };
  const answers = await Promise.all([token(base, fields), token(base, fields), token(base, fields)]);
  assert.strictEqual(answers.filter((answer) => answer.status === 200).length, 1);
});

test('vernieuwen roteert het token; het oude werkt niet meer', async () => {
  const { base, admin } = await setup();
  const connection = await connect(base, admin);
  const renewed = await token(base, { grant_type: 'refresh_token', refresh_token: connection.refreshToken, client_id: connection.clientId });
  assert.strictEqual(renewed.status, 200);
  assert.notStrictEqual(renewed.body.refresh_token, connection.refreshToken);
  assert.strictEqual((await mcp(base, renewed.body.access_token, { method: 'ping' })).status, 200);
  assert.strictEqual((await mcp(base, connection.accessToken, { method: 'ping' })).status, 401);
  assert.strictEqual((await token(base, { grant_type: 'refresh_token', refresh_token: connection.refreshToken, client_id: connection.clientId })).body.error, 'invalid_grant');
  // Met een ander client_id niet.
  const otherClient = (await register(base, { redirect_uris: [REDIRECT, 'http://127.0.0.1:9/cb'] })).body.client_id;
  assert.strictEqual((await token(base, { grant_type: 'refresh_token', refresh_token: renewed.body.refresh_token, client_id: otherClient })).body.error, 'invalid_grant');
});

test('toestemmingsscherm: CSRF, ander account, andere site en weigeren', async () => {
  const { base, admin, installer } = await setup();
  const clientId = (await register(base)).body.client_id;
  const page = await admin.get(authorizeUrl({ client_id: clientId, code_challenge: pkcePair().challenge }));
  const fields = consentFields(page.text);
  assert.strictEqual((await postForm(base, admin, '/app/oauth/authorize', { ...fields, decision: 'allow' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  // Het scherm is na één poging verbruikt; een nieuw scherm met een vervalste CSRF-code of door een ander account: geweigerd.
  const second = consentFields((await admin.get(authorizeUrl({ client_id: clientId, code_challenge: pkcePair().challenge }))).text);
  assert.strictEqual((await postForm(base, installer, '/app/oauth/authorize', { ...second, decision: 'allow' })).status, 403);
  const third = consentFields((await admin.get(authorizeUrl({ client_id: clientId, code_challenge: pkcePair().challenge }))).text);
  assert.strictEqual((await postForm(base, admin, '/app/oauth/authorize', { ...third, csrf: third.csrf.replace(/^./, 'x'), decision: 'allow' })).status, 403);
  const fourth = consentFields((await admin.get(authorizeUrl({ client_id: clientId, code_challenge: pkcePair().challenge }))).text);
  const denied = await postForm(base, admin, '/app/oauth/authorize', { ...fourth, decision: 'deny' });
  assert.strictEqual(new URL(denied.location).searchParams.get('error'), 'access_denied');
  assert.strictEqual((await postForm(base, admin, '/app/oauth/authorize', { ...fourth, decision: 'allow' })).status, 400);
});

test('rechten: een klant kan niet koppelen en een smalle scope geeft minder tools', async () => {
  const { base, admin, as } = await setup();
  const clientId = (await register(base)).body.client_id;
  const customer = await as('klant1');
  assert.strictEqual((await customer.get(authorizeUrl({ client_id: clientId, code_challenge: pkcePair().challenge }))).status, 403);
  const narrow = await connect(base, admin, { scope: 'artikelen.lezen' });
  assert.strictEqual(narrow.scope, 'artikelen.lezen');
  assert.deepStrictEqual((await mcp(base, narrow.accessToken, { method: 'tools/list' })).body.result.tools.map((tool) => tool.name), ['zoek_artikelen']);
  const blocked = await callTool(base, narrow.accessToken, 'maak_concept_offerte', { regels: [{ omschrijving: 'x', aantal: 1 }] });
  assert.strictEqual(blocked.isError, true);
  assert.strictEqual((await mcp(base, narrow.accessToken, { method: 'tools/call', params: { name: 'verwijder_alles', arguments: {} } })).body.error.code, -32602);
});

test('organisaties zijn gescheiden: een andere organisatie ziet geen klanten en kan ze niet gebruiken', async () => {
  const { base, store, main, as } = await setup();
  const outsider = await as('vreemd', 'ander');
  assert.strictEqual((await outsider.put('/app/api/admin/settings', { aiConnector: true })).status, 200);
  const connection = await connect(base, outsider);
  const ownCustomer = store.listCustomers([main]).find((customer) => customer.username === 'klant1');
  assert.strictEqual((await callTool(base, connection.accessToken, 'zoek_klant', { zoekterm: 'Klant' })).structuredContent.aantal, 0);
  assert.strictEqual((await callTool(base, connection.accessToken, 'zoek_artikelen', { zoekterm: 'PE' })).structuredContent.aantal, 0);
  const foreign = await callTool(base, connection.accessToken, 'maak_concept_offerte', { klantId: ownCustomer.id, regels: [{ omschrijving: 'x', aantal: 1 }] });
  assert.strictEqual(foreign.isError, true);
  // Een token van de ene organisatie met de omgeving van een andere erin geplakt werkt niet.
  const swapped = connection.accessToken.replace(/^aqt_at_[^.]+/, `aqt_at_${main}`);
  assert.strictEqual((await mcp(base, swapped, { method: 'ping' })).status, 401);
});

test('uitzetten, uitschakelen, wachtwoord wijzigen en intrekken stoppen de koppeling direct', async () => {
  const { base, admin, as } = await setup();
  // Intrekken via Mijn profiel.
  const installer = await as('monteur');
  const viaProfile = await connect(base, installer);
  const list = await installer.get('/app/api/account/connections');
  assert.strictEqual(list.body.items.length, 1);
  assert.strictEqual(list.body.items[0].app, 'Claude');
  assert.strictEqual(list.body.available, true);
  assert.strictEqual((await admin.del(`/app/api/account/connections/${list.body.items[0].id}`)).status, 404);
  assert.strictEqual((await installer.del(`/app/api/account/connections/${list.body.items[0].id}`)).status, 200);
  assert.strictEqual((await mcp(base, viaProfile.accessToken, { method: 'ping' })).status, 401);
  assert.strictEqual((await installer.get('/app/api/account/connections')).body.items.length, 0);

  // Intrekken door de app zelf (RFC 7009).
  const viaApp = await connect(base, installer);
  const revoke = await fetch(`${base}/app/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: viaApp.refreshToken, client_id: viaApp.clientId }) });
  assert.strictEqual(revoke.status, 200);
  assert.strictEqual((await mcp(base, viaApp.accessToken, { method: 'ping' })).status, 401);

  // Uitschakelen van het account.
  const disabled = await connect(base, installer);
  const userId = (await installer.get('/app/api/me')).body.user.id;
  assert.strictEqual((await admin.patch(`/app/api/admin/users/${userId}`, { disabled: true })).status, 200);
  assert.strictEqual((await mcp(base, disabled.accessToken, { method: 'ping' })).status, 401);
  assert.strictEqual((await admin.patch(`/app/api/admin/users/${userId}`, { disabled: false })).status, 200);

  // Nieuw wachtwoord: oude koppelingen vervallen.
  const beforePassword = await connect(base, admin);
  assert.strictEqual((await admin.post('/app/api/account/password', { currentPassword: PW, newPassword: 'Nieuw-Tuin-2026!' })).status, 200);
  assert.strictEqual((await mcp(base, beforePassword.accessToken, { method: 'ping' })).status, 401);

  // De koppeling uitzetten in Beheer.
  const admin2 = await createLogin(base, { password: 'Nieuw-Tuin-2026!', clientOptions: { followRedirects: false } })('baas');
  const beforeOff = await connect(base, admin2);
  assert.strictEqual((await admin2.put('/app/api/admin/settings', { aiConnector: false })).status, 200);
  assert.strictEqual((await mcp(base, beforeOff.accessToken, { method: 'ping' })).status, 401);
  const clientId = (await register(base)).body.client_id;
  assert.strictEqual((await admin2.get(authorizeUrl({ client_id: clientId, code_challenge: pkcePair().challenge }))).status, 403);
});

test('MCP-server: Origin van een vreemde site, onbekende protocolversie en lijsten van berichten', async () => {
  const { base, admin } = await setup();
  const connection = await connect(base, admin);
  assert.strictEqual((await mcp(base, connection.accessToken, { method: 'ping' }, { origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await mcp(base, connection.accessToken, { method: 'ping' }, { origin: 'https://claude.ai' })).status, 200);
  assert.strictEqual((await mcp(base, connection.accessToken, { method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
  const response = await fetch(`${base}/app/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.accessToken}` },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]) });
  const answers = await response.json();
  assert.deepStrictEqual(answers.map((answer) => answer.id), [1, 2]);
  const invalid = await callTool(base, connection.accessToken, 'maak_concept_offerte', { regels: [{ aantal: -1, omschrijving: 'x' }] });
  assert.strictEqual(invalid.isError, true);
  const empty = await callTool(base, connection.accessToken, 'maak_concept_offerte', { regels: [] });
  assert.strictEqual(empty.isError, true);
});

test('hulpfuncties: terugkeeradressen, scopes, PKCE, tokens en het zoeken van artikelen', () => {
  assert.ok(allowedRedirect('https://claude.ai/api/mcp/auth_callback'));
  assert.ok(allowedRedirect('https://chatgpt.com/connector_platform_oauth_redirect'));
  assert.ok(allowedRedirect('http://localhost:6274/oauth/callback'));
  assert.strictEqual(allowedRedirect('https://claude.ai/cb#x'), null);
  assert.strictEqual(allowedRedirect('https://notclaude.ai/cb'), null);
  assert.deepStrictEqual(parseScope(''), ['klanten.lezen', 'klanten.aanmaken', 'artikelen.lezen', 'offertes.concept']);
  assert.strictEqual(parseScope('offertes.concept admin'), null);
  const verifier = 'a'.repeat(43);
  assert.ok(pkceMatches(verifier, crypto.createHash('sha256').update(verifier).digest('base64url')));
  assert.ok(!pkceMatches('kort', 'x'));
  assert.strictEqual(parseToken(`aqt_rt_abc.${'b'.repeat(43)}`, 'at'), null);
  assert.strictEqual(parseToken(`aqt_at_abc.${'b'.repeat(43)}`, 'at').tenantId, 'abc');
  const articles = [
    { code: 'SPR-1', name: 'Sproeier rotor', variants: [] },
    { code: 'SLANG', name: 'Druppelslang', variants: [{ code: 'SLANG-16', name: 'Druppelslang 16 mm', values: { maat: '16 mm' } }] },
    { code: 'KRAAN', name: 'Kogelkraan messing', variants: [] },
  ];
  assert.deepStrictEqual(searchArticles(articles, 'rotor sproeier', 5).items.map((item) => item.code), ['SPR-1']);
  assert.strictEqual(searchArticles(articles, 'kraan plastic', 5).allWords, false);
  assert.deepStrictEqual(searchArticles(articles, 'slang-16', 5).items.map((item) => item.code), ['SLANG']);
  assert.strictEqual(findArticle(articles, 'slang-16').parent.code, 'SLANG');
  assert.strictEqual(findArticle(articles, 'bestaat-niet'), null);
});
