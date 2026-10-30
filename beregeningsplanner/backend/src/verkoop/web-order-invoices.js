// Facturen bij bestellingen van de eigen webshop (module winkel). Zodra een
// bestelling op Verzonden gaat maakt Aquatech er een factuur van, met een
// debiteur, en zet hem desgewenst meteen op definitief (en verstuurd per
// e-mail, instelling autoSend). Visma volgt via de gewone haak van definitief
// maken. Eén factuur per bestelling (shop_order_id = `web:<bestelling>`,
// uniek per omgeving), dus opnieuw proberen is veilig. De voorraad is bij
// Verzonden al afgeboekt (stock.issueOrder), de factuur boekt dus niets af.
// Betaling is nu altijd "op rekening": de factuur blijft open tot een
// beheerder hem in Facturen op betaald zet. Een afgeronde retour (web-returns.js)
// krijgt een creditnota voor de teruggestuurde regels bij die factuur.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');

const { invoiceFileName } = require('./invoice-pdf');

const Core = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));

/**
 * Sleutel waaronder de factuur van een bestelling bij de facturen staat.
 * @param {string} orderId Id van de bestelling.
 * @returns {string} De waarde voor shop_order_id.
 */
const invoiceKey = (orderId) => `web:${orderId}`;

/**
 * Zet een webshopbestelling om naar factuurgegevens. Bedragen komen uit de
 * bestelling (excl. btw per stuk, het tarief van de bestelling; bij btw
 * verlegd 0% met een vermelding).
 * @param {object} order De bestelling (web-orders.js, volledig).
 * @param {object} articles Verkoopgegevens per code (stock.saleInfo) voor eenheid en omzetgroep.
 * @param {object} settings De factuurinstellingen.
 * @returns {object} De opgeschoonde factuurgegevens (Core.sanitize).
 */
function fromWebOrder(order, articles, settings) {
  const customer = order.customer || {};
  const address = order.address || {};
  const company = String(customer.company || '').trim();
  const shifted = Boolean(order.vat && order.vat.shifted);
  const lines = order.lines.map((line) => {
    const article = articles[String(line.code || '').toUpperCase()] || null;
    return {
      code: line.code, description: line.name, qty: line.qty, unit: line.unit || (article && article.unit) || 'st', price: line.unitExcl, vat: shifted ? 0 : line.vatRate,
      group: article && article.revenueGroup ? article.revenueGroup : 'producten',
    };
  });
  const shipping = order.shipping || null;
  if (shipping && Number(shipping.priceExcl) > 0) {
    lines.push({ code: '', description: `Verzendkosten (${shipping.label || 'DPD'})`, qty: 1, unit: '', price: shipping.priceExcl, vat: shifted ? 0 : shipping.vatRate, group: 'overig' });
  }
  const country = address.country && address.country !== 'NL' ? address.country : '';
  const notes = [
    shifted ? `BTW verlegd naar afnemer${order.vat.number ? ` (btw-nummer ${order.vat.number})` : ''}; levering naar een ander EU-land.` : '',
    order.note ? `Opmerking bij de bestelling: ${order.note}` : '',
  ].filter(Boolean).join('\n');
  return Core.sanitize({
    date: Core.today(),
    reference: `Webshopbestelling ${order.number}`,
    customer: {
      name: company || customer.name, contact: company ? customer.name : '',
      address: [address.street, [address.postcode, address.city].filter(Boolean).join('  '), country].filter(Boolean).join('\n'),
      email: customer.email, phone: customer.phone, vatNumber: order.vat && order.vat.number ? order.vat.number : '',
    },
    notes, lines,
  }, settings);
}

/**
 * Maakt het factureren van webshopbestellingen.
 * @param {{ orders: object, invoices: object, returns?: object, debtors?: object, stock?: object, sender?: object, settingsFor: Function, log?: object }} ctx De opslagen en hulpfuncties van de server (settingsFor(tenantId) geeft de instellingen van een omgeving).
 * @returns {{ invoiceFor: Function, ensureInvoice: Function, mailIfFinalized: Function, pdfFor: Function, onShipped: Function, creditReturn: Function }} De functies.
 */
