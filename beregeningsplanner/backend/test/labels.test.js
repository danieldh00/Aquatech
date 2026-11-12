// Etiketten met streepjescode (artikelen/labels.js, shared/barcode.js): EAN-controle, codering van EAN-13, EAN-8 en
// Code 128 (vaste uitkomsten, met een scanner-decoder nagekeken), de EAN per artikel (uniek per omgeving), sjablonen in
// Beheer en de PDF op etiketformaat, met rechten, scheiding tussen organisaties en grenzen.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeLabelTemplates, buildLabelPdf, POINTS_PER_MM } = require('../src/artikelen/labels');
const { FRONTEND_DIR } = require('../src/paths');
const { createLogin, listen } = require('./helpers/http-client');

const Barcode = require(path.join(FRONTEND_DIR, 'shared', 'barcode.js'));
const SECRET = 'e'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, installateur, planner en klant, en een tweede organisatie.
 * @returns {Promise<object>} base, admin, installer, planner, customer, outsider.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'planner1', displayName: 'Planner', role: 'planner', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'klant1', displayName: 'Klant', role: 'klant', password: PW }, { mustChangePassword: false });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW }, { mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  return { base, db, admin: await as('baas'), installer: await as('monteur'), planner: await as('planner1'), customer: await as('klant1'), outsider: await as('vreemd', 'ander') };
}

/**
 * De MediaBox-maten en het aantal pagina's uit een PDF.
 * @param {Buffer} pdf De PDF.
 * @returns {{ pages: number, width: number, height: number }} De maten van de eerste pagina en het aantal pagina's.
 */
function pdfInfo(pdf) {
  const text = pdf.toString('latin1');
  const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text);
  return { pages: Number(/\/Count (\d+)/.exec(text)[1]), width: Number(box[1]), height: Number(box[2]) };
}

test('streepjescodes: controlecijfer, EAN-13, EAN-8 en Code 128 met vaste uitkomsten', () => {
  assert.strictEqual(Barcode.eanCheckDigit('871234567890'), 6);
  assert.strictEqual(Barcode.cleanEan('8712 3456-78906'), '8712345678906');
  assert.strictEqual(Barcode.cleanEan('8712345678907'), null, 'fout controlecijfer');
  assert.strictEqual(Barcode.cleanEan('012345678905'), '0012345678905', 'UPC-A wordt EAN-13');
  assert.strictEqual(Barcode.cleanEan('96385074'), '96385074');
  assert.strictEqual(Barcode.cleanEan('12345'), null);
  assert.strictEqual(Barcode.cleanEan('abc'), null);
  // Uitkomsten nagekeken door ze als afbeelding te laten lezen door een scanner-decoder (zxing).
  const ean13 = Barcode.encodeEan('8712345678906');
  assert.strictEqual(ean13.length, 95);
  assert.strictEqual(ean13, '10101110110110011001001101000010011101011000101010101000010001001001000111010011100101010000101');
  const ean8 = Barcode.encodeEan('96385074');
  assert.strictEqual(ean8.length, 67);
  assert.strictEqual(ean8, '1010001011010111101111010110111010101001110111001010001001011100101');
  assert.deepStrictEqual(Barcode.code128Values('PE-25'), [104, 48, 37, 13, 18, 21, 30, 106]);
  assert.deepStrictEqual(Barcode.code128Values('12345'), [105, 12, 34, 100, 21, 54, 106]);
  assert.deepStrictEqual(Barcode.code128Values('A1234567B'), [104, 33, 99, 12, 34, 56, 100, 23, 34, 69, 106]);
  // Start B (211214), X (waarde 56: 331121), controle (104 + 56 = 160 % 103 = 57: 312113) en stop (2331112).
  assert.strictEqual(Barcode.encodeCode128('X'), '1101001000011100010110111011010001100011101011');
  assert.strictEqual(Barcode.code128Fits('é'), false);
  assert.strictEqual(Barcode.code128Fits('x'.repeat(41)), false);
  // Een artikel: EAN als die geldig is, anders de artikelcode; met voorkeur 'ean' zonder EAN geen code.
  assert.strictEqual(Barcode.forItem({ code: 'PE-25', ean: '8712345678906' }).type, 'ean13');
  assert.strictEqual(Barcode.forItem({ code: 'PE-25', ean: '' }).type, 'code128');
  assert.strictEqual(Barcode.forItem({ code: 'PE-25', ean: '8712345678906' }, 'code128').text, 'PE-25');
  assert.strictEqual(Barcode.forItem({ code: 'PE-25' }, 'ean'), null);
  assert.deepStrictEqual(Barcode.bars('0110111'), [{ start: 1, width: 2 }, { start: 4, width: 3 }]);
});

