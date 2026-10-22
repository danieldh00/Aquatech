// Werkregistratie: uren en materiaalverbruik op een werkorder (worklog.js).
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createWorkLogStore, Core } = require('../src/uitvoering/worklog');
const { createClient } = require('./helpers/http-client');

const SECRET = 'w'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

test('kern: uren uit begin/eind/pauze of direct, materiaal met retour, totalen tegenover de planning', () => {
  assert.strictEqual(Core.minutesBetween('07:30', '16:00', 30), 480);
  assert.strictEqual(Core.minutesBetween('22:00', '02:00'), 240, 'over middernacht');
  assert.strictEqual(Core.hoursText(485), '8:05');
  const a = Core.cleanHours({ workDate: '2026-05-01', startTime: '08:00', endTime: '12:15', breakMinutes: 15, kind: 'onzin' });
  assert.deepStrictEqual([a.entry.minutes, a.entry.kind], [240, 'werk']);
  const b = Core.cleanHours({ workDate: '2026-05-01', hours: '1,5', kind: 'reistijd', startTime: '08:00' });
  assert.deepStrictEqual([b.entry.minutes, b.entry.startTime, b.entry.endTime], [90, '', ''], 'zonder eindtijd tellen de uren');
  assert.ok(Core.cleanHours({ workDate: '2026-05-01' }).error);
  assert.ok(Core.cleanHours({ workDate: '2026-13-01', hours: 1 }).error);
  assert.ok(Core.cleanHours({ workDate: '2026-05-01', hours: 25 }).error);
  assert.strictEqual(Core.cleanMaterial({ usedOn: '2026-05-01', description: 'Sproeier', qty: '-2,5' }).entry.qty, -2.5);
  assert.ok(Core.cleanMaterial({ usedOn: '2026-05-01', description: 'Sproeier', qty: 0 }).error);
  assert.ok(Core.cleanMaterial({ usedOn: '2026-05-01', qty: 1 }).error);

  const data = { steps: [{ hours: 4 }, { hours: 2.5 }], materials: [{ code: 'SPR', description: 'Sproeier', unit: 'st', qty: 4 }, { code: '', description: 'Tape', unit: 'rol', qty: 1 }] };
  const t = Core.totals(data, [
    { minutes: 240, kind: 'werk', user: { displayName: 'Kees' } }, { minutes: 30, kind: 'reistijd', user: { displayName: 'Kees' } },
    { minutes: 120, kind: 'werk', user: { displayName: 'Piet' } },
  ], [
    { code: 'spr', description: 'Sproeier', qty: 5 }, { code: 'SPR', description: 'Sproeier', qty: -1 },
    { code: '', description: ' tape', qty: 1 }, { code: 'KOP', description: 'Koppeling', unit: 'st', qty: 2 },
  ]);
  assert.deepStrictEqual([t.hours, t.plannedHours, t.byKind.werk, t.byUser.Kees], [6.5, 6.5, 360, 270]);
  assert.deepStrictEqual(t.materials.map((m) => [m.description, m.planned, m.used, m.diff, m.extra]),
    [['Sproeier', 4, 4, 0, false], ['Tape', 1, 1, 0, false], ['Koppeling', 0, 2, 2, true]]);
  assert.strictEqual(t.extraMaterials, 1);
});

async function setup() {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  const mk = (t, username, role) => store.createAccount(t, { username, displayName: username[0].toUpperCase() + username.slice(1), role, password: PW, mustChangePassword: false });
  await mk(tid, 'baas', 'beheerder');
  await mk(tid, 'kees', 'installateur');
  await mk(tid, 'piet', 'installateur');
  await mk(tid, 'pim', 'planner');
  await mk(tid, 'klaas', 'klant');
  await mk(other.id, 'vreemd', 'beheerder');
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, tenant) => {
    const c = createClient(base);
    assert.strictEqual((await c.post('/api/auth/login', { username, password: PW, tenant })).status, 200, username);
    return c;
  };
  return { db, server, as };
}

const lines = [{ id: 'a', section: 'materiaal', code: 'SPR-1', description: 'Sproeier', qty: 4, unit: 'st', price: 10 },
  { id: 'b', section: 'arbeid', description: 'Sproeiers plaatsen', qty: 3, unit: 'uur', price: 50 }];

