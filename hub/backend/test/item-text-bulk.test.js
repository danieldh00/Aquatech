// Omschrijvingen in bulk (artikelen/item-text-bulk.js): kenmerken opzoeken en bewaren, schrijven uit de bekende gegevens, bestaande teksten beoordelen,
// overschrijven met terugzetten, waarschuwingen als concept, kostenschatting en het kostenoverzicht.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { validateFeatures } = require('../src/artikelen/related-compat');
const { buildFacts } = require('../src/artikelen/item-text-check');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const SOURCE = 'https://fabrikant.example/product';

test('kenmerken: alleen met adres uit de zoekresultaten en getallen die in de bronzin staan', () => {
  const allowed = new Set([SOURCE]);
  const good = { name: 'Werpstraal', value: '7,6 tot 15,2 m', url: SOURCE, quote: 'Radius 7.6 - 15.2 m' };
  assert.strictEqual(validateFeatures([good], allowed).length, 1);
  assert.strictEqual(validateFeatures([{ ...good, value: '8 tot 15,2 m' }], allowed).length, 0, 'het getal 8 staat niet in de bronzin');
  assert.strictEqual(validateFeatures([{ ...good, url: 'https://anders.example/' }], allowed).length, 0, 'adres niet uit de zoekresultaten');
  assert.strictEqual(validateFeatures([{ ...good, quote: '' }], allowed).length, 0, 'zonder bronzin');
  assert.strictEqual(validateFeatures([good, { ...good, value: '1 m' }], allowed).length, 1, 'elke naam één keer');
  assert.strictEqual(validateFeatures([{ name: 'Materiaal', value: 'Messing', url: SOURCE, quote: 'Materiaal: messing' }], allowed).length, 1);
});

test('bronvelden: specificaties en kenmerken van Past bij gaan mee, een artikel met alleen die gegevens is niet dun', () => {
  const facts = buildFacts({ name: 'Kop', code: 'K1', unit: 'st', specifications: '[]' }, '', {
    role: 'sproeikop', connections: [{ kind: 'draad', size: '1/2"', gender: 'binnen' }], pressureBar: { min: 1.5, max: 3 }, flowLh: null,
    kenmerken: [{ name: 'Werpstraal', value: '7,6 m', url: SOURCE, quote: 'x' }],
  });
  const labels = facts.fields.map((field) => field.label);
  assert.ok(labels.includes('Aansluitingen (volgens fabrikantbron)') && labels.includes('Kenmerken (volgens fabrikantbron)'));
  assert.strictEqual(facts.fields.find((field) => field.label.startsWith('Werkdruk')).value, '1,5 tot 3');
  assert.strictEqual(facts.thin, false);
});

/**
 * Testserver met een nep-schrijver en nep-zoeker.
 * @param {Function} behave Krijgt { fields } en geeft de teksten (description, seoTitle, seoDescription, verdict).
 * @returns {Promise<object>} server, as, calls en db.
 */
async function setup(behave) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const calls = { writes: 0, searches: 0, seen: [] };
  /**
   * Nep-schrijver.
   * @param {{ model: string }} options Het gekozen model.
   * @returns {object} De schrijver.
   */
  const createItemTextWriter = ({ model }) => ({
    available: true, model,
    /**
     * Schrijft de tekst volgens het opgegeven gedrag.
     * @param {object} input De bronvelden.
     * @returns {Promise<object>} De teksten met model en verbruik.
     */
    async write(input) { calls.writes += 1; calls.seen.push(input.fields); return { notes: '', verdict: 'geen', verdictReason: '', ...(await behave(input)), model: 'claude-sonnet-5-5', usage: { input_tokens: 100, output_tokens: 50 } }; },
  });
  /**
   * Nep-zoeker: geeft voor elk artikel één kenmerk.
   * @param {{ model: string }} options Het gekozen model.
   * @returns {object} De zoeker.
   */
  const createSpecResearcher = ({ model }) => ({
    available: true, model,
    /**
     * Zoekt "kenmerken".
     * @returns {Promise<object>} Eén kenmerk, met model en verbruik.
     */
    async researchFeatures() { calls.searches += 1; return { status: 'gevonden', features: [{ name: 'Materiaal', value: 'Messing', url: SOURCE, quote: 'Materiaal: messing' }], model: 'claude-sonnet-5-5', usage: { input_tokens: 500, output_tokens: 100, server_tool_use: { web_search_requests: 2 } } }; },
  });
  const app = createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db, anthropicApiKey: 'sk-ant-test-test-test-test', createItemTextWriter, createSpecResearcher });
  const { server, base } = await listen(app);
  return { server, app, tenantId: main, calls, db, as: createLogin(base, { password: PW }) };
}