test('sjablonen: standaard, opschonen en een PDF op etiketformaat', () => {
  const defaults = sanitizeLabelTemplates({});
  assert.deepStrictEqual(defaults.templates.map((template) => template.key), ['zebra-57x32', 'zebra-102x51']);
  assert.strictEqual(defaults.defaultKey, 'zebra-57x32');
  const cleaned = sanitizeLabelTemplates({ templates: [{ name: 'Schap', widthMm: 5, heightMm: 999, barcode: 'qr' }, { name: 'Schap' }], defaultKey: 'bestaat-niet' });
  assert.deepStrictEqual(cleaned.templates.map((template) => [template.key, template.widthMm, template.heightMm, template.barcode]), [['schap', 15, 150, 'auto'], ['schap-2', 57, 32, 'auto']]);
  assert.strictEqual(cleaned.defaultKey, 'schap');
  assert.strictEqual(sanitizeLabelTemplates({ templates: [{ name: 'Eerste' }, { name: 'Nieuw' }], defaultIndex: 1, defaultKey: 'eerste' }).defaultKey, 'nieuw');
  assert.strictEqual(sanitizeLabelTemplates({ templates: Array.from({ length: 20 }, (_, i) => ({ name: `T${i}` })) }).templates.length, 10);

  const template = defaults.templates[0];
  const item = { code: 'SPR-POP-10', name: 'Pop-up sproeier 10 cm met een heel lange omschrijving die afbreekt', ean: '8712345678906', salePrice: 12.5, vatRate: 21 };
  const out = buildLabelPdf(template, [{ item, qty: 3 }, { item: { ...item, ean: null, code: 'PE-25' }, qty: 1 }]);
  assert.strictEqual(out.count, 4);
  const info = pdfInfo(out.pdf);
  assert.strictEqual(info.pages, 4);
  assert.strictEqual(Math.round(info.width / POINTS_PER_MM), 57);
  assert.strictEqual(Math.round(info.height / POINTS_PER_MM), 32);
  // Een code die te lang is voor een smal etiket wordt geweigerd (te smalle strepen zijn niet te scannen).
  const narrow = { ...template, widthMm: 20 };
  const refused = buildLabelPdf(narrow, [{ item: { ...item, ean: null, code: 'ABCDEFGHIJKLMNOPQRST' }, qty: 1 }]);
  assert.match(refused.error, /te lang voor een etiket van 20 mm/);
  assert.match(buildLabelPdf({ ...template, barcode: 'ean' }, [{ item: { ...item, ean: null }, qty: 1 }]).error, /geen geldige EAN/);
});

test('EAN per artikel: opslaan, ongeldig, uniek per omgeving en niet op een hoofdartikel', async () => {
  const { admin, outsider } = await setup();
  const made = await admin.post('/app/api/stock/items', { code: 'SPR-1', name: 'Sproeier', unit: 'st', salePrice: 10, vatRate: 21, ean: '8712 3456 78906' });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.strictEqual(made.body.ean, '8712345678906');
  assert.strictEqual((await admin.get(`/app/api/stock/items/${made.body.id}`)).body.ean, '8712345678906');
  const wrong = await admin.post('/app/api/stock/items', { code: 'SPR-2', name: 'Sproeier 2', unit: 'st', ean: '8712345678907' });
  assert.strictEqual(wrong.status, 400);
  assert.strictEqual(wrong.body.field, 'ean');
  const second = (await admin.post('/app/api/stock/items', { code: 'SPR-2', name: 'Sproeier 2', unit: 'st' })).body;
  const duplicate = await admin.put(`/app/api/stock/items/${second.id}`, { ean: '8712345678906' });
  assert.strictEqual(duplicate.status, 409);
  assert.match(duplicate.body.message, /SPR-1/);
  // Een geweigerde EAN laat de andere wijzigingen ook niet staan (niets half opgeslagen).
  const mixed = await admin.put(`/app/api/stock/items/${second.id}`, { name: 'Nieuwe naam', salePrice: 99, ean: '8712345678906' });
  assert.strictEqual(mixed.status, 409);
  const unchanged = (await admin.get(`/app/api/stock/items/${second.id}`)).body;
  assert.strictEqual(unchanged.name, 'Sproeier 2');
  assert.strictEqual(unchanged.salePrice, null);
  // Een nieuw artikel met een EAN die al bestaat wordt helemaal niet aangemaakt; daarna lukt het zonder EAN met dezelfde code.
  const refused = await admin.post('/app/api/stock/items', { code: 'SPR-3', name: 'Sproeier 3', unit: 'st', ean: '8712345678906' });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.body.field, 'ean');
  assert.strictEqual((await admin.post('/app/api/stock/items', { code: 'SPR-3', name: 'Sproeier 3', unit: 'st' })).status, 201);
  // Een andere organisatie mag dezelfde EAN gebruiken.
  assert.strictEqual((await outsider.post('/app/api/stock/items', { code: 'X-1', name: 'Zelfde', unit: 'st', ean: '8712345678906' })).status, 201);
  // Wissen en een EAN-8.
  assert.strictEqual((await admin.put(`/app/api/stock/items/${made.body.id}`, { ean: '' })).body.ean, null);
  assert.strictEqual((await admin.put(`/app/api/stock/items/${second.id}`, { ean: '96385074' })).body.ean, '96385074');
  // In de lijst staat de EAN ook.
  const listed = (await admin.get('/app/api/stock')).body.items.find((item) => item.id === second.id);
  assert.strictEqual(listed.ean, '96385074');
});

