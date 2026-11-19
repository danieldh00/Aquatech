// Toegestane bezorgmethodes per artikel en per categorie: regels met een aantalgrens (bijvoorbeeld "pallet vanaf 100 stuks")
// en de uitkomst voor een winkelwagen. Zuivere functies zonder database, plus de beheerroutes voor de regels per categorie
// (instelling deliveryRules, Beheer > Webshop > Levermethodes). Ophalen valt buiten de regels: dat kan altijd.
//
// Rangorde van de regels: het artikel zelf (bij een variant anders het hoofdartikel) > de diepste categorie met regels > geen beperking.
// Een gemengde wagen gaat met de zwaarste methode mee: is voor één artikel alleen pallet toegestaan, dan geldt pallet voor de hele bestelling.

/** De methodes waarvoor regels gelden, van licht naar zwaar (de rang bepaalt welke methode een andere mag vervangen). */
const RULE_METHODS = ['dpd', 'eigen', 'pallet'];
/** Hoogste aantal regels per artikel of categorie. */
const MAX_RULES = 12;
/** Hoogste aantal categorieën met regels. */
const MAX_CATEGORIES = 200;
/** Hoogste aantal dat in een regel past. */
const MAX_QTY = 1000000;

/**
 * Maakt van de invoer een nette lijst regels: alleen bekende methodes, hele aantallen, min vanaf 1 en max leeg of niet onder min.
 * @param {*} raw De lijst: [{ method, minQty, maxQty }] (of een JSON-tekst daarvan).
 * @returns {{ method: string, minQty: number, maxQty: ?number }[]} De regels (hoogstens 12); ongeldige regels vallen weg.
 */
function sanitizeRules(raw) {
  let list = raw;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  if (!Array.isArray(list)) return [];
  const rules = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || !RULE_METHODS.includes(entry.method)) continue;
    const minQty = entry.minQty === '' || entry.minQty == null ? 1 : Math.floor(Number(entry.minQty));
    const maxQty = entry.maxQty === '' || entry.maxQty == null ? null : Math.floor(Number(entry.maxQty));
    if (!Number.isFinite(minQty) || minQty < 1 || minQty > MAX_QTY) continue;
    if (maxQty !== null && (!Number.isFinite(maxQty) || maxQty < minQty || maxQty > MAX_QTY)) continue;
    rules.push({ method: entry.method, minQty, maxQty });
    if (rules.length >= MAX_RULES) break;
  }
  return rules;
}

/**
 * Controleert regels van een beheerder streng met een melding (sanitize laat ongeldige regels stil weg).
 * @param {*} raw De lijst regels.
 * @returns {string} Een melding in gewone taal, of een lege tekst als alles klopt.
 */
function checkRules(raw) {
  if (!Array.isArray(raw)) return 'Ongeldige lijst met regels.';
  if (raw.length > MAX_RULES) return `Hoogstens ${MAX_RULES} regels per artikel of categorie.`;
  for (const entry of raw) {
    if (!entry || !RULE_METHODS.includes(entry.method)) return 'Kies bij elke regel een bezorgmethode.';
    const minQty = entry.minQty === '' || entry.minQty == null ? 1 : Number(entry.minQty);
    if (!Number.isInteger(minQty) || minQty < 1 || minQty > MAX_QTY) return 'Het minimum aantal is een heel getal vanaf 1.';
    if (entry.maxQty !== '' && entry.maxQty != null) {
      const maxQty = Number(entry.maxQty);
      if (!Number.isInteger(maxQty) || maxQty < minQty || maxQty > MAX_QTY) return 'Het maximum aantal is een heel getal, niet lager dan het minimum.';
    }
  }
  return '';
}

/**
 * Saneert de instelling met regels per categorie.
 * @param {*} raw De instelling: { categories: [{ categorySlug, rules }] }.
 * @returns {{ categories: { categorySlug: string, rules: object[] }[] }} Elke categorie één keer, alleen met regels, op categorie gesorteerd.
 */
function sanitizeCategoryRules(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.categories) ? raw.categories : [];
  const bySlug = new Map();
  for (const entry of list.slice(0, MAX_CATEGORIES)) {
    const categorySlug = String(entry && entry.categorySlug != null ? entry.categorySlug : '').trim().slice(0, 120);
    const rules = sanitizeRules(entry && entry.rules);
    if (categorySlug && rules.length) bySlug.set(categorySlug, rules);
  }
  return { categories: [...bySlug].map(([categorySlug, rules]) => ({ categorySlug, rules })).sort((left, right) => left.categorySlug.localeCompare(right.categorySlug)) };
}

