// Unittests voor de sproeierplaatsing en de instelbare rotators (frontend-code, geladen in een sandbox).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONT = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const file of ['geometry.js', 'sprinklerlib.js', 'catalog.js', 'simulation.js', 'planner.js', 'concept.js', 'hydraulics.js', 'bom.js', 'editor.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, file), 'utf8'), sandbox);
const { Geo, Catalog, Planner, Simulation, Concept } = sandbox.window;

/**
 * Rechthoek als lijst hoekpunten.
 * @param {number} x0 Links.
 * @param {number} y0 Boven.
 * @param {number} x1 Rechts.
 * @param {number} y1 Onder.
 * @returns {Array<{x: number, y: number}>} De vier hoekpunten.
 */
const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

// L-vormig gazon (10 × 9 m).
const L_SHAPE = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 5, y: 4 }, { x: 5, y: 9 }, { x: 0, y: 9 }];

/**
 * Gekartelde rand, zoals uit de herkenning of de toverstaf.
 * @param {Array<{x: number, y: number}>} points Hoekpunten van de veelhoek.
 * @param {number} step Afstand tussen de punten op de rand.
 * @param {number} amplitude Grootte van de kartels.
 * @param {number} [seed] Startwaarde van de (vaste) toevalsreeks.
 * @returns {Array<{x: number, y: number}>} De gekartelde rand.
 */
function jagged(points, step, amplitude, seed = 1) {
  let state = seed;
  /**
   * Volgende waarde van de vaste toevalsreeks.
   * @returns {number} Tussen -0,5 en 0,5.
   */
  const random = () => { state = (state * 16807) % 2147483647; return state / 2147483647 - 0.5; };
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const from = points[i], to = points[(i + 1) % points.length];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const count = Math.ceil(length / step);
    for (let j = 0; j < count; j++) {
      const fraction = j / count, offset = random() * amplitude;
      out.push({ x: from.x + (to.x - from.x) * fraction - ((to.y - from.y) / length) * offset, y: from.y + (to.y - from.y) * fraction + ((to.x - from.x) / length) * offset });
    }
  }
  return out;
}
/**
 * Simuleert de neerslag van koppen op een gazon.
 * @param {Array<{x: number, y: number}>} points Hoekpunten van het gazon.
 * @param {object[]} heads De sproeiers.
 * @returns {object} Statistiek van de simulatie (du, dryPct, ...).
 */
const stats = (points, heads) => Simulation.simulate({ areas: [{ type: 'lawn', pts: points }], sprinklers: heads }, 0.2).stats;
/**
 * Ligt een rotator binnen het instelbereik van zijn kop (worp en sector)?
 * @param {object} head De sproeier.
 * @returns {boolean} true als hij past.
 */
const validRotator = (head) => {
  const model = Catalog.rotatorModels[Catalog.rotatorModelOf(head)];
  const set = Catalog.rotatorArcSet(Catalog.rotatorModelOf(head), head.arc);
  return head.r >= model.rMin - 1e-9 && head.r <= model.rMax + 1e-9 && head.arc >= set[0] && head.arc <= set[1];
};

test('rotator: kop, sector en worp blijven binnen het instelbereik', () => {
  const fitted = Catalog.fitRotator({ type: 'rotator', r: 5.2, arc: 300 });
  assert.strictEqual(Catalog.rotatorModelOf(fitted), 'MP2000');
  assert.strictEqual(fitted.arc, 270, '300° bestaat niet: dichtstbijzijnde sector 210–270°');
  const fixed = Catalog.fitRotator({ type: 'rotator', model: 'MP1000', r: 6, arc: 180 });
  assert.strictEqual(fixed.r, 4.5, 'vaste kop: worp begrensd op het bereik van de kop');
  const corner = Catalog.fitRotator({ type: 'rotator', r: 3.5, arc: 60 });
  assert.strictEqual(Catalog.rotatorModelOf(corner), 'MPCORNER');
  assert.strictEqual(corner.arc, 60);
  const big = Catalog.fitRotator({ type: 'rotator', model: 'MP3500', r: 10, arc: 360 });
  assert.strictEqual(big.arc, 210, 'MP3500 heeft geen 360°-kop');
  assert.match(Catalog.rotatorSetting(fitted), /^MP2000 \(210–270°\) op 270° en 5,2 m$/);
  const spray = Catalog.fitRotator({ type: 'spray', r: 1, arc: 33 });
  assert.deepStrictEqual([spray.r, spray.arc], [1, 33], 'andere sproeiers blijven ongemoeid');
});

