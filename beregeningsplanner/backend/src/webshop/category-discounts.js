// Kortingen per productcategorie voor zakelijke klanten: de instelling categoryDiscounts
// (Beheer > Webshop > Zakelijke kortingen), het zoeken van de korting bij een categorie van
// de webshopboom en de beheerroutes. Zuivere functies zonder database, gedeeld door de
// catalogus (storefront-data.js) en de prijsberekening van de winkelwagen (web-orders.js).
//
// Rangorde: een eigen zakelijke prijs van het artikel (of van een verpakking) gaat altijd voor;
// de categoriekorting geldt alleen voor artikelen die de zakelijke prijs niet zelf vastleggen.
// Binnen de boom wint de diepste categorie met een korting (een subcategorie gaat voor haar
// hoofdcategorie). Bij groothandelsklanten telt de hoogste van staffel-, klant- en
// categoriekorting; ze worden dus nooit opgeteld (zie wholesale.js).

/** Hoogste aantal regels in de lijst met categoriekortingen. */
const MAX_RULES = 200;
/** Hoogste korting (%) per categorie. */
const MAX_DISCOUNT = 90;

/**
 * Rondt een percentage af op twee decimalen.
 * @param {number} value Het percentage.
 * @returns {number} Het afgeronde percentage.
 */
function roundPct(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Controleert de lijst met kortingen en maakt er een nette lijst van: elke categorie één keer, een korting boven 0
 * en hoogstens 90%. Ongeldige regels worden overgeslagen (zie `check` voor meldingen aan de beheerder).
 * @param {*} raw De opgeslagen of ingevoerde instelling: { rules: [{ categorySlug, discountPct }] }.
 * @returns {{ rules: { categorySlug: string, discountPct: number }[] }} De opgeschoonde lijst, op categorie gesorteerd.
 */
function sanitizeCategoryDiscounts(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.rules) ? raw.rules : [];
  const bySlug = new Map();
  for (const entry of list.slice(0, MAX_RULES)) {
    const categorySlug = String(entry && entry.categorySlug != null ? entry.categorySlug : '').trim().slice(0, 120);
    const discountPct = roundPct(Number(entry && entry.discountPct));
    if (!categorySlug || !Number.isFinite(discountPct) || discountPct <= 0 || discountPct > MAX_DISCOUNT) continue;
    bySlug.set(categorySlug, discountPct);
  }
  return { rules: [...bySlug].map(([categorySlug, discountPct]) => ({ categorySlug, discountPct })).sort((left, right) => left.categorySlug.localeCompare(right.categorySlug)) };
}

/**
 * Controleert een invoer van de beheerder streng, met een melding per fout (anders dan sanitize, dat ongeldige regels stil weglaat).
 * @param {*} raw De invoer: { rules: [...] }.
 * @param {Set<string>} knownSlugs De categorieën die in de boom staan.
 * @returns {string} Een melding in gewone taal, of een lege tekst als alles klopt.
 */
function check(raw, knownSlugs) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rules)) return 'Ongeldige lijst met kortingen.';
  if (raw.rules.length > MAX_RULES) return `Hoogstens ${MAX_RULES} categorieën met een korting.`;
  const seen = new Set();
  for (const entry of raw.rules) {
    const slug = String(entry && entry.categorySlug != null ? entry.categorySlug : '');
    if (!knownSlugs.has(slug)) return 'Een gekozen categorie staat niet (meer) in het menu van de webshop.';
    if (seen.has(slug)) return 'Een categorie komt twee keer voor.';
    seen.add(slug);
    const discountPct = roundPct(Number(entry.discountPct));
    if (!Number.isFinite(discountPct) || discountPct <= 0 || discountPct > MAX_DISCOUNT) return `De korting is een percentage boven 0 tot en met ${MAX_DISCOUNT}.`;
  }
  return '';
}

/**
 * Maakt van de categorieboom een platte lijst met de plek van elke categorie.
 * @param {object[]} tree De boom (hoofdcategorieën met `children`, elk met `slug` en `name`).
 * @returns {{ slug: string, name: string, depth: number, parentSlug: string, path: string }[]} Alle categorieën, in de volgorde van het menu.
 */
