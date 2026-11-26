// Ontbrekende webshopproducten toevoegen (tijdelijke knop in Artikelen): de route weigert zonder login of zonder recht en zonder webshopkoppeling.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, createClient, listen } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

test('ontbrekende webshopproducten toevoegen: rechten, tenantgrens en zonder koppeling', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'klant1', displayName: 'Klant', role: 'klant', password: PW, mustChangePassword: false });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: 'f'.repeat(64), db }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  const admin = await as('baas');
  const klant = await as('klant1');
  const vreemd = await as('vreemd', 'ander');
  const url = '/app/api/stock/import-shop-missing';
  assert.strictEqual((await createClient(base).post(url, {})).status, 401, 'niet ingelogd');
  assert.strictEqual((await klant.post(url, {})).status, 403, 'klant heeft geen recht');
  const noShop = await admin.post(url, {});
  assert.strictEqual(noShop.status, 409, 'zonder webshopkoppeling');
  assert.strictEqual(noShop.body.error, 'not_configured');
  assert.strictEqual((await vreemd.post(url, {})).status, 409, 'andere organisatie: eigen (ontbrekende) koppeling, geen gegevens van de hoofdorganisatie');
});
