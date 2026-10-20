// Rollen per organisatie (Beheer > Rollen). De standaardrollen staan in
// frontend/shared/roles.js; tabel `roles` bewaart alleen wat een beheerder
// daaraan veranderd heeft en de eigen rollen. Rollen horen bij de live-tenant;
// een testomgeving gebruikt die van live (de gebruikers zijn ook dezelfde).
//
// Regels:
// - beheerder heeft vaste rechten (anders kan niemand meer beheren); naam en
//   omschrijving zijn wel aan te passen. 'beheer' en 'hoofdbeheer' zijn voor
//   geen andere rol aan te zetten.
// - Een rol is een medewerker- of klantrol; een klantrol kan alleen
//   klantrechten krijgen (Roles.rightsForKind).
// - Standaardrollen zijn niet te verwijderen (wel terug te zetten), een eigen
//   rol alleen als er geen gebruikers meer mee werken.
const path = require('path');

const Roles = require(path.join(__dirname, '..', '..', 'frontend', 'shared', 'roles.js'));

const KEY = /^[a-z][a-z0-9-]{1,29}$/;
const CACHE_MS = 30 * 1000;
const now = () => new Date().toISOString();

/** Sleutel uit een naam: "Werkvoorbereider Noord" → "werkvoorbereider-noord". */
function keyFrom(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 30).replace(/-+$/, '');
}

