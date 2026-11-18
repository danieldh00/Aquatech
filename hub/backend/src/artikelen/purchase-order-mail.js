// Een inkooporder per e-mail naar de leverancier sturen, alleen na een klik van een medewerker (nooit automatisch): het concept
// van ontvanger, onderwerp en tekst voor het scherm, en het versturen met de inkooporder als PDF in de bijlage. Wat er gebeurde
// (wanneer, naar wie, of het mislukte) komt op de order zelf (purchaseOrders.markMail). De opmaak van de mail is die van de andere
// zakelijke mails (mailBody); een instelbare mailopmaak volgt later.
const { validEmail, mailFailure } = require('../platform/mailer');
const { purchaseOrderPdf, purchaseOrderFileName } = require('./purchase-order-pdf');

/** Statussen waarin een order naar de leverancier mag: pas na Bestellen, en niet meer als hij af of geannuleerd is. */
const SENDABLE_STATUSES = ['besteld', 'deels_ontvangen'];
const MAX_RECIPIENTS = 3;
const MAX_SUBJECT = 200;
const MAX_MESSAGE = 5000;

/**
 * Maakt een fout met een code (not_found, not_sendable, not_configured, invalid_to, busy of send_failed).
 * @param {string} code De foutcode.
 * @param {string} message De leesbare melding.
 * @param {Error} [cause] De onderliggende fout.
 * @returns {Error} De fout met `code`.
 */
const failure = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });

/**
 * Maakt tekst zonder stuurtekens (geen kopregel-injectie) en begrensd.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximale lengte.
 * @returns {string} De schone tekst op één regel.
 */
const singleLine = (value, maxLength) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);

/**
 * Leest de ontvangers uit tekst met een of meer adressen (gescheiden door komma, puntkomma of spatie).
 * @param {*} value De invoer.
 * @returns {{ addresses: string[], invalid: boolean }} De geldige adressen zonder dubbelen (hoogstens drie) en of er iets ongeldigs bij zat.
 */
function parseRecipients(value) {
  const parts = String(value ?? '').split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean);
  const addresses = [];
  let invalid = parts.length === 0 || parts.length > MAX_RECIPIENTS;
  for (const part of parts) {
    if (!validEmail(part)) invalid = true;
    else if (!addresses.some((address) => address.toLowerCase() === part.toLowerCase())) addresses.push(part);
  }
  return { addresses: addresses.slice(0, MAX_RECIPIENTS), invalid };
}

/**
 * Maakt de verzender voor inkooporders per e-mail.
 * @param {{ purchaseOrders: object, suppliers: object, settingsFor: Function, mailerFor: Function, mailBody: Function, colorsOf?: Function }} deps De orderopslag (get, markMail), de leveranciersopslag (get), de instellingen per omgeving, de mailserver, de opmaak van de mail en de themakleuren per omgeving.
 * @returns {{ draft: Function, send: Function, pdfOf: Function, fileName: Function }} De functies.
 */
