// Inkooporder per e-mail naar de leverancier (artikelen/purchase-order-mail.js): alleen na een expliciete klik, met de PDF in de bijlage,
// het resultaat op de order, duidelijke fouten zonder mailserver of adres, en scheiding tussen rechten en organisaties.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { createPdokFake } = require('./helpers/pdok-fake');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { parseRecipients, createPurchaseOrderMailer } = require('../src/artikelen/purchase-order-mail');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';

/**
 * Hoofdtenant met beheerder, installateur en klant, een testserver en een nagebootste mailserver.
 * @param {{ configured?: boolean }} [options] `configured: false` = geen mailserver ingesteld.
 * @returns {Promise<object>} server, as (inloggen), sent (de verstuurde mails), mailer (gedrag aanpassen) en db.
 */
async function setup({ configured = true } = {}) {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(main, { username: 'klant', displayName: 'Klant', role: 'klant', password: PW });
  const sent = [];
  const mailer = { configured, failWith: null, delayMs: 0 };
  /**
   * De nagebootste mailserver: gedrag volgt `mailer` (ingesteld of niet, vertraging, fout).
   * @returns {{ configured: Function, send: Function }} De mailserver.
   */
  const mailerFor = () => ({
    configured: () => mailer.configured,
    send: async (message) => {
      if (mailer.delayMs) await new Promise((resolve) => setTimeout(resolve, mailer.delayMs));
      if (mailer.failWith) throw mailer.failWith;
      sent.push(message);
    },
  });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, addressFetch: createPdokFake().fetchImpl, secret: SECRET, db, mailerFor }));
  return { db, server, sent, mailer, as: createLogin(base, { password: PW }) };
}

/**
 * Maakt een leverancier (met e-mailadres) en een order met twee regels; de order is nog een concept.
 * @param {object} client De ingelogde client.
 * @param {object} [supplierFields] Velden van de leverancier.
 * @returns {Promise<object>} supplier en order.
 */
async function seed(client, supplierFields = { email: 'orders@tuintechniek.nl', contactName: 'Jan de Vries' }) {
  const supplier = (await client.post('/app/api/suppliers', { name: 'Tuintechniek', ...supplierFields })).body;
  const pipe = (await client.post('/app/api/stock/items', { code: 'PIJP', name: 'Pijp 25 mm', costPrice: 2 })).body;
  const valve = (await client.post('/app/api/stock/items', { code: 'KLEP', name: 'Klep', costPrice: 10 })).body;
  const created = await client.post('/app/api/purchase-orders', { supplierId: supplier.id, expectedDate: '2026-12-01', notes: 'Op de bouw leveren', lines: [{ itemId: pipe.id, qty: 50, unitCost: 1.5 }, { itemId: valve.id, qty: 4 }] });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  return { supplier, order: created.body };
}

/**
 * Zet een order op besteld.
 * @param {object} client De ingelogde client.
 * @param {object} order De order.
 * @returns {Promise<void>}
 */
async function place(client, order) {
  assert.strictEqual((await client.post(`/app/api/purchase-orders/${order.id}/place`)).status, 200);
}

test('ontvangers: geldige adressen, dubbele weg, hoogstens drie, ongeldige en kopregel-trucs geweigerd', () => {
  assert.deepStrictEqual(parseRecipients('a@b.nl, C@d.nl; a@B.nl'), { addresses: ['a@b.nl', 'C@d.nl'], invalid: false });
  assert.strictEqual(parseRecipients('').invalid, true);
  assert.strictEqual(parseRecipients('geen-adres').invalid, true);
  assert.strictEqual(parseRecipients('a@b.nl\nBcc: x@y.nl').invalid, true);
  assert.strictEqual(parseRecipients('a@b.nl, b@b.nl, c@b.nl, d@b.nl').invalid, true);
});

test('een order wordt nooit vanzelf verstuurd: bestellen en bewaren sturen niets', async () => {
  const { server, as, sent } = await setup();
  try {
    const kees = await as('kees');
    const { order } = await seed(kees);
    await place(kees, order);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual((await kees.get(`/app/api/purchase-orders/${order.id}`)).body.mail.sentAt, null);
  } finally {
    server.close();
  }
});

