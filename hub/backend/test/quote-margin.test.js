// Marge in de offerte: rekenkern (QuoteCore.margin) en de route GET /api/quote-costs.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { listen, createLogin } = require('./helpers/http-client');
const { FRONTEND_DIR } = require('../src/paths');

const QuoteCore = require(path.join(FRONTEND_DIR, 'offertes', 'quote-core.js'));
const SECRET = 'n'.repeat(64);
const PW = 'Tuin-Plan-2026!';

test('kern: marge per regel en totaal, na korting, met onbekende kostprijs apart', () => {
  const quote = {
    discountType: 'pct', discountPct: 10,
    lines: [
      { id: 'a', section: 'materiaal', code: 'pe-25', description: 'PE-buis', qty: 100, unit: 'm', price: 2 },
      { id: 'b', section: 'arbeid', description: 'Leggen', qty: 4, unit: 'uur', price: 50 },
      { id: 'c', section: 'materiaal', code: 'KLEP', description: 'Klep', qty: 2, unit: 'st', price: 40 },
      { id: 'd', section: 'materiaal', code: 'PE-25', description: 'Optie', qty: 10, unit: 'm', price: 2, optional: true, selected: false },
      { id: 'e', section: 'overig', description: 'Voorrijkosten', qty: 1, unit: 'post', price: 25 },
    ],
  };
  const result = QuoteCore.margin(quote, { 'PE-25': 1, KLEP: null }, 30);
  // Opbrengst na 10% korting: buis 180, uren 180; kosten 100 + 120.
  assert.deepStrictEqual([result.revenue, result.cost, result.margin, result.pct], [360, 220, 140, 38.89]);
  assert.deepStrictEqual(result.lines.a, { cost: 100, margin: 80, pct: 44.44 });
  assert.deepStrictEqual(result.lines.b, { cost: 120, margin: 60, pct: 33.33 });
  assert.deepStrictEqual(result.unknown, ['Klep', 'Voorrijkosten'], 'zonder kostprijs, niet gekozen opties tellen niet');
  // Zonder kostprijs per uur telt arbeid niet mee.
  assert.deepStrictEqual(Object.keys(QuoteCore.margin(quote, { 'PE-25': 1 }, 0).lines), ['a']);
  // Alleen onbekende regels: geen percentage.
  assert.strictEqual(QuoteCore.margin({ lines: [{ id: 'x', section: 'overig', qty: 1, unit: 'post', price: 10 }] }, {}, 0).pct, null);
});

test('API: inkoopprijzen en minimummarge alleen intern, andere organisatie ziet niets', async () => {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  for (const [tenantId, username, role] of [[tid, 'baas', 'beheerder'], [tid, 'kees', 'installateur'], [other.id, 'vreemd', 'beheerder']]) {
    await store.createAccount(tenantId, { username, displayName: username, role, password: PW, mustChangePassword: false });
  }
  const { server, base } = await listen(createApp({ env: { MULTITENANCY: '1' }, secret: SECRET, db }));
  try {
    const as = createLogin(base, { password: PW });
    const baas = await as('baas'), kees = await as('kees'), vreemd = await as('vreemd', 'ander');
    const saved = (await baas.put('/app/api/quote-profile', { profile: { hourlyCost: 30, minMarginPct: 25 } })).body.profile;
    assert.deepStrictEqual([saved.hourlyCost, saved.minMarginPct], [30, 25]);
    assert.strictEqual((await baas.put('/app/api/quote-profile', { profile: { minMarginPct: 150 } })).body.profile.minMarginPct, 99, 'begrensd op 99');
    assert.strictEqual((await kees.get('/app/api/quote-profile')).body.profile.minMarginPct, undefined, 'intern');
    assert.strictEqual((await baas.get('/app/api/quote-profile')).body.profile.minMarginPct, 99);

    assert.strictEqual((await baas.post('/app/api/stock/import', { codes: ['PE-25'] })).status, 200);
    const pipe = (await baas.get('/app/api/stock')).body.items.find((item) => item.code === 'PE-25');
    assert.strictEqual((await baas.put(`/app/api/stock/items/${pipe.id}`, { costPrice: 1.25 })).status, 200);
    const url = '/app/api/quote-costs?codes=pe-25,ONBEKEND';
    assert.deepStrictEqual((await baas.get(url)).body.costs, { 'PE-25': 1.25, ONBEKEND: null });
    assert.strictEqual((await kees.get(url)).status, 403, 'installateur heeft standaard geen nacalculatie');
    assert.deepStrictEqual((await vreemd.get(url)).body.costs, { 'PE-25': null, ONBEKEND: null }, 'andere organisatie ziet de voorraad niet');
  } finally {
    server.close();
  }
});
