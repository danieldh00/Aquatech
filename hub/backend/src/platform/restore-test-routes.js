// Routes voor de hersteltest van de back-up (Beheer > Systeem > Hersteltest): stand opvragen, instellen en nu laten
// testen. Dezelfde toegang als de systeemupdate (alleen de beheerder van de hoofdorganisatie, `canUpdate`); de test
// zelf draait op de server (platform/restore-test.js en deploy/apps01/restore-test.sh).
const express = require('express');
const { createRateLimiter } = require('../beveiliging/rate-limit');

/**
 * Registreert de routes onder /api/admin/restore-test (de map /api/admin eist al het recht beheer).
 * @param {import('express').Express} app De app.
 * @param {object} ctx restoreTest (createRestoreTest), audit (req, actie, detail, gebruiker, tenant), mainTenantId en canUpdate (req → boolean).
 * @returns {void}
 */
function registerRestoreTestRoutes(app, { restoreTest, audit, mainTenantId, canUpdate }) {
  const changeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `hersteltest-wijzig:${req.user ? req.user.id : ''}` });
  const runLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 6, keyFn: (req) => `hersteltest-start:${req.user ? req.user.id : ''}` });

  app.use('/api/admin/restore-test', express.json({ limit: '1kb' }), (req, res, next) => {
    if (!canUpdate(req)) return res.status(403).json({ error: 'forbidden', message: 'Alleen de beheerder van de hoofdorganisatie beheert de hersteltest.' });
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/admin/restore-test', (req, res) => res.json(restoreTest.view()));

  app.put('/api/admin/restore-test', changeLimiter, (req, res) => {
    const out = restoreTest.setPolicy(req.body);
    if (out.error) return res.status(out.status).json({ error: out.error, message: out.message });
    audit(req, 'hersteltest_ingesteld', { aan: out.policy.enabled, dag: out.policy.day, tijd: out.policy.time }, undefined, mainTenantId);
    res.json(restoreTest.view());
  });

  app.post('/api/admin/restore-test/run', runLimiter, (req, res) => {
    const out = restoreTest.requestRun({ userId: req.user.id, byName: req.user.display_name });
    if (out.error) return res.status(out.status).json({ error: out.error, message: out.message });
    audit(req, 'hersteltest_aangevraagd', {}, undefined, mainTenantId);
    res.status(202).json(restoreTest.view());
  });
}

module.exports = { registerRestoreTestRoutes };
