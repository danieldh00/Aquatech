// Tests bij de auditpunten van 1.33.0 voor online betalen in de webshop: de korte voorraadreservering van een onbetaalde
// bestelling (B-13), betaald na vervallen (T-08), stappen na de betaling opnieuw proberen (T-16), een dubbele betaling (T-17),
// terugbetalen in drie stappen (T-18) en de webhook bij een uitgezette webshop (T-20).
const test = require('node:test');
const assert = require('node:assert');
const { setup, order, mailsWith, PERSON } = require('./helpers/webshop-world');
const { createClient, postForm, postCheckout } = require('./helpers/http-client');
const { createWebPayments, REFUND_PENDING, HOOK_MAX_TRIES } = require('../src/webshop/web-payments');
const { MollieError } = require('../src/webshop/mollie');

/**
 * Plaatst een online bestelling en opent de betaalpagina.
 * @param {object} world Het resultaat van setup({ mollie: true }).
 * @param {object} shopper De klant.
 * @returns {Promise<{ id: string, paymentId: string }>} Het bestel-id en het betaling-id.
 */
async function placeOnline(world, shopper) {
  const id = await order(world, shopper, { paymentMethod: 'online' });
  const pay = await createClient(world.base, { jar: shopper.client.jar, followRedirects: false }).get(`/bestelling/${id}/betalen/`);
  assert.strictEqual(pay.status, 302);
  return { id, paymentId: (await world.admin.get(`/app/api/admin/web-orders/${id}`)).body.order.pay.id };
}

/**
 * De bestelling zoals Beheer hem ziet.
 * @param {object} world De testopzet.
 * @param {string} id Het bestel-id.
 * @returns {Promise<object>} De bestelling.
 */
const adminOrder = async (world, id) => (await world.admin.get(`/app/api/admin/web-orders/${id}`)).body.order;

/**
 * Laat Mollie de webhook voor een betaling aanroepen.
 * @param {object} world De testopzet.
 * @param {string} orderId Het bestel-id.
 * @param {string} paymentId Het betaling-id.
 * @returns {Promise<{ status: number }>} Het antwoord.
 */
const webhook = (world, orderId, paymentId) => postForm(world.base, createClient(world.base), `/mollie/webhook/${orderId}/`, { id: paymentId });

/**
 * Doet alsof de korte betaaltijd van een bestelling voorbij is (data.stockHoldUntil een uur geleden).
 * @param {object} world De testopzet.
 * @param {string} orderId Het bestel-id.
 * @returns {void}
 */
const holdExpired = (world, orderId) => {
  const row = world.db.prepare('SELECT data FROM web_orders WHERE id = ?').get(orderId);
  const data = JSON.parse(row.data);
  data.stockHoldUntil = new Date(Date.now() - 3600 * 1000).toISOString();
  world.db.prepare('UPDATE web_orders SET data = ? WHERE id = ?').run(JSON.stringify(data), orderId);
};

/**
 * Het aantal gereserveerde stuks voor een bestelling.
 * @param {object} world De testopzet.
 * @param {string} orderId Het bestel-id.
 * @returns {number} De som van de reserveringen.
 */
const reservedFor = (world, orderId) => Number(world.db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM stock_reservations WHERE web_order_id = ?').get(orderId).n);

test('B-13: een onbetaalde online bestelling houdt de voorraad een half uur vast; betalen reserveert opnieuw', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const { id, paymentId } = await placeOnline(world, customer);
  const placed = await adminOrder(world, id);
  assert.ok(placed.stockHoldUntil, 'de korte betaaltijd is vastgelegd');
  assert.ok(Date.parse(placed.stockHoldUntil) - Date.now() <= 30 * 60 * 1000 + 1000);
  assert.ok(Date.parse(placed.reservedUntil) - Date.now() > 23 * 3600 * 1000, 'de bestelling zelf blijft de bewaartijd betaalbaar');
  assert.strictEqual(reservedFor(world, id), 2);
  await world.app.locals.webPaymentsExpire();
  assert.strictEqual(reservedFor(world, id), 2, 'binnen het half uur blijft de voorraad vast');
  holdExpired(world, id);
  assert.deepStrictEqual(await world.app.locals.webPaymentsExpire(), { expired: 0 });
  const released = await adminOrder(world, id);
  assert.strictEqual(released.status, 'nieuw', 'de bestelling blijft staan');
  assert.ok(released.reservationReleasedAt);
  assert.strictEqual(reservedFor(world, id), 0, 'de voorraad is weer vrij');
  // Naar de betaalpagina: de voorraad wordt opnieuw vastgelegd.
  const again = await createClient(world.base, { jar: customer.client.jar, followRedirects: false }).get(`/bestelling/${id}/betalen/`);
  assert.strictEqual(again.status, 302);
  assert.strictEqual(reservedFor(world, id), 2);
  assert.strictEqual((await adminOrder(world, id)).reservationReleasedAt, null);
  // Vrijgegeven en dan toch betaald (de betaalpagina stond nog open): opnieuw gereserveerd bij de betaling.
  holdExpired(world, id);
  await world.app.locals.webPaymentsExpire();
  assert.strictEqual(reservedFor(world, id), 0);
  world.mollie.set(paymentId, 'paid');
  await webhook(world, id, paymentId);
  const paid = await adminOrder(world, id);
  assert.strictEqual(paid.pay.status, 'betaald');
  assert.strictEqual(paid.reservationReleasedAt, null);
  assert.strictEqual(reservedFor(world, id), 2);
});

