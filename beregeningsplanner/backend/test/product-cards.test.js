// Productkaarten in de shop: elke kaart heeft een aantal-veld en de knop In winkelwagen, een hoofdartikel
// met varianten is een gewone kaart met keuzelijst, en de kaart is nooit een formulier binnen een link.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, createClient, listen, postForm } = require('./helpers/http-client');

const SECRET = 'e'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Winkel met een gewoon artikel op voorraad, een artikel zonder voorraad en een hoofdartikel met twee varianten.
 * @param {boolean} ordering Of bestellen aan staat.
 * @returns {Promise<{ anonymous: object, main: string }>} Client en tenant.
 */
async function setup(ordering) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  await admin.put('/app/api/admin/settings', { storefront: true, shopOrdering: ordering });
  await admin.post('/app/api/stock/items', { code: 'BUIS', name: 'PE buis', onHand: 50, salePrice: 2 });
  await admin.post('/app/api/stock/items', { code: 'LEEG', name: 'Leeg artikel', onHand: 0, salePrice: 3 });
  const parent = (await admin.post('/app/api/stock/items', { code: 'KOP', name: 'Koppeling', salePrice: 5 })).body;
  await admin.put(`/app/api/stock/items/${parent.id}/variants`, { attributes: [{ name: 'Maat', values: ['25 mm', '32 mm'] }] });
  db.prepare('UPDATE stock_items SET sale_price = 7, on_hand = 3 WHERE tenant_id = ? AND parent_id IS NOT NULL').run(main);
  db.prepare('UPDATE stock_items SET shop_sync = 1 WHERE tenant_id = ?').run(main);
  return { anonymous: createClient(base), admin, base };
}

/**
 * Knipt de kaarten uit de HTML van een overzicht.
 * @param {string} html De pagina.
 * @returns {string[]} HTML van elke productkaart.
 */
function cardsOf(html) {
  return html.split('<article class="product-card"').slice(1).map((part) => part.split('</article>')[0]);
}

test('elke kaart heeft aantal en winkelwagenknop, ook het hoofdartikel met varianten', async () => {
  const { anonymous } = await setup(true);
  const home = await anonymous.get('/');
  const slug = home.text.match(/href="categorie\/(overig-[0-9a-f]{6})\//)[1];
  const page = await anonymous.get(`/categorie/${slug}/`);
  const cards = cardsOf(page.text);
  assert.strictEqual(cards.length, 3, 'drie kaarten: twee artikelen en één hoofdartikel (geen losse varianten)');
  for (const card of cards) {
    assert.match(card, /<form class="card-order" method="post" action="\.\.\/\.\.\/winkelwagen\/">/);
    assert.match(card, /<input type="number" name="qty" value="1" min="1" max="99" aria-label="Aantal"/);
    assert.match(card, /<button class="button" type="submit"[^>]*>In winkelwagen<\/button>/);
    assert.ok(!/<a [^>]*>(?:(?!<\/a>)[^])*<(?:form|input|button|select)/.test(card), 'geen formulier of knop binnen een link');
  }
  const plain = cards.find((card) => card.includes('value="BUIS"'));
  assert.ok(plain && !plain.includes('data-variant-select'), 'gewoon artikel zonder keuzelijst');
  const empty = cards.find((card) => card.includes('value="LEEG"'));
  assert.match(empty, /name="qty"[^>]*disabled/);
  assert.match(empty, /type="submit" disabled>In winkelwagen/);
  const variant = cards.find((card) => card.includes('data-variant-select'));
  assert.match(variant, /2 varianten/);
  assert.match(variant, /<option value="[^"]+" data-code="[^"]+"[^>]*selected>25 mm<\/option>/, 'eerste variant op voorraad staat voorgekozen');
  const selectedCode = variant.match(/data-order-code[^>]*>|name="code" value="([^"]+)"/)[1];
  assert.ok(variant.includes(`<span data-variant-code>${selectedCode}</span>`), 'winkelwagencode volgt de gekozen variant');
  assert.match(page.text, /assets\/varianten\.js\?v=/);
});

