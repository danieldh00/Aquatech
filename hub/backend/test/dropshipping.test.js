// Dropshipping met de eigen pakbon van de klant (webshop/order-slips.js): keuze bij het afrekenen, uploaden en controleren van de PDF,
// eigenaar- en omgevingscontrole, de pakbon in Te picken en Alles afdrukken in plaats van de onze, en de kopie van de verzendmail.
const test = require('node:test');
const assert = require('node:assert');
const { PDFDocument, PDFName, PDFString, degrees } = require('pdf-lib');
const { inspectSlip, assemblePdf, MAX_SLIP_BYTES } = require('../src/webshop/order-slips');
const { setup, order, until, mailsWith, PERSON } = require('./helpers/webshop-world');

/**
 * Maakt een PDF met het gevraagde aantal pagina's.
 * @param {number} pageCount Aantal pagina's.
 * @param {{ script?: boolean, size?: [number, number] }} [options] script: met een script dat bij openen draait; size: paginagrootte in punten.
 * @returns {Promise<Buffer>} De PDF.
 */
async function makePdf(pageCount, { script = false, size = [595, 842] } = {}) {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pageCount; index++) doc.addPage(size);
  if (script) {
    // Een linkannotatie met een actie en een paginaactie, zoals een kwaadwillende klant ze zou meesturen.
    const page = doc.getPage(0);
    const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 100, 100], A: { S: 'URI', URI: PDFString.of('https://phishing.example/') } }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
    page.node.set(PDFName.of('AA'), doc.context.obj({ O: { S: 'JavaScript', JS: PDFString.of('app.alert(2)') } }));
  }
  if (script) doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
  return Buffer.from(await doc.save());
}

/**
 * Aantal pagina's van een PDF.
 * @param {Buffer} bytes De PDF.
 * @returns {Promise<number>} Het aantal.
 */
async function pageCountOf(bytes) {
  return (await PDFDocument.load(bytes)).getPageCount();
}

/**
 * Stuurt een PDF als bestandsinhoud naar het uploadadres van een bestelling.
 * @param {object} world De testwereld.
 * @param {object} shopper De klant.
 * @param {string} orderId Id van de bestelling.
 * @param {Buffer} body De bytes.
 * @param {{ type?: string, method?: string }} [options] Het inhoudstype en de methode.
 * @returns {Promise<{ status: number, body: object }>} Statuscode en JSON.
 */
async function putSlip(world, shopper, orderId, body, { type = 'application/pdf', method = 'POST' } = {}) {
  const cookie = [...shopper.client.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const response = await fetch(`${world.base}/bestelling/${orderId}/pakbon`, { method, headers: { 'content-type': type, cookie }, body });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** Afrekenvelden voor een dropshippingbestelling. */
const DROP = { dropshipping: 'ja', dropshipProofEmail: 'Bewijs@Reseller.example' };

test('inspectSlip: neemt een gewone PDF aan, bouwt hem opnieuw op zonder scripts en weigert de rest', async () => {
  const good = await inspectSlip(await makePdf(2, { script: true }));
  assert.ok(good.bytes && good.pages === 2, JSON.stringify(good.error));
  const text = good.bytes.toString('latin1');
  for (const forbidden of ['JavaScript', 'phishing', '/Annots', '/AA ']) assert.ok(!text.includes(forbidden), `${forbidden} is eruit`);
  assert.strictEqual(await pageCountOf(good.bytes), 2);
  assert.match((await inspectSlip(Buffer.from('dit is geen pdf, maar wel genoeg tekst om niet leeg te zijn, echt waar, nog meer tekst'))).error, /geen PDF/);
  assert.match((await inspectSlip(Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('rommel '.repeat(30))]))).error, /niet worden gelezen/);
  assert.match((await inspectSlip(Buffer.alloc(0))).error, /leeg/);
  assert.match((await inspectSlip(Buffer.alloc(MAX_SLIP_BYTES + 1, 1))).error, /te groot/);
  assert.match((await inspectSlip(await makePdf(11))).error, /te veel pagina/);
  assert.match((await inspectSlip(await makePdf(1, { size: [20000, 20000] }))).error, /paginagrootte/);
});

