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
const vm = require('vm');
const { transaction } = require('./db');
const { fetchProducts, normalizeBaseUrl, sanitizeShop, SourceError } = require('./woocommerce');

const CATALOG_FILE = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js', 'catalog.js');

let articles = null;
/** Interne artikelen uit de frontend-catalogus (één bron van waarheid). */
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

const key = (s) => String(s || '').trim().toUpperCase();

function matchProducts(products, arts, mapping = {}) {
  const bySku = new Map();
  const byCode = new Map();
  for (const p of products) {
    if (p.sku && !bySku.has(key(p.sku))) bySku.set(key(p.sku), p);
    if (p.code && !byCode.has(key(p.code))) byCode.set(key(p.code), p);
  }
  const matched = {};
  const unmatched = [];
  for (const code of Object.keys(arts)) {
    const viaMap = mapping[code] ? bySku.get(key(mapping[code])) : null;
    const p = viaMap || byCode.get(key(code)) || bySku.get(key(code));
    if (p && p.price != null) {
      matched[code] = { sku: p.sku, name: p.name, price: p.price, url: p.url, inStock: p.inStock, via: viaMap ? 'mapping' : byCode.get(key(code)) === p ? 'code' : 'sku' };
    } else {
      unmatched.push(code);
    }
  }
  return { matched, unmatched };
}

