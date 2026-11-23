// Online betalen van een factuur door de klant (Mollie), vanuit het klantportaal. De Mollie-sleutel en het webadres komen uit dezelfde
// instellingen als de webshop (webshop/mollie.js configOf). Een betaling is een rij in invoice_payments; de uitkomst komt altijd uit een
// opvraging bij Mollie zelf (webhook of terugkeer van de klant), nooit uit wat de browser zegt. De overgang naar betaald gebeurt één keer
// (voorwaardelijke update) en zet dan de factuur op betaald (invoices.setPaid, dus ook zichtbaar in de debiteuren), en roept de haken van onPaid aan.
const crypto = require('crypto');
const { configOf, validPaymentId, MollieError } = require('../webshop/mollie');
const { linkExpired } = require('../platform/public-links');

/** Hoe de Mollie-status bij ons heet: betaald, nog open of mislukt. */
const MOLLIE_STATES = { paid: 'betaald', open: 'open', pending: 'open', authorized: 'open', canceled: 'mislukt', expired: 'mislukt', failed: 'mislukt' };

/**
 * Maakt de betaalfuncties voor facturen.
 * @param {{ db: object, invoices: object, mollie: object, settingsFor: Function, linkKey?: Buffer, log?: object }} deps De database, de factuuropslag, de Mollie-client, de instellingen per omgeving en de sleutel voor de betaallinks (zonder sleutel geen links).
 * @returns {{ enabled: Function, payableState: Function, start: Function, sync: Function, onPaid: Function, listOwn: Function, own: Function, paymentsOf: Function, linkFor: Function, publicLinkCheck: Function, appUrl: Function }} De functies.
 */
