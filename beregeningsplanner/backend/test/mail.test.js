// E-mailinstellingen in Beheer: SMTP of Exchange Online-connector, en het
// WAN-IP van de server voor de connector.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createMailer, sanitizeMail } = require('../src/platform/mailer');
const { createWanIp } = require('../src/platform/wan-ip');

const SECRET = 'test-secret-mail-0123456789abcdef';

function client(base) {
  const jar = new Map();
  async function call(method, p, body) {
    const headers = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (kv.slice(i + 1)) jar.set(kv.slice(0, i), kv.slice(i + 1)); else jar.delete(kv.slice(0, i));
    }
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { /* geen JSON */ }
    return { status: res.status, body: json };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
}

test('WAN-IP: omgeving gaat voor, opzoeken met terugval, onthouden en alleen openbaar IPv4', async () => {
  let t = 1_000_000;
  const calls = [];
  const answers = { a: 'geen ip', b: '203.0.113.9', c: '93.184.215.14\n' };
  const fetch = async (url) => { calls.push(url); if (url === 'x') throw new Error('weg'); return answers[url]; };
  const wan = createWanIp({ fetch, env: {}, now: () => t, sources: ['x', 'a', 'b', 'c'] });
  const first = await wan.get();
  assert.strictEqual(first.ip, '93.184.215.14', 'ongeldig en documentatieadres overgeslagen');
  assert.strictEqual(first.source, 'opgezocht');
  assert.deepStrictEqual(calls, ['x', 'a', 'b', 'c']);
  t += 30_000;
  await wan.get({ refresh: true });
  assert.strictEqual(calls.length, 4, 'niet vaker dan eens per minuut opnieuw');
  t += 60_000;
  await wan.get({ refresh: true });
  assert.strictEqual(calls.length, 8);
  assert.strictEqual((await createWanIp({ fetch, env: { WAN_IP: '8.8.4.4' } }).get()).source, 'omgeving');
  await assert.rejects(createWanIp({ fetch: async () => '192.168.2.251', env: {} }).get(), { code: 'unavailable' });
});

test('mailer: Exchange-connector zonder inlog, met verplichte TLS', async () => {
  const conf = sanitizeMail({ mode: 'connector', host: 'bedrijf-nl.mail.protection.outlook.com', port: 25, user: 'blijft-leeg', from: 'info@bedrijf.nl' });
  assert.strictEqual(conf.mode, 'connector');
  assert.strictEqual(conf.user, '');
  assert.strictEqual(sanitizeMail({ mode: 'iets' }).mode, 'smtp');
  let used = null;
  const settings = { get: (k) => (k === 'mailServer' ? { ...conf, user: 'x' } : 'wachtwoord') };
  const mailer = createMailer(settings, { resolveHost: async () => '52.101.1.1', createTransport: (o) => { used = o; return { sendMail: async () => ({}) }; } });
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
  const mailerFor = (settings) => createMailer(settings, { resolveHost: async (h) => h, createTransport: (o) => ({ sendMail: async (m) => { sent.push({ ...m, auth: o.auth }); return {}; } }) });
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db, wanIp, mailerFor }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username) => {
    const c = client(base);
    assert.strictEqual((await c.post('/api/auth/login', { username, password: 'Tuin-Plan-2026!' })).status, 200);
    return c;
  };
  try {
    const baas = await as('baas'), kees = await as('kees');
    assert.strictEqual((await client(base).get('/api/admin/wan-ip')).status, 401);
    assert.strictEqual((await kees.get('/api/admin/wan-ip')).status, 403);
    assert.strictEqual((await kees.put('/api/admin/mail', { config: { host: 'smtp.x' } })).status, 403);
    const ip = await baas.get('/api/admin/wan-ip');
    assert.strictEqual(ip.status, 200);
    assert.strictEqual(ip.body.ip, '93.184.215.14');
    await baas.get('/api/admin/wan-ip');
    assert.strictEqual(lookups, 1, 'onthouden');

    const put = await baas.put('/api/admin/mail', { config: { mode: 'smtp', host: 'smtp.bedrijf.nl', port: 587, user: 'info', from: 'info@bedrijf.nl' }, password: 'geheim-wachtwoord' });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.passwordSet, true);
    assert.ok(!JSON.stringify(put.body).includes('geheim-wachtwoord'));
    assert.ok(!JSON.stringify((await baas.get('/api/admin/settings')).body).includes('geheim-wachtwoord'));

    const conn = await baas.put('/api/admin/mail', { config: { mode: 'connector', host: 'bedrijf-nl.mail.protection.outlook.com', port: 25, from: 'info@bedrijf.nl' } });
    assert.strictEqual(conn.body.config.mode, 'connector');
    assert.strictEqual(conn.body.config.user, '');
    assert.strictEqual((await baas.post('/api/admin/mail/test', { to: 'info@bedrijf.nl' })).status, 200);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].auth, undefined);
  } finally {
    server.close();
  }
});
