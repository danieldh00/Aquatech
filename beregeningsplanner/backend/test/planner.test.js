// Unittests voor de sproeierplaatsing en de instelbare rotators (frontend-code, geladen in een sandbox).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONT = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['geometry.js', 'sprinklerlib.js', 'catalog.js', 'simulation.js', 'planner.js', 'concept.js', 'hydraulics.js', 'bom.js', 'editor.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, f), 'utf8'), sandbox);
const { Geo: G, Catalog: C, Planner: P, Simulation: S, Concept } = sandbox.window;

const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const L = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 5, y: 4 }, { x: 5, y: 9 }, { x: 0, y: 9 }];
// gekartelde rand, zoals uit de herkenning of de toverstaf
function jagged(pts, step, amp, seed = 1) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.ceil(len / step);
    for (let k = 0; k < n; k++) {
      const t = k / n, e = rnd() * amp;
      out.push({ x: a.x + (b.x - a.x) * t - ((b.y - a.y) / len) * e, y: a.y + (b.y - a.y) * t + ((b.x - a.x) / len) * e });
    }
  }
  return out;
}
const stats = (pts, heads) => S.simulate({ areas: [{ type: 'lawn', pts }], sprinklers: heads }, 0.2).stats;
const validRotator = (s) => {
  const m = C.rotatorModels[C.rotatorModelOf(s)];
  const set = C.rotatorArcSet(C.rotatorModelOf(s), s.arc);
  return s.r >= m.rMin - 1e-9 && s.r <= m.rMax + 1e-9 && s.arc >= set[0] && s.arc <= set[1];
};

test('rotator: kop, sector en worp blijven binnen het instelbereik', () => {
  const s = C.fitRotator({ type: 'rotator', r: 5.2, arc: 300 });
  assert.strictEqual(C.rotatorModelOf(s), 'MP2000');
  assert.strictEqual(s.arc, 270, '300° bestaat niet: dichtstbijzijnde sector 210–270°');
  const fixed = C.fitRotator({ type: 'rotator', model: 'MP1000', r: 6, arc: 180 });
  assert.strictEqual(fixed.r, 4.5, 'vaste kop: worp begrensd op het bereik van de kop');
  const corner = C.fitRotator({ type: 'rotator', r: 3.5, arc: 60 });
  assert.strictEqual(C.rotatorModelOf(corner), 'MPCORNER');
  assert.strictEqual(corner.arc, 60);
  const big = C.fitRotator({ type: 'rotator', model: 'MP3500', r: 10, arc: 360 });
  assert.strictEqual(big.arc, 210, 'MP3500 heeft geen 360°-kop');
  assert.match(C.rotatorSetting(s), /^MP2000 \(210–270°\) op 270° en 5,2 m$/);
  const spray = C.fitRotator({ type: 'spray', r: 1, arc: 33 });
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
  const codes = sandbox.window.BOM.build(state).map((i) => i.code);
  assert.ok(codes.includes('ROT-MPCORNER'));
  assert.ok(codes.includes('ROT-MP2000'));
  assert.ok(!codes.includes('ROT-MP1000'), 'gekozen kop gaat voor de automatische (4,2 m zou MP1000 zijn)');
});

test('rechttrekken: kartels weg, randen haaks', () => {
  const pts = jagged(L, 0.3, 0.3, 7);
  const simple = G.simplifyClosed(pts, 0.3);
  const out = G.regularize(simple, G.dominantAngle([simple]));
  assert.ok(out.length <= 7, `${out.length} hoekpunten`);
  assert.ok(Math.abs(G.area(out) - G.area(L)) / G.area(L) < 0.06);
  const clean = G.regularize(L, 0);
  assert.strictEqual(clean.length, 6, 'een nette vorm blijft gelijk');
});

test('plaatsing: rechthoek kop-tot-kop met hoek- en randkoppen', () => {
  const pts = rect(0, 0, 10, 12);
  const heads = P.autoPlace(pts, 'rotator');
  assert.ok(heads.length >= 4 && heads.length <= 16, `${heads.length} koppen`);
  for (const [x, y] of [[0, 0], [10, 0], [10, 12], [0, 12]]) {
    const h = heads.find((s) => Math.hypot(s.x - x, s.y - y) < 0.05);
    assert.ok(h, `kop op hoek ${x},${y}`);
    assert.strictEqual(h.arc, 90);
  }
  for (const h of heads) {
    assert.ok(validRotator(h), `rotator binnen bereik: ${h.r} m ${h.arc}°`);
    assert.ok(G.pointInPolygon(h, pts) || G.closestOnPolygon(h, pts).d < 0.05, 'kop in of op het vlak');
  }
  const st = stats(pts, heads);
  assert.ok(st.du > 0.85, `DU ${st.du}`);
});

