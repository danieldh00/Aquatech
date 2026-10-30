// Online betalen voor bestellingen van de eigen webshop (Mollie). Een
// bestelling met betaalwijze online krijgt bij het plaatsen `data.pay`; hier
// start de klant de betaling (een betaalpagina bij Mollie) en leggen we de
// uitkomst vast. De uitkomst komt altijd uit een opvraging bij Mollie zelf:
// via de webhook van Mollie, of als de klant terugkomt in de winkel. Dat kan
// tegelijk gebeuren; de overgang naar betaald gebeurt maar één keer (in een
// transactie, web-orders.js changePay) en roept dan de haken van onPaid aan.
// Een mislukte, geannuleerde of verlopen betaling laat de bestelling staan
// zodat de klant opnieuw kan betalen; na de bewaartijd uit de instelling
// shopPayment vervalt hij en komt de voorraad vrij (expireUnpaid, elk uur).
const { configOf, validPaymentId } = require('./mollie');

/** Hoe de Mollie-status bij ons heet: betaald, nog open of mislukt. */
const MOLLIE_STATES = { paid: 'betaald', open: 'open', pending: 'open', authorized: 'open', canceled: 'mislukt', expired: 'mislukt', failed: 'mislukt' };

/**
 * Maakt de betaalfuncties voor webshopbestellingen.
 * @param {{ orders: object, mollie: object, settingsFor: Function, log?: object }} deps De bestelopslag (web-orders.js), de Mollie-client (mollie.js), de instellingen per omgeving en de logger.
 * @returns {{ start: Function, sync: Function, expireUnpaid: Function, onPaid: Function, optionsFor: Function }} De functies.
 */
