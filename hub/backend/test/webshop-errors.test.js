// Foutmeldingen in de webshop (betalen, facturen bij bestellingen): een storing van Mollie of een weigering bij het
// factureren komt leesbaar bij de beheerder, een onverwachte fout (database, programmeerfout) niet letterlijk maar als
// verwijzing naar het serverlog, met de oorzaak alleen in het log en de debugmodus (niet in de JSON van de uitkomst).
const test = require('node:test');
const assert = require('node:assert');
const { createMollie, MollieError } = require('../src/webshop/mollie');
const { createWebPayments } = require('../src/webshop/web-payments');
const { createWebOrderInvoices } = require('../src/verkoop/web-order-invoices');

/**
 * Een log dat de aanroepen onthoudt in plaats van ze te schrijven.
 * @returns {{ warn: Function, error: Function, lines: Array }} Het log.
 */
function quietLog() {
  const lines = [];
  return {
    lines,
    /**
     * Onthoudt een waarschuwing.
     * @param {...*} parts De delen.
     * @returns {void}
     */
    warn(...parts) { lines.push(['warn', ...parts]); },
    /**
     * Onthoudt een fout.
     * @param {...*} parts De delen.
     * @returns {void}
     */
    error(...parts) { lines.push(['error', ...parts]); },
  };
}

/**
 * Instellingen van een omgeving zoals settingsFor ze geeft.
 * @param {object} values Waarden per sleutel.
 * @returns {{ get: Function }} De instellingen.
 */
const settingsWith = (values) => ({ get: (key) => values[key] });

test('Mollie: niet bereikbaar en een weigering zonder tekst geven een leesbare melding, de oorzaak blijft bewaard', async () => {
  const down = createMollie({ fetchImpl: async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.mollie.com'); } });
  const unreachable = await down.createPayment('test_abc', { amount: 10, description: 'x', redirectUrl: 'https://shop.test/', webhookUrl: 'https://shop.test/w', metadata: {}, idempotencyKey: 'k' }).catch((error) => error);
  assert.ok(unreachable instanceof MollieError);
  assert.strictEqual(unreachable.message, 'Mollie is niet bereikbaar. Probeer het later opnieuw.');
  assert.match(unreachable.cause.message, /ENOTFOUND/);

  const slow = createMollie({ fetchImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); } });
  const timedOut = await slow.createPayment('test_abc', { amount: 10, description: 'x', redirectUrl: 'https://shop.test/', webhookUrl: 'https://shop.test/w', metadata: {}, idempotencyKey: 'k' }).catch((error) => error);
  assert.strictEqual(timedOut.message, 'Mollie antwoordt niet op tijd. Probeer het later opnieuw.');

  const broken = createMollie({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('geen json'); } }) });
  const refused = await broken.createPayment('test_abc', { amount: 10, description: 'x', redirectUrl: 'https://shop.test/', webhookUrl: 'https://shop.test/w', metadata: {}, idempotencyKey: 'k' }).catch((error) => error);
  assert.strictEqual(refused.message, 'Mollie weigert het verzoek: status 503');
  assert.strictEqual(refused.status, 503);
});

