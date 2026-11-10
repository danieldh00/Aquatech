// Tenantafscherming in de database zelf (2 uit de audit van 1.7.3): per HTTP-verzoek onthoudt deze module welke
// omgevingen het verzoek mag zien. pgdb.js stuurt die lijst mee met elke query; de werkthread zet hem als
// `aquatech.tenants` op de verbinding en de policies in PostgreSQL (pgdb.js, lockDown) laten alleen rijen van die
// omgevingen door. Een vergeten `WHERE tenant_id = ?` lekt dan geen gegevens van een andere organisatie.
// Lege lijst = systeem (opstarten, onderhoud, hoofdbeheerder, inloggen): dan geldt geen beperking.
// SQLite heeft geen policies; daar blijft het filter in de code (en tools/tenant-filter.js) de bescherming.
const { AsyncLocalStorage, AsyncResource } = require('async_hooks');

const scopes = new AsyncLocalStorage();

/**
 * Voert een verzoek uit met een eigen, nog onbeperkte afscherming (server.js zet hem per verzoek).
 * @param {Function} callback De rest van het verzoek.
 * @returns {*} Wat de callback teruggeeft.
 */
const withScope = (callback) => scopes.run({ tenants: null }, callback);

/**
 * Beperkt de rest van het huidige verzoek tot deze omgevingen (na het herkennen van de gebruiker).
 * @param {string[]} tenantIds De omgevingen die het verzoek mag zien.
 * @returns {void}
 */
function limitTo(tenantIds) {
  const scope = scopes.getStore();
  if (!scope || scope.pinned) return;
  const ids = [...new Set((tenantIds || []).filter((id) => typeof id === 'string' && id && !id.includes(',')))];
  scope.tenants = ids.length ? ids : null;
}

/**
 * Voert iets uit zonder beperking, voor code die bewust over organisaties heen kijkt (bijv. de instellingen van de
 * hoofdtenant of uitbesteden tussen organisaties).
 * @param {Function} callback Wat er zonder beperking moet gebeuren.
 * @returns {*} Wat de callback teruggeeft.
 */
const asSystem = (callback) => scopes.run({ tenants: null, pinned: true }, callback);

/**
 * Zet de rest van het huidige verzoek blijvend zonder beperking (ook als de gebruiker daarna nog herkend wordt), voor
 * routes die per ontwerp tussen organisaties werken (uitbesteden). Rechten en het filter in de code gelden gewoon.
 * @returns {void}
 */
function pinSystem() {
  const scope = scopes.getStore();
  if (!scope) return;
  scope.tenants = null;
  scope.pinned = true;
}

/**
 * De omgevingen van het huidige verzoek als tekst voor de database.
 * @returns {string} Komma-gescheiden id's, of '' (geen beperking).
 */
function scopeKey() {
  const scope = scopes.getStore();
  return scope && scope.tenants ? scope.tenants.join(',') : '';
}

/**
 * Laat de luisteraars van een verzoekstroom (body-parser leest de body via 'data'/'end') in de context van dit verzoek
 * lopen. Zonder dit loopt de code na het inlezen van de body in de context van wie de stroom aanmaakte, en zou de
 * afscherming (en het geheugen per verzoek) van een ander verzoek kunnen gelden.
 * @param {import('events').EventEmitter} stream Het verzoek (req).
 * @returns {void}
 */
function bindStream(stream) {
  const bound = new WeakMap();
  /**
   * De aan dit verzoek gebonden versie van een luisteraar (steeds dezelfde, zodat afmelden werkt).
   * @param {Function} listener De luisteraar.
   * @returns {Function} De gebonden luisteraar.
   */
  const bindListener = (listener) => {
    if (typeof listener !== 'function') return listener;
    if (!bound.has(listener)) bound.set(listener, AsyncResource.bind(listener));
    return bound.get(listener);
  };
  for (const method of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener', 'removeListener', 'off']) {
    const original = stream[method];
    if (typeof original !== 'function') continue;
    /**
     * Meldt de luisteraar aan of af in zijn gebonden vorm.
     * @param {string} event Naam van het event.
     * @param {Function} listener De luisteraar.
     * @returns {*} Wat de oorspronkelijke methode teruggeeft (de stroom).
     */
    stream[method] = function boundMethod(event, listener) { return original.call(this, event, bindListener(listener)); };
  }
}

module.exports = { withScope, limitTo, asSystem, pinSystem, scopeKey, bindStream };
