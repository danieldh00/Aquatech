// Aanbetalingsfactuur bij een geaccordeerde offerte (V-10): na het akkoord komt er één factuur voor de aanbetaling (definitief, per e-mail met
// betaallink); de eindfactuur uit de werkorder trekt hem weer af (invoices.js, InvoiceCore.fromWorkOrder). Ook met de hand te maken vanaf de offerte.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');

const Core = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));
const QuoteCore = require(path.join(FRONTEND_DIR, 'offertes', 'quote-core.js'));
const DocText = require(path.join(FRONTEND_DIR, 'shared', 'doc-text.js'));

/**
 * Maakt de aanbetalingsfacturen van offertes.
 * @param {object} ctx invoices (factuuropslag), sender (invoice-mail), settingsFor(tenantId), mailConfigured(tenantId), audit({ tenantId, userId, action, detail }) en enabled(tenantId) (staat automatisch versturen aan).
 * @returns {{ create: Function, statusOf: Function, onAccepted: Function }} De bediening.
 */
function createDepositInvoices(ctx) {
  const { invoices, sender, settingsFor } = ctx;

  /**
   * De factuurinstellingen van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} De opgeschoonde instellingen.
   */
  const invoicingOf = (tenantId) => Core.sanitizeSettings(settingsFor(tenantId).get('invoicing'));

  /**
   * Wat er bij een offerte staat: de aanbetaling die hij vraagt en de factuur ervan als die er is.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} quoteId Id van de offerte.
   * @returns {{ deposit: object|null, invoice: object|null }|null} Het bedrag (incl. btw, met restant) en de factuur; null als de offerte niet bestaat.
   */
  function statusOf(tenantId, quoteId) {
    const quote = invoices.quote(tenantId, quoteId);
    if (!quote) return null;
    const split = QuoteCore.depositSplit(quote.data);
    const found = invoices.depositsOf(tenantId, quote.id)[0];
    const invoice = found ? invoices.get(tenantId, found.id) : null;
    return { deposit: split ? { amount: split.amount, rest: split.rest } : null, invoice: invoice ? { id: invoice.id, number: invoice.number, status: invoice.status, total: invoice.total, paid: Boolean(invoice.paidAt), sentAt: invoice.sentAt, sentTo: invoice.sentTo, sendError: invoice.sendError } : null };
  }

  /**
   * Maakt de aanbetalingsfactuur van een geaccordeerde offerte, maakt hem definitief en verstuurt hem met de betaallink (als er een mailserver
   * en een adres zijn; anders blijft hij definitief en komt hij in de openstaande taken). Nooit een tweede per offerte.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} quoteId Id van de offerte.
   * @param {{ user?: object|null, via?: string }} [options] Wie het doet (zonder: de eigenaar van de offerte) en `via` ('akkoord' of 'handmatig') voor het auditlog.
   * @returns {Promise<{ error?: string, exists?: boolean, invoice?: object, sent?: boolean, sendError?: string }>} De uitkomst; error is not_found, not_accepted of no_deposit.
   */
  async function create(tenantId, quoteId, { user = null, via = 'handmatig' } = {}) {
    const quote = invoices.quote(tenantId, quoteId);
    if (!quote) return { error: 'not_found' };
    if (quote.status !== 'akkoord') return { error: 'not_accepted' };
    const split = QuoteCore.depositSplit(quote.data);
    if (!split) return { error: 'no_deposit' };
    const existing = invoices.depositsOf(tenantId, quote.id)[0];
    if (existing) return { exists: true, invoice: invoices.get(tenantId, existing.id) };
    const actor = user || (quote.ownerId ? { id: quote.ownerId } : null);
    const settings = invoicingOf(tenantId);
    const language = quote.data.language;
    const built = Core.fromQuoteDeposit(quote, split, { settings, text: (key, values) => DocText.text(language, key, values) });
    const draft = invoices.create(tenantId, actor, built.data, settings, { quoteId: quote.id, customerId: quote.customerId, deposit: built.data.deposit });
    const finalized = invoices.finalize(tenantId, actor, draft.id, settings);
    if (!finalized || finalized.error) {
      // Zonder klantnaam kan hij niet definitief; het concept blijft staan voor een medewerker.
      return { invoice: draft, sent: false, sendError: (finalized && finalized.error) || 'finalize_failed' };
    }
    ctx.audit({ tenantId, userId: actor ? actor.id : null, action: 'aanbetalingsfactuur_aangemaakt', detail: { invoiceId: draft.id, quoteId: quote.id, number: finalized.invoice.number, via } });
    const out = { invoice: finalized.invoice, sent: false };
    try {
      out.invoice = await sender.send(tenantId, draft.id);
      out.sent = true;
    } catch (error) {
      // Geen mailserver of adres: de factuur blijft definitief en onverstuurd, met de reden erbij.
      const reason = error.code === 'not_configured' ? 'Niet automatisch verstuurd: er is geen mailserver ingesteld.'
        : error.code === 'invalid_to' ? 'Niet automatisch verstuurd: de klant heeft geen geldig e-mailadres.' : '';
      if (reason) invoices.markSent(tenantId, draft.id, '', reason);
      out.sendError = error.code || 'send_failed';
      out.invoice = invoices.get(tenantId, draft.id);
    }
    return out;
  }

  /**
   * Haak voor het akkoord op een offerte: maakt de aanbetalingsfactuur als de offerte er een vraagt en de organisatie het automatisch wil.
   * Gooit nooit (een fout laat het akkoord staan).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} quoteId Id van de geaccordeerde offerte.
   * @returns {Promise<void>} Klaar zodra de factuur is gemaakt en verstuurd (of niets te doen was).
   */
  async function onAccepted(tenantId, quoteId) {
    try {
      if (!ctx.enabled(tenantId)) return;
      await create(tenantId, quoteId, { via: 'akkoord' });
    } catch (error) {
      console.warn(`Aanbetalingsfactuur bij akkoord op offerte ${quoteId} niet gemaakt: ${error.message}`);
    }
  }

  return { create, statusOf, onAccepted };
}

