// Zoeken in de webshop: normaliseren (hoofdletters, accenten, leestekens), rangschikken op relevantie (exacte artikelcode eerst, dan
// beginnende codes en namen, dan de rest) en, als er niets gevonden wordt, ruimer zoeken met verwante woorden en kleine typefouten.
// Zuivere functies zonder database: de catalogus wordt meegegeven.

/** Groepen van woorden die voor een bezoeker hetzelfde betekenen (genormaliseerd, enkelvoud). */
const SYNONYM_GROUPS = [
  ['sproeier', 'sprinkler', 'sproeikop', 'spuitkop', 'sproeidop'],
  ['druppelslang', 'druppelleiding', 'druppelbuis', 'druppelaar', 'driptape', 'druppelband'],
  ['magneetklep', 'klep', 'ventiel', 'solenoid', 'beregeningsklep'],
  ['regensensor', 'regenmelder', 'regenschakelaar', 'regenmeter'],
  ['beregeningscomputer', 'stuurcomputer', 'timer', 'programmeur', 'besturing', 'regelunit'],
  ['verdeler', 'manifold', 'kleppenblok'],
  ['koppeling', 'koppelstuk', 'connector', 'verbinder', 'fitting'],
  ['slang', 'tuinslang', 'waterslang'],
  ['buis', 'leiding', 'pijp', 'pebuis'],
  ['pomp', 'waterpomp', 'tuinpomp'],
  ['filter', 'zeef', 'vuilfilter'],
  ['kraan', 'afsluiter', 'kogelkraan'],
  ['gazon', 'grasveld', 'gras'],
  ['rotator', 'roterende', 'draaisproeier'],
];

/** Hoeveel resultaten het zoeken hoogstens teruggeeft (de pagina toont er minder). */
const MAX_RESULTS = 400;

/** Voor elk woord de andere woorden uit zijn groep (alleen genormaliseerd en op de gevonden woorden). */
const SYNONYMS = (() => {
  const map = new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) map.set(word, group.filter((other) => other !== word));
  }
  return map;
})();

/**
 * Maakt van een tekst kleine letters zonder accenten en met alleen letters, cijfers en spaties (andere tekens worden spaties).
 * @param {*} text De tekst.
 * @returns {string} De genormaliseerde tekst.
 */
