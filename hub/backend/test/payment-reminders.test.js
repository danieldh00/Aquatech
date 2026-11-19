// Betalingsherinneringen en aanmaningen: instelling opschonen, de verzendronde (juiste stap op het juiste moment, nooit dubbel,
// betaald/gecrediteerd/uitgezette klant/geen adres overgeslagen, Engelse factuur) en de zichtbaarheid per factuur.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createInvoiceStore } = require('../src/verkoop/invoices');
const { sanitizePaymentReminders, createPaymentReminderStore, createPaymentReminderRunner } = require('../src/verkoop/payment-reminders');
const { mailBody } = require('../src/verkoop/quotes');
const Core = require('../../frontend/facturen/invoice-core.js');

const PW = 'Tuin-Plan-2026!';
const TODAY = '2026-12-01';

test('instelling: standaard uit, dagen oplopend met minstens een week ertussen, stopgrens boven de laatste stap', () => {
  const defaults = sanitizePaymentReminders({});
  assert.strictEqual(defaults.enabled, false);
  assert.deepStrictEqual(defaults.steps.map((step) => [step.key, step.days, step.enabled]), [['herinnering', 7, true], ['aanmaning', 21, true], ['laatste_aanmaning', 35, false]]);
  assert.strictEqual(defaults.stopAfterDays, 90);
  const out = sanitizePaymentReminders({ enabled: true, stopAfterDays: 10, steps: [{ key: 'herinnering', enabled: true, days: 14 }, { key: 'aanmaning', enabled: true, days: 15 }, { key: 'laatste_aanmaning', enabled: true, days: 20 }] });
  assert.deepStrictEqual(out.steps.map((step) => step.days), [14, 21, 28]);
  assert.strictEqual(out.stopAfterDays, 29);
  assert.strictEqual(sanitizePaymentReminders({ enabled: 'ja' }).enabled, false);
});

/**
 * Bouwt een omgeving met een nagebootste mailer en facturen.
 * @param {object} config De instelling paymentReminders.
 * @returns {Promise<object>} db, store, tenantId, invoices, reminders, runner, sent en make(options).
 */
async function setup(config) {
  const db = openDb();
  const store = createStore(db);
  const tenantId = store.ensureTenant().id;
  const admin = await store.createAccount(tenantId, { username: 'anne', displayName: 'Anne', role: 'beheerder', password: PW });
  const invoices = createInvoiceStore(db);
  const reminders = createPaymentReminderStore(db);
  const sent = [];
  const conf = Core.sanitizeSettings({});
  const values = {
    quoteProfile: { iban: 'NL00 BANK 0123 4567 89', companyName: 'AquaTech Service' }, paymentReminders: sanitizePaymentReminders(config),
  };
  const settings = { get: (key) => values[key] };
  const sender = {
    /**
     * Nagebootste invulwaarden.
     * @param {string} _tenantId De omgeving.
     * @param {object} invoice De factuur.
     * @returns {object} Veldnaam → tekst.
     */
    values: (_tenantId, invoice) => ({ klant: 'Jan', nummer: invoice.number, datum: '1 oktober', vervaldatum: invoice.dueDate, bedrag: '€ 100,00', bedrijf: 'AquaTech Service', iban: 'NL00' }),
    /**
     * Nagebootste PDF.
     * @returns {Buffer} De bytes.
     */
    pdfOf: () => Buffer.from('%PDF'),
  };
  let failWith = null;
  /**
   * Nagebootste mailer: bewaart de berichten of faalt.
   * @returns {{ configured: Function, send: Function }} De mailer.
   */
  const mailerFor = () => ({ configured: () => true, send: async (message) => { if (failWith) throw failWith; sent.push(message); } });
  const runner = createPaymentReminderRunner(reminders, { invoices, sender, settingsFor: () => settings, mailerFor, mailBody });
  /**
   * Maakt een definitieve factuur met een vervaldatum.
   * @param {{ overdueDays: number, email?: string, customerId?: string, language?: string }} options De factuur.
   * @returns {object} De factuur.
   */
  const make = ({ overdueDays, email = 'jan@voorbeeld.test', customerId = null, language = 'nl' }) => {
    const dueDate = Core.addDays(TODAY, -overdueDays);
    const invoice = invoices.create(tenantId, admin.user || admin, {
      date: Core.addDays(dueDate, -14), dueDate, language, customer: { name: 'Jan', email },
      lines: [{ description: 'Sproeier', qty: 1, unit: 'st', price: 100, vat: 21, group: 'producten' }],
    }, conf, { customerId });
    invoices.finalize(tenantId, admin.user || admin, invoice.id, conf);
    return invoices.get(tenantId, invoice.id);
  };
  return { db, store, tenantId, invoices, reminders, runner, sent, make, conf, fail: (error) => { failWith = error; } };
}

const ON = { enabled: true, steps: [{ key: 'herinnering', enabled: true, days: 7 }, { key: 'aanmaning', enabled: true, days: 21 }, { key: 'laatste_aanmaning', enabled: true, days: 35 }] };

