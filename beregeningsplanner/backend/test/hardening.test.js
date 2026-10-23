// Beveiligingsronde 0.69.0: offline wachtrij per eigenaar, plannen alleen met
// het recht plannen, uitgeschakelde organisaties, inlogpogingen, sessieduur
// per organisatie, gekoppelde webshopverbinding en lineaire PDF-tekst.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { createApp } = require('../src/server');
const { openDb, openSqlite } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createSettings } = require('../src/platform/settings');
const { createMailer } = require('../src/platform/mailer');
const { remoteIp } = require('../src/beveiliging/auth');
const { pinnedFetch, readLimited } = require('../src/beveiliging/pinned-fetch');
const { copyDatabase, describe, rowsOf } = require('../src/database/db-copy');
const { wrap, textWidth } = require('../src/verkoop/pdf');
const { createClient, createLogin, listen } = require('./helpers/http-client');
const OfflineCore = require(path.join(__dirname, '..', '..', 'frontend', 'shared', 'offline-core.js'));
const WorkOrderCore = require(path.join(__dirname, '..', '..', 'frontend', 'werkorders', 'workorder-core.js'));

const PW = 'Tuin-Plan-2026!';
const PG = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Testserver met een hoofdbeheerder, een beheerder, een planner en een klant in de hoofdtenant.
 * @returns {Promise<object>} db, store, tid, server, base en as (inloggen).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'hoofd', displayName: 'Hoofd', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW });
  await store.createAccount(tid, { username: 'pim', displayName: 'Pim', role: 'planner', password: PW });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ secret: 'x'.repeat(64), db }));
  return { db, store, tid, server, base, as: createLogin(base, { password: PW }) };
}

test('offline wachtrij: alleen bekende werkorder-wijzigingen, eigenaar meegestuurd en door de server gecontroleerd', async () => {
  assert.ok(OfflineCore.queueable('api/workorders/abc-1', 'PUT'));
  assert.ok(OfflineCore.queueable('api/workorders/abc-1/hours', 'POST'));
  assert.ok(OfflineCore.queueable('api/workorders/abc-1/photos/p-2', 'PATCH'));
  assert.ok(!OfflineCore.queueable('api/admin/users/abc-1', 'PATCH'), 'beheer gaat nooit via de wachtrij');
  assert.ok(!OfflineCore.queueable('api/workorders/abc-1', 'DELETE'));
  assert.strictEqual(OfflineCore.classify(409, { error: 'owner_mismatch' }), 'failed');

  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const me = (await baas.get('/api/me')).body;
    const owner = `${me.user.id}@${me.tenant.id}`;
    const other = await baas.put('/api/account/profile', { phone: '0612345678' }, { 'X-Aquatech-Owner': 'iemand-anders@elders' });
    assert.strictEqual(other.status, 409);
    assert.strictEqual(other.body.error, 'owner_mismatch');
    assert.strictEqual((await baas.get('/api/account/profile')).body.user.phone || '', '', 'niet uitgevoerd');
    assert.strictEqual((await baas.put('/api/account/profile', { phone: '0612345678' }, { 'X-Aquatech-Owner': owner })).status, 200);
    // Zonder de kop (gewoon verzoek vanaf de pagina) verandert er niets.
    assert.strictEqual((await baas.put('/api/account/profile', { phone: '0612345679' })).status, 200);
  } finally {
    server.close();
  }
});

test('plannen: alleen met het recht plannen; zonder recht geen lijst, geen opslaan', async () => {
  const { server, as } = await setup();
  try {
    const pim = await as('pim'), klaas = await as('klaas');
    const plan = { data: { areas: [], meta: { name: 'Tuin' } } };
    assert.strictEqual((await pim.post('/api/plans', plan)).status, 403, 'planner heeft geen recht plannen');
    assert.deepStrictEqual((await pim.get('/api/plans')).body.items, []);
    const own = await klaas.post('/api/plans', plan);
    assert.strictEqual(own.status, 201, 'klant mag wel');
    assert.strictEqual((await pim.get(`/api/plans/${own.body.id}`)).status, 403);
    assert.strictEqual((await pim.put(`/api/plans/${own.body.id}`, plan)).status, 403);
    assert.strictEqual((await pim.del(`/api/plans/${own.body.id}`)).status, 403);
    assert.strictEqual((await pim.post(`/api/plans/${own.body.id}/review-request`, {})).status, 403);
  } finally {
    server.close();
  }
});

