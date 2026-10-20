// Foto's bij werkorders (versleuteld opgeslagen, EXIF eruit) en het klantdossier.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');
const { createVault } = require('../src/vault');
const { inspectImage, cleanJpeg } = require('../src/photos');
const { sitePhotoPng } = require('../src/testdata');

// Kleine JPEG-structuur: JFIF, EXIF met GPS-gegevens, frame (SOF0 640x480), scan.
function fakeJpeg({ exif = true } = {}) {
  const seg = (marker, body) => {
    const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, body]);
  };
  const sof = Buffer.from([8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    ...(exif ? [seg(0xe1, Buffer.from('Exif\0\0GPSLatitude 52.37 Nunspeet', 'latin1'))] : []),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, sof),
    seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
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

test('vault: bestanden versleuteld met de context als AAD', () => {
  const v = createVault();
  const buf = Buffer.from([0, 1, 2, 250, 255]);
  const sealed = v.sealBytes(buf, 't1:foto:a:beeld');
  assert.match(sealed, /^f1:/);
  assert.deepStrictEqual(v.openBytes(sealed, 't1:foto:a:beeld'), buf);
  assert.throws(() => v.openBytes(sealed, 't2:foto:a:beeld'), 'andere tenant: niet te openen');
  assert.throws(() => createVault().openBytes(sealed, 't1:foto:a:beeld'), 'andere sleutel: niet te openen');
});

// ---------- API ----------
const SECRET = 'z'.repeat(64);
function client(base) {
  const jar = new Map();
  async function call(method, p, body) {
    const headers = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (kv.slice(i + 1)) jar.set(kv.slice(0, i), kv.slice(i + 1)); else jar.delete(kv.slice(0, i));
    }
    const type = res.headers.get('content-type') || '';
    const raw = Buffer.from(await res.arrayBuffer());
    let json = null;
    if (type.includes('json')) { try { json = JSON.parse(raw.toString('utf8')); } catch { /* geen JSON */ } }
    return { status: res.status, body: json, raw, type };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

async function setup() {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  const pw = 'Tuin-Plan-2026!';
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: pw });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: pw });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: pw });
  await store.createAccount(tid, { username: 'piet', displayName: 'Piet', role: 'klant', password: pw });
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username) => {
    const c = client(base);
    assert.strictEqual((await c.post('/api/auth/login', { username, password: pw })).status, 200);
    return c;
  };
  return { db, server, base, as };
}

const lines = [{ id: 'a', section: 'materiaal', description: 'Sproeier', qty: 4, unit: 'st', price: 10 }, { id: 'b', section: 'arbeid', description: 'Sproeiers plaatsen', qty: 2, unit: 'uur', price: 50 }];