test('concept voor het scherm: adres van de leverancier, onderwerp, tekst en bestandsnaam; een concept-order mag nog niet weg', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const { order } = await seed(kees);
    const early = (await kees.get(`/app/api/purchase-orders/${order.id}/mail-draft`)).body;
    assert.strictEqual(early.canSend, false);
    assert.match(early.problem, /Bestellen/);
    await place(kees, order);
    const draft = (await kees.get(`/app/api/purchase-orders/${order.id}/mail-draft`)).body;
    assert.strictEqual(draft.canSend, true);
    assert.strictEqual(draft.problem, '');
    assert.strictEqual(draft.to, 'orders@tuintechniek.nl');
    assert.match(draft.subject, new RegExp(order.number));
    assert.match(draft.message, /^Beste Jan de Vries,/);
    assert.match(draft.message, new RegExp(order.number));
    assert.strictEqual(draft.fileName, `Inkooporder ${order.number}.pdf`);
    assert.deepStrictEqual(draft.mail, { sentAt: null, sentTo: '', sentBy: '', error: '' });
  } finally {
    server.close();
  }
});

test('versturen: alleen na een klik, met de PDF als bijlage, en het resultaat staat op de order', async () => {
  const { server, as, sent } = await setup();
  try {
    const kees = await as('kees');
    const { order } = await seed(kees);
    await place(kees, order);
    const out = await kees.post(`/app/api/purchase-orders/${order.id}/send`, {});
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.strictEqual(sent.length, 1);
    const mail = sent[0];
    assert.deepStrictEqual(mail.to, ['orders@tuintechniek.nl']);
    assert.match(mail.subject, new RegExp(order.number));
    assert.match(mail.text, /Beste Jan de Vries/);
    assert.strictEqual(mail.attachments.length, 1);
    assert.strictEqual(mail.attachments[0].filename, `Inkooporder ${order.number}.pdf`);
    assert.strictEqual(mail.attachments[0].contentType, 'application/pdf');
    assert.strictEqual(mail.attachments[0].content.subarray(0, 5).toString(), '%PDF-');
    assert.strictEqual(out.body.mail.sentTo, 'orders@tuintechniek.nl');
    assert.strictEqual(out.body.mail.sentBy, 'Kees');
    assert.strictEqual(out.body.mail.error, '');
    assert.ok(Date.now() - Date.parse(out.body.mail.sentAt) < 60000);
    // De status van de order verandert er niet door.
    assert.strictEqual(out.body.status, 'besteld');
    // Een tweede klik zonder bewuste keuze (of vanaf een tweede scherm) mailt niet nog eens.
    const again = await kees.post(`/app/api/purchase-orders/${order.id}/send`, {});
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.error, 'already_sent');
    assert.strictEqual(sent.length, 1);
    // Bewust opnieuw versturen mag en werkt de datum bij.
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${order.id}/send`, { resend: true })).status, 200);
    assert.strictEqual(sent.length, 2);
  } finally {
    server.close();
  }
});

test('versturen met een eigen adres, onderwerp en tekst: dat gaat precies zo de deur uit; stuurtekens uit het onderwerp', async () => {
  const { server, as, sent } = await setup();
  try {
    const kees = await as('kees');
    const { order } = await seed(kees);
    await place(kees, order);
    const out = await kees.post(`/app/api/purchase-orders/${order.id}/send`, { to: 'inkoop@ander.nl; extra@ander.nl', subject: 'Spoed\r\nBcc: x@y.nl', message: 'Eerste regel <b>vet</b>\n\nTweede alinea' });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.deepStrictEqual(sent[0].to, ['inkoop@ander.nl', 'extra@ander.nl']);
    assert.strictEqual(sent[0].subject, 'Spoed Bcc: x@y.nl');
    assert.match(sent[0].text, /^Eerste regel <b>vet<\/b>\n\nTweede alinea/);
    assert.match(sent[0].html, /Eerste regel &lt;b&gt;vet&lt;\/b&gt;/, 'html wordt ontsmet');
    assert.strictEqual(out.body.mail.sentTo, 'inkoop@ander.nl, extra@ander.nl');
  } finally {
    server.close();
  }
});

test('fouten: geen mailserver, geen of ongeldig adres, een order die nog niet besteld of al af is', async () => {
  const { server, as, sent, mailer } = await setup();
  try {
    const kees = await as('kees');
    const { order } = await seed(kees, { email: '' });
    const concept = await kees.post(`/app/api/purchase-orders/${order.id}/send`, { to: 'a@b.nl' });
    assert.strictEqual(concept.status, 409);
    assert.strictEqual(concept.body.error, 'not_sendable');
    await place(kees, order);
    const draft = (await kees.get(`/app/api/purchase-orders/${order.id}/mail-draft`)).body;
    assert.strictEqual(draft.to, '');
    assert.match(draft.problem, /Tuintechniek.*e-mailadres/);
    // Zonder adres bij de leverancier en zonder ingevuld adres: duidelijke melding.
    const noAddress = await kees.post(`/app/api/purchase-orders/${order.id}/send`, {});
    assert.strictEqual(noAddress.status, 400);
    assert.strictEqual(noAddress.body.error, 'invalid_to');
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${order.id}/send`, { to: 'geen adres' })).status, 400);
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${order.id}/send`, { to: 'a@b.nl\nBcc: x@y.nl' })).status, 400);
    // Zonder mailserver.
    mailer.configured = false;
    const noServer = await kees.post(`/app/api/purchase-orders/${order.id}/send`, { to: 'a@b.nl' });
    assert.strictEqual(noServer.status, 409);
    assert.strictEqual(noServer.body.error, 'not_configured');
    assert.match(noServer.body.message, /mailserver/);
    assert.match((await kees.get(`/app/api/purchase-orders/${order.id}/mail-draft`)).body.problem, /mailserver/);
    mailer.configured = true;
    // Een geannuleerde order gaat niet meer weg.
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${order.id}/cancel`)).status, 200);
    assert.strictEqual((await kees.post(`/app/api/purchase-orders/${order.id}/send`, { to: 'a@b.nl' })).status, 409);
    assert.strictEqual(sent.length, 0, 'bij elke fout is er niets verstuurd');
  } finally {
    server.close();
  }
});

