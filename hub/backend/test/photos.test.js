// Foto's bij werkorders (versleuteld opgeslagen, EXIF eruit) en het klantdossier.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createVault } = require('../src/beveiliging/vault');
const { inspectImage, cleanJpeg } = require('../src/uitvoering/photos');
const zlib = require('zlib');
const { sitePhotoPng } = require('../src/platform/test-data');
const { createClient, createLogin, listen } = require('./helpers/http-client');

/**
 * Kleine JPEG-structuur: JFIF, EXIF met GPS-gegevens, frame (SOF0 640x480), scan.
 * @param {{ exif?: boolean }} [options] exif: met EXIF-blok (standaard aan).
 * @returns {Buffer} De JPEG.
 */
function fakeJpeg({ exif = true } = {}) {
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
  const sof = Buffer.from([8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    ...(exif ? [segment(0xe1, Buffer.from('Exif\0\0GPSLatitude 52.37 Nunspeet', 'latin1'))] : []),
    segment(0xdb, Buffer.alloc(65, 1)),
    segment(0xc0, sof),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0x00, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

test('afbeelding herkennen: formaat en afmetingen uit de inhoud, EXIF/GPS uit JPEG', () => {
  const j = fakeJpeg();
  const out = cleanJpeg(j);
  assert.strictEqual(out.mime, 'image/jpeg');
  assert.deepStrictEqual([out.width, out.height], [640, 480]);
  assert.ok(j.includes('GPSLatitude'));
  assert.ok(!out.body.includes('GPSLatitude'), 'EXIF met GPS is weg');
  assert.ok(out.body.includes('JFIF'), 'JFIF blijft');
  assert.deepStrictEqual(cleanJpeg(out.body).body, out.body, 'nogmaals schoonmaken verandert niets');

  const png = inspectImage(sitePhotoPng('voor', 1, 120, 80));
  assert.deepStrictEqual([png.mime, png.width, png.height], ['image/png', 120, 80]);
  assert.strictEqual(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null, 'geen SVG (scripts)');
  assert.strictEqual(inspectImage(Buffer.from('GIF89a................')), null);
  assert.strictEqual(inspectImage(j.subarray(0, 40)), null, 'afgekapte JPEG');
});

/**
 * Eén PNG-blok: lengte, type, inhoud en CRC (de CRC wordt hier niet gecontroleerd).
 * @param {string} type Type van het blok (4 tekens).
 * @param {Buffer} body Inhoud.
 * @returns {Buffer} Het blok.
 */
function pngChunk(type, body) {
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]);
}

/**
 * Eén WebP-blok (RIFF): type, lengte, inhoud en opvulbyte bij een oneven lengte.
 * @param {string} type Type van het blok (4 tekens).
 * @param {Buffer} body Inhoud.
 * @returns {Buffer} Het blok.
 */
function webpChunk(type, body) {
  const length = Buffer.alloc(4); length.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from(type, 'latin1'), length, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

test('afbeelding herkennen: tekst, tijd en EXIF gaan ook uit PNG en WebP', () => {
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(3, 4); header[8] = 8; header[9] = 2;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const imageData = pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(3 * 7)));
  const png = Buffer.concat([signature, pngChunk('IHDR', header), pngChunk('tEXt', Buffer.from('Author\0Jan Jansen', 'latin1')),
    pngChunk('eXIf', Buffer.from('GPSLatitude 52.37', 'latin1')), pngChunk('tIME', Buffer.alloc(7)), imageData, pngChunk('IEND', Buffer.alloc(0))]);
  const cleanPng = inspectImage(png);
  assert.deepStrictEqual([cleanPng.mime, cleanPng.width, cleanPng.height], ['image/png', 2, 3]);
  assert.ok(!cleanPng.body.includes('GPSLatitude') && !cleanPng.body.includes('Jan Jansen'), 'tekst en EXIF zijn weg');
  assert.ok(cleanPng.body.includes(imageData), 'beelddata blijft');
  assert.deepStrictEqual(cleanPng.body, Buffer.concat([signature, pngChunk('IHDR', header), imageData, pngChunk('IEND', Buffer.alloc(0))]));
  const plain = sitePhotoPng('voor', 1, 120, 80);
  assert.deepStrictEqual(inspectImage(plain).body, plain, 'zonder metadata: hetzelfde bestand');
  const trailer = Buffer.from('GPSLatitude 52.37', 'latin1');
  assert.deepStrictEqual(inspectImage(Buffer.concat([plain, trailer])).body, plain, 'bytes na IEND gaan eruit (zonder metadata)');
  assert.deepStrictEqual(inspectImage(Buffer.concat([png, trailer])).body, cleanPng.body, 'bytes na IEND gaan eruit (met metadata)');
  assert.strictEqual(inspectImage(png.subarray(0, png.length - 20)), null, 'afgekapte PNG wordt geweigerd');
  assert.strictEqual(inspectImage(png.subarray(0, png.length - 12)), null, 'PNG zonder IEND wordt geweigerd');

  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x04 | 0x10; vp8x.writeUIntLE(99, 4, 3); vp8x.writeUIntLE(49, 7, 3);
  const bitstream = webpChunk('VP8L', Buffer.from([0x2f, 1, 2, 3, 4]));
  const chunks = Buffer.concat([webpChunk('VP8X', vp8x), bitstream, webpChunk('EXIF', Buffer.from('GPSLatitude 52.37', 'latin1')), webpChunk('XMP ', Buffer.from('<x:xmpmeta/>', 'latin1'))]);
  const size = Buffer.alloc(4); size.writeUInt32LE(chunks.length + 4);
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), size, Buffer.from('WEBP', 'latin1'), chunks]);
  const cleanWebp = inspectImage(webp);
  assert.deepStrictEqual([cleanWebp.mime, cleanWebp.width, cleanWebp.height], ['image/webp', 100, 50]);
  assert.ok(!cleanWebp.body.includes('GPSLatitude') && !cleanWebp.body.includes('xmpmeta'), 'EXIF en XMP zijn weg');
  assert.strictEqual(cleanWebp.body[20], 0x10, 'vlaggen voor EXIF en XMP uit, alfa blijft');
  assert.strictEqual(cleanWebp.body.readUInt32LE(4), cleanWebp.body.length - 8, 'RIFF-lengte klopt');
  assert.ok(cleanWebp.body.includes(bitstream), 'beelddata blijft');
  assert.deepStrictEqual(inspectImage(cleanWebp.body).body, cleanWebp.body, 'nogmaals schoonmaken verandert niets');
  assert.strictEqual(inspectImage(webp.subarray(0, webp.length - 4)), null, 'RIFF-lengte groter dan het bestand: geweigerd');
  const overlong = Buffer.from(webp);
  overlong.writeUInt32LE(9999, 12 + 18 + 4);
  assert.strictEqual(inspectImage(overlong), null, 'blok buiten het bestand: geweigerd');
  /**
   * Een WebP met deze blokken achter elkaar en een kloppende RIFF-lengte.
   * @param {Buffer} body De blokken.
   * @returns {Buffer} Het bestand.
   */
  const riff = (body) => { const length = Buffer.alloc(4); length.writeUInt32LE(body.length + 4); return Buffer.concat([Buffer.from('RIFF', 'latin1'), length, Buffer.from('WEBP', 'latin1'), body]); };
  const plainWebp = riff(Buffer.concat([webpChunk('VP8X', vp8x), bitstream]));
  assert.deepStrictEqual(inspectImage(plainWebp).body, plainWebp, 'zonder metadata: hetzelfde bestand');
  assert.deepStrictEqual(inspectImage(Buffer.concat([plainWebp, trailer])).body, plainWebp, 'bytes na de RIFF-grens gaan eruit (zonder metadata)');
  assert.deepStrictEqual(inspectImage(Buffer.concat([webp, trailer])).body, cleanWebp.body, 'bytes na de RIFF-grens gaan eruit (met metadata)');
  assert.strictEqual(inspectImage(riff(Buffer.concat([webpChunk('VP8X', vp8x), bitstream, Buffer.from('EXI', 'latin1')]))), null, 'halve blokkop aan het eind: geweigerd');
  const unpadded = Buffer.concat([webpChunk('VP8X', vp8x), bitstream]);
  assert.strictEqual(inspectImage(riff(unpadded.subarray(0, unpadded.length - 1))), null, 'ontbrekende opvulbyte bij oneven lengte: geweigerd');
});

