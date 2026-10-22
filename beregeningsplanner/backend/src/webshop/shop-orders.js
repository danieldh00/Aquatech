// Webshopbestellingen (WooCommerce) worden facturen: zodra een bestelling de
// ingestelde status heeft (standaard Afgerond = completed) maakt Aquatech er
// een factuur van, met een debiteur (debtors.js), en zet hem desgewenst
// meteen op definitief, betaald (als de webshop de betaling heeft) en
// verstuurd (invoice-mail.js, instelling autoSend). Eén factuur per
// bestelling (unieke shop_order_id), dus opnieuw ophalen is veilig.
//
// Instelling invoicing.shopOrders: enabled, status, since (bestellingen van
// vóór die datum zijn al gefactureerd, bijv. in het oude pakket), finalize.
// Wanneer: elke 10 minuten (runAll vanuit server.js) en met de knop in
// Facturen. Voorraad: met voorraad naar de webshop (shopSource.pushStock)
// is de verkoop al afgeboekt via de webshopsynchronisatie (shop-sync.js);
// anders boekt de definitieve factuur de artikelen af.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { fetchOrders, SourceError } = require('./woocommerce');

const Core = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));

/**
 * Rondt af op twee decimalen.
 * @param {*} value Het bedrag.
 * @returns {number} Afgerond (0 bij ongeldige invoer).
 */
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
/**
 * Leest een getal, ook met een komma.
 * @param {*} value De invoer.
 * @returns {number} Het getal, of 0.
 */
