// Catalogus van de kengetallen voor het beheerdersdashboard: elke vaste KPI met zijn module, recht, standaardstand en
// berekening, plus het schoonmaken van de instelling `dashboardKpis` (welke aan staan, in welke volgorde, welke periode).
// Een nieuwe KPI = één regel in CATALOG (met `compute`); Beheer en het dashboard volgen vanzelf.
const Roles = require('../../../frontend/shared/roles.js');
const QuoteCore = require('../../../frontend/offertes/quote-core.js');

/** De periodes voor KPI's die over een tijdvak gaan (`periodic`). */
const PERIODS = {
  week: 'Deze week',
  maand: 'Deze maand',
  '30dagen': 'Laatste 30 dagen',
  jaar: 'Dit jaar',
};
const DEFAULT_PERIOD = 'maand';

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
 * Geeft de eerste en laatste dag van een periode.
 * @param {string} period Sleutel uit PERIODS.
 * @param {string} today Vandaag als JJJJ-MM-DD.
 * @returns {{ from: string, to: string }} Eerste en laatste dag (de laatste dag telt mee).
 */
function rangeOf(period, today) {
  if (period === 'week') return weekOf(today);
  if (period === '30dagen') return { from: QuoteCore.addDays(today, -29), to: today };
  if (period === 'jaar') return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
  const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-${String(monthEnd).padStart(2, '0')}` };
}

/**
 * Maakt een bedrag leesbaar in nl-NL-opmaak, zoals de waarde van een tegel.
 * @param {number|string} amount Het bedrag.
 * @returns {string} Bijv. "€ 7.777,00".
 */
function euros(amount) {
  return `€ ${QuoteCore.round2(Number(amount)).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Kiest enkelvoud of meervoud.
 * @param {number} count Het aantal.
 * @param {string} one Enkelvoud.
 * @param {string} many Meervoud.
 * @returns {string} Het juiste woord.
 */
const plural = (count, one, many) => (Number(count) === 1 ? one : many);

/**
 * De vaste kengetallen. `module` = id uit modules.js (staat die uit, dan is de KPI niet beschikbaar), `right` = recht dat
 * de gebruiker naast `beheer` moet hebben, `periodic` = volgt de gekozen periode, `enabled` = standaard aan.
 * `compute` krijgt `{ db, tenantId, today, range, periodLabel }` en geeft `{ value, unit, detail }` terug (`unit` euro | aantal).
 */
const CATALOG = [
  {
    key: 'openstaand', title: 'Openstaand bedrag', description: 'Totaal van alle definitieve, nog niet betaalde facturen.', module: 'facturen', right: 'facturen', href: 'facturen/', enabled: true,
    compute: ({ db, tenantId }) => {
      const open = db.prepare("SELECT COALESCE(SUM(total), 0) AS amount, COUNT(*) AS count FROM invoices WHERE tenant_id = ? AND status = 'definitief'").get(tenantId);
      return { value: QuoteCore.round2(Number(open.amount)), unit: 'euro', detail: `${Number(open.count)} open ${plural(open.count, 'factuur', 'facturen')} (incl. btw)` };
    },
  },
  {
    key: 'vervallen', title: 'Vervallen facturen', description: 'Aantal definitieve facturen dat over de vervaldatum is.', module: 'facturen', right: 'facturen', href: 'facturen/', enabled: true,
    compute: ({ db, tenantId, today }) => {
      const overdue = db.prepare("SELECT COALESCE(SUM(total), 0) AS amount, COUNT(*) AS count FROM invoices WHERE tenant_id = ? AND status = 'definitief' AND kind = 'factuur' AND due_date < ?").get(tenantId, today);
      return { value: Number(overdue.count), unit: 'aantal', detail: `${euros(overdue.amount)} voorbij de vervaldatum` };
    },
  },
  {
    key: 'omzet', title: 'Gefactureerd', description: 'Omzet excl. btw van definitieve en betaalde facturen (credits afgetrokken) in de gekozen periode.', module: 'facturen', right: 'facturen', href: 'facturen/', periodic: true, enabled: true,
    compute: ({ db, tenantId, range, periodLabel }) => {
      const sum = db.prepare("SELECT COALESCE(SUM(subtotal), 0) AS amount, COUNT(*) AS count FROM invoices WHERE tenant_id = ? AND status IN ('definitief', 'betaald') AND invoice_date >= ? AND invoice_date <= ?").get(tenantId, range.from, range.to);
      return { value: QuoteCore.round2(Number(sum.amount)), unit: 'euro', detail: `excl. btw, ${Number(sum.count)} ${plural(sum.count, 'document', 'documenten')} (${periodLabel.toLowerCase()})` };
    },
  },
  {
    key: 'offertes', title: 'Open offertes', description: 'Verzonden offertes die nog op antwoord wachten.', module: 'offertes', right: 'offertes', href: 'offertes/', enabled: true,
    compute: ({ db, tenantId }) => {
      const quotes = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total_excl), 0) AS amount FROM quotes WHERE tenant_id = ? AND status = 'verzonden' AND deleted_at IS NULL").get(tenantId);
      return { value: Number(quotes.count), unit: 'aantal', detail: `${euros(quotes.amount)} excl. btw wacht op antwoord` };
    },
  },
  {
    key: 'offertes_akkoord', title: 'Geaccepteerde offertes', description: 'Offertes waarop de klant in de gekozen periode akkoord gaf.', module: 'offertes', right: 'offertes', href: 'offertes/', periodic: true,
    compute: ({ db, tenantId, range, periodLabel }) => {
      const quotes = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total_excl), 0) AS amount FROM quotes WHERE tenant_id = ? AND status = 'akkoord' AND deleted_at IS NULL AND responded_at >= ? AND responded_at < ?").get(tenantId, range.from, QuoteCore.addDays(range.to, 1));
      return { value: Number(quotes.count), unit: 'aantal', detail: `${euros(quotes.amount)} excl. btw (${periodLabel.toLowerCase()})` };
    },
  },
  {
    key: 'werkorders_open', title: 'Open werkorders', description: 'Werkorders die nog niet gereed of geannuleerd zijn.', module: 'werkorders', right: 'werkorders', href: 'werkorders/',
    compute: ({ db, tenantId }) => {
      const open = db.prepare("SELECT COUNT(*) AS count, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS unplanned FROM work_orders WHERE tenant_id = ? AND deleted_at IS NULL AND status IN ('open', 'gepland', 'bezig')").get(tenantId);
      return { value: Number(open.count), unit: 'aantal', detail: `${Number(open.unplanned || 0)} nog niet ingepland` };
    },
  },
  {
    key: 'webshop_nieuw', title: 'Te verzenden bestellingen', description: 'Webshopbestellingen met status Nieuw.', module: 'webshop-bestellingen', right: 'beheer', href: 'webshop-bestellingen/',
    compute: ({ db, tenantId }) => {
      const orders = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS amount FROM web_orders WHERE tenant_id = ? AND status = 'nieuw'").get(tenantId);
      return { value: Number(orders.count), unit: 'aantal', detail: `${euros(orders.amount)} incl. btw` };
    },
  },
  {
    key: 'webshop_omzet', title: 'Webshop-omzet', description: 'Totaal van de webshopbestellingen (zonder geannuleerde) in de gekozen periode.', module: 'webshop-bestellingen', right: 'beheer', href: 'webshop-bestellingen/', periodic: true,
    compute: ({ db, tenantId, range, periodLabel }) => {
      const orders = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS amount FROM web_orders WHERE tenant_id = ? AND status <> 'geannuleerd' AND created_at >= ? AND created_at < ?").get(tenantId, range.from, QuoteCore.addDays(range.to, 1));
      return { value: QuoteCore.round2(Number(orders.amount)), unit: 'euro', detail: `incl. btw, ${Number(orders.count)} ${plural(orders.count, 'bestelling', 'bestellingen')} (${periodLabel.toLowerCase()})` };
    },
  },
  {
    key: 'voorraad_minimum', title: 'Onder minimumvoorraad', description: 'Artikelen met een minimumvoorraad waarvan de voorraad daaronder zit.', module: 'voorraad', right: 'voorraad', href: 'artikelen/',
    compute: ({ db, tenantId }) => {
      const items = db.prepare('SELECT COUNT(*) AS count FROM stock_items WHERE tenant_id = ? AND archived = 0 AND has_variants = 0 AND stock_managed = 1 AND min_qty > 0 AND on_hand < min_qty').get(tenantId);
      return { value: Number(items.count), unit: 'aantal', detail: plural(items.count, 'artikel moet', 'artikelen moeten') + ' worden bijbesteld' };
    },
  },
  {
    key: 'inkooporders_open', title: 'Inkooporders onderweg', description: 'Bestelde en deels ontvangen inkooporders.', module: 'voorraad', right: 'voorraad', href: 'artikelen/#orders',
    compute: ({ db, tenantId }) => {
      const orders = db.prepare("SELECT COUNT(*) AS count FROM purchase_orders WHERE tenant_id = ? AND status IN ('besteld', 'deels_ontvangen')").get(tenantId);
      return { value: Number(orders.count), unit: 'aantal', detail: plural(orders.count, 'inkooporder wacht', 'inkooporders wachten') + ' op ontvangst' };
    },
  },
  {
    key: 'bezetting', title: 'Bezetting deze week', description: 'Ingeplande werkorders deze week en het aantal uitvoerders (voor later, standaard uit).', module: 'planning', right: 'planning', href: 'planning/',
    compute: ({ db, tenantId, today }) => {
      const week = weekOf(today);
      const planned = db.prepare("SELECT COUNT(*) AS count, COUNT(DISTINCT assignee_id) AS staff FROM work_orders WHERE tenant_id = ? AND deleted_at IS NULL AND status IN ('gepland', 'bezig', 'gereed') AND planned_date >= ? AND planned_date <= ?").get(tenantId, week.from, week.to);
      return { value: Number(planned.count), unit: 'aantal', detail: `werkorders ingepland, ${Number(planned.staff)} uitvoerder${Number(planned.staff) === 1 ? '' : 's'} (${week.from.slice(8)}-${week.to.slice(8)}/${week.to.slice(5, 7)})` };
    },
  },
];

