// Unittests voor de lokale planherkenning (frontend-code, geladen in een sandbox).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONT = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['geometry.js', 'catalog.js', 'autotrace.js', 'planimport.js', 'concept.js', 'localrecog.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, f), 'utf8'), sandbox);
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

test('bleke potloodkleuren (genormaliseerd op het papier)', () => {
  const t = (r, g, b) => L.classify(r * 255, g * 255, b * 255);
  assert.strictEqual(t(0.94, 1.0, 0.86), 1); // lichtgroen potlood = gazon
  assert.strictEqual(t(0.87, 0.94, 0.89), 0); // grijsgroen, licht (grind, vervaagd) ≠ gazon
  assert.strictEqual(t(0.6, 0.89, 0.95), 2); // blauwgroen = heesters
  assert.strictEqual(t(0.99, 0.96, 0.8), 4); // lichtgeel = terras
  assert.strictEqual(t(1.0, 0.98, 0.76), 4); // geel = vlonder/veranda
  assert.strictEqual(t(1.0, 0.9, 0.9), 4); // licht rood = schuur, baksteen
});

test('maten lezen: zwakke lezingen bij een weggevallen komma', () => {
  // via JSON: arrays uit de sandbox hebben een ander prototype
  const rd = (...a) => JSON.stringify(L.lengthReadings(...a).map((x) => [x.meters, x.strong]));
  assert.strictEqual(rd('100', 'm'), '[[100,false],[10,false],[1,false]]');
  assert.strictEqual(rd('12,50', 'm'), '[[12.5,true]]');
  assert.strictEqual(rd('8 m'), '[[8,true]]');
  assert.strictEqual(rd('8500'), '[[8.5,false]]');
});

test('schaal kiezen: sterke lezing wint, losse zwakke alleen als plausibel', () => {
  const W = 1200;
  const strong = { mpp: 10 / 702, strong: true, text: '10,00 m', meters: 10, px: 702 };
  const weak = { mpp: 1.1 / 241, strong: false, text: '1100', meters: 1.1, px: 241 };
  assert.strictEqual(L.pickScale([weak, strong], W).metersPerPixel, strong.mpp);
  // "100 m" over 592 px: 100 m geeft een plan van 200+ m, 1 m een van 2 m; 10 m is plausibel
  const lost = [100, 10, 1].map((m) => ({ mpp: m / 592, strong: false, text: '100 m', meters: m, px: 592 }));
  const p = L.pickScale(lost, W);
  assert.strictEqual(p.metersPerPixel, 10 / 592);
  assert.strictEqual(p.confidence, 'laag');
  // twee zwakke die overeenkomen: hoog
  const mm = [{ ...weak, mpp: 0.01, text: '4500', px: 450 }, { ...weak, mpp: 0.0101, text: '6000', px: 594 }];
  assert.strictEqual(L.pickScale(mm, W).confidence, 'hoog');
  assert.strictEqual(L.pickScale([], W), null);
});

// ---- synthetisch gefotografeerd potloodplan: grijs, ongelijk belicht papier, arcering, lijnen, titelblok
function photoPlan() {
  const w = 400, h = 300;
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const inRect = (x, y, r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
  const lawn = [120, 80, 280, 220], path = [60, 60, 340, 250], title = [250, 268, 395, 296];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const light = 0.5 + 0.2 * (x / w) + 0.08 * (y / h); // belichting loopt van 50% naar 78%
      let c = [255, 255, 250]; // papier
      if (inRect(x, y, path)) c = [200, 200, 200]; // grijze verharding rond het gazon
      if (inRect(x, y, lawn) && (x + y) % 4 < 3) c = [215, 240, 190]; // lichtgroene arcering met papier ertussen
      if (inRect(x, y, title) && (y % 7 === 0 || x % 50 === 0)) c = [60, 60, 60]; // titelblok: lijnen
      if (x === 150 || y === 150) c = [30, 30, 30]; // inktlijnen dwars door alles
      const n = (rnd() - 0.5) * 8;
      const i = (y * w + x) * 4;
      data[i] = c[0] * light * 1.0 + n; data[i + 1] = c[1] * light * 0.98 + n; data[i + 2] = c[2] * light * 0.92 + n; data[i + 3] = 255;
    }
  }
  return { data, w, h, lawn, path, title };
}

