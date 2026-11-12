// Leveranciers en welke leverancier welk artikel levert (tabellen suppliers en item_suppliers, migratie 59).
//
// - Een leverancier heeft een naam (uniek per omgeving, zonder hoofdletters) en contactgegevens.
//   Een leverancier die aan artikelen hangt wordt bij verwijderen gearchiveerd (hij blijft in de
//   koppelingen en later in inkooporders staan); zonder koppelingen gaat hij echt weg.
// - Per artikel kunnen een of meer leveranciers staan, met het artikelnummer van de leverancier,
//   een eigen inkoopprijs (leeg = de prijs van het artikel), de bestelhoeveelheid (bestellen in
//   veelvouden, bijvoorbeeld een doos van 25) en welke leverancier de voorkeur heeft. Er is
//   hoogstens één voorkeur per artikel; de eerste leverancier is de voorkeur zolang er geen is gekozen.
// - Een hoofdartikel (met varianten) heeft zelf geen leverancier: die hoort bij de varianten.
const crypto = require('crypto');
const { transaction } = require('../database/db');

const MAX_SUPPLIERS_PER_ITEM = 20;
const MAX_COST_PRICE = 1000000;
const MAX_ORDER_QTY = 1000000;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

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
 * Rondt een bedrag af op vier decimalen (prijs per eenheid).
 * @param {number} value Het bedrag.
 * @returns {number} Het afgeronde bedrag.
 */
const round4 = (value) => Math.round(value * 10000) / 10000;

/**
 * Rondt een aantal af op drie decimalen.
 * @param {number} value Het aantal.
 * @returns {number} Het afgeronde aantal.
 */
const round3 = (value) => Math.round(value * 1000) / 1000;

/**
 * Controleert en schoont de gegevens van een leverancier.
 * @param {object} input De invoer (name, contactName, email, phone, address, notes).
 * @param {{ partial?: boolean }} [options] Bij een wijziging mogen velden ontbreken.
 * @returns {{ value?: object, error?: string, field?: string }} De schone velden, of een fout.
 */
function sanitizeSupplier(input, { partial = false } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const value = {};
  if (!partial || source.name !== undefined) {
    value.name = cleanText(source.name, 120);
    if (!value.name) return { error: 'Vul de naam van de leverancier in.', field: 'name' };
  }
  if (!partial || source.contactName !== undefined) value.contactName = cleanText(source.contactName, 120);
  if (!partial || source.email !== undefined) {
    value.email = cleanText(source.email, 200);
    if (value.email && !EMAIL_PATTERN.test(value.email)) return { error: 'Dit e-mailadres is niet geldig.', field: 'email' };
  }
  if (!partial || source.phone !== undefined) value.phone = cleanText(source.phone, 40);
  if (!partial || source.address !== undefined) value.address = cleanText(source.address, 300);
  if (!partial || source.notes !== undefined) value.notes = cleanText(source.notes, 2000);
  if (partial && source.archived !== undefined) {
    if (typeof source.archived !== 'boolean') return { error: 'Archiveren is ja of nee.', field: 'archived' };
    value.archived = source.archived;
  }
  return { value };
}

/**
 * Controleert en schoont de leveranciersregels van één artikel.
 * @param {*} entries De invoer: [{ supplierId, supplierSku, costPrice, orderQty, preferred }].
 * @returns {{ value?: object[], error?: string, field?: string }} De schone regels, of een fout.
 */
