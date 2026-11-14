// Rekenkern van de goederenontvangst (frontend/orderpick/receiving-core.js): scannen, aantallen, stand per regel en de ontvangst-aanroep.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { FRONTEND_DIR } = require('../src/paths');

const Core = require(path.join(FRONTEND_DIR, 'orderpick', 'receiving-core.js'));

/**
 * Een inkooporder zoals GET /api/orderpick/receipts/:id die geeft.
 * @returns {object} De order met vier regels: open, deels ontvangen, zonder code en al ontvangen.
 */
function sampleOrder() {
  return {
    id: 'io-1', number: 'IO2026-0001',
    lines: [
      { id: 'l1', code: 'PIJP', name: 'Pijp', unit: 'm', location: 'A-2', ordered: 20, received: 0, openQty: 20, scanCodes: ['PIJP', 'TT-PIJP'], scannable: true },
      { id: 'l2', code: 'BUS', name: 'Bus', unit: '', location: 'B-10', ordered: 10, received: 4, openQty: 6, scanCodes: ['4006381333931', 'BUS'], scannable: true },
      { id: 'l3', code: 'ZONDER', name: 'Zonder code', unit: '', location: '', ordered: 1, received: 0, openQty: 1, scanCodes: [], scannable: false },
      { id: 'l4', code: 'KLAAR', name: 'Al binnen', unit: '', location: 'C-1', ordered: 2, received: 2, openQty: 0, scanCodes: ['KLAAR'], scannable: true },
    ],
  };
}

test('receivableLines en initialStates: alleen regels met een openstaand aantal, vooraf ingevuld', () => {
  const order = sampleOrder();
  assert.deepStrictEqual(Core.receivableLines(order).map((line) => line.index), [0, 1, 2]);
  assert.deepStrictEqual(Core.initialStates(order), {
    0: { status: 'pending', qty: 20, scanned: false }, 1: { status: 'pending', qty: 6, scanned: false }, 2: { status: 'pending', qty: 1, scanned: false },
  });
});

test('clampQuantity: geen negatieve of ongeldige aantallen, meer dan besteld mag, drie decimalen', () => {
  assert.strictEqual(Core.clampQuantity('abc'), 0);
  assert.strictEqual(Core.clampQuantity(-3), 0);
  assert.strictEqual(Core.clampQuantity(0), 0);
  assert.strictEqual(Core.clampQuantity('2,5'), 0, 'een komma is geen getal: de invoer wordt geweigerd, niet geraden');
  assert.strictEqual(Core.clampQuantity(25), 25);
  assert.strictEqual(Core.clampQuantity(1.23456), 1.235);
  assert.strictEqual(Core.clampQuantity(1e9), 1000000);
});

test('findLine: EAN, code of leveranciersnummer; open regel gaat voor; behandelde regel en onbekende code', () => {
  const order = sampleOrder();
  const states = Core.initialStates(order);
  assert.strictEqual(Core.findLine(order, states, '4006381333931').line.index, 1);
  assert.strictEqual(Core.findLine(order, states, ' tt-pijp ').line.index, 0);
  assert.strictEqual(Core.findLine(order, states, 'KLAAR'), null, 'een regel zonder openstaand aantal bestaat niet voor het scannen');
  assert.strictEqual(Core.findLine(order, states, '000'), null);
  states[1].status = 'received';
  assert.strictEqual(Core.findLine(order, states, 'BUS').open, false);
});

test('nextOpenLine: volgende open regel, daarna van voren af, en null als alles klaar is', () => {
  const order = sampleOrder();
  const states = Core.initialStates(order);
  assert.strictEqual(Core.nextOpenLine(order, states).index, 0);
  assert.strictEqual(Core.nextOpenLine(order, states, 0).index, 1);
  states[0].status = 'received';
  states[1].status = 'skipped';
  assert.strictEqual(Core.nextOpenLine(order, states, 1).index, 2);
  assert.strictEqual(Core.nextOpenLine(order, states, 2).index, 2, 'van voren af: regel 2 is de enige die nog openstaat');
  states[2].status = 'received';
  assert.strictEqual(Core.nextOpenLine(order, states), null);
});

test('summarize en canFinish: open regels, tekort, teveel en niets ontvangen', () => {
  const order = sampleOrder();
  const states = Core.initialStates(order);
  assert.deepStrictEqual(Core.canFinish(order, states), { ok: false, reason: 'Er staan nog 3 regels open.' });
  states[0] = { status: 'received', qty: 20, scanned: true };
  states[1] = { status: 'received', qty: 4, scanned: true };
  states[2] = { status: 'skipped', qty: 0, scanned: false };
  assert.deepStrictEqual(Core.summarize(order, states), { open: 0, received: 2, skipped: 1, pieces: 24, shortPieces: 3, overLines: 0, overPieces: 0 });
  assert.deepStrictEqual(Core.canFinish(order, states), { ok: true, reason: '' });
  states[0].qty = 22;
  const over = Core.summarize(order, states);
  assert.deepStrictEqual([over.overLines, over.overPieces, over.pieces], [1, 2, 26]);
  for (const key of [0, 1, 2]) states[key] = { status: 'skipped', qty: 0, scanned: false };
  assert.deepStrictEqual(Core.canFinish(order, states), { ok: false, reason: 'Er is niets ontvangen: er is niets om in te boeken.' });
});

test('receiveBody: alleen ontvangen regels, met het eerder ontvangen aantal en de bevestiging voor meer dan besteld', () => {
  const order = sampleOrder();
  const states = Core.initialStates(order);
  states[0] = { status: 'received', qty: 20, scanned: true };
  states[1] = { status: 'received', qty: 2, scanned: true };
  states[2] = { status: 'skipped', qty: 0, scanned: false };
  assert.deepStrictEqual(Core.receiveBody(order, states), { lines: [{ lineId: 'l1', qty: 20, seen: 0 }, { lineId: 'l2', qty: 2, seen: 4 }], allowOver: false });
  states[1].qty = 7;
  assert.strictEqual(Core.receiveBody(order, states).allowOver, true);
});

test('quantityText: aantal met eenheid', () => {
  const order = sampleOrder();
  assert.strictEqual(Core.quantityText(order.lines[0], 20), '20 m');
  assert.strictEqual(Core.quantityText(order.lines[1], 6), '6');
});
