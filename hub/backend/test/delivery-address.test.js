// Afleveradres op de offerte: standaard gelijk aan het adres van de klant, een afwijkend adres wordt opgeschoond, gecontroleerd
// (PDOK), op het document getoond en komt niet voor bij een klant zonder afwijkend adres.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Core = require('../../frontend/offertes/quote-core.js');
const DocText = require('../../frontend/shared/doc-text.js');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, listen } = require('./helpers/http-client');
const { createPdokFake } = require('./helpers/pdok-fake');

const PW = 'Tuin-Plan-2026!';

test('opschonen: afleveradres is standaard gelijk; een afwijkend adres zonder tekst telt als gelijk', () => {
  assert.deepStrictEqual(Core.sanitize({}).delivery, { same: true, address: '' });
  assert.deepStrictEqual(Core.sanitize({ delivery: { same: false, address: '   ' } }).delivery, { same: true, address: '' });
  assert.deepStrictEqual(Core.sanitize({ delivery: { same: true, address: 'Tuinstraat 2' } }).delivery, { same: true, address: '' }, 'gelijk wist een oud adres');
  assert.deepStrictEqual(Core.sanitize({ delivery: { same: false, address: 'Tuinstraat 2\n8071 AB Nunspeet' } }).delivery, { same: false, address: 'Tuinstraat 2\n8071 AB Nunspeet' });
  assert.strictEqual(Core.sanitize({ delivery: { same: false, address: 'x'.repeat(900) } }).delivery.address.length, 400);
  assert.deepStrictEqual(Core.sanitize({ delivery: 'rommel' }).delivery, { same: true, address: '' });
});

test('API: een afwijkend afleveradres op de offerte moet bij PDOK kloppen en wordt bewaard', async () => {
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  await store.createAccount(tenantId, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: 'e'.repeat(64), db, addressFetch: createPdokFake().fetchImpl }));
  try {
    const kees = await createLogin(base, { password: PW })('kees');
    const data = { customer: { name: 'Fam. Jansen', address: 'Tuinstraat 1\n8071 AB Nunspeet' } };
    const plain = await kees.post('/app/api/quotes', { data });
    assert.strictEqual(plain.status, 201);
    assert.deepStrictEqual(plain.body.data.delivery, { same: true, address: '' });
    // Een onbekend afleveradres wordt geweigerd, ook als het adres van de klant klopt.
    const unknown = await kees.post('/app/api/quotes', { data: { ...data, delivery: { same: false, address: 'Onbekendlaan 9\n8071 ZZ Nunspeet' } } });
    assert.strictEqual(unknown.status, 400, JSON.stringify(unknown.body));
    // Een bestaand afleveradres wordt bewaard en blijft zichtbaar bij het opnieuw lezen.
    const different = await kees.post('/app/api/quotes', { data: { ...data, delivery: { same: false, address: 'Tuinstraat 2\n8071 AB Nunspeet' } } });
    assert.strictEqual(different.status, 201, JSON.stringify(different.body));
    const read = await kees.get(`/app/api/quotes/${different.body.id}`);
    assert.deepStrictEqual(read.body.data.delivery, { same: false, address: 'Tuinstraat 2\n8071 AB Nunspeet' });
    // Wijzigen naar een ander onbekend adres mislukt; terug naar gelijk wist het adres.
    assert.strictEqual((await kees.put(`/app/api/quotes/${different.body.id}`, { data: { ...data, delivery: { same: false, address: 'Nergens 1\n8071 ZZ Nunspeet' } } })).status, 400);
    const back = await kees.put(`/app/api/quotes/${different.body.id}`, { data: { ...data, delivery: { same: true, address: 'Tuinstraat 2\n8071 AB Nunspeet' } } });
    assert.strictEqual(back.status, 200);
    assert.deepStrictEqual(back.body.data.delivery, { same: true, address: '' });
  } finally {
    server.close();
  }
});

test('document: het afleveradres staat alleen op de offerte als het afwijkt, in de taal van het document', () => {
  const sandbox = { QuoteCore: Core, DocText };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'offertes', 'quote-view.js'), 'utf8'), sandbox);
  /**
   * Het offertedocument met de gegeven extra velden.
   * @param {object} extra Extra offertegegevens.
   * @returns {string} De HTML van het document.
   */
  const html = (extra) => sandbox.QuoteView.documentHtml({ number: 'OF-1', acceptance: null, data: Core.sanitize({ customer: { name: 'Jansen', address: 'Tuinstraat 1' }, lines: [], ...extra }) }, { companyName: 'AquaTech' });
  assert.doesNotMatch(html({}), /Afleveradres/);
  const different = html({ delivery: { same: false, address: 'Havenkade 5\n1011 AA Amsterdam' } });
  assert.match(different, /Afleveradres<\/div>Havenkade 5/);
  assert.match(html({ language: 'en', delivery: { same: false, address: 'Havenkade 5' } }), /Delivery address/);
});
