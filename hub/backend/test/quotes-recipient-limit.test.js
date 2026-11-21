// Offertes mailen: één e-mailadres krijgt hoogstens 5 verstuurde mails per uur (losse mail en bulk samen).
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createMailer } = require('../src/platform/mailer');
const { createLogin, listen } = require('./helpers/http-client');

const PASSWORD = 'Tuin-Plan-2026!';
const URL_OK = 'https://aquatech.example/openbaar/offerte.html';

test('limiet per ontvanger: mislukte verzending telt niet, de zesde mail wordt geweigerd, bulk slaat over', async () => {
  const sent = [];
  let failNext = false;
  /**
   * Mailer die niets verstuurt maar elk bericht bewaart; met failNext mislukt de eerstvolgende verzending.
   * @param {object} settings Instellingen van de omgeving.
   * @returns {object} De mailer.
   */
  const mailerFor = (settings) => createMailer(settings, { resolveHost: async (host) => host, createTransport: () => ({ sendMail: async (message) => { if (failNext) { failNext = false; throw new Error('smtp weg'); } sent.push(message); return {}; } }) });
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  await store.createAccount(tenantId, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PASSWORD });
  await store.createAccount(tenantId, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PASSWORD });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: 'z'.repeat(64), db, mailerFor }));
  const as = createLogin(base, { password: PASSWORD });
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    await baas.put('/app/api/quote-mail', { config: { host: 'smtp.aquatech.test', port: 465, secure: true, user: 'offerte', from: 'AquaTech <offerte@aquatech.test>' }, password: 'geheim-wachtwoord' });
    const quoteId = (await kees.post('/app/api/quotes', { data: { title: 'Tuin', customer: { name: 'Fam. A', email: 'a@klant.test' }, lines: [{ section: 'overig', description: 'Post', qty: 1, price: 10 }] } })).body.id;
    /**
     * Verstuurt de offerte per mail aan de klant.
     * @returns {Promise<object>} Het antwoord van de server.
     */
    const send = () => kees.post(`/app/api/quotes/${quoteId}/send`, { to: 'a@klant.test', url: URL_OK });

    failNext = true;
    assert.strictEqual((await send()).status, 502, 'mislukte verzending');
    for (let count = 0; count < 5; count += 1) assert.strictEqual((await send()).status, 200, `mail ${count + 1}`);
    assert.strictEqual(sent.length, 5, 'de mislukte poging heeft geen plek verbruikt');
    const refused = await send();
    assert.deepStrictEqual([refused.status, refused.body.error], [429, 'recipient_limited']);
    assert.strictEqual(sent.length, 5);

    // Parallelle verzoeken kunnen niet langs de limiet: voor een nieuw adres gaan er hoogstens 5 mails door.
    const otherQuote = (await kees.post('/app/api/quotes', { data: { title: 'Tuin 2', customer: { name: 'Fam. B', email: 'b@klant.test' }, lines: [{ section: 'overig', description: 'Post', qty: 1, price: 10 }] } })).body.id;
    const parallel = await Promise.all(Array.from({ length: 12 }, () => kees.post(`/app/api/quotes/${otherQuote}/send`, { to: 'b@klant.test', url: URL_OK })));
    assert.strictEqual(parallel.filter((answer) => answer.status === 200).length, 5);
    assert.strictEqual(parallel.filter((answer) => answer.status === 429).length, 7);
    assert.strictEqual(sent.length, 10);

    const bulk = (await kees.post('/app/api/quotes-bulk/send', { ids: [quoteId], url: URL_OK })).body;
    assert.deepStrictEqual([bulk.sent.length, bulk.skipped[0].reason], [0, 'Naar dit e-mailadres is het afgelopen uur al vaak gemaild.']);
    assert.strictEqual(sent.length, 10);
  } finally {
    server.close();
  }
});
