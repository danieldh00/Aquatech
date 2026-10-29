// Tweerichtingssynchronisatie tussen de voorraadartikelen in Aquatech en de
// webshop (WooCommerce REST API, zie woocommerce.js). Per omgeving een eigen
// koppeling (instelling shopSource + versleutelde sleutels).
//
// Koppelen: een voorraadartikel hoort bij het webshopproduct met dezelfde
// code (handmatige koppeling code -> sku, het productveld aquatech_code, of
// sku = code), net als bij de catalogus van de planner (shop.js).
//
// Bij een volle synchronisatie is de webshop leidend voor de lijst zelf: elk
// webshopproduct met een code of sku wordt een voorraadartikel en artikelen
// die niet in de webshop staan worden gearchiveerd (stock.mirrorShop).
//
// Met shopSource.push aan is Aquatech de bron:
// - Prijs: de verkoopprijs (excl. btw) gaat naar de normale prijs van het
//   product (incl. btw als de webshop zo rekent, met het btw-tarief van het
//   artikel). Is de prijs in de webshop veranderd terwijl hij in Aquatech
//   gelijk bleef, dan neemt Aquatech die over (shop_price_seen = de prijs na
//   de vorige synchronisatie).
// - Voorraad (shopSource.pushStock): de webshop krijgt het beschikbare aantal
//   (stand − gereserveerd voor open werkorders, naar beneden afgerond). Is de
//   voorraad in de webshop sindsdien gedaald, dan is er via de webshop
//   verkocht: dat verschil wordt eerst in Aquatech afgeboekt (bron
//   'webshop'), daarna gaat de nieuwe stand terug. Bij de eerste koppeling
//   van een artikel met stand 0 neemt Aquatech de webshopvoorraad over.
// Met push uit blijft de webshop leidend: de prijs uit de webshop wordt de
// verkoopprijs in Aquatech.
//
// Wanneer: na elke wijziging van prijs of stand (alleen de gewijzigde
// artikelen, enkele seconden later, schedule()), elke 10 minuten alles
// (runAll() vanuit server.js) en met de knop in Beheer > Webshop.
const { transaction } = require('../database/db');
const { fetchProducts, updateProducts, SourceError } = require('./woocommerce');

const DEBOUNCE_MS = 3000;
/**
 * Rondt af op twee decimalen.
 * @param {number} value Het getal.
 * @returns {number} Afgerond.
 */
const round2 = (value) => Math.round(value * 100) / 100;
/**
 * Maakt een sku of code vergelijkbaar (getrimd, hoofdletters).
 * @param {*} value De sku of code.
 * @returns {string} De sleutel.
 */
const normalizeKey = (value) => String(value || '').trim().toUpperCase();

/**
 * Rekent een prijs uit de webshop (zoals opgeslagen) om naar excl. btw met het tarief van het artikel.
 * @param {number} raw Prijs zoals de webshop hem opslaat.
 * @param {number} vatRate Btw-tarief van het artikel.
 * @param {object} shopConfig De koppelinstelling (pricesIncludeTax).
 * @returns {number} Prijs excl. btw.
 */
const exclOf = (raw, vatRate, shopConfig) => round2(shopConfig.pricesIncludeTax ? raw / (1 + (Number(vatRate) || 0) / 100) : raw);
/**
 * Rekent een prijs excl. btw om naar hoe de webshop hem opslaat.
 * @param {number} excl Prijs excl. btw.
 * @param {number} vatRate Btw-tarief van het artikel.
 * @param {object} shopConfig De koppelinstelling (pricesIncludeTax).
 * @returns {number} Prijs voor de webshop.
 */
const rawOf = (excl, vatRate, shopConfig) => round2(shopConfig.pricesIncludeTax ? excl * (1 + (Number(vatRate) || 0) / 100) : excl);

/**
 * Maakt de tweerichtingssynchronisatie tussen voorraadartikelen en webshop.
 * @param {object} ctx db, shop (shop.js), stock (stock.js), settingsFor(tenantId), fetchImpl en log.
 * @returns {{ sync: Function, run: Function, schedule: Function, runAll: Function, exclOf: Function, rawOf: Function }} De synchronisatiefuncties.
 */
