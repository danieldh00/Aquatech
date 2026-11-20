// Test: de herkomst van klantlinks komt uit het webadres in Beheer (pinShareBase).
const test = require('node:test');
const assert = require('node:assert');
const { pinShareBase } = require('../src/verkoop/quotes');

/**
 * Maakt een nagebootste instellingenlijst.
 * @param {object} values Waarden per sleutel.
 * @returns {{ get: Function }} Object met get(sleutel).
 */
const fakeSettings = (values) => ({ get: (key) => values[key] });

test('klantlink krijgt de openbare herkomst, het pad blijft', () => {
  const settings = fakeSettings({ shopPayment: { publicUrl: 'https://aquatech.example/' } });
  assert.strictEqual(pinShareBase(settings, 'http://localhost:3300/app/openbaar/offerte.html'), 'https://aquatech.example/app/openbaar/offerte.html');
  assert.strictEqual(pinShareBase(settings, 'http://192.168.1.5/app/openbaar/afspraak.html', 'afspraak.html'), 'https://aquatech.example/app/openbaar/afspraak.html');
});

test('zonder webadres of bij een ongeldig adres verandert er niets', () => {
  const url = 'http://localhost:3300/app/openbaar/offerte.html';
  assert.strictEqual(pinShareBase(fakeSettings({ shopPayment: { publicUrl: '' } }), url), url);
  assert.strictEqual(pinShareBase(fakeSettings({}), url), url);
  const settings = fakeSettings({ shopPayment: { publicUrl: 'https://aquatech.example/' } });
  assert.strictEqual(pinShareBase(settings, 'https://evil.example/elders.html'), 'https://evil.example/elders.html');
});
