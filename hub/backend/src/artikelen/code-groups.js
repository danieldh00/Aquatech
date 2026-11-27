// Hoofdgroepen (merken), subgroepen (soorten) en oude nummers van artikelen (tabellen main_groups, sub_groups en item_aliases, migratie 104).
//
// - Een hoofdgroep is een merk met een korte code (UD), een subgroep een soort (KBI) met een korte code. Een subgroep hoort bij een
//   hoofdgroep, of bij geen: dan is het een soort zonder merk (KBI.20.12 in plaats van UD.KBI.20.12). Dezelfde soortcode mag onder
//   verschillende merken staan.
// - Een artikelcode is MERK.SOORT.DIAMETER.DRAADMAAT (zie frontend/shared/article-code.js). Dit bestand stelt de code voor
//   (`proposeCode`) en controleert of hij nog vrij is; een uitgegeven code verandert nooit meer.
// - Een alias is een oud nummer, EAN of ander nummer waarop het artikel ook te vinden is; hij is uniek per omgeving.
const crypto = require('crypto');
const ArticleCode = require('../../../frontend/shared/article-code.js');
const { transaction } = require('../database/db');

const MAX_ALIASES_PER_ITEM = 50;
const ALIAS_KINDS = ['oud', 'ean', 'leverancier', 'overig'];

/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * Maakt tekst schoon: stuurtekens weg, spaties aan de randen af, ingekort.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximale lengte.
 * @returns {string} De schone tekst.
 */
const cleanText = (value, maxLength) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);

/**
 * Controleert en schoont de gegevens van een hoofdgroep of subgroep.
 * @param {object} input De invoer (code, name, sort).
 * @param {{ partial?: boolean }} [options] Bij een wijziging mogen velden ontbreken.
 * @returns {{ value?: object, error?: string, field?: string }} De schone velden, of een fout.
 */
function sanitizeGroup(input, { partial = false } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const value = {};
  if (!partial || source.code !== undefined) {
    value.code = ArticleCode.cleanGroupCode(source.code);
    if (!ArticleCode.isGroupCode(value.code)) return { error: 'De code bestaat uit 1 tot 8 hoofdletters of cijfers en begint met een letter (bijvoorbeeld UD of KBI).', field: 'code' };
  }
  if (!partial || source.name !== undefined) {
    value.name = cleanText(source.name, 120);
    if (!value.name) return { error: 'Vul een naam in.', field: 'name' };
  }
  if (source.sort !== undefined) {
    const sort = Number(source.sort);
    if (!Number.isInteger(sort) || sort < 0 || sort > 100000) return { error: 'De volgorde is een heel getal.', field: 'sort' };
    value.sort = sort;
  }
  if (partial && source.archived !== undefined) {
    if (typeof source.archived !== 'boolean') return { error: 'Archiveren is ja of nee.', field: 'archived' };
    value.archived = source.archived;
  }
  return { value };
}

/**
 * Controleert en schoont de oude nummers van een artikel.
 * @param {*} list De lijst [{ alias, kind }] of een lijst met alleen tekst.
 * @returns {{ value?: { alias: string, kind: string }[], error?: string, field?: string }} De schone lijst, of een fout.
 */
function sanitizeAliases(list) {
  if (!Array.isArray(list)) return { error: 'De lijst met oude nummers ontbreekt.', field: 'aliases' };
  if (list.length > MAX_ALIASES_PER_ITEM) return { error: `Hoogstens ${MAX_ALIASES_PER_ITEM} oude nummers per artikel.`, field: 'aliases' };
  const seen = new Set();
  const value = [];
  for (const entry of list) {
    const raw = entry && typeof entry === 'object' ? entry : { alias: entry };
    const alias = cleanText(raw.alias, 80);
    if (!alias) continue;
    const kind = raw.kind === undefined || raw.kind === null || raw.kind === '' ? 'oud' : String(raw.kind);
    if (!ALIAS_KINDS.includes(kind)) return { error: 'Het soort nummer is oud, ean, leverancier of overig.', field: 'aliases' };
    if (seen.has(alias.toLowerCase())) continue;
    seen.add(alias.toLowerCase());
    value.push({ alias, kind });
  }
  return { value };
}

