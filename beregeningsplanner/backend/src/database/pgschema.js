/** Teksttype van PostgreSQL met binaire sortering, zodat vergelijken en sorteren gelijk is aan SQLite. */
const TEXT_TYPE = 'TEXT COLLATE "C"';
/**
 * Foreign key die pas bij COMMIT gecontroleerd kan worden (DEFERRABLE), zoals defer_foreign_keys in SQLite.
 * @param {string} ref Doeltabel met kolom, bijv. 'tenants(id)'.
 * @param {string} [extra] Extra regel, bijv. ' ON DELETE CASCADE'.
 * @returns {string} De REFERENCES-clausule.
 */
const references = (ref, extra = '') => `REFERENCES ${ref}${extra} DEFERRABLE INITIALLY IMMEDIATE`;

// Versie waarop het basisschema hieronder overeenkomt met SQLite.
const PG_BASE_VERSION = 12;

const PG_BASE = `
CREATE TABLE tenants (
  id          ${TEXT_TYPE} PRIMARY KEY,
  slug        ${TEXT_TYPE} NOT NULL UNIQUE,
  name        ${TEXT_TYPE} NOT NULL,
  created_at  ${TEXT_TYPE} NOT NULL,
  environment ${TEXT_TYPE} NOT NULL DEFAULT 'live' CHECK (environment IN ('live', 'test')),
  parent_id   ${TEXT_TYPE} ${references('tenants(id)')},
  disabled    BIGINT NOT NULL DEFAULT 0,
  updated_at  ${TEXT_TYPE}
);
CREATE INDEX tenants_parent ON tenants (parent_id);

CREATE TABLE users (
  id                   ${TEXT_TYPE} PRIMARY KEY,
  tenant_id            ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
  username             ${TEXT_TYPE} NOT NULL,
  display_name         ${TEXT_TYPE} NOT NULL,
  role                 ${TEXT_TYPE} NOT NULL CHECK (role IN ('beheerder', 'installateur', 'klant')),
  kind                 ${TEXT_TYPE} NOT NULL CHECK (kind IN ('account', 'gast', 'systeem')),
  password_hash        ${TEXT_TYPE},
  disabled             BIGINT NOT NULL DEFAULT 0,
  created_at           ${TEXT_TYPE} NOT NULL,
  last_seen_at         ${TEXT_TYPE},
  platform_admin       BIGINT NOT NULL DEFAULT 0,
  must_change_password BIGINT NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, username)
);

CREATE TABLE plans (
  id         ${TEXT_TYPE} PRIMARY KEY,
  tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
  owner_id   ${TEXT_TYPE} NOT NULL ${references('users(id)')},
  title      ${TEXT_TYPE} NOT NULL,
  customer   ${TEXT_TYPE} NOT NULL DEFAULT '',
  address    ${TEXT_TYPE} NOT NULL DEFAULT '',
  data       ${TEXT_TYPE} NOT NULL,
  created_at ${TEXT_TYPE} NOT NULL,
  updated_at ${TEXT_TYPE} NOT NULL,
  deleted_at ${TEXT_TYPE}
);
CREATE INDEX plans_owner ON plans (tenant_id, owner_id, updated_at);

CREATE TABLE history (
  id         ${TEXT_TYPE} PRIMARY KEY,
  tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
  user_id    ${TEXT_TYPE} ${references('users(id)')},
  plan_id    ${TEXT_TYPE},
  action     ${TEXT_TYPE} NOT NULL,
  title      ${TEXT_TYPE} NOT NULL DEFAULT '',
  customer   ${TEXT_TYPE} NOT NULL DEFAULT '',
  address    ${TEXT_TYPE} NOT NULL DEFAULT '',
  summary    ${TEXT_TYPE} NOT NULL DEFAULT '{}',
  snapshot   ${TEXT_TYPE},
  ip         ${TEXT_TYPE} NOT NULL DEFAULT '',
  created_at ${TEXT_TYPE} NOT NULL,
  updated_at ${TEXT_TYPE} NOT NULL
);
CREATE INDEX history_tenant ON history (tenant_id, updated_at);
CREATE INDEX history_plan ON history (tenant_id, plan_id, updated_at);

CREATE TABLE settings (
  tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
  key        ${TEXT_TYPE} NOT NULL,
  value      ${TEXT_TYPE} NOT NULL,
  updated_at ${TEXT_TYPE} NOT NULL,
  updated_by ${TEXT_TYPE} ${references('users(id)')},
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE sessions (
  id_hash      ${TEXT_TYPE} PRIMARY KEY,
  tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
  user_id      ${TEXT_TYPE} NOT NULL ${references('users(id)', ' ON DELETE CASCADE')},
  via          ${TEXT_TYPE} NOT NULL CHECK (via IN ('user', 'code')),
  fingerprint  ${TEXT_TYPE} NOT NULL,
  created_at   ${TEXT_TYPE} NOT NULL,
  last_seen_at ${TEXT_TYPE} NOT NULL,
  expires_at   ${TEXT_TYPE} NOT NULL,
  ip           ${TEXT_TYPE} NOT NULL DEFAULT '',
  user_agent   ${TEXT_TYPE} NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions (tenant_id, user_id);

CREATE TABLE audit (
  id         ${TEXT_TYPE} PRIMARY KEY,
  tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
  user_id    ${TEXT_TYPE} ${references('users(id)')},
  action     ${TEXT_TYPE} NOT NULL,
  detail     ${TEXT_TYPE} NOT NULL DEFAULT '{}',
  ip         ${TEXT_TYPE} NOT NULL DEFAULT '',
  created_at ${TEXT_TYPE} NOT NULL
);
CREATE INDEX audit_tenant ON audit (tenant_id, created_at);

CREATE TABLE quotes (
  id             ${TEXT_TYPE} PRIMARY KEY,
  tenant_id      ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
  owner_id       ${TEXT_TYPE} NOT NULL ${references('users(id)')},
  plan_id        ${TEXT_TYPE},
  number         ${TEXT_TYPE} NOT NULL,
  status         ${TEXT_TYPE} NOT NULL DEFAULT 'concept' CHECK (status IN ('concept', 'verzonden', 'akkoord', 'afgewezen')),
  title          ${TEXT_TYPE} NOT NULL DEFAULT '',
  customer       ${TEXT_TYPE} NOT NULL DEFAULT '',
  total_excl     DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_incl     DOUBLE PRECISION NOT NULL DEFAULT 0,
  data           ${TEXT_TYPE} NOT NULL,
  created_at     ${TEXT_TYPE} NOT NULL,
  updated_at     ${TEXT_TYPE} NOT NULL,
  deleted_at     ${TEXT_TYPE},
  customer_id    ${TEXT_TYPE} ${references('users(id)')},
  share_hash     ${TEXT_TYPE},
  share_token    ${TEXT_TYPE},
  share_url      ${TEXT_TYPE},
  shared_at      ${TEXT_TYPE},
  viewed_at      ${TEXT_TYPE},
  last_viewed_at ${TEXT_TYPE},
  view_count     BIGINT NOT NULL DEFAULT 0,
  sent_at        ${TEXT_TYPE},
  sent_to        ${TEXT_TYPE},
  responded_at   ${TEXT_TYPE},
  acceptance     ${TEXT_TYPE},
  UNIQUE (tenant_id, number)
);
CREATE INDEX quotes_owner ON quotes (tenant_id, owner_id, updated_at);
CREATE INDEX quotes_plan ON quotes (tenant_id, plan_id);
CREATE INDEX quotes_customer ON quotes (tenant_id, customer_id);
CREATE UNIQUE INDEX quotes_share ON quotes (share_hash) WHERE share_hash IS NOT NULL;

CREATE TABLE support_grants (
  id         ${TEXT_TYPE} PRIMARY KEY,
  tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
  user_id    ${TEXT_TYPE} NOT NULL ${references('users(id)')},
  created_at ${TEXT_TYPE} NOT NULL,
  expires_at ${TEXT_TYPE} NOT NULL,
  revoked_at ${TEXT_TYPE}
);
CREATE INDEX support_grants_user ON support_grants (user_id, expires_at);

CREATE TABLE impersonations (
  id           ${TEXT_TYPE} PRIMARY KEY,
  tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
  admin_id     ${TEXT_TYPE} NOT NULL ${references('users(id)')},
  user_id      ${TEXT_TYPE} NOT NULL ${references('users(id)')},
  grant_id     ${TEXT_TYPE} ${references('support_grants(id)')},
  reason       ${TEXT_TYPE} NOT NULL DEFAULT '',
  started_at   ${TEXT_TYPE} NOT NULL,
  expires_at   ${TEXT_TYPE} NOT NULL,
  ended_at     ${TEXT_TYPE},
  ended_reason ${TEXT_TYPE}
);
CREATE INDEX impersonations_admin ON impersonations (admin_id, started_at);

CREATE TABLE work_orders (
  id           ${TEXT_TYPE} PRIMARY KEY,
  tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
  owner_id     ${TEXT_TYPE} NOT NULL ${references('users(id)')},
  quote_id     ${TEXT_TYPE},
  plan_id      ${TEXT_TYPE},
  number       ${TEXT_TYPE} NOT NULL,
  status       ${TEXT_TYPE} NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'gepland', 'bezig', 'gereed', 'geannuleerd')),
  title        ${TEXT_TYPE} NOT NULL DEFAULT '',
  customer     ${TEXT_TYPE} NOT NULL DEFAULT '',
  address      ${TEXT_TYPE} NOT NULL DEFAULT '',
  planned_date ${TEXT_TYPE},
  assignee_id  ${TEXT_TYPE} ${references('users(id)')},
  data         ${TEXT_TYPE} NOT NULL,
  created_at   ${TEXT_TYPE} NOT NULL,
  updated_at   ${TEXT_TYPE} NOT NULL,
  deleted_at   ${TEXT_TYPE},
  UNIQUE (tenant_id, number)
);
CREATE INDEX work_orders_tenant ON work_orders (tenant_id, updated_at);
CREATE INDEX work_orders_quote ON work_orders (tenant_id, quote_id);

CREATE TABLE shop_products (
  tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
  id         ${TEXT_TYPE} NOT NULL,
  sku        ${TEXT_TYPE} NOT NULL DEFAULT '',
  name       ${TEXT_TYPE} NOT NULL DEFAULT '',
  price      DOUBLE PRECISION,
  currency   ${TEXT_TYPE} NOT NULL DEFAULT 'EUR',
  url        ${TEXT_TYPE} NOT NULL DEFAULT '',
  image      ${TEXT_TYPE} NOT NULL DEFAULT '',
  in_stock   BIGINT NOT NULL DEFAULT 1,
  code       ${TEXT_TYPE} NOT NULL DEFAULT '',
  categories ${TEXT_TYPE} NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE shop_sync (
  tenant_id       ${TEXT_TYPE} PRIMARY KEY ${references('tenants(id)')},
  synced_at       ${TEXT_TYPE},
  product_count   BIGINT,
  last_attempt_at ${TEXT_TYPE},
  last_error      ${TEXT_TYPE}
);
`;