test('een mislukte verzending: leesbare melding, fout bij de order, en een geslaagde poging wist die weer', async () => {
  const { server, as, sent, mailer } = await setup();
  try {
    const kees = await as('kees');
    const { order } = await seed(kees);
    await place(kees, order);
    mailer.failWith = Object.assign(new Error('nope'), { code: 'EAUTH', response: '535 Authentication unsuccessful' });
    const failed = await kees.post(`/app/api/purchase-orders/${order.id}/send`, {});
    assert.strictEqual(failed.status, 502);
    assert.strictEqual(failed.body.error, 'send_failed');
    assert.match(failed.body.message, /^Versturen mislukt/);
    assert.doesNotMatch(JSON.stringify(failed.body), /"debug"/);
    const stored = (await kees.get(`/app/api/purchase-orders/${order.id}`)).body;
    assert.strictEqual(stored.mail.sentAt, null);
    assert.match(stored.mail.error, /^Versturen mislukt/);
    mailer.failWith = null;
    const ok = await kees.post(`/app/api/purchase-orders/${order.id}/send`, {});
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.mail.error, '');
    assert.strictEqual(sent.length, 1);
  } finally {
    server.close();
  }
});

test('een dubbele klik: de tweede wordt geweigerd zolang de eerste loopt, er gaat één mail', async () => {
  const { server, as, sent, mailer } = await setup();
  try {
    const kees = await as('kees');
    const { order } = await seed(kees);
    await place(kees, order);
    mailer.delayMs = 150;
    const [first, second] = await Promise.all([
      kees.post(`/app/api/purchase-orders/${order.id}/send`, {}),
      kees.post(`/app/api/purchase-orders/${order.id}/send`, {}),
    ]);
    assert.deepStrictEqual([first.status, second.status].sort(), [200, 409]);
    assert.strictEqual(sent.length, 1);
  } finally {
    server.close();
  }
});

test('de PDF van de order: te openen, met de juiste bestandsnaam', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    const { order } = await seed(kees);
    const response = await kees.get(`/app/api/purchase-orders/${order.id}/pdf`);
    assert.strictEqual(response.status, 200);
    assert.match(String(response.headers.get ? response.headers.get('content-type') : response.headers['content-type']), /application\/pdf/);
  } finally {
    server.close();
  }
});

test('rechten en andere organisatie: klant 403, andere organisatie 404, en er gaat niets weg', async () => {
  const { server, as, sent } = await setup();
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    const { order } = await seed(kees);
    await place(kees, order);
    const klant = await as('klant');
    for (const [method, path] of [['get', `/app/api/purchase-orders/${order.id}/pdf`], ['get', `/app/api/purchase-orders/${order.id}/mail-draft`], ['post', `/app/api/purchase-orders/${order.id}/send`]]) {
      assert.strictEqual((await klant[method](path, ...(method === 'post' ? [{}] : []))).status, 403, `${method} ${path}`);
    }
    await baas.post('/app/api/platform/tenants', { name: 'Groen BV', slug: 'groen', admin: { username: 'piet', displayName: 'Piet', password: PW, mustChangePassword: false } });
    const piet = await as('piet', 'groen');
    assert.strictEqual((await piet.get(`/app/api/purchase-orders/${order.id}/pdf`)).status, 404);
    assert.strictEqual((await piet.get(`/app/api/purchase-orders/${order.id}/mail-draft`)).status, 404);
    assert.strictEqual((await piet.post(`/app/api/purchase-orders/${order.id}/send`, { to: 'a@b.nl' })).status, 404);
    assert.strictEqual(sent.length, 0);
  } finally {
    server.close();
  }
});

