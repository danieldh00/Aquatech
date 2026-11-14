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
  assert.strictEqual(store.put('t1', 'u9', 'groot', Buffer.alloc(6 * 1024 * 1024)).error, 'te_groot', 'een rapport boven 5 MB wordt geweigerd');
  // Eén gebruiker houdt hoogstens 10 MB: de oudste gaat weg, de rapporten van een ander blijven.
  const other = store.put('t1', 'u2', 'x', Buffer.from('x'));
  const first = store.put('t1', 'u3', 'a', Buffer.alloc(4 * 1024 * 1024));
  const second = store.put('t1', 'u3', 'b', Buffer.alloc(4 * 1024 * 1024));
  const third = store.put('t1', 'u3', 'c', Buffer.alloc(4 * 1024 * 1024));
  assert.strictEqual(store.get(first.token, 't1', 'u3'), null);
  assert.ok(store.get(second.token, 't1', 'u3') && store.get(third.token, 't1', 'u3'));
  assert.ok(store.get(other.token, 't1', 'u2'));
  // Past het nieuwe rapport niet in de totale ruimte, dan mislukt de opslag en blijven de eigen oude links werken.
  for (const user of ['f1', 'f2', 'f3', 'f4']) { store.put('t1', user, 'x', Buffer.alloc(5 * 1024 * 1024)); store.put('t1', user, 'y', Buffer.alloc(5 * 1024 * 1024)); }
  const keep = store.put('t1', 'u8', 'oud', Buffer.alloc(1024 * 1024));
  const refused = store.put('t1', 'u8', 'nieuw', Buffer.alloc(5 * 1024 * 1024));
  assert.strictEqual(refused.error, 'vol');
  assert.ok(store.get(keep.token, 't1', 'u8'), 'de oude link blijft werken na een mislukte opslag');
});
