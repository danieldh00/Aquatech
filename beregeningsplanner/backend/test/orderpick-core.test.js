// Rekenkern van de orderpick-app (frontend/orderpick/orderpick-core.js): scannen, aantallen, stand per regel en de pick-aanroep.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { FRONTEND_DIR } = require('../src/paths');

const Core = require(path.join(FRONTEND_DIR, 'orderpick', 'orderpick-core.js'));

/**
 * Een bestelling zoals GET /api/orderpick/orders/:id die geeft.
 * @returns {object} De bestelling met vier regels: twee leverbaar, één voor de helft en één zonder voorraad.
 */
function sampleOrder() {
  return {
    id: 'order-1', number: 'WB-1', shipmentCount: 2, allowPartial: true,
    lines: [
      { index: 2, code: 'BUS', name: 'Bus', unit: 'stuks', location: 'A-01', ordered: 4, shipped: 0, remaining: 4, ready: 4, backorder: 0, packaging: null, scanCodes: ['8712345678906', 'BUS'], scannable: true },
      { index: 0, code: 'KRAAN@PAL', name: 'Kraan (pallet)', unit: 'stuks', location: 'B-02', ordered: 3, shipped: 0, remaining: 3, ready: 2, backorder: 1, packaging: { code: 'PAL', name: 'pallet', factor: 10 }, scanCodes: ['8712345678913', 'KRAAN@PAL'], scannable: true },
      { index: 1, code: 'ZONDER', name: 'Zonder code', unit: '', location: '', ordered: 1, shipped: 0, remaining: 1, ready: 1, backorder: 0, packaging: null, scanCodes: [], scannable: false },
      { index: 3, code: 'LEEG', name: 'Niet op voorraad', unit: 'stuks', location: 'C-03', ordered: 2, shipped: 0, remaining: 2, ready: 0, backorder: 2, packaging: null, scanCodes: ['LEEG'], scannable: true },
    ],
  };
}

test('normalizeCode haalt spaties, stuurtekens en hoofdletters weg', () => {
  assert.strictEqual(Core.normalizeCode(' 8712 345\r\n'), '8712345');
  assert.strictEqual(Core.normalizeCode('bus\t'), 'BUS');
  assert.strictEqual(Core.normalizeCode(null), '');
});

test('findLine: EAN of code, open regel gaat voor, onbekend geeft null', () => {
  const order = sampleOrder();
  const states = Core.initialStates(order);
  assert.strictEqual(Core.findLine(order.lines, states, '8712345678906').line.index, 2);
  assert.strictEqual(Core.findLine(order.lines, states, ' bus ').line.index, 2);
  assert.strictEqual(Core.findLine(order.lines, states, 'KRAAN@PAL').line.index, 0);
  assert.strictEqual(Core.findLine(order.lines, states, '000'), null);
  assert.strictEqual(Core.findLine(order.lines, states, ''), null);
  states[2].status = 'picked';
  assert.deepStrictEqual(Core.findLine(order.lines, states, 'BUS'), { line: order.lines[0], open: false });
  // Twee regels met dezelfde code: de open regel wint, en de huidige regel gaat voor.
  const twin = [{ index: 5, scanCodes: ['X'] }, { index: 6, scanCodes: ['X'] }];
  const twinStates = { 5: { status: 'picked' }, 6: { status: 'pending' } };
  assert.strictEqual(Core.findLine(twin, twinStates, 'X').line.index, 6);
  twinStates[5].status = 'pending';
  assert.strictEqual(Core.findLine(twin, twinStates, 'X', 6).line.index, 6);
  assert.strictEqual(Core.findLine(twin, twinStates, 'X').line.index, 5);
});

test('clampQuantity: geheel, niet negatief, hoogstens het leverbare aantal', () => {
  assert.strictEqual(Core.clampQuantity(3, 4), 3);
  assert.strictEqual(Core.clampQuantity(9, 4), 4);
  assert.strictEqual(Core.clampQuantity(-2, 4), 0);
  assert.strictEqual(Core.clampQuantity('abc', 4), 0);
  assert.strictEqual(Core.clampQuantity(2.7, 4), 2);
  assert.strictEqual(Core.clampQuantity(5, 2.5), 2.5);
  assert.strictEqual(Core.clampQuantity(2.5, 2.5), 2.5);
});

test('beginstand: leverbare regels staan open met het volledige aantal, een regel zonder voorraad doet niet mee', () => {
  const order = sampleOrder();
  const states = Core.initialStates(order);
  assert.deepStrictEqual(Object.keys(states).sort(), ['0', '1', '2']);
  assert.deepStrictEqual(states[0], { status: 'pending', qty: 2, scanned: false });
  assert.deepStrictEqual(Core.pickableLines(order).map((line) => line.index), [2, 0, 1]);
});

test('nextOpenLine volgt de volgorde van het magazijn en begint na de laatste regel weer van voren', () => {
  const order = sampleOrder();
  const states = Core.initialStates(order);
  assert.strictEqual(Core.nextOpenLine(order, states).index, 2);
  assert.strictEqual(Core.nextOpenLine(order, states, 2).index, 0);
  states[0].status = 'picked';
  assert.strictEqual(Core.nextOpenLine(order, states, 2).index, 1);
  states[2].status = 'picked';
  assert.strictEqual(Core.nextOpenLine(order, states, 1).index, 1);
  states[1].status = 'absent';
  assert.strictEqual(Core.nextOpenLine(order, states, 1), null);
});

test('summarize en canFinish: open regels, backorder en niets gepickt', () => {
  const order = sampleOrder();
  const states = Core.initialStates(order);
  assert.strictEqual(Core.summarize(order, states).open, 3);
  assert.strictEqual(Core.canFinish(order, states).ok, false);
  assert.match(Core.canFinish(order, states).reason, /3 regels open/);
  states[2] = { status: 'picked', qty: 4, scanned: true };
  states[0] = { status: 'picked', qty: 1, scanned: true };
  states[1] = { status: 'absent', qty: 0, scanned: false };
  assert.deepStrictEqual(Core.summarize(order, states), { open: 0, picked: 2, absent: 1, short: 2, pieces: 5, missingPieces: 2 });
  assert.deepStrictEqual(Core.canFinish(order, states), { ok: true, reason: '' });
  for (const key of Object.keys(states)) states[key] = { status: 'absent', qty: 0, scanned: false };
  assert.strictEqual(Core.canFinish(order, states).ok, false);
  assert.match(Core.canFinish(order, states).reason, /niets gepickt/);
});

test('pickBody: alleen gepickte regels met minstens één stuk, plus het aantal bekende zendingen', () => {
  const order = sampleOrder();
  const states = {
    2: { status: 'picked', qty: 4, scanned: true },
    0: { status: 'picked', qty: 0, scanned: true },
    1: { status: 'absent', qty: 0, scanned: false },
  };
  assert.deepStrictEqual(Core.pickBody(order, states), { lines: [{ index: 2, qty: 4 }], shipmentCount: 2 });
});

test('quantityText: eenheid of verpakking', () => {
  const order = sampleOrder();
  assert.strictEqual(Core.quantityText(order.lines[0], 3), '3 stuks');
  assert.strictEqual(Core.quantityText(order.lines[1], 2), '2 × pallet');
  assert.strictEqual(Core.quantityText(order.lines[2], 1), '1');
});
