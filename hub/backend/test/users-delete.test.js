// Gebruikers verwijderen: door een beheerder in de eigen tenant en door een hoofdbeheerder.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createApp } = require('../src/server');
const { createClient, listen, createLogin } = require('./helpers/http-client');

/** Vaste uuid's voor de koppeling, de factuur en het nieuwsbericht van de te verwijderen gebruiker. */
const GRANT_ID = '00000000-0000-4000-8000-0000000000a1';
const INVOICE_ID = '00000000-0000-4000-8000-0000000000a2';
const NEWS_ID = '00000000-0000-4000-8000-0000000000a3';

const PW = 'Tuin-Plan-2026!';
/**
 * Maakt een leeg plan.
 * @param {string} name Naam van het plan.
 * @returns {object} De plangegevens.
 */
const plan = (name) => ({ meta: { name }, areas: [], elements: [], sprinklers: [], zones: [] });

/**
 * Database met hoofdbeheerder, beheerder, installateur en klant, plus een testserver.
 * @returns {Promise<object>} server, as (inloggen), store, db, tid en ids (id per gebruikersnaam).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  const ids = {};
  for (const [username, role, platformAdmin] of [['hoofd', 'beheerder', true], ['baas', 'beheerder'], ['ina', 'installateur'], ['klaas', 'klant']]) {
    ids[username] = (await store.createAccount(tid, { username, displayName: username, role, password: PW }, { platformAdmin })).user.id;
  }
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: 'x'.repeat(64), db }));
  const as = createLogin(base, { password: PW, organizationField: 'org' });
  return { server, as, store, db, tid, ids };
}

test('beheerder verwijdert een gebruiker; plannen en offertes blijven bewaard', async () => {
  const { server, as, store, db, tid, ids } = await setup();
  try {
    const baas = await as('baas'), ina = await as('ina'), klaas = await as('klaas');
    const createdPlan = (await ina.post('/app/api/plans', { data: plan('Tuin Ina') })).body;
    const qt = (await ina.post('/app/api/quotes', { data: {} })).body;
    assert.ok(createdPlan.id && qt.id);

    // Een installateur mag niet verwijderen.
    assert.strictEqual((await klaas.del(`/app/api/admin/users/${ids.ina}`)).status, 403);
    assert.strictEqual((await ina.del(`/app/api/admin/users/${ids.klaas}`)).status, 403);

    const out = await baas.del(`/app/api/admin/users/${ids.ina}`);
    assert.strictEqual(out.status, 200);
    assert.deepStrictEqual(out.body.moved, { plans: 1, quotes: 1, work_orders: 0 });
    assert.strictEqual(store.getUser(ids.ina), null);
    assert.strictEqual((await ina.get('/app/api/me')).body.user, null, 'sessie is weg');
    assert.strictEqual((await createClient(`http://127.0.0.1:${server.address().port}`).post('/app/api/auth/login', { username: 'ina', password: PW })).status, 401);

    // Plan en offerte staan nu op naam van "Verwijderde gebruiker".
    const heir = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND username = 'verwijderd~'").get(tid);
    assert.strictEqual(heir.kind, 'systeem');
    assert.strictEqual(db.prepare('SELECT owner_id FROM plans WHERE id = ?').get(createdPlan.id).owner_id, heir.id);
    assert.strictEqual(db.prepare('SELECT owner_id FROM quotes WHERE id = ?').get(qt.id).owner_id, heir.id);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM history WHERE user_id = ?').get(ids.ina).n, 0);
    const users = (await baas.get('/app/api/admin/users')).body.items;
    assert.ok(!users.some((user) => user.username === 'ina'));
    assert.strictEqual(users.find((user) => user.username === 'verwijderd~').planCount, 1);
    const audit = (await baas.get('/app/api/admin/audit')).body.items.find((entry) => entry.action === 'gebruiker_verwijderd');
    assert.strictEqual(audit.detail.username, 'ina');

    // Nog een keer: niet gevonden. Systeemgebruikers zijn niet te verwijderen.
    assert.strictEqual((await baas.del(`/app/api/admin/users/${ids.ina}`)).status, 404);
    assert.strictEqual((await baas.del(`/app/api/admin/users/${heir.id}`)).status, 409);
  } finally {
    server.close();
  }
});

test('niet jezelf, niet de laatste beheerder en een hoofdbeheerder alleen door een hoofdbeheerder', async () => {
  const { server, as, store, tid, ids } = await setup();
  try {
    const baas = await as('baas'), hoofd = await as('hoofd');
    assert.strictEqual((await baas.del(`/app/api/admin/users/${ids.baas}`)).status, 409, 'zichzelf');
    assert.strictEqual((await baas.del(`/app/api/admin/users/${ids.hoofd}`)).status, 403, 'beheerder kan hoofdbeheerder niet verwijderen');
    assert.strictEqual((await hoofd.del(`/app/api/platform/tenants/${tid}/users/${ids.hoofd}`)).status, 409, 'zichzelf via hoofdbeheer');

    // Laatste actieve hoofdbeheerder: ook een tweede hoofdbeheerder kan die niet weghalen als die de enige actieve is.
    const tweede = (await store.createAccount(tid, { username: 'hoofd2', displayName: 'Hoofd 2', role: 'beheerder', password: PW }, { platformAdmin: true })).user;
    const h2 = await as('hoofd2');
    assert.strictEqual((await hoofd.patch(`/app/api/platform/tenants/${tid}/users/${tweede.id}`, { disabled: true })).status, 200);
    assert.strictEqual((await h2.get('/app/api/me')).body.user, null);
    // hoofd2 is uitgeschakeld; hoofd is nu de enige actieve: door de store geweigerd.
    assert.strictEqual(store.deleteAccount(tid, ids.hoofd).status, 409);
    // Een uitgeschakelde hoofdbeheerder kan wel weg.
    assert.strictEqual((await hoofd.del(`/app/api/platform/tenants/${tid}/users/${tweede.id}`)).status, 200);

    // Laatste actieve beheerder van een andere tenant.
    const klant = (await hoofd.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'gerrit', displayName: 'Gerrit', password: PW } }));
    assert.strictEqual(klant.status, 201, JSON.stringify(klant.body));
    const gt = klant.body.tenant.id;
    const gbUsers = (await hoofd.get(`/app/api/platform/tenants/${gt}/users`)).body.items;
    const gb = gbUsers.find((user) => user.username === 'gerrit');
    assert.strictEqual((await hoofd.del(`/app/api/platform/tenants/${gt}/users/${gb.id}`)).status, 409, 'laatste beheerder');
    const ext = await hoofd.post(`/app/api/platform/tenants/${gt}/users`, { username: 'gerda', displayName: 'Gerda', role: 'beheerder', password: PW });
    assert.strictEqual(ext.status, 201);
    assert.strictEqual((await hoofd.del(`/app/api/platform/tenants/${gt}/users/${gb.id}`)).status, 200);
    // Een beheerder van de hoofdtenant kan geen gebruiker van een andere tenant verwijderen.
    assert.strictEqual((await baas.del(`/app/api/admin/users/${ext.body.id}`)).status, 404);
    assert.strictEqual((await baas.del(`/app/api/platform/tenants/${gt}/users/${ext.body.id}`)).status, 403);
  } finally {
    server.close();
  }
});

test('een gebruiker met AI-koppeling, factuur en nieuwsbericht is te verwijderen (foreign keys)', async () => {
  const { server, as, db, tid, ids } = await setup();
  try {
    const baas = await as('baas');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO oauth_grants (id, tenant_id, user_id, client_id_hash, redirect_uri, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(GRANT_ID, tid, ids.klaas, 'hash', 'https://example.org/cb', now, now);
    db.prepare('INSERT INTO invoices (id, tenant_id, customer_id, data, invoice_date, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(INVOICE_ID, tid, ids.klaas, '{}', '2026-11-20', '2026-12-20', now, now);
    db.prepare('INSERT INTO news (id, tenant_id, author_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(NEWS_ID, tid, ids.klaas, 'Titel', 'Tekst', now, now);
    const out = await baas.del(`/app/api/admin/users/${ids.klaas}`);
    assert.strictEqual(out.status, 200);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ?').get(ids.klaas).n, 0, 'koppeling verdwijnt met het account');
    assert.strictEqual(db.prepare('SELECT customer_id FROM invoices WHERE id = ?').get(INVOICE_ID).customer_id, null);
    assert.strictEqual(db.prepare('SELECT author_id FROM news WHERE id = ?').get(NEWS_ID).author_id, null);
  } finally { server.close(); }
});
