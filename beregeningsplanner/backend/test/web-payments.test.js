// Tests van online betalen in de eigen webshop (Mollie): instelling, keuze bij
// het afrekenen, betaalstroom met webhook en terugkeer, een mislukte betaling,
// beveiliging van de webhook, verlopen van onbetaalde bestellingen en de rechten.
const test = require('node:test');
const assert = require('node:assert');
const { setup, order, until, mailsWith, PERSON } = require('./helpers/webshop-world');
const { createClient, postForm, postCheckout } = require('./helpers/http-client');

/**
 * Plaatst een online bestelling en geeft het id en het Mollie-id van de eerste betaling.
 * @param {object} world Het resultaat van setup({ mollie: true }).
 * @param {object} shopper De klant.
 * @returns {Promise<{ id: string, paymentId: string }>} Het bestel-id en het betaling-id.
 */
async function placeOnline(world, shopper) {
  const id = await order(world, shopper, { paymentMethod: 'online' });
  const pay = await createClient(world.base, { jar: shopper.client.jar, followRedirects: false }).get(`/winkel/bestelling/${id}/betalen/`);
  assert.strictEqual(pay.status, 302);
  assert.match(pay.location, /^https:\/\/www\.mollie\.com\/checkout\//);
  const detail = (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order;
  return { id, paymentId: detail.pay.id };
}

/**
 * Laat Mollie de webhook voor een betaling aanroepen (zonder cookies, zoals Mollie zelf).
 * @param {object} world Het resultaat van setup.
 * @param {string} orderId Het bestel-id in het adres van de webhook.
 * @param {string} paymentId Het betaling-id in de inhoud.
 * @returns {Promise<{ status: number }>} Het antwoord.
 */
const webhook = (world, orderId, paymentId) => postForm(world.base, createClient(world.base), `/winkel/mollie/webhook/${orderId}/`, { id: paymentId });

test('de instelling bewaart de sleutel versleuteld en toont hem nooit', async () => {
  const world = await setup({ mollie: true });
  const view = (await world.admin.get('/api/admin/settings')).body.settings;
  assert.strictEqual(view.mollieApiKey.set, true);
  assert.strictEqual(view.mollieApiKey.value, undefined);
  assert.strictEqual(view.mollieApiKey.hint, '…4567');
  assert.strictEqual(view.shopPayment.value.publicUrl, 'https://winkel.example/winkel/');
  const invalid = await world.admin.put('/api/admin/settings', { shopPayment: { online: true, publicUrl: 'http://evil.example/', onAccount: 'zomaar', holdHours: 9999 } });
  assert.strictEqual(invalid.status, 200);
  assert.deepStrictEqual(invalid.body.settings.shopPayment.value, { online: true, publicUrl: '', onAccount: 'iedereen', holdHours: 24 }, 'http buiten localhost, onbekende keuze en bewaartijd worden gesaneerd');
});

test('de betaalinstelling is alleen voor beheerders van de hoofdtenant', async () => {
  const world = await setup({ mollie: true });
  assert.strictEqual((await world.shoppers[0].client.put('/api/admin/settings', { shopPayment: { online: false } })).status, 403);
  const other = await world.vreemd.put('/api/admin/settings', { shopPayment: { online: true } });
  assert.strictEqual(other.status, 400);
  const otherView = (await world.vreemd.get('/api/admin/settings')).body.settings;
  assert.strictEqual(otherView.shopPayment, undefined);
  assert.strictEqual(otherView.mollieApiKey, undefined);
});

test('bij het afrekenen kiest de klant hoe hij betaalt', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  await postForm(world.base, customer.client, '/winkel/winkelwagen/', { action: 'add', code: 'BUS', qty: '1' });
  const both = await customer.client.get('/winkel/afrekenen/');
  assert.match(both.text, /name="paymentMethod" value="online" checked/);
  assert.match(both.text, /name="paymentMethod" value="rekening"/);
  await world.admin.put('/api/admin/settings', { shopPayment: { online: true, publicUrl: 'https://winkel.example/winkel/', onAccount: 'nooit', holdHours: 24 } });
  const onlyOnline = await customer.client.get('/winkel/afrekenen/');
  assert.match(onlyOnline.text, /<input type="hidden" name="paymentMethod" value="online">/);
  assert.doesNotMatch(onlyOnline.text, /value="rekening"/);
  assert.match(onlyOnline.text, /Bestellen en betalen/);
  const refused = await postCheckout(world.base, customer.client, { ...PERSON, paymentMethod: 'rekening' });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.text, /Kies hoe je wilt betalen/);
  await world.admin.put('/api/admin/settings', { shopPayment: { online: false, publicUrl: 'https://winkel.example/winkel/', onAccount: 'nooit', holdHours: 24 } });
  const fallback = await customer.client.get('/winkel/afrekenen/');
  assert.match(fallback.text, /Op rekening/, 'zonder online betalen blijft op rekening bestellen mogelijk');
});

