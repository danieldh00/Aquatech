// Terugzetten uit een back-up, volledig of gedeeltelijk, zonder de app te stoppen.
//
// Een back-up (backup.js) is een versleutelde SQLite-kopie van de hele database. Hier wordt hij tijdelijk ontsleuteld en
// alleen-lezen geopend; daaruit zijn losse records terug te zetten in de actieve omgeving:
//  - een record dat nu ontbreekt (verwijderd) komt terug, met zijn onderliggende rijen (uren, verpakkingen, ...);
//  - een record dat is gewijzigd krijgt, per gekozen veld, de waarde uit de back-up terug (ook een deel van het JSON-veld
//    `data`, bijvoorbeeld alleen `lines` of `note` van een offerte);
//  - gevoelige velden (wachtwoorden, 2FA, voorraadstand) worden nooit teruggezet.
// Eerst altijd een voorbeeld (preview, schrijft niets); het terugzetten zelf maakt eerst een verse back-up en gebeurt in één
// transactie. Welke soorten records kunnen, en wat er per soort niet overschreven mag worden, staat in ENTITIES.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openSqlite, transaction, tableColumns, foreignKeys } = require('../database/db');
const { decryptFile, keyOf, isBackupName } = require('../backup');

/** Velden die nooit worden teruggezet, in elke tabel. */
const NEVER_RESTORE = new Set(['tenant_id', 'password_hash', 'totp_secret', 'totp_enabled_at', 'totp_last_step', 'totp_recovery', 'platform_admin', 'must_change_password', 'share_hash', 'share_token', 'created_at', 'updated_at']);
const MAX_LIST = 50;
const MAX_IDS = 200;

/**
 * Soorten records die teruggezet kunnen worden. neverColumns = velden die bij een wijziging nooit teruggaan, neverOnInsert = velden die
 * bij een teruggezet (verwijderd) record leeg blijven.
 * overwrite: 'columns' = gewijzigde velden mogen per veld terug; 'never' = alleen een ontbrekend record komt terug.
 * lockedWhen(current, backup): tekst als het huidige record niet overschreven mag worden (bijv. een definitieve factuur).
 */
