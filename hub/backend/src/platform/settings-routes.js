// Routes voor Beheer > Instellingen van de actieve omgeving (/api/admin/settings en /api/admin/settings/test-ai).
// De opslag en validatie staan in settings.js; hier staan de modulevergrendeling, de webshopgrenzen en het auditlog.
const { SettingsError, FIELDS } = require('./settings');
const { AnalyzeError } = require('../beregening/plan-analyzer');

/**
 * Registreert de instellingenroutes onder /api/admin/settings.
 * @param {import('express').Express} app De app.
 * @param {object} ctx tenant (hoofdtenant), auth, audit, requireJson, settingsFor, aiTenantOf, currentAnalyzer, moduleFlagsOf en ModuleTools.
 * @returns {void}
 */
function registerSettingsRoutes(app, { tenant, auth, audit, requireJson, settingsFor, aiTenantOf, currentAnalyzer, moduleFlagsOf, ModuleTools }) {
  // ---------- Beheer: instellingen (van de actieve omgeving) ----------
  app.get('/api/admin/settings', (req, res) => {
    // aiFromLive: testomgeving zonder eigen sleutel gebruikt die van live.
    const aiFrom = aiTenantOf(req.tenantId);
    const settings = settingsFor(req.tenantId).view();
    if (req.tenantId !== tenant.id) { delete settings.storefront; delete settings.shopPlanner; delete settings.shopOrdering; delete settings.shopShipping; delete settings.shopPayment; delete settings.shopAnalytics; delete settings.shopSeo; delete settings.mollieApiKey; }
    res.json({ settings, via: auth.session(req)?.via || null,
      // De eigen webshop (winkel/) toont alleen de hoofdtenant: de schakelaar hoort alleen daar.
      storefrontAllowed: req.tenantId === tenant.id,
      aiFromLive: aiFrom !== req.tenantId && Boolean(settingsFor(aiFrom).get('anthropicApiKey')) });
  });

  app.put('/api/admin/settings', requireJson, (req, res) => {
    const settings = settingsFor(req.tenantId);
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    // De toegangscode geldt alleen voor de hoofdtenant.
    const via = req.tenantId === tenant.id ? auth.session(req)?.via : null;
    const oldCode = settings.get('accessCode');
    // Wie met de toegangscode is ingelogd, zou zichzelf buitensluiten door die
    // leeg te maken; met een beheerdersaccount kan het wel.
    const resets = Array.isArray(patch.reset) ? patch.reset : [];
    // Instellingen van een module die uit staat zijn verborgen en worden niet gewijzigd (een patch die de module tegelijk aanzet telt mee).
    const patchedFlags = patch.modules && typeof patch.modules === 'object' && !Array.isArray(patch.modules)
      ? Object.fromEntries(Object.entries(patch.modules).map(([id, on]) => [id, Boolean(on)])) : {};
    const lockedKeys = ModuleTools.lockedSettings({ ...moduleFlagsOf(req.tenantId), ...patchedFlags });
    const lockedField = [...Object.keys(patch), ...resets].find((key) => lockedKeys.has(key));
    if (lockedField) return res.status(409).json({ error: 'module_off', field: lockedField, message: 'Deze instelling hoort bij een module die uit staat. Zet de module eerst aan in Beheer > Modules aan/uit.' });
    const platformField = [...Object.keys(patch), ...resets].find((key) => FIELDS[key]?.platform || FIELDS[key]?.internal);
    if (platformField) {
      return res.status(400).json({ error: 'invalid_setting', field: platformField,
        message: FIELDS[platformField].internal ? 'Deze instelling wijzig je in de module zelf.' : (platformField === 'theme' ? 'Kleuren wijzig je in Beheer > Kleuren.' : 'Deze instelling wijzig je in Hoofdbeheer.') });
    }
    if (req.tenantId !== tenant.id && ['storefront', 'shopPlanner', 'shopOrdering', 'shopShipping', 'shopPayment', 'shopAnalytics', 'shopSeo', 'mollieApiKey'].some((key) => [...Object.keys(patch), ...resets].includes(key))) {
      return res.status(400).json({ error: 'invalid_setting', field: 'storefront', message: 'De eigen webshop geldt alleen voor de hoofdtenant.' });
    }
    const codeAfter = patch.accessCode !== undefined ? String(patch.accessCode).trim()
      : resets.includes('accessCode') ? settings.get('accessCode', true) : oldCode;
    if (via === 'code' && !codeAfter) {
      return res.status(400).json({ error: 'invalid_setting', field: 'accessCode', message: 'Je bent ingelogd met de toegangscode; leegmaken sluit je buiten. Maak eerst een beheerdersaccount aan (tabblad Gebruikers) en log daarmee in.' });
    }
    let changed;
    try {
      changed = settings.update(patch, req.user?.id);
    } catch (err) {
      if (err instanceof SettingsError) return res.status(400).json({ error: 'invalid_setting', field: err.field, message: err.message });
      throw err;
    }
    // Nieuwe toegangscode: andere toestellen zijn uitgelogd, deze beheerder niet.
    if (via === 'code' && settings.get('accessCode') && settings.get('accessCode') !== oldCode) auth.setCookie(req, res);
    if (changed.length) {
      console.log(`Instellingen gewijzigd door ${req.user?.display_name || 'beheerder'}: ${changed.join(', ')}`);
      audit(req, 'instellingen_gewijzigd', { fields: changed });
    }
    const responseSettings = settings.view();
    if (req.tenantId !== tenant.id) { delete responseSettings.storefront; delete responseSettings.shopPlanner; delete responseSettings.shopOrdering; delete responseSettings.shopShipping; delete responseSettings.shopPayment; delete responseSettings.shopAnalytics; delete responseSettings.shopSeo; delete responseSettings.mollieApiKey; }
    res.json({ settings: responseSettings, changed });
  });

  // Sleutel testen zonder kosten: vraagt alleen het model op.
  app.post('/api/admin/settings/test-ai', async (req, res, next) => {
    const aiClient = currentAnalyzer(req.tenantId);
    if (!aiClient.check) return res.status(501).json({ error: 'not_supported', message: 'Testen is niet beschikbaar.' });
    try {
      res.json(await aiClient.check());
    } catch (err) {
      if (err instanceof AnalyzeError) return res.status(err.status === 502 ? 400 : err.status).json({ error: err.code, message: err.message });
      next(err);
    }
  });
}

module.exports = { registerSettingsRoutes };