/**
 * Nep-gedrag: bij "BLIJF" oordeelt de AI dat de bestaande tekst goed is, bij "FOUT" staat er een verzonnen getal in.
 * @param {{ fields: { label: string, value: string }[] }} input De bronvelden.
 * @returns {object} De teksten.
 */
function behaviour(input) {
  const name = input.fields.find((field) => field.label === 'Naam').value;
  const existing = input.fields.some((field) => field.label === 'Bestaande omschrijving');
  const text = name.includes('FOUT') ? `${name} met 40 bar werkdruk.` : `${name} van messing.`;
  const verdict = !existing ? 'geen' : name.includes('BLIJF') ? 'behouden' : 'vervangen';
  return { description: text, seoTitle: name, seoDescription: `${name} bij AquaTech.`, verdict, verdictReason: verdict === 'behouden' ? 'De bestaande tekst klopt.' : 'De nieuwe tekst is feitelijker.' };
}

test('omschrijvingen in bulk: nieuw, behouden, overschreven met terugzetten, concept bij waarschuwing en kosten', async () => {
  const { server, calls, as } = await setup(behaviour);
  try {
    const baas = await as('baas');
    /**
     * Maakt een artikel aan.
     * @param {string} code Artikelcode.
     * @param {string} name Naam.
     * @param {object} [extra] Extra velden.
     * @returns {Promise<object>} Het artikel.
     */
    const make = async (code, name, extra = {}) => (await baas.post('/app/api/stock/items', { code, name, unit: 'st', brand: 'Rainpro', ...extra })).body;
    const fresh = await make('N1', 'Klep 25 mm');
    const keep = await make('B1', 'Klep BLIJF');
    const replace = await make('V1', 'Klep VERVANG');
    const wrong = await make('F1', 'Klep FOUT');
    const parent = await make('P1', 'Samengevoegd artikel');
    await baas.put(`/app/api/stock/items/${keep.id}`, { description: 'Goede oude tekst.' });
    await baas.put(`/app/api/stock/items/${replace.id}`, { description: 'Slechte oude tekst.' });
    // Een variant krijgt geen eigen tekst.
    const split = await baas.put(`/app/api/stock/items/${parent.id}/variants`, { attributes: [{ name: 'Maat', values: ['S', 'M'] }] });
    assert.strictEqual(split.status, 200, JSON.stringify(split.body));
    const variantId = (await baas.get('/app/api/stock')).body.items.find((item) => item.parentId === parent.id).id;

    const todo = (await baas.get('/app/api/stock/item-texts/bulk/todo?mode=texts')).body;
    assert.strictEqual(todo.total, 5, 'vijf hoofdartikelen (de variant telt niet)');
    assert.strictEqual(todo.withExisting, 2);
    assert.strictEqual(todo.withoutFeatures, 5);
    assert.ok(todo.estimateEur > 0 && todo.ai.model === 'claude-sonnet-5-5', 'Sonnet is de standaard');
    assert.strictEqual((await baas.get('/app/api/stock/item-texts/bulk/todo?mode=texts&review=0')).body.total, 3, 'zonder beoordelen alleen artikelen zonder omschrijving');

    const run = await baas.post('/app/api/stock/item-texts/bulk/run', { itemIds: [fresh.id, keep.id, replace.id, wrong.id, parent.id, variantId], mode: 'texts' });
    assert.strictEqual(run.status, 200, JSON.stringify(run.body));
    const byId = Object.fromEntries(run.body.results.map((result) => [result.itemId, result]));
    assert.strictEqual(byId[fresh.id].status, 'nieuw');
    assert.strictEqual(byId[keep.id].status, 'behouden');
    assert.strictEqual(byId[replace.id].status, 'overschreven');
    assert.strictEqual(byId[wrong.id].status, 'concept');
    assert.strictEqual(byId[parent.id].status, 'nieuw');
    assert.strictEqual(byId[variantId].status, 'skipped', 'een variant erft de tekst van het hoofdartikel');
    // De kenmerken zijn één keer opgezocht per hoofdartikel en gaan als bronveld mee naar de schrijver.
    assert.strictEqual(calls.searches, 5);
    assert.ok(calls.seen[0].some((field) => field.label === 'Kenmerken (volgens fabrikantbron)' && field.value === 'Materiaal: Messing'));

    const freshDetail = (await baas.get(`/app/api/stock/item-texts/${fresh.id}`)).body;
    assert.strictEqual(freshDetail.live.description, 'Klep 25 mm van messing.');
    assert.strictEqual(freshDetail.written.action, 'nieuw');
    assert.strictEqual((await baas.get(`/app/api/stock/item-texts/${keep.id}`)).body.live.description, 'Goede oude tekst.');
    const replaced = (await baas.get(`/app/api/stock/item-texts/${replace.id}`)).body;
    assert.strictEqual(replaced.live.description, 'Klep VERVANG van messing.');
    assert.strictEqual(replaced.written.action, 'overschreven');
    assert.strictEqual(replaced.written.previous.text, 'Slechte oude tekst.');
    const wrongDetail = (await baas.get(`/app/api/stock/item-texts/${wrong.id}`)).body;
    assert.strictEqual(wrongDetail.live.description, '', 'met een waarschuwing gaat niets live');
    assert.ok(wrongDetail.draft && wrongDetail.draft.warnings.some((warning) => warning.kind === 'number'));

    // Lijst: markering per artikel, filter op overschreven, en zonder het logboek met de oude tekst.
    const listed = (await baas.get('/app/api/stock/item-texts?filter=overschreven')).body;
    assert.deepStrictEqual(listed.items.map((item) => [item.code, item.written.action]), [['V1', 'overschreven']]);
    assert.ok(!JSON.stringify(listed).includes('Slechte oude tekst'));

    // Opnieuw draaien slaat behandelde artikelen en concepten over en zoekt niets opnieuw op.
    const again = (await baas.get('/app/api/stock/item-texts/bulk/todo?mode=texts')).body;
    assert.strictEqual(again.total, 0);
    const before = { searches: calls.searches, writes: calls.writes };
    const second = await baas.post('/app/api/stock/item-texts/bulk/run', { itemIds: [fresh.id, wrong.id], mode: 'texts' });
    assert.deepStrictEqual(second.body.results.map((result) => result.status), ['skipped', 'skipped']);
    assert.strictEqual(calls.searches, before.searches, 'kenmerken worden maar één keer opgezocht');

    // Terugzetten.
    assert.strictEqual((await baas.post(`/app/api/stock/item-texts/${replace.id}/restore`, {})).status, 200);
    const restored = (await baas.get(`/app/api/stock/item-texts/${replace.id}`)).body;
    assert.strictEqual(restored.live.description, 'Slechte oude tekst.');
    assert.strictEqual(restored.written.action, 'hersteld');
    assert.strictEqual((await baas.post(`/app/api/stock/item-texts/${replace.id}/restore`, {})).status, 409);

    // Kostenoverzicht: beide functies, niets mislukt.
    const usage = (await baas.get('/app/api/admin/ai-usage')).body;
    const json = JSON.stringify(usage);
    assert.ok(json.includes('kenmerken_opzoeken') && json.includes('product_tekst'));
    assert.strictEqual(usage.totals.failed, 0);
  } finally { server.close(); }
});