test('uitgeschakelde organisatie: ook accounts in haar testomgeving en de AI-route zijn dicht', async () => {
  const { store, server, base, as } = await setup();
  try {
    const live = store.createTenant({ name: 'Groen', slug: 'groen' }).tenant;
    const env = store.createEnvironment(live.id, { name: 'Test' }).tenant;
    await store.createAccount(env.id, { username: 'tess', displayName: 'Tess', role: 'installateur', password: PW });
    const tess = await as('tess', env.slug);
    assert.ok((await tess.get('/api/me')).body.user, 'werkt zolang de organisatie aan staat');
    const hoofd = await as('hoofd');
    assert.strictEqual((await hoofd.patch(`/api/platform/tenants/${live.id}`, { disabled: true })).status, 200);
    assert.strictEqual((await tess.get('/api/me')).body.user, null, 'bestaande sessie werkt niet meer');
    assert.strictEqual((await tess.post('/api/plans', { data: { areas: [] } })).status, 401);
    assert.strictEqual((await tess.get('/api/plan/status')).status, 401, 'AI niet via de hoofdtenant');
    // Zonder sessie en zonder gasten: ook dicht.
    assert.strictEqual((await createClient(base).get('/api/plan/status')).status, 401);
  } finally {
    server.close();
  }
});

test('inloggen: verzonnen organisatiecodes geven geen extra pogingen op een hoofdbeheerder; toegangscode heeft een totaalgrens', async () => {
  const { server, base } = await setup();
  try {
    // Elke poging van een ander (doorgegeven) IP-adres, zodat alleen de grens per gebruiker telt.
    let ip = 1;
    /**
     * Eén inlogpoging vanaf een nieuw IP-adres.
     * @param {object} body De inloggegevens.
     * @returns {Promise<object>} Het antwoord.
     */
    const attempt = (body) => createClient(base).request('POST', '/api/auth/login', body, { 'X-Forwarded-For': `203.0.113.${ip++}` });
    for (let i = 0; i < 10; i++) assert.strictEqual((await attempt({ username: 'hoofd', password: 'fout-fout-fout-1', tenant: `code-${i}` })).status, 401);
    assert.strictEqual((await attempt({ username: 'hoofd', password: PW, tenant: 'nog-een-code' })).status, 401, 'via een andere code niet meer');
    assert.strictEqual((await attempt({ username: 'hoofd', password: PW })).status, 429, 'de gebruikersnaam in de hoofdtenant is geblokkeerd');
  } finally {
    server.close();
  }

  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW });
  const { server: codeServer, base: codeBase } = await listen(createApp({ secret: 'x'.repeat(64), db, accessCode: 'juiste-code-123' }));
  try {
    let ip = 1;
    /**
     * Eén poging met de toegangscode vanaf een nieuw IP-adres.
     * @param {string} code De code.
     * @returns {Promise<object>} Het antwoord.
     */
    const tryCode = (code) => createClient(codeBase).request('POST', '/api/auth/login', { code }, { 'X-Forwarded-For': `198.51.100.${ip++}` });
    for (let i = 0; i < 30; i++) assert.strictEqual((await tryCode(`fout-${i}`)).status, 401);
    assert.strictEqual((await tryCode('juiste-code-123')).status, 429, 'na 30 fouten in totaal even dicht');
  } finally {
    codeServer.close();
  }
});

test('IP-adres achter een proxy: met TRUSTED_PROXIES alleen van die adressen', () => {
  /**
   * Nagebootst verzoek via een proxy.
   * @param {string} socketIp Adres van de directe verbinding.
   * @returns {object} Het verzoek.
   */
  const request = (socketIp) => ({ socket: { remoteAddress: socketIp }, headers: { 'x-forwarded-for': '203.0.113.9' } });
  const before = process.env.TRUSTED_PROXIES;
  try {
    delete process.env.TRUSTED_PROXIES;
    assert.strictEqual(remoteIp(request('10.0.0.5')), '203.0.113.9', 'standaard: elk lokaal adres');
    process.env.TRUSTED_PROXIES = '172.18.0.0/16, 127.0.0.1';
    assert.strictEqual(remoteIp(request('10.0.0.5')), '10.0.0.5', 'niet in de lijst: kop genegeerd');
    assert.strictEqual(remoteIp(request('172.18.4.2')), '203.0.113.9');
    assert.strictEqual(remoteIp(request('::ffff:127.0.0.1')), '203.0.113.9');
  } finally {
    if (before === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = before;
  }
});

test('sessieduur volgt de instelling van de eigen organisatie', async () => {
  const { db, store, server, as } = await setup();
  try {
    const live = store.createTenant({ name: 'Groen', slug: 'groen' }).tenant;
    await store.createAccount(live.id, { username: 'gerda', displayName: 'Gerda', role: 'beheerder', password: PW });
    createSettings({ db, tenantId: live.id }).update({ sessionIdleDays: 1 });
    const gerda = await as('gerda', 'groen');
    const baas = await as('baas');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    db.prepare('UPDATE sessions SET last_seen_at = ?').run(twoDaysAgo);
    assert.strictEqual((await gerda.get('/api/me')).body.user, null, 'na 1 dag zonder gebruik uitgelogd');
    assert.ok((await baas.get('/api/me')).body.user, 'hoofdtenant: standaard 14 dagen');
  } finally {
    server.close();
  }
});

test('profiel: zonder wijziging geen auditregel', async () => {
  const { db, server, as } = await setup();
  try {
    const baas = await as('baas');
    /**
     * Aantal auditregels voor een gewijzigd profiel.
     * @returns {number} Het aantal.
     */
    const count = () => Number(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'profiel_gewijzigd'").get().n);
    await baas.put('/api/account/profile', { phone: '0612345678' });
    assert.strictEqual(count(), 1);
    await baas.put('/api/account/profile', { phone: '0612345678' });
    await baas.put('/api/account/profile', {});
    assert.strictEqual(count(), 1);
  } finally {
    server.close();
  }
});

test('mail: zonder SSL/TLS is STARTTLS altijd verplicht', async () => {
  let used = null;
  const settings = { get: (key) => (key === 'mailServer' ? { mode: 'smtp', host: 'smtp.example.nl', port: 587, secure: false, user: 'info', from: 'info@example.nl' } : 'wachtwoord') };
  const mailer = createMailer(settings, { resolveHost: async () => '93.184.215.14', createTransport: (options) => { used = options; return { sendMail: async () => ({}) }; } });
  await mailer.send({ to: 'klant@example.nl', subject: 's', text: 't' });
  assert.strictEqual(used.requireTLS, true);
});

test('webshopverbinding: naar het goedgekeurde adres, geen omleiding, grens na uitpakken', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/bom') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 32)));
    } else if (req.url === '/weg') {
      res.statusCode = 302;
      res.setHeader('Location', 'http://127.0.0.1/');
      res.end();
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ host: req.headers.host }));
    }
  });
  const { base } = await listen(server);
  const port = new URL(base).port;
  try {
    // De naam bestaat niet: het verzoek gaat toch naar het vaste adres.
    const send = pinnedFetch('127.0.0.1');
    const response = await send(`http://shop.voorbeeld.invalid:${port}/producten`);
    assert.deepStrictEqual(JSON.parse(await readLimited(response, 1000)), { host: `shop.voorbeeld.invalid:${port}` });
    await assert.rejects(readLimited(await send(`http://shop.voorbeeld.invalid:${port}/bom`), 1024 * 1024), { code: 'too_large' });
    await assert.rejects(send(`http://shop.voorbeeld.invalid:${port}/weg`), TypeError);
  } finally {
    server.close();
  }
});

