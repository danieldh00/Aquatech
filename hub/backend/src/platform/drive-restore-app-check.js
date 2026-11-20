// Overdracht van de hersteltest van de Google Drive-back-up aan het hostscript (deploy/apps01/restore-test-drive.sh): de app kan
// geen docker starten, dus ze zet de gedownloade back-up klaar in de aanvraagmap (UPDATE_REQUEST_DIR/drive-restore) en wacht op de
// uitslag in de statusmap (UPDATE_STATUS_DIR/drive-restore-app.json). Het script zet de back-up terug in een wegwerpdatabase, start
// er een wegwerp-app op en meldt of die inlogt en gegevens ophaalt. Ontbreekt het script (servertaak 007 nog niet uitgevoerd), dan
// meldt `run` dat de controle niet kon draaien; dat is een waarschuwing, geen mislukking van de back-up zelf.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { readJsonFile, writeJsonFile, cleanText } = require('./system-update');

const HANDOVER = 'drive-restore';
const STATUS_FILE = 'drive-restore-app.json';
const PICKUP_MS = 90 * 1000;
const TOTAL_MS = 25 * 60 * 1000;
const POLL_MS = 3000;
const MAX_SANITY = 20;

/**
 * Saneert de uitslag uit de statusmap.
 * @param {object|null} raw De ruwe inhoud van drive-restore-app.json.
 * @returns {{ id: string, state: string, message: string, sanity: object[] }|null} De uitslag of null bij onbruikbare inhoud.
 */
function sanitizeStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && /^[0-9a-f-]{36}$/.test(raw.id) ? raw.id : '';
  const state = ['bezig', 'klaar', 'mislukt'].includes(raw.state) ? raw.state : '';
  if (!id || !state) return null;
  return {
    id,
    state,
    message: cleanText(raw.message, 300),
    sanity: (Array.isArray(raw.sanity) ? raw.sanity : [])
      .map((item) => ({ name: cleanText(item && item.name, 120), value: Number.isInteger(item && item.value) && item.value > 0 ? item.value : 0, ok: Boolean(item && item.ok === true) }))
      .filter((item) => item.name)
      .slice(0, MAX_SANITY),
  };
}

/**
 * Maakt de overdracht naar het hostscript.
 * @param {object} options statusDir en requestDir (UPDATE_STATUS_DIR en UPDATE_REQUEST_DIR; leeg = niet beschikbaar), en voor tests pickupMs, totalMs, pollMs en sleep.
 * @returns {{ available: boolean, run: Function }} available en run({ file, name }).
 */
function createDriveAppCheck({ statusDir = '', requestDir = '', pickupMs = PICKUP_MS, totalMs = TOTAL_MS, pollMs = POLL_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const available = Boolean(statusDir && requestDir);
  const handoverDir = available ? path.join(requestDir, HANDOVER) : '';

  /**
   * Haalt de klaargezette bestanden weg (als het script ze nog niet heeft weggehaald).
   * @returns {void}
   */
  function clear() {
    for (const name of ['request.json', 'backup.db.enc']) fs.rmSync(path.join(handoverDir, name), { force: true });
  }

  /**
   * Zet een back-up klaar voor het hostscript en wacht op de uitslag.
   * @param {{ file: string, name: string }} options Het gedownloade back-upbestand (.db.enc) en de naam.
   * @returns {Promise<{ ran: boolean, ok: boolean, message: string, sanity: object[] }>} ran = het script heeft gedraaid; ok = alle controles goed.
   */
  async function run({ file, name }) {
    if (!available) return { ran: false, ok: true, message: 'De app-controle is niet beschikbaar op deze installatie (geen update-mappen).', sanity: [] };
    const id = crypto.randomUUID();
    const started = Date.now();
    try {
      fs.mkdirSync(handoverDir, { recursive: true, mode: 0o755 });
      clear();
      // Eerst de back-up (tijdelijk bestand + hernoemen), pas daarna de aanvraag: die start het script.
      const partFile = path.join(handoverDir, `.backup.${id}.part`);
      fs.copyFileSync(file, partFile);
      fs.renameSync(partFile, path.join(handoverDir, 'backup.db.enc'));
      writeJsonFile(handoverDir, 'request.json', { id, name, requestedAt: new Date(started).toISOString() });
      let pickedUp = false;
      while (Date.now() - started < totalMs) {
        await sleep(pollMs);
        const status = sanitizeStatus(readJsonFile(statusDir, STATUS_FILE));
        if (status && status.id === id) {
          pickedUp = true;
          if (status.state === 'klaar') return { ran: true, ok: true, message: status.message, sanity: status.sanity };
          if (status.state === 'mislukt') return { ran: true, ok: false, message: status.message || 'De app-controle van de Drive-back-up is mislukt.', sanity: status.sanity };
        }
        if (!pickedUp && Date.now() - started > pickupMs) {
          return { ran: false, ok: true, message: 'De app-controle draaide niet: het hostscript reageerde niet (servertaak 007 nog niet uitgevoerd?).', sanity: [] };
        }
      }
      return { ran: false, ok: true, message: 'De app-controle gaf geen uitslag binnen 25 minuten.', sanity: [] };
    } catch (error) {
      return { ran: false, ok: true, message: 'De app-controle kon niet worden klaargezet in de aanvraagmap.', sanity: [] };
    } finally {
      try { clear(); } catch { /* al weg */ }
    }
  }

  return { available, run };
}

module.exports = { createDriveAppCheck, sanitizeStatus };
