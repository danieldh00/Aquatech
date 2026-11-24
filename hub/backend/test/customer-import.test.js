// Klanten importeren uit Excel (V-05): controle zonder te schrijven, nieuw/wijzigt/ongewijzigd/fout, herkennen op
// e-mail en naam, rechten (zakelijk alleen beheerder), PDOK-adres, alles-of-niets en scheiding tussen organisaties.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, listen } = require('./helpers/http-client');
const { createPdokFake } = require('./helpers/pdok-fake');
const { parseNumber, mapColumns, normalizeHeader } = require('../src/platform/excel-import');

const SECRET = 'c'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, installateur en een andere organisatie.
 * @returns {Promise<object>} base, as, admin, installer en other (beheerder van de andere organisatie).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'klant1', displayName: 'Klant Eén', role: 'klant', password: PW }, { mustChangePassword: false });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, addressFetch: createPdokFake().fetchImpl, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  return { as, admin: await as('baas'), installer: await as('monteur'), klant: await as('klant1'), other: await as('vreemd', 'ander') };
}

const HEADERS = ['Naam', 'E-mailadres', 'Telefoon', 'Adres', 'Bedrijfsnaam', 'KvK', 'Btw', 'Klantgroep', 'Betaaltermijn', 'Taal'];

test('getallen en kolomkoppen worden ruim herkend', () => {
  assert.strictEqual(parseNumber('1.234,56'), 1234.56);
  assert.strictEqual(parseNumber('€ 12,50'), 12.5);
  assert.strictEqual(parseNumber('1,234.56'), 1234.56);
  assert.strictEqual(parseNumber('1.234'), 1234);
  assert.strictEqual(parseNumber('12.5'), 12.5);
  assert.strictEqual(parseNumber(''), null);
  assert.strictEqual(parseNumber('abc'), undefined);
  assert.strictEqual(normalizeHeader(' E-mail­adres '), 'emailadres');
  const mapped = mapColumns(['E-mailadres', 'Naam', 'Onbekend'], [{ key: 'displayName', label: 'Naam', required: true }, { key: 'email', label: 'E-mail', aliases: ['e-mailadres'] }]);
  assert.deepStrictEqual(mapped, { columns: { email: 0, displayName: 1 }, unknown: ['Onbekend'], missing: [] });
});

test('controle schrijft niets; verwerken maakt nieuwe klanten en wijzigt bestaande', async () => {
  const { admin, installer } = await setup();
  await installer.post('/app/api/customers', { displayName: 'Jansen', email: 'info@jansen.nl' });
  const rows = [
    ['Piet Pieters', 'piet@voorbeeld.nl', '06 12345678', 'Tuinstraat 1, 8071 AB Nunspeet', '', '', '', '', '14', 'Engels'],
    ['Jansen Tuinen', 'INFO@jansen.nl', '', '', '', '', '', '', '30', ''],
    ['Jansen', '', '', '', '', '', '', '', '', ''],
  ];
  const preview = await installer.post('/app/api/customers/import', { headers: HEADERS, rows });
  assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));
  assert.deepStrictEqual(preview.body.counts, { nieuw: 1, wijzigt: 1, ongewijzigd: 1, fout: 0 });
  assert.deepStrictEqual(preview.body.rows.map((row) => row.status), ['nieuw', 'wijzigt', 'ongewijzigd']);
  assert.deepStrictEqual(preview.body.rows[1].changes.map((change) => change.field), ['displayName', 'paymentDays']);
  assert.strictEqual(preview.body.rows[1].matchedBy, 'e-mail');
  assert.strictEqual((await installer.get('/app/api/customers')).body.total, 2, 'controle schrijft niets');
  const applied = await installer.post('/app/api/customers/import', { headers: HEADERS, rows, apply: true });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  assert.strictEqual(applied.body.created, 1);
  assert.strictEqual(applied.body.updated, 1);
  const list = (await installer.get('/app/api/customers?q=pieters')).body.items[0];
  assert.strictEqual(list.address, 'Tuinstraat 1\n8071 AB Nunspeet');
  assert.strictEqual(list.paymentDays, 14);
  assert.strictEqual(list.documentLanguage, 'en');
  const jansen = (await installer.get('/app/api/customers?q=jansen')).body.items[0];
  assert.strictEqual(jansen.displayName, 'Jansen Tuinen');
  assert.strictEqual(jansen.paymentDays, 30);
  // Nogmaals: niets meer te doen.
  const again = await admin.post('/app/api/customers/import', { headers: HEADERS, rows: rows.slice(0, 2), apply: true });
  assert.strictEqual(again.body.created + again.body.updated, 0);
});

test('fouten blokkeren het verwerken, behalve met skipErrors', async () => {
  const { installer } = await setup();
  const rows = [
    ['Goed', 'goed@voorbeeld.nl', '', '', '', '', '', '', '', ''],
    ['Slecht adres', '', '', 'Nergens 99, 1234 ZZ Niets', '', '', '', '', '', ''],
    ['Slechte mail', 'geen-mail', '', '', '', '', '', '', '', ''],
    ['Dubbel', 'goed@voorbeeld.nl', '', '', '', '', '', '', '', ''],
    ['Zakelijk', '', '', '', 'Bedrijf BV', '', '', 'zakelijk', '', ''],
  ];
  const blocked = await installer.post('/app/api/customers/import', { headers: HEADERS, rows, apply: true });
  assert.strictEqual(blocked.status, 409);
  assert.strictEqual(blocked.body.counts.fout, 4);
  assert.match(blocked.body.rows[4].problems[0], /beheerder/);
  assert.strictEqual((await installer.get('/app/api/customers')).body.total, 1, 'niets geschreven');
  const partial = await installer.post('/app/api/customers/import', { headers: HEADERS, rows, apply: true, skipErrors: true });
  assert.strictEqual(partial.status, 200);
  assert.strictEqual(partial.body.created, 1);
  assert.strictEqual(partial.body.skipped, 4);
});

test('een beheerder importeert een zakelijke klant; rechten en andere organisatie', async () => {
  const { admin, klant, other, installer } = await setup();
  const rows = [['Bedrijf Contact', 'b@bedrijf.nl', '', '', 'Bedrijf BV', '', 'NL123456789B01', 'zakelijk', '', '']];
  const made = await admin.post('/app/api/customers/import', { headers: HEADERS, rows, apply: true });
  assert.strictEqual(made.status, 200, JSON.stringify(made.body));
  const customer = (await admin.get('/app/api/customers?q=bedrijf')).body.items[0];
  assert.strictEqual(customer.customerGroup, 'zakelijk');
  assert.strictEqual(customer.companyName, 'Bedrijf BV');
  assert.strictEqual((await klant.post('/app/api/customers/import', { headers: HEADERS, rows })).status, 403);
  // De andere organisatie ziet de klant niet en heeft er dus een nieuwe.
  const foreign = await other.post('/app/api/customers/import', { headers: HEADERS, rows });
  assert.strictEqual(foreign.body.counts.nieuw, 1);
  // Verplichte kolom ontbreekt.
  const missing = await installer.post('/app/api/customers/import', { headers: ['E-mail'], rows: [['a@b.nl']] });
  assert.strictEqual(missing.status, 400);
  assert.match(missing.body.message, /Naam/);
  assert.strictEqual((await installer.post('/app/api/customers/import', { headers: HEADERS, rows: [] })).status, 400);
  assert.strictEqual((await installer.get('/app/api/customers/import/fields')).body.fields[0].key, 'displayName');
});
