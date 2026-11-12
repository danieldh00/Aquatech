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
  assert.strictEqual((await staff.post('/app/api/stock/price-factors/apply', { items: [{ id: 'x', newPrice: 1 }] })).status, 403);
  const saved = await admin.put('/app/api/stock/price-factors', config);
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.strictEqual(saved.body.config.defaultFactor, 1.8);
  assert.ok(saved.body.categories.some((category) => category.slug === CHILD.slug));
  assert.ok(saved.body.suppliers.some((entry) => entry.id === supplier.id));
  // Ongeldig: onbekende categorie, onbekende leverancier, factor buiten de grenzen.
  assert.strictEqual((await admin.put('/app/api/stock/price-factors', { categories: [{ categorySlug: 'bestaat-niet', factor: 2 }] })).status, 400);
  assert.strictEqual((await admin.put('/app/api/stock/price-factors', { suppliers: [{ supplierId: 'x', factor: 2 }] })).status, 400);
  assert.strictEqual((await admin.put('/app/api/stock/price-factors', { defaultFactor: 500 })).status, 400);
  // Een andere organisatie ziet niets van deze instelling of deze leverancier en kan niet doorvoeren.
  const foreign = await vreemd.get('/app/api/stock/price-factors');
  assert.strictEqual(foreign.status, 200);
  assert.strictEqual(foreign.body.config.defaultFactor, null);
  assert.deepStrictEqual(foreign.body.suppliers, []);
  assert.strictEqual((await vreemd.put('/app/api/stock/price-factors', { suppliers: [{ supplierId: supplier.id, factor: 2 }] })).status, 400);
  assert.strictEqual((await admin.post('/app/api/stock/price-factors/apply', {})).status, 400);
  // Een ontbrekende of niet-numerieke prijs bewijst niets en wordt overgeslagen, nooit doorgevoerd.
  assert.deepStrictEqual((await admin.post('/app/api/stock/price-factors/apply', { items: [{ id: 'x' }, { id: 'y', newPrice: 'abc' }, { id: 'z', newPrice: null }] })).body, { updated: 0, skipped: 3 });
});

