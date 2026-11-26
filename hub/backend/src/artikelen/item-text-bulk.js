// Omschrijvingen in bulk door de AI (Artikelen > Teksten > "Alles schrijven"): per hoofdartikel eerst de kenmerken opzoeken in de bron van de fabrikant
// (alleen wat letterlijk in de bron staat, met adres en zin; bewaard in item_specs, zie item-text-log.js) en daarna de omschrijving schrijven uit alleen die
// bekende gegevens (item-text-writer.js, met de specificaties van Past bij).
//
// - Vooraf een kostenschatting (GET .../bulk/todo); de browser verwerkt de artikelen in porties (POST .../bulk/run) en kan elk moment stoppen en later verder.
// - Zonder bestaande omschrijving gaat een tekst zonder waarschuwingen direct live ("nieuw"). Bij een bestaande omschrijving oordeelt de AI of de nieuwe beter is:
//   zo ja dan wordt hij overschreven ("overschreven", de vorige tekst blijft bewaard en kan terug), zo nee dan blijft hij staan ("behouden").
// - Een tekst met waarschuwingen van de feitencontrole (getal, eenheid of bewering die niet in de gegevens staat) gaat nooit live maar wordt een concept
//   voor handmatige beoordeling, zoals bij het schrijven per artikel.
// - Samengevoegde (variabele) artikelen krijgen één tekst op het hoofdartikel; varianten en gearchiveerde artikelen worden overgeslagen.
// - Een bulkrun telt niet mee voor het dagelijkse maximum van AI-verzoeken (dat is bedoeld voor losse verzoeken); de schatting en de bevestiging in het scherm vervangen dat.
const { AnalyzeError } = require('../beregening/plan-analyzer');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const AiModelList = require(path.join(FRONTEND_DIR, 'shared', 'ai-models.js'));
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { checkText } = require('./item-text-check');

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

/**
 * Koppelt de routes voor de bulkrun aan de app.
 * @param {object} app Express-app.
 * @param {object} ctx drafts (item-text-drafts.js), related (voor de zoekvelden), stock, requireRight, requireJson, audit, settingsFor, aiTenantOf, currentItemTextWriter, currentSpecResearcher en aiUsage.
 * @returns {void}
 */
