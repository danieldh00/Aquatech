// Database van de app. Standaard SQLite (node:sqlite, ingebouwd in Node 22:
// geen native npm-module nodig, dus geen multi-arch-bouwproblemen); met
// DATABASE_URL PostgreSQL, bijv. Supabase (pgdb.js, schema in pgschema.js).
// Beide werken via dezelfde synchrone interface (prepare/get/all/run/exec).
//
// Multitenant: elke tabel heeft een tenant_id en elke query filtert daarop.
// De hoofdtenant ("default") bestaat altijd; andere tenants en hun
// testomgevingen (eigen tenant met parent_id) maakt een hoofdbeheerder aan.
// Id's zijn willekeurige UUID's (niet te raden en zonder hernummeren over te
// zetten naar een andere database, zie db-copy.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
  // 12: gebruiker moet bij de volgende aanmelding zelf een nieuw wachtwoord kiezen.
  `
  ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
  `,
  // 13: planning en klantlink van werkorders. De klant ziet via een openbare
  // link (net als de digitale offerte: SHA-256 van het token om op te zoeken,
  // het token versleuteld) wanneer de afspraak staat en bevestigt die of
  // vraagt een ander moment. appointment = JSON-logboek van die reacties.
  `
  ALTER TABLE work_orders ADD COLUMN share_hash TEXT;
  ALTER TABLE work_orders ADD COLUMN share_token TEXT;
  ALTER TABLE work_orders ADD COLUMN share_url TEXT;
  ALTER TABLE work_orders ADD COLUMN shared_at TEXT;
  ALTER TABLE work_orders ADD COLUMN viewed_at TEXT;
  ALTER TABLE work_orders ADD COLUMN sent_at TEXT;
  ALTER TABLE work_orders ADD COLUMN sent_to TEXT;
  ALTER TABLE work_orders ADD COLUMN appointment TEXT;
  CREATE UNIQUE INDEX work_orders_share ON work_orders (share_hash) WHERE share_hash IS NOT NULL;
  CREATE INDEX work_orders_planned ON work_orders (tenant_id, planned_date);
  `,
  // 14: foto's bij werkorders (klantdossier: hoe een installatie is
  // opgeleverd). Afbeelding en miniatuur versleuteld (vault.sealBytes, AAD
  // tenant + foto-id); geen BLOB, zodat SQLite en PostgreSQL gelijk blijven.
  `
  CREATE TABLE work_order_photos (
    id               TEXT PRIMARY KEY,
    tenant_id        TEXT NOT NULL REFERENCES tenants(id),
    work_order_id    TEXT NOT NULL REFERENCES work_orders(id),
    uploaded_by      TEXT REFERENCES users(id),
    kind             TEXT NOT NULL DEFAULT 'oplevering' CHECK (kind IN ('voor', 'tijdens', 'oplevering')),
    caption          TEXT NOT NULL DEFAULT '',
    customer_visible INTEGER NOT NULL DEFAULT 1,
    mime             TEXT NOT NULL,
    width            INTEGER,
    height           INTEGER,
    size             INTEGER NOT NULL,
    taken_at         TEXT,
    image            TEXT NOT NULL,
    thumb            TEXT NOT NULL,
    created_at       TEXT NOT NULL
  );
  CREATE INDEX work_order_photos_wo ON work_order_photos (tenant_id, work_order_id, created_at);
  `,
  // 15: Mijn profiel: contactgegevens en persoonlijke voorkeuren (JSON) per
  // gebruiker.
  `
  ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}';
  `,
  // 16: indexen voor wat zonder tenant of op andere kolommen zoekt: historie
  // en plannen per gebruiker (gebruikersbeheer, verwijderen), het startscherm
  // per uitvoerder, verlopen sessies (elk uur) en impersonaties per gebruiker.
  `
  CREATE INDEX history_user ON history (user_id);
  CREATE INDEX plans_owner_only ON plans (owner_id);
  CREATE INDEX work_orders_assignee ON work_orders (tenant_id, assignee_id, planned_date);
  CREATE INDEX sessions_expires ON sessions (expires_at);
  CREATE INDEX impersonations_user ON impersonations (user_id);
  `,
  // 17: opdrachten uitbesteden aan een andere organisatie op het platform.
  // tenant_id = de uitbestedende omgeving; to_tenant_id leeg = aan iedereen
  // die opdrachten ontvangt. Na acceptatie staat de kopie in de omgeving van
  // de ontvanger (receiver_tenant_id, received_work_order_id). Geen foreign
  // keys naar de andere organisatie: die kan los worden gewist.
  `
  CREATE TABLE work_order_offers (
    id                     TEXT PRIMARY KEY,
    tenant_id              TEXT NOT NULL REFERENCES tenants(id),
    work_order_id          TEXT NOT NULL,
    to_tenant_id           TEXT,
    status                 TEXT NOT NULL DEFAULT 'aangeboden' CHECK (status IN ('aangeboden', 'geaccepteerd', 'afgewezen', 'ingetrokken')),
    message                TEXT NOT NULL DEFAULT '',
    fee                    REAL,
    preview                TEXT NOT NULL,
    from_name              TEXT NOT NULL DEFAULT '',
    created_by             TEXT,
    created_by_name        TEXT NOT NULL DEFAULT '',
    declined               TEXT NOT NULL DEFAULT '[]',
    receiver_tenant_id     TEXT,
    receiver_name          TEXT NOT NULL DEFAULT '',
    received_work_order_id TEXT,
    responded_by_name      TEXT NOT NULL DEFAULT '',
    responded_at           TEXT,
    reason                 TEXT NOT NULL DEFAULT '',
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
  );
  CREATE INDEX work_order_offers_wo ON work_order_offers (tenant_id, work_order_id);
  CREATE INDEX work_order_offers_open ON work_order_offers (status, to_tenant_id);
  CREATE INDEX work_order_offers_receiver ON work_order_offers (receiver_tenant_id, received_work_order_id);
  `,
  // 18: rollen per organisatie (Beheer > Rollen, zie roles.js): aanpassingen
  // van de standaardrollen en eigen rollen, bij de live-tenant. users.role is
  // daarmee een vrije sleutel; de CHECK erop kan in SQLite alleen weg door de
  // tabel opnieuw op te bouwen (kolommen in dezelfde volgorde).
  {
    foreignKeysOff: true,
    sql: `
  CREATE TABLE roles (
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    role_key    TEXT NOT NULL,
    label       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL CHECK (kind IN ('medewerker', 'klant')),
    rights      TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (tenant_id, role_key)
  );

  CREATE TABLE users_new (
    id                   TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL REFERENCES tenants(id),
    username             TEXT NOT NULL,
    display_name         TEXT NOT NULL,
    role                 TEXT NOT NULL,
    kind                 TEXT NOT NULL CHECK (kind IN ('account', 'gast', 'systeem')),
    password_hash        TEXT,
    disabled             INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    last_seen_at         TEXT,
    platform_admin       INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    email                TEXT NOT NULL DEFAULT '',
    phone                TEXT NOT NULL DEFAULT '',
    preferences          TEXT NOT NULL DEFAULT '{}',
    UNIQUE (tenant_id, username)
  );
  INSERT INTO users_new SELECT id, tenant_id, username, display_name, role, kind, password_hash, disabled, created_at, last_seen_at,
    platform_admin, must_change_password, email, phone, preferences FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  `,
  },
  // 19: nieuwsberichten van de organisatie (pagina Nieuws, zie news.js).
  // Geen foreign key naar de auteur: bij het verwijderen van de gebruiker
  // wordt author_id leeg, de naam blijft bij het bericht staan.
  `
  CREATE TABLE news (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    audience    TEXT NOT NULL DEFAULT 'medewerkers' CHECK (audience IN ('medewerkers', 'iedereen')),
    pinned      INTEGER NOT NULL DEFAULT 0,
    author_id   TEXT,
    author_name TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX news_tenant ON news (tenant_id, created_at);
  `,
  // 20: controle van plannen. Een plan van een klant (ook een tekening die
  // zonder inloggen is ingediend, submitted_via 'openbaar') is nooit meteen
  // definitief: een installateur keurt het goed. review_status = concept |
  // ter_controle | goedgekeurd; bestaande plannen van medewerkers gelden als
  // goedgekeurd. reviewed_by zonder foreign key (gebruiker kan weg).
  `
  ALTER TABLE plans ADD COLUMN review_status TEXT NOT NULL DEFAULT 'concept';
  ALTER TABLE plans ADD COLUMN review_question TEXT NOT NULL DEFAULT '';
  ALTER TABLE plans ADD COLUMN review_requested_at TEXT;
  ALTER TABLE plans ADD COLUMN reviewed_by TEXT;
  ALTER TABLE plans ADD COLUMN reviewed_at TEXT;
  ALTER TABLE plans ADD COLUMN submitted_via TEXT NOT NULL DEFAULT '';
  UPDATE plans SET review_status = 'goedgekeurd', reviewed_at = updated_at
    WHERE owner_id IN (SELECT id FROM users WHERE kind IN ('account', 'systeem') AND role IN ('beheerder', 'installateur'));
  CREATE INDEX plans_review ON plans (tenant_id, review_status, updated_at);
  `,
  // 21: verbruik en kosten van elk AI-verzoek (Beheer > AI-kosten, zie
  // ai-usage.js). user_id zonder foreign key: de regel blijft na het
  // verwijderen van de gebruiker. Kosten in miljoensten (dollar en euro,
  // met de koers van dat moment), zodat sommen exact blijven.
  `
  CREATE TABLE ai_usage (
    id                 TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES tenants(id),
    user_id            TEXT,
    feature            TEXT NOT NULL,
    model              TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'ok',
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms        INTEGER NOT NULL DEFAULT 0,
    cost_usd_micro     INTEGER NOT NULL DEFAULT 0,
    cost_eur_micro     INTEGER NOT NULL DEFAULT 0,
    detail             TEXT NOT NULL DEFAULT '{}',
    created_at         TEXT NOT NULL
  );
  CREATE INDEX ai_usage_tenant ON ai_usage (tenant_id, created_at);
  CREATE INDEX ai_usage_created ON ai_usage (created_at);
  `,
  // 22: herkende plannen (zie recognitions.js). Een AI-herkenning wordt per
  // tekening (SHA-256 van de afbeelding) bewaard, zodat dezelfde tekening
  // altijd hetzelfde resultaat geeft. Daarnaast kleurtellingen (samples) van
  // AI-herkenningen en goedgekeurde plannen, waarvan de lokale herkenning
  // leert. Geen afbeelding in de tabel.
  `
  CREATE TABLE plan_recognitions (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    user_id     TEXT,
    source      TEXT NOT NULL,
    image_hash  TEXT NOT NULL DEFAULT '',
    plan_id     TEXT,
    model       TEXT NOT NULL DEFAULT '',
    version     TEXT NOT NULL DEFAULT '',
    result      TEXT NOT NULL DEFAULT '',
    samples     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX plan_recognitions_hash ON plan_recognitions (tenant_id, image_hash);
  CREATE INDEX plan_recognitions_plan ON plan_recognitions (tenant_id, plan_id);
  CREATE INDEX plan_recognitions_created ON plan_recognitions (tenant_id, created_at);
  `,
  // 23: werkregistratie (zie worklog.js): uren en materiaalverbruik die de
  // ploeg op een werkorder boekt. user_id zonder foreign key (de gebruiker
  // kan weg; de naam blijft in user_name voor de urenstaat). client_id = id
  // uit de browser, zodat een regel die opnieuw wordt verstuurd (offline,
  // opnieuw proberen) maar één keer telt. stock_movement_id = de afboeking
  // in de voorraad (voorraadbeheer), leeg zolang er niets is afgeboekt.
  `
  CREATE TABLE work_order_hours (
    id             TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL REFERENCES tenants(id),
    work_order_id  TEXT NOT NULL REFERENCES work_orders(id),
    user_id        TEXT,
    user_name      TEXT NOT NULL DEFAULT '',
    work_date      TEXT NOT NULL,
    start_time     TEXT NOT NULL DEFAULT '',
    end_time       TEXT NOT NULL DEFAULT '',
    break_minutes  INTEGER NOT NULL DEFAULT 0,
    minutes        INTEGER NOT NULL,
    kind           TEXT NOT NULL DEFAULT 'werk',
    step_id        TEXT NOT NULL DEFAULT '',
    note           TEXT NOT NULL DEFAULT '',
    client_id      TEXT,
    created_by     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX work_order_hours_wo ON work_order_hours (tenant_id, work_order_id, work_date);
  CREATE INDEX work_order_hours_date ON work_order_hours (tenant_id, work_date);
  CREATE UNIQUE INDEX work_order_hours_client ON work_order_hours (tenant_id, client_id);
  CREATE TABLE work_order_materials (
    id                 TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES tenants(id),
    work_order_id      TEXT NOT NULL REFERENCES work_orders(id),
    user_id            TEXT,
    user_name          TEXT NOT NULL DEFAULT '',
    used_on            TEXT NOT NULL,
    code               TEXT NOT NULL DEFAULT '',
    description        TEXT NOT NULL DEFAULT '',
    unit               TEXT NOT NULL DEFAULT '',
    qty                REAL NOT NULL,
    material_id        TEXT NOT NULL DEFAULT '',
    note               TEXT NOT NULL DEFAULT '',
    client_id          TEXT,
    stock_movement_id  TEXT,
    created_by         TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );
  CREATE INDEX work_order_materials_wo ON work_order_materials (tenant_id, work_order_id, used_on);
  CREATE INDEX work_order_materials_date ON work_order_materials (tenant_id, used_on);
  CREATE UNIQUE INDEX work_order_materials_client ON work_order_materials (tenant_id, client_id);
  `,
  // 24: voorraadbeheer (zie stock.js). Artikelen per omgeving met de stand
  // (on_hand, bijgehouden bij elke mutatie), het logboek van mutaties
  // (ontvangst, afboeking op een werkorder, retour, correctie, telling) en de
  // reserveringen per werkorder (afgeleid van de materiaallijst). Geen
  // foreign key naar werkorders of gebruikers: het logboek blijft staan.
  `
  CREATE TABLE stock_items (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    code        TEXT NOT NULL,
    name        TEXT NOT NULL,
    unit        TEXT NOT NULL DEFAULT 'st',
    location    TEXT NOT NULL DEFAULT '',
    min_qty     REAL NOT NULL DEFAULT 0,
    on_hand     REAL NOT NULL DEFAULT 0,
    cost_price  REAL,
    notes       TEXT NOT NULL DEFAULT '',
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (tenant_id, code)
  );
  CREATE TABLE stock_movements (
    id                TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL REFERENCES tenants(id),
    item_id           TEXT NOT NULL REFERENCES stock_items(id),
    kind              TEXT NOT NULL CHECK (kind IN ('ontvangst', 'afboeking', 'retour', 'correctie', 'telling')),
    qty               REAL NOT NULL,
    balance           REAL NOT NULL,
    work_order_id     TEXT,
    work_order_number TEXT NOT NULL DEFAULT '',
    source            TEXT NOT NULL DEFAULT '',
    note              TEXT NOT NULL DEFAULT '',
    user_id           TEXT,
    user_name         TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL
  );
  CREATE INDEX stock_movements_item ON stock_movements (tenant_id, item_id, created_at);
  CREATE INDEX stock_movements_created ON stock_movements (tenant_id, created_at);
  CREATE INDEX stock_movements_wo ON stock_movements (tenant_id, work_order_id);
  CREATE INDEX stock_movements_source ON stock_movements (tenant_id, source);
  CREATE TABLE stock_reservations (
    tenant_id     TEXT NOT NULL REFERENCES tenants(id),
    work_order_id TEXT NOT NULL,
    item_id       TEXT NOT NULL REFERENCES stock_items(id),
    qty           REAL NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (tenant_id, work_order_id, item_id)
  );
  CREATE INDEX stock_reservations_item ON stock_reservations (tenant_id, item_id);
  `,
  // 25: meldingen van klanten (storing of onderhoudsverzoek) via het
  // klantportaal, zie service-requests.js. customer_id, handled_by en
  // work_order_id zonder foreign key: de melding blijft staan als het account
  // of de werkorder verdwijnt. installation_id = de werkorder van de
  // installatie waar de melding over gaat. Foto's van de klant versleuteld
  // (vault.sealBytes) in een eigen tabel.
  `
  CREATE TABLE service_requests (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    number          TEXT NOT NULL,
    customer_id     TEXT,
    customer_name   TEXT NOT NULL DEFAULT '',
    kind            TEXT NOT NULL DEFAULT 'storing' CHECK (kind IN ('storing', 'onderhoud', 'overig')),
    urgent          INTEGER NOT NULL DEFAULT 0,
    subject         TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    address         TEXT NOT NULL DEFAULT '',
    phone           TEXT NOT NULL DEFAULT '',
    email           TEXT NOT NULL DEFAULT '',
    preferred       TEXT NOT NULL DEFAULT '',
    installation_id TEXT,
    status          TEXT NOT NULL DEFAULT 'nieuw' CHECK (status IN ('nieuw', 'in_behandeling', 'ingepland', 'afgehandeld', 'afgewezen', 'ingetrokken')),
    reply           TEXT NOT NULL DEFAULT '',
    note            TEXT NOT NULL DEFAULT '',
    handled_by      TEXT,
    handled_by_name TEXT NOT NULL DEFAULT '',
    work_order_id   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (tenant_id, number)
  );
  CREATE INDEX service_requests_status ON service_requests (tenant_id, status, created_at);
  CREATE INDEX service_requests_customer ON service_requests (tenant_id, customer_id, created_at);
  CREATE INDEX service_requests_wo ON service_requests (tenant_id, work_order_id);
  CREATE TABLE service_request_photos (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id),
    request_id TEXT NOT NULL REFERENCES service_requests(id),
    mime       TEXT NOT NULL,
    width      INTEGER,
    height     INTEGER,
    size       INTEGER NOT NULL,
    image      TEXT NOT NULL,
    thumb      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX service_request_photos_req ON service_request_photos (tenant_id, request_id, created_at);
  `,
  // 26: artikelen met verkoopprijs, btw en omzetgroep (Aquatech als bron voor
  // de webshop, zie shop.js syncStock) en facturen (invoices.js). shop_*_seen
  // = prijs/voorraad zoals de webshop ze na de laatste synchronisatie had:
  // een verschil daarmee is een wijziging of verkoop in de webshop.
  // shop_dirty = nog naar de webshop te sturen. Een factuur krijgt pas een
  // nummer als hij definitief wordt (doorlopende nummering per jaar).
  `
  ALTER TABLE stock_items ADD COLUMN sale_price REAL;
  ALTER TABLE stock_items ADD COLUMN vat_rate INTEGER NOT NULL DEFAULT 21;
  ALTER TABLE stock_items ADD COLUMN revenue_group TEXT NOT NULL DEFAULT 'producten';
  ALTER TABLE stock_items ADD COLUMN shop_sync INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE stock_items ADD COLUMN shop_product_id TEXT;
  ALTER TABLE stock_items ADD COLUMN shop_dirty INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE stock_items ADD COLUMN shop_price_seen REAL;
  ALTER TABLE stock_items ADD COLUMN shop_stock_seen REAL;
  ALTER TABLE stock_items ADD COLUMN shop_synced_at TEXT;
  ALTER TABLE stock_items ADD COLUMN shop_error TEXT NOT NULL DEFAULT '';
  CREATE INDEX stock_items_dirty ON stock_items (tenant_id, shop_dirty);
  CREATE TABLE invoices (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL REFERENCES tenants(id),
    number        TEXT,
    status        TEXT NOT NULL DEFAULT 'concept' CHECK (status IN ('concept', 'definitief', 'betaald')),
    kind          TEXT NOT NULL DEFAULT 'factuur' CHECK (kind IN ('factuur', 'credit')),
    credit_of     TEXT,
    customer_id   TEXT,
    customer_name TEXT NOT NULL DEFAULT '',
    work_order_id TEXT,
    quote_id      TEXT,
    invoice_date  TEXT NOT NULL,
    due_date      TEXT NOT NULL,
    subtotal      REAL NOT NULL DEFAULT 0,
    vat_total     REAL NOT NULL DEFAULT 0,
    total         REAL NOT NULL DEFAULT 0,
    data          TEXT NOT NULL,
    stock_booked  INTEGER NOT NULL DEFAULT 0,
    finalized_at  TEXT,
    paid_at       TEXT,
    credited_at   TEXT,
    exported_at   TEXT,
    created_by    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (tenant_id, number)
  );
  CREATE INDEX invoices_date ON invoices (tenant_id, invoice_date);
  CREATE INDEX invoices_status ON invoices (tenant_id, status, invoice_date);
  CREATE INDEX invoices_wo ON invoices (tenant_id, work_order_id);
  `,
  // 27: debiteuren (klanten van de facturen; later ook naar de boekhouding),
  // facturen uit webshopbestellingen (shop_order_id, één factuur per
  // bestelling) en verzonden per e-mail (sent_*). De stand van het ophalen
  // van bestellingen staat bij shop_sync.
  `
  CREATE TABLE debtors (
    id               TEXT PRIMARY KEY,
    tenant_id        TEXT NOT NULL REFERENCES tenants(id),
    number           INTEGER NOT NULL,
    name             TEXT NOT NULL DEFAULT '',
    contact          TEXT NOT NULL DEFAULT '',
    address          TEXT NOT NULL DEFAULT '',
    email            TEXT NOT NULL DEFAULT '',
    phone            TEXT NOT NULL DEFAULT '',
    vat_number       TEXT NOT NULL DEFAULT '',
    match_key        TEXT NOT NULL DEFAULT '',
    customer_id      TEXT,
    shop_customer_id TEXT,
    source           TEXT NOT NULL DEFAULT 'factuur',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (tenant_id, number)
  );
  CREATE INDEX debtors_match ON debtors (tenant_id, match_key);
  CREATE INDEX debtors_name ON debtors (tenant_id, name);
  ALTER TABLE invoices ADD COLUMN debtor_id TEXT;
  ALTER TABLE invoices ADD COLUMN shop_order_id TEXT;
  ALTER TABLE invoices ADD COLUMN sent_at TEXT;
  ALTER TABLE invoices ADD COLUMN sent_to TEXT;
  ALTER TABLE invoices ADD COLUMN send_error TEXT NOT NULL DEFAULT '';
  CREATE UNIQUE INDEX invoices_shop_order ON invoices (tenant_id, shop_order_id) WHERE shop_order_id IS NOT NULL;
  CREATE INDEX invoices_debtor ON invoices (tenant_id, debtor_id);
  ALTER TABLE shop_sync ADD COLUMN orders_after TEXT;
  ALTER TABLE shop_sync ADD COLUMN orders_synced_at TEXT;
  ALTER TABLE shop_sync ADD COLUMN orders_error TEXT;
  `,
  // 28: koppeling met Visma eAccounting (visma.js): de klant en de factuur
  // in Visma bij een debiteur en een factuur, en wanneer/fout bij het doorsturen.
  `
  ALTER TABLE debtors ADD COLUMN visma_customer_id TEXT;
  ALTER TABLE invoices ADD COLUMN visma_invoice_id TEXT;
  ALTER TABLE invoices ADD COLUMN visma_number TEXT;
  ALTER TABLE invoices ADD COLUMN visma_synced_at TEXT;
  ALTER TABLE invoices ADD COLUMN visma_error TEXT NOT NULL DEFAULT '';
  CREATE INDEX invoices_visma ON invoices (tenant_id, visma_invoice_id, invoice_date);
  `,
  // 29: sproeierbibliotheek per omgeving (sprinklers.js): eigen behuizingen en
  // nozzles bovenop de standaard uit frontend/beregening/js/sprinklerlib.js.
  `
  CREATE TABLE sprinkler_library (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id),
    kind       TEXT NOT NULL CHECK (kind IN ('body', 'nozzle')),
    key        TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT,
    UNIQUE (tenant_id, kind, key)
  );
  `,
  // 30: seizoensherinneringen (season-reminders.js): welke klant welke
  // herinnering in welk jaar al per mail kreeg (nooit twee keer dezelfde).
  `
  CREATE TABLE season_reminders_sent (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id),
    user_id      TEXT NOT NULL REFERENCES users(id),
    reminder_key TEXT NOT NULL,
    year         INTEGER NOT NULL,
    sent_at      TEXT NOT NULL,
    UNIQUE (tenant_id, user_id, reminder_key, year)
  );
  `,
];

