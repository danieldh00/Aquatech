// Mails bij een bestelling in de eigen webshop: een bevestiging aan de klant en
// een melding aan het bedrijf (e-mailadres uit het bedrijfsprofiel). Via de
// mailserver van de organisatie (mailer.js); een mislukte verzending houdt de
// bestelling niet tegen maar blijft zichtbaar bij de bestelling (data.mail).
// Bij Verzonden volgt een mail met de volgcode van DPD (of: klaar om op te
// halen); komt de volgcode later, dan volgt één mail met die code (data.shipMail).
const { validEmail, mailFailure, MAIL_SETUP_FAILED } = require('../platform/mailer');
const { mailStyleOf, composeFor } = require('../platform/mail-layout');
const { WITHDRAWAL_DAYS } = require('./legal-pages');
const { cleanPublicUrl } = require('./mollie');
const DeliveryTimes = require('./delivery-times');

/**
 * Een ISO-datum als dd-mm-jjjj voor in een mail.
 * @param {string} iso De datum (alleen het datumdeel telt).
 * @returns {string} Bijv. "5-3-2026", of de invoer als die geen datum is.
 */
function expectedText(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return match ? `${Number(match[3])}-${Number(match[2])}-${match[1]}` : String(iso || '');
}

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

/**
 * Maakt de verzender van bestelmails.
 * @param {{ orders: object, settingsFor: Function, mailerFor: Function, mailBody: Function, guestLinkOf?: Function }} deps De bestelopslag, de instellingen per omgeving, de mailserver en de opmaak van de mail, en `guestLinkOf(tenantId, order, baseUrl)` = de persoonlijke link naar een gastbestelling (guest-orders.js; zonder geen link in de mails).
 * @returns {{ sendPlaced: Function, sendShipment: Function, sendBusinessRequest: Function, businessRequestReady: Function, mailReady: Function, sendStockAlert: Function, sendPaymentReminder: Function }} De functies.
 */
