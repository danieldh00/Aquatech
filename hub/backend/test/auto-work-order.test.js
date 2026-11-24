// Werkorder automatisch klaarzetten bij akkoord (V-01): na een akkoord door een medewerker of de klant staat er een werkorder
// (open = In te plannen, materiaal gereserveerd); instelbaar, nooit dubbel, en zichtbaar in de openstaande taken.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { signaturePng } = require('../src/platform/test-data');
const { listen, createLogin } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';
const SIGNATURE = signaturePng();
/**
 * Offertegegevens met een materiaalregel en een arbeidsregel.
 * @returns {object} De offertedata.
 */
const quoteData = () => ({
  title: 'Beregening', customer: { name: 'Fam. Jansen', email: 'jansen@klant.test' },
  lines: [{ id: 'r1', section: 'materiaal', code: 'PE-25', description: 'PE-buis', qty: 10, unit: 'm', price: 2, vat: 21 }, { id: 'r2', section: 'arbeid', description: 'Leggen', qty: 2, unit: 'uur', price: 55, vat: 21 }],
});

/**
 * Start de app met een beheerder, een planner, een klant en een tweede organisatie.
 * @returns {Promise<object>} base, as (inloggen), customerId en server.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW }, { mustChangePassword: false });
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const customer = await store.createAccount(main, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1', APP_PUBLIC_URL: 'https://aquatech.example/' }, secret: 'v'.repeat(64), db, loginDelayMs: 0 }));
  return { server, base, as: createLogin(base, { password: PW }), customerId: customer.id || customer.user.id };
}

test('akkoord door een medewerker zet één werkorder klaar, met reservering en een taak', async () => {
  const { server, as, customerId } = await setup();
  try {
    const baas = await as('baas'), klaas = await as('klaas'), vreemd = await as('vreemd', 'ander');
    assert.strictEqual((await baas.post('/app/api/stock/import', { codes: ['PE-25'] })).status, 200);
    const quote = (await baas.post('/app/api/quotes', { data: quoteData(), customerId })).body;
    assert.strictEqual((await baas.get('/app/api/workorders')).body.items.length, 0);
    assert.strictEqual((await baas.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' })).status, 200);
    const orders = (await baas.get('/app/api/workorders')).body.items;
    assert.strictEqual(orders.length, 1, 'werkorder is aangemaakt');
    assert.strictEqual(orders[0].status, 'open');
    assert.strictEqual(orders[0].plannedDate, '', 'nog niet ingepland');
    assert.strictEqual(orders[0].quoteId, quote.id);
    assert.ok(JSON.stringify((await baas.get(`/app/api/stock/workorders/${orders[0].id}`)).body).includes('PE-25'), 'materiaal gereserveerd');
    // Nog een keer akkoord of opslaan maakt er geen tweede.
    await baas.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' });
    assert.strictEqual((await baas.get('/app/api/workorders')).body.items.length, 1);
    // In de openstaande taken van wie plant; de andere organisatie ziet niets.
    const task = (await baas.get('/app/api/tasks')).body.tasks.find((entry) => entry.key === 'in-te-plannen');
    assert.deepStrictEqual([task.count, task.items.length], [1, 1]);
    assert.strictEqual((await klaas.get('/app/api/tasks')).body.tasks.some((entry) => entry.key === 'in-te-plannen'), false, 'een klant plant niet');
    assert.strictEqual((await vreemd.get('/app/api/tasks')).body.tasks.some((entry) => entry.key === 'in-te-plannen'), false);
    assert.strictEqual((await vreemd.get('/app/api/workorders')).body.items.length, 0);
    // Ingepland: de taak verdwijnt.
    assert.strictEqual((await baas.post(`/app/api/workorders/${orders[0].id}/schedule`, { plannedDate: '2031-05-01' })).status, 200);
    assert.strictEqual((await baas.get('/app/api/tasks')).body.tasks.some((entry) => entry.key === 'in-te-plannen'), false);
  } finally {
    server.close();
  }
});

test('akkoord door de klant zet ook een werkorder klaar; uitgezet in Beheer > Modules is er geen', async () => {
  const { server, as, customerId } = await setup();
  try {
    const baas = await as('baas'), klaas = await as('klaas');
    const quote = (await baas.post('/app/api/quotes', { data: quoteData(), customerId })).body;
    await baas.put(`/app/api/quotes/${quote.id}`, { status: 'verzonden' });
    const seen = (await klaas.get(`/app/api/quotes/${quote.id}`)).body;
    const answered = await klaas.post(`/app/api/quotes/${quote.id}/respond`, { answer: 'akkoord', name: 'Klaas Jansen', terms: true, signature: SIGNATURE, version: seen.version });
    assert.strictEqual(answered.status, 200);
    const orders = (await baas.get('/app/api/workorders')).body.items;
    assert.deepStrictEqual([orders.length, orders[0].status, orders[0].quoteId], [1, 'open', quote.id]);

    // Uitzetten: een volgend akkoord geeft geen werkorder.
    assert.strictEqual((await baas.put('/app/api/admin/modules', { flags: { 'werkorder-automatisch': false } })).status, 200);
    const second = (await baas.post('/app/api/quotes', { data: quoteData(), customerId })).body;
    assert.strictEqual((await baas.put(`/app/api/quotes/${second.id}`, { status: 'akkoord' })).status, 200);
    assert.strictEqual((await baas.get('/app/api/workorders')).body.items.length, 1, 'uit = geen automatische werkorder');
    // De handmatige knop blijft werken.
    assert.strictEqual((await baas.post('/app/api/workorders', { quoteId: second.id })).status, 201);
  } finally {
    server.close();
  }
});

test('akkoord via de openbare link zet ook een werkorder klaar, met reservering', async () => {
  const { server, base, as, customerId } = await setup();
  try {
    const baas = await as('baas');
    assert.strictEqual((await baas.post('/app/api/stock/import', { codes: ['PE-25'] })).status, 200);
    const quote = (await baas.post('/app/api/quotes', { data: quoteData(), customerId })).body;
    const shared = (await baas.post(`/app/api/quotes/${quote.id}/share`, { url: 'https://aquatech.example/app/openbaar/offerte.html' })).body;
    const token = shared.share.url.split('#t=')[1];
    const seen = await (await fetch(`${base}/app/api/public/quote`, { headers: { 'X-Offerte-Token': token } })).json();
    const answered = await fetch(`${base}/app/api/public/quote/respond`, {
      method: 'POST', headers: { 'X-Offerte-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: 'akkoord', name: 'Klaas Jansen', terms: true, signature: SIGNATURE, version: seen.quote.version }),
    });
    assert.strictEqual(answered.status, 200);
    const orders = (await baas.get('/app/api/workorders')).body.items;
    assert.deepStrictEqual([orders.length, orders[0].status, orders[0].quoteId], [1, 'open', quote.id]);
    assert.ok(JSON.stringify((await baas.get(`/app/api/stock/workorders/${orders[0].id}`)).body).includes('PE-25'), 'materiaal gereserveerd');
  } finally {
    server.close();
  }
});
