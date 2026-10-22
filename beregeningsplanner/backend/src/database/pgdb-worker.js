// Werkthread van pgdb.js: houdt één verbinding met PostgreSQL open en voert
// de queries uit die de hoofdthread synchroon aanbiedt. Na elk antwoord zet
// de thread de vlag in het gedeelde geheugen en wekt de hoofdthread.
const { workerData } = require('worker_threads');
const { Client, types } = require('pg');

// BIGINT (ook COUNT(*)) en NUMERIC als gewoon getal, zoals in SQLite.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

const { port, signal, config } = workerData;
const flag = new Int32Array(signal);

let client = null;
let schema = null; // search_path van de huidige verbinding
let inTx = false;

const CONN_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P02', '57P03', '08000', '08003', '08006']);
const isConnError = (err) => CONN_CODES.has(err.code) || /Connection terminated|connection.*(closed|ended)|Client was closed/i.test(err.message || '');

async function connect() {
  const c = new Client(config);
  // Een verbroken verbinding (bijv. door de pooler) niet laten crashen: de
  // volgende query maakt een nieuwe verbinding.
  c.on('error', () => { if (client === c) client = null; });
  await c.connect();
  client = c;
  schema = null;
}

async function useSchema(name) {
  if (name === schema) return;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Ongeldige schemanaam: ${name}`);
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${name}"; SET search_path TO "${name}"`);
  schema = name;
}

async function run(msg) {
  if (!client) await connect();
  await useSchema(msg.schema);
  if (msg.op === 'exec') return client.query(msg.sql);
  return client.query({ text: msg.sql, values: msg.params });
}

function txState(sql) {
  const head = String(sql).trimStart().slice(0, 10).toUpperCase();
  if (head.startsWith('BEGIN')) inTx = true;
  else if (head.startsWith('COMMIT') || head.startsWith('ROLLBACK') || head.startsWith('END')) inTx = false;
}

async function handle(msg) {
  if (msg.op === 'close') {
    const c = client;
    client = null;
    if (c) await c.end().catch(() => {});
    return { rows: [], rowCount: 0 };
  }
  let res;
  try {
    res = await run(msg);
  } catch (err) {
    if (!isConnError(err)) throw err;
    // Verbinding weg: buiten een transactie één keer opnieuw proberen; binnen
    // een transactie is die al verloren, dan de fout doorgeven.
    const c = client;
    client = null;
    if (c) c.end().catch(() => {});
    if (inTx) { inTx = false; throw err; }
    res = await run(msg);
  }
  txState(msg.sql);
  const last = Array.isArray(res) ? res[res.length - 1] : res;
  return { rows: last?.rows || [], rowCount: last?.rowCount ?? 0 };
}

port.on('message', async (msg) => {
  let reply;
  try {
    reply = { id: msg.id, ...(await handle(msg)) };
  } catch (err) {
    if (/^\s*(COMMIT|ROLLBACK|END)/i.test(msg.sql || '')) inTx = false;
    reply = { id: msg.id, error: { message: err.message, code: err.code, detail: err.detail, constraint: err.constraint, table: err.table } };
  }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
