// Inkoopprijzen met historie, voorraadlagen (FIFO) en de margerapportage van de
// webshop: oude inkoopprijzen blijven in de kostprijs van eerdere verkopen, een
// onbekende prijs wordt niet geraden, en de rapportage valt achter beheer en de tenant.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createStockStore } = require('../src/artikelen/stock');
const { createWebSalesStore, periodOf, bucketOf, bucketsBetween } = require('../src/webshop/web-sales');
const { setup, order } = require('./helpers/webshop-world');
const { postForm } = require('./helpers/http-client');

/**
 * Een lege omgeving met een voorraadopslag.
 * @returns {{ db: object, stock: object, tenantId: string }} De database, de opslag en de omgeving.
 */
function freshStock() {
  const db = openDb();
  const tenantId = createStore(db).ensureTenant().id;
  return { db, stock: createStockStore(db), tenantId };
}

/**
 * De kostregels van een mutatie.
 * @param {object} db De database.
 * @param {string} movementId Id van de mutatie.
 * @returns {{ qty: number, unitCost: ?number }[]} Aantal en prijs per gebruikte laag.
 */
const entriesOf = (db, movementId) => db.prepare('SELECT qty, unit_cost FROM stock_cost_entries WHERE movement_id = ? ORDER BY created_at, qty')
  .all(movementId).map((row) => ({ qty: Number(row.qty), unitCost: row.unit_cost == null ? null : Number(row.unit_cost) }));

test('inkoopprijs: een nieuwe prijs overschrijft de oude niet', () => {
  const { stock, tenantId } = freshStock();
  const created = stock.create(tenantId, null, { code: 'PE-25', name: 'PE-buis 25 mm', costPrice: 1.2 }).item;
  assert.deepStrictEqual(created.costPrices.map((price) => price.price), [1.2]);
  const updated = stock.update(tenantId, created.id, { costPrice: 1.35 }).item;
  assert.deepStrictEqual(updated.costPrices.map((price) => price.price), [1.35, 1.2], 'oude prijs blijft in de historie');
  assert.strictEqual(stock.update(tenantId, created.id, { costPrice: 1.35 }).item.costPrices.length, 2, 'dezelfde prijs geeft geen nieuwe regel');

  const backdated = stock.addCostPrice(tenantId, null, created.id, { price: 1.1, validFrom: '2026-01-01', note: 'Oude offerte leverancier' });
  assert.strictEqual(backdated.item.costPrice, 1.35, 'een prijs met een oudere datum verandert de actuele prijs niet');
  assert.strictEqual(backdated.item.costPrices.at(-1).note, 'Oude offerte leverancier');
  const future = stock.addCostPrice(tenantId, null, created.id, { price: 2, validFrom: '2999-01-01' });
  assert.strictEqual(future.field, 'validFrom');
  assert.strictEqual(stock.addCostPrice(tenantId, null, created.id, { price: -1 }).field, 'price');
  assert.strictEqual(stock.addCostPrice(tenantId, null, 'bestaat-niet', { price: 1 }).status, 404);
});

test('FIFO: afboeken gebruikt de oudste laag eerst, ook na een prijsstijging', () => {
  const { db, stock, tenantId } = freshStock();
  const item = stock.create(tenantId, null, { code: 'KLEP', name: 'Magneetklep', costPrice: 20, onHand: 10 }).item;
  assert.deepStrictEqual(item.layers.map((layer) => [layer.remaining, layer.unitCost]), [[10, 20]]);
  const receipt = stock.move(tenantId, null, item.id, { kind: 'ontvangst', qty: 10, unitCost: 25, note: 'Pakbon 123' });
  assert.strictEqual(receipt.item.costPrice, 25, 'de ontvangstprijs wordt de nieuwe inkoopprijs');
  assert.deepStrictEqual(receipt.item.costPrices.map((price) => price.price), [25, 20]);
  const issue = stock.move(tenantId, null, item.id, { kind: 'correctie', qty: -15, note: 'Verkocht aan de balie' });
  assert.deepStrictEqual(entriesOf(db, issue.movementId), [{ qty: -10, unitCost: 20 }, { qty: -5, unitCost: 25 }]);
  assert.deepStrictEqual(issue.item.layers.map((layer) => [layer.remaining, layer.unitCost]), [[5, 25]]);
  assert.strictEqual(stock.stockValue(tenantId).value, 125);

  // Meer eraf dan er is: het tekort tegen de actuele prijs, de stand wordt negatief.
  const shortage = stock.move(tenantId, null, item.id, { kind: 'correctie', qty: -7, note: 'Telfout' });
  assert.deepStrictEqual(entriesOf(db, shortage.movementId), [{ qty: -5, unitCost: 25 }, { qty: -2, unitCost: 25 }]);
  assert.strictEqual(shortage.item.onHand, -2);
  // Een ontvangst vult eerst het tekort aan.
  const refill = stock.move(tenantId, null, item.id, { kind: 'ontvangst', qty: 6, unitCost: 25 });
  assert.deepStrictEqual(refill.item.layers.map((layer) => [layer.remaining, layer.unitCost]), [[4, 25]]);
  assert.strictEqual(stock.move(tenantId, null, item.id, { kind: 'ontvangst', qty: 1, unitCost: 'veel' }).field, 'unitCost');
});

