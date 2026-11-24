// Bewaart een geopende back-up (het tijdelijke schema met alle tabellen, zie backup-restore.js openBackup) kort, zodat
// bladeren, zoeken, een voorbeeld en terugzetten niet elke keer de hele back-up opnieuw ontsleutelen en inlezen (audit T-09).
// Zelfde patroon als de Drive-bron (drive-restore-source.js): teller van gebruikers, verlooptijd, elke minuut opruimen.
// Een back-up is alleen-lezen; een mislukte opening wordt niet bewaard.

const TTL_MS = 5 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

/**
 * Maakt de cache voor geopende back-ups.
 * @param {{ ttlMs?: number, sweepMs?: number, now?: Function }} [options] Bewaartijd, opruiminterval en klok (alleen tests).
 * @returns {{ use: Function, drop: Function, sweep: Function, size: Function, close: Function }} De functies van de cache.
 */
function createBackupOpenCache({ ttlMs = TTL_MS, sweepMs = SWEEP_MS, now = () => Date.now() } = {}) {
  const entries = new Map();

  /**
   * Sluit een bewaarde back-up (wist het tijdelijke schema en bestand).
   * @param {object} entry Het bewaarde item.
   * @returns {Promise<void>}
   */
  async function closeEntry(entry) {
    try {
      const opened = await entry.opened;
      opened.close();
    } catch { /* de opening mislukte: er is niets te sluiten */ }
  }

  /**
   * Verwijdert een back-up uit de cache; is hij nog in gebruik, dan sluit hij zodra de laatste gebruiker klaar is.
   * @param {string} key De sleutel (bronnaam van de back-up).
   * @returns {void}
   */
  function drop(key) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    if (entry.users === 0) closeEntry(entry);
    else entry.doomed = true;
  }

  /**
   * Geeft de geopende back-up aan de functie; opent hem alleen als hij niet al bewaard is.
   * @param {string} key De sleutel (bronnaam van de back-up).
   * @param {Function} open Opent de back-up en geeft een belofte van { db, close } (alleen aangeroepen bij een nieuwe opening).
   * @param {Function} callback Krijgt de geopende back-up ({ db, close }) en geeft het resultaat terug; hij mag hem niet sluiten.
   * @returns {Promise<*>} Wat de functie teruggeeft.
   * @throws {Error} Als de back-up niet te openen is.
   */
  async function use(key, open, callback) {
    let entry = entries.get(key);
    if (!entry) {
      entry = { opened: null, users: 0, expiresAt: 0, doomed: false };
      entry.opened = Promise.resolve().then(open);
      entry.opened.catch(() => { if (entries.get(key) === entry) entries.delete(key); });
      entries.set(key, entry);
    }
    entry.users += 1;
    try {
      return await callback(await entry.opened);
    } finally {
      entry.users -= 1;
      entry.expiresAt = now() + ttlMs;
      if (entry.doomed && entry.users === 0) closeEntry(entry);
    }
  }

  /**
   * Sluit bewaarde back-ups die niet in gebruik zijn en verlopen zijn.
   * @returns {void}
   */
  function sweep() {
    for (const [key, entry] of entries) {
      if (entry.users === 0 && entry.expiresAt && entry.expiresAt <= now()) drop(key);
    }
  }

  const timer = setInterval(sweep, sweepMs);
  timer.unref();

  return {
    use,
    drop,
    sweep,
    /**
     * Aantal bewaarde back-ups (voor tests).
     * @returns {number} Het aantal.
     */
    size: () => entries.size,
    /**
     * Stopt het opruimen en sluit alles (afsluiten en tests).
     * @returns {void}
     */
    close() {
      clearInterval(timer);
      for (const key of [...entries.keys()]) drop(key);
    },
  };
}

module.exports = { createBackupOpenCache };
