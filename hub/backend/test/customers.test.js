// Klanten: de klantenlijst met zoeken en pagina's, een klant aanmaken (met PDOK-adres, zonder inlog), wijzigen,
// de klantkaart met documenten, de uitnodiging per mail, rechten en scheiding tussen organisaties.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createLogin, createClient, listen, postForm } = require('./helpers/http-client');
const { createPdokFake, KNOWN_ADDRESS } = require('./helpers/pdok-fake');
const { createViesFake } = require('./helpers/vies-fake');

const SECRET = 'c'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });

/**
 * Hoofdtenant met beheerder, installateur, planner, een klant met inlog en een andere organisatie.
 * @param {{ mail?: boolean }} [options] mail: false = geen mailserver ingesteld.
 * @returns {Promise<object>} base, db, store, main, as (login), sent (verstuurde mails), admin en installer.
 */
async function setup({ mail = true, vies = createViesFake({ valid: ['DE123456789'] }) } = {}) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'monteur', displayName: 'Monteur', role: 'installateur', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'planner1', displayName: 'Planner', role: 'planner', password: PW }, { mustChangePassword: false });
  await store.createAccount(main, { username: 'klant1', displayName: 'Klant Eén', role: 'klant', password: PW }, { mustChangePassword: false });
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  await store.createAccount(other.id, { username: 'vreemd', displayName: 'Vreemd', role: 'beheerder', password: PW, mustChangePassword: false });
  const sent = [];
  /**
   * Nep-mailserver die de berichten bewaart.
   * @returns {{ configured: Function, send: Function }} De mailfuncties.
   */
  const mailerFor = () => ({ configured: () => mail, send: async (message) => { sent.push(message); } });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, mailerFor, addressFetch: createPdokFake().fetchImpl, viesFetch: vies.fetchImpl, loginDelayMs: 0 }));
  servers.push(server);
  const as = createLogin(base, { password: PW });
  const admin = await as('baas');
  assert.strictEqual((await admin.put('/app/api/admin/settings', { storefront: true, shopPayment: { online: false, publicUrl: `${base}/` } })).status, 200);
  return { base, db, store, main, as, sent, admin, installer: await as('monteur') };
}

test('een klant aanmaken zonder inlog, met adres, en terugvinden met zoeken', async () => {
  const { installer } = await setup();
  const made = await installer.post('/app/api/customers', { displayName: 'Jansen Tuinen', email: 'Info@Jansen.nl', phone: '06 12345678', address: KNOWN_ADDRESS });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const customer = made.body.customer;
  assert.strictEqual(customer.displayName, 'Jansen Tuinen');
  assert.strictEqual(customer.email, 'info@jansen.nl');
  assert.strictEqual(customer.address, KNOWN_ADDRESS);
  assert.strictEqual(customer.hasLogin, false);
  assert.strictEqual(customer.customerGroup, '');
  assert.strictEqual(made.body.invite, null);
  // Zoeken op naam, e-mail, telefoon en adres; leeg filter geeft alle klanten.
  for (const query of ['jansen', 'INFO@jansen', '12345678', 'tuinstraat', 'jansen nunspeet']) {
    const found = await installer.get(`/app/api/customers?q=${encodeURIComponent(query)}`);
    assert.deepStrictEqual(found.body.items.map((item) => item.displayName), ['Jansen Tuinen'], query);
  }
  assert.strictEqual((await installer.get('/app/api/customers?q=bestaatniet')).body.total, 0);
  assert.strictEqual((await installer.get('/app/api/customers')).body.total, 2);
  // % en _ zijn gewone tekens in de zoekopdracht.
  assert.strictEqual((await installer.get('/app/api/customers?q=%25')).body.total, 0);
});

