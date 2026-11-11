// Kortingsregel op offerte en factuur: percentage óf vast bedrag, met bijschrift; kern, rekenen over btw-tarieven,
// creditfactuur, overname offerte -> factuur, nacalculatie, Visma en de API (bewaren, klantweergave).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, listen } = require('./helpers/http-client');
const { createPdokFake } = require('./helpers/pdok-fake');
const { invoiceBody, sanitizeVisma } = require('../src/verkoop/visma');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const QuoteCore = require(path.join(FRONTEND, 'offertes', 'quote-core.js'));
const InvoiceCore = require(path.join(FRONTEND, 'facturen', 'invoice-core.js'));
const CostingCore = require(path.join(FRONTEND, 'werkorders', 'costing-core.js'));
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

const LINES = [
  { id: 'a', section: 'materiaal', description: 'Sproeier', qty: 2, unit: 'st', price: 100, vat: 21 },
  { id: 'b', section: 'arbeid', description: 'Montage', qty: 1, unit: 'uur', price: 50, vat: 9 },
];

test('offerte: korting als percentage of als vast bedrag, beide met bijschrift', () => {
  const pct = QuoteCore.totals({ lines: LINES, discountPct: 10, discountNote: 'actie' });
  assert.deepStrictEqual([pct.discountType, pct.discount, pct.net, pct.total, pct.discountNote], ['pct', 25, 225, 266.85, 'actie']);
  const amount = QuoteCore.totals({ lines: LINES, discountType: 'amount', discountAmount: 25, discountNote: 'actie' });
  assert.deepStrictEqual([amount.discountType, amount.discount, amount.discountAmount, amount.net, amount.total], ['amount', 25, 25, 225, 266.85], 'zelfde uitkomst als 10%');
  assert.deepStrictEqual(amount.vat.map((entry) => [entry.rate, entry.base]), [[21, 180], [9, 45]], 'naar rato over de btw-tarieven');
  // Een bedrag hoger dan het subtotaal wordt het subtotaal; negatief of onzin telt als geen korting.
  const capped = QuoteCore.totals({ lines: LINES, discountType: 'amount', discountAmount: 9999 });
  assert.deepStrictEqual([capped.discount, capped.net, capped.total], [250, 0, 0]);
  assert.strictEqual(QuoteCore.totals({ lines: LINES, discountType: 'amount', discountAmount: -5 }).discount, 0);
  assert.strictEqual(QuoteCore.totals({ lines: [], discountType: 'amount', discountAmount: 5 }).discount, 0, 'lege offerte');
  // Zonder soort of met onbekende soort blijft het een percentage (oude offertes).
  assert.strictEqual(QuoteCore.totals({ lines: LINES, discountPct: 10, discountType: 'iets' }).discount, 25);
});

test('offerte: opschonen houdt precies één soort korting over', () => {
  const amount = QuoteCore.sanitize({ discountType: 'amount', discountPct: 50, discountAmount: '12,5x', discountNote: 'x'.repeat(300) });
  assert.deepStrictEqual([amount.discountType, amount.discountPct, amount.discountAmount, amount.discountNote.length], ['amount', 0, 0, 120], 'onleesbaar bedrag wordt 0');
  const clean = QuoteCore.sanitize({ discountType: 'amount', discountAmount: 12.345 });
  assert.strictEqual(clean.discountAmount, 12.35);
  const pct = QuoteCore.sanitize({ discountPct: 150, discountAmount: 40 });
  assert.deepStrictEqual([pct.discountType, pct.discountPct, pct.discountAmount], ['pct', 100, 0]);
  assert.strictEqual(QuoteCore.sanitize({ discountType: 'amount', discountAmount: 1e12 }).discountAmount, 10000000);
});

test('bijschrift: percentage alleen bij een percentage', () => {
  const pct = QuoteCore.totals({ lines: LINES, discountPct: 5, discountNote: 'seizoen' });
  assert.strictEqual(QuoteCore.discountCaption(pct, 'Korting', '5'), 'Korting 5% – seizoen');
  const amount = QuoteCore.totals({ lines: LINES, discountType: 'amount', discountAmount: 5 });
  assert.strictEqual(QuoteCore.discountCaption(amount, 'Korting', '2'), 'Korting');
});

test('factuur: vast bedrag, creditfactuur en overname uit de offerte', () => {
  const lines = LINES.map((line) => ({ ...line, price: line.price }));
  const data = InvoiceCore.sanitize({ lines, discountType: 'amount', discountAmount: 25, discountNote: 'actie' });
  assert.deepStrictEqual([data.discountType, data.discountAmount, data.discountNote], ['amount', 25, 'actie']);
  const invoiceTotals = InvoiceCore.totals(data);
  assert.deepStrictEqual([invoiceTotals.discount, invoiceTotals.net, invoiceTotals.total], [25, 225, 266.85]);
  assert.strictEqual(InvoiceCore.discountCaption(invoiceTotals, 'Korting', '10'), 'Korting – actie');
  // Credit: negatieve regels, het bedrag blijft staan maar werkt negatief mee.
  const credit = InvoiceCore.totals(InvoiceCore.creditOf({ number: 'F-1', data }));
  assert.deepStrictEqual([credit.subtotal, credit.discount, credit.net, credit.total], [-250, -25, -225, -266.85]);
  // Uit de offerte op de factuur.
  const built = InvoiceCore.fromWorkOrder({ number: 'WO-1', data: { customer: { name: 'Jansen' } } }, {
    quote: { number: 'OF-1', data: { discountType: 'amount', discountAmount: 25, discountNote: 'actie', lines: LINES } },
  });
  assert.deepStrictEqual([built.data.discountType, built.data.discountAmount, built.data.discountNote], ['amount', 25, 'actie']);
  assert.strictEqual(InvoiceCore.totals(built.data).discount, 25);
  const plain = InvoiceCore.fromWorkOrder({ number: 'WO-2', data: {} }, { quote: { number: 'OF-2', data: { discountPct: 10, lines: LINES } } });
  assert.deepStrictEqual([plain.data.discountType, plain.data.discountPct], ['pct', 10]);
});

