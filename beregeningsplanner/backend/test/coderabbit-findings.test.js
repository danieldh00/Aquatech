// CodeRabbit-bevindingen: onopgeloste opmerkingen op een gemergede PR worden issues, zonder dubbelen.
const test = require('node:test');
const assert = require('node:assert');
const { CRITICAL_LABEL, titleOf, findingsOf, existingKeys, processPullRequest, sweep, createClient } = require('../tools/coderabbit-findings');

const PULL_REQUEST = { number: 150, title: 'Voorbeeld', html_url: 'https://github.com/x/y/pull/150', merged_at: '2026-11-11T06:00:00Z' };

/**
 * Een reactiedraad zoals createClient hem teruggeeft.
 * @param {string} id Draad-id.
 * @param {object} [overrides] Velden die afwijken.
 * @returns {object} De reactiedraad.
 */
function thread(id, overrides = {}) {
  return {
    id,
    isResolved: false,
    comments: [{ author: 'coderabbitai', body: '_⚠️ Potential issue_\n\n**Tenantfilter ontbreekt in de query.**\n\nDetails.', url: `https://github.com/x/y/pull/150#discussion_${id}`, path: 'a/b.js', line: 12 }],
    ...overrides,
  };
}

/**
 * Nagebootste GitHub-client die bijhoudt welke issues zijn aangemaakt.
 * @param {object} data pull (de PR), threads, reviews en issues (bestaande).
 * @returns {object} Client plus `created`, de lijst aangemaakte issues.
 */
function fakeClient({ pull = PULL_REQUEST, threads = [], reviews = [], issues = [], merged = [150] }) {
  const created = [];
  return {
    created,
    labels: [],
    /**
     * Geeft de vaste PR terug.
     * @returns {Promise<object>} De PR.
     */
    async getPullRequest() { return pull; },
    /**
     * Geeft de vaste reactiedraden terug.
     * @returns {Promise<object[]>} De draden.
     */
    async listThreads() { return threads; },
    /**
     * Geeft de vaste reviews terug.
     * @returns {Promise<object[]>} De reviews.
     */
    async listReviews() { return reviews; },
    /**
     * Onthoudt dat het label is aangemaakt.
     * @param {string} name Labelnaam.
     * @returns {Promise<void>}
     */
    async ensureLabel(name) { this.labels.push(name); },
    /**
     * Geeft bestaande en zojuist aangemaakte issues terug.
     * @returns {Promise<object[]>} De issues.
     */
    async listIssuesWithLabel() { return [...issues, ...created.map((issue) => ({ body: issue.body }))]; },
    /**
     * Legt het issue vast.
     * @param {object} issue Het issue.
     * @returns {Promise<number>} Een nepnummer.
     */
    async createIssue(issue) { created.push(issue); return 200 + created.length; },
    /**
     * Geeft de vaste PR-nummers terug.
     * @returns {Promise<number[]>} De nummers.
     */
    async listMergedSince() { return merged; },
  };
}

test('titleOf slaat opmaak en het label over en kort in', () => {
  assert.strictEqual(titleOf('_⚠️ Potential issue_\n\n**Tenantfilter ontbreekt.**'), 'Tenantfilter ontbreekt.');
  assert.strictEqual(titleOf(''), 'opmerking');
  assert.ok(titleOf('x'.repeat(500)).length <= 120);
});

