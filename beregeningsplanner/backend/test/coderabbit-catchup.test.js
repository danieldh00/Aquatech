// CodeRabbit-inhaalreview: ongereviewde gemergde PR's krijgen een label en een cumulatieve inhaal-PR.
const test = require('node:test');
const assert = require('node:assert');
const { BASELINE_BRANCH, CATCHUP_BRANCH, PENDING_LABEL, classifyPulls, catchupText, tick, createClient } = require('../tools/coderabbit-catchup');

const NOW = new Date('2026-11-11T12:00:00Z');

/**
 * Nagebootste GitHub-client met een kleine in-memory wereld.
 * @param {object} world Beginstand: refs, ahead (commits na de baseline), pulls (gemergd), reviewed (PR-nummer:sha), openCatchup, comments.
 * @returns {object} De client plus het logboek `log` van alle schrijfacties.
 */
function fakeClient(world) {
  const log = [];
  return {
    log,
    world,
    /**
     * Geeft de vaste ref terug.
     * @param {string} name Branch.
     * @returns {Promise<string|null>} Commit.
     */
    async getRef(name) { return world.refs[name] || null; },
    /**
     * Legt de nieuwe ref vast.
     * @param {string} name Branch.
     * @param {string} sha Commit.
     * @returns {Promise<void>}
     */
    async createRef(name, sha) { world.refs[name] = sha; log.push(`createRef ${name}`); },
    /**
     * Verplaatst de ref.
     * @param {string} name Branch.
     * @param {string} sha Commit.
     * @param {boolean} force Forceren.
     * @returns {Promise<void>}
     */
    async updateRef(name, sha, force) { world.refs[name] = sha; log.push(`updateRef ${name} force=${force}`); },
    /**
     * Verwijdert de ref.
     * @param {string} name Branch.
     * @returns {Promise<void>}
     */
    async deleteRef(name) { delete world.refs[name]; log.push(`deleteRef ${name}`); },
    /**
     * Geeft de vaste commits terug.
     * @returns {Promise<string[]>} Commits.
     */
    async compareShas() { return world.ahead; },
    /**
     * Geeft de vaste PR's terug.
     * @returns {Promise<object[]>} PR's.
     */
    async listMergedPulls() { return world.pulls; },
    /**
     * Zoekt de review in de vaste stand.
     * @param {number} number PR.
     * @param {string} sha Commit.
     * @returns {Promise<boolean>} Of gereviewd.
     */
    async hasCodeRabbitReview(number, sha) { return world.reviewed.includes(`${number}:${sha}`); },
    /**
     * Geeft de open inhaal-PR terug.
     * @returns {Promise<object|null>} PR.
     */
    async findOpenPull() { return world.openCatchup || null; },
    /**
     * Legt de PR vast.
     * @param {object} pull PR.
     * @returns {Promise<number>} Nummer.
     */
    async createPull(pull) { log.push(`createPull ${pull.head}->${pull.base}`); world.created = pull; return 900; },
    /**
     * Legt het sluiten vast.
     * @param {number} number PR.
     * @returns {Promise<void>}
     */
    async closePull(number) { log.push(`closePull ${number}`); },
    /**
     * Doet niets met labels die al bestaan.
     * @param {string} name Label.
     * @returns {Promise<void>}
     */
    async ensureLabel(name) { log.push(`ensureLabel ${name}`); },
    /**
     * Legt het label vast.
     * @param {number} number PR.
     * @param {string} label Label.
     * @returns {Promise<void>}
     */
    async addLabel(number, label) { log.push(`addLabel ${number} ${label}`); },
    /**
     * Legt het verwijderen vast.
     * @param {number} number PR.
     * @param {string} label Label.
     * @returns {Promise<void>}
     */
    async removeLabel(number, label) { log.push(`removeLabel ${number} ${label}`); },
    /**
     * Legt de opmerking vast.
     * @param {number} number PR.
     * @param {string} body Tekst.
     * @returns {Promise<void>}
     */
    async comment(number, body) { log.push(`comment ${number} ${body.split('\n')[0]}`); },
    /**
     * Geeft de vaste opmerkingen terug.
     * @returns {Promise<object[]>} Opmerkingen.
     */
    async listComments() { return world.comments || []; },
    /**
     * Legt het issue vast.
     * @param {object} issue Issue.
     * @returns {Promise<number>} Nummer.
     */
    async createIssue(issue) { log.push(`createIssue ${issue.title}`); return 77; },
  };
}

