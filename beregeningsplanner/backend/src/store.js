// Gegevenslaag bovenop db.js: gebruikers, plannen en de aanvraaghistorie.
// Elke functie krijgt de tenant mee; niets leest buiten de eigen tenant.
const crypto = require('crypto');
const path = require('path');
const { transaction } = require('./db');

const Roles = require(path.join(__dirname, '..', '..', 'frontend', 'shared', 'roles.js'));
const ROLES = Object.keys(Roles.ROLES);
// Opeenvolgende wijzigingen van één gebruiker aan één plan binnen dit venster
// vormen één regel in de historie (anders levert automatisch opslaan honderden
// regels per plan op).
const HISTORY_MERGE_MS = 30 * 60 * 1000;

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

// ---------- Wachtwoorden (scrypt, ingebouwd in Node) ----------
// Parameters volgens de OWASP-aanbeveling voor scrypt (N=2^17, r=8, p=1:
// 128 MiB geheugen per berekening). Asynchroon, zodat de server tijdens het
// rekenen andere verzoeken blijft beantwoorden. Oudere, lichtere hashes worden
// bij de eerstvolgende geslaagde inlog vervangen (needsRehash).
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

function scrypt(password, salt, keylen, { N, r, p }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

function needsRehash(stored) {
  const [, N, r, p] = String(stored || '').split('$');
  return +N !== SCRYPT.N || +r !== SCRYPT.r || +p !== SCRYPT.p;
}

// Veelgebruikte (delen van) wachtwoorden; vergeleken zonder cijfers en tekens,
// dus 'Wachtwoord2024!' valt er ook onder.
const COMMON = new Set(`
  wachtwoord password paswoord passwoord welkom welkomwelkom geheim geheimpje qwerty qwertyuiop azerty asdfgh
  asdfghjkl zxcvbn abcdef abcdefgh abc letmein admin administrator beheerder gebruiker iloveyou monkey dragon
  football voetbal ajax feyenoord psv sunshine princess zomer winter lente herfst voorjaar najaar maandag
  aquatech aquatechservice beregening beregeningsplanner tuin tuinman sproeier water nunspeet nederland holland
  amsterdam rotterdam utrecht test testtest changeme default master login secret trustno
`.split(/\s+/).filter(Boolean));

/** Wachtwoordbeleid (OWASP ASVS): lengte boven complexiteitsregels. */
function passwordProblem(password, username = '') {
  const pw = String(password || '');
  if (pw.length < 12) return 'Wachtwoord: minimaal 12 tekens.';
  if (pw.length > 128) return 'Wachtwoord: maximaal 128 tekens.';
  const lower = pw.toLowerCase();
  const user = String(username || '').toLowerCase();
  if (user.length >= 3 && lower.includes(user)) return 'Het wachtwoord mag je gebruikersnaam niet bevatten.';
  const core = lower.replace(/[^a-zà-ÿ]/g, '');
  if (COMMON.has(core) || COMMON.has(lower) || new Set(lower).size < 5 || /^(.{1,4})\1+$/.test(lower)) {
    return 'Dit wachtwoord is te voorspelbaar. Kies bijvoorbeeld een zin van een paar woorden.';
  }
  return null;
}

let dummyHash;
const getDummyHash = async () => (dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex')));

// ---------- Samenvatting van een plan (voor de historie) ----------
function polygonArea(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += (Number(a?.x) || 0) * (Number(b?.y) || 0) - (Number(b?.x) || 0) * (Number(a?.y) || 0);
  }
  return Math.abs(s) / 2;
}

function summarize(data) {
  const areas = Array.isArray(data?.areas) ? data.areas : [];
  const m2ByType = {};
  for (const a of areas) {
    const t = String(a?.type || 'onbekend');
    m2ByType[t] = (m2ByType[t] || 0) + polygonArea(a?.pts);
  }
  const round = (v) => Math.round(v * 10) / 10;
  for (const t of Object.keys(m2ByType)) m2ByType[t] = round(m2ByType[t]);
  const count = (k) => (Array.isArray(data?.[k]) ? data[k].length : 0);
  return {
    areas: areas.length,
    totalM2: round(Object.values(m2ByType).reduce((s, v) => s + v, 0)),
    m2ByType,
    sprinklers: count('sprinklers'),
    zones: count('zones'),
    elements: count('elements'),
  };
}

function metaOf(data) {
  const meta = (data && typeof data.meta === 'object' && data.meta) || {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  return {
    title: str(meta.name, 200) || 'Naamloos plan',
    customer: str(meta.customer, 200),
    address: str(meta.address, 300),
  };
}

// De achtergrond (foto/PDF van de tekening) kan megabytes groot zijn; die hoort
// bij het plan, maar niet in elke historieregel.
function withoutBackground(data) {
  const { background, ...rest } = data || {};
  return rest;
}

function createStore(db) {
  const q = (sql) => db.prepare(sql);

  function ensureTenant(slug = 'default', name = 'Aquatech') {
    const row = q('SELECT * FROM tenants WHERE slug = ?').get(slug);
    if (row) return row;
    const t = { id: newId(), slug, name, created_at: now() };
    q('INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, ?)').run(t.id, t.slug, t.name, t.created_at);
    return t;
  }

  // ---------- Gebruikers ----------
  function publicUser(u) {
    if (!u) return null;
    return { id: u.id, tenantId: u.tenant_id, username: u.username, displayName: u.display_name, role: u.role, kind: u.kind,
      disabled: Boolean(u.disabled), platformAdmin: Boolean(u.platform_admin), createdAt: u.created_at, lastSeenAt: u.last_seen_at };
  }

  function getUser(id) {
    return q('SELECT * FROM users WHERE id = ?').get(String(id)) || null;
  }

  function insertUser(tenantId, { username, displayName, role, kind, passwordHash = null, platformAdmin = false }) {
    const u = { id: newId(), tenant_id: tenantId, username, display_name: displayName, role, kind, password_hash: passwordHash, disabled: 0,
      platform_admin: platformAdmin ? 1 : 0, created_at: now(), last_seen_at: null };
    q(`INSERT INTO users (id, tenant_id, username, display_name, role, kind, password_hash, disabled, platform_admin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(u.id, tenantId, username, displayName, role, kind, passwordHash, u.platform_admin, u.created_at);
    return u;
  }

  // Vaste beheerder: inloggen met de (optionele) toegangscode.
  function systemUser(tenantId, username, displayName) {
    return q('SELECT * FROM users WHERE tenant_id = ? AND username = ?').get(tenantId, username)
      || insertUser(tenantId, { username, displayName, role: 'beheerder', kind: 'systeem' });
  }

  function createGuest(tenantId) {
    const tag = crypto.randomBytes(4).toString('hex');
    return insertUser(tenantId, { username: `gast-${tag}`, displayName: `Gast ${tag}`, role: 'klant', kind: 'gast' });
  }

  // Oude rolnamen (zoals 'gebruiker') gaan naar de huidige.
  const withRole = (input) => (input.role === undefined ? input : { ...input, role: Roles.normalize(input.role) });

  function validateAccount({ username, displayName, role, password }, { partial = false } = {}) {
    if (!partial || username !== undefined) {
      if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(String(username || ''))) return 'Gebruikersnaam: 3–40 tekens, kleine letters, cijfers, punt, streepje of underscore.';
      if (/^(gast-|ha-|beheerder$)/.test(username)) return 'Deze gebruikersnaam is gereserveerd.';
    }
    if (displayName !== undefined && String(displayName).trim().length > 80) return 'Naam is te lang.';
    if ((!partial || role !== undefined) && !ROLES.includes(role)) return 'Ongeldige rol.';
    if (!partial || password !== undefined) return passwordProblem(password, username);
    return null;
  }

  // Gebruikersnamen zijn uniek binnen een tenant (dezelfde voornaam kan in
  // twee organisaties voorkomen). Een gebruiker wordt overal aangeduid met zijn
  // eigen id; bij het inloggen bepaalt de organisatiecode de tenant.
  async function createAccount(tenantId, rawInput, { platformAdmin = false } = {}) {
    const input = withRole(rawInput);
    const err = validateAccount(input);
    if (err) return { error: err };
    if (usernameTaken(tenantId, input.username)) {
      return { error: 'Deze gebruikersnaam bestaat al.' };
    }
    const passwordHash = await hashPassword(input.password);
    if (usernameTaken(tenantId, input.username)) return { error: 'Deze gebruikersnaam bestaat al.' };
    const u = insertUser(tenantId, {
      username: input.username,
      displayName: String(input.displayName || '').trim() || input.username,
      role: input.role,
      kind: 'account',
      passwordHash,
      platformAdmin,
    });
    return { user: u };
  }

  async function updateAccount(tenantId, id, rawInput) {
    const input = withRole(rawInput);
    const u = q('SELECT * FROM users WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
    if (!u) return { error: 'Gebruiker niet gevonden.', status: 404 };
    if (u.kind !== 'account') return { error: 'Systeem- en gastgebruikers zijn niet aan te passen.', status: 409 };
    const err = validateAccount({ ...input, username: input.username ?? (input.password !== undefined ? u.username : undefined) }, { partial: true });
    if (err) return { error: err };
    if (input.username !== undefined) return { error: 'De gebruikersnaam is niet te wijzigen.' };
    // De laatste actieve beheerder blijft beheerder: anders verschijnt het
    // instelscherm voor een eerste beheerder weer voor iedereen.
    const losesAdmin = u.role === 'beheerder' && !u.disabled && ((input.role !== undefined && input.role !== 'beheerder') || input.disabled);
    if (losesAdmin && countAdmins(tenantId) <= 1) {
      return { error: 'Dit is de enige actieve beheerder. Maak eerst een andere beheerder aan.', status: 409 };
    }
    // De laatste actieve hoofdbeheerder blijft dat ook: anders kan niemand
    // meer bij het hoofdbeheer.
    const losesPlatform = u.platform_admin && !u.disabled && (losesAdmin || input.disabled || input.platformAdmin === false);
    if (losesPlatform && countPlatformAdmins() <= 1) {
      return { error: 'Dit is de enige actieve hoofdbeheerder. Maak eerst een andere hoofdbeheerder aan.', status: 409 };
    }
    if (input.displayName !== undefined) q('UPDATE users SET display_name = ? WHERE id = ?').run(String(input.displayName).trim() || u.username, u.id);
    if (input.role !== undefined) q('UPDATE users SET role = ? WHERE id = ?').run(input.role, u.id);
    if (input.disabled !== undefined) q('UPDATE users SET disabled = ? WHERE id = ?').run(input.disabled ? 1 : 0, u.id);
    // Hoofdbeheerder worden of af: een hoofdbeheerder is altijd beheerder.
    if (input.platformAdmin !== undefined) {
      q('UPDATE users SET platform_admin = ? WHERE id = ?').run(input.platformAdmin ? 1 : 0, u.id);
      if (input.platformAdmin) q("UPDATE users SET role = 'beheerder' WHERE id = ?").run(u.id);
    }
    const newHash = input.password !== undefined ? await hashPassword(input.password) : null;
    if (newHash) q('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, u.id);
    // Nieuw wachtwoord of uitgeschakeld: op alle toestellen uitgelogd.
    if (newHash || input.disabled) revokeSessions(tenantId, u.id);
    return { user: getUser(u.id) };
  }

  // Actieve beheerders met een eigen account (geen systeem- of gastgebruikers).
  function countAdmins(tenantId) {
    return q("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND kind = 'account' AND role = 'beheerder' AND disabled = 0").get(tenantId).n;
  }

  // Een organisatie = de live-tenant plus zijn testomgevingen (die eigen
  // testaccounts kunnen hebben). Binnen die familie is een gebruikersnaam
  // uniek, zodat inloggen met de organisatiecode altijd één account vindt.
  function familyIds(tenantId) {
    const t = tenantId && getTenant(tenantId);
    if (!t) return [];
    const root = t.environment === 'test' && t.parent_id ? t.parent_id : t.id;
    return [root, ...q('SELECT id FROM tenants WHERE parent_id = ? ORDER BY created_at').all(root).map((r) => r.id)];
  }

  const usernameTaken = (tenantId, username, { except = null } = {}) => familyIds(tenantId)
    .some((id) => id !== except && q('SELECT 1 FROM users WHERE tenant_id = ? AND username = ?').get(id, username));

  function countPlatformAdmins() {
    return q("SELECT COUNT(*) AS n FROM users WHERE kind = 'account' AND platform_admin = 1 AND disabled = 0").get().n;
  }

  // ---------- Tenants en omgevingen ----------
  // Een live-tenant is een klant (beregeningsbedrijf) met eigen gebruikers. Een
  // testomgeving hoort bij een live-tenant: eigen plannen, historie en
  // instellingen, maar dezelfde gebruikers, zodat je kunt wisselen zonder
  // opnieuw in te loggen of een andere URL te gebruiken.
  function tenantRow(t) {
    if (!t) return null;
    return { id: t.id, slug: t.slug, name: t.name, environment: t.environment || 'live', parentId: t.parent_id || null,
      disabled: Boolean(t.disabled), createdAt: t.created_at, updatedAt: t.updated_at || t.created_at };
  }

  const getTenant = (id) => q('SELECT * FROM tenants WHERE id = ?').get(String(id)) || null;
  const getTenantBySlug = (slug) => q('SELECT * FROM tenants WHERE slug = ?').get(String(slug)) || null;

  function listTenants() {
    const rows = q(`SELECT t.*,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.kind = 'account') AS user_count,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.kind = 'account' AND u.role = 'beheerder' AND u.disabled = 0) AS admin_count,
        (SELECT COUNT(*) FROM plans p WHERE p.tenant_id = t.id AND p.deleted_at IS NULL) AS plan_count,
        (SELECT MAX(h.updated_at) FROM history h WHERE h.tenant_id = t.id) AS last_activity
      FROM tenants t ORDER BY t.name COLLATE NOCASE, t.created_at`).all();
    const withStats = (t) => ({ ...tenantRow(t), userCount: t.user_count, adminCount: t.admin_count, planCount: t.plan_count, lastActivity: t.last_activity });
    const live = rows.filter((t) => (t.environment || 'live') === 'live').map((t) => ({ ...withStats(t), environments: [] }));
    const byId = new Map(live.map((t) => [t.id, t]));
    for (const t of rows) if (t.environment === 'test' && byId.has(t.parent_id)) byId.get(t.parent_id).environments.push(withStats(t));
    return live;
  }

  function validateTenant({ name, slug }, { partial = false } = {}) {
    if (!partial || name !== undefined) {
      const n = String(name || '').trim();
      if (n.length < 2 || n.length > 80) return 'Naam: 2–80 tekens.';
    }
    if (!partial || slug !== undefined) {
      if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(String(slug || ''))) return 'Code: 2–40 tekens, kleine letters, cijfers of streepje.';
      if (getTenantBySlug(slug)) return 'Deze code is al in gebruik.';
    }
    return null;
  }

  function createTenant({ name, slug }) {
    const err = validateTenant({ name, slug });
    if (err) return { error: err };
    const ts = now();
    const t = { id: newId(), slug, name: String(name).trim() };
    q("INSERT INTO tenants (id, slug, name, environment, created_at, updated_at) VALUES (?, ?, ?, 'live', ?, ?)").run(t.id, t.slug, t.name, ts, ts);
    return { tenant: getTenant(t.id) };
  }

  // De hoofdtenant (slug 'default') host de hoofdbeheerders en blijft altijd aan.
  function updateTenant(id, { name, disabled }) {
    const t = getTenant(id);
    if (!t) return { error: 'Tenant niet gevonden.', status: 404 };
    const err = validateTenant({ name }, { partial: true });
    if (err) return { error: err };
    if (disabled && t.slug === 'default') return { error: 'De hoofdtenant kan niet worden uitgeschakeld.', status: 409 };
    if (name !== undefined) q('UPDATE tenants SET name = ? WHERE id = ?').run(String(name).trim(), t.id);
    if (disabled !== undefined) q('UPDATE tenants SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, t.id);
    q('UPDATE tenants SET updated_at = ? WHERE id = ?').run(now(), t.id);
    return { tenant: getTenant(t.id) };
  }

  const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);

  /**
   * Nieuwe testomgeving bij een live-tenant. De instellingen (API-sleutel,
   * limieten, modules) worden gekopieerd; met copyPlans ook de huidige plannen
   * (nieuwe id's, zelfde eigenaar), zodat je met echte data kunt testen zonder
   * live te raken.
   */
  function createEnvironment(parentId, { name, copyPlans = false, skipSettings = [] } = {}) {
    const parent = getTenant(parentId);
    if (!parent || parent.environment !== 'live') return { error: 'Live-tenant niet gevonden.', status: 404 };
    const label = String(name || '').trim() || 'Test';
    if (label.length > 60) return { error: 'Naam: maximaal 60 tekens.' };
    const base = `${parent.slug}-${slugify(label) || 'test'}`.slice(0, 36);
    let slug = base;
    for (let i = 2; getTenantBySlug(slug); i++) slug = `${base}-${i}`;
    return transaction(db, () => {
      const ts = now();
      const id = newId();
      q("INSERT INTO tenants (id, slug, name, environment, parent_id, created_at, updated_at) VALUES (?, ?, ?, 'test', ?, ?, ?)")
        .run(id, slug, label, parent.id, ts, ts);
      // Versleutelde geheimen horen bij de tenant (zie settings.js); die
      // kopieert de server opnieuw versleuteld (skipSettings).
      for (const row of q('SELECT key, value, updated_by FROM settings WHERE tenant_id = ?').all(parent.id)) {
        if (skipSettings.includes(row.key)) continue;
        q('INSERT INTO settings (tenant_id, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)').run(id, row.key, row.value, ts, row.updated_by);
      }
      let copied = 0;
      if (copyPlans) {
        for (const p of q('SELECT * FROM plans WHERE tenant_id = ? AND deleted_at IS NULL').all(parent.id)) {
          q(`INSERT INTO plans (id, tenant_id, owner_id, title, customer, address, data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newId(), id, p.owner_id, p.title, p.customer, p.address, p.data, p.created_at, p.updated_at);
          copied++;
        }
      }
      return { tenant: getTenant(id), copied };
    });
  }

  // Voor het terugdraaien van een net aangemaakte tenant (bijv. als de eerste
  // beheerder niet aan te maken was): alleen zolang er nog niets in staat.
  function dropEmptyTenant(id) {
    const busy = q('SELECT EXISTS (SELECT 1 FROM users WHERE tenant_id = ?) OR EXISTS (SELECT 1 FROM plans WHERE tenant_id = ?) OR EXISTS (SELECT 1 FROM tenants WHERE parent_id = ?) AS n').get(id, id, id).n;
    if (busy) return false;
    transaction(db, () => {
      q('DELETE FROM settings WHERE tenant_id = ?').run(id);
      q('DELETE FROM audit WHERE tenant_id = ?').run(id);
      q('DELETE FROM tenants WHERE id = ?').run(id);
    });
    return true;
  }

  // Controle van een nieuw account zonder het aan te maken.
  function accountProblem(tenantId, input) {
    return validateAccount(input) || (usernameTaken(tenantId, input.username) ? 'Deze gebruikersnaam bestaat al.' : null);
  }

  function testEnvironment(id) {
    const t = getTenant(id);
    if (!t) return { error: 'Omgeving niet gevonden.', status: 404 };
    if (t.environment !== 'test') return { error: 'Alleen testomgevingen kunnen worden leeggemaakt of verwijderd.', status: 409 };
    return { tenant: t };
  }

  // Leegmaken: plannen, historie, auditlog, sessies en gasten weg;
  // instellingen blijven.
  function clearData(tenantId) {
    q('DELETE FROM history WHERE tenant_id = ?').run(tenantId);
    q('DELETE FROM audit WHERE tenant_id = ?').run(tenantId);
    q('DELETE FROM sessions WHERE tenant_id = ?').run(tenantId);
    q('DELETE FROM impersonations WHERE tenant_id = ?').run(tenantId);
    q('DELETE FROM support_grants WHERE tenant_id = ?').run(tenantId);
    q('DELETE FROM quotes WHERE tenant_id = ?').run(tenantId);
    q('DELETE FROM plans WHERE tenant_id = ?').run(tenantId);
    q(`DELETE FROM users WHERE tenant_id = ? AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.owner_id = users.id)
      AND NOT EXISTS (SELECT 1 FROM quotes o WHERE o.owner_id = users.id)`).run(tenantId);
  }

  function resetEnvironment(id) {
    const out = testEnvironment(id);
    if (out.error) return out;
    transaction(db, () => clearData(out.tenant.id));
    return { tenant: out.tenant };
  }

  function deleteEnvironment(id) {
    const out = testEnvironment(id);
    if (out.error) return out;
    transaction(db, () => {
      clearData(out.tenant.id);
      q('DELETE FROM settings WHERE tenant_id = ?').run(out.tenant.id);
      q('DELETE FROM tenants WHERE id = ?').run(out.tenant.id);
    });
    return { ok: true };
  }

  /**
   * Testomgeving vullen met testdata (opgebouwd in testdata.js): eerst
   * leegmaken, dan de testaccounts (allemaal met dezelfde wachtwoord-hash),
   * plannen met een regel in de historie en offertes. De accounts horen bij de
   * testomgeving zelf, dus "Leegmaken" en "Verwijderen" ruimen ze mee op.
   */
  function seedEnvironment(id, { accounts, plans, quotes }, { passwordHash, numberPrefix = 'OF-' }) {
    const out = testEnvironment(id);
    if (out.error) return out;
    const tid = out.tenant.id;
    const clash = accounts.find((a) => usernameTaken(tid, a.username, { except: tid }));
    if (clash) return { error: `De gebruikersnaam ${clash.username} bestaat al binnen deze organisatie.`, status: 409 };
    return transaction(db, () => {
      clearData(tid);
      const users = {};
      for (const a of accounts) {
        users[a.key] = insertUser(tid, { username: a.username, displayName: a.displayName, role: a.role, kind: 'account', passwordHash });
      }
      const planIds = {};
      for (const p of plans) {
        const pid = newId();
        const meta = metaOf(p.data);
        q(`INSERT INTO plans (id, tenant_id, owner_id, title, customer, address, data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(pid, tid, users[p.owner].id, meta.title, meta.customer, meta.address, JSON.stringify(p.data), p.at, p.at);
        const hid = record({ tenantId: tid, userId: users[p.owner].id, planId: pid, action: 'aangemaakt', data: p.data });
        q('UPDATE history SET created_at = ?, updated_at = ? WHERE id = ?').run(p.at, p.at, hid);
        planIds[p.key] = pid;
      }
      const seq = {};
      for (const o of [...quotes].sort((a, b) => a.at.localeCompare(b.at))) {
        const year = o.data.date.slice(0, 4);
        seq[year] = (seq[year] || 0) + 1;
        const data = { ...o.data, planId: planIds[o.planKey] || '' };
        q(`INSERT INTO quotes (id, tenant_id, owner_id, plan_id, number, status, title, customer, total_excl, total_incl, data, created_at, updated_at, customer_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(newId(), tid, users[o.owner].id, data.planId || null, `${numberPrefix}${year}-${String(seq[year]).padStart(4, '0')}`, o.status,
            data.title, data.customer.name, o.totalExcl, o.totalIncl, JSON.stringify(data), o.at, o.at, o.customerKey ? users[o.customerKey].id : null);
      }
      return { tenant: out.tenant, users: Object.values(users), counts: { accounts: accounts.length, plans: plans.length, quotes: quotes.length } };
    });
  }

  /**
   * Omgevingen waarin deze gebruiker mag werken: een hoofdbeheerder overal,
   * een beheerder in de eigen tenant en de testomgevingen daarvan, een
   * installateur of klant alleen in de eigen tenant. Uitgeschakelde tenants vallen af
   * (behalve voor de hoofdbeheerder).
   */
  function accessibleTenants(user) {
    if (!user) return [];
    if (user.platform_admin) return q('SELECT * FROM tenants ORDER BY name COLLATE NOCASE').all();
    const home = getTenant(user.tenant_id);
    if (!home || home.disabled) return [];
    if (!Roles.can(user, 'beheer')) return [home];
    return [home, ...q("SELECT * FROM tenants WHERE parent_id = ? AND environment = 'test' AND disabled = 0 ORDER BY name COLLATE NOCASE").all(home.id)];
  }

  /**
   * De tenant waarin met een organisatiecode wordt ingelogd. Leeg = de
   * hoofdtenant (daar staan de hoofdbeheerders). De code van een testomgeving
   * leidt naar de live-tenant, want daar horen de gebruikers bij. Onbekend =
   * null.
   */
  function loginTenant(code) {
    const slug = String(code ?? '').trim().toLowerCase();
    const t = slug ? getTenantBySlug(slug) : getTenantBySlug('default');
    if (!t) return null;
    return t.environment === 'test' && t.parent_id ? getTenant(t.parent_id) : getTenant(t.id);
  }

  async function authenticate(tenantId, username, password) {
    // Alleen binnen de organisatie zoeken (live-tenant en zijn testomgevingen):
    // dezelfde gebruikersnaam kan in andere organisaties voorkomen. Zonder
    // tenant (onbekende code) wordt niemand gevonden.
    const name = String(username || '').trim().toLowerCase();
    const ids = familyIds(tenantId);
    const u = ids.length
      ? q(`SELECT * FROM users WHERE username = ? AND kind = 'account' AND tenant_id IN (${ids.map(() => '?').join(', ')})
          ORDER BY tenant_id = ? DESC LIMIT 1`).get(name, ...ids, ids[0])
      : null;
    // Ook zonder gebruiker een hash uitrekenen: gelijke looptijd.
    const ok = await verifyPassword(password, u?.password_hash || await getDummyHash());
    if (!(ok && u && !u.disabled)) return null;
    if (needsRehash(u.password_hash)) {
      // Zelfde wachtwoord, sterkere hash; de lopende sessies blijven geldig.
      const hash = await hashPassword(password);
      q('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?').run(hash, u.id, u.password_hash);
      q('UPDATE sessions SET fingerprint = ? WHERE user_id = ? AND via = ?').run(fingerprintOf(hash), u.id, 'user');
      return getUser(u.id);
    }
    return u;
  }

  // ---------- Sessies ----------
  // Het token (32 willekeurige bytes) staat alleen in de cookie; de database
  // kent alleen de hash. De vingerafdruk hoort bij het wachtwoord (accounts)
  // of de toegangscode: verandert die, dan vervalt de sessie.
  const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');

  function createSession({ tenantId, userId, via, fingerprint, maxMs, ip = '', userAgent = '' }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const ts = Date.now();
    q(`INSERT INTO sessions (id_hash, tenant_id, user_id, via, fingerprint, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tokenHash(token), tenantId, userId, via, fingerprint,
      new Date(ts).toISOString(), new Date(ts).toISOString(), new Date(ts + maxMs).toISOString(), String(ip).slice(0, 64), String(userAgent).slice(0, 200));
    return token;
  }

  function findSession(token) {
    if (typeof token !== 'string' || !/^[\w-]{40,60}$/.test(token)) return null;
    return q('SELECT * FROM sessions WHERE id_hash = ?').get(tokenHash(token)) || null;
  }

  function touchSession(row) {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    if (row.last_seen_at < cutoff) q('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now(), row.id_hash);
  }

  const deleteSession = (token) => q('DELETE FROM sessions WHERE id_hash = ?').run(tokenHash(token)).changes;
  const dropSession = (row) => q('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
  const revokeSessions = (tenantId, userId) => q('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?').run(tenantId, userId).changes;

  // ---------- Auditlog ----------
  // Beveiligingsgebeurtenissen (inloggen, gebruikers, instellingen). Nooit
  // wachtwoorden, codes of sleutels in `detail`.
  function audit({ tenantId, userId = null, action, detail = {}, ip = '' }) {
    q('INSERT INTO audit (id, tenant_id, user_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), tenantId, userId, action, JSON.stringify(detail || {}), String(ip).slice(0, 64), now());
  }

  function listAudit(tenantId, { limit = 100, offset = 0, action = '' } = {}) {
    const where = ['a.tenant_id = ?'];
    const args = [tenantId];
    if (action) { where.push('a.action = ?'); args.push(String(action)); }
    const from = `FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE ${where.join(' AND ')}`;
    const total = q(`SELECT COUNT(*) AS n ${from}`).get(...args).n;
    const lim = Math.max(1, Math.min(1000, Math.floor(Number(limit)) || 100));
    const off = Math.max(0, Math.floor(Number(offset)) || 0);
    const items = q(`SELECT a.*, u.username, u.display_name ${from} ORDER BY a.created_at DESC, a.id LIMIT ? OFFSET ?`).all(...args, lim, off)
      .map((a) => ({ id: a.id, action: a.action, detail: JSON.parse(a.detail || '{}'), ip: a.ip, createdAt: a.created_at,
        user: a.user_id ? { id: a.user_id, username: a.username, displayName: a.display_name } : null }));
    return { total, items };
  }

  // ---------- Bewaartermijnen (AVG) ----------
  // IP-adressen wissen na ipDays, auditregels verwijderen na auditDays,
  // verlopen sessies opruimen.
  function applyRetention(tenantId, { ipDays, auditDays }) {
    const before = (days) => new Date(Date.now() - days * 86400000).toISOString();
    return transaction(db, () => ({
      historyIps: q("UPDATE history SET ip = '' WHERE tenant_id = ? AND ip <> '' AND updated_at < ?").run(tenantId, before(ipDays)).changes,
      auditIps: q("UPDATE audit SET ip = '' WHERE tenant_id = ? AND ip <> '' AND created_at < ?").run(tenantId, before(ipDays)).changes,
      sessionIps: q("UPDATE sessions SET ip = '' WHERE tenant_id = ? AND ip <> '' AND created_at < ?").run(tenantId, before(ipDays)).changes,
      audit: q('DELETE FROM audit WHERE tenant_id = ? AND created_at < ?').run(tenantId, before(auditDays)).changes,
      sessions: q('DELETE FROM sessions WHERE expires_at < ?').run(now()).changes,
    }));
  }

  function touchUser(id) {
    // Hooguit eens per vijf minuten schrijven.
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    q('UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)').run(now(), id, cutoff);
  }

  function listUsers(tenantId, { includeGuests = true } = {}) {
    return q(`
      SELECT u.*,
        (SELECT COUNT(*) FROM plans p WHERE p.owner_id = u.id AND p.deleted_at IS NULL) AS plan_count,
        (SELECT COUNT(*) FROM history h WHERE h.user_id = u.id) AS history_count,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS session_count
      FROM users u WHERE u.tenant_id = ? ${includeGuests ? '' : "AND u.kind <> 'gast'"}
      ORDER BY CASE u.kind WHEN 'systeem' THEN 0 WHEN 'account' THEN 1 ELSE 2 END, u.display_name COLLATE NOCASE`)
      .all(now(), tenantId)
      .map((u) => ({ ...publicUser(u), planCount: u.plan_count, historyCount: u.history_count, sessionCount: u.session_count }));
  }

  // Klantaccounts van een tenant (om een offerte aan te koppelen).
  function listCustomers(tenantId) {
    return q("SELECT * FROM users WHERE tenant_id = ? AND kind = 'account' AND role = 'klant' AND disabled = 0 ORDER BY display_name COLLATE NOCASE")
      .all(tenantId).map((u) => ({ id: u.id, username: u.username, displayName: u.display_name }));
  }

  // ---------- Historie ----------
  function record({ tenantId, userId, planId = null, action, data = null, summary: extra = null, title = '', ip = '', merge = false }) {
    const ts = now();
    const meta = data ? metaOf(data) : { title, customer: '', address: '' };
    const summary = JSON.stringify(extra || (data ? summarize(data) : {}));
    const snapshot = data ? JSON.stringify(withoutBackground(data)) : null;
    if (merge && planId) {
      const since = new Date(Date.now() - HISTORY_MERGE_MS).toISOString();
      const last = q(`SELECT id FROM history WHERE tenant_id = ? AND plan_id = ? AND user_id = ?
        AND action IN ('aangemaakt', 'bijgewerkt') AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1`).get(tenantId, planId, userId, since);
      if (last) {
        q('UPDATE history SET title = ?, customer = ?, address = ?, summary = ?, snapshot = ?, ip = ?, updated_at = ? WHERE id = ?')
          .run(meta.title, meta.customer, meta.address, summary, snapshot, ip, ts, last.id);
        return last.id;
      }
    }
    const id = newId();
    q(`INSERT INTO history (id, tenant_id, user_id, plan_id, action, title, customer, address, summary, snapshot, ip, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, userId, planId, action, meta.title, meta.customer, meta.address, summary, snapshot, ip, ts, ts);
    return id;
  }

  function historyRow(h, withSnapshot) {
    const out = {
      id: h.id, planId: h.plan_id, action: h.action, title: h.title, customer: h.customer, address: h.address,
      summary: JSON.parse(h.summary || '{}'), ip: h.ip, createdAt: h.created_at, updatedAt: h.updated_at,
      user: h.user_id ? { id: h.user_id, username: h.username, displayName: h.display_name, role: h.role, kind: h.kind } : null,
      planDeleted: h.plan_id ? !h.plan_exists : false,
      hasSnapshot: Boolean(h.has_snapshot),
    };
    if (withSnapshot) out.snapshot = h.snapshot ? JSON.parse(h.snapshot) : null;
    return out;
  }

  const HISTORY_SELECT = `
    SELECT h.id, h.plan_id, h.user_id, h.action, h.title, h.customer, h.address, h.summary, h.ip, h.created_at, h.updated_at,
      h.snapshot IS NOT NULL AS has_snapshot,
      u.username, u.display_name, u.role, u.kind,
      EXISTS (SELECT 1 FROM plans p WHERE p.id = h.plan_id AND p.deleted_at IS NULL) AS plan_exists`;

  function listHistory(tenantId, { limit = 100, offset = 0, userId = '', search = '', action = '', planId = '' } = {}) {
    const where = ['h.tenant_id = ?'];
    const args = [tenantId];
    if (planId) { where.push('h.plan_id = ?'); args.push(String(planId)); }
    if (userId) { where.push('h.user_id = ?'); args.push(String(userId)); }
    if (action) { where.push('h.action = ?'); args.push(String(action)); }
    if (search) {
      where.push("(h.title LIKE ? ESCAPE '\\' OR h.customer LIKE ? ESCAPE '\\' OR h.address LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')");
      const like = `%${String(search).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like, like, like, like);
    }
    const from = `FROM history h LEFT JOIN users u ON u.id = h.user_id WHERE ${where.join(' AND ')}`;
    const total = q(`SELECT COUNT(*) AS n ${from}`).get(...args).n;
    const lim = Math.max(1, Math.min(1000, Math.floor(Number(limit)) || 100));
    const off = Math.max(0, Math.floor(Number(offset)) || 0);
    const rows = q(`${HISTORY_SELECT} ${from} ORDER BY h.updated_at DESC, h.id LIMIT ? OFFSET ?`).all(...args, lim, off);
    return { total, items: rows.map((h) => historyRow(h, false)) };
  }

  function getHistory(tenantId, id) {
    const h = q(`${HISTORY_SELECT}, h.snapshot FROM history h LEFT JOIN users u ON u.id = h.user_id WHERE h.tenant_id = ? AND h.id = ?`).get(tenantId, String(id));
    return h ? historyRow(h, true) : null;
  }

  // ---------- Plannen ----------
  function planRow(p, withData) {
    const out = { id: p.id, title: p.title, customer: p.customer, address: p.address, createdAt: p.created_at, updatedAt: p.updated_at };
    if (p.owner_name !== undefined) out.owner = { id: p.owner_id, username: p.owner_username, displayName: p.owner_name, kind: p.owner_kind };
    if (p.lite !== undefined) {
      let data = null;
      try { data = JSON.parse(p.lite); } catch { /* beschadigd plan: lege samenvatting */ }
      out.summary = summarize(data);
      out.deletedAt = p.deleted_at || null;
    }
    if (p.history_count !== undefined) out.historyCount = p.history_count;
    if (withData) out.data = JSON.parse(p.data);
    return out;
  }

  // Met samenvatting (vlakken, m², sproeiers, zones) voor de overzichten; de
  // achtergrondafbeelding laat SQLite al weg (json_remove), die is groot.
  // withHistory: aantal historieregels per plan (alleen voor beheerders).
  function listPlans(tenantId, { ownerId = null, includeDeleted = false, withHistory = false } = {}) {
    const args = [tenantId];
    let sql = `SELECT p.id, p.title, p.customer, p.address, p.created_at, p.updated_at, p.deleted_at, p.owner_id,
        json_remove(p.data, '$.background') AS lite,
        ${withHistory ? '(SELECT COUNT(*) FROM history h WHERE h.tenant_id = p.tenant_id AND h.plan_id = p.id) AS history_count,' : ''}
        u.username AS owner_username, u.display_name AS owner_name, u.kind AS owner_kind
      FROM plans p JOIN users u ON u.id = p.owner_id WHERE p.tenant_id = ?${includeDeleted ? '' : ' AND p.deleted_at IS NULL'}`;
    if (ownerId) { sql += ' AND p.owner_id = ?'; args.push(ownerId); }
    return q(`${sql} ORDER BY p.updated_at DESC`).all(...args).map((p) => planRow(p, false));
  }

  // Een plan is alleen zichtbaar voor de eigenaar; beheerders en installateurs
  // (recht plannen.alle) zien en bewerken alles binnen de eigen tenant.
  function findPlan(user, id) {
    const p = q('SELECT * FROM plans WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(user.tenant_id, String(id));
    if (!p) return null;
    if (p.owner_id !== user.id && !Roles.can(user, 'plannen.alle')) return null;
    return p;
  }

  function getPlan(user, id) {
    const p = findPlan(user, id);
    return p ? planRow(p, true) : null;
  }

  function savePlan(user, id, data, ip) {
    return transaction(db, () => {
      const meta = metaOf(data);
      const ts = now();
      const json = JSON.stringify(data);
      if (!id) {
        const pid = newId();
        q(`INSERT INTO plans (id, tenant_id, owner_id, title, customer, address, data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(pid, user.tenant_id, user.id, meta.title, meta.customer, meta.address, json, ts, ts);
        record({ tenantId: user.tenant_id, userId: user.id, planId: pid, action: 'aangemaakt', data, ip });
        return planRow(q('SELECT * FROM plans WHERE id = ?').get(pid), false);
      }
      const p = findPlan(user, id);
      if (!p) return null;
      q('UPDATE plans SET title = ?, customer = ?, address = ?, data = ?, updated_at = ? WHERE id = ?')
        .run(meta.title, meta.customer, meta.address, json, ts, p.id);
      record({ tenantId: user.tenant_id, userId: user.id, planId: p.id, action: 'bijgewerkt', data, ip, merge: true });
      return planRow(q('SELECT * FROM plans WHERE id = ?').get(p.id), false);
    });
  }

  // Definitief wissen (AVG-verzoek): het plan zelf en de persoonsgegevens in
  // de historie (kopie, klant, adres, titel, IP). De regels blijven staan als
  // spoor dat er iets was, zonder inhoud. Ook al verwijderde plannen.
  function purgePlan(tenantId, id) {
    return transaction(db, () => {
      const p = q('SELECT id FROM plans WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
      const h = q(`UPDATE history SET snapshot = NULL, title = 'Gewist plan', customer = '', address = '', summary = '{}', ip = ''
        WHERE tenant_id = ? AND plan_id = ?`).run(tenantId, String(id)).changes;
      if (!p && !h) return null;
      if (p) q('DELETE FROM plans WHERE id = ?').run(p.id);
      return { plan: Boolean(p), history: h };
    });
  }

  function deletePlan(user, id, ip) {
    return transaction(db, () => {
      const p = findPlan(user, id);
      if (!p) return false;
      q('UPDATE plans SET deleted_at = ? WHERE id = ?').run(now(), p.id);
      record({ tenantId: user.tenant_id, userId: user.id, planId: p.id, action: 'verwijderd', data: JSON.parse(p.data), ip });
      return true;
    });
  }

  return {
    getTenant, getTenantBySlug, tenantRow, listTenants, createTenant, updateTenant, createEnvironment, resetEnvironment, deleteEnvironment, seedEnvironment,
    accessibleTenants, countPlatformAdmins, dropEmptyTenant, accountProblem, listCustomers,
    ensureTenant, systemUser, createGuest, createAccount, updateAccount, countAdmins, authenticate, loginTenant, getUser, touchUser, listUsers, publicUser,
    createSession, findSession, touchSession, deleteSession, dropSession, revokeSessions, audit, listAudit, applyRetention,
    record, listHistory, getHistory, listPlans, getPlan, savePlan, deletePlan, purgePlan,
  };
}

// Vingerafdruk van een wachtwoord-hash voor de sessies (geen geheim, wel
// uniek per wachtwoord): een nieuw wachtwoord maakt oude sessies ongeldig.
const fingerprintOf = (value) => crypto.createHash('sha256').update(`fp:${value || ''}`).digest('base64url').slice(0, 22);

module.exports = { createStore, hashPassword, verifyPassword, needsRehash, passwordProblem, fingerprintOf, summarize, ROLES };
