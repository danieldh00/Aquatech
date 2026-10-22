// Meldingen: een klant meldt via het portaal een storing of onderhoud, met
// foto's; medewerkers antwoorden en maken er een werkorder van, die de klant
// daarna in zijn portaal ziet.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sitePhotoPng } = require('../src/platform/test-data');
const { forCustomer } = require('../src/uitvoering/service-requests');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 'm'.repeat(64);
const PW = 'Tuin-Plan-2026!';

async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'pim', displayName: 'Pim', role: 'planner', password: PW });
  await store.createAccount(main, { username: 'klaas', displayName: 'Klaas Jansen', role: 'klant', password: PW });
  await store.createAccount(main, { username: 'piet', displayName: 'Piet', role: 'klant', password: PW });
  const other = store.createTenant({ name: 'Blauw BV', slug: 'blauw' }).tenant;
  await store.createAccount(other.id, { username: 'bram', displayName: 'Bram', role: 'installateur', password: PW });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  const as = createLogin(base, { password: PW, extraBody: { mustChangePassword: false } });
  return { db, store, server, base, as };
}

test('klantweergave: geen interne notitie', () => {
  const out = forCustomer({ id: 'r1', subject: 'Lek', note: 'Klant is lastig', reply: 'Wij komen langs' });
  assert.deepStrictEqual(out, { id: 'r1', subject: 'Lek', reply: 'Wij komen langs' });
});

