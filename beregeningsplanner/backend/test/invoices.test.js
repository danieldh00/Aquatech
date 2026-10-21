// Facturen: uit een werkorder (offerteregels + meerwerk), losse verkoop met
// voorraad, definitief met doorlopend nummer, betaald, crediteren, export
// per omzetcategorie, en rechten/scheiding tussen organisaties.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'facturen', 'invoice-core.js'));
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
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, org) => {
    const c = client(base);
    const r = await c.post('/api/auth/login', { username, password: PW, tenant: org });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return c;
  };
  return { db, server, as };
}

test('factuurkern: totalen per btw-tarief en omzetcategorie, instellingen, credit', () => {
  const s = Core.sanitizeSettings({ prefix: 'F/', paymentDays: 30, categories: { 'producten:21': { name: 'Omzet producten hoog', account: '8000' } } });
  assert.strictEqual(s.prefix, 'F/');
  assert.strictEqual(s.categories['producten:21'].account, '8000');
  assert.strictEqual(s.categories['arbeid:9'].name, 'Omzet arbeid laag (9%)');
  assert.deepStrictEqual(Core.sanitizeSettings({}).categories['arbeid:21'], { name: 'Omzet diensten hoog tarief', account: '8140' });
  assert.strictEqual(Core.sanitizeSettings({ categories: { 'arbeid:21': { account: '' } } }).categories['arbeid:21'].account, '');
  assert.strictEqual(Core.sanitizeSettings({}).prefix, 'F');
  const inv = Core.sanitize({ date: '2026-10-01', discountPct: 10, lines: [
    { description: 'Sproeier', qty: 10, price: 10, vat: 21, group: 'producten' },
    { description: 'Arbeid', qty: 2, price: 50, vat: 21, group: 'arbeid' },
    { description: 'Plantenvoeding', qty: 1, price: 100, vat: 9, group: 'producten' },
  ] }, s);
  assert.strictEqual(inv.dueDate, '2026-10-31');
  const t = Core.totals(inv, s);
  assert.strictEqual(t.subtotal, 300);
  assert.strictEqual(t.net, 270);
  assert.deepStrictEqual(t.vat, [{ rate: 21, base: 180, amount: 37.8 }, { rate: 9, base: 90, amount: 8.1 }]);
  assert.strictEqual(t.total, 315.9);
  const cat = Object.fromEntries(t.categories.map((c) => [c.key, [c.name, c.account, c.base]]));
  assert.deepStrictEqual(cat['producten:21'], ['Omzet producten hoog', '8000', 90]);
  assert.deepStrictEqual(cat['arbeid:21'], ['Omzet diensten hoog tarief', '8140', 90]);
  const rows = Core.exportRows([{ number: 'F2026-0001', data: inv }], s);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(Math.round(rows.reduce((a, r) => a + r.total, 0) * 100) / 100, 315.9);
  const cr = Core.sanitize(Core.creditOf({ number: 'F2026-0001', data: inv }), s);
  assert.strictEqual(Core.totals(cr, s).total, -315.9);
  assert.strictEqual(cr.creditOfNumber, 'F2026-0001');
  assert.match(Core.paymentText(s, { number: 'F1', iban: 'NL00BANK0123456789' }), /30 dagen.*NL00BANK0123456789.*F1/);
});

