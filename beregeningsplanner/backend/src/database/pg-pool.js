// Pool van verbindingen met PostgreSQL voor db.async (async-db.js): een paar verbindingen in de hoofdthread, naast de
// ene synchrone verbinding van pgdb.js. Een query via de pool zet de hoofdthread niet stil; andere verzoeken lopen
// intussen door. Per verbinding onthoudt de pool dezelfde sessie-instellingen als de werkthread (pgdb-worker.js):
// statement_timeout, search_path (het schema van de database) en de tenantafscherming (aquatech.tenants + SET ROLE,
// tenant-scope.js). Die worden alleen opnieuw gezet als ze veranderen, in één rondgang.
//
// Grootte: PG_POOL_SIZE (standaard 5, 0 = geen pool: db.async gebruikt dan de synchrone verbinding). De Session pooler
// van Supabase telt elke verbinding mee voor zijn Pool Size.
const { Pool, types } = require('pg');
const { scopeKey } = require('./tenant-scope');
const { refuseTransaction } = require('./async-db');

// BIGINT (ook COUNT(*)) en NUMERIC als gewoon getal, zoals in SQLite en in de werkthread.
types.setTypeParser(20, (text) => Number(text));
types.setTypeParser(1700, (text) => Number(text));

/** Aantal verbindingen per pool (PG_POOL_SIZE, standaard 5, hoogstens 50; 0 = geen pool). */
const POOL_SIZE = Math.min(50, Math.max(0, Math.floor(Number(process.env.PG_POOL_SIZE ?? 5)) || 0));
/** Hoogstens zoveel milliseconden per query, net als in de werkthread (PG_STATEMENT_TIMEOUT_MS, 0 = geen grens). */
const STATEMENT_TIMEOUT_MS = Math.max(0, Math.floor(Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 30000)) || 0);
/** Na zoveel milliseconden zonder werk sluit een verbinding (en kan het proces stoppen als er niets meer loopt). */
const IDLE_MS = 10000;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const CONN_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P02', '57P03', '08000', '08003', '08006']);

/** Eén pool per database-URL per proces; elk schema gebruikt dezelfde pool met een eigen search_path. */
const pools = new Map();

/**
 * Of een fout betekent dat de verbinding weg is (dan een nieuwe verbinding proberen).
 * @param {Error} error De fout van pg.
 * @returns {boolean} true bij een verbroken of geweigerde verbinding.
 */
const isConnError = (error) => CONN_CODES.has(error.code) || /Connection terminated|connection.*(closed|ended)|Client was closed/i.test(error.message || '');

/**
 * Zet tekst als letterlijke SQL-tekst ('...', met verdubbelde aanhalingstekens).
 * @param {string} text De tekst.
 * @returns {string} De SQL-tekst.
 */
const sqlText = (text) => `'${String(text).replace(/'/g, "''")}'`;

/**
 * De pool voor deze URL (één per URL per proces).
 * @param {string} url De database-URL.
 * @param {object} config Verbindingsinstellingen (pgConfig in pgdb.js).
 * @returns {Pool} De pool.
 */
function poolFor(url, config) {
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({ ...config, max: POOL_SIZE, idleTimeoutMillis: IDLE_MS, allowExitOnIdle: true });
    // Een verbinding die wegvalt terwijl hij ongebruikt in de pool ligt: de pool gooit hem weg, het proces blijft draaien.
    pool.on('error', () => {});
    pools.set(url, pool);
  }
  return pool;
}

/**
 * Zet de sessie-instellingen van een verbinding goed voor deze query (alleen wat verandert, in één rondgang).
 * @param {import('pg').PoolClient} client De verbinding uit de pool.
 * @param {string} schema Het schema (search_path).
 * @param {string} scope De omgevingen van het verzoek ('' = geen beperking).
 * @returns {Promise<void>}
 */
