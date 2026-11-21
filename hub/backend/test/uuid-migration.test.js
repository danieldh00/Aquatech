// Migratie 97: id's en verwijzingen naar id's gaan van tekst naar uuid, ook als er oude, niet-UUID-waarden in staan.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { openPg } = require('../src/database/pgdb');
const { PG_MIGRATIONS } = require('../src/database/pgschema');

const URL_ = process.env.TEST_DATABASE_URL;
const needPg = { skip: !URL_ && 'zet TEST_DATABASE_URL voor tests tegen PostgreSQL' };
const MD5_PREFIX = 'aquatech-uuid:';

/**
 * Het UUID dat de migratie voor een niet-UUID-waarde afleidt.
 * @param {string} value De oude waarde.
 * @returns {string} De afgeleide UUID.
 */
function derived(value) {
  const hex = crypto.createHash('md5').update(MD5_PREFIX + value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test('migratie 97: bestaande gegevens blijven kloppen, verwijzingen blijven werken en ongeldige verwijzingen worden geweigerd', needPg, () => {
  const schema = `aqt_test_${crypto.randomBytes(8).toString('hex')}`;
  const last = PG_MIGRATIONS.pop();
  let db;
  try {
    db = openPg(URL_, { schema });
    const goodTenant = crypto.randomUUID();
    const goodUser = crypto.randomUUID();
    db.prepare('INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, ?)').run(goodTenant, 'goed', 'Goed', new Date().toISOString());
    db.prepare('INSERT INTO tenants (id, slug, name, created_at, parent_id) VALUES (?, ?, ?, ?, ?)').run('oude-tenant', 'oud', 'Oud', new Date().toISOString(), goodTenant);
    for (const [id, tenant] of [[goodUser, goodTenant], ['oude-gebruiker', 'oude-tenant']]) {
      db.prepare("INSERT INTO users (id, tenant_id, username, display_name, role, kind, created_at) VALUES (?, ?, ?, 'X', 'klant', 'gast', ?)").run(id, tenant, `u-${id.slice(0, 6)}`, new Date().toISOString());
    }
    db.prepare("INSERT INTO plans (id, tenant_id, owner_id, title, data, created_at, updated_at) VALUES ('oud-plan', 'oude-tenant', 'oude-gebruiker', 'T', '{}', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    PG_MIGRATIONS.push(last);
    db.close?.();
    db = openPg(URL_, { schema });

    const columnType = db.prepare("SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'plans' AND column_name = 'owner_id'").get().data_type;
    assert.strictEqual(columnType, 'uuid');
    assert.strictEqual(db.prepare('SELECT id FROM tenants WHERE slug = ?').get('goed').id, goodTenant, 'een geldig UUID blijft gelijk');
    assert.strictEqual(db.prepare('SELECT id FROM tenants WHERE slug = ?').get('oud').id, derived('oude-tenant'));
    assert.strictEqual(db.prepare('SELECT parent_id FROM tenants WHERE slug = ?').get('oud').parent_id, goodTenant);
    const plan = db.prepare('SELECT p.id, p.tenant_id, p.owner_id, u.tenant_id AS owner_tenant FROM plans p JOIN users u ON u.id = p.owner_id').get();
    assert.strictEqual(plan.id, derived('oud-plan'));
    assert.strictEqual(plan.owner_id, derived('oude-gebruiker'));
    assert.strictEqual(plan.tenant_id, derived('oude-tenant'));
    assert.strictEqual(plan.owner_tenant, derived('oude-tenant'));
    assert.throws(() => db.prepare("INSERT INTO plans (id, tenant_id, owner_id, title, data, created_at, updated_at) VALUES (?, ?, ?, 'T', '{}', ?, ?)")
      .run(crypto.randomUUID(), goodTenant, crypto.randomUUID(), new Date().toISOString(), new Date().toISOString()), /foreign key|violates/i, 'de foreign keys zijn terug');
    assert.strictEqual(db.prepare('SELECT id FROM plans WHERE id = ?').get('geen-uuid'), undefined, 'een tekst die geen UUID is, vindt nooit een rij');
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM pg_constraint WHERE contype = ? AND connamespace = current_schema()::regnamespace').get('f').n > 50, true);
  } finally {
    if (PG_MIGRATIONS[PG_MIGRATIONS.length - 1] !== last) PG_MIGRATIONS.push(last);
  }
});

test('legacyUuid: hetzelfde afleiden als de migratie, een uuid blijft gelijk en lege tekst wordt NULL', () => {
  const { legacyUuid } = require('../src/database/pgschema');
  const given = crypto.randomUUID();
  assert.strictEqual(legacyUuid(given), given);
  assert.strictEqual(legacyUuid(given.toUpperCase()), given.toUpperCase());
  assert.strictEqual(legacyUuid(''), null);
  assert.strictEqual(legacyUuid(null), null);
  assert.strictEqual(legacyUuid('oude-tenant'), derived('oude-tenant'));
});

test('een INSERT … RETURNING met een ongeldig uuid blijft een fout, een SELECT geeft niets', async () => {
  const { toleratesInvalidUuid } = require('../src/database/pg-pool');
  assert.equal(toleratesInvalidUuid('SELECT id FROM users WHERE id = ?'), true);
  assert.equal(toleratesInvalidUuid('UPDATE users SET name = ? WHERE id = ? RETURNING id'), true);
  assert.equal(toleratesInvalidUuid('INSERT INTO users (id) VALUES (?) RETURNING id'), false);
  assert.equal(toleratesInvalidUuid('WITH x AS (INSERT INTO users (id) VALUES (?) RETURNING id) SELECT * FROM x'), false);
});
