// Aanbetaling op een offerte (V-10): bij akkoord gaat een aanbetalingsfactuur met betaallink weg, de eindfactuur trekt hem af,
// nooit dubbel, alleen met recht op facturen en alleen binnen de eigen organisatie.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createMailer } = require('../src/platform/mailer');
const QuoteCore = require('../../frontend/offertes/quote-core.js');
const InvoiceCore = require('../../frontend/facturen/invoice-core.js');
const { listen, createLogin } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';

/**
 * Offertegegevens: 1000 euro materiaal (21%) en 100 euro arbeid (9%), met aanbetaling en klant met e-mailadres.
 * @param {object} [overrides] Velden die de standaard overschrijven.
 * @returns {object} De offertedata.
 */
const quoteData = (overrides = {}) => ({
  title: 'Beregening', customer: { name: 'Fam. Jansen', email: 'jansen@klant.test' }, deposit: { on: true, type: 'pct', pct: 30 },
  lines: [{ id: 'r1', section: 'materiaal', description: 'Leidingwerk', qty: 1, unit: 'st', price: 1000, vat: 21 }, { id: 'r2', section: 'arbeid', description: 'Leggen', qty: 1, unit: 'uur', price: 100, vat: 9 }],
  ...overrides,
});

/**
 * Start de app met een beheerder, een installateur (heeft geen recht op facturen), een klant en een tweede organisatie.
 * @param {{ mailer?: boolean }} [options] mailer: een mailserver instellen die berichten bewaart in `sent`.
 * @returns {Promise<object>} server, as, sent en customerId.
 */
async function setup({ mailer = false } = {}) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  const sent = [];
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW }, { mustChangePassword: false });
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const customer = await store.createAccount(main, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW }, { mustChangePassword: false });
  /**
   * Maakt een nagebootste mailer die verstuurde berichten in `sent` bewaart.
   * @param {object} settings De mailinstellingen van de omgeving.
   * @returns {object} De mailer.
   */
  const mailerFor = (settings) => createMailer(settings, { resolveHost: async (host) => host, createTransport: () => ({ sendMail: async (message) => { sent.push(message); return {}; } }) });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1', APP_PUBLIC_URL: 'https://aquatech.example/' }, secret: 'd'.repeat(64), db, mailerFor, loginDelayMs: 0 }));
  const as = createLogin(base, { password: PW });
  if (mailer) {
    const baas = await as('baas');
    const saved = await baas.put('/app/api/admin/mail', { config: { mode: 'smtp', host: 'smtp.example.test', port: 587, user: '', from: 'info@aquatech.test' }, password: '' });
    assert.ok(saved.status < 300, `mail instellen: ${saved.status}`);
  }
  return { server, as, sent, customerId: customer.id || customer.user.id };
}

/**
 * Wacht tot er een aanbetalingsfactuur bij de offerte staat (de factuur wordt na het akkoord op de achtergrond gemaakt).
 * @param {object} client De ingelogde client.
 * @param {string} quoteId Id van de offerte.
 * @returns {Promise<object>} De stand van de aanbetaling.
 */
async function waitForDeposit(client, quoteId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = (await client.get(`/app/api/quotes/${quoteId}/deposit-invoice`)).body;
    if (status.invoice) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('geen aanbetalingsfactuur');
}

test('kern: aanbetaling als percentage of vast bedrag, verdeeld over de btw-tarieven', () => {
  const data = QuoteCore.sanitize(quoteData());
  const total = QuoteCore.totals(data).total;
  assert.strictEqual(total, 1319);
  const split = QuoteCore.depositSplit(data);
  assert.strictEqual(split.amount, 395.7);
  assert.strictEqual(split.rest, 923.3);
  assert.strictEqual(Math.round(split.groups.reduce((sum, group) => sum + group.gross, 0) * 100) / 100, 395.7, 'de delen tellen op tot de aanbetaling');
  assert.deepStrictEqual(split.groups.map((group) => group.rate), [21, 9]);
  assert.strictEqual(QuoteCore.depositOf({ deposit: { on: true, type: 'amount', amount: 5000 } }, 1319).amount, 1319, 'een vast bedrag is nooit hoger dan het totaal');
  assert.strictEqual(QuoteCore.depositOf({ deposit: { on: false, type: 'pct', pct: 30 } }, 1319).on, false);
  assert.strictEqual(QuoteCore.sanitizeDeposit({ on: true, type: 'pct', pct: 500 }).pct, 90);
  assert.strictEqual(QuoteCore.sanitize({}).deposit.on, false);
  // De factuur van de aanbetaling heeft precies dat bedrag, de eindfactuur het restant (ook met korting op de offerte).
  const quote = { id: 'q1', number: 'OF-1', data: QuoteCore.sanitize(quoteData({ discountType: 'pct', discountPct: 10 })) };
  const discounted = QuoteCore.depositSplit(quote.data);
  const deposit = InvoiceCore.fromQuoteDeposit(quote, discounted);
  assert.ok(Math.abs(InvoiceCore.totals(deposit.data).total - discounted.amount) <= 0.02);
  assert.strictEqual(InvoiceCore.sanitize({ lines: [] }).deposit, undefined, 'een gewone factuur draagt geen aanbetalingskenmerk');
  const final = InvoiceCore.fromWorkOrder({ number: 'WO-1', data: {} }, { quote, deposits: [{ number: 'F1', amount: discounted.amount, lines: discounted.groups.map((group) => ({ rate: group.rate, net: group.net })) }] });
  assert.ok(Math.abs(InvoiceCore.totals(final.data).total - discounted.rest) <= 0.02, 'eindfactuur = restant');
});

