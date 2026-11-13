// Voorstellen voor het samenvoegen van losse artikelen tot één variabel artikel:
// artikelen die alleen in een maat (of kleur) in de omschrijving verschillen,
// bijv. "PE-buis 16 mm", "PE-buis 20 mm" en "PE-buis 25 mm". Zuivere functies
// zonder database, zodat ze los te testen zijn (stock.js haalt de artikelen op).

/** Eenheden die achter een getal horen en dan samen de maat vormen (16 mm, 3/4 inch). */
const MEASURE_UNITS = new Set(['mm', 'cm', 'm', 'meter', 'l', 'ltr', 'liter', 'kg', 'g', 'gr', 'bar', 'inch', 'mtr', 'cm²', 'm²', 'm2', 'ml', 'w', 'v', 'volt', 'watt', 'lit']);
/** Kleuren die als kenmerk "Kleur" gelden als een artikel geen maat heeft. */
const COLOURS = new Set(['zwart', 'wit', 'grijs', 'antraciet', 'blauw', 'groen', 'rood', 'geel', 'bruin', 'oranje', 'naturel', 'transparant', 'zilver', 'goud']);
/** Hoogstens zoveel voorstellen tegelijk. */
const MAX_GROUPS = 50;
/** Hoogstens zoveel artikelen in één voorstel (gelijk aan het maximum aantal waarden van een kenmerk). */
const MAX_GROUP_SIZE = 30;

/**
 * Is dit woord een getal of maat zonder eenheid (16, 1/2", 20x2, Ø32, 2,5)?
 * @param {string} word Eén woord uit de omschrijving.
 * @returns {boolean} true als het een maat lijkt.
 */
function isMeasureWord(word) {
  return /^[ø⌀]?\d+([.,/x×]\d+)*(["”″']|mm|cm|m|l|ltr|kg|g|bar|v|w|inch)?$/i.test(word);
}

/**
 * Splitst een omschrijving in de vaste basis en het deel dat per artikel verschilt.
 * Een maat is een getal (met eventueel een eenheid erachter, ook los: "16 mm");
 * bij een artikel zonder maat telt een kleur.
 * @param {string} name De omschrijving van het artikel.
 * @returns {{ kind: 'Maat'|'Kleur', base: string, baseKey: string, value: string }|null} Het kenmerk, de basis (met hoofdletters zoals ingevoerd), dezelfde basis in kleine letters en de waarde; null als er geen maat of kleur in staat of er niets overblijft.
 */
function splitName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const measure = [];
  const rest = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const next = words[index + 1] ? words[index + 1].toLowerCase() : '';
    if (isMeasureWord(word)) {
      // "16 mm": het getal en de eenheid erachter horen bij elkaar.
      if (/^[ø⌀]?\d+([.,/x×]\d+)*$/.test(word) && MEASURE_UNITS.has(next)) { measure.push(`${word} ${words[index + 1]}`); index++; } else measure.push(word);
    } else rest.push(word);
  }
  if (measure.length && rest.length) {
    return { kind: 'Maat', base: rest.join(' '), baseKey: rest.join(' ').toLowerCase(), value: measure.join(' ') };
  }
  const colours = words.filter((word) => COLOURS.has(word.toLowerCase()));
  const others = words.filter((word) => !COLOURS.has(word.toLowerCase()));
  if (colours.length === 1 && others.length) {
    return { kind: 'Kleur', base: others.join(' '), baseKey: others.join(' ').toLowerCase(), value: colours[0].charAt(0).toUpperCase() + colours[0].slice(1).toLowerCase() };
  }
  return null;
}

/**
 * Het gemeenschappelijke begin van artikelcodes, zonder scheidingstekens aan het eind.
 * @param {string[]} codes De codes.
 * @returns {string} Bijv. 'PE-BUIS' voor PE-BUIS-16 en PE-BUIS-20; leeg als er geen is van minstens 2 tekens.
 */
function commonCodePrefix(codes) {
  if (!codes.length) return '';
  let prefix = codes[0];
  for (const code of codes) {
    let length = 0;
    while (length < prefix.length && length < code.length && prefix[length] === code[length]) length++;
    prefix = prefix.slice(0, length);
  }
  prefix = prefix.replace(/[-_. /+]+$/, '');
  return prefix.length >= 2 ? prefix : '';
}

/**
 * Een stukje artikelcode uit een omschrijving: hoofdletters en cijfers, met streepjes.
 * @param {string} text De omschrijving.
 * @returns {string} Bijv. 'PE-BUIS'.
 */
const codeFromName = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

/**
 * Natuurlijk sorteren van maten (16 mm vóór 110 mm).
 * @param {string} left Eerste waarde.
 * @param {string} right Tweede waarde.
 * @returns {number} Sorteervolgorde.
 */
const compareValues = (left, right) => left.localeCompare(right, 'nl', { numeric: true, sensitivity: 'base' });

/**
 * Zoekt groepen losse artikelen die samen één variabel artikel kunnen worden:
 * zelfde omschrijving op de maat (of kleur) na, en dezelfde eenheid, btw en omzetgroep
 * (varianten volgen die van het hoofdartikel). Artikelen waarvan de maat dubbel voorkomt
 * of die niet mee kunnen vallen buiten het voorstel.
 * @param {{ id: string, code: string, name: string, unit: string, vatRate: number, revenueGroup: string }[]} items De losse, actieve artikelen.
 * @param {Set<string>} takenCodes Alle artikelcodes in de omgeving (voor een vrije voorgestelde code).
 * @returns {{ attributeName: string, name: string, code: string, items: { id: string, code: string, name: string, value: string }[] }[]} De voorstellen, grootste eerst.
 */
function suggestGroups(items, takenCodes = new Set()) {
  const buckets = new Map();
  for (const item of items) {
    const split = splitName(item.name);
    if (!split) continue;
    const key = [split.kind, item.unit, item.vatRate, item.revenueGroup, split.baseKey].join('|');
    if (!buckets.has(key)) buckets.set(key, { split, members: [] });
    buckets.get(key).members.push({ item, value: split.value });
  }
  const groups = [];
  for (const { split, members } of buckets.values()) {
    // Dubbele waarden (twee artikelen "PE-buis 16 mm") kunnen niet allebei een variant worden.
    const counts = new Map();
    for (const member of members) counts.set(member.value.toLowerCase(), (counts.get(member.value.toLowerCase()) || 0) + 1);
    const usable = members.filter((member) => counts.get(member.value.toLowerCase()) === 1).slice(0, MAX_GROUP_SIZE);
    if (usable.length < 2) continue;
    usable.sort((left, right) => compareValues(left.value, right.value));
    const base = codeFromName(split.base);
    const wanted = commonCodePrefix(usable.map((member) => member.item.code)) || base || 'HOOFDARTIKEL';
    let code = wanted;
    for (let suffix = 2; takenCodes.has(code); suffix++) code = `${wanted}-${suffix}`;
    groups.push({
      attributeName: split.kind,
      name: split.base,
      code,
      items: usable.map((member) => ({ id: member.item.id, code: member.item.code, name: member.item.name, value: member.value })),
    });
  }
  groups.sort((left, right) => right.items.length - left.items.length || left.name.localeCompare(right.name, 'nl'));
  return groups.slice(0, MAX_GROUPS);
}

module.exports = { suggestGroups, splitName, commonCodePrefix, MAX_GROUP_SIZE };
