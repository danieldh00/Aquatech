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

  call(msg) {
    if (this.dead) throw new DatabaseError({ message: `Database niet beschikbaar: ${this.dead.message}` });
    const id = ++this.seq;
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage({ ...msg, id });
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const reply = this.take(id);
      if (reply) {
        if (reply.error) throw new DatabaseError(reply.error);
        return reply;
      }
      const left = deadline - Date.now();
      if (left <= 0 || Atomics.wait(this.flag, 0, 0, left) === 'timed-out') {
        // Laatste kans: het antwoord kan net binnen zijn.
        const late = this.take(id);
        if (late) { if (late.error) throw new DatabaseError(late.error); return late; }
        throw new DatabaseError({ message: `Database antwoordt niet binnen ${TIMEOUT_MS} ms.`, code: 'ETIMEDOUT' });
      }
    }
  }

  // Haalt het antwoord met dit id op (oudere, te late antwoorden vervallen).
  take(id) {
    for (;;) {
      const m = receiveMessageOnPort(this.port);
      if (!m) {
        Atomics.store(this.flag, 0, 0);
        // Tussen leeglezen en de vlag terugzetten kan nog iets binnenkomen.
        const again = receiveMessageOnPort(this.port);
        if (!again) return null;
        if (again.message.id === id) return again.message;
        continue;
      }
      if (m.message.id === id) return m.message;
    }
  }
}

/** ?-parameters omzetten naar $1, $2, ... (niet binnen strings of namen). */
function toPgParams(sql) {
  let out = '';
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = sql.indexOf(c, i + 1);
      const stop = end < 0 ? sql.length : end;
      out += sql.slice(i, stop + 1);
      i = stop;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === '?') {
      out += `$${++n}`;
    } else {
      out += c;
    }
  }
  return out;
}

const toPgValue = (v) => (v === undefined ? null : typeof v === 'bigint' ? v.toString() : v);

class PgDatabase {
  constructor(bridge, schema) {
    this.dialect = 'postgres';
    this.bridge = bridge;
    this.schema = schema;
    this.cache = new Map();
  }

  query(sql, params = []) {
    return this.bridge.call({ op: 'query', schema: this.schema, sql, params: params.map(toPgValue) });
  }

  prepare(sql) {
    let text = this.cache.get(sql);
    if (!text) {
      text = toPgParams(sql);
      if (this.cache.size > 2000) this.cache.clear();
      this.cache.set(sql, text);
    }
    return {
      get: (...params) => this.query(text, params).rows[0],
      all: (...params) => this.query(text, params).rows,
      run: (...params) => ({ changes: this.query(text, params).rowCount }),
    };
  }

  /** Eén of meer statements zonder parameters. */
  exec(sql) {
    this.bridge.call({ op: 'exec', schema: this.schema, sql: String(sql).replace(/^\s*BEGIN\s+IMMEDIATE\b/i, 'BEGIN') });
  }

  // De verbinding is gedeeld (per URL) en stopt vanzelf met het proces.
  close() {}
}

/** Verbindingsinstellingen voor pg uit een postgres://-URL. */
function pgConfig(url, { caFile = process.env.DATABASE_CA_FILE } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is geen geldige postgres://-URL.');
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('DATABASE_URL moet met postgres:// of postgresql:// beginnen.');
  // De transaction pooler van Supabase (poort 6543) wisselt per transactie
  // van verbinding; dan gaan search_path en sessie-instellingen verloren.
  if (/\.pooler\.supabase\.com$/i.test(u.hostname) && u.port === '6543') {
    throw new Error('Gebruik de Session pooler van Supabase (poort 5432), niet de Transaction pooler (6543).');
  }
  // sslmode zelf afhandelen (pg zou 'require' anders anders uitleggen):
  // disable = geen TLS (alleen lokaal), no-verify = TLS zonder controle,
  // verder altijd TLS met controle van certificaat en hostnaam.
  const mode = (u.searchParams.get('sslmode') || '').toLowerCase();
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) u.searchParams.delete(k);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  let ssl;
  if (mode === 'disable' || (local && !mode)) ssl = false;
  else if (mode === 'no-verify') ssl = { rejectUnauthorized: false };
  else {
    ssl = { rejectUnauthorized: true };
    // Supabase tekent zijn databasecertificaten met een eigen root-CA
    // (openbaar, meegeleverd); een eigen CA kan via DATABASE_CA_FILE.
    const cas = [];
    if (caFile) cas.push(fs.readFileSync(caFile, 'utf8'));
    else if (/\.supabase\.(co|com)$/i.test(u.hostname)) cas.push(fs.readFileSync(SUPABASE_CA, 'utf8'));
    if (cas.length) ssl.ca = [...require('tls').rootCertificates, ...cas];
  }
  return {
    connectionString: u.toString(),
    ssl,
    keepAlive: true,
    connectionTimeoutMillis: Math.min(TIMEOUT_MS, 15000),
    application_name: 'aquatech',
  };
}

function bridgeFor(url) {
  let b = bridges.get(url);
  if (!b || b.dead) {
    b = new Bridge(pgConfig(url));
    bridges.set(url, b);
  }
  return b;
}

/**
 * Opent (en migreert) de database in PostgreSQL. schema: eigen schema voor
 * de app (standaard "aquatech"; niet "public", want dat stelt Supabase via
 * de REST-API open).
 */
function openPg(url, { schema = process.env.DATABASE_SCHEMA || 'aquatech' } = {}) {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`DATABASE_SCHEMA "${schema}": alleen kleine letters, cijfers en _.`);
  const db = new PgDatabase(bridgeFor(url), schema);
  migratePg(db);
  return db;
}

const versionOf = (db) => {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version BIGINT NOT NULL)');
  return db.prepare('SELECT version FROM schema_version').get()?.version || 0;
};

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
    for (let v = version; v < PG_BASE_VERSION + PG_MIGRATIONS.length; v++) {
      db.exec(PG_MIGRATIONS[v - PG_BASE_VERSION]);
      db.prepare('UPDATE schema_version SET version = ?').run(v + 1);
    }
    lockDown(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Afscherming in Supabase: row level security aan op elke tabel (zonder
// policies: de rollen anon en authenticated van de REST-API zien niets; de
// eigenaar, waarmee de app verbindt, wel) en geen rechten op het schema.
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

/** Schemaversie (gelijk aan PRAGMA user_version van SQLite). */
const pgVersion = (db) => db.prepare('SELECT version FROM schema_version').get()?.version || 0;

/** Alle schema's met deze voorvoegsel verwijderen (alleen voor tests). */
function dropSchemas(url, prefix) {
  const db = new PgDatabase(bridgeFor(url), 'public');
  for (const r of db.prepare('SELECT nspname FROM pg_namespace WHERE starts_with(nspname, ?)').all(prefix)) {
    db.exec(`DROP SCHEMA "${r.nspname}" CASCADE`);
  }
}

module.exports = { openPg, pgConfig, pgVersion, toPgParams, dropSchemas, DatabaseError, PgDatabase };
