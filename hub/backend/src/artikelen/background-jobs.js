// Achtergrondtaken voor de artikelrondes met AI (omschrijvingen in bulk, Past bij opzoeken): de server loopt alle artikelen zelf in porties door, ook als de
// browser of het venster dicht gaat. De stand staat in het geheugen (één container): na een herstart is de taak weg, maar wat al klaar is staat in de
// database en een nieuwe start gaat gewoon verder met wat nog aan de beurt is. Een lopende taak staat daarnaast in de instelling `backgroundJobs` (zie
// createJobPersistence): na een herstart van de container pakt `resume` hem automatisch weer op, ook als de update-timer elke paar uur herstart.

/** De soorten taak die bewaard worden. */
const KINDS = ['omschrijvingen', 'pastbij'];

/**
 * Maakt van een ruwe waarde de bewaarde taken: per soort de gebruiker, de starttijd en de opties (alleen booleans).
 * @param {*} raw De opgeslagen waarde.
 * @returns {object} Per soort { userId, startedAt, options }; onbekende soorten en rommel vervallen.
 */
function sanitizeBackgroundJobs(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const kind of KINDS) {
    const entry = raw[kind];
    if (!entry || typeof entry !== 'object') continue;
    const options = {};
    for (const key of ['research', 'review', 'again']) if (entry.options && typeof entry.options[key] === 'boolean') options[key] = entry.options[key];
    out[kind] = { userId: typeof entry.userId === 'string' && entry.userId.length <= 64 ? entry.userId : null, startedAt: typeof entry.startedAt === 'string' ? entry.startedAt.slice(0, 40) : '', options };
  }
  return out;
}

/**
 * Bewaart per omgeving welke taken lopen (instelling backgroundJobs), zodat ze na een herstart hervat kunnen worden.
 * @param {Function} settingsFor Geeft de instellingen van een omgeving.
 * @returns {{ save: Function, clear: Function, list: Function }} save(omgeving, soort, { userId, options }), clear(omgeving, soort) en list(omgeving) → { soort: { userId, startedAt, options } }.
 */
function createJobPersistence(settingsFor) {
  /**
   * De bewaarde taken van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} Per soort de bewaarde taak.
   */
  const list = (tenantId) => sanitizeBackgroundJobs(settingsFor(tenantId).get('backgroundJobs'));
  return {
    list,
    /**
     * Legt vast dat een taak loopt.
     * @param {string} tenantId Id van de omgeving.
     * @param {string} kind De soort taak.
     * @param {{ userId: ?string, options: object }} job Wie de taak startte en met welke opties.
     * @returns {void}
     */
    save(tenantId, kind, { userId, options }) {
      settingsFor(tenantId).update({ backgroundJobs: { ...list(tenantId), [kind]: { userId: userId || null, startedAt: new Date().toISOString(), options } } }, null);
    },
    /**
     * Haalt een taak weg (klaar, gestopt of vastgelopen), zodat hij niet meer hervat wordt.
     * @param {string} tenantId Id van de omgeving.
     * @param {string} kind De soort taak.
     * @returns {void}
     */
    clear(tenantId, kind) {
      const current = list(tenantId);
      if (!current[kind]) return;
      delete current[kind];
      settingsFor(tenantId).update({ backgroundJobs: current }, null);
    },
  };
}

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
   * @param {{ ids: string[], size: number, options?: object, runBatch: (ids: string[]) => Promise<{ refused: ?object, results: object[], aborted: ?object }>, onDone?: (state: object) => void, onFinish?: (state: object) => void }} job De artikelen, de grootte van een portie, de functie die één portie verwerkt en een optionele afsluitstap (die ook bij stoppen draait; een fout daarin stopt de taak niet) en een optionele melding als de taak helemaal klaar is.
   * @returns {boolean} true als de taak is gestart, false als er al een loopt.
   */
  function start(key, { ids, size, options = {}, runBatch, onDone, onFinish }) {
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
        if (onFinish) { try { onFinish(state); } catch (error) { console.warn(`Afronden van ${key} mislukt: ${error.message}`); } }
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

module.exports = { createJobs, createJobPersistence, sanitizeBackgroundJobs, KINDS };
