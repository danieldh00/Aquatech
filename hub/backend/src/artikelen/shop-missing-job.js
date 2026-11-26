// TIJDELIJK (alleen zolang WooCommerce nog draait): achtergrondtaak die de ontbrekende webshopproducten als artikel toevoegt, met voortgang en een lijst van wat is binnengehaald.
// De taak loopt op de server door als het venster sluit; de stand staat in het geheugen (één container) per omgeving. Raakt bestaande artikelen nooit aan.
const { SourceError } = require('../webshop/woocommerce');

/** Hoeveel toegevoegde artikelen de stand maximaal onthoudt (genoeg voor de hele webshop). */
const MAX_LISTED = 3000;

/**
 * De beginstand van een taak die nog niet gestart is.
 * @returns {object} running, phase, message, counters en lege lijst.
 */
function emptyState() {
  return { running: false, phase: 'idle', message: '', fetched: 0, variationsDone: 0, variationsTotal: 0, total: 0, created: 0, skipped: 0, added: [], error: null, startedAt: null, finishedAt: null };
}

/**
 * Maakt het register van de taken (één per omgeving).
 * @param {{ syncShop: Function, log?: object }} deps syncShop(tenantId, user, options) = de synchronisatie (met addMissing) en log (warn).
 * @returns {{ start: Function, get: Function }} start(tenantId, user, { onDone }) → true als gestart (false als er al een loopt) en get(tenantId) → de stand (een kopie).
 */
function createShopMissingJob({ syncShop, log = console }) {
  const states = new Map();

  /**
   * De stand van de taak van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object} De stand (een kopie, de lijst van toegevoegde artikelen als `added`).
   */
  function get(tenantId) {
    const state = states.get(tenantId);
    return state ? { ...state, added: state.added.slice() } : emptyState();
  }

  /**
   * Verwerkt een voortgangsmelding van het ophalen of toevoegen.
   * @param {object} state De stand van de taak.
   * @param {{ step: string, done?: number, total?: number, created?: number, skipped?: number, added?: object[] }} event De melding.
   * @returns {void}
   */
  function apply(state, event) {
    if (event.step === 'products') {
      state.phase = 'ophalen';
      state.fetched = event.done;
      state.message = `Producten ophalen uit de webshop (${event.done} tot nu toe)…`;
    } else if (event.step === 'variations') {
      state.phase = 'variaties';
      state.variationsDone = event.done;
      state.variationsTotal = event.total;
      state.message = `Variaties ophalen (${event.done} van ${event.total} variabele producten)…`;
    } else if (event.step === 'toevoegen') {
      state.phase = 'toevoegen';
      state.total = event.total;
      state.created = event.created;
      state.skipped = event.skipped;
      for (const item of event.added) if (state.added.length < MAX_LISTED) state.added.push(item);
      state.message = `Artikelen toevoegen (${event.created} van ${event.total})…`;
    }
  }

  /**
   * Start de taak als er voor deze omgeving niet al een loopt.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} user De gebruiker die hem start.
   * @param {{ onDone?: Function }} [options] onDone(stand) na afloop (bijvoorbeeld voor het auditlog).
   * @returns {boolean} true als gestart, false als er al een loopt.
   */
  function start(tenantId, user, { onDone = null } = {}) {
    const existing = states.get(tenantId);
    if (existing && existing.running) return false;
    const state = { ...emptyState(), running: true, phase: 'ophalen', message: 'Verbinding maken met de webshop…', startedAt: new Date().toISOString() };
    states.set(tenantId, state);
    (async () => {
      try {
        const out = await syncShop(tenantId, user, { addMissing: true, onProgress: (event) => apply(state, event) });
        if (out.skipped) state.error = { code: 'not_configured', message: 'Er is geen webshop gekoppeld (Beheer → Integraties → Webshop).' };
        else {
          state.created = out.created || 0;
          state.skipped = out.skippedProducts || 0;
          state.phase = 'klaar';
          state.message = `Klaar: ${state.created} artikel${state.created === 1 ? '' : 'en'} toegevoegd${state.skipped ? `, ${state.skipped} overgeslagen (geen geldige of dubbele code)` : ''}.`;
        }
      } catch (error) {
        log.warn(`Ontbrekende webshopproducten toevoegen mislukt: ${error && error.stack ? error.stack : error}`);
        state.error = error instanceof SourceError
          ? { code: error.code, message: error.message }
          : { code: 'error', message: `Toevoegen mislukt door een interne fout${error && error.code ? ` (${String(error.code).slice(0, 20)})` : ''}; zie het serverlog.` };
        state.phase = 'mislukt';
        state.message = state.error.message;
      } finally {
        state.running = false;
        state.finishedAt = new Date().toISOString();
        if (onDone) { try { onDone(get(tenantId)); } catch (error) { log.warn(`Afronden mislukt: ${error.message}`); } }
      }
    })();
    return true;
  }

  return { start, get };
}

module.exports = { createShopMissingJob };
