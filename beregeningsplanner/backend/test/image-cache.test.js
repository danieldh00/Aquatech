// Cache voor afbeeldingen in het geheugen (platform/image-cache.js) en het gebruik ervan door de artikelafbeeldingen.
const test = require('node:test');
const assert = require('node:assert');
const { createImageCache } = require('../src/platform/image-cache');

/**
 * Een nagebootste afbeelding van een bepaalde grootte.
 * @param {number} size Aantal bytes.
 * @returns {{ mime: string, body: Buffer }} De afbeelding.
 */
const imageOf = (size) => ({ mime: 'image/png', body: Buffer.alloc(size, 1) });

test('afbeeldingencache: per omgeving, begrensd op bytes (minst recent gebruikt eruit) en op leeftijd', () => {
  const cache = createImageCache({ maxBytes: 300, maxEntryBytes: 200, ttlMs: 60 * 1000 });
  cache.set('t1', 'a', imageOf(100));
  cache.set('t1', 'b', imageOf(100));
  assert.strictEqual(cache.get('t2', 'a'), null, 'andere omgeving: niet gevonden');
  assert.strictEqual(cache.get('t1', 'a').body.length, 100);
  cache.set('t1', 'c', imageOf(100));
  cache.set('t1', 'd', imageOf(100));
  assert.strictEqual(cache.get('t1', 'b'), null, 'minst recent gebruikte is eruit');
  assert.ok(cache.get('t1', 'a'), 'net gebruikte blijft');
  assert.deepStrictEqual(cache.stats(), { count: 3, bytes: 300 });
  cache.set('t1', 'groot', imageOf(201));
  assert.strictEqual(cache.get('t1', 'groot'), null, 'te grote afbeelding wordt niet bewaard');
  cache.remove('t1', 'a');
  assert.strictEqual(cache.get('t1', 'a'), null);
  cache.set('t2', 'a', imageOf(10));
  cache.clearTenant('t1');
  assert.deepStrictEqual(cache.stats(), { count: 1, bytes: 10 }, 'alleen t2 blijft');

  const shortLived = createImageCache({ ttlMs: -1 });
  shortLived.set('t1', 'a', imageOf(10));
  assert.strictEqual(shortLived.get('t1', 'a'), null, 'verlopen');
  assert.deepStrictEqual(shortLived.stats(), { count: 0, bytes: 0 });
});
