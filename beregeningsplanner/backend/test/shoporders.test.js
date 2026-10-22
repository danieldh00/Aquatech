// Deel 2 van de facturen: webshopbestellingen worden facturen (met debiteur,
// definitief, betaald), facturen als PDF en per e-mail (handmatig en
// automatisch), debiteurenlijst, en rechten/scheiding tussen organisaties.
process.env.SHOP_ALLOW_INSECURE = '1';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { fromOrder, snapRate } = require('../src/webshop/shop-orders');
const { createPdf, wrap, textWidth, encode } = require('../src/verkoop/pdf');
const { invoicePdf } = require('../src/verkoop/invoice-pdf');

const Core = require(path.join(__dirname, '..', '..', 'frontend', 'facturen', 'invoice-core.js'));
const { createLogin, listen } = require('./helpers/http-client');
const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

const order = (id, extra = {}) => ({
  id, number: String(id), status: 'completed', customer_id: 0,
  date_created: '2026-10-20T09:00:00', date_completed: '2026-10-21T10:00:00', date_paid: '2026-10-20T09:01:00',
  date_modified_gmt: `2026-10-21T08:00:${String(id % 60).padStart(2, '0')}`,
  billing: { first_name: 'Petra', last_name: 'Jansen', company: '', address_1: 'Kerkstraat 12', postcode: '8071 CD', city: 'Nunspeet', country: 'NL', email: 'petra@voorbeeld.test', phone: '06' },
  tax_lines: [{ rate_id: 1, rate_percent: 21 }, { rate_id: 2, rate_percent: 9 }],
  line_items: [{ sku: 'PE-25', name: 'PE-buis', quantity: 10, total: '20.00', total_tax: '4.20', taxes: [{ id: 1, total: '4.20' }] }],
  shipping_lines: [{ method_title: 'PostNL', total: '6.95', total_tax: '1.46', taxes: [{ id: 1, total: '1.46' }] }],
  ...extra,
});

// Nagebootste WooCommerce: alleen bestellingen (en een lege productlijst).
function fakeShop(orders) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams) });
    const json = (body) => ({ ok: true, status: 200, headers: new Headers({ 'x-wp-totalpages': '1' }), text: async () => JSON.stringify(body) });
    if (u.pathname.endsWith('/orders')) {
      const after = u.searchParams.get('modified_after') || '';
      return json(orders.filter((o) => o.status === u.searchParams.get('status') && (!after || o.date_modified_gmt > after)));
    }
    return json([]);
  };
  return { fetchImpl, calls };
}

async function setup({ orders = [], mailOn = true } = {}) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  const sent = [];
  const mail = { on: mailOn };
  const mailerFor = () => ({ configured: () => mail.on, send: async (m) => { sent.push(m); return {}; } });
  const shop = fakeShop(orders);
  const { server, base } = await listen(createApp({ secret: SECRET, db, mailerFor, shopFetch: shop.fetchImpl }));
  const as = createLogin(base, { password: PW });
  return { db, server, as, sent, mail, shop, main };
}

test('pdf: tekst in WinAnsi, breedtes, afbreken en een geldig bestand', () => {
  assert.deepStrictEqual(encode('€ é−'), [0x80, 32, 0xe9, 45]);
  assert.strictEqual(textWidth('AAA', 10), 20.01);
  assert.ok(wrap('een twee drie vier vijf zes', 50, 10).length > 1);
  assert.deepStrictEqual(wrap('regel 1\nregel 2', 500, 10), ['regel 1', 'regel 2']);
  const pdf = createPdf({ title: 'Test' });
  pdf.addPage();
  pdf.text('Hallo (wereld) \\ €', 40, 40);
  const buf = pdf.toBuffer();
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  // De xref-tabel wijst naar de objecten.
  const start = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.ok(s.slice(start).startsWith('xref'));
  const first = Number(/xref\n0 \d+\n0000000000 65535 f \n(\d{10})/.exec(s.slice(start))[1]);
  assert.ok(s.slice(first).startsWith('1 0 obj'));
});

