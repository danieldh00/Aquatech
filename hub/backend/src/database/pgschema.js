/** Teksttype van PostgreSQL met binaire sortering, zodat vergelijken en sorteren overal hetzelfde werkt. */
const TEXT_TYPE = 'TEXT COLLATE "C"';
/**
 * Foreign key die pas bij COMMIT gecontroleerd kan worden (DEFERRABLE).
 * @param {string} ref Doeltabel met kolom, bijv. 'tenants(id)'.
 * @param {string} [extra] Extra regel, bijv. ' ON DELETE CASCADE'.
 * @returns {string} De REFERENCES-clausule.
 */
const references = (ref, extra = '') => `REFERENCES ${ref}${extra} DEFERRABLE INITIALLY IMMEDIATE`;

// Versie waarop het basisschema hieronder overeenkomt (de migraties erna staan in PG_MIGRATIONS).
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

// Kolommen die later zijn hernoemd, per tabel: oude naam -> nieuwe naam. Een back-up van vóór migratie 103 (artikelgroep en subartikel) heeft de oude namen;
// importLines (table-rows.js) leest ze onder de nieuwe naam in. Migratie 97 gebruikt UUID_COLUMNS met de oude namen en blijft dus ongewijzigd.
const RENAMED_COLUMNS = {
  stock_items: { parent_id: 'group_id', has_variants: 'is_group', variant_values: 'sub_values' },
  stock_merges: { parent_id: 'group_id', parent_code: 'group_code', parent_name: 'group_name' },
};
/** Het schemanummer waarbij RENAMED_COLUMNS is toegepast (migratie 103). */
const RENAMED_COLUMNS_VERSION = 103;

// Migraties na het basisschema: PG_MIGRATIONS[0] is migratie
// PG_BASE_VERSION + 1, enzovoort. Alleen toevoegen, nooit aanpassen.
/**
 * Kolommen die in migratie 97 van tekst naar UUID gaan (primaire sleutels en verwijzingen). Bewust tekst gebleven:
 * id's van buiten (WooCommerce, Mollie, Visma), `invoices.shop_order_id` (`web:<bestelling>` of een externe waarde),
 * `client_id` (sleutel van de offline wachtrij), `request_id`, `step_id` en `material_id`.
 */
const UUID_COLUMNS = {
  account_tokens: ['id', 'tenant_id', 'user_id'],
  ai_usage: ['id', 'tenant_id', 'user_id'],
  app_logs: ['id', 'tenant_id'],
  audit: ['id', 'tenant_id', 'user_id'],
  debtors: ['customer_id', 'id', 'tenant_id'],
  history: ['id', 'plan_id', 'tenant_id', 'user_id'],
  impersonations: ['admin_id', 'grant_id', 'id', 'tenant_id', 'user_id'],
  invoice_payments: ['id', 'invoice_id', 'tenant_id'],
  invoice_reminders: ['id', 'invoice_id', 'tenant_id'],
  invoices: ['created_by', 'customer_id', 'debtor_id', 'id', 'quote_id', 'tenant_id', 'work_order_id'],
  item_images: ['id', 'tenant_id'],
  item_packagings: ['id', 'item_id', 'tenant_id'],
  item_suppliers: ['id', 'item_id', 'supplier_id', 'tenant_id'],
  item_text_drafts: ['created_by', 'id', 'item_id', 'tenant_id'],
  monitor_incidents: ['id', 'tenant_id'],
  news: ['author_id', 'id', 'tenant_id'],
  oauth_grants: ['id', 'tenant_id', 'user_id'],
  plan_recognitions: ['id', 'plan_id', 'tenant_id', 'user_id'],
  plans: ['id', 'owner_id', 'reviewed_by', 'tenant_id'],
  purchase_order_lines: ['id', 'item_id', 'order_id', 'tenant_id'],
  purchase_orders: ['id', 'supplier_id', 'tenant_id'],
  purchase_proposal_dismissals: ['item_id', 'tenant_id'],
  quotes: ['customer_id', 'id', 'order_id', 'owner_id', 'plan_id', 'tenant_id'],
  roles: ['tenant_id'],
  season_reminders_sent: ['id', 'tenant_id', 'user_id'],
  service_request_photos: ['id', 'request_id', 'tenant_id'],
  service_requests: ['customer_id', 'handled_by', 'id', 'installation_id', 'tenant_id', 'work_order_id'],
  sessions: ['tenant_id', 'user_id'],
  settings: ['tenant_id', 'updated_by'],
  shop_content: ['id', 'published_by', 'tenant_id', 'updated_by'],
  shop_funnel_days: ['tenant_id'],
  shop_images: ['created_by', 'id', 'tenant_id'],
  shop_products: ['tenant_id'],
  shop_search_misses: ['tenant_id'],
  shop_sync: ['tenant_id'],
  sprinkler_library: ['id', 'tenant_id', 'updated_by'],
  stock_alerts: ['id', 'tenant_id'],
  stock_cost_entries: ['id', 'item_id', 'layer_id', 'movement_id', 'tenant_id'],
  stock_cost_prices: ['id', 'item_id', 'tenant_id', 'user_id'],
  stock_count_entries: ['count_id', 'id', 'line_id', 'tenant_id', 'user_id'],
  stock_count_lines: ['count_id', 'counted_by', 'id', 'item_id', 'movement_id', 'tenant_id'],
  stock_counts: ['closed_by', 'created_by', 'id', 'tenant_id'],
  stock_items: ['id', 'image_id', 'parent_id', 'tenant_id'],
  stock_layers: ['id', 'item_id', 'movement_id', 'tenant_id'],
  stock_merges: ['created_by', 'id', 'parent_id', 'tenant_id'],
  stock_movements: ['id', 'item_id', 'tenant_id', 'user_id', 'work_order_id'],
  stock_reservations: ['item_id', 'tenant_id', 'web_order_id', 'work_order_id'],
  stock_units: ['id', 'tenant_id'],
  suppliers: ['id', 'tenant_id'],
  support_grants: ['id', 'tenant_id', 'user_id'],
  tenants: ['id', 'parent_id'],
  users: ['id', 'tenant_id'],
  visma_log: ['id', 'tenant_id'],
  web_order_slips: ['order_id', 'tenant_id'],
  web_orders: ['id', 'tenant_id', 'user_id'],
  web_returns: ['id', 'order_id', 'tenant_id', 'user_id'],
  web_sale_lines: ['id', 'item_id', 'movement_id', 'order_id', 'tenant_id'],
  work_order_hours: ['created_by', 'id', 'tenant_id', 'user_id', 'work_order_id'],
  work_order_materials: ['created_by', 'id', 'stock_movement_id', 'tenant_id', 'user_id', 'work_order_id'],
  work_order_offers: ['created_by', 'id', 'received_work_order_id', 'receiver_tenant_id', 'tenant_id', 'to_tenant_id', 'work_order_id'],
  work_order_photos: ['id', 'tenant_id', 'uploaded_by', 'work_order_id'],
  work_orders: ['assignee_id', 'customer_id', 'id', 'owner_id', 'plan_id', 'quote_id', 'tenant_id'],
};

/**
 * SQL van migratie 97: kolommen uit UUID_COLUMNS gaan van tekst naar uuid. Waarden die al een UUID zijn blijven gelijk;
 * een andere waarde (zou niet moeten voorkomen) krijgt in elke kolom dezelfde afgeleide UUID (md5), zodat verwijzingen
 * kloppen, en een lege tekst in een kolom die leeg mag zijn wordt NULL. Eerst gaan de foreign keys en de tenantpolicies
 * weg; de keys komen daarna terug, de policies maakt pgdb.js bij het opstarten opnieuw aan (nu met uuid).
 * @returns {string} De SQL.
 */
