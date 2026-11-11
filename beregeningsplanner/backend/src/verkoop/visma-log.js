// Logboek van de Visma-koppeling (tabel visma_log, per omgeving): wat is er wanneer naar
// Visma gestuurd of ervan gelezen, door wie of wat (handmatig of automatisch) en met welke
// uitkomst. Alleen korte, leesbare meldingen: nooit tokens, secrets of volledige antwoorden.
//
// - Een fout die zich herhaalt (hetzelfde onderdeel, dezelfde verwijzing en dezelfde melding,
//   bijv. een factuur die elke 10 minuten opnieuw mislukt) krijgt geen nieuwe regel maar
//   verhoogt `repeat_count` en `last_at` (bron, naam en `created_at` blijven die van de eerste keer, dus de sortering en de cursor schuiven niet): het logboek loopt niet vol.
// - Een geslaagde leesactie van hetzelfde onderdeel binnen 30 minuten wordt niet opnieuw gelogd.
// - Bewaartermijn: die van het auditlog (auditRetentionDays), via prune().
// - Lijst met keyset-paginering (nieuwste eerst), dus snel bij een groot logboek.
const crypto = require('crypto');

const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;
const READ_DEDUPE_MS = 30 * 60 * 1000;
const COLUMNS = 'id, created_at, last_at, kind, direction, ok, source, actor, reference, message, repeat_count';
const KINDS = ['verbonden', 'verbroken', 'klant', 'factuur', 'opties', 'aanmelding'];
const DIRECTIONS = ['naar', 'van', ''];

/**
 * Maakt van een waarde korte tekst zonder regeleinden.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximaal aantal tekens.
 * @returns {string} De tekst.
 */
const shorten = (value, maxLength) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLength);

/**
 * Maakt de opslag voor het Visma-logboek.
 * @param {object} db Databaseverbinding.
 * @returns {{ record: Function, list: Function, prune: Function }} De opslagfuncties.
 */
function createVismaLog(db) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL met ?-parameters.
   * @returns {object} Het voorbereide statement.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Legt één gebeurtenis vast. Een herhaalde fout of herhaalde leesactie voegt geen regel toe.
   * @param {string} tenantId De omgeving.
   * @param {object} entry kind (zie KINDS), direction ('naar' | 'van' | ''), ok (boolean), source ('automatisch' | 'handmatig'), actor (naam, leeg bij automatisch), reference (bijv. factuurnummer) en message.
   * @returns {string|null} Id van de nieuwe of bijgewerkte regel, of null als er niets is vastgelegd.
   */
  function record(tenantId, { kind, direction = '', ok, source = 'automatisch', actor = '', reference = '', message = '' }) {
    if (!KINDS.includes(kind)) throw new Error(`Onbekend soort Visma-logregel: ${kind}`);
    const entry = {
      direction: DIRECTIONS.includes(direction) ? direction : '',
      ok: ok ? 1 : 0,
      source: source === 'handmatig' ? 'handmatig' : 'automatisch',
      actor: shorten(actor, 120),
      reference: shorten(reference, 80),
      message: shorten(message, 300),
    };
    const now = new Date();
    const last = prepare('SELECT id, ok, message, created_at FROM visma_log WHERE tenant_id = ? AND kind = ? AND reference = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(tenantId, kind, entry.reference);
    if (last && !entry.ok && !Number(last.ok) && last.message === entry.message) {
      // source en actor blijven van de eerste keer: een automatische herhaling wist niet wie het handmatig startte.
      prepare('UPDATE visma_log SET last_at = ?, repeat_count = repeat_count + 1 WHERE tenant_id = ? AND id = ?')
        .run(now.toISOString(), tenantId, last.id);
      return last.id;
    }
    if (kind === 'opties' && entry.ok && last && Number(last.ok) && now.getTime() - new Date(last.created_at).getTime() < READ_DEDUPE_MS) return null;
    const id = crypto.randomUUID();
    prepare(`INSERT INTO visma_log (id, tenant_id, created_at, last_at, kind, direction, ok, source, actor, reference, message, repeat_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(id, tenantId, now.toISOString(), now.toISOString(), kind, entry.direction, entry.ok, entry.source, entry.actor, entry.reference, entry.message);
    return id;
  }

  /**
   * Eén pagina van het logboek, nieuwste eerst.
   * @param {string} tenantId De omgeving.
   * @param {object} [options] limit (1-100, standaard 50), before (cursor uit een vorig antwoord) en onlyErrors.
   * @returns {{ items: object[], next: string|null }} De regels en de cursor voor de volgende pagina (null als er geen meer is).
   */
  function list(tenantId, { limit = DEFAULT_PAGE, before = '', onlyErrors = false } = {}) {
    const pageSize = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(limit)) || DEFAULT_PAGE));
    const [beforeTime, beforeId] = String(before || '').split('|');
    const paged = Boolean(beforeTime && beforeId);
    const limitArgs = [pageSize + 1];
    let rows;
    if (onlyErrors && paged) rows = prepare(`SELECT ${COLUMNS} FROM visma_log WHERE tenant_id = ? AND ok = 0 AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`).all(tenantId, beforeTime, beforeTime, beforeId, ...limitArgs);
    else if (onlyErrors) rows = prepare(`SELECT ${COLUMNS} FROM visma_log WHERE tenant_id = ? AND ok = 0 ORDER BY created_at DESC, id DESC LIMIT ?`).all(tenantId, ...limitArgs);
    else if (paged) rows = prepare(`SELECT ${COLUMNS} FROM visma_log WHERE tenant_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`).all(tenantId, beforeTime, beforeTime, beforeId, ...limitArgs);
    else rows = prepare(`SELECT ${COLUMNS} FROM visma_log WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(tenantId, ...limitArgs);
    const more = rows.length > pageSize;
    const page = more ? rows.slice(0, pageSize) : rows;
    const items = page.map((row) => ({
      id: row.id, at: row.created_at, lastAt: row.last_at, kind: row.kind, direction: row.direction, ok: Boolean(Number(row.ok)), source: row.source,
      actor: row.actor, reference: row.reference, message: row.message, count: Number(row.repeat_count) || 1,
    }));
    const lastRow = page[page.length - 1];
    return { items, next: more && lastRow ? `${lastRow.created_at}|${lastRow.id}` : null };
  }

  /**
   * Bewaartermijn: verwijdert regels ouder dan `days` dagen.
   * @param {string} tenantId De omgeving.
   * @param {number} days Bewaartermijn in dagen.
   * @returns {number} Aantal verwijderde regels.
   */
  function prune(tenantId, days) {
    const before = new Date(Date.now() - days * 86400000).toISOString();
    return prepare('DELETE FROM visma_log WHERE tenant_id = ? AND last_at < ?').run(tenantId, before).changes;
  }

  return { record, list, prune };
}

module.exports = { createVismaLog, KINDS };
