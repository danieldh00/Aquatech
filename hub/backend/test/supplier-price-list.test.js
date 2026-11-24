// Prijslijst van de leverancier inlezen (V-30): koppelen op artikelnummer leverancier, EAN of eigen code, controle zonder te
// schrijven, voorkeursleverancier zet ook de inkoopprijs (en via de prijsfactor de verkoopprijs), backup-leverancier niet,
// onbekende artikelen worden overgeslagen, rechten en andere organisatie.
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
 * Hoofdtenant met installateur, klant en een andere organisatie, plus twee leveranciers en drie artikelen.
 * @returns {Promise<object>} installer, klant, other en de id's van leveranciers en artikelen.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'klant1', displayName: 'Klant Eén', role: 'klant', password: PW }, { mustChangePassword: false });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: 'c'.repeat(64), db, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  const installer = await as('monteur');
  const main1 = (await installer.post('/app/api/suppliers', { name: 'Hoofdleverancier' })).body;
  const backup = (await installer.post('/app/api/suppliers', { name: 'Backupleverancier' })).body;
  const itemA = (await installer.post('/app/api/stock/items', { code: 'A-1', name: 'Sproeier', costPrice: 4, salePrice: 9, ean: '4006381333931' })).body;
  const itemB = (await installer.post('/app/api/stock/items', { code: 'B-1', name: 'Slang', costPrice: 10, salePrice: 20 })).body;
  const itemC = (await installer.post('/app/api/stock/items', { code: 'C-1', name: 'Kraan', costPrice: 2, salePrice: 5 })).body;
  await installer.put(`/app/api/stock/items/${itemA.id}/suppliers`, { suppliers: [{ supplierId: main1.id, supplierSku: 'RB-4000', costPrice: 4 }] });
  await installer.put(`/app/api/stock/items/${itemB.id}/suppliers`, { suppliers: [{ supplierId: main1.id, supplierSku: 'SL-25', costPrice: 10 }, { supplierId: backup.id, supplierSku: 'X-25', costPrice: 11 }] });
  return { installer, klant: await as('klant1'), other: await as('vreemd', 'ander'), main1, backup, itemA, itemB, itemC };
}

const HEADERS = ['Artikelnummer leverancier', 'EAN', 'Artikelcode', 'Inkoopprijs', 'Bestelhoeveelheid', 'Levertijd'];

test('controle schrijft niets; verwerken wijzigt prijzen bij de voorkeursleverancier en koppelt nieuwe artikelen', async () => {
  const { installer, main1, itemA, itemC } = await setup();
  const rows = [
    ['rb-4000', '', '', '4,75', '10', '3'],
    ['', '', 'C-1', '2,40', '', ''],
    ['ONBEKEND-1', '', '', '1,00', '', ''],
  ];
  const path = `/app/api/stock/price-lists/${main1.id}`;
  const preview = await installer.post(path, { headers: HEADERS, rows });
  assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));
  assert.deepStrictEqual(preview.body.counts, { onbekend: 1, nieuw: 1, wijzigt: 1, ongewijzigd: 0, fout: 0 });
  assert.deepStrictEqual(preview.body.rows.map((row) => row.status), ['wijzigt', 'nieuw', 'onbekend']);
  assert.ok(preview.body.rows[0].changes.some((change) => change.label === 'Inkoopprijs artikel'));
  assert.strictEqual((await installer.get(`/app/api/stock/items/${itemA.id}`)).body.costPrice, 4, 'controle schrijft niets');
  const applied = await installer.post(path, { headers: HEADERS, rows, apply: true });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  assert.deepStrictEqual([applied.body.created, applied.body.updated, applied.body.itemPrices, applied.body.failed.length], [1, 1, 2, 0]);
  const itemAfter = (await installer.get(`/app/api/stock/items/${itemA.id}`)).body;
  assert.strictEqual(itemAfter.costPrice, 4.75);
  const aLinks = (await installer.get(`/app/api/stock/items/${itemA.id}/suppliers`)).body.items;
  assert.strictEqual(aLinks[0].costPrice, 4.75);
  assert.strictEqual(aLinks[0].orderQty, 10);
  assert.strictEqual(aLinks[0].leadDays, 3);
  const itemCAfter = (await installer.get(`/app/api/stock/items/${itemC.id}`)).body;
  assert.strictEqual(itemCAfter.costPrice, 2.4);
  const cLinks = (await installer.get(`/app/api/stock/items/${itemC.id}/suppliers`)).body.items;
  assert.strictEqual(cLinks.length, 1);
  assert.strictEqual(cLinks[0].preferred, true);
  const again = await installer.post(path, { headers: HEADERS, rows: rows.slice(0, 2) });
  assert.strictEqual(again.body.counts.ongewijzigd, 2);
});