test('API: uren en materiaal boeken, eigen regels, collega alleen met planning, afgerond = vast, andere tenant 404', async () => {
  const { db, server, as } = await setup();
  try {
    const kees = await as('kees'), piet = await as('piet'), pim = await as('pim'), baas = await as('baas'), klaas = await as('klaas');
    const vreemd = await as('vreemd', 'ander');
    // Installateurs zonder het recht planning (monteurs): alleen eigen regels.
    const noPlanning = ['plannen', 'plannen.alle', 'plannen.goedkeuren', 'offertes', 'offertes.alle', 'werkorders', 'uitvoerder'];
    assert.strictEqual((await baas.patch('/api/admin/roles/installateur', { rights: noPlanning })).status, 200);
    const pietId = (await piet.get('/api/me')).body.user.id;
    const q = (await kees.post('/api/quotes', { data: { title: 'Aanleg', customer: { name: 'Fam. Klaassen' }, lines } })).body;
    await kees.put(`/api/quotes/${q.id}`, { status: 'akkoord' });
    const wo = (await kees.post('/api/workorders', { quoteId: q.id })).body;
    const url = `/api/workorders/${wo.id}`;
    const d = today();

    // Rechten.
    assert.strictEqual((await klaas.get(`${url}/worklog`)).status, 403, 'klant');
    assert.strictEqual((await klaas.post(`${url}/hours`, { workDate: d, hours: 1 })).status, 403);
    assert.strictEqual((await vreemd.get(`${url}/worklog`)).status, 404, 'andere organisatie');
    assert.strictEqual((await vreemd.post(`${url}/hours`, { workDate: d, hours: 1 })).status, 404);
    assert.strictEqual((await kees.post('/api/workorders/bestaat-niet/hours', { workDate: d, hours: 1 })).status, 404);

    // Uren boeken (eigen), met clientId: opnieuw versturen telt één keer.
    const clientId = '0b8f8c1e-7a1d-4a7e-9d3a-1c2b3d4e5f60';
    const h1 = await kees.post(`${url}/hours`, { workDate: d, startTime: '07:30', endTime: '16:00', breakMinutes: 30, kind: 'werk', note: 'Leidingen', clientId });
    assert.strictEqual(h1.status, 201);
    assert.deepStrictEqual([h1.body.minutes, h1.body.user.displayName, h1.body.clientId], [480, 'Kees', clientId]);
    const again = await kees.post(`${url}/hours`, { workDate: d, hours: 9, clientId });
    assert.deepStrictEqual([again.status, again.body.id, again.body.minutes], [200, h1.body.id, 480]);
    assert.strictEqual((await kees.post(`${url}/hours`, { workDate: addDays(d, 5), hours: 1 })).status, 400, 'toekomst');
    assert.strictEqual((await kees.post(`${url}/hours`, { workDate: d })).status, 400, 'geen uren');
    const travel = (await kees.post(`${url}/hours`, { workDate: d, hours: '0,5', kind: 'reistijd' })).body;
    assert.strictEqual(travel.minutes, 30);

    // Voor een collega boeken: installateur niet, planner wel.
    assert.strictEqual((await kees.post(`${url}/hours`, { workDate: d, hours: 2, userId: pietId })).status, 403);
    const forPiet = await pim.post(`${url}/hours`, { workDate: d, hours: 2, userId: pietId });
    assert.deepStrictEqual([forPiet.status, forPiet.body.user.displayName], [201, 'Piet']);
    assert.strictEqual((await pim.post(`${url}/hours`, { workDate: d, hours: 2, userId: 'onbekend' })).status, 400);

    // Wijzigen en verwijderen: alleen eigen regels (planner alles).
    assert.strictEqual((await piet.put(`${url}/hours/${h1.body.id}`, { hours: 1 })).status, 403);
    const ch = await kees.put(`${url}/hours/${h1.body.id}`, { startTime: '', endTime: '', hours: 7.5 });
    assert.deepStrictEqual([ch.status, ch.body.minutes, ch.body.note], [200, 450, 'Leidingen']);
    assert.strictEqual((await piet.del(`${url}/hours/${travel.id}`)).status, 403);
    assert.strictEqual((await kees.put(`/api/workorders/bestaat-niet/hours/${h1.body.id}`, { hours: 1 })).status, 404);

    // Materiaal: verbruik en retour, extra artikel.
    const m1 = await kees.post(`${url}/materials`, { usedOn: d, code: 'SPR-1', description: 'Sproeier', unit: 'st', qty: 5, materialId: wo.data.materials[0].id });
    assert.strictEqual(m1.status, 201);
    assert.strictEqual(m1.body.stockMovementId, null);
    assert.strictEqual((await kees.post(`${url}/materials`, { usedOn: d, code: 'SPR-1', description: 'Sproeier', unit: 'st', qty: -1 })).status, 201);
    assert.strictEqual((await kees.post(`${url}/materials`, { usedOn: d, description: 'Koppelstuk', unit: 'st', qty: 2 })).status, 201);
    assert.strictEqual((await kees.post(`${url}/materials`, { usedOn: d, description: 'Niets', qty: 0 })).status, 400);
    assert.strictEqual((await vreemd.post(`${url}/materials`, { usedOn: d, description: 'X', qty: 1 })).status, 404);

    const log = (await kees.get(`${url}/worklog`)).body;
    assert.strictEqual(log.hours.length, 3);
    assert.strictEqual(log.materials.length, 3);
    assert.strictEqual(log.canManage, false);
    const tot = Core.totals(wo.data, log.hours, log.materials);
    assert.strictEqual(tot.minutes, 450 + 30 + 120);
    assert.deepStrictEqual(tot.materials.find((m) => m.code === 'SPR-1').used, 4);
    assert.ok((await pim.get(`${url}/worklog`)).body.canManage);

    // Overzicht toont de geboekte uren.
    const listed = (await kees.get('/api/workorders')).body.items.find((w) => w.id === wo.id);
    assert.deepStrictEqual(listed.logged, { minutes: 600, materials: 3 });

    // Urenstaat over een periode: eigen uren, planner ziet iedereen.
    const mine = (await kees.get(`/api/worklog?from=${d}&to=${d}`)).body;
    assert.deepStrictEqual(mine.hours.map((h) => h.user.displayName), ['Kees', 'Kees']);
    assert.strictEqual(mine.hours[0].workOrder.number, wo.number);
    assert.strictEqual((await kees.get(`/api/worklog?from=${d}&to=${d}&user=${pietId}`)).status, 403);
    assert.strictEqual((await pim.get(`/api/worklog?from=${d}&to=${d}`)).body.hours.length, 3);
    assert.strictEqual((await pim.get(`/api/worklog?from=${d}&to=${d}&user=${pietId}`)).body.hours.length, 1);
    assert.strictEqual((await kees.get('/api/worklog?from=2026-01-01&to=2028-01-01')).status, 400);
    assert.strictEqual((await vreemd.get(`/api/worklog?from=${d}&to=${d}`)).body.hours.length, 0, 'andere organisatie ziet niets');

    // Afgerond: installateur kan niet meer boeken, planner wel.
    await kees.put(url, { status: 'gereed' });
    assert.strictEqual((await kees.post(`${url}/hours`, { workDate: d, hours: 1 })).status, 409);
    assert.strictEqual((await kees.del(`${url}/materials/${m1.body.id}`)).status, 409);
    assert.ok((await kees.get(`${url}/worklog`)).body.locked);
    assert.strictEqual((await pim.put(`${url}/materials/${m1.body.id}`, { qty: 6 })).body.qty, 6);
    assert.strictEqual((await baas.del(`${url}/hours/${travel.id}`)).status, 200);

    const audit = db.prepare("SELECT action FROM audit WHERE action IN ('uren_geboekt', 'materiaal_geboekt', 'uren_verwijderd')").all().map((r) => r.action);
    assert.strictEqual(audit.filter((a) => a === 'uren_geboekt').length, 3, 'dubbel verstuurde regel niet opnieuw');
    assert.ok(audit.includes('materiaal_geboekt') && audit.includes('uren_verwijderd'));

    // Definitief wissen van de werkorder neemt de registratie mee.
    assert.strictEqual((await baas.del(`/api/admin/workorders/${wo.id}`)).status, 200);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM work_order_hours').get().n, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM work_order_materials').get().n, 0);
  } finally {
    server.close();
  }
});

