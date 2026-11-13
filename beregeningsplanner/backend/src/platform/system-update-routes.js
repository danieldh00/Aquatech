// Routes voor de systeemupdate (Beheer > Systeem > Updates) en de onderhoudsmodus tijdens een uitrol.
// De koppeling met het hostscript staat in system-update.js; hier staan alleen wie wat mag, de limieten en het
// auditlog. Alleen een eigen account van de hoofdtenant met beheerrechten (bij multitenancy: een hoofdbeheerder)
// mag een update starten, en alleen na het opnieuw invullen van het eigen wachtwoord.
const express = require('express');
const { verifyPassword } = require('./store');
const { createRateLimiter } = require('../beveiliging/rate-limit');

// Tijdens de onderhoudsmodus blijven deze schrijfverzoeken werken: uitloggen, en de webhook van Mollie (die vraagt de
// betaalstand zelf op en is herhaalbaar; Mollie probeert het anders later opnieuw, maar dan blijft een betaling langer open).
const MAINTENANCE_OPEN = [/^\/api\/auth\/logout$/, /^\/mollie\/webhook\//];
const MAINTENANCE_MESSAGE = 'Er wordt een update geïnstalleerd. Opslaan kan even niet; probeer het over een minuut opnieuw.';

/**
 * Middleware voor de onderhoudsmodus: elk antwoord krijgt de kop X-Aquatech-Maintenance (de pagina's tonen dan een
 * balk), en schrijfverzoeken krijgen 503 met Retry-After, zodat er tijdens het wisselen niets half wordt opgeslagen.
 * @param {object} systemUpdate De koppeling uit createSystemUpdate.
 * @returns {Function} Express-middleware.
 */
function maintenanceGuard(systemUpdate) {
  return (req, res, next) => {
    const state = systemUpdate.maintenance();
    if (!state.active) return next();
    res.setHeader('X-Aquatech-Maintenance', '1');
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (MAINTENANCE_OPEN.some((pattern) => pattern.test(req.path))) return next();
    res.setHeader('Retry-After', '60');
    res.setHeader('Cache-Control', 'no-store');
    const wantsJson = req.path.startsWith('/api/') || req.path === '/mcp' || req.path.startsWith('/oauth/') || req.is('application/json');
    if (wantsJson) return res.status(503).json({ error: 'maintenance', message: MAINTENANCE_MESSAGE });
    return res.status(503).type('html').send(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Even geduld</title></head><body><h1>Even geduld</h1><p>${MAINTENANCE_MESSAGE}</p></body></html>`);
  };
}

/**
 * Registreert de routes onder /api/admin/system-update (de map /api/admin eist al het recht beheer).
 * @param {import('express').Express} app De app.
 * @param {object} ctx systemUpdate, store, audit (req, actie, detail, gebruiker, tenant), mainTenantId en canUpdate (req → boolean).
 * @returns {{ recordFinished: Function }} Om een afgeronde uitrol bij het opstarten vast te leggen.
 */
function registerSystemUpdateRoutes(app, { systemUpdate, store, audit, mainTenantId, canUpdate }) {
  // Starten: weinig pogingen per gebruiker (ook tegen raden van het wachtwoord).
  const startLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, keyFn: (req) => `update:${req.user ? req.user.id : ''}` });
  const changeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `update-wijzig:${req.user ? req.user.id : ''}` });

  /**
   * Legt een afgeronde uitrol (ook een automatische) één keer vast in het auditlog van de hoofdtenant. Draait bij het
   * opstarten en bij het openen van het scherm.
   * @returns {void}
   */
  const recordFinished = () => {
    const run = systemUpdate.finishedRun();
    if (!run) return;
    const action = run.state === 'geslaagd' ? 'update_geslaagd' : run.state === 'geweigerd' ? 'update_geweigerd' : 'update_mislukt';
    store.audit({ tenantId: mainTenantId, action, detail: { versie: run.version, automatisch: run.automatic, melding: run.message } });
  };

  app.use('/api/admin/system-update', express.json({ limit: '2kb' }), (req, res, next) => {
    if (!canUpdate(req)) return res.status(403).json({ error: 'forbidden', message: 'Alleen de beheerder van de hoofdorganisatie kan het systeem bijwerken.' });
    next();
  });

  app.get('/api/admin/system-update', (req, res) => {
    recordFinished();
    res.json(systemUpdate.view());
  });

  app.post('/api/admin/system-update', startLimiter, async (req, res) => {
    const account = store.getUser(req.user.id);
    const password = String(req.body?.password ?? '').slice(0, 200);
    if (!account || !account.password_hash || !(await verifyPassword(password, account.password_hash))) {
      audit(req, 'update_wachtwoord_fout', {}, undefined, mainTenantId);
      return res.status(401).json({ error: 'wrong_password', message: 'Je wachtwoord klopt niet.' });
    }
    const out = systemUpdate.request({ version: req.body?.version, userId: req.user.id, byName: req.user.display_name });
    if (out.error) return res.status(out.status).json({ error: out.error, message: out.message });
    audit(req, 'update_aangevraagd', { versie: out.request.version, van: systemUpdate.view().running }, undefined, mainTenantId);
    console.log(`Update naar ${out.request.version} aangevraagd door ${req.user.display_name}`);
    res.status(202).json(systemUpdate.view());
  });

  app.delete('/api/admin/system-update/request', changeLimiter, (req, res) => {
    const pending = systemUpdate.view().pending;
    if (!systemUpdate.cancel()) return res.status(404).json({ error: 'not_found', message: 'Er staat geen aanvraag open (misschien is de update al begonnen).' });
    audit(req, 'update_ingetrokken', { versie: pending ? pending.version : null }, undefined, mainTenantId);
    res.json(systemUpdate.view());
  });

  app.put('/api/admin/system-update/auto', changeLimiter, (req, res) => {
    if (typeof req.body?.auto !== 'boolean') return res.status(400).json({ error: 'invalid', message: 'Geef auto: true of false.' });
    if (!systemUpdate.configured) return res.status(501).json({ error: 'not_configured', message: 'Updaten vanuit de app is op deze server niet ingericht.' });
    systemUpdate.setAuto(req.body.auto);
    audit(req, 'update_automatisch', { aan: req.body.auto }, undefined, mainTenantId);
    res.json(systemUpdate.view());
  });

  return { recordFinished };
}

module.exports = { registerSystemUpdateRoutes, maintenanceGuard, MAINTENANCE_MESSAGE };
