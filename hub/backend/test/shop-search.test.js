// Zoeken in de webshop: normaliseren, rangschikken (exacte code eerst), meervouden, verwante woorden, tikfouten en subartikelen.
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers/webshop-world');
const { createSearchMisses, MAX_TERMS } = require('../src/webshop/search-misses');
const { searchProducts, normalize, withinDistance, stemOf, stemsOf } = require('../src/webshop/search');

const CATALOG = [
  { code: 'MP2000', name: 'Hunter MP2000 sproeier', categoryName: 'Sproeiers', inStock: true },
  { code: 'SPR-10', name: 'Sprinklerset voor gazon', categoryName: 'Sets', inStock: false },
  { code: 'DR16', name: 'Druppelslang 16 mm', categoryName: 'Druppelleiding', inStock: true },
  { code: 'KLEP1', name: 'Magneetklep 24V', categoryName: 'Kleppen', inStock: true },
  { code: 'REGEN', name: 'Regensensor draadloos', categoryName: 'Sensoren', inStock: true },
  { code: 'KOP', name: 'Koppeling 32 mm', categoryName: 'Koppelingen', inStock: true, subItems: [{ code: 'KOP-25', label: '25 mm', inStock: false }, { code: 'KOP-32', label: '32 mm', inStock: true }] },
  { code: 'KOGEL', name: 'Kogelkraan 1 inch', categoryName: 'Afsluiters', inStock: true },
  { code: 'MPX', name: 'Onderdeel voor mp2000', categoryName: 'Overig', inStock: true },
];

/**
 * De codes van de gevonden producten, in volgorde.
 * @param {string} query De zoekterm.
 * @param {object} [options] Opties voor searchProducts.
 * @returns {string[]} De codes.
 */
const codesOf = (query, options) => searchProducts(CATALOG, query, options).products.map((product) => product.code);

test('normalize en stam: hoofdletters, accenten en leestekens', () => {
  assert.strictEqual(normalize('  Müller-Straat (24V) '), 'muller straat 24v');
  assert.strictEqual(normalize(null), '');
  assert.strictEqual(stemOf('sproeiers'), 'sproeier');
  assert.strictEqual(stemOf('kranen'), 'kran');
  assert.strictEqual(stemOf('pomp'), 'pomp');
});

test('withinDistance: tikfouten en omgewisselde letters', () => {
  assert.ok(withinDistance('sproeier', 'sproier', 1));
  assert.ok(withinDistance('sproeier', 'sproiear', 2));
  assert.ok(withinDistance('klep', 'kelp', 1), 'twee letters omgewisseld telt als één fout');
  assert.ok(!withinDistance('klep', 'kraan', 1));
  assert.ok(!withinDistance('abc', 'abd', 0));
});

test('exacte artikelcode staat bovenaan, ook als de naam van een ander product de code noemt', () => {
  assert.deepStrictEqual(codesOf('mp2000'), ['MP2000', 'MPX']);
  assert.strictEqual(codesOf('MP-2000')[0], 'MP2000', 'streepje of spatie in de code maakt niet uit');
  assert.strictEqual(codesOf('spr-10')[0], 'SPR-10');
  assert.deepStrictEqual(codesOf('SPR10'), ['SPR-10'], 'zonder streepje');
  assert.deepStrictEqual(codesOf('spr 10'), ['SPR-10'], 'met spatie');
  assert.deepStrictEqual(codesOf('kop32'), ['KOP'], 'subartikelcode zonder streepje');
});

test('een leeg of onbruikbaar zoekwoord geeft niets', () => {
  assert.deepStrictEqual(searchProducts(CATALOG, '   ').products, []);
  assert.deepStrictEqual(searchProducts(CATALOG, '%%%').products, []);
});

test('alle woorden moeten passen en delen van woorden tellen mee', () => {
  assert.deepStrictEqual(codesOf('druppel 16'), ['DR16']);
  assert.deepStrictEqual(codesOf('druppel 99'), []);
  assert.deepStrictEqual(codesOf('24v klep'), ['KLEP1']);
});

