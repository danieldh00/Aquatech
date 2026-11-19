// Openstaande taken voor het dashboard: welke taak bij welk recht hoort en dat lege taken wegvallen.
const test = require('node:test');
const assert = require('node:assert');
const { buildTasks, resetCache } = require('../src/platform/open-tasks');

/**
 * Nepfunctie die zegt of bestelvoorstellen aan staan.
 * @param {boolean} enabled De vaste uitkomst.
 * @returns {Function} Functie met die uitkomst.
 */
function isEnabled(enabled) { return () => enabled; }

/**
 * Nepopslag met vaste uitkomsten.
 * @param {{ orders?: number, proposals?: number, withoutSupplier?: number, enabled?: boolean, shop?: boolean, stock?: boolean }} counts Hoeveel er openstaat per soort.
 * @returns {object} De bronnen voor buildTasks.
 */
function sources({ orders = 0, proposals = 0, withoutSupplier = 0, enabled = true, shop = true, stock = true } = {}) {
  resetCache();
  return {
    orders: { listUnprocessed: () => ({ total: orders, items: orders ? [{ id: 'o1', number: 'WEB-2026-0001', customerName: 'Piet', total: 12.5, createdAt: '2026-11-19T10:00:00Z' }] : [] }) },
    purchaseOrders: { proposals: () => ({ orders: Array.from({ length: proposals }, (_, index) => ({ number: `IO2026-000${index + 1}`, supplierName: 'Leverancier', lines: [{}] })), withoutSupplier }) },
    proposalsEnabled: isEnabled(enabled),
    shopEnabled: isEnabled(shop),
    stockEnabled: isEnabled(stock),
  };
}

test('taken volgen de rechten van de gebruiker en lege taken vallen weg', () => {
  const everything = sources({ orders: 3, proposals: 2, withoutSupplier: 4 });
  const admin = buildTasks({ user: { rights: ['beheer', 'voorraad'] }, tenantId: 't' }, everything);
  assert.deepStrictEqual(admin.map((task) => [task.key, task.count]), [['bestellingen', 3], ['bestelvoorstellen', 2], ['zonder-leverancier', 4]]);
  assert.strictEqual(admin[0].items[0].href, 'webshop-bestellingen/?id=o1');
  assert.deepStrictEqual(buildTasks({ user: { rights: ['voorraad'] }, tenantId: 't' }, everything).map((task) => task.key), ['bestelvoorstellen', 'zonder-leverancier'], 'zonder beheer geen bestellingen');
  assert.deepStrictEqual(buildTasks({ user: { rights: ['werkorders'] }, tenantId: 't' }, everything), [], 'geen rechten, geen taken');
  assert.deepStrictEqual(buildTasks({ user: { rights: ['beheer', 'voorraad'] }, tenantId: 't' }, sources()), [], 'niets open = geen taken');
  assert.deepStrictEqual(buildTasks({ user: { rights: ['voorraad'] }, tenantId: 't' }, sources({ proposals: 1, enabled: false })).map((task) => task.key), [], 'bestelvoorstellen uit = geen taak');
  assert.deepStrictEqual(buildTasks({ user: { rights: ['beheer', 'voorraad'] }, tenantId: 't' }, sources({ orders: 3, shop: false, stock: false })), [], 'webshop uit en module voorraad uit = geen taken');
});

test('de dure tellingen worden kort onthouden per omgeving', () => {
  let calls = 0;
  const counting = sources({ proposals: 2 });
  counting.purchaseOrders = { proposals: () => { calls += 1; return { orders: [], withoutSupplier: 1 }; } };
  const viewer = { user: { rights: ['voorraad'] }, tenantId: 'cache-test' };
  buildTasks(viewer, counting);
  buildTasks(viewer, counting);
  assert.strictEqual(calls, 1, 'tweede weergave binnen de tijd rekent niet opnieuw');
  buildTasks({ ...viewer, tenantId: 'andere' }, counting);
  assert.strictEqual(calls, 2, 'een andere omgeving heeft een eigen telling');
});
