const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { validate, createPlanAnalyzer, SCHEMA } = require('../src/planAnalyzer');

const SECRET = 'x'.repeat(64);
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function start(opts = {}) {
  return new Promise((resolve) => {
    const server = createApp({ secret: SECRET, ...opts }).listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}
const post = (base, body) => fetch(`${base}/api/plan/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('validate: schaal uit referentiemaat, ongeldige vlakken weg, coördinaten begrensd', () => {
  const r = validate({
    scale: { method: 'maatvoering', evidence: '12,00 m', confidence: 'hoog', x1: 100, y1: 50, x2: 580, y2: 50, length_m: 12 },
    areas: [
      { type: 'lawn', name: 'Gazon', points: [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 10, y: 10 }] },
      { type: 'zwembad', name: 'X', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] },
      { type: 'bed', name: 'te klein', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    ],
    elements: [{ kind: 'source', x: 5, y: 5, reason: 'kraan' }, { kind: 'pomp', x: 1, y: 1, reason: '' }],
    notes: 'ok',
  }, 800, 600);
  assert.strictEqual(r.scale.metersPerPixel, 12 / 480);
  assert.strictEqual(r.areas.length, 1);
  assert.strictEqual(r.areas[0].points[1].x, 800);
  assert.strictEqual(r.elements.length, 1);
});

test('validate: geen bruikbare referentie geeft geen schaal', () => {
  const r = validate({ scale: { method: 'schatting', evidence: '', confidence: 'laag', x1: 0, y1: 0, x2: 0, y2: 0, length_m: 0 }, areas: [], elements: [], notes: '' }, 100, 100);
  assert.strictEqual(r.scale.metersPerPixel, null);
});

test('schema is strikt (additionalProperties false, alles required)', () => {
  const walk = (s) => {
    if (s.type === 'object') {
      assert.strictEqual(s.additionalProperties, false);
      assert.deepStrictEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === 'array') walk(s.items);
  };
  walk(SCHEMA);
});

test('zonder API-sleutel: status niet beschikbaar en analyse 409', async () => {
  const { server, base } = await start();
  try {
    const st = await (await fetch(`${base}/api/plan/status`)).json();
    assert.strictEqual(st.available, false);
    const res = await post(base, { image: PNG, width: 10, height: 10 });
    assert.strictEqual(res.status, 409);
  } finally { server.close(); }
});

test('analyse met nagebootste AI-dienst, daglimiet en invoercontrole', async () => {
  let calls = 0;
  const analyzer = { available: true, analyze: async ({ mediaType, width }) => { calls++; assert.strictEqual(mediaType, 'image/png'); return { scale: { metersPerPixel: 0.02 }, areas: [], elements: [], notes: '', width }; } };
  const { server, base } = await start({ analyzer, aiDailyLimit: 2 });
  try {
    assert.strictEqual((await post(base, { image: 'geen-afbeelding', width: 10, height: 10 })).status, 400);
    assert.strictEqual((await post(base, { image: PNG, width: 0, height: 10 })).status, 400);
    const ok = await post(base, { image: PNG, width: 10, height: 10 });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).scale.metersPerPixel, 0.02);
    assert.strictEqual((await post(base, { image: PNG, width: 10, height: 10 })).status, 200);
    const limited = await post(base, { image: PNG, width: 10, height: 10 });
    assert.strictEqual(limited.status, 429);
    assert.strictEqual(calls, 2);
    assert.strictEqual((await (await fetch(`${base}/api/plan/status`)).json()).remainingToday, 0);
  } finally { server.close(); }
});

test('met toegangscode: analyse vereist inloggen', async () => {
  const analyzer = { available: true, analyze: async () => { throw new Error('mag niet aangeroepen worden'); } };
  const { server, base } = await start({ analyzer, accessCode: 'geheim' });
  try {
    assert.strictEqual((await post(base, { image: PNG, width: 10, height: 10 })).status, 401);
    assert.strictEqual((await fetch(`${base}/api/plan/status`)).status, 401);
  } finally { server.close(); }
});

test('AI-dienst: weigering en onleesbaar antwoord geven nette fout', async () => {
  const fake = (msg) => ({ beta: { messages: { stream: () => ({ finalMessage: async () => msg }) } } });
  const a1 = createPlanAnalyzer({ client: fake({ stop_reason: 'refusal', content: [] }) });
  await assert.rejects(a1.analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 }), { code: 'refusal' });
  const a2 = createPlanAnalyzer({ client: fake({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'geen json' }] }) });
  await assert.rejects(a2.analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 }), { code: 'invalid_output' });
  const a3 = createPlanAnalyzer({ client: fake({ stop_reason: 'end_turn', model: 'm', usage: {}, content: [{ type: 'text', text: JSON.stringify({ scale: { method: 'schaalstok', evidence: 'balk 5 m', confidence: 'hoog', x1: 0, y1: 0, x2: 100, y2: 0, length_m: 5 }, areas: [], elements: [], notes: '' }) }] }) });
  const r = await a3.analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 });
  assert.strictEqual(r.scale.metersPerPixel, 0.05);
});

test('verzoek naar de AI-dienst: model, fallback, gestructureerde uitvoer en afbeelding', async () => {
  let req;
  const client = { beta: { messages: { stream: (r) => { req = r; return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"scale":{"method":"schatting","evidence":"","confidence":"laag","x1":0,"y1":0,"x2":0,"y2":0,"length_m":0},"areas":[],"elements":[],"notes":""}' }] }) }; } } } };
  await createPlanAnalyzer({ client }).analyze({ mediaType: 'image/jpeg', data: 'QUJD', width: 1200, height: 900 });
  assert.strictEqual(req.model, 'claude-opus-5-5');
  assert.strictEqual(req.fallbacks, 'default');
  assert.deepStrictEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.strictEqual(req.output_config.format.type, 'json_schema');
  assert.strictEqual(req.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.match(req.messages[0].content[1].text, /1200 × 900/);
});

test('fallback-beta geweigerd: één nieuwe poging zonder beta, foutmelding van de API wordt doorgegeven', async () => {
  const Anthropic = require('@anthropic-ai/sdk');
  const bad = (msg) => new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: msg } }, msg, new Headers());
  const ok = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"scale":{"method":"schatting","evidence":"","confidence":"laag","x1":0,"y1":0,"x2":0,"y2":0,"length_m":0},"areas":[],"elements":[],"notes":""}' }] };
  const logs = [];
  let plainReq;
  const client = {
    beta: { messages: { stream: () => ({ finalMessage: async () => { throw bad('fallbacks: unsupported'); } }) } },
    messages: { stream: (r) => { plainReq = r; return { finalMessage: async () => ok }; } },
  };
  const r = await createPlanAnalyzer({ client, log: (m) => logs.push(m) }).analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 });
  assert.ok(r.scale);
  assert.strictEqual(plainReq.fallbacks, undefined);
  assert.strictEqual(plainReq.betas, undefined);
  assert.match(logs[0], /fallbacks: unsupported/);

  const client2 = {
    beta: { messages: { stream: () => ({ finalMessage: async () => { throw bad('eerste'); } }) } },
    messages: { stream: () => ({ finalMessage: async () => { throw bad('output_config.format: schema niet ondersteund'); } }) },
  };
  await assert.rejects(createPlanAnalyzer({ client: client2, log: () => {} }).analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 }),
    (e) => e.code === 'bad_request' && /schema niet ondersteund/.test(e.message));
});
