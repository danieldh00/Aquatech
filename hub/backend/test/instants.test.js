// Tests voor de controle op tijdstippen uit zoekopdrachten en cursors.
const test = require('node:test');
const assert = require('node:assert');
const { isInstant } = require('../src/platform/instants');

test('isInstant: bestaande datums en tijdstippen zijn geldig, onmogelijke en rommel niet', () => {
  assert.strictEqual(isInstant('2026-11-20'), true);
  assert.strictEqual(isInstant('2026-11-20T10:00:00.000Z'), true);
  assert.strictEqual(isInstant('2026-11-20 10:00:00'), true);
  assert.strictEqual(isInstant('2026-02-31T10:00:00Z'), false, '31 februari bestaat niet');
  assert.strictEqual(isInstant('2026-13-01'), false);
  assert.strictEqual(isInstant('nu'), false);
  assert.strictEqual(isInstant(''), false);
  assert.strictEqual(isInstant(null), false);
  assert.strictEqual(isInstant('2026-11-20T10:00:00Z'.padEnd(80, ' ')), false);
});
