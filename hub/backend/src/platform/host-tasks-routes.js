// Routes voor de servertaken (Beheer > Systeem > Updates): de lijst lezen en een taak met de hand afvinken.
// Alleen wie het systeem mag bijwerken (canUpdate: beheerder van de hoofdtenant) heeft hier toegang.
const express = require('express');
const { createRateLimiter } = require('../beveiliging/rate-limit');

/**
 * Registreert `GET /api/admin/host-tasks` en `PUT /api/admin/host-tasks/:id` (de map /api/admin eist al het recht beheer).
 * @param {import('express').Express} app De app.
 * @param {{ hostTasks: object, audit: Function, mainTenantId: string, canUpdate: Function }} ctx De opslag uit createHostTasks, het auditlog, de hoofdtenant en wie mag.
 * @returns {void}
 */
function registerHostTaskRoutes(app, { hostTasks, audit, mainTenantId, canUpdate }) {
  const changeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, keyFn: (req) => `servertaak:${req.user ? req.user.id : ''}` });
  app.use('/api/admin/host-tasks', express.json({ limit: '1kb' }), (req, res, next) => {
    if (!canUpdate(req)) return res.status(403).json({ error: 'forbidden', message: 'Alleen de beheerder van de hoofdorganisatie ziet de servertaken.' });
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/admin/host-tasks', (req, res) => res.json(hostTasks.view()));
  app.put('/api/admin/host-tasks/:id', changeLimiter, (req, res) => {
    if (typeof req.body?.done !== 'boolean') return res.status(400).json({ error: 'invalid', message: 'Geef done: true of false.' });
    if (!hostTasks.setChecked(req.params.id, req.body.done, req.user.display_name)) return res.status(404).json({ error: 'not_found', message: 'Deze servertaak bestaat niet.' });
    audit(req, req.body.done ? 'servertaak_afgevinkt' : 'servertaak_heropend', { taak: req.params.id }, undefined, mainTenantId);
    res.json(hostTasks.view());
  });
}

module.exports = { registerHostTaskRoutes };