test('vault: bestanden versleuteld met de context als AAD', () => {
  const vault = createVault();
  const buf = Buffer.from([0, 1, 2, 250, 255]);
  const sealed = vault.sealBytes(buf, 't1:foto:a:beeld');
  assert.match(sealed, /^f1:/);
  assert.deepStrictEqual(vault.openBytes(sealed, 't1:foto:a:beeld'), buf);
  assert.throws(() => vault.openBytes(sealed, 't2:foto:a:beeld'), 'andere tenant: niet te openen');
  assert.throws(() => createVault().openBytes(sealed, 't1:foto:a:beeld'), 'andere sleutel: niet te openen');
});

// ---------- API ----------
const SECRET = 'z'.repeat(64);

/**
 * Tenant met beheerder, installateur en twee klanten, plus een testserver.
 * @returns {Promise<object>} db, server, base en as (inloggen).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  const pw = 'Tuin-Plan-2026!';
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: pw });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: pw });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: pw });
  await store.createAccount(tid, { username: 'piet', displayName: 'Piet', role: 'klant', password: pw });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db }));
  const as = createLogin(base, { password: pw });
  return { db, server, base, as };
}

const lines = [{ id: 'a', section: 'materiaal', description: 'Sproeier', qty: 4, unit: 'st', price: 10 }, { id: 'b', section: 'arbeid', description: 'Sproeiers plaatsen', qty: 2, unit: 'uur', price: 50 }];

test('API: foto\'s bij een werkorder, klant ziet alleen zichtbare foto\'s van zijn eigen werkorder, dossier per klant', async () => {
  const { db, server, base, as } = await setup();
  try {
    const kees = await as('kees'), baas = await as('baas'), klaas = await as('klaas'), piet = await as('piet');
    const klaasId = (await klaas.get('/app/api/me')).body.user.id;
    const quote = (await kees.post('/app/api/quotes', { data: { title: 'Aanleg beregening', customer: { name: 'Fam. Klaassen', address: 'Tuinstraat 1\n8071 AB Nunspeet' }, lines } })).body;
    await kees.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord', customerId: klaasId });
    const wo = (await kees.post('/app/api/workorders', { quoteId: quote.id })).body;
    // Tweede klant zonder account (dossier op naam).
    const q2 = (await kees.post('/app/api/quotes', { data: { title: 'Druppelslang border', customer: { name: 'Bakker' }, lines } })).body;
    await kees.put(`/app/api/quotes/${q2.id}`, { status: 'akkoord' });
    const wo2 = (await kees.post('/app/api/workorders', { quoteId: q2.id })).body;

    const jpeg = fakeJpeg();
    const thumb = sitePhotoPng('oplevering', 2, 60, 40);
    assert.strictEqual((await klaas.post(`/app/api/workorders/${wo.id}/photos`, { image: jpeg.toString('base64') })).status, 403, 'klant uploadt niet');
    const up = await kees.post(`/app/api/workorders/${wo.id}/photos`, { image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, thumb: thumb.toString('base64'),
      kind: 'oplevering', caption: 'Gazon klaar', takenAt: '2026-05-01T10:00:00Z' });
    assert.strictEqual(up.status, 201);
    assert.deepStrictEqual([up.body.kind, up.body.caption, up.body.width, up.body.height, up.body.customerVisible, up.body.uploadedBy.displayName],
      ['oplevering', 'Gazon klaar', 640, 480, true, 'Kees']);
    assert.strictEqual(up.body.size, cleanJpeg(jpeg).body.length);
    const hidden = (await kees.post(`/app/api/workorders/${wo.id}/photos`, { image: sitePhotoPng('tijdens', 1).toString('base64'), kind: 'tijdens', customerVisible: false })).body;
    assert.strictEqual(hidden.mime, 'image/png');

    // Ongeldige invoer.
    assert.strictEqual((await kees.post(`/app/api/workorders/${wo.id}/photos`, { image: Buffer.from('<svg/>').toString('base64') })).status, 400);
    assert.strictEqual((await kees.post(`/app/api/workorders/${wo.id}/photos`, { image: 'niet base64!' })).status, 400);
    assert.strictEqual((await kees.post(`/app/api/workorders/${wo.id}/photos`, { image: jpeg.toString('base64'), thumb: Buffer.from('x'.repeat(40)).toString('base64') })).status, 400);
    assert.strictEqual((await kees.post(`/app/api/workorders/${wo.id}/photos`, { image: jpeg.toString('base64'), thumb: sitePhotoPng('te breed', 1, 1100, 40).toString('base64') })).status, 400, 'miniatuur te groot');
    assert.strictEqual((await kees.post('/app/api/workorders/bestaat-niet/photos', { image: jpeg.toString('base64') })).status, 404);

    // Versleuteld in de database: geen JPEG/PNG-bytes in de rij.
    const row = db.prepare('SELECT image, thumb FROM work_order_photos WHERE id = ?').get(up.body.id);
    assert.match(row.image, /^f1:/);
    assert.match(row.thumb, /^f1:/);

    // Ophalen door de ploeg: zonder EXIF, en de miniatuur.
    const img = await kees.get(`/app/api/workorders/${wo.id}/photos/${up.body.id}`);
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.type, 'image/jpeg');
    assert.ok(!img.raw.includes('GPSLatitude'));
    assert.deepStrictEqual(img.raw, cleanJpeg(jpeg).body);
    const th = await kees.get(`/app/api/workorders/${wo.id}/photos/${up.body.id}?thumb=1`);
    assert.strictEqual(th.type, 'image/png');
    assert.deepStrictEqual(th.raw, thumb);
    assert.strictEqual((await kees.get(`/app/api/workorders/${wo2.id}/photos/${up.body.id}`)).status, 404, 'foto hoort bij een andere werkorder');

    const list = (await kees.get(`/app/api/workorders/${wo.id}/photos`)).body;
    assert.deepStrictEqual(list.items.map((photo) => photo.id), [up.body.id, hidden.id]);
    assert.strictEqual(list.items[0].url, `api/workorders/${wo.id}/photos/${up.body.id}`);

    // Klantportaal: alleen zichtbare foto's van de eigen werkorder.
    assert.strictEqual((await klaas.get(`/app/api/portal/photos/${up.body.id}`)).status, 200);
    assert.strictEqual((await klaas.get(`/app/api/portal/photos/${up.body.id}?thumb=1`)).type, 'image/png');
    assert.strictEqual((await klaas.get(`/app/api/portal/photos/${hidden.id}`)).status, 404, 'niet zichtbaar gezet');
    assert.strictEqual((await piet.get(`/app/api/portal/photos/${up.body.id}`)).status, 404, 'andere klant');
    assert.strictEqual((await createClient(base).get(`/app/api/portal/photos/${up.body.id}`)).status, 401);
    assert.strictEqual((await baas.get(`/app/api/portal/photos/${hidden.id}`)).status, 200, 'medewerker ziet alles');
    // Offerte terug naar concept of verwijderd: dan ook geen losse foto's meer (zelfde regel als het dossier).
    db.prepare("UPDATE quotes SET status = 'concept' WHERE id = ?").run(quote.id);
    assert.strictEqual((await klaas.get(`/app/api/portal/photos/${up.body.id}`)).status, 404, 'offerte is concept');
    db.prepare("UPDATE quotes SET status = 'akkoord', deleted_at = ? WHERE id = ?").run(new Date().toISOString(), quote.id);
    assert.strictEqual((await klaas.get(`/app/api/portal/photos/${up.body.id}`)).status, 404, 'offerte is verwijderd');
    db.prepare('UPDATE quotes SET deleted_at = NULL WHERE id = ?').run(quote.id);
    assert.strictEqual((await klaas.get(`/app/api/portal/photos/${up.body.id}`)).status, 200);
    assert.strictEqual((await klaas.get(`/app/api/workorders/${wo.id}/photos`)).status, 403);
    // Het opleverdossier in het portaal toont alleen de zichtbare foto's, met de portaal-URL.
    const pw = (await klaas.get(`/app/api/portal/workorders/${wo.id}`)).body;
    assert.deepStrictEqual(pw.photos.map((photo) => [photo.id, photo.url]), [[up.body.id, `api/portal/photos/${up.body.id}`]]);
    assert.ok(!('uploadedBy' in pw.photos[0]), 'geen medewerkersnaam naar de klant');

    // Wijzigen: zichtbaar zetten, bijschrift, soort.
    const ch = await kees.patch(`/app/api/workorders/${wo.id}/photos/${hidden.id}`, { customerVisible: true, caption: 'Leidingwerk', kind: 'onzin' });
    assert.deepStrictEqual([ch.body.customerVisible, ch.body.caption, ch.body.kind], [true, 'Leidingwerk', 'tijdens']);
    assert.strictEqual((await klaas.get(`/app/api/portal/photos/${hidden.id}`)).status, 200);

    // Dossiers: één per klant (account of naam).
    await kees.put(`/app/api/workorders/${wo.id}`, { status: 'gereed', data: { ...wo.data, report: { notes: 'Alles werkt', completedOn: '2026-05-02', signedBy: 'K. Klaassen' } } });
    assert.strictEqual((await klaas.get('/app/api/dossiers')).status, 403);
    const dossiers = (await kees.get('/app/api/dossiers')).body.items;
    assert.strictEqual(dossiers.length, 2);
    const accountDossier = dossiers.find((dossier) => dossier.account);
    assert.deepStrictEqual([accountDossier.key, accountDossier.name, accountDossier.installations, accountDossier.completed, accountDossier.photos, accountDossier.lastCompletedOn], [`a-${klaasId}`, 'Fam. Klaassen', 1, 1, 2, '2026-05-02']);
    const nameDossier = dossiers.find((dossier) => !dossier.account);
    assert.match(nameDossier.key, /^n-[0-9a-f]{16}$/);
    const detail = (await kees.get(`/app/api/dossiers/${encodeURIComponent(accountDossier.key)}`)).body;
    assert.strictEqual(detail.customer.name, 'Fam. Klaassen');
    assert.deepStrictEqual(detail.addresses, ['Tuinstraat 1, 8071 AB Nunspeet']);
    assert.strictEqual(detail.installations[0].report.signedBy, 'K. Klaassen');
    assert.strictEqual(detail.installations[0].photos.length, 2);
    assert.deepStrictEqual(detail.installations[0].materials.map((material) => material.description), ['Sproeier']);
    assert.deepStrictEqual(detail.quotes.map((x) => x.number), [quote.number]);
    assert.strictEqual((await kees.get(`/app/api/dossiers/${nameDossier.key}`)).body.quotes.length, 1);
    assert.strictEqual((await kees.get('/app/api/dossiers/n-0000000000000000')).status, 404);

    // Verwijderen; definitief wissen van de werkorder neemt de foto's mee.
    assert.strictEqual((await kees.del(`/app/api/workorders/${wo.id}/photos/${up.body.id}`)).status, 200);
    assert.strictEqual((await kees.get(`/app/api/workorders/${wo.id}/photos/${up.body.id}`)).status, 404);
    assert.strictEqual((await baas.del(`/app/api/admin/workorders/${wo.id}`)).status, 200);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM work_order_photos').get().n, 0);
    const audit = db.prepare("SELECT action FROM audit WHERE action LIKE 'foto_%'").all().map((row) => row.action);
    assert.ok(audit.includes('foto_toegevoegd') && audit.includes('foto_verwijderd'));
  } finally {
    server.close();
  }
});

test('API: maximaal aantal foto\'s per werkorder en grote foto via de eigen limiet', async () => {
  const { db, server, as } = await setup();
  try {
    const kees = await as('kees');
    const quote = (await kees.post('/app/api/quotes', { data: { title: 'X', customer: { name: 'Y' }, lines } })).body;
    await kees.put(`/app/api/quotes/${quote.id}`, { status: 'akkoord' });
    const wo = (await kees.post('/app/api/workorders', { quoteId: quote.id })).body;
    // ~2 MB: groter dan de 1 MB van de werkorder-API, past binnen de fotolimiet.
    const big = Buffer.concat([fakeJpeg({ exif: false }).subarray(0, -2), Buffer.alloc(2 * 1024 * 1024, 7), Buffer.from([0xff, 0xd9])]);
    assert.strictEqual((await kees.post(`/app/api/workorders/${wo.id}/photos`, { image: big.toString('base64') })).status, 201);
    const tooBig = Buffer.concat([big, Buffer.alloc(3 * 1024 * 1024)]);
    assert.strictEqual((await kees.post(`/app/api/workorders/${wo.id}/photos`, { image: tooBig.toString('base64') })).status, 413);
    const id = db.prepare('SELECT id FROM work_order_photos').get().id;
    const row = db.prepare('SELECT * FROM work_order_photos WHERE id = ?').get(id);
    const ins = db.prepare(`INSERT INTO work_order_photos (id, tenant_id, work_order_id, uploaded_by, kind, caption, customer_visible, mime, width, height, size, taken_at, image, thumb, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 99; i++) ins.run(`x${i}`, row.tenant_id, row.work_order_id, null, 'voor', '', 1, row.mime, 1, 1, 1, null, 'f1:a:b:c', 'f1:a:b:c', row.created_at);
    const response = await kees.post(`/app/api/workorders/${wo.id}/photos`, { image: fakeJpeg().toString('base64') });
    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.body.error, 'too_many_photos');
  } finally {
    server.close();
  }
});
