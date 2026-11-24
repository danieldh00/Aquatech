// Gasten: geen schrijfacties in het klantportaal (audit B-08) en opruimen van
// gasten zonder activiteit (audit T-11).
const test = require('node:test');
const crypto = require('node:crypto');
const assert = require('node:assert');
const express = require('express');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { registerPortalRoutes } = require('../src/uitvoering/portal');
const { registerServiceRequestRoutes } = require('../src/uitvoering/service-requests');
const Roles = require('../../frontend/shared/roles.js');
const { createClient, listen } = require('./helpers/http-client');

/**
 * Bouwt een app met de portaalroutes en de meldingroutes voor één gebruiker.
 * @param {object} user De ingelogde gebruiker.
 * @param {object[]} calls Hier komen de aanroepen van de opslag in.
 * @returns {object} De Express-app.
 */
function buildApp(user, calls) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; req.tenantId = crypto.randomUUID(); next(); });
  /**
   * Rechtencontrole zoals in de echte app.
   * @param {string} right Het recht.
   * @returns {Function} De middleware.
   */
  function requireRight(right) {
    return (req, res, next) => (Roles.can(req.user, right) ? next() : res.status(403).end());
  }
  /**
   * Laat elk verzoek door.
   * @param {object} req Het verzoek.
   * @param {object} res Het antwoord.
   * @param {Function} next Volgende stap.
   * @returns {void}
   */
  function requireJson(req, res, next) {
    next();
  }
  /**
   * Nep-instellingen.
   * @returns {object} Instellingen zonder waarden.
   */
  function settingsOf() {
    return { get: () => ({}) };
  }
  /**
   * Nep-auditlog.
   * @returns {void}
   */
  function audit() {}
  const common = { requireRight, requireJson, settingsOf, audit };
  registerPortalRoutes(app, {
    ...common,
    portal: { ownRow: () => null },
    store: { listPlans: () => [] },
    quotes: { list: () => [] },
    workorders: { list: () => [], respond: () => { calls.push('respond'); return { row: {} }; } },
  });
  registerServiceRequestRoutes(app, {
    ...common,
    requests: { create: () => { calls.push('create'); return { error: 'x', message: 'x', status: 400 }; }, addPhoto: () => { calls.push('photo'); return { error: 'x', message: 'x', status: 400 }; }, list: () => [] },
    portal: { ownRow: () => null },
    workorders: { list: () => [] },
    addressGuard: null,
  });
  return app;
}

test('B-08: een gast mag het portaal niet schrijvend gebruiken, een account wel', async () => {
  const guestCalls = [];
  const guest = await listen(buildApp({ id: crypto.randomUUID(), kind: 'gast', role: 'klant', display_name: 'Gast' }, guestCalls));
  const accountCalls = [];
  const account = await listen(buildApp({ id: crypto.randomUUID(), kind: 'account', role: 'klant', display_name: 'Klant' }, accountCalls));
  try {
    const guestClient = createClient(guest.base);
    for (const [path, body] of [['/api/portal/requests', { title: 'x' }], ['/api/portal/requests/r1/photos', {}], ['/api/portal/workorders/w1/appointment', { answer: 'bevestigd' }], ['/api/portal/invoices/i1/pay', {}]]) {
      const res = await guestClient.post(path, body);
      assert.strictEqual(res.status, 403, path);
      assert.strictEqual(res.body.error, 'account_required', path);
    }
    assert.strictEqual((await guestClient.del('/api/portal/requests/r1/photos/p1')).status, 403);
    assert.deepStrictEqual(guestCalls, [], 'de opslag is nooit aangeroepen');
    assert.strictEqual((await guestClient.get('/api/portal')).status, 200, 'lezen mag nog');

    const accountClient = createClient(account.base);
    assert.notStrictEqual((await accountClient.post('/api/portal/requests/r1/photos', {})).status, 403, 'een account komt langs de poort');
    assert.ok(accountCalls.includes('photo'));
  } finally {
    guest.server.close();
    account.server.close();
  }
});

test('T-11: gasten zonder activiteit worden opgeruimd, gasten met een plan of recente activiteit niet', async () => {
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  const staleGuest = store.createGuest(tenantId);
  const recentGuest = store.createGuest(tenantId);
  const planGuest = store.createGuest(tenantId);
  const seenGuest = store.createGuest(tenantId);
  const historyGuest = store.createGuest(tenantId);
  const account = (await store.createAccount(tenantId, { username: 'piet', role: 'klant', password: 'Tuin-Plan-2026!' })).user;
  store.savePlan(planGuest, null, { areas: [], meta: { name: 'Tuin' } }, '');
  db.prepare('UPDATE users SET created_at = ? WHERE id IN (?, ?, ?, ?)').run(old, staleGuest.id, planGuest.id, seenGuest.id, historyGuest.id);
  db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(recent, recentGuest.id);
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(recent, seenGuest.id);
  db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(old, account.id);
  store.record({ tenantId, userId: historyGuest.id, action: 'bekeken', title: 'Iets' });
  store.createSession({ tenantId, userId: staleGuest.id, via: 'user', fingerprint: '', maxMs: 3600000 });
  assert.strictEqual(store.purgeStaleGuests(tenantId, 30), 1);
  const left = db.prepare('SELECT id FROM users WHERE tenant_id = ?').all(tenantId).map((row) => row.id);
  assert.ok(!left.includes(staleGuest.id), 'oude gast weg');
  for (const keep of [recentGuest, planGuest, seenGuest, historyGuest, account]) assert.ok(left.includes(keep.id), `${keep.username} blijft`);
  assert.strictEqual(store.purgeStaleGuests(tenantId, 30), 0, 'tweede ronde: niets meer');
});
