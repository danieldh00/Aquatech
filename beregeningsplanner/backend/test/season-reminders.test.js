// Seizoensherinneringen: instelling opschonen, welke herinnering wanneer loopt,
// de verzendronde (één mail per klant per jaar, alleen klanten met een
// installatie in de eigen omgeving, afmelden) en het klantportaal.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { sanitizeSeasonReminders, activeItems, portalReminders, createSeasonReminderRunner } = require('../src/uitvoering/season-reminders');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

test('instelling: standaardherinneringen, datums begrensd, alleen een portaaladres', () => {
  const defaults = sanitizeSeasonReminders({});
  assert.strictEqual(defaults.enabled, false);
  assert.deepStrictEqual(defaults.items.map((item) => [item.key, item.month, item.day]), [['voorjaar', 3, 15], ['najaar', 10, 1]]);
  const out = sanitizeSeasonReminders({
    enabled: true, portalUrl: 'https://user:pw@example.nl/portaal/',
    items: [{ key: 'voorjaar', title: 'Start\nnu', month: 2, day: 31, text: 'Tekst' }, { key: 'voorjaar', title: 'Dubbel' }, { key: 'FOUT!', title: 'x' }],
  });
  assert.strictEqual(out.portalUrl, '', 'geen inloggegevens in het adres');
  assert.deepStrictEqual(out.items, [{ key: 'voorjaar', title: 'Start nu', month: 2, day: 28, text: 'Tekst' }]);
  assert.strictEqual(sanitizeSeasonReminders({ portalUrl: 'https://app.voorbeeld.nl/aquatech/portaal/?x=1' }).portalUrl, 'https://app.voorbeeld.nl/aquatech/portaal/');
  assert.strictEqual(sanitizeSeasonReminders({ portalUrl: 'javascript:alert(1)//portaal/' }).portalUrl, '');
});

test('lopende herinneringen: vanaf de datum, ook over de jaarwisseling', () => {
  const config = sanitizeSeasonReminders({ enabled: true, items: [{ key: 'winter', title: 'Winter', month: 12, day: 20 }, { key: 'voorjaar', title: 'Voorjaar', month: 3, day: 15 }] });
  assert.deepStrictEqual(activeItems(config, new Date('2026-03-14T12:00:00Z'), 21).map((entry) => entry.item.key), []);
  assert.deepStrictEqual(activeItems(config, new Date('2026-03-15T00:30:00Z'), 21).map((entry) => [entry.item.key, entry.year]), [['voorjaar', 2026]]);
  assert.deepStrictEqual(activeItems(config, new Date('2026-04-05T12:00:00Z'), 21).map((entry) => entry.item.key), [], 'na drie weken geen mail meer');
  assert.deepStrictEqual(activeItems(config, new Date('2027-01-05T12:00:00Z'), 21).map((entry) => [entry.item.key, entry.year]), [['winter', 2026]]);
  assert.deepStrictEqual(portalReminders(config, new Date('2026-04-20T12:00:00Z')).map((reminder) => reminder.key), ['voorjaar'], 'portaal: twee maanden');
  assert.deepStrictEqual(portalReminders({ ...config, enabled: false }, new Date('2026-03-20T12:00:00Z')), [], 'uit = niets in het portaal');
});

