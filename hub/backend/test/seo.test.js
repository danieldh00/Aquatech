// Vindbaarheid van de webshop (seo.js): Schema.org-gegevens, robots.txt,
// sitemap, llms.txt, productfeed en de canonical-/OpenGraph-regels op de pagina's.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const Seo = require('../src/webshop/seo');
const { createLogin, createClient, listen } = require('./helpers/http-client');

const SECRET = 'f'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const BASE = 'https://shop.example.nl/';
const servers = [];
after(() => { for (const server of servers) server.close(); });

const SITE = { contact: { phone: '06 47212019', email: 'info@example.nl', kvk: '88438252', address: 'Oenenburgweg 218, 8072 GP Nunspeet' }, footer: { about: 'Beregening voor tuin en bedrijf.' } };
const PRODUCT = { code: 'SPR-1', slug: 'sproeier-spr-1', name: 'Sproeier <Pro>', priceIncl: 12.1, inStock: true, image: 'own:11111111-1111-1111-1111-111111111111', categoryName: 'Sproeiers', groupSlug: 'beregening', updatedAt: '2026-11-01' };

/**
 * Haalt de JSON-LD-objecten uit een HTML-pagina.
 * @param {string} html De pagina.
 * @returns {object[]} Alle Schema.org-objecten in de pagina (een lijst in één blok wordt uitgevouwen).
 */
function jsonLdOf(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].flatMap((match) => [].concat(JSON.parse(match[1])));
}

test('bedrijf: Store met adres, KvK en zoekfunctie op de website', () => {
  const [store, website] = Seo.organizationJsonLd(SITE, BASE, 'Aquatechshop.nl', `${BASE}assets/hero.jpg`);
  assert.strictEqual(store['@type'], 'Store');
  assert.deepStrictEqual(store.address, { '@type': 'PostalAddress', streetAddress: 'Oenenburgweg 218', postalCode: '8072 GP', addressLocality: 'Nunspeet', addressCountry: 'NL' });
  assert.strictEqual(store.telephone, '+31647212019');
  assert.strictEqual(store.identifier.value, '88438252');
  assert.strictEqual(website.potentialAction.target.urlTemplate, `${BASE}zoeken/?q={search_term_string}`);
});

test('product: aanbieding met prijs, voorraad en afbeelding; hoofdartikel krijgt een prijsbereik', () => {
  const single = Seo.productJsonLd({ product: PRODUCT, baseUrl: BASE, canonicalPath: 'product/sproeier-spr-1/', shopName: 'Aquatechshop.nl', description: 'Tekst' });
  assert.strictEqual(single.offers['@type'], 'Offer');
  assert.strictEqual(single.offers.price, '12.10');
  assert.strictEqual(single.offers.priceCurrency, 'EUR');
  assert.strictEqual(single.offers.availability, 'https://schema.org/InStock');
  assert.deepStrictEqual(single.image, [`${BASE}artikelfoto/11111111-1111-1111-1111-111111111111`]);
  const group = Seo.productJsonLd({
    product: { ...PRODUCT, variants: [{ priceIncl: 5, inStock: false }, { priceIncl: 9.5, inStock: true }] },
    baseUrl: BASE, canonicalPath: 'product/x/', shopName: 'Aquatechshop.nl', description: 'Tekst',
  });
  assert.strictEqual(group.offers['@type'], 'AggregateOffer');
  assert.strictEqual(group.offers.lowPrice, '5.00');
  assert.strictEqual(group.offers.highPrice, '9.50');
  assert.strictEqual(group.offers.offerCount, 2);
  assert.strictEqual(group.offers.availability, 'https://schema.org/InStock');
});

test('JSON-LD in de pagina kan niet worden afgesloten door tekst in de gegevens', () => {
  const block = Seo.jsonLdBlock([{ name: '</script><script>alert(1)</script>' }]);
  assert.strictEqual(block.match(/<\/script>/g).length, 1);
  assert.strictEqual(JSON.parse(block.replace(/^<script[^>]*>|<\/script>\n$/g, '')).name, '</script><script>alert(1)</script>');
  assert.strictEqual(Seo.jsonLdBlock([null]), '');
});

