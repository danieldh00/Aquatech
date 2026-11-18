// Pagina's met blokken in de webshop (page-blocks.js): saneren, tekenen, FAQPage-gegevens,
// sitemap en llms.txt (alleen als de shop is vrijgegeven), rechten en voorbeeld.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { normalizePage } = require('../src/webshop/shop-content');
const { normalizeBlocks, blocksOf, faqEntriesOfBlocks } = require('../src/webshop/page-blocks');
const { createLogin, createClient, listen } = require('./helpers/http-client');

const SECRET = 'e'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, klant, aangezette shop en twee artikelen.
 * @param {{ open?: boolean }} [options] open = vrijgegeven voor zoekmachines (standaard ja).
 * @returns {Promise<object>} anonymous, admin, customer, base.
 */
async function setupShop({ open = true } = {}) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'jan.klant', displayName: 'Jan', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db }));
  servers.push(server);
  const login = createLogin(base, { password: PW });
  const admin = await login('baas');
  await admin.post('/app/api/stock/items', { code: 'SPR-1', name: 'Sproeier Pro', onHand: 5, salePrice: 10 });
  await admin.post('/app/api/stock/items', { code: 'BUIS-25', name: 'PE buis 25 mm', onHand: 3, salePrice: 1.5 });
  assert.strictEqual((await admin.put('/app/api/admin/settings', { storefront: true, shopPayment: { online: false, publicUrl: `${base}/` }, shopSeo: { indexing: open } })).status, 200);
  return { anonymous: createClient(base), admin, customer: await login('jan.klant'), base };
}

/**
 * De JSON-LD-objecten uit een pagina.
 * @param {string} html De pagina.
 * @returns {object[]} De objecten.
 */
const jsonLdOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));

const BLOCKS = [
  { type: 'text', html: '<h2>Welkom</h2><p>Hallo <script>alert(1)</script></p>' },
  { type: 'faq', title: 'Vragen', items: [{ question: 'Hoe lang is de levertijd?', answer: '1 tot 3 dagen.\n\nBij pallets langer.' }, { question: 'Leeg antwoord', answer: ' ' }] },
  { type: 'products', title: 'Onze keuze', mode: 'codes', codes: ['spr-1', 'bestaat-niet'] },
  { type: 'cta', title: 'Advies nodig?', text: 'Bel ons.', button: 'Contact', link: 'pagina/contact/' },
];

