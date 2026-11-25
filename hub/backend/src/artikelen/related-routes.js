// Routes voor gerelateerde artikelen (Artikelen > Past bij): overzicht, handmatig koppelen, de AI-ronde (specificaties opzoeken en koppelen) en
// "vaak samen besteld" opnieuw berekenen. Recht `voorraad`; het model kiezen vraagt recht `beheer`.
const { AnalyzeError } = require('../beregening/plan-analyzer');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const AiModelList = require(path.join(FRONTEND_DIR, 'shared', 'ai-models.js'));
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { RESEARCH_BATCH, RESEARCH_CONCURRENCY, MAX_LINKS } = require('./related-items');

/** Fouten waarbij doorgaan zinloos is (sleutel, tegoed, model): de rest van de portie wordt overgeslagen. */
const FATAL_CODES = ['auth', 'permission', 'not_found', 'no_credit', 'not_configured', 'rate_limited'];
/** Geschatte kosten per artikel (euro) voor de bevestiging in het scherm; het echte verbruik staat in Beheer > AI-kosten. */
const ESTIMATE_EUR_PER_ITEM = 0.045;

/**
 * Koppelt de routes aan de app.
 * @param {object} app Express-app.
 * @param {object} deps related (opslag), requireRight, requireJson, audit, settingsFor, aiTenantOf, currentSpecResearcher, limiter, aiUsage, stock (voor het zoeken van artikelen).
 * @returns {void}
 */
