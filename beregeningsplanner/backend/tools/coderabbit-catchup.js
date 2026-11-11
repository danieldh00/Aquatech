// Inhaalreview voor gemergde PR's die CodeRabbit niet (op tijd) heeft gereviewd, bijvoorbeeld door zijn uurlimiet:
// er mag geen merge ongereviewd blijven. De branch `coderabbit-baseline` wijst naar de laatste master-commit waarvan
// zeker is dat CodeRabbit hem heeft gezien. Is master daar voorbij en heeft een gemergde PR geen CodeRabbit-review op
// zijn laatste commit, dan labelt dit de PR `coderabbit-pending` en opent het een PR (nooit te mergen) van
// `coderabbit/catchup` (master-kop) naar de baseline met de cumulatieve diff, en vraagt CodeRabbit die te reviewen.
// Die PR heeft master niet als doel, dus de versiecontrole draait er niet op en er is geen subnummer nodig. Zodra
// CodeRabbit de kop heeft gereviewd gaan de bevindingen de issueroute in (coderabbit-findings.js), wordt de PR
// gesloten en schuift de baseline op. Logica zonder netwerk testbaar via een nagebootste client; `createClient`
// koppelt aan GitHub via Octokit (actions/github-script in .github/workflows/coderabbit-catchup.yml).

const BASELINE_BRANCH = 'coderabbit-baseline';
const CATCHUP_BRANCH = 'coderabbit/catchup';
const PENDING_LABEL = 'coderabbit-pending';
const CATCHUP_LABEL = 'coderabbit-catchup';
const REVIEW_REQUEST = '@coderabbitai review';
const REQUEST_MARKER = '<!-- coderabbit-catchup-request -->';
const STALE_MARKER = 'coderabbit-catchup-stale';
const LOOKBACK_DAYS = 14;
const REREQUEST_HOURS = 6;
const GIVE_UP_HOURS = 72;
const HOUR_MS = 3600000;
const BOT_LOGIN = /^coderabbitai(\[bot\])?$/i;

/**
 * Bepaalt welke gemergede PR's nog geen CodeRabbit-review op hun laatste commit hebben.
 * @param {{number: number, mergeCommitSha: string, headSha: string}[]} mergedPulls Gemergde PR's.
 * @param {Set<string>} aheadShas Commits op master die na de baseline zijn gekomen.
 * @param {(number: number, sha: string) => Promise<boolean>} hasReview Of CodeRabbit die commit van die PR heeft gereviewd.
 * @returns {Promise<{pending: object[], unreviewed: object[]}>} Alle PR's na de baseline en daarvan de ongereviewde.
 */
async function classifyPulls(mergedPulls, aheadShas, hasReview) {
  const pending = mergedPulls.filter((pull) => aheadShas.has(pull.mergeCommitSha));
  const unreviewed = [];
  for (const pull of pending) {
    if (!(await hasReview(pull.number, pull.headSha))) unreviewed.push(pull);
  }
  return { pending, unreviewed };
}

/**
 * Titel en tekst van de inhaal-PR.
 * @param {{number: number, title: string}[]} unreviewed De ongereviewde PR's.
 * @returns {{title: string, body: string}} De tekst voor de PR.
 */
function catchupText(unreviewed) {
  const numbers = unreviewed.map((pull) => `#${pull.number}`).join(', ');
  const list = unreviewed.map((pull) => `- #${pull.number} ${pull.title}`).join('\n');
  return {
    title: `CodeRabbit inhaalreview: ${numbers}`,
    body: `Automatische PR, **nooit mergen**. Dit is de cumulatieve diff van master sinds de laatste door CodeRabbit gereviewde stand (\`${BASELINE_BRANCH}\`), zodat CodeRabbit PR's alsnog reviewt die hij vóór het mergen niet kon doen (bijvoorbeeld door zijn limiet).\n\nGemergde PR's zonder CodeRabbit-review:\n${list}\n\nOnopgeloste bevindingen worden issues met het label \`coderabbit-bevinding\`; daarna sluit de workflow deze PR en schuift de baseline op.`,
  };
}

