// Webshopkoppeling: WooCommerce wordt nagebootst met een lokale server (geen echte shops).
process.env.SHOP_ALLOW_INSECURE = '1';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { fetchProducts, normalizeBaseUrl, sanitizeShop } = require('../src/webshop/woocommerce');
const { matchProducts, loadArticles } = require('../src/webshop/shop');

const SECRET = 'w'.repeat(64);
const PW = 'Tuin-Plan-2026!';

// 150 producten verdeeld over twee pagina's; enkele met sku = artikelcode.
function storeProducts() {
  const list = [
    { id: 1, sku: 'PE-25', name: 'PE buis 25mm per meter', permalink: 'https://shop.test/pe-25', prices: { price: '121', currency_code: 'EUR', currency_minor_unit: 2 }, is_in_stock: true },
    { id: 2, sku: 'pe25-alt', name: 'Andere buis', permalink: 'https://shop.test/pe-25b', prices: { price: '99', currency_minor_unit: 2 } },
    { id: 3, sku: 'VAL24', name: 'Magneetventiel Hunter PGV', permalink: 'https://shop.test/pgv', prices: { price: '3630', currency_minor_unit: 2 } },
  ];
  for (let i = 0; i < 147; i++) list.push({ id: 100 + i, sku: `X-${i}`, name: `Product ${i}`, prices: { price: '100', currency_minor_unit: 2 } });
  return list;
}

function startShop(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => { seen.push(req); handler(req, res); })
      .listen(0, () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const paged = (all, prefix) => (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith(prefix)) { res.writeHead(404); return res.end(); }
  const page = Number(u.searchParams.get('page'));
  const per = Number(u.searchParams.get('per_page'));
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-WP-TotalPages': String(Math.ceil(all.length / per)) });
  res.end(JSON.stringify(all.slice((page - 1) * per, page * per)));
};

test('webadres: alleen openbare https-adressen', () => {
  assert.strictEqual(normalizeBaseUrl('https://www.shop.nl/winkel/', { allowInsecure: false }), 'https://www.shop.nl/winkel');
  for (const bad of ['http://shop.nl', 'https://localhost', 'https://192.168.1.10', 'https://10.0.0.1', 'https://user:pw@shop.nl', 'ftp://shop.nl', 'geen url']) {
    assert.throws(() => normalizeBaseUrl(bad, { allowInsecure: false }), /webadres|https|inloggegevens/i, bad);
  }
  const s = sanitizeShop({ url: 'https://shop.nl/', mode: 'x', vatRate: 7, mapping: { 'PE-25': ' A ', 'kapot code': 'B', FILTER: 3 } });
  assert.deepStrictEqual([s.url, s.mode, s.vatRate, s.mapping], ['https://shop.nl', 'store', 21, { 'PE-25': 'A' }]);
});

test('Store API: alle pagina\'s, prijs omgerekend naar excl. btw', async () => {
  const shop = await startShop(paged(storeProducts(), '/wp-json/wc/store/v1/products'));
  try {
    const products = await fetchProducts({ url: shop.url, mode: 'store', pricesIncludeTax: true, vatRate: 21 });
    assert.strictEqual(products.length, 150);
    assert.strictEqual(shop.seen.length, 2);
    const pe = products.find((p) => p.sku === 'PE-25');
    assert.strictEqual(pe.price, 1.0); // 1,21 incl. -> 1,00 excl.
    assert.strictEqual(pe.url, 'https://shop.test/pe-25');
  } finally {
    shop.server.close();
  }
});

test('REST API v3: basic auth, aquatech_code uit meta_data', async () => {
  const rest = [{ id: 7, sku: 'HUNTER-PGV', name: 'Hunter PGV 1"', price: '30.00', permalink: 'https://shop.test/pgv', stock_status: 'instock', meta_data: [{ key: 'aquatech_code', value: 'VAL-24V' }] }];
  const shop = await startShop(paged(rest, '/wp-json/wc/v3/products'));
  try {
    const products = await fetchProducts({ url: shop.url, mode: 'rest', consumerKey: 'ck_a', consumerSecret: 'cs_b', pricesIncludeTax: false });
    assert.strictEqual(shop.seen[0].headers.authorization, `Basic ${Buffer.from('ck_a:cs_b').toString('base64')}`);
    assert.strictEqual(products[0].code, 'VAL-24V');
    assert.strictEqual(products[0].price, 30);
    assert.strictEqual(matchProducts(products, loadArticles()).matched['VAL-24V'].via, 'code');
  } finally {
    shop.server.close();
  }
});

test('koppelen: handmatig gaat voor sku, producten zonder prijs tellen niet', () => {
  const products = [{ sku: 'pe-25', name: 'A', price: 1 }, { sku: 'ALT', name: 'B', price: 2 }, { sku: 'GEENPRIJS', name: 'C', price: null }];
  const r = matchProducts(products, { 'PE-25': {}, 'PE-32': {}, FILTER: {} }, { 'PE-32': 'alt', FILTER: 'GEENPRIJS' });
  assert.strictEqual(r.matched['PE-25'].via, 'sku');
  assert.strictEqual(r.matched['PE-32'].name, 'B');
  assert.deepStrictEqual(r.unmatched, ['FILTER']);
});