/**
 * Nagebootste findings-module die alleen onthoudt dat de inhaal-PR is verwerkt.
 * @param {string[]} log Het logboek om in te schrijven.
 * @returns {object} Met processPullRequest en findingsClient.
 */
function fakeFindings(log) {
  return {
    findingsClient: {},
    /**
     * Legt de verwerking vast.
     * @param {object} _client Client.
     * @param {number} number PR.
     * @param {object} options Opties.
     * @returns {Promise<void>}
     */
    async processPullRequest(_client, number, options) { log.push(`findings ${number} allowUnmerged=${options.allowUnmerged}`); },
  };
}

const PULLS = [
  { number: 10, title: 'Eerste', mergeCommitSha: 'm10', headSha: 'h10' },
  { number: 11, title: 'Tweede', mergeCommitSha: 'm11', headSha: 'h11' },
  { number: 5, title: 'Oud', mergeCommitSha: 'm5', headSha: 'h5' },
];

test('zonder baseline wordt die aangemaakt op master en gebeurt er verder niets', async () => {
  const client = fakeClient({ refs: { master: 'M' }, ahead: [], pulls: [], reviewed: [] });
  assert.match(await tick(client, fakeFindings(client.log), NOW), /baseline aangemaakt/);
  assert.deepStrictEqual(client.log, [`createRef ${BASELINE_BRANCH}`]);
});

test('is de baseline bij, dan gebeurt er niets', async () => {
  const client = fakeClient({ refs: { master: 'M', [BASELINE_BRANCH]: 'M' }, ahead: [], pulls: [], reviewed: [] });
  assert.strictEqual(await tick(client, fakeFindings(client.log), NOW), 'baseline is bij');
  assert.deepStrictEqual(client.log, []);
});

test('alleen gereviewde PR\'s na de baseline: baseline schuift op zonder inhaal-PR', async () => {
  const client = fakeClient({ refs: { master: 'M', [BASELINE_BRANCH]: 'B' }, ahead: ['m10', 'm11'], pulls: PULLS, reviewed: ['10:h10', '11:h11'] });
  await tick(client, fakeFindings(client.log), NOW);
  assert.deepStrictEqual(client.log, [`updateRef ${BASELINE_BRANCH} force=false`, `removeLabel 10 ${PENDING_LABEL}`, `removeLabel 11 ${PENDING_LABEL}`]);
  assert.strictEqual(client.world.refs[BASELINE_BRANCH], 'M');
});

