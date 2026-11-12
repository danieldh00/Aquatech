// Pakbonnen en Te picken (webshop/packing-slips.js): de PDF, de lijst met te picken bestellingen,
// het vastleggen van het afdrukken en de tenant- en rechtencontrole.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createWebOrderStore } = require('../src/webshop/web-orders');
const { packingSlipsPdf, slipLines, MAX_SLIPS } = require('../src/webshop/packing-slips');
const { createLogin, createClient, listen, postForm, postCheckout } = require('./helpers/http-client');

const SECRET = 'e'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

const CHECKOUT = { name: 'Piet Tuin', company: '', email: 'piet@voorbeeld.nl', phone: '0612345678', street: 'Tuinstraat 1', postcode: '8071ab', city: 'Nunspeet', note: 'Graag bellen', shippingMethod: 'dpd', country: 'NL' };

/**
 * Hoofdtenant met beheerder, de webshop met bestellen aan en artikelen op verschillende magazijnlocaties.
 * @returns {Promise<object>} base, db, admin, vreemd (beheerder van een andere organisatie), shopper() en order(codes) dat een bestelling plaatst.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const app = createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db });
  const { server, base } = await listen(app);
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  assert.strictEqual((await admin.put('/app/api/admin/settings', { storefront: true, shopOrdering: true, shopPayment: { online: false, publicUrl: `${base}/` } })).status, 200);
  for (const item of [
    { code: 'SPR-1', name: 'Sproeier Pro', onHand: 50, salePrice: 10, location: 'B-12' },
    { code: 'BUIS-25', name: 'PE buis 25 mm', onHand: 100, salePrice: 1.5, location: 'A-02' },
    { code: 'LOS', name: 'Zonder locatie', onHand: 100, salePrice: 2 },
  ]) assert.strictEqual((await admin.post('/app/api/stock/items', item)).status, 201);
  let counter = 0;
  /**
   * Registreert een nieuwe klant in de shop.
   * @returns {Promise<object>} De ingelogde client.
   */
  const shopper = async () => {
    counter += 1;
    const client = createClient(base);
    const done = await postForm(base, client, '/registreren/', { displayName: `Klant ${counter}`, email: `klant${counter}@voorbeeld.nl`, password: PW, password2: PW, website: '' });
    assert.strictEqual(done.status, 303);
    return client;
  };
  /**
   * Plaatst een bestelling met de gegeven artikelen (elk 1 stuk, behalve BUIS-25: 3).
   * @param {string[]} codes De artikelcodes.
   * @param {object} [fields] Extra velden voor het afrekenformulier.
   * @returns {Promise<void>}
   */
  const order = async (codes, fields = {}) => {
    const customer = await shopper();
    for (const code of codes) {
      const added = await postForm(base, customer, '/winkelwagen/', { action: 'add', code, qty: code === 'BUIS-25' ? '3' : '1' });
      assert.strictEqual(added.status, 303);
    }
    assert.strictEqual((await postCheckout(base, customer, { ...CHECKOUT, ...fields })).status, 303);
  };
  const vreemd = await createLogin(base, { password: PW })('vreemd', 'ander');
  return { base, db, admin, vreemd, shopper, order };
}

test('slipLines sorteert op magazijnlocatie, zonder locatie onderaan, en rekent verpakkingen om', () => {
  const locations = new Map([['1', 'B-12'], ['2', 'A-02'], ['4', 'A-10']]);
  const lines = slipLines({ lines: [
    { itemId: '1', code: 'X', name: 'Een', qty: 1, unit: 'st' },
    { itemId: '3', code: 'Y', name: 'Drie', qty: 2, unit: 'st' },
    { itemId: '2', code: 'Z@PAL', name: 'Twee', qty: 2, unit: 'pal', stockPer: 50 },
    { itemId: '4', code: 'W', name: 'Vier', qty: 1, unit: 'st' },
  ] }, locations);
  assert.deepStrictEqual(lines.map((line) => line.name), ['Twee', 'Vier', 'Een', 'Drie'], 'A-02, A-10 (numeriek), B-12, zonder locatie');
  assert.strictEqual(lines[0].baseQty, 100);
  assert.strictEqual(lines[3].location, '');
});

