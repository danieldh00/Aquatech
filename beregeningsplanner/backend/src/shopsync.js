// Tweerichtingssynchronisatie tussen de voorraadartikelen in Aquatech en de
// webshop (WooCommerce REST API, zie woocommerce.js). Per omgeving een eigen
// koppeling (instelling shopSource + versleutelde sleutels).
//
// Koppelen: een voorraadartikel hoort bij het webshopproduct met dezelfde
// code (handmatige koppeling code -> sku, het productveld aquatech_code, of
// sku = code), net als bij de catalogus van de planner (shop.js).
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
const { transaction } = require('./db');
const { fetchProducts, updateProducts, SourceError } = require('./woocommerce');

const DEBOUNCE_MS = 3000;
const round2 = (n) => Math.round(n * 100) / 100;
const key = (s) => String(s || '').trim().toUpperCase();

/** Prijs in de webshop (zoals opgeslagen) omrekenen naar excl. btw met het tarief van het artikel. */
const exclOf = (raw, vatRate, cfg) => round2(cfg.pricesIncludeTax ? raw / (1 + (Number(vatRate) || 0) / 100) : raw);
const rawOf = (excl, vatRate, cfg) => round2(cfg.pricesIncludeTax ? excl * (1 + (Number(vatRate) || 0) / 100) : excl);

