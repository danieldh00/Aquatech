// Werkthread van pgdb.js: houdt één verbinding met PostgreSQL open en voert
// de queries uit die de hoofdthread synchroon aanbiedt. Na elk antwoord zet
// de thread de vlag in het gedeelde geheugen en wekt de hoofdthread.
const { workerData } = require('worker_threads');
const { Client, types } = require('pg');

// BIGINT (ook COUNT(*)) en NUMERIC als gewoon getal, zoals in SQLite.
types.setTypeParser(20, (text) => Number(text));
types.setTypeParser(1700, (text) => Number(text));

const { port, signal, config } = workerData;
const flag = new Int32Array(signal);

let client = null;
let schema = null; // search_path van de huidige verbinding
let inTransaction = false;

const CONN_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P02', '57P03', '08000', '08003', '08006']);
/**
 * Of een fout betekent dat de verbinding weg is (en een nieuwe verbinding zin heeft).
 * @param {Error} err De fout van pg.
 * @returns {boolean} true bij een verbroken of geweigerde verbinding.
 */
const isConnError = (err) => CONN_CODES.has(err.code) || /Connection terminated|connection.*(closed|ended)|Client was closed/i.test(err.message || '');

/**
 * Maakt een nieuwe verbinding met PostgreSQL. Een verbroken verbinding (bijv.
 * door de pooler) laat de thread niet crashen: de volgende query maakt een
 * nieuwe verbinding.
 * @returns {Promise<void>}
 */
async function connect() {
  const connection = new Client(config);
  // Een verbroken verbinding (bijv. door de pooler) niet laten crashen: de
  // volgende query maakt een nieuwe verbinding.
  connection.on('error', () => { if (client === connection) client = null; });
  await connection.connect();
  client = connection;
  schema = null;
}

/**
 * Zet het schema (search_path) van de verbinding, en maakt het schema zo nodig aan.
 * @param {string} name Naam van het schema (alleen kleine letters, cijfers en _).
 * @returns {Promise<void>}
 */
async function useSchema(name) {
  if (name === schema) return;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Ongeldige schemanaam: ${name}`);
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${name}"; SET search_path TO "${name}"`);
  schema = name;
}

/**
 * Voert één opdracht uit op de (zo nodig nieuwe) verbinding.
 * @param {{ op: string, schema: string, sql: string, params?: Array }} message De opdracht van de hoofdthread ('exec' = losse SQL zonder parameters).
 * @returns {Promise<object|object[]>} Het resultaat van pg.
 */
async function run(message) {
  if (!client) await connect();
  await useSchema(message.schema);
  if (message.op === 'exec') return client.query(message.sql);
  return client.query({ text: message.sql, values: message.params });
}

/**
 * Houdt bij of er een transactie loopt (BEGIN tot COMMIT/ROLLBACK/END).
 * @param {string} sql De zojuist uitgevoerde SQL.
 * @returns {void}
 */
function txState(sql) {
  const head = String(sql).trimStart().slice(0, 10).toUpperCase();
  if (head.startsWith('BEGIN')) inTransaction = true;
  else if (head.startsWith('COMMIT') || head.startsWith('ROLLBACK') || head.startsWith('END')) inTransaction = false;
}

/**
 * Verwerkt één bericht van de hoofdthread. Bij een verbroken verbinding buiten
 * een transactie wordt de opdracht één keer opnieuw geprobeerd; binnen een
 * transactie is die al verloren en gaat de fout terug.
 * @param {{ op: string, schema?: string, sql?: string, params?: Array }} message De opdracht ('close' sluit de verbinding).
 * @returns {Promise<{ rows: object[], rowCount: number }>} De rijen van de laatste opdracht en het aantal gewijzigde rijen.
 */
async function handle(message) {
  if (message.op === 'close') {
    const connection = client;
    client = null;
    if (connection) await connection.end().catch(() => {});
    return { rows: [], rowCount: 0 };
  }
  let result;
  try {
    result = await run(message);
  } catch (err) {
    if (!isConnError(err)) throw err;
    // Verbinding weg: buiten een transactie één keer opnieuw proberen; binnen
    // een transactie is die al verloren, dan de fout doorgeven.
    const connection = client;
    client = null;
    if (connection) connection.end().catch(() => {});
    if (inTransaction) { inTransaction = false; throw err; }
    result = await run(message);
  }
  txState(message.sql);
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  return { rows: last?.rows || [], rowCount: last?.rowCount ?? 0 };
}

port.on('message', async (msg) => {
  let reply;
  try {
    reply = { id: msg.id, ...(await handle(msg)) };
  } catch (err) {
    if (/^\s*(COMMIT|ROLLBACK|END)/i.test(msg.sql || '')) inTransaction = false;
    reply = { id: msg.id, error: { message: err.message, code: err.code, detail: err.detail, constraint: err.constraint, table: err.table } };
  }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
