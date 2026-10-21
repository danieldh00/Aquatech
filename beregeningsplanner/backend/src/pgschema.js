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
  // 16: indexen (zie db.js).
  `
  CREATE INDEX history_user ON history (user_id);
  CREATE INDEX plans_owner_only ON plans (owner_id);
  CREATE INDEX work_orders_assignee ON work_orders (tenant_id, assignee_id, planned_date);
  CREATE INDEX sessions_expires ON sessions (expires_at);
  CREATE INDEX impersonations_user ON impersonations (user_id);
  `,
  // 17: opdrachten uitbesteden aan een andere organisatie.
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
  // 18: rollen per organisatie; users.role wordt een vrije sleutel.
  `
  CREATE TABLE roles (
    tenant_id   ${T} NOT NULL ${FK('tenants(id)')},
    role_key    ${T} NOT NULL,
    label       ${T} NOT NULL,
    description ${T} NOT NULL DEFAULT '',
    kind        ${T} NOT NULL CHECK (kind IN ('medewerker', 'klant')),
    rights      ${T} NOT NULL DEFAULT '[]',
    created_at  ${T} NOT NULL,
    updated_at  ${T} NOT NULL,
    PRIMARY KEY (tenant_id, role_key)
  );
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  `,
  // 19: nieuwsberichten van de organisatie (zie db.js).
  `
  CREATE TABLE news (
    id          ${T} PRIMARY KEY,
    tenant_id   ${T} NOT NULL ${FK('tenants(id)')},
    title       ${T} NOT NULL,
    body        ${T} NOT NULL,
    audience    ${T} NOT NULL DEFAULT 'medewerkers' CHECK (audience IN ('medewerkers', 'iedereen')),
    pinned      BIGINT NOT NULL DEFAULT 0,
    author_id   ${T},
    author_name ${T} NOT NULL DEFAULT '',
    created_at  ${T} NOT NULL,
    updated_at  ${T} NOT NULL
  );
  CREATE INDEX news_tenant ON news (tenant_id, created_at);
  `,
  // 20: controle van plannen (zie db.js).
  `
  ALTER TABLE plans ADD COLUMN review_status ${T} NOT NULL DEFAULT 'concept';
  ALTER TABLE plans ADD COLUMN review_question ${T} NOT NULL DEFAULT '';
  ALTER TABLE plans ADD COLUMN review_requested_at ${T};
  ALTER TABLE plans ADD COLUMN reviewed_by ${T};
  ALTER TABLE plans ADD COLUMN reviewed_at ${T};
  ALTER TABLE plans ADD COLUMN submitted_via ${T} NOT NULL DEFAULT '';
  UPDATE plans SET review_status = 'goedgekeurd', reviewed_at = updated_at
    WHERE owner_id IN (SELECT id FROM users WHERE kind IN ('account', 'systeem') AND role IN ('beheerder', 'installateur'));
  CREATE INDEX plans_review ON plans (tenant_id, review_status, updated_at);
  `,
  // 21: verbruik en kosten van AI-verzoeken (zie db.js).
  `
  CREATE TABLE ai_usage (
    id                 ${T} PRIMARY KEY,
    tenant_id          ${T} NOT NULL ${FK('tenants(id)')},
    user_id            ${T},
    feature            ${T} NOT NULL,
    model              ${T} NOT NULL,
    status             ${T} NOT NULL DEFAULT 'ok',
    input_tokens       BIGINT NOT NULL DEFAULT 0,
    output_tokens      BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
    cache_write_tokens BIGINT NOT NULL DEFAULT 0,
    duration_ms        BIGINT NOT NULL DEFAULT 0,
    cost_usd_micro     BIGINT NOT NULL DEFAULT 0,
    cost_eur_micro     BIGINT NOT NULL DEFAULT 0,
    detail             ${T} NOT NULL DEFAULT '{}',
    created_at         ${T} NOT NULL
  );
  CREATE INDEX ai_usage_tenant ON ai_usage (tenant_id, created_at);
  CREATE INDEX ai_usage_created ON ai_usage (created_at);
  `,
  // 22: herkende plannen en geleerde kleuren (zie db.js).
  `
  CREATE TABLE plan_recognitions (
    id          ${T} PRIMARY KEY,
    tenant_id   ${T} NOT NULL ${FK('tenants(id)')},
    user_id     ${T},
    source      ${T} NOT NULL,
    image_hash  ${T} NOT NULL DEFAULT '',
    plan_id     ${T},
    model       ${T} NOT NULL DEFAULT '',
    version     ${T} NOT NULL DEFAULT '',
    result      ${T} NOT NULL DEFAULT '',
    samples     ${T} NOT NULL DEFAULT '',
    created_at  ${T} NOT NULL,
    updated_at  ${T} NOT NULL
  );
  CREATE INDEX plan_recognitions_hash ON plan_recognitions (tenant_id, image_hash);
  CREATE INDEX plan_recognitions_plan ON plan_recognitions (tenant_id, plan_id);
  CREATE INDEX plan_recognitions_created ON plan_recognitions (tenant_id, created_at);
  `,
  // 23: werkregistratie: uren en materiaalverbruik (zie db.js).
  `
  CREATE TABLE work_order_hours (
    id             ${T} PRIMARY KEY,
    tenant_id      ${T} NOT NULL ${FK('tenants(id)')},
    work_order_id  ${T} NOT NULL ${FK('work_orders(id)')},
    user_id        ${T},
    user_name      ${T} NOT NULL DEFAULT '',
    work_date      ${T} NOT NULL,
    start_time     ${T} NOT NULL DEFAULT '',
    end_time       ${T} NOT NULL DEFAULT '',
    break_minutes  BIGINT NOT NULL DEFAULT 0,
    minutes        BIGINT NOT NULL,
    kind           ${T} NOT NULL DEFAULT 'werk',
    step_id        ${T} NOT NULL DEFAULT '',
    note           ${T} NOT NULL DEFAULT '',
    client_id      ${T},
    created_by     ${T},
    created_at     ${T} NOT NULL,
    updated_at     ${T} NOT NULL
  );
  CREATE INDEX work_order_hours_wo ON work_order_hours (tenant_id, work_order_id, work_date);
  CREATE INDEX work_order_hours_date ON work_order_hours (tenant_id, work_date);
  CREATE UNIQUE INDEX work_order_hours_client ON work_order_hours (tenant_id, client_id);
  CREATE TABLE work_order_materials (
    id                 ${T} PRIMARY KEY,
    tenant_id          ${T} NOT NULL ${FK('tenants(id)')},
    work_order_id      ${T} NOT NULL ${FK('work_orders(id)')},
    user_id            ${T},
    user_name          ${T} NOT NULL DEFAULT '',
    used_on            ${T} NOT NULL,
    code               ${T} NOT NULL DEFAULT '',
    description        ${T} NOT NULL DEFAULT '',
    unit               ${T} NOT NULL DEFAULT '',
    qty                DOUBLE PRECISION NOT NULL,
    material_id        ${T} NOT NULL DEFAULT '',
    note               ${T} NOT NULL DEFAULT '',
    client_id          ${T},
    stock_movement_id  ${T},
    created_by         ${T},
    created_at         ${T} NOT NULL,
    updated_at         ${T} NOT NULL
  );
  CREATE INDEX work_order_materials_wo ON work_order_materials (tenant_id, work_order_id, used_on);
  CREATE INDEX work_order_materials_date ON work_order_materials (tenant_id, used_on);
  CREATE UNIQUE INDEX work_order_materials_client ON work_order_materials (tenant_id, client_id);
  `,
  // 24: voorraadbeheer (zie db.js).
  `
  CREATE TABLE stock_items (
    id          ${T} PRIMARY KEY,
    tenant_id   ${T} NOT NULL ${FK('tenants(id)')},
    code        ${T} NOT NULL,
    name        ${T} NOT NULL,
    unit        ${T} NOT NULL DEFAULT 'st',
    location    ${T} NOT NULL DEFAULT '',
    min_qty     DOUBLE PRECISION NOT NULL DEFAULT 0,
    on_hand     DOUBLE PRECISION NOT NULL DEFAULT 0,
    cost_price  DOUBLE PRECISION,
    notes       ${T} NOT NULL DEFAULT '',
    archived    BIGINT NOT NULL DEFAULT 0,
    created_at  ${T} NOT NULL,
    updated_at  ${T} NOT NULL,
    UNIQUE (tenant_id, code)
  );
  CREATE TABLE stock_movements (
    id                ${T} PRIMARY KEY,
    tenant_id         ${T} NOT NULL ${FK('tenants(id)')},
    item_id           ${T} NOT NULL ${FK('stock_items(id)')},
    kind              ${T} NOT NULL CHECK (kind IN ('ontvangst', 'afboeking', 'retour', 'correctie', 'telling')),
    qty               DOUBLE PRECISION NOT NULL,
    balance           DOUBLE PRECISION NOT NULL,
    work_order_id     ${T},
    work_order_number ${T} NOT NULL DEFAULT '',
    source            ${T} NOT NULL DEFAULT '',
    note              ${T} NOT NULL DEFAULT '',
    user_id           ${T},
    user_name         ${T} NOT NULL DEFAULT '',
    created_at        ${T} NOT NULL
  );
  CREATE INDEX stock_movements_item ON stock_movements (tenant_id, item_id, created_at);
  CREATE INDEX stock_movements_created ON stock_movements (tenant_id, created_at);
  CREATE INDEX stock_movements_wo ON stock_movements (tenant_id, work_order_id);
  CREATE INDEX stock_movements_source ON stock_movements (tenant_id, source);
  CREATE TABLE stock_reservations (
    tenant_id     ${T} NOT NULL ${FK('tenants(id)')},
    work_order_id ${T} NOT NULL,
    item_id       ${T} NOT NULL ${FK('stock_items(id)')},
    qty           DOUBLE PRECISION NOT NULL,
    updated_at    ${T} NOT NULL,
    PRIMARY KEY (tenant_id, work_order_id, item_id)
  );
  CREATE INDEX stock_reservations_item ON stock_reservations (tenant_id, item_id);
  `,
  // 25: meldingen van klanten (zie db.js).
  `
  CREATE TABLE service_requests (
    id              ${T} PRIMARY KEY,
    tenant_id       ${T} NOT NULL ${FK('tenants(id)')},
    number          ${T} NOT NULL,
    customer_id     ${T},
    customer_name   ${T} NOT NULL DEFAULT '',
    kind            ${T} NOT NULL DEFAULT 'storing' CHECK (kind IN ('storing', 'onderhoud', 'overig')),
    urgent          BIGINT NOT NULL DEFAULT 0,
    subject         ${T} NOT NULL,
    description     ${T} NOT NULL DEFAULT '',
    address         ${T} NOT NULL DEFAULT '',
    phone           ${T} NOT NULL DEFAULT '',
    email           ${T} NOT NULL DEFAULT '',
    preferred       ${T} NOT NULL DEFAULT '',
    installation_id ${T},
    status          ${T} NOT NULL DEFAULT 'nieuw' CHECK (status IN ('nieuw', 'in_behandeling', 'ingepland', 'afgehandeld', 'afgewezen', 'ingetrokken')),
    reply           ${T} NOT NULL DEFAULT '',
    note            ${T} NOT NULL DEFAULT '',
    handled_by      ${T},
    handled_by_name ${T} NOT NULL DEFAULT '',
    work_order_id   ${T},
    created_at      ${T} NOT NULL,
    updated_at      ${T} NOT NULL,
    UNIQUE (tenant_id, number)
  );
  CREATE INDEX service_requests_status ON service_requests (tenant_id, status, created_at);
  CREATE INDEX service_requests_customer ON service_requests (tenant_id, customer_id, created_at);
  CREATE INDEX service_requests_wo ON service_requests (tenant_id, work_order_id);
  CREATE TABLE service_request_photos (
    id         ${T} PRIMARY KEY,
    tenant_id  ${T} NOT NULL ${FK('tenants(id)')},
    request_id ${T} NOT NULL ${FK('service_requests(id)')},
    mime       ${T} NOT NULL,
    width      BIGINT,
    height     BIGINT,
    size       BIGINT NOT NULL,
    image      ${T} NOT NULL,
    thumb      ${T} NOT NULL,
    created_at ${T} NOT NULL
  );
  CREATE INDEX service_request_photos_req ON service_request_photos (tenant_id, request_id, created_at);
  `,
  // 26: artikelen met verkoopprijs en webshopstand, facturen (zie db.js).
  `
  ALTER TABLE stock_items ADD COLUMN sale_price DOUBLE PRECISION;
  ALTER TABLE stock_items ADD COLUMN vat_rate BIGINT NOT NULL DEFAULT 21;
  ALTER TABLE stock_items ADD COLUMN revenue_group ${T} NOT NULL DEFAULT 'producten';
  ALTER TABLE stock_items ADD COLUMN shop_sync BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE stock_items ADD COLUMN shop_product_id ${T};
  ALTER TABLE stock_items ADD COLUMN shop_dirty BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE stock_items ADD COLUMN shop_price_seen DOUBLE PRECISION;
  ALTER TABLE stock_items ADD COLUMN shop_stock_seen DOUBLE PRECISION;
  ALTER TABLE stock_items ADD COLUMN shop_synced_at ${T};
  ALTER TABLE stock_items ADD COLUMN shop_error ${T} NOT NULL DEFAULT '';
  CREATE INDEX stock_items_dirty ON stock_items (tenant_id, shop_dirty);
  CREATE TABLE invoices (
    id            ${T} PRIMARY KEY,
    tenant_id     ${T} NOT NULL ${FK('tenants(id)')},
    number        ${T},
    status        ${T} NOT NULL DEFAULT 'concept' CHECK (status IN ('concept', 'definitief', 'betaald')),
    kind          ${T} NOT NULL DEFAULT 'factuur' CHECK (kind IN ('factuur', 'credit')),
    credit_of     ${T},
    customer_id   ${T},
    customer_name ${T} NOT NULL DEFAULT '',
    work_order_id ${T},
    quote_id      ${T},
    invoice_date  ${T} NOT NULL,
    due_date      ${T} NOT NULL,
    subtotal      DOUBLE PRECISION NOT NULL DEFAULT 0,
    vat_total     DOUBLE PRECISION NOT NULL DEFAULT 0,
    total         DOUBLE PRECISION NOT NULL DEFAULT 0,
    data          ${T} NOT NULL,
    stock_booked  BIGINT NOT NULL DEFAULT 0,
    finalized_at  ${T},
    paid_at       ${T},
    credited_at   ${T},
    exported_at   ${T},
    created_by    ${T},
    created_at    ${T} NOT NULL,
    updated_at    ${T} NOT NULL,
    UNIQUE (tenant_id, number)
  );
  CREATE INDEX invoices_date ON invoices (tenant_id, invoice_date);
  CREATE INDEX invoices_status ON invoices (tenant_id, status, invoice_date);
  CREATE INDEX invoices_wo ON invoices (tenant_id, work_order_id);
  `,
  // 27: debiteuren, facturen uit webshopbestellingen, verzonden (zie db.js).
  `
  CREATE TABLE debtors (
    id               ${T} PRIMARY KEY,
    tenant_id        ${T} NOT NULL ${FK('tenants(id)')},
    number           BIGINT NOT NULL,
    name             ${T} NOT NULL DEFAULT '',
    contact          ${T} NOT NULL DEFAULT '',
    address          ${T} NOT NULL DEFAULT '',
    email            ${T} NOT NULL DEFAULT '',
    phone            ${T} NOT NULL DEFAULT '',
    vat_number       ${T} NOT NULL DEFAULT '',
    match_key        ${T} NOT NULL DEFAULT '',
    customer_id      ${T},
    shop_customer_id ${T},
    source           ${T} NOT NULL DEFAULT 'factuur',
    created_at       ${T} NOT NULL,
    updated_at       ${T} NOT NULL,
    UNIQUE (tenant_id, number)
  );
  CREATE INDEX debtors_match ON debtors (tenant_id, match_key);
  CREATE INDEX debtors_name ON debtors (tenant_id, name);
  ALTER TABLE invoices ADD COLUMN debtor_id ${T};
  ALTER TABLE invoices ADD COLUMN shop_order_id ${T};
  ALTER TABLE invoices ADD COLUMN sent_at ${T};
  ALTER TABLE invoices ADD COLUMN sent_to ${T};
  ALTER TABLE invoices ADD COLUMN send_error ${T} NOT NULL DEFAULT '';
  CREATE UNIQUE INDEX invoices_shop_order ON invoices (tenant_id, shop_order_id) WHERE shop_order_id IS NOT NULL;
  CREATE INDEX invoices_debtor ON invoices (tenant_id, debtor_id);
  ALTER TABLE shop_sync ADD COLUMN orders_after ${T};
  ALTER TABLE shop_sync ADD COLUMN orders_synced_at ${T};
  ALTER TABLE shop_sync ADD COLUMN orders_error ${T};
  `,
];

module.exports = { PG_BASE, PG_BASE_VERSION, PG_MIGRATIONS };