const ENTITIES = {
  quote: {
    label: 'Offerte', table: 'quotes', numberColumn: 'number', searchColumns: ['number', 'title', 'customer'], jsonColumns: ['data', 'acceptance'],
    summary: (row) => `${row.number || ''} ${row.title || ''} ${row.customer ? `· ${row.customer}` : ''}`.trim(), overwrite: 'columns',
    // Status, nummer en koppelingen volgen uit wat er met het document gebeurde; ze gaan nooit per veld terug (anders omzeil je de vergrendeling).
    neverColumns: ['status', 'number', 'acceptance', 'sent_at', 'sent_to', 'responded_at', 'viewed_at', 'last_viewed_at', 'view_count', 'shared_at', 'share_url', 'order_id', 'customer_id', 'plan_id'],
    lockedWhen: (current) => (current.acceptance ? 'Deze offerte is geaccordeerd en vergrendeld.' : ''),
  },
  work_order: {
    label: 'Werkorder', table: 'work_orders', numberColumn: 'number', searchColumns: ['number', 'title', 'customer'], jsonColumns: ['data', 'appointment'],
    summary: (row) => `${row.number || ''} ${row.title || ''} ${row.customer ? `· ${row.customer}` : ''}`.trim(), overwrite: 'columns',
    // Status, nummer en koppelingen volgen uit wat er met het document gebeurde; ze gaan nooit per veld terug (anders omzeil je de vergrendeling).
    neverColumns: ['status', 'number', 'appointment', 'sent_at', 'sent_to', 'viewed_at', 'shared_at', 'share_url', 'quote_id', 'plan_id', 'customer_id'],
    children: [{ table: 'work_order_hours', column: 'work_order_id' }, { table: 'work_order_materials', column: 'work_order_id' }, { table: 'work_order_photos', column: 'work_order_id' }],
  },
  invoice: {
    label: 'Factuur', table: 'invoices', numberColumn: 'number', searchColumns: ['number', 'customer_name'], jsonColumns: ['data'],
    summary: (row) => `${row.number || '(concept)'} · ${row.customer_name || ''} · € ${Number(row.total || 0).toFixed(2)}`, overwrite: 'columns',
    // Status, nummer en koppelingen volgen uit wat er met het document gebeurde; ze gaan nooit per veld terug (anders omzeil je de vergrendeling).
    neverColumns: ['status', 'number', 'kind', 'credit_of', 'finalized_at', 'paid_at', 'credited_at', 'exported_at', 'stock_booked', 'debtor_id', 'shop_order_id', 'work_order_id', 'quote_id', 'customer_id', 'sent_at', 'sent_to', 'send_error', 'visma_invoice_id', 'visma_number', 'visma_synced_at', 'visma_error'],
    lockedWhen: (current) => (current.status !== 'concept' ? 'Een definitieve factuur wordt nooit overschreven (maak een creditnota).' : ''),
  },
  web_order: {
    label: 'Webshopbestelling', table: 'web_orders', numberColumn: 'number', searchColumns: ['number', 'customer_name', 'email'], jsonColumns: ['data'],
    summary: (row) => `${row.number} · ${row.customer_name || ''} · € ${Number(row.total || 0).toFixed(2)} · ${row.status}`, overwrite: 'never',
    children: [{ table: 'web_order_slips', column: 'order_id' }, { table: 'web_returns', column: 'order_id' }],
  },
  purchase_order: {
    label: 'Inkooporder', table: 'purchase_orders', numberColumn: 'number', searchColumns: ['number', 'supplier_reference'], jsonColumns: [],
    summary: (row) => `${row.number} · ${row.status}`, overwrite: 'never', children: [{ table: 'purchase_order_lines', column: 'order_id' }],
  },
  stock_item: {
    label: 'Artikel', table: 'stock_items', numberColumn: 'code', searchColumns: ['code', 'name'], jsonColumns: ['attributes', 'variant_values'],
    summary: (row) => `${row.code} · ${row.name}`, overwrite: 'columns',
    // De voorraadstand en alles wat de webshopsynchronisatie bijhoudt worden nooit teruggezet: de stand komt uit boekingen.
    neverColumns: ['on_hand', 'shop_product_id', 'shop_dirty', 'shop_price_seen', 'shop_stock_seen', 'shop_synced_at', 'shop_error', 'image_id'],
    neverOnInsert: ['on_hand', 'shop_product_id', 'shop_dirty', 'shop_price_seen', 'shop_stock_seen', 'shop_synced_at', 'shop_error', 'image_id'],
    children: [{ table: 'item_packagings', column: 'item_id' }, { table: 'item_suppliers', column: 'item_id' }],
  },
  supplier: {
    label: 'Leverancier', table: 'suppliers', numberColumn: 'name', searchColumns: ['name', 'email'], jsonColumns: [],
    summary: (row) => `${row.name}`, overwrite: 'columns',
  },
  customer: {
    label: 'Klant', table: 'users', numberColumn: 'username', searchColumns: ['username', 'display_name', 'company_name', 'email'], jsonColumns: ['preferences'],
    summary: (row) => `${row.display_name || row.username}${row.company_name ? ` · ${row.company_name}` : ''}`, overwrite: 'columns', onlyCustomers: true,
    neverColumns: ['role', 'kind', 'disabled', 'preferences'],
  },
  plan: {
    label: 'Tuinplan', table: 'plans', numberColumn: null, searchColumns: ['title', 'customer', 'address'], jsonColumns: ['data'],
    summary: (row) => `${row.title || '(zonder titel)'}${row.customer ? ` · ${row.customer}` : ''}`, overwrite: 'columns',
  },
};

/**
 * Welke soorten records er zijn, voor de keuzelijst.
 * @returns {{ kind: string, label: string, overwrite: string }[]} De soorten.
 */
function kinds() {
  return Object.entries(ENTITIES).map(([kind, entity]) => ({ kind, label: entity.label, overwrite: entity.overwrite }));
}

/**
 * Een waarde uit de database vergelijkbaar maken (BigInt wordt een getal, undefined null).
 * @param {*} raw De waarde.
 * @returns {*} De genormaliseerde waarde.
 */
const plain = (raw) => (raw === undefined || raw === null ? null : typeof raw === 'bigint' ? Number(raw) : raw);

/**
 * Of twee waarden uit de database gelijk zijn (getallen en tekst met hetzelfde getal tellen als gelijk).
 * @param {*} left Eerste waarde.
 * @param {*} right Tweede waarde.
 * @returns {boolean} True als gelijk.
 */