test('PDF: een heel lang woord wordt snel en binnen de breedte afgebroken', () => {
  const started = Date.now();
  const lines = wrap(`kort ${'x'.repeat(20000)} einde`, 120, 9);
  assert.ok(Date.now() - started < 1000, 'lineair, niet in het kwadraat');
  assert.ok(lines.every((line) => textWidth(line, 9) <= 120));
  assert.strictEqual(lines.join('').replace(/\s/g, ''), `kort${'x'.repeat(20000)}einde`);
  assert.deepStrictEqual(wrap('een twee\ndrie', 500, 9), ['een twee', 'drie']);
});

test('werkorder: titel blijft één regel (geen extra regels in het agendabestand)', () => {
  assert.strictEqual(WorkOrderCore.sanitize({ title: 'Aanleg\r\nEND:VEVENT\nBEGIN:VEVENT' }).title, 'Aanleg END:VEVENT BEGIN:VEVENT');
});

test('back-up: kopiëren in porties na de laatste sleutel (geen OFFSET), alle rijen gelijk', { skip: PG && 'alleen SQLite → SQLite' }, () => {
  const from = openSqlite(':memory:');
  const store = createStore(from);
  const tid = store.ensureTenant().id;
  for (let i = 0; i < 450; i++) store.audit({ tenantId: tid, userId: null, action: 'test', detail: { i }, ip: '' });
  const to = openSqlite(':memory:');
  const statements = [];
  const prepare = from.prepare.bind(from);
  /**
   * Onthoudt elke query van de bron.
   * @param {string} sql De query.
   * @returns {object} Het prepared statement.
   */
  from.prepare = (sql) => { statements.push(sql); return prepare(sql); };
  const result = copyDatabase(from, to);
  assert.strictEqual(result.tables.audit, Number(prepare('SELECT COUNT(*) AS n FROM audit').get().n));
  assert.ok(!statements.some((sql) => /FROM audit .*OFFSET/.test(sql)), 'audit heeft een primaire sleutel');
});

test('back-up: primaire sleutel met een NULL (SQLite) valt terug op OFFSET, geen rij overgeslagen', { skip: PG && 'alleen SQLite' }, () => {
  const db = openSqlite(':memory:');
  db.exec('CREATE TABLE losse_sleutel (id TEXT PRIMARY KEY, waarde TEXT)');
  db.exec("INSERT INTO losse_sleutel (id, waarde) VALUES (NULL, 'a'), ('b', 'b'), ('c', 'c')");
  const description = describe(db).losse_sleutel;
  assert.strictEqual(description.nullableKey, true);
  assert.strictEqual([...rowsOf(db, 'losse_sleutel', description)].length, 3);
});

test('PDF: een letter met accent blijft bij het afbreken heel', () => {
  const word = 'é'.repeat(400);
  const lines = wrap(word, 60, 9);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => !/^\p{M}/u.test(line)), 'geen regel begint met een los accent');
});
