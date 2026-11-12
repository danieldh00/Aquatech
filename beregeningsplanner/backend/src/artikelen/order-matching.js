// Koppelt de regels die uit een leveranciersdocument zijn gelezen aan artikelen en leveranciers
// (zuivere functies, geen database). Volgorde per regel: artikelnummer van de leverancier,
// artikelcode, exacte omschrijving en tot slot gelijkenis van de omschrijving (alleen een voorstel).

const SUGGESTIONS = 3;
const MIN_SIMILARITY = 0.5;

/**
 * Maakt tekst vergelijkbaar: kleine letters, alleen letters en cijfers, enkele spaties.
 * @param {*} value De tekst.
 * @returns {string} De genormaliseerde tekst.
 */
function normalize(value) {
  return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * De woorden van een tekst (genormaliseerd), zonder dubbelen.
 * @param {string} value De tekst.
 * @returns {Set<string>} De woorden.
 */
const wordsOf = (value) => new Set(normalize(value).split(' ').filter(Boolean));

/**
 * Gelijkenis van twee omschrijvingen: gedeelde woorden gedeeld door alle woorden (0 tot 1).
 * @param {string} left De ene tekst.
 * @param {string} right De andere tekst.
 * @returns {number} De gelijkenis.
 */
function similarity(left, right) {
  return overlap(wordsOf(left), wordsOf(right));
}

/**
 * Gelijkenis van twee woordensets (gedeelde woorden gedeeld door alle woorden).
 * @param {Set<string>} leftWords De ene set.
 * @param {Set<string>} rightWords De andere set.
 * @returns {number} De gelijkenis (0 tot 1).
 */
function overlap(leftWords, rightWords) {
  if (!leftWords.size || !rightWords.size) return 0;
  let shared = 0;
  for (const word of leftWords) if (rightWords.has(word)) shared += 1;
  return shared / (leftWords.size + rightWords.size - shared);
}

/**
 * Zoekt de leverancier die bij de naam op het document past: eerst gelijk, dan bevat de ene naam de andere.
 * @param {string} name De naam op het document.
 * @param {Array<{ id: string, name: string }>} suppliers De leveranciers van de omgeving.
 * @returns {object|null} De leverancier, of null als er geen (of meer dan één) past.
 */
function matchSupplier(name, suppliers) {
  const wanted = normalize(name);
  if (!wanted) return null;
  const exact = suppliers.filter((supplier) => normalize(supplier.name) === wanted);
  if (exact.length === 1) return exact[0];
  const partial = suppliers.filter((supplier) => {
    const own = normalize(supplier.name);
    return own.length >= 4 && wanted.length >= 4 && (wanted.includes(own) || own.includes(wanted));
  });
  return partial.length === 1 ? partial[0] : null;
}

/**
 * De artikelen die het best op de woorden lijken (gelijkenis vanaf de ondergrens), hoogste eerst.
 * @param {Set<string>} lineWords De woorden van de omschrijving op het document.
 * @param {Array<{ item: object, words: Set<string> }>} candidates De artikelen met hun woordenset.
 * @returns {Array<{ candidate: object, score: number }>} Hoogstens SUGGESTIONS artikelen met hun score.
 */
function bestMatches(lineWords, candidates) {
  const best = [];
  for (const entry of candidates) {
    const score = overlap(lineWords, entry.words);
    if (score < MIN_SIMILARITY) continue;
    if (best.length === SUGGESTIONS && score <= best[best.length - 1].score) continue;
    best.push({ candidate: entry.item, score });
    best.sort((left, right) => right.score - left.score);
    if (best.length > SUGGESTIONS) best.pop();
  }
  return best;
}

/**
 * Koppelt gelezen regels aan artikelen.
 * @param {Array<{ supplierSku: string, description: string }>} lines De gelezen regels.
 * @param {Array<{ id: string, code: string, name: string }>} items De artikelen om uit te kiezen (geen hoofdartikelen of gearchiveerde).
 * @param {Map<string, string>} skuToItem Artikelnummer van de leverancier (genormaliseerd) naar artikel-id.
 * @returns {object[]} Per regel: itemId, itemCode, itemName, matchedBy (leveranciersnummer, code, omschrijving, gelijkenis of null), sure en suggestions.
 */
function matchLines(lines, items, skuToItem) {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const itemByCode = new Map(items.map((item) => [normalize(item.code), item]));
  const itemsByName = new Map();
  for (const item of items) {
    const key = normalize(item.name);
    if (key) itemsByName.set(key, itemsByName.has(key) ? null : item);
  }
  // Woordenset per artikel één keer, niet per regel opnieuw.
  const candidates = items.map((item) => ({ item, words: wordsOf(item.name) }));
  return lines.map((line) => {
    const skuKey = normalize(line.supplierSku);
    let item = null;
    let matchedBy = null;
    if (skuKey && skuToItem.has(skuKey)) { item = itemById.get(skuToItem.get(skuKey)) || null; if (item) matchedBy = 'leveranciersnummer'; }
    if (!item && skuKey && itemByCode.has(skuKey)) { item = itemByCode.get(skuKey); matchedBy = 'code'; }
    if (!item) {
      const named = itemsByName.get(normalize(line.description));
      if (named) { item = named; matchedBy = 'omschrijving'; }
    }
    // Suggesties alleen voor een regel die nog geen artikel heeft; een lus houdt de beste drie bij (geen volledige sortering).
    const ranked = item ? [] : bestMatches(wordsOf(line.description), candidates);
    if (!item && ranked.length) { item = ranked[0].candidate; matchedBy = 'gelijkenis'; }
    // Zeker is alleen wat op nummer, code of exacte omschrijving klopt; een gok op gelijkenis nooit.
    return {
      itemId: item ? item.id : null, itemCode: item ? item.code : '', itemName: item ? item.name : '', matchedBy, sure: Boolean(item) && matchedBy !== 'gelijkenis',
      suggestions: ranked.map((entry) => ({ itemId: entry.candidate.id, code: entry.candidate.code, name: entry.candidate.name })),
    };
  });
}

module.exports = { normalize, similarity, matchSupplier, matchLines };
