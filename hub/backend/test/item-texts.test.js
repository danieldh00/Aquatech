// Producttekst door de AI (artikelen/item-text-*.js): feitencontrole, schrijver, concepten en goedkeuren, limieten en rechten.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { buildFacts, checkText } = require('../src/artikelen/item-text-check');
const { createItemTextWriter, validate } = require('../src/artikelen/item-text-writer');
const { AnalyzeError } = require('../src/beregening/plan-analyzer');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Een artikelrij zoals de opslag hem geeft, met overschrijfbare velden.
 * @param {object} [extra] Velden die de standaardrij overschrijven.
 * @returns {object} De rij.
 */
const row = (extra = {}) => ({ name: 'PE-buis 25 mm', code: 'PE25', unit: 'm', brand: 'Rainpro', ean: '', description: '', specifications: JSON.stringify([{ name: 'Materiaal', value: 'Polyetheen' }, { name: 'Druk', value: 'PN10' }, { name: 'Lengte rol', value: '100 m' }]), seo_title: '', seo_description: '', ...extra });

test('feitencontrole: getallen en eenheden uit de bron zijn goed, afwijkingen worden gemeld', () => {
  const facts = buildFacts(row(), 'Buizen');
  assert.strictEqual(facts.thin, false);
  assert.deepStrictEqual(checkText({ description: 'PE-buis van 25 mm in een rol van 100 m, PN10. Materiaal: polyetheen.' }, facts.sourceText), []);
  // Schrijfwijzen: 25mm, 25,0? nee: 25mm en 100 meter zijn gelijk aan de bron.
  assert.deepStrictEqual(checkText({ description: '25mm buis, 100 meter per rol.' }, facts.sourceText), []);
  const wrongNumber = checkText({ description: 'Rol van 50 m.' }, facts.sourceText);
  assert.deepStrictEqual(wrongNumber.map((warning) => [warning.kind, warning.text]), [['number', '50 m']]);
  const wrongUnit = checkText({ seoTitle: 'PE-buis 25 cm' }, facts.sourceText);
  assert.deepStrictEqual(wrongUnit.map((warning) => [warning.kind, warning.field]), [['unit', 'seoTitle']]);
  const plainNumber = checkText({ description: 'Past op 3 aansluitingen.' }, facts.sourceText);
  assert.strictEqual(plainNumber[0].kind, 'number');
  const claims = checkText({ description: 'KIWA-gecertificeerd, 10 jaar garantie en waterdicht.' }, facts.sourceText).map((warning) => warning.kind + ':' + warning.text);
  assert.ok(claims.includes('claim:KIWA') && claims.includes('claim:garantie') && claims.includes('claim:waterdicht') && claims.includes('number:10'));
  assert.strictEqual(checkText({ description: 'Meer op https://voorbeeld.nl of info@voorbeeld.nl' }, facts.sourceText).filter((warning) => warning.kind === 'link').length, 1);
});

test('feitencontrole: decimalen met komma of punt en duizendtallen', () => {
  const facts = buildFacts(row({ name: 'Klep 2,5 bar', specifications: JSON.stringify([{ name: 'Debiet', value: '1.200 l/u' }]) }));
  assert.deepStrictEqual(checkText({ description: 'Werkdruk 2.5 bar en 1200 l' }, facts.sourceText), []);
  assert.strictEqual(checkText({ description: 'Werkdruk 2,6 bar' }, facts.sourceText).length, 1);
});

test('feitencontrole: een artikel met alleen een naam is dun, claims uit de bron blijven toegestaan', () => {
  const thin = buildFacts({ name: 'Klep', code: 'K1', unit: 'st', specifications: '[]' });
  assert.strictEqual(thin.thin, true);
  const withClaim = buildFacts(row({ description: 'Geleverd met 2 jaar garantie.' }));
  assert.deepStrictEqual(checkText({ description: 'Met 2 jaar garantie.' }, withClaim.sourceText), []);
});

