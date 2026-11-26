// Concepten van producttekst (tabel item_text_drafts, migratie 75) en de routes om ze te maken, te bekijken, aan te passen,
// goed te keuren of af te wijzen.
//
// - Een concept bevat omschrijving, titel en omschrijving voor zoekmachines van één artikel (hoogstens één per artikel). De AI
//   schrijft het met de sleutel van de organisatie (item-text-writer.js) uit de bekende artikelgegevens.
// - Feitencontrole: elk concept wordt vergeleken met die gegevens (item-text-check.js); afwijkende getallen, eenheden en
//   beweringen staan als waarschuwing bij het concept. Bij goedkeuren worden ze opnieuw bepaald (de gegevens kunnen intussen
//   veranderd zijn); met waarschuwingen moet de gebruiker dat uitdrukkelijk bevestigen.
// - Niets gaat vanzelf live: goedkeuren is altijd een handeling van een gebruiker met recht `voorraad`. Is de live tekst sinds het
//   schrijven veranderd, dan wordt hij alleen overschreven na een expliciete keuze (overwrite).
// - Varianten krijgen geen eigen concept (ze erven de tekst van het hoofdartikel), gearchiveerde artikelen ook niet.
const crypto = require('crypto');
const { transaction } = require('../database/db');
const ItemDetails = require('./item-details');
const { buildFacts, checkText } = require('./item-text-check');
const { createItemTextLog } = require('./item-text-log');
const { AnalyzeError } = require('../beregening/plan-analyzer');

/** Hoeveel artikelen één schrijfverzoek hoogstens bevat (de browser verdeelt een grote selectie in porties). */
const GENERATE_BATCH = 5;
/** Hoeveel artikelen tegelijk bij de AI-dienst. */
const GENERATE_CONCURRENCY = 3;
/** Hoeveel concepten in één keer goedgekeurd of afgewezen. */
const DECIDE_BATCH = 100;
/** Hoeveel artikelen het overzicht hoogstens toont. */
const MAX_LIST = 300;
/** Fouten waarbij doorgaan zinloos is (sleutel, tegoed, model): de rest van de portie wordt overgeslagen. */
const FATAL_CODES = ['auth', 'permission', 'not_found', 'no_credit', 'not_configured', 'rate_limited'];

/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * Vingerafdruk van de live tekst van een artikel, om te zien of hij sinds het schrijven is veranderd.
 * @param {{ description?: string, seoTitle?: string, seoDescription?: string }} texts De live tekst.
 * @returns {string} SHA-256.
 */
const hashOf = (texts) => crypto.createHash('sha256').update(`${texts.description || ''}\n${texts.seoTitle || ''}\n${texts.seoDescription || ''}`).digest('hex');

/**
 * Leest de opgeslagen waarschuwingen.
 * @param {string} json De kolom warnings.
 * @returns {object[]} De waarschuwingen (leeg bij onleesbare invoer).
 */
function warningsOf(json) {
  try { const list = JSON.parse(json || '[]'); return Array.isArray(list) ? list : []; } catch { return []; }
}

/**
 * De waarschuwingen bij een concept: de feitencontrole plus een melding als er weinig gegevens zijn.
 * @param {{ description: string, seoTitle: string, seoDescription: string }} texts De concepttekst.
 * @param {{ sourceText: string, thin: boolean }} facts De bronvelden (buildFacts).
 * @returns {object[]} De waarschuwingen.
 */
function warningsFor(texts, facts) {
  const warnings = checkText(texts, facts.sourceText);
  if (facts.thin) warnings.push({ field: 'description', kind: 'thin', text: '', message: 'Er zijn weinig artikelgegevens (geen merk, specificaties of omschrijving): de tekst is kort gehouden. Controleer hem extra goed.' });
  return warnings;
}

/**
 * Zet een conceptrij om naar het formaat van de API.
 * @param {object} row De rij uit item_text_drafts.
 * @param {object[]} [warnings] Waarschuwingen om mee te geven (anders de opgeslagen).
 * @returns {object} Het concept.
 */
const draftOf = (row, warnings) => ({
  itemId: row.item_id, description: row.description, seoTitle: row.seo_title, seoDescription: row.seo_description,
  warnings: warnings || warningsOf(row.warnings), notes: row.notes, model: row.model, edited: Boolean(Number(row.edited)), updatedAt: row.updated_at,
});

