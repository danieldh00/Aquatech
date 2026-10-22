// Unittests voor de lokale planherkenning (frontend-code, geladen in een sandbox).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONT = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const file of ['geometry.js', 'sprinklerlib.js', 'catalog.js', 'autotrace.js', 'planimport.js', 'concept.js', 'localrecog.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, file), 'utf8'), sandbox);
const LocalRecognizer = sandbox.window.LocalRecognizer;

test('maten lezen: eenheden en notaties', () => {
  assert.strictEqual(LocalRecognizer.parseLength('12,00', 'm'), 12);
  assert.strictEqual(LocalRecognizer.parseLength('12,00m'), 12);
  assert.strictEqual(LocalRecognizer.parseLength('8500'), 8.5); // mm op bouwtekening
  assert.strictEqual(LocalRecognizer.parseLength('450', 'cm'), 4.5);
  assert.strictEqual(LocalRecognizer.parseLength('3.5'), 3.5);
  assert.strictEqual(LocalRecognizer.parseLength('1250mm'), 1.25);
  assert.strictEqual(LocalRecognizer.parseLength('12'), null); // geheel getal zonder eenheid: te onzeker
  assert.strictEqual(LocalRecognizer.parseLength('abc'), null);
});

test('kleur naar vlaksoort', () => {
  /**
   * Kleur als #rrggbb naar [rood, groen, blauw].
   * @param {string} color De kleur.
   * @returns {number[]} De drie kanalen (0–255).
   */
  const hex = (color) => [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
  /**
   * Vlaktype dat de herkenning aan een kleur geeft.
   * @param {string} color De kleur als #rrggbb.
   * @returns {number} Typenummer (0 = geen).
   */
  const type = (color) => LocalRecognizer.classify(...hex(color));
  // 0 geen, 1 gazon, 2 haag, 3 beplanting, 4 droog, 5 nat
  for (const color of ['#8bc34a', '#7cb342', '#9ccc65', '#66bb6a']) assert.strictEqual(type(color), 1, color);
  for (const color of ['#2e7d32', '#1b5e20']) assert.strictEqual(type(color), 2, color);
  for (const color of ['#a1887f', '#8d6e63', '#f48fb1', '#ce93d8']) assert.strictEqual(type(color), 3, color);
  for (const color of ['#9e9e9e', '#bdbdbd', '#e8dcc2']) assert.strictEqual(type(color), 4, color);
  for (const color of ['#4fc3f7', '#1e88e5']) assert.strictEqual(type(color), 5, color);
  for (const color of ['#ffffff', '#000000', '#222222']) assert.strictEqual(type(color), 0, color);
});

test('maatlijn meten: lijn boven de tekst, onderbroken door de tekst', () => {
  const width = 300, height = 60;
  const gray = new Uint8Array(width * height).fill(255);
  // maatlijn op y=40 van x=20 tot 280, met gat waar de tekst staat (130–170)
  for (let x = 20; x <= 280; x++) if (x < 130 || x > 170) gray[40 * width + x] = 0;
  // tekst iets erboven
  for (let y = 25; y < 37; y++) for (let x = 132; x < 168; x += 3) gray[y * width + x] = 0;
  const line = LocalRecognizer.measureLine(gray, width, height, { x0: 130, y0: 24, x1: 170, y1: 38 });
  assert.ok(line, 'lijn gevonden');
  assert.strictEqual(line.len, 261);
});

test('maatlijn meten: tekst midden in een onderbreking van de lijn', () => {
  const width = 300, height = 60;
  const gray = new Uint8Array(width * height).fill(255);
  for (let x = 20; x <= 280; x++) if (x < 128 || x > 172) gray[30 * width + x] = 0;
  for (let y = 24; y < 37; y++) for (let x = 132; x < 168; x += 3) gray[y * width + x] = 0;
  const line = LocalRecognizer.measureLine(gray, width, height, { x0: 130, y0: 23, x1: 170, y1: 37 });
  assert.ok(line, 'lijn gevonden');
  assert.strictEqual(line.len, 261);
});

test('maatlijn meten: rand van een vlak die niet voorbij de tekst loopt telt niet', () => {
  const width = 300, height = 60;
  const gray = new Uint8Array(width * height).fill(255);
  for (let x = 125; x <= 175; x++) gray[42 * width + x] = 0; // korte rand net onder de tekst
  assert.strictEqual(LocalRecognizer.measureLine(gray, width, height, { x0: 130, y0: 24, x1: 170, y1: 38 }), null);
});

test('bleke potloodkleuren (genormaliseerd op het papier)', () => {
  /**
   * Vlaktype van een kleur met kanalen als fractie (0–1).
   * @param {number} red Rood.
   * @param {number} green Groen.
   * @param {number} blue Blauw.
   * @returns {number} Typenummer (0 = geen).
   */
  const classify = (red, green, blue) => LocalRecognizer.classify(red * 255, green * 255, blue * 255);
  assert.strictEqual(classify(0.94, 1.0, 0.86), 1); // lichtgroen potlood = gazon
  assert.strictEqual(classify(0.87, 0.94, 0.89), 0); // grijsgroen, licht (grind, vervaagd) ≠ gazon
  assert.strictEqual(classify(0.6, 0.89, 0.95), 2); // blauwgroen = heesters
  assert.strictEqual(classify(0.99, 0.96, 0.8), 4); // lichtgeel = terras
  assert.strictEqual(classify(1.0, 0.98, 0.76), 4); // geel = vlonder/veranda
  assert.strictEqual(classify(1.0, 0.9, 0.9), 4); // licht rood = schuur, baksteen
});

test('maten lezen: zwakke lezingen bij een weggevallen komma', () => {
  // via JSON: arrays uit de sandbox hebben een ander prototype
  /**
   * Lezingen van een maat als JSON: [[meters, sterk], ...].
   * @param {...string} args Tekst en eventueel eenheid.
   * @returns {string} De lezingen als JSON.
   */
  const readings = (...args) => JSON.stringify(LocalRecognizer.lengthReadings(...args).map((reading) => [reading.meters, reading.strong]));
  assert.strictEqual(readings('100', 'm'), '[[100,false],[10,false],[1,false]]');
  assert.strictEqual(readings('12,50', 'm'), '[[12.5,true]]');
  assert.strictEqual(readings('8 m'), '[[8,true]]');
  assert.strictEqual(readings('8500'), '[[8.5,false]]');
});

test('schaal kiezen: sterke lezing wint, losse zwakke alleen als plausibel', () => {
  const imageWidth = 1200;
  const strong = { mpp: 10 / 702, strong: true, text: '10,00 m', meters: 10, px: 702 };
  const weak = { mpp: 1.1 / 241, strong: false, text: '1100', meters: 1.1, px: 241 };
  assert.strictEqual(LocalRecognizer.pickScale([weak, strong], imageWidth).metersPerPixel, strong.mpp);
  // "100 m" over 592 px: 100 m geeft een plan van 200+ m, 1 m een van 2 m; 10 m is plausibel
  const lost = [100, 10, 1].map((meters) => ({ mpp: meters / 592, strong: false, text: '100 m', meters, px: 592 }));
  const picked = LocalRecognizer.pickScale(lost, imageWidth);
  assert.strictEqual(picked.metersPerPixel, 10 / 592);
  assert.strictEqual(picked.confidence, 'laag');
  // twee zwakke die overeenkomen: hoog
  const mm = [{ ...weak, mpp: 0.01, text: '4500', px: 450 }, { ...weak, mpp: 0.0101, text: '6000', px: 594 }];
  assert.strictEqual(LocalRecognizer.pickScale(mm, imageWidth).confidence, 'hoog');
  assert.strictEqual(LocalRecognizer.pickScale([], imageWidth), null);
});

// ---- synthetisch gefotografeerd potloodplan: grijs, ongelijk belicht papier, arcering, lijnen, titelblok
/**
 * Synthetisch gefotografeerd potloodplan.
 * @returns {{ data: Uint8ClampedArray, w: number, h: number, lawn: number[], path: number[], title: number[] }} Pixels (RGBA), afmetingen en de rechthoeken van gazon, pad en titelblok.
 */
function photoPlan() {
  const width = 400, height = 300;
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  /**
   * Volgende waarde van de vaste toevalsreeks.
   * @returns {number} Tussen 0 en 1.
   */
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  /**
   * Ligt het punt in de rechthoek?
   * @param {number} x Horizontale positie.
   * @param {number} y Verticale positie.
   * @param {number[]} box [links, boven, rechts, onder].
   * @returns {boolean} true als het punt erin ligt.
   */
  const inRect = (x, y, box) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
  const lawn = [120, 80, 280, 220], path = [60, 60, 340, 250], title = [250, 268, 395, 296];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const light = 0.5 + 0.2 * (x / width) + 0.08 * (y / height); // belichting loopt van 50% naar 78%
      let color = [255, 255, 250]; // papier
      if (inRect(x, y, path)) color = [200, 200, 200]; // grijze verharding rond het gazon
      if (inRect(x, y, lawn) && (x + y) % 4 < 3) color = [215, 240, 190]; // lichtgroene arcering met papier ertussen
      if (inRect(x, y, title) && (y % 7 === 0 || x % 50 === 0)) color = [60, 60, 60]; // titelblok: lijnen
      if (x === 150 || y === 150) color = [30, 30, 30]; // inktlijnen dwars door alles
      const noise = (random() - 0.5) * 8;
      const i = (y * width + x) * 4;
      data[i] = color[0] * light * 1.0 + noise; data[i + 1] = color[1] * light * 0.98 + noise; data[i + 2] = color[2] * light * 0.92 + noise; data[i + 3] = 255;
    }
  }
  return { data, w: width, h: height, lawn, path, title };
}