function registerRelatedRoutes(app, { related, requireRight, requireJson, audit, settingsFor, aiTenantOf, currentSpecResearcher, limiter, aiUsage }) {
  const requireStock = requireRight('voorraad');
  // De zware rondes (koppelen, wissen, opnieuw berekenen) lezen en schrijven veel rijen: hoogstens 6 per uur per omgeving.
  const heavyLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 6, keyFn: (req) => `related-heavy|${req.tenantId}` });
  /**
   * De omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId;
  /**
   * Antwoordt 404 voor een onbekend artikel.
   * @param {object} res Het antwoord.
   * @returns {object} Het antwoord.
   */
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Artikel niet gevonden.' });

  /**
   * De stand van de AI voor het scherm.
   * @param {object} req Het verzoek.
   * @returns {object} enabled, configured, model, estimate.
   */
  const aiStateOf = (req) => {
    const tenantId = tenantOf(req);
    const researcher = currentSpecResearcher(tenantId);
    return {
      enabled: Boolean(settingsFor(tenantId).get('aiEnabled')), configured: researcher.available, model: researcher.model, modelLabel: AiModelList.label(researcher.model),
      models: AiModelList.SELECTABLE.map((id) => ({ id, label: AiModelList.label(id) })), batchSize: RESEARCH_BATCH, estimatePerItemEur: ESTIMATE_EUR_PER_ITEM, maxLinks: MAX_LINKS,
    };
  };

  app.get('/api/stock/related', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const filter = ['alle', 'zonder', 'handmatig', 'ai', 'geenspec'].includes(req.query.filter) ? req.query.filter : 'alle';
    res.json({ ...related.list(tenantOf(req), { search: String(req.query.q || '').slice(0, 80), filter }), ai: aiStateOf(req) });
  });

  app.get('/api/stock/related/ai/todo', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const todo = related.researchTodo(tenantOf(req), { again: req.query.again === '1' });
    res.json({ ...todo, estimateEur: Math.round(todo.ids.length * ESTIMATE_EUR_PER_ITEM * 100) / 100 });
  });

  app.get('/api/stock/related/:itemId', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const found = related.detail(tenantOf(req), req.params.itemId);
    return found ? res.json(found) : notFound(res);
  });

  app.put('/api/stock/related/:itemId', requireJson, requireStock, (req, res) => {
    const out = related.setManual(tenantOf(req), req.params.itemId, req.body && req.body.relatedIds);
    if (out.error === 'not_found') return notFound(res);
    if (out.error) return res.status(400).json({ error: out.error, message: out.message });
    audit(req, 'gerelateerd_ingesteld', { itemId: req.params.itemId });
    return res.json(related.detail(tenantOf(req), req.params.itemId));
  });

  app.delete('/api/stock/related/:itemId/:relatedId', requireStock, (req, res) => {
    if (!related.removeLink(tenantOf(req), req.params.itemId, req.params.relatedId)) return notFound(res);
    audit(req, 'gerelateerd_verwijderd', { itemId: req.params.itemId });
    return res.json({ ok: true });
  });

  app.post('/api/stock/related-ai/research', requireJson, requireStock, limiter, async (req, res, next) => {
    const tenantId = tenantOf(req);
    const ids = Array.isArray(req.body && req.body.itemIds) ? [...new Set(req.body.itemIds.map(String))].slice(0, RESEARCH_BATCH) : [];
    if (!ids.length) return res.status(400).json({ error: 'invalid', message: `Kies 1 tot ${RESEARCH_BATCH} artikelen per keer.` });
    if (!settingsFor(tenantId).get('aiEnabled')) return res.status(409).json({ error: 'disabled', message: 'AI staat uit (Beheer → Integraties → AI-herkenning). Koppel artikelen dan met de hand.' });
    const researcher = currentSpecResearcher(tenantId);
    if (!researcher.available) return res.status(409).json({ error: 'not_configured', message: 'Specificaties opzoeken is niet ingesteld: een beheerder kan de API-sleutel invullen bij Beheer → Integraties → AI-herkenning.' });
    const results = [];
    let aborted = null;
    let cursor = 0;
    /**
     * Legt het verbruik van één zoekopdracht vast in het kostenoverzicht (feature past_bij).
     * @param {string} itemId Het artikel.
     * @param {number} started Starttijd in ms.
     * @param {{ model?: string, usage?: object, status?: string }} result Model, verbruik en status.
     * @returns {void}
     */
    const logUsage = (itemId, started, { model, usage, status = 'ok' }) => {
      try {
        const aiSettings = settingsFor(aiTenantOf(tenantId));
        aiUsage.record({ tenantId, userId: req.user ? req.user.id : null, feature: 'past_bij', model: model || researcher.model, status, usage: usage || {}, durationMs: Date.now() - started, eurCentsPerUsd: aiSettings.get('aiEurCentsPerUsd'), detail: { itemId } });
      } catch (error) {
        console.warn(`AI-verbruik niet vastgelegd: ${error.message}`);
      }
    };
    /**
     * Zoekt de specificaties van één artikel op en bewaart de uitkomst.
     * @param {string} itemId Het artikel.
     * @returns {Promise<void>}
     */
    const handle = async (itemId) => {
      const facts = related.factsFor(tenantId, itemId);
      if (!facts) { results.push({ itemId, status: 'error', code: 'not_found', message: 'Artikel niet gevonden.' }); return; }
      if (aborted) { results.push({ itemId, status: 'error', code: aborted.code, message: aborted.message }); return; }
      const started = Date.now();
      try {
        const found = await researcher.research(facts);
        logUsage(itemId, started, found);
        related.saveSpecs(tenantId, itemId, found);
        results.push({ itemId, status: found.status });
      } catch (error) {
        if (error instanceof AnalyzeError) {
          if (error.code !== 'not_configured') logUsage(itemId, started, { model: error.model, usage: error.usage, status: error.code });
          if (FATAL_CODES.includes(error.code)) aborted = { code: error.code, message: error.message };
          results.push({ itemId, status: 'error', code: error.code, message: error.message });
          return;
        }
        logUsage(itemId, started, { status: 'error' });
        console.warn(`Specificaties opzoeken mislukt: ${error.message}`);
        results.push({ itemId, status: 'error', code: 'error', message: 'Het opzoeken is mislukt door een interne fout.' });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(RESEARCH_CONCURRENCY, ids.length) }, async () => {
        while (cursor < ids.length) { const itemId = ids[cursor]; cursor += 1; await handle(itemId); }
      }));
    } catch (error) {
      return next(error);
    }
    const ordered = ids.map((itemId) => results.find((result) => result.itemId === itemId)).filter(Boolean);
    audit(req, 'gerelateerd_ai_onderzocht', { requested: ids.length, found: ordered.filter((result) => result.status === 'gevonden').length });
    return res.json({ results: ordered, aborted });
  });

  app.post('/api/stock/related-ai/link', requireJson, requireStock, heavyLimiter, (req, res) => {
    const outcome = related.linkWithSpecs(tenantOf(req));
    audit(req, 'gerelateerd_ai_gekoppeld', { items: outcome.items, links: outcome.links });
    res.json(outcome);
  });

  app.post('/api/stock/related-ai/clear', requireJson, requireStock, heavyLimiter, (req, res) => {
    const removed = related.clearAi(tenantOf(req));
    audit(req, 'gerelateerd_ai_gewist', { removed });
    res.json({ removed });
  });

  app.put('/api/stock/related-ai/model', requireJson, requireRight('beheer'), (req, res) => {
    const model = String(req.body && req.body.model || '');
    if (!AiModelList.SELECTABLE.includes(model)) return res.status(400).json({ error: 'invalid', message: 'Onbekend model.' });
    settingsFor(tenantOf(req)).update({ relatedAiModel: model }, req.user ? req.user.id : null);
    audit(req, 'gerelateerd_ai_model', { model });
    return res.json({ model });
  });

  app.post('/api/stock/related/together/refresh', requireJson, requireStock, heavyLimiter, (req, res) => {
    const outcome = related.refreshTogether(tenantOf(req));
    audit(req, 'gerelateerd_samen_berekend', outcome);
    res.json(outcome);
  });
}

module.exports = { registerRelatedRoutes };
