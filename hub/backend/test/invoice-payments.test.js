// Tests van een factuur online betalen in het klantportaal (Mollie): lijst en PDF van de eigen facturen, betaalstroom met webhook en
// terugkeer, een mislukte betaling, dat een factuur maar één keer op betaald gaat, de beveiliging van de webhook en de rechten.
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers/webshop-world');
const { createClient, postForm } = require('./helpers/http-client');

/**
 * Maakt een definitieve factuur van 121 euro voor een klant uit de shop.
 * @param {object} world Het resultaat van setup({ mollie: true }).
 * @param {number} shopperIndex Welke klant (0 of 1).
 * @returns {Promise<{ invoiceId: string, customerId: string }>} Het factuur-id en het id van de klant.
 */
async function finalInvoiceFor(world, shopperIndex = 0) {
  const customerId = world.db.prepare('SELECT id FROM users WHERE email = ?').get(`k${shopperIndex + 1}@voorbeeld.nl`).id;
  const created = await world.admin.post('/app/api/invoices', { data: { customer: { name: 'Klant', email: `k${shopperIndex + 1}@voorbeeld.nl` }, lines: [{ description: 'Sproeier', qty: 1, price: 100, vat: 21, group: 'producten' }] } });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  world.db.prepare('UPDATE invoices SET customer_id = ? WHERE id = ?').run(customerId, created.body.id);
  const finalized = await world.admin.post(`/app/api/invoices/${created.body.id}/finalize`, {});
  assert.strictEqual(finalized.status, 200, JSON.stringify(finalized.body));
  return { invoiceId: created.body.id, customerId };
}

/**
 * Laat Mollie de webhook voor een factuurbetaling aanroepen (zonder cookies, zoals Mollie zelf).
 * @param {object} world Het resultaat van setup.
 * @param {string} invoiceId Het factuur-id in het adres.
 * @param {string} paymentId Het betaling-id in de inhoud.
 * @returns {Promise<{ status: number }>} Het antwoord.
 */
const webhook = (world, invoiceId, paymentId) => postForm(world.base, createClient(world.base), `/app/api/public/invoice-payment/${invoiceId}/webhook`, { id: paymentId });

test('de klant ziet eigen definitieve facturen met knop Nu betalen, een ander niet', async () => {
  const world = await setup({ mollie: true });
  const { invoiceId } = await finalInvoiceFor(world, 0);
  const own = (await world.shoppers[0].client.get('/app/api/portal')).body;
  assert.deepStrictEqual(own.invoices.map((invoice) => [invoice.id, invoice.status, invoice.total, invoice.payable]), [[invoiceId, 'definitief', 121, true]]);
  assert.strictEqual(own.features.invoices, true);
  assert.deepStrictEqual((await world.shoppers[1].client.get('/app/api/portal')).body.invoices, []);
  assert.strictEqual((await world.shoppers[1].client.get(`/app/api/portal/invoices/${invoiceId}/pdf`)).status, 404);
  assert.strictEqual((await world.shoppers[1].client.post(`/app/api/portal/invoices/${invoiceId}/pay`, {})).status, 404);
  const pdf = await world.shoppers[0].client.get(`/app/api/portal/invoices/${invoiceId}/pdf`);
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual((await createClient(world.base).get('/app/api/portal')).status, 401, 'zonder inloggen geen portaal');
  assert.strictEqual((await createClient(world.base).get(`/app/api/portal/invoices/${invoiceId}/pdf`)).status, 401);
});

test('zonder recht portaal 403 en een webhook voor een onbekende factuur doet niets', async () => {
  const world = await setup({ mollie: true });
  assert.strictEqual((await world.vreemd.get('/app/api/portal')).status, 403, 'een beheerder van een andere organisatie heeft het portaal niet');
  assert.strictEqual((await world.vreemd.post('/app/api/portal/invoices/x/pay', {})).status, 403);
  assert.strictEqual((await webhook(world, 'bestaat-niet', 'tr_onbekend0001')).status, 200);
});