test('factuur-pdf: met logo, meerdere pagina\'s bij veel regels', () => {
  const lines = Array.from({ length: 60 }, (_, i) => ({ code: `A${i}`, description: `Artikel ${i}`, qty: 1, unit: 'st', price: 10, vat: 21, group: 'producten' }));
  const inv = { kind: 'factuur', number: 'F2026-0001', status: 'definitief', data: Core.sanitize({ customer: { name: 'Jan' }, lines }) };
  const s = invoicePdf(inv, { profile: { companyName: 'AquaTech Service', iban: 'NL00TEST0123456789' } }).toString('latin1');
  assert.ok(s.includes('/Subtype /Image'), 'logo ingesloten');
  assert.ok(s.includes('/SMask'), 'met transparantie');
  assert.strictEqual(Number(/\/Count (\d+)/.exec(s)[1]), 2);
});

test('bestelling als factuur: klant, btw-tarief per regel, verzendkosten, afronding', () => {
  assert.strictEqual(snapRate(20.6), 21);
  assert.strictEqual(snapRate(9.2), 9);
  const o = order(1, {
    billing: { first_name: 'Petra', last_name: 'Jansen', company: 'Tuin BV', address_1: 'Rue 1', postcode: '1000', city: 'Brussel', country: 'BE', email: 'p@x.test' },
    meta_data: [{ key: '_billing_vat_number', value: 'BE0123456789' }],
    line_items: [
      { sku: 'pe-25', name: 'PE-buis', quantity: 3, total: '10.00', total_tax: '2.10', taxes: [{ id: 1, total: '2.10' }] },
      { sku: '', name: 'Zaad', quantity: 2, total: '5.00', total_tax: '0.45', taxes: [{ id: 2, total: '0.45' }] },
    ],
  });
  const b = fromOrder(o, { articles: { 'PE-25': { unit: 'm', vatRate: 21, revenueGroup: 'producten' } } });
  assert.strictEqual(b.data.customer.name, 'Tuin BV');
  assert.strictEqual(b.data.customer.contact, 'Petra Jansen');
  assert.ok(b.data.customer.address.endsWith('BE'));
  assert.strictEqual(b.data.customer.vatNumber, 'BE0123456789');
  assert.strictEqual(b.data.reference, 'Webshopbestelling #1');
  // 10,00 / 3 komt niet uit: één regel met het totaal.
  assert.deepStrictEqual([b.data.lines[0].qty, b.data.lines[0].price, b.data.lines[0].description], [1, 10, '3 × PE-buis']);
  assert.deepStrictEqual([b.data.lines[1].qty, b.data.lines[1].price, b.data.lines[1].vat], [2, 2.5, 9]);
  assert.deepStrictEqual([b.data.lines[2].description, b.data.lines[2].group, b.data.lines[2].vat], ['Verzendkosten (PostNL)', 'overig', 21]);
  assert.strictEqual(Core.totals(b.data).net, 21.95);
  assert.strictEqual(b.paidOn, '2026-10-20');
  assert.strictEqual(b.data.date, '2026-10-21');
});