const DEFAULT_SETTING = { items: CATALOG.map((entry) => ({ key: entry.key, enabled: Boolean(entry.enabled) })), period: DEFAULT_PERIOD };

/**
 * Maakt de instelling `dashboardKpis` schoon: onbekende sleutels vallen weg, dubbele ook; KPI's die ontbreken komen
 * achteraan met hun standaardstand (zo verschijnt een nieuwe KPI zonder dat de beheerder iets hoeft te doen).
 * @param {*} raw De ingevoerde of opgeslagen waarde ({ items: [{ key, enabled }], period }).
 * @returns {{ items: { key: string, enabled: boolean }[], period: string }} De schone instelling, altijd met alle KPI's.
 */
function sanitizeDashboardKpis(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const items = [];
  for (const entry of Array.isArray(source.items) ? source.items : []) {
    const known = entry && typeof entry === 'object' && CATALOG.find((candidate) => candidate.key === entry.key);
    if (!known || seen.has(known.key)) continue;
    seen.add(known.key);
    items.push({ key: known.key, enabled: typeof entry.enabled === 'boolean' ? entry.enabled : Boolean(known.enabled) });
  }
  for (const entry of CATALOG) if (!seen.has(entry.key)) items.push({ key: entry.key, enabled: Boolean(entry.enabled) });
  const period = Object.prototype.hasOwnProperty.call(PERIODS, source.period) ? source.period : DEFAULT_PERIOD;
  return { items, period };
}

