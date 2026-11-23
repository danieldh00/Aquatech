// Bewaakt dat de mediabibliotheek van Artikelen de api-functie van artikelen.js meekrijgt (L-01: "api is not defined").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const folder = path.join(__dirname, '..', '..', 'frontend', 'artikelen');

test('artikelen.js geeft api mee aan ArtikelenMedia.setup', () => {
  const source = fs.readFileSync(path.join(folder, 'artikelen.js'), 'utf8');
  assert.match(source, /ArtikelenMedia\.setup\(\{[^}]*\bapi\b[^}]*\}\)/);
});

test('media.js haalt api uit de context en definieert hem niet zelf', () => {
  const source = fs.readFileSync(path.join(folder, 'media.js'), 'utf8');
  assert.match(source, /\(\{[^}]*\bapi\b[^}]*\} = context\)/);
  assert.doesNotMatch(source, /function api\(/);
});
