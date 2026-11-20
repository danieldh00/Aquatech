// Test: listAsync (db.async) geeft hetzelfde als de synchrone list voor offertes, facturen en debiteuren, ook met filters en een tweede organisatie.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createQuoteStore } = require('../src/verkoop/quotes');
const { createInvoiceStore } = require('../src/verkoop/invoices');
const { createDebtorStore } = require('../src/verkoop/debtors');
const InvoiceCore = require(path.join(__dirname, '..', '..', 'frontend', 'facturen', 'invoice-core.js'));

/**
 * Maakt twee organisaties met elk een gebruiker, offertes, facturen en debiteuren.
 * @returns {Promise<object>} De stores en de tenant-id's en gebruikers.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  const otherId = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant.id;
  const mainUser = (await store.createAccount(main, { username: 'anne', displayName: 'Anne', role: 'beheerder', password: 'Tuin-Plan-2026!' })).user;
  const otherUser = (await store.createAccount(otherId, { username: 'bram', displayName: 'Bram', role: 'beheerder', password: 'Tuin-Plan-2026!' })).user;
  const quotes = createQuoteStore(db);
  const debtors = createDebtorStore(db);
  const invoices = createInvoiceStore(db, { debtors });
  const settings = InvoiceCore.sanitizeSettings({});
  for (const [tenantId, user, name] of [[main, mainUser, 'Jansen'], [main, mainUser, 'Pieters'], [otherId, otherUser, 'Vreemd']]) {
    quotes.create({ ...user, tenant_id: tenantId }, { title: `Offerte ${name}`, customer: { name } });
    invoices.create(tenantId, user, { customer: { name, email: `${name.toLowerCase()}@voorbeeld.nl` } }, settings);
    debtors.ensure(tenantId, { name, email: `${name.toLowerCase()}@voorbeeld.nl` });
  }
  return { db, quotes, invoices, debtors, main, otherId, mainUser };
}

test('db.async is aanwezig in de test (anders bewijst de vergelijking niets)', async () => {
  const { db } = await setup();
  assert.ok(db.async);
});

test('quotes.listAsync = list, met filters en binnen de organisatie', async () => {
  const { quotes, main, otherId, mainUser } = await setup();
  for (const [tenantId, filters] of [[main, {}], [main, { ownerId: mainUser.id }], [main, { planId: 'bestaatniet' }], [main, { customerId: mainUser.id }], [otherId, {}]]) {
    assert.deepStrictEqual(await quotes.listAsync(tenantId, filters), quotes.list(tenantId, filters), JSON.stringify(filters));
  }
  assert.strictEqual((await quotes.listAsync(main)).length, 2);
  assert.strictEqual((await quotes.listAsync(otherId)).length, 1);
});

test('invoices.listAsync = list, met filters en binnen de organisatie', async () => {
  const { invoices, main, otherId } = await setup();
  for (const [tenantId, filters] of [[main, {}], [main, { status: 'concept' }], [main, { status: 'definitief' }], [main, { kinds: ['credit'] }], [otherId, {}]]) {
    assert.deepStrictEqual(await invoices.listAsync(tenantId, filters), invoices.list(tenantId, filters), JSON.stringify(filters));
  }
  assert.strictEqual((await invoices.listAsync(main)).length, 2);
  assert.strictEqual((await invoices.listAsync(otherId)).length, 1);
});

test('debtors.listAsync = list, met zoeken en binnen de organisatie', async () => {
  const { debtors, main, otherId } = await setup();
  for (const [tenantId, options] of [[main, {}], [main, { search: 'jans' }], [main, { search: 'bestaatniet' }], [otherId, {}]]) {
    assert.deepStrictEqual(await debtors.listAsync(tenantId, options), debtors.list(tenantId, options), JSON.stringify(options));
  }
  assert.strictEqual((await debtors.listAsync(main, { search: 'jans' })).length, 1);
  assert.strictEqual((await debtors.listAsync(otherId)).length, 1);
});
