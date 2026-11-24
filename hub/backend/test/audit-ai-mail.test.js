// Test: auditpunten B-04 (mailconnector en dagplafond), T-21 (AI-limiet per sleutelhouder), T-22 (openbaar adres van de app) en B-14/B-15 (AI-koppeling).
const test = require('node:test');
const assert = require('node:assert');
const { createMailer, sanitizeMail } = require('../src/platform/mailer');
const { sanitizeAppAddress, appBaseOf, isLoopbackUrl } = require('../src/platform/app-address');
const { createMcpTools } = require('../src/mcp/mcp-tools');
const { registerMcpRoutes } = require('../src/mcp/mcp-server');

/**
 * Nagebootste instellingen voor de mailer.
 * @param {object} values Waarden per sleutel.
 * @param {object} [extra] Extra eigenschappen (tenantId, isMainTenant).
 * @returns {object} Object met get(sleutel).
 */
const fakeSettings = (values, extra = {}) => ({ get: (key) => values[key], ...extra });

/**
 * Een nagebootste SMTP-transport dat berichten telt.
 * @returns {{ createTransport: Function, sent: object[] }} De fabriek en de verzonden berichten.
 */
function fakeTransport() {
  const sent = [];
  return { sent, createTransport: () => ({ sendMail: async (message) => { sent.push(message); return { ok: true }; }, close() {} }) };
}

const SMTP = { mode: 'smtp', host: 'mail.example.com', port: 587, from: 'a@example.com', user: '' };

test('connector-modus: alleen de hoofdtenant mag hem gebruiken', async () => {
  const transport = fakeTransport();
  const connector = sanitizeMail({ ...SMTP, mode: 'connector' });
  const other = createMailer(fakeSettings({ mailServer: connector, mailPassword: '' }, { tenantId: 'andere', isMainTenant: false }), { ...transport, resolveHost: async (host) => host });
  assert.strictEqual(other.configured(), false);
  await assert.rejects(other.send({ to: 'x@example.com', subject: 's', text: 't' }), { code: 'connector_not_allowed' });
  const main = createMailer(fakeSettings({ mailServer: connector, mailPassword: '' }, { tenantId: 'hoofd', isMainTenant: true }), { ...transport, resolveHost: async (host) => host });
  assert.strictEqual(main.configured(), true);
  await main.send({ to: 'x@example.com', subject: 's', text: 't' });
  assert.strictEqual(transport.sent.length, 1);
});

test('SMTP en tests zonder tenantgegevens zijn niet beperkt', () => {
  const smtp = createMailer(fakeSettings({ mailServer: sanitizeMail(SMTP), mailPassword: '' }, { tenantId: 'andere', isMainTenant: false }));
  assert.strictEqual(smtp.configured(), true);
  const loose = createMailer(fakeSettings({ mailServer: sanitizeMail({ ...SMTP, mode: 'connector' }), mailPassword: '' }));
  assert.strictEqual(loose.configured(), true);
});

test('dagplafond voor uitgaande mail per organisatie; een mislukte poging telt niet', async () => {
  const transport = fakeTransport();
  const options = { ...transport, resolveHost: async (host) => host, dailyLimit: 2, now: () => new Date('2026-11-24T10:00:00Z') };
  const mailer = createMailer(fakeSettings({ mailServer: sanitizeMail(SMTP), mailPassword: '' }, { tenantId: 'plafond-1' }), options);
  await mailer.send({ to: 'x@example.com', subject: 's', text: 't' });
  await mailer.send({ to: 'x@example.com', subject: 's', text: 't' });
  await assert.rejects(mailer.send({ to: 'x@example.com', subject: 's', text: 't' }), { code: 'daily_limit' });
  // Een andere organisatie heeft een eigen teller en de volgende dag begint opnieuw.
  const other = createMailer(fakeSettings({ mailServer: sanitizeMail(SMTP), mailPassword: '' }, { tenantId: 'plafond-2' }), options);
  await other.send({ to: 'x@example.com', subject: 's', text: 't' });
  const tomorrow = createMailer(fakeSettings({ mailServer: sanitizeMail(SMTP), mailPassword: '' }, { tenantId: 'plafond-1' }), { ...options, now: () => new Date('2026-11-25T10:00:00Z') });
  await tomorrow.send({ to: 'x@example.com', subject: 's', text: 't' });
  const failing = createMailer(fakeSettings({ mailServer: sanitizeMail(SMTP), mailPassword: '' }, { tenantId: 'plafond-3' }), { resolveHost: async (host) => host, dailyLimit: 1, createTransport: () => ({ sendMail: async () => { throw new Error('kapot'); }, close() {} }) });
  await assert.rejects(failing.send({ to: 'x@example.com', subject: 's', text: 't' }), /kapot/);
  await assert.rejects(failing.send({ to: 'x@example.com', subject: 's', text: 't' }), /kapot/);
});