test('B-13: is de vrijgegeven voorraad intussen verkocht, dan kan betalen niet meer', async () => {
  const world = await setup({ mollie: true });
  const [customer, rival] = world.shoppers;
  const id = await order(world, customer, { paymentMethod: 'online' });
  holdExpired(world, id);
  await world.app.locals.webPaymentsExpire();
  // De ander koopt alles wat er nog ligt (50 stuks) op rekening.
  await postForm(world.base, rival.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '50' });
  assert.strictEqual((await postCheckout(world.base, rival.client, { ...PERSON, shippingMethod: 'ophalen', paymentMethod: 'rekening' })).status, 303);
  const pay = await createClient(world.base, { jar: customer.client.jar, followRedirects: false }).get(`/bestelling/${id}/betalen/`);
  assert.strictEqual(pay.status, 303);
  assert.strictEqual(pay.location, '../?betaalfout=2');
  assert.strictEqual(world.mollie.calls.filter((entry) => entry.method === 'POST').length, 0, 'er is geen betaling gestart');
  assert.match((await customer.client.get(`/bestelling/${id}/?betaalfout=2`)).text, /niet meer op voorraad/);
  assert.strictEqual(reservedFor(world, id), 0);
});

test('T-08: vervallen annuleert de betaling bij Mollie; een nieuwe betaling op een vervallen bestelling kan niet', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const { id, paymentId } = await placeOnline(world, customer);
  const row = world.db.prepare('SELECT data FROM web_orders WHERE id = ?').get(id);
  const data = JSON.parse(row.data);
  data.reservedUntil = new Date(Date.now() - 1000).toISOString();
  world.db.prepare('UPDATE web_orders SET data = ?, created_at = ? WHERE id = ?').run(JSON.stringify(data), new Date(Date.now() - 25 * 3600 * 1000).toISOString(), id);
  assert.deepStrictEqual(await world.app.locals.webPaymentsExpire(), { expired: 1 });
  assert.strictEqual(world.mollie.payments.get(paymentId).status, 'canceled', 'de betaalpagina is niet meer bruikbaar');
  const pay = await createClient(world.base, { jar: customer.client.jar, followRedirects: false }).get(`/bestelling/${id}/betalen/`);
  assert.strictEqual(pay.status, 303);
  assert.strictEqual(world.mollie.payments.size, 1, 'geen nieuwe betaling');
});