function uuidMigrationSql() {
  const spec = JSON.stringify(UUID_COLUMNS).replace(/'/g, "''");
  return `
  DO $uuid$
  DECLARE
    spec jsonb := '${spec}';
    entry record;
    target text;
    found record;
    restore text[] := '{}';
    statement text;
    uuid_pattern text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
    source text;
    blank_default boolean;
  BEGIN
    FOR found IN SELECT tablename FROM pg_policies WHERE schemaname = current_schema() AND policyname = 'aquatech_tenant' LOOP
      EXECUTE format('DROP POLICY aquatech_tenant ON %I', found.tablename);
    END LOOP;
    FOR found IN SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE contype = 'f' AND connamespace = current_schema()::regnamespace LOOP
      restore := restore || format('ALTER TABLE %s ADD CONSTRAINT %I %s', found.table_name, found.conname, found.definition);
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', found.table_name, found.conname);
    END LOOP;
    FOR entry IN SELECT key AS table_name, value AS columns FROM jsonb_each(spec) LOOP
      FOR target IN SELECT jsonb_array_elements_text(entry.columns) LOOP
        SELECT CASE WHEN c.is_nullable = 'YES' OR c.column_default = '''''::text' THEN format('NULLIF(%I, '''')', target) ELSE format('%I', target) END,
               c.column_default = '''''::text'
          INTO source, blank_default
          FROM information_schema.columns c
          WHERE c.table_schema = current_schema() AND c.table_name = entry.table_name AND c.column_name = target;
        IF blank_default THEN
          EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT, ALTER COLUMN %I DROP NOT NULL', entry.table_name, target, target);
        END IF;
        EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE uuid USING (CASE WHEN %s ~ %L THEN %s::uuid ELSE md5(%L || %s)::uuid END)',
          entry.table_name, target, source, uuid_pattern, source, 'aquatech-uuid:', source);
      END LOOP;
    END LOOP;
    FOREACH statement IN ARRAY restore LOOP
      EXECUTE statement;
    END LOOP;
  END
  $uuid$;
  `;
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * De uuid-waarde van een id uit een back-up van vóór migratie 97, op dezelfde manier als de migratie: een uuid blijft gelijk,
 * lege tekst wordt NULL en een andere tekst krijgt een vaste, afgeleide uuid (md5), zodat verwijzingen blijven kloppen.
 * @param {*} value De waarde uit de back-up.
 * @param {boolean} [required] Waar bij een NOT NULL-kolom: een lege tekst krijgt dan ook een afgeleide uuid i.p.v. NULL.
 * @returns {*} De waarde voor een uuid-kolom.
 */
function legacyUuid(value, required = false) {
  if (typeof value !== 'string') return value;
  if (value === '' && !required) return null;
  if (UUID_TEXT.test(value)) return value;
  const hex = require('crypto').createHash('md5').update(`aquatech-uuid:${value}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
  // 35: account zoeken op e-mailadres (zie db.js).
  `
  CREATE INDEX users_email ON users (tenant_id, email);
  `,
  // 36: inhoud van de eigen webshop (zie db.js).
  `
  CREATE TABLE shop_content (
    id           ${TEXT_TYPE} PRIMARY KEY,
    tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    key          ${TEXT_TYPE} NOT NULL,
    draft        ${TEXT_TYPE},
    published    ${TEXT_TYPE},
    previous     ${TEXT_TYPE},
    updated_at   ${TEXT_TYPE} NOT NULL,
    updated_by   ${TEXT_TYPE} ${references('users(id)')},
    published_at ${TEXT_TYPE},
    published_by ${TEXT_TYPE} ${references('users(id)')}
  );
  CREATE UNIQUE INDEX shop_content_key ON shop_content (tenant_id, key);
  CREATE TABLE shop_images (
    id         ${TEXT_TYPE} PRIMARY KEY,
    tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    name       ${TEXT_TYPE} NOT NULL,
    mime       ${TEXT_TYPE} NOT NULL,
    width      BIGINT,
    height     BIGINT,
    size       BIGINT NOT NULL,
    data       ${TEXT_TYPE} NOT NULL,
    created_at ${TEXT_TYPE} NOT NULL,
    created_by ${TEXT_TYPE} ${references('users(id)')}
  );
  CREATE INDEX shop_images_tenant ON shop_images (tenant_id, created_at);
  `,
  // 37: bestellingen in de eigen webshop (zie db.js).
  `
  CREATE TABLE web_orders (
    id            ${TEXT_TYPE} PRIMARY KEY,
    tenant_id     ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    number        ${TEXT_TYPE} NOT NULL,
    user_id       ${TEXT_TYPE} ${references('users(id)')},
    status        ${TEXT_TYPE} NOT NULL DEFAULT 'nieuw',
    customer_name ${TEXT_TYPE} NOT NULL,
    email         ${TEXT_TYPE} NOT NULL,
    total         DOUBLE PRECISION NOT NULL,
    data          ${TEXT_TYPE} NOT NULL,
    created_at    ${TEXT_TYPE} NOT NULL,
    updated_at    ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX web_orders_number ON web_orders (tenant_id, number);
  CREATE INDEX web_orders_created ON web_orders (tenant_id, created_at);
  CREATE INDEX web_orders_user ON web_orders (tenant_id, user_id, created_at);
  `,
  // 38: gewicht per artikel (zie db.js).
  `
  ALTER TABLE stock_items ADD COLUMN weight_grams BIGINT;
  `,
  // 39: zakelijke klantgroep en zakelijke prijs (zie db.js).
  `
  ALTER TABLE users ADD COLUMN customer_group ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE stock_items ADD COLUMN business_price DOUBLE PRECISION;
  `,
  // 40: retouren van webshopbestellingen (zie db.js).
  `
  CREATE TABLE web_returns (
    id         ${TEXT_TYPE} PRIMARY KEY,
    tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    order_id   ${TEXT_TYPE} NOT NULL ${references('web_orders(id)')},
    user_id    ${TEXT_TYPE} ${references('users(id)')},
    number     ${TEXT_TYPE} NOT NULL,
    status     ${TEXT_TYPE} NOT NULL DEFAULT 'aangevraagd',
    data       ${TEXT_TYPE} NOT NULL,
    created_at ${TEXT_TYPE} NOT NULL,
    updated_at ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX web_returns_number ON web_returns (tenant_id, number);
  CREATE INDEX web_returns_order ON web_returns (tenant_id, order_id);
  CREATE INDEX web_returns_status ON web_returns (tenant_id, status, created_at);
  `,
  // 41: afbeeldingen bij artikelen (zie db.js).
  `
  CREATE TABLE item_images (
    id           ${TEXT_TYPE} PRIMARY KEY,
    tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    name         ${TEXT_TYPE} NOT NULL,
    mime         ${TEXT_TYPE} NOT NULL,
    width        BIGINT,
    height       BIGINT,
    size         BIGINT NOT NULL,
    content_hash ${TEXT_TYPE} NOT NULL,
    source_url   ${TEXT_TYPE},
    data         ${TEXT_TYPE} NOT NULL,
    created_at   ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX item_images_hash ON item_images (tenant_id, content_hash);
  ALTER TABLE stock_items ADD COLUMN image_id ${TEXT_TYPE};
  CREATE INDEX stock_items_image ON stock_items (tenant_id, image_id);
  `,
  // 42: logboek van samengevoegde artikelen (zie db.js).
  `
  CREATE TABLE stock_merges (
    id          ${TEXT_TYPE} PRIMARY KEY,
    tenant_id   ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    parent_id   ${TEXT_TYPE} NOT NULL,
    parent_code ${TEXT_TYPE} NOT NULL,
    parent_name ${TEXT_TYPE} NOT NULL,
    snapshot    ${TEXT_TYPE} NOT NULL,
    created_by  ${TEXT_TYPE},
    created_at  ${TEXT_TYPE} NOT NULL,
    undone_at   ${TEXT_TYPE}
  );
  CREATE INDEX stock_merges_parent ON stock_merges (tenant_id, parent_id);
  `,
  // 43: bedrijfsgegevens van zakelijke klanten (zie db.js).
  `
  ALTER TABLE users ADD COLUMN company_name ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN kvk_number ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN vat_number ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN business_request ${TEXT_TYPE} NOT NULL DEFAULT '';
  `,
  // 44: groothandel in de webshop (zie db.js).
  `
  ALTER TABLE users ADD COLUMN wholesale BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN wholesale_discount DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE stock_items ADD COLUMN order_pack_size BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE stock_items ADD COLUMN order_min_qty BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE stock_items ADD COLUMN price_tiers ${TEXT_TYPE} NOT NULL DEFAULT '[]';
  `,
  // 45: inkoopprijzen, voorraadlagen (FIFO) en webshopverkopen (zie db.js).
  `
  CREATE TABLE stock_cost_prices (
    id         ${TEXT_TYPE} PRIMARY KEY,
    tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    item_id    ${TEXT_TYPE} NOT NULL ${references('stock_items(id)')},
    price      DOUBLE PRECISION NOT NULL,
    valid_from ${TEXT_TYPE} NOT NULL,
    note       ${TEXT_TYPE} NOT NULL DEFAULT '',
    user_id    ${TEXT_TYPE},
    user_name  ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_at ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX stock_cost_prices_item ON stock_cost_prices (tenant_id, item_id, valid_from);
  CREATE TABLE stock_layers (
    id          ${TEXT_TYPE} PRIMARY KEY,
    tenant_id   ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    item_id     ${TEXT_TYPE} NOT NULL ${references('stock_items(id)')},
    movement_id ${TEXT_TYPE},
    received_at ${TEXT_TYPE} NOT NULL,
    qty         DOUBLE PRECISION NOT NULL,
    remaining   DOUBLE PRECISION NOT NULL,
    unit_cost   DOUBLE PRECISION,
    source      ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_at  ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX stock_layers_item ON stock_layers (tenant_id, item_id, received_at);
  CREATE TABLE stock_cost_entries (
    id          ${TEXT_TYPE} PRIMARY KEY,
    tenant_id   ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    movement_id ${TEXT_TYPE} NOT NULL,
    item_id     ${TEXT_TYPE} NOT NULL ${references('stock_items(id)')},
    layer_id    ${TEXT_TYPE},
    qty         DOUBLE PRECISION NOT NULL,
    unit_cost   DOUBLE PRECISION,
    created_at  ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX stock_cost_entries_movement ON stock_cost_entries (tenant_id, movement_id);
  CREATE INDEX stock_cost_entries_layer ON stock_cost_entries (tenant_id, layer_id);
  CREATE TABLE web_sale_lines (
    id          ${TEXT_TYPE} PRIMARY KEY,
    tenant_id   ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    kind        ${TEXT_TYPE} NOT NULL CHECK (kind IN ('verkoop', 'retour')),
    sold_at     ${TEXT_TYPE} NOT NULL,
    order_id    ${TEXT_TYPE},
    reference   ${TEXT_TYPE} NOT NULL,
    item_id     ${TEXT_TYPE},
    code        ${TEXT_TYPE} NOT NULL,
    name        ${TEXT_TYPE} NOT NULL,
    qty         DOUBLE PRECISION NOT NULL,
    revenue     DOUBLE PRECISION NOT NULL,
    movement_id ${TEXT_TYPE},
    created_at  ${TEXT_TYPE} NOT NULL
  );
  CREATE INDEX web_sale_lines_sold ON web_sale_lines (tenant_id, sold_at);
  CREATE INDEX web_sale_lines_order ON web_sale_lines (tenant_id, order_id);
  INSERT INTO stock_layers (id, tenant_id, item_id, movement_id, received_at, qty, remaining, unit_cost, source, created_at)
    SELECT 'begin-' || id, tenant_id, id, NULL, created_at, on_hand, on_hand, cost_price, 'beginstand', updated_at
    FROM stock_items WHERE has_variants = 0 AND on_hand > 0;
  INSERT INTO stock_cost_prices (id, tenant_id, item_id, price, valid_from, note, user_id, user_name, created_at)
    SELECT 'begin-' || id, tenant_id, id, cost_price, substr(created_at, 1, 10), 'Inkoopprijs bij de start van de prijshistorie', NULL, '', updated_at
    FROM stock_items WHERE cost_price IS NOT NULL;
  `,
  // 46: index op de gebruikersnaam alleen. Bij inloggen zonder treffer in de organisatie
  // zoekt store.loginTenantOfTestAccount een testaccount op naam over alle omgevingen;
  // de unieke sleutel (tenant_id, username) helpt daar niet, zonder index las dat elke gebruiker.
  // Niet uniek: dezelfde naam mag in verschillende organisaties voorkomen.
  `
  CREATE INDEX users_login_name ON users (username);
  `,
  // 47: stock_managed. Artikelen die uit een webshop komen zonder voorraadbeheer (geen aantal, alleen
  // "op voorraad") hebben in Aquatech geen stand; ze stonden op 0 en dus overal als niet op voorraad.
  // Met stock_managed = 0 volgt de status de webshop (shop_products.in_stock) tot er een ontvangst of telling is.
  // Bestaande gekoppelde artikelen zonder stand, boekingen en gezien webshopaantal worden zo gezet.
  `
  ALTER TABLE stock_items ADD COLUMN stock_managed BIGINT NOT NULL DEFAULT 1;
  UPDATE stock_items SET stock_managed = 0
    WHERE shop_product_id IS NOT NULL AND has_variants = 0 AND on_hand = 0 AND shop_stock_seen IS NULL
      AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id = stock_items.tenant_id AND m.item_id = stock_items.id);
  `,
  // 48: wachtwoord vergeten en e-mailadres bevestigen (zie db.js).
  `
  CREATE TABLE account_tokens (
    id          ${TEXT_TYPE} PRIMARY KEY,
    tenant_id   ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    user_id     ${TEXT_TYPE} NOT NULL ${references('users(id)')},
    purpose     ${TEXT_TYPE} NOT NULL CHECK (purpose IN ('wachtwoord', 'e-mail')),
    token_hash  ${TEXT_TYPE} NOT NULL,
    email       ${TEXT_TYPE} NOT NULL DEFAULT '',
    expires_at  ${TEXT_TYPE} NOT NULL,
    used_at     ${TEXT_TYPE},
    created_at  ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX account_tokens_hash ON account_tokens (token_hash);
  CREATE INDEX account_tokens_user ON account_tokens (tenant_id, user_id, purpose, created_at);
  ALTER TABLE users ADD COLUMN email_verified_at ${TEXT_TYPE};
  `,
  // 49: inhoud per verkoopeenheid voor de planner (zie db.js).
  `
  ALTER TABLE stock_items ADD COLUMN unit_content DOUBLE PRECISION;
  `,
  // 50: omschrijving en specificaties per artikel (zie db.js).
  `
  ALTER TABLE stock_items ADD COLUMN description ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE stock_items ADD COLUMN specifications ${TEXT_TYPE} NOT NULL DEFAULT '[]';
  ALTER TABLE shop_products ADD COLUMN description ${TEXT_TYPE} NOT NULL DEFAULT '';
  `,
  // 51: tweestapsverificatie per account (zie db.js).
  `
  ALTER TABLE users ADD COLUMN totp_secret ${TEXT_TYPE};
  ALTER TABLE users ADD COLUMN totp_enabled_at ${TEXT_TYPE};
  ALTER TABLE users ADD COLUMN totp_last_step BIGINT;
  ALTER TABLE users ADD COLUMN totp_recovery ${TEXT_TYPE} NOT NULL DEFAULT '[]';
  `,
  // 52: logboek van de Visma-koppeling (zie db.js).
  `
  CREATE TABLE visma_log (
    id           ${TEXT_TYPE} PRIMARY KEY,
    tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    created_at   ${TEXT_TYPE} NOT NULL,
    last_at      ${TEXT_TYPE} NOT NULL,
    kind         ${TEXT_TYPE} NOT NULL,
    direction    ${TEXT_TYPE} NOT NULL DEFAULT '',
    ok           BIGINT NOT NULL DEFAULT 1,
    source       ${TEXT_TYPE} NOT NULL DEFAULT 'automatisch',
    actor        ${TEXT_TYPE} NOT NULL DEFAULT '',
    reference    ${TEXT_TYPE} NOT NULL DEFAULT '',
    message      ${TEXT_TYPE} NOT NULL DEFAULT '',
    repeat_count BIGINT NOT NULL DEFAULT 1
  );
  CREATE INDEX visma_log_tenant ON visma_log (tenant_id, created_at, id);
  CREATE INDEX visma_log_reference ON visma_log (tenant_id, kind, reference, created_at);
  `,
  // 53: index voor de opschoonquery van het Visma-logboek (zie db.js).
  `
  CREATE INDEX visma_log_last ON visma_log (tenant_id, last_at);
  `,
  // 54: adres van een klant (zie db.js).
  `
  ALTER TABLE users ADD COLUMN address ${TEXT_TYPE} NOT NULL DEFAULT '';
  `,
  // 55: index voor de facturen op de klantkaart (zie db.js).
  `
  CREATE INDEX invoices_customer ON invoices (tenant_id, customer_id, invoice_date);
  `,
  // 56: betaaltermijn per klant (zie db.js).
  `
  ALTER TABLE users ADD COLUMN payment_days INTEGER;
  `,
  // 57: toestemmingen van de AI-koppeling (zie db.js).
  `
  CREATE TABLE oauth_grants (
    id                    ${TEXT_TYPE} PRIMARY KEY,
    tenant_id             ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    user_id               ${TEXT_TYPE} NOT NULL,
    client_id_hash        ${TEXT_TYPE} NOT NULL,
    client_name           ${TEXT_TYPE} NOT NULL DEFAULT '',
    redirect_uri          ${TEXT_TYPE} NOT NULL,
    scope                 ${TEXT_TYPE} NOT NULL DEFAULT '',
    resource              ${TEXT_TYPE} NOT NULL DEFAULT '',
    fingerprint           ${TEXT_TYPE} NOT NULL DEFAULT '',
    code_hash             ${TEXT_TYPE},
    code_challenge        ${TEXT_TYPE} NOT NULL DEFAULT '',
    code_expires_at       ${TEXT_TYPE},
    code_used_at          ${TEXT_TYPE},
    access_hash           ${TEXT_TYPE},
    access_expires_at     ${TEXT_TYPE},
    refresh_hash          ${TEXT_TYPE},
    refresh_expires_at    ${TEXT_TYPE},
    previous_refresh_hash ${TEXT_TYPE},
    rotated_at            ${TEXT_TYPE},
    created_at            ${TEXT_TYPE} NOT NULL,
    last_used_at          ${TEXT_TYPE},
    expires_at            ${TEXT_TYPE} NOT NULL,
    revoked_at            ${TEXT_TYPE}
  );
  CREATE UNIQUE INDEX oauth_grants_code ON oauth_grants (tenant_id, code_hash);
  CREATE UNIQUE INDEX oauth_grants_access ON oauth_grants (tenant_id, access_hash);
  CREATE UNIQUE INDEX oauth_grants_refresh ON oauth_grants (tenant_id, refresh_hash);
  CREATE INDEX oauth_grants_previous ON oauth_grants (tenant_id, previous_refresh_hash);
  CREATE INDEX oauth_grants_user ON oauth_grants (tenant_id, user_id, created_at);
  CREATE INDEX oauth_grants_expires ON oauth_grants (tenant_id, expires_at);
  `,
  // 58: documenttaal per klant (zie db.js).
  `
  ALTER TABLE users ADD COLUMN document_language ${TEXT_TYPE} NOT NULL DEFAULT 'nl';
  `,
  // 59: leveranciers (zie db.js).
  `
  CREATE TABLE suppliers (
    id           ${TEXT_TYPE} PRIMARY KEY,
    tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    name         ${TEXT_TYPE} NOT NULL,
    contact_name ${TEXT_TYPE} NOT NULL DEFAULT '',
    email        ${TEXT_TYPE} NOT NULL DEFAULT '',
    phone        ${TEXT_TYPE} NOT NULL DEFAULT '',
    address      ${TEXT_TYPE} NOT NULL DEFAULT '',
    notes        ${TEXT_TYPE} NOT NULL DEFAULT '',
    archived     BIGINT NOT NULL DEFAULT 0,
    created_at   ${TEXT_TYPE} NOT NULL,
    updated_at   ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX suppliers_tenant_name_ci ON suppliers (tenant_id, LOWER(name));
  CREATE TABLE item_suppliers (
    id           ${TEXT_TYPE} PRIMARY KEY,
    tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    item_id      ${TEXT_TYPE} NOT NULL ${references('stock_items(id)')},
    supplier_id  ${TEXT_TYPE} NOT NULL ${references('suppliers(id)')},
    supplier_sku ${TEXT_TYPE} NOT NULL DEFAULT '',
    cost_price   DOUBLE PRECISION,
    order_qty    DOUBLE PRECISION NOT NULL DEFAULT 1,
    preferred    BIGINT NOT NULL DEFAULT 0,
    created_at   ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX item_suppliers_pair ON item_suppliers (tenant_id, item_id, supplier_id);
  CREATE INDEX item_suppliers_supplier ON item_suppliers (tenant_id, supplier_id);
  `,
  // 61: inkooporders (zie db.js).
  `
  CREATE TABLE purchase_orders (
    id            ${TEXT_TYPE} PRIMARY KEY,
    tenant_id     ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    number        ${TEXT_TYPE} NOT NULL,
    supplier_id   ${TEXT_TYPE} NOT NULL ${references('suppliers(id)')},
    status        ${TEXT_TYPE} NOT NULL DEFAULT 'concept',
    expected_date ${TEXT_TYPE} NOT NULL DEFAULT '',
    notes         ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_by    ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_at    ${TEXT_TYPE} NOT NULL,
    updated_at    ${TEXT_TYPE} NOT NULL,
    ordered_at    ${TEXT_TYPE},
    closed_at     ${TEXT_TYPE}
  );
  CREATE UNIQUE INDEX purchase_orders_number ON purchase_orders (tenant_id, number);
  CREATE INDEX purchase_orders_status ON purchase_orders (tenant_id, status, created_at);
  CREATE INDEX purchase_orders_supplier ON purchase_orders (tenant_id, supplier_id);
  CREATE TABLE purchase_order_lines (
    id            ${TEXT_TYPE} PRIMARY KEY,
    tenant_id     ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    order_id      ${TEXT_TYPE} NOT NULL ${references('purchase_orders(id)')},
    item_id       ${TEXT_TYPE} NOT NULL ${references('stock_items(id)')},
    position      BIGINT NOT NULL DEFAULT 0,
    code          ${TEXT_TYPE} NOT NULL,
    name          ${TEXT_TYPE} NOT NULL,
    unit          ${TEXT_TYPE} NOT NULL DEFAULT 'st',
    supplier_sku  ${TEXT_TYPE} NOT NULL DEFAULT '',
    qty           DOUBLE PRECISION NOT NULL,
    unit_cost     DOUBLE PRECISION,
    received_qty  DOUBLE PRECISION NOT NULL DEFAULT 0
  );
  CREATE INDEX purchase_order_lines_order ON purchase_order_lines (tenant_id, order_id);
  CREATE INDEX purchase_order_lines_item ON purchase_order_lines (tenant_id, item_id);
  `,
  // 62: EAN per artikel (zie db.js).
  `
  ALTER TABLE stock_items ADD COLUMN ean ${TEXT_TYPE};
  CREATE UNIQUE INDEX stock_items_ean ON stock_items (tenant_id, ean) WHERE ean IS NOT NULL;
  `,
  // 63: verpakkingseenheden per artikel (zie db.js).
  `
  CREATE TABLE item_packagings (
    id             ${TEXT_TYPE} PRIMARY KEY,
    tenant_id      ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    item_id        ${TEXT_TYPE} NOT NULL ${references('stock_items(id)')},
    code           ${TEXT_TYPE} NOT NULL,
    name           ${TEXT_TYPE} NOT NULL,
    factor         BIGINT NOT NULL,
    sale_price     DOUBLE PRECISION,
    business_price DOUBLE PRECISION,
    ean            ${TEXT_TYPE},
    audience       ${TEXT_TYPE} NOT NULL DEFAULT 'iedereen',
    active         BIGINT NOT NULL DEFAULT 1,
    created_at     ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX item_packagings_code ON item_packagings (tenant_id, item_id, code);
  CREATE UNIQUE INDEX item_packagings_ean ON item_packagings (tenant_id, ean) WHERE ean IS NOT NULL;
  `,
  // 64: inkooporders: document van de leverancier (zie db.js).
  `
  ALTER TABLE purchase_orders ADD COLUMN supplier_reference ${TEXT_TYPE} NOT NULL DEFAULT '';
  `,
  // 65: prijsfactor per artikel (zie db.js).
  `
  ALTER TABLE stock_items ADD COLUMN price_mode ${TEXT_TYPE} NOT NULL DEFAULT 'vast';
  ALTER TABLE stock_items ADD COLUMN price_factor DOUBLE PRECISION;
  CREATE INDEX stock_items_price_mode ON stock_items (tenant_id, price_mode);
  `,
  // 66: offerte omgezet naar bestelling (zie db.js).
  `
  ALTER TABLE quotes ADD COLUMN order_id ${TEXT_TYPE};
  ALTER TABLE quotes ADD COLUMN converted_at ${TEXT_TYPE};
  CREATE UNIQUE INDEX quotes_order ON quotes (tenant_id, order_id) WHERE order_id IS NOT NULL;
  `,
  // 67: Te picken per status (zie db.js).
  `
  CREATE INDEX web_orders_status ON web_orders (tenant_id, status, created_at);
  `,
  // 68: afgewezen prijsvoorstellen (zie db.js).
  `
  CREATE TABLE price_proposal_rejections (
    id             ${TEXT_TYPE} PRIMARY KEY,
    tenant_id      ${TEXT_TYPE} NOT NULL REFERENCES tenants(id),
    item_id        ${TEXT_TYPE} NOT NULL REFERENCES stock_items(id),
    cost_price     DOUBLE PRECISION NOT NULL,
    proposed_price DOUBLE PRECISION NOT NULL,
    rejected_by    ${TEXT_TYPE},
    rejected_at    ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX price_proposal_rejections_item ON price_proposal_rejections (tenant_id, item_id);
  `,
  // 69: eigen pakbon bij dropshipping (zie db.js).
  `
  CREATE TABLE web_order_slips (
    tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    order_id   ${TEXT_TYPE} NOT NULL ${references('web_orders(id)')},
    file_name  ${TEXT_TYPE} NOT NULL,
    pages      BIGINT NOT NULL,
    size       BIGINT NOT NULL,
    data       ${TEXT_TYPE} NOT NULL,
    created_at ${TEXT_TYPE} NOT NULL,
    PRIMARY KEY (tenant_id, order_id)
  );
  `,
  // 70: meetcorpus voor de planherkenning (beregening/recognitions.js): alleen als de organisatie dat aanzet (instelling planCorpus)
  // bewaart de regel van een goedgekeurd plan de tekening (versleuteld, vault.sealBytes) en het eindplan, om de lokale herkenning mee te meten.
  `
  ALTER TABLE plan_recognitions ADD COLUMN corpus_image TEXT NOT NULL DEFAULT '';
  ALTER TABLE plan_recognitions ADD COLUMN corpus_width BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE plan_recognitions ADD COLUMN corpus_height BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE plan_recognitions ADD COLUMN corpus_final TEXT NOT NULL DEFAULT '';
  `,
  // 71: automatische bestelvoorstellen (zie db.js).
  `
  ALTER TABLE purchase_orders ADD COLUMN origin ${TEXT_TYPE} NOT NULL DEFAULT 'handmatig';
  CREATE UNIQUE INDEX purchase_orders_proposal ON purchase_orders (tenant_id, supplier_id) WHERE status = 'concept' AND origin = 'voorstel';
  CREATE TABLE purchase_proposal_dismissals (
    tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    item_id      ${TEXT_TYPE} NOT NULL ${references('stock_items(id)')},
    dismissed_at ${TEXT_TYPE} NOT NULL,
    PRIMARY KEY (tenant_id, item_id)
  );
  `,
  // 72: bewaking (zie db.js).
  `
  CREATE TABLE monitor_incidents (
    id                   ${TEXT_TYPE} PRIMARY KEY,
    tenant_id            ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    scope                ${TEXT_TYPE} NOT NULL DEFAULT 'tenant',
    check_key            ${TEXT_TYPE} NOT NULL,
    severity             ${TEXT_TYPE} NOT NULL,
    state                ${TEXT_TYPE} NOT NULL DEFAULT 'open',
    title                ${TEXT_TYPE} NOT NULL DEFAULT '',
    message              ${TEXT_TYPE} NOT NULL DEFAULT '',
    first_at             ${TEXT_TYPE} NOT NULL,
    last_at              ${TEXT_TYPE} NOT NULL,
    resolved_at          ${TEXT_TYPE} NOT NULL DEFAULT '',
    occurrences          BIGINT NOT NULL DEFAULT 1,
    notified_at          ${TEXT_TYPE} NOT NULL DEFAULT '',
    reminded_at          ${TEXT_TYPE} NOT NULL DEFAULT '',
    resolved_notified_at ${TEXT_TYPE} NOT NULL DEFAULT '',
    notify_error         ${TEXT_TYPE} NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX monitor_incidents_open ON monitor_incidents (tenant_id, check_key) WHERE state = 'open';
  CREATE INDEX monitor_incidents_recent ON monitor_incidents (tenant_id, state, last_at);
  `,
  // 73: zoekmachineteksten en merk per artikel (zie db.js).
  `
  ALTER TABLE stock_items ADD COLUMN seo_title ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE stock_items ADD COLUMN seo_description ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE stock_items ADD COLUMN brand ${TEXT_TYPE} NOT NULL DEFAULT '';
  `,
  // 74: levermethode en levertijd per artikel en leverancier (zie db.js).
  `
  ALTER TABLE stock_items ADD COLUMN delivery_rules ${TEXT_TYPE} NOT NULL DEFAULT '[]';
  ALTER TABLE stock_items ADD COLUMN lead_days_min BIGINT;
  ALTER TABLE stock_items ADD COLUMN lead_days_max BIGINT;
  ALTER TABLE item_suppliers ADD COLUMN lead_days BIGINT;
  `,
  // 75: concepten van producttekst door de AI (zie db.js).
  `
  CREATE TABLE item_text_drafts (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    item_id         TEXT NOT NULL REFERENCES stock_items(id),
    description     ${TEXT_TYPE} NOT NULL DEFAULT '',
    seo_title       ${TEXT_TYPE} NOT NULL DEFAULT '',
    seo_description ${TEXT_TYPE} NOT NULL DEFAULT '',
    warnings        ${TEXT_TYPE} NOT NULL DEFAULT '[]',
    notes           ${TEXT_TYPE} NOT NULL DEFAULT '',
    model           ${TEXT_TYPE} NOT NULL DEFAULT '',
    base_hash       ${TEXT_TYPE} NOT NULL DEFAULT '',
    edited          BIGINT NOT NULL DEFAULT 0,
    created_by      ${TEXT_TYPE},
    created_at      ${TEXT_TYPE} NOT NULL,
    updated_at      ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX item_text_drafts_item ON item_text_drafts (tenant_id, item_id);
  `,
  // 76: voorraadmeldingen in de eigen webshop (zie db.js).
  `
  CREATE TABLE stock_alerts (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id),
    item_code  ${TEXT_TYPE} NOT NULL,
    email      ${TEXT_TYPE} NOT NULL,
    created_at ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX stock_alerts_unique ON stock_alerts (tenant_id, item_code, email);
  CREATE INDEX stock_alerts_email ON stock_alerts (tenant_id, email);
  `,
  // 77: zoektermen zonder resultaat in de eigen webshop (zie db.js).
  `
  CREATE TABLE shop_search_misses (
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    term      ${TEXT_TYPE} NOT NULL,
    hits      INTEGER NOT NULL,
    first_at  ${TEXT_TYPE} NOT NULL,
    last_at   ${TEXT_TYPE} NOT NULL,
    PRIMARY KEY (tenant_id, term)
  );
  CREATE INDEX shop_search_misses_last ON shop_search_misses (tenant_id, last_at);
  `,
  // 78: eigen koopfunneltelling van de webshop (zie db.js).
  `
  CREATE TABLE shop_funnel_days (
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    day       ${TEXT_TYPE} NOT NULL,
    step      ${TEXT_TYPE} NOT NULL,
    hits      INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, day, step)
  );
  `,
  // 79: werkorder aan een klantrecord (zie db.js).
  `
  ALTER TABLE work_orders ADD COLUMN customer_id ${TEXT_TYPE} ${references('users(id)')};
  CREATE INDEX work_orders_customer ON work_orders (tenant_id, customer_id);
  UPDATE work_orders SET customer_id = (SELECT q.customer_id FROM quotes q WHERE q.id = work_orders.quote_id AND q.tenant_id = work_orders.tenant_id
    AND q.customer_id IS NOT NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id = q.customer_id)) WHERE quote_id IS NOT NULL;
  UPDATE work_orders SET customer_id = (SELECT sr.customer_id FROM service_requests sr WHERE sr.tenant_id = work_orders.tenant_id AND sr.work_order_id = work_orders.id
    AND sr.customer_id IS NOT NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id = sr.customer_id) ORDER BY sr.created_at LIMIT 1) WHERE customer_id IS NULL;
  `,  // 80: inkooporder per e-mail naar de leverancier (zie db.js).
  `
  ALTER TABLE purchase_orders ADD COLUMN mail_sent_at ${TEXT_TYPE};
  ALTER TABLE purchase_orders ADD COLUMN mail_sent_to ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE purchase_orders ADD COLUMN mail_sent_by ${TEXT_TYPE} NOT NULL DEFAULT '';
  ALTER TABLE purchase_orders ADD COLUMN mail_error ${TEXT_TYPE} NOT NULL DEFAULT '';
  `,
  // 81: miniatuur bij een artikelafbeelding (zie db.js).
  `
  ALTER TABLE item_images ADD COLUMN thumb ${TEXT_TYPE};
  `,
  // 82: centraal applicatielogboek (zie db.js).
  `
  CREATE TABLE app_logs (
    id           ${TEXT_TYPE} PRIMARY KEY,
    tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    scope        ${TEXT_TYPE} NOT NULL DEFAULT 'tenant',
    created_at   ${TEXT_TYPE} NOT NULL,
    level        ${TEXT_TYPE} NOT NULL DEFAULT 'info',
    source       ${TEXT_TYPE} NOT NULL,
    request_id   ${TEXT_TYPE} NOT NULL DEFAULT '',
    error_code   ${TEXT_TYPE} NOT NULL DEFAULT '',
    message      ${TEXT_TYPE} NOT NULL DEFAULT '',
    data         ${TEXT_TYPE} NOT NULL DEFAULT '{}',
    duration_ms  BIGINT NOT NULL DEFAULT 0,
    repeat_count BIGINT NOT NULL DEFAULT 1
  );
  CREATE INDEX app_logs_tenant_time ON app_logs (tenant_id, created_at);
  CREATE INDEX app_logs_tenant_level ON app_logs (tenant_id, level, created_at);
  CREATE INDEX app_logs_request ON app_logs (tenant_id, request_id);
  `,
  // 83: herhaalde logregels (taak, stilstand, traag) blijven na het wegschrijven één regel met teller: `created_at` = laatste keer,
  // `first_at` = eerste keer (leeg = één keer voorgekomen).
  `
  ALTER TABLE app_logs ADD COLUMN first_at ${TEXT_TYPE};
  `,
  // 84: online betalen van een factuur (zie db.js).
  `
  CREATE TABLE invoice_payments (
    id           ${TEXT_TYPE} PRIMARY KEY,
    tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    invoice_id   ${TEXT_TYPE} NOT NULL,
    mollie_id    ${TEXT_TYPE} NOT NULL,
    status       ${TEXT_TYPE} NOT NULL DEFAULT 'open',
    amount       DOUBLE PRECISION NOT NULL,
    checkout_url ${TEXT_TYPE} NOT NULL DEFAULT '',
    method       ${TEXT_TYPE} NOT NULL DEFAULT '',
    mode         ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_at   ${TEXT_TYPE} NOT NULL,
    paid_at      ${TEXT_TYPE}
  );
  CREATE UNIQUE INDEX invoice_payments_mollie ON invoice_payments (tenant_id, mollie_id);
  CREATE INDEX invoice_payments_invoice ON invoice_payments (tenant_id, invoice_id, created_at);
  `,
  // 85: betalingsherinneringen en aanmaningen (zie db.js).
  `
  ALTER TABLE users ADD COLUMN reminders_off BIGINT NOT NULL DEFAULT 0;
  CREATE TABLE invoice_reminders (
    id           ${TEXT_TYPE} PRIMARY KEY,
    tenant_id    ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    invoice_id   ${TEXT_TYPE} NOT NULL ${references('invoices(id)')},
    step_key     ${TEXT_TYPE} NOT NULL,
    status       ${TEXT_TYPE} NOT NULL DEFAULT 'verstuurd',
    sent_at      ${TEXT_TYPE} NOT NULL,
    sent_to      ${TEXT_TYPE} NOT NULL DEFAULT '',
    reason       ${TEXT_TYPE} NOT NULL DEFAULT '',
    days_overdue BIGINT NOT NULL DEFAULT 0,
    UNIQUE (tenant_id, invoice_id, step_key)
  );
  CREATE INDEX invoices_due ON invoices (tenant_id, status, due_date, id);
  `,
  // 86: opvolging van offertes zonder reactie (zie db.js).
  `
  ALTER TABLE quotes ADD COLUMN followup_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE quotes ADD COLUMN followup_at ${TEXT_TYPE};
  `,
  // 87: jaarlijkse voorraadtelling (zie artikelen/stock-counts.js).
  `
  CREATE TABLE stock_counts (
    id             ${TEXT_TYPE} PRIMARY KEY,
    tenant_id      ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    number         ${TEXT_TYPE} NOT NULL,
    kind           ${TEXT_TYPE} NOT NULL CHECK (kind IN ('jaar', 'tussentijds')),
    status         ${TEXT_TYPE} NOT NULL CHECK (status IN ('tellen', 'afgesloten', 'geannuleerd')),
    reference_date ${TEXT_TYPE} NOT NULL,
    reference_year BIGINT NOT NULL,
    frozen_at      ${TEXT_TYPE} NOT NULL,
    scope          ${TEXT_TYPE} NOT NULL DEFAULT '[]',
    threshold      ${TEXT_TYPE} NOT NULL DEFAULT '{}',
    note           ${TEXT_TYPE} NOT NULL DEFAULT '',
    summary        ${TEXT_TYPE} NOT NULL DEFAULT '{}',
    created_by     ${TEXT_TYPE},
    created_by_name ${TEXT_TYPE} NOT NULL DEFAULT '',
    closed_at      ${TEXT_TYPE},
    closed_by      ${TEXT_TYPE},
    closed_by_name ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_at     ${TEXT_TYPE} NOT NULL,
    UNIQUE (tenant_id, number)
  );
  CREATE UNIQUE INDEX stock_counts_open ON stock_counts (tenant_id) WHERE status = 'tellen';
  CREATE UNIQUE INDEX stock_counts_year ON stock_counts (tenant_id, reference_year) WHERE status = 'afgesloten' AND kind = 'jaar';
  CREATE INDEX stock_counts_list ON stock_counts (tenant_id, created_at);
  CREATE TABLE stock_count_lines (
    id                 ${TEXT_TYPE} PRIMARY KEY,
    tenant_id          ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    count_id           ${TEXT_TYPE} NOT NULL ${references('stock_counts(id)')},
    item_id            ${TEXT_TYPE} NOT NULL ${references('stock_items(id)')},
    code               ${TEXT_TYPE} NOT NULL,
    name               ${TEXT_TYPE} NOT NULL,
    unit               ${TEXT_TYPE} NOT NULL DEFAULT 'st',
    ean                ${TEXT_TYPE} NOT NULL DEFAULT '',
    location           ${TEXT_TYPE} NOT NULL DEFAULT '',
    expected_qty       DOUBLE PRECISION NOT NULL,
    unit_cost          DOUBLE PRECISION,
    cost_source        ${TEXT_TYPE} NOT NULL DEFAULT 'onbekend',
    counted_qty        DOUBLE PRECISION,
    counted_at         ${TEXT_TYPE},
    counted_by         ${TEXT_TYPE},
    counted_by_name    ${TEXT_TYPE} NOT NULL DEFAULT '',
    status             ${TEXT_TYPE} NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'geteld', 'hertellen')),
    resolution         ${TEXT_TYPE},
    expected_at_count  DOUBLE PRECISION,
    moved_since        DOUBLE PRECISION,
    difference         DOUBLE PRECISION,
    movement_id        ${TEXT_TYPE},
    UNIQUE (tenant_id, count_id, item_id)
  );
  CREATE INDEX stock_count_lines_location ON stock_count_lines (tenant_id, count_id, location, code);
  CREATE INDEX stock_count_lines_item ON stock_count_lines (tenant_id, item_id);
  CREATE TABLE stock_count_entries (
    id         ${TEXT_TYPE} PRIMARY KEY,
    tenant_id  ${TEXT_TYPE} NOT NULL ${references('tenants(id)')},
    count_id   ${TEXT_TYPE} NOT NULL ${references('stock_counts(id)')},
    line_id    ${TEXT_TYPE} NOT NULL ${references('stock_count_lines(id)')},
    client_id  ${TEXT_TYPE} NOT NULL,
    qty        DOUBLE PRECISION NOT NULL,
    counted_at ${TEXT_TYPE} NOT NULL,
    user_id    ${TEXT_TYPE},
    user_name  ${TEXT_TYPE} NOT NULL DEFAULT '',
    UNIQUE (tenant_id, client_id)
  );
  CREATE INDEX stock_count_entries_line ON stock_count_entries (tenant_id, count_id, line_id, counted_at);
  `,
  // 88: prioriteit en voorraadstatus per leverancier van een artikel (zie artikelen/suppliers.js).
  `
  ALTER TABLE item_suppliers ADD COLUMN rank BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE item_suppliers ADD COLUMN stock_status ${TEXT_TYPE} NOT NULL DEFAULT '';
  UPDATE item_suppliers SET rank = ordered.position FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id, item_id ORDER BY preferred DESC, created_at, id) - 1 AS position FROM item_suppliers
  ) ordered WHERE item_suppliers.id = ordered.id;
  UPDATE item_suppliers SET preferred = CASE WHEN rank = 0 THEN 1 ELSE 0 END;
  `,
  // 89: opruimen: ongebruikte tabel met afgewezen prijsvoorstellen weg (prijzen volgen automatisch de factor) en een index op de klant van een retour (account verwijderen en klantgegevens).
  `
  DROP TABLE IF EXISTS price_proposal_rejections;
  CREATE INDEX web_returns_user ON web_returns (tenant_id, user_id);
  `,
  // 90: indexen op FK-kolommen en opzoekingen zonder index, gedeeltelijke index voor de webshopsync en CHECK op statuskolommen (NOT VALID: bestaande rijen blijven ongemoeid, nieuwe schrijfacties worden wel gecontroleerd).
  `
  CREATE INDEX work_orders_owner ON work_orders (tenant_id, owner_id);
  CREATE INDEX audit_user ON audit (tenant_id, user_id, created_at);
  CREATE INDEX stock_cost_entries_item ON stock_cost_entries (tenant_id, item_id);
  CREATE INDEX stock_count_entries_line_only ON stock_count_entries (tenant_id, line_id);
  CREATE INDEX support_grants_tenant ON support_grants (tenant_id);
  CREATE INDEX impersonations_tenant ON impersonations (tenant_id);
  CREATE INDEX web_orders_email ON web_orders (tenant_id, lower(email));
  CREATE INDEX stock_alerts_email_lower ON stock_alerts (tenant_id, lower(email));
  DROP INDEX stock_items_dirty;
  CREATE INDEX stock_items_dirty ON stock_items (tenant_id) WHERE shop_dirty = 1;
  ALTER TABLE web_orders ADD CONSTRAINT web_orders_status_check CHECK (status IN ('nieuw', 'verzonden', 'afgerond', 'geannuleerd')) NOT VALID;
  ALTER TABLE web_returns ADD CONSTRAINT web_returns_status_check CHECK (status IN ('aangevraagd', 'goedgekeurd', 'afgewezen', 'ingetrokken', 'afgerond')) NOT VALID;
  ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check CHECK (status IN ('concept', 'besteld', 'deels_ontvangen', 'ontvangen', 'geannuleerd')) NOT VALID;
  `,
  // 91: geldbedragen, prijzen en hoeveelheden van DOUBLE PRECISION naar NUMERIC (exacte decimalen, geen afrondingsfouten bij sommen). Bedragen 2 decimalen, prijzen en hoeveelheden 4, factoren en percentages 4. De databaselaag leest NUMERIC al als getal (pgdb-worker, pg-pool).
  `
  ALTER TABLE invoices ALTER COLUMN subtotal TYPE NUMERIC(14,2) USING round(subtotal::numeric, 2);
  ALTER TABLE invoices ALTER COLUMN vat_total TYPE NUMERIC(14,2) USING round(vat_total::numeric, 2);
  ALTER TABLE invoices ALTER COLUMN total TYPE NUMERIC(14,2) USING round(total::numeric, 2);
  ALTER TABLE quotes ALTER COLUMN total_excl TYPE NUMERIC(14,2) USING round(total_excl::numeric, 2);
  ALTER TABLE quotes ALTER COLUMN total_incl TYPE NUMERIC(14,2) USING round(total_incl::numeric, 2);
  ALTER TABLE web_orders ALTER COLUMN total TYPE NUMERIC(14,2) USING round(total::numeric, 2);
  ALTER TABLE invoice_payments ALTER COLUMN amount TYPE NUMERIC(14,2) USING round(amount::numeric, 2);
  ALTER TABLE web_sale_lines ALTER COLUMN revenue TYPE NUMERIC(14,2) USING round(revenue::numeric, 2);
  ALTER TABLE work_order_offers ALTER COLUMN fee TYPE NUMERIC(14,2) USING round(fee::numeric, 2);
  ALTER TABLE item_packagings ALTER COLUMN sale_price TYPE NUMERIC(14,4) USING round(sale_price::numeric, 4);
  ALTER TABLE item_packagings ALTER COLUMN business_price TYPE NUMERIC(14,4) USING round(business_price::numeric, 4);
  ALTER TABLE item_suppliers ALTER COLUMN cost_price TYPE NUMERIC(14,4) USING round(cost_price::numeric, 4);
  ALTER TABLE purchase_order_lines ALTER COLUMN unit_cost TYPE NUMERIC(14,4) USING round(unit_cost::numeric, 4);
  ALTER TABLE shop_products ALTER COLUMN price TYPE NUMERIC(14,4) USING round(price::numeric, 4);
  ALTER TABLE stock_cost_entries ALTER COLUMN unit_cost TYPE NUMERIC(14,4) USING round(unit_cost::numeric, 4);
  ALTER TABLE stock_cost_prices ALTER COLUMN price TYPE NUMERIC(14,4) USING round(price::numeric, 4);
  ALTER TABLE stock_count_lines ALTER COLUMN unit_cost TYPE NUMERIC(14,4) USING round(unit_cost::numeric, 4);
  ALTER TABLE stock_items ALTER COLUMN cost_price TYPE NUMERIC(14,4) USING round(cost_price::numeric, 4);
  ALTER TABLE stock_items ALTER COLUMN sale_price TYPE NUMERIC(14,4) USING round(sale_price::numeric, 4);
  ALTER TABLE stock_items ALTER COLUMN business_price TYPE NUMERIC(14,4) USING round(business_price::numeric, 4);
  ALTER TABLE stock_items ALTER COLUMN shop_price_seen TYPE NUMERIC(14,4) USING round(shop_price_seen::numeric, 4);
  ALTER TABLE stock_layers ALTER COLUMN unit_cost TYPE NUMERIC(14,4) USING round(unit_cost::numeric, 4);
  ALTER TABLE item_suppliers ALTER COLUMN order_qty TYPE NUMERIC(14,4) USING round(order_qty::numeric, 4);
  ALTER TABLE purchase_order_lines ALTER COLUMN qty TYPE NUMERIC(14,4) USING round(qty::numeric, 4);
  ALTER TABLE purchase_order_lines ALTER COLUMN received_qty TYPE NUMERIC(14,4) USING round(received_qty::numeric, 4);
  ALTER TABLE stock_cost_entries ALTER COLUMN qty TYPE NUMERIC(14,4) USING round(qty::numeric, 4);
  ALTER TABLE stock_count_entries ALTER COLUMN qty TYPE NUMERIC(14,4) USING round(qty::numeric, 4);
  ALTER TABLE stock_count_lines ALTER COLUMN counted_qty TYPE NUMERIC(14,4) USING round(counted_qty::numeric, 4);
  ALTER TABLE stock_count_lines ALTER COLUMN difference TYPE NUMERIC(14,4) USING round(difference::numeric, 4);
  ALTER TABLE stock_count_lines ALTER COLUMN expected_at_count TYPE NUMERIC(14,4) USING round(expected_at_count::numeric, 4);
  ALTER TABLE stock_count_lines ALTER COLUMN expected_qty TYPE NUMERIC(14,4) USING round(expected_qty::numeric, 4);
  ALTER TABLE stock_count_lines ALTER COLUMN moved_since TYPE NUMERIC(14,4) USING round(moved_since::numeric, 4);
  ALTER TABLE stock_items ALTER COLUMN min_qty TYPE NUMERIC(14,4) USING round(min_qty::numeric, 4);
  ALTER TABLE stock_items ALTER COLUMN on_hand TYPE NUMERIC(14,4) USING round(on_hand::numeric, 4);
  ALTER TABLE stock_items ALTER COLUMN reorder_qty TYPE NUMERIC(14,4) USING round(reorder_qty::numeric, 4);
  ALTER TABLE stock_items ALTER COLUMN shop_stock_seen TYPE NUMERIC(14,4) USING round(shop_stock_seen::numeric, 4);
  ALTER TABLE stock_layers ALTER COLUMN qty TYPE NUMERIC(14,4) USING round(qty::numeric, 4);
  ALTER TABLE stock_layers ALTER COLUMN remaining TYPE NUMERIC(14,4) USING round(remaining::numeric, 4);
  ALTER TABLE stock_movements ALTER COLUMN balance TYPE NUMERIC(14,4) USING round(balance::numeric, 4);
  ALTER TABLE stock_movements ALTER COLUMN qty TYPE NUMERIC(14,4) USING round(qty::numeric, 4);
  ALTER TABLE stock_reservations ALTER COLUMN qty TYPE NUMERIC(14,4) USING round(qty::numeric, 4);
  ALTER TABLE web_sale_lines ALTER COLUMN qty TYPE NUMERIC(14,4) USING round(qty::numeric, 4);
  ALTER TABLE work_order_materials ALTER COLUMN qty TYPE NUMERIC(14,4) USING round(qty::numeric, 4);
  ALTER TABLE stock_items ALTER COLUMN price_factor TYPE NUMERIC(10,4) USING round(price_factor::numeric, 4);
  ALTER TABLE users ALTER COLUMN wholesale_discount TYPE NUMERIC(10,4) USING round(wholesale_discount::numeric, 4);
  ALTER TABLE stock_items ALTER COLUMN unit_content TYPE NUMERIC(10,4) USING round(unit_content::numeric, 4);
  `,
  // 92: ontbrekende foreign keys op de belangrijkste verwijzingen (NOT VALID: bestaande rijen worden niet gecontroleerd, nieuwe en gewijzigde rijen wel; verwijzingen naar iets dat wordt verwijderd gaan naar NULL waar de kolom leeg mag zijn).
  `
  ALTER TABLE invoices ADD CONSTRAINT invoices_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
  ALTER TABLE invoices ADD CONSTRAINT invoices_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
  ALTER TABLE invoices ADD CONSTRAINT invoices_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
  ALTER TABLE invoices ADD CONSTRAINT invoices_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES debtors(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
  ALTER TABLE work_orders ADD CONSTRAINT work_orders_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
  ALTER TABLE stock_items ADD CONSTRAINT stock_items_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES stock_items(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
  ALTER TABLE service_requests ADD CONSTRAINT service_requests_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
  ALTER TABLE service_requests ADD CONSTRAINT service_requests_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
  ALTER TABLE oauth_grants ADD CONSTRAINT oauth_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
  ALTER TABLE news ADD CONSTRAINT news_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
  `,
  // 93: vlaggen (BIGINT 0/1) krijgen een CHECK zodat er nooit iets anders in komt (NOT VALID: bestaande rijen worden niet gecontroleerd, nieuwe en gewijzigde wel). Echte boolean-kolommen zijn bewust niet gekozen: de code schrijft en vergelijkt overal met 0/1.
  `
  ALTER TABLE item_packagings ADD CONSTRAINT item_packagings_active_flag CHECK (active IN (0, 1)) NOT VALID;
  ALTER TABLE item_suppliers ADD CONSTRAINT item_suppliers_preferred_flag CHECK (preferred IN (0, 1)) NOT VALID;
  ALTER TABLE item_text_drafts ADD CONSTRAINT item_text_drafts_edited_flag CHECK (edited IN (0, 1)) NOT VALID;
  ALTER TABLE news ADD CONSTRAINT news_pinned_flag CHECK (pinned IN (0, 1)) NOT VALID;
  ALTER TABLE service_requests ADD CONSTRAINT service_requests_urgent_flag CHECK (urgent IN (0, 1)) NOT VALID;
  ALTER TABLE shop_products ADD CONSTRAINT shop_products_in_stock_flag CHECK (in_stock IN (0, 1)) NOT VALID;
  ALTER TABLE stock_items ADD CONSTRAINT stock_items_archived_flag CHECK (archived IN (0, 1)) NOT VALID;
  ALTER TABLE stock_items ADD CONSTRAINT stock_items_archived_by_parent_flag CHECK (archived_by_parent IN (0, 1)) NOT VALID;
  ALTER TABLE stock_items ADD CONSTRAINT stock_items_has_variants_flag CHECK (has_variants IN (0, 1)) NOT VALID;
  ALTER TABLE stock_items ADD CONSTRAINT stock_items_shop_dirty_flag CHECK (shop_dirty IN (0, 1)) NOT VALID;
  ALTER TABLE stock_items ADD CONSTRAINT stock_items_shop_sync_flag CHECK (shop_sync IN (0, 1)) NOT VALID;
  ALTER TABLE stock_items ADD CONSTRAINT stock_items_stock_managed_flag CHECK (stock_managed IN (0, 1)) NOT VALID;
  ALTER TABLE suppliers ADD CONSTRAINT suppliers_archived_flag CHECK (archived IN (0, 1)) NOT VALID;
  ALTER TABLE tenants ADD CONSTRAINT tenants_disabled_flag CHECK (disabled IN (0, 1)) NOT VALID;
  ALTER TABLE users ADD CONSTRAINT users_disabled_flag CHECK (disabled IN (0, 1)) NOT VALID;
  ALTER TABLE users ADD CONSTRAINT users_must_change_password_flag CHECK (must_change_password IN (0, 1)) NOT VALID;
  ALTER TABLE users ADD CONSTRAINT users_platform_admin_flag CHECK (platform_admin IN (0, 1)) NOT VALID;
  ALTER TABLE users ADD CONSTRAINT users_reminders_off_flag CHECK (reminders_off IN (0, 1)) NOT VALID;
  ALTER TABLE users ADD CONSTRAINT users_wholesale_flag CHECK (wholesale IN (0, 1)) NOT VALID;
  ALTER TABLE visma_log ADD CONSTRAINT visma_log_ok_flag CHECK (ok IN (0, 1)) NOT VALID;
  ALTER TABLE work_order_photos ADD CONSTRAINT work_order_photos_customer_visible_flag CHECK (customer_visible IN (0, 1)) NOT VALID;
  ALTER TABLE invoices ADD CONSTRAINT invoices_stock_booked_flag CHECK (stock_booked IN (0, 1)) NOT VALID;
  `,
  // 94: tijdstippen (kolommen *_at, ISO-tekst) worden echte TIMESTAMPTZ. De pg-driver geeft ze als dezelfde ISO-tekst terug (database/pg-types.js) en de verbinding staat op UTC. Een waarde die geen ISO-tijdstip is (met T of spatie) wordt NULL (bij NOT NULL: 1970-01-01); de vier meldmomenten van monitor_incidents gebruikten lege tekst voor 'nog niet' en worden nu NULL.
  `
  SET TIME ZONE 'UTC';
  CREATE FUNCTION migrate_ts(value TEXT) RETURNS TIMESTAMPTZ LANGUAGE plpgsql IMMUTABLE AS $fn$
  BEGIN
    IF value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}' THEN RETURN value::timestamptz; END IF;
    RETURN NULL;
  EXCEPTION WHEN others THEN RETURN NULL;
  END
  $fn$;
  ALTER TABLE monitor_incidents ALTER COLUMN notified_at DROP DEFAULT;
  ALTER TABLE monitor_incidents ALTER COLUMN notified_at DROP NOT NULL;
  ALTER TABLE monitor_incidents ALTER COLUMN reminded_at DROP DEFAULT;
  ALTER TABLE monitor_incidents ALTER COLUMN reminded_at DROP NOT NULL;
  ALTER TABLE monitor_incidents ALTER COLUMN resolved_at DROP DEFAULT;
  ALTER TABLE monitor_incidents ALTER COLUMN resolved_at DROP NOT NULL;
  ALTER TABLE monitor_incidents ALTER COLUMN resolved_notified_at DROP DEFAULT;
  ALTER TABLE monitor_incidents ALTER COLUMN resolved_notified_at DROP NOT NULL;
  ALTER TABLE account_tokens ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE account_tokens ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(expires_at), 'epoch'::timestamptz);
  ALTER TABLE account_tokens ALTER COLUMN used_at TYPE TIMESTAMPTZ USING migrate_ts(used_at);
  ALTER TABLE ai_usage ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE app_logs ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE app_logs ALTER COLUMN first_at TYPE TIMESTAMPTZ USING migrate_ts(first_at);
  ALTER TABLE audit ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE debtors ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE debtors ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE history ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE history ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE impersonations ALTER COLUMN ended_at TYPE TIMESTAMPTZ USING migrate_ts(ended_at);
  ALTER TABLE impersonations ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(expires_at), 'epoch'::timestamptz);
  ALTER TABLE impersonations ALTER COLUMN started_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(started_at), 'epoch'::timestamptz);
  ALTER TABLE invoice_payments ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE invoice_payments ALTER COLUMN paid_at TYPE TIMESTAMPTZ USING migrate_ts(paid_at);
  ALTER TABLE invoice_reminders ALTER COLUMN sent_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(sent_at), 'epoch'::timestamptz);
  ALTER TABLE invoices ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE invoices ALTER COLUMN credited_at TYPE TIMESTAMPTZ USING migrate_ts(credited_at);
  ALTER TABLE invoices ALTER COLUMN exported_at TYPE TIMESTAMPTZ USING migrate_ts(exported_at);
  ALTER TABLE invoices ALTER COLUMN finalized_at TYPE TIMESTAMPTZ USING migrate_ts(finalized_at);
  ALTER TABLE invoices ALTER COLUMN paid_at TYPE TIMESTAMPTZ USING migrate_ts(paid_at);
  ALTER TABLE invoices ALTER COLUMN sent_at TYPE TIMESTAMPTZ USING migrate_ts(sent_at);
  ALTER TABLE invoices ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE invoices ALTER COLUMN visma_synced_at TYPE TIMESTAMPTZ USING migrate_ts(visma_synced_at);
  ALTER TABLE item_images ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE item_packagings ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE item_suppliers ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE item_text_drafts ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE item_text_drafts ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE monitor_incidents ALTER COLUMN first_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(first_at), 'epoch'::timestamptz);
  ALTER TABLE monitor_incidents ALTER COLUMN last_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(last_at), 'epoch'::timestamptz);
  ALTER TABLE monitor_incidents ALTER COLUMN notified_at TYPE TIMESTAMPTZ USING migrate_ts(notified_at);
  ALTER TABLE monitor_incidents ALTER COLUMN reminded_at TYPE TIMESTAMPTZ USING migrate_ts(reminded_at);
  ALTER TABLE monitor_incidents ALTER COLUMN resolved_at TYPE TIMESTAMPTZ USING migrate_ts(resolved_at);
  ALTER TABLE monitor_incidents ALTER COLUMN resolved_notified_at TYPE TIMESTAMPTZ USING migrate_ts(resolved_notified_at);
  ALTER TABLE news ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE news ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE oauth_grants ALTER COLUMN access_expires_at TYPE TIMESTAMPTZ USING migrate_ts(access_expires_at);
  ALTER TABLE oauth_grants ALTER COLUMN code_expires_at TYPE TIMESTAMPTZ USING migrate_ts(code_expires_at);
  ALTER TABLE oauth_grants ALTER COLUMN code_used_at TYPE TIMESTAMPTZ USING migrate_ts(code_used_at);
  ALTER TABLE oauth_grants ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE oauth_grants ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(expires_at), 'epoch'::timestamptz);
  ALTER TABLE oauth_grants ALTER COLUMN last_used_at TYPE TIMESTAMPTZ USING migrate_ts(last_used_at);
  ALTER TABLE oauth_grants ALTER COLUMN refresh_expires_at TYPE TIMESTAMPTZ USING migrate_ts(refresh_expires_at);
  ALTER TABLE oauth_grants ALTER COLUMN revoked_at TYPE TIMESTAMPTZ USING migrate_ts(revoked_at);
  ALTER TABLE oauth_grants ALTER COLUMN rotated_at TYPE TIMESTAMPTZ USING migrate_ts(rotated_at);
  ALTER TABLE plan_recognitions ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE plan_recognitions ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE plans ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE plans ALTER COLUMN deleted_at TYPE TIMESTAMPTZ USING migrate_ts(deleted_at);
  ALTER TABLE plans ALTER COLUMN review_requested_at TYPE TIMESTAMPTZ USING migrate_ts(review_requested_at);
  ALTER TABLE plans ALTER COLUMN reviewed_at TYPE TIMESTAMPTZ USING migrate_ts(reviewed_at);
  ALTER TABLE plans ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE purchase_orders ALTER COLUMN closed_at TYPE TIMESTAMPTZ USING migrate_ts(closed_at);
  ALTER TABLE purchase_orders ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE purchase_orders ALTER COLUMN mail_sent_at TYPE TIMESTAMPTZ USING migrate_ts(mail_sent_at);
  ALTER TABLE purchase_orders ALTER COLUMN ordered_at TYPE TIMESTAMPTZ USING migrate_ts(ordered_at);
  ALTER TABLE purchase_orders ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE purchase_proposal_dismissals ALTER COLUMN dismissed_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(dismissed_at), 'epoch'::timestamptz);
  ALTER TABLE quotes ALTER COLUMN converted_at TYPE TIMESTAMPTZ USING migrate_ts(converted_at);
  ALTER TABLE quotes ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE quotes ALTER COLUMN deleted_at TYPE TIMESTAMPTZ USING migrate_ts(deleted_at);
  ALTER TABLE quotes ALTER COLUMN followup_at TYPE TIMESTAMPTZ USING migrate_ts(followup_at);
  ALTER TABLE quotes ALTER COLUMN last_viewed_at TYPE TIMESTAMPTZ USING migrate_ts(last_viewed_at);
  ALTER TABLE quotes ALTER COLUMN responded_at TYPE TIMESTAMPTZ USING migrate_ts(responded_at);
  ALTER TABLE quotes ALTER COLUMN sent_at TYPE TIMESTAMPTZ USING migrate_ts(sent_at);
  ALTER TABLE quotes ALTER COLUMN shared_at TYPE TIMESTAMPTZ USING migrate_ts(shared_at);
  ALTER TABLE quotes ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE quotes ALTER COLUMN viewed_at TYPE TIMESTAMPTZ USING migrate_ts(viewed_at);
  ALTER TABLE roles ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE roles ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE season_reminders_sent ALTER COLUMN sent_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(sent_at), 'epoch'::timestamptz);
  ALTER TABLE service_request_photos ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE service_requests ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE service_requests ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE sessions ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE sessions ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(expires_at), 'epoch'::timestamptz);
  ALTER TABLE sessions ALTER COLUMN last_seen_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(last_seen_at), 'epoch'::timestamptz);
  ALTER TABLE settings ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE shop_content ALTER COLUMN published_at TYPE TIMESTAMPTZ USING migrate_ts(published_at);
  ALTER TABLE shop_content ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE shop_images ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE shop_search_misses ALTER COLUMN first_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(first_at), 'epoch'::timestamptz);
  ALTER TABLE shop_search_misses ALTER COLUMN last_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(last_at), 'epoch'::timestamptz);
  ALTER TABLE shop_sync ALTER COLUMN last_attempt_at TYPE TIMESTAMPTZ USING migrate_ts(last_attempt_at);
  ALTER TABLE shop_sync ALTER COLUMN orders_synced_at TYPE TIMESTAMPTZ USING migrate_ts(orders_synced_at);
  ALTER TABLE shop_sync ALTER COLUMN synced_at TYPE TIMESTAMPTZ USING migrate_ts(synced_at);
  ALTER TABLE sprinkler_library ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE stock_alerts ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE stock_cost_entries ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE stock_cost_prices ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE stock_count_entries ALTER COLUMN counted_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(counted_at), 'epoch'::timestamptz);
  ALTER TABLE stock_count_lines ALTER COLUMN counted_at TYPE TIMESTAMPTZ USING migrate_ts(counted_at);
  ALTER TABLE stock_counts ALTER COLUMN closed_at TYPE TIMESTAMPTZ USING migrate_ts(closed_at);
  ALTER TABLE stock_counts ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE stock_counts ALTER COLUMN frozen_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(frozen_at), 'epoch'::timestamptz);
  ALTER TABLE stock_items ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE stock_items ALTER COLUMN shop_synced_at TYPE TIMESTAMPTZ USING migrate_ts(shop_synced_at);
  ALTER TABLE stock_items ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE stock_layers ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE stock_layers ALTER COLUMN received_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(received_at), 'epoch'::timestamptz);
  ALTER TABLE stock_merges ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE stock_merges ALTER COLUMN undone_at TYPE TIMESTAMPTZ USING migrate_ts(undone_at);
  ALTER TABLE stock_movements ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE stock_reservations ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE stock_units ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE suppliers ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE suppliers ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE support_grants ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE support_grants ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(expires_at), 'epoch'::timestamptz);
  ALTER TABLE support_grants ALTER COLUMN revoked_at TYPE TIMESTAMPTZ USING migrate_ts(revoked_at);
  ALTER TABLE tenants ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE tenants ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING migrate_ts(updated_at);
  ALTER TABLE users ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE users ALTER COLUMN email_verified_at TYPE TIMESTAMPTZ USING migrate_ts(email_verified_at);
  ALTER TABLE users ALTER COLUMN last_seen_at TYPE TIMESTAMPTZ USING migrate_ts(last_seen_at);
  ALTER TABLE users ALTER COLUMN totp_enabled_at TYPE TIMESTAMPTZ USING migrate_ts(totp_enabled_at);
  ALTER TABLE visma_log ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE visma_log ALTER COLUMN last_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(last_at), 'epoch'::timestamptz);
  ALTER TABLE web_order_slips ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE web_orders ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE web_orders ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE web_returns ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE web_returns ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE web_sale_lines ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE web_sale_lines ALTER COLUMN sold_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(sold_at), 'epoch'::timestamptz);
  ALTER TABLE work_order_hours ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE work_order_hours ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE work_order_materials ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE work_order_materials ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE work_order_offers ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE work_order_offers ALTER COLUMN responded_at TYPE TIMESTAMPTZ USING migrate_ts(responded_at);
  ALTER TABLE work_order_offers ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE work_order_photos ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE work_order_photos ALTER COLUMN taken_at TYPE TIMESTAMPTZ USING migrate_ts(taken_at);
  ALTER TABLE work_orders ALTER COLUMN created_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(created_at), 'epoch'::timestamptz);
  ALTER TABLE work_orders ALTER COLUMN deleted_at TYPE TIMESTAMPTZ USING migrate_ts(deleted_at);
  ALTER TABLE work_orders ALTER COLUMN sent_at TYPE TIMESTAMPTZ USING migrate_ts(sent_at);
  ALTER TABLE work_orders ALTER COLUMN shared_at TYPE TIMESTAMPTZ USING migrate_ts(shared_at);
  ALTER TABLE work_orders ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING COALESCE(migrate_ts(updated_at), 'epoch'::timestamptz);
  ALTER TABLE work_orders ALTER COLUMN viewed_at TYPE TIMESTAMPTZ USING migrate_ts(viewed_at);
  DROP FUNCTION migrate_ts(TEXT);
  `,
  // 95: het gegevensveld van bestellingen, werkorders, facturen en offertes wordt JSONB (gecontroleerd op geldige JSON, sneller te doorzoeken, kleiner in de back-up). De pg-driver geeft jsonb als JSON-tekst terug (database/pg-types.js), dus de code merkt niets; de SQL cast de kolom al naar jsonb. Een regel met ongeldige JSON, of een gegevensveld dat geen object is, laat de migratie stoppen in plaats van gegevens te verliezen.
  `
  ALTER TABLE web_orders ALTER COLUMN data TYPE JSONB USING data::jsonb;
  ALTER TABLE work_orders ALTER COLUMN data TYPE JSONB USING data::jsonb;
  ALTER TABLE invoices ALTER COLUMN data TYPE JSONB USING data::jsonb;
  ALTER TABLE quotes ALTER COLUMN data TYPE JSONB USING data::jsonb;
  ALTER TABLE web_orders ADD CONSTRAINT web_orders_data_object CHECK (jsonb_typeof(data) = 'object');
  ALTER TABLE work_orders ADD CONSTRAINT work_orders_data_object CHECK (jsonb_typeof(data) = 'object');
  ALTER TABLE invoices ADD CONSTRAINT invoices_data_object CHECK (jsonb_typeof(data) = 'object');
  ALTER TABLE quotes ADD CONSTRAINT quotes_data_object CHECK (jsonb_typeof(data) = 'object');
  `,
  // 96: een reservering hoort bij een werkorder óf een webshopbestelling. Voorheen stond beide in één tekstkolom (`order:<id>` voor een bestelling), zonder verwijzing. Nu hebben ze elk een eigen kolom met een echte verwijzing (verdwijnt mee met de order), en een controle dat er precies één is gevuld. Reserveringen waarvan de order niet (meer) bestaat zijn zinloos en worden eerst verwijderd.
  `
  DELETE FROM stock_reservations r
    WHERE (r.work_order_id LIKE 'order:%' AND NOT EXISTS (SELECT 1 FROM web_orders o WHERE o.tenant_id = r.tenant_id AND o.id = substr(r.work_order_id, 7)))
       OR (r.work_order_id NOT LIKE 'order:%' AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.tenant_id = r.tenant_id AND w.id = r.work_order_id));
  ALTER TABLE stock_reservations ADD COLUMN web_order_id TEXT;
  UPDATE stock_reservations SET web_order_id = substr(work_order_id, 7), work_order_id = NULL WHERE work_order_id LIKE 'order:%';
  ALTER TABLE stock_reservations DROP CONSTRAINT stock_reservations_pkey;
  ALTER TABLE stock_reservations ALTER COLUMN work_order_id DROP NOT NULL;
  ALTER TABLE stock_reservations ADD CONSTRAINT stock_reservations_work_order_fkey FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  ALTER TABLE stock_reservations ADD CONSTRAINT stock_reservations_web_order_fkey FOREIGN KEY (web_order_id) REFERENCES web_orders(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  ALTER TABLE stock_reservations ADD CONSTRAINT stock_reservations_one_owner CHECK (num_nonnulls(work_order_id, web_order_id) = 1);
  CREATE UNIQUE INDEX stock_reservations_work_order ON stock_reservations (tenant_id, work_order_id, item_id) WHERE work_order_id IS NOT NULL;
  CREATE UNIQUE INDEX stock_reservations_web_order ON stock_reservations (tenant_id, web_order_id, item_id) WHERE web_order_id IS NOT NULL;
  `,
  // 97: alle id's en verwijzingen naar id's worden uuid (zie UUID_COLUMNS), met echte foreign keys die weer terugkomen.
  uuidMigrationSql(),
  // 98: één aanbetalingsfactuur per offerte (de factuur draagt `data.deposit`; een gecrediteerde telt niet meer mee, dus een nieuwe kan dan weer).
  `
  CREATE UNIQUE INDEX invoices_deposit_once ON invoices (tenant_id, quote_id) WHERE kind = 'factuur' AND credited_at IS NULL AND (data -> 'deposit') IS NOT NULL;
  `,
  // 99: gerelateerde artikelen. item_related = "Past bij" (handmatig of door de AI, met reden en bronnen); item_specs = de opgezochte specificaties per hoofdartikel
  // (alleen de AI-koppeling gebruikt ze); item_together = "Vaak samen besteld", berekend uit verzonden bestellingen (web_sale_lines).
  `
  CREATE TABLE item_related (
    id              UUID PRIMARY KEY,
    tenant_id       UUID NOT NULL ${references('tenants(id)')},
    item_id         UUID NOT NULL ${references('stock_items(id)', ' ON DELETE CASCADE')},
    related_item_id UUID NOT NULL ${references('stock_items(id)', ' ON DELETE CASCADE')},
    position        INTEGER NOT NULL DEFAULT 0,
    source          ${TEXT_TYPE} NOT NULL CHECK (source IN ('handmatig', 'ai')),
    reason          ${TEXT_TYPE} NOT NULL DEFAULT '',
    evidence        ${TEXT_TYPE} NOT NULL DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (item_id <> related_item_id)
  );
  CREATE UNIQUE INDEX item_related_pair ON item_related (tenant_id, item_id, related_item_id);
  CREATE INDEX item_related_item ON item_related (tenant_id, item_id, position);
  CREATE INDEX item_related_target ON item_related (tenant_id, related_item_id);
  CREATE TABLE item_specs (
    tenant_id  UUID NOT NULL ${references('tenants(id)')},
    item_id    UUID NOT NULL ${references('stock_items(id)', ' ON DELETE CASCADE')},
    status     ${TEXT_TYPE} NOT NULL CHECK (status IN ('gevonden', 'niet_gevonden')),
    specs      ${TEXT_TYPE} NOT NULL DEFAULT '{}',
    model      ${TEXT_TYPE} NOT NULL DEFAULT '',
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, item_id)
  );
  CREATE TABLE item_together (
    tenant_id    UUID NOT NULL ${references('tenants(id)')},
    item_id      UUID NOT NULL ${references('stock_items(id)', ' ON DELETE CASCADE')},
    other_id     UUID NOT NULL ${references('stock_items(id)', ' ON DELETE CASCADE')},
    orders_both  INTEGER NOT NULL,
    orders_item  INTEGER NOT NULL,
    orders_other INTEGER NOT NULL,
    lift         DOUBLE PRECISION NOT NULL,
    score        DOUBLE PRECISION NOT NULL,
    computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, item_id, other_id)
  );
  CREATE INDEX item_together_item ON item_together (tenant_id, item_id, score DESC);
  `,
  // 100: archief. Een gearchiveerd plan, offerte, werkorder, factuur, webshopbestelling of klant blijft bestaan (nummers blijven bezet, planner-leerdata
  // blijft staan) maar verdwijnt standaard uit de lijsten en KPI's; terughalen = archived_at leegmaken. Gedeeltelijke indexen voor het archiefscherm.
  `
  ALTER TABLE plans ADD COLUMN archived_at TIMESTAMPTZ;
  CREATE INDEX plans_archived ON plans (tenant_id, archived_at) WHERE archived_at IS NOT NULL;
  ALTER TABLE quotes ADD COLUMN archived_at TIMESTAMPTZ;
  CREATE INDEX quotes_archived ON quotes (tenant_id, archived_at) WHERE archived_at IS NOT NULL;
  ALTER TABLE work_orders ADD COLUMN archived_at TIMESTAMPTZ;
  CREATE INDEX work_orders_archived ON work_orders (tenant_id, archived_at) WHERE archived_at IS NOT NULL;
  ALTER TABLE invoices ADD COLUMN archived_at TIMESTAMPTZ;
  CREATE INDEX invoices_archived ON invoices (tenant_id, archived_at) WHERE archived_at IS NOT NULL;
  ALTER TABLE web_orders ADD COLUMN archived_at TIMESTAMPTZ;
  CREATE INDEX web_orders_archived ON web_orders (tenant_id, archived_at) WHERE archived_at IS NOT NULL;
  ALTER TABLE users ADD COLUMN archived_at TIMESTAMPTZ;
  CREATE INDEX users_archived ON users (tenant_id, archived_at) WHERE archived_at IS NOT NULL;
  -- Hoogste uitgegeven volgnummer per soort en voorvoegsel; een nummer van een definitief verwijderd stuk komt nooit terug.
  CREATE TABLE number_floors (
    tenant_id UUID NOT NULL ${references('tenants(id)')},
    kind      ${TEXT_TYPE} NOT NULL,
    head      ${TEXT_TYPE} NOT NULL,
    floor     BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, kind, head)
  );
  `,
  // 101: orderhistorie uit de oude WordPress/WooCommerce-webshop, alleen voor "Vaak samen besteld" (geen echte bestellingen: geen voorraad, facturen of mails).
  // wp_order_lines = één regel per bestelregel (uniek per WP-bestelling en regel, dus opnieuw ophalen maakt geen dubbelingen; item_id leeg = nog niet gekoppeld);
  // wp_order_import = de stand van het ophalen per omgeving (cursor, aan/uit voor het uurlijks bijwerken, laatste fout, aantal aangemaakte klanten).
  `
  CREATE TABLE wp_order_lines (
    id           UUID PRIMARY KEY,
    tenant_id    UUID NOT NULL ${references('tenants(id)')},
    wp_order_id  ${TEXT_TYPE} NOT NULL,
    wp_line_id   ${TEXT_TYPE} NOT NULL,
    ordered_at   TIMESTAMPTZ NOT NULL,
    product_id   ${TEXT_TYPE} NOT NULL DEFAULT '',
    variation_id ${TEXT_TYPE} NOT NULL DEFAULT '',
    sku          ${TEXT_TYPE} NOT NULL DEFAULT '',
    name         ${TEXT_TYPE} NOT NULL DEFAULT '',
    qty          NUMERIC(14,4) NOT NULL DEFAULT 1,
    item_id      UUID ${references('stock_items(id)', ' ON DELETE SET NULL')},
    matched_by   ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX wp_order_lines_unique ON wp_order_lines (tenant_id, wp_order_id, wp_line_id);
  CREATE INDEX wp_order_lines_date ON wp_order_lines (tenant_id, ordered_at);
  CREATE INDEX wp_order_lines_item ON wp_order_lines (tenant_id, item_id);
  CREATE TABLE wp_order_import (
    tenant_id   UUID PRIMARY KEY ${references('tenants(id)')},
    enabled     BIGINT NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    months      INTEGER NOT NULL DEFAULT 24,
    orders_after ${TEXT_TYPE},
    started_at  TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    error       ${TEXT_TYPE},
    orders_seen BIGINT NOT NULL DEFAULT 0,
    customers_created BIGINT NOT NULL DEFAULT 0
  );
  `,
  // 102: kopgegevens van de WordPress-bestellingen (alleen lezen, voor de lijst bij Webshopbestellingen): nummer, status, klant, totaal. Geen echte bestelling: nooit voorraad, factuur,
  // mail of terugschrijven naar WordPress. De ophaalcursor gaat terug, zodat de eerstvolgende ronde de koppen van de al opgehaalde bestellingen aanvult (regels blijven ongemoeid).
  `
  CREATE TABLE wp_orders (
    id             UUID PRIMARY KEY,
    tenant_id      UUID NOT NULL ${references('tenants(id)')},
    wp_order_id    ${TEXT_TYPE} NOT NULL,
    number         ${TEXT_TYPE} NOT NULL,
    status         ${TEXT_TYPE} NOT NULL DEFAULT '',
    ordered_at     TIMESTAMPTZ NOT NULL,
    customer_name  ${TEXT_TYPE} NOT NULL DEFAULT '',
    company        ${TEXT_TYPE} NOT NULL DEFAULT '',
    email          ${TEXT_TYPE} NOT NULL DEFAULT '',
    phone          ${TEXT_TYPE} NOT NULL DEFAULT '',
    total          DOUBLE PRECISION NOT NULL DEFAULT 0,
    payment_title  ${TEXT_TYPE} NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX wp_orders_unique ON wp_orders (tenant_id, wp_order_id);
  CREATE INDEX wp_orders_date ON wp_orders (tenant_id, ordered_at);
  UPDATE wp_order_import SET orders_after = NULL;
  `,
  // 103: eigen taal voor artikelen: een hoofdartikel heet een artikelgroep en een variant een subartikel (kolommen en namen in de database volgen de schermen).
  // Alleen hernoemen: geen gegevens veranderen. Oude back-ups lezen mee via RENAMED_COLUMNS (table-rows.js).
  `
  ALTER TABLE stock_items RENAME COLUMN parent_id TO group_id;
  ALTER TABLE stock_items RENAME COLUMN has_variants TO is_group;
  ALTER TABLE stock_items RENAME COLUMN variant_values TO sub_values;
  ALTER INDEX stock_items_parent RENAME TO stock_items_group;
  ALTER TABLE stock_items RENAME CONSTRAINT stock_items_parent_id_fkey TO stock_items_group_id_fkey;
  ALTER TABLE stock_items RENAME CONSTRAINT stock_items_has_variants_flag TO stock_items_is_group_flag;
  ALTER TABLE stock_merges RENAME COLUMN parent_id TO group_id;
  ALTER TABLE stock_merges RENAME COLUMN parent_code TO group_code;
  ALTER TABLE stock_merges RENAME COLUMN parent_name TO group_name;
  ALTER INDEX stock_merges_parent RENAME TO stock_merges_group;
  `,
  // 104: sprekende artikelcodes (MERK.SOORT.DIAMETER.DRAADMAAT): hoofdgroepen (merken), subgroepen (soorten, met of zonder merk) en oude nummers als zoeknaam.
  // Een artikel met een subgroep heeft een sprekende code die niet meer verandert; diameter en draadmaat staan alleen in naam en code.
  `
  CREATE TABLE main_groups (
    id         UUID PRIMARY KEY,
    tenant_id  UUID NOT NULL ${references('tenants(id)')},
    code       ${TEXT_TYPE} NOT NULL,
    name       ${TEXT_TYPE} NOT NULL,
    sort       BIGINT NOT NULL DEFAULT 0,
    archived   BIGINT NOT NULL DEFAULT 0,
    created_at ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX main_groups_code ON main_groups (tenant_id, code);
  CREATE TABLE sub_groups (
    id            UUID PRIMARY KEY,
    tenant_id     UUID NOT NULL ${references('tenants(id)')},
    main_group_id UUID ${references('main_groups(id)')},
    code          ${TEXT_TYPE} NOT NULL,
    name          ${TEXT_TYPE} NOT NULL,
    sort          BIGINT NOT NULL DEFAULT 0,
    archived      BIGINT NOT NULL DEFAULT 0,
    created_at    ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX sub_groups_code ON sub_groups (tenant_id, main_group_id, code) WHERE main_group_id IS NOT NULL;
  CREATE UNIQUE INDEX sub_groups_code_no_brand ON sub_groups (tenant_id, code) WHERE main_group_id IS NULL;
  ALTER TABLE stock_items ADD COLUMN main_group_id UUID ${references('main_groups(id)')};
  ALTER TABLE stock_items ADD COLUMN sub_group_id UUID ${references('sub_groups(id)')};
  CREATE INDEX stock_items_sub_group ON stock_items (tenant_id, sub_group_id);
  CREATE TABLE item_aliases (
    id         UUID PRIMARY KEY,
    tenant_id  UUID NOT NULL ${references('tenants(id)')},
    item_id    UUID NOT NULL ${references('stock_items(id)')},
    alias      ${TEXT_TYPE} NOT NULL,
    kind       ${TEXT_TYPE} NOT NULL DEFAULT 'oud',
    created_at ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX item_aliases_alias ON item_aliases (tenant_id, LOWER(alias));
  CREATE INDEX item_aliases_item ON item_aliases (tenant_id, item_id);
  `,
  // 105: PDF's bij artikelen (productinformatie van de leverancier): versleuteld bewaard, hoogstens een paar per artikel; `public` = te downloaden op de productpagina.
  `
  CREATE TABLE item_documents (
    id           UUID PRIMARY KEY,
    tenant_id    UUID NOT NULL ${references('tenants(id)')},
    item_id      UUID NOT NULL ${references('stock_items(id)')},
    name         ${TEXT_TYPE} NOT NULL,
    pages        BIGINT NOT NULL,
    size         BIGINT NOT NULL,
    content_hash ${TEXT_TYPE} NOT NULL,
    public       BIGINT NOT NULL DEFAULT 1,
    data         ${TEXT_TYPE} NOT NULL,
    created_at   ${TEXT_TYPE} NOT NULL
  );
  CREATE UNIQUE INDEX item_documents_hash ON item_documents (tenant_id, item_id, content_hash);
  CREATE INDEX item_documents_item ON item_documents (tenant_id, item_id);
  `,
];

module.exports = { PG_BASE, PG_BASE_VERSION, PG_MIGRATIONS, UUID_COLUMNS, RENAMED_COLUMNS, RENAMED_COLUMNS_VERSION, legacyUuid };