function createShopSync({ db, shop, stock, settingsFor, fetchImpl, log = console }) {
  const q = (sql) => db.prepare(sql);
  const running = new Map();
  const timers = new Map();

  const configOf = (tenantId) => {
    const s = settingsFor(tenantId);
    const src = s.get('shopSource');
    return { ...src, consumerKey: s.get('shopConsumerKey'), consumerSecret: s.get('shopConsumerSecret') };
  };

  const itemsOf = (tenantId, onlyDirty) => q(`SELECT i.id, i.code, i.on_hand, i.sale_price, i.vat_rate, i.shop_product_id, i.shop_dirty,
      i.shop_price_seen, i.shop_stock_seen, COALESCE(r.qty, 0) AS reserved,
      EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id = i.tenant_id AND m.item_id = i.id) AS moved
    FROM stock_items i
    LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_reservations WHERE tenant_id = ? GROUP BY item_id) r ON r.item_id = i.id
    WHERE i.tenant_id = ? AND i.archived = 0 AND i.shop_sync = 1${onlyDirty ? ' AND i.shop_dirty = 1 AND i.shop_product_id IS NOT NULL' : ''}`)
    .all(tenantId, tenantId);

  function matcher(products, mapping = {}) {
    const byId = new Map(), bySku = new Map(), byCode = new Map();
    for (const p of products) {
      byId.set(String(p.id), p);
      if (p.sku && !bySku.has(key(p.sku))) bySku.set(key(p.sku), p);
      if (p.code && !byCode.has(key(p.code))) byCode.set(key(p.code), p);
    }
    const byMapping = new Map(Object.entries(mapping || {}).map(([c, sku]) => [key(c), key(sku)]));
    return (item) => {
      const m = byMapping.get(item.code);
      return (m && bySku.get(m)) || byCode.get(item.code) || bySku.get(item.code) || null;
    };
  }

  /**
   * Eén synchronisatie. full: alle producten ophalen (en de productlijst van
   * de catalogus bijwerken); anders alleen de gewijzigde, gekoppelde
   * artikelen. Geeft een samenvatting.
   */
  async function sync(tenantId, { full = true, user = null } = {}) {
    const cfg = configOf(tenantId);
    if (!cfg.url) return { skipped: 'not_configured' };
    if (!full && !cfg.push) return { skipped: 'no_push' };
    const items = itemsOf(tenantId, !full);
    if (!full && !items.length) return { skipped: 'nothing' };
    const products = full
      ? await fetchProducts(cfg, { fetchImpl })
      : await fetchProducts(cfg, { fetchImpl, ids: items.map((i) => i.shop_product_id) });
    if (full) shop.replaceProducts(tenantId, products, new Date().toISOString());
    const match = matcher(products, cfg.mapping);
    const byId = new Map(products.map((p) => [String(p.id), p]));
    const pushStock = Boolean(cfg.push && cfg.pushStock !== false && cfg.mode === 'rest');
    const summary = { linked: 0, unlinked: 0, soldInShop: 0, pricesFromShop: 0, updated: 0, failed: 0 };
    const updates = [];
    const t = new Date().toISOString();

    transaction(db, () => {
      for (const it of items) {
        const p = (it.shop_product_id && byId.get(String(it.shop_product_id))) || (full ? match(it) : null);
        if (!p) {
          if (full && it.shop_product_id) {
            q(`UPDATE stock_items SET shop_product_id = NULL, shop_price_seen = NULL, shop_stock_seen = NULL, shop_dirty = 0,
              shop_error = 'Niet (meer) gevonden in de webshop.' WHERE tenant_id = ? AND id = ?`).run(tenantId, it.id);
            summary.unlinked++;
          }
          continue;
        }
        const first = String(it.shop_product_id || '') !== String(p.id);
        if (first) summary.linked++;
        let onHand = Number(it.on_hand) || 0;
        let salePrice = it.sale_price == null ? null : Number(it.sale_price);
        let priceSeen = first ? null : it.shop_price_seen;
        let stockSeen = first ? null : it.shop_stock_seen;

        // 1. Voorraad uit de webshop: verkocht (of aangepast) sinds de vorige keer.
        if (pushStock && p.stockQty != null) {
          if (stockSeen != null && p.stockQty !== Number(stockSeen)) {
            const delta = p.stockQty - Number(stockSeen);
            stock.book(tenantId, it.id, delta, {
              kind: delta < 0 ? 'afboeking' : 'correctie', source: 'webshop', user,
              note: delta < 0 ? `Verkocht via de webshop (${-delta})` : 'Voorraad aangepast in de webshop',
            });
            onHand += delta;
            if (delta < 0) summary.soldInShop += -delta;
          } else if (stockSeen == null && onHand === 0 && !Number(it.moved) && p.stockQty > 0) {
            stock.book(tenantId, it.id, p.stockQty, { kind: 'telling', source: 'webshop', user, note: 'Beginstand uit de webshop' });
            onHand = p.stockQty;
          }
        }

        // 2. Prijs.
        const raw = p.rawRegular != null ? p.rawRegular : null;
        if (raw != null) {
          const shopChanged = priceSeen != null && Math.abs(raw - Number(priceSeen)) >= 0.005 && !Number(it.shop_dirty);
          if (!cfg.push || salePrice == null || shopChanged) {
            const excl = exclOf(raw, it.vat_rate, cfg);
            if (salePrice == null || Math.abs(excl - salePrice) >= 0.005) {
              q('UPDATE stock_items SET sale_price = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(excl, t, tenantId, it.id);
              salePrice = excl;
              summary.pricesFromShop++;
            }
          }
        }

        // 3. Wat de webshop moet krijgen.
        const u = { id: String(p.id), itemId: it.id };
        if (cfg.push && salePrice != null) {
          const want = rawOf(salePrice, it.vat_rate, cfg);
          if (raw == null || Math.abs(want - raw) >= 0.005) { u.price = salePrice; u.vatRate = it.vat_rate; }
          u.priceSeen = want;
        } else {
          u.priceSeen = raw;
        }
        if (pushStock) {
          const want = Math.max(0, Math.floor(onHand - Number(it.reserved || 0) + 1e-9));
          if (p.stockQty == null || p.stockQty !== want) u.stockQty = want;
          u.stockSeen = want;
        } else {
          u.stockSeen = p.stockQty;
        }
        q(`UPDATE stock_items SET shop_product_id = ?, shop_synced_at = ?, shop_error = '' WHERE tenant_id = ? AND id = ?`).run(String(p.id), t, tenantId, it.id);
        updates.push(u);
      }
    });

    // 4. Terugschrijven (buiten de transactie: dat is een netwerkverzoek).
    const send = updates.filter((u) => u.price != null || u.stockQty != null);
    let results = new Map();
    let sendError = null;
    if (send.length) {
      try {
        results = new Map((await updateProducts(cfg, send, { fetchImpl })).map((r) => [r.id, r]));
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        sendError = err.message;
      }
    }
    transaction(db, () => {
      for (const u of updates) {
        const sent = u.price != null || u.stockQty != null;
        const r = sent ? results.get(u.id) : { ok: true };
        if (r && r.ok) {
          if (sent) summary.updated++;
          q(`UPDATE stock_items SET shop_price_seen = ?, shop_stock_seen = ?, shop_dirty = 0, shop_error = '', shop_synced_at = ?
            WHERE tenant_id = ? AND id = ?`).run(u.priceSeen ?? null, u.stockSeen ?? null, t, tenantId, u.itemId);
        } else {
          summary.failed++;
          q("UPDATE stock_items SET shop_dirty = 1, shop_error = ? WHERE tenant_id = ? AND id = ?")
            .run(String(sendError || (r && r.error) || 'Niet bijgewerkt in de webshop.').slice(0, 300), tenantId, u.itemId);
        }
      }
    });
    if (sendError) shop.setStatus(tenantId, { error: sendError });
    return summary;
  }

  /** Eén synchronisatie tegelijk per omgeving; een volgende wacht op de lopende. */
  function run(tenantId, opts = {}) {
    const prev = running.get(tenantId) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => sync(tenantId, opts));
    running.set(tenantId, next);
    next.finally(() => { if (running.get(tenantId) === next) running.delete(tenantId); }).catch(() => {});
    return next;
  }

  /** Na een wijziging: over enkele seconden de gewijzigde artikelen naar de webshop. */
  function schedule(tenantId) {
    if (timers.has(tenantId)) return;
    let cfg;
    try { cfg = configOf(tenantId); } catch { return; }
    if (!cfg.url || !cfg.push) return;
    const timer = setTimeout(() => {
      timers.delete(tenantId);
      run(tenantId, { full: false }).catch((err) => log.warn(`Webshop (${tenantId}): terugschrijven mislukt: ${err.code || err.message}`));
    }, DEBOUNCE_MS);
    if (timer.unref) timer.unref();
    timers.set(tenantId, timer);
  }

  /** Alle omgevingen met terugschrijven aan (elke 10 minuten vanuit server.js). */
  async function runAll(tenantIds) {
    const out = {};
    for (const id of tenantIds) {
      let cfg;
      try { cfg = configOf(id); } catch { continue; }
      if (!cfg.url || !cfg.push) continue;
      try {
        out[id] = await run(id, { full: true });
      } catch (err) {
        log.warn(`Webshop (${id}): synchronisatie mislukt: ${err.code || err.message}`);
        if (err instanceof SourceError) shop.setStatus(id, { error: err.message });
      }
    }
    return out;
  }

  return { sync, run, schedule, runAll, exclOf, rawOf };
}

module.exports = { createShopSync, exclOf, rawOf };