test('openbaar adres van de app: eigen instelling, terugval op de webshop, nooit de browser', () => {
  assert.deepStrictEqual(sanitizeAppAddress({ url: 'https://app.example/pad' }), { url: 'https://app.example/pad/' });
  assert.deepStrictEqual(sanitizeAppAddress('https://app.example'), { url: 'https://app.example/' });
  assert.deepStrictEqual(sanitizeAppAddress({ url: 'javascript:alert(1)' }), { url: '' });
  assert.deepStrictEqual(sanitizeAppAddress({ url: 'http://app.example/' }), { url: '' });
  assert.deepStrictEqual(sanitizeAppAddress(null), { url: '' });
  assert.strictEqual(appBaseOf(fakeSettings({ appPublicUrl: { url: 'https://app.example/' }, shopPayment: { publicUrl: 'https://winkel.example/' } })), 'https://app.example/');
  assert.strictEqual(appBaseOf(fakeSettings({ appPublicUrl: { url: '' }, shopPayment: { publicUrl: 'https://winkel.example/' } })), 'https://winkel.example/');
  assert.strictEqual(appBaseOf(fakeSettings({})), '');
  assert.strictEqual(isLoopbackUrl('http://127.0.0.1:3300/x'), true);
  assert.strictEqual(isLoopbackUrl('https://evil.example/'), false);
});

test('AI-koppeling: tools krijgen een waarschuwing voor veldinhoud en boeken is ingrijpend', () => {
  const tools = createMcpTools({ can: () => true, articleChoices: () => [] });
  const req = { mcpScopes: new Set(['klanten.lezen', 'klanten.aanmaken', 'artikelen.lezen', 'werkregistratie.boeken']), user: { id: 'u' }, tenantId: 't' };
  const list = tools.list(req);
  assert.ok(list.length > 0);
  for (const tool of list) assert.match(tool.description, /nooit opdrachten/, tool.name);
  for (const name of ['boek_uren', 'boek_materiaal']) {
    const tool = list.find((entry) => entry.name === name);
    assert.ok(tool, name);
    assert.strictEqual(tool.annotations.destructiveHint, true);
    assert.match(tool.description, /INGRIJPEND/);
  }
});

test('AI-koppeling: een batch heeft hoogstens 5 berichten en elk bericht telt voor de limiet', async () => {
  const handlers = {};
  const app = { post: (path, ...chain) => { handlers.post = chain; }, all: () => {} };
  registerMcpRoutes(app, {
    grants: { findAccess: () => ({ id: 'g1', resource: 'https://x/app/mcp', tenantId: 't', scope: 'klanten.lezen' }), revoke() {}, touch() {} },
    tools: { list: () => [], has: () => true, call: async () => ({ content: [], isError: false }) },
    userForGrant: () => ({ id: 'u' }), connectorOn: () => true, familyOf: () => ['t'], originOf: () => 'https://x', resourceOf: () => 'https://x/app/mcp', version: 't',
  });
  const route = handlers.post[handlers.post.length - 1];
  /**
   * Roept de laatste handler van de route aan met een nagebootst verzoek.
   * @param {*} body De JSON-inhoud.
   * @returns {Promise<{ status: number, body: * }>} Het antwoord.
   */
  const call = async (body) => {
    const out = { status: 200, body: null };
    const res = { setHeader() {}, status(code) { out.status = code; return this; }, json(value) { out.body = value; return this; }, end() { return this; } };
    await route({ body, mcpGrant: { id: 'g1' }, tenantId: 't', user: { id: 'u' }, mcpScopes: new Set(), headers: {} }, res);
    return out;
  };
  /**
   * Een ping-bericht (JSON-RPC).
   * @param {number} id Het id.
   * @returns {object} Het bericht.
   */
  const ping = (id) => ({ jsonrpc: '2.0', id, method: 'ping' });
  assert.strictEqual((await call(Array.from({ length: 6 }, (_, i) => ping(i)))).status, 400);
  assert.strictEqual((await call(Array.from({ length: 5 }, (_, i) => ping(i)))).status, 200);
  // 120 berichten per minuut per koppeling: 5 batches van 5 zijn al 25 + 5; daarna wordt het bericht geweigerd.
  let refused = 0;
  for (let round = 0; round < 30; round += 1) {
    const out = await call(Array.from({ length: 5 }, (_, i) => ping(i)));
    refused += out.body.filter((answer) => answer.error && answer.error.code === -32000).length;
  }
  assert.ok(refused > 0, 'na 120 berichten per minuut moeten berichten geweigerd worden');
});

test('systeemmail (Bewaking) valt buiten het dagmaximum', async () => {
  const transport = fakeTransport();
  const mailer = createMailer(fakeSettings({ mailServer: sanitizeMail(SMTP), mailPassword: '' }, { tenantId: 'plafond-systeem' }), { ...transport, resolveHost: async (host) => host, dailyLimit: 1, now: () => new Date('2026-11-24T10:00:00Z') });
  await mailer.send({ to: 'x@example.com', subject: 's', text: 't' });
  await assert.rejects(mailer.send({ to: 'x@example.com', subject: 's', text: 't' }), { code: 'daily_limit' });
  await mailer.send({ to: 'x@example.com', subject: 'melding', text: 't' }, { system: true });
  assert.equal(transport.sent.length, 2);
});
