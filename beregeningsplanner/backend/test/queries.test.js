// Databasequeries: hoeveel queries een verzoek kost en hoeveel er uit de
// database komt. Met PostgreSQL (Supabase) is elke query een rondgang over
// het netwerk; deze test bewaakt dat de lichte paden licht blijven.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createClient, listen } = require('./helpers/http-client');

const SECRET = 'q'.repeat(64);
const PASSWORD = 'Tuin-Plan-2026!';

/**
 * Telt queries en de omvang van wat ze teruggeven (alle tekst in de rijen).
 * @param {object} db De database (prepare wordt vervangen).
 * @returns {{ reset: Function, stats: object }} Tellers en een functie om ze op nul te zetten.
 */
function instrument(db) {
  const stats = { queries: 0, bytes: 0, sql: [] };
  /**
   * Omvang van een queryresultaat: lengte van alle waarden als tekst.
   * @param {*} value Rij, lijst van rijen of niets.
   * @returns {number} Aantal tekens.
   */
  const size = (value) => (value == null ? 0 : Array.isArray(value) ? value.reduce((sum, item) => sum + size(item), 0)
    : typeof value === 'object' ? Object.values(value).reduce((sum, field) => sum + (field == null ? 0 : String(field).length), 0) : 0);
  const prepare = db.prepare.bind(db);
  /**
   * Telt elke query van dit statement.
   * @param {string} sql De SQL.
   * @returns {object} Het statement, met getelde get/all/run.
   */
  db.prepare = (sql) => {
    const statement = prepare(sql);
    /**
     * Maakt een getelde versie van get, all of run.
     * @param {string} method Naam van de methode.
     * @returns {Function} De getelde methode.
     */
    const wrap = (method) => (...args) => {
      const result = statement[method](...args);
      stats.queries++;
      stats.bytes += size(result);
      stats.sql.push(sql.replace(/\s+/g, ' ').slice(0, 80));
      return result;
    };
    return new Proxy(statement, { get: (target, property) => (['get', 'all', 'run'].includes(property) ? wrap(property) : typeof target[property] === 'function' ? target[property].bind(target) : target[property]) });
  };
  // Ook de queries via db.async (de pool): die tellen even zwaar als een gewone query.
  const asyncDb = db.async;
  db.async = Object.fromEntries(['get', 'all', 'run'].map((method) => [method, async (sql, ...args) => {
    const result = await asyncDb[method](sql, ...args);
    stats.queries++;
    stats.bytes += size(result);
    stats.sql.push(sql.replace(/\s+/g, ' ').slice(0, 80));
    return result;
  }]));
  return {
    /** Zet de tellers op nul. */
    reset() { stats.queries = 0; stats.bytes = 0; stats.sql = []; },
    /**
     * De tellers: queries, bytes en de (ingekorte) SQL.
     * @returns {object} De tellers.
     */
    get stats() { return stats; },
  };
}

/**
 * Maakt een plan met één gazon en één sproeier.
 * @param {object} [extra] Velden die de standaard aanvullen of overschrijven.
 * @returns {object} De plangegevens.
 */
const plan = (extra = {}) => ({
  meta: { name: 'Tuin', customer: 'Fam. Jansen', address: 'Dorpsstraat 1' },
  areas: [{ id: 'a1', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }] }],
  sprinklers: [{ id: 's1', x: 1, y: 1, r: 4 }], zones: [], elements: [], ...extra,
});