test('inspectSlip: weigert een decompressiebom snel en zonder veel geheugen', async () => {
  const zlib = require('zlib');
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  const base = Buffer.from(await doc.save());
  const bomb = zlib.deflateSync(Buffer.alloc(200 * 1024 * 1024), { level: 9 });
  assert.ok(bomb.length < MAX_SLIP_BYTES, 'de bom zelf is klein genoeg om te uploaden');
  const pdf = Buffer.concat([base, Buffer.from(`\n99 0 obj\n<< /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n`), bomb, Buffer.from('\nendstream\nendobj\n')]);
  // Ook als het filter ver vóór de stream staat (veel opvulling in het woordenboek) wordt de bom herkend.
  const padded = Buffer.concat([base, Buffer.from(`\n98 0 obj\n<< /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode /Pad (${'x'.repeat(4000)}) /Length ${bomb.length} >>\nstream\n`), bomb, Buffer.from('\nendstream\nendobj\n')]);
  assert.match((await inspectSlip(padded)).error, /te groot als hij wordt uitgepakt/);
  // Een 'endstream' middenin de gecomprimeerde gegevens knipt de scan niet af, en een stream zonder einde wordt geweigerd.
  const split = zlib.deflateSync(Buffer.concat([Buffer.from('endstream'), Buffer.alloc(200 * 1024 * 1024)]), { level: 9 });
  const sneaky = Buffer.concat([base, Buffer.from(`\n97 0 obj\n<< /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode /Length ${split.length} >>\nstream\n`), split, Buffer.from('\nendstream\nendobj\n')]);
  assert.match((await inspectSlip(sneaky)).error, /te groot als hij wordt uitgepakt/);
  // Een bom die binnen de ruwe gegevens van een andere stream staat (pdf-lib leest hem via de xref) wordt ook gevonden.
  const hidden = Buffer.concat([Buffer.from('\n94 0 obj\n<< /Length 10 >>\nstream\nxxxx\n93 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\n'), bomb, Buffer.from('\nendstream\nendobj\n')]);
  assert.match((await inspectSlip(Buffer.concat([base, hidden]))).error, /te groot als hij wordt uitgepakt/);
  // Spaties tussen 'stream' en het regeleinde (pdf-lib leest dat ook) ontsnappen niet aan de controle.
  for (const gap of [' \r\n', ' \n', '  \r\n']) {
    const spaced = Buffer.concat([base, Buffer.from(`\n92 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream${gap}`), bomb, Buffer.from('\nendstream\nendobj\n')]);
    assert.match((await inspectSlip(spaced)).error, /te groot als hij wordt uitgepakt/);
  }
  // Een filterketen (Flate van Flate): de eerste laag is klein, de tweede enorm.
  const chained = zlib.deflateSync(zlib.deflateSync(Buffer.alloc(200 * 1024 * 1024), { level: 9 }), { level: 9 });
  const chain = Buffer.concat([base, Buffer.from('\n91 0 obj\n<< /Type /ObjStm /Filter [/FlateDecode /FlateDecode] >>\nstream\n'), chained, Buffer.from('\nendstream\nendobj\n')]);
  assert.match((await inspectSlip(chain)).error, /te groot als hij wordt uitgepakt/);
  // Ook als de binnenste laag een zlib-kop met een kleiner venster heeft (0x58 in plaats van 0x78).
  const smallWindow = zlib.deflateSync(zlib.deflateSync(Buffer.alloc(200 * 1024 * 1024), { level: 9, windowBits: 13 }), { level: 9 });
  const chain2 = Buffer.concat([base, Buffer.from('\n90 0 obj\n<< /Type /ObjStm /Filter [/FlateDecode /FlateDecode] >>\nstream\n'), smallWindow, Buffer.from('\nendstream\nendobj\n')]);
  assert.match((await inspectSlip(chain2)).error, /te groot als hij wordt uitgepakt/);
  // Filters die niet te begrenzen zijn worden geweigerd, ook als de naam met #xx is geschreven.
  for (const name of ['ASCIIHexDecode', 'RunLengthDecode', 'ASCII#48exDecode']) {
    const hexed = Buffer.concat([base, Buffer.from(`\n89 0 obj\n<< /Type /ObjStm /Filter [/${name} /FlateDecode] >>\nstream\n00>\nendstream\nendobj\n`)]);
    assert.match((await inspectSlip(hexed)).error, /compressie die niet wordt ondersteund/);
  }
  // Een naam helemaal met #xx-tekens geschreven is langer dan 40 ruwe tekens.
  for (const name of ['RunLengthDecode', 'ASCIIHexDecode']) {
    const escaped = [...name].map((character) => `#${character.charCodeAt(0).toString(16).toUpperCase()}`).join('');
    const long = Buffer.concat([base, Buffer.from(`\n86 0 obj\n<< /Type /ObjStm /Filter /${escaped} >>\nstream\n00>\nendstream\nendobj\n`)]);
    assert.match((await inspectSlip(long)).error, /compressie die niet wordt ondersteund/);
  }
  // Een NUL na de naam is voor pdf-lib witruimte.
  const nul = Buffer.concat([base, Buffer.from('\n87 0 obj\n<< /Type /ObjStm /Filter /RunLengthDecode\0/Length 3 >>\nstream\n00>\nendstream\nendobj\n', 'latin1')]);
  assert.match((await inspectSlip(nul)).error, /compressie die niet wordt ondersteund/);
  // Een verwijzing naar een filternaam (die in een objectstroom kan staan) wordt geweigerd, direct of in een rij.
  for (const filter of ['8 0 R', '[/FlateDecode 8 0 R]', '[ 8 0 R ]', '\0 8 0 R', '\0[ 8 0 R ]', '\0[/FlateDecode\0 8 0 R]', `${' '.repeat(400)}8 0 R`, `${'\n'.repeat(400)}[ 8 0 R ]`, '%c\n8 0 R', `%${'x'.repeat(500)}\n8 0 R`]) {
    const indirect = Buffer.concat([base, Buffer.from(`\n88 0 obj\n<< /Type /ObjStm /Filter ${filter} >>\nstream\n00>\nendstream\nendobj\n`, 'latin1')]);
    assert.match((await inspectSlip(indirect)).error, /compressie die niet wordt ondersteund/);
  }
  // Gewone namen die toevallig lijken op een afkorting van een filter (/RL gs) zijn geen probleem.
  assert.ok((await inspectSlip(Buffer.concat([await makePdf(1), Buffer.from('\n% /RL gs /A85 /LZW\n')]))).bytes);
  // Een onredelijk aantal streams wordt geweigerd.
  const many = Buffer.concat([base, Buffer.from('\nstream\nabc\nendstream'.repeat(600))]);
  assert.match((await inspectSlip(many)).error, /te groot als hij wordt uitgepakt/);
  const open = Buffer.concat([base, Buffer.from('\n96 0 obj\n<< /Length 100 >>\nstream\n'), bomb]);
  assert.match((await inspectSlip(open)).error, /te groot als hij wordt uitgepakt/);
  const started = Date.now();
  const result = await inspectSlip(pdf);
  assert.match(result.error, /te groot als hij wordt uitgepakt/);
  assert.ok(Date.now() - started < 3000, 'binnen enkele seconden geweigerd');
});

