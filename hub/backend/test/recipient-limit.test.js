// Test van de limiet per ontvanger voor offertemails (beveiliging/recipient-limit.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecipientLimit } = require('../src/beveiliging/recipient-limit');

test('een adres krijgt hoogstens het maximum aantal verstuurde mails per venster', () => {
  const limit = createRecipientLimit({ windowMs: 60000, max: 2 });
  assert.equal(limit.allowed('t1', ['klant@example.nl']), true);
  limit.record('t1', ['klant@example.nl']);
  limit.record('t1', ['KLANT@example.nl ']);
  assert.equal(limit.allowed('t1', ['klant@example.nl']), false);
});

test('controleren telt niet mee: een mislukte verzending verbruikt geen plek', () => {
  const limit = createRecipientLimit({ windowMs: 60000, max: 1 });
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(limit.allowed('t1', ['a@example.nl']), true);
  limit.record('t1', ['a@example.nl']);
  assert.equal(limit.allowed('t1', ['a@example.nl']), false);
});

test('een andere organisatie of een ander adres heeft een eigen teller', () => {
  const limit = createRecipientLimit({ windowMs: 60000, max: 1 });
  limit.record('t1', ['a@example.nl']);
  assert.equal(limit.allowed('t2', ['a@example.nl']), true);
  assert.equal(limit.allowed('t1', ['b@example.nl']), true);
  assert.equal(limit.allowed('t1', ['a@example.nl', 'b@example.nl']), false);
});
