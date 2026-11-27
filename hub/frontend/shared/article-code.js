// Sprekende artikelcodes: MERK.SOORT.DIAMETER.DRAADMAAT (bijvoorbeeld UD.KBI.20.12) of zonder merk SOORT.DIAMETER.DRAADMAAT (KBI.20.12).
// Zuivere functies zonder afhankelijkheden (UMD): de server bouwt en controleert er codes mee (artikelen/code-groups.js) en de
// browser toont het voorstel. De draadmaat is BSP in duimen als cijfers (½" = 12, ¾" = 34, 1" = 1, 1¼" = 114, 1½" = 112, 2" = 2);
// een metrische maat is het getal zelf. Diameter en draadmaat staan alleen in de naam en in de code, nooit in een eigen kolom:
// de volgorde van subartikelen (klein naar groot) wordt uit de code gelezen.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArticleCode = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  /** Draadmaten in duimen (BSP): de code, de waarde in duimen en hoe ze worden getoond. */
  const BSP_SIZES = [
    { code: '18', inches: 0.125, label: '1/8"' },
    { code: '14', inches: 0.25, label: '1/4"' },
    { code: '38', inches: 0.375, label: '3/8"' },
    { code: '12', inches: 0.5, label: '1/2"' },
    { code: '34', inches: 0.75, label: '3/4"' },
    { code: '1', inches: 1, label: '1"' },
    { code: '114', inches: 1.25, label: '1 1/4"' },
    { code: '112', inches: 1.5, label: '1 1/2"' },
    { code: '2', inches: 2, label: '2"' },
    { code: '212', inches: 2.5, label: '2 1/2"' },
    { code: '3', inches: 3, label: '3"' },
    { code: '4', inches: 4, label: '4"' },
  ];
  /** Een merk- of soortcode: begint met een letter, hoofdletters en cijfers, hoogstens 8 tekens. */
  const GROUP_CODE_PATTERN = /^[A-Z][A-Z0-9]{0,7}$/;
  /** Een soortdeel van een code: de soortcode, eventueel met een volgnummer (KBI-2) voor een tweede artikelgroep van dezelfde soort. */
  const KIND_PART_PATTERN = /^[A-Z][A-Z0-9]{0,7}(-[0-9]{1,2})?$/;
  /** Breuktekens die mensen intikken. */
  const FRACTIONS = { '⅛': '1/8', '¼': '1/4', '⅜': '3/8', '½': '1/2', '¾': '3/4' };

  /**
   * Maakt een merk- of soortcode schoon: hoofdletters, alleen letters en cijfers.
   * @param {*} value De invoer.
   * @returns {string} De schone code (leeg als er niets overblijft).
   */
  function cleanGroupCode(value) {
    return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  }

  /**
   * Is dit een geldige merk- of soortcode?
   * @param {*} value De code.
   * @returns {boolean} true als hij aan het patroon voldoet.
   */
  function isGroupCode(value) {
    return GROUP_CODE_PATTERN.test(String(value == null ? '' : value));
  }

  /**
   * Zet een draadmaat zoals mensen hem schrijven om naar de code: 3/4", ¾, 1 1/4" en 1¼ worden 34 en 114.
   * Alleen cijfers worden als code gelezen (34 blijft 34, een metrische maat blijft het getal).
   * @param {*} input De draadmaat (leeg = geen draadmaat).
   * @returns {{ code: string }|{ error: string }} De code (leeg bij geen draadmaat), of een fout.
   */
  function threadCode(input) {
    let text = String(input == null ? '' : input).trim();
    if (!text) return { code: '' };
    if (/^[0-9]{1,3}$/.test(text)) return { code: text };
    text = text.replace(/[⅛¼⅜½¾]/g, (sign) => ` ${FRACTIONS[sign]}`).replace(/["”″]|inch|duim|bsp|g\b/gi, '').replace(/\s+/g, ' ').trim();
    const match = /^(?:([0-9]+)\s+)?([0-9]+)\/([0-9]+)$/.exec(text) || /^([0-9]+)()()$/.exec(text);
    if (!match) return { error: `De draadmaat "${String(input).trim().slice(0, 20)}" is niet te lezen; schrijf bijvoorbeeld 3/4" of 1 1/4".` };
    const whole = match[3] ? Number(match[1] || 0) : Number(match[1]);
    const inches = match[3] ? whole + Number(match[2]) / Number(match[3]) : whole;
    const known = BSP_SIZES.find((size) => size.inches === inches);
    if (!known) return { error: `De draadmaat ${text}" kent geen vaste code; kies een gangbare BSP-maat of tik de code in cijfers.` };
    return { code: known.code };
  }

  /**
   * De draadmaat van een code, leesbaar: 34 wordt 3/4", een onbekende code blijft het getal.
   * @param {string} code De draadmaatcode.
   * @returns {string} De weergave (leeg bij geen code).
   */
  function threadLabel(code) {
    const known = BSP_SIZES.find((size) => size.code === String(code));
    return known ? known.label : String(code || '');
  }

  /**
   * De waarde waarop draadmaten worden gesorteerd: duimen voor een bekende BSP-code (112 = 1,5), anders het getal zelf.
   * @param {string} code De draadmaatcode.
   * @returns {number} De sorteerwaarde (0 bij geen code).
   */
  function threadSortValue(code) {
    const known = BSP_SIZES.find((size) => size.code === String(code));
    return known ? known.inches : Number(code) || 0;
  }

  /**
   * Bouwt een artikelcode uit de delen. Lege delen vallen weg (zonder merk is het MERK-deel er niet).
   * @param {{ brand?: string, kind: string, diameter?: string|number, thread?: string }} parts Merkcode, soortcode, diameter in mm en draadmaatcode.
   * @returns {{ code: string }|{ error: string }} De code, of een fout.
   */
  function buildCode({ brand = '', kind, diameter = '', thread = '' } = {}) {
    const brandPart = String(brand || '');
    const kindPart = String(kind || '');
    if (brandPart && !isGroupCode(brandPart)) return { error: 'De merkcode bestaat uit hoofdletters en cijfers en begint met een letter.' };
    if (!KIND_PART_PATTERN.test(kindPart)) return { error: 'De soortcode bestaat uit hoofdletters en cijfers en begint met een letter.' };
    const diameterPart = String(diameter == null ? '' : diameter).trim();
    if (diameterPart && !/^[0-9]{1,4}$/.test(diameterPart)) return { error: 'De diameter is een heel getal in mm.' };
    const threadPart = String(thread || '');
    if (threadPart && !/^[0-9]{1,3}$/.test(threadPart)) return { error: 'De draadmaat is een code in cijfers.' };
    if (threadPart && !diameterPart) return { error: 'Een draadmaat hoort bij een diameter; vul de diameter in.' };
    return { code: [brandPart, kindPart, diameterPart, threadPart].filter(Boolean).join('.') };
  }

  /**
   * Leest een sprekende code terug in zijn delen. Een code die er niet uitziet als MERK.SOORT.DIAMETER.DRAADMAAT geeft null.
   * Eerst de letterdelen (één = soort, twee = merk en soort), dan hoogstens twee cijferdelen (diameter en draadmaat).
   * @param {string} code De artikelcode.
   * @returns {{ brand: string, kind: string, diameter: string, thread: string }|null} De delen, of null.
   */
  function parseCode(code) {
    const parts = String(code || '').split('.');
    if (parts.length < 1 || parts.length > 4 || parts.some((part) => !part)) return null;
    const letters = [];
    while (parts.length && !/^[0-9]+$/.test(parts[0])) letters.push(parts.shift());
    if (!letters.length || letters.length > 2 || parts.length > 2) return null;
    if (!parts.every((part) => /^[0-9]{1,4}$/.test(part))) return null;
    const [brandOrKind, kindOnly] = letters;
    const brand = letters.length === 2 ? brandOrKind : '';
    const kind = letters.length === 2 ? kindOnly : brandOrKind;
    if ((brand && !isGroupCode(brand)) || !KIND_PART_PATTERN.test(kind)) return null;
    return { brand, kind, diameter: parts[0] || '', thread: parts[1] || '' };
  }

  /**
   * Vergelijkt twee codes voor de volgorde van subartikelen: eerst op diameter, dan op draadmaat (klein naar groot), daarna op de tekst.
   * Een code zonder maten (of een oude code) komt na de codes met maten, in natuurlijke volgorde.
   * @param {string} left De eerste code.
   * @param {string} right De tweede code.
   * @returns {number} Negatief, nul of positief.
   */
  function compareCodes(left, right) {
    const first = parseCode(left);
    const second = parseCode(right);
    if (first && second) {
      const byDiameter = (Number(first.diameter) || 0) - (Number(second.diameter) || 0);
      if (byDiameter) return byDiameter;
      const byThread = threadSortValue(first.thread) - threadSortValue(second.thread);
      if (byThread) return byThread;
    } else if (first || second) {
      return first ? -1 : 1;
    }
    return String(left).localeCompare(String(right), 'nl', { numeric: true });
  }

  return { BSP_SIZES, cleanGroupCode, isGroupCode, threadCode, threadLabel, threadSortValue, buildCode, parseCode, compareCodes };
}));
