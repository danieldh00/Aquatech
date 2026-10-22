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

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const int = (v) => Math.max(0, Math.round(Number(v) || 0));

/** Filters uit de query-string: van/tot (datum, tot en met), gebruiker, functie, model. */
function sanitizeFilter(raw = {}) {
  const today = new Date().toISOString().slice(0, 10);
  let to = isDate(raw.to) ? raw.to : today;
  let from = isDate(raw.from) ? raw.from : new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
  if (from > to) [from, to] = [to, from];
  const text = (v) => (typeof v === 'string' && v.length <= 80 ? v : '');
  return {
    from, to,
    period: raw.period === 'month' ? 'month' : 'day',
    userId: text(raw.user),
    feature: text(raw.feature),
    model: text(raw.model),
  };
}

const shapeTotals = (r) => ({
  requests: r.requests, failed: r.failed, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
  cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens, durationMs: r.duration_ms,
  costUsd: r.cost_usd_micro / 1e6, costEur: r.cost_eur_micro / 1e6,
});

function createAiUsageStore(db) {
  const q = (sql) => db.prepare(sql);

  /**
   * Legt één verzoek vast. usage = verbruik zoals de AI-dienst het geeft
   * (input_tokens enz.); eurCentsPerUsd = koers uit de instellingen.
   */
  function record({ tenantId, userId = null, feature, model, status = 'ok', usage = {}, durationMs = 0, eurCentsPerUsd = 86, detail = {} }) {
    const u = {
      inputTokens: int(usage.input_tokens ?? usage.inputTokens),
      outputTokens: int(usage.output_tokens ?? usage.outputTokens),
      cacheReadTokens: int(usage.cache_read_input_tokens ?? usage.cacheReadTokens),
      cacheWriteTokens: int(usage.cache_creation_input_tokens ?? usage.cacheWriteTokens),
    };
    const { usd, known } = AiModels.costUsd(model, u);
    const extra = known ? detail : { ...detail, prijsGeschat: true };
    let json = JSON.stringify(extra || {});
    if (json.length > MAX_DETAIL) json = JSON.stringify({ afgekapt: true });
    const id = crypto.randomUUID();
    q(`INSERT INTO ai_usage (id, tenant_id, user_id, feature, model, status, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, duration_ms, cost_usd_micro, cost_eur_micro, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, userId || null, String(feature).slice(0, 40), String(model || '').slice(0, 80), String(status || 'ok').slice(0, 40),
        u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, int(durationMs),
        Math.round(usd * 1e6), Math.round(usd * eurCentsPerUsd * 1e4), json, new Date().toISOString());
    return id;
  }

  // WHERE-deel voor tenants (null = alle) en de filters.
  function where(tenantIds, f) {
    const parts = ['a.created_at >= ?', 'a.created_at < ?'];
    const args = [f.from, nextDay(f.to)];
    if (tenantIds) {
      parts.unshift(`a.tenant_id IN (${tenantIds.map(() => '?').join(', ')})`);
      args.unshift(...tenantIds);
    }
    if (f.userId) { parts.push('a.user_id = ?'); args.push(f.userId); }
    if (f.feature) { parts.push('a.feature = ?'); args.push(f.feature); }
    if (f.model) { parts.push('a.model = ?'); args.push(f.model); }
    return { sql: parts.join(' AND '), args };
  }

  /**
   * Totalen en uitsplitsingen. tenantIds = lijst omgevingen, of null voor
   * alle organisaties (alleen hoofdbeheerder; dan ook per organisatie).
   */
  function summary(tenantIds, filter) {
    const f = sanitizeFilter(filter);
    const w = where(tenantIds, f);
    const len = f.period === 'month' ? 7 : 10;
    const totals = shapeTotals(q(`SELECT ${SUMS} FROM ai_usage a WHERE ${w.sql}`).get(...w.args));
    const byPeriod = q(`SELECT substr(a.created_at, 1, ${len}) AS k, ${SUMS} FROM ai_usage a WHERE ${w.sql} GROUP BY 1 ORDER BY 1`)
      .all(...w.args).map((r) => ({ key: r.k, ...shapeTotals(r) }));
    const byUser = q(`SELECT a.user_id AS k, u.display_name, u.username, u.kind, ${SUMS} FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id
        WHERE ${w.sql} GROUP BY a.user_id, u.display_name, u.username, u.kind ORDER BY cost_eur_micro DESC, requests DESC`)
      .all(...w.args).map((r) => ({ key: r.k, user: userOf(r), ...shapeTotals(r) }));
    const byFeature = q(`SELECT a.feature AS k, ${SUMS} FROM ai_usage a WHERE ${w.sql} GROUP BY a.feature ORDER BY 1`)
      .all(...w.args).map((r) => ({ key: r.k, label: AiModels.featureLabel(r.k), ...shapeTotals(r) }));
    const byModel = q(`SELECT a.model AS k, ${SUMS} FROM ai_usage a WHERE ${w.sql} GROUP BY a.model ORDER BY 1`)
      .all(...w.args).map((r) => ({ key: r.k, label: AiModels.label(r.k), ...shapeTotals(r) }));
    const out = { filter: f, totals, byPeriod, byUser, byFeature, byModel };
    if (!tenantIds || tenantIds.length > 1) {
      out.byTenant = q(`SELECT a.tenant_id AS k, t.name, t.slug, t.environment, ${SUMS} FROM ai_usage a LEFT JOIN tenants t ON t.id = a.tenant_id
          WHERE ${w.sql} GROUP BY a.tenant_id, t.name, t.slug, t.environment ORDER BY cost_eur_micro DESC, requests DESC`)
        .all(...w.args).map((r) => ({ key: r.k, tenant: { name: r.name || '–', slug: r.slug || '', environment: r.environment || '' }, ...shapeTotals(r) }));
    }
    return out;
  }

  function userOf(r) {
    if (!r.k) return { displayName: 'Onbekend (niet ingelogd)', username: '', kind: '' };
    if (!r.username) return { displayName: 'Verwijderde gebruiker', username: '', kind: '' };
    return { displayName: r.display_name || r.username, username: r.username, kind: r.kind };
  }

  /** Losse verzoeken, nieuwste eerst (gepagineerd; ook voor de Excel-export). */
  function list(tenantIds, filter, { limit = 100, offset = 0 } = {}) {
    const f = sanitizeFilter(filter);
    const w = where(tenantIds, f);
    const lim = Math.min(MAX_LIST, Math.max(1, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);
    const total = q(`SELECT COUNT(*) AS n FROM ai_usage a WHERE ${w.sql}`).get(...w.args).n;
    const items = q(`SELECT ${COLS}, u.display_name, u.username, u.kind, t.name AS tenant_name, t.environment
        FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN tenants t ON t.id = a.tenant_id
        WHERE ${w.sql} ORDER BY a.created_at DESC, a.id LIMIT ${lim} OFFSET ${off}`)
      .all(...w.args).map((r) => {
        let detail = {};
        try { detail = JSON.parse(r.detail || '{}'); } catch { /* leeg */ }
        return {
          id: r.id, createdAt: r.created_at, tenant: { id: r.tenant_id, name: r.tenant_name || '–', environment: r.environment || '' },
          user: userOf({ k: r.user_id, username: r.username, display_name: r.display_name, kind: r.kind }), userId: r.user_id,
          feature: r.feature, featureLabel: AiModels.featureLabel(r.feature), model: r.model, modelLabel: AiModels.label(r.model), status: r.status,
          inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens,
          durationMs: r.duration_ms, costUsd: r.cost_usd_micro / 1e6, costEur: r.cost_eur_micro / 1e6, detail,
        };
      });
    return { total, limit: lim, offset: off, items };
  }

  /** Bewaartermijn: regels ouder dan `days` dagen weg. */
  function prune(tenantId, days) {
    const before = new Date(Date.now() - days * 86400000).toISOString();
    return q('DELETE FROM ai_usage WHERE tenant_id = ? AND created_at < ?').run(tenantId, before).changes;
  }

  return { record, summary, list, prune };
}

module.exports = { createAiUsageStore, sanitizeFilter };