function createShopStore(db) {
  const q = (sql) => db.prepare(sql);

  function replaceProducts(tenantId, products, syncedAt) {
    transaction(db, () => {
      q('DELETE FROM shop_products WHERE tenant_id = ?').run(tenantId);
      const put = q(`INSERT INTO shop_products (tenant_id, id, sku, name, price, currency, url, image, in_stock, code, categories)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const seen = new Set();
      for (const p of products) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        put.run(tenantId, p.id, p.sku.slice(0, 100), p.name.slice(0, 300), p.price, p.currency.slice(0, 3), p.url.slice(0, 1000),
          p.image.slice(0, 1000), p.inStock ? 1 : 0, p.code.slice(0, 40), JSON.stringify(p.categories.slice(0, 20)));
      }
      setStatus(tenantId, { syncedAt, productCount: seen.size, error: null });
    });
  }

  function setStatus(tenantId, { syncedAt = null, productCount = null, error = null }) {
    const at = new Date().toISOString();
    q(`INSERT INTO shop_sync (tenant_id, synced_at, product_count, last_attempt_at, last_error) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id) DO UPDATE SET
        synced_at = COALESCE(excluded.synced_at, shop_sync.synced_at),
        product_count = COALESCE(excluded.product_count, shop_sync.product_count),
        last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error`).run(tenantId, syncedAt, productCount, at, error);
  }

  const status = (tenantId) => {
    const r = q('SELECT synced_at, product_count, last_attempt_at, last_error FROM shop_sync WHERE tenant_id = ?').get(tenantId);
    return r ? { syncedAt: r.synced_at, productCount: r.product_count || 0, lastAttemptAt: r.last_attempt_at, lastError: r.last_error } : null;
  };

  const products = (tenantId) => q('SELECT id, sku, name, price, currency, url, image, in_stock, code, categories FROM shop_products WHERE tenant_id = ?').all(tenantId).map((r) => ({
    id: r.id, sku: r.sku, name: r.name, price: r.price, currency: r.currency, url: r.url, image: r.image,
    inStock: Boolean(r.in_stock), code: r.code, categories: JSON.parse(r.categories || '[]'),
  }));

  function clear(tenantId) {
    q('DELETE FROM shop_products WHERE tenant_id = ?').run(tenantId);
    q('DELETE FROM shop_sync WHERE tenant_id = ?').run(tenantId);
  }

  return { replaceProducts, setStatus, status, products, clear };
}

/**
 * Routes:
 *   GET  /api/catalog          artikelen met webshopprijs (planner en offertes, iedereen die is ingelogd)
 *   GET  /api/admin/shop       koppeling en status (beheerder)
 *   PUT  /api/admin/shop       koppeling instellen
 *   POST /api/admin/shop/sync  producten nu ophalen
 * /api/admin/* staat in server.js al achter requireAdmin.
 */
function registerShopRoutes(app, { shop, requireUser, requireJson, settingsOf, tenantOf, audit, syncLimiter, fetchImpl, sync = null, salePrices = () => ({}) }) {
  const configured = (s) => Boolean(s.get('shopSource').url);

  // Verkoopprijzen uit voorraadbeheer gaan voor (Aquatech is de bron); de
  // webshopprijs alleen voor artikelen zonder eigen verkoopprijs.
  function withSalePrices(tenantId, articles) {
    const out = { ...articles };
    const arts = loadArticles();
    for (const [code, v] of Object.entries(salePrices(tenantId))) {
      if (v.salePrice == null || !arts[code]) continue;
      out[code] = { ...(out[code] || { sku: code, name: v.name, url: '', inStock: true }), price: v.salePrice, via: 'voorraad' };
    }
    return out;
  }

  function catalogOf(tenantId, settings) {
    const st = shop.status(tenantId);
    if (!configured(settings) || !st || !st.syncedAt) return { configured: configured(settings), syncedAt: null, articles: withSalePrices(tenantId, {}), unmatched: [] };
    const { matched, unmatched } = matchProducts(shop.products(tenantId), loadArticles(), settings.get('shopSource').mapping);
    return { configured: true, shop: settings.get('shopSource').url, syncedAt: st.syncedAt, productCount: st.productCount, articles: withSalePrices(tenantId, matched), unmatched };
  }

  app.get('/api/catalog', requireUser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(catalogOf(tenantOf(req), settingsOf(req)));
  });

  function adminView(req) {
    const s = settingsOf(req);
    const v = s.view();
    const cat = catalogOf(tenantOf(req), s);
    return {
      source: s.get('shopSource'),
      consumerKey: v.shopConsumerKey,
      consumerSecret: v.shopConsumerSecret,
      status: shop.status(tenantOf(req)),
      matchedCount: Object.keys(cat.articles).length,
      articleCount: Object.keys(loadArticles()).length,
      unmatched: cat.unmatched,
    };
  }

  app.get('/api/admin/shop', (req, res) => res.json(adminView(req)));

  app.put('/api/admin/shop', requireJson, (req, res) => {
    const b = req.body || {};
    // Eerst het webadres controleren met een duidelijke melding; sanitizeShop
    // laat een ongeldig adres stil vallen.
    if (b.url) {
      try { normalizeBaseUrl(b.url); } catch (err) { return res.status(400).json({ error: err.code, field: 'url', message: err.message }); }
    }
    const patch = { shopSource: sanitizeShop(b) };
    // Sleutels: weglaten = ongewijzigd, tekst = nieuw, '' = wissen (zoals bij de andere geheimen).
    for (const [field, k] of [['consumerKey', 'shopConsumerKey'], ['consumerSecret', 'shopConsumerSecret']]) {
      if (typeof b[field] === 'string' && (b[field].trim() || b.clearKeys)) patch[k] = b[field].trim();
    }
    const settings = settingsOf(req);
    if (patch.shopSource.mode !== 'rest' || b.clearKeys) {
      for (const k of ['shopConsumerKey', 'shopConsumerSecret']) if (settings.get(k)) patch[k] = '';
    }
    let changed;
    try {
      changed = settings.update(patch, req.user?.id);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_setting', field: err.field, message: err.message });
    }
    if (!patch.shopSource.url) shop.clear(tenantOf(req));
    if (changed.length) audit(req, 'instellingen_gewijzigd', { fields: changed });
    res.json(adminView(req));
  });

  app.post('/api/admin/shop/sync', syncLimiter, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const tenantId = tenantOf(req);
    const s = settingsOf(req);
    if (!configured(s)) return res.status(409).json({ error: 'not_configured', message: 'Stel eerst de webshop in.' });
    const cfg = { ...s.get('shopSource'), consumerKey: s.get('shopConsumerKey'), consumerSecret: s.get('shopConsumerSecret') };
    try {
      // Met voorraadbeheer: ook de voorraadartikelen in beide richtingen (shopsync.js).
      let stockSync = null;
      if (sync) {
        stockSync = await sync(tenantId, req.user);
      } else {
        shop.replaceProducts(tenantId, await fetchProducts(cfg, { fetchImpl }), new Date().toISOString());
      }
      const view = { ...adminView(req), stockSync };
      const count = view.status ? view.status.productCount : 0;
      console.log(`Webshop (${tenantId}): ${count} producten opgehaald, ${view.matchedCount} artikelen gekoppeld`);
      audit(req, 'webshop_gesynchroniseerd', { products: count, matched: view.matchedCount, ...(stockSync || {}) });
      res.json(view);
    } catch (err) {
      if (err instanceof SourceError) {
        shop.setStatus(tenantId, { error: err.message });
        console.warn(`Webshop (${tenantId}): ophalen mislukt: ${err.code}`);
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      next(err);
    }
  });
}

module.exports = { createShopStore, registerShopRoutes, matchProducts, loadArticles };