/**
 * Eén doorloop: houdt de baseline bij, labelt ongereviewde PR's en regelt de inhaal-PR.
 * @param {object} client De GitHub-aanroepen (zie createClient).
 * @param {object} findings Functies uit coderabbit-findings.js: `processPullRequest(findingsClient, number, options)` en `findingsClient`.
 * @param {Date} [now] Huidig moment (voor tests).
 * @returns {Promise<string>} Korte beschrijving van wat er is gedaan.
 */
async function tick(client, findings, now = new Date()) {
  const masterSha = await client.getRef('master');
  const baselineSha = await client.getRef(BASELINE_BRANCH);
  if (!baselineSha) {
    await client.createRef(BASELINE_BRANCH, masterSha);
    return 'baseline aangemaakt op de huidige master; eerdere merges gelden als gereviewd';
  }
  const catchup = await client.findOpenPull(CATCHUP_BRANCH);
  if (catchup) return handleOpenCatchup(client, findings, catchup, now);

  const ahead = await client.compareShas(baselineSha, masterSha);
  if (!ahead.length) return 'baseline is bij';
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * HOUR_MS).toISOString();
  const mergedPulls = await client.listMergedPulls(since);
  const { pending, unreviewed } = await classifyPulls(mergedPulls, new Set(ahead), (number, sha) => client.hasCodeRabbitReview(number, sha));
  if (!unreviewed.length) {
    await client.updateRef(BASELINE_BRANCH, masterSha, false);
    for (const pull of pending) await client.removeLabel(pull.number, PENDING_LABEL);
    return `alles na de baseline was gereviewd (${pending.length} PR's); baseline opgeschoven`;
  }
  await client.ensureLabel(PENDING_LABEL, 'fbca04', 'Gemerged zonder voltooide CodeRabbit-review; inhaalreview loopt');
  await client.ensureLabel(CATCHUP_LABEL, 'fbca04', 'Automatische inhaalreview voor CodeRabbit; nooit mergen');
  for (const pull of unreviewed) await client.addLabel(pull.number, PENDING_LABEL);
  await client.createRef(CATCHUP_BRANCH, masterSha);
  const text = catchupText(unreviewed);
  const number = await client.createPull({ ...text, head: CATCHUP_BRANCH, base: BASELINE_BRANCH });
  await client.addLabel(number, CATCHUP_LABEL);
  await client.comment(number, `${REVIEW_REQUEST}\n\n${REQUEST_MARKER}`);
  return `inhaalreview geopend (PR #${number}) voor ${unreviewed.length} PR('s)`;
}

/**
 * Verwerkt een openstaande inhaal-PR: afronden als CodeRabbit klaar is, anders opnieuw vragen of opgeven.
 * @param {object} client De GitHub-aanroepen.
 * @param {object} findings Zie tick.
 * @param {{number: number, headSha: string, createdAt: string}} catchup De open inhaal-PR.
 * @param {Date} now Huidig moment.
 * @returns {Promise<string>} Korte beschrijving van wat er is gedaan.
 */
