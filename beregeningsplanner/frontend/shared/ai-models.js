// AI-modellen, prijzen en functies, gedeeld door de server (require) en de
// browser (window.AquatechAiModels). De server rekent hiermee de kosten van
// elk AI-verzoek uit (tabel ai_usage, zie backend/src/platform/ai-usage.js); Beheer >
// Instellingen toont de keuzelijst en Beheer > AI-kosten de namen.
//
// Prijzen in dollar per miljoen tokens (tarieven van Anthropic). Lezen uit de
// cache kost een fractie, schrijven naar de cache 1,25× de invoerprijs. Het
// denkwerk van het model telt mee als uitvoer. Een prijswijziging bij
// Anthropic? Pas de bedragen hier aan: oude verzoeken houden hun berekende
// kosten (die staan bij het verzoek opgeslagen).
(function (root) {
  const MODELS = {
    'claude-opus-5-5': { label: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, select: true, fallback: true,
      description: 'Aanbevolen: leest ook lastige handschetsen en CAD-tekeningen goed.' },
    'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, select: true, fallback: true,
      description: 'Half zo duur als Opus; goed voor duidelijke, digitale plannen.' },
    'claude-haiku-5-5': { label: 'Claude Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, select: true, fallback: false,
      description: 'Veruit het goedkoopst en snel, maar minder nauwkeurig bij schetsen.' },
    'claude-fable-5-1': { label: 'Claude Fable 5.1', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, select: true, fallback: true,
      description: 'Het krachtigste model; duurder en trager.' },
    // Kan het antwoord geven als de AI-dienst een verzoek doorzet naar een
    // ander model (server-side fallback); niet zelf te kiezen.
    'claude-opus-5': { label: 'Claude Opus 5', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-8': { label: 'Claude Opus 4.8', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-sonnet-5': { label: 'Claude Sonnet 5', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    'claude-fable-5': { label: 'Claude Fable 5', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  };
  const DEFAULT = 'claude-opus-5-5';
  const SELECTABLE = Object.keys(MODELS).filter((key) => MODELS[key].select);

  // Waarvoor de app AI gebruikt (kolom feature in ai_usage).
  const FEATURES = {
    plan_analyse: 'Plan herkennen',
  };

  /**
   * Prijs van een model. Het model zoals de AI-dienst het teruggeeft kan een
   * datum-achtervoegsel hebben (claude-…-20260101): dan het basismodel.
   * @param {string} model Model-id.
   * @returns {object} id, label, prijzen per miljoen tokens en known (false = onbekend, standaardmodel gebruikt).
   */
  function priceOf(model) {
    const id = String(model || '');
    if (MODELS[id]) return { id, ...MODELS[id], known: true };
    const base = Object.keys(MODELS).find((key) => id.startsWith(`${key}-`));
    if (base) return { id: base, ...MODELS[base], known: true };
    return { id: DEFAULT, ...MODELS[DEFAULT], known: false };
  }

  /**
   * Leesbare naam van een model.
   * @param {string} model Model-id.
   * @returns {string} De naam (of het id zelf als het onbekend is).
   */
  const label = (model) => (MODELS[model] ? MODELS[model].label : priceOf(model).known ? priceOf(model).label : String(model || '–'));
  /**
   * Leesbare naam van een AI-functie.
   * @param {string} feature Sleutel (bijv. plan_analyse).
   * @returns {string} De naam.
   */
  const featureLabel = (feature) => FEATURES[feature] || String(feature || '–');

  /**
   * Kosten in dollar van één verzoek. usage = { inputTokens, outputTokens,
   * cacheReadTokens, cacheWriteTokens } (of de velden van de AI-dienst).
   * @param {string} model Model-id.
   * @param {object} usage Tokenverbruik.
   * @returns {{ usd: number, known: boolean }} Kosten; known = false: onbekend model, geschat met de prijs van het standaardmodel.
   */
  function costUsd(model, usage) {
    const counts = usage || {};
    /**
     * Aantal tokens uit het eerste veld dat er is (nooit negatief).
     * @param {string} camelName Veldnaam van de app.
     * @param {string} snakeName Veldnaam van de AI-dienst.
     * @returns {number} Aantal tokens.
     */
    const tokens = (camelName, snakeName) => Math.max(0, Number(counts[camelName] ?? counts[snakeName]) || 0);
    const price = priceOf(model);
    const usd = (tokens('inputTokens', 'input_tokens') * price.input + tokens('outputTokens', 'output_tokens') * price.output
      + tokens('cacheReadTokens', 'cache_read_input_tokens') * price.cacheRead + tokens('cacheWriteTokens', 'cache_creation_input_tokens') * price.cacheWrite) / 1e6;
    return { usd, known: price.known };
  }

  const api = { MODELS, DEFAULT, SELECTABLE, FEATURES, priceOf, label, featureLabel, costUsd };
  root.AquatechAiModels = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
