// Losse artikelen samenvoegen tot één variabel artikel: voorstellen op basis van de
// omschrijving, en het samenvoegen zelf zonder dat voorraad, prijzen, afbeelding,
// boekingen en verwijzingen (werkorders) verloren gaan.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { suggestGroups, splitName, commonCodePrefix } = require('../src/artikelen/variant-suggestions');
const { createLogin, listen } = require('./helpers/http-client');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Maakt een artikel met de gegevens die ertoe doen voor de voorstellen.
 * @param {string} id Id van het artikel.
 * @param {string} code Artikelcode.
 * @param {string} name Omschrijving.
 * @param {object} [extra] Andere velden (unit, vatRate, revenueGroup).
 * @returns {object} Het artikel.
 */
const looseItem = (id, code, name, extra = {}) => ({ id, code, name, unit: 'st', vatRate: 21, revenueGroup: 'producten', ...extra });

test('samenvoegen: omschrijving splitsen in basis en maat of kleur', () => {
  assert.deepStrictEqual(splitName('PE-buis 16 mm'), { kind: 'Maat', base: 'PE-buis', baseKey: 'pe-buis', value: '16 mm' });
  assert.deepStrictEqual(splitName('Koppeling 3/4" binnendraad'), { kind: 'Maat', base: 'Koppeling binnendraad', baseKey: 'koppeling binnendraad', value: '3/4"' });
  assert.deepStrictEqual(splitName('Kabel 2x1,5 mm'), { kind: 'Maat', base: 'Kabel', baseKey: 'kabel', value: '2x1,5 mm' });
  assert.deepStrictEqual(splitName('Plantenbak Zwart'), { kind: 'Kleur', base: 'Plantenbak', baseKey: 'plantenbak', value: 'Zwart' });
  assert.strictEqual(splitName('Sproeier'), null);
  assert.strictEqual(splitName('16 mm'), null);
  assert.strictEqual(commonCodePrefix(['PE-16', 'PE-20', 'PE-25']), 'PE');
  assert.strictEqual(commonCodePrefix(['A1', 'B1']), '');
});

test('samenvoegen: voorstellen groeperen op naam, eenheid en btw; dubbele maten vallen af', () => {
  const groups = suggestGroups([
    looseItem('1', 'PEB-25', 'PE-buis 25 mm'), looseItem('2', 'PEB-16', 'PE-buis 16 mm'), looseItem('3', 'PEB-110', 'PE-buis 110 mm'),
    looseItem('4', 'KLEP-1', 'Klep 24V', { unit: 'st' }), looseItem('5', 'KLEP-2', 'Klep 230V', { unit: 'set' }),
    looseItem('6', 'DUB-1', 'Mof 20 mm'), looseItem('7', 'DUB-2', 'Mof 20 mm'), looseItem('8', 'DUB-3', 'Mof 25 mm'),
    looseItem('9', 'BAK-Z', 'Plantenbak zwart'), looseItem('10', 'BAK-W', 'Plantenbak wit'),
    looseItem('11', 'X', 'Hoogwaardige tuinkraan', {}),
  ], new Set(['PEB']));
  assert.strictEqual(groups.length, 2, JSON.stringify(groups));
  assert.deepStrictEqual(groups[0].items.map((entry) => entry.value), ['16 mm', '25 mm', '110 mm']);
  assert.strictEqual(groups[0].attributeName, 'Maat');
  assert.strictEqual(groups[0].name, 'PE-buis');
  assert.strictEqual(groups[0].code, 'PEB-2', 'de gemeenschappelijke code PEB bestaat al');
  assert.deepStrictEqual(groups[1].items.map((entry) => entry.value), ['Wit', 'Zwart']);
  assert.strictEqual(groups[1].attributeName, 'Kleur');
});

