// Bestaande artikelen omzetten naar sprekende codes (MERK.SOORT.DIAMETER.DRAADMAAT, zie frontend/shared/article-code.js).
//
// - `proposals` stelt voor elk artikel zonder soort een soort, diameter, draadmaat en nieuwe code voor. De soort komt uit woorden in de
//   artikelnaam (de naam of code van een soort of merk), de diameter en draadmaat uit de naam en de waarden van het subartikel.
// - `apply` zet bevestigde regels om: nieuwe code, merk en soort op het artikel, en de oude code wordt een oud nummer (zoeknaam), zodat
//   offertes, werkorders en de zoekfunctie het artikel blijven vinden. Een uitgegeven code verandert daarna nooit meer.
// - Een regel die niet klopt (geen soort, bezette of dubbele code) wordt gemeld en niet omgezet; de rest gaat wel door.
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const ArticleCode = require(path.join(FRONTEND_DIR, 'shared', 'article-code.js'));
const { transaction } = require('../database/db');

const MAX_ROWS_PER_APPLY = 1000;
const FRACTION_SIGNS = { '⅛': '1/8', '¼': '1/4', '⅜': '3/8', '½': '1/2', '¾': '3/4' };

/**
 * Zet tekst om naar kleine letters met gewone breuken en aanhalingstekens, zodat de herkenning niet op schrijfwijze struikelt.
 * @param {string} text De tekst van het artikel.
 * @returns {string} De genormaliseerde tekst.
 */
function normalize(text) {
  return String(text || '').toLowerCase()
    .replace(/[⅛¼⅜½¾]/g, (sign) => ` ${FRACTION_SIGNS[sign]}`)
    .replace(/[”″]|''/g, '"')
    .replace(/\s+/g, ' ');
}

/**
 * Escapet een tekst voor gebruik in een reguliere expressie.
 * @param {string} text De tekst.
 * @returns {string} De tekst met ontsnapte tekens.
 */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Zoekt een woord of woordgroep als geheel woord in een tekst.
 * @param {string} text De (genormaliseerde) tekst.
 * @param {string} phrase Het woord of de woordgroep, in kleine letters.
 * @returns {boolean} true als het erin staat.
 */
