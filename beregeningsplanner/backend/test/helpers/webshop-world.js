// Gedeelde opzet voor de tests van de eigen webshop: een hoofdtenant met
// beheerder, een artikel, een tweede organisatie en twee klanten, waarbij de
// verstuurde mails worden onderschept.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../../src/server');
const { openDb } = require('../../src/database/db');
const { createStore } = require('../../src/platform/store');
const { createLogin, createClient, listen, postForm, postCheckout } = require('./http-client');

const SECRET = 'f'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/** Afrekengegevens van een particulier in Nederland. */
const PERSON = { name: 'Els Bakker', company: '', email: 'els@bakker.example', phone: '', street: 'Tuinstraat 1', postcode: '8071 AB', city: 'Nunspeet', note: '', shippingMethod: 'dpd', country: 'NL', action: 'place' };

/**
 * Wacht tot een voorwaarde waar is (de mails gaan los van het antwoord weg).
 * @param {Function} check Geeft iets waars zodra het klaar is.
 * @returns {Promise<*>} De waarde van check.
 */
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Voorwaarde niet bereikt.');
}

/**
 * Hoofdtenant met beheerder, een artikel, een tweede organisatie en twee klanten; mails worden onderschept.
 * @returns {Promise<object>} base, admin, vreemd, sent (verstuurde mails), mailFailing (zet .on aan om mails te laten mislukken) en shoppers (twee klanten).
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const sent = [];
  const mailFailing = { on: false };
  /**
   * Mailserver die elk bericht onderschept (of laat mislukken zolang mailFailing.on aan staat).
   * @returns {{ configured: Function, send: Function }} De nagebootste mailserver.
   */
  const mailerFor = () => ({ configured: () => true, send: async (message) => { if (mailFailing.on) throw new Error('Mailserver onbereikbaar'); sent.push(message); } });
  const { server, base } = await listen(createApp({ secret: SECRET, db, mailerFor }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  await admin.put('/api/admin/settings', { storefront: true, shopOrdering: true, shopShipping: {
    pickup: { enabled: true }, dpd: { enabled: true, defaultWeightGrams: 1000, zones: [{ country: 'NL', tiers: [{ upToGrams: 2000, price: 6.95 }] }] },
  } });
  assert.strictEqual((await admin.post('/api/stock/items', { code: 'BUS', name: 'Sproeier', onHand: 50, salePrice: 10, weightGrams: 400 })).status, 201);
  let counter = 0;
  /**
   * Registreert een klant in de shop.
   * @returns {Promise<object>} De client.
   */
  const shopper = async () => {
    counter += 1;
    const client = createClient(base);
    await postForm(base, client, '/winkel/registreren/', { displayName: `Klant ${counter}`, email: `k${counter}@voorbeeld.nl`, password: PW, password2: PW, website: '' });
    return { client };
  };
  return { base, admin, vreemd: await createLogin(base, { password: PW })('vreemd', 'ander'), sent, mailFailing, shoppers: [await shopper(), await shopper()] };
}

/**
 * Bestelt twee sproeiers en geeft het id van de nieuwste bestelling.
 * @param {object} world Het resultaat van setup.
 * @param {object} shopper De klant.
 * @param {object} [fields] Andere afrekengegevens (bijvoorbeeld ophalen).
 * @returns {Promise<string>} Id van de bestelling.
 */
async function order(world, shopper, fields = {}) {
  await postForm(world.base, shopper.client, '/winkel/winkelwagen/', { action: 'add', code: 'BUS', qty: '2' });
  const placed = await postCheckout(world.base, shopper.client, { ...PERSON, ...fields });
  assert.strictEqual(placed.status, 303, placed.text);
  return (await world.admin.get('/api/admin/web-orders')).body.items[0].id;
}

/**
 * Zoekt de verzonden mails voor een onderwerp.
 * @param {object[]} sent Alle onderschepte mails.
 * @param {RegExp} subject Het onderwerp.
 * @returns {object[]} De mails.
 */
const mailsWith = (sent, subject) => sent.filter((message) => subject.test(message.subject));

module.exports = { setup, order, until, mailsWith, PERSON, PW };
