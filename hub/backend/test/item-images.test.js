// Afbeeldingen bij artikelen: uploaden, delen, vervangen en verwijderen, tonen in de
// openbare shop, rechten en tenant-isolatie, en het overnemen uit de oude webshop.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createVault } = require('../src/beveiliging/vault');
const { createStore } = require('../src/platform/store');
const { sitePhotoPng } = require('../src/platform/test-data');
const { createLogin, createClient, listen } = require('./helpers/http-client');

const SECRET = 'i'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Een kleine geldige PNG als base64.
 * @param {number} seed Verschillende waarden geven verschillende afbeeldingen.
 * @returns {string} De base64-inhoud.
 */
const pngBase64 = (seed) => sitePhotoPng('voor', seed, 48, 32).toString('base64');

/**
 * Hoofdtenant met beheerder en klant, een tweede organisatie, de shop aan en een nagebootste webshopserver voor afbeeldingen.
 * @returns {Promise<object>} db, main, admin, klant, vreemd, anonymous, downloads (aangevraagde adressen) en responses (adres → antwoord).
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
  const downloads = [];
  const responses = new Map();
  /**
   * Nagebootste webshopserver: geeft het ingestelde antwoord voor een adres (anders 404).
   * @param {string} url Het adres.
   * @returns {Promise<Response>} Het antwoord.
   */
  const imageFetch = async (url) => {
    downloads.push(url);
    const body = responses.get(url);
    return body ? new Response(body, { status: 200, headers: { 'Content-Type': 'image/png' } }) : new Response('niet gevonden', { status: 404 });
  };
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, imageFetch, vault }));
  servers.push(server);
  const login = createLogin(base, { password: PW });
  const admin = await login('baas');
  await admin.put('/app/api/admin/settings', { storefront: true });
  return { db, main, vault, admin, klant: await login('klant'), vreemd: await login('vreemd', 'ander'), anonymous: createClient(base), downloads, responses };
}

/**
 * Maakt een artikel dat naar de shop mag.
 * @param {object} client Ingelogde client.
 * @param {string} code Artikelcode.
 * @returns {Promise<object>} Het artikel.
 */
async function article(client, code) {
  const out = await client.post('/app/api/stock/items', { code, name: `Artikel ${code}`, onHand: 3, salePrice: 10 });
  assert.strictEqual(out.status, 201, JSON.stringify(out.body));
  return out.body;
}

