// Testdata voor testomgevingen: opbouw (tuinen, offertes) en de API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb, listTables, tableColumns } = require('../src/database/db');
const { createStore } = require('../src/platform/store');

const SECRET = 'z'.repeat(64);

/**
 * Start een testserver op de gegeven database.
 * @param {object} db De database.
 * @param {object} [opts] Extra opties voor createApp.
 * @returns {Promise<{ server: import('http').Server, base: string }>} De server en zijn adres.
 */
function start(db, opts = {}) {
  return listen(createApp({ secret: SECRET, db, ...opts }));
}

/**
 * Maakt een eenvoudig plan met één gazon.
 * @param {string} name Naam van het plan.
 * @returns {object} De plangegevens.
 */
const plan = (name) => ({
  meta: { name, customer: 'Fam. Jansen', address: 'Dorpsstraat 1' },
  areas: [{ id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }] }],
  sprinklers: [], zones: [], elements: [],
});

/**
 * Platform met een hoofdbeheerder ('baas') in de hoofdtenant.
 * @returns {Promise<object>} De database.
 */
async function platformDb() {
  const db = openDb();
  const store = createStore(db);
  await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!' }, { platformAdmin: true });
  return db;
}

const { buildTestData, lawnHeads } = require('../src/platform/test-data');
const { summarize } = require('../src/platform/store');
const { createClient, listen } = require('./helpers/http-client');

test('testdata: tuinen met zones, offertes met regels en geldige gebruikersnamen', () => {
  const set = buildTestData({ slug: 'groen-test', profile: { hourlyRate: 55, vatRate: 21, validDays: 30 }, today: new Date('2026-10-18T12:00:00Z') });
  assert.deepStrictEqual(set.accounts.map((account) => account.role).sort(), ['beheerder', 'installateur', 'installateur', 'klant', 'klant', 'klant', 'klant', 'planner']);
  for (const account of set.accounts) assert.match(account.username, /^groen-test\.[a-z0-9]+$/);
  assert.ok(set.plans.length >= 6);
  for (const plan of set.plans) {
    const summary = summarize(plan.data);
    assert.ok(summary.totalM2 > 50 && summary.sprinklers > 0, plan.data.meta.name);
    assert.ok(plan.guest || set.accounts.some((account) => account.key === plan.owner));
    assert.ok(plan.review && ['concept', 'ter_controle', 'goedgekeurd'].includes(plan.review.status));
  }
  assert.ok(set.plans.filter((plan) => plan.owner !== 'klant1').every((plan) => plan.data.zones.length > 0 && plan.data.sprinklers.every((head) => head.zone)), 'zones ingedeeld');
  assert.deepStrictEqual([...new Set(set.quotes.map((quote) => quote.status))].sort(), ['afgewezen', 'akkoord', 'concept', 'verzonden']);
  for (const quote of set.quotes) {
    assert.ok(quote.data.lines.some((line) => line.section === 'materiaal') && quote.data.lines.some((line) => line.section === 'arbeid'));
    assert.ok(quote.totalIncl > quote.totalExcl && quote.totalExcl > 100);
  }
});

test('sproeiers kop-aan-kop: hoeken 90°, randen 180°, midden 360°', () => {
  const heads = lawnHeads(0, 0, 12, 12, 'rotator', 6);
  assert.strictEqual(heads.length, 9);
  assert.deepStrictEqual(heads.map((head) => head.arc).sort((left, right) => left - right), [90, 90, 90, 90, 180, 180, 180, 180, 360]);
  assert.ok(heads.every((head) => head.r === 6));
});

