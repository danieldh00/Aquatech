// Automatische bestelvoorstellen, de bedrading rond de inkooporders: de instelling `purchaseProposals` (standaard aan,
// schoonmaken, per organisatie), de uurlijkse taak `app.locals.purchaseProposalsAll` (slaat uitgezette omgevingen,
// modules en organisaties over en vangt een fout per omgeving af) en de vergrendeling van de voorstel-routes als de
// module Artikelen uit staat. autoPropose zelf wordt hier nagebootst; die heeft zijn eigen tests.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { FIELDS, LIVE_ONLY_KEYS, sanitizePurchaseProposals } = require('../src/platform/settings');
const { FRONTEND_DIR } = require('../src/paths');
const { createLogin, listen } = require('./helpers/http-client');

const MODULES = require(path.join(FRONTEND_DIR, 'dashboard', 'modules.js'));
const SECRET = 'b'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Twee organisaties met elk een beheerder (multitenancy aan) en een testomgeving onder de hoofdtenant.
 * @returns {Promise<object>} app, store, de id's van de omgevingen en ingelogde beheerders.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const testEnvironment = store.createEnvironment(main, { name: 'Test' }).tenant;
  const app = createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, loginDelayMs: 0 });
  const { server, base } = await listen(app);
  servers.push(server);
  const as = createLogin(base, { password: PW });
  return { app, store, main, other: other.id, testId: testEnvironment.id, adminA: await as('baas'), adminB: await as('vreemd', 'ander') };
}

/**
 * Vervangt autoPropose door een nabootsing die onthoudt voor welke omgevingen hij draaide.
 * @param {object} app De app uit createApp.
 * @param {Function} [answer] Uitkomst per omgeving (standaard één nieuw voorstel).
 * @returns {string[]} De omgevingen waarvoor autoPropose werd aangeroepen.
 */
function fakeAutoPropose(app, answer = () => ({ created: 1, updated: 0, removed: 0, skipped: 0, dismissedSkipped: 0 })) {
  const calls = [];
  /**
   * Nagebootste autoPropose: onthoudt de omgeving en geeft de afgesproken uitkomst.
   * @param {string} tenantId Id van de omgeving.
   * @returns {Promise<object>} De samenvatting.
   */
  app.locals.purchaseOrders.autoPropose = async (tenantId) => {
    calls.push(tenantId);
    return answer(tenantId);
  };
  return calls;
}

test('instelling: standaard aan, alleen `enabled` als ja/nee, geen geheim en niet liveOnly', () => {
  assert.strictEqual(FIELDS.purchaseProposals.type, 'object');
  assert.deepStrictEqual(FIELDS.purchaseProposals.default, { enabled: true });
  assert.ok(!LIVE_ONLY_KEYS.includes('purchaseProposals'), 'maakt alleen concepten, gaat mee naar een testomgeving');
  assert.ok(!FIELDS.purchaseProposals.internal && !FIELDS.purchaseProposals.platform, 'gewoon in Beheer > Instellingen');
  assert.deepStrictEqual(sanitizePurchaseProposals({ enabled: false, extra: 'weg' }), { enabled: false });
  assert.deepStrictEqual(sanitizePurchaseProposals({ enabled: true }), { enabled: true });
  assert.deepStrictEqual(sanitizePurchaseProposals({ enabled: 'nee' }), { enabled: true }, 'geen ja/nee = standaard');
  assert.deepStrictEqual(sanitizePurchaseProposals(null), { enabled: true });
  assert.deepStrictEqual(sanitizePurchaseProposals([]), { enabled: true });
});

test('moduleregister: de instelling, de Beheer-sectie en de voorstel-routes horen bij Artikelen', () => {
  const stockModule = MODULES.find((module) => module.id === 'voorraad');
  assert.ok(stockModule.configuration.settings.includes('purchaseProposals'));
  assert.ok(stockModule.configuration.sections.includes('bestelvoorstellen'));
  assert.ok(stockModule.configuration.routes.includes('/api/purchase-orders/proposals'));
  assert.ok(!stockModule.configuration.routes.includes('/api/purchase-orders'), 'de gewone inkooporders blijven werken');
});

test('server: standaard aan, uitzetten geldt alleen voor de eigen organisatie', async () => {
  const { adminA, adminB } = await setup();
  assert.deepStrictEqual((await adminA.get('/app/api/admin/settings')).body.settings.purchaseProposals.value, { enabled: true });
  const off = await adminA.put('/app/api/admin/settings', { purchaseProposals: { enabled: false, onzin: 1 } });
  assert.strictEqual(off.status, 200);
  assert.deepStrictEqual(off.body.settings.purchaseProposals.value, { enabled: false }, 'andere sleutels vallen weg');
  assert.deepStrictEqual((await adminB.get('/app/api/admin/settings')).body.settings.purchaseProposals.value, { enabled: true }, 'andere organisatie ongemoeid');
  assert.strictEqual((await adminA.put('/app/api/admin/settings', { purchaseProposals: 'uit' })).status, 400);
});

