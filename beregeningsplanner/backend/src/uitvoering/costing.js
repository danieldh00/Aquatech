// Nacalculatie per werkorder: GET /api/workorders/:id/costing (recht
// nacalculatie). Haalt de werkorder, de offerte, de geboekte uren en het
// materiaalverbruik, de prijzen uit de voorraad en de facturen van de
// werkorder op (een vast aantal queries) en rekent met
// frontend/werkorders/costing-core.js. De Excel-export maakt de browser.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');

const Core = require(path.join(FRONTEND_DIR, 'werkorders', 'costing-core.js'));

/**
 * Registreert de route van de nacalculatie.
 * @param {object} app De Express-app.
 * @param {object} ctx { requireRight, invoices (workOrder, quote, list), loggedOf(tid, woId), articlesOf(tid, codes), profileOf(req) }.
 * @returns {void}
 */
function registerCostingRoutes(app, ctx) {
  const { requireRight, invoices } = ctx;

  app.get('/api/workorders/:id/costing', requireRight('nacalculatie'), (req, res) => {
    const tenantId = req.tenantId || req.user.tenant_id;
    const workOrder = invoices.workOrder(tenantId, req.params.id);
    if (!workOrder) return res.status(404).json({ error: 'not_found', message: 'Werkorder niet gevonden.' });
    const quote = workOrder.quoteId ? invoices.quote(tenantId, workOrder.quoteId) : null;
    const logged = ctx.loggedOf(tenantId, workOrder.id);
    const codes = [
      ...((quote && quote.data.lines) || []).map((line) => line.code),
      ...(workOrder.data.materials || []).map((line) => line.code),
      ...logged.materials.map((line) => line.code),
    ].filter(Boolean);
    const profile = ctx.profileOf(req);
    const result = Core.compute({
      workOrder, quote, logged, articles: ctx.articlesOf(tenantId, codes),
      invoices: invoices.list(tenantId, { workOrderId: workOrder.id }),
      hourlyRate: profile.hourlyRate, hourlyCost: profile.hourlyCost,
    });
    res.json({
      workOrder: { id: workOrder.id, number: workOrder.number, title: workOrder.data.title || '', customer: (workOrder.data.customer && workOrder.data.customer.name) || '' },
      quote: quote ? { id: quote.id, number: quote.number } : null,
      ...result,
    });
  });
}

module.exports = { registerCostingRoutes, Core };