test('verzendronde: de juiste stap, één keer, en het staat bij de factuur', async () => {
  const env = await setup(ON);
  const early = env.make({ overdueDays: 3 });
  const first = env.make({ overdueDays: 8 });
  const result = await env.runner.runEnvironment(env.tenantId, TODAY);
  assert.deepStrictEqual(result, { sent: 1, skipped: 0, failed: 0 });
  assert.strictEqual(env.sent.length, 1);
  assert.match(env.sent[0].subject, /Herinnering: factuur/);
  assert.strictEqual(env.sent[0].attachments[0].contentType, 'application/pdf');
  assert.deepStrictEqual(env.reminders.forInvoice(env.tenantId, early.id), []);
  const [entry] = env.reminders.forInvoice(env.tenantId, first.id);
  assert.strictEqual(entry.stepKey, 'herinnering');
  assert.strictEqual(entry.status, 'verstuurd');
  assert.strictEqual(entry.sentTo, 'jan@voorbeeld.test');
  assert.strictEqual(env.reminders.latestByInvoice(env.tenantId, [first.id]).get(first.id).title, 'Betalingsherinnering');
  // Dezelfde ronde nog eens: niets dubbel.
  assert.deepStrictEqual(await env.runner.runEnvironment(env.tenantId, TODAY), { sent: 0, skipped: 0, failed: 0 });
  // Veertien dagen later: de aanmaning, met het aantal dagen in de tekst.
  const later = Core.addDays(TODAY, 14);
  env.db.prepare('UPDATE invoice_reminders SET sent_at = ? WHERE tenant_id = ?').run('2026-12-01T08:00:00.000Z', env.tenantId);
  assert.strictEqual((await env.runner.runEnvironment(env.tenantId, later)).sent, 2, 'de eerste factuur krijgt de aanmaning, de andere de herinnering');
  assert.ok(env.sent.some((message) => /Aanmaning: factuur/.test(message.subject) && /22 dagen/.test(message.text)));
});

test('een factuur die al lang openstaat krijgt alleen de laatst passende stap', async () => {
  const env = await setup(ON);
  const old = env.make({ overdueDays: 40 });
  assert.strictEqual((await env.runner.runEnvironment(env.tenantId, TODAY)).sent, 1);
  assert.match(env.sent[0].subject, /Laatste aanmaning/);
  const steps = env.reminders.forInvoice(env.tenantId, old.id);
  assert.deepStrictEqual(steps.map((step) => [step.stepKey, step.status]).sort(), [['aanmaning', 'overgeslagen'], ['herinnering', 'overgeslagen'], ['laatste_aanmaning', 'verstuurd']]);
});

test('niet versturen: uit, betaald, gecrediteerd, te oud, klant uitgezet, geen of ongeldig adres', async () => {
  const off = await setup({ ...ON, enabled: false });
  off.make({ overdueDays: 10 });
  assert.strictEqual((await off.runner.runEnvironment(off.tenantId, TODAY)).sent, 0);

  const env = await setup(ON);
  const paid = env.make({ overdueDays: 10 });
  env.invoices.setPaid(env.tenantId, paid.id, true, TODAY);
  const credited = env.make({ overdueDays: 10 });
  const credit = env.invoices.credit(env.tenantId, null, credited.id, env.conf);
  env.invoices.finalize(env.tenantId, null, credit.invoice.id, env.conf);
  env.make({ overdueDays: 200 });
  const customer = await env.store.createAccount(env.tenantId, { username: 'klaas', displayName: 'Klaas', role: 'klant', password: PW });
  const customerId = (customer.user || customer).id;
  env.make({ overdueDays: 10, customerId });
  const updated = await env.store.updateAccount(env.tenantId, customerId, { remindersOff: true });
  assert.ok(!updated.error, updated.error);
  assert.strictEqual(env.store.getCustomer([env.tenantId], customerId).remindersOff, true);
  const noMail = env.make({ overdueDays: 10, email: 'geen-adres' });
  const result = await env.runner.runEnvironment(env.tenantId, TODAY);
  assert.deepStrictEqual(result, { sent: 0, skipped: 1, failed: 0 });
  const [entry] = env.reminders.forInvoice(env.tenantId, noMail.id);
  assert.strictEqual(entry.status, 'overgeslagen');
  assert.match(entry.reason, /e-mailadres/);
  assert.strictEqual(env.sent.length, 0);
});

test('een Engelse factuur krijgt een Engelse mail; een mailfout wordt niet als verstuurd vastgelegd', async () => {
  const env = await setup(ON);
  env.make({ overdueDays: 8, language: 'en' });
  assert.strictEqual((await env.runner.runEnvironment(env.tenantId, TODAY)).sent, 1);
  assert.match(env.sent[0].subject, /Reminder: invoice/);

  const broken = await setup(ON);
  const invoice = broken.make({ overdueDays: 8 });
  broken.fail(Object.assign(new Error('weg'), { code: 'ECONNECTION' }));
  assert.strictEqual((await broken.runner.runEnvironment(broken.tenantId, TODAY)).failed, 1);
  assert.deepStrictEqual(broken.reminders.forInvoice(broken.tenantId, invoice.id), [], 'volgende ronde opnieuw');
});