async function handleOpenCatchup(client, findings, catchup, now) {
  if (await client.hasCodeRabbitReview(catchup.number, catchup.headSha)) {
    await findings.processPullRequest(findings.findingsClient, catchup.number, { allowUnmerged: true });
    const baselineSha = await client.getRef(BASELINE_BRANCH);
    const ahead = await client.compareShas(baselineSha, catchup.headSha);
    const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * HOUR_MS).toISOString();
    const covered = new Set(ahead);
    for (const pull of await client.listMergedPulls(since)) {
      if (covered.has(pull.mergeCommitSha)) await client.removeLabel(pull.number, PENDING_LABEL);
    }
    await client.updateRef(BASELINE_BRANCH, catchup.headSha, true);
    await client.closePull(catchup.number);
    await client.deleteRef(CATCHUP_BRANCH);
    return `inhaalreview PR #${catchup.number} afgerond; baseline opgeschoven`;
  }
  const ageHours = (now.getTime() - new Date(catchup.createdAt).getTime()) / HOUR_MS;
  const comments = await client.listComments(catchup.number);
  if (comments.some((comment) => String(comment.body).includes(STALE_MARKER))) return 'wacht op CodeRabbit; opgegeven-melding staat al';
  if (ageHours >= GIVE_UP_HOURS) {
    await client.createIssue({
      title: `CodeRabbit heeft inhaalreview PR #${catchup.number} niet uitgevoerd`,
      body: `CodeRabbit heeft de inhaalreview in ${GIVE_UP_HOURS} uur niet gedaan (limiet, of hij reageert niet op een opmerking van een bot). Vink bij PR #${catchup.number} handmatig *Trigger review* aan of plaats zelf \`${REVIEW_REQUEST}\`; de workflow rondt de rest daarna af.\n\n<!-- ${STALE_MARKER} -->`,
      labels: [],
    });
    await client.comment(catchup.number, `Opgegeven na ${GIVE_UP_HOURS} uur, zie het aangemaakte issue.\n\n<!-- ${STALE_MARKER} -->`);
    return `inhaalreview PR #${catchup.number} loopt vast; issue aangemaakt`;
  }
  const requests = comments.filter((comment) => String(comment.body).includes(REQUEST_MARKER));
  const lastRequest = requests.length ? new Date(requests[requests.length - 1].createdAt).getTime() : 0;
  if (now.getTime() - lastRequest >= REREQUEST_HOURS * HOUR_MS) {
    await client.comment(catchup.number, `${REVIEW_REQUEST}\n\n${REQUEST_MARKER}`);
    return `review opnieuw gevraagd op PR #${catchup.number}`;
  }
  return `wacht op CodeRabbit (PR #${catchup.number})`;
}

/**
 * Koppelt de logica aan GitHub via een Octokit-instantie.
 * @param {object} octokit Octokit met `rest` en `paginate`.
 * @param {string} owner Eigenaar van de repository.
 * @param {string} repo Naam van de repository.
 * @returns {object} De client voor tick.
 */