test('plaatsing: gekarteld gazon geeft een rustige indeling met goede verdeling', () => {
  for (const [shape, max] of [[rect(0, 0, 6.5, 7), 10], [L, 14]]) {
    const pts = jagged(shape, 0.3, 0.3, 3);
    const heads = P.autoPlace(pts, 'rotator');
    assert.ok(heads.length <= max, `${heads.length} koppen (max ${max})`);
    const st = stats(pts, heads);
    assert.ok(st.du > 0.8, `DU ${st.du}`);
    assert.ok(st.dryPct < 5, `droog ${st.dryPct}%`);
    heads.forEach((h) => assert.ok(validRotator(h)));
  }
});

test('plaatsing: L-vorm krijgt een kop in de binnenhoek (270°)', () => {
  const heads = P.autoPlace(L, 'rotator');
  const inner = heads.find((s) => Math.hypot(s.x - 5, s.y - 4) < 0.05);
  assert.ok(inner, 'kop op de binnenhoek');
  assert.strictEqual(inner.arc, 270);
});

test('herkenning: lokaal herkende vlakken worden rechtgetrokken', () => {
  const pts = jagged(rect(0, 0, 400, 300), 10, 8, 5).map((p) => ({ x: p.x + 50, y: p.y + 50 }));
  const res = Concept.build(
    { local: true, scale: { metersPerPixel: 0.02, method: 'maatvoering', confidence: 'hoog' }, areas: [{ type: 'lawn', points: pts }], elements: [] },
    { width: 500, height: 400, factor: 1 },
  );
  const lawn = res.areas.find((a) => a.type === 'lawn');
  assert.ok(lawn.pts.length <= 6, `${lawn.pts.length} hoekpunten`);
});

test('herkenning: rechttrekken volgt bochten (ingezoomd blijft een vlak op de tekening)', () => {
  // gebogen gazonband, pixelranden van 5 cm, in een paar draaiingen
  for (const rot of [0, 10, 25, 45]) {
    const t = (rot * Math.PI) / 180, ring = [];
    for (let a = 0; a <= 90; a++) ring.push({ r: 14, a });
    for (let a = 90; a >= 0; a--) ring.push({ r: 9, a });
    const orig = ring.map(({ r, a }) => {
      const x = r * Math.cos((a * Math.PI) / 180), y = r * Math.sin((a * Math.PI) / 180);
      return { x: Math.round((x * Math.cos(t) - y * Math.sin(t)) * 20) / 20, y: Math.round((x * Math.sin(t) + y * Math.cos(t)) * 20) / 20 };
    });
    const areas = [{ type: 'lawn', pts: orig.map((p) => ({ ...p })) }, { type: 'bed', pts: rect(0, 0, 20, 1.5) }];
    Concept.straighten(areas);
    const dev = G.deviation(orig, areas[0].pts);
    assert.ok(dev <= 0.17, `draaiing ${rot}°: rand ${dev.toFixed(2)} m naast de tekening`);
    assert.ok(areas[0].pts.length <= 30, `${areas[0].pts.length} hoekpunten`);
  }
});

test('weergave: ingezoomd wordt alleen het zichtbare deel van de ondergrond getekend, op dezelfde plek', () => {
  const ed = Object.create(sandbox.window.Editor.prototype);
  ed.bgImg = { width: 2400, height: 1600 };
  const bg = { x: 1, y: 2, scale: 0.01 }; // 24 × 16 m
  for (const view of [{ x: 0, y: 0, scale: 40 }, { x: 10, y: 8, scale: 400 }, { x: 23.5, y: 17, scale: 200 }, { x: -50, y: -50, scale: 2 }]) {
    ed.view = view;
    const r = ed._bgSource(bg, 390, 600);
    if (!r) { assert.ok(view.x > 24, 'alleen leeg als de ondergrond buiten beeld is'); continue; }
    assert.ok(r.sx >= 0 && r.sy >= 0 && r.sx + r.sw <= 2400 && r.sy + r.sh <= 1600, 'binnen het beeld');
    assert.ok(r.dw <= 390 + 2 * 0.01 * view.scale + 1e-6 && r.dh <= 600 + 2 * 0.01 * view.scale + 1e-6, 'niet (veel) groter dan het canvas');
    // een beeldpixel komt op dezelfde schermplek als met het hele beeld
    const k = bg.scale * view.scale, o = ed.toScreen({ x: bg.x, y: bg.y });
    assert.ok(Math.abs(r.dx - (o.x + r.sx * k)) < 1e-6 && Math.abs(r.dy - (o.y + r.sy * k)) < 1e-6);
    assert.ok(Math.abs(r.dw / r.sw - k) < 1e-9 && Math.abs(r.dh / r.sh - k) < 1e-9);
  }
});