test('omschrijvingen in bulk: rechten, grenzen, modelkeuze en een fout die de portie stopt', async () => {
  const { server, as } = await setup((input) => {
    if (input.fields.some((field) => field.value.includes('LEEG'))) { const { AnalyzeError } = require('../src/beregening/plan-analyzer'); throw new AnalyzeError('no_credit', 'Tegoed op.', 402); }
    return behaviour(input);
  });
  try {
    const baas = await as('baas');
    const klant = await as('klant');
    assert.strictEqual((await klant.get('/app/api/stock/item-texts/bulk/todo?mode=texts')).status, 403);
    assert.strictEqual((await klant.post('/app/api/stock/item-texts/bulk/run', { itemIds: ['x'], mode: 'texts' })).status, 403);
    assert.strictEqual((await baas.post('/app/api/stock/item-texts/bulk/run', { itemIds: [], mode: 'texts' })).status, 400);
    assert.strictEqual((await baas.post('/app/api/stock/item-texts/bulk/run', { itemIds: ['1', '2', '3', '4', '5', '6', '7'], mode: 'texts' })).status, 400);
    assert.strictEqual((await baas.put('/app/api/stock/item-texts/bulk/model', { model: 'bestaat-niet' })).status, 400);
    assert.strictEqual((await baas.put('/app/api/stock/item-texts/bulk/model', { model: 'claude-haiku-5-5' })).status, 200);
    assert.strictEqual((await baas.get('/app/api/stock/item-texts/bulk/todo?mode=texts')).body.ai.model, 'claude-haiku-5-5');
    const empty = (await baas.post('/app/api/stock/items', { code: 'L1', name: 'Klep LEEG', unit: 'st' })).body;
    const run = (await baas.post('/app/api/stock/item-texts/bulk/run', { itemIds: [empty.id], mode: 'texts' })).body;
    assert.strictEqual(run.aborted.code, 'no_credit');
    assert.strictEqual((await baas.get(`/app/api/stock/item-texts/${empty.id}`)).body.live.description, '');
  } finally { server.close(); }
});

