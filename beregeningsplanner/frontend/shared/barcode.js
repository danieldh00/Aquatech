// Streepjescodes voor etiketten: EAN-13/EAN-8 (artikelnummer van de fabrikant) en Code 128 (eigen artikelcode).
// Zuivere functies zonder afhankelijkheden (UMD): de server tekent er de etiketten-PDF mee (artikelen/labels.js) en de
// browser kan een voorbeeld tonen. Een code wordt een reeks modules (1 = zwart, 0 = wit); `bars` maakt daar balken van.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Barcode = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  /** Linkse cijfers met oneven pariteit (set A van EAN). */
  const EAN_LEFT_ODD = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  /** Rechtse cijfers (set C): het omgekeerde van de linkse set. */
  const EAN_RIGHT = EAN_LEFT_ODD.map((pattern) => pattern.replace(/./g, (bit) => (bit === '1' ? '0' : '1')));
  /** Linkse cijfers met even pariteit (set B): de rechtse set in spiegelbeeld. */
  const EAN_LEFT_EVEN = EAN_RIGHT.map((pattern) => pattern.split('').reverse().join(''));
  /** Welke pariteit de zes linkse cijfers van een EAN-13 krijgen, per eerste cijfer (O = oneven, E = even). */
  const EAN13_PARITY = ['OOOOOO', 'OOEOEE', 'OOEEOE', 'OOEEEO', 'OEOOEE', 'OEEOOE', 'OEEEOO', 'OEOEOE', 'OEOEEO', 'OEEOEO'];

  /** Code 128: per waarde (0-106) de breedtes van balk, ruimte, balk, ruimte, balk, ruimte (stop: zeven breedtes). */
  const CODE128 = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
  ];
  /** Bijzondere waarden van Code 128. */
  const START_B = 104;
  const START_C = 105;
  const CODE_B = 100;
  const CODE_C = 99;
  const STOP = 106;
  /** Hoogstens zoveel tekens in een Code 128 op een etiket (langer wordt onleesbaar smal). */
  const CODE128_MAX = 40;

  /**
   * Het controlecijfer van een EAN (GTIN): de cijfers van rechts af om en om ×3 en ×1, aangevuld tot een tiental.
   * @param {string} digits De cijfers zonder controlecijfer (7 voor EAN-8, 12 voor EAN-13).
   * @returns {number} Het controlecijfer.
   */
  function eanCheckDigit(digits) {
    let sum = 0;
    const reversed = String(digits).split('').reverse();
    reversed.forEach((digit, index) => { sum += Number(digit) * (index % 2 === 0 ? 3 : 1); });
    return (10 - (sum % 10)) % 10;
  }

  /**
   * Maakt een ingevoerde EAN schoon: spaties en streepjes eruit, alleen 8 of 13 cijfers met een kloppend controlecijfer.
   * Een UPC-A (12 cijfers) wordt een EAN-13 met een 0 ervoor.
   * @param {*} value De invoer.
   * @returns {string|null} De EAN, of null als hij ongeldig is.
   */
  function cleanEan(value) {
    let digits = String(value == null ? '' : value).replace(/[\s-]/g, '');
    if (!/^\d+$/.test(digits)) return null;
    if (digits.length === 12) digits = `0${digits}`;
    if (digits.length !== 8 && digits.length !== 13) return null;
    return eanCheckDigit(digits.slice(0, -1)) === Number(digits.slice(-1)) ? digits : null;
  }

  /**
   * De modules van een EAN-13 of EAN-8 (zonder witruimte eromheen).
   * @param {string} ean Een geldige EAN (cleanEan).
   * @returns {string} De modules (95 bij EAN-13, 67 bij EAN-8).
   */
  function encodeEan(ean) {
    const digits = ean.split('').map(Number);
    if (digits.length === 8) {
      return `101${digits.slice(0, 4).map((digit) => EAN_LEFT_ODD[digit]).join('')}01010${digits.slice(4).map((digit) => EAN_RIGHT[digit]).join('')}101`;
    }
    const parity = EAN13_PARITY[digits[0]];
    const left = digits.slice(1, 7).map((digit, index) => (parity[index] === 'O' ? EAN_LEFT_ODD : EAN_LEFT_EVEN)[digit]).join('');
    const right = digits.slice(7).map((digit) => EAN_RIGHT[digit]).join('');
    return `101${left}01010${right}101`;
  }

  /**
   * Of tekst als Code 128 kan (alleen gewone tekens 32-126, niet te lang).
   * @param {*} text De tekst.
   * @returns {boolean} true als het kan.
   */
  const code128Fits = (text) => typeof text === 'string' && text.length > 0 && text.length <= CODE128_MAX && /^[\x20-\x7e]+$/.test(text);

  /**
   * De waarden (0-106) van een Code 128 inclusief start, controle en stop. Reeksen van vier of meer cijfers gaan in set C
   * (twee cijfers per teken, korter), de rest in set B.
   * @param {string} text De tekst (code128Fits).
   * @returns {number[]} De waarden.
   */
  function code128Values(text) {
    const values = [];
    let set = null;
    let index = 0;
    /**
     * Hoeveel cijfers er vanaf een positie achter elkaar staan.
     * @param {number} from De positie.
     * @returns {number} Het aantal cijfers.
     */
    const digitRun = (from) => { let end = from; while (end < text.length && text[end] >= '0' && text[end] <= '9') end += 1; return end - from; };
    while (index < text.length) {
      const run = digitRun(index);
      const useC = run >= 4 || (set === 'C' && run >= 2);
      if (useC) {
        if (set !== 'C') values.push(set === null ? START_C : CODE_C);
        set = 'C';
        const pairs = Math.floor(run / 2);
        for (let pair = 0; pair < pairs; pair += 1) { values.push(Number(text.slice(index, index + 2))); index += 2; }
      } else {
        if (set !== 'B') values.push(set === null ? START_B : CODE_B);
        set = 'B';
        values.push(text.charCodeAt(index) - 32);
        index += 1;
      }
    }
    const check = values.reduce((sum, value, position) => sum + value * (position === 0 ? 1 : position), 0) % 103;
    values.push(check, STOP);
    return values;
  }

  /**
   * De modules van een Code 128 (zonder witruimte eromheen).
   * @param {string} text De tekst (code128Fits).
   * @returns {string} De modules.
   */
  function encodeCode128(text) {
    return code128Values(text).map((value) => CODE128[value].split('').map((width, position) => (position % 2 === 0 ? '1' : '0').repeat(Number(width))).join('')).join('');
  }

  /**
   * Kiest de streepjescode voor een artikel: de EAN als die geldig is, anders de eigen artikelcode als Code 128.
   * @param {{ ean?: string, code?: string }} item Het artikel.
   * @param {string} [prefer] 'auto' (standaard: EAN, anders de code), 'ean' (alleen een EAN) of 'code128' (altijd de code).
   * @returns {{ type: string, text: string, modules: string }|null} De code, of null als er niets te coderen valt.
   */
  function forItem(item, prefer = 'auto') {
    const ean = cleanEan(item && item.ean);
    const code = String((item && item.code) || '').trim();
    if (prefer !== 'code128' && ean) return { type: ean.length === 8 ? 'ean8' : 'ean13', text: ean, modules: encodeEan(ean) };
    if (prefer !== 'ean' && code128Fits(code)) return { type: 'code128', text: code, modules: encodeCode128(code) };
    return null;
  }

  /**
   * Zet modules om in balken (voor tekenen): beginpositie en breedte in modules.
   * @param {string} modules De modules (1 = zwart).
   * @returns {{ start: number, width: number }[]} De zwarte balken.
   */
  function bars(modules) {
    const out = [];
    let start = -1;
    for (let index = 0; index <= modules.length; index += 1) {
      if (modules[index] === '1') { if (start < 0) start = index; } else if (start >= 0) { out.push({ start, width: index - start }); start = -1; }
    }
    return out;
  }

  return { eanCheckDigit, cleanEan, encodeEan, code128Fits, code128Values, encodeCode128, forItem, bars, CODE128_MAX };
}));