test('schrijver: antwoord opschonen, fouten vertalen', async () => {
  const cleaned = validate({ description: 'Tekst <b>vet</b> zie https://x.nl', seoTitle: 'T'.repeat(200), seoDescription: 'D'.repeat(400), notes: 'n' });
  assert.ok(!cleaned.description.includes('<') && !cleaned.description.includes('https'));
  assert.ok(cleaned.seoTitle.length <= 70 && cleaned.seoDescription.length <= 160);
  /**
   * Nep-AI-client die het opgegeven bericht teruggeeft.
   * @param {object} message Het antwoord.
   * @returns {object} De client.
   */
  const clientWith = (message) => ({ messages: { stream: () => ({ finalMessage: async () => message }) } });
  const ok = createItemTextWriter({ client: clientWith({ model: 'm', usage: {}, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ description: 'Buis.', seoTitle: 'Buis', seoDescription: 'Een buis.', notes: '' }) }] }) });
  assert.strictEqual((await ok.write({ fields: [{ label: 'Naam', value: 'Buis' }] })).description, 'Buis.');
  const empty = createItemTextWriter({ client: clientWith({ model: 'm', usage: {}, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ description: '', seoTitle: '', seoDescription: '', notes: '' }) }] }) });
  await assert.rejects(empty.write({ fields: [] }), (error) => error instanceof AnalyzeError && error.code === 'invalid_output');
  const broken = createItemTextWriter({ client: clientWith({ model: 'm', usage: {}, stop_reason: 'end_turn', content: [{ type: 'text', text: 'geen json' }] }) });
  await assert.rejects(broken.write({ fields: [] }), (error) => error.code === 'invalid_output');
  const refused = createItemTextWriter({ client: clientWith({ model: 'm', usage: {}, stop_reason: 'refusal', content: [] }) });
  await assert.rejects(refused.write({ fields: [] }), (error) => error.code === 'refusal');
  await assert.rejects(createItemTextWriter({}).write({ fields: [] }), (error) => error.code === 'not_configured');
});

/**
 * Testserver met een nep-schrijver waarvan het gedrag per artikelnaam instelbaar is.
 * @param {Function} behave Krijgt { fields } en geeft de teksten, of gooit een fout.
 * @returns {Promise<object>} server, as, calls, store, db.
 */
async function setup(behave) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const calls = { count: 0 };
  /**
   * Nep-schrijver.
   * @returns {object} De schrijver.
   */
  const createItemTextWriterFake = () => ({
    available: true, model: 'test-model',
    /**
     * Schrijft "de tekst" volgens het opgegeven gedrag.
     * @param {object} input De bronvelden.
     * @returns {Promise<object>} De teksten met model en verbruik.
     */
    async write(input) { calls.count += 1; return { notes: '', ...(await behave(input)), model: 'test-model', usage: { input_tokens: 100, output_tokens: 50 } }; },
  });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db, anthropicApiKey: 'sk-ant-test-test-test-test', createItemTextWriter: createItemTextWriterFake }));
  return { server, calls, store, db, as: createLogin(base, { password: PW }) };
}

/**
 * Nep-gedrag: een nette tekst, met een afwijkend getal als de naam "FOUT" bevat, een fout bij "KAPOT".
 * @param {{ fields: { label: string, value: string }[] }} input De bronvelden.
 * @returns {object} De teksten.
 */
function behaviour(input) {
  const name = input.fields.find((field) => field.label === 'Naam').value;
  if (name.includes('KAPOT')) throw new AnalyzeError('api_error', 'De AI-dienst is stuk.', 502);
  if (name.includes('LEEG')) throw new AnalyzeError('no_credit', 'Tegoed op.', 402);
  return { description: name.includes('FOUT') ? 'Buis voor 40 bar werkdruk.' : `${name}, geleverd per meter.`, seoTitle: name, seoDescription: `${name} bij AquaTech.` };
}

