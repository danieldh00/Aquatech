// Artikelen importeren uit Excel (V-05): controle zonder te schrijven, nieuw/wijzigt/ongewijzigd/fout, herkennen op code,
// Nederlandse getallen, EAN-controle, beginvoorraad alleen voor nieuwe artikelen, rechten en alles-of-niets.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, listen } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, installateur, klant en een andere organisatie.
 * @returns {Promise<object>} installer, klant en other (beheerder van de andere organisatie).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'klant1', displayName: 'Klant Eén', role: 'klant', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: 'c'.repeat(64), db, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  return { installer: await as('monteur'), klant: await as('klant1'), other: await as('vreemd', 'ander') };
}

const HEADERS = ['Artikelcode', 'Omschrijving', 'Eenheid', 'Inkoopprijs', 'Verkoopprijs', 'Btw', 'EAN', 'Beginvoorraad'];

test('controle schrijft niets; verwerken maakt nieuwe artikelen en wijzigt bestaande', async () => {
  const { installer } = await setup();
  await installer.post('/app/api/stock/items', { code: 'SPR-001', name: 'Sproeier', unit: 'st', costPrice: 4, salePrice: 9 });
  const rows = [
    ['spr-001', '', '', '4,50', '9,95', '', '', '3'],
    ['SPR-002', 'Slang 25 m', 'rol', '€ 12,50', '24,95', '9', '4006381333931', '10'],
    ['SPR-003', 'Kraan', '', '', '', '', '', ''],
  ];
  const preview = await installer.post('/app/api/stock/import-excel', { headers: HEADERS, rows });
  assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));
  assert.deepStrictEqual(preview.body.counts, { nieuw: 2, wijzigt: 1, ongewijzigd: 0, fout: 0 });
  assert.deepStrictEqual(preview.body.rows[0].changes.map((change) => change.field), ['costPrice', 'salePrice']);
  assert.ok(preview.body.rows[0].warnings[0].includes('beginvoorraad'));
  const applied = await installer.post('/app/api/stock/import-excel', { headers: HEADERS, rows, apply: true });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  assert.deepStrictEqual([applied.body.created, applied.body.updated, applied.body.failed.length], [2, 1, 0]);
  const all = (await installer.get('/app/api/stock')).body;
  const items = all.items || all;
  const byCode = Object.fromEntries(items.map((item) => [item.code, item]));
  assert.strictEqual(byCode['SPR-001'].costPrice, 4.5);
  assert.strictEqual(byCode['SPR-001'].salePrice, 9.95);
  assert.strictEqual(byCode['SPR-001'].onHand, 0);
  assert.strictEqual(byCode['SPR-002'].onHand, 10);
  assert.strictEqual(byCode['SPR-002'].vatRate, 9);
  assert.strictEqual(byCode['SPR-002'].ean, '4006381333931');
  const again = await installer.post('/app/api/stock/import-excel', { headers: HEADERS, rows: rows.slice(0, 2) });
  assert.strictEqual(again.body.counts.ongewijzigd, 2);
});

test('fouten blokkeren het verwerken, behalve met skipErrors', async () => {
  const { installer } = await setup();
  const rows = [
    ['A-1', 'Goed', '', '', '', '', '', ''],
    ['A-1', 'Dubbel', '', '', '', '', '', ''],
    ['A-2', '', '', '', '', '', '', ''],
    ['A-3', 'Slechte prijs', '', 'veel', '', '', '', ''],
    ['A-4', 'Slechte EAN', '', '', '', '', '1234567890123', ''],
    ['A-5', 'Slechte btw', '', '', '', '19', '', ''],
  ];
  const blocked = await installer.post('/app/api/stock/import-excel', { headers: HEADERS, rows, apply: true });
  assert.strictEqual(blocked.status, 409);
  assert.strictEqual(blocked.body.counts.fout, 5);
  const partial = await installer.post('/app/api/stock/import-excel', { headers: HEADERS, rows, apply: true, skipErrors: true });
  assert.strictEqual(partial.body.created, 1);
  assert.strictEqual(partial.body.skipped, 5);
});

test('rechten, verplichte kolommen en scheiding tussen organisaties', async () => {
  const { installer, klant, other } = await setup();
  const rows = [['B-1', 'Artikel', '', '', '', '', '', '']];
  assert.strictEqual((await klant.post('/app/api/stock/import-excel', { headers: HEADERS, rows })).status, 403);
  assert.strictEqual((await installer.post('/app/api/stock/import-excel', { headers: ['Omschrijving'], rows: [['x']] })).status, 400);
  assert.strictEqual((await installer.post('/app/api/stock/import-excel', { headers: HEADERS, rows, apply: true })).body.created, 1);
  assert.strictEqual((await other.post('/app/api/stock/import-excel', { headers: HEADERS, rows })).body.counts.nieuw, 1);
  assert.strictEqual((await installer.get('/app/api/stock/import-excel/fields')).body.fields[0].key, 'code');
});

test('een artikel met prijsfactor houdt de factorprijs; alleen gewijzigde velden gaan naar het artikel; groot bestand past', async () => {
  const { installer } = await setup();
  const made = await installer.post('/app/api/stock/items', { code: 'F-1', name: 'Factorartikel', costPrice: 10, salePrice: 20, priceMode: 'factor', priceFactor: 2 });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const before = made.body.salePrice;
  const rows = [['F-1', 'Andere naam', '', '10', '99', '', '', '']];
  const preview = await installer.post('/app/api/stock/import-excel', { headers: HEADERS, rows });
  assert.deepStrictEqual(preview.body.rows[0].changes.map((change) => change.field), ['name']);
  assert.ok(preview.body.rows[0].warnings.some((text) => /prijsfactor/.test(text)));
  await installer.post('/app/api/stock/import-excel', { headers: HEADERS, rows, apply: true });
  const after = (await installer.get(`/app/api/stock/items/${made.body.id}`)).body;
  assert.strictEqual(after.name, 'Andere naam');
  assert.strictEqual(after.salePrice, before);
  // 1000 regels met lange omschrijvingen: geen kale 413 maar een gewone controle.
  const big = Array.from({ length: 1000 }, (_, index) => [`G-${index}`, 'Omschrijving '.repeat(20), '', '', '', '', '', '']);
  const bigPreview = await installer.post('/app/api/stock/import-excel', { headers: HEADERS, rows: big });
  assert.strictEqual(bigPreview.status, 200);
  assert.strictEqual(bigPreview.body.counts.nieuw, 1000);
});