function registerItemTextBulkRoutes(app, ctx) {
  const { drafts, related, stock, requireRight, requireJson, audit, settingsFor, aiTenantOf, currentItemTextWriter, currentSpecResearcher, aiUsage } = ctx;
  const requireStock = requireRight('voorraad');
  const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 600, keyFn: (req) => `item-text-bulk|${req.tenantId}` });
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
    const todo = drafts.bulkTodo(tenantId, { review });
    const estimateEur = todo.total * ESTIMATE_WRITE_EUR + (research ? todo.withoutFeatures * ESTIMATE_RESEARCH_EUR : 0);
    res.json({ ...todo, review, research, estimateEur: Math.round(estimateEur * 100) / 100, ai: stateOf(tenantId) });
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

  app.post('/api/stock/item-texts/bulk/run', requireJson, requireStock, limiter, async (req, res, next) => {
    const tenantId = tenantOf(req);
    const ids = Array.isArray(req.body && req.body.itemIds) ? [...new Set(req.body.itemIds.map(String))] : [];
    if (!ids.length || ids.length > BULK_BATCH) return res.status(400).json({ error: 'invalid', message: `Kies 1 tot ${BULK_BATCH} artikelen per keer.` });
    if (!settingsFor(tenantId).get('aiEnabled')) return res.status(409).json({ error: 'disabled', message: 'AI staat uit (Beheer → Integraties → AI-herkenning).' });
    const writer = currentItemTextWriter(tenantId);
    const researcher = currentSpecResearcher(tenantId);
    if (!writer.available || !researcher.available) return res.status(409).json({ error: 'not_configured', message: 'Er is geen API-sleutel ingesteld: een beheerder kan hem invullen bij Beheer → Integraties → AI-herkenning.' });
    const research = req.body.research !== false;
    const review = req.body.review !== false;
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
        aiUsage.record({ tenantId, userId: req.user ? req.user.id : null, feature, model: model || writer.model, status, usage: usage || {}, durationMs: Date.now() - started, eurCentsPerUsd: aiSettings.get('aiEurCentsPerUsd'), detail: { itemId, bulk: true } });
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
     * Verwerkt één artikel en zet de uitkomst in results.
     * @param {string} itemId Het artikel.
     * @returns {Promise<void>}
     */
    const handle = async (itemId) => {
      const first = drafts.prepareWrite(tenantId, itemId);
      if (first.status === 'not_found') { results.push({ itemId, status: 'error', code: 'not_found', message: 'Artikel niet gevonden.' }); return; }
      if (first.status === 'unavailable') { results.push({ itemId, status: 'skipped', code: 'unavailable', message: 'Varianten en gearchiveerde artikelen krijgen geen eigen tekst.' }); return; }
      if (drafts.hasDraft(tenantId, itemId)) { results.push({ itemId, status: 'skipped', code: 'has_draft', message: 'Er staat al een concept.' }); return; }
      const earlier = (drafts.logOf(tenantId, itemId) || {}).textLog;
      if (earlier && ['nieuw', 'overschreven', 'behouden'].includes(earlier.action)) { results.push({ itemId, status: 'skipped', code: 'done', message: 'Dit artikel is al behandeld.' }); return; }
      if (aborted) { results.push({ itemId, status: 'error', code: aborted.code, message: aborted.message }); return; }
      const started = Date.now();
      let usageLogged = false;
      try {
        await lookUpFeatures(itemId);
        const prepared = drafts.prepareWrite(tenantId, itemId);
        const existing = prepared.facts.fields.some((field) => field.label === 'Bestaande omschrijving');
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
          const draft = drafts.save(tenantId, itemId, { ...written, userId: req.user ? req.user.id : null });
          results.push({ itemId, status: 'concept', warnings: draft ? draft.warnings.length : blocking.length });
          return;
        }
        const applied = drafts.applyWritten(tenantId, itemId, { ...written, reason: written.verdictReason }, stock, req.user);
        results.push(applied.error ? { itemId, status: 'error', code: applied.error, message: 'De tekst kon niet worden geplaatst.' } : { itemId, status: applied.action });
      } catch (error) {
        if (error instanceof AnalyzeError) {
          if (error.code !== 'not_configured' && !usageLogged) logUsage('product_tekst', itemId, started, { model: error.model, usage: error.usage, status: error.code });
          if (FATAL_CODES.includes(error.code)) aborted = { code: error.code, message: error.message };
          results.push({ itemId, status: 'error', code: error.code, message: error.message });
          return;
        }
        console.warn(`Omschrijving schrijven mislukt: ${error.message}`);
        results.push({ itemId, status: 'error', code: 'error', message: 'Het schrijven is mislukt door een interne fout.' });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, ids.length) }, async () => {
        while (cursor < ids.length) { const itemId = ids[cursor]; cursor += 1; await handle(itemId); }
      }));
    } catch (error) {
      return next(error);
    }
    const ordered = ids.map((itemId) => results.find((result) => result.itemId === itemId)).filter(Boolean);
    /**
     * Telt de uitkomsten met een status.
     * @param {string} status De status.
     * @returns {number} Het aantal.
     */
    const count = (status) => ordered.filter((result) => result.status === status).length;
    audit(req, 'omschrijving_bulk', { requested: ids.length, nieuw: count('nieuw'), overschreven: count('overschreven'), behouden: count('behouden'), concept: count('concept') });
    return res.json({ results: ordered, aborted });
  });
}

module.exports = { registerItemTextBulkRoutes, BULK_BATCH };