test('twee gelijktijdige klikken geven dezelfde betaalpagina', async () => {
  const world = await setup({ mollie: true });
  const { invoiceId } = await finalInvoiceFor(world, 0);
  const client = world.shoppers[0].client;
  const [first, second] = await Promise.all([client.post(`/app/api/portal/invoices/${invoiceId}/pay`, {}), client.post(`/app/api/portal/invoices/${invoiceId}/pay`, {})]);
  assert.deepStrictEqual([first.status, second.status], [200, 200]);
  assert.strictEqual(first.body.checkoutUrl, second.body.checkoutUrl);
  assert.strictEqual(world.mollie.payments.size, 1);
});

test('een concept of een creditfactuur staat niet in het portaal', async () => {
  const world = await setup({ mollie: true });
  const customerId = world.db.prepare('SELECT id FROM users WHERE email = ?').get('k1@voorbeeld.nl').id;
  const draft = (await world.admin.post('/app/api/invoices', { data: { customer: { name: 'Klant' }, lines: [{ description: 'Iets', qty: 1, price: 10 }] } })).body;
  world.db.prepare('UPDATE invoices SET customer_id = ? WHERE id = ?').run(customerId, draft.id);
  assert.deepStrictEqual((await world.shoppers[0].client.get('/app/api/portal')).body.invoices, []);
  assert.strictEqual((await world.shoppers[0].client.get(`/app/api/portal/invoices/${draft.id}/pdf`)).status, 404);
});

