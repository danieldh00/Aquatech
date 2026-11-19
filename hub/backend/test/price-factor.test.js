// Prijsfactor op de inkoopprijs (artikelen/price-factor.js): afronden, de rangorde van de factoren, het opschonen en
// controleren van de instelling, en de routes (rechten, tenant, voorbeeld, doorvoeren, meteen berekenen bij opslaan).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const PriceFactor = require('../src/artikelen/price-factor');
const { createLogin, listen } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';
const SECRET = 's'.repeat(64);
const servers = [];
after(() => { for (const server of servers) server.close(); });

/** De categorieën waarmee de test een artikel in de boom hangt. */
const PARENT = { slug: 'druppelslang-toebehoren', name: 'Druppelslangen & toebehoren' };
const CHILD = { slug: 'driptape-koppelingen', name: 'Driptape koppelingen' };

test('prijsfactor: afronden op stappen en op eindgetallen', () => {
  /**
   * Rondt een prijs af met de gegeven regel.
   * @param {number} price De prijs.
   * @param {string} mode De afrondingsregel.
   * @param {string} [direction] dichtstbij of omhoog.
   * @returns {number} De afgeronde prijs.
   */
  const round = (price, mode, direction = 'dichtstbij') => PriceFactor.roundPrice(price, { mode, direction });
  assert.strictEqual(round(12.344, 'cent'), 12.34);
  assert.strictEqual(round(1.15 * 3, 'cent'), 3.45);
  assert.strictEqual(round(12.33, '0.05'), 12.35);
  assert.strictEqual(round(12.31, '0.05', 'omhoog'), 12.35);
  assert.strictEqual(round(12.30, '0.05', 'omhoog'), 12.3);
  assert.strictEqual(round(12.34, '0.10'), 12.3);
  assert.strictEqual(round(12.74, '0.50'), 12.5);
  assert.strictEqual(round(12.4, '1.00'), 12);
  assert.strictEqual(round(12.4, '1.00', 'omhoog'), 13);
  // Een kleine prijs wordt niet nul.
  assert.strictEqual(round(0.01, '1.00'), 1);
  assert.strictEqual(round(0.02, '0.05'), 0.05);
  assert.strictEqual(round(0, 'cent'), 0);
  assert.strictEqual(round(-3, 'cent'), 0);
  // Eindgetal: dichtstbij of eerstvolgende hogere.
  assert.strictEqual(round(18, 'x.95'), 17.95);
  assert.strictEqual(round(18.5, 'x.95'), 18.95);
  assert.strictEqual(round(18, 'x.95', 'omhoog'), 18.95);
  assert.strictEqual(round(18.95, 'x.95', 'omhoog'), 18.95);
  assert.strictEqual(round(19.2, 'x.99'), 18.99);
  assert.strictEqual(round(19.6, 'x.99'), 19.99);
  assert.strictEqual(round(0.3, 'x.95'), 0.95);
  assert.strictEqual(round(0.3, 'x.99', 'omhoog'), 0.99);
  assert.strictEqual(round(7, 'onbekend'), 7);
});

test('prijsfactor: factor, marge en rangorde', () => {
  const config = PriceFactor.sanitizePriceFactors({ defaultFactor: 1.8, suppliers: [{ supplierId: 'lev1', factor: 2.2 }] });
  assert.deepStrictEqual(PriceFactor.resolveFactor({}, config), { factor: 1.8, source: 'standaard' });
  assert.deepStrictEqual(PriceFactor.resolveFactor({ categoryFactor: 2 }, config), { factor: 2, source: 'categorie' });
  assert.deepStrictEqual(PriceFactor.resolveFactor({ categoryFactor: 2, supplierId: 'lev1' }, config), { factor: 2.2, source: 'leverancier' });
  assert.deepStrictEqual(PriceFactor.resolveFactor({ categoryFactor: 2, supplierId: 'lev1', itemFactor: 3 }, config), { factor: 3, source: 'artikel' });
  assert.deepStrictEqual(PriceFactor.resolveFactor({ supplierId: 'onbekend' }, config), { factor: 1.8, source: 'standaard' });
  assert.strictEqual(PriceFactor.resolveFactor({}, PriceFactor.sanitizePriceFactors({})), null);
  assert.strictEqual(PriceFactor.priceFrom(10, 1.8, { mode: 'cent', direction: 'dichtstbij' }), 18);
  assert.strictEqual(PriceFactor.priceFrom(null, 1.8, { mode: 'cent' }), null);
  assert.strictEqual(PriceFactor.priceFrom(0, 1.8, { mode: 'cent' }), null);
  assert.strictEqual(PriceFactor.marginPct(18, 10), 44.4);
  assert.strictEqual(PriceFactor.marginPct(8, 10), -25);
  assert.strictEqual(PriceFactor.marginPct(0, 10), null);
  assert.strictEqual(PriceFactor.marginPct(null, 10), null);
  assert.strictEqual(PriceFactor.marginPct(10, null), null);
});

