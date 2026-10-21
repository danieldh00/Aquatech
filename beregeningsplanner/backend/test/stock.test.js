// Voorraadbeheer: artikelen, mutaties, reserveren vanuit de materiaallijst van
// een werkorder en afboeken (met de hand, via verbruik of bij Gereed).
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');
const { createStockStore, sanitizeItem, needsOf } = require('../src/stock');
const { transaction } = require('../src/db');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

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
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'pien', displayName: 'Pien', role: 'planner', password: PW });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, org) => {
    const c = client(base);
    const r = await c.post('/api/auth/login', { username, password: PW, tenant: org });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return c;
  };
  return { db, server, as, main };
}

async function workOrder(c, lines) {
  const q = (await c.post('/api/quotes', { data: { title: 'Aanleg', customer: { name: 'Fam. Jansen', address: 'Dorpsstraat 1, Nunspeet' },
    lines: [...lines.map(([code, qty]) => ({ section: 'materiaal', code, description: code, qty, unit: 'st', price: 1 })),
      { section: 'arbeid', description: 'Sleuven graven', qty: 4, unit: 'uur', price: 55 }] } })).body;
  assert.strictEqual((await c.put(`/api/quotes/${q.id}`, { status: 'akkoord' })).status, 200);
  const wo = await c.post('/api/workorders', { quoteId: q.id });
  assert.strictEqual(wo.status, 201, JSON.stringify(wo.body));
  return wo.body;
}

test('voorraad: artikel opschonen en benodigd per code', () => {
  assert.deepStrictEqual(sanitizeItem({ code: ' pe-25 ', name: ' PE-buis ', minQty: '5', costPrice: '0.849' }).value,
    { code: 'PE-25', name: 'PE-buis', unit: 'st', location: '', notes: '', minQty: 5, costPrice: 0.85, salePrice: null, vatRate: 21, revenueGroup: 'producten', shopSync: true });
  assert.strictEqual(sanitizeItem({ code: '', name: 'x' }).field, 'code');
  assert.strictEqual(sanitizeItem({ code: 'A B;C', name: 'x' }).field, 'code');
  assert.strictEqual(sanitizeItem({ code: 'A', name: '' }).field, 'name');
  assert.strictEqual(sanitizeItem({ code: 'A', name: 'x', minQty: -1 }).field, 'minQty');
  const need = needsOf([{ code: 'pe-25', qty: 10 }, { code: 'PE-25', qty: 2.5 }, { code: '', qty: 3 }, { code: 'X', qty: -1 }]);
  assert.deepStrictEqual([...need.entries()].map(([c, n]) => [c, n.qty]), [['PE-25', 12.5]]);
});

