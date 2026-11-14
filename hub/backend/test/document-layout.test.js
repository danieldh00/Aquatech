// Documentopmaak (verkoop/document-layout.js): opschonen van de instelling, kop en voet in de factuur- en pakbon-PDF
// (logo, kopstijl, kleur, lettertype, voettekst), de routes in Beheer (rechten, scheiding tussen organisaties,
// voorbeeld) en het lettertype met schreef in de PDF-schrijver.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createPdf, textWidth, wrap } = require('../src/verkoop/pdf');
const { DEFAULTS, sanitizeDocumentLayout, layoutProblem, sampleInvoice, sampleOrder } = require('../src/verkoop/document-layout');
const { invoicePdf } = require('../src/verkoop/invoice-pdf');
const { packingSlipsPdf } = require('../src/webshop/packing-slips');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 'e'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Een kleine, geldige PNG (8 bit RGBA, zonder interlacing) in één kleur.
 * @param {number} [width] Breedte in pixels.
 * @param {number} [height] Hoogte in pixels.
 * @returns {Buffer} Het PNG-bestand.
 */
function makePng(width = 8, height = 4) {
  /**
   * Eén PNG-blok: lengte, soort, inhoud en controlegetal.
   * @param {string} type De soort (IHDR, IDAT, IEND).
   * @param {Buffer} data De inhoud.
   * @returns {Buffer} Het blok.
   */
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height, 0x80);
  for (let row = 0; row < height; row++) rows[row * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Een PNG als data-adres, zoals het beheerscherm hem opstuurt.
 * @param {Buffer} [png] De PNG.
 * @returns {string} Het data-adres.
 */
const dataUrl = (png = makePng()) => `data:image/png;base64,${png.toString('base64')}`;

/**
 * De inhoud van alle gecomprimeerde streams van een PDF, achter elkaar (de tekencommando's per pagina).
 * @param {Buffer} pdf De PDF.
 * @returns {string} De uitgepakte streams.
 */
function pdfContent(pdf) {
  const text = pdf.toString('latin1');
  const out = [];
  for (const match of text.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    try { out.push(zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')); } catch { /* beeldgegevens */ }
  }
  return out.join('\n');
}

/**
 * Het aantal afbeeldingen (zonder maskers) in een PDF.
 * @param {Buffer} pdf De PDF.
 * @returns {number} Het aantal.
 */
const imageCount = (pdf) => (pdf.toString('latin1').match(/\/Subtype \/Image[^>]*\/ColorSpace \/DeviceRGB/g) || []).length;

test('sanitizeDocumentLayout: standaard, grenzen, onbekende velden en een logo dat ontbreekt of niet deugt', () => {
  assert.deepStrictEqual(sanitizeDocumentLayout(undefined), DEFAULTS);
  assert.deepStrictEqual(sanitizeDocumentLayout('onzin'), DEFAULTS);
  assert.deepStrictEqual(sanitizeDocumentLayout([1]), DEFAULTS);
  const clean = sanitizeDocumentLayout({ logoMode: 'custom', logo: dataUrl(), logoPosition: 'right', logoHeight: 500, headerStyle: 'plain', headerColor: '#ABCDEF', accentColor: 'rood',
    font: 'comic', showCompanyInHeader: 'ja', footerText: `  ${'x'.repeat(300)}  `, pageNumbers: false, onbekend: 1 });
  assert.strictEqual(clean.logoMode, 'custom');
  assert.strictEqual(clean.logoPosition, 'right');
  assert.strictEqual(clean.logoHeight, 80, 'hoogte op het maximum');
  assert.strictEqual(sanitizeDocumentLayout({ logoHeight: 1 }).logoHeight, 20, 'hoogte op het minimum');
  assert.strictEqual(clean.headerColor, '#abcdef');
  assert.strictEqual(clean.accentColor, '', 'een ongeldige kleur valt weg');
  assert.strictEqual(clean.font, 'sans');
  assert.strictEqual(clean.showCompanyInHeader, true, 'geen ja/nee = de standaard');
  assert.strictEqual(clean.footerText.length, 200);
  assert.strictEqual(clean.pageNumbers, false);
  assert.ok(!('onbekend' in clean));
  // Eigen logo zonder bruikbaar bestand = het standaardlogo.
  assert.strictEqual(sanitizeDocumentLayout({ logoMode: 'custom', logo: '' }).logoMode, 'default');
  assert.strictEqual(sanitizeDocumentLayout({ logoMode: 'custom', logo: 'data:image/png;base64,AAAA' }).logoMode, 'default');
  assert.strictEqual(sanitizeDocumentLayout({ logoMode: 'custom', logo: 'https://voorbeeld.nl/logo.png' }).logo, '', 'geen adres naar buiten');
  assert.strictEqual(sanitizeDocumentLayout({ logoMode: 'custom', logo: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` }).logo, '');
});

test('layoutProblem: logo, kleuren en contrast met duidelijke meldingen', () => {
  assert.strictEqual(layoutProblem({}), '');
  assert.strictEqual(layoutProblem({ logoMode: 'custom', logo: dataUrl() }), '');
  assert.match(layoutProblem({ logoMode: 'custom', logo: '' }), /PNG/);
  assert.match(layoutProblem({ logoMode: 'custom', logo: dataUrl(makePng(3000, 2)) }), /pixels/);
  assert.match(layoutProblem({ logo: dataUrl(Buffer.concat([Buffer.alloc(300 * 1024 + 10, 1)])) }), /PNG/);
  assert.match(layoutProblem({ headerColor: 'rood' }), /Kopkleur/);
  assert.match(layoutProblem({ accentColor: '#12' }), /Accentkleur/);
  assert.match(layoutProblem({ headerColor: '#ffee99' }), /te licht/);
  assert.match(layoutProblem(null), /Ongeldige/);
  // Een PNG met een ander kleurtype (hier: palet) kan de PDF-schrijver niet aan en wordt geweigerd.
  const palette = makePng();
  palette[25] = 3;
  assert.match(layoutProblem({ logoMode: 'custom', logo: dataUrl(palette) }), /PDF/);
});

test('PNG-bom: een kleine PNG die veel groter uitpakt dan de kop belooft wordt geweigerd', () => {
  const { pngImage } = require('../src/verkoop/pdf');
  const png = makePng(8, 4);
  const bomb = Buffer.from(png);
  // Vervang de pixelgegevens door een veel grotere uitgepakte stroom (dezelfde kop: 8 x 4).
  const header = png.subarray(0, 33);
  const data = zlib.deflateSync(Buffer.alloc(50 * 1024 * 1024));
  const chunkHead = Buffer.alloc(8);
  chunkHead.writeUInt32BE(data.length, 0); chunkHead.write('IDAT', 4, 'latin1');
  const bombPng = Buffer.concat([header, chunkHead, data, Buffer.alloc(4), png.subarray(png.length - 12)]);
  assert.ok(pngImage(bomb), 'de gewone PNG werkt');
  assert.strictEqual(pngImage(bombPng), null);
  assert.match(layoutProblem({ logoMode: 'custom', logo: dataUrl(bombPng) }), /PDF|PNG/);
});

test('PDF-schrijver: lettertype met schreef meet en schrijft Times, en blijft binnen de regel', () => {
  assert.ok(textWidth('Voorbeeldtekst', 10, false, 'serif') < textWidth('Voorbeeldtekst', 10, false, 'sans'), 'Times is smaller dan Helvetica');
  assert.strictEqual(textWidth('Abc', 10, false, 'onbekend'), textWidth('Abc', 10, false, 'sans'), 'een onbekend lettertype valt terug op sans');
  const lines = wrap('Een lange zin met een aantal woorden die samen niet op één regel passen', 120, 10, false, 'serif');
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(textWidth(line, 10, false, 'serif') <= 120);
  const serif = createPdf({ font: 'serif' });
  serif.addPage();
  serif.text('Hallo', 10, 10);
  serif.text('Vet', 10, 30, { bold: true });
  const text = serif.toBuffer().toString('latin1');
  assert.match(text, /\/BaseFont \/Times-Roman/);
  assert.match(text, /\/BaseFont \/Times-Bold/);
  assert.doesNotMatch(text, /Helvetica/);
  assert.strictEqual(serif.wrap('aaa bbb', 1000, 10).length, 1, 'de afbreking in het document gebruikt zijn eigen lettertype');
  assert.match(createPdf().toBuffer().toString('latin1'), /\/BaseFont \/Helvetica /);
});

test('factuur-PDF: standaardopmaak, eigen logo, witte kop, lettertype en voettekst', () => {
  const invoice = sampleInvoice();
  const profile = { companyName: 'Tuinbedrijf Test', address: 'Straat 1\n8071 AB Nunspeet', kvk: '12345678', vatNumber: 'NL001234567B01', iban: 'NL00BANK0123456789', phone: '0612345678', email: 'info@test.nl' };
  const base = invoicePdf(invoice, { profile });
  assert.strictEqual(base.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.strictEqual(imageCount(base), 1, 'het standaardlogo');
  assert.match(pdfContent(base), /KvK 12345678/);
  assert.match(pdfContent(base), /IBAN NL00BANK0123456789/);
  assert.match(base.toString('latin1'), /Helvetica/);
  // Zonder opmaak (null) en met de standaardopmaak is het resultaat gelijk.
  assert.strictEqual(invoicePdf(invoice, { profile, layout: DEFAULTS }).length, base.length);

  const custom = invoicePdf(invoice, { profile, layout: { logoMode: 'custom', logo: dataUrl(makePng(40, 10)), logoPosition: 'right', headerStyle: 'plain', headerColor: '#224466', accentColor: '#cc3300',
    font: 'serif', footerText: 'Alle leveringen volgens onze voorwaarden.', footerCompanyInfo: false, pageNumbers: true } });
  assert.strictEqual(imageCount(custom), 1, 'het eigen logo');
  assert.match(custom.toString('latin1'), /Times-Roman/);
  const content = pdfContent(custom);
  assert.match(content, /Alle leveringen volgens onze voorwaarden/);
  assert.doesNotMatch(content, /KvK 12345678/, 'de bedrijfsregel kan uit');
  assert.match(content, /0\.8 0\.2 0 RG/, 'de accentkleur #cc3300 voor de lijn boven de voet');
  assert.doesNotMatch(content, /0\.09 0\.18 0\.37 rg\n?0 \d+ 595/, 'een witte kop vult geen balk in de kopkleur');

  // Wit met een lijn en zonder eigen logo: het witte standaardlogo past daar niet, dus staat de bedrijfsnaam als tekst.
  const plainNoLogo = invoicePdf(invoice, { profile, layout: { headerStyle: 'plain' } });
  assert.strictEqual(imageCount(plainNoLogo), 0);
  assert.match(pdfContent(plainNoLogo), /\(Tuinbedrijf Test\)/);
  // Geen logo gewenst.
  assert.strictEqual(imageCount(invoicePdf(invoice, { profile, layout: { logoMode: 'none' } })), 0);
  // Zonder paginanummers en zonder bedrijfsgegevens in de kop.
  const minimal = pdfContent(invoicePdf(invoice, { profile, layout: { showCompanyInHeader: false, pageNumbers: false } }));
  assert.doesNotMatch(minimal, /Straat 1/);
});

test('factuur-PDF: lange factuur houdt kop en voet op elke pagina, ook met een hoog logo en een tweeregelige voettekst', () => {
  const invoice = sampleInvoice();
  invoice.data.lines = Array.from({ length: 80 }, (_, index) => ({ description: `Regel ${index} met een omschrijving`, qty: 1, unit: 'st', price: 10, vat: 21, code: `C${index}` }));
  const buffer = invoicePdf(invoice, { profile: { companyName: 'Test BV', kvk: '1' }, layout: { logoMode: 'custom', logo: dataUrl(makePng(200, 10)), logoHeight: 80, footerText: 'Regel een. '.repeat(40) } });
  const pages = Number(/\/Count (\d+) /.exec(buffer.toString('latin1'))[1]);
  assert.ok(pages >= 3);
  assert.strictEqual((pdfContent(buffer).match(/Pagina \d+ van \d+/g) || []).length, pages, 'paginanummer op elke pagina');
});

test('pakbon-PDF volgt dezelfde opmaak', () => {
  const profile = { companyName: 'Tuinbedrijf Test', kvk: '123' };
  const order = sampleOrder();
  const base = packingSlipsPdf([order], { profile });
  assert.strictEqual(imageCount(base), 1);
  const custom = packingSlipsPdf([order, { ...order, number: 'WEB-2026-0002' }], { profile, layout: { logoMode: 'none', font: 'serif', footerText: 'Pakbon voettekst', headerStyle: 'plain' } });
  assert.strictEqual(imageCount(custom), 0);
  assert.match(custom.toString('latin1'), /Times-Roman/);
  assert.match(pdfContent(custom), /Pakbon voettekst/);
});

/**
 * Hoofdtenant met beheerder en niet-beheerders, en een tweede organisatie.
 * @returns {Promise<object>} admin, planner, customer en outsider (clients).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'planner1', displayName: 'Planner', role: 'planner', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'klant1', displayName: 'Klant', role: 'klant', password: PW }, { mustChangePassword: false });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  return { admin: await as('baas'), planner: await as('planner1'), customer: await as('klant1'), outsider: await as('vreemd', 'ander'), base };
}

test('routes: lezen, opslaan, voorbeeld, rechten en scheiding tussen organisaties', async () => {
  const { admin, planner, customer, outsider } = await setup();
  const url = '/app/api/admin/document-layout';
  const first = await admin.get(url);
  assert.strictEqual(first.status, 200);
  assert.deepStrictEqual(first.body.layout, DEFAULTS);
  assert.deepStrictEqual(first.body.defaults, DEFAULTS);
  assert.strictEqual(first.body.limits.logoBytes, 300 * 1024);

  // Opslaan; wat de server terugstuurt is de schone opmaak.
  const layout = { ...DEFAULTS, logoMode: 'custom', logo: dataUrl(), headerStyle: 'plain', font: 'serif', footerText: 'Voettekst', headerColor: '#224466' };
  const saved = await admin.put(url, { layout });
  assert.strictEqual(saved.status, 200, saved.text.slice(0, 200));
  assert.strictEqual(saved.body.layout.font, 'serif');
  assert.strictEqual(saved.body.layout.logo, layout.logo);
  assert.deepStrictEqual((await admin.get(url)).body.layout, saved.body.layout);

  // Ongeldig: duidelijke melding, niets opgeslagen.
  const bad = await admin.put(url, { layout: { ...layout, headerColor: '#ffee99' } });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error, 'invalid_layout');
  assert.match(bad.body.message, /te licht/);
  assert.strictEqual((await admin.put(url, { layout: { logoMode: 'custom', logo: 'https://voorbeeld.nl/x.png' } })).status, 400);
  assert.strictEqual((await admin.put(url, {})).status, 400);
  assert.strictEqual((await admin.get(url)).body.layout.headerColor, '#224466');

  // Een logo van een paar honderd kB past door de bodygrens; een logo van een paar MB niet.
  const big = makePng(8, 4);
  assert.strictEqual((await admin.put(url, { layout: { logoMode: 'custom', logo: dataUrl(Buffer.concat([big, Buffer.alloc(200 * 1024)])) } })).status, 200);
  assert.strictEqual((await admin.put(url, { layout: { logo: dataUrl(Buffer.concat([big, Buffer.alloc(2 * 1024 * 1024)])) } })).status, 413);

  // Voorbeeld met de opmaak uit het formulier, zonder iets op te slaan.
  const before = (await admin.get(url)).body.layout;
  const invoicePreview = await admin.post(`${url}/preview`, { layout: { ...DEFAULTS, font: 'serif', logoMode: 'none' }, kind: 'invoice' });
  assert.strictEqual(invoicePreview.status, 200);
  assert.match(invoicePreview.type, /application\/pdf/);
  assert.strictEqual(invoicePreview.headers.get('cache-control'), 'no-store');
  assert.match(invoicePreview.raw.toString('latin1'), /Times-Roman/);
  const packingPreview = await admin.post(`${url}/preview`, { layout: DEFAULTS, kind: 'packing' });
  assert.strictEqual(packingPreview.status, 200);
  assert.strictEqual(packingPreview.raw.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.strictEqual((await admin.post(`${url}/preview`, { layout: { headerColor: 'x' } })).status, 400);
  assert.strictEqual((await admin.post(`${url}/preview`, { layout: DEFAULTS, kind: 'offerte' })).status, 400);
  assert.deepStrictEqual((await admin.get(url)).body.layout, before);

  // Standaard terugzetten.
  assert.deepStrictEqual((await admin.put(url, { layout: DEFAULTS })).body.layout, DEFAULTS);

  // Rechten: alleen met het recht beheer.
  for (const client of [planner, customer]) {
    assert.strictEqual((await client.get(url)).status, 403);
    assert.strictEqual((await client.put(url, { layout: DEFAULTS })).status, 403);
    assert.strictEqual((await client.post(`${url}/preview`, { layout: DEFAULTS })).status, 403);
  }
  // Een andere organisatie heeft zijn eigen opmaak; wat de ene opslaat ziet de andere niet.
  await admin.put(url, { layout: { ...DEFAULTS, footerText: 'Alleen de hoofdorganisatie' } });
  assert.strictEqual((await outsider.get(url)).body.layout.footerText, '');
  await outsider.put(url, { layout: { ...DEFAULTS, footerText: 'Andere organisatie' } });
  assert.strictEqual((await admin.get(url)).body.layout.footerText, 'Alleen de hoofdorganisatie');
});

test('de opmaak staat niet in de algemene instellingen (alleen via het eigen scherm)', async () => {
  const { admin } = await setup();
  await admin.put('/app/api/admin/document-layout', { layout: { ...DEFAULTS, footerText: 'Geheim?' } });
  const settings = await admin.get('/app/api/admin/settings');
  assert.strictEqual(settings.status, 200);
  assert.ok(!JSON.stringify(settings.body).includes('documentLayout'));
  const attempt = await admin.put('/app/api/admin/settings', { documentLayout: { footerText: 'via instellingen' } });
  assert.notStrictEqual(attempt.status, 200);
  assert.strictEqual((await admin.get('/app/api/admin/document-layout')).body.layout.footerText, 'Geheim?');
});

/**
 * Laadt shared/doc-layout.js in een sandbox met een window, zoals de browser dat doet.
 * @returns {{ wrap: Function, logoHtml: Function, footerHtml: Function }} De hulpfuncties.
 */
function loadBrowserLayout() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'shared', 'doc-layout.js'), 'utf8'), sandbox);
  return sandbox.window.AquatechDocLayout;
}

test('afgedrukte documenten: wikkel, logo en voet volgens de opmaak', () => {
  const layout = loadBrowserLayout();
  const png = dataUrl();
  // Zonder opmaak blijft alles zoals het was.
  assert.strictEqual(layout.wrap('<p>x</p>', null), '<p>x</p>');
  assert.match(layout.logoHtml(null, { defaultSrc: '../shared/logo-white.png', name: 'A & B' }), /<img src="..\/shared\/logo-white.png" alt="A &amp; B">/);
  assert.strictEqual(layout.footerHtml(null, 'KvK 1'), 'KvK 1');

  // Standaardopmaak: alleen de wikkel met het lettertype van de app.
  const standard = layout.wrap('<p>x</p>', DEFAULTS);
  assert.match(standard, /^<div class="doc-layout"/);
  assert.doesNotMatch(standard, /doc-plain|doc-logo-right|doc-no-company/);
  assert.match(standard, /--doc-logo-height:42px/);

  const custom = { ...DEFAULTS, logoMode: 'custom', logo: png, headerStyle: 'plain', logoPosition: 'right', showCompanyInHeader: false,
    headerColor: '#224466', accentColor: '#118844', font: 'serif', footerText: 'Eerste<script>\nTweede\nDerde', footerCompanyInfo: false };
  const wrapped = layout.wrap('<p>x</p>', custom);
  assert.match(wrapped, /class="doc-layout doc-plain doc-logo-right doc-no-company"/);
  assert.match(wrapped, /--doc-primary:#224466/);
  assert.match(wrapped, /--doc-accent:#118844/);
  assert.match(wrapped, /--doc-font:Georgia/);
  assert.ok(wrapped.endsWith('<p>x</p></div>'));
  // Een kleur die geen #rrggbb is komt nooit in de stijl terecht.
  assert.doesNotMatch(layout.wrap('', { ...DEFAULTS, headerColor: 'red;background:url(x)' }), /--doc-primary/);

  assert.ok(layout.logoHtml(custom, { defaultSrc: 'x.png', name: 'Naam' }).includes(png));
  assert.doesNotMatch(layout.logoHtml({ ...custom, logo: 'javascript:alert(1)' }, { defaultSrc: 'x.png', name: 'Naam' }), /<img/, 'een onbekend logo valt terug op de naam als tekst bij een witte kop');
  assert.match(layout.logoHtml({ ...DEFAULTS, logoMode: 'none' }, { defaultSrc: 'x.png', name: 'Naam' }), /<span class="p-name">Naam<\/span>/);
  assert.match(layout.logoHtml({ ...DEFAULTS, headerStyle: 'plain' }, { defaultSrc: 'x.png', name: 'Naam' }), /p-name/, 'het witte logo staat niet op een witte kop');
  assert.match(layout.logoHtml(DEFAULTS, { defaultSrc: 'x.png', name: 'Naam' }), /<img src="x.png"/);

  // Voet: eigen tekst (hoogstens twee regels, veilig gemaakt) en de bedrijfsregel.
  assert.strictEqual(layout.footerHtml(custom, 'KvK 1'), 'Eerste&lt;script&gt;<br>Tweede');
  assert.strictEqual(layout.footerHtml({ ...custom, footerCompanyInfo: true }, 'KvK 1'), 'Eerste&lt;script&gt;<br>Tweede<br>KvK 1');
});

test('de opmaak komt mee met het bedrijfsprofiel en de openbare offerte, per organisatie', async () => {
  const { admin, planner, outsider, base } = await setup();
  assert.deepStrictEqual((await planner.get('/app/api/quote-profile')).body.documentLayout, DEFAULTS);
  await admin.put('/app/api/admin/document-layout', { layout: { ...DEFAULTS, font: 'serif', footerText: 'Onze voet' } });
  const seen = (await planner.get('/app/api/quote-profile')).body;
  assert.strictEqual(seen.documentLayout.font, 'serif');
  assert.strictEqual(seen.documentLayout.footerText, 'Onze voet');
  assert.strictEqual((await outsider.get('/app/api/quote-profile')).body.documentLayout.footerText, '', 'een andere organisatie ziet de opmaak niet');

  // Openbare offerte: de klant ziet het document in dezelfde opmaak.
  const year = new Date().getFullYear();
  const quote = (await admin.post('/app/api/quotes', { data: { title: 'Test', date: `${year}-01-01`, validUntil: `${year + 1}-01-01`, customer: { name: 'Fam. Jansen' },
    lines: [{ id: 'r1', section: 'materiaal', description: 'Sproeier', qty: 1, price: 10, vat: 21 }] } })).body;
  const url = 'https://aquatech.example/pad/openbaar/offerte.html';
  const shared = (await admin.post(`/app/api/quotes/${quote.id}/share`, { url })).body;
  const token = shared.share.url.split('#t=')[1];
  const response = await fetch(`${base}/app/api/public/quote`, { headers: { 'X-Offerte-Token': token } });
  assert.strictEqual((await response.json()).documentLayout.footerText, 'Onze voet');
});