/**
 * Maakt de opslag voor concepten van producttekst.
 * @param {object} db De database.
 * @returns {object} list, get, save, edit, remove, forApproval, prepareWrite, hasDraft en voor de bulkrun bulkTodo, applyWritten, recordKept, restorePrevious en saveFeatures.
 */
function createItemTextDraftStore(db) {
  const textLog = createItemTextLog(db);
  /**
   * Maakt een query klaar.
   * @param {string} sql De query.
   * @returns {object} De voorbereide query.
   */
  const prepare = (sql) => db.prepare(sql);
  const DRAFT_COLS = 'id, item_id, description, seo_title, seo_description, warnings, notes, model, base_hash, edited, updated_at';

  /**
   * De artikelrij met alles wat de teksten en de bronvelden nodig hebben.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {object|undefined} De rij (artikel plus webshopproduct), of niets.
   */
  const findRow = (tenantId, itemId) => prepare(`SELECT i.id, i.code, i.name, i.unit, i.brand, i.ean, i.weight_grams, i.description, i.specifications, i.attributes, i.seo_title, i.seo_description,
      i.archived, i.parent_id, p.description AS shop_description, p.attributes AS shop_attributes, p.categories
    FROM stock_items i LEFT JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id
    WHERE i.tenant_id = ? AND i.id = ?`).get(tenantId, String(itemId || ''));

  /**
   * Bronvelden en live tekst van een artikel.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} row De rij van findRow.
   * @returns {{ facts: object, live: object }} De bronvelden (buildFacts, met de opgezochte specificaties en kenmerken) en de eigen live tekst van het artikel.
   */
  function sourcesOf(tenantId, row) {
    const names = (() => { try { const list = JSON.parse(row.categories || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } })();
    const facts = buildFacts(row, String(names.find(Boolean) || ''), textLog.read(tenantId, row.id));
    const live = { description: ItemDetails.sanitizeDescription(row.description), seoTitle: ItemDetails.sanitizeSeoTitle(row.seo_title), seoDescription: ItemDetails.sanitizeSeoDescription(row.seo_description) };
    return { facts, live };
  }

  /**
   * Overzicht van de artikelen waarvoor een tekst geschreven kan worden, met de stand van de tekst en het concept.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ search?: string, filter?: string, category?: string }} [options] Zoekterm, filter (alle, ontbreekt, concept, zonderconcept, zonderai, nieuw, overschreven, behouden, hersteld) en categorie.
   * @returns {{ items: object[], total: number, categories: string[], truncated: boolean }} De artikelen (hoogstens MAX_LIST), het totaal en de categorieën.
   */
  function list(tenantId, { search = '', filter = 'alle', category = '' } = {}) {
    const rows = prepare(`SELECT i.id, i.code, i.name, LENGTH(i.description) AS description_length, LENGTH(p.description) AS shop_description_length, i.seo_title, i.seo_description, p.categories,
        d.updated_at AS draft_updated, d.warnings AS draft_warnings, d.edited AS draft_edited,
        (SELECT ((s.specs::jsonb -> 'textLog') - 'previous')::text FROM item_specs s WHERE s.tenant_id = i.tenant_id AND s.item_id = i.id) AS text_log
      FROM stock_items i
      LEFT JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id
      LEFT JOIN item_text_drafts d ON d.tenant_id = i.tenant_id AND d.item_id = i.id
      WHERE i.tenant_id = ? AND i.archived = 0 AND i.parent_id IS NULL ORDER BY i.name, i.code`).all(tenantId);
    const term = String(search || '').trim().toLowerCase();
    const categories = new Set();
    const matching = [];
    for (const row of rows) {
      let names = [];
      try { names = JSON.parse(row.categories || '[]'); } catch { names = []; }
      const categoryName = Array.isArray(names) ? String(names.find(Boolean) || '') : '';
      if (categoryName) categories.add(categoryName);
      if (term && !`${row.code} ${row.name}`.toLowerCase().includes(term)) continue;
      if (category && categoryName !== category) continue;
      const hasDescription = Number(row.description_length) > 0 || Number(row.shop_description_length) > 0;
      const hasSeo = Boolean(row.seo_title) && Boolean(row.seo_description);
      const hasDraft = row.draft_updated != null;
      if (filter === 'ontbreekt' && hasDescription && hasSeo) continue;
      if (filter === 'concept' && !hasDraft) continue;
      if (filter === 'zonderconcept' && hasDraft) continue;
      let written = null;
      try { written = row.text_log ? JSON.parse(row.text_log) : null; } catch { written = null; }
      if (['nieuw', 'overschreven', 'behouden', 'hersteld'].includes(filter) && !(written && written.action === filter)) continue;
      if (filter === 'zonderai' && written) continue;
      const warnings = hasDraft ? warningsOf(row.draft_warnings).length : 0;
      matching.push({ id: row.id, code: row.code, name: row.name, category: categoryName, hasDescription, hasSeo, written: written ? { action: written.action, at: written.at, reason: written.reason || '' } : null, draft: hasDraft ? { updatedAt: row.draft_updated, warnings, edited: Boolean(Number(row.draft_edited)) } : null });
    }
    return { items: matching.slice(0, MAX_LIST), total: matching.length, categories: [...categories].sort((left, right) => left.localeCompare(right, 'nl')), truncated: matching.length > MAX_LIST };
  }

  /**
   * Eén artikel met zijn bronvelden, live tekst en concept (met opnieuw bepaalde waarschuwingen).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {object|null} { item, facts, live, draft }, of null als het artikel niet bestaat.
   */
  function get(tenantId, itemId) {
    const row = findRow(tenantId, itemId);
    if (!row) return null;
    const { facts, live } = sourcesOf(tenantId, row);
    const draftRow = prepare(`SELECT ${DRAFT_COLS} FROM item_text_drafts WHERE tenant_id = ? AND item_id = ?`).get(tenantId, row.id);
    const draft = draftRow ? draftOf(draftRow, warningsFor({ description: draftRow.description, seoTitle: draftRow.seo_title, seoDescription: draftRow.seo_description }, facts)) : null;
    const known = textLog.read(tenantId, row.id) || {};
    return { item: { id: row.id, code: row.code, name: row.name, variant: Boolean(row.parent_id), archived: Boolean(Number(row.archived)) }, facts: facts.fields, thin: facts.thin, live, draft, written: known.textLog || null };
  }

  /**
   * Bewaart een concept (vervangt een eerder concept van dit artikel).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {{ description: string, seoTitle: string, seoDescription: string, notes?: string, model?: string, userId?: string|null, edited?: boolean }} texts De tekst en herkomst.
   * @returns {object|null} Het bewaarde concept, of null als het artikel niet (meer) bestaat.
   */
  function save(tenantId, itemId, texts) {
    const row = findRow(tenantId, itemId);
    if (!row) return null;
    const { facts, live } = sourcesOf(tenantId, row);
    const clean = { description: ItemDetails.sanitizeDescription(texts.description), seoTitle: ItemDetails.sanitizeSeoTitle(texts.seoTitle), seoDescription: ItemDetails.sanitizeSeoDescription(texts.seoDescription) };
    const warnings = warningsFor(clean, facts);
    const timestamp = currentTimestamp();
    transaction(db, () => {
      const existing = prepare('SELECT id FROM item_text_drafts WHERE tenant_id = ? AND item_id = ?').get(tenantId, row.id);
      if (existing) {
        prepare(`UPDATE item_text_drafts SET description = ?, seo_title = ?, seo_description = ?, warnings = ?, notes = ?, model = ?, base_hash = ?, edited = ?, created_by = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`).run(clean.description, clean.seoTitle, clean.seoDescription, JSON.stringify(warnings), texts.notes || '', texts.model || '', hashOf(live), texts.edited ? 1 : 0, texts.userId || null, timestamp, tenantId, existing.id);
      } else {
        prepare(`INSERT INTO item_text_drafts (id, tenant_id, item_id, description, seo_title, seo_description, warnings, notes, model, base_hash, edited, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), tenantId, row.id, clean.description, clean.seoTitle, clean.seoDescription, JSON.stringify(warnings), texts.notes || '', texts.model || '', hashOf(live), texts.edited ? 1 : 0, texts.userId || null, timestamp, timestamp);
      }
    });
    return get(tenantId, row.id).draft;
  }

  /**
   * Past een bewerking van de gebruiker toe op een bestaand concept: de teksten veranderen, de basis (live tekst bij het schrijven) en de herkomst blijven.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {{ description: string, seoTitle: string, seoDescription: string }} texts De nieuwe teksten.
   * @returns {object|null} Het concept, of null als er geen concept is.
   */
  function edit(tenantId, itemId, texts) {
    const draftRow = prepare('SELECT id, notes, model, base_hash FROM item_text_drafts WHERE tenant_id = ? AND item_id = ?').get(tenantId, String(itemId || ''));
    if (!draftRow) return null;
    const row = findRow(tenantId, itemId);
    if (!row) return null;
    const { facts } = sourcesOf(tenantId, row);
    const clean = { description: ItemDetails.sanitizeDescription(texts.description), seoTitle: ItemDetails.sanitizeSeoTitle(texts.seoTitle), seoDescription: ItemDetails.sanitizeSeoDescription(texts.seoDescription) };
    const warnings = warningsFor(clean, facts);
    prepare('UPDATE item_text_drafts SET description = ?, seo_title = ?, seo_description = ?, warnings = ?, edited = 1, updated_at = ? WHERE tenant_id = ? AND id = ?')
      .run(clean.description, clean.seoTitle, clean.seoDescription, JSON.stringify(warnings), currentTimestamp(), tenantId, draftRow.id);
    return get(tenantId, itemId).draft;
  }

  /**
   * Verwijdert het concept van een artikel.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {boolean} true als er een concept was.
   */
  function remove(tenantId, itemId) {
    return prepare('DELETE FROM item_text_drafts WHERE tenant_id = ? AND item_id = ?').run(tenantId, String(itemId || '')).changes > 0;
  }

  /**
   * Het concept en de live tekst van een artikel, voor het goedkeuren.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {{ draft: object, warnings: object[], liveChanged: boolean }|null} Het concept met opnieuw bepaalde waarschuwingen en of de live tekst sinds het schrijven veranderd is; null zonder artikel of concept.
   */
  function forApproval(tenantId, itemId) {
    const row = findRow(tenantId, itemId);
    const draftRow = row && prepare(`SELECT ${DRAFT_COLS} FROM item_text_drafts WHERE tenant_id = ? AND item_id = ?`).get(tenantId, row.id);
    if (!draftRow) return null;
    const { facts, live } = sourcesOf(tenantId, row);
    const warnings = warningsFor({ description: draftRow.description, seoTitle: draftRow.seo_title, seoDescription: draftRow.seo_description }, facts);
    return { draft: draftOf(draftRow, warnings), warnings, liveChanged: hashOf(live) !== draftRow.base_hash, unavailable: Boolean(row.parent_id) || Boolean(Number(row.archived)) };
  }

  /**
   * De artikelen die klaar zijn om een tekst voor te schrijven (bestaan, geen variant, niet gearchiveerd) met hun bronvelden.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {{ status: string, facts?: object }} status ok (met facts), not_found of unavailable.
   */
  function prepareWrite(tenantId, itemId) {
    const row = findRow(tenantId, itemId);
    if (!row) return { status: 'not_found' };
    if (row.parent_id || Number(row.archived)) return { status: 'unavailable' };
    return { status: 'ok', facts: sourcesOf(tenantId, row).facts };
  }

  /**
   * Of een artikel al een concept heeft.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {boolean} true bij een bestaand concept.
   */
  const hasDraft = (tenantId, itemId) => Boolean(prepare('SELECT id FROM item_text_drafts WHERE tenant_id = ? AND item_id = ?').get(tenantId, String(itemId || '')));

  /**
   * De hoofdartikelen die in een bulkrun aan de beurt zijn: niet gearchiveerd, geen variant, nog geen concept en nog niet door een eerdere bulkrun behandeld.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ review?: boolean }} [options] review = ook artikelen die al een omschrijving hebben (die wordt beoordeeld en alleen vervangen als de nieuwe beter is); anders alleen artikelen zonder omschrijving.
   * @returns {{ ids: string[], total: number, withExisting: number, withoutFeatures: number }} De id's (op naam), hoeveel er al een omschrijving hebben en voor hoeveel nog kenmerken moeten worden opgezocht.
   */
  function bulkTodo(tenantId, { review = true } = {}) {
    const rows = prepare(`SELECT i.id, (COALESCE(LENGTH(i.description), 0) > 0 OR COALESCE(LENGTH(p.description), 0) > 0) AS has_text,
        (s.specs LIKE '%"kenmerkenAt"%') AS has_features
      FROM stock_items i
      LEFT JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id
      LEFT JOIN item_specs s ON s.tenant_id = i.tenant_id AND s.item_id = i.id
      WHERE i.tenant_id = ? AND i.archived = 0 AND i.parent_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM item_text_drafts d WHERE d.tenant_id = i.tenant_id AND d.item_id = i.id)
        AND (s.specs IS NULL OR s.specs NOT LIKE '%"textLog"%')
      ORDER BY i.name, i.code`).all(tenantId);
    const wanted = rows.filter((row) => review || !row.has_text);
    return { ids: wanted.map((row) => row.id), total: wanted.length, withExisting: wanted.filter((row) => row.has_text).length, withoutFeatures: wanted.filter((row) => !row.has_features).length };
  }

  /**
   * De kenmerken die voor een artikel zijn opgezocht (om te zien of opzoeken nog nodig is).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {boolean} true als er al eens naar kenmerken is gezocht (ook zonder resultaat).
   */
  const featuresSearched = (tenantId, itemId) => Boolean((textLog.read(tenantId, String(itemId || '')) || {}).kenmerkenAt);

  /**
   * De omschrijving die nu in gebruik is (eigen, anders die van het webshopproduct), met waar ze staat.
   * @param {object} row De rij van findRow.
   * @returns {{ text: string, source: string }} De tekst en 'eigen', 'webshop' of leeg.
   */
  function currentTextOf(row) {
    const own = ItemDetails.sanitizeDescription(row.description);
    if (own) return { text: own, source: 'eigen' };
    const shop = ItemDetails.sanitizeDescription(row.shop_description);
    return shop ? { text: shop, source: 'webshop' } : { text: '', source: '' };
  }

  /**
   * De omschrijving die nu in gebruik is (eigen, anders die van het webshopproduct).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {string} De tekst, leeg zonder omschrijving of zonder artikel.
   */
  const currentText = (tenantId, itemId) => { const row = findRow(tenantId, itemId); return row ? currentTextOf(row).text : ''; };

  /**
   * Zet een geschreven omschrijving direct live (bulkrun) en legt vast wat er gebeurde. De titel en omschrijving voor zoekmachines worden alleen gevuld als ze leeg zijn.
   * Een bestaande omschrijving wordt bewaard in het logboek, zodat ze terug kan.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {{ description: string, seoTitle: string, seoDescription: string, model?: string, reason?: string, basis?: string }} texts De geschreven tekst; basis = de omschrijving waarop de AI zijn oordeel baseerde (is ze intussen veranderd, dan wordt niets overschreven).
   * @param {{ update: Function }} stock De voorraadopslag (voor de wijziging van het artikel).
   * @param {object|null} user Wie de run startte.
   * @returns {{ action?: string, error?: string }} nieuw of overschreven, of een fout (changed = de omschrijving is intussen veranderd).
   */
  function applyWritten(tenantId, itemId, texts, stock, user) {
    const row = findRow(tenantId, itemId);
    if (!row) return { error: 'not_found' };
    const previous = currentTextOf(row);
    if (texts.basis !== undefined && texts.basis !== previous.text) return { error: 'changed' };
    const live = ItemDetails.sanitizeSeoTitle(row.seo_title) && ItemDetails.sanitizeSeoDescription(row.seo_description);
    const patch = { description: texts.description };
    if (!ItemDetails.sanitizeSeoTitle(row.seo_title)) patch.seoTitle = texts.seoTitle;
    if (!ItemDetails.sanitizeSeoDescription(row.seo_description)) patch.seoDescription = texts.seoDescription;
    const out = stock.update(tenantId, itemId, patch, user);
    if (out.error) return { error: out.error };
    const action = previous.text ? 'overschreven' : 'nieuw';
    textLog.recordWrite(tenantId, itemId, { action, model: texts.model, reason: texts.reason, previous: previous.text ? previous : undefined });
    return { action, seoKept: Boolean(live) };
  }

  /**
   * Legt vast dat de bestaande omschrijving is behouden (het oordeel van de AI), zodat het artikel niet opnieuw aan de beurt komt.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {{ model?: string, reason?: string }} info Model en reden.
   * @returns {void}
   */
  const recordKept = (tenantId, itemId, info) => textLog.recordWrite(tenantId, itemId, { action: 'behouden', model: info.model, reason: info.reason });

  /**
   * Zet de omschrijving terug naar wat er stond vóór een bulkrun. Stond die in het webshopproduct, dan wordt de eigen omschrijving leeggemaakt (de webshoptekst komt weer tevoorschijn).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {{ update: Function }} stock De voorraadopslag.
   * @param {object|null} user Wie het terugzet.
   * @returns {{ ok?: boolean, error?: string }} Uitkomst.
   */
  function restorePrevious(tenantId, itemId, stock, user) {
    const known = textLog.read(tenantId, String(itemId || ''));
    const entry = known && known.textLog;
    if (!entry || entry.action !== 'overschreven' || !entry.previous) return { error: 'nothing_to_restore' };
    const out = stock.update(tenantId, itemId, { description: entry.previous.source === 'webshop' ? '' : entry.previous.text }, user);
    if (out.error) return { error: out.error };
    textLog.recordWrite(tenantId, itemId, { action: 'hersteld', reason: 'De vorige omschrijving is teruggezet.' });
    return { ok: true };
  }

  return { list, get, save, edit, remove, forApproval, prepareWrite, hasDraft, currentText, bulkTodo, featuresSearched, applyWritten, recordKept, restorePrevious, saveFeatures: textLog.saveFeatures, logOf: textLog.read };
}

/**
 * Hangt de routes voor producttekst aan de app (`/api/stock/item-texts`, recht `voorraad`).
 * @param {object} app De Express-app.
 * @param {object} ctx De opslag en hulpfuncties: drafts, stock, requireRight, requireJson, audit, settingsFor, aiTenantOf, currentItemTextWriter, dailyFor, limiter, aiUsage.
 * @returns {void}
 */
function registerItemTextRoutes(app, ctx) {
  const { drafts, stock, requireRight, requireJson, audit, settingsFor, aiTenantOf, currentItemTextWriter, dailyFor, limiter, aiUsage } = ctx;
  const requireStock = requireRight('voorraad');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Stuurt 404 terug.
   * @param {object} res Het antwoord.
   * @returns {object} Het antwoord.
   */
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Artikel niet gevonden.' });
  /**
   * De id's uit de aanvraag, uniek en begrensd.
   * @param {*} value De invoer.
   * @param {number} max Hoogstens zoveel.
   * @returns {string[]|null} De id's, of null als de invoer ongeldig of leeg is of te groot.
   */
  const idsOf = (value, max) => {
    if (!Array.isArray(value) || !value.length || value.length > max) return null;
    const ids = [...new Set(value.map((id) => String(id || '')).filter(Boolean))];
    return ids.length ? ids : null;
  };

  /**
   * De AI-status voor het scherm: aan of uit, sleutel aanwezig, hoeveel verzoeken er vandaag nog mogen en de portiegrootte.
   * @param {object} req Het verzoek.
   * @returns {{ enabled: boolean, configured: boolean, remainingToday: number, batchSize: number }} De status.
   */
  const aiStateOf = (req) => {
    const settings = settingsFor(tenantOf(req));
    return {
      enabled: Boolean(settings.get('aiEnabled')),
      configured: currentItemTextWriter(tenantOf(req)).available,
      remainingToday: Math.max(0, settingsFor(aiTenantOf(tenantOf(req))).get('aiDailyLimit') - dailyFor(tenantOf(req)).count),
      batchSize: GENERATE_BATCH,
    };
  };

  app.get('/api/stock/item-texts', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const filter = ['alle', 'ontbreekt', 'concept', 'zonderconcept', 'zonderai', 'nieuw', 'overschreven', 'behouden', 'hersteld'].includes(req.query.filter) ? req.query.filter : 'alle';
    res.json({
      ...drafts.list(tenantOf(req), { search: String(req.query.q || '').slice(0, 80), filter, category: String(req.query.category || '').slice(0, 120) }),
      ai: aiStateOf(req),
    });
  });

  app.get('/api/stock/item-texts/:itemId', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const found = drafts.get(tenantOf(req), req.params.itemId);
    return found ? res.json({ ...found, ai: aiStateOf(req) }) : notFound(res);
  });

  app.post('/api/stock/item-texts/generate', requireJson, requireStock, limiter, async (req, res, next) => {
    const tenantId = tenantOf(req);
    const ids = idsOf(req.body && req.body.itemIds, GENERATE_BATCH);
    if (!ids) return res.status(400).json({ error: 'invalid', message: `Kies 1 tot ${GENERATE_BATCH} artikelen per keer.` });
    const settings = settingsFor(tenantId);
    if (!settings.get('aiEnabled')) {
      return res.status(409).json({ error: 'disabled', message: 'AI staat uit (Beheer → Integraties → AI-herkenning). Teksten schrijf je dan met de hand.' });
    }
    const writer = currentItemTextWriter(tenantId);
    if (!writer.available) {
      return res.status(409).json({ error: 'not_configured', message: 'Teksten schrijven is niet ingesteld: een beheerder kan de API-sleutel invullen bij Beheer → Integraties → AI-herkenning.' });
    }
    const skipExisting = Boolean(req.body.skipExisting);
    const daily = dailyFor(tenantId);
    const dailyLimit = settingsFor(aiTenantOf(tenantId)).get('aiDailyLimit');
    if (daily.count >= dailyLimit) {
      return res.status(429).json({ error: 'daily_limit', message: 'Het dagelijkse maximum voor AI-verzoeken is bereikt. Probeer het morgen opnieuw of verhoog het maximum bij Beheer → Integraties → AI-herkenning.' });
    }
    const results = [];
    let aborted = null;
    let cursor = 0;
    /**
     * Legt het verbruik van één aanroep vast in het kostenoverzicht.
     * @param {string} itemId Het artikel.
     * @param {number} started Starttijd in ms.
     * @param {{ model?: string, usage?: object, status?: string }} result Model, verbruik en status.
     * @returns {void}
     */
    const logUsage = (itemId, started, { model, usage, status = 'ok' }) => {
      try {
        const aiSettings = settingsFor(aiTenantOf(tenantId));
        aiUsage.record({ tenantId, userId: req.user ? req.user.id : null, feature: 'product_tekst', model: model || writer.model || aiSettings.get('aiModel'),
          status, usage: usage || {}, durationMs: Date.now() - started, eurCentsPerUsd: aiSettings.get('aiEurCentsPerUsd'), detail: { itemId } });
      } catch (error) {
        console.warn(`AI-verbruik niet vastgelegd: ${error.message}`);
      }
    };
    /**
     * Schrijft de tekst voor één artikel en zet de uitkomst in results.
     * @param {string} itemId Het artikel.
     * @returns {Promise<void>}
     */
    const handle = async (itemId) => {
      const prepared = drafts.prepareWrite(tenantId, itemId);
      if (prepared.status === 'not_found') { results.push({ itemId, status: 'error', code: 'not_found', message: 'Artikel niet gevonden.' }); return; }
      if (prepared.status === 'unavailable') { results.push({ itemId, status: 'skipped', code: 'unavailable', message: 'Varianten en gearchiveerde artikelen krijgen geen eigen tekst.' }); return; }
      if (skipExisting && drafts.hasDraft(tenantId, itemId)) { results.push({ itemId, status: 'skipped', code: 'has_draft', message: 'Er staat al een concept.' }); return; }
      if (aborted) { results.push({ itemId, status: 'error', code: aborted.code, message: aborted.message }); return; }
      if (daily.count >= dailyLimit) { results.push({ itemId, status: 'error', code: 'daily_limit', message: 'Het dagelijkse maximum voor AI-verzoeken is bereikt.' }); return; }
      daily.count += 1;
      const started = Date.now();
      try {
        const written = await writer.write({ fields: prepared.facts.fields });
        logUsage(itemId, started, { model: written.model, usage: written.usage });
        const draft = drafts.save(tenantId, itemId, { ...written, userId: req.user ? req.user.id : null });
        if (!draft) { results.push({ itemId, status: 'error', code: 'not_found', message: 'Artikel niet gevonden.' }); return; }
        results.push({ itemId, status: 'ok', warnings: draft.warnings.length });
      } catch (error) {
        if (error instanceof AnalyzeError) {
          if (error.code !== 'not_configured') logUsage(itemId, started, { model: error.model, usage: error.usage, status: error.code });
          if (FATAL_CODES.includes(error.code)) aborted = { code: error.code, message: error.message };
          results.push({ itemId, status: 'error', code: error.code, message: error.message });
          return;
        }
        logUsage(itemId, started, { status: 'error' });
        console.warn(`Producttekst schrijven mislukt: ${error.message}`);
        results.push({ itemId, status: 'error', code: 'error', message: 'Het schrijven is mislukt door een interne fout.' });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(GENERATE_CONCURRENCY, ids.length) }, async () => {
        while (cursor < ids.length) { const itemId = ids[cursor]; cursor += 1; await handle(itemId); }
      }));
    } catch (error) {
      return next(error);
    }
    const ordered = ids.map((itemId) => results.find((result) => result.itemId === itemId)).filter(Boolean);
    audit(req, 'producttekst_geschreven', { requested: ids.length, written: ordered.filter((result) => result.status === 'ok').length });
    return res.json({ results: ordered, aborted, remainingToday: Math.max(0, dailyLimit - daily.count) });
  });

  app.put('/api/stock/item-texts/:itemId', requireJson, requireStock, (req, res) => {
    if (!ItemDetails.sanitizeDescription(req.body && req.body.description)) return res.status(400).json({ error: 'invalid', message: 'De omschrijving mag niet leeg zijn.', field: 'description' });
    const draft = drafts.edit(tenantOf(req), req.params.itemId, req.body || {});
    return draft ? res.json({ draft }) : res.status(404).json({ error: 'not_found', message: 'Concept niet gevonden.' });
  });

  app.delete('/api/stock/item-texts/:itemId', requireStock, (req, res) => {
    if (!drafts.remove(tenantOf(req), req.params.itemId)) return res.status(404).json({ error: 'not_found', message: 'Concept niet gevonden.' });
    audit(req, 'producttekst_afgewezen', { count: 1 });
    return res.json({ ok: true });
  });

  app.post('/api/stock/item-texts/reject', requireJson, requireStock, (req, res) => {
    const ids = idsOf(req.body && req.body.itemIds, DECIDE_BATCH);
    if (!ids) return res.status(400).json({ error: 'invalid', message: `Kies 1 tot ${DECIDE_BATCH} concepten.` });
    const rejected = ids.filter((itemId) => drafts.remove(tenantOf(req), itemId)).length;
    audit(req, 'producttekst_afgewezen', { count: rejected });
    return res.json({ rejected });
  });

  app.post('/api/stock/item-texts/approve', requireJson, requireStock, (req, res) => {
    const tenantId = tenantOf(req);
    const ids = idsOf(req.body && req.body.itemIds, DECIDE_BATCH);
    if (!ids) return res.status(400).json({ error: 'invalid', message: `Kies 1 tot ${DECIDE_BATCH} concepten.` });
    const overwrite = req.body.overwrite === true;
    const acknowledgeWarnings = req.body.acknowledgeWarnings === true;
    const results = [];
    for (const itemId of ids) {
      const found = drafts.forApproval(tenantId, itemId);
      if (!found) { results.push({ itemId, status: 'not_found' }); continue; }
      if (found.unavailable) { results.push({ itemId, status: 'unavailable' }); continue; }
      if (found.warnings.length && !acknowledgeWarnings) { results.push({ itemId, status: 'warnings', warnings: found.warnings }); continue; }
      if (found.liveChanged && !overwrite) { results.push({ itemId, status: 'changed' }); continue; }
      const out = stock.update(tenantId, itemId, { description: found.draft.description, seoTitle: found.draft.seoTitle, seoDescription: found.draft.seoDescription }, req.user);
      if (out.error) { results.push({ itemId, status: 'error', message: out.error }); continue; }
      drafts.remove(tenantId, itemId);
      results.push({ itemId, status: 'approved' });
    }
    audit(req, 'producttekst_goedgekeurd', { count: results.filter((result) => result.status === 'approved').length, withWarnings: acknowledgeWarnings && results.some((result) => result.status === 'approved') });
    res.json({ results });
  });
}

module.exports = { createItemTextDraftStore, registerItemTextRoutes, hashOf, GENERATE_BATCH, DECIDE_BATCH };
