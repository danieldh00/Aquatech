// Facturen versturen per e-mail met de factuur als PDF-bijlage
// (invoice-pdf.js), via de mailserver van de organisatie (mailer.js). Met de
// knop Versturen (eigen adres, onderwerp en tekst) of automatisch zodra een
// factuur definitief wordt (instelling invoicing.autoSend; ook voor facturen
// uit webshopbestellingen). Een mislukte verzending blijft zichtbaar op de
// factuur (send_error); de factuur zelf blijft gewoon definitief.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { validEmail } = require('../platform/mailer');
const { invoicePdf, invoiceFileName } = require('./invoice-pdf');

const Core = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
/**
 * Zet een ISO-datum om naar de Nederlandse schrijfwijze.
 * @param {string} iso Datum als ISO-tekst (alleen het datumdeel telt).
 * @returns {string} Bijv. "5-3-2026", of leeg.
 */
const day = (iso) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return match ? `${Number(match[3])}-${Number(match[2])}-${match[1]}` : '';
};

/**
 * Maakt de verzender voor facturen per e-mail.
 * @param {object} ctx invoices, settingsFor(tenantId), mailerFor(settings), colorsOf(tenantId) en mailBody(profile, paragraphs).
 * @returns {{ send: Function, autoSend: Function, draft: Function, pdfOf: Function }} De verzendfuncties.
 */
function createInvoiceSender({ invoices, settingsFor, mailerFor, colorsOf = () => ({}), mailBody }) {
  /**
   * De gecontroleerde factuurinstellingen van een organisatie.
   * @param {object} settings De instellingen van de tenant.
   * @returns {object} Instelling invoicing, opgeschoond.
   */
  const invoicingOf = (settings) => Core.sanitizeSettings(settings.get('invoicing'));

  /**
   * De factuur als PDF met het profiel, de instellingen en de kleuren van de organisatie.
   * @param {string} tenantId Id van de tenant.
   * @param {object} invoice De factuur (met data).
   * @returns {Buffer} De PDF.
   */
  function pdfOf(tenantId, invoice) {
    const settings = settingsFor(tenantId);
    return invoicePdf(invoice, { profile: settings.get('quoteProfile'), settings: invoicingOf(settings), colors: colorsOf(tenantId) });
  }

  /**
   * Waarden voor {veld} in onderwerp en tekst.
   * @param {object} invoice De factuur (met data).
   * @param {object} profile Het bedrijfsprofiel.
   * @param {object} invoicing De factuurinstellingen.
   * @returns {object} Veldnaam → tekst (klant, nummer, datum, bedrag, betaling, ...).
   */
  function valuesOf(invoice, profile, invoicing) {
    const details = invoice.data;
    const credit = invoice.kind === 'credit';
    const totals = Core.totals(details, invoicing);
    return {
      klant: details.customer.contact || details.customer.name || 'klant',
      nummer: invoice.number || '(concept)',
      datum: day(details.date),
      vervaldatum: day(details.dueDate),
      bedrag: EUR.format(totals.total),
      bedrijf: profile.companyName || '',
      soort: credit ? 'Creditfactuur' : 'Factuur',
      soort_klein: credit ? 'creditfactuur' : 'factuur',
      betaling: credit ? 'Het bedrag verrekenen wij met u.'
        : invoice.status === 'betaald' ? 'Deze factuur is al voldaan, dank u wel.'
          : Core.paymentText(invoicing, { number: invoice.number, iban: profile.iban, dueDate: day(details.dueDate) }),
    };
  }

  /**
   * Standaard ontvanger, onderwerp en tekst voor het verzendformulier.
   * @param {string} tenantId Id van de tenant.
   * @param {object} invoice De factuur (met data).
   * @returns {{ to: string, subject: string, message: string }} Het concept.
   */
  function draft(tenantId, invoice) {
    const settings = settingsFor(tenantId);
    const invoicing = invoicingOf(settings);
    const values = valuesOf(invoice, settings.get('quoteProfile'), invoicing);
    return { to: invoice.data.customer.email || '', subject: Core.fillText(invoicing.mailSubject, values), message: Core.fillText(invoicing.mailText, values) };
  }

  /**
   * Verstuurt een definitieve factuur met de PDF als bijlage. Zonder opties
   * gaat de standaardtekst naar het adres van de klant. Een mislukte
   * verzending komt op de factuur (send_error).
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de factuur.
   * @param {{ to?: string[], subject?: string, message?: string, bcc?: string }} [options] Eigen ontvangers, onderwerp, tekst en bcc.
   * @returns {Promise<object>} De bijgewerkte factuur. Gooit een fout met code not_found, not_final, not_configured, invalid_to of send_failed.
   */
  async function send(tenantId, id, options = {}) {
    const invoice = invoices.get(tenantId, id);
    if (!invoice) throw Object.assign(new Error('Factuur niet gevonden.'), { code: 'not_found' });
    if (invoice.status === 'concept') throw Object.assign(new Error('Maak de factuur eerst definitief.'), { code: 'not_final' });
    const settings = settingsFor(tenantId);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) throw Object.assign(new Error('Er is geen mailserver ingesteld (Beheer → Instellingen → E-mail).'), { code: 'not_configured' });
    const defaults = draft(tenantId, invoice);
    const to = (options.to && options.to.length ? options.to : [defaults.to]).filter(validEmail);
    if (!to.length) throw Object.assign(new Error('Geen geldig e-mailadres van de klant.'), { code: 'invalid_to' });
    const profile = settings.get('quoteProfile');
    const message = String(options.message || defaults.message).slice(0, 5000);
    try {
      await mailer.send({
        to, replyTo: profile.email, bcc: options.bcc,
        subject: String(options.subject || defaults.subject).slice(0, 300),
        ...mailBody(profile, message.split(/\n{2,}/)),
        attachments: [{ filename: invoiceFileName(invoice), content: pdfOf(tenantId, invoice), contentType: 'application/pdf' }],
      });
    } catch (error) {
      invoices.markSent(tenantId, invoice.id, '', `Versturen mislukt: ${error.message}`);
      throw Object.assign(new Error(`Versturen mislukt: ${error.message}`), { code: 'send_failed' });
    }
    invoices.markSent(tenantId, invoice.id, to.join(', '));
    return invoices.get(tenantId, invoice.id);
  }

  /**
   * Verstuurt een factuur automatisch na definitief als dat aan staat en er
   * een mailserver en een adres zijn. Gooit nooit.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de factuur.
   * @returns {Promise<{ sent: boolean, error?: string }>} Of hij verstuurd is, en anders de foutcode.
   */
  async function autoSend(tenantId, id) {
    const settings = settingsFor(tenantId);
    if (!invoicingOf(settings).autoSend) return { sent: false };
    if (!mailerFor(settings).configured()) {
      invoices.markSent(tenantId, id, '', 'Niet automatisch verstuurd: er is geen mailserver ingesteld.');
      return { sent: false, error: 'not_configured' };
    }
    try {
      await send(tenantId, id);
      return { sent: true };
    } catch (error) {
      if (error.code === 'invalid_to') invoices.markSent(tenantId, id, '', 'Niet automatisch verstuurd: de klant heeft geen geldig e-mailadres.');
      return { sent: false, error: error.code || 'send_failed' };
    }
  }

  return { send, autoSend, draft, pdfOf };
}

module.exports = { createInvoiceSender };