function createOrderMailer({ orders, settingsFor, mailerFor, mailBody, guestLinkOf = () => '' }) {
  /**
   * De regels van de bestelling als tekst, één per regel.
   * @param {object} order De bestelling (met regels).
   * @returns {string} De regels.
   */
  const linesText = (order) => order.lines.map((line) => `${line.qty} × ${line.name} (${line.code}): ${EUR.format(order.customerGroup === 'zakelijk' && line.lineExcl !== undefined ? line.lineExcl : line.lineTotal)}${order.customerGroup === 'zakelijk' ? ' excl. btw' : ''}`).join('\n');
  /**
   * De totalen als tekst: voor een zakelijke klant excl. btw, de btw en het totaal (of 'btw verlegd').
   * @param {object} order De bestelling.
   * @returns {string} Eén of meer regels.
   */
  const totalsText = (order) => {
    if (order.customerGroup !== 'zakelijk') return `Totaal incl. btw: ${EUR.format(order.totals.total)}`;
    if (order.vat && order.vat.shifted) return `Totaal (btw verlegd naar de afnemer${order.vat.number ? `, btw-nummer ${order.vat.number}` : ''}): ${EUR.format(order.totals.total)}`;
    const excl = order.totals.byRate.reduce((sum, row) => sum + row.excl, 0);
    const vatLines = order.totals.byRate.filter((row) => row.rate > 0).map((row) => `Btw ${row.rate}% over ${EUR.format(row.excl)}: ${EUR.format(row.vat)}`);
    return [`Totaal excl. btw: ${EUR.format(excl)}`, ...vatLines, `Totaal incl. btw: ${EUR.format(order.totals.total)}`].join('\n');
  };
  /**
   * Het afleveradres als tekst.
   * @param {object} order De bestelling.
   * @returns {string} Naam, straat en postcode met plaats.
   */
  const addressText = (order) => [order.customer.company, order.customer.name, order.address.street, `${order.address.postcode} ${order.address.city}`].filter(Boolean).join('\n');
  /**
   * Het factuuradres als tekst, alleen als het afleveradres afwijkt.
   * @param {object} order De bestelling.
   * @returns {string} Een alinea met het factuuradres, of leeg.
   */
  const billingText = (order) => {
    const billing = order.deliverySame === false ? order.billingAddress : null;
    return billing && billing.street ? `\n\nFactuuradres:\n${[order.customer.company, order.customer.name, billing.street, `${billing.postcode} ${billing.city}`].filter(Boolean).join('\n')}` : '';
  };
  /**
   * De verzending als tekst: de methode met kosten, en het adres of de ophaalmelding.
   * @param {object} order De bestelling.
   * @returns {string} Tekst voor in de mail.
   */
  const shippingText = (order) => {
    const shipping = order.shipping;
    if (shipping && shipping.method === 'ophalen') return `Verzending: ${shipping.label} (gratis)\nJe haalt de bestelling zelf op.`;
    const shifted = Boolean(order.vat && order.vat.shifted);
    const businessExclusive = order.customerGroup === 'zakelijk' && !shifted;
    const priceText = shipping && shipping.price > 0 ? `${EUR.format(businessExclusive && shipping.priceExcl !== undefined ? shipping.priceExcl : shipping.price)}${businessExclusive ? ' excl. btw' : shifted ? ' (btw verlegd)' : ''}` : 'gratis';
    return `${shipping ? `Verzending: ${shipping.label} (${priceText})\n\n` : ''}Afleveradres:\n${addressText(order)}${billingText(order)}`;
  };

  /**
   * De persoonlijke link naar een gastbestelling voor in een mail aan de klant (nooit in de melding aan het bedrijf).
   * Het webadres komt uit Beheer (Betalen), nooit uit een verzoek.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De bestelling.
   * @param {object} settings De instellingen van de omgeving.
   * @returns {string} De link, of een lege tekst (geen gastbestelling of geen webadres).
   */
  const guestLink = (tenantId, order, settings) => {
    if (!order.guest) return '';
    const payment = settings.get('shopPayment');
    return guestLinkOf(tenantId, order, cleanPublicUrl(payment && payment.publicUrl));
  };

  /**
   * Stuurt de bevestiging naar de klant en de melding naar het bedrijf, en
   * legt vast hoe dat is gegaan. Bij een online bestelling gebeurt dat pas als hij betaald is.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De geplaatste bestelling.
   * @returns {Promise<void>}
   */
  async function sendPlaced(tenantId, order) {
    let settings;
    let mailer;
    try {
      settings = settingsFor(tenantId);
      mailer = mailerFor(settings);
    } catch (failure) {
      console.error('Mailinstellingen lezen mislukt:', failure);
      orders.updateData(tenantId, order.id, { mail: { sent: false, error: MAIL_SETUP_FAILED, at: new Date().toISOString() } });
      return;
    }
    if (!mailer.configured()) { orders.updateData(tenantId, order.id, { mail: { sent: false, error: 'Geen mailserver ingesteld.', at: new Date().toISOString() } }); return; }
    const profile = settings.get('quoteProfile') || {};
    const paid = Boolean(order.pay && order.pay.status === 'betaald');
    const link = guestLink(tenantId, order, settings);
    const details = `Bestelling ${order.number}\n\n${linesText(order)}\n\n${totalsText(order)}\n\n${shippingText(order)}${order.note ? `\n\nJe opmerking: ${order.note}` : ''}`;
    let error = '';
    try {
      const style = mailStyleOf(settings);
      const composed = composeFor(settings, paid ? 'order_betaald' : 'order_rekening', {
        klant: order.customer.name, nummer: order.number, bedrag: EUR.format(order.totals.total), bestelling: details, levertijd: DeliveryTimes.etaSentence(order.shipping),
        statuslink: link ? `Bekijk de status van je bestelling, download de factuur of vraag een retour aan via deze persoonlijke link (bewaar deze mail en deel de link niet):\n${link}` : '',
      });
      // De tekst over het herroepingsrecht is wettelijk en staat altijd onderaan, welke eigen tekst er ook is ingesteld.
      const withdrawal = `Als consument kun je binnen ${WITHDRAWAL_DAYS} dagen na ontvangst herroepen: ${link ? 'open je bestelling via de link hierboven' : 'log in'} en kies bij je bestelling Retour aanvragen, of antwoord op deze mail. Onze algemene voorwaarden, privacyverklaring en het herroepingsrecht met modelformulier staan onderaan elke pagina van de webshop.`;
      const customerMail = mailBody(profile, [...composed.paragraphs, withdrawal], undefined, style);
      await mailer.send({ to: order.email, subject: composed.subject, text: customerMail.text, html: customerMail.html, replyTo: validEmail(profile.email) ? profile.email : undefined });
      if (validEmail(profile.email)) {
        const shopMail = mailBody(profile, [`Nieuwe webshopbestelling ${order.number} van ${order.customer.company || order.customer.name} (${order.email})${paid ? ', online betaald' : ''}.`, details, ...(DeliveryTimes.etaSentence(order.shipping) ? [`Aan de klant doorgegeven: ${DeliveryTimes.etaSentence(order.shipping)}`] : [])], undefined, style);
        await mailer.send({ to: profile.email, subject: `Nieuwe webshopbestelling ${order.number}`, text: shopMail.text, html: shopMail.html });
      }
    } catch (failure) {
      error = mailFailure(failure).slice(0, 300);
    }
    orders.updateData(tenantId, order.id, { mail: { sent: !error, error, at: new Date().toISOString() } });
  }

  /**
   * Of aanvragen voor een zakelijk account per mail kunnen binnenkomen: er is een
   * mailserver ingesteld en het bedrijfsprofiel heeft een e-mailadres.
   * @param {string} tenantId Id van de omgeving.
   * @returns {boolean} true als het formulier getoond kan worden.
   */
  function businessRequestReady(tenantId) {
    try {
      const settings = settingsFor(tenantId);
      return mailerFor(settings).configured() && validEmail((settings.get('quoteProfile') || {}).email);
    } catch {
      return false;
    }
  }

  /**
   * Mailt een aanvraag voor een zakelijk account (formulier op de startpagina van
   * de shop) naar het e-mailadres van het bedrijf; de gegevens worden niet bewaard.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ company?: string, email?: string, phone?: string, message?: string }} request De ingevulde velden.
   * @returns {Promise<boolean>} true als de mail is verstuurd; false bij ongeldige gegevens, geen mailserver of een fout.
   */
  async function sendBusinessRequest(tenantId, request) {
    /**
     * Maakt van een invoerveld een korte tekst zonder stuurtekens.
     * @param {*} value De invoer.
     * @param {number} max Maximale lengte.
     * @returns {string} De tekst.
     */
    const clean = (value, max) => String(value || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
    // Velden die in de onderwerpregel of kop terechtkomen krijgen geen regeleinden.
    /**
     * Maakt van een invoerveld één regel tekst.
     * @param {*} value De invoer.
     * @param {number} max Maximale lengte.
     * @returns {string} De tekst op één regel.
     */
    const oneLine = (value, max) => clean(value, max).replace(/\s+/g, ' ');
    const company = oneLine(request.company, 120);
    const email = oneLine(request.email, 120);
    const phone = oneLine(request.phone, 30);
    const message = clean(request.message, 1000);
    if (!company || !phone || !validEmail(email)) return false;
    const settings = settingsFor(tenantId);
    const mailer = mailerFor(settings);
    const profile = settings.get('quoteProfile') || {};
    if (!mailer.configured() || !validEmail(profile.email)) return false;
    const mail = mailBody(profile, ['Nieuwe aanvraag voor een zakelijk account via de webshop.', `Bedrijfsnaam: ${company}\nE-mail: ${email}\nTelefoon: ${phone}${message ? `\n\nBericht:\n${message}` : ''}`], undefined, mailStyleOf(settings));
    await mailer.send({ to: profile.email, subject: `Aanvraag zakelijk account: ${company}`, text: mail.text, html: mail.html, replyTo: email });
    return true;
  }

  /**
   * Meldt de klant dat de bestelling onderweg is (met de volgcode van DPD als
   * die er is) of klaarstaat om op te halen, en legt vast hoe dat is gegaan.
   * Met `onlyNewTracking` (na het vastleggen van een volgcode) gaat er alleen
   * een mail als de klant deze code nog niet kreeg.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De verzonden bestelling (met shipping en shipMail).
   * @param {{ onlyNewTracking?: boolean, shipment?: object }} [options] Zie boven; met `shipment` gaat het om een deellevering: de mail noemt wat nu onderweg is en wat nog op backorder staat (met de verwachte datum).
   * @returns {Promise<void>}
   */
  async function sendShipment(tenantId, order, { onlyNewTracking = false, shipment = null } = {}) {
    const shipping = order.shipping || {};
    const pickup = shipping.method === 'ophalen';
    const tracking = !pickup && shipping.tracking ? shipping.tracking : null;
    if (onlyNewTracking && (!tracking || (order.shipMail && order.shipMail.sent && order.shipMail.tracking === tracking.code))) return;
    /**
     * Legt de uitkomst van de verzendmail vast bij de bestelling.
     * @param {{ sent: boolean, error: string }} patch Of de mail is verstuurd en anders de fout.
     * @returns {void}
     */
    const record = (patch) => orders.updateData(tenantId, order.id, { shipMail: { tracking: tracking ? tracking.code : null, at: new Date().toISOString(), ...patch } });
    let mailer;
    let profile;
    let settings;
    let link = '';
    try {
      settings = settingsFor(tenantId);
      mailer = mailerFor(settings);
      profile = settings.get('quoteProfile') || {};
      link = guestLink(tenantId, order, settings);
    } catch (failure) {
      console.error('Mailinstellingen lezen mislukt:', failure);
      record({ sent: false, error: MAIL_SETUP_FAILED });
      return;
    }
    if (!mailer.configured()) { record({ sent: false, error: 'Geen mailserver ingesteld.' }); return; }
    // Bij een deellevering alleen de regels van deze zending; bij de laatste zending van een bestelling in delen ook alleen de laatste.
    const lastShipment = shipment || (Array.isArray(order.shipments) && order.shipments.length > 1 ? order.shipments[order.shipments.length - 1] : null);
    const shippedText = lastShipment
      ? lastShipment.lines.map((entry) => order.lines[entry.index] && `${entry.qty} × ${order.lines[entry.index].name} (${order.lines[entry.index].code})`).filter(Boolean).join('\n')
      : linesText(order);
    const backorderLines = shipment && order.fulfilment ? order.fulfilment.lines.filter((entry) => entry.backorder > 0 && order.lines[entry.index]) : [];
    const backorderText = backorderLines.map((entry) => `${entry.backorder} × ${order.lines[entry.index].name} (${order.lines[entry.index].code})${entry.expected ? `, verwacht ${expectedText(entry.expected)}` : ''}`).join('\n');
    const typeKey = `${shipment ? 'deel_' : ''}${pickup ? 'klaar_ophalen' : tracking ? 'verzonden_volgcode' : 'verzonden'}`;
    let error = '';
    try {
      const style = mailStyleOf(settings);
      const composed = composeFor(settings, typeKey, {
        klant: order.customer.name, nummer: order.number, volgcode: tracking ? tracking.code : '', volglink: tracking ? tracking.url : '',
        ophaaladres: profile.address || '', bestelling: `Bestelling ${order.number}\n\n${shippedText}`, bestellink: link ? `Je bestelling bekijken: ${link}` : '',
        backorder: backorderText ? `Nog niet geleverd (backorder):\n${backorderText}\n\nZodra de rest binnen is, sturen we het je na. Je ontvangt dan opnieuw bericht.` : '',
      });
      const message = mailBody(profile, composed.paragraphs, undefined, style);
      await mailer.send({ to: order.email, subject: composed.subject, text: message.text, html: message.html, replyTo: validEmail(profile.email) ? profile.email : undefined });
      // Dropshipping: het adres voor het afleverbewijs krijgt een eigen, vast bericht (alleen bestelnummer en volgcode, nooit tekst van de klant),
      // want dat adres is niet geverifieerd en mag de shop-afzender niet als doorgeefluik gebruiken.
      const proofEmail = !pickup && order.dropshipping && validEmail(order.dropshipping.proofEmail) && order.dropshipping.proofEmail !== order.email ? order.dropshipping.proofEmail : '';
      if (proofEmail) {
        const proofLines = [`Bestelling ${order.number} is onderweg naar de ontvanger.`, tracking ? `Volg het pakket met de code ${tracking.code}: ${tracking.url}` : 'Zodra we de volgcode hebben, sturen we hem toe.'];
        const proof = mailBody(profile, proofLines, undefined, style);
        await mailer.send({ to: proofEmail, subject: tracking ? `Bestelling ${order.number} is onderweg (volgcode ${tracking.code})` : `Bestelling ${order.number} is onderweg`, text: proof.text, html: proof.html, replyTo: validEmail(profile.email) ? profile.email : undefined });
      }
    } catch (failure) {
      error = mailFailure(failure).slice(0, 300);
    }
    record({ sent: !error, error });
  }

  /**
   * Of de omgeving mail kan versturen (een mailserver is ingesteld).
   * @param {string} tenantId Id van de omgeving.
   * @returns {boolean} true als er een mailserver is.
   */
  function mailReady(tenantId) {
    try {
      return mailerFor(settingsFor(tenantId)).configured();
    } catch {
      return false;
    }
  }

  /**
   * Meldt een bezoeker dat een artikel weer te bestellen is (voorraadmelding), met een link naar de webshop als het webadres bekend is.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ email: string, name: string, code: string }} alert Het adres van de bezoeker en het artikel.
   * @returns {Promise<boolean>} true als de mail is verstuurd; false zonder mailserver of bij een ongeldig adres. Een verzendfout wordt gegooid, zodat de melding blijft staan voor een volgende ronde.
   */
  async function sendStockAlert(tenantId, { email, name, code }) {
    if (!validEmail(email)) return false;
    const settings = settingsFor(tenantId);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return false;
    const profile = settings.get('quoteProfile') || {};
    const base = cleanPublicUrl((settings.get('shopPayment') || {}).publicUrl);
    const link = base ? `${base}zoeken/?q=${encodeURIComponent(code)}` : '';
    const composed = composeFor(settings, 'weer_op_voorraad', { artikel: name, code, artikellink: link ? `\n\nBekijk het artikel: ${link}` : '' });
    const mail = mailBody(profile, composed.paragraphs, undefined, mailStyleOf(settings));
    await mailer.send({ to: email, subject: composed.subject, text: mail.text, html: mail.html, replyTo: validEmail(profile.email) ? profile.email : undefined });
    return true;
  }

  /**
   * Maakt een naam geschikt voor de aanhef van een ongevraagde mail: geen links, regeleinden of lange tekst.
   * @param {string} name De naam uit de bestelling.
   * @returns {string} De opgeschoonde naam, of 'klant'.
   */
  const safeName = (name) => String(name || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/https?:\/\/\S*|www\.\S*|\S+@\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'klant';

  /**
   * Stuurt één herinnering bij een online bestelling waarvan de betaling niet is afgerond: wat er aan de hand is, tot wanneer de
   * artikelen gereserveerd blijven en een link om af te rekenen (de persoonlijke link bij een gastbestelling, anders de
   * bestelpagina met Nu betalen). Zonder webadres uit Beheer wordt er niets gestuurd: een herinnering zonder link helpt niemand.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De bestelling (met pay, email, customer, number, reservedUntil, reservationReleasedAt).
   * @returns {Promise<boolean>} true als de mail is verstuurd; false bij een ongeldig adres, geen mailserver of geen webadres.
   */
  async function sendPaymentReminder(tenantId, order) {
    if (!validEmail(order.email)) return false;
    const settings = settingsFor(tenantId);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) return false;
    const payment = settings.get('shopPayment') || {};
    const base = cleanPublicUrl(payment.publicUrl);
    const link = order.guest ? guestLink(tenantId, order, settings) : (base ? `${base}bestelling/${encodeURIComponent(order.id)}/` : '');
    if (!link) return false;
    const profile = settings.get('quoteProfile') || {};
    const failed = order.pay && order.pay.status === 'mislukt';
    const until = order.reservedUntil ? new Date(order.reservedUntil).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Amsterdam' }) : '';
    const composed = composeFor(settings, failed ? 'betalingsherinnering_mislukt' : 'betalingsherinnering', {
      klant: safeName(order.customer.name), nummer: order.number, bedrag: EUR.format(order.totals.total), link,
      // Onbetaald ligt de voorraad maar kort vast (audit 1.33.0 B-13): na het vrijgeven beloven we geen reservering meer.
      reservering: !until ? '' : order.reservationReleasedAt ? `Je kunt je bestelling nog afrekenen tot ${until}, zolang de voorraad strekt. ` : `We houden de artikelen voor je gereserveerd tot ${until}. `,
    });
    const mail = mailBody(profile, composed.paragraphs, undefined, mailStyleOf(settings));
    await mailer.send({ to: order.email, subject: composed.subject, text: mail.text, html: mail.html, replyTo: validEmail(profile.email) ? profile.email : undefined });
    return true;
  }

  return { sendPlaced, sendShipment, sendBusinessRequest, businessRequestReady, mailReady, sendStockAlert, sendPaymentReminder };
}

module.exports = { createOrderMailer };
