// Openstaande taken voor het dashboard: welke taak bij welk recht hoort en dat lege taken wegvallen.
const test = require('node:test');
const assert = require('node:assert');
const { buildTasks } = require('../src/platform/open-tasks');

/**
 * Nepfunctie die zegt of bestelvoorstellen aan staan.
 * @param {boolean} enabled De vaste uitkomst.
 * @returns {Function} Functie met die uitkomst.
 */
function isEnabled(enabled) { return () => enabled; }

/**
 * Nepopslag met vaste uitkomsten.
 * @param {{ orders?: number, proposals?: number, withoutSupplier?: number, prices?: number, enabled?: boolean }} counts Hoeveel er openstaat per soort.
 * @returns {object} De bronnen voor buildTasks.
 */
function sources({ orders = 0, proposals = 0, withoutSupplier = 0, prices = 0, enabled = true } = {}) {
  return {
    orders: { listUnprocessed: () => ({ total: orders, items: orders ? [{ id: 'o1', number: 'WEB-2026-0001', customerName: 'Piet', total: 12.5, createdAt: '2026-11-19T10:00:00Z' }] : [] }) },
    purchaseOrders: { proposals: () => ({ orders: Array.from({ length: proposals }, (_, index) => ({ number: `IO2026-000${index + 1}`, supplierName: 'Leverancier', lines: [{}] })), withoutSupplier }) },
    priceFactors: { openProposals: () => Array.from({ length: prices }, (_, index) => ({ id: String(index) })) },
    proposalsEnabled: isEnabled(enabled),
  };
}

test('taken volgen de rechten van de gebruiker en lege taken vallen weg', () => {
  const everything = sources({ orders: 3, proposals: 2, withoutSupplier: 4, prices: 5 });
  const admin = buildTasks({ user: { rights: ['beheer', 'voorraad'] }, tenantId: 't' }, everything);
  assert.deepStrictEqual(admin.map((task) => [task.key, task.count]), [['bestellingen', 3], ['bestelvoorstellen', 2], ['zonder-leverancier', 4], ['prijsvoorstellen', 5]]);
  assert.strictEqual(admin[0].items[0].href, 'webshop-bestellingen/?id=o1');
  assert.deepStrictEqual(buildTasks({ user: { rights: ['voorraad'] }, tenantId: 't' }, everything).map((task) => task.key), ['bestelvoorstellen', 'zonder-leverancier', 'prijsvoorstellen'], 'zonder beheer geen bestellingen');
  assert.deepStrictEqual(buildTasks({ user: { rights: ['werkorders'] }, tenantId: 't' }, everything), [], 'geen rechten, geen taken');
  assert.deepStrictEqual(buildTasks({ user: { rights: ['beheer', 'voorraad'] }, tenantId: 't' }, sources()), [], 'niets open = geen taken');
  assert.deepStrictEqual(buildTasks({ user: { rights: ['voorraad'] }, tenantId: 't' }, sources({ proposals: 1, enabled: false })).map((task) => task.key), [], 'bestelvoorstellen uit = geen taak');
});
