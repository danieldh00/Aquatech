// Voorraadbeheer: artikelen op voorraad, het logboek van mutaties en de
// reserveringen per werkorder (tabellen stock_items, stock_movements,
// stock_reservations, migratie 23). Alles per omgeving (req.tenantId).
//
// - Een voorraadartikel heeft een artikelcode; dezelfde codes als de
//   catalogus van de planner (frontend/beregening/js/catalog.js), de stuklijst,
//   de offerte en de materiaallijst van de werkorder. Zo is de koppeling met
//   stuklijsten en werkorders gewoon de code (hoofdletterongevoelig).
// - De stand (on_hand) wordt bij elke mutatie bijgewerkt; het logboek bewaart
//   per mutatie de wijziging en de stand erna (balance).
// - Reserveren: zolang een werkorder Nieuw, Gepland of In uitvoering is,
//   staat per voorraadartikel uit de materiaallijst het nog niet afgeboekte
//   deel gereserveerd (benodigd − afgeboekt). Dat wordt opnieuw berekend na
//   elke wijziging van de werkorder (onWorkOrderChange); beschikbaar = stand −
//   gereserveerd.
// - Afboeken: handmatig vanuit de werkorder (issue), via het geregistreerde
//   materiaalverbruik van de installateur (syncUsage, idempotent per
//   verbruiksregel) of vanzelf als de werkorder Gereed wordt: dan wordt wat
//   nog gereserveerd staat afgeboekt, tenzij er verbruik is geregistreerd (dat
//   is dan de werkelijkheid en de rest van de reservering vervalt).
// - Verkoop (migratie 26): een artikel heeft een verkoopprijs (excl. btw),
//   btw-tarief en omzetgroep (voor de facturen en de Visma-export). Aquatech
//   is de bron: prijs en voorraad gaan naar de webshop (shop-sync.js). Elke
//   wijziging van prijs of stand zet shop_dirty, onDirty start dan het
//   terugschrijven.
// - Bestelvoorstel (migratie 30): artikelen waarvan beschikbaar onder het
//   minimum zakt, met het aantal om aan te vullen tot reorder_qty ("bestellen
//   tot"; leeg = 2× minimum), afgerond naar boven op hele eenheden.
// - Varianten (migratie 33): een hoofdartikel (has_variants) heeft kenmerken
//   (bijv. Maat: 16 mm, 20 mm) en zelf geen voorraad; elke combinatie is een
//   variant: een gewoon voorraadartikel met eigen code, prijs, kostprijs,
//   voorraad, minimum en bestelniveau (parent_id + variant_values). Werkorders,
//   offertes en facturen gebruiken de code van de variant; staat de code van
//   een hoofdartikel op een werkorder, dan moet er eerst een maat gekozen
//   worden (forWorkOrder: chooseVariant). Eenheid, btw en omzetgroep volgen het
//   hoofdartikel.
const crypto = require('crypto');
const { transaction } = require('../database/db');
const { loadArticles } = require('../webshop/shop');

const KINDS = { ontvangst: 'Ontvangst', afboeking: 'Afboeking', retour: 'Retour', correctie: 'Correctie', telling: 'Telling' };
// Mutaties die een beheerder op het artikel zelf doet (de rest hoort bij een werkorder).
const MANUAL = ['ontvangst', 'correctie', 'telling'];
const OPEN = ['open', 'gepland', 'bezig'];
const MAX_QTY = 1e6;
const LIST_LIMIT = 200;
// Omzetgroepen: samen met het btw-tarief de omzetcategorie op de factuur en
// in de export naar de boekhouding (invoices.js).
const GROUPS = { producten: 'Producten', arbeid: 'Arbeid', overig: 'Overig' };
const VAT_RATES = [21, 9, 0];
const EXPORT_LIMIT = 10000;
/** Hoogstens zoveel id's per IN (...) bij bulkwijzigingen (ruim onder de parameterlimiet). */
const BATCH = 500;

/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * Rondt een aantal af op drie decimalen (leeg of ongeldig = 0).
 * @param {*} value Het aantal.
 * @returns {number} Het afgeronde aantal.
 */
const round3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;
/**
 * Maakt een artikelcode vergelijkbaar: getrimd en in hoofdletters.
 * @param {*} value De code.
 * @returns {string} De genormaliseerde code.
 */
const normalizeCode = (value) => String(value ?? '').trim().toUpperCase();
/**
 * De voorraadcode van een webshopproduct: aquatech_code, anders de sku, anders
 * WC-<product-id> (zodat ook producten zonder sku mee kunnen).
 * @param {{ id: *, code?: string, sku?: string }} product Het webshopproduct.
 * @returns {string} De code in hoofdletters.
 */
const shopCodeOf = (product) => normalizeCode(product.code) || normalizeCode(product.sku) || `WC-${String(product.id).trim()}`;

/**
 * Maakt van een waarde nette tekst zonder stuurtekens, getrimd en ingekort.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximaal aantal tekens.
 * @returns {string} De tekst.
 */
const cleanText = (value, maxLength) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
/**
 * Is de waarde een datum als JJJJ-MM-DD?
 * @param {*} value De invoer.
 * @returns {boolean} true als het een datum is.
 */
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
/**
 * Telt de aantallen van rijen op.
 * @param {{ qty: number }[]} rows De rijen.
 * @returns {number} Het totaal.
 */
const sumQty = (rows) => rows.reduce((sum, row) => sum + row.qty, 0);
/** Eenheden die een nieuwe omgeving meekrijgt. */
const DEFAULT_UNITS = ['st', 'm', 'm²', 'rol', 'set', 'zak', 'kg', 'l', 'uur'];
/** Hoogstens zoveel kenmerken per hoofdartikel, waarden per kenmerk en varianten. */
const MAX_ATTRIBUTES = 3;
const MAX_VALUES = 30;
const MAX_VARIANTS = 200;

/**
 * Leest JSON uit een tekstkolom.
 * @param {string} text De opgeslagen tekst.
 * @param {*} fallback Wat terugkomt bij lege of ongeldige tekst.
 * @returns {*} De gelezen waarde.
 */
function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/**
 * Schoont de kenmerken van een hoofdartikel op: hooguit drie kenmerken met
 * een naam en een of meer unieke waarden.
 * @param {*} raw De invoer: [{ name, values }] (values als lijst of tekst met komma's).
 * @returns {{ value?: { name: string, values: string[] }[], error?: string, field?: string }} De kenmerken, of een fout.
 */
function sanitizeAttributes(raw) {
  if (!Array.isArray(raw)) return { error: 'Geef de kenmerken op (bijv. Maat met de waarden 16 mm, 20 mm).', field: 'attributes' };
  const out = [];
  const names = new Set();
  for (const entry of raw) {
    const name = cleanText(entry && entry.name, 40);
    const rawValues = Array.isArray(entry && entry.values) ? entry.values : String((entry && entry.values) ?? '').split(',');
    const values = [];
    const seen = new Set();
    for (const rawValue of rawValues) {
      const value = cleanText(rawValue, 40);
      if (!value || seen.has(value.toLowerCase())) continue;
      seen.add(value.toLowerCase());
      values.push(value);
    }
    if (!name && !values.length) continue;
    if (!name) return { error: 'Geef elk kenmerk een naam (bijv. Maat of Kleur).', field: 'attributes' };
    if (names.has(name.toLowerCase())) return { error: `Het kenmerk ${name} staat er twee keer in.`, field: 'attributes' };
    if (!values.length) return { error: `Geef het kenmerk ${name} een of meer waarden.`, field: 'attributes' };
    if (values.length > MAX_VALUES) return { error: `Hooguit ${MAX_VALUES} waarden per kenmerk.`, field: 'attributes' };
    names.add(name.toLowerCase());
    out.push({ name, values });
  }
  if (out.length > MAX_ATTRIBUTES) return { error: `Hooguit ${MAX_ATTRIBUTES} kenmerken per artikel.`, field: 'attributes' };
  if (out.reduce((total, attribute) => total * attribute.values.length, out.length ? 1 : 0) > MAX_VARIANTS) return { error: `Dat worden meer dan ${MAX_VARIANTS} varianten.`, field: 'attributes' };
  return { value: out };
}

/**
 * Alle combinaties van de waarden van de kenmerken.
 * @param {{ name: string, values: string[] }[]} attributes De kenmerken.
 * @returns {Object<string, string>[]} Per combinatie de waarde per kenmerk.
 */
function combinations(attributes) {
  return attributes.reduce((partial, attribute) => partial.flatMap((combination) => attribute.values.map((value) => ({ ...combination, [attribute.name]: value }))), attributes.length ? [{}] : []);
}

/**
 * De kenmerken van een variabel webshopproduct (alleen die voor variaties) in
 * het formaat van het hoofdartikel.
 * @param {{ attributes?: { name: string, options?: string[], variation?: boolean }[] }} product Het webshopproduct.
 * @returns {{ name: string, values: string[] }[]} De kenmerken.
 */
function shopAttributesOf(product) {
  const raw = (product.attributes || []).filter((attribute) => attribute && attribute.variation !== false && Array.isArray(attribute.options))
    .map((attribute) => ({ name: attribute.name, values: attribute.options.slice(0, MAX_VALUES) }));
  const checked = sanitizeAttributes(raw.slice(0, MAX_ATTRIBUTES));
  return checked.error ? [] : checked.value;
}

/**
 * Voegt de waarden van kenmerken uit de webshop toe aan die van het hoofdartikel (niets valt weg).
 * @param {{ name: string, values: string[] }[]} current De kenmerken in Aquatech.
 * @param {{ name: string, values: string[] }[]} incoming De kenmerken uit de webshop.
 * @returns {{ name: string, values: string[] }[]} De samengevoegde kenmerken.
 */
function mergeAttributes(current, incoming) {
  const out = current.map((attribute) => ({ name: attribute.name, values: [...attribute.values] }));
  for (const attribute of incoming) {
    const found = out.find((existing) => existing.name.toLowerCase() === attribute.name.toLowerCase());
    if (!found) {
      if (out.length < MAX_ATTRIBUTES) out.push({ name: attribute.name, values: [...attribute.values] });
      continue;
    }
    for (const value of attribute.values) {
      if (found.values.length < MAX_VALUES && !found.values.some((known) => known.toLowerCase() === value.toLowerCase())) found.values.push(value);
    }
  }
  return out;
}

/**
 * Een vaste sleutel voor de waarden van een variant (hoofdletterongevoelig, op naam van het kenmerk).
 * @param {Object<string, string>} values Waarde per kenmerk.
 * @returns {string} De sleutel.
 */
function valuesKey(values) {
  return Object.entries(values || {}).map(([name, value]) => `${String(name).toLowerCase()}=${String(value).toLowerCase()}`).sort().join('|');
}

/**
 * Een stukje artikelcode uit een waarde: hoofdletters, cijfers en . / +, zonder accenten.
 * @param {string} value De waarde, bijv. '16 mm'.
 * @returns {string} Bijv. '16MM'.
 */
const codePart = (value) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9./+]/g, '') || 'X';

/**
 * De omschrijving van een variant: hoofdartikel met de waarden erachter.
 * @param {string} parentName Omschrijving van het hoofdartikel.
 * @param {Object<string, string>} values Waarde per kenmerk.
 * @returns {string} Bijv. 'PE-buis 16 mm'.
 */
const variantName = (parentName, values) => cleanText(`${parentName} ${Object.values(values).join(' / ')}`, 200);

/**
 * Vraagtekens voor een SQL IN (...)-lijst.
 * @param {number} count Aantal waarden.
 * @returns {string} Bijv. "?,?,?".
 */
const placeholders = (count) => Array.from({ length: count }, () => '?').join(',');

/**
 * Schoont een voorraadartikel op.
 * @param {object} raw De invoer.
 * @param {{ partial?: boolean }} [options] partial: alleen de meegestuurde velden (wijzigen).
 * @returns {{ value?: object, error?: string, field?: string }} De opgeschoonde velden, of een fout met het veld.
 */
