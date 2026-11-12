// Prijsfactor op de inkoopprijs (punt 19): de verkoopprijs (excl. btw) van een artikel is de inkoopprijs maal een factor,
// afgerond volgens een instelbare regel. De factor komt van het meest specifieke niveau dat er een heeft:
//   artikel (eigen factor) > voorkeursleverancier > categorie van de webshop (de diepste met een factor) > standaard.
// Per artikel kies je tussen een vaste prijs (zoals altijd) en prijs volgens factor. Wijzigt de inkoopprijs, dan blijft de
// verkoopprijs staan tot de beheerder de herberekening doorvoert; die toont eerst een voorbeeld (oude en nieuwe prijs, marge).
// Alleen bij het opslaan van een artikel waarvan modus, factor of inkoopprijs verandert, wordt de prijs meteen berekend.
// Kortingen voor zakelijke klanten (category-discounts.js) rekenen over de uitkomst; verpakkingen zonder eigen prijs volgen
// de stukprijs. De instelling `priceFactors` bewaart standaardfactor, afronding en de factoren per categorie en leverancier.
const { placeIn } = require('../webshop/category-tree');
const { categoryNamesOf } = require('../webshop/storefront-data');
const { flatten } = require('../webshop/category-discounts');

/** Laagste en hoogste toegestane factor (de verkoopprijs is inkoopprijs × factor). */
const MIN_FACTOR = 0.1;
const MAX_FACTOR = 50;
/** Hoogste aantal regels per lijst (categorieën, leveranciers). */
const MAX_RULES = 300;
/** De afrondingsregels: stap in centen, of een eindgetal (x.95, x.99). */
const ROUNDING_MODES = {
  cent: { label: 'Op de cent', step: 1 },
  '0.05': { label: 'Op 5 cent', step: 5 },
  '0.10': { label: 'Op 10 cent', step: 10 },
  '0.50': { label: 'Op 50 cent', step: 50 },
  '1.00': { label: 'Op hele euro\'s', step: 100 },
  'x.95': { label: 'Eindigend op ,95', ending: 95 },
  'x.99': { label: 'Eindigend op ,99', ending: 99 },
};
const DIRECTIONS = ['dichtstbij', 'omhoog'];
const DEFAULT_ROUNDING = { mode: 'cent', direction: 'dichtstbij' };

/**
 * Rondt een factor af op vier decimalen en controleert de grenzen.
 * @param {*} value De invoer.
 * @returns {number|null} De factor, of null als het geen getal tussen MIN_FACTOR en MAX_FACTOR is.
 */
function cleanFactor(value) {
  if (value === '' || value == null) return null;
  const factor = Math.round(Number(value) * 10000) / 10000;
  return Number.isFinite(factor) && factor >= MIN_FACTOR && factor <= MAX_FACTOR ? factor : null;
}

/**
 * Maakt van de opgeslagen of ingevoerde instelling een nette instelling: ongeldige regels en dubbelen vallen weg.
 * @param {*} raw { defaultFactor, rounding: { mode, direction }, categories: [{ categorySlug, factor }], suppliers: [{ supplierId, factor }] }.
 * @returns {{ defaultFactor: ?number, rounding: { mode: string, direction: string }, categories: object[], suppliers: object[] }} De opgeschoonde instelling.
 */
function sanitizePriceFactors(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rounding = input.rounding && typeof input.rounding === 'object' ? input.rounding : {};
  const mode = ROUNDING_MODES[rounding.mode] ? rounding.mode : DEFAULT_ROUNDING.mode;
  const direction = DIRECTIONS.includes(rounding.direction) ? rounding.direction : DEFAULT_ROUNDING.direction;
  /**
   * Maakt een lijst met één factor per sleutel.
   * @param {*} list De ruwe lijst.
   * @param {string} key De naam van het sleutelveld.
   * @returns {object[]} Regels met sleutel en factor, op sleutel gesorteerd.
   */
  const rulesOf = (list, key) => {
    const byKey = new Map();
    for (const entry of (Array.isArray(list) ? list : []).slice(0, MAX_RULES)) {
      const name = String(entry && entry[key] != null ? entry[key] : '').trim().slice(0, 120);
      const factor = cleanFactor(entry && entry.factor);
      if (name && factor !== null) byKey.set(name, factor);
    }
    return [...byKey].map(([name, factor]) => ({ [key]: name, factor })).sort((left, right) => left[key].localeCompare(right[key]));
  };
  return { defaultFactor: cleanFactor(input.defaultFactor), rounding: { mode, direction }, categories: rulesOf(input.categories, 'categorySlug'), suppliers: rulesOf(input.suppliers, 'supplierId') };
}