// band om een terras met een getrapte binnenrand (trapjes van ruim een meter) en een schuine buitenrand
const TERRAS = [[0, 0], [14, 0], [18, 2], [21, 5], [23, 9], [24, 14], [24, 20], [18, 20], [18, 15], [17, 15], [17, 13.8], [15.8, 13.8],
  [15.8, 12.5], [14.5, 12.5], [14.5, 11], [8, 11], [8, 9.8], [6.5, 9.8], [6.5, 8.5], [0, 8.5]].map(([x, y]) => ({ x, y }));
const minGap = (heads) => {
  let m = Infinity;
  for (let i = 0; i < heads.length; i++) for (let j = i + 1; j < heads.length; j++) m = Math.min(m, Math.hypot(heads[i].x - heads[j].x, heads[i].y - heads[j].y));
  return m;
};

test('plaatsing: geen kluitjes koppen langs een getrapte rand, weinig gele plekken', () => {
  // voorheen 20 rotators / 18 turbines met koppen op 1 m van elkaar op elk trapje
  for (const [type, max] of [['rotator', 14], ['spray', 24], ['rotor', 11]]) {
    const heads = P.autoPlace(TERRAS, type);
    assert.ok(heads.length <= max, `${type}: ${heads.length} koppen (max ${max})`);
    assert.ok(minGap(heads) > 2.5, `${type}: koppen op ${minGap(heads).toFixed(2)} m van elkaar`);
    const st = stats(TERRAS, heads);
    assert.ok(st.du > 0.72, `${type}: DU ${st.du}`);
    assert.ok(st.dryPct < 2, `${type}: droog ${st.dryPct}%`);
    const ev = P.evaluate(TERRAS, heads);
    assert.ok(ev.lowPct < 6, `${type}: geel ${ev.lowPct}%`);
  }
});

test('plaatsing: water buiten het gazon telt over de volle worp mee', () => {
  const pts = rect(0, 0, 10, 4);
  const near = P.evaluate(pts, [{ id: 'a', type: 'rotor', x: 5, y: 4, r: 3, start: 180, arc: 180 }]);
  const far = P.evaluate(pts, [{ id: 'a', type: 'rotor', x: 5, y: 4, r: 12, start: 180, arc: 180 }]);
  // halve cirkel van 12 m: ruim 200 m² valt buiten een gazon van 10 × 4 m
  assert.ok(far.outsideM2 > 150, `${far.outsideM2} m² buiten`);
  assert.ok(near.outsideM2 < far.outsideM2);
});

test('automatisch type: per gazon het beste sproeiertype, binnen de druk', () => {
  // groot rechthoekig gazon: turbines met de minste koppen
  const big = P.bestPlace(rect(0, 0, 25, 18), { pressure: 3.5 });
  assert.strictEqual(big.type, 'rotor');
  assert.strictEqual(big.results.map((r) => r.type).join(), 'rotator,spray,rotor');
  const own = big.results.find((r) => r.type === 'rotor');
  assert.ok(big.results.every((r) => r.score.cost >= own.score.cost), 'gekozen indeling is de goedkoopste');
  assert.ok(big.heads.every((h) => h.type === 'rotor'));
  // onregelmatig gazon langs een terras: turbines spuiten te veel naast het gazon, rotators winnen
  const terras = P.bestPlace(TERRAS, { pressure: 3.5 });
  assert.strictEqual(terras.type, 'rotator');
  // klein L-vormig gazon: geen turbines
  assert.notStrictEqual(P.bestPlace(L, { pressure: 3.5 }).type, 'rotor');
  // te weinig druk voor rotators (2,8 bar aan de kop): die doen niet mee
  const low = P.bestPlace(TERRAS, { pressure: 2.9 });
  assert.ok(!low.results.some((r) => r.type === 'rotator'));
  // alleen wat in het assortiment zit
  assert.strictEqual(P.bestPlace(L, { types: ['spray'], pressure: 3.5 }).results.map((r) => r.type).join(), 'spray');
});