/**
 * Controleert de invoer van het beheerscherm met een melding per fout.
 * @param {*} raw De invoer: { categories: [...] }.
 * @param {Set<string>} knownSlugs De categorieën die in het menu staan.
 * @returns {string} Een melding, of een lege tekst als alles klopt.
 */
function checkCategoryRules(raw, knownSlugs) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.categories)) return 'Ongeldige lijst met categorieën.';
  if (raw.categories.length > MAX_CATEGORIES) return `Hoogstens ${MAX_CATEGORIES} categorieën met regels.`;
  const seen = new Set();
  for (const entry of raw.categories) {
    const slug = String(entry && entry.categorySlug != null ? entry.categorySlug : '');
    if (!knownSlugs.has(slug)) return 'Een gekozen categorie staat niet (meer) in het menu van de webshop.';
    if (seen.has(slug)) return 'Een categorie komt twee keer voor.';
    seen.add(slug);
    const problem = checkRules(entry.rules);
    if (problem) return problem;
  }
  return '';
}

/**
 * Welke methodes bij een aantal zijn toegestaan.
 * @param {{ method: string, minQty: number, maxQty: ?number }[]} rules De regels van het artikel (leeg = geen beperking).
 * @param {number} qty Het aantal in de basiseenheid.
 * @returns {?Set<string>} De toegestane methodes (kan leeg zijn: dan kan het artikel in dit aantal niet bezorgd worden), of null zonder regels.
 */
function allowedAt(rules, qty) {
  if (!rules || !rules.length) return null;
  return new Set(rules.filter((rule) => qty >= rule.minQty && (rule.maxQty == null || qty <= rule.maxQty)).map((rule) => rule.method));
}

/**
 * De regels van een artikel in gewone taal, bijvoorbeeld "Bezorging door DPD tot 99 stuks · Bezorging per pallet vanaf 100 stuks".
 * @param {{ method: string, minQty: number, maxQty: ?number }[]} rules De geldende regels (leeg of null = geen beperking).
 * @param {(method: string) => string} labelOf De naam van een methode (uit de verzendinstelling).
 * @param {string} unit De eenheid van het artikel (stuk, meter, ...).
 * @returns {string} De tekst, of leeg zonder regels.
 */
function describeRules(rules, labelOf, unit) {
  if (!rules || !rules.length) return '';
  const unitText = String(unit || 'stuks').trim() || 'stuks';
  return [...rules].sort((left, right) => left.minQty - right.minQty || RULE_METHODS.indexOf(left.method) - RULE_METHODS.indexOf(right.method)).map((rule) => {
    const range = rule.maxQty == null ? (rule.minQty <= 1 ? 'in elk aantal' : `vanaf ${rule.minQty} ${unitText}`) : (rule.minQty <= 1 ? `tot ${rule.maxQty} ${unitText}` : `van ${rule.minQty} tot ${rule.maxQty} ${unitText}`);
    return `${labelOf(rule.method)} ${range}`.trim();
  }).join(' · ');
}

/**
 * Welke bezorgmethodes een winkelwagen toestaat. Een methode mag als voor elk artikel met regels de methode zelf is toegestaan of
 * zwaarder is dan alles wat dat artikel toestaat (de zwaarste methode neemt de hele bestelling mee).
 * @param {{ name: string, qty: number, rules: ?object[] }[]} lines Per regel de naam, het aantal in de basiseenheid en de geldende regels (null = geen).
 * @returns {Object<string, string>} Per geblokkeerde methode de reden; een methode die ontbreekt is toegestaan.
 */
function blockedMethods(lines) {
  const blocked = {};
  for (const line of lines) {
    const allowed = allowedAt(line.rules, line.qty);
    if (!allowed) continue;
    if (!allowed.size) {
      for (const method of RULE_METHODS) blocked[method] = blocked[method] || `"${line.name}" kan in dit aantal niet worden bezorgd; neem contact met ons op of kies afhalen.`;
      continue;
    }
    const heaviest = Math.max(-1, ...[...allowed].map((method) => RULE_METHODS.indexOf(method)));
    for (const [rank, method] of RULE_METHODS.entries()) {
      if (blocked[method] || allowed.has(method) || rank > heaviest) continue;
      blocked[method] = `"${line.name}" kan in dit aantal niet met deze methode worden bezorgd.`;
    }
  }
  return blocked;
}

