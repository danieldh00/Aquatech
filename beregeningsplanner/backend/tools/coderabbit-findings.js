// Zet onopgeloste CodeRabbit-bevindingen op een gemergede pull request om in GitHub-issues met het label
// `coderabbit-bevinding`, zodat ze zichtbaar blijven en door een bouwthread kunnen worden opgepakt nadat de
// PR is gemerged (CodeRabbit is adviserend, zijn goedkeuring is geen merge-vereiste). Eén issue per
// onopgeloste reactiedraad; opmerkingen die CodeRabbit buiten een draad plaatst (buiten de diff, nitpicks)
// komen samen in één issue per review. Elk issue draagt een verborgen sleutel, dus herhaald draaien maakt
// geen dubbele issues. De GitHub-aanroepen zitten in `createClient` zodat de logica zonder netwerk testbaar is.
// Gebruik: de workflow .github/workflows/coderabbit-findings.yml (actions/github-script).

const LABEL = 'coderabbit-bevinding';
const LABEL_COLOR = 'f9a03f';
const LABEL_DESCRIPTION = 'Onopgeloste CodeRabbit-opmerking op een gemergede PR; oppakken in een eigen kleine PR';
const BOT_LOGIN = /^coderabbitai(\[bot\])?$/i;
const KEY_PATTERN = /<!-- coderabbit-key:([^\s>]+) -->/g;
const CRITICAL_LABEL = 'coderabbit-kritiek';
const CRITICAL_COLOR = 'b60205';
const CRITICAL_DESCRIPTION = 'Kritieke of beveiligingsbevinding van CodeRabbit: direct oppakken, niet bundelen';
/** Een bevinding is kritiek bij CodeRabbits eigen markering of als de opmerking over beveiliging gaat. */
const CRITICAL_PATTERN = /🔴|critical|security|beveilig/i;
const MAX_QUOTE = 3000;
const MAX_TITLE = 120;
/** Kopjes in een CodeRabbit-review waaronder opmerkingen staan die geen eigen reactiedraad hebben. */
const OUTSIDE_THREAD_SECTIONS = /(Outside diff range comments|Nitpick comments|Additional comments)/i;

/**
 * Maakt van een CodeRabbit-opmerking een korte titelregel: eerste inhoudelijke regel zonder opmaak.
 * @param {string} body De markdown van de opmerking.
 * @returns {string} Tekst van hoogstens MAX_TITLE tekens.
 */
