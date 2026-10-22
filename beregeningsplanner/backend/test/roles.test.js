// Rollen: hoofdbeheerder, beheerder, installateur en klant (shared/roles.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createApp } = require('../src/server');
const Roles = require(path.join(__dirname, '..', '..', 'frontend', 'shared', 'roles.js'));
const { createLogin, listen } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';
/**
 * Maakt een leeg plan.
 * @param {string} name Naam van het plan.
 * @returns {object} De plangegevens.
 */
const plan = (name) => ({ meta: { name }, areas: [], elements: [], sprinklers: [], zones: [] });

/**
 * Hoofdtenant met beheerder, twee installateurs en een klant, plus een testserver.
 * @returns {Promise<object>} server, as (inloggen), store en tid.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'hoofd', displayName: 'Hoofd', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW });
  await store.createAccount(tid, { username: 'ina', displayName: 'Ina', role: 'installateur', password: PW });
  await store.createAccount(tid, { username: 'ivo', displayName: 'Ivo', role: 'installateur', password: PW });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ secret: 'x'.repeat(64), db }));
  const as = createLogin(base, { password: PW });
  return { server, as, store, tid };
}

test('rechten per rol; een hoofdbeheerder mag alles', () => {
  assert.ok(Roles.can({ role: 'klant', platform_admin: 1 }, 'hoofdbeheer'));
  assert.ok(Roles.can({ role: 'beheerder' }, 'beheer'));
  assert.ok(!Roles.can({ role: 'beheerder' }, 'hoofdbeheer'));
  assert.ok(Roles.can({ role: 'installateur' }, 'offertes'));
  assert.ok(!Roles.can({ role: 'installateur' }, 'beheer'));
  assert.deepStrictEqual(Roles.rightsOf({ role: 'klant' }), ['plannen', 'offertes.klant', 'portaal']);
  assert.ok(Roles.can({ role: 'gebruiker' }, 'offertes'), 'oude rolnaam = installateur');
  assert.deepStrictEqual(Roles.rightsOf({ role: 'onbekend' }), []);
});

test('API: elke rol ziet alleen wat bij die rol hoort', async () => {
  const { server, as } = await setup();
  try {
    const hoofd = await as('hoofd'), baas = await as('baas'), ina = await as('ina'), ivo = await as('ivo'), klaas = await as('klaas');
    assert.ok((await hoofd.get('/api/me')).body.rights.includes('hoofdbeheer'));
    assert.deepStrictEqual((await klaas.get('/api/me')).body.rights, ['plannen', 'offertes.klant', 'portaal']);
    assert.ok(!(await ina.get('/api/me')).body.rights.includes('beheer'));

    // Plannen: iedereen maakt eigen plannen; installateurs zien die van de organisatie.
    const p1 = (await ina.post('/api/plans', { data: plan('Tuin Ina') })).body;
    const pk = (await klaas.post('/api/plans', { data: plan('Tuin Klaas') })).body;
    assert.ok(p1.id && pk.id);
    assert.strictEqual((await ivo.get('/api/plans?all=1')).body.items.length, 2);
    assert.strictEqual((await ivo.get(`/api/plans/${p1.id}`)).status, 200);
    assert.strictEqual((await klaas.get('/api/plans?all=1')).body.items.length, 1, 'klant: alleen eigen plannen');
    assert.strictEqual((await klaas.get(`/api/plans/${p1.id}`)).status, 404);
    assert.strictEqual((await klaas.put(`/api/plans/${p1.id}`, { data: plan('x') })).status, 404);

    // Beheer: alleen beheerders (en de hoofdbeheerder).
    for (const client of [ina, klaas]) {
      for (const url of ['/api/admin/users', '/api/admin/settings', '/api/admin/history', '/api/admin/plans', '/api/admin/audit']) {
        assert.strictEqual((await client.get(url)).status, 403, url);
      }
      assert.strictEqual((await client.get('/api/platform/tenants')).status, 403);
    }
    assert.strictEqual((await baas.get('/api/admin/users')).status, 200);
    assert.strictEqual((await baas.get('/api/platform/tenants')).status, 403, 'beheerder is geen hoofdbeheerder');
    assert.strictEqual((await hoofd.get('/api/admin/users')).status, 200);
    assert.strictEqual((await hoofd.get('/api/platform/tenants')).status, 200);

    // Offertes opstellen: niet voor een klant.
    assert.strictEqual((await ina.post('/api/quotes', { data: {} })).status, 201);
    assert.strictEqual((await klaas.post('/api/quotes', { data: {} })).status, 403);
    assert.strictEqual((await klaas.get('/api/quote-customers')).status, 403);
    assert.strictEqual((await ina.put('/api/quote-profile', { profile: { hourlyRate: 1 } })).status, 403);

    // Rollen toekennen; de oude naam 'gebruiker' wordt installateur.
    const users = (await baas.get('/api/admin/users')).body.items;
    const ivoId = users.find((user) => user.username === 'ivo').id;
    assert.strictEqual((await baas.patch(`/api/admin/users/${ivoId}`, { role: 'klant' })).body.role, 'klant');
    assert.strictEqual((await ivo.get('/api/plans?all=1')).body.items.length, 0, 'rechten gelden meteen');
    assert.strictEqual((await baas.patch(`/api/admin/users/${ivoId}`, { role: 'gebruiker' })).body.role, 'installateur');
    assert.strictEqual((await baas.patch(`/api/admin/users/${ivoId}`, { role: 'koning' })).status, 400);
    assert.strictEqual((await baas.post('/api/admin/users', { username: 'kim', role: 'klant', password: PW, mustChangePassword: false })).body.role, 'klant');
  } finally {
    server.close();
  }
});

test('standaardrol planner: planning en werkorders, geen offertes; staat niet tussen de uitvoerders', async () => {
  const { server, as, store, tid } = await setup();
  try {
    await store.createAccount(tid, { username: 'pim', displayName: 'Pim', role: 'planner', password: PW });
    const pim = await as('pim'), ina = await as('ina'), klaas = await as('klaas');
    const me = (await pim.get('/api/me')).body;
    assert.deepStrictEqual(me.rights, ['werkorders', 'planning']);
    assert.strictEqual(me.user.roleLabel, 'Planner');
    assert.strictEqual((await pim.get('/api/workorders')).status, 200);
    assert.strictEqual((await pim.post('/api/workorders/bestaat-niet/schedule', { plannedDate: '2026-11-02' })).status, 404, 'mag inplannen');
    assert.strictEqual((await pim.post('/api/quotes', { data: {} })).status, 403);
    assert.strictEqual((await pim.get('/api/admin/users')).status, 403);
    assert.strictEqual((await klaas.post('/api/workorders/bestaat-niet/schedule', {})).status, 403);
    const staff = (await pim.get('/api/workorder-staff')).body.items.map((user) => user.username).sort();
    assert.deepStrictEqual(staff, ['baas', 'hoofd', 'ina', 'ivo'], 'planner voert zelf niets uit');
    assert.ok((await ina.get('/api/me')).body.rights.includes('planning'), 'installateur plant ook');
  } finally {
    server.close();
  }
});

test('Beheer > Rollen: rechten aan/uit, eigen rol, beheerder vast, verwijderen alleen zonder gebruikers', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas'), ina = await as('ina'), klaas = await as('klaas');
    assert.strictEqual((await ina.get('/api/admin/roles')).status, 403);
    const list = (await baas.get('/api/admin/roles')).body;
    assert.strictEqual(list.editable, true);
    assert.deepStrictEqual(list.items.map((role) => role.key), ['beheerder', 'installateur', 'planner', 'klant']);
    assert.strictEqual(list.items.find((role) => role.key === 'installateur').userCount, 2);

    // Installateur zonder offertes: geldt meteen; afhankelijke rechten gaan mee.
    const inst = list.items.find((role) => role.key === 'installateur');
    const patched = await baas.patch('/api/admin/roles/installateur', { rights: inst.rights.filter((right) => right !== 'offertes' && right !== 'offertes.alle') });
    assert.strictEqual(patched.status, 200);
    assert.strictEqual(patched.body.customized, true);
    assert.strictEqual((await ina.post('/api/quotes', { data: {} })).status, 403);
    assert.ok((await baas.patch('/api/admin/roles/installateur', { rights: ['uitvoerder'] })).body.rights.includes('werkorders'), 'uitvoerder heeft werkorders nodig');
    assert.strictEqual((await baas.patch('/api/admin/roles/installateur', { rights: ['portaal'] })).status, 400, 'klantrecht past niet bij medewerker');
    assert.strictEqual((await baas.patch('/api/admin/roles/installateur', { rights: ['beheer'] })).status, 400);
    assert.strictEqual((await baas.del('/api/admin/roles/installateur')).body.reset, true);
    assert.strictEqual((await ina.post('/api/quotes', { data: {} })).status, 201, 'terug naar standaard');

    // Beheerder: rechten vast, naam wel aan te passen; standaardrol niet weg.
    assert.strictEqual((await baas.patch('/api/admin/roles/beheerder', { rights: ['plannen'] })).status, 409);
    assert.strictEqual((await baas.patch('/api/admin/roles/beheerder', { label: 'Eigenaar' })).body.label, 'Eigenaar');
    assert.ok((await baas.get('/api/me')).body.rights.includes('beheer'));

    // Eigen rol: overnemen van planner, toekennen, rechten gelden; klantrol in de klantenlijst.
    const own = await baas.post('/api/admin/roles', { label: 'Werkvoorbereider', copyOf: 'planner' });
    assert.strictEqual(own.status, 201);
    assert.strictEqual(own.body.key, 'werkvoorbereider');
    assert.deepStrictEqual(own.body.rights, ['werkorders', 'planning']);
    assert.strictEqual((await baas.post('/api/admin/roles', { label: 'werkvoorbereider' })).status, 400, 'naam bestaat al');
    const kim = await baas.post('/api/admin/users', { username: 'kim', role: 'werkvoorbereider', password: PW, mustChangePassword: false });
    assert.strictEqual(kim.status, 201);
    assert.strictEqual(kim.body.roleLabel, 'Werkvoorbereider');
    const kimC = await as('kim');
    assert.deepStrictEqual((await kimC.get('/api/me')).body.rights, ['werkorders', 'planning']);
    await baas.patch('/api/admin/roles/werkvoorbereider', { rights: ['werkorders', 'planning', 'offertes'] });
    assert.strictEqual((await kimC.post('/api/quotes', { data: {} })).status, 201);
    const del = await baas.del('/api/admin/roles/werkvoorbereider');
    assert.strictEqual(del.status, 409);
    assert.strictEqual(del.body.error, 'in_use');

    const zak = await baas.post('/api/admin/roles', { label: 'Zakelijke klant', kind: 'klant', rights: ['offertes.klant', 'portaal'] });
    assert.strictEqual(zak.body.kind, 'klant');
    assert.strictEqual((await baas.post('/api/admin/roles', { label: 'Fout', kind: 'klant', rights: ['offertes'] })).status, 400);
    await baas.post('/api/admin/users', { username: 'zeeman', displayName: 'Zeeman BV', role: 'zakelijke-klant', password: PW, mustChangePassword: false });
    const customers = (await baas.get('/api/quote-customers')).body.items.map((customer) => customer.username).sort();
    assert.deepStrictEqual(customers, ['klaas', 'zeeman']);
    assert.strictEqual((await klaas.get('/api/me')).body.rights.includes('portaal'), true);

    // Auditlog.
    const actions = (await baas.get('/api/admin/audit?limit=200')).body.items.map((entry) => entry.action);
    for (const action of ['rol_aangemaakt', 'rol_gewijzigd', 'rol_teruggezet']) assert.ok(actions.includes(action), action);
  } finally {
    server.close();
  }
});
