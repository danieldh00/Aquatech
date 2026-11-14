// Tests voor de plan-bouwer van de AI-koppeling: dezelfde rekenkern als de planner, zonder browser en zonder AI.
const test = require('node:test');
const assert = require('node:assert');
const { buildPlan, summarizePlan, sanitizeInput, LIMITS } = require('../src/beregening/plan-builder');
const { runPlanTask } = require('../src/beregening/plan-runner');

const LAWN = { soort: 'lawn', naam: 'Gazon', punten: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }] };
const BED = { soort: 'bed', naam: 'Border', punten: [{ x: 0, y: 8 }, { x: 10, y: 8 }, { x: 10, y: 9.5 }, { x: 0, y: 9.5 }] };

test('buildPlan: gazon en border geven sproeiers, zones en een stuklijst met prijzen', () => {
  const built = buildPlan({ naam: 'Tuin', druk: 3.5, debiet: 2.2, vlakken: [LAWN, BED] });
  assert.ok(!built.problems, JSON.stringify(built.problems));
  assert.ok(built.report.sproeiers.totaal >= 1);
  assert.ok(built.report.zones.length >= 1);
  assert.ok(built.report.stuklijst.length > 0);
  assert.ok(built.report.totaalMateriaalExclBtw > 0);
  assert.strictEqual(built.state.meta.name, 'Tuin');
  assert.strictEqual(built.state.areas.length, 2);
  assert.ok(!('calc' in built.state), 'rekenresultaat hoort niet in het bewaarde plan');
  assert.strictEqual(built.report.aannames.length > 0, true, 'wateraansluting wordt automatisch geplaatst en gemeld');
});

test('buildPlan: dezelfde invoer geeft hetzelfde plan (deterministisch verslag, ids zijn willekeurig)', () => {
  const input = { druk: 3, debiet: 2, vlakken: [LAWN, BED] };
  assert.deepStrictEqual(buildPlan(input).report, buildPlan(input).report);
});

test('buildPlan: een gazon zonder sproeiers in het assortiment geeft een aandachtspunt', () => {
  const built = buildPlan({ druk: 3, debiet: 2, vlakken: [LAWN] }, { catalog: { assortment: ['PE-25'], articles: {} } });
  assert.strictEqual(built.report.sproeiers.totaal, 0);
  assert.ok(built.report.aandachtspunten.some((text) => /geen sproeiers/.test(text)));
});

test('buildPlan: alleen een border geeft geen sproeiers maar wel druppelmateriaal', () => {
  const built = buildPlan({ druk: 3, debiet: 2, vlakken: [BED] });
  assert.strictEqual(built.report.sproeiers.totaal, 0);
  assert.ok(built.report.aandachtspunten.some((text) => /geen gazon/.test(text)));
});

test('buildPlan: grenzen en ongeldige invoer geven meldingen, geen uitzonderingen', () => {
  /**
   * Een vierkant vlak van size x size meter.
   * @param {number} size De zijde.
   * @returns {object[]} De hoekpunten.
   */
  const square = (size) => [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }];
  for (const input of [
    {}, { vlakken: 'x' }, { vlakken: [null] },
    { vlakken: [{ soort: 'lawn', punten: square(80) }] },
    { vlakken: [{ soort: 'lawn', punten: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] }] },
    { vlakken: [{ soort: 'lawn', punten: [{ x: 'a', y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }] },
    { vlakken: Array.from({ length: LIMITS.lawns + 1 }, () => ({ soort: 'lawn', punten: square(5) })) },
    { vlakken: [LAWN], druk: 0 }, { vlakken: [LAWN], debiet: 100 }, { vlakken: [LAWN], sproeiertype: 'x' },
    { vlakken: [LAWN], methodes: JSON.parse('{"constructor":"x","__proto__":"y"}') }, { vlakken: [LAWN], methodes: 'bed' },
  ]) {
    const built = buildPlan(input);
    assert.ok(Array.isArray(built.problems) && built.problems.length, JSON.stringify(input).slice(0, 80));
  }
  assert.deepStrictEqual(sanitizeInput({ vlakken: [LAWN] }).assumed, { pressure: true, flow: true });
});

test('summarizePlan: geeft voor een bewaard plan dezelfde aantallen als bij het bouwen', () => {
  const built = buildPlan({ druk: 3.5, debiet: 2.2, vlakken: [LAWN, BED] });
  const summary = summarizePlan(built.state);
  assert.strictEqual(summary.sproeiers.totaal, built.report.sproeiers.totaal);
  assert.strictEqual(summary.totaalMateriaalExclBtw, built.report.totaalMateriaalExclBtw);
  assert.deepStrictEqual(summarizePlan({}).vlakken, []);
});

test('buildPlan: de gazons samen hebben een grens, zodat de berekening begrensd blijft', () => {
  const lawns = Array.from({ length: 3 }, (_, index) => ({ soort: 'lawn', naam: `Gazon ${index}`, punten: [{ x: index * 60, y: 0 }, { x: index * 60 + 45, y: 0 }, { x: index * 60 + 45, y: 45 }, { x: index * 60, y: 45 }] }));
  const built = buildPlan({ druk: 3, debiet: 2, vlakken: lawns });
  assert.match(built.problems[0], /samen/);
});

test('summarizePlan: een bewaard plan met een kapot vlak geeft geen uitzondering', () => {
  const summary = summarizePlan({ areas: [{ type: 'lawn', name: 'Kapot' }, null], sprinklers: 'x' });
  assert.deepStrictEqual(summary.vlakken, []);
  assert.ok(summary.aandachtspunten.some((text) => /ongeldige hoekpunten/.test(text)));
  assert.deepStrictEqual(summarizePlan({ areas: [{ type: 'lawn', name: 'x', pts: [null, null, null] }] }).vlakken, []);
});

test('runPlanTask: rekent in een werkthread en meldt een fout als een melding', async () => {
  const built = await runPlanTask('buildPlan', [{ druk: 3, debiet: 2, vlakken: [LAWN] }, {}]);
  assert.ok(built.report.sproeiers.totaal >= 1);
  const summary = await runPlanTask('summarizePlan', [built.state, {}]);
  assert.strictEqual(summary.sproeiers.totaal, built.report.sproeiers.totaal);
  const broken = await runPlanTask('bestaatNiet', []);
  assert.ok(broken.problems.length);
});

test('runPlanTask: meer berekeningen dan er tegelijk mogen draaien wachten hun beurt af en geven allemaal een uitkomst', async () => {
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => runPlanTask('buildPlan', [{ druk: 3, debiet: 2, vlakken: [LAWN] }, {}])));
  assert.ok(outcomes.every((outcome) => outcome.report && outcome.report.sproeiers.totaal >= 1));
});
