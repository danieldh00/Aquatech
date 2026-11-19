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
  let failNext = false;
  /**
   * Mailer die niets verstuurt maar elk bericht bewaart.
   * @param {object} settings Instellingen van de omgeving.
   * @returns {object} De mailer.
   */
  const mailerFor = (settings) => createMailer(settings, { resolveHost: async (host) => host, createTransport: () => ({ sendMail: async (message) => { if (failNext) { failNext = false; throw new Error('smtp weg'); } sent.push(message); return {}; } }) });
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
    // Een tweede keer: een nog 'verzonden' offerte mag opnieuw (herinnering).
    const again = (await kees.post('/app/api/quotes-bulk/send', { ids: ids.slice(0, 1), url: URL_OK })).body;
    assert.strictEqual(again.sent.length, 1);
    // Beantwoord (afgewezen door de klant) of afgesloten: overgeslagen en niet gemaild.
    const closed = (await kees.post('/app/api/quotes', { data: { title: 'Dicht', customer: { name: 'Fam. D', email: 'd@klant.test' } } })).body.id;
    await kees.put(`/app/api/quotes/${closed}`, { status: 'afgewezen' });
    const before = sent.length;
    const skippedClosed = (await kees.post('/app/api/quotes-bulk/send', { ids: [closed], url: URL_OK })).body;
    assert.deepStrictEqual([skippedClosed.sent.length, skippedClosed.skipped[0].reason], [0, 'Is al beantwoord, omgezet of afgesloten.']);
    assert.strictEqual(sent.length, before);
    // Te veel offertes in één keer.
    assert.strictEqual((await kees.post('/app/api/quotes-bulk/send', { ids: Array.from({ length: 11 }, (_, i) => `id-${i}`), url: URL_OK })).status, 400);
    // Een offerte van een andere organisatie is voor deze gebruiker niet te vinden en wordt niet gemaild.
    {
      const otherTenant = store.createTenant({ name: 'Andere', slug: 'andere' }).tenant.id;
      await store.createAccount(otherTenant, { username: 'ander', displayName: 'Ander', role: 'installateur', password: PASSWORD });
      const foreign = await as('ander', 'andere');
      const foreignId = (await foreign.post('/app/api/quotes', { data: { title: 'Vreemd', customer: { name: 'X', email: 'x@vreemd.test' } } })).body.id;
      const mailCount = sent.length;
      const result2 = (await kees.post('/app/api/quotes-bulk/send', { ids: [foreignId], url: URL_OK })).body;
      assert.deepStrictEqual([result2.sent.length, result2.skipped[0].reason], [0, 'Niet gevonden.']);
      assert.strictEqual(sent.length, mailCount);
    }
    // Een mislukte mail: gemeld, offerte blijft een concept (de link is weer ingetrokken).
    failNext = true;
    const draft = (await kees.post('/app/api/quotes', { data: { title: 'Mailfout', customer: { name: 'Fam. E', email: 'e@klant.test' } } })).body.id;
    const failed = (await kees.post('/app/api/quotes-bulk/send', { ids: [draft], url: URL_OK })).body;
    assert.strictEqual(failed.sent.length, 0);
    assert.strictEqual(failed.skipped.length, 1);
    assert.strictEqual((await kees.get(`/app/api/quotes/${draft}`)).body.status, 'concept', 'er is niets verstuurd, dus blijft het een concept');
  } finally {
    server.close();
  }
});