test('artikelafbeelding: uploaden, delen, vervangen en verwijderen', async () => {
  const { admin, db, main, vault } = await setup();
  const first = await article(admin, 'IMG-1');
  const second = await article(admin, 'IMG-2');
  const put = await admin.put(`/app/api/stock/items/${first.id}/image`, { name: 'foto.png', data: pngBase64(1) });
  assert.strictEqual(put.status, 200, JSON.stringify(put.body));
  assert.match(put.body.imageId, /^[0-9a-f-]{36}$/);
  assert.strictEqual((await admin.get(`/app/api/stock/items/${first.id}`)).body.imageId, put.body.imageId);
  const file = await admin.get(`/app/api/stock/images/${put.body.imageId}`);
  assert.strictEqual(file.status, 200);
  assert.match(file.type, /image\/png/);
  assert.ok(file.size > 50);
  const stored = db.prepare('SELECT data FROM item_images WHERE tenant_id = ?').get(main).data;
  assert.match(stored, /^f1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.deepStrictEqual(vault.openBytes(stored, `${main}:artikel-afbeelding:${put.body.imageId}`), Buffer.from(pngBase64(1), 'base64'));

  // Dezelfde afbeelding bij een tweede artikel: één opgeslagen afbeelding.
  const shared = await admin.put(`/app/api/stock/items/${second.id}/image`, { name: 'zelfde.png', data: pngBase64(1) });
  assert.strictEqual(shared.body.imageId, put.body.imageId);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM item_images WHERE tenant_id = ?').get(main).n, 1);

  // Vervangen bij het eerste artikel: de gedeelde afbeelding blijft voor het tweede.
  const replaced = await admin.put(`/app/api/stock/items/${first.id}/image`, { name: 'nieuw.png', data: pngBase64(2) });
  assert.notStrictEqual(replaced.body.imageId, put.body.imageId);
  assert.strictEqual((await admin.get(`/app/api/stock/images/${put.body.imageId}`)).status, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM item_images WHERE tenant_id = ?').get(main).n, 2);

  // Verwijderen: de afbeelding zelf verdwijnt als niemand haar meer gebruikt.
  assert.strictEqual((await admin.del(`/app/api/stock/items/${first.id}/image`)).status, 200);
  assert.strictEqual((await admin.get(`/app/api/stock/items/${first.id}`)).body.imageId, null);
  assert.strictEqual((await admin.get(`/app/api/stock/images/${replaced.body.imageId}`)).status, 404);
  assert.strictEqual((await admin.del(`/app/api/stock/items/${second.id}/image`)).status, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM item_images WHERE tenant_id = ?').get(main).n, 0);
});

test('artikelafbeelding: een echt verwijderd artikel ruimt zijn afbeelding op', async () => {
  const { admin, db, main } = await setup();
  // Zonder voorraadmutaties wordt het artikel echt verwijderd (anders gearchiveerd).
  const created = await admin.post('/app/api/stock/items', { code: 'IMG-DEL', name: 'Artikel IMG-DEL', onHand: 0, salePrice: 10 });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const item = created.body;
  assert.strictEqual((await admin.put(`/app/api/stock/items/${item.id}/image`, { name: 'weg.png', data: pngBase64(7) })).status, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM item_images WHERE tenant_id = ?').get(main).n, 1);
  assert.strictEqual((await admin.del(`/app/api/stock/items/${item.id}`)).status, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM item_images WHERE tenant_id = ?').get(main).n, 0);
});

test('mediabibliotheek: alle afbeeldingen met hun artikelen en de artikelen zonder afbeelding', async () => {
  const { admin, klant, vreemd } = await setup();
  const first = await article(admin, 'LIB-1');
  const second = await article(admin, 'LIB-2');
  const third = await article(admin, 'LIB-3');
  const shared = (await admin.put(`/app/api/stock/items/${first.id}/image`, { name: 'a.png', data: pngBase64(20) })).body.imageId;
  await admin.put(`/app/api/stock/items/${second.id}/image`, { name: 'b.png', data: pngBase64(20) });
  const library = (await admin.get('/app/api/stock/images')).body;
  assert.strictEqual(library.images.length, 1);
  assert.strictEqual(library.images[0].id, shared);
  assert.deepStrictEqual(library.images[0].items.map((item) => item.code), ['LIB-1', 'LIB-2']);
  assert.ok(library.images[0].width > 0 && library.images[0].size > 0);
  assert.ok(!JSON.stringify(library).includes('"data"'), 'geen inhoud in de lijst');
  assert.deepStrictEqual(library.missing.map((item) => item.code), ['LIB-3']);
  assert.strictEqual(library.missing[0].id, third.id);
  assert.strictEqual((await klant.get('/app/api/stock/images')).status, 403);
  assert.deepStrictEqual((await vreemd.get('/app/api/stock/images')).body, { images: [], missing: [] });
});

test('artikelafbeelding: ongeldige bestanden, rechten en andere organisatie', async () => {
  const { admin, klant, vreemd, anonymous } = await setup();
  const item = await article(admin, 'IMG-3');
  const text = await admin.put(`/app/api/stock/items/${item.id}/image`, { name: 'tekst.png', data: Buffer.from('Dit is geen afbeelding, maar tekst.').toString('base64') });
  assert.strictEqual(text.status, 400);
  assert.strictEqual((await admin.put(`/app/api/stock/items/${item.id}/image`, { name: 'leeg.png' })).status, 400);
  assert.strictEqual((await admin.put('/app/api/stock/items/bestaat-niet/image', { name: 'a.png', data: pngBase64(3) })).status, 404);

  const stored = (await admin.put(`/app/api/stock/items/${item.id}/image`, { name: 'a.png', data: pngBase64(3) })).body;
  // Geen recht: klant en anoniem.
  assert.strictEqual((await klant.put(`/app/api/stock/items/${item.id}/image`, { name: 'a.png', data: pngBase64(4) })).status, 403);
  assert.strictEqual((await klant.del(`/app/api/stock/items/${item.id}/image`)).status, 403);
  assert.strictEqual((await klant.get(`/app/api/stock/images/${stored.imageId}`)).status, 403);
  assert.strictEqual((await klant.post('/app/api/stock/images-import', { after: '' })).status, 403);
  assert.strictEqual((await anonymous.get(`/app/api/stock/images/${stored.imageId}`)).status, 401);
  // Andere organisatie: artikel en afbeelding bestaan daar niet.
  assert.strictEqual((await vreemd.put(`/app/api/stock/items/${item.id}/image`, { name: 'a.png', data: pngBase64(5) })).status, 404);
  assert.strictEqual((await vreemd.del(`/app/api/stock/items/${item.id}/image`)).status, 404);
  assert.strictEqual((await vreemd.get(`/app/api/stock/images/${stored.imageId}`)).status, 404);
  assert.strictEqual((await admin.get(`/app/api/stock/items/${item.id}`)).body.imageId, stored.imageId);
});

test('artikelafbeelding: de openbare shop toont de eigen afbeelding', async () => {
  const { admin, anonymous } = await setup();
  const item = await article(admin, 'IMG-4');
  const { imageId } = (await admin.put(`/app/api/stock/items/${item.id}/image`, { name: 'shop.png', data: pngBase64(6) })).body;
  const home = await anonymous.get('/');
  assert.ok(home.text.includes(`src="artikelfoto/${imageId}/klein"`), 'startpagina verwijst naar de miniatuur van de eigen afbeelding');
  const product = await anonymous.get(`/product/${/product\/([^/"]+)\//.exec(home.text)[1]}/`);
  assert.ok(product.text.includes(`src="../../artikelfoto/${imageId}"`), 'productpagina verwijst naar de eigen afbeelding');
  const picture = await anonymous.get(`/artikelfoto/${imageId}`);
  assert.strictEqual(picture.status, 200);
  assert.match(picture.type, /image\/png/);
  assert.match(picture.headers.get('cache-control'), /immutable/);
  // Daarna uit het geheugen; verwijderen in Aquatech haalt hem daar ook weg.
  assert.strictEqual((await anonymous.get(`/artikelfoto/${imageId}`)).status, 200);
  assert.strictEqual((await admin.del(`/app/api/stock/items/${item.id}/image`)).status, 200);
  assert.strictEqual((await anonymous.get(`/artikelfoto/${imageId}`)).status, 404, 'verwijderde afbeelding komt niet meer uit het geheugen');
  assert.strictEqual((await anonymous.get('/artikelfoto/00000000-0000-0000-0000-000000000000')).status, 404);
  assert.strictEqual((await anonymous.get('/artikelfoto/geen-id')).status, 404);
});

test('afbeeldingen uit de webshop overnemen: eenmalig, per portie en herhaalbaar', async () => {
  const { admin, db, main, downloads, responses, klant } = await setup();
  const items = [];
  for (const code of ['OLD-1', 'OLD-2', 'OLD-3', 'OLD-4', 'OLD-5']) items.push(await article(admin, code));
  const imageUrls = ['https://oud.example/a.png', 'https://oud.example/a.png', 'https://oud.example/b.png', 'https://oud.example/kapot.png', ''];
  items.forEach((item, index) => {
    db.prepare('INSERT INTO shop_products (tenant_id, id, sku, name, price, currency, url, image, in_stock, code, categories) VALUES (?, ?, ?, ?, 10, ?, ?, ?, 1, ?, ?)')
      .run(main, `p${index}`, item.code, item.name, 'EUR', '', imageUrls[index], item.code, '[]');
    db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND id = ?').run(`p${index}`, main, item.id);
  });
  responses.set('https://oud.example/a.png', Buffer.from(pngBase64(10), 'base64'));
  responses.set('https://oud.example/b.png', Buffer.from(pngBase64(11), 'base64'));

  assert.deepStrictEqual((await admin.get('/app/api/stock/images-import')).body, { pending: 4 });
  assert.strictEqual((await klant.get('/app/api/stock/images-import')).status, 403);
  const run = await admin.post('/app/api/stock/images-import', { after: '' });
  assert.strictEqual(run.status, 200, JSON.stringify(run.body));
  assert.strictEqual(run.body.processed, 4);
  assert.strictEqual(run.body.imported, 3);
  assert.strictEqual(run.body.stored, 2, 'twee artikelen delen een afbeelding: er worden twee bewaard, geen drie');
  assert.strictEqual(run.body.next, null);
  assert.strictEqual(run.body.failed.length, 1);
  assert.strictEqual(run.body.failed[0].code, 'OLD-4');
  assert.strictEqual(run.body.pending, 1, 'het artikel met een kapot adres blijft over');
  // Elk adres is één keer opgehaald, ook al gebruiken twee artikelen dezelfde afbeelding.
  assert.deepStrictEqual([...downloads].sort(), ['https://oud.example/a.png', 'https://oud.example/b.png', 'https://oud.example/kapot.png']);
  const [one, two, three, four, five] = await Promise.all(items.map(async (item) => (await admin.get(`/app/api/stock/items/${item.id}`)).body.imageId));
  assert.ok(one && one === two, 'gedeelde afbeelding');
  assert.ok(three && three !== one);
  assert.strictEqual(four, null);
  assert.strictEqual(five, null);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM item_images WHERE tenant_id = ?').get(main).n, 2);
  assert.strictEqual(db.prepare('SELECT source_url FROM item_images WHERE tenant_id = ? AND id = ?').get(main, one).source_url, 'https://oud.example/a.png');

  // Opnieuw uitvoeren is veilig: alleen het kapotte adres wordt nog eens geprobeerd.
  downloads.length = 0;
  const again = await admin.post('/app/api/stock/images-import', { after: '' });
  assert.strictEqual(again.body.imported, 0);
  assert.strictEqual(again.body.failed.length, 1);
  assert.deepStrictEqual(downloads, ['https://oud.example/kapot.png']);
  // Zodra het adres het wel doet, lukt het alsnog.
  responses.set('https://oud.example/kapot.png', Buffer.from(pngBase64(12), 'base64'));
  const fixed = await admin.post('/app/api/stock/images-import', { after: '' });
  assert.strictEqual(fixed.body.imported, 1);
  assert.strictEqual(fixed.body.pending, 0);
  assert.strictEqual(fixed.body.failed.length, 0);
});

test('afbeeldingen overnemen: geen http-adressen en geen ongeldige bestanden', async () => {
  const { admin, db, main, downloads, responses } = await setup();
  const item = await article(admin, 'OLD-9');
  db.prepare('INSERT INTO shop_products (tenant_id, id, sku, name, price, currency, url, image, in_stock, code, categories) VALUES (?, ?, ?, ?, 10, ?, ?, ?, 1, ?, ?)').run(main, 'p9', 'OLD-9', 'x', 'EUR', '', 'http://oud.example/a.png', 'OLD-9', '[]');
  db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND id = ?').run('p9', main, item.id);
  // http (zonder s) wordt nooit opgehaald.
  const refused = await admin.post('/app/api/stock/images-import', { after: '' });
  assert.strictEqual(refused.body.failed.length, 1);
  assert.deepStrictEqual(downloads, []);
  // Geen afbeelding maar tekst: geweigerd na het ophalen.
  db.prepare('UPDATE shop_products SET image = ? WHERE tenant_id = ?').run('https://oud.example/tekst.png', main);
  responses.set('https://oud.example/tekst.png', Buffer.from('<html>geen afbeelding</html>'));
  const notImage = await admin.post('/app/api/stock/images-import', { after: '' });
  assert.strictEqual(notImage.body.failed.length, 1);
  assert.strictEqual((await admin.get(`/app/api/stock/items/${item.id}`)).body.imageId, null);
});

test('afbeeldingen overnemen: veel artikelen en verschillende adressen met dezelfde foto geven één afbeelding', async () => {
  const { admin, db, main, responses } = await setup();
  const sameBytes = Buffer.from(pngBase64(20), 'base64');
  const urls = ['https://oud.example/foto.png', 'https://oud.example/foto-1.png', 'https://oud.example/foto-2.png'];
  for (const url of urls) responses.set(url, sameBytes);
  // 30 artikelen (meer dan één portie van 25) verdeeld over drie adressen met identieke inhoud.
  for (let index = 0; index < 30; index += 1) {
    const item = await article(admin, `SAME-${String(index).padStart(2, '0')}`);
    db.prepare('INSERT INTO shop_products (tenant_id, id, sku, name, price, currency, url, image, in_stock, code, categories) VALUES (?, ?, ?, ?, 10, ?, ?, ?, 1, ?, ?)')
      .run(main, `s${index}`, item.code, item.name, 'EUR', '', urls[index % 3], item.code, '[]');
    db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND id = ?').run(`s${index}`, main, item.id);
  }
  let after = '';
  let stored = 0;
  do {
    const part = await admin.post('/app/api/stock/images-import', { after });
    assert.strictEqual(part.status, 200, JSON.stringify(part.body));
    stored += part.body.stored;
    after = part.body.next;
  } while (after);
  assert.strictEqual(stored, 1, 'identieke inhoud wordt één keer bewaard');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM item_images WHERE tenant_id = ?').get(main).n, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(DISTINCT image_id) AS n FROM stock_items WHERE tenant_id = ? AND image_id IS NOT NULL').get(main).n, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stock_items WHERE tenant_id = ? AND image_id IS NOT NULL').get(main).n, 30);
});

/**
 * Een minimale WebP (VP8L-kop, geen echte beelddata) met de opgegeven afmetingen, genoeg voor de controle op inhoud.
 * @param {number} width De breedte.
 * @param {number} height De hoogte.
 * @returns {string} De WebP als base64.
 */
function webpBase64(width, height) {
  const data = Buffer.alloc(20);
  data[0] = 0x2f;
  data.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  const chunk = Buffer.concat([Buffer.from('VP8L'), Buffer.from(Uint32Array.of(data.length).buffer), data]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(chunk.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, chunk]).toString('base64');
}

/**
 * Een kleine JPEG-structuur (SOF0) met de opgegeven afmetingen, genoeg voor de controle op inhoud.
 * @param {number} width De breedte.
 * @param {number} height De hoogte.
 * @returns {string} De JPEG als base64.
 */
function jpegBase64(width, height) {
  /**
   * Eén JPEG-segment: marker, lengte en inhoud.
   * @param {number} marker Segmenttype (na 0xFF).
   * @param {Buffer} body Inhoud.
   * @returns {Buffer} Het segment.
   */
  const segment = (marker, body) => {
    const length = Buffer.alloc(2); length.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), length, body]);
  };
  const sof = Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), segment(0xdb, Buffer.alloc(65, 1)), segment(0xc0, sof),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0x12, 0x34, 0x56, 0xff, 0x00, 0x78]), Buffer.from([0xff, 0xd9]),
  ]).toString('base64');
}