/**
 * Controleert een invoer van de beheerder streng, met een melding per fout.
 * @param {*} raw De invoer.
 * @param {Set<string>} knownSlugs De categorieën van het menu.
 * @param {Set<string>} knownSuppliers De id's van de leveranciers van de omgeving.
 * @returns {string} Een melding in gewone taal, of een lege tekst als alles klopt.
 */
function check(raw, knownSlugs, knownSuppliers) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Ongeldige instelling.';
  const range = `Een factor is een getal van ${MIN_FACTOR} tot en met ${MAX_FACTOR}.`;
  if (raw.defaultFactor !== '' && raw.defaultFactor != null && cleanFactor(raw.defaultFactor) === null) return range;
  if (raw.rounding && (!ROUNDING_MODES[raw.rounding.mode] || !DIRECTIONS.includes(raw.rounding.direction))) return 'Kies een geldige afrondingsregel.';
  for (const [list, key, known, unknown] of [
    [raw.categories, 'categorySlug', knownSlugs, 'Een gekozen categorie staat niet (meer) in het menu van de webshop.'],
    [raw.suppliers, 'supplierId', knownSuppliers, 'Een gekozen leverancier bestaat niet (meer).'],
  ]) {
    if (list == null) continue;
    if (!Array.isArray(list) || list.length > MAX_RULES) return 'Ongeldige lijst met factoren.';
    const seen = new Set();
    for (const entry of list) {
      const name = String(entry && entry[key] != null ? entry[key] : '');
      if (!known.has(name)) return unknown;
      if (seen.has(name)) return 'Een categorie of leverancier komt twee keer voor.';
      seen.add(name);
      if (cleanFactor(entry.factor) === null) return range;
    }
  }
  return '';
}

/**
 * Rondt een prijs af volgens de regel.
 * @param {number} price De prijs, excl. btw.
 * @param {{ mode: string, direction: string }} [rounding] De regel (standaard: op de cent).
 * @returns {number} De afgeronde prijs in euro's; nooit lager dan de kleinste stap (een prijs boven 0 wordt niet 0).
 */
function roundPrice(price, rounding = DEFAULT_ROUNDING) {
  const rule = ROUNDING_MODES[rounding.mode] || ROUNDING_MODES.cent;
  const up = rounding.direction === 'omhoog';
  // Rekenen in hele centen voorkomt drijvendekommafouten (1,15 × 100 = 114,99999…).
  const cents = Math.round(Number(price) * 100 + 1e-7);
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  if (rule.step) {
    const steps = up ? Math.ceil((cents - 1e-9) / rule.step) : Math.round(cents / rule.step);
    return Math.max(rule.step, steps * rule.step) / 100;
  }
  // Eindgetal: de dichtstbijzijnde (of eerstvolgende hogere) prijs die op ,95 of ,99 eindigt.
  const low = Math.floor((cents - rule.ending) / 100) * 100 + rule.ending;
  const high = low === cents ? cents : low + 100;
  if (low <= 0) return high / 100;
  if (up) return high / 100;
  return (cents - low <= high - cents ? low : high) / 100;
}

/**
 * Bepaalt welke factor geldt: artikel, dan voorkeursleverancier, dan de categorie, dan de standaard.
 * @param {{ itemFactor?: ?number, supplierId?: ?string, categoryFactor?: ?number }} levels De factor per niveau (leeg = niet ingesteld).
 * @param {{ defaultFactor: ?number, suppliers: { supplierId: string, factor: number }[] }} config De instelling.
 * @returns {{ factor: number, source: string }|null} De factor met de bron (artikel, leverancier, categorie of standaard); null zonder factor.
 */
function resolveFactor(levels, config) {
  if (levels.itemFactor != null) return { factor: Number(levels.itemFactor), source: 'artikel' };
  const supplierRule = levels.supplierId ? config.suppliers.find((rule) => rule.supplierId === levels.supplierId) : null;
  if (supplierRule) return { factor: supplierRule.factor, source: 'leverancier' };
  if (levels.categoryFactor != null) return { factor: levels.categoryFactor, source: 'categorie' };
  if (config.defaultFactor != null) return { factor: config.defaultFactor, source: 'standaard' };
  return null;
}

