// AI-kosten: elk verzoek aan de AI-dienst komt als regel in ai_usage (wie,
// welke omgeving, functie, model, tokens, duur en kosten). Beheer > AI-kosten
// toont totalen per periode, gebruiker, functie en model plus de losse
// verzoeken; een hoofdbeheerder ziet ook alle organisaties samen.
//
// - Kosten worden bij het verzoek uitgerekend met de prijzen uit
//   shared/ai-models.js en de koers uit de instellingen (aiEurCentsPerUsd), en
//   in miljoensten opgeslagen: een latere prijswijziging verandert oude regels
//   niet, en sommen blijven exact.
// - Geen afbeelding, prompt of antwoord in de tabel: alleen getallen en een
//   kleine samenvatting in detail (aantal vlakken, afmetingen, foutcode).
// - Bewaartermijn: die van het auditlog (auditRetentionDays), via prune().
const crypto = require('crypto');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const AiModels = require(path.join(FRONTEND_DIR, 'shared', 'ai-models.js'));

const MAX_LIST = 1000;
const MAX_DETAIL = 2000;
const COLS = `a.id, a.tenant_id, a.user_id, a.feature, a.model, a.status, a.input_tokens, a.output_tokens, a.cache_read_tokens,
  a.cache_write_tokens, a.duration_ms, a.cost_usd_micro, a.cost_eur_micro, a.detail, a.created_at`;
const SUMS = `COUNT(*) AS requests, COALESCE(SUM(a.input_tokens), 0) AS input_tokens, COALESCE(SUM(a.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(a.cache_read_tokens), 0) AS cache_read_tokens, COALESCE(SUM(a.cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(a.duration_ms), 0) AS duration_ms, COALESCE(SUM(a.cost_usd_micro), 0) AS cost_usd_micro,
  COALESCE(SUM(a.cost_eur_micro), 0) AS cost_eur_micro, COALESCE(SUM(CASE WHEN a.status = 'ok' THEN 0 ELSE 1 END), 0) AS failed`;

/**
 * Of een waarde een geldige datum is (JJJJ-MM-DD).
 * @param {*} value De waarde.
 * @returns {boolean} true bij een geldige datum.
 */
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
/**
 * De dag na een datum.
 * @param {string} date Datum JJJJ-MM-DD.
 * @returns {string} De volgende dag, JJJJ-MM-DD.
 */
const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
/**
 * Maakt een niet-negatief geheel getal van een waarde (tokens, milliseconden).
 * @param {*} value De waarde.
 * @returns {number} Het getal, 0 bij een ongeldige waarde.
 */
const toCount = (value) => Math.max(0, Math.round(Number(value) || 0));

/**
 * Filters uit de query-string: van/tot (datum, tot en met; standaard de laatste 30 dagen), periode (dag of maand), gebruiker, functie en model.
 * @param {object} [raw] De query-parameters.
 * @returns {{ from: string, to: string, period: string, userId: string, feature: string, model: string }} Het opgeschoonde filter.
 */
function sanitizeFilter(raw = {}) {
  const today = new Date().toISOString().slice(0, 10);
  let to = isDate(raw.to) ? raw.to : today;
  let from = isDate(raw.from) ? raw.from : new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
  if (from > to) [from, to] = [to, from];
  /**
   * Korte tekst uit het filter (anders leeg).
   * @param {*} value De waarde.
   * @returns {string} De tekst, of '' als het geen tekst tot 80 tekens is.
   */
  const text = (value) => (typeof value === 'string' && value.length <= 80 ? value : '');
  return {
    from, to,
    period: raw.period === 'month' ? 'month' : 'day',
    userId: text(raw.user),
    feature: text(raw.feature),
    model: text(raw.model),
  };
}

/**
 * Zet een rij met sommen om naar de totalen voor de API (kosten in dollar en euro).
 * @param {object} row Rij met de kolommen uit SUMS.
 * @returns {object} De totalen.
 */
const shapeTotals = (row) => ({
  requests: row.requests, failed: row.failed, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens, cacheWriteTokens: row.cache_write_tokens, durationMs: row.duration_ms,
  costUsd: row.cost_usd_micro / 1e6, costEur: row.cost_eur_micro / 1e6,
});

/**
 * Maakt de opslag voor AI-kosten (tabel ai_usage).
 * @param {object} db Databaseverbinding.
 * @returns {{ record: Function, summary: Function, list: Function, prune: Function }} De opslagfuncties.
 */