test('miniatuur: opslaan, tonen in de shop met terugval, porties en afkeuren van ongeldige', async () => {
  const { admin, klant, vreemd, anonymous, db, main, vault } = await setup();
  const item = await article(admin, 'IMG-T1');
  const { imageId } = (await admin.put(`/app/api/stock/items/${item.id}/image`, { name: 'groot.png', data: pngBase64(11) })).body;
  // Zonder miniatuur levert /klein de gewone afbeelding.
  const fallback = await anonymous.get(`/artikelfoto/${imageId}/klein`);
  assert.strictEqual(fallback.status, 200);
  assert.match(fallback.type, /image\/png/);
  assert.match(fallback.headers.get('cache-control'), /max-age=300/);
  assert.doesNotMatch(fallback.headers.get('cache-control'), /immutable/, 'de terugval wordt niet een jaar onthouden');
  assert.deepStrictEqual((await admin.get('/app/api/stock/images-thumbs')).body, { pending: 1, ids: [imageId], next: null });
  // Ongeldig: geen WebP, te groot van afmeting, geen afbeelding.
  assert.strictEqual((await admin.put(`/app/api/stock/images/${imageId}/thumb`, { data: pngBase64(12) })).status, 400);
  assert.strictEqual((await admin.put(`/app/api/stock/images/${imageId}/thumb`, { data: webpBase64(900, 600) })).status, 400);
  assert.strictEqual((await admin.put(`/app/api/stock/images/${imageId}/thumb`, { data: 'geen afbeelding' })).status, 400);
  // Rechten en andere organisatie.
  assert.strictEqual((await klant.put(`/app/api/stock/images/${imageId}/thumb`, { data: webpBase64(480, 320) })).status, 403);
  assert.strictEqual((await vreemd.put(`/app/api/stock/images/${imageId}/thumb`, { data: webpBase64(480, 320) })).status, 404);
  assert.strictEqual((await admin.put('/app/api/stock/images/geen-id/thumb', { data: webpBase64(480, 320) })).status, 404);
  // Geldig: versleuteld bewaard, daarna geserveerd als WebP.
  assert.strictEqual((await admin.put(`/app/api/stock/images/${imageId}/thumb`, { data: webpBase64(480, 320) })).status, 200);
  const stored = db.prepare('SELECT thumb FROM item_images WHERE tenant_id = ?').get(main).thumb;
  assert.deepStrictEqual(vault.openBytes(stored, `${main}:artikel-afbeelding-klein:${imageId}`), Buffer.from(webpBase64(480, 320), 'base64'));
  const small = await anonymous.get(`/artikelfoto/${imageId}/klein`);
  assert.match(small.type, /image\/webp/);
  assert.match(small.headers.get('cache-control'), /immutable/);
  assert.match((await anonymous.get(`/artikelfoto/${imageId}`)).type, /image\/png/, 'de gewone afbeelding blijft de grote');
  assert.deepStrictEqual((await admin.get('/app/api/stock/images-thumbs')).body, { pending: 0, ids: [], next: null });
  // Safari maakt een JPEG-miniatuur: ook die wordt geaccepteerd en als JPEG geserveerd.
  assert.strictEqual((await admin.put(`/app/api/stock/images/${imageId}/thumb`, { data: jpegBase64(480, 320) })).status, 200);
  assert.match((await anonymous.get(`/artikelfoto/${imageId}/klein`)).type, /image\/jpeg/);
  assert.strictEqual((await admin.put(`/app/api/stock/images/${imageId}/thumb`, { data: jpegBase64(900, 600) })).status, 400);
  assert.strictEqual((await anonymous.get('/artikelfoto/geen-id/klein')).status, 404);
  // Nieuwe upload met miniatuur meteen erbij; een ongeldige miniatuur laat de upload wel slagen.
  const second = await article(admin, 'IMG-T2');
  const withThumb = await admin.put(`/app/api/stock/items/${second.id}/image`, { name: 'b.png', data: pngBase64(13), thumb: webpBase64(300, 200) });
  assert.strictEqual(withThumb.status, 200);
  assert.match((await anonymous.get(`/artikelfoto/${withThumb.body.imageId}/klein`)).type, /image\/webp/);
  const third = await article(admin, 'IMG-T3');
  const badThumb = await admin.put(`/app/api/stock/items/${third.id}/image`, { name: 'c.png', data: pngBase64(14), thumb: 'rommel' });
  assert.strictEqual(badThumb.status, 200);
  assert.match((await anonymous.get(`/artikelfoto/${badThumb.body.imageId}/klein`)).type, /image\/png/);
});

