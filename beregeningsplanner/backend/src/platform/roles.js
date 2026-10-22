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
const { FRONTEND_DIR } = require('../paths');

const Roles = require(path.join(FRONTEND_DIR, 'shared', 'roles.js'));

const KEY = /^[a-z][a-z0-9-]{1,29}$/;
const CACHE_MS = 30 * 1000;
/**
 * Huidig tijdstip als ISO-tekst.
 * @returns {string} Tijdstip in ISO 8601.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * Sleutel uit een naam: "Werkvoorbereider Noord" → "werkvoorbereider-noord" (zonder accenten, begint met een letter, hoogstens 30 tekens).
 * @param {string} text De naam.
 * @returns {string} De sleutel.
 */
function keyFrom(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 30).replace(/-+$/, '');
}

/**
 * Maakt de opslag voor rollen per organisatie (tabel roles, bij de live-tenant), met een korte cache.
 * @param {object} db Databaseverbinding.
 * @returns {object} list, get, exists, rightsFor, label, keysWith, keysOfKind, userCounts, create, update, remove en rootOf.
 */
function createRoleStore(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL met ?-parameters.
   * @returns {object} Het voorbereide statement.
   */
  const prepare = (sql) => db.prepare(sql);
  // De live-tenant van een tenant verandert niet; rollen kort in het geheugen
  // (elk verzoek vraagt de rechten op), na een wijziging direct opnieuw.
  const roots = new Map();
  const cache = new Map();

  /**
   * De live-tenant van een tenant (een testomgeving gebruikt de rollen van live); wordt onthouden.
   * @param {string} tenantId De tenant.
   * @returns {string} Id van de live-tenant.
   */
  function rootOf(tenantId) {
    const id = String(tenantId || '');
    if (roots.has(id)) return roots.get(id);
    const tenant = prepare('SELECT id, environment, parent_id FROM tenants WHERE id = ?').get(id);
    const root = tenant ? (tenant.environment === 'test' && tenant.parent_id ? tenant.parent_id : tenant.id) : id;
    if (tenant) roots.set(id, root);
    return root;
  }
  /**
   * De live-tenant met al zijn testomgevingen.
   * @param {string} root Id van de live-tenant.
   * @returns {string[]} Id's van de omgevingen.
   */
  const familyOf = (root) => [root, ...prepare('SELECT id FROM tenants WHERE parent_id = ?').all(root).map((row) => row.id)];

  /**
   * De opgeslagen rollen van een organisatie (30 s in het geheugen).
   * @param {string} root Id van de live-tenant.
   * @returns {Map<string, object>} Per rolsleutel de rij uit roles.
   */
  function rowsOf(root) {
    const hit = cache.get(root);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
    const rows = new Map(prepare('SELECT role_key, label, description, kind, rights FROM roles WHERE tenant_id = ?').all(root).map((row) => [row.role_key, row]));
    cache.set(root, { at: Date.now(), rows });
    return rows;
  }
  /**
   * Vergeet de cache van een organisatie (na een wijziging).
   * @param {string} root Id van de live-tenant.
   * @returns {boolean} Of er iets in de cache stond.
   */
  const forget = (root) => cache.delete(root);

  /**
   * Leest de rechten uit de JSON-kolom.
   * @param {string} text JSON-tekst.
   * @returns {string[]} De rechten (leeg bij ongeldige JSON).
   */
  const parseRights = (text) => { try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : []; } catch { return []; } };

  /**
   * Een rol zoals de app hem gebruikt: de standaardrol met de opgeslagen
   * afwijkingen, of een eigen rol. Alleen bekende rechten die bij de soort
   * passen; de beheerder houdt zijn vaste rechten.
   * @param {string} key Sleutel van de rol.
   * @param {object|undefined} row Opgeslagen rij (afwijking of eigen rol).
   * @returns {object|null} De rol, of null als hij niet bestaat.
   */
  function toRole(key, row) {
    const base = Roles.ROLES[key] || null;
    if (!base && !row) return null;
    const kind = base ? base.kind : row.kind;
    let rights = row ? parseRights(row.rights) : base.rights.slice();
    // Alleen bekende rechten die bij de soort passen (en beheer vast bij beheerder).
    const allowed = Roles.rightsForKind(kind);
    rights = base && base.locked ? base.rights.slice() : Roles.RIGHTS.filter((right) => allowed.includes(right) && rights.includes(right));
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

  /**
   * Alle rollen van de organisatie: standaardrollen eerst, dan de eigen op naam.
   * @param {string} tenantId Een omgeving van de organisatie.
   * @returns {object[]} De rollen.
   */
  function list(tenantId) {
    const rows = rowsOf(rootOf(tenantId));
    const own = [...rows.values()].filter((row) => !Roles.ROLES[row.role_key]).sort((left, right) => left.label.localeCompare(right.label, 'nl'));
    return [...Object.keys(Roles.ROLES).map((roleKey) => toRole(roleKey, rows.get(roleKey))), ...own.map((row) => toRole(row.role_key, row))];
  }

  /**
   * Haalt één rol op (oude rolnamen worden omgezet).
   * @param {string} tenantId Een omgeving van de organisatie.
   * @param {string} key Sleutel van de rol.
   * @returns {object|null} De rol, of null.
   */
  function get(tenantId, key) {
    const roleKey = Roles.normalize(String(key || ''));
    return toRole(roleKey, rowsOf(rootOf(tenantId)).get(roleKey));
  }

  /**
   * Of een rol bestaat.
   * @param {string} tenantId Een omgeving van de organisatie.
   * @param {string} key Sleutel van de rol.
   * @returns {boolean} true als de rol bestaat.
   */
  const exists = (tenantId, key) => Boolean(get(tenantId, key));
  /**
   * De rechten van een rol.
   * @param {string} tenantId Een omgeving van de organisatie.
   * @param {string} key Sleutel van de rol.
   * @returns {string[]} De rechten (leeg bij een onbekende rol).
   */
  const rightsFor = (tenantId, key) => { const role = get(tenantId, key); return role ? role.rights : []; };
  /**
   * De naam van een rol.
   * @param {string} tenantId Een omgeving van de organisatie.
   * @param {string} key Sleutel van de rol.
   * @returns {string} De naam, of de sleutel bij een onbekende rol.
   */
  const label = (tenantId, key) => { const role = get(tenantId, key); return role ? role.label : String(key || ''); };
  /**
   * Sleutels van de rollen met dit recht.
   * @param {string} tenantId Een omgeving van de organisatie.
   * @param {string} right Het recht.
   * @returns {string[]} De rolsleutels.
   */
  const keysWith = (tenantId, right) => list(tenantId).filter((role) => role.rights.includes(right)).map((role) => role.key);
  /**
   * Sleutels van de rollen van deze soort.
   * @param {string} tenantId Een omgeving van de organisatie.
   * @param {string} kind 'medewerker' of 'klant'.
   * @returns {string[]} De rolsleutels.
   */
  const keysOfKind = (tenantId, kind) => list(tenantId).filter((role) => role.kind === kind).map((role) => role.key);

  /**
   * Aantal accounts per rol in de organisatie (live + testomgevingen).
   * @param {string} tenantId Een omgeving van de organisatie.
   * @returns {Object<string, number>} Per rolsleutel het aantal accounts.
   */
  function userCounts(tenantId) {
    const ids = familyOf(rootOf(tenantId));
    const out = {};
    for (const row of prepare(`SELECT role, COUNT(*) AS n FROM users WHERE kind = 'account' AND tenant_id IN (${ids.map(() => '?').join(', ')}) GROUP BY role`).all(...ids)) {
      out[row.role] = Number(row.n);
    }
    return out;
  }

  /**
   * Controleert naam, omschrijving en rechten van een rol.
   * @param {object} input De invoer.
   * @param {string} kind Soort van de rol (bepaalt welke rechten mogen).
   * @param {{ partial: boolean }} options partial = alleen de meegegeven velden controleren.
   * @returns {{ value: object }|{ error: string, field: string }} De opgeschoonde velden of een foutmelding.
   */
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
      const bad = input.rights.find((right) => !allowed.includes(right));
      if (bad !== undefined) {
        return { error: Roles.RIGHT_INFO[bad] ? `Het recht "${Roles.RIGHT_INFO[bad].label}" past niet bij deze rol.` : 'Onbekend recht.', field: 'rights' };
      }
      out.rights = Roles.withNeeds(input.rights);
    }
    return { value: out };
  }

  /**
   * Slaat een rol (of een afwijking van een standaardrol) op en vergeet de cache.
   * @param {string} root Id van de live-tenant.
   * @param {string} key Sleutel van de rol.
   * @param {{ label: string, description: string, kind: string, rights: string[] }} role De rol.
   * @returns {void}
   */
  function write(root, key, role) {
    const timestamp = currentTimestamp();
    const params = [role.label, role.description, role.kind, JSON.stringify(role.rights), timestamp, root, key];
    const done = prepare('UPDATE roles SET label = ?, description = ?, kind = ?, rights = ?, updated_at = ? WHERE tenant_id = ? AND role_key = ?').run(...params).changes;
    if (!done) {
      prepare('INSERT INTO roles (label, description, kind, rights, updated_at, tenant_id, role_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...params, timestamp);
    }
    forget(root);
  }

  /**
   * Maakt een nieuwe eigen rol.
   * @param {string} tenantId Een omgeving van de organisatie.
   * @param {object} [input] label, description, kind, rights en eventueel key.
   * @returns {{ role: object }|{ error: string, field: string }} De rol of een foutmelding.
   */
  function create(tenantId, input = {}) {
    const root = rootOf(tenantId);
    const kind = input.kind === 'klant' ? 'klant' : 'medewerker';
    if (input.kind !== undefined && !Roles.KINDS[input.kind]) return { error: 'Kies medewerker of klant.', field: 'kind' };
    const checked = validate({ rights: [], ...input }, kind, { partial: false });
    if (checked.error) return checked;
    const key = input.key !== undefined ? String(input.key).trim().toLowerCase() : keyFrom(checked.value.label);
    if (!KEY.test(key)) return { error: 'Kies een naam die met een letter begint (code: 2–30 tekens, kleine letters, cijfers of streepjes).', field: 'label' };
    if (Roles.ROLES[key] || Roles.ALIASES[key] || rowsOf(root).has(key)) return { error: 'Er is al een rol met deze naam.', field: 'label' };
    if (list(tenantId).some((role) => role.label.toLowerCase() === checked.value.label.toLowerCase())) return { error: 'Er is al een rol met deze naam.', field: 'label' };
    write(root, key, { description: '', ...checked.value, kind });
    return { role: get(tenantId, key) };
  }

  /**
   * Wijzigt naam, omschrijving en/of rechten van een rol.
   * @param {string} tenantId Een omgeving van de organisatie.
   * @param {string} key Sleutel van de rol.
   * @param {object} [input] De gewijzigde velden.
   * @returns {{ role: object, before: object }|{ error: string, field?: string, status?: number }} De rol (en hoe hij was) of een foutmelding.
   */
  function update(tenantId, key, input = {}) {
    const root = rootOf(tenantId);
    const current = get(tenantId, key);
    if (!current) return { error: 'Rol niet gevonden.', status: 404 };
    if (input.kind !== undefined && input.kind !== current.kind) return { error: 'De soort van een rol is niet te wijzigen.', field: 'kind' };
    if (current.locked && input.rights !== undefined && [...input.rights].sort().join() !== [...current.rights].sort().join()) {
      return { error: 'De rechten van de beheerder liggen vast.', field: 'rights', status: 409 };
    }
    const checked = validate(current.locked ? { ...input, rights: undefined } : input, current.kind, { partial: true });
    if (checked.error) return checked;
    const next = { label: current.label, description: current.description, kind: current.kind, rights: current.rights, ...checked.value };
    if (next.label.toLowerCase() !== current.label.toLowerCase() && list(tenantId).some((role) => role.key !== current.key && role.label.toLowerCase() === next.label.toLowerCase())) {
      return { error: 'Er is al een rol met deze naam.', field: 'label' };
    }
    write(root, current.key, next);
    return { role: get(tenantId, current.key), before: current };
  }

  /**
   * Zet een standaardrol terug naar de standaard, of verwijdert een eigen rol (alleen zonder gebruikers).
   * @param {string} tenantId Een omgeving van de organisatie.
   * @param {string} key Sleutel van de rol.
   * @returns {{ role: object, reset: boolean }|{ error: string, status: number, code?: string }} De rol en of het een terugzetting was, of een foutmelding.
   */
  function remove(tenantId, key) {
    const root = rootOf(tenantId);
    const current = get(tenantId, key);
    if (!current) return { error: 'Rol niet gevonden.', status: 404 };
    if (!current.builtin) {
      const userCount = userCounts(tenantId)[current.key] || 0;
      if (userCount) return { error: `Deze rol heeft nog ${userCount} gebruiker${userCount === 1 ? '' : 's'}. Geef ${userCount === 1 ? 'die' : 'hen'} eerst een andere rol.`, status: 409, code: 'in_use' };
    }
    prepare('DELETE FROM roles WHERE tenant_id = ? AND role_key = ?').run(root, current.key);
    forget(root);
    return { role: current, reset: current.builtin };
  }

  return { list, get, exists, rightsFor, label, keysWith, keysOfKind, userCounts, create, update, remove, rootOf };
}

module.exports = { createRoleStore, keyFrom };
