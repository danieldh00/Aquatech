// Adresindeling: de webshop is de hoofdmap, de app staat onder /app/, oude
// adressen worden doorgestuurd en de oude service worker ruimt zichzelf op.

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createClient, listen } = require('./helpers/http-client');

const SECRET = 'a'.repeat(64);

/**
 * Start een testserver met een beheerder, zodat het instelscherm niet verschijnt.
 * @returns {Promise<{ server: import('http').Server, base: string, client: object }>} De server, zijn adres en een client die doorverwijzingen niet volgt.
 */
async function start() {
  const db = openDb();
  const store = createStore(db);
  await store.createAccount(store.ensureTenant().id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: 'Tuin-Plan-2026!' });
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  return { server, base, client: createClient(base, { followRedirects: false }) };
}

test('oude app-adressen gaan relatief door naar /app/, met querystring', async () => {
  const { server, client } = await start();
  try {
    const cases = [
      ['/beregening/?tekenen', 302, '../app/beregening/?tekenen'],
      ['/beregening', 302, 'app/beregening'],
      ['/beheer/beheer.js', 302, '../app/beheer/beheer.js'],
      ['/login', 302, 'app/login'],
      ['/wachtwoord', 302, 'app/wachtwoord'],
      ['/openbaar/offerte.html', 302, '../app/openbaar/offerte.html'],
      ['/admin', 302, 'app/beheer/'],
      ['/winkel/', 301, '../'],
      ['/winkel', 301, './'],
      ['/winkel/product/pe-buis/', 301, '../../../product/pe-buis/'],
      ['/winkel/groep/leidingen/?voorbeeld=1', 301, '../../../groep/leidingen/?voorbeeld=1'],
    ];
    for (const [urlPath, status, location] of cases) {
      const res = await client.get(urlPath);
      assert.strictEqual(res.status, status, urlPath);
      assert.strictEqual(res.location, location, urlPath);
    }
  } finally { server.close(); }
});

test('/app zonder slash gaat naar /app/, daaronder werkt de app als vanouds', async () => {
  const { server, client } = await start();
  try {
    const bare = await client.get('/app');
    assert.strictEqual(bare.status, 302);
    assert.strictEqual(bare.location, 'app/');
    const page = await client.get('/app/');
    assert.strictEqual(page.status, 401, 'zonder inlog de inlogpagina');
    assert.strictEqual((await client.get('/app/api/health')).body.ok, true);
    assert.strictEqual((await client.get('/api/health')).body.ok, true, 'de gezondheidscontrole blijft ook op de oude plek');
    const oldApi = await client.get('/api/me');
    assert.strictEqual(oldApi.status, 404, 'de API staat alleen nog onder /app/');
  } finally { server.close(); }
});

test('webshop uit: / stuurt naar de app; /sw.js ruimt de oude worker op; robots.txt', async () => {
  const { server, client } = await start();
  try {
    const root = await client.get('/');
    assert.strictEqual(root.status, 302);
    assert.strictEqual(root.location, 'app/');
    const worker = await client.get('/sw.js');
    assert.strictEqual(worker.status, 200);
    assert.match(worker.type, /javascript/);
    assert.match(worker.text, /unregister\(\)/);
    assert.match(worker.headers.get('cache-control'), /no-cache/);
    const robots = await client.get('/robots.txt');
    assert.match(robots.text, /Disallow: \/app\//);
  } finally { server.close(); }
});