test('afbeeldingen overnemen: AVIF van de oude webshop wordt gemeld als omzetten in de browser en de bytes zijn op te halen', async () => {
  const { admin, klant, vreemd, db, main, responses } = await setup();
  const item = await article(admin, 'AVIF-1');
  const loose = await article(admin, 'AVIF-2');
  const url = 'https://oud.example/honda.avif';
  db.prepare('INSERT INTO shop_products (tenant_id, id, sku, name, price, currency, url, image, in_stock, code, categories) VALUES (?, ?, ?, ?, 10, ?, ?, ?, 1, ?, ?)').run(main, 'pa', 'AVIF-1', 'x', 'EUR', '', url, 'AVIF-1', '[]');
  db.prepare('UPDATE stock_items SET shop_product_id = ? WHERE tenant_id = ? AND id = ?').run('pa', main, item.id);
  // Een AVIF-bestand: ftyp-vak met het merk avif (de server kan de inhoud niet decoderen).
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypavif'), Buffer.alloc(40)]);
  responses.set(url, avif);
  const run = await admin.post('/app/api/stock/images-import', { after: '' });
  assert.strictEqual(run.status, 200);
  assert.strictEqual(run.body.failed.length, 1);
  assert.strictEqual(run.body.failed[0].convert, true);
  assert.strictEqual(run.body.failed[0].itemId, item.id);
  assert.match(run.body.failed[0].reason, /AVIF/);
  // Een kapot adres blijft een gewone fout zonder omzetten.
  responses.set(url, Buffer.from('<html>geen afbeelding</html>'));
  assert.strictEqual((await admin.post('/app/api/stock/images-import', { after: '' })).body.failed[0].convert, false);
  responses.set(url, avif);
  // De browser haalt de bytes op via het artikel (nooit via een adres uit het verzoek).
  const bytes = await admin.get(`/app/api/stock/items/${item.id}/shop-image`);
  assert.strictEqual(bytes.status, 200);
  assert.match(bytes.type, /octet-stream/);
  assert.strictEqual(bytes.size, avif.length);
  assert.strictEqual((await admin.get(`/app/api/stock/items/${loose.id}/shop-image`)).status, 404, 'artikel zonder webshopproduct');
  assert.strictEqual((await admin.get('/app/api/stock/items/geen-id/shop-image')).status, 404);
  assert.strictEqual((await klant.get(`/app/api/stock/items/${item.id}/shop-image`)).status, 403);
  assert.strictEqual((await vreemd.get(`/app/api/stock/items/${item.id}/shop-image`)).status, 404, 'andere organisatie');
  // Na het omzetten door de browser (JPEG/PNG uploaden) is het artikel niet meer in afwachting.
  assert.strictEqual((await admin.put(`/app/api/stock/items/${item.id}/image`, { name: 'AVIF-1.png', data: pngBase64(21) })).status, 200);
  assert.deepStrictEqual((await admin.get('/app/api/stock/images-import')).body, { pending: 0 });
});