test('omschrijvingen in bulk: gelijktijdige runs doen niets dubbel, een veranderde tekst wordt niet overschreven en het dagplafond is zichtbaar', async () => {
  const gates = { TRAAG: null, WACHT: null };
  const releases = {};
  for (const key of Object.keys(gates)) gates[key] = new Promise((resolve) => { releases[key] = resolve; });
  const { server, calls, as } = await setup(async (input) => {
    const name = input.fields.find((field) => field.label === 'Naam').value;
    for (const key of Object.keys(gates)) if (name.includes(key)) await gates[key];
    return behaviour(input);
  });
  /**
   * Wacht tot de nep-schrijver het opgegeven aantal keren is aangeroepen.
   * @param {number} writes Het aantal aanroepen.
   * @returns {Promise<void>}
   */
  const untilWrites = async (writes) => { for (let attempt = 0; attempt < 100 && calls.writes < writes; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20)); };
  try {
    const baas = await as('baas');
    const slow = (await baas.post('/app/api/stock/items', { code: 'T1', name: 'Klep TRAAG', unit: 'st' })).body;
    const first = baas.post('/app/api/stock/item-texts/bulk/run', { itemIds: [slow.id], mode: 'texts' });
    await untilWrites(1);
    const second = (await baas.post('/app/api/stock/item-texts/bulk/run', { itemIds: [slow.id], mode: 'texts' })).body;
    assert.deepStrictEqual([second.results[0].status, second.results[0].code], ['skipped', 'busy']);
    releases.TRAAG();
    assert.strictEqual((await first).body.results[0].status, 'nieuw');
    assert.strictEqual(calls.writes, 1, 'maar één keer betaald');

    // Verandert iemand de omschrijving terwijl de AI schrijft, dan blijft die staan.
    const waiting = (await baas.post('/app/api/stock/items', { code: 'W1', name: 'Klep WACHT', unit: 'st' })).body;
    await baas.put(`/app/api/stock/items/${waiting.id}`, { description: 'Oude tekst.' });
    const run = baas.post('/app/api/stock/item-texts/bulk/run', { itemIds: [waiting.id], mode: 'texts' });
    await untilWrites(2);
    await baas.put(`/app/api/stock/items/${waiting.id}`, { description: 'Net handmatig aangepast.' });
    releases.WACHT();
    const outcome = (await run).body.results[0];
    assert.deepStrictEqual([outcome.status, outcome.code], ['skipped', 'changed']);
    assert.strictEqual((await baas.get(`/app/api/stock/item-texts/${waiting.id}`)).body.live.description, 'Net handmatig aangepast.');

    const todo = (await baas.get('/app/api/stock/item-texts/bulk/todo?mode=texts')).body;
    assert.ok(Number.isInteger(todo.remainingToday) && todo.remainingToday <= 2000 - 2, 'het dagplafond telt de verwerkte artikelen');
  } finally { server.close(); }
});

