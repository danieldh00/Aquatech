// Testbank voor de lokale planherkenning (zonder AI). Leest een map met tekeningen
// (`naam.png`) en per tekening een referentie (`naam.json`: de AI-uitkomst of het
// goedgekeurde plan in het formaat van plan-analyzer.js, coördinaten in beeldpixels:
// { "areas": [{ "type": "lawn", "points": [{ "x": 0, "y": 0 }, ...] }] }),
// draait de lokale vlakherkenning en toont per tekening hoe goed die overeenkomt.
// Gebruik: `npm run recog-bench` (map backend/test/fixtures) of
// `node tools/recog-bench.js <map> [--json]`. Geen netwerk, geen AI-aanroepen.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readPng } = require('../test/helpers/png');
const Metrics = require('../src/beregening/recog-metrics');
const { FRONTEND_DIR } = require('../src/paths');

const PLANNER_DIR = path.join(FRONTEND_DIR, 'beregening', 'js');
const DEFAULT_DIR = path.join(__dirname, '..', 'test', 'fixtures');
const SCRIPTS = ['geometry.js', 'sprinklerlib.js', 'catalog.js', 'autotrace.js', 'simulation.js', 'planner.js', 'planimport.js', 'concept.js', 'localrecog.js'];
/** Werkresolutie van de browser (localrecog.js WORK_MAX). */
const WORK_MAX = 1000;

/**
 * Laadt de planner-scripts in een afgesloten omgeving, zoals de browser ze gebruikt.
 * @returns {object} Het window-object met LocalRecognizer.
 */
function loadRecognizer() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  for (const file of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(PLANNER_DIR, file), 'utf8'), sandbox);
  return sandbox.window;
}

/**
 * Verkleint RGBA-pixels met een gemiddelde per blok tot de werkresolutie van de browser.
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} image De tekening.
 * @returns {{ data: Uint8ClampedArray, width: number, height: number, factor: number }} Pixels op werkresolutie en werk-px per beeld-px.
 */
function toWorkResolution(image) {
  const factor = Math.min(1, WORK_MAX / Math.max(image.width, image.height));
  if (factor === 1) return { data: image.data, width: image.width, height: image.height, factor };
  const width = Math.max(1, Math.round(image.width * factor));
  const height = Math.max(1, Math.round(image.height * factor));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const sourceTop = Math.floor(row / factor), sourceBottom = Math.max(sourceTop + 1, Math.min(image.height, Math.floor((row + 1) / factor)));
    for (let column = 0; column < width; column++) {
      const sourceLeft = Math.floor(column / factor), sourceRight = Math.max(sourceLeft + 1, Math.min(image.width, Math.floor((column + 1) / factor)));
      const sums = [0, 0, 0, 0];
      let count = 0;
      for (let sourceRow = sourceTop; sourceRow < sourceBottom; sourceRow++) {
        for (let sourceColumn = sourceLeft; sourceColumn < sourceRight; sourceColumn++) {
          const offset = (sourceRow * image.width + sourceColumn) * 4;
          for (let channel = 0; channel < 4; channel++) sums[channel] += image.data[offset + channel];
          count++;
        }
      }
      for (let channel = 0; channel < 4; channel++) data[(row * width + column) * 4 + channel] = sums[channel] / Math.max(1, count);
    }
  }
  return { data, width, height, factor };
}

/**
 * Draait de bank over een map.
 * @param {string} directory Map met `naam.png` + `naam.json`.
 * @param {object} [recognizerWindow] Geladen planner-scripts (standaard: nieuw geladen).
 * @returns {{ rows: object[], summary: object }} Resultaat per tekening en samenvatting.
 */
function runBench(directory, recognizerWindow = loadRecognizer()) {
  const rows = [];
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.png')).sort()) {
    const name = file.slice(0, -4);
    const referenceFile = path.join(directory, `${name}.json`);
    if (!fs.existsSync(referenceFile)) continue;
    const reference = JSON.parse(fs.readFileSync(referenceFile, 'utf8'));
    const image = readPng(path.join(directory, file));
    const work = toWorkResolution(image);
    const started = Date.now();
    const found = recognizerWindow.LocalRecognizer.areasFromPixels(work.data, work.width, work.height, work.factor);
    const comparison = Metrics.compareAreas(reference.areas, found.areas, image.width, image.height);
    rows.push({ name, width: image.width, height: image.height, ms: Date.now() - started, ...comparison });
  }
  return { rows, summary: Metrics.summarize(rows) };
}

/**
 * Een getal als percentage voor de tabel.
 * @param {number|null} value Fractie.
 * @returns {string} Bijvoorbeeld "87%", of "-" bij geen waarde.
 */
const percent = (value) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : '-');

/**
 * Drukt de uitkomst af als tabel.
 * @param {{ rows: object[], summary: object }} result De uitkomst van runBench.
 */
function printReport(result) {
  console.log('tekening'.padEnd(34), 'gazon-IoU'.padStart(10), 'juist'.padStart(7), 'functie'.padStart(8), 'gazon x'.padStart(8), 'ms'.padStart(6), 'mist / extra');
  for (const row of result.rows) {
    const ratio = typeof row.lawnRatio === 'number' ? row.lawnRatio.toFixed(2) : '-';
    console.log(row.name.padEnd(34), percent(row.lawnIou).padStart(10), percent(row.accuracy).padStart(7), percent(row.functionalAccuracy).padStart(8), ratio.padStart(8), String(row.ms).padStart(6), `${row.missing.join(',') || '-'} / ${row.extra.join(',') || '-'}`);
  }
  const { summary } = result;
  console.log(`\n${summary.drawings} tekening(en): gemiddeld gazon-overlap ${percent(summary.meanLawnIou)}, juist ${percent(summary.meanAccuracy)}, functie ${percent(summary.meanFunctionalAccuracy)}, gazon goed gevonden in ${summary.lawnFound}/${summary.drawings}`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const directory = path.resolve(args.find((argument) => !argument.startsWith('--')) || DEFAULT_DIR);
  if (!fs.existsSync(directory)) {
    console.error(`Map niet gevonden: ${directory}`);
    process.exit(1);
  }
  const result = runBench(directory);
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else printReport(result);
}

module.exports = { runBench, toWorkResolution, loadRecognizer };
