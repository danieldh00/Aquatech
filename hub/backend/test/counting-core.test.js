// Rekenkern van het tellen in de orderpick-app (frontend/orderpick/counting-core.js): aantallen, scannen, voortgang en de ingave.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { FRONTEND_DIR } = require('../src/paths');

const Core = require(path.join(FRONTEND_DIR, 'orderpick', 'counting-core.js'));

/**
 * Regels zoals GET /api/orderpick/counts/:id/lines ze geeft (blind).
 * @returns {object[]} Drie regels: geteld, open en te hertellen.
 */
function sampleLines() {
  return [
    { id: 'a', code: 'BUS', name: 'Bus', unit: 'stuks', ean: '8712345678906', location: 'A-01', status: 'geteld', countedQty: 4 },
    { id: 'b', code: 'KRAAN', name: 'Kraan', unit: 'stuks', ean: '', location: 'A-01', status: 'open', countedQty: null },
    { id: 'c', code: 'SLANG', name: 'Slang', unit: 'm', ean: '8712345678913', location: 'A-01', status: 'hertellen', countedQty: null },
  ];
}

test('parseQuantity: leeg is geen 0, komma mag, negatief en onzin worden geweigerd', () => {
  assert.strictEqual(Core.parseQuantity(''), null);
  assert.strictEqual(Core.parseQuantity(null), null);
  assert.strictEqual(Core.parseQuantity('abc'), null);
  assert.strictEqual(Core.parseQuantity('-1'), null);
  assert.strictEqual(Core.parseQuantity(Core.MAX_QTY + 1), null);
  assert.strictEqual(Core.parseQuantity('0'), 0);
  assert.strictEqual(Core.parseQuantity('2,5'), 2.5);
  assert.strictEqual(Core.parseQuantity('1.00049'), 1);
});

test('findLine vindt op EAN en code en laat een regel die nog geteld moet worden voorgaan', () => {
  const lines = sampleLines();
  assert.strictEqual(Core.findLine(lines, ' 8712 345678906\r\n').id, 'a');
  assert.strictEqual(Core.findLine(lines, 'kraan').id, 'b');
  assert.strictEqual(Core.findLine(lines, 'onbekend'), null);
  assert.strictEqual(Core.findLine(lines, ''), null);
  const twice = [{ ...lines[0] }, { ...lines[0], id: 'a2', status: 'open' }];
  assert.strictEqual(Core.findLine(twice, 'BUS').id, 'a2');
});

test('nextOpenLine en summarize tellen open en te hertellen regels, geteld niet', () => {
  const lines = sampleLines();
  assert.strictEqual(Core.nextOpenLine(lines).id, 'b');
  assert.strictEqual(Core.nextOpenLine(lines, 'b').id, 'c');
  assert.strictEqual(Core.nextOpenLine(lines, 'c').id, 'b');
  assert.strictEqual(Core.nextOpenLine([lines[0]]), null);
  assert.deepStrictEqual(Core.summarize(lines), { total: 3, counted: 1, open: 1, recount: 1 });
});

test('countBody, newClientId en locationName', () => {
  assert.deepStrictEqual(Core.countBody(3, 'abcdefgh'), { qty: 3, clientId: 'abcdefgh' });
  assert.strictEqual(Core.newClientId({ randomUUID: () => 'uuid-1234' }), 'uuid-1234');
  assert.ok(Core.newClientId().length >= 8);
  assert.notStrictEqual(Core.newClientId(), Core.newClientId());
  assert.strictEqual(Core.locationName(''), 'Geen locatie');
  assert.strictEqual(Core.locationName('B-02'), 'B-02');
});

test('het telscherm is blind: de bestanden kennen geen verwacht aantal of prijs', () => {
  for (const file of ['counting-core.js', 'counting.js']) {
    const source = fs.readFileSync(path.join(FRONTEND_DIR, 'orderpick', file), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/expected|verwacht|price|prijs|unitCost|onHand/i.test(source), `${file} noemt een verwacht aantal of een prijs`);
  }
});

test('totalOf: losse stuks plus verpakkingen keer hun factor, leeg is geen 0', () => {
  assert.strictEqual(Core.totalOf('', []), null);
  assert.strictEqual(Core.totalOf('', [{ factor: 12, count: '' }]), null);
  assert.strictEqual(Core.totalOf('5', []), 5);
  assert.strictEqual(Core.totalOf('3', [{ factor: 12, count: '2' }, { factor: 100, count: '1' }]), 127);
  assert.strictEqual(Core.totalOf('', [{ factor: 12, count: '0' }]), 0, 'een ingevulde 0 is wel een telling');
  assert.strictEqual(Core.totalOf('x', [{ factor: 12, count: '2' }]), null);
  assert.strictEqual(Core.totalOf('', [{ factor: 12, count: '-1' }]), null);
  assert.strictEqual(Core.totalOf('', [{ factor: 0, count: '2' }]), null);
});
