// Online betalen voor bestellingen van de eigen webshop (Mollie). Een
// bestelling met betaalwijze online krijgt bij het plaatsen `data.pay`; hier
// start de klant de betaling (een betaalpagina bij Mollie) en leggen we de
// uitkomst vast. De uitkomst komt altijd uit een opvraging bij Mollie zelf:
// via de webhook van Mollie, of als de klant terugkomt in de winkel. Dat kan
// tegelijk gebeuren; de overgang naar betaald gebeurt maar één keer (in een
// transactie, web-orders.js changePay) en roept dan de haken van onPaid aan.
// Een mislukte, geannuleerde of verlopen betaling laat de bestelling staan
// zodat de klant opnieuw kan betalen; na de bewaartijd uit de instelling
// shopPayment vervalt hij (expireUnpaid, elk uur). De voorraad houdt een
// onbetaalde bestelling maar kort vast (web-orders.js PAY_HOLD_MINUTES): daarna
// komt hij vrij en wordt bij het betalen opnieuw gereserveerd.
//
// Uit de audit van 1.33.0: een betaling op een geannuleerde bestelling (T-08) of
// een tweede geslaagde betaling (T-17) geeft geen bevestiging maar wordt
// vastgelegd en meteen terugbetaald; een terugbetaling wordt eerst vastgelegd en
// dan pas bij Mollie aangevraagd (T-18); en de stappen na een betaling met een
// sleutel (factuur, bevestigingsmail) worden opnieuw geprobeerd als ze niet
// lukten of het proces wegviel (T-16).
const { configOf, validPaymentId, MollieError } = require('./mollie');
const { withHiddenCause } = require('../platform/error-report');

/**
 * Rondt een bedrag af op centen (leeg of ongeldig = 0).
 * @param {*} value Het bedrag.
 * @returns {number} Het afgeronde bedrag.
 */
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Na hoeveel uur zonder betaling de herinnering gestuurd wordt. */
const REMINDER_AFTER_HOURS = 1;
/** Hoeveel herinneringen één ronde hoogstens verstuurt, en hoeveel onbetaalde bestellingen hij hoogstens bekijkt. */
const MAX_REMINDERS_PER_RUN = 50;
const MAX_REMINDER_SCAN = 500;

/** De stand van een terugbetaling die wel is vastgelegd maar waarvan Mollie de uitkomst nog niet heeft bevestigd. */
const REFUND_PENDING = 'aangevraagd';
/** Na zoveel minuten zonder spoor bij Mollie geldt een aangevraagde terugbetaling als niet aangekomen. */
const REFUND_LOST_AFTER_MINUTES = 15;
/** Een stap na de betaling die niet lukte wordt na zoveel minuten opnieuw geprobeerd, hoogstens zoveel keer, tot zoveel dagen na de betaling. */
const HOOK_RETRY_AFTER_MINUTES = 10;
const HOOK_MAX_TRIES = 5;
const HOOK_WINDOW_DAYS = 7;

/**
 * Of er bij deze bestelling nog geld terug moet: een dubbele betaling die nog niet is terugbetaald.
 * @param {object} pay De betaalgegevens.
 * @returns {boolean} true als een dubbele betaling nog openstaat.
 */
const duplicateOpen = (pay) => (Array.isArray(pay.duplicates) ? pay.duplicates : []).some((entry) => !entry.refund || !entry.refund.id);

/**
 * Wat er van een betaalde bestelling nog terugbetaald kan worden: het totaal min wat al is terugbetaald (of aangevraagd) en teruggeboekt.
 * @param {object} pay De betaalgegevens.
 * @param {number} total Het totaal van de bestelling.
 * @returns {number} Het resterende bedrag (nooit negatief).
 */
function refundableOf(pay, total) {
  const earlier = Array.isArray(pay.refunds) ? pay.refunds : [];
  const done = Math.max(earlier.reduce((sum, entry) => sum + Number(entry.amount || 0), 0), round2(pay.refundedTotal)) + round2(pay.chargedBack);
  return Math.max(0, round2(total - done));
}

/** Hoe de Mollie-status bij ons heet: betaald, nog open of mislukt. */
const MOLLIE_STATES = { paid: 'betaald', open: 'open', pending: 'open', authorized: 'open', canceled: 'mislukt', expired: 'mislukt', failed: 'mislukt' };

/**
 * Maakt de betaalfuncties voor webshopbestellingen.
 * @param {{ orders: object, mollie: object, settingsFor: Function, log?: object }} deps De bestelopslag (web-orders.js), de Mollie-client (mollie.js), de instellingen per omgeving en de logger.
 * @returns {{ start: Function, sync: Function, expireUnpaid: Function, releaseHolds: Function, catchUpPaid: Function, reconcileRefunds: Function, remindUnpaid: Function, onPaid: Function, onLatePayment: Function, onHookFailed: Function, optionsFor: Function, guestCheckoutAllowed: Function, refund: Function }} De functies.
 */
