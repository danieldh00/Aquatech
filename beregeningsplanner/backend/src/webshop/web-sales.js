// Verkopen van de eigen webshop voor de margerapportage (tabel web_sale_lines,
// migratie 45; Verkoop > Webshopbestellingen > Rapportage).
//
// - Per regel van een verzonden bestelling komt er een verkoopregel: omzet excl. btw
//   en de afboeking (movement_id, bron 'bestelling:<nummer>'). De inkoopwaarde komt uit de voorraadlagen
//   (stock_cost_entries van die afboeking, FIFO): de prijs waarvoor de artikelen
//   ooit zijn ingekocht, ook als de inkoopprijs daarna is gestegen.
// - Per afgeronde retour komt er een negatieve regel: de omzet gaat eraf, en als
//   de artikelen terug op voorraad gaan ook de inkoopwaarde (tegen dezelfde prijs).
//   Gaan ze niet terug (beschadigd), dan blijft de inkoopwaarde staan.
// - Geen bekende inkoopprijs: dat deel telt als "inkoop onbekend" en gaat niet mee
//   in de marge (er wordt niets geraden).
// - De regels worden bij elke rapportage aangevuld (sync): bestellingen en retouren
//   die er nog niet in staan komen erbij, met het moment van verzenden of afronden
//   uit hun verloop. Zo hoeven bestellingen en retouren zelf niets te weten van de
//   rapportage. Van bestellingen die al verzonden waren vóór migratie 45 is de
//   inkoopwaarde onbekend (er waren toen nog geen voorraadlagen).
// - Omzet = artikelen excl. btw; verzendkosten tellen niet mee.
const crypto = require('crypto');
const { transaction } = require('../database/db');
const { categoryNameOf } = require('./storefront-data');

/** Tijdzone voor de dagen in de rapportage. */
const TIME_ZONE = 'Europe/Amsterdam';
/** Langste periode die de rapportage in één keer toont (dagen). */
const MAX_DAYS = 3 * 366;
/** Hoeveel verkoopregels de rapportage hoogstens leest. */
const MAX_LINES = 50000;
/** Zoveel artikel-id's per query (IN-lijst). */
const CHUNK = 500;
/** Statussen van een bestelling waarbij de artikelen zijn afgeboekt. */
const SHIPPED = ['verzonden', 'afgerond'];
/** Indeling van de grafiek. */
const INTERVALS = ['day', 'week', 'month'];

/**
 * Afronden op twee decimalen.
 * @param {*} value Het bedrag.
 * @returns {number} Het afgeronde bedrag.
 */
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
/**
 * Afronden op drie decimalen (aantallen).
 * @param {*} value Het aantal.
 * @returns {number} Het afgeronde aantal.
 */
const round3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;
/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * Een reeks vraagtekens voor een IN-lijst.
 * @param {number} count Aantal.
 * @returns {string} Bijv. '?,?,?'.
 */
const placeholders = (count) => Array.from({ length: count }, () => '?').join(',');
/**
 * Marge als percentage van de omzet.
 * @param {number} margin De marge.
 * @param {number} revenue De omzet (met bekende inkoop).
 * @returns {number|null} Het percentage (één decimaal), of null zonder omzet.
 */
const marginPct = (margin, revenue) => (Math.abs(revenue) > 0.004 ? Math.round((margin / revenue) * 1000) / 10 : null);

const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
/**
 * De datum in Nederland van een tijdstip.
 * @param {string} iso Tijdstip als ISO-tekst.
 * @returns {string} Bijv. '2026-11-05'.
 */
const localDate = (iso) => dateFormat.format(new Date(iso));
/**
 * Is dit een bestaande datum als JJJJ-MM-DD?
 * @param {*} value De invoer.
 * @returns {boolean} true als het klopt.
 */
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
/**
 * Telt dagen op bij een datum.
 * @param {string} date Datum (JJJJ-MM-DD).
 * @param {number} days Aantal dagen (mag negatief).
 * @returns {string} De nieuwe datum.
 */
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
/**
 * Aantal dagen van de ene datum tot de andere.
 * @param {string} from Begindatum.
 * @param {string} to Einddatum.
 * @returns {number} Het verschil in dagen.
 */
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/**
 * Het begin van de periode in de grafiek waar een datum in valt.
 * @param {string} date Datum (JJJJ-MM-DD).
 * @param {string} interval 'day', 'week' (maandag) of 'month'.
 * @returns {string} De begindatum van die dag, week of maand.
 */