test('prijsfactor: instelling opschonen en streng controleren', () => {
  const clean = PriceFactor.sanitizePriceFactors({
    defaultFactor: '1.5', rounding: { mode: 'x.99', direction: 'omhoog' },
    categories: [{ categorySlug: 'b', factor: 2 }, { categorySlug: 'a', factor: 0 }, { categorySlug: 'b', factor: 2.5 }, { categorySlug: '', factor: 2 }],
    suppliers: [{ supplierId: 'x', factor: 99 }, { supplierId: 'y', factor: 1.23456 }],
  });
  assert.strictEqual(clean.defaultFactor, 1.5);
  assert.deepStrictEqual(clean.rounding, { mode: 'x.99', direction: 'omhoog' });
  assert.deepStrictEqual(clean.categories, [{ categorySlug: 'b', factor: 2.5 }]);
  assert.deepStrictEqual(clean.suppliers, [{ supplierId: 'y', factor: 1.2346 }]);
  assert.deepStrictEqual(PriceFactor.sanitizePriceFactors('troep'), { defaultFactor: null, rounding: { mode: 'cent', direction: 'dichtstbij' }, categories: [], suppliers: [] });
  const slugs = new Set(['a']);
  const suppliers = new Set(['s1']);
  assert.strictEqual(PriceFactor.check({ defaultFactor: 1.5, categories: [{ categorySlug: 'a', factor: 2 }], suppliers: [{ supplierId: 's1', factor: 2 }] }, slugs, suppliers), '');
  assert.match(PriceFactor.check({ defaultFactor: 0 }, slugs, suppliers), /factor/);
  assert.match(PriceFactor.check({ defaultFactor: 'abc' }, slugs, suppliers), /factor/);
  assert.match(PriceFactor.check({ rounding: { mode: 'x', direction: 'omhoog' } }, slugs, suppliers), /afronding/);
  for (const mode of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.match(PriceFactor.check({ rounding: { mode, direction: 'omhoog' } }, slugs, suppliers), /afronding/, mode);
    assert.strictEqual(PriceFactor.sanitizePriceFactors({ rounding: { mode } }).rounding.mode, 'cent');
    assert.strictEqual(PriceFactor.roundPrice(12.344, { mode, direction: 'dichtstbij' }), 12.34);
  }
  assert.match(PriceFactor.check({ categories: [{ categorySlug: 'weg', factor: 2 }] }, slugs, suppliers), /categorie/);
  assert.match(PriceFactor.check({ suppliers: [{ supplierId: 'weg', factor: 2 }] }, slugs, suppliers), /leverancier/);
  assert.match(PriceFactor.check({ categories: [{ categorySlug: 'a', factor: 2 }, { categorySlug: 'a', factor: 3 }] }, slugs, suppliers), /twee keer/);
  assert.match(PriceFactor.check({ categories: [{ categorySlug: 'a', factor: 99 }] }, slugs, suppliers), /factor/);
  assert.match(PriceFactor.check(null, slugs, suppliers), /Ongeldig/);
});

