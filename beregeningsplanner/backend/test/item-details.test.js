// Omschrijving en specificaties van artikelen (item-details.js, 12 uit de audit van 1.7.3):
// opschonen, HTML uit de oude webshop naar platte tekst en de terugval die de shop toont.
const test = require('node:test');
const assert = require('node:assert');
const ItemDetails = require('../src/artikelen/item-details');

test('HTML uit de webshop wordt platte tekst met alinea’s en lijstpunten, zonder scripts', () => {
  const text = ItemDetails.plainTextFromHtml('<p>Hallo&nbsp;&amp; welkom<br>tweede regel</p><ul><li>Een</li><li>Twee &#8211; drie</li></ul><script>alert(1)</script><style>p{}</style>');
  assert.strictEqual(text, 'Hallo & welkom\ntweede regel\n\n• Een\n• Twee – drie');
  assert.strictEqual(ItemDetails.plainTextFromHtml(null), '');
});

test('specificaties: als lijst of als tekst met naam: waarde, lege en te lange weg', () => {
  assert.deepStrictEqual(ItemDetails.sanitizeSpecifications('Maat: 25 mm\nzonder\n: leeg\nDruk: 6 bar: max'), [{ name: 'Maat', value: '25 mm' }, { name: 'Druk', value: '6 bar: max' }]);
  assert.deepStrictEqual(ItemDetails.sanitizeSpecifications([{ name: 'a'.repeat(80), value: 'x' }, null, 'tekst']), [{ name: 'a'.repeat(60), value: 'x' }]);
  assert.strictEqual(ItemDetails.sanitizeSpecifications(Array.from({ length: 40 }, (_, i) => ({ name: `n${i}`, value: 'v' }))).length, ItemDetails.MAX_SPECIFICATIONS);
  assert.deepStrictEqual(ItemDetails.specificationsOf('geen json'), []);
});

test('omschrijving: regeleinden blijven, stuurtekens en meer dan één lege regel niet', () => {
  assert.strictEqual(ItemDetails.sanitizeDescription('  Een\r\n\r\n\r\n\r\nTwee\u0007  drie  '), 'Een\n\nTwee drie');
  assert.strictEqual(ItemDetails.sanitizeDescription('x'.repeat(6000)).length, ItemDetails.MAX_DESCRIPTION);
});

test('de shop toont eigen tekst, anders die van de webshop, anders die van het hoofdartikel', () => {
  const shopAttributes = JSON.stringify([{ name: 'Maat', visible: true, variation: false, options: ['25', '32'] }, { name: 'Verborgen', visible: false, options: ['x'] }]);
  const own = ItemDetails.shownDetails({ description: 'Eigen', specifications: '[{"name":"A","value":"B"}]', shop_description: 'Webshop', shop_attributes: shopAttributes });
  assert.deepStrictEqual(own, { description: 'Eigen', specifications: [{ name: 'A', value: 'B' }] });
  const shop = ItemDetails.shownDetails({ description: '', specifications: '[]', shop_description: 'Webshop', shop_attributes: shopAttributes });
  assert.deepStrictEqual(shop, { description: 'Webshop', specifications: [{ name: 'Maat', value: '25, 32' }] });
  const variant = ItemDetails.shownDetails({ description: '', specifications: '[]' }, { description: 'Van het hoofdartikel', specifications: [{ name: 'X', value: 'Y' }] });
  assert.deepStrictEqual(variant, { description: 'Van het hoofdartikel', specifications: [{ name: 'X', value: 'Y' }] });
});