test('samenvoegen via de API: voorraad, prijs, afbeelding en reserveringen blijven, rechten en andere organisatie', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'pien', displayName: 'Pien', role: 'planner', password: PW });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  try {
    const as = createLogin(base, { password: PW });
    const baas = await as('baas');
    const pien = await as('pien');
    const klant = await as('klant');
    const sizes = [['PEB-16', '16 mm', 0.5, 1.2, 100], ['PEB-20', '20 mm', 0.7, 1.6, 50], ['PEB-25', '25 mm', 0.9, 2.1, 0]];
    const made = [];
    for (const [code, size, costPrice, salePrice, onHand] of sizes) {
      const response = await baas.post('/api/stock/items', { code, name: `PE-buis ${size}`, unit: 'm', costPrice, salePrice, vatRate: 9, minQty: 10, onHand });
      assert.strictEqual(response.status, 201, JSON.stringify(response.body));
      made.push(response.body);
    }
    const other = (await baas.post('/api/stock/items', { code: 'LOS', name: 'Losse kraan', unit: 'st' })).body;
    db.prepare('UPDATE stock_items SET image_id = ? WHERE id = ?').run('img-1', made[1].id);
    db.prepare('UPDATE stock_items SET shop_product_id = ?, shop_dirty = 1 WHERE id = ?').run('77', made[0].id);

    // Een werkorder met PEB-20 reserveert 5 m; dat moet na het samenvoegen zo blijven.
    const quote = (await baas.post('/api/quotes', { data: { title: 'Buis', customer: { name: 'Fam. Jansen' },
      lines: [{ section: 'materiaal', code: 'PEB-20', description: 'PE-buis 20 mm', qty: 5, unit: 'm', price: 1.6 }] } })).body;
    await baas.put(`/api/quotes/${quote.id}`, { status: 'akkoord' });
    const workOrder = (await baas.post('/api/workorders', { quoteId: quote.id })).body;
    assert.strictEqual((await baas.get(`/api/stock/items/${made[1].id}`)).body.reserved, 5);

    const suggestions = await baas.get('/api/stock/merge-suggestions');
    assert.strictEqual(suggestions.status, 200);
    assert.strictEqual(suggestions.body.groups.length, 1);
    const group = suggestions.body.groups[0];
    assert.deepStrictEqual(group.items.map((entry) => entry.code), ['PEB-16', 'PEB-20', 'PEB-25']);
    assert.strictEqual(group.code, 'PEB');
    assert.strictEqual((await pien.get('/api/stock/merge-suggestions')).status, 403);
    assert.strictEqual((await klant.get('/api/stock/merge-suggestions')).status, 403);

    const body = { ids: group.items.map((entry) => entry.id), code: group.code, name: group.name, attributeName: group.attributeName,
      values: Object.fromEntries(group.items.map((entry) => [entry.id, entry.value])) };
    assert.strictEqual((await pien.post('/api/stock/merge', body)).status, 403);
    // Controles: te weinig, dubbele waarde, bestaande code, ander soort artikel, onbekend id.
    assert.strictEqual((await baas.post('/api/stock/merge', { ...body, ids: [made[0].id] })).status, 400);
    assert.strictEqual((await baas.post('/api/stock/merge', { ...body, values: { ...body.values, [made[1].id]: '16 MM' } })).status, 409);
    assert.strictEqual((await baas.post('/api/stock/merge', { ...body, code: 'LOS' })).status, 409);
    assert.strictEqual((await baas.post('/api/stock/merge', { ...body, ids: [...body.ids.slice(0, 2), other.id], values: { ...body.values, [other.id]: '30 mm' } })).status, 409, 'andere eenheid');
    assert.strictEqual((await baas.post('/api/stock/merge', { ...body, ids: [...body.ids.slice(0, 2), 'bestaat-niet'], values: { ...body.values, 'bestaat-niet': '30 mm' } })).status, 404);
    assert.strictEqual((await baas.post('/api/stock/merge', { ...body, attributeName: '' })).status, 400);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stock_items WHERE parent_id IS NOT NULL').get().n, 0, 'afgewezen verzoeken veranderen niets');

    const merged = await baas.post('/api/stock/merge', body);
    assert.strictEqual(merged.status, 201, JSON.stringify(merged.body));
    assert.strictEqual(merged.body.merged, 3);
    assert.strictEqual(merged.body.unlinked, 1);
    const parent = merged.body.item;
    assert.strictEqual(parent.code, 'PEB');
    assert.strictEqual(parent.hasVariants, true);
    assert.strictEqual(parent.imageId, 'img-1');
    assert.strictEqual(parent.onHand, 150, 'het hoofdartikel telt de varianten op');
    assert.deepStrictEqual(parent.attributes, [{ name: 'Maat', values: ['16 mm', '20 mm', '25 mm'] }]);

    // Dezelfde artikelen (id, code, voorraad, prijs, minimum) zijn nu varianten.
    for (const [index, [code, size, costPrice, salePrice, onHand]] of sizes.entries()) {
      const variant = (await baas.get(`/api/stock/items/${made[index].id}`)).body;
      assert.strictEqual(variant.code, code);
      assert.strictEqual(variant.parentId, parent.id);
      assert.deepStrictEqual(variant.values, { Maat: size });
      assert.strictEqual(variant.onHand, onHand);
      assert.strictEqual(variant.costPrice, costPrice);
      assert.strictEqual(variant.salePrice, salePrice);
      assert.strictEqual(variant.minQty, 10);
      assert.strictEqual(variant.shop.productId, null);
    }
    assert.strictEqual((await baas.get(`/api/stock/items/${made[1].id}`)).body.reserved, 5, 'reservering van de werkorder blijft');
    assert.strictEqual((await baas.get(`/api/stock/items/${made[1].id}`)).body.imageId, 'img-1');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE item_id = ?').get(made[0].id).n, 1, 'boekingen blijven');
    const workOrderStock = (await baas.get(`/api/stock/workorders/${workOrder.id}`)).body;
    assert.deepStrictEqual(workOrderStock.lines.map((line) => [line.code, line.reserved]), [['PEB-20', 5]]);
    assert.deepStrictEqual(workOrderStock.chooseVariant, []);

    // Nog een keer samenvoegen kan niet: het zijn nu varianten.
    assert.strictEqual((await baas.post('/api/stock/merge', { ...body, code: 'PEB-NIEUW' })).status, 409);
    const listed = (await baas.get('/api/stock')).body.items;
    assert.strictEqual(listed.filter((item) => item.hasVariants).length, 1);
    assert.deepStrictEqual((await baas.get('/api/stock/merge-suggestions')).body.groups, []);

    // Andere organisatie ziet de artikelen niet en kan ze niet samenvoegen.
    const created = await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const piet = await as('piet', 'groen');
    assert.deepStrictEqual((await piet.get('/api/stock/merge-suggestions')).body.groups, []);
    const otherTenant = await piet.post('/api/stock/merge', { ...body, code: 'ANDERS' });
    assert.strictEqual(otherTenant.status, 404);
  } finally { server.close(); }
});

