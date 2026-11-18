// Feitencontrole van een door de AI geschreven producttekst. De tekst mag alleen feiten bevatten die in de bekende
// artikelgegevens staan (naam, code, eenheid, merk, EAN, categorie, specificaties, varianten, bestaande omschrijvingen).
// `buildFacts` zet die gegevens om naar bronvelden (voor de opdracht aan de AI én als bron voor de controle);
// `checkText` vergelijkt getallen, getal + eenheid en claims (certificeringen, garantie) in de concepttekst met die bron en
// geeft elke afwijking terug als waarschuwing voor het goedkeuringsscherm. Alles zuivere functies, zonder database of netwerk.
const ItemDetails = require('./item-details');

/** Eenheden die bij een getal gecontroleerd worden, met hun vaste schrijfwijze. */
const UNIT_ALIASES = {
  'mm²': 'mm²', mm2: 'mm²', mm: 'mm', cm: 'cm', km: 'km', 'm³': 'm³', m3: 'm³', 'm²': 'm²', m2: 'm²', m: 'm', meter: 'm',
  ml: 'ml', l: 'l', liter: 'l', bar: 'bar', kg: 'kg', g: 'g', gram: 'g', w: 'w', kw: 'kw', v: 'v', a: 'a', '°c': '°c', '%': '%',
  inch: 'inch', '"': 'inch', stuk: 'st', stuks: 'st', st: 'st', rol: 'rol', rollen: 'rol', set: 'set',
};
const UNIT_PATTERN = '(mm²|mm2|mm|cm|km|m³|m3|m²|m2|meter|m|ml|liter|l|bar|kg|gram|g|kw|w|v|a|°c|%|inch|"|stuks|stuk|st|rollen|rol|set)';
const PAIR_PATTERN = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${UNIT_PATTERN}(?![\\p{L}\\d])`, 'giu');
/** Een getal op zichzelf: niet vastgeplakt aan letters (PN10, 25mm) of cijfers; getal + eenheid hoort bij PAIR_PATTERN. */
const NUMBER_PATTERN = /(?<![\p{L}\d.,])\d+(?:[.,]\d+)*(?![\p{L}\d])/gu;
/** Een code van letters met een getal erachter (PN10, DN25, PE100, IP68): moet als geheel in de bron staan. */
const CODE_PATTERN = /(?<![\p{L}\d])\p{L}{1,4}-?\d+(?:[.,]\d+)?(?![\p{L}\d])/gu;
/** Afkortingen van keuren en normen (hoofdletters), die alleen in de tekst mogen als ze in de bron staan. */
const CLAIM_ACRONYMS = /(?<![\p{L}\d])(ISO ?\d*|KIWA|KOMO|DIN ?\d*|NEN ?\d*|EN ?\d{3,}|IP ?\d{2}|WRAS|NSF|FDA|RoHS|REACH|CE)(?![\p{L}\d])/gu;
/** Woorden die een bewering over certificering, garantie of eigenschappen doen; ze mogen alleen in de tekst als ze in de bron staan. */
const CLAIM_WORDS = /\b(CE-?markering|gecertificeerd|garantie|waterdicht|vorstbestendig|vorstvrij|UV-bestendig|roestvrij|corrosiebestendig|drinkwatergeschikt|geschikt voor drinkwater|milieuvriendelijk|duurzaam|energiezuinig|Made in [A-Za-z]+|gratis verzending|op voorraad|direct leverbaar|snel geleverd)\b/giu;
/** Hoeveel tekens van elke bron hoogstens meegaan (de opdracht blijft klein en betaalbaar). */
const MAX_SOURCE_TEXT = 3000;

/**
 * Leest het getal van een tekst als waarde(n): "2,5" en "2.5" zijn 2,5; "1.000" kan 1000 of 1,000 zijn.
 * @param {string} token Het getal zoals het in de tekst staat.
 * @returns {number[]} De mogelijke waarden.
 */
function valuesOf(token) {
  const values = new Set();
  const plain = Number(token.replace(',', '.'));
  if (Number.isFinite(plain)) values.add(plain);
  if (/^\d{1,3}([.,]\d{3})+$/.test(token)) values.add(Number(token.replace(/[.,]/g, '')));
  return [...values];
}

/**
 * Alle getallen en getal+eenheid-paren in een tekst.
 * @param {string} text De tekst.
 * @returns {{ numbers: Set<number>, pairs: Set<string>, codes: Set<string> }} De losse getallen, de paren (waarde + eenheid, bijvoorbeeld "25|mm") en de codes (bijvoorbeeld "pn10").
 */
function numbersIn(text) {
  const numbers = new Set();
  const pairs = new Set();
  const codes = new Set((String(text || '').match(CODE_PATTERN) || []).map((code) => code.toLowerCase().replace(/\s+/g, '')));
  for (const token of String(text || '').match(NUMBER_PATTERN) || []) for (const value of valuesOf(token)) numbers.add(value);
  for (const match of String(text || '').matchAll(PAIR_PATTERN)) {
    for (const value of valuesOf(match[1])) {
      numbers.add(value);
      pairs.add(`${value}|${UNIT_ALIASES[match[2].toLowerCase()] || match[2].toLowerCase()}`);
    }
  }
  return { numbers, pairs, codes };
}

/**
 * Zet de gegevens van een artikel om naar bronvelden.
 * @param {object} row De artikelrij met name, code, unit, brand, ean, weight_grams, description, specifications, attributes, shop_description, shop_attributes, seo_title, seo_description en categories.
 * @param {string} [categoryName] De categorie in de webshop (leeg = onbekend).
 * @returns {{ fields: { label: string, value: string }[], sourceText: string, thin: boolean }} De bronvelden (alleen gevulde), alle bronnen als één tekst voor de controle, en of er weinig gegevens zijn.
 */
function buildFacts(row, categoryName = '') {
  const details = ItemDetails.shownDetails(row);
  /**
   * Kort een bron in.
   * @param {*} value De tekst.
   * @returns {string} De tekst zonder randspaties, hoogstens MAX_SOURCE_TEXT tekens.
   */
  const clip = (value) => String(value || '').trim().slice(0, MAX_SOURCE_TEXT);
  let attributes = [];
  try { attributes = JSON.parse(row.attributes || '[]'); } catch { attributes = []; }
  const variantLines = (Array.isArray(attributes) ? attributes : []).filter((attribute) => attribute && attribute.name && Array.isArray(attribute.values) && attribute.values.length)
    .map((attribute) => `${attribute.name}: ${attribute.values.join(', ')}`);
  const candidates = [
    ['Naam', row.name], ['Artikelcode', row.code], ['Eenheid', row.unit], ['Merk', details.brand], ['EAN', row.ean],
    ['Gewicht (gram)', row.weight_grams == null ? '' : String(row.weight_grams)], ['Categorie in de webshop', categoryName],
    ['Specificaties', details.specifications.map((specification) => `${specification.name}: ${specification.value}`).join('\n')],
    ['Beschikbaar in (varianten)', variantLines.join('\n')],
    ['Bestaande omschrijving', ItemDetails.sanitizeDescription(row.description) || ItemDetails.sanitizeDescription(row.shop_description)],
  ];
  const fields = candidates.map(([label, value]) => ({ label, value: clip(value) })).filter((field) => field.value);
  const informative = fields.filter((field) => !['Naam', 'Artikelcode', 'Eenheid', 'EAN'].includes(field.label));
  return { fields, sourceText: fields.map((field) => field.value).join('\n'), thin: informative.length === 0 };
}

/**
 * Vergelijkt de concepttekst met de bron en meldt elke afwijking.
 * @param {{ description?: string, seoTitle?: string, seoDescription?: string }} texts De concepttekst.
 * @param {string} sourceText De bron (buildFacts().sourceText).
 * @returns {{ field: string, kind: string, text: string, message: string }[]} Waarschuwingen: kind is number (getal niet in de bron), unit (getal staat met een andere eenheid in de bron), claim (certificering of belofte niet in de bron) of link.
 */
function checkText(texts, sourceText) {
  const source = numbersIn(sourceText);
  const sourceLower = String(sourceText || '').toLowerCase();
  const warnings = [];
  const seen = new Set();
  /**
   * Voegt een waarschuwing toe (elke combinatie van veld, soort en tekst één keer).
   * @param {string} field Het veld.
   * @param {string} kind De soort.
   * @param {string} text De verdachte tekst.
   * @param {string} message De uitleg.
   * @returns {void}
   */
  const add = (field, kind, text, message) => {
    const key = `${field}|${kind}|${text}`;
    if (!seen.has(key)) { seen.add(key); warnings.push({ field, kind, text, message }); }
  };
  for (const field of ['description', 'seoTitle', 'seoDescription']) {
    const value = String(texts[field] || '');
    const covered = new Set();
    for (const match of value.matchAll(PAIR_PATTERN)) {
      const unit = UNIT_ALIASES[match[2].toLowerCase()] || match[2].toLowerCase();
      const values = valuesOf(match[1]);
      for (let index = 0; index < match[1].length; index += 1) covered.add(match.index + index);
      if (values.some((candidate) => source.pairs.has(`${candidate}|${unit}`))) continue;
      const known = [...source.pairs].filter((pair) => values.includes(Number(pair.split('|')[0]))).map((pair) => pair.split('|')[1]);
      if (known.length) add(field, 'unit', match[0], `"${match[0]}" past niet bij de gegevens: daar staat dit getal met ${[...new Set(known)].join(' of ')}.`);
      else add(field, 'number', match[0], `"${match[0]}" staat niet in de artikelgegevens.`);
    }
    for (const match of value.matchAll(NUMBER_PATTERN)) {
      if (covered.has(match.index)) continue;
      if (valuesOf(match[0]).some((candidate) => source.numbers.has(candidate))) continue;
      add(field, 'number', match[0], `Het getal "${match[0]}" staat niet in de artikelgegevens.`);
    }
    for (const match of value.matchAll(CODE_PATTERN)) {
      if (source.codes.has(match[0].toLowerCase().replace(/\s+/g, ''))) continue;
      add(field, 'number', match[0], `"${match[0]}" staat niet in de artikelgegevens.`);
    }
    for (const pattern of [CLAIM_ACRONYMS, CLAIM_WORDS]) {
      for (const match of value.matchAll(pattern)) {
        if (sourceLower.includes(match[0].toLowerCase())) continue;
        add(field, 'claim', match[0], `"${match[0]}" is een bewering die niet in de artikelgegevens staat.`);
      }
    }
    if (/https?:\/\/|www\.|@/i.test(value)) add(field, 'link', 'link', 'De tekst bevat een webadres of e-mailadres; dat staat niet in de artikelgegevens.');
  }
  return warnings;
}

module.exports = { buildFacts, checkText, numbersIn, valuesOf, MAX_SOURCE_TEXT };