test('stuklijst: sproeikop volgt de gekozen MP-kop', () => {
  const state = {
    settings: { level: 'standard', pressure: 3.5, flow: 2 },
    areas: [{ id: 'a1', type: 'lawn', pts: rect(0, 0, 6, 6) }],
    sprinklers: [
      { id: 's1', type: 'rotator', x: 0, y: 0, r: 3.5, start: 0, arc: 60 },
      { id: 's2', type: 'rotator', model: 'MP2000', x: 6, y: 0, r: 4.2, start: 90, arc: 90 },
    ],
    elements: [], zones: [],
  };
  const codes = sandbox.window.BOM.build(state).map((row) => row.code);
  assert.ok(codes.includes('ROT-MPCORNER'));
  assert.ok(codes.includes('ROT-MP2000'));
  assert.ok(!codes.includes('ROT-MP1000'), 'gekozen kop gaat voor de automatische (4,2 m zou MP1000 zijn)');
});

test('rechttrekken: kartels weg, randen haaks', () => {
  const pts = jagged(L_SHAPE, 0.3, 0.3, 7);
  const simple = Geo.simplifyClosed(pts, 0.3);
  const out = Geo.regularize(simple, Geo.dominantAngle([simple]));
  assert.ok(out.length <= 7, `${out.length} hoekpunten`);
  assert.ok(Math.abs(Geo.area(out) - Geo.area(L_SHAPE)) / Geo.area(L_SHAPE) < 0.06);
  const clean = Geo.regularize(L_SHAPE, 0);
  assert.strictEqual(clean.length, 6, 'een nette vorm blijft gelijk');
});

test('plaatsing: rechthoek kop-tot-kop met hoek- en randkoppen', () => {
  const pts = rect(0, 0, 10, 12);
  const heads = Planner.autoPlace(pts, 'rotator');
  assert.ok(heads.length >= 4 && heads.length <= 16, `${heads.length} koppen`);
  for (const [x, y] of [[0, 0], [10, 0], [10, 12], [0, 12]]) {
    const corner = heads.find((head) => Math.hypot(head.x - x, head.y - y) < 0.05);
    assert.ok(corner, `kop op hoek ${x},${y}`);
    assert.strictEqual(corner.arc, 90);
  }
  for (const head of heads) {
    assert.ok(validRotator(head), `rotator binnen bereik: ${head.r} m ${head.arc}°`);
    assert.ok(Geo.pointInPolygon(head, pts) || Geo.closestOnPolygon(head, pts).d < 0.05, 'kop in of op het vlak');
  }
  const simulationStats = stats(pts, heads);
  assert.ok(simulationStats.du > 0.85, `DU ${simulationStats.du}`);
});

test('plaatsing: gekarteld gazon geeft een rustige indeling met goede verdeling', () => {
  for (const [shape, max] of [[rect(0, 0, 6.5, 7), 10], [L_SHAPE, 14]]) {
    const pts = jagged(shape, 0.3, 0.3, 3);
    const heads = Planner.autoPlace(pts, 'rotator');
    assert.ok(heads.length <= max, `${heads.length} koppen (max ${max})`);
    const simulationStats = stats(pts, heads);
    assert.ok(simulationStats.du > 0.8, `DU ${simulationStats.du}`);
    assert.ok(simulationStats.dryPct < 5, `droog ${simulationStats.dryPct}%`);
    heads.forEach((head) => assert.ok(validRotator(head)));
  }
});

