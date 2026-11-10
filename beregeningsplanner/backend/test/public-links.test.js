// Verlopen van openbare klantlinks (G-02): 180 dagen na delen, of 90 dagen na
// de datum van de offerte of afspraak als die later ligt.
const test = require('node:test');
const assert = require('node:assert');
const { linkExpired } = require('../src/platform/public-links');

const DAY = 86400000;
const NOW = Date.parse('2026-11-10T12:00:00Z');

test('linkExpired: termijn na delen en na de datum van de offerte of afspraak', () => {
  /**
   * Tijdstip een aantal dagen voor NOW.
   * @param {number} days Aantal dagen.
   * @returns {string} ISO-tijdstip.
   */
  const daysAgo = (days) => new Date(NOW - days * DAY).toISOString();
  assert.strictEqual(linkExpired({ sharedAt: daysAgo(10) }, NOW), false);
  assert.strictEqual(linkExpired({ sharedAt: daysAgo(181) }, NOW), true);
  assert.strictEqual(linkExpired({ sharedAt: daysAgo(181), referenceDate: daysAgo(30).slice(0, 10) }, NOW), false, 'geplande datum kort geleden');
  assert.strictEqual(linkExpired({ sharedAt: daysAgo(400), referenceDate: daysAgo(91).slice(0, 10) }, NOW), true);
  assert.strictEqual(linkExpired({}, NOW), false, 'zonder datum niet stil laten verlopen');
});
