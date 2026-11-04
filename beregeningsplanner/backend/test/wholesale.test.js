// Groothandelsvenster in de eigen webshop (/winkel/groothandel/): groothandelsklanten
// met een vaste korting, staffelkorting, verpakkingseenheid en minimale afname per
// artikel, de snelbestellijst, bestellen op artikelcode en opnieuw bestellen.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const Wholesale = require('../src/webshop/wholesale');
const { addCartLines, applyCartAction, cartActionRejected } = require('../src/webshop/storefront-cart');
const { createLogin, createClient, listen, postForm, postCheckout } = require('./helpers/http-client');

const SECRET = 'e'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/** Bedrijfsgegevens voor een zakelijke aanvraag. */
const COMPANY = { companyName: 'Groothandel Tuinzaken BV', kvkNumber: '12345678', vatNumber: 'NL123456789B01' };

test('staffels: opschonen, sorteren en weigeren', () => {
  assert.deepStrictEqual(Wholesale.sanitizeTiers([{ minQty: 100, discountPct: 15 }, { minQty: 50, discountPct: '10' }]).tiers,
    [{ minQty: 50, discountPct: 10 }, { minQty: 100, discountPct: 15 }]);
  assert.deepStrictEqual(Wholesale.sanitizeTiers(undefined).tiers, []);
  assert.deepStrictEqual(Wholesale.tiersOf('[{"minQty":10,"discountPct":5}]'), [{ minQty: 10, discountPct: 5 }]);
  assert.deepStrictEqual(Wholesale.tiersOf('kapot'), [], 'ongeldige opslag geeft geen staffels');
  for (const bad of [[{ minQty: 1, discountPct: 5 }], [{ minQty: 10, discountPct: 0 }], [{ minQty: 10, discountPct: 95 }], [{ minQty: 2.5, discountPct: 5 }],
    [{ minQty: 10, discountPct: 5 }, { minQty: 10, discountPct: 6 }], 'geen lijst', Array.from({ length: 6 }, (_, index) => ({ minQty: 10 + index, discountPct: 5 }))]) {
    assert.ok(Wholesale.sanitizeTiers(bad).error, JSON.stringify(bad));
  }
});

test('voorwaarden: minimale afname wordt een veelvoud van de verpakkingseenheid', () => {
  assert.deepStrictEqual(Wholesale.sanitizeTerms({}), { packSize: 1, orderMinQty: 1 });
  assert.deepStrictEqual(Wholesale.sanitizeTerms({ packSize: 25, orderMinQty: 30 }), { packSize: 25, orderMinQty: 50 });
  assert.strictEqual(Wholesale.sanitizeTerms({ packSize: 0 }).field, 'packSize');
  assert.strictEqual(Wholesale.sanitizeTerms({ orderMinQty: 1.5 }).field, 'orderMinQty');
  assert.strictEqual(Wholesale.sanitizeTerms({ packSize: 10000, orderMinQty: 1 }).field, 'orderMinQty');
  const terms = { packSize: 25, orderMinQty: 50 };
  assert.strictEqual(Wholesale.minimumOf(terms), 50);
  assert.strictEqual(Wholesale.roundUpQty(30, terms), 50);
  assert.strictEqual(Wholesale.roundUpQty(51, terms), 75);
  assert.strictEqual(Wholesale.roundUpQty(100, terms), 100);
  assert.strictEqual(Wholesale.quantityProblem(100, terms), '');
  assert.match(Wholesale.quantityProblem(30, terms), /Minimaal 50.*per 25/);
  assert.match(Wholesale.quantityProblem(60, terms), /Alleen per 25/);
});

test('prijs: de grootste van staffelkorting en klantkorting, niet opgeteld', () => {
  const tiers = [{ minQty: 50, discountPct: 10 }, { minQty: 100, discountPct: 15 }];
  assert.deepStrictEqual(Wholesale.wholesalePrice(10, 10, tiers, 0), { unitExcl: 10, discountPct: 0, source: '' });
  assert.deepStrictEqual(Wholesale.wholesalePrice(10, 50, tiers, 0), { unitExcl: 9, discountPct: 10, source: 'staffel' });
  assert.deepStrictEqual(Wholesale.wholesalePrice(10, 100, tiers, 5), { unitExcl: 8.5, discountPct: 15, source: 'staffel' });
  assert.deepStrictEqual(Wholesale.wholesalePrice(10, 60, tiers, 20), { unitExcl: 8, discountPct: 20, source: 'klant' });
  assert.strictEqual(Wholesale.wholesalePrice(9.99, 1, [], 5).unitExcl, 9.49, 'afgerond op centen');
});