test('plaatsing: L-vorm krijgt een kop in de binnenhoek (270°)', () => {
  const heads = Planner.autoPlace(L_SHAPE, 'rotator');
  const inner = heads.find((head) => Math.hypot(head.x - 5, head.y - 4) < 0.05);
  assert.ok(inner, 'kop op de binnenhoek');
  assert.strictEqual(inner.arc, 270);
});

test('herkenning: lokaal herkende vlakken worden rechtgetrokken', () => {
  const pts = jagged(rect(0, 0, 400, 300), 10, 8, 5).map((point) => ({ x: point.x + 50, y: point.y + 50 }));
  const res = Concept.build(
    { local: true, scale: { metersPerPixel: 0.02, method: 'maatvoering', confidence: 'hoog' }, areas: [{ type: 'lawn', points: pts }], elements: [] },
    { width: 500, height: 400, factor: 1 },
  );
  const lawn = res.areas.find((area) => area.type === 'lawn');
  assert.ok(lawn.pts.length <= 6, `${lawn.pts.length} hoekpunten`);
});

test('herkenning: rechttrekken volgt bochten (ingezoomd blijft een vlak op de tekening)', () => {
  // gebogen gazonband, pixelranden van 5 cm, in een paar draaiingen
  for (const rotation of [0, 10, 25, 45]) {
    const angle = (rotation * Math.PI) / 180, ring = [];
    for (let degrees = 0; degrees <= 90; degrees++) ring.push({ r: 14, a: degrees });
    for (let degrees = 90; degrees >= 0; degrees--) ring.push({ r: 9, a: degrees });
    const original = ring.map(({ r: radius, a: degrees }) => {
      const x = radius * Math.cos((degrees * Math.PI) / 180), y = radius * Math.sin((degrees * Math.PI) / 180);
      return { x: Math.round((x * Math.cos(angle) - y * Math.sin(angle)) * 20) / 20, y: Math.round((x * Math.sin(angle) + y * Math.cos(angle)) * 20) / 20 };
    });
    const areas = [{ type: 'lawn', pts: original.map((point) => ({ ...point })) }, { type: 'bed', pts: rect(0, 0, 20, 1.5) }];
    Concept.straighten(areas);
    const deviation = Geo.deviation(original, areas[0].pts);
    assert.ok(deviation <= 0.17, `draaiing ${rotation}°: rand ${deviation.toFixed(2)} m naast de tekening`);
    assert.ok(areas[0].pts.length <= 30, `${areas[0].pts.length} hoekpunten`);
  }
});

test('weergave: ingezoomd wordt alleen het zichtbare deel van de ondergrond getekend, op dezelfde plek', () => {
  const editor = Object.create(sandbox.window.Editor.prototype);
  editor.bgImg = { width: 2400, height: 1600 };
  const bg = { x: 1, y: 2, scale: 0.01 }; // 24 × 16 m
  for (const view of [{ x: 0, y: 0, scale: 40 }, { x: 10, y: 8, scale: 400 }, { x: 23.5, y: 17, scale: 200 }, { x: -50, y: -50, scale: 2 }]) {
    editor.view = view;
    const source = editor._bgSource(bg, 390, 600);
    if (!source) { assert.ok(view.x > 24, 'alleen leeg als de ondergrond buiten beeld is'); continue; }
    assert.ok(source.sx >= 0 && source.sy >= 0 && source.sx + source.sw <= 2400 && source.sy + source.sh <= 1600, 'binnen het beeld');
    assert.ok(source.dw <= 390 + 2 * 0.01 * view.scale + 1e-6 && source.dh <= 600 + 2 * 0.01 * view.scale + 1e-6, 'niet (veel) groter dan het canvas');
    // een beeldpixel komt op dezelfde schermplek als met het hele beeld
    const factor = bg.scale * view.scale, origin = editor.toScreen({ x: bg.x, y: bg.y });
    assert.ok(Math.abs(source.dx - (origin.x + source.sx * factor)) < 1e-6 && Math.abs(source.dy - (origin.y + source.sy * factor)) < 1e-6);
    assert.ok(Math.abs(source.dw / source.sw - factor) < 1e-9 && Math.abs(source.dh / source.sh - factor) < 1e-9);
  }
});

