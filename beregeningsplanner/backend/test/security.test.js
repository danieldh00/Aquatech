// Beveiliging van de opslag: versleuteling, sessies, wachtwoorden, auditlog,
// bewaartermijnen en headers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore, passwordProblem, hashPassword, verifyPassword, needsRehash } = require('../src/store');
const { createSettings } = require('../src/settings');
const { createVault, loadOrCreateMasterKey } = require('../src/vault');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

async function start(opts = {}) {
  const db = opts.db || openDb();
  const store = createStore(db);
  if (!opts.noAdmin) await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW });
  return new Promise((resolve) => {
    const app = createApp({ secret: SECRET, db, ...opts });
    const server = app.listen(0, () => resolve({ app, db, store, server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

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
      if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i)); else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    let json = null;
    try { json = await res.json(); } catch { /* geen JSON */ }
    return { status: res.status, body: json, headers: res.headers };
  }
  return { jar, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b) };
}

test('vault: versleutelen met context, geknoei en verkeerde context worden geweigerd', () => {
  const v = createVault(crypto.randomBytes(32));
  const sealed = v.seal('geheim', 't:veld');
  assert.ok(v.isSealed(sealed));
  assert.notStrictEqual(sealed, v.seal('geheim', 't:veld'), 'elke keer een nieuwe IV');
  assert.strictEqual(v.open(sealed, 't:veld'), 'geheim');
  assert.throws(() => v.open(sealed, 't:ander'));
  const [a, b, c, d] = sealed.split(':');
  const flipped = Buffer.from(d, 'base64url');
  flipped[0] ^= 1;
  assert.throws(() => v.open([a, b, c, flipped.toString('base64url')].join(':'), 't:veld'));
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

test('databasebestand alleen leesbaar voor de eigenaar', () => {
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
  const h = await hashPassword(PW);
  assert.match(h, /^scrypt\$131072\$8\$1\$/);
  assert.ok(await verifyPassword(PW, h));
  assert.ok(!(await verifyPassword('fout', h)));

  // Een oude (lichtere) hash werkt nog en wordt bij het inloggen vervangen.
  const db = openDb();
  const store = createStore(db);
  const t = store.ensureTenant();
  const { user } = await store.createAccount(t.id, { username: 'oud', role: 'gebruiker', password: PW });
  const salt = crypto.randomBytes(16);
  const old = `scrypt$16384$8$1$${salt.toString('base64url')}$${crypto.scryptSync(PW, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64url')}`;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(old, user.id);
  assert.ok(await store.authenticate(t.id, 'oud', PW));
  assert.ok(!needsRehash(store.getUser(user.id).password_hash));
});

test('sessies staan op de server: uitloggen en intrekken werkt meteen; token alleen als hash', async () => {
  const { server, base, db } = await start();
  try {
    const a = client(base);
    assert.strictEqual((await a.post('/api/auth/login', { username: 'baas', password: PW })).status, 200);
    const token = a.jar.get('aquatech_session');
    assert.ok(token && token.length >= 40);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?').get(token).n, 0, 'geen leesbaar token in de database');
    assert.strictEqual((await a.get('/api/admin/users')).status, 200);

    // Uitloggen: een gekopieerde cookie werkt daarna ook niet meer.
    const stolen = client(base);
    stolen.jar.set('aquatech_session', token);
    await a.post('/api/auth/logout');
    assert.strictEqual((await stolen.get('/api/admin/users')).status, 401);

    // Beheerder logt iemand op alle toestellen uit.
    const admin = client(base);
    await admin.post('/api/auth/login', { username: 'baas', password: PW });
    const jan = (await admin.post('/api/admin/users', { username: 'jan', role: 'gebruiker', password: 'Gras-Pomp-2027!' })).body;
    const j = client(base);
    await j.post('/api/auth/login', { username: 'jan', password: 'Gras-Pomp-2027!' });
    assert.ok((await j.get('/api/me')).body.user);
    assert.strictEqual((await admin.get('/api/admin/users')).body.items.find((u) => u.id === jan.id).sessionCount, 1);
    assert.strictEqual((await admin.post(`/api/admin/users/${jan.id}/logout`)).body.revoked, 1);
    assert.strictEqual((await j.get('/api/me')).body.user, null);
  } finally {
    server.close();
  }
});

test('sessie verloopt na de ingestelde dagen zonder gebruik', async () => {
  const { server, base, db } = await start();
  try {
    const a = client(base);
    await a.post('/api/auth/login', { username: 'baas', password: PW });
    const old = new Date(Date.now() - 15 * 86400000).toISOString();
    db.prepare('UPDATE sessions SET last_seen_at = ?').run(old);
    assert.strictEqual((await a.get('/api/me')).body.user, null);
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
    const c = client(base);
    for (let i = 0; i < 10; i++) assert.strictEqual((await c.post('/api/auth/login', { username: 'baas', password: 'fout' })).status, 401);
    assert.strictEqual((await c.post('/api/auth/login', { username: 'baas', password: PW })).status, 429);
  } finally {
    server.close();
  }
  const s2 = await start();
  try {
    const admin = client(s2.base);
    await admin.post('/api/auth/login', { username: 'baas', password: 'fout-fout-fout' });
    await admin.post('/api/auth/login', { username: 'baas', password: PW });
    await admin.put('/api/admin/settings', { sessionIdleDays: 7 });
    const { items } = (await admin.get('/api/admin/audit')).body;
    const actions = items.map((x) => x.action);
    assert.deepStrictEqual(actions.slice(0, 3), ['instellingen_gewijzigd', 'ingelogd', 'inloggen_mislukt']);
    assert.ok(!JSON.stringify(items).includes(PW), 'geen wachtwoorden in het auditlog');
    assert.strictEqual((await client(s2.base).get('/api/admin/audit')).status, 401);
  } finally {
    s2.server.close();
  }
});

test('bewaartermijnen: oude IP-adressen gewist, oude auditregels verwijderd', async () => {
  const db = openDb();
  const store = createStore(db);
  const t = store.ensureTenant();
  const { user } = await store.createAccount(t.id, { username: 'piet', role: 'gebruiker', password: PW });
  store.savePlan(user, null, { areas: [], meta: { name: 'Tuin', customer: 'Klant' } }, '10.0.0.1');
  store.audit({ tenantId: t.id, userId: user.id, action: 'ingelogd', ip: '10.0.0.1' });
  const long = new Date(Date.now() - 400 * 86400000).toISOString();
  db.prepare('UPDATE history SET updated_at = ?').run(long);
  db.prepare('UPDATE audit SET created_at = ?').run(long);
  const r = store.applyRetention(t.id, { ipDays: 90, auditDays: 365 });
  assert.strictEqual(r.historyIps, 1);
  assert.strictEqual(r.audit, 1);
  assert.strictEqual(db.prepare('SELECT ip FROM history').get().ip, '');
});

test('installatiecode is nodig voor het eerste beheerdersaccount', async () => {
  const { server, base, app } = await start({ noAdmin: true });
  try {
    const code = app.locals.setupCode;
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const c = client(base);
    assert.strictEqual((await c.post('/api/setup', { username: 'daniel', password: PW })).status, 401);
    assert.strictEqual((await c.post('/api/setup', { username: 'daniel', password: PW, code: code.toLowerCase() })).status, 201);
  } finally {
    server.close();
  }
});

test('beveiligingsheaders op pagina’s en API', async () => {
  const { server, base } = await start();
  try {
    for (const p of ['/', '/api/health']) {
      const res = await fetch(base + p);
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
    const t = store.ensureTenant();
    const { user } = await store.createAccount(t.id, { username: 'piet', role: 'gebruiker', password: PW });
    store.savePlan(user, null, { areas: [], meta: { name: 'Tuin', customer: 'Familie Jansen' } }, '');
    const vault = createVault(crypto.randomBytes(32));
    const b = await createBackup({ db, dir, vault });
    assert.deepStrictEqual(listBackups(dir).map((x) => x.name), [b.name]);
    assert.strictEqual(fs.statSync(path.join(dir, b.name)).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(path.join(dir, b.name)).includes('Familie Jansen'), 'versleuteld');
    assert.deepStrictEqual(fs.readdirSync(dir), [b.name], 'geen tijdelijke bestanden over');

    const out = path.join(dir, 'terug.db');
    await decryptFile(path.join(dir, b.name), out, keyOf(vault));
    const restored = openDb(out);
    assert.strictEqual(restored.prepare('SELECT customer FROM plans').get().customer, 'Familie Jansen');
    restored.close();

    await assert.rejects(decryptFile(path.join(dir, b.name), path.join(dir, 'fout.db'), keyOf(createVault(crypto.randomBytes(32)))));
    assert.ok(!fs.existsSync(path.join(dir, 'fout.db')) && !fs.existsSync(path.join(dir, 'fout.db.part')));

    // Bewaartermijn: oude weg, de nieuwste blijft altijd.
    const old = path.join(dir, 'aquatech-20200101-000000.db.enc');
    fs.copyFileSync(path.join(dir, b.name), old);
    fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
    assert.deepStrictEqual(pruneBackups(dir, 14), ['aquatech-20200101-000000.db.enc']);
    assert.deepStrictEqual(pruneBackups(dir, 0), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('back-up-API alleen voor beheerders; download alleen geldige namen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-bkapi-'));
  const { server, base } = await start({ backupDir: dir });
  try {
    assert.strictEqual((await client(base).post('/api/admin/backups')).status, 401);
    const a = client(base);
    await a.post('/api/auth/login', { username: 'baas', password: PW });
    const made = await a.post('/api/admin/backups');
    assert.strictEqual(made.status, 201);
    const list = (await a.get('/api/admin/backups')).body;
    assert.strictEqual(list.enabled, true);
    assert.strictEqual(list.items[0].name, made.body.name);
    const dl = await fetch(`${base}/api/admin/backups/${made.body.name}`, { headers: { cookie: `aquatech_session=${a.jar.get('aquatech_session')}` } });
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(Buffer.from(await dl.arrayBuffer()).subarray(0, 4).toString(), 'AQBK');
    assert.strictEqual((await a.get('/api/admin/backups/..%2Fmaster-key')).status, 404);
    assert.ok((await a.get('/api/admin/audit')).body.items.some((x) => x.action === 'backup_gedownload'));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan definitief wissen haalt ook klantgegevens uit de historie', async () => {
  const { server, base, store, db } = await start();
  try {
    const t = store.ensureTenant();
    const { user } = await store.createAccount(t.id, { username: 'klaas', role: 'gebruiker', password: PW });
    const plan = store.savePlan(user, null, { areas: [], meta: { name: 'Tuin Jansen', customer: 'Familie Jansen', address: 'Dorpsstraat 1' } }, '10.1.1.1');
    store.deletePlan(user, plan.id, '10.1.1.1');
    const a = client(base);
    await a.post('/api/auth/login', { username: 'baas', password: PW });
    const r = await (async () => { const res = await fetch(`${base}/api/admin/plans/${plan.id}`, { method: 'DELETE', headers: { cookie: `aquatech_session=${a.jar.get('aquatech_session')}` } }); return { status: res.status, body: await res.json() }; })();
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true, plan: true, history: 2 });
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 0);
    const dump = JSON.stringify(db.prepare('SELECT * FROM history').all());
    assert.doesNotMatch(dump, /Jansen|Dorpsstraat|10\.1\.1\.1/);
  } finally {
    server.close();
  }
});
