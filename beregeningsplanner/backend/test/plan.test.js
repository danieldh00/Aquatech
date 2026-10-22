// Planherkenning met AI: validate, het schema, de route /api/plan/analyze (met vaste uitkomst en leren) en de AI-dienst.

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { validate, createPlanAnalyzer, SCHEMA } = require('../src/beregening/plan-analyzer');
const { listen } = require('./helpers/http-client');

const SECRET = 'x'.repeat(64);
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/**
 * Start een testserver met gasten aan.
 * @param {object} [opts] Extra opties voor createApp.
 * @returns {Promise<{ server: import('http').Server, base: string }>} De server en zijn adres.
 */
function start(opts = {}) {
  return listen(createApp({ secret: SECRET, env: { GUEST_ACCESS: 'true' }, ...opts }));
}
/**
 * Stuurt een tekening naar /api/plan/analyze.
 * @param {string} base Adres van de testserver.
 * @param {object} body De body (image, fresh, ...).
 * @returns {Promise<Response>} Het fetch-antwoord.
 */
const post = (base, body) => fetch(`${base}/api/plan/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('validate: schaal uit referentiemaat, ongeldige vlakken weg, coördinaten begrensd', () => {
  const result = validate({
    scale: { method: 'maatvoering', evidence: '12,00 m', confidence: 'hoog', x1: 100, y1: 50, x2: 580, y2: 50, length_m: 12 },
    areas: [
      { type: 'lawn', name: 'Gazon', points: [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 10, y: 10 }] },
      { type: 'zwembad', name: 'X', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] },
      { type: 'bed', name: 'te klein', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    ],
    elements: [{ kind: 'source', x: 5, y: 5, reason: 'kraan' }, { kind: 'pomp', x: 1, y: 1, reason: '' }],
    notes: 'ok',
  }, 800, 600);
  assert.strictEqual(result.scale.metersPerPixel, 12 / 480);
  assert.strictEqual(result.areas.length, 1);
  assert.strictEqual(result.areas[0].points[1].x, 800);
  assert.strictEqual(result.elements.length, 1);
});

test('validate: geen bruikbare referentie geeft geen schaal', () => {
  const result = validate({ scale: { method: 'schatting', evidence: '', confidence: 'laag', x1: 0, y1: 0, x2: 0, y2: 0, length_m: 0 }, areas: [], elements: [], notes: '' }, 100, 100);
  assert.strictEqual(result.scale.metersPerPixel, null);
});

test('schema is strikt (additionalProperties false, alles required)', () => {
  /**
   * Controleert een (deel)schema recursief: objecten strikt en alles verplicht.
   * @param {object} schema Het (deel)schema.
   * @returns {void}
   */
  const walk = (schema) => {
    if (schema.type === 'object') {
      assert.strictEqual(schema.additionalProperties, false);
      assert.deepStrictEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(walk);
    }
    if (schema.type === 'array') walk(schema.items);
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
    assert.strictEqual((await post(base, { image: PNG, width: 10, height: 10, fresh: true })).status, 200);
    const limited = await post(base, { image: PNG, width: 10, height: 10, fresh: true });
    assert.strictEqual(limited.status, 429);
    assert.strictEqual(calls, 2);
    assert.strictEqual((await (await fetch(`${base}/api/plan/status`)).json()).remainingToday, 0);
  } finally { server.close(); }
});

test('zelfde tekening geeft altijd hetzelfde resultaat; opnieuw herkennen kan', async () => {
  let calls = 0;
  const analyzer = {
    available: true,
    model: 'claude-opus-5-5',
    /**
     * Nagebootste herkenning: elke aanroep geeft een ander resultaat.
     * @returns {Promise<object>} Het herkenningsresultaat.
     */
    analyze: async () => {
      calls++;
      return { scale: { metersPerPixel: 0.01 * calls }, areas: [{ type: 'lawn', name: `Gazon ${calls}`, points: [] }], elements: [], notes: '', model: 'claude-opus-5-5', usage: { input_tokens: 1 } };
    },
  };
  const { server, base } = await start({ analyzer });
  try {
    const first = await (await post(base, { image: PNG, width: 10, height: 10 })).json();
    assert.strictEqual(first.recognition.cached, false);
    const second = await (await post(base, { image: PNG, width: 10, height: 10 })).json();
    assert.strictEqual(calls, 1, 'tweede keer geen AI-aanroep');
    assert.strictEqual(second.recognition.cached, true);
    assert.strictEqual(second.recognition.id, first.recognition.id);
    assert.deepStrictEqual(second.areas, first.areas);
    assert.strictEqual(second.scale.metersPerPixel, first.scale.metersPerPixel);
    assert.strictEqual(second.usage, undefined, 'geen kosten bij een bewaarde herkenning');
    // andere tekening: nieuwe herkenning
    await post(base, { image: 'data:image/png;base64,iVBORw0KGgoA', width: 10, height: 10 });
    assert.strictEqual(calls, 2);
    // opnieuw herkennen: nieuwe uitkomst, die daarna vast blijft
    const fresh = await (await post(base, { image: PNG, width: 10, height: 10, fresh: true })).json();
    assert.strictEqual(calls, 3);
    assert.strictEqual(fresh.areas[0].name, 'Gazon 3');
    const after = await (await post(base, { image: PNG, width: 10, height: 10 })).json();
    assert.strictEqual(after.areas[0].name, 'Gazon 3');
    assert.strictEqual(calls, 3);
  } finally { server.close(); }
});

test('leren: kleurtellingen bij een AI-herkenning, opgeteld per omgeving, invoercontrole', async () => {
  const analyzer = { available: true, model: 'claude-opus-5-5', analyze: async () => ({ scale: {}, areas: [], elements: [], notes: '' }) };
  const { server, base } = await start({ analyzer });
  /**
   * Stuurt geleerde tellingen naar /api/plan/learn.
   * @param {object} body De tellingen.
   * @returns {Promise<Response>} Het fetch-antwoord.
   */
  const learn = (body) => fetch(`${base}/api/plan/learn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const empty = await (await fetch(`${base}/api/plan/learned`)).json();
    assert.strictEqual(empty.examples, 0);
    const { recognition } = await (await post(base, { image: PNG, width: 10, height: 10 })).json();
    assert.strictEqual(recognition.learned, false);
    const samples = { v: 1, bins: { 100: [0, 50, 0, 0, 0, 0], 7: [5, 0, 0, 0, 0, 1] } };
    assert.strictEqual((await learn({ recognitionId: recognition.id, samples: { v: 1, bins: { 99999: [1, 0, 0, 0, 0, 0] } } })).status, 400);
    assert.strictEqual((await learn({ recognitionId: recognition.id, samples: { v: 1, bins: { 1: [1, 2, 3] } } })).status, 400);
    assert.strictEqual((await learn({ recognitionId: 'onbekend', samples })).status, 404);
    assert.strictEqual((await learn({ recognitionId: recognition.id, samples })).status, 200);
    // één keer per herkenning
    assert.strictEqual((await learn({ recognitionId: recognition.id, samples })).status, 404);
    const learned = await (await fetch(`${base}/api/plan/learned`)).json();
    assert.strictEqual(learned.examples, 1);
    assert.deepStrictEqual(learned.bins['100'], [0, 50, 0, 0, 0, 0]);
    const again = await (await post(base, { image: PNG, width: 10, height: 10 })).json();
    assert.strictEqual(again.recognition.learned, true);
    // goedgekeurd plan: alleen ingelogd met recht plannen.goedkeuren (zie drawings.test.js)
    assert.strictEqual((await learn({ planId: 'x', samples })).status, 401);
  } finally { server.close(); }
});