function createPurchaseOrderMailer({ purchaseOrders, suppliers, settingsFor, mailerFor, mailBody, colorsOf = () => ({}) }) {
  /** Orders waarvan nu een mail onderweg is (tegen een dubbele klik of twee schermen). */
  const sending = new Set();
  /** Orders die net met succes zijn verstuurd (sleutel → { to, at }): houdt `already_sent` overeind als het vastleggen in de database faalde. */
  const recentlySent = new Map();
  const RECENT_MS = 10 * 60 * 1000;

  /**
   * Zoekt de order en de leverancier van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de order.
   * @returns {{ order: object, supplier: object }} De order (met regels) en de leverancier. Gooit not_found.
   */
  function load(tenantId, id) {
    const order = purchaseOrders.get(tenantId, id);
    if (!order) throw failure('not_found', 'Inkooporder niet gevonden.');
    return { order, supplier: suppliers.get(tenantId, order.supplierId) || { name: order.supplierName, email: '' } };
  }

  /**
   * De inkooporder als PDF met het profiel, de kleuren en de documentopmaak van de organisatie.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De order (met regels).
   * @param {object} supplier De leverancier.
   * @returns {Buffer} De PDF.
   */
  function pdfOf(tenantId, order, supplier) {
    const settings = settingsFor(tenantId);
    return purchaseOrderPdf(order, { profile: settings.get('quoteProfile'), supplier, colors: colorsOf(tenantId), layout: settings.get('documentLayout') });
  }

  /**
   * Het concept voor het scherm: ontvanger (het adres van de leverancier), onderwerp en tekst, en wat het versturen nu tegenhoudt.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de order.
   * @returns {{ to: string, subject: string, message: string, fileName: string, canSend: boolean, problem: string, mail: object }} Het concept, of `problem` (leesbaar) als versturen nog niet kan; `mail` = wat er eerder gebeurde (sentAt, sentTo, sentBy, error). Gooit not_found.
   */
  function draft(tenantId, id) {
    const { order, supplier } = load(tenantId, id);
    const settings = settingsFor(tenantId);
    const profile = settings.get('quoteProfile') || {};
    const contact = singleLine(supplier.contactName, 80);
    const paragraphs = [
      `Beste ${contact || 'heer/mevrouw'},`,
      `Hierbij ontvangt u onze inkooporder ${order.number}${order.supplierReference ? ` (uw referentie ${singleLine(order.supplierReference, 60)})` : ''}. De order staat als PDF in de bijlage.`,
      'Wilt u de order bevestigen met de verwachte levertijd? Bij vragen kunt u op deze mail antwoorden.',
      'Met vriendelijke groet,',
    ];
    let problem = '';
    if (!SENDABLE_STATUSES.includes(order.status)) problem = order.status === 'concept' ? 'Zet de order eerst op besteld (knop Bestellen); daarna kun je hem naar de leverancier sturen.' : 'Alleen een bestelde order is naar de leverancier te sturen.';
    else if (!mailerFor(settings).configured()) problem = 'Er is geen mailserver ingesteld (Beheer → Integraties → E-mail).';
    else if (!validEmail(supplier.email)) problem = `Bij leverancier ${supplier.name} staat geen geldig e-mailadres; vul het hieronder in of bij Leveranciers.`;
    return {
      to: validEmail(supplier.email) ? supplier.email : '',
      subject: singleLine(`Inkooporder ${order.number} van ${profile.companyName || 'AquaTech'}`, MAX_SUBJECT),
      message: paragraphs.join('\n\n'),
      fileName: purchaseOrderFileName(order),
      // Een ontbrekend leveranciersadres is geen blokkade: het scherm laat de medewerker een adres invullen.
      canSend: SENDABLE_STATUSES.includes(order.status) && mailerFor(settings).configured(),
      problem,
      mail: order.mail,
    };
  }

  /**
   * Verstuurt de order met de PDF als bijlage naar het opgegeven adres. Alleen aanroepen na een expliciete klik; legt het resultaat vast op de order.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de order.
   * @param {{ to?: string, subject?: string, message?: string, resend?: boolean }} options De ontvanger(s), het onderwerp en de tekst zoals de medewerker ze nakeek (leeg = de standaard); `resend: true` is nodig als de order al eerder is verstuurd (zo mailt een tweede klik of een tweede scherm nooit per ongeluk dubbel).
   * @param {{ display_name?: string, name?: string }} user De medewerker die verstuurt (req.user).
   * @returns {Promise<object>} De bijgewerkte order. Gooit een fout met code not_found, not_sendable, already_sent, not_configured, invalid_to, busy of send_failed.
   */
  async function send(tenantId, id, { to, subject, message, resend = false } = {}, user = {}) {
    const { order, supplier } = load(tenantId, id);
    if (!SENDABLE_STATUSES.includes(order.status)) throw failure('not_sendable', 'Alleen een bestelde order is naar de leverancier te sturen.');
    const recent = recentlySent.get(`${tenantId}:${order.id}`);
    const earlierTo = order.mail.sentAt ? order.mail.sentTo : (recent && Date.now() - recent.at < RECENT_MS ? recent.to : '');
    if (earlierTo && resend !== true) throw failure('already_sent', `Deze order is al verstuurd naar ${earlierTo}. Open het paneel opnieuw als je hem nog een keer wilt sturen.`);
    const settings = settingsFor(tenantId);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) throw failure('not_configured', 'Er is geen mailserver ingesteld (Beheer → Integraties → E-mail).');
    const { addresses, invalid } = parseRecipients(to === undefined || to === '' ? supplier.email : to);
    if (invalid || !addresses.length) throw failure('invalid_to', `Geef een geldig e-mailadres op${supplier.email ? '' : ` (bij leverancier ${supplier.name} staat er geen)`}.`);
    const defaults = draft(tenantId, id);
    const key = `${tenantId}:${order.id}`;
    if (sending.has(key)) throw failure('busy', 'Deze order wordt al verstuurd.');
    sending.add(key);
    try {
      const profile = settings.get('quoteProfile') || {};
      const text = String(message === undefined || String(message).trim() === '' ? defaults.message : message).slice(0, MAX_MESSAGE);
      try {
        await mailer.send({
          to: addresses,
          replyTo: validEmail(profile.email) ? profile.email : undefined,
          subject: singleLine(subject, MAX_SUBJECT) || defaults.subject,
          ...mailBody(profile, text.split(/\n{2,}/)),
          attachments: [{ filename: purchaseOrderFileName(order), content: pdfOf(tenantId, order, supplier), contentType: 'application/pdf' }],
        });
      } catch (error) {
        const reason = mailFailure(error);
        purchaseOrders.markMail(tenantId, order.id, { error: reason });
        throw failure('send_failed', reason, error);
      }
      recentlySent.set(key, { to: addresses.join(', '), at: Date.now() });
      for (const [recentKey, entry] of recentlySent) if (Date.now() - entry.at >= RECENT_MS) recentlySent.delete(recentKey);
      // De mail is weg: een databasefout bij het vastleggen mag er geen fout van maken (dan klikt iemand opnieuw en gaat hij dubbel).
      try {
        return purchaseOrders.markMail(tenantId, order.id, { to: addresses.join(', '), by: user.display_name || user.name || '' });
      } catch (error) {
        console.error(`Inkooporder ${order.number} verstuurd, maar vastleggen mislukte: ${error.message}`);
        return purchaseOrders.get(tenantId, order.id) || order;
      }
    } finally {
      sending.delete(key);
    }
  }

  return { draft, send, pdfOf: (tenantId, id) => { const { order, supplier } = load(tenantId, id); return pdfOf(tenantId, order, supplier); }, fileName: (tenantId, id) => purchaseOrderFileName(load(tenantId, id).order) };
}

module.exports = { createPurchaseOrderMailer, parseRecipients, SENDABLE_STATUSES };