test('assemblePdf: zet eigen pagina\'s en de pakbon van de klant (met bestelnummer) in volgorde', async () => {
  const ours = await makePdf(3);
  const customer = await makePdf(2);
  const merged = await assemblePdf([
    { type: 'ours', first: 0, last: 0 }, { type: 'slip', bytes: customer, label: 'WEB-1 - dropshipping' }, { type: 'ours', first: 1, last: 2 },
  ], ours);
  assert.strictEqual(await pageCountOf(merged), 5);
  const rotated = await PDFDocument.create();
  for (const angle of [0, 90, 180, 270]) rotated.addPage([595, 842]).setRotation(degrees(angle));
  const withLabels = await assemblePdf([{ type: 'slip', bytes: Buffer.from(await rotated.save()), label: 'WEB-3 - dropshipping' }], null);
  assert.strictEqual(await pageCountOf(withLabels), 4, 'ook gedraaide pagina\'s krijgen een etiket');
  const onlyCustomer = await assemblePdf([{ type: 'slip', bytes: customer, label: 'WEB-2 - dropshipping' }], null);
  assert.strictEqual(await pageCountOf(onlyCustomer), 2);
});

test('afrekenen: dropshipping vraagt een geldig e-mailadres voor het afleverbewijs en kan niet bij ophalen', async () => {
  const world = await setup();
  const [shopper] = world.shoppers;
  const { postForm, postCheckout } = require('./helpers/http-client');
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '1' });
  const form = await shopper.client.request('GET', '/afrekenen/');
  assert.match(form.text, /name="dropshipping"/);
  assert.match(form.text, /name="dropshipProofEmail"/);
  const noMail = await postCheckout(world.base, shopper.client, { ...PERSON, dropshipping: 'ja', dropshipProofEmail: 'geen-adres' });
  assert.strictEqual(noMail.status, 400);
  assert.match(noMail.text, /afleverbewijs naartoe moet/);
  const pickup = await postCheckout(world.base, shopper.client, { ...PERSON, ...DROP, shippingMethod: 'ophalen' });
  assert.strictEqual(pickup.status, 400);
  assert.match(pickup.text, /Dropshipping kan alleen met bezorgen/);
  assert.strictEqual((await world.admin.get('/app/api/admin/web-orders')).body.items.length, 0, 'er is niets besteld');
});

