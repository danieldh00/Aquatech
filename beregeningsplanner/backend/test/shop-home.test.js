// Startpagina van de eigen webshop (1.6.8): de blokken banners, kolommen, citaat en
// zakelijk formulier uit Beheer, de tabbladen Meest verkocht / Populaire producten
// en de aanvraag voor een zakelijk account per mail.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { normalizeSite, DEFAULT_SITE } = require('../src/webshop/shop-content');
const { buildCatalog, createStorefrontData } = require('../src/webshop/storefront-data');
const { createLogin, listen, postForm } = require('./helpers/http-client');

const SECRET = 'f'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, nep-mailserver, bedrijfsprofiel met e-mailadres en twee artikelen met foto.
 * @returns {Promise<object>} db, base, main (tenant-id), admin en sent (verstuurde mails).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const sent = [];
  /**
   * Nep-mailserver die de berichten bewaart.
   * @returns {{ configured: Function, send: Function }} De mailfuncties.
   */
  const mailerFor = () => ({ configured: () => true, send: async (message) => { sent.push(message); } });
  const { server, base } = await listen(createApp({ secret: SECRET, db, mailerFor }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  assert.strictEqual((await admin.put('/app/api/admin/settings', { storefront: true })).status, 200);
  assert.strictEqual((await admin.put('/app/api/quote-profile', { profile: { email: 'info@bedrijf.nl', name: 'Bedrijf' } })).status, 200);
  for (const item of [{ code: 'SPR-1', name: 'Sproeier Pro', onHand: 5, salePrice: 10 }, { code: 'BUIS-25', name: 'PE buis 25 mm', onHand: 100, salePrice: 1.5 }]) {
    assert.strictEqual((await admin.post('/app/api/stock/items', item)).status, 201);
  }
  for (const [index, code] of ['SPR-1', 'BUIS-25'].entries()) {
    db.prepare('INSERT INTO shop_products (tenant_id, id, name, image, categories) VALUES (?, ?, ?, ?, ?)').run(main, String(index + 1), code, `https://shop.test/${index}.jpg`, '["Leidingen"]');
    db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND code = ?').run(String(index + 1), main, code);
  }
  return { db, base, main, admin, sent };
}

test('blokken: banners, kolommen, citaat en formulier worden gesaneerd', () => {
  const site = normalizeSite({
    banners: { items: [{ image: 'asset:banner-pomp.jpg', title: 'Pompen', button: 'Kijk', link: 'groep/pomp-techniek/' }, { image: 'http://evil/x.png', title: 'Geen afbeelding' }] },
    columns: { items: [{ title: 'Uitverkoop', group: 'onbekend', codes: 'spr-1, spr-1, <b>, BUIS-25' }, { title: '' }] },
    quote: { text: 'Kwaliteit' },
    business: { form: false },
  });
  assert.deepStrictEqual(site.banners.items, [{ image: 'asset:banner-pomp.jpg', title: 'Pompen', button: 'Kijk', link: 'groep/pomp-techniek/' }]);
  assert.deepStrictEqual(site.columns.items, [{ title: 'Uitverkoop', group: '', codes: ['SPR-1', 'BUIS-25'] }]);
  assert.strictEqual(site.quote.text, 'Kwaliteit');
  assert.strictEqual(site.business.form, false);
  assert.strictEqual(normalizeSite({}).business.form, DEFAULT_SITE.business.form);
  assert.strictEqual(DEFAULT_SITE.hero.title, '', 'de hero is een afbeelding zonder tekst, zoals aquatechshop.nl');
});

test('catalogus: meest verkocht uit de verkochte aantallen per code', () => {
  const rows = ['A', 'B', 'C'].map((code) => ({ code, name: code, unit: 'st', on_hand: 1, sale_price: 1, vat_rate: 21, categories: '["Leidingen"]', image: 'https://x.nl/a.jpg' }));
  assert.deepStrictEqual(buildCatalog(rows).bestsellers, []);
  const catalog = buildCatalog(rows, new Map([['C', 9], ['A', 2], ['ONBEKEND', 50]]));
  assert.deepStrictEqual(catalog.bestsellers.map((product) => product.code), ['C', 'A']);
});

test('catalogus: variantverkopen tellen samen voor het hoofdartikel', () => {
  const rows = [
    { id: 'P', code: 'KOP', name: 'Koppeling', has_variants: 1, image: 'https://x.nl/k.jpg' },
    { id: 'V1', parent_id: 'P', code: 'KOP-1', name: 'Koppeling 1', on_hand: 1, sale_price: 1 },
    { id: 'V2', parent_id: 'P', code: 'KOP-2', name: 'Koppeling 2', on_hand: 1, sale_price: 1 },
    { id: 'S', code: 'LOS', name: 'Los artikel', on_hand: 1, sale_price: 1, image: 'https://x.nl/l.jpg' },
  ];
  const catalog = buildCatalog(rows, new Map([['KOP-1', 3], ['KOP-2', 3], ['LOS', 5]]));
  assert.deepStrictEqual(catalog.bestsellers.map((product) => product.code), ['KOP', 'LOS']);
});

test('startpagina: hero zonder tekst, banners, kolommen, citaat en tabbladen na een verkoop', async () => {
  const { db, base, main } = await setup();
  const home = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(home, /home-hero-text/, 'geen tekst over de hero');
  assert.match(home, /home-banners/);
  assert.match(home, /Efficiënt bewateren met een druppelslang/);
  assert.match(home, /banner-druppelslang\.jpg/);
  assert.match(home, /<h2>Speciale producten<\/h2>/);
  assert.match(home, /<h2>Uitverkoop<\/h2>/);
  assert.match(home, /Binnenkort meer producten/);
  assert.match(home, /Duurzaamheid door kwaliteit!/);
  assert.match(home, /<h2 class="centered">Populaire producten<\/h2>/, 'zonder verkopen geen tabbladen');
  assert.doesNotMatch(home, /Meest verkocht/);
  assert.match(home, /Klantenservice/);
  assert.doesNotMatch(home, /MOVA/);

  const item = db.prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND code = ?').get(main, 'BUIS-25');
  db.prepare("INSERT INTO stock_movements (id, tenant_id, item_id, kind, qty, balance, source, note, created_at) VALUES ('m1', ?, ?, 'afboeking', -3, 97, 'bestelling:WEB-1', '', ?)").run(main, item.id, new Date().toISOString());
  const catalog = createStorefrontData(db).catalogOf(main);
  assert.deepStrictEqual(catalog.bestsellers.map((product) => product.code), ['BUIS-25']);
});

test('zakelijk formulier: alleen met mailserver en e-mailadres, anders de knop', async () => {
  const { base, admin } = await setup();
  assert.match(await (await fetch(`${base}/`)).text(), /class="business-form"/);
  assert.strictEqual((await admin.put('/app/api/quote-profile', { profile: { email: '' } })).status, 200);
  const without = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(without, /class="business-form"/);
  assert.match(without, /Account aanmaken/);
});

test('zakelijk formulier: mail naar het bedrijf, valstrik en limiet', async () => {
  const { base, sent } = await setup();
  const client = { jar: new Map() };
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /<form class="business-form" id="zakelijk" method="post" action="zakelijk-aanvraag\/">/);

  const ok = await postForm(base, client, '/zakelijk-aanvraag/', { company: 'Tuinbedrijf Jansen', email: 'jan@jansen.nl', phone: '0612345678', message: 'Graag prijzen', website: '' });
  assert.strictEqual(ok.status, 303);
  assert.strictEqual(ok.location, '../?aanvraag=ja#zakelijk');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, 'info@bedrijf.nl');
  assert.strictEqual(sent[0].replyTo, 'jan@jansen.nl');
  assert.match(sent[0].text, /Tuinbedrijf Jansen/);
  assert.match(await (await fetch(`${base}/?aanvraag=ja`)).text(), /Bedankt voor je aanvraag/);

  const robot = await postForm(base, client, '/zakelijk-aanvraag/', { company: 'Spam', email: 'bot@spam.nl', phone: '1', website: 'http://spam' });
  assert.strictEqual(robot.location, '../?aanvraag=ja#zakelijk');
  assert.strictEqual(sent.length, 1, 'robot krijgt een nep-bevestiging maar geen mail');

  const invalid = await postForm(base, client, '/zakelijk-aanvraag/', { company: '', email: 'geen-adres', phone: '' });
  assert.strictEqual(invalid.location, '../?aanvraag=fout#zakelijk');
  assert.strictEqual(sent.length, 1);

  const foreign = await postForm(base, client, '/zakelijk-aanvraag/', { company: 'X', email: 'x@x.nl', phone: '1' }, { 'sec-fetch-site': 'cross-site' });
  assert.strictEqual(foreign.status, 403);

  for (let attempt = 0; attempt < 4; attempt += 1) await postForm(base, client, '/zakelijk-aanvraag/', { company: `Bedrijf ${attempt}`, email: 'a@b.nl', phone: '1' });
  const limited = await postForm(base, client, '/zakelijk-aanvraag/', { company: 'Te veel', email: 'a@b.nl', phone: '1' });
  assert.strictEqual(limited.status, 429);
});