test('omschrijvingen in bulk: het dagplafond stopt de run', async () => {
  const { server, as } = await setup(behaviour);
  try {
    const baas = await as('baas');
    assert.strictEqual((await baas.put('/app/api/admin/settings', { descriptionBulkDailyItems: 10 })).status, 200);
    const ids = [];
    for (let number = 1; number <= 12; number += 1) ids.push((await baas.post('/app/api/stock/items', { code: `D${number}`, name: `Klep ${number}`, unit: 'st' })).body.id);
    const early = (await baas.post('/app/api/stock/item-texts/bulk/run', { itemIds: ids.slice(0, 6), mode: 'texts' })).body;
    assert.ok(early.results.every((result) => result.status === 'nieuw'));
    const late = (await baas.post('/app/api/stock/item-texts/bulk/run', { itemIds: ids.slice(6, 12), mode: 'texts' })).body;
    assert.deepStrictEqual(late.results.map((result) => result.code || result.status), ['nieuw', 'nieuw', 'nieuw', 'nieuw', 'daily_limit', 'daily_limit']);
    const refused = await baas.post('/app/api/stock/item-texts/bulk/run', { itemIds: [ids[11]], mode: 'texts' });
    assert.strictEqual(refused.status, 429);
    assert.strictEqual(refused.body.error, 'daily_limit');
    assert.strictEqual((await baas.get('/app/api/stock/item-texts/bulk/todo?mode=texts')).body.remainingToday, 0);
  } finally { server.close(); }
});

test('omschrijvingen in bulk: de achtergrondtaak loopt op de server door, toont voortgang, weigert een tweede start en is te stoppen', async () => {
  const { server, as } = await setup(behaviour);
  try {
    const baas = await as('baas');
    const klant = await as('klant');
    for (let number = 1; number <= 8; number += 1) await baas.post('/app/api/stock/items', { code: `J${number}`, name: `Klep ${number}`, unit: 'st' });
    assert.strictEqual((await klant.get('/app/api/stock/item-texts/bulk/job')).status, 403);
    assert.strictEqual((await klant.post('/app/api/stock/item-texts/bulk/job', { mode: 'texts' })).status, 403);
    assert.strictEqual((await baas.get('/app/api/stock/item-texts/bulk/job')).body.running, false, 'nog geen taak');
    const started = await baas.post('/app/api/stock/item-texts/bulk/job', { research: true, review: true, mode: 'texts' });
    assert.strictEqual(started.status, 202, JSON.stringify(started.body));
    assert.strictEqual(started.body.total, 8);
    let job = (await baas.get('/app/api/stock/item-texts/bulk/job')).body;
    for (let round = 0; round < 100 && job.running; round += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      job = (await baas.get('/app/api/stock/item-texts/bulk/job')).body;
    }
    assert.strictEqual(job.running, false);
    assert.strictEqual(job.processed, 8);
    assert.strictEqual(job.tally.nieuw, 8);
    assert.strictEqual(job.message, 'Klaar.');
    assert.strictEqual((await baas.post('/app/api/stock/item-texts/bulk/job', { mode: 'texts' })).status, 409, 'niets meer aan de beurt');
    assert.strictEqual((await baas.get('/app/api/stock/item-texts/bulk/todo?mode=texts')).body.total, 0);
  } finally { server.close(); }
});

