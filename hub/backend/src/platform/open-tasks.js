// Openstaande taken voor het dashboard: wat er voor de ingelogde gebruiker nog te doen ligt (bestellingen
// verwerken, bestelvoorstellen goedkeuren, prijsvoorstellen beoordelen, artikelen zonder leverancier).
// Elke taak hoort bij een recht; wie het recht niet heeft, krijgt de taak niet te zien.
const Roles = require('../../../frontend/shared/roles.js');

/**
 * Bouwt de lijst met openstaande taken voor een gebruiker en omgeving.
 * @param {{ user: object, tenantId: string }} viewer De gebruiker (met rechten) en de omgeving.
 * @param {{ orders: object, purchaseOrders: object, priceFactors: object, proposalsEnabled: Function }} sources De opslag per soort taak.
 * @returns {{ key: string, title: string, count: number, href: string, items: { label: string, meta: string, href: string }[] }[]} Alleen taken met minstens één openstaand punt.
 */
function buildTasks({ user, tenantId }, { orders, purchaseOrders, priceFactors, proposalsEnabled }) {
  const tasks = [];
  if (Roles.can(user, 'beheer')) {
    const open = orders.listUnprocessed(tenantId, 5);
    tasks.push({
      key: 'bestellingen', title: 'Webshopbestellingen verwerken', count: open.total, href: 'webshop-bestellingen/',
      items: open.items.map((order) => ({ label: `${order.number} · ${order.customerName}`, meta: `${order.createdAt.slice(0, 10)} · ${order.total.toFixed(2).replace('.', ',')} euro`, href: `webshop-bestellingen/?id=${encodeURIComponent(order.id)}` })),
    });
  }
  if (Roles.can(user, 'voorraad')) {
    if (proposalsEnabled(tenantId)) {
      const proposals = purchaseOrders.proposals(tenantId);
      tasks.push({
        key: 'bestelvoorstellen', title: 'Bestelvoorstellen goedkeuren (lage voorraad)', count: proposals.orders.length, href: 'artikelen/#reorder',
        items: proposals.orders.slice(0, 5).map((order) => ({ label: `${order.number} · ${order.supplierName || 'Leverancier'}`, meta: `${order.lines.length} artikel${order.lines.length === 1 ? '' : 'en'}`, href: 'artikelen/#reorder' })),
      });
      tasks.push({ key: 'zonder-leverancier', title: 'Artikelen onder het minimum zonder voorkeursleverancier', count: proposals.withoutSupplier, href: 'artikelen/#reorder', items: [] });
    }
    tasks.push({ key: 'prijsvoorstellen', title: 'Prijsvoorstellen beoordelen', count: priceFactors.openProposals(tenantId).length, href: 'artikelen/#pricefactor', items: [] });
  }
  return tasks.filter((task) => task.count > 0);
}

/**
 * Registreert `GET /api/tasks` (ingelogd; de taken volgen de rechten van de gebruiker).
 * @param {object} app De Express-app.
 * @param {{ identify: Function, sources: object }} ctx De identificatie van de server en de opslag per soort taak.
 * @returns {void}
 */
function registerOpenTaskRoutes(app, { identify, sources }) {
  app.get('/api/tasks', (req, res) => {
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    res.set('Cache-Control', 'no-store');
    res.json({ tasks: buildTasks({ user, tenantId: req.tenantId }, sources) });
  });
}

module.exports = { buildTasks, registerOpenTaskRoutes };