test('T-17: een tweede geslaagde betaling wordt vastgelegd en terugbetaald', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const { id, paymentId } = await placeOnline(world, customer);
  // De eerste poging mislukt, de klant start een tweede; daarna slagen ze allebei.
  world.mollie.set(paymentId, 'failed');
  await webhook(world, id, paymentId);
  await createClient(world.base, { jar: customer.client.jar, followRedirects: false }).get(`/bestelling/${id}/betalen/`);
  const second = (await adminOrder(world, id)).pay.id;
  assert.notStrictEqual(second, paymentId);
  world.mollie.set(second, 'paid');
  await webhook(world, id, second);
  world.mollie.set(paymentId, 'paid');
  await webhook(world, id, paymentId);
  const detail = await adminOrder(world, id);
  assert.strictEqual(detail.pay.paidId, second);
  assert.strictEqual(detail.pay.duplicates.length, 1);
  assert.strictEqual(detail.pay.duplicates[0].id, paymentId);
  assert.strictEqual(detail.pay.duplicates[0].amount, detail.totals.total);
  assert.match(detail.pay.duplicates[0].refund.id, /^re_/);
  assert.strictEqual(detail.pay.refundNeeded, false);
  const refundCall = world.mollie.calls.find((entry) => entry.method === 'POST' && entry.url.endsWith(`/payments/${paymentId}/refunds`));
  assert.ok(refundCall, 'de dubbele betaling zelf is terugbetaald');
  // Dezelfde melding nog een keer verandert niets.
  await webhook(world, id, paymentId);
  assert.strictEqual((await adminOrder(world, id)).pay.duplicates.length, 1);
  assert.strictEqual(world.mollie.calls.filter((entry) => entry.method === 'POST' && /\/refunds$/.test(entry.url)).length, 1);
  assert.strictEqual(mailsWith(world.sent, /Bevestiging van je bestelling/).length, 1, 'één bevestiging');
});

test('T-18: een terugbetaling waarvan het antwoord wegvalt blijft aangevraagd en wordt met Mollie afgestemd', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const { id, paymentId } = await placeOnline(world, customer);
  world.mollie.set(paymentId, 'paid');
  await webhook(world, id, paymentId);
  assert.strictEqual((await world.admin.post(`/app/api/admin/web-orders/${id}/status`, { status: 'geannuleerd' })).status, 200);
  world.mollie.lost.refunds = true;
  const lost = await world.admin.post(`/app/api/admin/web-orders/${id}/refund`, {});
  assert.strictEqual(lost.status, 502);
  assert.match(lost.body.message, /automatisch bij Mollie nagekeken/);
  world.mollie.lost.refunds = false;
  let pay = (await adminOrder(world, id)).pay;
  assert.strictEqual(pay.refunds.length, 1);
  assert.strictEqual(pay.refunds[0].status, REFUND_PENDING, 'de aanvraag staat vast, ook al kwam er geen antwoord');
  // De volgende ronde vindt hem bij Mollie en rondt af; er wordt niet nog een keer terugbetaald.
  await world.app.locals.webPaymentsExpire();
  pay = (await adminOrder(world, id)).pay;
  assert.match(pay.refunds[0].id, /^re_/);
  assert.notStrictEqual(pay.refunds[0].status, REFUND_PENDING);
  assert.strictEqual(pay.refundNeeded, false);
  assert.strictEqual((await world.admin.post(`/app/api/admin/web-orders/${id}/refund`, {})).status, 409);
  assert.strictEqual(world.mollie.calls.filter((entry) => entry.method === 'POST' && /\/refunds$/.test(entry.url)).length, 1);
});

test('T-18: weigert Mollie de terugbetaling, dan verdwijnt de aanvraag en kan het opnieuw', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const { id, paymentId } = await placeOnline(world, customer);
  world.mollie.set(paymentId, 'paid');
  await webhook(world, id, paymentId);
  assert.strictEqual((await world.admin.post(`/app/api/admin/web-orders/${id}/status`, { status: 'geannuleerd' })).status, 200);
  // Mollie weigert (de betaling staat daar niet meer op betaald).
  world.mollie.payments.get(paymentId).status = 'open';
  const refused = await world.admin.post(`/app/api/admin/web-orders/${id}/refund`, {});
  assert.strictEqual(refused.status, 502);
  assert.deepStrictEqual((await adminOrder(world, id)).pay.refunds, []);
  world.mollie.payments.get(paymentId).status = 'paid';
  assert.strictEqual((await world.admin.post(`/app/api/admin/web-orders/${id}/refund`, {})).status, 200);
});

test('T-20: de webhook van Mollie komt ook aan als de webshop uit staat', async () => {
  const world = await setup({ mollie: true });
  const [customer] = world.shoppers;
  const { id, paymentId } = await placeOnline(world, customer);
  assert.strictEqual((await world.admin.put('/app/api/admin/settings', { storefront: false })).status, 200);
  assert.strictEqual((await createClient(world.base).get('/winkelwagen/')).status, 404, 'de shop zelf is dicht');
  world.mollie.set(paymentId, 'paid');
  assert.strictEqual((await webhook(world, id, paymentId)).status, 200);
  assert.strictEqual((await adminOrder(world, id)).pay.status, 'betaald');
});