function createWebOrderInvoices({ orders, invoices, returns = null, debtors = null, stock = null, sender = null, settingsFor, log = console }) {
  /**
   * De factuurinstellingen van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} De opgeschoonde instellingen.
   */
  const settingsOf = (tenantId) => Core.sanitizeSettings(settingsFor(tenantId).get('invoicing'));

  /**
   * De factuur van een bestelling, als die er is.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @returns {{ id: string, number: string, status: string, total: number, paidAt: ?string }|null} Kerngegevens van de factuur, of null.
   */
  function invoiceFor(tenantId, orderId) {
    const invoiceId = invoices.byShopOrders(tenantId, [invoiceKey(orderId)]).get(invoiceKey(orderId));
    if (!invoiceId) return null;
    const invoice = invoices.get(tenantId, invoiceId);
    return invoice ? { id: invoice.id, number: invoice.number, status: invoice.status, total: invoice.total, paidAt: invoice.paidAt } : null;
  }

  /**
   * Zorgt dat de bestelling een factuur heeft: maakt hem aan (concept) en zet
   * hem zo ingesteld meteen op definitief. Heeft de bestelling al een factuur,
   * dan verandert er niets. Een fout wordt in de bestelling bewaard.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @param {object|null} user Wie het doet.
   * @returns {{ invoice?: object, created?: boolean, finalizedNow?: boolean, error?: string, status?: number }} De factuur (finalizedNow: hij is door deze aanroep definitief geworden), of een foutmelding.
   */
  function ensureInvoice(tenantId, orderId, user) {
    const order = orders.get(tenantId, orderId);
    if (!order) return { error: 'Bestelling niet gevonden.', status: 404 };
    if (!['verzonden', 'afgerond'].includes(order.status)) return { error: 'Een factuur kan pas als de bestelling is verzonden.', status: 409 };
    const existing = invoiceFor(tenantId, order.id);
    const settings = settingsOf(tenantId);
    if (existing) {
      // Een concept dat bleef staan doordat definitief maken mislukte, alsnog afmaken.
      if (existing.status !== 'concept' || !order.invoiceError || !settings.webOrders.finalize) return { invoice: existing, created: false };
      if (!settings.webOrders.enabled) return { error: 'Facturen voor webshopbestellingen staan uit (Facturen → Instellingen).', status: 409 };
      const finalized = invoices.finalize(tenantId, user, existing.id, settings, { skipStock: true });
      if (!finalized || finalized.error) {
        const reason = finalized && finalized.error ? finalized.error : 'Factuur niet gevonden.';
        orders.updateData(tenantId, order.id, { invoiceError: String(reason).slice(0, 300) });
        return { error: `Factuur definitief maken mislukt: ${reason}`, status: 500 };
      }
      orders.updateData(tenantId, order.id, { invoiceError: null });
      return { invoice: invoiceFor(tenantId, order.id), created: false, finalizedNow: true };
    }
    if (!settings.webOrders.enabled) return { error: 'Facturen voor webshopbestellingen staan uit (Facturen → Instellingen).', status: 409 };
    try {
      const articles = stock ? stock.saleInfo(tenantId, order.lines.map((line) => line.code).filter(Boolean)) : {};
      const data = fromWebOrder(order, articles, settings);
      const debtor = debtors ? debtors.ensure(tenantId, data.customer, { customerId: order.userId, source: 'webshop', start: settings.debtorStart }) : null;
      const created = invoices.create(tenantId, user, data, settings, { shopOrderId: invoiceKey(order.id), customerId: order.userId, debtorId: debtor ? debtor.id : null });
      if (settings.webOrders.finalize) {
        const finalized = invoices.finalize(tenantId, user, created.id, settings, { skipStock: true });
        if (finalized && finalized.error) throw new Error(finalized.error);
      }
      orders.updateData(tenantId, order.id, { invoiceError: null });
      const invoice = invoiceFor(tenantId, order.id);
      return { invoice, created: true, finalizedNow: invoice.status === 'definitief' };
    } catch (error) {
      // Tegelijk al gemaakt (unieke index op de bestelling): de bestaande factuur is goed.
      const raced = /unique|constraint/i.test(error.message) ? invoiceFor(tenantId, order.id) : null;
      if (raced) return { invoice: raced, created: false };
      orders.updateData(tenantId, order.id, { invoiceError: String(error.message || error).slice(0, 300) });
      return { error: `Factuur maken mislukt: ${error.message}`, status: 500 };
    }
  }

  /**
   * De factuur van een bestelling als PDF, voor de klant zelf (de aanroeper
   * controleert dat de bestelling van de klant is). Concepten worden niet getoond.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @returns {{ name: string, body: Buffer }|null} Bestandsnaam en PDF, of null als er (nog) geen definitieve factuur is.
   */
  function pdfFor(tenantId, orderId) {
    if (!sender) return null;
    const found = invoiceFor(tenantId, orderId);
    if (!found || found.status === 'concept') return null;
    const invoice = invoices.get(tenantId, found.id);
    return invoice ? { name: invoiceFileName(invoice), body: sender.pdfOf(tenantId, invoice) } : null;
  }

  /**
   * Mailt de factuur als hij zojuist definitief is geworden en automatisch
   * mailen aan staat (instelling autoSend). Een mailfout wordt alleen gelogd.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ invoice?: object, finalizedNow?: boolean }} outcome Het resultaat van ensureInvoice.
   * @returns {Promise<void>} Klaar als de mail is verstuurd of overgeslagen.
   */
  async function mailIfFinalized(tenantId, outcome) {
    if (!outcome.finalizedNow || !sender) return;
    try { await sender.autoSend(tenantId, outcome.invoice.id); } catch (error) { log.warn(`Factuur ${outcome.invoice.number} mailen mislukt: ${error.message}`); }
  }

  /**
   * Haak voor web-orders.js: na Verzonden de factuur maken en eventueel mailen.
   * Mislukt het, dan blijft de verzending staan (de fout staat bij de bestelling
   * en met de knop in Beheer kan het opnieuw).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De bestelling die is verzonden.
   * @param {object|null} user Wie de status wijzigde.
   * @returns {Promise<void>} Klaar als de factuur is gemaakt en (zo ingesteld) verstuurd.
   */
  async function onShipped(tenantId, order, user) {
    const out = ensureInvoice(tenantId, order.id, user);
    if (out.error) { log.warn(`Factuur bij ${order.number}: ${out.error}`); return; }
    await mailIfFinalized(tenantId, out);
  }

  /**
   * Maakt de creditnota voor een afgeronde retour: een creditfactuur bij de factuur
   * van de bestelling met alleen de teruggestuurde regels, zo ingesteld meteen
   * definitief en per mail verstuurd. De voorraad is al door de retour zelf
   * teruggeboekt, de creditnota boekt dus niets. Heeft de retour al een creditnota,
   * dan verandert er niets. Zonder definitieve factuur (of met facturen voor
   * webshopbestellingen uit) wordt er niets gemaakt en staat dat bij de retour.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} returnId Id van de retour.
   * @param {object|null} user Wie het doet.
   * @returns {Promise<{ credit?: { invoiceId: string, number: string, status: string }, existing?: boolean, skipped?: string, error?: string, status?: number }>} De creditnota, of waarom er geen is.
   */
  async function creditReturn(tenantId, returnId, user) {
    const record = returns ? returns.get(tenantId, returnId) : null;
    if (!record) return { error: 'Retour niet gevonden.', status: 404 };
    if (record.credit) return { credit: record.credit, existing: true };
    /**
     * Legt vast waarom er (nog) geen creditnota is en meldt dat terug.
     * @param {string} reason De reden.
     * @returns {{ skipped: string }} De melding.
     */
    const skip = (reason) => { returns.updateData(tenantId, record.id, { creditError: reason }); return { skipped: reason }; };
    const settings = settingsOf(tenantId);
    if (!settings.webOrders.enabled) return skip('Facturen voor webshopbestellingen staan uit (Facturen → Instellingen): er is geen creditnota gemaakt.');
    const found = invoiceFor(tenantId, record.orderId);
    if (!found || found.status === 'concept') return skip('Er is nog geen definitieve factuur bij de bestelling: maak de creditnota zelf in Facturen zodra die er is.');
    try {
      const original = invoices.get(tenantId, found.id);
      const draft = Core.creditOf(original);
      const byCode = new Map(draft.lines.map((line) => [String(line.code || '').toUpperCase(), line]));
      draft.lines = record.lines.map((line) => {
        const match = byCode.get(String(line.code || '').toUpperCase());
        return match ? { ...match, qty: -Math.abs(line.qty) } : null;
      }).filter(Boolean);
      if (!draft.lines.length) return skip('De teruggestuurde artikelen staan niet op de factuur: er is geen creditnota gemaakt.');
      draft.intro = `Creditering van factuur ${original.number} voor retour ${record.number}`;
      const created = invoices.create(tenantId, user, draft, settings, { kind: 'credit', creditOf: original.id, customerId: original.customerId, debtorId: original.debtorId });
      let outcome = { invoice: created, finalizedNow: false };
      if (settings.webOrders.finalize) {
        const finalized = invoices.finalize(tenantId, user, created.id, settings, { skipStock: true });
        if (finalized && finalized.error) throw new Error(finalized.error);
        outcome = { invoice: finalized.invoice || invoices.get(tenantId, created.id), finalizedNow: true };
      }
      const saved = invoices.get(tenantId, created.id);
      const credit = { invoiceId: saved.id, number: saved.number, status: saved.status };
      returns.updateData(tenantId, record.id, { credit, creditError: '' });
      await mailIfFinalized(tenantId, { invoice: saved, finalizedNow: outcome.finalizedNow });
      return { credit };
    } catch (error) {
      const reason = `Creditnota maken mislukt: ${String(error.message || error).slice(0, 250)}`;
      returns.updateData(tenantId, record.id, { creditError: reason });
      return { error: reason, status: 500 };
    }
  }

  return { invoiceFor, ensureInvoice, mailIfFinalized, pdfFor, onShipped, creditReturn };
}

module.exports = { createWebOrderInvoices, fromWebOrder, invoiceKey };