test('queries: sessie in één query, opslaan zonder het plan terug te lezen, overzicht zonder achtergrond', async () => {
  const db = openDb();
  const store = createStore(db);
  await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PASSWORD });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db }));
  const client = createClient(base);
  try {
    assert.strictEqual((await client.post('/app/api/auth/login', { username: 'baas', password: PASSWORD })).status, 200);
    await client.get('/app/api/me');
    const probe = instrument(db);

    // Elk verzoek: sessie + gebruiker + tenant in één query, verder niets
    // (last_seen_at is net geschreven, het aantal beheerders is bekend).
    probe.reset();
    assert.strictEqual((await client.get('/app/api/account/profile')).status, 200);
    assert.strictEqual(probe.stats.queries, 1, probe.stats.sql.join('\n'));

    // Statische bestanden van een pagina: één sessiecontrole, daarna even geen query.
    probe.reset();
    for (const file of ['/app/shared/brand.css', '/app/dashboard/modules.js', '/app/shared/sidebar.js']) assert.strictEqual((await client.get(file)).status, 200, file);
    assert.ok(probe.stats.queries <= 1, probe.stats.sql.join('\n'));
    // Na uitloggen geen bestanden meer.
    const other = createClient(`http://127.0.0.1:${server.address().port}`);
    assert.strictEqual((await other.post('/app/api/auth/login', { username: 'baas', password: PASSWORD })).status, 200);
    assert.strictEqual((await other.get('/app/beheer/beheer.js')).status, 200);
    await other.post('/app/api/auth/logout');
    assert.strictEqual((await other.get('/app/beheer/beheer.js')).status, 401);

    // Een plan met een grote achtergrond (foto van de tekening).
    const background = { src: `data:image/png;base64,${'A'.repeat(400000)}` };
    const id = (await client.post('/app/api/plans', { data: plan({ background }) })).body.id;

    // Automatisch opslaan leest het plan niet terug uit de database.
    probe.reset();
    assert.strictEqual((await client.put(`/app/api/plans/${id}`, { data: plan({ background }) })).status, 200);
    assert.ok(probe.stats.bytes < 5000, `opslaan las ${probe.stats.bytes} tekens`);

    // Het overzicht haalt alleen de vlakken en aantallen op, niet de achtergrond of het hele plan.
    probe.reset();
    const list = (await client.get('/app/api/plans')).body.items;
    assert.deepStrictEqual(list[0].summary, { areas: 1, totalM2: 50, m2ByType: { lawn: 50 }, sprinklers: 1, zones: 0, elements: 0 });
    assert.ok(probe.stats.bytes < 5000, `overzicht las ${probe.stats.bytes} tekens`);
    assert.strictEqual(probe.stats.queries, 2);

    // Gebruikersbeheer stuurt nooit de wachtwoord-hash mee uit de database.
    probe.reset();
    assert.strictEqual((await client.get('/app/api/admin/users')).status, 200);
    assert.ok(!probe.stats.sql.some((sql) => /SELECT u\.\*/.test(sql)));

    // AI-kosten: vaste aantallen queries, ongeacht het aantal verzoeken
    // (sessie + totaal + per periode/gebruiker/functie/model; lijst: aantal + pagina).
    probe.reset();
    assert.strictEqual((await client.get('/app/api/admin/ai-usage')).status, 200);
    assert.strictEqual(probe.stats.queries, 6, probe.stats.sql.join('\n'));
    probe.reset();
    assert.strictEqual((await client.get('/app/api/admin/ai-usage/requests')).status, 200);
    assert.strictEqual(probe.stats.queries, 3, probe.stats.sql.join('\n'));

    // Klanten: de lijst kost een vast aantal queries (de pagina en het totaal), hoeveel klanten er ook zijn; de klantkaart ook.
    for (let index = 0; index < 30; index += 1) store.createCustomer(store.ensureTenant().id, { displayName: `Klant ${index}`, email: `k${index}@voorbeeld.nl` });
    probe.reset();
    const customerPage = (await client.get('/app/api/customers?limit=50')).body;
    assert.strictEqual(customerPage.items.length, 30);
    assert.ok(probe.stats.queries <= 4, probe.stats.sql.join('\n'));
    assert.ok(!probe.stats.sql.some((sql) => /SELECT \*|u\.\*/.test(sql)));
    probe.reset();
    assert.strictEqual((await client.get(`/app/api/customers/${customerPage.items[0].id}`)).status, 200);
    assert.ok(probe.stats.queries <= 6, probe.stats.sql.join('\n'));

    // Voorraad: overzicht in één query (stand + reserveringen samen), een
    // artikel in vier (artikel, reserveringen, mutaties, prijshistorie + voorraadlagen samen),
    // ongeacht het aantal artikelen en mutaties.
    assert.strictEqual((await client.post('/app/api/stock/import', { codes: ['PE-25', 'PE-32', 'FIT-T-25', 'VAL-24V', 'BOX-STD'] })).status, 200);
    probe.reset();
    const stock = (await client.get('/app/api/stock')).body.items;
    assert.strictEqual(stock.length, 5);
    assert.strictEqual(probe.stats.queries, 2, probe.stats.sql.join('\n'));
    probe.reset();
    assert.strictEqual((await client.get(`/app/api/stock/items/${stock[0].id}`)).status, 200);
    assert.strictEqual(probe.stats.queries, 5, probe.stats.sql.join('\n'));
    // Etiketten: de sjablonen komen uit de instellingen, de artikelen uit één query ongeacht het aantal.
    probe.reset();
    const labelRequest = await client.post('/app/api/stock/labels', { items: stock.map((item) => ({ id: item.id, qty: 2 })) });
    assert.strictEqual(labelRequest.status, 200, labelRequest.text.slice(0, 200));
    assert.strictEqual(probe.stats.sql.filter((statement) => /^SELECT i\.id, i\.code/.test(statement)).length, 1, probe.stats.sql.join('\n'));
    // Werkregistratie: vaste aantallen queries, ongeacht het aantal regels
    // (sessie + werkorder + uren + materiaal; urenstaat: sessie + uren + materiaal).
    const lines = [{ id: 'a', section: 'materiaal', description: 'Sproeier', qty: 4, unit: 'st', price: 10 }];
    const qid = (await client.post('/app/api/quotes', { data: { title: 'Aanleg', customer: { name: 'Fam. Jansen', address: 'Tuinstraat 1, 8071 AB Nunspeet' }, lines } })).body.id;
    await client.put(`/app/api/quotes/${qid}`, { status: 'akkoord' });
    const wo = (await client.post('/app/api/workorders', { quoteId: qid })).body;
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 5; i++) {
      assert.strictEqual((await client.post(`/app/api/workorders/${wo.id}/hours`, { workDate: day, hours: 1 })).status, 201);
      assert.strictEqual((await client.post(`/app/api/workorders/${wo.id}/materials`, { usedOn: day, description: 'Sproeier', qty: 1 })).status, 201);
    }
    probe.reset();
    assert.strictEqual((await client.get(`/app/api/workorders/${wo.id}/worklog`)).status, 200);
    assert.strictEqual(probe.stats.queries, 4, probe.stats.sql.join('\n'));
    probe.reset();
    assert.strictEqual((await client.get(`/app/api/worklog?from=${day}&to=${day}`)).status, 200);
    assert.strictEqual(probe.stats.queries, 3, probe.stats.sql.join('\n'));
    // Nacalculatie: vast aantal queries, ongeacht het aantal boekingen en artikelen
    // (sessie + werkorder + melding + offerte + uren + materiaal + facturen; zonder artikelcodes geen voorraadquery).
    probe.reset();
    assert.strictEqual((await client.get(`/app/api/workorders/${wo.id}/costing`)).status, 200);
    assert.strictEqual(probe.stats.queries, 7, probe.stats.sql.join('\n'));
    // Installatiedossier per locatie: vast aantal queries, niet per werkorder of melding.
    probe.reset();
    const locations = (await client.get('/app/api/locations')).body.items;
    assert.strictEqual(locations.length, 1);
    assert.ok(probe.stats.queries <= 4, probe.stats.sql.join('\n'));
    probe.reset();
    assert.strictEqual((await client.get(`/app/api/locations/${locations[0].key}`)).body.materials[0].used, 5);
    assert.ok(probe.stats.queries <= 7, probe.stats.sql.join('\n'));
    // Het werkorderoverzicht telt de geboekte uren met twee queries, niet per werkorder.
    probe.reset();
    assert.strictEqual((await client.get('/app/api/workorders')).body.items[0].logged.minutes, 300);
    assert.ok(probe.stats.queries <= 5, probe.stats.sql.join('\n'));
    // Facturen: overzicht en export in een vast aantal queries, ongeacht het
    // aantal facturen (geen query per factuur of regel).
    for (let i = 0; i < 4; i++) {
      const inv = (await client.post('/app/api/invoices', { data: { customer: { name: `Klant ${i}` }, lines: [{ description: 'Sproeier', qty: 2, price: 10 }] } })).body;
      assert.strictEqual((await client.post(`/app/api/invoices/${inv.id}/finalize`, {})).status, 200);
    }
    probe.reset();
    assert.strictEqual((await client.get('/app/api/invoices')).body.items.length, 4);
    assert.ok(probe.stats.queries <= 2, probe.stats.sql.join('\n'));
    probe.reset();
    assert.strictEqual((await client.get('/app/api/invoices/export')).body.items.length, 4);
    assert.ok(probe.stats.queries <= 2, probe.stats.sql.join('\n'));
    // Debiteuren met aantal facturen en openstaand bedrag: één query.
    probe.reset();
    assert.strictEqual((await client.get('/app/api/debtors')).body.items.length, 4);
    assert.ok(probe.stats.queries <= 2, probe.stats.sql.join('\n'));
    // Sproeierbibliotheek: alle eigen regels in één query (sessie + bibliotheek).
    const Lib = require('../../frontend/beregening/js/sprinklerlib.js');
    const own = { bodies: Lib.DEFAULTS.bodies.map((body) => ({ ...body, key: `X-${body.key}` })), nozzles: Lib.DEFAULTS.nozzles.map((nozzle) => ({ ...nozzle, key: `X-${nozzle.key}` })) };
    assert.strictEqual((await client.put('/app/api/sprinkler-library', own)).status, 200);
    probe.reset();
    assert.strictEqual((await client.get('/app/api/sprinkler-library')).body.own.nozzles.length, own.nozzles.length);
    assert.ok(probe.stats.queries <= 2, probe.stats.sql.join('\n'));
    // Visma-status: wachtende facturen in één telling.
    probe.reset();
    assert.strictEqual((await client.get('/app/api/visma')).body.connected, false);
    assert.ok(probe.stats.queries <= 2, probe.stats.sql.join('\n'));
    // Visma-logboek: één pagina is één query (plus de sessie).
    probe.reset();
    assert.deepStrictEqual((await client.get('/app/api/visma/log')).body, { items: [], next: null });
    assert.ok(probe.stats.queries <= 2, probe.stats.sql.join('\n'));
  } finally {
    server.close();
  }
});