test('samenvoegen: een los webshopproduct met dezelfde sku wordt niet weer aan een variant gekoppeld', () => {
  const db = openDb();
  const { createShopStore } = require('../src/webshop/shop');
  const { createShopSync } = require('../src/webshop/shop-sync');
  const { createStockStore } = require('../src/artikelen/stock');
  const sync = createShopSync({ db, shop: createShopStore(db), stock: createStockStore(db), settingsFor: () => ({ get: () => undefined }), fetchImpl: async () => ({}), log: { warn() {} } });
  const match = sync.matcher([{ id: '1', sku: 'PEB-16' }, { id: '2', sku: 'PEB-20', parentId: '9' }]);
  assert.strictEqual(match({ code: 'PEB-16', parent_id: null }).id, '1', 'een los artikel blijft koppelen');
  assert.strictEqual(match({ code: 'PEB-16', parent_id: 'p1' }), null, 'een variant koppelt niet aan een los product');
  assert.strictEqual(match({ code: 'PEB-20', parent_id: 'p1' }).id, '2', 'een variant koppelt wel aan een variatie');
});

test('samenvoegen: bepaalt de webshop de artikellijst, dan worden aan een webshopproduct gekoppelde artikelen geweigerd', () => {
  const db = openDb();
  const tenantId = createStore(db).ensureTenant().id;
  const { createStockStore } = require('../src/artikelen/stock');
  const stock = createStockStore(db);
  const user = { id: null, display_name: 'Test' };
  const first = stock.create(tenantId, user, { code: 'A-16', name: 'Buis 16 mm', unit: 'm' }).item;
  const second = stock.create(tenantId, user, { code: 'A-20', name: 'Buis 20 mm', unit: 'm' }).item;
  const third = stock.create(tenantId, user, { code: 'A-25', name: 'Buis 25 mm', unit: 'm' }).item;
  db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE id = ?').run('55', first.id);
  const input = { ids: [first.id, second.id], code: 'A', name: 'Buis', attributeName: 'Maat', values: { [first.id]: '16 mm', [second.id]: '20 mm' } };
  const refused = stock.mergeIntoVariants(tenantId, input, { refuseLinked: true });
  assert.strictEqual(refused.status, 409);
  assert.match(refused.error, /A-16/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stock_items WHERE parent_id IS NOT NULL').get().n, 0);
  const looseMatch = stock.mergeIntoVariants(tenantId, { ...input, ids: [second.id, third.id], values: { [second.id]: '20 mm', [third.id]: '25 mm' } }, { refuseLinked: true, shopMatchOf: (row) => (row.code === 'A-25' ? { id: 9 } : null) });
  assert.strictEqual(looseMatch.status, 409, 'een artikel dat met een los webshopproduct samenvalt wordt geweigerd');
  assert.match(looseMatch.error, /A-25/);
  assert.strictEqual(stock.mergeIntoVariants(tenantId, input).merged, 2, 'zonder spiegelen mag het wel');
});

test('samenvoeging terugdraaien via de API: artikelen weer los met hun voorraad, webshopkoppeling terug, rechten en andere organisatie', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'pien', displayName: 'Pien', role: 'planner', password: PW });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  try {
    const as = createLogin(base, { password: PW });
    const baas = await as('baas');
    const pien = await as('pien');
    const made = [];
    for (const [code, size, onHand] of [['KR-16', '16 mm', 10], ['KR-20', '20 mm', 4]]) {
      made.push((await baas.post('/api/stock/items', { code, name: `Kraan ${size}`, unit: 'st', costPrice: 2, salePrice: 5, onHand })).body);
    }
    db.prepare('UPDATE stock_items SET shop_product_id = ?, shop_price_seen = 5, shop_dirty = 1 WHERE id = ?').run('88', made[0].id);
    const body = { ids: made.map((item) => item.id), code: 'KR', name: 'Kraan', attributeName: 'Maat', values: { [made[0].id]: '16 mm', [made[1].id]: '20 mm' } };
    const merged = (await baas.post('/api/stock/merge', body)).body;
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stock_merges').get().n, 1, 'het samenvoegen komt in het logboek');
    // Na het samenvoegen verandert de voorraad nog: die mutatie moet het terugdraaien overleven.
    assert.strictEqual((await baas.post(`/api/stock/items/${made[1].id}/movements`, { kind: 'ontvangst', qty: 6, note: 'Pakbon' })).status, 201);

    const preview = await baas.get(`/api/stock/items/${merged.item.id}/unmerge`);
    assert.strictEqual(preview.status, 200);
    assert.strictEqual(preview.body.logged, true);
    assert.strictEqual(preview.body.restoresLinks, 1);
    assert.deepStrictEqual(preview.body.variants.map((variant) => variant.code), ['KR-16', 'KR-20']);
    assert.strictEqual((await baas.get(`/api/stock/items/${made[0].id}/unmerge`)).status, 409, 'een los artikel is geen hoofdartikel');
    assert.strictEqual((await pien.get(`/api/stock/items/${merged.item.id}/unmerge`)).status, 403);
    assert.strictEqual((await pien.post(`/api/stock/items/${merged.item.id}/unmerge`, {})).status, 403);

    // Een andere organisatie kan het hoofdartikel niet terugdraaien (404).
    assert.strictEqual((await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } })).status, 201);
    const piet = await as('piet', 'groen');
    assert.strictEqual((await piet.post(`/api/stock/items/${merged.item.id}/unmerge`, {})).status, 404);

    // Een variant die na het samenvoegen een nieuwe koppeling kreeg, houdt die; de preview telt hem niet mee.
    db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE id = ?').run('555', made[0].id);
    assert.strictEqual((await baas.get(`/api/stock/items/${merged.item.id}/unmerge`)).body.restoresLinks, 0);
    db.prepare('UPDATE stock_items SET shop_product_id = NULL WHERE id = ?').run(made[0].id);

    // Is het hoofdartikel inmiddels aan een webshopproduct gekoppeld, dan blijft het staan.
    db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE id = ?').run('99', merged.item.id);
    assert.strictEqual((await baas.post(`/api/stock/items/${merged.item.id}/unmerge`, {})).status, 409);
    db.prepare('UPDATE stock_items SET shop_product_id = NULL WHERE id = ?').run(merged.item.id);

    const undone = await baas.post(`/api/stock/items/${merged.item.id}/unmerge`, {});
    assert.strictEqual(undone.status, 200, JSON.stringify(undone.body));
    assert.strictEqual(undone.body.restored, 2);
    assert.strictEqual(undone.body.linksRestored, 1);
    assert.strictEqual((await baas.get(`/api/stock/items/${merged.item.id}`)).status, 404, 'het hoofdartikel is weg');
    const first = (await baas.get(`/api/stock/items/${made[0].id}`)).body;
    assert.strictEqual(first.parentId, null);
    assert.strictEqual(first.name, 'Kraan 16 mm');
    assert.strictEqual(first.shop.productId, '88', 'de webshopkoppeling is terug');
    const second = (await baas.get(`/api/stock/items/${made[1].id}`)).body;
    assert.strictEqual(second.parentId, null);
    assert.strictEqual(second.onHand, 10, 'de ontvangst na het samenvoegen blijft');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE item_id = ?').get(made[1].id).n, 2);
    const listed = (await baas.get('/api/stock')).body.items;
    assert.strictEqual(listed.filter((item) => item.hasVariants || item.parentId).length, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stock_merges WHERE undone_at IS NOT NULL').get().n, 1);
    assert.strictEqual((await baas.post(`/api/stock/items/${merged.item.id}/unmerge`, {})).status, 404, 'nog een keer kan niet');
    // Opnieuw samenvoegen met dezelfde code kan weer.
    assert.strictEqual((await baas.post('/api/stock/merge', body)).status, 201);
  } finally { server.close(); }
});

