// Releasenotes van dit image als JSON, voor het updatescript op de host (deploy/apps01/update.sh). Dat draait dit
// bestand in het nieuwe image (zonder netwerk, als gewone gebruiker) en zet de uitvoer in releases.json, zodat Beheer >
// Updates vóór het installeren laat zien wat er verandert (zie src/platform/system-update.js).
//
//   node tools/release-info.js [vanaf-versie]
//
// Geeft { version, releases } met de versies die nieuwer zijn dan vanaf-versie (zonder: de laatste 30), nieuwste eerst.
const path = require('path');
const Releases = require(path.join(__dirname, '..', '..', 'frontend', 'nieuws', 'releases.js'));
const { version } = require('../package.json');

const MAX_RELEASES = 30;

/**
 * Bouwt de uitvoer: alleen versies met zichtbare punten, nieuwer dan de opgegeven versie.
 * @param {string} [since] Versie die nu draait (leeg = alles tot het maximum).
 * @returns {{ version: string, releases: object[] }} De releasenotes.
 */
function releaseInfo(since) {
  const releases = Releases.RELEASES
    .filter((release) => release.items.length && (!since || Releases.compare(release.version, since) > 0))
    .slice(0, MAX_RELEASES)
    .map((release) => ({ version: release.version, date: release.date, title: release.title, items: release.items.map((item) => ({ text: item.text })) }));
  return { version, releases };
}

if (require.main === module) {
  const since = /^\d+\.\d+\.\d+$/.test(process.argv[2] || '') ? process.argv[2] : '';
  process.stdout.write(`${JSON.stringify(releaseInfo(since))}\n`);
}

module.exports = { releaseInfo };
