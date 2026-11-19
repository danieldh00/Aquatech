// Offertes in bulk mailen: standaardbericht per klant, overslaan wat niet kan, rechten en limieten.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createMailer } = require('../src/platform/mailer');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const PASSWORD = 'Tuin-Plan-2026!';
const URL_OK = 'https://aquatech.example/openbaar/offerte.html';

test('bulk mailen: elke klant krijgt zijn bericht, de rest wordt overgeslagen', async () => {
  const sent = [];
  /**
   * Mailer die niets verstuurt maar elk bericht bewaart.
   * @param {object} settings Instellingen van de omgeving.
   * @returns {object} De mailer.
   */
  const mailerFor = (settings) => createMailer(settings, { resolveHost: async (host) => host, createTransport: () => ({ sendMail: async (message) => { sent.push(message); return {}; } }) });
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PASSWORD });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PASSWORD });
  await store.createAccount(tid, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PASSWORD });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: 'z'.repeat(64), db, mailerFor }));
  const as = createLogin(base, { password: PASSWORD });
  try {
    const baas = await as('baas'), kees = await as('kees'), klaas = await as('klaas');
    const ids = [];
    for (const customer of [{ name: 'Fam. A', email: 'a@klant.test' }, { name: 'Fam. B', email: 'b@klant.test', contact: 'Bert' }, { name: 'Fam. C' }]) {
      ids.push((await kees.post('/app/api/quotes', { data: { title: 'Tuin', customer, lines: [{ section: 'overig', description: 'Post', qty: 1, price: 10 }] } })).body.id);
    }
    assert.strictEqual((await createClient(base).post('/app/api/quotes-bulk/send', { ids, url: URL_OK })).status, 401);
    assert.strictEqual((await klaas.post('/app/api/quotes-bulk/send', { ids, url: URL_OK })).status, 403);
    assert.strictEqual((await kees.post('/app/api/quotes-bulk/send', { ids, url: URL_OK })).status, 409, 'zonder mailserver');
    await baas.put('/app/api/quote-mail', { config: { host: 'smtp.aquatech.test', port: 465, secure: true, user: 'offerte', from: 'AquaTech <offerte@aquatech.test>' }, password: 'geheim-wachtwoord' });
    assert.strictEqual((await kees.post('/app/api/quotes-bulk/send', { ids: [], url: URL_OK })).status, 400);
    assert.strictEqual((await kees.post('/app/api/quotes-bulk/send', { ids, url: 'https://evil.example/x.html' })).status, 400);
    const result = (await kees.post('/app/api/quotes-bulk/send', { ids: [...ids, 'bestaat-niet'], url: URL_OK })).body;
    assert.strictEqual(result.sent.length, 2);
    assert.deepStrictEqual(result.skipped.map((entry) => entry.reason).sort(), ['Geen geldig e-mailadres bij de klant.', 'Niet gevonden.']);
    assert.deepStrictEqual(sent.map((message) => [].concat(message.to).join()).sort(), ['a@klant.test', 'b@klant.test']);
    assert.ok(sent.every((message) => /Offerte OF-/.test(message.subject)));
    assert.ok(sent.find((message) => /Beste Bert/.test(message.text || message.html)));
    assert.strictEqual((await kees.get(`/app/api/quotes/${ids[0]}`)).body.status, 'verzonden');
    // Een tweede keer: de eerste twee zijn nog 'verzonden' en mogen opnieuw (herinnering), de derde blijft overgeslagen.
    const again = (await kees.post('/app/api/quotes-bulk/send', { ids: ids.slice(0, 1), url: URL_OK })).body;
    assert.strictEqual(again.sent.length, 1);
  } finally {
    server.close();
  }
});
