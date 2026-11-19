// Minify-stap voor de release-image: kopieert de map frontend/ naar een
// uitvoermap en verkleint daarbij elk eigen .js- en .css-bestand (geen
// vendor/, geen bestanden die al .min. heten). De broncode in de repo blijft
// leesbaar. Alleen witruimte, commentaar en syntaxis worden verkleind; namen
// van globale variabelen blijven gelijk omdat de pagina's gewone scripts zijn.
// Gebruik: `node tools/minify-frontend.js <bronmap> <uitvoermap>`.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

/**
 * Bepaalt of een bestand verkleind moet worden.
 * @param {string} relativePath pad van het bestand binnen de frontendmap
 * @returns {string|null} 'js', 'css' of null als het bestand ongewijzigd blijft
 */
function minifyKind(relativePath) {
  const parts = relativePath.split(path.sep);
  if (parts.includes('vendor')) return null;
  const name = parts[parts.length - 1];
  if (name.includes('.min.')) return null;
  if (name.endsWith('.js')) return 'js';
  if (name.endsWith('.css')) return 'css';
  return null;
}

/**
 * Kopieert een map recursief en verkleint de bestanden waar dat kan.
 * @param {string} sourceDir bronmap
 * @param {string} targetDir uitvoermap
 * @param {string} rootDir hoofdmap van de bron, voor relatieve paden
 * @param {{files: number, before: number, after: number}} totals tellers die worden bijgewerkt
 * @returns {void}
 */
function copyMinified(sourceDir, targetDir, rootDir, totals) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyMinified(sourcePath, targetPath, rootDir, totals);
      continue;
    }
    const kind = minifyKind(path.relative(rootDir, sourcePath));
    if (!kind) {
      fs.copyFileSync(sourcePath, targetPath);
      continue;
    }
    const source = fs.readFileSync(sourcePath, 'utf8');
    let result;
    try {
      result = esbuild.transformSync(source, {
        loader: kind,
        minify: true,
        legalComments: 'none',
        target: kind === 'js' ? 'es2020' : 'chrome90',
        sourcefile: entry.name,
      });
    } catch (error) {
      throw new Error(`Verkleinen mislukt voor ${sourcePath}: ${error.message}`, { cause: error });
    }
    fs.writeFileSync(targetPath, result.code);
    totals.files += 1;
    totals.before += Buffer.byteLength(source);
    totals.after += Buffer.byteLength(result.code);
  }
}

/**
 * Leest de opdrachtregel en draait de minify-stap.
 * @returns {void}
 */
function main() {
  const [sourceDir, targetDir] = process.argv.slice(2);
  if (!sourceDir || !targetDir) {
    console.error('Gebruik: node tools/minify-frontend.js <bronmap> <uitvoermap>');
    process.exit(1);
  }
  const totals = { files: 0, before: 0, after: 0 };
  copyMinified(path.resolve(sourceDir), path.resolve(targetDir), path.resolve(sourceDir), totals);
  console.log(`Verkleind: ${totals.files} bestanden, ${totals.before} -> ${totals.after} bytes`);
}

main();
