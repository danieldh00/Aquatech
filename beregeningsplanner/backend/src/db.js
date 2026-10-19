// SQLite-database van de app (node:sqlite, ingebouwd in Node 22: geen native
// npm-module nodig, dus geen multi-arch-bouwproblemen).
//
// Multitenant: elke tabel heeft een tenant_id en elke query filtert daarop.
// De hoofdtenant ("default") bestaat altijd; andere tenants en hun
// testomgevingen (eigen tenant met parent_id) maakt een hoofdbeheerder aan.
// Id's zijn willekeurige UUID's (niet te raden en later zonder hernummeren
// over te zetten naar een andere database).
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
  -- browser) of 'systeem' (toegangscode).
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
  // Multitenant: tenants met live- en testomgevingen. Een testomgeving is een
  // eigen tenant (eigen plannen, historie en instellingen) met parent_id naar
  // de live-tenant; de gebruikers horen bij de live-tenant. platform_admin =
  // hoofdbeheerder die alle tenants ziet en beheert. De beheerders van de
  // bestaande tenant worden hoofdbeheerder.
  `
  ALTER TABLE tenants ADD COLUMN environment TEXT NOT NULL DEFAULT 'live' CHECK (environment IN ('live', 'test'));
  ALTER TABLE tenants ADD COLUMN parent_id TEXT REFERENCES tenants(id);
  ALTER TABLE tenants ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tenants ADD COLUMN updated_at TEXT;
  ALTER TABLE users ADD COLUMN platform_admin INTEGER NOT NULL DEFAULT 0;
  UPDATE users SET platform_admin = 1
    WHERE kind = 'account' AND role = 'beheerder' AND disabled = 0
      AND tenant_id IN (SELECT id FROM tenants WHERE slug = 'default');
  CREATE INDEX tenants_parent ON tenants (parent_id);
  CREATE INDEX users_username ON users (username);
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
  // Rollen: beheerder, installateur en klant (zie frontend/shared/roles.js).
  // De CHECK op users.role is in SQLite niet aan te passen, dus de tabel wordt
  // opnieuw opgebouwd (met foreign keys tijdelijk uit, anders vallen de
  // verwijzingen vanuit plannen, sessies enz. om). Een bestaande 'gebruiker'
  // wordt installateur, een gast klant. Een offerte kan aan een klantaccount
  // gekoppeld worden (customer_id); die klant ziet de offerte dan zelf.
  {
    foreignKeysOff: true,
    sql: `
  CREATE TABLE users_new (
    id             TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL REFERENCES tenants(id),
    username       TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('beheerder', 'installateur', 'klant')),
    kind           TEXT NOT NULL CHECK (kind IN ('account', 'gast', 'systeem')),
    password_hash  TEXT,
    disabled       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    last_seen_at   TEXT,
    platform_admin INTEGER NOT NULL DEFAULT 0,
    UNIQUE (tenant_id, username)
  );
  INSERT INTO users_new (id, tenant_id, username, display_name, role, kind, password_hash, disabled, created_at, last_seen_at, platform_admin)
    SELECT id, tenant_id, username, display_name,
      CASE WHEN role = 'beheerder' THEN 'beheerder' WHEN kind = 'gast' THEN 'klant' ELSE 'installateur' END,
      kind, password_hash, disabled, created_at, last_seen_at, platform_admin
    FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  CREATE INDEX users_username ON users (username);

  ALTER TABLE quotes ADD COLUMN customer_id TEXT REFERENCES users(id);
  CREATE INDEX quotes_customer ON quotes (tenant_id, customer_id);
  `,
  },
  // Impersonatie: een hoofdbeheerder werkt tijdelijk als een gebruiker. In een
  // testomgeving zonder goedkeuring; in live alleen met een supporttoestemming
  // die de gebruiker zelf geeft (support_grants, tenant = eigen tenant van de
  // gebruiker). Een impersonatie hoort bij de omgeving waarin gewerkt wordt.
  `
  CREATE TABLE support_grants (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id),
    user_id    TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX support_grants_user ON support_grants (user_id, expires_at);

  CREATE TABLE impersonations (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id),
    admin_id     TEXT NOT NULL REFERENCES users(id),
    user_id      TEXT NOT NULL REFERENCES users(id),
    grant_id     TEXT REFERENCES support_grants(id),
    reason       TEXT NOT NULL DEFAULT '',
    started_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    ended_at     TEXT,
    ended_reason TEXT
  );
  CREATE INDEX impersonations_admin ON impersonations (admin_id, started_at);
  `,
  // Gebruikersnamen zijn uniek per tenant (UNIQUE (tenant_id, username) staat
  // al op de tabel); bij het inloggen kiest de organisatiecode de tenant. De
  // index voor zoeken op alleen de gebruikersnaam (over alle tenants) vervalt.
  `
  DROP INDEX IF EXISTS users_username;
  `,
  // Digitale offerte: een openbare link per offerte (alleen de SHA-256 van het
  // token om op te zoeken, het token zelf versleuteld om de link opnieuw te
  // tonen), bijhouden wanneer de klant die opende, en het vastgelegde akkoord
  // (naam, handtekening, tijd, IP, hash van de geaccordeerde inhoud) als JSON.
  `
  ALTER TABLE quotes ADD COLUMN share_hash TEXT;
  ALTER TABLE quotes ADD COLUMN share_token TEXT;
  ALTER TABLE quotes ADD COLUMN share_url TEXT;
  ALTER TABLE quotes ADD COLUMN shared_at TEXT;
  ALTER TABLE quotes ADD COLUMN viewed_at TEXT;
  ALTER TABLE quotes ADD COLUMN last_viewed_at TEXT;
  ALTER TABLE quotes ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE quotes ADD COLUMN sent_at TEXT;
  ALTER TABLE quotes ADD COLUMN sent_to TEXT;
  ALTER TABLE quotes ADD COLUMN responded_at TEXT;
  ALTER TABLE quotes ADD COLUMN acceptance TEXT;
  CREATE UNIQUE INDEX quotes_share ON quotes (share_hash) WHERE share_hash IS NOT NULL;
  `,
  // Werkorders (module Werkorders): ontstaan uit een geaccordeerde offerte.
  // Verwijzingen naar offerte en plan zonder foreign key (de werkorder blijft
  // bestaan als die worden gewist). Nummer uniek per tenant.
  `
  CREATE TABLE work_orders (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id),
    owner_id     TEXT NOT NULL REFERENCES users(id),
    quote_id     TEXT,
    plan_id      TEXT,
    number       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'gepland', 'bezig', 'gereed', 'geannuleerd')),
    title        TEXT NOT NULL DEFAULT '',
    customer     TEXT NOT NULL DEFAULT '',
    address      TEXT NOT NULL DEFAULT '',
    planned_date TEXT,
    assignee_id  TEXT REFERENCES users(id),
    data         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    deleted_at   TEXT,
    UNIQUE (tenant_id, number)
  );
  CREATE INDEX work_orders_tenant ON work_orders (tenant_id, updated_at);
  CREATE INDEX work_orders_quote ON work_orders (tenant_id, quote_id);
  `,
  // 11: webshopkoppeling: opgehaalde producten en de status van het ophalen per tenant.
  `
  CREATE TABLE shop_products (
    tenant_id  TEXT NOT NULL REFERENCES tenants(id),
    id         TEXT NOT NULL,
    sku        TEXT NOT NULL DEFAULT '',
    name       TEXT NOT NULL DEFAULT '',
    price      REAL,
    currency   TEXT NOT NULL DEFAULT 'EUR',
    url        TEXT NOT NULL DEFAULT '',
    image      TEXT NOT NULL DEFAULT '',
    in_stock   INTEGER NOT NULL DEFAULT 1,
    code       TEXT NOT NULL DEFAULT '',
    categories TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (tenant_id, id)
  );
  CREATE TABLE shop_sync (
    tenant_id       TEXT PRIMARY KEY REFERENCES tenants(id),
    synced_at       TEXT,
    product_count   INTEGER,
    last_attempt_at TEXT,
    last_error      TEXT
  );
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
    const m = typeof MIGRATIONS[v] === 'string' ? { sql: MIGRATIONS[v] } : MIGRATIONS[v];
    // Een tabel opnieuw opbouwen kan alleen met foreign keys uit (en dat kan
    // niet binnen een transactie). De rijen gaan één op één over, dus de
    // verwijzingen blijven kloppen; afwijkingen (ook van vroeger) alleen melden.
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(db, () => {
        db.exec(m.sql);
        if (m.foreignKeysOff) {
          const broken = db.prepare('PRAGMA foreign_key_check').all();
          if (broken.length) console.warn(`Migratie ${v + 1}: ${broken.length} verbroken verwijzing(en), eerste in ${broken[0].table}`);
        }
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    } finally {
      if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
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
