// Offertesjablonen: opschonen en de API (kiezen voor medewerkers, bewaren en verwijderen alleen door de beheerder).
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeQuoteTemplates, upsertTemplate, MAX_TEMPLATES, MAX_TEMPLATE_LINES } = require('../src/verkoop/quote-templates');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const PASSWORD = 'Tuin-Plan-2026!';

test('opschonen: naam verplicht, notities en keuze eruit, dubbele namen vallen weg', () => {
  const result = sanitizeQuoteTemplates({ templates: [
    { name: ' Standaard ', intro: 'Hallo', lines: [{ description: 'Voorrijkosten', qty: 1, price: 35, note: 'intern', selected: true, optional: true }] },
    { name: 'standaard', intro: 'dubbel' },
    { name: '', intro: 'zonder naam' },
    { name: 'Leeg' },
    'rommel',
  ] });
  assert.deepStrictEqual(result.templates.map((template) => template.name), ['Standaard']);
  const line = result.templates[0].lines[0];
  assert.strictEqual(line.note, '');
  assert.strictEqual(line.selected, false);
  assert.strictEqual(line.optional, true);
  assert.deepStrictEqual(sanitizeQuoteTemplates(null), { templates: [] });
});

test('bewaren: dezelfde naam vervangt, een nieuwe naam komt erbij, het maximum geldt', () => {
  const first = upsertTemplate({ templates: [] }, { name: 'A', terms: 'x' });
  const again = upsertTemplate(first.config, { name: 'a', terms: 'y' });
  assert.strictEqual(again.config.templates.length, 1);
  assert.strictEqual(again.config.templates[0].id, first.template.id);
  assert.strictEqual(again.config.templates[0].terms, 'y');
  assert.strictEqual(upsertTemplate(first.config, { name: 'B' }).error, 'invalid_template');
  const full = { templates: Array.from({ length: MAX_TEMPLATES }, (_, i) => ({ id: `id-${String(i).padStart(6, '0')}`, name: `T${i}`, intro: 'x', terms: '', lines: [] })) };
  assert.strictEqual(upsertTemplate(full, { name: 'Nieuw', intro: 'x' }).error, 'too_many');
});

/**
 * Twee organisaties met beheerder, medewerker en klant, plus een testserver.
 * @returns {Promise<object>} server, base, as en de tenant-id's.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PASSWORD });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PASSWORD });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PASSWORD });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: 'z'.repeat(64), db }));
  return { server, base, as: createLogin(base, { password: PASSWORD }), store, tid };
}

test('bewaren: meer regels dan het maximum geeft een fout in plaats van stil afkappen', () => {
  const lines = Array.from({ length: MAX_TEMPLATE_LINES + 1 }, (_, i) => ({ description: `Regel ${i}`, qty: 1, price: 1 }));
  assert.strictEqual(upsertTemplate({ templates: [] }, { name: 'Groot', lines }).error, 'too_many_lines');
  assert.strictEqual(upsertTemplate({ templates: [] }, { name: 'Past', lines: lines.slice(0, MAX_TEMPLATE_LINES) }).template.lines.length, MAX_TEMPLATE_LINES);
});

test('API: sjablonen kiezen door medewerkers, bewaren en verwijderen door de beheerder', async () => {
  const { server, base, as } = await setup();
  try {
    assert.strictEqual((await createClient(base).get('/app/api/quote-templates')).status, 401);
    const baas = await as('baas'), kees = await as('kees'), klaas = await as('klaas');
    assert.strictEqual((await klaas.get('/app/api/quote-templates')).status, 403, 'een klant ziet de sjablonen niet');
    assert.deepStrictEqual((await kees.get('/app/api/quote-templates')).body.templates, []);
    const template = { name: 'Aanleg gazon', intro: 'Intro', terms: 'Voorwaarden', lines: [{ section: 'arbeid', description: 'Montage', qty: 2, unit: 'uur', price: 55, vat: 21 }] };
    assert.strictEqual((await kees.put('/app/api/quote-templates', { template })).status, 403);
    assert.strictEqual((await klaas.put('/app/api/quote-templates', { template })).status, 403);
    const saved = await baas.put('/app/api/quote-templates', { template });
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.body.templates.length, 1);
    assert.strictEqual((await baas.put('/app/api/quote-templates', { template: { name: '' } })).status, 400);
    const listed = (await kees.get('/app/api/quote-templates')).body.templates;
    assert.strictEqual(listed[0].lines[0].price, 55);
    assert.strictEqual((await kees.del(`/app/api/quote-templates/${listed[0].id}`)).status, 403);
    assert.strictEqual((await baas.del('/app/api/quote-templates/bestaat-niet')).status, 404);
    assert.strictEqual((await baas.del(`/app/api/quote-templates/${listed[0].id}`)).status, 200);
    assert.deepStrictEqual((await kees.get('/app/api/quote-templates')).body.templates, []);
  } finally {
    server.close();
  }
});

test('API: sjablonen staan niet in de algemene instellingen', async () => {
  const { server, as } = await setup();
  try {
    const baas = await as('baas');
    await baas.put('/app/api/quote-templates', { template: { name: 'Eigen', intro: 'x' } });
    const response = await baas.get('/app/api/admin/settings');
    assert.strictEqual(response.status, 200);
    assert.ok(!JSON.stringify(response.body).includes('quoteTemplates'), 'internal: alleen via de eigen route');
  } finally {
    server.close();
  }
});

test('API: een andere organisatie ziet de sjablonen niet en kan ze niet verwijderen', async () => {
  const { server, as, store } = await setup();
  try {
    const baas = await as('baas');
    const saved = await baas.put('/app/api/quote-templates', { template: { name: 'Eigen', intro: 'x' } });
    const templateId = saved.body.templates[0].id;
    const otherTenant = store.createTenant({ name: 'Andere', slug: 'andere' }).tenant.id;
    await store.createAccount(otherTenant, { username: 'ander', displayName: 'Ander', role: 'beheerder', password: PASSWORD });
    const other = await as('ander', 'andere');
    assert.deepStrictEqual((await other.get('/app/api/quote-templates')).body.templates, []);
    assert.strictEqual((await other.del(`/app/api/quote-templates/${templateId}`)).status, 404);
    assert.strictEqual((await baas.get('/app/api/quote-templates')).body.templates.length, 1, 'het sjabloon van de eerste organisatie staat er nog');
  } finally {
    server.close();
  }
});
