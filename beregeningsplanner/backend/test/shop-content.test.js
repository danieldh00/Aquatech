// Inhoud van de eigen webshop bewerken (shop-content.js): saneren van pagina-HTML,
// concept en publiceren, voorbeeld voor beheerders, vaste pagina's, afbeeldingen,
// rechten en tenantgrenzen.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeHtml, normalizeSite, normalizePage, DEFAULT_SITE } = require('../src/webshop/shop-content');
const { createLogin, createClient, listen } = require('./helpers/http-client');

const SECRET = 'f'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/** Een geldige PNG van 1 pixel. */
const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/**
 * Hoofdtenant met beheerder en klant, testserver en de webshop aan.
 * @returns {Promise<object>} db, base, admin (beheerder), customer (klant), anonymous en store.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'jan.klant', displayName: 'Jan', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  servers.push(server);
  const login = createLogin(base, { password: PW });
  const admin = await login('baas');
  assert.strictEqual((await admin.put('/api/admin/settings', { storefront: true })).status, 200);
  for (const item of [{ code: 'SPR-1', name: 'Sproeier Pro', onHand: 5, salePrice: 10 }, { code: 'BUIS-25', name: 'PE buis 25 mm', onHand: 100, salePrice: 1.5 }]) {
    assert.strictEqual((await admin.post('/api/stock/items', item)).status, 201);
  }
  return { db, base, store, admin, customer: await login('jan.klant'), anonymous: createClient(base) };
}

test('sanitizeHtml houdt opmaak, haalt scripts en gevaarlijke links weg', () => {
  const clean = sanitizeHtml('<h1 onclick="x()">Kop</h1><p>Tekst <b>vet</b> &amp; <i>schuin</i></p><script>alert(1)</script><style>p{}</style>'
    + '<a href="javascript:alert(1)">fout</a><a href=" https://voorbeeld.nl/x?a=1&b=2 " onmouseover="x()">goed</a><iframe src="https://x"></iframe>'
    + '<img src="https://evil/x.png"><img src="media:11111111-1111-1111-1111-111111111111" onerror="x()" alt="Foto"><ul><li>een<li>twee</ul>');
  assert.strictEqual(clean, '<h2>Kop</h2><p>Tekst <strong>vet</strong> &amp; <em>schuin</em></p>fout<a href="https://voorbeeld.nl/x?a=1&amp;b=2" rel="noopener noreferrer">goed</a>'
    + '<img src="media:11111111-1111-1111-1111-111111111111" alt="Foto"><ul><li>een<li>twee</li></li></ul>');
  assert.ok(!/script|onclick|onerror|javascript|iframe|style/i.test(clean));
  assert.strictEqual(sanitizeHtml('<p>open <strong>nooit gesloten'), '<p>open <strong>nooit gesloten</strong></p>');
  assert.strictEqual(sanitizeHtml('1 < 2 en <3'), '1 &lt; 2 en &lt;3');
  assert.strictEqual(sanitizeHtml('<a href="tel:+31647212019">bel</a> <a href="mailto:info@voorbeeld.nl">mail</a>'), '<a href="tel:+31647212019" rel="noopener noreferrer">bel</a> <a href="mailto:info@voorbeeld.nl" rel="noopener noreferrer">mail</a>');
});

test('normalizeSite vult aan met de standaard en weigert ongeldige waarden', () => {
  assert.deepStrictEqual(normalizeSite({}), DEFAULT_SITE);
  const site = normalizeSite({
    notice: { enabled: false, text: 'Even gesloten' }, hero: { title: 'Nieuwe kop', image: 'asset:bestaat-niet.png', link: 'javascript:alert(1)' },
    benefits: { items: [{ title: '', text: 'zonder titel' }, { title: 'Snel', text: 'Morgen in huis', image: 'asset:usp-bezorgd.png' }] },
    brands: { enabled: false, items: [{ image: 'https://evil/x.png', name: 'Fout' }, { image: 'asset:merk-dab.webp', name: 'DAB' }] },
    contact: { phone: '06-123 <b>', email: 'geen-adres' },
  });
  assert.strictEqual(site.notice.enabled, false);
  assert.strictEqual(site.hero.title, 'Nieuwe kop');
  assert.strictEqual(site.hero.image, DEFAULT_SITE.hero.image, 'onbekend bestand valt terug op de standaard');
  assert.strictEqual(site.hero.link, '');
  assert.strictEqual(normalizeSite({ business: { image: '' } }).business.image, '', 'zakelijk blok zonder afbeelding blijft leeg');
  assert.deepStrictEqual(site.benefits.items, [{ image: 'asset:usp-bezorgd.png', title: 'Snel', text: 'Morgen in huis' }]);
  assert.deepStrictEqual(site.brands.items, [{ image: 'asset:merk-dab.webp', name: 'DAB' }]);
  assert.strictEqual(site.contact.phone, '06-123 ');
  assert.strictEqual(site.contact.email, DEFAULT_SITE.contact.email);
  assert.strictEqual(normalizePage('Ab', { title: 'x' }).error, 'invalid_slug');
  assert.strictEqual(normalizePage('klantenservice', { title: ' ' }).error, 'title_required');
  assert.strictEqual(normalizePage('klantenservice', { title: 'Klantenservice', body: 'x'.repeat(100001) }).error, 'too_long');
});

test('blokken: concept, voorbeeld, publiceren en vorige versie terugzetten', async () => {
  const { admin, anonymous } = await setup();
  const start = await admin.get('/api/admin/shop-content');
  assert.strictEqual(start.status, 200);
  assert.strictEqual(start.body.available, true);
  assert.strictEqual(start.body.site.isDefault, true);
  assert.ok(start.body.assets.includes('hero-tuin.jpg'));
  assert.match((await anonymous.get('/winkel/')).text, /Alles voor uw tuinberegening/);

  const draft = await admin.put('/api/admin/shop-content/site', { hero: { title: 'Tuinseizoen is begonnen' }, notice: { enabled: false } });
  assert.strictEqual(draft.status, 200);
  assert.strictEqual(draft.body.site.hasDraft, true);
  assert.strictEqual(draft.body.site.draft.hero.title, 'Tuinseizoen is begonnen');
  assert.strictEqual(draft.body.site.draft.hero.text, DEFAULT_SITE.hero.text, 'rest blijft standaard');

  // Bezoekers zien het concept niet, een beheerder met ?voorbeeld=1 wel.
  assert.match((await anonymous.get('/winkel/')).text, /Alles voor uw tuinberegening/);
  assert.match((await anonymous.get('/winkel/?voorbeeld=1')).text, /Alles voor uw tuinberegening/);
  const preview = await admin.get('/winkel/?voorbeeld=1');
  assert.match(preview.text, /Tuinseizoen is begonnen/);
  assert.doesNotMatch(preview.text, /shop-notice/);
  assert.strictEqual(preview.headers.get('cache-control'), 'no-store');
  assert.match(preview.headers.get('x-robots-tag'), /noindex/);

  const published = await admin.post('/api/admin/shop-content/site/publish', {});
  assert.strictEqual(published.status, 200);
  assert.strictEqual(published.body.site.hasDraft, false);
  assert.strictEqual(published.body.site.isDefault, false);
  const live = await anonymous.get('/winkel/');
  assert.match(live.text, /Tuinseizoen is begonnen/);
  assert.doesNotMatch(live.text, /shop-notice/);

  assert.strictEqual((await admin.post('/api/admin/shop-content/site/publish', {})).status, 409, 'zonder concept niets te publiceren');
  assert.strictEqual((await admin.post('/api/admin/shop-content/site/revert', {})).status, 409, 'nog geen vorige versie');

  await admin.put('/api/admin/shop-content/site', { hero: { title: 'Tweede versie' } });
  assert.match((await admin.get('/winkel/?voorbeeld=1')).text, /Tweede versie/);
  const discarded = await admin.post('/api/admin/shop-content/site/discard', {});
  assert.strictEqual(discarded.body.site.hasDraft, false);
  assert.match((await admin.get('/winkel/?voorbeeld=1')).text, /Tuinseizoen is begonnen/);

  await admin.put('/api/admin/shop-content/site', { hero: { title: 'Tweede versie' } });
  const republished = await admin.post('/api/admin/shop-content/site/publish', {});
  assert.strictEqual(republished.body.site.canRevert, true);
  const reverted = await admin.post('/api/admin/shop-content/site/revert', {});
  assert.strictEqual(reverted.status, 200);
  assert.match((await anonymous.get('/winkel/')).text, /Tuinseizoen is begonnen/);
});

test('contactgegevens, voordelen en merken komen uit de gepubliceerde blokken', async () => {
  const { admin, anonymous } = await setup();
  await admin.put('/api/admin/shop-content/site', {
    contact: { phone: '085 1234567', email: 'verkoop@voorbeeld.nl', kvk: '12345678', address: 'Hoofdstraat 1, Nunspeet' },
    footer: { about: 'Wij leveren <b>alles</b>' },
    benefits: { items: [{ title: 'Gratis advies', text: 'Bel ons' }] },
    brands: { title: 'Merken die wij voeren', items: [{ image: 'asset:merk-dab.webp', name: 'DAB' }] },
    business: { enabled: false },
  });
  await admin.post('/api/admin/shop-content/site/publish', {});
  const home = (await anonymous.get('/winkel/')).text;
  assert.match(home, /href="tel:\+31851234567"/);
  assert.match(home, /verkoop@voorbeeld\.nl/);
  assert.match(home, /K\.v\.k\.: 12345678/);
  assert.match(home, /Hoofdstraat 1, Nunspeet/);
  assert.match(home, /Wij leveren &lt;b&gt;alles&lt;\/b&gt;/, 'tekst wordt ontsnapt');
  assert.match(home, /Gratis advies/);
  assert.doesNotMatch(home, /Zeer compleet assortiment/);
  assert.match(home, /Merken die wij voeren/);
  assert.doesNotMatch(home, /merk-ebara/);
  assert.doesNotMatch(home, /class="business"/);
});

test('vaste pagina: concept, publiceren, menu, voet en Over ons overschrijven', async () => {
  const { admin, anonymous, base } = await setup();
  const body = '<h2>Verzending</h2><p>Binnen 2 werkdagen <a href="https://voorbeeld.nl">geleverd</a>.</p><script>alert(1)</script>';
  const saved = await admin.put('/api/admin/shop-content/pages/verzending-retour', { title: 'Verzending & retour', description: 'Hoe wij leveren', body, menu: true, footer: true, order: 5 });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.body.pages.length, 1);
  assert.ok(!saved.body.pages[0].draft.body.includes('script'));
  assert.strictEqual((await anonymous.get('/winkel/pagina/verzending-retour/')).status, 404, 'concept is niet openbaar');
  assert.match((await admin.get('/winkel/pagina/verzending-retour/?voorbeeld=1')).text, /Binnen 2 werkdagen/);
  assert.doesNotMatch((await anonymous.get('/winkel/')).text, /Verzending &amp; retour/);

  assert.strictEqual((await admin.post('/api/admin/shop-content/pages/verzending-retour/publish', {})).status, 200);
  const page = await anonymous.get('/winkel/pagina/verzending-retour/');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /<h1>Verzending &amp; retour<\/h1>/);
  assert.match(page.text, /<a href="https:\/\/voorbeeld.nl" rel="noopener noreferrer">geleverd<\/a>/);
  assert.match(page.text, /<meta name="description" content="Hoe wij leveren">/);
  const home = (await anonymous.get('/winkel/')).text;
  assert.match(home, /<li class="nav-about"><a href="pagina\/verzending-retour\/">Verzending &amp; retour<\/a><\/li>/);
  assert.match(home, /<li><a href="pagina\/verzending-retour\/">Verzending &amp; retour<\/a><\/li>/, 'ook in de voet');
  assert.strictEqual((await createClient(base, { followRedirects: false }).get('/winkel/pagina/verzending-retour')).location, 'verzending-retour/');

  // Over ons: standaardpagina totdat er een eigen versie is.
  assert.match((await anonymous.get('/winkel/over-ons/')).text, /Waarom Aquatechshop/);
  await admin.put('/api/admin/shop-content/pages/over-ons', { title: 'Over ons', body: '<p>Ons eigen verhaal.</p>' });
  await admin.post('/api/admin/shop-content/pages/over-ons/publish', {});
  const about = (await anonymous.get('/winkel/over-ons/')).text;
  assert.match(about, /Ons eigen verhaal/);
  assert.doesNotMatch(about, /Waarom Aquatechshop/);
  assert.doesNotMatch((await anonymous.get('/winkel/')).text, /pagina\/over-ons/, 'Over ons staat al in het menu');
  await admin.post('/api/admin/shop-content/pages/over-ons/revert', {}).then((out) => assert.strictEqual(out.status, 409));
  assert.strictEqual((await admin.del('/api/admin/shop-content/pages/over-ons')).status, 200);
  assert.match((await anonymous.get('/winkel/over-ons/')).text, /Waarom Aquatechshop/);

  assert.strictEqual((await admin.del('/api/admin/shop-content/pages/verzending-retour')).status, 200);
  assert.strictEqual((await anonymous.get('/winkel/pagina/verzending-retour/')).status, 404);
  assert.strictEqual((await admin.del('/api/admin/shop-content/pages/bestaat-niet')).status, 404);
  assert.strictEqual((await admin.put('/api/admin/shop-content/pages/ab', { title: 'x' })).status, 400);
  assert.strictEqual((await admin.put('/api/admin/shop-content/pages/geen-titel', { title: '' })).status, 400);
});

test('afbeeldingen uploaden, tonen in een pagina en pas verwijderen als ze ongebruikt zijn', async () => {
  const { admin, anonymous, db } = await setup();
  const upload = await admin.post('/api/admin/shop-content/images', { name: 'C:\\fotos\\tuin.png', data: `data:image/png;base64,${PIXEL_PNG.toString('base64')}` });
  assert.strictEqual(upload.status, 201);
  const image = upload.body.image;
  assert.strictEqual(image.name, 'tuin.png');
  assert.strictEqual(image.mime, 'image/png');
  const stored = db.prepare('SELECT data FROM shop_images WHERE id = ?').get(image.id).data;
  assert.match(stored, /^f1:/, 'versleuteld opgeslagen');

  const fromAdmin = await admin.get(`/api/admin/shop-content/images/${image.id}`);
  assert.strictEqual(fromAdmin.status, 200);
  assert.deepStrictEqual(fromAdmin.raw, PIXEL_PNG);
  assert.strictEqual((await anonymous.get(`/api/admin/shop-content/images/${image.id}`)).status, 401);

  await admin.put('/api/admin/shop-content/pages/foto', { title: 'Foto', body: `<p><img src="media:${image.id}" alt="Tuin"></p>` });
  await admin.post('/api/admin/shop-content/pages/foto/publish', {});
  assert.match((await anonymous.get('/winkel/pagina/foto/')).text, new RegExp(`<img loading="lazy" src="\\.\\./\\.\\./media/${image.id}"`));
  const served = await anonymous.get(`/winkel/media/${image.id}`);
  assert.strictEqual(served.status, 200);
  assert.strictEqual(served.type, 'image/png');
  assert.match(served.headers.get('cache-control'), /immutable/);
  assert.strictEqual((await anonymous.get('/winkel/media/00000000-0000-0000-0000-000000000000')).status, 404);
  assert.strictEqual((await anonymous.get('/winkel/media/niet-een-id')).status, 404);

  assert.strictEqual((await admin.del(`/api/admin/shop-content/images/${image.id}`)).status, 409, 'in gebruik');
  await admin.del('/api/admin/shop-content/pages/foto');
  assert.strictEqual((await admin.del(`/api/admin/shop-content/images/${image.id}`)).status, 200);
  assert.strictEqual((await anonymous.get(`/winkel/media/${image.id}`)).status, 404);

  // Alleen echte afbeeldingen; een script met een png-naam of een SVG wordt geweigerd.
  assert.strictEqual((await admin.post('/api/admin/shop-content/images', { name: 'x.png', data: Buffer.from('<script>alert(1)</script>').toString('base64') })).status, 400);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.strictEqual((await admin.post('/api/admin/shop-content/images', { name: 'x.svg', data: svg.toString('base64') })).status, 400);
  assert.strictEqual((await admin.post('/api/admin/shop-content/images', { name: 'x.png' })).status, 400);
});

test('rechten en tenantgrenzen van de webshop-inhoud', async () => {
  const { admin, customer, anonymous, base, store } = await setup();
  for (const client of [anonymous, customer]) {
    const out = await client.get('/api/admin/shop-content');
    assert.strictEqual(out.status, client === anonymous ? 401 : 403);
    assert.strictEqual((await client.put('/api/admin/shop-content/site', { hero: { title: 'Hack' } })).status, client === anonymous ? 401 : 403);
    assert.strictEqual((await client.post('/api/admin/shop-content/images', { data: PIXEL_PNG.toString('base64') })).status, client === anonymous ? 401 : 403);
  }
  // Een klant ziet het voorbeeld niet en een bezoeker ook niet.
  await admin.put('/api/admin/shop-content/site', { hero: { title: 'Geheim concept' } });
  assert.doesNotMatch((await customer.get('/winkel/?voorbeeld=1')).text, /Geheim concept/);
  assert.doesNotMatch((await anonymous.get('/winkel/?voorbeeld=1')).text, /Geheim concept/);

  // Een andere organisatie heeft eigen beheerders, maar geen webshop-inhoud: 404.
  const groen = store.createTenant({ name: 'Groen', slug: 'groen' }).tenant.id;
  await store.createAccount(groen, { username: 'tuinman', displayName: 'Tuinman', role: 'beheerder', password: PW });
  const other = await createLogin(base, { password: PW })('tuinman', 'groen');
  const view = await other.get('/api/admin/shop-content');
  assert.strictEqual(view.status, 200);
  assert.strictEqual(view.body.available, false);
  assert.strictEqual((await other.put('/api/admin/shop-content/site', { hero: { title: 'Hack' } })).status, 404);
  assert.strictEqual((await other.put('/api/admin/shop-content/pages/hack', { title: 'Hack' })).status, 404);
  assert.strictEqual((await other.post('/api/admin/shop-content/site/publish', {})).status, 404);
  assert.strictEqual((await other.post('/api/admin/shop-content/images', { data: PIXEL_PNG.toString('base64') })).status, 404);
  assert.match((await admin.get('/winkel/?voorbeeld=1')).text, /Geheim concept/);
});

test('webshop uit: beheerder ziet voorbeeld mét opmaak en afbeeldingen, bezoeker niets', async () => {
  const { admin, anonymous } = await setup();
  assert.strictEqual((await admin.put('/api/admin/settings', { storefront: false })).status, 200);
  assert.strictEqual((await anonymous.get('/winkel/assets/winkel.css')).status, 404);
  assert.strictEqual((await anonymous.get('/winkel/?voorbeeld=1')).status, 404);
  assert.strictEqual((await admin.get('/winkel/?voorbeeld=1')).status, 200);
  assert.strictEqual((await admin.get('/winkel/assets/winkel.css')).status, 200);
  assert.strictEqual((await admin.get('/winkel/')).status, 404, 'zonder voorbeeld ziet ook een beheerder de uitgeschakelde shop niet');
});

test('de webshop-inhoud heeft geen SELECT * en staat in de standaard-assets', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'webshop', 'shop-content.js'), 'utf8');
  assert.doesNotMatch(source, /SELECT\s+\*/i);
  for (const reference of [DEFAULT_SITE.hero.image, DEFAULT_SITE.business.image, ...DEFAULT_SITE.benefits.items.map((item) => item.image), ...DEFAULT_SITE.brands.items.map((item) => item.image)]) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'webshop', 'assets', reference.replace(/^asset:/, ''))), `${reference} ontbreekt`);
  }
});