test('geplakte lijst: tab, puntkomma, x, dubbele codes, kopregel en fouten', () => {
  const parsed = Wholesale.parseOrderList('Artikelcode\tAantal\nsp-100\t50\nDR-16;200\r\nsp-100 x 25\n\nLOSSE-CODE\n"AB 12" 5\n;3\nCODE 0');
  assert.deepStrictEqual(parsed.entries, [{ code: 'SP-100', qty: 75 }, { code: 'DR-16', qty: 200 }, { code: 'LOSSE-CODE', qty: 1 }, { code: 'AB 12', qty: 5 }]);
  assert.strictEqual(parsed.problems.length, 2, 'de regel zonder code en de regel met aantal 0');
  assert.deepStrictEqual(parsed.problems.map((problem) => problem.line), [8, 9]);
  assert.strictEqual(Wholesale.parseOrderList('').entries.length, 0);
  const huge = Wholesale.parseOrderList(`A${' '.repeat(5000)}b\nOK 2`);
  assert.deepStrictEqual(huge.entries, [{ code: 'OK', qty: 2 }], 'een te lange regel wordt overgeslagen');
  assert.match(huge.problems[0].message, /te lang/);
  const long = Wholesale.parseOrderList(Array.from({ length: Wholesale.MAX_PASTE_LINES + 5 }, (_, index) => `C${index}\t1`).join('\n'));
  assert.strictEqual(long.entries.length, Wholesale.MAX_PASTE_LINES);
  assert.ok(long.truncated);
});

test('winkelwagen: een gewone toevoeging die niet meer past wordt als geweigerd herkend', () => {
  const full = Array.from({ length: 60 }, (_, index) => ({ code: `ART-${index}`, qty: 1 }));
  const after = applyCartAction(full, { action: 'add', code: 'NIEUW', qty: '1' });
  assert.strictEqual(after.length, 60);
  assert.ok(cartActionRejected(full, after, { action: 'add', code: 'NIEUW', qty: '1' }));
  const raised = applyCartAction(full, { action: 'set', code: 'ART-1', qty: '5' });
  assert.ok(!cartActionRejected(full, raised, { action: 'set', code: 'ART-1', qty: '5' }));
});

test('winkelwagen: een gecombineerd aantal boven het maximum wordt niet stil afgekapt', () => {
  const { lines, skipped } = addCartLines([{ code: 'A', qty: 9990 }], [{ code: 'A', qty: 10 }]);
  assert.deepStrictEqual(skipped, ['A']);
  assert.strictEqual(lines[0].qty, 9990);
});

test('winkelwagen: bulk bijvoegen, en wat niet past wordt gemeld', () => {
  const { lines, skipped } = addCartLines([{ code: 'A', qty: 5 }], [{ code: 'A', qty: 100 }, { code: 'B', qty: 12000 }]);
  assert.deepStrictEqual(lines, [{ code: 'A', qty: 105 }, { code: 'B', qty: 9999 }]);
  assert.deepStrictEqual(skipped, []);
  const many = addCartLines([], Array.from({ length: 80 }, (_, index) => ({ code: `ARTIKEL-${index}`, qty: 1 })));
  assert.strictEqual(many.lines.length, 60);
  assert.strictEqual(many.skipped.length, 20);
  // Vul de wagen tot er niets meer bij past; verhoog daarna één aantal tot de cookiegrens dat niet meer toelaat.
  let cart = [];
  for (let index = 0; index < 60; index += 1) {
    const filled = addCartLines(cart, [{ code: `LANGE-ARTIKELCODE-VOOR-COOKIE-${index}-${'X'.repeat(20)}`, qty: 1 }]);
    if (filled.skipped.length) break;
    cart = filled.lines;
  }
  // Elke regel krijgt er 9000 bij: het eerste aantal dat de cookie te groot maakt wordt geweigerd en blijft zoals het was.
  let blocked = null;
  let blockedCode = '';
  for (const line of cart) {
    const raised = addCartLines(cart, [{ code: line.code, qty: 9000 }]);
    if (raised.skipped.length) { blocked = raised; blockedCode = line.code; break; }
    cart = raised.lines;
  }
  assert.ok(blocked, 'een hoger aantal stuit uiteindelijk op de cookiegrens');
  assert.deepStrictEqual(blocked.skipped, [blockedCode]);
  assert.strictEqual(blocked.lines.find((line) => line.code === blockedCode).qty, 1, 'het aantal blijft ongewijzigd');
});