test('betalen: betaalpagina, webhook zet de factuur op betaald, een tweede melding doet niets', async () => {
  const world = await setup({ mollie: true });
  const { invoiceId } = await finalInvoiceFor(world, 0);
  const client = world.shoppers[0].client;
  const started = await client.post(`/app/api/portal/invoices/${invoiceId}/pay`, {});
  assert.strictEqual(started.status, 200, JSON.stringify(started.body));
  assert.match(started.body.checkoutUrl, /^https:\/\/www\.mollie\.com\/checkout\//);
  const [paymentId] = [...world.mollie.payments.keys()].slice(-1);
  const payment = world.mollie.payments.get(paymentId);
  assert.strictEqual(payment.amount.value, '121.00');
  assert.strictEqual(payment.metadata.invoiceId, invoiceId);
  assert.strictEqual(payment.webhookUrl, `https://winkel.example/app/api/public/invoice-payment/${invoiceId}/webhook`);
  assert.strictEqual(payment.redirectUrl, `https://winkel.example/app/portaal/?betaald=${invoiceId}`);
  // Tweede klik: dezelfde betaalpagina, geen tweede betaling.
  assert.strictEqual((await client.post(`/app/api/portal/invoices/${invoiceId}/pay`, {})).body.checkoutUrl, started.body.checkoutUrl);
  assert.strictEqual(world.mollie.payments.size, 1);
  // Betaald bij Mollie, webhook.
  world.mollie.set(paymentId, 'paid');
  assert.strictEqual((await webhook(world, invoiceId, paymentId)).status, 200);
  const invoice = (await world.admin.get(`/app/api/invoices/${invoiceId}`)).body;
  assert.strictEqual(invoice.status, 'betaald');
  assert.ok(invoice.paidAt);
  assert.strictEqual((await webhook(world, invoiceId, paymentId)).status, 200);
  const audits = world.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'factuur_betaald_online'").get();
  assert.strictEqual(Number(audits.n), 1, 'één auditregel, ook na een tweede webhook');
  // De klant ziet hem als betaald en kan niet opnieuw betalen.
  const listed = (await client.get('/app/api/portal')).body.invoices[0];
  assert.deepStrictEqual([listed.status, listed.payable], ['betaald', false]);
  assert.deepStrictEqual((await client.post(`/app/api/portal/invoices/${invoiceId}/pay`, {})).body, { paid: true });
  // Openstaand in de debiteuren: de factuur telt niet meer als open.
  const open = (await world.admin.get('/app/api/invoices?status=definitief')).body.items.filter((item) => item.id === invoiceId);
  assert.deepStrictEqual(open, []);
});

test('terug van de betaalpagina: de uitkomst wordt bij Mollie opgevraagd zonder webhook', async () => {
  const world = await setup({ mollie: true });
  const { invoiceId } = await finalInvoiceFor(world, 0);
  const client = world.shoppers[0].client;
  await client.post(`/app/api/portal/invoices/${invoiceId}/pay`, {});
  const [paymentId] = [...world.mollie.payments.keys()];
  assert.strictEqual((await client.post(`/app/api/portal/invoices/${invoiceId}/check`, {})).body.status, 'definitief', 'nog niet betaald');
  world.mollie.set(paymentId, 'paid');
  assert.strictEqual((await client.post(`/app/api/portal/invoices/${invoiceId}/check`, {})).body.status, 'betaald');
});

test('een mislukte betaling laat de factuur open en de klant kan opnieuw betalen', async () => {
  const world = await setup({ mollie: true });
  const { invoiceId } = await finalInvoiceFor(world, 0);
  const client = world.shoppers[0].client;
  await client.post(`/app/api/portal/invoices/${invoiceId}/pay`, {});
  const [first] = [...world.mollie.payments.keys()];
  world.mollie.set(first, 'canceled');
  await webhook(world, invoiceId, first);
  assert.strictEqual((await world.admin.get(`/app/api/invoices/${invoiceId}`)).body.status, 'definitief');
  const again = await client.post(`/app/api/portal/invoices/${invoiceId}/pay`, {});
  assert.strictEqual(again.status, 200);
  assert.strictEqual(world.mollie.payments.size, 2, 'een nieuwe poging');
  assert.notStrictEqual(again.body.checkoutUrl, `https://www.mollie.com/checkout/select-method/${first}`);
});

test('de webhook vertrouwt alleen Mollie: onbekend id, andere factuur of afwijkend bedrag doet niets', async () => {
  const world = await setup({ mollie: true });
  const one = await finalInvoiceFor(world, 0);
  const two = await finalInvoiceFor(world, 1);
  await world.shoppers[0].client.post(`/app/api/portal/invoices/${one.invoiceId}/pay`, {});
  const [paymentId] = [...world.mollie.payments.keys()];
  world.mollie.set(paymentId, 'paid');
  assert.strictEqual((await webhook(world, two.invoiceId, paymentId)).status, 200);
  assert.strictEqual((await webhook(world, one.invoiceId, 'tr_onbekend0001')).status, 200);
  assert.strictEqual((await webhook(world, one.invoiceId, 'geen-id')).status, 200);
  assert.strictEqual((await world.admin.get(`/app/api/invoices/${two.invoiceId}`)).body.status, 'definitief', 'andere factuur blijft open');
  assert.strictEqual((await world.admin.get(`/app/api/invoices/${one.invoiceId}`)).body.status, 'definitief', 'onbekend id telt niet');
  // Afwijkend bedrag bij Mollie: genegeerd.
  world.mollie.payments.get(paymentId).amount.value = '1.00';
  await webhook(world, one.invoiceId, paymentId);
  assert.strictEqual((await world.admin.get(`/app/api/invoices/${one.invoiceId}`)).body.status, 'definitief');
});

test('zonder online betalen staat er geen knop en weigert de server', async () => {
  const world = await setup({ mollie: true });
  const { invoiceId } = await finalInvoiceFor(world, 0);
  await world.admin.put('/app/api/admin/settings', { shopPayment: { online: false, publicUrl: 'https://winkel.example/' } });
  const listed = (await world.shoppers[0].client.get('/app/api/portal')).body.invoices[0];
  assert.strictEqual(listed.payable, false);
  assert.strictEqual((await world.shoppers[0].client.post(`/app/api/portal/invoices/${invoiceId}/pay`, {})).status, 409);
});

test('Mollie onbereikbaar: nette melding en de factuur blijft open', async () => {
  const world = await setup({ mollie: true });
  const { invoiceId } = await finalInvoiceFor(world, 0);
  world.mollie.down.on = true;
  const out = await world.shoppers[0].client.post(`/app/api/portal/invoices/${invoiceId}/pay`, {});
  assert.strictEqual(out.status, 502);
  assert.match(out.body.message, /niet bereikbaar/);
  world.mollie.down.on = false;
  assert.strictEqual((await world.shoppers[0].client.post(`/app/api/portal/invoices/${invoiceId}/pay`, {})).status, 200);
});

test('valt de verwerking halverwege weg, dan herstelt de volgende melding de factuur', async () => {
  const { createInvoicePayments } = require('../src/verkoop/invoice-payments');
  const { createMollieFake } = require('./helpers/mollie-fake');
  const { openDb } = require('../src/database/db');
  const { createStore } = require('../src/platform/store');
  const { createMollie } = require('../src/webshop/mollie');
  const db = openDb();
  const tenantId = createStore(db).ensureTenant().id;
  const invoice = { id: 'inv-1', number: 'F1', status: 'definitief', kind: 'factuur', total: 50, customerId: 'c1' };
  let failOnce = true;
  let paidCalls = 0;
  const invoices = {
    /**
     * De factuur.
     * @returns {object} Een kopie.
     */
    get: () => ({ ...invoice }),
    /**
     * Zet de factuur op betaald; faalt de eerste keer.
     * @returns {{ invoice: object }} De factuur.
     */
    setPaid: () => {
      if (failOnce) { failOnce = false; throw new Error('databasefout'); }
      paidCalls += 1; invoice.status = 'betaald';
      return { invoice: { ...invoice } };
    },
  };
  const fake = createMollieFake();
  /**
   * Instellingen met online betalen aan.
   * @returns {{ get: Function }} De instellingen.
   */
  const settingsFor = () => ({ get: (name) => (name === 'mollieApiKey' ? 'test_abcdefghij1234567' : { online: true, publicUrl: 'https://winkel.example/' }) });
  const payments = createInvoicePayments({ db, invoices, mollie: createMollie({ fetchImpl: fake.fetchImpl }), settingsFor, log: { warn() {} } });
  const started = await payments.start(tenantId, invoice);
  assert.ok(started.checkoutUrl);
  const [paymentId] = [...fake.payments.keys()];
  fake.set(paymentId, 'paid');
  await assert.rejects(payments.sync(tenantId, 'inv-1', { paymentId }), /databasefout/);
  assert.strictEqual(invoice.status, 'definitief');
  const retry = await payments.sync(tenantId, 'inv-1', { paymentId });
  assert.strictEqual(retry.becamePaid, true);
  assert.strictEqual(invoice.status, 'betaald');
  assert.strictEqual((await payments.sync(tenantId, 'inv-1', { paymentId })).becamePaid, false);
  assert.strictEqual(paidCalls, 1);
});

test('opnieuw klikken op Nu betalen na een halverwege weggevallen verwerking maakt geen tweede betaling', async () => {
  const { createInvoicePayments } = require('../src/verkoop/invoice-payments');
  const { createMollieFake } = require('./helpers/mollie-fake');
  const { openDb } = require('../src/database/db');
  const { createStore } = require('../src/platform/store');
  const { createMollie } = require('../src/webshop/mollie');
  const db = openDb();
  const tenantId = createStore(db).ensureTenant().id;
  const invoice = { id: 'inv-2', number: 'F2', status: 'definitief', kind: 'factuur', total: 50, customerId: 'c1' };
  let failOnce = true;
  const invoices = {
    /**
     * De factuur.
     * @returns {object} Een kopie.
     */
    get: () => ({ ...invoice }),
    /**
     * Zet de factuur op betaald; faalt de eerste keer.
     * @returns {{ invoice: object }} De factuur.
     */
    setPaid: () => {
      if (failOnce) { failOnce = false; throw new Error('databasefout'); }
      invoice.status = 'betaald';
      return { invoice: { ...invoice } };
    },
  };
  const fake = createMollieFake();
  /**
   * Instellingen met online betalen aan.
   * @returns {{ get: Function }} De instellingen.
   */
  const settingsFor = () => ({ get: (name) => (name === 'mollieApiKey' ? 'test_abcdefghij1234567' : { online: true, publicUrl: 'https://winkel.example/' }) });
  const payments = createInvoicePayments({ db, invoices, mollie: createMollie({ fetchImpl: fake.fetchImpl }), settingsFor, log: { warn() {} } });
  await payments.start(tenantId, invoice);
  const [paymentId] = [...fake.payments.keys()];
  fake.set(paymentId, 'paid');
  await assert.rejects(payments.sync(tenantId, 'inv-2', { paymentId }), /databasefout/);
  const again = await payments.start(tenantId, invoice);
  assert.deepStrictEqual(again, { paid: true });
  assert.strictEqual(invoice.status, 'betaald');
  assert.strictEqual(fake.payments.size, 1, 'geen tweede betaling bij Mollie');
});

/**
 * Haalt de betaallink uit het mailvoorstel van een factuur.
 * @param {object} world Het resultaat van setup.
 * @param {string} invoiceId Het factuur-id.
 * @returns {Promise<{ link: string, message: string }>} De link als pad op de testserver (leeg zonder link) en de mailtekst.
 */
async function mailLinkOf(world, invoiceId) {
  const draft = (await world.admin.get(`/app/api/invoices/${invoiceId}/mail`)).body;
  const match = /https:\/\/winkel\.example(\/app\/api\/public\/invoice-pay\/[^\s]+)/.exec(draft.message);
  return { link: match ? match[1] : '', message: draft.message };
}

test('de factuurmail bevat een betaallink; klikken gaat naar Mollie, terugkeer toont de uitkomst', async () => {
  const world = await setup({ mollie: true });
  const { invoiceId } = await finalInvoiceFor(world, 0);
  const { link, message } = await mailLinkOf(world, invoiceId);
  assert.ok(link, message);
  assert.match(message, /direct online betalen/);
  const anonymous = createClient(world.base, { followRedirects: false });
  const clicked = await anonymous.get(link);
  assert.strictEqual(clicked.status, 302);
  assert.match(clicked.location, /^https:\/\/www\.mollie\.com\/checkout\//);
  const [paymentId] = [...world.mollie.payments.keys()];
  assert.strictEqual(world.mollie.payments.get(paymentId).redirectUrl, `https://winkel.example${link}?teruggekeerd=1`);
  assert.strictEqual((await anonymous.get(link)).location, clicked.location, 'nogmaals klikken geeft dezelfde betaalpagina');
  assert.strictEqual(world.mollie.payments.size, 1);
  // Terug zonder betaling, daarna betaald.
  assert.match((await anonymous.get(`${link}?teruggekeerd=1`)).text, /nog niet bevestigd/);
  world.mollie.set(paymentId, 'paid');
  assert.match((await anonymous.get(`${link}?teruggekeerd=1`)).text, /Bedankt, uw betaling is ontvangen/);
  assert.strictEqual((await world.admin.get(`/app/api/invoices/${invoiceId}`)).body.status, 'betaald');
  assert.match((await anonymous.get(link)).text, /al betaald/);
  assert.strictEqual((await mailLinkOf(world, invoiceId)).link, '', 'een betaalde factuur krijgt geen link meer');
});

test('een betaallink met een onjuiste handtekening of van een andere factuur werkt niet', async () => {
  const world = await setup({ mollie: true });
  const one = await finalInvoiceFor(world, 0);
  const two = await finalInvoiceFor(world, 1);
  const { link } = await mailLinkOf(world, one.invoiceId);
  const anonymous = createClient(world.base, { followRedirects: false });
  const parts = link.split('/');
  const signature = parts.pop();
  assert.strictEqual((await anonymous.get(`${parts.join('/')}/${'A'.repeat(32)}`)).status, 404);
  assert.strictEqual((await anonymous.get(`${parts.join('/')}/kort`)).status, 404);
  const other = parts.slice(0, -1).concat(two.invoiceId, signature).join('/');
  assert.strictEqual((await anonymous.get(other)).status, 404, 'handtekening van een andere factuur');
  assert.strictEqual(world.mollie.payments.size, 0, 'er is niets bij Mollie aangemaakt');
});

test('zonder online betalen staat er geen betaallink in de mail', async () => {
  const world = await setup({ mollie: true });
  const { invoiceId } = await finalInvoiceFor(world, 0);
  await world.admin.put('/app/api/admin/settings', { shopPayment: { online: false, publicUrl: 'https://winkel.example/' } });
  assert.strictEqual((await mailLinkOf(world, invoiceId)).link, '');
});

test('de meldingspagina van de betaallink escapet titel en tekst', () => {
  const { messagePage } = require('../src/verkoop/invoice-pay-routes');
  const html = messagePage('Factuur <b>1</b>', '<script>alert(1)</script> & "x"');
  assert.ok(!html.includes('<script>') && !html.includes('<b>'));
  assert.ok(html.includes('&lt;script&gt;') && html.includes('&amp;'));
});
