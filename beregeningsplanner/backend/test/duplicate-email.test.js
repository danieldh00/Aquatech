// Een e-mailadres hoort bij hoogstens één actief account: wijzigen via de klantkaart (store), een uitgeschakeld account
// weer inschakelen, en twee gelijktijdige klanten met hetzelfde adres. De overige paden (profiel, registratie, nieuwe klant)
// worden in profile-/shop-accounts-/customers-tests gedekt.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');

const PW = 'Tuin-Plan-2026!';

/**
 * Maakt een lege database met een hoofdtenant en een beheerder.
 * @returns {Promise<{ store: object, main: string }>} De store en het id van de hoofdtenant.
 */
async function setup() {
  const store = createStore(openDb());
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW });
  return { store, main };
}

test('e-mailadres: wijzigen naar het adres van een ander actief account wordt geweigerd (ook met hoofdletters)', async () => {
  const { store, main } = await setup();
  const first = store.createCustomer(main, { displayName: 'Eerste', email: 'dubbel@voorbeeld.nl' }).user;
  const second = store.createCustomer(main, { displayName: 'Tweede', email: 'anders@voorbeeld.nl' }).user;
  const clash = await store.updateAccount(main, second.id, { contact: { email: ' Dubbel@Voorbeeld.nl ' } });
  assert.strictEqual(clash.status, 409);
  assert.strictEqual(clash.field, 'email');
  assert.strictEqual(store.getUser(second.id).email, 'anders@voorbeeld.nl');
  // Het eigen adres opnieuw opslaan mag, een vrij adres ook.
  assert.ok((await store.updateAccount(main, first.id, { contact: { email: 'dubbel@voorbeeld.nl', phone: '0612345678' } })).user);
  assert.ok((await store.updateAccount(main, second.id, { contact: { email: 'vrij@voorbeeld.nl' } })).user);
});

test('e-mailadres: een uitgeschakeld account kan niet worden ingeschakeld naast een actief account met hetzelfde adres', async () => {
  const { store, main } = await setup();
  const old = store.createCustomer(main, { displayName: 'Oud', email: 'zelfde@voorbeeld.nl' }).user;
  await store.updateAccount(main, old.id, { disabled: true });
  // Een disabled account blokkeert het adres niet: een nieuwe klant mag het gebruiken.
  const fresh = store.createCustomer(main, { displayName: 'Nieuw', email: 'zelfde@voorbeeld.nl' });
  assert.ok(fresh.user);
  const enable = await store.updateAccount(main, old.id, { disabled: false });
  assert.strictEqual(enable.status, 409);
  // Elke onwaarde schakelt in en wordt dus ook gecontroleerd.
  for (const falsy of [null, '', 0]) assert.strictEqual((await store.updateAccount(main, old.id, { disabled: falsy })).status, 409, `disabled: ${JSON.stringify(falsy)}`);
  assert.match(enable.error, /e-mailadres/);
  assert.strictEqual(Number(store.getUser(old.id).disabled), 1);
  // Een uitgeschakeld account mag wel een adres krijgen dat een actief account heeft (het telt pas bij inschakelen).
  assert.ok((await store.updateAccount(main, old.id, { contact: { email: 'zelfde@voorbeeld.nl' } })).user);
  // Met een ander adres tegelijk lukt het wel.
  assert.ok((await store.updateAccount(main, old.id, { disabled: false, contact: { email: 'oud@voorbeeld.nl' } })).user);
});

test('e-mailadres: twee klanten met hetzelfde adres kort na elkaar aanmaken geeft er één', async () => {
  const { store, main } = await setup();
  const results = [store.createCustomer(main, { displayName: 'A', email: 'race@voorbeeld.nl' }), store.createCustomer(main, { displayName: 'B', email: 'RACE@voorbeeld.nl' })];
  assert.strictEqual(results.filter((result) => result.user).length, 1);
  assert.strictEqual(store.accountIdsByEmail(main, 'race@voorbeeld.nl').length, 1);
  assert.strictEqual(results.find((result) => result.error).field, 'email');
});