async function prepareClient(client, schema, scope) {
  const state = client.aquatechState || (client.aquatechState = { ready: false, schema: null, scope: null });
  const statements = [];
  if (!state.ready) statements.push(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
  if (state.schema !== schema) statements.push(`SET search_path TO "${schema}"`);
  if (state.scope !== scope) {
    // Beperkt = als de rol zonder BYPASSRLS (de policies gelden); leeg = weer als de eigenaar.
    statements.push(`SELECT set_config('aquatech.tenants', ${sqlText(scope)}, false)`, scope ? 'SET ROLE aquatech_app' : 'RESET ROLE');
  }
  if (!statements.length) return;
  // Bij een fout is niet zeker welke instelling al gold: dan alles opnieuw bij het volgende gebruik.
  state.ready = false;
  state.schema = null;
  state.scope = null;
  await client.query(statements.join('; '));
  Object.assign(state, { ready: true, schema, scope });
}

/**
 * Maakt db.async voor een database in PostgreSQL: get/all/run(sql, ...params) via de pool. De SQL is in SQLite-stijl
 * (?-parameters) en gaat door dezelfde omzetting als db.prepare (db.pgText).
 * @param {{ url: string, config: object, db: object, toPgValue: Function, DatabaseError: Function }} options
 *   De URL en instellingen, de synchrone database (schema, tenantRls) en de hulpfuncties van pgdb.js.
 * @returns {{ get: Function, all: Function, run: Function, pooled: boolean, size: number }} De asynchrone database.
 */
function createPoolAsync({ url, config, db, toPgValue, DatabaseError }) {
  if (!SCHEMA_NAME.test(db.schema)) throw new Error(`Ongeldige schemanaam: ${db.schema}`);
  const pool = poolFor(url, config);
  /**
   * Voert één query uit via de pool. Een verbroken verbinding wordt weggegooid en de query één keer opnieuw geprobeerd
   * (veilig: er loopt nooit een transactie in de pool).
   * @param {string} sql De SQL met ?-parameters.
   * @param {Array} params De parameters.
   * @returns {Promise<{ rows: object[], rowCount: number }>} Het resultaat van pg.
   * @throws {DatabaseError} Bij een fout in de database.
   */
  const query = async (sql, params) => {
    refuseTransaction(sql);
    const text = db.pgText(sql);
    const values = params.map(toPgValue);
    // Op het moment van de aanroep: de omgevingen van dit verzoek (na limitTo in server.js).
    const scope = db.tenantRls ? scopeKey() : '';
    for (let attempt = 0; ; attempt++) {
      let client;
      try {
        client = await pool.connect();
      } catch (error) {
        if (attempt || !isConnError(error)) throw new DatabaseError({ message: error.message, code: error.code });
        continue;
      }
      try {
        await prepareClient(client, db.schema, scope);
        const result = await client.query({ text, values });
        client.release();
        return result;
      } catch (error) {
        const broken = isConnError(error);
        // Een verbroken verbinding (of een die half is ingesteld) niet teruggeven aan de pool.
        client.release(broken || !client.aquatechState?.ready ? error : undefined);
        if (broken && !attempt) continue;
        throw new DatabaseError({ message: error.message, code: error.code, detail: error.detail, constraint: error.constraint, table: error.table });
      }
    }
  };
  return {
    pooled: true,
    size: POOL_SIZE,
    /**
     * Eerste rij van het resultaat.
     * @param {string} sql De SQL met ?-parameters.
     * @param {...*} params De parameters.
     * @returns {Promise<object|undefined>} De rij.
     */
    get: async (sql, ...params) => (await query(sql, params)).rows[0],
    /**
     * Alle rijen van het resultaat.
     * @param {string} sql De SQL met ?-parameters.
     * @param {...*} params De parameters.
     * @returns {Promise<object[]>} De rijen.
     */
    all: async (sql, ...params) => (await query(sql, params)).rows,
    /**
     * Voert een wijziging uit (één statement, meteen vastgelegd).
     * @param {string} sql De SQL met ?-parameters.
     * @param {...*} params De parameters.
     * @returns {Promise<{ changes: number }>} Aantal gewijzigde rijen.
     */
    run: async (sql, ...params) => ({ changes: (await query(sql, params)).rowCount }),
  };
}

/**
 * Sluit alle pools (tests en scripts die netjes willen stoppen).
 * @returns {Promise<void>}
 */
async function closePools() {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((pool) => pool.end().catch(() => {})));
}

module.exports = { createPoolAsync, closePools, POOL_SIZE };
