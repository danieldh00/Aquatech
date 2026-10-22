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

/**
 * Vingerafdruk van een tekening (de afbeelding zelf wordt niet bewaard).
 * @param {string} mediaType Het beeldformaat, bijv. image/png.
 * @param {string} data De afbeelding in base64.
 * @returns {string} SHA-256 in hex.
 */
const imageHash = (mediaType, data) => crypto.createHash('sha256').update(`${mediaType}:${data}`).digest('hex');

/**
 * Controleert de tellingen uit de browser.
 * @param {object} raw { v, bins: { vakje: [6 gehele getallen] } }.
 * @returns {{ v: number, bins: object }|null} De bruikbare tellingen, of null bij ongeldige of lege invoer.
 */
function sanitizeSamples(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== FEATURE_VERSION || !raw.bins || typeof raw.bins !== 'object') return null;
  const bins = {};
  let binCount = 0;
  for (const [key, counts] of Object.entries(raw.bins)) {
    const bin = Number(key);
    if (!Number.isInteger(bin) || bin < 0 || bin >= FEATURE_BINS || !Array.isArray(counts) || counts.length !== 6) return null;
    const rounded = counts.map((value) => Math.round(Number(value)));
    if (rounded.some((value) => !Number.isFinite(value) || value < 0 || value > MAX_COUNT)) return null;
    if (rounded.some((value) => value > 0)) { bins[bin] = rounded; binCount++; }
  }
  return binCount ? { v: FEATURE_VERSION, bins } : null;
}

/**
 * Maakt de opslag voor AI-herkenningen en geleerde kleuren.
 * @param {object} db De database.
 * @returns {object} findAi, saveAi, addSamples, savePlanSamples, learned en removePlan.
 */
function createRecognitionStore(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  const cache = new Map();
  /**
   * Het huidige moment.
   * @returns {string} Tijdstip als ISO-tekst.
   */
  const currentTimestamp = () => new Date().toISOString();

  /**
   * Laatste AI-herkenning van deze tekening met dit model en deze opdracht.
   * @param {string} tenantId Id van de tenant.
   * @param {string} hash Vingerafdruk van de tekening (imageHash).
   * @param {string} model Het AI-model.
   * @param {string} version Versie van de opdracht.
   * @returns {{ id: string, result: object, learned: boolean }|null} De herkenning, of null.
   */
  function findAi(tenantId, hash, model, version) {
    const row = prepare(`SELECT id, result, CASE WHEN samples = '' THEN 0 ELSE 1 END AS learned FROM plan_recognitions
      WHERE tenant_id = ? AND image_hash = ? AND source = 'ai' AND model = ? AND version = ? ORDER BY created_at DESC LIMIT 1`)
      .get(tenantId, hash, String(model || ''), String(version || ''));
    if (!row) return null;
    try {
      return { id: row.id, result: JSON.parse(row.result), learned: Boolean(row.learned) };
    } catch {
      return null;
    }
  }

  /**
   * Bewaart een AI-herkenning.
   * @param {object} recognition tenantId, userId, hash, model, version en result.
   * @returns {string} Id van de nieuwe regel.
   */
  function saveAi({ tenantId, userId = null, hash, model, version, result }) {
    const id = crypto.randomUUID();
    const timestamp = currentTimestamp();
    prepare(`INSERT INTO plan_recognitions (id, tenant_id, user_id, source, image_hash, plan_id, model, version, result, samples, created_at, updated_at)
      VALUES (?, ?, ?, 'ai', ?, NULL, ?, ?, ?, '', ?, ?)`)
      .run(id, tenantId, userId || null, hash, String(model || ''), String(version || ''), JSON.stringify(result), timestamp, timestamp);
    return id;
  }

  /**
   * Slaat de tellingen bij een AI-herkenning van deze tenant op; alleen de eerste keer (niet overschrijven).
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de herkenning.
   * @param {object} samples De gecontroleerde tellingen.
   * @returns {boolean} Of de tellingen zijn opgeslagen.
   */
  function addSamples(tenantId, id, samples) {
    const changes = prepare(`UPDATE plan_recognitions SET samples = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND source = 'ai' AND samples = ''`)
      .run(JSON.stringify(samples), currentTimestamp(), tenantId, String(id || '')).changes;
    if (changes) cache.delete(tenantId);
    return changes > 0;
  }

  /**
   * Slaat de tellingen van een goedgekeurd plan op: één regel per plan, een nieuwe goedkeuring vervangt de oude.
   * @param {object} entry tenantId, userId, planId en samples.
   */
  function savePlanSamples({ tenantId, userId = null, planId, samples }) {
    const timestamp = currentTimestamp();
    const row = prepare(`SELECT id FROM plan_recognitions WHERE tenant_id = ? AND plan_id = ? AND source = 'plan'`).get(tenantId, String(planId));
    if (row) prepare('UPDATE plan_recognitions SET samples = ?, user_id = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(samples), userId || null, timestamp, row.id);
    else {
      prepare(`INSERT INTO plan_recognitions (id, tenant_id, user_id, source, image_hash, plan_id, model, version, result, samples, created_at, updated_at)
        VALUES (?, ?, ?, 'plan', '', ?, '', '', '', ?, ?, ?)`)
        .run(crypto.randomUUID(), tenantId, userId || null, String(planId), JSON.stringify(samples), timestamp, timestamp);
    }
    cache.delete(tenantId);
  }

  /**
   * Opgetelde kennis van de tenant uit de laatste voorbeelden (een goedgekeurd plan telt dubbel); 60 s in het geheugen.
   * @param {string} tenantId Id van de tenant.
   * @returns {{ v: number, examples: number, bins: object }} Versie, aantal voorbeelden en de tellingen per vakje (leeg zonder voorbeelden).
   */
  function learned(tenantId) {
    const hit = cache.get(tenantId);
    if (hit && hit.until > Date.now()) return hit.value;
    const rows = prepare(`SELECT source, samples FROM plan_recognitions WHERE tenant_id = ? AND samples <> ''
      ORDER BY created_at DESC LIMIT ${MAX_EXAMPLES}`).all(tenantId);
    const bins = {};
    let examples = 0;
    for (const row of rows) {
      let samples;
      try { samples = JSON.parse(row.samples); } catch { continue; }
      if (!samples || samples.v !== FEATURE_VERSION || !samples.bins) continue;
      const weight = row.source === 'plan' ? 2 : 1;
      for (const [bin, counts] of Object.entries(samples.bins)) {
        const total = bins[bin] || (bins[bin] = [0, 0, 0, 0, 0, 0]);
        for (let typeIndex = 0; typeIndex < 6; typeIndex++) total[typeIndex] += (counts[typeIndex] || 0) * weight;
      }
      examples++;
    }
    const value = { v: FEATURE_VERSION, examples, bins };
    cache.set(tenantId, { until: Date.now() + CACHE_MS, value });
    return value;
  }

  /**
   * AVG: bij het wissen van een plan ook zijn tellingen weg.
   * @param {string} tenantId Id van de tenant.
   * @param {string} planId Id van het plan.
   * @returns {number} Aantal verwijderde regels.
   */
  function removePlan(tenantId, planId) {
    const removed = prepare(`DELETE FROM plan_recognitions WHERE tenant_id = ? AND plan_id = ?`).run(tenantId, String(planId)).changes;
    if (removed) cache.delete(tenantId);
    return removed;
  }

  return { findAi, saveAi, addSamples, savePlanSamples, learned, removePlan };
}

module.exports = { createRecognitionStore, sanitizeSamples, imageHash, FEATURE_VERSION };
