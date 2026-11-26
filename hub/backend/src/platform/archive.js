// Archief: gegevens (plannen, offertes, werkorders, facturen, webshopbestellingen en klanten) uit het zicht halen zonder ze te wissen,
// terughalen, in bulk archiveren op datum of zoekterm, en het archief ten slotte definitief verwijderen.
// Gearchiveerd = kolom archived_at gevuld. Planner-leerdata (plan_recognitions) en artikelspecificaties (item_specs) blijven altijd staan.
const { transaction } = require('../database/db');
const { recordFloor } = require('./number-floors');

/** Wettelijke bewaartermijn voor facturen (jaren): een definitieve factuur jonger dan dit wordt niet definitief verwijderd. */
const INVOICE_RETENTION_YEARS = 7;
/** Hoeveel voorbeeldregels het voorbeeld van een bulkactie toont. */
const SAMPLE_LIMIT = 20;
/** Hoeveel stukken één verzoek hoogstens raakt (een verzoek is één transactie per stuk, dus dit begrenst de duur). */
const MAX_PER_REQUEST = 2000;

/**
 * De soorten gegevens die gearchiveerd kunnen worden. `alias` is de tabelalias in de queries, `number`/`title`/`customer` zijn SQL-uitdrukkingen
 * voor de weergave en het zoeken, `base` is de voorwaarde die bepaalt wat überhaupt meetelt (niet zacht verwijderd).
 */
const KINDS = {
  plannen: { label: 'Plannen', table: 'plans', alias: 'p', number: "''", title: 'p.title', customer: 'p.customer', base: 'p.deleted_at IS NULL' },
  offertes: { label: 'Offertes', table: 'quotes', alias: 'q', number: 'q.number', title: 'q.title', customer: 'q.customer', base: 'q.deleted_at IS NULL' },
  werkorders: { label: 'Werkorders', table: 'work_orders', alias: 'w', number: 'w.number', title: 'w.title', customer: 'w.customer', base: 'w.deleted_at IS NULL' },
  facturen: { label: 'Facturen', table: 'invoices', alias: 'i', number: "COALESCE(i.number, 'concept')", title: "''", customer: 'i.customer_name', base: 'TRUE' },
  bestellingen: { label: 'Webshopbestellingen', table: 'web_orders', alias: 'o', number: 'o.number', title: "''", customer: 'o.customer_name', base: 'TRUE' },
  klanten: { label: 'Klanten', table: 'users', alias: 'u', number: "''", title: 'u.display_name', customer: "COALESCE(u.company_name, '')", base: "u.kind = 'account'" },
};

/**
 * Maakt een archief-object voor een database.
 * @param {object} db De database.
 * @param {{ customerRoleKeys: function(string): string[], purgePlan: function(string, string): *, today?: function(): Date, audit?: function }} deps customerRoleKeys (rollen van het soort klant per tenant), purgePlan (plan-store, wist het plan en anonimiseert de historie zonder de leerdata te raken) en optioneel today (voor tests).
 * @returns {object} kinds, archive, restore, preview, archiveMatching, list, counts, purge, retentionCutoff.
 */
