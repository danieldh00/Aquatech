// Gerelateerde artikelen (artikelen/related-*.js): vaste compatibiliteitsregels, onderbouwing uit bronnen, de AI-ronde met een nagebootste zoeker,
// handmatig koppelen, vaak samen besteld en de blokken op de productpagina.
const test = require('node:test');
const assert = require('node:assert');
const { normalizeSize, quoteSupportsSize, validateSpecs, compatible, suggestLinks } = require('../src/artikelen/related-compat');
const { computeTogether } = require('../src/artikelen/related-items');
const { createSpecResearcher, urlsOf } = require('../src/artikelen/related-research');
const { AnalyzeError } = require('../src/beregening/plan-analyzer');
const { setup } = require('./helpers/webshop-world');
const { createClient } = require('./helpers/http-client');
const AiModels = require('../../frontend/shared/ai-models.js');

const SOURCE = 'https://fabrikant.example/product/1';

/**
 * Specificaties met bron zoals de AI ze zou teruggeven.
 * @param {string} role De functie van het artikel.
 * @param {object[]} connections De aansluitingen.
 * @param {object} [extra] Extra velden (pressureBar).
 * @returns {object} Het antwoord (nog niet gevalideerd).
 */
const raw = (role, connections, extra = {}) => ({
  found: true, role, connections, pressureBar: null, flowLh: null, ...extra,
  evidence: [...connections.map((connection) => ({ field: 'aansluiting', url: SOURCE, quote: `Aansluiting ${connection.size} ${connection.gender}` })), ...(extra.pressureBar ? [{ field: 'druk', url: SOURCE, quote: 'Werkdruk 1,5 tot 3 bar' }] : [])],
});

test('maten worden gelijkgetrokken en een bronzin moet de maat echt noemen', () => {
  assert.strictEqual(normalizeSize('3/4 inch'), '3/4"');
  assert.strictEqual(normalizeSize('G 3/4'), '3/4"');
  assert.strictEqual(normalizeSize('R 1/2"'), '1/2"');
  assert.strictEqual(normalizeSize('Ø 25 mm'), '25mm');
  assert.strictEqual(normalizeSize('25mm'), '25mm');
  assert.strictEqual(normalizeSize('groot'), '');
  assert.strictEqual(quoteSupportsSize('Inlaat: 3/4" binnendraad', '3/4"'), true);
  assert.strictEqual(quoteSupportsSize('Inlaat: 1/2" binnendraad', '3/4"'), false);
  assert.strictEqual(quoteSupportsSize('Buis 125 mm', '25mm'), false, '25 staat niet los in 125');
  assert.strictEqual(quoteSupportsSize('Buisdiameter 25 mm', '25mm'), true);
});

test('specificaties zonder bron uit de zoekresultaten of zonder de maat in de zin vervallen', () => {
  const allowed = new Set([SOURCE]);
  const good = validateSpecs(raw('behuizing', [{ kind: 'draad', size: '3/4 inch', gender: 'buiten' }]), allowed);
  assert.deepStrictEqual(good.connections, [{ kind: 'draad', size: '3/4"', gender: 'buiten' }]);
  assert.strictEqual(validateSpecs(raw('behuizing', [{ kind: 'draad', size: '3/4 inch', gender: 'buiten' }]), new Set(['https://andere.example/'])), null, 'adres niet uit de zoekresultaten');
  const invented = raw('behuizing', [{ kind: 'draad', size: '1 inch', gender: 'buiten' }]);
  invented.evidence[0].quote = 'Aansluiting 3/4 buiten';
  assert.strictEqual(validateSpecs(invented, allowed), null, 'de zin noemt de maat niet');
  assert.strictEqual(validateSpecs({ found: true, role: 'x', connections: [{ kind: 'draad', size: '3/4"', gender: 'buiten' }], evidence: [] }, allowed), null, 'zonder bewijs');
  const noPressureProof = validateSpecs({ ...raw('x', [{ kind: 'buis', size: '25 mm', gender: 'geen' }]), pressureBar: { min: 1, max: 3 } }, allowed);
  assert.strictEqual(noPressureProof.pressureBar, null, 'een druk zonder bewijsregel telt niet');
  assert.strictEqual(validateSpecs(raw('x', [{ kind: 'draad', size: '3/4"', gender: 'geen' }]), allowed), null, 'draad zonder binnen/buiten');
});

