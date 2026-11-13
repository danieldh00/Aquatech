// QR-code maken zonder bibliotheek (UMD: browser `window.QrCode`, server/tests via require), voor het
// aanzetten van tweestapsverificatie op het profiel: de authenticator-app leest het otpauth://-adres
// in. Alleen wat daarvoor nodig is: bytemodus, foutcorrectie M, versie 1 t/m 10 (tot 213 bytes),
// automatische keuze van het masker (strafpunten volgens ISO/IEC 18004).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QrCode = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  /** Per versie (1-10) bij foutcorrectie M: codewoorden foutcorrectie per blok en de blokken [aantal, datacodewoorden]. */
  const BLOCKS_M = [
    null,
    { ecc: 10, groups: [[1, 16]] }, { ecc: 16, groups: [[1, 28]] }, { ecc: 26, groups: [[1, 44]] }, { ecc: 18, groups: [[2, 32]] },
    { ecc: 24, groups: [[2, 43]] }, { ecc: 16, groups: [[4, 27]] }, { ecc: 18, groups: [[4, 31]] }, { ecc: 22, groups: [[2, 38], [2, 39]] },
    { ecc: 22, groups: [[3, 36], [2, 37]] }, { ecc: 26, groups: [[4, 43], [1, 44]] },
  ];
  /** Plaats van de uitlijnpatronen per versie. */
  const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // Rekenen in GF(256) met het veelterm 0x11d, voor Reed-Solomon.
  const EXP = new Array(512);
  const LOG = new Array(256);
  {
    let value = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = value;
      LOG[value] = i;
      value <<= 1;
      if (value & 256) value ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  }

  /**
   * Vermenigvuldigt twee getallen in GF(256).
   * @param {number} left Het eerste getal.
   * @param {number} right Het tweede getal.
   * @returns {number} Het product.
   */
  const multiply = (left, right) => (left && right ? EXP[LOG[left] + LOG[right]] : 0);

  /**
   * De codewoorden foutcorrectie (Reed-Solomon) bij een blok data.
   * @param {number[]} data De datacodewoorden.
   * @param {number} count Aantal codewoorden foutcorrectie.
   * @returns {number[]} De codewoorden foutcorrectie.
   */
  function errorCorrection(data, count) {
    let generator = [1];
    for (let i = 0; i < count; i++) {
      const next = new Array(generator.length + 1).fill(0);
      generator.forEach((coefficient, index) => {
        next[index] ^= coefficient;
        next[index + 1] ^= multiply(coefficient, EXP[i]);
      });
      generator = next;
    }
    const remainder = [...data, ...new Array(count).fill(0)];
    for (let i = 0; i < data.length; i++) {
      const factor = remainder[i];
      if (!factor) continue;
      generator.forEach((coefficient, index) => { remainder[i + index] ^= multiply(coefficient, factor); });
    }
    return remainder.slice(data.length);
  }

  /**
   * De rest van een BCH-code (voor de formaat- en versie-informatie).
   * @param {number} value De gegevensbits, al naar links geschoven.
   * @param {number} poly Het genererende veelterm.
   * @returns {number} De rest.
   */
  function bchRemainder(value, poly) {
    const polyBits = Math.floor(Math.log2(poly));
    let rest = value;
    while (rest && Math.floor(Math.log2(rest)) >= polyBits) rest ^= poly << (Math.floor(Math.log2(rest)) - polyBits);
    return rest;
  }

  /**
   * Zet tekst om naar de reeks codewoorden (data + foutcorrectie, door elkaar gevlochten) voor een versie.
   * @param {number[]} bytes De tekst als UTF-8-bytes.
   * @param {number} version De versie (1-10).
   * @returns {number[]} Alle codewoorden in de volgorde waarin ze in de code komen.
   */
  function codewords(bytes, version) {
    const spec = BLOCKS_M[version];
    const dataCount = spec.groups.reduce((sum, [count, size]) => sum + count * size, 0);
    const bits = [];
    /**
     * Voegt een getal toe als een aantal bits.
     * @param {number} value Het getal.
     * @param {number} length Aantal bits.
     * @returns {void}
     */
    const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(4, 4);
    push(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach((byte) => push(byte, 8));
    push(0, Math.min(4, dataCount * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((sum, bit) => (sum << 1) | bit, 0));
    for (let pad = 0; data.length < dataCount; pad++) data.push(pad % 2 ? 0x11 : 0xec);
    const blocks = [];
    let offset = 0;
    for (const [count, size] of spec.groups) {
      for (let i = 0; i < count; i++) {
        const block = data.slice(offset, offset + size);
        offset += size;
        blocks.push({ data: block, ecc: errorCorrection(block, spec.ecc) });
      }
    }
    const out = [];
    const longest = Math.max(...blocks.map((block) => block.data.length));
    for (let i = 0; i < longest; i++) blocks.forEach((block) => { if (i < block.data.length) out.push(block.data[i]); });
    for (let i = 0; i < spec.ecc; i++) blocks.forEach((block) => out.push(block.ecc[i]));
    return out;
  }

  /** De acht maskers: of een module op rij/kolom wordt omgedraaid. */
  const MASKS = [
    (row, column) => (row + column) % 2 === 0,
    (row) => row % 2 === 0,
    (row, column) => column % 3 === 0,
    (row, column) => (row + column) % 3 === 0,
    (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
    (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
    (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
    (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
  ];

  /**
   * Bouwt de matrix voor een versie en masker.
   * @param {number[]} words De codewoorden (codewords).
   * @param {number} version De versie.
   * @param {number} mask Het masker (0-7).
   * @returns {boolean[][]} De modules (true = donker).
   */
  function build(words, version, mask) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    /**
     * Zet een vaste module.
     * @param {number} row De rij.
     * @param {number} column De kolom.
     * @param {boolean} dark Donker of licht.
     * @returns {void}
     */
    const set = (row, column, dark) => { modules[row][column] = dark; fixed[row][column] = true; };
    for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let row = -1; row <= 7; row++) {
        for (let column = -1; column <= 7; column++) {
          const y = top + row;
          const x = left + column;
          if (y < 0 || x < 0 || y >= size || x >= size) continue;
          const ring = Math.max(Math.abs(row - 3), Math.abs(column - 3));
          set(y, x, ring !== 2 && ring !== 4);
        }
      }
    }
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const centers = ALIGNMENT[version];
    const last = centers.length - 1;
    centers.forEach((y, rowIndex) => {
      centers.forEach((x, columnIndex) => {
        // Niet op de drie zoekers in de hoeken.
        if ((rowIndex === 0 && (columnIndex === 0 || columnIndex === last)) || (rowIndex === last && columnIndex === 0)) return;
        for (let row = -2; row <= 2; row++) for (let column = -2; column <= 2; column++) set(y + row, x + column, Math.max(Math.abs(row), Math.abs(column)) !== 1);
      });
    });
    // Formaatinformatie: foutcorrectie M (00) en het masker, met BCH-code en het vaste XOR-patroon.
    const format = ((mask << 10) | bchRemainder(mask << 10, 0x537)) ^ 0x5412;
    for (let i = 0; i < 15; i++) {
      const bit = ((format >>> i) & 1) === 1;
      // Eerste kopie rond de zoeker linksboven, tweede verdeeld over rechtsboven en linksonder.
      if (i < 6) set(i, 8, bit); else if (i < 8) set(i + 1, 8, bit); else if (i === 8) set(8, 7, bit); else set(8, 14 - i, bit);
      if (i < 8) set(8, size - 1 - i, bit); else set(size - 15 + i, 8, bit);
    }
    set(size - 8, 8, true);
    if (version >= 7) {
      const info = (version << 12) | bchRemainder(version << 12, 0x1f25);
      for (let i = 0; i < 18; i++) {
        const bit = ((info >>> i) & 1) === 1;
        set(Math.floor(i / 3), size - 11 + (i % 3), bit);
        set(size - 11 + (i % 3), Math.floor(i / 3), bit);
      }
    }
    // De data in zigzag van rechtsonder, twee kolommen tegelijk, over de vaste modules heen.
    let bitIndex = 0;
    const totalBits = words.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical++) {
        for (let side = 0; side < 2; side++) {
          const column = right - side;
          const upward = ((right + 1) & 2) === 0;
          const row = upward ? size - 1 - vertical : vertical;
          if (fixed[row][column]) continue;
          let dark = false;
          if (bitIndex < totalBits) dark = ((words[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex += 1;
          modules[row][column] = MASKS[mask](row, column) ? !dark : dark;
        }
      }
    }
    return modules;
  }

  /**
   * Strafpunten van een matrix (lagere score = beter leesbaar), volgens de vier regels van de norm.
   * @param {boolean[][]} modules De matrix.
   * @returns {number} De score.
   */
  function penalty(modules) {
    const size = modules.length;
    let score = 0;
    /**
     * Regel 1 en 3 op één rij of kolom: reeksen van vijf of meer en het patroon van een zoeker.
     * @param {boolean[]} line De modules.
     * @returns {number} De strafpunten.
     */
    const lineScore = (line) => {
      let points = 0;
      let run = 1;
      for (let i = 1; i <= line.length; i++) {
        if (i < line.length && line[i] === line[i - 1]) run += 1;
        else { if (run >= 5) points += run - 2; run = 1; }
      }
      const text = line.map((dark) => (dark ? '1' : '0')).join('');
      for (const pattern of ['10111010000', '00001011101']) {
        for (let index = text.indexOf(pattern); index >= 0; index = text.indexOf(pattern, index + 1)) points += 40;
      }
      return points;
    };
    for (let i = 0; i < size; i++) {
      score += lineScore(modules[i]);
      score += lineScore(modules.map((row) => row[i]));
    }
    let dark = 0;
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        if (modules[row][column]) dark += 1;
        if (row < size - 1 && column < size - 1) {
          const value = modules[row][column];
          if (modules[row][column + 1] === value && modules[row + 1][column] === value && modules[row + 1][column + 1] === value) score += 3;
        }
      }
    }
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
  }

  /**
   * De kleinste versie waarin de tekst past.
   * @param {number} length Aantal bytes.
   * @returns {number} De versie (1-10).
   */
  function versionFor(length) {
    for (let version = 1; version <= 10; version++) {
      const capacity = BLOCKS_M[version].groups.reduce((sum, [count, size]) => sum + count * size, 0);
      if (4 + (version < 10 ? 8 : 16) + length * 8 <= capacity * 8) return version;
    }
    throw new Error('Te lange tekst voor een QR-code.');
  }

  /**
   * De QR-code van een tekst als matrix.
   * @param {string} text De tekst (UTF-8).
   * @param {{ mask?: number }} [options] mask = een vast masker (tests); standaard het beste.
   * @returns {boolean[][]} De modules (true = donker), zonder stille zone.
   */
  function matrix(text, { mask } = {}) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    const version = versionFor(bytes.length);
    const words = codewords(bytes, version);
    if (Number.isInteger(mask)) return build(words, version, mask);
    let best = null;
    let bestScore = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      const modules = build(words, version, candidate);
      const score = penalty(modules);
      if (score < bestScore) { best = modules; bestScore = score; }
    }
    return best;
  }

  /**
   * De QR-code als SVG (zwart op wit, met een stille zone van vier modules).
   * @param {string} text De tekst.
   * @param {{ label?: string }} [options] label = de toegankelijke naam van de afbeelding.
   * @returns {string} De SVG-tekst.
   */
  function svg(text, { label = 'QR-code' } = {}) {
    const modules = matrix(text);
    const size = modules.length + 8;
    let path = '';
    modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`; }));
    const name = String(label).replace(/[<>&"]/g, '');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${name}"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }

  return { matrix, svg, versionFor };
}));
