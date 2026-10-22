// PostgreSQL (bijv. Supabase) als database, met dezelfde synchrone interface
// als node:sqlite: db.prepare(sql).get/all/run(...) en db.exec(sql). Zo werkt
// alle code in store.js, quotes.js enz. ongewijzigd op beide databases.
//
// Hoe: een werkthread (pgdb-worker.js) houdt de verbinding open; de
// hoofdthread geeft een query door en wacht met Atomics.wait tot het antwoord
// er is. Elke query is daardoor (net als bij SQLite) blokkerend; alle queries
// lopen na elkaar over één verbinding, dus transacties lopen nooit door elkaar.
//
// SQL schrijft de code met ?-parameters (SQLite-stijl); die worden hier
// omgezet naar $1, $2, ... Dialectverschillen (JSON, schema opvragen) lost
// db.js op met kleine hulpfuncties.
const fs = require('fs');
const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const { PG_BASE, PG_BASE_VERSION, PG_MIGRATIONS } = require('./pgschema');

const TIMEOUT_MS = Math.max(1000, Number(process.env.DATABASE_TIMEOUT_MS) || 30000);
const SUPABASE_CA = path.join(__dirname, 'certs', 'supabase-root-2021.crt');
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

class DatabaseError extends Error {
  /**
   * Fout uit PostgreSQL, met code, detail, constraint en tabel zoals pg ze geeft.
   * @param {{ message: string, code?: string, detail?: string, constraint?: string, table?: string }} info De fout zoals de werkthread hem doorgeeft.
   */
  constructor(info) {
    super(info.message);
    this.name = 'DatabaseError';
    Object.assign(this, { code: info.code, detail: info.detail, constraint: info.constraint, table: info.table });
  }
}

// Eén verbinding (werkthread) per database-URL per proces; elk geopend
// schema gebruikt die verbinding met een eigen search_path.
const bridges = new Map();

class Bridge {
  /**
   * Start de werkthread met één verbinding naar PostgreSQL en het gedeelde geheugen voor de wachtvlag.
   * @param {object} config Verbindingsinstellingen voor pg (zie pgConfig).
   */
  constructor(config) {
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.signal = new SharedArrayBuffer(4);
    this.flag = new Int32Array(this.signal);
    this.seq = 0;
    this.worker = new Worker(path.join(__dirname, 'pgdb-worker.js'), {
      workerData: { port: port2, signal: this.signal, config },
      transferList: [port2],
    });
    // De werkthread houdt het proces niet in leven (tests en scripts stoppen
    // gewoon als ze klaar zijn).
    this.worker.unref();
    this.worker.on('error', (err) => { this.dead = err; });
    this.worker.on('exit', () => { this.dead ||= new Error('Databaseverbinding gestopt.'); });
  }

  /**
   * Stuurt een opdracht naar de werkthread en wacht (blokkerend, met Atomics.wait) op het antwoord.
   * @param {{ op: string, schema: string, sql: string, params?: Array }} message De opdracht.
   * @returns {{ rows: object[], rowCount: number }} Het antwoord van de werkthread.
   * @throws {DatabaseError} Bij een fout in de database, een gestopte werkthread of na TIMEOUT_MS.
   */
  call(message) {
    if (this.dead) throw new DatabaseError({ message: `Database niet beschikbaar: ${this.dead.message}` });
    const id = ++this.seq;
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage({ ...message, id });
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const reply = this.take(id);
      if (reply) {
        if (reply.error) throw new DatabaseError(reply.error);
        return reply;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || Atomics.wait(this.flag, 0, 0, remaining) === 'timed-out') {
        // Laatste kans: het antwoord kan net binnen zijn.
        const late = this.take(id);
        if (late) { if (late.error) throw new DatabaseError(late.error); return late; }
        throw new DatabaseError({ message: `Database antwoordt niet binnen ${TIMEOUT_MS} ms.`, code: 'ETIMEDOUT' });
      }
    }
  }

  /**
   * Haalt het antwoord met dit id op; oudere, te late antwoorden vervallen.
   * @param {number} id Volgnummer van de opdracht.
   * @returns {object|null} Het antwoord, of null als het er nog niet is.
   */
  take(id) {
    for (;;) {
      const received = receiveMessageOnPort(this.port);
      if (!received) {
        Atomics.store(this.flag, 0, 0);
        // Tussen leeglezen en de vlag terugzetten kan nog iets binnenkomen.
        const again = receiveMessageOnPort(this.port);
        if (!again) return null;
        if (again.message.id === id) return again.message;
        continue;
      }
      if (received.message.id === id) return received.message;
    }
  }
}

/**
 * Zet ?-parameters om naar $1, $2, ... (niet binnen strings, namen of commentaar).
 * @param {string} sql SQL in SQLite-stijl.
 * @returns {string} SQL voor PostgreSQL.
 */
