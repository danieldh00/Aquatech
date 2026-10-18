// Offertes: rekenkern (regels uit een plan, korting, btw) en de API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');
const Core = require('../../frontend/offertes/quote-core.js');

// Plannerbibliotheken in een sandbox, zoals de offertemodule ze laadt.
const FRONT = path.join(__dirname, '..', '..', 'frontend', 'beregening', 'js');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['geometry.js', 'catalog.js', 'hydraulics.js', 'bom.js']) vm.runInContext(fs.readFileSync(path.join(FRONT, f), 'utf8'), sandbox);
const lib = { Catalog: sandbox.window.Catalog, Hydraulics: sandbox.window.Hydraulics, BOM: sandbox.window.BOM };

const garden = () => ({
  meta: { name: 'Tuin Jansen', customer: 'Fam. Jansen', address: 'Dorpsstraat 1, Nunspeet' },
  settings: { level: 'expert', pressure: 3.5, flow: 2 },
  areas: [
    { id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 8 }, { x: 0, y: 8 }] },
    { id: 'a2', type: 'bed', pts: [{ x: 0, y: 9 }, { x: 12, y: 9 }, { x: 12, y: 10.5 }, { x: 0, y: 10.5 }] },
  ],
  sprinklers: [
    { id: 's1', type: 'rotator', x: 0, y: 0, r: 6, arc: 90, start: 0 },
    { id: 's2', type: 'rotator', x: 12, y: 0, r: 6, arc: 90, start: 90 },
    { id: 's3', type: 'rotator', x: 12, y: 8, r: 6, arc: 90, start: 180 },
    { id: 's4', type: 'rotator', x: 0, y: 8, r: 6, arc: 90, start: 270 },
    { id: 's5', type: 'rotator', x: 6, y: 0, r: 6, arc: 180, start: 0 },
    { id: 's6', type: 'rotator', x: 6, y: 8, r: 6, arc: 180, start: 180 },
  ],
  zones: [],
  elements: [
    { id: 'e1', kind: 'source', x: -2, y: 4 },
    { id: 'e2', kind: 'valvebox', x: -1, y: 5 },
    { id: 'e3', kind: 'controller', x: -3, y: 6 },
  ],
});

test('offerteregels uit een plan: materiaal uit de stuklijst plus arbeid', () => {
  // JSON: de regels komen deels uit de sandbox (ander realm).
  const { lines, summary } = JSON.parse(JSON.stringify(Core.fromPlan(garden(), lib, { hourlyRate: 60, markupPct: 10, vatRate: 21, callOutFee: 35 })));
  const mat = lines.filter((l) => l.section === 'materiaal');
  const arb = lines.filter((l) => l.section === 'arbeid');
  assert.ok(mat.length > 5, 'materialen overgenomen');
  const pop = mat.find((l) => l.code === 'ROT-POP10-PRS');
  assert.strictEqual(pop.qty, 6);
  assert.strictEqual(pop.price, Core.round2(lib.Catalog.articles['ROT-POP10-PRS'].price * 1.1), '10% opslag');
  assert.ok(mat.some((l) => l.code === 'DRIP-16'), 'druppelslang voor de border');
  assert.ok(arb.length >= 5);
  assert.ok(arb.every((l) => l.unit === 'uur' && l.price === 60 && l.qty > 0 && (l.qty * 4) % 1 === 0), 'hele kwartieren tegen het uurtarief');
  assert.ok(arb.find((l) => /Sproeiers plaatsen/.test(l.description)).qty === Core.round2(Math.ceil(6 * Core.LABOR.sprinkler * 4) / 4));
  assert.deepStrictEqual(lines.filter((l) => l.section === 'overig').map((l) => [l.description, l.price]), [['Voorrijkosten', 35]]);
  assert.strictEqual(summary.sprinklers, 6);
  assert.strictEqual(summary.lawnM2, 96);
  assert.ok(summary.zones >= 2);
  assert.strictEqual(summary.level, 'Standaard');
});

test('leeg plan: geen materialen, wel een waarschuwing', () => {
  const { lines, warnings } = Core.fromPlan({ areas: [], sprinklers: [] }, lib, {});
  assert.strictEqual(lines.length, 0);
  assert.match(warnings[0], /geen sproeiers/);
});

test('totalen: korting naar rato over de btw-tarieven', () => {
  const t = Core.totals({
    discountPct: 10,
    lines: [
      { section: 'materiaal', qty: 2, price: 50, vat: 21 },
      { section: 'arbeid', qty: 4, price: 25, vat: 9 },
      { section: 'overig', qty: 1, price: 0.333, vat: 0 },
    ],
  });
  assert.strictEqual(t.subtotal, 200.33);
  assert.strictEqual(t.discount, 20.03);
  assert.strictEqual(t.net, 180.3);
  assert.deepStrictEqual(t.vat.map((v) => [v.rate, v.base, v.amount]), [[21, 90, 18.9], [9, 90, 8.1], [0, 0.3, 0]]);
  assert.strictEqual(t.total, 207.3);
  assert.deepStrictEqual(t.bySection, { materiaal: 100, arbeid: 100, overig: 0.33 });
});

test('opschonen: onbekende tarieven, te lange teksten en rommel', () => {
  const d = Core.sanitize({ title: 'x'.repeat(500), discountPct: 400, lines: [{ section: 'hack', qty: 'abc', price: '12.5', vat: 7, description: '<b>' }], customer: 'nee' });
  assert.strictEqual(d.title.length, 200);
  assert.strictEqual(d.discountPct, 100);
  assert.deepStrictEqual([d.lines[0].section, d.lines[0].qty, d.lines[0].price, d.lines[0].vat], ['overig', 0, 12.5, 21]);
  assert.strictEqual(d.customer.name, '');
  assert.match(d.validUntil, /^\d{4}-\d{2}-\d{2}$/);
});