test('producttekst: genereren, fouten en afwijkingen, aanpassen en goedkeuren', async () => {
  const { server, calls, as } = await setup(behaviour);
  try {
    const baas = await as('baas');
    const good = (await baas.post('/app/api/stock/items', { code: 'G1', name: 'Buis 25 mm', unit: 'm' })).body;
    const bad = (await baas.post('/app/api/stock/items', { code: 'F1', name: 'Buis FOUT 25 mm', unit: 'm' })).body;
    const broken = (await baas.post('/app/api/stock/items', { code: 'K1', name: 'Buis KAPOT', unit: 'm' })).body;
    const list = await baas.get('/app/api/stock/item-texts');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.items.length, 3);
    assert.strictEqual(list.body.ai.enabled, true);
    // Een deel mislukt: de rest wordt wel bewaard.
    const run = await baas.post('/app/api/stock/item-texts/generate', { itemIds: [good.id, bad.id, broken.id, 'bestaat-niet'] });
    assert.strictEqual(run.status, 200, JSON.stringify(run.body));
    assert.deepStrictEqual(run.body.results.map((result) => [result.status, result.code || '']), [['ok', ''], ['ok', ''], ['error', 'api_error'], ['error', 'not_found']]);
    assert.strictEqual(calls.count, 3);
    const goodDetail = (await baas.get(`/app/api/stock/item-texts/${good.id}`)).body;
    assert.deepStrictEqual(Object.keys(goodDetail.ai).sort(), ['batchSize', 'configured', 'enabled', 'remainingToday'], 'het artikelscherm krijgt de AI-status mee');
    assert.strictEqual(goodDetail.draft.description, 'Buis 25 mm, geleverd per meter.');
    assert.deepStrictEqual(goodDetail.draft.warnings.map((warning) => warning.kind), ['thin']);
    const badDetail = (await baas.get(`/app/api/stock/item-texts/${bad.id}`)).body;
    assert.ok(badDetail.draft.warnings.some((warning) => warning.kind === 'number' && warning.text === '40 bar'));
    // Live tekst is nog niet veranderd.
    assert.strictEqual(badDetail.live.description, '');
    // Zonder bevestiging van de waarschuwingen gaat niets live.
    const blocked = await baas.post('/app/api/stock/item-texts/approve', { itemIds: [bad.id] });
    assert.strictEqual(blocked.body.results[0].status, 'warnings');
    assert.strictEqual((await baas.get(`/app/api/stock/item-texts/${bad.id}`)).body.live.description, '');
    // De gebruiker verbetert het getal; dan blijft alleen de waarschuwing voor weinig gegevens.
    const fixed = await baas.put(`/app/api/stock/item-texts/${bad.id}`, { description: 'Buis van 25 mm.', seoTitle: 'Buis 25 mm', seoDescription: 'Buis 25 mm bij AquaTech.' });
    assert.strictEqual(fixed.status, 200);
    assert.deepStrictEqual(fixed.body.draft.warnings.map((warning) => warning.kind), ['thin']);
    assert.strictEqual((await baas.put(`/app/api/stock/item-texts/${bad.id}`, { description: '', seoTitle: '' })).status, 400);
    const approved = await baas.post('/app/api/stock/item-texts/approve', { itemIds: [good.id, bad.id], acknowledgeWarnings: true });
    assert.deepStrictEqual(approved.body.results.map((result) => result.status), ['approved', 'approved']);
    const live = (await baas.get(`/app/api/stock/item-texts/${bad.id}`)).body;
    assert.strictEqual(live.live.description, 'Buis van 25 mm.');
    assert.strictEqual(live.draft, null);
    assert.strictEqual((await baas.post('/app/api/stock/item-texts/approve', { itemIds: [bad.id], acknowledgeWarnings: true })).body.results[0].status, 'not_found');
    // Verbruik staat in het kostenoverzicht.
    assert.ok(JSON.stringify((await baas.get('/app/api/admin/ai-usage')).body).includes('product_tekst'));
  } finally { server.close(); }
});

test('producttekst: veranderde live tekst, overslaan van bestaande concepten, afwijzen, subartikelen en grenzen', async () => {
  const { server, calls, as } = await setup(behaviour);
  try {
    const baas = await as('baas');
    const item = (await baas.post('/app/api/stock/items', { code: 'G2', name: 'Klep 3/4 inch', unit: 'st', brand: 'Rainpro' })).body;
    await baas.post('/app/api/stock/item-texts/generate', { itemIds: [item.id] });
    const second = await baas.post('/app/api/stock/item-texts/generate', { itemIds: [item.id], skipExisting: true });
    assert.deepStrictEqual([second.body.results[0].status, second.body.results[0].code], ['skipped', 'has_draft']);
    assert.strictEqual(calls.count, 1);
    // Iemand wijzigt de live tekst na het schrijven: goedkeuren vraagt eerst een keuze.
    await baas.put(`/app/api/stock/items/${item.id}`, { description: 'Handmatige tekst.' });
    const changed = await baas.post('/app/api/stock/item-texts/approve', { itemIds: [item.id], acknowledgeWarnings: true });
    assert.strictEqual(changed.body.results[0].status, 'changed');
    assert.strictEqual((await baas.get(`/app/api/stock/item-texts/${item.id}`)).body.live.description, 'Handmatige tekst.');
    const forced = await baas.post('/app/api/stock/item-texts/approve', { itemIds: [item.id], acknowledgeWarnings: true, overwrite: true });
    assert.strictEqual(forced.body.results[0].status, 'approved');
    // Afwijzen.
    await baas.post('/app/api/stock/item-texts/generate', { itemIds: [item.id] });
    assert.strictEqual((await baas.post('/app/api/stock/item-texts/reject', { itemIds: [item.id] })).body.rejected, 1);
    assert.strictEqual((await baas.del(`/app/api/stock/item-texts/${item.id}`)).status, 404);
    // Grenzen: te veel of geen id's.
    assert.strictEqual((await baas.post('/app/api/stock/item-texts/generate', { itemIds: [] })).status, 400);
    assert.strictEqual((await baas.post('/app/api/stock/item-texts/generate', { itemIds: ['1', '2', '3', '4', '5', '6'] })).status, 400);
    assert.strictEqual((await baas.post('/app/api/stock/item-texts/approve', {})).status, 400);
  } finally { server.close(); }
});

