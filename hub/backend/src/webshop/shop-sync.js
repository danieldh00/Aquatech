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
// artikelen, enkele seconden later, schedule()), alles volgens de instelling
// `syncSchedule` (standaard één keer per nacht; runAll() vanuit server.js) en met de knop in Beheer > Webshop.
//
// Subartikelen (stock.js): een artikelgroep hoort bij een variabel product, elke
// subartikel bij een variatie daaronder (shop_product_id = id van de variatie).
// Prijs en voorraad gaan per variatie heen en weer; de artikelgroep zelf
// heeft geen prijs of voorraad. Met push aan maakt Aquatech ontbrekende
// variaties van een gekoppeld artikelgroep aan (createMissingVariations) en
// zet publish() een nieuw artikel (met subartikelen) in de webshop.
const { transaction } = require('../database/db');
const { fetchProducts, fetchProductWithVariations, updateProducts, patchProducts, createProduct, updateAttributes, createVariations, SourceError } = require('./woocommerce');

// Melding bij een gewoon artikel dat in de webshop een product met variaties is (zie stock.promoteToParent).
const VARIABLE_ON_PLAIN = 'In de webshop is dit een product met variaties, maar dit artikel heeft voorraad of boekingen. Maak een nieuw artikelgroep en zet de subartikelen daaronder.';

const DEBOUNCE_MS = 3000;
const SYNC_SCHEDULES = ['night', 'hourly', 'tenmin'];

/**
 * Dagsleutel in Nederlandse tijd met de dagwisseling om 04:00 (de nachtelijke synchronisatie valt na de back-up).
 * @param {Date} moment Het moment.
 * @returns {string} Datum (jjjj-mm-dd) van de synchronisatiedag.
 */
const syncDayOf = (moment) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date(moment.getTime() - 4 * 3600 * 1000));

/**
 * Bepaalt of een volledige synchronisatie nu aan de beurt is.
 * @param {string} schedule 'night' (één keer per nacht, standaard), 'hourly' of 'tenmin'.
 * @param {{ syncedAt?: string|null, lastAttemptAt?: string|null, lastError?: string|null }|null} status De laatste (geslaagde) synchronisatie en poging.
 * @param {Date} [now] Het huidige moment.
 * @returns {boolean} true als er nu gesynchroniseerd moet worden.
 */
function fullSyncDue(schedule, status, now = new Date()) {
  const synced = status && status.syncedAt ? new Date(status.syncedAt) : null;
  const attempt = status && status.lastAttemptAt ? new Date(status.lastAttemptAt) : null;
  // Na een mislukte poging hoogstens elk uur opnieuw (niet elke 10 minuten tegen een onbereikbare webshop).
  if (status && status.lastError && attempt && now - attempt < 3600 * 1000) return false;
  if (!synced) return true;
  if (schedule === 'tenmin') return now - synced >= 9 * 60 * 1000;
  if (schedule === 'hourly') return now - synced >= 55 * 60 * 1000;
  return syncDayOf(now) !== syncDayOf(synced);
}

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
 * Leest JSON uit een tekstkolom (waarden van een subartikel, kenmerken).
 * @param {string} text De opgeslagen tekst.
 * @param {*} [fallback] Wat terugkomt bij lege of ongeldige tekst.
 * @returns {*} De gelezen waarde.
 */
const parseValues = (text, fallback = {}) => {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
};
/**
 * Een vaste sleutel voor de waarden van een subartikel of variatie (hoofdletterongevoelig).
 * @param {Object<string, string>} values Waarde per kenmerk.
 * @returns {string} De sleutel.
 */
const valuesKeyOf = (values) => Object.entries(values || {}).map(([name, value]) => `${String(name).toLowerCase()}=${String(value).toLowerCase()}`).sort().join('|');

