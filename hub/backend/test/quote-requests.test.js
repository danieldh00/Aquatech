// Offerte aanvragen vanuit de winkelwagen: alleen een zakelijke klant vanaf het drempelbedrag; het maakt een concept in Offertes
// met de webshopprijzen excl. btw en meldt het aan het bedrijf; een particulier of een te kleine wagen kan het niet.
const test = require('node:test');
const assert = require('node:assert');
const { setup, mailsWith } = require('./helpers/webshop-world');
const { postForm } = require('./helpers/http-client');
const { qualifies, cartExcl, QUOTE_REQUEST_MIN_EXCL } = require('../src/webshop/quote-requests');

const BUTTON = /Offerte aanvragen</;

test('qualifies: alleen zakelijke prijzen, bestelbaar en vanaf het drempelbedrag', () => {
  /**
   * Eén winkelwagenregel met het gegeven bedrag excl. btw.
   * @param {number} amount Het bedrag.
   * @returns {object[]} De regels.
   */
  const lines = (amount) => [{ lineExcl: amount }];
  assert.strictEqual(qualifies({ pricesExcl: true, ok: true, lines: lines(QUOTE_REQUEST_MIN_EXCL) }), true);
  assert.strictEqual(qualifies({ pricesExcl: true, ok: true, lines: lines(QUOTE_REQUEST_MIN_EXCL - 0.01) }), false);
  assert.strictEqual(qualifies({ pricesExcl: false, ok: true, lines: lines(9999) }), false, 'particulier');
  assert.strictEqual(qualifies({ pricesExcl: true, ok: false, lines: lines(9999) }), false, 'niet alles bestelbaar');
  assert.strictEqual(qualifies({ pricesExcl: true, ok: true, lines: [] }), false);
  assert.strictEqual(cartExcl({ lines: [{ lineExcl: 10.1 }, { lineExcl: 0.2 }, {}] }), 10.3);
});

test('offerte aanvragen: knop vanaf 500 euro excl. btw voor een zakelijke klant, maakt een concept en meldt het aan het bedrijf', async () => {
  const world = await setup();
  const [shopper, other] = world.shoppers;
  assert.strictEqual((await world.admin.put('/app/api/admin/settings', { quoteProfile: { email: 'verkoop@aquatech.example', companyName: 'AquaTech' } })).status, 200);
  const user = world.db.prepare('SELECT id, tenant_id FROM users WHERE email = ?').get('k1@voorbeeld.nl');
  // Een particulier ziet geen knop en kan het ook niet afdwingen.
  await postForm(world.base, other.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '50' });
  assert.doesNotMatch((await other.client.get('/winkelwagen/')).text, BUTTON);
  assert.strictEqual((await postForm(world.base, other.client, '/winkelwagen/offerte/', {})).status, 303);
  assert.strictEqual(world.db.prepare('SELECT COUNT(*) AS n FROM quotes').get().n, 0);
  // Zakelijk maar onder het drempelbedrag: geen knop.
  assert.strictEqual((await world.admin.patch(`/app/api/admin/users/${user.id}`, { customerGroup: 'zakelijk' })).status, 200);
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '40' });
  assert.doesNotMatch((await shopper.client.get('/winkelwagen/')).text, BUTTON);
  await postForm(world.base, shopper.client, '/winkelwagen/offerte/', {});
  assert.strictEqual(world.db.prepare('SELECT COUNT(*) AS n FROM quotes').get().n, 0, 'te kleine wagen');
  // Vanaf 500 euro excl. btw (50 × 10): knop, aanvraag, concept.
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'set', code: 'BUS', qty: '50' });
  assert.match((await shopper.client.get('/winkelwagen/')).text, BUTTON);
  const sent = await postForm(world.base, shopper.client, '/winkelwagen/offerte/', {});
  assert.strictEqual(sent.status, 303);
  assert.match(sent.location, /offerte=ja/);
  assert.match((await shopper.client.get('/winkelwagen/?offerte=ja')).text, /offerteaanvraag is ontvangen/);
  const quote = world.db.prepare('SELECT status, customer_id, total_excl, data FROM quotes').get();
  assert.strictEqual(quote.status, 'concept');
  assert.strictEqual(quote.customer_id, user.id);
  assert.strictEqual(quote.total_excl, 500);
  const data = JSON.parse(quote.data);
  assert.deepStrictEqual(data.lines.map((line) => [line.code, line.qty, line.price, line.section]), [['BUS', 50, 10, 'materiaal']]);
  assert.match(data.internalNote, /Aangevraagd door de klant/);
  // Een dubbelklik of herlaad met dezelfde wagen maakt geen tweede concept en geen tweede mail.
  assert.strictEqual((await postForm(world.base, shopper.client, '/winkelwagen/offerte/', {})).status, 303);
  assert.strictEqual(world.db.prepare('SELECT COUNT(*) AS n FROM quotes').get().n, 1);
  assert.strictEqual(mailsWith(world.sent, /Offerteaanvraag via de webshop/).length, 1);
  assert.strictEqual(world.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'webshop_offerte_aangevraagd'").get().n, 1, 'één auditregel');
  assert.ok(data.validUntil && data.title);
  // De wagen blijft bewaard en een medewerker ziet de offerte in Offertes.
  assert.match((await shopper.client.get('/winkelwagen/')).text, /Sproeier/);
  const listed = await world.admin.get('/app/api/quotes?all=1');
  assert.strictEqual(listed.status, 200);
  assert.strictEqual(listed.body.items.length, 1);
  const mails = mailsWith(world.sent, /Offerteaanvraag via de webshop/);
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'verkoop@aquatech.example');
  assert.match(mails[0].text, /verstuur de offerte zelf|verstuur hem zelf/);
});

test('offerte aanvragen: niet ingelogd gaat naar inloggen en meer dan vijf per uur wordt begrensd', async () => {
  const world = await setup();
  const { createClient } = require('./helpers/http-client');
  const visitor = createClient(world.base);
  const anonymous = await postForm(world.base, visitor, '/winkelwagen/offerte/', {});
  assert.strictEqual(anonymous.status, 303);
  assert.match(anonymous.location, /inloggen/);
  const [shopper] = world.shoppers;
  const user = world.db.prepare('SELECT id FROM users WHERE email = ?').get('k1@voorbeeld.nl');
  await world.admin.patch(`/app/api/admin/users/${user.id}`, { customerGroup: 'zakelijk' });
  await postForm(world.base, shopper.client, '/winkelwagen/', { action: 'add', code: 'BUS', qty: '50' });
  const statuses = [];
  for (let attempt = 0; attempt < 7; attempt += 1) statuses.push((await postForm(world.base, shopper.client, '/winkelwagen/offerte/', {})).status);
  assert.deepStrictEqual(statuses, [303, 303, 303, 303, 303, 429, 429]);
  assert.strictEqual(world.db.prepare('SELECT COUNT(*) AS n FROM quotes').get().n, 1, 'steeds dezelfde wagen: één concept');
});
