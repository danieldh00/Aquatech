const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createClient } = require('./helpers/http-client');

const SECRET = 'z'.repeat(64);

function start(db, opts = {}) {
  return new Promise((resolve) => {
    const server = createApp({ secret: SECRET, db, ...opts }).listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const plan = (name) => ({
  meta: { name, customer: 'Fam. Jansen', address: 'Dorpsstraat 1' },
  areas: [{ id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }] }],
  sprinklers: [], zones: [], elements: [],
});

// Platform met een hoofdbeheerder ('baas') in de hoofdtenant.
async function platformDb() {
  const db = openDb();
  const store = createStore(db);
  await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!' }, { platformAdmin: true });
  return db;
}


const auditRows = (db, action) => db.prepare('SELECT * FROM audit WHERE action = ? ORDER BY created_at').all(action)
  .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));

// Hoofdtenant met 'baas', tenant Groen met beheerder piet en klant kees, en een testomgeving.
async function setup() {
  const db = await platformDb();
  const { server, base } = await start(db);
  const baas = createClient(base);
  await baas.login('baas', 'Tuin-Plan-2026!');
  const groen = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: 'Gras-Pomp-2027!', mustChangePassword: false } })).body.tenant;
  const kees = (await baas.post(`/api/platform/tenants/${groen.id}/users`, { username: 'kees', displayName: 'Kees', role: 'klant', password: 'Haag-Slang-2028!', mustChangePassword: false })).body;
  const test = (await baas.post(`/api/platform/tenants/${groen.id}/environments`, { name: 'Acceptatie' })).body.tenant;
  const users = (await baas.get(`/api/platform/tenants/${groen.id}/users`)).body.items;
  const piet = users.find((u) => u.username === 'piet');
  return { db, server, base, baas, groen, test, piet, kees };
}

test('impersonatie in een testomgeving: zonder toestemming, met balk-cookie, terug in één klik', async () => {
  const { db, server, base, baas, groen, test: env, piet } = await setup();
  try {
    const out = await baas.post('/api/platform/impersonate', { userId: piet.id, tenantId: env.id, reason: 'Ticket 12' });
    assert.strictEqual(out.status, 201, JSON.stringify(out.body));
    assert.strictEqual(out.body.live, false);
    assert.ok(baas.jar.get('aquatech_imp_hint'), 'leesbare hint voor de balk');

    const me = (await baas.get('/api/me')).body;
    assert.strictEqual(me.user.username, 'piet');
    assert.strictEqual(me.tenant.id, env.id);
    assert.strictEqual(me.platformAdmin, false);
    assert.strictEqual(me.impersonation.by, 'Baas');
    assert.strictEqual(me.impersonation.live, false);
    assert.strictEqual(me.environments, 0, 'geen wisselaar tijdens impersonatie');

    // Werkt met de rechten van piet, niet als hoofdbeheerder.
    assert.strictEqual((await baas.get('/api/platform/tenants')).status, 403);
    assert.strictEqual((await baas.post('/api/environment', { tenantId: groen.id })).status, 409);
    assert.strictEqual((await baas.post('/api/support', { hours: 4 })).status, 403, 'geen toestemming namens de gebruiker');
    assert.strictEqual((await baas.post('/api/plans', { data: plan('Testplan') })).status, 201);
    const plans = db.prepare('SELECT * FROM plans WHERE tenant_id = ?').all(env.id);
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].owner_id, piet.id);

    // Auditlog: start in de testomgeving en in de hoofdtenant, met reden.
    const started = auditRows(db, 'impersonatie_gestart');
    const main = db.prepare("SELECT id FROM tenants WHERE slug = 'default'").get().id;
    assert.deepStrictEqual(started.map((r) => r.tenant_id).sort(), [env.id, main].sort());
    assert.strictEqual(started[0].detail.gebruiker, 'piet');
    assert.strictEqual(started[0].detail.reden, 'Ticket 12');

    // Terug naar het eigen account.
    assert.strictEqual((await baas.post('/api/impersonation/stop')).body.ended, true);
    const back = (await baas.get('/api/me')).body;
    assert.strictEqual(back.user.username, 'baas');
    assert.strictEqual(back.platformAdmin, true);
    assert.strictEqual(back.impersonation, null);
    assert.ok(!baas.jar.get('aquatech_imp_hint'));
    assert.strictEqual(auditRows(db, 'impersonatie_beeindigd')[0].detail.reden, 'gestopt');
    assert.strictEqual((await baas.get('/api/platform/tenants')).status, 200);
  } finally {
    server.close();
  }
});

