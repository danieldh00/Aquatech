// Betalingsherinnering in de eigen webshop: één mail na een uur bij een online bestelling die niet betaald is (of mislukte), met een
// link om af te rekenen, alleen zolang de reservering loopt, nooit twee keer, en uit te zetten in Beheer.
const test = require('node:test');
const assert = require('node:assert');
const { setup, order, mailsWith, PERSON } = require('./helpers/webshop-world');
const { createClient, postForm, postCheckout } = require('./helpers/http-client');

const SUBJECT = /wacht nog op betaling/;

/**
 * Plaatst een online bestelling (de betaling wordt wel gestart, maar niet afgerond) en geeft het id en het Mollie-id.
 * @param {object} world De testopzet (setup({ mollie: true })).
 * @param {object} shopper De klant.
 * @returns {Promise<{ id: string, paymentId: string }>} Het bestel-id en het betaling-id.
 */
async function placeOpen(world, shopper) {
  const id = await order(world, shopper, { paymentMethod: 'online' });
  const pay = await createClient(world.base, { jar: shopper.client.jar, followRedirects: false }).get(`/bestelling/${id}/betalen/`);
  assert.strictEqual(pay.status, 302);
  const detail = (await world.admin.get(`/app/api/admin/web-orders/${id}`)).body.order;
  return { id, paymentId: detail.pay.id };
}

/**
 * Zet een bestelling terug in de tijd (aanmaakmoment en reserveringstermijn schuiven mee).
 * @param {object} world De testopzet.
 * @param {string} orderId Het bestel-id.
 * @param {number} hours Hoeveel uur geleden de bestelling geplaatst is.
 * @returns {void}
 */
function backdate(world, orderId, hours) {
  const row = world.db.prepare('SELECT created_at, data FROM web_orders WHERE id = ?').get(orderId);
  const createdAt = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const data = JSON.parse(row.data);
  if (data.reservedUntil) data.reservedUntil = new Date(Date.parse(createdAt) + (Date.parse(data.reservedUntil) - Date.parse(row.created_at))).toISOString();
  world.db.prepare('UPDATE web_orders SET created_at = ?, data = ? WHERE id = ?').run(createdAt, JSON.stringify(data), orderId);
}

test('herinnering na een uur: één mail met link en reserveringstijd, daarna nooit meer', async () => {
  const world = await setup({ mollie: true });
  const [shopper] = world.shoppers;
  const { id } = await placeOpen(world, shopper);
  assert.deepStrictEqual(await world.app.locals.webPaymentsRemind(), { sent: 0 }, 'binnen het uur nog niets');
  backdate(world, id, 2);
  assert.deepStrictEqual(await world.app.locals.webPaymentsRemind(), { sent: 1 });
  const mails = mailsWith(world.sent, SUBJECT);
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'k1@voorbeeld.nl');
  assert.match(mails[0].text, new RegExp(`https://winkel\\.example/bestelling/${id}/`));
  assert.match(mails[0].text, /gereserveerd tot/);
  assert.match(mails[0].text, /nog niet afgerond/);
  assert.match(mails[0].text, /één keer/);
  assert.strictEqual(JSON.parse(world.db.prepare('SELECT data FROM web_orders WHERE id = ?').get(id).data).pay.reminderAt.length > 10, true);
  assert.deepStrictEqual(await world.app.locals.webPaymentsRemind(), { sent: 0 }, 'nooit twee keer');
  assert.strictEqual(mailsWith(world.sent, SUBJECT).length, 1);
});

test('geen herinnering voor een betaalde bestelling, een verlopen reservering of als het is uitgezet', async () => {
  const world = await setup({ mollie: true });
  const [first, second] = world.shoppers;
  const paid = await placeOpen(world, first);
  world.mollie.set(paid.paymentId, 'paid');
  backdate(world, paid.id, 2);
  assert.deepStrictEqual(await world.app.locals.webPaymentsRemind(), { sent: 0 }, 'bleek bij Mollie betaald');
  const expired = await placeOpen(world, second);
  backdate(world, expired.id, 30);
  assert.deepStrictEqual(await world.app.locals.webPaymentsRemind(), { sent: 0 }, 'reservering van 24 uur is voorbij');
  const open = await placeOpen(world, second);
  backdate(world, open.id, 2);
  const off = await world.admin.put('/app/api/admin/settings', { shopPayment: { online: true, publicUrl: 'https://winkel.example/', onAccount: 'iedereen', holdHours: 24, paymentReminder: false } });
  assert.strictEqual(off.status, 200, JSON.stringify(off.body));
  assert.deepStrictEqual(await world.app.locals.webPaymentsRemind(), { sent: 0 }, 'uitgezet in Beheer');
  assert.strictEqual(mailsWith(world.sent, SUBJECT).length, 0);
  await world.admin.put('/app/api/admin/settings', { shopPayment: { online: true, publicUrl: 'https://winkel.example/', onAccount: 'iedereen', holdHours: 24, paymentReminder: true } });
  assert.deepStrictEqual(await world.app.locals.webPaymentsRemind(), { sent: 1 }, 'weer aan: alleen de open bestelling');
});

test('een mail die niet lukt wordt de volgende ronde opnieuw geprobeerd; een mislukte betaling krijgt een eigen tekst', async () => {
  const world = await setup({ mollie: true });
  const [shopper] = world.shoppers;
  const { id, paymentId } = await placeOpen(world, shopper);
  world.mollie.set(paymentId, 'failed');
  backdate(world, id, 2);
  world.mailFailing.on = true;
  assert.deepStrictEqual(await world.app.locals.webPaymentsRemind(), { sent: 0 });
  assert.strictEqual(JSON.parse(world.db.prepare('SELECT data FROM web_orders WHERE id = ?').get(id).data).pay.reminderAt, undefined, 'niet als verstuurd vastgelegd');
  world.mailFailing.on = false;
  assert.deepStrictEqual(await world.app.locals.webPaymentsRemind(), { sent: 1 });
  assert.match(mailsWith(world.sent, SUBJECT)[0].text, /niet gelukt/);
});

test('een gastbestelling krijgt de persoonlijke link, zonder webadres in Beheer gaat er niets uit', async () => {
  const world = await setup({ mollie: true });
  const client = createClient(world.base);
  await postForm(world.base, client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '1' });
  const placed = await postCheckout(world.base, client, { ...PERSON, guest: 'ja', paymentMethod: 'online' });
  assert.strictEqual(placed.status, 303, placed.text);
  const id = /\/bestelling\/([0-9a-f-]{36})\//.exec(placed.location)[1];
  backdate(world, id, 2);
  assert.deepStrictEqual(await world.app.locals.webPaymentsRemind(), { sent: 1 });
  const mail = mailsWith(world.sent, SUBJECT)[0];
  assert.match(mail.text, new RegExp(`https://winkel\\.example/bestelling/${id}/\\?k=`));
  assert.strictEqual(mail.to, PERSON.email);
});
