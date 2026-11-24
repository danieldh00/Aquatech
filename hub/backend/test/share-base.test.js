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

test('zonder openbaar adres geldt alleen localhost; een ander adres uit de browser wordt geweigerd', () => {
  const local = 'http://localhost:3300/app/openbaar/offerte.html';
  assert.strictEqual(pinShareBase(fakeSettings({ shopPayment: { publicUrl: '' } }), local), local);
  assert.strictEqual(pinShareBase(fakeSettings({}), local), local);
  assert.strictEqual(pinShareBase(fakeSettings({}), 'https://evil.example/app/openbaar/offerte.html'), null);
  assert.strictEqual(pinShareBase(fakeSettings({ appPublicUrl: { url: '' } }), 'https://intern.example/app/openbaar/offerte.html'), null);
  const settings = fakeSettings({ shopPayment: { publicUrl: 'https://aquatech.example/' } });
  assert.strictEqual(pinShareBase(settings, 'https://evil.example/elders.html'), 'https://evil.example/elders.html');
});

test('het eigen openbare adres van de app gaat voor het webadres van de webshop', () => {
  const settings = fakeSettings({ appPublicUrl: { url: 'https://app.example/' }, shopPayment: { publicUrl: 'https://winkel.example/' } });
  assert.strictEqual(pinShareBase(settings, 'https://evil.example/app/openbaar/offerte.html'), 'https://app.example/app/openbaar/offerte.html');
});

test('een pad in het webadres blijft voor het pad van de app, zonder dubbel voorvoegsel', () => {
  const settings = fakeSettings({ shopPayment: { publicUrl: 'https://voorbeeld.example/winkel/' } });
  assert.strictEqual(pinShareBase(settings, 'http://localhost:3300/app/openbaar/offerte.html'), 'https://voorbeeld.example/winkel/app/openbaar/offerte.html');
  assert.strictEqual(pinShareBase(settings, 'https://intern.example/winkel/app/openbaar/offerte.html'), 'https://voorbeeld.example/winkel/app/openbaar/offerte.html');
});
