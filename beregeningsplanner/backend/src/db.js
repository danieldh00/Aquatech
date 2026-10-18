// SQLite-database van de app (node:sqlite, ingebouwd in Node 22: geen native
// npm-module nodig, dus geen multi-arch-bouwproblemen).
//
// Het datamodel is tenant-klaar: elke tabel heeft een tenant_id en elke query
// filtert daarop. Voorlopig is er één tenant ("default"); bij
// de overstap naar een gedeelde server komen er tenants bij zonder dat het
// schema verandert. Id's zijn willekeurige UUID's (niet te raden en later
// zonder hernummeren over te zetten naar een andere database).
const { DatabaseSync } = require('node:sqlite');

// Elke migratie verhoogt PRAGMA user_version met één. Nooit een bestaande
// migratie aanpassen; altijd een nieuwe toevoegen.
const MIGRATIONS = [
  `
  CREATE TABLE tenants (
    id         TEXT PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- kind: 'account' (gebruikersnaam + wachtwoord), 'gast' (anoniem, per
  -- browser) of 'systeem' (Home Assistant-paneel, toegangscode).
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL REFERENCES tenants(id),
    username      TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('beheerder', 'gebruiker')),
    kind          TEXT NOT NULL CHECK (kind IN ('account', 'gast', 'systeem')),
    password_hash TEXT,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT,
    UNIQUE (tenant_id, username)
  );

  CREATE TABLE plans (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id),
    owner_id   TEXT NOT NULL REFERENCES users(id),
    title      TEXT NOT NULL,
    customer   TEXT NOT NULL DEFAULT '',
    address    TEXT NOT NULL DEFAULT '',
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX plans_owner ON plans (tenant_id, owner_id, updated_at);

  -- Historie van de aanvragen: alleen toevoegen (en een recente regel van
  -- dezelfde gebruiker bijwerken), nooit verwijderen. Een regel blijft staan
  -- als het plan later verwijderd wordt; daarom geen foreign key op plan_id
  -- en een eigen kopie van het plan (snapshot, zonder achtergrondafbeelding).
  CREATE TABLE history (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id),
    user_id    TEXT REFERENCES users(id),
    plan_id    TEXT,
    action     TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    customer   TEXT NOT NULL DEFAULT '',
    address    TEXT NOT NULL DEFAULT '',
    summary    TEXT NOT NULL DEFAULT '{}',
    snapshot   TEXT,
    ip         TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX history_tenant ON history (tenant_id, updated_at);
  CREATE INDEX history_plan ON history (tenant_id, plan_id, updated_at);
  `,
  // Instellingen per tenant (Beheer > Instellingen), waarde als JSON.
  `
  CREATE TABLE settings (
    tenant_id  TEXT NOT NULL REFERENCES tenants(id),
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id),
    PRIMARY KEY (tenant_id, key)
  );
  `,
];

function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, transaction, MIGRATIONS };