test('webshopbestellingen: factuur + debiteur, definitief, betaald, automatisch verstuurd met pdf; niet dubbel', async () => {
  const orders = [order(101), order(102, { date_paid: null, billing: { ...order(1).billing, email: 'ander@voorbeeld.test', first_name: 'Ab' } }),
    order(99, { date_completed: '2026-09-01T10:00:00' })];
  const { server, as, sent, shop } = await setup({ orders });
  try {
    const baas = await as('baas');
    // Nog niet aangezet.
    assert.strictEqual((await baas.post('/api/invoices/shop-orders/sync')).status, 409);
    // Webshop koppelen (REST, voorraad gaat niet naar de webshop) en ophalen aanzetten vanaf 1 oktober.
    assert.strictEqual((await baas.put('/api/admin/shop', { url: 'http://shop.test', mode: 'rest', consumerKey: 'ck_test_1234567890', consumerSecret: 'cs_test_1234567890' })).status, 200);
    const conf = (await baas.get('/api/invoices/settings')).body;
    assert.strictEqual(conf.shop.rest, true);
    assert.strictEqual(conf.settings.shopOrders.enabled, false);
    const put = await baas.put('/api/invoices/settings', { ...conf.settings, autoSend: true, debtorStart: 5000, shopOrders: { enabled: true, status: 'completed', since: '2026-10-01' } });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.settings.shopOrders.finalize, true);
    // Voorraad: PE-25 met 50 op voorraad (zonder voorraadsync boekt de factuur af).
    const item = (await baas.post('/api/stock/items', { code: 'PE-25', name: 'PE-buis', unit: 'm', onHand: 50, salePrice: 2, revenueGroup: 'producten' })).body;

    const r = await baas.post('/api/invoices/shop-orders/sync');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.found, r.body.imported, r.body.finalized, r.body.paid, r.body.sent, r.body.skipped], [3, 2, 2, 1, 2, 1]);
    assert.strictEqual(shop.calls.find((c) => c.path.endsWith('/orders')).query.modified_after, '2026-10-01T00:00:00');
    const list = (await baas.get('/api/invoices')).body.items;
    assert.strictEqual(list.length, 2);
    const paid = list.find((i) => i.status === 'betaald');
    assert.strictEqual(paid.source, 'webshop');
    assert.ok(paid.number.startsWith('F2026-'));
    assert.ok(paid.sentAt);
    const full = (await baas.get(`/api/invoices/${paid.id}`)).body;
    assert.strictEqual(full.debtorNumber, 5000);
    assert.strictEqual(full.total, 32.61);
    // Mail met de pdf als bijlage, betaald = "al voldaan".
    const m = sent.find((x) => x.to.includes('petra@voorbeeld.test'));
    assert.match(m.subject, /^Factuur F2026-\d{4} van /);
    assert.match(m.text, /al voldaan/);
    assert.strictEqual(m.attachments[0].contentType, 'application/pdf');
    assert.ok(m.attachments[0].content.subarray(0, 5).equals(Buffer.from('%PDF-')));
    // Voorraad afgeboekt (2 bestellingen x 10).
    assert.strictEqual((await baas.get(`/api/stock/items/${item.id}`)).body.onHand, 30);
    // Debiteuren: twee (verschillende e-mailadressen), nummers vanaf 5000.
    const debtors = (await baas.get('/api/debtors')).body.items;
    assert.deepStrictEqual(debtors.map((d) => d.number).sort(), [5000, 5001]);
    assert.strictEqual(debtors.find((d) => d.number === 5001).openTotal, 32.61);
    assert.strictEqual(debtors[0].source, 'webshop');

    // Opnieuw ophalen: niets dubbel.
    const again = await baas.post('/api/invoices/shop-orders/sync');
    assert.strictEqual(again.body.imported, 0);
    assert.strictEqual((await baas.get('/api/invoices')).body.items.length, 2);
  } finally {
    server.close();
  }
});