test('meervoud, verwante woorden en tikfouten vinden iets als er niets precies past', () => {
  const plural = searchProducts(CATALOG, 'sproeiers');
  assert.ok(plural.products.some((product) => product.code === 'MP2000'));
  const synonym = searchProducts(CATALOG, 'sprinkler');
  assert.strictEqual(synonym.widened, false, 'sprinkler staat precies in een naam');
  const related = searchProducts(CATALOG, 'timer');
  assert.deepStrictEqual(related.products, [], 'timer: geen product met stuurcomputer in dit assortiment');
  const typo = searchProducts(CATALOG, 'magneetkelp');
  assert.deepStrictEqual(typo.products.map((product) => product.code), ['KLEP1']);
  assert.strictEqual(typo.widened, true);
  const viaSynonym = searchProducts(CATALOG, 'ventiel');
  assert.deepStrictEqual(viaSynonym.products.map((product) => product.code), ['KLEP1']);
  assert.strictEqual(viaSynonym.widened, true);
  assert.deepStrictEqual(codesOf('regenmelder'), ['REGEN']);
});

test('een korte tikfout in een kort woord wordt niet geraden', () => {
  assert.deepStrictEqual(codesOf('klap'), []);
});

test('subartikelen: het woord moet bij één subartikel passen en het voorraadfilter volgt dat subartikel', () => {
  assert.deepStrictEqual(codesOf('koppeling 25'), ['KOP']);
  assert.deepStrictEqual(codesOf('koppeling 25', { onlyInStock: true }), []);
  assert.deepStrictEqual(codesOf('koppeling 32', { onlyInStock: true }), ['KOP']);
});

test('voorraadfilter en limiet', () => {
  assert.ok(!codesOf('sprinkler', { onlyInStock: true }).includes('SPR-10'));
  assert.strictEqual(searchProducts(CATALOG, 'mm', { limit: 1 }).products.length, 1);
});

test('zoekpagina: code, tikfout en melding bij ruimer zoeken', async () => {
  const world = await setup();
  const made = await world.admin.post('/app/api/stock/items', { code: 'MAGNEET', name: 'Magneetklep 24V', unit: 'st', onHand: 5, salePrice: 5, weightGrams: 100, vatRate: 21 });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const tenantId = world.db.prepare('SELECT tenant_id FROM stock_items WHERE code = ?').get('MAGNEET').tenant_id;
  world.db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(tenantId, 'MAGNEET', 'MAGNEET', '', JSON.stringify(['Overig']));
  world.db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND code = ?').run('MAGNEET', tenantId, 'MAGNEET');
  // De catalogus onthoudt zijn gegevens 30 seconden; een kortingsinstelling geeft meteen een nieuwe catalogus.
  assert.strictEqual((await world.admin.put('/app/api/admin/category-discounts', { rules: [{ categorySlug: 'beregeningscomputers-en-regensensors', discountPct: 1 }] })).status, 200);
  const client = world.shoppers[0].client;
  const exact = await client.request('GET', '/zoeken/?q=magneetklep');
  assert.match(exact.text, /magneetklep-24v-magneet/);
  assert.doesNotMatch(exact.text, /search-widened/);
  const typo = await client.request('GET', '/zoeken/?q=magneetkelp');
  assert.match(typo.text, /magneetklep-24v-magneet/);
  assert.match(typo.text, /search-widened/);
  const none = await client.request('GET', '/zoeken/?q=bestaatechtniet');
  assert.doesNotMatch(none.text, /magneetklep-24v-magneet/);
  // De zoekroute heeft een eigen limiet per bezoeker (40 per minuut).
  let limited = false;
  for (let attempt = 0; attempt < 45 && !limited; attempt += 1) limited = (await client.request('GET', `/zoeken/?q=term${attempt}`)).status === 429;
  assert.ok(limited, 'na 40 zoekopdrachten per minuut volgt 429');
});

test('meervouden met verdubbelde medeklinker of klinker en z of v', () => {
  assert.deepStrictEqual(stemsOf('kleppen'), ['klepp', 'klep']);
  assert.ok(stemsOf('kranen').includes('kraan'));
  assert.ok(stemsOf('buizen').includes('buis'));
  assert.ok(stemsOf('schroeven').includes('schroef'));
  assert.deepStrictEqual(stemsOf('pomp'), []);
  assert.deepStrictEqual(codesOf('magneetkleppen'), ['KLEP1']);
  assert.deepStrictEqual(codesOf('kranen'), ['KOGEL']);
  // Een vorm van drie tekens telt alleen als begin van een woord: koppen → kop vindt Koppeling niet als deelreeks midden in een woord.
  assert.deepStrictEqual(codesOf('koppen'), ['KOP'], 'kop is het begin van Koppeling');
  assert.deepStrictEqual(codesOf('oppen'), [], 'opp zit midden in koppeling en telt niet');
});