test('FIFO: een onbekende inkoopprijs blijft onbekend tot hij is ingevuld', () => {
  const { db, stock, tenantId } = freshStock();
  const item = stock.create(tenantId, null, { code: 'ZAND', name: 'Zand', onHand: 8 }).item;
  assert.deepStrictEqual(item.layers.map((layer) => [layer.remaining, layer.unitCost, layer.editable]), [[8, null, true]]);
  const issue = stock.move(tenantId, null, item.id, { kind: 'correctie', qty: -3, note: 'Gebruikt' });
  assert.deepStrictEqual(entriesOf(db, issue.movementId), [{ qty: -3, unitCost: null }], 'geen geraden prijs');
  assert.deepStrictEqual(stock.stockValue(tenantId), { value: 0, unknownQty: 5, unknownItems: 1 });

  const layerId = issue.item.layers[0].id;
  const filled = stock.setLayerCost(tenantId, item.id, layerId, 4.5);
  assert.strictEqual(filled.item.layers[0].unitCost, 4.5);
  assert.deepStrictEqual(entriesOf(db, issue.movementId), [{ qty: -3, unitCost: 4.5 }], 'wat al uit de laag kwam krijgt de prijs ook');
  assert.strictEqual(stock.setLayerCost(tenantId, item.id, layerId, -2).field, 'unitCost');
  assert.strictEqual(stock.setLayerCost(tenantId, item.id, 'bestaat-niet', 1).status, 404);

  const receipt = stock.move(tenantId, null, item.id, { kind: 'ontvangst', qty: 2, unitCost: 5 });
  const fixed = receipt.item.layers.find((layer) => layer.unitCost === 5);
  assert.strictEqual(fixed.editable, false);
  assert.strictEqual(stock.setLayerCost(tenantId, item.id, fixed.id, 1).status, 409, 'de prijs van een ontvangst ligt vast');
});

test('FIFO: een opgebruikte laag zonder prijs blijft zichtbaar en invulbaar', () => {
  const { db, stock, tenantId } = freshStock();
  const item = stock.create(tenantId, null, { code: 'GRIND', name: 'Grind', onHand: 2 }).item;
  const issue = stock.move(tenantId, null, item.id, { kind: 'correctie', qty: -2, note: 'Opgebruikt' });
  assert.deepStrictEqual(issue.item.layers.map((layer) => [layer.remaining, layer.unitCost, layer.editable]), [[0, null, true]]);
  stock.setLayerCost(tenantId, item.id, issue.item.layers[0].id, 2.5);
  assert.deepStrictEqual(entriesOf(db, issue.movementId), [{ qty: -2, unitCost: 2.5 }]);
  assert.deepStrictEqual(stock.get(tenantId, item.id).layers, [], 'een lege laag met prijs valt uit het overzicht');
});

test('inkoopprijs: vier decimalen blijven bewaard', () => {
  const { stock, tenantId } = freshStock();
  const item = stock.create(tenantId, null, { code: 'NIP', name: 'Nippel', costPrice: 0.1234 }).item;
  assert.strictEqual(item.costPrice, 0.1234);
  assert.deepStrictEqual(item.costPrices.map((price) => price.price), [0.1234]);
});

