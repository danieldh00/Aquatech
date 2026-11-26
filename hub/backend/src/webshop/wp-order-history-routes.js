// Routes voor de WordPress-orderhistorie (Artikelen > Past bij): stand, starten (serverjob), stoppen met uurlijks bijwerken en niet-gekoppelde producten
// met de hand koppelen. Recht `voorraad`. Alleen lezen uit WordPress: er gaat niets terug naar de webshop.
const { createRateLimiter } = require('../beveiliging/rate-limit');

/**
 * Koppelt de routes aan de app.
 * @param {object} app Express-app.
 * @param {object} deps history (createWpOrderHistory), requireRight, requireJson, audit.
 * @returns {void}
 */
function registerWpOrderHistoryRoutes(app, { history, requireRight, requireJson, audit }) {
  const requireStock = requireRight('voorraad');
  const startLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, keyFn: (req) => `wp-history|${req.tenantId}` });
  const base = '/api/stock/related/wp-orders';

  app.get(base, requireStock, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: history.status(req.tenantId), unmatched: history.unmatched(req.tenantId) });
  });

  app.post(`${base}/start`, requireJson, requireStock, startLimiter, (req, res) => {
    const months = Number(req.body && req.body.months) || null;
    const outcome = history.start(req.tenantId, { months, restart: Boolean(req.body && req.body.restart) });
    audit(req, 'wordpress_orders_ophalen', { started: outcome.started, months });
    res.status(202).json({ ...outcome, status: history.status(req.tenantId) });
  });

  app.post(`${base}/stop`, requireJson, requireStock, (req, res) => {
    history.stop(req.tenantId);
    audit(req, 'wordpress_orders_uurlijks_uit', {});
    res.json({ status: history.status(req.tenantId) });
  });

  app.post(`${base}/link`, requireJson, requireStock, (req, res) => {
    const body = req.body || {};
    const outcome = history.link(req.tenantId, body, body.itemId);
    if (outcome.error) return res.status(outcome.status).json({ error: 'not_found', message: outcome.error });
    audit(req, 'wordpress_orders_gekoppeld', { regels: outcome.updated });
    return res.json({ ...outcome, status: history.status(req.tenantId), unmatched: history.unmatched(req.tenantId) });
  });
}

module.exports = { registerWpOrderHistoryRoutes };