test('vlakken op een gefotografeerd potloodplan', () => {
  const Geo = sandbox.window.Geo;
  const plan = photoPlan();
  const result = LocalRecognizer.areasFromPixels(plan.data, plan.w, plan.h);
  assert.ok(result.normalized, 'belichting gecorrigeerd');
  const lawns = result.areas.filter((area) => area.type === 'lawn');
  assert.strictEqual(lawns.length, 1, 'één gazon');
  const lawnArea = Geo.area(lawns[0].points), expect = (plan.lawn[2] - plan.lawn[0]) * (plan.lawn[3] - plan.lawn[1]);
  assert.ok(Math.abs(lawnArea - expect) / expect < 0.12, `gazon ${lawnArea} ≈ ${expect}`);
  // het papier zelf en het titelblok zijn geen vlak
  for (const area of result.areas) {
    const box = Geo.bbox(area.points);
    assert.ok(box.w < 0.9 * plan.w, `${area.type} beslaat niet het hele vel`);
    assert.ok(box.minY < plan.title[1] - 5, `${area.type} ligt niet in het titelblok`);
  }
  // verharding rond het gazon: het gazon ligt niet binnen het verhardingsvlak (sleutelgat)
  const dry = result.areas.filter((area) => area.type === 'dry');
  assert.ok(dry.length >= 1, 'verharding herkend');
  const mid = { x: (plan.lawn[0] + plan.lawn[2]) / 2 + 10, y: (plan.lawn[1] + plan.lawn[3]) / 2 + 10 };
  assert.ok(!dry.some((area) => Geo.pointInPolygon(mid, area.points)), 'gazon niet als droog vlak');
  assert.ok(dry.some((area) => Geo.pointInPolygon({ x: 80, y: 100 }, area.points)), 'pad wel droog');
});

