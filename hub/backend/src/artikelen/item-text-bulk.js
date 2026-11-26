// Omschrijvingen in bulk door de AI (Artikelen > Teksten > "Alles schrijven"): per hoofdartikel eerst de kenmerken opzoeken in de bron van de fabrikant
// (alleen wat letterlijk in de bron staat, met adres en zin; bewaard in item_specs, zie item-text-log.js) en daarna de omschrijving schrijven uit alleen die
// bekende gegevens (item-text-writer.js, met de specificaties van Past bij).
//
// - Vooraf een kostenschatting (GET .../bulk/todo); daarna start POST .../bulk/job een achtergrondtaak op de server (background-jobs.js) die alle artikelen in porties doorloopt, ook als de browser sluit; de stand staat bij GET .../bulk/job en stoppen kan met POST .../bulk/job/stop. POST .../bulk/run (één portie) blijft bestaan.
// - Zonder bestaande omschrijving gaat een tekst zonder waarschuwingen direct live ("nieuw"). Bij een bestaande omschrijving oordeelt de AI of de nieuwe beter is:
//   zo ja dan wordt hij overschreven ("overschreven", de vorige tekst blijft bewaard en kan terug), zo nee dan blijft hij staan ("behouden").
// - Een tekst met waarschuwingen van de feitencontrole (getal, eenheid of bewering die niet in de gegevens staat) gaat nooit live maar wordt een concept
//   voor handmatige beoordeling, zoals bij het schrijven per artikel.
// - Samengevoegde (variabele) artikelen krijgen één tekst op het hoofdartikel; varianten en gearchiveerde artikelen worden overgeslagen.
// - Een bulkrun telt niet mee voor het dagelijkse maximum van AI-verzoeken (dat is bedoeld voor losse verzoeken). In plaats daarvan geldt een eigen dagplafond
//   (instelling descriptionBulkDailyItems, in het geheugen geteld: één container) en een uurlimiet; de schatting en de bevestiging in het scherm komen daar nog bij.
// - Een artikel dat al in behandeling is (tweede tabblad, dubbelklik) wordt overgeslagen, en een tekst wordt alleen overschreven als de bestaande omschrijving
//   nog gelijk is aan die waarop de AI zijn oordeel baseerde.
const { AnalyzeError } = require('../beregening/plan-analyzer');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const AiModelList = require(path.join(FRONTEND_DIR, 'shared', 'ai-models.js'));
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { checkText } = require('./item-text-check');
const { createJobs, createJobPersistence } = require('./background-jobs');

/** Hoeveel artikelen één verzoek hoogstens bevat. */
const BULK_BATCH = 6;
/** Hoeveel artikelen tegelijk bij de AI-dienst. */
const BULK_CONCURRENCY = 3;
/** Geschatte kosten per artikel (euro): kenmerken opzoeken (gemeten gemiddelde van Past bij) en de tekst schrijven. */
const ESTIMATE_RESEARCH_EUR = 0.07;
const ESTIMATE_WRITE_EUR = 0.015;
/** Fouten waarbij doorgaan zinloos is (sleutel, tegoed, model): de rest van de portie wordt overgeslagen. */
const FATAL_CODES = ['auth', 'permission', 'not_found', 'no_credit', 'not_configured', 'rate_limited'];
/** Soorten waarschuwing die een tekst tegenhouden (een tekst met alleen "weinig gegevens" mag wel live). */
const BLOCKING_KINDS = ['number', 'unit', 'claim', 'link'];

/** Artikelen die nu in behandeling zijn (sleutel omgeving:artikel), zodat gelijktijdige runs niets dubbel doen. */
const inFlight = new Set();
/** Aantal artikelen dat vandaag per omgeving in een bulkrun is verwerkt (sleutel omgeving|datum). */
const dailyCounts = new Map();

/**
 * Het aantal artikelen dat een omgeving vandaag al in bulk liet verwerken.
 * @param {string} tenantId Id van de omgeving.
 * @returns {{ key: string, count: number }} De sleutel van de teller en de stand.
 */