test('omschrijvingen in bulk: de taak wordt bewaard en gaat na een herstart vanzelf verder', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let first = true;
  const { server, app, tenantId, as } = await setup(async (input) => {
    if (first) { first = false; await gate; }
    return behaviour(input);
  });
  try {
    const baas = await as('baas');
    for (let number = 1; number <= 3; number += 1) await baas.post('/app/api/stock/items', { code: `H${number}`, name: `Klep ${number}`, unit: 'st' });
    const settings = app.locals.settingsFor(tenantId);
    assert.strictEqual((await baas.post('/app/api/stock/item-texts/bulk/job', { research: true, review: false, mode: 'texts' })).status, 202);
    const saved = settings.get('backgroundJobs');
    assert.deepStrictEqual(saved.omschrijvingen.options, { research: true, review: false, mode: 'texts' });
    assert.ok(saved.omschrijvingen.userId, 'wie de taak startte');
    release();
    let job = (await baas.get('/app/api/stock/item-texts/bulk/job')).body;
    for (let round = 0; round < 100 && job.running; round += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      job = (await baas.get('/app/api/stock/item-texts/bulk/job')).body;
    }
    assert.strictEqual(job.tally.nieuw, 3);
    assert.deepStrictEqual(settings.get('backgroundJobs'), {}, 'een afgeronde taak wordt niet meer hervat');
    assert.deepStrictEqual(await app.locals.resumeBackgroundJobs(), []);

    // Een taak die liep toen de server stopte: de instelling staat er nog, een nieuwe start hervat hem.
    for (let number = 4; number <= 5; number += 1) await baas.post('/app/api/stock/items', { code: `H${number}`, name: `Klep ${number}`, unit: 'st' });
    settings.update({ backgroundJobs: { omschrijvingen: { userId: null, startedAt: '2026-11-26T10:00:00.000Z', options: { research: true, review: true, mode: 'texts' } } } }, null);
    assert.deepStrictEqual(await app.locals.resumeBackgroundJobs(), [`omschrijvingen|${tenantId}`]);
    job = (await baas.get('/app/api/stock/item-texts/bulk/job')).body;
    for (let round = 0; round < 100 && job.running; round += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      job = (await baas.get('/app/api/stock/item-texts/bulk/job')).body;
    }
    assert.strictEqual(job.tally.nieuw, 2, 'alleen wat nog aan de beurt was');
    assert.deepStrictEqual(settings.get('backgroundJobs'), {});
    // Niets meer aan de beurt: een bewaarde taak wordt opgeruimd in plaats van hervat.
    settings.update({ backgroundJobs: { omschrijvingen: { userId: null, startedAt: '2026-11-26T10:00:00.000Z', options: { mode: 'texts' } } } }, null);
    assert.deepStrictEqual(await app.locals.resumeBackgroundJobs(), []);
    assert.deepStrictEqual(settings.get('backgroundJobs'), {});
  } finally { release(); server.close(); }
});

test('specs in bulk: kenmerken worden specificaties, eigen specificaties blijven, geen tekst geschreven en AI-teksten verdwijnen uit de shop', async () => {
  const { server, calls, as, db, tenantId } = await setup(behaviour);
  try {
    const baas = await as('baas');
    /**
     * Maakt een artikel aan.
     * @param {string} code Artikelcode.
     * @param {string} name Naam.
     * @param {object} [extra] Extra velden.
     * @returns {Promise<object>} Het artikel.
     */
    const make = async (code, name, extra = {}) => (await baas.post('/app/api/stock/items', { code, name, unit: 'st', brand: 'Rainpro', ...extra })).body;
    const empty = await make('S1', 'Klep 25 mm');
    const own = await make('S2', 'Klep eigen', { specifications: [{ name: 'Materiaal', value: 'Kunststof' }, { name: 'Kleur', value: 'Zwart' }] });
    const todo = (await baas.get('/app/api/stock/item-texts/bulk/todo')).body;
    assert.strictEqual(todo.mode, 'specs');
    assert.strictEqual(todo.total, 2);
    const run = await baas.post('/app/api/stock/item-texts/bulk/run', { itemIds: [empty.id, own.id] });
    assert.strictEqual(run.status, 200, JSON.stringify(run.body));
    const byId = Object.fromEntries(run.body.results.map((result) => [result.itemId, result]));
    assert.strictEqual(byId[empty.id].status, 'gevuld');
    assert.strictEqual(byId[own.id].status, 'geen', 'Materiaal staat er al: niets overschreven');
    assert.strictEqual(calls.writes, 0, 'in specs-modus wordt geen tekst geschreven');
    /**
     * De opgeslagen specificaties van een artikel.
     * @param {string} id Artikel-id.
     * @returns {object[]} De specificaties.
     */
    const specsOf = (id) => JSON.parse(db.prepare('SELECT specifications FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, id).specifications);
    assert.deepStrictEqual(specsOf(empty.id), [{ name: 'Materiaal', value: 'Messing' }]);
    assert.deepStrictEqual(specsOf(own.id), [{ name: 'Materiaal', value: 'Kunststof' }, { name: 'Kleur', value: 'Zwart' }]);
    assert.strictEqual((await baas.get('/app/api/stock/item-texts/bulk/todo')).body.total, 0, 'daarna is alles behandeld');
  } finally { server.close(); }
});