test('digitaal plan (egaal wit) wordt niet genormaliseerd', () => {
  const width = 200, height = 150;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 40; y < 110; y++) for (let x = 50; x < 150; x++) { const i = (y * width + x) * 4; data[i] = 0x8b; data[i + 1] = 0xc3; data[i + 2] = 0x4a; }
  const result = LocalRecognizer.areasFromPixels(data, width, height);
  assert.ok(!result.normalized);
  const lawns = result.areas.filter((area) => area.type === 'lawn');
  assert.strictEqual(lawns.length, 1);
  assert.ok(Math.abs(sandbox.window.Geo.area(lawns[0].points) - 7000) < 700);
});

test('schaal 1:N herkennen', () => {
  const PlanImport = sandbox.window.PlanImport;
  assert.strictEqual(PlanImport.parseRatio('Schaal: 1:50'), 50);
  assert.strictEqual(PlanImport.parseRatio('schaal 1 : 100 datum 12-3'), 100);
  assert.strictEqual(PlanImport.parseRatio('1/200'), 200);
  assert.strictEqual(PlanImport.parseRatio('om 11:50 uur'), null);
  assert.strictEqual(PlanImport.parseRatio('1:12345'), null);
  assert.strictEqual(PlanImport.parseRatio('geen schaal'), null);
});

