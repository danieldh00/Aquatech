// Retouren van webshopbestellingen: aanvragen door de klant binnen de termijn,
// goedkeuren of afwijzen, afronden met voorraad terug en een creditnota, de
// mails daarbij en de rechten en tenantgrenzen.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createWebReturnStore, RETURN_DAYS } = require('../src/webshop/web-returns');
const { createWebOrderInvoices } = require('../src/verkoop/web-order-invoices');
const { postForm } = require('./helpers/http-client');
const { setup, order, until, mailsWith } = require('./helpers/webshop-world');

/**
 * Bestelt twee sproeiers als de eerste klant en zet de bestelling op Verzonden.
 * @param {object} world Het resultaat van setup.
 * @returns {Promise<string>} Id van de bestelling.
 */
async function shippedOrder(world) {
  const id = await order(world, world.shoppers[0]);
  assert.strictEqual((await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' })).status, 200);
  return id;
}

/**
 * Vraagt als de eerste klant een retour aan.
 * @param {object} world Het resultaat van setup.
 * @param {string} id Id van de bestelling.
 * @param {object} fields De velden van het formulier (qty:BUS, reason, note).
 * @returns {Promise<object>} Het antwoord (status, location, text).
 */
const requestReturn = (world, id, fields) => postForm(world.base, world.shoppers[0].client, `/winkel/bestelling/${id}/retour`, fields);

/**
 * Het voorraadartikel BUS uit de voorraadlijst.
 * @param {object} admin Ingelogde beheerder.
 * @returns {Promise<object>} Het artikel.
 */
async function stockOf(admin) {
  return (await admin.get('/api/stock')).body.items.find((item) => item.code === 'BUS');
}

/**
 * De nieuwste retour uit Beheer.
 * @param {object} admin Ingelogde beheerder.
 * @returns {Promise<object>} De retour.
 */
async function latestReturn(admin) {
  return (await admin.get('/api/admin/web-returns')).body.items[0];
}

test('retour van aanvraag tot creditnota: mails, voorraad terug en creditregel', async () => {
  const world = await setup();
  const [customer, other] = world.shoppers;
  const id = await shippedOrder(world);
  assert.strictEqual((await stockOf(world.admin)).onHand, 48);
  const page = await customer.client.get(`/winkel/bestelling/${id}/`);
  assert.match(page.text, /Retourneren/);
  assert.match(page.text, /name="qty:BUS"/);

  const tooMany = await requestReturn(world, id, { 'qty:BUS': '3', reason: 'defect' });
  assert.strictEqual(tooMany.status, 409);
  assert.match(tooMany.text, /kunnen nog 2 terug/);
  assert.strictEqual((await requestReturn(world, id, { 'qty:BUS': '1', reason: '' })).status, 400, 'reden is verplicht');
  assert.strictEqual((await requestReturn(world, id, { 'qty:BUS': '0', reason: 'defect' })).status, 400, 'minstens één artikel');
  const asked = await requestReturn(world, id, { 'qty:BUS': '1', reason: 'defect', note: 'Kapot bij uitpakken' });
  assert.strictEqual(asked.status, 303);
  assert.strictEqual(asked.location, './');
  const [confirmation] = await until(() => { const found = mailsWith(world.sent, /We hebben je retour .* ontvangen/); return found.length ? found : null; });
  assert.strictEqual(confirmation.to, 'els@bakker.example');
  assert.match(confirmation.text, /1 × Sproeier \(BUS\)/);
  assert.match((await customer.client.get(`/winkel/bestelling/${id}/`)).text, /Aangevraagd/);
  assert.match((await requestReturn(world, id, { 'qty:BUS': '2', reason: 'defect' })).text, /kunnen nog 1 terug/, 'wat al in een retour zit telt mee');

  assert.strictEqual((await requestReturn(world, id, { 'qty:BUS': '1', reason: 'anders' })).status, 303, 'het laatste stuk kan nog');
  const foreign = await postForm(world.base, other.client, `/winkel/bestelling/${id}/retour`, { 'qty:BUS': '1', reason: 'anders' });
  assert.strictEqual(foreign.status, 404, 'een andere klant kan geen retour op deze bestelling');

  const list = (await world.admin.get('/api/admin/web-returns')).body;
  assert.strictEqual(list.total, 2);
  const record = list.items.find((item) => item.note === 'Kapot bij uitpakken');
  assert.strictEqual(record.status, 'aangevraagd');
  assert.strictEqual((await world.vreemd.get(`/api/admin/web-returns/${record.id}`)).status, 404, 'andere organisatie');
  assert.strictEqual((await customer.client.get('/api/admin/web-returns')).status, 403, 'klant heeft geen beheerrecht');
  for (const action of ['decision', 'complete', 'credit']) {
    assert.strictEqual((await world.vreemd.post(`/api/admin/web-returns/${record.id}/${action}`, { approve: true })).status, 404, `andere organisatie: ${action}`);
    assert.strictEqual((await customer.client.post(`/api/admin/web-returns/${record.id}/${action}`, { approve: true })).status, 403, `klant heeft geen beheerrecht: ${action}`);
  }
  assert.strictEqual((await world.admin.get(`/api/admin/web-returns/${record.id}`)).body.return.status, 'aangevraagd', 'status ongewijzigd');

  assert.strictEqual((await world.admin.post(`/api/admin/web-returns/${record.id}/complete`, {})).status, 409, 'eerst goedkeuren');
  assert.strictEqual((await world.admin.post(`/api/admin/web-returns/${record.id}/decision`, { approve: false })).status, 400, 'afwijzen vraagt een reden');
  const approved = await world.admin.post(`/api/admin/web-returns/${record.id}/decision`, { approve: true, note: 'Graag in de originele verpakking.' });
  assert.strictEqual(approved.status, 200);
  assert.strictEqual(approved.body.return.status, 'goedgekeurd');
  const [approval] = await until(() => { const found = mailsWith(world.sent, /is goedgekeurd/); return found.length ? found : null; });
  assert.match(approval.text, /originele verpakking/);

  const done = await world.admin.post(`/api/admin/web-returns/${record.id}/complete`, { restock: true });
  assert.strictEqual(done.status, 200);
  assert.strictEqual(done.body.return.status, 'afgerond');
  assert.strictEqual((await stockOf(world.admin)).onHand, 49, 'het artikel is teruggeboekt');
  assert.ok(done.body.credit.credit, JSON.stringify(done.body.credit));
  const credit = (await world.admin.get(`/api/invoices/${done.body.credit.credit.invoiceId}`)).body;
  assert.strictEqual(credit.kind, 'credit');
  assert.strictEqual(credit.status, 'definitief');
  assert.deepStrictEqual(credit.data.lines.map((line) => [line.code, line.qty]), [['BUS', -1]], 'alleen de teruggestuurde regel, zonder verzendkosten');
  assert.strictEqual(credit.total, -12.1, '10,00 excl. + 21% btw');
  assert.strictEqual((await stockOf(world.admin)).onHand, 49, 'de creditnota boekt de voorraad niet nog eens');
  assert.strictEqual((await world.admin.post(`/api/admin/web-returns/${record.id}/complete`, {})).status, 409, 'niet twee keer afronden');
  const [finished] = await until(() => { const found = mailsWith(world.sent, /is ontvangen en afgehandeld/); return found.length ? found : null; });
  assert.match(finished.text, new RegExp(credit.number));
  assert.strictEqual((await world.admin.post(`/api/admin/web-returns/${record.id}/credit`, {})).body.credit.existing, true, 'opnieuw vragen maakt geen tweede creditnota');
});

test('afwijzen met reden en intrekken door de klant', async () => {
  const world = await setup();
  const customer = world.shoppers[0];
  const id = await shippedOrder(world);
  assert.strictEqual((await requestReturn(world, id, { 'qty:BUS': '2', reason: 'niet_nodig' })).status, 303);
  const first = await latestReturn(world.admin);
  const rejected = await world.admin.post(`/api/admin/web-returns/${first.id}/decision`, { approve: false, note: 'Gebruikte artikelen nemen we niet terug.' });
  assert.strictEqual(rejected.body.return.status, 'afgewezen');
  const [mail] = await until(() => { const found = mailsWith(world.sent, /is afgewezen/); return found.length ? found : null; });
  assert.match(mail.text, /Gebruikte artikelen/);
  assert.match((await customer.client.get(`/winkel/bestelling/${id}/`)).text, /Gebruikte artikelen nemen we niet terug/);

  assert.strictEqual((await requestReturn(world, id, { 'qty:BUS': '2', reason: 'verkeerd' })).status, 303, 'na afwijzen kan het opnieuw');
  const second = await latestReturn(world.admin);
  const other = world.shoppers[1];
  const withdrawUrl = `/winkel/bestelling/${id}/retour/${second.id}/intrekken`;
  assert.strictEqual((await postForm(world.base, other.client, withdrawUrl, {})).status, 404, 'alleen de eigen retour');
  const withdrawn = await postForm(world.base, customer.client, withdrawUrl, {});
  assert.strictEqual(withdrawn.status, 303);
  assert.strictEqual(withdrawn.location, '../../');
  assert.strictEqual((await world.admin.get(`/api/admin/web-returns/${second.id}`)).body.return.status, 'ingetrokken');
  assert.strictEqual((await world.admin.post(`/api/admin/web-returns/${second.id}/decision`, { approve: true })).status, 409, 'een ingetrokken retour is klaar');
  assert.strictEqual((await requestReturn(world, id, { 'qty:BUS': '2', reason: 'verkeerd' })).status, 303, 'ingetrokken telt niet mee');
});

test('geen retour voor verzending, en zonder terugboeken blijft de voorraad staan', async () => {
  const world = await setup();
  const id = await order(world, world.shoppers[0]);
  const early = await requestReturn(world, id, { 'qty:BUS': '1', reason: 'defect' });
  assert.strictEqual(early.status, 409);
  assert.match(early.text, /pas als de bestelling is verzonden/);
  assert.strictEqual((await world.admin.post(`/api/admin/web-orders/${id}/status`, { status: 'verzonden' })).status, 200);
  assert.strictEqual((await requestReturn(world, id, { 'qty:BUS': '1', reason: 'defect' })).status, 303);
  const record = await latestReturn(world.admin);
  await world.admin.post(`/api/admin/web-returns/${record.id}/decision`, { approve: true });
  const done = await world.admin.post(`/api/admin/web-returns/${record.id}/complete`, { restock: false });
  assert.strictEqual(done.body.return.restock, false);
  assert.strictEqual((await stockOf(world.admin)).onHand, 48, 'beschadigd: niet terug op voorraad');
});

test('zonder facturen voor webshopbestellingen geen creditnota, met melding', async () => {
  const world = await setup();
  await world.admin.put('/api/invoices/settings', { webOrders: { enabled: false } });
  const id = await shippedOrder(world);
  await requestReturn(world, id, { 'qty:BUS': '1', reason: 'defect' });
  const record = await latestReturn(world.admin);
  await world.admin.post(`/api/admin/web-returns/${record.id}/decision`, { approve: true });
  const done = await world.admin.post(`/api/admin/web-returns/${record.id}/complete`, {});
  assert.strictEqual(done.status, 200);
  assert.match(done.body.credit.skipped, /staan uit/);
  assert.match(done.body.return.creditError, /staan uit/);
});

test('de termijn van 14 dagen na verzending', () => {
  const store = createWebReturnStore(openDb(), { orders: {}, stock: {} });
  /**
   * Het tijdstip van een aantal dagen geleden.
   * @param {number} days Aantal dagen.
   * @returns {string} ISO-tijdstip.
   */
  const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
  /**
   * Een verzonden bestelling die een aantal dagen geleden is verzonden.
   * @param {number} days Aantal dagen sinds verzending.
   * @returns {object} De bestelling met verloop.
   */
  const order = (days) => ({ id: 'x', status: 'verzonden', lines: [], history: [{ at: daysAgo(days + 1), status: 'nieuw' }, { at: daysAgo(days), status: 'verzonden' }] });
  assert.strictEqual(store.eligibility('t', order(RETURN_DAYS - 1)).open, true);
  assert.strictEqual(store.eligibility('t', order(RETURN_DAYS + 1)).open, false);
  assert.strictEqual(store.eligibility('t', { id: 'y', status: 'nieuw', lines: [], history: [] }).shipped, false);
});

test('mislukt definitief maken van de creditnota: een nieuwe poging maakt het concept af, geen tweede creditnota', async () => {
  const stored = new Map([['i1', { id: 'i1', number: 'F2026-0001', status: 'definitief', kind: 'factuur', customerId: 'c', debtorId: 'd', data: { customer: { name: 'Els' }, lines: [{ code: 'BUS', description: 'Sproeier', qty: 2, unit: 'st', price: 10, vat: 21, group: 'producten' }] } }]]);
  let created = 0;
  let finalizeCalls = 0;
  const invoices = {
    /**
     * De factuur van de bestelling.
     * @returns {Map<string, string>} Sleutel naar factuur-id.
     */
    byShopOrders: () => new Map([['web:o1', 'i1']]),
    /**
     * Een factuur uit het geheugen.
     * @param {string} tenantId Id van de omgeving.
     * @param {string} id Id van de factuur.
     * @returns {?object} De factuur, of null.
     */
    get: (tenantId, id) => stored.get(id) || null,
    /**
     * Maakt de creditfactuur als concept.
     * @returns {object} Het concept.
     */
    create: () => { created += 1; stored.set('c1', { id: 'c1', number: '', status: 'concept' }); return stored.get('c1'); },
    /**
     * Definitief maken: de eerste keer mislukt het, daarna lukt het.
     * @returns {object} De fout of de definitieve factuur.
     */
    finalize: () => {
      finalizeCalls += 1;
      if (finalizeCalls === 1) return { error: 'Boekhouding even niet bereikbaar.' };
      Object.assign(stored.get('c1'), { number: 'F2026-0002', status: 'definitief' });
      return { invoice: stored.get('c1') };
    },
  };
  const record = { id: 'r1', orderId: 'o1', number: 'WEB-1-R1', lines: [{ code: 'BUS', qty: 1 }], credit: null, creditError: '' };
  const returns = { get: () => ({ ...record }), updateData: (tenantId, id, patch) => Object.assign(record, patch) };
  const credits = createWebOrderInvoices({ orders: {}, invoices, returns, settingsFor: () => ({ get: () => undefined }) });
  const failed = await credits.creditReturn('t', 'r1', null);
  assert.match(failed.error, /Boekhouding even niet bereikbaar/);
  assert.strictEqual(record.credit.invoiceId, 'c1', 'het concept is vastgelegd');
  const retried = await credits.creditReturn('t', 'r1', null);
  assert.strictEqual(retried.credit.status, 'definitief');
  assert.strictEqual(retried.credit.number, 'F2026-0002');
  assert.strictEqual(created, 1, 'één creditnota');
  assert.strictEqual((await credits.creditReturn('t', 'r1', null)).existing, true, 'daarna verandert er niets meer');
});