function client(base) {
  const jar = new Map();
  async function call(method, p, body) {
    const headers = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (kv.slice(i + 1)) jar.set(kv.slice(0, i), kv.slice(i + 1)); else jar.delete(kv.slice(0, i));
    }
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { /* geen JSON */ }
    return { status: res.status, body: json };
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
}

test('API: beheerder stelt in en haalt op, catalogus per tenant, rechten', async () => {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  const other = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant.id;
  await store.createAccount(tid, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW });
  await store.createAccount(tid, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW });
  await store.createAccount(other, { username: 'groenbaas', displayName: 'Groen', role: 'beheerder', password: PW });
  const shop = await startShop(paged(storeProducts(), '/wp-json/wc/store/v1/products'));
  const server = await new Promise((resolve) => { const s = createApp({ secret: SECRET, db }).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, tenant) => {
    const c = client(base);
    assert.strictEqual((await c.post('/api/auth/login', { username, password: PW, tenant })).status, 200);
    return c;
  };
  try {
    const baas = await as('baas');
    const kees = await as('kees');
    assert.strictEqual((await client(base).get('/api/catalog')).status, 401);
    assert.strictEqual((await kees.get('/api/admin/shop')).status, 403);
    assert.strictEqual((await kees.post('/api/admin/shop/sync')).status, 403);
    assert.deepStrictEqual((await kees.get('/api/catalog')).body.articles, {});
    assert.deepStrictEqual((await kees.get('/api/catalog')).body.assortment, [], 'zonder artikelen: standaardcatalogus');

    let r = await baas.put('/api/admin/shop', { url: shop.url, mode: 'rest', consumerKey: 'ck_1234567890', consumerSecret: 'cs_geheim_1234', mapping: { 'VAL-24V': 'VAL24' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.consumerSecret.set, true);
    assert.ok(!JSON.stringify(r.body).includes('cs_geheim'));
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'shopConsumerSecret'").get().value;
    assert.ok(!raw.includes('cs_geheim'), 'sleutel versleuteld in de database');

    // Terug naar de Store API: de sleutels worden gewist.
    r = await baas.put('/api/admin/shop', { url: shop.url, mode: 'store', mapping: { 'VAL-24V': 'VAL24' } });
    assert.strictEqual(r.body.consumerKey.set, false);
    r = await baas.post('/api/admin/shop/sync');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.status.productCount, 150);
    assert.strictEqual(r.body.matchedCount, 2);
    assert.ok(r.body.unmatched.includes('FILTER'));

    // Installateur (planner, offertes) ziet de webshopprijzen.
    const cat = (await kees.get('/api/catalog')).body;
    assert.strictEqual(cat.articles['PE-25'].price, 1);
    assert.strictEqual(cat.articles['VAL-24V'].price, 30);
    assert.strictEqual(cat.articles['VAL-24V'].via, 'mapping');
    // Eigen assortiment = gekoppelde producten (de planner gebruikt alleen die).
    assert.deepStrictEqual(cat.assortment, ['PE-25', 'VAL-24V']);

    // Voorraadartikelen tellen mee; een code die de planner niet kent niet.
    assert.strictEqual((await baas.post('/api/stock/items', { code: 'FILTER', name: 'Filter 1"', unit: 'st' })).status, 201);
    assert.strictEqual((await baas.post('/api/stock/items', { code: 'EIGEN-1', name: 'Eigen artikel', unit: 'st' })).status, 201);
    const cat2 = (await kees.get('/api/catalog')).body;
    assert.deepStrictEqual(cat2.assortment, ['FILTER', 'PE-25', 'VAL-24V']);
    assert.strictEqual(cat2.unknownCodes, 1);

    // Andere organisatie: eigen (lege) catalogus.
    const groen = await as('groenbaas', 'groen');
    assert.deepStrictEqual((await groen.get('/api/catalog')).body.articles, {});
    assert.deepStrictEqual((await groen.get('/api/catalog')).body.assortment, [], 'assortiment per organisatie');
    assert.strictEqual((await groen.get('/api/admin/shop')).body.source.url, '');

    // Ongeldig adres en een onbereikbare shop: duidelijke melding, status bewaard.
    process.env.SHOP_ALLOW_INSECURE = '0';
    assert.strictEqual((await baas.put('/api/admin/shop', { url: 'http://192.168.1.2' })).status, 400);
    process.env.SHOP_ALLOW_INSECURE = '1';
    shop.server.close();
    r = await baas.post('/api/admin/shop/sync');
    assert.strictEqual(r.status, 502);
    const st = (await baas.get('/api/admin/shop')).body.status;
    assert.ok(st.lastError && st.syncedAt, 'vorige producten blijven staan');
    assert.strictEqual((await kees.get('/api/catalog')).body.articles['PE-25'].price, 1);

    // Koppeling verwijderen wist de producten.
    r = await baas.put('/api/admin/shop', { url: '', clearKeys: true });
    assert.deepStrictEqual((await kees.get('/api/catalog')).body.articles, {});
  } finally {
    server.close();
    shop.server.close();
  }
});
