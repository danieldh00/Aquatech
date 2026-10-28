// Installatiedossier per locatie: werkorders, meldingen, offertes, plannen en
// materialen van één adres; de klant ziet alleen zijn eigen deel zonder
// prijzen, verbruik en interne notities.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { locationKey } = require('../src/uitvoering/photos');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 'l'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Hoofdtenant met installateur en twee klanten, plus organisatie Blauw met een installateur.
 * @returns {Promise<object>} db, server en as (inloggen).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'klaas', displayName: 'Klaas Jansen', role: 'klant', password: PW });
  await store.createAccount(main, { username: 'piet', displayName: 'Piet', role: 'klant', password: PW });
  const other = store.createTenant({ name: 'Blauw BV', slug: 'blauw' }).tenant;
  await store.createAccount(other.id, { username: 'bram', displayName: 'Bram', role: 'installateur', password: PW });
  await store.createAccount(other.id, { username: 'bea', displayName: 'Bea', role: 'klant', password: PW });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  const as = createLogin(base, { password: PW, extraBody: { mustChangePassword: false } });
  return { db, server, as };
}

test('locatiesleutel: zelfde adres met andere schrijfwijze, leeg adres geen sleutel', () => {
  assert.strictEqual(locationKey('Dorpsstraat 1\n8071 AB  Nunspeet'), locationKey('dorpsstraat 1, 8071ab nunspeet'));
  assert.notStrictEqual(locationKey('Dorpsstraat 1, Nunspeet'), locationKey('Dorpsstraat 3, Nunspeet'));
  assert.match(locationKey('Dorpsstraat 1'), /^l-[0-9a-f]{16}$/);
  assert.strictEqual(locationKey('  '), null);
});