test('FIFO: een oude stand zonder lagen wordt een beginstand', () => {
  const { db, stock, tenantId } = freshStock();
  const item = stock.create(tenantId, null, { code: 'OUD', name: 'Oud artikel', costPrice: 3 }).item;
  // Een stand van vóór de voorraadlagen (rechtstreeks in de tabel).
  db.prepare('UPDATE stock_items SET on_hand = 4 WHERE id = ?').run(item.id);
  const issue = stock.move(tenantId, null, item.id, { kind: 'correctie', qty: -1, note: 'Proef' });
  assert.deepStrictEqual(entriesOf(db, issue.movementId), [{ qty: -1, unitCost: 3 }]);
  assert.deepStrictEqual(issue.item.layers.map((layer) => [layer.source, layer.remaining]), [['beginstand', 3]]);
});

test('rapportage: periode en indeling', () => {
  assert.strictEqual(periodOf({ from: '2026-01-01', to: '2026-01-31' }).interval, 'day');
  assert.strictEqual(periodOf({ from: '2026-01-01', to: '2026-03-31' }).interval, 'week');
  assert.strictEqual(periodOf({ from: '2026-01-01', to: '2026-12-31' }).interval, 'month');
  assert.strictEqual(periodOf({ from: '2026-01-01', to: '2026-12-31', interval: 'day' }).interval, 'day');
  assert.ok(periodOf({ from: '2026-02-30', to: '2026-03-01' }).error);
  assert.ok(periodOf({ from: '2026-05-01', to: '2026-04-01' }).error);
  assert.ok(periodOf({ from: '2020-01-01', to: '2026-01-01' }).error);
  assert.strictEqual(bucketOf('2026-11-05', 'week'), '2026-11-02', 'week begint op maandag');
  assert.deepStrictEqual(bucketsBetween('2026-11-15', '2027-01-03', 'month'), ['2026-11-01', '2026-12-01', '2027-01-01']);
});

