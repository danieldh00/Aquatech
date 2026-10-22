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

const now = () => new Date().toISOString();
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const normCode = (v) => String(v ?? '').trim().toUpperCase();
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const marks = (n) => Array.from({ length: n }, () => '?').join(',');

/** Schoont een voorraadartikel op; geeft { value } of { error, field }. */
function sanitizeItem(raw, { partial = false } = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  if (!partial || r.code !== undefined) {
    const code = normCode(r.code);
    if (!code) return { error: 'Vul een artikelcode in.', field: 'code' };
    if (code.length > 40 || !/^[A-Z0-9][A-Z0-9 ._\-/+]*$/.test(code)) return { error: 'Een artikelcode bestaat uit letters, cijfers en - . _ / + (max. 40 tekens).', field: 'code' };
    out.code = code;
  }
  if (!partial || r.name !== undefined) {
    const name = str(r.name, 200);
    if (!name) return { error: 'Vul een omschrijving in.', field: 'name' };
    out.name = name;
  }
  if (!partial || r.unit !== undefined) out.unit = str(r.unit, 12) || 'st';
  if (!partial || r.location !== undefined) out.location = str(r.location, 60);
  if (!partial || r.notes !== undefined) out.notes = str(r.notes, 1000);
  if (!partial || r.minQty !== undefined) {
    const n = r.minQty === '' || r.minQty == null ? 0 : Number(r.minQty);
    if (!Number.isFinite(n) || n < 0 || n > MAX_QTY) return { error: 'Ongeldige minimumvoorraad.', field: 'minQty' };
    out.minQty = r3(n);
  }
  if (!partial || r.costPrice !== undefined) {
    const n = r.costPrice === '' || r.costPrice == null ? null : Number(r.costPrice);
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > MAX_QTY)) return { error: 'Ongeldige inkoopprijs.', field: 'costPrice' };
    out.costPrice = n === null ? null : Math.round(n * 100) / 100;
  }
  if (!partial || r.salePrice !== undefined) {
    const n = r.salePrice === '' || r.salePrice == null ? null : Number(r.salePrice);
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > MAX_QTY)) return { error: 'Ongeldige verkoopprijs.', field: 'salePrice' };
    out.salePrice = n === null ? null : Math.round(n * 100) / 100;
  }
  if (!partial || r.vatRate !== undefined) {
    const n = r.vatRate === undefined || r.vatRate === '' || r.vatRate === null ? 21 : Number(r.vatRate);
    if (!VAT_RATES.includes(n)) return { error: 'Kies een btw-tarief van 21, 9 of 0%.', field: 'vatRate' };
    out.vatRate = n;
  }
  if (!partial || r.revenueGroup !== undefined) {
    const g = r.revenueGroup === undefined || r.revenueGroup === '' ? 'producten' : String(r.revenueGroup);
    if (!GROUPS[g]) return { error: 'Onbekende omzetgroep.', field: 'revenueGroup' };
    out.revenueGroup = g;
  }
  if (!partial || r.shopSync !== undefined) out.shopSync = r.shopSync !== false;
  return { value: out };
}

/** Benodigd per artikelcode uit de materiaallijst van een werkorder. */
function needsOf(materials) {
  const need = new Map();
  for (const m of Array.isArray(materials) ? materials : []) {
    const code = normCode(m && m.code);
    const qty = Number(m && m.qty);
    if (!code || !(qty > 0)) continue;
    const cur = need.get(code) || { qty: 0, description: '', unit: '' };
    cur.qty = r3(cur.qty + qty);
    cur.description = cur.description || str(m.description, 200);
    cur.unit = cur.unit || str(m.unit, 12);
    need.set(code, cur);
  }
  return need;
}