test('dropshipping: uploaden, eigenaarcontrole, Te picken en Alles afdrukken met de pakbon van de klant', async () => {
  const world = await setup();
  const [owner, stranger] = world.shoppers;
  const dropId = await order(world, owner, DROP);
  const normalId = await order(world, stranger, {});
  const detail = (await world.admin.get(`/app/api/admin/web-orders/${dropId}`)).body.order;
  assert.deepStrictEqual(detail.dropshipping, { proofEmail: 'bewijs@reseller.example', slip: null });

  // Zonder pakbon van de klant staat de bestelling niet in Te picken (wel gemeld) en is geen pakbon te maken.
  let pick = (await world.admin.get('/app/api/admin/web-orders/to-pick')).body;
  assert.deepStrictEqual(pick.items.map((item) => item.id), [normalId]);
  assert.deepStrictEqual(pick.waitingForSlip.map((entry) => entry.id), [dropId]);
  const blocked = await world.admin.post(`/app/api/admin/web-orders/${dropId}/packing-slip`, {});
  assert.strictEqual(blocked.status, 409);
  assert.match(blocked.body.message, /nog geen pakbon geüpload/);
  const page = await owner.client.request('GET', `/bestelling/${dropId}/`);
  assert.match(page.text, /Upload je pakbon/);
  assert.match(page.text, /bewijs@reseller\.example/);
  assert.match(page.text, /pakbon\.js/);

  // Alleen de eigenaar mag uploaden en alleen een echte PDF.
  const pdf = await makePdf(2);
  assert.strictEqual((await putSlip(world, stranger, dropId, pdf)).status, 404, 'andermans bestelling');
  assert.strictEqual((await putSlip(world, owner, normalId, pdf)).status, 404, 'bestelling van een ander');
  assert.strictEqual((await putSlip(world, stranger, normalId, pdf)).status, 409, 'geen dropshippingbestelling');
  assert.strictEqual((await putSlip(world, owner, dropId, pdf, { type: 'text/plain' })).status, 415, 'alleen application/pdf');
  assert.strictEqual((await putSlip(world, owner, dropId, Buffer.from('%PDF-1.4 ' + 'x'.repeat(100)))).status, 400);
  const tooBig = await putSlip(world, owner, dropId, Buffer.alloc(MAX_SLIP_BYTES + 10, 1));
  assert.strictEqual(tooBig.status, 413);
  const anonymous = await fetch(`${world.base}/bestelling/${dropId}/pakbon`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: pdf });
  assert.strictEqual(anonymous.status, 401);
  const crossSite = await fetch(`${world.base}/bestelling/${dropId}/pakbon`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'sec-fetch-site': 'cross-site', cookie: [...owner.client.jar].map(([name, value]) => `${name}=${value}`).join('; ') }, body: pdf });
  assert.strictEqual(crossSite.status, 403);
  assert.strictEqual((await world.admin.get(`/app/api/admin/web-orders/${dropId}`)).body.order.dropshipping.slip, null, 'niets is opgeslagen');

  const stored = await putSlip(world, owner, dropId, await makePdf(2, { script: true }));
  assert.strictEqual(stored.status, 200, JSON.stringify(stored.body));
  assert.strictEqual(stored.body.pages, 2);
  const row = world.db.prepare('SELECT data, pages, size FROM web_order_slips WHERE order_id = ?').get(dropId);
  assert.ok(row.data.startsWith('f1:') && !row.data.includes('%PDF'), 'versleuteld opgeslagen');
  assert.strictEqual(Number(row.pages), 2);
  const withSlip = (await world.admin.get(`/app/api/admin/web-orders/${dropId}`)).body.order.dropshipping.slip;
  assert.strictEqual(withSlip.pages, 2);
  assert.match(withSlip.name, /^Pakbon WEB-/);

  // Vervangen kan (één pakbon per bestelling).
  assert.strictEqual((await putSlip(world, owner, dropId, await makePdf(1))).status, 200);
  assert.strictEqual(Number(world.db.prepare('SELECT COUNT(*) AS n FROM web_order_slips').get().n), 1);
  assert.strictEqual((await putSlip(world, owner, dropId, await makePdf(2))).status, 200);

  // Bekijken: alleen de eigenaar.
  const mine = await owner.client.request('GET', `/bestelling/${dropId}/pakbon.pdf`);
  assert.strictEqual(mine.status, 200);
  assert.match(mine.type, /application\/pdf/);
  assert.strictEqual(await pageCountOf(mine.raw), 2);
  assert.strictEqual((await stranger.client.request('GET', `/bestelling/${dropId}/pakbon.pdf`)).status, 404);
  assert.strictEqual((await world.vreemd.get(`/app/api/admin/web-orders/${dropId}`)).status, 404, 'andere organisatie ziet de bestelling niet');

  // Nu staat hij in Te picken en gaat de pakbon van de klant in de PDF; onze eigen pakbon alleen voor de gewone bestelling.
  pick = (await world.admin.get('/app/api/admin/web-orders/to-pick')).body;
  assert.deepStrictEqual(pick.waitingForSlip, []);
  assert.strictEqual(pick.items.length, 2);
  assert.strictEqual(pick.items.find((item) => item.id === dropId).dropshipping, true);
  assert.strictEqual(pick.items.find((item) => item.id === normalId).dropshipping, false);
  const all = await world.admin.post('/app/api/admin/web-orders/packing-slips', { ids: pick.items.map((item) => item.id) });
  assert.strictEqual(all.status, 200);
  assert.strictEqual(await pageCountOf(all.raw), 1 + 2, 'één eigen pagina plus de twee van de klant');
  const single = await world.admin.post(`/app/api/admin/web-orders/${dropId}/packing-slip`, {});
  assert.strictEqual(single.status, 200);
  assert.strictEqual(await pageCountOf(single.raw), 2, 'alleen de pakbon van de klant');
  assert.ok(!single.raw.toString('latin1').includes('JavaScript'));
  const printed = (await world.admin.get('/app/api/admin/web-orders/to-pick')).body.items.find((item) => item.id === dropId);
  assert.ok(printed.printedAt, 'het afdrukken is vastgelegd');

  // Na het afdrukken kan de klant de pakbon niet meer vervangen (het papier ligt al in de doos).
  const afterPrint = await putSlip(world, owner, dropId, pdf);
  assert.strictEqual(afterPrint.status, 409);
  assert.match(afterPrint.body.message, /afgedrukt/);

  // Na verzenden is de pakbon vast, en de verzendmail gaat ook naar het adres voor het afleverbewijs.
  assert.strictEqual((await world.admin.post(`/app/api/admin/web-orders/${dropId}/status`, { status: 'verzonden' })).status, 200);
  assert.strictEqual((await putSlip(world, owner, dropId, pdf)).status, 409);
  const shipment = await until(() => mailsWith(world.sent, /onderweg/)[0]);
  assert.strictEqual(shipment.to, 'k1@voorbeeld.nl');
  const proofMail = await until(() => world.sent.find((message) => message.to === 'bewijs@reseller.example'));
  assert.ok(!proofMail.text.includes('Klant 1'), 'geen tekst van de klant in de mail aan het afleverbewijs-adres');
  assert.match(proofMail.text, /Bestelling WEB-\d{4}-\d+ is onderweg/);
  assert.strictEqual((await world.admin.get('/app/api/admin/web-orders/to-pick')).body.items.length, 1);
});

test('een dropshippingbestelling zonder pakbon blijft geblokkeerd voor het afdrukken van een groep', async () => {
  const world = await setup();
  const [owner] = world.shoppers;
  const dropId = await order(world, owner, DROP);
  const out = await world.admin.post('/app/api/admin/web-orders/packing-slips', { ids: [dropId] });
  assert.strictEqual(out.status, 409);
  assert.match(out.body.message, /nog geen pakbon geüpload/);
});
