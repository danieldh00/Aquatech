// Telt per verzoek (of achtergrondtaak) hoeveel databasequeries en externe aanroepen er waren en hoe lang ze samen
// duurden, zodat de log van trage verzoeken (platform/slow-log.js) kan zien waar de tijd bleef. De tellers staan in een
// AsyncLocalStorage: pgdb.js (synchrone brug) en pg-pool.js (db.async) melden elke query met `recordQuery`, de
// gewrapte fetch (slow-log.js) elke externe aanroep met `recordExternal`. Buiten een context doen ze niets.
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Maakt een lege teller.
 * @returns {{ queries: number, dbMs: number, externalCalls: number, externalMs: number }} De teller.
 */
const createStats = () => ({ queries: 0, dbMs: 0, externalCalls: 0, externalMs: 0 });

/**
 * Voert een functie uit met een eigen teller.
 * @param {object} stats De teller (createStats).
 * @param {Function} callback De functie.
 * @returns {*} Wat de functie teruggeeft.
 */
const runWithStats = (stats, callback) => storage.run(stats, callback);

/**
 * Legt één databasequery vast bij de teller van het lopende verzoek.
 * @param {number} durationMs Duur in milliseconden.
 * @returns {void}
 */
function recordQuery(durationMs) {
  const stats = storage.getStore();
  if (!stats) return;
  stats.queries += 1;
  stats.dbMs += durationMs;
}

/**
 * Legt één externe aanroep vast bij de teller van het lopende verzoek.
 * @param {number} durationMs Duur in milliseconden.
 * @returns {void}
 */
function recordExternal(durationMs) {
  const stats = storage.getStore();
  if (!stats) return;
  stats.externalCalls += 1;
  stats.externalMs += durationMs;
}

module.exports = { createStats, runWithStats, recordQuery, recordExternal };