test('online betalen: bestelling, betaalpagina, webhook, bevestiging en factuur', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const id = await order(world, customer, { paymentMethod: 'online' });
  let detail = (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order;
  assert.strictEqual(detail.payment, 'online');
  assert.strictEqual(detail.pay.status, 'open');
  assert.strictEqual(mailsWith(world.sent, /Bevestiging van je bestelling/).length, 0, 'nog geen bevestiging vóór de betaling');
  const page = await customer.client.get(`/winkel/bestelling/${id}/?bedankt=1&betalen=1`);
  assert.match(page.text, /<meta http-equiv="refresh" content="0;url=betalen\/">/);
  assert.match(page.text, /Nu betalen/);

  const followed = createClient(world.base, { jar: customer.client.jar, followRedirects: false });
  const toMollie = await followed.get(`/winkel/bestelling/${id}/betalen/`);
  assert.strictEqual(toMollie.status, 302);
  assert.match(toMollie.location, /^https:\/\/www\.mollie\.com\/checkout\/select-method\/tr_test0001$/);
  const created = world.mollie.calls.find((call) => call.method === 'POST');
  assert.deepStrictEqual(created.body.amount, { currency: 'EUR', value: '31.15' });
  assert.strictEqual(created.body.webhookUrl, `https://winkel.example/winkel/mollie/webhook/${id}/`);
  assert.strictEqual(created.body.redirectUrl, `https://winkel.example/winkel/bestelling/${id}/?betaald=1`);
  assert.strictEqual(created.headers['Idempotency-Key'], `${id}:1`);
  assert.strictEqual(created.headers.Authorization, 'Bearer test_abcdefghij1234567');

  const early = await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' });
  assert.strictEqual(early.status, 409);
  assert.match(early.body.message, /nog niet betaald/);

  world.mollie.set('tr_test0001', 'paid');
  assert.strictEqual((await webhook(world, id, 'tr_test0001')).status, 200);
  await until(() => mailsWith(world.sent, /Bevestiging van je bestelling/).length === 1);
  assert.strictEqual((await webhook(world, id, 'tr_test0001')).status, 200);
  detail = (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order;
  assert.strictEqual(detail.pay.status, 'betaald');
  assert.strictEqual(detail.pay.method, 'ideal');
  const confirmation = mailsWith(world.sent, /Bevestiging van je bestelling/)[0];
  assert.match(confirmation.text, /online betaald/);
  assert.strictEqual(mailsWith(world.sent, /Bevestiging van je bestelling/).length, 1, 'een tweede webhook stuurt geen tweede mail');

  const shipped = await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' });
  assert.strictEqual(shipped.status, 200, JSON.stringify(shipped.body));
  const withInvoice = (await world.admin.get(`/api/admin/web-orders/${id}`)).body;
  assert.ok(withInvoice.invoice, 'factuur gemaakt');
  assert.strictEqual(withInvoice.invoice.status, 'betaald', 'online betaald = factuur meteen betaald');
  assert.ok(withInvoice.invoice.paidAt);
  const view = await customer.client.get(`/winkel/bestelling/${id}/`);
  assert.match(view.text, /Betaling: <strong>betaald<\/strong>/);
});

test('terug van de betaalpagina vraagt de uitkomst zelf op, ook zonder webhook', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const { id, paymentId } = await placeOnline(world, customer);
  const waiting = await customer.client.get(`/winkel/bestelling/${id}/?betaald=1`);
  assert.match(waiting.text, /nog te betalen/);
  world.mollie.set(paymentId, 'paid');
  const back = await customer.client.get(`/winkel/bestelling/${id}/?betaald=1`);
  assert.match(back.text, /Bedankt voor je bestelling/);
  assert.match(back.text, /Betaling: <strong>betaald<\/strong>/);
  await until(() => mailsWith(world.sent, /Bevestiging van je bestelling/).length === 1);
  assert.strictEqual((await world.admin.get(`/api/admin/web-orders/${id}`)).body.order.pay.status, 'betaald');
});

