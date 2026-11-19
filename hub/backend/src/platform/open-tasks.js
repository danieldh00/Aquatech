// Openstaande taken voor het dashboard: wat er voor de ingelogde gebruiker nog te doen ligt (bestellingen
// verwerken, bestelvoorstellen goedkeuren, prijsvoorstellen beoordelen, artikelen zonder leverancier).
// Elke taak hoort bij een recht; wie het recht niet heeft, krijgt de taak niet te zien.
const Roles = require('../../../frontend/shared/roles.js');

/** Hoe lang het aantal prijsvoorstellen en bestelvoorstellen per omgeving onthouden wordt (de berekening loopt over alle artikelen en het dashboard is de startpagina). */
const CACHE_TTL_MS = 10 * 1000;
const cache = new Map();

/**
 * Geeft de uitkomst van een dure berekening terug en onthoudt hem kort per omgeving.
 * @param {string} key Sleutel van de berekening, inclusief omgeving.
 * @param {Function} compute Berekent de waarde.
 * @returns {*} De (eventueel onthouden) waarde.
 */
function remembered(key, compute) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = compute();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

/**
 * Bouwt de lijst met openstaande taken voor een gebruiker en omgeving.
 * @param {{ user: object, tenantId: string, canHostTasks?: boolean }} viewer De gebruiker (met rechten), de omgeving en of de gebruiker de servertaken mag zien (canUpdate).
 * @param {{ orders: object, purchaseOrders: object, priceFactors: object, proposalsEnabled: Function, shopEnabled: Function, stockEnabled: Function }} sources De opslag per soort taak (hostTasks = de servertaken, mag ontbreken); shopEnabled en stockEnabled zeggen of de webshop en de module voorraad aan staan.
 * @returns {{ key: string, title: string, count: number, href: string, items: { label: string, meta: string, href: string }[] }[]} Alleen taken met minstens één openstaand punt.
 */
function buildTasks({ user, tenantId, canHostTasks = false }, { hostTasks, orders, purchaseOrders, priceFactors, proposalsEnabled, shopEnabled, stockEnabled }) {
  const tasks = [];
  if (Roles.can(user, 'beheer') && shopEnabled(tenantId)) {
    const open = orders.listUnprocessed(tenantId, 5);
    tasks.push({
      key: 'bestellingen', title: 'Webshopbestellingen verwerken', count: open.total, href: 'webshop-bestellingen/',
      items: open.items.map((order) => ({ label: `${order.number} · ${order.customerName}`, meta: `${order.createdAt.slice(0, 10)} · ${order.total.toFixed(2).replace('.', ',')} euro`, href: `webshop-bestellingen/?id=${encodeURIComponent(order.id)}` })),
    });
  }
  if (Roles.can(user, 'voorraad') && stockEnabled(tenantId)) {
    if (proposalsEnabled(tenantId)) {
      const proposals = remembered(`voorstellen:${tenantId}`, () => purchaseOrders.proposals(tenantId));
      tasks.push({
        key: 'bestelvoorstellen', title: 'Bestelvoorstellen goedkeuren (lage voorraad)', count: proposals.orders.length, href: 'artikelen/#reorder',
        items: proposals.orders.slice(0, 5).map((order) => ({ label: `${order.number} · ${order.supplierName || 'Leverancier'}`, meta: `${order.lines.length} artikel${order.lines.length === 1 ? '' : 'en'}`, href: 'artikelen/#reorder' })),
      });
      tasks.push({ key: 'zonder-leverancier', title: 'Artikelen onder het minimum zonder voorkeursleverancier', count: proposals.withoutSupplier, href: 'artikelen/#reorder', items: [] });
    }
    tasks.push({ key: 'prijsvoorstellen', title: 'Prijsvoorstellen beoordelen', count: remembered(`prijzen:${tenantId}`, () => priceFactors.openProposals(tenantId).length), href: 'artikelen/#pricefactor', items: [] });
  }
  if (canHostTasks && hostTasks) {
    const hostView = hostTasks.view();
    const open = hostView.tasks.filter((task) => !task.done);
    tasks.push({
      key: 'servertaken', title: 'Servertaken uitvoeren op de Proxmox-host', count: open.length, href: 'beheer/#updates', command: hostView.command,
      items: open.map((task) => ({ label: task.title, meta: `Toegevoegd ${task.addedAt}`, href: 'beheer/#updates' })),
    });
  }
  return tasks.filter((task) => task.count > 0);
}

/**
 * Registreert `GET /api/tasks` (ingelogd; de taken volgen de rechten van de gebruiker).
 * @param {object} app De Express-app.
 * @param {{ identify: Function, canUpdate?: Function, sources: object }} ctx De identificatie van de server, wie het systeem mag bijwerken (servertaken) en de opslag per soort taak.
 * @returns {void}
 */
function registerOpenTaskRoutes(app, { identify, canUpdate = () => false, sources }) {
  app.get('/api/tasks', (req, res) => {
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    res.set('Cache-Control', 'no-store');
    res.json({ tasks: buildTasks({ user, tenantId: req.tenantId, canHostTasks: canUpdate(req) }, sources) });
  });
}

/**
 * Wist de onthouden tellingen (voor tests).
 * @returns {void}
 */
function resetCache() { cache.clear(); }

module.exports = { buildTasks, registerOpenTaskRoutes, resetCache };