test('neerslagkaart: elk gazon t.o.v. zijn eigen gemiddelde (rotators naast turbines)', () => {
  const a = rect(0, 0, 10, 8), b = rect(20, 0, 45, 18);
  const state = {
    areas: [{ type: 'lawn', pts: a }, { type: 'lawn', pts: b }],
    sprinklers: [...P.autoPlace(a, 'rotator'), ...P.autoPlace(b, 'rotor')],
  };
  const sim = S.simulate(state, 0.25);
  const own = sim.perArea.map((p) => p.stats.du);
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
  const res = P.tune(pts, heads);
  assert.ok(res.after.cost < res.before.cost, 'beter dan voorheen');
  assert.ok(res.after.outsideM2 < res.before.outsideM2, 'minder water buiten het gazon');
  res.heads.forEach((h, i) => {
    assert.deepStrictEqual([h.id, h.x, h.y], [heads[i].id, heads[i].x, heads[i].y]);
    assert.ok(validRotator(h));
  });
  const only = P.tune(pts, heads, ['h1']);
  assert.deepStrictEqual(only.heads.slice(1).map((h) => [h.r, h.arc, h.start]), heads.slice(1).map((h) => [h.r, h.arc, h.start]), 'alleen de gekozen kop wijzigt');
  assert.notDeepStrictEqual([only.heads[0].r, only.heads[0].arc, only.heads[0].start], [9, 120, 340]);
});

test('eigen assortiment: alleen artikelen die de organisatie heeft', () => {
  const Hy = sandbox.window.Hydraulics;
  const BOM = sandbox.window.BOM;
  try {
    // Zonder assortiment: alles beschikbaar.
    C.setAssortment(null);
    assert.ok(C.available('ROT-MP3500') && C.typeAvailable('rotor'));
    assert.strictEqual(C.pipes.length, 4);

    C.setAssortment(['ROT-MP2000', 'ROT-POP10-PRS', 'CON-ECO', 'PE-32', 'onbekend']);
    assert.strictEqual(C.assortment.size, 4, 'onbekende codes vallen af');
    // Buis: alleen de diameters die er zijn.
    assert.deepStrictEqual(Array.from(C.pipes, (p) => p.dn), [32]);
    // Sproeiertypes en rotatorkoppen.
    assert.ok(C.typeAvailable('rotator'));
    assert.ok(!C.typeAvailable('spray') && !C.typeAvailable('rotor'));
    assert.strictEqual(C.usableType('spray'), 'rotator');
    assert.strictEqual(C.autoRotatorModel(3, 180), 'MP2000', 'kop die er is, in plaats van MP1000');
    assert.strictEqual(C.rotatorModelOf({ type: 'rotator', r: 8, arc: 90, model: 'MP3000' }), 'MP2000');
    assert.deepStrictEqual(Object.keys(C.rotatorModelsAvailable()), ['MP2000']);
    // Planner plaatst alleen afstanden die de beschikbare kop haalt.
    const heads = P.autoPlace(rect(0, 0, 12, 8), 'rotator');
    assert.ok(heads.length > 0);
    for (const h of heads) assert.ok(h.r >= 4.0 - 1e-9 && h.r <= 6.4 + 1e-9, `worp ${h.r}`);

    // Stuklijst: alternatief waar dat kan (CON-FLEX -> CON-ECO), de rest ontbreekt.
    const st = {
      settings: { pressure: 3.5, flow: 2, level: 'expert', targetMm: 20, sessions: 3, methods: {} },
      areas: [{ id: 'a1', type: 'lawn', pts: rect(0, 0, 12, 8) }],
      elements: [{ id: 'e1', kind: 'source', x: -1, y: 4 }, { id: 'e2', kind: 'valvebox', x: 0, y: 4 }, { id: 'e3', kind: 'controller', x: 0, y: 5 }],
      sprinklers: heads, zones: [],
    };
    Hy.autoZones(st);
    Hy.calculate(st);
    const rows = BOM.build(st);
    const codes = rows.map((r) => r.code);
    for (const c of codes) assert.ok(C.available(c), `${c} hoort in het assortiment`);
    assert.ok(codes.includes('CON-ECO') && !codes.includes('CON-FLEX'));
    assert.ok(codes.includes('ROT-MP2000') && codes.includes('PE-32'));
    const missing = rows.missing.map((m) => m.code);
    assert.ok(missing.includes('VAL-24V') && missing.includes('FIT-T-32'), missing.join(','));
    assert.ok(!missing.includes('CON-FLEX'));
  } finally {
    C.setAssortment(null);
  }
  assert.strictEqual(C.pipes.length, 4, 'terug naar de standaardcatalogus');
});
