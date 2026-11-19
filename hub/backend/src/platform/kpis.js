// Kengetallen voor het beheerdersdashboard (`GET /api/kpis`): welke KPI's, in welke volgorde en over welke periode komt
// uit de instelling `dashboardKpis` (Beheer > Modules > Dashboard: kengetallen); de catalogus staat in kpi-catalog.js.
const Roles = require('../../../frontend/shared/roles.js');
const { buildKpis, weekOf } = require('./kpi-catalog');

/**
 * Registreert `GET /api/kpis` (ingelogd, alleen beheerders; de tegels volgen de instelling van de omgeving, de modules die aan
 * staan en de rechten van de gebruiker).
 * @param {object} app De Express-app.
 * @param {{ identify: Function, db: object, settingsFor: Function, isModuleOn: Function }} ctx Identificatie, database,
 *   de instellingen per omgeving en een functie (omgeving, module-id) → boolean.
 * @returns {void}
 */
function registerKpiRoutes(app, { identify, db, settingsFor = null, isModuleOn = () => true }) {
  app.get('/api/kpis', (req, res) => {
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    if (!Roles.can(user, 'beheer')) return res.status(403).json({ error: 'forbidden', message: 'Alleen voor beheerders.' });
    res.set('Cache-Control', 'no-store');
    const config = settingsFor ? settingsFor(req.tenantId).get('dashboardKpis') : undefined;
    res.json({ kpis: buildKpis({ user, tenantId: req.tenantId }, { db, config, isModuleOn: (moduleId) => isModuleOn(req.tenantId, moduleId) }) });
  });
}

module.exports = { buildKpis, registerKpiRoutes, weekOf };