test('rapportage webshop: kostprijs uit de laag, retour tegen dezelfde prijs, rechten en tenant', async () => {
  const world = await setup();
  const bus = (await world.admin.get('/app/api/stock')).body.items.find((item) => item.code === 'BUS');
  const begin = (await world.admin.get(`/app/api/stock/items/${bus.id}`)).body.layers[0];
  assert.strictEqual(begin.unitCost, null, 'beginvoorraad zonder inkoopprijs is onbekend');
  const filled = await world.admin.put(`/app/api/stock/items/${bus.id}/layers/${begin.id}`, { unitCost: 4 });
  assert.strictEqual(filled.status, 200, JSON.stringify(filled.body));
  assert.strictEqual((await world.vreemd.put(`/app/api/stock/items/${bus.id}/layers/${begin.id}`, { unitCost: 1 })).status, 404, 'andere organisatie');
  assert.strictEqual((await world.shoppers[0].client.put(`/app/api/stock/items/${bus.id}/layers/${begin.id}`, { unitCost: 1 })).status, 403, 'klant');
  assert.strictEqual((await world.shoppers[0].client.post(`/app/api/stock/items/${bus.id}/cost-prices`, { price: 1 })).status, 403, 'klant');
  assert.strictEqual((await world.vreemd.post(`/app/api/stock/items/${bus.id}/cost-prices`, { price: 1 })).status, 404, 'andere organisatie');

  const id = await order(world, world.shoppers[0]);
  // De inkoopprijs stijgt vóór het verzenden: de verkoop komt nog uit de oude partij.
  assert.strictEqual((await world.admin.post(`/app/api/stock/items/${bus.id}/cost-prices`, { price: 6, note: 'Prijsverhoging' })).status, 201);
  assert.strictEqual((await world.admin.post(`/app/api/admin/web-orders/${id}/status`, { status: 'verzonden' })).status, 200);

  const report = (await world.admin.get('/app/api/admin/webshop-report')).body;
  assert.strictEqual(report.totals.revenue, 20);
  assert.strictEqual(report.totals.cost, 8, '2 × de oude inkoopprijs van 4');
  assert.strictEqual(report.totals.margin, 12);
  assert.strictEqual(report.totals.marginPct, 60);
  assert.strictEqual(report.totals.orders, 1);
  assert.deepStrictEqual(report.items.map((item) => [item.code, item.qty, item.margin]), [['BUS', 2, 12]]);
  assert.deepStrictEqual(report.categories.map((category) => category.name), ['Overig']);
  assert.strictEqual(report.series.reduce((sum, period) => sum + period.revenue, 0), 20);
  assert.strictEqual(report.stock.value, 192, '48 × 4 (de oude partij)');
  assert.strictEqual((await world.admin.get('/app/api/admin/webshop-report')).body.totals.lines, 1, 'niet dubbel bij opnieuw ophalen');

  // Retour terug op voorraad: omzet en inkoop gaan er tegen dezelfde prijs af.
  const asked = await postForm(world.base, world.shoppers[0].client, `/bestelling/${id}/retour`, { 'qty:BUS': '1', reason: 'defect' });
  assert.strictEqual(asked.status, 303);
  const record = (await world.admin.get('/app/api/admin/web-returns')).body.items[0];
  assert.strictEqual((await world.admin.post(`/app/api/admin/web-returns/${record.id}/decision`, { approve: true })).status, 200);
  assert.strictEqual((await world.admin.post(`/app/api/admin/web-returns/${record.id}/complete`, { restock: true })).status, 200);
  const after = (await world.admin.get('/app/api/admin/webshop-report?lines=1')).body;
  assert.strictEqual(after.totals.revenue, 10);
  assert.strictEqual(after.totals.cost, 4);
  assert.strictEqual(after.totals.margin, 6);
  assert.deepStrictEqual(after.lines.map((line) => [line.kind, line.qty, line.revenue, line.cost]), [['verkoop', 2, 20, 8], ['retour', -1, -10, -4]]);
  const again = (await world.admin.get('/app/api/admin/webshop-report?lines=1')).body;
  assert.strictEqual(again.lines.length, 2, 'een tweede rapportage voegt geen regels toe');
  const layers = (await world.admin.get(`/app/api/stock/items/${bus.id}`)).body.layers;
  assert.deepStrictEqual(layers.map((layer) => [layer.remaining, layer.unitCost]), [[48, 4], [1, 4]], 'de retour komt terug als partij van 4');

  assert.strictEqual((await world.vreemd.get('/app/api/admin/webshop-report')).body.totals.lines, 0, 'andere organisatie ziet niets');
  assert.strictEqual((await world.shoppers[0].client.get('/app/api/admin/webshop-report')).status, 403, 'klant heeft geen beheerrecht');
  assert.strictEqual((await world.admin.get('/app/api/admin/webshop-report?from=2026-13-01')).status, 400);
});


test('inkoopprijs: vier decimalen blijven bij aanmaken en bewerken', () => {
  const { stock, tenantId } = freshStock();
  const item = stock.create(tenantId, null, { code: 'PRECIES', name: 'Precies', costPrice: 1.2345 }).item;
  assert.strictEqual(item.costPrice, 1.2345);
  assert.strictEqual(stock.update(tenantId, item.id, { name: 'Andere naam' }).item.costPrice, 1.2345);
  assert.strictEqual(stock.update(tenantId, item.id, { costPrice: 2.3456 }).item.costPrice, 2.3456);
});

test('FIFO: een lege onbekende laag kan achteraf worden geprijsd', () => {
  const { db, stock, tenantId } = freshStock();
  const item = stock.create(tenantId, null, { code: 'LEEG', name: 'Leeg', onHand: 2 }).item;
  const issue = stock.move(tenantId, null, item.id, { kind: 'correctie', qty: -2, note: 'Alles gebruikt' });
  assert.deepStrictEqual(issue.item.layers.map((layer) => [layer.remaining, layer.unitCost]), [[0, null]]);
  const filled = stock.setLayerCost(tenantId, item.id, issue.item.layers[0].id, 1.2345);
  assert.deepStrictEqual(entriesOf(db, issue.movementId), [{ qty: -2, unitCost: 1.2345 }]);
  assert.deepStrictEqual(filled.item.layers, []);
});