test('installatiedossier per locatie: medewerker ziet alles, klant alleen zijn deel', async () => {
  const { db, server, as } = await setup();
  try {
    const kees = await as('kees'), klaas = await as('klaas'), piet = await as('piet'), bram = await as('bram', 'blauw'), bea = await as('bea', 'blauw');
    const klaasId = (await klaas.get('/api/me')).body.user.id;

    // Twee installaties op hetzelfde adres (anders geschreven) en één elders.
    /**
     * Maakt een geaccordeerde offerte met werkorder voor Klaas.
     * @param {string} title De titel.
     * @param {string} address Het adres.
     * @returns {Promise<object>} De werkorder.
     */
    const install = async (title, address) => {
      const data = { title, customer: { name: 'Fam. Jansen', address },
        lines: [{ section: 'materiaal', code: 'SPR', description: 'Sproeier', qty: 4, unit: 'st', price: 20, vat: 21 }] };
      const quote = (await kees.post('/api/quotes', { data, customerId: klaasId })).body;
      await kees.put(`/api/quotes/${quote.id}`, { status: 'akkoord' });
      return (await kees.post('/api/workorders', { quoteId: quote.id })).body;
    };
    const first = await install('Aanleg tuin', 'Dorpsstraat 1\n8071 AB Nunspeet');
    const second = await install('Uitbreiding border', 'Dorpsstraat 1, 8071AB Nunspeet');
    await install('Vakantiehuis', 'Strandweg 9, Renesse');
    await kees.put(`/api/workorders/${first.id}`, { status: 'gereed', data: { ...first.data, report: { completedOn: '2026-10-01', notes: 'Netjes opgeleverd', signedBy: 'Jansen' } } });
    const materialUse = await kees.post(`/api/workorders/${first.id}/materials`, { usedOn: '2026-10-01', code: 'SPR', description: 'Sproeier', unit: 'st', qty: 5 });
    assert.strictEqual(materialUse.status, 201);
    // Melding van Klaas op hetzelfde adres; Piet meldt op een eigen adres.
    assert.strictEqual((await klaas.post('/api/portal/requests', { subject: 'Lek', description: 'Er lekt water bij de kraan.', address: 'dorpsstraat 1 8071 ab nunspeet' })).status, 201);
    // Melding zonder adres maar aan een installatie gekoppeld: hoort bij het adres van die installatie.
    assert.strictEqual((await klaas.post('/api/portal/requests', { subject: 'Zone 2', description: 'Zone 2 gaat niet meer aan.', installationId: first.id })).status, 201);
    assert.strictEqual((await piet.post('/api/portal/requests', { subject: 'Onderhoud', description: 'Graag winterklaar maken.', address: 'Kerkplein 2, Ermelo' })).status, 201);

    // Overzicht: drie locaties, het dubbele adres één keer.
    assert.strictEqual((await klaas.get('/api/locations')).status, 403);
    const items = (await kees.get('/api/locations')).body.items;
    assert.strictEqual(items.length, 3);
    const home = items.find((item) => item.key === locationKey('Dorpsstraat 1, 8071 AB Nunspeet'));
    assert.deepStrictEqual([home.installations, home.completed, home.requests, home.openRequests], [2, 1, 2, 2]);
    assert.strictEqual(home.lastCompletedOn, '2026-10-01');

    // Detail voor de medewerker: beide installaties, melding, offertes met bedrag, geplaatst + verbruikt.
    const staff = (await kees.get(`/api/locations/${home.key}`)).body;
    assert.deepStrictEqual(staff.installations.map((installation) => installation.id).sort(), [first.id, second.id].sort());
    assert.strictEqual(staff.requests.length, 2);
    assert.strictEqual(staff.quotes.length, 2);
    assert.ok(staff.quotes.every((quote) => quote.totalIncl > 0));
    const sprinkler = staff.materials.find((material) => material.code === 'SPR');
    assert.strictEqual(sprinkler.used, 5);
    assert.ok(sprinkler.placed > 0);
    assert.ok(staff.customers.some((customer) => customer.dossierKey === `a-${klaasId}`));

    // Klant: eigen locatie zonder prijzen en verbruik; andermans locatie 404.
    const portal = await klaas.get(`/api/portal/locations/${home.key}`);
    assert.strictEqual(portal.status, 200);
    assert.strictEqual(portal.body.installations.length, 2);
    assert.ok(portal.body.quotes.every((quote) => !('totalIncl' in quote)));
    assert.ok(portal.body.materials.every((material) => !('used' in material)));
    assert.ok(!('customers' in portal.body));
    assert.ok(portal.body.installations.every((installation) => !('crew' in installation)));
    const pietHome = items.find((item) => item.key === locationKey('Kerkplein 2, Ermelo'));
    assert.strictEqual((await klaas.get(`/api/portal/locations/${pietHome.key}`)).status, 404);
    assert.strictEqual((await piet.get(`/api/portal/locations/${pietHome.key}`)).status, 200);
    assert.strictEqual((await kees.get(`/api/portal/locations/${home.key}`)).status, 403, 'medewerker heeft geen portaal');
    // Het portaal geeft per werkorder de locatie mee.
    const overview = (await klaas.get('/api/portal')).body;
    assert.ok(overview.workorders.some((workOrder) => workOrder.location === home.key));
    assert.strictEqual(overview.requests.length, 2);
    assert.ok(overview.requests.every((request) => request.location === home.key));

    // Andere organisatie en onbekende sleutels: 404.
    assert.strictEqual((await bram.get(`/api/locations/${home.key}`)).status, 404);
    assert.strictEqual((await bram.get('/api/locations')).body.items.length, 0);
    assert.strictEqual((await bea.get(`/api/portal/locations/${home.key}`)).status, 404, 'klant van een andere organisatie');
    assert.strictEqual((await klaas.get(`/api/locations/${home.key}`)).status, 403, 'klant heeft geen recht werkorders');
    assert.strictEqual((await kees.get('/api/locations/l-0000000000000000')).status, 404);
    assert.strictEqual((await kees.get('/api/locations/onzin')).status, 404);
  } finally {
    server.close();
    db.close();
  }
});
