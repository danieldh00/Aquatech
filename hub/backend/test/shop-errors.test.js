// Foutmeldingen van de webshopkoppeling: een weigering van WooCommerce komt leesbaar bij de gebruiker, de
// oorzaak (status, adres, antwoord) alleen in de debugmodus, en een onverwachte fout wordt een 500 met foutcode
// in plaats van "De webshop is niet bereikbaar".
process.env.SHOP_ALLOW_INSECURE = '1';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { fetchProducts, sanitizeShop, respondShopError, SourceError } = require('../src/webshop/woocommerce');
const { createLogin, listen } = require('./helpers/http-client');

const SECRET = 's'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const SHOP = { ...sanitizeShop({ url: 'http://shop.test', mode: 'rest' }), consumerKey: 'ck_test_1234567890', consumerSecret: 'cs_test_1234567890' };

/**
 * Een antwoord zoals fetch het geeft, met alleen text().
 * @param {number} status De HTTP-status.
 * @param {string} text De inhoud.
 * @returns {object} Het antwoord.
 */
const reply = (status, text) => ({ ok: status < 400, status, headers: new Headers({ 'x-wp-totalpages': '1' }), text: async () => text });

test('webshopfout: weigering met de melding van WooCommerce, oorzaak met status en antwoord', async () => {
  const refused = await fetchProducts(SHOP, { fetchImpl: async () => reply(400, '{"code":"product_invalid_sku","message":"<b>Ongeldige</b> of dubbele SKU."}'), allowInsecure: true }).catch((error) => error);
  assert.ok(refused instanceof SourceError);
  assert.strictEqual(refused.code, 'bad_status');
  assert.strictEqual(refused.message, 'De webshop antwoordt met status 400: Ongeldige of dubbele SKU.');
  assert.match(refused.cause.message, /^Webshop 400 op http:\/\/shop\.test\/wp-json\/wc\/v3\/products: \{"code":"product_invalid_sku"/);

  // Een serverfout van de webshop: de melding blijft kort, het antwoord staat in de oorzaak.
  const broken = await fetchProducts(SHOP, { fetchImpl: async () => reply(500, '<html>Fatal error in plugin</html>'), allowInsecure: true }).catch((error) => error);
  assert.strictEqual(broken.message, 'De webshop antwoordt met status 500.');
  assert.match(broken.cause.message, /Fatal error in plugin/);

  const unreachable = await fetchProducts(SHOP, { fetchImpl: async () => { throw new TypeError('fetch failed'); }, allowInsecure: true }).catch((error) => error);
  assert.strictEqual(unreachable.code, 'unreachable');
  assert.strictEqual(unreachable.cause.message, 'fetch failed');

  const garbage = await fetchProducts(SHOP, { fetchImpl: async () => reply(200, 'geen json'), allowInsecure: true }).catch((error) => error);
  assert.strictEqual(garbage.code, 'invalid_json');
  assert.match(garbage.cause.message, /begin van het antwoord: geen json/);
});

test('webshopfout: respondShopError stuurt een SourceError terug en laat een onverwachte fout door', () => {
  const sent = {};
  const res = {
    locals: {},
    /**
     * Onthoudt de status.
     * @param {number} status De status.
     * @returns {object} Het antwoord.
     */
    status(status) { sent.status = status; return this; },
    /**
     * Onthoudt de body.
     * @param {object} body De body.
     * @returns {object} Het antwoord.
     */
    json(body) { sent.body = body; return this; },
  };
  const shopError = new SourceError('unauthorized', 'De webshop weigert de toegang.');
  respondShopError(res, shopError, () => assert.fail('next mag niet'));
  assert.deepStrictEqual(sent, { status: 502, body: { error: 'unauthorized', message: 'De webshop weigert de toegang.' } });
  assert.strictEqual(res.locals.errorCause, shopError);

  const bug = new TypeError('Cannot read properties of undefined');
  let passed = null;
  respondShopError(res, bug, (error) => { passed = error; });
  assert.strictEqual(passed, bug);
});

test('webshopfout via de API: in de webshop zetten geeft de melding van WooCommerce, details alleen in de debugmodus', async () => {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  /**
   * Nagebootste webshop: lezen lukt (lege lijsten), een product aanmaken wordt geweigerd.
   * @param {string} url Het adres.
   * @param {object} [options] Fetch-opties.
   * @returns {Promise<object>} Het antwoord.
   */
  const shopFetch = async (url, options = {}) => ((options.method || 'GET') === 'GET'
    ? reply(200, '[]')
    : reply(400, '{"code":"woocommerce_rest_product_not_created","message":"De SKU KRAAN bestaat al."}'));
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db, shopFetch }));
  try {
    const as = createLogin(base, { password: PW });
    const baas = await as('baas');
    const kees = await as('kees');
    assert.strictEqual((await baas.put('/app/api/admin/shop', { url: 'http://shop.test', mode: 'rest', push: true, mirror: false, consumerKey: 'ck_test_1234567890', consumerSecret: 'cs_test_1234567890' })).status, 200);
    const item = (await kees.post('/app/api/stock/items', { code: 'KRAAN', name: 'Kraan', salePrice: 10 })).body;

    let response = await baas.post(`/app/api/stock/items/${item.id}/publish`, {});
    assert.strictEqual(response.status, 502, JSON.stringify(response.body));
    assert.strictEqual(response.body.error, 'bad_status');
    assert.strictEqual(response.body.message, 'De webshop antwoordt met status 400: De SKU KRAAN bestaat al.');
    assert.strictEqual(response.body.debug, undefined);

    assert.strictEqual((await baas.put('/app/api/admin/settings', { debugMode: true })).status, 200);
    response = await baas.post(`/app/api/stock/items/${item.id}/publish`, {});
    assert.strictEqual(response.status, 502);
    assert.match(response.body.debug.cause.message, /^De webshop antwoordt met status 400/);
    assert.match(JSON.stringify(response.body.debug), /woocommerce_rest_product_not_created/);
    assert.ok(!JSON.stringify(response.body.debug).includes('cs_test_1234567890'), 'geen sleutels in de details');
    // Een installateur ziet ook met de debugmodus aan geen details.
    response = await kees.post(`/app/api/stock/items/${item.id}/publish`, {});
    assert.strictEqual(response.status, 502);
    assert.strictEqual(response.body.debug, undefined);
  } finally {
    server.close();
  }
});