test('een ongereviewde PR krijgt het label en er komt één inhaal-PR naar de baseline (niet naar master)', async () => {
  const client = fakeClient({ refs: { master: 'M', [BASELINE_BRANCH]: 'B' }, ahead: ['m10', 'm11'], pulls: PULLS, reviewed: ['10:h10'] });
  await tick(client, fakeFindings(client.log), NOW);
  assert.ok(client.log.includes(`addLabel 11 ${PENDING_LABEL}`));
  assert.ok(!client.log.includes(`addLabel 10 ${PENDING_LABEL}`), 'de gereviewde PR krijgt geen label');
  assert.ok(client.log.includes(`createRef ${CATCHUP_BRANCH}`));
  assert.ok(client.log.includes(`createPull ${CATCHUP_BRANCH}->${BASELINE_BRANCH}`));
  assert.ok(client.log.some((line) => line.startsWith('comment 900 @coderabbitai review')));
  assert.match(client.world.created.title, /#11/);
  assert.ok(!/#5\b/.test(client.world.created.title), 'PR 5 zit vóór de baseline');
});

test('een PR van vóór de lookback of buiten de nieuwe commits telt niet mee', async () => {
  const { pending, unreviewed } = await classifyPulls(PULLS, new Set(['m11']), async () => false);
  assert.deepStrictEqual(pending.map((pull) => pull.number), [11]);
  assert.deepStrictEqual(unreviewed.map((pull) => pull.number), [11]);
});

test('catchupText noemt alle PR\'s en dat de PR nooit gemerged hoeft te worden', () => {
  const text = catchupText([PULLS[0], PULLS[1]]);
  assert.strictEqual(text.title, 'CodeRabbit inhaalreview: #10, #11');
  assert.match(text.body, /nooit mergen/);
});

test('is de inhaal-PR gereviewd, dan: bevindingen, labels weg, PR dicht, branch weg, baseline naar de kop', async () => {
  const open = { number: 900, headSha: 'H', createdAt: '2026-11-11T08:00:00Z' };
  const client = fakeClient({ refs: { master: 'M2', [BASELINE_BRANCH]: 'B', [CATCHUP_BRANCH]: 'H' }, ahead: ['m10', 'm11'], pulls: PULLS, reviewed: ['900:H'], openCatchup: open });
  await tick(client, fakeFindings(client.log), NOW);
  assert.deepStrictEqual(client.log, [
    'findings 900 allowUnmerged=true',
    `removeLabel 10 ${PENDING_LABEL}`, `removeLabel 11 ${PENDING_LABEL}`,
    `updateRef ${BASELINE_BRANCH} force=true`, 'closePull 900', `deleteRef ${CATCHUP_BRANCH}`,
  ]);
  assert.strictEqual(client.world.refs[BASELINE_BRANCH], 'H');
});

test('zonder review vraagt de workflow na 6 uur opnieuw, eerder niet', async () => {
  const open = { number: 900, headSha: 'H', createdAt: '2026-11-11T08:00:00Z' };
  const recent = [{ body: '@coderabbitai review\n\n<!-- coderabbit-catchup-request -->', createdAt: '2026-11-11T10:00:00Z' }];
  const waiting = fakeClient({ refs: { master: 'M', [BASELINE_BRANCH]: 'B' }, ahead: [], pulls: [], reviewed: [], openCatchup: open, comments: recent });
  assert.match(await tick(waiting, fakeFindings(waiting.log), NOW), /wacht op CodeRabbit/);
  assert.deepStrictEqual(waiting.log, []);
  const old = [{ body: recent[0].body, createdAt: '2026-11-11T05:00:00Z' }];
  const again = fakeClient({ refs: { master: 'M', [BASELINE_BRANCH]: 'B' }, ahead: [], pulls: [], reviewed: [], openCatchup: open, comments: old });
  assert.match(await tick(again, fakeFindings(again.log), NOW), /opnieuw gevraagd/);
});

test('na 72 uur zonder review komt er één issue en geen tweede', async () => {
  const open = { number: 900, headSha: 'H', createdAt: '2026-11-08T08:00:00Z' };
  const first = fakeClient({ refs: { master: 'M', [BASELINE_BRANCH]: 'B' }, ahead: [], pulls: [], reviewed: [], openCatchup: open, comments: [] });
  assert.match(await tick(first, fakeFindings(first.log), NOW), /loopt vast/);
  assert.ok(first.log.some((line) => line.startsWith('createIssue')));
  const second = fakeClient({ refs: { master: 'M', [BASELINE_BRANCH]: 'B' }, ahead: [], pulls: [], reviewed: [], openCatchup: open, comments: [{ body: 'x <!-- coderabbit-catchup-stale -->', createdAt: NOW.toISOString() }] });
  await tick(second, fakeFindings(second.log), NOW);
  assert.deepStrictEqual(second.log, []);
});

test('createClient: getRef geeft null bij 404, createRef verplaatst een bestaande branch, reviews tellen alleen op dezelfde commit', async () => {
  const calls = [];
  const octokit = {
    /**
     * Geeft de vaste reviews terug.
     * @returns {Promise<object[]>} De reviews.
     */
    paginate: async () => [{ user: { login: 'coderabbitai[bot]' }, commit_id: 'old' }, { user: { login: 'iemand' }, commit_id: 'new' }],
    rest: {
      git: {
        getRef: async () => { const error = new Error('weg'); error.status = 404; throw error; },
        createRef: async () => { const error = new Error('bestaat'); error.status = 422; throw error; },
        updateRef: async (parameters) => { calls.push(parameters); },
      },
      pulls: { listReviews: () => {} },
    },
  };
  const client = createClient(octokit, 'x', 'y');
  assert.strictEqual(await client.getRef('nergens'), null);
  await client.createRef('coderabbit/catchup', 'S');
  assert.deepStrictEqual(calls.map((call) => [call.ref, call.sha, call.force]), [['heads/coderabbit/catchup', 'S', true]]);
  assert.strictEqual(await client.hasCodeRabbitReview(1, 'old'), true);
  assert.strictEqual(await client.hasCodeRabbitReview(1, 'new'), false, 'review van een ander telt niet');
});
