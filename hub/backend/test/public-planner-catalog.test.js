// Catalogus voor de planner zonder account: alleen met het indienen aan, zonder interne velden, en
// publicCatalogOf laat artikelen zonder prijs weg.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { registerDrawingRoutes } = require('../src/beregening/drawings');
const { registerShopRoutes } = require('../src/webshop/shop');
const { listen } = require('./helpers/http-client');

/**
 * Maakt een kleine app met alleen de tekeningroutes.
 * @param {object} [extra] Extra velden voor de routes (bijvoorbeeld plannerCatalogOf).
 * @param {boolean} [enabled] Of tekeningen indienen aan staat.
 * @returns {Promise<{ server: object, base: string }>} De testserver.
 */
async function setup(extra = {}, enabled = true) {
  const app = express();
  app.use(express.json());
  const tenant = { id: 't-1', slug: 'default', name: 'Test' };
  registerDrawingRoutes(app, {
    store: { getTenantBySlug: (slug) => (slug === 'default' ? tenant : null) },
    identify: () => null, requirePlans: (req, res, next) => next(), requireRight: () => (req, res, next) => next(), requireJson: (req, res, next) => next(),
    audit: () => {}, settingsFor: () => ({ get: (key) => (key === 'drawingRequests' ? enabled : {}) }), remoteIp: () => '', publicLimiter: (req, res, next) => next(), ...extra,
  });
  return listen(app);
}

test('openbare plannercatalogus: zonder koppeling of met indienen uit is er niets', async () => {
  for (const [extra, enabled] of [[{}, true], [{ plannerCatalogOf: () => ({ articles: {} }) }, false]]) {
    const { server, base } = await setup(extra, enabled);
    try {
      const body = await (await fetch(`${base}/api/public/planner-catalog`)).json();
      assert.deepStrictEqual(body, { enabled: false });
    } finally { server.close(); }
  }
});

test('openbare plannercatalogus: geeft de catalogus van de organisatie', async () => {
  const { server, base } = await setup({ plannerCatalogOf: (tenantId) => ({ assortment: ['PE-32'], articles: { 'PE-32': { name: 'PE-buis', price: 2, vatRate: 21, inStock: true } }, ordering: tenantId === 't-1' }) });
  try {
    const res = await fetch(`${base}/api/public/planner-catalog`);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.strictEqual(body.enabled, true);
    assert.strictEqual(body.articles['PE-32'].price, 2);
    assert.strictEqual(body.ordering, true);
    assert.strictEqual((await (await fetch(`${base}/api/public/planner-catalog?org=bestaat-niet`)).json()).enabled, false);
  } finally { server.close(); }
});

test('publicCatalogOf: alleen artikelen met prijs, zonder sku of adres, btw uit het artikel', () => {
  const shop = { status: () => null, products: () => [] };
  const settings = { get: (key) => (key === 'shopSource' ? { url: '', mapping: {} } : null) };
  const routes = registerShopRoutes(express(), {
    shop, requireUser: (req, res, next) => next(), requireJson: (req, res, next) => next(), settingsOf: () => settings, tenantOf: () => 't-1', audit: () => {},
    syncLimiter: (req, res, next) => next(),
    salePrices: () => ({ 'PE-32': { name: 'PE-buis', salePrice: 2, vatRate: 9 }, 'ROT-MP2000': { name: 'Rotator', salePrice: null, vatRate: 21 } }),
  });
  const result = routes.publicCatalogOf('t-1', settings);
  assert.deepStrictEqual(Object.keys(result.articles), ['PE-32']);
  assert.deepStrictEqual(result.articles['PE-32'], { name: 'PE-buis', price: 2, vatRate: 9, inStock: true });
  assert.ok(result.assortment.includes('PE-32'));
});

test('ingediende tekening: een fout of ontbrekende offerte laat het indienen slagen, de offerte staat in de melding en het auditlog', async () => {
  const submitted = [];
  for (const [createLeadQuote, expectedQuoteId] of [[() => { throw new Error('rekenfout'); }, undefined], [() => null, undefined], [() => ({ id: 'q-1', number: 'O2026-0001' }), 'q-1']]) {
    const audits = [];
    const { server, base } = await setup({
      createLeadQuote, audit: (...args) => audits.push(args[2]),
      store: { getTenantBySlug: () => ({ id: 't-1' }), submitDrawing: () => { submitted.push(1); return { id: 'p1', title: 'Tuin', reference: 'ABCD1234', ownerId: 'u1' }; }, pendingDrawingChars: () => 0 },
      requireJson: (req, res, next) => next(),
    });
    try {
      const body = { name: 'Mark', email: 'mark@voorbeeld.test', consent: true, website: '', data: { areas: [{ id: 'a', type: 'lawn', pts: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }] }], sprinklers: [], elements: [], zones: [], settings: {}, meta: {} } };
      const res = await fetch(`${base}/api/public/drawing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(audits.length, 1);
      assert.strictEqual(audits[0].quoteId, expectedQuoteId);
    } finally { server.close(); }
  }
  assert.strictEqual(submitted.length, 3);
});