function sanitizeItemSuppliers(entries) {
  if (!Array.isArray(entries)) return { error: 'Geef de leveranciers als lijst.', field: 'suppliers' };
  if (entries.length > MAX_SUPPLIERS_PER_ITEM) return { error: `Een artikel kan hoogstens ${MAX_SUPPLIERS_PER_ITEM} leveranciers hebben.`, field: 'suppliers' };
  const seen = new Set();
  const value = [];
  for (const entry of entries) {
    const supplierId = cleanText(entry && entry.supplierId, 60);
    if (!supplierId) return { error: 'Kies een leverancier.', field: 'supplierId' };
    if (seen.has(supplierId)) return { error: 'Een leverancier staat al bij dit artikel.', field: 'supplierId' };
    seen.add(supplierId);
    let costPrice = null;
    if (entry.costPrice !== undefined && entry.costPrice !== null && entry.costPrice !== '') {
      costPrice = Number(entry.costPrice);
      if (!Number.isFinite(costPrice) || costPrice < 0 || costPrice > MAX_COST_PRICE) return { error: 'De inkoopprijs is niet geldig.', field: 'costPrice' };
      costPrice = round4(costPrice);
    }
    let orderQty = 1;
    if (entry.orderQty !== undefined && entry.orderQty !== null && entry.orderQty !== '') {
      orderQty = Number(entry.orderQty);
      if (!Number.isFinite(orderQty) || orderQty <= 0 || orderQty > MAX_ORDER_QTY) return { error: 'De bestelhoeveelheid moet groter zijn dan 0.', field: 'orderQty' };
      orderQty = round3(orderQty);
    }
    value.push({ supplierId, supplierSku: cleanText(entry.supplierSku, 80), costPrice, orderQty, preferred: Boolean(entry.preferred) });
  }
  // Hoogstens één voorkeur: de eerste die is aangevinkt; zonder voorkeur is de eerste leverancier het.
  const firstPreferred = value.findIndex((entry) => entry.preferred);
  value.forEach((entry, index) => { entry.preferred = index === (firstPreferred >= 0 ? firstPreferred : 0); });
  return { value };
}

/**
 * Zet een rij uit suppliers om naar het formaat van de API.
 * @param {object} row De rij.
 * @param {number} [itemCount] Aantal artikelen dat de leverancier levert.
 * @returns {object} De leverancier.
 */
function supplierOf(row, itemCount) {
  const out = { id: row.id, name: row.name, contactName: row.contact_name, email: row.email, phone: row.phone, address: row.address, notes: row.notes, archived: Boolean(Number(row.archived)) };
  if (itemCount !== undefined) out.itemCount = itemCount;
  return out;
}

/**
 * Maakt de opslag voor leveranciers.
 * @param {object} db De database.
 * @returns {object} list, get, create, update, remove, forItem, setForItem, preferredByItem.
 */