const hasWord = (text, phrase) => Boolean(phrase) && new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}($|[^a-z0-9])`).test(text);

/**
 * Leest de diameter in mm uit de tekst: na ø of "diameter", of vlak voor "mm".
 * @param {string} text De genormaliseerde tekst.
 * @returns {string} De diameter als cijfers, of leeg.
 */
function readDiameter(text) {
  const match = /(?:ø|⌀|\bdia(?:m(?:eter)?)?\.?|\bd)\s*=?\s*(\d{1,4})(?:\s*mm)?(?![\d/])/.exec(text) || /(\d{1,4})\s*mm\b/.exec(text);
  return match ? match[1] : '';
}

/**
 * Leest de draadmaat (BSP in duimen) uit de tekst en geeft hem terug als code in cijfers.
 * @param {string} text De genormaliseerde tekst.
 * @returns {string} De draadmaatcode (bijvoorbeeld 34), of leeg als er geen bekende maat staat.
 */
function readThread(text) {
  const candidates = [
    /(?:^|[^\d/])(\d+\s+\d\/\d|\d\/\d)\s*(?:"|inch|duim|bsp|bsm)?/,
    /\b(?:bsp|rp|g|r)\s*(\d+\s+\d\/\d|\d\/\d|\d)\b/,
    /(?:^|[^\d/.,])(\d)\s*(?:"|inch|duim)/,
  ];
  for (const pattern of candidates) {
    const match = pattern.exec(text);
    if (!match) continue;
    const thread = ArticleCode.threadCode(match[1]);
    if (!thread.error && thread.code) return thread.code;
  }
  return '';
}

/**
 * Kiest soort (en daarmee merk) voor een artikel op de woorden in zijn naam.
 * @param {string} text De genormaliseerde tekst van het artikel.
 * @param {object[]} subGroups De actieve soorten ({ id, code, name, main_group_id }).
 * @param {object[]} mainGroups De actieve merken ({ id, code, name }).
 * @returns {object|null} De gekozen soort, of null als er geen (of geen eenduidige) is.
 */
function pickSubGroup(text, subGroups, mainGroups) {
  let bestScore = 0;
  let bestCode = '';
  for (const sub of subGroups) {
    const nameHit = hasWord(text, normalize(sub.name)) ? normalize(sub.name).length : 0;
    const codeHit = hasWord(text, sub.code.toLowerCase()) ? sub.code.length : 0;
    const score = Math.max(nameHit, codeHit);
    if (score > bestScore) { bestScore = score; bestCode = sub.code; }
  }
  if (!bestScore) return null;
  const options = subGroups.filter((sub) => sub.code === bestCode);
  const brand = mainGroups.filter((main) => hasWord(text, normalize(main.name)) || hasWord(text, main.code.toLowerCase()))
    .sort((left, right) => right.name.length - left.name.length)[0];
  return options.find((sub) => brand && sub.main_group_id === brand.id)
    || options.find((sub) => !sub.main_group_id)
    || (options.length === 1 ? options[0] : null);
}

/**
 * Maakt de opslag voor het omzetten van bestaande artikelen.
 * @param {object} db De database.
 * @returns {{ proposals: Function, apply: Function }} Het voorstel en het omzetten.
 */
function createCodeConversion(db) {
  /**
   * Maakt een query klaar.
   * @param {string} sql De query.
   * @returns {object} De voorbereide query.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Haalt de actieve merken en soorten op.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ mainGroups: object[], subGroups: object[] }} De groepen.
   */
  function groupsOf(tenantId) {
    return {
      mainGroups: prepare('SELECT id, code, name FROM main_groups WHERE tenant_id = ? AND archived = 0 ORDER BY sort, code').all(tenantId),
      subGroups: prepare('SELECT id, code, name, main_group_id FROM sub_groups WHERE tenant_id = ? AND archived = 0 ORDER BY sort, code').all(tenantId),
    };
  }

  /**
   * Alle codes en oude nummers die al in gebruik zijn, in kleine letters.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ codes: Map<string, string>, aliases: Set<string> }} Code naar artikel-id, en de oude nummers.
   */
  function takenOf(tenantId) {
    const codes = new Map(prepare('SELECT id::text AS id, code FROM stock_items WHERE tenant_id = ?').all(tenantId).map((row) => [row.code.toLowerCase(), row.id]));
    const aliases = new Set(prepare('SELECT alias FROM item_aliases WHERE tenant_id = ?').all(tenantId).map((row) => row.alias.toLowerCase()));
    return { codes, aliases };
  }

  /**
   * De tekst waaruit diameter en draadmaat worden gelezen: de naam plus de waarden van een subartikel.
   * @param {object} row Het artikel (name, sub_values).
   * @returns {string} De genormaliseerde tekst.
   */
  function textOf(row) {
    let values = '';
    try { values = Object.values(JSON.parse(row.sub_values || '{}')).join(' '); } catch { values = ''; }
    return normalize(`${row.name} ${values}`);
  }

  /**
   * Bouwt de nieuwe code voor een artikel en controleert of hij vrij is.
   * @param {object} entry De regel: { isGroup, sub, main, diameter, thread, ownId, oldCode }.
   * @param {{ codes: Map<string, string>, aliases: Set<string> }} taken De codes en oude nummers die al bestaan.
   * @param {Map<string, string>} batch De codes die in dezelfde ronde al zijn vergeven (code naar artikel-id).
   * @returns {{ code?: string, error?: string, status?: string }} De code, of de reden dat het niet kan.
   */
  function buildFor(entry, taken, batch) {
    const parts = { brand: entry.main ? entry.main.code : '', kind: entry.sub.code };
    if (!entry.isGroup) {
      if (!entry.diameter) return { error: 'Vul een diameter in.', status: 'geen_diameter' };
      Object.assign(parts, { diameter: entry.diameter, thread: entry.thread });
    }
    const built = ArticleCode.buildCode(parts);
    if (built.error) return { error: built.error, status: 'fout' };
    const key = built.code.toLowerCase();
    const owner = taken.codes.get(key);
    if (owner && owner !== entry.ownId) return { error: `De code ${built.code} is al van een ander artikel.`, status: 'bezet' };
    if (taken.aliases.has(key) && key !== String(entry.oldCode).toLowerCase()) return { error: `De code ${built.code} is een oud nummer van een ander artikel.`, status: 'bezet' };
    if (batch.has(key) && batch.get(key) !== entry.ownId) return { error: `De code ${built.code} komt in dit voorstel twee keer voor.`, status: 'dubbel' };
    return { code: built.code };
  }

  /**
   * Stelt voor elk artikel zonder soort een nieuwe code voor.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ items: object[], converted: number, groups: object }} De voorstellen, het aantal al omgezette artikelen en de beschikbare merken en soorten.
   */
  function proposals(tenantId) {
    const { mainGroups, subGroups } = groupsOf(tenantId);
    const taken = takenOf(tenantId);
    const rows = prepare('SELECT id::text AS id, code, name, is_group, group_id::text AS group_id, sub_values FROM stock_items WHERE tenant_id = ? AND sub_group_id IS NULL AND archived = 0 ORDER BY code').all(tenantId);
    const converted = Number(prepare('SELECT COUNT(*) AS total FROM stock_items WHERE tenant_id = ? AND sub_group_id IS NOT NULL').get(tenantId).total);
    const batch = new Map();
    const items = rows.map((row) => {
      const isGroup = Boolean(Number(row.is_group));
      const text = textOf(row);
      const sub = pickSubGroup(text, subGroups, mainGroups);
      const base = { id: row.id, code: row.code, name: row.name, isGroup, isSubItem: Boolean(row.group_id), subGroupId: sub ? sub.id : '', diameter: '', thread: '', newCode: '', status: 'geen_soort', note: 'Geen soort herkend in de naam; kies er een.' };
      if (!sub) return base;
      const main = sub.main_group_id ? mainGroups.find((group) => group.id === sub.main_group_id) : null;
      const diameter = isGroup ? '' : readDiameter(text);
      const thread = isGroup ? '' : readThread(text);
      const built = buildFor({ isGroup, sub, main, diameter, thread, ownId: row.id, oldCode: row.code }, taken, batch);
      const item = { ...base, diameter, thread, status: built.code ? 'klaar' : built.status, note: built.error || '', newCode: built.code || '' };
      if (built.code) batch.set(built.code.toLowerCase(), row.id);
      return item;
    });
    return { items, converted, groups: { mainGroups, subGroups } };
  }

  /**
   * Zet bevestigde regels om. Elke regel wordt eerst gecontroleerd; wat klopt gaat in één transactie, de rest wordt gemeld.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, subGroupId: string, diameter?: string, thread?: string }[]} rows De bevestigde regels.
   * @returns {{ converted: number, results: object[], error?: string, status?: number }} Per regel de uitkomst, of een fout bij een ongeldige aanvraag.
   */
  function apply(tenantId, rows) {
    if (!Array.isArray(rows) || !rows.length) return { error: 'Er zijn geen regels om om te zetten.', status: 400 };
    if (rows.length > MAX_ROWS_PER_APPLY) return { error: `Hoogstens ${MAX_ROWS_PER_APPLY} regels per keer.`, status: 400 };
    const { mainGroups, subGroups } = groupsOf(tenantId);
    const taken = takenOf(tenantId);
    const batch = new Map();
    const plan = [];
    const results = [];
    for (const raw of rows) {
      const id = String(raw && raw.id || '');
      const item = prepare('SELECT id::text AS id, code, is_group, sub_group_id FROM stock_items WHERE tenant_id = ? AND id::text = ?').get(tenantId, id);
      const sub = subGroups.find((group) => group.id === String(raw && raw.subGroupId || ''));
      const thread = ArticleCode.threadCode(raw && raw.thread);
      let problem = null;
      if (!item) problem = { error: 'Artikel niet gevonden.', status: 'fout' };
      else if (item.sub_group_id) problem = { error: 'Dit artikel heeft al een soort en een uitgegeven code.', status: 'al_omgezet' };
      else if (!sub) problem = { error: 'Kies een soort.', status: 'geen_soort' };
      else if (thread.error) problem = { error: thread.error, status: 'fout' };
      const main = sub && sub.main_group_id ? mainGroups.find((group) => group.id === sub.main_group_id) : null;
      const built = problem ? null : buildFor({ isGroup: Boolean(Number(item.is_group)), sub, main, diameter: String(raw.diameter || '').trim(), thread: thread.code, ownId: item.id, oldCode: item.code }, taken, batch);
      if (built && !built.code) problem = built;
      if (problem) { results.push({ id, ok: false, error: problem.error, status: problem.status }); continue; }
      batch.set(built.code.toLowerCase(), item.id);
      plan.push({ item, sub, main, code: built.code });
      results.push({ id, ok: true, code: built.code, oldCode: item.code });
    }
    transaction(db, () => {
      const at = new Date().toISOString();
      for (const entry of plan) {
        prepare('UPDATE stock_items SET code = ?, main_group_id = ?, sub_group_id = ?, updated_at = ? WHERE tenant_id = ? AND id::text = ?')
          .run(entry.code, entry.main ? entry.main.id : null, entry.sub.id, at, tenantId, entry.item.id);
        const alreadyThere = prepare('SELECT 1 AS found FROM item_aliases WHERE tenant_id = ? AND LOWER(alias) = LOWER(?)').get(tenantId, entry.item.code);
        if (entry.item.code !== entry.code && !alreadyThere) {
          prepare('INSERT INTO item_aliases (id, tenant_id, item_id, alias, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(crypto.randomUUID(), tenantId, entry.item.id, entry.item.code, 'oud', at);
        }
      }
    });
    return { converted: plan.length, results };
  }

  return { proposals, apply };
}

/**
 * Registreert de routes voor het omzetten van bestaande artikelen (recht voorraad).
 * @param {object} app De Express-app.
 * @param {{ codeConversion: object, requireRight: Function, audit: Function }} ctx De opslag en hulpfuncties.
 * @returns {void}
 */
function registerCodeConversionRoutes(app, { codeConversion, requireRight, audit }) {
  const requireStock = requireRight('voorraad');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;

  app.get('/api/stock/code-conversion', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(codeConversion.proposals(tenantOf(req)));
  });

  app.post('/api/stock/code-conversion/apply', express.json({ limit: '512kb' }), requireStock, (req, res) => {
    const out = codeConversion.apply(tenantOf(req), req.body && req.body.rows);
    if (out.error) return res.status(out.status || 400).json({ error: 'invalid', message: out.error });
    audit(req, 'artikelcodes_omgezet', { count: out.converted, rejected: out.results.length - out.converted });
    res.json(out);
  });
}

module.exports = { createCodeConversion, registerCodeConversionRoutes, readDiameter, readThread, pickSubGroup, normalize };