test('etiketten afdrukken: PDF, sjabloon uit Beheer, rechten, andere organisatie en grenzen', async () => {
  const { admin, installer, planner, customer, outsider } = await setup();
  const item = (await admin.post('/app/api/stock/items', { code: 'SPR-1', name: 'Sproeier', unit: 'st', salePrice: 10, vatRate: 21, ean: '8712345678906' })).body;
  const templates = await installer.get('/app/api/stock/label-templates');
  assert.strictEqual(templates.status, 200);
  assert.strictEqual(templates.body.defaultKey, 'zebra-57x32');

  const printed = await installer.post('/app/api/stock/labels', { template: 'zebra-102x51', items: [{ id: item.id, qty: 2 }] });
  assert.strictEqual(printed.status, 200, printed.text.slice(0, 200));
  assert.match(printed.type, /application\/pdf/);
  assert.strictEqual(printed.headers.get('cache-control'), 'no-store');
  assert.strictEqual(printed.raw.subarray(0, 5).toString('latin1'), '%PDF-');
  const info = pdfInfo(printed.raw);
  assert.strictEqual(info.pages, 2);
  assert.strictEqual(Math.round(info.width / POINTS_PER_MM), 102);

  // Eigen sjabloon in Beheer > Instellingen; onbekend sjabloon = het standaardsjabloon.
  const saved = await admin.put('/app/api/admin/settings', { labelTemplates: { templates: [{ name: 'Bak 40 × 20', widthMm: 40, heightMm: 20, showPrice: false }] } });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const own = await installer.post('/app/api/stock/labels', { template: 'onbekend', items: [{ id: item.id, qty: 1 }] });
  assert.strictEqual(Math.round(pdfInfo(own.raw).width / POINTS_PER_MM), 40);
  assert.deepStrictEqual((await installer.get('/app/api/stock/label-templates')).body.templates.map((template) => template.key), ['bak-40-20']);

  // Rechten: zonder recht voorraad (planner, klant) 403; een andere organisatie vindt het artikel niet.
  for (const client of [planner, customer]) {
    assert.strictEqual((await client.post('/app/api/stock/labels', { items: [{ id: item.id, qty: 1 }] })).status, 403);
    assert.strictEqual((await client.get('/app/api/stock/label-templates')).status, 403);
  }
  assert.strictEqual((await outsider.post('/app/api/stock/labels', { items: [{ id: item.id, qty: 1 }] })).status, 404);

  // Grenzen: geen artikelen, te veel etiketten, hoofdartikel met varianten.
  assert.strictEqual((await installer.post('/app/api/stock/labels', { items: [] })).status, 400);
  assert.strictEqual((await installer.post('/app/api/stock/labels', { items: [{ id: item.id, qty: 0 }] })).status, 400);
  const tooMany = await installer.post('/app/api/stock/labels', { items: [{ id: item.id, qty: 501 }] });
  assert.strictEqual(tooMany.body && tooMany.body.error, 'too_many', `${tooMany.status} ${tooMany.text}`);
  const parent = (await admin.post('/app/api/stock/items', { code: 'HOOFD', name: 'Hoofd', unit: 'st' })).body;
  assert.strictEqual((await admin.put(`/app/api/stock/items/${parent.id}/variants`, { attributes: [{ name: 'Maat', values: ['S', 'M'] }] })).status, 200);
  assert.strictEqual((await installer.post('/app/api/stock/labels', { items: [{ id: parent.id, qty: 1 }] })).body.error, 'has_variants');
  assert.strictEqual((await admin.put(`/app/api/stock/items/${parent.id}`, { name: 'Hoofd nieuw', ean: '96385074' })).status, 400);
  assert.strictEqual((await admin.get(`/app/api/stock/items/${parent.id}`)).body.name, 'Hoofd');
});
