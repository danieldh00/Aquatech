// Tests voor de meetlat van de planherkenning en de testbank (tools/recog-bench.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Metrics = require('../src/beregening/recog-metrics');
const { runBench, toWorkResolution } = require('../tools/recog-bench');

/**
 * Rechthoekig vlak.
 * @param {string} type De vlaksoort.
 * @param {number} left Links.
 * @param {number} top Boven.
 * @param {number} right Rechts.
 * @param {number} bottom Onder.
 * @returns {{type: string, points: object[]}} Het vlak.
 */
const box = (type, left, top, right, bottom) => ({ type, points: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }] });

test('identieke vlakken geven overlap 1 en geen verschillen', () => {
  const areas = [box('lawn', 100, 100, 400, 300), box('dry', 0, 0, 100, 100)];
  const result = Metrics.compareAreas(areas, areas, 500, 400);
  assert.strictEqual(result.lawnIou, 1);
  assert.strictEqual(result.accuracy, 1);
  assert.strictEqual(result.lawnRatio, 1);
  assert.deepStrictEqual(result.missing, []);
  assert.deepStrictEqual(result.extra, []);
});

test('verschoven gazon: gedeeltelijke overlap; gemiste en extra soorten worden genoemd', () => {
  const reference = [box('lawn', 100, 100, 300, 300), box('bed', 300, 100, 400, 300)];
  const found = [box('lawn', 200, 100, 400, 300), box('wet', 0, 0, 50, 50)];
  const result = Metrics.compareAreas(reference, found, 500, 400);
  assert.ok(result.lawnIou > 0.25 && result.lawnIou < 0.45, `iou ${result.lawnIou}`);
  assert.deepStrictEqual(result.missing, ['bed']);
  assert.deepStrictEqual(result.extra, ['wet']);
  assert.strictEqual(result.counts.lawn.reference, 1);
});

test('terras boven gazon: het gat in het gazon telt als droog', () => {
  const reference = [box('lawn', 0, 0, 400, 400), box('dry', 0, 0, 200, 400)];
  const found = [box('lawn', 0, 0, 400, 400)];
  const result = Metrics.compareAreas(reference, found, 400, 400);
  assert.ok(result.iou.dry === 0 && result.missing.includes('dry'));
  assert.ok(result.accuracy > 0.45 && result.accuracy < 0.55, `juist ${result.accuracy}`);
});

test('lege referentie en uitkomst geven null in plaats van een fout', () => {
  const result = Metrics.compareAreas([], [], 300, 300);
  assert.strictEqual(result.lawnIou, null);
  assert.strictEqual(result.accuracy, null);
  assert.strictEqual(result.lawnRatio, null);
});

test('schaalfout en elementafstand', () => {
  assert.strictEqual(Metrics.scaleError(0.02, 0.022).toFixed(2), '0.10');
  assert.strictEqual(Metrics.scaleError(null, 0.02), null);
  const distances = Metrics.elementDistances([{ kind: 'source', x: 0, y: 0 }, { kind: 'valvebox', x: 10, y: 10 }], [{ kind: 'source', x: 30, y: 40 }], 300, 400);
  assert.strictEqual(distances.source, 0.1);
  assert.strictEqual(distances.valvebox, null);
});

test('samenvatten telt alleen bestaande waarden', () => {
  const summary = Metrics.summarize([{ lawnIou: 0.8, accuracy: 0.9 }, { lawnIou: null, accuracy: 0.5 }, { lawnIou: 0.2, accuracy: null }]);
  assert.strictEqual(summary.drawings, 3);
  assert.ok(Math.abs(summary.meanLawnIou - 0.5) < 1e-9);
  assert.ok(Math.abs(summary.meanAccuracy - 0.7) < 1e-9);
  assert.strictEqual(summary.lawnFound, 1);
});

test('verkleinen naar werkresolutie bewaart de verhouding', () => {
  const data = new Uint8ClampedArray(2000 * 1000 * 4).fill(200);
  const work = toWorkResolution({ width: 2000, height: 1000, data });
  assert.strictEqual(work.width, 1000);
  assert.strictEqual(work.height, 500);
  assert.strictEqual(work.factor, 0.5);
  assert.strictEqual(work.data[0], 200);
});

test('testbank draait op het voorbeeldplan en vindt het gazon', () => {
  const result = runBench(path.join(__dirname, 'fixtures'));
  const row = result.rows.find((item) => item.name === 'tuinontwerp-voorbeeld');
  assert.ok(row, 'voorbeeldplan met referentie gevonden');
  // de referentie is een grove rechthoek, dus een ruime ondergrens; dit bewaakt dat het gazon op de goede plek ligt
  assert.ok(row.lawnIou > 0.45, `gazon-overlap ${row.lawnIou}`);
  assert.strictEqual(result.summary.lawnFound, result.summary.drawings);
});

test('een vlak met eigen laag ligt boven een lager vlak, ook als de soort lager in de volgorde staat', () => {
  /**
   * Een vierkant met de linkerbovenhoek op de oorsprong.
   * @param {number} size zijde in pixels
   * @returns {object[]} de vier hoekpunten
   */
  const square = (size) => [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }];
  const reference = [{ type: 'bed', layer: 5, points: square(100) }, { type: 'dry', layer: 1, points: square(100) }];
  const comparison = Metrics.compareAreas(reference, [{ type: 'bed', points: square(100) }], 100, 100);
  assert.strictEqual(comparison.accuracy, 1);
});

test('functionele nauwkeurigheid rekent bed en haag als dezelfde beregening', () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const comparison = Metrics.compareAreas([{ type: 'bed', points: square }], [{ type: 'hedge', points: square }], 100, 100);
  assert.strictEqual(comparison.accuracy, 0);
  assert.strictEqual(comparison.functionalAccuracy, 1);
});

test('plangenerator is deterministisch en levert een waarheid met een gazon', () => {
  const { buildPlan } = require('../tools/plan-generator');
  const first = buildPlan(7, { style: 'digitaal' });
  assert.strictEqual(first.svg, buildPlan(7, { style: 'digitaal' }).svg);
  assert.notStrictEqual(first.svg, buildPlan(8, { style: 'digitaal' }).svg);
  assert.ok(first.truth.areas.some((area) => area.type === 'lawn'));
  for (const area of first.truth.areas) assert.ok(area.points.length >= 3);
});

test('plangenerator houdt woning, terras en oprit binnen de tuinomtrek', () => {
  const { buildPlan } = require('../tools/plan-generator');
  for (let seed = 1; seed <= 60; seed++) {
    const garden = buildPlan(seed).truth.areas.find((area) => area.layer === 0);
    for (const area of buildPlan(seed).truth.areas.filter((item) => item.type === 'dry')) {
      for (const point of area.points) assert.ok(Metrics.insidePolygon(point.x, point.y, garden.points), `seed ${seed}: ${area.name} buiten de tuin`);
    }
  }
});