function normalize(text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Een grove stam van een woord: een meervoud op -en of -s valt weg (sproeiers → sproeier, kranen → kran). Afwijkende vormen vangt
 * stemsOf op.
 * @param {string} word Een genormaliseerd woord.
 * @returns {string} De stam.
 */
function stemOf(word) {
  if (word.length > 5 && word.endsWith('en')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/**
 * Alle enkelvoudsvormen die bij een meervoud kunnen horen: de grove stam, met een verdubbelde slotmedeklinker weer enkel
 * (kleppen → klepp → klep), met een verdubbelde klinker (kranen → kran → kraan) en met z of v als s of f (buizen → buis).
 * @param {string} word Een genormaliseerd woord.
 * @returns {string[]} De mogelijke enkelvoudsvormen, zonder het woord zelf en zonder te korte vormen.
 */
function stemsOf(word) {
  const stem = stemOf(word);
  if (stem === word) return [];
  const forms = new Set([stem]);
  if (stem.length > 3 && stem.at(-1) === stem.at(-2) && !/[aeiou]/.test(stem.at(-1))) forms.add(stem.slice(0, -1));
  if (/[^aeiou][aeiou][^aeiou]$/.test(stem)) forms.add(`${stem.slice(0, -2)}${stem.at(-2)}${stem.slice(-2)}`);
  if (stem.endsWith('z')) forms.add(`${stem.slice(0, -1)}s`);
  if (stem.endsWith('v')) forms.add(`${stem.slice(0, -1)}f`);
  return [...forms].filter((form) => form.length >= 3);
}

/**
 * Het hoogste aantal tikfouten dat bij een woord van deze lengte nog als dezelfde term telt.
 * @param {number} length Aantal tekens van het gezochte woord.
 * @returns {number} 0 (korte woorden en cijfers zoeken precies), 1 of 2.
 */
function typoLimit(length) {
  if (length < 5) return 0;
  return length < 8 ? 1 : 2;
}

/**
 * Of twee woorden hoogstens `limit` bewerkingen (invoegen, weglaten, vervangen, twee letters omwisselen) uit elkaar liggen.
 * @param {string} left Het ene woord.
 * @param {string} right Het andere woord.
 * @param {number} limit De toegestane afstand.
 * @returns {boolean} true als ze dichtbij genoeg zijn.
 */
function withinDistance(left, right, limit) {
  if (limit <= 0) return left === right;
  if (Math.abs(left.length - right.length) > limit) return false;
  let previousPrevious = null;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let best = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let value = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost);
      if (previousPrevious && row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) value = Math.min(value, previousPrevious[column - 2] + 1);
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return false;
    previousPrevious = previous;
    previous = current;
  }
  return previous[right.length] <= limit;
}

/**
 * Bereidt één zoekbare eenheid voor (een product, of een product met één subartikel): genormaliseerde naam, code en woorden.
 * @param {object} product De artikelgroep (code, name, categoryName).
 * @param {?object} subartikel Het subartikel (code, label) of null.
 * @returns {{ code: string, compactCode: string, haystack: string, tokens: string[], inStock: boolean }} De eenheid.
 */
function candidateOf(product, subItem) {
  const code = normalize(subItem ? subItem.code : product.code);
  // Een code met streepje of spatie (SPR-10) is ook zonder te vinden (SPR10): de samengevoegde code is een eigen woord.
  const compactCode = code.replace(/ /g, '');
  const haystack = normalize(`${product.name} ${product.code} ${product.categoryName || ''} ${subItem ? `${subItem.code} ${subItem.label}` : ''} ${compactCode}`);
  return { code, compactCode, haystack, tokens: haystack.split(' ').filter(Boolean), inStock: subItem ? Boolean(subItem.inStock) : Boolean(product.inStock) };
}

/**
 * Hoe goed één zoekwoord bij een eenheid past: een exacte code of woord weegt zwaarder dan het begin van een woord, en dat weer
 * zwaarder dan ergens in een woord. Bij `wide` tellen ook de stam, verwante woorden en kleine tikfouten mee.
 * @param {string} word Het genormaliseerde zoekwoord.
 * @param {object} candidate De eenheid (uit candidateOf).
 * @param {boolean} wide Of verwante woorden en tikfouten meetellen.
 * @param {string[]} [forms] De mogelijke enkelvoudsvormen van het zoekwoord (stemsOf, één keer per zoekopdracht berekend).
 * @returns {number} 0 als het niet past, anders een score (hoger is beter).
 */
function wordScore(word, candidate, wide, forms = []) {
  if (candidate.code === word || candidate.compactCode === word) return 100;
  if (candidate.tokens.includes(word)) return 40;
  if (candidate.tokens.some((token) => token.startsWith(word))) return 30;
  if (candidate.haystack.includes(word)) return 20;
  if (!wide) return 0;
  // Een vorm van drie tekens (koppen → kop) telt alleen als begin van een woord, anders vindt kop ook Koppeling.
  if (forms.some((form) => (form.length > 3 ? candidate.haystack.includes(form) : candidate.tokens.some((token) => token.startsWith(form))))) return 18;
  for (const form of [word, ...forms]) {
    for (const related of SYNONYMS.get(form) || []) {
      if (candidate.haystack.includes(related)) return 14;
    }
  }
  const limit = typoLimit(word.length);
  if (limit > 0 && candidate.tokens.some((token) => withinDistance(word, token, limit) || (token.length > word.length && withinDistance(word, token.slice(0, word.length), limit)))) return 8;
  return 0;
}

/** Per catalogus (de lijst producten, die de gegevenslaag 30 seconden hergebruikt) de eenmaal genormaliseerde zoekeenheden. */
const INDEX_CACHE = new WeakMap();

/**
 * De zoekeenheden van een catalogus: per product de genormaliseerde naam en per subartikel (of het product zelf) één kandidaat.
 * Wordt één keer per catalogus berekend, zodat een zoekopdracht alleen nog scoort.
 * @param {object[]} products De producten van de catalogus.
 * @returns {{ product: object, productName: string, candidates: object[] }[]} De index.
 */
function indexOf(products) {
  let index = INDEX_CACHE.get(products);
  if (!index) {
    index = products.map((product) => {
      const subItems = product.subItems || [];
      return { product, productName: normalize(product.name), candidates: subItems.length ? subItems.map((subItem) => candidateOf(product, subItem)) : [candidateOf(product, null)] };
    });
    INDEX_CACHE.set(products, index);
  }
  return index;
}

/**
 * Zoekt één tier: elk zoekwoord moet bij dezelfde eenheid (de artikelgroep of één subartikel) passen.
 * @param {{ product: object, productName: string, candidates: object[] }[]} index De zoekeenheden van de catalogus (uit indexOf).
 * @param {string[]} words De genormaliseerde zoekwoorden.
 * @param {string} phrase Alle woorden achter elkaar, genormaliseerd.
 * @param {boolean} onlyInStock Of de gevonden eenheid op voorraad moet zijn.
 * @param {boolean} wide Of verwante woorden en tikfouten meetellen.
 * @param {Map<string, string[]>} formsByWord Per zoekwoord de mogelijke enkelvoudsvormen.
 * @returns {{ product: object, score: number }[]} De gevonden producten met score, nog ongesorteerd.
 */
function searchTier(index, words, phrase, onlyInStock, wide, formsByWord) {
  // Een code met streepjes of spaties (MP-2000, mp 2000) is na het normaliseren los van elkaar; samen vergelijken we hem met de code.
  const compact = words.join('');
  const found = [];
  for (const { product, productName, candidates } of index) {
    let best = 0;
    for (const candidate of candidates) {
      if (onlyInStock && !candidate.inStock) continue;
      let total = 0;
      let allMatch = true;
      for (const word of words) {
        const score = wordScore(word, candidate, wide, formsByWord.get(word));
        if (!score) { allMatch = false; break; }
        total += score;
      }
      if (!allMatch) continue;
      if (candidate.code === phrase || candidate.compactCode === compact) total += 1000;
      else if (candidate.compactCode.startsWith(compact)) total += 400;
      if (productName.startsWith(phrase)) total += 100;
      if (words.every((word) => productName.includes(word))) total += 50;
      if (candidate.inStock) total += 5;
      best = Math.max(best, total);
    }
    if (best) found.push({ product, score: best });
  }
  return found;
}

/**
 * Zoekt in de catalogus en rangschikt op relevantie. Eerst precies (woorden, begin van woorden en delen van woorden); komt daar
 * niets uit, dan ruimer met meervouden, verwante woorden (sproeier = sprinkler) en kleine tikfouten.
 * @param {object[]} products De producten van de catalogus (code, name, categoryName, inStock, subartikelen).
 * @param {string} query De zoekterm van de bezoeker.
 * @param {{ onlyInStock?: boolean, limit?: number }} [options] onlyInStock: alleen wat op voorraad is; limit: hoogstens zoveel resultaten.
 * @returns {{ products: object[], widened: boolean }} De gevonden producten, beste eerst, en of er ruimer is gezocht.
 */
function searchProducts(products, query, { onlyInStock = false, limit = MAX_RESULTS } = {}) {
  const phrase = normalize(query);
  const words = phrase.split(' ').filter(Boolean);
  if (!words.length) return { products: [], widened: false };
  const index = indexOf(products);
  const formsByWord = new Map(words.map((word) => [word, stemsOf(word)]));
  let widened = false;
  let found = searchTier(index, words, phrase, onlyInStock, false, formsByWord);
  if (!found.length) {
    widened = true;
    found = searchTier(index, words, phrase, onlyInStock, true, formsByWord);
  }
  found.sort((left, right) => right.score - left.score || left.product.name.localeCompare(right.product.name, 'nl'));
  return { products: found.slice(0, limit).map((entry) => entry.product), widened };
}

module.exports = { searchProducts, normalize, withinDistance, stemOf, stemsOf, MAX_RESULTS };
