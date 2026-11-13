// AI-koppeling (mcp/): OAuth 2.1 (ontdekken, registreren, toestemming met PKCE, tokens, vernieuwen, intrekken) en de
// MCP-server met de tools zoek_klant, maak_klant, zoek_artikelen, maak_concept_offerte en de leesfuncties (klant_details,
// prijs_voor_klant, status_opvragen, openstaande_debiteuren). Ook de beveiliging: alleen
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
const { daysLate, numberCandidates } = require('../src/mcp/mcp-lookups');
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

test('met een webadres in Beheer gelden issuer, resource en links dat adres, niet de Host-kop', async () => {
  const { base, admin } = await setup();
  assert.strictEqual((await admin.put('/app/api/admin/settings', { shopPayment: { publicUrl: 'https://winkel.example.nl/' } })).status, 200);
  const resource = await createClient(base).get('/.well-known/oauth-protected-resource/app/mcp');
  assert.strictEqual(resource.body.resource, 'https://winkel.example.nl/app/mcp');
  assert.deepStrictEqual(resource.body.authorization_servers, ['https://winkel.example.nl']);
  assert.strictEqual((await createClient(base).get('/.well-known/oauth-authorization-server')).body.issuer, 'https://winkel.example.nl');
  assert.strictEqual((await admin.get('/app/api/account/connections')).body.url, 'https://winkel.example.nl/app/mcp');
  const anonymous = await mcp(base, null, { method: 'initialize', params: {} });
  assert.match(anonymous.headers.get('www-authenticate'), /resource_metadata="https:\/\/winkel\.example\.nl\/\.well-known\/oauth-protected-resource\/app\/mcp"/);
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
  assert.strictEqual(connection.scope, 'klanten.lezen klanten.aanmaken artikelen.lezen offertes.concept werkorders.concept werkregistratie.boeken status.lezen facturen.lezen');
  const init = await mcp(base, connection.accessToken, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.strictEqual(init.body.result.protocolVersion, '2025-06-18');
  assert.ok(init.body.result.capabilities.tools);
  assert.strictEqual((await mcp(base, connection.accessToken, { method: 'notifications/initialized', id: undefined })).status, 202);
  const tools = (await mcp(base, connection.accessToken, { method: 'tools/list' })).body.result.tools.map((tool) => tool.name);
  assert.deepStrictEqual(tools, ['zoek_klant', 'maak_klant', 'zoek_artikelen', 'klant_details', 'prijs_voor_klant', 'status_opvragen', 'openstaande_debiteuren', 'boek_uren', 'boek_materiaal', 'maak_concept_werkorder', 'maak_concept_offerte']);
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
    klantId: customer.structuredContent.id, titel: 'Beregening achtertuin', ookMetOpenPunten: true,
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

test('de koppeling vraagt terug bij onduidelijkheid in plaats van te raden', async () => {
  const { base, admin, store, main } = await setup();
  const connection = await connect(base, admin);
  const token = connection.accessToken;
  const init = await mcp(base, token, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.match(init.body.result.instructions, /TERUGVRAGEN: raad nooit/);
  // Meerdere treffers of geen: keuzeNodig met een vraag voor de gebruiker; één duidelijke treffer niet.
  await callTool(base, token, 'maak_klant', { naam: 'Jan Bakker' });
  await callTool(base, token, 'maak_klant', { naam: 'Jan Bosman' });
  const several = (await callTool(base, token, 'zoek_klant', { zoekterm: 'jan' })).structuredContent;
  assert.strictEqual(several.keuzeNodig, true);
  assert.match(several.vraag, /2 mogelijke treffers/);
  const one = (await callTool(base, token, 'zoek_klant', { zoekterm: 'bakker' })).structuredContent;
  assert.strictEqual(one.keuzeNodig, undefined);
  const none = (await callTool(base, token, 'zoek_klant', { zoekterm: 'bestaatniet' })).structuredContent;
  assert.strictEqual(none.keuzeNodig, true);
  assert.match(none.vraag, /Maak niet zelf een klant aan/);
  // Bij de limiet (10 resultaten) is het aantal niet exact: "10 of meer", niet "10 mogelijke treffers".
  for (let number = 1; number <= 10; number += 1) await callTool(base, token, 'maak_klant', { naam: `Piet Extra ${number}` });
  const capped = (await callTool(base, token, 'zoek_klant', { zoekterm: 'extra' })).structuredContent;
  assert.strictEqual(capped.aantal, 10);
  assert.match(capped.vraag, /10 of meer mogelijke treffers/);
  assert.strictEqual((await callTool(base, token, 'zoek_artikelen', { zoekterm: 'PE-25' })).structuredContent.keuzeNodig, undefined);
  assert.strictEqual((await callTool(base, token, 'zoek_artikelen', { zoekterm: 'nietbestaand' })).structuredContent.keuzeNodig, true);
  assert.strictEqual((await callTool(base, token, 'zoek_artikelen', { zoekterm: 'sproeier beregeningscomputer' })).structuredContent.keuzeNodig, true);
  // Precies één gedeeltelijke treffer (alleen het woord "zones" past, "xyz" niet) is ook geen duidelijke keuze.
  const partial = (await callTool(base, token, 'zoek_artikelen', { zoekterm: 'beregeningscomputer xyz' })).structuredContent;
  assert.strictEqual(partial.aantal, 1);
  assert.strictEqual(partial.keuzeNodig, true);

  // Open punten: niets aangemaakt, de vragen komen terug; met ookMetOpenPunten gaat hij wel door.
  const before = (await admin.get('/app/api/quotes')).body.length;
  const asked = await callTool(base, token, 'maak_concept_offerte', { regels: [{ artikelcode: 'VERZONNEN-1', aantal: 1 }, { omschrijving: 'Iets', aantal: 2 }] });
  assert.strictEqual(asked.isError, false);
  assert.strictEqual(asked.structuredContent.status, 'terugvragen');
  assert.strictEqual(asked.structuredContent.aangemaakt, false);
  assert.deepStrictEqual(asked.structuredContent.vragen.map((question) => question.onderwerp || question.regel), ['klant', 1, 2]);
  assert.strictEqual((await admin.get('/app/api/quotes')).body.length, before);
  const forced = await callTool(base, token, 'maak_concept_offerte', { klant: { naam: 'Los Persoon' }, ookMetOpenPunten: true, regels: [{ artikelcode: 'VERZONNEN-1', aantal: 1 }] });
  assert.strictEqual(forced.structuredContent.status, 'concept');
  // Een duidelijke aanvraag gaat gewoon door, zonder vragen.
  const klant = store.listCustomers([main]).find((customer) => customer.username === 'klant1');
  const clear = await callTool(base, token, 'maak_concept_offerte', { klantId: klant.id, regels: [{ artikelcode: 'PE-25', aantal: 10 }] });
  assert.strictEqual(clear.structuredContent.status, 'concept');
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
  // Markeer als gecontroleerd: de notitie blijft voor intern staan met de status; de klant ziet geen van beide.
  const checked = await admin.put(`/app/api/quotes/${id}`, { data: { ...quote.data, lines: quote.data.lines.map((line) => ({ ...line, noteChecked: true })) } });
  assert.strictEqual(checked.body.data.lines[0].noteChecked, true);
  assert.ok(checked.body.data.lines[0].note.includes('geheim voor intern'));
  const seenChecked = await (await as('klant1')).get(`/app/api/quotes/${id}`);
  assert.strictEqual(seenChecked.body.data.lines[0].noteChecked, undefined);
  assert.ok(!seenChecked.text.includes('geheim voor intern'));
  // Zonder notitie bestaat er niets te controleren.
  const cleared = await admin.put(`/app/api/quotes/${id}`, { data: { ...quote.data, lines: quote.data.lines.map((line) => ({ ...line, note: '', noteChecked: true })) } });
  assert.strictEqual(cleared.body.data.lines[0].note, '');
  assert.strictEqual(cleared.body.data.lines[0].noteChecked, false);
});

test('leesfuncties: klantkaart, prijs voor een zakelijke klant, status op nummer en openstaande debiteuren', async () => {
  const { base, db, main, admin, installer, as } = await setup();
  const connection = await connect(base, admin);
  const created = (await callTool(base, connection.accessToken, 'maak_klant', { naam: 'Groen Hoveniers' })).structuredContent;
  db.prepare("UPDATE users SET customer_group = 'zakelijk', company_name = 'Groen BV', wholesale = 1, wholesale_discount = 10, payment_days = 14 WHERE tenant_id = ? AND id = ?").run(main, created.id);
  db.prepare("UPDATE stock_items SET business_price = 10 WHERE tenant_id = ? AND code = 'SPR-POP-10'").run(main);

  // Prijs: offerteprijs uit de voorraad, webshopprijs met zakelijke prijs min 10% groothandelskorting.
  const priced = (await callTool(base, connection.accessToken, 'prijs_voor_klant', { klantId: created.id, artikelen: [{ artikelcode: 'spr-pop-10', aantal: 2 }, { artikelcode: 'BESTAAT-NIET' }] })).structuredContent;
  assert.strictEqual(priced.klantgroep, 'zakelijk');
  assert.strictEqual(priced.groothandel, true);
  const sprinkler = priced.artikelen[0];
  assert.strictEqual(sprinkler.offerteprijsExclBtw, 12.5);
  assert.strictEqual(sprinkler.webshop.prijsExclBtw, 9);
  assert.strictEqual(sprinkler.webshop.kortingProcent, 10);
  assert.strictEqual(sprinkler.beschikbaar, 40);
  assert.deepStrictEqual(priced.artikelen[1], { artikelcode: 'BESTAAT-NIET', gevonden: false });
  assert.strictEqual((await callTool(base, connection.accessToken, 'prijs_voor_klant', { klantId: 'onbekend', artikelen: [{ artikelcode: 'PE-25' }] })).isError, true);

  // Een definitieve, onbetaalde factuur over de vervaldatum voor deze klant.
  const invoice = (await admin.post('/app/api/invoices', { data: { customer: { name: 'Groen BV' }, lines: [{ description: 'Onderhoud', qty: 1, price: 100, vat: 21 }] } })).body;
  const finalized = await admin.post(`/app/api/invoices/${invoice.id}/finalize`, {});
  assert.strictEqual(finalized.status, 200, JSON.stringify(finalized.body));
  db.prepare("UPDATE invoices SET customer_id = ?, due_date = '2020-01-01' WHERE tenant_id = ? AND id = ?").run(created.id, main, invoice.id);
  const paidInvoice = (await admin.post('/app/api/invoices', { data: { customer: { name: 'Betaalt Netjes' }, lines: [{ description: 'Sproeier', qty: 1, price: 50, vat: 21 }] } })).body;
  await admin.post(`/app/api/invoices/${paidInvoice.id}/finalize`, {});
  assert.strictEqual((await admin.post(`/app/api/invoices/${paidInvoice.id}/paid`, { paid: true })).status, 200);

  // Klantkaart: klantgroep, eigen betaaltermijn, korting en het openstaande bedrag.
  const card = (await callTool(base, connection.accessToken, 'klant_details', { klantId: created.id })).structuredContent;
  assert.strictEqual(card.klantgroep, 'zakelijk');
  assert.strictEqual(card.betaaltermijnDagen, 14);
  assert.strictEqual(card.betaaltermijnBron, 'eigen afspraak');
  assert.deepStrictEqual(card.groothandel, { korting: 10 });
  assert.strictEqual(card.openstaand.openstaand, 121);
  assert.strictEqual(card.openstaand.teLaat, 121);
  assert.ok(card.openstaand.facturen[0].dagenTeLaat > 0);
  assert.match(card.link, new RegExp(`/app/klanten/\\?id=${created.id}$`));

  // Openstaande debiteuren: de database telt per debiteur op; betaalde facturen tellen niet mee.
  const second = (await admin.post('/app/api/invoices', { data: { customer: { name: 'Groen BV' }, lines: [{ description: 'Uitbreiding', qty: 1, price: 100, vat: 21 }] } })).body;
  await admin.post(`/app/api/invoices/${second.id}/finalize`, {});
  db.prepare("UPDATE invoices SET customer_id = ?, due_date = '2099-01-01' WHERE tenant_id = ? AND id = ?").run(created.id, main, second.id);
  const loose = (await admin.post('/app/api/invoices', { data: { customer: { name: 'Balieklant' } , lines: [{ description: 'Zand', qty: 1, price: 10, vat: 21 }] } })).body;
  await admin.post(`/app/api/invoices/${loose.id}/finalize`, {});
  db.prepare("UPDATE invoices SET due_date = '2099-01-01' WHERE tenant_id = ? AND id = ?").run(main, loose.id);
  const everyone = (await callTool(base, connection.accessToken, 'openstaande_debiteuren', {})).structuredContent;
  assert.strictEqual(everyone.aantalDebiteuren, 2);
  assert.strictEqual(everyone.totaalOpenstaand, 254.1);
  assert.strictEqual(everyone.debiteuren[0].klantId, created.id);
  assert.strictEqual(everyone.debiteuren[0].aantalFacturen, 2);
  assert.strictEqual(everyone.debiteuren[0].openstaand, 242);
  assert.strictEqual(everyone.debiteuren[0].teLaat, 121);
  assert.strictEqual(everyone.debiteuren[0].oudsteVervaldatum, '2020-01-01');
  assert.strictEqual(everyone.debiteuren[0].facturen.length, 2);
  assert.strictEqual(everyone.debiteuren[1].naam, 'Balieklant');
  assert.strictEqual(everyone.debiteuren[0].facturenGetoond, 2);
  assert.ok(!JSON.stringify(everyone).includes('Betaalt Netjes'));
  assert.strictEqual((await callTool(base, connection.accessToken, 'openstaande_debiteuren', { maxResultaten: 1 })).structuredContent.debiteuren.length, 1);
  const debtors = (await callTool(base, connection.accessToken, 'openstaande_debiteuren', { alleenTeLaat: true })).structuredContent;
  assert.strictEqual(debtors.aantalGevonden, 1);
  assert.strictEqual(debtors.debiteuren.length, 1);
  assert.strictEqual(debtors.debiteuren[0].klantId, created.id);
  // De totalen gelden ook met het filter voor alle debiteuren.
  assert.strictEqual(debtors.aantalDebiteuren, 2);
  assert.strictEqual(debtors.aantalTeLaat, 1);
  assert.strictEqual(debtors.totaalOpenstaand, 254.1);
  assert.strictEqual(debtors.totaalTeLaat, 121);
  // Veel facturen bij één debiteur: het bedrag telt alles, de lijst toont de tien oudste.
  const stamp = new Date().toISOString();
  for (let i = 0; i < 12; i += 1) {
    db.prepare(`INSERT INTO invoices (id, tenant_id, number, status, kind, customer_name, invoice_date, due_date, subtotal, vat_total, total, data, created_at, updated_at)
      VALUES (?, ?, ?, 'definitief', 'factuur', 'Veel BV', ?, '2099-01-01', 10, 0, 10, '{}', ?, ?)`).run(crypto.randomUUID(), main, `VEEL-${i}`, `2026-01-${String(i + 10)}`, stamp, stamp);
  }
  const many = (await callTool(base, connection.accessToken, 'openstaande_debiteuren', {})).structuredContent.debiteuren.find((debtor) => debtor.naam === 'Veel BV');
  assert.strictEqual(many.aantalFacturen, 12);
  assert.strictEqual(many.openstaand, 120);
  assert.strictEqual(many.facturenGetoond, 10);
  assert.deepStrictEqual(many.facturen.map((invoice) => invoice.nummer), Array.from({ length: 10 }, (_, i) => `VEEL-${i}`));

  // Status op nummer (ook in kleine letters), met een link naar het document.
  const quote = (await callTool(base, connection.accessToken, 'maak_concept_offerte', { klantId: created.id, regels: [{ artikelcode: 'PE-25', aantal: 10 }] })).structuredContent;
  const quoteStatus = (await callTool(base, connection.accessToken, 'status_opvragen', { soort: 'offerte', nummer: quote.nummer.toLowerCase() })).structuredContent;
  assert.strictEqual(quoteStatus.status, 'concept');
  assert.strictEqual(quoteStatus.nummer, quote.nummer);
  assert.ok(quoteStatus.link.endsWith(`/app/offertes/?id=${quote.offerteId}`));
  assert.strictEqual(quoteStatus.id, undefined);
  // Werkorders bij de offerte alleen voor wie werkorders mag zien: een eigen rol met alleen offertes ziet ze niet.
  const adminId = (await admin.get('/app/api/me')).body.user.id;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO work_orders (id, tenant_id, owner_id, quote_id, number, status, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, 'WO-TEST-0001', 'gepland', 'Aanleg', '{}', ?, ?)")
    .run(crypto.randomUUID(), main, adminId, quote.offerteId, now, now);
  assert.deepStrictEqual((await callTool(base, connection.accessToken, 'status_opvragen', { soort: 'offerte', nummer: quote.nummer })).structuredContent.werkorders, [{ nummer: 'WO-TEST-0001', status: 'gepland' }]);
  assert.strictEqual((await admin.post('/app/api/admin/roles', { label: 'Verkoper', rights: ['offertes'] })).status, 201);
  assert.strictEqual((await admin.post('/app/api/admin/users', { username: 'verkoper', displayName: 'Verkoper', role: 'verkoper', password: PW, mustChangePassword: false })).status, 201);
  const seller = await connect(base, await as('verkoper'));
  const sellerView = (await callTool(base, seller.accessToken, 'status_opvragen', { soort: 'offerte', nummer: quote.nummer })).structuredContent;
  assert.strictEqual(sellerView.status, 'concept');
  assert.strictEqual(sellerView.werkorders, undefined);
  assert.ok(!JSON.stringify(sellerView).includes('WO-TEST-0001'));
  assert.strictEqual((await callTool(base, seller.accessToken, 'status_opvragen', { soort: 'werkorder', nummer: 'WO-TEST-0001' })).isError, true);
  const invoiceStatus = (await callTool(base, connection.accessToken, 'status_opvragen', { soort: 'factuur', nummer: finalized.body.number })).structuredContent;
  assert.strictEqual(invoiceStatus.status, 'definitief');
  assert.ok(invoiceStatus.dagenTeLaat > 0);
  assert.strictEqual((await callTool(base, connection.accessToken, 'status_opvragen', { soort: 'werkorder', nummer: 'WO-2099-9999' })).isError, true);
  assert.strictEqual((await callTool(base, connection.accessToken, 'status_opvragen', { soort: 'bestelling', nummer: 'WEB-2099-0001' })).isError, true);

  // Installateur: geen facturen en geen webshopbestellingen in de app, dus ook niet via de AI; de klantkaart zonder openstaand bedrag.
  const viaInstaller = await connect(base, installer);
  assert.strictEqual((await callTool(base, viaInstaller.accessToken, 'openstaande_debiteuren', {})).isError, true);
  const forbidden = await callTool(base, viaInstaller.accessToken, 'status_opvragen', { soort: 'factuur', nummer: finalized.body.number });
  assert.strictEqual(forbidden.isError, true);
  assert.ok(!JSON.stringify(forbidden).includes('definitief'));
  assert.strictEqual((await callTool(base, viaInstaller.accessToken, 'status_opvragen', { soort: 'bestelling', nummer: 'WEB-2099-0001' })).isError, true);
  const installerCard = (await callTool(base, viaInstaller.accessToken, 'klant_details', { klantId: created.id })).structuredContent;
  assert.strictEqual(installerCard.openstaand, undefined);
  assert.strictEqual(installerCard.recenteOffertes[0].nummer, quote.nummer);
  assert.strictEqual((await callTool(base, viaInstaller.accessToken, 'status_opvragen', { soort: 'offerte', nummer: quote.nummer })).structuredContent.status, 'concept');

  // De leesfuncties hebben samen een limiet per gebruiker per uur (300, over al zijn koppelingen); daarna een leesbare fout.
  // Drie koppelingen, omdat elke koppeling los ook 120 verzoeken per minuut mag.
  const tokens = [viaInstaller.accessToken, (await connect(base, installer)).accessToken, (await connect(base, installer)).accessToken];
  let used = 4; // al gedaan hierboven met viaInstaller: drie keer status_opvragen en één klantkaart (debiteuren telt apart)
  while (used < 300) {
    const next = tokens[Math.floor(used / 100)];
    const answer = await callTool(base, next, 'status_opvragen', { soort: 'werkorder', nummer: `WO-2099-${used}` });
    assert.doesNotMatch(answer.structuredContent.fout, /Te veel/, `opvraging ${used + 1}`);
    used += 1;
  }
  const limited = await callTool(base, tokens[2], 'klant_details', { klantId: created.id });
  assert.strictEqual(limited.isError, true);
  assert.match(limited.structuredContent.fout, /Te veel opvragingen/);

  // Een smalle toestemming: alleen artikelen lezen geeft geen klantprijzen (daar hoort klanten.lezen bij).
  const narrow = await connect(base, admin, { scope: 'artikelen.lezen' });
  assert.strictEqual((await callTool(base, narrow.accessToken, 'prijs_voor_klant', { klantId: created.id, artikelen: [{ artikelcode: 'PE-25' }] })).isError, true);
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
  assert.strictEqual((await postForm(base, admin, '/app/oauth/authorize', { ...third, csrf: (third.csrf[0] === 'x' ? 'y' : 'x') + third.csrf.slice(1), decision: 'allow' })).status, 403);
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
  // Alleen intern: een klant ziet in Mijn profiel niets van de koppeling (de API weigert) en een eerdere toestemming werkt niet.
  const forCustomer = await customer.get('/app/api/account/connections');
  assert.strictEqual(forCustomer.status, 403);
  assert.strictEqual(forCustomer.body.error, 'internal_only');
  // Wordt een medewerker klant terwijl het toestemmingsscherm openstaat, dan weigert ook het toestaan.
  const installer = await as('monteur');
  const page = await installer.get(authorizeUrl({ client_id: clientId, code_challenge: pkcePair().challenge }));
  assert.strictEqual(page.status, 200);
  const installerId = (await installer.get('/app/api/me')).body.user.id;
  assert.strictEqual((await admin.patch(`/app/api/admin/users/${installerId}`, { role: 'klant' })).status, 200);
  const late = await postForm(base, installer, '/app/oauth/authorize', { ...consentFields(page.text), decision: 'allow' });
  assert.strictEqual(late.status, 403);
  assert.ok(!late.location);
  const narrow = await connect(base, admin, { scope: 'artikelen.lezen' });
  assert.strictEqual(narrow.scope, 'artikelen.lezen');
  assert.deepStrictEqual((await mcp(base, narrow.accessToken, { method: 'tools/list' })).body.result.tools.map((tool) => tool.name), ['zoek_artikelen']);
  const blocked = await callTool(base, narrow.accessToken, 'maak_concept_offerte', { regels: [{ omschrijving: 'x', aantal: 1 }] });
  assert.strictEqual(blocked.isError, true);
  assert.strictEqual((await mcp(base, narrow.accessToken, { method: 'tools/call', params: { name: 'verwijder_alles', arguments: {} } })).body.error.code, -32602);
});

test('rechten volgen de rol op dit moment: een andere rol beperkt de AI direct tot wat de gebruiker in de app mag', async () => {
  const { base, admin, installer } = await setup();
  const connection = await connect(base, installer);
  // Een tweede koppeling die tijdens de klantrol niet wordt gebruikt: die moet de gebruiker als klant nog kunnen intrekken.
  const firstIds = (await installer.get('/app/api/account/connections')).body.items.map((item) => item.id);
  const spare = await connect(base, installer);
  const spareId = (await installer.get('/app/api/account/connections')).body.items.map((item) => item.id).find((id) => !firstIds.includes(id));
  assert.ok(spareId);
  /**
   * De namen van de tools die de AI nu ziet.
   * @returns {Promise<string[]>} De namen.
   */
  const toolNames = async () => (await mcp(base, connection.accessToken, { method: 'tools/list' })).body.result.tools.map((tool) => tool.name);
  // Installateur: geen facturen, dus geen openstaande debiteuren.
  assert.deepStrictEqual(await toolNames(), ['zoek_klant', 'maak_klant', 'zoek_artikelen', 'klant_details', 'prijs_voor_klant', 'status_opvragen', 'boek_uren', 'boek_materiaal', 'maak_concept_werkorder', 'maak_concept_offerte']);
  const userId = (await installer.get('/app/api/me')).body.user.id;
  // Planner: geen offertes en geen klanten in de app, dus ook niet via de AI (hetzelfde token).
  assert.strictEqual((await admin.patch(`/app/api/admin/users/${userId}`, { role: 'planner' })).status, 200);
  assert.deepStrictEqual(await toolNames(), ['zoek_artikelen', 'status_opvragen', 'boek_uren', 'boek_materiaal', 'maak_concept_werkorder']);
  for (const [name, args] of [['zoek_klant', { zoekterm: 'Klant' }], ['maak_klant', { naam: 'Nieuw' }], ['maak_concept_offerte', { regels: [{ omschrijving: 'x', aantal: 1 }] }]]) {
    assert.strictEqual((await callTool(base, connection.accessToken, name, args)).isError, true, name);
  }
  // Een rol van het soort klant: de koppeling werkt helemaal niet meer (alleen intern).
  assert.strictEqual((await admin.patch(`/app/api/admin/users/${userId}`, { role: 'klant' })).status, 200);
  assert.strictEqual((await mcp(base, connection.accessToken, { method: 'ping' })).status, 401);
  // Als klant ziet hij de lijst niet, maar intrekken van een eigen oude koppeling mag wel.
  assert.strictEqual((await installer.get('/app/api/account/connections')).status, 403);
  assert.strictEqual((await installer.del(`/app/api/account/connections/${spareId}`)).status, 200);
  // Terug naar installateur: de gebruikte toestemming is ingetrokken, dus opnieuw koppelen geeft de rechten terug.
  assert.strictEqual((await admin.patch(`/app/api/admin/users/${userId}`, { role: 'installateur' })).status, 200);
  assert.strictEqual((await mcp(base, connection.accessToken, { method: 'ping' })).status, 401);
  assert.strictEqual((await mcp(base, spare.accessToken, { method: 'ping' })).status, 401);
  const again = await connect(base, installer);
  assert.strictEqual((await callTool(base, again.accessToken, 'zoek_klant', { zoekterm: 'Klant' })).isError, false);
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
  // Ook de leesfuncties zien niets van de andere organisatie: geen klantkaart, geen prijs, geen status en geen debiteuren.
  const mainAdmin = await as('baas');
  const mainConnection = await connect(base, mainAdmin);
  const mainQuote = (await callTool(base, mainConnection.accessToken, 'maak_concept_offerte', { klantId: ownCustomer.id, regels: [{ artikelcode: 'PE-25', aantal: 1 }] })).structuredContent;
  assert.strictEqual((await callTool(base, connection.accessToken, 'klant_details', { klantId: ownCustomer.id })).isError, true);
  assert.strictEqual((await callTool(base, connection.accessToken, 'prijs_voor_klant', { klantId: ownCustomer.id, artikelen: [{ artikelcode: 'PE-25' }] })).isError, true);
  assert.strictEqual((await callTool(base, connection.accessToken, 'status_opvragen', { soort: 'offerte', nummer: mainQuote.nummer })).isError, true);
  assert.strictEqual((await callTool(base, connection.accessToken, 'openstaande_debiteuren', {})).structuredContent.aantalDebiteuren, 0);
  // Een token van de ene organisatie met de omgeving van een andere erin geplakt werkt niet.
  const swapped = connection.accessToken.replace(/^aqt_at_[^.]+/, `aqt_at_${main}`);
  assert.strictEqual((await mcp(base, swapped, { method: 'ping' })).status, 401);
  // De koppeling van de andere organisatie is voor een beheerder hier onzichtbaar en niet in te trekken (404).
  const admin = await as('baas');
  const foreignGrant = (await outsider.get('/app/api/account/connections')).body.items[0].id;
  assert.ok(!(await admin.get('/app/api/account/connections')).body.items.some((item) => item.id === foreignGrant));
  assert.strictEqual((await admin.del(`/app/api/account/connections/${foreignGrant}`)).status, 404);
  assert.strictEqual((await mcp(base, connection.accessToken, { method: 'ping' })).status, 200);
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
  assert.strictEqual(daysLate('2026-01-01', '2026-01-11'), 10);
  assert.strictEqual(daysLate('2026-02-01', '2026-01-11'), 0);
  assert.strictEqual(daysLate('', '2026-01-11'), 0);
  assert.deepStrictEqual(numberCandidates(' of-2026-0001 '), ['of-2026-0001', 'OF-2026-0001']);
  assert.deepStrictEqual(numberCandidates('\u0000'), []);
  assert.deepStrictEqual(parseScope(''), ['klanten.lezen', 'klanten.aanmaken', 'artikelen.lezen', 'offertes.concept', 'werkorders.concept', 'werkregistratie.boeken', 'status.lezen', 'facturen.lezen']);
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

test('maak_concept_werkorder: nieuwe werkorder zonder offerte, vraagt terug bij open punten en zet niets in te plannen', async () => {
  const { base, admin, installer } = await setup();
  const { accessToken } = await connect(base, admin);
  const customer = (await callTool(base, accessToken, 'maak_klant', { naam: 'Jan Tuinman', postcode: '8071 AB', huisnummer: '1' })).structuredContent;
  // Open punten: onbekend artikel en een artikel met varianten leiden tot terugvragen; er wordt niets aangemaakt.
  await admin.post('/app/api/stock/items', { code: 'SLANG-X', name: 'Druppelslang', unit: 'm', salePrice: 2, vatRate: 21, onHand: 10 });
  const asked = await callTool(base, accessToken, 'maak_concept_werkorder', { klantId: customer.id, titel: 'Winterklaar', materiaal: [{ artikelcode: 'VERZONNEN-9', aantal: 1 }] });
  assert.strictEqual(asked.isError, false);
  assert.strictEqual(asked.structuredContent.status, 'terugvragen');
  assert.strictEqual(asked.structuredContent.aangemaakt, false);
  assert.strictEqual((await admin.get('/app/api/workorders')).body.items.length, 0);
  const noCustomer = await callTool(base, accessToken, 'maak_concept_werkorder', { titel: 'Zonder klant' });
  assert.strictEqual(noCustomer.structuredContent.status, 'terugvragen');
  // Ongeldige invoer is een fout, geen terugvraag.
  assert.strictEqual((await callTool(base, accessToken, 'maak_concept_werkorder', { klantId: customer.id, titel: 'x', materiaal: [{ artikelcode: 'PE-25', aantal: -2 }] })).isError, true);
  assert.strictEqual((await callTool(base, accessToken, 'maak_concept_werkorder', { klantId: customer.id, titel: '   ' })).isError, true);
  assert.strictEqual((await callTool(base, accessToken, 'maak_concept_werkorder', { klantId: 'bestaat-niet', titel: 'x' })).isError, true);
  // Goede invoer: werkorder met status Nieuw, adres van de klant, stappen en gereserveerd materiaal.
  const made = await callTool(base, accessToken, 'maak_concept_werkorder', {
    klantId: customer.id, titel: 'Winterklaar maken', instructies: 'Leidingen leegblazen.',
    stappen: [{ titel: 'Leidingen leegblazen', uren: 1.5 }, { titel: 'Computer afkoppelen' }],
    materiaal: [{ artikelcode: 'pe-25', aantal: 10 }],
  });
  assert.strictEqual(made.isError, false, JSON.stringify(made));
  const result = made.structuredContent;
  assert.strictEqual(result.status, 'open');
  assert.match(result.nummer, /^WO-\d{4}-\d{4}$/);
  assert.strictEqual(result.stappen, 2);
  assert.strictEqual(result.materiaalregels, 1);
  const order = (await admin.get(`/app/api/workorders/${result.werkorderId}`)).body;
  assert.strictEqual(order.status, 'open');
  assert.strictEqual(order.plannedDate || '', '');
  assert.strictEqual(order.assigneeId || null, null);
  assert.strictEqual(order.data.customer.name, 'Jan Tuinman');
  assert.match(order.data.customer.address, /Tuinstraat 1/);
  assert.deepStrictEqual(order.data.steps.map((step) => [step.title, step.hours]), [['Leidingen leegblazen', 1.5], ['Computer afkoppelen', 0]]);
  assert.deepStrictEqual(order.data.materials.map((material) => [material.code, material.qty, material.unit]), [['PE-25', 10, 'm']]);
  assert.match(order.data.internalNote, /AI-koppeling/);
  const reserved = await admin.get(`/app/api/stock/workorders/${result.werkorderId}`);
  assert.strictEqual(reserved.status, 200);
  assert.ok(JSON.stringify(reserved.body).includes('PE-25'));
  // Met open punten bewust doorgaan: het onbekende artikel staat als notitie, niet op de werkorder.
  const forced = await callTool(base, accessToken, 'maak_concept_werkorder', { klantId: customer.id, titel: 'Met open punt', materiaal: [{ artikelcode: 'VERZONNEN-9', aantal: 1 }], ookMetOpenPunten: true });
  assert.strictEqual(forced.isError, false);
  assert.strictEqual(forced.structuredContent.materiaalregels, 0);
  const forcedOrder = (await admin.get(`/app/api/workorders/${forced.structuredContent.werkorderId}`)).body;
  assert.match(forcedOrder.data.internalNote, /VERZONNEN-9/);
  // Een planner (recht werkorders, niet klanten) mag geen klantkaart overnemen via klantId, wel de klant als tekst opgeven.
  const viaInstaller = await connect(base, installer);
  assert.ok((await mcp(base, viaInstaller.accessToken, { method: 'tools/list' })).body.result.tools.some((tool) => tool.name === 'maak_concept_werkorder'));
  const plannerId = (await installer.get('/app/api/me')).body.user.id;
  assert.strictEqual((await admin.patch(`/app/api/admin/users/${plannerId}`, { role: 'planner' })).status, 200);
  const asPlanner = viaInstaller;
  const byId = await callTool(base, asPlanner.accessToken, 'maak_concept_werkorder', { klantId: customer.id, titel: 'Via id' });
  assert.strictEqual(byId.isError, true);
  assert.match(byId.structuredContent.fout, /klantgegevens/);
  const byName = await callTool(base, asPlanner.accessToken, 'maak_concept_werkorder', { klant: { naam: 'Los Persoon' }, titel: 'Via naam' });
  assert.strictEqual(byName.isError, false, JSON.stringify(byName));
  assert.strictEqual((await admin.patch(`/app/api/admin/users/${plannerId}`, { role: 'installateur' })).status, 200);
  // Een andere organisatie ziet de werkorder niet; de installateur met toestemming mag er ook een maken.
  const foreign = await createLogin(base, { password: PW, clientOptions: { followRedirects: false } })('vreemd', 'ander');
  assert.strictEqual((await foreign.get(`/app/api/workorders/${result.werkorderId}`)).status, 404);
  // Zonder de scope is de tool er niet.
  const narrow = await connect(base, admin, { scope: 'klanten.lezen' });
  const denied = await callTool(base, narrow.accessToken, 'maak_concept_werkorder', { klantId: customer.id, titel: 'x' });
  assert.strictEqual(denied.isError, true);
  assert.match(denied.structuredContent.fout, /toestemming/);
});

test('boek_uren en boek_materiaal: alleen op eigen naam, vraagt terug, voorraad en afgeronde werkorders volgen de app', async () => {
  const { base, admin, installer } = await setup();
  const boss = await connect(base, admin);
  const worker = await connect(base, installer);
  const customer = (await callTool(base, boss.accessToken, 'maak_klant', { naam: 'Piet Boeker', postcode: '8071 AB', huisnummer: '1' })).structuredContent;
  const order = (await callTool(base, boss.accessToken, 'maak_concept_werkorder', { klantId: customer.id, titel: 'Boeken testen' })).structuredContent;
  /**
   * De voorraad van een artikel volgens de app.
   * @param {string} code De artikelcode.
   * @returns {Promise<number>} De voorraad.
   */
  const stockOf = async (code) => (await admin.get('/app/api/stock')).body.items.find((item) => item.code === code).onHand;
  const before = await stockOf('PE-25');
  const hours = await callTool(base, worker.accessToken, 'boek_uren', { werkorderNummer: order.nummer.toLowerCase(), uren: 2.5, notitie: 'Sleuf graven' });
  assert.strictEqual(hours.isError, false, JSON.stringify(hours));
  assert.strictEqual(hours.structuredContent.geboekt, true);
  assert.strictEqual(hours.structuredContent.uren, 2.5);
  assert.strictEqual(hours.structuredContent.totaalUrenOpWerkorder, 2.5);
  const timed = await callTool(base, worker.accessToken, 'boek_uren', { werkorderNummer: order.nummer, begintijd: '08:00', eindtijd: '10:30', pauzeMinuten: 30, soort: 'reistijd' });
  assert.strictEqual(timed.structuredContent.uren, 2);
  assert.strictEqual(timed.structuredContent.totaalUrenOpWerkorder, 4.5);
  assert.strictEqual((await callTool(base, worker.accessToken, 'boek_uren', { werkorderNummer: order.nummer })).isError, true);
  assert.strictEqual((await callTool(base, worker.accessToken, 'boek_uren', { werkorderNummer: order.nummer, begintijd: '08:00', uren: 1 })).isError, true);
  assert.strictEqual((await callTool(base, worker.accessToken, 'boek_uren', { werkorderNummer: 'WO-1999-0001', uren: 1 })).isError, true);
  assert.strictEqual((await callTool(base, worker.accessToken, 'boek_uren', { werkorderNummer: order.nummer, uren: 1, datum: '2999-01-01' })).isError, true);
  const dubbel = await callTool(base, worker.accessToken, 'boek_uren', { werkorderNummer: order.nummer, uren: 2.5, notitie: 'Sleuf graven' });
  assert.strictEqual(dubbel.structuredContent.status, 'terugvragen');
  assert.strictEqual(dubbel.structuredContent.geboekt, false);
  assert.strictEqual((await callTool(base, worker.accessToken, 'boek_uren', { werkorderNummer: order.nummer, uren: 2.5, ookAlsHetDubbelLijkt: true })).structuredContent.geboekt, true);
  const log = (await installer.get(`/app/api/workorders/${order.werkorderId}/worklog`)).body;
  assert.strictEqual(log.hours.length, 3);
  assert.ok(log.hours.every((entry) => entry.user.displayName === 'Monteur'));
  const material = await callTool(base, worker.accessToken, 'boek_materiaal', { werkorderNummer: order.nummer, artikelcode: 'pe-25', aantal: 12 });
  assert.strictEqual(material.isError, false, JSON.stringify(material));
  assert.strictEqual(material.structuredContent.geboekt, true);
  assert.strictEqual(material.structuredContent.eenheid, 'm');
  assert.strictEqual(await stockOf('PE-25'), before - 12);
  assert.strictEqual((await callTool(base, worker.accessToken, 'boek_materiaal', { werkorderNummer: order.nummer, artikelcode: 'VERZONNEN', aantal: 1 })).structuredContent.status, 'terugvragen');
  assert.strictEqual((await callTool(base, worker.accessToken, 'boek_materiaal', { werkorderNummer: order.nummer, artikelcode: 'PE-25', aantal: 12 })).structuredContent.status, 'terugvragen');
  assert.strictEqual(await stockOf('PE-25'), before - 12);
  assert.strictEqual((await callTool(base, worker.accessToken, 'boek_materiaal', { werkorderNummer: order.nummer, artikelcode: 'PE-25', aantal: -3 })).isError, true);
  // Zonder de scope is de tool er niet (een andere organisatie komt niet bij deze nummers: findWorkOrder filtert op de omgeving).
  const narrow = await connect(base, admin, { scope: 'klanten.lezen' });
  assert.match((await callTool(base, narrow.accessToken, 'boek_uren', { werkorderNummer: order.nummer, uren: 1 })).structuredContent.fout, /toestemming/);
  // Afgeronde werkorder: een rol zonder recht planning niet, de beheerder wel.
  assert.strictEqual((await admin.put(`/app/api/workorders/${order.werkorderId}`, { status: 'gereed' })).status, 200);
  assert.strictEqual((await admin.post('/app/api/admin/roles', { label: 'Alleen uitvoeren', rights: ['werkorders'] })).status, 201);
  const workerId = (await installer.get('/app/api/me')).body.user.id;
  assert.strictEqual((await admin.patch(`/app/api/admin/users/${workerId}`, { role: 'alleen-uitvoeren' })).status, 200);
  const locked = await callTool(base, worker.accessToken, 'boek_uren', { werkorderNummer: order.nummer, uren: 1 });
  assert.strictEqual(locked.isError, true);
  assert.match(locked.structuredContent.fout, /afgerond/);
  assert.strictEqual((await callTool(base, boss.accessToken, 'boek_uren', { werkorderNummer: order.nummer, uren: 1 })).structuredContent.geboekt, true);
});