function createRoleStore(db) {
  const q = (sql) => db.prepare(sql);
  // De live-tenant van een tenant verandert niet; rollen kort in het geheugen
  // (elk verzoek vraagt de rechten op), na een wijziging direct opnieuw.
  const roots = new Map();
  const cache = new Map();

  function rootOf(tenantId) {
    const id = String(tenantId || '');
    if (roots.has(id)) return roots.get(id);
    const t = q('SELECT id, environment, parent_id FROM tenants WHERE id = ?').get(id);
    const root = t ? (t.environment === 'test' && t.parent_id ? t.parent_id : t.id) : id;
    if (t) roots.set(id, root);
    return root;
  }
  const familyOf = (root) => [root, ...q('SELECT id FROM tenants WHERE parent_id = ?').all(root).map((r) => r.id)];

  function rowsOf(root) {
    const hit = cache.get(root);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
    const rows = new Map(q('SELECT role_key, label, description, kind, rights FROM roles WHERE tenant_id = ?').all(root).map((r) => [r.role_key, r]));
    cache.set(root, { at: Date.now(), rows });
    return rows;
  }
  const forget = (root) => cache.delete(root);

  const parseRights = (text) => { try { const a = JSON.parse(text); return Array.isArray(a) ? a : []; } catch { return []; } };

  function shape(key, row) {
    const base = Roles.ROLES[key] || null;
    if (!base && !row) return null;
    const kind = base ? base.kind : row.kind;
    let rights = row ? parseRights(row.rights) : base.rights.slice();
    // Alleen bekende rechten die bij de soort passen (en beheer vast bij beheerder).
    const allowed = Roles.rightsForKind(kind);
    rights = base && base.locked ? base.rights.slice() : Roles.RIGHTS.filter((r) => allowed.includes(r) && rights.includes(r));
    return {
      key,
      label: (row && row.label) || (base ? base.label : key),
      description: row ? row.description : base.description,
      kind,
      rights,
      builtin: Boolean(base),
      locked: Boolean(base && base.locked),
      customized: Boolean(base && row),
    };
  }

  /** Alle rollen van de organisatie: standaardrollen eerst, dan de eigen op naam. */
  function list(tenantId) {
    const rows = rowsOf(rootOf(tenantId));
    const own = [...rows.values()].filter((r) => !Roles.ROLES[r.role_key]).sort((a, b) => a.label.localeCompare(b.label, 'nl'));
    return [...Object.keys(Roles.ROLES).map((k) => shape(k, rows.get(k))), ...own.map((r) => shape(r.role_key, r))];
  }

  function get(tenantId, key) {
    const k = Roles.normalize(String(key || ''));
    return shape(k, rowsOf(rootOf(tenantId)).get(k));
  }

  const exists = (tenantId, key) => Boolean(get(tenantId, key));
  const rightsFor = (tenantId, key) => { const r = get(tenantId, key); return r ? r.rights : []; };
  const label = (tenantId, key) => { const r = get(tenantId, key); return r ? r.label : String(key || ''); };
  /** Sleutels van de rollen met dit recht, of van deze soort. */
  const keysWith = (tenantId, right) => list(tenantId).filter((r) => r.rights.includes(right)).map((r) => r.key);
  const keysOfKind = (tenantId, kind) => list(tenantId).filter((r) => r.kind === kind).map((r) => r.key);

  /** Aantal accounts per rol in de organisatie (live + testomgevingen). */
  function userCounts(tenantId) {
    const ids = familyOf(rootOf(tenantId));
    const out = {};
    for (const r of q(`SELECT role, COUNT(*) AS n FROM users WHERE kind = 'account' AND tenant_id IN (${ids.map(() => '?').join(', ')}) GROUP BY role`).all(...ids)) {
      out[r.role] = Number(r.n);
    }
    return out;
  }

  function validate(input, kind, { partial }) {
    const out = {};
    if (!partial || input.label !== undefined) {
      const name = String(input.label ?? '').replace(/\s+/g, ' ').trim();
      if (!name) return { error: 'Geef de rol een naam.', field: 'label' };
      if (name.length > 40) return { error: 'De naam mag maximaal 40 tekens hebben.', field: 'label' };
      out.label = name;
    }
    if (input.description !== undefined) {
      const text = String(input.description ?? '').replace(/\s+/g, ' ').trim();
      if (text.length > 300) return { error: 'De omschrijving mag maximaal 300 tekens hebben.', field: 'description' };
      out.description = text;
    }
    if (input.rights !== undefined) {
      if (!Array.isArray(input.rights)) return { error: 'Ongeldige rechten.', field: 'rights' };
      const allowed = Roles.rightsForKind(kind);
      const bad = input.rights.find((r) => !allowed.includes(r));
      if (bad !== undefined) {
        return { error: Roles.RIGHT_INFO[bad] ? `Het recht "${Roles.RIGHT_INFO[bad].label}" past niet bij deze rol.` : 'Onbekend recht.', field: 'rights' };
      }
      out.rights = Roles.withNeeds(input.rights);
    }
    return { value: out };
  }

  function write(root, key, role) {
    const ts = now();
    const params = [role.label, role.description, role.kind, JSON.stringify(role.rights), ts, root, key];
    const done = q('UPDATE roles SET label = ?, description = ?, kind = ?, rights = ?, updated_at = ? WHERE tenant_id = ? AND role_key = ?').run(...params).changes;
    if (!done) {
      q('INSERT INTO roles (label, description, kind, rights, updated_at, tenant_id, role_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...params, ts);
    }
    forget(root);
  }

  /** Nieuwe eigen rol; geeft { role } of { error, field }. */
  function create(tenantId, input = {}) {
    const root = rootOf(tenantId);
    const kind = input.kind === 'klant' ? 'klant' : 'medewerker';
    if (input.kind !== undefined && !Roles.KINDS[input.kind]) return { error: 'Kies medewerker of klant.', field: 'kind' };
    const v = validate({ rights: [], ...input }, kind, { partial: false });
    if (v.error) return v;
    const key = input.key !== undefined ? String(input.key).trim().toLowerCase() : keyFrom(v.value.label);
    if (!KEY.test(key)) return { error: 'Kies een naam die met een letter begint (code: 2–30 tekens, kleine letters, cijfers of streepjes).', field: 'label' };
    if (Roles.ROLES[key] || Roles.ALIASES[key] || rowsOf(root).has(key)) return { error: 'Er is al een rol met deze naam.', field: 'label' };
    if (list(tenantId).some((r) => r.label.toLowerCase() === v.value.label.toLowerCase())) return { error: 'Er is al een rol met deze naam.', field: 'label' };
    write(root, key, { description: '', ...v.value, kind });
    return { role: get(tenantId, key) };
  }

  /** Naam, omschrijving en/of rechten van een rol wijzigen. */
  function update(tenantId, key, input = {}) {
    const root = rootOf(tenantId);
    const cur = get(tenantId, key);
    if (!cur) return { error: 'Rol niet gevonden.', status: 404 };
    if (input.kind !== undefined && input.kind !== cur.kind) return { error: 'De soort van een rol is niet te wijzigen.', field: 'kind' };
    if (cur.locked && input.rights !== undefined && [...input.rights].sort().join() !== [...cur.rights].sort().join()) {
      return { error: 'De rechten van de beheerder liggen vast.', field: 'rights', status: 409 };
    }
    const v = validate(cur.locked ? { ...input, rights: undefined } : input, cur.kind, { partial: true });
    if (v.error) return v;
    const next = { label: cur.label, description: cur.description, kind: cur.kind, rights: cur.rights, ...v.value };
    if (next.label.toLowerCase() !== cur.label.toLowerCase() && list(tenantId).some((r) => r.key !== cur.key && r.label.toLowerCase() === next.label.toLowerCase())) {
      return { error: 'Er is al een rol met deze naam.', field: 'label' };
    }
    write(root, cur.key, next);
    return { role: get(tenantId, cur.key), before: cur };
  }

  /** Standaardrol terug naar de standaard, of eigen rol verwijderen (alleen zonder gebruikers). */
  function remove(tenantId, key) {
    const root = rootOf(tenantId);
    const cur = get(tenantId, key);
    if (!cur) return { error: 'Rol niet gevonden.', status: 404 };
    if (!cur.builtin) {
      const n = userCounts(tenantId)[cur.key] || 0;
      if (n) return { error: `Deze rol heeft nog ${n} gebruiker${n === 1 ? '' : 's'}. Geef ${n === 1 ? 'die' : 'hen'} eerst een andere rol.`, status: 409, code: 'in_use' };
    }
    q('DELETE FROM roles WHERE tenant_id = ? AND role_key = ?').run(root, cur.key);
    forget(root);
    return { role: cur, reset: cur.builtin };
  }

  return { list, get, exists, rightsFor, label, keysWith, keysOfKind, userCounts, create, update, remove, rootOf };
}

module.exports = { createRoleStore, keyFrom };
