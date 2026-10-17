// Unittests voor de lokale planherkenning (frontend-code, geladen in een sandbox).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONT = path.join(__dirname, '..', '..', 'frontend', 'js');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['geometry.js', 'catalog.js', 'localrecog.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, f), 'utf8'), sandbox);
const L = sandbox.window.LocalRecognizer;

test('maten lezen: eenheden en notaties', () => {
  assert.strictEqual(L.parseLength('12,00', 'm'), 12);
  assert.strictEqual(L.parseLength('12,00m'), 12);
  assert.strictEqual(L.parseLength('8500'), 8.5); // mm op bouwtekening
  assert.strictEqual(L.parseLength('450', 'cm'), 4.5);
  assert.strictEqual(L.parseLength('3.5'), 3.5);
  assert.strictEqual(L.parseLength('1250mm'), 1.25);
  assert.strictEqual(L.parseLength('12'), null); // geheel getal zonder eenheid: te onzeker
  assert.strictEqual(L.parseLength('abc'), null);
});

test('kleur naar vlaksoort', () => {
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const type = (h) => L.classify(...hex(h));
  // 0 geen, 1 gazon, 2 haag, 3 beplanting, 4 droog, 5 nat
  for (const h of ['#8bc34a', '#7cb342', '#9ccc65', '#66bb6a']) assert.strictEqual(type(h), 1, h);
  for (const h of ['#2e7d32', '#1b5e20']) assert.strictEqual(type(h), 2, h);
  for (const h of ['#a1887f', '#8d6e63', '#f48fb1', '#ce93d8']) assert.strictEqual(type(h), 3, h);
  for (const h of ['#9e9e9e', '#bdbdbd', '#e8dcc2']) assert.strictEqual(type(h), 4, h);
  for (const h of ['#4fc3f7', '#1e88e5']) assert.strictEqual(type(h), 5, h);
  for (const h of ['#ffffff', '#000000', '#222222']) assert.strictEqual(type(h), 0, h);
});

test('maatlijn meten: lijn boven de tekst, onderbroken door de tekst', () => {
  const w = 300, h = 60;
  const gray = new Uint8Array(w * h).fill(255);
  // maatlijn op y=40 van x=20 tot 280, met gat waar de tekst staat (130–170)
  for (let x = 20; x <= 280; x++) if (x < 130 || x > 170) gray[40 * w + x] = 0;
  // tekst iets erboven
  for (let y = 25; y < 37; y++) for (let x = 132; x < 168; x += 3) gray[y * w + x] = 0;
  const r = L.measureLine(gray, w, h, { x0: 130, y0: 24, x1: 170, y1: 38 });
  assert.ok(r, 'lijn gevonden');
  assert.strictEqual(r.len, 261);
});

test('maatlijn meten: tekst midden in een onderbreking van de lijn', () => {
  const w = 300, h = 60;
  const gray = new Uint8Array(w * h).fill(255);
  for (let x = 20; x <= 280; x++) if (x < 128 || x > 172) gray[30 * w + x] = 0;
  for (let y = 24; y < 37; y++) for (let x = 132; x < 168; x += 3) gray[y * w + x] = 0;
  const r = L.measureLine(gray, w, h, { x0: 130, y0: 23, x1: 170, y1: 37 });
  assert.ok(r, 'lijn gevonden');
  assert.strictEqual(r.len, 261);
});

test('maatlijn meten: rand van een vlak die niet voorbij de tekst loopt telt niet', () => {
  const w = 300, h = 60;
  const gray = new Uint8Array(w * h).fill(255);
  for (let x = 125; x <= 175; x++) gray[42 * w + x] = 0; // korte rand net onder de tekst
  assert.strictEqual(L.measureLine(gray, w, h, { x0: 130, y0: 24, x1: 170, y1: 38 }), null);
});