test('normalizeBlocks: onbekend, leeg en gevaarlijk valt weg; grenzen gelden', () => {
  /**
   * Korte nepversies van de saneerfuncties uit shop-content.js.
   * @param {*} value De invoer.
   * @param {number} max Maximale lengte.
   * @returns {string} De tekst.
   */
  const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  /**
   * Alleen asset-verwijzingen zijn geldig.
   * @param {*} value De invoer.
   * @param {string} fallback Terugvalwaarde.
   * @returns {string} De verwijzing.
   */
  const imageRef = (value, fallback) => (/^asset:[a-z.-]+$/.test(String(value)) ? value : fallback);
  /**
   * Alleen https-adressen en paden zijn geldig.
   * @param {*} value De invoer.
   * @returns {string} De link.
   */
  const linkRef = (value) => (/^(https:\/\/[^\s"'<>]+|[a-z0-9][a-z0-9/_-]*\/?)$/.test(String(value)) ? value : '');
  /**
   * Haalt scripts weg.
   * @param {*} html De HTML.
   * @returns {string} De HTML zonder scripts.
   */
  const sanitizeHtml = (html) => String(html || '').replace(/<script.*?<\/script>/g, '');
  /**
   * Codes in hoofdletters.
   * @param {*} value De invoer.
   * @returns {string[]} De codes.
   */
  const cleanCodes = (value) => (Array.isArray(value) ? value.map((code) => String(code).toUpperCase()) : []);
  const helpers = { cleanText, imageRef, linkRef, sanitizeHtml, cleanCodes };
  const { blocks } = normalizeBlocks([
    { type: 'text', html: '' }, { type: 'onbekend' }, null, 'tekst',
    { type: 'image', image: 'http://evil/x.png' }, { type: 'image', image: 'asset:a.png', alt: 'Tuin', link: 'javascript:alert(1)' },
    { type: 'products', mode: 'category', category: 'Ongeldig Slug!' }, { type: 'products', mode: 'category', category: 'beregening', limit: 99 },
    { type: 'products', mode: 'codes', codes: [] }, { type: 'faq', items: [{ question: 'Vraag', answer: '' }] },
    { type: 'cta', title: '', button: '' }, { type: 'cta', title: 'Titel', button: 'Knop', link: '' },
  ], helpers);
  assert.deepStrictEqual(blocks.map((block) => block.type), ['image', 'products', 'cta']);
  assert.strictEqual(blocks[0].link, '');
  assert.strictEqual(blocks[1].limit, 12);
  assert.strictEqual(blocks[2].button, '', 'een knop zonder link valt weg');
  assert.strictEqual(normalizeBlocks('geen lijst', helpers).blocks.length, 0);
  assert.strictEqual(normalizeBlocks(new Array(41).fill({ type: 'cta', title: 'x' }), helpers).error, 'too_many_blocks');
});

test('normalizePage: body wordt één tekstblok; blokken gaan voor; te lange tekst geweigerd', () => {
  assert.deepStrictEqual(normalizePage('klantenservice', { title: 'K', body: '<p>Tekst</p>' }).page.blocks, [{ type: 'text', html: '<p>Tekst</p>' }]);
  assert.deepStrictEqual(normalizePage('klantenservice', { title: 'K', body: '<p>x</p>', blocks: [] }).page.blocks, []);
  assert.strictEqual(normalizePage('klantenservice', { title: 'K', blocks: [{ type: 'text', html: 'x'.repeat(100001) }] }).error, 'too_long');
  assert.strictEqual(normalizePage('klantenservice', { title: 'K', body: `<p>${'x'.repeat(100001)}</p>` }).error, 'too_long', 'ook een pagina met alleen body');
  const faqItems = new Array(40).fill({ question: 'Vraag?', answer: 'a'.repeat(2000) });
  assert.strictEqual(normalizePage('klantenservice', { title: 'K', blocks: [{ type: 'faq', items: faqItems }, { type: 'text', html: `<p>${'y'.repeat(30000)}</p>` }] }).error, 'too_long', 'totaal van alle blokken');
  assert.strictEqual(normalizePage('klantenservice', { title: 'K', blocks: new Array(41).fill({ type: 'cta', title: 'x' }) }).error, 'too_many_blocks');
  assert.deepStrictEqual(blocksOf({ body: '<p>oud</p>' }), [{ type: 'text', html: '<p>oud</p>' }]);
  assert.deepStrictEqual(blocksOf({}), []);
  assert.deepStrictEqual(faqEntriesOfBlocks([{ type: 'faq', items: [{ question: 'V', answer: 'a\n\nb' }] }, { type: 'text', html: 'x' }]), [{ question: 'V', answer: 'a b' }]);
});

test('pagina met blokken: concept, voorbeeld, publiceren, FAQPage, sitemap en llms.txt', async () => {
  const { admin, anonymous, customer } = await setupShop();
  const saved = await admin.put('/app/api/admin/shop-content/pages/advies', { title: 'Advies', description: 'Hulp bij je tuin', blocks: BLOCKS, menu: true });
  assert.strictEqual(saved.status, 200);
  const stored = saved.body.pages[0].draft.blocks;
  assert.strictEqual(stored.length, 4);
  assert.deepStrictEqual(stored[1].items.map((item) => item.question), ['Hoe lang is de levertijd?'], 'vraag zonder antwoord valt weg');
  assert.deepStrictEqual(stored[2].codes, ['SPR-1', 'BESTAAT-NIET']);
  assert.ok(!JSON.stringify(stored).includes('script'));
  assert.strictEqual((await anonymous.get('/pagina/advies/')).status, 404, 'concept niet openbaar');
  assert.ok(!(await anonymous.get('/sitemap.xml')).text.includes('pagina/advies'), 'concept niet in de sitemap');
  const preview = await admin.get('/pagina/advies/?voorbeeld=1');
  assert.match(preview.text, /Hoe lang is de levertijd\?/);

  assert.strictEqual((await admin.post('/app/api/admin/shop-content/pages/advies/publish', {})).status, 200);
  const page = await anonymous.get('/pagina/advies/');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /<h2>Welkom<\/h2>/);
  assert.match(page.text, /<details><summary>Hoe lang is de levertijd\?<\/summary><p>1 tot 3 dagen\.<\/p><p>Bij pallets langer\.<\/p><\/details>/);
  assert.match(page.text, /Sproeier Pro/);
  assert.strictEqual((page.text.match(/class="product-card"/g) || []).length, 1, 'alleen bestaande codes');
  assert.doesNotMatch(page.text, /bestaat-niet/);
  assert.match(page.text, /<aside class="cms-cta"><h2>Advies nodig\?<\/h2><p>Bel ons\.<\/p><a class="button" href="..\/..\/pagina\/contact\/">Contact<\/a><\/aside>/);
  const faq = jsonLdOf(page.text).find((item) => item['@type'] === 'FAQPage');
  assert.strictEqual(faq.mainEntity.length, 1);
  assert.strictEqual(faq.mainEntity[0].acceptedAnswer.text, '1 tot 3 dagen. Bij pallets langer.');
  assert.ok(page.text.includes('Hoe lang is de levertijd?'), 'wat in de gegevens staat, staat ook zichtbaar');

  assert.match((await anonymous.get('/sitemap.xml')).text, /pagina\/advies\//);
  const llms = (await anonymous.get('/llms.txt')).text;
  assert.match(llms, /\[Advies\]\(http:\/\/127\.0\.0\.1:\d+\/pagina\/advies\/\): Hulp bij je tuin/);

  assert.strictEqual((await customer.put('/app/api/admin/shop-content/pages/advies', { title: 'x', blocks: [] })).status, 403);
});

test('categorieblok toont artikelen uit de categorie; een pagina zonder FAQ-blok heeft geen FAQPage', async () => {
  const { admin, anonymous } = await setupShop();
  await admin.put('/app/api/admin/shop-content/pages/overzicht', { title: 'Overzicht', blocks: [{ type: 'products', title: 'Alles', mode: 'category', category: 'bestaat-niet' }, { type: 'text', html: '<h2>Wat is dit?</h2><p>Antwoord.</p>' }] });
  await admin.post('/app/api/admin/shop-content/pages/overzicht/publish', {});
  const page = await anonymous.get('/pagina/overzicht/');
  assert.strictEqual(page.status, 200);
  assert.doesNotMatch(page.text, /cms-products/, 'lege selectie toont niets');
  assert.ok(!jsonLdOf(page.text).some((item) => item['@type'] === 'FAQPage'), 'koppen op een gewone pagina zijn geen FAQ');
  const catalogPage = await anonymous.get('/');
  const slug = /categorie\/([a-z0-9-]+)\//.exec(catalogPage.text);
  if (slug) {
    await admin.put('/app/api/admin/shop-content/pages/overzicht', { title: 'Overzicht', blocks: [{ type: 'products', mode: 'category', category: slug[1], limit: 3 }] });
    await admin.post('/app/api/admin/shop-content/pages/overzicht/publish', {});
    assert.match((await anonymous.get('/pagina/overzicht/')).text, /cms-products/);
  }
});

test('pagina veelgestelde-vragen met koppen geeft FAQPage; zolang niet vrijgegeven: geen gegevens, llms.txt en sitemap', async () => {
  const open = await setupShop();
  await open.admin.put('/app/api/admin/shop-content/pages/veelgestelde-vragen', { title: 'Veelgestelde vragen', body: '<h2>Retourneren?</h2><p>Binnen 14 dagen.</p>' });
  await open.admin.post('/app/api/admin/shop-content/pages/veelgestelde-vragen/publish', {});
  const page = await open.anonymous.get('/pagina/veelgestelde-vragen/');
  assert.strictEqual(jsonLdOf(page.text).find((item) => item['@type'] === 'FAQPage').mainEntity[0].name, 'Retourneren?');

  const closed = await setupShop({ open: false });
  await closed.admin.put('/app/api/admin/shop-content/pages/veelgestelde-vragen', { title: 'Veelgestelde vragen', blocks: BLOCKS });
  await closed.admin.post('/app/api/admin/shop-content/pages/veelgestelde-vragen/publish', {});
  const hidden = await closed.anonymous.get('/pagina/veelgestelde-vragen/');
  assert.match(hidden.text, /noindex/);
  assert.ok(!hidden.text.includes('application/ld+json'));
  assert.strictEqual((await closed.anonymous.get('/llms.txt')).status, 404);
  assert.strictEqual((await closed.anonymous.get('/sitemap.xml')).status, 404);
});

test('afbeeldingsblok en XSS: alt en bijschrift worden ontsnapt, onbekende afbeelding valt weg', async () => {
  const { admin, anonymous } = await setupShop();
  const put = await admin.put('/app/api/admin/shop-content/pages/foto', { title: 'Foto', blocks: [
    { type: 'image', image: 'asset:hero-tuin.jpg', alt: '"><script>x</script>', caption: '<b>Tuin</b>', link: 'javascript:alert(1)' },
    { type: 'image', image: 'media:00000000-0000-0000-0000-000000000000x' },
  ] });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.body.pages[0].draft.blocks.length, 1);
  await admin.post('/app/api/admin/shop-content/pages/foto/publish', {});
  const html = (await anonymous.get('/pagina/foto/')).text;
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /<figcaption>&lt;b&gt;Tuin&lt;\/b&gt;<\/figcaption>/);
  assert.doesNotMatch(html, /javascript:/);
});

test('artikelblok met eigen codes toont alle codes, ook meer dan de standaardlimiet', async () => {
  const { admin, anonymous } = await setupShop();
  for (let number = 1; number <= 8; number += 1) await admin.post('/app/api/stock/items', { code: `X-${number}`, name: `Artikel ${number}`, onHand: 5, salePrice: 2 });
  await admin.put('/app/api/admin/shop-content/pages/acht', { title: 'Acht', blocks: [{ type: 'products', mode: 'codes', codes: ['X-1', 'X-2', 'X-3', 'X-4', 'X-5', 'X-6', 'X-7', 'X-8'] }] });
  await admin.post('/app/api/admin/shop-content/pages/acht/publish', {});
  assert.strictEqual(((await anonymous.get('/pagina/acht/')).text.match(/class="product-card"/g) || []).length, 8);
});
