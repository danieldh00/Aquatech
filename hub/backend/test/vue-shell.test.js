// De Vue-schil van de webshop (webshop/vue-shell.js): de pagina gebruikt de schil van de tekenlaag zodra die geladen is, valt
// terug op de oude schil als dat niet zo is, en een kapotte tekenlaag geeft een duidelijke fout in plaats van een hangend verzoek.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const VueShell = require('../src/webshop/vue-shell');
const { createClient, createLogin, listen } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';
const servers = [];
after(() => { for (const server of servers) server.close(); });
afterEach(() => VueShell.configure(null));

/**
 * Hoofdtenant met beheerder en een openstaande webshop (zonder producten).
 * @returns {Promise<{ shop: object }>} Een anonieme client op de shop.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: 'f'.repeat(64), db }));
  servers.push(server);
  const admin = await createLogin(base, { password: PW })('baas');
  assert.strictEqual((await admin.put('/app/api/admin/settings', { storefront: true })).status, 200);
  return { shop: createClient(base) };
}

test('met de Vue-schil staat de pagina in de schil van de tekenlaag, met kop en markeringen intact', async () => {
  const { shop } = await setup();
  const seen = [];
  VueShell.configure(async (shell) => { seen.push(shell); return `<div class="vue-schil" data-root="${shell.root}"><!--shop-body--></div><!--planner:${shell.root}-->`; });
  const res = await shop.get('/');
  assert.strictEqual(res.status, 200);
  const html = res.text;
  assert.match(html, /<body[^>]*>\s*<div class="vue-schil" data-root="">/);
  assert.match(html, /<title>[^<]*Aquatechshop\.nl/);
  assert.ok(!html.includes('vue-shell:'), 'de markering van de schil is vervangen');
  assert.ok(!html.includes('<header class="shop-head">'), 'de oude schil staat er niet bij');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].visitor.ordering, false);
  assert.strictEqual(seen[0].root, '');
});

test('zonder geladen tekenlaag blijft de oude schil in gebruik', async () => {
  const { shop } = await setup();
  const html = (await shop.get('/')).text;
  assert.match(html, /<header class="shop-head">/);
});

test('een kapotte tekenlaag geeft 500 met een melding, geen hangend verzoek', async () => {
  const { shop } = await setup();
  VueShell.configure(async () => { throw new Error('kapot'); });
  const originalError = console.error;
  console.error = Function.prototype;
  try {
    const res = await shop.get('/');
    assert.strictEqual(res.status, 500);
    assert.match(res.text, /misging|misgegaan|ging iets mis/i);
  } finally { console.error = originalError; }
});

test('de schil wordt onthouden voor dezelfde gegevens en de cache blijft begrensd', async () => {
  let calls = 0;
  VueShell.configure(async () => { calls += 1; return '<!--shop-body-->'; });
  const shell = { root: '', n: 1 };
  await VueShell.render(shell);
  await VueShell.render({ ...shell });
  assert.strictEqual(calls, 1);
  for (let index = 0; index < 350; index += 1) await VueShell.render({ root: '', n: 100 + index });
  await VueShell.render(shell);
  assert.strictEqual(calls, 352, 'de oudste schil is uit de cache gevallen');
});
