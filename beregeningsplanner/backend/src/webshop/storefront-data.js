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
 * bij voorkeur op voorraad, om en om uit elke hoofdcategorie zodat de selectie breed is (zonder genoeg voorraad vult ze aan met producten met foto).
 * @param {object[]} products De producten (op naam gesorteerd, met groupSlug, image en inStock).
 * @returns {object[]} Maximaal FEATURED_COUNT producten.
 */
function pickFeatured(products) {
  /**
   * Kiest om en om uit elke hoofdcategorie producten met foto.
   * @param {object[]} candidates De producten om uit te kiezen.
   * @returns {object[]} Maximaal FEATURED_COUNT producten.
   */
  function interleave(candidates) {
    const queues = new Map();
    for (const product of candidates) {
      if (!queues.has(product.groupSlug)) queues.set(product.groupSlug, []);
      queues.get(product.groupSlug).push(product);
    }
    const picked = [];
    const lists = [...queues.values()];
    for (let round = 0; picked.length < FEATURED_COUNT && lists.some((list) => round < list.length); round += 1) {
      for (const list of lists) if (round < list.length && picked.length < FEATURED_COUNT) picked.push(list[round]);
    }
    return picked;
  }
  const withImage = products.filter((product) => product.image);
  const featured = interleave(withImage.filter((product) => product.inStock));
  // Te weinig op voorraad: vul aan met producten met foto, zodat de startpagina nooit leeg blijft.
  if (featured.length < FEATURED_COUNT) {
    const chosen = new Set(featured);
    featured.push(...interleave(withImage.filter((product) => !chosen.has(product))).slice(0, FEATURED_COUNT - featured.length));
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
 * Leest de waarden van een variant (bijv. { Maat: '25 mm' }) uit het JSON-veld.
 * @param {*} valuesJson De opgeslagen tekst.
 * @returns {Object<string, string>} Kenmerknaam → waarde, leeg bij ongeldige invoer.
 */
function variantValuesOf(valuesJson) {
  try {
    const values = JSON.parse(valuesJson || '{}');
    return values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  } catch { return {}; }
}

/**
 * Leest de kenmerken van een hoofdartikel uit het JSON-veld en geeft de namen.
 * @param {*} attributesJson De opgeslagen tekst, bijv. '[{"name":"Maat","values":["16 mm"]}]'.
 * @returns {string[]} De kenmerknamen.
 */
function attributeNamesOf(attributesJson) {
  try {
    const attributes = JSON.parse(attributesJson || '[]');
    return Array.isArray(attributes) ? attributes.map((attribute) => String(attribute && attribute.name || '').trim()).filter(Boolean) : [];
  } catch { return []; }
}

/**
 * Bouwt de catalogus uit rijen van de database: unieke slugs voor producten
 * en categorieën, categorie-indeling en prijs inclusief btw. Varianten van een
 * hoofdartikel (parent_id) komen als één regel in `products`, met hun keuzes
 * in `variants`; elke variant blijft los bereikbaar via `variantProducts`.
 * @param {object[]} rows Rijen met id, code, name, unit, on_hand, sale_price, vat_rate, categories en image; bij varianten parent_id en variant_values, bij hoofdartikelen has_variants=1 en attributes.
 * @returns {{ products: object[], variantProducts: object[], categories: object[], groups: object[], featured: object[] }} products (slug, code, name, unit, categorySlug, categoryName, groupSlug, priceExcl, priceIncl, vatRate, inStock, image; bij een hoofdartikel met varianten ook `variants` [{ slug, code, label, meta, priceIncl, inStock, image }] en `attributeName`, met de laagste prijs en op voorraad als een variant dat is) en categories (slug, name, count, groupSlug), beide op naam gesorteerd; variantProducts = de varianten als gewoon product (met parentSlug en parentName); groups = hoofdcategorieën met hun categorieën (slug, name, categories, count); featured = uitgelichte producten.
 */
function buildCatalog(rows) {
  /**
   * Sorteert op naam, bij gelijke namen op artikelcode.
   * @param {object} left Het eerste product of de eerste rij.
   * @param {object} right Het tweede product of de tweede rij.
   * @returns {number} Negatief, nul of positief.
   */
  const compareByName = (left, right) => String(left.name).localeCompare(String(right.name), 'nl') || String(left.code).localeCompare(String(right.code), 'nl');
  const parentRows = new Map(rows.filter((row) => Number(row.has_variants)).map((row) => [row.id, row]));
  const itemRows = rows.filter((row) => !Number(row.has_variants)).sort(compareByName);
  const usedSlugs = new Set();
  /**
   * Geeft een unieke slug die volgt uit naam én artikelcode (de code is uniek en
   * blijft gelijk), zodat de url van een artikel niet verandert als er artikelen
   * bijkomen. De code blijft volledig buiten de afkapping; alleen de naam wordt ingekort.
   * @param {string} name De naam.
   * @param {string} code De artikelcode.
   * @returns {string} De slug.
   */
  const uniqueSlug = (name, code) => {
    const codeSlug = slugify(code);
    const namePart = slugify(name).slice(0, Math.max(0, 80 - codeSlug.length - 1)).replace(/-+$/g, '');
    const base = [namePart, codeSlug].filter(Boolean).join('-') || 'artikel';
    let slug = base;
    for (let counter = 2; usedSlugs.has(slug); counter += 1) slug = `${base}-${counter}`;
    usedSlugs.add(slug);
    return slug;
  };
  /**
   * Zet een rij van de database om in een product (zonder categorie-indeling).
   * @param {object} row De rij.
   * @returns {object} Het product.
   */
  const toProduct = (row) => {
    const categoryName = categoryNameOf(row.categories);
    const priceExcl = Number(row.sale_price);
    const vatRate = Number(row.vat_rate ?? 21);
    return {
      slug: uniqueSlug(row.name, row.code), code: String(row.code), name: decodeHtmlEntities(row.name), unit: String(row.unit || 'st'),
      categoryKey: categoryName.toLowerCase(), categoryName, groupSlug: groupOf(categoryName).slug, priceExcl, vatRate,
      priceIncl: Math.round(priceExcl * (1 + vatRate / 100) * 100) / 100,
      inStock: Math.round((Number(row.on_hand) - Number(row.reserved || 0)) * 1000) / 1000 > 0, image: safeImageUrl(row.image),
    };
  };
  const standalone = [];
  const variantsOfParent = new Map();
  const variantProducts = [];
  for (const row of itemRows) {
    const product = toProduct(row);
    const parent = row.parent_id ? parentRows.get(row.parent_id) : null;
    if (!parent) { standalone.push(product); continue; }
    product.values = variantValuesOf(row.variant_values);
    product.parentName = decodeHtmlEntities(parent.name);
    variantProducts.push(product);
    variantsOfParent.set(parent.id, [...(variantsOfParent.get(parent.id) || []), product]);
  }
  const listing = [...standalone];
  for (const [parentId, variants] of variantsOfParent) {
    const parent = parentRows.get(parentId);
    variants.sort((left, right) => Object.values(left.values).join(' ').localeCompare(Object.values(right.values).join(' '), 'nl', { numeric: true }) || compareByName(left, right));
    const attributeNames = attributeNamesOf(parent.attributes);
    const cheapest = variants.reduce((lowest, variant) => (variant.priceIncl < lowest.priceIncl ? variant : lowest), variants[0]);
    const categoryName = parent.categories ? categoryNameOf(parent.categories) : variants[0].categoryName;
    const group = {
      slug: uniqueSlug(parent.name, parent.code), code: String(parent.code), name: decodeHtmlEntities(parent.name), unit: String(parent.unit || variants[0].unit),
      categoryKey: categoryName.toLowerCase(), categoryName, groupSlug: groupOf(categoryName).slug,
      priceExcl: cheapest.priceExcl, vatRate: cheapest.vatRate, priceIncl: cheapest.priceIncl,
      inStock: variants.some((variant) => variant.inStock), image: safeImageUrl(parent.image) || (variants.find((variant) => variant.image) || {}).image || '',
      attributeName: attributeNames.length === 1 ? attributeNames[0] : 'Uitvoeringen',
      variants: variants.map((variant) => ({
        slug: variant.slug, code: variant.code, label: Object.values(variant.values).join(' / ') || variant.code,
        meta: Object.entries(variant.values).map(([name, value]) => `${name}: ${value}`).join(' | '),
        priceIncl: variant.priceIncl, vatRate: variant.vatRate, inStock: variant.inStock, image: variant.image,
      })),
    };
    for (const variant of variants) {
      variant.parentSlug = group.slug;
      variant.categoryKey = group.categoryKey; variant.categoryName = group.categoryName; variant.groupSlug = group.groupSlug;
    }
    listing.push(group);
  }
  const products = listing.sort(compareByName);
  const categories = new Map();
  for (const product of products) {
    const category = categories.get(product.categoryKey) || { key: product.categoryKey, name: product.categoryName, count: 0, groupSlug: product.groupSlug };
    category.count += 1;
    categories.set(product.categoryKey, category);
  }
  assignCategorySlugs(categories);
  for (const product of [...products, ...variantProducts]) {
    product.categorySlug = categories.get(product.categoryKey).slug;
    delete product.categoryKey;
  }
  const categoryList = [...categories.values()].sort((left, right) => left.name.localeCompare(right.name, 'nl'));
  const groups = [...GROUPS, OTHER_GROUP].map((group) => {
    const members = categoryList.filter((category) => category.groupSlug === group.slug);
    return { slug: group.slug, name: group.name, categories: members, count: members.reduce((total, category) => total + category.count, 0) };
  }).filter((group) => group.categories.length);
  return { products, variantProducts, categories: categoryList, groups, featured: pickFeatured(products) };
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
      const rows = db.prepare(`SELECT i.id, i.code, i.name, i.unit, i.on_hand, i.parent_id, i.has_variants, i.attributes, i.variant_values, COALESCE(r.qty, 0) AS reserved, i.sale_price, i.vat_rate, p.categories, p.image
        FROM stock_items i
        LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_reservations WHERE tenant_id = ? GROUP BY item_id) r ON r.item_id = i.id
        LEFT JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id
        WHERE i.tenant_id = ? AND i.archived = 0 AND ((i.shop_sync = 1 AND i.has_variants = 0 AND i.sale_price IS NOT NULL) OR i.has_variants = 1)`).all(tenantId, tenantId);
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