test('akkoord zet een definitieve aanbetalingsfactuur klaar, met de mail en betaallink; nooit een tweede', async () => {
  const { server, as, sent, customerId } = await setup({ mailer: true });
  try {
    const baas = await as('baas');
    const quote = (await baas.post('/app/api/quotes', { data: quoteData(), customerId })).body;
    assert.strictEqual(quote.data.deposit.on, true);
    assert.strictEqual((await baas.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' })).status, 200);
    const status = await waitForDeposit(baas, quote.id);
    assert.deepStrictEqual([status.deposit.amount, status.deposit.rest], [395.7, 923.3]);
    assert.strictEqual(status.invoice.status, 'definitief');
    assert.ok(Math.abs(status.invoice.total - 395.7) <= 0.02);
    assert.ok(status.invoice.sentAt, 'verstuurd');
    assert.strictEqual(sent.length >= 1, true, 'er is een mail met de factuur');
    // Opnieuw akkoord of met de hand maken geeft geen tweede factuur.
    await baas.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' });
    assert.strictEqual((await baas.post(`/app/api/quotes/${quote.id}/deposit-invoice`, {})).status, 409);
    const invoices = (await baas.get('/app/api/invoices')).body.items;
    assert.strictEqual(invoices.filter((invoice) => invoice.quoteId === quote.id).length, 1);
  } finally { server.close(); }
});

test('zonder mailserver blijft de factuur definitief en onverstuurd, met een taak; de eindfactuur trekt hem af', async () => {
  const { server, as, customerId } = await setup();
  try {
    const baas = await as('baas');
    const quote = (await baas.post('/app/api/quotes', { data: quoteData(), customerId })).body;
    await baas.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' });
    const status = await waitForDeposit(baas, quote.id);
    assert.strictEqual(status.invoice.status, 'definitief');
    assert.strictEqual(status.invoice.sentAt, null);
    const task = (await baas.get('/app/api/tasks')).body.tasks.find((entry) => entry.key === 'aanbetaling-versturen');
    assert.deepStrictEqual([task.count, task.items.length], [1, 1]);
    // De werkorder is automatisch aangemaakt; de eindfactuur daaruit trekt de aanbetaling af.
    const order = (await baas.get('/app/api/workorders')).body.items[0];
    const final = await baas.post('/app/api/invoices', { workOrderId: order.id });
    assert.strictEqual(final.status, 201);
    assert.ok(Math.abs(final.body.total - 923.3) <= 0.02, `eindfactuur ${final.body.total}`);
    assert.ok(final.body.data.lines.some((line) => line.deposit === true && line.price < 0), 'negatieve regel');
    assert.match(final.body.data.notes, /aanbetaling/i);
    // Het kenmerk kan niet via de gewone factuur-API gezet worden, en blijft bij opslaan staan.
    const forged = await baas.post('/app/api/invoices', { data: { customer: { name: 'X' }, deposit: { quoteId: quote.id, quoteNumber: 'Q', amount: 5 }, lines: [] } });
    assert.strictEqual(forged.status, 201);
    assert.strictEqual(forged.body.data.deposit, undefined, 'create negeert het kenmerk');
    const stored = (await baas.get(`/app/api/invoices/${status.invoice.id}`)).body;
    assert.ok(stored.data.deposit, 'de aanbetalingsfactuur heeft het kenmerk');
    // Een aanbetaling die al verstuurd is geeft geen taak meer.
    assert.strictEqual(typeof task.items[0].href, 'string');
  } finally { server.close(); }
});

test('een offerte zonder aanbetaling, uitgezet in Beheer of een andere organisatie: geen factuur, geen toegang', async () => {
  const { server, as, customerId } = await setup();
  try {
    const baas = await as('baas'), kees = await as('kees'), klaas = await as('klaas'), vreemd = await as('vreemd', 'ander');
    const plain = (await baas.post('/app/api/quotes', { data: quoteData({ deposit: { on: false } }), customerId })).body;
    await baas.put(`/app/api/quotes/${plain.id}`, { status: 'akkoord' });
    assert.strictEqual((await baas.post(`/app/api/quotes/${plain.id}/deposit-invoice`, {})).status, 409);
    assert.strictEqual((await baas.get('/app/api/invoices')).body.items.length, 0);
    // Uit: geen automatische factuur, met de hand lukt het wel.
    assert.strictEqual((await baas.put('/app/api/admin/modules', { flags: { 'aanbetaling-automatisch': false } })).status, 200);
    const manual = (await baas.post('/app/api/quotes', { data: quoteData(), customerId })).body;
    await baas.put(`/app/api/quotes/${manual.id}`, { status: 'akkoord' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.strictEqual((await baas.get(`/app/api/quotes/${manual.id}/deposit-invoice`)).body.invoice, null);
    assert.strictEqual((await baas.post(`/app/api/quotes/${manual.id}/deposit-invoice`, {})).status, 201);
    // Rechten en organisaties.
    assert.strictEqual((await kees.get(`/app/api/quotes/${manual.id}/deposit-invoice`)).status, 403, 'geen recht op facturen');
    assert.strictEqual((await klaas.post(`/app/api/quotes/${manual.id}/deposit-invoice`, {})).status, 403);
    assert.strictEqual((await vreemd.get(`/app/api/quotes/${manual.id}/deposit-invoice`)).status, 404);
    assert.strictEqual((await vreemd.post(`/app/api/quotes/${manual.id}/deposit-invoice`, {})).status, 404);
  } finally { server.close(); }
});