/**
 * Hoofdtenant met beheerder, een andere organisatie, artikelen met groothandelsvoorwaarden en een winkel die bestellen toestaat.
 * @returns {Promise<object>} base, admin, vreemd en shopper() om een klant te registreren.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  await admin.put('/api/admin/settings', { storefront: true, shopOrdering: true });
  await admin.post('/api/stock/items', { code: 'SPR', name: 'Sproeier groothandel', onHand: 5000, salePrice: 10, businessPrice: 8,
    packSize: 25, orderMinQty: 50, priceTiers: [{ minQty: 100, discountPct: 15 }] });
  await admin.post('/api/stock/items', { code: 'SLANG', name: 'Slangklem', onHand: 5000, salePrice: 5 });
  let counter = 0;
  /**
   * Registreert een klant in de shop, optioneel als zakelijke of groothandelsklant (door de beheerder goedgekeurd).
   * @param {{ business?: boolean, wholesale?: boolean, discount?: number }} [options] Welke klantgroep de klant krijgt.
   * @returns {Promise<object>} client en id van het account.
   */
  const shopper = async ({ business = false, wholesale = false, discount } = {}) => {
    counter += 1;
    const client = createClient(base);
    await postForm(base, client, '/winkel/registreren/', { displayName: `Klant ${counter}`, email: `g${counter}@voorbeeld.nl`, password: PW, password2: PW, website: '' });
    const user = (await admin.get('/api/admin/users')).body.items.find((candidate) => candidate.email === `g${counter}@voorbeeld.nl`);
    if (business) await admin.patch(`/api/admin/users/${user.id}`, { customerGroup: 'zakelijk', ...COMPANY });
    if (wholesale) assert.strictEqual((await admin.patch(`/api/admin/users/${user.id}`, { wholesale: true, ...(discount !== undefined ? { wholesaleDiscount: discount } : {}) })).status, 200);
    return { client, id: user.id };
  };
  return { base, admin, vreemd: await createLogin(base, { password: PW })('vreemd', 'ander'), shopper };
}

/**
 * Leest uit de winkelwagenpagina het totaal aantal stuks en de stukprijs van een artikel.
 * @param {object} client De client.
 * @returns {Promise<string>} De HTML van de winkelwagen.
 */
async function cartHtml(client) {
  return (await client.get('/winkel/winkelwagen/')).text;
}

test('beheer: groothandel alleen bij een zakelijke klant, korting 0-50%, particulier maken wist het', async () => {
  const { admin, vreemd, shopper } = await setup();
  const person = await shopper();
  const refused = await admin.patch(`/api/admin/users/${person.id}`, { wholesale: true });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.body.message, /zakelijke klant/);
  assert.strictEqual((await admin.patch(`/api/admin/users/${person.id}`, { customerGroup: 'zakelijk', wholesale: true, wholesaleDiscount: 7.5 })).status, 200);
  const user = (await admin.get('/api/admin/users')).body.items.find((candidate) => candidate.id === person.id);
  assert.strictEqual(user.wholesale, true);
  assert.strictEqual(user.wholesaleDiscount, 7.5);
  for (const bad of [-1, 51, 'abc', '']) assert.strictEqual((await admin.patch(`/api/admin/users/${person.id}`, { wholesaleDiscount: bad })).status, 400, String(bad));
  assert.strictEqual((await vreemd.patch(`/api/admin/users/${person.id}`, { wholesale: false })).status, 404, 'andere organisatie');
  assert.strictEqual((await person.client.patch(`/api/admin/users/${person.id}`, { wholesale: false })).status, 403, 'klant zelf');
  await admin.patch(`/api/admin/users/${person.id}`, { customerGroup: '' });
  const reset = (await admin.get('/api/admin/users')).body.items.find((candidate) => candidate.id === person.id);
  assert.strictEqual(reset.wholesale, false);
  assert.strictEqual(reset.wholesaleDiscount, 0);
});

