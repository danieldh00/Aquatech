// Beveiliging van de opslag: versleuteling, sessies, wachtwoorden, auditlog,
// bewaartermijnen en headers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../src/server');
const { openDb, openSqlite } = require('../src/database/db');
const PG = Boolean(process.env.TEST_DATABASE_URL); // testsuite tegen PostgreSQL

const { createStore, passwordProblem, hashPassword, verifyPassword, needsRehash } = require('../src/platform/store');
const { createSettings } = require('../src/platform/settings');
const { createVault, loadOrCreateMasterKey } = require('../src/beveiliging/vault');
const { createClient, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Start een testserver; standaard met hoofdbeheerder 'baas' (zoals na het instelscherm).
 * @param {{ db?: object, noAdmin?: boolean }} [opts] Eigen database, noAdmin: zonder beheerder; de rest gaat naar createApp.
 * @returns {Promise<object>} app, db, store, server en base.
 */
async function start(opts = {}) {
  const db = opts.db || openDb();
  const store = createStore(db);
  // Zoals na het instelscherm: de eerste beheerder is hoofdbeheerder.
  if (!opts.noAdmin) await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const app = createApp({ secret: SECRET, db, ...opts });
  return { app, db, store, ...(await listen(app)) };
}

test('vault: versleutelen met context, geknoei en verkeerde context worden geweigerd', () => {
  const vault = createVault(crypto.randomBytes(32));
  const sealed = vault.seal('geheim', 't:veld');
  assert.ok(vault.isSealed(sealed));
  assert.notStrictEqual(sealed, vault.seal('geheim', 't:veld'), 'elke keer een nieuwe IV');
  assert.strictEqual(vault.open(sealed, 't:veld'), 'geheim');
  assert.throws(() => vault.open(sealed, 't:ander'));
  const [version, iv, tag, ciphertext] = sealed.split(':');
  const flipped = Buffer.from(ciphertext, 'base64url');
  flipped[0] ^= 1;
  assert.throws(() => vault.open([version, iv, tag, flipped.toString('base64url')].join(':'), 't:veld'));
});

test('hoofdsleutel: uit de omgeving, of eenmalig aangemaakt in de datamap (0600)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-key-'));
  try {
    const first = loadOrCreateMasterKey(dir, {});
    assert.strictEqual(first.key.length, 32);
    assert.strictEqual(fs.statSync(path.join(dir, 'master-key')).mode & 0o777, 0o600);
    assert.ok(loadOrCreateMasterKey(dir, {}).key.equals(first.key));
    const hex = crypto.randomBytes(32).toString('hex');
    assert.strictEqual(loadOrCreateMasterKey(dir, { AQUATECH_MASTER_KEY: hex }).key.toString('hex'), hex);
    fs.writeFileSync(path.join(dir, 'secret'), `${hex}\n`);
    assert.strictEqual(loadOrCreateMasterKey(dir, { AQUATECH_MASTER_KEY_FILE: path.join(dir, 'secret') }).key.toString('hex'), hex);
    assert.throws(() => loadOrCreateMasterKey(dir, { AQUATECH_MASTER_KEY: 'te-kort' }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('onversleutelde geheimen van een oudere versie worden bij de start versleuteld', () => {
  const db = openDb();
  const tenant = createStore(db).ensureTenant();
  db.prepare("INSERT INTO settings (tenant_id, key, value, updated_at) VALUES (?, 'accessCode', ?, 'nu')").run(tenant.id, JSON.stringify('oude-code'));
  const vault = createVault(crypto.randomBytes(32));
  assert.strictEqual(createSettings({ db, tenantId: tenant.id, vault }).get('accessCode'), 'oude-code');
  const raw = db.prepare("SELECT value FROM settings WHERE key = 'accessCode'").get().value;
  assert.doesNotMatch(raw, /oude-code/);
  assert.ok(vault.isSealed(JSON.parse(raw).enc));
});

test('databasebestand alleen leesbaar voor de eigenaar', { skip: PG && 'alleen SQLite' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-perm-'));
  try {
    const file = path.join(dir, 'aquatech.db');
    openDb(file).close();
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wachtwoordbeleid en sterkere hash met automatische upgrade', async () => {
  assert.match(passwordProblem('kort'), /12 tekens/);
  assert.match(passwordProblem('Wachtwoord2024!'), /voorspelbaar/);
  assert.match(passwordProblem('aaaaaaaaaaaaaa'), /voorspelbaar/);
  assert.match(passwordProblem('jan.devries-2026', 'jan.devries'), /gebruikersnaam/);
  assert.strictEqual(passwordProblem('paard batterij nietje'), null);
  const hash = await hashPassword(PW);
  assert.match(hash, /^scrypt\$131072\$8\$1\$/);
  assert.ok(await verifyPassword(PW, hash));
  assert.ok(!(await verifyPassword('fout', hash)));

  // Een oude (lichtere) hash werkt nog en wordt bij het inloggen vervangen.
  const db = openDb();
  const store = createStore(db);
  const tenant = store.ensureTenant();
  const { user } = await store.createAccount(tenant.id, { username: 'oud', role: 'gebruiker', password: PW });
  const salt = crypto.randomBytes(16);
  const old = `scrypt$16384$8$1$${salt.toString('base64url')}$${crypto.scryptSync(PW, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64url')}`;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(old, user.id);
  assert.ok(await store.authenticate(tenant.id, 'oud', PW));
  assert.ok(!needsRehash(store.getUser(user.id).password_hash));
});

test('sessies staan op de server: uitloggen en intrekken werkt meteen; token alleen als hash', async () => {
  const { server, base, db } = await start();
  try {
    const baas = createClient(base, { emptyJsonBody: false });
    assert.strictEqual((await baas.post('/api/auth/login', { username: 'baas', password: PW })).status, 200);
    const token = baas.jar.get('aquatech_session');
    assert.ok(token && token.length >= 40);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?').get(token).n, 0, 'geen leesbaar token in de database');
    assert.strictEqual((await baas.get('/api/admin/users')).status, 200);

    // Uitloggen: een gekopieerde cookie werkt daarna ook niet meer.
    const stolen = createClient(base, { emptyJsonBody: false });
    stolen.jar.set('aquatech_session', token);
    await baas.post('/api/auth/logout');
    assert.strictEqual((await stolen.get('/api/admin/users')).status, 401);

    // Beheerder logt iemand op alle toestellen uit.
    const admin = createClient(base, { emptyJsonBody: false });
    await admin.post('/api/auth/login', { username: 'baas', password: PW });
    const jan = (await admin.post('/api/admin/users', { username: 'jan', role: 'gebruiker', password: 'Gras-Pomp-2027!', mustChangePassword: false })).body;
    const j = createClient(base, { emptyJsonBody: false });
    await j.post('/api/auth/login', { username: 'jan', password: 'Gras-Pomp-2027!' });
    assert.ok((await j.get('/api/me')).body.user);
    assert.strictEqual((await admin.get('/api/admin/users')).body.items.find((user) => user.id === jan.id).sessionCount, 1);
    assert.strictEqual((await admin.post(`/api/admin/users/${jan.id}/logout`)).body.revoked, 1);
    assert.strictEqual((await j.get('/api/me')).body.user, null);
  } finally {
    server.close();
  }
});

test('sessie verloopt na de ingestelde dagen zonder gebruik', async () => {
  const { server, base, db } = await start();
  try {
    const baas = createClient(base, { emptyJsonBody: false });
    await baas.post('/api/auth/login', { username: 'baas', password: PW });
    const old = new Date(Date.now() - 15 * 86400000).toISOString();
    db.prepare('UPDATE sessions SET last_seen_at = ?').run(old);
    assert.strictEqual((await baas.get('/api/me')).body.user, null);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'verlopen sessie opgeruimd');
  } finally {
    server.close();
  }
});

test('blokkade per gebruikersnaam na herhaald mislukt inloggen, met auditlog', async () => {
  const { server, base } = await start();
  try {
    // Elke poging van een ander "IP" is hier niet na te bootsen; de limiet per
    // IP (10) en per gebruiker (10) vallen samen, dus de 11e is 429.
    const baas = createClient(base, { emptyJsonBody: false });
    for (let i = 0; i < 10; i++) assert.strictEqual((await baas.post('/api/auth/login', { username: 'baas', password: 'fout' })).status, 401);
    assert.strictEqual((await baas.post('/api/auth/login', { username: 'baas', password: PW })).status, 429);
  } finally {
    server.close();
  }
  const s2 = await start();
  try {
    const admin = createClient(s2.base, { emptyJsonBody: false });
    await admin.post('/api/auth/login', { username: 'baas', password: 'fout-fout-fout' });
    await admin.post('/api/auth/login', { username: 'baas', password: PW });
    await admin.put('/api/admin/settings', { sessionIdleDays: 7 });
    const { items } = (await admin.get('/api/admin/audit')).body;
    const actions = items.map((x) => x.action);
    assert.deepStrictEqual(actions.slice(0, 3), ['instellingen_gewijzigd', 'ingelogd', 'inloggen_mislukt']);
    assert.ok(!JSON.stringify(items).includes(PW), 'geen wachtwoorden in het auditlog');
    assert.strictEqual((await createClient(s2.base, { emptyJsonBody: false }).get('/api/admin/audit')).status, 401);
  } finally {
    s2.server.close();
  }
});

test('bewaartermijnen: oude IP-adressen gewist, oude auditregels verwijderd', async () => {
  const db = openDb();
  const store = createStore(db);
  const tenant = store.ensureTenant();
  const { user } = await store.createAccount(tenant.id, { username: 'piet', role: 'gebruiker', password: PW });
  store.savePlan(user, null, { areas: [], meta: { name: 'Tuin', customer: 'Klant' } }, '10.0.0.1');
  store.audit({ tenantId: tenant.id, userId: user.id, action: 'ingelogd', ip: '10.0.0.1' });
  const long = new Date(Date.now() - 400 * 86400000).toISOString();
  db.prepare('UPDATE history SET updated_at = ?').run(long);
  db.prepare('UPDATE audit SET created_at = ?').run(long);
  const removed = store.applyRetention(tenant.id, { ipDays: 90, auditDays: 365 });
  assert.strictEqual(removed.historyIps, 1);
  assert.strictEqual(removed.audit, 1);
  assert.strictEqual(db.prepare('SELECT ip FROM history').get().ip, '');
});

test('installatiecode is nodig voor het eerste beheerdersaccount', async () => {
  const { server, base, app } = await start({ noAdmin: true });
  try {
    const code = app.locals.setupCode;
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const client = createClient(base, { emptyJsonBody: false });
    assert.strictEqual((await client.post('/api/setup', { username: 'daniel', password: PW })).status, 401);
    assert.strictEqual((await client.post('/api/setup', { username: 'daniel', password: PW, code: code.toLowerCase() })).status, 201);
  } finally {
    server.close();
  }
});

test('beveiligingsheaders op pagina’s en API', async () => {
  const { server, base } = await start();
  try {
    for (const urlPath of ['/', '/api/health']) {
      const res = await fetch(base + urlPath);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /object-src 'none'/);
      assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
      assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.strictEqual((await fetch(`${base}/api/health`)).headers.get('cache-control'), 'no-store');
    const https = await fetch(`${base}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(https.headers.get('strict-transport-security'), /max-age=/);
  } finally {
    server.close();
  }
});

test('versleutelde back-up: onleesbaar zonder sleutel, terug te zetten met sleutel', async () => {
  const { createBackup, listBackups, pruneBackups, decryptFile, keyOf } = require('../src/backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-bk-'));
  try {
    const db = openDb();
    const store = createStore(db);
    const tenant = store.ensureTenant();
    const { user } = await store.createAccount(tenant.id, { username: 'piet', role: 'gebruiker', password: PW });
    store.savePlan(user, null, { areas: [], meta: { name: 'Tuin', customer: 'Familie Jansen' } }, '');
    const vault = createVault(crypto.randomBytes(32));
    const backup = await createBackup({ db, dir, vault });
    assert.deepStrictEqual(listBackups(dir).map((x) => x.name), [backup.name]);
    assert.strictEqual(fs.statSync(path.join(dir, backup.name)).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(path.join(dir, backup.name)).includes('Familie Jansen'), 'versleuteld');
    assert.deepStrictEqual(fs.readdirSync(dir), [backup.name], 'geen tijdelijke bestanden over');

    const out = path.join(dir, 'terug.db');
    await decryptFile(path.join(dir, backup.name), out, keyOf(vault));
    const restored = openSqlite(out);
    assert.strictEqual(restored.prepare('SELECT customer FROM plans').get().customer, 'Familie Jansen');
    restored.close();

    await assert.rejects(decryptFile(path.join(dir, backup.name), path.join(dir, 'fout.db'), keyOf(createVault(crypto.randomBytes(32)))));
    assert.ok(!fs.existsSync(path.join(dir, 'fout.db')) && !fs.existsSync(path.join(dir, 'fout.db.part')));

    // Bewaartermijn: oude weg, de nieuwste blijft altijd.
    const old = path.join(dir, 'aquatech-20200101-000000.db.enc');
    fs.copyFileSync(path.join(dir, backup.name), old);
    fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
    assert.deepStrictEqual(pruneBackups(dir, 14), ['aquatech-20200101-000000.db.enc']);
    assert.deepStrictEqual(pruneBackups(dir, 0), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('back-up-API alleen voor hoofdbeheerders; download alleen geldige namen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-bkapi-'));
  const { server, base, store } = await start({ backupDir: dir });
  try {
    assert.strictEqual((await createClient(base, { emptyJsonBody: false }).post('/api/admin/backups')).status, 401);
    // Een gewone beheerder (geen hoofdbeheerder): de back-up bevat alle tenants.
    await store.createAccount(store.ensureTenant().id, { username: 'tweede', role: 'beheerder', password: PW });
    const tweede = createClient(base, { emptyJsonBody: false });
    await tweede.post('/api/auth/login', { username: 'tweede', password: PW });
    assert.strictEqual((await tweede.post('/api/admin/backups')).status, 403);
    assert.strictEqual((await tweede.get('/api/admin/backups')).status, 403);
    const baas = createClient(base, { emptyJsonBody: false });
    await baas.post('/api/auth/login', { username: 'baas', password: PW });
    const made = await baas.post('/api/admin/backups');
    assert.strictEqual(made.status, 201);
    const list = (await baas.get('/api/admin/backups')).body;
    assert.strictEqual(list.enabled, true);
    assert.strictEqual(list.items[0].name, made.body.name);
    const dl = await fetch(`${base}/api/admin/backups/${made.body.name}`, { headers: { cookie: `aquatech_session=${baas.jar.get('aquatech_session')}` } });
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(Buffer.from(await dl.arrayBuffer()).subarray(0, 4).toString(), 'AQBK');
    assert.strictEqual((await baas.get('/api/admin/backups/..%2Fmaster-key')).status, 404);
    assert.ok((await baas.get('/api/admin/audit')).body.items.some((x) => x.action === 'backup_gedownload'));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan definitief wissen haalt ook klantgegevens uit de historie', async () => {
  const { server, base, store, db } = await start();
  try {
    const tenant = store.ensureTenant();
    const { user } = await store.createAccount(tenant.id, { username: 'klaas', role: 'gebruiker', password: PW });
    const plan = store.savePlan(user, null, { areas: [], meta: { name: 'Tuin Jansen', customer: 'Familie Jansen', address: 'Dorpsstraat 1' } }, '10.1.1.1');
    store.deletePlan(user, plan.id, '10.1.1.1');
    const baas = createClient(base, { emptyJsonBody: false });
    await baas.post('/api/auth/login', { username: 'baas', password: PW });
    const response = await (async () => { const res = await fetch(`${base}/api/admin/plans/${plan.id}`, { method: 'DELETE', headers: { cookie: `aquatech_session=${baas.jar.get('aquatech_session')}` } }); return { status: res.status, body: await res.json() }; })();
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, { ok: true, plan: true, history: 2 });
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 0);
    const dump = JSON.stringify(db.prepare('SELECT * FROM history').all());
    assert.doesNotMatch(dump, /Jansen|Dorpsstraat|10\.1\.1\.1/);
  } finally {
    server.close();
  }
});

test('bezoekers-IP achter de tunnel: doorgegeven adres alleen van een proxy in het eigen netwerk', () => {
  const { remoteIp } = require('../src/beveiliging/auth');
  /**
   * Een nagebootst verzoek met socketadres en koppen.
   * @param {string} socketAddress Adres van de directe verbinding.
   * @param {object} [headers] Koppen.
   * @returns {object} Het verzoek.
   */
  const req = (socketAddress, headers = {}) => ({ socket: { remoteAddress: socketAddress }, headers });
  assert.strictEqual(remoteIp(req('::ffff:172.18.0.3', { 'cf-connecting-ip': '203.0.114.7' })), '203.0.114.7');
  assert.strictEqual(remoteIp(req('172.18.0.3', { 'x-forwarded-for': '1.1.1.1, 8.8.4.4' })), '8.8.4.4', 'laatste hop, niet te vervalsen');
  assert.strictEqual(remoteIp(req('172.18.0.3', { 'cf-connecting-ip': 'geen-ip' })), '172.18.0.3');
  assert.strictEqual(remoteIp(req('8.8.8.8', { 'cf-connecting-ip': '1.2.3.4' })), '8.8.8.8', 'openbaar socketadres: koppen genegeerd');
});

test('inlogblokkade per IP geldt per bezoeker, niet voor iedereen achter de tunnel', async () => {
  const { server, base } = await start();
  try {
    /**
     * Probeert in te loggen met een fout wachtwoord vanaf een bezoekers-IP.
     * @param {string} ip Doorgegeven IP (CF-Connecting-IP).
     * @returns {Promise<number>} De HTTP-status.
     */
    const login = (ip) => fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ username: `x${ip}`, password: 'fout-fout-fout' }) }).then((response) => response.status);
    for (let i = 0; i < 10; i++) await login('198.51.99.1');
    assert.strictEqual(await login('198.51.99.1'), 429);
    assert.strictEqual(await login('198.51.99.2'), 401, 'andere bezoeker kan nog inloggen');
  } finally {
    server.close();
  }
});

test('wijzigingen via de API vanaf een andere (sub)site worden geweigerd', async () => {
  const { server, base } = await start();
  try {
    /**
     * Logt uit met de opgegeven Sec-Fetch-Site.
     * @param {string|null} site Waarde van Sec-Fetch-Site (null = zonder kop).
     * @returns {Promise<number>} De HTTP-status.
     */
    const post = (site) => fetch(`${base}/api/auth/logout`, { method: 'POST', headers: site ? { 'Sec-Fetch-Site': site } : {} }).then((response) => response.status);
    assert.strictEqual(await post('same-site'), 403);
    assert.strictEqual(await post('cross-site'), 403);
    assert.strictEqual(await post('same-origin'), 200);
    assert.strictEqual(await post(null), 200);
    const get = await fetch(`${base}/api/health`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.strictEqual(get.status, 200, 'lezen blijft mogelijk');
  } finally {
    server.close();
  }
});

test('mailserver en webshop alleen op een openbaar adres (geen toegang tot het eigen netwerk)', async () => {
  const { publicAddress, isPublicAddress } = require('../src/beveiliging/netguard');
  for (const ip of ['10.1.2.3', '192.168.2.251', '172.18.0.2', '127.0.0.1', '169.254.169.254', '100.100.1.1', '::1', 'fd00::1', '::ffff:192.168.1.1']) {
    assert.strictEqual(isPublicAddress(ip), false, ip);
  }
  assert.ok(isPublicAddress('8.8.8.8') && isPublicAddress('2606:4700::1111'));
  /**
   * Nagebootste DNS-opzoeking die vaste adressen geeft.
   * @param {string[]} addresses De adressen.
   * @returns {Function} De opzoekfunctie.
   */
  const lookup = (addresses) => async () => addresses.map((address) => ({ address }));
  await assert.rejects(publicAddress('intern.example', { lookup: lookup(['93.184.215.14', '192.168.2.251']) }), { code: 'private_host' });
  assert.strictEqual(await publicAddress('smtp.example', { lookup: lookup(['93.184.215.14']) }), '93.184.215.14');

  const { createMailer } = require('../src/platform/mailer');
  const settings = { get: (key) => (key === 'mailServer' ? { host: 'mail.intern', port: 25, from: 'a@b.nl' } : '') };
  let used = null;
  const mailer = createMailer(settings, { resolveHost: async () => { throw Object.assign(new Error('x'), { code: 'private_host' }); },
    createTransport: (options) => { used = options; return { sendMail: async () => ({}) }; } });
  await assert.rejects(mailer.send({ to: 'klant@example.nl', subject: 's', text: 't' }), /openbaar adres/);
  assert.strictEqual(used, null, 'geen verbinding gemaakt');
  const ok = createMailer(settings, { resolveHost: async () => '93.184.215.14', createTransport: (options) => { used = options; return { sendMail: async () => ({}) }; } });
  await ok.send({ to: 'klant@example.nl', subject: 's', text: 't' });
  assert.strictEqual(used.host, '93.184.215.14');
  assert.strictEqual(used.servername, 'mail.intern', 'certificaat op naam gecontroleerd');

  const { fetchProducts } = require('../src/webshop/woocommerce');
  await assert.rejects(fetchProducts({ url: 'https://shop.example', mode: 'store' }, { allowInsecure: false, fetchImpl: async () => { throw new Error('niet ophalen'); },
    resolveHost: async () => { throw Object.assign(new Error('x'), { code: 'private_host' }); } }), { code: 'invalid_url' });
});