test('met toegangscode: analyse vereist inloggen', async () => {
  const analyzer = { available: true, analyze: async () => { throw new Error('mag niet aangeroepen worden'); } };
  const { server, base } = await start({ analyzer, accessCode: 'geheim' });
  try {
    assert.strictEqual((await post(base, { image: PNG, width: 10, height: 10 })).status, 401);
    assert.strictEqual((await fetch(`${base}/api/plan/status`)).status, 401);
    assert.strictEqual((await fetch(`${base}/api/plan/learned`)).status, 401);
  } finally { server.close(); }
});

test('AI-dienst: weigering en onleesbaar antwoord geven nette fout', async () => {
  /**
   * Nagebootste Anthropic-client die altijd het gegeven bericht teruggeeft.
   * @param {object} message Het antwoord van de API.
   * @returns {object} De client.
   */
  const fake = (message) => ({ beta: { messages: { stream: () => ({ finalMessage: async () => message }) } } });
  const a1 = createPlanAnalyzer({ client: fake({ stop_reason: 'refusal', content: [] }) });
  await assert.rejects(a1.analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 }), { code: 'refusal' });
  const a2 = createPlanAnalyzer({ client: fake({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'geen json' }] }) });
  await assert.rejects(a2.analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 }), { code: 'invalid_output' });
  const a3 = createPlanAnalyzer({ client: fake({ stop_reason: 'end_turn', model: 'm', usage: {}, content: [{ type: 'text', text: JSON.stringify({ scale: { method: 'schaalstok', evidence: 'balk 5 m', confidence: 'hoog', x1: 0, y1: 0, x2: 100, y2: 0, length_m: 5 }, areas: [], elements: [], notes: '' }) }] }) });
  const result = await a3.analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 });
  assert.strictEqual(result.scale.metersPerPixel, 0.05);
});

