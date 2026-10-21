// Unittests voor de sproeierplaatsing en de instelbare rotators (frontend-code, geladen in een sandbox).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONT = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['geometry.js', 'catalog.js', 'simulation.js', 'planner.js', 'concept.js', 'hydraulics.js', 'bom.js', 'editor.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, f), 'utf8'), sandbox);
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