const toNumber = (value) => {
  const parsed = Number(String(value == null ? '' : value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
};
/**
 * Maakt van een waarde getrimde tekst.
 * @param {*} value De invoer.
 * @returns {string} De tekst.
 */
const cleanText = (value) => String(value == null ? '' : value).trim();
/**
 * Het dichtstbijzijnde Nederlandse btw-tarief.
 * @param {number} pct Percentage uit de webshop.
 * @returns {number} 0, 9 of 21.
 */
const snapRate = (pct) => Core.VAT_RATES.reduce((best, rate) => (Math.abs(rate - pct) < Math.abs(best - pct) ? rate : best), 21);

/**
 * Btw-tarief van een regel: uit de belastingregels van de bestelling, anders uit de bedragen.
 * @param {object} line Bestelregel, verzend- of toeslagregel.
 * @param {Map<string, number>} rates Belastingregel-id → percentage.
 * @param {number} [fallback] Tarief als er niets af te leiden is.
 * @returns {number} Het btw-tarief.
 */
function rateOf(line, rates, fallback = 21) {
  for (const tax of line.taxes || []) {
    if (toNumber(tax.total) !== 0 && rates.has(String(tax.id))) return snapRate(rates.get(String(tax.id)));
  }
  const base = toNumber(line.total);
  if (base) return snapRate((toNumber(line.total_tax) / base) * 100);
  return fallback;
}

/**
 * Zet een bestelling (REST v3) om naar factuurgegevens.
 * @param {object} order De bestelling.
 * @param {{ articles?: object, settings?: object }} [context] Verkoopgegevens per code (stock.saleInfo) voor eenheid, btw en omzetgroep, en de factuurinstellingen.
 * @returns {{ data: object, paidOn: string|null, shopCustomerId: string|null, shopTotal: number }} Factuurinhoud, betaaldatum, klant-id in de webshop en het webshoptotaal.
 */
function fromOrder(order, { articles = {}, settings = null } = {}) {
  const billing = order.billing || {};
  const person = [billing.first_name, billing.last_name].map(cleanText).filter(Boolean).join(' ');
  const company = cleanText(billing.company);
  const country = cleanText(billing.country).toUpperCase();
  const address = [cleanText(billing.address_1), cleanText(billing.address_2), [cleanText(billing.postcode), cleanText(billing.city)].filter(Boolean).join('  '), country && country !== 'NL' ? country : '']
    .filter(Boolean).join('\n');
  const vatMeta = (order.meta_data || []).find((entry) => /(^|_)(vat|btw)(_|$)|vat_number|vat_id/i.test(String(entry.key || '')) && typeof entry.value === 'string' && entry.value.trim());
  const rates = new Map((order.tax_lines || []).map((taxLine) => [String(taxLine.rate_id), toNumber(taxLine.rate_percent)]));
  const lines = [];
  for (const item of order.line_items || []) {
    const code = cleanText(item.sku).toUpperCase();
    const qty = toNumber(item.quantity) || 1;
    const total = round2(toNumber(item.total));
    const article = articles[code] || null;
    const vat = rateOf(item, rates, article ? article.vatRate : 21);
    const each = round2(total / qty);
    // Prijs per stuk alleen als dat precies uitkomt; anders één regel met het totaal.
    const exact = Math.abs(each * qty - total) < 0.005;
    lines.push({
      code: cleanText(item.sku).slice(0, 40), description: exact ? cleanText(item.name) : `${qty} × ${cleanText(item.name)}`,
      qty: exact ? qty : 1, unit: article && article.unit ? article.unit : 'st', price: exact ? each : total, vat,
      group: article && article.revenueGroup ? article.revenueGroup : 'producten',
    });
  }
  for (const shipping of order.shipping_lines || []) {
    const total = round2(toNumber(shipping.total));
    if (!total) continue;
    lines.push({ code: '', description: `Verzendkosten${shipping.method_title ? ` (${cleanText(shipping.method_title)})` : ''}`, qty: 1, unit: '', price: total, vat: rateOf(shipping, rates), group: 'overig' });
  }
  for (const fee of order.fee_lines || []) {
    const total = round2(toNumber(fee.total));
    if (!total) continue;
    lines.push({ code: '', description: cleanText(fee.name) || 'Toeslag', qty: 1, unit: '', price: total, vat: rateOf(fee, rates), group: 'overig' });
  }
  const done = cleanText(order.date_completed || order.date_paid || order.date_created).slice(0, 10);
  const date = Core.isDate(done) ? done : Core.today();
  const paid = cleanText(order.date_paid).slice(0, 10);
  return {
    data: Core.sanitize({
      date,
      reference: `Webshopbestelling #${cleanText(order.number || order.id)}`,
      customer: {
        name: company || person || `Webshopklant ${cleanText(order.number || order.id)}`,
        contact: company ? person : '',
        address, email: cleanText(billing.email), phone: cleanText(billing.phone),
        vatNumber: vatMeta ? cleanText(vatMeta.value).slice(0, 30) : '',
      },
      notes: order.customer_note ? `Opmerking bij de bestelling: ${cleanText(order.customer_note)}` : '',
      lines,
    }, settings),
    paidOn: Core.isDate(paid) ? paid : null,
    shopCustomerId: Number(order.customer_id) > 0 ? String(order.customer_id) : null,
    // Om te controleren: het totaal volgens de webshop.
    shopTotal: round2(toNumber(order.total)),
  };
}

/**
 * Maakt het ophalen van webshopbestellingen als facturen.
 * @param {object} ctx db, invoices, debtors, stock, sender, settingsFor(tenantId), fetchImpl en log.
 * @returns {{ importOrders: Function, run: Function, runAll: Function, status: Function }} De functies.
 */
function createShopOrders({ db, invoices, debtors, stock, sender, settingsFor, fetchImpl, log = console }) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  const running = new Map();

  /**
   * Koppelinstelling (met sleutels) en factuurinstellingen van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ shop: object, conf: object }} De instellingen.
   */
  const configOf = (tenantId) => {
    const settings = settingsFor(tenantId);
    return {
      shop: { ...settings.get('shopSource'), consumerKey: settings.get('shopConsumerKey'), consumerSecret: settings.get('shopConsumerSecret') },
      conf: Core.sanitizeSettings(settings.get('invoicing')),
    };
  };

  /**
   * Stand van het ophalen: tot waar (wijzigingsmoment), wanneer en de laatste fout.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ after: string|null, syncedAt: string|null, error: string|null }} De stand.
   */
  function status(tenantId) {
    const row = prepare('SELECT orders_after, orders_synced_at, orders_error FROM shop_sync WHERE tenant_id = ?').get(tenantId);
    return { after: (row && row.orders_after) || null, syncedAt: (row && row.orders_synced_at) || null, error: (row && row.orders_error) || null };
  }
  /**
   * Legt de stand van het ophalen vast; lege velden houden hun waarde.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ after?: string, syncedAt?: string, error?: string }} state De nieuwe stand.
   */
  function setStatus(tenantId, { after = null, syncedAt = null, error = null }) {
    prepare(`INSERT INTO shop_sync (tenant_id, orders_after, orders_synced_at, orders_error) VALUES (?, ?, ?, ?)
      ON CONFLICT (tenant_id) DO UPDATE SET
        orders_after = COALESCE(excluded.orders_after, shop_sync.orders_after),
        orders_synced_at = COALESCE(excluded.orders_synced_at, shop_sync.orders_synced_at),
        orders_error = excluded.orders_error`).run(tenantId, after, syncedAt, error);
  }

  /**
   * Haalt de nieuwe bestellingen op en maakt de facturen (zo ingesteld ook definitief, betaald en verstuurd).
   * @param {string} tenantId Id van de omgeving.
   * @param {{ user?: object }} [options] Wie het doet.
   * @returns {Promise<object>} Samenvatting (found, imported, finalized, paid, sent, skipped, invoiceIds) of { skipped }.
   */
  async function importOrders(tenantId, { user = null } = {}) {
    const { shop, conf } = configOf(tenantId);
    const orderSettings = conf.shopOrders;
    if (!orderSettings.enabled) return { skipped: 'disabled' };
    if (!shop.url) return { skipped: 'not_configured' };
    const syncStatus = status(tenantId);
    const since = orderSettings.since ? `${orderSettings.since}T00:00:00` : '';
    const after = [syncStatus.after, since].filter(Boolean).sort().pop() || '';
    let orders;
    try {
      orders = await fetchOrders(shop, { status: orderSettings.status, after, fetchImpl });
    } catch (error) {
      if (error instanceof SourceError) setStatus(tenantId, { error: error.message });
      throw error;
    }
    const summary = { found: orders.length, imported: 0, finalized: 0, paid: 0, sent: 0, skipped: 0, invoiceIds: [] };
    const known = invoices.byShopOrders(tenantId, orders.map((order) => order.id));
    const articles = stock ? stock.saleInfo(tenantId, orders.flatMap((order) => (order.line_items || []).map((item) => cleanText(item.sku))).filter(Boolean)) : {};
    // Voorraad al afgeboekt door de webshopsynchronisatie?
    const skipStock = Boolean(shop.push && shop.pushStock !== false && shop.mode === 'rest');
    let cursor = syncStatus.after || '';
    for (const order of orders) {
      const modified = cleanText(order.date_modified_gmt || order.date_modified);
      if (modified > cursor) cursor = modified;
      const day = cleanText(order.date_completed || order.date_paid || order.date_created).slice(0, 10);
      if (known.has(String(order.id)) || (orderSettings.since && day && day < orderSettings.since)) { summary.skipped++; continue; }
      const built = fromOrder(order, { articles, settings: conf });
      const debtor = debtors ? debtors.ensure(tenantId, built.data.customer, { shopCustomerId: built.shopCustomerId, source: 'webshop', start: conf.debtorStart }) : null;
      let invoice;
      try {
        invoice = invoices.create(tenantId, user, built.data, conf, { shopOrderId: String(order.id), debtorId: debtor ? debtor.id : null });
      } catch (error) {
        // Tegelijk al gemaakt (unieke index op de bestelling): overslaan.
        if (/unique|constraint/i.test(error.message)) { summary.skipped++; continue; }
        throw error;
      }
      summary.imported++;
      summary.invoiceIds.push(invoice.id);
      if (!orderSettings.finalize || !built.data.lines.length) continue;
      const finalized = invoices.finalize(tenantId, user, invoice.id, conf, { skipStock });
      if (!finalized || finalized.error) continue;
      summary.finalized++;
      if (built.paidOn) {
        invoices.setPaid(tenantId, invoice.id, true, built.paidOn);
        summary.paid++;
      }
      if (sender) {
        const mailResult = await sender.autoSend(tenantId, invoice.id);
        if (mailResult.sent) summary.sent++;
      }
    }
    setStatus(tenantId, { after: cursor || null, syncedAt: new Date().toISOString(), error: null });
    return summary;
  }

  /**
   * Ophalen per omgeving één keer tegelijk; een volgende wacht op de lopende.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} [options] Zie importOrders.
   * @returns {Promise<object>} Het resultaat van importOrders.
   */
  function run(tenantId, options = {}) {
    const previous = running.get(tenantId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => importOrders(tenantId, options));
    running.set(tenantId, next);
    next.finally(() => { if (running.get(tenantId) === next) running.delete(tenantId); }).catch(() => {});
    return next;
  }

  /**
   * Haalt bestellingen op voor alle omgevingen waar dat aan staat (elke 10 minuten vanuit server.js).
   * @param {string[]} tenantIds De omgevingen.
   * @returns {Promise<object>} Resultaat per omgeving.
   */
  async function runAll(tenantIds) {
    const out = {};
    for (const id of tenantIds) {
      let config;
      try { config = configOf(id); } catch { continue; }
      if (!config.conf.shopOrders.enabled || !config.shop.url) continue;
      try {
        out[id] = await run(id);
      } catch (error) {
        log.warn(`Webshopbestellingen (${id}): ophalen mislukt: ${error.code || error.message}`);
      }
    }
    return out;
  }

  return { importOrders, run, runAll, status };
}

module.exports = { createShopOrders, fromOrder, snapRate };