test('meldingen: klant meldt met foto, medewerker antwoordt en maakt een werkorder, klant ziet die', async () => {
  const { db, server, base, as } = await setup();
  try {
    const kees = await as('kees'), pim = await as('pim'), klaas = await as('klaas'), piet = await as('piet'), bram = await as('bram', 'blauw');
    const klaasId = (await klaas.get('/api/me')).body.user.id;

    // Installatie van Klaas: werkorder uit een geaccordeerde offerte aan zijn account.
    const data = { title: 'Aanleg', customer: { name: 'Fam. Jansen', address: 'Dorpsstraat 1\nNunspeet' },
      lines: [{ section: 'materiaal', description: 'Sproeier', qty: 4, unit: 'st', price: 20, vat: 21 }] };
    const quote = (await kees.post('/api/quotes', { data, customerId: klaasId })).body;
    await kees.put(`/api/quotes/${quote.id}`, { status: 'akkoord' });
    const inst = (await kees.post('/api/workorders', { quoteId: quote.id })).body;
    await kees.put(`/api/workorders/${inst.id}`, { status: 'gereed', data: { ...inst.data, zones: [{ name: 'Zone 1', kind: 'Gazon', parts: '4× sproeier' }] } });

    // Alleen klanten melden; medewerkers niet (en omgekeerd).
    assert.strictEqual((await kees.post('/api/portal/requests', { subject: 'x', description: 'iets aan de hand' })).status, 403);
    assert.strictEqual((await klaas.get('/api/service-requests')).status, 403);
    assert.strictEqual((await klaas.post('/api/portal/requests', { subject: 'Lek', description: 'kort' })).status, 400, 'te korte omschrijving');
    const otherInst = (await piet.post('/api/portal/requests', { subject: 'Lek', description: 'Er lekt water bij de kraan.', installationId: inst.id }));
    assert.strictEqual(otherInst.status, 400, 'installatie van een ander');

    const created = await klaas.post('/api/portal/requests', {
      kind: 'storing', urgent: true, subject: 'Zone 1 gaat niet aan', description: 'Sinds gisteren gaat zone 1 niet meer aan.',
      address: 'Dorpsstraat 1, Nunspeet', phone: '0341 000 000', preferred: 'Ochtend', installationId: inst.id,
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const r = created.body;
    assert.match(r.number, /^M-\d{4}-0001$/);
    assert.deepStrictEqual([r.status, r.urgent, r.installation.id, r.customer.name], ['nieuw', true, inst.id, 'Klaas Jansen']);

    // Foto: op inhoud gecontroleerd, alleen bij een eigen, lopende melding.
    const img = sitePhotoPng('voor', 3).toString('base64');
    assert.strictEqual((await klaas.post(`/api/portal/requests/${r.id}/photos`, { image: Buffer.from('geen foto').toString('base64') })).status, 400);
    assert.strictEqual((await piet.post(`/api/portal/requests/${r.id}/photos`, { image: img })).status, 404);
    const photo = (await klaas.post(`/api/portal/requests/${r.id}/photos`, { image: img })).body;
    assert.ok(photo.id && photo.url === `api/portal/requests/${r.id}/photos/${photo.id}`);
    const extra = (await klaas.post(`/api/portal/requests/${r.id}/photos`, { image: img })).body;
    assert.strictEqual((await klaas.del(`/api/portal/requests/${r.id}/photos/${extra.id}`)).status, 200);
    assert.strictEqual((await klaas.get(`/api/portal/requests/${r.id}/photos/${photo.id}`)).type, 'image/png');
    assert.strictEqual((await piet.get(`/api/portal/requests/${r.id}/photos/${photo.id}`)).status, 404);
    assert.strictEqual((await piet.get(`/api/portal/requests/${r.id}`)).status, 404);
    assert.deepStrictEqual((await piet.get('/api/portal')).body.requests, []);
    const stored = db.prepare('SELECT image FROM service_request_photos WHERE id = ?').get(photo.id).image;
    assert.ok(!stored.includes(img.slice(0, 40)), 'versleuteld opgeslagen');

    // Medewerker (ook een planner): overzicht, detail, andere tenant ziet niets.
    const list = (await pim.get('/api/service-requests?open=1')).body.items;
    assert.deepStrictEqual(list.map((x) => [x.id, x.photoCount]), [[r.id, 1]]);
    assert.strictEqual((await bram.get(`/api/service-requests/${r.id}`)).status, 404);
    assert.deepStrictEqual((await bram.get('/api/service-requests')).body.items, []);
    assert.strictEqual((await bram.put(`/api/service-requests/${r.id}`, { status: 'afgewezen' })).status, 404);
    assert.strictEqual((await bram.post(`/api/service-requests/${r.id}/workorder`)).status, 404);
    assert.strictEqual((await bram.get(`/api/service-requests/${r.id}/photos/${photo.id}`)).status, 404);
    assert.strictEqual((await kees.get(`/api/service-requests/${r.id}/photos/${photo.id}?thumb=1`)).type, 'image/png');

    const upd = await kees.put(`/api/service-requests/${r.id}`, { status: 'in_behandeling', reply: 'Wij komen langs.', note: 'Waarschijnlijk het ventiel' });
    assert.strictEqual(upd.status, 200);
    assert.deepStrictEqual([upd.body.status, upd.body.handledBy, upd.body.note], ['in_behandeling', 'Kees', 'Waarschijnlijk het ventiel']);
    assert.strictEqual((await kees.put(`/api/service-requests/${r.id}`, { status: 'ingepland' })).status, 400, 'ingepland volgt uit de werkorder');
    let mine = (await klaas.get(`/api/portal/requests/${r.id}`)).body;
    assert.deepStrictEqual([mine.reply, mine.note], ['Wij komen langs.', undefined], 'antwoord wel, notitie niet');

    // Werkorder maken: klantgegevens, omschrijving, zones van de installatie en de foto gaan mee.
    assert.strictEqual((await kees.post(`/api/service-requests/${r.id}/workorder`, { assigneeId: 'onbekend' })).status, 400);
    const conv = await kees.post(`/api/service-requests/${r.id}/workorder`, {});
    assert.strictEqual(conv.status, 201, JSON.stringify(conv.body));
    const wo = conv.body.workOrder;
    assert.strictEqual(conv.body.item.status, 'ingepland');
    assert.strictEqual(conv.body.photosCopied, 1);
    assert.match(wo.title, /^Storing: Zone 1 gaat niet aan$/);
    assert.ok(wo.data.instructions.includes(r.number) && wo.data.instructions.includes('Sinds gisteren'));
    assert.deepStrictEqual(wo.data.zones.map((z) => z.name), ['Zone 1']);
    assert.strictEqual(wo.quoteId, null);
    assert.strictEqual((await kees.post(`/api/service-requests/${r.id}/workorder`)).status, 409, 'maar één keer');
    assert.strictEqual((await kees.put(`/api/service-requests/${r.id}`, { status: 'nieuw' })).status, 409);
    const photos = (await kees.get(`/api/workorders/${wo.id}/photos`)).body.items;
    assert.deepStrictEqual(photos.map((p) => [p.kind, p.customerVisible]), [['voor', true]]);

    // Klant: de werkorder staat in zijn portaal (met de foto), niet bij een ander.
    const p = (await klaas.get('/api/portal')).body;
    assert.ok(p.workorders.some((w) => w.id === wo.id));
    assert.strictEqual(p.requests[0].workOrder.id, wo.id);
    const dossier = (await klaas.get(`/api/portal/workorders/${wo.id}`)).body;
    assert.ok(!JSON.stringify(dossier).includes('Sinds gisteren'), 'geen interne instructies naar de klant');
    assert.strictEqual(dossier.photos.length, 1);
    assert.strictEqual((await klaas.get(`/api/${dossier.photos[0].url.replace(/^api\//, '')}`)).type, 'image/png');
    assert.strictEqual((await piet.get(`/api/portal/workorders/${wo.id}`)).status, 404);
    await kees.put(`/api/workorders/${wo.id}`, { status: 'gepland', data: { ...wo.data, plannedDate: '2030-01-07', startTime: '09:00' } });
    assert.strictEqual((await klaas.post(`/api/portal/workorders/${wo.id}/appointment`, { answer: 'bevestigd' })).status, 200, 'afspraak bevestigen via het portaal');

    // Na het omzetten geen foto's of intrekken meer.
    assert.strictEqual((await klaas.post(`/api/portal/requests/${r.id}/photos`, { image: img })).status, 409);
    assert.strictEqual((await klaas.post(`/api/portal/requests/${r.id}/withdraw`)).status, 409);

    // Tweede melding: intrekken, daarna geen werkorder meer.
    const r2 = (await klaas.post('/api/portal/requests', { kind: 'onderhoud', subject: 'Winterklaar', description: 'Graag winterklaar maken.' })).body;
    assert.strictEqual(r2.number.slice(-4), '0002');
    assert.strictEqual(r2.urgent, false);
    mine = (await klaas.post(`/api/portal/requests/${r2.id}/withdraw`)).body;
    assert.strictEqual(mine.status, 'ingetrokken');
    assert.strictEqual((await kees.post(`/api/service-requests/${r2.id}/workorder`)).status, 409);
    assert.deepStrictEqual((await kees.get('/api/service-requests?open=1')).body.items, []);
  } finally {
    server.close();
  }
});

test('meldingen: klant kan niet onbeperkt melden', async () => {
  const { server, as } = await setup();
  try {
    const klaas = await as('klaas');
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await klaas.post('/api/portal/requests', { subject: `Melding ${i}`, description: 'Er is iets mis met de beregening.' })).status;
    assert.strictEqual(last, 429);
  } finally {
    server.close();
  }
});
