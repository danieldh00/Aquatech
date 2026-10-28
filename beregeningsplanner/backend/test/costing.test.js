// Nacalculatie per werkorder: rekenkern (costing-core.js) en de route
// GET /api/workorders/:id/costing (costing.js).
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { Core } = require('../src/uitvoering/costing');
const { listen, createLogin } = require('./helpers/http-client');

const SECRET = 'n'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const lines = [
  { id: 'a', section: 'materiaal', code: 'PE-25', description: 'PE-buis', qty: 50, unit: 'm', price: 2 },
  { id: 'b', section: 'arbeid', description: 'Leidingen leggen', qty: 4, unit: 'uur', price: 50 },
  { id: 'c', section: 'overig', description: 'Voorrijkosten', qty: 1, unit: 'post', price: 25 },
  { id: 'd', section: 'materiaal', code: 'VAL-24V', description: 'Ventiel', qty: 2, unit: 'st', price: 40, optional: true },
];

test('kern: begroot uit de offerte, werkelijk uit boekingen, kosten, opbrengst en marge', () => {
  const result = Core.compute({
    workOrder: { number: 'WO-1', data: {} },
    quote: { number: 'OF-1', data: { lines, discountPct: 10 } },
    logged: {
      hours: [{ minutes: 240 }, { minutes: 60 }],
      materials: [{ code: 'pe-25', description: 'PE-buis', qty: 60 }, { code: 'PE-25', qty: -5 }, { code: 'KOP-25', description: 'Koppeling', unit: 'st', qty: 3 }],
    },
    articles: { 'PE-25': { salePrice: 2.5, costPrice: 1 }, 'KOP-25': { salePrice: 4, costPrice: null } },
    invoices: [],
    hourlyRate: 50, hourlyCost: 30,
  });
  assert.deepStrictEqual([result.labour.plannedHours, result.labour.actualHours, result.labour.diffHours], [4, 5, 1]);
  assert.deepStrictEqual([result.budget.labour, result.budget.materials, result.budget.other, result.budget.net], [200, 100, 25, 292.5], 'optie niet gekozen telt niet');
  const pipe = result.materials.find((material) => material.code === 'PE-25');
  assert.deepStrictEqual([pipe.plannedQty, pipe.usedQty, pipe.diffQty, pipe.usedAmount, pipe.usedCost], [50, 55, 5, 110, 55], 'offerteprijs voor de waarde');
  const coupling = result.materials.find((material) => material.code === 'KOP-25');
  assert.deepStrictEqual([coupling.extra, coupling.price, coupling.usedCost], [true, 4, null], 'extra artikel tegen verkoopprijs, zonder inkoopprijs');
  assert.deepStrictEqual([result.actual.labour, result.actual.materials, result.actual.net], [250, 122, 357.3]);
  assert.deepStrictEqual([result.cost.labour, result.cost.materials, result.cost.total, result.cost.complete], [150, 55, 205, false]);
  assert.deepStrictEqual([result.revenueSource, result.revenue, result.margin, result.marginPct], ['offerte', 292.5, 87.5, 29.91]);
  assert.ok(result.warnings.some((warning) => warning.includes('KOP-25')));

  // Gefactureerd telt als opbrengst (credit negatief, concept niet).
  const invoiced = Core.compute({
    workOrder: { data: {} }, quote: { data: { lines } }, logged: { hours: [], materials: [] },
    invoices: [{ number: 'F-1', status: 'definitief', subtotal: 400 }, { number: 'F-2', status: 'betaald', subtotal: -50 }, { status: 'concept', subtotal: 999 }],
  });
  assert.deepStrictEqual([invoiced.revenueSource, invoiced.revenue, invoiced.invoiced.numbers, invoiced.invoiced.concepts], ['factuur', 350, ['F-1', 'F-2'], 1]);

  // Zonder offerte: werkstappen en materiaallijst van de werkorder.
  const withoutQuote = Core.compute({
    workOrder: { data: { steps: [{ hours: 2 }, { hours: 1.5 }], materials: [{ code: 'PE-25', description: 'PE-buis', qty: 10, unit: 'm' }] } },
    quote: null, logged: { hours: [{ minutes: 120 }], materials: [] }, articles: { 'PE-25': { salePrice: 3, costPrice: 1 } }, hourlyRate: 60, hourlyCost: 0,
  });
  assert.deepStrictEqual([withoutQuote.source, withoutQuote.labour.plannedHours, withoutQuote.budget.labour, withoutQuote.budget.materials], ['werkorder', 3.5, 210, 30]);
  assert.ok(withoutQuote.warnings.some((warning) => warning.includes('kostprijs per uur')));
  assert.strictEqual(withoutQuote.revenueSource, 'schatting', 'zonder offerte en factuur is de opbrengst een schatting');

  // Werkelijke arbeid tegen het tarief van de offerte, niet tegen het profiel.
  const quoteRate = Core.compute({
    workOrder: { data: {} }, quote: { data: { lines: [{ section: 'arbeid', qty: 2, unit: 'uur', price: 70 }] } },
    logged: { hours: [{ minutes: 120 }], materials: [] }, hourlyRate: 50,
  });
  assert.deepStrictEqual([quoteRate.labour.hourlyRate, quoteRate.actual.labour, quoteRate.budget.labour], [70, 140, 140]);

  // Zonder offerte en zonder verkoopprijs: waarschuwing, waarde € 0.
  const noPrice = Core.compute({ workOrder: { data: { materials: [{ code: 'X-1', description: 'Iets', qty: 2 }] } }, quote: null, logged: { hours: [], materials: [] } });
  assert.strictEqual(noPrice.materials[0].plannedAmount, 0);
  assert.ok(noPrice.warnings.some((warning) => warning.includes('Geen verkoopprijs voor X-1')));
});

