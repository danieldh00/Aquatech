// Omschrijving en specificaties van een artikel (12 uit de audit van 1.7.3): kolommen
// stock_items.description (platte tekst, alinea's met een lege regel) en stock_items.specifications
// (JSON [{ name, value }]), migratie 50. Zolang een artikel er zelf geen heeft, toont de shop die van het
// gekoppelde webshopproduct (shop_products.description en de zichtbare kenmerken die niet voor
// variaties zijn). Alles zuivere functies, zodat de shop, de feed en de artikel-API ze delen.

/** Hoogstens zoveel tekens omschrijving. */
const MAX_DESCRIPTION = 5000;
/** Hoogstens zoveel specificaties per artikel. */
const MAX_SPECIFICATIONS = 30;

/**
 * Schoont een omschrijving op: platte tekst, regeleinden blijven, andere stuurtekens en meer dan één lege regel niet.
 * @param {*} raw De invoer.
 * @returns {string} De omschrijving (hoogstens MAX_DESCRIPTION tekens).
 */
function sanitizeDescription(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .split('\n').map((line) => line.replace(/ {2,}/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_DESCRIPTION);
}

/**
 * Schoont specificaties op. Neemt een lijst [{ name, value }] of tekst met per regel "Naam: waarde".
 * @param {*} raw De invoer.
 * @returns {{ name: string, value: string }[]} Hoogstens MAX_SPECIFICATIONS specificaties met naam en waarde.
 */
function sanitizeSpecifications(raw) {
  /**
   * Eén regel tekst zonder stuurtekens en dubbele spaties.
   * @param {*} value De invoer.
   * @param {number} maxLength Hoogstens zoveel tekens.
   * @returns {string} De opgeschoonde tekst.
   */
  const clean = (value, maxLength) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, maxLength);
  let entries = [];
  if (Array.isArray(raw)) entries = raw.map((entry) => (entry && typeof entry === 'object' ? { name: entry.name, value: entry.value } : {}));
  else if (typeof raw === 'string') {
    entries = raw.split(/\r?\n/).map((line) => {
      const colon = line.indexOf(':');
      return colon > 0 ? { name: line.slice(0, colon), value: line.slice(colon + 1) } : { name: '', value: '' };
    });
  }
  return entries.map((entry) => ({ name: clean(entry.name, 60), value: clean(entry.value, 200) }))
    .filter((entry) => entry.name && entry.value)
    .slice(0, MAX_SPECIFICATIONS);
}

/**
 * Leest de specificaties uit de opgeslagen JSON.
 * @param {*} json De kolom specifications.
 * @returns {{ name: string, value: string }[]} De specificaties (leeg bij onleesbare invoer).
 */
function specificationsOf(json) {
  try { return sanitizeSpecifications(JSON.parse(json || '[]')); } catch { return []; }
}

/**
 * Vertaalt de HTML-entiteiten die WordPress in teksten zet.
 * @param {string} text De tekst.
 * @returns {string} De tekst met gewone tekens.
 */
function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', deg: '°', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', times: '×', sup2: '²', sup3: '³', frac12: '½' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const number = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(number) && number > 0 && number < 0x110000 ? String.fromCodePoint(number) : '';
    }
    return named[code.toLowerCase()] ?? whole;
  });
}

/**
 * Zet de HTML van een webshopomschrijving om naar platte tekst: alinea's en lijstregels op een eigen regel,
 * geen tags, scripts of stijlen.
 * @param {*} html De HTML uit de webshop.
 * @returns {string} De omschrijving als platte tekst (opgeschoond met sanitizeDescription).
 */
function plainTextFromHtml(html) {
  const text = String(html ?? '')
    .slice(0, MAX_DESCRIPTION * 4)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|table|tr)>/gi, '\n\n')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return sanitizeDescription(decodeEntities(text).replace(/[ \t]+\n/g, '\n'));
}

/**
 * De specificaties van een webshopproduct: de zichtbare kenmerken die niet voor variaties zijn.
 * @param {*} attributesJson De kolom shop_products.attributes ([{ name, visible, variation, options }]).
 * @returns {{ name: string, value: string }[]} De specificaties.
 */
function specificationsFromShop(attributesJson) {
  let attributes;
  try { attributes = JSON.parse(attributesJson || '[]'); } catch { return []; }
  if (!Array.isArray(attributes)) return [];
  return sanitizeSpecifications(attributes
    .filter((attribute) => attribute && attribute.visible !== false && !attribute.variation)
    .map((attribute) => ({ name: decodeEntities(String(attribute.name || '')), value: (attribute.options || []).map((option) => decodeEntities(String(option))).join(', ') })));
}

/**
 * Kiest wat de shop toont: de eigen omschrijving en specificaties van het artikel, anders die van het
 * webshopproduct, anders die van het hoofdartikel (bij een variant).
 * @param {{ description?: string, specifications?: string, shop_description?: string, shop_attributes?: string }} row De rij van het artikel (met de kolommen van het webshopproduct).
 * @param {{ description: string, specifications: object[] }|null} [parent] Wat het hoofdartikel toont (bij een variant).
 * @returns {{ description: string, specifications: { name: string, value: string }[] }} De omschrijving en specificaties.
 */
function shownDetails(row, parent = null) {
  const own = sanitizeDescription(row.description);
  const shop = plainTextFromHtml(row.shop_description);
  const ownSpecs = specificationsOf(row.specifications);
  const shopSpecs = specificationsFromShop(row.shop_attributes);
  return {
    description: own || shop || (parent ? parent.description : ''),
    specifications: ownSpecs.length ? ownSpecs : shopSpecs.length ? shopSpecs : parent ? parent.specifications : [],
  };
}

module.exports = { sanitizeDescription, sanitizeSpecifications, specificationsOf, plainTextFromHtml, specificationsFromShop, shownDetails, MAX_DESCRIPTION, MAX_SPECIFICATIONS };