/**
 * Twee organisaties met een beheerder, een installateur en een klant, plus een testserver.
 * @returns {Promise<object>} db, main (id van de hoofdtenant), admin, staff, klant en vreemd (clients).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  return { db, main, admin: await as('baas'), staff: await as('kees'), klant: await as('klant'), vreemd: await as('vreemd', 'ander') };
}

test('prijsfactor: instellen, rechten en scheiding tussen organisaties', async () => {
  const { admin, staff, klant, vreemd } = await setup();
  const supplier = (await admin.post('/app/api/suppliers', { name: 'Groothandel' })).body;
  const config = { defaultFactor: 1.8, rounding: { mode: 'x.95', direction: 'dichtstbij' }, categories: [{ categorySlug: CHILD.slug, factor: 2 }], suppliers: [{ supplierId: supplier.id, factor: 2.5 }] };
  // Lezen mag met recht voorraad; wijzigen alleen een beheerder; een klant niets.
  assert.strictEqual((await staff.get('/app/api/stock/price-factors')).status, 200);
  assert.strictEqual((await klant.get('/app/api/stock/price-factors')).status, 403);
  assert.strictEqual((await staff.put('/app/api/stock/price-factors', config)).status, 403);
  // De goedkeuringsroutes bestaan niet meer.
  assert.strictEqual((await admin.post('/app/api/stock/price-factors/apply', { items: [] })).status, 404);
  assert.strictEqual((await admin.get('/app/api/stock/price-proposals')).status, 404);
  const saved = await admin.put('/app/api/stock/price-factors', config);
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.strictEqual(saved.body.config.defaultFactor, 1.8);
  assert.ok(saved.body.categories.some((category) => category.slug === CHILD.slug));
  assert.ok(saved.body.suppliers.some((entry) => entry.id === supplier.id));
  // Ongeldig: onbekende categorie, onbekende leverancier, factor buiten de grenzen.
  assert.strictEqual((await admin.put('/app/api/stock/price-factors', { categories: [{ categorySlug: 'bestaat-niet', factor: 2 }] })).status, 400);
  assert.strictEqual((await admin.put('/app/api/stock/price-factors', { suppliers: [{ supplierId: 'x', factor: 2 }] })).status, 400);
  assert.strictEqual((await admin.put('/app/api/stock/price-factors', { defaultFactor: 500 })).status, 400);
  // Een andere organisatie ziet niets van deze instelling of deze leverancier en kan niets wijzigen.
  const foreign = await vreemd.get('/app/api/stock/price-factors');
  assert.strictEqual(foreign.status, 200);
  assert.strictEqual(foreign.body.config.defaultFactor, null);
  assert.deepStrictEqual(foreign.body.suppliers, []);
  assert.strictEqual((await vreemd.put('/app/api/stock/price-factors', { suppliers: [{ supplierId: supplier.id, factor: 2 }] })).status, 400);
});

/**
 * De automatische prijswijzigingen in het auditlog van een omgeving.
 * @param {object} db De database.
 * @param {string} tenantId Id van de omgeving.
 * @returns {object[]} De details (artikel, oud, nieuw, bron), oudste eerst.
 */
function priceAudit(db, tenantId) {
  return db.prepare("SELECT detail FROM audit WHERE tenant_id = ? AND action = 'verkoopprijs_automatisch' ORDER BY created_at, id").all(tenantId)
    .map((row) => (typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail));
}

