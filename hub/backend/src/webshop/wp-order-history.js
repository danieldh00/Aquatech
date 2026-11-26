// Orderhistorie uit de oude WordPress/WooCommerce-webshop, alleen als bron voor "Vaak samen besteld" (migratie 101).
//
// - De regels komen in `wp_order_lines`, nooit in `web_orders`: er ontstaat dus geen voorraadmutatie, factuur, mail of omzet. Opnieuw ophalen is veilig
//   (unieke sleutel per WP-bestelling en regel; een eerdere koppeling, ook een handmatige, blijft staan).
// - Alleen afgeronde en in behandeling zijnde bestellingen tellen mee; geannuleerd, mislukt, terugbetaald en wachtend niet.
// - Koppelen aan artikelen (ook na het samenvoegen tot variabele producten): variatie-id of product-id naar het huidige webshop-id van een artikel, een oud
//   product-id uit de momentopname van het samenvoegen (stock_merges), de SKU gelijk aan de artikelcode, het webshopproduct (shop_products) via zijn
//   SKU of code, en als laatste een unieke naam. Wat niet past staat in de lijst "niet gekoppeld" en is met de hand te koppelen.
// - Klanten: elke bestelling met een e-mailadres maakt de klant aan (zonder inlog, gewone klantrecord op naam, adres en telefoon van de factuurgegevens), tenzij er
//   al een account met dat adres is; dan blijft die ongemoeid. Bestellingen zonder e-mailadres maken geen klant.
// - Het ophalen draait als serverjob (start geeft meteen antwoord) en gaat door als het venster sluit. Na de eerste keer werkt een uurlijkse ronde de
//   nieuwe en gewijzigde bestellingen bij zolang het aan staat.
const crypto = require('crypto');
const { transaction } = require('../database/db');
const { fetchOrders, SourceError } = require('./woocommerce');

/** Zoveel bestellingen vraagt één verzoek op (gelijk aan de paginagrootte van woocommerce.js). */
const PAGE_SIZE = 100;
/** Hoogstens zoveel bestellingen per ronde, tegen een eindeloze lus bij een rare webshop. */
const MAX_ORDERS = 100000;
/** Standaard aantal maanden terug (gelijk aan de berekening van Vaak samen besteld). */
const DEFAULT_MONTHS = 24;
/** Statussen die meetellen. */
const COUNTED_STATUSES = new Set(['completed', 'processing']);
/** Hoeveel niet-gekoppelde groepen het scherm hoogstens toont. */
const MAX_UNMATCHED = 200;

/**
 * Maakt van een waarde getrimde tekst.
 * @param {*} value De invoer.
 * @returns {string} De tekst.
 */
const cleanText = (value) => String(value == null ? '' : value).trim();

/**
 * Een WooCommerce-id als tekst; 0 en leeg worden een lege tekst.
 * @param {*} value Het id.
 * @returns {string} Het id of ''.
 */
const idOf = (value) => { const text = cleanText(value); return text && text !== '0' ? text.slice(0, 40) : ''; };

/**
 * Het bestelmoment van een WooCommerce-bestelling (de GMT-velden hebben geen zone-aanduiding).
 * @param {object} order De bestelling.
 * @returns {string|null} ISO-tijd, of null bij een onleesbare datum.
 */
function orderedAtOf(order) {
  const raw = cleanText(order.date_created_gmt) || cleanText(order.date_created);
  if (!raw) return null;
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Een eenvoudige controle op een e-mailadres. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * De klantgegevens uit de factuurgegevens van een bestelling.
 * @param {object} order De bestelling.
 * @returns {{ displayName: string, email: string, phone: string, address: string }|null} De gegevens, of null zonder bruikbaar e-mailadres of naam.
 */
function customerOf(order) {
  const billing = order.billing || {};
  const email = cleanText(billing.email).toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 120) return null;
  const person = [billing.first_name, billing.last_name].map(cleanText).filter(Boolean).join(' ');
  const displayName = (cleanText(billing.company) || person).replace(/\s+/g, ' ').slice(0, 80);
  if (!displayName) return null;
  const country = cleanText(billing.country).toUpperCase();
  const address = [cleanText(billing.address_1), cleanText(billing.address_2), [cleanText(billing.postcode), cleanText(billing.city)].filter(Boolean).join('  '), country && country !== 'NL' ? country : '']
    .filter(Boolean).join('\n').slice(0, 300);
  return { displayName, email, phone: cleanText(billing.phone).slice(0, 30), address };
}

