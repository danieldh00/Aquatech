// Webshopbestellingen (WooCommerce) worden facturen: zodra een bestelling de
// ingestelde status heeft (standaard Afgerond = completed) maakt Aquatech er
// een factuur van, met een debiteur (debtors.js), en zet hem desgewenst
// meteen op definitief, betaald (als de webshop de betaling heeft) en
// verstuurd (invoicemail.js, instelling autoSend). Eén factuur per
// bestelling (unieke shop_order_id), dus opnieuw ophalen is veilig.
//
// Instelling invoicing.shopOrders: enabled, status, since (bestellingen van
// vóór die datum zijn al gefactureerd, bijv. in het oude pakket), finalize.
// Wanneer: elke 10 minuten (runAll vanuit server.js) en met de knop in
// Facturen. Voorraad: met voorraad naar de webshop (shopSource.pushStock)
// is de verkoop al afgeboekt via de webshopsynchronisatie (shopsync.js);
// anders boekt de definitieve factuur de artikelen af.
const path = require('path');
const { fetchOrders, SourceError } = require('./woocommerce');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'facturen', 'invoice-core.js'));

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => {
  const n = Number(String(v == null ? '' : v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => String(v == null ? '' : v).trim();
/** Dichtstbijzijnde Nederlandse btw-tarief. */
const snapRate = (pct) => Core.VAT_RATES.reduce((best, r) => (Math.abs(r - pct) < Math.abs(best - pct) ? r : best), 21);

/** Btw-tarief van een regel: uit de belastingregels van de bestelling, anders uit de bedragen. */
function rateOf(line, rates, fallback = 21) {
  for (const t of line.taxes || []) {
    if (num(t.total) !== 0 && rates.has(String(t.id))) return snapRate(rates.get(String(t.id)));
  }
  const base = num(line.total);
  if (base) return snapRate((num(line.total_tax) / base) * 100);
  return fallback;
}

/**
 * Een bestelling (REST v3) als factuurgegevens. articles: verkoopgegevens per
 * code (stock.saleInfo) voor de omzetgroep. Geeft { data, paidOn, shopCustomerId }.
 */
function fromOrder(order, { articles = {}, settings = null } = {}) {
  const b = order.billing || {};
  const person = [b.first_name, b.last_name].map(str).filter(Boolean).join(' ');
  const company = str(b.company);
  const country = str(b.country).toUpperCase();
  const address = [str(b.address_1), str(b.address_2), [str(b.postcode), str(b.city)].filter(Boolean).join('  '), country && country !== 'NL' ? country : '']
    .filter(Boolean).join('\n');
  const vatMeta = (order.meta_data || []).find((m) => /(^|_)(vat|btw)(_|$)|vat_number|vat_id/i.test(String(m.key || '')) && typeof m.value === 'string' && m.value.trim());
  const rates = new Map((order.tax_lines || []).map((t) => [String(t.rate_id), num(t.rate_percent)]));
  const lines = [];
  for (const l of order.line_items || []) {
    const code = str(l.sku).toUpperCase();
    const qty = num(l.quantity) || 1;
    const total = round2(num(l.total));
    const a = articles[code] || null;
    const vat = rateOf(l, rates, a ? a.vatRate : 21);
    const each = round2(total / qty);
    // Prijs per stuk alleen als dat precies uitkomt; anders één regel met het totaal.
    const exact = Math.abs(each * qty - total) < 0.005;
    lines.push({
      code: str(l.sku).slice(0, 40), description: exact ? str(l.name) : `${qty} × ${str(l.name)}`,
      qty: exact ? qty : 1, unit: a && a.unit ? a.unit : 'st', price: exact ? each : total, vat,
      group: a && a.revenueGroup ? a.revenueGroup : 'producten',
    });
  }
  for (const s of order.shipping_lines || []) {
    const total = round2(num(s.total));
    if (!total) continue;
    lines.push({ code: '', description: `Verzendkosten${s.method_title ? ` (${str(s.method_title)})` : ''}`, qty: 1, unit: '', price: total, vat: rateOf(s, rates), group: 'overig' });
  }
  for (const f of order.fee_lines || []) {
    const total = round2(num(f.total));
    if (!total) continue;
    lines.push({ code: '', description: str(f.name) || 'Toeslag', qty: 1, unit: '', price: total, vat: rateOf(f, rates), group: 'overig' });
  }
  const done = str(order.date_completed || order.date_paid || order.date_created).slice(0, 10);
  const date = Core.isDate(done) ? done : Core.today();
  const paid = str(order.date_paid).slice(0, 10);
  return {
    data: Core.sanitize({
      date,
      reference: `Webshopbestelling #${str(order.number || order.id)}`,
      customer: {
        name: company || person || `Webshopklant ${str(order.number || order.id)}`,
        contact: company ? person : '',
        address, email: str(b.email), phone: str(b.phone),
        vatNumber: vatMeta ? str(vatMeta.value).slice(0, 30) : '',
      },
      notes: order.customer_note ? `Opmerking bij de bestelling: ${str(order.customer_note)}` : '',
      lines,
    }, settings),
    paidOn: Core.isDate(paid) ? paid : null,
    shopCustomerId: Number(order.customer_id) > 0 ? String(order.customer_id) : null,
    // Om te controleren: het totaal volgens de webshop.
    shopTotal: round2(num(order.total)),
  };
}

/**
 * ctx: { db, invoices, debtors, stock, sender, settingsFor(tid), fetchImpl, log }.
 * Geeft { importOrders(tid, { user }), run, runAll(tids), status(tid) }.
 */
function createShopOrders({ db, invoices, debtors, stock, sender, settingsFor, fetchImpl, log = console }) {
  const q = (sql) => db.prepare(sql);
  const running = new Map();

  const configOf = (tenantId) => {
    const s = settingsFor(tenantId);
    return {
      shop: { ...s.get('shopSource'), consumerKey: s.get('shopConsumerKey'), consumerSecret: s.get('shopConsumerSecret') },
      conf: Core.sanitizeSettings(s.get('invoicing')),
    };
  };

  function status(tenantId) {
    const r = q('SELECT orders_after, orders_synced_at, orders_error FROM shop_sync WHERE tenant_id = ?').get(tenantId);
    return { after: (r && r.orders_after) || null, syncedAt: (r && r.orders_synced_at) || null, error: (r && r.orders_error) || null };
  }
  function setStatus(tenantId, { after = null, syncedAt = null, error = null }) {
    q(`INSERT INTO shop_sync (tenant_id, orders_after, orders_synced_at, orders_error) VALUES (?, ?, ?, ?)
      ON CONFLICT (tenant_id) DO UPDATE SET
        orders_after = COALESCE(excluded.orders_after, shop_sync.orders_after),
        orders_synced_at = COALESCE(excluded.orders_synced_at, shop_sync.orders_synced_at),
        orders_error = excluded.orders_error`).run(tenantId, after, syncedAt, error);
  }

  /** Haalt de nieuwe bestellingen op en maakt de facturen. Geeft een samenvatting. */
  async function importOrders(tenantId, { user = null } = {}) {
    const { shop, conf } = configOf(tenantId);
    const so = conf.shopOrders;
    if (!so.enabled) return { skipped: 'disabled' };
    if (!shop.url) return { skipped: 'not_configured' };
    const st = status(tenantId);
    const since = so.since ? `${so.since}T00:00:00` : '';
    const after = [st.after, since].filter(Boolean).sort().pop() || '';
    let orders;
    try {
      orders = await fetchOrders(shop, { status: so.status, after, fetchImpl });
    } catch (err) {
      if (err instanceof SourceError) setStatus(tenantId, { error: err.message });
      throw err;
    }
    const summary = { found: orders.length, imported: 0, finalized: 0, paid: 0, sent: 0, skipped: 0, invoiceIds: [] };
    const known = invoices.byShopOrders(tenantId, orders.map((o) => o.id));
    const articles = stock ? stock.saleInfo(tenantId, orders.flatMap((o) => (o.line_items || []).map((l) => str(l.sku))).filter(Boolean)) : {};
    // Voorraad al afgeboekt door de webshopsynchronisatie?
    const skipStock = Boolean(shop.push && shop.pushStock !== false && shop.mode === 'rest');
    let cursor = st.after || '';
    for (const o of orders) {
      const modified = str(o.date_modified_gmt || o.date_modified);
      if (modified > cursor) cursor = modified;
      const day = str(o.date_completed || o.date_paid || o.date_created).slice(0, 10);
      if (known.has(String(o.id)) || (so.since && day && day < so.since)) { summary.skipped++; continue; }
      const built = fromOrder(o, { articles, settings: conf });
      const debtor = debtors ? debtors.ensure(tenantId, built.data.customer, { shopCustomerId: built.shopCustomerId, source: 'webshop', start: conf.debtorStart }) : null;
      let inv;
      try {
        inv = invoices.create(tenantId, user, built.data, conf, { shopOrderId: String(o.id), debtorId: debtor ? debtor.id : null });
      } catch (err) {
        // Tegelijk al gemaakt (unieke index op de bestelling): overslaan.
        if (/unique|constraint/i.test(err.message)) { summary.skipped++; continue; }
        throw err;
      }
      summary.imported++;
      summary.invoiceIds.push(inv.id);
      if (!so.finalize || !built.data.lines.length) continue;
      const fin = invoices.finalize(tenantId, user, inv.id, conf, { skipStock });
      if (!fin || fin.error) continue;
      summary.finalized++;
      if (built.paidOn) {
        invoices.setPaid(tenantId, inv.id, true, built.paidOn);
        summary.paid++;
      }
      if (sender) {
        const r = await sender.autoSend(tenantId, inv.id);
        if (r.sent) summary.sent++;
      }
    }
    setStatus(tenantId, { after: cursor || null, syncedAt: new Date().toISOString(), error: null });
    return summary;
  }

  /** Eén keer tegelijk per omgeving. */
  function run(tenantId, opts = {}) {
    const prev = running.get(tenantId) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => importOrders(tenantId, opts));
    running.set(tenantId, next);
    next.finally(() => { if (running.get(tenantId) === next) running.delete(tenantId); }).catch(() => {});
    return next;
  }

  /** Alle omgevingen met bestellingen ophalen aan (elke 10 minuten vanuit server.js). */
  async function runAll(tenantIds) {
    const out = {};
    for (const id of tenantIds) {
      let cfg;
      try { cfg = configOf(id); } catch { continue; }
      if (!cfg.conf.shopOrders.enabled || !cfg.shop.url) continue;
      try {
        out[id] = await run(id);
      } catch (err) {
        log.warn(`Webshopbestellingen (${id}): ophalen mislukt: ${err.code || err.message}`);
      }
    }
    return out;
  }

  return { importOrders, run, runAll, status };
}

module.exports = { createShopOrders, fromOrder, snapRate };