test('zoektermen zonder resultaat: tellen, normaliseren, geen persoonsgegevens, plafond en opruimen', async () => {
  const world = await setup();
  const tenantId = world.db.prepare('SELECT id FROM tenants ORDER BY created_at LIMIT 1').get().id;
  const other = world.db.prepare("SELECT id FROM tenants WHERE slug = 'ander'").get().id;
  const misses = createSearchMisses(world.db);
  assert.ok(misses.record(tenantId, '  Plantenspuit! '));
  assert.ok(misses.record(tenantId, 'plantenspuit'));
  assert.deepStrictEqual(misses.list(tenantId).map((row) => [row.term, row.hits]), [['plantenspuit', 2]]);
  assert.deepStrictEqual(misses.list(other), [], 'andere omgeving ziet niets');
  assert.ok(!misses.record(tenantId, 'a'), 'te kort');
  assert.ok(!misses.record(tenantId, 'x'.repeat(41)), 'te lang');
  assert.ok(!misses.record(tenantId, 'jan@voorbeeld.nl'), 'e-mailadres');
  assert.ok(!misses.record(tenantId, '0612345678'), 'lang cijfer');
  assert.strictEqual(misses.list(tenantId).length, 1);
  // Plafond: een volle omgeving laat de minst gezochte term vallen.
  for (let number = 0; number < MAX_TERMS + 5; number += 1) misses.record(tenantId, `term ${number}`);
  assert.strictEqual(misses.list(tenantId).length, MAX_TERMS);
  assert.strictEqual(misses.list(tenantId)[0].term, 'plantenspuit', 'de meest gezochte blijft staan');
  // Opruimen na 90 dagen.
  world.db.prepare("UPDATE shop_search_misses SET last_at = '2000-01-01T00:00:00.000Z' WHERE term = 'plantenspuit'").run();
  assert.strictEqual(misses.purgeOld(tenantId), 1);
});

test('zoekpagina telt een lege zoekopdracht, suggesties en het overzicht in Beheer', async () => {
  const world = await setup();
  const client = world.shoppers[0].client;
  await client.request('GET', '/zoeken/?q=bestaatechtniet');
  await client.request('GET', '/zoeken/?q=bestaatechtniet');
  await client.request('GET', '/zoeken/?q=sproeier&voorraad=1');
  await client.request('GET', '/zoeken/?q=niets&voorraad=1');
  const listed = await world.admin.get('/app/api/admin/shop-search-misses');
  assert.strictEqual(listed.status, 200);
  assert.deepStrictEqual(listed.body.items.map((row) => [row.term, row.hits]), [['bestaatechtniet', 2]], 'met voorraadfilter telt niet mee');
  assert.strictEqual((await world.vreemd.get('/app/api/admin/shop-search-misses')).body.items.length, 0, 'andere organisatie ziet niets');
  assert.strictEqual((await client.request('GET', '/app/api/admin/shop-search-misses')).status === 200, false, 'klant heeft geen toegang');
  // Suggesties.
  const suggestions = await client.request('GET', '/zoeken/suggesties/?q=sproei');
  assert.strictEqual(suggestions.status, 200);
  assert.match(suggestions.headers.get('cache-control'), /no-store/);
  assert.ok(suggestions.body.items.length >= 1 && suggestions.body.items.length <= 6);
  assert.deepStrictEqual(Object.keys(suggestions.body.items[0]).sort(), ['category', 'code', 'name', 'url']);
  assert.deepStrictEqual((await client.request('GET', '/zoeken/suggesties/?q=s')).body.items, [], 'te kort');
  assert.deepStrictEqual((await client.request('GET', '/zoeken/suggesties/')).body.items, []);
  // Suggesties tellen niet als zoekopdracht zonder resultaat.
  await client.request('GET', '/zoeken/suggesties/?q=bestaatechtniet2');
  assert.strictEqual((await world.admin.get('/app/api/admin/shop-search-misses')).body.items.length, 1);
  // De kop verwijst naar het script en het script wordt geserveerd.
  const home = await client.request('GET', '/zoeken/?q=x');
  assert.match(home.text, /data-suggest="\.\.\/zoeken\/suggesties\/"/);
  assert.match(home.text, /zoeksuggesties\.js/);
  const script = await client.request('GET', '/assets/zoeksuggesties.js');
  assert.strictEqual(script.status, 200);
  assert.match(script.type, /javascript/);
});