test('impersonatie in live: alleen met toestemming van de gebruiker, intrekken stopt meteen', async () => {
  const { db, server, base, baas, groen, piet } = await setup();
  try {
    const no = await baas.post('/api/platform/impersonate', { userId: piet.id, tenantId: groen.id });
    assert.strictEqual(no.status, 403);
    assert.strictEqual(no.body.error, 'consent_required');

    const pc = createClient(base);
    await pc.login('piet', 'Gras-Pomp-2027!', 'groen');
    assert.strictEqual((await pc.get('/api/support')).body.grant, null);
    assert.strictEqual((await pc.post('/api/support', { hours: 5 })).status, 400);
    const g = await pc.post('/api/support', { hours: 1 });
    assert.strictEqual(g.status, 201);
    assert.ok(Date.parse(g.body.grant.expiresAt) - Date.now() <= 60 * 60 * 1000 + 5000);
    assert.ok((await baas.get(`/api/platform/tenants/${groen.id}/users`)).body.items.find((u) => u.id === piet.id).support);

    const ok = await baas.post('/api/platform/impersonate', { userId: piet.id, tenantId: groen.id });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(ok.body.live, true);
    assert.ok(Date.parse(ok.body.expiresAt) <= Date.parse(g.body.grant.expiresAt), 'nooit langer dan de toestemming');
    assert.strictEqual((await baas.get('/api/me')).body.user.username, 'piet');

    // Acties tijdens de impersonatie krijgen de hoofdbeheerder in het auditlog.
    await baas.post('/api/admin/users', { username: 'nieuw', displayName: 'Nieuw', role: 'installateur', password: 'Bloem-Perk-2029!', mustChangePassword: false });
    assert.strictEqual(auditRows(db, 'gebruiker_aangemaakt').at(-1).detail.impersonatie, 'baas');

    // De gebruiker ziet wie er heeft meegekeken en trekt de toestemming in.
    const seen = (await pc.get('/api/support')).body;
    assert.strictEqual(seen.recent[0].by, 'Baas');
    assert.strictEqual(seen.recent[0].endedAt, null);
    assert.strictEqual((await pc.del('/api/support')).status, 200);
    const me = (await baas.get('/api/me')).body;
    assert.strictEqual(me.user.username, 'baas');
    assert.strictEqual(me.impersonation, null);
    assert.strictEqual(auditRows(db, 'impersonatie_beeindigd')[0].detail.reden, 'toestemming_ingetrokken');
    assert.strictEqual(auditRows(db, 'support_toegang_ingetrokken').length, 1);
  } finally {
    server.close();
  }
});

test('impersonatie: verloopt vanzelf, stopt bij uitloggen en heeft grenzen', async () => {
  const { db, server, base, baas, groen, test: env, piet, kees } = await setup();
  try {
    const baasId = db.prepare("SELECT id FROM users WHERE username = 'baas'").get().id;
    // Niet als zichzelf, niet als (andere) hoofdbeheerder, niet in een vreemde omgeving.
    assert.strictEqual((await baas.post('/api/platform/impersonate', { userId: baasId, tenantId: env.id })).status, 409);
    const main = db.prepare("SELECT id FROM tenants WHERE slug = 'default'").get().id;
    assert.strictEqual((await baas.post('/api/platform/impersonate', { userId: piet.id, tenantId: main })).status, 409);
    assert.strictEqual((await baas.post('/api/platform/impersonate', { userId: 'bestaat-niet', tenantId: env.id })).status, 404);

    // Een gewone beheerder mag niet impersoneren.
    const pc = createClient(base);
    await pc.login('piet', 'Gras-Pomp-2027!', 'groen');
    assert.strictEqual((await pc.post('/api/platform/impersonate', { userId: kees.id, tenantId: env.id })).status, 403);

    // Verlopen: daarna weer de hoofdbeheerder zelf.
    assert.strictEqual((await baas.post('/api/platform/impersonate', { userId: kees.id, tenantId: env.id })).status, 201);
    assert.strictEqual((await baas.get('/api/me')).body.user.username, 'kees');
    db.prepare("UPDATE impersonations SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    assert.strictEqual((await baas.get('/api/me')).body.user.username, 'baas');
    assert.strictEqual(auditRows(db, 'impersonatie_beeindigd')[0].detail.reden, 'verlopen');

    // Uitloggen beëindigt de impersonatie; opnieuw inloggen begint als zichzelf.
    await baas.post('/api/platform/impersonate', { userId: kees.id, tenantId: env.id });
    await baas.post('/api/auth/logout');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM impersonations WHERE ended_at IS NULL').get().n, 0);
    await baas.login('baas', 'Tuin-Plan-2026!');
    assert.strictEqual((await baas.get('/api/me')).body.user.username, 'baas');

    // Een gestolen impersonatie-cookie werkt niet bij een andere sessie.
    await baas.post('/api/platform/impersonate', { userId: kees.id, tenantId: env.id });
    pc.jar.set('aquatech_imp', baas.jar.get('aquatech_imp'));
    assert.strictEqual((await pc.get('/api/me')).body.user.username, 'piet');

    // Een uitgeschakelde gebruiker kan niet (meer) worden overgenomen.
    await baas.post('/api/impersonation/stop');
    await baas.patch(`/api/platform/tenants/${groen.id}/users/${kees.id}`, { disabled: true });
    assert.strictEqual((await baas.post('/api/platform/impersonate', { userId: kees.id, tenantId: env.id })).status, 409);

    // Een testaccount (bestaat alleen in de testomgeving): zonder toestemming.
    const tester = await baas.post(`/api/platform/tenants/${env.id}/users`, { username: 'tester', displayName: 'Tester', role: 'klant', password: 'Bloem-Perk-2029!', mustChangePassword: false });
    assert.strictEqual(tester.status, 201, JSON.stringify(tester.body));
    const tc = createClient(base);
    await tc.login('tester', 'Bloem-Perk-2029!', 'groen');
    assert.strictEqual((await tc.get('/api/support')).body.applicable, false);
    assert.strictEqual((await tc.post('/api/support', { hours: 1 })).status, 409);
    assert.strictEqual((await baas.post('/api/platform/impersonate', { userId: tester.body.id, tenantId: env.id })).status, 201);
    assert.strictEqual((await baas.get('/api/me')).body.user.username, 'tester');
    await baas.post('/api/impersonation/stop');

        // Testomgeving verwijderen kan ook met impersonaties in de historie.
    assert.strictEqual((await baas.del(`/api/platform/tenants/${env.id}`)).status, 200);
  } finally {
    server.close();
  }
});