function createStockStore(db, { articles = loadArticles, onDirty = null } = {}) {
  const q = (sql) => db.prepare(sql);
  // Webshop: na een wijziging van prijs of stand (shop-sync.js meldt zich aan via onDirty()).
  let dirtyHook = onDirty;
  const dirty = (tenantId) => { if (dirtyHook) dirtyHook(tenantId); };
  const SALE_COLS = 'sale_price, vat_rate, revenue_group, shop_sync, shop_product_id, shop_dirty, shop_synced_at, shop_error';
  const ITEM_COLS = `id, code, name, unit, location, min_qty, on_hand, cost_price, notes, archived, created_at, updated_at, ${SALE_COLS}`;
  const MOVE_COLS = 'm.id, m.item_id, m.kind, m.qty, m.balance, m.work_order_id, m.work_order_number, m.source, m.note, m.user_name, m.created_at';

  const shapeItem = (r, reserved = 0, orders = 0) => {
    const onHand = r3(r.on_hand);
    const res = r3(reserved);
    return {
      id: r.id, code: r.code, name: r.name, unit: r.unit, location: r.location, minQty: r3(r.min_qty), onHand,
      reserved: res, available: r3(onHand - res), orders: Number(orders) || 0,
      costPrice: r.cost_price == null ? null : Number(r.cost_price),
      value: r.cost_price == null ? null : Math.round(onHand * r.cost_price * 100) / 100,
      low: r.min_qty > 0 && onHand - res < r.min_qty, notes: r.notes, archived: Boolean(r.archived),
      salePrice: r.sale_price == null ? null : Number(r.sale_price), vatRate: Number(r.vat_rate ?? 21), revenueGroup: r.revenue_group || 'producten',
      shopSync: r.shop_sync === undefined ? true : Boolean(Number(r.shop_sync)),
      shop: { productId: r.shop_product_id || null, pending: Boolean(Number(r.shop_dirty)), syncedAt: r.shop_synced_at || null, error: r.shop_error || '' },
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  };
  const shapeMove = (r) => ({
    id: r.id, itemId: r.item_id, kind: r.kind, qty: r3(r.qty), balance: r3(r.balance),
    workOrderId: r.work_order_id || null, workOrderNumber: r.work_order_number || '', source: r.source || '',
    note: r.note, userName: r.user_name, createdAt: r.created_at,
    ...(r.code !== undefined ? { code: r.code, name: r.name, unit: r.unit } : {}),
  });

  // Overzicht in één query: stand plus gereserveerd (som over open werkorders).
  function list(tenantId, { archived = false } = {}) {
    return q(`SELECT i.id, i.code, i.name, i.unit, i.location, i.min_qty, i.on_hand, i.cost_price, i.notes, i.archived, i.created_at, i.updated_at,
        i.sale_price, i.vat_rate, i.revenue_group, i.shop_sync, i.shop_product_id, i.shop_dirty, i.shop_synced_at, i.shop_error,
        COALESCE(r.qty, 0) AS reserved, COALESCE(r.orders, 0) AS orders
      FROM stock_items i
      LEFT JOIN (SELECT item_id, SUM(qty) AS qty, COUNT(*) AS orders FROM stock_reservations WHERE tenant_id = ? GROUP BY item_id) r ON r.item_id = i.id
      WHERE i.tenant_id = ?${archived ? '' : ' AND i.archived = 0'} ORDER BY i.code`)
      .all(tenantId, tenantId).map((r) => shapeItem(r, r.reserved, r.orders));
  }

  const findItem = (tenantId, id) => q(`SELECT ${ITEM_COLS} FROM stock_items WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));
  const findCode = (tenantId, code) => q(`SELECT ${ITEM_COLS} FROM stock_items WHERE tenant_id = ? AND code = ?`).get(tenantId, normCode(code));

  // Reserveringen met de werkorder erbij (nummer, titel, status, datum).
  function reservationsOf(tenantId, itemId = null) {
    const args = [tenantId];
    let sql = `SELECT r.item_id, r.work_order_id, r.qty, r.updated_at, w.number, w.title, w.customer, w.status, w.planned_date,
        i.code, i.name, i.unit
      FROM stock_reservations r JOIN stock_items i ON i.id = r.item_id
      LEFT JOIN work_orders w ON w.id = r.work_order_id AND w.tenant_id = r.tenant_id
      WHERE r.tenant_id = ?`;
    if (itemId) { sql += ' AND r.item_id = ?'; args.push(String(itemId)); }
    return q(`${sql} ORDER BY w.planned_date, w.number`).all(...args).map((r) => ({
      itemId: r.item_id, code: r.code, name: r.name, unit: r.unit, qty: r3(r.qty), updatedAt: r.updated_at,
      workOrder: { id: r.work_order_id, number: r.number || '', title: r.title || '', customer: r.customer || '', status: r.status || '', plannedDate: r.planned_date || '' },
    }));
  }

  function get(tenantId, id) {
    const r = findItem(tenantId, id);
    if (!r) return null;
    const reservations = reservationsOf(tenantId, r.id);
    const item = shapeItem(r, reservations.reduce((s, x) => s + x.qty, 0), reservations.length);
    const movements = q(`SELECT ${MOVE_COLS} FROM stock_movements m WHERE m.tenant_id = ? AND m.item_id = ? ORDER BY m.created_at DESC, m.id LIMIT ${LIST_LIMIT}`)
      .all(tenantId, r.id).map(shapeMove);
    return { ...item, reservations, movements };
  }

  // Een mutatie boeken: stand bijwerken en het logboek aanvullen. Binnen de
  // transactie van de aanroeper.
  function book(tenantId, itemId, delta, { kind, workOrder = null, source = '', note = '', user = null, at = now() }) {
    // Een verkoop in de webshop zelf (source 'webshop') hoeft niet terug.
    const toShop = source === 'webshop' ? 0 : 1;
    q(`UPDATE stock_items SET on_hand = on_hand + ?, updated_at = ?,
      shop_dirty = CASE WHEN shop_product_id IS NOT NULL AND shop_sync = 1 AND ? = 1 THEN 1 ELSE shop_dirty END
      WHERE tenant_id = ? AND id = ?`).run(r3(delta), at, toShop, tenantId, itemId);
    if (toShop) dirty(tenantId);
    const balance = q('SELECT on_hand FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, itemId).on_hand;
    const id = crypto.randomUUID();
    q(`INSERT INTO stock_movements (id, tenant_id, item_id, kind, qty, balance, work_order_id, work_order_number, source, note, user_id, user_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, itemId, kind, r3(delta), r3(balance), workOrder ? workOrder.id : null, workOrder ? workOrder.number : '',
        source, str(note, 300), user ? user.id : null, user ? str(user.display_name || user.displayName, 120) : '', at);
    return id;
  }

  function create(tenantId, user, raw, { resync = true } = {}) {
    const s = sanitizeItem(raw);
    if (s.error) return s;
    const v = s.value;
    const out = transaction(db, () => {
      if (findCode(tenantId, v.code)) return { error: 'Er is al een voorraadartikel met deze code.', field: 'code', status: 409 };
      const id = crypto.randomUUID();
      const t = now();
      q(`INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, on_hand, cost_price, notes, archived, created_at, updated_at,
           sale_price, vat_rate, revenue_group, shop_sync)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, v.code, v.name, v.unit, v.location, v.minQty, v.costPrice, v.notes, t, t, v.salePrice, v.vatRate, v.revenueGroup, v.shopSync ? 1 : 0);
      const start = Number(raw && raw.onHand);
      if (Number.isFinite(start) && start > 0 && start <= MAX_QTY) book(tenantId, id, start, { kind: 'ontvangst', note: 'Beginvoorraad', user });
      return { id };
    });
    if (out.error) return out;
    // Open werkorders met deze code reserveren meteen.
    if (resync) resyncOpen(tenantId, [v.code]);
    return { item: get(tenantId, out.id) };
  }

  function update(tenantId, id, raw) {
    const s = sanitizeItem(raw, { partial: true });
    if (s.error) return s;
    const v = s.value;
    const out = transaction(db, () => {
      const r = findItem(tenantId, id);
      if (!r) return { error: 'not_found', status: 404 };
      if (v.code && v.code !== r.code) {
        // De code is de koppeling met werkorders en verbruik: alleen zolang er niets op geboekt is.
        if (findCode(tenantId, v.code)) return { error: 'Er is al een voorraadartikel met deze code.', field: 'code', status: 409 };
        const used = q('SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = ? AND item_id = ? AND work_order_id IS NOT NULL) OR EXISTS (SELECT 1 FROM stock_reservations WHERE tenant_id = ? AND item_id = ?) AS n')
          .get(tenantId, r.id, tenantId, r.id).n;
        if (used) return { error: 'De code van een artikel dat al op werkorders is gereserveerd of afgeboekt, kan niet meer veranderen.', field: 'code', status: 409 };
      }
      const n = {
        code: r.code, name: r.name, unit: r.unit, location: r.location, minQty: r.min_qty, costPrice: r.cost_price, notes: r.notes,
        salePrice: r.sale_price, vatRate: Number(r.vat_rate), revenueGroup: r.revenue_group, shopSync: Boolean(Number(r.shop_sync)), ...v,
      };
      const archived = raw && raw.archived !== undefined ? (raw.archived ? 1 : 0) : r.archived;
      // Andere prijs of btw (of weer meesturen): opnieuw naar de webshop.
      const toShop = (n.salePrice ?? null) !== (r.sale_price ?? null) || n.vatRate !== Number(r.vat_rate) || (n.shopSync && !Number(r.shop_sync));
      q(`UPDATE stock_items SET code = ?, name = ?, unit = ?, location = ?, min_qty = ?, cost_price = ?, notes = ?, archived = ?, updated_at = ?,
           sale_price = ?, vat_rate = ?, revenue_group = ?, shop_sync = ?,
           shop_dirty = CASE WHEN ? = 1 AND shop_product_id IS NOT NULL THEN 1 ELSE shop_dirty END
         WHERE tenant_id = ? AND id = ?`)
        .run(n.code, n.name, n.unit, n.location, n.minQty, n.costPrice, n.notes, archived, now(), n.salePrice, n.vatRate, n.revenueGroup, n.shopSync ? 1 : 0,
          toShop && n.shopSync ? 1 : 0, tenantId, r.id);
      if (archived && !r.archived) q('DELETE FROM stock_reservations WHERE tenant_id = ? AND item_id = ?').run(tenantId, r.id);
      return { item: get(tenantId, r.id), toShop };
    });
    if (out.toShop) dirty(tenantId);
    return out;
  }

  /** Verwijderen: zonder mutaties echt weg, anders gearchiveerd (het logboek blijft). */
  function remove(tenantId, id) {
    return transaction(db, () => {
      const r = findItem(tenantId, id);
      if (!r) return null;
      q('DELETE FROM stock_reservations WHERE tenant_id = ? AND item_id = ?').run(tenantId, r.id);
      const moved = q('SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = ? AND item_id = ?) AS n').get(tenantId, r.id).n;
      if (moved) {
        q('UPDATE stock_items SET archived = 1, updated_at = ? WHERE tenant_id = ? AND id = ?').run(now(), tenantId, r.id);
        return { archived: true, code: r.code };
      }
      q('DELETE FROM stock_items WHERE tenant_id = ? AND id = ?').run(tenantId, r.id);
      return { deleted: true, code: r.code };
    });
  }

  /**
   * Mutatie op het artikel: ontvangst (aantal > 0), correctie (+ of −) of
   * telling (het getelde aantal; de stand wordt dat).
   */
  function move(tenantId, user, id, raw) {
    const r0 = raw && typeof raw === 'object' ? raw : {};
    const kind = r0.kind;
    const qty = Number(r0.qty);
    if (!MANUAL.includes(kind)) return { error: 'Kies ontvangst, correctie of telling.', field: 'kind' };
    if (!Number.isFinite(qty) || Math.abs(qty) > MAX_QTY) return { error: 'Vul een geldig aantal in.', field: 'qty' };
    if (kind === 'ontvangst' && !(qty > 0)) return { error: 'Een ontvangst is een aantal groter dan 0.', field: 'qty' };
    if (kind === 'correctie' && !qty) return { error: 'Een correctie is een aantal erbij (+) of eraf (−).', field: 'qty' };
    if (kind === 'telling' && qty < 0) return { error: 'Vul het getelde aantal in.', field: 'qty' };
    const note = str(r0.note, 300);
    if (kind === 'correctie' && note.length < 3) return { error: 'Geef bij een correctie de reden op.', field: 'note' };
    return transaction(db, () => {
      const r = findItem(tenantId, id);
      if (!r) return { error: 'not_found', status: 404 };
      if (r.archived) return { error: 'Dit artikel is gearchiveerd.', status: 409 };
      const delta = kind === 'telling' ? r3(qty - r.on_hand) : r3(qty);
      const movementId = book(tenantId, r.id, delta, { kind, note: kind === 'telling' ? note || `Geteld: ${r3(qty)}` : note, user });
      return { movementId, delta, item: get(tenantId, r.id) };
    });
  }

  /** Artikelen uit de catalogus van de planner op voorraad nemen (codes die nog niet bestaan). */
  function importCatalog(tenantId, user, codes) {
    const arts = articles();
    const wanted = [...new Set((Array.isArray(codes) ? codes : []).map(normCode))].filter(Boolean).slice(0, 500);
    const byUpper = new Map(Object.keys(arts).map((k) => [normCode(k), k]));
    const unknown = wanted.filter((c) => !byUpper.has(c));
    if (unknown.length) return { error: `Onbekende artikelcode: ${unknown.slice(0, 5).join(', ')}.`, field: 'codes' };
    const have = new Set(wanted.length ? q(`SELECT code FROM stock_items WHERE tenant_id = ? AND code IN (${marks(wanted.length)})`).all(tenantId, ...wanted).map((r) => r.code) : []);
    const fresh = wanted.filter((c) => !have.has(c));
    transaction(db, () => {
      const t = now();
      const put = q(`INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, on_hand, cost_price, notes, archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '', 0, 0, NULL, '', 0, ?, ?)`);
      for (const c of fresh) {
        const a = arts[byUpper.get(c)];
        put.run(crypto.randomUUID(), tenantId, c, str(a.name, 200), str(a.unit, 12) || 'st', t, t);
      }
    });
    if (fresh.length) resyncOpen(tenantId, fresh);
    return { created: fresh.length, existing: have.size };
  }

  /**
   * Producten uit de webshop als voorraadartikel overnemen (nog niet bestaande
   * codes). Code = het veld aquatech_code of de sku; prijs = de webshopprijs
   * (excl. btw). De stand komt bij de volgende synchronisatie uit de webshop.
   */
  function importShop(tenantId, products, ids) {
    const want = new Set((Array.isArray(ids) ? ids : []).map(String).slice(0, 500));
    if (!want.size) return { error: 'Kies een of meer producten.', field: 'ids' };
    const chosen = products.filter((p) => want.has(String(p.id)));
    const skipped = [];
    const fresh = [];
    const seen = new Set();
    for (const p of chosen) {
      const code = normCode(p.code || p.sku);
      if (!code || code.length > 40 || !/^[A-Z0-9][A-Z0-9 ._\-/+]*$/.test(code) || seen.has(code)) { skipped.push(p.name); continue; }
      seen.add(code);
      fresh.push({ p, code });
    }
    const have = new Set(fresh.length ? q(`SELECT code FROM stock_items WHERE tenant_id = ? AND code IN (${marks(fresh.length)})`).all(tenantId, ...fresh.map((f) => f.code)).map((r) => r.code) : []);
    const todo = fresh.filter((f) => !have.has(f.code));
    transaction(db, () => {
      const t = now();
      const put = q(`INSERT INTO stock_items (id, tenant_id, code, name, unit, location, min_qty, on_hand, cost_price, notes, archived, created_at, updated_at,
          sale_price, vat_rate, revenue_group, shop_sync, shop_product_id)
        VALUES (?, ?, ?, ?, 'st', '', 0, 0, NULL, '', 0, ?, ?, ?, 21, 'producten', 1, ?)`);
      for (const { p, code } of todo) put.run(crypto.randomUUID(), tenantId, code, str(p.name, 200) || code, t, t, p.price == null ? null : Math.round(p.price * 100) / 100, String(p.id));
    });
    if (todo.length) resyncOpen(tenantId, todo.map((f) => f.code));
    return { created: todo.length, existing: have.size, skipped };
  }

  /** Logboek (voor het overzicht en de Excel-export), nieuwste eerst. */
  function movements(tenantId, { from = '', to = '', itemId = null, workOrderId = null, limit = EXPORT_LIMIT } = {}) {
    const args = [tenantId];
    let sql = `SELECT ${MOVE_COLS}, i.code, i.name, i.unit FROM stock_movements m JOIN stock_items i ON i.id = m.item_id WHERE m.tenant_id = ?`;
    if (isDate(from)) { sql += ' AND m.created_at >= ?'; args.push(`${from}T00:00:00.000Z`); }
    if (isDate(to)) { sql += ' AND m.created_at <= ?'; args.push(`${to}T23:59:59.999Z`); }
    if (itemId) { sql += ' AND m.item_id = ?'; args.push(String(itemId)); }
    if (workOrderId) { sql += ' AND m.work_order_id = ?'; args.push(String(workOrderId)); }
    const n = Math.max(1, Math.min(EXPORT_LIMIT, Number(limit) || EXPORT_LIMIT));
    return q(`${sql} ORDER BY m.created_at DESC, m.id LIMIT ${n}`).all(...args).map(shapeMove);
  }

  // ---------- Werkorders: reserveren en afboeken ----------
  const findWo = (tenantId, id) => q('SELECT id, number, status, data, deleted_at FROM work_orders WHERE tenant_id = ? AND id = ?').get(tenantId, String(id));
  const itemsFor = (tenantId, codes) => (codes.length
    ? q(`SELECT ${ITEM_COLS} FROM stock_items WHERE tenant_id = ? AND archived = 0 AND code IN (${marks(codes.length)})`).all(tenantId, ...codes) : []);
  // Netto afgeboekt per artikel voor deze werkorder (afboeking − retour).
  const issuedFor = (tenantId, woId) => new Map(q(`SELECT item_id, SUM(qty) AS qty FROM stock_movements
    WHERE tenant_id = ? AND work_order_id = ? AND kind IN ('afboeking', 'retour') GROUP BY item_id`).all(tenantId, woId).map((r) => [r.item_id, r3(-r.qty)]));
  const usageBooked = (tenantId, woId) => Boolean(q(`SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = ? AND work_order_id = ? AND source LIKE 'verbruik:%') AS n`)
    .get(tenantId, woId).n);

  // nested: de aanroeper heeft al een transactie open (transaction nest niet).
  const tx = (fn, nested) => (nested ? fn() : transaction(db, fn));

  /** Reserveringen van een werkorder opnieuw vastleggen (benodigd − afgeboekt, alleen open werkorders). */
  function syncWorkOrder(tenantId, woId, wo = findWo(tenantId, woId), { nested = false } = {}) {
    return tx(() => {
      q('DELETE FROM stock_reservations WHERE tenant_id = ? AND work_order_id = ?').run(tenantId, String(woId));
      if (!wo || wo.deleted_at || !OPEN.includes(wo.status)) return 0;
      const need = needsOf(JSON.parse(wo.data).materials);
      const items = itemsFor(tenantId, [...need.keys()]);
      if (!items.length) return 0;
      const issued = issuedFor(tenantId, wo.id);
      const put = q('INSERT INTO stock_reservations (tenant_id, work_order_id, item_id, qty, updated_at) VALUES (?, ?, ?, ?, ?)');
      const t = now();
      let n = 0;
      for (const it of items) {
        const rest = r3(need.get(it.code).qty - (issued.get(it.id) || 0));
        if (rest > 0) { put.run(tenantId, wo.id, it.id, rest, t); n++; }
      }
      return n;
    }, nested);
  }

  /** Alle open werkorders opnieuw reserveren (bijv. na een nieuw voorraadartikel). */
  function resyncOpen(tenantId, codes = null) {
    const rows = q(`SELECT id, number, status, data, deleted_at FROM work_orders WHERE tenant_id = ? AND deleted_at IS NULL
      AND status IN (${marks(OPEN.length)})`).all(tenantId, ...OPEN);
    const want = codes ? new Set(codes.map(normCode)) : null;
    let n = 0;
    for (const wo of rows) {
      if (want && ![...needsOf(JSON.parse(wo.data).materials).keys()].some((c) => want.has(c))) continue;
      syncWorkOrder(tenantId, wo.id, wo);
      n++;
    }
    return n;
  }

  /**
   * Werkorder gereed: wat nog gereserveerd staat afboeken, tenzij er verbruik
   * is geregistreerd (dan vervalt alleen de rest van de reservering).
   */
  function complete(tenantId, wo, user) {
    return transaction(db, () => {
      const res = q('SELECT item_id, qty FROM stock_reservations WHERE tenant_id = ? AND work_order_id = ?').all(tenantId, wo.id);
      let booked = 0;
      if (res.length && !usageBooked(tenantId, wo.id)) {
        for (const r of res) {
          if (!(r.qty > 0)) continue;
          book(tenantId, r.item_id, -r.qty, { kind: 'afboeking', workOrder: wo, source: 'gereed', note: 'Werkorder gereed', user });
          booked++;
        }
      }
      q('DELETE FROM stock_reservations WHERE tenant_id = ? AND work_order_id = ?').run(tenantId, wo.id);
      return { booked };
    });
  }

  /** Na elke wijziging van een werkorder (aanmaken, opslaan, status, verwijderen). */
  function onWorkOrderChange(tenantId, woId, user) {
    const wo = findWo(tenantId, woId);
    if (wo && !wo.deleted_at && wo.status === 'gereed') return complete(tenantId, wo, user);
    return { reserved: syncWorkOrder(tenantId, woId, wo) };
  }

  /** Stand van de materialen van een werkorder ten opzichte van de voorraad. */
  function forWorkOrder(tenantId, woId) {
    const wo = findWo(tenantId, woId);
    if (!wo || wo.deleted_at) return null;
    const need = needsOf(JSON.parse(wo.data).materials);
    const issued = issuedFor(tenantId, wo.id);
    const issuedIds = [...issued.keys()];
    const items = itemsFor(tenantId, [...need.keys()]);
    const known = new Set(items.map((i) => i.id));
    // Ook artikelen die zijn afgeboekt maar niet (meer) in de materiaallijst staan.
    const extraIds = issuedIds.filter((id) => !known.has(id));
    if (extraIds.length) items.push(...q(`SELECT ${ITEM_COLS} FROM stock_items WHERE tenant_id = ? AND id IN (${marks(extraIds.length)})`).all(tenantId, ...extraIds));
    const ids = items.map((i) => i.id);
    const resRows = ids.length ? q(`SELECT item_id, work_order_id, qty FROM stock_reservations WHERE tenant_id = ? AND item_id IN (${marks(ids.length)})`).all(tenantId, ...ids) : [];
    const lines = [];
    for (const it of items) {
      const mine = resRows.filter((r) => r.item_id === it.id && r.work_order_id === wo.id).reduce((s, r) => s + r.qty, 0);
      const others = resRows.filter((r) => r.item_id === it.id && r.work_order_id !== wo.id).reduce((s, r) => s + r.qty, 0);
      const n = need.get(it.code);
      const needed = n ? n.qty : 0;
      const done = issued.get(it.id) || 0;
      const rest = Math.max(0, r3(needed - done));
      const free = r3(it.on_hand - others);
      lines.push({
        itemId: it.id, code: it.code, name: it.name, unit: it.unit, location: it.location, needed, issued: r3(done), reserved: r3(mine),
        onHand: r3(it.on_hand), available: free, shortage: OPEN.includes(wo.status) ? Math.max(0, r3(rest - Math.max(0, free))) : 0, archived: Boolean(it.archived),
      });
    }
    const stockCodes = new Set(items.map((i) => i.code));
    const notInStock = [...need.entries()].filter(([c]) => !stockCodes.has(c)).map(([code, n]) => ({ code, description: n.description, qty: n.qty, unit: n.unit }));
    lines.sort((a, b) => a.code.localeCompare(b.code));
    return {
      workOrder: { id: wo.id, number: wo.number, status: wo.status }, lines, notInStock,
      usage: usageBooked(tenantId, wo.id),
      movements: movements(tenantId, { workOrderId: wo.id, limit: LIST_LIMIT }),
    };
  }

  /**
   * Handmatig afboeken op een werkorder. lines: [{ code, qty }] (qty > 0 =
   * afboeken, < 0 = retour); zonder lines alles wat nog gereserveerd staat.
   */
  function issue(tenantId, user, woId, rawLines, note = '') {
    const wo = findWo(tenantId, woId);
    if (!wo || wo.deleted_at) return { error: 'not_found', status: 404 };
    let lines;
    if (rawLines === undefined || rawLines === null) {
      lines = q(`SELECT r.item_id, r.qty, i.code FROM stock_reservations r JOIN stock_items i ON i.id = r.item_id
        WHERE r.tenant_id = ? AND r.work_order_id = ?`).all(tenantId, wo.id).map((r) => ({ itemId: r.item_id, code: r.code, qty: r3(r.qty) }));
      if (!lines.length) return { error: 'Er staat niets gereserveerd om af te boeken.', status: 409 };
    } else {
      if (!Array.isArray(rawLines) || !rawLines.length || rawLines.length > 200) return { error: 'Geef aan wat er afgeboekt moet worden.', field: 'lines' };
      const clean = [];
      for (const l of rawLines) {
        const code = normCode(l && l.code);
        const qty = r3(l && l.qty);
        if (!code || !qty || Math.abs(qty) > MAX_QTY) return { error: 'Ongeldige regel: artikelcode en aantal zijn nodig.', field: 'lines' };
        clean.push({ code, qty });
      }
      const codes = [...new Set(clean.map((l) => l.code))];
      const items = new Map(itemsFor(tenantId, codes).map((i) => [i.code, i]));
      const unknown = codes.filter((c) => !items.has(c));
      if (unknown.length) return { error: `Geen voorraadartikel: ${unknown.slice(0, 5).join(', ')}.`, field: 'lines' };
      lines = clean.map((l) => ({ itemId: items.get(l.code).id, code: l.code, qty: l.qty }));
    }
    const ids = transaction(db, () => lines.map((l) => book(tenantId, l.itemId, -l.qty, {
      kind: l.qty > 0 ? 'afboeking' : 'retour', workOrder: wo, source: 'handmatig', note, user,
    })));
    syncWorkOrder(tenantId, wo.id);
    return { booked: ids.length, stock: forWorkOrder(tenantId, wo.id) };
  }

  /**
   * Materiaalverbruik van de installateur boeken (registratie op de
   * werkorder). Idempotent per verbruiksregel: de totale afboeking voor
   * usageId wordt qty (0 = regel verwijderd, negatief = retour), dus een
   * gewijzigde regel boekt alleen het verschil. Geeft het id van de laatste
   * mutatie voor deze regel, of null als de code geen voorraadartikel is. nested: aanroepen binnen de transactie van de aanroeper
   * (materiaalregistratie), zodat verbruik en afboeking samen slagen.
   */
  function syncUsage(tenantId, { usageId, workOrderId, code, qty, user = null }, { nested = false } = {}) {
    if (!usageId) return null;
    const source = `verbruik:${String(usageId).slice(0, 80)}`;
    const wo = findWo(tenantId, workOrderId);
    if (!wo) return null;
    const out = tx(() => {
      const prev = q('SELECT item_id, SUM(qty) AS qty FROM stock_movements WHERE tenant_id = ? AND source = ? GROUP BY item_id').all(tenantId, source);
      const item = normCode(code) ? findCode(tenantId, code) : null;
      let last = null;
      // Een andere code dan eerder: het oude artikel eerst terugboeken.
      for (const p of prev) {
        if (item && p.item_id === item.id) continue;
        if (r3(p.qty)) last = book(tenantId, p.item_id, -p.qty, { kind: p.qty < 0 ? 'retour' : 'afboeking', workOrder: wo, source, note: 'Verbruik gewijzigd', user });
      }
      if (item && !item.archived) {
        const was = r3(-(prev.find((p) => p.item_id === item.id)?.qty || 0));
        const delta = r3((Number(qty) || 0) - was);
        if (delta) last = book(tenantId, item.id, -delta, { kind: delta > 0 ? 'afboeking' : 'retour', workOrder: wo, source, note: 'Materiaalverbruik', user });
        // Niets veranderd (bijv. alleen de opmerking): de bestaande afboeking blijft de koppeling.
        if (!last && prev.length) last = q('SELECT id FROM stock_movements WHERE tenant_id = ? AND source = ? AND item_id = ? ORDER BY created_at DESC, id LIMIT 1').get(tenantId, source, item.id)?.id || null;
      }
      return last;
    }, nested);
    syncWorkOrder(tenantId, wo.id, wo, { nested });
    return out;
  }

  /** Verkoopgegevens per code (facturen, catalogus): { CODE: { id, name, unit, salePrice, vatRate, revenueGroup } }. */
  function saleInfo(tenantId, codes = null) {
    const list0 = codes ? [...new Set(codes.map(normCode))].filter(Boolean) : null;
    if (list0 && !list0.length) return {};
    const rows = list0
      ? q(`SELECT id, code, name, unit, sale_price, vat_rate, revenue_group FROM stock_items WHERE tenant_id = ? AND code IN (${marks(list0.length)})`).all(tenantId, ...list0)
      : q('SELECT id, code, name, unit, sale_price, vat_rate, revenue_group FROM stock_items WHERE tenant_id = ? AND archived = 0').all(tenantId);
    const out = {};
    for (const r of rows) {
      out[r.code] = { id: r.id, name: r.name, unit: r.unit, salePrice: r.sale_price == null ? null : Number(r.sale_price), vatRate: Number(r.vat_rate), revenueGroup: r.revenue_group };
    }
    return out;
  }

  return {
    list, get, create, update, remove, move, importCatalog, importShop, movements, reservations: reservationsOf,
    syncWorkOrder, resyncOpen, complete, onWorkOrderChange, forWorkOrder, issue, syncUsage, book, saleInfo, findCode,
    onDirty: (fn) => { dirtyHook = fn; },
  };
}

/**
 * API-routes. ctx: { stock, requireRight, requireJson, audit }. Het beheer
 * van de voorraad valt onder het recht 'voorraad'; de voorraad van een
 * werkorder bekijken en afboeken onder 'werkorders'. Gegevens per omgeving
 * via req.tenantId.
 */
function registerStockRoutes(app, ctx) {
  const { stock, requireRight, requireJson, audit } = ctx;
  const requireStock = requireRight('voorraad');
  const requireWo = requireRight('werkorders');
  const tid = (req) => req.tenantId || req.user.tenant_id;
  const notFound = (res, what = 'Artikel') => res.status(404).json({ error: 'not_found', message: `${what} niet gevonden.` });
  const fail = (res, out) => (out.error === 'not_found' ? notFound(res)
    : res.status(out.status || 400).json({ error: out.status === 409 ? 'conflict' : 'invalid', message: out.error, field: out.field }));
  const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

  app.get('/api/stock', requireStock, (req, res) => {
    noStore(res);
    res.json({ items: stock.list(tid(req), { archived: req.query.archived === '1' }), kinds: KINDS, groups: GROUPS });
  });

  app.get('/api/stock/reservations', requireStock, (req, res) => {
    noStore(res);
    res.json({ items: stock.reservations(tid(req)) });
  });

  app.get('/api/stock/movements', requireStock, (req, res) => {
    noStore(res);
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if ((from && !isDate(from)) || (to && !isDate(to))) return res.status(400).json({ error: 'invalid_date', message: 'Ongeldige datum.' });
    res.json({ items: stock.movements(tid(req), { from, to, limit: req.query.limit }), limit: EXPORT_LIMIT });
  });

  app.get('/api/stock/items/:id', requireStock, (req, res) => {
    noStore(res);
    const item = stock.get(tid(req), req.params.id);
    if (!item) return notFound(res);
    res.json(item);
  });

  app.post('/api/stock/items', requireJson, requireStock, (req, res) => {
    const out = stock.create(tid(req), req.user, req.body);
    if (out.error) return fail(res, out);
    audit(req, 'voorraad_artikel_aangemaakt', { itemId: out.item.id, code: out.item.code });
    res.status(201).json(out.item);
  });

  app.post('/api/stock/import', requireJson, requireStock, (req, res) => {
    const out = stock.importCatalog(tid(req), req.user, req.body?.codes);
    if (out.error) return fail(res, out);
    if (out.created) audit(req, 'voorraad_catalogus_overgenomen', { created: out.created });
    res.json(out);
  });

  // Webshopproducten die nog geen voorraadartikel zijn (om over te nemen).
  app.get('/api/stock/shop-products', requireStock, (req, res) => {
    noStore(res);
    const products = ctx.shopProductsOf ? ctx.shopProductsOf(tid(req)) : [];
    const have = new Set(stock.list(tid(req), { archived: true }).flatMap((i) => [i.code, i.shop.productId ? `#${i.shop.productId}` : '']));
    res.json({
      items: products.filter((p) => !have.has(`#${p.id}`) && !have.has(normCode(p.code || p.sku)))
        .map((p) => ({ id: p.id, sku: p.sku, code: normCode(p.code || p.sku), name: p.name, price: p.price, inStock: p.inStock })),
    });
  });

  app.post('/api/stock/import-shop', requireJson, requireStock, (req, res) => {
    const out = stock.importShop(tid(req), ctx.shopProductsOf ? ctx.shopProductsOf(tid(req)) : [], req.body?.ids);
    if (out.error) return fail(res, out);
    if (out.created) audit(req, 'voorraad_webshop_overgenomen', { created: out.created });
    res.json(out);
  });

  app.put('/api/stock/items/:id', requireJson, requireStock, (req, res) => {
    const out = stock.update(tid(req), req.params.id, req.body);
    if (out.error) return fail(res, out);
    res.json(out.item);
  });

  app.delete('/api/stock/items/:id', requireStock, (req, res) => {
    const out = stock.remove(tid(req), req.params.id);
    if (!out) return notFound(res);
    audit(req, out.deleted ? 'voorraad_artikel_verwijderd' : 'voorraad_artikel_gearchiveerd', { itemId: req.params.id, code: out.code });
    res.json(out);
  });

  app.post('/api/stock/items/:id/movements', requireJson, requireStock, (req, res) => {
    const out = stock.move(tid(req), req.user, req.params.id, req.body);
    if (out.error) return fail(res, out);
    if (req.body.kind !== 'ontvangst') audit(req, `voorraad_${req.body.kind}`, { itemId: out.item.id, code: out.item.code, delta: out.delta });
    res.status(201).json(out.item);
  });

  app.post('/api/stock/resync', requireJson, requireStock, (req, res) => {
    res.json({ workOrders: stock.resyncOpen(tid(req)) });
  });

  // ---------- Vanuit de werkorder ----------
  app.get('/api/stock/workorders/:id', requireWo, (req, res) => {
    noStore(res);
    const out = stock.forWorkOrder(tid(req), req.params.id);
    if (!out) return notFound(res, 'Werkorder');
    res.json(out);
  });

  app.post('/api/stock/workorders/:id/reserve', requireJson, requireWo, (req, res) => {
    const out = stock.forWorkOrder(tid(req), req.params.id);
    if (!out) return notFound(res, 'Werkorder');
    stock.syncWorkOrder(tid(req), req.params.id);
    res.json(stock.forWorkOrder(tid(req), req.params.id));
  });

  app.post('/api/stock/workorders/:id/issue', requireJson, requireWo, (req, res) => {
    const out = stock.issue(tid(req), req.user, req.params.id, req.body?.lines, req.body?.note);
    if (out.error === 'not_found') return notFound(res, 'Werkorder');
    if (out.error) return fail(res, out);
    audit(req, 'voorraad_afgeboekt', { workOrderId: req.params.id, lines: out.booked });
    res.json(out.stock);
  });
}

module.exports = { createStockStore, registerStockRoutes, sanitizeItem, needsOf, KINDS, GROUPS, VAT_RATES };