test('purchaseProposalsAll: alleen omgevingen met de instelling en de module aan, uitgeschakelde organisaties niet', async () => {
  const { app, store, main, other, testId, adminA, adminB } = await setup();
  const calls = fakeAutoPropose(app);
  const all = await app.locals.purchaseProposalsAll();
  assert.deepStrictEqual(calls.sort(), [main, other, testId].sort(), 'standaard overal aan, ook in de testomgeving');
  assert.deepStrictEqual(all[main], { created: 1, updated: 0, removed: 0, skipped: 0, dismissedSkipped: 0 });

  // Instelling uit in de hoofdtenant, module uit bij de andere organisatie: alleen de testomgeving (eigen instelling) blijft.
  assert.strictEqual((await adminA.put('/app/api/admin/settings', { purchaseProposals: { enabled: false } })).status, 200);
  assert.strictEqual((await adminB.put('/app/api/admin/settings', { modules: { voorraad: false } })).status, 200);
  calls.length = 0;
  await app.locals.purchaseProposalsAll();
  assert.deepStrictEqual(calls, [testId]);

  // De testomgeving zelf uit: niets meer.
  assert.strictEqual((await adminA.post('/app/api/environment', { tenantId: testId })).status, 200);
  assert.strictEqual((await adminA.put('/app/api/admin/settings', { purchaseProposals: { enabled: false } })).status, 200);
  calls.length = 0;
  assert.deepStrictEqual(await app.locals.purchaseProposalsAll(), {});
  assert.deepStrictEqual(calls, []);

  // Module weer aan bij de andere organisatie, maar de organisatie uitgeschakeld: overgeslagen.
  assert.strictEqual((await adminB.put('/app/api/admin/settings', { modules: { voorraad: true } })).status, 200);
  store.updateTenant(other, { disabled: true });
  await app.locals.purchaseProposalsAll();
  assert.deepStrictEqual(calls, []);
  store.updateTenant(other, { disabled: false });
  await app.locals.purchaseProposalsAll();
  assert.deepStrictEqual(calls, [other]);
});

test('purchaseProposalsAll: een fout in één omgeving stopt de rest niet; zonder wijziging geen regel', async () => {
  const { app, main, other, testId } = await setup();
  fakeAutoPropose(app, (tenantId) => {
    if (tenantId === main) throw new Error('kapot');
    if (tenantId === testId) return { created: [], updated: [], removed: [], skipped: 3, dismissedSkipped: 1 };
    return { created: 0, updated: ['io-1'], removed: 0, skipped: 0, dismissedSkipped: 0 };
  });
  const originalError = console.error;
  /** Houdt de verwachte foutmelding uit de testuitvoer. */
  console.error = () => {};
  let summary;
  try {
    summary = await app.locals.purchaseProposalsAll();
  } finally {
    console.error = originalError;
  }
  assert.deepStrictEqual(summary[main], { error: 'kapot' });
  assert.deepStrictEqual(summary[other].updated, ['io-1'], 'de volgende omgeving draaide gewoon');
  assert.strictEqual(summary[testId], undefined, 'niets veranderd = niet in de samenvatting');
});

test('purchaseProposalsAll: zonder autoPropose (nog niet gebouwd) een lege uitkomst', async () => {
  const { app } = await setup();
  app.locals.purchaseOrders.autoPropose = undefined;
  assert.deepStrictEqual(await app.locals.purchaseProposalsAll(), {});
});

test('server: met de module Artikelen uit geven schrijfacties op de voorstel-routes 409 module_off', async () => {
  const { adminA } = await setup();
  assert.strictEqual((await adminA.put('/app/api/admin/settings', { modules: { voorraad: false } })).status, 200);
  for (const [method, url] of [['post', '/app/api/purchase-orders/proposals/run'], ['post', '/app/api/Purchase-Orders/Proposals/x/dismiss'], ['del', '/app/api/purchase-orders/proposals/x']]) {
    const response = await adminA[method](url, {});
    assert.strictEqual(response.status, 409, `${method} ${url}`);
    assert.strictEqual(response.body.error, 'module_off', `${method} ${url}`);
  }
  // De instelling zelf is dan ook vergrendeld; lezen van inkooporders blijft kunnen.
  const locked = await adminA.put('/app/api/admin/settings', { purchaseProposals: { enabled: false } });
  assert.strictEqual(locked.status, 409);
  assert.strictEqual(locked.body.field, 'purchaseProposals');
  assert.notStrictEqual((await adminA.get('/app/api/purchase-orders')).status, 409);
});

test('app: de uurlijkse taak en de inkooporders staan klaar voor main', async () => {
  const { app } = await setup();
  assert.strictEqual(typeof app.locals.purchaseProposalsAll, 'function');
  assert.ok(app.locals.purchaseOrders, 'inkooporders bereikbaar voor de taak');
});
