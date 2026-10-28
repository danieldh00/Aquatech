/*
 * Lokale planherkenning, zonder AI-koppeling.
 *  1. Vlakken: elk pixel op kleur indelen (gazon, haag, beplanting, bebouwing/verharding, water/grind),
 *     gladstrijken, gaten van tekst en lijnen dichten, aaneengesloten vlakken zoeken en hun rand traceren.
 *  2. Schaal: maatgetallen lezen met tekstherkenning (Tesseract, lokaal als WebAssembly) en per getal de
 *     bijbehorende maatlijn meten.
 * Geeft hetzelfde formaat terug als de AI-analyse (pixels van de analyse-afbeelding), zodat Concept.build
 * het resultaat op dezelfde manier verwerkt.
 */
(function () {
  'use strict';

  const Geo = window.Geo;
  const Catalog = window.Catalog;

  const WORK_MAX = 1000; // werkresolutie voor de kleuranalyse
  const NONE = 0, LAWN = 1, HEDGE = 2, BED = 3, DRY = 4, WET = 5;
  const TEX_PLANTS = 0.07; // textuur (zie normalizedColors) waarboven groen als beplanting telt
  const CLASS_TYPE = { [LAWN]: 'lawn', [HEDGE]: 'hedge', [BED]: 'bed', [DRY]: 'dry', [WET]: 'wet' };

  // ---------------------------------------------------------------- kleuren

  /**
   * Zet een RGB-kleur om naar HSV.
   * @param {number} red rood 0–255
   * @param {number} green groen 0–255
   * @param {number} blue blauw 0–255
   * @returns {number[]} [tint 0–360, verzadiging 0–1, helderheid 0–1]
   */
  function rgbToHsv(red, green, blue) {
    red /= 255; green /= 255; blue /= 255;
    const max = Math.max(red, green, blue), min = Math.min(red, green, blue), delta = max - min;
    let hue = 0;
    if (delta > 1e-6) {
      if (max === red) hue = 60 * (((green - blue) / delta) % 6);
      else if (max === green) hue = 60 * ((blue - red) / delta + 2);
      else hue = 60 * ((red - green) / delta + 4);
    }
    if (hue < 0) hue += 360;
    return [hue, max === 0 ? 0 : delta / max, max];
  }

  /**
   * Kleur naar vlaksoort. Bewust eenvoudig en uitlegbaar; zie DOCS.md voor de regels. Werkt op kleuren die
   * op het papier genormaliseerd zijn, dus ook voor bleke potlood- en stifttinten.
   * @param {number} red rood 0–255
   * @param {number} green groen 0–255
   * @param {number} blue blauw 0–255
   * @returns {number} vlaksoort (NONE, LAWN, HEDGE, BED, DRY of WET)
   */
  function classify(red, green, blue) {
    const [hue, saturation, value] = rgbToHsv(red, green, blue);
    const chroma = saturation * value; // kleurigheid (chroma): klein bij wit, grijs én zwart
    if (value < 0.22) return NONE; // lijnen, tekst
    if (chroma < 0.07) return value > 0.88 ? NONE : DRY; // wit papier / grijs = bebouwing, verharding
    if (hue >= 65 && hue < 140) {
      if (chroma < 0.12) return value > 0.88 ? NONE : DRY; // grijsgroen: grind, vervaagde lijnen
      return value > 0.58 ? LAWN : HEDGE; // licht/middengroen = gras, donkergroen = haag/heesters
    }
    if (hue >= 140 && hue < 195) return chroma < 0.1 ? DRY : HEDGE; // blauwgroen = heesters, coniferen
    if (hue >= 50 && hue < 65) return saturation > 0.35 ? LAWN : DRY; // geelgroen gras / kaki, geel = terras of vlonder
    if (hue >= 195 && hue < 260) return WET; // water
    if (hue >= 260 && hue < 345) return BED; // bloemen
    return saturation < 0.3 && value > 0.7 ? DRY : BED; // licht beige/zand/baksteen = verharding, (grijs)bruin/oranje/rood = beplanting
  }

  /**
   * Kleur van de achtergrond (papier) = meest voorkomende kleur op de rand van het beeld.
   * @param {Uint8ClampedArray} data RGBA-pixels
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @returns {number[]} [rood, groen, blauw, aandeel van de rand met die kleur]
   */
  function backgroundColor(data, width, height) {
    const counts = new Map();
    /**
     * Telt de (grof afgeronde) kleur van één pixel.
     * @param {number} pixelIndex index van het pixel
     */
    const add = (pixelIndex) => {
      const offset = pixelIndex * 4;
      const key = ((data[offset] >> 4) << 8) | ((data[offset + 1] >> 4) << 4) | (data[offset + 2] >> 4);
      counts.set(key, (counts.get(key) || 0) + 1);
    };
    for (let x = 0; x < width; x++) { add(x); add((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { add(y * width); add(y * width + width - 1); }
    let best = 0, bestCount = -1;
    for (const [colorKey, count] of counts) if (count > bestCount) { best = colorKey; bestCount = count; }
    return [((best >> 8) & 15) * 16 + 8, ((best >> 4) & 15) * 16 + 8, (best & 15) * 16 + 8, bestCount / (2 * (width + height))];
  }

  /**
   * Termen van een derdegraads veelterm in x, y (beide -1..1).
   * @param {number} x x tussen -1 en 1
   * @param {number} y y tussen -1 en 1
   * @param {Float64Array} out array van 10 plaatsen die gevuld wordt
   * @returns {Float64Array} de gevulde termen
   */
  function polyTerms(x, y, out) {
    out[0] = 1; out[1] = x; out[2] = y; out[3] = x * x; out[4] = x * y; out[5] = y * y;
    out[6] = x * x * x; out[7] = x * x * y; out[8] = x * y * y; out[9] = y * y * y;
    return out;
  }

  /**
   * Kleinste-kwadratenoplossing (normaalvergelijkingen, Gauss-eliminatie met kleine regularisatie).
   * @param {Float64Array[]} rows termen per waarneming
   * @param {number[]} ys gemeten waarde per waarneming
   * @param {number[]} [weights] gewicht per waarneming (0 = niet meetellen)
   * @returns {number[]} de coëfficiënten
   */
  function solveLeastSquares(rows, ys, weights) {
    const size = rows[0].length;
    const matrix = Array.from({ length: size }, () => new Float64Array(size + 1));
    rows.forEach((row, rowIndex) => {
      const weight = weights ? weights[rowIndex] : 1;
      if (!weight) return;
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) matrix[i][j] += weight * row[i] * row[j];
        matrix[i][size] += weight * row[i] * ys[rowIndex];
      }
    });
    for (let i = 0; i < size; i++) matrix[i][i] += 1e-6 * (matrix[0][0] || 1);
    for (let i = 0; i < size; i++) {
      let pivot = i;
      for (let row = i + 1; row < size; row++) if (Math.abs(matrix[row][i]) > Math.abs(matrix[pivot][i])) pivot = row;
      [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
      if (Math.abs(matrix[i][i]) < 1e-12) continue;
      for (let row = 0; row < size; row++) {
        if (row === i) continue;
        const factor = matrix[row][i] / matrix[i][i];
        for (let j = i; j <= size; j++) matrix[row][j] -= factor * matrix[i][j];
      }
    }
    return matrix.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[size] / row[i]));
  }

  /**
   * Papierkleur over het hele beeld schatten (foto's en scans: ongelijke belichting, grijs of getint papier).
   * Per cel de lichtste, minst gekleurde pixels; cellen met een afwijkende kleurtoon (ingekleurd) vallen af.
   * Daarna een gladde derdegraads veelterm per kleurkanaal, herhaald zonder cellen die duidelijk donkerder
   * zijn dan de fit (grijze arcering, tafelrand).
   * @param {Uint8ClampedArray} data RGBA-pixels
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @returns {Function|null} functie (x, y, out) → [r, g, b] (0–255), of null als er geen papier zichtbaar is
   */
  function paperModel(data, width, height) {
    const cellSize = Math.max(6, Math.round(Math.max(width, height) / 32));
    const gridWidth = Math.ceil(width / cellSize), gridHeight = Math.ceil(height / cellSize);
    const cells = [];
    const histogram = new Uint32Array(256);
    /**
     * Helderheid van een kleur.
     * @param {number[]} rgb kleur [r, g, b]
     * @returns {number} helderheid 0–255
     */
    const luminance = (rgb) => rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11;
    /**
     * Papierscore van een pixel: licht en kleurloos scoort hoog.
     * @param {number} offset index van het pixel in de RGBA-data
     * @returns {number} score 0–255
     */
    const score = (offset) => {
      const red = data[offset], green = data[offset + 1], blue = data[offset + 2];
      return Math.max(0, Math.min(255, (red * 0.3 + green * 0.59 + blue * 0.11) - 3 * (Math.max(red, green, blue) - Math.min(red, green, blue)))) | 0;
    };
    for (let gy = 0; gy < gridHeight; gy++) {
      for (let gx = 0; gx < gridWidth; gx++) {
        const xa = gx * cellSize, ya = gy * cellSize, xb = Math.min(width, xa + cellSize), yb = Math.min(height, ya + cellSize);
        histogram.fill(0);
        let count = 0;
        for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { histogram[score((y * width + x) * 4)]++; count++; }
        let accumulated = 0, threshold = 255; // drempel: lichtste 15%
        while (threshold > 0 && accumulated + histogram[threshold] < count * 0.15) accumulated += histogram[threshold--];
        let sr = 0, sg = 0, sb = 0, pixelCount = 0;
        for (let y = ya; y < yb; y++) {
          for (let x = xa; x < xb; x++) {
            const offset = (y * width + x) * 4;
            if (score(offset) < threshold) continue;
            sr += data[offset]; sg += data[offset + 1]; sb += data[offset + 2]; pixelCount++;
          }
        }
        cells.push({ x: ((xa + xb) / 2 / width) * 2 - 1, y: ((ya + yb) / 2 / height) * 2 - 1, rgb: [sr / pixelCount, sg / pixelCount, sb / pixelCount] });
      }
    }

    /**
     * Kleurtoon van een cel: aandeel van elk kanaal in de som.
     * @param {object} cell de cel
     * @returns {number[]} aandelen [r, g, b]
     */
    const tone = (cell) => { const total = cell.rgb[0] + cell.rgb[1] + cell.rgb[2] || 1; return [cell.rgb[0] / total, cell.rgb[1] / total, cell.rgb[2] / total]; };
    /**
     * Mediaan van een lijst getallen.
     * @param {number[]} values de getallen
     * @returns {number} de mediaan
     */
    const median = (values) => values.slice().sort((left, right) => left - right)[values.length >> 1];
    // kleurtoon t.o.v. de papiertint (een foto kan een kleurzweem hebben): mediaan over de 20% cellen die
    // het lichtst en minst gekleurd zijn; bij een sterk ingekleurd plan is papier niet de meerderheid
    const tones = cells.map(tone);
    /**
     * Papierscore van een cel: licht en kleurloos scoort hoog.
     * @param {object} cell de cel
     * @returns {number} score
     */
    const cellScore = (cell) => luminance(cell.rgb) - 3 * (Math.max(...cell.rgb) - Math.min(...cell.rgb));
    const best = cells.map((cell, index) => index).sort((left, right) => cellScore(cells[right]) - cellScore(cells[left])).slice(0, Math.max(5, Math.round(cells.length * 0.2)));
    const mt = [0, 1, 2].map((channel) => median(best.map((index) => tones[index][channel])));
    const valid = cells.map((cell, index) => cell.rgb[0] + cell.rgb[1] + cell.rgb[2] > 60 &&
      Math.abs(tones[index][0] - mt[0]) + Math.abs(tones[index][1] - mt[1]) + Math.abs(tones[index][2] - mt[2]) < 0.025);
    if (valid.filter(Boolean).length < Math.max(8, 0.1 * cells.length)) return null; // geen papier zichtbaar (luchtfoto)
    const rows = cells.map((cell) => polyTerms(cell.x, cell.y, new Float64Array(10)));
    let active = valid.map((isValid) => (isValid ? 1 : 0));
    let coef = null;
    for (let iteration = 0; iteration < 6; iteration++) {
      coef = [0, 1, 2].map((channel) => solveLeastSquares(rows, cells.map((cell) => cell.rgb[channel]), active));
      /**
       * Helderheid van de fit op een cel.
       * @param {number} index index van de cel
       * @returns {number} helderheid volgens de veelterm
       */
      const fitLum = (index) => luminance([0, 1, 2].map((channel) => rows[index].reduce((sum, term, i) => sum + term * coef[channel][i], 0)));
      active = cells.map((cell, index) => (valid[index] && luminance(cell.rgb) > fitLum(index) * 0.94 ? 1 : 0));
      if (active.filter(Boolean).length < 10) return null;
    }
    // begrenzen op wat er werkelijk aan papier gezien is (extrapolatie in hoeken)
    const act = cells.filter((cell, index) => active[index]);
    const lo = [0, 1, 2].map((channel) => Math.min(...act.map((cell) => cell.rgb[channel])) * 0.9);
    const hi = [0, 1, 2].map((channel) => Math.max(...act.map((cell) => cell.rgb[channel])) * 1.05);
    const terms = new Float64Array(10);
    /**
     * Papierkleur op een punt volgens de fit, begrensd op wat er werkelijk aan papier gezien is.
     * @param {number} x x in pixels
     * @param {number} y y in pixels
     * @param {number[]} out array die gevuld wordt met [r, g, b]
     * @returns {number[]} de gevulde kleur
     */
    return (x, y, out) => {
      polyTerms((x / width) * 2 - 1, (y / height) * 2 - 1, terms);
      for (let channel = 0; channel < 3; channel++) {
        let value = 0;
        for (let i = 0; i < 10; i++) value += terms[i] * coef[channel][i];
        out[channel] = Math.max(Math.max(24, lo[channel]), Math.min(hi[channel], value));
      }
      return out;
    };
  }

  /**
   * Kleuren genormaliseerd op het papier (papier = 1,1,1) en uitgemiddeld over de arcering van potlood
   * of stift. Inkt (zwarte lijnen, tekst) telt bij het middelen niet mee: een lijn neemt de kleur van zijn
   * omgeving aan en verdwijnt, in plaats van een grijze rand (= "verharding") te worden.
   * Digitale plannen (egaal wit papier) worden niet genormaliseerd.
   * @param {Uint8ClampedArray} data RGBA-pixels
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @returns {{rgb: Float32Array, tex: Float32Array, normalized: boolean}} kleuren (rgb 0..~1), textuur per pixel en of er genormaliseerd is
   */
  function normalizedColors(data, width, height) {
    const [paperRed, paperGreen, paperBlue, share] = backgroundColor(data, width, height);
    const [, paperSaturation, paperValue] = rgbToHsv(paperRed, paperGreen, paperBlue);
    const digital = share > 0.5 && paperValue > 0.9 && paperSaturation < 0.08; // egaal wit papier: niets te corrigeren
    let model = digital ? null : paperModel(data, width, height);
    const out = new Float32Array(width * height * 3);
    /**
     * Deelt elk pixel door de papierkleur.
     * @param {Function|null} paper papiermodel, of null voor wit papier
     * @returns {number} aandeel pixels dat duidelijk lichter is dan het papier
     */
    const fill = (paper) => {
      const paperColor = [255, 255, 255];
      let over = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4, outOffset = (y * width + x) * 3;
          if (paper && (x & 3) === 0) paper(x, y, paperColor); // papierkleur verloopt traag: elke 4 pixels bijwerken
          out[outOffset] = data[offset] / paperColor[0]; out[outOffset + 1] = data[offset + 1] / paperColor[1]; out[outOffset + 2] = data[offset + 2] / paperColor[2];
          if (out[outOffset] * 0.3 + out[outOffset + 1] * 0.59 + out[outOffset + 2] * 0.11 > 1.12) over++;
        }
      }
      return over / (width * height);
    };
    // controle: na normaliseren hoort vrijwel niets veel lichter te zijn dan het papier (anders: geen papier,
    // maar bv. een luchtfoto met grijze daken en wegen)
    if (fill(model) > 0.04 && model) { model = null; fill(null); }
    const radius = Math.max(1, Math.round(Math.max(width, height) / 220));
    const rgb = inkFreeBlur(out, width, height, radius);
    // textuur: gemiddelde afwijking van de helderheid t.o.v. de gemiddelde kleur. Gazon is egaal,
    // getekende planten en bomen zijn gevlekt (ook als ze gemiddeld dezelfde kleur hebben)
    const deviation = new Float32Array(width * height);
    for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
      const offset = pixelIndex * 3;
      if (isInk(out[offset], out[offset + 1], out[offset + 2])) continue; // lijnen en tekst tellen niet als textuur
      deviation[pixelIndex] = Math.abs((out[offset] - rgb[offset]) * 0.3 + (out[offset + 1] - rgb[offset + 1]) * 0.59 + (out[offset + 2] - rgb[offset + 2]) * 0.11);
    }
    return { rgb, tex: boxBlur(deviation, width, height, radius), normalized: Boolean(model) };
  }

  /**
   * Box-blur van één kanaal (lopende som).
   * @param {Float32Array} source waarden per pixel
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @param {number} radius straal in pixels
   * @returns {Float32Array} de vervaagde waarden
   */
  function boxBlur(source, width, height, radius) {
    const horizontal = new Float32Array(width * height), out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      let sum = 0, count = 0;
      for (let x = 0; x < Math.min(width, radius); x++) { sum += source[y * width + x]; count++; }
      for (let x = 0; x < width; x++) {
        if (x + radius < width) { sum += source[y * width + x + radius]; count++; }
        if (x - radius - 1 >= 0) { sum -= source[y * width + x - radius - 1]; count--; }
        horizontal[y * width + x] = sum / count;
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0, count = 0;
      for (let y = 0; y < Math.min(height, radius); y++) { sum += horizontal[y * width + x]; count++; }
      for (let y = 0; y < height; y++) {
        if (y + radius < height) { sum += horizontal[(y + radius) * width + x]; count++; }
        if (y - radius - 1 >= 0) { sum -= horizontal[(y - radius - 1) * width + x]; count--; }
        out[y * width + x] = sum / count;
      }
    }
    return out;
  }

  /**
   * Is deze (genormaliseerde) kleur inkt: donker en kleurloos?
   * @param {number} red rood 0..1
   * @param {number} green groen 0..1
   * @param {number} blue blauw 0..1
   * @returns {boolean} true bij inkt
   */
  function isInk(red, green, blue) {
    const maxChannel = Math.max(red, green, blue), minChannel = Math.min(red, green, blue);
    return maxChannel < 0.45 && maxChannel - minChannel < 0.1;
  }

  /**
   * Box-blur (lopende som, horizontaal en verticaal) waarin inktpixels niet meetellen. Een pixel zonder
   * inktvrije buren houdt zijn eigen kleur (grote donkere vlakken).
   * @param {Float32Array} source kleuren (rgb per pixel)
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @param {number} radius straal in pixels
   * @returns {Float32Array} de vervaagde kleuren (rgb per pixel)
   */
  function inkFreeBlur(source, width, height, radius) {
    const pixelCount = width * height;
    const weighted = new Float32Array(pixelCount * 4); // r, g, b, gewicht
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      if (isInk(source[pixelIndex * 3], source[pixelIndex * 3 + 1], source[pixelIndex * 3 + 2])) continue;
      weighted[pixelIndex * 4] = source[pixelIndex * 3]; weighted[pixelIndex * 4 + 1] = source[pixelIndex * 3 + 1]; weighted[pixelIndex * 4 + 2] = source[pixelIndex * 3 + 2]; weighted[pixelIndex * 4 + 3] = 1;
    }
    const horizontal = new Float32Array(pixelCount * 4), sum = new Float64Array(4);
    /**
     * Lopende som over één rij of kolom (r, g, b en gewicht).
     * @param {Float32Array} from bron
     * @param {Float32Array} to doel
     * @param {number} length aantal pixels in de rij of kolom
     * @param {number} stride afstand tussen opeenvolgende pixels
     * @param {number} base index van het eerste pixel
     */
    const run = (from, to, length, stride, base) => {
      sum.fill(0);
      for (let i = 0; i < Math.min(length, radius); i++) for (let channel = 0; channel < 4; channel++) sum[channel] += from[(base + i * stride) * 4 + channel];
      for (let i = 0; i < length; i++) {
        if (i + radius < length) for (let channel = 0; channel < 4; channel++) sum[channel] += from[(base + (i + radius) * stride) * 4 + channel];
        if (i - radius - 1 >= 0) for (let channel = 0; channel < 4; channel++) sum[channel] -= from[(base + (i - radius - 1) * stride) * 4 + channel];
        for (let channel = 0; channel < 4; channel++) to[(base + i * stride) * 4 + channel] = sum[channel];
      }
    };
    for (let y = 0; y < height; y++) run(weighted, horizontal, width, 1, y * width);
    const summed = new Float32Array(pixelCount * 4);
    for (let x = 0; x < width; x++) run(horizontal, summed, height, width, x);
    const out = new Float32Array(pixelCount * 3);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      const weight = summed[pixelIndex * 4 + 3];
      for (let channel = 0; channel < 3; channel++) out[pixelIndex * 3 + channel] = weight > 0.5 ? summed[pixelIndex * 4 + channel] / weight : source[pixelIndex * 3 + channel];
    }
    return out;
  }

  /**
   * Vlaksoort per pixel: eerst wat geleerd is, anders de vaste kleurregels.
   * @param {Uint8ClampedArray} data RGBA-pixels
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @param {object|null} learned geleerde tellingen van de organisatie
   * @returns {{cls: Uint8Array, rgb: Float32Array, tex: Float32Array, normalized: boolean, learnedShare: number}} vlaksoorten, kleuren, textuur en het aandeel uit het geleerde
   */
  function classMap(data, width, height, learned = null) {
    const { rgb, tex, normalized } = normalizedColors(data, width, height);
    const classes = new Uint8Array(width * height);
    const decide = learnedDecisions(learned);
    let fromLearned = 0;
    for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
      const offset = pixelIndex * 3;
      if (decide) {
        const decision = decide[featureKey(rgb[offset], rgb[offset + 1], rgb[offset + 2], tex[pixelIndex])];
        if (decision >= 0) { classes[pixelIndex] = decision; fromLearned++; continue; }
      }
      let pixelClass = classify(rgb[offset] * 255, rgb[offset + 1] * 255, rgb[offset + 2] * 255);
      // gevlekt lichtgroen = getekende planten of een boomkroon, geen gazon
      if (pixelClass === LAWN && tex[pixelIndex] > TEX_PLANTS) pixelClass = BED;
      classes[pixelIndex] = pixelClass;
    }
    return { cls: classes, rgb, tex, normalized, learnedShare: fromLearned / (width * height) };
  }

  // ---------------------------------------------------------------- leren van herkende plannen
  //
  // Na een AI-herkenning (of het goedkeuren van een plan) telt de planner per kleur/textuur-vakje hoe vaak
  // het bij gazon, haag, beplanting, bestrating, water of "niets" hoorde. Alleen die tellingen gaan naar de
  // server, geen afbeelding. De server telt alle voorbeelden van de organisatie op; de lokale herkenning
  // gebruikt die uitkomst vóór de vaste kleurregels, maar alleen als een vakje vaak en eenduidig gezien is.

  const FEATURE_VERSION = 1;
  const LEVELS = 8; // per kleurkanaal
  const TEX_LEVELS = [0.025, 0.07]; // grenzen egaal | licht gevlekt | gevlekt
  const FEATURE_BINS = LEVELS * LEVELS * LEVELS * (TEX_LEVELS.length + 1);
  const SAMPLE_TOTAL = 20000; // elk voorbeeld weegt even zwaar, hoe groot het plan ook is
  const LEARN_MIN = 40; // minimaal gewicht in een vakje voordat het meetelt
  const LEARN_SHARE = 0.6; // en het winnende type moet zo'n aandeel hebben
  const TYPE_CLASS = { lawn: LAWN, hedge: HEDGE, bed: BED, planter: BED, dry: DRY, wet: WET };

  /**
   * Vakje voor een (op het papier genormaliseerde) kleur 0..1 en textuur.
   * @param {number} red rood 0..1
   * @param {number} green groen 0..1
   * @param {number} blue blauw 0..1
   * @param {number} texture textuur
   * @returns {number} nummer van het vakje
   */
  function featureKey(red, green, blue, texture) {
    /**
     * Kleurwaarde 0..1 naar een niveau 0..LEVELS-1.
     * @param {number} value de waarde
     * @returns {number} het niveau
     */
    const quantize = (value) => Math.max(0, Math.min(LEVELS - 1, Math.floor(value * LEVELS)));
    const textureLevel = texture < TEX_LEVELS[0] ? 0 : texture < TEX_LEVELS[1] ? 1 : 2;
    return ((quantize(red) * LEVELS + quantize(green)) * LEVELS + quantize(blue)) * (TEX_LEVELS.length + 1) + textureLevel;
  }

  /**
   * Per vakje het geleerde type (of -1: niet genoeg of niet eenduidig gezien).
   * @param {object|null} learned geleerde tellingen ({ v, bins })
   * @returns {Int8Array|null} vlaksoort per vakje, of null als er niets bruikbaars is
   */
  function learnedDecisions(learned) {
    if (!learned || learned.v !== FEATURE_VERSION || !learned.bins) return null;
    const decide = new Int8Array(FEATURE_BINS).fill(-1);
    let any = false;
    for (const [key, counts] of Object.entries(learned.bins)) {
      const bin = Number(key);
      if (!(bin >= 0 && bin < FEATURE_BINS) || !Array.isArray(counts)) continue;
      let total = 0, best = 0;
      for (let typeIndex = 0; typeIndex < 6; typeIndex++) { total += counts[typeIndex] || 0; if ((counts[typeIndex] || 0) > (counts[best] || 0)) best = typeIndex; }
      if (total >= LEARN_MIN && counts[best] / total >= LEARN_SHARE) { decide[bin] = best; any = true; }
    }
    return any ? decide : null;
  }

  /**
   * Vult een polygoon (pixels) in `label` met een waarde (scanline).
   * @param {Uint8Array} label waarden per pixel
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @param {Array<{x: number, y: number}>} points hoekpunten in pixels
   * @param {number} value de waarde
   */
  function fillPolygon(label, width, height, points, value) {
    const ys = points.map((point) => point.y);
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      const rowCenter = y + 0.5;
      xs.length = 0;
      for (let i = 0; i < points.length; i++) {
        const from = points[i], to = points[(i + 1) % points.length];
        if ((from.y <= rowCenter) !== (to.y <= rowCenter)) xs.push(from.x + ((rowCenter - from.y) / (to.y - from.y)) * (to.x - from.x));
      }
      xs.sort((left, right) => left - right);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.ceil(xs[i] - 0.5)), xb = Math.min(width - 1, Math.floor(xs[i + 1] - 0.5));
        for (let x = xa; x <= xb; x++) label[y * width + x] = value;
      }
    }
  }

  /**
   * Tellingen per vakje uit RGBA-pixels (werkresolutie) en de juiste vlakken (in dezelfde pixels).
   * Grote vlakken eerst, kleinere erover: een border in het gazon telt als border.
   * @param {Uint8ClampedArray} data RGBA-pixels
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @param {object[]} areas vlakken met type en points
   * @returns {{v: number, bins: object}|null} tellingen per vakje, of null zonder bruikbare vlakken
   */
  function samplesFromPixels(data, width, height, areas) {
    const label = new Uint8Array(width * height); // 0 = buiten elk vlak
    const list = (areas || []).filter((area) => TYPE_CLASS[area.type] && area.points && area.points.length >= 3)
      .map((area) => ({ c: TYPE_CLASS[area.type], pts: area.points, size: Geo.area(area.points) }))
      .sort((left, right) => right.size - left.size);
    if (!list.length) return null;
    for (const item of list) fillPolygon(label, width, height, item.pts, item.c);
    const { rgb, tex } = normalizedColors(data, width, height);
    const counts = new Map();
    let total = 0;
    for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
      const offset = pixelIndex * 3;
      const key = featureKey(rgb[offset], rgb[offset + 1], rgb[offset + 2], tex[pixelIndex]);
      // buiten de vlakken: half gewicht (de AI tekent niet elk randje, en papier is overal)
      const weight = label[pixelIndex] ? 1 : 0.5;
      let binCounts = counts.get(key);
      if (!binCounts) counts.set(key, (binCounts = [0, 0, 0, 0, 0, 0]));
      binCounts[label[pixelIndex]] += weight;
      total += weight;
    }
    const factor = SAMPLE_TOTAL / total;
    const bins = {};
    for (const [key, binCounts] of counts) {
      const scaled = binCounts.map((count) => Math.round(count * factor));
      if (scaled.some((count) => count > 0)) bins[key] = scaled;
    }
    return { v: FEATURE_VERSION, bins };
  }

  /**
   * Leert van een herkenning: analyse-afbeelding + resultaat (vlakken in pixels van die afbeelding,
   * zoals /api/plan/analyze ze geeft).
   * @param {{dataUrl: string}} analyzeImage de analyse-afbeelding
   * @param {object} result de herkenning
   * @returns {Promise<object|null>} de tellingen (zonder afbeelding)
   */
  async function learn(analyzeImage, result) {
    const image = await window.PlanImport.loadImage(analyzeImage.dataUrl);
    const { data, w: width, h: height, f: factor } = workPixels(image);
    const areas = (result.areas || []).map((area) => ({ type: area.type, points: (area.points || []).map((point) => ({ x: point.x * factor, y: point.y * factor })) }));
    return samplesFromPixels(data, width, height, areas);
  }

  /**
   * Meerderheidsfilter 3×3 (ruis en antialiasing weg).
   * @param {Uint8Array} classes vlaksoort per pixel
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @returns {Uint8Array} gefilterde vlaksoorten
   */
  function modeFilter(classes, width, height) {
    const out = new Uint8Array(classes.length);
    const counts = new Uint8Array(6);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        counts.fill(0);
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            counts[classes[yy * width + xx]]++;
          }
        }
        let best = classes[y * width + x], bestCount = 0;
        for (let pixelClass = 0; pixelClass < 6; pixelClass++) if (counts[pixelClass] > bestCount) { bestCount = counts[pixelClass]; best = pixelClass; }
        out[y * width + x] = bestCount >= 5 ? best : classes[y * width + x];
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- vlakken

  /**
   * Dilatatie of erosie van een masker met een vierkant (horizontaal en verticaal apart).
   * @param {Uint8Array} mask masker (0/1)
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @param {number} radius straal in pixels
   * @param {boolean} dilate true = verdikken, false = versmallen
   * @returns {Uint8Array} het nieuwe masker
   */
  function morph(mask, width, height, radius, dilate) {
    /**
     * Eén doorgang in één richting.
     * @param {Uint8Array} source masker
     * @param {boolean} horizontal true = horizontaal, false = verticaal
     * @returns {Uint8Array} het nieuwe masker
     */
    const pass = (source, horizontal) => {
      const out = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let value = dilate ? 0 : 1;
          for (let offset = -radius; offset <= radius; offset++) {
            const xx = horizontal ? x + offset : x, yy = horizontal ? y : y + offset;
            const sourceValue = xx >= 0 && yy >= 0 && xx < width && yy < height ? source[yy * width + xx] : 0;
            if (dilate ? sourceValue : !sourceValue) { value = dilate ? 1 : 0; break; }
          }
          out[y * width + x] = value;
        }
      }
      return out;
    };
    return pass(pass(mask, true), false);
  }

  /**
   * Aaneengesloten vlakken (4-buren) met hun pixels.
   * @param {Uint8Array} mask masker (0/1)
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @param {number} minPx minimaal aantal pixels
   * @returns {Array<{pix: number[], x0: number, y0: number, x1: number, y1: number}>} de vlakken
   */
  function components(mask, width, height, minPx) {
    const label = new Int32Array(width * height).fill(-1);
    const out = [];
    const stack = [];
    for (let seed = 0; seed < mask.length; seed++) {
      if (!mask[seed] || label[seed] >= 0) continue;
      const id = out.length;
      const pixels = [];
      let x0 = width, y0 = height, x1 = 0, y1 = 0;
      stack.push(seed);
      label[seed] = id;
      while (stack.length) {
        const index = stack.pop();
        pixels.push(index);
        const x = index % width, y = (index - x) / width;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && mask[index - 1] && label[index - 1] < 0) { label[index - 1] = id; stack.push(index - 1); }
        if (x < width - 1 && mask[index + 1] && label[index + 1] < 0) { label[index + 1] = id; stack.push(index + 1); }
        if (y > 0 && mask[index - width] && label[index - width] < 0) { label[index - width] = id; stack.push(index - width); }
        if (y < height - 1 && mask[index + width] && label[index + width] < 0) { label[index + width] = id; stack.push(index + width); }
      }
      out.push({ pix: pixels, x0, y0, x1, y1 });
    }
    return out.filter((component) => component.pix.length >= minPx);
  }

  /**
   * Polygonen van één vlak: lokaal masker, kleine gaten (tekst, symbolen) dicht, rand volgen, vereenvoudigen.
   * Grote gaten (een gazon midden in de verharding, een border) blijven open: een polygoon kent geen gaten,
   * dus wordt er een smalle snede langs de kortste weg naar buiten gemaakt (sleutelgat).
   * @param {object} comp het vlak (uit components)
   * @param {number} width breedte van het beeld in pixels
   * @param {number} tolerance vereenvoudiging in pixels
   * @param {number} minHole minimale grootte van een gat dat open blijft (pixels)
   * @param {Uint8Array} cls vlaksoort per pixel (voor de vulgraad)
   * @param {number} minFill minimale vulgraad (lager = getekende omtrek, geen vlak)
   * @param {Function|null} keepHole bepaalt per gat (beeldpixels) of het open blijft
   * @returns {Array<Array<{x: number, y: number}>>} de polygonen in beeldpixels
   */
  function componentPolygons(comp, width, tolerance, minHole, cls, minFill = 0.4, keepHole = null) {
    const Trace = window.AutoTrace._internal;
    const pad = 2;
    const boxWidth = comp.x1 - comp.x0 + 1 + 2 * pad, boxHeight = comp.y1 - comp.y0 + 1 + 2 * pad;
    const local = new Uint8Array(boxWidth * boxHeight);
    for (const index of comp.pix) {
      const x = index % width, y = (index - x) / width;
      local[(y - comp.y0 + pad) * boxWidth + (x - comp.x0 + pad)] = 1;
    }
    const filled = Trace.fillHoles(local, boxWidth, boxHeight);
    const holeMask = new Uint8Array(boxWidth * boxHeight);
    let inner = 0; // binnenkant zonder ander vlak (papier, lijnen)
    for (let index = 0; index < holeMask.length; index++) {
      holeMask[index] = filled[index] && !local[index] ? 1 : 0;
      if (!holeMask[index] || !cls) continue;
      const x = (index % boxWidth) + comp.x0 - pad, y = Math.floor(index / boxWidth) + comp.y0 - pad;
      if (!cls[y * width + x]) inner++;
    }
    // getekende omtrek (lijn) i.p.v. ingekleurd vlak: binnenin vrijwel leeg
    if (minFill > 0 && comp.pix.length / Math.max(1, comp.pix.length + inner) < minFill) return [];
    const mask = filled.slice();
    let holes = components(holeMask, boxWidth, boxHeight, minHole);
    if (keepHole) {
      // gatpixels terug naar beeldpixels voor de beoordeling
      /**
       * Index in het lokale masker naar index in het beeld.
       * @param {number} index index in het lokale masker
       * @returns {number} index in het beeld
       */
      const toImageIndex = (index) => (Math.floor(index / boxWidth) + comp.y0 - pad) * width + (index % boxWidth) + comp.x0 - pad;
      holes = holes.filter((hole) => keepHole(hole.pix.map(toImageIndex)));
    }
    const holeId = new Int32Array(boxWidth * boxHeight).fill(-1);
    holes.forEach((hole, i) => { for (const index of hole.pix) { mask[index] = 0; holeId[index] = i; } });
    holes.forEach((hole, i) => {
      // kortste weg (breedte-eerst) naar buiten het vlak, eventueel door andere gaten heen
      const prev = new Int32Array(boxWidth * boxHeight).fill(-2);
      const queue = [];
      for (const index of hole.pix) { prev[index] = -1; queue.push(index); }
      let end = -1;
      for (let queueIndex = 0; queueIndex < queue.length && end < 0; queueIndex++) {
        const index = queue[queueIndex], x = index % boxWidth;
        for (const neighbour of [x > 0 ? index - 1 : -1, x < boxWidth - 1 ? index + 1 : -1, index - boxWidth, index + boxWidth]) {
          if (neighbour < 0 || neighbour >= boxWidth * boxHeight || prev[neighbour] !== -2) continue;
          prev[neighbour] = index;
          if (!filled[neighbour]) { end = neighbour; break; }
          queue.push(neighbour);
        }
      }
      // snede 3 px breed, zodat de randvolging er niet overheen springt
      for (let index = end >= 0 ? prev[end] : -1; index >= 0 && holeId[index] !== i; index = prev[index]) {
        if (holeId[index] >= 0) continue; // door een ander gat: daar is niets te snijden
        const x = index % boxWidth, y = (index - x) / boxWidth;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < boxWidth && yy < boxHeight) mask[yy * boxWidth + xx] = 0;
        }
      }
    });
    const out = [];
    for (const piece of components(mask, boxWidth, boxHeight, minHole)) {
      const pieceMask = new Uint8Array(boxWidth * boxHeight);
      for (const index of piece.pix) pieceMask[index] = 1;
      const contour = Trace.traceContour(pieceMask, boxWidth, boxHeight);
      if (contour.length < 8) continue;
      const poly = Trace.simplify(contour, tolerance).map((point) => ({ x: point.x + comp.x0 - pad, y: point.y + comp.y0 - pad }));
      if (poly.length >= 3) out.push(poly);
    }
    return out;
  }

  /**
   * Eén polygoon (gaten dicht), eventueel iets verdikt: voor vlakken die door lijnen rond een label omsloten zijn.
   * @param {object} comp het vlak
   * @param {number} width breedte van het beeld in pixels
   * @param {number} tolerance vereenvoudiging in pixels
   * @param {number} minFill minimale vulgraad
   * @param {number} grow verdikking in pixels
   * @returns {Array<{x: number, y: number}>|null} de polygoon in beeldpixels, of null
   */
  function componentPolygon(comp, width, tolerance, minFill = 0, grow = 0) {
    const pad = 2 + grow;
    const boxWidth = comp.x1 - comp.x0 + 1 + 2 * pad, boxHeight = comp.y1 - comp.y0 + 1 + 2 * pad;
    const local = new Uint8Array(boxWidth * boxHeight);
    for (const index of comp.pix) {
      const x = index % width, y = (index - x) / width;
      local[(y - comp.y0 + pad) * boxWidth + (x - comp.x0 + pad)] = 1;
    }
    let filled = window.AutoTrace._internal.fillHoles(local, boxWidth, boxHeight);
    if (grow > 0) filled = morph(filled, boxWidth, boxHeight, grow, true);
    if (minFill > 0) {
      // getekende omtrek (lijn) i.p.v. ingekleurd vlak: binnenin vrijwel leeg
      let filledCount = 0;
      for (let index = 0; index < filled.length; index++) filledCount += filled[index];
      if (comp.pix.length / Math.max(1, filledCount) < minFill) return null;
    }
    const contour = window.AutoTrace._internal.traceContour(filled, boxWidth, boxHeight);
    if (contour.length < 8) return null;
    return window.AutoTrace._internal.simplify(contour, tolerance).map((point) => ({ x: point.x + comp.x0 - pad, y: point.y + comp.y0 - pad }));
  }

  /**
   * Pixels van het beeld op werkresolutie.
   * @param {HTMLImageElement} image het beeld
   * @returns {{data: Uint8ClampedArray, w: number, h: number, f: number}} RGBA-pixels, maat en f = werk-px per beeld-px
   */
  function workPixels(image) {
    const imageWidth = image.naturalWidth || image.width, imageHeight = image.naturalHeight || image.height;
    const factor = Math.min(1, WORK_MAX / Math.max(imageWidth, imageHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(imageWidth * factor));
    canvas.height = Math.max(1, Math.round(imageHeight * factor));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height, f: factor };
  }

  /**
   * Vlakken uit een beeld (via een canvas op werkresolutie).
   * @param {HTMLImageElement} image het beeld
   * @param {Function} onProgress voortgangsmelding (tekst)
   * @param {object} opts opties (learned)
   * @returns {object} zie areasFromPixels
   */
  function findAreas(image, onProgress, opts = {}) {
    const { data, w: width, h: height, f: factor } = workPixels(image);
    onProgress && onProgress('Kleuren indelen…');
    return areasFromPixels(data, width, height, factor, opts);
  }

  /**
   * Vlakken uit RGBA-pixels (werkresolutie). Los van canvas, zodat het testbaar is.
   * @param {Uint8ClampedArray} data RGBA-pixels
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @param {number} factor werk-px per beeld-px
   * @param {{learned: object, debug: boolean}} opts geleerde tellingen en debuguitvoer
   * @returns {{areas: object[], coloredShare: number, normalized: boolean, learnedShare: number, work: object}} vlakken (beeldpixels) en tussenresultaten
   */
  function areasFromPixels(data, width, height, factor = 1, opts = {}) {
    const colorMap = classMap(data, width, height, opts.learned);
    const classes = modeFilter(modeFilter(colorMap.cls, width, height), width, height);

    const radius = Math.max(1, Math.round(Math.max(width, height) / 350)); // dichtmaken van lijnen en tekst
    const minPx = Math.max(60, Math.round(width * height * 0.0012));
    const tolerance = Math.max(1.2, Math.max(width, height) / 450);
    const rLawn = Math.max(2, Math.round(Math.max(width, height) * 0.025));
    let colored = 0;
    const found = [];
    for (const pixelClass of [LAWN, HEDGE, BED, DRY, WET]) {
      let mask = new Uint8Array(width * height);
      for (let index = 0; index < mask.length; index++) if (classes[index] === pixelClass) { mask[index] = 1; colored++; }
      mask = morph(morph(mask, width, height, radius, true), width, height, radius, false);
      if (pixelClass === LAWN) {
        // tekst, een watermerk of een boom over het gras snijdt geen inhammen in het gazon: smalle
        // stukken beplanting/tekst tussen gras horen erbij (bestrating, water en hagen niet)
        // eerst losse snippers lichtgroen weg (in getekende planten, logo's): die zouden anders aan het gazon groeien
        const parts = components(mask, width, height, 1);
        const biggest = parts.reduce((largest, part) => Math.max(largest, part.pix.length), 0);
        for (const part of parts) if (part.pix.length < Math.max(minPx, 0.1 * biggest)) for (const index of part.pix) mask[index] = 0;
        const closed = morph(morph(mask, width, height, rLawn, true), width, height, rLawn, false);
        for (let index = 0; index < mask.length; index++) if (closed[index] && !mask[index] && (classes[index] === BED || classes[index] === NONE)) mask[index] = 1;
      }
      const comps = components(mask, width, height, minPx).sort((left, right) => right.pix.length - left.pix.length).slice(0, 25);
      for (const comp of comps) {
        if (comp.x1 - comp.x0 > 0.95 * width && comp.y1 - comp.y0 > 0.95 * height) continue; // achtergrond, geen vlak
        // foto of scan van een vel: wat de beeldrand raakt ligt buiten het papier (tafel, schaduw)
        if (colorMap.normalized && (comp.x0 <= 1 || comp.y0 <= 1 || comp.x1 >= width - 2 || comp.y1 >= height - 2)) continue;
        found.push({ c: pixelClass, comp });
      }
    }
    // grijze vlakken die niet aan de tuin grenzen (titelblok, legenda, tekstkader) weglaten
    let garden = found.filter((item) => item.c !== DRY && item.comp.pix.length >= 3 * minPx); // logo's en symbolen tellen niet
    if (!garden.length) garden = found.filter((item) => item.c !== DRY);
    if (garden.length) {
      let near = new Uint8Array(width * height);
      for (const item of garden) for (const index of item.comp.pix) near[index] = 1;
      near = morph(near, width, height, Math.max(2, Math.round(0.02 * Math.max(width, height))), true);
      for (let i = found.length - 1; i >= 0; i--) {
        const { c: pixelClass, comp } = found[i];
        if (pixelClass !== DRY) continue;
        let touch = 0;
        for (const index of comp.pix) if (near[index]) touch++;
        if (touch < Math.min(minPx, 0.02 * comp.pix.length)) found.splice(i, 1);
      }
    }
    const areas = [];
    const counters = {};
    for (const { c: pixelClass, comp } of found) {
      const type = CLASS_TYPE[pixelClass];
      /**
       * Laat in een gazon alleen een gat open dat droog moet blijven (terras, vijver).
       * Een border of boom in het gras wordt meegenomen, die krijgt toch water van de sproeiers.
       * @param {number[]} pixels beeldpixels van het gat
       * @returns {boolean} true als het gat open blijft
       */
      const keepHole = pixelClass === LAWN ? (pixels) => pixels.filter((index) => classes[index] === DRY || classes[index] === WET).length > 0.5 * pixels.length : null;
      for (const poly of componentPolygons(comp, width, tolerance, minPx, classes, 0.4, keepHole)) {
        counters[type] = (counters[type] || 0) + 1;
        areas.push({ type, name: `${Catalog.areaTypes[type].label} ${counters[type]}`, points: poly.map((point) => ({ x: point.x / factor, y: point.y / factor })) });
      }
    }
    dropIslands(areas, 0.03 * Math.max(width, height) / factor);
    const gray = new Uint8Array(width * height);
    for (let index = 0; index < gray.length; index++) gray[index] = (data[index * 4] * 0.299 + data[index * 4 + 1] * 0.587 + data[index * 4 + 2] * 0.114) | 0;
    const result = { areas, coloredShare: colored / (width * height), normalized: colorMap.normalized, learnedShare: colorMap.learnedShare, work: { gray, w: width, h: height, f: factor } };
    if (opts.debug) {
      const normalizedPixels = new Uint8ClampedArray(width * height * 4);
      for (let index = 0; index < width * height; index++) { for (let channel = 0; channel < 3; channel++) normalizedPixels[index * 4 + channel] = colorMap.rgb[index * 3 + channel] * 255; normalizedPixels[index * 4 + 3] = 255; }
      result.debug = { w: width, h: height, cls: classes, norm: normalizedPixels, rgb: colorMap.rgb };
    }
    return result;
  }

  /**
   * Losse eilandjes buiten de tuin weg (logo, legenda, kleurstalen): vlakken die elkaar binnen `gap`
   * naderen vormen een groep; groepen met minder dan 10% van de oppervlakte van de grootste groep vallen af.
   * @param {object[]} areas vlakken (worden aangepast)
   * @param {number} gap afstand in beeldpixels
   */
  function dropIslands(areas, gap) {
    if (areas.length < 2) return;
    const boxes = areas.map((area) => Geo.bbox(area.points));
    const sizes = areas.map((area) => Geo.area(area.points));
    const parent = areas.map((_, i) => i);
    /**
     * Wortel van de groep van een vlak (union-find).
     * @param {number} i index van het vlak
     * @returns {number} index van de wortel
     */
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < areas.length; i++) {
      for (let j = i + 1; j < areas.length; j++) {
        const first = boxes[i], second = boxes[j];
        if (first.minX - gap <= second.maxX && second.minX - gap <= first.maxX && first.minY - gap <= second.maxY && second.minY - gap <= first.maxY) parent[find(i)] = find(j);
      }
    }
    const total = new Map();
    areas.forEach((_, i) => total.set(find(i), (total.get(find(i)) || 0) + sizes[i]));
    const max = Math.max(...total.values());
    for (let i = areas.length - 1; i >= 0; i--) if (total.get(find(i)) < 0.1 * max) areas.splice(i, 1);
  }

  // ---------------------------------------------------------------- schaal (OCR)

  let tessWorker = null;

  /**
   * Laadt een script (Tesseract) als het er nog niet is.
   * @param {string} url adres van het script
   * @returns {Promise<void>} klaar na laden
   */
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve();
      const script = document.createElement('script');
      script.src = url;
      /** Script geladen. */
      script.onload = () => { resolve(); };
      /** Script kon niet geladen worden. */
      script.onerror = () => { reject(new Error('Tekstherkenning kon niet geladen worden')); };
      document.head.appendChild(script);
    });
  }

  /**
   * Start (eenmalig) de Tesseract-worker met Nederlands en Engels.
   * @returns {Promise<object>} de worker
   */
  async function getWorker() {
    if (tessWorker) return tessWorker;
    await loadScript('vendor/tesseract/tesseract.min.js');
    // De worker laadt kern en taaldata zelf in; relatieve paden zouden relatief aan het worker-script
    // worden opgelost, dus absolute URL's (werkt ook onder een padprefix achter een proxy).
    const base = new URL('vendor/tesseract/', window.location.href).href;
    tessWorker = await window.Tesseract.createWorker('nld+eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,
      langPath: base + 'lang',
      gzip: true,
      workerBlobURL: false,
    });
    return tessWorker;
  }

  /**
   * Getal + eenheid uit OCR-woorden halen. Geeft de mogelijke lezingen [{meters, strong}]:
   * sterk = decimaal getal of gewone eenheid ("12,50", "450 cm", "8 m"); zwak = kaal geheel getal (mm op een
   * bouwtekening) of een getal van 3+ cijfers met "m", waar OCR vaak de komma mist ("10,00 m" → "100 m";
   * dan ook 10 en 1 m als zwakke lezing).
   * @param {string} text het woord
   * @param {string|null} nextText het volgende woord op dezelfde regel (eenheid)
   * @returns {Array<{meters: number, strong: boolean}>} de lezingen
   */
  function lengthReadings(text, nextText) {
    const compact = String(text).replace(/\s+/g, '').replace(/[Mm]{2}$/, 'mm');
    const match = /^(\d{1,5}(?:[.,]\d{1,3})?)(mm|cm|m)?$/i.exec(compact);
    if (!match) return [];
    const raw = match[1];
    let unit = (match[2] || '').toLowerCase();
    if (!unit && nextText && /^(mm|cm|m)$/i.test(String(nextText).trim())) unit = String(nextText).trim().toLowerCase();
    const value = parseFloat(raw.replace(',', '.'));
    if (!isFinite(value) || value <= 0) return [];
    const hasDecimal = /[.,]\d/.test(raw);
    if (unit === 'mm') return [{ meters: value / 1000, strong: true }];
    if (unit === 'cm') return [{ meters: value / 100, strong: true }];
    if (unit === 'm') {
      if (hasDecimal || raw.length <= 2) return [{ meters: value, strong: true }];
      return [{ meters: value, strong: false }, { meters: value / 10, strong: false }, { meters: value / 100, strong: false }];
    }
    if (hasDecimal && value < 200) return [{ meters: value, strong: true }]; // 12,50 → meter
    if (!hasDecimal && value >= 300 && value <= 99999) return [{ meters: value / 1000, strong: false }]; // 1250 → mm (bouwtekening)
    return [];
  }

  /**
   * Eerste lezing in meters, of null.
   * @param {string} text het woord
   * @param {string|null} nextText het volgende woord
   * @returns {number|null} lengte in meters
   */
  function parseLength(text, nextText) {
    const readings = lengthReadings(text, nextText);
    return readings.length ? readings[0].meters : null;
  }

  /**
   * Kiest de schaal uit kandidaten {mpp, meters, px, text, strong?, conf?}.
   * Groepen kandidaten die binnen 8% overeenkomen; dezelfde maat (zelfde lijn) uit meerdere OCR-rondes telt
   * één keer. Een groep komt in aanmerking met een sterke lezing of met twee of meer verschillende maten;
   * daarbinnen wint de groep met de meeste maten en de hoogste zekerheid. Anders: één zwakke lezing die een
   * gangbare plangrootte geeft (laag). Tegenstrijdige lezingen verlagen de betrouwbaarheid.
   * @param {object[]} candidates maatkandidaten
   * @param {number} imageWidth beeldbreedte in pixels
   * @returns {object|null} schaal {metersPerPixel, method, confidence, evidence, count}, of null
   */
  function pickScale(candidates, imageWidth) {
    const ok = candidates.filter((candidate) => imageWidth * candidate.mpp >= 3 && imageWidth * candidate.mpp <= 200); // plan 3–200 m breed
    if (!ok.length) return null;
    /**
     * Sleutel voor dezelfde maat (zelfde getal en lijnlengte).
     * @param {object} candidate de kandidaat
     * @returns {string} de sleutel
     */
    const key = (candidate) => `${candidate.meters}@${Math.round(candidate.px / 5)}`; // dezelfde maat
    /**
     * Sleutel voor hetzelfde woord (alternatieve lezingen).
     * @param {object} candidate de kandidaat
     * @returns {string} de sleutel
     */
    const source = (candidate) => `${candidate.text}@${Math.round(candidate.px / 5)}`; // hetzelfde woord (alternatieve lezingen)
    /**
     * Is de lezing sterk?
     * @param {object} candidate de kandidaat
     * @returns {boolean} true bij een sterke lezing
     */
    const strong = (candidate) => candidate.strong !== false;
    const groups = ok.map((entry) => {
      const members = ok.filter((other) => Math.abs(other.mpp - entry.mpp) / entry.mpp <= 0.08);
      const distinct = [...new Map(members.map((candidate) => [key(candidate), candidate])).values()];
      const score = (members.some(strong) ? 10000 : 0) + distinct.length * 100 + members.reduce((sum, candidate) => sum + (candidate.conf == null ? 50 : candidate.conf), 0);
      return { grp: members, distinct, score, eligible: members.some(strong) || distinct.length >= 2 };
    }).filter((group) => group.eligible).sort((left, right) => right.score - left.score);
    let best = groups[0], confidence;
    if (best) {
      const own = new Set(best.grp.map(source));
      const conflicts = ok.filter((candidate) => !best.grp.includes(candidate) && !own.has(source(candidate))).map((candidate) => `"${candidate.text}"`);
      const many = best.distinct.length >= 2;
      confidence = conflicts.length ? (many ? 'middel' : 'laag') : many ? 'hoog' : 'middel';
      best.conflicts = [...new Set(conflicts)];
    } else {
      const plausible = ok.filter((candidate) => imageWidth * candidate.mpp >= 5 && imageWidth * candidate.mpp <= 100);
      plausible.sort((left, right) => Math.abs(Math.log(imageWidth * left.mpp / 25)) - Math.abs(Math.log(imageWidth * right.mpp / 25)));
      if (!plausible.length) return null;
      best = { grp: [plausible[0]], distinct: [plausible[0]], conflicts: [] };
      confidence = 'laag';
    }
    const sorted = best.grp.slice().sort((left, right) => left.mpp - right.mpp);
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
      metersPerPixel: median.mpp,
      method: 'maatvoering',
      confidence,
      evidence: best.distinct.slice(0, 4).map((candidate) => `"${candidate.text}" = ${+candidate.meters.toFixed(3)} m over ${Math.round(candidate.px)} px`).join(', ') +
        (best.conflicts.length ? `; tegenstrijdig gelezen: ${best.conflicts.slice(0, 3).join(', ')}` : ''),
      count: best.distinct.length,
    };
  }

  /**
   * Zoekt de maatlijn bij een tekst: de langste aaneengesloten donkere lijn (horizontaal) op een rij
   * dicht bij de tekst die het midden van de tekst overspant. Onderbrekingen door de tekst zelf mogen.
   * @param {Uint8Array} gray grijswaarde per pixel
   * @param {number} width breedte in pixels
   * @param {number} height hoogte in pixels
   * @param {{x0: number, y0: number, x1: number, y1: number}} box kader van de tekst
   * @returns {{len: number, dy: number, y: number, a: number, b: number}|null} de lijn (lengte, afstand tot de tekst, rij, begin, einde), of null
   */
  function measureLine(gray, width, height, box) {
    const textHeight = box.y1 - box.y0, textWidth = box.x1 - box.x0, cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    let best = null;
    for (let y = Math.max(0, Math.round(box.y0 - 2 * textHeight)); y <= Math.min(height - 1, Math.round(box.y1 + 2 * textHeight)); y++) {
      // donkere segmenten op deze rij
      const segments = [];
      let start = -1;
      for (let x = 0; x <= width; x++) {
        const dark = x < width && gray[y * width + x] < 110;
        if (dark && start < 0) start = x;
        if (!dark && start >= 0) { segments.push([start, x - 1]); start = -1; }
      }
      if (!segments.length) continue;
      // samenvoegen: kleine gaten, of een gat waar de tekst staat
      const merged = [segments[0].slice()];
      for (let i = 1; i < segments.length; i++) {
        const last = merged[merged.length - 1];
        const gap = segments[i][0] - last[1];
        const gapOverText = last[1] >= box.x0 - textHeight && segments[i][0] <= box.x1 + textHeight && y >= box.y0 - textHeight && y <= box.y1 + textHeight;
        if (gap <= 3 || gapOverText) last[1] = segments[i][1];
        else merged.push(segments[i].slice());
      }
      for (const [segmentStart, segmentEnd] of merged) {
        const length = segmentEnd - segmentStart + 1;
        if (segmentStart > cx || segmentEnd < cx) continue;
        if (length < Math.max(1.4 * textWidth, 30)) continue;
        // een maatlijn loopt aan beide kanten voorbij de tekst (filtert letters en tekstranden)
        if (segmentStart > box.x0 - 0.2 * textWidth || segmentEnd < box.x1 + 0.2 * textWidth) continue;
        const dy = Math.abs(y - cy);
        if (!best || dy < best.dy - 1 || (Math.abs(dy - best.dy) <= 1 && length > best.len)) best = { len: length, dy, y, a: segmentStart, b: segmentEnd };
      }
    }
    return best;
  }

  /**
   * Grijswaarden van een canvas.
   * @param {HTMLCanvasElement} canvas het canvas
   * @returns {Uint8Array} grijswaarde per pixel
   */
  function grayOf(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const grayValues = new Uint8Array(canvas.width * canvas.height);
    for (let pixelIndex = 0; pixelIndex < grayValues.length; pixelIndex++) grayValues[pixelIndex] = (data[pixelIndex * 4] * 0.299 + data[pixelIndex * 4 + 1] * 0.587 + data[pixelIndex * 4 + 2] * 0.114) | 0;
    return grayValues;
  }

  /**
   * Kader van de tekens zelf (van één of meer opeenvolgende woorden). Tesseract rekent een maatlijn die de
   * tekst raakt soms bij het eerste of laatste teken (kader honderden pixels breed): het eerste teken wordt
   * dan ingekort tot een gewone tekenbreedte aan zijn rechterkant, het laatste aan zijn linkerkant.
   * @param {...object} words OCR-woorden
   * @returns {object|null} het kader {x0, y0, x1, y1}, of null
   */
  function textBox(...words) {
    const textHeight = Math.max(...words.map((word) => word.bbox.y1 - word.bbox.y0)), charWidth = 0.7 * textHeight;
    const syms = [];
    for (const word of words) {
      const symbols = (word.symbols || []).filter((symbol) => symbol.text.trim());
      if (symbols.length) syms.push(...symbols);
      else syms.push({ text: word.text, bbox: word.bbox });
    }
    let box = null;
    syms.forEach((symbol, i) => {
      let { x0, x1 } = symbol.bbox;
      if (x1 - x0 > 1.6 * textHeight) {
        if (syms.length === 1) return; // niet te zeggen aan welke kant de tekst staat
        if (i === 0) x0 = x1 - charWidth;
        else if (i === syms.length - 1) x1 = x0 + charWidth;
        else return;
      }
      box = unionBox(box, { x0, y0: symbol.bbox.y0, x1, y1: symbol.bbox.y1 });
    });
    return box;
  }

  /**
   * Kleinste kader om twee kaders (een van beide mag leeg zijn).
   * @param {object|null} first eerste kader
   * @param {object|null} second tweede kader
   * @returns {object|null} het samengevoegde kader
   */
  function unionBox(first, second) {
    if (!first || !second) return first || second;
    return { x0: Math.min(first.x0, second.x0), y0: Math.min(first.y0, second.y0), x1: Math.max(first.x1, second.x1), y1: Math.max(first.y1, second.y1) };
  }

  /**
   * Beeldvariant voor OCR: eventueel 90° gedraaid en/of zwart-wit gemaakt.
   * @param {HTMLImageElement} image het beeld
   * @param {boolean} rotate 90° draaien
   * @param {boolean} binary zwart-wit maken
   * @returns {HTMLCanvasElement} de variant
   */
  function variant(image, rotate, binary) {
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    const canvas = document.createElement('canvas');
    canvas.width = rotate ? height : width;
    canvas.height = rotate ? width : height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (rotate) { context.translate(height, 0); context.rotate(Math.PI / 2); }
    context.drawImage(image, 0, 0);
    if (binary) {
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < imageData.data.length; i += 4) {
        const grayValue = imageData.data[i] * 0.299 + imageData.data[i + 1] * 0.587 + imageData.data[i + 2] * 0.114;
        imageData.data[i] = imageData.data[i + 1] = imageData.data[i + 2] = grayValue < 150 ? 0 : 255;
      }
      context.putImageData(imageData, 0, 0);
    }
    return canvas;
  }

  /**
   * Box in een 90° gedraaid beeld (x' = H - y, y' = x) terug naar het origineel.
   * @param {object} box kader in het gedraaide beeld
   * @param {number} height hoogte van het originele beeld
   * @returns {object} kader in het originele beeld
   */
  const unrotate = (box, height) => ({ x0: box.y0, y0: height - box.x1, x1: box.y1, y1: height - box.x0 });

  /**
   * Maatkandidaten uit de woorden van één OCR-ronde, gemeten op dat beeld.
   * @param {object[]} ocrWords woorden van Tesseract
   * @param {HTMLCanvasElement} canvas het gelezen beeld
   * @returns {object[]} kandidaten; `ratios` = gelezen schaalaanduidingen "1:N"
   */
  function scaleCandidates(ocrWords, canvas) {
    // Tesseract geeft getallen met een komma ("10,00") met tekenwitlijst soms betrouwbaarheid 0; een getal
    // met eenheid telt daarom ook bij lage betrouwbaarheid, de maatlijn eromheen is dan het bewijs
    const words = ocrWords.filter((word) => word.text.trim());
    const gray = grayOf(canvas);
    const out = [];
    out.ratios = words.filter((word) => word.confidence > 40).map((word) => window.PlanImport && window.PlanImport.parseRatio(word.text)).filter(Boolean);
    words.forEach((word, i) => {
      const next = words[i + 1];
      const sameLine = next && Math.abs(next.bbox.y0 - word.bbox.y0) < (word.bbox.y1 - word.bbox.y0) && next.bbox.x0 - word.bbox.x1 < (word.bbox.y1 - word.bbox.y0) * 1.5;
      const readings = lengthReadings(word.text, sameLine ? next.text : null);
      if (!readings.length) return;
      const withUnit = /(mm|cm|m)$/i.test(word.text.trim()) || (sameLine && /^(mm|cm|m)$/i.test(next.text.trim()));
      if (word.confidence <= 40 && !withUnit) return;
      const unitWord = sameLine && /^(mm|cm|m)$/i.test(next.text.trim());
      const box = unitWord ? textBox(word, next) : textBox(word);
      if (!box) return;
      const line = measureLine(gray, canvas.width, canvas.height, box);
      if (!line) return;
      const text = `${word.text}${unitWord ? ' ' + next.text : ''}`;
      for (const reading of readings) out.push({ mpp: reading.meters / line.len, strong: reading.strong, text, meters: reading.meters, px: line.len, conf: word.confidence });
    });
    return out;
  }

  /**
   * Alle OCR-rondes: maten (cijfers, normaal + gedraaid) en labels (vrije tekst, normaal en zwart-wit,
   * recht en gedraaid).
   * @param {HTMLImageElement} image het beeld
   * @param {Function} onProgress voortgangsmelding (tekst)
   * @returns {Promise<{words: object[], scales: object[], ratios: number[]}>} woorden in originele coördinaten, maatkandidaten en schaalaanduidingen
   */
  async function readText(image, onProgress) {
    const worker = await getWorker();
    const imageHeight = image.naturalHeight || image.height;
    const passes = [
      { rotate: false, binary: false, digits: true, msg: 'Maten lezen…' },
      { rotate: true, binary: false, digits: true, msg: 'Verticale maten lezen…' },
      { rotate: false, binary: false, digits: false, msg: 'Teksten zoeken (gras, terras, border…)…' },
      { rotate: false, binary: true, digits: false, msg: 'Teksten zoeken (zwart-wit)…' },
      { rotate: true, binary: false, digits: false, msg: 'Verticale teksten zoeken…' },
      { rotate: true, binary: true, digits: false, msg: 'Verticale teksten zoeken (zwart-wit)…' },
    ];
    const words = [];
    const scales = [];
    const ratios = []; // schaalaanduiding "1:N"; bruikbaar als het papierformaat bekend is (PDF)
    for (const pass of passes) {
      onProgress && onProgress(pass.msg);
      const canvas = variant(image, pass.rotate, pass.binary);
      await worker.setParameters({
        tessedit_pageseg_mode: '11', // losse tekst verspreid over de tekening
        tessedit_char_whitelist: pass.digits ? '0123456789.,:/mMcC ' : '',
      });
      const { data } = await worker.recognize(canvas);
      const ocrWords = data.words || [];
      // de gemeten lijnlengte hangt niet af van de draaiing; de cijferronde is betrouwbaarder voor getallen
      const candidates = scaleCandidates(ocrWords, canvas);
      scales.push(...candidates.map((candidate) => ({ ...candidate, conf: candidate.conf + (pass.digits ? 10 : 0) })));
      ratios.push(...candidates.ratios);
      if (pass.digits) continue;
      for (const word of ocrWords) {
        if (word.confidence < 25 || !String(word.text).trim()) continue;
        words.push({ text: word.text, confidence: word.confidence, bbox: pass.rotate ? unrotate(word.bbox, imageHeight) : { ...word.bbox } });
      }
    }
    return { words, scales, ratios };
  }

  /**
   * Schaal van een beeld via tekstherkenning.
   * @param {HTMLImageElement} image het beeld
   * @param {Function} onProgress voortgangsmelding (tekst)
   * @returns {Promise<object|null>} de schaal, of null
   */
  async function findScale(image, onProgress) {
    const { scales, ratios } = await readText(image, onProgress);
    return scaleFrom(scales, ratios, image.naturalWidth || image.width);
  }

  /**
   * Schaal uit maatkandidaten; zonder bruikbare maat eventueel alleen de schaalaanduiding "1:N".
   * @param {object[]} scales maatkandidaten
   * @param {number[]} ratios schaalaanduidingen
   * @param {number} imageWidth beeldbreedte in pixels
   * @returns {object|null} de schaal, of null
   */
  function scaleFrom(scales, ratios, imageWidth) {
    const ratio = ratios[0] || null;
    // "1:100" zonder dubbele punt gelezen ("1100") is geen maat
    const noRatio = scales.filter((candidate) => candidate.strong || !ratios.some((ratioValue) => candidate.text.replace(/\D/g, '') === `1${ratioValue}`));
    const picked = pickScale(noRatio, imageWidth);
    if (!picked) return ratio ? { metersPerPixel: null, method: 'schatting', confidence: 'laag', evidence: `schaal 1:${ratio}`, ratio } : null;
    return { ...picked, ratio };
  }

  // ---------------------------------------------------------------- labels (gras, terras, …)

  /** Woorden per vlaksoort (Nederlands, Duits, Engels). */
  const VOCAB = {
    lawn: ['gras', 'gazon', 'grasveld', 'grasmat', 'speelgazon', 'rasen', 'rasenfläche', 'wiese', 'lawn', 'grass'],
    bed: ['border', 'borders', 'beplanting', 'plantvak', 'plantvakken', 'bloemen', 'bloemenborder', 'bloemperk', 'perk',
      'heesters', 'struiken', 'vasteplanten', 'planten', 'moestuin', 'kruidentuin', 'beet', 'beete', 'staudenbeet', 'blumen',
      'sträucher', 'flowers', 'shrubs', 'plants', 'flowerbed'],
    hedge: ['haag', 'heg', 'beukenhaag', 'ligusterhaag', 'taxushaag', 'coniferen', 'hecke', 'hedge'],
    planter: ['plantenbak', 'plantenbakken', 'bak', 'bakken', 'pot', 'potten', 'kuip', 'pflanzkübel', 'kübel', 'planter'],
    dry: ['terras', 'terrassen', 'woning', 'huis', 'woonhuis', 'schuur', 'tuinhuis', 'berging', 'garage', 'bestrating',
      'tegels', 'klinkers', 'pad', 'tuinpad', 'oprit', 'carport', 'veranda', 'overkapping', 'patio', 'vlonder', 'zitplek',
      'terrasse', 'haus', 'gebäude', 'weg', 'house', 'terrace', 'path', 'driveway', 'shed', 'deck'],
    wet: ['vijver', 'water', 'grind', 'grindpad', 'kiezel', 'kiezels', 'split', 'teich', 'kies', 'pond', 'gravel'],
  };
  const VOCAB_INDEX = [];
  for (const [type, words] of Object.entries(VOCAB)) for (const word of words) VOCAB_INDEX.push({ type, w: word.replace(/[^a-zäöüß]/g, '') });

  /**
   * Bewerkingsafstand (Levenshtein) tussen twee woorden.
   * @param {string} first eerste woord
   * @param {string} second tweede woord
   * @returns {number} aantal bewerkingen
   */
  function levenshtein(first, second) {
    const firstLength = first.length, secondLength = second.length;
    if (!firstLength) return secondLength;
    if (!secondLength) return firstLength;
    let prev = Array.from({ length: secondLength + 1 }, (_, j) => j);
    for (let i = 1; i <= firstLength; i++) {
      const current = [i];
      for (let j = 1; j <= secondLength; j++) current[j] = Math.min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + (first[i - 1] === second[j - 1] ? 0 : 1));
      prev = current;
    }
    return prev[secondLength];
  }

  /**
   * Woord (ook slordig/handgeschreven gelezen) naar vlaksoort, of null.
   * @param {string} text het gelezen woord
   * @returns {{type: string, word: string, d: number}|null} vlaksoort, het woord uit de woordenlijst en de afstand
   */
  function matchLabel(text) {
    const normalized = String(text).toLowerCase().replace(/[^a-zäöüß]/g, '');
    if (normalized.length < 3) return null;
    let best = null;
    for (const entry of VOCAB_INDEX) {
      // korte woorden exact; langere met 1–2 tekens speling (handschrift)
      const allowed = entry.w.length <= 4 ? 0 : entry.w.length <= 7 ? 1 : 2;
      if (Math.abs(entry.w.length - normalized.length) > allowed) continue;
      const distance = levenshtein(normalized, entry.w);
      if (distance <= allowed && (!best || distance < best.d)) best = { type: entry.type, word: entry.w, d: distance };
    }
    return best;
  }

  /**
   * Labels uit OCR-woorden; dezelfde tekst uit meerdere rondes wordt samengevoegd.
   * @param {object[]} words OCR-woorden
   * @returns {object[]} labels {type, text, conf, bbox}
   */
  function labelsFromWords(words) {
    const out = [];
    for (const word of words) {
      const match = matchLabel(word.text);
      if (!match) continue;
      const label = { type: match.type, text: word.text, conf: word.confidence - match.d * 15, bbox: word.bbox };
      const cx = (label.bbox.x0 + label.bbox.x1) / 2, cy = (label.bbox.y0 + label.bbox.y1) / 2;
      const duplicate = out.find((other) => cx >= other.bbox.x0 && cx <= other.bbox.x1 && cy >= other.bbox.y0 && cy <= other.bbox.y1);
      if (duplicate) {
        if (label.conf > duplicate.conf) Object.assign(duplicate, label);
        continue;
      }
      out.push(label);
    }
    return out;
  }

  /**
   * Vlak dat door getekende lijnen rond een label wordt omsloten (lijntekening of handschets).
   * Lijnen worden iets verdikt om kleine gaten in handgetekende lijnen te dichten.
   * @param {{gray: Uint8Array, w: number, h: number}} work grijswaarden op werkresolutie
   * @returns {{label: Int32Array, comps: object[], w: number, h: number, r: number}} vrije gebieden per pixel en hun gegevens
   */
  function enclosedRegions(work) {
    const { gray, w: width, h: height } = work;
    // achtergrondhelderheid = mediaan van de rand
    const edge = [];
    for (let x = 0; x < width; x += 4) edge.push(gray[x], gray[(height - 1) * width + x]);
    edge.sort((left, right) => left - right);
    const bgLum = edge[Math.floor(edge.length / 2)] || 255;
    const threshold = Math.min(170, bgLum - 55);
    let dark = new Uint8Array(width * height);
    for (let index = 0; index < dark.length; index++) dark[index] = gray[index] < threshold ? 1 : 0;
    const radius = Math.max(1, Math.round(Math.max(width, height) / 300));
    dark = morph(dark, width, height, radius, true);
    const free = new Uint8Array(width * height);
    for (let index = 0; index < free.length; index++) free[index] = dark[index] ? 0 : 1;
    const label = new Int32Array(width * height).fill(-1);
    const comps = [];
    const stack = [];
    for (let seed = 0; seed < free.length; seed++) {
      if (!free[seed] || label[seed] >= 0) continue;
      const id = comps.length;
      const pixels = [];
      let x0 = width, y0 = height, x1 = 0, y1 = 0, border = false;
      stack.push(seed); label[seed] = id;
      while (stack.length) {
        const index = stack.pop();
        pixels.push(index);
        const x = index % width, y = (index - x) / width;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border = true;
        for (const neighbour of [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y > 0 ? index - width : -1, y < height - 1 ? index + width : -1]) {
          if (neighbour >= 0 && free[neighbour] && label[neighbour] < 0) { label[neighbour] = id; stack.push(neighbour); }
        }
      }
      comps.push({ pix: pixels, x0, y0, x1, y1, border });
    }
    return { label, comps, w: width, h: height, r: radius };
  }

  /**
   * Het omsloten gebied rond een label, of null als het te klein, te groot of de achtergrond is.
   * @param {object} regions uitkomst van enclosedRegions
   * @param {{x0: number, y0: number, x1: number, y1: number}} box kader van het label (werkpixels)
   * @returns {object|null} het gebied
   */
  function regionForLabel(regions, box) {
    const { label, comps, w: width, h: height, r: radius } = regions;
    const boxWidth = box.x1 - box.x0, boxHeight = box.y1 - box.y0;
    const pad = Math.max(2 * radius + 2, Math.round(boxHeight * 0.6));
    const votes = new Map();
    /**
     * Telt het gebied onder een punt rond het label.
     * @param {number} x x in werkpixels
     * @param {number} y y in werkpixels
     */
    const vote = (x, y) => {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const id = label[y * width + x];
      if (id >= 0) votes.set(id, (votes.get(id) || 0) + 1);
    };
    for (let fraction = 0; fraction <= 1; fraction += 0.05) {
      vote(box.x0 - pad + fraction * (boxWidth + 2 * pad), box.y0 - pad);
      vote(box.x0 - pad + fraction * (boxWidth + 2 * pad), box.y1 + pad);
      vote(box.x0 - pad, box.y0 - pad + fraction * (boxHeight + 2 * pad));
      vote(box.x1 + pad, box.y0 - pad + fraction * (boxHeight + 2 * pad));
    }
    let best = -1, bestVotes = 0;
    for (const [id, count] of votes) if (count > bestVotes) { bestVotes = count; best = id; }
    if (best < 0) return null;
    const comp = comps[best];
    const share = comp.pix.length / (width * height);
    if (comp.pix.length < boxWidth * boxHeight * 3 || share > 0.7 || (comp.border && share > 0.25)) return null;
    return comp;
  }

  /**
   * Labels toepassen: type van gekleurde vlakken corrigeren, en lijnvlakken toevoegen.
   * @param {object[]} areas vlakken (worden aangepast)
   * @param {object[]} labels gelezen labels
   * @param {object} work werkbeeld (grijswaarden, maat, factor)
   * @returns {{retyped: number, added: number}} aantal gewijzigde en toegevoegde vlakken
   */
  function applyLabels(areas, labels, work) {
    const factor = work.f;
    let retyped = 0, added = 0;
    const named = new Set();
    const counters = {};
    labels.sort((left, right) => right.conf - left.conf);
    let regions = null;
    /**
     * Naam voor een vlak uit de tekst van het label.
     * @param {object} label het label
     * @returns {string} de naam
     */
    const nameOf = (label) => label.text.replace(/[^\p{L}]/gu, '').toLowerCase().replace(/^./, (firstChar) => firstChar.toUpperCase()) || Catalog.areaTypes[label.type].label;
    for (const label of labels) {
      const cx = (label.bbox.x0 + label.bbox.x1) / 2, cy = (label.bbox.y0 + label.bbox.y1) / 2;
      // kleinste gekleurde vlak waar het label in staat
      const hits = areas.filter((area) => Geo.pointInPolygon({ x: cx, y: cy }, area.points)).sort((left, right) => Geo.area(left.points) - Geo.area(right.points));
      if (hits.length) {
        const area = hits[0];
        if (named.has(area)) continue;
        named.add(area);
        if (area.type !== label.type) retyped++;
        area.type = label.type;
        area.name = nameOf(label);
        area.fromLabel = true;
        continue;
      }
      regions = regions || enclosedRegions(work);
      const box = { x0: label.bbox.x0 * factor, y0: label.bbox.y0 * factor, x1: label.bbox.x1 * factor, y1: label.bbox.y1 * factor };
      const comp = regionForLabel(regions, box);
      if (!comp || comp.used) continue;
      comp.used = true;
      const tolerance = Math.max(1.2, Math.max(work.w, work.h) / 450);
      const poly = componentPolygon(comp, work.w, tolerance, 0, regions.r + 1);
      if (!poly || poly.length < 3) continue;
      counters[label.type] = (counters[label.type] || 0) + 1;
      areas.push({ type: label.type, name: nameOf(label), points: poly.map((point) => ({ x: point.x / factor, y: point.y / factor })), fromLabel: true });
      added++;
    }
    return { retyped, added };
  }

  // ---------------------------------------------------------------- samen

  /**
   * Herkent een plan lokaal: vlakken, schaal en labels.
   * @param {{dataUrl: string, width: number, height: number}} analyzeImage de analyse-afbeelding
   * @param {Function} onProgress voortgangsmelding (tekst)
   * @param {{learned: object}} opts geleerde tellingen van de organisatie
   * @returns {Promise<object>} resultaat in hetzelfde formaat als /api/plan/analyze
   */
  async function analyze(analyzeImage, onProgress, opts = {}) {
    const image = await window.PlanImport.loadImage(analyzeImage.dataUrl);
    const notes = [];
    const { areas, coloredShare, learnedShare, work } = findAreas(image, onProgress, { learned: opts.learned });
    if (learnedShare > 0.01) notes.push(`Kleuren herkend met wat geleerd is van ${opts.learned.examples || 'eerdere'} herkende plannen (${Math.round(learnedShare * 100)}% van het beeld).`);
    let labelStats = { retyped: 0, added: 0 }, labels = [], scale = null;
    try {
      const { words, scales, ratios } = await readText(image, onProgress);
      scale = scaleFrom(scales, ratios, image.naturalWidth || image.width);
      // gekleurde "vlakjes" die op een gelezen woord liggen zijn tekst (gekleurde inkt), geen vlak
      const imageWidth = image.naturalWidth || image.width, imageHeight = image.naturalHeight || image.height;
      const textBoxes = words.map((word) => word.bbox).filter((box) => box.y1 - box.y0 < imageHeight * 0.08 && box.x1 - box.x0 < imageWidth * 0.4);
      for (let i = areas.length - 1; i >= 0; i--) {
        const areaBox = Geo.bbox(areas[i].points);
        const isText = textBoxes.some((box) => {
          const margin = (box.y1 - box.y0) * 0.5; // marge van een halve letterhoogte
          return areaBox.minX >= box.x0 - margin && areaBox.maxX <= box.x1 + margin && areaBox.minY >= box.y0 - margin && areaBox.maxY <= box.y1 + margin;
        });
        // kleine blauwe vlekjes zijn bij pen-/inkttekeningen vrijwel altijd lijnen of tekst, geen vijver
        const tinyWet = areas[i].type === 'wet' && Geo.area(areas[i].points) < imageWidth * imageHeight * 0.004;
        if (isText || tinyWet) areas.splice(i, 1);
      }
      labels = labelsFromWords(words);
      labelStats = applyLabels(areas, labels, work);
    } catch (error) {
      notes.push(`Teksten lezen lukte niet (${error.message}).`);
    }
    if (labelStats.added || labelStats.retyped) {
      notes.push(`${labels.length} label(s) gelezen: ${labelStats.added} vlak(ken) uit lijnen rond een label gehaald, ${labelStats.retyped} vlak(ken) van type veranderd.`);
    }
    if (coloredShare < 0.05 && !labelStats.added) notes.push('Het plan bevat weinig kleur en geen leesbare labels als "gras" of "terras". Trek de vlakken uit met de toverstaf of teken ze zelf.');
    return {
      scale: scale || { metersPerPixel: null, method: 'schatting', confidence: 'laag', evidence: '' },
      areas,
      elements: [],
      notes: notes.join(' '),
      local: true,
    };
  }

  window.LocalRecognizer = {
    analyze, learn, samplesFromPixels, featureKey, FEATURE_VERSION, classify, parseLength, lengthReadings, pickScale, measureLine, findAreas, findScale, areasFromPixels,
    readText, matchLabel, labelsFromWords, enclosedRegions, regionForLabel, applyLabels, _internal: { paperModel, normalizedColors, classMap },
  };
})();
