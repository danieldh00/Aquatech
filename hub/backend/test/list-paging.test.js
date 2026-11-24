// Paginering van lijsten (audit T-05): harde bovengrens, ?limit en ?offset, totaal en de melding dat een lijst is ingekort.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, listen } = require('./helpers/http-client');
const { createPdokFake } = require('./helpers/pdok-fake');
const { LIST_LIMIT, pageSize, pageOffset, pageOf, pagedBody } = require('../src/platform/list-paging');

const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

test('pageSize en pageOffset begrenzen en vullen standaardwaarden in', () => {
  assert.strictEqual(pageSize(undefined), LIST_LIMIT);
  assert.strictEqual(pageSize('abc'), LIST_LIMIT);
  assert.strictEqual(pageSize(0), LIST_LIMIT);
  assert.strictEqual(pageSize(-5), LIST_LIMIT);
  assert.strictEqual(pageSize(10), 10);
  assert.strictEqual(pageSize('25'), 25);
  assert.strictEqual(pageSize(10 ** 9), LIST_LIMIT);
  assert.strictEqual(pageOffset(undefined), 0);
  assert.strictEqual(pageOffset(-3), 0);
  assert.strictEqual(pageOffset('7'), 7);
  assert.deepStrictEqual(pageOf({ limit: '5', offset: '2' }), { limit: 5, offset: 2 });
  assert.deepStrictEqual(pagedBody([1, 2], 5, { limit: 2, offset: 0 }), { items: [1, 2], total: 5, truncated: true });
  assert.deepStrictEqual(pagedBody([5], 5, { limit: 2, offset: 4 }), { items: [5], total: 5, truncated: false });
});

test('offertes en werkorders: pagina, totaal en ingekort', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { APP_PUBLIC_URL: 'https://aquatech.example/' }, secret: 'e'.repeat(64), db, addressFetch: createPdokFake().fetchImpl, loginDelayMs: 0 }));
  servers.push(server);
  const monteur = await createLogin(base, { password: PW })('monteur');
  /**
   * Offertegegevens met een titel.
   * @param {string} title De titel.
   * @returns {object} De gegevens.
   */
  const data = (title) => ({ title, customer: { name: 'Fam. Jansen' }, lines: [{ id: 'r1', section: 'materiaal', description: 'Sproeier', qty: 1, unit: 'st', price: 10, vat: 21 }] });
  const ids = [];
  for (const title of ['A', 'B', 'C']) {
    const quote = (await monteur.post('/app/api/quotes', { data: data(title) })).body;
    await monteur.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' });
    ids.push(quote.id);
  }
  const all = (await monteur.get('/app/api/quotes')).body;
  assert.deepStrictEqual([all.items.length, all.total, all.truncated], [3, 3, false]);
  const first = (await monteur.get('/app/api/quotes?limit=2')).body;
  assert.deepStrictEqual([first.items.length, first.total, first.truncated], [2, 3, true]);
  const second = (await monteur.get('/app/api/quotes?limit=2&offset=2')).body;
  assert.deepStrictEqual([second.items.length, second.total, second.truncated], [1, 3, false]);
  assert.deepStrictEqual([...first.items, ...second.items].map((quote) => quote.id).sort(), [...ids].sort(), 'de pagina\'s sluiten op elkaar aan');
  assert.strictEqual((await monteur.get('/app/api/quotes?limit=-1')).body.items.length, 3, 'ongeldige limit valt terug op de standaard');

  for (const id of ids) assert.strictEqual((await monteur.post('/app/api/workorders', { quoteId: id })).status, 201);
  const wo = (await monteur.get('/app/api/workorders?limit=2')).body;
  assert.deepStrictEqual([wo.items.length, wo.total, wo.truncated], [2, 3, true]);
  assert.ok(wo.items[0].outsourcing === null && 'logged' in wo.items[0], 'de verrijking per werkorder blijft');
  const rest = (await monteur.get('/app/api/workorders?limit=2&offset=2')).body;
  assert.deepStrictEqual([rest.items.length, rest.total, rest.truncated], [1, 3, false]);
  assert.strictEqual((await monteur.get(`/app/api/workorders?quote=${ids[0]}`)).body.total, 1, 'filter op offerte telt mee in het totaal');
});

test('facturen: het antwoord meldt het totaal en dat de lijst niet is ingekort', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ secret: 'e'.repeat(64), db, addressFetch: createPdokFake().fetchImpl, loginDelayMs: 0 }));
  servers.push(server);
  const baas = await createLogin(base, { password: PW })('baas');
  assert.strictEqual((await baas.post('/app/api/invoices', { data: { lines: [] } })).status, 201);
  const list = (await baas.get('/app/api/invoices')).body;
  assert.deepStrictEqual([list.items.length, list.total, list.truncated], [1, 1, false]);
});
