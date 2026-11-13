// Meetlat voor de planherkenning: vergelijkt wat de lokale herkenning vindt met een
// referentie (de AI-uitkomst of het door een mens goedgekeurde plan). Zuivere
// functies zonder database of canvas, zodat de testbank (tools/recog-bench.js) en
// de tests ze kunnen gebruiken. Alle coördinaten zijn beeldpixels.

/** Vlaksoorten, in dezelfde volgorde als de AI-uitvoer (plan-analyzer.js). */
const AREA_TYPES = ['lawn', 'bed', 'hedge', 'planter', 'wet', 'dry'];
/** Bij overlap wint het vlak dat later in deze lijst staat (terras en water liggen "boven" het gazon). Een vlak met een eigen `layer` (getal) gaat daarvoor: een hogere laag ligt boven een lagere. Meng binnen één lijst geen vlakken met en zonder `layer`: de volgorde tussen die twee is dan niet zinvol. */
const DRAW_ORDER = ['lawn', 'bed', 'hedge', 'planter', 'wet', 'dry'];
/** Wat de beregening ermee doet: gazon = sproeiers, beplanting = druppel, verharding en water = geen beregening. Bed en haag verwarren maakt voor het ontwerp geen verschil. */
const FUNCTION_OF = { lawn: 'sprinkler', bed: 'drip', hedge: 'drip', planter: 'drip', wet: 'none', dry: 'none' };
/** Aantal cellen langs de lange zijde van het raster. */
const GRID_CELLS = 160;

/**
 * Zegt of een punt binnen een veelhoek ligt (even-oneven regel).
 * @param {number} pointX Horizontale positie.
 * @param {number} pointY Verticale positie.
 * @param {Array<{x: number, y: number}>} points Hoekpunten van de veelhoek.
 * @returns {boolean} True als het punt erin ligt.
 */
function insidePolygon(pointX, pointY, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const current = points[index], before = points[previous];
    if ((current.y > pointY) !== (before.y > pointY)
      && pointX < ((before.x - current.x) * (pointY - current.y)) / (before.y - current.y) + current.x) inside = !inside;
  }
  return inside;
}

/**
 * Hoogte van een vlak in de tekenvolgorde: de eigen `layer` als die er is, anders de plek van de soort in DRAW_ORDER.
 * @param {{type: string, layer?: number}} area Het vlak.
 * @returns {number} De laag (hoger ligt boven lager).
 */
function layerOf(area) {
  return typeof area.layer === 'number' ? area.layer : DRAW_ORDER.indexOf(area.type);
}

/**
 * Zet vlakken om naar een raster met per cel de vlaksoort (0 = niets).
 * @param {Array<{type: string, points: Array<{x: number, y: number}>}>} areas De vlakken.
 * @param {number} width Breedte van de tekening in pixels.
 * @param {number} height Hoogte van de tekening in pixels.
 * @returns {{ cells: Uint8Array, columns: number, rows: number }} Per cel de index in AREA_TYPES + 1, of 0.
 */
function rasterize(areas, width, height) {
  const cellSize = Math.max(width, height) / GRID_CELLS;
  const columns = Math.max(1, Math.ceil(width / cellSize));
  const rows = Math.max(1, Math.ceil(height / cellSize));
  const cells = new Uint8Array(columns * rows);
  const ordered = (areas || [])
    .filter((area) => AREA_TYPES.includes(area.type) && Array.isArray(area.points) && area.points.length >= 3)
    .sort((left, right) => layerOf(left) - layerOf(right));
  for (const area of ordered) {
    const code = AREA_TYPES.indexOf(area.type) + 1;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of area.points) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    }
    const firstColumn = Math.max(0, Math.floor(minX / cellSize)), lastColumn = Math.min(columns - 1, Math.floor(maxX / cellSize));
    const firstRow = Math.max(0, Math.floor(minY / cellSize)), lastRow = Math.min(rows - 1, Math.floor(maxY / cellSize));
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        if (insidePolygon((column + 0.5) * cellSize, (row + 0.5) * cellSize, area.points)) cells[row * columns + column] = code;
      }
    }
  }
  return { cells, columns, rows };
}

/**
 * Oppervlakte (in rastercellen) van een soort in een raster.
 * @param {Uint8Array} cells Het raster.
 * @param {string} type De vlaksoort.
 * @returns {number} Aantal cellen.
 */
function countCells(cells, type) {
  const code = AREA_TYPES.indexOf(type) + 1;
  let count = 0;
  for (const value of cells) if (value === code) count++;
  return count;
}

/**
 * Vergelijkt de gevonden vlakken met de referentie.
 * @param {object[]} reference De referentievlakken ({type, points}).
 * @param {object[]} found De door de lokale herkenning gevonden vlakken.
 * @param {number} width Breedte van de tekening in pixels.
 * @param {number} height Hoogte van de tekening in pixels.
 * @returns {{ iou: object, lawnIou: number|null, accuracy: number|null, functionalAccuracy: number|null, lawnRatio: number|null, missing: string[], extra: string[], counts: object }}
 *   iou per soort (null als noch referentie noch uitkomst de soort heeft), lawnIou = overlap van het gazon,
 *   accuracy = aandeel cellen binnen de referentie met dezelfde soort, functionalAccuracy = idem als bed/haag/plantenbak als één soort tellen (zo wordt het ontwerp beregend), lawnRatio = gazonoppervlak gevonden / referentie,
 *   missing = soorten die wel in de referentie staan maar niet gevonden zijn, extra = andersom, counts = aantal vlakken per soort.
 */
