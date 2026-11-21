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

test('stableStringify geeft dezelfde tekst bij een andere sleutelvolgorde', () => {
  const { stableStringify } = require('../src/platform/stable-json');
  assert.strictEqual(stableStringify({ b: 1, a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1},"b":1}');
  assert.strictEqual(stableStringify({ a: { c: 2, d: 1 }, b: 1 }), stableStringify({ b: 1, a: { d: 1, c: 2 } }));
  assert.strictEqual(stableStringify([{ z: 1, y: [{ b: 1, a: 2 }] }]), '[{"y":[{"a":2,"b":1}],"z":1}]');
});

test('het gegevensveld van een offerte is JSONB en moet een object zijn', () => {
  const db = openDb();
  const type = db.prepare("SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'quotes' AND column_name = 'data'").get();
  assert.strictEqual(type.data_type, 'jsonb');
  const constraint = db.prepare("SELECT convalidated FROM pg_constraint WHERE conname = 'quotes_data_object' AND connamespace = current_schema()::regnamespace").get();
  assert.ok(constraint, 'de objectcontrole bestaat');
  assert.ok(constraint.convalidated, 'de objectcontrole geldt ook voor bestaande rijen');
});