// ---------- API ----------
const SECRET = 'z'.repeat(64);
function client(base) {
  const jar = new Map();
  async function call(method, p, body) {
    const headers = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (kv.slice(i + 1)) jar.set(kv.slice(0, i), kv.slice(i + 1)); else jar.delete(kv.slice(0, i));
    }
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { /* geen JSON */ }
    return { status: res.status, body: json };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

async function setup() {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!' });
  await store.createAccount(tid, { username: 'piet', displayName: 'Piet', role: 'gebruiker', password: 'Tuin-Plan-2026!' });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'gebruiker', password: 'Tuin-Plan-2026!' });
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username) => {
    const c = client(base);
    assert.strictEqual((await c.post('/api/auth/login', { username, password: 'Tuin-Plan-2026!' })).status, 200);
    return c;
  };
  return { server, base, as };
}

test('API: offertes aanmaken, nummeren, afschermen en verwijderen', async () => {
  const { server, base, as } = await setup();
  try {
    assert.strictEqual((await client(base).post('/api/quotes', { data: {} })).status, 401);
    const piet = await as('piet'), kees = await as('kees'), baas = await as('baas');
    const year = new Date().getFullYear();
    const data = { title: 'Beregening tuin', date: `${year}-03-01`, customer: { name: 'Fam. Jansen' }, planId: 'plan-1',
      lines: [{ section: 'materiaal', description: 'Sproeier', qty: 4, price: 10, vat: 21 }, { section: 'arbeid', description: 'Montage', qty: 2, price: 50, vat: 21 }] };
    const a = await piet.post('/api/quotes', { data });
    assert.strictEqual(a.status, 201);
    assert.strictEqual(a.body.number, `OF-${year}-0001`);
    assert.strictEqual(a.body.status, 'concept');
    assert.strictEqual(a.body.totalExcl, 140);
    assert.strictEqual(a.body.totalIncl, 169.4);
    assert.strictEqual(a.body.customer, 'Fam. Jansen');
    const b = await kees.post('/api/quotes', { data: { date: `${year}-03-02` } });
    assert.strictEqual(b.body.number, `OF-${year}-0002`, 'oplopend per tenant');
    assert.strictEqual(b.body.title, 'Offerte');

    assert.deepStrictEqual((await piet.get('/api/quotes')).body.items.map((q) => q.id), [a.body.id]);
    assert.strictEqual((await kees.get(`/api/quotes/${a.body.id}`)).status, 404, 'niet van iemand anders');
    assert.strictEqual((await kees.put(`/api/quotes/${a.body.id}`, { status: 'akkoord' })).status, 404);
    assert.strictEqual((await kees.get('/api/quotes?all=1')).body.items.length, 1, 'alleen beheerders zien alles');
    assert.strictEqual((await baas.get('/api/quotes?all=1')).body.items.length, 2);
    assert.strictEqual((await piet.get('/api/quotes?plan=plan-1')).body.items.length, 1);

    const upd = await piet.put(`/api/quotes/${a.body.id}`, { status: 'verzonden', data: { ...data, discountPct: 10 } });
    assert.strictEqual(upd.body.status, 'verzonden');
    assert.strictEqual(upd.body.totalExcl, 126);
    assert.strictEqual(upd.body.number, a.body.number, 'nummer blijft');
    assert.strictEqual((await piet.put(`/api/quotes/${a.body.id}`, { status: 'weg' })).status, 400);

    assert.strictEqual((await piet.del(`/api/quotes/${a.body.id}`)).status, 200);
    assert.strictEqual((await piet.get(`/api/quotes/${a.body.id}`)).status, 404);
    const c = await piet.post('/api/quotes', { data: { date: `${year}-04-01` } });
    assert.strictEqual(c.body.number, `OF-${year}-0003`, 'een nummer komt nooit terug');

    assert.strictEqual((await piet.del(`/api/admin/quotes/${c.body.id}`)).status, 403);
    assert.strictEqual((await baas.del(`/api/admin/quotes/${c.body.id}`)).status, 200);
  } finally {
    server.close();
  }
});

test('API: bedrijfsprofiel lezen voor iedereen, wijzigen alleen door beheerders', async () => {
  const { server, as } = await setup();
  try {
    const piet = await as('piet'), baas = await as('baas');
    const p = (await piet.get('/api/quote-profile')).body;
    assert.strictEqual(p.canEdit, false);
    assert.strictEqual(p.profile.hourlyRate, 55);
    assert.strictEqual(p.profile.companyName, 'AquaTech Service');
    assert.strictEqual((await piet.put('/api/quote-profile', { profile: { hourlyRate: 1 } })).status, 403);
    const r = await baas.put('/api/quote-profile', { profile: { hourlyRate: 62.5, vatRate: 7, numberPrefix: 'AQ-', kvk: '12345678', evil: 'x' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.profile.hourlyRate, 62.5);
    assert.strictEqual(r.body.profile.vatRate, 21, 'alleen 0, 9 of 21%');
    assert.strictEqual(r.body.profile.evil, undefined);
    assert.strictEqual((await piet.get('/api/quote-profile')).body.profile.kvk, '12345678');
    const q = await piet.post('/api/quotes', { data: {} });
    assert.match(q.body.number, /^AQ-\d{4}-0001$/);
    // Ook zichtbaar in Beheer > Instellingen.
    assert.strictEqual((await baas.get('/api/admin/settings')).body.settings.quoteProfile.value.numberPrefix, 'AQ-');
  } finally {
    server.close();
  }
});