test('queries: leveranciers en inkooporders kosten een vast aantal queries, ongeacht het aantal regels', async () => {
  const db = openDb();
  const store = createStore(db);
  await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PASSWORD });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db }));
  const client = createClient(base);
  try {
    assert.strictEqual((await client.post('/app/api/auth/login', { username: 'baas', password: PASSWORD })).status, 200);
    const supplier = (await client.post('/app/api/suppliers', { name: 'Tuintechniek' })).body;
    const lines = [];
    for (let index = 0; index < 12; index += 1) {
      const item = (await client.post('/app/api/stock/items', { code: `Q-${index}`, name: `Artikel ${index}`, minQty: 5, costPrice: 1 })).body;
      await client.put(`/app/api/stock/items/${item.id}/suppliers`, { suppliers: [{ supplierId: supplier.id, orderQty: 5 }] });
      lines.push({ itemId: item.id, qty: 10 });
    }
    for (let count = 0; count < 3; count += 1) assert.strictEqual((await client.post('/app/api/purchase-orders', { supplierId: supplier.id, lines })).status, 201);
    const probe = instrument(db);
    // Leveranciers met aantal artikelen: een telling in één query (plus de sessie).
    probe.reset();
    assert.strictEqual((await client.get('/app/api/suppliers')).body.items.length, 1);
    assert.ok(probe.stats.queries <= 3, probe.stats.sql.join('\n'));
    // Orderlijst: orders en de som van de regels, niet een query per order.
    probe.reset();
    assert.strictEqual((await client.get('/app/api/purchase-orders')).body.items.length, 3);
    assert.ok(probe.stats.queries <= 3, probe.stats.sql.join('\n'));
    // Eén order met 12 regels: de order en zijn regels.
    const id = (await client.get('/app/api/purchase-orders')).body.items[0].id;
    probe.reset();
    assert.strictEqual((await client.get(`/app/api/purchase-orders/${id}`)).body.lines.length, 12);
    assert.ok(probe.stats.queries <= 3, probe.stats.sql.join('\n'));
    // Onderweg per artikel: één query.
    probe.reset();
    assert.strictEqual((await client.get('/app/api/purchase-orders/incoming')).body.items.length, 12);
    assert.ok(probe.stats.queries <= 2, probe.stats.sql.join('\n'));
    // Bestelvoorstel met voorkeursleveranciers en onderweg: een vast aantal, niet per artikel.
    probe.reset();
    assert.strictEqual((await client.get('/app/api/stock/reorder')).status, 200);
    assert.ok(probe.stats.queries <= 8, probe.stats.sql.join('\n'));
    // Prijsfactor: het voorbeeld van 12 artikelen in een vast aantal queries; doorvoeren ook niet per artikel opnieuw berekenen.
    assert.strictEqual((await client.put('/app/api/stock/price-factors', { defaultFactor: 2 })).status, 200);
    const ids = (await client.get('/app/api/stock')).body.items.map((item) => item.id);
    for (const id of ids) assert.strictEqual((await client.put(`/app/api/stock/items/${id}`, { priceMode: 'factor' })).status, 200);
    db.prepare('UPDATE stock_items SET cost_price = 2').run();
    probe.reset();
    const factorView = (await client.get('/app/api/stock/price-factors')).body;
    assert.strictEqual(factorView.preview.length, 12);
    assert.ok(probe.stats.queries <= 8, probe.stats.sql.join('\n'));
    probe.reset();
    const changes = factorView.preview.filter((row) => row.changed).map((row) => ({ id: row.id, newPrice: row.newPrice }));
    assert.strictEqual((await client.post('/app/api/stock/price-factors/apply', { items: changes })).body.updated, changes.length);
    assert.ok(probe.stats.queries <= 8 + changes.length * 2, probe.stats.sql.join('\n'));
  } finally {
    server.close();
  }
});

