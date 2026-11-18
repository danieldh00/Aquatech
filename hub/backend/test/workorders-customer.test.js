// Werkorders aan een klantrecord: koppelen uit offerte en melding, kiezen en ontkoppelen in het formulier, automatisch koppelen op naam en de klantkaart.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const WorkOrderCore = require('../../frontend/werkorders/workorder-core.js');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const PASSWORD = 'Tuin-Plan-2026!';

/**
 * Een omgeving met beheerder, installateur, planner (geen recht klanten) en twee klanten, plus een tweede organisatie met een klant.
 * @returns {Promise<object>} server, base, as, db, store, tenantId, de klanten en de klant van de andere organisatie.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  await store.createAccount(tenantId, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PASSWORD });
  await store.createAccount(tenantId, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PASSWORD });
  await store.createAccount(tenantId, { username: 'piet', displayName: 'Piet', role: 'planner', password: PASSWORD });
  const jansen = store.createCustomer(tenantId, { displayName: 'Jan Jansen' }).user;
  const bos = store.createCustomer(tenantId, { displayName: 'Piet Bos', business: { companyName: 'Bos Hoveniers BV', kvkNumber: '12345678', vatNumber: 'NL123456789B01' } }).user;
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  const stranger = store.createCustomer(other.id, { displayName: 'Vreemde Klant' }).user;
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: 'test-secret-test-secret-test-secret', db, loginDelayMs: 0 }));
  return { server, base, as: createLogin(base, { password: PASSWORD }), db, store, tenantId, jansen, bos, stranger };
}

/**
 * Maakt een werkorder zonder offerte rechtstreeks in de opslag (zoals een melding of uitbesteding).
 * @param {object} app De opstelling van setup().
 * @param {string} customerName Naam op de werkorder.
 * @returns {object} De rij met id.
 */