/** WordPress-statussen die geen echte bestelling zijn en dus niet in de lijst komen. */
const HIDDEN_STATUSES = new Set(['checkout-draft', 'auto-draft', 'trash']);

/**
 * De kopgegevens van een bestelling voor de lijst bij Webshopbestellingen (alleen lezen).
 * @param {object} order De bestelling zoals WooCommerce hem stuurt.
 * @returns {{ number: string, status: string, customerName: string, company: string, email: string, phone: string, total: number, paymentTitle: string }} De velden van `wp_orders`.
 */
function headerOf(order) {
  const billing = order.billing || {};
  const company = cleanText(billing.company).replace(/\s+/g, ' ').slice(0, 80);
  const person = [billing.first_name, billing.last_name].map(cleanText).filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 80);
  const total = Number(String(order.total == null ? 0 : order.total).replace(',', '.'));
  return {
    number: cleanText(order.number || order.id).slice(0, 40), status: cleanText(order.status).slice(0, 40), customerName: person || company, company,
    email: cleanText(billing.email).toLowerCase().slice(0, 120), phone: cleanText(billing.phone).slice(0, 30), total: Number.isFinite(total) ? total : 0,
    paymentTitle: cleanText(order.payment_method_title).slice(0, 80),
  };
}

/**
 * De bestelregels van een bestelling in de vorm van de tabel.
 * @param {object} order De bestelling zoals WooCommerce hem stuurt.
 * @returns {{ lineId: string, productId: string, variationId: string, sku: string, name: string, qty: number }[]} De regels met een positief aantal.
 */
function linesOf(order) {
  const out = [];
  (order.line_items || []).forEach((item, index) => {
    const qty = Number(String(item.quantity == null ? 1 : item.quantity).replace(',', '.'));
    if (!Number.isFinite(qty) || qty <= 0) return;
    out.push({
      lineId: cleanText(item.id) || `i${index}`, productId: idOf(item.product_id), variationId: idOf(item.variation_id),
      sku: cleanText(item.sku).slice(0, 80), name: cleanText(item.name).slice(0, 200), qty,
    });
  });
  return out;
}

/**
 * Maakt de opslag en de serverjob voor de WordPress-orderhistorie.
 * @param {object} options db, settingsFor, fetchImpl (voor tests), afterImport (haak na elke ronde, bijv. Vaak samen besteld opnieuw berekenen) en customers ({ createCustomer, accountIdsByEmail } van de store; zonder maakt de import geen klanten).
 * @returns {object} start, runAll, importOrders, rematch, link, status, unmatched, setEnabled.
 */
