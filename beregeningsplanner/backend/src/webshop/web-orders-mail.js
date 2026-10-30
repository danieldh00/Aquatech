// Mails bij een bestelling in de eigen webshop: een bevestiging aan de klant en
// een melding aan het bedrijf (e-mailadres uit het bedrijfsprofiel). Via de
// mailserver van de organisatie (mailer.js); een mislukte verzending houdt de
// bestelling niet tegen maar blijft zichtbaar bij de bestelling (data.mail).
const { validEmail } = require('../platform/mailer');

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

/**
 * Maakt de verzender van bestelmails.
 * @param {{ orders: object, settingsFor: Function, mailerFor: Function, mailBody: Function }} deps De bestelopslag, de instellingen per omgeving, de mailserver en de opmaak van de mail.
 * @returns {{ sendPlaced: Function }} De functies.
 */
function createOrderMailer({ orders, settingsFor, mailerFor, mailBody }) {
  /**
   * De regels van de bestelling als tekst, één per regel.
   * @param {object} order De bestelling (met regels).
   * @returns {string} De regels.
   */
  const linesText = (order) => order.lines.map((line) => `${line.qty} × ${line.name} (${line.code}): ${EUR.format(line.lineTotal)}`).join('\n');
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
    return `${shipping ? `Verzending: ${shipping.label} (${shipping.price > 0 ? EUR.format(shipping.price) : 'gratis'})\n\n` : ''}Afleveradres:\n${addressText(order)}`;
  };

  /**
   * Stuurt de bevestiging naar de klant en de melding naar het bedrijf, en
   * legt vast hoe dat is gegaan.
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
    const details = `Bestelling ${order.number}\n\n${linesText(order)}\n\nTotaal incl. btw: ${EUR.format(order.totals.total)}\n\n${shippingText(order)}${order.note ? `\n\nJe opmerking: ${order.note}` : ''}`;
    let error = '';
    try {
      const customerMail = mailBody(profile, [
        `Beste ${order.customer.name},`, 'Bedankt voor je bestelling. We hebben hem ontvangen en reserveren de artikelen voor je.',
        details, 'Je bestelling gaat op rekening: je ontvangt de factuur van ons. Zodra je bestelling onderweg is of klaarstaat, laten we het je weten.',
      ]);
      await mailer.send({ to: order.email, subject: `Bevestiging van je bestelling ${order.number}`, text: customerMail.text, html: customerMail.html, replyTo: validEmail(profile.email) ? profile.email : undefined });
      if (validEmail(profile.email)) {
        const shopMail = mailBody(profile, [`Nieuwe webshopbestelling ${order.number} van ${order.customer.company || order.customer.name} (${order.email}).`, details]);
        await mailer.send({ to: profile.email, subject: `Nieuwe webshopbestelling ${order.number}`, text: shopMail.text, html: shopMail.html });
      }
    } catch (failure) {
      error = String(failure && failure.message || 'Versturen mislukt.').slice(0, 300);
    }
    orders.updateData(tenantId, order.id, { mail: { sent: !error, error, at: new Date().toISOString() } });
  }

  return { sendPlaced };
}

module.exports = { createOrderMailer };