function dailyOf(tenantId) {
  const key = `${tenantId}|${new Date().toISOString().slice(0, 10)}`;
  for (const old of dailyCounts.keys()) if (!old.endsWith(key.slice(key.indexOf('|')))) dailyCounts.delete(old);
  return { key, count: dailyCounts.get(key) || 0 };
}

/**
 * Koppelt de routes voor de bulkrun aan de app.
 * @param {object} app Express-app.
 * @param {object} ctx drafts (item-text-drafts.js), related (voor de zoekvelden), stock, requireRight, requireJson, audit, settingsFor, aiTenantOf, currentItemTextWriter, currentSpecResearcher en aiUsage.
 * @returns {void}
 */
function registerItemTextBulkRoutes(app, ctx) {
  const { drafts, related, stock, requireRight, requireJson, audit, settingsFor, aiTenantOf, currentItemTextWriter, currentSpecResearcher, aiUsage } = ctx;
  const requireStock = requireRight('voorraad');
  const jobs = ctx.jobs || createJobs();
  const persistence = createJobPersistence(settingsFor);
  const startLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 6, keyFn: (req) => `item-text-bulk-start|${req.tenantId}` });
  const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 120, keyFn: (req) => `item-text-bulk|${req.tenantId}` });
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;

  /**
   * De stand van de AI voor het scherm.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} enabled, configured, model, modelLabel, models, researchModelLabel en batchSize.
   */
  function stateOf(tenantId) {
    const writer = currentItemTextWriter(tenantId);
    const researcher = currentSpecResearcher(tenantId);
    return {
      enabled: Boolean(settingsFor(tenantId).get('aiEnabled')), configured: writer.available && researcher.available,
      model: writer.model, modelLabel: AiModelList.label(writer.model), models: AiModelList.SELECTABLE.map((id) => ({ id, label: AiModelList.label(id) })),
      researchModelLabel: AiModelList.label(researcher.model), batchSize: BULK_BATCH,
    };
  }

  app.get('/api/stock/item-texts/bulk/todo', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const tenantId = tenantOf(req);
    const review = req.query.review !== '0';
    const research = req.query.research !== '0';
    const mode = req.query.mode === 'texts' ? 'texts' : 'specs';
    const todo = drafts.bulkTodo(tenantId, { review, mode });
    const estimateEur = (mode === 'texts' ? todo.total * ESTIMATE_WRITE_EUR : 0) + (research ? todo.withoutFeatures * ESTIMATE_RESEARCH_EUR : 0);
    const remainingToday = Math.max(0, settingsFor(tenantId).get('descriptionBulkDailyItems') - dailyOf(tenantId).count);
    res.json({ ...todo, review, research, mode, remainingToday, estimateEur: Math.round(estimateEur * 100) / 100, ai: stateOf(tenantId) });
  });

  app.put('/api/stock/item-texts/bulk/model', requireJson, requireRight('beheer'), (req, res) => {
    const model = String(req.body && req.body.model || '');
    if (!AiModelList.SELECTABLE.includes(model)) return res.status(400).json({ error: 'invalid', message: 'Onbekend model.' });
    settingsFor(tenantOf(req)).update({ descriptionAiModel: model }, req.user ? req.user.id : null);
    audit(req, 'omschrijving_ai_model', { model });
    return res.json({ model });
  });

  app.post('/api/stock/item-texts/:itemId/restore', requireJson, requireStock, (req, res) => {
    const out = drafts.restorePrevious(tenantOf(req), req.params.itemId, stock, req.user);
    if (out.error === 'nothing_to_restore') return res.status(409).json({ error: out.error, message: 'Er is geen vorige omschrijving om terug te zetten.' });
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json({ error: out.error, message: 'Terugzetten is niet gelukt.' });
    audit(req, 'omschrijving_hersteld', { itemId: req.params.itemId });
    return res.json({ ok: true });
  });

  /**
   * Verwerkt één portie artikelen (hoogstens BULK_BATCH): kenmerken opzoeken, schrijven en plaatsen. Gebruikt door het verzoek per portie én door de achtergrondtaak.
   * @param {string} tenantId Id van de omgeving.
   * @param {?object} user De gebruiker voor het kostenoverzicht en het logboek (of null).
   * @param {string[]} ids De artikelen van deze portie.
   * @param {{ research: boolean, review: boolean, mode?: string }} options Kenmerken opzoeken, bestaande teksten beoordelen en de soort run (specs = alleen de kenmerken als specificaties zetten, standaard; texts = ook een tekst schrijven).
   * @returns {Promise<{ refused: ?{ status: number, error: string, message: string }, results: object[], aborted: ?object }>} De uitkomsten per artikel, of een weigering van de hele portie.
   */
  async function processBatch(tenantId, user, ids, { research, review, mode = 'specs' }) {
    const specsOnly = mode !== 'texts';
    if (!settingsFor(tenantId).get('aiEnabled')) return { refused: { status: 409, error: 'disabled', message: 'AI staat uit (Beheer → Integraties → AI-herkenning).' } };
    const writer = currentItemTextWriter(tenantId);
    const researcher = currentSpecResearcher(tenantId);
    if (!researcher.available || (!specsOnly && !writer.available)) return { refused: { status: 409, error: 'not_configured', message: 'Er is geen API-sleutel ingesteld: een beheerder kan hem invullen bij Beheer → Integraties → AI-herkenning.' } };
    const dailyLimit = settingsFor(tenantId).get('descriptionBulkDailyItems');
    const today = dailyOf(tenantId);
    if (today.count >= dailyLimit) return { refused: { status: 429, error: 'daily_limit', message: `Het dagplafond voor omschrijvingen in bulk (${dailyLimit} artikelen) is bereikt. Ga morgen verder of verhoog het plafond (instelling descriptionBulkDailyItems).` } };
    const results = [];
    let aborted = null;
    let cursor = 0;
    /**
     * Legt het verbruik van één aanroep vast in het kostenoverzicht.
     * @param {string} feature De functie (product_tekst of kenmerken_opzoeken).
     * @param {string} itemId Het artikel.
     * @param {number} started Starttijd in ms.
     * @param {{ model?: string, usage?: object, status?: string }} result Model, verbruik en status (ok bij een gelukte aanroep).
     * @returns {void}
     */
    const logUsage = (feature, itemId, started, { model, usage, status = 'ok' }) => {
      try {
        const aiSettings = settingsFor(aiTenantOf(tenantId));
        aiUsage.record({ tenantId, userId: user ? user.id : null, feature, model: model || writer.model, status, usage: usage || {}, durationMs: Date.now() - started, eurCentsPerUsd: aiSettings.get('aiEurCentsPerUsd'), detail: { itemId, bulk: true } });
      } catch (error) {
        console.warn(`AI-verbruik niet vastgelegd: ${error.message}`);
      }
    };
    /**
     * Zoekt de kenmerken op als dat nog niet gebeurd is. Een fout die doorgaan zinloos maakt stopt de portie, een andere fout slaat alleen het opzoeken over.
     * @param {string} itemId Het artikel.
     * @returns {Promise<void>}
     */
    const lookUpFeatures = async (itemId) => {
      if (!research || drafts.featuresSearched(tenantId, itemId)) return;
      const searchFacts = related.factsFor(tenantId, itemId);
      if (!searchFacts) return;
      const started = Date.now();
      try {
        const found = await researcher.researchFeatures(searchFacts);
        logUsage('kenmerken_opzoeken', itemId, started, { model: found.model, usage: found.usage });
        drafts.saveFeatures(tenantId, itemId, { features: found.features, model: found.model });
      } catch (error) {
        if (!(error instanceof AnalyzeError)) throw error;
        if (error.code !== 'not_configured') logUsage('kenmerken_opzoeken', itemId, started, { model: error.model, usage: error.usage, status: error.code });
        if (FATAL_CODES.includes(error.code)) throw error;
      }
    };
    /**
     * Specs-run voor één artikel: kenmerken opzoeken (als dat nog niet gebeurd is) en als specificaties bij het artikel zetten. Er wordt geen tekst geschreven.
     * @param {string} itemId Het artikel.
     * @param {{ status?: string }} first Uitkomst van prepareWrite (niet gevonden of niet beschikbaar).
     * @returns {Promise<void>}
     */
    const handleSpecs = async (itemId, first) => {
      if (first.status === 'not_found') { results.push({ itemId, status: 'error', code: 'not_found', message: 'Artikel niet gevonden.' }); return; }
      if (first.status === 'unavailable') { results.push({ itemId, status: 'skipped', code: 'unavailable', message: 'Varianten en gearchiveerde artikelen krijgen geen eigen specificaties.' }); return; }
      if (aborted) { results.push({ itemId, status: 'error', code: aborted.code, message: aborted.message }); return; }
      const flightKey = `${tenantId}:${itemId}`;
      if (inFlight.has(flightKey)) { results.push({ itemId, status: 'skipped', code: 'busy', message: 'Dit artikel wordt al verwerkt.' }); return; }
      inFlight.add(flightKey);
      try {
        if (research && !drafts.featuresSearched(tenantId, itemId)) {
          if (dailyCounts.get(today.key) >= dailyLimit) { results.push({ itemId, status: 'error', code: 'daily_limit', message: 'Het dagplafond voor bulkrondes is bereikt.' }); return; }
          dailyCounts.set(today.key, (dailyCounts.get(today.key) || 0) + 1);
          await lookUpFeatures(itemId);
        }
        const applied = drafts.applySpecs(tenantId, itemId, stock, user);
        results.push(applied.error ? { itemId, status: 'error', code: applied.error, message: 'De specificaties konden niet worden geplaatst.' } : { itemId, status: applied.status, added: applied.added });
      } catch (error) {
        if (error instanceof AnalyzeError) {
          if (FATAL_CODES.includes(error.code)) aborted = { code: error.code, message: error.message };
          results.push({ itemId, status: 'error', code: error.code, message: error.message });
          return;
        }
        console.warn(`Specificaties vullen mislukt: ${error.message}`);
        results.push({ itemId, status: 'error', code: 'error', message: 'Het vullen is mislukt door een interne fout.' });
      } finally {
        inFlight.delete(flightKey);
      }
    };
    /**
     * Verwerkt één artikel en zet de uitkomst in results.
     * @param {string} itemId Het artikel.
     * @returns {Promise<void>}
     */
    const handle = async (itemId) => {
      const first = drafts.prepareWrite(tenantId, itemId);
      if (specsOnly) { await handleSpecs(itemId, first); return; }
      if (first.status === 'not_found') { results.push({ itemId, status: 'error', code: 'not_found', message: 'Artikel niet gevonden.' }); return; }
      if (first.status === 'unavailable') { results.push({ itemId, status: 'skipped', code: 'unavailable', message: 'Varianten en gearchiveerde artikelen krijgen geen eigen tekst.' }); return; }
      if (drafts.hasDraft(tenantId, itemId)) { results.push({ itemId, status: 'skipped', code: 'has_draft', message: 'Er staat al een concept.' }); return; }
      const earlier = (drafts.logOf(tenantId, itemId) || {}).textLog;
      if (earlier && ['nieuw', 'overschreven', 'behouden'].includes(earlier.action)) { results.push({ itemId, status: 'skipped', code: 'done', message: 'Dit artikel is al behandeld.' }); return; }
      if (aborted) { results.push({ itemId, status: 'error', code: aborted.code, message: aborted.message }); return; }
      if (dailyCounts.get(today.key) >= dailyLimit) { results.push({ itemId, status: 'error', code: 'daily_limit', message: 'Het dagplafond voor omschrijvingen in bulk is bereikt.' }); return; }
      const flightKey = `${tenantId}:${itemId}`;
      if (inFlight.has(flightKey)) { results.push({ itemId, status: 'skipped', code: 'busy', message: 'Dit artikel wordt al verwerkt.' }); return; }
      inFlight.add(flightKey);
      dailyCounts.set(today.key, (dailyCounts.get(today.key) || 0) + 1);
      const started = Date.now();
      let usageLogged = false;
      try {
        await lookUpFeatures(itemId);
        const prepared = drafts.prepareWrite(tenantId, itemId);
        const existing = prepared.facts.fields.some((field) => field.label === 'Bestaande omschrijving');
        const basis = drafts.currentText(tenantId, itemId);
        if (existing && !review) { results.push({ itemId, status: 'skipped', code: 'has_text', message: 'Heeft al een omschrijving.' }); return; }
        const writeStarted = Date.now();
        const written = await writer.write({ fields: prepared.facts.fields });
        logUsage('product_tekst', itemId, writeStarted, { model: written.model, usage: written.usage });
        usageLogged = true;
        if (existing && written.verdict === 'behouden') {
          drafts.recordKept(tenantId, itemId, { model: written.model, reason: written.verdictReason });
          results.push({ itemId, status: 'behouden', reason: written.verdictReason });
          return;
        }
        const blocking = checkText(written, prepared.facts.sourceText).filter((warning) => BLOCKING_KINDS.includes(warning.kind));
        if (blocking.length) {
          const draft = drafts.save(tenantId, itemId, { ...written, userId: user ? user.id : null });
          results.push({ itemId, status: 'concept', warnings: draft ? draft.warnings.length : blocking.length });
          return;
        }
        const applied = drafts.applyWritten(tenantId, itemId, { ...written, reason: written.verdictReason, basis }, stock, user);
        if (applied.error === 'changed') results.push({ itemId, status: 'skipped', code: 'changed', message: 'De omschrijving is intussen veranderd; er is niets overschreven.' });
        else results.push(applied.error ? { itemId, status: 'error', code: applied.error, message: 'De tekst kon niet worden geplaatst.' } : { itemId, status: applied.action });
      } catch (error) {
        if (error instanceof AnalyzeError) {
          if (error.code !== 'not_configured' && !usageLogged) logUsage('product_tekst', itemId, started, { model: error.model, usage: error.usage, status: error.code });
          if (FATAL_CODES.includes(error.code)) aborted = { code: error.code, message: error.message };
          results.push({ itemId, status: 'error', code: error.code, message: error.message });
          return;
        }
        console.warn(`Omschrijving schrijven mislukt: ${error.message}`);
        results.push({ itemId, status: 'error', code: 'error', message: 'Het schrijven is mislukt door een interne fout.' });
      } finally {
        inFlight.delete(flightKey);
      }
    };
    await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, ids.length) }, async () => {
      while (cursor < ids.length) { const itemId = ids[cursor]; cursor += 1; await handle(itemId); }
    }));
    const ordered = ids.map((itemId) => results.find((result) => result.itemId === itemId)).filter(Boolean);
    return { refused: null, results: ordered, aborted };
  }

  /**
   * Telt de uitkomsten met een status.
   * @param {object[]} results De uitkomsten.
   * @param {string} status De status.
   * @returns {number} Het aantal.
   */
  const countOf = (results, status) => results.filter((result) => result.status === status).length;

  app.post('/api/stock/item-texts/bulk/run', requireJson, requireStock, limiter, async (req, res, next) => {
    const tenantId = tenantOf(req);
    const ids = Array.isArray(req.body && req.body.itemIds) ? [...new Set(req.body.itemIds.map(String))] : [];
    if (!ids.length || ids.length > BULK_BATCH) return res.status(400).json({ error: 'invalid', message: `Kies 1 tot ${BULK_BATCH} artikelen per keer.` });
    let out;
    try {
      out = await processBatch(tenantId, req.user, ids, { research: req.body.research !== false, review: req.body.review !== false, mode: req.body.mode === 'texts' ? 'texts' : 'specs' });
    } catch (error) {
      return next(error);
    }
    if (out.refused) return res.status(out.refused.status).json({ error: out.refused.error, message: out.refused.message });
    audit(req, 'omschrijving_bulk', { requested: ids.length, nieuw: countOf(out.results, 'nieuw'), overschreven: countOf(out.results, 'overschreven'), behouden: countOf(out.results, 'behouden'), concept: countOf(out.results, 'concept') });
    return res.json({ results: out.results, aborted: out.aborted });
  });

  // Achtergrondtaak: de server loopt zelf alle artikelen aan de beurt door, ook als de browser dicht gaat. De stand is op te vragen en de taak is te stoppen.
  /**
   * De sleutel van de achtergrondtaak van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {string} De sleutel.
   */
  const jobKeyOf = (tenantId) => `omschrijvingen|${tenantId}`;
  /**
   * Start de achtergrondtaak voor alle artikelen die aan de beurt zijn en bewaart hem, zodat hij een herstart overleeft.
   * @param {string} tenantId Id van de omgeving.
   * @param {?object} user Wie de taak startte (voor het kostenoverzicht en het logboek).
   * @param {{ research: boolean, review: boolean }} options Kenmerken opzoeken en bestaande teksten beoordelen.
   * @returns {{ error?: string, total?: number }} nothing_to_do of running als het niet kan, anders het aantal artikelen.
   */
  function startJob(tenantId, user, options) {
    const todo = drafts.bulkTodo(tenantId, { review: options.review, mode: options.mode });
    if (!todo.ids.length) return { error: 'nothing_to_do' };
    const started = jobs.start(jobKeyOf(tenantId), {
      ids: todo.ids, size: BULK_BATCH, options,
      runBatch: (batchIds) => processBatch(tenantId, user, batchIds, options),
      onFinish: () => persistence.clear(tenantId, 'omschrijvingen'),
    });
    if (!started) return { error: 'running' };
    persistence.save(tenantId, 'omschrijvingen', { userId: user ? user.id : null, options });
    return { total: todo.ids.length };
  }
  // Na een herstart van de server (de update-timer herstart de container bij elke release) gaat een bewaarde taak vanzelf verder met wat nog aan de beurt is.
  /**
   * Hervat een bewaarde taak van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ userId: ?string, options: object }} entry De bewaarde taak.
   * @returns {boolean} true als de taak weer loopt.
   */
  app.locals.resumeItemTextJob = (tenantId, entry) => {
    const out = startJob(tenantId, entry.userId ? { id: entry.userId } : null, { research: entry.options.research !== false, review: entry.options.review !== false, mode: entry.options.mode === 'texts' ? 'texts' : 'specs' });
    if (out.error === 'nothing_to_do') persistence.clear(tenantId, 'omschrijvingen');
    return !out.error;
  };
  app.post('/api/stock/item-texts/bulk/job', requireJson, requireStock, startLimiter, (req, res) => {
    const tenantId = tenantOf(req);
    const options = { research: !(req.body && req.body.research === false), review: !(req.body && req.body.review === false), mode: req.body && req.body.mode === 'texts' ? 'texts' : 'specs' };
    const out = startJob(tenantId, req.user, options);
    if (out.error === 'nothing_to_do') return res.status(409).json({ error: out.error, message: 'Er zijn geen artikelen aan de beurt.' });
    if (out.error === 'running') return res.status(409).json({ error: out.error, message: 'Er loopt al een taak voor deze omgeving.' });
    audit(req, 'omschrijving_bulk_gestart', { total: out.total, ...options });
    return res.status(202).json(jobs.get(jobKeyOf(tenantId)));
  });
  app.get('/api/stock/item-texts/bulk/job', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(jobs.get(jobKeyOf(tenantOf(req))));
  });
  app.post('/api/stock/item-texts/bulk/job/stop', requireJson, requireStock, (req, res) => {
    jobs.stop(jobKeyOf(tenantOf(req)));
    audit(req, 'omschrijving_bulk_gestopt', {});
    res.json(jobs.get(jobKeyOf(tenantOf(req))));
  });
}

module.exports = { registerItemTextBulkRoutes, BULK_BATCH };