test('producttekst: een fout die doorgaan zinloos maakt stopt de portie, het archief krijgt niets', async () => {
  const { server, calls, as } = await setup(behaviour);
  try {
    const baas = await as('baas');
    const empty = (await baas.post('/app/api/stock/items', { code: 'L1', name: 'Buis LEEG', unit: 'm' })).body;
    const other = (await baas.post('/app/api/stock/items', { code: 'L2', name: 'Andere buis', unit: 'm' })).body;
    const archived = (await baas.post('/app/api/stock/items', { code: 'A1', name: 'Oud', unit: 'm' })).body;
    await baas.put(`/app/api/stock/items/${archived.id}`, { archived: true });
    const run = (await baas.post('/app/api/stock/item-texts/generate', { itemIds: [empty.id, other.id, archived.id] })).body;
    assert.strictEqual(run.aborted.code, 'no_credit');
    assert.strictEqual(run.results.find((result) => result.itemId === archived.id).code, 'unavailable');
    assert.ok(run.results.filter((result) => result.status === 'error').every((result) => result.code === 'no_credit'));
    assert.ok(calls.count <= 3);
    const list = (await baas.get('/app/api/stock/item-texts')).body;
    assert.ok(!list.items.some((entry) => entry.id === archived.id));
  } finally { server.close(); }
});

test('producttekst: dagelijks maximum, rechten en andere organisatie', async () => {
  const { server, store, db, as } = await setup(behaviour);
  try {
    const baas = await as('baas');
    const item = (await baas.post('/app/api/stock/items', { code: 'D1', name: 'Dagbuis', unit: 'm' })).body;
    const klant = await as('klant');
    assert.strictEqual((await klant.get('/app/api/stock/item-texts')).status, 403);
    assert.strictEqual((await klant.post('/app/api/stock/item-texts/generate', { itemIds: [item.id] })).status, 403);
    assert.strictEqual((await klant.post('/app/api/stock/item-texts/approve', { itemIds: [item.id] })).status, 403);
    // Een artikel van een andere organisatie is hier onvindbaar.
    const other = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant;
    db.prepare("INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, on_hand, cost_price, notes, archived, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000000e1', ?, 'V', 'Vreemd', 'st', '', 0, 0, 0, '', 0, '2026-01-01', '2026-01-01')").run(other.id);
    assert.strictEqual((await baas.get('/app/api/stock/item-texts/00000000-0000-4000-8000-0000000000e1')).status, 404);
    const foreign = await baas.post('/app/api/stock/item-texts/generate', { itemIds: ['00000000-0000-4000-8000-0000000000e1'] });
    assert.strictEqual(foreign.body.results[0].code, 'not_found');
    // Dagelijks maximum: zet het op 1; het tweede artikel in dezelfde portie wordt geweigerd.
    await baas.put('/app/api/admin/settings', { aiDailyLimit: 1 });
    const second = (await baas.post('/app/api/stock/items', { code: 'D2', name: 'Dagbuis twee', unit: 'm' })).body;
    const run = await baas.post('/app/api/stock/item-texts/generate', { itemIds: [item.id, second.id] });
    assert.strictEqual(run.status, 200, JSON.stringify(run.body));
    assert.deepStrictEqual(run.body.results.map((result) => result.code || result.status).sort(), ['daily_limit', 'ok']);
    assert.strictEqual((await baas.post('/app/api/stock/item-texts/generate', { itemIds: [item.id] })).status, 429);
  } finally { server.close(); }
});

test('producttekst: AI uit of zonder sleutel geeft een duidelijke melding', async () => {
  const { server, as } = await setup(behaviour);
  try {
    const baas = await as('baas');
    const item = (await baas.post('/app/api/stock/items', { code: 'U1', name: 'Uitbuis', unit: 'm' })).body;
    await baas.put('/app/api/admin/settings', { aiEnabled: false });
    const off = await baas.post('/app/api/stock/item-texts/generate', { itemIds: [item.id] });
    assert.deepStrictEqual([off.status, off.body.error], [409, 'disabled']);
  } finally { server.close(); }
});