test('ongeldige invoer wordt geweigerd en het adres moet bij PDOK bestaan', async () => {
  const { installer, admin } = await setup();
  assert.strictEqual((await installer.post('/app/api/customers', { displayName: '  ' })).status, 400);
  assert.strictEqual((await installer.post('/app/api/customers', { displayName: 'X', email: 'geen-mail' })).body.field, 'email');
  assert.strictEqual((await installer.post('/app/api/customers', { displayName: 'X', phone: 'abc' })).body.field, 'phone');
  assert.strictEqual((await installer.post('/app/api/customers', { displayName: 'X', address: 'Verzonnen 99\n1234 AB Nergens' })).status, 400);
  assert.strictEqual((await installer.post('/app/api/customers', { displayName: 'X', customerGroup: 'vip' })).body.field, 'customerGroup');
  const noCompany = await admin.post('/app/api/customers', { displayName: 'Bedrijf', customerGroup: 'zakelijk' });
  assert.strictEqual(noCompany.status, 400);
  assert.strictEqual(noCompany.body.field, 'companyName');
});

test('een zakelijke klant aanmaken vult de bedrijfsgegevens', async () => {
  const { installer, admin } = await setup();
  const body = { displayName: 'Piet Bos', customerGroup: 'zakelijk', companyName: 'Bos Hoveniers BV', kvkNumber: '12345678', vatNumber: 'NL123456789B01' };
  assert.strictEqual((await installer.post('/app/api/customers', body)).status, 403, 'een installateur kent geen zakelijke prijzen toe');
  const made = await admin.post('/app/api/customers', body);
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.strictEqual(made.body.customer.customerGroup, 'zakelijk');
  assert.strictEqual(made.body.customer.companyName, 'Bos Hoveniers BV');
  const business = await installer.get('/app/api/customers?group=zakelijk');
  assert.strictEqual(business.body.total, 1);
  assert.strictEqual((await installer.get('/app/api/customers?group=particulier')).body.total, 1);
  // Zoeken op de bedrijfsnaam.
  assert.strictEqual((await installer.get('/app/api/customers?q=hoveniers')).body.total, 1);
});

test('wijzigen: contactgegevens door een installateur, klantgroep en groothandel alleen door een beheerder', async () => {
  const { admin, installer } = await setup();
  const id = (await installer.post('/app/api/customers', { displayName: 'Els', email: 'els@voorbeeld.nl' })).body.customer.id;
  const changed = await installer.patch(`/app/api/customers/${id}`, { displayName: 'Els de Vries', phone: '0612345678', address: KNOWN_ADDRESS });
  assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
  assert.strictEqual(changed.body.customer.displayName, 'Els de Vries');
  assert.strictEqual(changed.body.customer.phone, '0612345678');
  assert.strictEqual(changed.body.customer.email, 'els@voorbeeld.nl');
  // Prijsgevoelig: 403 voor een installateur, wel voor een beheerder.
  assert.strictEqual((await installer.patch(`/app/api/customers/${id}`, { customerGroup: 'zakelijk' })).status, 403);
  assert.strictEqual((await installer.patch(`/app/api/customers/${id}`, { wholesale: true })).status, 403);
  assert.strictEqual((await admin.patch(`/app/api/customers/${id}`, { companyName: 'Els BV', kvkNumber: '12345678', customerGroup: 'zakelijk' })).status, 200);
  const wholesale = await admin.patch(`/app/api/customers/${id}`, { wholesale: true, wholesaleDiscount: 7.5 });
  assert.strictEqual(wholesale.body.customer.wholesale, true);
  assert.strictEqual(wholesale.body.customer.wholesaleDiscount, 7.5);
  assert.strictEqual((await admin.patch(`/app/api/customers/${id}`, { wholesaleDiscount: 80 })).status, 400);
  // Een deel van de bedrijfsgegevens vult het bestaande profiel aan; een ongeldig KvK-nummer wordt geweigerd.
  assert.strictEqual((await installer.patch(`/app/api/customers/${id}`, { vatNumber: 'NL123456789B01' })).body.customer.vatNumber, 'NL123456789B01');
  assert.strictEqual((await installer.patch(`/app/api/customers/${id}`, { kvkNumber: '12' })).body.field, 'kvkNumber');
  // Particulier maken haalt de groothandel weg.
  const back = await admin.patch(`/app/api/customers/${id}`, { customerGroup: '' });
  assert.strictEqual(back.body.customer.wholesale, false);
  // Leeg verzoek verandert niets.
  assert.strictEqual((await installer.patch(`/app/api/customers/${id}`, {})).status, 200);
});