function sanitizeItem(raw, { partial = false } = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  if (!partial || input.code !== undefined) {
    const code = normalizeCode(input.code);
    if (!code) return { error: 'Vul een artikelcode in.', field: 'code' };
    if (code.length > 40 || !/^[A-Z0-9][A-Z0-9 ._\-/+]*$/.test(code)) return { error: 'Een artikelcode bestaat uit letters, cijfers en - . _ / + (max. 40 tekens).', field: 'code' };
    out.code = code;
  }
  if (!partial || input.name !== undefined) {
    const name = cleanText(input.name, 200);
    if (!name) return { error: 'Vul een omschrijving in.', field: 'name' };
    out.name = name;
  }
  if (!partial || input.unit !== undefined) out.unit = cleanText(input.unit, 12) || 'st';
  if (!partial || input.location !== undefined) out.location = cleanText(input.location, 60);
  if (!partial || input.notes !== undefined) out.notes = cleanText(input.notes, 1000);
  if (!partial || input.minQty !== undefined) {
    const minQty = input.minQty === '' || input.minQty == null ? 0 : Number(input.minQty);
    if (!Number.isFinite(minQty) || minQty < 0 || minQty > MAX_QTY) return { error: 'Ongeldige minimumvoorraad.', field: 'minQty' };
    out.minQty = round3(minQty);
  }
  if (!partial || input.reorderQty !== undefined) {
    const reorderQty = input.reorderQty === '' || input.reorderQty == null ? null : Number(input.reorderQty);
    if (reorderQty !== null && (!Number.isFinite(reorderQty) || reorderQty < 0 || reorderQty > MAX_QTY)) return { error: 'Ongeldig aantal bij Bestellen tot.', field: 'reorderQty' };
    out.reorderQty = reorderQty === null ? null : round3(reorderQty);
  }
  if (!partial || input.costPrice !== undefined) {
    const costPrice = input.costPrice === '' || input.costPrice == null ? null : Number(input.costPrice);
    if (costPrice !== null && (!Number.isFinite(costPrice) || costPrice < 0 || costPrice > MAX_QTY)) return { error: 'Ongeldige inkoopprijs.', field: 'costPrice' };
    out.costPrice = costPrice === null ? null : Math.round(costPrice * 100) / 100;
  }
  if (!partial || input.salePrice !== undefined) {
    const salePrice = input.salePrice === '' || input.salePrice == null ? null : Number(input.salePrice);
    if (salePrice !== null && (!Number.isFinite(salePrice) || salePrice < 0 || salePrice > MAX_QTY)) return { error: 'Ongeldige verkoopprijs.', field: 'salePrice' };
    out.salePrice = salePrice === null ? null : Math.round(salePrice * 100) / 100;
  }
  if (!partial || input.vatRate !== undefined) {
    const vatRate = input.vatRate === undefined || input.vatRate === '' || input.vatRate === null ? 21 : Number(input.vatRate);
    if (!VAT_RATES.includes(vatRate)) return { error: 'Kies een btw-tarief van 21, 9 of 0%.', field: 'vatRate' };
    out.vatRate = vatRate;
  }
  if (!partial || input.revenueGroup !== undefined) {
    const group = input.revenueGroup === undefined || input.revenueGroup === '' ? 'producten' : String(input.revenueGroup);
    if (!GROUPS[group]) return { error: 'Onbekende omzetgroep.', field: 'revenueGroup' };
    out.revenueGroup = group;
  }
  if (!partial || input.shopSync !== undefined) out.shopSync = input.shopSync !== false;
  return { value: out };
}

/**
 * Benodigd per artikelcode uit de materiaallijst van een werkorder.
 * @param {object[]} materials De materiaallijst (code, qty, description, unit).
 * @returns {Map<string, { qty: number, description: string, unit: string }>} Per genormaliseerde code het totaal.
 */
function needsOf(materials) {
  const need = new Map();
  for (const material of Array.isArray(materials) ? materials : []) {
    const code = normalizeCode(material && material.code);
    const qty = Number(material && material.qty);
    if (!code || !(qty > 0)) continue;
    const total = need.get(code) || { qty: 0, description: '', unit: '' };
    total.qty = round3(total.qty + qty);
    total.description = total.description || cleanText(material.description, 200);
    total.unit = total.unit || cleanText(material.unit, 12);
    need.set(code, total);
  }
  return need;
}

/**
 * Maakt de opslag voor voorraadartikelen, mutaties en reserveringen.
 * @param {object} db De database.
 * @param {{ articles?: Function, onDirty?: Function }} [options] Catalogus van de planner; aanroep na een wijziging voor de webshop.
 * @returns {object} list, get, create, update, remove, move, setVariants, articleChoices, importCatalog, importShop, mirrorShop, movements, reservations, syncWorkOrder, resyncOpen, complete, onWorkOrderChange, forWorkOrder, issue, syncUsage, book, saleInfo, findCode, reorderProposal en onDirty.
 */