test('verzoek naar de AI-dienst: model, fallback, gestructureerde uitvoer en afbeelding', async () => {
  let req;
  const client = { beta: { messages: { stream: (request) => { req = request; return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"scale":{"method":"schatting","evidence":"","confidence":"laag","x1":0,"y1":0,"x2":0,"y2":0,"length_m":0},"areas":[],"elements":[],"notes":""}' }] }) }; } } } };
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
  /**
   * Een BadRequestError zoals de Anthropic-SDK hem gooit.
   * @param {string} message Foutmelding van de API.
   * @returns {Error} De fout.
   */
  const bad = (message) => new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message } }, message, new Headers());
  const ok = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"scale":{"method":"schatting","evidence":"","confidence":"laag","x1":0,"y1":0,"x2":0,"y2":0,"length_m":0},"areas":[],"elements":[],"notes":""}' }] };
  const logs = [];
  let plainReq;
  const client = {
    beta: { messages: { stream: () => ({ finalMessage: async () => { throw bad('fallbacks: unsupported'); } }) } },
    messages: { stream: (request) => { plainReq = request; return { finalMessage: async () => ok }; } },
  };
  const result = await createPlanAnalyzer({ client, log: (line) => logs.push(line) }).analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 });
  assert.ok(result.scale);
  assert.strictEqual(plainReq.fallbacks, undefined);
  assert.strictEqual(plainReq.betas, undefined);
  assert.match(logs[0], /fallbacks: unsupported/);

  const client2 = {
    beta: { messages: { stream: () => ({ finalMessage: async () => { throw bad('eerste'); } }) } },
    messages: { stream: () => ({ finalMessage: async () => { throw bad('output_config.format: schema niet ondersteund'); } }) },
  };
  await assert.rejects(createPlanAnalyzer({ client: client2, log: () => {} }).analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 }),
    (error) => error.code === 'bad_request' && /schema niet ondersteund/.test(error.message));
});

test('tegoed op: duidelijke melding, geen tweede poging', async () => {
  const Anthropic = require('@anthropic-ai/sdk');
  const msg = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
  let plainCalls = 0;
  const client = {
    beta: { messages: { stream: () => ({ finalMessage: async () => { throw new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: msg } }, msg, new Headers()); } }) } },
    messages: { stream: () => { plainCalls++; return { finalMessage: async () => ({}) }; } },
  };
  await assert.rejects(createPlanAnalyzer({ client, log: () => {} }).analyze({ mediaType: 'image/png', data: 'x', width: 10, height: 10 }),
    (error) => error.code === 'no_credit' && error.status === 402 && /tegoed/.test(error.message));
  assert.strictEqual(plainCalls, 0);
});