test('een mislukte betaling kan opnieuw; een oude poging telt niet', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const { id, paymentId } = await placeOnline(world, customer);
  world.mollie.set(paymentId, 'canceled');
  assert.strictEqual((await webhook(world, id, paymentId)).status, 200);
  let detail = (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order;
  assert.strictEqual(detail.pay.status, 'mislukt');
  assert.strictEqual(detail.status, 'nieuw', 'de bestelling blijft staan');
  const failed = await customer.client.get(`/winkel/bestelling/${id}/`);
  assert.match(failed.text, /niet gelukt/);
  assert.match(failed.text, /Opnieuw betalen/);
  const again = await createClient(world.base, { jar: customer.client.jar, followRedirects: false }).get(`/winkel/bestelling/${id}/betalen/`);
  assert.strictEqual(again.status, 302);
  detail = (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order;
  assert.strictEqual(detail.pay.status, 'open');
  assert.strictEqual(detail.pay.ids.length, 2);
  const second = detail.pay.id;
  assert.notStrictEqual(second, paymentId);
  assert.strictEqual(world.mollie.calls.filter((call) => call.method === 'POST').pop().headers['Idempotency-Key'], `${id}:2`);
  world.mollie.set(paymentId, 'failed');
  await webhook(world, id, paymentId);
  assert.strictEqual((await world.admin.get(`/api/admin/web-orders/${id}`)).body.order.pay.status, 'open', 'de oude poging zet de nieuwe niet op mislukt');
  world.mollie.set(second, 'paid');
  await webhook(world, id, second);
  assert.strictEqual((await world.admin.get(`/api/admin/web-orders/${id}`)).body.order.pay.status, 'betaald');
});

test('de webhook negeert onbekende, vreemde en onjuiste betalingen', async () => {
  const world = await setup({ mollie: true });
  const [first, second] = world.shoppers;
  const one = await placeOnline(world, first);
  const two = await placeOnline(world, second);
  world.mollie.set(two.paymentId, 'paid');
  assert.strictEqual((await webhook(world, one.id, two.paymentId)).status, 200, 'de betaling van een andere bestelling');
  assert.strictEqual((await world.admin.get(`/api/admin/web-orders/${one.id}`)).body.order.pay.status, 'open');
  assert.strictEqual((await webhook(world, one.id, 'geen-id')).status, 200);
  assert.strictEqual((await webhook(world, '00000000-0000-0000-0000-000000000000', one.paymentId)).status, 200);
  assert.strictEqual((await webhook(world, one.id, 'tr_nietbekend1')).status, 200);
  // Bedrag dat niet bij de bestelling hoort: genegeerd, ook al zegt Mollie paid.
  world.mollie.set(one.paymentId, 'paid', { amount: { currency: 'EUR', value: '1.00' } });
  await webhook(world, one.id, one.paymentId);
  assert.strictEqual((await world.admin.get(`/api/admin/web-orders/${one.id}`)).body.order.pay.status, 'open');
  assert.strictEqual(mailsWith(world.sent, /Bevestiging van je bestelling/).length, 0);
});

test('is Mollie onbereikbaar, dan krijgt Mollie een fout (opnieuw proberen) en de klant een melding', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const { id, paymentId } = await placeOnline(world, customer);
  world.mollie.down.on = true;
  assert.strictEqual((await webhook(world, id, paymentId)).status, 502);
  const unreachable = await createClient(world.base, { jar: customer.client.jar, followRedirects: false }).get(`/winkel/bestelling/${id}/betalen/`);
  assert.strictEqual(unreachable.status, 303);
  assert.match(unreachable.location, /betaalfout=1/);
  assert.match((await customer.client.get(`/winkel/bestelling/${id}/?betaalfout=1`)).text.replace(/\s+/g, ' '), /nu niet bereikbaar/);
  world.mollie.down.on = false;
  assert.strictEqual((await webhook(world, id, paymentId)).status, 200);
});