test('terugbetalen: een storing van Mollie staat in de melding, een fout in de app niet letterlijk', async () => {
  const order = { id: 'o1', number: 'W-1', payment: 'online', pay: { status: 'betaald', paidId: 'tr_abcd1234', refunds: [] }, totals: { total: 20 } };
  const settings = settingsWith({ shopPayment: { online: true, publicUrl: 'https://shop.test/' }, mollieApiKey: 'test_abcdefghijklmnopqrstuvwxyz0123' });
  /**
   * Terugbetalen met een Mollie-client die op de gegeven manier faalt.
   * @param {Error} failure De fout van createRefund.
   * @returns {Promise<{ out: object, log: object }>} De uitkomst en het log.
   */
  const refundWith = async (failure) => {
    const log = quietLog();
    const payments = createWebPayments({ orders: { get: () => order }, mollie: { createRefund: async () => { throw failure; } }, settingsFor: () => settings, log });
    return { out: await payments.refund('t1', 'o1', { amount: 20, description: 'Terugbetaling', key: 'annulering' }), log };
  };

  const mollieDown = await refundWith(new MollieError('Mollie is niet bereikbaar. Probeer het later opnieuw.'));
  assert.strictEqual(mollieDown.out.status, 502);
  assert.strictEqual(mollieDown.out.error, 'Terugbetalen via Mollie lukte niet: Mollie is niet bereikbaar. Probeer het later opnieuw.');
  assert.strictEqual(mollieDown.log.lines.length, 0);

  const bug = new TypeError("Cannot read properties of undefined (reading 'value')");
  const internal = await refundWith(bug);
  assert.strictEqual(internal.out.error, 'Terugbetalen via Mollie lukte niet: interne fout, de oorzaak staat in het serverlog');
  assert.strictEqual(internal.out.cause, bug, 'de oorzaak is er voor withCause');
  assert.ok(!JSON.stringify(internal.out).includes('Cannot read'), 'maar gaat niet mee als JSON');
  assert.strictEqual(internal.log.lines[0][0], 'error');
  assert.strictEqual(internal.log.lines[0][2], bug);
});

test('factuur bij een bestelling: een databasefout komt niet letterlijk bij de bestelling, een weigering wel', () => {
  const order = {
    id: 'o1', number: 'W-7', status: 'verzonden', payment: 'op rekening', pay: null, customer: { name: 'Els', email: 'els@voorbeeld.nl' },
    address: { street: 'Tuinstraat 1', postcode: '8071 AB', city: 'Nunspeet', country: 'NL' }, lines: [{ code: 'BUS', name: 'Sproeier', qty: 2, unitExcl: 10, vatRate: 21 }], totals: { total: 24.2 },
  };
  /**
   * Factureren met een factuuropslag die op de gegeven manier faalt.
   * @param {object} invoiceStore Wat de factuuropslag doet (create, finalize).
   * @returns {{ out: object, saved: object, log: object }} De uitkomst, wat bij de bestelling is opgeslagen en het log.
   */
  const ensureWith = (invoiceStore) => {
    const saved = {};
    const log = quietLog();
    const invoices = createWebOrderInvoices({
      orders: { get: () => order, updateData: (_tenant, _id, data) => Object.assign(saved, data) },
      invoices: { byShopOrders: () => new Map(), get: () => null, ...invoiceStore },
      settingsFor: () => settingsWith({ invoicing: { webOrders: { enabled: true, finalize: true } } }),
      log,
    });
    return { out: invoices.ensureInvoice('t1', 'o1', null), saved, log };
  };

  const databaseError = Object.assign(new Error('relation "aquatech.invoices" does not exist'), { code: '42P01' });
  const failed = ensureWith({ create: () => { throw databaseError; } });
  assert.strictEqual(failed.out.status, 500);
  assert.strictEqual(failed.out.error, 'Factuur maken mislukt: interne fout, de oorzaak staat in het serverlog');
  assert.strictEqual(failed.saved.invoiceError, 'interne fout, de oorzaak staat in het serverlog');
  assert.strictEqual(failed.out.cause, databaseError);
  assert.ok(!JSON.stringify(failed.out).includes('relation'), 'geen SQL-tekst in de uitkomst');
  assert.deepStrictEqual(failed.log.lines[0].slice(0, 1), ['error']);
  assert.strictEqual(failed.log.lines[0][2], databaseError);

  // Weigert de factuuropslag het definitief maken met een eigen melding, dan staat die gewoon bij de bestelling.
  const refused = ensureWith({ create: () => ({ id: 'f1' }), finalize: () => ({ error: 'De factuur heeft geen regels.' }) });
  assert.strictEqual(refused.out.error, 'Factuur maken mislukt: De factuur heeft geen regels.');
  assert.strictEqual(refused.saved.invoiceError, 'De factuur heeft geen regels.');
  assert.strictEqual(refused.log.lines.length, 0);
});
