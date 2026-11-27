// PDF's bij artikelen: uploaden (controle op inhoud), dubbele PDF, grenzen, tonen op de productpagina aan/uit,
// verwijderen, versleutelde opslag, rechten en tenant-isolatie.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createVault } = require('../src/beveiliging/vault');
const { createStore } = require('../src/platform/store');
const { createLogin, createClient, listen } = require('./helpers/http-client');

const SECRET = 'd'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Maakt een PDF met een aantal pagina's.
 * @param {number} pageCount Het aantal pagina's.
 * @param {string} title Tekst op de eerste pagina (verschillende titels geven verschillende bestanden).
 * @returns {Promise<Buffer>} De PDF.
 */
async function makePdf(pageCount, title = 'Productinformatie') {
  const doc = await PDFDocument.create();
  for (let page = 0; page < pageCount; page++) doc.addPage([595, 842]).drawText(`${title} ${page}`, { x: 50, y: 700, size: 12 });
  return Buffer.from(await doc.save());
}

/**
 * Hoofdtenant met beheerder en klant en een tweede organisatie.
 * @returns {Promise<object>} db, main, vault, base, admin, klant, vreemd en anonymous.
 */
async function setup() {
  const db = openDb();
  const vault = createVault();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, vault }));
  servers.push(server);
  const login = createLogin(base, { password: PW });
  return { db, main, vault, base, admin: await login('baas'), klant: await login('klant'), vreemd: await login('vreemd', 'ander'), anonymous: createClient(base) };
}

/**
 * Uploadt een PDF zoals de browser: de bytes als body met type application/pdf.
 * @param {object} world De testwereld (base).
 * @param {object} client De ingelogde client (cookies).
 * @param {string} itemId Het artikel.
 * @param {Buffer} body De bytes.
 * @param {{ type?: string, name?: string }} [options] Het type en de bestandsnaam.
 * @returns {Promise<{ status: number, body: object }>} Het antwoord.
 */