test('voorraad: reserveren vanuit de werkorder, afboeken bij Gereed, mutaties', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const wo = await workOrder(kees, [['PE-25', 50], ['VAL-24V', 3], ['TAPE', 1]]);

    // Uit de catalogus op voorraad: de open werkorder reserveert meteen.
    const imp = await kees.post('/api/stock/import', { codes: ['PE-25', 'val-24v', 'FIT-T-25'] });
    assert.deepStrictEqual(imp.body, { created: 3, existing: 0 });
    assert.strictEqual((await kees.post('/api/stock/import', { codes: ['BESTAAT-NIET'] })).status, 400);
    let items = (await kees.get('/api/stock')).body.items;
    const pe = items.find((i) => i.code === 'PE-25');
    const val = items.find((i) => i.code === 'VAL-24V');
    assert.strictEqual(pe.name, 'PE-buis 25 mm PN6');
    assert.strictEqual(pe.unit, 'm');
    assert.strictEqual(pe.reserved, 50);
    assert.strictEqual(pe.available, -50);

    // Ontvangst, telling en correctie.
    assert.strictEqual((await kees.post(`/api/stock/items/${pe.id}/movements`, { kind: 'ontvangst', qty: 100, note: 'Pakbon 1' })).status, 201);
    assert.strictEqual((await kees.post(`/api/stock/items/${pe.id}/movements`, { kind: 'ontvangst', qty: -5 })).status, 400);
    assert.strictEqual((await kees.post(`/api/stock/items/${pe.id}/movements`, { kind: 'correctie', qty: -2 })).status, 400, 'correctie vraagt een reden');
    assert.strictEqual((await kees.post(`/api/stock/items/${pe.id}/movements`, { kind: 'correctie', qty: -2, note: 'Beschadigd' })).status, 201);
    const counted = (await kees.post(`/api/stock/items/${pe.id}/movements`, { kind: 'telling', qty: 95 })).body;
    assert.strictEqual(counted.onHand, 95);
    assert.deepStrictEqual(counted.movements.map((m) => [m.kind, m.qty, m.balance]), [['telling', -3, 95], ['correctie', -2, 98], ['ontvangst', 100, 100]]);
    await kees.post(`/api/stock/items/${val.id}/movements`, { kind: 'ontvangst', qty: 2 });

    // Op de werkorder: nodig, gereserveerd, tekort en wat niet op voorraad is.
    let s = (await kees.get(`/api/stock/workorders/${wo.id}`)).body;
    const line = (code) => s.lines.find((l) => l.code === code);
    assert.deepStrictEqual([line('PE-25').needed, line('PE-25').reserved, line('PE-25').shortage], [50, 50, 0]);
    assert.deepStrictEqual([line('VAL-24V').needed, line('VAL-24V').shortage], [3, 1]);
    assert.deepStrictEqual(s.notInStock.map((m) => m.code), ['TAPE']);

    // Materiaallijst aanpassen: de reservering volgt.
    const data = (await kees.get(`/api/workorders/${wo.id}`)).body.data;
    data.materials.find((m) => m.code === 'PE-25').qty = 60;
    assert.strictEqual((await kees.put(`/api/workorders/${wo.id}`, { data })).status, 200);
    assert.strictEqual((await kees.get('/api/stock')).body.items.find((i) => i.code === 'PE-25').reserved, 60);

    // Met de hand afboeken (en een retour).
    s = (await kees.post(`/api/stock/workorders/${wo.id}/issue`, { lines: [{ code: 'pe-25', qty: 40 }] })).body;
    assert.deepStrictEqual([line('PE-25').issued, line('PE-25').reserved], [40, 20]);
    s = (await kees.post(`/api/stock/workorders/${wo.id}/issue`, { lines: [{ code: 'PE-25', qty: -5 }] })).body;
    assert.deepStrictEqual([line('PE-25').issued, line('PE-25').reserved], [35, 25]);
    assert.strictEqual((await kees.post(`/api/stock/workorders/${wo.id}/issue`, { lines: [{ code: 'TAPE', qty: 1 }] })).status, 400);

    // Gereed: de rest van de reservering wordt afgeboekt.
    assert.strictEqual((await kees.put(`/api/workorders/${wo.id}`, { status: 'gereed' })).status, 200);
    items = (await kees.get('/api/stock')).body.items;
    assert.strictEqual(items.find((i) => i.code === 'PE-25').onHand, 95 - 60);
    assert.strictEqual(items.find((i) => i.code === 'VAL-24V').onHand, -1, 'tekort wordt zichtbaar als negatieve stand');
    assert.ok(items.every((i) => i.reserved === 0));
    s = (await kees.get(`/api/stock/workorders/${wo.id}`)).body;
    assert.ok(s.movements.some((m) => m.source === 'gereed' && m.workOrderNumber === wo.number));
    // Nogmaals opslaan als gereed boekt niets dubbel.
    await kees.put(`/api/workorders/${wo.id}`, { status: 'gereed' });
    assert.strictEqual((await kees.get('/api/stock')).body.items.find((i) => i.code === 'PE-25').onHand, 35);

    // Een geannuleerde werkorder geeft zijn reservering vrij.
    const wo2 = await workOrder(kees, [['PE-25', 10]]);
    assert.strictEqual((await kees.get('/api/stock/reservations')).body.items.length, 1);
    await kees.put(`/api/workorders/${wo2.id}`, { status: 'geannuleerd' });
    assert.strictEqual((await kees.get('/api/stock/reservations')).body.items.length, 0);

    // Mutaties voor de export, met een periode.
    const all = (await baas.get('/api/stock/movements')).body.items;
    assert.ok(all.length >= 8);
    assert.strictEqual((await baas.get('/api/stock/movements?from=2000-01-01&to=2000-01-02')).body.items.length, 0);
    assert.strictEqual((await baas.get('/api/stock/movements?from=gisteren')).status, 400);

    // Code wijzigen kan niet meer na boekingen op werkorders; verwijderen archiveert.
    assert.strictEqual((await kees.put(`/api/stock/items/${pe.id}`, { code: 'PE-25-OUD' })).status, 409);
    const fit = items.find((i) => i.code === 'FIT-T-25');
    assert.strictEqual((await kees.put(`/api/stock/items/${fit.id}`, { code: 'FIT-T-25B', location: 'Bus 2' })).body.location, 'Bus 2');
    assert.deepStrictEqual((await kees.del(`/api/stock/items/${fit.id}`)).body, { deleted: true, code: 'FIT-T-25B' });
    assert.strictEqual((await kees.del(`/api/stock/items/${pe.id}`)).body.archived, true);
    assert.ok(!(await kees.get('/api/stock')).body.items.some((i) => i.code === 'PE-25'));
    assert.ok((await kees.get('/api/stock?archived=1')).body.items.some((i) => i.code === 'PE-25' && i.archived));
    assert.strictEqual((await kees.post('/api/stock/items', { code: 'VAL-24V', name: 'Dubbel' })).status, 409);
  } finally {
    server.close();
  }
});