function createWebPayments({ orders, mollie, settingsFor, log = console }) {
  const paidHooks = [];

  /**
   * Registreert een haak die één keer wordt aangeroepen als een bestelling betaald is.
   * @param {Function} hook Functie (tenantId, order); mag een belofte geven, fouten worden alleen gelogd.
   * @returns {void}
   */
  const onPaid = (hook) => { paidHooks.push(hook); };

  /**
   * De betaalwijzen die een klant bij het afrekenen mag kiezen.
   * Online betalen als het aan staat; op rekening volgens de instelling (altijd als online uit staat, zodat bestellen blijft werken).
   * @param {string} tenantId Id van de omgeving.
   * @param {{ customerGroup?: string }} viewer De klant (zakelijk of niet).
   * @returns {string[]} 'online' en/of 'rekening' (online staat voorop).
   */
  function optionsFor(tenantId, viewer) {
    const config = configOf(settingsFor(tenantId));
    const business = Boolean(viewer) && viewer.customerGroup === 'zakelijk';
    const onAccount = !config.online || config.onAccount === 'iedereen' || (config.onAccount === 'zakelijk' && business);
    return [...(config.online ? ['online'] : []), ...(onAccount ? ['rekening'] : [])];
  }

  /**
   * Start de haken nadat een bestelling betaald is, zonder op de mail te wachten; een fout in een haak houdt de rest niet tegen.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De betaalde bestelling.
   * @returns {void}
   */
  function runPaidHooks(tenantId, order) {
    for (const hook of paidHooks) {
      try { Promise.resolve(hook(tenantId, order)).catch((error) => log.warn(`Na betalen van ${order.number}: ${error.message}`)); } catch (error) { log.warn(`Na betalen van ${order.number}: ${error.message}`); }
    }
  }

  /**
   * Verwerkt de stand van een Mollie-betaling in de bestelling. Alleen de laatst
   * gestarte betaling kan de bestelling op mislukt zetten (een eerdere poging
   * die later alsnog mislukt telt niet); betaald telt altijd, ook als de
   * bestelling intussen is geannuleerd (dan staat er dat terugbetalen nodig is).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @param {object} payment De betaling zoals Mollie hem geeft (mollie.getPayment).
   * @returns {Promise<{ order?: object, becamePaid: boolean }>} De bestelling en of hij door deze aanroep betaald werd.
   */
  async function apply(tenantId, orderId, payment) {
    const state = MOLLIE_STATES[payment.status] || 'open';
    const out = orders.changePay(tenantId, orderId, (pay, order) => {
      if (!pay.ids.includes(payment.id)) return null;
      if (state === 'betaald' && pay.status !== 'betaald') {
        return { ...pay, status: 'betaald', paidAt: payment.paidAt || new Date().toISOString(), method: payment.method || pay.method || '', paidId: payment.id, ...(order.status === 'geannuleerd' ? { refundNeeded: true } : {}) };
      }
      if (state === 'mislukt' && pay.status === 'open' && pay.id === payment.id) return { ...pay, status: 'mislukt', failedAt: new Date().toISOString(), failure: payment.status };
      return null;
    });
    if (out.error) return { becamePaid: false };
    const becamePaid = Boolean(out.changed) && out.order.pay.status === 'betaald' && out.order.pay.paidId === payment.id;
    if (becamePaid) runPaidHooks(tenantId, out.order);
    return { order: out.order, becamePaid };
  }

  /**
   * Vraagt een betaling bij Mollie op en verwerkt hem. De betaling moet bij de
   * bestelling horen (id, metadata en bedrag kloppen), anders gebeurt er niets.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @param {{ paymentId?: string }} [options] De betaling om te controleren (webhook); zonder de laatst gestarte.
   * @returns {Promise<{ order?: object, becamePaid: boolean, ignored?: boolean }>} De bestelling, of hij betaald werd, of dat de betaling genegeerd is. Een fout van Mollie wordt doorgegeven.
   */
  async function sync(tenantId, orderId, { paymentId } = {}) {
    const order = orders.get(tenantId, orderId);
    if (!order || order.payment !== 'online' || !order.pay) return { becamePaid: false, ignored: true };
    const id = paymentId || order.pay.id;
    if (!id || !validPaymentId(id) || !order.pay.ids.includes(id)) return { order, becamePaid: false, ignored: true };
    const config = configOf(settingsFor(tenantId));
    if (!config.apiKey) return { order, becamePaid: false, ignored: true };
    const payment = await mollie.getPayment(config.apiKey, id);
    if (payment.orderId !== order.id || !(Math.abs(payment.amount - order.totals.total) <= 0.005)) {
      log.warn(`Betaling ${id} hoort niet bij bestelling ${order.number}; genegeerd.`);
      return { order, becamePaid: false, ignored: true };
    }
    return apply(tenantId, order.id, payment);
  }

  /**
   * Zorgt dat de klant een betaalpagina heeft: de lopende betaling als die nog open is,
   * anders een nieuwe. Een bestelling die al betaald of geannuleerd is wordt geweigerd.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De online bestelling.
   * @returns {Promise<{ checkoutUrl?: string, paid?: boolean, error?: string, status?: number }>} Het adres van de betaalpagina, of paid als hij intussen betaald bleek, of een foutmelding.
   */
  async function start(tenantId, order) {
    const config = configOf(settingsFor(tenantId));
    if (!config.online) return { error: 'Online betalen staat niet aan.', status: 409 };
    if (order.payment !== 'online' || !order.pay) return { error: 'Deze bestelling gaat op rekening.', status: 409 };
    if (order.status !== 'nieuw') return { error: 'Deze bestelling kan niet meer betaald worden.', status: 409 };
    if (order.pay.status === 'betaald') return { paid: true };
    try {
      if (order.pay.id && order.pay.status === 'open' && order.pay.checkoutUrl) {
        const current = await mollie.getPayment(config.apiKey, order.pay.id);
        if (MOLLIE_STATES[current.status] === 'betaald') { await apply(tenantId, order.id, current); return { paid: true }; }
        if (MOLLIE_STATES[current.status] === 'open') return { checkoutUrl: order.pay.checkoutUrl };
        await apply(tenantId, order.id, current);
      }
      const attempt = order.pay.ids.length + 1;
      const base = config.publicUrl;
      const created = await mollie.createPayment(config.apiKey, {
        amount: order.totals.total, description: `Bestelling ${order.number}`, idempotencyKey: `${order.id}:${attempt}`,
        redirectUrl: `${base}bestelling/${order.id}/?betaald=1`, webhookUrl: `${base}mollie/webhook/${order.id}/`,
        metadata: { orderId: order.id, number: order.number },
      });
      const saved = orders.changePay(tenantId, order.id, (pay) => (pay.status === 'betaald' ? null : { ...pay, status: 'open', id: created.id, ids: pay.ids.includes(created.id) ? pay.ids : [...pay.ids, created.id], checkoutUrl: created.checkoutUrl, mode: created.mode, failure: undefined, failedAt: undefined }));
      if (saved.error) return saved;
      if (!saved.changed) return { paid: true };
      return { checkoutUrl: created.checkoutUrl };
    } catch (error) {
      log.warn(`Betaling starten voor ${order.number} mislukt: ${error.message}`);
      return { error: 'De betaalpagina is nu niet bereikbaar. Probeer het zo opnieuw.', status: 502 };
    }
  }

  /**
   * Laat onbetaalde online bestellingen vervallen die langer wachten dan de bewaartijd: de
   * bestelling gaat op Geannuleerd (de voorraad komt vrij). Bleek hij bij Mollie toch betaald,
   * dan blijft hij staan. Kan Mollie niet bereikt worden, dan blijft de bestelling ook staan.
   * @param {string} tenantId Id van de omgeving.
   * @returns {Promise<{ expired: number }>} Het aantal vervallen bestellingen.
   */
  async function expireUnpaid(tenantId) {
    const config = configOf(settingsFor(tenantId));
    const cutoff = new Date(Date.now() - config.holdHours * 3600 * 1000).toISOString();
    let expired = 0;
    for (const id of orders.unpaidOnline(tenantId, cutoff)) {
      try {
        const order = orders.get(tenantId, id);
        if (order && order.pay && order.pay.id && config.apiKey) {
          const out = await sync(tenantId, id);
          if (out.becamePaid || (out.order && out.order.pay.status === 'betaald')) continue;
        }
        const cancelled = orders.setStatus(tenantId, id, 'geannuleerd', null);
        if (cancelled.error) continue;
        orders.changePay(tenantId, id, (pay) => (pay.status === 'betaald' ? null : { ...pay, status: 'verlopen' }));
        expired += 1;
      } catch (error) {
        log.warn(`Onbetaalde bestelling ${id} laten vervallen mislukt: ${error.message}`);
      }
    }
    return { expired };
  }

  return { start, sync, expireUnpaid, onPaid, optionsFor };
}

module.exports = { createWebPayments, MOLLIE_STATES };
