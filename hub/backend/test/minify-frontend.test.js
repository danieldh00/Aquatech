// Test van de minify-stap voor de release-image: het verkleinde resultaat moet
// parsen, vendor-bestanden moeten ongewijzigd blijven en de bestanden die de
// server of een sandbox laadt (UMD) moeten dezelfde globale namen geven.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const FRONTEND_DIR = path.resolve(__dirname, '..', '..', 'frontend');
const TOOL = path.resolve(__dirname, '..', 'tools', 'minify-frontend.js');

/**
 * Geeft alle bestanden onder een map terug als relatieve paden.
 * @param {string} directory de map om te doorlopen
 * @param {string} rootDir de hoofdmap voor de relatieve paden
 * @returns {string[]} relatieve paden
 */
function listFiles(directory, rootDir = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath, rootDir) : [path.relative(rootDir, fullPath)];
  });
}

/**
 * Laadt een script in een lege sandbox en geeft de globale variabelen terug.
 * @param {string} filePath pad van het script
 * @returns {object} de sandbox na het uitvoeren
 */
function loadInSandbox(filePath) {
  const sandbox = { window: {}, console };
  sandbox.self = sandbox.window;
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(filePath, 'utf8'), { filename: filePath }).runInContext(sandbox);
  return sandbox;
}

test('minify-frontend: parsen, vendor ongewijzigd, UMD-namen gelijk', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatech-min-'));
  try {
    execFileSync('node', [TOOL, FRONTEND_DIR, outputDir], { stdio: 'pipe' });
    const sourceFiles = listFiles(FRONTEND_DIR);
    assert.deepStrictEqual(listFiles(outputDir).sort(), sourceFiles.sort());
    for (const file of sourceFiles) {
      const sourcePath = path.join(FRONTEND_DIR, file);
      const outputPath = path.join(outputDir, file);
      const untouched = file.split(path.sep).includes('vendor') || file.includes('.min.');
      if (file.endsWith('.js') && !untouched) {
        assert.doesNotThrow(() => new vm.Script(fs.readFileSync(outputPath, 'utf8')), `parsen van ${file}`);
      }
      if (untouched || !/\.(js|css)$/.test(file)) {
        assert.ok(fs.readFileSync(sourcePath).equals(fs.readFileSync(outputPath)), `${file} moet gelijk blijven`);
      }
    }
    for (const file of ['shared/roles.js', 'offertes/quote-core.js']) {
      const fromSource = Object.keys(loadInSandbox(path.join(FRONTEND_DIR, file))).sort();
      const fromMinified = Object.keys(loadInSandbox(path.join(outputDir, file))).sort();
      assert.deepStrictEqual(fromMinified, fromSource, `globale namen van ${file}`);
    }
    for (const file of ['shared/roles.js', 'offertes/quote-core.js']) {
      assert.deepStrictEqual(
        Object.keys(require(path.join(outputDir, file))).sort(),
        Object.keys(require(path.join(FRONTEND_DIR, file))).sort(),
        `exports van ${file}`,
      );
    }
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
