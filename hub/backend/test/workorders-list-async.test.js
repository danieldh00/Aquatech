// Werkorderlijst: list en listAsync (db.async) geven hetzelfde, ook met filters en per organisatie.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createWorkOrderStore } = require('../src/uitvoering/workorders');

test('werkorders: listAsync geeft hetzelfde als list, met filters en tenant-isolatie', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  const other = store.createTenant({ name: 'Blauw BV', slug: 'blauw' }).tenant.id;
  const owner = await store.createAccount(main, { username: 'anne', displayName: 'Anne', role: 'beheerder', password: 'Tuin-Plan-2026!' });
  const customer = store.createCustomer(main, { displayName: 'Klant Een', email: 'een@voorbeeld.nl' }).user;
  const workOrders = createWorkOrderStore(db);
  const user = { id: owner.user ? owner.user.id : owner.id, tenant_id: main };
  const unlinked = workOrders.createReceived(user, { title: 'Zonder klant' });
  const linked = workOrders.createReceived(user, { title: 'Met klant' }, { customerId: customer.id });
  // Een klant ziet een werkorder via een niet-concept-offerte aan zijn account.
  const quoteId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO quotes (id, tenant_id, owner_id, number, status, title, data, created_at, updated_at, customer_id)
    VALUES (?, ?, ?, 'O2026-0001', 'akkoord', 'Offerte', '{}', ?, ?, ?)`).run(quoteId, main, user.id, now, now, customer.id);
  db.prepare('UPDATE work_orders SET quote_id = ? WHERE id = ?').run(quoteId, linked.id);
  /**
   * Gesorteerde id's van een lijst werkorders.
   * @param {object[]} items De werkorders.
   * @returns {string[]} De id's.
   */
  const ids = (items) => items.map((item) => item.id).sort();

  assert.deepStrictEqual(ids(await workOrders.listAsync(main)), ids(workOrders.list(main)));
  assert.deepStrictEqual(ids(await workOrders.listAsync(main)), ids([unlinked, linked]));
  assert.deepStrictEqual(await workOrders.listAsync(other), []);
  const unknown = crypto.randomUUID();
  assert.deepStrictEqual(await workOrders.listAsync(main, { quoteId: unknown }), workOrders.list(main, { quoteId: unknown }));
  assert.deepStrictEqual(await workOrders.listAsync(main, { customerId: unknown }), []);
  const forCustomer = await workOrders.listAsync(main, { customerId: customer.id });
  assert.deepStrictEqual(ids(forCustomer), [linked.id]);
  assert.ok(forCustomer[0].data, 'het klantportaal krijgt de data erbij');
  assert.deepStrictEqual(forCustomer, workOrders.list(main, { customerId: customer.id }));
  assert.deepStrictEqual(ids(await workOrders.listAsync(main, { quoteId })), [linked.id]);
});