test('voorraadkoppeling: hook bij boeken, wijzigen en verwijderen; afboeking in stock_movement_id', () => {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO users (id, tenant_id, username, display_name, role, kind, password_hash, created_at) VALUES ('u1', ?, 'kees', 'Kees', 'installateur', 'account', '', ?)").run(tid, ts);
  db.prepare(`INSERT INTO work_orders (id, tenant_id, owner_id, number, status, title, customer, address, data, created_at, updated_at)
    VALUES ('w1', ?, 'u1', 'WO-2026-0001', 'bezig', 'Klus', 'Klant', '', '{}', ?, ?)`).run(tid, ts, ts);
  const calls = [];
  const log = createWorkLogStore(db);
  log.hook((t, row, user) => { calls.push([row.code, row.qty, row.deleted, user.id]); return row.deleted ? null : `mut-${calls.length}`; });
  const who = { actor: { id: 'u1' }, forUser: { id: 'u1', displayName: 'Kees' } };
  const out = log.addMaterial(tid, 'w1', { usedOn: '2026-05-01', code: 'SPR-1', description: 'Sproeier', qty: 3 }, who);
  assert.strictEqual(out.entry.stockMovementId, 'mut-1');
  assert.strictEqual(log.updateMaterial(tid, out.entry.id, { qty: 2 }, who).entry.stockMovementId, 'mut-2');
  assert.deepStrictEqual(log.usedByCode(tid, 'w1'), { 'SPR-1': 2 });
  assert.ok(log.removeMaterial(tid, out.entry.id, { id: 'u1' }));
  assert.deepStrictEqual(calls, [['SPR-1', 3, false, 'u1'], ['SPR-1', 2, false, 'u1'], ['SPR-1', 2, true, 'u1']]);
});