/**
 * Berekent de verkoopprijs uit inkoopprijs en factor.
 * @param {*} costPrice De inkoopprijs (excl. btw).
 * @param {number} factor De factor.
 * @param {{ mode: string, direction: string }} rounding De afrondingsregel.
 * @returns {number|null} De prijs, of null zonder inkoopprijs boven 0.
 */
function priceFrom(costPrice, factor, rounding) {
  const cost = Number(costPrice);
  if (costPrice == null || !Number.isFinite(cost) || cost <= 0) return null;
  return roundPrice(cost * factor, rounding);
}

/**
 * De marge als percentage van de verkoopprijs.
 * @param {*} salePrice De verkoopprijs (excl. btw).
 * @param {*} costPrice De inkoopprijs.
 * @returns {number|null} Marge in procenten met één decimaal; null als een van beide ontbreekt of de verkoopprijs 0 is.
 */
function marginPct(salePrice, costPrice) {
  if (salePrice == null || costPrice == null) return null;
  const sale = Number(salePrice);
  const cost = Number(costPrice);
  if (!(sale > 0) || !Number.isFinite(cost)) return null;
  return Math.round(((sale - cost) / sale) * 1000) / 10;
}

/** De kolommen en koppelingen die de herberekening van een artikel nodig heeft; parameter: de omgeving, daarna volgen de extra voorwaarden met AND. */
const ROWS_SQL = `SELECT i.id, i.code, i.name, i.unit, i.cost_price, i.sale_price, i.price_mode, i.price_factor, i.shop_sync, i.shop_product_id,
    COALESCE(p.categories, pp.categories) AS categories,
    (SELECT l.supplier_id FROM item_suppliers l JOIN suppliers s ON s.tenant_id = l.tenant_id AND s.id = l.supplier_id
      WHERE l.tenant_id = i.tenant_id AND l.item_id = i.id AND l.preferred = 1 AND s.archived = 0 LIMIT 1) AS supplier_id
  FROM stock_items i
  LEFT JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id
  LEFT JOIN stock_items parent ON parent.tenant_id = i.tenant_id AND parent.id = i.parent_id
  LEFT JOIN shop_products pp ON pp.tenant_id = i.tenant_id AND pp.id = parent.shop_product_id
  WHERE i.tenant_id = ?`;

/**
 * Maakt de opslaglaag voor de prijsfactor.
 * @param {object} db De database.
 * @param {{ stock: object, settingsOf: Function, treeOf: Function }} ctx stock = voorraadopslag (setSalePrices), settingsOf(tenantId) = de instellingen van de omgeving,
 *   treeOf(tenantId) = de categorieboom van de webshop van de omgeving.
 * @returns {object} configOf, saveConfig, view, preview, apply en priceFor.
 */
