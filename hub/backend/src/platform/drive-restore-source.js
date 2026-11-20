// Back-ups van Google Drive als bron voor "Terugzetten uit een back-up" (backup-restore-routes.js): de gekozen back-up
// wordt één keer opgehaald naar een tijdelijke map in de back-upmap (niet in het geheugen) en daar een kwartier bewaard,
// zodat zoeken, voorbeeld en terugzetten niet elke keer opnieuw downloaden. Daarna, bij een nieuwe start van de app en bij
// een fout wordt alles opgeruimd; het bestand is alleen voor de eigenaar leesbaar en blijft versleuteld.
const fs = require('fs');
const path = require('path');

const PREFIX = 'drive:';
const DIR_PREFIX = '.drive-restore-cache-';
const TTL_MS = 15 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

/**
 * Of een bronnaam van Google Drive komt (voorvoegsel "drive:").
 * @param {*} value De gekozen back-up uit het verzoek.
 * @returns {boolean} True als de back-up van Drive moet komen.
 */
const isDriveName = (value) => typeof value === 'string' && value.startsWith(PREFIX);

/**
 * Maakt de bron voor terugzetten vanaf Google Drive.
 * @param {object} options driveBackup (platform/drive-backup.js), backupDir en now/ttlMs (alleen tests).
 * @returns {{ use: Function, sweep: Function, close: Function }} use(name, callback), sweep() en close().
 */
function createDriveRestoreSource({ driveBackup, backupDir, now = () => Date.now(), ttlMs = TTL_MS }) {
  const entries = new Map();

  // Resten van een eerdere run (bijv. na een herstart midden in het terugzetten) opruimen.
  if (backupDir && fs.existsSync(backupDir)) {
    for (const entry of fs.readdirSync(backupDir)) {
      if (entry.startsWith(DIR_PREFIX)) fs.rmSync(path.join(backupDir, entry), { recursive: true, force: true });
    }
  }

  /**
   * Verwijdert een bewaarde back-up van schijf.
   * @param {string} name De bestandsnaam.
   * @returns {void}
   */
  function drop(name) {
    const entry = entries.get(name);
    entries.delete(name);
    if (entry) fs.rmSync(entry.dir, { recursive: true, force: true });
  }

  /**
   * Haalt een back-up van Drive op (of hergebruikt de bewaarde) en geeft de map en naam door aan de functie.
   * @param {string} source De bron zoals de browser hem stuurt: "drive:<bestandsnaam>".
   * @param {Function} callback Krijgt { dir, name } en geeft het resultaat terug.
   * @returns {Promise<*>} Wat de functie teruggeeft.
   * @throws {DriveError} Als de back-up niet op Drive staat of niet op te halen is.
   */
  async function use(source, callback) {
    const name = String(source).slice(PREFIX.length);
    let entry = entries.get(name);
    if (!entry) {
      const dir = fs.mkdtempSync(path.join(backupDir, DIR_PREFIX));
      entry = { dir, users: 0, expiresAt: 0, ready: null };
      entry.ready = driveBackup.download(name, dir);
      entries.set(name, entry);
    }
    entry.users += 1;
    try {
      try {
        await entry.ready;
      } catch (error) {
        if (entries.get(name) === entry) drop(name);
        throw error;
      }
      return await callback({ dir: entry.dir, name });
    } finally {
      entry.users -= 1;
      entry.expiresAt = now() + ttlMs;
    }
  }

  /**
   * Ruimt bewaarde back-ups op die niet in gebruik zijn en verlopen zijn.
   * @returns {void}
   */
  function sweep() {
    for (const [name, entry] of entries) {
      if (entry.users === 0 && entry.expiresAt && entry.expiresAt <= now()) drop(name);
    }
  }

  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref();

  /**
   * Stopt het opruimen en wist alles (voor de tests en het afsluiten).
   * @returns {void}
   */
  function close() {
    clearInterval(timer);
    for (const name of [...entries.keys()]) drop(name);
  }

  return { use, sweep, close };
}

module.exports = { createDriveRestoreSource, isDriveName, PREFIX };