test('verzendronde: één mail per klant per jaar, alleen met installatie in de eigen omgeving, afmelden werkt', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'anne', displayName: 'Anne', role: 'beheerder', password: PW });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  const klaas = await store.createAccount(main, { username: 'klaas', displayName: 'Klaas Jansen', role: 'klant', password: PW });
  const piet = await store.createAccount(main, { username: 'piet', displayName: 'Piet', role: 'klant', password: PW });
  const jan = await store.createAccount(main, { username: 'jan', displayName: 'Jan', role: 'klant', password: PW });
  const other = store.createTenant({ name: 'Blauw BV', slug: 'blauw' }).tenant;
  await store.createAccount(other.id, { username: 'bram', displayName: 'Bram', role: 'installateur', password: PW });
  const bas = await store.createAccount(other.id, { username: 'bas', displayName: 'Bas', role: 'klant', password: PW });
  for (const [account, email] of [[klaas, 'klaas@voorbeeld.test'], [piet, 'piet@voorbeeld.test'], [jan, 'jan@voorbeeld.test'], [bas, 'bas@voorbeeld.test']]) {
    store.updateProfile((account.user || account).id, { email });
  }
  const sent = [];
  /**
   * Nagebootste mailer: altijd ingesteld, bewaart de berichten.
   * @returns {{ configured: Function, send: Function }} De mailer.
   */
  const mailerFor = () => ({ configured: () => true, send: async (message) => { sent.push(message); } });
  const app = createApp({ secret: SECRET, db, mailerFor });
  const { server, base } = await listen(app);
  const as = createLogin(base, { password: PW, extraBody: { mustChangePassword: false } });
  try {
    const anne = await as('anne'), kees = await as('kees'), bram = await as('bram', 'blauw');
    const klaasClient = await as('klaas'), janClient = await as('jan');
    /**
     * Maakt een installatie (werkorder uit een geaccordeerde offerte) voor een klant.
     * @param {object} installer Ingelogde installateur.
     * @param {string} customerId Id van de klant.
     * @returns {Promise<void>}
     */
    const install = async (installer, customerId) => {
      const data = { title: 'Aanleg', customer: { name: 'Klant' }, lines: [{ section: 'materiaal', description: 'Sproeier', qty: 1, unit: 'st', price: 20, vat: 21 }] };
      const quote = (await installer.post('/api/quotes', { data, customerId })).body;
      await installer.put(`/api/quotes/${quote.id}`, { status: 'akkoord' });
      assert.strictEqual((await installer.post('/api/workorders', { quoteId: quote.id })).status, 201);
    };
    const klaasId = (await klaasClient.get('/api/me')).body.user.id;
    const janId = (await janClient.get('/api/me')).body.user.id;
    const basId = store.listUsers(other.id).find((user) => user.username === 'bas').id;
    await install(kees, klaasId);
    await install(kees, janId);
    await install(bram, basId);

    // Alleen een beheerder zet het aan; standaard staat het uit.
    assert.strictEqual((await kees.put('/api/admin/settings', { seasonReminders: { enabled: true } })).status, 403);
    assert.deepStrictEqual(await app.locals.seasonRemindersAll(new Date('2026-03-16T08:00:00Z')), {});
    let portal = (await klaasClient.get('/api/portal')).body;
    assert.deepStrictEqual([portal.remindersEnabled, portal.reminderMails], [false, true]);

    const saved = await anne.put('/api/admin/settings', { seasonReminders: { enabled: true, portalUrl: 'https://app.voorbeeld.test/portaal/', items: sanitizeSeasonReminders({}).items } });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    portal = (await klaasClient.get('/api/portal')).body;
    assert.strictEqual(portal.remindersEnabled, true);

    // Jan meldt zich af in zijn portaal.
    const optOut = await janClient.put('/api/account/profile', { preferences: { seasonReminders: false } });
    assert.strictEqual(optOut.body.preferences.seasonReminders, false);
    assert.strictEqual((await janClient.get('/api/portal')).body.reminderMails, false);

    // Vóór de datum niets; daarna alleen Klaas (Piet heeft geen installatie, Bas is van Blauw).
    assert.deepStrictEqual(await app.locals.seasonRemindersAll(new Date('2026-03-14T08:00:00Z')), {});
    const result = await app.locals.seasonRemindersAll(new Date('2026-03-16T08:00:00Z'));
    assert.deepStrictEqual(result[main], { sent: 1, skipped: 1, failed: 0 });
    assert.strictEqual(result[other.id], undefined);
    assert.deepStrictEqual(sent.map((message) => [message.to, message.subject]), [['klaas@voorbeeld.test', 'Beregening weer opstarten']]);
    assert.match(sent[0].text, /Beste Klaas Jansen/);
    assert.match(sent[0].text, /https:\/\/app\.voorbeeld\.test\/portaal\/\?herinnering=voorjaar/);
    // Een volgende ronde stuurt niets opnieuw.
    assert.deepStrictEqual(await app.locals.seasonRemindersAll(new Date('2026-03-17T08:00:00Z')), {});
    assert.strictEqual(sent.length, 1);
  } finally {
    server.close();
  }
});