// band om een terras met een getrapte binnenrand (trapjes van ruim een meter) en een schuine buitenrand
const TERRAS = [[0, 0], [14, 0], [18, 2], [21, 5], [23, 9], [24, 14], [24, 20], [18, 20], [18, 15], [17, 15], [17, 13.8], [15.8, 13.8],
  [15.8, 12.5], [14.5, 12.5], [14.5, 11], [8, 11], [8, 9.8], [6.5, 9.8], [6.5, 8.5], [0, 8.5]].map(([x, y]) => ({ x, y }));
/**
 * Kleinste afstand tussen twee koppen.
 * @param {object[]} heads De sproeiers.
 * @returns {number} De afstand in meters.
 */
const minGap = (heads) => {
  let smallest = Infinity;
  for (let i = 0; i < heads.length; i++) for (let j = i + 1; j < heads.length; j++) smallest = Math.min(smallest, Math.hypot(heads[i].x - heads[j].x, heads[i].y - heads[j].y));
  return smallest;
};

test('plaatsing: geen kluitjes koppen langs een getrapte rand, weinig gele plekken', () => {
  // voorheen 20 rotators / 18 turbines met koppen op 1 m van elkaar op elk trapje
  for (const [type, max] of [['rotator', 14], ['spray', 30], ['rotor', 13]]) {
    const heads = Planner.autoPlace(TERRAS, type);
    assert.ok(heads.length <= max, `${type}: ${heads.length} koppen (max ${max})`);
    assert.ok(minGap(heads) > 2.5, `${type}: koppen op ${minGap(heads).toFixed(2)} m van elkaar`);
    const simulationStats = stats(TERRAS, heads);
    assert.ok(simulationStats.du > 0.72, `${type}: DU ${simulationStats.du}`);
    assert.ok(simulationStats.dryPct < 2, `${type}: droog ${simulationStats.dryPct}%`);
    const evaluation = Planner.evaluate(TERRAS, heads);
    assert.ok(evaluation.lowPct < 6, `${type}: geel ${evaluation.lowPct}%`);
  }
});

/**
 * Deel van het gazon dat groen kleurt op de neerslagkaart (85–130% van het gemiddelde).
 * @param {Array<{x: number, y: number}>} points Hoekpunten van het gazon.
 * @param {object[]} heads De sproeiers.
 * @returns {number} Percentage groen.
 */
const greenPct = (points, heads) => {
  const sim = Simulation.simulate({ areas: [{ type: 'lawn', pts: points }], sprinklers: heads }, 0.25);
  let total = 0, green = 0;
  for (let index = 0; index < sim.values.length; index++) {
    if (sim.mask[index] !== 1) continue;
    total++;
    const ratio = sim.values[index] / sim.stats.mean;
    if (ratio >= 0.85 && ratio <= 1.3) green++;
  }
  return (100 * green) / total;
};

test('plaatsing: neerslagkaart nagenoeg helemaal groen', () => {
  // 0.67.0: 78–80% groen op onregelmatige gazons
  for (const [pts, min] of [[TERRAS, 92], [rect(0, 0, 12, 8), 97], [L_SHAPE, 97], [rect(0, 0, 25, 18), 96]]) {
    const res = Planner.bestPlace(pts, { pressure: 3.5 });
    const green = greenPct(pts, res.heads);
    assert.ok(green >= min, `${res.type}: ${green.toFixed(1)}% groen (min ${min}%)`);
  }
});

test('plaatsing: water op een vlak dat droog moet blijven telt zwaarder', () => {
  const pts = rect(0, 0, 10, 4);
  const head = [{ id: 'a', type: 'rotator', x: 5, y: 4, r: 6, start: 180, arc: 180 }];
  const plain = Planner.evaluate(pts, head);
  const terrace = Planner.autoPlace(pts, 'rotator', { dry: [rect(-5, -8, 15, 0)] });
  const sim = Simulation.simulate({ areas: [{ type: 'lawn', pts }, { type: 'dry', pts: rect(-5, -8, 15, 0) }], sprinklers: terrace }, 0.2);
  assert.ok(plain.outsideM2 > 0);
  assert.ok(sim.overspray < 4, `${sim.overspray} m² op het terras`);
});