test('artikel: voorwaarden en staffels opslaan, controleren en terugkrijgen', async () => {
  const { admin, vreemd } = await setup();
  const items = (await admin.get('/api/stock')).body.items;
  const sprayer = items.find((item) => item.code === 'SPR');
  assert.strictEqual(sprayer.packSize, 25);
  assert.strictEqual(sprayer.orderMinQty, 50);
  assert.deepStrictEqual(sprayer.priceTiers, [{ minQty: 100, discountPct: 15 }]);
  const clamp = await admin.put(`/api/stock/items/${sprayer.id}`, { packSize: 40, orderMinQty: 50 });
  assert.strictEqual(clamp.status, 200);
  assert.strictEqual(clamp.body.orderMinQty, 80, 'de minimale afname wordt een veelvoud van de eenheid');
  assert.deepStrictEqual(clamp.body.priceTiers, [{ minQty: 100, discountPct: 15 }], 'staffels blijven bij een deelwijziging staan');
  assert.strictEqual((await admin.put(`/api/stock/items/${sprayer.id}`, { priceTiers: [{ minQty: 1, discountPct: 5 }] })).status, 400);
  assert.strictEqual((await admin.put(`/api/stock/items/${sprayer.id}`, { packSize: 0 })).status, 400);
  assert.strictEqual((await vreemd.put(`/api/stock/items/${sprayer.id}`, { packSize: 2 })).status, 404, 'andere organisatie');
  await admin.put(`/api/stock/items/${sprayer.id}`, { packSize: 25, orderMinQty: 50 });
});

