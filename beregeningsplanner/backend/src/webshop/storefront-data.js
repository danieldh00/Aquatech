// Gegevens voor de eigen webshop (storefront.js): de publiceerbare artikelen
// uit de voorraad van een omgeving, met categorie en afbeelding uit de
// opgehaalde webshopproducten (shop_products). Alleen lezen; interne velden
// (inkoopprijs, locatie, notities, aantallen) komen er nooit in.

const crypto = require('crypto');
const { decodeHtmlEntities } = require('./html-entities');
const Wholesale = require('./wholesale');
const { DEFAULT_TREE, placeIn } = require('./category-tree');
const ItemDetails = require('../artikelen/item-details');

/** Hoe lang (ms) een opgebouwde catalogus per omgeving wordt hergebruikt. */
const CACHE_MS = 30 * 1000;
/** Hoogstens zoveel productpagina's met omschrijving in de cache. */
const DETAILS_CACHE_MAX = 2000;
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
 * Leest alle categorienamen uit het JSON-veld `categories` van een webshopproduct.
 * @param {*} categoriesJson De opgeslagen tekst, bijv. '["Sproeiers","Pop-up sproeiers"]'.
 * @returns {string[]} De namen (ontdaan van html-tekens), leeg bij ongeldige invoer.
 */
function categoryNamesOf(categoriesJson) {
  let names = [];
  try { names = JSON.parse(categoriesJson || '[]'); } catch { names = []; }
  return Array.isArray(names) ? names.map((name) => decodeHtmlEntities(name).trim()).filter(Boolean) : [];
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
 * De afbeelding van een artikel: de eigen afbeelding (als 'own:<id>'; de pagina
 * maakt er het adres van `artikelfoto/<id>` van) of anders het https-adres van
 * het gekoppelde webshopproduct.
 * @param {{ image_id?: string|null, image?: string|null }} row De artikelrij (image_id = eigen afbeelding, image = adres bij het webshopproduct).
 * @returns {string} 'own:<id>', een https-adres of ''.
 */
function imageOf(row) {
  return row.image_id && /^[0-9a-f-]{36}$/.test(String(row.image_id)) ? `own:${row.image_id}` : safeImageUrl(row.image);
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
 * Deelt de producten in categorieën in en bouwt de boom: categorieën uit de boom (met telling
 * inclusief subcategorieën, leeg = weggelaten) en losse categorieën voor wat niet in de boom
 * staat. Zet `categorySlug` op elk product en haalt de tijdelijke velden `categoryKey` en
 * `treeSlug` weg.
 * @param {object[]} products De producten (met categoryKey, categoryName, groupSlug en eventueel treeSlug).
 * @param {object[]} variantProducts De varianten als product (zelfde velden als hun hoofdartikel).
 * @param {object[]} tree De categorieboom.
 * @returns {{ categoryList: object[], groups: object[] }} Alle categorieën plat (op naam) en de hoofdcategorieën met hun bovenste categorieën.
 */
function arrangeCategories(products, variantProducts, tree) {
  const flat = new Map();
  const ownCounts = new Map();
  for (const product of products) {
    if (product.treeSlug) { ownCounts.set(product.treeSlug, (ownCounts.get(product.treeSlug) || 0) + 1); continue; }
    const category = flat.get(product.categoryKey) || { key: product.categoryKey, name: product.categoryName, count: 0, groupSlug: product.groupSlug };
    category.count += 1;
    flat.set(product.categoryKey, category);
  }
  assignCategorySlugs(flat);
  for (const product of [...products, ...variantProducts]) {
    product.categorySlug = product.treeSlug || flat.get(product.categoryKey).slug;
    delete product.categoryKey;
    delete product.treeSlug;
  }
  const entries = [];
  /**
   * Bouwt de categorie van een knoop en (eerst) haar subcategorieën.
   * @param {object} node De knoop uit de boom.
   * @param {number} depth Diepte (1 = bovenste categorie in een hoofdcategorie).
   * @param {string} groupSlug De hoofdcategorie.
   * @param {string} parentSlug De bovenliggende categorie (leeg = de hoofdcategorie zelf).
   * @returns {?object} De categorie, of null als er geen producten in zitten.
   */
  const build = (node, depth, groupSlug, parentSlug) => {
    const children = (node.children || []).map((child) => build(child, depth + 1, groupSlug, node.slug)).filter(Boolean);
    const ownCount = ownCounts.get(node.slug) || 0;
    const count = ownCount + children.reduce((total, child) => total + child.count, 0);
    if (!count) return null;
    const entry = { slug: node.slug, name: node.name, count, ownCount, groupSlug, parentSlug, depth, intro: node.intro || '', image: node.image || '', hidden: Boolean(node.hidden), loose: false, children };
    entries.push(entry);
    return entry;
  };
  const topOf = new Map();
  const rootOf = new Map();
  for (const root of tree) {
    rootOf.set(root.group, root);
    topOf.set(root.group, (root.children || []).map((child) => build(child, 1, root.group, '')).filter(Boolean));
  }
  for (const category of flat.values()) {
    const entry = { slug: category.slug, name: category.name, count: category.count, ownCount: category.count, groupSlug: category.groupSlug, parentSlug: '', depth: 1, intro: '', image: '', hidden: false, loose: true, children: [] };
    entries.push(entry);
    topOf.set(category.groupSlug, [...(topOf.get(category.groupSlug) || []), entry]);
  }
  const groups = [...GROUPS, OTHER_GROUP].map((group) => {
    // De volgorde uit de boom (Beheer) blijft staan; losse categorieën uit de webshop komen er alfabetisch achter.
    const inTree = (topOf.get(group.slug) || []).filter((category) => !category.loose);
    const loose = (topOf.get(group.slug) || []).filter((category) => category.loose).sort((left, right) => left.name.localeCompare(right.name, 'nl'));
    const members = [...inTree, ...loose];
    const root = rootOf.get(group.slug);
    return { slug: group.slug, name: root && root.name || group.name, categories: members, count: members.reduce((total, category) => total + category.count, 0), intro: root && root.intro || '', image: root && root.image || '' };
  }).filter((group) => group.categories.length);
  return { categoryList: entries.sort((left, right) => left.name.localeCompare(right.name, 'nl')), groups };
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
 * @param {object[]} rows Rijen met id, code, name, unit, on_hand, updated_at, sale_price, business_price, vat_rate, categories en image (en optioneel order_pack_size, order_min_qty en price_tiers: de groothandelsvoorwaarden); bij varianten parent_id en variant_values, bij hoofdartikelen has_variants=1 en attributes.
 * @param {Map<string, number>} [soldByCode] Het verkochte aantal per artikelcode (webshopverkopen), voor de meest verkochte producten.
 * @param {object[]} [tree] De categorieboom (standaard die van Aquatechshop.nl); producten waarvan een categorienaam in de boom staat komen in de diepste passende categorie.
 * @returns {{ products: object[], variantProducts: object[], categories: object[], groups: object[], featured: object[], bestsellers: object[] }} products (slug, code, name, unit, categorySlug, categoryName, groupSlug, priceExcl, priceIncl, vatRate, inStock, image; bij een hoofdartikel met varianten ook `variants` [{ slug, code, label, meta, priceIncl, inStock, image }] en `attributeName`, met de laagste prijs en op voorraad als een variant dat is) en categories (alle categorieën plat: slug, name, count = producten inclusief subcategorieën, ownCount, groupSlug, parentSlug, depth, intro, image, hidden en children = de subcategorieën als objecten) op naam gesorteerd; variantProducts = de varianten als gewoon product (met parentSlug en parentName); groups = hoofdcategorieën met hun bovenste categorieën (slug, name, categories, count, intro, image); featured = uitgelichte producten; bestsellers = de meest verkochte producten met foto (leeg zonder verkopen).
 */
function buildCatalog(rows, soldByCode = new Map(), tree = DEFAULT_TREE) {
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
   * Of een artikel op voorraad is: met voorraadbeheer stand min gereserveerd boven nul; zonder
   * voorraadbeheer (stock_managed = 0, bijvoorbeeld uit de webshop overgenomen zonder aantal) de
   * status uit het gekoppelde webshopproduct (zonder koppeling: op voorraad).
   * @param {object} row Artikelrij met on_hand, reserved, stock_managed en shop_in_stock.
   * @returns {boolean} true als te bestellen.
   */
  const stockOf = (row) => (Number(row.stock_managed) === 0
    ? row.shop_in_stock == null || Boolean(Number(row.shop_in_stock))
    : Math.round((Number(row.on_hand) - Number(row.reserved || 0)) * 1000) / 1000 > 0);

  /**
   * Bepaalt de plek van een product in de indeling: de diepste categorie uit de boom waarvan de
   * naam bij de categorieën van het webshopproduct past; anders de eerste categorienaam als losse
   * categorie in de hoofdcategorie die bij haar naam past. Staat alleen een hoofdcategorie genoemd,
   * dan komt het product in "Overig" van die hoofdcategorie.
   * @param {*} categoriesJson Het JSON-veld met categorienamen.
   * @returns {{ categoryKey: string, categoryName: string, groupSlug: string, treeSlug?: string }} De plek (categoryKey is voor het tellen en wordt later vervangen door categorySlug).
   */
  const placementOf = (categoriesJson) => {
    const names = categoryNamesOf(categoriesJson);
    const place = placeIn(tree, names);
    if (place && !place.root) return { categoryKey: `boom:${place.node.slug}`, categoryName: place.node.name, groupSlug: place.group, treeSlug: place.node.slug };
    if (place) return { categoryKey: `overig:${place.group}`, categoryName: FALLBACK_CATEGORY, groupSlug: place.group };
    const categoryName = names[0] || FALLBACK_CATEGORY;
    return { categoryKey: categoryName.toLowerCase(), categoryName, groupSlug: groupOf(categoryName).slug };
  };

  /**
   * Zet een rij van de database om in een product (zonder categorie-indeling).
   * @param {object} row De rij.
   * @returns {object} Het product.
   */
  const toProduct = (row) => {
    const priceExcl = Number(row.sale_price);
    const vatRate = Number(row.vat_rate ?? 21);
    // De prijs voor een zakelijke klant (excl. btw): de zakelijke prijs van het artikel, anders de gewone verkoopprijs.
    const priceBusiness = Math.round((row.business_price != null ? Number(row.business_price) : priceExcl) * 100) / 100;
    return {
      slug: uniqueSlug(row.name, row.code), code: String(row.code), name: decodeHtmlEntities(row.name), unit: String(row.unit || 'st'),
      ...placementOf(row.categories), priceExcl, vatRate,
      priceIncl: Math.round(priceExcl * (1 + vatRate / 100) * 100) / 100,
      priceBusiness, priceBusinessIncl: Math.round(priceBusiness * (1 + vatRate / 100) * 100) / 100,
      inStock: stockOf(row), image: imageOf(row), updatedAt: String(row.updated_at || '').slice(0, 10),
      // Groothandelsvoorwaarden (alleen gebruikt op de groothandelspagina's): verpakkingseenheid, minimale afname en staffels.
      packSize: Number(row.order_pack_size) || 1, minimum: Wholesale.minimumOf({ packSize: row.order_pack_size, orderMinQty: row.order_min_qty }), tiers: Wholesale.tiersOf(row.price_tiers),
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
    const cheapestBusiness = variants.reduce((lowest, variant) => (variant.priceBusiness < lowest.priceBusiness ? variant : lowest), variants[0]);
    const placement = parent.categories ? placementOf(parent.categories) : { categoryKey: variants[0].categoryKey, categoryName: variants[0].categoryName, groupSlug: variants[0].groupSlug, treeSlug: variants[0].treeSlug };
    const group = {
      slug: uniqueSlug(parent.name, parent.code), code: String(parent.code), name: decodeHtmlEntities(parent.name), unit: String(parent.unit || variants[0].unit),
      ...placement,
      priceExcl: cheapest.priceExcl, vatRate: cheapest.vatRate, priceIncl: cheapest.priceIncl,
      priceBusiness: cheapestBusiness.priceBusiness, priceBusinessIncl: cheapestBusiness.priceBusinessIncl,
      updatedAt: [String(parent.updated_at || '').slice(0, 10), ...variants.map((variant) => variant.updatedAt)].sort().pop(),
      inStock: variants.some((variant) => variant.inStock), image: imageOf(parent) || (variants.find((variant) => variant.image) || {}).image || '',
      attributeName: attributeNames.length === 1 ? attributeNames[0] : 'Uitvoeringen',
      variants: variants.map((variant) => ({
        slug: variant.slug, code: variant.code, label: Object.values(variant.values).join(' / ') || variant.code,
        meta: Object.entries(variant.values).map(([name, value]) => `${name}: ${value}`).join(' | '),
        priceIncl: variant.priceIncl, priceBusiness: variant.priceBusiness, priceBusinessIncl: variant.priceBusinessIncl, vatRate: variant.vatRate, inStock: variant.inStock, image: variant.image || imageOf(parent),
      })),
    };
    for (const variant of variants) {
      variant.parentSlug = group.slug;
      variant.categoryKey = group.categoryKey; variant.categoryName = group.categoryName; variant.groupSlug = group.groupSlug; variant.treeSlug = group.treeSlug;
    }
    listing.push(group);
  }
  const products = listing.sort(compareByName);
  const { categoryList, groups } = arrangeCategories(products, variantProducts, tree);
  /**
   * Het verkochte aantal van een product (bij een hoofdartikel de varianten samen).
   * @param {object} product Een product van de catalogus.
   * @returns {number} Het aantal.
   */
  const soldOf = (product) => (product.variants ? product.variants.reduce((total, variant) => total + (soldByCode.get(variant.code) || 0), 0) : soldByCode.get(product.code) || 0);
  const bestsellers = products.filter((product) => product.image && soldOf(product) > 0)
    .sort((left, right) => soldOf(right) - soldOf(left) || compareByName(left, right)).slice(0, FEATURED_COUNT);
  return { products, variantProducts, categories: categoryList, groups, featured: pickFeatured(products), bestsellers };
}

/**
 * Maakt de gegevenslaag van de webshop, met een korte cache per omgeving
 * (de pagina's zijn openbaar: niet bij elk bezoek een databasequery).
 * @param {object} db De database.
 * @param {{ treeOf?: Function }} [options] treeOf(tenantId, preview) = de categorieboom van een omgeving (uit Beheer; zonder de standaardboom).
 * @returns {{ catalogOf: Function, clearCache: Function }} catalogOf(tenantId, { preview }) en clearCache().
 */
function createStorefrontData(db, { treeOf = () => DEFAULT_TREE } = {}) {
  const cache = new Map();
  // Omschrijvingen per productpagina (en de hele feed) met dezelfde bewaartijd als de catalogus, zodat een
  // productpagina met een warme cache geen query kost (1 uit de audit van 1.7.3). Begrensd in aantal.
  const detailsCache = new Map();
  return {
    /**
     * De catalogus van een omgeving: niet-gearchiveerde voorraadartikelen met
     * verkoopprijs die naar de webshop mogen (shop_sync), met categorie en
     * afbeelding van het gekoppelde webshopproduct. Eén query.
     * @param {string} tenantId De omgeving.
     * @param {{ preview?: boolean }} [options] preview = met het concept van de categorieboom (niet onthouden).
     * @returns {{ products: object[], categories: object[], groups: object[], featured: object[], bestsellers: object[] }} Zie buildCatalog.
     */
    catalogOf(tenantId, { preview = false } = {}) {
      const tree = treeOf(tenantId, preview);
      const cached = !preview && cache.get(tenantId);
      // Een andere boom (na publiceren) geeft een nieuwe catalogus, ook binnen de cachetijd.
      if (cached && cached.until > Date.now() && cached.tree === tree) return cached.catalog;
      const rows = db.prepare(`SELECT i.id, i.code, i.name, i.unit, i.on_hand, i.stock_managed, p.in_stock AS shop_in_stock, i.parent_id, i.has_variants, i.attributes, i.variant_values, COALESCE(r.qty, 0) AS reserved, i.sale_price, i.business_price, i.vat_rate, i.image_id, i.order_pack_size, i.order_min_qty, i.price_tiers, i.updated_at, p.categories, p.image
        FROM stock_items i
        LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_reservations WHERE tenant_id = ? GROUP BY item_id) r ON r.item_id = i.id
        LEFT JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id
        WHERE i.tenant_id = ? AND i.archived = 0 AND ((i.shop_sync = 1 AND i.has_variants = 0 AND i.sale_price IS NOT NULL) OR i.has_variants = 1)`).all(tenantId, tenantId);
      // Meest verkocht: afboekingen van webshopverkopen (eigen bestellingen en de oude webshop) van de laatste 180 dagen.
      const since = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
      const sold = db.prepare(`SELECT i.code, SUM(-m.qty) AS qty FROM stock_movements m JOIN stock_items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
        WHERE m.tenant_id = ? AND m.created_at >= ? AND m.kind = 'afboeking' AND m.qty < 0 AND (m.source = 'webshop' OR m.source LIKE 'bestelling:%')
        GROUP BY i.code`).all(tenantId, since);
      const catalog = buildCatalog(rows, new Map(sold.map((row) => [String(row.code), Number(row.qty)])), tree);
      if (!preview) cache.set(tenantId, { catalog, tree, until: Date.now() + CACHE_MS });
      return catalog;
    },
    /**
     * Omschrijving en specificaties per artikelcode voor de productpagina of de feed (12): eigen tekst, anders die van
     * het webshopproduct, anders die van het hoofdartikel. Eén query (niet in de catalogus, want die staat in het geheugen).
     * @param {string} tenantId De omgeving.
     * @param {string[]|null} [codes] Alleen deze codes (de productpagina: het artikel en zijn varianten); null = alle artikelen (de feed).
     * @returns {Map<string, { description: string, specifications: object[] }>} Per code wat de shop toont.
     */
    detailsOf(tenantId, codes = null) {
      const wanted = Array.isArray(codes) ? [...new Set(codes.map(String))].slice(0, 500) : null;
      if (wanted && !wanted.length) return new Map();
      const cacheKey = `${tenantId}|${wanted ? wanted.join('|') : '*'}`;
      const hit = detailsCache.get(cacheKey);
      if (hit && hit.until > Date.now()) return hit.details;
      const details = readDetails(tenantId, wanted);
      if (detailsCache.size >= DETAILS_CACHE_MAX) detailsCache.delete(detailsCache.keys().next().value);
      detailsCache.set(cacheKey, { details, until: Date.now() + CACHE_MS });
      return details;
    },
    /**
     * Wist de cache (tests).
     * @returns {void}
     */
    clearCache() { cache.clear(); detailsCache.clear(); },
  };

  /**
   * Leest de omschrijving en specificaties uit de database (zie detailsOf).
   * @param {string} tenantId De omgeving.
   * @param {string[]|null} wanted De codes, of null voor alle artikelen.
   * @returns {Map<string, { description: string, specifications: object[] }>} Per code wat de shop toont.
   */
  function readDetails(tenantId, wanted) {
    const filter = wanted ? ` AND (i.code IN (${wanted.map(() => '?').join(',')}) OR i.id IN (SELECT v.parent_id FROM stock_items v WHERE v.tenant_id = ? AND v.code IN (${wanted.map(() => '?').join(',')})))` : '';
    const rows = db.prepare(`SELECT i.id, i.code, i.parent_id, i.description, i.specifications, p.description AS shop_description, p.attributes AS shop_attributes
      FROM stock_items i LEFT JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id
      WHERE i.tenant_id = ? AND i.archived = 0${filter}`).all(tenantId, ...(wanted ? [...wanted, tenantId, ...wanted] : []));
    const parents = new Map(rows.filter((row) => !row.parent_id).map((row) => [row.id, ItemDetails.shownDetails(row)]));
    return new Map(rows.map((row) => [row.code, row.parent_id ? ItemDetails.shownDetails(row, parents.get(row.parent_id) || null) : parents.get(row.id)]));
  }
}

const GROUP_SLUGS = [...GROUPS.map((group) => group.slug), OTHER_GROUP.slug];
/** Naam per hoofdcategorie (slug → naam), voor de keuzelijst in Beheer. */
const GROUP_NAMES = Object.fromEntries([...GROUPS, OTHER_GROUP].map((group) => [group.slug, group.name]));

module.exports = { GROUP_SLUGS, GROUP_NAMES, createStorefrontData, buildCatalog, slugify, categoryNameOf, groupOf, safeImageUrl, imageOf, CACHE_MS };
