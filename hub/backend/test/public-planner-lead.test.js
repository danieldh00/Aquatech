// Openbare planner als verkoopkanaal: de catalogus (alleen hoofdtenant mag bestellen) en de concept-offerte bij een ingediende tekening.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createSettings } = require('../src/platform/settings');
const { createClient, listen } = require('./helpers/http-client');

const PW = 'Tuin-Plan-2026!';
/**
 * Een punt in meters.
 * @param {number} x Afstand van links.
 * @param {number} y Afstand van boven.
 * @returns {{ x: number, y: number }} Het punt.
 */
const point = (x, y) => ({ x, y });
/**
 * Een gazon met drie sproeiers: genoeg om materiaal en arbeid uit te rekenen.
 * @returns {object} De plangegevens.
 */
const plan = () => ({
  meta: { name: 'Tuin' }, settings: {}, elements: [], zones: [],
  sprinklers: [point(2, 2), point(8, 2), point(5, 4)].map((position, index) => ({ id: `s${index}`, type: 'rotor', x: position.x, y: position.y, radius: 4 })),
  areas: [{ id: 'a1', type: 'lawn', pts: [point(0, 0), point(10, 0), point(10, 5), point(0, 5)] }],
});
/**
 * Een ingediende tekening zoals het formulier hem verstuurt.
 * @param {object} [extra] Velden die de standaard overschrijven.
 * @returns {object} De body voor POST /api/public/drawing.
 */
const submission = (extra = {}) => ({ name: 'Mark Jansen', email: 'jansen@voorbeeld.test', phone: '06 1234 5678', address: 'Vierhouterweg 31, Vierhouten', question: '', consent: true, website: '', data: plan(), ...extra });

/**
 * Hoofdtenant en organisatie Groen met tekening indienen aan, plus een testserver.
 * @returns {Promise<object>} db, main, groen, server en base.
 */
async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant();
  await store.createAccount(main.id, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW });
  const groen = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant;
  for (const tenantId of [main.id, groen.id]) createSettings({ db, tenantId }).update({ drawingRequests: true });
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: 'd'.repeat(64), db }));
  return { db, main, groen, server, base };
}

test('plannercatalogus: bestellen alleen voor de hoofdtenant met een open, bestelbare webshop', async () => {
  const { server, base } = await setup();
  try {
    const anon = createClient(base);
    const closed = (await anon.get('/app/api/public/planner-catalog')).body;
    assert.strictEqual(closed.enabled, true);
    assert.strictEqual(closed.ordering, false);
    const baas = createClient(base);
    await baas.login('baas', PW);
    assert.strictEqual((await baas.put('/app/api/admin/settings', { storefront: true, shopOrdering: true })).status, 200);
    assert.strictEqual((await anon.get('/app/api/public/planner-catalog')).body.ordering, true);
    assert.strictEqual((await anon.get('/app/api/public/planner-catalog?org=groen')).body.ordering, false, 'andere organisatie: nooit bestellen');
    assert.strictEqual((await anon.get('/app/api/public/planner-catalog?org=bestaat-niet')).body.enabled, false);
  } finally { server.close(); }
});

test('ingediende tekening wordt een concept-offerte voor de installateur', async () => {
  const { db, main, server, base } = await setup();
  try {
    const anon = createClient(base);
    assert.strictEqual((await anon.post('/app/api/public/drawing', submission())).status, 201);
    const quote = db.prepare("SELECT number, status, data FROM quotes WHERE tenant_id = ?").get(main.id);
    assert.ok(quote, 'er is een offerte gemaakt');
    assert.strictEqual(quote.status, 'concept');
    const data = typeof quote.data === 'string' ? JSON.parse(quote.data) : quote.data;
    assert.ok(data.lines.length > 0);
    assert.strictEqual(data.customer.name, 'Mark Jansen');
    assert.match(data.internalNote, /planner zonder account/);
  } finally { server.close(); }
});