test('rechten: planner en klant mogen niet bij de klanten; onbekende klant, andere organisatie en medewerker geven 404', async () => {
  const { as, installer, admin } = await setup();
  const id = (await installer.post('/app/api/customers', { displayName: 'Zonder inlog' })).body.customer.id;
  for (const who of ['planner1', 'klant1']) {
    const client = await as(who);
    assert.strictEqual((await client.get('/app/api/customers')).status, 403, who);
    assert.strictEqual((await client.get(`/app/api/customers/${id}`)).status, 403, who);
    assert.strictEqual((await client.post('/app/api/customers', { displayName: 'Nieuw' })).status, 403, who);
    assert.strictEqual((await client.patch(`/app/api/customers/${id}`, { displayName: 'Hack' })).status, 403, who);
    assert.strictEqual((await client.post(`/app/api/customers/${id}/invite`, {})).status, 403, who);
  }
  const foreign = await as('vreemd', 'ander');
  assert.strictEqual((await foreign.get(`/app/api/customers/${id}`)).status, 404);
  assert.strictEqual((await foreign.patch(`/app/api/customers/${id}`, { displayName: 'Hack' })).status, 404);
  assert.strictEqual((await foreign.post(`/app/api/customers/${id}/invite`, {})).status, 404);
  assert.strictEqual((await foreign.get('/app/api/customers')).body.total, 0);
  // Een medewerker is geen klant.
  const staffId = (await admin.get('/app/api/admin/users')).body.items.find((user) => user.username === 'monteur').id;
  assert.strictEqual((await installer.get(`/app/api/customers/${staffId}`)).status, 404);
  assert.strictEqual((await installer.patch(`/app/api/customers/${staffId}`, { displayName: 'Hack' })).status, 404);
  assert.strictEqual((await installer.get('/app/api/customers/bestaat-niet')).status, 404);
});

test('de klantkaart toont offertes, werkorders en facturen van de klant, alleen met het juiste recht', async () => {
  const { admin, installer, as } = await setup();
  const id = (await installer.post('/app/api/customers', { displayName: 'Kaart Klant', address: KNOWN_ADDRESS })).body.customer.id;
  const quote = await installer.post('/app/api/quotes', { customerId: id, data: { title: 'Tuin', customer: { name: 'Kaart Klant', address: KNOWN_ADDRESS } } });
  assert.strictEqual(quote.status, 201, JSON.stringify(quote.body));
  const card = await installer.get(`/app/api/customers/${id}`);
  assert.strictEqual(card.status, 200);
  assert.strictEqual(card.body.quotes.length, 1);
  assert.strictEqual(card.body.quotes[0].id, quote.body.id);
  assert.deepStrictEqual(card.body.workOrders, []);
  assert.strictEqual(card.body.invoices, null, 'een installateur heeft geen recht op facturen');
  assert.strictEqual(card.body.dossierKey, `a-${id}`);
  assert.strictEqual(card.body.mayPrice, false);
  const adminCard = await admin.get(`/app/api/customers/${id}`);
  assert.deepStrictEqual(adminCard.body.invoices, []);
  assert.strictEqual(adminCard.body.mayPrice, true);
  // Een klant van een andere klant staat er niet bij.
  const other = (await installer.post('/app/api/customers', { displayName: 'Ander' })).body.customer.id;
  assert.deepStrictEqual((await installer.get(`/app/api/customers/${other}`)).body.quotes, []);
  assert.ok(await as('monteur'));
});