async function upload(world, client, itemId, body, { type = 'application/pdf', name = 'Datasheet.pdf' } = {}) {
  const cookie = [...client.jar].map(([key, value]) => `${key}=${value}`).join('; ');
  const response = await fetch(`${world.base}/app/api/stock/items/${itemId}/documents`, { method: 'POST', headers: { 'content-type': type, 'x-bestandsnaam': encodeURIComponent(name), cookie }, body });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/**
 * Maakt een artikel.
 * @param {object} client Ingelogde client.
 * @param {string} code Artikelcode.
 * @returns {Promise<object>} Het artikel.
 */
async function article(client, code) {
  const out = await client.post('/app/api/stock/items', { code, name: `Artikel ${code}`, onHand: 0, salePrice: 10 });
  assert.strictEqual(out.status, 201, JSON.stringify(out.body));
  return out.body;
}

test('artikel-pdf: uploaden, lijst, downloaden, tonen aan/uit en verwijderen', async () => {
  const world = await setup();
  const { admin, db, main, vault } = world;
  const item = await article(admin, 'DOC-1');
  const pdf = await makePdf(3);
  const added = await upload(world, admin, item.id, pdf, { name: 'C:\\map\\Datasheet MP Rotator.pdf' });
  assert.strictEqual(added.status, 201, JSON.stringify(added.body));
  assert.strictEqual(added.body.name, 'Datasheet MP Rotator.pdf');
  assert.strictEqual(added.body.pages, 3);
  assert.strictEqual(added.body.public, true);

  const list = await admin.get(`/app/api/stock/items/${item.id}/documents`);
  assert.deepStrictEqual(list.body.documents.map((document) => document.id), [added.body.id]);

  const stored = db.prepare('SELECT data FROM item_documents WHERE tenant_id = ?').get(main).data;
  assert.match(stored, /^f1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.strictEqual(vault.openBytes(stored, `${main}:artikel-pdf:${added.body.id}`).subarray(0, 5).toString('latin1'), '%PDF-');

  const file = await admin.get(`/app/api/stock/documents/${added.body.id}`);
  assert.strictEqual(file.status, 200);
  assert.match(file.type, /application\/pdf/);
  assert.match(file.headers.get('content-disposition'), /attachment; filename="Datasheet MP Rotator\.pdf"/);
  assert.strictEqual((await PDFDocument.load(file.raw)).getPageCount(), 3);

  assert.strictEqual((await admin.patch(`/app/api/stock/documents/${added.body.id}`, { public: false })).status, 200);
  assert.strictEqual((await admin.get(`/app/api/stock/items/${item.id}/documents`)).body.documents[0].public, false);
  assert.strictEqual((await admin.patch(`/app/api/stock/documents/${added.body.id}`, { public: 'ja' })).status, 400);

  assert.strictEqual((await admin.del(`/app/api/stock/documents/${added.body.id}`)).status, 200);
  assert.strictEqual((await admin.get(`/app/api/stock/documents/${added.body.id}`)).status, 404);
  assert.strictEqual((await admin.del(`/app/api/stock/documents/${added.body.id}`)).status, 404);
});

test('artikel-pdf: alleen echte PDF\'s, geen dubbele, grenzen per PDF en per artikel', async () => {
  const world = await setup();
  const { admin } = world;
  const item = await article(admin, 'DOC-2');
  const pdf = await makePdf(1, 'een');
  assert.strictEqual((await upload(world, admin, item.id, pdf, { type: 'text/plain' })).status, 415, 'alleen application/pdf');
  assert.strictEqual((await upload(world, admin, item.id, Buffer.from('dit is geen pdf maar gewoon tekst, ruim langer dan vierenzestig tekens om de lengtecontrole te halen'))).status, 400);
  assert.strictEqual((await upload(world, admin, item.id, await makePdf(41))).status, 400, 'te veel pagina\'s');
  assert.strictEqual((await upload(world, admin, item.id, pdf)).status, 201);
  const duplicate = await upload(world, admin, item.id, pdf);
  assert.strictEqual(duplicate.status, 409);
  assert.strictEqual(duplicate.body.error, 'duplicate');
  for (let index = 2; index <= 5; index++) assert.strictEqual((await upload(world, admin, item.id, await makePdf(1, `pdf ${index}`))).status, 201);
  const tooMany = await upload(world, admin, item.id, await makePdf(1, 'zesde'));
  assert.strictEqual(tooMany.status, 409);
  assert.strictEqual(tooMany.body.error, 'too_many');
  assert.strictEqual((await upload(world, admin, '00000000-0000-4000-8000-000000000000', pdf)).status, 404);
});

test('artikel-pdf: gelijktijdige uploads geven geen 500 en blijven binnen het maximum', async () => {
  const world = await setup();
  const { admin, db, main } = world;
  const item = await article(admin, 'DOC-4');
  const same = await makePdf(1, 'zelfde');
  const twins = await Promise.all([upload(world, admin, item.id, same), upload(world, admin, item.id, same)]);
  assert.deepStrictEqual(twins.map((out) => out.status).sort(), [201, 409]);
  const many = [];
  for (let index = 0; index < 6; index++) many.push(await makePdf(1, `parallel ${index}`));
  const outcomes = (await Promise.all(many.map((pdf) => upload(world, admin, item.id, pdf)))).map((out) => out.status);
  assert.ok(outcomes.every((status) => [201, 409, 429].includes(status)), outcomes.join(','));
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM item_documents WHERE tenant_id = ? AND item_id = ?').get(main, item.id).n <= 5);
});

test('artikel-pdf: rechten, andere organisatie en opruimen bij verwijderen van het artikel', async () => {
  const world = await setup();
  const { admin, klant, vreemd, anonymous, db, main } = world;
  const item = await article(admin, 'DOC-3');
  const added = await upload(world, admin, item.id, await makePdf(2));
  assert.strictEqual(added.status, 201);

  assert.strictEqual((await klant.get(`/app/api/stock/items/${item.id}/documents`)).status, 403);
  assert.strictEqual((await klant.get(`/app/api/stock/documents/${added.body.id}`)).status, 403);
  assert.strictEqual((await upload(world, klant, item.id, await makePdf(1, 'klant'))).status, 403);
  assert.strictEqual((await klant.del(`/app/api/stock/documents/${added.body.id}`)).status, 403);
  assert.ok([401, 403].includes((await anonymous.get(`/app/api/stock/documents/${added.body.id}`)).status));

  assert.strictEqual((await vreemd.get(`/app/api/stock/documents/${added.body.id}`)).status, 404);
  assert.strictEqual((await vreemd.patch(`/app/api/stock/documents/${added.body.id}`, { public: false })).status, 404);
  assert.strictEqual((await vreemd.del(`/app/api/stock/documents/${added.body.id}`)).status, 404);
  assert.strictEqual((await upload(world, vreemd, item.id, await makePdf(1, 'vreemd'))).status, 404);
  assert.strictEqual((await vreemd.get(`/app/api/stock/items/${item.id}/documents`)).body.documents.length, 0);

  assert.strictEqual((await admin.del(`/app/api/stock/items/${item.id}`)).status, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM item_documents WHERE tenant_id = ?').get(main).n, 0);
});

test('artikel-pdf: de openbare shop toont alleen openbare PDF\'s van niet-gearchiveerde artikelen als download', async () => {
  const world = await setup();
  const { admin, anonymous } = world;
  const created = await admin.post('/app/api/stock/items', { code: 'SHOP-1', name: 'Artikel SHOP-1', onHand: 3, salePrice: 10 });
  const item = created.body;
  // Pas daarna de shop aanzetten: de catalogus wordt bij het eerste bezoek opgebouwd.
  await admin.put('/app/api/admin/settings', { storefront: true });
  const pdf = await upload(world, admin, item.id, await makePdf(2, 'Shop'), { name: 'Technische fiche.pdf' });
  assert.strictEqual(pdf.status, 201, JSON.stringify(pdf.body));
  const hidden = await upload(world, admin, item.id, await makePdf(1, 'Intern'), { name: 'Intern.pdf' });
  assert.strictEqual((await admin.patch(`/app/api/stock/documents/${hidden.body.id}`, { public: false })).status, 200);

  const home = await anonymous.get('/');
  const category = await anonymous.get(`/${/href="(categorie\/[^"]+)"/.exec(home.text)[1]}`);
  const slug = /product\/([^/"]+)\//.exec(category.text)[1];
  const page = await anonymous.get(`/product/${slug}/`);
  assert.ok(page.text.includes('<h2>Downloads</h2>'), 'het blok Downloads staat op de productpagina');
  assert.ok(page.text.includes(`href="../../artikel-pdf/${pdf.body.id}/Technische%20fiche.pdf"`), 'de openbare PDF heeft een link');
  assert.ok(!page.text.includes(hidden.body.id), 'een niet-openbare PDF komt niet op de pagina');

  const download = await anonymous.get(`/artikel-pdf/${pdf.body.id}/Technische%20fiche.pdf`);
  assert.strictEqual(download.status, 200);
  assert.match(download.type, /application\/pdf/);
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.strictEqual(download.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anonymous.get(`/artikel-pdf/${hidden.body.id}/Intern.pdf`)).status, 404, 'niet openbaar = niet te downloaden');
  assert.strictEqual((await anonymous.get('/artikel-pdf/geen-id/x.pdf')).status, 404);
  assert.strictEqual((await anonymous.get('/artikel-pdf/00000000-0000-0000-0000-000000000000/x.pdf')).status, 404);

  // Gearchiveerd: ook de download is dicht, ook als de PDF openbaar staat.
  assert.strictEqual((await admin.put(`/app/api/stock/items/${item.id}`, { archived: true })).status, 200);
  assert.strictEqual((await anonymous.get(`/artikel-pdf/${pdf.body.id}/Technische%20fiche.pdf`)).status, 404);
});