function compareAreas(reference, found, width, height) {
  const expected = rasterize(reference, width, height).cells;
  const actual = rasterize(found, width, height).cells;
  const iou = {};
  const missing = [];
  const extra = [];
  for (const type of AREA_TYPES) {
    const code = AREA_TYPES.indexOf(type) + 1;
    let both = 0, either = 0, expectedCount = 0, actualCount = 0;
    for (let index = 0; index < expected.length; index++) {
      const isExpected = expected[index] === code, isActual = actual[index] === code;
      if (isExpected && isActual) both++;
      if (isExpected || isActual) either++;
      if (isExpected) expectedCount++;
      if (isActual) actualCount++;
    }
    iou[type] = either ? both / either : null;
    if (expectedCount && !actualCount) missing.push(type);
    if (!expectedCount && actualCount) extra.push(type);
  }
  let covered = 0, correct = 0;
  for (let index = 0; index < expected.length; index++) {
    if (!expected[index]) continue;
    covered++;
    if (expected[index] === actual[index]) correct++;
  }
  let functionalCorrect = 0;
  for (let index = 0; index < expected.length; index++) {
    if (expected[index] && FUNCTION_OF[AREA_TYPES[expected[index] - 1]] === (actual[index] ? FUNCTION_OF[AREA_TYPES[actual[index] - 1]] : '')) functionalCorrect++;
  }
  const expectedLawn = countCells(expected, 'lawn');
  const counts = {};
  for (const type of AREA_TYPES) {
    counts[type] = { reference: (reference || []).filter((area) => area.type === type).length, found: (found || []).filter((area) => area.type === type).length };
  }
  return {
    iou,
    lawnIou: iou.lawn,
    accuracy: covered ? correct / covered : null,
    functionalAccuracy: covered ? functionalCorrect / covered : null,
    lawnRatio: expectedLawn ? countCells(actual, 'lawn') / expectedLawn : null,
    missing,
    extra,
    counts,
  };
}

/**
 * Afwijking van de schaal: gevonden meter per pixel t.o.v. de referentie.
 * @param {number|null} referenceMetersPerPixel Schaal van de referentie.
 * @param {number|null} foundMetersPerPixel Schaal van de uitkomst.
 * @returns {number|null} Relatieve fout (0,1 = 10% te groot), of null als een van beide ontbreekt.
 */
function scaleError(referenceMetersPerPixel, foundMetersPerPixel) {
  if (!(referenceMetersPerPixel > 0) || !(foundMetersPerPixel > 0)) return null;
  return foundMetersPerPixel / referenceMetersPerPixel - 1;
}

/**
 * Afstand tussen dezelfde soort elementen (bron, ventielkast, regelaar) als aandeel van de diagonaal van de tekening.
 * @param {Array<{kind: string, x: number, y: number}>} reference De referentie-elementen.
 * @param {Array<{kind: string, x: number, y: number}>} found De gevonden elementen.
 * @param {number} width Breedte van de tekening in pixels.
 * @param {number} height Hoogte van de tekening in pixels.
 * @returns {object} Per soort die in de referentie staat de afstand (0 = precies goed), of null als de uitkomst hem mist.
 */
function elementDistances(reference, found, width, height) {
  const diagonal = Math.hypot(width, height) || 1;
  const distances = {};
  for (const element of reference || []) {
    const candidates = (found || []).filter((other) => other.kind === element.kind);
    distances[element.kind] = candidates.length
      ? Math.min(...candidates.map((other) => Math.hypot(other.x - element.x, other.y - element.y) / diagonal))
      : null;
  }
  return distances;
}

/**
 * Vat de uitkomsten van meerdere tekeningen samen.
 * @param {Array<{ lawnIou: number|null, accuracy: number|null, functionalAccuracy?: number|null }>} results Uitkomsten van compareAreas.
 * @returns {{ drawings: number, meanLawnIou: number|null, meanAccuracy: number|null, meanFunctionalAccuracy: number|null, lawnFound: number }}
 *   Gemiddelden (alleen over tekeningen waar de waarde bestaat) en het aantal tekeningen waarin het gazon is gevonden (overlap > 0,5).
 */
function summarize(results) {
  /**
   * Gemiddelde van de bestaande waarden.
   * @param {Array<number|null>} values De waarden.
   * @returns {number|null} Gemiddelde, of null als er geen waarde is.
   */
  const mean = (values) => {
    const present = values.filter((value) => typeof value === 'number');
    return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
  };
  return {
    drawings: results.length,
    meanLawnIou: mean(results.map((result) => result.lawnIou)),
    meanAccuracy: mean(results.map((result) => result.accuracy)),
    meanFunctionalAccuracy: mean(results.map((result) => result.functionalAccuracy)),
    lawnFound: results.filter((result) => result.lawnIou !== null && result.lawnIou > 0.5).length,
  };
}

module.exports = { AREA_TYPES, insidePolygon, rasterize, compareAreas, scaleError, elementDistances, summarize };
