// Herkende plannen: vaste AI-uitkomst per tekening en geleerde kleuren.
//
// - AI-herkenning: per tenant bewaard onder de SHA-256 van de afbeelding, het
//   model en de versie van de opdracht (planAnalyzer.PROMPT_VERSION). Dezelfde
//   tekening geeft daardoor altijd hetzelfde resultaat, en kost de tweede keer
//   geen tegoed. "Opnieuw herkennen" maakt een nieuwe regel; de nieuwste telt.
// - Leren: de planner telt na een AI-herkenning of bij het goedkeuren van een
//   plan per kleur/textuur-vakje welk soort vlak er lag (zie localrecog.js) en
//   stuurt alleen die tellingen (samples). learned() telt de laatste
//   voorbeelden van de tenant op; de lokale herkenning gebruikt die kennis.
//   Een goedgekeurd plan (door een mens gecontroleerd) telt dubbel.
// - Geen afbeelding in de tabel. Het AI-resultaat bevat alleen vlakken,
//   elementen, schaal en een toelichting.
const crypto = require('crypto');

const FEATURE_VERSION = 1;
const FEATURE_BINS = 8 * 8 * 8 * 3; // zie localrecog.js (featureKey)
const MAX_EXAMPLES = 300; // zoveel recente voorbeelden tellen mee
const MAX_COUNT = 1000000;
const CACHE_MS = 60 * 1000;

const imageHash = (mediaType, data) => crypto.createHash('sha256').update(`${mediaType}:${data}`).digest('hex');

/** Tellingen uit de browser controleren: { v, bins: { vakje: [6 gehele getallen] } }. */
function sanitizeSamples(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== FEATURE_VERSION || !raw.bins || typeof raw.bins !== 'object') return null;
  const bins = {};
  let n = 0;
  for (const [key, counts] of Object.entries(raw.bins)) {
    const k = Number(key);
    if (!Number.isInteger(k) || k < 0 || k >= FEATURE_BINS || !Array.isArray(counts) || counts.length !== 6) return null;
    const c = counts.map((v) => Math.round(Number(v)));
    if (c.some((v) => !Number.isFinite(v) || v < 0 || v > MAX_COUNT)) return null;
    if (c.some((v) => v > 0)) { bins[k] = c; n++; }
  }
  return n ? { v: FEATURE_VERSION, bins } : null;
}

function createRecognitionStore(db) {
  const q = (sql) => db.prepare(sql);
  const cache = new Map();
  const now = () => new Date().toISOString();

  /** Laatste AI-herkenning van deze tekening met dit model en deze opdracht, of null. */
  function findAi(tenantId, hash, model, version) {
    const row = q(`SELECT id, result, CASE WHEN samples = '' THEN 0 ELSE 1 END AS learned FROM plan_recognitions
      WHERE tenant_id = ? AND image_hash = ? AND source = 'ai' AND model = ? AND version = ? ORDER BY created_at DESC LIMIT 1`)
      .get(tenantId, hash, String(model || ''), String(version || ''));
    if (!row) return null;
    try {
      return { id: row.id, result: JSON.parse(row.result), learned: Boolean(row.learned) };
    } catch {
      return null;
    }
  }

  function saveAi({ tenantId, userId = null, hash, model, version, result }) {
    const id = crypto.randomUUID();
    const at = now();
    q(`INSERT INTO plan_recognitions (id, tenant_id, user_id, source, image_hash, plan_id, model, version, result, samples, created_at, updated_at)
      VALUES (?, ?, ?, 'ai', ?, NULL, ?, ?, ?, '', ?, ?)`)
      .run(id, tenantId, userId || null, hash, String(model || ''), String(version || ''), JSON.stringify(result), at, at);
    return id;
  }

  /** Tellingen bij een AI-herkenning van deze tenant; alleen de eerste keer (niet overschrijven). */
  function addSamples(tenantId, id, samples) {
    const changes = q(`UPDATE plan_recognitions SET samples = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND source = 'ai' AND samples = ''`)
      .run(JSON.stringify(samples), now(), tenantId, String(id || '')).changes;
    if (changes) cache.delete(tenantId);
    return changes > 0;
  }

  /** Tellingen van een goedgekeurd plan: één regel per plan, een nieuwe goedkeuring vervangt de oude. */
  function savePlanSamples({ tenantId, userId = null, planId, samples }) {
    const at = now();
    const row = q(`SELECT id FROM plan_recognitions WHERE tenant_id = ? AND plan_id = ? AND source = 'plan'`).get(tenantId, String(planId));
    if (row) q('UPDATE plan_recognitions SET samples = ?, user_id = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(samples), userId || null, at, row.id);
    else {
      q(`INSERT INTO plan_recognitions (id, tenant_id, user_id, source, image_hash, plan_id, model, version, result, samples, created_at, updated_at)
        VALUES (?, ?, ?, 'plan', '', ?, '', '', '', ?, ?, ?)`)
        .run(crypto.randomUUID(), tenantId, userId || null, String(planId), JSON.stringify(samples), at, at);
    }
    cache.delete(tenantId);
  }

  /** Opgetelde kennis van de tenant: { v, examples, bins } (bins leeg zonder voorbeelden). */
  function learned(tenantId) {
    const hit = cache.get(tenantId);
    if (hit && hit.until > Date.now()) return hit.value;
    const rows = q(`SELECT source, samples FROM plan_recognitions WHERE tenant_id = ? AND samples <> ''
      ORDER BY created_at DESC LIMIT ${MAX_EXAMPLES}`).all(tenantId);
    const bins = {};
    let examples = 0;
    for (const r of rows) {
      let s;
      try { s = JSON.parse(r.samples); } catch { continue; }
      if (!s || s.v !== FEATURE_VERSION || !s.bins) continue;
      const weight = r.source === 'plan' ? 2 : 1;
      for (const [k, counts] of Object.entries(s.bins)) {
        const acc = bins[k] || (bins[k] = [0, 0, 0, 0, 0, 0]);
        for (let c = 0; c < 6; c++) acc[c] += (counts[c] || 0) * weight;
      }
      examples++;
    }
    const value = { v: FEATURE_VERSION, examples, bins };
    cache.set(tenantId, { until: Date.now() + CACHE_MS, value });
    return value;
  }

  /** AVG: bij het wissen van een plan ook zijn tellingen weg. */
  function removePlan(tenantId, planId) {
    const n = q(`DELETE FROM plan_recognitions WHERE tenant_id = ? AND plan_id = ?`).run(tenantId, String(planId)).changes;
    if (n) cache.delete(tenantId);
    return n;
  }

  return { findAi, saveAi, addSamples, savePlanSamples, learned, removePlan };
}

module.exports = { createRecognitionStore, sanitizeSamples, imageHash, FEATURE_VERSION };
