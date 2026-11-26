// Achtergrondtaken voor de artikelrondes met AI (omschrijvingen in bulk, Past bij opzoeken): de server loopt alle artikelen zelf in porties door, ook als de
// browser of het venster dicht gaat. De stand staat in het geheugen (één container): na een herstart is de taak weg, maar wat al klaar is staat in de
// database en een nieuwe start gaat gewoon verder met wat nog aan de beurt is.

/** De stand van een taak die nooit gestart is. */
const EMPTY = { running: false, total: 0, processed: 0, tally: {}, message: '', aborted: null, stopRequested: false, startedAt: null, finishedAt: null, options: {}, extra: null };

/**
 * Maakt het register van achtergrondtaken (één taak per sleutel, bijvoorbeeld soort en omgeving).
 * @returns {{ start: Function, get: Function, stop: Function }} start(sleutel, taak) → true als gestart; get(sleutel) → stand; stop(sleutel).
 */
function createJobs() {
  const states = new Map();

  /**
   * De stand van een taak (een kopie, zodat de beller hem niet kan aanpassen).
   * @param {string} key Sleutel van de taak.
   * @returns {object} running, total, processed, tally, message, aborted, stopRequested, startedAt, finishedAt en options.
   */
  function get(key) {
    const state = states.get(key);
    return state ? { ...state, tally: { ...state.tally } } : { ...EMPTY };
  }

  /**
   * Start een taak als er voor deze sleutel niet al een loopt. De taak verwerkt de id's in porties via runBatch en stopt bij een stopverzoek, een weigering of een fatale fout.
   * @param {string} key Sleutel van de taak.
   * @param {{ ids: string[], size: number, options?: object, runBatch: (ids: string[]) => Promise<{ refused: ?object, results: object[], aborted: ?object }>, onDone?: (state: object) => void }} job De artikelen, de grootte van een portie, de functie die één portie verwerkt en een optionele afsluitstap (die ook bij stoppen draait; een fout daarin stopt de taak niet).
   * @returns {boolean} true als de taak is gestart, false als er al een loopt.
   */
  function start(key, { ids, size, options = {}, runBatch, onDone }) {
    const existing = states.get(key);
    if (existing && existing.running) return false;
    const state = { ...EMPTY, running: true, total: ids.length, tally: {}, startedAt: new Date().toISOString(), options };
    states.set(key, state);
    (async () => {
      try {
        for (let from = 0; from < ids.length && !state.stopRequested && !state.aborted; from += size) {
          const out = await runBatch(ids.slice(from, from + size));
          if (out.refused) { state.aborted = { code: out.refused.error, message: out.refused.message }; break; }
          for (const result of out.results) state.tally[result.status] = (state.tally[result.status] || 0) + 1;
          state.processed = Math.min(ids.length, from + size);
          if (out.aborted) state.aborted = out.aborted;
        }
        if (onDone) { try { onDone(state); } catch (error) { console.warn(`Afsluitstap van ${key} mislukt: ${error.message}`); } }
        state.message = state.aborted ? state.aborted.message : state.stopRequested ? 'Gestopt op verzoek.' : 'Klaar.';
      } catch (error) {
        console.warn(`Achtergrondtaak ${key} mislukt: ${error.message}`);
        state.aborted = { code: 'error', message: 'De taak is gestopt door een interne fout.' };
        state.message = state.aborted.message;
      } finally {
        state.running = false;
        state.finishedAt = new Date().toISOString();
      }
    })();
    return true;
  }

  /**
   * Vraagt een taak te stoppen na de lopende portie.
   * @param {string} key Sleutel van de taak.
   * @returns {void}
   */
  function stop(key) {
    const state = states.get(key);
    if (state && state.running) state.stopRequested = true;
  }

  return { start, get, stop };
}

module.exports = { createJobs };
