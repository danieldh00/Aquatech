// Gegevens voor de eigen webshop (storefront.js): de publiceerbare artikelen
// uit de voorraad van een omgeving, met categorie en afbeelding uit de
// opgehaalde webshopproducten (shop_products). Alleen lezen; interne velden
// (inkoopprijs, locatie, notities, aantallen) komen er nooit in.

/** Hoe lang (ms) een opgebouwde catalogus per omgeving wordt hergebruikt. */
const CACHE_MS = 30 * 1000;
/** Categorie voor artikelen zonder categorie in de webshop. */
const FALLBACK_CATEGORY = 'Overig';

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
  const first = Array.isArray(names) ? names.map((name) => String(name || '').trim()).find(Boolean) : '';
  return first || FALLBACK_CATEGORY;
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
 * Bouwt de catalogus uit rijen van de database: unieke slugs voor producten
 * en categorieën, categorie-indeling en prijs inclusief btw.
 * @param {object[]} rows Rijen met id, code, name, unit, on_hand, sale_price, vat_rate, categories en image.
 * @returns {{ products: object[], categories: object[] }} products (slug, code, name, unit, categorySlug, categoryName, priceExcl, priceIncl, vatRate, inStock, image) en categories (slug, name, count), beide op naam gesorteerd.
 */
function buildCatalog(rows) {
  const sorted = [...rows].sort((left, right) => String(left.name).localeCompare(String(right.name), 'nl') || String(left.code).localeCompare(String(right.code), 'nl'));
  const usedSlugs = new Set();
  const categories = new Map();
  const products = sorted.map((row) => {
    const base = slugify(row.name) || slugify(row.code) || 'artikel';
    let slug = base;
    if (usedSlugs.has(slug)) slug = slugify(`${base}-${row.code}`) || `${base}-2`;
    for (let counter = 2; usedSlugs.has(slug); counter += 1) slug = `${base}-${counter}`;
    usedSlugs.add(slug);
    const categoryName = categoryNameOf(row.categories);
    const categorySlug = slugify(categoryName) || 'overig';
    const category = categories.get(categorySlug) || { slug: categorySlug, name: categoryName, count: 0 };
    category.count += 1;
    categories.set(categorySlug, category);
    const priceExcl = Number(row.sale_price);
    const vatRate = Number(row.vat_rate ?? 21);
    return {
      slug, code: String(row.code), name: String(row.name), unit: String(row.unit || 'st'),
      categorySlug, categoryName, priceExcl, vatRate,
      priceIncl: Math.round(priceExcl * (1 + vatRate / 100) * 100) / 100,
      inStock: Number(row.on_hand) > 0, image: safeImageUrl(row.image),
    };
  });
  const categoryList = [...categories.values()].sort((left, right) => left.name.localeCompare(right.name, 'nl'));
  return { products, categories: categoryList };
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
     * @returns {{ products: object[], categories: object[] }} Zie buildCatalog.
     */
    catalogOf(tenantId) {
      const cached = cache.get(tenantId);
      if (cached && cached.until > Date.now()) return cached.catalog;
      const rows = db.prepare(`SELECT i.code, i.name, i.unit, i.on_hand, i.sale_price, i.vat_rate, p.categories, p.image
        FROM stock_items i
        LEFT JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id
        WHERE i.tenant_id = ? AND i.archived = 0 AND i.shop_sync = 1 AND i.sale_price IS NOT NULL`).all(tenantId);
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

module.exports = { createStorefrontData, buildCatalog, slugify, categoryNameOf, safeImageUrl, CACHE_MS };
