// Klantportaal: een klant ziet alleen zijn eigen plannen, offertes en de
// werkorders uit die offertes, zonder interne velden.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { registerPortalRoutes, customerWorkOrder } = require('../src/uitvoering/portal');
const Roles = require('../../frontend/shared/roles.js');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const SECRET = 'p'.repeat(64);
const PW = 'Tuin-Plan-2026!';


test('rollen: alleen de klant (en de hoofdbeheerder) heeft het portaal', () => {
  assert.ok(Roles.can({ role: 'klant' }, 'portaal'));
  assert.ok(!Roles.can({ role: 'installateur' }, 'portaal'));
  assert.ok(!Roles.can({ role: 'beheerder' }, 'portaal'));
  assert.ok(Roles.can({ role: 'beheerder', platform_admin: 1 }, 'portaal'));
});

test('klantweergave van een werkorder: geen uren, instructies of notities', () => {
  const wo = {
    id: 'w1', number: 'WO-2026-0001', status: 'bezig', title: 'Aanleg', address: 'Dorpsstraat 1', quoteId: 'q1', quoteNumber: 'OF-1', planId: 'p1',
    plannedDate: '2026-11-03', startTime: '08:00', assignee: { id: 'u1', displayName: 'Kees' }, updatedAt: 'x',
    progress: { steps: 2, done: 1, pct: 50, hours: 6, actualHours: 3, materials: 1, picked: 1 },
    data: {
      instructions: 'Sleutel onder de mat', siteNotes: 'Hond bijt', crew: 'Ploeg A', design: { zones: 2 },
      steps: [{ phase: 'uitvoering', title: 'Sleuven', hours: 4, actualHours: 3, done: true }, { phase: 'oplevering', title: 'Inregelen', hours: 2, done: false }],
      materials: [{ code: 'X', description: 'Sproeier', qty: 4, unit: 'st', picked: true }, { code: 'Y', description: 'Retour', qty: -1, unit: 'st' }],
      zones: [{ name: 'Zone 1', kind: 'Gazon', parts: '4× Rotator', flowLph: 900, pressureBar: 2.5 }],
      report: { notes: 'Alles werkt', completedOn: '', signedBy: '' },
    },
  };
  const out = customerWorkOrder(wo, { detail: true });
  const json = JSON.stringify(out);
  for (const secret of ['Sleutel', 'Hond', 'Ploeg A', 'actualHours', 'picked', 'flowLph', '"hours"']) assert.ok(!json.includes(secret), `geen ${secret}`);
  assert.deepStrictEqual(out.progress, { steps: 2, done: 1, pct: 50 });
  assert.strictEqual(out.installer, 'Kees');
  assert.deepStrictEqual(out.materials.map((material) => material.description), ['Sproeier'], 'geen negatieve regels');
  assert.deepStrictEqual(out.steps.map((step) => [step.title, step.done, step.phaseLabel]), [['Sleuven', true, 'Uitvoering'], ['Inregelen', false, 'Oplevering']]);
  assert.strictEqual(out.report.notes, 'Alles werkt');
  assert.strictEqual(out.appointment, undefined, 'zonder planning geen afspraakveld');
});

