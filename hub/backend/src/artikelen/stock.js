// Artikelen (voorheen Voorraadbeheer): artikelen op voorraad, het logboek van mutaties en de
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
// - Subartikelen (migratie 33): een artikelgroep (is_group) heeft kenmerken
//   (bijv. Maat: 16 mm, 20 mm) en zelf geen voorraad; elke combinatie is een
//   subartikel: een gewoon voorraadartikel met eigen code, prijs, kostprijs,
//   voorraad, minimum en bestelniveau (group_id + sub_values). Werkorders,
//   offertes en facturen gebruiken de code van het subartikel; staat de code van
//   een artikelgroep op een werkorder, dan moet er eerst een maat gekozen
//   worden (forWorkOrder: chooseSubItem). Eenheid, btw en omzetgroep volgen het
//   artikelgroep.
// - Samenvoegen (1.5.8): losse artikelen worden de subartikelen van een nieuw artikelgroep
//   (mergeIntoGroup). Hun id, code, voorraad, prijzen, afbeelding, boekingen en
//   reserveringen blijven zoals ze zijn, dus werkorders, offertes en facturen
//   verwijzen nog steeds naar dezelfde code. mergeSuggestions stelt groepen voor.
// - Inkoopprijzen en FIFO (migratie 45, stock-costs.js): elke mutatie gaat via book
//   langs de voorraadlagen. Een ontvangst wordt een laag met zijn inkoopprijs, een
//   afboeking gebruikt de oudste laag eerst; een nieuwe inkoopprijs komt in de
//   historie en overschrijft de oude niet.
const crypto = require('crypto');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { transaction } = require('../database/db');
const { loadArticles } = require('../webshop/shop');
const { suggestGroups, MAX_GROUP_SIZE } = require('./group-suggestions');
const Wholesale = require('../webshop/wholesale');
const ItemDetails = require('./item-details');
const { createStockCosts, parsePrice } = require('./stock-costs');
const PriceFactor = require('./price-factor');
const DeliveryRules = require('../webshop/delivery-rules');
const ArticleCode = require(path.join(FRONTEND_DIR, 'shared', 'article-code.js'));
const { MANUAL, OPEN, MAX_QTY, LIST_LIMIT, EXPORT_LIMIT, BATCH, currentTimestamp, round3, normalizeCode, shopCodeOf, cleanText, isDate, sumQty, DEFAULT_UNITS, parseJson, sanitizeAttributes, combinations, shopAttributesOf, mergeAttributes, valuesKey, codePart, subItemName, placeholders, sanitizeItem, needsOf } = require('./stock-helpers');
const { registerStockRoutes } = require('./stock-routes');
const { KINDS, GROUPS, VAT_RATES } = require('./stock-helpers');

/**
 * Maakt de opslag voor voorraadartikelen, mutaties en reserveringen.
 * @param {object} db De database.
 * @param {{ articles?: Function, onDirty?: Function }} [options] Catalogus van de planner; aanroep na een wijziging voor de webshop.
 * @returns {object} list, get, create, update, remove, move, setSubItems, articleChoices, mergeSuggestions, mergeIntoGroup, unmergePreview, unmergeSubItems, importCatalog, importShop, mirrorShop, addMissingShop, movements, reservations, syncWorkOrder, resyncOpen, complete, onWorkOrderChange, forWorkOrder, issue, syncUsage, book, saleInfo, findCode, reorderProposal, reserveOrder, releaseOrder, issueOrder en onDirty.
 */