test('API: foto\'s bij een werkorder, klant ziet alleen zichtbare foto\'s van zijn eigen werkorder, dossier per klant', async () => {
  const { db, server, base, as } = await setup();
  try {
    const kees = await as('kees'), baas = await as('baas'), klaas = await as('klaas'), piet = await as('piet');
    const klaasId = (await klaas.get('/api/me')).body.user.id;
    const q = (await kees.post('/api/quotes', { data: { title: 'Aanleg beregening', customer: { name: 'Fam. Klaassen', address: 'Dorpsstraat 1\nNunspeet' }, lines } })).body;
    await kees.put(`/api/quotes/${q.id}`, { status: 'akkoord', customerId: klaasId });
    const wo = (await kees.post('/api/workorders', { quoteId: q.id })).body;
    // Tweede klant zonder account (dossier op naam).
    const q2 = (await kees.post('/api/quotes', { data: { title: 'Druppelslang border', customer: { name: 'Bakker' }, lines } })).body;
    await kees.put(`/api/quotes/${q2.id}`, { status: 'akkoord' });
    const wo2 = (await kees.post('/api/workorders', { quoteId: q2.id })).body;

    const jpeg = fakeJpeg();
    const thumb = sitePhotoPng('oplevering', 2, 60, 40);
    assert.strictEqual((await klaas.post(`/api/workorders/${wo.id}/photos`, { image: jpeg.toString('base64') })).status, 403, 'klant uploadt niet');
    const up = await kees.post(`/api/workorders/${wo.id}/photos`, { image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, thumb: thumb.toString('base64'),
      kind: 'oplevering', caption: 'Gazon klaar', takenAt: '2026-05-01T10:00:00Z' });
    assert.strictEqual(up.status, 201);
    assert.deepStrictEqual([up.body.kind, up.body.caption, up.body.width, up.body.height, up.body.customerVisible, up.body.uploadedBy.displayName],
      ['oplevering', 'Gazon klaar', 640, 480, true, 'Kees']);
    assert.strictEqual(up.body.size, cleanJpeg(jpeg).body.length);
    const hidden = (await kees.post(`/api/workorders/${wo.id}/photos`, { image: sitePhotoPng('tijdens', 1).toString('base64'), kind: 'tijdens', customerVisible: false })).body;
    assert.strictEqual(hidden.mime, 'image/png');

    // Ongeldige invoer.
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/photos`, { image: Buffer.from('<svg/>').toString('base64') })).status, 400);
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/photos`, { image: 'niet base64!' })).status, 400);
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/photos`, { image: jpeg.toString('base64'), thumb: Buffer.from('x'.repeat(40)).toString('base64') })).status, 400);
    assert.strictEqual((await kees.post('/api/workorders/bestaat-niet/photos', { image: jpeg.toString('base64') })).status, 404);

    // Versleuteld in de database: geen JPEG/PNG-bytes in de rij.
    const row = db.prepare('SELECT image, thumb FROM work_order_photos WHERE id = ?').get(up.body.id);
    assert.match(row.image, /^f1:/);
    assert.match(row.thumb, /^f1:/);

    // Ophalen door de ploeg: zonder EXIF, en de miniatuur.
    const img = await kees.get(`/api/workorders/${wo.id}/photos/${up.body.id}`);
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.type, 'image/jpeg');
    assert.ok(!img.raw.includes('GPSLatitude'));
    assert.deepStrictEqual(img.raw, cleanJpeg(jpeg).body);
    const th = await kees.get(`/api/workorders/${wo.id}/photos/${up.body.id}?thumb=1`);
    assert.strictEqual(th.type, 'image/png');
    assert.deepStrictEqual(th.raw, thumb);
    assert.strictEqual((await kees.get(`/api/workorders/${wo2.id}/photos/${up.body.id}`)).status, 404, 'foto hoort bij een andere werkorder');

    const list = (await kees.get(`/api/workorders/${wo.id}/photos`)).body;
    assert.deepStrictEqual(list.items.map((p) => p.id), [up.body.id, hidden.id]);
    assert.strictEqual(list.items[0].url, `api/workorders/${wo.id}/photos/${up.body.id}`);

    // Klantportaal: alleen zichtbare foto's van de eigen werkorder.
    assert.strictEqual((await klaas.get(`/api/portal/photos/${up.body.id}`)).status, 200);
    assert.strictEqual((await klaas.get(`/api/portal/photos/${up.body.id}?thumb=1`)).type, 'image/png');
    assert.strictEqual((await klaas.get(`/api/portal/photos/${hidden.id}`)).status, 404, 'niet zichtbaar gezet');
    assert.strictEqual((await piet.get(`/api/portal/photos/${up.body.id}`)).status, 404, 'andere klant');
    assert.strictEqual((await client(base).get(`/api/portal/photos/${up.body.id}`)).status, 401);
    assert.strictEqual((await baas.get(`/api/portal/photos/${hidden.id}`)).status, 200, 'medewerker ziet alles');
    assert.strictEqual((await klaas.get(`/api/workorders/${wo.id}/photos`)).status, 403);

    // Wijzigen: zichtbaar zetten, bijschrift, soort.
    const ch = await kees.patch(`/api/workorders/${wo.id}/photos/${hidden.id}`, { customerVisible: true, caption: 'Leidingwerk', kind: 'onzin' });
    assert.deepStrictEqual([ch.body.customerVisible, ch.body.caption, ch.body.kind], [true, 'Leidingwerk', 'tijdens']);
    assert.strictEqual((await klaas.get(`/api/portal/photos/${hidden.id}`)).status, 200);

    // Dossiers: één per klant (account of naam).
    await kees.put(`/api/workorders/${wo.id}`, { status: 'gereed', data: { ...wo.data, report: { notes: 'Alles werkt', completedOn: '2026-05-02', signedBy: 'K. Klaassen' } } });
    assert.strictEqual((await klaas.get('/api/dossiers')).status, 403);
    const ds = (await kees.get('/api/dossiers')).body.items;
    assert.strictEqual(ds.length, 2);
    const dk = ds.find((d) => d.account);
    assert.deepStrictEqual([dk.key, dk.name, dk.installations, dk.completed, dk.photos, dk.lastCompletedOn], [`a-${klaasId}`, 'Fam. Klaassen', 1, 1, 2, '2026-05-02']);
    const db2 = ds.find((d) => !d.account);
    assert.match(db2.key, /^n-[0-9a-f]{16}$/);
    const d = (await kees.get(`/api/dossiers/${encodeURIComponent(dk.key)}`)).body;
    assert.strictEqual(d.customer.name, 'Fam. Klaassen');
    assert.deepStrictEqual(d.addresses, ['Dorpsstraat 1, Nunspeet']);
    assert.strictEqual(d.installations[0].report.signedBy, 'K. Klaassen');
    assert.strictEqual(d.installations[0].photos.length, 2);
    assert.deepStrictEqual(d.installations[0].materials.map((m) => m.description), ['Sproeier']);
    assert.deepStrictEqual(d.quotes.map((x) => x.number), [q.number]);
    assert.strictEqual((await kees.get(`/api/dossiers/${db2.key}`)).body.quotes.length, 1);
    assert.strictEqual((await kees.get('/api/dossiers/n-0000000000000000')).status, 404);

    // Verwijderen; definitief wissen van de werkorder neemt de foto's mee.
    assert.strictEqual((await kees.del(`/api/workorders/${wo.id}/photos/${up.body.id}`)).status, 200);
    assert.strictEqual((await kees.get(`/api/workorders/${wo.id}/photos/${up.body.id}`)).status, 404);
    assert.strictEqual((await baas.del(`/api/admin/workorders/${wo.id}`)).status, 200);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM work_order_photos').get().n, 0);
    const audit = db.prepare("SELECT action FROM audit WHERE action LIKE 'foto_%'").all().map((r) => r.action);
    assert.ok(audit.includes('foto_toegevoegd') && audit.includes('foto_verwijderd'));
  } finally {
    server.close();
  }
});

test('API: maximaal aantal foto\'s per werkorder en grote foto via de eigen limiet', async () => {
  const { db, server, as } = await setup();
  try {
    const kees = await as('kees');
    const q = (await kees.post('/api/quotes', { data: { title: 'X', customer: { name: 'Y' }, lines } })).body;
    await kees.put(`/api/quotes/${q.id}`, { status: 'akkoord' });
    const wo = (await kees.post('/api/workorders', { quoteId: q.id })).body;
    // ~2 MB: groter dan de 1 MB van de werkorder-API, past binnen de fotolimiet.
    const big = Buffer.concat([fakeJpeg({ exif: false }).subarray(0, -2), Buffer.alloc(2 * 1024 * 1024, 7), Buffer.from([0xff, 0xd9])]);
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/photos`, { image: big.toString('base64') })).status, 201);
    const tooBig = Buffer.concat([big, Buffer.alloc(3 * 1024 * 1024)]);
    assert.strictEqual((await kees.post(`/api/workorders/${wo.id}/photos`, { image: tooBig.toString('base64') })).status, 413);
    const id = db.prepare('SELECT id FROM work_order_photos').get().id;
    const row = db.prepare('SELECT * FROM work_order_photos WHERE id = ?').get(id);
    const ins = db.prepare(`INSERT INTO work_order_photos (id, tenant_id, work_order_id, uploaded_by, kind, caption, customer_visible, mime, width, height, size, taken_at, image, thumb, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 99; i++) ins.run(`x${i}`, row.tenant_id, row.work_order_id, null, 'voor', '', 1, row.mime, 1, 1, 1, null, 'f1:a:b:c', 'f1:a:b:c', row.created_at);
    const r = await kees.post(`/api/workorders/${wo.id}/photos`, { image: fakeJpeg().toString('base64') });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'too_many_photos');
  } finally {
    server.close();
  }
});