test('uitnodigen: mail met wachtwoordlink van zeven dagen, daarna kan de klant inloggen', async () => {
  const { base, installer, sent, as } = await setup();
  const made = await installer.post('/app/api/customers', { displayName: 'Uitgenodigd', email: 'uit@voorbeeld.nl', invite: true });
  assert.strictEqual(made.status, 201);
  assert.deepStrictEqual(made.body.invite, { sent: true, problem: '' });
  const mail = sent.find((message) => message.to === 'uit@voorbeeld.nl');
  assert.ok(mail, 'uitnodiging verstuurd');
  assert.strictEqual(mail.subject, 'Je klantaccount staat klaar');
  const token = /#t=([A-Za-z0-9_-]+)/.exec(mail.text)[1];
  const done = await postForm(base, createClient(base), '/wachtwoord-herstellen/', { token, password: 'Nieuw-Wachtwoord-2026!', password2: 'Nieuw-Wachtwoord-2026!' });
  assert.strictEqual(done.status, 200, done.text.slice(0, 300));
  const customer = (await installer.get(`/app/api/customers/${made.body.customer.id}`)).body.customer;
  assert.strictEqual(customer.hasLogin, true);
  // Een klant met inlog: geen nieuwe uitnodiging en geen adreswijziging door een installateur (accountovername).
  const again = await installer.post(`/app/api/customers/${customer.id}/invite`, {});
  assert.strictEqual(again.status, 409);
  assert.match(again.body.message, /al inloggen/);
  assert.strictEqual((await installer.patch(`/app/api/customers/${customer.id}`, { email: 'overname@voorbeeld.nl' })).status, 403);
  assert.strictEqual((await installer.patch(`/app/api/customers/${customer.id}`, { phone: '0612345678' })).status, 200);
  // De link werkt maar één keer.
  assert.strictEqual((await postForm(base, createClient(base), '/wachtwoord-herstellen/', { token, password: PW, password2: PW })).status, 400);
  assert.ok(as);
});

test('uitnodigen: duidelijke melding zonder e-mailadres of zonder mailserver; opnieuw uitnodigen kan', async () => {
  const noMail = await setup({ mail: false });
  const made = await noMail.installer.post('/app/api/customers', { displayName: 'Zonder mail', email: 'a@voorbeeld.nl', invite: true });
  assert.strictEqual(made.status, 201, 'de klant is wel aangemaakt');
  assert.strictEqual(made.body.invite.sent, false);
  assert.match(made.body.invite.problem, /mailserver/);
  const refused = await noMail.installer.post(`/app/api/customers/${made.body.customer.id}/invite`, {});
  assert.strictEqual(refused.status, 409);
  assert.match(refused.body.message, /mailserver/);
  const { installer } = await setup();
  const noAddress = (await installer.post('/app/api/customers', { displayName: 'Geen adres' })).body.customer.id;
  const noEmail = await installer.post(`/app/api/customers/${noAddress}/invite`, {});
  assert.strictEqual(noEmail.status, 409);
  assert.match(noEmail.body.message, /e-mailadres/);
  const card = await installer.get(`/app/api/customers/${noAddress}`);
  assert.match(card.body.inviteProblem, /e-mailadres/);
  // Met mail en adres lukt een nieuwe uitnodiging.
  await installer.patch(`/app/api/customers/${noAddress}`, { email: 'geen@voorbeeld.nl' });
  assert.strictEqual((await installer.post(`/app/api/customers/${noAddress}/invite`, {})).status, 200);
});

test('de lijst is gepagineerd en een klant zonder e-mail krijgt een eigen gebruikersnaam', async () => {
  const { installer, store, main } = await setup();
  for (let index = 1; index <= 5; index += 1) await installer.post('/app/api/customers', { displayName: `Klant ${String(index).padStart(2, '0')}` });
  const firstPage = (await installer.get('/app/api/customers?limit=3')).body;
  assert.strictEqual(firstPage.total, 6);
  assert.strictEqual(firstPage.items.length, 3);
  const secondPage = (await installer.get('/app/api/customers?limit=3&offset=3')).body;
  assert.strictEqual(secondPage.items.length, 3);
  assert.strictEqual(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size, 6, 'geen dubbele of ontbrekende regels');
  const names = [...firstPage.items, ...secondPage.items].map((item) => item.displayName);
  assert.deepStrictEqual(names, [...names].sort((left, right) => left.localeCompare(right)));
  assert.ok(store.getCustomer([main], firstPage.items[0].id));
  assert.ok(firstPage.items.every((item) => /^klant-[0-9a-f]{8}$/.test(item.username) || item.username === 'klant1'));
});