test('voorraad: verbruik boeken is idempotent per verbruiksregel; met verbruik vervalt de rest bij Gereed', async () => {
  const { db, server, as, main } = await setup();
  try {
    const kees = await as('kees');
    const wo = await workOrder(kees, [['PE-25', 50]]);
    const item = (await kees.post('/api/stock/items', { code: 'PE-25', name: 'PE-buis', unit: 'm', onHand: 80 })).body;
    assert.strictEqual(item.onHand, 80);
    assert.strictEqual(item.reserved, 50);
    const stock = createStockStore(db);
    const user = { id: 'u1', display_name: 'Kees' };
    const onHand = () => stock.get(main, item.id).onHand;
    const first = stock.syncUsage(main, { usageId: 'v1', workOrderId: wo.id, code: 'pe-25', qty: 30, user });
    assert.ok(first);
    assert.strictEqual(onHand(), 50);
    assert.strictEqual(stock.get(main, item.id).reserved, 20);
    assert.strictEqual(stock.syncUsage(main, { usageId: 'v1', workOrderId: wo.id, code: 'PE-25', qty: 30, user }), first, 'zelfde regel nogmaals: niets nieuws');
    assert.strictEqual(onHand(), 50);
    stock.syncUsage(main, { usageId: 'v1', workOrderId: wo.id, code: 'PE-25', qty: 35, user });
    assert.strictEqual(onHand(), 45, 'alleen het verschil');
    stock.syncUsage(main, { usageId: 'v2', workOrderId: wo.id, code: 'PE-25', qty: -2, user });
    assert.strictEqual(onHand(), 47, 'negatief = retour');
    stock.syncUsage(main, { usageId: 'v2', workOrderId: wo.id, code: 'PE-25', qty: 0, user });
    assert.strictEqual(onHand(), 45, 'regel verwijderd');
    // Binnen de transactie van de materiaalregistratie (nested).
    transaction(db, () => stock.syncUsage(main, { usageId: 'v4', workOrderId: wo.id, code: 'PE-25', qty: 1, user }, { nested: true }));
    assert.strictEqual(onHand(), 44);
    stock.syncUsage(main, { usageId: 'v4', workOrderId: wo.id, code: 'PE-25', qty: 0, user });
    assert.strictEqual(stock.syncUsage(main, { usageId: 'v3', workOrderId: wo.id, code: 'GEEN-VOORRAAD', qty: 3, user }), null);
    // Via de materiaalregistratie op de werkorder (zelfde transactie, id terug in stock_movement_id).
    const day = new Date().toISOString().slice(0, 10);
    const used = await kees.post(`/api/workorders/${wo.id}/materials`, { usedOn: day, code: 'PE-25', description: 'PE-buis', unit: 'm', qty: 5 });
    assert.strictEqual(used.status, 201, JSON.stringify(used.body));
    assert.strictEqual(onHand(), 40);
    const entry = used.body.entry || used.body;
    assert.ok(entry.stockMovementId, 'afboeking gekoppeld aan de verbruiksregel');
    assert.strictEqual((await kees.del(`/api/workorders/${wo.id}/materials/${entry.id}`)).status, 200);
    assert.strictEqual(onHand(), 45, 'verwijderde regel wordt teruggeboekt');
    // Gereed: er is verbruik, dus de rest van de reservering (15) vervalt zonder afboeking.
    await kees.put(`/api/workorders/${wo.id}`, { status: 'gereed' });
    assert.strictEqual(onHand(), 45);
    assert.strictEqual(stock.get(main, item.id).reserved, 0);
  } finally {
    server.close();
  }
});