// Wens Daniël (2026-10-20): nergens SELECT * of t.*; elke query noemt de
// kolommen die hij nodig heeft (COUNT(*) mag).
test('queries: geen SELECT * in de backend', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src');
  const hits = [];
  const files = fs.readdirSync(dir, { recursive: true }).filter((file) => file.endsWith('.js'));
  assert.ok(files.some((file) => file.includes(path.sep)), 'ook de submappen van src/ worden doorzocht');
  for (const file of files) {
    fs.readFileSync(path.join(dir, file), 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/COUNT\(\*\)/gi, '');
      if (/^\s*\/\//.test(line)) return;
      if (/SELECT\s+\*|\b[a-z]\.\*(\s|,)/i.test(code)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(hits, []);
});

test('webshop: met een warme cache kost een shop-pagina geen query, ook de productpagina met omschrijving niet (1)', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PASSWORD, mustChangePassword: false }, { platformAdmin: true });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db }));
  try {
    const admin = createClient(base);
    assert.strictEqual((await admin.post('/app/api/auth/login', { username: 'baas', password: PASSWORD })).status, 200);
    assert.strictEqual((await admin.post('/app/api/stock/items', { code: 'SPR-1', name: 'Sproeier Pro', onHand: 5, salePrice: 10 })).status, 201);
    assert.strictEqual((await admin.put('/app/api/admin/settings', { storefront: true, shopPayment: { online: false, publicUrl: `${base}/` } })).status, 200);
    const visitor = createClient(base);
    const counter = instrument(db);
    for (const url of ['/', '/product/sproeier-pro-spr-1/', '/zoeken/?q=spr']) assert.strictEqual((await visitor.get(url)).status, 200);
    counter.reset();
    for (const url of ['/', '/product/sproeier-pro-spr-1/', '/zoeken/?q=spr', '/categorie/overig/']) await visitor.get(url);
    assert.strictEqual(counter.stats.queries, 0, counter.stats.sql.join('\n'));
    // Met categoriekortingen blijft een warme shop-pagina ook zonder query.
    const saved = await admin.put('/app/api/admin/category-discounts', { rules: [{ categorySlug: 'druppelslang-toebehoren', discountPct: 10 }] });
    assert.strictEqual(saved.status, 200);
    for (const url of ['/', '/product/sproeier-pro-spr-1/']) assert.strictEqual((await visitor.get(url)).status, 200);
    counter.reset();
    for (const url of ['/', '/product/sproeier-pro-spr-1/', '/zoeken/?q=spr']) await visitor.get(url);
    assert.strictEqual(counter.stats.queries, 0, counter.stats.sql.join('\n'));
  } finally {
    server.close();
  }
});