test('nieuwe klant: hetzelfde e-mailadres twee keer wordt geweigerd', async () => {
  const { installer } = await setup();
  assert.strictEqual((await installer.post('/app/api/customers', { displayName: 'Eerste', email: 'dubbel@voorbeeld.nl' })).status, 201);
  const second = await installer.post('/app/api/customers', { displayName: 'Tweede', email: 'Dubbel@voorbeeld.nl' });
  assert.strictEqual(second.status, 400);
  assert.strictEqual(second.body.field, 'email');
  // Ook bij wijzigen: het adres van een ander account mag niet.
  const third = (await installer.post('/app/api/customers', { displayName: 'Derde' })).body.customer;
  const clash = await installer.patch(`/app/api/customers/${third.id}`, { email: 'dubbel@voorbeeld.nl' });
  assert.strictEqual(clash.status, 400);
  assert.strictEqual(clash.body.field, 'email');
  assert.strictEqual((await installer.patch(`/app/api/customers/${third.id}`, { email: 'derde@voorbeeld.nl' })).status, 200);
  assert.strictEqual((await installer.patch(`/app/api/customers/${third.id}`, { email: 'derde@voorbeeld.nl' })).status, 200, 'eigen adres opnieuw opslaan mag');
});

test('uitnodigen: begrensd per medewerker', async () => {
  const { installer } = await setup();
  let last = 0;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    last = (await installer.post('/app/api/customers', { displayName: `Klant ${attempt}`, email: `k${attempt}@voorbeeld.nl`, invite: true })).status;
  }
  assert.strictEqual(last, 429);
});

test('klantkeuze in de offerte: zoekt, begrenst op 20 en laat uitgeschakelde klanten weg', async () => {
  const { installer, store, main } = await setup();
  for (let index = 0; index < 22; index += 1) {
    assert.strictEqual((await installer.post('/app/api/customers', { displayName: `Keuzeklant ${String(index).padStart(2, '0')}`, email: `keuze${index}@voorbeeld.nl` })).status, 201);
  }
  const all = (await installer.get('/app/api/quote-customers?q=keuzeklant')).body.items;
  assert.strictEqual(all.length, 20);
  const one = (await installer.get('/app/api/quote-customers?q=keuze21@')).body.items;
  assert.deepStrictEqual(one.map((customer) => customer.displayName), ['Keuzeklant 21']);
  assert.strictEqual(one[0].email, 'keuze21@voorbeeld.nl');
  assert.ok(!(await store.updateAccount(main, one[0].id, { disabled: true })).error);
  assert.deepStrictEqual((await installer.get('/app/api/quote-customers?q=keuze21@')).body.items, []);
});

test('klantkeuze in de offerte: geen klanten van een andere organisatie, en zonder recht offertes 403', async () => {
  const { installer, as } = await setup();
  assert.strictEqual((await installer.post('/app/api/customers', { displayName: 'Gedeelde Zoekterm Eigen' })).status, 201);
  const foreign = await as('vreemd', 'ander');
  assert.strictEqual((await foreign.post('/app/api/customers', { displayName: 'Gedeelde Zoekterm Vreemd' })).status, 201);
  const own = (await installer.get('/app/api/quote-customers?q=gedeelde%20zoekterm')).body.items;
  assert.deepStrictEqual(own.map((customer) => customer.displayName), ['Gedeelde Zoekterm Eigen']);
  const theirs = (await foreign.get('/app/api/quote-customers?q=gedeelde%20zoekterm')).body.items;
  assert.deepStrictEqual(theirs.map((customer) => customer.displayName), ['Gedeelde Zoekterm Vreemd']);
  // Een klant van de andere organisatie kan niet aan een eigen offerte worden gehangen.
  const foreignId = theirs[0].id;
  const quote = await installer.post('/app/api/quotes', { data: {} });
  assert.strictEqual(quote.status, 201);
  const linked = await installer.put(`/app/api/quotes/${quote.body.id}`, { data: {}, customerId: foreignId });
  assert.strictEqual(linked.status, 400);
  assert.strictEqual(linked.body.error, 'invalid_customer');
  const planner = await as('planner1');
  assert.strictEqual((await planner.get('/app/api/quote-customers?q=gedeelde')).status, 403);
});