test('plaatsing: water buiten het gazon telt over de volle worp mee', () => {
  const pts = rect(0, 0, 10, 4);
  const near = Planner.evaluate(pts, [{ id: 'a', type: 'rotor', x: 5, y: 4, r: 3, start: 180, arc: 180 }]);
  const far = Planner.evaluate(pts, [{ id: 'a', type: 'rotor', x: 5, y: 4, r: 12, start: 180, arc: 180 }]);
  // halve cirkel van 12 m: ruim 200 m² valt buiten een gazon van 10 × 4 m
  assert.ok(far.outsideM2 > 150, `${far.outsideM2} m² buiten`);
  assert.ok(near.outsideM2 < far.outsideM2);
});

test('automatisch type: per gazon het beste sproeiertype, binnen de druk', () => {
  // groot rechthoekig gazon: turbines met de minste koppen
  const big = Planner.bestPlace(rect(0, 0, 25, 18), { pressure: 3.5 });
  assert.strictEqual(big.type, 'rotor');
  assert.strictEqual(big.results.map((result) => result.type).join(), 'rotator,spray,rotor');
  const own = big.results.find((result) => result.type === 'rotor');
  assert.ok(big.results.every((result) => result.score.cost >= own.score.cost), 'gekozen indeling is de goedkoopste');
  assert.ok(big.heads.every((head) => head.type === 'rotor'));
  // onregelmatig gazon langs een terras: turbines spuiten te veel naast het gazon, rotators winnen
  const terras = Planner.bestPlace(TERRAS, { pressure: 3.5 });
  assert.strictEqual(terras.type, 'rotator');
  // klein L-vormig gazon: geen turbines
  assert.notStrictEqual(Planner.bestPlace(L_SHAPE, { pressure: 3.5 }).type, 'rotor');
  // te weinig druk voor rotators (2,8 bar aan de kop): die doen niet mee
  const low = Planner.bestPlace(TERRAS, { pressure: 2.9 });
  assert.ok(!low.results.some((result) => result.type === 'rotator'));
  // alleen wat in het assortiment zit
  assert.strictEqual(Planner.bestPlace(L_SHAPE, { types: ['spray'], pressure: 3.5 }).results.map((result) => result.type).join(), 'spray');
});

test('neerslagkaart: elk gazon t.o.v. zijn eigen gemiddelde (rotators naast turbines)', () => {
  const smallLawn = rect(0, 0, 10, 8), bigLawn = rect(20, 0, 45, 18);
  const state = {
    areas: [{ type: 'lawn', pts: smallLawn }, { type: 'lawn', pts: bigLawn }],
    sprinklers: [...Planner.autoPlace(smallLawn, 'rotator'), ...Planner.autoPlace(bigLawn, 'rotor')],
  };
  const sim = Simulation.simulate(state, 0.25);
  const own = sim.perArea.map((area) => area.stats.du);
  assert.ok(sim.stats.du >= Math.min(...own) - 0.02, `DU ${sim.stats.du} vs per gazon ${own}`);
  assert.ok(sim.areaMean[0] > 0 && sim.areaMean[1] > 0);
});

test('afstellen: te ruim ingestelde koppen worden bijgesteld, positie blijft', () => {
  const pts = rect(0, 0, 8, 6);
  const heads = [
    { id: 'h1', type: 'rotator', x: 0, y: 0, r: 9, start: 340, arc: 120 },
    { id: 'h2', type: 'rotator', x: 8, y: 0, r: 9, start: 90, arc: 90 },
    { id: 'h3', type: 'rotator', x: 8, y: 6, r: 9, start: 180, arc: 90 },
    { id: 'h4', type: 'rotator', x: 0, y: 6, r: 9, start: 270, arc: 90 },
  ];
  const res = Planner.tune(pts, heads);
  assert.ok(res.after.cost < res.before.cost, 'beter dan voorheen');
  assert.ok(res.after.outsideM2 < res.before.outsideM2, 'minder water buiten het gazon');
  res.heads.forEach((head, i) => {
    assert.deepStrictEqual([head.id, head.x, head.y], [heads[i].id, heads[i].x, heads[i].y]);
    assert.ok(validRotator(head));
  });
  const only = Planner.tune(pts, heads, ['h1']);
  assert.deepStrictEqual(only.heads.slice(1).map((head) => [head.r, head.arc, head.start]), heads.slice(1).map((head) => [head.r, head.arc, head.start]), 'alleen de gekozen kop wijzigt');
  assert.notDeepStrictEqual([only.heads[0].r, only.heads[0].arc, only.heads[0].start], [9, 120, 340]);
});

