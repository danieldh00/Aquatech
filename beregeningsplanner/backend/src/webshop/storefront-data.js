// Gegevens voor de eigen webshop (storefront.js): de publiceerbare artikelen
// uit de voorraad van een omgeving, met categorie en afbeelding uit de
// opgehaalde webshopproducten (shop_products). Alleen lezen; interne velden
// (inkoopprijs, locatie, notities, aantallen) komen er nooit in.

const crypto = require('crypto');
const { decodeHtmlEntities } = require('./html-entities');

/** Hoe lang (ms) een opgebouwde catalogus per omgeving wordt hergebruikt. */
const CACHE_MS = 30 * 1000;
/** Categorie voor artikelen zonder categorie in de webshop. */
const FALLBACK_CATEGORY = 'Overig';
/** Aantal uitgelichte producten op de startpagina. */
const FEATURED_COUNT = 8;
/**
 * Hoofdcategorieën van de shop, zoals het menu van aquatechshop.nl. De
 * webshop levert alleen platte categorienamen; een categorie komt in de eerste
 * groep waarvan het patroon op de naam past (volgorde telt), anders in Overig.
 */
const GROUPS = [
  { slug: 'beregening', name: 'Beregening', pattern: /sproei|druppel|driptape|beregening|regensensor|computer|verdeler|manifold|magneetklep|kleppenput/i },
  { slug: 'elektra', name: 'Elektra', pattern: /^elektra/i },
  { slug: 'pomp-techniek', name: 'Pomp & techniek', pattern: /pomp|bronkop|expansievat|aansluitkast|kabel|waterbehandeling|filter|^techniek/i },
  { slug: 'leidingen-toebehoren', name: 'Leidingen & toebehoren', pattern: /tyleen|draadfitting|kraan|kranen|koppeling|pvc|leiding|slang|fitting|unidelta|muurplaat/i },
];
/** Hoofdcategorie voor wat nergens in past. */
const OTHER_GROUP = { slug: 'overig', name: 'Overig' };

/**
 * Maakt van een tekst een url-vriendelijke naam: kleine letters, cijfers en
 * streepjes, zonder accenten.
 * @param {*} text De tekst (bijv. een productnaam).
 * @returns {string} De slug, leeg als er niets bruikbaars overblijft.
 */
function slugify(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' en ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '');
}

/**
 * Leest de eerste categorienaam uit het JSON-veld `categories` van een webshopproduct.
 * @param {*} categoriesJson De opgeslagen tekst, bijv. '["Sproeiers"]'.
 * @returns {string} De categorienaam, of de standaardcategorie.
 */
function categoryNameOf(categoriesJson) {
  let names = [];
  try { names = JSON.parse(categoriesJson || '[]'); } catch { names = []; }
  const first = Array.isArray(names) ? names.map((name) => decodeHtmlEntities(name).trim()).find(Boolean) : '';
  return first || FALLBACK_CATEGORY;
}

/**
 * Bepaalt de hoofdcategorie van een categorie op haar naam.
 * @param {string} categoryName De categorienaam.
 * @returns {{ slug: string, name: string }} De hoofdcategorie (zie GROUPS), of Overig.
 */
function groupOf(categoryName) {
  return GROUPS.find((group) => group.pattern.test(categoryName)) || OTHER_GROUP;
}

/**
 * Kiest de uitgelichte producten voor de startpagina: producten met foto die
 * op voorraad zijn, om en om uit elke hoofdcategorie zodat de selectie breed is.
 * @param {object[]} products De producten (op naam gesorteerd, met groupSlug, image en inStock).
 * @returns {object[]} Maximaal FEATURED_COUNT producten.
 */
function pickFeatured(products) {
  const queues = new Map();
  for (const product of products) {
    if (!product.image || !product.inStock) continue;
    if (!queues.has(product.groupSlug)) queues.set(product.groupSlug, []);
    queues.get(product.groupSlug).push(product);
  }
  const featured = [];
  const lists = [...queues.values()];
  for (let round = 0; featured.length < FEATURED_COUNT && lists.some((list) => round < list.length); round += 1) {
    for (const list of lists) if (round < list.length && featured.length < FEATURED_COUNT) featured.push(list[round]);
  }
  return featured;
}

/**
 * Geeft alleen een https-adres terug (afbeeldingen van de webshop); alles
 * anders (data:, javascript:, http:) wordt leeg.
 * @param {*} url Het adres.
 * @returns {string} Het https-adres, of ''.
 */