/**
 * Bouwt de kengetallen voor een gebruiker en omgeving; alleen voor wie `beheer` heeft. Een KPI telt alleen mee als hij aan
 * staat, zijn module aan staat en de gebruiker het bijbehorende recht heeft. Volgorde = die van de instelling.
 * @param {{ user: object, tenantId: string }} viewer De gebruiker (met rechten) en de omgeving.
 * @param {{ db: object, today?: string, config?: object, isModuleOn?: Function }} sources De database, vaste datum (tests),
 *   de instelling `dashboardKpis` en een functie (module-id) → boolean.
 * @returns {{ key: string, title: string, value: number, unit: string, detail: string, href: string, period?: string }[]} De tegels.
 */
function buildKpis({ user, tenantId }, { db, today = QuoteCore.today(), config = DEFAULT_SETTING, isModuleOn = () => true }) {
  const tiles = [];
  if (!Roles.can(user, 'beheer')) return tiles;
  const setting = sanitizeDashboardKpis(config);
  const range = rangeOf(setting.period, today);
  for (const item of setting.items) {
    const entry = CATALOG.find((candidate) => candidate.key === item.key);
    if (!item.enabled || !isModuleOn(entry.module) || !Roles.can(user, entry.right)) continue;
    const result = entry.compute({ db, tenantId, today, range, periodLabel: PERIODS[setting.period] });
    tiles.push({ key: entry.key, title: entry.title, ...result, href: entry.href, ...(entry.periodic ? { period: PERIODS[setting.period] } : {}) });
  }
  return tiles;
}

/**
 * Beschrijft de catalogus voor het keuzescherm in Beheer: alle KPI's in de volgorde van de instelling, met of ze aan staan
 * en of hun module aan staat.
 * @param {object} config De instelling `dashboardKpis`.
 * @param {Function} isModuleOn Functie (module-id) → boolean.
 * @returns {{ items: object[], period: string, periods: object }} Items met key, title, description, enabled, available, periodic.
 */
function describeCatalog(config, isModuleOn = () => true) {
  const setting = sanitizeDashboardKpis(config);
  const items = setting.items.map((item) => {
    const entry = CATALOG.find((candidate) => candidate.key === item.key);
    return { key: entry.key, title: entry.title, description: entry.description, enabled: item.enabled, available: isModuleOn(entry.module), periodic: Boolean(entry.periodic) };
  });
  return { items, period: setting.period, periods: PERIODS };
}

module.exports = { CATALOG, PERIODS, DEFAULT_SETTING, sanitizeDashboardKpis, buildKpis, describeCatalog, weekOf, rangeOf, euros };
