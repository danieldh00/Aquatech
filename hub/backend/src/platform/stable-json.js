/**
 * Stabiele JSON-tekst: objectsleutels altijd alfabetisch, zodat een hash over gegevens
 * niet afhangt van de sleutelvolgorde (jsonb in PostgreSQL bewaart een eigen volgorde).
 */

/**
 * Zet een waarde om naar JSON met alfabetisch gesorteerde objectsleutels.
 * @param {*} value De waarde (object, array of primitief).
 * @returns {string} JSON-tekst met vaste sleutelvolgorde.
 */
function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

/**
 * Geeft een kopie van de waarde met overal alfabetisch gesorteerde objectsleutels.
 * @param {*} value De waarde.
 * @returns {*} De gesorteerde kopie.
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
    return sorted;
  }
  return value;
}

module.exports = { stableStringify };