test('vaste regels: draad binnen op buiten, gelijke maat, andere functie en overlappende druk', () => {
  const allowed = new Set([SOURCE]);
  const head = { name: 'Sproeikop', specs: validateSpecs(raw('sproeikop', [{ kind: 'draad', size: '1/2"', gender: 'binnen' }], { pressureBar: { min: 1.5, max: 3 } }), allowed) };
  const housing = { name: 'Behuizing', specs: validateSpecs(raw('behuizing', [{ kind: 'draad', size: '1/2"', gender: 'buiten' }, { kind: 'draad', size: '3/4"', gender: 'binnen' }]), allowed) };
  const wrongSize = { name: 'Grote behuizing', specs: validateSpecs(raw('behuizing', [{ kind: 'draad', size: '3/4"', gender: 'buiten' }]), allowed) };
  const sameGender = { name: 'Zelfde draad', specs: validateSpecs(raw('behuizing', [{ kind: 'draad', size: '1/2"', gender: 'binnen' }]), allowed) };
  const sameRole = { name: 'Tweede kop', specs: validateSpecs(raw('sproeikop', [{ kind: 'draad', size: '1/2"', gender: 'buiten' }]), allowed) };
  const highPressure = { name: 'Hoge druk', specs: validateSpecs({ ...raw('behuizing', [{ kind: 'draad', size: '1/2"', gender: 'buiten' }], { pressureBar: { min: 5, max: 8 } }) }, allowed) };
  const fit = compatible(head, housing);
  assert.ok(fit && /binnendraad 1\/2"/.test(fit.reason) && /buitendraad 1\/2"/.test(fit.reason));
  assert.ok(fit.evidence.every((entry) => entry.url === SOURCE && entry.quote));
  assert.strictEqual(compatible(head, wrongSize), null);
  assert.strictEqual(compatible(head, sameGender), null);
  assert.strictEqual(compatible(head, sameRole), null);
  assert.strictEqual(compatible(head, highPressure), null, 'drukbereiken overlappen niet');
  const links = suggestLinks([{ id: 'a', ...head }, { id: 'b', ...housing }, { id: 'c', ...wrongSize }]);
  assert.deepStrictEqual([...links.keys()].sort(), ['a', 'b']);
  assert.strictEqual(links.get('a')[0].relatedId, 'b');
  const pipes = suggestLinks([{ id: 'p', name: 'Buis', specs: validateSpecs(raw('buis', [{ kind: 'buis', size: '25 mm', gender: 'geen' }]), allowed) }, { id: 'k', name: 'Koppeling', specs: validateSpecs(raw('koppeling', [{ kind: 'buis', size: '25mm', gender: 'geen' }]), allowed) }]);
  assert.strictEqual(pipes.get('p')[0].relatedId, 'k', 'buismaten passen bij gelijke maat');
});

test('de zoeker accepteert alleen adressen uit de zoekresultaten en meldt geen bron als niet gevonden', async () => {
  /**
   * Nep-AI-client die het opgegeven bericht teruggeeft.
   * @param {object} message Het antwoord.
   * @returns {object} De client.
   */
  const clientWith = (message) => ({ messages: { create: async () => message } });
  const search = { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: SOURCE, title: 'x' }] };
  /**
   * Maakt een nagebootst AI-antwoord met een zoekresultaat en de gegeven specificaties.
   * @param {object} body De specificaties die de AI teruggeeft.
   * @returns {object} Het nagebootste antwoord.
   */
  const answer = (body) => ({ model: 'm', usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 2 } }, stop_reason: 'end_turn', content: [search, { type: 'text', text: `Hier: ${JSON.stringify(body)}` }] });
  const found = await createSpecResearcher({ client: clientWith(answer(raw('behuizing', [{ kind: 'draad', size: '3/4 inch', gender: 'buiten' }]))) }).research({ fields: [{ label: 'Naam', value: 'Behuizing' }] });
  assert.strictEqual(found.status, 'gevonden');
  assert.strictEqual(found.specs.connections[0].size, '3/4"');
  const outside = answer(raw('behuizing', [{ kind: 'draad', size: '3/4 inch', gender: 'buiten' }]));
  outside.content[0] = { ...search, content: [{ type: 'web_search_result', url: 'https://iets-anders.example/' }] };
  assert.strictEqual((await createSpecResearcher({ client: clientWith(outside) }).research({ fields: [] })).status, 'niet_gevonden');
  assert.strictEqual((await createSpecResearcher({ client: clientWith(answer({ found: false })) }).research({ fields: [] })).status, 'niet_gevonden');
  await assert.rejects(createSpecResearcher({ client: clientWith({ ...answer({}), content: [{ type: 'text', text: 'geen json' }] }) }).research({ fields: [] }), (error) => error instanceof AnalyzeError && error.code === 'invalid_output');
  await assert.rejects(createSpecResearcher({}).research({ fields: [] }), (error) => error.code === 'not_configured');
  assert.deepStrictEqual([...urlsOf([search])], [SOURCE]);
});