function toPgParams(sql) {
  let out = '';
  let paramCount = 0;
  for (let i = 0; i < sql.length; i++) {
    const character = sql[i];
    if (character === "'" || character === '"') {
      const end = sql.indexOf(character, i + 1);
      const stop = end < 0 ? sql.length : end;
      out += sql.slice(i, stop + 1);
      i = stop;
    } else if (character === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (character === '?') {
      out += `$${++paramCount}`;
    } else {
      out += character;
    }
  }
  return out;
}

/**
 * Zet een parameterwaarde om voor pg: undefined wordt null, BigInt wordt tekst.
 * @param {*} value De waarde.
 * @returns {*} De waarde voor pg.
 */
const toPgValue = (value) => (value === undefined ? null : typeof value === 'bigint' ? value.toString() : value);

class PgDatabase {
  /**
   * Database in PostgreSQL met dezelfde synchrone interface als node:sqlite.
   * @param {Bridge} bridge De werkthread met de verbinding.
   * @param {string} schema Het schema van deze database.
   */
  constructor(bridge, schema) {
    this.dialect = 'postgres';
    this.bridge = bridge;
    this.schema = schema;
    this.cache = new Map();
  }

  /**
   * Voert een query uit met parameters.
   * @param {string} sql SQL met $1, $2, ...
   * @param {Array} [params] De parameters.
   * @returns {{ rows: object[], rowCount: number }} Het resultaat.
   */
  query(sql, params = []) {
    return this.bridge.call({ op: 'query', schema: this.schema, sql, params: params.map(toPgValue) });
  }

  /**
   * Bereidt een SQL-opdracht met ?-parameters voor (de omzetting wordt onthouden).
   * @param {string} sql SQL in SQLite-stijl.
   * @returns {{ get: Function, all: Function, run: Function }} Statement met dezelfde functies als node:sqlite.
   */
  prepare(sql) {
    let text = this.cache.get(sql);
    if (!text) {
      text = toPgParams(sql);
      if (this.cache.size > 2000) this.cache.clear();
      this.cache.set(sql, text);
    }
    return {
      /**
       * Eerste rij van het resultaat.
       * @param {...*} params De parameters.
       * @returns {object|undefined} De rij.
       */
      get: (...params) => this.query(text, params).rows[0],
      /**
       * Alle rijen van het resultaat.
       * @param {...*} params De parameters.
       * @returns {object[]} De rijen.
       */
      all: (...params) => this.query(text, params).rows,
      /**
       * Voert een wijziging uit.
       * @param {...*} params De parameters.
       * @returns {{ changes: number }} Aantal gewijzigde rijen.
       */
      run: (...params) => ({ changes: this.query(text, params).rowCount }),
    };
  }

  /**
   * Voert één of meer statements zonder parameters uit (BEGIN IMMEDIATE wordt BEGIN).
   * @param {string} sql De SQL.
   * @returns {void}
   */
  exec(sql) {
    this.bridge.call({ op: 'exec', schema: this.schema, sql: String(sql).replace(/^\s*BEGIN\s+IMMEDIATE\b/i, 'BEGIN') });
  }

  /**
   * Doet niets: de verbinding is gedeeld (per URL) en stopt vanzelf met het proces.
   * @returns {void}
   */
  close() {}
}

/**
 * Verbindingsinstellingen voor pg uit een postgres://-URL. Weigert de
 * transaction pooler van Supabase (poort 6543, verliest search_path) en regelt
 * TLS zelf: sslmode=disable zonder TLS (alleen lokaal), no-verify zonder
 * controle, anders TLS met controle van certificaat en hostnaam (met de root-CA
 * van Supabase of DATABASE_CA_FILE).
 * @param {string} url De database-URL.
 * @param {{ caFile?: string }} [options] Eigen CA-bestand.
 * @returns {object} Instellingen voor new pg.Client().
 * @throws {Error} Bij een ongeldige URL of de transaction pooler.
 */
function pgConfig(url, { caFile = process.env.DATABASE_CA_FILE } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is geen geldige postgres://-URL.');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) throw new Error('DATABASE_URL moet met postgres:// of postgresql:// beginnen.');
  // De transaction pooler van Supabase (poort 6543) wisselt per transactie
  // van verbinding; dan gaan search_path en sessie-instellingen verloren.
  if (/\.pooler\.supabase\.com$/i.test(parsed.hostname) && parsed.port === '6543') {
    throw new Error('Gebruik de Session pooler van Supabase (poort 5432), niet de Transaction pooler (6543).');
  }
  // sslmode zelf afhandelen (pg zou 'require' anders anders uitleggen):
  // disable = geen TLS (alleen lokaal), no-verify = TLS zonder controle,
  // verder altijd TLS met controle van certificaat en hostnaam.
  const mode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
  for (const param of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) parsed.searchParams.delete(param);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  let ssl;
  if (mode === 'disable' || (local && !mode)) ssl = false;
  else if (mode === 'no-verify') ssl = { rejectUnauthorized: false };
  else {
    ssl = { rejectUnauthorized: true };
    // Supabase tekent zijn databasecertificaten met een eigen root-CA
    // (openbaar, meegeleverd); een eigen CA kan via DATABASE_CA_FILE.
    const extraCas = [];
    if (caFile) extraCas.push(fs.readFileSync(caFile, 'utf8'));
    else if (/\.supabase\.(co|com)$/i.test(parsed.hostname)) extraCas.push(fs.readFileSync(SUPABASE_CA, 'utf8'));
    if (extraCas.length) ssl.ca = [...require('tls').rootCertificates, ...extraCas];
  }
  return {
    connectionString: parsed.toString(),
    ssl,
    keepAlive: true,
    connectionTimeoutMillis: Math.min(TIMEOUT_MS, 15000),
    application_name: 'aquatech',
  };
}

/**
 * De werkthread voor deze URL (één per URL per proces); een gestopte wordt vervangen.
 * @param {string} url De database-URL.
 * @returns {Bridge} De werkthread.
 */
function bridgeFor(url) {
  let bridge = bridges.get(url);
  if (!bridge || bridge.dead) {
    bridge = new Bridge(pgConfig(url));
    bridges.set(url, bridge);
  }
  return bridge;
}

/**
 * Opent (en migreert) de database in PostgreSQL, in een eigen schema voor de
 * app (standaard "aquatech"; niet "public", want dat stelt Supabase via de
 * REST-API open).
 * @param {string} url De database-URL.
 * @param {{ schema?: string }} [options] Naam van het schema.
 * @returns {PgDatabase} De database.
 */
function openPg(url, { schema = process.env.DATABASE_SCHEMA || 'aquatech' } = {}) {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`DATABASE_SCHEMA "${schema}": alleen kleine letters, cijfers en _.`);
  const db = new PgDatabase(bridgeFor(url), schema);
  migratePg(db);
  return db;
}

