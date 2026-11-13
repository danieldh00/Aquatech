// Rekenkern van de automatische bestelvoorstellen (frontend/artikelen/proposals-core.js): herkennen, totalen en meldingen.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { FRONTEND_DIR } = require('../src/paths');

const Core = require(path.join(FRONTEND_DIR, 'artikelen', 'proposals-core.js'));

/**
 * Een antwoord zoals GET /api/purchase-orders/proposals dat geeft.
 * @returns {object} Twee voorstellen (Zeta met een regel zonder prijs, Alfa met twee regels) en één afgewezen artikel.
 */
function sampleResult() {
  return {
    enabled: true, withoutSupplier: 2,
    orders: [
      { id: 'o-2', number: 'IO2026-0002', status: 'concept', origin: 'voorstel', supplierName: 'Zeta', lines: [
        { itemId: 'i-3', code: 'C', name: 'Koppeling', unit: 'stuks', qty: 3, unitCost: null, amount: null },
        { itemId: 'i-4', code: 'D', name: 'Slang', unit: 'm', qty: 10, unitCost: 0.1, amount: 1 },
      ] },
      { id: 'o-1', number: 'IO2026-0001', status: 'concept', origin: 'voorstel', supplierName: 'Alfa', lines: [
        { itemId: 'i-1', code: 'A', name: 'Bocht', unit: 'stuks', qty: 3, unitCost: 0.1 },
        { itemId: 'i-2', code: 'B', name: 'Kraan', unit: 'stuks', qty: 1, unitCost: 0.2, amount: 0.2 },
      ] },
    ],
    dismissed: [{ itemId: 'i-9', code: 'Z', name: 'Zeef', dismissedAt: '2026-11-01T10:00:00Z' }, { itemId: 'i-8', code: 'Y', name: 'Afsluiter' }],
  };
}

test('isProposal: alleen een concept met herkomst voorstel', () => {
  assert.strictEqual(Core.isProposal({ status: 'concept', origin: 'voorstel' }), true);
  assert.strictEqual(Core.isProposal({ status: 'besteld', origin: 'voorstel' }), false);
  assert.strictEqual(Core.isProposal({ status: 'concept', origin: 'handmatig' }), false);
  assert.strictEqual(Core.isProposal({ status: 'concept' }), false);
  assert.strictEqual(Core.isProposal(null), false);
});

test('lineAmount: bedrag van de server, anders aantal × prijs zonder afrondingsrest, zonder prijs null', () => {
  assert.strictEqual(Core.lineAmount({ qty: 3, unitCost: 0.1 }), 0.3);
  assert.strictEqual(Core.lineAmount({ qty: 3, unitCost: 0.1, amount: 0.31 }), 0.31);
  assert.strictEqual(Core.lineAmount({ qty: 3, unitCost: null, amount: null }), null);
  assert.strictEqual(Core.lineAmount({ qty: 3, unitCost: '' }), null);
});

test('orderSummary: telt regels, totaal en regels zonder prijs', () => {
  assert.deepStrictEqual(Core.orderSummary(sampleResult().orders[0]), { lineCount: 2, total: 1, unpriced: 1 });
  assert.deepStrictEqual(Core.orderSummary({ lines: [{ qty: 1, unitCost: null }] }), { lineCount: 1, total: null, unpriced: 1 });
  assert.deepStrictEqual(Core.orderSummary({}), { lineCount: 0, total: null, unpriced: 0 });
});

test('overview: op leveranciersnaam, totalen over alles, afgewezen op naam', () => {
  const summary = Core.overview(sampleResult());
  assert.deepStrictEqual(summary.orders.map((order) => order.supplierName), ['Alfa', 'Zeta']);
  assert.strictEqual(summary.count, 2);
  assert.strictEqual(summary.lineCount, 4);
  assert.strictEqual(summary.total, 1.5);
  assert.strictEqual(summary.unpriced, 1);
  assert.deepStrictEqual(summary.orders[0].summary, { lineCount: 2, total: 0.5, unpriced: 0 });
  assert.deepStrictEqual(summary.dismissed.map((entry) => entry.code), ['Y', 'Z']);
  assert.strictEqual(summary.withoutSupplier, 2);
  assert.strictEqual(summary.enabled, true);
  const empty = Core.overview({ enabled: false });
  assert.deepStrictEqual([empty.count, empty.total, empty.enabled, empty.dismissed.length], [0, null, false, 0]);
});

test('approveQuestion noemt orders, regels, bedrag en regels zonder prijs', () => {
  const question = Core.approveQuestion(Core.overview(sampleResult()), (amount) => `€ ${amount.toFixed(2)}`);
  assert.strictEqual(question, '2 inkooporders met 4 regels voor € 1.50 (1 regel zonder inkoopprijs) bestellen?');
  assert.match(Core.approveQuestion({ count: 1, lineCount: 1, total: null, unpriced: 1 }, String), /^1 inkooporder met 1 regel zonder bekend bedrag/);
});

test('refreshMessage en approveMessage geven leesbare meldingen', () => {
  assert.strictEqual(Core.refreshMessage({ created: 1, updated: 2, removed: 0, skipped: 3, dismissedSkipped: 1 }), '1 voorstel gemaakt, 2 bijgewerkt. Overgeslagen: 3 artikelen zonder voorkeursleverancier en 1 artikel op Niet bestellen.');
  assert.strictEqual(Core.refreshMessage({ created: 0, updated: 0, removed: 0, skipped: 0, dismissedSkipped: 0 }), 'Geen wijzigingen.');
  assert.deepStrictEqual(Core.approveMessage({ placed: [{ id: 'o-1', number: 'IO2026-0001' }], failed: [] }), { message: 'Besteld: IO2026-0001.', isError: false });
  assert.deepStrictEqual(Core.approveMessage({ placed: [], failed: [{ id: 'o-2', message: 'Order is gewijzigd.' }] }), { message: 'Niet besteld: Order is gewijzigd.', isError: true });
  assert.deepStrictEqual(Core.approveMessage({}), { message: 'Niets besteld.', isError: false });
});

test('withoutSupplierHint en countBadge', () => {
  assert.strictEqual(Core.withoutSupplierHint(0), '');
  assert.match(Core.withoutSupplierHint(1), /^1 artikel onder het minimum heeft nog geen voorkeursleverancier/);
  assert.match(Core.withoutSupplierHint(4), /^4 artikelen onder het minimum hebben nog geen voorkeursleverancier/);
  assert.deepStrictEqual([0, 3, 12].map(Core.countBadge), ['', '3', '9+']);
});
