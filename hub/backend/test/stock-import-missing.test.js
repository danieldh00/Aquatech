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
  assert.strictEqual((await klant.get(url)).status, 403, 'klant leest de voortgang niet');
  /**
   * Wacht tot de taak van deze gebruiker klaar is en geeft de stand.
   * @param {object} client De ingelogde client.
   * @returns {Promise<object>} De stand.
   */
  const finished = async (client) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const state = (await client.get(url)).body;
      if (!state.running) return state;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    throw new Error('taak liep te lang');
  };
  const started = await admin.post(url, {});
  assert.strictEqual(started.status, 202);
  const noShop = await finished(admin);
  assert.strictEqual(noShop.error.code, 'not_configured', 'zonder webshopkoppeling');
  assert.strictEqual(noShop.phase, 'mislukt', 'zonder koppeling staat de taak op mislukt');
  assert.match(noShop.message, /webshop gekoppeld/, 'en de melding staat in message');
  assert.strictEqual((await vreemd.post(url, {})).status, 202);
  assert.strictEqual((await finished(vreemd)).error.code, 'not_configured', 'andere organisatie: eigen stand en eigen koppeling');
});

test('taak: voortgang per fase en een lijst van wat is binnengehaald, een tweede start tijdens het lopen wordt geweigerd', async () => {
  const { createShopMissingJob } = require('../src/artikelen/shop-missing-job');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const job = createShopMissingJob({
    log: { warn() {} },
    syncShop: async (_tenantId, _user, options) => {
      options.onProgress({ step: 'products', done: 100 });
      options.onProgress({ step: 'variations', done: 2, total: 5 });
      options.onProgress({ step: 'toevoegen', total: 3, created: 2, skipped: 0, added: [{ code: 'A', name: 'Een' }, { code: 'B', name: 'Twee' }] });
      await gate;
      return { created: 3, skippedProducts: 1, skippedList: [{ productId: '9', sku: 'X', code: 'X', name: 'Een', reason: 'code bestaat al', url: '' }], linked: 0 };
    },
  });
  assert.strictEqual(job.start('t1', null), true);
  assert.strictEqual(job.start('t1', null), false, 'er loopt al een taak');
  const midway = job.get('t1');
  assert.strictEqual(midway.running, true);
  assert.strictEqual(midway.variationsDone, 2);
  assert.deepStrictEqual(midway.added.map((item) => item.code), ['A', 'B']);
  assert.strictEqual(job.get('t2').running, false, 'andere omgeving heeft een eigen stand');
  release();
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const done = job.get('t1');
  assert.strictEqual(done.skippedItems.length, 1, 'de overgeslagen artikelen staan met reden in de stand');
  assert.strictEqual(done.skippedItems[0].reason, 'code bestaat al');
  assert.strictEqual(done.running, false);
  assert.strictEqual(done.phase, 'klaar');
  assert.strictEqual(done.created, 3);
  assert.ok(done.message.includes('1 overgeslagen'));

  const failing = createShopMissingJob({ log: { warn() {} }, syncShop: async () => { throw new Error('geheime databasedetails'); } });
  failing.start('t1', null);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const failed = failing.get('t1');
  assert.strictEqual(failed.phase, 'mislukt');
  assert.ok(!failed.error.message.includes('geheime'), 'interne fouttekst gaat niet naar de browser');
});
