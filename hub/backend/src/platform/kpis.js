// Kengetallen voor het beheerdersdashboard: openstaand bedrag, vervallen facturen, open offertes en de
// bezetting van deze week. Elk kengetal hoort bij een recht; wie het recht niet heeft, krijgt het niet te zien.
const Roles = require('../../../frontend/shared/roles.js');
const QuoteCore = require('../../../frontend/offertes/quote-core.js');

/**
 * Geeft de maandag en zondag van de week waarin een datum valt.
 * @param {string} date Datum als JJJJ-MM-DD.
 * @returns {{ from: string, to: string }} Eerste en laatste dag van de week.
 */
function weekOf(date) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const sinceMonday = (weekday + 6) % 7;
  const from = QuoteCore.addDays(date, -sinceMonday);
  return { from, to: QuoteCore.addDays(from, 6) };
}

/**
 * Bouwt de kengetallen voor een gebruiker en omgeving; alleen voor wie `beheer` heeft.
 * @param {{ user: object, tenantId: string }} viewer De gebruiker (met rechten) en de omgeving.
 * @param {{ db: object, today?: string }} sources De database en eventueel een vaste datum (tests).
 * @returns {{ key: string, title: string, value: number, unit: string, detail: string, href: string }[]} De tegels, in vaste volgorde.
 */
function buildKpis({ user, tenantId }, { db, today = QuoteCore.today() }) {
  const tiles = [];
  if (!Roles.can(user, 'beheer')) return tiles;
  if (Roles.can(user, 'facturen')) {
    const open = db.prepare("SELECT COALESCE(SUM(total), 0) AS amount, COUNT(*) AS count FROM invoices WHERE tenant_id = ? AND status = 'definitief'").get(tenantId);
    const overdue = db.prepare("SELECT COALESCE(SUM(total), 0) AS amount, COUNT(*) AS count FROM invoices WHERE tenant_id = ? AND status = 'definitief' AND kind = 'factuur' AND due_date < ?").get(tenantId, today);
    tiles.push({ key: 'openstaand', title: 'Openstaand bedrag', value: QuoteCore.round2(Number(open.amount)), unit: 'euro', detail: `${Number(open.count)} open factu${Number(open.count) === 1 ? 'ur' : 'ren'} (incl. btw)`, href: 'facturen/' });
    tiles.push({ key: 'vervallen', title: 'Vervallen facturen', value: Number(overdue.count), unit: 'aantal', detail: `${QuoteCore.round2(Number(overdue.amount)).toFixed(2).replace('.', ',')} euro voorbij de vervaldatum`, href: 'facturen/' });
  }
  if (Roles.can(user, 'offertes')) {
    const quotes = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total_excl), 0) AS amount FROM quotes WHERE tenant_id = ? AND status = 'verzonden' AND deleted_at IS NULL").get(tenantId);
    tiles.push({ key: 'offertes', title: 'Open offertes', value: Number(quotes.count), unit: 'aantal', detail: `${QuoteCore.round2(Number(quotes.amount)).toFixed(2).replace('.', ',')} euro excl. btw wacht op antwoord`, href: 'offertes/' });
  }
  if (Roles.can(user, 'planning')) {
    const week = weekOf(today);
    const planned = db.prepare("SELECT COUNT(*) AS count, COUNT(DISTINCT assignee_id) AS staff FROM work_orders WHERE tenant_id = ? AND deleted_at IS NULL AND status IN ('gepland', 'bezig', 'gereed') AND planned_date >= ? AND planned_date <= ?").get(tenantId, week.from, week.to);
    tiles.push({ key: 'bezetting', title: 'Bezetting deze week', value: Number(planned.count), unit: 'aantal', detail: `werkorders ingepland, ${Number(planned.staff)} uitvoerder${Number(planned.staff) === 1 ? '' : 's'} (${week.from.slice(8)}-${week.to.slice(8)}/${week.to.slice(5, 7)})`, href: 'planning/' });
  }
  return tiles;
}

/**
 * Registreert `GET /api/kpis` (ingelogd; de tegels volgen de rechten van de gebruiker).
 * @param {object} app De Express-app.
 * @param {{ identify: Function, db: object }} ctx De identificatie van de server en de database.
 * @returns {void}
 */
function registerKpiRoutes(app, { identify, db }) {
  app.get('/api/kpis', (req, res) => {
    const user = identify(req);
    if (!user) return res.status(401).json({ error: 'not_logged_in', message: 'Log eerst in.' });
    if (!Roles.can(user, 'beheer')) return res.status(403).json({ error: 'forbidden', message: 'Alleen voor beheerders.' });
    res.set('Cache-Control', 'no-store');
    res.json({ kpis: buildKpis({ user, tenantId: req.tenantId }, { db }) });
  });
}

module.exports = { buildKpis, registerKpiRoutes, weekOf };