test('klant zonder KvK-nummer: zakelijk mag, een ongeldig KvK-nummer niet', async () => {
  const { admin } = await setup();
  const made = await admin.post('/app/api/customers', { displayName: 'Hans', customerGroup: 'zakelijk', companyName: 'Hans GmbH' });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.strictEqual(made.body.customer.companyName, 'Hans GmbH');
  assert.strictEqual(made.body.customer.kvkNumber, '');
  assert.strictEqual((await admin.post('/app/api/customers', { displayName: 'Fout', customerGroup: 'zakelijk', companyName: 'X', kvkNumber: '12' })).body.field, 'kvkNumber');
  assert.strictEqual((await admin.post('/app/api/customers', { displayName: 'Fout', customerGroup: 'zakelijk', kvkNumber: '' })).body.field, 'companyName');
  // Wijzigen: KvK-nummer weghalen kan ook.
  const id = (await admin.post('/app/api/customers', { displayName: 'Els', customerGroup: 'zakelijk', companyName: 'Els BV', kvkNumber: '12345678' })).body.customer.id;
  const cleared = await admin.patch(`/app/api/customers/${id}`, { kvkNumber: '' });
  assert.strictEqual(cleared.status, 200, JSON.stringify(cleared.body));
  assert.strictEqual(cleared.body.customer.kvkNumber, '');
});

test('buitenlandse klant: vrij adres alleen met een door VIES geldig bevonden btw-nummer uit een ander land', async () => {
  const { admin, installer } = await setup();
  const foreign = 'Hauptstraße 5, 10115 Berlin, Duitsland';
  const base = { displayName: 'Hans', customerGroup: 'zakelijk', companyName: 'Hans GmbH', address: foreign };
  const noVat = await admin.post('/app/api/customers', base);
  assert.strictEqual(noVat.status, 400, 'zonder btw-nummer geldt PDOK');
  assert.strictEqual(noVat.body.field, 'address');
  assert.strictEqual((await admin.post('/app/api/customers', { ...base, vatNumber: 'DE999999999' })).status, 400, 'VIES noemt het nummer ongeldig');
  assert.strictEqual((await admin.post('/app/api/customers', { ...base, vatNumber: 'NL123456789B01' })).status, 400, 'een Nederlands nummer geeft geen vrij adres');
  assert.strictEqual((await admin.post('/app/api/customers', { ...base, address: 'Dorpsstraat 1, 1234 AB Dorp', vatNumber: 'DE123456789' })).status, 400, 'een Nederlandse postcode wordt altijd gecontroleerd');
  const made = await admin.post('/app/api/customers', { ...base, vatNumber: 'DE123456789' });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.strictEqual(made.body.customer.address, foreign);
  // Wijzigen met het opgeslagen btw-nummer: een installateur kan het adres aanpassen.
  const changed = await installer.patch(`/app/api/customers/${made.body.customer.id}`, { address: 'Berliner Allee 9, 10115 Berlin, Duitsland' });
  assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
});

test('buitenlandse klant: VIES onbereikbaar laat de adrescontrole gelden; een andere organisatie geeft 404', async () => {
  const { admin, as } = await setup({ vies: createViesFake({ valid: ['DE123456789'], down: true }) });
  const out = await admin.post('/app/api/customers', { displayName: 'Hans', customerGroup: 'zakelijk', companyName: 'Hans GmbH', vatNumber: 'DE123456789', address: 'Hauptstraße 5, Berlin' });
  assert.strictEqual(out.status, 400);
  const id = (await admin.post('/app/api/customers', { displayName: 'Zonder' })).body.customer.id;
  const other = await as('vreemd', 'ander');
  assert.strictEqual((await other.patch(`/app/api/customers/${id}`, { phone: '0612345678' })).status, 404);
  const planner = await as('planner1');
  assert.strictEqual((await planner.post('/app/api/customers', { displayName: 'X' })).status, 403);
});