function createClient(octokit, owner, repo) {
  return {
    /**
     * Leest de commit waar een branch naar wijst.
     * @param {string} name Branchnaam.
     * @returns {Promise<string|null>} De commit waar de branch naar wijst, of null.
     */
    async getRef(name) {
      try {
        return (await octokit.rest.git.getRef({ owner, repo, ref: `heads/${name}` })).data.object.sha;
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },
    /**
     * Maakt een branch aan (een bestaande met dezelfde naam wordt verplaatst).
     * @param {string} name Branchnaam.
     * @param {string} sha Commit.
     * @returns {Promise<void>}
     */
    async createRef(name, sha) {
      try {
        await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${name}`, sha });
      } catch (error) {
        if (error.status !== 422) throw error;
        await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${name}`, sha, force: true });
      }
    },
    /**
     * Verplaatst een bestaande branch naar een commit.
     * @param {string} name Branchnaam.
     * @param {string} sha Nieuwe commit.
     * @param {boolean} force Ook toestaan als dat geen vooruitgang is.
     * @returns {Promise<void>}
     */
    async updateRef(name, sha, force) {
      await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${name}`, sha, force });
    },
    /**
     * Verwijdert een branch.
     * @param {string} name Branchnaam.
     * @returns {Promise<void>}
     */
    async deleteRef(name) {
      await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${name}` });
    },
    /**
     * Zoekt de commits in head die niet in base zitten.
     * @param {string} base Basiscommit.
     * @param {string} head Kopcommit.
     * @returns {Promise<string[]>} De commits in head die niet in base zitten (hoogstens 250).
     */
    async compareShas(base, head) {
      const response = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${head}`, per_page: 100 });
      return response.data.commits.map((commit) => commit.sha);
    },
    /**
     * Haalt de recent gemergde PR's naar master op.
     * @param {string} since ISO-tijdstip.
     * @returns {Promise<object[]>} Gemergde PR's naar master sinds dat moment.
     */
    async listMergedPulls(since) {
      const pulls = await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: 'closed', base: 'master', sort: 'updated', direction: 'desc', per_page: 100 }, (response, done) => {
        if (response.data.length && response.data[response.data.length - 1].updated_at < since) done();
        return response.data;
      });
      return pulls.filter((pull) => pull.merged_at && pull.merged_at >= since)
        .map((pull) => ({ number: pull.number, title: pull.title, mergeCommitSha: pull.merge_commit_sha, headSha: pull.head.sha }));
    },
    /**
     * Controleert of CodeRabbit een review op precies die commit heeft gepost.
     * @param {number} number PR-nummer.
     * @param {string} sha Commit.
     * @returns {Promise<boolean>} Of CodeRabbit een review op precies die commit heeft gepost.
     */
    async hasCodeRabbitReview(number, sha) {
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
      return reviews.some((review) => review.user && BOT_LOGIN.test(review.user.login) && review.commit_id === sha);
    },
    /**
     * Zoekt de open PR vanaf een branch.
     * @param {string} headBranch Branchnaam van de kop.
     * @returns {Promise<object|null>} De open PR vanaf die branch, of null.
     */
    async findOpenPull(headBranch) {
      const pulls = await octokit.rest.pulls.list({ owner, repo, state: 'open', head: `${owner}:${headBranch}`, per_page: 1 });
      const pull = pulls.data[0];
      return pull ? { number: pull.number, headSha: pull.head.sha, createdAt: pull.created_at } : null;
    },
    /**
     * Opent een pull request.
     * @param {{title: string, body: string, head: string, base: string}} pull De nieuwe PR.
     * @returns {Promise<number>} Het PR-nummer.
     */
    async createPull(pull) {
      return (await octokit.rest.pulls.create({ owner, repo, ...pull })).data.number;
    },
    /**
     * Sluit een pull request.
     * @param {number} number PR-nummer.
     * @returns {Promise<void>}
     */
    async closePull(number) {
      await octokit.rest.pulls.update({ owner, repo, pull_number: number, state: 'closed' });
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
     * Zet een label op een PR.
     * @param {number} number PR-nummer.
     * @param {string} label Labelnaam.
     * @returns {Promise<void>}
     */
    async addLabel(number, label) {
      await octokit.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [label] });
    },
    /**
     * Haalt een label van een PR (zonder fout als het er niet op staat).
     * @param {number} number PR-nummer.
     * @param {string} label Labelnaam.
     * @returns {Promise<void>}
     */
    async removeLabel(number, label) {
      try {
        await octokit.rest.issues.removeLabel({ owner, repo, issue_number: number, name: label });
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    },
    /**
     * Plaatst een opmerking op een PR.
     * @param {number} number PR-nummer.
     * @param {string} body Tekst.
     * @returns {Promise<void>}
     */
    async comment(number, body) {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body });
    },
    /**
     * Haalt de opmerkingen van een PR op.
     * @param {number} number PR-nummer.
     * @returns {Promise<{body: string, createdAt: string}[]>} De opmerkingen.
     */
    async listComments(number) {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });
      return comments.map((comment) => ({ body: comment.body, createdAt: comment.created_at }));
    },
    /**
     * Maakt een issue aan.
     * @param {{title: string, body: string, labels: string[]}} issue Het issue.
     * @returns {Promise<number>} Het issuenummer.
     */
    async createIssue(issue) {
      return (await octokit.rest.issues.create({ owner, repo, ...issue })).data.number;
    },
  };
}

module.exports = { BASELINE_BRANCH, CATCHUP_BRANCH, PENDING_LABEL, classifyPulls, catchupText, tick, createClient };