function flatten(tree) {
  const out = [];
  /**
   * Zet een knoop en zijn kinderen in de lijst.
   * @param {object} node De knoop.
   * @param {number} depth Diepte (0 = hoofdcategorie).
   * @param {string} parentSlug De bovenliggende categorie ('' bij een hoofdcategorie).
   * @param {string} trail De namen van de bovenliggende categorieën, gescheiden door ' › '.
   * @returns {void}
   */
  const visit = (node, depth, parentSlug, trail) => {
    if (!node || !node.slug) return;
    const path = trail ? `${trail} › ${node.name}` : String(node.name);
    out.push({ slug: node.slug, name: String(node.name), depth, parentSlug, path });
    for (const child of node.children || []) visit(child, depth + 1, node.slug, path);
  };
  for (const root of tree || []) visit(root, 0, '', '');
  return out;
}

/**
 * Maakt een zoekfunctie die bij een categorie (slug in de boom) de korting geeft: die van de categorie zelf, anders van de
 * dichtstbijzijnde bovenliggende categorie met een korting.
 * @param {object[]} tree De categorieboom.
 * @param {{ rules?: { categorySlug: string, discountPct: number }[] }} config De instelling categoryDiscounts.
 * @returns {(treeSlug: ?string) => number} De zoekfunctie; geeft 0 voor een onbekende categorie of zonder korting.
 */
function resolverFor(tree, config) {
  const rules = sanitizeCategoryDiscounts(config).rules;
  if (!rules.length) return () => 0;
  const pctOf = new Map(rules.map((rule) => [rule.categorySlug, rule.discountPct]));
  const parentOf = new Map(flatten(tree).map((node) => [node.slug, node.parentSlug]));
  const memo = new Map();
  return (treeSlug) => {
    if (!treeSlug || !parentOf.has(treeSlug)) return 0;
    if (memo.has(treeSlug)) return memo.get(treeSlug);
    let pct = 0;
    // De diepte van de boom is beperkt (vijf niveaus); de teller beschermt tegen een lus in een kapotte boom.
    for (let slug = treeSlug, steps = 0; slug && steps < 12; slug = parentOf.get(slug), steps += 1) {
      if (pctOf.has(slug)) { pct = pctOf.get(slug); break; }
    }
    memo.set(treeSlug, pct);
    return pct;
  };
}

/**
 * Registreert de beheerroutes (recht beheer via /api/admin): de lijst met kortingen lezen en opslaan.
 * @param {object} app De Express-app.
 * @param {{ settingsOf: Function, treeOf: Function, audit: Function, requireJson: Function }} ctx settingsOf(req) = de instellingen van de omgeving,
 *   treeOf(tenantId) = de categorieboom van de omgeving, audit(req, actie, detail) en requireJson = middleware voor JSON-bodies. De catalogus onthoudt de kortingen bij zijn cache, dus na opslaan is niets te wissen.
 * @returns {void}
 */
function registerCategoryDiscountRoutes(app, { settingsOf, treeOf, audit, requireJson }) {
  /**
   * Het antwoord voor het beheerscherm.
   * @param {object} req Het verzoek.
   * @returns {{ rules: object[], categories: object[] }} De kortingen en alle categorieën van het menu.
   */
  const viewOf = (req) => ({ ...sanitizeCategoryDiscounts(settingsOf(req).get('categoryDiscounts')), categories: flatten(treeOf(req.tenantId)) });

  app.get('/api/admin/category-discounts', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(viewOf(req)); });

  app.put('/api/admin/category-discounts', requireJson, (req, res) => {
    const known = new Set(flatten(treeOf(req.tenantId)).map((node) => node.slug));
    const problem = check(req.body, known);
    if (problem) return res.status(400).json({ error: 'invalid_discounts', message: problem });
    const clean = sanitizeCategoryDiscounts(req.body);
    settingsOf(req).update({ categoryDiscounts: clean }, req.user.id);
    audit(req, 'categoriekortingen_gewijzigd', { aantal: clean.rules.length });
    res.set('Cache-Control', 'no-store');
    res.json(viewOf(req));
  });
}

module.exports = { MAX_DISCOUNT, sanitizeCategoryDiscounts, flatten, resolverFor, registerCategoryDiscountRoutes };
