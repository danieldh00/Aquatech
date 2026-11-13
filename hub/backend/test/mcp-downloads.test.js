// Tests van de Excel-schrijver en de tijdelijke opslag van rapporten (mcp/xlsx-writer.js, mcp/mcp-downloads.js).
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { buildWorkbook, columnName } = require('../src/mcp/xlsx-writer');
const { createDownloadStore, safeFileName } = require('../src/mcp/mcp-downloads');

test('xlsx-writer: kolomnamen, tabbladen, datums, bedragen en veilige tekst', () => {
  assert.deepStrictEqual([0, 1, 25, 26, 27, 701, 702].map(columnName), ['A', 'B', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  const buffer = buildWorkbook([{ name: 'Test/Blad:1', columns: [{ header: 'Naam', key: 'naam' }, { header: 'Datum', key: 'datum', type: 'date' }, { header: 'Bedrag', key: 'bedrag', type: 'money' }],
    rows: [{ naam: 'A & <B> \u0001', datum: '2026-11-13', bedrag: 12.5 }, { naam: '=1+1', datum: 'geen', bedrag: 'x' }] }]);
  assert.strictEqual(buffer.subarray(0, 2).toString(), 'PK');
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.strictEqual(buffer.readUInt16LE(end + 10), 6);
  assert.strictEqual(zlib.crc32(Buffer.from('abc')) >>> 0, 0x352441c2);
  assert.throws(() => buildWorkbook([]), /minstens één tabblad/);
});

test('mcp-downloads: alleen de eigen gebruiker, verloopt, begrenst per gebruiker en maakt de naam veilig', () => {
  assert.strictEqual(safeFileName('../../etc/pass wd'), 'etc_pass_wd.xlsx');
  assert.strictEqual(safeFileName(''), 'rapport.xlsx');
  let clock = 1000;
  const store = createDownloadStore({ now: () => clock, ttlMs: 100 });
  const stored = store.put('t1', 'u1', 'a', Buffer.from('x'));
  assert.ok(stored.token.length >= 40);
  assert.ok(store.get(stored.token, 't1', 'u1'));
  assert.strictEqual(store.get(stored.token, 't1', 'u2'), null);
  assert.strictEqual(store.get(stored.token, 't2', 'u1'), null);
  clock += 101;
  assert.strictEqual(store.get(stored.token, 't1', 'u1'), null);
  assert.strictEqual(store.size(), 0);
  const tokens = Array.from({ length: 12 }, () => store.put('t1', 'u1', 'b', Buffer.from('x')).token);
  assert.strictEqual(store.get(tokens[0], 't1', 'u1'), null, 'de oudste gaat weg na tien');
  assert.ok(store.get(tokens[11], 't1', 'u1'));
  assert.strictEqual(store.put('t1', 'u9', 'groot', Buffer.alloc(51 * 1024 * 1024)), null);
});