function createStockStore(db, { articles = loadArticles, onDirty = null } = {}) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  // Webshop: na een wijziging van prijs of stand (shop-sync.js meldt zich aan via onDirty()).
  let dirtyHook = onDirty;
  /**
   * Webshop: meldt een wijziging van prijs of stand (shop-sync.js meldt zich aan via onDirty()).
   * @param {string} tenantId Id van de omgeving.
   * @returns {void}
   */
  const dirty = (tenantId) => { if (dirtyHook) dirtyHook(tenantId); };
  const SALE_COLS = 'sale_price, vat_rate, revenue_group, shop_sync, shop_product_id, shop_dirty, shop_synced_at, shop_error';
  const VARIANT_COLS = 'parent_id, has_variants, attributes, variant_values';
  const ITEM_COLS = `id, code, name, unit, location, min_qty, reorder_qty, on_hand, cost_price, notes, archived, created_at, updated_at, ${SALE_COLS}, ${VARIANT_COLS}`;
  const MOVE_COLS = 'm.id, m.item_id, m.kind, m.qty, m.balance, m.work_order_id, m.work_order_number, m.source, m.note, m.user_name, m.created_at';

  /**
   * Zet een artikelrij om naar het formaat van de API.
   * @param {object} itemRow Rij met ITEM_COLS.
   * @param {number} [reserved] Gereserveerd aantal.
   * @param {number} [orders] Aantal werkorders met een reservering.
   * @returns {object} Het artikel met stand, beschikbaar en webshopstatus.
   */
  const shapeItem = (itemRow, reserved = 0, orders = 0) => {
    const onHand = round3(itemRow.on_hand);
    const reservedQty = round3(reserved);
    return {
      id: itemRow.id, code: itemRow.code, name: itemRow.name, unit: itemRow.unit, location: itemRow.location, minQty: round3(itemRow.min_qty),
      reorderQty: itemRow.reorder_qty == null ? null : round3(itemRow.reorder_qty), onHand,
      reserved: reservedQty, available: round3(onHand - reservedQty), orders: Number(orders) || 0,
      costPrice: itemRow.cost_price == null ? null : Number(itemRow.cost_price),
      value: itemRow.cost_price == null ? null : Math.round(onHand * itemRow.cost_price * 100) / 100,
      low: itemRow.min_qty > 0 && onHand - reservedQty < itemRow.min_qty, notes: itemRow.notes, archived: Boolean(itemRow.archived),
      salePrice: itemRow.sale_price == null ? null : Number(itemRow.sale_price), vatRate: Number(itemRow.vat_rate ?? 21), revenueGroup: itemRow.revenue_group || 'producten',
      shopSync: itemRow.shop_sync === undefined ? true : Boolean(Number(itemRow.shop_sync)),
      shop: { productId: itemRow.shop_product_id || null, pending: Boolean(Number(itemRow.shop_dirty)), syncedAt: itemRow.shop_synced_at || null, error: itemRow.shop_error || '' },
      parentId: itemRow.parent_id || null, hasVariants: Boolean(Number(itemRow.has_variants)),
      attributes: Number(itemRow.has_variants) ? parseJson(itemRow.attributes, []) : [],
      values: itemRow.parent_id ? parseJson(itemRow.variant_values, {}) : null,
      createdAt: itemRow.created_at, updatedAt: itemRow.updated_at,
    };
  };
  /**
   * Telt bij een hoofdartikel de varianten op: stand, gereserveerd,
   * beschikbaar, werkorders en waarde; onder het minimum als een variant dat is.
   * @param {object} parent Het hoofdartikel (shapeItem).
   * @param {object[]} variants Zijn varianten (shapeItem), zonder de gearchiveerde.
   * @returns {object} Het hoofdartikel met de totalen en variantCount.
   */
  const withTotals = (parent, variants) => {
    /**
     * Telt een veld van alle varianten op.
     * @param {string} key Het veld, bijv. 'onHand'.
     * @returns {number} Het totaal.
     */
    const total = (key) => round3(variants.reduce((sum, variant) => sum + (variant[key] || 0), 0));
    const values = variants.filter((variant) => variant.value != null);
    return {
      ...parent, onHand: total('onHand'), reserved: total('reserved'), available: total('available'),
      orders: variants.reduce((sum, variant) => sum + variant.orders, 0),
      value: values.length ? Math.round(values.reduce((sum, variant) => sum + variant.value, 0) * 100) / 100 : null,
      low: variants.some((variant) => variant.low), variantCount: variants.length,
    };
  };
  /**
   * Zet een mutatierij om naar het formaat van de API.
   * @param {object} movementRow Rij met MOVE_COLS (en eventueel code, name, unit).
   * @returns {object} De mutatie.
   */
  const shapeMove = (movementRow) => ({
    id: movementRow.id, itemId: movementRow.item_id, kind: movementRow.kind, qty: round3(movementRow.qty), balance: round3(movementRow.balance),
    workOrderId: movementRow.work_order_id || null, workOrderNumber: movementRow.work_order_number || '', source: movementRow.source || '',
    note: movementRow.note, userName: movementRow.user_name, createdAt: movementRow.created_at,
    ...(movementRow.code !== undefined ? { code: movementRow.code, name: movementRow.name, unit: movementRow.unit } : {}),
  });

  /**
   * Overzicht in één query: stand plus gereserveerd (som over open werkorders).
   * @param {string} tenantId Id van de omgeving.
   * @param {{ archived?: boolean }} [options] Ook gearchiveerde artikelen.
   * @returns {object[]} De artikelen, op code.
   */
  function list(tenantId, { archived = false } = {}) {
    const items = listRows(tenantId, { archived });
    const variantsOf = new Map();
    for (const item of items) {
      if (!item.parentId || item.archived) continue;
      if (!variantsOf.has(item.parentId)) variantsOf.set(item.parentId, []);
      variantsOf.get(item.parentId).push(item);
    }
    return items.map((item) => (item.hasVariants ? withTotals(item, variantsOf.get(item.id) || []) : item));
  }

  /**
   * Artikelrijen met het gereserveerde aantal (som over open werkorders), in één query.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ archived?: boolean, parentId?: string|null }} [filters] Ook gearchiveerde; alleen de varianten van dit hoofdartikel.
   * @returns {object[]} De artikelen (shapeItem), op code.
   */
  function listRows(tenantId, { archived = false, parentId = null } = {}) {
    const args = [tenantId, tenantId];
    let where = archived ? '' : ' AND i.archived = 0';
    if (parentId) { where += ' AND i.parent_id = ?'; args.push(String(parentId)); }
    return prepare(`SELECT i.id, i.code, i.name, i.unit, i.location, i.min_qty, i.reorder_qty, i.on_hand, i.cost_price, i.notes, i.archived, i.created_at, i.updated_at,
        i.sale_price, i.vat_rate, i.revenue_group, i.shop_sync, i.shop_product_id, i.shop_dirty, i.shop_synced_at, i.shop_error,
        i.parent_id, i.has_variants, i.attributes, i.variant_values,
        COALESCE(r.qty, 0) AS reserved, COALESCE(r.orders, 0) AS orders
      FROM stock_items i
      LEFT JOIN (SELECT item_id, SUM(qty) AS qty, COUNT(*) AS orders FROM stock_reservations WHERE tenant_id = ? GROUP BY item_id) r ON r.item_id = i.id
      WHERE i.tenant_id = ?${where} ORDER BY i.code`)
      .all(...args).map((itemRow) => shapeItem(itemRow, itemRow.reserved, itemRow.orders));
  }

  /**
   * Zoekt een artikel op id.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van het artikel.
   * @returns {object|undefined} De rij.
   */
  const findItem = (tenantId, id) => prepare(`SELECT ${ITEM_COLS} FROM stock_items WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));
  /**
   * Zoekt een artikel op code (hoofdletterongevoelig).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} code De artikelcode.
   * @returns {object|undefined} De rij.
   */
  const findCode = (tenantId, code) => prepare(`SELECT ${ITEM_COLS} FROM stock_items WHERE tenant_id = ? AND code = ?`).get(tenantId, normalizeCode(code));

  /**
   * Reserveringen met de werkorder erbij (nummer, titel, status, datum).
   * @param {string} tenantId Id van de omgeving.
   * @param {string|null} [itemId] Alleen van dit artikel.
   * @returns {object[]} De reserveringen.
   */
  function reservationsOf(tenantId, itemId = null) {
    const args = [tenantId];
    let sql = `SELECT r.item_id, r.work_order_id, r.qty, r.updated_at, w.number, w.title, w.customer, w.status, w.planned_date,
        i.code, i.name, i.unit
      FROM stock_reservations r JOIN stock_items i ON i.id = r.item_id
      LEFT JOIN work_orders w ON w.id = r.work_order_id AND w.tenant_id = r.tenant_id
      WHERE r.tenant_id = ?`;
    if (itemId) { sql += ' AND r.item_id = ?'; args.push(String(itemId)); }
    return prepare(`${sql} ORDER BY w.planned_date, w.number`).all(...args).map((reservationRow) => ({
      itemId: reservationRow.item_id, code: reservationRow.code, name: reservationRow.name, unit: reservationRow.unit, qty: round3(reservationRow.qty), updatedAt: reservationRow.updated_at,
      workOrder: { id: reservationRow.work_order_id, number: reservationRow.number || '', title: reservationRow.title || '', customer: reservationRow.customer || '', status: reservationRow.status || '', plannedDate: reservationRow.planned_date || '' },
    }));
  }

  /**
   * Eén artikel met reserveringen en de laatste mutaties.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van het artikel.
   * @returns {object|null} Het artikel, of null.
   */
  function get(tenantId, id) {
    const itemRow = findItem(tenantId, id);
    if (!itemRow) return null;
    if (Number(itemRow.has_variants)) {
      // Hoofdartikel: geen eigen voorraad, wel de varianten met hun totalen.
      const variants = listRows(tenantId, { archived: true, parentId: itemRow.id });
      const parent = withTotals(shapeItem(itemRow), variants.filter((variant) => !variant.archived));
      return { ...parent, variants, reservations: [], movements: [] };
    }
    const reservations = reservationsOf(tenantId, itemRow.id);
    const item = shapeItem(itemRow, reservations.reduce((sum, reservation) => sum + reservation.qty, 0), reservations.length);
    const movements = prepare(`SELECT ${MOVE_COLS} FROM stock_movements m WHERE m.tenant_id = ? AND m.item_id = ? ORDER BY m.created_at DESC, m.id LIMIT ${LIST_LIMIT}`)
      .all(tenantId, itemRow.id).map(shapeMove);
    const parentRow = itemRow.parent_id ? prepare('SELECT id, code, name, attributes, archived FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, itemRow.parent_id) : null;
    const parent = parentRow ? { id: parentRow.id, code: parentRow.code, name: parentRow.name, attributes: parseJson(parentRow.attributes, []), archived: Boolean(parentRow.archived) } : null;
    return { ...item, parent, reservations, movements };
  }

  /**
   * Een mutatie boeken: stand bijwerken en het logboek aanvullen. Binnen de
   * transactie van de aanroeper.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {number} delta Wijziging van de stand (negatief = eraf).
   * @param {{ kind: string, workOrder?: object, source?: string, note?: string, user?: object, at?: string }} details Soort, werkorder, bron, opmerking, gebruiker en tijdstip.
   * @returns {string} Id van de mutatie.
   */
  function book(tenantId, itemId, delta, { kind, workOrder = null, source = '', note = '', user = null, at = currentTimestamp() }) {
    // Een verkoop in de webshop zelf (source 'webshop') hoeft niet terug.
    const toShop = source === 'webshop' ? 0 : 1;
    prepare(`UPDATE stock_items SET on_hand = on_hand + ?, updated_at = ?,
      shop_dirty = CASE WHEN shop_product_id IS NOT NULL AND shop_sync = 1 AND ? = 1 THEN 1 ELSE shop_dirty END
      WHERE tenant_id = ? AND id = ?`).run(round3(delta), at, toShop, tenantId, itemId);
    if (toShop) dirty(tenantId);
    const balance = prepare('SELECT on_hand FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, itemId).on_hand;
    const id = crypto.randomUUID();
    prepare(`INSERT INTO stock_movements (id, tenant_id, item_id, kind, qty, balance, work_order_id, work_order_number, source, note, user_id, user_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, itemId, kind, round3(delta), round3(balance), workOrder ? workOrder.id : null, workOrder ? workOrder.number : '',
        source, cleanText(note, 300), user ? user.id : null, user ? cleanText(user.display_name || user.displayName, 120) : '', at);
    return id;
  }

  /**
   * Nieuw voorraadartikel (met eventueel een beginvoorraad in raw.onHand).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} user Wie het aanmaakt.
   * @param {object} raw De invoer.
   * @param {{ resync?: boolean }} [options] Open werkorders met deze code meteen laten reserveren.
   * @returns {object} { item }, of { error, field, status }.
   */
  function create(tenantId, user, raw, { resync = true } = {}) {
    const checked = sanitizeItem(raw);
    if (checked.error) return checked;
    const fields = checked.value;
    const out = transaction(db, () => {
      if (findCode(tenantId, fields.code)) return { error: 'Er is al een voorraadartikel met deze code.', field: 'code', status: 409 };
      rememberUnit(tenantId, fields.unit);
      const id = crypto.randomUUID();
      const timestamp = currentTimestamp();
      prepare(`INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, reorder_qty, on_hand, cost_price, notes, archived, created_at, updated_at,
           sale_price, vat_rate, revenue_group, shop_sync)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, fields.code, fields.name, fields.unit, fields.location, fields.minQty, fields.reorderQty, fields.costPrice, fields.notes, timestamp, timestamp, fields.salePrice, fields.vatRate, fields.revenueGroup, fields.shopSync ? 1 : 0);
      const start = Number(raw && raw.onHand);
      if (Number.isFinite(start) && start > 0 && start <= MAX_QTY) book(tenantId, id, start, { kind: 'ontvangst', note: 'Beginvoorraad', user });
      return { id };
    });
    if (out.error) return out;
    // Open werkorders met deze code reserveren meteen.
    if (resync) resyncOpen(tenantId, [fields.code]);
    return { item: get(tenantId, out.id) };
  }

  /**
   * Wijzigt een voorraadartikel. De code kan alleen veranderen zolang er niets op werkorders is geboekt.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van het artikel.
   * @param {object} raw De gewijzigde velden (en eventueel archived).
   * @returns {object} { item, toShop }, of { error, field, status }.
   */
  function update(tenantId, id, raw) {
    const checked = sanitizeItem(raw, { partial: true });
    if (checked.error) return checked;
    const fields = checked.value;
    const out = transaction(db, () => {
      const existing = findItem(tenantId, id);
      if (!existing) return { error: 'not_found', status: 404 };
      if (fields.code && fields.code !== existing.code) {
        // De code is de koppeling met werkorders en verbruik: alleen zolang er niets op geboekt is.
        if (findCode(tenantId, fields.code)) return { error: 'Er is al een voorraadartikel met deze code.', field: 'code', status: 409 };
        const used = prepare('SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = ? AND item_id = ? AND work_order_id IS NOT NULL) OR EXISTS (SELECT 1 FROM stock_reservations WHERE tenant_id = ? AND item_id = ?) AS n')
          .get(tenantId, existing.id, tenantId, existing.id).n;
        if (used) return { error: 'De code van een artikel dat al op werkorders is gereserveerd of afgeboekt, kan niet meer veranderen.', field: 'code', status: 409 };
      }
      if (fields.unit) rememberUnit(tenantId, fields.unit);
      const merged = {
        code: existing.code, name: existing.name, unit: existing.unit, location: existing.location, minQty: existing.min_qty, reorderQty: existing.reorder_qty, costPrice: existing.cost_price, notes: existing.notes,
        salePrice: existing.sale_price, vatRate: Number(existing.vat_rate), revenueGroup: existing.revenue_group, shopSync: Boolean(Number(existing.shop_sync)), ...fields,
      };
      const archived = raw && raw.archived !== undefined ? (raw.archived ? 1 : 0) : existing.archived;
      const isParent = Boolean(Number(existing.has_variants));
      if (!archived && existing.archived && existing.parent_id) {
        const parentRow = prepare('SELECT archived FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, existing.parent_id);
        if (parentRow && parentRow.archived) return { error: 'Zet eerst het hoofdartikel terug uit het archief.', status: 409 };
      }
      // Andere prijs of btw (of weer meesturen): opnieuw naar de webshop. Een
      // hoofdartikel heeft in de webshop geen eigen prijs of voorraad.
      const toShop = !isParent && ((merged.salePrice ?? null) !== (existing.sale_price ?? null) || merged.vatRate !== Number(existing.vat_rate) || (merged.shopSync && !Number(existing.shop_sync)));
      prepare(`UPDATE stock_items SET code = ?, name = ?, unit = ?, location = ?, min_qty = ?, reorder_qty = ?, cost_price = ?, notes = ?, archived = ?, archived_by_parent = 0, updated_at = ?,
           sale_price = ?, vat_rate = ?, revenue_group = ?, shop_sync = ?,
           shop_dirty = CASE WHEN ? = 1 AND shop_product_id IS NOT NULL THEN 1 ELSE shop_dirty END
         WHERE tenant_id = ? AND id = ?`)
        .run(merged.code, merged.name, merged.unit, merged.location, merged.minQty, merged.reorderQty ?? null, merged.costPrice, merged.notes, archived, currentTimestamp(), merged.salePrice, merged.vatRate, merged.revenueGroup, merged.shopSync ? 1 : 0,
          toShop && merged.shopSync ? 1 : 0, tenantId, existing.id);
      if (archived && !existing.archived) prepare('DELETE FROM stock_reservations WHERE tenant_id = ? AND item_id = ?').run(tenantId, existing.id);
      let variantsToShop = false;
      if (isParent) variantsToShop = followParent(tenantId, existing, merged, archived);
      return { item: get(tenantId, existing.id), toShop: toShop || variantsToShop };
    });
    if (out.toShop) dirty(tenantId);
    return out;
  }

  /**
   * Varianten volgen hun hoofdartikel: eenheid, btw en omzetgroep worden
   * gelijk, en archiveren of terugzetten geldt voor alle varianten. Binnen de
   * transactie van update.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} existing Het hoofdartikel zoals het was.
   * @param {object} merged De nieuwe velden van het hoofdartikel.
   * @param {number} archived 1 als het hoofdartikel nu gearchiveerd is.
   * @returns {boolean} true als gekoppelde varianten opnieuw naar de webshop moeten (ander btw-tarief).
   */
  function followParent(tenantId, existing, merged, archived) {
    const timestamp = currentTimestamp();
    const vatChanged = merged.vatRate !== Number(existing.vat_rate);
    prepare(`UPDATE stock_items SET unit = ?, vat_rate = ?, revenue_group = ?, updated_at = ?,
        shop_dirty = CASE WHEN ? = 1 AND shop_product_id IS NOT NULL AND shop_sync = 1 THEN 1 ELSE shop_dirty END
      WHERE tenant_id = ? AND parent_id = ?`).run(merged.unit, merged.vatRate, merged.revenueGroup, timestamp, vatChanged ? 1 : 0, tenantId, existing.id);
    if (archived && !existing.archived) {
      prepare('DELETE FROM stock_reservations WHERE tenant_id = ? AND item_id IN (SELECT id FROM stock_items WHERE tenant_id = ? AND parent_id = ?)').run(tenantId, tenantId, existing.id);
      prepare('UPDATE stock_items SET archived = 1, archived_by_parent = 1, updated_at = ? WHERE tenant_id = ? AND parent_id = ? AND archived = 0').run(timestamp, tenantId, existing.id);
    } else if (!archived && existing.archived) {
      // Alleen de varianten die met het hoofdartikel mee het archief in gingen; een los verwijderde variant blijft weg.
      const codes = prepare('SELECT code FROM stock_items WHERE tenant_id = ? AND parent_id = ? AND archived_by_parent = 1').all(tenantId, existing.id).map((row) => row.code);
      prepare('UPDATE stock_items SET archived = 0, archived_by_parent = 0, updated_at = ? WHERE tenant_id = ? AND parent_id = ? AND archived_by_parent = 1').run(timestamp, tenantId, existing.id);
      if (codes.length) resyncOpen(tenantId, codes, { nested: true });
    }
    return vatChanged;
  }

  /**
   * Verwijdert of archiveert één artikel binnen een lopende transactie: zonder
   * mutaties echt weg, anders gearchiveerd (het logboek blijft).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} row Het artikel (id).
   * @returns {boolean} true als het gearchiveerd is in plaats van verwijderd.
   */
  function removeRow(tenantId, row) {
    prepare('DELETE FROM stock_reservations WHERE tenant_id = ? AND item_id = ?').run(tenantId, row.id);
    const moved = prepare('SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = ? AND item_id = ?) AS n').get(tenantId, row.id).n;
    if (moved) {
      prepare('UPDATE stock_items SET archived = 1, archived_by_parent = 0, updated_at = ? WHERE tenant_id = ? AND id = ?').run(currentTimestamp(), tenantId, row.id);
      return true;
    }
    prepare('DELETE FROM stock_items WHERE tenant_id = ? AND id = ?').run(tenantId, row.id);
    return false;
  }

  /**
   * Verwijderen: zonder mutaties echt weg, anders gearchiveerd (het logboek
   * blijft). Een hoofdartikel neemt zijn varianten mee; het blijft zelf
   * (gearchiveerd) bestaan zolang er een gearchiveerde variant is.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van het artikel.
   * @returns {object|null} { deleted, code } of { archived, code }, of null.
   */
  function remove(tenantId, id) {
    return transaction(db, () => {
      const existing = findItem(tenantId, id);
      if (!existing) return null;
      let keepParent = false;
      if (Number(existing.has_variants)) {
        for (const variant of prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND parent_id = ?').all(tenantId, existing.id)) {
          if (removeRow(tenantId, variant)) keepParent = true;
        }
      }
      if (keepParent) {
        prepare('UPDATE stock_items SET archived = 1, updated_at = ? WHERE tenant_id = ? AND id = ?').run(currentTimestamp(), tenantId, existing.id);
        return { archived: true, code: existing.code };
      }
      return removeRow(tenantId, existing) ? { archived: true, code: existing.code } : { deleted: true, code: existing.code };
    });
  }

  /**
   * Maakt van een artikel een hoofdartikel met kenmerken en maakt de varianten
   * aan die nog ontbreken (elke combinatie van waarden; een gearchiveerde
   * variant met dezelfde waarden komt terug). Varianten krijgen de code van het
   * hoofdartikel met de waarden erachter (bijv. PE-BUIS-16MM) en nemen eenheid,
   * prijzen, btw, omzetgroep en webshopinstelling over. Een variant waarvan
   * een waarde is weggehaald gaat weg (met boekingen: gearchiveerd), net als
   * bij verwijderen. Kenmerken zonder varianten maken er weer een gewoon
   * artikel van.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van het artikel.
   * @param {*} rawAttributes De kenmerken: [{ name, values }].
   * @returns {object} { item, created, restored, removed }, of { error, field, status }.
   */
  function setVariants(tenantId, id, rawAttributes) {
    const checked = sanitizeAttributes(rawAttributes);
    if (checked.error) return checked;
    const attributes = checked.value;
    const out = transaction(db, () => {
      const existing = findItem(tenantId, id);
      if (!existing) return { error: 'not_found', status: 404 };
      if (existing.parent_id) return { error: 'Een variant kan zelf geen varianten hebben.', status: 409 };
      if (existing.archived) return { error: 'Dit artikel is gearchiveerd.', status: 409 };
      const variants = prepare('SELECT id, code, archived, variant_values FROM stock_items WHERE tenant_id = ? AND parent_id = ?').all(tenantId, existing.id);
      const live = variants.filter((variant) => !variant.archived);
      if (!Number(existing.has_variants)) {
        // Een gewoon artikel met voorraad of boekingen blijft dat: die voorraad hoort bij geen enkele maat.
        const used = Math.abs(Number(existing.on_hand)) > 0 || prepare('SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = ? AND item_id = ?) OR EXISTS (SELECT 1 FROM stock_reservations WHERE tenant_id = ? AND item_id = ?) AS n')
          .get(tenantId, existing.id, tenantId, existing.id).n;
        if (used && attributes.length) return { error: 'Dit artikel heeft al voorraad of boekingen. Maak een nieuw hoofdartikel en zet de varianten daaronder.', status: 409 };
      }
      const timestamp = currentTimestamp();
      if (!attributes.length) {
        if (live.length) return { error: 'Verwijder eerst de varianten; daarna kan dit weer een gewoon artikel worden.', field: 'attributes', status: 409 };
        prepare("UPDATE stock_items SET has_variants = 0, attributes = '', updated_at = ? WHERE tenant_id = ? AND id = ?").run(timestamp, tenantId, existing.id);
        return { created: [], restored: 0 };
      }
      const before = parseJson(existing.attributes, []).map((attribute) => attribute.name.toLowerCase()).join('|');
      if (live.length && before !== attributes.map((attribute) => attribute.name.toLowerCase()).join('|')) {
        return { error: 'Zolang er varianten zijn, kun je alleen waarden toevoegen of weghalen, niet de kenmerken zelf.', field: 'attributes', status: 409 };
      }
      const byKey = new Map(variants.map((variant) => [valuesKey(parseJson(variant.variant_values, {})), variant]));
      const taken = new Set(prepare('SELECT code FROM stock_items WHERE tenant_id = ?').all(tenantId).map((row) => row.code));
      const insert = prepare(`INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, on_hand, cost_price, notes, archived, created_at, updated_at,
          sale_price, vat_rate, revenue_group, shop_sync, parent_id, variant_values)
        VALUES (?, ?, ?, ?, ?, '', 0, 0, ?, '', 0, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const created = [];
      let restored = 0;
      let removed = 0;
      const wanted = combinations(attributes);
      const wantedKeys = new Set(wanted.map(valuesKey));
      // Een weggehaalde waarde: die varianten gaan weg (met boekingen: archief), net als bij verwijderen.
      for (const variant of live) {
        if (wantedKeys.has(valuesKey(parseJson(variant.variant_values, {})))) continue;
        removeRow(tenantId, variant);
        removed++;
      }
      for (const values of wanted) {
        const found = byKey.get(valuesKey(values));
        if (found) {
          if (found.archived) {
            prepare('UPDATE stock_items SET archived = 0, archived_by_parent = 0, updated_at = ? WHERE tenant_id = ? AND id = ?').run(timestamp, tenantId, found.id);
            created.push(found.code);
            restored++;
          }
          continue;
        }
        const base = `${existing.code}-${Object.values(values).map(codePart).join('-')}`.slice(0, 37).replace(/[-. /+]+$/, '');
        let code = base;
        for (let suffix = 2; taken.has(code); suffix++) code = `${base}-${suffix}`;
        taken.add(code);
        insert.run(crypto.randomUUID(), tenantId, code, variantName(existing.name, values), existing.unit, existing.cost_price, timestamp, timestamp,
          existing.sale_price, existing.vat_rate, existing.revenue_group, existing.shop_sync, existing.id, JSON.stringify(values));
        created.push(code);
      }
      // Een gekoppeld hoofdartikel: de nieuwe varianten komen bij de volgende ronde in de webshop.
      prepare(`UPDATE stock_items SET has_variants = 1, attributes = ?, updated_at = ?,
          shop_dirty = CASE WHEN ? = 1 AND shop_product_id IS NOT NULL AND shop_sync = 1 THEN 1 ELSE shop_dirty END
        WHERE tenant_id = ? AND id = ?`).run(JSON.stringify(attributes), timestamp, created.length ? 1 : 0, tenantId, existing.id);
      if (created.length) resyncOpen(tenantId, created, { nested: true });
      return { created, restored, removed, linked: Boolean(existing.shop_product_id && Number(existing.shop_sync)) };
    });
    if (out.error) return out;
    if (out.linked && out.created.length) dirty(tenantId);
    return { item: get(tenantId, id), created: out.created.length - out.restored, restored: out.restored, removed: out.removed };
  }

  /**
   * De artikellijst om uit te kiezen (werkorder, offerte): gewone artikelen en
   * hoofdartikelen met hun varianten, met verkoopprijs en beschikbaar aantal;
   * zonder inkoopprijs of andere interne velden. Gearchiveerde artikelen niet.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object[]} code, name, unit, salePrice, vatRate en available; een hoofdartikel ook attributes en variants (met values).
   */
  function articleChoices(tenantId) {
    const items = listRows(tenantId);
    /**
     * De velden van een artikel die de keuzelijst nodig heeft.
     * @param {object} item Het artikel (shapeItem).
     * @returns {object} code, name, unit, salePrice, vatRate en available.
     */
    const pick = (item) => ({ code: item.code, name: item.name, unit: item.unit, salePrice: item.salePrice, vatRate: item.vatRate, available: item.available });
    const parents = new Map(items.filter((item) => item.hasVariants).map((item) => [item.id, { ...pick(item), attributes: item.attributes, variants: [] }]));
    const out = [];
    for (const item of items) {
      if (item.hasVariants) out.push(parents.get(item.id));
      else if (item.parentId && parents.has(item.parentId)) parents.get(item.parentId).variants.push({ ...pick(item), values: item.values });
      else out.push(pick(item));
    }
    for (const parent of parents.values()) parent.available = round3(parent.variants.reduce((sum, variant) => sum + variant.available, 0));
    return out;
  }

  /**
   * Mutatie op het artikel: ontvangst (aantal > 0), correctie (+ of −) of
   * telling (het getelde aantal; de stand wordt dat).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} user Wie boekt.
   * @param {string} id Id van het artikel.
   * @param {{ kind: string, qty: number, note?: string }} raw De mutatie.
   * @returns {object} { movementId, delta, item }, of { error, field, status }.
   */
  function move(tenantId, user, id, raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const kind = input.kind;
    const qty = Number(input.qty);
    if (!MANUAL.includes(kind)) return { error: 'Kies ontvangst, correctie of telling.', field: 'kind' };
    if (!Number.isFinite(qty) || Math.abs(qty) > MAX_QTY) return { error: 'Vul een geldig aantal in.', field: 'qty' };
    if (kind === 'ontvangst' && !(qty > 0)) return { error: 'Een ontvangst is een aantal groter dan 0.', field: 'qty' };
    if (kind === 'correctie' && !qty) return { error: 'Een correctie is een aantal erbij (+) of eraf (−).', field: 'qty' };
    if (kind === 'telling' && qty < 0) return { error: 'Vul het getelde aantal in.', field: 'qty' };
    const note = cleanText(input.note, 300);
    if (kind === 'correctie' && note.length < 3) return { error: 'Geef bij een correctie de reden op.', field: 'note' };
    return transaction(db, () => {
      const existing = findItem(tenantId, id);
      if (!existing) return { error: 'not_found', status: 404 };
      if (existing.archived) return { error: 'Dit artikel is gearchiveerd.', status: 409 };
      if (Number(existing.has_variants)) return { error: 'Een hoofdartikel heeft zelf geen voorraad: boek op een variant.', status: 409 };
      const delta = kind === 'telling' ? round3(qty - existing.on_hand) : round3(qty);
      const movementId = book(tenantId, existing.id, delta, { kind, note: kind === 'telling' ? note || `Geteld: ${round3(qty)}` : note, user });
      return { movementId, delta, item: get(tenantId, existing.id) };
    });
  }

  /**
   * Artikelen uit de catalogus van de planner op voorraad nemen (codes die nog niet bestaan).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} user Wie het doet.
   * @param {string[]} codes De artikelcodes.
   * @returns {object} { created, existing }, of { error, field }.
   */
  function importCatalog(tenantId, user, codes) {
    const catalogArticles = articles();
    const wanted = [...new Set((Array.isArray(codes) ? codes : []).map(normalizeCode))].filter(Boolean).slice(0, 500);
    const byUpper = new Map(Object.keys(catalogArticles).map((key) => [normalizeCode(key), key]));
    const unknown = wanted.filter((code) => !byUpper.has(code));
    if (unknown.length) return { error: `Onbekende artikelcode: ${unknown.slice(0, 5).join(', ')}.`, field: 'codes' };
    const have = new Set(wanted.length ? prepare(`SELECT code FROM stock_items WHERE tenant_id = ? AND code IN (${placeholders(wanted.length)})`).all(tenantId, ...wanted).map((row) => row.code) : []);
    const fresh = wanted.filter((code) => !have.has(code));
    transaction(db, () => {
      const timestamp = currentTimestamp();
      const put = prepare(`INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, on_hand, cost_price, notes, archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '', 0, 0, NULL, '', 0, ?, ?)`);
      for (const code of fresh) {
        const article = catalogArticles[byUpper.get(code)];
        put.run(crypto.randomUUID(), tenantId, code, cleanText(article.name, 200), cleanText(article.unit, 12) || 'st', timestamp, timestamp);
      }
    });
    if (fresh.length) resyncOpen(tenantId, fresh);
    return { created: fresh.length, existing: have.size };
  }

  /**
   * Zet webshopproducten in de voorraad (binnen de transactie van de
   * aanroeper). Een variabel product wordt een hoofdartikel met kenmerken, zijn
   * variaties worden varianten eronder; een variatie komt pas na zijn product.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ product: object, code: string }[]} fresh De nieuwe producten met hun voorraadcode.
   * @param {Map<string, object>} parentItems Bestaande hoofdartikelen per webshop-product-id ({ id, name, has_variants, attributes }).
   * @param {{ vatRate: number, priceOf: Function }} options Btw-tarief van nieuwe artikelen en product → verkoopprijs excl. btw.
   * @returns {{ codes: string[], skipped: number }} De codes van de nieuwe artikelen en het aantal overgeslagen variaties.
   */
  function insertShopProducts(tenantId, fresh, parentItems, { vatRate, priceOf }) {
    const timestamp = currentTimestamp();
    const put = prepare(`INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, on_hand, cost_price, notes, archived, created_at, updated_at,
        sale_price, vat_rate, revenue_group, shop_sync, shop_product_id, parent_id, has_variants, attributes, variant_values)
      VALUES (?, ?, ?, ?, 'st', '', 0, 0, NULL, '', 0, ?, ?, ?, ?, 'producten', 1, ?, ?, ?, ?, ?)`);
    const codes = [];
    let skipped = 0;
    const ordered = [...fresh.filter((entry) => !entry.product.parentId), ...fresh.filter((entry) => entry.product.parentId)];
    for (const { product, code } of ordered) {
      const price = priceOf(product);
      const salePrice = price == null ? null : Math.round(price * 100) / 100;
      if (product.type === 'variable') {
        const attributes = shopAttributesOf(product);
        const id = crypto.randomUUID();
        put.run(id, tenantId, code, cleanText(product.name, 200) || code, timestamp, timestamp, null, vatRate, String(product.id), null, 1, JSON.stringify(attributes), '');
        parentItems.set(String(product.id), { id, name: cleanText(product.name, 200) || code, has_variants: 1, attributes: JSON.stringify(attributes) });
      } else if (product.parentId) {
        const parent = parentItems.get(String(product.parentId));
        if (!parent || !Number(parent.has_variants)) { skipped++; continue; }
        const values = {};
        for (const attribute of product.attributes || []) if (attribute.name && attribute.option) values[cleanText(attribute.name, 40)] = cleanText(attribute.option, 40);
        put.run(crypto.randomUUID(), tenantId, code, Object.keys(values).length ? variantName(parent.name, values) : cleanText(product.name, 200) || code, timestamp, timestamp,
          salePrice, vatRate, String(product.id), parent.id, 0, '', JSON.stringify(values));
      } else {
        put.run(crypto.randomUUID(), tenantId, code, cleanText(product.name, 200) || code, timestamp, timestamp, salePrice, vatRate, String(product.id), null, 0, '', '');
      }
      codes.push(code);
    }
    return { codes, skipped };
  }

  /**
   * Maakt van een bestaand gewoon artikel dat aan een variabel webshopproduct
   * gekoppeld is (van vóór de varianten) een hoofdartikel, zodat de variaties
   * eronder kunnen komen. Alleen als het artikel geen voorraad, boekingen of
   * reserveringen heeft; anders krijgt het een melding en blijft het zoals het
   * is. Binnen een lopende transactie.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} item Het artikel (id); wordt bij omzetten bijgewerkt (has_variants, attributes).
   * @param {object} product Het variabele webshopproduct.
   * @returns {boolean} true als het artikel nu een hoofdartikel is.
   */
  function promoteToParent(tenantId, item, product) {
    const row = prepare('SELECT on_hand, parent_id, has_variants FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, item.id);
    if (!row || row.parent_id) return false;
    if (Number(row.has_variants)) return true;
    const used = Math.abs(Number(row.on_hand)) > 0 || prepare('SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = ? AND item_id = ?) OR EXISTS (SELECT 1 FROM stock_reservations WHERE tenant_id = ? AND item_id = ?) AS n')
      .get(tenantId, item.id, tenantId, item.id).n;
    if (used) {
      prepare('UPDATE stock_items SET shop_error = ? WHERE tenant_id = ? AND id = ?')
        .run('In de webshop is dit een product met variaties, maar dit artikel heeft voorraad of boekingen. Maak een nieuw hoofdartikel en zet de varianten daaronder.', tenantId, item.id);
      return false;
    }
    const attributes = JSON.stringify(shopAttributesOf(product));
    prepare('UPDATE stock_items SET has_variants = 1, attributes = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(attributes, currentTimestamp(), tenantId, item.id);
    item.has_variants = 1;
    item.attributes = attributes;
    return true;
  }

  /**
   * Bestaande artikelen die bij een variabel webshopproduct horen, per product-id.
   * @param {string} tenantId Id van de omgeving.
   * @returns {Map<string, object>} id, name, has_variants en attributes per webshop-product-id.
   */
  const parentItemsOf = (tenantId) => new Map(prepare('SELECT id, name, has_variants, attributes, shop_product_id FROM stock_items WHERE tenant_id = ? AND parent_id IS NULL AND shop_product_id IS NOT NULL')
    .all(tenantId).map((row) => [String(row.shop_product_id), row]));

  /**
   * Producten uit de webshop als voorraadartikel overnemen (nog niet bestaande
   * codes). Code = het veld aquatech_code, de sku of WC-<id>; prijs = de webshopprijs
   * (excl. btw). Een variabel product neemt zijn variaties mee als varianten.
   * De stand komt bij de volgende synchronisatie uit de webshop.
   * @param {string} tenantId Id van de omgeving.
   * @param {object[]} products De webshopproducten (met variaties).
   * @param {string[]} ids Ids van de gekozen producten.
   * @returns {object} { created, existing, skipped }, of { error, field }.
   */
  function importShop(tenantId, products, ids) {
    const want = new Set((Array.isArray(ids) ? ids : []).map(String).slice(0, 500));
    if (!want.size) return { error: 'Kies een of meer producten.', field: 'ids' };
    const chosen = products.filter((product) => want.has(String(product.id)) && !product.parentId);
    // Producten van vóór migratie 33 hebben nog geen bekend type; een variabel product zou anders een gewoon artikel worden.
    if (chosen.some((product) => product.type === 'unknown')) return { error: 'Synchroniseer eerst de webshop opnieuw (Beheer → Webshop); van een of meer producten is het type nog onbekend.', field: 'ids' };
    const chosenIds = new Set(chosen.map((product) => String(product.id)));
    chosen.push(...products.filter((product) => product.parentId && chosenIds.has(String(product.parentId))));
    const skipped = [];
    const fresh = [];
    const seen = new Set();
    for (const product of chosen) {
      const code = shopCodeOf(product);
      if (!code || code.length > 40 || !/^[A-Z0-9][A-Z0-9 ._\-/+]*$/.test(code) || seen.has(code)) { skipped.push(product.name); continue; }
      seen.add(code);
      fresh.push({ product, code });
    }
    const have = new Set(fresh.length ? prepare(`SELECT code FROM stock_items WHERE tenant_id = ? AND code IN (${placeholders(fresh.length)})`).all(tenantId, ...fresh.map((entry) => entry.code)).map((row) => row.code) : []);
    const todo = fresh.filter((entry) => !have.has(entry.code));
    const out = transaction(db, () => {
      const parentItems = parentItemsOf(tenantId);
      // Een eerder als gewoon artikel overgenomen variabel product wordt (als dat veilig kan) een hoofdartikel.
      for (const product of chosen) {
        const item = product.type === 'variable' && parentItems.get(String(product.id));
        if (item && !Number(item.has_variants)) promoteToParent(tenantId, item, product);
      }
      return insertShopProducts(tenantId, todo, parentItems, { vatRate: 21, priceOf: (product) => product.price });
    });
    if (out.codes.length) resyncOpen(tenantId, out.codes);
    return { created: out.codes.length, existing: have.size, skipped };
  }

  /**
   * Maakt de voorraadlijst gelijk aan de webshop: elk webshopproduct met een
   * code of sku wordt een voorraadartikel (nieuw, of een gearchiveerd artikel
   * komt terug), artikelen die niet in de webshop staan worden gearchiveerd
   * (nooit verwijderd: werkorders, offertes en facturen houden hun regels).
   * Een variabel product wordt een hoofdartikel, zijn variaties varianten; nieuwe
   * waarden van een kenmerk in de webshop komen bij het hoofdartikel.
   * @param {string} tenantId Id van de omgeving.
   * @param {object[]} products Alle producten uit de webshop (met variaties).
   * @param {Function} matchProduct Functie item ({ code }) → webshopproduct of null.
   * @param {{ vatRate?: number, priceOf?: Function }} [options] Btw-tarief van nieuwe artikelen en product → verkoopprijs excl. btw.
   * @returns {{ created: number, restored: number, archived: number, skippedProducts: number }} Aantallen.
   */
  function mirrorShop(tenantId, products, matchProduct, { vatRate = 21, priceOf = (product) => product.price } = {}) {
    const items = prepare('SELECT id, code, name, archived, shop_product_id, parent_id, has_variants, attributes FROM stock_items WHERE tenant_id = ?').all(tenantId);
    const timestamp = currentTimestamp();
    const matchedProducts = new Set();
    const parentItems = new Map();
    const restore = [];
    const archive = [];
    const attributeUpdates = [];
    const legacyParents = [];
    const seenCodes = new Set(items.map((item) => item.code));
    for (const item of items) {
      const product = matchProduct(item);
      if (product) {
        matchedProducts.add(String(product.id));
        if (item.archived) restore.push(item);
        if (!product.parentId) parentItems.set(String(product.id), item);
        if (product.type === 'variable' && !Number(item.has_variants) && !item.parent_id) legacyParents.push({ item, product });
        else if (product.type === 'variable' && Number(item.has_variants)) {
          const merged = mergeAttributes(parseJson(item.attributes, []), shopAttributesOf(product));
          if (JSON.stringify(merged) !== item.attributes) attributeUpdates.push({ id: item.id, attributes: JSON.stringify(merged) });
        }
      } else if (!item.archived) {
        archive.push(item);
      }
    }
    const fresh = [];
    let skippedProducts = 0;
    const productIds = new Set(products.map((product) => String(product.id)));
    for (const product of products) {
      if (matchedProducts.has(String(product.id))) continue;
      const code = shopCodeOf(product);
      if (!code || code.length > 40 || !/^[A-Z0-9][A-Z0-9 ._\-/+]*$/.test(code) || seenCodes.has(code) || (product.parentId && !productIds.has(String(product.parentId)))) { skippedProducts++; continue; }
      seenCodes.add(code);
      fresh.push({ product, code });
    }
    let createdCount = 0;
    transaction(db, () => {
      for (const update of attributeUpdates) prepare('UPDATE stock_items SET attributes = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(update.attributes, timestamp, tenantId, update.id);
      // Van vóór de varianten: een gewoon artikel bij een variabel product wordt (als dat veilig kan) een hoofdartikel.
      for (const { item, product } of legacyParents) promoteToParent(tenantId, item, product);
      const inserted = insertShopProducts(tenantId, fresh, parentItems, { vatRate, priceOf });
      createdCount = inserted.codes.length;
      skippedProducts += inserted.skipped;
      for (let start = 0; start < restore.length; start += BATCH) {
        const ids = restore.slice(start, start + BATCH).map((item) => item.id);
        prepare(`UPDATE stock_items SET archived = 0, updated_at = ? WHERE tenant_id = ? AND id IN (${placeholders(ids.length)})`).run(timestamp, tenantId, ...ids);
      }
      for (let start = 0; start < archive.length; start += BATCH) {
        const ids = archive.slice(start, start + BATCH).map((item) => item.id);
        prepare(`UPDATE stock_items SET archived = 1, updated_at = ? WHERE tenant_id = ? AND id IN (${placeholders(ids.length)})`).run(timestamp, tenantId, ...ids);
        prepare(`DELETE FROM stock_reservations WHERE tenant_id = ? AND item_id IN (${placeholders(ids.length)})`).run(tenantId, ...ids);
      }
      // In dezelfde transactie, zodat een herstelde of nieuwe regel nooit zonder reservering actief blijft.
      const reopened = [...inserted.codes, ...restore.map((item) => item.code)];
      if (reopened.length) resyncOpen(tenantId, reopened, { nested: true });
    });
    return { created: createdCount, restored: restore.length, archived: archive.length, skippedProducts };
  }

  /**
   * Logboek (voor het overzicht en de Excel-export), nieuwste eerst.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ from?: string, to?: string, itemId?: string, workOrderId?: string, limit?: number }} [filters] Periode, artikel, werkorder en maximum.
   * @returns {object[]} De mutaties met code, naam en eenheid.
   */
  function movements(tenantId, { from = '', to = '', itemId = null, workOrderId = null, limit = EXPORT_LIMIT } = {}) {
    const args = [tenantId];
    let sql = `SELECT ${MOVE_COLS}, i.code, i.name, i.unit FROM stock_movements m JOIN stock_items i ON i.id = m.item_id WHERE m.tenant_id = ?`;
    if (isDate(from)) { sql += ' AND m.created_at >= ?'; args.push(`${from}T00:00:00.000Z`); }
    if (isDate(to)) { sql += ' AND m.created_at <= ?'; args.push(`${to}T23:59:59.999Z`); }
    if (itemId) { sql += ' AND m.item_id = ?'; args.push(String(itemId)); }
    if (workOrderId) { sql += ' AND m.work_order_id = ?'; args.push(String(workOrderId)); }
    const rowLimit = Math.max(1, Math.min(EXPORT_LIMIT, Number(limit) || EXPORT_LIMIT));
    return prepare(`${sql} ORDER BY m.created_at DESC, m.id LIMIT ${rowLimit}`).all(...args).map(shapeMove);
  }

  // ---------- Werkorders: reserveren en afboeken ----------
  /**
   * Een werkorder van de omgeving (ook verwijderd).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de werkorder.
   * @returns {object|undefined} id, number, status, data en deleted_at.
   */
  const findWorkOrder = (tenantId, id) => prepare('SELECT id, number, status, data, deleted_at FROM work_orders WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
  /**
   * De niet-gearchiveerde voorraadartikelen met deze codes.
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} codes Genormaliseerde codes.
   * @returns {object[]} De rijen.
   */
  const itemsFor = (tenantId, codes) => (codes.length
    ? prepare(`SELECT ${ITEM_COLS} FROM stock_items WHERE tenant_id = ? AND archived = 0 AND has_variants = 0 AND code IN (${placeholders(codes.length)})`).all(tenantId, ...codes) : []);
  /**
   * Netto afgeboekt per artikel voor deze werkorder (afboeking − retour).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} workOrderId Id van de werkorder.
   * @returns {Map<string, number>} Aantal per artikel-id.
   */
  const issuedFor = (tenantId, workOrderId) => new Map(prepare(`SELECT item_id, SUM(qty) AS qty FROM stock_movements
    WHERE tenant_id = ? AND work_order_id = ? AND kind IN ('afboeking', 'retour') GROUP BY item_id`).all(tenantId, workOrderId).map((row) => [row.item_id, round3(-row.qty)]));
  /**
   * Is er materiaalverbruik van de installateur op deze werkorder geboekt?
   * @param {string} tenantId Id van de omgeving.
   * @param {string} workOrderId Id van de werkorder.
   * @returns {boolean} true als dat zo is.
   */
  const usageBooked = (tenantId, workOrderId) => Boolean(prepare(`SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = ? AND work_order_id = ? AND source LIKE 'verbruik:%') AS n`)
    .get(tenantId, workOrderId).n);

  /**
   * Voert werk uit in een transactie, of direct als de aanroeper er al een open heeft (transaction nest niet).
   * @param {Function} work Het werk.
   * @param {boolean} nested true als er al een transactie loopt.
   * @returns {*} Wat het werk teruggeeft.
   */
  const inTransaction = (work, nested) => (nested ? work() : transaction(db, work));

  /**
   * Reserveringen van een werkorder opnieuw vastleggen (benodigd − afgeboekt, alleen open werkorders).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} workOrderId Id van de werkorder.
   * @param {object} [workOrder] De werkorderrij (anders opgezocht).
   * @param {{ nested?: boolean }} [options] Binnen de transactie van de aanroeper.
   * @returns {number} Aantal reserveringsregels.
   */
  function syncWorkOrder(tenantId, workOrderId, workOrder = findWorkOrder(tenantId, workOrderId), { nested = false } = {}) {
    return inTransaction(() => {
      prepare('DELETE FROM stock_reservations WHERE tenant_id = ? AND work_order_id = ?').run(tenantId, String(workOrderId));
      if (!workOrder || workOrder.deleted_at || !OPEN.includes(workOrder.status)) return 0;
      const need = needsOf(JSON.parse(workOrder.data).materials);
      const items = itemsFor(tenantId, [...need.keys()]);
      if (!items.length) return 0;
      const issued = issuedFor(tenantId, workOrder.id);
      const put = prepare('INSERT INTO stock_reservations (tenant_id, work_order_id, item_id, qty, updated_at) VALUES (?, ?, ?, ?, ?)');
      const timestamp = currentTimestamp();
      let count = 0;
      for (const item of items) {
        const rest = round3(need.get(item.code).qty - (issued.get(item.id) || 0));
        if (rest > 0) { put.run(tenantId, workOrder.id, item.id, rest, timestamp); count++; }
      }
      return count;
    }, nested);
  }

  /**
   * Alle open werkorders opnieuw reserveren (bijv. na een nieuw voorraadartikel).
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]|null} [codes] Alleen werkorders met een van deze codes.
   * @param {{ nested?: boolean }} [options] Binnen de transactie van de aanroeper.
   * @returns {number} Aantal bijgewerkte werkorders.
   */
  function resyncOpen(tenantId, codes = null, { nested = false } = {}) {
    const rows = prepare(`SELECT id, number, status, data, deleted_at FROM work_orders WHERE tenant_id = ? AND deleted_at IS NULL
      AND status IN (${placeholders(OPEN.length)})`).all(tenantId, ...OPEN);
    const want = codes ? new Set(codes.map(normalizeCode)) : null;
    let count = 0;
    for (const workOrder of rows) {
      if (want && ![...needsOf(JSON.parse(workOrder.data).materials).keys()].some((code) => want.has(code))) continue;
      syncWorkOrder(tenantId, workOrder.id, workOrder, { nested });
      count++;
    }
    return count;
  }

  /**
   * Werkorder gereed: wat nog gereserveerd staat afboeken, tenzij er verbruik
   * is geregistreerd (dan vervalt alleen de rest van de reservering).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} workOrder De werkorderrij.
   * @param {object} user Wie hem gereed meldt.
   * @returns {{ booked: number }} Aantal afboekingen.
   */
  function complete(tenantId, workOrder, user) {
    return transaction(db, () => {
      const reservations = prepare('SELECT item_id, qty FROM stock_reservations WHERE tenant_id = ? AND work_order_id = ?').all(tenantId, workOrder.id);
      let booked = 0;
      if (reservations.length && !usageBooked(tenantId, workOrder.id)) {
        for (const reservation of reservations) {
          if (!(reservation.qty > 0)) continue;
          book(tenantId, reservation.item_id, -reservation.qty, { kind: 'afboeking', workOrder, source: 'gereed', note: 'Werkorder gereed', user });
          booked++;
        }
      }
      prepare('DELETE FROM stock_reservations WHERE tenant_id = ? AND work_order_id = ?').run(tenantId, workOrder.id);
      return { booked };
    });
  }

  /**
   * Na elke wijziging van een werkorder (aanmaken, opslaan, status, verwijderen).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} workOrderId Id van de werkorder.
   * @param {object} user Wie de wijziging deed.
   * @returns {object} { booked } bij Gereed, anders { reserved }.
   */
  function onWorkOrderChange(tenantId, workOrderId, user) {
    const workOrder = findWorkOrder(tenantId, workOrderId);
    if (workOrder && !workOrder.deleted_at && workOrder.status === 'gereed') return complete(tenantId, workOrder, user);
    return { reserved: syncWorkOrder(tenantId, workOrderId, workOrder) };
  }

  /**
   * Stand van de materialen van een werkorder ten opzichte van de voorraad.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} workOrderId Id van de werkorder.
   * @returns {object|null} workOrder, lines (per artikel), notInStock, usage en movements; null als de werkorder niet bestaat.
   */
  function forWorkOrder(tenantId, workOrderId) {
    const workOrder = findWorkOrder(tenantId, workOrderId);
    if (!workOrder || workOrder.deleted_at) return null;
    const need = needsOf(JSON.parse(workOrder.data).materials);
    const issued = issuedFor(tenantId, workOrder.id);
    const issuedIds = [...issued.keys()];
    const items = itemsFor(tenantId, [...need.keys()]);
    const known = new Set(items.map((item) => item.id));
    // Ook artikelen die zijn afgeboekt maar niet (meer) in de materiaallijst staan.
    const extraIds = issuedIds.filter((id) => !known.has(id));
    if (extraIds.length) items.push(...prepare(`SELECT ${ITEM_COLS} FROM stock_items WHERE tenant_id = ? AND id IN (${placeholders(extraIds.length)})`).all(tenantId, ...extraIds));
    const ids = items.map((item) => item.id);
    const resRows = ids.length ? prepare(`SELECT item_id, work_order_id, qty FROM stock_reservations WHERE tenant_id = ? AND item_id IN (${placeholders(ids.length)})`).all(tenantId, ...ids) : [];
    const lines = [];
    for (const item of items) {
      const mine = sumQty(resRows.filter((reservation) => reservation.item_id === item.id && reservation.work_order_id === workOrder.id));
      const others = sumQty(resRows.filter((reservation) => reservation.item_id === item.id && reservation.work_order_id !== workOrder.id));
      const required = need.get(item.code);
      const needed = required ? required.qty : 0;
      const done = issued.get(item.id) || 0;
      const rest = Math.max(0, round3(needed - done));
      const free = round3(item.on_hand - others);
      lines.push({
        itemId: item.id, code: item.code, name: item.name, unit: item.unit, location: item.location, needed, issued: round3(done), reserved: round3(mine),
        onHand: round3(item.on_hand), available: free, shortage: OPEN.includes(workOrder.status) ? Math.max(0, round3(rest - Math.max(0, free))) : 0, archived: Boolean(item.archived),
      });
    }
    const stockCodes = new Set(items.map((item) => item.code));
    // Code van een hoofdartikel: eerst een maat (variant) kiezen.
    const missing = [...need.keys()].filter((code) => !stockCodes.has(code));
    const parentRows = missing.length ? prepare(`SELECT code, name FROM stock_items WHERE tenant_id = ? AND archived = 0 AND has_variants = 1 AND code IN (${placeholders(missing.length)})`).all(tenantId, ...missing) : [];
    const parentCodes = new Set(parentRows.map((row) => row.code));
    const chooseVariant = parentRows.map((row) => ({ code: row.code, name: row.name, qty: need.get(row.code).qty, unit: need.get(row.code).unit }));
    const notInStock = [...need.entries()].filter(([code]) => !stockCodes.has(code) && !parentCodes.has(code)).map(([code, required]) => ({ code, description: required.description, qty: required.qty, unit: required.unit }));
    lines.sort((left, right) => left.code.localeCompare(right.code));
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status }, lines, notInStock, chooseVariant,
      usage: usageBooked(tenantId, workOrder.id),
      movements: movements(tenantId, { workOrderId: workOrder.id, limit: LIST_LIMIT }),
    };
  }

  /**
   * Handmatig afboeken op een werkorder; zonder regels alles wat nog gereserveerd staat.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} user Wie afboekt.
   * @param {string} workOrderId Id van de werkorder.
   * @param {{ code: string, qty: number }[]|null} rawLines qty > 0 = afboeken, < 0 = retour.
   * @param {string} [note] Opmerking.
   * @returns {object} { booked, stock }, of { error, field, status }.
   */
  function issue(tenantId, user, workOrderId, rawLines, note = '') {
    const workOrder = findWorkOrder(tenantId, workOrderId);
    if (!workOrder || workOrder.deleted_at) return { error: 'not_found', status: 404 };
    let lines;
    if (rawLines === undefined || rawLines === null) {
      lines = prepare(`SELECT r.item_id, r.qty, i.code FROM stock_reservations r JOIN stock_items i ON i.id = r.item_id
        WHERE r.tenant_id = ? AND r.work_order_id = ?`).all(tenantId, workOrder.id).map((row) => ({ itemId: row.item_id, code: row.code, qty: round3(row.qty) }));
      if (!lines.length) return { error: 'Er staat niets gereserveerd om af te boeken.', status: 409 };
    } else {
      if (!Array.isArray(rawLines) || !rawLines.length || rawLines.length > 200) return { error: 'Geef aan wat er afgeboekt moet worden.', field: 'lines' };
      const clean = [];
      for (const line of rawLines) {
        const code = normalizeCode(line && line.code);
        const qty = round3(line && line.qty);
        if (!code || !qty || Math.abs(qty) > MAX_QTY) return { error: 'Ongeldige regel: artikelcode en aantal zijn nodig.', field: 'lines' };
        clean.push({ code, qty });
      }
      const codes = [...new Set(clean.map((line) => line.code))];
      const items = new Map(itemsFor(tenantId, codes).map((item) => [item.code, item]));
      const unknown = codes.filter((code) => !items.has(code));
      if (unknown.length) return { error: `Geen voorraadartikel: ${unknown.slice(0, 5).join(', ')}.`, field: 'lines' };
      lines = clean.map((line) => ({ itemId: items.get(line.code).id, code: line.code, qty: line.qty }));
    }
    const ids = transaction(db, () => lines.map((line) => book(tenantId, line.itemId, -line.qty, {
      kind: line.qty > 0 ? 'afboeking' : 'retour', workOrder, source: 'handmatig', note, user,
    })));
    syncWorkOrder(tenantId, workOrder.id);
    return { booked: ids.length, stock: forWorkOrder(tenantId, workOrder.id) };
  }

  /**
   * Materiaalverbruik van de installateur boeken (registratie op de
   * werkorder). Idempotent per verbruiksregel: de totale afboeking voor
   * usageId wordt qty (0 = regel verwijderd, negatief = retour), dus een
   * gewijzigde regel boekt alleen het verschil.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ usageId: string, workOrderId: string, code: string, qty: number, user?: object }} usage De verbruiksregel.
   * @param {{ nested?: boolean }} [options] nested: binnen de transactie van de aanroeper (materiaalregistratie), zodat verbruik en afboeking samen slagen.
   * @returns {string|null} Id van de laatste mutatie voor deze regel, of null als de code geen voorraadartikel is.
   */
  function syncUsage(tenantId, { usageId, workOrderId, code, qty, user = null }, { nested = false } = {}) {
    if (!usageId) return null;
    const source = `verbruik:${String(usageId).slice(0, 80)}`;
    const workOrder = findWorkOrder(tenantId, workOrderId);
    if (!workOrder) return null;
    const out = inTransaction(() => {
      const previous = prepare('SELECT item_id, SUM(qty) AS qty FROM stock_movements WHERE tenant_id = ? AND source = ? GROUP BY item_id').all(tenantId, source);
      const item = normalizeCode(code) ? findCode(tenantId, code) : null;
      let last = null;
      // Een andere code dan eerder: het oude artikel eerst terugboeken.
      for (const earlier of previous) {
        if (item && earlier.item_id === item.id) continue;
        if (round3(earlier.qty)) last = book(tenantId, earlier.item_id, -earlier.qty, { kind: earlier.qty < 0 ? 'retour' : 'afboeking', workOrder, source, note: 'Verbruik gewijzigd', user });
      }
      if (item && !item.archived && !Number(item.has_variants)) {
        const was = round3(-(previous.find((earlier) => earlier.item_id === item.id)?.qty || 0));
        const delta = round3((Number(qty) || 0) - was);
        if (delta) last = book(tenantId, item.id, -delta, { kind: delta > 0 ? 'afboeking' : 'retour', workOrder, source, note: 'Materiaalverbruik', user });
        // Niets veranderd (bijv. alleen de opmerking): de bestaande afboeking blijft de koppeling.
        if (!last && previous.length) last = prepare('SELECT id FROM stock_movements WHERE tenant_id = ? AND source = ? AND item_id = ? ORDER BY created_at DESC, id LIMIT 1').get(tenantId, source, item.id)?.id || null;
      }
      return last;
    }, nested);
    syncWorkOrder(tenantId, workOrder.id, workOrder, { nested });
    return out;
  }

  /**
   * Verkoopgegevens per code (facturen, catalogus).
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]|null} [codes] Alleen deze codes (null = alle niet-gearchiveerde).
   * @param {{ withCost?: boolean }} [options] withCost: ook de inkoopprijs (alleen voor de nacalculatie, niet voor facturen of de webshop).
   * @returns {Object<string, object>} Per code: id, name, unit, salePrice, vatRate en revenueGroup (met withCost ook costPrice).
   */
  function saleInfo(tenantId, codes = null, { withCost = false } = {}) {
    const wanted = codes ? [...new Set(codes.map(normalizeCode))].filter(Boolean) : null;
    if (wanted && !wanted.length) return {};
    const rows = wanted
      ? prepare(`SELECT id, code, name, unit, sale_price, cost_price, vat_rate, revenue_group FROM stock_items WHERE tenant_id = ? AND has_variants = 0 AND code IN (${placeholders(wanted.length)})`).all(tenantId, ...wanted)
      : prepare('SELECT id, code, name, unit, sale_price, cost_price, vat_rate, revenue_group FROM stock_items WHERE tenant_id = ? AND archived = 0 AND has_variants = 0').all(tenantId);
    const out = {};
    for (const row of rows) {
      out[row.code] = { id: row.id, name: row.name, unit: row.unit, salePrice: row.sale_price == null ? null : Number(row.sale_price), vatRate: Number(row.vat_rate), revenueGroup: row.revenue_group };
      if (withCost) out[row.code].costPrice = row.cost_price == null ? null : Number(row.cost_price);
    }
    return out;
  }

  /**
   * Bestelvoorstel: niet-gearchiveerde artikelen waarvan beschikbaar (stand −
   * gereserveerd) onder het minimum ligt (ook een tekort bij minimum 0), met het aantal om aan te vullen tot
   * "bestellen tot" (leeg of lager dan het minimum = 2× minimum), naar boven
   * afgerond op hele eenheden.
   * @param {string} tenantId Id van de omgeving.
   * @returns {{ items: object[], total: number|null }} De regels (artikel plus orderQty, target en amount) en het totaal op inkoopprijs.
   */
  function reorderProposal(tenantId) {
    let total = null;
    const items = list(tenantId).filter((item) => !item.hasVariants && item.available < item.minQty).map((item) => {
      const target = item.reorderQty != null && item.reorderQty >= item.minQty ? item.reorderQty : round3(item.minQty * 2);
      const orderQty = Math.ceil(round3(target - item.available));
      const amount = item.costPrice == null ? null : Math.round(orderQty * item.costPrice * 100) / 100;
      if (amount != null) total = Math.round(((total || 0) + amount) * 100) / 100;
      return { ...item, target, orderQty, amount };
    });
    return { items, total };
  }

  /**
   * Meldt de webshopkoppeling aan voor wijzigingen (vervangt onDirty uit de opties).
   * @param {Function} handler Aanroep met het tenant-id.
   * @returns {void}
   */
  function setDirtyHook(handler) {
    dirtyHook = handler;
  }

  /**
   * De eenheden van de omgeving. De eerste keer wordt de lijst gevuld met de
   * standaardeenheden; eenheden die artikelen gebruiken (ook via een import)
   * maar nog niet in de lijst staan, worden erbij gezet.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ nested?: boolean }} [options] Binnen de transactie van de aanroeper.
   * @returns {{ id: string, name: string }[]} De eenheden, alfabetisch.
   */
  function unitRows(tenantId, { nested = false } = {}) {
    let rows = prepare('SELECT id, name FROM stock_units WHERE tenant_id = ?').all(tenantId);
    const inUse = prepare('SELECT DISTINCT unit FROM stock_items WHERE tenant_id = ?').all(tenantId).map((row) => row.unit);
    const seen = new Set(rows.map((row) => row.name.toLowerCase()));
    const missing = [...(rows.length ? [] : DEFAULT_UNITS), ...inUse].filter((name) => {
      const known = !name || seen.has(name.toLowerCase());
      seen.add(String(name).toLowerCase());
      return !known;
    });
    if (missing.length) {
      inTransaction(() => {
        const timestamp = currentTimestamp();
        for (const name of missing) prepare('INSERT INTO stock_units (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), tenantId, name, timestamp);
      }, nested);
      rows = prepare('SELECT id, name FROM stock_units WHERE tenant_id = ?').all(tenantId);
    }
    return rows.sort((left, right) => left.name.localeCompare(right.name, 'nl'));
  }

  /**
   * De eenheden met per eenheid het aantal artikelen dat hem gebruikt.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ nested?: boolean }} [options] Binnen de transactie van de aanroeper.
   * @returns {{ id: string, name: string, items: number }[]} De eenheden.
   */
  function units(tenantId, { nested = false } = {}) {
    const rows = unitRows(tenantId, { nested });
    const counts = new Map(prepare('SELECT unit, COUNT(*) AS n FROM stock_items WHERE tenant_id = ? GROUP BY unit').all(tenantId).map((row) => [String(row.unit).toLowerCase(), Number(row.n)]));
    return rows.map((row) => ({ id: row.id, name: row.name, items: counts.get(row.name.toLowerCase()) || 0 }));
  }

  /**
   * Voegt een eenheid toe (een bestaande, ook met andere hoofdletters, blijft zoals hij is).
   * @param {string} tenantId Id van de omgeving.
   * @param {*} rawName De naam, bijv. 'rol'.
   * @param {{ nested?: boolean }} [options] Binnen de transactie van de aanroeper.
   * @returns {{ unit?: object, error?: string, field?: string, status?: number }} De eenheid, of een fout.
   */
  function addUnit(tenantId, rawName, { nested = false } = {}) {
    const name = cleanText(rawName, 12);
    if (!name) return { error: 'Vul een eenheid in.', field: 'name' };
    return inTransaction(() => {
      if (unitRows(tenantId, { nested: true }).some((row) => row.name.toLowerCase() === name.toLowerCase())) return { error: 'Deze eenheid bestaat al.', field: 'name', status: 409 };
      const id = crypto.randomUUID();
      prepare('INSERT INTO stock_units (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, tenantId, name, currentTimestamp());
      return { unit: { id, name, items: 0 } };
    }, nested);
  }

  /**
   * Verwijdert een eenheid die geen artikel meer gebruikt.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de eenheid.
   * @returns {{ name?: string, error?: string, status?: number }} De verwijderde naam, of een fout (404 of 409).
   */
  function removeUnit(tenantId, id) {
    return transaction(db, () => {
      const found = units(tenantId, { nested: true }).find((unit) => unit.id === String(id));
      if (!found) return { error: 'Eenheid niet gevonden.', status: 404 };
      if (units(tenantId, { nested: true }).length === 1) return { error: 'Er moet minstens één eenheid overblijven.', status: 409 };
      if (found.items) return { error: `Deze eenheid wordt nog door ${found.items} artikel${found.items === 1 ? '' : 'en'} gebruikt.`, status: 409 };
      prepare('DELETE FROM stock_units WHERE tenant_id = ? AND id = ?').run(tenantId, found.id);
      return { name: found.name };
    });
  }

  /**
   * Zet een eenheid die een artikel gebruikt (bijv. via de API) ook in de lijst; draait binnen de transactie van create/update.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} name De eenheid.
   * @returns {void}
   */
  function rememberUnit(tenantId, name) {
    if (name && !unitRows(tenantId, { nested: true }).some((row) => row.name.toLowerCase() === name.toLowerCase())) addUnit(tenantId, name, { nested: true });
  }

  return {
    units, addUnit, removeUnit, setVariants, articleChoices,
    list, get, create, update, remove, move, importCatalog, importShop, mirrorShop, movements, reservations: reservationsOf,
    syncWorkOrder, resyncOpen, complete, onWorkOrderChange, forWorkOrder, issue, syncUsage, book, saleInfo, findCode,
    reorderProposal, onDirty: setDirtyHook,
  };
}

/**
 * API-routes voor de voorraad. Het beheer valt onder het recht 'voorraad';
 * de voorraad van een werkorder bekijken en afboeken onder 'werkorders'.
 * Gegevens per omgeving via req.tenantId.
 * @param {object} app De Express-app.
 * @param {object} ctx { stock, requireRight, requireAnyRight?, requireJson, audit, shopProductsOf?, syncShop?, publishToShop? }.
 * @returns {void}
 */
function registerStockRoutes(app, ctx) {
  const { stock, requireRight, requireJson, audit } = ctx;
  const requireStock = requireRight('voorraad');
  const requireWorkOrders = requireRight('werkorders');
  // De artikellijst om uit te kiezen hebben werkorders, offertes en de voorraad nodig.
  const requirePicker = ctx.requireAnyRight ? ctx.requireAnyRight(['werkorders', 'offertes', 'voorraad']) : requireStock;
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het verzoek.
   * @returns {string} Id van de omgeving.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * Stuurt 404 terug.
   * @param {object} res Het antwoord.
   * @param {string} [what] Wat niet gevonden is.
   * @returns {void}
   */
  const notFound = (res, what = 'Artikel') => res.status(404).json({ error: 'not_found', message: `${what} niet gevonden.` });
  /**
   * Stuurt een fout uit de opslag terug (404, 409 of 400 met het veld).
   * @param {object} res Het antwoord.
   * @param {{ error: string, status?: number, field?: string }} out De fout.
   * @returns {void}
   */
  const fail = (res, out) => (out.error === 'not_found' ? notFound(res)
    : res.status(out.status || 400).json({ error: out.status === 409 ? 'conflict' : 'invalid', message: out.error, field: out.field }));
  /**
   * Zet het antwoord op niet cachen.
   * @param {object} res Het antwoord.
   * @returns {void}
   */
  const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

  app.get('/api/stock', requireStock, (req, res) => {
    noStore(res);
    res.json({ items: stock.list(tenantOf(req), { archived: req.query.archived === '1' }), kinds: KINDS, groups: GROUPS });
  });

  // Eenheden (st, m, rol, ...) waaruit een artikel er een kiest.
  app.get('/api/stock/units', requireStock, (req, res) => {
    noStore(res);
    res.json({ items: stock.units(tenantOf(req)) });
  });

  app.post('/api/stock/units', requireJson, requireStock, (req, res) => {
    const out = stock.addUnit(tenantOf(req), req.body?.name);
    if (out.error) return fail(res, out);
    audit(req, 'voorraad_eenheid_aangemaakt', { name: out.unit.name });
    res.status(201).json(out.unit);
  });

  app.delete('/api/stock/units/:id', requireStock, (req, res) => {
    const out = stock.removeUnit(tenantOf(req), req.params.id);
    if (out.error) return out.status === 404 ? notFound(res, 'Eenheid') : fail(res, out);
    audit(req, 'voorraad_eenheid_verwijderd', { name: out.name });
    res.json({ deleted: true });
  });

  // Artikelen om uit te kiezen (eerst het artikel, dan de maat): zonder inkoopprijs.
  app.get('/api/stock/articles', requirePicker, (req, res) => {
    noStore(res);
    res.json({ items: stock.articleChoices(tenantOf(req)) });
  });

  app.get('/api/stock/reservations', requireStock, (req, res) => {
    noStore(res);
    res.json({ items: stock.reservations(tenantOf(req)) });
  });

  // Bestelvoorstel: wat onder het minimum zit en hoeveel er bij moet (de Excel maakt de browser).
  app.get('/api/stock/reorder', requireStock, (req, res) => {
    noStore(res);
    res.json(stock.reorderProposal(tenantOf(req)));
  });

  app.get('/api/stock/movements', requireStock, (req, res) => {
    noStore(res);
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if ((from && !isDate(from)) || (to && !isDate(to))) return res.status(400).json({ error: 'invalid_date', message: 'Ongeldige datum.' });
    res.json({ items: stock.movements(tenantOf(req), { from, to, limit: req.query.limit }), limit: EXPORT_LIMIT });
  });

  app.get('/api/stock/items/:id', requireStock, (req, res) => {
    noStore(res);
    const item = stock.get(tenantOf(req), req.params.id);
    if (!item) return notFound(res);
    res.json(item);
  });

  app.post('/api/stock/items', requireJson, requireStock, (req, res) => {
    const out = stock.create(tenantOf(req), req.user, req.body);
    if (out.error) return fail(res, out);
    audit(req, 'voorraad_artikel_aangemaakt', { itemId: out.item.id, code: out.item.code });
    res.status(201).json(out.item);
  });

  app.post('/api/stock/import', requireJson, requireStock, (req, res) => {
    const out = stock.importCatalog(tenantOf(req), req.user, req.body?.codes);
    if (out.error) return fail(res, out);
    if (out.created) audit(req, 'voorraad_catalogus_overgenomen', { created: out.created });
    res.json(out);
  });

  // Webshopproducten die nog geen voorraadartikel zijn (om over te nemen).
  app.get('/api/stock/shop-products', requireStock, (req, res) => {
    noStore(res);
    const products = ctx.shopProductsOf ? ctx.shopProductsOf(tenantOf(req)) : [];
    const have = new Set(stock.list(tenantOf(req), { archived: true }).flatMap((item) => [item.code, item.shop.productId ? `#${item.shop.productId}` : '']));
    const variationCount = new Map();
    for (const product of products) if (product.parentId) variationCount.set(String(product.parentId), (variationCount.get(String(product.parentId)) || 0) + 1);
    res.json({
      items: products.filter((product) => !product.parentId && !have.has(`#${product.id}`) && !have.has(shopCodeOf(product)))
        .map((product) => ({ id: product.id, sku: product.sku, code: shopCodeOf(product), name: product.name, price: product.price, inStock: product.inStock, variations: variationCount.get(String(product.id)) || 0 })),
    });
  });

  // Zonder ids: alles uit de webshop overnemen (volle synchronisatie, zie shop-sync.js).
  app.post('/api/stock/import-shop', requireJson, requireStock, ctx.importLimiter || ((req, res, next) => next()), async (req, res, next) => {
    if (!Array.isArray(req.body?.ids) && ctx.syncShop) {
      try {
        const out = await ctx.syncShop(tenantOf(req), req.user);
        if (out.skipped) return res.status(409).json({ error: 'not_configured', message: 'Er is geen webshop gekoppeld (Beheer → Webshop).' });
        if (out.mirror === false) return res.status(409).json({ error: 'mirror_off', message: 'De instelling "Webshop bepaalt de artikellijst" staat uit (Beheer → Webshop); er is niets overgenomen.' });
        audit(req, 'voorraad_webshop_overgenomen', { created: out.created, archived: out.archived });
        return res.json(out);
      } catch (error) {
        return res.status(502).json({ error: 'shop_error', message: String(error.message || 'De webshop is niet bereikbaar.').slice(0, 300) });
      }
    }
    next();
  }, (req, res) => {
    const out = stock.importShop(tenantOf(req), ctx.shopProductsOf ? ctx.shopProductsOf(tenantOf(req)) : [], req.body?.ids);
    if (out.error) return fail(res, out);
    if (out.created) audit(req, 'voorraad_webshop_overgenomen', { created: out.created });
    res.json(out);
  });

  app.put('/api/stock/items/:id', requireJson, requireStock, (req, res) => {
    const out = stock.update(tenantOf(req), req.params.id, req.body);
    if (out.error) return fail(res, out);
    res.json(out.item);
  });

  // Kenmerken van een hoofdartikel; ontbrekende varianten worden aangemaakt.
  app.put('/api/stock/items/:id/variants', requireJson, requireStock, (req, res) => {
    const out = stock.setVariants(tenantOf(req), req.params.id, req.body?.attributes);
    if (out.error) return fail(res, out);
    audit(req, 'voorraad_varianten', { itemId: out.item.id, code: out.item.code, created: out.created, restored: out.restored });
    res.json({ ...out.item, created: out.created, restored: out.restored });
  });

  // Artikel (met varianten) als nieuw product in de webshop zetten; Aquatech is de bron.
  app.post('/api/stock/items/:id/publish', requireJson, requireStock, ctx.importLimiter || ((req, res, next) => next()), async (req, res) => {
    // Eerst het artikel in deze omgeving: een id van een andere organisatie is 404, ook zonder webshop.
    if (!stock.get(tenantOf(req), req.params.id)) return notFound(res);
    if (!ctx.publishToShop) return res.status(409).json({ error: 'not_configured', message: 'Er is geen webshop gekoppeld (Beheer → Webshop).' });
    try {
      const out = await ctx.publishToShop(tenantOf(req), req.params.id, req.user);
      if (out.error === 'not_found') return notFound(res);
      if (out.error) return res.status(out.status || 409).json({ error: out.code || 'conflict', message: out.error });
      audit(req, 'voorraad_naar_webshop', { itemId: req.params.id, productId: out.productId, variations: out.variations });
      res.json({ ...stock.get(tenantOf(req), req.params.id), published: out });
    } catch (error) {
      res.status(502).json({ error: 'shop_error', message: String(error.message || 'De webshop is niet bereikbaar.').slice(0, 300) });
    }
  });

  app.delete('/api/stock/items/:id', requireStock, (req, res) => {
    const out = stock.remove(tenantOf(req), req.params.id);
    if (!out) return notFound(res);
    audit(req, out.deleted ? 'voorraad_artikel_verwijderd' : 'voorraad_artikel_gearchiveerd', { itemId: req.params.id, code: out.code });
    res.json(out);
  });

  app.post('/api/stock/items/:id/movements', requireJson, requireStock, (req, res) => {
    const out = stock.move(tenantOf(req), req.user, req.params.id, req.body);
    if (out.error) return fail(res, out);
    if (req.body.kind !== 'ontvangst') audit(req, `voorraad_${req.body.kind}`, { itemId: out.item.id, code: out.item.code, delta: out.delta });
    res.status(201).json(out.item);
  });

  app.post('/api/stock/resync', requireJson, requireStock, (req, res) => {
    res.json({ workOrders: stock.resyncOpen(tenantOf(req)) });
  });

  // ---------- Vanuit de werkorder ----------
  app.get('/api/stock/workorders/:id', requireWorkOrders, (req, res) => {
    noStore(res);
    const out = stock.forWorkOrder(tenantOf(req), req.params.id);
    if (!out) return notFound(res, 'Werkorder');
    res.json(out);
  });

  app.post('/api/stock/workorders/:id/reserve', requireJson, requireWorkOrders, (req, res) => {
    const out = stock.forWorkOrder(tenantOf(req), req.params.id);
    if (!out) return notFound(res, 'Werkorder');
    stock.syncWorkOrder(tenantOf(req), req.params.id);
    res.json(stock.forWorkOrder(tenantOf(req), req.params.id));
  });

  app.post('/api/stock/workorders/:id/issue', requireJson, requireWorkOrders, (req, res) => {
    const out = stock.issue(tenantOf(req), req.user, req.params.id, req.body?.lines, req.body?.note);
    if (out.error === 'not_found') return notFound(res, 'Werkorder');
    if (out.error) return fail(res, out);
    audit(req, 'voorraad_afgeboekt', { workOrderId: req.params.id, lines: out.booked });
    res.json(out.stock);
  });
}

module.exports = { createStockStore, registerStockRoutes, sanitizeItem, sanitizeAttributes, combinations, needsOf, KINDS, GROUPS, VAT_RATES };