test('FAQ: koppen worden vragen, de tekst eronder het antwoord', () => {
  const entries = Seo.faqEntriesOf('<h2>Welke sproeier voor 200 m²?</h2><p>Kies een <strong>rotor</strong>.</p><p>Of twee.</p><h3>Levertijd?</h3><p>1 tot 3 dagen.</p><h2>Leeg</h2>');
  assert.deepStrictEqual(entries, [{ question: 'Welke sproeier voor 200 m²?', answer: 'Kies een rotor . Of twee.' }, { question: 'Levertijd?', answer: '1 tot 3 dagen.' }]);
  assert.strictEqual(Seo.faqJsonLd([]), null);
  assert.strictEqual(Seo.faqJsonLd(entries).mainEntity[1].acceptedAnswer.text, '1 tot 3 dagen.');
});

test('robots.txt: AI-crawlers expliciet toegestaan, persoonlijke pagina’s niet, met de sitemap', () => {
  const text = Seo.robotsTxt(BASE);
  for (const crawler of ['GPTBot', 'OAI-SearchBot', 'PerplexityBot', 'ClaudeBot', 'Google-Extended']) assert.match(text, new RegExp(`User-agent: ${crawler}\\n`));
  assert.match(text, /Disallow: \/app\//);
  assert.match(text, /Disallow: \/afrekenen\//);
  assert.ok(!/Disallow: \/\n/.test(text), 'de shop zelf blijft leesbaar');
  assert.match(text, /Sitemap: https:\/\/shop\.example\.nl\/sitemap\.xml/);
});

test('sitemap en llms.txt: pagina’s met lastmod en een samenvatting in Markdown', () => {
  const catalog = {
    groups: [{ slug: 'beregening', name: 'Beregening', count: 2, intro: '<p>Alles voor <b>beregening</b>.</p>', categories: [] }],
    categories: [{ slug: 'sproeiers', hidden: false, count: 2 }, { slug: 'leeg', hidden: false, count: 0 }, { slug: 'oud', hidden: true, count: 3 }],
    products: [PRODUCT], variantProducts: [],
  };
  const pages = [{ slug: 'over-ons', title: 'Over ons' }, { slug: 'privacyverklaring', title: 'Privacyverklaring' }];
  const xml = Seo.sitemapXml(Seo.sitemapEntriesOf({ catalog, pages }), BASE);
  assert.match(xml, /<loc>https:\/\/shop\.example\.nl\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/shop\.example\.nl\/categorie\/sproeiers\/<\/loc>/);
  assert.ok(!xml.includes('categorie/leeg/') && !xml.includes('categorie/oud/'), 'lege en verborgen categorieën blijven eruit');
  assert.match(xml, /<loc>https:\/\/shop\.example\.nl\/over-ons\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/shop\.example\.nl\/pagina\/privacyverklaring\/<\/loc>/);
  assert.match(xml, /product\/sproeier-spr-1\/<\/loc><lastmod>2026-11-01<\/lastmod>/);
  const llms = Seo.llmsTxt({ shopName: 'Aquatechshop.nl', baseUrl: BASE, site: SITE, groups: catalog.groups, pages });
  assert.match(llms, /^# Aquatechshop\.nl\n\n> Beregening voor tuin en bedrijf\./);
  assert.match(llms, /- Adres: Oenenburgweg 218, 8072 GP Nunspeet/);
  assert.match(llms, /\[Beregening\]\(https:\/\/shop\.example\.nl\/groep\/beregening\/\): 2 producten\. Alles voor beregening\./);
  assert.match(llms, /\[Productfeed\]\(https:\/\/shop\.example\.nl\/productfeed\.xml\)/);
});

test('productfeed: prijs, voorraad en afbeelding; varianten apart; zonder foto niet', () => {
  const feed = Seo.merchantFeedXml({
    shopName: 'Aquatechshop.nl', baseUrl: BASE,
    groups: [{ slug: 'beregening', name: 'Beregening' }],
    products: [
      PRODUCT,
      { ...PRODUCT, code: 'GEEN-FOTO', slug: 'geen-foto', image: '' },
      { ...PRODUCT, code: 'HOOFD', slug: 'hoofd', name: 'Slang', variants: [{ code: 'HOOFD-25', slug: 'slang-25', label: '25 mm', priceIncl: 3, inStock: false, image: 'https://img.example.nl/s.jpg' }] },
    ],
  });
  assert.match(feed, /<g:id>SPR-1<\/g:id>/);
  assert.match(feed, /<title>Sproeier &lt;Pro&gt;<\/title>/);
  assert.match(feed, /<g:price>12\.10 EUR<\/g:price>/);
  assert.match(feed, /<g:availability>in_stock<\/g:availability>/);
  assert.match(feed, /<g:product_type>Beregening &gt; Sproeiers<\/g:product_type>/);
  assert.ok(!feed.includes('GEEN-FOTO'), 'Merchant Center eist een afbeelding');
  assert.match(feed, /<g:id>HOOFD-25<\/g:id>[\s\S]*<g:availability>out_of_stock<\/g:availability>[\s\S]*<g:item_group_id>HOOFD<\/g:item_group_id>/);
  assert.match(feed, /<link>https:\/\/shop\.example\.nl\/product\/slang-25\/<\/link>/);
  assert.match(feed, /<description>Sproeier &lt;Pro&gt; \(artikelnummer SPR-1\) van Aquatechshop\.nl\.<\/description>/, 'zonder omschrijving de standaardtekst');
  const described = Seo.merchantFeedXml({ shopName: 'Aquatechshop.nl', baseUrl: BASE, groups: [], products: [PRODUCT], details: new Map([['SPR-1', { description: 'Regel één\n\nRegel & twee', specifications: [] }]]) });
  assert.match(described, /<description>Regel één Regel &amp; twee<\/description>/, 'de eigen omschrijving op één regel (12)');
});

/**
 * Hoofdtenant met beheerder, aangezette shop en twee artikelen.
 * @param {{ open?: boolean }} [options] open = de shop is vrijgegeven voor zoekmachines (standaard ja).
 * @returns {Promise<{ anonymous: object, admin: object, base: string, db: object, main: string }>} Een client zonder en een met inlog, het adres, de database en de hoofdtenant.
 */
async function setupShop({ open = true } = {}) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  await admin.post('/app/api/stock/items', { code: 'SPR-1', name: 'Sproeier Pro', onHand: 5, salePrice: 10 });
  await admin.post('/app/api/stock/items', { code: 'BUIS-25', name: 'PE buis 25 mm', onHand: 0, salePrice: 1.5 });
  assert.strictEqual((await admin.put('/app/api/admin/settings', { storefront: true, shopPayment: { online: false, publicUrl: `${base}/` }, shopSeo: { indexing: open } })).status, 200);
  return { anonymous: createClient(base), admin, base, db, main };
}

test('shop: canonical, OpenGraph en JSON-LD op startpagina en product; noindex op zoeken en account', async () => {
  const { anonymous } = await setupShop();
  const home = await anonymous.get('/');
  assert.strictEqual(home.status, 200);
  assert.match(home.text, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/">/);
  assert.match(home.text, /<meta property="og:type" content="website">/);
  const homeTypes = jsonLdOf(home.text).map((item) => item['@type']);
  assert.deepStrictEqual(homeTypes, ['Store', 'WebSite']);
  const product = await anonymous.get('/product/sproeier-pro-spr-1/');
  assert.strictEqual(product.status, 200);
  assert.match(product.text, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/product\/sproeier-pro-spr-1\/">/);
  assert.match(product.text, /<meta property="og:type" content="product">/);
  const items = jsonLdOf(product.text);
  const productData = items.find((item) => item['@type'] === 'Product');
  assert.strictEqual(productData.sku, 'SPR-1');
  assert.strictEqual(productData.offers.price, '12.10');
  assert.strictEqual(productData.offers.availability, 'https://schema.org/InStock');
  assert.strictEqual(items.find((item) => item['@type'] === 'BreadcrumbList').itemListElement.at(-1).name, 'Sproeier Pro');
  const search = await anonymous.get('/zoeken/?q=sproeier');
  assert.match(search.text, /<meta name="robots" content="noindex, follow">/);
  assert.ok(!search.text.includes('rel="canonical"'));
  const missing = await anonymous.get('/product/bestaat-niet/');
  assert.strictEqual(missing.status, 404);
  assert.match(missing.text, /noindex/);
});

test('shop: robots.txt, sitemap.xml, llms.txt en productfeed.xml zijn openbaar en bevatten de producten', async () => {
  const { anonymous } = await setupShop();
  const robots = await anonymous.get('/robots.txt');
  assert.strictEqual(robots.status, 200);
  assert.match(robots.type, /text\/plain/);
  assert.match(robots.text, /User-agent: GPTBot/);
  assert.match(robots.text, /Sitemap: http:\/\/127\.0\.0\.1:\d+\/sitemap\.xml/);
  const sitemap = await anonymous.get('/sitemap.xml');
  assert.strictEqual(sitemap.status, 200);
  assert.match(sitemap.type, /application\/xml/);
  assert.match(sitemap.text, /product\/sproeier-pro-spr-1\/<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  assert.match(sitemap.text, /product\/pe-buis-25-mm-buis-25\//);
  const llms = await anonymous.get('/llms.txt');
  assert.strictEqual(llms.status, 200);
  assert.match(llms.text, /^# Aquatechshop\.nl/);
  const feed = await anonymous.get('/productfeed.xml');
  assert.strictEqual(feed.status, 200);
  assert.match(feed.text, /<rss version="2\.0"/);
});

test('shop dicht voor zoekmachines (standaard): noindex overal, robots blokkeert alles, geen sitemap, feeds, canonical of JSON-LD', async () => {
  const { anonymous, admin, base } = await setupShop({ open: false });
  for (const urlPath of ['/', '/product/sproeier-pro-spr-1/']) {
    const page = await anonymous.get(urlPath);
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /<meta name="robots" content="noindex, follow">/, urlPath);
    assert.match(page.headers.get('x-robots-tag'), /noindex/, urlPath);
    assert.doesNotMatch(page.text, /rel="canonical"|og:title|application\/ld\+json/, urlPath);
  }
  const robots = await anonymous.get('/robots.txt');
  assert.strictEqual(robots.text, 'User-agent: *\nDisallow: /\n');
  for (const urlPath of ['/sitemap.xml', '/llms.txt', '/productfeed.xml']) assert.strictEqual((await anonymous.get(urlPath)).status, 404, urlPath);
  // Ook met een webadres blijft het dicht zolang de schakelaar uit staat; aanzetten zonder webadres opent niets.
  assert.strictEqual((await admin.put('/app/api/admin/settings', { shopSeo: { indexing: true }, shopPayment: { online: false, publicUrl: '' } })).status, 200);
  assert.strictEqual((await anonymous.get('/sitemap.xml')).status, 404);
  assert.match((await anonymous.get('/')).text, /noindex/);
  assert.strictEqual((await fetch(`${base}/robots.txt`)).status, 200);
  // Open met webadres: alles beschikbaar, geen noindex-kop.
  assert.strictEqual((await admin.put('/app/api/admin/settings', { shopPayment: { online: false, publicUrl: `${base}/` } })).status, 200);
  const open = await anonymous.get('/');
  assert.strictEqual(open.headers.get('x-robots-tag'), null);
  assert.doesNotMatch(open.text, /name="robots"/);
  assert.strictEqual((await anonymous.get('/sitemap.xml')).status, 200);
});

test('instelling shopSeo: alleen een echte true opent; rommel blijft dicht; niet in een testomgeving', () => {
  assert.deepStrictEqual(Seo.sanitizeSeoSettings(undefined), { indexing: false });
  assert.deepStrictEqual(Seo.sanitizeSeoSettings({ indexing: 'ja' }), { indexing: false });
  assert.deepStrictEqual(Seo.sanitizeSeoSettings([true]), { indexing: false });
  assert.deepStrictEqual(Seo.sanitizeSeoSettings({ indexing: true }), { indexing: true });
  assert.strictEqual(Seo.indexingOn({ indexing: true }, ''), false);
  assert.strictEqual(Seo.indexingOn({ indexing: false }, BASE), false);
  assert.strictEqual(Seo.indexingOn({ indexing: true }, BASE), true);
  assert.strictEqual(Seo.pageTitleOf('  Eigen  ', 'Auto'), 'Eigen');
  assert.strictEqual(Seo.pageTitleOf('', 'Auto'), 'Auto');
});

test('product-JSON-LD: merk en EAN alleen als ze bestaan; een prijsbereik krijgt geen EAN; ongeldige EAN valt weg', () => {
  const single = Seo.productJsonLd({ product: PRODUCT, baseUrl: BASE, canonicalPath: 'product/x/', shopName: 'Shop', description: 'd', brand: 'Rain Bird', ean: '4006381333931' });
  assert.deepStrictEqual(single.brand, { '@type': 'Brand', name: 'Rain Bird' });
  assert.strictEqual(single.gtin13, '4006381333931');
  assert.strictEqual(single.offers.price, '12.10', 'consumentenprijs incl. btw');
  const short = Seo.productJsonLd({ product: PRODUCT, baseUrl: BASE, canonicalPath: 'product/x/', shopName: 'Shop', description: 'd', ean: '96385074' });
  assert.strictEqual(short.gtin8, '96385074');
  assert.ok(!('brand' in short));
  const bad = Seo.productJsonLd({ product: PRODUCT, baseUrl: BASE, canonicalPath: 'product/x/', shopName: 'Shop', description: 'd', ean: '12345' });
  assert.ok(!('gtin13' in bad) && !('gtin8' in bad));
  const range = Seo.productJsonLd({ product: { ...PRODUCT, variants: [{ code: 'A', priceIncl: 1, inStock: true }, { code: 'B', priceIncl: 2, inStock: false }] }, baseUrl: BASE, canonicalPath: 'product/x/', shopName: 'Shop', description: 'd', ean: '4006381333931' });
  assert.ok(!('gtin13' in range));
});

test('artikel: eigen zoekmachinetitel, -omschrijving en merk komen in de pagina en de JSON-LD; leeg = automatisch; variant erft van het hoofdartikel', async () => {
  const { anonymous, admin } = await setupShop();
  const items = (await admin.get('/app/api/stock')).body.items;
  const sproeier = items.find((item) => item.code === 'SPR-1');
  // Een artikel zonder eigen teksten (de pagina's worden 30 seconden onthouden, dus een ander artikel dan hieronder).
  const automatic = await anonymous.get('/product/pe-buis-25-mm-buis-25/');
  assert.match(automatic.text, /<title>PE buis 25 mm – Aquatechshop\.nl<\/title>/);
  assert.ok(!('brand' in jsonLdOf(automatic.text).find((item) => item['@type'] === 'Product')));
  const saved = await admin.put(`/app/api/stock/items/${sproeier.id}`, { seoTitle: '  Sproeier Pro kopen <b>bij</b> ons ', seoDescription: 'Koop de Sproeier Pro met gratis advies.', brand: 'Hunter', ean: '4006381333931' });
  assert.strictEqual(saved.status, 200);
  const detail = (await admin.get(`/app/api/stock/items/${sproeier.id}`)).body;
  assert.strictEqual(detail.seoTitle, 'Sproeier Pro kopen bij ons');
  assert.strictEqual(detail.brand, 'Hunter');
  const page = await anonymous.get('/product/sproeier-pro-spr-1/');
  assert.match(page.text, /<title>Sproeier Pro kopen bij ons<\/title>/);
  assert.match(page.text, /<meta name="description" content="Koop de Sproeier Pro met gratis advies\.">/);
  assert.match(page.text, /<meta property="og:title" content="Sproeier Pro kopen bij ons">/);
  const productData = jsonLdOf(page.text).find((item) => item['@type'] === 'Product');
  assert.deepStrictEqual(productData.brand, { '@type': 'Brand', name: 'Hunter' });
  assert.strictEqual(productData.gtin13, '4006381333931');
  const created = await admin.post('/app/api/stock/items', { code: 'NIEUW-1', name: 'Nieuw artikel', onHand: 1, salePrice: 5, seoTitle: 'Nieuw titel', brand: 'Merk X' });
  assert.strictEqual(created.status, 201);
  const createdDetail = (await admin.get(`/app/api/stock/items/${created.body.id}`)).body;
  assert.deepStrictEqual([createdDetail.seoTitle, createdDetail.brand], ['Nieuw titel', 'Merk X'], 'ook bij aanmaken');
  // Te lange invoer wordt afgekapt; leeg maken geeft weer de automatische tekst.
  await admin.put(`/app/api/stock/items/${sproeier.id}`, { seoTitle: 'x'.repeat(200), seoDescription: 'y'.repeat(400) });
  const long = (await admin.get(`/app/api/stock/items/${sproeier.id}`)).body;
  assert.strictEqual(long.seoTitle.length, 70);
  assert.strictEqual(long.seoDescription.length, 160);
  await admin.put(`/app/api/stock/items/${sproeier.id}`, { seoTitle: '', seoDescription: '', brand: '' });
  const cleared = (await admin.get(`/app/api/stock/items/${sproeier.id}`)).body;
  assert.deepStrictEqual([cleared.seoTitle, cleared.seoDescription, cleared.brand], ['', '', '']);
});

test('pagina: eigen titel voor zoekmachines, anders de paginatitel; te lang wordt afgekapt', async () => {
  const { anonymous, admin } = await setupShop();
  assert.strictEqual((await admin.put('/app/api/admin/shop-content/pages/verzending', { title: 'Verzending', description: 'Zo leveren wij.', seoTitle: '  Verzending en levertijd <i>tuinberegening</i> ', body: '<p>Tekst</p>' })).status, 200);
  assert.strictEqual((await admin.post('/app/api/admin/shop-content/pages/verzending/publish', {})).status, 200);
  const page = await anonymous.get('/pagina/verzending/');
  assert.match(page.text, /<title>Verzending en levertijd tuinberegening<\/title>/);
  assert.match(page.text, /<meta name="description" content="Zo leveren wij\.">/);
  assert.match(page.text, /<meta property="og:title" content="Verzending en levertijd tuinberegening">/);
  await admin.put('/app/api/admin/shop-content/pages/verzending', { title: 'Verzending', seoTitle: 'z'.repeat(300), body: '<p>Tekst</p>' });
  await admin.post('/app/api/admin/shop-content/pages/verzending/publish', {});
  assert.match((await anonymous.get('/pagina/verzending/')).text, new RegExp(`<title>z{70}</title>`));
  await admin.put('/app/api/admin/shop-content/pages/verzending', { title: 'Verzending', body: '<p>Tekst</p>' });
  await admin.post('/app/api/admin/shop-content/pages/verzending/publish', {});
  assert.match((await anonymous.get('/pagina/verzending/')).text, /<title>Verzending – Aquatechshop\.nl<\/title>/);
});

test('shop uit: sitemap, llms.txt en feed bestaan niet', async () => {
  const db = openDb();
  const store = createStore(db);
  store.ensureTenant();
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db }));
  servers.push(server);
  const anonymous = createClient(base);
  for (const urlPath of ['/sitemap.xml', '/llms.txt', '/productfeed.xml']) assert.strictEqual((await anonymous.get(urlPath)).status, 404, urlPath);
  assert.match((await anonymous.get('/robots.txt')).text, /Disallow: \/\n/);
});

test('shop: zonder ingevuld webadres geen canonical en geen sitemap, ook niet met een vervalste Host-kop (W-07)', async () => {
  const { admin, base } = await setupShop();
  assert.strictEqual((await admin.put('/app/api/admin/settings', { shopPayment: { online: false, publicUrl: '' } })).status, 200);
  const home = await fetch(`${base}/`, { headers: { Host: 'evil.example' } });
  assert.doesNotMatch(await home.text(), /rel="canonical"|evil\.example/);
  assert.strictEqual((await fetch(`${base}/sitemap.xml`, { headers: { Host: 'evil.example' } })).status, 404);
});

test('productpagina: eigen omschrijving en specificaties, anders die uit de oude webshop; ook in JSON-LD en de meta-omschrijving (12)', async () => {
  const { anonymous, admin, db, main } = await setupShop();
  const items = (await admin.get('/app/api/stock')).body.items;
  const sproeier = items.find((item) => item.code === 'SPR-1');
  const buis = items.find((item) => item.code === 'BUIS-25');
  const saved = await admin.put(`/app/api/stock/items/${sproeier.id}`, { description: 'Een sterke sproeier.\n\n• Instelbaar\n• Robuust <b>', specifications: 'Aansluiting: 1/2 inch\nzonder dubbele punt\nWorp: 4-6 m' });
  assert.strictEqual(saved.status, 200);
  const detail = (await admin.get(`/app/api/stock/items/${sproeier.id}`)).body;
  assert.strictEqual(detail.description, 'Een sterke sproeier.\n\n• Instelbaar\n• Robuust <b>');
  assert.deepStrictEqual(detail.specifications, [{ name: 'Aansluiting', value: '1/2 inch' }, { name: 'Worp', value: '4-6 m' }]);
  const page = await anonymous.get('/product/sproeier-pro-spr-1/');
  assert.match(page.text, /<h2>Omschrijving<\/h2>\n<p>Een sterke sproeier\.<\/p>\n<ul><li>Instelbaar<\/li><li>Robuust &lt;b&gt;<\/li><\/ul>/);
  assert.match(page.text, /<th scope="row">Aansluiting<\/th><td>1\/2 inch<\/td>/);
  assert.match(page.text, /<meta name="description" content="Een sterke sproeier\. • Instelbaar • Robuust &lt;b&gt;">/);
  assert.strictEqual(jsonLdOf(page.text).find((item) => item['@type'] === 'Product').description, 'Een sterke sproeier. • Instelbaar • Robuust <b>');
  // Terugval: de omschrijving en zichtbare kenmerken van het gekoppelde webshopproduct.
  db.prepare("INSERT INTO shop_products (tenant_id, id, sku, name, attributes, description) VALUES (?, '77', 'BUIS-25', 'Buis', ?, ?)")
    .run(main, JSON.stringify([{ name: 'Diameter', visible: true, variation: false, options: ['25 mm'] }, { name: 'Kleur', visible: true, variation: true, options: ['Zwart'] }]), 'PE-buis voor beregening.');
  db.prepare("UPDATE stock_items SET shop_product_id = '77' WHERE tenant_id = ? AND id = ?").run(main, buis.id);
  const fallback = await anonymous.get('/product/pe-buis-25-mm-buis-25/');
  assert.match(fallback.text, /<p>PE-buis voor beregening\.<\/p>/);
  assert.match(fallback.text, /<th scope="row">Diameter<\/th><td>25 mm<\/td>/);
  assert.ok(!fallback.text.includes('>Kleur<'), 'een kenmerk voor variaties is geen specificatie');
  const buisDetail = (await admin.get(`/app/api/stock/items/${buis.id}`)).body;
  assert.strictEqual(buisDetail.description, '');
  assert.strictEqual(buisDetail.shopDescription, 'PE-buis voor beregening.');
  // De opgeslagen webshoptekst is al platte tekst: vergelijkingstekens blijven staan.
  db.prepare("UPDATE shop_products SET description = ? WHERE tenant_id = ? AND id = '77'").run('Diameter < 20 mm > 10 mm', main);
  assert.strictEqual((await admin.get(`/app/api/stock/items/${buis.id}`)).body.shopDescription, 'Diameter < 20 mm > 10 mm');
});
