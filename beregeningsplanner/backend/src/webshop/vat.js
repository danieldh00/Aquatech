// Btw voor zakelijke klanten in de eigen webshop: het formaat van een Europees
// btw-nummer per land en de vraag of de btw wordt verlegd (levering naar een
// ander EU-land aan een bedrijf met btw-nummer). Zuivere functies; het nummer
// wordt hier alleen op formaat gecontroleerd, niet bij VIES opgezocht.

/** Voorvoegsel van het btw-nummer per landcode (Griekenland gebruikt EL). */
const VAT_PREFIX = { GR: 'EL' };
/** Formaat van het deel na het landvoorvoegsel, per voorvoegsel. */
const VAT_PATTERNS = {
  AT: /^U\d{8}$/, BE: /^[01]\d{9}$/, BG: /^\d{9,10}$/, CY: /^\d{8}[A-Z]$/, CZ: /^\d{8,10}$/, DE: /^\d{9}$/, DK: /^\d{8}$/, EE: /^\d{9}$/,
  EL: /^\d{9}$/, ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^\d{8}$/, FR: /^[A-Z0-9]{2}\d{9}$/, HR: /^\d{11}$/, HU: /^\d{8}$/, IE: /^\d[A-Z0-9+*]\d{5}[A-Z]{1,2}$/,
  IT: /^\d{11}$/, LT: /^(\d{9}|\d{12})$/, LU: /^\d{8}$/, LV: /^\d{11}$/, MT: /^\d{8}$/, NL: /^\d{9}B\d{2}$/, PL: /^\d{10}$/, PT: /^\d{9}$/,
  RO: /^\d{2,10}$/, SE: /^\d{12}$/, SI: /^\d{8}$/, SK: /^\d{10}$/,
};

/**
 * Maakt van een ingevoerd btw-nummer hoofdletters zonder spaties, punten en streepjes.
 * @param {*} raw De invoer.
 * @returns {string} Het genormaliseerde nummer (afgekapt op 40 tekens, zodat een te lang nummer ongeldig blijft), of een lege tekst.
 */
function normalizeVatNumber(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[\s.\-]/g, '').slice(0, 40);
}

/**
 * Controleert het formaat van een btw-nummer (landvoorvoegsel plus nummer).
 * @param {string} vatNumber Het genormaliseerde nummer, bijvoorbeeld BE0123456789.
 * @returns {boolean} true als het formaat bij een EU-land past.
 */
function validVatNumber(vatNumber) {
  const pattern = VAT_PATTERNS[vatNumber.slice(0, 2)];
  return Boolean(pattern) && pattern.test(vatNumber.slice(2));
}

/**
 * Of het btw-nummer bij het land van aflevering hoort.
 * @param {string} vatNumber Het genormaliseerde nummer.
 * @param {string} country Landcode van het afleveradres (ISO, bijvoorbeeld GR voor Griekenland).
 * @returns {boolean} true als het voorvoegsel van het nummer het land is.
 */
function vatNumberFits(vatNumber, country) {
  return vatNumber.slice(0, 2) === (VAT_PREFIX[country] || country);
}

/**
 * Of de btw wordt verlegd: een bedrijf met een geldig btw-nummer van het land van aflevering, in een ander EU-land dan Nederland.
 * @param {{ group: string, method: string, country: string, vatNumber: string }} order Klantgroep, verzendmethode, land en btw-nummer.
 * @returns {boolean} true als de bestelling zonder btw wordt gefactureerd.
 */
function vatShifted({ group, method, country, vatNumber }) {
  if (group !== 'zakelijk' || method !== 'dpd' || country === 'NL') return false;
  return validVatNumber(vatNumber) && vatNumberFits(vatNumber, country);
}

module.exports = { normalizeVatNumber, validVatNumber, vatNumberFits, vatShifted };