/**
 * Een bestelopslag in het geheugen met één online bestelling, voor de tests van de haken.
 * @param {object} [overrides] Velden van de bestelling die afwijken.
 * @returns {{ store: object, current: Function }} De nagebootste opslag en een functie die de bestelling van nu geeft.
 */
function memoryOrders(overrides = {}) {
  let record = { id: 'o1', number: 'W2026-0001', status: 'nieuw', payment: 'online', totals: { total: 30 }, pay: { status: 'open', id: 'tr_test0001', ids: ['tr_test0001'] }, ...overrides };
  /**
   * De bestelling van nu (een kopie).
   * @returns {object} De bestelling.
   */
  const get = () => JSON.parse(JSON.stringify(record));
  /**
   * Past de betaalgegevens aan zoals web-orders.js changePay.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de bestelling.
   * @param {Function} mutate Geeft de nieuwe betaalgegevens of null.
   * @returns {{ order: object, changed: boolean }} De bestelling en of er iets veranderde.
   */
  const changePay = (tenantId, id, mutate) => {
    const next = mutate(record.pay, record);
    if (!next) return { order: get(), changed: false };
    record = { ...record, pay: JSON.parse(JSON.stringify(next)) };
    return { order: get(), changed: true };
  };
  /**
   * De bestellingen met openstaande stappen: altijd deze ene.
   * @returns {string[]} De id's.
   */
  const paidWithOpenHooks = () => [record.id];
  /**
   * Een selectie die in deze tests leeg is.
   * @returns {string[]} Geen id's.
   */
  const none = () => [];
  /**
   * Het vrijgeven van voorraad doet hier niets.
   * @returns {{ released: number }} Niets vrijgegeven.
   */
  const releaseUnpaidHolds = () => ({ released: 0 });
  const store = { get, changePay, paidWithOpenHooks, withPendingRefunds: none, releaseUnpaidHolds, unpaidOnline: none };
  return { store, current: () => store.get(), set: (patch) => { record = { ...record, ...patch }; } };
}

/**
 * Instellingen met online betalen aan en een testsleutel.
 * @returns {{ get: Function }} De instellingen.
 */
const SETTINGS = () => ({ get: (name) => (name === 'mollieApiKey' ? 'test_abcdefghij1234567' : { online: true, publicUrl: 'https://winkel.example/' }) });
/** Een logger die niets doet. */
const QUIET = { warn: () => {}, error: () => {} };
/** Een betaalde Mollie-betaling die bij de bestelling uit memoryOrders hoort. */
const PAID = { id: 'tr_test0001', status: 'paid', amount: 30, orderId: 'o1', method: 'ideal', paidAt: '2026-11-01T10:00:00.000Z', amountRefunded: 0, amountChargedBack: 0 };