test('verzendronde: geweigerd adres blokkeert de rest niet, rondes lopen niet over elkaar', async () => {
  const customers = ['een', 'twee', 'drie', 'vier', 'vijf'].map((name) => ({ id: name, displayName: name, email: `${name}@voorbeeld.test`, preferences: '{}' }));
  const marked = new Set();
  const reminders = {
    /**
     * Nagebootste ontvangers: iedereen die nog niets kreeg, op volgorde.
     * @param {string} _tenantId Omgeving (niet gebruikt).
     * @param {string[]} _userTenantIds Omgevingen van de klanten (niet gebruikt).
     * @param {string} _key Sleutel (niet gebruikt).
     * @param {number} _year Jaar (niet gebruikt).
     * @param {number} limit Hoogstens zoveel.
     * @returns {object[]} De klanten.
     */
    recipients: (_tenantId, _userTenantIds, _key, _year, limit) => customers.filter((customer) => !marked.has(customer.id)).slice(0, limit),
    /**
     * Legt vast dat een klant is afgehandeld.
     * @param {string} _tenantId Omgeving (niet gebruikt).
     * @param {string} userId Id van de klant.
     * @returns {void}
     */
    markSent: (_tenantId, userId) => { marked.add(userId); },
  };
  const config = sanitizeSeasonReminders({ enabled: true, items: [{ key: 'voorjaar', title: 'Voorjaar', month: 3, day: 15 }] });
  const sent = [];
  let release = null;
  const mailer = {
    /**
     * Altijd ingesteld.
     * @returns {boolean} true.
     */
    configured: () => true,
    /**
     * Weigert de eerste drie adressen definitief; 'vier' wacht tot de test hem loslaat.
     * @param {{ to: string }} message Het bericht.
     * @returns {Promise<void>}
     */
    send: async (message) => {
      if (/^(een|twee|drie)@/.test(message.to)) throw Object.assign(new Error('550 onbekend'), { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, permanent: true });
      if (message.to.startsWith('vier') && !release) await new Promise((resolve) => { release = resolve; });
      sent.push(message.to);
    },
  };
  const runner = createSeasonReminderRunner(reminders, {
    settingsFor: () => ({ get: (key) => (key === 'seasonReminders' ? config : {}) }),
    mailerFor: () => mailer,
    userTenantsOf: (tenantId) => [tenantId],
  });
  const today = new Date('2026-03-16T08:00:00Z');
  const first = runner.runAll(['t1'], today);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(await runner.runAll(['t1'], today), {}, 'tweede ronde tijdens de eerste: overgeslagen');
  release();
  assert.deepStrictEqual((await first).t1, { sent: 2, skipped: 0, failed: 3 });
  assert.deepStrictEqual(sent, ['vier@voorbeeld.test', 'vijf@voorbeeld.test']);
  assert.deepStrictEqual(await runner.runAll(['t1'], today), {}, 'geweigerde adressen komen niet terug');

  // Een geweigerde afzender ligt niet aan de klant: niemand vastleggen, ronde stoppen.
  customers.push({ id: 'zes', displayName: 'zes', email: 'zes@voorbeeld.test', preferences: '{}' }, { id: 'zeven', displayName: 'zeven', email: 'zeven@voorbeeld.test', preferences: '{}' });
  /**
   * Mailserver die de afzender weigert.
   * @returns {Promise<void>}
   */
  mailer.send = async () => { throw Object.assign(new Error('550 afzender'), { code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 550, permanent: true }); };
  assert.deepStrictEqual((await runner.runAll(['t1'], today)).t1, { sent: 0, skipped: 0, failed: 1 });
  assert.ok(!marked.has('zes') && !marked.has('zeven'), 'klanten blijven aan de beurt');
});
