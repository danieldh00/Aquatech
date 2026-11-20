// Routes voor de hersteltest van de Google Drive-back-up (Beheer > Systeem > Hersteltest Google Drive): stand, instellen en nu
// testen. Dezelfde toegang als de lokale hersteltest (alleen de beheerder van de hoofdorganisatie, `canUpdate`); de test zelf
// draait in de app (platform/drive-restore-test.js).
const express = require('express');
const { createRateLimiter } = require('../beveiliging/rate-limit');

/**
 * Registreert de routes onder /api/admin/restore-test-drive (de map /api/admin eist al het recht beheer).
 * @param {import('express').Express} app De app.
 * @param {object} ctx driveRestoreTest (createDriveRestoreTest), audit (req, actie, detail, gebruiker, tenant), mainTenantId en canUpdate (req → boolean).
 * @returns {void}
 */
function registerDriveRestoreTestRoutes(app, { driveRestoreTest, audit, mainTenantId, canUpdate }) {
  const changeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `hersteltest-drive-wijzig:${req.user ? req.user.id : ''}` });
  const runLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 4, keyFn: (req) => `hersteltest-drive-start:${req.user ? req.user.id : ''}` });

  app.use('/api/admin/restore-test-drive', express.json({ limit: '1kb' }), (req, res, next) => {
    if (!canUpdate(req)) return res.status(403).json({ error: 'forbidden', message: 'Alleen de beheerder van de hoofdorganisatie beheert de hersteltest.' });
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/admin/restore-test-drive', (req, res) => res.json(driveRestoreTest.view()));

  app.put('/api/admin/restore-test-drive', changeLimiter, (req, res) => {
    const out = driveRestoreTest.setPolicy(req.body);
    if (out.error) return res.status(out.status).json({ error: out.error, message: out.message });
    audit(req, 'hersteltest_drive_ingesteld', { aan: out.policy.enabled, dag: out.policy.day, tijd: out.policy.time }, undefined, mainTenantId);
    res.json(driveRestoreTest.view());
  });

  app.post('/api/admin/restore-test-drive/run', runLimiter, (req, res) => {
    const out = driveRestoreTest.run({ trigger: 'handmatig' });
    if (out.error) return res.status(out.status).json({ error: out.error, message: out.message });
    audit(req, 'hersteltest_drive_aangevraagd', {}, undefined, mainTenantId);
    res.status(202).json(driveRestoreTest.view());
  });
}

module.exports = { registerDriveRestoreTestRoutes };