function sameValue(left, right) {
  const first = plain(left);
  const second = plain(right);
  if (first === null || second === null) return first === second;
  return String(first) === String(second);
}

/**
 * Leest JSON uit een veld (ongeldig of leeg = leeg object).
 * @param {*} text De tekst.
 * @returns {*} De waarde.
 */
function parseJson(text) {
  if (typeof text !== 'string' || !text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * Stabiele tekst van een JSON-waarde (sleutels gesorteerd), om twee waarden te vergelijken.
 * @param {*} value De waarde.
 * @returns {string} De tekst.
 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * Ontsleutelt een back-up naar een tijdelijk bestand en opent die alleen om te lezen.
 * @param {{ dir: string, name: string, vault: object }} options De back-upmap, de bestandsnaam en de kluis.
 * @returns {Promise<{ db: object, close: Function }>} De geopende back-up; close() sluit en wist het tijdelijke bestand.
 * @throws {Error} Bij een ongeldige naam, een verkeerde sleutel of een beschadigd bestand.
 */
async function openBackup({ dir, name, vault }) {
  if (!dir || !isBackupName(name) || !fs.existsSync(path.join(dir, name))) throw Object.assign(new Error('Back-up niet gevonden.'), { status: 404 });
  const temp = path.join(dir, `.restore-${crypto.randomUUID()}.db`);
  try {
    await decryptFile(path.join(dir, name), temp, keyOf(vault));
    const db = openSqlite(temp);
    return {
      db,
      /** Sluit de back-up en wist het tijdelijke bestand. */
      close() {
        try { db.close(); } finally { fs.rmSync(temp, { force: true }); fs.rmSync(`${temp}-wal`, { force: true }); fs.rmSync(`${temp}-shm`, { force: true }); fs.rmSync(`${temp}-journal`, { force: true }); }
      },
    };
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Bouwt de SQL-voorwaarde voor de klantenlijst: alleen accounts met een rol van het soort klant.
 * @param {{ customerRoleKeys: string[] }} context De klantrollen.
 * @returns {{ clause: string, args: string[] }} Voorwaarde en parameters.
 */
function customerFilter(context) {
  const keys = context.customerRoleKeys.length ? context.customerRoleKeys : ['klant'];
  return { clause: ` AND role IN (${keys.map(() => '?').join(', ')}) AND platform_admin = 0`, args: keys };
}

/**
 * De zoekvoorwaarde voor een soort record.
 * @param {object} entity De soort uit ENTITIES.
 * @param {string} query De zoektekst.
 * @param {object} context Zie restoreContext.
 * @returns {{ clause: string, args: string[] }} Voorwaarde en parameters (altijd met een voorloop-AND of leeg).
 */
function filterOf(entity, query, context) {
  let clause = '';
  let args = [];
  if (entity.onlyCustomers) { const customers = customerFilter(context); clause += customers.clause; args = args.concat(customers.args); }
  const term = String(query || '').trim().toLowerCase().slice(0, 80);
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    clause += ` AND (${entity.searchColumns.map((column) => `lower(COALESCE(CAST(${column} AS TEXT), '')) LIKE ? ESCAPE '\\'`).join(' OR ')})`;
    args = args.concat(entity.searchColumns.map(() => like));
  }
  return { clause, args };
}

/**
 * Bouwt "SELECT kolommen FROM tabel" met de kolommen die de database zelf heeft.
 * @param {object} db Databaseverbinding (back-up of live).
 * @param {string} table Tabelnaam uit het register.
 * @returns {string} Het begin van de query.
 */
function selectOf(db, table) {
  return `SELECT ${tableColumns(db, table).map((column) => column.name).join(', ')} FROM ${table}`;
}

/**
 * Alle kolommen van een rij die we mogen vergelijken en terugzetten: in beide databases aanwezig, niet de sleutel, niet gevoelig.
 * @param {object} entity De soort.
 * @param {object} current De actieve database.
 * @param {object} backup De back-up.
 * @param {string} table De tabel.
 * @returns {string[]} Kolomnamen.
 */
function comparableColumns(entity, current, backup, table) {
  const inBackup = new Set(tableColumns(backup, table).map((column) => column.name));
  const never = new Set([...NEVER_RESTORE, ...(entity.neverColumns || [])]);
  return tableColumns(current, table).filter((column) => !column.pk && inBackup.has(column.name) && !never.has(column.name)).map((column) => column.name);
}

/**
 * Zoekt records in de back-up en zegt per record of het nu ontbreekt, is gewijzigd of gelijk is.
 * @param {{ backup: object, current: object, context: object, kind: string, query?: string, offset?: number }} options De databases, de omgeving en de zoekopdracht.
 * @returns {{ items: object[], hasMore: boolean }} Records (id, label, state, datum) van deze pagina.
 */
function listRecords({ backup, current, context, kind, query = '', offset = 0 }) {
  const entity = Object.hasOwn(ENTITIES, kind) ? ENTITIES[kind] : undefined;
  if (!entity) throw Object.assign(new Error('Onbekende soort record.'), { status: 400 });
  const filter = filterOf(entity, query, context);
  const rows = backup.prepare(`${selectOf(backup, entity.table)} WHERE tenant_id = ?${filter.clause} ORDER BY created_at DESC, id LIMIT ${MAX_LIST + 1} OFFSET ${Math.max(0, Math.floor(Number(offset)) || 0)}`)
    .all(context.tenantId, ...filter.args);
  const page = rows.slice(0, MAX_LIST);
  const ids = page.map((row) => row.id);
  const existing = new Map();
  if (ids.length) {
    for (const row of current.prepare(`${selectOf(current, entity.table)} WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(', ')})`).all(context.tenantId, ...ids)) existing.set(row.id, row);
  }
  const columns = comparableColumns(entity, current, backup, entity.table);
  const items = page.map((row) => {
    const now = existing.get(row.id);
    return { id: row.id, label: entity.summary(row), createdAt: row.created_at || '', state: !now ? 'ontbreekt' : (diffOf(entity, columns, row, now).length ? 'gewijzigd' : 'gelijk') };
  });
  return { items, hasMore: rows.length > MAX_LIST };
}

/**
 * De verschillen tussen een record in de back-up en het huidige record, per veld. Van een JSON-veld komt elke hoofdsleutel
 * apart (veld `data.lines`), zodat bijvoorbeeld alleen de regels van een offerte terug kunnen.
 * @param {object} entity De soort.
 * @param {string[]} columns De vergelijkbare kolommen.
 * @param {object} backupRow De rij uit de back-up.
 * @param {object} currentRow De huidige rij.
 * @returns {{ field: string, backup: *, current: * }[]} De verschillen.
 */
function diffOf(entity, columns, backupRow, currentRow) {
  const diffs = [];
  for (const column of columns) {
    if ((entity.jsonColumns || []).includes(column)) {
      const before = parseJson(backupRow[column]);
      const now = parseJson(currentRow[column]);
      if (!before || typeof before !== 'object' || Array.isArray(before) || !now || typeof now !== 'object' || Array.isArray(now)) {
        if (stable(before) !== stable(now)) diffs.push({ field: column, backup: before, current: now });
        continue;
      }
      for (const key of new Set([...Object.keys(before), ...Object.keys(now)])) {
        if (stable(before[key]) !== stable(now[key])) diffs.push({ field: `${column}.${key}`, backup: before[key] === undefined ? null : before[key], current: now[key] === undefined ? null : now[key] });
      }
    } else if (!sameValue(backupRow[column], currentRow[column])) {
      diffs.push({ field: column, backup: plain(backupRow[column]), current: plain(currentRow[column]) });
    }
  }
  return diffs;
}

/**
 * Controleert of een rij in de actieve database kan: bestaan de rijen waarnaar hij verwijst nog?
 * @param {object} current De actieve database.
 * @param {string} table De tabel.
 * @param {object} row De rij uit de back-up.
 * @param {string} tenantId De omgeving.
 * @param {Map<string, boolean>} [seen] Eerder opgezochte ouders (voorkomt een query per kindrij).
 * @returns {string} Een tekst met wat ontbreekt, of leeg als alles er is.
 */
function missingParent(current, table, row, tenantId, seen = new Map()) {
  for (const foreignKey of foreignKeys(current, table)) {
    if (foreignKey.from === 'tenant_id' || foreignKey.table === 'tenants') continue;
    const target = plain(row[foreignKey.from]);
    if (target === null || target === '') continue;
    const memo = `${foreignKey.table}:${target}`;
    if (!seen.has(memo)) seen.set(memo, Boolean(current.prepare(`SELECT 1 AS ok FROM ${foreignKey.table} WHERE tenant_id = ? AND id = ?`).get(tenantId, target)));
    const found = seen.get(memo);
    if (!found) return `verwijst naar een ${foreignKey.table}-record (${target}) dat niet meer bestaat; zet dat eerst terug`;
  }
  return '';
}

/**
 * Wat een terugzetting van één record zou doen, zonder iets te wijzigen.
 * @param {{ backup: object, current: object, context: object, kind: string, id: string }} options De databases, de omgeving en het record.
 * @returns {object} state (ontbreekt|gewijzigd|gelijk|niet_in_back-up), label, diffs, blocked (reden, of leeg), children (aantal rijen dat mee terugkomt) en fields (de te kiezen velden).
 */
function preview({ backup, current, context, kind, id }) {
  const entity = Object.hasOwn(ENTITIES, kind) ? ENTITIES[kind] : undefined;
  if (!entity) throw Object.assign(new Error('Onbekende soort record.'), { status: 400 });
  const filter = filterOf(entity, '', context);
  const before = backup.prepare(`${selectOf(backup, entity.table)} WHERE tenant_id = ? AND id = ?${filter.clause}`).get(context.tenantId, String(id), ...filter.args);
  if (!before) return { id, state: 'niet_in_back-up', label: '', diffs: [], blocked: 'Dit record staat niet in deze back-up.', children: [], fields: [] };
  const now = current.prepare(`${selectOf(current, entity.table)} WHERE tenant_id = ? AND id = ?`).get(context.tenantId, String(id));
  const columns = comparableColumns(entity, current, backup, entity.table);
  const label = entity.summary(before);
  if (!now) {
    let blocked = missingParent(current, entity.table, before, context.tenantId);
    if (!blocked && entity.numberColumn && before[entity.numberColumn]) {
      const clash = current.prepare(`SELECT id FROM ${entity.table} WHERE tenant_id = ? AND ${entity.numberColumn} = ? AND id <> ?`).get(context.tenantId, before[entity.numberColumn], String(id));
      if (clash) blocked = `Het nummer ${before[entity.numberColumn]} is intussen aan een ander record gegeven.`;
    }
    if (!blocked) {
      const required = tableColumns(current, entity.table).filter((column) => column.notnull && !column.pk);
      const have = new Set(tableColumns(backup, entity.table).map((column) => column.name));
      const lacking = required.filter((column) => !have.has(column.name) && column.name !== 'tenant_id').map((column) => column.name);
      if (lacking.length) blocked = `De back-up is van een oudere versie en mist verplichte velden (${lacking.join(', ')}).`;
    }
    return { id, state: 'ontbreekt', label, diffs: [], blocked, children: childCounts(backup, current, entity, id, context.tenantId), fields: [] };
  }
  const diffs = diffOf(entity, columns, before, now);
  let blocked = '';
  if (!diffs.length) blocked = 'Dit record is gelijk aan de back-up.';
  else if (entity.overwrite === 'never') blocked = 'Dit soort record wordt nooit overschreven (alleen een verwijderd record komt terug), omdat voorraad, betalingen en zendingen eraan hangen.';
  else if (entity.lockedWhen) blocked = entity.lockedWhen(now, before);
  return { id, state: diffs.length ? 'gewijzigd' : 'gelijk', label, diffs, blocked, children: childCounts(backup, current, entity, id, context.tenantId), fields: diffs.map((diff) => diff.field) };
}

/**
 * Primaire-sleutelkolommen van een tabel.
 * @param {object} db De database.
 * @param {string} table De tabel.
 * @returns {string[]} De kolommen.
 */
const keyColumns = (db, table) => tableColumns(db, table).filter((column) => column.pk).map((column) => column.name);

/**
 * Sleutel van een kindrij als tekst, om in een verzameling op te zoeken.
 * @param {object} row De rij.
 * @param {string[]} keys De sleutelkolommen.
 * @returns {string} De sleutel.
 */
function rowKeyText(row, keys) {
  return JSON.stringify(keys.map((key) => plain(row[key])));
}

/**
 * Haalt in één query de sleutels op van de kindrijen die nu al bij dit record horen (geen query per rij).
 * @param {object} current De actieve database.
 * @param {{ table: string, column: string }} child De kindtabel en de kolom die naar het hoofdrecord verwijst.
 * @param {string} tenantId De omgeving.
 * @param {string} id Het hoofdrecord.
 * @returns {Set<string>} De sleutels (zie rowKeyText).
 */
function existingChildKeys(current, child, tenantId, id) {
  const keys = keyColumns(current, child.table).filter((column) => column !== 'tenant_id');
  const rows = current.prepare(`SELECT ${keys.join(', ')} FROM ${child.table} WHERE tenant_id = ? AND ${child.column} = ?`).all(tenantId, String(id));
  return new Set(rows.map((row) => rowKeyText(row, keys)));
}

/**
 * Per onderliggende tabel hoeveel rijen in de back-up staan en hoeveel daarvan nu ontbreken.
 * @param {object} backup De back-up.
 * @param {object} current De actieve database.
 * @param {object} entity De soort.
 * @param {string} id Het record.
 * @param {string} tenantId De omgeving.
 * @returns {{ table: string, inBackup: number, missing: number }[]} De aantallen.
 */
function childCounts(backup, current, entity, id, tenantId) {
  return (entity.children || []).map((child) => {
    const rows = backup.prepare(`${selectOf(backup, child.table)} WHERE tenant_id = ? AND ${child.column} = ?`).all(tenantId, String(id));
    const have = existingChildKeys(current, child, tenantId, id);
    const keys = keyColumns(current, child.table).filter((column) => column !== 'tenant_id');
    const missing = rows.filter((row) => !have.has(rowKeyText(row, keys))).length;
    return { table: child.table, inBackup: rows.length, missing };
  });
}

/**
 * Voegt een rij uit de back-up toe aan de actieve database (alleen de kolommen die in beide bestaan, zonder gevoelige velden).
 * @param {object} current De actieve database.
 * @param {object} backup De back-up.
 * @param {object} entity De soort.
 * @param {string} table De tabel.
 * @param {object} row De rij uit de back-up.
 * @param {string} tenantId De omgeving.
 * @returns {void}
 */
function insertRow(current, backup, entity, table, row, tenantId) {
  const inBackup = new Set(tableColumns(backup, table).map((column) => column.name));
  const never = new Set([...NEVER_RESTORE, ...(entity.neverOnInsert || [])]);
  const columns = tableColumns(current, table).map((column) => column.name).filter((name) => inBackup.has(name) && (!never.has(name) || name === 'created_at' || name === 'updated_at'));
  // Een teruggezet record heeft geen wachtwoord/2FA en geen deellink meer: de kolommen die we nooit terugzetten blijven leeg.
  const names = ['tenant_id', ...columns.filter((name) => name !== 'tenant_id')];
  const values = names.map((name) => (name === 'tenant_id' ? tenantId : plain(row[name])));
  current.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...values);
}

/**
 * Zet de gekozen velden van een bestaand record terug naar de waarde in de back-up.
 * @param {object} current De actieve database.
 * @param {object} entity De soort.
 * @param {object} backupRow De rij uit de back-up.
 * @param {object} currentRow De huidige rij.
 * @param {string[]} fields De te herstellen velden (`kolom` of `kolom.sleutel` voor een JSON-veld).
 * @param {string} tenantId De omgeving.
 * @param {string} now Het tijdstip voor updated_at.
 * @returns {void}
 */
function updateFields(current, entity, backupRow, currentRow, fields, tenantId, now) {
  const sets = new Map();
  const jsonState = new Map();
  for (const field of fields) {
    const [column, ...rest] = field.split('.');
    if (rest.length && (entity.jsonColumns || []).includes(column)) {
      if (!jsonState.has(column)) jsonState.set(column, parseJson(currentRow[column]));
      const key = rest.join('.');
      const wanted = parseJson(backupRow[column]);
      const target = jsonState.get(column);
      if (wanted[key] === undefined) delete target[key]; else target[key] = wanted[key];
    } else {
      sets.set(column, plain(backupRow[column]));
    }
  }
  for (const [column, target] of jsonState) if (!sets.has(column)) sets.set(column, JSON.stringify(target));
  const columns = [...sets.keys()];
  const hasUpdatedAt = tableColumns(current, entity.table).some((column) => column.name === 'updated_at');
  current.prepare(`UPDATE ${entity.table} SET ${columns.map((column) => `${column} = ?`).join(', ')}${hasUpdatedAt ? ', updated_at = ?' : ''} WHERE tenant_id = ? AND id = ?`)
    .run(...columns.map((column) => sets.get(column)), ...(hasUpdatedAt ? [now] : []), tenantId, currentRow.id);
}

/**
 * Zet records terug uit de back-up. Alles of niets: de geselecteerde records gaan in één transactie; geblokkeerde records
 * worden overgeslagen en gemeld. Maakt zelf geen back-up vooraf en schrijft geen auditregel (dat doet de aanroeper).
 * @param {{ backup: object, current: object, context: object, kind: string, items: { id: string, fields?: string[] }[] }} options De databases, de omgeving, de soort en de gekozen records (met voor een gewijzigd record de te herstellen velden).
 * @returns {{ results: { id: string, label: string, status: string, message: string, children: number }[] }} Per record: hersteld, bijgewerkt, overgeslagen of geblokkeerd.
 */
function applyRestore({ backup, current, context, kind, items }) {
  const entity = Object.hasOwn(ENTITIES, kind) ? ENTITIES[kind] : undefined;
  if (!entity) throw Object.assign(new Error('Onbekende soort record.'), { status: 400 });
  const list = (Array.isArray(items) ? items : []).slice(0, MAX_IDS);
  if (!list.length) throw Object.assign(new Error('Kies minstens één record.'), { status: 400 });
  const now = new Date().toISOString();
  return transaction(current, () => {
    const results = [];
    for (const item of list) {
      const id = String(item?.id || '');
      const plan = preview({ backup, current, context, kind, id });
      if (plan.blocked) { results.push({ id, label: plan.label, status: plan.state === 'gelijk' ? 'overgeslagen' : 'geblokkeerd', message: plan.blocked, children: 0 }); continue; }
      const before = backup.prepare(`${selectOf(backup, entity.table)} WHERE tenant_id = ? AND id = ?`).get(context.tenantId, id);
      if (plan.state === 'ontbreekt') {
        insertRow(current, backup, entity, entity.table, before, context.tenantId);
        let restored = 0;
        for (const child of entity.children || []) {
          const keys = keyColumns(current, child.table).filter((column) => column !== 'tenant_id');
          const have = existingChildKeys(current, child, context.tenantId, id);
          const parents = new Map();
          for (const row of backup.prepare(`${selectOf(backup, child.table)} WHERE tenant_id = ? AND ${child.column} = ?`).all(context.tenantId, id)) {
            if (have.has(rowKeyText(row, keys)) || missingParent(current, child.table, row, context.tenantId, parents)) continue;
            try {
              insertRow(current, backup, entity, child.table, row, context.tenantId);
            } catch (error) {
              // Een uniek nummer of code is intussen aan iets anders vergeven: alles terugdraaien, met een leesbare melding.
              throw Object.assign(new Error(`${plan.label}: een onderliggende rij (${child.table}) botst met een bestaande. Er is niets teruggezet.`, { cause: error }), { status: 409 });
            }
            restored += 1;
          }
        }
        results.push({ id, label: plan.label, status: 'hersteld', message: restored ? `Teruggezet met ${restored} onderliggende rij${restored === 1 ? '' : 'en'}.` : 'Teruggezet.', children: restored });
        continue;
      }
      const wanted = [...new Set((Array.isArray(item.fields) ? item.fields : []).map(String))];
      const allowed = new Set(plan.fields);
      const chosen = wanted.filter((field) => allowed.has(field));
      if (!chosen.length) { results.push({ id, label: plan.label, status: 'overgeslagen', message: 'Geen velden gekozen om terug te zetten.', children: 0 }); continue; }
      const currentRow = current.prepare(`${selectOf(current, entity.table)} WHERE tenant_id = ? AND id = ?`).get(context.tenantId, id);
      updateFields(current, entity, before, currentRow, chosen, context.tenantId, now);
      results.push({ id, label: plan.label, status: 'bijgewerkt', message: `${chosen.length} veld${chosen.length === 1 ? '' : 'en'} teruggezet: ${chosen.join(', ')}.`, children: 0 });
    }
    return { results };
  });
}

module.exports = { ENTITIES, kinds, openBackup, listRecords, preview, applyRestore, diffOf, MAX_LIST, MAX_IDS };