test('FIFO: retour kiest de werkorder boven een gedeelde bron', () => {
  const { db, stock, tenantId } = freshStock();
  const { createStockCosts } = require('../src/artikelen/stock-costs');
  const costs = createStockCosts(db);
  const item = stock.create(tenantId, null, { code: 'RETOUR', name: 'Retour' }).item;
  for (const [id, workOrderId, price] of [['issue-a', 'a', 2], ['issue-b', 'b', 8]]) {
    db.prepare(`INSERT INTO stock_movements (id, tenant_id, item_id, kind, qty, balance, work_order_id, source, created_at)
      VALUES (?, ?, ?, 'afboeking', -1, -1, ?, 'gereed', '2026-01-01')`).run(id, tenantId, item.id, workOrderId);
    costs.record(tenantId, { id: item.id, cost_price: price }, { movementId: id, delta: -1, onHandBefore: 0, kind: 'afboeking', at: '2026-01-01' });
  }
  // Werkorder bekend: de prijs van die werkorder. Alleen een algemene bron: niets herleidbaars,
  // dus de actuele inkoopprijs. Een eigen bron zonder kostregels (van vóór de lagen): onbekend.
  const cases = [['return-a', { workOrderId: 'a', source: 'gereed' }, 2], ['return-source', { source: 'gereed' }, 99], ['return-old', { source: 'bestelling:W-OUD' }, null]];
  for (const [id, basis, expected] of cases) {
    db.prepare(`INSERT INTO stock_movements (id, tenant_id, item_id, kind, qty, balance, created_at)
      VALUES (?, ?, ?, 'retour', 1, 1, '2026-01-02')`).run(id, tenantId, item.id);
    costs.record(tenantId, { id: item.id, cost_price: 99 }, { movementId: id, delta: 1, onHandBefore: 0, kind: 'retour', at: '2026-01-02', costBasis: basis });
    assert.deepStrictEqual(entriesOf(db, id), [{ qty: 1, unitCost: expected }]);
  }
});

test('rapportage: overlappende selecties voegen order- en retourregels eenmaal toe', () => {
  const { db, tenantId } = freshStock();
  const lines = [{ code: 'ZELFDE', qty: 1, unitExcl: 10 }, { code: 'ZELFDE', qty: 2, unitExcl: 10 }];
  const data = JSON.stringify({ lines });
  db.prepare(`INSERT INTO web_orders (id, tenant_id, number, status, customer_name, email, total, data, created_at, updated_at)
    VALUES ('race', ?, 'W-RACE', 'verzonden', '', '', 30, ?, '2026-01-01', '2026-01-01')`).run(tenantId, data);
  for (const id of ['return-one', 'return-two']) {
    db.prepare(`INSERT INTO web_returns (id, tenant_id, order_id, number, status, data, created_at, updated_at)
      VALUES (?, ?, 'race', ?, 'afgerond', ?, '2026-01-02', '2026-01-02')`).run(id, tenantId, id, data);
  }
  // Beide processen kunnen dezelfde ontbrekende regels selecteren. De echte
  // database verwerkt de inserts en controleert de unieke primaire sleutel.
  const selections = new Map();
  const staleDb = {
    /**
     * Bereidt SQL voor en bewaart de oorspronkelijke selectie.
     * @param {string} sql De opdracht.
     * @returns {object} De opdracht met zo nodig een bewaarde selectie.
     */
    prepare: (sql) => {
      const statement = db.prepare(sql);
      if (!sql.includes('NOT EXISTS')) return statement;
      return {
        /**
         * Geeft dezelfde selectie aan beide synchronisaties.
         * @param {...*} args De queryparameters.
         * @returns {object[]} De oorspronkelijke rijen.
         */
        all: (...args) => {
          if (!selections.has(sql)) selections.set(sql, statement.all(...args));
          return selections.get(sql);
        },
      };
    },
  };
  assert.strictEqual(createWebSalesStore(staleDb).sync(tenantId), 6);
  assert.strictEqual(createWebSalesStore(staleDb).sync(tenantId), 0);
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS total FROM web_sale_lines WHERE tenant_id = ?').get(tenantId).total), 6);
});