test('prijsfactor: de prijs volgt de instelling met alle niveaus, zonder goedkeuring', async () => {
  const { db, main, admin, vreemd } = await setup();
  const supplier = (await admin.post('/app/api/suppliers', { name: 'Groothandel' })).body;
  const config = { defaultFactor: 1.8, rounding: { mode: 'x.95', direction: 'dichtstbij' }, categories: [{ categorySlug: PARENT.slug, factor: 2 }], suppliers: [{ supplierId: supplier.id, factor: 2.5 }] };
  assert.strictEqual((await admin.put('/app/api/stock/price-factors', config)).status, 200);
  /**
   * Maakt een artikel.
   * @param {string} code De code.
   * @param {object} extra Extra velden.
   * @returns {Promise<object>} Het artikel.
   */
  const make = async (code, extra) => {
    const made = await admin.post('/app/api/stock/items', { code, name: `Artikel ${code}`, unit: 'st', costPrice: 10, salePrice: 99, ...extra });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    return made.body;
  };
  // Standaardfactor 1,8 × 10 = 18 → 17,95; een vast artikel blijft op zijn prijs.
  const byDefault = await make('STD', { priceMode: 'factor' });
  assert.strictEqual(byDefault.salePrice, 17.95);
  assert.strictEqual(byDefault.margin, 44.3);
  const fixed = await make('VAST', {});
  assert.deepStrictEqual([fixed.salePrice, fixed.priceMode], [99, 'vast']);
  assert.strictEqual((await make('EIGEN', { priceMode: 'factor', priceFactor: 3 })).salePrice, 29.95);
  assert.strictEqual((await make('GEENKOST', { priceMode: 'factor', costPrice: '' })).salePrice, 99, 'zonder inkoopprijs blijft de ingevulde prijs staan');
  assert.strictEqual((await admin.post('/app/api/stock/items', { code: 'FOUT', name: 'x', priceMode: 'raar' })).status, 400);
  assert.strictEqual((await admin.post('/app/api/stock/items', { code: 'FOUT', name: 'x', priceMode: 'factor', priceFactor: 0 })).status, 400);
  // Categorie en voorkeursleverancier: de prijs volgt zodra de instelling opnieuw wordt opgeslagen.
  const viaCategory = await make('CAT', { priceMode: 'factor', salePrice: 1 });
  db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(main, 'p1', 'CAT', '', JSON.stringify([CHILD.name]));
  db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND id = ?').run('p1', main, viaCategory.id);
  const viaSupplier = await make('LEV', { priceMode: 'factor', salePrice: 1 });
  assert.strictEqual((await admin.put(`/app/api/stock/items/${viaSupplier.id}/suppliers`, { suppliers: [{ supplierId: supplier.id, preferred: true }] })).status, 200);
  const resaved = await admin.put('/app/api/stock/price-factors', config);
  assert.strictEqual(resaved.body.repriced, 2, JSON.stringify(resaved.body));
  /**
   * Zoekt een regel van het overzicht.
   * @param {string} code De artikelcode.
   * @returns {object} De regel.
   */
  const rowOf = (code) => resaved.body.preview.find((row) => row.code === code);
  assert.deepStrictEqual(resaved.body.preview.map((row) => row.code).sort(), ['CAT', 'EIGEN', 'GEENKOST', 'LEV', 'STD']);
  assert.deepStrictEqual([rowOf('CAT').factor, rowOf('CAT').source, rowOf('CAT').oldPrice], [2, 'categorie', 19.95]);
  assert.deepStrictEqual([rowOf('LEV').factor, rowOf('LEV').source, rowOf('LEV').oldPrice], [2.5, 'leverancier', 24.95]);
  assert.deepStrictEqual([rowOf('EIGEN').source, rowOf('GEENKOST').problem], ['artikel', 'Geen inkoopprijs']);
  assert.strictEqual(resaved.body.preview[0].code, 'GEENKOST', 'artikelen met een opmerking staan bovenaan');
  assert.strictEqual((await admin.get(`/app/api/stock/items/${fixed.id}`)).body.salePrice, 99, 'een vast artikel verandert nooit');
  // Auditlog: oud, nieuw en bron per automatische wijziging.
  assert.deepStrictEqual(priceAudit(db, main).filter((entry) => entry.bron === 'factorinstelling').map((entry) => [entry.artikel, entry.oud, entry.nieuw]).sort(), [['CAT', 17.95, 19.95], ['LEV', 17.95, 24.95]]);

  // Een nieuwe inkoopprijs in het formulier zet de verkoopprijs direct goed.
  const repriced = await admin.put(`/app/api/stock/items/${byDefault.id}`, { costPrice: 20.5 });
  assert.strictEqual(repriced.body.salePrice, 36.95);
  assert.ok(priceAudit(db, main).some((entry) => entry.artikel === 'STD' && entry.oud === 17.95 && entry.nieuw === 36.95 && entry.bron === 'inkoopprijs'));
  // Een andere naam verandert niets; een eigen factor rekent meteen.
  assert.strictEqual((await admin.put(`/app/api/stock/items/${byDefault.id}`, { name: 'Andere naam' })).body.salePrice, 36.95);
  assert.strictEqual((await admin.put(`/app/api/stock/items/${byDefault.id}`, { priceFactor: 2 })).body.salePrice, 40.95);
  // Een inkoopprijs via de prijshistorie en een ontvangst werken ook door.
  assert.strictEqual((await admin.post(`/app/api/stock/items/${byDefault.id}/cost-prices`, { price: 10 })).status, 201, 'inkoopprijs toevoegen');
  assert.strictEqual((await admin.get(`/app/api/stock/items/${byDefault.id}`)).body.salePrice, 19.95);
  const receipt = await admin.post(`/app/api/stock/items/${byDefault.id}/movements`, { kind: 'ontvangst', qty: 3, unitCost: 12 });
  assert.strictEqual(receipt.status, 201, JSON.stringify(receipt.body));
  assert.strictEqual((await admin.get(`/app/api/stock/items/${byDefault.id}`)).body.salePrice, 23.95);
  // Terug naar een vaste prijs: de prijs blijft zoals hij was en doet niet meer mee.
  const backToFixed = await admin.put(`/app/api/stock/items/${byDefault.id}`, { priceMode: 'vast', salePrice: 40 });
  assert.deepStrictEqual([backToFixed.body.priceMode, backToFixed.body.salePrice], ['vast', 40]);
  assert.ok(!(await admin.get('/app/api/stock/price-factors')).body.preview.some((row) => row.code === 'STD'));
  assert.deepStrictEqual((await vreemd.get('/app/api/stock/price-factors')).body.preview, []);
});

