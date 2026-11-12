// Leveranciersdocument inlezen (artikelen/order-read-route.js, order-matching.js): koppelen, route, limieten,
// rechten, een order direct inboeken (alles of niets) en artikelnummers van de leverancier onthouden.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { matchSupplier, matchLines, similarity } = require('../src/artikelen/order-matching');
const { validate } = require('../src/artikelen/order-reader');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const FILE = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test').toString('base64')}`;

/**
 * Testserver met nep-lezer die het vaste document teruggeeft.
 * @param {object} document Wat de nep-lezer teruggeeft.
 * @returns {Promise<object>} server, as, calls (aantal leesopdrachten).
 */
async function setup(document) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const calls = { count: 0 };
  /**
   * Nep-lezer: geeft het vaste document.
   * @returns {object} De lezer.
   */
  const createOrderReader = () => ({
    available: true, model: 'test-model',
    /**
     * Leest "het document".
     * @returns {Promise<object>} Het gelezen document met verbruik.
     */
    async read() { calls.count += 1; return { ...validate(document), model: 'test-model', usage: { input_tokens: 100, output_tokens: 50 } }; },
  });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db, anthropicApiKey: 'sk-ant-test-test-test-test', createOrderReader }));
  return { server, calls, as: createLogin(base, { password: PW }) };
}

const DOCUMENT = {
  supplierName: 'Tuintechniek B.V.', documentNumber: 'OB-77', documentDate: '2026-11-10', documentType: 'orderbevestiging',
  lines: [
    { supplierSku: 'TT-PIJP', description: 'Pijp', qty: 50, unit: 'm', unitPrice: 1.4 },
    { supplierSku: 'X-1', description: 'Klep 3/4 inch', qty: 4, unit: 'st', unitPrice: 9 },
    { supplierSku: 'ZZ', description: 'Onbekend ding', qty: 2, unit: 'st', unitPrice: null },
  ],
};

test('inlezen: koppelen van leverancier en regels', () => {
  assert.strictEqual(matchSupplier('Tuintechniek B.V.', [{ id: 'a', name: 'Tuintechniek' }]).id, 'a');
  assert.strictEqual(matchSupplier('Iets anders', [{ id: 'a', name: 'Tuintechniek' }]), null);
  assert.strictEqual(matchSupplier('', [{ id: 'a', name: 'Tuintechniek' }]), null);
  assert.ok(similarity('klep 3/4 inch', 'Klep 3 4 inch') > 0.9);
  const items = [{ id: 'p', code: 'PIJP', name: 'Pijp 25 mm' }, { id: 'k', code: 'KLEP', name: 'Klep 3/4 inch' }];
  const result = matchLines([{ supplierSku: 'tt-pijp', description: 'x' }, { supplierSku: '', description: 'Klep 3/4 inch' }, { supplierSku: 'Q', description: 'Niets' }], items, new Map([['tt pijp', 'p']]));
  assert.deepStrictEqual(result.map((entry) => [entry.itemId, entry.matchedBy]), [['p', 'leveranciersnummer'], ['k', 'omschrijving'], [null, null]]);
});

test('inlezen: gelezen document opschonen', () => {
  const out = validate({ supplierName: ' X ', documentDate: 'gisteren', documentType: 'raar', lines: [{ description: 'a', qty: 0 }, { description: 'b', qty: '3', unitPrice: -1 }, { qty: 2 }] });
  assert.deepStrictEqual([out.supplierName, out.documentDate, out.documentType, out.lines.length, out.lines[0].qty], ['X', '', 'overig', 1, 3]);
});