// Migraties na het basisschema: PG_MIGRATIONS[0] hoort bij SQLite-migratie
// PG_BASE_VERSION + 1, enzovoort. Alleen toevoegen, nooit aanpassen.
const PG_MIGRATIONS = [
  // 13: planning en klantlink van werkorders.
  `
  ALTER TABLE work_orders ADD COLUMN share_hash ${TEXT_TYPE};
  ALTER TABLE work_orders ADD COLUMN share_token ${TEXT_TYPE};
  ALTER TABLE work_orders ADD COLUMN share_url ${TEXT_TYPE};
  ALTER TABLE work_orders ADD COLUMN shared_at ${TEXT_TYPE};
  ALTER TABLE work_orders ADD COLUMN viewed_at ${TEXT_TYPE};
  ALTER TABLE work_orders ADD COLUMN sent_at ${TEXT_TYPE};
  ALTER TABLE work_orders ADD COLUMN sent_to ${TEXT_TYPE};
  ALTER TABLE work_orders ADD COLUMN appointment ${TEXT_TYPE};
  CREATE UNIQUE INDEX work_orders_share ON work_orders (share_hash) WHERE share_hash IS NOT NULL;
  CREATE INDEX work_orders_planned ON work_orders (tenant_id, planned_date);
  `,
  // 14: foto's bij werkorders.
  `
  CREATE TABLE work_order_photos (
    id               ${TEXT_TYPE} PRIMARY KEY,
    tenant_id        ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    work_order_id    ${TEXT_TYPE} NOT NULL ${references('work_orders(id)')},
    uploaded_by      ${TEXT_TYPE} ${references('users(id)')},
    kind             ${TEXT_TYPE} NOT NULL DEFAULT 'oplevering' CHECK (kind IN ('voor', 'tijdens', 'oplevering')),
    caption          ${TEXT_TYPE} NOT NULL DEFAULT '',
    customer_visible BIGINT NOT NULL DEFAULT 1,
    mime             ${TEXT_TYPE} NOT NULL,
    width            BIGINT,
    height           BIGINT,
    size             BIGINT NOT NULL,
    taken_at         ${TEXT_TYPE},
    image            ${TEXT_TYPE} NOT NULL,
    thumb            ${TEXT_TYPE} NOT NULL,
    created_at       ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX work_order_photos_wo ON work_order_photos (tenant_id, work_order_id, created_at);
  `,
  // 15: Mijn profiel (contactgegevens en voorkeuren).
  `
  ALTER TABLE users ADD COLUMN email ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN phone ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN preferences ${TEXT_TYPE} NOT NULL DEFAULT '{}';
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
    id                     ${TEXT_TYPE} PRIMARY KEY,
    tenant_id              ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    work_order_id          ${TEXT_TYPE} NOT NULL,
    to_tenant_id           ${TEXT_TYPE},
    status                 ${TEXT_TYPE} NOT NULL DEFAULT 'aangeboden' CHECK (status IN ('aangeboden', 'geaccepteerd', 'afgewezen', 'ingetrokken')),
    message                ${TEXT_TYPE} NOT NULL DEFAULT '',
    fee                    DOUBLE PRECISION,
    preview                ${TEXT_TYPE} NOT NULL,
    from_name              ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_by             ${TEXT_TYPE},
    created_by_name        ${TEXT_TYPE} NOT NULL DEFAULT '',
    declined               ${TEXT_TYPE} NOT NULL DEFAULT '[]',
    receiver_tenant_id     ${TEXT_TYPE},
    receiver_name          ${TEXT_TYPE} NOT NULL DEFAULT '',
    received_work_order_id ${TEXT_TYPE},
    responded_by_name      ${TEXT_TYPE} NOT NULL DEFAULT '',
    responded_at           ${TEXT_TYPE},
    reason                 ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_at             ${TEXT_TYPE} NOT NULL,
    updated_at             ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX work_order_offers_wo ON work_order_offers (tenant_id, work_order_id);
  CREATE INDEX work_order_offers_open ON work_order_offers (status, to_tenant_id);
  CREATE INDEX work_order_offers_receiver ON work_order_offers (receiver_tenant_id, received_work_order_id);
  `,
  // 18: rollen per organisatie; users.role wordt een vrije sleutel.
  `
  CREATE TABLE roles (
    tenant_id   ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    role_key    ${TEXT_TYPE} NOT NULL,
    label       ${TEXT_TYPE} NOT NULL,
    description ${TEXT_TYPE} NOT NULL DEFAULT '',
    kind        ${TEXT_TYPE} NOT NULL CHECK (kind IN ('medewerker', 'klant')),
    rights      ${TEXT_TYPE} NOT NULL DEFAULT '[]',
    created_at  ${TEXT_TYPE} NOT NULL,
    updated_at  ${TEXT_TYPE} NOT NULL,
    PRIMARY KEY (tenant_id, role_key)
  );
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  `,
  // 19: nieuwsberichten van de organisatie (zie db.js).
  `
  CREATE TABLE news (
    id          ${TEXT_TYPE} PRIMARY KEY,
    tenant_id   ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    title       ${TEXT_TYPE} NOT NULL,
    body        ${TEXT_TYPE} NOT NULL,
    audience    ${TEXT_TYPE} NOT NULL DEFAULT 'medewerkers' CHECK (audience IN ('medewerkers', 'iedereen')),
    pinned      BIGINT NOT NULL DEFAULT 0,
    author_id   ${TEXT_TYPE},
    author_name ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_at  ${TEXT_TYPE} NOT NULL,
    updated_at  ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX news_tenant ON news (tenant_id, created_at);
  `,
  // 20: controle van plannen (zie db.js).
  `
  ALTER TABLE plans ADD COLUMN review_status ${TEXT_TYPE} NOT NULL DEFAULT 'concept';
  ALTER TABLE plans ADD COLUMN review_question ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE plans ADD COLUMN review_requested_at ${TEXT_TYPE};
  ALTER TABLE plans ADD COLUMN reviewed_by ${TEXT_TYPE};
  ALTER TABLE plans ADD COLUMN reviewed_at ${TEXT_TYPE};
  ALTER TABLE plans ADD COLUMN submitted_via ${TEXT_TYPE} NOT NULL DEFAULT '';
  UPDATE plans SET review_status = 'goedgekeurd', reviewed_at = updated_at
    WHERE owner_id IN (SELECT id FROM users WHERE kind IN ('account', 'systeem') AND role IN ('beheerder', 'installateur'));
  CREATE INDEX plans_review ON plans (tenant_id, review_status, updated_at);
  `,
  // 21: verbruik en kosten van AI-verzoeken (zie db.js).
  `
  CREATE TABLE ai_usage (
    id                 ${TEXT_TYPE} PRIMARY KEY,
    tenant_id          ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    user_id            ${TEXT_TYPE},
    feature            ${TEXT_TYPE} NOT NULL,
    model              ${TEXT_TYPE} NOT NULL,
    status             ${TEXT_TYPE} NOT NULL DEFAULT 'ok',
    input_tokens       BIGINT NOT NULL DEFAULT 0,
    output_tokens      BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
    cache_write_tokens BIGINT NOT NULL DEFAULT 0,
    duration_ms        BIGINT NOT NULL DEFAULT 0,
    cost_usd_micro     BIGINT NOT NULL DEFAULT 0,
    cost_eur_micro     BIGINT NOT NULL DEFAULT 0,
    detail             ${TEXT_TYPE} NOT NULL DEFAULT '{}',
    created_at         ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX ai_usage_tenant ON ai_usage (tenant_id, created_at);
  CREATE INDEX ai_usage_created ON ai_usage (created_at);
  `,
  // 22: herkende plannen en geleerde kleuren (zie db.js).
  `
  CREATE TABLE plan_recognitions (
    id          ${TEXT_TYPE} PRIMARY KEY,
    tenant_id   ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    user_id     ${TEXT_TYPE},
    source      ${TEXT_TYPE} NOT NULL,
    image_hash  ${TEXT_TYPE} NOT NULL DEFAULT '',
    plan_id     ${TEXT_TYPE},
    model       ${TEXT_TYPE} NOT NULL DEFAULT '',
    version     ${TEXT_TYPE} NOT NULL DEFAULT '',
    result      ${TEXT_TYPE} NOT NULL DEFAULT '',
    samples     ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_at  ${TEXT_TYPE} NOT NULL,
    updated_at  ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX plan_recognitions_hash ON plan_recognitions (tenant_id, image_hash);
  CREATE INDEX plan_recognitions_plan ON plan_recognitions (tenant_id, plan_id);
  CREATE INDEX plan_recognitions_created ON plan_recognitions (tenant_id, created_at);
  `,
  // 23: werkregistratie: uren en materiaalverbruik (zie db.js).
  `
  CREATE TABLE work_order_hours (
    id             ${TEXT_TYPE} PRIMARY KEY,
    tenant_id      ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    work_order_id  ${TEXT_TYPE} NOT NULL ${references('work_orders(id)')},
    user_id        ${TEXT_TYPE},
    user_name      ${TEXT_TYPE} NOT NULL DEFAULT '',
    work_date      ${TEXT_TYPE} NOT NULL,
    start_time     ${TEXT_TYPE} NOT NULL DEFAULT '',
    end_time       ${TEXT_TYPE} NOT NULL DEFAULT '',
    break_minutes  BIGINT NOT NULL DEFAULT 0,
    minutes        BIGINT NOT NULL,
    kind           ${TEXT_TYPE} NOT NULL DEFAULT 'werk',
    step_id        ${TEXT_TYPE} NOT NULL DEFAULT '',
    note           ${TEXT_TYPE} NOT NULL DEFAULT '',
    client_id      ${TEXT_TYPE},
    created_by     ${TEXT_TYPE},
    created_at     ${TEXT_TYPE} NOT NULL,
    updated_at     ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX work_order_hours_wo ON work_order_hours (tenant_id, work_order_id, work_date);
  CREATE INDEX work_order_hours_date ON work_order_hours (tenant_id, work_date);
  CREATE UNIQUE INDEX work_order_hours_client ON work_order_hours (tenant_id, client_id);
  CREATE TABLE work_order_materials (
    id                 ${TEXT_TYPE} PRIMARY KEY,
    tenant_id          ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    work_order_id      ${TEXT_TYPE} NOT NULL ${references('work_orders(id)')},
    user_id            ${TEXT_TYPE},
    user_name          ${TEXT_TYPE} NOT NULL DEFAULT '',
    used_on            ${TEXT_TYPE} NOT NULL,
    code               ${TEXT_TYPE} NOT NULL DEFAULT '',
    description        ${TEXT_TYPE} NOT NULL DEFAULT '',
    unit               ${TEXT_TYPE} NOT NULL DEFAULT '',
    qty                DOUBLE PRECISION NOT NULL,
    material_id        ${TEXT_TYPE} NOT NULL DEFAULT '',
    note               ${TEXT_TYPE} NOT NULL DEFAULT '',
    client_id          ${TEXT_TYPE},
    stock_movement_id  ${TEXT_TYPE},
    created_by         ${TEXT_TYPE},
    created_at         ${TEXT_TYPE} NOT NULL,
    updated_at         ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX work_order_materials_wo ON work_order_materials (tenant_id, work_order_id, used_on);
  CREATE INDEX work_order_materials_date ON work_order_materials (tenant_id, used_on);
  CREATE UNIQUE INDEX work_order_materials_client ON work_order_materials (tenant_id, client_id);
  `,
  // 24: voorraadbeheer (zie db.js).
  `
  CREATE TABLE stock_items (
    id          ${TEXT_TYPE} PRIMARY KEY,
    tenant_id   ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    code        ${TEXT_TYPE} NOT NULL,
    name        ${TEXT_TYPE} NOT NULL,
    unit        ${TEXT_TYPE} NOT NULL DEFAULT 'st',
    location    ${TEXT_TYPE} NOT NULL DEFAULT '',
    min_qty     DOUBLE PRECISION NOT NULL DEFAULT 0,
    on_hand     DOUBLE PRECISION NOT NULL DEFAULT 0,
    cost_price  DOUBLE PRECISION,
    notes       ${TEXT_TYPE} NOT NULL DEFAULT '',
    archived    BIGINT NOT NULL DEFAULT 0,
    created_at  ${TEXT_TYPE} NOT NULL,
    updated_at  ${TEXT_TYPE} NOT NULL,
    UNIQUE (tenant_id, code)
  );
  CREATE TABLE stock_movements (
    id                ${TEXT_TYPE} PRIMARY KEY,
    tenant_id         ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    item_id           ${TEXT_TYPE} NOT NULL ${references('stock_items(id)')},
    kind              ${TEXT_TYPE} NOT NULL CHECK (kind IN ('ontvangst', 'afboeking', 'retour', 'correctie', 'telling')),
    qty               DOUBLE PRECISION NOT NULL,
    balance           DOUBLE PRECISION NOT NULL,
    work_order_id     ${TEXT_TYPE},
    work_order_number ${TEXT_TYPE} NOT NULL DEFAULT '',
    source            ${TEXT_TYPE} NOT NULL DEFAULT '',
    note              ${TEXT_TYPE} NOT NULL DEFAULT '',
    user_id           ${TEXT_TYPE},
    user_name         ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_at        ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX stock_movements_item ON stock_movements (tenant_id, item_id, created_at);
  CREATE INDEX stock_movements_created ON stock_movements (tenant_id, created_at);
  CREATE INDEX stock_movements_wo ON stock_movements (tenant_id, work_order_id);
  CREATE INDEX stock_movements_source ON stock_movements (tenant_id, source);
  CREATE TABLE stock_reservations (
    tenant_id     ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    work_order_id ${TEXT_TYPE} NOT NULL,
    item_id       ${TEXT_TYPE} NOT NULL ${references('stock_items(id)')},
    qty           DOUBLE PRECISION NOT NULL,
    updated_at    ${TEXT_TYPE} NOT NULL,
    PRIMARY KEY (tenant_id, work_order_id, item_id)
  );
  CREATE INDEX stock_reservations_item ON stock_reservations (tenant_id, item_id);
  `,
  // 25: meldingen van klanten (zie db.js).
  `
  CREATE TABLE service_requests (
    id              ${TEXT_TYPE} PRIMARY KEY,
    tenant_id       ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    number          ${TEXT_TYPE} NOT NULL,
    customer_id     ${TEXT_TYPE},
    customer_name   ${TEXT_TYPE} NOT NULL DEFAULT '',
    kind            ${TEXT_TYPE} NOT NULL DEFAULT 'storing' CHECK (kind IN ('storing', 'onderhoud', 'overig')),
    urgent          BIGINT NOT NULL DEFAULT 0,
    subject         ${TEXT_TYPE} NOT NULL,
    description     ${TEXT_TYPE} NOT NULL DEFAULT '',
    address         ${TEXT_TYPE} NOT NULL DEFAULT '',
    phone           ${TEXT_TYPE} NOT NULL DEFAULT '',
    email           ${TEXT_TYPE} NOT NULL DEFAULT '',
    preferred       ${TEXT_TYPE} NOT NULL DEFAULT '',
    installation_id ${TEXT_TYPE},
    status          ${TEXT_TYPE} NOT NULL DEFAULT 'nieuw' CHECK (status IN ('nieuw', 'in_behandeling', 'ingepland', 'afgehandeld', 'afgewezen', 'ingetrokken')),
    reply           ${TEXT_TYPE} NOT NULL DEFAULT '',
    note            ${TEXT_TYPE} NOT NULL DEFAULT '',
    handled_by      ${TEXT_TYPE},
    handled_by_name ${TEXT_TYPE} NOT NULL DEFAULT '',
    work_order_id   ${TEXT_TYPE},
    created_at      ${TEXT_TYPE} NOT NULL,
    updated_at      ${TEXT_TYPE} NOT NULL,
    UNIQUE (tenant_id, number)
  );
  CREATE INDEX service_requests_status ON service_requests (tenant_id, status, created_at);
  CREATE INDEX service_requests_customer ON service_requests (tenant_id, customer_id, created_at);
  CREATE INDEX service_requests_wo ON service_requests (tenant_id, work_order_id);
  CREATE TABLE service_request_photos (
    id         ${TEXT_TYPE} PRIMARY KEY,
    tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    request_id ${TEXT_TYPE} NOT NULL ${references('service_requests(id)')},
    mime       ${TEXT_TYPE} NOT NULL,
    width      BIGINT,
    height     BIGINT,
    size       BIGINT NOT NULL,
    image      ${TEXT_TYPE} NOT NULL,
    thumb      ${TEXT_TYPE} NOT NULL,
    created_at ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX service_request_photos_req ON service_request_photos (tenant_id, request_id, created_at);
  `,
  // 26: artikelen met verkoopprijs en webshopstand, facturen (zie db.js).
  `
  ALTER TABLE stock_items ADD COLUMN sale_price DOUBLE PRECISION;
  ALTER TABLE stock_items ADD COLUMN vat_rate BIGINT NOT NULL DEFAULT 21;
  ALTER TABLE stock_items ADD COLUMN revenue_group ${TEXT_TYPE} NOT NULL DEFAULT 'producten';
  ALTER TABLE stock_items ADD COLUMN shop_sync BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE stock_items ADD COLUMN shop_product_id ${TEXT_TYPE};
  ALTER TABLE stock_items ADD COLUMN shop_dirty BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE stock_items ADD COLUMN shop_price_seen DOUBLE PRECISION;
  ALTER TABLE stock_items ADD COLUMN shop_stock_seen DOUBLE PRECISION;
  ALTER TABLE stock_items ADD COLUMN shop_synced_at ${TEXT_TYPE};
  ALTER TABLE stock_items ADD COLUMN shop_error ${TEXT_TYPE} NOT NULL DEFAULT '';
  CREATE INDEX stock_items_dirty ON stock_items (tenant_id, shop_dirty);
  CREATE TABLE invoices (
    id            ${TEXT_TYPE} PRIMARY KEY,
    tenant_id     ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    number        ${TEXT_TYPE},
    status        ${TEXT_TYPE} NOT NULL DEFAULT 'concept' CHECK (status IN ('concept', 'definitief', 'betaald')),
    kind          ${TEXT_TYPE} NOT NULL DEFAULT 'factuur' CHECK (kind IN ('factuur', 'credit')),
    credit_of     ${TEXT_TYPE},
    customer_id   ${TEXT_TYPE},
    customer_name ${TEXT_TYPE} NOT NULL DEFAULT '',
    work_order_id ${TEXT_TYPE},
    quote_id      ${TEXT_TYPE},
    invoice_date  ${TEXT_TYPE} NOT NULL,
    due_date      ${TEXT_TYPE} NOT NULL,
    subtotal      DOUBLE PRECISION NOT NULL DEFAULT 0,
    vat_total     DOUBLE PRECISION NOT NULL DEFAULT 0,
    total         DOUBLE PRECISION NOT NULL DEFAULT 0,
    data          ${TEXT_TYPE} NOT NULL,
    stock_booked  BIGINT NOT NULL DEFAULT 0,
    finalized_at  ${TEXT_TYPE},
    paid_at       ${TEXT_TYPE},
    credited_at   ${TEXT_TYPE},
    exported_at   ${TEXT_TYPE},
    created_by    ${TEXT_TYPE},
    created_at    ${TEXT_TYPE} NOT NULL,
    updated_at    ${TEXT_TYPE} NOT NULL,
    UNIQUE (tenant_id, number)
  );
  CREATE INDEX invoices_date ON invoices (tenant_id, invoice_date);
  CREATE INDEX invoices_status ON invoices (tenant_id, status, invoice_date);
  CREATE INDEX invoices_wo ON invoices (tenant_id, work_order_id);
  `,
  // 27: debiteuren, facturen uit webshopbestellingen, verzonden (zie db.js).
  `
  CREATE TABLE debtors (
    id               ${TEXT_TYPE} PRIMARY KEY,
    tenant_id        ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    number           BIGINT NOT NULL,
    name             ${TEXT_TYPE} NOT NULL DEFAULT '',
    contact          ${TEXT_TYPE} NOT NULL DEFAULT '',
    address          ${TEXT_TYPE} NOT NULL DEFAULT '',
    email            ${TEXT_TYPE} NOT NULL DEFAULT '',
    phone            ${TEXT_TYPE} NOT NULL DEFAULT '',
    vat_number       ${TEXT_TYPE} NOT NULL DEFAULT '',
    match_key        ${TEXT_TYPE} NOT NULL DEFAULT '',
    customer_id      ${TEXT_TYPE},
    shop_customer_id ${TEXT_TYPE},
    source           ${TEXT_TYPE} NOT NULL DEFAULT 'factuur',
    created_at       ${TEXT_TYPE} NOT NULL,
    updated_at       ${TEXT_TYPE} NOT NULL,
    UNIQUE (tenant_id, number)
  );
  CREATE INDEX debtors_match ON debtors (tenant_id, match_key);
  CREATE INDEX debtors_name ON debtors (tenant_id, name);
  ALTER TABLE invoices ADD COLUMN debtor_id ${TEXT_TYPE};
  ALTER TABLE invoices ADD COLUMN shop_order_id ${TEXT_TYPE};
  ALTER TABLE invoices ADD COLUMN sent_at ${TEXT_TYPE};
  ALTER TABLE invoices ADD COLUMN sent_to ${TEXT_TYPE};
  ALTER TABLE invoices ADD COLUMN send_error ${TEXT_TYPE} NOT NULL DEFAULT '';
  CREATE UNIQUE INDEX invoices_shop_order ON invoices (tenant_id, shop_order_id) WHERE shop_order_id IS NOT NULL;
  CREATE INDEX invoices_debtor ON invoices (tenant_id, debtor_id);
  ALTER TABLE shop_sync ADD COLUMN orders_after ${TEXT_TYPE};
  ALTER TABLE shop_sync ADD COLUMN orders_synced_at ${TEXT_TYPE};
  ALTER TABLE shop_sync ADD COLUMN orders_error ${TEXT_TYPE};
  `,
  // 28: koppeling met Visma eAccounting (zie db.js).
  `
  ALTER TABLE debtors ADD COLUMN visma_customer_id ${TEXT_TYPE};
  ALTER TABLE invoices ADD COLUMN visma_invoice_id ${TEXT_TYPE};
  ALTER TABLE invoices ADD COLUMN visma_number ${TEXT_TYPE};
  ALTER TABLE invoices ADD COLUMN visma_synced_at ${TEXT_TYPE};
  ALTER TABLE invoices ADD COLUMN visma_error ${TEXT_TYPE} NOT NULL DEFAULT '';
  CREATE INDEX invoices_visma ON invoices (tenant_id, visma_invoice_id, invoice_date);
  `,
  // 29: sproeierbibliotheek per omgeving (zie db.js).
  `
  CREATE TABLE sprinkler_library (
    id         ${TEXT_TYPE} PRIMARY KEY,
    tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    kind       ${TEXT_TYPE} NOT NULL CHECK (kind IN ('body', 'nozzle')),
    key        ${TEXT_TYPE} NOT NULL,
    data       ${TEXT_TYPE} NOT NULL,
    updated_at ${TEXT_TYPE} NOT NULL,
    updated_by ${TEXT_TYPE},
    UNIQUE (tenant_id, kind, key)
  );
  `,
  // 30: bestelvoorstel: aanvullen tot (zie db.js).
  `
  ALTER TABLE stock_items ADD COLUMN reorder_qty DOUBLE PRECISION;
  `,
  // 31: seizoensherinneringen (zie db.js).
  `
  CREATE TABLE season_reminders_sent (
    id           ${TEXT_TYPE} PRIMARY KEY,
    tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    user_id      ${TEXT_TYPE} NOT NULL ${references('users(id)')},
    reminder_key ${TEXT_TYPE} NOT NULL,
    year         BIGINT NOT NULL,
    sent_at      ${TEXT_TYPE} NOT NULL,
    UNIQUE (tenant_id, user_id, reminder_key, year)
  );
  `,
  // 32: artikeleenheden (zie db.js).
  `
  CREATE TABLE stock_units (
    id         ${TEXT_TYPE} PRIMARY KEY,
    tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    name       ${TEXT_TYPE} NOT NULL,
    created_at ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX stock_units_tenant_name_ci ON stock_units (tenant_id, LOWER(name));
  `,
  // 33: artikelen met varianten (zie db.js).
  `
  ALTER TABLE stock_items ADD COLUMN parent_id ${TEXT_TYPE};
  ALTER TABLE stock_items ADD COLUMN has_variants BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE stock_items ADD COLUMN attributes ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE stock_items ADD COLUMN variant_values ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE stock_items ADD COLUMN archived_by_parent BIGINT NOT NULL DEFAULT 0;
  CREATE INDEX stock_items_parent ON stock_items (tenant_id, parent_id);
  ALTER TABLE shop_products ADD COLUMN parent_id ${TEXT_TYPE};
  ALTER TABLE shop_products ADD COLUMN attributes ${TEXT_TYPE} NOT NULL DEFAULT '[]';
  ALTER TABLE shop_products ADD COLUMN type ${TEXT_TYPE} NOT NULL DEFAULT '';
  `,
  // 34: klantweergave (zie db.js).
  `
  ALTER TABLE impersonations ADD COLUMN mode ${TEXT_TYPE} NOT NULL DEFAULT 'support';
  `,
];

module.exports = { PG_BASE, PG_BASE_VERSION, PG_MIGRATIONS };