test('findingsOf neemt alleen onopgeloste draden van CodeRabbit en review-opmerkingen buiten een draad', () => {
  const found = findingsOf(PULL_REQUEST, [
    thread('t1'),
    thread('t2', { isResolved: true }),
    thread('t3', { comments: [{ author: 'danieldh00', body: 'Eigen opmerking', url: 'u', path: 'a.js', line: 1 }] }),
    thread('t4', { comments: [] }),
  ], [
    { id: 9, author: 'coderabbitai[bot]', body: 'Actionable\n<summary>🧹 Nitpick comments (2)</summary>', url: 'https://github.com/x/y/pull/150#pullrequestreview-9' },
    { id: 10, author: 'coderabbitai[bot]', body: 'Alles goed.', url: 'u' },
    { id: 11, author: 'iemand', body: 'Nitpick comments', url: 'u' },
  ]);
  assert.deepStrictEqual(found.map((finding) => finding.key), ['thread:t1', 'review:9']);
  assert.match(found[0].title, /^CodeRabbit \(PR #150\): Tenantfilter ontbreekt in de query\.$/);
  assert.match(found[0].body, /`a\/b\.js:12`/);
  assert.match(found[0].body, /<!-- coderabbit-key:thread:t1 -->/);
});

test('processPullRequest maakt per bevinding één issue en herhaald draaien maakt geen dubbelen', async () => {
  const client = fakeClient({ threads: [thread('t1'), thread('t2')] });
  const first = await processPullRequest(client, 150);
  assert.strictEqual(first.created.length, 2);
  assert.deepStrictEqual(client.labels, ['coderabbit-bevinding']);
  assert.ok(client.created.every((issue) => issue.labels.includes('coderabbit-bevinding')));
  const second = await processPullRequest(client, 150);
  assert.deepStrictEqual(second.created, []);
  assert.strictEqual(client.created.length, 2);
});

test('een gesloten issue met dezelfde sleutel telt mee (niet opnieuw openen)', async () => {
  const closed = findingsOf(PULL_REQUEST, [thread('t1')], [])[0].body;
  const client = fakeClient({ threads: [thread('t1')], issues: [{ body: closed }] });
  assert.deepStrictEqual((await processPullRequest(client, 150)).created, []);
});

test('een PR die niet is gemerged krijgt geen issues', async () => {
  const client = fakeClient({ pull: { ...PULL_REQUEST, merged_at: null }, threads: [thread('t1')] });
  const result = await processPullRequest(client, 150);
  assert.deepStrictEqual(result.created, []);
  assert.strictEqual(result.skipped, 'niet gemerged');
  assert.strictEqual(client.created.length, 0);
});

test('zonder onopgeloste bevindingen wordt het label niet eens aangemaakt', async () => {
  const client = fakeClient({ threads: [thread('t1', { isResolved: true })] });
  assert.strictEqual((await processPullRequest(client, 150)).skipped, 'geen onopgeloste bevindingen');
  assert.deepStrictEqual(client.labels, []);
});

test('existingKeys leest alle sleutels uit de issueteksten', () => {
  const keys = existingKeys([{ body: 'a <!-- coderabbit-key:thread:PRRT_1 --> b' }, { body: '<!-- coderabbit-key:review:7 -->' }, { body: null }]);
  assert.deepStrictEqual([...keys].sort(), ['review:7', 'thread:PRRT_1']);
});

test('sweep verwerkt elke recent gemergede PR', async () => {
  const client = fakeClient({ threads: [thread('t1')], merged: [150, 151] });
  const results = await sweep(client, 7, new Date('2026-11-12T00:00:00Z'));
  assert.strictEqual(results.length, 2);
  assert.strictEqual(client.created.length, 1, 'dezelfde draad-sleutel levert maar één issue op');
});

test('createClient pagineert de reactiedraden en maakt het label alleen aan als het ontbreekt', async () => {
  const pages = [
    { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ id: 'a', isResolved: false, comments: { nodes: [{ body: 'x', url: 'u', path: 'p', line: 1, author: { login: 'coderabbitai' } }] } }] } } } },
    { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'b', isResolved: true, comments: { nodes: [{ body: 'y', url: 'u', path: 'p', line: 2, author: null }] } }] } } } },
  ];
  const cursors = [];
  const created = [];
  const octokit = {
    /**
     * Geeft de volgende pagina reactiedraden terug en onthoudt de cursor.
     * @param {string} _query De query.
     * @param {object} variables De variabelen.
     * @returns {Promise<object>} De pagina.
     */
    graphql: async (_query, variables) => { cursors.push(variables.after); return pages[cursors.length - 1]; },
    rest: { issues: {
      getLabel: async () => { const error = new Error('niet gevonden'); error.status = 404; throw error; },
      createLabel: async (parameters) => { created.push(parameters.name); },
    } },
  };
  const client = createClient(octokit, 'x', 'y');
  const threads = await client.listThreads(150);
  assert.deepStrictEqual(cursors, [null, 'c1']);
  assert.deepStrictEqual(threads.map((entry) => entry.id), ['a', 'b']);
  assert.strictEqual(threads[0].comments[0].author, 'coderabbitai');
  assert.strictEqual(threads[1].comments[0].author, null);
  await client.ensureLabel('coderabbit-bevinding', 'f9a03f', 'x');
  assert.deepStrictEqual(created, ['coderabbit-bevinding']);
});

test('een kritieke of beveiligingsbevinding krijgt ook het label coderabbit-kritiek', async () => {
  const critical = thread('t9', { comments: [{ author: 'coderabbitai', body: '_⚠️ Potential issue_ | _🔴 Critical_\n\n**Tenant-id ontbreekt.**', url: 'u', path: 'a.js', line: 3 }] });
  const client = fakeClient({ threads: [thread('t1'), critical] });
  await processPullRequest(client, 150);
  assert.deepStrictEqual(client.created.map((issue) => issue.labels), [['coderabbit-bevinding'], ['coderabbit-bevinding', CRITICAL_LABEL]]);
  assert.deepStrictEqual(client.labels, ['coderabbit-bevinding', CRITICAL_LABEL]);
});
