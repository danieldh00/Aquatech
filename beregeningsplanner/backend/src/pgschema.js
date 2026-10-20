// Schema van de app in PostgreSQL (bijv. Supabase), gelijk aan het
// SQLite-schema na alle migraties in db.js.
//
// Eén op één met SQLite:
// - tekst is TEXT COLLATE "C" (bytevolgorde, net als BINARY in SQLite), zodat
//   vergelijken, sorteren en UNIQUE zich hetzelfde gedragen;
// - INTEGER wordt BIGINT (SQLite-gehele getallen zijn 64-bits), REAL wordt
//   DOUBLE PRECISION (beide 8-byte IEEE);
// - dezelfde tabellen, kolommen (in dezelfde volgorde), CHECK's, standaard-
//   waarden, foreign keys en indexen. Foreign keys zijn DEFERRABLE, zodat een
//   transactie ze pas bij COMMIT kan laten controleren (zoals PRAGMA
//   defer_foreign_keys in SQLite).
//
// Nieuwe migratie: voeg hem toe aan MIGRATIONS in db.js én aan PG_MIGRATIONS
// hieronder (zelfde nummer). test/postgres.test.js vergelijkt beide schema's.
const T = 'TEXT COLLATE "C"';
const FK = (ref, extra = '') => `REFERENCES ${ref}${extra} DEFERRABLE INITIALLY IMMEDIATE`;

// Versie waarop het basisschema hieronder overeenkomt met SQLite.
const PG_BASE_VERSION = 12;