function createWebPayments({ orders, mollie, settingsFor, log = console }) {
  const paidHooks = [];
  const lateHooks = [];
  const failedHooks = [];

  /**
   * Registreert een haak die wordt aangeroepen als een bestelling betaald is (niet bij een geannuleerde bestelling). Met een
   * sleutel wordt bijgehouden of de stap gelukt is (`pay.hooks`) en wordt hij bij een fout, of als het proces wegviel, later
   * opnieuw geprobeerd (catchUpPaid); zo'n stap moet dus zonder schade twee keer kunnen lopen. Zonder sleutel loopt hij één keer.
   * @param {Function} hook Functie (tenantId, order); mag een belofte geven, fouten worden gelogd.
   * @param {{ key?: string }} [options] De sleutel van de stap (bijv. 'factuur').
   * @returns {void}
   */
  const onPaid = (hook, { key = '' } = {}) => { paidHooks.push({ hook, key: String(key) }); };

  /**
   * Registreert een haak voor een betaling die niet bij een lopende bestelling hoort: betaald nadat de bestelling was vervallen
   * of geannuleerd, of een tweede geslaagde betaling op dezelfde bestelling.
   * @param {Function} hook Functie (tenantId, order, { reason: 'geannuleerd'|'dubbel', paymentId, amount, refunded }); refunded is of het terugbetalen bij Mollie is gestart.
   * @returns {void}
   */
  const onLatePayment = (hook) => { lateHooks.push(hook); };

  /**
   * Registreert een haak die wordt aangeroepen als een stap na de betaling na alle pogingen niet is gelukt.
   * @param {Function} hook Functie (tenantId, order, key, message).
   * @returns {void}
   */
  const onHookFailed = (hook) => { failedHooks.push(hook); };

  /**
   * Roept een lijst haken aan; een fout in de ene haak houdt de andere niet tegen.
   * @param {Function[]} hooks De haken.
   * @param {string} label Waar het om gaat (voor het log).
   * @param {...*} values De argumenten voor elke haak.
   * @returns {void}
   */
  function notify(hooks, label, ...values) {
    for (const hook of hooks) {
      try { Promise.resolve(hook(...values)).catch((error) => log.warn(`${label}: ${error.message}`)); } catch (error) { log.warn(`${label}: ${error.message}`); }
    }
  }

  /**
   * De betaalwijzen die een klant bij het afrekenen mag kiezen.
   * Online betalen als het aan staat; op rekening volgens de instelling (altijd als online betalen niet is aangezet, zodat bestellen blijft werken).
   * @param {string} tenantId Id van de omgeving.
   * @param {{ customerGroup?: string }} viewer De klant (zakelijk of niet).
   * @returns {string[]} 'online' en/of 'rekening' (online staat voorop).
   */
  function optionsFor(tenantId, viewer) {
    const config = configOf(settingsFor(tenantId));
    const business = Boolean(viewer) && viewer.customerGroup === 'zakelijk';
    // Staat online betalen aan maar klopt de sleutel of het webadres niet, dan blijft de beperking voor op rekening gelden (bij 'nooit' kan er dan niet besteld worden).
    const onAccount = !config.wanted || config.onAccount === 'iedereen' || (config.onAccount === 'zakelijk' && business);
    return [...(config.online ? ['online'] : []), ...(onAccount ? ['rekening'] : [])];
  }

  /**
   * Of een bezoeker zonder account mag afrekenen: alleen als online betalen werkt (een gast betaalt altijd vooraf, nooit op rekening)
   * en de beheerder bestellen als gast niet heeft uitgezet.
   * @param {string} tenantId Id van de omgeving.
   * @returns {boolean} true als afrekenen als gast kan.
   */
  function guestCheckoutAllowed(tenantId) {
    const config = configOf(settingsFor(tenantId));
    return config.online && config.guestCheckout;
  }

  /**
   * Legt de uitkomst van een stap met een sleutel vast bij de bestelling: gelukt, of een mislukte poging (na de laatste poging
   * geeft hij het op en roept de haken van onHookFailed aan).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De bestelling.
   * @param {string} key De sleutel van de stap.
   * @param {?Error} failure De fout, of null als de stap gelukt is.
   * @returns {void}
   */
  function recordHook(tenantId, order, key, failure) {
    let gaveUp = false;
    try {
      orders.changePay(tenantId, order.id, (pay) => {
        const hooks = pay.hooks && typeof pay.hooks === 'object' ? pay.hooks : {};
        const pending = Array.isArray(hooks.pending) ? hooks.pending : [];
        if (!pending.includes(key)) return null;
        const without = pending.filter((name) => name !== key);
        if (!failure) return { ...pay, hooks: { ...hooks, pending: without, done: { ...(hooks.done || {}), [key]: new Date().toISOString() } } };
        const tries = Number((hooks.tries || {})[key] || 0) + 1;
        gaveUp = tries >= HOOK_MAX_TRIES;
        return { ...pay, hooks: { ...hooks, pending: gaveUp ? without : pending, tries: { ...(hooks.tries || {}), [key]: tries }, lastTryAt: new Date().toISOString(), ...(gaveUp ? { failed: { ...(hooks.failed || {}), [key]: new Date().toISOString() } } : {}) } };
      });
    } catch (error) {
      log.warn(`Stap ${key} na betalen van ${order.number} vastleggen mislukt: ${error.message}`);
    }
    if (failure) log.warn(`Na betalen van ${order.number} (${key}): ${failure.message}`);
    if (gaveUp) notify(failedHooks, `Melding over stap ${key} bij ${order.number}`, tenantId, order, key, String(failure.message || '').slice(0, 300));
  }

  /**
   * Start de haken nadat een bestelling betaald is, zonder op de mail te wachten; een fout in een haak houdt de rest niet tegen.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De betaalde bestelling.
   * @param {?string[]} [onlyKeys] Alleen de stappen met deze sleutels (inhalen); standaard alle haken.
   * @returns {Promise<void>} Klaar als alle gestarte haken zijn afgelopen (de aanroeper hoeft daar niet op te wachten).
   */
  function runPaidHooks(tenantId, order, onlyKeys = null) {
    const running = [];
    for (const { hook, key } of paidHooks) {
      if (onlyKeys && !(key && onlyKeys.includes(key))) continue;
      let outcome;
      try { outcome = Promise.resolve(hook(tenantId, order)); } catch (error) { outcome = Promise.reject(error); }
      running.push(outcome.then(
        () => { if (key) recordHook(tenantId, order, key, null); },
        (error) => { if (key) recordHook(tenantId, order, key, error); else log.warn(`Na betalen van ${order.number}: ${error.message}`); },
      ));
    }
    return Promise.all(running).then(() => undefined);
  }

  /**
   * Vraagt een terugbetaling bij Mollie aan voor een dubbele betaling (T-17): eerst vastleggen, dan Mollie, dan afronden. Een
   * weigering van Mollie haalt de aanvraag weer weg (terugbetalen blijft dan nodig); bij een onbekende uitkomst blijft hij staan
   * tot reconcileRefunds hem bij Mollie heeft nagekeken.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De bestelling.
   * @param {string} paymentId Het id van de dubbele betaling.
   * @returns {Promise<boolean>} true als de terugbetaling bij Mollie is gestart.
   */
  async function refundDuplicate(tenantId, order, paymentId) {
    const config = configOf(settingsFor(tenantId));
    if (!config.apiKey) return false;
    /**
     * Werkt de terugbetaling van deze dubbele betaling bij.
     * @param {?object} refund De nieuwe stand, of null om de aanvraag weg te halen.
     * @param {Function} [allowed] Of de huidige stand vervangen mag worden.
     * @returns {object} De uitkomst van changePay.
     */
    const setRefund = (refund, allowed = () => true) => orders.changePay(tenantId, order.id, (pay) => {
      const list = Array.isArray(pay.duplicates) ? pay.duplicates : [];
      const entry = list.find((candidate) => candidate.id === paymentId);
      if (!entry || !allowed(entry)) return null;
      const duplicates = list.map((candidate) => (candidate.id === paymentId ? { ...candidate, refund: refund || undefined } : candidate));
      const next = { ...pay, duplicates };
      return { ...next, refundNeeded: duplicateOpen(next) || (pay.refundNeeded === true && !duplicateOpen(pay)) };
    });
    const entry = (order.pay.duplicates || []).find((candidate) => candidate.id === paymentId);
    if (!entry) return false;
    const reserved = setRefund({ status: REFUND_PENDING, at: new Date().toISOString() }, (current) => !current.refund);
    if (!reserved.changed) return false;
    try {
      const made = await mollie.createRefund(config.apiKey, paymentId, { amount: entry.amount, description: `Dubbele betaling bestelling ${order.number}`, idempotencyKey: `dubbel:${order.id}:${paymentId}`, key: `dubbel:${paymentId}` });
      setRefund({ id: made.id, status: made.status, at: new Date().toISOString() });
      return true;
    } catch (error) {
      const refused = error instanceof MollieError && error.status >= 400 && error.status < 500;
      if (refused) setRefund(null);
      log.warn(`Dubbele betaling ${paymentId} van bestelling ${order.number} terugbetalen ${refused ? 'geweigerd door Mollie' : 'gaf geen duidelijke uitkomst (wordt nagekeken)'}: ${error.message}`);
      return false;
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
    let duplicate = false;
    let turnedPaid = false;
    const out = orders.changePay(tenantId, orderId, (pay, order) => {
      duplicate = false;
      turnedPaid = false;
      if (!pay.ids.includes(payment.id)) return null;
      if (state === 'betaald' && pay.status !== 'betaald') {
        turnedPaid = true;
        const cancelled = order.status === 'geannuleerd';
        // De stappen met een sleutel staan open tot ze gelukt zijn (T-16); bij een geannuleerde bestelling komt er geen bevestiging (T-08).
        const pending = cancelled ? [] : [...new Set(paidHooks.map((entry) => entry.key).filter(Boolean))];
        return { ...pay, status: 'betaald', paidAt: payment.paidAt || new Date().toISOString(), method: payment.method || pay.method || '', paidId: payment.id, hooks: { pending, done: {}, tries: {} }, ...(cancelled ? { refundNeeded: true, paidAfterCancel: true } : {}) };
      }
      // Een tweede geslaagde betaling op dezelfde bestelling (dubbele tab, overboeking): vastleggen en terugbetalen (T-17).
      if (state === 'betaald' && pay.paidId && pay.paidId !== payment.id) {
        if ((pay.duplicates || []).some((entry) => entry.id === payment.id)) return null;
        duplicate = true;
        return { ...pay, duplicates: [...(pay.duplicates || []), { id: payment.id, amount: round2(payment.amount), at: payment.paidAt || new Date().toISOString() }], refundNeeded: true };
      }
      if (state === 'mislukt' && pay.status === 'open' && pay.id === payment.id) return { ...pay, status: 'mislukt', failedAt: new Date().toISOString(), failure: payment.status };
      // Na betaald: terugbetalingen (ook vanuit het Mollie-dashboard) en terugboekingen door de bank (chargeback) vastleggen (W-05).
      if (pay.status === 'betaald' && pay.paidId === payment.id) {
        const refunded = round2(payment.amountRefunded);
        const chargedBack = round2(payment.amountChargedBack);
        if (refunded === round2(pay.refundedTotal) && chargedBack === round2(pay.chargedBack)) return null;
        const settled = refunded + chargedBack >= order.totals.total - 0.005;
        return {
          ...pay, refundedTotal: refunded, chargedBack,
          ...(chargedBack > round2(pay.chargedBack) ? { chargebackAt: new Date().toISOString() } : {}),
          ...(settled ? { refundNeeded: duplicateOpen(pay) } : {}),
        };
      }
      return null;
    });
    if (out.error) return { becamePaid: false };
    if (out.changed && duplicate) {
      log.warn(`Tweede geslaagde betaling ${payment.id} (${round2(payment.amount)} euro) bij bestelling ${out.order.number}: wordt terugbetaald.`);
      const refunded = await refundDuplicate(tenantId, out.order, payment.id);
      notify(lateHooks, `Melding over dubbele betaling bij ${out.order.number}`, tenantId, out.order, { reason: 'dubbel', paymentId: payment.id, amount: round2(payment.amount), refunded });
      return { order: orders.get(tenantId, orderId) || out.order, becamePaid: false };
    }
    if (out.changed && out.order.pay.chargebackAt && round2(out.order.pay.chargedBack) > 0 && state === 'betaald') log.warn(`Terugboeking (chargeback) van ${round2(out.order.pay.chargedBack)} euro bij bestelling ${out.order.number}.`);
    const becamePaid = Boolean(out.changed) && turnedPaid;
    if (!becamePaid) return { order: out.order, becamePaid };
    if (out.order.status === 'geannuleerd') {
      // Betaald nadat de bestelling was vervallen of geannuleerd (T-08): geen bevestiging en geen factuur, het bedrag gaat terug.
      log.warn(`Bestelling ${out.order.number} is betaald (${payment.id}) terwijl hij geannuleerd is: het bedrag wordt terugbetaald.`);
      let refunded = false;
      try {
        const back = await refund(tenantId, orderId, { amount: out.order.totals.total, description: `Terugbetaling bestelling ${out.order.number}`, key: 'annulering' });
        refunded = !back.error;
        if (back.error) log.warn(`Automatisch terugbetalen van bestelling ${out.order.number} lukte niet: ${back.error}`);
      } catch (error) {
        log.warn(`Automatisch terugbetalen van bestelling ${out.order.number} lukte niet: ${error.message}`);
      }
      const current = orders.get(tenantId, orderId) || out.order;
      notify(lateHooks, `Melding over betaling na annuleren bij ${current.number}`, tenantId, current, { reason: 'geannuleerd', paymentId: payment.id, amount: round2(payment.amount), refunded });
      return { order: current, becamePaid };
    }
    runPaidHooks(tenantId, out.order);
    return { order: out.order, becamePaid };
  }

  /**
   * Controleert of een betaling van Mollie bij de bestelling hoort (metadata en bedrag).
   * @param {object} payment De betaling zoals Mollie hem geeft.
   * @param {object} order De bestelling.
   * @returns {boolean} true als bestelling en bedrag kloppen.
   */
  function belongsTo(payment, order) {
    return payment.orderId === order.id && Math.abs(payment.amount - order.totals.total) <= 0.005;
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
    if (!belongsTo(payment, order)) {
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
   * @returns {Promise<{ checkoutUrl?: string, paid?: boolean, error?: string, status?: number, soldOut?: boolean }>} Het adres van de betaalpagina, of paid als hij intussen betaald bleek, of een foutmelding (soldOut: de voorraad was vrijgegeven en is intussen aan een ander verkocht).
   */
  async function start(tenantId, order) {
    const config = configOf(settingsFor(tenantId));
    if (!config.online) return { error: 'Online betalen staat niet aan.', status: 409 };
    if (order.payment !== 'online' || !order.pay) return { error: 'Deze bestelling gaat op rekening.', status: 409 };
    if (order.status !== 'nieuw') return { error: 'Deze bestelling kan niet meer betaald worden.', status: 409 };
    if (order.pay.status === 'betaald') return { paid: true };
    // De voorraad ligt (weer) een half uur vast zolang de klant betaalt; is hij intussen aan een ander verkocht, dan kan betalen niet (B-13).
    const hold = orders.holdForPayment(tenantId, order.id);
    if (hold.paid) return { paid: true };
    if (hold.error) return { error: hold.error, status: hold.status, ...(hold.short ? { soldOut: true } : {}) };
    try {
      if (order.pay.id && order.pay.status === 'open' && order.pay.checkoutUrl) {
        const current = await mollie.getPayment(config.apiKey, order.pay.id);
        if (MOLLIE_STATES[current.status] === 'betaald') {
          if (!belongsTo(current, order)) {
            log.warn(`Betaling ${current.id} hoort niet bij bestelling ${order.number}; genegeerd.`);
            return { error: 'De betaling hoort niet bij deze bestelling.', status: 409 };
          }
          await apply(tenantId, order.id, current);
          return { paid: true };
        }
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
      // Onder het rijslot: is de bestelling intussen geannuleerd (vervallen), dan hoort er geen nieuwe betaling meer bij (T-08).
      let gone = false;
      const saved = orders.changePay(tenantId, order.id, (pay, current) => {
        gone = current.status !== 'nieuw';
        if (pay.status === 'betaald' || gone) return null;
        return { ...pay, status: 'open', id: created.id, ids: pay.ids.includes(created.id) ? pay.ids : [...pay.ids, created.id], checkoutUrl: created.checkoutUrl, mode: created.mode, failure: undefined, failedAt: undefined };
      });
      if (saved.error) return saved;
      if (gone) {
        await cancelAtMollie(config.apiKey, created.id, order.number);
        return { error: 'Deze bestelling kan niet meer betaald worden.', status: 409 };
      }
      if (!saved.changed) return { paid: true };
      return { checkoutUrl: created.checkoutUrl };
    } catch (error) {
      // Een storing van Mollie kort in het log; een andere fout (in de app) met de hele aanroepketen.
      // Bij een MollieError ook de onderliggende oorzaak (bijv. de netwerkfout) in het log, nooit naar de klant.
      log.warn(`Betaling starten voor ${order.number} mislukt:`, error instanceof MollieError ? error.message : error, ...(error instanceof MollieError && error.cause ? [error.cause] : []));
      return { error: 'De betaalpagina is nu niet bereikbaar. Probeer het zo opnieuw.', status: 502 };
    }
  }

  /**
   * Annuleert een openstaande betaling bij Mollie zodat de betaalpagina niet meer werkt. Lukt alleen bij betaalmethodes die dat
   * toelaten; een weigering of storing is geen fout (een betaling die toch binnenkomt wordt terugbetaald, zie apply).
   * @param {string} apiKey De API-sleutel.
   * @param {string} paymentId Het betaling-id.
   * @param {string} number Het bestelnummer (voor het log).
   * @returns {Promise<void>}
   */
  async function cancelAtMollie(apiKey, paymentId, number) {
    if (!apiKey || !validPaymentId(paymentId)) return;
    try { await mollie.cancelPayment(apiKey, paymentId); } catch (error) {
      if (!(error instanceof MollieError)) log.warn(`Betaling ${paymentId} van bestelling ${number} annuleren bij Mollie mislukt: ${error.message}`);
    }
  }

  /**
   * Geeft de voorraad vrij van online bestellingen die na de korte betaaltijd nog niet betaald zijn (B-13); zie
   * web-orders.js releaseUnpaidHolds. Bedoeld om vaker te lopen dan de uurlijkse vervalronde.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ released: number }} Het aantal bestellingen waarvan de voorraad is vrijgegeven.
   */
  const releaseHolds = (tenantId) => orders.releaseUnpaidHolds(tenantId);

  /**
   * Zoekt een terugbetaling met onze sleutel bij Mollie op.
   * @param {string} apiKey De API-sleutel.
   * @param {string} paymentId Het betaling-id.
   * @param {string} key De sleutel die we als metadata meegaven.
   * @returns {Promise<?{ id: string, status: string, amount: number }>} De terugbetaling, of null als Mollie hem niet kent (of hij mislukt is).
   */
  async function findRefund(apiKey, paymentId, key) {
    const list = await mollie.listRefunds(apiKey, paymentId);
    return list.find((entry) => entry.key === key && !['failed', 'canceled'].includes(entry.status)) || null;
  }

  /**
   * Stemt de aangevraagde terugbetalingen van één bestelling af met Mollie (T-18): staat hij bij Mollie, dan wordt hij afgerond;
   * kent Mollie hem na een kwartier nog niet, dan is hij niet aangekomen en vervalt de aanvraag (terugbetalen is dan weer nodig).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De bestelling.
   * @returns {Promise<{ settled: number, dropped: number, waiting: number }>} Hoeveel aanvragen zijn afgerond, vervallen en nog in afwachting.
   */
  async function reconcileOrder(tenantId, order) {
    const result = { settled: 0, dropped: 0, waiting: 0 };
    const config = configOf(settingsFor(tenantId));
    if (!order.pay || !config.apiKey) return result;
    const lostBefore = new Date(Date.now() - REFUND_LOST_AFTER_MINUTES * 60 * 1000).toISOString();
    for (const entry of (order.pay.refunds || []).filter((candidate) => candidate.status === REFUND_PENDING)) {
      const found = order.pay.paidId ? await findRefund(config.apiKey, order.pay.paidId, entry.key) : null;
      if (!found && entry.at > lostBefore) { result.waiting += 1; continue; }
      orders.changePay(tenantId, order.id, (pay, current) => {
        const list = Array.isArray(pay.refunds) ? pay.refunds : [];
        if (!list.some((candidate) => candidate.key === entry.key && candidate.status === REFUND_PENDING)) return null;
        if (found) return { ...pay, refunds: list.map((candidate) => (candidate.key === entry.key ? { ...candidate, id: found.id, status: found.status } : candidate)), refundNeeded: duplicateOpen(pay) };
        const next = { ...pay, refunds: list.filter((candidate) => candidate.key !== entry.key) };
        return { ...next, refundNeeded: duplicateOpen(next) || current.status === 'geannuleerd' };
      });
      if (found) result.settled += 1; else result.dropped += 1;
    }
    for (const entry of (order.pay.duplicates || []).filter((candidate) => candidate.refund && candidate.refund.status === REFUND_PENDING && !candidate.refund.id)) {
      const found = await findRefund(config.apiKey, entry.id, `dubbel:${entry.id}`);
      if (!found && entry.refund.at > lostBefore) { result.waiting += 1; continue; }
      orders.changePay(tenantId, order.id, (pay) => {
        const list = Array.isArray(pay.duplicates) ? pay.duplicates : [];
        if (!list.some((candidate) => candidate.id === entry.id && candidate.refund && candidate.refund.status === REFUND_PENDING && !candidate.refund.id)) return null;
        const next = { ...pay, duplicates: list.map((candidate) => (candidate.id === entry.id ? { ...candidate, refund: found ? { id: found.id, status: found.status, at: candidate.refund.at } : undefined } : candidate)) };
        return { ...next, refundNeeded: duplicateOpen(next) || (pay.refundNeeded === true && !duplicateOpen(pay)) };
      });
      if (found) result.settled += 1; else result.dropped += 1;
    }
    return result;
  }

  /**
   * Stemt alle aangevraagde, nog niet afgeronde terugbetalingen af met Mollie (T-18); een bestelling waarbij Mollie niet
   * bereikbaar is blijft staan voor de volgende ronde.
   * @param {string} tenantId Id van de omgeving.
   * @returns {Promise<{ settled: number, dropped: number }>} Hoeveel aanvragen zijn afgerond en hoeveel als niet aangekomen zijn vervallen.
   */
  async function reconcileRefunds(tenantId) {
    const total = { settled: 0, dropped: 0 };
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    for (const id of orders.withPendingRefunds(tenantId, since)) {
      try {
        const order = orders.get(tenantId, id);
        if (!order) continue;
        const out = await reconcileOrder(tenantId, order);
        total.settled += out.settled;
        total.dropped += out.dropped;
        if (out.dropped) log.warn(`Terugbetaling bij bestelling ${order.number} is niet bij Mollie aangekomen: terugbetalen is opnieuw nodig.`);
      } catch (error) {
        log.warn(`Terugbetaling van bestelling ${id} afstemmen met Mollie mislukt: ${error.message}`);
      }
    }
    return total;
  }

  /**
   * Haalt de stappen na een betaling in die niet zijn gelukt of nooit zijn gestart (T-16): betaalde, niet-geannuleerde
   * bestellingen waarvan een stap met een sleutel nog openstaat. Elke stap wordt hoogstens HOOK_MAX_TRIES keer geprobeerd.
   * @param {string} tenantId Id van de omgeving.
   * @returns {Promise<{ retried: number }>} Het aantal bestellingen waarvoor stappen opnieuw zijn gestart.
   */
  async function catchUpPaid(tenantId) {
    const keys = [...new Set(paidHooks.map((entry) => entry.key).filter(Boolean))];
    if (!keys.length) return { retried: 0 };
    const before = new Date(Date.now() - HOOK_RETRY_AFTER_MINUTES * 60 * 1000).toISOString();
    const since = new Date(Date.now() - HOOK_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    let retried = 0;
    for (const id of orders.paidWithOpenHooks(tenantId, before, since)) {
      try {
        const order = orders.get(tenantId, id);
        if (!order || order.status === 'geannuleerd' || !order.pay || order.pay.status !== 'betaald' || !order.pay.hooks) continue;
        // Een poging die net liep (eerste poging of vorige inhaalronde) krijgt eerst de tijd.
        if (order.pay.hooks.lastTryAt && order.pay.hooks.lastTryAt > before) continue;
        const open = (order.pay.hooks.pending || []).filter((key) => keys.includes(key));
        if (!open.length) continue;
        await runPaidHooks(tenantId, order, open);
        retried += 1;
      } catch (error) {
        log.warn(`Stappen na betalen van bestelling ${id} inhalen mislukt: ${error.message}`);
      }
    }
    return { retried };
  }

  /**
   * Laat onbetaalde online bestellingen vervallen die langer wachten dan de bewaartijd: de
   * bestelling gaat op Geannuleerd (de voorraad komt vrij). Bleek hij bij Mollie toch betaald,
   * dan blijft hij staan. Kan Mollie niet bereikt worden, dan blijft de bestelling ook staan. De openstaande betaling wordt bij
   * Mollie geannuleerd waar dat kan. Dezelfde ronde geeft eerst de voorraad vrij van wat te lang onbetaald is (B-13) en stemt
   * daarna aangevraagde terugbetalingen af (T-18) en haalt mislukte stappen na een betaling in (T-16).
   * @param {string} tenantId Id van de omgeving.
   * @returns {Promise<{ expired: number }>} Het aantal vervallen bestellingen.
   */
  async function expireUnpaid(tenantId) {
    const config = configOf(settingsFor(tenantId));
    try { orders.releaseUnpaidHolds(tenantId); } catch (error) { log.warn(`Voorraad van onbetaalde bestellingen vrijgeven mislukt: ${error.message}`); }
    // De deadline per bestelling (data.reservedUntil, vastgelegd bij het plaatsen) telt, niet de huidige instelling:
    // selecteer alles ouder dan het kortst mogelijke (1 uur) en controleer per bestelling.
    const nowIso = new Date().toISOString();
    const cutoff = new Date(Date.now() - 3600 * 1000).toISOString();
    const fallback = new Date(Date.now() - config.holdHours * 3600 * 1000).toISOString();
    let expired = 0;
    let kept = 0;
    for (;;) {
      const batch = orders.unpaidOnline(tenantId, cutoff, 100, kept);
      if (!batch.length) break;
      for (const id of batch) {
        try {
          const order = orders.get(tenantId, id);
          const deadline = order && order.reservedUntil;
          if (order && (deadline ? deadline > nowIso : order.createdAt > fallback)) { kept += 1; continue; }
          if (order && order.pay && order.pay.id && !config.apiKey) { kept += 1; continue; }
          if (order && order.pay && order.pay.id) {
            const out = await sync(tenantId, id);
            if (out.becamePaid || (out.order && out.order.pay.status === 'betaald')) continue; // niet meer onbetaald: valt buiten de selectie, dus telt niet mee in kept
          }
          const cancelled = orders.setStatus(tenantId, id, 'geannuleerd', null);
          if (cancelled.error) { kept += 1; continue; }
          orders.changePay(tenantId, id, (pay) => (pay.status === 'betaald' ? null : { ...pay, status: 'verlopen' }));
          expired += 1;
          if (order && order.pay && order.pay.id) await cancelAtMollie(config.apiKey, order.pay.id, order.number);
        } catch (error) {
          kept += 1;
          log.warn(`Onbetaalde bestelling ${id} laten vervallen mislukt: ${error.message}`);
        }
      }
    }
    try { await reconcileRefunds(tenantId); } catch (error) { log.warn(`Terugbetalingen afstemmen met Mollie mislukt: ${error.message}`); }
    try { await catchUpPaid(tenantId); } catch (error) { log.warn(`Stappen na betalen inhalen mislukt: ${error.message}`); }
    return { expired };
  }

  /**
   * Stuurt één herinnering bij online bestellingen die na een uur nog niet betaald zijn (of waarvan de betaling mislukte), zolang
   * de reservering loopt. Elke bestelling krijgt hoogstens één herinnering (`pay.reminderAt`); een mail die niet lukt wordt de
   * volgende ronde opnieuw geprobeerd. Wat intussen toch betaald bleek bij Mollie wordt eerst bijgewerkt en krijgt niets.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ send: Function, canSend?: Function }} mailer `send(order)` stuurt de herinnering en geeft true als dat gelukt is; `canSend()` meldt vooraf of er een mailserver is (zo niet, dan ook geen Mollie-opvragingen).
   * @returns {Promise<{ sent: number }>} Het aantal verstuurde herinneringen.
   */
  async function remindUnpaid(tenantId, { send, canSend = () => true }) {
    const config = configOf(settingsFor(tenantId));
    if (!config.online || !config.paymentReminder || !canSend()) return { sent: 0 };
    const nowIso = new Date().toISOString();
    const cutoff = new Date(Date.now() - REMINDER_AFTER_HOURS * 3600 * 1000).toISOString();
    const fallback = new Date(Date.now() - config.holdHours * 3600 * 1000).toISOString();
    let sent = 0;
    let looked = 0;
    for (;;) {
      const batch = orders.unpaidOnline(tenantId, cutoff, 100, looked, { withoutReminder: true });
      if (!batch.length || looked >= MAX_REMINDER_SCAN) break;
      // Een bestelling die een herinnering krijgt valt uit de selectie: telt dus niet mee voor het overslaan.
      looked += batch.length;
      for (const id of batch) {
        try {
          let order = orders.get(tenantId, id);
          if (!order || order.status !== 'nieuw' || !order.pay || order.pay.reminderAt || order.pay.status === 'betaald') continue;
          const deadline = order.reservedUntil;
          if (deadline ? deadline <= nowIso : order.createdAt <= fallback) continue;
          if (!orders.reminderAllowed(tenantId, order)) continue;
          if (order.pay.id && config.apiKey) {
            const out = await sync(tenantId, id);
            if (out.becamePaid || (out.order && out.order.pay.status === 'betaald')) continue;
            if (out.order) order = out.order;
          }
          if (!(await send(order))) continue;
          orders.changePay(tenantId, id, (pay) => (pay.status === 'betaald' || pay.reminderAt ? null : { ...pay, reminderAt: new Date().toISOString() }));
          sent += 1;
          looked -= 1;
          if (sent >= MAX_REMINDERS_PER_RUN) return { sent };
        } catch (error) {
          log.warn(`Betalingsherinnering voor bestelling ${id} mislukt: ${error.message}`);
        }
      }
    }
    return { sent };
  }

  /**
   * Betaalt (een deel van) een online betaalde bestelling terug via Mollie (W-05): bij een retour het bedrag van de
   * creditnota, bij een geannuleerde bestelling wat er nog over is. Dezelfde sleutel betaalt nooit twee keer terug
   * (ook Mollie krijgt hem als idempotentiesleutel). De aanvraag wordt eerst vastgelegd en dan pas bij Mollie gedaan (T-18).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @param {{ amount: number, description: string, key: string }} refund Bedrag in euro, omschrijving voor de klant en de sleutel (bijv. retour:<id> of annulering).
   * @returns {Promise<{ order?: object, refund?: object, error?: string, status?: number }>} De bijgewerkte bestelling en de terugbetaling, of de fout.
   */
  async function refund(tenantId, orderId, { amount, description, key }) {
    let order = orders.get(tenantId, orderId);
    if (!order) return { error: 'Bestelling niet gevonden.', status: 404 };
    if (order.payment !== 'online' || !order.pay || order.pay.status !== 'betaald' || !order.pay.paidId) return { error: 'Deze bestelling is niet online betaald: terugbetalen gaat buiten de webshop om.', status: 409 };
    const config = configOf(settingsFor(tenantId));
    if (!config.apiKey) return { error: 'Mollie is niet ingesteld.', status: 409 };
    const same = (Array.isArray(order.pay.refunds) ? order.pay.refunds : []).find((entry) => entry.key === key);
    if (same && same.status === REFUND_PENDING) {
      // Eerder aangevraagd zonder duidelijke uitkomst: eerst bij Mollie nakijken of hij is uitgevoerd.
      let checked;
      try { checked = await reconcileOrder(tenantId, order); } catch (error) { checked = { waiting: 1, cause: error }; }
      order = orders.get(tenantId, orderId) || order;
      const still = (order.pay.refunds || []).find((entry) => entry.key === key);
      if (still && still.status === REFUND_PENDING) return withHiddenCause({ error: 'Deze terugbetaling is al bij Mollie aangevraagd, maar de uitkomst is nog niet bekend. Probeer het over een kwartier opnieuw.', status: 409 }, checked.cause);
      if (still) return { error: 'Dit is al terugbetaald.', status: 409 };
    } else if (same) return { error: 'Dit is al terugbetaald.', status: 409 };
    // Stap 1: de aanvraag vastleggen bij de bestelling, onder het rijslot (twee gelijktijdige aanvragen kunnen samen nooit meer terugbetalen dan er is).
    const at = new Date().toISOString();
    let value = 0;
    let taken = false;
    const reserved = orders.changePay(tenantId, order.id, (pay, current) => {
      taken = (pay.refunds || []).some((entry) => entry.key === key);
      if (taken || pay.status !== 'betaald') return null;
      value = Math.min(round2(amount), refundableOf(pay, current.totals.total));
      if (!(value > 0)) return null;
      return { ...pay, refunds: [...(pay.refunds || []), { key, amount: value, at, status: REFUND_PENDING }] };
    });
    if (reserved.error) return reserved;
    if (taken) return { error: 'Dit is al terugbetaald.', status: 409 };
    if (!reserved.changed) return { error: 'Er valt niets (meer) terug te betalen.', status: 409 };
    // Stap 2: Mollie. Een weigering haalt de aanvraag weer weg; bij een onbekende uitkomst (storing, herstart) blijft hij staan
    // en kijkt reconcileRefunds bij Mollie na of hij is uitgevoerd.
    let made;
    try {
      made = await mollie.createRefund(config.apiKey, order.pay.paidId, { amount: value, description, idempotencyKey: `terug:${order.id}:${key}`, key });
    } catch (error) {
      const refused = error instanceof MollieError && error.status >= 400 && error.status < 500;
      if (refused) orders.changePay(tenantId, order.id, (pay) => ({ ...pay, refunds: (pay.refunds || []).filter((entry) => !(entry.key === key && entry.status === REFUND_PENDING)) }));
      // Een weigering of storing van Mollie heeft een leesbare melding; een andere fout is een fout in de app.
      const reason = error instanceof MollieError ? String(error.message).slice(0, 200) : 'interne fout, de oorzaak staat in het serverlog';
      if (!(error instanceof MollieError)) log.error(`[fout] Terugbetalen voor ${order.number}:`, error);
      return withHiddenCause({ error: `Terugbetalen via Mollie lukte niet: ${reason}${refused ? '' : ' De aanvraag blijft staan en wordt automatisch bij Mollie nagekeken.'}`, status: 502 }, error);
    }
    // Stap 3: afronden met het id van Mollie.
    const out = orders.changePay(tenantId, order.id, (pay) => ({ ...pay, refunds: (pay.refunds || []).map((entry) => (entry.key === key ? { id: made.id, key, amount: value, at, status: made.status } : entry)), refundNeeded: duplicateOpen(pay) }));
    return { order: out.order || order, refund: { id: made.id, amount: value, status: made.status } };
  }

  return { start, sync, expireUnpaid, releaseHolds, catchUpPaid, reconcileRefunds, remindUnpaid, onPaid, onLatePayment, onHookFailed, optionsFor, guestCheckoutAllowed, refund };
}

module.exports = { createWebPayments, MOLLIE_STATES, REFUND_PENDING, HOOK_MAX_TRIES };
