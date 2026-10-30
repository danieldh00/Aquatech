// Verzendmail met volgcode van DPD, bestelhistorie in het klantaccount en de
// factuur als PDF bij een eigen bestelling in de eigen webshop.
const test = require('node:test');
const assert = require('node:assert');
const { createClient } = require('./helpers/http-client');
const { setup, order, until, mailsWith, PW } = require('./helpers/webshop-world');

test('Verzonden met volgcode: de klant krijgt een mail met de DPD-link', async () => {
  const world = await setup();
  const id = await order(world, world.shoppers[0]);
  assert.strictEqual((await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden', trackingCode: 'abc123456789' })).status, 200);
  const [mail] = await until(() => { const found = mailsWith(world.sent, /onderweg/); return found.length ? found : null; });
  assert.strictEqual(mail.to, 'els@bakker.example');
  assert.match(mail.subject, /volgcode abc123456789/);
  assert.match(mail.text, /tracking\.dpd\.de\/status\/nl_NL\/parcel\/abc123456789/);
  const detail = (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order;
  await until(async () => (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order.shipMail);
  assert.strictEqual(detail.shipping.tracking.code, 'abc123456789');
});

test('volgcode later: één extra mail, niet bij dezelfde code', async () => {
  const world = await setup();
  const id = await order(world, world.shoppers[0]);
  await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' });
  await until(() => mailsWith(world.sent, /onderweg/).length === 1);
  assert.doesNotMatch(mailsWith(world.sent, /onderweg/)[0].text, /tracking\.dpd\.de/);
  await world.admin.post(`/api/admin/web-orders/${id}/tracking`, { trackingCode: 'abc123456789' });
  await until(() => mailsWith(world.sent, /onderweg/).length === 2);
  assert.match(mailsWith(world.sent, /onderweg/)[1].text, /abc123456789/);
  await world.admin.post(`/api/admin/web-orders/${id}/tracking`, { trackingCode: 'abc123456789' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(mailsWith(world.sent, /onderweg/).length, 2, 'dezelfde code geeft geen nieuwe mail');
  const shipMail = await until(async () => (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order.shipMail);
  assert.strictEqual(shipMail.sent, true);
});

test('ophalen: mail dat de bestelling klaarstaat', async () => {
  const world = await setup();
  const id = await order(world, world.shoppers[0], { shippingMethod: 'ophalen' });
  await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' });
  const [mail] = await until(() => { const found = mailsWith(world.sent, /staat klaar/); return found.length ? found : null; });
  assert.match(mail.text, /klaar om op te halen/);
});

test('bestelhistorie: alleen eigen bestellingen, niet zonder inloggen', async () => {
  const world = await setup();
  const [first, second] = world.shoppers;
  await order(world, first);
  await order(world, second);
  const own = await first.client.get('/winkel/bestellingen/');
  assert.strictEqual(own.status, 200);
  assert.match(own.text, /WEB-\d{4}-0001/);
  assert.doesNotMatch(own.text, /WEB-\d{4}-0002/, 'de bestelling van een ander staat er niet tussen');
  assert.match((await first.client.get('/winkel/account/')).text, /Mijn bestellingen/);
  const beyond = await first.client.get('/winkel/bestellingen/?pagina=5');
  assert.match(beyond.text, /Naar de eerste pagina/, 'een lege pagina verwijst terug naar pagina 1');
  assert.doesNotMatch(beyond.text, /nog geen bestellingen/);
  const anonymous = await createClient(world.base).get('/winkel/bestellingen/');
  assert.match(anonymous.text, /Inloggen/, 'zonder sessie naar het inlogscherm');
  assert.doesNotMatch(anonymous.text, /WEB-\d{4}-0001/);
});

test('factuur als PDF: eigen bestelling na Verzonden, niet van een ander, niet als concept', async () => {
  const world = await setup();
  const [owner, stranger] = world.shoppers;
  const id = await order(world, owner);
  const url = `/winkel/bestelling/${id}/factuur.pdf`;
  assert.strictEqual((await owner.client.get(url)).status, 404, 'nog geen factuur');
  assert.doesNotMatch((await owner.client.get(`/winkel/bestelling/${id}/`)).text, /factuur\.pdf/);
  await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' });
  const page = await owner.client.get(`/winkel/bestelling/${id}/`);
  assert.match(page.text, /href="factuur\.pdf"/);
  const pdf = await owner.client.get(url);
  assert.strictEqual(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  assert.match(pdf.headers.get('content-disposition'), /attachment; filename="[A-Za-z0-9._-]+\.pdf"/);
  assert.strictEqual((await stranger.client.get(url)).status, 404);
  const anonymous = await createClient(world.base).get(url);
  assert.notStrictEqual(anonymous.type, 'application/pdf', 'zonder sessie geen PDF');
  assert.match(anonymous.text, /Inloggen/);
});

test('een conceptfactuur is niet te downloaden door de klant', async () => {
  const world = await setup();
  await world.admin.put('/api/invoices/settings', { webOrders: { enabled: true, finalize: false } });
  const id = await order(world, world.shoppers[0]);
  await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' });
  assert.strictEqual((await world.shoppers[0].client.get(`/winkel/bestelling/${id}/factuur.pdf`)).status, 404);
  assert.doesNotMatch((await world.shoppers[0].client.get(`/winkel/bestelling/${id}/`)).text, /factuur\.pdf/);
});