const PG_BASE = `
CREATE TABLE tenants (
  id          ${T} PRIMARY KEY,
  slug        ${T} NOT NULL UNIQUE,
  name        ${T} NOT NULL,
  created_at  ${T} NOT NULL,
  environment ${T} NOT NULL DEFAULT 'live' CHECK (environment IN ('live', 'test')),
  parent_id   ${T} ${FK('tenants(id)')},
  disabled    BIGINT NOT NULL DEFAULT 0,
  updated_at  ${T}
);
CREATE INDEX tenants_parent ON tenants (parent_id);

CREATE TABLE users (
  id                   ${T} PRIMARY KEY,
  tenant_id            ${T} NOT NULL ${FK('tenants(id)')},
  username             ${T} NOT NULL,
  display_name         ${T} NOT NULL,
  role                 ${T} NOT NULL CHECK (role IN ('beheerder', 'installateur', 'klant')),
  kind                 ${T} NOT NULL CHECK (kind IN ('account', 'gast', 'systeem')),
  password_hash        ${T},
  disabled             BIGINT NOT NULL DEFAULT 0,
  created_at           ${T} NOT NULL,
  last_seen_at         ${T},
  platform_admin       BIGINT NOT NULL DEFAULT 0,
  must_change_password BIGINT NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, username)
);

CREATE TABLE plans (
  id         ${T} PRIMARY KEY,
  tenant_id  ${T} NOT NULL ${FK('tenants(id)')},
  owner_id   ${T} NOT NULL ${FK('users(id)')},
  title      ${T} NOT NULL,
  customer   ${T} NOT NULL DEFAULT '',
  address    ${T} NOT NULL DEFAULT '',
  data       ${T} NOT NULL,
  created_at ${T} NOT NULL,
  updated_at ${T} NOT NULL,
  deleted_at ${T}
);
CREATE INDEX plans_owner ON plans (tenant_id, owner_id, updated_at);

CREATE TABLE history (
  id         ${T} PRIMARY KEY,
  tenant_id  ${T} NOT NULL ${FK('tenants(id)')},
  user_id    ${T} ${FK('users(id)')},
  plan_id    ${T},
  action     ${T} NOT NULL,
  title      ${T} NOT NULL DEFAULT '',
  customer   ${T} NOT NULL DEFAULT '',
  address    ${T} NOT NULL DEFAULT '',
  summary    ${T} NOT NULL DEFAULT '{}',
  snapshot   ${T},
  ip         ${T} NOT NULL DEFAULT '',
  created_at ${T} NOT NULL,
  updated_at ${T} NOT NULL
);
CREATE INDEX history_tenant ON history (tenant_id, updated_at);
CREATE INDEX history_plan ON history (tenant_id, plan_id, updated_at);

CREATE TABLE settings (
  tenant_id  ${T} NOT NULL ${FK('tenants(id)')},
  key        ${T} NOT NULL,
  value      ${T} NOT NULL,
  updated_at ${T} NOT NULL,
  updated_by ${T} ${FK('users(id)')},
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE sessions (
  id_hash      ${T} PRIMARY KEY,
  tenant_id    ${T} NOT NULL ${FK('tenants(id)')},
  user_id      ${T} NOT NULL ${FK('users(id)', ' ON DELETE CASCADE')},
  via          ${T} NOT NULL CHECK (via IN ('user', 'code')),
  fingerprint  ${T} NOT NULL,
  created_at   ${T} NOT NULL,
  last_seen_at ${T} NOT NULL,
  expires_at   ${T} NOT NULL,
  ip           ${T} NOT NULL DEFAULT '',
  user_agent   ${T} NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions (tenant_id, user_id);

CREATE TABLE audit (
  id         ${T} PRIMARY KEY,
  tenant_id  ${T} NOT NULL ${FK('tenants(id)')},
  user_id    ${T} ${FK('users(id)')},
  action     ${T} NOT NULL,
  detail     ${T} NOT NULL DEFAULT '{}',
  ip         ${T} NOT NULL DEFAULT '',
  created_at ${T} NOT NULL
);
CREATE INDEX audit_tenant ON audit (tenant_id, created_at);

CREATE TABLE quotes (
  id             ${T} PRIMARY KEY,
  tenant_id      ${T} NOT NULL ${FK('tenants(id)')},
  owner_id       ${T} NOT NULL ${FK('users(id)')},
  plan_id        ${T},
  number         ${T} NOT NULL,
  status         ${T} NOT NULL DEFAULT 'concept' CHECK (status IN ('concept', 'verzonden', 'akkoord', 'afgewezen')),
  title          ${T} NOT NULL DEFAULT '',
  customer       ${T} NOT NULL DEFAULT '',
  total_excl     DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_incl     DOUBLE PRECISION NOT NULL DEFAULT 0,
  data           ${T} NOT NULL,
  created_at     ${T} NOT NULL,
  updated_at     ${T} NOT NULL,
  deleted_at     ${T},
  customer_id    ${T} ${FK('users(id)')},
  share_hash     ${T},
  share_token    ${T},
  share_url      ${T},
  shared_at      ${T},
  viewed_at      ${T},
  last_viewed_at ${T},
  view_count     BIGINT NOT NULL DEFAULT 0,
  sent_at        ${T},
  sent_to        ${T},
  responded_at   ${T},
  acceptance     ${T},
  UNIQUE (tenant_id, number)
);
CREATE INDEX quotes_owner ON quotes (tenant_id, owner_id, updated_at);
CREATE INDEX quotes_plan ON quotes (tenant_id, plan_id);
CREATE INDEX quotes_customer ON quotes (tenant_id, customer_id);
CREATE UNIQUE INDEX quotes_share ON quotes (share_hash) WHERE share_hash IS NOT NULL;

CREATE TABLE support_grants (
  id         ${T} PRIMARY KEY,
  tenant_id  ${T} NOT NULL ${FK('tenants(id)')},
  user_id    ${T} NOT NULL ${FK('users(id)')},
  created_at ${T} NOT NULL,
  expires_at ${T} NOT NULL,
  revoked_at ${T}
);
CREATE INDEX support_grants_user ON support_grants (user_id, expires_at);

CREATE TABLE impersonations (
  id           ${T} PRIMARY KEY,
  tenant_id    ${T} NOT NULL ${FK('tenants(id)')},
  admin_id     ${T} NOT NULL ${FK('users(id)')},
  user_id      ${T} NOT NULL ${FK('users(id)')},
  grant_id     ${T} ${FK('support_grants(id)')},
  reason       ${T} NOT NULL DEFAULT '',
  started_at   ${T} NOT NULL,
  expires_at   ${T} NOT NULL,
  ended_at     ${T},
  ended_reason ${T}
);
CREATE INDEX impersonations_admin ON impersonations (admin_id, started_at);

CREATE TABLE work_orders (
  id           ${T} PRIMARY KEY,
  tenant_id    ${T} NOT NULL ${FK('tenants(id)')},
  owner_id     ${T} NOT NULL ${FK('users(id)')},
  quote_id     ${T},
  plan_id      ${T},
  number       ${T} NOT NULL,
  status       ${T} NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'gepland', 'bezig', 'gereed', 'geannuleerd')),
  title        ${T} NOT NULL DEFAULT '',
  customer     ${T} NOT NULL DEFAULT '',
  address      ${T} NOT NULL DEFAULT '',
  planned_date ${T},
  assignee_id  ${T} ${FK('users(id)')},
  data         ${T} NOT NULL,
  created_at   ${T} NOT NULL,
  updated_at   ${T} NOT NULL,
  deleted_at   ${T},
  UNIQUE (tenant_id, number)
);
CREATE INDEX work_orders_tenant ON work_orders (tenant_id, updated_at);
CREATE INDEX work_orders_quote ON work_orders (tenant_id, quote_id);

CREATE TABLE shop_products (
  tenant_id  ${T} NOT NULL ${FK('tenants(id)')},
  id         ${T} NOT NULL,
  sku        ${T} NOT NULL DEFAULT '',
  name       ${T} NOT NULL DEFAULT '',
  price      DOUBLE PRECISION,
  currency   ${T} NOT NULL DEFAULT 'EUR',
  url        ${T} NOT NULL DEFAULT '',
  image      ${T} NOT NULL DEFAULT '',
  in_stock   BIGINT NOT NULL DEFAULT 1,
  code       ${T} NOT NULL DEFAULT '',
  categories ${T} NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE shop_sync (
  tenant_id       ${T} PRIMARY KEY ${FK('tenants(id)')},
  synced_at       ${T},
  product_count   BIGINT,
  last_attempt_at ${T},
  last_error      ${T}
);
`;

