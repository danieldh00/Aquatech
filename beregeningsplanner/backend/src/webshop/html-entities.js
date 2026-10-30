// Leest HTML-tekens (&amp;, &#8243;, &eacute; ...) in namen die WooCommerce
// als HTML teruggeeft, zodat ze als gewone tekst worden opgeslagen en getoond.

/** Benoemde tekens die in productnamen en categorieën voorkomen. */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  euro: '€', deg: '°', plusmn: '±', times: '×', frac12: '½', micro: 'µ', sup2: '²', sup3: '³',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', prime: '′', Prime: '″',
  eacute: 'é', egrave: 'è', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', auml: 'ä', ecirc: 'ê',
};

/**
 * Zet HTML-tekens in een tekst om naar gewone tekens (één keer, niet herhaald).
 * @param {*} text De tekst, bijv. "Leidingen &amp; Slangen" of "4&#8243; pomp".
 * @returns {string} De tekst met echte tekens; onbekende tekens blijven staan zoals ze zijn.
 */
function decodeHtmlEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, name) => {
    if (name[0] === '#') {
      const codePoint = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : match;
  });
}

module.exports = { decodeHtmlEntities };
