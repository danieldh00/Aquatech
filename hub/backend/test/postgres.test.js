// PostgreSQL: omzetten van parameters, verbindingsinstellingen en, met TEST_DATABASE_URL,
// het schema en de back-ups (exporteren en inlezen).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { openDatabase, databaseUrl, schemaVersion, listTables } = require('../src/database/db');
const { toPgParams, pgConfig, openPg } = require('../src/database/pgdb');
const { PG_BASE_VERSION, PG_MIGRATIONS } = require('../src/database/pgschema');
const { fingerprint, describe } = require('../src/database/table-rows');
const { createStore } = require('../src/platform/store');
const { createVault } = require('../src/beveiliging/vault');

const URL_ = process.env.TEST_DATABASE_URL;
const needPg = { skip: !URL_ && 'zet TEST_DATABASE_URL voor tests tegen PostgreSQL' };
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

test('zonder database-URL start de app niet, met een duidelijke melding', () => {
  assert.throws(() => openDatabase({}), /DATABASE_URL/);
});

test('PG_MIGRATIONS: elke migratie is een niet-lege tekst en het schema is overal afgeschermd (row level security)', needPg, () => {
  assert.ok(PG_MIGRATIONS.every((sql) => typeof sql === 'string' && sql.trim()));
  const pg = openPg(URL_, { schema: freshSchema() });
  assert.strictEqual(schemaVersion(pg), PG_BASE_VERSION + PG_MIGRATIONS.length);
  assert.ok(listTables(pg).includes('tenants'));
  assert.deepStrictEqual(pg.prepare('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND NOT rowsecurity').all(), []);
});

test('back-up uit PostgreSQL: versleuteld exporteren en in een tijdelijk schema inlezen geeft exact dezelfde gegevens', needPg, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-pg-'));
  const vault = createVault(crypto.randomBytes(32));
  try {
    const pg = openPg(URL_, { schema: freshSchema() });
    const store = createStore(pg);
    const tenant = store.ensureTenant();
    const { user } = await store.createAccount(tenant.id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW });
    store.savePlan(user, null, { areas: [], meta: { name: 'Tuin', customer: 'Familie Jansen' } }, '');
    const { createBackup } = require('../src/backup');
    const { openBackup } = require('../src/platform/backup-restore');
    const backup = await createBackup({ db: pg, dir, vault });
    const opened = await openBackup({ dir, name: backup.name, vault, current: pg });
    const scratchSchema = opened.db.schema;
    try {
      assert.deepStrictEqual(fingerprint(opened.db, describe(pg)), fingerprint(pg));
      assert.strictEqual(opened.db.prepare('SELECT customer FROM plans').get().customer, 'Familie Jansen');
    } finally {
      opened.close();
    }
    const schemas = pg.prepare('SELECT count(*) AS n FROM pg_namespace WHERE nspname = ?').get(scratchSchema).n;
    assert.strictEqual(Number(schemas), 0, 'tijdelijk schema opgeruimd');
    // Een back-up in het oude SQLite-formaat (versie 1) wordt duidelijk geweigerd.
    const old = path.join(dir, 'aquatech-20200101-000000.db.enc');
    const header = Buffer.concat([Buffer.from('AQBK'), Buffer.from([1]), Buffer.alloc(12), Buffer.alloc(40)]);
    fs.writeFileSync(old, header);
    await assert.rejects(openBackup({ dir, name: 'aquatech-20200101-000000.db.enc', vault, current: pg }), /SQLite-formaat/);
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

test('een database die nieuwer is dan de code start niet (tenzij bewust toegestaan)', needPg, () => {
  const schema = freshSchema();
  const pg = openPg(URL_, { schema });
  pg.prepare('UPDATE schema_version SET version = ?').run(PG_BASE_VERSION + PG_MIGRATIONS.length + 1);
  assert.throws(() => openPg(URL_, { schema }), /database nieuwer dan de code/);
  process.env.AQUATECH_ALLOW_NEWER_SCHEMA = '1';
  try {
    assert.doesNotThrow(() => openPg(URL_, { schema }));
  } finally {
    delete process.env.AQUATECH_ALLOW_NEWER_SCHEMA;
  }
});
