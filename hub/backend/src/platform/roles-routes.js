// Routes voor Beheer > Rollen (/api/admin/roles; de map /api/admin eist al het recht beheer). De opslag staat in roles.js.
// Rollen gelden voor de hele organisatie (live en testomgevingen). Een testaccount (dat in een testomgeving woont) kan
// ze zien maar niet wijzigen. Tenant-isolatie: de omgeving komt altijd uit req.tenantId.

/**
 * Registreert de routes onder /api/admin/roles.
 * @param {import('express').Express} app De app.
 * @param {object} ctx store, audit (req, actie, detail, gebruiker, tenant) en requireJson (middleware).
 * @returns {void}
 */
function registerRoleRoutes(app, { store, audit, requireJson }) {
  /**
   * Mag deze gebruiker de rollen wijzigen? Stuurt anders zelf 403.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {boolean} true als het mag.
   */
  function rolesEditable(req, res) {
    const home = store.getTenant(req.user.home_tenant_id || req.user.tenant_id);
    if (req.user.platform_admin || !home || home.environment !== 'test') return true;
    res.status(403).json({ error: 'forbidden', message: 'Rollen gelden voor de hele organisatie; wijzig ze met een account van live.' });
    return false;
  }
  /**
   * De rollen met het aantal gebruikers per rol.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object[]} De rollen.
   */
  const rolesView = (tenantId) => {
    const counts = store.roles.userCounts(tenantId);
    return store.roles.list(tenantId).map((role) => ({ ...role, userCount: counts[role.key] || 0 }));
  };
  /**
   * Stuurt een fout uit de rollenopslag terug.
   * @param {object} res Het antwoord.
   * @param {{ status?: number, code?: string, error: string, field?: string }} out De fout.
   * @returns {void}
   */
  const roleError = (res, out) => res.status(out.status || 400).json({ error: out.code || (out.status === 404 ? 'not_found' : 'invalid_role'), message: out.error, field: out.field || null });

  app.get('/api/admin/roles', (req, res) => {
    const home = store.getTenant(req.user.home_tenant_id || req.user.tenant_id);
    res.json({ items: rolesView(req.tenantId), editable: Boolean(req.user.platform_admin || !home || home.environment !== 'test') });
  });

  app.post('/api/admin/roles', requireJson, (req, res) => {
    if (!rolesEditable(req, res)) return;
    const { label, description, kind, rights, copyOf } = req.body || {};
    // Een nieuwe rol kan de rechten van een bestaande rol overnemen.
    const from = copyOf ? store.roles.get(req.tenantId, copyOf) : null;
    const out = store.roles.create(req.tenantId, { label, description, kind: kind ?? from?.kind, rights: rights ?? from?.rights ?? [] });
    if (out.error) return roleError(res, out);
    audit(req, 'rol_aangemaakt', { rol: out.role.key, naam: out.role.label, rechten: out.role.rights }, undefined, store.roles.rootOf(req.tenantId));
    res.status(201).json(out.role);
  });

  app.patch('/api/admin/roles/:key', requireJson, (req, res) => {
    if (!rolesEditable(req, res)) return;
    const input = {};
    for (const field of ['label', 'description', 'rights', 'kind']) if (req.body?.[field] !== undefined) input[field] = req.body[field];
    const out = store.roles.update(req.tenantId, req.params.key, input);
    if (out.error) return roleError(res, out);
    const added = out.role.rights.filter((right) => !out.before.rights.includes(right));
    const removed = out.before.rights.filter((right) => !out.role.rights.includes(right));
    audit(req, 'rol_gewijzigd', { rol: out.role.key, fields: Object.keys(input), ...(added.length ? { aan: added } : {}), ...(removed.length ? { uit: removed } : {}) },
      undefined, store.roles.rootOf(req.tenantId));
    res.json(out.role);
  });

  // Eigen rol verwijderen (zonder gebruikers) of een standaardrol terugzetten.
  app.delete('/api/admin/roles/:key', (req, res) => {
    if (!rolesEditable(req, res)) return;
    const out = store.roles.remove(req.tenantId, req.params.key);
    if (out.error) return roleError(res, out);
    audit(req, out.reset ? 'rol_teruggezet' : 'rol_verwijderd', { rol: out.role.key, naam: out.role.label }, undefined, store.roles.rootOf(req.tenantId));
    res.json({ ok: true, reset: out.reset, role: out.reset ? store.roles.get(req.tenantId, out.role.key) : null });
  });
}

module.exports = { registerRoleRoutes };
