// Gegevenslaag bovenop db.js: gebruikers, plannen en de aanvraaghistorie.
// Elke functie krijgt de tenant mee; niets leest buiten de eigen tenant.
const crypto = require('crypto');
const { transaction } = require('./db');

const ROLES = ['beheerder', 'gebruiker'];
// Opeenvolgende wijzigingen van één gebruiker aan één plan binnen dit venster
// vormen één regel in de historie (anders levert automatisch opslaan honderden
// regels per plan op).
const HISTORY_MERGE_MS = 30 * 60 * 1000;

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

// ---------- Wachtwoorden (scrypt, ingebouwd in Node) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

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
      disabled: Boolean(u.disabled), createdAt: u.created_at, lastSeenAt: u.last_seen_at };
  }

  function getUser(id) {
    return q('SELECT * FROM users WHERE id = ?').get(String(id)) || null;
  }

  function insertUser(tenantId, { username, displayName, role, kind, passwordHash = null }) {
    const u = { id: newId(), tenant_id: tenantId, username, display_name: displayName, role, kind, password_hash: passwordHash, disabled: 0, created_at: now(), last_seen_at: null };
    q(`INSERT INTO users (id, tenant_id, username, display_name, role, kind, password_hash, disabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(u.id, tenantId, username, displayName, role, kind, passwordHash, u.created_at);
    return u;
  }

  // Vaste beheerders: het Home Assistant-paneel en inloggen met de toegangscode.
  function systemUser(tenantId, username, displayName) {
    return q('SELECT * FROM users WHERE tenant_id = ? AND username = ?').get(tenantId, username)
      || insertUser(tenantId, { username, displayName, role: 'beheerder', kind: 'systeem' });
  }

  function createGuest(tenantId) {
    const tag = crypto.randomBytes(4).toString('hex');
    return insertUser(tenantId, { username: `gast-${tag}`, displayName: `Gast ${tag}`, role: 'gebruiker', kind: 'gast' });
  }

  function validateAccount({ username, displayName, role, password }, { partial = false } = {}) {
    if (!partial || username !== undefined) {
      if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(String(username || ''))) return 'Gebruikersnaam: 3–40 tekens, kleine letters, cijfers, punt, streepje of underscore.';
      if (/^(gast-|ha-|beheerder$)/.test(username)) return 'Deze gebruikersnaam is gereserveerd.';
    }
    if (displayName !== undefined && String(displayName).trim().length > 80) return 'Naam is te lang.';
    if ((!partial || role !== undefined) && !ROLES.includes(role)) return 'Ongeldige rol.';
    if ((!partial || password !== undefined) && String(password || '').length < 8) return 'Wachtwoord: minimaal 8 tekens.';
    return null;
  }

  function createAccount(tenantId, input) {
    const err = validateAccount(input);
    if (err) return { error: err };
    if (q('SELECT 1 FROM users WHERE tenant_id = ? AND username = ?').get(tenantId, input.username)) {
      return { error: 'Deze gebruikersnaam bestaat al.' };
    }
    const u = insertUser(tenantId, {
      username: input.username,
      displayName: String(input.displayName || '').trim() || input.username,
      role: input.role,
      kind: 'account',
      passwordHash: hashPassword(input.password),
    });
    return { user: u };
  }

  function updateAccount(tenantId, id, input) {
    const u = q('SELECT * FROM users WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
    if (!u) return { error: 'Gebruiker niet gevonden.', status: 404 };
    if (u.kind !== 'account') return { error: 'Systeem- en gastgebruikers zijn niet aan te passen.', status: 409 };
    const err = validateAccount(input, { partial: true });
    if (err) return { error: err };
    if (input.username !== undefined) return { error: 'De gebruikersnaam is niet te wijzigen.' };
    if (input.displayName !== undefined) q('UPDATE users SET display_name = ? WHERE id = ?').run(String(input.displayName).trim() || u.username, u.id);
    if (input.role !== undefined) q('UPDATE users SET role = ? WHERE id = ?').run(input.role, u.id);
    if (input.disabled !== undefined) q('UPDATE users SET disabled = ? WHERE id = ?').run(input.disabled ? 1 : 0, u.id);
    if (input.password !== undefined) q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(input.password), u.id);
    return { user: getUser(u.id) };
  }

  function authenticate(tenantId, username, password) {
    const u = q("SELECT * FROM users WHERE tenant_id = ? AND username = ? AND kind = 'account'").get(tenantId, String(username || '').trim().toLowerCase());
    // Ook zonder gebruiker een hash uitrekenen: gelijke looptijd.
    const ok = verifyPassword(password, u?.password_hash || DUMMY_HASH);
    return ok && u && !u.disabled ? u : null;
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
        (SELECT COUNT(*) FROM history h WHERE h.user_id = u.id) AS history_count
      FROM users u WHERE u.tenant_id = ? ${includeGuests ? '' : "AND u.kind <> 'gast'"}
      ORDER BY CASE u.kind WHEN 'systeem' THEN 0 WHEN 'account' THEN 1 ELSE 2 END, u.display_name COLLATE NOCASE`)
      .all(tenantId)
      .map((u) => ({ ...publicUser(u), planCount: u.plan_count, historyCount: u.history_count }));
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

  function listHistory(tenantId, { limit = 100, offset = 0, userId = '', search = '', action = '' } = {}) {
    const where = ['h.tenant_id = ?'];
    const args = [tenantId];
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
    if (withData) out.data = JSON.parse(p.data);
    return out;
  }

  function listPlans(tenantId, { ownerId = null } = {}) {
    const args = [tenantId];
    let sql = `SELECT p.id, p.title, p.customer, p.address, p.created_at, p.updated_at, p.owner_id,
        u.username AS owner_username, u.display_name AS owner_name, u.kind AS owner_kind
      FROM plans p JOIN users u ON u.id = p.owner_id WHERE p.tenant_id = ? AND p.deleted_at IS NULL`;
    if (ownerId) { sql += ' AND p.owner_id = ?'; args.push(ownerId); }
    return q(`${sql} ORDER BY p.updated_at DESC`).all(...args).map((p) => planRow(p, false));
  }

  // Een plan is alleen zichtbaar voor de eigenaar; een beheerder ziet alles
  // binnen de eigen tenant.
  function findPlan(user, id) {
    const p = q('SELECT * FROM plans WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(user.tenant_id, String(id));
    if (!p) return null;
    if (p.owner_id !== user.id && user.role !== 'beheerder') return null;
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
    ensureTenant, systemUser, createGuest, createAccount, updateAccount, authenticate, getUser, touchUser, listUsers, publicUser,
    record, listHistory, getHistory, listPlans, getPlan, savePlan, deletePlan,
  };
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

module.exports = { createStore, hashPassword, verifyPassword, summarize, ROLES };