function createArchive(db, { customerRoleKeys, purgePlan, today = () => new Date() }) {
  /**
   * Bereidt een query voor.
   * @param {string} sql De query.
   * @returns {object} De voorbereide query.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * Maakt een rij vraagtekens voor een IN-lijst.
   * @param {number} count Aantal parameters.
   * @returns {string} De vraagtekens, gescheiden door komma's.
   */
  const marks = (count) => Array(count).fill('?').join(', ');

  /**
   * Zorgt dat een soortnaam bekend is.
   * @param {string} kind Soortnaam.
   * @returns {object|null} De beschrijving of null.
   */
  const kindOf = (kind) => (Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null);

  /**
   * De bewaargrens voor facturen: facturen met een datum tot en met deze dag mogen weg.
   * @returns {string} Datum (JJJJ-MM-DD) van zeven jaar geleden.
   */
  function retentionCutoff() {
    const date = today();
    return `${date.getUTCFullYear() - INVOICE_RETENTION_YEARS}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  /**
   * Basisvoorwaarde en parameters van een soort (tenant, wat meetelt, eventueel alleen klantrollen).
   * @param {object} spec De soortbeschrijving.
   * @param {string} tenantId Id van de tenant.
   * @param {string} kind Soortnaam.
   * @returns {{ where: string[], args: Array }|null} Voorwaarden en parameters, of null als de soort in deze tenant niets kan bevatten.
   */
  function baseOf(spec, tenantId, kind) {
    const where = [`${spec.alias}.tenant_id = ?`, spec.base];
    const args = [tenantId];
    if (kind === 'klanten') {
      const keys = customerRoleKeys(tenantId);
      if (!keys.length) return null;
      where.push(`u.role IN (${marks(keys.length)})`);
      args.push(...keys);
    }
    return { where, args };
  }

  /**
   * Bouwt de voorwaarden van een selectie.
   * @param {string} tenantId Id van de tenant.
   * @param {string} kind Soortnaam.
   * @param {{ state?: string, ids?: string[], before?: string, query?: string }} selection state `actief` of `archief`, ids, `before` (aangemaakt vóór deze datum JJJJ-MM-DD) en een zoekterm op nummer, titel en klant.
   * @returns {{ spec: object, from: string, where: string, args: Array }|null} De delen van de query, of null.
   */
  function selectionOf(tenantId, kind, { state = 'actief', ids = null, before = '', query = '' } = {}) {
    const spec = kindOf(kind);
    if (!spec) return null;
    const base = baseOf(spec, tenantId, kind);
    if (!base) return null;
    const { where, args } = base;
    where.push(state === 'archief' ? `${spec.alias}.archived_at IS NOT NULL` : `${spec.alias}.archived_at IS NULL`);
    if (Array.isArray(ids)) {
      if (!ids.length) return null;
      where.push(`${spec.alias}.id IN (${marks(ids.length)})`);
      args.push(...ids.map(String));
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(before || ''))) { where.push(`${spec.alias}.created_at::text < ?`); args.push(before); }
    const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
    for (const word of words) {
      where.push(`lower(${spec.number} || ' ' || ${spec.title} || ' ' || ${spec.customer}) LIKE ? ESCAPE '\\'`);
      args.push(`%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
    }
    return { spec, from: `${spec.table} ${spec.alias}`, where: where.join(' AND '), args };
  }

  /**
   * Zet archived_at voor een selectie.
   * @param {string} tenantId Id van de tenant.
   * @param {string} kind Soortnaam.
   * @param {object} selection Zie selectionOf (state bepaalt de bron: `actief` om te archiveren, `archief` om terug te halen).
   * @param {boolean} archiveIt True = archiveren, false = terughalen.
   * @returns {number} Aantal gewijzigde regels.
   */
  function setFlag(tenantId, kind, selection, archiveIt) {
    const part = selectionOf(tenantId, kind, { ...selection, state: archiveIt ? 'actief' : 'archief' });
    if (!part) return 0;
    const alias = part.spec.alias;
    const ids = prepare(`SELECT ${alias}.id AS id FROM ${part.from} WHERE ${part.where} LIMIT ${MAX_PER_REQUEST}`).all(...part.args).map((row) => row.id);
    if (!ids.length) return 0;
    const value = archiveIt ? new Date().toISOString() : null;
    return prepare(`UPDATE ${part.spec.table} SET archived_at = ? WHERE tenant_id = ? AND id IN (${marks(ids.length)})`).run(value, tenantId, ...ids).changes;
  }

  /**
   * Archiveert gekozen stukken.
   * @param {string} tenantId Id van de tenant.
   * @param {string} kind Soortnaam.
   * @param {string[]} ids Id's.
   * @returns {number} Aantal gearchiveerd.
   */
  const archive = (tenantId, kind, ids) => setFlag(tenantId, kind, { ids }, true);

  /**
   * Haalt gekozen stukken uit het archief terug.
   * @param {string} tenantId Id van de tenant.
   * @param {string} kind Soortnaam.
   * @param {string[]} ids Id's.
   * @returns {number} Aantal teruggehaald.
   */
  const restore = (tenantId, kind, ids) => setFlag(tenantId, kind, { ids }, false);

  /**
   * Telt per soort wat er actief en in het archief staat.
   * @param {string} tenantId Id van de tenant.
   * @returns {object} Per soort { label, active, archived }.
   */
  function counts(tenantId) {
    const out = {};
    for (const kind of Object.keys(KINDS)) {
      const entry = { label: KINDS[kind].label, active: 0, archived: 0 };
      for (const state of ['actief', 'archief']) {
        const part = selectionOf(tenantId, kind, { state });
        if (part) entry[state === 'actief' ? 'active' : 'archived'] = Number(prepare(`SELECT COUNT(*) AS n FROM ${part.from} WHERE ${part.where}`).get(...part.args).n);
      }
      out[kind] = entry;
    }
    return out;
  }

  /**
   * Voorbeeld van een bulkselectie: per soort het aantal en een paar regels.
   * @param {string} tenantId Id van de tenant.
   * @param {{ kinds?: string[], state?: string, before?: string, query?: string }} filters Soorten (leeg = alle) en de selectie.
   * @returns {{ total: number, kinds: object }} Totaal en per soort { label, count, sample }.
   */
  function preview(tenantId, { kinds = null, state = 'actief', before = '', query = '' } = {}) {
    const wanted = Array.isArray(kinds) && kinds.length ? kinds.filter((kind) => kindOf(kind)) : Object.keys(KINDS);
    const out = {};
    let total = 0;
    for (const kind of wanted) {
      const part = selectionOf(tenantId, kind, { state, before, query });
      const entry = { label: KINDS[kind].label, count: 0, sample: [] };
      if (part) {
        const alias = part.spec.alias;
        entry.count = Number(prepare(`SELECT COUNT(*) AS n FROM ${part.from} WHERE ${part.where}`).get(...part.args).n);
        entry.sample = prepare(`SELECT ${alias}.id AS id, ${part.spec.number} AS number, ${part.spec.title} AS title, ${part.spec.customer} AS customer, ${alias}.created_at::text AS created_at
          FROM ${part.from} WHERE ${part.where} ORDER BY ${alias}.created_at DESC, ${alias}.id LIMIT ${SAMPLE_LIMIT}`).all(...part.args);
      }
      total += entry.count;
      out[kind] = entry;
    }
    return { total, kinds: out };
  }

  /**
   * Archiveert alles wat bij de selectie past (per soort).
   * @param {string} tenantId Id van de tenant.
   * @param {{ kinds?: string[], before?: string, query?: string }} filters Zie preview.
   * @returns {object} Per soort het aantal gearchiveerde stukken.
   */
  function archiveMatching(tenantId, { kinds = null, before = '', query = '' } = {}) {
    const wanted = Array.isArray(kinds) && kinds.length ? kinds.filter((kind) => kindOf(kind)) : Object.keys(KINDS);
    const out = {};
    for (const kind of wanted) out[kind] = setFlag(tenantId, kind, { before, query }, true);
    return out;
  }

  /**
   * De stukken in het archief (voor het archiefscherm), nieuwst gearchiveerd eerst.
   * @param {string} tenantId Id van de tenant.
   * @param {{ kind: string, query?: string, limit?: number, offset?: number }} options Soort, zoekterm en pagina.
   * @returns {{ total: number, items: object[] }} Totaal en regels.
   */
  function list(tenantId, { kind, query = '', limit = 50, offset = 0 } = {}) {
    const part = selectionOf(tenantId, kind, { state: 'archief', query });
    if (!part) return { total: 0, items: [] };
    const alias = part.spec.alias;
    const total = Number(prepare(`SELECT COUNT(*) AS n FROM ${part.from} WHERE ${part.where}`).get(...part.args).n);
    const items = prepare(`SELECT ${alias}.id AS id, ${part.spec.number} AS number, ${part.spec.title} AS title, ${part.spec.customer} AS customer,
        ${alias}.created_at::text AS created_at, ${alias}.archived_at::text AS archived_at
      FROM ${part.from} WHERE ${part.where} ORDER BY ${alias}.archived_at DESC, ${alias}.id LIMIT ? OFFSET ?`)
      .all(...part.args, Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
    return { total, items };
  }

  /**
   * Verwijdert één gearchiveerd stuk definitief (binnen een eigen transactie). Leerdata en artikelspecificaties blijven.
   * @param {string} tenantId Id van de tenant.
   * @param {string} kind Soortnaam.
   * @param {object} row Rij uit de selectie (id, number, invoice_date, status voor facturen).
   * @returns {{ deleted: boolean, reason?: string }} Of het gelukt is, anders de reden.
   */
  function purgeOne(tenantId, kind, row) {
    const spec = KINDS[kind];
    if (kind === 'facturen' && row.status !== 'concept' && String(row.invoice_date) > retentionCutoff()) {
      return { deleted: false, reason: `Bewaarplicht: een definitieve factuur wordt ${INVOICE_RETENTION_YEARS} jaar bewaard (tot ${String(Number(String(row.invoice_date).slice(0, 4)) + INVOICE_RETENTION_YEARS)}).` };
    }
    try {
      transaction(db, () => {
        const numberKind = { offertes: 'offertes', werkorders: 'werkorders', facturen: 'facturen', bestellingen: 'bestellingen' }[kind];
        if (numberKind && row.number) recordFloor(prepare, tenantId, numberKind, row.number);
        if (kind === 'plannen') purgePlan(tenantId, row.id);
        else prepare(`DELETE FROM ${spec.table} WHERE tenant_id = ? AND id = ? AND archived_at IS NOT NULL`).run(tenantId, row.id);
      });
      return { deleted: true };
    } catch (error) {
      if (error && (error.code === '23503' || /foreign key|violates/i.test(String(error.message)))) {
        return { deleted: false, reason: 'Nog gekoppeld aan ander werk (bijvoorbeeld een offerte, werkorder of factuur). Verwijder of haal dat eerst weg.' };
      }
      throw error;
    }
  }

  /**
   * Verwijdert het archief definitief (alleen stukken die al gearchiveerd zijn), in een volgorde die koppelingen respecteert.
   * @param {string} tenantId Id van de tenant.
   * @param {{ kinds?: string[], before?: string, query?: string }} filters Welke gearchiveerde stukken (leeg = alles in het archief).
   * @returns {{ deleted: object, blocked: object[], truncated: boolean }} Per soort het aantal verwijderd en de geblokkeerde stukken met reden.
   */
  function purge(tenantId, { kinds = null, before = '', query = '' } = {}) {
    const order = ['facturen', 'bestellingen', 'werkorders', 'offertes', 'plannen', 'klanten'];
    const wanted = order.filter((kind) => !(Array.isArray(kinds) && kinds.length) || kinds.includes(kind));
    const deleted = {};
    const blocked = [];
    let budget = MAX_PER_REQUEST;
    for (const kind of wanted) {
      deleted[kind] = 0;
      const part = selectionOf(tenantId, kind, { state: 'archief', before, query });
      if (!part || budget <= 0) continue;
      const alias = part.spec.alias;
      const extra = kind === 'facturen' ? ', i.invoice_date AS invoice_date, i.status AS status' : '';
      const rows = prepare(`SELECT ${alias}.id AS id, ${part.spec.number} AS number${extra} FROM ${part.from} WHERE ${part.where} ORDER BY ${alias}.created_at, ${alias}.id LIMIT ${budget}`).all(...part.args);
      for (const row of rows) {
        budget -= 1;
        const result = purgeOne(tenantId, kind, row);
        if (result.deleted) deleted[kind] += 1;
        else blocked.push({ kind, label: KINDS[kind].label, id: row.id, number: row.number, reason: result.reason });
      }
    }
    return { deleted, blocked, truncated: budget <= 0 };
  }

  return { kinds: KINDS, archive, restore, preview, archiveMatching, list, counts, purge, retentionCutoff };
}

module.exports = { createArchive, KINDS, INVOICE_RETENTION_YEARS };