function createAiUsageStore(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL met ?-parameters.
   * @returns {object} Het voorbereide statement.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Legt één verzoek aan de AI-dienst vast, met de kosten uitgerekend tegen de huidige prijzen en koers.
   * @param {object} entry tenantId, userId, feature, model, status, usage (verbruik zoals de AI-dienst het geeft: input_tokens enz.), durationMs, eurCentsPerUsd (koers uit de instellingen) en detail (kleine samenvatting).
   * @returns {string} Id van de nieuwe regel.
   */
  function record({ tenantId, userId = null, feature, model, status = 'ok', usage = {}, durationMs = 0, eurCentsPerUsd = 86, detail = {} }) {
    const tokens = {
      inputTokens: toCount(usage.input_tokens ?? usage.inputTokens),
      outputTokens: toCount(usage.output_tokens ?? usage.outputTokens),
      cacheReadTokens: toCount(usage.cache_read_input_tokens ?? usage.cacheReadTokens),
      cacheWriteTokens: toCount(usage.cache_creation_input_tokens ?? usage.cacheWriteTokens),
    };
    const { usd, known } = AiModels.costUsd(model, tokens);
    const extra = known ? detail : { ...detail, prijsGeschat: true };
    let json = JSON.stringify(extra || {});
    if (json.length > MAX_DETAIL) json = JSON.stringify({ afgekapt: true });
    const id = crypto.randomUUID();
    prepare(`INSERT INTO ai_usage (id, tenant_id, user_id, feature, model, status, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, duration_ms, cost_usd_micro, cost_eur_micro, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, userId || null, String(feature).slice(0, 40), String(model || '').slice(0, 80), String(status || 'ok').slice(0, 40),
        tokens.inputTokens, tokens.outputTokens, tokens.cacheReadTokens, tokens.cacheWriteTokens, toCount(durationMs),
        Math.round(usd * 1e6), Math.round(usd * eurCentsPerUsd * 1e4), json, new Date().toISOString());
    return id;
  }

  /**
   * WHERE-deel voor de omgevingen en de filters.
   * @param {string[]|null} tenantIds Omgevingen, of null voor alle.
   * @param {object} filter Opgeschoond filter (sanitizeFilter).
   * @returns {{ sql: string, args: Array }} De voorwaarde en de parameters.
   */
  function where(tenantIds, filter) {
    const parts = ['a.created_at >= ?', 'a.created_at < ?'];
    const args = [filter.from, nextDay(filter.to)];
    if (tenantIds) {
      parts.unshift(`a.tenant_id IN (${tenantIds.map(() => '?').join(', ')})`);
      args.unshift(...tenantIds);
    }
    if (filter.userId) { parts.push('a.user_id = ?'); args.push(filter.userId); }
    if (filter.feature) { parts.push('a.feature = ?'); args.push(filter.feature); }
    if (filter.model) { parts.push('a.model = ?'); args.push(filter.model); }
    return { sql: parts.join(' AND '), args };
  }

  /**
   * Totalen en uitsplitsingen per periode, gebruiker, functie en model (en per
   * organisatie als het om meer omgevingen gaat).
   * @param {string[]|null} tenantIds Lijst omgevingen, of null voor alle organisaties (alleen hoofdbeheerder).
   * @param {object} filter Het filter uit de query-string.
   * @returns {object} filter, totals, byPeriod, byUser, byFeature, byModel en eventueel byTenant.
   */
  function summary(tenantIds, filter) {
    const cleanFilter = sanitizeFilter(filter);
    const condition = where(tenantIds, cleanFilter);
    const keyLength = cleanFilter.period === 'month' ? 7 : 10;
    const totals = shapeTotals(prepare(`SELECT ${SUMS} FROM ai_usage a WHERE ${condition.sql}`).get(...condition.args));
    const byPeriod = prepare(`SELECT substr(a.created_at, 1, ${keyLength}) AS k, ${SUMS} FROM ai_usage a WHERE ${condition.sql} GROUP BY 1 ORDER BY 1`)
      .all(...condition.args).map((row) => ({ key: row.k, ...shapeTotals(row) }));
    const byUser = prepare(`SELECT a.user_id AS k, u.display_name, u.username, u.kind, ${SUMS} FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id
        WHERE ${condition.sql} GROUP BY a.user_id, u.display_name, u.username, u.kind ORDER BY cost_eur_micro DESC, requests DESC`)
      .all(...condition.args).map((row) => ({ key: row.k, user: userOf(row), ...shapeTotals(row) }));
    const byFeature = prepare(`SELECT a.feature AS k, ${SUMS} FROM ai_usage a WHERE ${condition.sql} GROUP BY a.feature ORDER BY 1`)
      .all(...condition.args).map((row) => ({ key: row.k, label: AiModels.featureLabel(row.k), ...shapeTotals(row) }));
    const byModel = prepare(`SELECT a.model AS k, ${SUMS} FROM ai_usage a WHERE ${condition.sql} GROUP BY a.model ORDER BY 1`)
      .all(...condition.args).map((row) => ({ key: row.k, label: AiModels.label(row.k), ...shapeTotals(row) }));
    const out = { filter: cleanFilter, totals, byPeriod, byUser, byFeature, byModel };
    if (!tenantIds || tenantIds.length > 1) {
      out.byTenant = prepare(`SELECT a.tenant_id AS k, t.name, t.slug, t.environment, ${SUMS} FROM ai_usage a LEFT JOIN tenants t ON t.id = a.tenant_id
          WHERE ${condition.sql} GROUP BY a.tenant_id, t.name, t.slug, t.environment ORDER BY cost_eur_micro DESC, requests DESC`)
        .all(...condition.args).map((row) => ({ key: row.k, tenant: { name: row.name || '–', slug: row.slug || '', environment: row.environment || '' }, ...shapeTotals(row) }));
    }
    return out;
  }

  /**
   * Naam van de gebruiker bij een regel, ook als die onbekend of verwijderd is.
   * @param {object} row Rij met k (gebruikers-id), username, display_name en kind.
   * @returns {{ displayName: string, username: string, kind: string }} De gebruiker.
   */
  function userOf(row) {
    if (!row.k) return { displayName: 'Onbekend (niet ingelogd)', username: '', kind: '' };
    if (!row.username) return { displayName: 'Verwijderde gebruiker', username: '', kind: '' };
    return { displayName: row.display_name || row.username, username: row.username, kind: row.kind };
  }

  /**
   * Losse verzoeken, nieuwste eerst (gepagineerd; ook voor de Excel-export).
   * @param {string[]|null} tenantIds Omgevingen, of null voor alle.
   * @param {object} filter Het filter uit de query-string.
   * @param {{ limit?: number, offset?: number }} [page] Paginagrootte (max. 1000) en beginpunt.
   * @returns {{ total: number, limit: number, offset: number, items: object[] }} Het totaal en de regels van deze pagina.
   */
  function list(tenantIds, filter, { limit = 100, offset = 0 } = {}) {
    const cleanFilter = sanitizeFilter(filter);
    const condition = where(tenantIds, cleanFilter);
    const pageSize = Math.min(MAX_LIST, Math.max(1, Number(limit) || 100));
    const skip = Math.max(0, Number(offset) || 0);
    const total = prepare(`SELECT COUNT(*) AS n FROM ai_usage a WHERE ${condition.sql}`).get(...condition.args).n;
    const items = prepare(`SELECT ${COLS}, u.display_name, u.username, u.kind, t.name AS tenant_name, t.environment
        FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN tenants t ON t.id = a.tenant_id
        WHERE ${condition.sql} ORDER BY a.created_at DESC, a.id LIMIT ${pageSize} OFFSET ${skip}`)
      .all(...condition.args).map((row) => {
        let detail = {};
        try { detail = JSON.parse(row.detail || '{}'); } catch { /* leeg */ }
        return {
          id: row.id, createdAt: row.created_at, tenant: { id: row.tenant_id, name: row.tenant_name || '–', environment: row.environment || '' },
          user: userOf({ k: row.user_id, username: row.username, display_name: row.display_name, kind: row.kind }), userId: row.user_id,
          feature: row.feature, featureLabel: AiModels.featureLabel(row.feature), model: row.model, modelLabel: AiModels.label(row.model), status: row.status,
          inputTokens: row.input_tokens, outputTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens, cacheWriteTokens: row.cache_write_tokens,
          durationMs: row.duration_ms, costUsd: row.cost_usd_micro / 1e6, costEur: row.cost_eur_micro / 1e6, detail,
        };
      });
    return { total, limit: pageSize, offset: skip, items };
  }

  /**
   * Bewaartermijn: verwijdert regels ouder dan `days` dagen.
   * @param {string} tenantId De omgeving.
   * @param {number} days Bewaartermijn in dagen.
   * @returns {number} Aantal verwijderde regels.
   */
  function prune(tenantId, days) {
    const before = new Date(Date.now() - days * 86400000).toISOString();
    return prepare('DELETE FROM ai_usage WHERE tenant_id = ? AND created_at < ?').run(tenantId, before).changes;
  }

  return { record, summary, list, prune };
}

module.exports = { createAiUsageStore, sanitizeFilter };
