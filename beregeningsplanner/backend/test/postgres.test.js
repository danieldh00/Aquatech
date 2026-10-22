// PostgreSQL (Supabase): omzetten van parameters, verbindingsinstellingen en,
// met TEST_DATABASE_URL, het schema en de overstap van SQLite één op één.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../src/server');
const { openSqlite, databaseUrl, schemaVersion, listTables, tableColumns, foreignKeys, MIGRATIONS } = require('../src/database/db');
const { toPgParams, pgConfig, openPg } = require('../src/database/pgdb');
const { PG_BASE_VERSION, PG_MIGRATIONS } = require('../src/database/pgschema');
const { fingerprint, copyDatabase } = require('../src/database/db-copy');
const { createStore } = require('../src/platform/store');
const { createVault } = require('../src/beveiliging/vault');
const { createClient, listen } = require('./helpers/http-client');

const URL_ = process.env.TEST_DATABASE_URL;
const needPg = { skip: !URL_ && 'zet TEST_DATABASE_URL voor tests tegen PostgreSQL' };
const SECRET = 'z'.repeat(64);
const PW = 'Tuin-Plan-2026!';
/**
 * Naam voor een nieuw, leeg testschema.
 * @returns {string} Bijv. aqt_test_0123456789abcdef.
 */
const freshSchema = () => `aqt_test_${crypto.randomBytes(8).toString('hex')}`;

test('?-parameters worden $1, $2, ... (niet binnen strings, namen of commentaar)', () => {
  assert.strictEqual(toPgParams('SELECT * FROM t WHERE a = ? AND b IN (?, ?)'), 'SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)');
  assert.strictEqual(toPgParams("SELECT '?', \"x?\" FROM t WHERE c LIKE ? ESCAPE '\\' -- en ?\nAND d = ?"),
    "SELECT '?', \"x?\" FROM t WHERE c LIKE $1 ESCAPE '\\' -- en ?\nAND d = $2");
  assert.strictEqual(toPgParams("SELECT 'it''s ?' , ?"), "SELECT 'it''s ?' , $1");
});