test('prijsfactor: prijs bij opslaan, voorbeeld en doorvoeren met alle niveaus', async () => {
  const { db, main, admin, vreemd } = await setup();
  const supplier = (await admin.post('/app/api/suppliers', { name: 'Groothandel' })).body;
  assert.strictEqual((await admin.put('/app/api/stock/price-factors', {
    defaultFactor: 1.8, rounding: { mode: 'x.95', direction: 'dichtstbij' }, categories: [{ categorySlug: PARENT.slug, factor: 2 }], suppliers: [{ supplierId: supplier.id, factor: 2.5 }],
  })).status, 200);
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
  assert.strictEqual(byDefault.priceMode, 'factor');
  assert.strictEqual(byDefault.margin, 44.3);
  const fixed = await make('VAST', {});
  assert.strictEqual(fixed.salePrice, 99);
  assert.strictEqual(fixed.priceMode, 'vast');
  // Eigen factor van het artikel; zonder inkoopprijs blijft de ingevulde prijs staan.
  assert.strictEqual((await make('EIGEN', { priceMode: 'factor', priceFactor: 3 })).salePrice, 29.95);
  const noCost = await make('GEENKOST', { priceMode: 'factor', costPrice: '' });
  assert.strictEqual(noCost.salePrice, 99);
  // Ongeldige invoer.
  assert.strictEqual((await admin.post('/app/api/stock/items', { code: 'FOUT', name: 'x', priceMode: 'raar' })).status, 400);
  assert.strictEqual((await admin.post('/app/api/stock/items', { code: 'FOUT', name: 'x', priceMode: 'factor', priceFactor: 0 })).status, 400);
  // Categorie en leverancier via de webshopkoppeling en de voorkeursleverancier.
  const viaCategory = await make('CAT', { priceMode: 'factor', salePrice: 1 });
  db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(main, 'p1', 'CAT', '', JSON.stringify([CHILD.name]));
  db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND id = ?').run('p1', main, viaCategory.id);
  const viaSupplier = await make('LEV', { priceMode: 'factor', salePrice: 1 });
  assert.strictEqual((await admin.put(`/app/api/stock/items/${viaSupplier.id}/suppliers`, { suppliers: [{ supplierId: supplier.id, preferred: true }] })).status, 200);

  const preview = (await admin.get('/app/api/stock/price-factors')).body;
  /**
   * Zoekt een regel van het voorbeeld.
   * @param {string} code De artikelcode.
   * @returns {object} De regel.
   */
  const rowOf = (code) => preview.preview.find((row) => row.code === code);
  assert.deepStrictEqual(preview.preview.map((row) => row.code).sort(), ['CAT', 'EIGEN', 'GEENKOST', 'LEV', 'STD']);
  assert.strictEqual(rowOf('STD').changed, false);
  assert.deepStrictEqual([rowOf('CAT').factor, rowOf('CAT').source, rowOf('CAT').newPrice, rowOf('CAT').changed], [2, 'categorie', 19.95, true]);
  assert.deepStrictEqual([rowOf('LEV').factor, rowOf('LEV').source, rowOf('LEV').newPrice], [2.5, 'leverancier', 24.95]);
  assert.deepStrictEqual([rowOf('EIGEN').source, rowOf('GEENKOST').problem, rowOf('GEENKOST').newPrice, rowOf('GEENKOST').changed], ['artikel', 'Geen inkoopprijs', null, false]);
  assert.strictEqual(rowOf('CAT').marginNew, 49.9);
  assert.strictEqual(preview.changedCount, 2);
  assert.deepStrictEqual(preview.preview.slice(0, 2).map((row) => row.changed), [true, true], 'afwijkende artikelen staan bovenaan');

  // Doorvoeren: kies er twee; een verouderde prijs (instelling intussen anders) wordt overgeslagen, niet toegepast.
  const apply = await admin.post('/app/api/stock/price-factors/apply', { items: [{ id: viaCategory.id, newPrice: 19.95 }, { id: viaSupplier.id, newPrice: 11.11 }, { id: fixed.id, newPrice: 1 }, { id: 'bestaat-niet', newPrice: 1 }] });
  assert.deepStrictEqual(apply.body, { updated: 1, skipped: 3 });
  const noPrice = await admin.post('/app/api/stock/price-factors/apply', { items: [{ id: viaSupplier.id }, { id: viaSupplier.id, newPrice: 'abc' }] });
  assert.deepStrictEqual(noPrice.body, { updated: 0, skipped: 2 });
  assert.strictEqual((await admin.get(`/app/api/stock/items/${viaCategory.id}`)).body.salePrice, 19.95);
  assert.strictEqual((await admin.get(`/app/api/stock/items/${viaSupplier.id}`)).body.salePrice, 17.95, 'verouderde prijs uit het voorbeeld is niet toegepast');
  assert.strictEqual((await admin.get(`/app/api/stock/items/${fixed.id}`)).body.salePrice, 99, 'een vast artikel verandert nooit');
  assert.strictEqual((await admin.get('/app/api/stock/price-factors')).body.changedCount, 1);

  // Een andere inkoopprijs: de prijs blijft staan tot de herberekening (afwijkend), maar een wijziging van factor of inkoopprijs in het formulier rekent meteen.
  db.prepare('UPDATE stock_items SET cost_price = 20 WHERE tenant_id = ? AND id = ?').run(main, byDefault.id);
  assert.strictEqual((await admin.get(`/app/api/stock/items/${byDefault.id}`)).body.salePrice, 17.95);
  /**
   * Zoekt een regel in het antwoord van het voorbeeld.
   * @param {object} response Antwoord van GET price-factors.
   * @param {string} code Artikelcode.
   * @returns {object} De regel.
   */
  const rowAfter = (response, code) => response.body.preview.find((row) => row.code === code);
  const after = rowAfter(await admin.get('/app/api/stock/price-factors'), 'STD');
  assert.deepStrictEqual([after.changed, after.newPrice], [true, 35.95]);
  // Een andere inkoopprijs in het formulier verandert de verkoopprijs niet vanzelf: er komt een voorstel; een andere eigen factor rekent wel meteen.
  const renamed = await admin.put(`/app/api/stock/items/${byDefault.id}`, { name: 'Andere naam' });
  assert.strictEqual(renamed.body.salePrice, 17.95);
  const repriced = await admin.put(`/app/api/stock/items/${byDefault.id}`, { costPrice: 20.5 });
  assert.strictEqual(repriced.body.salePrice, 17.95);
  assert.deepStrictEqual(rowAfter(await admin.get('/app/api/stock/price-factors'), 'STD').newPrice, 36.95);
  const refactored = await admin.put(`/app/api/stock/items/${byDefault.id}`, { priceFactor: 2 });
  assert.strictEqual(refactored.body.salePrice, 40.95);
  // Terug naar een vaste prijs: de prijs blijft zoals hij was en doet niet meer mee.
  const backToFixed = await admin.put(`/app/api/stock/items/${byDefault.id}`, { priceMode: 'vast', salePrice: 40 });
  assert.deepStrictEqual([backToFixed.body.priceMode, backToFixed.body.salePrice], ['vast', 40]);
  assert.ok(!(await admin.get('/app/api/stock/price-factors')).body.preview.some((row) => row.code === 'STD'));
  // Een andere organisatie ziet de artikelen niet.
  assert.deepStrictEqual((await vreemd.get('/app/api/stock/price-factors')).body.preview, []);
  assert.deepStrictEqual((await vreemd.post('/app/api/stock/price-factors/apply', { items: [{ id: viaSupplier.id, newPrice: 24.95 }] })).body, { updated: 0, skipped: 1 });
});

