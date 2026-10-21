// Sproeierbibliotheek: behuizingen en nozzles (rekenkern, planner, stuklijst) en de opslag per omgeving.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');

const Lib = require('../../frontend/beregening/js/sprinklerlib.js');
const FRONT = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['geometry.js', 'sprinklerlib.js', 'catalog.js', 'simulation.js', 'planner.js', 'hydraulics.js', 'bom.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, f), 'utf8'), sandbox);
const { Catalog: C, Planner: P, Simulation: S, BOM } = sandbox.window;

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

test('bibliotheek: standaarddata is geldig en Excel heen en terug verandert niets', () => {
  const d = Lib.sanitize(Lib.DEFAULTS);
  assert.deepStrictEqual(d.problems, []);
  for (const k of ['RB-1804-PRS', 'RB-1806-P45', 'RB-1812-PRS', 'HU-PROS04-PRS40', 'RB-5004-PC', 'RB-5012-PC']) assert.ok(d.bodies.some((b) => b.key === k), k);
  for (const k of ['MP1000', 'MP3000', 'MP3500', 'HE-VAN-12', 'RB5000-3.0']) assert.ok(d.nozzles.some((n) => n.key === k), k);
  const sheets = Lib.toSheets(Lib.merge(null));
  const withHead = Object.fromEntries(Object.entries(sheets).map(([k, rows]) => [k, [Lib.SHEETS[k].map((c) => c[0]), ...rows]]));
  const back = Lib.sanitize(Lib.fromSheets(withHead));
  assert.deepStrictEqual(back.problems, []);
  assert.strictEqual(JSON.stringify(back.nozzles), JSON.stringify(d.nozzles));
  assert.strictEqual(JSON.stringify(back.bodies), JSON.stringify(d.bodies));
});

test('bibliotheek: invoer controleren, prestaties tussen de meetpunten', () => {
  const out = Lib.sanitize({
    bodies: [{ key: 'X 1', name: 'fout' }, { key: 'POP20', name: 'Pop-up 20 cm', regBar: '2,8', popup: '20', active: 'ja' }],
    nozzles: [
      { key: 'N1', group: 'rotator', arcs: '90-210; 360', perf: [{ bar: 3, r: 6, q: 400 }, { bar: 2, r: 5, q: 300 }] },
      { key: 'N2', group: 'sproeier', arcs: '360', perf: [{ bar: 2, r: 3, q: 100 }] },
      { key: 'N3', group: 'spray', arcs: '', perf: [{ bar: 2, r: 3, q: 100 }] },
      { key: 'N4', group: 'rotor', arcs: '40-360', perf: [] },
    ],
  });
  assert.deepStrictEqual(out.bodies.map((b) => [b.key, b.regBar, b.popup]), [['POP20', 2.8, 20]]);
  assert.deepStrictEqual(out.nozzles.map((n) => n.key), ['N1']);
  assert.strictEqual(out.problems.length, 4);
  const n = out.nozzles[0];
  assert.deepStrictEqual(n.arcs, [[90, 210], [360, 360]]);
  assert.deepStrictEqual(n.perf.map((p) => p.bar), [2, 3], 'gesorteerd op druk');
  assert.deepStrictEqual(Lib.perfAt(n, 2.5), { r: 5.5, q: 350, bar: 2.5 });
  assert.strictEqual(Lib.perfAt(n, 9).r, 6, 'buiten het bereik: dichtstbijzijnde meetpunt');
  // matched: debiet schaalt met hoek en worp², rotornozzle: per nozzle
  assert.strictEqual(Lib.flowLph(n, 6, 180, 3), 200);
  assert.strictEqual(Lib.flowLph(n, 3, 360, 3), 100);
  const rotor = Lib.DEFAULTS.nozzles.find((x) => x.key === 'RB5000-3.0');
  assert.strictEqual(Lib.flowLph(rotor, 10, 90, 3), Lib.flowLph(rotor, 11, 270, 3));
  // eigen regels gaan voor de standaard, actief = nee verbergt
  const merged = Lib.merge({ bodies: [], nozzles: [{ ...Lib.DEFAULTS.nozzles[0], price: 99 }, { ...Lib.DEFAULTS.nozzles[1], active: false }] });
  assert.strictEqual(merged.nozzles.find((x) => x.key === Lib.DEFAULTS.nozzles[0].key).price, 99);
  assert.ok(!merged.nozzles.some((x) => x.key === Lib.DEFAULTS.nozzles[1].key));
});

test('planner: zelf gekozen behuizing en nozzle bepalen bereik, debiet, druk en stuklijst', () => {
  C.setLibrary(null);
  // HE-VAN-12 op een 1812 PRS (30 cm, 2,1 bar): worp 2,8–3,7 m, hoek 0–360
  const s = C.fitHead({ type: 'spray', body: 'RB-1812-PRS', model: 'HE-VAN-12', r: 5, arc: 180, x: 0, y: 0, start: 0 });
  assert.strictEqual(s.r, 3.7, 'worp begrensd op de nozzle');
  assert.strictEqual(C.headMinBar(s), 2.1, 'drukregeling van het huis');
  assert.ok(Math.abs(C.headPr(s) - 40) < 0.5, `neerslag ${C.headPr(s)}`);
  // generieke sproeier zonder behuizing blijft zoals hij was
  const g = C.fitHead({ type: 'spray', r: 5.2, arc: 33 });
  assert.deepStrictEqual([g.r, g.arc], [5.2, 33]);
  // 5004 zonder gekozen nozzle: automatisch een Rain Curtain-nozzle die bij de worp past
  const rotor = C.fitHead({ type: 'rotor', body: 'RB-5004-PC', r: 12, arc: 180 });
  const n = C.nozzleOf(rotor);
  assert.ok(n && n.mount === 'rb5000' && n.group === 'rotor');
  assert.ok(C.sprinklerFlowLph(rotor) > 0);
  // stuklijst: huis en nozzle uit de bibliotheek; generiek blijft generiek
  const state = {
    settings: { level: 'expert', pressure: 4, flow: 3 },
    areas: [{ id: 'a1', type: 'lawn', pts: rect(0, 0, 8, 8) }],
    sprinklers: [
      { id: 's1', type: 'spray', body: 'RB-1812-PRS', model: 'HE-VAN-12', x: 0, y: 0, r: 3.7, start: 0, arc: 90 },
      { id: 's2', type: 'rotator', body: 'HU-PROS04-PRS40', model: 'MP2000', x: 8, y: 0, r: 5, start: 90, arc: 90 },
      { id: 's3', type: 'rotator', x: 8, y: 8, r: 4, start: 180, arc: 90 },
    ],
    elements: [], zones: [],
  };
  const codes = BOM.build(state).map((i) => i.code);
  for (const c of ['RB-1812-PRS', 'RB-HEVAN12', 'HU-PROS04-PRS40', 'ROT-MP2000', 'ROT-POP10-PRS', 'ROT-MP1000']) assert.ok(codes.includes(c), c);
  assert.ok(!codes.includes('SPR-VAN'));
});

test('planner: eigen bibliotheek van de organisatie (setLibrary)', () => {
  const own = {
    bodies: [{ key: 'POP20', brand: 'Eigen', name: 'Pop-up 20 cm', code: 'EIGEN-POP20', popup: 20, mount: 'sproeikop', regBar: 2.8, price: 12 }],
    nozzles: [{ key: 'MP3000', brand: 'Hunter', name: 'MP3000', code: 'ROT-MP3000', group: 'rotator', arcs: '90-210; 210-270; 360', rMin: 6.7, bar: 2.8, perf: [{ bar: 2.8, r: 9.5, q: 900 }] }],
  };
  C.setLibrary(own);
  try {
    assert.strictEqual(C.rotatorModels.MP3000.rMax, 9.5, 'eigen prestaties gaan voor');
    assert.ok(C.bodies.POP20 && C.articles['EIGEN-POP20'] && C.articles['EIGEN-POP20'].price === 12);
    assert.ok(C.bodiesFor('rotator').some((b) => b.key === 'POP20'));
    assert.ok(!C.bodiesFor('rotator').some((b) => b.key === 'RB-5004-PC'), 'een rotor past niet op een MP');
  } finally {
    C.setLibrary(null);
  }
  assert.strictEqual(C.rotatorModels.MP3000.rMax, 9.1);
});

test('automatisch plaatsen: volle worp over de breedte van het gazon', () => {
  C.setLibrary(null);
  const stats = (pts, heads) => S.simulate({ areas: [{ type: 'lawn', pts }], sprinklers: heads }, 0.2).stats;
  // 30 × 12 m: vroeger 18 koppen op 6 m, nu grotere koppen met minder stuks
  const lawn = rect(0, 0, 30, 12);
  const heads = P.autoPlace(lawn, 'rotator');
  assert.ok(heads.length <= 15, `${heads.length} koppen`);
  assert.ok(Math.max(...heads.map((h) => h.r)) >= 9, 'grote MP-koppen benut');
  const st = stats(lawn, heads);
  assert.ok(st.du > 0.75 && st.dryPct < 3, `DU ${st.du}, droog ${st.dryPct}%`);
  // 20 × 15 m: kop-tot-kop met MP3000/MP3500, geen raster van kleine koppen
  const wide = P.autoPlace(rect(0, 0, 20, 15), 'rotator');
  assert.ok(wide.length <= 10, `${wide.length} koppen`);
  // met een gekozen behuizing krijgt elke kop die behuizing
  const withBody = P.autoPlace(rect(0, 0, 10, 8), 'rotator', { body: 'HU-PROS04-PRS40' });
  assert.ok(withBody.every((h) => h.body === 'HU-PROS04-PRS40'));
  // turbinesproeiers op een 5004: Rain Curtain-nozzles tot ca. 14 m
  const big = P.autoPlace(rect(0, 0, 40, 28), 'rotor', { body: 'RB-5004-PC' });
  assert.ok(big.length && big.every((h) => C.nozzleOf(h) && C.nozzleOf(h).mount === 'rb5000'));
  assert.ok(Math.max(...big.map((h) => h.r)) > 12, 'grote worp van de rotor benut');
});

async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW }, { mustChangePassword: false });
  const groen = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant;
  await store.createAccount(groen.id, { username: 'gert', displayName: 'Gert', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, org) => {
    const jar = new Map();
    const call = async (method, p, body) => {
      const headers = {};
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    if (username) {
      const r = await call('POST', '/api/auth/login', { username, password: PW, tenant: org });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    }
    return { get: (p) => call('GET', p), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
  };
  return { db, server, as };
}

test('API sproeierbibliotheek: inlezen, rechten, andere organisatie en terug naar standaard', async () => {
  const { db, server, as } = await setup();
  try {
    const anon = await as(null);
    assert.strictEqual((await anon.get('/api/sprinkler-library')).status, 401);
    const baas = await as('baas');
    const kees = await as('kees');
    const gert = await as('gert', 'groen');
    assert.deepStrictEqual((await kees.get('/api/sprinkler-library')).body, { own: null, updatedAt: null });

    const file = Lib.toSheets(Lib.merge(null));
    const sheets = Object.fromEntries(Object.entries(file).map(([k, rows]) => [k, [Lib.SHEETS[k].map((c) => c[0]), ...rows]]));
    const raw = Lib.fromSheets(sheets);
    raw.bodies.push({ key: 'POP20', brand: 'Eigen', name: 'Pop-up 20 cm', code: 'EIGEN-POP20', popup: 20, mount: 'sproeikop', regBar: 2.8 });
    raw.nozzles.find((n) => n.key === 'MP3000').price = 11;
    raw.nozzles.push({ key: 'kapot', group: 'x' });

    assert.strictEqual((await kees.put('/api/sprinkler-library', raw)).status, 403, 'installateur mag niet inlezen');
    const put = await baas.put('/api/sprinkler-library', raw);
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.counts.own, 2, 'alleen afwijkingen van de standaard opgeslagen');
    assert.strictEqual(put.body.problems.length, 1);
    const rows = db.prepare('SELECT kind, key FROM sprinkler_library ORDER BY kind, key').all().map((r) => `${r.kind}:${r.key}`);
    assert.deepStrictEqual(rows, ['body:POP20', 'nozzle:MP3000']);

    const seen = await kees.get('/api/sprinkler-library');
    assert.deepStrictEqual(seen.body.own.bodies.map((b) => b.key), ['POP20']);
    assert.deepStrictEqual((await gert.get('/api/sprinkler-library')).body.own, null, 'andere organisatie ziet niets');
    assert.strictEqual((await gert.del('/api/sprinkler-library')).body.removed, 0, 'en kan niets wissen');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sprinkler_library').get().n, 2);

    assert.strictEqual((await baas.put('/api/sprinkler-library', { bodies: [], nozzles: [{ key: 'x' }] })).status, 400);
    assert.strictEqual((await kees.del('/api/sprinkler-library')).status, 403);
    assert.strictEqual((await baas.del('/api/sprinkler-library')).body.removed, 2);
    assert.strictEqual((await baas.get('/api/sprinkler-library')).body.own, null);
    const audit = db.prepare("SELECT action FROM audit WHERE action LIKE 'sproeierbibliotheek%' ORDER BY created_at").all().map((r) => r.action);
    assert.deepStrictEqual(audit, ['sproeierbibliotheek_ingelezen', 'sproeierbibliotheek_standaard']);
  } finally {
    server.close();
  }
});
