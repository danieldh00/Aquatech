// Asynchrone kant van de database (db.async): dezelfde SQL met ?-parameters als db.prepare, maar met een Promise als
// antwoord. Met PostgreSQL loopt die over een pool van verbindingen (pg-pool.js), zodat een trage query de hoofdthread
// niet stilzet en andere verzoeken intussen door kunnen. Met SQLite (en met PG_POOL_SIZE=0) is het dezelfde synchrone
// query, verpakt in een Promise: de code werkt dan op beide databases hetzelfde.
//
// Alleen losse queries (lezen, of één wijziging die meteen vastligt). Transacties blijven synchroon via
// db.prepare/transaction (db.js): een transactie in de pool die rijen vasthoudt terwijl de hoofdthread synchroon op
// dezelfde rijen wacht, zou vastlopen tot de statement_timeout.

/** SQL die een transactie begint of afsluit; die hoort niet in db.async. */
const TRANSACTION_SQL = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|END|SAVEPOINT|RELEASE)\b/i;

/**
 * Weigert transacties in db.async (zie de kop van dit bestand).
 * @param {string} sql De SQL.
 * @returns {void}
 * @throws {Error} Als de SQL een transactie begint of afsluit.
 */
function refuseTransaction(sql) {
  if (TRANSACTION_SQL.test(String(sql))) throw new Error('Transacties lopen via db.prepare/transaction, niet via db.async.');
}

/**
 * Maakt de asynchrone kant van een synchrone database (SQLite, of PostgreSQL zonder pool). De statements worden pas
 * bij de aanroep voorbereid, met de oorspronkelijke prepare (zo telt de querytest ze één keer, via db.async).
 * @param {{ prepare: Function }} db De synchrone database.
 * @returns {{ get: Function, all: Function, run: Function, pooled: boolean }} get/all/run(sql, ...params) met een Promise.
 */
function syncAsync(db) {
  const prepare = db.prepare.bind(db);
  /**
   * Voert één methode van een statement uit en geeft het resultaat als Promise.
   * @param {'get'|'all'|'run'} method De methode van het statement.
   * @param {string} sql De SQL met ?-parameters.
   * @param {Array} params De parameters.
   * @returns {Promise<*>} Het resultaat van de methode.
   */
  const call = async (method, sql, params) => {
    refuseTransaction(sql);
    const result = prepare(sql)[method](...params);
    return method === 'run' ? { changes: Number(result.changes) } : result;
  };
  return {
    pooled: false,
    /**
     * Eerste rij van het resultaat.
     * @param {string} sql De SQL met ?-parameters.
     * @param {...*} params De parameters.
     * @returns {Promise<object|undefined>} De rij.
     */
    get: (sql, ...params) => call('get', sql, params),
    /**
     * Alle rijen van het resultaat.
     * @param {string} sql De SQL met ?-parameters.
     * @param {...*} params De parameters.
     * @returns {Promise<object[]>} De rijen.
     */
    all: (sql, ...params) => call('all', sql, params),
    /**
     * Voert een wijziging uit.
     * @param {string} sql De SQL met ?-parameters.
     * @param {...*} params De parameters.
     * @returns {Promise<{ changes: number }>} Aantal gewijzigde rijen.
     */
    run: (sql, ...params) => call('run', sql, params),
  };
}

module.exports = { syncAsync, refuseTransaction };