function createStockStore(db, { articles = loadArticles, onDirty = null } = {}) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);
  // Inkoopprijzen en voorraadlagen (FIFO), zie stock-costs.js.
  const costs = createStockCosts(db);
  // Webshop: na een wijziging van prijs of stand (shop-sync.js meldt zich aan via onDirty()).
  let dirtyHook = onDirty;
  // Prijsfactor: berekent de verkoopprijs van een artikel in de modus factor (price-factor.js meldt zich aan via setPricer()).
  let pricer = null;
  // Auditlog voor automatische prijswijzigingen (de server meldt zich aan via setPriceLogger()).
  let priceLogger = null;
  /**
   * Legt een automatische prijswijziging vast in het auditlog (alleen als de prijs echt anders wordt).
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, code: string }} item Het artikel.
   * @param {*} oldPrice De prijs tot nu toe.
   * @param {number} newPrice De nieuwe prijs.
   * @param {string} source Waardoor de prijs wijzigde (inkoopprijs, ontvangst, factor enzovoort).
   * @param {object|null} user Wie de aanleiding gaf (leeg = systeem).
   * @param {object[]|null} [collect] Lijst waarin de auditregel wordt verzameld (voor één schrijfactie per blok); leeg = meteen schrijven.
   * @returns {void}
   */
  function logPriceChange(tenantId, item, oldPrice, newPrice, source, user, collect = null) {
    const before = oldPrice == null ? null : Number(oldPrice);
    if (!priceLogger || (before !== null && Math.abs(before - newPrice) < 0.005)) return;
    const entry = { tenantId, userId: user && user.id ? user.id : null, action: 'verkoopprijs_automatisch', detail: { artikel: item.code, oud: before, nieuw: newPrice, bron: source } };
    if (collect) collect.push(entry); else priceLogger([entry]);
  }
  /**
   * Webshop: meldt een wijziging van prijs of stand (shop-sync.js meldt zich aan via onDirty()).
   * @param {string} tenantId Id van de omgeving.
   * @returns {void}
   */
  const dirty = (tenantId) => { if (dirtyHook) dirtyHook(tenantId); };
  const SALE_COLS = 'stock_managed, sale_price, business_price, vat_rate, revenue_group, weight_grams, shop_sync, shop_product_id, shop_dirty, shop_synced_at, shop_error, order_pack_size, order_min_qty, price_tiers, unit_content, ean, price_mode, price_factor';
  const GROUP_COLS = 'group_id, is_group, attributes, sub_values, image_id, main_group_id, sub_group_id';
  const ITEM_COLS = `id, code, name, unit, location, min_qty, reorder_qty, on_hand, cost_price, notes, archived, created_at, updated_at, ${SALE_COLS}, ${GROUP_COLS}`;
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
      salePrice: itemRow.sale_price == null ? null : Number(itemRow.sale_price), businessPrice: itemRow.business_price == null ? null : Number(itemRow.business_price), vatRate: Number(itemRow.vat_rate ?? 21), revenueGroup: itemRow.revenue_group || 'producten',
      margin: PriceFactor.marginPct(itemRow.sale_price, itemRow.cost_price),
      priceMode: itemRow.price_mode === 'factor' ? 'factor' : 'vast', priceFactor: itemRow.price_factor == null ? null : Number(itemRow.price_factor),
      weightGrams: itemRow.weight_grams == null ? null : Number(itemRow.weight_grams),
      packSize: Number(itemRow.order_pack_size) || 1, orderMinQty: Number(itemRow.order_min_qty) || 1, priceTiers: Wholesale.tiersOf(itemRow.price_tiers),
      unitContent: itemRow.unit_content == null ? null : Number(itemRow.unit_content), ean: itemRow.ean || null,
      stockManaged: itemRow.stock_managed === undefined ? true : Boolean(Number(itemRow.stock_managed)),
      shopSync: itemRow.shop_sync === undefined ? true : Boolean(Number(itemRow.shop_sync)),
      shop: { productId: itemRow.shop_product_id || null, pending: Boolean(Number(itemRow.shop_dirty)), syncedAt: itemRow.shop_synced_at || null, error: itemRow.shop_error || '' },
      groupId: itemRow.group_id || null, mainGroupId: itemRow.main_group_id || null, subGroupId: itemRow.sub_group_id || null, imageId: itemRow.image_id || null, isGroup: Boolean(Number(itemRow.is_group)),
      attributes: Number(itemRow.is_group) ? parseJson(itemRow.attributes, []) : [],
      values: itemRow.group_id ? parseJson(itemRow.sub_values, {}) : null,
      createdAt: itemRow.created_at, updatedAt: itemRow.updated_at,
    };
  };
  /**
   * Telt bij een artikelgroep de subartikelen op: stand, gereserveerd,
   * beschikbaar, werkorders en waarde; onder het minimum als een subartikel dat is.
   * @param {object} articleGroup De artikelgroep (shapeItem).
   * @param {object[]} subartikelen Zijn subartikelen (shapeItem), zonder de gearchiveerde.
   * @param {number} orders Aantal verschillende werkorders met een reservering op een van de subartikelen.
   * @returns {object} De artikelgroep met de totalen en subItemCount.
   */
  const withTotals = (articleGroup, subItems, orders) => {
    /**
     * Telt een veld van alle subartikelen op.
     * @param {string} key Het veld, bijv. 'onHand'.
     * @returns {number} Het totaal.
     */
    const total = (key) => round3(subItems.reduce((sum, subItem) => sum + (subItem[key] || 0), 0));
    const values = subItems.filter((subItem) => subItem.value != null);
    return {
      ...articleGroup, onHand: total('onHand'), reserved: total('reserved'), available: total('available'),
      orders: Number(orders) || 0,
      value: values.length ? Math.round(values.reduce((sum, subItem) => sum + subItem.value, 0) * 100) / 100 : null,
      low: subItems.some((subItem) => subItem.low), subItemCount: subItems.length,
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
    const subItemsOf = new Map();
    for (const item of items) {
      if (!item.groupId || item.archived) continue;
      if (!subItemsOf.has(item.groupId)) subItemsOf.set(item.groupId, []);
      subItemsOf.get(item.groupId).push(item);
    }
    return items.map((item) => (item.isGroup ? withTotals(item, subItemsOf.get(item.id) || [], item.familyOrders) : item));
  }

  /**
   * Artikelrijen met het gereserveerde aantal (som over open werkorders), in één query.
   * Bij een artikelgroep en zijn subartikelen staat in familyOrders het aantal verschillende
   * werkorders over alle actieve subartikelen (een werkorder met twee maten telt één keer).
   * Met groupId tellen de reserveringen alleen voor die subartikelen (niet eerst alles van de omgeving).
   * @param {string} tenantId Id van de omgeving.
   * @param {{ archived?: boolean, groupId?: string|null }} [filters] Ook gearchiveerde; alleen de subartikelen van deze artikelgroep.
   * @returns {object[]} De artikelen (shapeItem met familyOrders), op code.
   */
  function listRows(tenantId, { archived = false, groupId = null } = {}) {
    const family = groupId ? String(groupId) : null;
    const reservedFilter = family ? ' AND item_id IN (SELECT id FROM stock_items WHERE tenant_id = ? AND group_id = ?)' : '';
    const familyFilter = family ? ' AND sibling.group_id = ?' : '';
    const args = [tenantId, ...(family ? [tenantId, family] : []), tenantId, tenantId, ...(family ? [family] : []), tenantId];
    let where = archived ? '' : ' AND i.archived = 0';
    if (family) { where += ' AND i.group_id = ?'; args.push(family); }
    return prepare(`SELECT i.id, i.code, i.name, i.unit, i.location, i.min_qty, i.reorder_qty, i.on_hand, i.cost_price, i.notes, i.archived, i.created_at, i.updated_at,
        i.sale_price, i.business_price, i.vat_rate, i.revenue_group, i.weight_grams, i.shop_sync, i.shop_product_id, i.shop_dirty, i.shop_synced_at, i.shop_error,
        i.order_pack_size, i.order_min_qty, i.price_tiers, i.unit_content, i.ean, i.price_mode, i.price_factor, i.group_id, i.is_group, i.attributes, i.sub_values, i.image_id, i.main_group_id, i.sub_group_id,
        COALESCE(r.qty, 0) AS reserved, COALESCE(r.orders, 0) AS orders, COALESCE(f.orders, 0) AS family_orders
      FROM stock_items i
      LEFT JOIN (SELECT item_id, SUM(qty) AS qty, COUNT(*) AS orders FROM stock_reservations WHERE tenant_id = ?${reservedFilter} GROUP BY item_id) r ON r.item_id = i.id
      LEFT JOIN (SELECT sibling.group_id, COUNT(DISTINCT COALESCE(family.work_order_id, family.web_order_id)) AS orders FROM stock_reservations family
          JOIN stock_items sibling ON sibling.id = family.item_id AND sibling.tenant_id = ?
          WHERE family.tenant_id = ? AND sibling.archived = 0 AND sibling.group_id IS NOT NULL${familyFilter} GROUP BY sibling.group_id) f
        ON f.group_id = COALESCE(i.group_id, i.id)
      WHERE i.tenant_id = ?${where} ORDER BY i.code`)
      .all(...args).map((itemRow) => ({ ...shapeItem(itemRow, itemRow.reserved, itemRow.orders), familyOrders: Number(itemRow.family_orders) || 0 }));
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
  const findCode = (tenantId, code) => {
    const normalized = normalizeCode(code);
    return prepare(`SELECT ${ITEM_COLS} FROM stock_items WHERE tenant_id = ? AND code = ?`).get(tenantId, normalized)
      // Een oude code van een omgezet artikel (zie code-conversion.js) wijst naar het artikel met de nieuwe code.
      || prepare(`SELECT ${ITEM_COLS} FROM stock_items WHERE tenant_id = ? AND id = (SELECT item_id FROM item_aliases WHERE tenant_id = ? AND kind = 'oud' AND LOWER(alias) = LOWER(?))`).get(tenantId, tenantId, normalized);
  };

  /**
   * Reserveringen met de werkorder erbij (nummer, titel, status, datum).
   * @param {string} tenantId Id van de omgeving.
   * @param {string|null} [itemId] Alleen van dit artikel.
   * @returns {object[]} De reserveringen.
   */
  function reservationsOf(tenantId, itemId = null) {
    const args = [tenantId];
    let sql = `SELECT r.item_id, COALESCE(r.work_order_id::text, 'order:' || r.web_order_id) AS work_order_id, r.qty, r.updated_at, COALESCE(w.number, o.number) AS number,
        COALESCE(w.title, CASE WHEN o.id IS NULL THEN NULL ELSE 'Webshopbestelling' END) AS title, COALESCE(w.customer, o.customer_name) AS customer,
        COALESCE(w.status, o.status) AS status, w.planned_date, i.code, i.name, i.unit
      FROM stock_reservations r JOIN stock_items i ON i.id = r.item_id
      LEFT JOIN work_orders w ON w.id = r.work_order_id AND w.tenant_id = r.tenant_id
      LEFT JOIN web_orders o ON o.id = r.web_order_id AND o.tenant_id = r.tenant_id
      WHERE r.tenant_id = ?`;
    if (itemId) { sql += ' AND r.item_id = ?'; args.push(String(itemId)); }
    return prepare(`${sql} ORDER BY w.planned_date, w.number`).all(...args).map((reservationRow) => ({
      itemId: reservationRow.item_id, code: reservationRow.code, name: reservationRow.name, unit: reservationRow.unit, qty: round3(reservationRow.qty), updatedAt: reservationRow.updated_at,
      workOrder: { id: reservationRow.work_order_id, number: reservationRow.number || '', title: reservationRow.title || '', customer: reservationRow.customer || '', status: reservationRow.status || '', plannedDate: reservationRow.planned_date || '' },
    }));
  }

  /**
   * Slaat de omschrijving en/of specificaties van een artikel op (alleen de meegestuurde velden).
   * Moet binnen de transactie van de aanroeper lopen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van het artikel.
   * @param {{ description?: string, specifications?: object[], seoTitle?: string, seoDescription?: string, brand?: string, deliveryRules?: object[], leadDays?: ?object }} fields De opgeschoonde velden (sanitizeItem).
   * @returns {void}
   */
  function saveDetails(tenantId, id, fields) {
    if (fields.description !== undefined) prepare('UPDATE stock_items SET description = ? WHERE tenant_id = ? AND id = ?').run(fields.description, tenantId, id);
    if (fields.specifications !== undefined) prepare('UPDATE stock_items SET specifications = ? WHERE tenant_id = ? AND id = ?').run(JSON.stringify(fields.specifications), tenantId, id);
    if (fields.seoTitle !== undefined) prepare('UPDATE stock_items SET seo_title = ? WHERE tenant_id = ? AND id = ?').run(fields.seoTitle, tenantId, id);
    if (fields.seoDescription !== undefined) prepare('UPDATE stock_items SET seo_description = ? WHERE tenant_id = ? AND id = ?').run(fields.seoDescription, tenantId, id);
    if (fields.brand !== undefined) prepare('UPDATE stock_items SET brand = ? WHERE tenant_id = ? AND id = ?').run(fields.brand, tenantId, id);
    if (fields.deliveryRules !== undefined) prepare('UPDATE stock_items SET delivery_rules = ? WHERE tenant_id = ? AND id = ?').run(JSON.stringify(fields.deliveryRules), tenantId, id);
    if (fields.leadDays !== undefined) prepare('UPDATE stock_items SET lead_days_min = ?, lead_days_max = ? WHERE tenant_id = ? AND id = ?').run(fields.leadDays ? fields.leadDays.min : null, fields.leadDays ? fields.leadDays.max : null, tenantId, id);
  }

  /**
   * Een artikel met zijn eigen omschrijving en specificaties en die van het gekoppelde webshopproduct, in één query
   * (voor de detailweergave; de overzichten halen deze grote kolommen niet op).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van het artikel.
   * @returns {object|undefined} De rij met ITEM_COLS plus description, specifications, shop_description en shop_attributes.
   */
  const findItemWithDetails = (tenantId, id) => prepare(`SELECT ${ITEM_COLS.split(', ').map((column) => `i.${column}`).join(', ')}, i.description, i.specifications, i.seo_title, i.seo_description, i.brand, i.delivery_rules, i.lead_days_min, i.lead_days_max, p.description AS shop_description, p.attributes AS shop_attributes
    FROM stock_items i LEFT JOIN shop_products p ON p.tenant_id = i.tenant_id AND p.id = i.shop_product_id
    WHERE i.tenant_id = ? AND i.id = ?`).get(tenantId, String(id));
  /**
   * De omschrijving en specificaties uit een rij van findItemWithDetails: de eigen en die van het webshopproduct
   * (wat de shop toont zolang het artikel er zelf geen heeft).
   * @param {object} row De rij.
   * @returns {{ description: string, specifications: object[], shopDescription: string, shopSpecifications: object[] }} De teksten.
   */
  const detailsOf = (row) => ({
    description: ItemDetails.sanitizeDescription(row.description), specifications: ItemDetails.specificationsOf(row.specifications),
    seoTitle: ItemDetails.sanitizeSeoTitle(row.seo_title), seoDescription: ItemDetails.sanitizeSeoDescription(row.seo_description), brand: ItemDetails.sanitizeBrand(row.brand),
    deliveryRules: DeliveryRules.sanitizeRules(row.delivery_rules), leadDays: row.lead_days_min == null ? null : { min: Number(row.lead_days_min), max: Number(row.lead_days_max) },
    shopDescription: ItemDetails.sanitizeDescription(row.shop_description), shopSpecifications: ItemDetails.specificationsFromShop(row.shop_attributes),
  });


  /**
   * Eén artikel met reserveringen en de laatste mutaties.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van het artikel.
   * @returns {object|null} Het artikel, of null.
   */
  function get(tenantId, id) {
    const itemRow = findItemWithDetails(tenantId, id);
    if (!itemRow) return null;
    if (Number(itemRow.is_group)) {
      // Artikelgroep: geen eigen voorraad, wel de subartikelen met hun totalen.
      const subItems = listRows(tenantId, { archived: true, groupId: itemRow.id });
      const articleGroup = withTotals(shapeItem(itemRow), subItems.filter((subItem) => !subItem.archived), subItems.length ? subItems[0].familyOrders : 0);
      return { ...articleGroup, ...detailsOf(itemRow), subItems, reservations: [], movements: [] };
    }
    const reservations = reservationsOf(tenantId, itemRow.id);
    const item = shapeItem(itemRow, reservations.reduce((sum, reservation) => sum + reservation.qty, 0), reservations.length);
    const movements = prepare(`SELECT ${MOVE_COLS} FROM stock_movements m WHERE m.tenant_id = ? AND m.item_id = ? ORDER BY m.created_at DESC, m.id LIMIT ${LIST_LIMIT}`)
      .all(tenantId, itemRow.id).map(shapeMove);
    const groupRow = itemRow.group_id ? prepare('SELECT id, code, name, attributes, archived FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, itemRow.group_id) : null;
    const articleGroup = groupRow ? { id: groupRow.id, code: groupRow.code, name: groupRow.name, attributes: parseJson(groupRow.attributes, []), archived: Boolean(groupRow.archived) } : null;
    const history = costs.historyOf(tenantId, itemRow.id);
    return { ...item, ...detailsOf(itemRow), articleGroup, reservations, movements, costPrices: history.prices, layers: history.layers };
  }

  /**
   * Een mutatie boeken: stand bijwerken en het logboek aanvullen. Binnen de
   * transactie van de aanroeper.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {number} delta Wijziging van de stand (negatief = eraf).
   * De voorraadlagen (FIFO) gaan mee: erbij wordt een laag met de inkoopprijs
   * (unitCost, anders bij een retour de prijs van de oorspronkelijke afboeking,
   * anders de actuele inkoopprijs), eraf gebruikt de oudste laag eerst.
   * @param {{ kind: string, workOrder?: object, source?: string, note?: string, user?: object, at?: string, unitCost?: number|null, costBasis?: { source?: string, workOrderId?: string } }} details
   *   Soort, werkorder, bron, opmerking, gebruiker, tijdstip, de inkoopprijs per eenheid (ontvangst) en bij een retour waar de afboeking vandaan kwam
   *   (standaard dezelfde bron of werkorder).
   * @returns {string} Id van de mutatie.
   * @throws {Error} Met code item_missing als het artikel niet (meer) bestaat.
   */
  function book(tenantId, itemId, delta, { kind, workOrder = null, source = '', note = '', user = null, at = currentTimestamp(), unitCost, costBasis }) {
    const before = prepare('SELECT id, on_hand, cost_price, created_at FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, itemId);
    if (!before) throw Object.assign(new Error('Het artikel van deze boeking bestaat niet meer.'), { code: 'item_missing', status: 409 });
    // Een verkoop in de webshop zelf (source 'webshop') hoeft niet terug.
    const toShop = source === 'webshop' ? 0 : 1;
    // Een ontvangst of telling betekent dat Aquatech de voorraad voortaan bijhoudt; een verkoop alleen niet.
    const manage = delta > 0 || kind === 'telling' ? 1 : 0;
    prepare(`UPDATE stock_items SET on_hand = on_hand + ?, updated_at = ?, stock_managed = CASE WHEN ? = 1 THEN 1 ELSE stock_managed END,
      shop_dirty = CASE WHEN shop_product_id IS NOT NULL AND shop_sync = 1 AND ? = 1 THEN 1 ELSE shop_dirty END
      WHERE tenant_id = ? AND id = ?`).run(round3(delta), at, manage, toShop, tenantId, itemId);
    if (toShop) dirty(tenantId);
    const balance = prepare('SELECT on_hand FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, itemId).on_hand;
    const id = crypto.randomUUID();
    prepare(`INSERT INTO stock_movements (id, tenant_id, item_id, kind, qty, balance, work_order_id, work_order_number, source, note, user_id, user_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, itemId, kind, round3(delta), round3(balance), workOrder ? workOrder.id : null, workOrder ? workOrder.number : '',
        source, cleanText(note, 300), user ? user.id : null, user ? cleanText(user.display_name || user.displayName, 120) : '', at);
    costs.record(tenantId, before, {
      movementId: id, delta, onHandBefore: Number(before.on_hand), kind, at, unitCost,
      costBasis: costBasis || { source, workOrderId: workOrder ? workOrder.id : null },
    });
    return id;
  }

  /**
   * Controleert of een EAN nog vrij is binnen de organisatie (vóór het opslaan, zodat er bij een fout niets half
   * wordt bewaard; een transactie terugdraaien gebeurt alleen bij een throw).
   * @param {string} tenantId Id van de omgeving.
   * @param {string|null} id Id van het artikel zelf (null bij een nieuw artikel).
   * @param {string|null} ean De opgeschoonde EAN (leeg = wissen, altijd goed).
   * @returns {object|null} { error, field, status } als de EAN al bij een ander artikel hoort, anders null.
   */
  function eanTaken(tenantId, id, ean) {
    if (!ean) return null;
    const other = id
      ? prepare('SELECT code FROM stock_items WHERE tenant_id = ? AND ean = ? AND id <> ?').get(tenantId, ean, id)
      : prepare('SELECT code FROM stock_items WHERE tenant_id = ? AND ean = ?').get(tenantId, ean);
    if (other) return { error: `Deze EAN hoort al bij artikel ${other.code}.`, field: 'ean', status: 409 };
    const packaging = prepare('SELECT i.code AS code FROM item_packagings p JOIN stock_items i ON i.tenant_id = p.tenant_id AND i.id = p.item_id WHERE p.tenant_id = ? AND p.ean = ?').get(tenantId, ean);
    return packaging ? { error: `Deze EAN hoort al bij een verpakking van artikel ${packaging.code}.`, field: 'ean', status: 409 } : null;
  }

  /**
   * Of een databasefout de unieke index op de EAN is (twee gelijktijdige aanvragen met dezelfde EAN).
   * @param {Error} error De fout.
   * @returns {boolean} true bij een dubbele EAN.
   */
  const isEanConflict = (error) => /stock_items_ean|stock_items\.ean/.test(String(error && error.message));

  /**
   * Voert een opslagactie uit en vertaalt een botsing op de unieke EAN-index naar dezelfde 409 als de controle vooraf.
   * @param {() => object} action De actie (een transactie).
   * @returns {object} De uitkomst van de actie, of { error, field, status } bij een dubbele EAN.
   */
  function withEanGuard(action) {
    try {
      return action();
    } catch (error) {
      if (isEanConflict(error)) return { error: 'Deze EAN hoort al bij een ander artikel.', field: 'ean', status: 409 };
      throw error;
    }
  }

  /**
   * Controleert of een code al als oud nummer (zoeknaam) van een ander artikel bestaat: één scan mag nooit naar twee artikelen wijzen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string|null} itemId Het artikel dat de code krijgt (null bij een nieuw artikel).
   * @param {string} code De nieuwe artikelcode.
   * @returns {object|null} { error, field, status } als de code een oud nummer van een ander artikel is, anders null.
   */
  function aliasTaken(tenantId, itemId, code) {
    const row = prepare('SELECT item_id FROM item_aliases WHERE tenant_id = ? AND LOWER(alias) = LOWER(?)').get(tenantId, code);
    if (!row || (itemId && row.item_id === itemId)) return null;
    return { error: 'Deze code is al een oud nummer van een ander artikel.', field: 'code', status: 409 };
  }

  /**
   * Zoekt de soort (en daarmee het merk) voor een artikel op, binnen de omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @param {*} subGroupId Het gekozen soort-id (leeg = geen soort).
   * @returns {{ subGroupId: string|null, mainGroupId: string|null }|{ error: string, field: string, status: number }} Het soort- en merk-id, of een fout.
   */
  function groupsOf(tenantId, subGroupId) {
    if (!subGroupId) return { subGroupId: null, mainGroupId: null };
    const row = prepare('SELECT id, main_group_id, archived FROM sub_groups WHERE tenant_id = ? AND id = ?').get(tenantId, String(subGroupId));
    if (!row) return { error: 'Deze soort bestaat niet.', field: 'subGroupId', status: 404 };
    if (row.archived) return { error: 'Deze soort is gearchiveerd.', field: 'subGroupId', status: 409 };
    return { subGroupId: row.id, mainGroupId: row.main_group_id || null };
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
    const out = withEanGuard(() => transaction(db, () => {
      if (findCode(tenantId, fields.code)) return { error: 'Er is al een voorraadartikel met deze code.', field: 'code', status: 409 };
      const aliasProblem = aliasTaken(tenantId, null, fields.code);
      if (aliasProblem) return aliasProblem;
      const eanProblem = eanTaken(tenantId, null, fields.ean);
      if (eanProblem) return eanProblem;
      const groups = groupsOf(tenantId, raw && raw.subGroupId);
      if (groups.error) return groups;
      rememberUnit(tenantId, fields.unit);
      const id = crypto.randomUUID();
      const timestamp = currentTimestamp();
      // Modus factor: de prijs volgt uit de inkoopprijs; zonder uitkomst (geen factor of inkoopprijs) blijft de ingevulde prijs staan.
      const factorPrice = fields.priceMode === 'factor' && pricer ? pricer(tenantId, { costPrice: fields.costPrice, priceFactor: fields.priceFactor ?? null }) : null;
      if (factorPrice !== null) fields.salePrice = factorPrice;
      prepare(`INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, reorder_qty, on_hand, cost_price, notes, archived, created_at, updated_at,
           sale_price, business_price, vat_rate, revenue_group, shop_sync, weight_grams, order_pack_size, order_min_qty, price_tiers, unit_content, ean, price_mode, price_factor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, fields.code, fields.name, fields.unit, fields.location, fields.minQty, fields.reorderQty, fields.costPrice, fields.notes, timestamp, timestamp, fields.salePrice, fields.businessPrice ?? null, fields.vatRate, fields.revenueGroup, fields.shopSync ? 1 : 0, fields.weightGrams ?? null, fields.packSize ?? 1, fields.orderMinQty ?? 1, JSON.stringify(fields.priceTiers || []), fields.unitContent ?? null, fields.ean || null, fields.priceMode || 'vast', fields.priceFactor ?? null);
      if (groups.subGroupId) prepare('UPDATE stock_items SET main_group_id = ?, sub_group_id = ? WHERE tenant_id = ? AND id = ?').run(groups.mainGroupId, groups.subGroupId, tenantId, id);
      if (fields.description || fields.specifications.length || fields.seoTitle || fields.seoDescription || fields.brand || fields.deliveryRules.length || fields.leadDays) saveDetails(tenantId, id, fields);
      costs.noteFormPrice(tenantId, id, null, fields.costPrice, user);
      const start = Number(raw && raw.onHand);
      if (Number.isFinite(start) && start > 0 && start <= MAX_QTY) book(tenantId, id, start, { kind: 'ontvangst', note: 'Beginvoorraad', user });
      return { id };
    }));
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
   * @param {object|null} [user] Wie het wijzigt (voor de prijshistorie).
   * @returns {object} { item, toShop }, of { error, field, status }.
   */
  function update(tenantId, id, raw, user = null) {
    const checked = sanitizeItem(raw, { partial: true });
    if (checked.error) return checked;
    const fields = checked.value;
    const out = withEanGuard(() => transaction(db, () => {
      const existing = findItem(tenantId, id);
      if (!existing) return { error: 'not_found', status: 404 };
      if (fields.code && fields.code !== existing.code) {
        // Een uitgegeven sprekende code (artikel met een soort) verandert nooit meer.
        if (existing.sub_group_id) return { error: 'De code van een artikel met een merk en soort is uitgegeven en verandert niet meer.', field: 'code', status: 409 };
        const aliasProblem = aliasTaken(tenantId, existing.id, fields.code);
        if (aliasProblem) return aliasProblem;
        // De code is de koppeling met werkorders en verbruik: alleen zolang er niets op geboekt is.
        if (findCode(tenantId, fields.code)) return { error: 'Er is al een voorraadartikel met deze code.', field: 'code', status: 409 };
        const used = prepare('SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = ? AND item_id = ? AND work_order_id IS NOT NULL) OR EXISTS (SELECT 1 FROM stock_reservations WHERE tenant_id = ? AND item_id = ?) AS n')
          .get(tenantId, existing.id, tenantId, existing.id).n;
        if (used) return { error: 'De code van een artikel dat al op werkorders is gereserveerd of afgeboekt, kan niet meer veranderen.', field: 'code', status: 409 };
      }
      // Een soort kiezen kan alleen als het artikel er nog geen heeft (en dan wordt de code vast); daarna niet meer wisselen.
      let groups = null;
      if (raw && raw.subGroupId !== undefined && (raw.subGroupId || null) !== (existing.sub_group_id || null)) {
        if (existing.sub_group_id) return { error: 'De soort van een artikel met een uitgegeven code verandert niet meer.', field: 'subGroupId', status: 409 };
        groups = groupsOf(tenantId, raw.subGroupId);
        if (groups.error) return groups;
      }
      const merged = {
        code: existing.code, name: existing.name, unit: existing.unit, location: existing.location, minQty: existing.min_qty, reorderQty: existing.reorder_qty, costPrice: existing.cost_price, notes: existing.notes,
        salePrice: existing.sale_price, businessPrice: existing.business_price ?? null, vatRate: Number(existing.vat_rate), revenueGroup: existing.revenue_group, shopSync: Boolean(Number(existing.shop_sync)), weightGrams: existing.weight_grams ?? null,
        packSize: Number(existing.order_pack_size) || 1, orderMinQty: Number(existing.order_min_qty) || 1, priceTiers: Wholesale.tiersOf(existing.price_tiers), unitContent: existing.unit_content ?? null,
        priceMode: existing.price_mode === 'factor' ? 'factor' : 'vast', priceFactor: existing.price_factor ?? null, ...fields,
      };
      // Modus factor: verandert de modus, de eigen factor of de inkoopprijs, dan volgt de verkoopprijs meteen (geen goedkeuring) en
      // komt de wijziging met oud, nieuw en bron in het auditlog.
      const costChanged = (merged.costPrice == null) !== (existing.cost_price == null) || Math.abs(Number(merged.costPrice ?? 0) - Number(existing.cost_price ?? 0)) > 0.00005;
      const factorChanged = merged.priceMode === 'factor' && (existing.price_mode !== 'factor' || (merged.priceFactor ?? null) !== (existing.price_factor ?? null) || costChanged);
      if (factorChanged && pricer && !Number(existing.is_group)) {
        const factorPrice = pricer(tenantId, { id: existing.id, costPrice: merged.costPrice, priceFactor: merged.priceFactor });
        if (factorPrice !== null) {
          merged.salePrice = factorPrice;
          logPriceChange(tenantId, existing, existing.sale_price, factorPrice, costChanged ? 'inkoopprijs' : 'artikelinstelling', user);
        }
      }
      // Een handmatig gewijzigde verkoopprijs bij modus factor (zonder wijziging van modus, factor of inkoopprijs) zou binnen een uur
      // worden teruggezet: de berekende prijs blijft staan (het formulier toont het veld dan alleen-lezen).
      if (!factorChanged && merged.priceMode === 'factor' && fields.salePrice !== undefined && pricer && !Number(existing.is_group)
        && pricer(tenantId, { id: existing.id, costPrice: merged.costPrice, priceFactor: merged.priceFactor }) !== null) {
        merged.salePrice = existing.sale_price;
      }
      const mergedTerms = Wholesale.sanitizeTerms(merged);
      if (mergedTerms.error) return { error: mergedTerms.error, field: mergedTerms.field, status: 400 };
      const archived = raw && raw.archived !== undefined ? (raw.archived ? 1 : 0) : existing.archived;
      const isGroup = Boolean(Number(existing.is_group));
      if (archived && !existing.archived) {
        const subItemIds = isGroup ? prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND group_id = ?').all(tenantId, existing.id).map((subItem) => subItem.id) : [];
        const held = heldByOrders(tenantId, [existing.id, ...subItemIds]);
        if (held) return held;
      }
      if (!archived && existing.archived && existing.group_id) {
        const groupRow = prepare('SELECT archived FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, existing.group_id);
        if (groupRow && groupRow.archived) return { error: 'Zet eerst de artikelgroep terug uit het archief.', status: 409 };
      }
      // EAN eerst controleren: na de UPDATE hieronder zou een fout de andere wijzigingen toch laten staan.
      const ean = fields.ean !== undefined ? (fields.ean || null) : (existing.ean || null);
      if (ean !== (existing.ean || null)) {
        if (ean && isGroup) return { error: 'Een artikelgroep met subartikelen heeft geen eigen EAN; geef elk subartikel een EAN.', field: 'ean', status: 400 };
        const eanProblem = eanTaken(tenantId, existing.id, ean);
        if (eanProblem) return eanProblem;
      }
      if (fields.unit) rememberUnit(tenantId, fields.unit);
      // Andere prijs of btw (of weer meesturen): opnieuw naar de webshop. Een
      // artikelgroep heeft in de webshop geen eigen prijs of voorraad.
      const toShop = !isGroup && ((merged.salePrice ?? null) !== (existing.sale_price ?? null) || merged.vatRate !== Number(existing.vat_rate) || (merged.shopSync && !Number(existing.shop_sync)));
      prepare(`UPDATE stock_items SET code = ?, name = ?, unit = ?, location = ?, min_qty = ?, reorder_qty = ?, cost_price = ?, notes = ?, archived = ?, archived_by_parent = 0, updated_at = ?,
           sale_price = ?, business_price = ?, vat_rate = ?, revenue_group = ?, shop_sync = ?, weight_grams = ?,
           order_pack_size = ?, order_min_qty = ?, price_tiers = ?, unit_content = ?, ean = ?, price_mode = ?, price_factor = ?,
           shop_dirty = CASE WHEN ? = 1 AND shop_product_id IS NOT NULL THEN 1 ELSE shop_dirty END
         WHERE tenant_id = ? AND id = ?`)
        .run(merged.code, merged.name, merged.unit, merged.location, merged.minQty, merged.reorderQty ?? null, merged.costPrice, merged.notes, archived, currentTimestamp(), merged.salePrice, merged.businessPrice, merged.vatRate, merged.revenueGroup, merged.shopSync ? 1 : 0, merged.weightGrams,
          merged.packSize, mergedTerms.orderMinQty, JSON.stringify(merged.priceTiers), merged.unitContent ?? null, ean, merged.priceMode, merged.priceFactor ?? null,
          toShop && merged.shopSync ? 1 : 0, tenantId, existing.id);
      if (groups && groups.subGroupId) prepare('UPDATE stock_items SET main_group_id = ?, sub_group_id = ? WHERE tenant_id = ? AND id = ?').run(groups.mainGroupId, groups.subGroupId, tenantId, existing.id);
      if (['description', 'specifications', 'seoTitle', 'seoDescription', 'brand', 'deliveryRules', 'leadDays'].some((key) => fields[key] !== undefined)) saveDetails(tenantId, existing.id, fields);
      // Een andere inkoopprijs komt als nieuwe regel in de historie (de oude blijft staan).
      costs.noteFormPrice(tenantId, existing.id, existing.cost_price, merged.costPrice, user);
      if (archived && !existing.archived) prepare('DELETE FROM stock_reservations WHERE tenant_id = ? AND item_id = ?').run(tenantId, existing.id);
      let subItemsToShop = false;
      if (isGroup) subItemsToShop = followGroup(tenantId, existing, merged, archived);
      return { item: get(tenantId, existing.id), toShop: toShop || subItemsToShop };
    }));
    if (out.toShop) dirty(tenantId);
    return out;
  }

  /**
   * Subartikelen volgen hun artikelgroep: eenheid, btw en omzetgroep worden
   * gelijk, en archiveren of terugzetten geldt voor alle subartikelen. Binnen de
   * transactie van update.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} existing De artikelgroep zoals het was.
   * @param {object} merged De nieuwe velden van de artikelgroep.
   * @param {number} archived 1 als de artikelgroep nu gearchiveerd is.
   * @returns {boolean} true als gekoppelde subartikelen opnieuw naar de webshop moeten (ander btw-tarief).
   */
  function followGroup(tenantId, existing, merged, archived) {
    const timestamp = currentTimestamp();
    const vatChanged = merged.vatRate !== Number(existing.vat_rate);
    prepare(`UPDATE stock_items SET unit = ?, vat_rate = ?, revenue_group = ?, updated_at = ?,
        shop_dirty = CASE WHEN ? = 1 AND shop_product_id IS NOT NULL AND shop_sync = 1 THEN 1 ELSE shop_dirty END
      WHERE tenant_id = ? AND group_id = ?`).run(merged.unit, merged.vatRate, merged.revenueGroup, timestamp, vatChanged ? 1 : 0, tenantId, existing.id);
    if (archived && !existing.archived) {
      prepare('DELETE FROM stock_reservations WHERE tenant_id = ? AND item_id IN (SELECT id FROM stock_items WHERE tenant_id = ? AND group_id = ?)').run(tenantId, tenantId, existing.id);
      prepare('UPDATE stock_items SET archived = 1, archived_by_parent = 1, updated_at = ? WHERE tenant_id = ? AND group_id = ? AND archived = 0').run(timestamp, tenantId, existing.id);
    } else if (!archived && existing.archived) {
      // Alleen de subartikelen die met de artikelgroep mee het archief in gingen; een los verwijderde subartikel blijft weg.
      const codes = prepare('SELECT code FROM stock_items WHERE tenant_id = ? AND group_id = ? AND archived_by_parent = 1').all(tenantId, existing.id).map((row) => row.code);
      prepare('UPDATE stock_items SET archived = 0, archived_by_parent = 0, updated_at = ? WHERE tenant_id = ? AND group_id = ? AND archived_by_parent = 1').run(timestamp, tenantId, existing.id);
      if (codes.length) resyncOpen(tenantId, codes, { nested: true });
    }
    return vatChanged;
  }

  /**
   * Zoekt de open webshopbestellingen die een van deze artikelen reserveren. Zo'n artikel mag niet weg of het archief in:
   * de bestelling kan anders niet meer worden verzonden.
   * @param {string} tenantId Id van de omgeving.
   * @param {string[]} itemIds Id's van de artikelen (het artikel zelf en zijn subartikelen).
   * @returns {{ error: string, status: number, orders: string[] }|null} De fout met de bestelnummers, of null als niets het tegenhoudt.
   */
  function heldByOrders(tenantId, itemIds) {
    if (!itemIds.length) return null;
    const numbers = prepare(`SELECT DISTINCT o.number FROM stock_reservations r
        JOIN web_orders o ON o.tenant_id = r.tenant_id AND o.id = r.web_order_id
      WHERE r.tenant_id = ? AND r.item_id IN (${itemIds.map(() => '?').join(', ')}) ORDER BY o.number`).all(tenantId, ...itemIds).map((row) => row.number);
    if (!numbers.length) return null;
    const shown = numbers.slice(0, 5).join(', ');
    return { error: `Dit artikel staat op ${numbers.length === 1 ? 'een open webshopbestelling' : 'open webshopbestellingen'} (${shown}${numbers.length > 5 ? ' en meer' : ''}). Verzend of annuleer die eerst.`, status: 409, orders: numbers };
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
    const moved = prepare(`SELECT (EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = ? AND item_id = ?)
      OR EXISTS (SELECT 1 FROM purchase_order_lines WHERE tenant_id = ? AND item_id = ?)
      OR EXISTS (SELECT 1 FROM stock_count_lines WHERE tenant_id = ? AND item_id = ?)) AS n`).get(tenantId, row.id, tenantId, row.id, tenantId, row.id).n;
    if (moved) {
      prepare('UPDATE stock_items SET archived = 1, archived_by_parent = 0, updated_at = ? WHERE tenant_id = ? AND id = ?').run(currentTimestamp(), tenantId, row.id);
      return true;
    }
    costs.removeItem(tenantId, row.id);
    prepare('DELETE FROM item_suppliers WHERE tenant_id = ? AND item_id = ?').run(tenantId, row.id);
    prepare('DELETE FROM item_packagings WHERE tenant_id = ? AND item_id = ?').run(tenantId, row.id);
    prepare('DELETE FROM item_aliases WHERE tenant_id = ? AND item_id = ?').run(tenantId, row.id);
    prepare('DELETE FROM item_documents WHERE tenant_id = ? AND item_id = ?').run(tenantId, row.id);
    prepare('DELETE FROM purchase_proposal_dismissals WHERE tenant_id = ? AND item_id = ?').run(tenantId, row.id);
    prepare('DELETE FROM item_text_drafts WHERE tenant_id = ? AND item_id = ?').run(tenantId, row.id);
    prepare('DELETE FROM stock_items WHERE tenant_id = ? AND id = ?').run(tenantId, row.id);
    return false;
  }

  /**
   * Verwijderen: zonder mutaties echt weg, anders gearchiveerd (het logboek
   * blijft). Een artikelgroep neemt zijn subartikelen mee; het blijft zelf
   * (gearchiveerd) bestaan zolang er een gearchiveerde subartikel is.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van het artikel.
   * @returns {object|null} { deleted, code } of { archived, code }, { error, status, orders } als een open webshopbestelling het artikel reserveert, of null.
   */
  function remove(tenantId, id) {
    return transaction(db, () => {
      const existing = findItem(tenantId, id);
      if (!existing) return null;
      let keepGroup = false;
      const subItems = Number(existing.is_group) ? prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND group_id = ?').all(tenantId, existing.id) : [];
      const held = heldByOrders(tenantId, [existing.id, ...subItems.map((subItem) => subItem.id)]);
      if (held) return held;
      for (const subItem of subItems) {
        if (removeRow(tenantId, subItem)) keepGroup = true;
      }
      if (keepGroup) {
        prepare('UPDATE stock_items SET archived = 1, updated_at = ? WHERE tenant_id = ? AND id = ?').run(currentTimestamp(), tenantId, existing.id);
        return { archived: true, code: existing.code };
      }
      return removeRow(tenantId, existing) ? { archived: true, code: existing.code } : { deleted: true, code: existing.code };
    });
  }

  /**
   * Maakt van een artikel een artikelgroep met kenmerken en maakt de subartikelen
   * aan die nog ontbreken (elke combinatie van waarden; een gearchiveerde
   * subartikel met dezelfde waarden komt terug). Subartikelen krijgen de code van het
   * artikelgroep met de waarden erachter (bijv. PE-BUIS-16MM) en nemen eenheid,
   * prijzen, btw, omzetgroep en webshopinstelling over. Een subartikel waarvan
   * een waarde is weggehaald gaat weg (met boekingen: gearchiveerd), net als
   * bij verwijderen. Kenmerken zonder subartikelen maken er weer een gewoon
   * artikel van.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van het artikel.
   * @param {*} rawAttributes De kenmerken: [{ name, values }].
   * @returns {object} { item, created, restored, removed }, of { error, field, status }.
   */
  function setSubItems(tenantId, id, rawAttributes) {
    const checked = sanitizeAttributes(rawAttributes);
    if (checked.error) return checked;
    const attributes = checked.value;
    const out = transaction(db, () => {
      const existing = findItem(tenantId, id);
      if (!existing) return { error: 'not_found', status: 404 };
      if (existing.group_id) return { error: 'Een subartikel kan zelf geen subartikelen hebben.', status: 409 };
      if (existing.archived) return { error: 'Dit artikel is gearchiveerd.', status: 409 };
      const subItems = prepare('SELECT id, code, archived, sub_values FROM stock_items WHERE tenant_id = ? AND group_id = ?').all(tenantId, existing.id);
      const live = subItems.filter((subItem) => !subItem.archived);
      if (!Number(existing.is_group)) {
        // Een gewoon artikel met voorraad of boekingen blijft dat: die voorraad hoort bij geen enkele maat.
        const used = Math.abs(Number(existing.on_hand)) > 0 || prepare('SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = ? AND item_id = ?) OR EXISTS (SELECT 1 FROM stock_reservations WHERE tenant_id = ? AND item_id = ?) AS n')
          .get(tenantId, existing.id, tenantId, existing.id).n;
        if (used && attributes.length) return { error: 'Dit artikel heeft al voorraad of boekingen. Maak een nieuw artikelgroep en zet de subartikelen daaronder.', status: 409 };
      }
      const timestamp = currentTimestamp();
      if (!attributes.length) {
        if (live.length) return { error: 'Verwijder eerst de subartikelen; daarna kan dit weer een gewoon artikel worden.', field: 'attributes', status: 409 };
        prepare("UPDATE stock_items SET is_group = 0, attributes = '', updated_at = ? WHERE tenant_id = ? AND id = ?").run(timestamp, tenantId, existing.id);
        return { created: [], restored: 0 };
      }
      const before = parseJson(existing.attributes, []).map((attribute) => attribute.name.toLowerCase()).join('|');
      if (live.length && before !== attributes.map((attribute) => attribute.name.toLowerCase()).join('|')) {
        return { error: 'Zolang er subartikelen zijn, kun je alleen waarden toevoegen of weghalen, niet de kenmerken zelf.', field: 'attributes', status: 409 };
      }
      const byKey = new Map(subItems.map((subItem) => [valuesKey(parseJson(subItem.sub_values, {})), subItem]));
      const taken = new Set(prepare('SELECT code FROM stock_items WHERE tenant_id = ?').all(tenantId).map((row) => row.code));
      const insert = prepare(`INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, on_hand, cost_price, notes, archived, created_at, updated_at,
          sale_price, business_price, vat_rate, revenue_group, shop_sync, group_id, sub_values, weight_grams)
        VALUES (?, ?, ?, ?, ?, '', 0, 0, ?, '', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const created = [];
      let restored = 0;
      let removed = 0;
      const wanted = combinations(attributes);
      const wantedKeys = new Set(wanted.map(valuesKey));
      // Een weggehaalde waarde: die subartikelen gaan weg (met boekingen: archief), net als bij verwijderen.
      const leaving = live.filter((subItem) => !wantedKeys.has(valuesKey(parseJson(subItem.sub_values, {}))));
      const held = heldByOrders(tenantId, leaving.map((subItem) => subItem.id));
      if (held) return { ...held, field: 'attributes' };
      for (const subItem of leaving) {
        removeRow(tenantId, subItem);
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
        insert.run(crypto.randomUUID(), tenantId, code, subItemName(existing.name, values), existing.unit, existing.cost_price, timestamp, timestamp,
          existing.sale_price, existing.business_price ?? null, existing.vat_rate, existing.revenue_group, existing.shop_sync, existing.id, JSON.stringify(values), existing.weight_grams ?? null);
        created.push(code);
      }
      // Een gekoppeld artikelgroep: de nieuwe subartikelen komen bij de volgende ronde in de webshop.
      prepare(`UPDATE stock_items SET is_group = 1, ean = NULL, attributes = ?, updated_at = ?,
          shop_dirty = CASE WHEN ? = 1 AND shop_product_id IS NOT NULL AND shop_sync = 1 THEN 1 ELSE shop_dirty END
        WHERE tenant_id = ? AND id = ?`).run(JSON.stringify(attributes), timestamp, created.length ? 1 : 0, tenantId, existing.id);
      prepare('DELETE FROM item_suppliers WHERE tenant_id = ? AND item_id = ?').run(tenantId, existing.id);
      prepare('DELETE FROM item_packagings WHERE tenant_id = ? AND item_id = ?').run(tenantId, existing.id);
      if (created.length) resyncOpen(tenantId, created, { nested: true });
      return { created, restored, removed, linked: Boolean(existing.shop_product_id && Number(existing.shop_sync)) };
    });
    if (out.error) return out;
    if (out.linked && out.created.length) dirty(tenantId);
    return { item: get(tenantId, id), created: out.created.length - out.restored, restored: out.restored, removed: out.removed };
  }

  /**
   * Stelt groepen losse artikelen voor die samen één variabel artikel kunnen worden
   * (zelfde omschrijving op de maat of kleur na, zelfde eenheid, btw en omzetgroep).
   * Eén query met alleen de nodige kolommen.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object[]} De voorstellen: attributeName, name, code en items (id, code, name, value).
   */
  function mergeSuggestions(tenantId) {
    const rows = prepare('SELECT id, code, name, unit, vat_rate, revenue_group, archived, group_id, is_group FROM stock_items WHERE tenant_id = ?').all(tenantId);
    const loose = rows.filter((row) => !row.archived && !row.group_id && !Number(row.is_group))
      .map((row) => ({ id: row.id, code: row.code, name: row.name, unit: row.unit, vatRate: Number(row.vat_rate ?? 21), revenueGroup: row.revenue_group || 'producten' }));
    return suggestGroups(loose, new Set(rows.map((row) => row.code)));
  }

  /**
   * Voegt losse artikelen samen tot de subartikelen van een nieuw artikelgroep. De
   * artikelen zelf blijven bestaan (zelfde id en code, dus werkorders, offertes,
   * facturen en bestellingen verwijzen nog naar hetzelfde artikel) en houden hun
   * voorraad, prijzen, afbeelding, boekingen en reserveringen; ze krijgen alleen
   * een artikelgroep en een waarde voor het kenmerk. De artikelgroep neemt eenheid,
   * btw, omzetgroep en prijzen van het eerste artikel (op code) over en neemt de
   * eerste afbeelding over. Is een artikel apart aan een webshopproduct gekoppeld,
   * dan vervalt die koppeling: de artikelgroep kan daarna met "In webshop zetten"
   * als één variabel product worden aangemaakt (het oude webshopproduct blijft in
   * de webshop staan tot je het daar weghaalt). Per samenvoeging komt een
   * momentopname in het logboek (stock_merges), zodat unmergeSubItems het kan terugdraaien.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ ids?: string[], code?: string, name?: string, attributeName?: string, values?: Object<string, string> }} raw De invoer: de artikelen, code en omschrijving van de artikelgroep, naam van het kenmerk en de waarde per artikel-id.
   * @param {{ refuseLinked?: boolean, shopMatchOf?: Function, user?: object }} [options] user: wie samenvoegt (voor het logboek); refuseLinked: weiger artikelen die aan een webshopproduct gekoppeld zijn (nodig als de webshop de artikellijst bepaalt: de volgende synchronisatie zou de subartikelen archiveren); shopMatchOf: functie artikelrij → webshopproduct of null, om ook artikelen te weigeren die via code of sku met een los webshopproduct samenvallen.
   * @returns {object} { groupId, merged, unlinked, shopProductIds } met het id van de nieuwe artikelgroep, het aantal samengevoegde artikelen, het aantal verbroken webshopkoppelingen en de id's van hun webshopproducten; of { error, field?, status }.
   */
  function mergeIntoGroup(tenantId, raw, { refuseLinked = false, shopMatchOf = null, user = null } = {}) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const ids = Array.isArray(input.ids) ? [...new Set(input.ids.map((id) => String(id)))] : [];
    if (ids.length < 2) return { error: 'Kies minstens twee artikelen om samen te voegen.', field: 'ids', status: 400 };
    if (ids.length > MAX_GROUP_SIZE) return { error: `Hooguit ${MAX_GROUP_SIZE} artikelen per keer.`, field: 'ids', status: 400 };
    const code = normalizeCode(input.code);
    if (code.length > 40 || !/^[A-Z0-9][A-Z0-9._\-/+ ]*$/.test(code)) return { error: 'Geef de artikelgroep een code (letters, cijfers en - . / +).', field: 'code', status: 400 };
    const name = cleanText(input.name, 200);
    if (!name) return { error: 'Geef de artikelgroep een omschrijving.', field: 'name', status: 400 };
    const attributeName = cleanText(input.attributeName, 40);
    if (!attributeName) return { error: 'Geef het kenmerk een naam (bijv. Maat of Kleur).', field: 'attributeName', status: 400 };
    const rawValues = input.values && typeof input.values === 'object' && !Array.isArray(input.values) ? input.values : {};
    const valueOf = new Map();
    const seen = new Set();
    for (const id of ids) {
      const value = cleanText(rawValues[id], 40);
      if (!value) return { error: 'Geef elk artikel een waarde voor het kenmerk (bijv. 16 mm).', field: 'values', status: 400 };
      if (seen.has(value.toLowerCase())) return { error: `De waarde ${value} komt twee keer voor; elk subartikel heeft een eigen waarde.`, field: 'values', status: 409 };
      seen.add(value.toLowerCase());
      valueOf.set(id, value);
    }
    return transaction(db, () => {
      const rows = prepare(`SELECT id, code, unit, location, cost_price, sale_price, business_price, vat_rate, revenue_group, shop_sync, shop_product_id, shop_price_seen, shop_stock_seen, shop_dirty, shop_error, image_id, archived, group_id, is_group
          FROM stock_items WHERE tenant_id = ? AND id IN (${placeholders(ids.length)})`).all(tenantId, ...ids);
      if (rows.length !== ids.length) return { error: 'not_found', status: 404 };
      for (const row of rows) {
        if (row.archived) return { error: `${row.code} is gearchiveerd.`, field: 'ids', status: 409 };
        if (row.group_id) return { error: `${row.code} is al een subartikel van een artikelgroep.`, field: 'ids', status: 409 };
        if (Number(row.is_group)) return { error: `${row.code} is zelf al een artikelgroep.`, field: 'ids', status: 409 };
      }
      if (refuseLinked) {
        const linked = rows.find((row) => row.shop_product_id || (shopMatchOf && shopMatchOf(row)));
        if (linked) return { error: `${linked.code} hangt aan (of komt overeen met) een webshopproduct en de webshop bepaalt de artikellijst. Zet in Beheer → Integraties → Webshop de REST API aan met "Aquatech is de bron" (dan zet Aquatech de artikelgroep zelf in de webshop), of zet "webshop bepaalt de artikellijst" uit.`, field: 'ids', status: 409 };
      }
      const first = [...rows].sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))[0];
      if (rows.some((row) => row.unit !== first.unit || Number(row.vat_rate) !== Number(first.vat_rate) || row.revenue_group !== first.revenue_group)) {
        return { error: 'De artikelen hebben niet dezelfde eenheid, btw en omzetgroep. Een subartikel volgt die van de artikelgroep; pas ze eerst aan.', field: 'ids', status: 409 };
      }
      if (findCode(tenantId, code)) return { error: 'Er is al een artikel met deze code.', field: 'code', status: 409 };
      const timestamp = currentTimestamp();
      const groupId = crypto.randomUUID();
      const attributes = [{ name: attributeName, values: ids.map((id) => valueOf.get(id)) }];
      const checked = sanitizeAttributes(attributes);
      if (checked.error) return checked;
      prepare(`INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, on_hand, cost_price, notes, archived, created_at, updated_at,
          sale_price, business_price, vat_rate, revenue_group, shop_sync, is_group, attributes, image_id)
        VALUES (?, ?, ?, ?, ?, '', 0, 0, ?, '', 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(groupId, tenantId, code, name, first.unit, first.cost_price, timestamp, timestamp, first.sale_price, first.business_price ?? null, first.vat_rate, first.revenue_group,
          rows.some((row) => Number(row.shop_sync) || row.shop_product_id) ? 1 : 0, JSON.stringify(checked.value), (rows.find((row) => row.image_id) || {}).image_id || null);
      let unlinked = 0;
      for (const row of rows) {
        // Een apart webshopproduct past niet bij een variatie: de koppeling vervalt, de artikelgroep wordt later als geheel aan de webshop gekoppeld.
        if (row.shop_product_id) unlinked++;
        prepare(`UPDATE stock_items SET group_id = ?, sub_values = ?, archived_by_parent = 0, updated_at = ?,
            shop_product_id = NULL, shop_price_seen = NULL, shop_stock_seen = NULL, shop_dirty = 0, shop_error = ''
          WHERE tenant_id = ? AND id = ?`).run(groupId, JSON.stringify({ [checked.value[0].name]: valueOf.get(row.id) }), timestamp, tenantId, row.id);
      }
      // Momentopname voor het terugdraaien: wat het samenvoegen aan de artikelen verandert (de webshopkoppeling).
      const snapshot = rows.map((row) => ({
        id: row.id, code: row.code, shopProductId: row.shop_product_id || null, shopPriceSeen: row.shop_price_seen ?? null,
        shopStockSeen: row.shop_stock_seen ?? null, shopDirty: Number(row.shop_dirty) || 0, shopError: row.shop_error || '',
      }));
      prepare('INSERT INTO stock_merges (id, tenant_id, group_id, group_code, group_name, snapshot, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), tenantId, groupId, code, name, JSON.stringify(snapshot), (user && user.id) || null, timestamp);
      // De webshopproducten van deze artikelen (gekoppeld, of via code/sku herkend): die worden na het samenvoegen vervangen door het ene variabele product.
      const shopProductIds = [...new Set(rows.map((row) => {
        const product = row.shop_product_id ? { id: row.shop_product_id } : shopMatchOf ? shopMatchOf(row) : null;
        return product && !product.parentId ? String(product.id) : '';
      }).filter(Boolean))];
      return { groupId, merged: rows.length, unlinked, shopProductIds };
    });
  }

  /**
   * De logboekregel van de samenvoeging waaruit een artikelgroep is ontstaan (de laatste die nog niet is teruggedraaid).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} groupId Id van de artikelgroep.
   * @returns {{ id: string, createdAt: string, snapshot: object[] }|null} De regel, of null als de artikelgroep niet via samenvoegen is gemaakt (of voor versie 1.5.9).
   */
  function mergeLogOf(tenantId, groupId) {
    const row = prepare('SELECT id, snapshot, created_at FROM stock_merges WHERE tenant_id = ? AND group_id = ? AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1').get(tenantId, groupId);
    return row ? { id: row.id, createdAt: row.created_at, snapshot: parseJson(row.snapshot, []) } : null;
  }

  /**
   * Controleert of een samenvoeging kan worden teruggedraaid en laat zien wat er gebeurt.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de artikelgroep.
   * @returns {object} { code, name, subartikelen: [{ code, name, value, archived, outcome }] (outcome: los, weg of gearchiveerd), logged, mergedAt, restoresLinks, blocked }; blocked is een tekst als terugdraaien nu niet kan (artikelgroep in de webshop, of een later bijgemaakte subartikel is gereserveerd); of { error, status }.
   */
  function unmergePreview(tenantId, id) {
    const articleGroup = findItem(tenantId, id);
    if (!articleGroup) return { error: 'not_found', status: 404 };
    if (!Number(articleGroup.is_group)) return { error: 'Dit is geen artikelgroep.', status: 409 };
    const children = prepare('SELECT id, code, name, sub_values, archived, shop_product_id FROM stock_items WHERE tenant_id = ? AND group_id = ? ORDER BY code').all(tenantId, articleGroup.id);
    const log = mergeLogOf(tenantId, articleGroup.id);
    const inLog = new Map((log ? log.snapshot : []).map((entry) => [entry.id, entry]));
    // Een na het samenvoegen bijgemaakte subartikel gaat weg, of wordt bij boekingen gearchiveerd: één query voor alle subartikelen.
    const extra = log ? children.filter((child) => !inLog.has(child.id)) : [];
    const moved = new Set(extra.length
      ? prepare(`SELECT DISTINCT item_id FROM stock_movements WHERE tenant_id = ? AND item_id IN (${placeholders(extra.length)})`).all(tenantId, ...extra.map((child) => child.id)).map((row) => row.item_id)
      : []);
    // Een reservering op een na het samenvoegen bijgemaakte subartikel zou bij het weghalen verdwijnen: dan blokkeren.
    const reserved = extra.length
      ? prepare(`SELECT 1 AS found FROM stock_reservations WHERE tenant_id = ? AND item_id IN (${placeholders(extra.length)}) LIMIT 1`).get(tenantId, ...extra.map((child) => child.id))
      : null;
    // Webshopkoppelingen uit de momentopname die nog vrij zijn; alleen die komen echt terug.
    const wantedLinks = [...new Set([...inLog.values()].map((entry) => entry.shopProductId).filter(Boolean))];
    const takenLinks = new Set(wantedLinks.length
      ? prepare(`SELECT shop_product_id FROM stock_items WHERE tenant_id = ? AND shop_product_id IN (${placeholders(wantedLinks.length)})`).all(tenantId, ...wantedLinks).map((row) => row.shop_product_id)
      : []);
    return {
      code: articleGroup.code,
      name: articleGroup.name,
      subItems: children.map((child) => ({
        code: child.code, name: child.name, value: Object.values(parseJson(child.sub_values, {})).join(' '), archived: Boolean(child.archived),
        outcome: !log || inLog.has(child.id) ? 'los' : moved.has(child.id) ? 'gearchiveerd' : 'weg',
      })),
      logged: Boolean(log),
      mergedAt: log ? log.createdAt : null,
      restoresLinks: children.filter((child) => {
        const shopProductId = inLog.get(child.id) && inLog.get(child.id).shopProductId;
        return shopProductId && !child.shop_product_id && !takenLinks.has(shopProductId);
      }).length,
      blocked: articleGroup.shop_product_id
        ? `${articleGroup.code} is aan een webshopproduct gekoppeld (bijv. via In webshop zetten). Haal dat product eerst uit de webshop of ontkoppel het; daarna kun je de samenvoeging terugdraaien.`
        : reserved ? 'Een na het samenvoegen bijgemaakt subartikel is gereserveerd voor een werkorder of bestelling. Handel die reservering eerst af of haal het subartikel van de werkorder; daarna kun je de samenvoeging terugdraaien.' : null,
    };
  }

  /**
   * Draait een samenvoeging terug: de subartikelen worden weer losse artikelen en het
   * artikelgroep verdwijnt. Id, code, omschrijving, prijzen, voorraad, afbeelding,
   * boekingen en reserveringen van de artikelen zijn nooit veranderd en blijven dus
   * zoals ze nu zijn (ook mutaties na het samenvoegen). Uit de momentopname komt
   * de webshopkoppeling terug (tenzij het artikel inmiddels een nieuwe koppeling heeft of het webshopproduct aan een ander
   * artikel hangt). Bij een artikelgroep zonder logboekregel (samengevoegd voor
   * 1.5.9) worden alleen de subartikelen losgemaakt; webshopkoppelingen kunnen dan niet
   * terugkomen. Een subartikel die na het samenvoegen is bijgemaakt gaat weg (met
   * boekingen: gearchiveerd en losgemaakt).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de artikelgroep.
   * @returns {object} { code, restored, removed, linksRestored, reconstructed }; of { error, status }.
   */
  function unmergeSubItems(tenantId, id) {
    const preview = unmergePreview(tenantId, id);
    if (preview.error) return preview;
    if (preview.blocked) return { error: preview.blocked, status: 409 };
    const out = transaction(db, () => {
      const articleGroup = findItem(tenantId, id);
      if (!articleGroup || !Number(articleGroup.is_group)) return { error: 'not_found', status: 404 };
      const log = mergeLogOf(tenantId, articleGroup.id);
      const inLog = new Map((log ? log.snapshot : []).map((entry) => [entry.id, entry]));
      const children = prepare('SELECT id, code, archived, archived_by_parent, shop_product_id FROM stock_items WHERE tenant_id = ? AND group_id = ?').all(tenantId, articleGroup.id);
      // Een na het samenvoegen bijgemaakte subartikel gaat weg; dat kan niet zolang een open webshopbestelling hem reserveert.
      const held = heldByOrders(tenantId, [articleGroup.id, ...(log ? children.filter((child) => !inLog.has(child.id)).map((child) => child.id) : [])]);
      if (held) return held;
      const reopened = [];
      const wantedLinks = [...new Set([...inLog.values()].map((entry) => entry.shopProductId).filter(Boolean))];
      const taken = new Set(wantedLinks.length
        ? prepare(`SELECT shop_product_id FROM stock_items WHERE tenant_id = ? AND shop_product_id IN (${placeholders(wantedLinks.length)})`).all(tenantId, ...wantedLinks).map((row) => row.shop_product_id)
        : []);
      const timestamp = currentTimestamp();
      let restored = 0;
      let removed = 0;
      let linksRestored = 0;
      for (const child of children) {
        if (log && !inLog.has(child.id)) {
          // Na het samenvoegen bijgemaakte subartikel: weg, of bij boekingen gearchiveerd en losgemaakt.
          if (removeRow(tenantId, child)) {
            prepare("UPDATE stock_items SET group_id = NULL, sub_values = '', archived_by_parent = 0 WHERE tenant_id = ? AND id = ?").run(tenantId, child.id);
          }
          removed++;
          continue;
        }
        if (child.archived && child.archived_by_parent) reopened.push(child.code);
        const entry = inLog.get(child.id);
        prepare(`UPDATE stock_items SET group_id = NULL, sub_values = '', archived = CASE WHEN archived_by_parent = 1 THEN 0 ELSE archived END,
            archived_by_parent = 0, updated_at = ? WHERE tenant_id = ? AND id = ?`).run(timestamp, tenantId, child.id);
        if (entry && entry.shopProductId && !child.shop_product_id && !taken.has(entry.shopProductId)) {
          prepare('UPDATE stock_items SET shop_product_id = ?, shop_price_seen = ?, shop_stock_seen = ?, shop_dirty = ?, shop_error = ? WHERE tenant_id = ? AND id = ?')
            .run(entry.shopProductId, entry.shopPriceSeen, entry.shopStockSeen, 1, '', tenantId, child.id);
          taken.add(entry.shopProductId);
          linksRestored++;
        }
        restored++;
      }
      removeRow(tenantId, articleGroup);
      // Subartikelen die door het gearchiveerde artikelgroep waren gearchiveerd (reserveringen weg) zijn weer actief: werkorders opnieuw laten reserveren.
      if (reopened.length) resyncOpen(tenantId, reopened, { nested: true });
      if (log) prepare('UPDATE stock_merges SET undone_at = ? WHERE tenant_id = ? AND id = ?').run(timestamp, tenantId, log.id);
      return { code: articleGroup.code, restored, removed, linksRestored, reconstructed: !log };
    });
    // Herstelde webshopkoppelingen krijgen bij de volgende ronde de actuele prijs en voorraad.
    if (out.linksRestored) dirty(tenantId);
    return out;
  }

  /**
   * De artikellijst om uit te kiezen (werkorder, offerte): gewone artikelen en
   * artikelgroepen met hun subartikelen, met verkoopprijs en beschikbaar aantal;
   * zonder inkoopprijs of andere interne velden. Gearchiveerde artikelen niet.
   * @param {string} tenantId Id van de omgeving.
   * @returns {object[]} code, name, unit, salePrice, vatRate en available; een artikelgroep ook attributes en subartikelen (met values).
   */
  function articleChoices(tenantId) {
    const items = listRows(tenantId);
    const aliasRows = prepare('SELECT item_id, alias FROM item_aliases WHERE tenant_id = ?').all(tenantId);
    const aliasesOf = new Map();
    for (const row of aliasRows) aliasesOf.set(row.item_id, [...(aliasesOf.get(row.item_id) || []), row.alias]);
    /**
     * De velden van een artikel die de keuzelijst nodig heeft.
     * @param {object} item Het artikel (shapeItem).
     * @returns {object} code, name, unit, salePrice, vatRate en available.
     */
    const pick = (item) => ({ code: item.code, name: item.name, unit: item.unit, salePrice: item.salePrice, vatRate: item.vatRate, available: item.available, ...(aliasesOf.has(item.id) ? { aliases: aliasesOf.get(item.id) } : {}) });
    const articleGroups = new Map(items.filter((item) => item.isGroup).map((item) => [item.id, { ...pick(item), attributes: item.attributes, subItems: [] }]));
    const out = [];
    for (const item of items) {
      if (item.isGroup) out.push(articleGroups.get(item.id));
      else if (item.groupId && articleGroups.has(item.groupId)) articleGroups.get(item.groupId).subItems.push({ ...pick(item), values: item.values });
      else out.push(pick(item));
    }
    // Subartikelen van klein naar groot, gelezen uit de code (diameter, dan draadmaat).
    for (const articleGroup of articleGroups.values()) articleGroup.subItems.sort((left, right) => ArticleCode.compareCodes(left.code, right.code));
    for (const articleGroup of articleGroups.values()) articleGroup.available = round3(articleGroup.subItems.reduce((sum, subItem) => sum + subItem.available, 0));
    return out;
  }

  /**
   * Mutatie op het artikel: ontvangst (aantal > 0), correctie (+ of −) of
   * telling (het getelde aantal; de stand wordt dat).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} user Wie boekt.
   * @param {string} id Id van het artikel.
   * Bij een ontvangst kan de inkoopprijs per eenheid mee (unitCost): die komt op de
   * voorraadlaag en wordt, als hij anders is, de nieuwe inkoopprijs (de oude blijft in de historie).
   * @param {{ kind: string, qty: number, note?: string, unitCost?: number|string }} raw De mutatie.
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
    const hasCost = kind === 'ontvangst' && input.unitCost !== undefined && input.unitCost !== null && input.unitCost !== '';
    const checkedCost = hasCost ? parsePrice(input.unitCost) : { value: undefined };
    if (checkedCost.error) return { error: checkedCost.error, field: 'unitCost' };
    return transaction(db, () => {
      const existing = findItem(tenantId, id);
      if (!existing) return { error: 'not_found', status: 404 };
      if (existing.archived) return { error: 'Dit artikel is gearchiveerd.', status: 409 };
      if (Number(existing.is_group)) return { error: 'Een artikelgroep heeft zelf geen voorraad: boek op een subartikel.', status: 409 };
      const delta = kind === 'telling' ? round3(qty - existing.on_hand) : round3(qty);
      const movementId = book(tenantId, existing.id, delta, { kind, note: kind === 'telling' ? note || `Geteld: ${round3(qty)}` : note, user, unitCost: checkedCost.value });
      if (hasCost && (existing.cost_price == null || Math.abs(Number(existing.cost_price) - checkedCost.value) > 0.00005)) {
        costs.addPrice(tenantId, existing, { price: checkedCost.value, note: `Bij ontvangst${note ? `: ${note}` : ''}`, user });
        repriceItem(tenantId, existing.id, 'ontvangst', user);
      }
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
   * aanroeper). Een variabel product wordt een artikelgroep met kenmerken, zijn
   * variaties worden subartikelen eronder; een variatie komt pas na zijn product.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ product: object, code: string }[]} fresh De nieuwe producten met hun voorraadcode.
   * @param {Map<string, object>} groupItems Bestaande artikelgroepen per webshop-product-id ({ id, name, is_group, attributes }).
   * @param {{ vatRate: number, priceOf: Function }} options Btw-tarief van nieuwe artikelen en product → verkoopprijs excl. btw.
   * @returns {{ codes: string[], skipped: number, skippedEntries: object[] }} De codes van de nieuwe artikelen, het aantal overgeslagen variaties en die variaties zelf.
   */
  function insertShopProducts(tenantId, fresh, groupItems, { vatRate, priceOf }) {
    const timestamp = currentTimestamp();
    const put = prepare(`INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, on_hand, cost_price, notes, archived, created_at, updated_at,
        sale_price, vat_rate, revenue_group, shop_sync, shop_product_id, group_id, is_group, attributes, sub_values, stock_managed)
      VALUES (?, ?, ?, ?, 'st', '', 0, 0, NULL, '', 0, ?, ?, ?, ?, 'producten', 1, ?, ?, ?, ?, ?, ?)`);
    const codes = [];
    const skippedEntries = [];
    let skipped = 0;
    const ordered = [...fresh.filter((entry) => !entry.product.parentId), ...fresh.filter((entry) => entry.product.parentId)];
    for (const { product, code } of ordered) {
      const entry = { product, code };
      const price = priceOf(product);
      const salePrice = price == null ? null : Math.round(price * 100) / 100;
      // Geen aantal in de webshop (geen voorraadbeheer daar): Aquatech houdt de voorraad nog niet bij, de status volgt de webshop.
      const managed = product.stockQty == null ? 0 : 1;
      if (product.type === 'variable') {
        const attributes = shopAttributesOf(product);
        const id = crypto.randomUUID();
        put.run(id, tenantId, code, cleanText(product.name, 200) || code, timestamp, timestamp, null, vatRate, String(product.id), null, 1, JSON.stringify(attributes), '', 1);
        groupItems.set(String(product.id), { id, name: cleanText(product.name, 200) || code, is_group: 1, attributes: JSON.stringify(attributes) });
      } else if (product.parentId) {
        const articleGroup = groupItems.get(String(product.parentId));
        if (!articleGroup || !Number(articleGroup.is_group)) { skipped++; skippedEntries.push(entry); continue; }
        const values = {};
        for (const attribute of product.attributes || []) if (attribute.name && attribute.option) values[cleanText(attribute.name, 40)] = cleanText(attribute.option, 40);
        put.run(crypto.randomUUID(), tenantId, code, Object.keys(values).length ? subItemName(articleGroup.name, values) : cleanText(product.name, 200) || code, timestamp, timestamp,
          salePrice, vatRate, String(product.id), articleGroup.id, 0, '', JSON.stringify(values), managed);
      } else {
        put.run(crypto.randomUUID(), tenantId, code, cleanText(product.name, 200) || code, timestamp, timestamp, salePrice, vatRate, String(product.id), null, 0, '', '', managed);
      }
      codes.push(code);
    }
    return { codes, skipped, skippedEntries };
  }

  /**
   * Maakt van een bestaand gewoon artikel dat aan een variabel webshopproduct
   * gekoppeld is (van vóór de subartikelen) een artikelgroep, zodat de variaties
   * eronder kunnen komen. Alleen als het artikel geen voorraad, boekingen of
   * reserveringen heeft; anders krijgt het een melding en blijft het zoals het
   * is. Binnen een lopende transactie.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} item Het artikel (id); wordt bij omzetten bijgewerkt (is_group, attributes).
   * @param {object} product Het variabele webshopproduct.
   * @returns {boolean} true als het artikel nu een artikelgroep is.
   */
  function promoteToGroup(tenantId, item, product) {
    const row = prepare('SELECT on_hand, group_id, is_group FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, item.id);
    if (!row || row.group_id) return false;
    if (Number(row.is_group)) return true;
    const used = Math.abs(Number(row.on_hand)) > 0 || prepare('SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = ? AND item_id = ?) OR EXISTS (SELECT 1 FROM stock_reservations WHERE tenant_id = ? AND item_id = ?) AS n')
      .get(tenantId, item.id, tenantId, item.id).n;
    if (used) {
      prepare('UPDATE stock_items SET shop_error = ? WHERE tenant_id = ? AND id = ?')
        .run('In de webshop is dit een product met variaties, maar dit artikel heeft voorraad of boekingen. Maak een nieuw artikelgroep en zet de subartikelen daaronder.', tenantId, item.id);
      return false;
    }
    const attributes = JSON.stringify(shopAttributesOf(product));
    prepare('UPDATE stock_items SET is_group = 1, ean = NULL, attributes = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(attributes, currentTimestamp(), tenantId, item.id);
    prepare('DELETE FROM item_suppliers WHERE tenant_id = ? AND item_id = ?').run(tenantId, item.id);
    prepare('DELETE FROM item_packagings WHERE tenant_id = ? AND item_id = ?').run(tenantId, item.id);
    prepare('DELETE FROM item_text_drafts WHERE tenant_id = ? AND item_id = ?').run(tenantId, item.id);
    item.is_group = 1;
    item.attributes = attributes;
    return true;
  }

  /**
   * Bestaande artikelen die bij een variabel webshopproduct horen, per product-id.
   * @param {string} tenantId Id van de omgeving.
   * @returns {Map<string, object>} id, name, is_group en attributes per webshop-product-id.
   */
  const groupItemsOf = (tenantId) => new Map(prepare('SELECT id, name, is_group, attributes, shop_product_id FROM stock_items WHERE tenant_id = ? AND group_id IS NULL AND shop_product_id IS NOT NULL')
    .all(tenantId).map((row) => [String(row.shop_product_id), row]));

  /**
   * Producten uit de webshop als voorraadartikel overnemen (nog niet bestaande
   * codes). Code = het veld aquatech_code, de sku of WC-<id>; prijs = de webshopprijs
   * (excl. btw). Een variabel product neemt zijn variaties mee als subartikelen.
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
    if (chosen.some((product) => product.type === 'unknown')) return { error: 'Synchroniseer eerst de webshop opnieuw (Beheer → Integraties → Webshop); van een of meer producten is het type nog onbekend.', field: 'ids' };
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
      const groupItems = groupItemsOf(tenantId);
      // Een eerder als gewoon artikel overgenomen variabel product wordt (als dat veilig kan) een artikelgroep.
      for (const product of chosen) {
        const item = product.type === 'variable' && groupItems.get(String(product.id));
        if (item && !Number(item.is_group)) promoteToGroup(tenantId, item, product);
      }
      return insertShopProducts(tenantId, todo, groupItems, { vatRate: 21, priceOf: (product) => product.price });
    });
    if (out.codes.length) resyncOpen(tenantId, out.codes);
    return { created: out.codes.length, existing: have.size, skipped };
  }

  /**
   * Maakt de voorraadlijst gelijk aan de webshop: elk webshopproduct met een
   * code of sku wordt een voorraadartikel (nieuw, of een gearchiveerd artikel
   * komt terug), artikelen die niet in de webshop staan worden gearchiveerd
   * (nooit verwijderd: werkorders, offertes en facturen houden hun regels).
   * Een variabel product wordt een artikelgroep, zijn variaties subartikelen; nieuwe
   * waarden van een kenmerk in de webshop komen bij de artikelgroep.
   * @param {string} tenantId Id van de omgeving.
   * @param {object[]} products Alle producten uit de webshop (met variaties).
   * @param {Function} matchProduct Functie item ({ code }) → webshopproduct of null.
   * @param {{ vatRate?: number, priceOf?: Function }} [options] Btw-tarief van nieuwe artikelen en product → verkoopprijs excl. btw.
   * @returns {{ created: number, restored: number, archived: number, skippedProducts: number }} Aantallen.
   */
  function mirrorShop(tenantId, products, matchProduct, { vatRate = 21, priceOf = (product) => product.price } = {}) {
    const items = prepare('SELECT id, code, name, archived, shop_product_id, group_id, is_group, attributes FROM stock_items WHERE tenant_id = ?').all(tenantId);
    const timestamp = currentTimestamp();
    const matchedProducts = new Set();
    const groupItems = new Map();
    const restore = [];
    const archive = [];
    const attributeUpdates = [];
    const legacyGroup = [];
    const seenCodes = new Set(items.map((item) => item.code));
    for (const item of items) {
      const product = matchProduct(item);
      if (product) {
        matchedProducts.add(String(product.id));
        if (item.archived) restore.push(item);
        if (!product.parentId) groupItems.set(String(product.id), item);
        if (product.type === 'variable' && !Number(item.is_group) && !item.group_id) legacyGroup.push({ item, product });
        else if (product.type === 'variable' && Number(item.is_group)) {
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
      // Van vóór de subartikelen: een gewoon artikel bij een variabel product wordt (als dat veilig kan) een artikelgroep.
      for (const { item, product } of legacyGroup) promoteToGroup(tenantId, item, product);
      const inserted = insertShopProducts(tenantId, fresh, groupItems, { vatRate, priceOf });
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
   * TIJDELIJK (alleen zolang WooCommerce nog draait): maakt een artikel voor elk webshopproduct dat er nog geen heeft.
   * Raakt bestaande artikelen niet aan, behalve dat een gearchiveerd los artikel met dezelfde code als een webshopproduct wordt teruggezet en aan dat product gekoppeld. Een product telt als
   * aanwezig als een artikel eraan gekoppeld is of dezelfde code of sku heeft (zie `matchProduct`).
   * @param {string} tenantId Id van de omgeving.
   * @param {object[]} products Alle producten uit de webshop (met variaties).
   * @param {Function} matchProduct Functie item ({ code }) → webshopproduct of null.
   * @param {{ vatRate?: number, priceOf?: Function, onProgress?: Function }} [options] Btw-tarief van nieuwe artikelen, product → verkoopprijs excl. btw en onProgress (krijgt { step: 'toevoegen', total, created, skipped, added: [{ code, name }] } na elke portie van 50).
   * @returns {{ created: number, restored: number, restoredItems: object[], skippedProducts: number, skippedList: object[] }} Aantallen, de teruggezette gearchiveerde artikelen { code, name, productId } en per overgeslagen product { productId, sku, code, name, reason, url }.
   */
  function addMissingShop(tenantId, products, matchProduct, { vatRate = 21, priceOf = (product) => product.price, onProgress = null } = {}) {
    const items = prepare('SELECT id, code, name, shop_product_id, group_id, is_group, attributes, archived FROM stock_items WHERE tenant_id = ?').all(tenantId);
    const matchedProducts = new Set();
    const groupItems = new Map();
    const itemsByCode = new Map(items.map((item) => [item.code, item]));
    const seenCodes = new Map();
    for (const item of items) {
      const product = matchProduct(item);
      if (!product) continue;
      matchedProducts.add(String(product.id));
      if (!product.parentId) groupItems.set(String(product.id), item);
    }
    const productIds = new Set(products.map((product) => String(product.id)));
    const fresh = [];
    const skippedList = [];
    const restoredList = [];
    /**
     * Beschrijft een bestaand artikel dat de code al heeft, voor de reden bij een overgeslagen product.
     * @param {object} item Het bestaande artikel.
     * @returns {string} De reden in gewone taal.
     */
    const existingReason = (item) => {
      if (item.group_id) return `bestaat al als ${item.archived ? 'gearchiveerd ' : ''}subartikel «${item.name}» van een artikelgroep (niet aan dit webshopproduct gekoppeld)`;
      return `bestaat al als ${item.archived ? 'gearchiveerd ' : ''}artikel «${item.name}»`;
    };
    /**
     * Zet een overgeslagen webshopproduct met de reden in de lijst.
     * @param {object} product Het webshopproduct.
     * @param {string} code De voorgestelde voorraadcode.
     * @param {string} reason De reden in gewone taal.
     * @returns {void}
     */
    const skip = (product, code, reason) => skippedList.push({ productId: String(product.id), sku: product.sku || '', code, name: cleanText(product.name, 200), reason, url: product.url || product.permalink || '' });
    for (const product of products) {
      if (matchedProducts.has(String(product.id))) continue;
      const code = shopCodeOf(product);
      let reason = '';
      if (!code) reason = 'geen code of sku';
      else if (code.length > 40) reason = `code langer dan 40 tekens (${code.length})`;
      else if (!/^[A-Z0-9][A-Z0-9 ._\-/+]*$/.test(code)) reason = 'code bevat tekens die niet mogen (toegestaan: letters, cijfers, spatie en . _ - / +)';
      else if (itemsByCode.has(code)) {
        const owner = itemsByCode.get(code);
        const simpleProduct = !product.parentId && product.type !== 'variable';
        const linkedElsewhere = owner.shop_product_id && String(owner.shop_product_id) !== String(product.id) && productIds.has(String(owner.shop_product_id));
        // Een gearchiveerd artikel (los of subartikel) of een subartikel zonder koppeling met deze code is het ontbrekende artikel: terugzetten en koppelen in plaats van overslaan.
        const needsAction = Number(owner.archived) || (owner.group_id && !owner.shop_product_id);
        if (simpleProduct && needsAction && !Number(owner.is_group) && !linkedElsewhere) { restoredList.push({ owner, product, code, sub: Boolean(owner.group_id) }); itemsByCode.delete(code); seenCodes.set(code, 'komt dubbel voor in de webshop (zelfde sku bij een ander product)'); continue; }
        reason = `code ${existingReason(owner)}`;
      } else if (seenCodes.has(code)) reason = `code ${seenCodes.get(code)}`;
      else if (product.parentId && !productIds.has(String(product.parentId))) reason = 'het hoofdproduct van deze variatie staat niet in de webshoplijst';
      if (reason) { skip(product, code, reason); continue; }
      seenCodes.set(code, 'komt dubbel voor in de webshop (zelfde sku bij een ander product)');
      fresh.push({ product, code });
    }
    if (restoredList.length) {
      transaction(db, () => {
        // Een los artikel gaat mee met de webshop (shop_sync = 1). Een subartikel wordt alleen gekoppeld (shop_sync = 0): zo schrijft de synchronisatie er nooit naar de webshop; de koppeling dient voor de orderhistorie.
        const restoreLoose = prepare('UPDATE stock_items SET archived = 0, shop_product_id = ?, shop_sync = 1, updated_at = ? WHERE tenant_id = ? AND id = ?');
        const restoreSub = prepare('UPDATE stock_items SET archived = 0, archived_by_parent = 0, shop_product_id = ?, shop_sync = 0, updated_at = ? WHERE tenant_id = ? AND id = ?');
        const reopenGroup = prepare('UPDATE stock_items SET archived = 0, updated_at = ? WHERE tenant_id = ? AND id = ? AND archived = 1');
        for (const entry of restoredList) {
          const timestamp = currentTimestamp();
          if (!entry.sub) { restoreLoose.run(String(entry.product.id), timestamp, tenantId, entry.owner.id); continue; }
          restoreSub.run(String(entry.product.id), timestamp, tenantId, entry.owner.id);
          reopenGroup.run(timestamp, tenantId, entry.owner.group_id);
        }
        resyncOpen(tenantId, restoredList.map((entry) => entry.code), { nested: true });
      });
    }
    const restoredItems = restoredList.map((entry) => ({ code: entry.code, name: cleanText(entry.product.name, 200) || entry.code, productId: String(entry.product.id), kind: `${entry.sub ? 'subartikel' : 'los artikel'}${Number(entry.owner.archived) ? ', teruggezet uit archief' : ', gekoppeld'}` }));
    if (onProgress) onProgress({ step: 'overgeslagen', items: skippedList, restored: restoredItems });
    // Hoofdproducten eerst, dan de variaties; in porties van 50 (elk in een eigen transactie), zodat de voortgang zichtbaar is.
    const ordered = [...fresh.filter((entry) => !entry.product.parentId), ...fresh.filter((entry) => entry.product.parentId)];
    let created = 0;
    for (let start = 0; start < ordered.length; start += 50) {
      const chunk = ordered.slice(start, start + 50);
      transaction(db, () => {
        const inserted = insertShopProducts(tenantId, chunk, groupItems, { vatRate, priceOf });
        created += inserted.codes.length;
        for (const entry of inserted.skippedEntries) skip(entry.product, entry.code, 'de variatie hoort bij een hoofdproduct dat niet als artikelgroep is toegevoegd');
        if (inserted.codes.length) resyncOpen(tenantId, inserted.codes, { nested: true });
        if (onProgress) {
          const names = new Map(chunk.map((entry) => [entry.code, cleanText(entry.product.name, 200) || entry.code]));
          onProgress({ step: 'toevoegen', total: ordered.length, created, skipped: skippedList.length, added: inserted.codes.map((code) => ({ code, name: names.get(code) })) });
        }
      });
    }
    if (onProgress && !ordered.length) onProgress({ step: 'toevoegen', total: 0, created: 0, skipped: skippedList.length, added: [] });
    return { created, restored: restoredItems.length, restoredItems, skippedProducts: skippedList.length, skippedList };
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
    ? prepare(`SELECT ${ITEM_COLS} FROM stock_items WHERE tenant_id = ? AND archived = 0 AND is_group = 0 AND code IN (${placeholders(codes.length)})`).all(tenantId, ...codes) : []);
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

  // ---------- Webshopbestellingen: reserveren en afboeken ----------
  /**
   * Reserveert voorraad voor een webshopbestelling. De reservering staat in
   * stock_reservations onder web_order_id (een bestelling, naast work_order_id voor een werkorder), dus elke
   * beschikbaarheidsberekening houdt er rekening mee. Moet binnen de
   * transactie van de aanroeper lopen.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @param {{ itemId: string, qty: number }[]} lines Artikel en aantal.
   * @returns {void}
   */
  function reserveOrder(tenantId, orderId, lines) {
    const put = prepare('INSERT INTO stock_reservations (tenant_id, web_order_id, item_id, qty, updated_at) VALUES (?, ?, ?, ?, ?)');
    const timestamp = currentTimestamp();
    for (const line of lines) put.run(tenantId, String(orderId), line.itemId, round3(line.qty), timestamp);
    dirty(tenantId);
  }

  /**
   * Welke artikelen niet genoeg vrije voorraad hebben voor deze regels: stand min wat anderen gereserveerd hebben (de
   * eigen reservering telt niet mee). Artikelen zonder voorraadbeheer tellen niet. Eén query.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ itemId: string, qty: number }[]} lines Artikel en aantal.
   * @param {string} ownKey De eigen reservering (bijv. `order:<id>`), die niet meetelt.
   * @returns {{ id: string, name: string, needed: number, free: number }[]} De artikelen met te weinig vrije voorraad.
   */
  function shortageFor(tenantId, lines, ownKey) {
    const needed = new Map();
    for (const line of lines || []) if (line.itemId) needed.set(line.itemId, round3((needed.get(line.itemId) || 0) + Number(line.qty || 0)));
    if (!needed.size) return [];
    const ids = [...needed.keys()];
    const rows = prepare(`SELECT i.id, i.name, i.on_hand, i.stock_managed,
        (SELECT COALESCE(SUM(r.qty), 0) FROM stock_reservations r WHERE r.tenant_id = i.tenant_id AND r.item_id = i.id AND COALESCE(r.work_order_id::text, 'order:' || r.web_order_id) <> ?) AS reserved
      FROM stock_items i WHERE i.tenant_id = ? AND i.id IN (${ids.map(() => '?').join(', ')})`).all(String(ownKey), tenantId, ...ids);
    return rows
      .filter((itemRow) => itemRow.stock_managed === undefined || Number(itemRow.stock_managed))
      .map((itemRow) => ({ id: itemRow.id, name: itemRow.name, needed: needed.get(itemRow.id), free: round3(Number(itemRow.on_hand) - Number(itemRow.reserved)) }))
      .filter((item) => item.free < item.needed);
  }

  /**
   * Laat de reservering van een webshopbestelling vervallen (annuleren of na het afboeken).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} orderId Id van de bestelling.
   * @returns {void}
   */
  function releaseOrder(tenantId, orderId) {
    prepare('DELETE FROM stock_reservations WHERE tenant_id = ? AND web_order_id = ?').run(tenantId, String(orderId));
    dirty(tenantId);
  }

  /**
   * Boekt de artikelen van een verzonden webshopbestelling af van de voorraad
   * (bron 'bestelling:<nummer>') en laat de reservering vervallen. Moet binnen
   * de transactie van de aanroeper lopen.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, number: string }} order De bestelling.
   * @param {{ itemId: string, qty: number }[]} lines Artikel en aantal.
   * @param {object|null} user Wie de bestelling verzendt.
   * @returns {void}
   */
  function issueOrder(tenantId, order, lines, user) {
    for (const line of lines) book(tenantId, line.itemId, -line.qty, { kind: 'afboeking', source: `bestelling:${order.number}`, note: `Webshopbestelling ${order.number}`, user });
    releaseOrder(tenantId, order.id);
  }

  /**
   * Boekt een deel van een webshopbestelling af (deellevering): de verzonden artikelen gaan van de voorraad (bron 'bestelling:<nummer>')
   * en de reservering krimpt tot wat nog geleverd moet worden. Moet binnen de transactie van de aanroeper lopen.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, number: string }} order De bestelling.
   * @param {{ itemId: string, qty: number }[]} shipped Per artikel het verzonden aantal (basiseenheid).
   * @param {{ itemId: string, qty: number }[]} remaining Per artikel wat nog te leveren is (basiseenheid); leeg = geen reservering meer.
   * @param {object|null} user Wie de bestelling verzendt.
   * @param {{ keepReservation?: boolean }} [options] Met keepReservation false (vrijgegeven reservering) komt er geen nieuwe reservering.
   * @returns {void}
   */
  function issueOrderPart(tenantId, order, shipped, remaining, user, { keepReservation = true } = {}) {
    for (const line of shipped) book(tenantId, line.itemId, -line.qty, { kind: 'afboeking', source: `bestelling:${order.number}`, note: `Webshopbestelling ${order.number} (deellevering)`, user });
    releaseOrder(tenantId, order.id);
    if (keepReservation && remaining.length) reserveOrder(tenantId, order.id, remaining);
  }

  /**
   * Legt een nieuwe inkoopprijs vast met een datum (geldig vanaf); de oude blijft in de historie.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} user Wie het doet.
   * @param {string} id Id van het artikel.
   * @param {{ price: *, validFrom?: string, note?: string }} raw De prijs, de datum (standaard vandaag) en een toelichting.
   * @param {{ nested?: boolean }} [options] Binnen de transactie van de aanroeper.
   * @returns {object} { item }, of { error, field, status }.
   */
  function addCostPrice(tenantId, user, id, raw, { nested = false } = {}) {
    const input = raw && typeof raw === 'object' ? raw : {};
    return inTransaction(() => {
      const existing = findItem(tenantId, id);
      if (!existing) return { error: 'not_found', status: 404 };
      if (Number(existing.is_group)) return { error: 'Een artikelgroep heeft zelf geen voorraad: geef de inkoopprijs per subartikel op.', status: 409 };
      const out = costs.addPrice(tenantId, existing, { price: input.price, validFrom: input.validFrom, note: input.note, user });
      if (out.error) return { ...out, status: 400 };
      repriceItem(tenantId, existing.id, 'inkoopprijs', user);
      return { item: get(tenantId, existing.id) };
    }, nested);
  }

  /**
   * Vult de inkoopprijs in van een voorraadlaag met een onbekende prijs (of van de beginstand).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van het artikel.
   * @param {string} layerId Id van de laag.
   * @param {*} unitCost De prijs per eenheid.
   * @returns {object} { item }, of { error, field, status }.
   */
  function setLayerCost(tenantId, id, layerId, unitCost) {
    return transaction(db, () => {
      const existing = findItem(tenantId, id);
      if (!existing) return { error: 'not_found', status: 404 };
      const out = costs.setLayerCost(tenantId, existing.id, layerId, unitCost);
      if (out.error) return out;
      return { item: get(tenantId, existing.id) };
    });
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
    // Code van een artikelgroep: eerst een maat (subartikel) kiezen.
    const missing = [...need.keys()].filter((code) => !stockCodes.has(code));
    const groupRows = missing.length ? prepare(`SELECT code, name FROM stock_items WHERE tenant_id = ? AND archived = 0 AND is_group = 1 AND code IN (${placeholders(missing.length)})`).all(tenantId, ...missing) : [];
    const groupCodes = new Set(groupRows.map((row) => row.code));
    const chooseSubItem = groupRows.map((row) => ({ code: row.code, name: row.name, qty: need.get(row.code).qty, unit: need.get(row.code).unit }));
    const notInStock = [...need.entries()].filter(([code]) => !stockCodes.has(code) && !groupCodes.has(code)).map(([code, required]) => ({ code, description: required.description, qty: required.qty, unit: required.unit }));
    lines.sort((left, right) => left.code.localeCompare(right.code));
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status }, lines, notInStock, chooseSubItem,
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
      if (item && !item.archived && !Number(item.is_group)) {
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
      ? prepare(`SELECT id, code, name, unit, sale_price, cost_price, vat_rate, revenue_group FROM stock_items WHERE tenant_id = ? AND is_group = 0 AND code IN (${placeholders(wanted.length)})`).all(tenantId, ...wanted)
      : prepare('SELECT id, code, name, unit, sale_price, cost_price, vat_rate, revenue_group FROM stock_items WHERE tenant_id = ? AND archived = 0 AND is_group = 0').all(tenantId);
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
   * afgerond op hele eenheden. Heeft het artikel een voorkeursleverancier, dan wordt het aantal naar boven
   * afgerond op een veelvoud van zijn bestelhoeveelheid (de verpakking), geldt de inkoopprijs van die
   * leverancier (als die is ingevuld) en staan leverancier en artikelnummer bij de regel. Is de voorkeursleverancier niet
   * leverbaar, dan bestelt het voorstel bij de eerste backup (`backup` met het prijsverschil per eenheid en in totaal).
   * @param {string} tenantId Id van de omgeving.
   * Wat al onderweg is (inkooporders die nog niet zijn ontvangen) telt mee als voorraad, zodat niets dubbel wordt besteld.
   * @param {{ preferred?: Map<string, object>, incoming?: Map<string, number> }} [options] preferred = voorkeursleverancier per artikel-id (suppliers.preferredByItem), incoming = aantal onderweg per artikel-id (purchaseOrders.incomingByItem).
   * @returns {{ items: object[], total: number|null, suppliers: object[] }} De regels (artikel plus orderQty, target, amount, supplierId, supplierName en supplierSku), het totaal en per leverancier het aantal regels en het bedrag (zonder leverancier als laatste).
   */
  function reorderProposal(tenantId, { preferred = new Map(), incoming = new Map() } = {}) {
    let total = null;
    const groups = new Map();
    const items = list(tenantId).filter((item) => !item.isGroup && item.available + (incoming.get(item.id) || 0) < item.minQty).map((item) => {
      const onTheWay = incoming.get(item.id) || 0;
      const target = item.reorderQty != null && item.reorderQty >= item.minQty ? item.reorderQty : round3(item.minQty * 2);
      const supplier = preferred.get(item.id) || null;
      const pack = supplier && supplier.orderQty > 0 ? supplier.orderQty : 1;
      const orderQty = round3(Math.ceil(round3(round3(target - item.available - onTheWay) / pack)) * pack);
      const unitCost = supplier && supplier.costPrice != null ? supplier.costPrice : item.costPrice;
      const amount = unitCost == null ? null : Math.round(orderQty * unitCost * 100) / 100;
      // Bestelt het voorstel bij een backup (de voorkeur is niet leverbaar), dan staat het prijsverschil per eenheid met de voorkeur erbij.
      let backup = null;
      if (supplier && supplier.backup && supplier.preferredSupplier) {
        const preferredCost = supplier.preferredSupplier.costPrice != null ? supplier.preferredSupplier.costPrice : item.costPrice;
        const extraPerUnit = unitCost == null || preferredCost == null ? null : Math.round((unitCost - preferredCost) * 10000) / 10000;
        backup = { preferredSupplierId: supplier.preferredSupplier.supplierId, preferredSupplierName: supplier.preferredSupplier.supplierName, extraPerUnit, extraAmount: extraPerUnit == null ? null : Math.round(extraPerUnit * orderQty * 100) / 100 };
      }
      if (amount != null) total = Math.round(((total || 0) + amount) * 100) / 100;
      const key = supplier ? supplier.supplierId : '';
      const group = groups.get(key) || { supplierId: supplier ? supplier.supplierId : null, supplierName: supplier ? supplier.supplierName : '', count: 0, total: null };
      group.count += 1;
      if (amount != null) group.total = Math.round(((group.total || 0) + amount) * 100) / 100;
      groups.set(key, group);
      return { ...item, costPrice: unitCost, target, incoming: onTheWay, orderQty, amount, supplierId: supplier ? supplier.supplierId : null, supplierName: supplier ? supplier.supplierName : '', supplierSku: supplier ? supplier.supplierSku : '', backup, allSuppliersUnavailable: Boolean(supplier && supplier.allUnavailable) };
    });
    const suppliers = [...groups.values()].sort((left, right) => (left.supplierId ? 0 : 1) - (right.supplierId ? 0 : 1) || left.supplierName.localeCompare(right.supplierName, 'nl'));
    return { items, total, suppliers };
  }

  /**
   * Meldt de prijsfactor aan: een functie die de verkoopprijs van een artikel in de modus factor berekent.
   * @param {Function} handler Aanroep (tenantId, { id?, costPrice, priceFactor }) die de prijs of null geeft.
   * @returns {void}
   */
  function setPricer(handler) {
    pricer = handler;
  }

  /**
   * Meldt de auditfunctie aan voor automatische prijswijzigingen.
   * @param {Function} handler Aanroep met { tenantId, userId, action, detail }.
   * @returns {void}
   */
  function setPriceLogger(handler) {
    priceLogger = handler;
  }

  /**
   * Rekent de verkoopprijs van één artikel in de modus factor opnieuw uit en zet hem meteen door (binnen de transactie van de aanroeper).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {string} source Bron voor het auditlog.
   * @param {object|null} user Wie de aanleiding gaf.
   * @returns {boolean} true als de prijs is gewijzigd.
   */
  function repriceItem(tenantId, itemId, source, user = null) {
    const row = findItem(tenantId, itemId);
    if (!pricer || !row || row.archived || Number(row.is_group) || row.price_mode !== 'factor') return false;
    const price = pricer(tenantId, { id: row.id, costPrice: row.cost_price, priceFactor: row.price_factor ?? null });
    if (price === null || (row.sale_price != null && Math.abs(Number(row.sale_price) - price) < 0.005)) return false;
    prepare(`UPDATE stock_items SET sale_price = ?, updated_at = ?, shop_dirty = CASE WHEN shop_sync = 1 AND shop_product_id IS NOT NULL THEN 1 ELSE shop_dirty END
      WHERE tenant_id = ? AND id = ?`).run(price, currentTimestamp(), tenantId, row.id);
    logPriceChange(tenantId, row, row.sale_price, price, source, user);
    return true;
  }

  /**
   * Een ontvangst met een andere inkoopprijs dan de actuele: de nieuwe prijs komt in de historie en de verkoopprijs volgt (modus factor).
   * Binnen de transactie van de aanroeper.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {number} unitCost De inkoopprijs op de ontvangst.
   * @param {{ user?: object|null, note?: string }} [options] Wie en een toelichting.
   * @returns {void}
   */
  function receiptCost(tenantId, itemId, unitCost, { user = null, note = '' } = {}) {
    const existing = findItem(tenantId, itemId);
    if (!existing || Number(existing.is_group) || !Number.isFinite(unitCost) || unitCost < 0) return;
    if (existing.cost_price != null && Math.abs(Number(existing.cost_price) - unitCost) <= 0.00005) return;
    // Een fout in de prijshistorie mag de ontvangst van goederen niet blokkeren: de voorraad is dan al geboekt. De fout komt wel in het log.
    const added = costs.addPrice(tenantId, existing, { price: unitCost, note, user });
    if (added.error) { console.error(`[inkoopprijs] ontvangst ${existing.code}: ${added.error}`); return; }
    repriceItem(tenantId, itemId, 'ontvangst', user);
    dirty(tenantId);
  }

  /**
   * Zet berekende verkoopprijzen door (alleen artikelen in de modus factor), in blokken van 200 per transactie, met een auditregel per wijziging.
   * De berekening zelf gebeurt in bulk door de aanroeper (price-factor.js), niet per artikel.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, code: string, oldPrice: ?number, newPrice: number }[]} changes De afwijkende prijzen.
   * @param {string} source Bron voor het auditlog.
   * @param {object|null} [user] Wie de aanleiding gaf.
   * @returns {number} Aantal artikelen waarvan de prijs wijzigde.
   */
  function applyAutoPrices(tenantId, changes, source, user = null) {
    let changed = 0;
    for (let start = 0; start < changes.length; start += 200) {
      const audits = [];
      transaction(db, () => {
        const block = [];
        for (const change of changes.slice(start, start + 200)) {
          const price = Math.round(Number(change.newPrice) * 100) / 100;
          if (Number.isFinite(price) && price >= 0 && price <= MAX_QTY) block.push({ change, price });
        }
        if (!block.length) return;
        // Eén UPDATE per blok: CASE per artikel, alleen artikelen die nog in de modus factor staan.
        const whens = block.map(() => 'WHEN ? THEN CAST(? AS DOUBLE PRECISION)').join(' ');
        const marks = block.map(() => '?').join(', ');
        const args = [];
        for (const { change, price } of block) args.push(change.id, price);
        const result = prepare(`UPDATE stock_items SET sale_price = CASE id ${whens} END, updated_at = ?,
          shop_dirty = CASE WHEN shop_sync = 1 AND shop_product_id IS NOT NULL THEN 1 ELSE shop_dirty END
          WHERE tenant_id = ? AND id IN (${marks}) AND is_group = 0 AND archived = 0 AND price_mode = 'factor' RETURNING id`)
          .all(...args, currentTimestamp(), tenantId, ...block.map(({ change }) => change.id));
        const touched = new Set(result.map((row) => row.id));
        changed += touched.size;
        for (const { change, price } of block.filter(({ change }) => touched.has(change.id))) logPriceChange(tenantId, change, change.oldPrice, price, source, user, audits);
        if (audits.length && priceLogger) priceLogger(audits);
      });
    }
    if (changed) dirty(tenantId);
    return changed;
  }

  /**
   * Zet nieuwe verkoopprijzen door (herberekening met de prijsfactor), in één transactie. Gekoppelde webshopproducten gaan opnieuw mee.
   * Artikelgroepen (met subartikelen) hebben geen eigen prijs en worden overgeslagen.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ id: string, salePrice: number }[]} changes De nieuwe prijzen (excl. btw).
   * @returns {number} Aantal artikelen waarvan de prijs is gewijzigd.
   */
  function setSalePrices(tenantId, changes) {
    const timestamp = currentTimestamp();
    let changed = 0;
    transaction(db, () => {
      const update = prepare(`UPDATE stock_items SET sale_price = ?, updated_at = ?,
          shop_dirty = CASE WHEN shop_sync = 1 AND shop_product_id IS NOT NULL THEN 1 ELSE shop_dirty END
        WHERE tenant_id = ? AND id = ? AND is_group = 0 AND archived = 0`);
      for (const change of changes) {
        const price = Math.round(Number(change.salePrice) * 100) / 100;
        if (Number.isFinite(price) && price >= 0 && price <= MAX_QTY) changed += Number(update.run(price, timestamp, tenantId, String(change.id)).changes) || 0;
      }
    });
    if (changed) dirty(tenantId);
    return changed;
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
    units, addUnit, removeUnit, setSubItems, articleChoices, mergeSuggestions, mergeIntoGroup, unmergePreview, unmergeSubItems,
    list, get, create, update, remove, move, importCatalog, importShop, mirrorShop, addMissingShop, movements, reservations: reservationsOf,
    syncWorkOrder, resyncOpen, complete, onWorkOrderChange, forWorkOrder, issue, syncUsage, book, saleInfo, findCode,
    reorderProposal, reserveOrder, releaseOrder, issueOrder, issueOrderPart, shortageFor, onDirty: setDirtyHook, setPricer, setPriceLogger, setSalePrices, repriceItem, applyAutoPrices, receiptCost,
    addCostPrice, setLayerCost, stockValue: costs.stockValue,
  };
}


module.exports = { createStockStore, registerStockRoutes, sanitizeItem, sanitizeAttributes, combinations, needsOf, KINDS, GROUPS, VAT_RATES };