function bucketOf(date, interval) {
  if (interval === 'month') return `${date.slice(0, 7)}-01`;
  if (interval === 'week') {
    const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
    return addDays(date, -weekday);
  }
  return date;
}

/**
 * Alle perioden van de grafiek tussen twee datums (ook die zonder verkoop).
 * @param {string} from Begindatum.
 * @param {string} to Einddatum.
 * @param {string} interval 'day', 'week' of 'month'.
 * @returns {string[]} De begindatums.
 */
function bucketsBetween(from, to, interval) {
  const out = [];
  let current = bucketOf(from, interval);
  while (current <= to && out.length < 2000) {
    out.push(current);
    current = interval === 'month' ? `${new Date(Date.UTC(Number(current.slice(0, 4)), Number(current.slice(5, 7)), 1)).toISOString().slice(0, 10)}`
      : addDays(current, interval === 'week' ? 7 : 1);
  }
  return out;
}

/**
 * Controleert de gevraagde periode en kiest de indeling van de grafiek.
 * @param {{ from?: string, to?: string, interval?: string }} query De invoer (datums als JJJJ-MM-DD).
 * @returns {{ from?: string, to?: string, interval?: string, error?: string }} De periode, of een foutmelding.
 */
function periodOf(query) {
  const input = query && typeof query === 'object' ? query : {};
  const todayDate = localDate(currentTimestamp());
  const to = input.to ? String(input.to) : todayDate;
  const from = input.from ? String(input.from) : `${to.slice(0, 4)}-01-01`;
  if (!isDate(from) || !isDate(to)) return { error: 'Kies een geldige periode.' };
  if (from > to) return { error: 'De begindatum ligt na de einddatum.' };
  if (daysBetween(from, to) > MAX_DAYS) return { error: 'Kies een periode van hooguit drie jaar.' };
  const days = daysBetween(from, to) + 1;
  const interval = INTERVALS.includes(input.interval) ? input.interval : days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
  return { from, to, interval };
}

/**
 * Het aantal in de basiseenheid van het artikel: een regel in dozen of pallets telt de factor mee (voorraad en kostprijs staan in de basiseenheid).
 * @param {{ qty: number, stockPer?: number }} line De regel.
 * @returns {number} Het aantal basiseenheden.
 */
const baseQtyOf = (line) => Number(line.qty) * (Number(line.stockPer) > 1 ? Number(line.stockPer) : 1);

/**
 * Voegt regels van hetzelfde artikel samen (stuks en een pallet): de voorraadmutatie is één afboeking per artikel, dus de kosten mogen maar één keer meetellen.
 * @param {{ itemId: string, code: string, name: string, qty: number, revenue: number }[]} lines De regels (aantal in de basiseenheid).
 * @returns {{ itemId: string, code: string, name: string, qty: number, revenue: number }[]} Eén regel per artikel, in volgorde van het eerste voorkomen.
 */
function mergePerItem(lines) {
  const merged = new Map();
  for (const line of lines) {
    const known = merged.get(line.itemId);
    if (known) { known.qty += line.qty; known.revenue = round2(known.revenue + line.revenue); } else merged.set(line.itemId, { ...line });
  }
  return [...merged.values()];
}

/**
 * Omzet excl. btw van een regel van een bestelling.
 * @param {{ qty: number, unitExcl: number, lineExcl?: number }} line De regel.
 * @param {number} [qty] Aantal (bij een retour het teruggestuurde aantal).
 * @returns {number} Het bedrag excl. btw.
 */
