// Route om een leveranciersdocument (PDF of foto) met AI in te lezen en aan artikelen te koppelen.
// Schrijft niets: de gebruiker controleert het resultaat in het inkoopscherm en bewaart zelf.

const { AnalyzeError } = require('../beregening/plan-analyzer');
const { matchSupplier, matchLines, normalize } = require('./order-matching');

const MAX_BYTES = 8 * 1024 * 1024;
const FILE_PATTERN = /^data:(application\/pdf|image\/jpeg|image\/png|image\/webp);base64,([A-Za-z0-9+/=]+)$/;

/**
 * Hangt `POST /api/purchase-orders/read` aan de app.
 * @param {object} app De Express-app.
 * @param {object} ctx De opslag en hulpfuncties: stock, suppliers, requireRight, requireJson, audit, settingsFor, aiTenantOf, currentOrderReader, dailyFor, limiter, aiUsage, tenantIdOf.
 * @returns {void}
 */
function registerOrderReadRoute(app, ctx) {
  const { stock, suppliers, requireRight, audit, settingsFor, aiTenantOf, currentOrderReader, dailyFor, limiter, aiUsage } = ctx;
  app.post('/api/purchase-orders/read', requireRight('voorraad'), limiter, async (req, res, next) => {
    const tenantId = req.tenantId || req.user.tenant_id;
    const match = FILE_PATTERN.exec(String((req.body && req.body.file) || ''));
    if (!match) return res.status(400).json({ error: 'invalid_file', message: 'Kies een PDF of een foto (JPEG, PNG of WebP).' });
    if (Math.floor(match[2].length * 3 / 4) > MAX_BYTES) return res.status(400).json({ error: 'file_too_large', message: 'Het bestand is groter dan 8 MB.' });
    const settings = settingsFor(tenantId);
    if (!settings.get('aiEnabled')) {
      return res.status(409).json({ error: 'disabled', message: 'AI staat uit (Beheer → Integraties → AI-herkenning). Een order maak je dan met de hand.' });
    }
    const reader = currentOrderReader(tenantId);
    if (!reader.available) {
      return res.status(409).json({ error: 'not_configured', message: 'Inlezen is niet ingesteld: een beheerder kan de API-sleutel invullen bij Beheer → Integraties → AI-herkenning.' });
    }
    const daily = dailyFor(tenantId);
    if (daily.count >= settings.get('aiDailyLimit')) {
      return res.status(429).json({ error: 'daily_limit', message: 'Het dagelijkse maximum voor AI-verzoeken is bereikt. Probeer het morgen opnieuw.' });
    }
    daily.count += 1;
    const started = Date.now();
    /**
     * Legt het verbruik vast in het kostenoverzicht, ook bij een mislukking.
     * @param {{ model?: string, usage?: object, status?: string, detail?: object }} result Model, verbruik, status en details.
     * @returns {void}
     */
    const logUsage = ({ model, usage, status = 'ok', detail = {} }) => {
      try {
        const aiSettings = settingsFor(aiTenantOf(tenantId));
        aiUsage.record({ tenantId, userId: req.user ? req.user.id : null, feature: 'inkoop_inlezen', model: model || reader.model || aiSettings.get('aiModel'),
          status, usage: usage || {}, durationMs: Date.now() - started, eurCentsPerUsd: aiSettings.get('aiEurCentsPerUsd'), detail });
      } catch (error) {
        console.warn(`AI-verbruik niet vastgelegd: ${error.message}`);
      }
    };
    try {
      const result = await reader.read({ mediaType: match[1], data: match[2] });
      logUsage({ model: result.model, usage: result.usage, detail: { lines: result.lines.length, type: result.documentType } });
      const supplierList = suppliers.list(tenantId);
      const supplier = req.body.supplierId ? supplierList.find((entry) => entry.id === String(req.body.supplierId)) || null : matchSupplier(result.supplierName, supplierList);
      const items = stock.list(tenantId).filter((item) => !item.hasVariants && !item.archived);
      const skuToItem = new Map();
      if (supplier) for (const link of suppliers.skusOf(tenantId, supplier.id)) skuToItem.set(normalize(link.supplierSku), link.itemId);
      const matches = matchLines(result.lines, items, skuToItem);
      audit(req, 'inkooporder_ingelezen', { lines: result.lines.length });
      return res.json({
        supplier: supplier ? { id: supplier.id, name: supplier.name } : null, supplierName: result.supplierName,
        documentNumber: result.documentNumber, documentDate: result.documentDate, documentType: result.documentType, notes: result.notes,
        lines: result.lines.map((line, index) => ({ ...line, match: matches[index] })),
      });
    } catch (error) {
      if (error instanceof AnalyzeError) {
        if (error.code !== 'not_configured') logUsage({ model: error.model, usage: error.usage, status: error.code });
        return res.status(error.status).json({ error: error.code, message: error.message });
      }
      logUsage({ status: 'error' });
      return next(error);
    }
  });
}

module.exports = { registerOrderReadRoute };
