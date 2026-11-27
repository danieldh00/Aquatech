// Specificaties uit de PDF's van de leverancier (knop "Specificaties uit PDF lezen" in het artikelformulier): de AI leest de PDF's van één artikel
// (related-research.js, researchPdfFeatures), de code controleert bron en zin per kenmerk (related-compat.js) en de kenmerken komen als specificaties bij het artikel.
// - Een kenmerk uit de PDF gaat voor een eerder opgezocht kenmerk met dezelfde naam; de andere eerder opgezochte kenmerken blijven bewaard.
// - Eigen specificaties van het artikel worden nooit overschreven (drafts.applySpecs voegt alleen nieuwe namen toe).
const { AnalyzeError } = require('../beregening/plan-analyzer');
const { createRateLimiter } = require('../beveiliging/rate-limit');

/** Hoeveel bytes aan PDF's hoogstens in één aanroep naar de AI gaan. */
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * Registreert de route om specificaties uit de PDF's van een artikel te lezen.
 * @param {object} app De Express-app.
 * @param {object} ctx documents (createItemDocumentStore), drafts (item-text-drafts.js), related (voor de bronvelden), stock, requireRight, audit, settingsFor, aiTenantOf, currentSpecResearcher en aiUsage.
 * @returns {void}
 */
function registerItemPdfSpecsRoutes(app, ctx) {
  const { documents, drafts, related, stock, requireRight, audit, settingsFor, aiTenantOf, currentSpecResearcher, aiUsage } = ctx;
  const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, keyFn: (req) => req.tenantId || req.user.tenant_id });

  app.post('/api/stock/items/:id/documents/specs', requireRight('voorraad'), limiter, async (req, res) => {
    const tenantId = req.tenantId || req.user.tenant_id;
    const itemId = req.params.id;
    const facts = related.factsFor(tenantId, itemId);
    if (!facts) return res.status(404).json({ error: 'not_found', message: 'Artikel niet gevonden.' });
    const files = documents.bodies(tenantId, itemId);
    if (!files.length) return res.status(409).json({ error: 'no_documents', message: 'Voeg eerst een PDF toe bij dit artikel.' });
    if (files.reduce((total, entry) => total + entry.body.length, 0) > MAX_TOTAL_BYTES) return res.status(413).json({ error: 'too_large', message: "De PDF's samen zijn te groot om te lezen (hoogstens 20 MB)." });
    const started = Date.now();
    /**
     * Legt het verbruik van de aanroep vast in het kostenoverzicht.
     * @param {{ model?: string, usage?: object, status?: string }} result Model, verbruik en status (ok bij een gelukte aanroep).
     * @returns {void}
     */
    const logUsage = ({ model, usage, status = 'ok' }) => {
      try {
        const aiSettings = settingsFor(aiTenantOf(tenantId));
        aiUsage.record({ tenantId, userId: req.user ? req.user.id : null, feature: 'kenmerken_pdf', model: model || 'onbekend', status, usage: usage || {}, durationMs: Date.now() - started, eurCentsPerUsd: aiSettings.get('aiEurCentsPerUsd'), detail: { itemId } });
      } catch (error) {
        console.warn(`AI-verbruik niet vastgelegd: ${error.message}`);
      }
    };
    let found;
    try {
      found = await currentSpecResearcher(tenantId).researchPdfFeatures({ fields: facts.fields, documents: files.map((entry) => ({ name: entry.name, data: entry.body.toString('base64') })) });
    } catch (error) {
      if (!(error instanceof AnalyzeError)) throw error;
      if (error.code !== 'not_configured') logUsage({ model: error.model, usage: error.usage, status: error.code });
      return res.status(error.status || 502).json({ error: error.code, message: error.message });
    }
    logUsage({ model: found.model, usage: found.usage });
    if (found.status !== 'gevonden') return res.json({ status: 'niet_gevonden', features: 0, added: 0 });
    const names = new Set(found.features.map((feature) => feature.name.toLowerCase()));
    const earlier = ((drafts.logOf(tenantId, itemId) || {}).kenmerken || []).filter((feature) => feature && !names.has(String(feature.name || '').toLowerCase()));
    drafts.saveFeatures(tenantId, itemId, { features: [...found.features, ...earlier], model: found.model });
    const applied = drafts.applySpecs(tenantId, itemId, stock, req.user);
    if (applied.error) return res.status(500).json({ error: applied.error, message: 'De specificaties konden niet worden geplaatst.' });
    audit(req, 'voorraad_pdf_specs', { itemId, features: found.features.length, added: applied.added });
    res.json({ status: 'gevonden', features: found.features.length, added: applied.added });
  });
}

module.exports = { registerItemPdfSpecsRoutes };