/**
 * Opent een database voor de app of de tests: SQLite (bestand of :memory:),
 * of in de testsuite tegen PostgreSQL (TEST_DATABASE_URL) een eigen schema per
 * database (een bestand steeds hetzelfde schema).
 * @param {string} [file] Pad van het databasebestand, of ':memory:'.
 * @returns {object} De geopende en gemigreerde database.
 */
function openDb(file = ':memory:') {
  // Testsuite tegen PostgreSQL (TEST_DATABASE_URL): elke database wordt een
  // eigen schema, een bestand steeds hetzelfde schema.
  if (process.env.TEST_DATABASE_URL) return openTestPg(process.env.TEST_DATABASE_URL, file);
  return openSqlite(file);
}

/**
 * Opent altijd SQLite (bestand of :memory:), ook in de testsuite tegen
 * PostgreSQL. Zet de bestandsrechten op alleen-eigenaar, schakelt foreign keys,
 * secure_delete (AVG: geen resten in het bestand) en trusted_schema=OFF in,
 * controleert het bestand en voert de migraties uit.
 * @param {string} [file] Pad van het databasebestand, of ':memory:'.
 * @returns {DatabaseSync} De database (node:sqlite).
 */
function openSqlite(file = ':memory:') {
  const onDisk = file !== ':memory:';
  if (onDisk) {
    // Alleen het eigen proces mag de database lezen (ook de journal-bestanden,
    // die met dezelfde rechten worden aangemaakt).
    process.umask(0o077);
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
  }
  const db = new DatabaseSync(file);
  db.dialect = 'sqlite';
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // Verwijderde gegevens worden overschreven in plaats van alleen vrijgegeven
  // (wissen volgens de AVG laat zo geen resten achter in het bestand).
  db.exec('PRAGMA secure_delete = ON');
  // Geen SQL-functies uit het schema zelf uitvoeren (bescherming tegen een
  // gemanipuleerd databasebestand).
  db.exec('PRAGMA trusted_schema = OFF');
  if (onDisk) {
    const check = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
    if (check.join() !== 'ok') console.error(`Database-controle meldt problemen: ${check.slice(0, 5).join('; ')}`);
  }
  migrate(db);
  return db;
}