test('prijsfactor: de webshop wordt opnieuw klaargezet en gearchiveerde artikelen doen niet mee', async () => {
  const { db, main, admin } = await setup();
  await admin.put('/app/api/stock/price-factors', { defaultFactor: 2, rounding: { mode: 'cent', direction: 'dichtstbij' } });
  const shop = (await admin.post('/app/api/stock/items', { code: 'SHOP', name: 'Shop', costPrice: 5, salePrice: 1, priceMode: 'factor', priceFactor: 3 })).body;
  const old = (await admin.post('/app/api/stock/items', { code: 'OUD', name: 'Oud', costPrice: 5, salePrice: 1, priceMode: 'factor' })).body;
  db.prepare('UPDATE stock_items SET shop_product_id = ?, shop_dirty = 0 WHERE tenant_id = ? AND id = ?').run('w1', main, shop.id);
  db.prepare('UPDATE stock_items SET archived = 1 WHERE tenant_id = ? AND id = ?').run(main, old.id);
  assert.deepStrictEqual((await admin.get('/app/api/stock/price-factors')).body.preview.map((row) => row.code), ['SHOP'], 'gearchiveerd telt niet mee');
  assert.strictEqual(shop.salePrice, 15);
  // Een nieuwe inkoopprijs buiten het formulier (hier rechtstreeks) wordt door de onderhoudsronde goedgezet; een wijziging van de instelling doet hetzelfde.
  db.prepare('UPDATE stock_items SET cost_price = 6 WHERE tenant_id = ? AND id = ?').run(main, shop.id);
  const out = await admin.put('/app/api/stock/price-factors', { defaultFactor: 2, rounding: { mode: 'cent', direction: 'dichtstbij' } });
  assert.strictEqual(out.body.repriced, 1);
  const row = db.prepare('SELECT sale_price, shop_dirty FROM stock_items WHERE tenant_id = ? AND id = ?').get(main, shop.id);
  assert.deepStrictEqual([Number(row.sale_price), Number(row.shop_dirty)], [18, 1]);
  assert.strictEqual(Number(db.prepare('SELECT sale_price FROM stock_items WHERE tenant_id = ? AND id = ?').get(main, old.id).sale_price), 10);
  // Opnieuw opslaan zonder verschil wijzigt niets.
  assert.strictEqual((await admin.put('/app/api/stock/price-factors', { defaultFactor: 2, rounding: { mode: 'cent', direction: 'dichtstbij' } })).body.repriced, 0);
});

test('prijsfactor: een inkooporder met een nieuwe inkoopprijs zet de verkoopprijs goed en logt het', async () => {
  const { db, main, admin } = await setup();
  await admin.put('/app/api/stock/price-factors', { defaultFactor: 2, rounding: { mode: 'cent', direction: 'dichtstbij' } });
  const supplier = (await admin.post('/app/api/suppliers', { name: 'Groothandel' })).body;
  const item = (await admin.post('/app/api/stock/items', { code: 'IO1', name: 'IO1', costPrice: 5, priceMode: 'factor' })).body;
  assert.strictEqual(item.salePrice, 10);
  const order = (await admin.post('/app/api/purchase-orders', { supplierId: supplier.id, lines: [{ itemId: item.id, qty: 4, unitCost: 8 }] })).body;
  const placed = (await admin.post(`/app/api/purchase-orders/${order.id}/place`)).body;
  const received = await admin.post(`/app/api/purchase-orders/${order.id}/receive`, { lines: [{ lineId: placed.lines[0].id, qty: 4 }] });
  assert.strictEqual(received.status, 200, JSON.stringify(received.body));
  const after = (await admin.get(`/app/api/stock/items/${item.id}`)).body;
  assert.deepStrictEqual([after.costPrice, after.salePrice], [8, 16]);
  assert.ok(priceAudit(db, main).some((entry) => entry.artikel === 'IO1' && entry.oud === 10 && entry.nieuw === 16 && entry.bron === 'ontvangst'));
});