test('verbinding: TLS met controle, Supabase-CA meegeleverd, sslmode zelf afgehandeld', () => {
  const sb = pgConfig('postgres://postgres.abc:geheim@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require');
  assert.strictEqual(sb.ssl.rejectUnauthorized, true);
  assert.ok(sb.ssl.ca.some((certificate) => certificate.includes('MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYw')), 'Supabase Root 2021 CA');
  assert.doesNotMatch(sb.connectionString, /sslmode/);
  assert.strictEqual(pgConfig('postgres://u:p@db.example.nl/app').ssl.rejectUnauthorized, true);
  assert.strictEqual(pgConfig('postgres://u:p@db.example.nl/app').ssl.ca, undefined, 'gewone CA\'s');
  assert.strictEqual(pgConfig('postgres://u:p@127.0.0.1:5432/app').ssl, false, 'lokaal zonder TLS');
  assert.ok(pgConfig('postgres://u:p@localhost/app?sslmode=require').ssl, 'lokaal mag wel TLS');
  assert.strictEqual(pgConfig('postgres://u:p@db.example.nl/app?sslmode=disable').ssl, false);
  assert.strictEqual(pgConfig('postgres://u:p@db.example.nl/app?sslmode=no-verify').ssl.rejectUnauthorized, false);
  assert.throws(() => pgConfig('postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'), /Session pooler/);
  assert.throws(() => pgConfig('mysql://x@y/z'), /postgres:\/\//);
  assert.throws(() => pgConfig('geen url'), /geldige/);
});

test('DATABASE_URL_FILE (Docker-secret) gaat voor DATABASE_URL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-url-'));
  try {
    const file = path.join(dir, 'database-url');
    fs.writeFileSync(file, 'postgres://u:p@db.example.nl/app\n');
    assert.strictEqual(databaseUrl({ DATABASE_URL_FILE: file, DATABASE_URL: 'postgres://ander' }), 'postgres://u:p@db.example.nl/app');
    assert.strictEqual(databaseUrl({ DATABASE_URL: ' postgres://x ' }), 'postgres://x');
    assert.strictEqual(databaseUrl({}), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('elke SQLite-migratie heeft een PostgreSQL-tegenhanger', () => {
  assert.strictEqual(PG_BASE_VERSION + PG_MIGRATIONS.length, MIGRATIONS.length, 'nieuwe migratie ook toevoegen aan PG_MIGRATIONS in pgschema.js');
});

/**
 * Indexen (geen automatische voor PRIMARY KEY/UNIQUE) per tabel.
 * @param {object} db De database (SQLite of PostgreSQL).
 * @param {string} table Tabelnaam.
 * @returns {string[]} Namen van de indexen, gesorteerd.
 */
function indexes(db, table) {
  if (db.dialect === 'postgres') {
    return db.prepare(`SELECT i.relname AS name FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema() AND t.relname = ? AND NOT x.indisprimary
        AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)`).all(table).map((row) => row.name).sort();
  }
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table).map((row) => row.name).sort();
}

test('PostgreSQL-schema is gelijk aan het SQLite-schema', needPg, () => {
  const lite = openSqlite();
  const pg = openPg(URL_, { schema: freshSchema() });
  assert.strictEqual(schemaVersion(pg), schemaVersion(lite));
  assert.deepStrictEqual(listTables(pg), listTables(lite));
  for (const table of listTables(lite)) {
    // SQLite laat een TEXT PRIMARY KEY NULL toe (oude eigenaardigheid); in
    // PostgreSQL is een primaire sleutel altijd NOT NULL.
    /**
     * Kolommen van de tabel als vergelijkbare tekst.
     * @param {object} db De database.
     * @returns {string[]} Per kolom naam, not null en pk.
     */
    const columnsOf = (db) => tableColumns(db, table).map((column) => `${column.name}${column.notnull || column.pk ? ' not null' : ''}${column.pk ? ' pk' : ''}`);
    assert.deepStrictEqual(columnsOf(pg), columnsOf(lite), `kolommen van ${table}`);
    /**
     * Foreign keys van de tabel als vergelijkbare tekst.
     * @param {object} db De database.
     * @returns {string[]} Per sleutel kolom->tabel, gesorteerd.
     */
    const foreignKeysOf = (db) => foreignKeys(db, table).map((key) => `${key.from}->${key.table}`).sort();
    assert.deepStrictEqual(foreignKeysOf(pg), foreignKeysOf(lite), `foreign keys van ${table}`);
    assert.deepStrictEqual(indexes(pg, table), indexes(lite, table), `indexen van ${table}`);
  }
  // Afgeschermd voor de REST-API van Supabase: row level security overal aan.
  assert.deepStrictEqual(pg.prepare('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND NOT rowsecurity').all(), []);
});

/**
 * Start een testserver op de gegeven database en kluis.
 * @param {object} db De database.
 * @param {object} vault De kluis voor geheimen.
 * @returns {Promise<{ server: import('http').Server, base: string }>} De server en zijn adres.
 */
function start(db, vault) {
  return listen(createApp({ secret: SECRET, db, vault }));
}

/**
 * Wat een gebruiker in de app ziet; na de overstap moet dat exact gelijk zijn.
 * @param {string} base Adres van de testserver.
 * @param {object} jars Cookiepot per gebruiker (naam → [[cookie, waarde]]).
 * @returns {Promise<object>} Status en body per gebruiker en pad.
 */
async function views(base, jars) {
  const out = {};
  for (const [who, jar] of Object.entries(jars)) {
    const client = createClient(base, { jar: new Map(jar) });
    for (const urlPath of ['/api/me', '/api/plans?all=1', '/api/quotes?all=1', '/api/workorders', '/api/catalog', '/api/admin/users', '/api/admin/history?limit=1000',
      '/api/admin/plans?deleted=1', '/api/admin/settings', '/api/platform/tenants', '/api/admin/audit?limit=1000', '/api/service-requests', '/api/portal']) {
      const response = await client.get(urlPath);
      out[`${who} ${urlPath}`] = { status: response.status, body: response.body };
    }
    const plans = (await client.get('/api/plans?all=1')).body?.items || [];
    for (const plan of plans) out[`${who} plan ${plan.id}`] = (await client.get(`/api/plans/${plan.id}`)).body;
    const quotes = (await client.get('/api/quotes?all=1')).body?.items || [];
    for (const quote of quotes) out[`${who} offerte ${quote.id}`] = (await client.get(`/api/quotes/${quote.id}`)).body;
  }
  return out;
}

test('overstap SQLite → PostgreSQL: alle gegevens één op één, ingelogd blijven, geheimen leesbaar', needPg, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-pg-'));
  const vault = createVault(crypto.randomBytes(32));
  const file = path.join(dir, 'aquatech.db');
  const KEY = `sk-ant-${'x'.repeat(30)}WXYZ`;
  try {
    // Een gevulde SQLite-database zoals op de server.
    const lite = openSqlite(file);
    await createStore(lite).createAccount(createStore(lite).ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
    let { server, base } = await start(lite, vault);
    const jars = {};
    try {
      const baas = createClient(base);
      assert.strictEqual((await baas.post('/api/auth/login', { username: 'baas', password: PW })).status, 200);
      assert.strictEqual((await baas.put('/api/admin/settings', { anthropicApiKey: KEY })).status, 200);
      const tenant = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!', mustChangePassword: false } })).body.tenant;
      const env = (await baas.post(`/api/platform/tenants/${tenant.id}/environments`, { name: 'Test' })).body.tenant;
      const seed = await baas.post(`/api/platform/tenants/${env.id}/testdata`, { shareBase: 'https://app.voorbeeld.nl/openbaar/offerte.html' });
      assert.strictEqual(seed.status, 201);
      const inst = createClient(base);
      const instName = seed.body.accounts.find((account) => account.username.endsWith('.installateur')).username;
      assert.strictEqual((await inst.post('/api/auth/login', { username: instName, password: seed.body.password, tenant: 'groen' })).status, 200);
      jars.baas = [...baas.jar];
      jars.installateur = [...inst.jar];
    } finally {
      server.close();
    }
    const before = await (async () => {
      ({ server, base } = await start(lite, vault));
      // Eerste ronde zet o.a. 'laatst gezien'; de tweede is de vergelijking.
      try { await views(base, jars); return await views(base, jars); } finally { server.close(); }
    })();
    lite.close();

    // Overstap met het script, zoals op de server.
    const { main } = require('../src/migrate-to-postgres');
    const schema = freshSchema();
    const lines = [];
    const result = main(['--from', file, '--schema', schema], { DATABASE_URL: URL_ }, (line) => lines.push(line));
    assert.ok(result.ok, lines.join('\n'));
    assert.ok(result.rows.find((row) => row.table === 'plans').postgres > 5);
    assert.match(lines.join('\n'), /één op één gelijk/);
    // Nog een keer naar hetzelfde schema mag niet (zou dubbel worden).
    assert.throws(() => main(['--from', file, '--schema', schema], { DATABASE_URL: URL_ }, () => {}), /niet leeg/);
    assert.ok(main(['--from', file, '--schema', schema, '--check'], { DATABASE_URL: URL_ }, () => {}).ok);

    // De app op PostgreSQL: dezelfde sessies (geen nieuwe login), dezelfde
    // gegevens en de versleutelde API-sleutel is met dezelfde hoofdsleutel leesbaar.
    const pg = openPg(URL_, { schema });
    ({ server, base } = await start(pg, vault));
    try {
      const after = await views(base, jars);
      assert.ok(Object.keys(before).length > 30);
      assert.strictEqual(before['installateur /api/quotes?all=1'].body.items.length, 6, 'vergelijking met echte gegevens');
      assert.ok(before['installateur /api/workorders'].body.items.length === 4 && before['baas /api/platform/tenants'].body.items.length === 2);
      for (const key of Object.keys(before)) assert.deepStrictEqual(after[key], before[key], key);
      assert.strictEqual((await createClient(base, { jar: new Map(jars.baas) }).get('/api/admin/settings')).body.settings.anthropicApiKey.hint, '…WXYZ');
      // En verder werken op PostgreSQL.
      const baas = createClient(base, { jar: new Map(jars.baas) });
      const created = await baas.post('/api/plans', { data: { meta: { name: 'Nieuw na overstap' }, areas: [], sprinklers: [], zones: [], elements: [] } });
      assert.strictEqual(created.status, 201);
      assert.ok((await baas.get('/api/admin/history?search=NIEUW')).body.items.some((entry) => entry.title === 'Nieuw na overstap'), 'zoeken blijft hoofdletterongevoelig');
    } finally {
      server.close();
    }

    // Back-up vanuit PostgreSQL is een gewoon SQLite-bestand met dezelfde inhoud.
    const { createBackup, decryptFile, keyOf } = require('../src/backup');
    const bdir = path.join(dir, 'backups');
    const backup = await createBackup({ db: pg, dir: bdir, vault });
    const restoredFile = path.join(dir, 'terug.db');
    await decryptFile(path.join(bdir, backup.name), restoredFile, keyOf(vault));
    const restored = openSqlite(restoredFile);
    assert.deepStrictEqual(fingerprint(restored), fingerprint(pg));
    // En die gaat ook weer terug naar een leeg schema.
    copyDatabase(restored, openPg(URL_, { schema: freshSchema() }));
    restored.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migratie weigert een schema met vreemde tabellen', needPg, () => {
  const schema = freshSchema();
  const pg = openPg(URL_, { schema });
  pg.exec('DROP TABLE schema_version');
  assert.throws(() => openPg(URL_, { schema }), /bevat al tabellen/);
});
