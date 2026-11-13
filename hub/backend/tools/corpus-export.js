// Exporteert het meetcorpus van de planherkenning (tekeningen + goedgekeurde eindplannen van organisaties die
// "Tekeningen bewaren" aanzetten) naar een map met `naam.png` + `naam.json`, de invoer van tools/recog-bench.js.
// Draait op de server waar de database en de hoofdsleutel staan (zoals src/backup.js):
//   docker compose exec aquatech node tools/corpus-export.js <doelmap> [organisatiecode]
// De doelmap bevat klantgegevens (tekeningen): bewaar hem niet in de repository.
const fs = require('fs');
const path = require('path');
const { createVault, loadOrCreateMasterKey } = require('../src/beveiliging/vault');
const { openDatabase } = require('../src/database/db');
const { createRecognitionStore } = require('../src/beregening/recognitions');

/**
 * Schrijft het corpus van de gekozen organisaties naar een map.
 * @param {object} options db (geopende database), vault, directory (doelmap) en slug (alleen deze organisatie, leeg = alle).
 * @returns {{ written: number, skipped: number }} Aantal geschreven tekeningen en het aantal dat niet te ontsleutelen was.
 */
function exportCorpus({ db, vault, directory, slug = '' }) {
  const recognitions = createRecognitionStore(db);
  const tenants = db.prepare('SELECT id, slug FROM tenants ORDER BY slug').all().filter((tenant) => !slug || tenant.slug === slug);
  fs.mkdirSync(directory, { recursive: true });
  let written = 0, skipped = 0;
  for (const tenant of tenants) {
    let afterId = '';
    for (;;) {
      const rows = recognitions.corpusRows(tenant.id, { afterId, limit: 20 });
      if (!rows.length) break;
      for (const row of rows) {
        afterId = row.id;
        let bytes;
        try { bytes = vault.openBytes(row.sealedImage, `${tenant.id}:plan-corpus:${row.planId}`); } catch { skipped++; continue; }
        const name = `${tenant.slug}-${row.id.slice(0, 8)}`;
        fs.writeFileSync(path.join(directory, `${name}.png`), bytes);
        fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify({ width: row.width, height: row.height, ...row.finalPlan }, null, 2));
        written++;
      }
    }
  }
  return { written, skipped };
}

module.exports = { exportCorpus };

if (require.main === module) {
  const [target, slug] = process.argv.slice(2);
  if (!target) {
    console.error('Gebruik: node tools/corpus-export.js <doelmap> [organisatiecode]');
    process.exit(2);
  }
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data');
  if (!process.env.AQUATECH_MASTER_KEY_FILE && !process.env.AQUATECH_MASTER_KEY && !fs.existsSync(path.join(dataDir, 'master-key'))) {
    console.error('Geen hoofdsleutel gevonden (AQUATECH_MASTER_KEY_FILE, AQUATECH_MASTER_KEY of DATA_DIR/master-key).');
    process.exit(1);
  }
  const vault = createVault(loadOrCreateMasterKey(dataDir).key);
  const result = exportCorpus({ db: openDatabase(dataDir), vault, directory: path.resolve(target), slug: slug || '' });
  console.log(`${result.written} tekening(en) geëxporteerd naar ${path.resolve(target)}${result.skipped ? `, ${result.skipped} overgeslagen (niet te ontsleutelen)` : ''}`);
  process.exit(0);
}