test('voorraad: rechten en scheiding tussen organisaties', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const pien = await as('pien');
    const klant = await as('klant');
    const wo = await workOrder(kees, [['PE-25', 5]]);
    const item = (await kees.post('/api/stock/items', { code: 'PE-25', name: 'PE-buis' })).body;

    // Planner: geen voorraadbeheer, wel de voorraad van een werkorder.
    assert.strictEqual((await pien.get('/api/stock')).status, 403);
    assert.strictEqual((await pien.post('/api/stock/items', { code: 'X', name: 'X' })).status, 403);
    assert.strictEqual((await pien.get(`/api/stock/workorders/${wo.id}`)).status, 200);
    // Klant: niets.
    assert.strictEqual((await klant.get('/api/stock')).status, 403);
    assert.strictEqual((await klant.get(`/api/stock/workorders/${wo.id}`)).status, 403);
    assert.strictEqual((await klant.post(`/api/stock/workorders/${wo.id}/issue`, {})).status, 403);

    // Andere organisatie: 404 op artikel en werkorder.
    const made = await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const piet = await as('piet', 'groen');
    assert.deepStrictEqual((await piet.get('/api/stock')).body.items, []);
    assert.strictEqual((await piet.get(`/api/stock/items/${item.id}`)).status, 404);
    assert.strictEqual((await piet.put(`/api/stock/items/${item.id}`, { name: 'Gekaapt' })).status, 404);
    assert.strictEqual((await piet.post(`/api/stock/items/${item.id}/movements`, { kind: 'ontvangst', qty: 1 })).status, 404);
    assert.strictEqual((await piet.del(`/api/stock/items/${item.id}`)).status, 404);
    assert.strictEqual((await piet.get(`/api/stock/workorders/${wo.id}`)).status, 404);
    assert.strictEqual((await piet.post(`/api/stock/workorders/${wo.id}/issue`, {})).status, 404);
    // Een eigen artikel met dezelfde code mag in de andere organisatie.
    assert.strictEqual((await piet.post('/api/stock/items', { code: 'PE-25', name: 'PE-buis' })).status, 201);
  } finally {
    server.close();
  }
});
