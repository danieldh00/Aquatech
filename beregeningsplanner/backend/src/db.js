// SQLite-database van de app (node:sqlite, ingebouwd in Node 22: geen native
// npm-module nodig, dus geen multi-arch-bouwproblemen).
//
// Het datamodel is tenant-klaar: elke tabel heeft een tenant_id en elke query
// filtert daarop. Voorlopig is er één tenant ("default"); bij
// de overstap naar een gedeelde server komen er tenants bij zonder dat het
// schema verandert. Id's zijn willekeurige UUID's (niet te raden en later
// zonder hernummeren over te zetten naar een andere database).
const fs = require('fs');
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
  // Sessies op de server (uitloggen en intrekken werkt meteen) en het
  // auditlog met beveiligingsgebeurtenissen. Van een sessietoken staat alleen
  // de SHA-256-hash in de database.
  `
  CREATE TABLE sessions (
    id_hash      TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id),
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    via          TEXT NOT NULL CHECK (via IN ('user', 'code')),
    fingerprint  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    ip           TEXT NOT NULL DEFAULT '',
    user_agent   TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions (tenant_id, user_id);

  CREATE TABLE audit (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id),
    user_id    TEXT REFERENCES users(id),
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '{}',
    ip         TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX audit_tenant ON audit (tenant_id, created_at);
  `,
  // Offertes (module Offertes). Het offertenummer is uniek per tenant; een
  // offerte verwijst naar het plan waaruit ze is opgebouwd, zonder foreign
  // key (de offerte blijft bestaan als het plan wordt gewist).
  `
  CREATE TABLE quotes (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id),
    owner_id   TEXT NOT NULL REFERENCES users(id),
    plan_id    TEXT,
    number     TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'concept' CHECK (status IN ('concept', 'verzonden', 'akkoord', 'afgewezen')),
    title      TEXT NOT NULL DEFAULT '',
    customer   TEXT NOT NULL DEFAULT '',
    total_excl REAL NOT NULL DEFAULT 0,
    total_incl REAL NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (tenant_id, number)
  );
  CREATE INDEX quotes_owner ON quotes (tenant_id, owner_id, updated_at);
  CREATE INDEX quotes_plan ON quotes (tenant_id, plan_id);
  `,
];

function openDb(file = ':memory:') {
  const onDisk = file !== ':memory:';
  if (onDisk) {
    // Alleen het eigen proces mag de database lezen (ook de journal-bestanden,
    // die met dezelfde rechten worden aangemaakt).
    process.umask(0o077);
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // Verwijderde gegevens worden overschreven in plaats van alleen vrijgegeven
  // (wissen volgens de AVG laat zo geen resten achter in het bestand).
  db.exec('PRAGMA secure_delete = ON');
  // Geen SQL-functies uit het schema zelf uitvoeren (bescherming tegen een
  // gemanipuleerd databasebestand).
  db.exec('PRAGMA trusted_schema = OFF');
  if (onDisk) {
    const check = db.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]);
    if (check.join() !== 'ok') console.error(`Database-controle meldt problemen: ${check.slice(0, 5).join('; ')}`);
  }
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