/**
 * De regels die voor een artikel gelden: eigen regels, anders die van het hoofdartikel, anders die van de diepste categorie.
 * @param {*} itemRules De regels van het artikel (JSON-tekst of lijst).
 * @param {*} parentRules De regels van het hoofdartikel (bij een variant).
 * @param {object[]} categoryRules De regels van de categorie (al opgezocht; leeg = geen).
 * @returns {?object[]} De regels, of null als er geen beperking is.
 */
function effectiveRules(itemRules, parentRules, categoryRules) {
  for (const candidate of [sanitizeRules(itemRules), sanitizeRules(parentRules), categoryRules || []]) {
    if (candidate.length) return candidate;
  }
  return null;
}

/**
 * Maakt een zoekfunctie die bij een categorie (slug in de boom) de regels geeft: die van de categorie zelf, anders van de
 * dichtstbijzijnde bovenliggende categorie met regels.
 * @param {{ slug: string, parentSlug: string }[]} flatTree De platte lijst van de boom (category-discounts.js, flatten).
 * @param {{ categories?: object[] }} config De instelling deliveryRules.
 * @returns {(treeSlug: ?string) => object[]} De zoekfunctie; geeft een lege lijst zonder regels of bij een onbekende categorie.
 */
function resolverFor(flatTree, config) {
  const entries = sanitizeCategoryRules(config).categories;
  if (!entries.length) return () => [];
  const rulesOf = new Map(entries.map((entry) => [entry.categorySlug, entry.rules]));
  const parentOf = new Map(flatTree.map((node) => [node.slug, node.parentSlug]));
  return (treeSlug) => {
    if (!treeSlug || !parentOf.has(treeSlug)) return [];
    // De diepte van de boom is beperkt; de teller beschermt tegen een lus in een kapotte boom.
    for (let slug = treeSlug, steps = 0; slug && steps < 12; slug = parentOf.get(slug), steps += 1) {
      if (rulesOf.has(slug)) return rulesOf.get(slug);
    }
    return [];
  };
}

/**
 * Registreert de beheerroutes (recht beheer via /api/admin): de regels per categorie lezen en opslaan.
 * @param {object} app De Express-app.
 * @param {{ settingsOf: Function, flatTreeOf: Function, audit: Function, requireJson: Function }} ctx settingsOf(req) = de instellingen van de omgeving, flatTreeOf(tenantId) = de platte categorielijst (met `path`), audit(req, actie, detail) en requireJson.
 * @returns {void}
 */
function registerDeliveryRuleRoutes(app, { settingsOf, flatTreeOf, audit, requireJson }) {
  /**
   * Het antwoord voor het beheerscherm.
   * @param {object} req Het verzoek.
   * @returns {{ categories: object[], menu: object[] }} De regels per categorie en alle categorieën van het menu.
   */
  const viewOf = (req) => ({ ...sanitizeCategoryRules(settingsOf(req).get('deliveryRules')), menu: flatTreeOf(req.tenantId) });

  app.get('/api/admin/delivery-rules', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(viewOf(req)); });

  app.put('/api/admin/delivery-rules', requireJson, (req, res) => {
    const known = new Set(flatTreeOf(req.tenantId).map((node) => node.slug));
    const problem = checkCategoryRules(req.body, known);
    if (problem) return res.status(400).json({ error: 'invalid_delivery_rules', message: problem });
    const clean = sanitizeCategoryRules(req.body);
    settingsOf(req).update({ deliveryRules: clean }, req.user.id);
    audit(req, 'levermethoderegels_gewijzigd', { aantal: clean.categories.length });
    res.set('Cache-Control', 'no-store');
    res.json(viewOf(req));
  });
}

module.exports = { describeRules, RULE_METHODS, sanitizeRules, checkRules, sanitizeCategoryRules, checkCategoryRules, allowedAt, blockedMethods, effectiveRules, resolverFor, registerDeliveryRuleRoutes };