test('vlakken op een gefotografeerd potloodplan', () => {
  const G = sandbox.window.Geo;
  const p = photoPlan();
  const r = L.areasFromPixels(p.data, p.w, p.h);
  assert.ok(r.normalized, 'belichting gecorrigeerd');
  const lawns = r.areas.filter((a) => a.type === 'lawn');
  assert.strictEqual(lawns.length, 1, 'één gazon');
  const la = G.area(lawns[0].points), expect = (p.lawn[2] - p.lawn[0]) * (p.lawn[3] - p.lawn[1]);
  assert.ok(Math.abs(la - expect) / expect < 0.12, `gazon ${la} ≈ ${expect}`);
  // het papier zelf en het titelblok zijn geen vlak
  for (const a of r.areas) {
    const b = G.bbox(a.points);
    assert.ok(b.w < 0.9 * p.w, `${a.type} beslaat niet het hele vel`);
    assert.ok(b.minY < p.title[1] - 5, `${a.type} ligt niet in het titelblok`);
  }
  // verharding rond het gazon: het gazon ligt niet binnen het verhardingsvlak (sleutelgat)
  const dry = r.areas.filter((a) => a.type === 'dry');
  assert.ok(dry.length >= 1, 'verharding herkend');
  const mid = { x: (p.lawn[0] + p.lawn[2]) / 2 + 10, y: (p.lawn[1] + p.lawn[3]) / 2 + 10 };
  assert.ok(!dry.some((d) => G.pointInPolygon(mid, d.points)), 'gazon niet als droog vlak');
  assert.ok(dry.some((d) => G.pointInPolygon({ x: 80, y: 100 }, d.points)), 'pad wel droog');
});

test('digitaal plan (egaal wit) wordt niet genormaliseerd', () => {
  const w = 200, h = 150;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 40; y < 110; y++) for (let x = 50; x < 150; x++) { const i = (y * w + x) * 4; data[i] = 0x8b; data[i + 1] = 0xc3; data[i + 2] = 0x4a; }
  const r = L.areasFromPixels(data, w, h);
  assert.ok(!r.normalized);
  const lawns = r.areas.filter((a) => a.type === 'lawn');
  assert.strictEqual(lawns.length, 1);
  assert.ok(Math.abs(sandbox.window.Geo.area(lawns[0].points) - 7000) < 700);
});

test('schaal 1:N herkennen', () => {
  const P = sandbox.window.PlanImport;
  assert.strictEqual(P.parseRatio('Schaal: 1:50'), 50);
  assert.strictEqual(P.parseRatio('schaal 1 : 100 datum 12-3'), 100);
  assert.strictEqual(P.parseRatio('1/200'), 200);
  assert.strictEqual(P.parseRatio('om 11:50 uur'), null);
  assert.strictEqual(P.parseRatio('1:12345'), null);
  assert.strictEqual(P.parseRatio('geen schaal'), null);
});