test('groothandelsvenster: alleen voor groothandelsklanten', async () => {
  const { base, shopper } = await setup();
  const anonymous = createClient(base, { followRedirects: false });
  const guest = await anonymous.get('/winkel/groothandel/');
  assert.strictEqual(guest.status, 302);
  assert.match(guest.location, /inloggen/);
  const person = await shopper();
  const business = await shopper({ business: true });
  const wholesale = await shopper({ business: true, wholesale: true });
  for (const client of [person.client, business.client]) {
    assert.strictEqual((await client.get('/winkel/groothandel/')).status, 404);
    assert.strictEqual((await postForm(base, client, '/winkel/groothandel/', { action: 'plakken', lijst: 'SPR 50' })).status, 404);
    assert.doesNotMatch((await client.get('/winkel/')).text, /groothandel\//, 'geen kopje Groothandel');
  }
  const page = await wholesale.client.get('/winkel/groothandel/');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Sproeier groothandel/);
  assert.match(page.text, /name="q:SPR"/);
  assert.match(page.text, /per 25, min\. 50/);
  assert.match(page.text, /vanaf 100: € 6,80/, 'staffelprijs 15% op 8,00 excl. btw');
  assert.match((await wholesale.client.get('/winkel/')).text, /href="groothandel\/">Groothandel/);
  assert.strictEqual((await postForm(base, wholesale.client, '/winkel/groothandel/', { action: 'plakken', lijst: 'SPR 50' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
});

test('snelbestellijst: aantallen worden afgerond, staffel- en klantkorting rekenen mee', async () => {
  const { base, shopper } = await setup();
  const wholesale = await shopper({ business: true, wholesale: true });
  const list = await postForm(base, wholesale.client, '/winkel/groothandel/', { action: 'bestellen', 'q:SPR': '30', 'q:SLANG': '120', 'q:LEEG': '' });
  assert.strictEqual(list.status, 200, 'er is een aanpassing te melden, dus de pagina blijft staan');
  assert.match(list.text, /SPR: 30 → 50/);
  assert.match(list.text, /2 artikelen in je winkelwagen/);
  let cart = await cartHtml(wholesale.client);
  assert.match(cart, /value="50" min="0" max="9999"/);
  assert.match(cart, /value="120"/, 'meer dan 99 stuks kan');
  assert.match(cart, /€\s8,00/, 'zonder staffel de zakelijke prijs excl. btw');
  // Meer bestellen: bij 100 stuks geldt de staffel van 15%.
  const more = await postForm(base, wholesale.client, '/winkel/groothandel/', { action: 'bestellen', 'q:SPR': '50' });
  assert.strictEqual(more.status, 303, 'alles gelukt zonder melding: door naar de winkelwagen');
  assert.match(more.location, /winkelwagen/);
  cart = await cartHtml(wholesale.client);
  assert.match(cart, /value="100"/);
  assert.match(cart, /€\s6,80/);
  assert.match(cart, /15% staffelkorting/);
  const empty = await postForm(base, wholesale.client, '/winkel/groothandel/', { action: 'bestellen', 'q:SPR': '' });
  assert.strictEqual(empty.status, 200);
  assert.match(empty.text, /minstens één artikel/);
});

test('vaste klantkorting wint van een kleinere staffel; een gewone zakelijke klant krijgt geen groothandelsvoorwaarden', async () => {
  const { base, shopper } = await setup();
  const discounted = await shopper({ business: true, wholesale: true, discount: 20 });
  await postForm(base, discounted.client, '/winkel/groothandel/', { action: 'plakken', lijst: 'SLANG\t10' });
  assert.match(await cartHtml(discounted.client), /€\s4,00[\s\S]*20% groothandelskorting/, '20% op 5,00');
  const business = await shopper({ business: true });
  await postForm(base, business.client, '/winkel/winkelwagen/', { action: 'add', code: 'SPR', qty: '30' });
  const cart = await cartHtml(business.client);
  assert.match(cart, /€\s8,00/);
  assert.doesNotMatch(cart, /korting/);
  assert.doesNotMatch(cart, /Alleen per 25/, 'de verpakkingseenheid geldt alleen voor groothandelsklanten');
});

test('bestellen op artikelcode: plakken uit Excel, onbekende codes en aantallen die niet passen', async () => {
  const { base, shopper } = await setup();
  const wholesale = await shopper({ business: true, wholesale: true });
  const pasted = await postForm(base, wholesale.client, '/winkel/groothandel/', { action: 'plakken', lijst: 'Artikelcode\tAantal\nspr\t60\nslang\t7\nONBEKEND\t5\nSLANG x 3\nkapot;' });
  assert.strictEqual(pasted.status, 200);
  assert.match(pasted.text, /SPR: 60 → 75/);
  assert.match(pasted.text, /ONBEKEND: Onbekende artikelcode/);
  assert.match(pasted.text, /2 artikelen in je winkelwagen/);
  assert.match(pasted.text, /<textarea[^>]*>[^<]*ONBEKEND/, 'de geplakte tekst blijft staan om te verbeteren');
  const cart = await cartHtml(wholesale.client);
  assert.match(cart, /value="75"/);
  assert.match(cart, /value="10"/, 'dubbele codes zijn opgeteld');
  const nothing = await postForm(base, wholesale.client, '/winkel/groothandel/', { action: 'plakken', lijst: '   ' });
  assert.strictEqual(nothing.status, 200);
  assert.match(nothing.text, /Er is niets aan je winkelwagen toegevoegd/);
});

test('winkelwagen en bestelling: een aantal dat niet past kan niet worden afgerekend; opnieuw bestellen zet een eerdere bestelling terug', async () => {
  const { base, shopper } = await setup();
  const wholesale = await shopper({ business: true, wholesale: true });
  // Rechtstreeks 30 stuks via de gewone winkelwagen: past niet bij per 25, minimaal 50.
  await postForm(base, wholesale.client, '/winkel/winkelwagen/', { action: 'add', code: 'SPR', qty: '30' });
  assert.match(await cartHtml(wholesale.client), /Minimaal 50 stuks, en alleen per 25/);
  const blocked = await createClient(base, { jar: wholesale.client.jar, followRedirects: false }).get('/winkel/afrekenen/');
  assert.strictEqual(blocked.status, 302, 'afrekenen kan pas als de aantallen kloppen');
  assert.match(blocked.location, /winkelwagen/);
  await postForm(base, wholesale.client, '/winkel/winkelwagen/', { action: 'set', code: 'SPR', qty: '100' });
  const placed = await postCheckout(base, wholesale.client, { name: 'Pieter', company: 'Groothandel Tuinzaken BV', email: 'pieter@groothandel.example', phone: '', street: '', postcode: '', city: '', note: '', shippingMethod: 'ophalen', country: 'NL', action: 'place', paymentMethod: 'rekening' });
  assert.strictEqual(placed.status, 303, placed.text.slice(0, 300));
  assert.match(placed.location, /bestelling\//);
  const page = await wholesale.client.get('/winkel/groothandel/');
  assert.match(page.text, /Eerder besteld/);
  const orderId = page.text.match(/name="orderId" value="([^"]+)"/)[1];
  const again = await postForm(base, wholesale.client, '/winkel/groothandel/', { action: 'opnieuw', orderId });
  assert.strictEqual(again.status, 303);
  assert.match(await cartHtml(wholesale.client), /value="100"/);
  const unknown = await postForm(base, wholesale.client, '/winkel/groothandel/', { action: 'opnieuw', orderId: 'bestaat-niet' });
  assert.strictEqual(unknown.status, 200);
  assert.match(unknown.text, /niet gevonden/);
  const other = await shopper({ business: true, wholesale: true });
  assert.match((await postForm(base, other.client, '/winkel/groothandel/', { action: 'opnieuw', orderId })).text, /niet gevonden/, 'een bestelling van een andere klant is niet te herhalen');
});