test('de betaalpagina is alleen voor de eigen bestelling', async () => {
  const world = await setup({ mollie: true });
  const [owner, stranger] = world.shoppers;
  const id = await order(world, owner, { paymentMethod: 'online' });
  const refused = await stranger.client.get(`/winkel/bestelling/${id}/betalen/`);
  assert.strictEqual(refused.status, 404);
  const anonymous = createClient(world.base, { followRedirects: false });
  assert.strictEqual((await anonymous.get(`/winkel/bestelling/${id}/betalen/`)).status, 302);
  assert.strictEqual(world.mollie.calls.length, 0, 'geen betaling aangemaakt');
});

test('een onbetaalde online bestelling vervalt na de bewaartijd, een betaalde niet', async () => {
  const world = await setup({ mollie: true });
  const [first, second] = world.shoppers;
  const unpaid = await placeOnline(world, first);
  const paid = await placeOnline(world, second);
  world.mollie.set(paid.paymentId, 'paid');
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  world.db.prepare('UPDATE web_orders SET created_at = ?').run(old);
  assert.deepStrictEqual(await world.app.locals.webPaymentsExpire(), { expired: 1 });
  const expired = (await world.admin.get(`/api/admin/web-orders/${unpaid.id}`)).body.order;
  assert.strictEqual(expired.status, 'geannuleerd');
  assert.strictEqual(expired.pay.status, 'verlopen');
  const kept = (await world.admin.get(`/api/admin/web-orders/${paid.id}`)).body.order;
  assert.strictEqual(kept.status, 'nieuw');
  assert.strictEqual(kept.pay.status, 'betaald', 'bleek bij Mollie toch betaald');
  assert.deepStrictEqual(await world.app.locals.webPaymentsExpire(), { expired: 0 });
});

test('betaald na annuleren: de betaling wordt vastgelegd met een waarschuwing om terug te betalen', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const { id, paymentId } = await placeOnline(world, customer);
  assert.strictEqual((await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'geannuleerd' })).status, 200);
  world.mollie.set(paymentId, 'paid');
  await webhook(world, id, paymentId);
  const detail = (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order;
  assert.strictEqual(detail.status, 'geannuleerd');
  assert.strictEqual(detail.pay.status, 'betaald');
  assert.strictEqual(detail.pay.refundNeeded, true);
});

test('de lijst in Beheer toont de betaalstatus', async () => {
  const world = await setup({ mollie: true });
  const [customer, other] = world.shoppers;
  await placeOnline(world, customer);
  await order(world, other, { paymentMethod: 'rekening' });
  const list = (await world.admin.get('/api/admin/web-orders')).body.items;
  assert.deepStrictEqual(list.map((item) => item.payStatus).sort((left, right) => String(left).localeCompare(String(right))), [null, 'open']);
});

test('een betaling met een afwijkend bedrag geldt niet als betaald, ook niet via de betaalpagina', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const { id, paymentId } = await placeOnline(world, customer);
  world.mollie.set(paymentId, 'paid', { amount: { currency: 'EUR', value: '1.00' } });
  const again = await createClient(world.base, { jar: customer.client.jar, followRedirects: false }).get(`/winkel/bestelling/${id}/betalen/`);
  assert.notStrictEqual(again.status, 302);
  const detail = (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order;
  assert.strictEqual(detail.pay.status, 'open');
});

test('zonder Mollie-sleutel blijft een onbetaalde online bestelling staan in plaats van te vervallen', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const { id } = await placeOnline(world, customer);
  await world.admin.put('/api/admin/settings', { mollieApiKey: '' });
  world.db.prepare('UPDATE web_orders SET created_at = ?').run(new Date(Date.now() - 25 * 3600 * 1000).toISOString());
  assert.deepStrictEqual(await world.app.locals.webPaymentsExpire(), { expired: 0 });
  const detail = (await world.admin.get(`/api/admin/web-orders/${id}`)).body.order;
  assert.strictEqual(detail.status, 'nieuw');
});