function createInvoicePayments({ db, invoices, mollie, settingsFor, linkKey = null, log = console }) {
  const paidHooks = [];
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * Rondt een bedrag af op centen.
   * @param {*} value Het bedrag.
   * @returns {number} Het afgeronde bedrag.
   */
  const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

  /**
   * Registreert een haak die één keer wordt aangeroepen als een factuur via Mollie betaald is.
   * @param {Function} hook Functie (tenantId, invoice); fouten worden alleen gelogd.
   * @returns {void}
   */
  const onPaid = (hook) => { paidHooks.push(hook); };

  /**
   * Of online betalen van facturen kan in deze omgeving (aan, sleutel en webadres kloppen).
   * @param {string} tenantId Id van de omgeving.
   * @returns {boolean} true als klanten kunnen betalen.
   */
  const enabled = (tenantId) => configOf(settingsFor(tenantId)).online;

  /**
   * Of deze factuur nog betaald kan worden: een definitieve, openstaande factuur (geen credit, geen bedrag van nul of lager,
   * niet gecrediteerd: dan hoeft de klant niets meer te betalen).
   * @param {object} invoice De factuur (toInvoice).
   * @returns {boolean} true als hij betaald mag worden.
   */
  const payable = (invoice) => invoice.kind === 'factuur' && invoice.status === 'definitief' && invoice.total > 0 && !invoice.creditedAt;

  /**
   * De betaalstand voor het portaal: of de klant nu kan betalen.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} invoice De factuur.
   * @returns {boolean} true als er een knop Nu betalen mag staan.
   */
  const payableState = (tenantId, invoice) => payable(invoice) && enabled(tenantId);

  /**
   * De facturen van een klant die hij in het portaal ziet: definitieve en betaalde facturen (geen concepten en geen creditfacturen).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} customerId Id van de klant.
   * @returns {object[]} De facturen (id, nummer, datum, vervaldatum, totaal, status, te laat, betaald op, payable).
   */
  function listOwn(tenantId, customerId) {
    const online = enabled(tenantId);
    return invoices.list(tenantId, { customerId: String(customerId), kinds: ['factuur'], statuses: ['definitief', 'betaald'] }).map((invoice) => ({
      id: invoice.id, number: invoice.number, date: invoice.date, dueDate: invoice.dueDate, total: invoice.total, status: invoice.status,
      overdue: invoice.overdue, paidAt: invoice.paidAt, credited: Boolean(invoice.creditedAt), payable: online && payable(invoice),
    }));
  }

  /**
   * Eén factuur van deze klant (met inhoud voor de PDF), of null als hij niet van hem is of nog een concept is.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} customerId Id van de klant.
   * @param {string} invoiceId Id van de factuur.
   * @returns {object|null} De factuur.
   */
  function own(tenantId, customerId, invoiceId) {
    const invoice = invoices.get(tenantId, invoiceId);
    if (!invoice || invoice.customerId !== String(customerId) || invoice.kind !== 'factuur' || invoice.status === 'concept') return null;
    return invoice;
  }

  /**
   * De betaalpogingen van een factuur, oudste eerst.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} invoiceId Id van de factuur.
   * @returns {object[]} De pogingen (id, mollieId, status, amount, checkoutUrl, method, createdAt, paidAt).
   */
  function paymentsOf(tenantId, invoiceId) {
    return prepare('SELECT id, mollie_id, status, amount, checkout_url, method, created_at, paid_at FROM invoice_payments WHERE tenant_id = ? AND invoice_id = ? ORDER BY created_at, id')
      .all(tenantId, String(invoiceId))
      .map((row) => ({ id: row.id, mollieId: row.mollie_id, status: row.status, amount: Number(row.amount), checkoutUrl: row.checkout_url, method: row.method, createdAt: row.created_at, paidAt: row.paid_at || null }));
  }

  /**
   * Verwerkt de stand van een Mollie-betaling. Betaald telt één keer: de rij gaat van open/mislukt naar betaald en de factuur wordt betaald gezet.
   * Mislukt telt alleen voor een rij die nog open is. Een betaling voor een factuur die intussen op een andere manier betaald is, blijft staan als betaald.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} invoice De factuur.
   * @param {object} payment De betaling zoals Mollie hem geeft.
   * @returns {{ becamePaid: boolean, status: string }} Of deze aanroep de factuur betaald maakte, en de stand.
   */
  function apply(tenantId, invoice, payment) {
    const state = MOLLIE_STATES[payment.status] || 'open';
    if (state === 'betaald') {
      const paidAt = payment.paidAt || new Date().toISOString();
      prepare("UPDATE invoice_payments SET status = 'betaald', paid_at = ?, method = ? WHERE tenant_id = ? AND mollie_id = ? AND status <> 'betaald'")
        .run(paidAt, payment.method || '', tenantId, payment.id);
      // Ook als de rij al betaald was: staat de factuur nog open (een eerdere verwerking viel halverwege weg), dan herstelt deze aanroep dat.
      // De controle op de status en setPaid draaien synchroon achter elkaar (geen await ertussen), dus gelijktijdige aanroepen maken de factuur maar één keer betaald.
      let becamePaid = false;
      const current = invoices.get(tenantId, invoice.id);
      if (current && current.status === 'definitief') {
        const out = invoices.setPaid(tenantId, invoice.id, true, paidAt.slice(0, 10));
        becamePaid = Boolean(out && out.invoice);
      }
      if (becamePaid) runPaidHooks(tenantId, invoices.get(tenantId, invoice.id), payment);
      return { becamePaid, status: 'betaald' };
    }
    if (state === 'mislukt') prepare("UPDATE invoice_payments SET status = 'mislukt' WHERE tenant_id = ? AND mollie_id = ? AND status = 'open'").run(tenantId, payment.id);
    return { becamePaid: false, status: state };
  }

  /**
   * Start de haken na een betaling; een fout in een haak houdt de rest niet tegen.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} invoice De betaalde factuur.
   * @param {object} payment De betaling.
   * @returns {void}
   */
  function runPaidHooks(tenantId, invoice, payment) {
    for (const hook of paidHooks) {
      try { Promise.resolve(hook(tenantId, invoice, payment)).catch((error) => log.warn(`Na betalen van factuur ${invoice.number}: ${error.message}`)); } catch (error) { log.warn(`Na betalen van factuur ${invoice.number}: ${error.message}`); }
    }
  }

  /**
   * Vraagt een betaling bij Mollie op en verwerkt hem. De betaling moet bij de factuur horen (metadata, id in onze tabel en bedrag), anders gebeurt er niets.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} invoiceId Id van de factuur.
   * @param {{ paymentId?: string }} [options] De te controleren betaling (webhook); zonder de laatst gestarte.
   * @returns {Promise<{ becamePaid: boolean, status?: string, ignored?: boolean }>} De uitkomst. Een fout van Mollie wordt doorgegeven.
   */
  async function sync(tenantId, invoiceId, { paymentId } = {}) {
    const invoice = invoices.get(tenantId, invoiceId);
    if (!invoice) return { becamePaid: false, ignored: true };
    const attempts = paymentsOf(tenantId, invoice.id);
    const id = paymentId || (attempts.length ? attempts[attempts.length - 1].mollieId : '');
    if (!id || !validPaymentId(id) || !attempts.some((attempt) => attempt.mollieId === id)) return { becamePaid: false, ignored: true };
    const config = configOf(settingsFor(tenantId));
    if (!config.apiKey) return { becamePaid: false, ignored: true };
    const payment = await mollie.getPayment(config.apiKey, id);
    if (payment.invoiceId !== invoice.id || Math.abs(payment.amount - invoice.total) > 0.005) {
      log.warn(`Betaling ${id} hoort niet bij factuur ${invoice.number}; genegeerd.`);
      return { becamePaid: false, ignored: true };
    }
    return apply(tenantId, invoice, payment);
  }

  /**
   * Zorgt dat de klant een betaalpagina heeft voor een factuur: de lopende betaling als die nog open is, anders een nieuwe.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} invoice De factuur (van de klant, al gecontroleerd).
   * @param {{ returnUrl?: string }} [options] Waar de klant na het betalen heen gaat (standaard het portaal).
   * @returns {Promise<{ checkoutUrl?: string, paid?: boolean, error?: string, status?: number }>} De betaalpagina, of paid als hij al betaald bleek, of een melding.
   */
  async function start(tenantId, invoice, { returnUrl = '' } = {}) {
    const config = configOf(settingsFor(tenantId));
    if (!config.online) return { error: 'Online betalen staat niet aan.', status: 409 };
    if (invoice.status === 'betaald') return { paid: true };
    if (invoice.creditedAt) return { error: 'Deze factuur is gecrediteerd en hoeft niet meer betaald te worden.', status: 409 };
    if (!payable(invoice)) return { error: 'Deze factuur kan niet online betaald worden.', status: 409 };
    try {
      const attempts = paymentsOf(tenantId, invoice.id);
      const last = attempts[attempts.length - 1];
      // Ook een rij die al betaald is maar waarvan de factuur nog openstaat (verwerking viel halverwege weg): eerst herstellen, nooit een tweede betaling maken.
      if (last && (last.status === 'open' || last.status === 'betaald') && last.checkoutUrl) {
        const current = await mollie.getPayment(config.apiKey, last.mollieId);
        const state = MOLLIE_STATES[current.status];
        if (state === 'betaald') {
          if (current.invoiceId !== invoice.id || Math.abs(current.amount - invoice.total) > 0.005) return { error: 'De betaling hoort niet bij deze factuur.', status: 409 };
          apply(tenantId, invoice, current);
          return { paid: true };
        }
        if (state === 'open') return { checkoutUrl: last.checkoutUrl };
        apply(tenantId, invoice, current);
      }
      const base = config.publicUrl;
      const created = await mollie.createPayment(config.apiKey, {
        amount: invoice.total, description: `Factuur ${invoice.number}`, idempotencyKey: `factuur:${invoice.id}:${attempts.length + 1}`,
        redirectUrl: returnUrl || `${base}app/portaal/?betaald=${encodeURIComponent(invoice.id)}`,
        webhookUrl: `${base}app/api/public/invoice-payment/${encodeURIComponent(invoice.id)}/webhook`,
        metadata: { invoiceId: invoice.id, number: invoice.number },
      });
      try {
        prepare('INSERT INTO invoice_payments (id, tenant_id, invoice_id, mollie_id, status, amount, checkout_url, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), tenantId, invoice.id, created.id, 'open', round2(invoice.total), created.checkoutUrl, created.mode, new Date().toISOString());
      } catch (insertError) {
        // Gelijktijdige tweede klik: dezelfde idempotentiesleutel gaf dezelfde betaling terug en de eerste aanroep legde hem al vast.
        if (!paymentsOf(tenantId, invoice.id).some((attempt) => attempt.mollieId === created.id)) throw insertError;
      }
      return { checkoutUrl: created.checkoutUrl };
    } catch (error) {
      log.warn(`Betaling starten voor factuur ${invoice.number} mislukt:`, error instanceof MollieError ? error.message : error, ...(error instanceof MollieError && error.cause ? [error.cause] : []));
      return { error: 'De betaalpagina is nu niet bereikbaar. Probeer het zo opnieuw.', status: 502 };
    }
  }

  /**
   * De handtekening van een betaallink: HMAC over omgeving en factuur-id, zodat de link niet te raden is en niets hoeft te worden bewaard.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} invoiceId Id van de factuur.
   * @returns {string} 32 tekens (base64url).
   */
  const signatureOf = (tenantId, invoiceId) => crypto.createHmac('sha256', linkKey).update(`${tenantId}:${invoiceId}`).digest('base64url').slice(0, 32);

  /**
   * Een adres in de app volgens het webadres uit Beheer.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} appPath Pad na `app/`, zonder slash vooraan.
   * @returns {string} Het volledige adres.
   */
  const appUrl = (tenantId, appPath) => `${configOf(settingsFor(tenantId)).publicUrl}app/${appPath}`;

  /**
   * De persoonlijke betaallink voor in de factuurmail, alleen voor een factuur die nu online betaald kan worden en met het webadres uit Beheer.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} invoice De factuur.
   * @returns {string} Het adres, of een lege tekst als er geen link kan zijn.
   */
  function linkFor(tenantId, invoice) {
    if (!linkKey || !payableState(tenantId, invoice)) return '';
    return appUrl(tenantId, `api/public/invoice-pay/${encodeURIComponent(invoice.id)}/${signatureOf(tenantId, invoice.id)}`);
  }

  /**
   * Controleert een betaallink uit een mail en geeft de factuur terug.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} invoiceId Id van de factuur uit het adres.
   * @param {string} signature De handtekening uit het adres.
   * @returns {{ invoice?: object, error?: 'invalid'|'expired' }} De factuur, of waarom de link niet werkt.
   */
  function publicLinkCheck(tenantId, invoiceId, signature) {
    if (!linkKey) return { error: 'invalid' };
    const expected = Buffer.from(signatureOf(tenantId, String(invoiceId)));
    const given = Buffer.from(String(signature));
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { error: 'invalid' };
    const invoice = invoices.get(tenantId, String(invoiceId));
    if (!invoice || invoice.kind !== 'factuur' || invoice.status === 'concept') return { error: 'invalid' };
    if (linkExpired({ sharedAt: invoice.finalizedAt, referenceDate: invoice.dueDate })) return { error: 'expired' };
    return { invoice };
  }

  return { enabled, payableState, start, sync, onPaid, listOwn, own, paymentsOf, linkFor, publicLinkCheck, appUrl };
}

module.exports = { createInvoicePayments };