function insertWorkOrder(app, customerName) {
  const id = require('crypto').randomUUID();
  const owner = app.db.prepare("SELECT id FROM users WHERE tenant_id = ? AND username = 'baas'").get(app.tenantId);
  const stamp = new Date().toISOString();
  const number = `WO-9999-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  app.db.prepare(`INSERT INTO work_orders (id, tenant_id, owner_id, number, status, title, customer, address, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', 'Klus', ?, '', ?, ?, ?)`).run(id, app.tenantId, owner.id, number, customerName, JSON.stringify(WorkOrderCore.sanitize({ title: 'Klus', customer: { name: customerName } })), stamp, stamp);
  return { id };
}

test('werkorder uit een offerte met een klant erft het klantrecord; zonder klant blijft hij ongekoppeld', async () => {
  const app = await setup();
  try {
    const kees = await app.as('kees');
    const withCustomer = (await kees.post('/app/api/quotes', { data: { title: 'A', customer: { name: 'Jan Jansen' } }, customerId: app.jansen.id })).body;
    const without = (await kees.post('/app/api/quotes', { data: { title: 'B', customer: { name: 'Los Contact' } } })).body;
    for (const quote of [withCustomer, without]) await kees.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' });
    const linked = (await kees.post('/app/api/workorders', { quoteId: withCustomer.id })).body;
    const loose = (await kees.post('/app/api/workorders', { quoteId: without.id })).body;
    assert.strictEqual(linked.customerId, app.jansen.id);
    assert.strictEqual(linked.customerAccount.displayName, 'Jan Jansen');
    assert.strictEqual(loose.customerId, null);
    assert.strictEqual(loose.customerAccount, null);
    // Zichtbaar in de lijst en op de klantkaart.
    const list = (await kees.get('/app/api/workorders')).body.items;
    assert.strictEqual(list.find((item) => item.id === linked.id).customerId, app.jansen.id);
    const card = (await kees.get(`/app/api/customers/${app.jansen.id}`)).body;
    assert.deepStrictEqual(card.workOrders.map((item) => item.id), [linked.id]);
  } finally { app.server.close(); }
});

test('klant kiezen en ontkoppelen in het formulier: controle op recht, bestaan en organisatie', async () => {
  const app = await setup();
  try {
    const kees = await app.as('kees'), piet = await app.as('piet');
    const { id } = insertWorkOrder(app, 'Onbekend');
    const url = `/app/api/workorders/${id}`;
    assert.strictEqual((await kees.get(url)).body.customerId, null);
    const linked = await kees.put(url, { customerId: app.bos.id });
    assert.strictEqual(linked.status, 200);
    assert.strictEqual(linked.body.customerId, app.bos.id);
    assert.strictEqual(linked.body.customerAccount.companyName, 'Bos Hoveniers BV');
    // Een wijziging zonder customerId laat de koppeling staan.
    assert.strictEqual((await kees.put(url, { status: 'bezig' })).body.customerId, app.bos.id);
    // Onbekend, uit een andere organisatie, of geen tekst: 400 en de koppeling blijft.
    for (const bad of ['bestaat-niet', app.stranger.id, 42, 'x'.repeat(65)]) {
      assert.strictEqual((await kees.put(url, { customerId: bad })).status, 400, String(bad));
    }
    assert.strictEqual((await kees.get(url)).body.customerId, app.bos.id);
    // Een planner heeft werkorders maar niet klanten.
    assert.strictEqual((await piet.put(url, { customerId: app.jansen.id })).status, 403);
    assert.strictEqual((await piet.put(url, { customerId: null })).status, 403);
    assert.strictEqual((await piet.put(url, { status: 'gepland' })).status, 200, 'zonder customerId werkt opslaan gewoon');
    assert.strictEqual((await piet.get('/app/api/workorder-customers')).status, 403);
    assert.strictEqual((await piet.post('/app/api/workorders/link-customers')).status, 403);
    // Ontkoppelen.
    const cleared = await kees.put(url, { customerId: null });
    assert.strictEqual(cleared.body.customerId, null);
    // Een uitgeschakelde klant kan niet meer gekozen worden.
    app.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(app.jansen.id);
    assert.strictEqual((await kees.put(url, { customerId: app.jansen.id })).status, 400);
  } finally { app.server.close(); }
});

test('klanten zoeken voor de werkorder: alleen eigen organisatie, zonder het wachtwoord of interne velden', async () => {
  const app = await setup();
  try {
    const kees = await app.as('kees');
    assert.strictEqual((await createClient(app.base).get('/app/api/workorder-customers')).status, 401);
    const found = (await kees.get('/app/api/workorder-customers?q=bos')).body.items;
    assert.deepStrictEqual(found.map((item) => item.id), [app.bos.id]);
    assert.deepStrictEqual(Object.keys(found[0]).sort(), ['address', 'companyName', 'displayName', 'email', 'id', 'phone', 'username']);
    assert.strictEqual((await kees.get('/app/api/workorder-customers?q=vreemde')).body.items.length, 0);
  } finally { app.server.close(); }
});

test('automatisch koppelen op naam: alleen bij precies één klant, rest blijft ongekoppeld en zichtbaar', async () => {
  const app = await setup();
  try {
    const kees = await app.as('kees');
    // Tweede 'Jan Jansen' maakt die naam dubbelzinnig; 'Bos Hoveniers BV' (bedrijfsnaam) is eenduidig.
    app.store.createCustomer(app.tenantId, { displayName: 'jan  jansen' });
    const exact = insertWorkOrder(app, ' bos hoveniers bv ');
    const dubbel = insertWorkOrder(app, 'Jan Jansen');
    const geen = insertWorkOrder(app, 'Niemand Bekend');
    const leeg = insertWorkOrder(app, '');
    const result = (await kees.post('/app/api/workorders/link-customers')).body;
    assert.strictEqual(result.linked, 1);
    assert.strictEqual(result.ambiguous, 1);
    assert.strictEqual(result.unmatched, 1);
    assert.strictEqual(result.unlinked, 3);
    const byId = Object.fromEntries((await kees.get('/app/api/workorders')).body.items.map((item) => [item.id, item]));
    assert.strictEqual(byId[exact.id].customerId, app.bos.id);
    for (const row of [dubbel, geen, leeg]) assert.strictEqual(byId[row.id].customerId, null);
    // Opnieuw draaien verandert niets; een eenmaal gekoppelde werkorder wordt nooit overschreven.
    assert.strictEqual((await kees.post('/app/api/workorders/link-customers')).body.linked, 0);
  } finally { app.server.close(); }
});

test('autoLink koppelt nooit klanten van een andere organisatie en laat de wijzigingstijd staan', async () => {
  const app = await setup();
  try {
    const { id } = insertWorkOrder(app, 'Vreemde Klant');
    const before = app.db.prepare('SELECT updated_at FROM work_orders WHERE id = ?').get(id).updated_at;
    const kees = await app.as('kees');
    assert.strictEqual((await kees.post('/app/api/workorders/link-customers')).body.linked, 0);
    insertWorkOrder(app, 'Jan Jansen');
    assert.strictEqual((await kees.post('/app/api/workorders/link-customers')).body.linked, 1);
    assert.strictEqual(app.db.prepare('SELECT updated_at FROM work_orders WHERE id = ?').get(id).updated_at, before);
  } finally { app.server.close(); }
});

test('een klant verwijderen ontkoppelt zijn werkorders', async () => {
  const app = await setup();
  try {
    const baas = await app.as('baas');
    const { id } = insertWorkOrder(app, 'Jan Jansen');
    await baas.put(`/app/api/workorders/${id}`, { customerId: app.jansen.id });
    const removed = await baas.del(`/app/api/admin/users/${app.jansen.id}`);
    assert.ok([200, 204].includes(removed.status), `status ${removed.status}`);
    assert.strictEqual((await baas.get(`/app/api/workorders/${id}`)).body.customerId, null);
  } finally { app.server.close(); }
});
