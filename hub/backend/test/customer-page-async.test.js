// Test: listCustomerPageAsync (db.async) geeft hetzelfde als de synchrone listCustomerPage (zoeken, filter, paginering, totaal).
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');

/**
 * Maakt een store met een hoofdtenant, een andere organisatie en een paar klanten.
 * @returns {{ store: object, main: string, otherId: string }} De store en de tenant-id's.
 */
function setup() {
  const store = createStore(openDb());
  const main = store.ensureTenant().id;
  const otherId = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant.id;
  for (const name of ['Jansen Tuinen', 'Pieters', 'Jansma', 'De Vries', 'Bakker']) {
    assert.ok(store.createCustomer(main, { displayName: name, email: `${name.replace(/\s/g, '').toLowerCase()}@voorbeeld.nl` }).user);
  }
  assert.ok(store.createCustomer(otherId, { displayName: 'Jansen Vreemd' }).user);
  return { store, main, otherId };
}

test('listCustomerPageAsync geeft hetzelfde als listCustomerPage', async () => {
  const { store, main } = setup();
  for (const options of [{}, { search: 'jans' }, { search: 'JANSEN tuinen' }, { search: 'voorbeeld.nl', limit: 2, offset: 1 }, { search: 'bestaatniet' }, { group: 'zakelijk' }, { activeOnly: true, limit: 3 }]) {
    assert.deepStrictEqual(await store.listCustomerPageAsync([main], options), store.listCustomerPage([main], options), JSON.stringify(options));
  }
});

test('listCustomerPageAsync pagineert, telt het totaal en blijft binnen de organisatie', async () => {
  const { store, main } = setup();
  const page = await store.listCustomerPageAsync([main], { limit: 2, offset: 0 });
  assert.strictEqual(page.items.length, 2);
  assert.strictEqual(page.total, 5);
  const jans = await store.listCustomerPageAsync([main], { search: 'jans' });
  assert.deepStrictEqual(jans.items.map((customer) => customer.displayName), ['Jansen Tuinen', 'Jansma']);
  assert.strictEqual(jans.total, 2);
});
