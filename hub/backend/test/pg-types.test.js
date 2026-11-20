// De typeparsers van de databaselaag: tijdstippen als ISO-tekst, jsonb als tekst, boolean als 1/0, getallen als Number,
// ook echt via een query (cast in de SELECT, zodat geen kolomtype hoeft te veranderen).
const test = require('node:test');
const assert = require('node:assert');
const { isoOf } = require('../src/database/pg-types');
const { openDb } = require('../src/database/db');

test('isoOf geeft ISO-tekst met milliseconden en Z', () => {
  assert.strictEqual(isoOf('2026-11-20 18:08:31.5+01', true), '2026-11-20T17:08:31.500Z');
  assert.strictEqual(isoOf('2026-11-20 18:08:31', false), '2026-11-20T18:08:31.000Z');
  assert.strictEqual(isoOf('onzin', true), 'onzin');
});

test('queries geven tijdstip, jsonb, boolean en getallen in de vorm die de app kent', () => {
  const db = openDb();
  const row = db.prepare(`SELECT '2026-11-20T18:08:31.250Z'::timestamptz AS moment, '2026-11-20 18:08:31'::timestamp AS plain,
    '{"a": 1}'::jsonb AS doc, TRUE AS yes, FALSE AS no, 7::bigint AS big, 1.5::numeric AS price`).get();
  assert.strictEqual(row.moment, '2026-11-20T18:08:31.250Z');
  assert.strictEqual(row.plain, '2026-11-20T18:08:31.000Z');
  assert.strictEqual(typeof row.doc, 'string');
  assert.deepStrictEqual(JSON.parse(row.doc), { a: 1 });
  assert.strictEqual(row.yes, 1);
  assert.strictEqual(row.no, 0);
  assert.strictEqual(row.big, 7);
  assert.strictEqual(row.price, 1.5);
});
