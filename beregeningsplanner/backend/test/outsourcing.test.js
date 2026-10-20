// Opdrachten uitbesteden aan een andere organisatie: alleen met opt-in aan
// beide kanten, alleen de nodige gegevens, en de ontvanger krijgt een eigen werkorder.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');
const { placeOf, previewOf, sanitizeOutsourcing } = require('../src/outsourcing');

const SECRET = 'z'.repeat(64);
const PW = 'Tuin-Plan-2026!';

function client(base) {
  const jar = new Map();
  async function call(method, p, body) {
    const headers = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (kv.slice(i + 1)) jar.set(kv.slice(0, i), kv.slice(i + 1)); else jar.delete(kv.slice(0, i));
    }
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { /* geen JSON */ }
    return { status: res.status, body: json };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

// Platform met drie organisaties: Aquatech (hoofdtenant), Groen en Blauw.
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, org) => {
    const c = client(base);
    const r = await c.post('/api/auth/login', { username, password: PW, tenant: org });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return c;
  };
  const baas = await as('baas');
  const orgs = {};
  for (const [slug, name, admin] of [['groen', 'Groen BV', 'piet'], ['blauw', 'Blauw BV', 'bram']]) {
    const made = await baas.post('/api/platform/tenants', { name, slug, admin: { username: admin, displayName: admin, password: PW, mustChangePassword: false } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    orgs[slug] = made.body.tenant;
  }
  return { db, server, base, as, baas, orgs, main };
}

async function acceptedWorkOrder(c, extra = {}) {
  const q = (await c.post('/api/quotes', { data: { title: 'Aanleg beregening', customer: { name: 'Fam. Jansen', address: 'Dorpsstraat 1\n8071 AB Nunspeet', email: 'jansen@voorbeeld.nl', phone: '0612345678' },
    lines: [{ section: 'materiaal', code: 'PE25', description: 'PE-buis 25 mm', qty: 50, unit: 'm', price: 1.2 }, { section: 'arbeid', description: 'Sleuven graven', qty: 6, unit: 'uur', price: 55 }] } })).body;
  await c.put(`/api/quotes/${q.id}`, { status: 'akkoord' });
  const wo = (await c.post('/api/workorders', { quoteId: q.id })).body;
  const data = { ...wo.data, plannedDate: '2027-04-12', instructions: 'Sleutel ligt bij de buren (nr. 3).', crew: 'Jan en Kees', ...extra };
  return (await c.put(`/api/workorders/${wo.id}`, { data })).body;
}

test('plaats zonder straat; voorvertoning zonder klantgegevens', () => {
  assert.strictEqual(placeOf('Dorpsstraat 1\n8071 AB Nunspeet'), '8071 Nunspeet');
  assert.strictEqual(placeOf('Dorpsstraat 1, 8071AB  Nunspeet'), '8071 Nunspeet');
  assert.strictEqual(placeOf('Dorpsstraat 1, Nunspeet'), 'Nunspeet');
  assert.strictEqual(placeOf('Dorpsstraat 1'), '', 'alleen een straat geeft niets prijs');
  const p = previewOf({ title: 'Tuin', customer: { name: 'Fam. Jansen', contact: 'Jan', address: 'Dorpsstraat 1, Nunspeet', email: 'j@x.nl', phone: '06' },
    instructions: 'Sleutel onder de mat', siteNotes: 'Hond', steps: [{ title: 'Graven', hours: 4, details: 'bij Jansen' }], materials: [{ code: 'A', description: 'Buis', qty: 2, unit: 'm' }] });
  const text = JSON.stringify(p);
  for (const secret of ['Jansen', 'Dorpsstraat', 'j@x.nl', 'Sleutel', 'Hond', 'Jan"']) assert.ok(!text.includes(secret), `${secret} hoort niet in de voorvertoning`);
  assert.strictEqual(p.place, 'Nunspeet');
  assert.strictEqual(p.hours, 4);
  assert.deepStrictEqual(sanitizeOutsourcing({ send: 'ja', receive: true, region: ' Veluwe ' }), { send: false, receive: true, region: 'Veluwe' });
});

test('uitbesteden: opt-in aan beide kanten, aannemen geeft een eigen werkorder, voortgang terug', async () => {
  const { server, as, baas, orgs } = await setup();
  try {
    const kees = await as('kees');
    const mainName = (await baas.get('/api/platform/tenants')).body.items.find((t) => t.slug === 'default').name;
    const piet = await as('piet', 'groen');
    const bram = await as('bram', 'blauw');
    const wo = await acceptedWorkOrder(baas);

    // Alleen beheerders; zonder opt-in kan niets.
    assert.strictEqual((await kees.get('/api/outsourcing')).status, 403);
    assert.strictEqual((await baas.post('/api/outsourcing/offers', { workOrderId: wo.id })).body.error, 'outsourcing_off');
    await baas.put('/api/admin/settings', { outsourcing: { send: true } });
    assert.strictEqual((await baas.post('/api/outsourcing/offers', { workOrderId: wo.id })).body.error, 'no_partners', 'nog niemand ontvangt');

    // Groen en Blauw zetten ontvangen aan; Aquatech ziet ze als partner.
    await piet.put('/api/admin/settings', { outsourcing: { receive: true, region: 'Veluwe' } });
    await bram.put('/api/admin/settings', { outsourcing: { receive: true } });
    const ov = (await baas.get('/api/outsourcing')).body;
    assert.deepStrictEqual(ov.partners.map((p) => [p.name, p.region]), [['Blauw BV', ''], ['Groen BV', 'Veluwe']]);
    assert.deepStrictEqual(ov.incoming, [], 'Aquatech ontvangt zelf niet');

    // Gericht aan Groen: Blauw ziet het niet.
    assert.strictEqual((await baas.post('/api/outsourcing/offers', { workOrderId: wo.id, toTenantId: 'bestaat-niet' })).status, 400);
    const offer = await baas.post('/api/outsourcing/offers', { workOrderId: wo.id, toTenantId: orgs.groen.id, message: 'Kunnen jullie dit in april doen?', fee: 450 });
    assert.strictEqual(offer.status, 201, JSON.stringify(offer.body));
    assert.strictEqual(offer.body.receiverName, 'Groen BV');
    assert.strictEqual((await baas.post('/api/outsourcing/offers', { workOrderId: wo.id })).body.error, 'active', 'één aanbod tegelijk');
    assert.deepStrictEqual((await bram.get('/api/outsourcing')).body.incoming, []);
    assert.strictEqual((await bram.post(`/api/outsourcing/offers/${offer.body.id}/accept`)).status, 404);

    // Groen ziet alleen de voorvertoning.
    const inc = (await piet.get('/api/outsourcing')).body.incoming;
    assert.strictEqual(inc.length, 1);
    assert.strictEqual(inc[0].fromName, mainName);
    assert.strictEqual(inc[0].fee, 450);
    assert.strictEqual(inc[0].preview.place, '8071 Nunspeet');
    const text = JSON.stringify(inc);
    for (const secret of ['Jansen', 'Dorpsstraat', 'jansen@', '0612345678', 'Sleutel', 'Kees']) assert.ok(!text.includes(secret), `${secret} lekt naar Groen vóór acceptatie`);
    // En niets van de werkorders van Aquatech zelf.
    assert.deepStrictEqual((await piet.get('/api/workorders')).body.items, []);
    assert.strictEqual((await piet.get(`/api/workorders/${wo.id}`)).status, 404);

    // Ontvangen uitzetten verbergt het aanbod en blokkeert aannemen.
    await piet.put('/api/admin/settings', { outsourcing: { receive: false } });
    assert.strictEqual((await piet.post(`/api/outsourcing/offers/${offer.body.id}/accept`)).body.error, 'outsourcing_off');
    await piet.put('/api/admin/settings', { outsourcing: { receive: true } });

    // Aannemen: Groen krijgt een eigen werkorder met de klantgegevens.
    const acc = await piet.post(`/api/outsourcing/offers/${offer.body.id}/accept`);
    assert.strictEqual(acc.status, 200, JSON.stringify(acc.body));
    const mine = acc.body.workOrder;
    assert.match(mine.number, /^WO-\d{4}-0001$/);
    assert.strictEqual(mine.customer, 'Fam. Jansen');
    assert.strictEqual(mine.data.customer.phone, '0612345678');
    assert.strictEqual(mine.data.plannedDate, '2027-04-12');
    assert.strictEqual(mine.data.quoteId, '', 'geen koppeling met de offerte van een ander');
    assert.strictEqual(mine.data.crew, '', 'de ploeg van de uitbesteder gaat niet mee');
    assert.ok(mine.data.steps.length > 0 && mine.data.steps.every((s) => !s.done));
    assert.ok(!JSON.stringify(mine).includes('price'));
    assert.strictEqual(mine.status, 'gepland');
    const got = (await piet.get(`/api/workorders/${mine.id}`)).body;
    assert.strictEqual(got.outsourcing.role, 'aangenomen');
    assert.strictEqual(got.outsourcing.partner, mainName);
    assert.strictEqual((await bram.post(`/api/outsourcing/offers/${offer.body.id}/accept`)).status, 404);
    assert.strictEqual((await baas.del(`/api/outsourcing/offers/${offer.body.id}`)).status, 409, 'aangenomen: niet meer in te trekken');

    // De uitbesteder ziet de voortgang bij Groen, niet de werkorder zelf.
    const steps = got.data.steps.map((s, i) => ({ ...s, done: i === 0 }));
    await piet.put(`/api/workorders/${mine.id}`, { status: 'bezig', data: { ...got.data, steps } });
    const out = (await baas.get('/api/outsourcing')).body.outgoing[0];
    assert.strictEqual(out.status, 'geaccepteerd');
    assert.strictEqual(out.execution.status, 'bezig');
    assert.strictEqual(out.execution.progress.done, 1);
    assert.ok(!JSON.stringify(out).includes(mine.id), 'geen id van de werkorder bij Groen');
    const mark = (await baas.get(`/api/workorders/${wo.id}`)).body.outsourcing;
    assert.strictEqual(mark.role, 'uitbesteed');
    assert.strictEqual(mark.partner, 'Groen BV');
    assert.strictEqual(mark.execution.status, 'bezig');
  } finally {
    server.close();
  }
});

test('uitbesteden: open aanbod, afwijzen, intrekken en alleen tussen live-omgevingen', async () => {
  const { server, as, baas, orgs } = await setup();
  try {
    const piet = await as('piet', 'groen');
    const bram = await as('bram', 'blauw');
    await baas.put('/api/admin/settings', { outsourcing: { send: true } });
    await piet.put('/api/admin/settings', { outsourcing: { receive: true } });
    await bram.put('/api/admin/settings', { outsourcing: { receive: true } });

    // Werk in uitvoering kan niet meer worden uitbesteed.
    const busy = await acceptedWorkOrder(baas);
    await baas.put(`/api/workorders/${busy.id}`, { status: 'bezig' });
    assert.strictEqual((await baas.post('/api/outsourcing/offers', { workOrderId: busy.id })).body.error, 'status');

    // Open aanbod: Groen wijst af, Blauw ziet het nog wel en neemt het aan.
    const wo = await acceptedWorkOrder(baas);
    const offer = (await baas.post('/api/outsourcing/offers', { workOrderId: wo.id })).body;
    assert.strictEqual(offer.direct, false);
    assert.strictEqual((await piet.post(`/api/outsourcing/offers/${offer.id}/decline`, { reason: 'Vol' })).status, 200);
    assert.strictEqual((await piet.get('/api/outsourcing')).body.incoming[0].myStatus, 'afgewezen');
    assert.strictEqual((await piet.post(`/api/outsourcing/offers/${offer.id}/accept`)).status, 404, 'na afwijzen niet meer aan te nemen');
    assert.strictEqual((await bram.get('/api/outsourcing')).body.incoming[0].myStatus, 'aangeboden');
    assert.strictEqual((await bram.post(`/api/outsourcing/offers/${offer.id}/accept`)).status, 200);
    assert.strictEqual((await baas.get('/api/outsourcing')).body.outgoing[0].receiverName, 'Blauw BV');

    // Gericht aanbod afwijzen en intrekken.
    const wo2 = await acceptedWorkOrder(baas);
    const o2 = (await baas.post('/api/outsourcing/offers', { workOrderId: wo2.id, toTenantId: orgs.groen.id })).body;
    await piet.post(`/api/outsourcing/offers/${o2.id}/decline`, { reason: 'Geen tijd in april' });
    const back = (await baas.get('/api/outsourcing')).body.outgoing.find((o) => o.id === o2.id);
    assert.deepStrictEqual([back.status, back.reason], ['afgewezen', 'Geen tijd in april']);
    const o3 = (await baas.post('/api/outsourcing/offers', { workOrderId: wo2.id, toTenantId: orgs.blauw.id })).body;
    assert.strictEqual((await bram.del(`/api/outsourcing/offers/${o3.id}`)).status, 404, 'alleen de uitbesteder trekt in');
    assert.strictEqual((await baas.del(`/api/outsourcing/offers/${o3.id}`)).body.status, 'ingetrokken');
    assert.deepStrictEqual((await bram.get('/api/outsourcing')).body.incoming.filter((o) => o.id === o3.id), []);

    // Een testomgeving ziet live-organisaties niet (en andersom).
    const env = await baas.post(`/api/platform/tenants/${orgs.groen.id}/environments`, { name: 'Groen test', slug: 'groen-test' });
    assert.strictEqual(env.status, 201, JSON.stringify(env.body));
    await piet.post('/api/environment', { tenantId: env.body.tenant.id });
    await piet.put('/api/admin/settings', { outsourcing: { send: true, receive: true } });
    const t = (await piet.get('/api/outsourcing')).body;
    assert.strictEqual(t.environment, 'test');
    assert.deepStrictEqual(t.partners, []);
    assert.deepStrictEqual(t.incoming, []);
    assert.ok(!(await baas.get('/api/outsourcing')).body.partners.some((p) => p.id === env.body.tenant.id));

    // Een uitgeschakelde organisatie is geen partner meer.
    await baas.patch(`/api/platform/tenants/${orgs.blauw.id}`, { disabled: true });
    assert.deepStrictEqual((await baas.get('/api/outsourcing')).body.partners.map((p) => p.name), ['Groen BV']);
  } finally {
    server.close();
  }
});