test('nacalculatie: een vast bedrag geldt in zijn geheel, een percentage schaalt mee', () => {
  const base = { workOrder: { number: 'WO-1', data: {} }, logged: { hours: [], materials: [] }, articles: {}, invoices: [], hourlyRate: 50, hourlyCost: 30 };
  const fixed = CostingCore.compute({ ...base, quote: { number: 'OF-1', data: { lines: LINES, discountType: 'amount', discountAmount: 25, discountNote: 'actie' } } });
  assert.deepStrictEqual([fixed.hasDiscount, fixed.discountAmount, fixed.discountNote, fixed.budget.discount, fixed.budget.net], [true, 25, 'actie', 25, 225]);
  const percent = CostingCore.compute({ ...base, quote: { number: 'OF-1', data: { lines: LINES, discountPct: 10 } } });
  assert.deepStrictEqual([percent.hasDiscount, percent.budget.discount], [true, 25]);
  assert.strictEqual(CostingCore.compute({ ...base, quote: { number: 'OF-1', data: { lines: LINES } } }).hasDiscount, false);
});

test('visma: de korting gaat als fractie per regel mee, ook bij een vast bedrag', () => {
  const conf = sanitizeVisma({ articles: { 'producten:21': '11111111-1111-1111-1111-111111111111' } });
  /**
   * Een factuur met twee regels en de opgegeven kortingsvelden.
   * @param {object} extra Kortingsvelden (discountType, discountPct, discountAmount).
   * @returns {object} De factuur voor invoiceBody.
   */
  const make = (extra) => ({ number: 'F-1', kind: 'factuur', data: { date: '2026-10-21', dueDate: '2026-11-04', customer: { name: 'Jan', address: 'Tuinstraat 1\n8071 AB Nunspeet' },
    lines: [{ description: 'Sproeier', code: 'SPR', qty: 2, price: 100, vat: 21, group: 'producten' }, { description: 'Buis', code: 'BUI', qty: 1, price: 50, vat: 21, group: 'producten' }], ...extra } });
  assert.strictEqual(invoiceBody(make({ discountType: 'amount', discountAmount: 25 }), 'c1', conf, null).body.Rows[1].DiscountPercentage, 0.1);
  assert.strictEqual(invoiceBody(make({ discountPct: 10 }), 'c1', conf, null).body.Rows[1].DiscountPercentage, 0.1);
  assert.strictEqual(invoiceBody(make({}), 'c1', conf, null).body.Rows[1].DiscountPercentage, 0);
  // Een niet-ronde fractie (10 over 30,03 in drie regels): de som van de regels na korting blijft binnen 1 cent per regel
  // van het factuurtotaal (Visma rondt zelf per regel af, ook bij een percentage).
  const odd = make({ discountType: 'amount', discountAmount: 10, lines: [
    { description: 'A', qty: 1, price: 10.01, vat: 21, group: 'producten' }, { description: 'B', qty: 1, price: 10.01, vat: 21, group: 'producten' }, { description: 'C', qty: 1, price: 10.01, vat: 21, group: 'producten' }] });
  const rows = invoiceBody(odd, 'c1', conf, null).body.Rows.filter((row) => !row.IsTextRow);
  const viaVisma = rows.reduce((sum, row) => sum + Math.round(row.UnitPrice * row.Quantity * (1 - row.DiscountPercentage) * 100) / 100, 0);
  const expected = InvoiceCore.totals(odd.data).net;
  assert.ok(Math.abs(viaVisma - expected) <= 0.03, `Visma ${viaVisma} tegenover factuur ${expected}`);
});

test('api: de korting wordt bewaard en de klant ziet bedrag en bijschrift', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ secret: 'f'.repeat(64), db, addressFetch: createPdokFake().fetchImpl, loginDelayMs: 0 }));
  servers.push(server);
  const installer = await createLogin(base, { password: PW })('monteur');
  const data = { title: 'Beregening', customer: { name: 'Fam. Jansen' }, discountType: 'amount', discountAmount: 25, discountNote: 'Seizoensactie',
    lines: LINES.map((line) => ({ ...line })) };
  const quote = (await installer.post('/app/api/quotes', { data })).body;
  assert.deepStrictEqual([quote.data.discountType, quote.data.discountAmount, quote.data.discountNote], ['amount', 25, 'Seizoensactie']);
  const saved = (await installer.put(`/app/api/quotes/${quote.id}`, { data: { ...quote.data, discountAmount: 30 } })).body;
  assert.strictEqual(saved.data.discountAmount, 30);
  assert.strictEqual(QuoteCore.totals((await installer.get(`/app/api/quotes/${quote.id}`)).body.data).discount, 30);
  // Via de openbare link ziet de klant het bedrag, het bijschrift en de totalen.
  const token = (await installer.post(`/app/api/quotes/${quote.id}/share`, { url: 'https://aquatech.example/pad/openbaar/offerte.html' })).body.share.url.split('#t=')[1];
  const publicQuote = (await (await fetch(`${base}/app/api/public/quote`, { headers: { 'X-Offerte-Token': token } })).json()).quote;
  assert.deepStrictEqual([publicQuote.data.discountNote, publicQuote.totals.discount, publicQuote.totals.discountType], ['Seizoensactie', 30, 'amount']);
});