test('eigen assortiment: alleen artikelen die de organisatie heeft', () => {
  const Hydraulics = sandbox.window.Hydraulics;
  const BOM = sandbox.window.BOM;
  try {
    // Zonder assortiment: alles beschikbaar.
    Catalog.setAssortment(null);
    assert.ok(Catalog.available('ROT-MP3500') && Catalog.typeAvailable('rotor'));
    assert.strictEqual(Catalog.pipes.length, 4);

    Catalog.setAssortment(['ROT-MP2000', 'ROT-POP10-PRS', 'CON-ECO', 'PE-32', 'onbekend']);
    assert.strictEqual(Catalog.assortment.size, 4, 'onbekende codes vallen af');
    // Buis: alleen de diameters die er zijn.
    assert.deepStrictEqual(Array.from(Catalog.pipes, (pipe) => pipe.dn), [32]);
    // Sproeiertypes en rotatorkoppen.
    assert.ok(Catalog.typeAvailable('rotator'));
    assert.ok(!Catalog.typeAvailable('spray') && !Catalog.typeAvailable('rotor'));
    assert.strictEqual(Catalog.usableType('spray'), 'rotator');
    assert.strictEqual(Catalog.autoRotatorModel(3, 180), 'MP2000', 'kop die er is, in plaats van MP1000');
    assert.strictEqual(Catalog.rotatorModelOf({ type: 'rotator', r: 8, arc: 90, model: 'MP3000' }), 'MP2000');
    assert.deepStrictEqual(Object.keys(Catalog.rotatorModelsAvailable()), ['MP2000']);
    // Planner plaatst alleen afstanden die de beschikbare kop haalt.
    const heads = Planner.autoPlace(rect(0, 0, 12, 8), 'rotator');
    assert.ok(heads.length > 0);
    for (const head of heads) assert.ok(head.r >= 4.0 - 1e-9 && head.r <= 6.4 + 1e-9, `worp ${head.r}`);

    // Stuklijst: alternatief waar dat kan (CON-FLEX -> CON-ECO), de rest ontbreekt.
    const state = {
      settings: { pressure: 3.5, flow: 2, level: 'expert', targetMm: 20, sessions: 3, methods: {} },
      areas: [{ id: 'a1', type: 'lawn', pts: rect(0, 0, 12, 8) }],
      elements: [{ id: 'e1', kind: 'source', x: -1, y: 4 }, { id: 'e2', kind: 'valvebox', x: 0, y: 4 }, { id: 'e3', kind: 'controller', x: 0, y: 5 }],
      sprinklers: heads, zones: [],
    };
    Hydraulics.autoZones(state);
    Hydraulics.calculate(state);
    const rows = BOM.build(state);
    const codes = rows.map((row) => row.code);
    for (const code of codes) assert.ok(Catalog.available(code), `${code} hoort in het assortiment`);
    assert.ok(codes.includes('CON-ECO') && !codes.includes('CON-FLEX'));
    assert.ok(codes.includes('ROT-MP2000') && codes.includes('PE-32'));
    const missing = rows.missing.map((row) => row.code);
    assert.ok(missing.includes('VAL-24V') && missing.includes('FIT-T-32'), missing.join(','));
    assert.ok(!missing.includes('CON-FLEX'));
  } finally {
    Catalog.setAssortment(null);
  }
  assert.strictEqual(Catalog.pipes.length, 4, 'terug naar de standaardcatalogus');
});