/** Na zoveel tijd wordt het bijwerkmoment van een ongewijzigd artikel toch vernieuwd (het staat als tooltip in Artikelen). */
const SYNCED_AT_REFRESH_MS = 24 * 60 * 60 * 1000;
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
 * @returns {{ sync: Function, run: Function, schedule: Function, runAll: Function, publish: Function, exclOf: Function, rawOf: Function }} De synchronisatiefuncties.
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
   * Bij alleen gewijzigde artikelen (na elke voorraadmutatie) wordt het gereserveerde aantal per
   * artikel via de index opgezocht, in plaats van alle reserveringen van de omgeving op te tellen.
   * @param {string} tenantId Id van de omgeving.
   * @param {boolean} onlyDirty Alleen gewijzigde, al gekoppelde artikelen.
   * @returns {object[]} De artikelrijen.
   */
  const itemsOf = (tenantId, onlyDirty) => prepare(`SELECT i.id, i.code, i.on_hand, i.sale_price, i.vat_rate, i.price_mode, i.shop_product_id, i.shop_dirty,
      i.shop_price_seen, i.shop_stock_seen, i.is_group, i.group_id, parent.shop_product_id AS shop_group_id,
      ${onlyDirty ? 'COALESCE((SELECT SUM(r.qty) FROM stock_reservations r WHERE r.tenant_id = i.tenant_id AND r.item_id = i.id), 0)' : 'COALESCE(r.qty, 0)'} AS reserved,
      EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id = i.tenant_id AND m.item_id = i.id) AS moved
    FROM stock_items i
    LEFT JOIN stock_items parent ON parent.tenant_id = i.tenant_id AND parent.id = i.group_id
    ${onlyDirty ? '' : 'LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_reservations WHERE tenant_id = ? GROUP BY item_id) r ON r.item_id = i.id'}
    WHERE i.tenant_id = ? AND i.archived = 0 AND i.shop_sync = 1${onlyDirty ? ' AND i.shop_dirty = 1 AND i.shop_product_id IS NOT NULL' : ''}`)
    .all(...(onlyDirty ? [tenantId] : [tenantId, tenantId]));

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
      // Een product zonder sku kreeg bij het overnemen de code WC-<id>; zo vindt de koppeling het terug als die weg is.
      const wooId = /^WC-(\d{1,20})$/.exec(String(item.code || ''));
      const found = (mappedSku && bySku.get(mappedSku)) || byCode.get(item.code) || bySku.get(item.code) || (wooId && byId.get(wooId[1])) || null;
      // Een subartikel hoort bij een variatie: een los product (ook met dezelfde sku) komt er niet voor in aanmerking.
      return found && item.group_id && !found.parentId ? null : found;
    };
  }

  /**
   * Schrijft de koppeling (webshopproduct-id en foutmelding) van meerdere artikelen in één opdracht,
   * alleen voor artikelen waar iets verschilt of waarvan het bijwerkmoment oud is.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ itemId: string, productId: string, error: string }[]} links De koppelingen.
   * @param {string} timestamp Moment van deze ronde.
   * @param {string} staleBefore Bijwerkmomenten ouder dan dit worden vernieuwd.
   */
  function writeLinks(tenantId, links, timestamp, staleBefore) {
    if (!links.length) return;
    prepare(`UPDATE stock_items i SET shop_product_id = v.product_id, shop_error = v.error, shop_synced_at = ?
      FROM unnest(?::uuid[], ?::text[], ?::text[]) AS v(id, product_id, error)
      WHERE i.tenant_id = ? AND i.id = v.id
        AND (i.shop_product_id IS DISTINCT FROM v.product_id OR COALESCE(i.shop_error, '') <> v.error OR i.shop_synced_at IS NULL OR i.shop_synced_at < ?)`)
      .run(timestamp, links.map((link) => link.itemId), links.map((link) => link.productId), links.map((link) => link.error), tenantId, staleBefore);
  }

  /**
   * Eén synchronisatie: voorraad en prijs uit de webshop verwerken en terugschrijven wat er veranderd is.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ full?: boolean, user?: object, addMissing?: boolean }} [options] full: alle producten ophalen (en de catalogus bijwerken), anders alleen de gewijzigde, gekoppelde artikelen; user voor de voorraadboekingen; onProgress: voortgang van het ophalen en toevoegen (alleen met addMissing); addMissing: alleen de producten die nog geen artikel hebben aanmaken en dan stoppen (geen boekingen, prijzen of terugschrijven; bij spiegelen aan loopt de gewone ronde).
   * @returns {Promise<object>} Samenvatting (created, restored, archived, skippedProducts, mirror, linked, unlinked, soldInShop, pricesFromShop, updated, failed) of { skipped }.
   */
  async function sync(tenantId, { full = true, user = null, addMissing = false, onProgress = null } = {}) {
    const shopConfig = configOf(tenantId);
    if (!shopConfig.url) return { skipped: 'not_configured' };
    if (!full && !shopConfig.push) return { skipped: 'no_push' };
    // Eerst ontbrekende variaties aanmaken, dan zitten ze meteen in deze ronde.
    const createdVariations = !addMissing && shopConfig.push && shopConfig.mode === 'rest' ? await createMissingVariations(tenantId, shopConfig) : 0;
    const dirtyItems = full ? null : itemsOf(tenantId, true);
    if (!full && !dirtyItems.length) return createdVariations ? { createdVariations } : { skipped: 'nothing' };
    const products = full
      ? await fetchProducts(shopConfig, { fetchImpl, onProgress: addMissing ? onProgress : null })
      : await fetchProducts(shopConfig, {
        fetchImpl,
        ids: dirtyItems.filter((item) => !item.shop_group_id).map((item) => item.shop_product_id),
        variations: dirtyItems.filter((item) => item.shop_group_id).map((item) => ({ id: item.shop_product_id, parentId: item.shop_group_id })),
      });
    if (full) shop.replaceProducts(tenantId, products, new Date().toISOString());
    const match = matcher(products, shopConfig.mapping);
    const mirrorOn = shopConfig.mirror !== false;
    /**
     * De verkoopprijs (excl. btw) van een webshopproduct.
     * @param {object} product Het webshopproduct.
     * @returns {number|null} De prijs excl. btw.
     */
    const productPrice = (product) => (product.rawRegular != null ? exclOf(product.rawRegular, shopConfig.vatRate, shopConfig) : product.price);
    // Alleen ontbrekende artikelen toevoegen (ook bij spiegelen aan): verder niets doen, dus geen boekingen,
    // geen prijzen overnemen, niets archiveren en niets naar de webshop schrijven.
    if (full && addMissing) {
      const added = stock.addMissingShop(tenantId, products, match, { vatRate: shopConfig.vatRate, priceOf: productPrice, onProgress });
      return { created: added.created, skippedProducts: added.skippedProducts, linked: 0 };
    }
    const mirrored = full && mirrorOn
      ? stock.mirrorShop(tenantId, products, match, { vatRate: shopConfig.vatRate, priceOf: productPrice })
      : null;
    const items = full ? itemsOf(tenantId, false) : dirtyItems;
    const byId = new Map(products.map((product) => [String(product.id), product]));
    const pushStockOn = Boolean(shopConfig.push && shopConfig.pushStock !== false && shopConfig.mode === 'rest');
    const summary = { created: 0, restored: 0, archived: 0, skippedProducts: 0, mirror: mirrorOn, ...mirrored, linked: 0, unlinked: 0, soldInShop: 0, pricesFromShop: 0, updated: 0, failed: 0, createdVariations };
    const updates = [];
    const timestamp = new Date().toISOString();
    const staleBefore = new Date(Date.now() - SYNCED_AT_REFRESH_MS).toISOString();
    // Koppelingen, losgekoppelde artikelen en voorraadbeheer worden verzameld en na de lus in één opdracht weggeschreven.
    const links = [];
    const unlinkedIds = [];
    const managedIds = [];

    transaction(db, () => {
      for (const item of items) {
        const product = (item.shop_product_id && byId.get(String(item.shop_product_id))) || (full ? match(item) : null);
        if (!product) {
          if (full && item.shop_product_id) {
            unlinkedIds.push(item.id);
            summary.unlinked++;
          }
          continue;
        }
        const first = String(item.shop_product_id || '') !== String(product.id);
        if (first) summary.linked++;
        if (Number(item.is_group)) {
          // Artikelgroep: alleen de koppeling; prijs en voorraad zitten bij de variaties.
          links.push({ itemId: item.id, productId: String(product.id), error: '' });
          updates.push({ id: String(product.id), itemId: item.id, priceSeen: null, stockSeen: null });
          continue;
        }
        if (product.type === 'variable') {
          // Gewoon artikel bij een product met variaties (van vóór de subartikelen, met voorraad): alleen koppelen, geen prijs of stand.
          links.push({ itemId: item.id, productId: String(product.id), error: VARIABLE_ON_PLAIN });
          continue;
        }
        let onHand = Number(item.on_hand) || 0;
        let salePrice = item.sale_price == null ? null : Number(item.sale_price);
        let priceSeen = first ? null : item.shop_price_seen;
        let stockSeen = first ? null : item.shop_stock_seen;
        // Een product zonder voorraadbeheer in de webshop en zonder stand in Aquatech blijft zo (geen 0 terugsturen).
        const pushStock = pushStockOn && (product.stockQty != null || onHand > 0 || Number(item.moved) > 0);

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

        // De webshop houdt een aantal bij: dan is de voorraad vanaf nu ook in Aquatech bijgehouden (stand uit stap 1).
        if (pushStock && product.stockQty != null) {
          managedIds.push(item.id);
        }

        // 2. Prijs.
        const raw = product.rawRegular != null ? product.rawRegular : null;
        // Artikelen in de modus factor: de prijs komt uit de berekening, nooit uit de webshop (anders heen-en-weer bij het uurlijkse herrekenen).
        const priceFromShop = item.price_mode !== 'factor';
        if (priceFromShop && raw == null && !shopConfig.push && product.price != null && (salePrice == null || Math.abs(product.price - salePrice) >= 0.005)) {
          // Store API: alleen de prijs excl. btw is bekend (geen rawRegular).
          prepare('UPDATE stock_items SET sale_price = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(product.price, timestamp, tenantId, item.id);
          salePrice = product.price;
          summary.pricesFromShop++;
        }
        if (raw != null && priceFromShop) {
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
        const update = { id: String(product.id), itemId: item.id, parentId: product.parentId || item.shop_group_id || null };
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
        links.push({ itemId: item.id, productId: String(product.id), error: '' });
        updates.push(update);
      }
      if (unlinkedIds.length) {
        prepare(`UPDATE stock_items SET shop_product_id = NULL, shop_price_seen = NULL, shop_stock_seen = NULL, shop_dirty = 0,
          shop_error = 'Niet (meer) gevonden in de webshop.' WHERE tenant_id = ? AND id = ANY(?::uuid[])`).run(tenantId, unlinkedIds);
      }
      if (managedIds.length) prepare('UPDATE stock_items SET stock_managed = 1 WHERE tenant_id = ? AND id = ANY(?::uuid[]) AND stock_managed = 0').run(tenantId, managedIds);
      writeLinks(tenantId, links, timestamp, staleBefore);
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
      const confirmed = [];
      const failed = [];
      for (const update of updates) {
        const sent = update.price != null || update.stockQty != null;
        const result = sent ? results.get(update.id) : { ok: true };
        if (result && result.ok) {
          if (sent) summary.updated++;
          confirmed.push(update);
        } else {
          summary.failed++;
          failed.push({ itemId: update.itemId, error: String(sendError || (result && result.error) || 'Niet bijgewerkt in de webshop.').slice(0, 300) });
        }
      }
      // Alleen artikelen die écht anders zijn (of al lang niet bijgewerkt) worden geschreven: een ongewijzigde ronde schrijft niets.
      if (confirmed.length) {
        prepare(`UPDATE stock_items i SET shop_price_seen = v.price_seen, shop_stock_seen = v.stock_seen, shop_dirty = 0, shop_error = '', shop_synced_at = ?
          FROM unnest(?::uuid[], ?::numeric[], ?::numeric[]) AS v(id, price_seen, stock_seen)
          WHERE i.tenant_id = ? AND i.id = v.id
            AND (i.shop_dirty <> 0 OR COALESCE(i.shop_error, '') <> '' OR i.shop_price_seen IS DISTINCT FROM v.price_seen
              OR i.shop_stock_seen IS DISTINCT FROM v.stock_seen OR i.shop_synced_at IS NULL OR i.shop_synced_at < ?)`)
          .run(timestamp, confirmed.map((update) => update.itemId), confirmed.map((update) => update.priceSeen ?? null),
            confirmed.map((update) => update.stockSeen ?? null), tenantId, staleBefore);
      }
      if (failed.length) {
        prepare(`UPDATE stock_items i SET shop_dirty = 1, shop_error = v.error
          FROM unnest(?::uuid[], ?::text[]) AS v(id, error) WHERE i.tenant_id = ? AND i.id = v.id`)
          .run(failed.map((entry) => entry.itemId), failed.map((entry) => entry.error), tenantId);
      }
    });
    if (sendError) shop.setStatus(tenantId, { error: sendError });
    return summary;
  }

  /**
   * Een prijs/voorraad zoals die voor een nieuw product of nieuwe variatie naar de webshop gaat.
   * @param {object} row Artikelrij met sale_price, vat_rate, on_hand en reserved.
   * @param {object} shopConfig De koppelinstelling.
   * @returns {{ price: number|null, vatRate: number, stockQty: number|null }} Prijs excl. btw, btw en beschikbaar (null zonder voorraad terugschrijven).
   */
  const offerOf = (row, shopConfig) => ({
    price: row.sale_price == null ? null : Number(row.sale_price),
    vatRate: Number(row.vat_rate),
    stockQty: shopConfig.pushStock !== false ? Math.max(0, Math.floor(Number(row.on_hand) - Number(row.reserved || 0) + 1e-9)) : null,
  });

  /**
   * Subartikelen van gekoppelde artikelgroepen die nog geen variatie in de
   * webshop hebben: een bestaande variatie met dezelfde sku of waarden wordt
   * gekoppeld, de rest aangemaakt (kenmerken van het product eerst aangevuld
   * met de nieuwe waarden). Alleen met push aan (Aquatech is de bron).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} shopConfig De koppelinstelling.
   * @param {{ parentItemId?: string|null, errors?: string[]|null }} [options] Alleen de subartikelen van deze artikelgroep; lijst om fouten in te verzamelen.
   * @returns {Promise<number>} Aantal aangemaakte of gekoppelde variaties.
   */
  async function createMissingVariations(tenantId, shopConfig, { parentItemId = null, errors = null } = {}) {
    const rows = prepare(`SELECT v.id, v.code, v.sale_price, v.vat_rate, v.on_hand, v.sub_values, parent.id AS parent_item_id, parent.shop_product_id AS parent_product_id,
        parent.attributes, COALESCE(r.qty, 0) AS reserved
      FROM stock_items v
      JOIN stock_items parent ON parent.tenant_id = v.tenant_id AND parent.id = v.group_id
      LEFT JOIN (SELECT item_id, SUM(qty) AS qty FROM stock_reservations WHERE tenant_id = ? GROUP BY item_id) r ON r.item_id = v.id
      WHERE v.tenant_id = ? AND v.archived = 0 AND v.shop_sync = 1 AND v.shop_product_id IS NULL
        AND parent.archived = 0 AND parent.shop_sync = 1 AND parent.shop_product_id IS NOT NULL${parentItemId ? ' AND parent.id = ?' : ''}`)
      .all(tenantId, tenantId, ...(parentItemId ? [parentItemId] : []));
    if (!rows.length) return 0;
    const byParent = new Map();
    for (const row of rows) {
      if (!byParent.has(row.parent_product_id)) byParent.set(row.parent_product_id, []);
      byParent.get(row.parent_product_id).push(row);
    }
    let done = 0;
    for (const [productId, subItems] of byParent) {
      try {
        done += await createVariationsOf(tenantId, shopConfig, productId, subItems, errors);
      } catch (error) {
        // Eén product dat niet lukt (weg uit de webshop, geen schrijfrechten) houdt de rest van de ronde niet tegen.
        if (!(error instanceof SourceError)) throw error;
        const message = `Variatie niet aangemaakt: ${error.message}`.slice(0, 300);
        if (errors) errors.push(message);
        for (const subItem of subItems) prepare('UPDATE stock_items SET shop_error = ? WHERE tenant_id = ? AND id = ?').run(message, tenantId, subItem.id);
      }
    }
    return done;
  }

  /**
   * Koppelt of maakt de ontbrekende variaties van één webshopproduct: eerst op
   * sku of waarden koppelen, dan de kenmerken van het product aanvullen en de
   * rest als nieuwe variaties aanmaken.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} shopConfig De koppelinstelling.
   * @param {number} productId Id van het product in de webshop.
   * @param {object[]} subartikelen De subartikelen zonder variatie-id (rijen uit createMissingVariations).
   * @param {string[]|null} [errors] Lijst om fouten per variatie in te verzamelen.
   * @returns {Promise<number>} Aantal aangemaakte of gekoppelde variaties.
   */
  async function createVariationsOf(tenantId, shopConfig, productId, subItems, errors = null) {
    let done = 0;
    const { product, variations } = await fetchProductWithVariations(shopConfig, productId, { fetchImpl });
    const timestamp = new Date().toISOString();
    const bySku = new Map(variations.filter((variation) => variation.sku).map((variation) => [normalizeKey(variation.sku), variation]));
    const byValues = new Map(variations.map((variation) => [valuesKeyOf(Object.fromEntries(variation.attributes.map((attribute) => [attribute.name, attribute.option]))), variation]));
    const toCreate = [];
    for (const subItem of subItems) {
      const values = parseValues(subItem.sub_values);
      const existing = bySku.get(normalizeKey(subItem.code)) || byValues.get(valuesKeyOf(values));
      if (existing) {
        prepare(`UPDATE stock_items SET shop_product_id = ?, shop_dirty = 1, shop_error = '', shop_synced_at = ? WHERE tenant_id = ? AND id = ?`).run(existing.id, timestamp, tenantId, subItem.id);
        done++;
      } else {
        toCreate.push({ subItem, values });
      }
    }
    if (!toCreate.length) return done;
    // Kenmerken van het product aanvullen met de waarden van de nieuwe subartikelen.
    const attributes = product.attributes.map((attribute) => ({ ...attribute, options: [...attribute.options] }));
    let changed = false;
    for (const { values } of toCreate) {
      for (const [name, option] of Object.entries(values)) {
        let attribute = attributes.find((existing) => existing.name.toLowerCase() === name.toLowerCase());
        if (!attribute) { attribute = { name, options: [], visible: true, variation: true, position: attributes.length }; attributes.push(attribute); changed = true; }
        if (!attribute.variation) { attribute.variation = true; changed = true; }
        if (!attribute.options.some((known) => known.toLowerCase() === option.toLowerCase())) { attribute.options.push(option); changed = true; }
      }
    }
    if (changed) await updateAttributes(shopConfig, productId, attributes.map(({ id, name, options, visible, variation, position }) => ({ ...(id ? { id } : { name }), name, options, visible, variation, position })), { fetchImpl });
    const results = await createVariations(shopConfig, productId, toCreate.map(({ subItem, values }) => ({ sku: subItem.code, code: subItem.code, values, ...offerOf(subItem, shopConfig) })), { fetchImpl });
    transaction(db, () => {
      toCreate.forEach(({ subItem }, index) => {
        const result = results[index];
        const offer = offerOf(subItem, shopConfig);
        if (result && result.ok) {
          prepare(`UPDATE stock_items SET shop_product_id = ?, shop_price_seen = ?, shop_stock_seen = ?, shop_dirty = 0, shop_error = '', shop_synced_at = ?
            WHERE tenant_id = ? AND id = ?`).run(result.id, offer.price == null ? null : rawOf(offer.price, offer.vatRate, shopConfig), offer.stockQty, timestamp, tenantId, subItem.id);
          done++;
        } else {
          const message = `Variatie ${subItem.code} niet aangemaakt: ${(result && result.error) || 'onbekende fout'}`.slice(0, 300);
          if (errors) errors.push(message);
          prepare('UPDATE stock_items SET shop_error = ? WHERE tenant_id = ? AND id = ?').run(message, tenantId, subItem.id);
        }
      });
    });
    return done;
  }

  /**
   * Controleert of Aquatech in de webshop mag schrijven (webshop gekoppeld, REST API, "Aquatech is de bron").
   * @param {object} shopConfig De koppelinstelling.
   * @returns {object|null} { error, code, status } als het niet kan, anders null.
   */
  function publishProblem(shopConfig) {
    if (!shopConfig.url) return { error: 'Er is geen webshop gekoppeld (Beheer → Integraties → Webshop).', code: 'not_configured', status: 409 };
    if (shopConfig.mode !== 'rest' || !shopConfig.push) return { error: 'Zet in Beheer → Integraties → Webshop de REST API aan met "Aquatech is de bron" (prijzen en voorraad terugschrijven).', code: 'no_push', status: 409 };
    return null;
  }

  /**
   * Kan Aquatech nu producten in de webshop aanmaken en wijzigen?
   * @param {string} tenantId Id van de omgeving.
   * @returns {boolean} true als de koppeling schrijven toestaat.
   */
  function canPublish(tenantId) {
    try { return !publishProblem(configOf(tenantId)); } catch { return false; }
  }

  /**
   * Zet een artikel dat nog niet gekoppeld is als nieuw product in de webshop:
   * een gewoon artikel als enkelvoudig product met prijs en voorraad, een
   * artikelgroep als variabel product met zijn kenmerken, daarna de subartikelen
   * als variaties. Code = sku, plus het productveld aquatech_code.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {Promise<object>} { productId, variations, warning }, of { error, status, code }.
   */
  async function publishNow(tenantId, itemId) {
    const shopConfig = configOf(tenantId);
    const problem = publishProblem(shopConfig);
    if (problem) return problem;
    const item = prepare(`SELECT i.id, i.code, i.name, i.sale_price, i.vat_rate, i.on_hand, i.archived, i.shop_sync, i.shop_product_id, i.group_id, i.is_group, i.attributes,
        COALESCE((SELECT SUM(r.qty) FROM stock_reservations r WHERE r.tenant_id = i.tenant_id AND r.item_id = i.id), 0) AS reserved
      FROM stock_items i
      WHERE i.tenant_id = ? AND i.id = ?`).get(tenantId, String(itemId));
    if (!item) return { error: 'not_found', status: 404 };
    if (item.group_id) return { error: 'Een subartikel gaat mee met zijn artikelgroep: zet de artikelgroep in de webshop.', status: 409 };
    if (item.archived) return { error: 'Dit artikel is gearchiveerd.', status: 409 };
    if (!Number(item.shop_sync)) return { error: 'Zet eerst "Naar de webshop" aan bij dit artikel.', status: 409 };
    if (item.shop_product_id) return { error: 'Dit artikel is al gekoppeld aan een webshopproduct.', status: 409 };
    const meta = [{ key: 'aquatech_code', value: item.code }];
    const timestamp = new Date().toISOString();
    if (Number(item.is_group)) {
      const attributes = parseValues(item.attributes, []).map((attribute, position) => ({ name: attribute.name, options: attribute.values, visible: true, variation: true, position }));
      const product = await createProduct(shopConfig, { name: item.name, type: 'variable', status: 'publish', sku: item.code, attributes, meta_data: meta }, { fetchImpl });
      prepare(`UPDATE stock_items SET shop_product_id = ?, shop_dirty = 0, shop_error = '', shop_synced_at = ? WHERE tenant_id = ? AND id = ?`).run(product.id, timestamp, tenantId, item.id);
      // Alleen de subartikelen van deze artikelgroep; wat niet lukt komt als waarschuwing terug.
      const errors = [];
      const variations = await createMissingVariations(tenantId, shopConfig, { parentItemId: item.id, errors });
      return { productId: product.id, variations, warning: errors.length ? `Niet alle variaties zijn aangemaakt: ${errors.join('; ')}`.slice(0, 600) : null };
    }
    const offer = offerOf(item, shopConfig);
    const body = { name: item.name, type: 'simple', status: 'publish', sku: item.code, meta_data: meta };
    if (offer.price != null) body.regular_price = rawOf(offer.price, offer.vatRate, shopConfig).toFixed(2);
    if (offer.stockQty != null) { body.manage_stock = true; body.stock_quantity = offer.stockQty; }
    const product = await createProduct(shopConfig, body, { fetchImpl });
    prepare(`UPDATE stock_items SET shop_product_id = ?, shop_price_seen = ?, shop_stock_seen = ?, shop_dirty = 0, shop_error = '', shop_synced_at = ? WHERE tenant_id = ? AND id = ?`)
      .run(product.id, offer.price == null ? null : rawOf(offer.price, offer.vatRate, shopConfig), offer.stockQty, timestamp, tenantId, item.id);
    return { productId: product.id, variations: 0 };
  }

  /**
   * Zet een net samengevoegd artikelgroep in de webshop en haalt de oude losse producten weg uit de winkel.
   * Volgorde: (1) de sku van de oude producten leeg zetten (anders is de sku van de nieuwe variatie dubbel),
   * (2) de artikelgroep als variabel product aanmaken, (3) de oude producten op concept zetten (verborgen,
   * niet verwijderd). Mislukt (1) of (2), dan zet deze functie de sku's terug (ook bij een onverwachte fout, die daarna doorgegooid wordt) en geeft `revert: true`:
   * de aanroeper draait de samenvoeging dan terug, zodat er niets half blijft staan. Mislukt alleen (3),
   * dan komt dat als waarschuwing terug.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} groupId Id van de nieuwe artikelgroep.
   * @param {string[]} productIds Id's van de oude webshopproducten van de samengevoegde artikelen.
   * @returns {Promise<object>} { productId, variations, hidden, warning }, of { error, revert: true, status }.
   */
  async function publishMergedNow(tenantId, groupId, productIds) {
    const shopConfig = configOf(tenantId);
    const problem = publishProblem(shopConfig);
    if (problem) return { ...problem, revert: true };
    const ids = [...new Set((productIds || []).map(String).filter((id) => /^\d{1,20}$/.test(id)))];
    const skuOf = new Map();
    /**
     * Zet de sku's van de oude producten terug (zo goed als het lukt).
     * @returns {Promise<void>}
     */
    const restoreSkus = async () => {
      const back = [...skuOf].map(([id, sku]) => ({ id, sku }));
      if (back.length) await patchProducts(shopConfig, back, { fetchImpl }).catch((error) => log.warn(`Webshop (${tenantId}): sku's terugzetten mislukt: ${error.code || error.message}`));
    };
    try {
      if (ids.length) {
        for (const product of await fetchProducts(shopConfig, { fetchImpl, ids })) if (product.sku) skuOf.set(String(product.id), product.sku);
        const cleared = await patchProducts(shopConfig, [...skuOf.keys()].map((id) => ({ id, sku: '' })), { fetchImpl });
        const failed = cleared.find((result) => !result.ok);
        if (failed) {
          for (const result of cleared) if (!result.ok) skuOf.delete(String(result.id));
          await restoreSkus();
          return { error: `Het oude webshopproduct ${failed.id} kon niet worden aangepast: ${failed.error}`, revert: true, status: 502 };
        }
      }
      const published = await publishNow(tenantId, groupId);
      if (published.error) { await restoreSkus(); return { ...published, revert: true }; }
      let hidden = 0;
      let warning = published.warning || null;
      if (ids.length) {
        try {
          const results = await patchProducts(shopConfig, ids.map((id) => ({ id, status: 'draft' })), { fetchImpl });
          hidden = results.filter((result) => result.ok).length;
          if (hidden < ids.length) warning = `${warning ? `${warning} ` : ''}${ids.length - hidden} oud webshopproduct staat nog zichtbaar in de webshop; zet het daar op concept.`;
        } catch (error) {
          // De artikelgroep staat dan al in de webshop: nooit meer terugdraaien, alleen waarschuwen (welke fout ook).
          log.warn(`Webshop (${tenantId}): oude producten op concept zetten mislukt: ${error.code || error.message}`);
          warning = `${warning ? `${warning} ` : ''}De oude webshopproducten zijn niet op concept gezet${error instanceof SourceError ? ` (${error.message})` : ''}; doe dat in de webshop.`;
        }
      }
      return { productId: published.productId, variations: published.variations, hidden, warning };
    } catch (error) {
      await restoreSkus();
      if (!(error instanceof SourceError)) throw error;
      return { error: error.message, revert: true, status: 502 };
    }
  }

  /**
   * Voert werk uit in de wachtrij van de omgeving, zodat er geen synchronisatie tussendoor loopt.
   * Gebruikt voor het samenvoegen: de samenvoeging in de database en het zetten in de webshop zijn
   * één taak, anders kan een synchronisatie de nieuwe subartikelen tussendoor archiveren of de oude producten opnieuw koppelen.
   * Roep binnen het werk publishMergedNow aan; `exclusive` opnieuw aanroepen zou op dezelfde wachtrij wachten (deadlock).
   * @param {string} tenantId Id van de omgeving.
   * @param {Function} work Het werk (async).
   * @returns {Promise<*>} Wat het werk teruggeeft.
   */
  function exclusive(tenantId, work) {
    return queue(tenantId, work);
  }

  /**
   * Zet een artikel in de webshop, in de wachtrij van de omgeving (nooit tegelijk met een synchronisatie).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {Promise<object>} Zie publishNow.
   */
  function publish(tenantId, itemId) {
    return queue(tenantId, () => publishNow(tenantId, itemId));
  }

  /**
   * Eén synchronisatie tegelijk per omgeving; een volgende wacht op de lopende.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} [options] Zie sync.
   * @returns {Promise<object>} Het resultaat van sync.
   */
  function run(tenantId, options = {}) {
    return queue(tenantId, () => sync(tenantId, options));
  }

  /**
   * Voert werk voor de webshop uit na wat er voor deze omgeving al loopt.
   * @param {string} tenantId Id van de omgeving.
   * @param {Function} work Het werk (async).
   * @returns {Promise<*>} Wat het werk teruggeeft.
   */
  function queue(tenantId, work) {
    const previous = running.get(tenantId) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
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
   * Synchroniseert alle omgevingen met een webshopkoppeling (elke 10 minuten aangeroepen; per omgeving alleen als `syncSchedule` het toelaat, standaard één keer per nacht).
   * @param {string[]} tenantIds De omgevingen.
   * @returns {Promise<object>} Resultaat per omgeving.
   */
  async function runAll(tenantIds) {
    const out = {};
    for (const id of tenantIds) {
      let shopConfig;
      try { shopConfig = configOf(id); } catch { continue; }
      if (!shopConfig.url) continue;
      if (!fullSyncDue(shopConfig.syncSchedule, shop.status(id), new Date())) continue;
      try {
        out[id] = await run(id, { full: true });
      } catch (error) {
        log.warn(`Webshop (${id}): synchronisatie mislukt: ${error.code || error.message}`);
        // Ook bij een onverwachte fout een melding (zonder interne tekst), anders volgt de uur-wachttijd niet.
        shop.setStatus(id, { error: error instanceof SourceError ? error.message : 'De synchronisatie is mislukt (zie het log).' });
      }
    }
    return out;
  }

  return { sync, run, schedule, runAll, publish, exclusive, publishMergedNow, canPublish, exclOf, rawOf, matcher };
}

module.exports = { createShopSync, exclOf, rawOf, fullSyncDue, SYNC_SCHEDULES };