test('samenvoeging terugdraaien zonder logboek (samengevoegd voor 1.5.9) en met een later bijgemaakte variant', () => {
  const db = openDb();
  const tenantId = createStore(db).ensureTenant().id;
  const { createStockStore } = require('../src/artikelen/stock');
  const stock = createStockStore(db);
  const user = { id: null, display_name: 'Test' };
  const first = stock.create(tenantId, user, { code: 'B-16', name: 'Buis 16 mm', unit: 'm' }).item;
  const second = stock.create(tenantId, user, { code: 'B-20', name: 'Buis 20 mm', unit: 'm' }).item;
  const input = { ids: [first.id, second.id], code: 'B', name: 'Buis', attributeName: 'Maat', values: { [first.id]: '16 mm', [second.id]: '20 mm' } };

  // Zonder logboekregel worden alleen de varianten losgemaakt.
  const legacy = stock.mergeIntoVariants(tenantId, input, { user });
  db.prepare('DELETE FROM stock_merges').run();
  assert.strictEqual(stock.unmergePreview(tenantId, legacy.parentId).logged, false);
  const reconstructed = stock.unmergeVariants(tenantId, legacy.parentId);
  assert.strictEqual(reconstructed.restored, 2);
  assert.strictEqual(reconstructed.reconstructed, true);
  assert.strictEqual(stock.get(tenantId, first.id).parentId, null);

  // Met logboek: een variant die erna is bijgemaakt gaat weg.
  const again = stock.mergeIntoVariants(tenantId, input, { user });
  const added = stock.setVariants(tenantId, again.parentId, [{ name: 'Maat', values: ['16 mm', '20 mm', '25 mm', '30 mm'] }]);
  assert.strictEqual(added.created, 2);
  const withMoves = added.item.variants.find((variant) => variant.values.Maat === '30 mm');
  stock.move(tenantId, user, withMoves.id, { kind: 'ontvangst', qty: 3, note: 'Pakbon' });
  assert.deepStrictEqual(stock.unmergePreview(tenantId, again.parentId).variants.map((variant) => variant.outcome), ['los', 'los', 'weg', 'gearchiveerd']);
  // Een reservering op een later bijgemaakte variant blokkeert het terugdraaien.
  const plain = added.item.variants.find((variant) => variant.values.Maat === '25 mm');
  db.prepare('INSERT INTO stock_reservations (tenant_id, work_order_id, item_id, qty, updated_at) VALUES (?, ?, ?, 1, ?)').run(tenantId, 'wo-1', plain.id, '2026-11-04T10:00:00Z');
  assert.ok(stock.unmergePreview(tenantId, again.parentId).blocked);
  assert.strictEqual(stock.unmergeVariants(tenantId, again.parentId).status, 409);
  db.prepare('DELETE FROM stock_reservations').run();
  const out = stock.unmergeVariants(tenantId, again.parentId);
  assert.strictEqual(out.restored, 2);
  assert.strictEqual(out.removed, 2);
  assert.deepStrictEqual(stock.list(tenantId).map((item) => item.code).sort(), ['B-16', 'B-20']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stock_items WHERE id = ?').get(plain.id).n, 0, 'zonder boekingen echt verwijderd');
  const archived = db.prepare('SELECT archived, parent_id FROM stock_items WHERE id = ?').get(withMoves.id);
  assert.deepStrictEqual([Number(archived.archived), archived.parent_id], [1, null], 'met boekingen gearchiveerd en losgemaakt');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE item_id = ?').get(withMoves.id).n, 1, 'boekingen blijven');
});