test('concept: schaal uit 1:N op papierformaat, tuinbreedte of aanname', () => {
  const Cn = sandbox.window.Concept;
  const areas = [{ type: 'lawn', points: [{ x: 100, y: 100 }, { x: 600, y: 100 }, { x: 600, y: 400 }, { x: 100, y: 400 }] }];
  const res = { scale: { metersPerPixel: null, method: 'schatting' }, areas, elements: [] };
  const img = { width: 1000, height: 700, factor: 1 };
  // A3 liggend (420 mm) op 1:50 = 21 m over 1000 px
  const a = Cn.build(res, { ...img, paper: { widthM: 0.42, ratio: 50 } });
  assert.ok(Math.abs(a.backgroundScale - 0.021) < 1e-9);
  assert.ok(!a.scaleInfo.estimated);
  // opgegeven tuinbreedte: 500 px = 8 m
  const b = Cn.build(res, img, { gardenWidthM: 8 });
  assert.ok(Math.abs(b.backgroundScale - 8 / 500) < 1e-9);
  // niets bekend: tuin 10 m breed aangenomen, en de app mag ernaar vragen
  const c = Cn.build(res, img);
  assert.ok(c.scaleInfo.estimated);
  assert.strictEqual(c.gardenWidthPx, 500);
  assert.ok(Math.abs(c.backgroundScale - Cn.FALLBACK_GARDEN_M / 500) < 1e-9);
  // een gevonden maat gaat voor
  const d = Cn.build({ ...res, scale: { metersPerPixel: 0.02, method: 'maatvoering', confidence: 'hoog' } }, { ...img, paper: { widthM: 0.42, ratio: 50 } });
  assert.strictEqual(d.backgroundScale, 0.02);
});

test('labels herkennen, ook slordig gelezen handschrift', () => {
  const t = (w) => { const m = L.matchLabel(w); return m ? m.type : null; };
  assert.strictEqual(t('gras'), 'lawn');
  assert.strictEqual(t('Gazon'), 'lawn');
  assert.strictEqual(t('gazn'), 'lawn'); // letter gemist
  assert.strictEqual(t('grasveld,'), 'lawn');
  assert.strictEqual(t('Terras'), 'dry');
  assert.strictEqual(t('teras'), 'dry');
  assert.strictEqual(t('WONING'), 'dry');
  assert.strictEqual(t('bordr'), 'bed');
  assert.strictEqual(t('beplantlng'), 'bed'); // i als l gelezen
  assert.strictEqual(t('haag'), 'hedge');
  assert.strictEqual(t('vijver'), 'wet');
  assert.strictEqual(t('grind'), 'wet');
  assert.strictEqual(t('plantenbak'), 'planter');
  assert.strictEqual(t('Rasen'), 'lawn');
  assert.strictEqual(t('ab'), null);
  assert.strictEqual(t('graf'), null); // kort woord: geen speling
  assert.strictEqual(t('12,00'), null);
});

test('labels uit meerdere OCR-rondes worden samengevoegd', () => {
  const words = [
    { text: 'gras', confidence: 70, bbox: { x0: 100, y0: 100, x1: 160, y1: 130 } },
    { text: 'gras', confidence: 90, bbox: { x0: 102, y0: 101, x1: 158, y1: 129 } },
    { text: 'terras', confidence: 80, bbox: { x0: 300, y0: 100, x1: 380, y1: 130 } },
    { text: 'xyz', confidence: 90, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
  ];
  const labels = L.labelsFromWords(words);
  assert.strictEqual(labels.length, 2);
  assert.strictEqual(labels.find((l) => l.type === 'lawn').conf, 90);
});

test('schaal: meeste en zekerste lezingen winnen, tegenstrijdigheid verlaagt betrouwbaarheid', () => {
  const k = (meters, px, conf, text) => ({ mpp: meters / px, meters, px, conf, text: text || String(meters) });
  const a = L.pickScale([k(12, 600, 90), k(12, 600, 80), k(42, 600, 78)], 1300);
  assert.ok(Math.abs(a.metersPerPixel - 0.02) < 1e-9);
  assert.strictEqual(a.confidence, 'laag');
  const b = L.pickScale([k(12, 600, 90), k(8.5, 425, 85)], 1300);
  assert.strictEqual(b.confidence, 'hoog');
  assert.strictEqual(L.pickScale([k(500, 10, 90)], 1300), null); // onwaarschijnlijk (650 km breed)
});