test('vaak samen besteld: relevantie telt, populariteit alleen niet; retouren en bulkbestellingen tellen niet mee', () => {
  const lines = [];
  /**
   * Zet een bestelling met de gegeven artikelen neer.
   * @param {string} orderId Id van de bestelling.
   * @param {string[]} items De artikelen.
   * @returns {void}
   */
  const order = (orderId, items) => { for (const itemId of items) lines.push({ orderId, itemId, kind: 'verkoop' }); };
  // A en B horen bij elkaar (6 van de 8 bestellingen met A); P is in bijna elke bestelling (populair) maar zegt niets.
  for (let index = 0; index < 6; index += 1) order(`ab${index}`, ['A', 'B', 'P']);
  for (let index = 0; index < 2; index += 1) order(`a${index}`, ['A', 'P']);
  for (let index = 0; index < 20; index += 1) order(`p${index}`, ['P', `Z${index}`]);
  for (let index = 0; index < 10; index += 1) order(`x${index}`, ['C', 'P']);
  const result = computeTogether(lines);
  assert.deepStrictEqual(result.get('A').map((entry) => entry.otherId), ['B'], 'P is populair maar niet relevant');
  assert.ok(!(result.get('A') || []).some((entry) => entry.otherId === 'P'));
  assert.ok(result.get('B') && result.get('B')[0].otherId === 'A');
  // Een retour van B in zes bestellingen haalt de paren weg.
  const returned = [...lines, ...[0, 1, 2, 3, 4, 5].map((index) => ({ orderId: `ab${index}`, itemId: 'B', kind: 'retour' }))];
  assert.ok(!computeTogether(returned).get('A'));
  // Een bestelling van meer dan 30 artikelen telt niet.
  const bulk = Array.from({ length: 31 }, (_, index) => `Q${index}`);
  const bulkLines = [];
  for (let index = 0; index < 10; index += 1) for (const itemId of bulk) bulkLines.push({ orderId: `b${index}`, itemId, kind: 'verkoop' });
  assert.strictEqual(computeTogether(bulkLines).size, 0);
});

/**
 * De nagebootste zoeker: specificaties per artikelcode (leeg = niet gevonden), met teller.
 * @param {object} table Per code het antwoord van de AI.
 * @param {{ count: number }} calls Teller.
 * @returns {Function} createSpecResearcher voor createApp.
 */
const fakeResearcher = (table, calls) => ({ model = 'claude-sonnet-5-5' } = {}) => ({
  available: true, model,
  /**
   * Zoekt "op internet": kijkt de code op in de tabel.
   * @param {{ fields: { label: string, value: string }[] }} input De bronvelden.
   * @returns {Promise<object>} De uitkomst.
   */
  async research(input) {
    calls.count += 1;
    const code = input.fields.find((field) => field.label === 'Artikelnummer').value;
    if (code === 'KAPOT') throw new AnalyzeError('api_error', 'De AI-dienst is stuk.', 502);
    const body = table[code];
    const specs = body ? validateSpecs(body, new Set([SOURCE])) : null;
    return { status: specs ? 'gevonden' : 'niet_gevonden', specs, model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 200, server_tool_use: { web_search_requests: 2 } } };
  },
});