/**
 * Maakt de opslag voor hoofdgroepen, subgroepen en oude nummers.
 * @param {object} db De database.
 * @returns {object} list, createMain, updateMain, removeMain, createSub, updateSub, removeSub, proposeCode, aliasesForItem, setAliases, aliasesByItem.
 */
function createCodeGroupStore(db) {
  /**
   * Maakt een query klaar.
   * @param {string} sql De query.
   * @returns {object} De voorbereide query.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Zet een rij van een groep om naar het formaat van de API.
   * @param {object} row De rij (id, code, name, sort, archived en eventueel main_group_id).
   * @param {number} itemCount Aantal artikelen in de groep.
   * @returns {object} De groep.
   */
  const groupOf = (row, itemCount) => ({
    id: row.id, code: row.code, name: row.name, sort: Number(row.sort), archived: Boolean(Number(row.archived)), itemCount,
    ...(row.main_group_id !== undefined ? { mainGroupId: row.main_group_id || null } : {}),
  });

  /**
   * Alle hoofdgroepen en subgroepen van de omgeving, met het aantal artikelen per groep.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ archived?: boolean }} [options] Ook de gearchiveerde.
   * @returns {{ mainGroups: object[], subGroups: object[] }} De hoofdgroepen en de subgroepen (mainGroupId leeg = soort zonder merk).
   */
  function list(tenantId, { archived = false } = {}) {
    const mainCounts = new Map(prepare('SELECT main_group_id, COUNT(*) AS n FROM stock_items WHERE tenant_id = ? AND main_group_id IS NOT NULL GROUP BY main_group_id').all(tenantId).map((row) => [row.main_group_id, Number(row.n)]));
    const subCounts = new Map(prepare('SELECT sub_group_id, COUNT(*) AS n FROM stock_items WHERE tenant_id = ? AND sub_group_id IS NOT NULL GROUP BY sub_group_id').all(tenantId).map((row) => [row.sub_group_id, Number(row.n)]));
    const filter = archived ? '' : ' AND archived = 0';
    /**
     * Sorteert groepen op hun volgorde en dan op code.
     * @param {object} left De eerste groep.
     * @param {object} right De tweede groep.
     * @returns {number} Negatief, nul of positief.
     */
    const bySort = (left, right) => left.sort - right.sort || left.code.localeCompare(right.code, 'nl');
    const mainGroups = prepare(`SELECT id, code, name, sort, archived FROM main_groups WHERE tenant_id = ?${filter}`).all(tenantId).map((row) => groupOf(row, mainCounts.get(row.id) || 0)).sort(bySort);
    const subGroups = prepare(`SELECT id, main_group_id, code, name, sort, archived FROM sub_groups WHERE tenant_id = ?${filter}`).all(tenantId).map((row) => groupOf(row, subCounts.get(row.id) || 0)).sort(bySort);
    return { mainGroups, subGroups };
  }

  /**
   * Zoekt een hoofdgroep van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de hoofdgroep.
   * @returns {object|undefined} De rij.
   */
  const findMain = (tenantId, id) => prepare('SELECT id, code, name, sort, archived FROM main_groups WHERE tenant_id = ? AND id = ?').get(tenantId, String(id || ''));

  /**
   * Zoekt een subgroep van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de subgroep.
   * @returns {object|undefined} De rij.
   */
  const findSub = (tenantId, id) => prepare('SELECT id, main_group_id, code, name, sort, archived FROM sub_groups WHERE tenant_id = ? AND id = ?').get(tenantId, String(id || ''));

  /**
   * Maakt een hoofdgroep (merk) aan.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} input De gegevens (code, name, sort).
   * @returns {{ group?: object, error?: string, field?: string, status?: number }} De hoofdgroep, of een fout.
   */
  function createMain(tenantId, input) {
    const clean = sanitizeGroup(input);
    if (clean.error) return clean;
    if (prepare('SELECT id FROM main_groups WHERE tenant_id = ? AND code = ?').get(tenantId, clean.value.code)) return { error: `De code ${clean.value.code} is al in gebruik voor een merk.`, field: 'code', status: 409 };
    const id = crypto.randomUUID();
    prepare('INSERT INTO main_groups (id, tenant_id, code, name, sort, archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(id, tenantId, clean.value.code, clean.value.name, clean.value.sort || 0, currentTimestamp());
    return { group: groupOf(findMain(tenantId, id), 0) };
  }

  /**
   * Wijzigt een hoofdgroep. De code blijft vast zodra er artikelen of subgroepen aan hangen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de hoofdgroep.
   * @param {object} input De gewijzigde velden.
   * @returns {{ group?: object, error?: string, field?: string, status?: number }} De hoofdgroep, of een fout.
   */
  function updateMain(tenantId, id, input) {
    const row = findMain(tenantId, id);
    if (!row) return { error: 'not_found', status: 404 };
    const clean = sanitizeGroup(input, { partial: true });
    if (clean.error) return clean;
    const value = clean.value;
    if (value.code !== undefined && value.code !== row.code) {
      const used = Number(prepare('SELECT COUNT(*) AS n FROM stock_items WHERE tenant_id = ? AND main_group_id = ?').get(tenantId, row.id).n)
        + Number(prepare('SELECT COUNT(*) AS n FROM sub_groups WHERE tenant_id = ? AND main_group_id = ?').get(tenantId, row.id).n);
      if (used) return { error: 'De code van een merk waar artikelen of soorten aan hangen verandert niet meer.', field: 'code', status: 409 };
      if (prepare('SELECT id FROM main_groups WHERE tenant_id = ? AND code = ? AND id <> ?').get(tenantId, value.code, row.id)) return { error: `De code ${value.code} is al in gebruik voor een merk.`, field: 'code', status: 409 };
    }
    prepare('UPDATE main_groups SET code = ?, name = ?, sort = ?, archived = ? WHERE tenant_id = ? AND id = ?')
      .run(value.code ?? row.code, value.name ?? row.name, value.sort ?? Number(row.sort), value.archived === undefined ? Number(row.archived) : (value.archived ? 1 : 0), tenantId, row.id);
    return { group: groupOf(findMain(tenantId, row.id), Number(prepare('SELECT COUNT(*) AS n FROM stock_items WHERE tenant_id = ? AND main_group_id = ?').get(tenantId, row.id).n)) };
  }

  /**
   * Verwijdert een hoofdgroep; hangen er soorten of artikelen aan, dan wordt hij gearchiveerd.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de hoofdgroep.
   * @returns {{ code: string, archived: boolean }|null} Wat er gebeurde, of null als hij niet bestaat.
   */
  function removeMain(tenantId, id) {
    const row = findMain(tenantId, id);
    if (!row) return null;
    const used = Number(prepare('SELECT COUNT(*) AS n FROM stock_items WHERE tenant_id = ? AND main_group_id = ?').get(tenantId, row.id).n)
      + Number(prepare('SELECT COUNT(*) AS n FROM sub_groups WHERE tenant_id = ? AND main_group_id = ?').get(tenantId, row.id).n);
    if (used) {
      prepare('UPDATE main_groups SET archived = 1 WHERE tenant_id = ? AND id = ?').run(tenantId, row.id);
      return { code: row.code, archived: true };
    }
    prepare('DELETE FROM main_groups WHERE tenant_id = ? AND id = ?').run(tenantId, row.id);
    return { code: row.code, archived: false };
  }

  /**
   * Is deze soortcode al bezet bij dit merk (of bij geen merk)?
   * @param {string} tenantId Id van de omgeving.
   * @param {string|null} mainGroupId De hoofdgroep, of null voor een soort zonder merk.
   * @param {string} code De soortcode.
   * @param {string} [exceptId] Deze subgroep telt niet mee.
   * @returns {boolean} true als de code bezet is.
   */
  function subCodeTaken(tenantId, mainGroupId, code, exceptId = '') {
    const row = mainGroupId
      ? prepare('SELECT id FROM sub_groups WHERE tenant_id = ? AND main_group_id = ? AND code = ? AND id::text <> ?').get(tenantId, mainGroupId, code, exceptId)
      : prepare('SELECT id FROM sub_groups WHERE tenant_id = ? AND main_group_id IS NULL AND code = ? AND id::text <> ?').get(tenantId, code, exceptId);
    return Boolean(row);
  }

  /**
   * Maakt een subgroep (soort) aan, onder een hoofdgroep of zonder merk.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} input De gegevens (code, name, sort, mainGroupId).
   * @returns {{ group?: object, error?: string, field?: string, status?: number }} De subgroep, of een fout.
   */
  function createSub(tenantId, input) {
    const clean = sanitizeGroup(input);
    if (clean.error) return clean;
    const mainGroupId = input.mainGroupId ? String(input.mainGroupId) : null;
    if (mainGroupId && !findMain(tenantId, mainGroupId)) return { error: 'Dit merk bestaat niet.', field: 'mainGroupId', status: 400 };
    if (subCodeTaken(tenantId, mainGroupId, clean.value.code)) return { error: `De soortcode ${clean.value.code} is hier al in gebruik.`, field: 'code', status: 409 };
    const id = crypto.randomUUID();
    prepare('INSERT INTO sub_groups (id, tenant_id, main_group_id, code, name, sort, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(id, tenantId, mainGroupId, clean.value.code, clean.value.name, clean.value.sort || 0, currentTimestamp());
    return { group: groupOf(findSub(tenantId, id), 0) };
  }

  /**
   * Wijzigt een subgroep. Code en merk blijven vast zodra er artikelen aan hangen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de subgroep.
   * @param {object} input De gewijzigde velden.
   * @returns {{ group?: object, error?: string, field?: string, status?: number }} De subgroep, of een fout.
   */
  function updateSub(tenantId, id, input) {
    const row = findSub(tenantId, id);
    if (!row) return { error: 'not_found', status: 404 };
    const clean = sanitizeGroup(input, { partial: true });
    if (clean.error) return clean;
    const value = clean.value;
    const count = Number(prepare('SELECT COUNT(*) AS n FROM stock_items WHERE tenant_id = ? AND sub_group_id = ?').get(tenantId, row.id).n);
    if (value.code !== undefined && value.code !== row.code) {
      if (count) return { error: 'De code van een soort waar artikelen aan hangen verandert niet meer.', field: 'code', status: 409 };
      if (subCodeTaken(tenantId, row.main_group_id || null, value.code, row.id)) return { error: `De soortcode ${value.code} is hier al in gebruik.`, field: 'code', status: 409 };
    }
    prepare('UPDATE sub_groups SET code = ?, name = ?, sort = ?, archived = ? WHERE tenant_id = ? AND id = ?')
      .run(value.code ?? row.code, value.name ?? row.name, value.sort ?? Number(row.sort), value.archived === undefined ? Number(row.archived) : (value.archived ? 1 : 0), tenantId, row.id);
    return { group: groupOf(findSub(tenantId, row.id), count) };
  }

  /**
   * Verwijdert een subgroep; hangen er artikelen aan, dan wordt hij gearchiveerd.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de subgroep.
   * @returns {{ code: string, archived: boolean }|null} Wat er gebeurde, of null als hij niet bestaat.
   */
  function removeSub(tenantId, id) {
    const row = findSub(tenantId, id);
    if (!row) return null;
    if (Number(prepare('SELECT COUNT(*) AS n FROM stock_items WHERE tenant_id = ? AND sub_group_id = ?').get(tenantId, row.id).n)) {
      prepare('UPDATE sub_groups SET archived = 1 WHERE tenant_id = ? AND id = ?').run(tenantId, row.id);
      return { code: row.code, archived: true };
    }
    prepare('DELETE FROM sub_groups WHERE tenant_id = ? AND id = ?').run(tenantId, row.id);
    return { code: row.code, archived: false };
  }

  /**
   * Stelt een artikelcode voor uit merk, soort, diameter en draadmaat en zegt of hij nog vrij is.
   * Voor een artikelgroep (zonder maten) is de code MERK.SOORT; is die al bezet, dan komt er een volgnummer achter (UD.KBI-2).
   * @param {string} tenantId Id van de omgeving.
   * @param {{ subGroupId: string, diameter?: *, thread?: *, isGroup?: boolean, exceptItemId?: string }} input De soort, de maten en of het een artikelgroep is.
   * @returns {{ code?: string, taken?: boolean, takenBy?: string, error?: string, field?: string, status?: number }} Het voorstel, of een fout.
   */
  function proposeCode(tenantId, input) {
    const source = input && typeof input === 'object' ? input : {};
    const sub = findSub(tenantId, source.subGroupId);
    if (!sub) return { error: 'Kies eerst een soort.', field: 'subGroupId', status: 400 };
    const main = sub.main_group_id ? findMain(tenantId, sub.main_group_id) : null;
    const thread = ArticleCode.threadCode(source.thread);
    if (thread.error) return { error: thread.error, field: 'thread', status: 400 };
    const exceptId = String(source.exceptItemId || '');
    /**
     * Zoekt een artikel met deze code (een artikel dat zelf wordt gewijzigd telt niet mee).
     * @param {string} code De code.
     * @returns {object|undefined} De rij met de code, of niets.
     */
    const isTaken = (code) => prepare('SELECT code FROM stock_items WHERE tenant_id = ? AND code = ? AND id::text <> ?').get(tenantId, code, exceptId);
    const base = { brand: main ? main.code : '', kind: sub.code };
    if (source.isGroup) {
      let code = ArticleCode.buildCode(base).code;
      for (let number = 2; isTaken(code) && number < 100; number += 1) code = ArticleCode.buildCode({ ...base, kind: `${sub.code}-${number}` }).code;
      return { code, taken: Boolean(isTaken(code)) };
    }
    const built = ArticleCode.buildCode({ ...base, diameter: source.diameter, thread: thread.code });
    if (built.error) return { error: built.error, field: 'diameter', status: 400 };
    const other = isTaken(built.code);
    return { code: built.code, taken: Boolean(other), ...(other ? { takenBy: other.code } : {}) };
  }

  /**
   * De oude nummers van één artikel.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {{ alias: string, kind: string }[]|null} De nummers, of null als het artikel niet bestaat.
   */
  function aliasesForItem(tenantId, itemId) {
    if (!prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, String(itemId || ''))) return null;
    return prepare('SELECT alias, kind FROM item_aliases WHERE tenant_id = ? AND item_id = ? ORDER BY created_at, alias').all(tenantId, String(itemId)).map((row) => ({ alias: row.alias, kind: row.kind }));
  }

  /**
   * Alle oude nummers van de omgeving, per artikel (voor de zoekfunctie in lijsten).
   * @param {string} tenantId Id van de omgeving.
   * @returns {Map<string, string[]>} Per artikel-id de nummers (alleen de tekst).
   */
  function aliasesByItem(tenantId) {
    const map = new Map();
    for (const row of prepare('SELECT item_id, alias FROM item_aliases WHERE tenant_id = ?').all(tenantId)) {
      if (!map.has(row.item_id)) map.set(row.item_id, []);
      map.get(row.item_id).push(row.alias);
    }
    return map;
  }

  /**
   * Vervangt de oude nummers van een artikel. Een nummer is uniek per omgeving en mag niet gelijk zijn aan een artikelcode van een ander artikel.
   * Alles of niets.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {*} list De nieuwe lijst [{ alias, kind }].
   * @returns {{ aliases?: object[], error?: string, field?: string, status?: number }} De nieuwe lijst, of een fout.
   */
  function setAliases(tenantId, itemId, list) {
    const item = prepare('SELECT id, code FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, String(itemId || ''));
    if (!item) return { error: 'not_found', status: 404 };
    const clean = sanitizeAliases(list);
    if (clean.error) return clean;
    for (const entry of clean.value) {
      const owner = prepare('SELECT i.code AS code FROM item_aliases a JOIN stock_items i ON i.tenant_id = a.tenant_id AND i.id = a.item_id WHERE a.tenant_id = ? AND LOWER(a.alias) = LOWER(?) AND a.item_id <> ?').get(tenantId, entry.alias, item.id);
      if (owner) return { error: `Het nummer ${entry.alias} hoort al bij artikel ${owner.code}.`, field: 'aliases', status: 409 };
      const sameCode = prepare('SELECT code FROM stock_items WHERE tenant_id = ? AND LOWER(code) = LOWER(?) AND id <> ?').get(tenantId, entry.alias, item.id);
      if (sameCode) return { error: `Het nummer ${entry.alias} is de artikelcode van een ander artikel.`, field: 'aliases', status: 409 };
    }
    transaction(db, () => {
      prepare('DELETE FROM item_aliases WHERE tenant_id = ? AND item_id = ?').run(tenantId, item.id);
      const at = currentTimestamp();
      for (const entry of clean.value) prepare('INSERT INTO item_aliases (id, tenant_id, item_id, alias, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), tenantId, item.id, entry.alias, entry.kind, at);
    });
    return { aliases: clean.value };
  }

  return { list, createMain, updateMain, removeMain, createSub, updateSub, removeSub, proposeCode, aliasesForItem, aliasesByItem, setAliases };
}

/**
 * Registreert de routes voor hoofdgroepen, subgroepen, het codevoorstel en de oude nummers (recht voorraad).
 * @param {object} app De Express-app.
 * @param {{ codeGroups: object, requireRight: Function, requireJson: Function, audit: Function }} ctx De opslag en hulpfuncties.
 * @returns {void}
 */
function registerCodeGroupRoutes(app, ctx) {
  const { codeGroups, requireRight, requireJson, audit } = ctx;
  const requireStock = requireRight('voorraad');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Stuurt een fout uit de opslag terug (404, 409 of 400 met het veld).
   * @param {object} res Het antwoord.
   * @param {{ error: string, status?: number, field?: string }} out De fout.
   * @param {string} what Wat bij een 404 niet gevonden is.
   * @returns {void}
   */
  const fail = (res, out, what) => (out.status === 404 ? res.status(404).json({ error: 'not_found', message: `${what} niet gevonden.` })
    : res.status(out.status || 400).json({ error: out.status === 409 ? 'conflict' : 'invalid', message: out.error, field: out.field }));

  app.get('/api/stock/code-groups', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(codeGroups.list(tenantOf(req), { archived: req.query.archived === '1' }));
  });

  for (const [path, kind, label] of [['main-groups', 'Main', 'Merk'], ['sub-groups', 'Sub', 'Soort']]) {
    app.post(`/api/stock/${path}`, requireJson, requireStock, (req, res) => {
      const out = codeGroups[`create${kind}`](tenantOf(req), req.body);
      if (out.error) return fail(res, out, label);
      audit(req, `artikel_${path.replace('-', '')}_aangemaakt`, { code: out.group.code });
      res.status(201).json(out.group);
    });
    app.patch(`/api/stock/${path}/:id`, requireJson, requireStock, (req, res) => {
      const out = codeGroups[`update${kind}`](tenantOf(req), req.params.id, req.body);
      if (out.error) return fail(res, out, label);
      audit(req, `artikel_${path.replace('-', '')}_gewijzigd`, { code: out.group.code });
      res.json(out.group);
    });
    app.delete(`/api/stock/${path}/:id`, requireStock, (req, res) => {
      const out = codeGroups[`remove${kind}`](tenantOf(req), req.params.id);
      if (!out) return fail(res, { status: 404 }, label);
      audit(req, out.archived ? `artikel_${path.replace('-', '')}_gearchiveerd` : `artikel_${path.replace('-', '')}_verwijderd`, { code: out.code });
      res.json(out.archived ? { archived: true } : { deleted: true });
    });
  }

  app.get('/api/stock/code-proposal', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const out = codeGroups.proposeCode(tenantOf(req), { subGroupId: req.query.subGroupId, diameter: req.query.diameter, thread: req.query.thread, isGroup: req.query.group === '1', exceptItemId: req.query.exceptItemId });
    if (out.error) return fail(res, out, 'Soort');
    res.json(out);
  });

  app.get('/api/stock/items/:id/aliases', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const rows = codeGroups.aliasesForItem(tenantOf(req), req.params.id);
    if (!rows) return fail(res, { status: 404 }, 'Artikel');
    res.json({ items: rows });
  });

  app.put('/api/stock/items/:id/aliases', requireJson, requireStock, (req, res) => {
    const out = codeGroups.setAliases(tenantOf(req), req.params.id, req.body && req.body.aliases);
    if (out.error) return fail(res, out, 'Artikel');
    audit(req, 'artikel_oude_nummers', { itemId: req.params.id, count: out.aliases.length });
    res.json({ items: out.aliases });
  });
}

module.exports = { createCodeGroupStore, registerCodeGroupRoutes, sanitizeGroup, sanitizeAliases };