function createPriceFactorStore(db, { stock, settingsOf, treeOf }) {
  /**
   * De instelling van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} De opgeschoonde instelling.
   */
  const configOf = (tenantId) => sanitizePriceFactors(settingsOf(tenantId).get('priceFactors'));

  /**
   * Maakt een functie die bij een categorie (slug in de boom) de factor geeft: die van de categorie zelf, anders van de
   * dichtstbijzijnde bovenliggende categorie met een factor.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} config De instelling.
   * @returns {{ categoryFactorOf: Function, slugOf: Function }} categoryFactorOf(slug) en slugOf(categoriesJson) = de diepste categorie in de boom.
   */
  function categoryLookup(tenantId, config) {
    const tree = treeOf(tenantId);
    const factorOf = new Map(config.categories.map((rule) => [rule.categorySlug, rule.factor]));
    const parentOf = new Map(flatten(tree).map((node) => [node.slug, node.parentSlug]));
    /**
     * De diepste categorie van de boom waar een webshopproduct onder valt.
     * @param {*} categoriesJson Het JSON-veld met categorienamen van het webshopproduct.
     * @returns {string|null} De slug, of null zonder passende categorie (of zonder factoren per categorie).
     */
    const slugOf = (categoriesJson) => {
      const place = factorOf.size ? placeIn(tree, categoryNamesOf(categoriesJson)) : null;
      return place && !place.root ? place.node.slug : null;
    };
    /**
     * De factor van een categorie, of van de dichtstbijzijnde bovenliggende met een factor.
     * @param {?string} slug De categorie.
     * @returns {number|null} De factor, of null als er geen is.
     */
    const categoryFactorOf = (slug) => {
      // De teller beschermt tegen een lus in een kapotte boom (de boom heeft hoogstens vijf niveaus).
      for (let current = slug, steps = 0; current && parentOf.has(current) && steps < 12; current = parentOf.get(current), steps += 1) {
        if (factorOf.has(current)) return factorOf.get(current);
      }
      return null;
    };
    return { categoryFactorOf, slugOf };
  }

  /**
   * Berekent de prijs van een artikelrij.
   * @param {object} row Rij uit ROWS_SQL.
   * @param {object} config De instelling.
   * @param {{ categoryFactorOf: Function, slugOf: Function }} lookup Zoeker van categoriefactoren.
   * @returns {{ factor: ?number, source: ?string, price: ?number, problem: string }} De uitkomst; `problem` is gevuld als er geen prijs uit komt.
   */
  function compute(row, config, lookup) {
    const found = resolveFactor({
      itemFactor: row.price_factor == null ? null : Number(row.price_factor), supplierId: row.supplier_id,
      categoryFactor: lookup.categoryFactorOf(lookup.slugOf(row.categories)),
    }, config);
    if (!found) return { factor: null, source: null, price: null, problem: 'Geen factor ingesteld' };
    const price = priceFrom(row.cost_price, found.factor, config.rounding);
    return { factor: found.factor, source: found.source, price, problem: price === null ? 'Geen inkoopprijs' : '' };
  }

  /**
   * Alle actieve artikelen in de modus factor, met de nieuwe prijs.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object[]} Rijen: id, code, name, unit, costPrice, oldPrice, newPrice, factor, source, problem, changed, marginOld, marginNew.
   */
  function rowsOf(tenantId) {
    const config = configOf(tenantId);
    const lookup = categoryLookup(tenantId, config);
    const rows = db.prepare(`${ROWS_SQL} AND i.archived = 0 AND i.has_variants = 0 AND i.price_mode = 'factor' ORDER BY i.code`).all(tenantId);
    return rows.map((row) => {
      const result = compute(row, config, lookup);
      const oldPrice = row.sale_price == null ? null : Number(row.sale_price);
      const costPrice = row.cost_price == null ? null : Number(row.cost_price);
      return {
        id: row.id, code: row.code, name: row.name, unit: row.unit, costPrice, oldPrice, newPrice: result.price, factor: result.factor, source: result.source, problem: result.problem,
        changed: result.price !== null && (oldPrice === null || Math.abs(oldPrice - result.price) >= 0.005),
        marginOld: marginPct(oldPrice, costPrice), marginNew: marginPct(result.price, costPrice),
      };
    });
  }

  /**
   * Het scherm: instelling, de keuzelijsten en het voorbeeld van de herberekening.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ suppliers: { id: string, name: string }[] }} choices De leveranciers om uit te kiezen.
   * @returns {object} config, categories, suppliers, roundingModes, directions en preview (de artikelen in de modus factor, afwijkende eerst).
   */
  function view(tenantId, choices) {
    const preview = rowsOf(tenantId).sort((left, right) => Number(right.changed) - Number(left.changed) || left.code.localeCompare(right.code));
    return {
      config: configOf(tenantId), categories: flatten(treeOf(tenantId)), suppliers: choices.suppliers,
      roundingModes: Object.entries(ROUNDING_MODES).map(([mode, rule]) => ({ mode, label: rule.label })), directions: DIRECTIONS,
      preview, changedCount: preview.filter((row) => row.changed).length,
    };
  }

  /**
   * Zet de nieuwe prijzen door voor de gevraagde artikelen. De prijzen worden opnieuw berekend; een artikel waarvan de
   * uitkomst intussen anders is dan in het voorbeeld (instelling of inkoopprijs veranderde) wordt overgeslagen.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, newPrice: number }[]} requested Wat het voorbeeld toonde.
   * @returns {{ updated: number, skipped: number }} Aantal doorgevoerd en overgeslagen.
   */
  function apply(tenantId, requested) {
    const current = new Map(rowsOf(tenantId).map((row) => [row.id, row]));
    const changes = [];
    let skipped = 0;
    for (const entry of requested) {
      const row = current.get(String(entry && entry.id));
      if (!row || !row.changed || !(Math.abs(Number(entry.newPrice) - row.newPrice) < 0.005)) { skipped += 1; continue; }
      changes.push({ id: row.id, salePrice: row.newPrice });
    }
    if (changes.length) stock.setSalePrices(tenantId, changes);
    return { updated: changes.length, skipped };
  }

  /**
   * De prijs voor één artikel, bij het opslaan in de voorraad. Een nieuw artikel (zonder id) heeft nog geen leverancier of
   * webshopproduct: dan tellen alleen de factor van het artikel en de standaard.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id?: ?string, costPrice: ?number, priceFactor: ?number }} item De waarden zoals ze worden opgeslagen.
   * @returns {number|null} De prijs, of null als er geen factor of inkoopprijs is.
   */
  function priceFor(tenantId, item) {
    const config = configOf(tenantId);
    const row = (item.id ? db.prepare(`${ROWS_SQL} AND i.id = ?`).get(tenantId, item.id) : null) || {};
    return compute({ ...row, cost_price: item.costPrice, price_factor: item.priceFactor }, config, categoryLookup(tenantId, config)).price;
  }

  return { configOf, view, apply, priceFor, sanitize: sanitizePriceFactors };
}