/**
 * Opent voor de testsuite een eigen schema in PostgreSQL per database.
 * @param {string} url De test-database-URL.
 * @param {string} file ':memory:' (elke keer een nieuw schema) of een pad (steeds hetzelfde schema).
 * @returns {object} De database in PostgreSQL.
 */
function openTestPg(url, file) {
  const { openPg } = require('./pgdb');
  const id = file === ':memory:' ? crypto.randomUUID() : path.resolve(file);
  return openPg(url, { schema: `aqt_test_${crypto.createHash('sha256').update(id).digest('hex').slice(0, 20)}` });
}

/**
 * De URL van PostgreSQL (bijv. Supabase) uit DATABASE_URL_FILE of DATABASE_URL.
 * @param {object} [env] Omgevingsvariabelen.
 * @returns {string} De URL, of '' als er geen is (dan SQLite).
 */
function databaseUrl(env = process.env) {
  if (env.DATABASE_URL_FILE) return fs.readFileSync(env.DATABASE_URL_FILE, 'utf8').trim();
  return String(env.DATABASE_URL || '').trim();
}

/**
 * De database van de server: PostgreSQL als DATABASE_URL of DATABASE_URL_FILE
 * gezet is, anders het SQLite-bestand aquatech.db in de datamap.
 * @param {string} dataDir Map met de gegevens van de app.
 * @param {object} [env] Omgevingsvariabelen.
 * @returns {object} De database.
 */