function createShopSync({ db, shop, stock, settingsFor, fetchImpl, log = console }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  const running = new Map();
  const timers = new Map();

  /**
   * De koppelinstelling van een omgeving met de sleutels.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} shopSource plus consumerKey en consumerSecret.
   */
  const configOf = (tenantId) => {
    const settings = settingsFor(tenantId);
    const source = settings.get('shopSource');
    return { ...source, consumerKey: settings.get('shopConsumerKey'), consumerSecret: settings.get('shopConsumerSecret') };
  };

  /**
   * Voorraadartikelen die met de webshop meedoen, met gereserveerd aantal en of er al boekingen zijn.
   * @param {string} tenantId Id van de omgeving.
   * @param {boolean} onlyDirty Alleen gewijzigde, al gekoppelde artikelen.
   * @returns {object[]} De artikelrijen.
   */
  const itemsOf = (tenantId, onlyDirty) => prepare(`SELECT i.id, i.code, i.on_hand, i.sale_price, i.vat_rate, i.shop_product_id, i.shop_dirty,
      i.shop_price_seen, i.shop_stock_seen, COALESCE(r.qty, 0) AS reserved,
      EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id = i.tenant_id AND m.item_id = i.id) AS moved
    FROM stock_items i
    LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_reservations WHERE tenant_id = ? GROUP BY item_id) r ON r.item_id = i.id
    WHERE i.tenant_id = ? AND i.archived = 0 AND i.shop_sync = 1${onlyDirty ? ' AND i.shop_dirty = 1 AND i.shop_product_id IS NOT NULL' : ''}`)
    .all(tenantId, tenantId);

  /**
   * Maakt een functie die bij een voorraadartikel het webshopproduct zoekt
   * (handmatige koppeling code → sku, aquatech_code, of sku = code).
   * @param {object[]} products De webshopproducten.
   * @param {object} [mapping] Handmatige koppeling code → sku.
   * @returns {Function} item → product of null.
   */
  function matcher(products, mapping = {}) {
    const byId = new Map(), bySku = new Map(), byCode = new Map();
    for (const product of products) {
      byId.set(String(product.id), product);
      if (product.sku && !bySku.has(normalizeKey(product.sku))) bySku.set(normalizeKey(product.sku), product);
      if (product.code && !byCode.has(normalizeKey(product.code))) byCode.set(normalizeKey(product.code), product);
    }
    const byMapping = new Map(Object.entries(mapping || {}).map(([code, sku]) => [normalizeKey(code), normalizeKey(sku)]));
    return (item) => {
      const linked = item.shop_product_id && byId.get(String(item.shop_product_id));
      if (linked) return linked;
      const mappedSku = byMapping.get(item.code);
      return (mappedSku && bySku.get(mappedSku)) || byCode.get(item.code) || bySku.get(item.code) || null;
    };
  }

  /**
   * Eén synchronisatie: voorraad en prijs uit de webshop verwerken en terugschrijven wat er veranderd is.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ full?: boolean, user?: object }} [options] full: alle producten ophalen (en de catalogus bijwerken), anders alleen de gewijzigde, gekoppelde artikelen; user voor de voorraadboekingen.
   * @returns {Promise<object>} Samenvatting (created, restored, archived, skipped, linked, unlinked, soldInShop, pricesFromShop, updated, failed) of { skipped }.
   */
  async function sync(tenantId, { full = true, user = null } = {}) {
    const shopConfig = configOf(tenantId);
    if (!shopConfig.url) return { skipped: 'not_configured' };
    if (!full && !shopConfig.push) return { skipped: 'no_push' };
    const dirtyItems = full ? null : itemsOf(tenantId, true);
    if (!full && !dirtyItems.length) return { skipped: 'nothing' };
    const products = full
      ? await fetchProducts(shopConfig, { fetchImpl })
      : await fetchProducts(shopConfig, { fetchImpl, ids: dirtyItems.map((item) => item.shop_product_id) });
    if (full) shop.replaceProducts(tenantId, products, new Date().toISOString());
    const match = matcher(products, shopConfig.mapping);
    const mirrored = full && shopConfig.mirror !== false ? stock.mirrorShop(tenantId, products, match) : null;
    const items = full ? itemsOf(tenantId, false) : dirtyItems;
    const byId = new Map(products.map((product) => [String(product.id), product]));
    const pushStock = Boolean(shopConfig.push && shopConfig.pushStock !== false && shopConfig.mode === 'rest');
    const summary = { created: 0, restored: 0, archived: 0, skipped: 0, ...mirrored, linked: 0, unlinked: 0, soldInShop: 0, pricesFromShop: 0, updated: 0, failed: 0 };
    const updates = [];
    const timestamp = new Date().toISOString();

    transaction(db, () => {
      for (const item of items) {
        const product = (item.shop_product_id && byId.get(String(item.shop_product_id))) || (full ? match(item) : null);
        if (!product) {
          if (full && item.shop_product_id) {
            prepare(`UPDATE stock_items SET shop_product_id = NULL, shop_price_seen = NULL, shop_stock_seen = NULL, shop_dirty = 0,
              shop_error = 'Niet (meer) gevonden in de webshop.' WHERE tenant_id = ? AND id = ?`).run(tenantId, item.id);
            summary.unlinked++;
          }
          continue;
        }
        const first = String(item.shop_product_id || '') !== String(product.id);
        if (first) summary.linked++;
        let onHand = Number(item.on_hand) || 0;
        let salePrice = item.sale_price == null ? null : Number(item.sale_price);
        let priceSeen = first ? null : item.shop_price_seen;
        let stockSeen = first ? null : item.shop_stock_seen;

        // 1. Voorraad uit de webshop: verkocht (of aangepast) sinds de vorige keer.
        if (pushStock && product.stockQty != null) {
          if (stockSeen != null && product.stockQty !== Number(stockSeen)) {
            const delta = product.stockQty - Number(stockSeen);
            stock.book(tenantId, item.id, delta, {
              kind: delta < 0 ? 'afboeking' : 'correctie', source: 'webshop', user,
              note: delta < 0 ? `Verkocht via de webshop (${-delta})` : 'Voorraad aangepast in de webshop',
            });
            onHand += delta;
            if (delta < 0) summary.soldInShop += -delta;
          } else if (stockSeen == null && onHand === 0 && !Number(item.moved) && product.stockQty > 0) {
            stock.book(tenantId, item.id, product.stockQty, { kind: 'telling', source: 'webshop', user, note: 'Beginstand uit de webshop' });
            onHand = product.stockQty;
          }
        }

        // 2. Prijs.
        const raw = product.rawRegular != null ? product.rawRegular : null;
        if (raw != null) {
          const shopChanged = priceSeen != null && Math.abs(raw - Number(priceSeen)) >= 0.005 && !Number(item.shop_dirty);
          if (!shopConfig.push || salePrice == null || shopChanged) {
            const excl = exclOf(raw, item.vat_rate, shopConfig);
            if (salePrice == null || Math.abs(excl - salePrice) >= 0.005) {
              prepare('UPDATE stock_items SET sale_price = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(excl, timestamp, tenantId, item.id);
              salePrice = excl;
              summary.pricesFromShop++;
            }
          }
        }

        // 3. Wat de webshop moet krijgen.
        const update = { id: String(product.id), itemId: item.id };
        if (shopConfig.push && salePrice != null) {
          const want = rawOf(salePrice, item.vat_rate, shopConfig);
          if (raw == null || Math.abs(want - raw) >= 0.005) { update.price = salePrice; update.vatRate = item.vat_rate; }
          update.priceSeen = want;
        } else {
          update.priceSeen = raw;
        }
        if (pushStock) {
          const want = Math.max(0, Math.floor(onHand - Number(item.reserved || 0) + 1e-9));
          if (product.stockQty == null || product.stockQty !== want) update.stockQty = want;
          update.stockSeen = want;
        } else {
          update.stockSeen = product.stockQty;
        }
        prepare(`UPDATE stock_items SET shop_product_id = ?, shop_synced_at = ?, shop_error = '' WHERE tenant_id = ? AND id = ?`).run(String(product.id), timestamp, tenantId, item.id);
        updates.push(update);
      }
    });

    // 4. Terugschrijven (buiten de transactie: dat is een netwerkverzoek).
    const send = updates.filter((update) => update.price != null || update.stockQty != null);
    let results = new Map();
    let sendError = null;
    if (send.length) {
      try {
        results = new Map((await updateProducts(shopConfig, send, { fetchImpl })).map((result) => [result.id, result]));
      } catch (error) {
        if (!(error instanceof SourceError)) throw error;
        sendError = error.message;
      }
    }
    transaction(db, () => {
      for (const update of updates) {
        const sent = update.price != null || update.stockQty != null;
        const result = sent ? results.get(update.id) : { ok: true };
        if (result && result.ok) {
          if (sent) summary.updated++;
          prepare(`UPDATE stock_items SET shop_price_seen = ?, shop_stock_seen = ?, shop_dirty = 0, shop_error = '', shop_synced_at = ?
            WHERE tenant_id = ? AND id = ?`).run(update.priceSeen ?? null, update.stockSeen ?? null, timestamp, tenantId, update.itemId);
        } else {
          summary.failed++;
          prepare("UPDATE stock_items SET shop_dirty = 1, shop_error = ? WHERE tenant_id = ? AND id = ?")
            .run(String(sendError || (result && result.error) || 'Niet bijgewerkt in de webshop.').slice(0, 300), tenantId, update.itemId);
        }
      }
    });
    if (sendError) shop.setStatus(tenantId, { error: sendError });
    return summary;
  }

  /**
   * Eén synchronisatie tegelijk per omgeving; een volgende wacht op de lopende.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} [options] Zie sync.
   * @returns {Promise<object>} Het resultaat van sync.
   */
  function run(tenantId, options = {}) {
    const previous = running.get(tenantId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => sync(tenantId, options));
    running.set(tenantId, next);
    next.finally(() => { if (running.get(tenantId) === next) running.delete(tenantId); }).catch(() => {});
    return next;
  }

  /**
   * Na een wijziging: over enkele seconden de gewijzigde artikelen naar de webshop.
   * @param {string} tenantId Id van de omgeving.
   */
  function schedule(tenantId) {
    if (timers.has(tenantId)) return;
    let shopConfig;
    try { shopConfig = configOf(tenantId); } catch { return; }
    if (!shopConfig.url || !shopConfig.push) return;
    const timer = setTimeout(() => {
      timers.delete(tenantId);
      run(tenantId, { full: false }).catch((error) => log.warn(`Webshop (${tenantId}): terugschrijven mislukt: ${error.code || error.message}`));
    }, DEBOUNCE_MS);
    if (timer.unref) timer.unref();
    timers.set(tenantId, timer);
  }

  /**
   * Synchroniseert alle omgevingen met een webshopkoppeling (elke 10 minuten vanuit server.js).
   * @param {string[]} tenantIds De omgevingen.
   * @returns {Promise<object>} Resultaat per omgeving.
   */
  async function runAll(tenantIds) {
    const out = {};
    for (const id of tenantIds) {
      let shopConfig;
      try { shopConfig = configOf(id); } catch { continue; }
      if (!shopConfig.url) continue;
      try {
        out[id] = await run(id, { full: true });
      } catch (error) {
        log.warn(`Webshop (${id}): synchronisatie mislukt: ${error.code || error.message}`);
        if (error instanceof SourceError) shop.setStatus(id, { error: error.message });
      }
    }
    return out;
  }

  return { sync, run, schedule, runAll, exclOf, rawOf };
}

module.exports = { createShopSync, exclOf, rawOf };