test('prijsfactor: doorvoeren zet de webshop opnieuw klaar en overslaan van gearchiveerde artikelen', async () => {
  const { db, main, admin } = await setup();
  await admin.put('/app/api/stock/price-factors', { defaultFactor: 2, rounding: { mode: 'cent', direction: 'dichtstbij' } });
  const shop = (await admin.post('/app/api/stock/items', { code: 'SHOP', name: 'Shop', costPrice: 5, salePrice: 1, priceMode: 'factor', priceFactor: 3 })).body;
  const old = (await admin.post('/app/api/stock/items', { code: 'OUD', name: 'Oud', costPrice: 5, salePrice: 1, priceMode: 'factor' })).body;
  db.prepare('UPDATE stock_items SET shop_product_id = ?, shop_dirty = 0 WHERE tenant_id = ? AND id = ?').run('w1', main, shop.id);
  db.prepare('UPDATE stock_items SET archived = 1 WHERE tenant_id = ? AND id = ?').run(main, old.id);
  const preview = (await admin.get('/app/api/stock/price-factors')).body.preview;
  assert.deepStrictEqual(preview.map((row) => row.code), ['SHOP'], 'gearchiveerd telt niet mee');
  assert.strictEqual(shop.salePrice, 15);
  db.prepare('UPDATE stock_items SET cost_price = 6 WHERE tenant_id = ? AND id = ?').run(main, shop.id);
  const apply = await admin.post('/app/api/stock/price-factors/apply', { items: [{ id: shop.id, newPrice: 18 }, { id: old.id, newPrice: 10 }] });
  assert.deepStrictEqual(apply.body, { updated: 1, skipped: 1 });
  const row = db.prepare('SELECT sale_price, shop_dirty FROM stock_items WHERE tenant_id = ? AND id = ?').get(main, shop.id);
  assert.deepStrictEqual([Number(row.sale_price), Number(row.shop_dirty)], [18, 1]);
  assert.strictEqual(Number(db.prepare('SELECT sale_price FROM stock_items WHERE tenant_id = ? AND id = ?').get(main, old.id).sale_price), 10);
});