test('AI-ronde: onderzoeken, koppelen met reden en bron, handmatig blijft, wissen, rechten en module', async () => {
  const calls = { count: 0 };
  const table = {
    KOP: raw('sproeikop', [{ kind: 'draad', size: '1/2"', gender: 'binnen' }]),
    BEH: raw('behuizing', [{ kind: 'draad', size: '1/2"', gender: 'buiten' }]),
    GROOT: raw('behuizing', [{ kind: 'draad', size: '3/4"', gender: 'buiten' }]),
  };
  const world = await setup({ appOptions: { createSpecResearcher: fakeResearcher(table, calls), anthropicApiKey: 'sk-ant-test-test-test-test' } });
  const { admin } = world;
  /**
   * Maakt een voorraadartikel aan.
   * @param {string} code De artikelcode.
   * @param {string} name De naam.
   * @returns {Promise<object>} Het aangemaakte artikel.
   */
  const make = async (code, name) => (await admin.post('/app/api/stock/items', { code, name, onHand: 5, salePrice: 10 })).body;
  const head = await make('KOP', 'Sproeikop 1/2');
  const housing = await make('BEH', 'Behuizing 1/2');
  const big = await make('GROOT', 'Behuizing 3/4');
  const unknown = await make('ONBEKEND', 'Mystery artikel');
  const broken = await make('KAPOT', 'Defect artikel');
  const todo = (await admin.get('/app/api/stock/related/ai/todo')).body;
  assert.ok(todo.ids.includes(head.id) && todo.estimateEur > 0);
  const run = await admin.post('/app/api/stock/related-ai/research', { itemIds: [head.id, housing.id, big.id, unknown.id, broken.id] });
  assert.strictEqual(run.status, 200, JSON.stringify(run.body));
  assert.deepStrictEqual(run.body.results.map((result) => result.status), ['gevonden', 'gevonden', 'gevonden', 'niet_gevonden', 'error']);
  assert.strictEqual((await admin.post('/app/api/stock/related-ai/research', { itemIds: [] })).status, 400);
  const linked = (await admin.post('/app/api/stock/related-ai/link', {})).body;
  assert.strictEqual(linked.links, 2, 'kop↔behuizing in beide richtingen; de grote behuizing past niet');
  const headDetail = (await admin.get(`/app/api/stock/related/${head.id}`)).body;
  assert.deepStrictEqual(headDetail.links.map((link) => [link.code, link.source]), [['BEH', 'ai']]);
  assert.match(headDetail.links[0].reason, /binnendraad 1\/2"/);
  assert.strictEqual(headDetail.links[0].evidence[0].url, SOURCE);
  assert.strictEqual(headDetail.specs.status, 'gevonden');
  assert.strictEqual((await admin.get(`/app/api/stock/related/${unknown.id}`)).body.links.length, 0, 'zonder bron geen koppeling');
  assert.strictEqual((await admin.get(`/app/api/stock/related/${unknown.id}`)).body.specs.status, 'niet_gevonden');
  // Verbruik, inclusief zoekopdrachten, staat in het kostenoverzicht.
  const usage = JSON.stringify((await admin.get('/app/api/admin/ai-usage')).body);
  assert.ok(usage.includes('past_bij'));
  // Alleen de echt mislukte aanvraag (broken) telt als mislukt; 'gevonden' en 'niet_gevonden' zijn gewoon gelukte verzoeken.
  assert.strictEqual((await admin.get('/app/api/admin/ai-usage')).body.totals.failed, 1);
  assert.ok(AiModels.costUsd('claude-sonnet-5-5', { webSearches: 2, inputTokens: 0, outputTokens: 0 }).usd >= 0.02, 'een zoekopdracht kost geld');
  // Het todo-lijstje bevat daarna alleen nog wat niet is opgezocht of mislukte.
  assert.ok(!(await admin.get('/app/api/stock/related/ai/todo')).body.ids.includes(head.id));
  assert.ok((await admin.get('/app/api/stock/related/ai/todo?again=1')).body.ids.includes(head.id));
  // Handmatig koppelen: de AI-koppeling wordt handmatig, de AI overschrijft hem nooit.
  const manual = await admin.put(`/app/api/stock/related/${head.id}`, { relatedIds: [big.id, housing.id] });
  assert.strictEqual(manual.status, 200, JSON.stringify(manual.body));
  assert.deepStrictEqual(manual.body.links.map((link) => [link.code, link.source]), [['GROOT', 'handmatig'], ['BEH', 'handmatig']]);
  await admin.post('/app/api/stock/related-ai/link', {});
  assert.deepStrictEqual((await admin.get(`/app/api/stock/related/${head.id}`)).body.links.map((link) => link.source), ['handmatig', 'handmatig']);
  assert.strictEqual((await admin.put(`/app/api/stock/related/${head.id}`, { relatedIds: [head.id] })).status, 400);
  assert.strictEqual((await admin.put(`/app/api/stock/related/${head.id}`, { relatedIds: ['00000000-0000-4000-8000-000000000001'] })).status, 400);
  assert.strictEqual((await admin.get('/app/api/stock/related/00000000-0000-4000-8000-000000000001')).status, 404);
  // Wissen van de AI-koppelingen laat de handmatige staan.
  const cleared = (await admin.post('/app/api/stock/related-ai/clear', {})).body;
  assert.ok(cleared.removed >= 1);
  assert.strictEqual((await admin.get(`/app/api/stock/related/${head.id}`)).body.links.length, 2);
  assert.strictEqual((await admin.del(`/app/api/stock/related/${head.id}/${big.id}`)).status, 200);
  assert.strictEqual((await admin.del(`/app/api/stock/related/${head.id}/${big.id}`)).status, 404);
  // Overzicht en filters.
  const overview = (await admin.get('/app/api/stock/related?filter=geenspec')).body;
  assert.deepStrictEqual(overview.items.map((item) => item.code), ['ONBEKEND']);
  assert.strictEqual((await admin.put('/app/api/stock/related-ai/model', { model: 'claude-haiku-5-5' })).status, 200);
  assert.strictEqual((await admin.get('/app/api/stock/related')).body.ai.model, 'claude-haiku-5-5');
  assert.strictEqual((await admin.put('/app/api/stock/related-ai/model', { model: 'bestaat-niet' })).status, 400);
  // Rechten en andere organisatie.
  assert.strictEqual((await world.vreemd.get(`/app/api/stock/related/${head.id}`)).status, 404);
  assert.strictEqual((await world.vreemd.put(`/app/api/stock/related/${head.id}`, { relatedIds: [] })).status, 404, 'een andere organisatie kan niet wijzigen');
  assert.strictEqual((await world.vreemd.del(`/app/api/stock/related/${head.id}/${head.id}`)).status, 404, 'een andere organisatie kan niet verwijderen');
  const customer = createClient(world.base);
  assert.ok([401, 403].includes((await customer.get('/app/api/stock/related')).status));
  const shopper = world.shoppers[0].client;
  assert.strictEqual((await shopper.get('/app/api/stock/related')).status, 403, 'een ingelogde klant heeft geen recht voorraad');
  assert.strictEqual((await shopper.put(`/app/api/stock/related/${head.id}`, { relatedIds: [] })).status, 403);
  assert.strictEqual((await shopper.put('/app/api/stock/related-ai/model', { model: 'claude-haiku-5-5' })).status, 403);
  // Module uit: alles dicht.
  assert.strictEqual((await admin.put('/app/api/admin/modules', { flags: { 'gerelateerde-artikelen': false } })).status, 200);
  assert.strictEqual((await admin.get('/app/api/stock/related')).status, 409);
});

test('webshop: Past bij en Vaak samen besteld op de productpagina, alleen leverbaar, met bundelknop', async () => {
  const world = await setup();
  const { admin, base, db } = world;
  const tenantId = db.prepare("SELECT tenant_id FROM stock_items WHERE code = 'BUS'").get().tenant_id;
  let shopId = 100;
  /**
   * Maakt een artikel met een webshopproduct, zodat het in de catalogus staat.
   * @param {string} code De artikelcode.
   * @param {number} onHand Voorraad.
   * @param {number} salePrice Verkoopprijs.
   * @returns {Promise<object>} Het artikel.
   */
  const make = async (code, onHand, salePrice) => {
    const made = (await admin.post('/app/api/stock/items', { code, name: `Artikel ${code}`, unit: 'st', onHand, salePrice, vatRate: 21 })).body;
    shopId += 1;
    db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(tenantId, String(shopId), code, '', JSON.stringify(['Beregeningscomputers & regensensors']));
    db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND code = ?').run(String(shopId), tenantId, code);
    return made;
  };
  const main = await make('HOOFD', 5, 10);
  const fits = await make('PAST', 5, 4);
  const empty = await make('LEEG', 0, 3);
  const together = await make('SAMEN', 5, 6);
  assert.strictEqual((await admin.put(`/app/api/stock/related/${main.id}`, { relatedIds: [fits.id, empty.id] })).status, 200);
  db.prepare('INSERT INTO item_together (tenant_id, item_id, other_id, orders_both, orders_item, orders_other, lift, score) VALUES (?, ?, ?, 6, 8, 7, 4, 1.5)').run(tenantId, main.id, together.id);
  // De catalogus onthoudt zijn gegevens 30 seconden; een andere kortingsinstelling geeft meteen een nieuwe catalogus met de nieuwe artikelen.
  assert.strictEqual((await admin.put('/app/api/admin/category-discounts', { rules: [{ categorySlug: 'beregeningscomputers-en-regensensors', discountPct: 1 }] })).status, 200);
  const visitor = createClient(base);
  const page = await visitor.get('/product/artikel-hoofd-hoofd/');
  assert.strictEqual(page.status, 200);
  const html = page.text;
  assert.match(html, /<h2 id="related-fits">Past bij<\/h2>/);
  assert.match(html, /Artikel PAST/);
  assert.doesNotMatch(html, /Artikel LEEG/, 'niet leverbaar wordt weggelaten');
  assert.match(html, /<h2 id="related-together">Vaak samen besteld<\/h2>/);
  assert.match(html, /action="..\/..\/winkelwagen\/samen\/"/);
  assert.match(html, /Alles in winkelwagen/);
  // Het artikel zelf staat nooit in zijn eigen blok.
  assert.doesNotMatch(html.split('id="related-fits"')[1].split('id="related-together"')[0], /Artikel HOOFD/);
  // Meer dan vier: de eerste vier staan open, de rest achter *Bekijk meer* (details-blok, zonder script).
  const extra = [];
  for (const code of ['EXTRA1', 'EXTRA2', 'EXTRA3', 'EXTRA4', 'EXTRA5']) extra.push((await make(code, 5, 5)).id);
  assert.strictEqual((await admin.put(`/app/api/stock/related/${main.id}`, { relatedIds: [fits.id, ...extra] })).status, 200);
  assert.strictEqual((await admin.put('/app/api/admin/category-discounts', { rules: [{ categorySlug: 'beregeningscomputers-en-regensensors', discountPct: 2 }] })).status, 200);
  const many = (await visitor.get('/product/artikel-hoofd-hoofd/')).text;
  const fitsHtml = many.split('id="related-fits"')[1].split('id="related-together"')[0];
  const [openPart, morePart] = fitsHtml.split('<details class="related-more">');
  assert.ok(morePart, 'zes artikelen geven een Bekijk meer-blok');
  assert.match(morePart, /Bekijk meer \(2\)/);
  assert.strictEqual((openPart.match(/class="product-card/g) || []).length, 4, 'vier direct zichtbaar');
  assert.strictEqual((morePart.match(/class="product-card/g) || []).length, 2, 'twee achter Bekijk meer');
});

test('AI-ronde als achtergrondtaak: loopt op de server door, koppelt aan het eind en weigert een tweede start', async () => {
  const calls = { count: 0 };
  const table = {
    KOP: raw('sproeikop', [{ kind: 'draad', size: '1/2"', gender: 'binnen' }]),
    BEH: raw('behuizing', [{ kind: 'draad', size: '1/2"', gender: 'buiten' }]),
  };
  const { admin, customer } = await setup({ appOptions: { createSpecResearcher: fakeResearcher(table, calls), anthropicApiKey: 'sk-ant-test-test-test-test' } });
  await admin.post('/app/api/stock/items', { code: 'KOP', name: 'Sproeikop 1/2', onHand: 5, salePrice: 10 });
  await admin.post('/app/api/stock/items', { code: 'BEH', name: 'Behuizing 1/2', onHand: 5, salePrice: 10 });
  if (customer) {
    assert.strictEqual((await customer.get('/app/api/stock/related-ai/job')).status, 403);
    assert.strictEqual((await customer.post('/app/api/stock/related-ai/job', {})).status, 403);
  }
  assert.strictEqual((await admin.get('/app/api/stock/related-ai/job')).body.running, false);
  const started = await admin.post('/app/api/stock/related-ai/job', {});
  assert.strictEqual(started.status, 202, JSON.stringify(started.body));
  assert.ok(started.body.total >= 2);
  let job = (await admin.get('/app/api/stock/related-ai/job')).body;
  for (let round = 0; round < 100 && job.running; round += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    job = (await admin.get('/app/api/stock/related-ai/job')).body;
  }
  assert.strictEqual(job.running, false);
  assert.strictEqual(job.processed, job.total);
  assert.strictEqual(job.tally.gevonden, 2);
  assert.strictEqual(job.extra.links, 2, 'na het opzoeken is automatisch gekoppeld');
  assert.strictEqual((await admin.post('/app/api/stock/related-ai/job', {})).status, 409, 'niets meer aan de beurt');
});