// Migraties na het basisschema: PG_MIGRATIONS[0] hoort bij SQLite-migratie
// PG_BASE_VERSION + 1, enzovoort. Alleen toevoegen, nooit aanpassen.
const PG_MIGRATIONS = [
  // 13: planning en klantlink van werkorders.
  `
  ALTER TABLE work_orders ADD COLUMN share_hash ${T};
  ALTER TABLE work_orders ADD COLUMN share_token ${T};
  ALTER TABLE work_orders ADD COLUMN share_url ${T};
  ALTER TABLE work_orders ADD COLUMN shared_at ${T};
  ALTER TABLE work_orders ADD COLUMN viewed_at ${T};
  ALTER TABLE work_orders ADD COLUMN sent_at ${T};
  ALTER TABLE work_orders ADD COLUMN sent_to ${T};
  ALTER TABLE work_orders ADD COLUMN appointment ${T};
  CREATE UNIQUE INDEX work_orders_share ON work_orders (share_hash) WHERE share_hash IS NOT NULL;
  CREATE INDEX work_orders_planned ON work_orders (tenant_id, planned_date);
  `,
  // 14: foto's bij werkorders.
  `
  CREATE TABLE work_order_photos (
    id               ${T} PRIMARY KEY,
    tenant_id        ${T} NOT NULL ${FK('tenants(id)')},
    work_order_id    ${T} NOT NULL ${FK('work_orders(id)')},
    uploaded_by      ${T} ${FK('users(id)')},
    kind             ${T} NOT NULL DEFAULT 'oplevering' CHECK (kind IN ('voor', 'tijdens', 'oplevering')),
    caption          ${T} NOT NULL DEFAULT '',
    customer_visible BIGINT NOT NULL DEFAULT 1,
    mime             ${T} NOT NULL,
    width            BIGINT,
    height           BIGINT,
    size             BIGINT NOT NULL,
    taken_at         ${T},
    image            ${T} NOT NULL,
    thumb            ${T} NOT NULL,
    created_at       ${T} NOT NULL
  );
  CREATE INDEX work_order_photos_wo ON work_order_photos (tenant_id, work_order_id, created_at);
  `,
  // 15: Mijn profiel (contactgegevens en voorkeuren).
  `
  ALTER TABLE users ADD COLUMN email ${T} NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN phone ${T} NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN preferences ${T} NOT NULL DEFAULT '{}';
  `,
  // 16: opdrachten uitbesteden aan een andere organisatie.
  `
  CREATE TABLE work_order_offers (
    id                     ${T} PRIMARY KEY,
    tenant_id              ${T} NOT NULL ${FK('tenants(id)')},
    work_order_id          ${T} NOT NULL,
    to_tenant_id           ${T},
    status                 ${T} NOT NULL DEFAULT 'aangeboden' CHECK (status IN ('aangeboden', 'geaccepteerd', 'afgewezen', 'ingetrokken')),
    message                ${T} NOT NULL DEFAULT '',
    fee                    DOUBLE PRECISION,
    preview                ${T} NOT NULL,
    from_name              ${T} NOT NULL DEFAULT '',
    created_by             ${T},
    created_by_name        ${T} NOT NULL DEFAULT '',
    declined               ${T} NOT NULL DEFAULT '[]',
    receiver_tenant_id     ${T},
    receiver_name          ${T} NOT NULL DEFAULT '',
    received_work_order_id ${T},
    responded_by_name      ${T} NOT NULL DEFAULT '',
    responded_at           ${T},
    reason                 ${T} NOT NULL DEFAULT '',
    created_at             ${T} NOT NULL,
    updated_at             ${T} NOT NULL
  );
  CREATE INDEX work_order_offers_wo ON work_order_offers (tenant_id, work_order_id);
  CREATE INDEX work_order_offers_open ON work_order_offers (status, to_tenant_id);
  CREATE INDEX work_order_offers_receiver ON work_order_offers (receiver_tenant_id, received_work_order_id);
  `,
];

module.exports = { PG_BASE, PG_BASE_VERSION, PG_MIGRATIONS };
