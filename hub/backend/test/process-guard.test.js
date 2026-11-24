// Vangnet voor niet-afgevangen fouten (audit T-14): loggen, tellen voor Bewaking en gecontroleerd stoppen.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { installProcessGuard } = require('../src/platform/process-guard');

/**
 * Bouwt het vangnet met nepafhankelijkheden.
 * @returns {object} guard, fake (processObject, calls) en exits.
 */
function build() {
  const calls = { logged: [], counted: 0, flushed: 0, closed: 0 };
  const exits = [];
  const processObject = new EventEmitter();
  const guard = installProcessGuard({
    appLog: { error: (source, message) => calls.logged.push([source, message]), flush: () => { calls.flushed += 1; } },
    errorCounter: { add: () => { calls.counted += 1; } },
    server: { close: (callback) => { calls.closed += 1; callback(); } },
    onExit: (code) => exits.push(code),
    processObject,
    log: () => {},
  });
  return { guard, processObject, calls, exits };
}

test('T-14: een niet-afgevangen belofte wordt gelogd en geteld, het proces blijft draaien', () => {
  const { processObject, calls, exits } = build();
  processObject.emit('unhandledRejection', new Error('timer stuk'));
  assert.strictEqual(calls.counted, 1);
  assert.strictEqual(calls.logged[0][0], 'proces');
  assert.match(calls.logged[0][1], /timer stuk/);
  assert.deepStrictEqual(exits, []);
});

test('T-14: een niet-afgevangen uitzondering wordt gelogd, weggeschreven en stopt het proces één keer', () => {
  const { processObject, calls, exits } = build();
  processObject.emit('uncaughtException', new Error('kapot'));
  processObject.emit('uncaughtException', new Error('nog eens'));
  assert.strictEqual(calls.counted, 2);
  assert.strictEqual(calls.flushed, 1);
  assert.strictEqual(calls.closed, 1);
  assert.deepStrictEqual(exits, [1]);
});

test('T-14: een kapot logboek of een afwijzing zonder Error breekt het vangnet niet', () => {
  const processObject = new EventEmitter();
  installProcessGuard({ appLog: { error: () => { throw new Error('db weg'); }, flush: () => {} }, errorCounter: { add: () => { throw new Error('x'); } }, processObject, onExit: () => {}, log: () => {} });
  assert.doesNotThrow(() => processObject.emit('unhandledRejection', 'gewoon tekst'));
});