function titleOf(body) {
  const lines = String(body || '').split('\n').map((line) => line.replace(/<[^>]+>/g, '').replace(/[*_`#>]/g, '').trim());
  const first = lines.find((line) => line && !/^(⚠️|🛠️|🧹|🟠|🟡|🔴|_?potential issue_?)/i.test(line) && line.length > 3) || lines.find(Boolean) || 'opmerking';
  return first.length > MAX_TITLE ? `${first.slice(0, MAX_TITLE - 1)}…` : first;
}

/**
 * Kort een markdown-tekst in voor in een issue.
 * @param {string} text De tekst.
 * @returns {string} De tekst, afgekapt op MAX_QUOTE tekens.
 */
function clip(text) {
  const value = String(text || '').trim();
  return value.length > MAX_QUOTE ? `${value.slice(0, MAX_QUOTE)}\n\n_(ingekort, zie de link voor de volledige opmerking)_` : value;
}

/**
 * Bouwt de issues voor één gemergede pull request.
 * @param {object} pullRequest Minstens `number`, `title`, `html_url`.
 * @param {object[]} threads Reactiedraden: `id`, `isResolved`, `comments[0]` met `author`, `body`, `url`, `path`, `line`.
 * @param {object[]} reviews Reviews: `id`, `author`, `body`, `url`.
 * @returns {{key: string, critical: boolean, title: string, body: string}[]} De te maken issues, met hun sleutel.
 */
function findingsOf(pullRequest, threads, reviews) {
  const found = [];
  const header = `Gevonden door CodeRabbit op [PR #${pullRequest.number}](${pullRequest.html_url}) (${pullRequest.title}), onopgelost bij het mergen.`;
  const footer = '\n\nPak dit op in een eigen kleine PR (Suggested fix letterlijk overnemen) en sluit het issue met `Closes #…`. Is het onjuist of al opgelost, sluit het dan met een korte reden.';
  for (const thread of threads) {
    const first = (thread.comments || [])[0];
    if (thread.isResolved || !first || !BOT_LOGIN.test(first.author || '')) continue;
    const where = first.path ? `\`${first.path}${first.line ? `:${first.line}` : ''}\`` : 'algemeen';
    found.push({
      key: `thread:${thread.id}`,
      critical: CRITICAL_PATTERN.test(first.body || ''),
      title: `CodeRabbit (PR #${pullRequest.number}): ${titleOf(first.body)}`,
      body: `${header}\n\nPlek: ${where}\nReactiedraad: ${first.url}\n\n---\n\n${clip(first.body)}\n\n<!-- coderabbit-key:thread:${thread.id} -->${footer}`,
    });
  }
  for (const review of reviews) {
    if (!BOT_LOGIN.test(review.author || '') || !OUTSIDE_THREAD_SECTIONS.test(review.body || '')) continue;
    found.push({
      key: `review:${review.id}`,
      critical: false,
      title: `CodeRabbit (PR #${pullRequest.number}): opmerkingen buiten de diff of nitpicks`,
      body: `${header}\n\nDeze review bevat opmerkingen zonder eigen reactiedraad (buiten de diff of nitpicks). Loop ze na en maak er zo nodig kleine PR's van.\nReview: ${review.url}\n\n---\n\n${clip(review.body)}\n\n<!-- coderabbit-key:review:${review.id} -->${footer}`,
    });
  }
  return found;
}

/**
 * Haalt de sleutels uit bestaande issues, zodat een bevinding niet twee keer wordt aangemaakt.
 * @param {{body: string}[]} issues Issues met het label (open en gesloten).
 * @returns {Set<string>} De sleutels.
 */
function existingKeys(issues) {
  const keys = new Set();
  for (const issue of issues) {
    for (const match of String(issue.body || '').matchAll(KEY_PATTERN)) keys.add(match[1]);
  }
  return keys;
}

/**
 * Verwerkt één pull request: alleen als hij is gemerged (of `allowUnmerged`, voor de inhaal-PR van
 * coderabbit-catchup.js), en alleen bevindingen die nog geen issue hebben.
 * @param {object} client De GitHub-aanroepen (zie createClient).
 * @param {number} number Het nummer van de PR.
 * @param {{allowUnmerged?: boolean, origin?: string}} [options] `allowUnmerged`: ook een PR die niet is gemerged verwerken; `origin`: de oorspronkelijke PR's, komt in elk issue.
 * @returns {Promise<{number: number, created: number[], skipped: string}>} Nummers van de nieuwe issues; `skipped` noemt waarom er niets is gedaan.
 */
async function processPullRequest(client, number, options = {}) {
  const pullRequest = await client.getPullRequest(number);
  if (!pullRequest.merged_at && !options.allowUnmerged) return { number, created: [], skipped: 'niet gemerged' };
  const [threads, reviews] = await Promise.all([client.listThreads(number), client.listReviews(number)]);
  const findings = findingsOf(pullRequest, threads, reviews);
  if (!findings.length) return { number, created: [], skipped: 'geen onopgeloste bevindingen' };
  await client.ensureLabel(LABEL, LABEL_COLOR, LABEL_DESCRIPTION);
  if (findings.some((finding) => finding.critical)) await client.ensureLabel(CRITICAL_LABEL, CRITICAL_COLOR, CRITICAL_DESCRIPTION);
  const known = existingKeys(await client.listIssuesWithLabel(LABEL));
  const created = [];
  for (const finding of findings) {
    if (known.has(finding.key)) continue;
    created.push(await client.createIssue({ title: finding.title, body: options.origin ? `${finding.body}\n\nOorspronkelijke PR's: ${options.origin}` : finding.body, labels: finding.critical ? [LABEL, CRITICAL_LABEL] : [LABEL] }));
    known.add(finding.key);
  }
  return { number, created, skipped: created.length ? '' : 'alles had al een issue' };
}

/**
 * Loopt alle recent gemergede pull requests na (vangt reviews die na het mergen binnenkomen en gemiste events).
 * @param {object} client De GitHub-aanroepen (zie createClient).
 * @param {number} days Hoeveel dagen terug.
 * @param {Date} [now] Huidig moment (voor tests).
 * @returns {Promise<object[]>} Het resultaat van processPullRequest per PR.
 */
async function sweep(client, days, now = new Date()) {
  const since = new Date(now.getTime() - days * 86400000).toISOString();
  const results = [];
  for (const number of await client.listMergedSince(since)) results.push(await processPullRequest(client, number));
  return results;
}

/**
 * Koppelt de logica aan GitHub via een Octokit-instantie (die van actions/github-script of van `gh`-loze fetch).
 * @param {object} octokit Octokit met `rest`, `paginate` en `graphql`.
 * @param {string} owner Eigenaar van de repository.
 * @param {string} repo Naam van de repository.
 * @returns {object} De client voor processPullRequest en sweep.
 */
function createClient(octokit, owner, repo) {
  const threadsQuery = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes {
        id isResolved comments(first: 1) { nodes { body url path line author { login } } } } } } } }`;
  return {
    /**
     * Haalt de pull request op.
     * @param {number} number PR-nummer.
     * @returns {Promise<object>} De pull request.
     */
    async getPullRequest(number) {
      return (await octokit.rest.pulls.get({ owner, repo, pull_number: number })).data;
    },
    /**
     * Haalt alle reviewdraden op, pagina voor pagina.
     * @param {number} number PR-nummer.
     * @returns {Promise<object[]>} Reactiedraden in het formaat van findingsOf.
     */
    async listThreads(number) {
      const threads = [];
      let after = null;
      for (;;) {
        const data = await octokit.graphql(threadsQuery, { owner, repo, number, after });
        const page = data.repository.pullRequest.reviewThreads;
        for (const node of page.nodes) {
          threads.push({
            id: node.id,
            isResolved: node.isResolved,
            comments: node.comments.nodes.map((comment) => ({ ...comment, author: comment.author && comment.author.login })),
          });
        }
        if (!page.pageInfo.hasNextPage) return threads;
        after = page.pageInfo.endCursor;
      }
    },
    /**
     * Haalt alle reviews op.
     * @param {number} number PR-nummer.
     * @returns {Promise<object[]>} Reviews in het formaat van findingsOf.
     */
    async listReviews(number) {
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
      return reviews.map((review) => ({ id: review.id, author: review.user && review.user.login, body: review.body, url: review.html_url }));
    },
    /**
     * Maakt het label aan als het nog niet bestaat.
     * @param {string} name Labelnaam.
     * @param {string} color Kleur zonder #.
     * @param {string} description Uitleg.
     * @returns {Promise<void>}
     */
    async ensureLabel(name, color, description) {
      try {
        await octokit.rest.issues.getLabel({ owner, repo, name });
      } catch (error) {
        if (error.status !== 404) throw error;
        await octokit.rest.issues.createLabel({ owner, repo, name, color, description });
      }
    },
    /**
     * Haalt de issues met het label op.
     * @param {string} label Labelnaam.
     * @returns {Promise<object[]>} Open en gesloten issues met dat label (zonder pull requests).
     */
    async listIssuesWithLabel(label) {
      const issues = await octokit.paginate(octokit.rest.issues.listForRepo, { owner, repo, labels: label, state: 'all', per_page: 100 });
      return issues.filter((issue) => !issue.pull_request);
    },
    /**
     * Maakt een issue aan.
     * @param {{title: string, body: string, labels: string[]}} issue De nieuwe issue.
     * @returns {Promise<number>} Het issuenummer.
     */
    async createIssue(issue) {
      return (await octokit.rest.issues.create({ owner, repo, ...issue })).data.number;
    },
    /**
     * Zoekt de pull requests die sinds een moment zijn gemerged.
     * @param {string} since ISO-tijdstip.
     * @returns {Promise<number[]>} Nummers van PR's die sinds dat moment zijn gemerged.
     */
    async listMergedSince(since) {
      const pulls = await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 }, (response, done) => {
        if (response.data.length && response.data[response.data.length - 1].updated_at < since) done();
        return response.data;
      });
      return pulls.filter((pull) => pull.merged_at && pull.merged_at >= since).map((pull) => pull.number);
    },
  };
}

module.exports = { LABEL, CRITICAL_LABEL, titleOf, findingsOf, existingKeys, processPullRequest, sweep, createClient };