function createSupplierStore(db) {
  /**
   * Maakt een query klaar.
   * @param {string} sql De query.
   * @returns {object} De voorbereide query.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Zoekt één leverancier van een omgeving.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de leverancier.
   * @returns {object|undefined} De rij.
   */
  function findRow(tenantId, id) {
    return prepare('SELECT id, name, contact_name, email, phone, address, notes, archived FROM suppliers WHERE tenant_id = ? AND id = ?').get(tenantId, String(id || ''));
  }

  /**
   * Is deze naam al in gebruik (zonder hoofdletters)?
   * @param {string} tenantId Id van de omgeving.
   * @param {string} name De naam.
   * @param {string} [exceptId] Deze leverancier telt niet mee.
   * @returns {boolean} true als de naam bezet is.
   */
  function nameTaken(tenantId, name, exceptId = '') {
    return Boolean(prepare('SELECT id FROM suppliers WHERE tenant_id = ? AND LOWER(name) = LOWER(?) AND id <> ?').get(tenantId, name, exceptId));
  }

  /**
   * De leveranciers van de omgeving, op naam, met het aantal artikelen per leverancier.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ archived?: boolean }} [options] Ook de gearchiveerde.
   * @returns {object[]} De leveranciers.
   */
  function list(tenantId, { archived = false } = {}) {
    const counts = new Map(prepare('SELECT supplier_id, COUNT(*) AS n FROM item_suppliers WHERE tenant_id = ? GROUP BY supplier_id').all(tenantId).map((row) => [row.supplier_id, Number(row.n)]));
    const rows = prepare(`SELECT id, name, contact_name, email, phone, address, notes, archived FROM suppliers WHERE tenant_id = ?${archived ? '' : ' AND archived = 0'}`).all(tenantId);
    return rows.map((row) => supplierOf(row, counts.get(row.id) || 0)).sort((left, right) => left.name.localeCompare(right.name, 'nl'));
  }

  /**
   * Eén leverancier.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de leverancier.
   * @returns {object|null} De leverancier, of null.
   */
  function get(tenantId, id) {
    const row = findRow(tenantId, id);
    if (!row) return null;
    const count = prepare('SELECT COUNT(*) AS n FROM item_suppliers WHERE tenant_id = ? AND supplier_id = ?').get(tenantId, row.id).n;
    return supplierOf(row, Number(count));
  }

  /**
   * Maakt een leverancier aan.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} input De gegevens.
   * @returns {{ supplier?: object, error?: string, field?: string, status?: number }} De leverancier, of een fout.
   */
  function create(tenantId, input) {
    const checked = sanitizeSupplier(input);
    if (checked.error) return checked;
    const fields = checked.value;
    return transaction(db, () => {
      if (nameTaken(tenantId, fields.name)) return { error: 'Er is al een leverancier met deze naam.', field: 'name', status: 409 };
      const id = crypto.randomUUID();
      const timestamp = currentTimestamp();
      prepare('INSERT INTO suppliers (id, tenant_id, name, contact_name, email, phone, address, notes, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
        .run(id, tenantId, fields.name, fields.contactName, fields.email, fields.phone, fields.address, fields.notes, timestamp, timestamp);
      return { supplier: get(tenantId, id) };
    });
  }

  /**
   * Wijzigt een leverancier (alleen de meegegeven velden; archived haalt hem uit of terug in de lijst).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de leverancier.
   * @param {object} input De te wijzigen velden.
   * @returns {{ supplier?: object, error?: string, field?: string, status?: number }} De leverancier, of een fout.
   */
  function update(tenantId, id, input) {
    const checked = sanitizeSupplier(input, { partial: true });
    if (checked.error) return checked;
    const fields = checked.value;
    return transaction(db, () => {
      const row = findRow(tenantId, id);
      if (!row) return { error: 'not_found', status: 404 };
      if (fields.name !== undefined && nameTaken(tenantId, fields.name, row.id)) return { error: 'Er is al een leverancier met deze naam.', field: 'name', status: 409 };
      const merged = {
        name: fields.name ?? row.name, contactName: fields.contactName ?? row.contact_name, email: fields.email ?? row.email,
        phone: fields.phone ?? row.phone, address: fields.address ?? row.address, notes: fields.notes ?? row.notes,
        archived: fields.archived !== undefined ? (fields.archived ? 1 : 0) : Number(row.archived),
      };
      prepare('UPDATE suppliers SET name = ?, contact_name = ?, email = ?, phone = ?, address = ?, notes = ?, archived = ?, updated_at = ? WHERE tenant_id = ? AND id = ?')
        .run(merged.name, merged.contactName, merged.email, merged.phone, merged.address, merged.notes, merged.archived, currentTimestamp(), tenantId, row.id);
      return { supplier: get(tenantId, row.id) };
    });
  }

  /**
   * Verwijdert een leverancier; hangt hij aan artikelen, dan wordt hij gearchiveerd.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} id Id van de leverancier.
   * @returns {{ deleted?: boolean, archived?: boolean, name?: string }|null} De uitkomst, of null als hij niet bestaat.
   */
  function remove(tenantId, id) {
    return transaction(db, () => {
      const row = findRow(tenantId, id);
      if (!row) return null;
      const linked = prepare(`SELECT (EXISTS (SELECT 1 FROM item_suppliers WHERE tenant_id = ? AND supplier_id = ?)
        OR EXISTS (SELECT 1 FROM purchase_orders WHERE tenant_id = ? AND supplier_id = ?)) AS n`).get(tenantId, row.id, tenantId, row.id).n;
      if (linked) {
        prepare('UPDATE suppliers SET archived = 1, updated_at = ? WHERE tenant_id = ? AND id = ?').run(currentTimestamp(), tenantId, row.id);
        return { archived: true, name: row.name };
      }
      prepare('DELETE FROM suppliers WHERE tenant_id = ? AND id = ?').run(tenantId, row.id);
      return { deleted: true, name: row.name };
    });
  }

  /**
   * De leveranciers van één artikel (voorkeur eerst, dan op naam).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {object[]|null} De regels, of null als het artikel niet bestaat.
   */
  function forItem(tenantId, itemId) {
    const item = prepare('SELECT id FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, String(itemId || ''));
    if (!item) return null;
    const rows = prepare(`SELECT l.supplier_id, l.supplier_sku, l.cost_price, l.order_qty, l.preferred, s.name AS supplier_name, s.archived AS supplier_archived
      FROM item_suppliers l JOIN suppliers s ON s.tenant_id = l.tenant_id AND s.id = l.supplier_id
      WHERE l.tenant_id = ? AND l.item_id = ?`).all(tenantId, item.id);
    return rows.map((row) => ({
      supplierId: row.supplier_id, supplierName: row.supplier_name, supplierArchived: Boolean(Number(row.supplier_archived)), supplierSku: row.supplier_sku,
      costPrice: row.cost_price == null ? null : Number(row.cost_price), orderQty: Number(row.order_qty), preferred: Boolean(Number(row.preferred)),
    })).sort((left, right) => Number(right.preferred) - Number(left.preferred) || left.supplierName.localeCompare(right.supplierName, 'nl'));
  }

  /**
   * Vervangt de leveranciers van een artikel door de opgegeven lijst.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {*} entries De regels: [{ supplierId, supplierSku, costPrice, orderQty, preferred }].
   * @returns {{ suppliers?: object[], error?: string, field?: string, status?: number }} De nieuwe lijst, of een fout.
   */
  function setForItem(tenantId, itemId, entries) {
    const checked = sanitizeItemSuppliers(entries);
    if (checked.error) return checked;
    return transaction(db, () => {
      const item = prepare('SELECT id, has_variants FROM stock_items WHERE tenant_id = ? AND id = ?').get(tenantId, String(itemId || ''));
      if (!item) return { error: 'not_found', status: 404 };
      if (Number(item.has_variants) && checked.value.length) return { error: 'Een hoofdartikel heeft geen eigen leverancier; stel die in bij de varianten.', field: 'suppliers', status: 409 };
      if (checked.value.length) {
        const ids = checked.value.map((entry) => entry.supplierId);
        const known = prepare(`SELECT id, archived FROM suppliers WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(', ')})`).all(tenantId, ...ids);
        const unknown = ids.find((id) => !known.some((row) => row.id === id));
        if (unknown) return { error: 'Deze leverancier bestaat niet.', field: 'supplierId', status: 404 };
        // Een gearchiveerde leverancier mag niet nieuw bij een artikel; bestaande koppelingen blijven staan.
        const already = new Set(prepare('SELECT supplier_id FROM item_suppliers WHERE tenant_id = ? AND item_id = ?').all(tenantId, item.id).map((row) => row.supplier_id));
        if (known.some((row) => Number(row.archived) && !already.has(row.id))) return { error: 'Deze leverancier is gearchiveerd; zet hem eerst terug uit het archief.', field: 'supplierId', status: 409 };
      }
      prepare('DELETE FROM item_suppliers WHERE tenant_id = ? AND item_id = ?').run(tenantId, item.id);
      const timestamp = currentTimestamp();
      for (const entry of checked.value) {
        prepare('INSERT INTO item_suppliers (id, tenant_id, item_id, supplier_id, supplier_sku, cost_price, order_qty, preferred, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), tenantId, item.id, entry.supplierId, entry.supplierSku, entry.costPrice, entry.orderQty, entry.preferred ? 1 : 0, timestamp);
      }
      return { suppliers: forItem(tenantId, item.id) };
    });
  }

  /**
   * De voorkeursleverancier van elk artikel dat er een heeft (voor het bestelvoorstel per leverancier).
   * @param {string} tenantId Id van de omgeving.
   * @returns {Map<string, object>} Artikel-id naar { supplierId, supplierName, supplierSku, costPrice, orderQty }.
   */
  function preferredByItem(tenantId) {
    const rows = prepare(`SELECT l.item_id, l.supplier_id, l.supplier_sku, l.cost_price, l.order_qty, s.name AS supplier_name
      FROM item_suppliers l JOIN suppliers s ON s.tenant_id = l.tenant_id AND s.id = l.supplier_id
      WHERE l.tenant_id = ? AND l.preferred = 1 AND s.archived = 0`).all(tenantId);
    return new Map(rows.map((row) => [row.item_id, {
      supplierId: row.supplier_id, supplierName: row.supplier_name, supplierSku: row.supplier_sku,
      costPrice: row.cost_price == null ? null : Number(row.cost_price), orderQty: Number(row.order_qty),
    }]));
  }

  return { list, get, create, update, remove, forItem, setForItem, preferredByItem };
}

/**
 * Hangt de routes voor leveranciers aan de app (recht voorraad).
 * @param {object} app De Express-app.
 * @param {{ suppliers: object, requireRight: Function, requireJson: Function, audit: Function }} ctx De opslag en hulpfuncties van de server.
 * @returns {void}
 */
function registerSupplierRoutes(app, ctx) {
  const { suppliers, requireRight, requireJson, audit } = ctx;
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
   * @param {string} what Wat niet gevonden is.
   * @returns {void}
   */
  const notFound = (res, what) => res.status(404).json({ error: 'not_found', message: `${what} niet gevonden.` });
  /**
   * Stuurt een fout uit de opslag terug (404, 409 of 400 met het veld).
   * @param {object} res Het antwoord.
   * @param {{ error: string, status?: number, field?: string }} out De fout.
   * @param {string} what Wat bij een 404 niet gevonden is.
   * @returns {void}
   */
  const fail = (res, out, what) => (out.status === 404 && out.error === 'not_found' ? notFound(res, what)
    : res.status(out.status || 400).json({ error: out.status === 409 ? 'conflict' : 'invalid', message: out.error, field: out.field }));

  app.get('/api/suppliers', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: suppliers.list(tenantOf(req), { archived: req.query.archived === '1' }) });
  });

  app.post('/api/suppliers', requireJson, requireStock, (req, res) => {
    const out = suppliers.create(tenantOf(req), req.body);
    if (out.error) return fail(res, out, 'Leverancier');
    audit(req, 'leverancier_aangemaakt', { name: out.supplier.name });
    res.status(201).json(out.supplier);
  });

  app.patch('/api/suppliers/:id', requireJson, requireStock, (req, res) => {
    const out = suppliers.update(tenantOf(req), req.params.id, req.body);
    if (out.error) return fail(res, out, 'Leverancier');
    audit(req, 'leverancier_gewijzigd', { name: out.supplier.name });
    res.json(out.supplier);
  });

  app.delete('/api/suppliers/:id', requireStock, (req, res) => {
    const out = suppliers.remove(tenantOf(req), req.params.id);
    if (!out) return notFound(res, 'Leverancier');
    audit(req, out.archived ? 'leverancier_gearchiveerd' : 'leverancier_verwijderd', { name: out.name });
    res.json(out.archived ? { archived: true } : { deleted: true });
  });

  app.get('/api/stock/items/:id/suppliers', requireStock, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const rows = suppliers.forItem(tenantOf(req), req.params.id);
    if (!rows) return notFound(res, 'Artikel');
    res.json({ items: rows });
  });

  app.put('/api/stock/items/:id/suppliers', requireJson, requireStock, (req, res) => {
    const out = suppliers.setForItem(tenantOf(req), req.params.id, req.body && req.body.suppliers);
    if (out.error) return fail(res, out, out.field === 'supplierId' ? 'Leverancier' : 'Artikel');
    audit(req, 'artikel_leveranciers_gewijzigd', { itemId: req.params.id, count: out.suppliers.length });
    res.json({ items: out.suppliers });
  });
}

module.exports = { createSupplierStore, registerSupplierRoutes, sanitizeSupplier, sanitizeItemSuppliers };
