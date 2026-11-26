// Gerelateerde artikelen voor de webshop: "Past bij" (handmatig of door de AI, tabel item_related) en "Vaak samen besteld" (berekend, tabel
// item_together), plus de opgezochte specificaties waarop de AI-koppeling rust (tabel item_specs, migratie 99).
//
// - Alles werkt op hoofdartikelen: varianten delen de koppelingen van hun hoofdartikel.
// - Past bij handmatig: de gebruiker kiest artikelen (hoogstens MAX_LINKS). Een handmatige koppeling wordt nooit door de AI overschreven of gewist.
// - Past bij met AI: de AI zoekt specificaties op (related-research.js), de code bepaalt met vaste regels wat past (related-compat.js). Elke koppeling heeft
//   een reden en bronnen. Zonder gevonden specificaties komt er geen koppeling.
// - Vaak samen besteld: uit de verzonden bestellingen (web_sale_lines) plus de orderhistorie van de oude WordPress-webshop (wp_order_lines, migratie 101): een artikel telt alleen mee als het relatief vaak samen met het andere voorkomt
//   (minimaal aantal bestellingen, aandeel en lift), niet omdat het populair is. Bestellingen met een retour van dat artikel tellen niet mee.
// - De webshop toont alleen artikelen die in de catalogus staan (actief, met prijs en in de shop) en leverbaar zijn, met de gewone prijsregels (storefront.js).
const crypto = require('crypto');
const { transaction } = require('../database/db');
const { suggestLinks } = require('./related-compat');

/** Hoeveel gerelateerde artikelen een artikel hoogstens heeft (handmatig + AI). */
const MAX_LINKS = 8;
/** Hoeveel artikelen één onderzoeksverzoek bevat. */
const RESEARCH_BATCH = 5;
/** Hoeveel artikelen tegelijk bij de AI-dienst. */
const RESEARCH_CONCURRENCY = 3;
/** Hoeveel artikelen het overzicht hoogstens toont. */
const MAX_LIST = 300;
/** Hoeveel artikelen één AI-ronde hoogstens bevat (begrenst de kosten). */
const MAX_RESEARCH = 5000;
/** Bestellingen van de laatste maanden tellen mee voor vaak samen besteld. */
const TOGETHER_MONTHS = 24;
/** Drempels voor vaak samen besteld. */
const MIN_PAIR_ORDERS = 3;
const MIN_ITEM_ORDERS = 5;
const MIN_CONFIDENCE = 0.1;
const MIN_LIFT = 1.5;
/** Bestellingen met meer verschillende artikelen tellen niet mee (zakelijke bulk geeft toevallige paren). */
const MAX_ORDER_ITEMS = 30;
/** Hoeveel regels uit web_sale_lines hoogstens gelezen worden. */
const MAX_SALE_LINES = 200000;

/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * Leest een JSON-kolom.
 * @param {*} value De kolom.
 * @param {*} fallback Waarde bij onleesbare invoer.
 * @returns {*} De waarde.
 */
function jsonOf(value, fallback) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
}

/**
 * Berekent welke artikelparen vaak samen besteld worden.
 * @param {{ orderId: string, itemId: string, kind: string }[]} lines Verkoop- en retourregels (artikel = hoofdartikel).
 * @returns {Map<string, { otherId: string, both: number, item: number, other: number, lift: number, score: number }[]>} Per artikel de beste partners (hoogstens MAX_LINKS), beste eerst.
 */
