// NUL-tekens in parameters: jsonb weigert de schrijfwijze \u0000, tekst weigert het teken zelf.
const test = require('node:test');
const assert = require('node:assert');
const { stripNul } = require('../src/database/pgdb');
const { openDb } = require('../src/database/db');

test('stripNul haalt NUL-tekens en hun JSON-schrijfwijze weg, maar laat een echte backslash staan', () => {
  assert.strictEqual(stripNul('Jan\u0000sen'), 'Jansen');
  assert.strictEqual(stripNul(JSON.stringify({ name: 'Jan\u0000\u0000sen' })), '{"name":"Jansen"}');
  assert.strictEqual(stripNul('{"path":"C:\\\\u0000x"}'), '{"path":"C:\\\\u0000x"}', 'een ontsnapte backslash blijft staan');
  assert.strictEqual(stripNul('gewone tekst'), 'gewone tekst');
});

test('stripNul werkt via de parameterroute: een NUL-teken in JSON-tekst gaat zonder fout naar een jsonb-kolom', () => {
  const db = openDb();
  const result = db.prepare('SELECT ?::jsonb AS data').get(JSON.stringify({ name: 'Jan\u0000sen' }));
  assert.strictEqual(JSON.parse(result.data).name, 'Jansen');
});