test('concept: schaal uit 1:N op papierformaat, tuinbreedte of aanname', () => {
  const Concept = sandbox.window.Concept;
  const areas = [{ type: 'lawn', points: [{ x: 100, y: 100 }, { x: 600, y: 100 }, { x: 600, y: 400 }, { x: 100, y: 400 }] }];
  const res = { scale: { metersPerPixel: null, method: 'schatting' }, areas, elements: [] };
  const img = { width: 1000, height: 700, factor: 1 };
  // A3 liggend (420 mm) op 1:50 = 21 m over 1000 px
  const onPaper = Concept.build(res, { ...img, paper: { widthM: 0.42, ratio: 50 } });
  assert.ok(Math.abs(onPaper.backgroundScale - 0.021) < 1e-9);
  assert.ok(!onPaper.scaleInfo.estimated);
  // opgegeven tuinbreedte: 500 px = 8 m
  const withWidth = Concept.build(res, img, { gardenWidthM: 8 });
  assert.ok(Math.abs(withWidth.backgroundScale - 8 / 500) < 1e-9);
  // niets bekend: tuin 10 m breed aangenomen, en de app mag ernaar vragen
  const estimated = Concept.build(res, img);
  assert.ok(estimated.scaleInfo.estimated);
  assert.strictEqual(estimated.gardenWidthPx, 500);
  assert.ok(Math.abs(estimated.backgroundScale - Concept.FALLBACK_GARDEN_M / 500) < 1e-9);
  // een gevonden maat gaat voor
  const measured = Concept.build({ ...res, scale: { metersPerPixel: 0.02, method: 'maatvoering', confidence: 'hoog' } }, { ...img, paper: { widthM: 0.42, ratio: 50 } });
  assert.strictEqual(measured.backgroundScale, 0.02);
});

test('labels herkennen, ook slordig gelezen handschrift', () => {
  /**
   * Vlaktype van een (slordig gelezen) woord.
   * @param {string} word Het woord.
   * @returns {string|null} Het type, of null.
   */
  const typeOf = (word) => { const match = LocalRecognizer.matchLabel(word); return match ? match.type : null; };
  assert.strictEqual(typeOf('gras'), 'lawn');
  assert.strictEqual(typeOf('Gazon'), 'lawn');
  assert.strictEqual(typeOf('gazn'), 'lawn'); // letter gemist
  assert.strictEqual(typeOf('grasveld,'), 'lawn');
  assert.strictEqual(typeOf('Terras'), 'dry');
  assert.strictEqual(typeOf('teras'), 'dry');
  assert.strictEqual(typeOf('WONING'), 'dry');
  assert.strictEqual(typeOf('bordr'), 'bed');
  assert.strictEqual(typeOf('beplantlng'), 'bed'); // i als l gelezen
  assert.strictEqual(typeOf('haag'), 'hedge');
  assert.strictEqual(typeOf('vijver'), 'wet');
  assert.strictEqual(typeOf('grind'), 'wet');
  assert.strictEqual(typeOf('plantenbak'), 'planter');
  assert.strictEqual(typeOf('Rasen'), 'lawn');
  assert.strictEqual(typeOf('ab'), null);
  assert.strictEqual(typeOf('graf'), null); // kort woord: geen speling
  assert.strictEqual(typeOf('12,00'), null);
});

