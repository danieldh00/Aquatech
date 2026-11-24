// Modules aan/uit (Beheer > Modules): de vlaggen zoals ze in een omgeving echt gelden en het opslaan ervan.
// Het register staat in frontend/dashboard/modules.js (MODULES en FEATURES). Een schakelaar is een vlag in de
// instelling `modules`, of (FEATURES met `setting`) een bestaande instelling uit settings.js: die blijft de ene
// waarheid, dit bestand leest en schrijft haar alleen. Routes: GET|PUT /api/admin/modules (recht beheer).

/**
 * Maakt de functies voor de modulevlaggen.
 * @param {{ ModuleTools: object, settingsFor: Function, mainTenantId: string, multitenancyOn: Function }} options Het moduleregister, de instellingen per omgeving, de hoofdtenant en of multitenancy aan staat.
 * @returns {{ flagsOf: Function, lockedOf: Function, apply: Function }} De functies.
 */
function createModuleSwitches({ ModuleTools, settingsFor, mainTenantId, multitenancyOn }) {
  const backed = ModuleTools.FEATURES.filter((feature) => feature.setting);

  /**
   * De stand van een schakelaar die een bestaande instelling is.
   * @param {object} settings De instellingen van de omgeving.
   * @param {object} feature De regel uit FEATURES (met `setting`).
   * @returns {boolean} true als de instelling aan staat.
   */
  function settingOn(settings, feature) {
    const value = settings.get(feature.setting.key);
    return feature.setting.field ? Boolean(value && value[feature.setting.field]) : Boolean(value);
  }

  /**
   * Waarom een schakelaar in deze omgeving niet te bedienen is.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} Id → reden in gewone taal; een bedienbare schakelaar ontbreekt.
   */
  function lockedOf(tenantId) {
    const locked = {};
    if (!multitenancyOn()) locked.uitbesteden = 'Werkt alleen met meer organisaties (Hoofdbeheer > Multitenancy).';
    if (tenantId !== mainTenantId) for (const feature of ModuleTools.FEATURES) if (feature.mainOnly) locked[feature.id] = 'Alleen voor de hoofdorganisatie.';
    return locked;
  }

  /**
   * De vlaggen zoals ze in een omgeving echt gelden: de bewaarde vlaggen, de stand van de instellingen achter een
   * schakelaar en wat in deze omgeving niet kan (uitbesteden zonder multitenancy, de webshop buiten de hoofdtenant).
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} Id → false voor wat uit staat (voor schakelaars met een instelling ook true).
   */
  function flagsOf(tenantId) {
    const settings = settingsFor(tenantId);
    const flags = { ...settings.get('modules') };
    for (const feature of backed) flags[feature.id] = settingOn(settings, feature);
    for (const id of Object.keys(lockedOf(tenantId))) flags[id] = false;
    return flags;
  }

  /**
   * Slaat een wijziging van schakelaars op: vlaggen in `modules`, de rest in de instelling erachter. Alles of niets.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} wanted Id → true (aan) of false (uit).
   * @param {string|null} userId Wie het wijzigt.
   * @returns {{ ok: true, on: string[], off: string[] }|{ ok: false, status: number, error: string, field: string, message: string }} Wat er echt veranderde, of de weigering.
   */
  function apply(tenantId, wanted, userId) {
    const known = new Set(ModuleTools.switchIds());
    const locked = lockedOf(tenantId);
    const entries = Object.entries(wanted);
    for (const [id, value] of entries) {
      if (!known.has(id) || typeof value !== 'boolean') return { ok: false, status: 400, error: 'invalid_module', field: id, message: 'Onbekende module of ongeldige waarde.' };
    }
    const before = flagsOf(tenantId);
    const changes = entries.filter(([id, value]) => (before[id] !== false) !== value);
    const refused = changes.find(([id]) => locked[id]);
    if (refused) return { ok: false, status: 409, error: 'module_locked', field: refused[0], message: `${ModuleTools.titleOf(refused[0])}: ${locked[refused[0]]}` };
    if (!changes.length) return { ok: true, on: [], off: [] };
    const settings = settingsFor(tenantId);
    // Een instelling van een module die (na deze wijziging) uit staat wordt niet gewijzigd, net als in Beheer > Instellingen.
    const lockedKeys = ModuleTools.lockedSettings({ ...before, ...Object.fromEntries(changes) });
    const hidden = changes.find(([id]) => { const feature = backed.find((candidate) => candidate.id === id); return feature && lockedKeys.has(feature.setting.key); });
    if (hidden) return { ok: false, status: 409, error: 'module_off', field: hidden[0], message: `${ModuleTools.titleOf(hidden[0])} hoort bij een module die uit staat. Zet die module eerst aan.` };
    const patch = {};
    for (const [id, value] of changes) {
      const feature = backed.find((candidate) => candidate.id === id);
      if (!feature) patch.modules = { ...(patch.modules || {}), [id]: value };
      else if (feature.setting.field) patch[feature.setting.key] = { ...(patch[feature.setting.key] || settings.get(feature.setting.key)), [feature.setting.field]: value };
      else patch[feature.setting.key] = value;
    }
    settings.update(patch, userId);
    return { ok: true, on: changes.filter(([, value]) => value).map(([id]) => id), off: changes.filter(([, value]) => !value).map(([id]) => id) };
  }

  return { flagsOf, lockedOf, apply };
}

/**
 * Registreert de routes van Beheer > Modules (onder /api/admin, dus alleen met het recht beheer).
 * @param {import('express').Express} app De app.
 * @param {{ moduleSwitches: object, requireJson: Function, audit: Function }} ctx De modulevlaggen, de JSON-poort en het auditlog.
 * @returns {void}
 */
function registerModuleRoutes(app, { moduleSwitches, requireJson, audit }) {
  app.get('/api/admin/modules', (req, res) => {
    res.json({ flags: moduleSwitches.flagsOf(req.tenantId), locked: moduleSwitches.lockedOf(req.tenantId) });
  });

  app.put('/api/admin/modules', requireJson, (req, res) => {
    const wanted = req.body && req.body.flags;
    if (!wanted || typeof wanted !== 'object' || Array.isArray(wanted)) return res.status(400).json({ error: 'invalid_module', message: 'Geef de schakelaars mee als flags.' });
    const result = moduleSwitches.apply(req.tenantId, wanted, req.user?.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error, field: result.field, message: result.message });
    if (result.on.length || result.off.length) audit(req, 'modules_gewijzigd', { aan: result.on, uit: result.off });
    res.json({ flags: moduleSwitches.flagsOf(req.tenantId), locked: moduleSwitches.lockedOf(req.tenantId), on: result.on, off: result.off });
  });
}

module.exports = { createModuleSwitches, registerModuleRoutes };
