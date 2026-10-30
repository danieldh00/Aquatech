// Webshopkoppeling: producten en prijzen uit de webshop van een tenant
// (prototype: WooCommerce, zie woocommerce.js). De koppeling staat in de
// instellingen van de tenant (shopSource; sleutels versleuteld in
// shopConsumerKey/shopConsumerSecret), de opgehaalde producten in tabel
// shop_products (migratie 11). Elke omgeving (ook een testomgeving) heeft een
// eigen koppeling en eigen producten.
//
// Producten worden aan de interne artikelcodes van de planner gekoppeld
// (frontend/beregening/js/catalog.js); de code blijft leidend voor de
// berekening, naam, prijs, sku en link komen uit de webshop. Volgorde:
// handmatige koppeling (code -> sku), het productveld aquatech_code, een sku
// gelijk aan de code.
const fs = require('fs');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const vm = require('vm');
const { transaction } = require('../database/db');
const { fetchProducts, normalizeBaseUrl, sanitizeShop, SourceError } = require('./woocommerce');

const CATALOG_FILE = path.join(FRONTEND_DIR, 'beregening', 'js', 'catalog.js');

let articles = null;
/**
 * Interne artikelen uit de frontend-catalogus (één bron van waarheid), één keer ingelezen.
 * @returns {object} Artikelcode → artikel.
 */
