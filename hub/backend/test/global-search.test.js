// Globaal zoeken: zoekt in klanten, offertes, werkorders, facturen en artikelen, alleen waar het recht voor is,
// alleen in de eigen omgeving, met begrensde groepen en zonder jokertekens uit de invoer.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { wordsOf, matchClause } = require('../src/platform/global-search');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

test('zoekwoorden: kleine letters, hoogstens vijf, jokertekens worden onschadelijk', () => {
  assert.deepStrictEqual(wordsOf('  Groen  BV '), ['groen', 'bv']);
  assert.strictEqual(wordsOf('a b c d e f g').length, 5);
  assert.deepStrictEqual(wordsOf(null), []);
  const clause = matchClause(['50%_x'], ['name']);
  assert.deepStrictEqual(clause.args, ['%50\\%\\_x%']);
  assert.match(clause.sql, /ESCAPE/);
});

test('zoeken: rechten per soort, eigen omgeving, geen resultaat bij te korte tekst', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'anne', displayName: 'Anne', role: 'beheerder', password: PW });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'pia', displayName: 'Pia', role: 'picker', password: PW });
  await store.createAccount(main, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW });
  const other = store.createTenant({ name: 'Blauw BV', slug: 'blauw' }).tenant;
  const app = createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db });
  const { server, base } = await listen(app);
  const as = createLogin(base, { password: PW, extraBody: { mustChangePassword: false } });
  try {
    const anne = await as('anne'), kees = await as('kees'), pia = await as('pia'), klaas = await as('klaas');
    const klant = (await anne.post('/app/api/customers', { displayName: 'Groenman Tuinen', email: 'groenman@voorbeeld.test', customerGroup: '' })).body.customer;
    assert.ok(klant.id, JSON.stringify(klant));
    const data = { title: 'Beregening Groenstraat', customer: { name: 'Groenman Tuinen' }, lines: [{ section: 'materiaal', description: 'Sproeier', qty: 1, unit: 'st', price: 20, vat: 21 }] };
    const quote = (await kees.post('/app/api/quotes', { data })).body;
    await kees.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' });
    const workOrder = (await kees.post('/app/api/workorders', { quoteId: quote.id })).body;
    const item = (await anne.post('/app/api/stock/items', { code: 'GRN-001', name: 'Groene slang 25 mm', unit: 'm', ean: '' })).body;
    assert.ok(item.id, JSON.stringify(item));
    // Een artikel en een offerte van een andere omgeving mogen nooit verschijnen.
    db.prepare('INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, on_hand, cost_price, notes, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 0, ?, ?)')
      .run('x-1', other.id, 'GRN-999', 'Groene vreemde', 'st', '', '', new Date().toISOString(), new Date().toISOString());

    /**
     * De sleutels van de groepen in een zoekantwoord.
     * @param {{ body: { groups: { key: string }[] } }} response Het antwoord.
     * @returns {string[]} De sleutels.
     */
    const groupsOf = (response) => response.body.groups.map((group) => group.key);
    // Beheerder: alles wat Groen heet.
    const found = await anne.get('/app/api/search?q=groen');
    assert.strictEqual(found.status, 200);
    assert.deepStrictEqual(groupsOf(found).sort(), ['artikelen', 'klanten', 'offertes', 'werkorders']);
    const articles = found.body.groups.find((group) => group.key === 'artikelen').items;
    assert.deepStrictEqual(articles.map((entry) => entry.title), ['GRN-001 Groene slang 25 mm'], 'andere omgeving blijft buiten beeld');
    assert.match(articles[0].href, /^artikelen\/\?id=/);
    assert.ok(found.body.groups.find((group) => group.key === 'klanten').items[0].href.startsWith('klanten/?id='));
    // Op nummer, hoofdletterongevoelig en met meerdere woorden.
    assert.deepStrictEqual((await anne.get(`/app/api/search?q=${encodeURIComponent(quote.number.toLowerCase())}`)).body.groups.map((group) => group.key).includes('offertes'), true);
    assert.deepStrictEqual(groupsOf(await anne.get('/app/api/search?q=beregening%20groenstraat')), ['offertes', 'werkorders']);
    assert.ok(workOrder.id);
    // Een factuur uit de werkorder is te vinden op klantnaam, alleen met het recht Facturen.
    const invoice = await anne.post('/app/api/invoices', { workOrderId: workOrder.id });
    assert.strictEqual(invoice.status, 201, JSON.stringify(invoice.body));
    const invoices = (await anne.get('/app/api/search?q=groenman')).body.groups.find((group) => group.key === 'facturen');
    assert.ok(invoices && invoices.items[0].href.startsWith('facturen/?id='));
    // Een installateur heeft geen recht op facturen en ziet dus nooit die groep.
    assert.ok(!groupsOf(await kees.get('/app/api/search?q=groen')).includes('facturen'));
    // Een picker heeft geen enkel zoekrecht, een klant ook niet; zonder login geen toegang.
    assert.deepStrictEqual((await pia.get('/app/api/search?q=groen')).body.groups, []);
    assert.deepStrictEqual((await klaas.get('/app/api/search?q=groen')).body.groups, []);
    assert.strictEqual((await fetch(`${base}/app/api/search?q=groen`)).status, 401);
    // Te korte tekst en jokertekens.
    assert.deepStrictEqual((await anne.get('/app/api/search?q=g')).body.groups, []);
    assert.deepStrictEqual((await anne.get('/app/api/search?q=%25')).body.groups, []);
    assert.deepStrictEqual((await anne.get('/app/api/search?q=_____')).body.groups, []);
    // Een andere omgeving ziet de resultaten van deze niet.
    await store.createAccount(other.id, { username: 'bram', displayName: 'Bram', role: 'beheerder', password: PW });
    const bram = await as('bram', 'blauw');
    const foreign = await bram.get('/app/api/search?q=groen');
    assert.deepStrictEqual(foreign.body.groups.map((group) => [group.key, group.items.map((entry) => entry.title)]), [['artikelen', ['GRN-999 Groene vreemde']]]);
  } finally {
    server.close();
  }
});