test('een backup-leverancier verandert de prijs van het artikel niet; EAN en conflicten', async () => {
  const { installer, backup, itemA, itemB } = await setup();
  const path = `/app/api/stock/price-lists/${backup.id}`;
  const rows = [['X-25', '', '', '12', '', ''], ['', '4006381333931', '', '5', '', '']];
  const preview = await installer.post(path, { headers: HEADERS, rows });
  assert.deepStrictEqual(preview.body.rows.map((row) => row.status), ['wijzigt', 'nieuw']);
  assert.ok(preview.body.rows[0].warnings.some((text) => /Backup/.test(text)));
  assert.ok(preview.body.rows[1].changes.some((change) => change.to === 'nieuw (backup)'));
  await installer.post(path, { headers: HEADERS, rows, apply: true });
  assert.strictEqual((await installer.get(`/app/api/stock/items/${itemB.id}`)).body.costPrice, 10);
  assert.strictEqual((await installer.get(`/app/api/stock/items/${itemA.id}`)).body.costPrice, 4);
  const bLinks = (await installer.get(`/app/api/stock/items/${itemB.id}/suppliers`)).body.items;
  assert.strictEqual(bLinks.find((link) => link.supplierId === backup.id).costPrice, 12);
  // Tegenstrijdig, dubbel en ongeldige prijs.
  const bad = await installer.post(path, { headers: HEADERS, rows: [['X-25', '4006381333931', '', '5', '', ''], ['X-25', '', '', '6', '', ''], ['X-25', '', '', 'veel', '', '']] });
  assert.deepStrictEqual(bad.body.rows.map((row) => row.status), ['fout', 'wijzigt', 'fout']);
  const blocked = await installer.post(path, { headers: HEADERS, rows: [['X-25', '', '', 'veel', '', '']], apply: true });
  assert.strictEqual(blocked.status, 409);
});

test('rechten, onbekende leverancier, ontbrekende kolommen en andere organisatie', async () => {
  const { installer, klant, other, main1 } = await setup();
  const rows = [['RB-4000', '', '', '5', '', '']];
  assert.strictEqual((await klant.post(`/app/api/stock/price-lists/${main1.id}`, { headers: HEADERS, rows })).status, 403);
  assert.strictEqual((await other.post(`/app/api/stock/price-lists/${main1.id}`, { headers: HEADERS, rows })).status, 404);
  assert.strictEqual((await installer.post('/app/api/stock/price-lists/00000000-0000-4000-8000-000000000000', { headers: HEADERS, rows })).status, 404);
  assert.strictEqual((await installer.post(`/app/api/stock/price-lists/${main1.id}`, { headers: ['Inkoopprijs'], rows: [['5']] })).status, 400);
  assert.strictEqual((await installer.post(`/app/api/stock/price-lists/${main1.id}`, { headers: ['Artikelnummer'], rows: [['RB-4000']] })).status, 400);
  assert.strictEqual((await installer.get('/app/api/stock/price-lists/fields')).body.fields.find((field) => field.key === 'costPrice').required, true);
});