test('pickable: alleen nieuwe bestellingen, online alleen als ze betaald zijn', () => {
  const { pickable } = createWebOrderStore(openDb(), { stock: {} });
  assert.strictEqual(pickable({ status: 'nieuw', payment: 'op rekening', pay: null }), true);
  assert.strictEqual(pickable({ status: 'nieuw', payment: 'online', pay: { status: 'open' } }), false);
  assert.strictEqual(pickable({ status: 'nieuw', payment: 'online', pay: { status: 'verlopen' } }), false);
  assert.strictEqual(pickable({ status: 'nieuw', payment: 'online', pay: { status: 'betaald' } }), true);
  assert.strictEqual(pickable({ status: 'verzonden', payment: 'op rekening', pay: null }), false);
  assert.strictEqual(pickable({ status: 'geannuleerd', payment: 'online', pay: { status: 'betaald' } }), false);
});

test('packingSlipsPdf: één pagina per bestelling, lange bestellingen lopen door, tekst met accenten en Engels', () => {
  const base = { number: 'WEB-2026-0001', createdAt: '2026-11-12T10:00:00.000Z', customer: { name: 'Zoë Ünal', company: 'Café Ré', phone: '0612345678' }, address: { street: 'Straat 1', postcode: '8071 AB', city: 'Nunspeet', country: 'NL' }, shipping: { method: 'dpd', label: 'DPD' }, note: '' };
  const short = { ...base, lines: [{ name: 'Sproeier', code: 'S', qty: 1, unit: 'st' }] };
  const long = { ...base, number: 'WEB-2026-0002', language: 'en', note: 'Bel even vooraf. '.repeat(30), lines: Array.from({ length: 90 }, (_, i) => ({ name: `Artikel nummer ${i} met een vrij lange omschrijving die over de regel heen gaat en dus afbreekt`, code: `C${i}`, qty: i + 1, unit: 'st' })) };
  const one = packingSlipsPdf([short], { profile: { companyName: 'AquaTech Service' } });
  assert.strictEqual(one.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(one.toString('latin1'), /\/Count 1 /);
  const both = packingSlipsPdf([short, long], { profile: { companyName: 'AquaTech Service' } });
  const pages = Number(/\/Count (\d+) /.exec(both.toString('latin1'))[1]);
  assert.ok(pages >= 4, `de lange bestelling loopt over meerdere pagina's (${pages})`);
  const pickup = packingSlipsPdf([{ ...short, shipping: { method: 'ophalen', label: 'Ophalen' }, address: { street: '', postcode: '', city: '', country: '' } }]);
  assert.match(pickup.toString('latin1'), /\/Count 1 /);
});

test('Te picken, pakbon per bestelling en alles in één PDF', async () => {
  const { admin, order } = await setup();
  await order(['SPR-1', 'BUIS-25']);
  await order(['LOS']);
  await order(['SPR-1'], { shippingMethod: 'ophalen' });
  const list = await admin.get('/app/api/admin/web-orders/to-pick');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.items.length, 3);
  const [first, second, third] = list.body.items;
  assert.ok(first.number < second.number && second.number < third.number, 'oudste eerst');
  assert.strictEqual(first.lineCount, 2);
  assert.strictEqual(first.pieces, 4);
  assert.strictEqual(first.printedAt, null);
  assert.strictEqual(third.pickup, true);
  assert.match(first.address, /Tuinstraat 1/);

  const single = await admin.post(`/app/api/admin/web-orders/${first.id}/packing-slip`, {});
  assert.strictEqual(single.status, 200);
  assert.match(single.type, /application\/pdf/);
  assert.match(single.headers.get('content-disposition'), /Pakbon WEB-\d{4}-0001\.pdf/);
  assert.strictEqual(single.raw.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(single.headers.get('cache-control'), /no-store/);

  const afterOne = (await admin.get('/app/api/admin/web-orders/to-pick')).body.items;
  assert.ok(afterOne.find((item) => item.id === first.id).printedAt, 'afdrukken wordt vastgelegd');
  assert.strictEqual(afterOne.find((item) => item.id === second.id).printedAt, null);

  const all = await admin.post('/app/api/admin/web-orders/packing-slips', { ids: list.body.items.map((item) => item.id) });
  assert.strictEqual(all.status, 200);
  assert.match(all.raw.toString('latin1'), /\/Count 3 /, 'één pagina per bestelling');
  assert.match(all.headers.get('content-disposition'), /Pakbonnen \d{4}-\d{2}-\d{2}\.pdf/);
  const detail = await admin.get(`/app/api/admin/web-orders/${first.id}`);
  assert.strictEqual(detail.body.order.packingSlip.count, 2, 'twee keer afgedrukt');
});

test('Te picken: verzonden en geannuleerde bestellingen staan er niet bij', async () => {
  const { admin, order } = await setup();
  await order(['SPR-1']);
  await order(['LOS']);
  await order(['BUIS-25']);
  const [keep, ship, cancel] = (await admin.get('/app/api/admin/web-orders/to-pick')).body.items;
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${ship.id}/status`, { status: 'verzonden' })).status, 200);
  assert.strictEqual((await admin.post(`/app/api/admin/web-orders/${cancel.id}/status`, { status: 'geannuleerd' })).status, 200);
  const items = (await admin.get('/app/api/admin/web-orders/to-pick')).body.items;
  assert.deepStrictEqual(items.map((item) => item.id), [keep.id]);
  const cancelled = await admin.post(`/app/api/admin/web-orders/${cancel.id}/packing-slip`, {});
  assert.strictEqual(cancelled.status, 404, 'van een geannuleerde bestelling geen pakbon');
  const shipped = await admin.post(`/app/api/admin/web-orders/${ship.id}/packing-slip`, {});
  assert.strictEqual(shipped.status, 200, 'een verzonden bestelling kan opnieuw worden afgedrukt');
});

test('pakbonnen: ongeldige invoer, andere organisatie en ontbrekend recht', async () => {
  const { base, admin, vreemd, shopper, order } = await setup();
  await order(['SPR-1']);
  const [item] = (await admin.get('/app/api/admin/web-orders/to-pick')).body.items;
  assert.strictEqual((await admin.post('/app/api/admin/web-orders/packing-slips', { ids: [] })).status, 400);
  assert.strictEqual((await admin.post('/app/api/admin/web-orders/packing-slips', {})).status, 400);
  assert.strictEqual((await admin.post('/app/api/admin/web-orders/packing-slips', { ids: Array.from({ length: MAX_SLIPS + 1 }, (_, i) => `id-${i}`) })).status, 400);
  assert.strictEqual((await admin.post('/app/api/admin/web-orders/packing-slips', { ids: ['bestaat-niet'] })).status, 404);
  assert.strictEqual((await admin.post('/app/api/admin/web-orders/bestaat-niet/packing-slip', {})).status, 404);
  // Een andere organisatie ziet de bestelling niet: 404, en haar lijst is leeg.
  assert.strictEqual((await vreemd.post(`/app/api/admin/web-orders/${item.id}/packing-slip`, {})).status, 404);
  assert.strictEqual((await vreemd.post('/app/api/admin/web-orders/packing-slips', { ids: [item.id] })).status, 404);
  assert.deepStrictEqual((await vreemd.get('/app/api/admin/web-orders/to-pick')).body.items, []);
  // Een klant en een bezoeker hebben geen toegang.
  const customer = await shopper();
  for (const client of [customer, createClient(base)]) {
    assert.ok([401, 403].includes((await client.get('/app/api/admin/web-orders/to-pick')).status));
    assert.ok([401, 403].includes((await client.post(`/app/api/admin/web-orders/${item.id}/packing-slip`, {})).status));
    assert.ok([401, 403].includes((await client.post('/app/api/admin/web-orders/packing-slips', { ids: [item.id] })).status));
  }
  // Niets is vastgelegd door de afgewezen verzoeken.
  assert.strictEqual((await admin.get('/app/api/admin/web-orders/to-pick')).body.items[0].printedAt, null);
  // Een GET schrijft niets: de pakbon van één bestelling is alleen via POST te maken.
  assert.notStrictEqual((await admin.get(`/app/api/admin/web-orders/${item.id}/packing-slip`)).status, 200);
  assert.strictEqual((await admin.get('/app/api/admin/web-orders/to-pick')).body.items[0].printedAt, null);
});

test('Te picken: een online bestelling staat er pas bij als hij betaald is (filter in SQL)', async () => {
  const { db, admin, order } = await setup();
  await order(['SPR-1']);
  await order(['LOS']);
  const [open, paid] = (await admin.get('/app/api/admin/web-orders/to-pick')).body.items;
  /**
   * Zet een bestelling op online betalen met een betaalstatus.
   * @param {string} id Id van de bestelling.
   * @param {string} status De betaalstatus.
   * @returns {void}
   */
  const setOnline = (id, status) => {
    const row = db.prepare('SELECT data FROM web_orders WHERE id = ?').get(id);
    const data = JSON.parse(row.data);
    data.payment = 'online';
    data.pay = { status };
    db.prepare('UPDATE web_orders SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
  };
  setOnline(open.id, 'open');
  setOnline(paid.id, 'betaald');
  assert.deepStrictEqual((await admin.get('/app/api/admin/web-orders/to-pick')).body.items.map((item) => item.id), [paid.id]);
  setOnline(open.id, 'betaald');
  assert.strictEqual((await admin.get('/app/api/admin/web-orders/to-pick')).body.items.length, 2);
});
