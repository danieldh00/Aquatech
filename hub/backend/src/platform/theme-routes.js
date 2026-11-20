// Routes voor Beheer > Kleuren (/api/admin/theme). Het thema zelf staat in frontend/shared/theme.js en wordt als instelling `theme` bewaard.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');

const Theme = require(path.join(FRONTEND_DIR, 'shared', 'theme.js'));

/**
 * Registreert de routes onder /api/admin/theme.
 * @param {import('express').Express} app De app.
 * @param {object} ctx store, tenant (hoofdtenant), settings (van de hoofdtenant), settingsFor, multitenancyOn, homeOf, audit en requireJson.
 * @returns {void}
 */
function registerThemeRoutes(app, { store, tenant, settings, settingsFor, multitenancyOn, homeOf, audit, requireJson }) {
  // Kleurthema (Beheer > Kleuren): elke organisatie stelt het eigen thema in; het thema van de
  // hoofdtenant is de standaard voor organisaties zonder eigen thema. Een testomgeving volgt
  // zijn live-tenant, dus daar werkt dit op de live-tenant. Leeg = huisstijl van AquaTech Service.
  /**
   * Of het account van de aanvrager in een live-omgeving woont: een testaccount (alleen in een testomgeving) wijzigt het live-thema niet.
   * @param {object} req Het verzoek.
   * @returns {boolean} True voor een account van een live-tenant (ook als het in een testomgeving kijkt).
   */
  function accountIsLive(req) {
    const own = store.getTenant(req.user.home_tenant_id || req.user.tenant_id);
    return Boolean(own && own.environment === 'live');
  }

  /**
   * Beschrijft het thema van de organisatie van de aanvrager voor het scherm Kleuren.
   * @param {object} req Het verzoek.
   * @returns {{ defaults: object, mainTenantId: string, tenantId: string, tenantName: string, theme: object, inherited: object, canEdit: boolean }} Of de aanvrager mag wijzigen (`canEdit`), het thema van deze organisatie (`theme`, leeg = geen eigen thema) en het standaardthema (`inherited`) waar zij anders op terugvalt.
   */
  function themeView(req) {
    const homeId = homeOf(req.tenantId);
    const homeRow = store.getTenant(homeId);
    return { defaults: Theme.DEFAULTS, mainTenantId: tenant.id, tenantId: homeId, tenantName: homeRow ? homeRow.name : '',
      theme: settingsFor(homeId).get('theme'), inherited: settings.get('theme'),
      canEdit: accountIsLive(req) && (homeId !== tenant.id || !multitenancyOn() || Boolean(req.user.platform_admin)) };
  }

  app.get('/api/admin/theme', (req, res) => { res.json(themeView(req)); });

  app.put('/api/admin/theme', requireJson, (req, res) => {
    const targetId = homeOf(req.tenantId);
    const tenantRow = store.getTenant(targetId);
    if (!tenantRow || tenantRow.environment !== 'live') return res.status(404).json({ error: 'not_found', message: 'Organisatie niet gevonden.' });
    if (!accountIsLive(req)) return res.status(403).json({ error: 'forbidden', message: 'Een testaccount wijzigt het thema van de live-omgeving niet.' });
    // Het thema van de hoofdtenant is de standaard voor alle andere organisaties: met meer organisaties alleen voor een hoofdbeheerder.
    if (targetId === tenant.id && multitenancyOn() && !req.user.platform_admin) {
      return res.status(403).json({ error: 'forbidden', message: 'Het standaardthema voor alle organisaties wijzigt alleen een hoofdbeheerder.' });
    }
    const raw = req.body?.colors;
    const target = settingsFor(targetId);
    if (raw == null || (typeof raw === 'object' && !Object.keys(raw).length)) {
      target.update({ reset: ['theme'] }, req.user.id);
    } else {
      if (typeof raw !== 'object' || Array.isArray(raw)) return res.status(400).json({ error: 'invalid_theme', message: 'Ongeldige kleuren.' });
      for (const [field, color] of Object.entries(raw)) {
        if (!Theme.FIELDS[field]) return res.status(400).json({ error: 'invalid_theme', field, message: `Onbekende kleur: ${field}` });
        if (!Theme.hex(color)) return res.status(400).json({ error: 'invalid_theme', field, message: `${Theme.FIELDS[field].label}: geef een kleur als #rrggbb.` });
      }
      const problem = Theme.problems(raw)[0];
      if (problem) return res.status(400).json({ error: 'invalid_theme', field: problem.field, message: problem.message });
      const colors = Theme.resolve(raw);
      if (targetId === tenant.id && Theme.isDefault(colors)) target.update({ reset: ['theme'] }, req.user.id);
      else target.update({ theme: colors }, req.user.id);
    }
    const theme = target.get('theme');
    console.log(`Kleurthema van ${tenantRow.name} gewijzigd door ${req.user.display_name}: ${Object.keys(theme).length ? Object.values(theme).join(' ') : 'standaard'}`);
    audit(req, 'thema_gewijzigd', { tenantId: targetId, theme }, undefined, targetId);
    res.json({ tenantId: targetId, theme });
  });
}

module.exports = { registerThemeRoutes };