test('facturen: uit een werkorder, definitief met nummer, betaald, credit en export', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    // Offerte met een optie die niet gekozen is, akkoord, werkorder.
    const q = (await kees.post('/api/quotes', { data: { title: 'Aanleg', discountPct: 0, customer: { name: 'Fam. Jansen', address: 'Dorpsstraat 1, Nunspeet', email: 'jansen@voorbeeld.test' },
      lines: [{ section: 'materiaal', code: 'PE-25', description: 'PE-buis', qty: 50, unit: 'm', price: 2, vat: 21 },
        { section: 'arbeid', description: 'Sleuven graven', qty: 4, unit: 'uur', price: 55, vat: 21 },
        { section: 'materiaal', code: 'X-OPT', description: 'Regensensor', qty: 1, unit: 'st', price: 80, vat: 21, optional: true, selected: false }] } })).body;
    assert.strictEqual((await kees.put(`/api/quotes/${q.id}`, { status: 'akkoord' })).status, 200);
    const wo = (await kees.post('/api/workorders', { quoteId: q.id })).body;
    // Meerwerk: een artikel dat niet in de offerte stond, met verkoopprijs uit de voorraad.
    assert.strictEqual((await baas.post('/api/stock/items', { code: 'VAL-24V', name: 'Magneetventiel', salePrice: 39.95, onHand: 10 })).status, 201);
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/materials`, { code: 'VAL-24V', description: 'Magneetventiel', qty: 2, unit: 'st', usedOn: Core.today() })).status, 201);

    // Installateur heeft standaard geen recht op facturen.
    assert.strictEqual((await kees.get('/api/invoices')).status, 403);
    assert.strictEqual((await kees.post('/api/invoices', { workOrderId: wo.id })).status, 403);

    const made = await baas.post('/api/invoices', { workOrderId: wo.id });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const inv = made.body;
    assert.strictEqual(inv.status, 'concept');
    assert.strictEqual(inv.number, '');
    assert.deepStrictEqual(inv.data.lines.map((l) => [l.code, l.qty, l.price, l.group]),
      [['PE-25', 50, 2, 'producten'], ['', 4, 55, 'arbeid'], ['VAL-24V', 2, 39.95, 'producten']]);
    assert.match(inv.data.lines[2].description, /^Meerwerk/);
    assert.strictEqual(inv.data.workOrderNumber, wo.number);
    assert.strictEqual(inv.total, Math.round((100 + 220 + 79.9) * 1.21 * 100) / 100);
    // Nog een factuur voor dezelfde werkorder: eerst bevestigen.
    const again = await baas.post('/api/invoices', { workOrderId: wo.id });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.invoiceId, inv.id);

    // Concept aanpassen, daarna definitief: nummer en vergrendeld.
    const edited = await baas.put(`/api/invoices/${inv.id}`, { data: { ...inv.data, reference: 'Aanleg beregening' } });
    assert.strictEqual(edited.status, 200);
    const fin = await baas.post(`/api/invoices/${inv.id}/finalize`, {});
    assert.strictEqual(fin.status, 200, JSON.stringify(fin.body));
    assert.strictEqual(fin.body.number, `F${inv.data.date.slice(0, 4)}-0001`);
    assert.strictEqual((await baas.put(`/api/invoices/${inv.id}`, { data: inv.data })).status, 409);
    assert.strictEqual((await baas.del(`/api/invoices/${inv.id}`)).status, 409);
    assert.strictEqual((await baas.post(`/api/invoices/${inv.id}/finalize`, {})).status, 409);
    // Werkorder boekt zijn eigen voorraad: de factuur niet.
    assert.strictEqual(fin.body.stockBooked, false);

    // Betaald en weer open.
    assert.strictEqual((await baas.post(`/api/invoices/${inv.id}/paid`, { paid: true, date: '2026-10-05' })).body.status, 'betaald');

    // Credit: concept met negatieve regels, definitief krijgt het volgende nummer.
    const cr = await baas.post(`/api/invoices/${inv.id}/credit`, {});
    assert.strictEqual(cr.status, 201);
    assert.strictEqual(cr.body.kind, 'credit');
    assert.strictEqual(cr.body.total, -fin.body.total);
    assert.strictEqual((await baas.post(`/api/invoices/${inv.id}/credit`, {})).body.id, cr.body.id);
    const crFin = await baas.post(`/api/invoices/${cr.body.id}/finalize`, {});
    assert.strictEqual(crFin.body.number, `F${inv.data.date.slice(0, 4)}-0002`);
    assert.ok((await baas.get(`/api/invoices/${inv.id}`)).body.creditedAt);

    // Instellingen: omzetcategorie met grootboekrekening, export per categorie.
    const st = await baas.put('/api/invoices/settings', { prefix: 'VF', paymentDays: 30, categories: { 'producten:21': { name: 'Omzet producten hoog', account: '8000' } } });
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.body.settings.categories['producten:21'].account, '8000');
    const exp = await baas.get('/api/invoices/export?new=1');
    assert.strictEqual(exp.status, 200);
    assert.strictEqual(exp.body.items.length, 2);
    const rows = Core.exportRows(exp.body.items, exp.body.settings);
    assert.ok(rows.some((r) => r.category === 'Omzet producten hoog' && r.account === '8000' && r.base === 179.9));
    assert.strictEqual((await baas.post('/api/invoices/export/mark', { ids: exp.body.items.map((i) => i.id) })).body.marked, 2);
    assert.strictEqual((await baas.get('/api/invoices/export?new=1')).body.items.length, 0);
    assert.strictEqual((await baas.get('/api/invoices?status=betaald')).body.items.length, 1);
  } finally {
    server.close();
  }
});

test('facturen: losse verkoop boekt de voorraad af, credit boekt terug', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const item = (await baas.post('/api/stock/items', { code: 'ZAND', name: 'Straatzand', unit: 'zak', salePrice: 7.5, onHand: 10 })).body;
    const arts = (await baas.get('/api/invoices/articles')).body.articles;
    assert.strictEqual(arts.ZAND.salePrice, 7.5);
    assert.strictEqual((await baas.post('/api/invoices', { data: [] })).status, 400);
    const inv = (await baas.post('/api/invoices', { data: { customer: { name: '' }, lines: [{ code: 'ZAND', description: 'Straatzand', qty: 3, price: 7.5 }] } })).body;
    // Zonder klantnaam niet definitief.
    assert.strictEqual((await baas.post(`/api/invoices/${inv.id}/finalize`, {})).body.field, 'customer');
    await baas.put(`/api/invoices/${inv.id}`, { data: { ...inv.data, customer: { name: 'Balieklant' } } });
    const fin = (await baas.post(`/api/invoices/${inv.id}/finalize`, {})).body;
    assert.strictEqual(fin.stockBooked, true);
    assert.strictEqual((await baas.get(`/api/stock/items/${item.id}`)).body.onHand, 7);
    const cr = (await baas.post(`/api/invoices/${inv.id}/credit`, {})).body;
    await baas.post(`/api/invoices/${cr.id}/finalize`, {});
    assert.strictEqual((await baas.get(`/api/stock/items/${item.id}`)).body.onHand, 10);
    // Concept verwijderen kan wel.
    const c2 = (await baas.post('/api/invoices', {})).body;
    assert.strictEqual((await baas.del(`/api/invoices/${c2.id}`)).status, 200);
    assert.strictEqual((await baas.get(`/api/invoices/${c2.id}`)).status, 404);
  } finally {
    server.close();
  }
});

test('facturen: rechten en scheiding tussen organisaties', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const klant = await as('klant');
    const inv = (await baas.post('/api/invoices', { data: { customer: { name: 'X' }, lines: [{ description: 'Iets', qty: 1, price: 10 }] } })).body;
    for (const [m, p] of [['get', '/api/invoices'], ['get', `/api/invoices/${inv.id}`], ['get', '/api/invoices/export'], ['get', '/api/invoices/settings'], ['post', '/api/invoices']]) {
      assert.strictEqual((await klant[m](p)).status, 403, `${m} ${p}`);
    }
    const made = await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const piet = await as('piet', 'groen');
    assert.deepStrictEqual((await piet.get('/api/invoices')).body.items, []);
    assert.strictEqual((await piet.get(`/api/invoices/${inv.id}`)).status, 404);
    assert.strictEqual((await piet.put(`/api/invoices/${inv.id}`, { data: {} })).status, 404);
    assert.strictEqual((await piet.post(`/api/invoices/${inv.id}/finalize`, {})).status, 404);
    assert.strictEqual((await piet.post(`/api/invoices/${inv.id}/credit`, {})).status, 404);
    assert.strictEqual((await piet.post(`/api/invoices/${inv.id}/paid`, {})).status, 404);
    assert.strictEqual((await piet.del(`/api/invoices/${inv.id}`)).status, 404);
    assert.strictEqual((await piet.post('/api/invoices/export/mark', { ids: [inv.id] })).body.marked, 0);
    // Eigen nummering per organisatie.
    const own = (await piet.post('/api/invoices', { data: { customer: { name: 'Y' }, lines: [{ description: 'Iets', qty: 1, price: 10 }] } })).body;
    await baas.post(`/api/invoices/${inv.id}/finalize`, {});
    assert.match((await piet.post(`/api/invoices/${own.id}/finalize`, {})).body.number, /-0001$/);
  } finally {
    server.close();
  }
});