/**
 * Schemaversie in de tabel schema_version (maakt de tabel zo nodig aan).
 * @param {PgDatabase} db De database.
 * @returns {number} De versie, 0 bij een nieuw schema.
 */
const versionOf = (db) => {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version BIGINT NOT NULL)');
  return db.prepare('SELECT version FROM schema_version').get()?.version || 0;
};

/**
 * Brengt het schema naar de nieuwste versie: een nieuw schema krijgt PG_BASE,
 * daarna de migraties uit PG_MIGRATIONS. Twee processen tegelijk migreren nooit
 * samen (advisory lock).
 * @param {PgDatabase} db De database.
 * @returns {void}
 */
function migratePg(db) {
  db.exec('BEGIN');
  try {
    // Twee processen tegelijk (bijv. bij een update) migreren nooit samen.
    db.prepare('SELECT pg_advisory_xact_lock(hashtext(current_schema()))').get();
    let version = versionOf(db);
    if (version === 0) {
      const existing = db.prepare("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name <> 'schema_version'").get().n;
      if (existing) throw new Error(`Schema "${db.schema}" bevat al tabellen maar geen schema_version; kies een leeg schema.`);
      db.exec(PG_BASE);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(PG_BASE_VERSION);
      version = PG_BASE_VERSION;
    }
    if (version < PG_BASE_VERSION) throw new Error(`Onbekende schemaversie ${version} in PostgreSQL.`);
    for (let step = version; step < PG_BASE_VERSION + PG_MIGRATIONS.length; step++) {
      db.exec(PG_MIGRATIONS[step - PG_BASE_VERSION]);
      db.prepare('UPDATE schema_version SET version = ?').run(step + 1);
    }
    lockDown(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Afscherming in Supabase: row level security aan op elke tabel (zonder
 * policies: de rollen anon en authenticated van de REST-API zien niets; de
 * eigenaar, waarmee de app verbindt, wel) en geen rechten op het schema.
 * @param {PgDatabase} db De database.
 * @returns {void}
 */
function lockDown(db) {
  db.exec(`DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND NOT rowsecurity LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM anon', current_schema());
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM anon', current_schema());
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM authenticated', current_schema());
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM authenticated', current_schema());
  END IF;
END $$`);
}

/**
 * Schemaversie (gelijk aan PRAGMA user_version van SQLite).
 * @param {PgDatabase} db De database.
 * @returns {number} De versie.
 */
const pgVersion = (db) => db.prepare('SELECT version FROM schema_version').get()?.version || 0;

/**
 * Verwijdert alle schema's met dit voorvoegsel (alleen voor tests).
 * @param {string} url De database-URL.
 * @param {string} prefix Voorvoegsel van de schemanamen.
 * @returns {void}
 */
function dropSchemas(url, prefix) {
  const db = new PgDatabase(bridgeFor(url), 'public');
  for (const row of db.prepare('SELECT nspname FROM pg_namespace WHERE starts_with(nspname, ?)').all(prefix)) {
    db.exec(`DROP SCHEMA "${row.nspname}" CASCADE`);
  }
}

module.exports = { openPg, pgConfig, pgVersion, toPgParams, dropSchemas, DatabaseError, PgDatabase };