function loadArticles() {
  if (!articles) {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(path.dirname(CATALOG_FILE), 'sprinklerlib.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(CATALOG_FILE, 'utf8'), sandbox);
    articles = JSON.parse(JSON.stringify(sandbox.window.Catalog.articles));
  }
  return articles;
}

/**
 * Maakt een sku of code vergelijkbaar (getrimd, hoofdletters).
 * @param {*} value De sku of code.
 * @returns {string} De sleutel.
 */
const normalizeKey = (value) => String(value || '').trim().toUpperCase();

/**
 * Koppelt webshopproducten aan de interne artikelcodes. Volgorde: handmatige
 * koppeling (code → sku), het productveld aquatech_code, een sku gelijk aan de code.
 * @param {object[]} products De webshopproducten.
 * @param {object} articleMap Artikelcode → artikel (loadArticles).
 * @param {object} [mapping] Handmatige koppeling code → sku.
 * @returns {{ matched: object, unmatched: string[] }} Per code het gekoppelde product (met prijs) en de codes zonder product.
 */
function matchProducts(products, articleMap, mapping = {}) {
  const bySku = new Map();
  const byCode = new Map();
  for (const product of products) {
    if (product.sku && !bySku.has(normalizeKey(product.sku))) bySku.set(normalizeKey(product.sku), product);
    if (product.code && !byCode.has(normalizeKey(product.code))) byCode.set(normalizeKey(product.code), product);
  }
  const matched = {};
  const unmatched = [];
  for (const code of Object.keys(articleMap)) {
    const viaMap = mapping[code] ? bySku.get(normalizeKey(mapping[code])) : null;
    const product = viaMap || byCode.get(normalizeKey(code)) || bySku.get(normalizeKey(code));
    if (product && product.price != null) {
      matched[code] = { sku: product.sku, name: product.name, price: product.price, url: product.url, inStock: product.inStock, via: viaMap ? 'mapping' : byCode.get(normalizeKey(code)) === product ? 'code' : 'sku' };
    } else {
      unmatched.push(code);
    }
  }
  return { matched, unmatched };
}

/**
 * Maakt de opslag voor opgehaalde webshopproducten en de synchronisatiestand.
 * @param {object} db De database.
 * @returns {{ replaceProducts: Function, setStatus: Function, status: Function, products: Function, clear: Function }} De opslagfuncties.
 */
function createShopStore(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Kiest de kenmerken die bewaard worden: eerst alle variatiekenmerken (die zijn nodig voor
   * de varianten), daarna de overige, samen hooguit twintig.
   * @param {object[]} attributes De kenmerken van het product.
   * @returns {object[]} De te bewaren kenmerken.
   */
  function attributesToKeep(attributes) {
    const list = Array.isArray(attributes) ? attributes : [];
    return [...list.filter((attribute) => attribute.variation), ...list.filter((attribute) => !attribute.variation)].slice(0, 20);
  }

  /**
   * Vervangt alle opgehaalde producten van een tenant in één transactie.
   * @param {string} tenantId Id van de tenant.
   * @param {object[]} products De producten (fetchProducts).
   * @param {string} syncedAt Moment van ophalen.
   */
  function replaceProducts(tenantId, products, syncedAt) {
    transaction(db, () => {
      prepare('DELETE FROM shop_products WHERE tenant_id = ?').run(tenantId);
      const insert = prepare(`INSERT INTO shop_products (tenant_id, id, sku, name, price, currency, url, image, in_stock, code, categories, parent_id, attributes, type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const seen = new Set();
      for (const product of products) {
        if (seen.has(product.id)) continue;
        seen.add(product.id);
        insert.run(tenantId, product.id, product.sku.slice(0, 100), product.name.slice(0, 300), product.price, product.currency.slice(0, 3), product.url.slice(0, 1000),
          product.image.slice(0, 1000), product.inStock ? 1 : 0, product.code.slice(0, 40), JSON.stringify(product.categories.slice(0, 20)),
          product.parentId ? String(product.parentId) : null, JSON.stringify(attributesToKeep(product.attributes)),
          product.parentId ? 'variation' : product.type === 'variable' ? 'variable' : 'simple');
      }
      setStatus(tenantId, { syncedAt, productCount: seen.size, error: null });
    });
  }

  /**
   * Legt de stand van de laatste synchronisatie vast; lege velden houden hun waarde.
   * @param {string} tenantId Id van de tenant.
   * @param {{ syncedAt?: string, productCount?: number, error?: string }} result Moment, aantal producten en foutmelding.
   */
  function setStatus(tenantId, { syncedAt = null, productCount = null, error = null }) {
    const timestamp = new Date().toISOString();
    prepare(`INSERT INTO shop_sync (tenant_id, synced_at, product_count, last_attempt_at, last_error) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id) DO UPDATE SET
        synced_at = COALESCE(excluded.synced_at, shop_sync.synced_at),
        product_count = COALESCE(excluded.product_count, shop_sync.product_count),
        last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error`).run(tenantId, syncedAt, productCount, timestamp, error);
  }

  /**
   * De stand van de laatste synchronisatie.
   * @param {string} tenantId Id van de tenant.
   * @returns {object|null} syncedAt, productCount, lastAttemptAt en lastError, of null.
   */
  const status = (tenantId) => {
    const row = prepare('SELECT synced_at, product_count, last_attempt_at, last_error FROM shop_sync WHERE tenant_id = ?').get(tenantId);
    return row ? { syncedAt: row.synced_at, productCount: row.product_count || 0, lastAttemptAt: row.last_attempt_at, lastError: row.last_error } : null;
  };

  /**
   * De opgehaalde producten van een tenant, met variaties (parentId = het
   * variabele product erboven; type 'variable' voor een variabel product).
   * @param {string} tenantId Id van de tenant.
   * @returns {object[]} De producten.
   */
  const products = (tenantId) => {
    const rows = prepare('SELECT id, sku, name, price, currency, url, image, in_stock, code, categories, parent_id, attributes, type FROM shop_products WHERE tenant_id = ?').all(tenantId);
    const parents = new Set(rows.filter((row) => row.parent_id).map((row) => String(row.parent_id)));
    return rows.map((row) => ({
      id: row.id, sku: row.sku, name: row.name, price: row.price, currency: row.currency, url: row.url, image: row.image,
      inStock: Boolean(row.in_stock), code: row.code, categories: JSON.parse(row.categories || '[]'),
      parentId: row.parent_id || null, attributes: JSON.parse(row.attributes || '[]'),
      // Bewaard type van de webshop (ook een variabel product zonder variaties). Rijen van vóór
      // migratie 33 hebben nog geen type: 'unknown' tot de volgende synchronisatie.
      type: row.parent_id ? 'variation' : row.type === 'variable' || parents.has(String(row.id)) ? 'variable' : row.type === 'simple' ? 'simple' : 'unknown',
    }));
  };

  /**
   * Wist de producten en de stand van een tenant (koppeling verwijderd).
   * @param {string} tenantId Id van de tenant.
   */
  function clear(tenantId) {
    prepare('DELETE FROM shop_products WHERE tenant_id = ?').run(tenantId);
    prepare('DELETE FROM shop_sync WHERE tenant_id = ?').run(tenantId);
  }

  return { replaceProducts, setStatus, status, products, clear };
}

/**
 * Registreert de routes: GET /api/catalog (artikelen met webshopprijs en
 * eigen assortiment, voor iedereen die is ingelogd) en /api/admin/shop[/sync]
 * (koppeling, status en nu ophalen; in server.js al achter requireAdmin).
 * @param {object} app De Express-app.
 * @param {object} ctx shop, requireUser, requireJson, settingsOf, tenantOf, audit, syncLimiter, fetchImpl, sync, salePrices en libraryCodes.
 */
function registerShopRoutes(app, { shop, requireUser, requireJson, settingsOf, tenantOf, audit, syncLimiter, fetchImpl, sync = null, salePrices = () => ({}), libraryCodes = () => [] }) {
  /**
   * Of er een webshop is ingesteld.
   * @param {object} settings De instellingen van de tenant.
   * @returns {boolean} True als er een webadres is.
   */
  const configured = (settings) => Boolean(settings.get('shopSource').url);

  /**
   * Maakt een controle of een code een plannercode is. Ook de eigen
   * behuizingen en nozzles uit de sproeierbibliotheek tellen mee; die worden
   * alleen opgevraagd als er een onbekende code is.
   * @param {string} tenantId Id van de tenant.
   * @param {object} sale Verkoopprijzen per code (voorraadbeheer).
   * @returns {Function} code → boolean.
   */
  function knownCodes(tenantId, sale) {
    const articleMap = loadArticles();
    let extra = null;
    return (code) => {
      if (articleMap[code]) return true;
      if (!extra) extra = new Set(Object.keys(sale).some((saleCode) => !articleMap[saleCode]) ? libraryCodes(tenantId) : []);
      return extra.has(code);
    };
  }

  /**
   * Legt de verkoopprijzen uit voorraadbeheer over de artikelen (Aquatech is de
   * bron); de webshopprijs alleen voor artikelen zonder eigen verkoopprijs.
   * @param {string} tenantId Id van de tenant.
   * @param {object} articles Gekoppelde artikelen per code.
   * @param {object} [sale] Verkoopprijzen per code.
   * @param {Function} [known] Controle op plannercodes (knownCodes).
   * @returns {object} Artikelen per code met prijs en herkomst.
   */
  function withSalePrices(tenantId, articles, sale = salePrices(tenantId), known = knownCodes(tenantId, sale)) {
    const out = { ...articles };
    for (const [code, item] of Object.entries(sale)) {
      if (item.salePrice == null || !known(code)) continue;
      out[code] = { ...(out[code] || { sku: code, name: item.name, url: '', inStock: true }), price: item.salePrice, via: 'voorraad' };
    }
    return out;
  }

  /**
   * Eigen assortiment: de plannercodes die de organisatie als product heeft
   * (voorraadartikel of gekoppeld webshopproduct). Met een assortiment gebruikt
   * de planner alleen die artikelen; zonder (leeg) de standaardcatalogus.
   * @param {object} sale Verkoopprijzen per code.
   * @param {object} matched Gekoppelde webshopproducten per code.
   * @param {Function} known Controle op plannercodes.
   * @returns {{ assortment: string[], unknownCodes: number }} De codes en het aantal onbekende voorraadcodes.
   */
  function assortmentOf(sale, matched, known) {
    const codes = new Set(Object.keys(matched));
    let unknown = 0;
    for (const code of Object.keys(sale)) {
      if (known(code)) codes.add(code);
      else unknown++;
    }
    return { assortment: [...codes].sort(), unknownCodes: unknown };
  }

  /**
   * De catalogus voor planner en offertes: prijzen, assortiment en ongekoppelde codes.
   * @param {string} tenantId Id van de tenant.
   * @param {object} settings De instellingen van de tenant.
   * @returns {object} configured, shop, syncedAt, productCount, articles, unmatched, assortment en unknownCodes.
   */
  function catalogOf(tenantId, settings) {
    const syncStatus = shop.status(tenantId);
    const sale = salePrices(tenantId);
    const known = knownCodes(tenantId, sale);
    if (!configured(settings) || !syncStatus || !syncStatus.syncedAt) {
      return { configured: configured(settings), syncedAt: null, articles: withSalePrices(tenantId, {}, sale, known), unmatched: [], ...assortmentOf(sale, {}, known) };
    }
    const { matched, unmatched } = matchProducts(shop.products(tenantId), loadArticles(), settings.get('shopSource').mapping);
    return {
      configured: true, shop: settings.get('shopSource').url, syncedAt: syncStatus.syncedAt, productCount: syncStatus.productCount,
      articles: withSalePrices(tenantId, matched, sale, known), unmatched, ...assortmentOf(sale, matched, known),
    };
  }

  app.get('/api/catalog', requireUser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(catalogOf(tenantOf(req), settingsOf(req)));
  });

  /**
   * De koppeling en de stand voor Beheer → Integraties → Webshop (sleutels alleen als "ingesteld" met de laatste tekens).
   * @param {object} req Het Express-verzoek.
   * @returns {object} source, consumerKey, consumerSecret, status, matchedCount, articleCount en unmatched.
   */
  function adminView(req) {
    const settings = settingsOf(req);
    const secrets = settings.view();
    const catalog = catalogOf(tenantOf(req), settings);
    return {
      source: settings.get('shopSource'),
      consumerKey: secrets.shopConsumerKey,
      consumerSecret: secrets.shopConsumerSecret,
      status: shop.status(tenantOf(req)),
      matchedCount: Object.keys(catalog.articles).length,
      articleCount: Object.keys(loadArticles()).length,
      unmatched: catalog.unmatched,
    };
  }

  app.get('/api/admin/shop', (req, res) => res.json(adminView(req)));

  app.put('/api/admin/shop', requireJson, (req, res) => {
    const body = req.body || {};
    // Eerst het webadres controleren met een duidelijke melding; sanitizeShop
    // laat een ongeldig adres stil vallen.
    if (body.url) {
      try { normalizeBaseUrl(body.url); } catch (error) { return res.status(400).json({ error: error.code, field: 'url', message: error.message }); }
    }
    const patch = { shopSource: sanitizeShop(body) };
    // Sleutels: weglaten = ongewijzigd, tekst = nieuw, '' = wissen (zoals bij de andere geheimen).
    for (const [field, settingKey] of [['consumerKey', 'shopConsumerKey'], ['consumerSecret', 'shopConsumerSecret']]) {
      if (typeof body[field] === 'string' && (body[field].trim() || body.clearKeys)) patch[settingKey] = body[field].trim();
    }
    const settings = settingsOf(req);
    if (patch.shopSource.mode !== 'rest' || body.clearKeys) {
      for (const settingKey of ['shopConsumerKey', 'shopConsumerSecret']) if (settings.get(settingKey)) patch[settingKey] = '';
    }
    let changed;
    try {
      changed = settings.update(patch, req.user?.id);
    } catch (error) {
      return res.status(400).json({ error: 'invalid_setting', field: error.field, message: error.message });
    }
    if (!patch.shopSource.url) shop.clear(tenantOf(req));
    if (changed.length) audit(req, 'instellingen_gewijzigd', { fields: changed });
    res.json(adminView(req));
  });

  app.post('/api/admin/shop/sync', syncLimiter, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const tenantId = tenantOf(req);
    const settings = settingsOf(req);
    if (!configured(settings)) return res.status(409).json({ error: 'not_configured', message: 'Stel eerst de webshop in.' });
    const shopConfig = { ...settings.get('shopSource'), consumerKey: settings.get('shopConsumerKey'), consumerSecret: settings.get('shopConsumerSecret') };
    try {
      // Met voorraadbeheer: ook de voorraadartikelen in beide richtingen (shop-sync.js).
      let stockSync = null;
      if (sync) {
        stockSync = await sync(tenantId, req.user);
      } else {
        shop.replaceProducts(tenantId, await fetchProducts(shopConfig, { fetchImpl }), new Date().toISOString());
      }
      const view = { ...adminView(req), stockSync };
      const count = view.status ? view.status.productCount : 0;
      console.log(`Webshop (${tenantId}): ${count} producten opgehaald, ${view.matchedCount} artikelen gekoppeld`);
      audit(req, 'webshop_gesynchroniseerd', { products: count, matched: view.matchedCount, ...(stockSync || {}) });
      res.json(view);
    } catch (error) {
      if (error instanceof SourceError) {
        shop.setStatus(tenantId, { error: error.message });
        console.warn(`Webshop (${tenantId}): ophalen mislukt: ${error.code}`);
        return res.status(error.status).json({ error: error.code, message: error.message });
      }
      next(error);
    }
  });
}

module.exports = { createShopStore, registerShopRoutes, matchProducts, loadArticles };