function safeImageUrl(url) {
  const text = String(url || '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(text) ? text : '';
}

/**
 * Geeft elke categorie een slug die alleen van haar eigen naam afhangt: de
 * slug van de naam plus een korte vingerafdruk van de naam. Zo blijft de url
 * gelijk als er categorieën bijkomen, ook bij namen waarvan de slug samenvalt
 * (bijv. "Tuin & huis" en "Tuin en huis"), en doet de volgorde van de producten
 * er niet toe.
 * @param {Map<string, object>} categories Categorieën per naam (kleine letters); krijgen een `slug`.
 * @returns {void}
 */
function assignCategorySlugs(categories) {
  const bySlug = new Map();
  for (const category of categories.values()) {
    const base = slugify(category.name) || 'overig';
    bySlug.set(base, [...(bySlug.get(base) || []), category]);
  }
  for (const [base, group] of bySlug) {
    for (const category of group) {
      category.slug = `${base}-${crypto.createHash('sha256').update(category.key).digest('hex').slice(0, 6)}`;
      delete category.key;
    }
  }
}

/**
 * Bouwt de catalogus uit rijen van de database: unieke slugs voor producten
 * en categorieën, categorie-indeling en prijs inclusief btw.
 * @param {object[]} rows Rijen met id, code, name, unit, on_hand, sale_price, vat_rate, categories en image.
 * @returns {{ products: object[], categories: object[], groups: object[], featured: object[] }} products (slug, code, name, unit, categorySlug, categoryName, groupSlug, priceExcl, priceIncl, vatRate, inStock, image) en categories (slug, name, count, groupSlug), beide op naam gesorteerd; groups = hoofdcategorieën met hun categorieën (slug, name, categories, count); featured = uitgelichte producten.
 */
function buildCatalog(rows) {
  const sorted = [...rows].sort((left, right) => String(left.name).localeCompare(String(right.name), 'nl') || String(left.code).localeCompare(String(right.code), 'nl'));
  const usedSlugs = new Set();
  const categories = new Map();
  const products = sorted.map((row) => {
    // De slug volgt naam én artikelcode (de code is uniek en blijft gelijk), zodat
    // de url van een artikel niet verandert als er artikelen bijkomen.
    // De code blijft volledig buiten de afkapping; alleen de naam wordt ingekort.
    const codeSlug = slugify(row.code);
    const namePart = slugify(row.name).slice(0, Math.max(0, 80 - codeSlug.length - 1)).replace(/-+$/g, '');
    const base = [namePart, codeSlug].filter(Boolean).join('-') || 'artikel';
    let slug = base;
    for (let counter = 2; usedSlugs.has(slug); counter += 1) slug = `${base}-${counter}`;
    usedSlugs.add(slug);
    const categoryName = categoryNameOf(row.categories);
    const categoryKey = categoryName.toLowerCase();
    const group = groupOf(categoryName);
    const category = categories.get(categoryKey) || { key: categoryKey, name: categoryName, count: 0, groupSlug: group.slug };
    category.count += 1;
    categories.set(categoryKey, category);
    const priceExcl = Number(row.sale_price);
    const vatRate = Number(row.vat_rate ?? 21);
    return {
      slug, code: String(row.code), name: decodeHtmlEntities(row.name), unit: String(row.unit || 'st'),
      categoryKey, categoryName, groupSlug: group.slug, priceExcl, vatRate,
      priceIncl: Math.round(priceExcl * (1 + vatRate / 100) * 100) / 100,
      inStock: Math.round((Number(row.on_hand) - Number(row.reserved || 0)) * 1000) / 1000 > 0, image: safeImageUrl(row.image),
    };
  });
  assignCategorySlugs(categories);
  for (const product of products) {
    product.categorySlug = categories.get(product.categoryKey).slug;
    delete product.categoryKey;
  }
  const categoryList = [...categories.values()].sort((left, right) => left.name.localeCompare(right.name, 'nl'));
  const groups = [...GROUPS, OTHER_GROUP].map((group) => {
    const members = categoryList.filter((category) => category.groupSlug === group.slug);
    return { slug: group.slug, name: group.name, categories: members, count: members.reduce((total, category) => total + category.count, 0) };
  }).filter((group) => group.categories.length);
  return { products, categories: categoryList, groups, featured: pickFeatured(products) };
}

/**
 * Maakt de gegevenslaag van de webshop, met een korte cache per omgeving
 * (de pagina's zijn openbaar: niet bij elk bezoek een databasequery).
 * @param {object} db De database.
 * @returns {{ catalogOf: Function, clearCache: Function }} catalogOf(tenantId) en clearCache().
 */
function createStorefrontData(db) {
  const cache = new Map();
  return {
    /**
     * De catalogus van een omgeving: niet-gearchiveerde voorraadartikelen met
     * verkoopprijs die naar de webshop mogen (shop_sync), met categorie en
     * afbeelding van het gekoppelde webshopproduct. Eén query.
     * @param {string} tenantId De omgeving.
     * @returns {{ products: object[], categories: object[], groups: object[], featured: object[] }} Zie buildCatalog.
     */
    catalogOf(tenantId) {
      const cached = cache.get(tenantId);
      if (cached && cached.until > Date.now()) return cached.catalog;
      const rows = db.prepare(`SELECT i.code, i.name, i.unit, i.on_hand, COALESCE(r.qty, 0) AS reserved, i.sale_price, i.vat_rate, p.categories, p.image
        FROM stock_items i
        LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_reservations WHERE tenant_id = ? GROUP BY item_id) r ON r.item_id = i.id
        LEFT JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id
        WHERE i.tenant_id = ? AND i.archived = 0 AND i.shop_sync = 1 AND i.has_variants = 0 AND i.sale_price IS NOT NULL`).all(tenantId, tenantId);
      const catalog = buildCatalog(rows);
      cache.set(tenantId, { catalog, until: Date.now() + CACHE_MS });
      return catalog;
    },
    /**
     * Wist de cache (tests).
     * @returns {void}
     */
    clearCache() { cache.clear(); },
  };
}

module.exports = { createStorefrontData, buildCatalog, slugify, categoryNameOf, groupOf, safeImageUrl, CACHE_MS };