/**
 * Hangt de routes aan de app: lezen en voorbeeld (recht voorraad), instelling opslaan en doorvoeren (recht beheer).
 * @param {object} app De Express-app.
 * @param {{ priceFactors: object, suppliers: object, settingsOf: Function, treeOf: Function, requireRight: Function, requireJson: Function, audit: Function }} ctx
 *   De opslag en hulpfuncties van de server.
 * @returns {void}
 */
function registerPriceFactorRoutes(app, { priceFactors, suppliers, settingsOf, treeOf, requireRight, requireJson, audit }) {
  const requireStock = requireRight('voorraad');
  const requireAdmin = requireRight('beheer');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * De leveranciers van de omgeving om uit te kiezen.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ id: string, name: string }[]} De actieve leveranciers.
   */
  const supplierChoices = (tenantId) => suppliers.list(tenantId, {}).map((supplier) => ({ id: supplier.id, name: supplier.name }));

  app.get('/api/stock/price-factors', requireStock, (req, res) => {
    const tenantId = tenantOf(req);
    res.set('Cache-Control', 'no-store');
    res.json(priceFactors.view(tenantId, { suppliers: supplierChoices(tenantId) }));
  });

  app.put('/api/stock/price-factors', requireAdmin, requireJson, (req, res) => {
    const tenantId = tenantOf(req);
    const known = new Set(flatten(treeOf(tenantId)).map((node) => node.slug));
    const problem = check(req.body, known, new Set(supplierChoices(tenantId).map((supplier) => supplier.id)));
    if (problem) return res.status(400).json({ error: 'invalid_price_factors', message: problem });
    const clean = sanitizePriceFactors(req.body);
    settingsOf(tenantId).update({ priceFactors: clean }, req.user.id);
    audit(req, 'prijsfactor_gewijzigd', { standaard: clean.defaultFactor, afronding: clean.rounding.mode, categorieen: clean.categories.length, leveranciers: clean.suppliers.length });
    res.set('Cache-Control', 'no-store');
    res.json(priceFactors.view(tenantId, { suppliers: supplierChoices(tenantId) }));
  });

  app.post('/api/stock/price-factors/apply', requireAdmin, requireJson, (req, res) => {
    const requested = req.body && Array.isArray(req.body.items) ? req.body.items.slice(0, 20000) : null;
    if (!requested || !requested.length) return res.status(400).json({ error: 'invalid', message: 'Kies de artikelen waarvan de prijs wijzigt.' });
    const out = priceFactors.apply(tenantOf(req), requested);
    audit(req, 'prijsfactor_doorgevoerd', { aantal: out.updated, overgeslagen: out.skipped });
    res.json(out);
  });
}

module.exports = {
  MIN_FACTOR, MAX_FACTOR, ROUNDING_MODES, sanitizePriceFactors, check, roundPrice, resolveFactor, priceFrom, marginPct, cleanFactor,
  createPriceFactorStore, registerPriceFactorRoutes,
};