/**
 * Wacht tot de losgelaten haken zijn afgelopen.
 * @returns {Promise<void>}
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('T-16: een stap met een sleutel die mislukt wordt ingehaald; een gelukte stap loopt niet opnieuw', async () => {
  const orders = memoryOrders();
  const payments = createWebPayments({ orders: orders.store, mollie: { getPayment: async () => PAID }, settingsFor: SETTINGS, log: QUIET });
  const runs = { factuur: 0, bevestiging: 0, los: 0 };
  let mailWorks = false;
  payments.onPaid(() => { runs.los += 1; });
  payments.onPaid(() => { runs.factuur += 1; }, { key: 'factuur' });
  payments.onPaid(async () => { runs.bevestiging += 1; if (!mailWorks) throw new Error('Mailserver onbereikbaar'); }, { key: 'bevestiging' });
  const out = await payments.sync('t', 'o1');
  assert.strictEqual(out.becamePaid, true);
  await settle();
  let hooks = orders.current().pay.hooks;
  assert.deepStrictEqual(hooks.pending, ['bevestiging']);
  assert.ok(hooks.done.factuur);
  assert.strictEqual(hooks.tries.bevestiging, 1);
  // Direct daarna: nog te vroeg voor een nieuwe poging.
  assert.deepStrictEqual(await payments.catchUpPaid('t'), { retried: 0 });
  // Later (de vorige poging en de betaling zijn ouder dan tien minuten): alleen de mislukte stap opnieuw.
  orders.store.changePay('t', 'o1', (pay) => ({ ...pay, hooks: { ...pay.hooks, lastTryAt: '2026-11-01T10:00:00.000Z' } }));
  mailWorks = true;
  assert.deepStrictEqual(await payments.catchUpPaid('t'), { retried: 1 });
  hooks = orders.current().pay.hooks;
  assert.deepStrictEqual(hooks.pending, []);
  assert.ok(hooks.done.bevestiging);
  assert.deepStrictEqual(runs, { factuur: 1, bevestiging: 2, los: 1 });
  assert.deepStrictEqual(await payments.catchUpPaid('t'), { retried: 0 });
});

test('T-16: na de laatste poging stopt het inhalen en volgt een melding', async () => {
  const orders = memoryOrders();
  const payments = createWebPayments({ orders: orders.store, mollie: { getPayment: async () => PAID }, settingsFor: SETTINGS, log: QUIET });
  const failed = [];
  payments.onPaid(async () => { throw new Error('Mailserver onbereikbaar'); }, { key: 'bevestiging' });
  payments.onHookFailed((tenantId, order, key, message) => { failed.push({ number: order.number, key, message }); });
  await payments.sync('t', 'o1');
  await settle();
  for (let round = 1; round < HOOK_MAX_TRIES; round += 1) {
    orders.store.changePay('t', 'o1', (pay) => ({ ...pay, hooks: { ...pay.hooks, lastTryAt: '2026-11-01T10:00:00.000Z' } }));
    await payments.catchUpPaid('t');
  }
  await settle();
  const hooks = orders.current().pay.hooks;
  assert.strictEqual(hooks.tries.bevestiging, HOOK_MAX_TRIES);
  assert.deepStrictEqual(hooks.pending, []);
  assert.ok(hooks.failed.bevestiging);
  assert.deepStrictEqual(failed, [{ number: 'W2026-0001', key: 'bevestiging', message: 'Mailserver onbereikbaar' }]);
});

test('T-08: betaald na annuleren geeft geen betaalhaken maar een melding, en het bedrag gaat terug', async () => {
  const orders = memoryOrders({ status: 'geannuleerd', pay: { status: 'verlopen', id: 'tr_test0001', ids: ['tr_test0001'] } });
  const refunds = [];
  const mollie = { getPayment: async () => PAID, createRefund: async (apiKey, paymentId, refund) => { refunds.push({ paymentId, ...refund }); return { id: 're_test0001', status: 'pending', amount: refund.amount }; } };
  const payments = createWebPayments({ orders: orders.store, mollie, settingsFor: SETTINGS, log: QUIET });
  let confirmed = 0;
  const late = [];
  payments.onPaid(() => { confirmed += 1; }, { key: 'bevestiging' });
  payments.onLatePayment((tenantId, order, detail) => { late.push(detail); });
  await payments.sync('t', 'o1');
  await settle();
  assert.strictEqual(confirmed, 0);
  assert.deepStrictEqual(late, [{ reason: 'geannuleerd', paymentId: 'tr_test0001', amount: 30, refunded: true }]);
  assert.strictEqual(refunds.length, 1);
  assert.strictEqual(refunds[0].amount, 30);
  assert.strictEqual(refunds[0].key, 'annulering');
  const pay = orders.current().pay;
  assert.deepStrictEqual(pay.hooks.pending, [], 'geen stappen om in te halen');
  assert.strictEqual(pay.refundNeeded, false);
});

test('T-08: lukt automatisch terugbetalen niet, dan blijft terugbetalen nodig en meldt de haak dat', async () => {
  const orders = memoryOrders({ status: 'geannuleerd' });
  const mollie = { getPayment: async () => PAID, createRefund: async () => { throw new MollieError('Mollie weigert het verzoek: te weinig saldo', 422); } };
  const payments = createWebPayments({ orders: orders.store, mollie, settingsFor: SETTINGS, log: QUIET });
  const late = [];
  payments.onLatePayment((tenantId, order, detail) => { late.push(detail.refunded); });
  await payments.sync('t', 'o1');
  await settle();
  assert.deepStrictEqual(late, [false]);
  assert.strictEqual(orders.current().pay.refundNeeded, true);
  assert.deepStrictEqual(orders.current().pay.refunds, []);
});