const revenueOf = (line, qty = line.qty) => (line.lineExcl !== undefined && qty === line.qty ? round2(line.lineExcl) : round2(Number(line.unitExcl) * qty));

/**
 * Maakt de opslag en de rapportage van de webshopverkopen.
 * @param {object} db De database (SQLite of PostgreSQL).
 * @param {{ stock?: object }} [deps] Voorraad (stock.js) voor de voorraadwaarde.
 * @returns {object} sync en report.
 */
function createWebSalesStore(db, { stock = null } = {}) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Schrijft verkoopregels weg (binnen de transactie van de aanroeper).
   * De deterministische id gebruikt de bestaande primaire sleutel als unieke
   * constraint: gelijktijdige synchronisaties slaan dezelfde regel eenmaal op.
   * @param {string} tenantId Id van de omgeving.
   * @param {object[]} rows Regels met id, kind, soldAt, orderId, reference, itemId, code, name, qty, revenue en movementId.
   * @returns {number} Aantal toegevoegde regels.
   */
  function insertLines(tenantId, rows) {
    const insert = prepare(`INSERT INTO web_sale_lines (id, tenant_id, kind, sold_at, order_id, reference, item_id, code, name, qty, revenue, movement_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`);
    const at = currentTimestamp();
    let added = 0;
    for (const row of rows) {
      added += insert.run(row.id, tenantId, row.kind, row.soldAt, row.orderId, row.reference, row.itemId || null, String(row.code || '').slice(0, 60),
        String(row.name || '').slice(0, 200), round3(row.qty), round2(row.revenue), row.movementId || null, at).changes;
    }
    return added;
  }

  /**
   * Legt de verkoop van een verzonden bestelling vast.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, number: string }} order De bestelling.
   * @param {object[]} lines De regels van de bestelling (itemId, code, name, qty, unitExcl, lineExcl).
   * @param {Map<string, string>} movementIds Per artikel-id de afboeking.
   * @param {string} soldAt Moment van verzenden.
   * @returns {number} Aantal toegevoegde regels.
   */
  function recordShipment(tenantId, order, lines, movementIds, soldAt) {
    return insertLines(tenantId, mergePerItem(lines.map((line) => ({
      itemId: line.itemId, code: line.baseCode || line.code, name: line.name, qty: baseQtyOf(line), revenue: revenueOf(line),
    }))).map((line, index) => ({
      id: crypto.createHash('sha256').update(JSON.stringify([tenantId, 'verkoop', order.id, index])).digest('hex'),
      kind: 'verkoop', soldAt, orderId: order.id, reference: order.number, itemId: line.itemId, code: line.code, name: line.name,
      qty: line.qty, revenue: line.revenue, movementId: movementIds.get(line.itemId) || null,
    })));
  }

  /**
   * Legt een afgeronde retour vast als negatieve verkoop.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ number: string, orderId: string }} record De retour.
   * @param {object[]} lines De teruggestuurde regels (itemId, code, name, qty, unitExcl).
   * @param {Map<string, string>} movementIds Per artikel-id de terugboeking op voorraad (leeg = niet terug op voorraad).
   * @param {string} soldAt Moment van afronden.
   * @returns {number} Aantal toegevoegde regels.
   */
  function recordReturn(tenantId, record, lines, movementIds, soldAt) {
    return insertLines(tenantId, mergePerItem(lines.map((line) => ({
      itemId: line.itemId, code: line.baseCode || line.code, name: line.name, qty: baseQtyOf(line), revenue: round2(Number(line.unitExcl) * line.qty),
    }))).map((line, index) => ({
      id: crypto.createHash('sha256').update(JSON.stringify([tenantId, 'retour', record.orderId, record.number, index])).digest('hex'),
      kind: 'retour', soldAt, orderId: record.orderId, reference: record.number, itemId: line.itemId, code: line.code, name: line.name,
      qty: -line.qty, revenue: -line.revenue, movementId: movementIds.get(line.itemId) || null,
    })));
  }

  /**
   * Vult de verkoopregels aan met verzonden bestellingen en afgeronde retouren die er
   * nog niet in staan (één keer per bestelling of retour). De afboeking wordt
   * opgezocht op bron en artikel. Twee queries als er niets nieuws is.
   * @param {string} tenantId Id van de omgeving.
   * @returns {number} Aantal toegevoegde regels.
   */
  function sync(tenantId) {
    const orders = prepare(`SELECT o.id, o.number, o.data FROM web_orders o
      WHERE o.tenant_id = ? AND o.status IN (${placeholders(SHIPPED.length)})
        AND NOT EXISTS (SELECT 1 FROM web_sale_lines l WHERE l.tenant_id = o.tenant_id AND l.order_id = o.id AND l.kind = 'verkoop')`).all(tenantId, ...SHIPPED);
    const returns = prepare(`SELECT r.number, r.order_id, r.data, r.updated_at FROM web_returns r
      WHERE r.tenant_id = ? AND r.status = 'afgerond'
        AND NOT EXISTS (SELECT 1 FROM web_sale_lines l WHERE l.tenant_id = r.tenant_id AND l.order_id = r.order_id AND l.kind = 'retour' AND l.reference = r.number)`).all(tenantId);
    if (!orders.length && !returns.length) return 0;
    const sources = [...orders.map((order) => `bestelling:${order.number}`), ...returns.map((record) => `retour:${record.number}`)];
    const movementOf = new Map();
    for (let index = 0; index < sources.length; index += CHUNK) {
      const part = sources.slice(index, index + CHUNK);
      for (const row of prepare(`SELECT id, item_id, source FROM stock_movements WHERE tenant_id = ? AND source IN (${placeholders(part.length)})`).all(tenantId, ...part)) {
        movementOf.set(`${row.source}|${row.item_id}`, row.id);
      }
    }
    /**
     * De afboekingen van één bron per artikel.
     * @param {string} source De bron, bijv. 'bestelling:W2026-0001'.
     * @param {object[]} lines De regels (itemId).
     * @returns {Map<string, string>} Per artikel-id de mutatie.
     */
    const movementsFor = (source, lines) => new Map(lines.filter((line) => movementOf.has(`${source}|${line.itemId}`)).map((line) => [line.itemId, movementOf.get(`${source}|${line.itemId}`)]));
    let added = 0;
    for (const order of orders) {
      const data = JSON.parse(order.data);
      const shipped = (data.history || []).find((entry) => entry.status === 'verzonden');
      const lines = data.lines || [];
      added += recordShipment(tenantId, order, lines, movementsFor(`bestelling:${order.number}`, lines), shipped ? shipped.at : currentTimestamp());
    }
    for (const record of returns) {
      const data = JSON.parse(record.data);
      const lines = data.lines || [];
      const completed = (data.history || []).find((entry) => entry.status === 'afgerond');
      added += recordReturn(tenantId, { number: record.number, orderId: record.order_id }, lines, data.restock ? movementsFor(`retour:${record.number}`, lines) : new Map(), completed ? completed.at : record.updated_at);
    }
    return added;
  }

  /**
   * De categorie in de webshop per artikel (een variant zonder eigen categorie krijgt die van zijn hoofdartikel).
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} itemIds De artikelen.
   * @returns {Map<string, string>} Per artikel-id de categorienaam.
   */
  function categoriesOf(tenantId, itemIds) {
    const out = new Map();
    for (let index = 0; index < itemIds.length; index += CHUNK) {
      const part = itemIds.slice(index, index + CHUNK);
      const rows = prepare(`SELECT i.id, own.categories AS own_categories, parent_product.categories AS parent_categories
        FROM stock_items i
        LEFT JOIN shop_products own ON own.tenant_id = i.tenant_id AND own.id = i.shop_product_id
        LEFT JOIN stock_items parent ON parent.tenant_id = i.tenant_id AND parent.id = i.parent_id
        LEFT JOIN shop_products parent_product ON parent_product.tenant_id = i.tenant_id AND parent_product.id = parent.shop_product_id
        WHERE i.tenant_id = ? AND i.id IN (${placeholders(part.length)})`).all(tenantId, ...part);
      for (const row of rows) {
        const own = categoryNameOf(row.own_categories);
        out.set(row.id, own !== categoryNameOf('[]') || !row.parent_categories ? own : categoryNameOf(row.parent_categories));
      }
    }
    return out;
  }

  /**
   * Telt verkoopregels op tot omzet, inkoop en marge. De marge rekent alleen met de
   * omzet waarvan de inkoop bekend is; de rest staat apart als onbekend.
   * @returns {object} Een lege optelling.
   */
  const emptySum = () => ({ revenue: 0, cost: 0, knownRevenue: 0, qty: 0, unknownQty: 0, unknownRevenue: 0 });
  /**
   * Telt één regel bij een optelling.
   * @param {object} sum De optelling (emptySum).
   * @param {object} line De regel (revenue, cost, qty, unknownQty, knownShare).
   * @returns {void}
   */
  const addTo = (sum, line) => {
    sum.revenue += line.revenue;
    sum.cost += line.cost;
    sum.qty += line.qty;
    sum.unknownQty += line.unknownQty;
    sum.knownRevenue += line.revenue * line.knownShare;
    sum.unknownRevenue += line.revenue * (1 - line.knownShare);
  };
  /**
   * Maakt van een optelling de getallen voor de API.
   * @param {object} sum De optelling.
   * @returns {{ revenue: number, cost: number, margin: number, marginPct: ?number, qty: number, unknownQty: number, unknownRevenue: number }} Afgeronde bedragen.
   */
  const finish = (sum) => {
    const margin = round2(sum.knownRevenue - sum.cost);
    return {
      revenue: round2(sum.revenue), cost: round2(sum.cost), margin, marginPct: marginPct(margin, sum.knownRevenue), qty: round3(sum.qty),
      unknownQty: round3(sum.unknownQty), unknownRevenue: round2(sum.unknownRevenue),
    };
  };

  /**
   * De margerapportage over een periode: totalen, verloop per dag/week/maand, per
   * artikel en per categorie, en de voorraadwaarde volgens de lagen.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ from?: string, to?: string, interval?: string, lines?: boolean }} query Periode (standaard dit jaar), indeling en of de losse regels mee moeten (Excel).
   * @returns {object} { from, to, interval, totals, series, items, categories, stock, lines? }, of { error }.
   */
  function report(tenantId, query = {}) {
    const period = periodOf(query);
    if (period.error) return period;
    transaction(db, () => sync(tenantId));
    // Ruim ophalen in UTC en daarna op de Nederlandse datum filteren.
    const rows = prepare(`SELECT l.id, l.kind, l.sold_at, l.order_id, l.reference, l.item_id, l.code, l.name, l.qty, l.revenue, l.movement_id,
        SUM(CASE WHEN e.unit_cost IS NULL THEN 0 ELSE -e.qty * e.unit_cost END) AS cost,
        SUM(CASE WHEN e.unit_cost IS NULL THEN 0 ELSE e.qty END) AS known_qty
      FROM web_sale_lines l
      LEFT JOIN stock_cost_entries e ON e.tenant_id = l.tenant_id AND e.movement_id = l.movement_id
      WHERE l.tenant_id = ? AND l.sold_at >= ? AND l.sold_at < ?
      GROUP BY l.id, l.kind, l.sold_at, l.order_id, l.reference, l.item_id, l.code, l.name, l.qty, l.revenue, l.movement_id
      ORDER BY l.sold_at, l.reference
      LIMIT ${MAX_LINES}`).all(tenantId, `${addDays(period.from, -1)}T00:00:00.000Z`, `${addDays(period.to, 2)}T00:00:00.000Z`);
    const lines = [];
    for (const row of rows) {
      const date = localDate(row.sold_at);
      if (date < period.from || date > period.to) continue;
      const qty = Number(row.qty);
      // Zonder mutatie (retour niet terug op voorraad) verandert de inkoop niet.
      const knownQty = row.movement_id ? Math.min(Math.abs(qty), Math.abs(Number(row.known_qty) || 0)) : Math.abs(qty);
      const unknownQty = round3(Math.abs(qty) - knownQty);
      const knownShare = Math.abs(qty) > 0 ? knownQty / Math.abs(qty) : 1;
      lines.push({
        kind: row.kind, date, soldAt: row.sold_at, orderId: row.order_id, reference: row.reference, itemId: row.item_id, code: row.code, name: row.name,
        qty: round3(qty), revenue: Number(row.revenue), cost: round2(row.movement_id ? Number(row.cost) || 0 : 0), unknownQty: qty < 0 ? -unknownQty : unknownQty, knownShare,
      });
    }
    const categoryOf = categoriesOf(tenantId, [...new Set(lines.map((line) => line.itemId).filter(Boolean))]);
    const total = emptySum();
    const buckets = new Map(bucketsBetween(period.from, period.to, period.interval).map((start) => [start, emptySum()]));
    const byItem = new Map();
    const byCategory = new Map();
    const orders = new Set();
    let returns = 0;
    for (const line of lines) {
      line.category = categoryOf.get(line.itemId) || categoryNameOf('[]');
      addTo(total, line);
      const bucket = buckets.get(bucketOf(line.date, period.interval));
      if (bucket) addTo(bucket, line);
      const itemKey = line.itemId || line.code;
      if (!byItem.has(itemKey)) byItem.set(itemKey, { itemId: line.itemId, code: line.code, name: line.name, category: line.category, sum: emptySum() });
      addTo(byItem.get(itemKey).sum, line);
      if (!byCategory.has(line.category)) byCategory.set(line.category, emptySum());
      addTo(byCategory.get(line.category), line);
      if (line.kind === 'verkoop') orders.add(line.orderId); else returns++;
    }
    /**
     * Sorteert op marge (hoogste eerst), daarna op omzet.
     * @param {object} left Eerste.
     * @param {object} right Tweede.
     * @returns {number} De volgorde.
     */
    const byMargin = (left, right) => right.margin - left.margin || right.revenue - left.revenue;
    const out = {
      from: period.from, to: period.to, interval: period.interval,
      totals: { ...finish(total), orders: orders.size, returnLines: returns, lines: lines.length },
      series: [...buckets.entries()].map(([start, sum]) => ({ start, ...finish(sum) })),
      items: [...byItem.values()].map((entry) => ({ itemId: entry.itemId, code: entry.code, name: entry.name, category: entry.category, ...finish(entry.sum) })).sort(byMargin),
      categories: [...byCategory.entries()].map(([name, sum]) => ({ name, ...finish(sum) })).sort(byMargin),
      stock: stock ? stock.stockValue(tenantId) : null,
      truncated: rows.length >= MAX_LINES,
    };
    if (query.lines) {
      out.lines = lines.map((line) => ({
        kind: line.kind, date: line.date, reference: line.reference, code: line.code, name: line.name, category: line.category, qty: line.qty,
        revenue: round2(line.revenue), cost: line.cost, margin: line.unknownQty ? null : round2(line.revenue - line.cost), unknownQty: line.unknownQty,
      }));
    }
    return out;
  }

  return { sync, report };
}

/**
 * API-route van de rapportage (onder /api/admin, dus alleen voor beheerders).
 * @param {object} app De Express-app.
 * @param {{ sales: object }} ctx De opslag (createWebSalesStore).
 * @returns {void}
 */
function registerWebSalesRoutes(app, { sales }) {
  app.get('/api/admin/webshop-report', (req, res) => {
    const out = sales.report(req.tenantId, {
      from: req.query.from ? String(req.query.from) : '', to: req.query.to ? String(req.query.to) : '',
      interval: req.query.interval ? String(req.query.interval) : '', lines: req.query.lines === '1',
    });
    if (out.error) return res.status(400).json({ error: 'invalid', message: out.error });
    res.json(out);
  });
}

module.exports = { createWebSalesStore, registerWebSalesRoutes, periodOf, bucketOf, bucketsBetween, revenueOf };