test('API: klant ziet eigen plannen, offertes en werkorders; anderen niet', async () => {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas Jansen', role: 'klant', password: PW });
  await store.createAccount(tid, { username: 'piet', displayName: 'Piet', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  const as = createLogin(base, { password: PW, extraBody: { mustChangePassword: false } });
  try {
    assert.strictEqual((await createClient(base).get('/api/portal')).status, 401);
    const kees = await as('kees'), klaas = await as('klaas'), piet = await as('piet');
    assert.strictEqual((await kees.get('/api/portal')).status, 403, 'medewerker heeft geen portaal');

    const klaasId = (await klaas.get('/api/me')).body.user.id;
    assert.ok((await klaas.get('/api/me')).body.rights.includes('portaal'));
    await klaas.post('/api/plans', { data: { meta: { name: 'Mijn tuin', address: 'Dorpsstraat 1' }, areas: [] } });
    await piet.post('/api/plans', { data: { meta: { name: 'Tuin Piet' }, areas: [] } });

    const data = { title: 'Aanleg beregening', customer: { name: 'Fam. Jansen', address: 'Dorpsstraat 1\nNunspeet' },
      lines: [{ section: 'materiaal', description: 'Sproeier', qty: 4, unit: 'st', price: 20, vat: 21 }, { section: 'arbeid', description: 'Sleuven graven', qty: 3, unit: 'uur', price: 55, vat: 21 }] };
    const concept = (await kees.post('/api/quotes', { data, customerId: klaasId })).body;
    let portal = (await klaas.get('/api/portal')).body;
    assert.deepStrictEqual(portal.plans.map((x) => x.title), ['Mijn tuin']);
    assert.deepStrictEqual(portal.quotes, [], 'concept is niet zichtbaar');
    assert.strictEqual(portal.contact.companyName, 'AquaTech Service');

    await kees.put(`/api/quotes/${concept.id}`, { status: 'akkoord' });
    const wo = (await kees.post('/api/workorders', { quoteId: concept.id })).body;
    await kees.put(`/api/workorders/${wo.id}`, { status: 'gepland', data: { ...wo.data, plannedDate: '2026-11-03', startTime: '08:00', instructions: 'Sleutel onder de mat' } });
    // Een werkorder van een offerte zonder klantaccount telt niet mee.
    const other = (await kees.post('/api/quotes', { data })).body;
    await kees.put(`/api/quotes/${other.id}`, { status: 'akkoord' });
    const wo2 = (await kees.post('/api/workorders', { quoteId: other.id })).body;

    portal = (await klaas.get('/api/portal')).body;
    assert.deepStrictEqual(portal.quotes.map((x) => x.number), [concept.number]);
    assert.deepStrictEqual(portal.workorders.map((x) => x.number), [wo.number]);
    assert.strictEqual(portal.workorders[0].status, 'gepland');
    assert.strictEqual(portal.workorders[0].plannedDate, '2026-11-03');
    assert.strictEqual(portal.workorders[0].startTime, '08:00');
    assert.ok(!JSON.stringify(portal).includes('Sleutel'), 'geen interne instructies');
    assert.strictEqual(portal.workorders[0].appointment.state, 'wacht', 'ingepland zonder reactie: wacht op de klant');
    assert.strictEqual((await piet.post(`/api/portal/workorders/${wo.id}/appointment`, { answer: 'bevestigd' })).status, 404);
    const response = await klaas.post(`/api/portal/workorders/${wo.id}/appointment`, { answer: 'bevestigd' });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual([response.body.appointment.state, response.body.appointment.response.name], ['bevestigd', 'Klaas Jansen']);
    assert.strictEqual((await klaas.post(`/api/portal/workorders/${wo.id}/appointment`, { answer: 'bevestigd' })).status, 409);

    const detail = await klaas.get(`/api/portal/workorders/${wo.id}`);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body.materials.length, 1);
    assert.ok(detail.body.steps.length >= 1);
    assert.deepStrictEqual(detail.body.photos, []);
    assert.strictEqual((await klaas.get(`/api/portal/workorders/${wo2.id}`)).status, 404, 'niet van deze klant');
    assert.strictEqual((await piet.get(`/api/portal/workorders/${wo.id}`)).status, 404, 'andere klant');
    const pp = (await piet.get('/api/portal')).body;
    assert.deepStrictEqual([pp.quotes.length, pp.workorders.length, pp.plans.map((x) => x.title)], [0, 0, ['Tuin Piet']]);

    // Verwijderde werkorder verdwijnt uit het portaal.
    // Afgerond: blijft zichtbaar als opleverdossier.
    await kees.put(`/api/workorders/${wo.id}`, { status: 'gereed' });
    assert.strictEqual((await klaas.get('/api/portal')).body.workorders[0].status, 'gereed');
  } finally {
    server.close();
  }
});

test('API: foto\'s en afspraak bevestigen via de optionele koppelingen', async () => {
  const user = { id: 'u1', tenant_id: 't1', display_name: 'Klaas', kind: 'account', role: 'klant' };
  const raw = { id: 'w1', tenant_id: 't1' };
  const wo = { id: 'w1', number: 'WO-1', status: 'gepland', title: 'Aanleg', address: '', progress: { steps: 0, done: 0, pct: 0 }, data: {}, appointment: { state: 'wacht', response: null } };
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; req.tenantId = 't1'; next(); });
  registerPortalRoutes(app, {
    portal: { ownRow: (tenantId, userId, id) => (tenantId === 't1' && userId === 'u1' && id === 'w1' ? raw : null) },
    store: { listPlans: () => [] },
    quotes: { list: () => [] },
    workorders: {
      list: (tenantId, { customerId }) => (tenantId === 't1' && customerId === 'u1' ? [wo] : []),
      get: (tenantId, id, options = {}) => (tenantId === 't1' && id === 'w1' && (!options.customerId || options.customerId === 'u1') ? wo : null),
      respond: (row, answer, input, meta) => {
        calls.push({ row, answer, input, meta });
        if (wo.appointment.state !== 'wacht') return { error: 'answered' };
        wo.appointment = { state: answer, response: { answer, name: input.name, reason: input.reason, at: 'nu', ip: meta.ip } };
        return { row };
      },
    },
    photos: { list: (tenantId, id, options) => (options.customerOnly ? [{ id: 'f1', kind: 'oplevering', url: 'api/portal/photos/f1' }] : []) },
    requireRight: (right) => (req, res, next) => (Roles.can(req.user, right) ? next() : res.status(403).end()),
    requireJson: (req, res, next) => next(),
    settingsOf: () => ({ get: () => ({ companyName: 'Bedrijf', iban: 'NL00GEHEIM' }) }),
    audit: () => {},
  });
  const { server, base } = await listen(app);
  const client = createClient(base);
  try {
    const portal = (await client.get('/api/portal')).body;
    assert.deepStrictEqual(portal.features, { photos: true, appointments: true, requests: false });
    assert.strictEqual(portal.workorders[0].appointment.state, 'wacht');
    assert.ok(!JSON.stringify(portal.contact).includes('GEHEIM'), 'alleen contactgegevens');
    assert.deepStrictEqual((await client.get('/api/portal/workorders/w1')).body.photos.map((photo) => photo.id), ['f1']);
    assert.strictEqual((await client.post('/api/portal/workorders/w1/appointment', { answer: 'misschien' })).status, 400);
    assert.strictEqual((await client.post('/api/portal/workorders/w9/appointment', { answer: 'bevestigd' })).status, 404);
    const ok = await client.post('/api/portal/workorders/w1/appointment', { answer: 'bevestigd' });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body.appointment, { state: 'bevestigd', response: { answer: 'bevestigd', name: 'Klaas', reason: '', at: 'nu' } }, 'geen ip naar de klant');
    assert.strictEqual(calls[0].row, raw);
    assert.strictEqual(calls[0].meta.via, 'account');
    assert.strictEqual(calls[0].meta.userId, 'u1');
    assert.strictEqual((await client.post('/api/portal/workorders/w1/appointment', { answer: 'bevestigd' })).status, 409);
  } finally {
    server.close();
  }
});
