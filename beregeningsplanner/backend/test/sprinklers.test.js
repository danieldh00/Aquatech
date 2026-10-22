// Sproeierbibliotheek: behuizingen en nozzles (rekenkern, planner, stuklijst) en de opslag per omgeving.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');

const Lib = require('../../frontend/beregening/js/sprinklerlib.js');
const { createClient, createLogin, listen } = require('./helpers/http-client');
const FRONT = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const file of ['geometry.js', 'sprinklerlib.js', 'catalog.js', 'simulation.js', 'planner.js', 'hydraulics.js', 'bom.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, file), 'utf8'), sandbox);
const { Catalog, Planner, Simulation, BOM } = sandbox.window;

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
/**
 * Rechthoek als lijst hoekpunten.
 * @param {number} x0 Links.
 * @param {number} y0 Boven.
 * @param {number} x1 Rechts.
 * @param {number} y1 Onder.
 * @returns {Array<{x: number, y: number}>} De vier hoekpunten.
 */
const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

test('bibliotheek: standaarddata is geldig en Excel heen en terug verandert niets', () => {
  const sanitized = Lib.sanitize(Lib.DEFAULTS);
  assert.deepStrictEqual(sanitized.problems, []);
  for (const key of ['RB-1804-PRS', 'RB-1806-P45', 'RB-1812-PRS', 'HU-PROS04-PRS40', 'RB-5004-PC', 'RB-5012-PC']) assert.ok(sanitized.bodies.some((body) => body.key === key), key);
  for (const key of ['MP1000', 'MP3000', 'MP3500', 'HE-VAN-12', 'RB5000-3.0']) assert.ok(sanitized.nozzles.some((nozzle) => nozzle.key === key), key);
  const sheets = Lib.toSheets(Lib.merge(null));
  const withHead = Object.fromEntries(Object.entries(sheets).map(([sheet, rows]) => [sheet, [Lib.SHEETS[sheet].map((column) => column[0]), ...rows]]));
  const back = Lib.sanitize(Lib.fromSheets(withHead));
  assert.deepStrictEqual(back.problems, []);
  assert.strictEqual(JSON.stringify(back.nozzles), JSON.stringify(sanitized.nozzles));
  assert.strictEqual(JSON.stringify(back.bodies), JSON.stringify(sanitized.bodies));
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
  assert.deepStrictEqual(out.bodies.map((entry) => [entry.key, entry.regBar, entry.popup]), [['POP20', 2.8, 20]]);
  assert.deepStrictEqual(out.nozzles.map((entry) => entry.key), ['N1']);
  assert.strictEqual(out.problems.length, 4);
  const nozzle = out.nozzles[0];
  assert.deepStrictEqual(nozzle.arcs, [[90, 210], [360, 360]]);
  assert.deepStrictEqual(nozzle.perf.map((point) => point.bar), [2, 3], 'gesorteerd op druk');
  assert.deepStrictEqual(Lib.perfAt(nozzle, 2.5), { r: 5.5, q: 350, bar: 2.5 });
  assert.strictEqual(Lib.perfAt(nozzle, 9).r, 6, 'buiten het bereik: dichtstbijzijnde meetpunt');
  // matched: debiet schaalt met hoek en worp², rotornozzle: per nozzle
  assert.strictEqual(Lib.flowLph(nozzle, 6, 180, 3), 200);
  assert.strictEqual(Lib.flowLph(nozzle, 3, 360, 3), 100);
  const rotor = Lib.DEFAULTS.nozzles.find((x) => x.key === 'RB5000-3.0');
  assert.strictEqual(Lib.flowLph(rotor, 10, 90, 3), Lib.flowLph(rotor, 11, 270, 3));
  // eigen regels gaan voor de standaard, actief = nee verbergt
  const merged = Lib.merge({ bodies: [], nozzles: [{ ...Lib.DEFAULTS.nozzles[0], price: 99 }, { ...Lib.DEFAULTS.nozzles[1], active: false }] });
  assert.strictEqual(merged.nozzles.find((x) => x.key === Lib.DEFAULTS.nozzles[0].key).price, 99);
  assert.ok(!merged.nozzles.some((x) => x.key === Lib.DEFAULTS.nozzles[1].key));
});

test('planner: zelf gekozen behuizing en nozzle bepalen bereik, debiet, druk en stuklijst', () => {
  Catalog.setLibrary(null);
  // HE-VAN-12 op een 1812 PRS (30 cm, 2,1 bar): worp 2,8–3,7 m, hoek 0–360
  const fitted = Catalog.fitHead({ type: 'spray', body: 'RB-1812-PRS', model: 'HE-VAN-12', r: 5, arc: 180, x: 0, y: 0, start: 0 });
  assert.strictEqual(fitted.r, 3.7, 'worp begrensd op de nozzle');
  assert.strictEqual(Catalog.headMinBar(fitted), 2.1, 'drukregeling van het huis');
  assert.ok(Math.abs(Catalog.headPr(fitted) - 40) < 0.5, `neerslag ${Catalog.headPr(fitted)}`);
  // generieke sproeier zonder behuizing blijft zoals hij was
  const fallback = Catalog.fitHead({ type: 'spray', r: 5.2, arc: 33 });
  assert.deepStrictEqual([fallback.r, fallback.arc], [5.2, 33]);
  // 5004 zonder gekozen nozzle: automatisch een Rain Curtain-nozzle die bij de worp past
  const rotor = Catalog.fitHead({ type: 'rotor', body: 'RB-5004-PC', r: 12, arc: 180 });
  const nozzle = Catalog.nozzleOf(rotor);
  assert.ok(nozzle && nozzle.mount === 'rb5000' && nozzle.group === 'rotor');
  assert.ok(Catalog.sprinklerFlowLph(rotor) > 0);
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
  for (const code of ['RB-1812-PRS', 'RB-HEVAN12', 'HU-PROS04-PRS40', 'ROT-MP2000', 'ROT-POP10-PRS', 'ROT-MP1000']) assert.ok(codes.includes(code), code);
  assert.ok(!codes.includes('SPR-VAN'));
});

test('planner: eigen bibliotheek van de organisatie (setLibrary)', () => {
  const own = {
    bodies: [{ key: 'POP20', brand: 'Eigen', name: 'Pop-up 20 cm', code: 'EIGEN-POP20', popup: 20, mount: 'sproeikop', regBar: 2.8, price: 12 }],
    nozzles: [{ key: 'MP3000', brand: 'Hunter', name: 'MP3000', code: 'ROT-MP3000', group: 'rotator', arcs: '90-210; 210-270; 360', rMin: 6.7, bar: 2.8, perf: [{ bar: 2.8, r: 9.5, q: 900 }] }],
  };
  Catalog.setLibrary(own);
  try {
    assert.strictEqual(Catalog.rotatorModels.MP3000.rMax, 9.5, 'eigen prestaties gaan voor');
    assert.ok(Catalog.bodies.POP20 && Catalog.articles['EIGEN-POP20'] && Catalog.articles['EIGEN-POP20'].price === 12);
    assert.ok(Catalog.bodiesFor('rotator').some((body) => body.key === 'POP20'));
    assert.ok(!Catalog.bodiesFor('rotator').some((body) => body.key === 'RB-5004-PC'), 'een rotor past niet op een MP');
  } finally {
    Catalog.setLibrary(null);
  }
  assert.strictEqual(Catalog.rotatorModels.MP3000.rMax, 9.1);
});

test('planner: eigen assortiment beperkt behuizingen en nozzles', () => {
  Catalog.setLibrary(null);
  Catalog.setAssortment(['ROT-MP3000', 'HU-PROS04-PRS40', 'PE-25']);
  try {
    assert.strictEqual(Catalog.bodiesFor('rotator').map((body) => body.key).join(), 'HU-PROS04-PRS40');
    assert.strictEqual(Catalog.nozzlesFor('rotator').map((nozzle) => nozzle.key).join(), 'MP3000');
    assert.strictEqual(Catalog.nozzleOf({ type: 'rotator', r: 5, arc: 180 }).key, 'MP3000');
    assert.strictEqual(Catalog.nozzleOf({ type: 'rotator', model: 'MP2000', r: 5, arc: 180 }).key, 'MP3000', 'gekozen kop niet in assortiment: automatisch');
    const heads = Planner.autoPlace(rect(0, 0, 12, 9), 'rotator');
    assert.ok(heads.every((head) => Catalog.rotatorModelOf(head) === 'MP3000'));
  } finally {
    Catalog.setAssortment(null);
  }
});

test('automatisch plaatsen: volle worp over de breedte van het gazon', () => {
  Catalog.setLibrary(null);
  /**
   * Simuleert de neerslag van koppen op een gazon.
   * @param {Array<{x: number, y: number}>} points Hoekpunten van het gazon.
   * @param {object[]} heads De sproeiers.
   * @returns {object} Statistiek van de simulatie (gemiddelde, spreiding, ...).
   */
  const stats = (points, heads) => Simulation.simulate({ areas: [{ type: 'lawn', pts: points }], sprinklers: heads }, 0.2).stats;
  // 30 × 12 m: vroeger 18 koppen op 6 m, nu grotere koppen met minder stuks
  const lawn = rect(0, 0, 30, 12);
  const heads = Planner.autoPlace(lawn, 'rotator');
  assert.ok(heads.length <= 15, `${heads.length} koppen`);
  assert.ok(Math.max(...heads.map((head) => head.r)) >= 9, 'grote MP-koppen benut');
  const st = stats(lawn, heads);
  assert.ok(st.du > 0.75 && st.dryPct < 3, `DU ${st.du}, droog ${st.dryPct}%`);
  // 20 × 15 m: kop-tot-kop met MP3000/MP3500, geen raster van kleine koppen (9 koppen kan ook,
  // maar dan spuiten de randkoppen ruim 25 m² naast het gazon)
  const wide = Planner.autoPlace(rect(0, 0, 20, 15), 'rotator');
  assert.ok(wide.length <= 12, `${wide.length} koppen`);
  // met een gekozen behuizing krijgt elke kop die behuizing
  const withBody = Planner.autoPlace(rect(0, 0, 10, 8), 'rotator', { body: 'HU-PROS04-PRS40' });
  assert.ok(withBody.every((head) => head.body === 'HU-PROS04-PRS40'));
  // turbinesproeiers op een 5004: Rain Curtain-nozzles tot ca. 14 m
  const big = Planner.autoPlace(rect(0, 0, 40, 28), 'rotor', { body: 'RB-5004-PC' });
  assert.ok(big.length && big.every((head) => Catalog.nozzleOf(head) && Catalog.nozzleOf(head).mount === 'rb5000'));
  assert.ok(Math.max(...big.map((head) => head.r)) > 12, 'grote worp van de rotor benut');
});

/**
 * Hoofdtenant met beheerder en installateur, organisatie Groen met een beheerder, plus een testserver.
 * @returns {Promise<object>} db, server, base en as (inloggen).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW }, { mustChangePassword: false });
  const groen = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant;
  await store.createAccount(groen.id, { username: 'gert', displayName: 'Gert', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  const as = createLogin(base, { password: PW });
  return { db, server, base, as };
}

test('API sproeierbibliotheek: inlezen, rechten, andere organisatie en terug naar standaard', async () => {
  const { db, server, base, as } = await setup();
  try {
    const anon = createClient(base);
    assert.strictEqual((await anon.get('/api/sprinkler-library')).status, 401);
    const baas = await as('baas');
    const kees = await as('kees');
    const gert = await as('gert', 'groen');
    assert.deepStrictEqual((await kees.get('/api/sprinkler-library')).body, { own: null, updatedAt: null });

    const file = Lib.toSheets(Lib.merge(null));
    const sheets = Object.fromEntries(Object.entries(file).map(([sheet, rows]) => [sheet, [Lib.SHEETS[sheet].map((column) => column[0]), ...rows]]));
    const raw = Lib.fromSheets(sheets);
    raw.bodies.push({ key: 'POP20', brand: 'Eigen', name: 'Pop-up 20 cm', code: 'EIGEN-POP20', popup: 20, mount: 'sproeikop', regBar: 2.8 });
    raw.nozzles.find((nozzle) => nozzle.key === 'MP3000').price = 11;
    raw.nozzles.push({ key: 'kapot', group: 'x' });

    assert.strictEqual((await kees.put('/api/sprinkler-library', raw)).status, 403, 'installateur mag niet inlezen');
    const put = await baas.put('/api/sprinkler-library', raw);
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.counts.own, 2, 'alleen afwijkingen van de standaard opgeslagen');
    assert.strictEqual(put.body.problems.length, 1);
    const rows = db.prepare('SELECT kind, key FROM sprinkler_library ORDER BY kind, key').all().map((row) => `${row.kind}:${row.key}`);
    assert.deepStrictEqual(rows, ['body:POP20', 'nozzle:MP3000']);

    const seen = await kees.get('/api/sprinkler-library');
    assert.deepStrictEqual(seen.body.own.bodies.map((body) => body.key), ['POP20']);
    assert.deepStrictEqual((await gert.get('/api/sprinkler-library')).body.own, null, 'andere organisatie ziet niets');
    assert.strictEqual((await gert.del('/api/sprinkler-library')).body.removed, 0, 'en kan niets wissen');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sprinkler_library').get().n, 2);

    assert.strictEqual((await baas.put('/api/sprinkler-library', { bodies: [], nozzles: [{ key: 'x' }] })).status, 400);
    assert.strictEqual((await kees.del('/api/sprinkler-library')).status, 403);
    assert.strictEqual((await baas.del('/api/sprinkler-library')).body.removed, 2);
    assert.strictEqual((await baas.get('/api/sprinkler-library')).body.own, null);
    const audit = db.prepare("SELECT action FROM audit WHERE action LIKE 'sproeierbibliotheek%' ORDER BY created_at").all().map((row) => row.action);
    assert.deepStrictEqual(audit, ['sproeierbibliotheek_ingelezen', 'sproeierbibliotheek_standaard']);
  } finally {
    server.close();
  }
});
