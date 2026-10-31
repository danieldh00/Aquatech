// Mails bij een bestelling in de eigen webshop: een bevestiging aan de klant en
// een melding aan het bedrijf (e-mailadres uit het bedrijfsprofiel). Via de
// mailserver van de organisatie (mailer.js); een mislukte verzending houdt de
// bestelling niet tegen maar blijft zichtbaar bij de bestelling (data.mail).
// Bij Verzonden volgt een mail met de volgcode van DPD (of: klaar om op te
// halen); komt de volgcode later, dan volgt één mail met die code (data.shipMail).
const { validEmail } = require('../platform/mailer');
const { WITHDRAWAL_DAYS } = require('./legal-pages');

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

/**
 * Maakt de verzender van bestelmails.
 * @param {{ orders: object, settingsFor: Function, mailerFor: Function, mailBody: Function }} deps De bestelopslag, de instellingen per omgeving, de mailserver en de opmaak van de mail.
 * @returns {{ sendPlaced: Function, sendShipment: Function }} De functies.
 */
function createOrderMailer({ orders, settingsFor, mailerFor, mailBody }) {
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
    return `${shipping ? `Verzending: ${shipping.label} (${priceText})\n\n` : ''}Afleveradres:\n${addressText(order)}`;
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
      orders.updateData(tenantId, order.id, { mail: { sent: false, error: String(failure && failure.message || 'Versturen mislukt.').slice(0, 300), at: new Date().toISOString() } });
      return;
    }
    if (!mailer.configured()) { orders.updateData(tenantId, order.id, { mail: { sent: false, error: 'Geen mailserver ingesteld.', at: new Date().toISOString() } }); return; }
    const profile = settings.get('quoteProfile') || {};
    const paid = Boolean(order.pay && order.pay.status === 'betaald');
    const details = `Bestelling ${order.number}\n\n${linesText(order)}\n\n${totalsText(order)}\n\n${shippingText(order)}${order.note ? `\n\nJe opmerking: ${order.note}` : ''}`;
    let error = '';
    try {
      const customerMail = mailBody(profile, [
        `Beste ${order.customer.name},`, paid ? 'Bedankt voor je bestelling en je betaling. We hebben beide ontvangen en reserveren de artikelen voor je.' : 'Bedankt voor je bestelling. We hebben hem ontvangen en reserveren de artikelen voor je.',
        details, paid ? `Je hebt ${EUR.format(order.totals.total)} online betaald. Je ontvangt de factuur van ons. Zodra je bestelling onderweg is of klaarstaat, laten we het je weten.` : 'Je bestelling gaat op rekening: je ontvangt de factuur van ons. Zodra je bestelling onderweg is of klaarstaat, laten we het je weten.',
        `Als consument kun je binnen ${WITHDRAWAL_DAYS} dagen na ontvangst herroepen: log in en kies bij je bestelling Retour aanvragen, of antwoord op deze mail. Onze algemene voorwaarden, privacyverklaring en het herroepingsrecht met modelformulier staan onderaan elke pagina van de webshop.`,
      ]);
      await mailer.send({ to: order.email, subject: `Bevestiging van je bestelling ${order.number}`, text: customerMail.text, html: customerMail.html, replyTo: validEmail(profile.email) ? profile.email : undefined });
      if (validEmail(profile.email)) {
        const shopMail = mailBody(profile, [`Nieuwe webshopbestelling ${order.number} van ${order.customer.company || order.customer.name} (${order.email})${paid ? ', online betaald' : ''}.`, details]);
        await mailer.send({ to: profile.email, subject: `Nieuwe webshopbestelling ${order.number}`, text: shopMail.text, html: shopMail.html });
      }
    } catch (failure) {
      error = String(failure && failure.message || 'Versturen mislukt.').slice(0, 300);
    }
    orders.updateData(tenantId, order.id, { mail: { sent: !error, error, at: new Date().toISOString() } });
  }

  /**
   * Meldt de klant dat de bestelling onderweg is (met de volgcode van DPD als
   * die er is) of klaarstaat om op te halen, en legt vast hoe dat is gegaan.
   * Met `onlyNewTracking` (na het vastleggen van een volgcode) gaat er alleen
   * een mail als de klant deze code nog niet kreeg.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De verzonden bestelling (met shipping en shipMail).
   * @param {{ onlyNewTracking?: boolean }} [options] Zie boven.
   * @returns {Promise<void>}
   */
  async function sendShipment(tenantId, order, { onlyNewTracking = false } = {}) {
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
    try {
      const settings = settingsFor(tenantId);
      mailer = mailerFor(settings);
      profile = settings.get('quoteProfile') || {};
    } catch (failure) {
      record({ sent: false, error: String(failure && failure.message || 'Versturen mislukt.').slice(0, 300) });
      return;
    }
    if (!mailer.configured()) { record({ sent: false, error: 'Geen mailserver ingesteld.' }); return; }
    const intro = pickup
      ? `Je bestelling ${order.number} staat klaar om op te halen.${profile.address ? `\n\nOphaaladres:\n${profile.address}` : ''}`
      : tracking
        ? `Je bestelling ${order.number} is onderweg. Volg je pakket met de code ${tracking.code}: ${tracking.url}`
        : `Je bestelling ${order.number} is onderweg met DPD. Zodra we de volgcode hebben, sturen we hem je toe.`;
    let error = '';
    try {
      const message = mailBody(profile, [`Beste ${order.customer.name},`, ...intro.split(/\n{2,}/), `Bestelling ${order.number}\n\n${linesText(order)}`]);
      const subject = pickup ? `Je bestelling ${order.number} staat klaar` : tracking ? `Je bestelling ${order.number} is onderweg (volgcode ${tracking.code})` : `Je bestelling ${order.number} is onderweg`;
      await mailer.send({ to: order.email, subject, text: message.text, html: message.html, replyTo: validEmail(profile.email) ? profile.email : undefined });
    } catch (failure) {
      error = String(failure && failure.message || 'Versturen mislukt.').slice(0, 300);
    }
    record({ sent: !error, error });
  }

  return { sendPlaced, sendShipment };
}

module.exports = { createOrderMailer };
