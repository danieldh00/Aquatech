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
const day = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])}-${Number(m[2])}-${m[1]}` : '';
};

/**
 * ctx: { invoices, settingsFor(tid), mailerFor(settings), colorsOf(tid), mailBody(profile, paragraphs) }.
 */
function createInvoiceSender({ invoices, settingsFor, mailerFor, colorsOf = () => ({}), mailBody }) {
  const confOf = (settings) => Core.sanitizeSettings(settings.get('invoicing'));

  function pdfOf(tenantId, inv) {
    const settings = settingsFor(tenantId);
    return invoicePdf(inv, { profile: settings.get('quoteProfile'), settings: confOf(settings), colors: colorsOf(tenantId) });
  }

  /** Waarden voor {veld} in onderwerp en tekst. */
  function valuesOf(inv, profile, conf) {
    const d = inv.data;
    const credit = inv.kind === 'credit';
    const t = Core.totals(d, conf);
    return {
      klant: d.customer.contact || d.customer.name || 'klant',
      nummer: inv.number || '(concept)',
      datum: day(d.date),
      vervaldatum: day(d.dueDate),
      bedrag: EUR.format(t.total),
      bedrijf: profile.companyName || '',
      soort: credit ? 'Creditfactuur' : 'Factuur',
      soort_klein: credit ? 'creditfactuur' : 'factuur',
      betaling: credit ? 'Het bedrag verrekenen wij met u.'
        : inv.status === 'betaald' ? 'Deze factuur is al voldaan, dank u wel.'
          : Core.paymentText(conf, { number: inv.number, iban: profile.iban, dueDate: day(d.dueDate) }),
    };
  }

  /** Standaard onderwerp en tekst voor het verzendformulier. */
  function draft(tenantId, inv) {
    const settings = settingsFor(tenantId);
    const conf = confOf(settings);
    const v = valuesOf(inv, settings.get('quoteProfile'), conf);
    return { to: inv.data.customer.email || '', subject: Core.fillText(conf.mailSubject, v), message: Core.fillText(conf.mailText, v) };
  }

  /**
   * Versturen. opts: { to (lijst), subject, message, bcc }; zonder = de
   * standaard uit de instellingen naar het adres van de klant. Gooit een fout
   * met code (not_configured, invalid_to, not_final, send_failed).
   */
  async function send(tenantId, id, opts = {}) {
    const inv = invoices.get(tenantId, id);
    if (!inv) throw Object.assign(new Error('Factuur niet gevonden.'), { code: 'not_found' });
    if (inv.status === 'concept') throw Object.assign(new Error('Maak de factuur eerst definitief.'), { code: 'not_final' });
    const settings = settingsFor(tenantId);
    const mailer = mailerFor(settings);
    if (!mailer.configured()) throw Object.assign(new Error('Er is geen mailserver ingesteld (Beheer → Instellingen → E-mail).'), { code: 'not_configured' });
    const d = draft(tenantId, inv);
    const to = (opts.to && opts.to.length ? opts.to : [d.to]).filter(validEmail);
    if (!to.length) throw Object.assign(new Error('Geen geldig e-mailadres van de klant.'), { code: 'invalid_to' });
    const p = settings.get('quoteProfile');
    const message = String(opts.message || d.message).slice(0, 5000);
    try {
      await mailer.send({
        to, replyTo: p.email, bcc: opts.bcc,
        subject: String(opts.subject || d.subject).slice(0, 300),
        ...mailBody(p, message.split(/\n{2,}/)),
        attachments: [{ filename: invoiceFileName(inv), content: pdfOf(tenantId, inv), contentType: 'application/pdf' }],
      });
    } catch (err) {
      invoices.markSent(tenantId, inv.id, '', `Versturen mislukt: ${err.message}`);
      throw Object.assign(new Error(`Versturen mislukt: ${err.message}`), { code: 'send_failed' });
    }
    invoices.markSent(tenantId, inv.id, to.join(', '));
    return invoices.get(tenantId, inv.id);
  }

  /**
   * Na definitief: automatisch versturen als dat aan staat en er een
   * mailserver en een adres zijn. Geeft { sent, error } en gooit nooit.
   */
  async function autoSend(tenantId, id) {
    const settings = settingsFor(tenantId);
    if (!confOf(settings).autoSend) return { sent: false };
    if (!mailerFor(settings).configured()) {
      invoices.markSent(tenantId, id, '', 'Niet automatisch verstuurd: er is geen mailserver ingesteld.');
      return { sent: false, error: 'not_configured' };
    }
    try {
      await send(tenantId, id);
      return { sent: true };
    } catch (err) {
      if (err.code === 'invalid_to') invoices.markSent(tenantId, id, '', 'Niet automatisch verstuurd: de klant heeft geen geldig e-mailadres.');
      return { sent: false, error: err.code || 'send_failed' };
    }
  }

  return { send, autoSend, draft, pdfOf };
}

module.exports = { createInvoiceSender };