function openDatabase(dataDir, env = process.env) {
  const url = databaseUrl(env);
  if (url) return require('./pgdb').openPg(url, { schema: env.DATABASE_SCHEMA || 'aquatech' });
  return openDb(path.join(dataDir, 'aquatech.db'));
}

/**
 * Voert de migraties uit die nog niet zijn gedaan (PRAGMA user_version telt
 * mee). Een migratie met foreignKeysOff bouwt een tabel opnieuw op met foreign
 * keys uit (kan niet binnen een transactie); verbroken verwijzingen worden alleen
 * gemeld.
 * @param {DatabaseSync} db De SQLite-database.
 * @returns {void}
 */
function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let index = current; index < MIGRATIONS.length; index++) {
    const migration = typeof MIGRATIONS[index] === 'string' ? { sql: MIGRATIONS[index] } : MIGRATIONS[index];
    // Een tabel opnieuw opbouwen kan alleen met foreign keys uit (en dat kan
    // niet binnen een transactie). De rijen gaan één op één over, dus de
    // verwijzingen blijven kloppen; afwijkingen (ook van vroeger) alleen melden.
    if (migration.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(db, () => {
        db.exec(migration.sql);
        if (migration.foreignKeysOff) {
          const broken = db.prepare('PRAGMA foreign_key_check').all();
          if (broken.length) console.warn(`Migratie ${index + 1}: ${broken.length} verbroken verwijzing(en), eerste in ${broken[0].table}`);
        }
        db.exec(`PRAGMA user_version = ${index + 1}`);
      });
    } finally {
      if (migration.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

/**
 * Voert een functie uit binnen één transactie: COMMIT als hij slaagt, ROLLBACK bij een fout.
 * @param {object} db De database (SQLite of PostgreSQL).
 * @param {Function} callback De functie met de wijzigingen.
 * @returns {*} Wat de functie teruggeeft.
 */
function transaction(db, callback) {
  db.exec(isPg(db) ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    const out = callback();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- Verschillen tussen SQLite en PostgreSQL ----------
// De rest van de code schrijft SQL die in beide werkt (?-parameters, lower()
// i.p.v. COLLATE NOCASE); waar dat niet kan, helpen deze functies.
/**
 * Of de database PostgreSQL is (anders SQLite).
 * @param {object} db De database.
 * @returns {boolean} true bij PostgreSQL.
 */
const isPg = (db) => db.dialect === 'postgres';

/**
 * Schemaversie: het aantal uitgevoerde migraties.
 * @param {object} db De database.
 * @returns {number} De versie.
 */
function schemaVersion(db) {
  if (isPg(db)) return require('./pgdb').pgVersion(db);
  return db.prepare('PRAGMA user_version').get().user_version;
}

/**
 * Namen van de tabellen van de app (zonder interne tabellen).
 * @param {object} db De database.
 * @returns {string[]} Tabelnamen, alfabetisch.
 */
function listTables(db) {
  if (isPg(db)) {
    return db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_version' ORDER BY table_name")
      .all().map((row) => row.name);
  }
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
}

const SAFE_NAME = /^[a-z_][a-z0-9_]*$/;
/**
 * Controleert dat een tabelnaam veilig in SQL kan (alleen kleine letters, cijfers en _).
 * @param {string} name De tabelnaam.
 * @returns {string} Dezelfde naam.
 * @throws {Error} Bij een ongeldige naam.
 */
const checkName = (name) => { if (!SAFE_NAME.test(name)) throw new Error(`Ongeldige tabelnaam: ${name}`); return name; };

/**
 * Kolommen van een tabel, in volgorde.
 * @param {object} db De database.
 * @param {string} table Naam van de tabel.
 * @returns {{ name: string, notnull: boolean, pk: boolean }[]} De kolommen.
 */
function tableColumns(db, table) {
  if (isPg(db)) {
    return db.prepare(`SELECT c.column_name AS name, c.is_nullable = 'NO' AS notnull,
        EXISTS (SELECT 1 FROM information_schema.key_column_usage k JOIN information_schema.table_constraints tc
          ON tc.constraint_name = k.constraint_name AND tc.table_schema = k.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY' AND k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name) AS pk
      FROM information_schema.columns c WHERE c.table_schema = current_schema() AND c.table_name = ? ORDER BY c.ordinal_position`)
      .all(table).map((column) => ({ name: column.name, notnull: Boolean(column.notnull), pk: Boolean(column.pk) }));
  }
  return db.prepare(`PRAGMA table_info(${checkName(table)})`).all().map((column) => ({ name: column.name, notnull: Boolean(column.notnull), pk: column.pk > 0 }));
}

/**
 * Foreign keys van een tabel.
 * @param {object} db De database.
 * @param {string} table Naam van de tabel.
 * @returns {{ from: string, table: string }[]} Per foreign key de kolom en de doeltabel.
 */
function foreignKeys(db, table) {
  if (isPg(db)) {
    return db.prepare(`SELECT a.attname AS "from", cf.relname AS "table"
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_class cf ON cf.oid = c.confrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND n.nspname = current_schema() AND cl.relname = ?`).all(table);
  }
  return db.prepare(`PRAGMA foreign_key_list(${checkName(table)})`).all().map((foreignKey) => ({ from: foreignKey.from, table: foreignKey.table }));
}

/**
 * Laat foreign keys binnen de lopende transactie pas bij COMMIT controleren.
 * @param {object} db De database.
 * @returns {void}
 */
function deferForeignKeys(db) {
  db.exec(isPg(db) ? 'SET CONSTRAINTS ALL DEFERRED' : 'PRAGMA defer_foreign_keys = ON');
}

/**
 * SQL-expressie voor de tekstwaarde van een veld uit een JSON-kolom.
 * @param {object} db De database (bepaalt het dialect).
 * @param {string} expr SQL-expressie van de JSON-kolom.
 * @param {string} key Vaste veldnaam uit de code.
 * @returns {string} De SQL-expressie.
 */
const jsonField = (db, expr, key) => (isPg(db) ? `((${expr})::jsonb ->> '${key}')` : `json_extract(${expr}, '$.${key}')`);

/**
 * SQL-expressie voor de JSON-kolom zonder dit veld (als tekst).
 * @param {object} db De database (bepaalt het dialect).
 * @param {string} expr SQL-expressie van de JSON-kolom.
 * @param {string} key Vaste veldnaam uit de code.
 * @returns {string} De SQL-expressie.
 */
const jsonWithout = (db, expr, key) => (isPg(db) ? `(((${expr})::jsonb - '${key}')::text)` : `json_remove(${expr}, '$.${key}')`);

/**
 * SQL-expressie voor een klein JSON-object (als tekst) uit een grote JSON-kolom,
 * zodat een overzicht niet het hele document ophaalt. Sleutels zijn vaste
 * namen uit de code.
 * @param {object} db De database (bepaalt het dialect).
 * @param {string} expr SQL-expressie van de JSON-kolom.
 * @param {{ values?: string[], counts?: string[] }} [fields] values = velden die meegaan zoals ze zijn; counts = arrays waarvan alleen de lengte meegaat (0 als het geen array is).
 * @returns {string} De SQL-expressie.
 */
function jsonDigest(db, expr, { values = [], counts = [] } = {}) {
  if (isPg(db)) {
    const parts = [
      ...values.map((key) => `'${key}', j -> '${key}'`),
      ...counts.map((key) => `'${key}', CASE WHEN jsonb_typeof(j -> '${key}') = 'array' THEN jsonb_array_length(j -> '${key}') ELSE 0 END`),
    ];
    // OFFSET 0: anders vouwt PostgreSQL de subquery in en zet hij de kolom per
    // veld opnieuw om naar jsonb (bij een plan met achtergrond: megabytes).
    return `(SELECT jsonb_build_object(${parts.join(', ')})::text FROM (SELECT (${expr})::jsonb AS j OFFSET 0) AS digest)`;
  }
  const parts = [
    ...values.map((key) => `'${key}', json_extract(${expr}, '$.${key}')`),
    ...counts.map((key) => `'${key}', CASE WHEN json_type(${expr}, '$.${key}') = 'array' THEN json_array_length(${expr}, '$.${key}') ELSE 0 END`),
  ];
  return `json_object(${parts.join(', ')})`;
}

module.exports = {
  openDb, openSqlite, openDatabase, databaseUrl, transaction, MIGRATIONS,
  isPg, schemaVersion, listTables, tableColumns, foreignKeys, deferForeignKeys, jsonField, jsonWithout, jsonDigest,
};