test('API: nacalculatie alleen met het recht, andere tenant 404, met kostprijs uit profiel en voorraad', async () => {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  const other = store.createTenant({ slug: 'ander', name: 'Ander BV' }).tenant;
  for (const [tenantId, username, role] of [[tid, 'baas', 'beheerder'], [tid, 'kees', 'installateur'], [other.id, 'vreemd', 'beheerder']]) {
    await store.createAccount(tenantId, { username, displayName: username, role, password: PW, mustChangePassword: false });
  }
  const { server, base } = await listen(createApp({ secret: SECRET, db }));
  try {
    const as = createLogin(base, { password: PW });
    const baas = await as('baas'), kees = await as('kees'), vreemd = await as('vreemd', 'ander');
    assert.strictEqual((await baas.put('/api/quote-profile', { profile: { hourlyRate: 50, hourlyCost: 30 } })).body.profile.hourlyCost, 30);
    const quote = (await baas.post('/api/quotes', { data: { title: 'Aanleg', customer: { name: 'Fam. Jansen' }, lines } })).body;
    await baas.put(`/api/quotes/${quote.id}`, { status: 'akkoord' });
    const workOrder = (await baas.post('/api/workorders', { quoteId: quote.id })).body;
    assert.strictEqual((await baas.post('/api/stock/import', { codes: ['PE-25'] })).status, 200);
    const pipe = (await baas.get('/api/stock')).body.items.find((item) => item.code === 'PE-25');
    assert.strictEqual((await baas.put(`/api/stock/items/${pipe.id}`, { costPrice: 1 })).status, 200);
    const day = new Date().toISOString().slice(0, 10);
    await kees.post(`/api/workorders/${workOrder.id}/hours`, { workDate: day, hours: 5 });
    await kees.post(`/api/workorders/${workOrder.id}/materials`, { usedOn: day, code: 'PE-25', description: 'PE-buis', unit: 'm', qty: 55 });

    // Inkoopprijzen gaan niet mee met de verkoopgegevens voor facturen.
    const articles = (await baas.get('/api/invoices/articles')).body.articles;
    assert.strictEqual(articles['PE-25'].costPrice, undefined);
    // Ook de factuurinstellingen geven de kostprijs per uur niet mee.
    assert.strictEqual((await baas.get('/api/invoices/settings')).body.profile.hourlyCost, undefined);
    // De kostprijs per uur is intern: niet voor een installateur zonder nacalculatie.
    assert.strictEqual((await kees.get('/api/quote-profile')).body.profile.hourlyCost, undefined);
    assert.strictEqual((await baas.get('/api/quote-profile')).body.profile.hourlyCost, 30);
    const url = `/api/workorders/${workOrder.id}/costing`;
    assert.strictEqual((await kees.get(url)).status, 403, 'installateur heeft standaard geen nacalculatie');
    assert.strictEqual((await vreemd.get(url)).status, 404, 'andere organisatie');
    assert.strictEqual((await baas.get('/api/workorders/bestaat-niet/costing')).status, 404);
    const costing = (await baas.get(url)).body;
    assert.deepStrictEqual([costing.workOrder.number, costing.quote.number], [workOrder.number, quote.number]);
    assert.deepStrictEqual([costing.labour.actualHours, costing.cost.labour, costing.cost.materials, costing.cost.complete], [5, 150, 55, true]);
    assert.deepStrictEqual([costing.revenue, costing.margin], [325, 120]);
  } finally {
    server.close();
  }
});