test('faalt het vastleggen na een geslaagde verzending, dan is er geen fout en een tweede klik mailt niet nog eens', async () => {
  const sent = [];
  const order = { id: 'o1', number: 'IO2026-0001', status: 'besteld', supplierId: 's1', supplierName: 'Tuintechniek', supplierReference: '', expectedDate: '', notes: '', createdAt: '2026-11-18T10:00:00Z', orderedAt: '2026-11-18T10:00:00Z', lines: [], mail: { sentAt: null, sentTo: '', sentBy: '', error: '' } };
  const mailer = createPurchaseOrderMailer({
    purchaseOrders: { get: () => order, markMail: () => { throw new Error('database weg'); } },
    suppliers: { get: () => ({ id: 's1', name: 'Tuintechniek', email: 'orders@tuintechniek.nl', contactName: '' }) },
    settingsFor: () => ({ get: () => ({ companyName: 'AquaTech' }) }),
    mailerFor: () => ({ configured: () => true, send: async (message) => { sent.push(message); } }),
    mailBody: (profile, paragraphs) => ({ text: paragraphs.join('\n\n'), html: paragraphs.join('<br>') }),
  });
  const result = await mailer.send('t1', 'o1', {}, { display_name: 'Kees' });
  assert.strictEqual(result.id, 'o1');
  assert.strictEqual(sent.length, 1);
  await assert.rejects(() => mailer.send('t1', 'o1', {}, { display_name: 'Kees' }), (error) => error.code === 'already_sent');
  assert.strictEqual(sent.length, 1);
  await mailer.send('t1', 'o1', { resend: true }, { display_name: 'Kees' });
  assert.strictEqual(sent.length, 2);
});

/**
 * Maakt een verzender met een opslag waarvan `markMail` per aanroep gedrag kan krijgen.
 * @param {Function} markMail De vervanger van `markMail` (krijgt tenant, id en wat vastgelegd wordt).
 * @param {object[]} sent Lijst waarin de verstuurde mails terechtkomen.
 * @returns {object} De verzender.
 */
function mailerWithMarkMail(markMail, sent) {
  const order = { id: 'o1', number: 'IO2026-0001', status: 'besteld', supplierId: 's1', supplierName: 'Tuintechniek', supplierReference: '', expectedDate: '', notes: '', createdAt: '2026-11-18T10:00:00Z', orderedAt: '2026-11-18T10:00:00Z', lines: [], mail: { sentAt: null, sentTo: '', sentBy: '', error: '' } };
  return createPurchaseOrderMailer({
    purchaseOrders: { get: () => order, markMail },
    suppliers: { get: () => ({ id: 's1', name: 'Tuintechniek', email: 'orders@tuintechniek.nl', contactName: '' }) },
    settingsFor: () => ({ get: () => ({ companyName: 'AquaTech' }) }),
    mailerFor: () => ({ configured: () => true, send: async (message) => { sent.push(message); } }),
    mailBody: (profile, paragraphs) => ({ text: paragraphs.join('\n\n'), html: paragraphs.join('<br>') }),
  });
}

test('lukt het vastleggen pas bij de tweede poging, dan komt de vastgelegde order terug', async () => {
  const sent = [];
  let calls = 0;
  const mailer = mailerWithMarkMail((tenantId, id, info) => {
    calls += 1;
    if (calls === 1) throw new Error('database even weg');
    return { id, recorded: true, mail: { sentAt: '2026-11-18T11:00:00Z', sentTo: info.to, sentBy: info.by, error: '' } };
  }, sent);
  const result = await mailer.send('t1', 'o1', {}, { display_name: 'Kees' });
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.recorded, true);
  assert.strictEqual(sent.length, 1);
});

test('falen beide pogingen, dan meldt het antwoord toch het adres dat de mail kreeg', async () => {
  const sent = [];
  const mailer = mailerWithMarkMail(() => { throw new Error('database weg'); }, sent);
  const result = await mailer.send('t1', 'o1', {}, { display_name: 'Kees' });
  assert.strictEqual(result.mail.sentTo, 'orders@tuintechniek.nl');
  assert.strictEqual(result.mail.sentBy, 'Kees');
  assert.ok(result.mail.sentAt);
  assert.strictEqual(sent.length, 1);
});