test('prijsvoorstel: nieuwe inkoopprijs geeft een voorstel dat je goedkeurt of afwijst', async () => {
  const { db, main, admin, staff, vreemd } = await setup();
  await admin.put('/app/api/stock/price-factors', { defaultFactor: 2, rounding: { mode: 'cent', direction: 'dichtstbij' } });
  const first = (await admin.post('/app/api/stock/items', { code: 'A', name: 'A', costPrice: 5, priceMode: 'factor' })).body;
  const second = (await admin.post('/app/api/stock/items', { code: 'B', name: 'B', costPrice: 5, priceMode: 'factor' })).body;
  const fixed = (await admin.post('/app/api/stock/items', { code: 'V', name: 'V', costPrice: 5, salePrice: 50 })).body;
  assert.deepStrictEqual([first.salePrice, second.salePrice], [10, 10]);
  // Een nieuwe inkoopprijs: de verkoopprijs blijft staan en er komen twee voorstellen; een vast artikel doet niet mee.
  await admin.put(`/app/api/stock/items/${first.id}`, { costPrice: 6 });
  await admin.put(`/app/api/stock/items/${second.id}`, { costPrice: 7 });
  await admin.put(`/app/api/stock/items/${fixed.id}`, { costPrice: 9 });
  let view = (await admin.get('/app/api/stock/price-factors')).body;
  assert.deepStrictEqual([view.changedCount, view.rejectedCount, view.preview.length], [2, 0, 2]);
  assert.strictEqual((await admin.get(`/app/api/stock/items/${first.id}`)).body.salePrice, 10);
  // Rechten: een medewerker mag lezen, niet afwijzen of heropenen; een andere organisatie kan niets afwijzen.
  assert.strictEqual((await staff.post('/app/api/stock/price-factors/reject', { items: [{ id: first.id, newPrice: 12 }] })).status, 403);
  assert.strictEqual((await staff.post('/app/api/stock/price-factors/reopen', { ids: [first.id] })).status, 403);
  assert.deepStrictEqual((await vreemd.post('/app/api/stock/price-factors/reject', { items: [{ id: first.id, newPrice: 12 }] })).body, { rejected: 0, skipped: 1 });
  assert.strictEqual((await admin.post('/app/api/stock/price-factors/reject', {})).status, 400);
  assert.strictEqual((await admin.post('/app/api/stock/price-factors/reopen', {})).status, 400);
  // Afwijzen: alleen als het voorstel klopt; een verouderde prijs en een vast artikel worden overgeslagen.
  const rejected = await admin.post('/app/api/stock/price-factors/reject', { items: [{ id: first.id, newPrice: 12 }, { id: second.id, newPrice: 99 }, { id: fixed.id, newPrice: 18 }] });
  assert.deepStrictEqual(rejected.body, { rejected: 1, skipped: 2 });
  view = (await admin.get('/app/api/stock/price-factors')).body;
  assert.deepStrictEqual([view.changedCount, view.rejectedCount], [1, 1]);
  assert.strictEqual(view.preview[0].code, 'B', 'open voorstellen staan bovenaan');
  assert.strictEqual(view.preview.find((row) => row.code === 'A').rejected, true);
  // Afwijzen twee keer geeft één rij; goedkeuren van een afgewezen voorstel kan alleen na heropenen niet nodig: het blijft doorvoerbaar via de API.
  await admin.post('/app/api/stock/price-factors/reject', { items: [{ id: first.id, newPrice: 12 }] });
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS n FROM price_proposal_rejections WHERE tenant_id = ?').get(main).n), 1);
  // Een nieuwe inkoopprijs maakt het voorstel weer open.
  await admin.put(`/app/api/stock/items/${first.id}`, { costPrice: 8 });
  view = (await admin.get('/app/api/stock/price-factors')).body;
  assert.deepStrictEqual([view.changedCount, view.rejectedCount, view.preview.find((row) => row.code === 'A').newPrice], [2, 0, 16]);
  // Heropenen en goedkeuren: na doorvoeren is de afwijzing weg en staat de prijs op het voorstel.
  await admin.post('/app/api/stock/price-factors/reject', { items: [{ id: first.id, newPrice: 16 }] });
  assert.strictEqual((await admin.post('/app/api/stock/price-factors/reopen', { ids: [first.id] })).body.reopened, 1);
  assert.strictEqual((await admin.get('/app/api/stock/price-factors')).body.rejectedCount, 0);
  await admin.post('/app/api/stock/price-factors/reject', { items: [{ id: first.id, newPrice: 16 }] });
  assert.deepStrictEqual((await admin.post('/app/api/stock/price-factors/apply', { items: [{ id: first.id, newPrice: 16 }, { id: second.id, newPrice: 14 }] })).body, { updated: 2, skipped: 0 });
  assert.strictEqual((await admin.get(`/app/api/stock/items/${first.id}`)).body.salePrice, 16);
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS n FROM price_proposal_rejections WHERE tenant_id = ?').get(main).n), 0);
  // Een artikel zonder boekingen verwijderen wist ook een onthouden afwijzing (geen blokkade door de koppeling).
  await admin.put(`/app/api/stock/items/${second.id}`, { costPrice: 9 });
  await admin.post('/app/api/stock/price-factors/reject', { items: [{ id: second.id, newPrice: 18 }] });
  assert.strictEqual((await admin.del(`/app/api/stock/items/${second.id}`)).status, 200);
});
