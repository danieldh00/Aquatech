// AI-kosten: elk AI-verzoek wordt vastgelegd (wie, functie, model, tokens,
// duur, kosten), beheerders zien alleen hun eigen omgeving en een
// hoofdbeheerder alle organisaties. Elke organisatie gebruikt haar eigen
// API-sleutel en model.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/database/db');
const { createStore } = require('../src/platform/store');
const { createAiUsageStore, sanitizeFilter } = require('../src/platform/ai-usage');
const { AnalyzeError, createPlanAnalyzer } = require('../src/beregening/plan-analyzer');
const AiModels = require(path.join(__dirname, '..', '..', 'frontend', 'shared', 'ai-models.js'));
const { createClient } = require('./helpers/http-client');

const SECRET = 'k'.repeat(64);
const PW = 'Tuin-Plan-2026!';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

const result = (model = 'claude-opus-5-5') => ({
  scale: { metersPerPixel: 0.02, method: 'maatvoering' }, areas: [{ type: 'lawn', name: 'Gazon', points: [] }], elements: [], notes: '',
  model, usage: { input_tokens: 3000, output_tokens: 10000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

// Nep-AI per sleutel: onthoudt met welke sleutel en welk model hij is gemaakt.
function fakeAi() {
  const made = [];
  const createAnalyzer = ({ apiKey, model }) => {
    made.push({ apiKey, model });
    return {
      available: Boolean(apiKey), model,
      async analyze() {
        if (apiKey === 'sk-ant-weiger-weiger-weiger') throw new AnalyzeError('refusal', 'Geweigerd.', 502, { model, usage: { input_tokens: 2000, output_tokens: 500 } });
        return result(model);
      },
      async check() { return { ok: true, model }; },
    };
  };
  return { made, createAnalyzer };
}

async function setup() {
  const db = openDb();
  const store = createStore(db);
  const main = store.ensureTenant().id;
  await store.createAccount(main, { username: 'baas', displayName: 'Baas', role: 'beheerder', password: PW }, { platformAdmin: true });
  await store.createAccount(main, { username: 'kees', displayName: 'Kees', role: 'installateur', password: PW }, { mustChangePassword: false });
  const groen = store.createTenant({ name: 'Groen BV', slug: 'groen' }).tenant;
  await store.createAccount(groen.id, { username: 'gerda', displayName: 'Gerda', role: 'beheerder', password: PW }, { mustChangePassword: false });
  await store.createAccount(groen.id, { username: 'gijs', displayName: 'Gijs', role: 'installateur', password: PW }, { mustChangePassword: false });
  const ai = fakeAi();
  const app = createApp({ secret: SECRET, db, anthropicApiKey: 'sk-ant-platform-sleutel-van-daniel', createAnalyzer: ai.createAnalyzer });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, org) => {
    const c = createClient(base);
    const r = await c.post('/api/auth/login', { username, password: PW, tenant: org });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return c;
  };
  return { db, store, server, base, as, main, groen, ai, app };
}

const analyze = (c) => c.post('/api/plan/analyze', { image: PNG, width: 800, height: 600, fresh: true });

test('prijzen: kosten per model, cache en onbekend model', () => {
  assert.strictEqual(AiModels.DEFAULT, 'claude-opus-5-5');
  const opus = AiModels.costUsd('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6 });
  assert.deepStrictEqual(opus, { usd: 24, known: true });
  assert.strictEqual(AiModels.costUsd('claude-sonnet-5-5', { inputTokens: 1e6 }).usd, 2);
  assert.strictEqual(AiModels.costUsd('claude-opus-5-5', { cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }).usd, 5.2);
  assert.strictEqual(AiModels.costUsd('claude-opus-5-5-20260901', { input_tokens: 1e6 }).known, true, 'met datum-achtervoegsel');
  assert.strictEqual(AiModels.costUsd('iets-anders', { input_tokens: 1e6 }).known, false);
  for (const k of AiModels.SELECTABLE) assert.ok(AiModels.MODELS[k].description && AiModels.MODELS[k].label);
});

test('opslag: kosten exact in miljoensten, filters en periode', () => {
  const db = openDb();
  const store = createStore(db);
  const tid = store.ensureTenant().id;
  const ai = createAiUsageStore(db);
  ai.record({ tenantId: tid, userId: 'u1', feature: 'plan_analyse', model: 'claude-opus-5-5', usage: { input_tokens: 3000, output_tokens: 10000 }, durationMs: 4000, eurCentsPerUsd: 90 });
  ai.record({ tenantId: tid, userId: 'u2', feature: 'plan_analyse', model: 'claude-sonnet-5-5', status: 'refusal', usage: { input_tokens: 1000, output_tokens: 0 }, eurCentsPerUsd: 90 });
  const s = ai.summary([tid], {});
  assert.strictEqual(s.totals.requests, 2);
  assert.strictEqual(s.totals.failed, 1);
  assert.strictEqual(s.totals.costUsd, 0.212 + 0.002);
  assert.strictEqual(s.totals.costEur, Math.round(0.214 * 0.9 * 1e6) / 1e6);
  assert.strictEqual(s.byModel.length, 2);
  assert.strictEqual(s.byUser[0].user.displayName, 'Verwijderde gebruiker', 'onbekende gebruiker');
  assert.strictEqual(ai.summary([tid], { user: 'u2' }).totals.requests, 1);
  assert.strictEqual(ai.summary([tid], { from: '2000-01-01', to: '2000-01-31' }).totals.requests, 0);
  assert.strictEqual(ai.summary([tid], { period: 'month' }).byPeriod[0].key.length, 7);
  assert.strictEqual(ai.list([tid], {}, { limit: 1 }).items.length, 1);
  const f = sanitizeFilter({ from: '2026-05-10', to: '2026-05-01', period: 'jaar', user: "x' OR 1=1" });
  assert.deepStrictEqual([f.from, f.to, f.period], ['2026-05-01', '2026-05-10', 'day']);
  assert.strictEqual(ai.prune(tid, 0), 2);
});

test('API: elk AI-verzoek komt in het overzicht met verbruik en kosten', async () => {
  const { server, as } = await setup();
  try {
    const kees = await as('kees');
    assert.strictEqual((await analyze(kees)).status, 200);
    const baas = await as('baas');
    const s = (await baas.get('/api/admin/ai-usage')).body;
    assert.strictEqual(s.totals.requests, 1);
    assert.strictEqual(s.totals.inputTokens, 3000);
    assert.strictEqual(s.totals.outputTokens, 10000);
    assert.strictEqual(s.totals.costUsd, 0.212);
    assert.strictEqual(s.byUser[0].user.username, 'kees');
    assert.strictEqual(s.byFeature[0].label, 'Plan herkennen');
    assert.strictEqual(s.byModel[0].label, 'Claude Opus 5.5');
    assert.strictEqual(s.eurCentsPerUsd, 86);
    const r = (await baas.get('/api/admin/ai-usage/requests')).body;
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.items[0].status, 'ok');
    assert.strictEqual(r.items[0].detail.areas, 1);
    assert.strictEqual(r.items[0].detail.width, 800);
    assert.ok(r.items[0].durationMs >= 0);
    assert.ok(!('image' in r.items[0].detail), 'geen afbeelding in het logboek');
    // Een installateur ziet de kosten niet.
    assert.strictEqual((await kees.get('/api/admin/ai-usage')).status, 403);
    assert.strictEqual((await kees.get('/api/admin/ai-usage/requests')).status, 403);
  } finally {
    server.close();
  }
});

test('API: eigen sleutel en model per organisatie, nooit de sleutel van het platform', async () => {
  const { server, as, ai, groen, store } = await setup();
  try {
    // Groen heeft nog geen sleutel: niet de platformsleutel gebruiken.
    const gijs = await as('gijs', 'groen');
    assert.strictEqual((await gijs.get('/api/plan/status')).body.available, false);
    assert.strictEqual((await analyze(gijs)).status, 409);
    assert.ok(ai.made.every((m) => m.apiKey !== 'sk-ant-platform-sleutel-van-daniel'), 'Groen krijgt nooit de platformsleutel');
    // De hoofdtenant gebruikt de sleutel uit de omgeving.
    const kees = await as('kees');
    assert.strictEqual((await analyze(kees)).status, 200);
    assert.ok(ai.made.some((m) => m.apiKey === 'sk-ant-platform-sleutel-van-daniel'));
    // Groen stelt een eigen sleutel en model in.
    const gerda = await as('gerda', 'groen');
    const put = await gerda.put('/api/admin/settings', { anthropicApiKey: 'sk-ant-groen-eigen-sleutel-123', aiModel: 'claude-sonnet-5-5' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual((await gerda.put('/api/admin/settings', { aiModel: 'gpt-iets' })).status, 400);
    assert.strictEqual((await analyze(gijs)).status, 200);
    const used = ai.made.filter((m) => m.apiKey === 'sk-ant-groen-eigen-sleutel-123');
    assert.deepStrictEqual(used.map((m) => m.model), ['claude-sonnet-5-5']);
    assert.strictEqual((await gerda.post('/api/admin/settings/test-ai')).body.model, 'claude-sonnet-5-5');
    // Een testomgeving zonder eigen sleutel gebruikt die van haar live-tenant.
    const env = store.createEnvironment(groen.id, { name: 'Test', skipSettings: ['anthropicApiKey'] }).tenant;
    const sw = await gerda.post('/api/environment', { tenantId: env.id });
    assert.strictEqual(sw.status, 200, JSON.stringify(sw.body));
    assert.strictEqual((await gerda.get('/api/admin/settings')).body.aiFromLive, true);
    assert.strictEqual((await analyze(gerda)).status, 200);
    const envRows = (await gerda.get('/api/admin/ai-usage/requests')).body;
    assert.strictEqual(envRows.total, 1, 'het verzoek hoort bij de testomgeving');
    assert.strictEqual(envRows.items[0].model, 'claude-sonnet-5-5');
  } finally {
    server.close();
  }
});

test('API: beheerder ziet alleen de eigen organisatie, hoofdbeheerder alles', async () => {
  const { server, as, groen } = await setup();
  try {
    const gerda = await as('gerda', 'groen');
    await gerda.put('/api/admin/settings', { anthropicApiKey: 'sk-ant-weiger-weiger-weiger' });
    const gijs = await as('gijs', 'groen');
    // Een geweigerd verzoek kost ook tokens en komt erin.
    assert.strictEqual((await analyze(gijs)).status, 502);
    const kees = await as('kees');
    await analyze(kees);
    await analyze(kees);

    const own = (await gerda.get('/api/admin/ai-usage')).body;
    assert.strictEqual(own.totals.requests, 1);
    assert.strictEqual(own.totals.failed, 1);
    assert.strictEqual(own.totals.inputTokens, 2000);
    assert.strictEqual(own.byTenant, undefined);
    assert.strictEqual((await gerda.get('/api/admin/ai-usage/requests')).body.items[0].status, 'refusal');
    // Andere organisaties: alleen voor een hoofdbeheerder.
    assert.strictEqual((await gerda.get('/api/admin/ai-usage?scope=all')).status, 403);
    assert.strictEqual((await gerda.get(`/api/admin/ai-usage/requests?tenant=${encodeURIComponent('default')}`)).status, 403);

    const baas = await as('baas');
    const mine = (await baas.get('/api/admin/ai-usage')).body;
    assert.strictEqual(mine.totals.requests, 2);
    assert.strictEqual(mine.platformAdmin, true);
    const all = (await baas.get('/api/admin/ai-usage?scope=all')).body;
    assert.strictEqual(all.totals.requests, 3);
    assert.ok(all.byTenant.some((t) => t.tenant.name === 'Groen BV' && t.requests === 1));
    assert.strictEqual(all.byTenant.length, 2);
    const one = (await baas.get(`/api/admin/ai-usage/requests?tenant=${groen.id}`)).body;
    assert.strictEqual(one.total, 1);
    assert.strictEqual((await baas.get('/api/admin/ai-usage?tenant=bestaat-niet')).status, 404);
  } finally {
    server.close();
  }
});

test('planAnalyzer: gekozen model en fallback alleen waar dat kan', async () => {
  const calls = [];
  const message = { model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 },
    content: [{ type: 'text', text: JSON.stringify({ scale: { method: 'schatting', evidence: '', confidence: 'laag', x1: 0, y1: 0, x2: 0, y2: 0, length_m: 0 }, areas: [], elements: [], notes: '' }) }] };
  const stream = (kind) => (params) => { calls.push({ kind, model: params.model, fallbacks: params.fallbacks }); return { finalMessage: async () => message }; };
  const client = { messages: { stream: stream('plain') }, beta: { messages: { stream: stream('beta') } } };
  const haiku = createPlanAnalyzer({ client, model: 'claude-haiku-5-5' });
  assert.strictEqual(haiku.model, 'claude-haiku-5-5');
  await haiku.analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 });
  assert.deepStrictEqual(calls.pop(), { kind: 'plain', model: 'claude-haiku-5-5', fallbacks: undefined });
  await createPlanAnalyzer({ client, model: 'claude-sonnet-5-5' }).analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 });
  assert.deepStrictEqual(calls.pop(), { kind: 'beta', model: 'claude-sonnet-5-5', fallbacks: 'default' });
  assert.strictEqual(createPlanAnalyzer({ client, model: 'onzin' }).model, AiModels.DEFAULT);
  // Een te lang antwoord geeft het verbruik mee in de fout.
  message.stop_reason = 'max_tokens';
  await assert.rejects(haiku.analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 }), (e) => e.code === 'too_long' && e.usage.output_tokens === 20);
});