function createWpOrderHistory({ db, settingsFor, fetchImpl = null, afterImport = null, customers = null }) {
  /**
   * Maakt een query klaar.
   * @param {string} sql De query.
   * @returns {object} De voorbereide query.
   */
  const prepare = (sql) => db.prepare(sql);
  /** Lopende rondes per omgeving (alleen in het geheugen; na een herstart pakt de uurlijkse ronde het weer op). */
  const running = new Map();

  /**
   * De koppelinstelling van de webshop voor deze omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} De instelling met API-sleutels.
   */
  function shopOf(tenantId) {
    const settings = settingsFor(tenantId);
    return { ...settings.get('shopSource'), consumerKey: settings.get('shopConsumerKey'), consumerSecret: settings.get('shopConsumerSecret') };
  }

  /**
   * Bouwt de opzoeklijsten om bestelregels aan artikelen te koppelen (één keer per ronde).
   * @param {string} tenantId Id van de omgeving.
   * @returns {Function} match(line) -> { itemId, by } of null.
   */
  function buildMatcher(tenantId) {
    const items = prepare('SELECT id, code, name, shop_product_id FROM stock_items WHERE tenant_id = ?').all(tenantId);
    const byShopId = new Map();
    const byCode = new Map();
    const nameCount = new Map();
    const byName = new Map();
    for (const item of items) {
      const id = String(item.id);
      if (item.shop_product_id) byShopId.set(String(item.shop_product_id), id);
      byCode.set(String(item.code).toUpperCase(), id);
      const nameKey = cleanText(item.name).toLowerCase();
      if (nameKey) { nameCount.set(nameKey, (nameCount.get(nameKey) || 0) + 1); byName.set(nameKey, id); }
    }
    const known = new Set(items.map((item) => String(item.id)));
    // Oude webshop-id's van artikelen die later tot een variabel product zijn samengevoegd.
    const byOldShopId = new Map();
    for (const row of prepare('SELECT snapshot FROM stock_merges WHERE tenant_id = ?').all(tenantId)) {
      let snapshot = [];
      try { snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot || []; } catch { snapshot = []; }
      for (const entry of Array.isArray(snapshot) ? snapshot : []) {
        if (entry && entry.shopProductId && entry.id && known.has(String(entry.id))) byOldShopId.set(String(entry.shopProductId), String(entry.id));
      }
    }
    const shopProducts = new Map();
    for (const row of prepare('SELECT id, sku, code FROM shop_products WHERE tenant_id = ?').all(tenantId)) shopProducts.set(String(row.id), row);
    return function match(line) {
      const ids = [line.variationId, line.productId].filter(Boolean);
      for (const id of ids) if (byShopId.has(id)) return { itemId: byShopId.get(id), by: id === line.variationId ? 'variatie' : 'product' };
      for (const id of ids) if (byOldShopId.has(id)) return { itemId: byOldShopId.get(id), by: 'oud-product' };
      const sku = cleanText(line.sku).toUpperCase();
      if (sku && byCode.has(sku)) return { itemId: byCode.get(sku), by: 'sku' };
      for (const id of ids) {
        const product = shopProducts.get(id);
        if (!product) continue;
        for (const code of [product.code, product.sku]) {
          const key = cleanText(code).toUpperCase();
          if (key && byCode.has(key)) return { itemId: byCode.get(key), by: 'webshopproduct' };
        }
      }
      const nameKey = cleanText(line.name).toLowerCase();
      if (nameKey && nameCount.get(nameKey) === 1) return { itemId: byName.get(nameKey), by: 'naam' };
      return null;
    };
  }

  /**
   * Legt de stand van een omgeving vast (maakt de rij zo nodig).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} fields Te wijzigen kolommen (enabled, months, orders_after, started_at, finished_at, error, orders_seen).
   * @returns {void}
   */
  function setState(tenantId, fields) {
    prepare('INSERT INTO wp_order_import (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO NOTHING').run(tenantId);
    const names = Object.keys(fields);
    if (!names.length) return;
    prepare(`UPDATE wp_order_import SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE tenant_id = ?`).run(...names.map((name) => fields[name]), tenantId);
  }

  /**
   * Koppelt de regels zonder artikel opnieuw (na een nieuw artikel, een samenvoeging of een nieuwe webshopsynchronisatie).
   * @param {string} tenantId Id van de omgeving.
   * @returns {number} Aantal regels dat nu een artikel heeft.
   */
  function rematch(tenantId) {
    const groups = prepare(`SELECT product_id, variation_id, sku, name FROM wp_order_lines WHERE tenant_id = ? AND item_id IS NULL
      GROUP BY product_id, variation_id, sku, name`).all(tenantId);
    if (!groups.length) return 0;
    const match = buildMatcher(tenantId);
    let updated = 0;
    transaction(db, () => {
      for (const group of groups) {
        const found = match({ productId: group.product_id, variationId: group.variation_id, sku: group.sku, name: group.name });
        if (!found) continue;
        updated += Number(prepare(`UPDATE wp_order_lines SET item_id = ?, matched_by = ? WHERE tenant_id = ? AND item_id IS NULL
          AND product_id = ? AND variation_id = ? AND sku = ? AND name = ?`).run(found.itemId, found.by, tenantId, group.product_id, group.variation_id, group.sku, group.name).changes) || 0;
      }
    });
    return updated;
  }

  /**
   * Schrijft de regels van een pagina bestellingen weg (bestaande regels blijven zoals ze zijn).
   * @param {string} tenantId Id van de omgeving.
   * @param {object[]} orders De bestellingen.
   * @param {Function} match De koppelfunctie.
   * @param {Set<string>} seenEmails E-mailadressen waarvan de klant deze ronde al bekend is.
   * @returns {{ orders: number, lines: number, customers: number }} Aantal meegeteld, nieuw weggeschreven en nieuw aangemaakte klanten.
   */
  function store(tenantId, orders, match, seenEmails) {
    let counted = 0;
    let added = 0;
    let created = 0;
    // Klanten eerst en buiten de transactie van de regels (een transactie nest niet).
    if (customers) {
      for (const order of orders) {
        if (!COUNTED_STATUSES.has(cleanText(order.status))) continue;
        const customer = customerOf(order);
        if (!customer || seenEmails.has(customer.email)) continue;
        seenEmails.add(customer.email);
        if (customers.accountIdsByEmail(tenantId, customer.email).length) continue;
        const out = customers.createCustomer(tenantId, customer);
        if (out.user) created += 1;
      }
    }
    transaction(db, () => {
      for (const order of orders) {
        const orderedAt = orderedAtOf(order);
        // Kopgegevens voor de lijst (alle echte bestellingen, ook geannuleerde); een nieuwe ronde werkt status en totaal bij.
        // Een bestelling die in WordPress naar de prullenbak of terug naar concept gaat, verdwijnt ook uit de lijst.
        if (HIDDEN_STATUSES.has(cleanText(order.status))) prepare('DELETE FROM wp_orders WHERE tenant_id = ? AND wp_order_id = ?').run(tenantId, String(order.id));
        else if (orderedAt) {
          const head = headerOf(order);
          prepare(`INSERT INTO wp_orders (id, tenant_id, wp_order_id, number, status, ordered_at, customer_name, company, email, phone, total, payment_title)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, wp_order_id) DO UPDATE SET number = EXCLUDED.number, status = EXCLUDED.status, customer_name = EXCLUDED.customer_name, company = EXCLUDED.company,
              email = EXCLUDED.email, phone = EXCLUDED.phone, total = EXCLUDED.total, payment_title = EXCLUDED.payment_title`)
            .run(crypto.randomUUID(), tenantId, String(order.id), head.number, head.status, orderedAt, head.customerName, head.company, head.email, head.phone, head.total, head.paymentTitle);
        }
        if (!COUNTED_STATUSES.has(cleanText(order.status))) continue;
        if (!orderedAt) continue;
        counted += 1;
        for (const line of linesOf(order)) {
          const found = match(line);
          const result = prepare(`INSERT INTO wp_order_lines (id, tenant_id, wp_order_id, wp_line_id, ordered_at, product_id, variation_id, sku, name, qty, item_id, matched_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, wp_order_id, wp_line_id) DO NOTHING`)
            .run(crypto.randomUUID(), tenantId, String(order.id), line.lineId, orderedAt, line.productId, line.variationId, line.sku, line.name, line.qty, found ? found.itemId : null, found ? found.by : '');
          added += Number(result.changes) || 0;
        }
      }
    });
    return { orders: counted, lines: added, customers: created };
  }

  /**
   * Haalt de bestellingen op (alle pagina's, vanaf de cursor) en schrijft de regels weg.
   * @param {string} tenantId Id van de omgeving.
   * @returns {Promise<{ orders: number, lines: number, customers: number, matched: number }>} Wat er is binnengekomen.
   */
  async function importOrders(tenantId) {
    const shop = shopOf(tenantId);
    if (!shop.url || shop.mode !== 'rest') throw new SourceError('not_configured', 'De WordPress-webshop is niet gekoppeld met de REST API (Beheer → Integraties → Webshop).', 400);
    setState(tenantId, {});
    const state = prepare('SELECT months, orders_after FROM wp_order_import WHERE tenant_id = ?').get(tenantId) || {};
    const months = Number(state.months) || DEFAULT_MONTHS;
    const start = new Date(); start.setMonth(start.getMonth() - months);
    let cursor = cleanText(state.orders_after) || start.toISOString().slice(0, 19);
    const match = buildMatcher(tenantId);
    const total = { orders: 0, lines: 0, customers: 0 };
    const seenEmails = new Set();
    let seen = 0;
    while (seen < MAX_ORDERS) {
      const batch = await fetchOrders(shop, { status: 'any', after: cursor, fetchImpl, maxPages: 1 });
      const stored = store(tenantId, batch, match, seenEmails);
      total.orders += stored.orders; total.lines += stored.lines; total.customers += stored.customers; seen += batch.length;
      if (stored.customers) prepare('UPDATE wp_order_import SET customers_created = customers_created + ? WHERE tenant_id = ?').run(stored.customers, tenantId);
      if (!batch.length) break;
      const last = cleanText(batch[batch.length - 1].date_modified_gmt || batch[batch.length - 1].date_modified);
      // Een seconde terug: bestellingen met dezelfde wijzigtijd als de laatste van de pagina mogen niet wegvallen (dubbelen vangt de unieke sleutel op).
      const lastDate = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(last) ? last : `${last}Z`);
      const next = Number.isNaN(lastDate.getTime()) ? cursor : new Date(lastDate.getTime() - 1000).toISOString().slice(0, 19);
      const advanced = next > cursor;
      if (advanced) cursor = next;
      setState(tenantId, { orders_after: cursor, orders_seen: seen });
      if (batch.length < PAGE_SIZE || !advanced) break;
    }
    const matched = rematch(tenantId);
    return { ...total, matched };
  }

  /**
   * Draait één ronde met stand, fout en haak; één per omgeving tegelijk.
   * @param {string} tenantId Id van de omgeving.
   * @returns {Promise<object>} Uitkomst van de ronde, of { skipped: 'running' }.
   */
  function round(tenantId) {
    if (running.has(tenantId)) return Promise.resolve({ skipped: 'running' });
    const job = (async () => {
      setState(tenantId, { started_at: new Date().toISOString(), error: null });
      try {
        const outcome = await importOrders(tenantId);
        setState(tenantId, { finished_at: new Date().toISOString(), error: null });
        if (afterImport) await afterImport(tenantId);
        return outcome;
      } catch (error) {
        setState(tenantId, { finished_at: new Date().toISOString(), error: String(error.message || 'Ophalen mislukt').slice(0, 300) });
        throw error;
      } finally {
        running.delete(tenantId);
      }
    })();
    running.set(tenantId, job);
    job.catch(() => {});
    return job;
  }

  /**
   * Zet het ophalen aan en start het op de achtergrond (het antwoord komt meteen). Vanaf dan werkt de uurlijkse ronde bij.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ months?: number, restart?: boolean }} [options] Aantal maanden terug en opnieuw vanaf het begin.
   * @returns {{ started: boolean }} started is false als er al een ronde loopt.
   */
  function start(tenantId, { months = null, restart = false } = {}) {
    if (running.has(tenantId)) return { started: false };
    const fields = { enabled: 1 };
    if (months) fields.months = Math.min(60, Math.max(1, Math.round(months)));
    if (restart) fields.orders_after = null;
    setState(tenantId, fields);
    round(tenantId);
    return { started: true };
  }

  /**
   * Zet het uurlijks bijwerken uit (bestaande regels blijven staan).
   * @param {string} tenantId Id van de omgeving.
   * @returns {void}
   */
  const stop = (tenantId) => setState(tenantId, { enabled: 0 });

  /**
   * Werkt alle omgevingen bij waar het ophalen aan staat (elk uur vanuit server.js).
   * @param {string[]} tenantIds De omgevingen.
   * @returns {Promise<object>} Uitkomst per omgeving.
   */
  async function runAll(tenantIds) {
    const out = {};
    if (!tenantIds.length) return out;
    const enabled = tenantIds.filter((tenantId) => { const state = prepare('SELECT enabled FROM wp_order_import WHERE tenant_id = ?').get(tenantId); return state && Number(state.enabled) === 1; });
    for (const tenantId of enabled) {
      try { out[tenantId] = await round(tenantId); } catch (error) { out[tenantId] = { error: error.message }; }
    }
    return out;
  }

  /**
   * De stand voor het scherm.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} enabled, running, months, finishedAt, error, customers (aangemaakt), orders, lines, matched, unmatched, from, to.
   */
  function status(tenantId) {
    const state = prepare('SELECT enabled, months, started_at, finished_at, error, customers_created FROM wp_order_import WHERE tenant_id = ?').get(tenantId) || {};
    const counts = prepare(`SELECT COUNT(*) AS lines, COUNT(DISTINCT wp_order_id) AS orders, COUNT(item_id) AS matched, MIN(ordered_at) AS first, MAX(ordered_at) AS last
      FROM wp_order_lines WHERE tenant_id = ?`).get(tenantId);
    /**
     * Zet een tijdstip uit de database om naar ISO-tekst.
     * @param {*} value Het tijdstip.
     * @returns {string|null} ISO-tekst, of null.
     */
    const iso = (value) => (value ? new Date(value).toISOString() : null);
    return {
      enabled: Boolean(Number(state.enabled)), running: running.has(tenantId), months: Number(state.months) || DEFAULT_MONTHS,
      startedAt: iso(state.started_at), finishedAt: iso(state.finished_at), error: state.error || '',
      customers: Number(state.customers_created) || 0, orders: Number(counts.orders), lines: Number(counts.lines), matched: Number(counts.matched), unmatched: Number(counts.lines) - Number(counts.matched),
      from: iso(counts.first), to: iso(counts.last),
    };
  }

  /**
   * De regels zonder artikel, per product, meest voorkomende eerst.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ productId: string, variationId: string, sku: string, name: string, orders: number, lines: number }[]} Hoogstens MAX_UNMATCHED groepen.
   */
  function unmatched(tenantId) {
    return prepare(`SELECT product_id, variation_id, sku, name, COUNT(*) AS lines, COUNT(DISTINCT wp_order_id) AS orders FROM wp_order_lines
      WHERE tenant_id = ? AND item_id IS NULL GROUP BY product_id, variation_id, sku, name ORDER BY COUNT(DISTINCT wp_order_id) DESC, name LIMIT ${MAX_UNMATCHED}`).all(tenantId)
      .map((row) => ({ productId: row.product_id, variationId: row.variation_id, sku: row.sku, name: row.name, orders: Number(row.orders), lines: Number(row.lines) }));
  }

  /**
   * Koppelt een groep niet-gekoppelde regels met de hand aan een artikel (de keuze blijft staan bij opnieuw ophalen).
   * @param {string} tenantId Id van de omgeving.
   * @param {{ productId?: string, variationId?: string, sku?: string, name?: string }} group De groep zoals unmatched() hem geeft.
   * @param {string} itemId Id van het artikel (hoofdartikel of variant).
   * @returns {{ updated: number }|{ error: string, status: number }} Aantal regels, of een fout.
   */
  function link(tenantId, group, itemId) {
    const item = prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND id::text = ?').get(tenantId, String(itemId || ''));
    if (!item) return { error: 'Artikel niet gevonden.', status: 404 };
    const result = prepare(`UPDATE wp_order_lines SET item_id = ?, matched_by = 'handmatig' WHERE tenant_id = ? AND item_id IS NULL
      AND product_id = ? AND variation_id = ? AND sku = ? AND name = ?`).run(item.id, tenantId, cleanText(group.productId), cleanText(group.variationId), cleanText(group.sku), cleanText(group.name));
    return { updated: Number(result.changes) || 0 };
  }

  return { start, stop, runAll, importOrders, rematch, status, unmatched, link, round };
}

module.exports = { createWpOrderHistory, headerOf, HIDDEN_STATUSES, linesOf, orderedAtOf, customerOf, COUNTED_STATUSES };
