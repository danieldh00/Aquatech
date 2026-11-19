// Test: bij Gereed van een werkorder komt een conceptfactuur klaar (instelling draftOnDone), één keer, en uit te zetten.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 'd'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Hoofdtenant met beheerder en installateur, een testserver en een werkorder uit een geaccordeerde offerte.
 * @param {{ lines?: object[] }} [options] lines: de regels van de offerte (leeg = een werkorder zonder regels).
 * @returns {Promise<object>} server, baas, kees en workOrder.
 */
async function setup({ lines = [{ section: 'materiaal', code: 'PE-25', description: 'PE-buis', qty: 50, unit: 'm', price: 2, vat: 21 }] } = {}) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db }));
  const as = createLogin(base, { password: PW });
  const baas = await as('baas');
  const kees = await as('kees');
  const quote = (await kees.post('/app/api/quotes', { data: { title: 'Aanleg', discountPct: 0, customer: { name: 'Fam. Jansen', address: 'Tuinstraat 1, 8071 AB Nunspeet' },
    lines } })).body;
  assert.strictEqual((await kees.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' })).status, 200);
  const workOrder = (await kees.post('/app/api/workorders', { quoteId: quote.id })).body;
  return { server, baas, kees, workOrder };
}

test('Gereed zet één conceptfactuur klaar, ook bij nog een keer opslaan', async () => {
  const { server, baas, kees, workOrder } = await setup();
  try {
    assert.strictEqual((await baas.get(`/app/api/invoices?workOrderId=${workOrder.id}`)).body.items.length, 0);
    assert.strictEqual((await kees.put(`/app/api/workorders/${workOrder.id}`, { status: 'gereed' })).status, 200);
    const items = (await baas.get(`/app/api/invoices?workOrderId=${workOrder.id}`)).body.items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].status, 'concept');
    assert.strictEqual((await kees.put(`/app/api/workorders/${workOrder.id}`, { status: 'gereed' })).status, 200);
    assert.strictEqual((await baas.get(`/app/api/invoices?workOrderId=${workOrder.id}`)).body.items.length, 1);
  } finally { server.close(); }
});

test('met draftOnDone uit komt er geen conceptfactuur', async () => {
  const { server, baas, kees, workOrder } = await setup();
  try {
    assert.strictEqual((await baas.put('/app/api/admin/settings', { invoicing: { draftOnDone: false } })).status, 200);
    assert.strictEqual((await kees.put(`/app/api/workorders/${workOrder.id}`, { status: 'gereed' })).status, 200);
    assert.strictEqual((await baas.get(`/app/api/invoices?workOrderId=${workOrder.id}`)).body.items.length, 0);
  } finally { server.close(); }
});

test('een werkorder zonder regels en een uitgezette module Facturen geven geen conceptfactuur', async () => {
  const empty = await setup({ lines: [] });
  try {
    assert.strictEqual((await empty.kees.put(`/app/api/workorders/${empty.workOrder.id}`, { status: 'gereed' })).status, 200);
    assert.strictEqual((await empty.baas.get(`/app/api/invoices?workOrderId=${empty.workOrder.id}`)).body.items.length, 0);
  } finally { empty.server.close(); }
  const off = await setup();
  try {
    assert.strictEqual((await off.baas.put('/app/api/admin/settings', { modules: { facturen: false } })).status, 200);
    assert.strictEqual((await off.kees.put(`/app/api/workorders/${off.workOrder.id}`, { status: 'gereed' })).status, 200);
    assert.strictEqual((await off.baas.put('/app/api/admin/settings', { modules: { facturen: true } })).status, 200);
    assert.strictEqual((await off.baas.get(`/app/api/invoices?workOrderId=${off.workOrder.id}`)).body.items.length, 0);
  } finally { off.server.close(); }
});

test('de audit blijft bestaan bij handmatig aanmaken en bij Gereed', async () => {
  const { server, baas, kees, workOrder } = await setup();
  try {
    assert.strictEqual((await kees.put(`/app/api/workorders/${workOrder.id}`, { status: 'gereed' })).status, 200);
    assert.strictEqual((await baas.post('/app/api/invoices', { workOrderId: workOrder.id, force: true })).status, 201);
    const actions = (await baas.get('/app/api/admin/audit')).body.items.map((entry) => entry.action);
    assert.ok(actions.includes('factuur_concept_bij_gereed'));
    assert.ok(actions.includes('factuur_aangemaakt'));
  } finally { server.close(); }
});