function computeTogether(lines) {
  const returned = new Set(lines.filter((line) => line.kind === 'retour').map((line) => `${line.orderId}|${line.itemId}`));
  const orders = new Map();
  for (const line of lines) {
    if (line.kind !== 'verkoop' || returned.has(`${line.orderId}|${line.itemId}`)) continue;
    if (!orders.has(line.orderId)) orders.set(line.orderId, new Set());
    orders.get(line.orderId).add(line.itemId);
  }
  const usable = [...orders.values()].filter((items) => items.size >= 1 && items.size <= MAX_ORDER_ITEMS);
  const total = usable.length;
  const single = new Map();
  const pairs = new Map();
  for (const items of usable) {
    const list = [...items];
    for (const itemId of list) single.set(itemId, (single.get(itemId) || 0) + 1);
    for (let left = 0; left < list.length; left += 1) {
      for (let right = left + 1; right < list.length; right += 1) {
        const key = list[left] < list[right] ? `${list[left]}|${list[right]}` : `${list[right]}|${list[left]}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  }
  const result = new Map();
  for (const [key, both] of pairs) {
    if (both < MIN_PAIR_ORDERS) continue;
    const [first, second] = key.split('|');
    const countFirst = single.get(first);
    const countSecond = single.get(second);
    const lift = (both * total) / (countFirst * countSecond);
    if (lift < MIN_LIFT) continue;
    for (const [itemId, otherId, countItem, countOther] of [[first, second, countFirst, countSecond], [second, first, countSecond, countFirst]]) {
      if (countItem < MIN_ITEM_ORDERS) continue;
      const confidence = both / countItem;
      if (confidence < MIN_CONFIDENCE) continue;
      if (!result.has(itemId)) result.set(itemId, []);
      result.get(itemId).push({ otherId, both, item: countItem, other: countOther, lift, score: confidence * Math.log2(1 + lift) });
    }
  }
  for (const [itemId, list] of result) result.set(itemId, list.sort((left, right) => right.score - left.score || (left.otherId < right.otherId ? -1 : 1)).slice(0, MAX_LINKS));
  return result;
}

/**
 * Maakt de opslag voor gerelateerde artikelen.
 * @param {object} db De database.
 * @returns {object} De functies van de opslag.
 */
function createRelatedStore(db) {
  /**
   * Maakt een query klaar.
   * @param {string} sql De query.
   * @returns {object} De voorbereide query.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * Een reeks vraagtekens voor een IN-lijst.
   * @param {number} count Aantal.
   * @returns {string} Bijv. '?,?,?'.
   */
  const placeholders = (count) => Array.from({ length: count }, () => '?').join(',');

  /**
   * Het hoofdartikel (geen variant, niet gearchiveerd) met dit id.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {object|undefined} De rij, of niets.
   */
  const findMain = (tenantId, itemId) => prepare('SELECT id, code, name FROM stock_items WHERE tenant_id = ? AND id::text = ? AND parent_id IS NULL AND archived = 0').get(tenantId, String(itemId || ''));

  /**
   * Zet een koppelingsrij om naar het formaat van de API.
   * @param {object} row De rij uit item_related met code en naam van het gekoppelde artikel.
   * @returns {object} De koppeling.
   */
  const linkOf = (row) => ({ relatedId: row.related_item_id, code: row.code, name: row.name, source: row.source, reason: row.reason, evidence: jsonOf(row.evidence, []), position: Number(row.position) });

  /**
   * De koppelingen en partners van één artikel.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het hoofdartikel.
   * @returns {{ links: object[], together: object[], specs: ?object }|null} Past bij, vaak samen besteld en de stand van de specificaties, of null als het artikel niet bestaat.
   */
  function detail(tenantId, itemId) {
    const item = findMain(tenantId, itemId);
    if (!item) return null;
    const links = prepare(`SELECT r.related_item_id, r.position, r.source, r.reason, r.evidence, i.code, i.name FROM item_related r
      JOIN stock_items i ON i.tenant_id = r.tenant_id AND i.id = r.related_item_id WHERE r.tenant_id = ? AND r.item_id = ? ORDER BY r.position, i.name`).all(tenantId, item.id).map(linkOf);
    const together = prepare(`SELECT t.other_id, t.orders_both, t.orders_item, t.lift, i.code, i.name FROM item_together t
      JOIN stock_items i ON i.tenant_id = t.tenant_id AND i.id = t.other_id WHERE t.tenant_id = ? AND t.item_id = ? AND i.archived = 0 ORDER BY t.score DESC`).all(tenantId, item.id)
      .map((row) => ({ otherId: row.other_id, code: row.code, name: row.name, ordersBoth: Number(row.orders_both), ordersItem: Number(row.orders_item), lift: Math.round(Number(row.lift) * 10) / 10 }));
    const specRow = prepare('SELECT status, specs, model, checked_at FROM item_specs WHERE tenant_id = ? AND item_id = ?').get(tenantId, item.id);
    return { item: { id: item.id, code: item.code, name: item.name }, links, together, specs: specRow ? { status: specRow.status, specs: jsonOf(specRow.specs, {}), model: specRow.model, checkedAt: specRow.checked_at } : null };
  }

  /**
   * Overzicht van de hoofdartikelen met het aantal koppelingen en de stand van de specificaties.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ search?: string, filter?: string }} [options] Zoekterm en filter (alle, zonder, handmatig, ai, geenspec).
   * @returns {{ items: object[], total: number, truncated: boolean }} Hoogstens MAX_LIST artikelen.
   */
  function list(tenantId, { search = '', filter = 'alle' } = {}) {
    const term = `%${String(search).toLowerCase().replace(/[%_\\]/g, ' ').trim()}%`;
    const rows = prepare(`SELECT i.id, i.code, i.name, i.brand,
        (SELECT COUNT(*) FROM item_related r WHERE r.tenant_id = i.tenant_id AND r.item_id = i.id AND r.source = 'handmatig') AS manual_count,
        (SELECT COUNT(*) FROM item_related r WHERE r.tenant_id = i.tenant_id AND r.item_id = i.id AND r.source = 'ai') AS ai_count,
        (SELECT COUNT(*) FROM item_together t WHERE t.tenant_id = i.tenant_id AND t.item_id = i.id) AS together_count,
        (SELECT CASE WHEN s.specs LIKE '%"descOnly":true%' THEN '' ELSE s.status END FROM item_specs s WHERE s.tenant_id = i.tenant_id AND s.item_id = i.id) AS spec_status
      FROM stock_items i WHERE i.tenant_id = ? AND i.parent_id IS NULL AND i.archived = 0 AND (lower(i.name) LIKE ? OR lower(i.code) LIKE ?)
      ORDER BY i.name`).all(tenantId, term, term);
    const shaped = rows.map((row) => ({ id: row.id, code: row.code, name: row.name, brand: row.brand || '', manual: Number(row.manual_count), ai: Number(row.ai_count), together: Number(row.together_count), specStatus: row.spec_status || '' }));
    const filtered = shaped.filter((row) => (filter === 'zonder' ? !row.manual && !row.ai : filter === 'handmatig' ? row.manual : filter === 'ai' ? row.ai : filter === 'geenspec' ? row.specStatus === 'niet_gevonden' : true));
    return { items: filtered.slice(0, MAX_LIST), total: filtered.length, truncated: filtered.length > MAX_LIST };
  }

  /**
   * Vervangt de handmatige koppelingen van een artikel door de gekozen lijst (in die volgorde, vóór de AI-koppelingen). Een gekozen artikel dat al een
   * AI-koppeling was wordt handmatig. Valideert eerst, schrijft dan.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het hoofdartikel.
   * @param {string[]} relatedIds Gekozen artikelen.
   * @returns {{ ok?: boolean, error?: string, message?: string }} Uitkomst; bij een fout niets geschreven.
   */
  function setManual(tenantId, itemId, relatedIds) {
    const item = findMain(tenantId, itemId);
    if (!item) return { error: 'not_found', message: 'Artikel niet gevonden.' };
    const wanted = [...new Set((Array.isArray(relatedIds) ? relatedIds : []).map(String))];
    if (wanted.includes(String(item.id))) return { error: 'invalid', message: 'Een artikel kan niet bij zichzelf passen.' };
    if (wanted.length > MAX_LINKS) return { error: 'too_many', message: `Hoogstens ${MAX_LINKS} artikelen per artikel.` };
    if (wanted.length) {
      const found = prepare(`SELECT id FROM stock_items WHERE tenant_id = ? AND parent_id IS NULL AND archived = 0 AND id::text IN (${placeholders(wanted.length)})`).all(tenantId, ...wanted);
      if (found.length !== wanted.length) return { error: 'invalid', message: 'Een gekozen artikel bestaat niet of is een variant of gearchiveerd.' };
    }
    transaction(db, () => {
      // Binnen de transactie gelezen, zodat een gelijktijdige AI-ronde geen verouderde lijst oplevert.
      const existingAi = prepare("SELECT related_item_id FROM item_related WHERE tenant_id = ? AND item_id = ? AND source = 'ai'").all(tenantId, item.id).map((row) => String(row.related_item_id));
      prepare("DELETE FROM item_related WHERE tenant_id = ? AND item_id = ? AND source = 'handmatig'").run(tenantId, item.id);
      wanted.forEach((relatedId, index) => {
        prepare("DELETE FROM item_related WHERE tenant_id = ? AND item_id = ? AND related_item_id::text = ?").run(tenantId, item.id, relatedId);
        prepare("INSERT INTO item_related (id, tenant_id, item_id, related_item_id, position, source, reason, evidence, created_at) VALUES (?, ?, ?, ?, ?, 'handmatig', '', '[]', ?)")
          .run(crypto.randomUUID(), tenantId, item.id, relatedId, index, currentTimestamp());
      });
      // De AI-koppelingen schuiven achter de handmatige; boven het maximum vervallen de laatste AI-koppelingen.
      const room = Math.max(0, MAX_LINKS - wanted.length);
      const keep = existingAi.filter((relatedId) => !wanted.includes(relatedId));
      keep.forEach((relatedId, index) => {
        if (index >= room) prepare("DELETE FROM item_related WHERE tenant_id = ? AND item_id = ? AND related_item_id::text = ?").run(tenantId, item.id, relatedId);
        else prepare('UPDATE item_related SET position = ? WHERE tenant_id = ? AND item_id = ? AND related_item_id::text = ?').run(100 + index, tenantId, item.id, relatedId);
      });
    });
    return { ok: true };
  }

  /**
   * Haalt één koppeling weg (ook een AI-koppeling).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het hoofdartikel.
   * @param {string} relatedId Id van het gekoppelde artikel.
   * @returns {boolean} true als er een koppeling was.
   */
  function removeLink(tenantId, itemId, relatedId) {
    return prepare('DELETE FROM item_related WHERE tenant_id = ? AND item_id::text = ? AND related_item_id::text = ?').run(tenantId, String(itemId || ''), String(relatedId || '')).changes > 0;
  }

  /**
   * Wist alle AI-koppelingen van de omgeving (handmatige blijven staan).
   * @param {string} tenantId Id van de omgeving.
   * @returns {number} Aantal gewiste koppelingen.
   */
  const clearAi = (tenantId) => prepare("DELETE FROM item_related WHERE tenant_id = ? AND source = 'ai'").run(tenantId).changes;

  /**
   * De hoofdartikelen waarvan de specificaties nog moeten worden opgezocht.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ again?: boolean, staleBefore?: string }} [options] again = ook artikelen met een eerdere uitkomst; staleBefore = ook artikelen die vóór dit moment zijn gecontroleerd.
   * @returns {{ ids: string[], total: number, capped: boolean }} De id's (hoogstens MAX_RESEARCH) en het totaal.
   */
  function researchTodo(tenantId, { again = false, staleBefore = '' } = {}) {
    const rows = prepare(`SELECT i.id FROM stock_items i LEFT JOIN item_specs s ON s.tenant_id = i.tenant_id AND s.item_id = i.id
      WHERE i.tenant_id = ? AND i.parent_id IS NULL AND i.archived = 0
        AND (? OR s.item_id IS NULL OR s.specs LIKE '%"descOnly":true%' OR (? <> '' AND s.checked_at < ?::timestamptz))
      ORDER BY i.name`).all(tenantId, again, staleBefore, staleBefore || '1970-01-01T00:00:00Z');
    return { ids: rows.slice(0, MAX_RESEARCH).map((row) => row.id), total: rows.length, capped: rows.length > MAX_RESEARCH };
  }

  /**
   * De bronvelden voor de zoekopdracht van één artikel.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {{ fields: { label: string, value: string }[] }|null} De velden, of null als het artikel niet te onderzoeken is.
   */
  function factsFor(tenantId, itemId) {
    const row = prepare('SELECT id, code, name, brand, ean, unit FROM stock_items WHERE tenant_id = ? AND id::text = ? AND parent_id IS NULL AND archived = 0').get(tenantId, String(itemId || ''));
    if (!row) return null;
    const skus = prepare('SELECT supplier_sku FROM item_suppliers WHERE tenant_id = ? AND item_id = ? AND supplier_sku <> \'\' ORDER BY preferred DESC LIMIT 2').all(tenantId, row.id).map((entry) => entry.supplier_sku);
    const fields = [{ label: 'Naam', value: row.name }, { label: 'Merk', value: row.brand }, { label: 'Artikelnummer', value: row.code }, { label: 'EAN', value: row.ean }, { label: 'Artikelnummer leverancier', value: skus.join(', ') }, { label: 'Eenheid', value: row.unit }]
      .filter((field) => String(field.value || '').trim());
    return { fields };
  }

  /**
   * Bewaart de uitkomst van een zoekopdracht (vervangt een eerdere).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het hoofdartikel.
   * @param {{ status: string, specs: ?object, model: string }} result De uitkomst.
   * @returns {void}
   */
  function saveSpecs(tenantId, itemId, { status, specs, model }) {
    // Kenmerken en het schrijflogboek van de omschrijving (item-text-log.js) staan in dezelfde kolom en blijven bewaard.
    const kept = {};
    const existing = prepare('SELECT specs FROM item_specs WHERE tenant_id = ? AND item_id = ?').get(tenantId, itemId);
    if (existing) {
      const old = jsonOf(existing.specs, {});
      for (const key of ['kenmerken', 'kenmerkenAt', 'textLog']) if (old[key] !== undefined) kept[key] = old[key];
    }
    prepare(`INSERT INTO item_specs (tenant_id, item_id, status, specs, model, checked_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, item_id) DO UPDATE SET status = EXCLUDED.status, specs = EXCLUDED.specs, model = EXCLUDED.model, checked_at = EXCLUDED.checked_at`)
      .run(tenantId, itemId, status, JSON.stringify({ ...(specs || {}), ...kept }), String(model || '').slice(0, 80), currentTimestamp());
  }

  /**
   * Berekent met de opgeslagen specificaties welke artikelen bij elkaar passen en vervangt de AI-koppelingen. Handmatige koppelingen blijven staan en
   * tellen mee voor het maximum. Artikelen die vaak samen besteld worden komen eerst.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ items: number, links: number, withSpecs: number, withoutSpecs: number }} Aantal artikelen met koppelingen, aantal koppelingen, en hoeveel artikelen wel/geen specificaties hebben.
   */
  function linkWithSpecs(tenantId) {
    const rows = prepare(`SELECT s.item_id, s.specs, i.name FROM item_specs s JOIN stock_items i ON i.tenant_id = s.tenant_id AND i.id = s.item_id
      WHERE s.tenant_id = ? AND s.status = 'gevonden' AND i.parent_id IS NULL AND i.archived = 0`).all(tenantId);
    const ranks = new Map();
    for (const row of prepare('SELECT item_id, other_id, score FROM item_together WHERE tenant_id = ?').all(tenantId)) ranks.set(`${row.item_id}|${row.other_id}`, Number(row.score));
    const items = rows.map((row) => ({ id: String(row.item_id), name: row.name, specs: jsonOf(row.specs, null) })).filter((item) => item.specs && Array.isArray(item.specs.connections));
    const suggestions = suggestLinks(items.map((item) => ({ ...item, rank: 0 })), { perItem: 100000 });
    // Eerst rangschikken, dan handmatige paren eruit en pas daarna afkappen op de ruimte die er is (zie hieronder).
    // De rangschikking per artikel hangt af van het artikel zelf (partners van vaak samen besteld eerst).
    const ordered = new Map();
    for (const [itemId, list] of suggestions) ordered.set(itemId, [...list].sort((left, right) => (ranks.get(`${itemId}|${right.relatedId}`) || 0) - (ranks.get(`${itemId}|${left.relatedId}`) || 0)));
    let linkCount = 0;
    let itemCount = 0;
    transaction(db, () => {
      prepare("DELETE FROM item_related WHERE tenant_id = ? AND source = 'ai'").run(tenantId);
      const manualCounts = new Map(prepare("SELECT item_id, COUNT(*) AS n FROM item_related WHERE tenant_id = ? AND source = 'handmatig' GROUP BY item_id").all(tenantId).map((row) => [String(row.item_id), Number(row.n)]));
      const manualPairs = new Set(prepare("SELECT item_id, related_item_id FROM item_related WHERE tenant_id = ? AND source = 'handmatig'").all(tenantId).map((row) => `${row.item_id}|${row.related_item_id}`));
      for (const [itemId, list] of ordered) {
        const room = MAX_LINKS - (manualCounts.get(itemId) || 0);
        const fresh = list.filter((link) => !manualPairs.has(`${itemId}|${link.relatedId}`)).slice(0, Math.max(0, room));
        fresh.forEach((link, index) => {
          prepare("INSERT INTO item_related (id, tenant_id, item_id, related_item_id, position, source, reason, evidence, created_at) VALUES (?, ?, ?, ?, ?, 'ai', ?, ?, ?)")
            .run(crypto.randomUUID(), tenantId, itemId, link.relatedId, 100 + index, link.reason.slice(0, 500), JSON.stringify(link.evidence), currentTimestamp());
        });
        if (fresh.length) { itemCount += 1; linkCount += fresh.length; }
      }
    });
    const withoutSpecs = Number(prepare("SELECT COUNT(*) AS n FROM stock_items i WHERE i.tenant_id = ? AND i.parent_id IS NULL AND i.archived = 0 AND NOT EXISTS (SELECT 1 FROM item_specs s WHERE s.tenant_id = i.tenant_id AND s.item_id = i.id AND s.status = 'gevonden')").get(tenantId).n);
    return { items: itemCount, links: linkCount, withSpecs: items.length, withoutSpecs };
  }

  /**
   * Berekent "vaak samen besteld" opnieuw uit de verzonden bestellingen en vervangt de oude uitkomst.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ items: number, pairs: number }} Aantal artikelen met partners en aantal paren.
   */
  function refreshTogether(tenantId) {
    const since = new Date(); since.setMonth(since.getMonth() - TOGETHER_MONTHS);
    const rows = prepare(`SELECT l.order_id, l.kind, l.sold_at, COALESCE(i.parent_id, i.id) AS main_id FROM web_sale_lines l
      JOIN stock_items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
      WHERE l.tenant_id = ? AND l.order_id IS NOT NULL AND l.sold_at >= ? ORDER BY l.sold_at DESC, l.order_id LIMIT ${MAX_SALE_LINES}`).all(tenantId, since.toISOString());
    // Ook de orderhistorie uit de oude WordPress-webshop (wp_order_lines, alleen gekoppelde regels) telt mee; haar bestelnummers krijgen een voorvoegsel.
    const wpRows = prepare(`SELECT l.wp_order_id, l.ordered_at, COALESCE(i.parent_id, i.id) AS main_id FROM wp_order_lines l
      JOIN stock_items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
      WHERE l.tenant_id = ? AND l.ordered_at >= ? ORDER BY l.ordered_at DESC, l.wp_order_id LIMIT ${MAX_SALE_LINES}`).all(tenantId, since.toISOString())
      .map((row) => ({ order_id: `wp:${row.wp_order_id}`, kind: 'verkoop', main_id: row.main_id, sold_at: new Date(row.ordered_at).toISOString() }));
    const combined = wpRows.length
      ? [...rows.map((row) => ({ ...row, sold_at: String(row.sold_at) })), ...wpRows]
        .sort((left, right) => (left.sold_at < right.sold_at ? 1 : left.sold_at > right.sold_at ? -1 : String(left.order_id) < String(right.order_id) ? -1 : 1)).slice(0, MAX_SALE_LINES)
      : rows;
    // Is er afgekapt, dan blijft de nieuwste periode over en gaat de laatste (mogelijk halve) bestelling niet mee: alle regels van die bestelling gaan eruit (ook de retourregels, die een eigen datum hebben): een bestelling zit er heel in of helemaal niet.
    let usedRows = combined;
    if (combined.length >= MAX_SALE_LINES) {
      const cutOrder = String(combined[combined.length - 1].order_id);
      usedRows = combined.filter((row) => String(row.order_id) !== cutOrder);
    }
    const lines = usedRows.map((row) => ({ orderId: String(row.order_id), itemId: String(row.main_id), kind: row.kind }));
    const result = computeTogether(lines);
    let pairs = 0;
    transaction(db, () => {
      prepare('DELETE FROM item_together WHERE tenant_id = ?').run(tenantId);
      const now = currentTimestamp();
      for (const [itemId, list] of result) {
        for (const entry of list) {
          prepare('INSERT INTO item_together (tenant_id, item_id, other_id, orders_both, orders_item, orders_other, lift, score, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(tenantId, itemId, entry.otherId, entry.both, entry.item, entry.other, entry.lift, entry.score, now);
          pairs += 1;
        }
      }
    });
    return { items: result.size, pairs };
  }

  const SHOP_FITS_SQL = `SELECT a.code AS item_code, b.code AS related_code FROM item_related r
      JOIN stock_items a ON a.tenant_id = r.tenant_id AND a.id = r.item_id JOIN stock_items b ON b.tenant_id = r.tenant_id AND b.id = r.related_item_id
      WHERE r.tenant_id = ? AND a.archived = 0 AND b.archived = 0 ORDER BY r.item_id, r.position`;
  const SHOP_TOGETHER_SQL = `SELECT a.code AS item_code, b.code AS related_code FROM item_together t
      JOIN stock_items a ON a.tenant_id = t.tenant_id AND a.id = t.item_id JOIN stock_items b ON b.tenant_id = t.tenant_id AND b.id = t.other_id
      WHERE t.tenant_id = ? AND a.archived = 0 AND b.archived = 0 ORDER BY t.item_id, t.score DESC`;

  /**
   * Zet de rijen voor de webshop om naar een lijst per artikelcode.
   * @param {object[]} fitRows Rijen van Past bij.
   * @param {object[]} togetherRows Rijen van Vaak samen besteld.
   * @returns {Map<string, { fits: string[], together: string[] }>} Per code.
   */
  function shapeShop(fitRows, togetherRows) {
    const result = new Map();
    /**
     * De lijst van een artikelcode (aangemaakt als hij er nog niet is).
     * @param {string} code Artikelcode.
     * @returns {{ fits: string[], together: string[] }} De lijsten van dit artikel.
     */
    const entryOf = (code) => { if (!result.has(code)) result.set(code, { fits: [], together: [] }); return result.get(code); };
    for (const row of fitRows) entryOf(row.item_code).fits.push(row.related_code);
    for (const row of togetherRows) entryOf(row.item_code).together.push(row.related_code);
    return result;
  }

  /**
   * De gerelateerde artikelen voor de webshop: per hoofdartikel (code) de codes van Past bij en Vaak samen besteld, in volgorde. De webshop filtert zelf op wat
   * zichtbaar en leverbaar is. Twee queries.
   * @param {string} tenantId Id van de omgeving.
   * @returns {Map<string, { fits: string[], together: string[] }>} Per code.
   */
  const forShop = (tenantId) => shapeShop(prepare(SHOP_FITS_SQL).all(tenantId), prepare(SHOP_TOGETHER_SQL).all(tenantId));

  /**
   * Zelfde als forShop, maar via de databasepool (zonder de hoofdthread te blokkeren), om de cache van de webshop vooraf te vullen.
   * @param {string} tenantId Id van de omgeving.
   * @returns {Promise<Map<string, { fits: string[], together: string[] }>>} Per code.
   */
  const forShopAsync = async (tenantId) => shapeShop(...(await Promise.all([db.async.all(SHOP_FITS_SQL, tenantId), db.async.all(SHOP_TOGETHER_SQL, tenantId)])));

  return { detail, list, setManual, removeLink, clearAi, researchTodo, factsFor, saveSpecs, linkWithSpecs, refreshTogether, forShop, forShopAsync };
}

module.exports = { createRelatedStore, computeTogether, MAX_LINKS, RESEARCH_BATCH, RESEARCH_CONCURRENCY, MAX_RESEARCH };