test('factuur versturen: voorstel, pdf, handmatig versturen, automatisch bij definitief, zonder mailserver', async () => {
  const { server, as, sent, mail } = await setup();
  try {
    const baas = await as('baas');
    const inv = (await baas.post('/api/invoices', { data: { customer: { name: 'Jan', email: 'jan@voorbeeld.test' }, lines: [{ description: 'Sproeier', qty: 2, price: 10 }] } })).body;
    // Concept versturen kan niet.
    assert.strictEqual((await baas.post(`/api/invoices/${inv.id}/send`, { to: 'jan@voorbeeld.test' })).status, 409);
    const fin = (await baas.post(`/api/invoices/${inv.id}/finalize`, {})).body;
    assert.strictEqual(fin.autoSent, false);
    assert.strictEqual(sent.length, 0);
    const draft = (await baas.get(`/api/invoices/${inv.id}/mail`)).body;
    assert.strictEqual(draft.to, 'jan@voorbeeld.test');
    assert.match(draft.message, /Beste Jan/);
    assert.match(draft.message, /€\s24,20/);
    const pdf = await baas.get(`/api/invoices/${inv.id}/pdf?download=1`);
    assert.strictEqual(pdf.status, 200);
    assert.strictEqual(pdf.type, 'application/pdf');
    assert.ok(pdf.raw.subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert.strictEqual((await baas.post(`/api/invoices/${inv.id}/send`, { to: 'geen-adres' })).status, 400);
    const s = await baas.post(`/api/invoices/${inv.id}/send`, { to: 'jan@voorbeeld.test, boekhouding@voorbeeld.test', subject: 'Uw factuur', message: 'Hallo' });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    assert.strictEqual(s.body.sentTo, 'jan@voorbeeld.test, boekhouding@voorbeeld.test');
    assert.strictEqual(sent[0].subject, 'Uw factuur');
    assert.match(sent[0].attachments[0].filename, /^Factuur F2026-0001\.pdf$/);

    // Automatisch bij definitief.
    const conf = (await baas.get('/api/invoices/settings')).body.settings;
    await baas.put('/api/invoices/settings', { ...conf, autoSend: true });
    const two = (await baas.post('/api/invoices', { data: { customer: { name: 'Piet', email: 'piet@voorbeeld.test' }, lines: [{ description: 'Arbeid', qty: 1, price: 50, group: 'arbeid' }] } })).body;
    assert.strictEqual((await baas.post(`/api/invoices/${two.id}/finalize`, {})).body.autoSent, true);
    assert.strictEqual(sent.length, 2);
    // Zonder e-mailadres of mailserver: de reden staat op de factuur.
    const three = (await baas.post('/api/invoices', { data: { customer: { name: 'Zonder mail' }, lines: [{ description: 'X', qty: 1, price: 5 }] } })).body;
    const f3 = (await baas.post(`/api/invoices/${three.id}/finalize`, {})).body;
    assert.strictEqual(f3.autoSent, false);
    assert.match(f3.sendError, /geen geldig e-mailadres/);
    mail.on = false;
    assert.strictEqual((await baas.post(`/api/invoices/${inv.id}/send`, { to: 'jan@voorbeeld.test' })).status, 409);
    // Dezelfde klant krijgt dezelfde debiteur.
    const four = (await baas.post('/api/invoices', { data: { customer: { name: 'Jan Andere Naam', email: 'JAN@voorbeeld.test' }, lines: [{ description: 'X', qty: 1, price: 5 }] } })).body;
    const f4 = (await baas.post(`/api/invoices/${four.id}/finalize`, {})).body;
    assert.strictEqual(f4.debtorId, (await baas.get(`/api/invoices/${inv.id}`)).body.debtorId);
    const deb = (await baas.get(`/api/debtors/${f4.debtorId}`)).body;
    assert.strictEqual(deb.name, 'Jan Andere Naam');
    assert.strictEqual(deb.number, 1000);
    const upd = await baas.put(`/api/debtors/${deb.id}`, { name: '', email: 'x' });
    assert.strictEqual(upd.status, 400);
    assert.strictEqual((await baas.put(`/api/debtors/${deb.id}`, { name: 'Jan de Vries' })).body.name, 'Jan de Vries');
    // Export heeft het debiteurnummer.
    const exp = (await baas.get('/api/invoices/export')).body.items;
    assert.ok(exp.every((i) => i.debtorNumber >= 1000));
    assert.strictEqual(Core.exportRows(exp, conf)[0].debtorNumber, exp[0].debtorNumber);
  } finally {
    server.close();
  }
});

test('debiteuren en versturen: recht facturen en scheiding tussen organisaties', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    const inv = (await baas.post('/api/invoices', { data: { customer: { name: 'Jan', email: 'jan@voorbeeld.test' }, lines: [{ description: 'X', qty: 1, price: 5 }] } })).body;
    const fin = (await baas.post(`/api/invoices/${inv.id}/finalize`, {})).body;
    const kees = await as('kees');
    for (const [m, p] of [['get', '/api/debtors'], ['get', `/api/debtors/${fin.debtorId}`], ['get', `/api/invoices/${inv.id}/pdf`], ['get', `/api/invoices/${inv.id}/mail`],
      ['post', `/api/invoices/${inv.id}/send`], ['post', '/api/invoices/shop-orders/sync']]) {
      assert.strictEqual((await kees[m](p, m === 'post' ? { to: 'a@b.test' } : undefined)).status, 403, p);
    }
    await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    const piet = await as('piet', 'groen');
    assert.strictEqual((await piet.get(`/api/debtors/${fin.debtorId}`)).status, 404);
    assert.strictEqual((await piet.put(`/api/debtors/${fin.debtorId}`, { name: 'Hack' })).status, 404);
    assert.strictEqual((await piet.get(`/api/invoices/${inv.id}/pdf`)).status, 404);
    assert.strictEqual((await piet.post(`/api/invoices/${inv.id}/send`, { to: 'a@b.test' })).status, 404);
    assert.strictEqual((await piet.get('/api/debtors')).body.items.length, 0);
  } finally {
    server.close();
  }
});