/**
 * Routes voor de aanbetaling op een offerte (recht `facturen`): de stand opvragen en de factuur met de hand maken.
 * @param {object} app De Express-app.
 * @param {object} ctx deposits (createDepositInvoices), requireRight, requireJson, tenantOf(req) en invoicesEnabled(tenantId) (staat de module Facturen aan).
 * @returns {void}
 */
function registerDepositRoutes(app, ctx) {
  const requireInvoices = ctx.requireRight('facturen');
  app.get('/api/quotes/:id/deposit-invoice', requireInvoices, (req, res) => {
    const status = ctx.deposits.statusOf(ctx.tenantOf(req), req.params.id);
    if (!status) return res.status(404).json({ error: 'not_found', message: 'Offerte niet gevonden.' });
    res.json(status);
  });
  app.post('/api/quotes/:id/deposit-invoice', ctx.requireJson, requireInvoices, async (req, res) => {
    if (!ctx.invoicesEnabled(ctx.tenantOf(req))) return res.status(409).json({ error: 'module_off', message: 'De module Facturen staat uit.' });
    const out = await ctx.deposits.create(ctx.tenantOf(req), req.params.id, { user: req.user, via: 'handmatig' });
    if (out.error === 'not_found') return res.status(404).json({ error: 'not_found', message: 'Offerte niet gevonden.' });
    if (out.error === 'not_accepted') return res.status(409).json({ error: 'not_accepted', message: 'De aanbetalingsfactuur kan pas na het akkoord op de offerte.' });
    if (out.error === 'no_deposit') return res.status(409).json({ error: 'no_deposit', message: 'Deze offerte vraagt geen aanbetaling.' });
    if (out.exists) return res.status(409).json({ error: 'exists', message: `Er is al een aanbetalingsfactuur (${out.invoice.number || 'concept'}).`, invoiceId: out.invoice.id });
    res.status(201).json({ invoice: out.invoice, sent: out.sent, sendError: out.sendError || null });
  });
}

module.exports = { createDepositInvoices, registerDepositRoutes };