test('bestellen uit: de kaart toont een uitgeschakelde knop en geen formulier', async () => {
  const { anonymous } = await setup(false);
  const home = await anonymous.get('/');
  const slug = home.text.match(/href="categorie\/(overig-[0-9a-f]{6})\//)[1];
  const cards = cardsOf((await anonymous.get(`/categorie/${slug}/`)).text);
  assert.strictEqual(cards.length, 3);
  for (const card of cards) {
    assert.ok(!card.includes('<form class="card-order"'));
    assert.match(card, /<div class="card-order"><input type="number" value="1" min="1" aria-label="Aantal" disabled><button class="button" type="button" disabled>In winkelwagen<\/button>/);
  }
});

test('de stijl: kaart in het raster, geen paginabrede regel meer', async () => {
  const { anonymous } = await setup(true);
  const css = (await anonymous.get('/assets/winkel.css')).text;
  assert.ok(!css.includes('.variant-row'), 'oude paginabrede variantregel is weg');
  assert.match(css, /\.card-order \{[^}]*display: flex/);
  assert.match(css, /@media \(max-width: 520px\) \{ \.card-order \{ flex-direction: column; \}/, 'op de telefoon staan aantal en knop onder elkaar');
});

test('productpagina: verpakkingskeuze met prijs, winkelwagencode en zichtbaarheid per klantgroep', async () => {
  const { anonymous, admin, base } = await setup(true);
  const item = (await admin.post('/app/api/stock/items', { code: 'KLINK', name: 'Klinker', unit: 'st', onHand: 300, salePrice: 10, businessPrice: 9, vatRate: 21 })).body;
  const saved = await admin.put(`/app/api/stock/items/${item.id}/packagings`, { packagings: [
    { code: 'DOOS', name: 'Doos', factor: 10, salePrice: 95, audience: 'iedereen' },
    { code: 'PAL', name: 'Pallet', factor: 144, salePrice: '', businessPrice: 1200, audience: 'zakelijk' },
  ] });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const home = await anonymous.get('/');
  const category = home.text.match(/href="categorie\/(overig-[0-9a-f]{6})\//)[1];
  const slug = (await anonymous.get(`/categorie/${category}/`)).text.match(/href="\.\.\/\.\.\/product\/(klinker[^/"]*)\//)[1];

  const plain = (await anonymous.get(`/product/${slug}/`)).text;
  assert.match(plain, /<select name="p" data-autosubmit><option value="">Per st – € ?12,10<\/option><option value="DOOS">Doos \(10 st\) – € ?114,95<\/option><\/select>/, 'doos voor iedereen, pallet niet');
  assert.ok(!plain.includes('Pallet'), 'pallet is alleen voor zakelijke klanten');
  assert.match(plain, /name="code" value="KLINK" data-order-code/, 'standaard per stuk');

  const doos = (await anonymous.get(`/product/${slug}/?p=DOOS`)).text;
  assert.match(doos, /<option value="DOOS" selected>/);
  assert.match(doos, /name="code" value="KLINK@DOOS" data-order-code/, 'winkelwagencode volgt de verpakking');
  assert.match(doos, /per Doos \(10 st\)/);
  assert.match(doos, /class="price">€ ?114,95/);
  const unknown = (await anonymous.get(`/product/${slug}/?p=ONBEKEND`)).text;
  assert.match(unknown, /name="code" value="KLINK" data-order-code/, 'een onbekende of verborgen verpakking valt terug op per stuk');
  const hidden = (await anonymous.get(`/product/${slug}/?p=PAL`)).text;
  assert.match(hidden, /name="code" value="KLINK" data-order-code/, 'de pallet is voor een particulier niet te kiezen');

  const business = createClient(base);
  await postForm(base, business, '/registreren/', { displayName: 'Zakelijk', email: 'zakelijk@voorbeeld.nl', password: PW, password2: PW, website: '' });
  const user = (await admin.get('/app/api/admin/users')).body.items.find((candidate) => candidate.email === 'zakelijk@voorbeeld.nl');
  await admin.patch(`/app/api/admin/users/${user.id}`, { customerGroup: 'zakelijk', companyName: 'Bouwbedrijf Vos BV', kvkNumber: '12345678', vatNumber: 'NL123456789B01' });
  const pallet = (await business.get(`/product/${slug}/?p=PAL`)).text;
  assert.match(pallet, /<option value="PAL" selected>Pallet \(144 st\)/);
  assert.match(pallet, /name="code" value="KLINK@PAL" data-order-code/);
  assert.match(pallet, /1\.200,00/, 'zakelijke prijs van de pallet');
});

test('productpagina zonder verpakkingen en zonder bestellen: geen verpakkingskeuze', async () => {
  const { anonymous } = await setup(false);
  const home = await anonymous.get('/');
  const slug = home.text.match(/href="categorie\/(overig-[0-9a-f]{6})\//)[1];
  const product = (await anonymous.get(`/categorie/${slug}/`)).text.match(/href="\.\.\/\.\.\/product\/(pe-buis[^/"]*)\//)[1];
  assert.ok(!(await anonymous.get(`/product/${product}/`)).text.includes('name="p"'));
});
