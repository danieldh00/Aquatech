// Openbare betaallink uit de factuurmail: de klant klikt, komt zonder inloggen bij de betaalpagina van Mollie en na het betalen op een
// korte bevestigingspagina. De link is een handtekening over de factuur (invoice-payments.js linkFor/publicLinkCheck); wat er te betalen
// is komt altijd uit de factuur zelf. Alleen de factuur van de link, nooit andere gegevens van de klant.

/**
 * Maakt tekst veilig voor gebruik in HTML.
 * @param {*} value De tekst.
 * @returns {string} De tekst met & < > " ' vervangen.
 */
const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

/**
 * Een kleine, eigen pagina met een melding (geen scripts of opmaakbestanden nodig).
 * @param {string} rawTitle Kop van de pagina.
 * @param {string} rawText Uitleg.
 * @returns {string} De HTML.
 */
const messagePage = (rawTitle, rawText) => {
  const title = escapeHtml(rawTitle);
  const text = escapeHtml(rawText);
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
};

/**
 * Registreert de openbare betaallink van een factuur.
 * @param {object} app De Express-app.
 * @param {{ invoicePayments: object, tenantId: string, limiter: Function }} ctx De betaalfuncties, de omgeving van de webshop/facturen en de limiet per bezoeker.
 * @returns {void}
 */
function registerInvoicePayLinkRoutes(app, { invoicePayments, tenantId, limiter }) {
  app.get('/api/public/invoice-pay/:invoiceId/:signature', limiter, async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
    /**
     * Stuurt een korte meldingspagina terug.
     * @param {number} status De HTTP-status.
     * @param {string} title De titel van de pagina.
     * @param {string} text De uitleg onder de titel.
     * @returns {object} Het antwoord.
     */
    const show = (status, title, text) => res.status(status).type('html').send(messagePage(title, text));
    const checked = invoicePayments.publicLinkCheck(tenantId, req.params.invoiceId, req.params.signature);
    if (checked.error === 'expired') return show(410, 'Deze betaallink is verlopen', 'Neem contact met ons op voor een nieuwe link.');
    if (!checked.invoice) return show(404, 'Betaallink niet gevonden', 'Controleer of u de volledige link uit de e-mail hebt gebruikt.');
    let invoice = checked.invoice;
    if (req.query.teruggekeerd === '1') {
      try { await invoicePayments.sync(tenantId, invoice.id); } catch (error) {
        return show(502, 'Betaalstatus niet te controleren', 'We kunnen de status van uw betaling nu niet opvragen. Is de betaling gelukt, dan verwerken we haar vanzelf.');
      }
      invoice = invoicePayments.publicLinkCheck(tenantId, invoice.id, req.params.signature).invoice || invoice;
      if (invoice.status === 'betaald') return show(200, 'Bedankt, uw betaling is ontvangen', `Factuur ${invoice.number} is betaald.`);
      return show(200, 'Uw betaling is nog niet bevestigd', 'Is de betaling gelukt, dan ziet u de factuur zo als betaald. Anders kunt u de link uit de e-mail opnieuw gebruiken.');
    }
    if (invoice.status === 'betaald') return show(200, 'Deze factuur is al betaald', `Factuur ${invoice.number} is betaald, dank u wel.`);
    if (!invoicePayments.payableState(tenantId, invoice)) return show(409, 'Online betalen is niet mogelijk', 'Betaal deze factuur op de manier die in de e-mail of op de factuur staat.');
    // Terug na het betalen: een adres uit het webadres van Beheer, nooit uit de Host-kop.
    const returnUrl = invoicePayments.appUrl(tenantId, `api/public/invoice-pay/${encodeURIComponent(invoice.id)}/${req.params.signature}?teruggekeerd=1`);
    const out = await invoicePayments.start(tenantId, invoice, { returnUrl });
    if (out.paid) return show(200, 'Deze factuur is al betaald', `Factuur ${invoice.number} is betaald, dank u wel.`);
    if (out.error) return show(out.status || 502, 'Betalen lukt nu niet', out.error);
    res.redirect(302, out.checkoutUrl);
  });
}

module.exports = { registerInvoicePayLinkRoutes, messagePage };