test('labels uit meerdere OCR-rondes worden samengevoegd', () => {
  const words = [
    { text: 'gras', confidence: 70, bbox: { x0: 100, y0: 100, x1: 160, y1: 130 } },
    { text: 'gras', confidence: 90, bbox: { x0: 102, y0: 101, x1: 158, y1: 129 } },
    { text: 'terras', confidence: 80, bbox: { x0: 300, y0: 100, x1: 380, y1: 130 } },
    { text: 'xyz', confidence: 90, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
  ];
  const labels = LocalRecognizer.labelsFromWords(words);
  assert.strictEqual(labels.length, 2);
  assert.strictEqual(labels.find((label) => label.type === 'lawn').conf, 90);
});

test('schaal: meeste en zekerste lezingen winnen, tegenstrijdigheid verlaagt betrouwbaarheid', () => {
  /**
   * Een lezing van een maat.
   * @param {number} meters Gelezen lengte.
   * @param {number} px Lengte van de maatlijn in pixels.
   * @param {number} conf Zekerheid van de OCR.
   * @param {string} [text] Gelezen tekst.
   * @returns {object} De lezing.
   */
  const reading = (meters, px, conf, text) => ({ mpp: meters / px, meters, px, conf, text: text || String(meters) });
  const contradicting = LocalRecognizer.pickScale([reading(12, 600, 90), reading(12, 600, 80), reading(42, 600, 78)], 1300);
  assert.ok(Math.abs(contradicting.metersPerPixel - 0.02) < 1e-9);
  assert.strictEqual(contradicting.confidence, 'laag');
  const agreeing = LocalRecognizer.pickScale([reading(12, 600, 90), reading(8.5, 425, 85)], 1300);
  assert.strictEqual(agreeing.confidence, 'hoog');
  assert.strictEqual(LocalRecognizer.pickScale([reading(500, 10, 90)], 1300), null); // onwaarschijnlijk (650 km breed)
});

// ---------------------------------------------------------------- echte tekening en leren

const { readPng } = require('./helpers/png');
const sandbox2 = { window: {}, console };
vm.createContext(sandbox2);
for (const file of ['geometry.js', 'sprinklerlib.js', 'catalog.js', 'autotrace.js', 'simulation.js', 'planner.js', 'planimport.js', 'concept.js', 'localrecog.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, file), 'utf8'), sandbox2);
const isolatedWindow = sandbox2.window;

test('tuinontwerp met watermerk, boom en logo: één gazon, rustige plaatsing', () => {
  // Voorbeeldplan van tuinontwerp-webshop.nl (500 × 500): gazon met een boomkroon en het watermerk
  // "Voorbeeld" erover, borders met getekende planten, een groen logo boven de tuin.
  const img = readPng(path.join(__dirname, 'fixtures', 'tuinontwerp-voorbeeld.png'));
  const res = isolatedWindow.LocalRecognizer.areasFromPixels(img.data, img.width, img.height, 1);
  const lawns = res.areas.filter((area) => area.type === 'lawn');
  assert.strictEqual(lawns.length, 1, 'één gazon, geen snippers in de borders');
  const bb = isolatedWindow.Geo.bbox(lawns[0].points);
  // gazon ligt ongeveer tussen x 200–400 en y 235–405 (het logo staat bij y < 90)
  assert.ok(bb.minX > 190 && bb.maxX < 410 && bb.minY > 225 && bb.maxY < 415, JSON.stringify(bb));
  assert.ok((bb.maxX - bb.minX) * (bb.maxY - bb.minY) > 0.8 * 190 * 160, 'gazon niet aangevreten door tekst');
  assert.ok(!res.areas.some((area) => isolatedWindow.Geo.bbox(area.points).maxY < 120), 'logo is geen vlak');
  // plaatsen op de schaal die Daniël opgaf (tuin 14 m breed)
  const built = isolatedWindow.Concept.build({ scale: {}, areas: res.areas, elements: [], local: true }, { width: 500, height: 500, factor: 1 }, { gardenWidthM: 14 });
  const lawn = built.areas.find((area) => area.type === 'lawn');
  const heads = isolatedWindow.Planner.autoPlace(lawn.pts, 'rotator', {});
  const evaluation = isolatedWindow.Planner.evaluate(lawn.pts, heads);
  assert.ok(heads.length <= 18, `${heads.length} koppen`);
  assert.ok(evaluation.du >= 0.65, `DU ${evaluation.du}`);
});

test('leren: kleur die de vaste regels niet als gazon zien, wordt na een voorbeeld wel gazon', () => {
  const width = 240, height = 160;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  /**
   * Kleurt een rechthoek in het beeld.
   * @param {number} x0 Links.
   * @param {number} y0 Boven.
   * @param {number} x1 Rechts.
   * @param {number} y1 Onder.
   * @param {number[]} color [rood, groen, blauw].
   */
  const rect = (x0, y0, x1, y1, [red, green, blue]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const index = (y * width + x) * 4; data[index] = red; data[index + 1] = green; data[index + 2] = blue; }
  };
  rect(20, 20, 150, 140, [150, 215, 205]); // gazon in een ongebruikelijke blauwgroene tint
  rect(160, 20, 220, 140, [160, 160, 160]); // terras
  const before = isolatedWindow.LocalRecognizer.areasFromPixels(data, width, height, 1);
  assert.ok(!before.areas.some((area) => area.type === 'lawn'), 'zonder leren geen gazon');
  // "AI-herkenning" van een ander plan met dezelfde kleuren
  const truth = [
    { type: 'lawn', points: [{ x: 20, y: 20 }, { x: 150, y: 20 }, { x: 150, y: 140 }, { x: 20, y: 140 }] },
    { type: 'dry', points: [{ x: 160, y: 20 }, { x: 220, y: 20 }, { x: 220, y: 140 }, { x: 160, y: 140 }] },
  ];
  const samples = isolatedWindow.LocalRecognizer.samplesFromPixels(data, width, height, truth);
  assert.strictEqual(samples.v, isolatedWindow.LocalRecognizer.FEATURE_VERSION);
  assert.ok(JSON.stringify(samples).length < 20000, 'klein: alleen tellingen');
  const after = isolatedWindow.LocalRecognizer.areasFromPixels(data, width, height, 1, { learned: { ...samples, examples: 1 } });
  const lawn = after.areas.find((area) => area.type === 'lawn');
  assert.ok(lawn, 'na leren gazon');
  const bb = isolatedWindow.Geo.bbox(lawn.points);
  assert.ok(Math.abs(bb.minX - 20) < 4 && Math.abs(bb.maxX - 150) < 4, JSON.stringify(bb));
  assert.ok(after.learnedShare > 0.5);
  // onbekende versie of te weinig bewijs: vaste regels
  const old = isolatedWindow.LocalRecognizer.areasFromPixels(data, width, height, 1, { learned: { ...samples, v: 0 } });
  assert.ok(!old.areas.some((area) => area.type === 'lawn'));
});