test('testomgeving vullen: testaccounts per rol, alleen in test, opnieuw vullen en leegmaken', async () => {
  const { server, base } = await start(await platformDb());
  try {
    const baas = createClient(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    const tenant = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!', mustChangePassword: false } })).body.tenant;
    const env = (await baas.post(`/api/platform/tenants/${tenant.id}/environments`, { name: 'Test' })).body.tenant;

    // Nooit in live, en alleen voor hoofdbeheerders.
    assert.strictEqual((await baas.post(`/api/platform/tenants/${tenant.id}/testdata`)).status, 409);
    const piet = createClient(base);
    await piet.login('piet', 'Gras-Pomp-2027!', 'groen');
    assert.strictEqual((await piet.post(`/api/platform/tenants/${env.id}/testdata`)).status, 403);

    const out = await baas.post(`/api/platform/tenants/${env.id}/testdata`);
    assert.strictEqual(out.status, 201);
    const { password, accounts, counts } = out.body;
    assert.strictEqual(accounts.length, 8);
    assert.ok(counts.plans >= 6 && counts.quotes === 6);
    /**
     * Volledige gebruikersnaam van een testaccount.
     * @param {string} suffix Achtervoegsel, bijv. klant1.
     * @returns {string} De gebruikersnaam (<slug>.<achtervoegsel>).
     */
    const usernameOf = (suffix) => accounts.find((account) => account.username.endsWith(`.${suffix}`)).username;

    // Een testklant komt direct in de testomgeving en ziet alleen het eigene.
    const klant = createClient(base);
    assert.strictEqual((await klant.login(usernameOf('klant2'), password, 'groen')).status, 200);
    const me = (await klant.get('/api/me')).body;
    assert.strictEqual(me.tenant.id, env.id);
    assert.strictEqual(me.user.role, 'klant');
    const mine = (await klant.get('/api/quotes')).body.items;
    assert.deepStrictEqual(mine.map((quote) => quote.status), ['verzonden']);
    assert.strictEqual((await klant.post(`/api/quotes/${mine[0].id}/respond`, { answer: 'afgewezen', name: 'Testklant', reason: 'test' })).status, 200, 'akkoord vraagt een handtekening; afwijzen niet');
    assert.strictEqual((await klant.get('/api/admin/users')).status, 403);

    // Klantportaal: klant1 heeft een opgeleverde werkorder, klant4 een ingeplande.
    const devries = createClient(base);
    await devries.login(usernameOf('klant1'), password, 'groen');
    const p1 = (await devries.get('/api/portal')).body;
    // Plus de werkorder uit zijn melding (winterklaar maken), ingepland.
    assert.deepStrictEqual(p1.workorders.map((workOrder) => workOrder.status).sort(), ['gepland', 'gereed']);
    assert.deepStrictEqual(p1.requests.map((request) => request.status).sort(), ['ingepland', 'nieuw']);
    assert.ok(p1.requests.every((request) => request.note === undefined), 'geen interne notitie naar de klant');
    const done = p1.workorders.find((workOrder) => workOrder.status === 'gereed');
    const dossier = (await devries.get(`/api/portal/workorders/${done.id}`)).body;
    assert.ok(dossier.report.notes && dossier.report.completedOn && dossier.steps.every((st) => st.done));
    const vanberg = createClient(base);
    await vanberg.login(usernameOf('klant4'), password, 'groen');
    const p4 = (await vanberg.get('/api/portal')).body;
    assert.deepStrictEqual(p4.workorders.map((workOrder) => workOrder.status), ['gepland']);
    assert.ok(p4.workorders[0].plannedDate > new Date().toISOString().slice(0, 10), 'afspraak in de toekomst');
    assert.strictEqual(p4.workorders[0].appointment.state, 'ander_moment', 'reactie uit de planning zichtbaar');

    // De installateur ziet alle plannen en offertes van de testomgeving.
    const inst = createClient(base);
    await inst.login(usernameOf('installateur'), password, env.slug);
    assert.strictEqual((await inst.get('/api/plans?all=1')).body.items.length, counts.plans);
    // Ter controle: de tekening zonder account en het plan van klant1; elk plan met een offerte is goedgekeurd.
    const review = (await inst.get('/api/plans?all=1&review=ter_controle')).body.items;
    assert.deepStrictEqual(review.map((plan) => plan.review.via).sort(), ['account', 'openbaar']);
    assert.strictEqual(review.find((plan) => plan.review.via === 'openbaar').owner.email, 'jansen@voorbeeld.test');
    const quoted = new Set((await inst.get('/api/quotes?all=1')).body.items.map((quote) => quote.planId));
    assert.ok((await inst.get('/api/plans?all=1')).body.items.filter((plan) => quoted.has(plan.id)).every((plan) => plan.review.status === 'goedgekeurd'));
    assert.strictEqual((await inst.get('/api/quotes?all=1')).body.items.length, 6);
    const customers = (await inst.get('/api/quote-customers')).body.items;
    assert.strictEqual(customers.length, 4, 'de testklanten om een offerte aan te koppelen');

    // De testbeheerder beheert alleen de testaccounts, nooit live.
    const bea = createClient(base);
    await bea.login(usernameOf('beheerder'), password, 'groen');
    const all = (await bea.get('/api/admin/users')).body.items;
    // Plus de gast die zonder account een tekening indiende.
    assert.deepStrictEqual(all.filter((user) => user.kind === 'gast').map((user) => user.displayName), ['Mark Jansen']);
    const users = all.filter((user) => user.kind !== 'gast').map((user) => user.username);
    assert.strictEqual(users.length, 8);
    assert.ok(!users.includes('piet'));
    // Rollen gelden voor de hele organisatie: een testaccount kan ze niet wijzigen.
    assert.strictEqual((await bea.get('/api/admin/roles')).body.editable, false);
    assert.strictEqual((await bea.patch('/api/admin/roles/planner', { label: 'X' })).status, 403);
    const pietId = (await baas.get(`/api/platform/tenants/${tenant.id}/users`)).body.items[0].id;
    assert.strictEqual((await bea.patch(`/api/admin/users/${pietId}`, { disabled: true })).status, 404);
    assert.deepStrictEqual((await bea.get('/api/environments')).body.items.map((environment) => environment.id), [env.id]);

    // Live blijft leeg; de beheerder van live ziet de testaccounts niet.
    assert.deepStrictEqual((await piet.get('/api/admin/users')).body.items.map((user) => user.username), ['piet']);
    assert.deepStrictEqual((await piet.get('/api/admin/plans')).body.items, []);
    const list = (await baas.get('/api/platform/tenants')).body.items.find((x) => x.id === tenant.id);
    assert.strictEqual(list.userCount, 1);
    assert.strictEqual(list.environments[0].userCount, 8);
    assert.strictEqual((await baas.get(`/api/platform/tenants/${env.id}/users`)).body.items.length, 8);

    // Opnieuw vullen: zelfde gebruikersnamen, nieuw wachtwoord, oude sessies weg.
    const again = await baas.post(`/api/platform/tenants/${env.id}/testdata`);
    assert.strictEqual(again.status, 201);
    assert.notStrictEqual(again.body.password, password);
    assert.strictEqual((await klant.get('/api/me')).body.user, null);
    assert.strictEqual((await createClient(base).login(usernameOf('klant2'), again.body.password, 'groen')).status, 200);

    // Leegmaken ruimt de testaccounts op.
    assert.strictEqual((await baas.post(`/api/platform/tenants/${env.id}/reset`)).status, 200);
    assert.strictEqual((await createClient(base).login(usernameOf('klant2'), again.body.password, 'groen')).status, 401);
    assert.strictEqual((await baas.get('/api/platform/tenants')).body.items.find((x) => x.id === tenant.id).environments[0].planCount, 0);
  } finally {
    server.close();
  }
});

test('testdata vult alle features: klantlinks, akkoord met handtekening, werkorders en webshop', async () => {
  const db = await platformDb();
  const { server, base } = await start(db);
  try {
    const baas = createClient(base);
    await baas.login('baas', 'Tuin-Plan-2026!');
    const tenant = (await baas.post('/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', password: 'Gras-Pomp-2027!' } })).body.tenant;
    const env = (await baas.post(`/api/platform/tenants/${tenant.id}/environments`, { name: 'Test' })).body.tenant;
    const out = await baas.post(`/api/platform/tenants/${env.id}/testdata`, { shareBase: 'https://app.voorbeeld.nl/openbaar/offerte.html' });
    assert.strictEqual(out.status, 201);
    const { password, accounts, counts } = out.body;
    assert.strictEqual(counts.links, 5);
    assert.strictEqual(counts.responses, 4);
    assert.strictEqual(counts.workOrders, 3);
    assert.strictEqual(counts.appointmentLinks, 3);
    assert.strictEqual(counts.appointments, 3);
    assert.ok(counts.products > 40);

    const inst = createClient(base);
    await inst.login(accounts.find((account) => account.username.endsWith('.installateur')).username, password, 'groen');
    const list = (await inst.get('/api/quotes?all=1')).body.items;
    assert.deepStrictEqual([...new Set(list.map((quote) => quote.status))].sort(), ['afgewezen', 'akkoord', 'concept', 'verzonden']);
    for (const item of list) {
      const quote = (await inst.get(`/api/quotes/${item.id}`)).body;
      if (quote.status === 'concept') { assert.strictEqual(quote.share.active, false); continue; }
      // De klantlink is zichtbaar voor de installateur en werkt zonder inlog.
      assert.match(quote.share.url, /^https:\/\/app\.voorbeeld\.nl\/openbaar\/offerte\.html#t=[A-Za-z0-9_-]{20,}$/);
      assert.ok(quote.share.viewCount > 0 && quote.share.sentAt);
      const pub = await fetch(`${base}/api/public/quote`, { headers: { 'X-Offerte-Token': quote.share.url.split('#t=')[1] } });
      assert.strictEqual(pub.status, 200);
      if (quote.status === 'akkoord') {
        assert.ok(quote.acceptance.signature.startsWith('data:image/png;base64,') && quote.acceptance.termsAccepted);
        assert.strictEqual((await inst.put(`/api/quotes/${quote.id}`, { data: quote.data })).status, 409, 'geaccordeerd = vast');
      }
      if (quote.status === 'afgewezen') assert.ok(quote.acceptance.reason);
    }
    assert.ok(list.length === 6);

    // Meldingen in alle stadia; één is al een (ingeplande) werkorder.
    assert.strictEqual(counts.requests, 4);
    assert.strictEqual(counts.requestWorkOrders, 1);
    const reqs = (await inst.get('/api/service-requests')).body.items;
    assert.deepStrictEqual(reqs.map((request) => request.status).sort(), ['afgehandeld', 'in_behandeling', 'ingepland', 'nieuw']);
    const fromRequest = reqs.find((request) => request.workOrder);
    assert.ok(fromRequest.installation && fromRequest.photoCount === 1);
    const all = (await inst.get('/api/workorders')).body.items;
    const service = all.filter((workOrder) => !workOrder.quoteId);
    assert.deepStrictEqual(service.map((workOrder) => [workOrder.id, workOrder.status]), [[fromRequest.workOrder.id, 'gepland']]);
    const sfull = (await inst.get(`/api/workorders/${service[0].id}`)).body;
    assert.ok(sfull.data.zones.length > 0, 'zones van de installatie gaan mee');
    assert.strictEqual((await inst.get(`/api/workorders/${service[0].id}/photos`)).body.items.length, 1, 'foto van de klant gaat mee');
    const workOrders = all.filter((workOrder) => workOrder.quoteId);
    assert.deepStrictEqual(workOrders.map((workOrder) => workOrder.status).sort(), ['bezig', 'gepland', 'gereed']);
    for (const workOrder of workOrders) {
      const full = (await inst.get(`/api/workorders/${workOrder.id}`)).body;
      assert.ok(full.assignee && full.plannedDate && full.data.zones.length > 0 && full.data.materials.length > 0);
      if (workOrder.status === 'gereed') assert.strictEqual(full.progress.pct, 100);
      if (workOrder.status === 'bezig') assert.ok(full.progress.pct > 0 && full.progress.pct < 100);
      // Afspraaklink met een reactie van de klant op het geplande moment.
      assert.match(full.share.url, /^https:\/\/app\.voorbeeld\.nl\/openbaar\/afspraak\.html#t=[A-Za-z0-9_-]{20,}$/);
      assert.strictEqual(full.appointment.response.current, true);
      const pub = await fetch(`${base}/api/public/appointment?preview=1`, { headers: { 'X-Afspraak-Token': full.share.url.split('#t=')[1] } });
      assert.strictEqual(pub.status, 200);
    }
    assert.deepStrictEqual(workOrders.map((workOrder) => workOrder.appointment.state).sort(), ['ander_moment', 'bevestigd', 'bevestigd']);

    const cat = (await inst.get('/api/catalog')).body;
    assert.ok(cat.configured && cat.syncedAt);
    assert.ok(Object.values(cat.articles).some((article) => article.via === 'mapping') && Object.values(cat.articles).some((article) => article.via === 'code'));
    assert.ok(cat.unmatched.length > 0, 'een paar artikelen staan niet in de nepwebshop');

    // Elke tabel met gegevens per tenant heeft testdata. Een nieuwe tabel?
    // Dan hoort die in test-data.js (of, als het echt geen testdata is, hier
    // in de uitzonderingen met de reden).
    const NO_TESTDATA = {
      sessions: 'ontstaan bij inloggen',
      audit: 'ontstaat vanzelf bij handelingen',
      settings: 'instellingen kiest de beheerder zelf (alleen de nepwebshop wordt gezet)',
      support_grants: 'meekijken is een handeling, geen data',
      impersonations: 'meekijken is een handeling, geen data',
      roles: 'rollen horen bij de organisatie (live-tenant); een testomgeving gebruikt die van live',
    };
    const tables = listTables(db).filter((table) => tableColumns(db, table).some((column) => column.name === 'tenant_id'));
    for (const table of tables) {
      if (NO_TESTDATA[table]) continue;
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(env.id).n;
      assert.ok(count > 0, `tabel ${table} heeft geen testdata: vul hem in test-data.js`);
    }
  } finally {
    server.close();
  }
});