test('inlezen: route koppelt aan artikelen, schrijft niets en kent limieten en rechten', async () => {
  const { server, calls, as } = await setup(DOCUMENT);
  try {
    const baas = await as('baas');
    const supplier = (await baas.post('/app/api/suppliers', { name: 'Tuintechniek' })).body;
    const pipe = (await baas.post('/app/api/stock/items', { code: 'PIJP', name: 'Pijp 25 mm', costPrice: 2 })).body;
    await baas.post('/app/api/stock/items', { code: 'KLEP', name: 'Klep 3/4 inch', costPrice: 10 });
    await baas.put(`/app/api/stock/items/${pipe.id}/suppliers`, { suppliers: [{ supplierId: supplier.id, supplierSku: 'TT-PIJP' }] });
    const read = await baas.post('/app/api/purchase-orders/read', { file: FILE });
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    assert.strictEqual(read.body.supplier.id, supplier.id);
    assert.deepStrictEqual(read.body.lines.map((line) => line.match.matchedBy), ['leveranciersnummer', 'omschrijving', null]);
    assert.strictEqual(read.body.documentNumber, 'OB-77');
    assert.strictEqual((await baas.get('/app/api/purchase-orders')).body.items.length, 0);
    assert.strictEqual((await baas.post('/app/api/purchase-orders/read', { file: 'data:text/html;base64,AAAA' })).status, 400);
    assert.strictEqual((await baas.post('/app/api/purchase-orders/read', {})).status, 400);
    // Type PDF maar andere inhoud: geweigerd vóór de betaalde AI-aanroep.
    assert.strictEqual((await baas.post('/app/api/purchase-orders/read', { file: `data:application/pdf;base64,${Buffer.from('<html>').toString('base64')}` })).status, 400);
    assert.strictEqual(calls.count, 1);
    const klant = await as('klant');
    assert.strictEqual((await klant.post('/app/api/purchase-orders/read', { file: FILE })).status, 403);
    const usage = await baas.get('/app/api/admin/ai-usage');
    assert.ok(JSON.stringify(usage.body).includes('inkoop_inlezen'));
  } finally { server.close(); }
});

test('inboeken: order direct ontvangen, alles of niets, en leveranciersnummers onthouden', async () => {
  const { server, as } = await setup(DOCUMENT);
  try {
    const baas = await as('baas');
    const supplier = (await baas.post('/app/api/suppliers', { name: 'Tuintechniek' })).body;
    const valve = (await baas.post('/app/api/stock/items', { code: 'KLEP', name: 'Klep', costPrice: 10 })).body;
    const pipe = (await baas.post('/app/api/stock/items', { code: 'PIJP', name: 'Pijp', costPrice: 2 })).body;
    const bad = await baas.post('/app/api/purchase-orders', { supplierId: supplier.id, receiveNow: true, lines: [{ itemId: valve.id, qty: 4, unitCost: 9 }, { itemId: 'bestaat-niet', qty: 1 }] });
    assert.ok(bad.status >= 400 && bad.status < 500, JSON.stringify(bad.body));
    assert.strictEqual((await baas.get('/app/api/purchase-orders')).body.items.length, 0);
    assert.strictEqual((await baas.get(`/app/api/stock/items/${valve.id}`)).body.onHand, 0);
    // Zonder regels mislukt het inboeken pas nadat de order is geschreven: die moet dan weer weg zijn.
    const empty = await baas.post('/app/api/purchase-orders', { supplierId: supplier.id, receiveNow: true, lines: [] });
    assert.strictEqual(empty.status, 409, JSON.stringify(empty.body));
    assert.strictEqual((await baas.get('/app/api/purchase-orders?status=')).body.items.length, 0);
    const ok = await baas.post('/app/api/purchase-orders', { supplierId: supplier.id, receiveNow: true, rememberSkus: true, supplierReference: 'OB-77',
      lines: [{ itemId: valve.id, qty: 4, unitCost: 9, supplierSku: 'X-1' }, { itemId: pipe.id, qty: 50, unitCost: 1.4, supplierSku: 'TT-PIJP' }] });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.status, 'ontvangen');
    assert.strictEqual(ok.body.supplierReference, 'OB-77');
    assert.strictEqual((await baas.get(`/app/api/stock/items/${valve.id}`)).body.onHand, 4);
    const links = await baas.get(`/app/api/stock/items/${valve.id}/suppliers`);
    assert.strictEqual(links.body.items[0].supplierSku, 'X-1');
  } finally { server.close(); }
});
