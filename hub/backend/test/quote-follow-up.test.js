// Offerte-opvolging: instelling opschonen, wanneer een herinnering uitgaat (alleen verzonden offertes zonder antwoord,
// niet verlopen, hoogstens het ingestelde aantal), rechten, dubbele rondes en een mislukte mail.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeQuoteFollowUp } = require('../src/verkoop/quote-follow-up');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const SHARE_URL = 'https://app.voorbeeld.test/openbaar/offerte.html';

test('instelling: standaard uit, dagen en aantal begrensd', () => {
  assert.deepStrictEqual(sanitizeQuoteFollowUp({}), { enabled: false, afterDays: 7, maxReminders: 1 });
  assert.deepStrictEqual(sanitizeQuoteFollowUp({ enabled: true, afterDays: 500, maxReminders: 9 }), { enabled: true, afterDays: 60, maxReminders: 2 });
  assert.deepStrictEqual(sanitizeQuoteFollowUp({ enabled: 'ja', afterDays: 0, maxReminders: 0 }), { enabled: false, afterDays: 2, maxReminders: 1 });
  assert.strictEqual(sanitizeQuoteFollowUp({ afterDays: 'x' }).afterDays, 7);
});

test('herinnering: alleen verzonden offertes zonder antwoord, niet dubbel, hoogstens het ingestelde aantal', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'anne', displayName: 'Anne', role: 'beheerder', password: PW });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  const sent = [];
  let failNext = false;
  /**
   * Nagebootste mailer: altijd ingesteld, bewaart de berichten.
   * @returns {{ configured: Function, send: Function }} De mailer.
   */
  const mailerFor = () => ({ configured: () => true, send: async (message) => { if (failNext) { failNext = false; throw new Error('mailserver weg'); } sent.push(message); } });
  const app = createApp({ secret: SECRET, db, mailerFor });
  const { server, base } = await listen(app);
  const as = createLogin(base, { password: PW, extraBody: { mustChangePassword: false } });
  try {
    const anne = await as('anne'), kees = await as('kees');
    /**
     * Maakt een offerte en mailt hem naar de klant.
     * @param {string} title Titel.
     * @param {object} [extra] Extra velden in de inhoud (validUntil).
     * @returns {Promise<object>} De offerte.
     */
    const sendQuote = async (title, extra = {}) => {
      const data = { title, customer: { name: 'Klant', email: 'klant@voorbeeld.test' }, lines: [{ section: 'materiaal', description: 'Sproeier', qty: 1, unit: 'st', price: 20, vat: 21 }], ...extra };
      const quote = (await kees.post('/app/api/quotes', { data })).body;
      const mail = await kees.post(`/app/api/quotes/${quote.id}/send`, { to: 'klant@voorbeeld.test', url: SHARE_URL });
      assert.strictEqual(mail.status, 200, JSON.stringify(mail.body));
      return quote;
    };
    const open = await sendQuote('Open');
    const answered = await sendQuote('Beantwoord');
    const expired = await sendQuote('Verlopen', { validUntil: '2020-01-01' });
    const mailsBefore = sent.length;
    assert.strictEqual(mailsBefore, 3);
    /**
     * Een moment een aantal dagen na nu.
     * @param {number} days Aantal dagen.
     * @returns {Date} Het moment.
     */
    const later = (days) => new Date(Date.now() + days * 86400000);

    // Alleen een beheerder zet het aan; uit = niets.
    assert.strictEqual((await kees.put('/app/api/admin/settings', { quoteFollowUp: { enabled: true } })).status, 403);
    assert.deepStrictEqual(await app.locals.quoteFollowUpAll(later(30)), {});
    assert.strictEqual((await anne.put('/app/api/admin/settings', { quoteFollowUp: { enabled: true, afterDays: 7, maxReminders: 2 } })).status, 200);
    // De klant reageert op één offerte.
    db.prepare("UPDATE quotes SET status = 'afgewezen' WHERE id = ?").run(answered.id);

    // Te vroeg: niets. Na zeven dagen: alleen de open, niet-verlopen offerte; de verlopen wordt overgeslagen.
    assert.deepStrictEqual(await app.locals.quoteFollowUpAll(later(6)), {});
    const first = await app.locals.quoteFollowUpAll(later(8));
    assert.deepStrictEqual(first[main], { sent: 1, skipped: 1, failed: 0 });
    const reminder = sent.at(-1);
    assert.deepStrictEqual(reminder.to, ['klant@voorbeeld.test']);
    assert.match(reminder.subject, /Herinnering: offerte /);
    assert.match(reminder.text, /openbaar\/offerte\.html#t=/);
    assert.strictEqual(sent.length, mailsBefore + 1);
    // Dezelfde dag opnieuw: niets. Tweede herinnering pas zeven dagen na de eerste, daarna nooit meer.
    assert.deepStrictEqual(await app.locals.quoteFollowUpAll(later(9)), {});
    assert.strictEqual((await app.locals.quoteFollowUpAll(later(16)))[main].sent, 1);
    assert.deepStrictEqual(await app.locals.quoteFollowUpAll(later(25)), {});
    assert.strictEqual(sent.length, mailsBefore + 2);
    assert.strictEqual(db.prepare('SELECT followup_count FROM quotes WHERE id = ?').get(open.id).followup_count, 2);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM audit WHERE action = ?').get('offerte_opvolging').total, 2);

    // Mislukte mail: de poging wordt teruggedraaid en de volgende ronde probeert het opnieuw.
    const retry = await sendQuote('Opnieuw');
    failNext = true;
    assert.strictEqual((await app.locals.quoteFollowUpAll(later(20)))[main].failed, 1);
    assert.strictEqual(db.prepare('SELECT followup_count FROM quotes WHERE id = ?').get(retry.id).followup_count, 0);
    assert.strictEqual((await app.locals.quoteFollowUpAll(later(20)))[main].sent, 1);
  } finally {
    server.close();
  }
});
