// Alle gegevens één op één van de ene database naar de andere kopiëren
// (SQLite → PostgreSQL bij de overstap naar Supabase, PostgreSQL → SQLite
// voor de versleutelde back-ups) en daarna controleren dat beide kanten
// exact gelijk zijn: per tabel het aantal rijen en een SHA-256 over alle
// waarden, op volgorde van de primaire sleutel.
//
// Er wordt niets omgezet of opnieuw versleuteld: id's (UUID's), tenant_id's,
// wachtwoord-hashes, sessie-hashes en versleutelde geheimen (vault, met de
// tenant in de AAD) gaan ongewijzigd over. De hoofdsleutel blijft dus nodig.
const crypto = require('crypto');
const { transaction, listTables, tableColumns, deferForeignKeys, schemaVersion, isPg } = require('./db');

const BATCH = 200;
// Tabellen met grote rijen (foto's) in kleinere porties, zodat het geheugen klein blijft.
const BATCH_OF = { work_order_photos: 10 };

function describe(db) {
  const tables = {};
  for (const name of listTables(db)) {
    const cols = tableColumns(db, name);
    const pk = cols.filter((c) => c.pk).map((c) => c.name);
    tables[name] = { columns: cols.map((c) => c.name), order: pk.length ? pk : cols.map((c) => c.name) };
  }
  return tables;
}

function* rowsOf(db, table, { columns, order }) {
  const sql = `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${order.join(', ')} LIMIT ? OFFSET ?`;
  const stmt = db.prepare(sql);
  const size = BATCH_OF[table] || BATCH;
  for (let off = 0; ; off += size) {
    const batch = stmt.all(size, off);
    for (const r of batch) yield r;
    if (batch.length < size) return;
  }
}

// Leesbare kopie van de hele database op één moment.
function snapshot(db, fn) {
  db.exec(isPg(db) ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
  try {
    return fn();
  } finally {
    db.exec('COMMIT');
  }
}

const value = (v) => (v === null || v === undefined ? null : typeof v === 'bigint' ? Number(v) : v);

/** { tabel: { rows, sha256 } } over alle tabellen. */
function fingerprint(db, tables = describe(db)) {
  return snapshot(db, () => {
    const out = {};
    for (const [name, t] of Object.entries(tables)) {
      const h = crypto.createHash('sha256');
      let rows = 0;
      for (const r of rowsOf(db, name, t)) {
        h.update(JSON.stringify(t.columns.map((c) => {
          const v = value(r[c]);
          // Type meenemen: "1" (tekst) en 1 (getal) zijn niet hetzelfde.
          return v === null ? null : [typeof v, v];
        })));
        h.update('\n');
        rows++;
      }
      out[name] = { rows, sha256: h.digest('hex') };
    }
    return out;
  });
}

/**
 * Kopieert alle rijen van `from` naar `to`. `to` moet hetzelfde schema
 * (dezelfde versie) hebben en leeg zijn. Geeft { tables, source, target }
 * (aantallen per tabel en de vingerafdrukken van beide kanten).
 */
function copyDatabase(from, to, { log = () => {} } = {}) {
  if (from === to || (from.bridge && from.bridge === to.bridge)) throw new Error('Bron en doel moeten verschillende databases zijn.');
  const vFrom = schemaVersion(from);
  const vTo = schemaVersion(to);
  if (vFrom !== vTo) throw new Error(`Schemaversie verschilt: bron ${vFrom}, doel ${vTo}. Werk eerst beide bij naar dezelfde versie van de app.`);
  const src = describe(from);
  const dst = describe(to);
  const names = Object.keys(src).sort();
  if (names.join() !== Object.keys(dst).sort().join()) {
    throw new Error(`Tabellen verschillen: bron [${names.join(', ')}], doel [${Object.keys(dst).sort().join(', ')}].`);
  }
  for (const n of names) {
    if (src[n].columns.join() !== dst[n].columns.join()) throw new Error(`Kolommen van ${n} verschillen: bron [${src[n].columns}], doel [${dst[n].columns}].`);
    const filled = to.prepare(`SELECT COUNT(*) AS n FROM ${n}`).get().n;
    if (filled) throw new Error(`Doeldatabase is niet leeg (${n}: ${filled} rijen). Kopieer alleen naar een lege database.`);
  }

  const counts = {};
  snapshot(from, () => transaction(to, () => {
    // Volgorde van tabellen doet er niet toe: foreign keys pas bij COMMIT.
    deferForeignKeys(to);
    for (const n of names) {
      const { columns } = src[n];
      const insert = to.prepare(`INSERT INTO ${n} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
      let rows = 0;
      for (const r of rowsOf(from, n, src[n])) {
        insert.run(...columns.map((c) => value(r[c])));
        rows++;
      }
      counts[n] = rows;
      log(`${n}: ${rows} rij(en)`);
    }
  }));

  const a = fingerprint(from, src);
  const b = fingerprint(to, src);
  const diff = names.filter((n) => a[n].rows !== b[n].rows || a[n].sha256 !== b[n].sha256);
  if (diff.length) {
    throw new Error(`Controle mislukt, verschil in: ${diff.map((n) => `${n} (bron ${a[n].rows}, doel ${b[n].rows} rijen)`).join(', ')}.`);
  }
  return { tables: counts, source: a, target: b };
}

module.exports = { copyDatabase, fingerprint, describe };
