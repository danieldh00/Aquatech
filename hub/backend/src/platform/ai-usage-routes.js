// Routes voor Beheer > AI-kosten (/api/admin/ai-usage, zie ai-usage.js voor de opslag).

/**
 * Registreert de routes onder /api/admin/ai-usage.
 * @param {import('express').Express} app De app.
 * @param {object} ctx store, aiUsage, settingsFor en aiTenantOf.
 * @returns {void}
 */
function registerAiUsageRoutes(app, { store, aiUsage, settingsFor, aiTenantOf }) {
  // ---------- Beheer: AI-kosten (zie ai-usage.js) ----------
  // Een beheerder ziet de actieve omgeving; een hoofdbeheerder kan ook alle
  // organisaties samen (?scope=all) of één andere omgeving (?tenant=id) zien.
  /**
   * De omgevingen waarvan de AI-kosten worden gevraagd; stuurt bij een fout zelf het antwoord.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @returns {string[]|null|undefined} Ids, null = alle, undefined = antwoord al verstuurd.
   */
  function aiUsageScope(req, res) {
    const all = req.query.scope === 'all';
    const other = typeof req.query.tenant === 'string' && req.query.tenant && req.query.tenant !== req.tenantId;
    if (!all && !other) return [req.tenantId];
    if (!req.user?.platform_admin) {
      res.status(403).json({ error: 'forbidden', message: 'Alleen een hoofdbeheerder ziet de AI-kosten van andere organisaties.' });
      return undefined;
    }
    if (all) return null;
    if (!store.getTenant(req.query.tenant)) {
      res.status(404).json({ error: 'not_found', message: 'Organisatie niet gevonden.' });
      return undefined;
    }
    return [req.query.tenant];
  }

  app.get('/api/admin/ai-usage', (req, res) => {
    const scope = aiUsageScope(req, res);
    if (scope === undefined) return;
    const aiSettings = settingsFor(aiTenantOf(req.tenantId));
    res.json({ ...aiUsage.summary(scope, req.query), scope: scope ? 'tenant' : 'all', platformAdmin: Boolean(req.user?.platform_admin),
      model: aiSettings.get('aiModel'), eurCentsPerUsd: aiSettings.get('aiEurCentsPerUsd'), retentionDays: settingsFor(req.tenantId).get('auditRetentionDays') });
  });

  app.get('/api/admin/ai-usage/requests', (req, res) => {
    const scope = aiUsageScope(req, res);
    if (scope === undefined) return;
    res.json(aiUsage.list(scope, req.query, { limit: req.query.limit, offset: req.query.offset }));
  });
}

module.exports = { registerAiUsageRoutes };
