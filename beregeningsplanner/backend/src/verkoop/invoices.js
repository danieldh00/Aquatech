// Facturen: opslag (tabel invoices, migratie 26), de factuurinstellingen
// (instelling invoicing: nummering, betaaltermijn, omzetcategorieën met
// grootboekrekening) en de API-routes. De berekening staat in
// frontend/facturen/invoice-core.js en is gedeeld met de browser.
//
// - Een factuur begint als concept (zonder nummer) en wordt definitief met
//   een doorlopend nummer per jaar (<voorvoegsel><jaar>-0001). Daarna ligt
//   hij vast; corrigeren gaat met een creditfactuur.
// - Uit een werkorder: de offerteregels plus meerwerk, of het geboekte
//   materiaal en de geboekte uren (InvoiceCore.fromWorkOrder).
// - Een losse verkoop (zonder werkorder) boekt bij definitief de artikelen
//   af van de voorraad (bron factuur:<id>); een creditfactuur daarvan boekt
//   ze terug. Bij een werkorder doet de werkorder dat al.
// - Export naar de boekhouding (Visma eAccounting): per factuur per
//   omzetcategorie een regel, als Excel in de browser; exported_at onthoudt
//   wat al is geëxporteerd.
// - Definitief maken koppelt de factuur aan een debiteur (debtors.js).
// - Versturen: per e-mail met de factuur als PDF (invoice-pdf.js), met de
//   knop of automatisch bij definitief (instelling autoSend).
// - Uit de webshop: shop-orders.js maakt van een afgeronde bestelling een
//   factuur (shop_order_id); de voorraad volgt dan uit de webshopsynchronisatie.
// Alles per omgeving (req.tenantId); recht 'facturen'.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const crypto = require('crypto');
const { transaction } = require('../database/db');
const { validEmail } = require('../platform/mailer');
const { preferencesOf } = require('../platform/store');
const { invoiceFileName } = require('./invoice-pdf');
const { SourceError } = require('../webshop/woocommerce');
const { withoutInternal } = require('./quotes');

const Core = require(path.join(FRONTEND_DIR, 'facturen', 'invoice-core.js'));

const LIST_COLS = `id, number, status, kind, credit_of, customer_id, customer_name, work_order_id, quote_id, invoice_date, due_date,
  subtotal, vat_total, total, stock_booked, finalized_at, paid_at, credited_at, exported_at, created_at, updated_at,
  debtor_id, shop_order_id, sent_at, sent_to, send_error, visma_invoice_id, visma_number, visma_synced_at, visma_error`;
// Debiteurnummer erbij (één query, geen opzoeking per factuur).
const DEBTOR_NUMBER = '(SELECT d.number FROM debtors d WHERE d.tenant_id = invoices.tenant_id AND d.id = invoices.debtor_id) AS debtor_number';
const LIST_LIMIT = 1000;
const EXPORT_LIMIT = 5000;
/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * Maakt van een async route-afhandeling een gewone: een fout gaat naar de foutafhandeling van Express.
 * @param {Function} handler De async afhandeling (req, res, next).
 * @returns {Function} De route-afhandeling.
 */
const wrapAsync = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
/**
 * Kopie aan de medewerker zelf (voorkeur mailCopy in Mijn profiel).
 * @param {object} user De ingelogde gebruiker.
 * @returns {string|undefined} Het e-mailadres, of niets.
 */
const copyTo = (user) => (user && preferencesOf(user).mailCopy && validEmail(user.email) ? user.email : undefined);
/**
 * Plaatshouders voor een IN-lijst.
 * @param {number} count Aantal waarden.
 * @returns {string} Bijv. "?,?,?".
 */
const marks = (count) => Array.from({ length: count }, () => '?').join(',');

/**
 * Maakt de opslag voor facturen.
 * @param {object} db De database.
 * @param {{ stock?: object, debtors?: object }} [stores] Voorraad (afboeken bij een losse verkoop) en debiteuren (koppelen bij definitief).
 * @returns {object} list, get, create, update, finalize, onFinalized, setPaid, credit, remove, exportList, markExported, nextNumber, workOrder, quote, byShopOrders en markSent.
 */
function createInvoiceStore(db, { stock = null, debtors = null } = {}) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De SQL.
   * @returns {object} De voorbereide opdracht.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * Zet een factuurrij om naar het formaat van de API (zonder de inhoud).
   * @param {object} row Rij met LIST_COLS (en eventueel debtor_number).
   * @returns {object} De factuur.
   */
  const toInvoice = (row) => ({
    id: row.id, number: row.number || '', status: row.status, kind: row.kind, creditOf: row.credit_of || null,
    customerId: row.customer_id || null, customer: row.customer_name, workOrderId: row.work_order_id || null, quoteId: row.quote_id || null,
    date: row.invoice_date, dueDate: row.due_date, subtotal: Number(row.subtotal), vatTotal: Number(row.vat_total), total: Number(row.total),
    stockBooked: Boolean(Number(row.stock_booked)), finalizedAt: row.finalized_at || null, paidAt: row.paid_at || null,
    creditedAt: row.credited_at || null, exportedAt: row.exported_at || null, createdAt: row.created_at, updatedAt: row.updated_at,
    debtorId: row.debtor_id || null, shopOrderId: row.shop_order_id || null,
    source: row.shop_order_id ? 'webshop' : row.work_order_id ? 'werkorder' : 'los',
    sentAt: row.sent_at || null, sentTo: row.sent_to || null, sendError: row.send_error || '',
    vismaInvoiceId: row.visma_invoice_id || null, vismaNumber: row.visma_number || null, vismaSyncedAt: row.visma_synced_at || null, vismaError: row.visma_error || '',
    ...(row.debtor_number !== undefined ? { debtorNumber: row.debtor_number == null ? null : Number(row.debtor_number) } : {}),
    overdue: row.status === 'definitief' && row.kind === 'factuur' && row.due_date < Core.today(),
  });

  /**
   * Zoekt een factuurrij binnen de tenant.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de factuur.
   * @param {string} [cols] De kolommen.
   * @returns {object|undefined} De rij.
   */
  const find = (tenantId, id, cols = LIST_COLS) => prepare(`SELECT ${cols} FROM invoices WHERE tenant_id = ? AND id = ?`).get(tenantId, String(id));

  /**
   * Facturen van een tenant, nieuwste eerst (hooguit LIST_LIMIT).
   * @param {string} tenantId Id van de tenant.
   * @param {object} [filters] status, from en to (factuurdatum) en workOrderId.
   * @returns {object[]} De facturen zonder inhoud.
   */
  function list(tenantId, { status = '', from = '', to = '', workOrderId = '' } = {}) {
    const args = [tenantId];
    let sql = `SELECT ${LIST_COLS} FROM invoices WHERE tenant_id = ?`;
    if (Core.STATUSES[status]) { sql += ' AND status = ?'; args.push(status); }
    if (Core.isDate(from)) { sql += ' AND invoice_date >= ?'; args.push(from); }
    if (Core.isDate(to)) { sql += ' AND invoice_date <= ?'; args.push(to); }
    if (workOrderId) { sql += ' AND work_order_id = ?'; args.push(String(workOrderId)); }
    return prepare(`${sql} ORDER BY invoice_date DESC, created_at DESC LIMIT ${LIST_LIMIT}`).all(...args).map(toInvoice);
  }

  /**
   * Eén factuur met inhoud en debiteurnummer.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de factuur.
   * @returns {object|null} De factuur, of null.
   */
  function get(tenantId, id) {
    const row = find(tenantId, id, `${LIST_COLS}, ${DEBTOR_NUMBER}, data`);
    if (!row) return null;
    return { ...toInvoice(row), data: JSON.parse(row.data) };
  }

  /**
   * Facturen bij webshopbestellingen, in blokken van 500.
   * @param {string} tenantId Id van de tenant.
   * @param {Array<string|number>} orderIds Bestelnummers uit de webshop.
   * @returns {Map<string, string>} Bestelnummer → id van de factuur (alleen bestellingen met een factuur).
   */
  function byShopOrders(tenantId, orderIds) {
    const ids = [...new Set(orderIds.map(String))];
    const out = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const row of prepare(`SELECT id, shop_order_id FROM invoices WHERE tenant_id = ? AND shop_order_id IN (${marks(part.length)})`).all(tenantId, ...part)) out.set(row.shop_order_id, row.id);
    }
    return out;
  }

  /**
   * Het volgende factuurnummer per tenant en jaar: <voorvoegsel><jaar>-0001, oplopend.
   * @param {string} tenantId Id van de tenant.
   * @param {string} prefix Voorvoegsel uit de instellingen.
   * @param {string} year Het jaar van de factuurdatum.
   * @returns {string} Het nummer.
   */
  function nextNumber(tenantId, prefix, year) {
    const head = `${prefix}${year}-`;
    let max = 0;
    for (const row of prepare('SELECT number FROM invoices WHERE tenant_id = ? AND number IS NOT NULL AND substr(number, 1, ?) = ?').all(tenantId, head.length, head)) {
      const sequence = Number(row.number.slice(head.length));
      if (Number.isInteger(sequence) && sequence > max) max = sequence;
    }
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  /**
   * Maakt een conceptfactuur.
   * @param {string} tenantId Id van de tenant.
   * @param {object|null} user Wie hem maakt.
   * @param {object} rawData De inhoud (wordt opgeschoond).
   * @param {object} settings De factuurinstellingen.
   * @param {object} [links] workOrderId, quoteId, customerId, kind ('factuur'|'credit'), creditOf, shopOrderId en debtorId.
   * @returns {object} De nieuwe factuur.
   */
  function create(tenantId, user, rawData, settings, { workOrderId = null, quoteId = null, customerId = null, kind = 'factuur', creditOf = null, shopOrderId = null, debtorId = null } = {}) {
    const data = Core.sanitize(rawData, settings);
    const totals = Core.totals(data, settings);
    const id = crypto.randomUUID();
    const timestamp = currentTimestamp();
    prepare(`INSERT INTO invoices (id, tenant_id, number, status, kind, credit_of, customer_id, customer_name, work_order_id, quote_id, invoice_date, due_date,
        subtotal, vat_total, total, data, stock_booked, created_by, created_at, updated_at, shop_order_id, debtor_id)
       VALUES (?, ?, NULL, 'concept', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, kind === 'credit' ? 'credit' : 'factuur', creditOf, customerId, data.customer.name.trim(), workOrderId, quoteId,
        data.date, data.dueDate, totals.net, totals.vatTotal, totals.total, JSON.stringify(data), user ? user.id : null, timestamp, timestamp,
        shopOrderId ? String(shopOrderId) : null, debtorId);
    return get(tenantId, id);
  }

  /**
   * Slaat een conceptfactuur op; een definitieve ligt vast.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de factuur.
   * @param {object} rawData De inhoud (wordt opgeschoond).
   * @param {object} settings De factuurinstellingen.
   * @returns {object|null} De factuur, { locked: true } als hij definitief is, of null.
   */
  function update(tenantId, id, rawData, settings) {
    const row = find(tenantId, id);
    if (!row) return null;
    if (row.status !== 'concept') return { locked: true };
    const data = Core.sanitize(rawData, settings);
    const totals = Core.totals(data, settings);
    prepare(`UPDATE invoices SET customer_name = ?, invoice_date = ?, due_date = ?, subtotal = ?, vat_total = ?, total = ?, data = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'concept'`)
      .run(data.customer.name.trim(), data.date, data.dueDate, totals.net, totals.vatTotal, totals.total, JSON.stringify(data), currentTimestamp(), tenantId, row.id);
    return get(tenantId, row.id);
  }

  // Functies die na definitief draaien (buiten de transactie), bijv. doorsturen naar Visma.
  const finalizedHooks = [];
  /**
   * Laat een functie draaien na elke definitief gemaakte factuur (buiten de transactie), bijv. doorsturen naar Visma.
   * @param {Function} hook Krijgt (tenantId, invoice).
   */
  const onFinalized = (hook) => { finalizedHooks.push(hook); };
  /**
   * Maakt een factuur definitief en roept daarna de haken van onFinalized aan.
   * @param {string} tenantId Id van de tenant.
   * @param {object|null} user Wie het doet.
   * @param {string} id Id van de factuur.
   * @param {object} settings De factuurinstellingen.
   * @param {{ skipStock?: boolean }} [options] Zie finalizeTx.
   * @returns {object|null} Zie finalizeTx.
   */
  function finalize(tenantId, user, id, settings, options) {
    const out = finalizeTx(tenantId, user, id, settings, options);
    if (out && out.invoice) {
      for (const hook of finalizedHooks) {
        try { hook(tenantId, out.invoice); } catch (error) { console.warn(`Na definitief: ${error.message}`); }
      }
    }
    return out;
  }
  /**
   * Definitief maken in één transactie: nummer, voorraad (bij een losse
   * verkoop), debiteur en vastleggen. Een creditfactuur boekt alleen terug wat
   * de oorspronkelijke factuur heeft afgeboekt.
   * @param {string} tenantId Id van de tenant.
   * @param {object|null} user Wie het doet.
   * @param {string} id Id van de factuur.
   * @param {object} settings De factuurinstellingen.
   * @param {{ skipStock?: boolean }} [options] skipStock: niet afboeken (webshopbestelling waarvan de voorraad al via de webshopsynchronisatie is afgeboekt).
   * @returns {{ invoice: object, booked: number }|{ error: string, status: number, field?: string }|null} De factuur en het aantal afboekingen, een fout, of null.
   */
  function finalizeTx(tenantId, user, id, settings, { skipStock = false } = {}) {
    return transaction(db, () => {
      const row = find(tenantId, id, `${LIST_COLS}, data`);
      if (!row) return null;
      if (row.status !== 'concept') return { error: 'Deze factuur is al definitief.', status: 409 };
      const data = JSON.parse(row.data);
      if (!data.customer.name.trim()) return { error: 'Vul de naam van de klant in.', field: 'customer', status: 400 };
      if (!data.lines.length) return { error: 'Een factuur zonder regels kan niet definitief worden.', field: 'lines', status: 400 };
      const number = nextNumber(tenantId, settings.prefix, data.date.slice(0, 4));
      const timestamp = currentTimestamp();
      let booked = 0;
      if (stock && !row.work_order_id && !(row.shop_order_id && skipStock)) {
        const wantCredit = row.kind === 'credit';
        // Een creditfactuur boekt alleen terug wat de oorspronkelijke factuur heeft afgeboekt.
        const original = wantCredit && row.credit_of ? find(tenantId, row.credit_of) : null;
        if (!wantCredit || (original && Number(original.stock_booked))) {
          for (const line of data.lines) {
            const item = line.code ? stock.findCode(tenantId, line.code) : null;
            if (!item || item.archived || !line.qty) continue;
            stock.book(tenantId, item.id, -line.qty, {
              kind: line.qty > 0 ? 'afboeking' : 'retour', source: `factuur:${row.id}`, user,
              note: `${wantCredit ? 'Creditfactuur' : 'Factuur'} ${number}`,
            });
            booked++;
          }
        }
      }
      // Debiteur: dezelfde als bij de vorige factuur van deze klant, of een nieuwe.
      let debtorId = row.debtor_id || null;
      if (debtors && !debtorId) {
        const debtor = debtors.ensure(tenantId, data.customer, { customerId: row.customer_id, source: row.shop_order_id ? 'webshop' : 'factuur', start: settings.debtorStart });
        if (debtor) debtorId = debtor.id;
      }
      prepare(`UPDATE invoices SET number = ?, status = 'definitief', finalized_at = ?, stock_booked = ?, debtor_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
        .run(number, timestamp, booked ? 1 : 0, debtorId, timestamp, tenantId, row.id);
      if (row.kind === 'credit' && row.credit_of) prepare('UPDATE invoices SET credited_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(timestamp, timestamp, tenantId, row.credit_of);
      return { invoice: get(tenantId, row.id), booked };
    });
  }

  /**
   * Zet een definitieve factuur op betaald of terug op onbetaald.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de factuur.
   * @param {boolean} paid Betaald of niet.
   * @param {string} [date] Betaaldatum (JJJJ-MM-DD); zonder = nu.
   * @returns {{ invoice: object }|{ error: string, status: number }|null} De factuur, een fout, of null.
   */
  function setPaid(tenantId, id, paid, date) {
    const row = find(tenantId, id);
    if (!row) return null;
    if (row.status === 'concept') return { error: 'Maak de factuur eerst definitief.', status: 409 };
    const paidAt = paid ? (Core.isDate(date) ? `${date}T12:00:00.000Z` : currentTimestamp()) : null;
    prepare('UPDATE invoices SET status = ?, paid_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(paid ? 'betaald' : 'definitief', paidAt, currentTimestamp(), tenantId, row.id);
    return { invoice: get(tenantId, row.id) };
  }

  /**
   * Maakt een creditfactuur (concept) bij een definitieve factuur; een open concept wordt hergebruikt.
   * @param {string} tenantId Id van de tenant.
   * @param {object|null} user Wie het doet.
   * @param {string} id Id van de oorspronkelijke factuur.
   * @param {object} settings De factuurinstellingen.
   * @returns {{ invoice: object, existing?: boolean }|{ error: string, status: number }|null} De creditfactuur, een fout, of null.
   */
  function credit(tenantId, user, id, settings) {
    const original = get(tenantId, id);
    if (!original) return null;
    if (original.status === 'concept') return { error: 'Een concept kun je gewoon aanpassen of verwijderen.', status: 409 };
    if (original.kind === 'credit') return { error: 'Een creditfactuur kun je niet crediteren.', status: 409 };
    const openCredit = prepare("SELECT id FROM invoices WHERE tenant_id = ? AND credit_of = ? AND status = 'concept'").get(tenantId, original.id);
    if (openCredit) return { invoice: get(tenantId, openCredit.id), existing: true };
    return {
      invoice: create(tenantId, user, Core.creditOf(original), settings, {
        workOrderId: original.workOrderId, quoteId: original.quoteId, customerId: original.customerId, kind: 'credit', creditOf: original.id, debtorId: original.debtorId,
      }),
    };
  }

  /**
   * Verwijdert een conceptfactuur; een definitieve kan niet weg (bewaarplicht).
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de factuur.
   * @returns {{ deleted: boolean }|{ error: string, status: number }|null} Resultaat, een fout, of null.
   */
  function remove(tenantId, id) {
    const row = find(tenantId, id);
    if (!row) return null;
    if (row.status !== 'concept') return { error: 'Een definitieve factuur kan niet weg (bewaarplicht); maak een creditfactuur.', status: 409 };
    prepare("DELETE FROM invoices WHERE tenant_id = ? AND id = ? AND status = 'concept'").run(tenantId, row.id);
    return { deleted: true };
  }

  /**
   * Definitieve facturen met inhoud voor de export, oudste eerst.
   * @param {string} tenantId Id van de tenant.
   * @param {{ from?: string, to?: string, onlyNew?: boolean }} [filters] Periode (factuurdatum) en alleen nog niet geëxporteerde.
   * @returns {object[]} De facturen.
   */
  function exportList(tenantId, { from = '', to = '', onlyNew = false } = {}) {
    const args = [tenantId];
    let sql = `SELECT ${LIST_COLS}, ${DEBTOR_NUMBER}, data FROM invoices WHERE tenant_id = ? AND status <> 'concept'`;
    if (Core.isDate(from)) { sql += ' AND invoice_date >= ?'; args.push(from); }
    if (Core.isDate(to)) { sql += ' AND invoice_date <= ?'; args.push(to); }
    if (onlyNew) sql += ' AND exported_at IS NULL';
    return prepare(`${sql} ORDER BY invoice_date, number LIMIT ${EXPORT_LIMIT}`).all(...args).map((row) => ({ ...toInvoice(row), data: JSON.parse(row.data) }));
  }

  /**
   * Markeert facturen als geëxporteerd.
   * @param {string} tenantId Id van de tenant.
   * @param {string[]} ids Id's van de facturen.
   * @returns {number} Aantal gemarkeerde facturen.
   */
  function markExported(tenantId, ids) {
    const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, EXPORT_LIMIT);
    if (!uniqueIds.length) return 0;
    const timestamp = currentTimestamp();
    let marked = 0;
    for (let i = 0; i < uniqueIds.length; i += 500) {
      const part = uniqueIds.slice(i, i + 500);
      marked += Number(prepare(`UPDATE invoices SET exported_at = ? WHERE tenant_id = ? AND status <> 'concept' AND id IN (${marks(part.length)})`).run(timestamp, tenantId, ...part).changes || 0);
    }
    return marked;
  }

  /**
   * Legt vast dat een factuur per e-mail is verstuurd, of waarom dat mislukte.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de factuur.
   * @param {string} to De ontvangers.
   * @param {string} [error] De foutmelding; leeg = gelukt.
   */
  function markSent(tenantId, id, to, error = '') {
    if (error) prepare('UPDATE invoices SET send_error = ? WHERE tenant_id = ? AND id = ?').run(String(error).slice(0, 300), tenantId, String(id));
    else prepare("UPDATE invoices SET sent_at = ?, sent_to = ?, send_error = '' WHERE tenant_id = ? AND id = ?").run(currentTimestamp(), String(to).slice(0, 400), tenantId, String(id));
  }

  /**
   * Een werkorder als bron voor een factuur (alleen binnen de eigen omgeving);
   * bij een werkorder uit een melding de klant van de melding.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de werkorder.
   * @returns {object|null} id, number, quoteId, data en customerId, of null.
   */
  function workOrder(tenantId, id) {
    const row = prepare('SELECT id, number, quote_id, data FROM work_orders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, String(id));
    if (!row) return null;
    // Werkorder uit een melding: de klant van de melding.
    const serviceRequest = prepare('SELECT customer_id FROM service_requests WHERE tenant_id = ? AND work_order_id = ?').get(tenantId, row.id);
    return { id: row.id, number: row.number, quoteId: row.quote_id || null, data: JSON.parse(row.data), customerId: (serviceRequest && serviceRequest.customer_id) || null };
  }
  /**
   * Een offerte als bron voor een factuur.
   * @param {string} tenantId Id van de tenant.
   * @param {string} id Id van de offerte.
   * @returns {object|null} id, number, status, customerId en data, of null.
   */
  function quote(tenantId, id) {
    const row = prepare("SELECT id, number, status, customer_id, data FROM quotes WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL").get(tenantId, String(id));
    return row ? { id: row.id, number: row.number, status: row.status, customerId: row.customer_id || null, data: JSON.parse(row.data) } : null;
  }

  return { list, get, create, update, finalize, onFinalized, setPaid, credit, remove, exportList, markExported, nextNumber, workOrder, quote, byShopOrders, markSent };
}

/**
 * Registreert de API-routes voor facturen (recht facturen).
 * @param {object} app De Express-app.
 * @param {object} ctx invoices, requireRight, requireJson, audit, settingsOf(req), loggedOf(tid, woId), articlesOf(tid), catalog(), sender (invoice-mail.js), shopOrders (shop-orders.js), mailConfigured(req), shopOf(req) en syncLimiter.
 */
function registerInvoiceRoutes(app, ctx) {
  const { invoices, requireRight, requireJson, audit, settingsOf, sender, shopOrders } = ctx;
  const syncLimiter = ctx.syncLimiter || ((req, res, next) => next());
  /**
   * Of de voorraad van een webshopfactuur al is afgeboekt doordat de voorraad naar de webshop gaat (shop-sync.js).
   * @param {object} req Het Express-verzoek.
   * @returns {boolean} True als de webshopvoorraad wordt bijgewerkt.
   */
  const shopStockSynced = (req) => {
    const shop = ctx.shopOf ? ctx.shopOf(req) : {};
    return Boolean(shop.push && shop.pushStock !== false && shop.mode === 'rest');
  };
  const requireInvoices = requireRight('facturen');
  /**
   * De actieve omgeving van het verzoek.
   * @param {object} req Het Express-verzoek.
   * @returns {string} Id van de tenant.
   */
  const tenantOf = (req) => req.tenantId || req.user.tenant_id;
  /**
   * De gecontroleerde factuurinstellingen van de omgeving.
   * @param {object} req Het Express-verzoek.
   * @returns {object} Instelling invoicing, opgeschoond.
   */
  const invoicingOf = (req) => Core.sanitizeSettings(settingsOf(req).get('invoicing'));
  /**
   * Stuurt het antwoord 404 "factuur niet gevonden".
   * @param {object} res Het Express-antwoord.
   * @returns {object} Het antwoord.
   */
  const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'Factuur niet gevonden.' });
  /**
   * Stuurt een foutmelding uit de opslag (409 bij een conflict, anders 400).
   * @param {object} res Het Express-antwoord.
   * @param {{ status?: number, error: string, field?: string }} out De fout.
   * @returns {object} Het antwoord.
   */
  const fail = (res, out) => res.status(out.status || 400).json({ error: out.status === 409 ? 'conflict' : 'invalid', message: out.error, field: out.field });
  /**
   * Of de inhoud van een factuur een object is.
   * @param {*} data De inhoud uit het verzoek.
   * @returns {boolean} True bij een gewoon object.
   */
  const validData = (data) => data && typeof data === 'object' && !Array.isArray(data);

  app.get('/api/invoices', requireInvoices, (req, res) => {
    res.json({ items: invoices.list(tenantOf(req), { status: String(req.query.status || ''), from: String(req.query.from || ''), to: String(req.query.to || ''), workOrderId: String(req.query.workOrderId || '') }) });
  });

  // Instellingen en artikelen vóór /:id.
  app.get('/api/invoices/settings', requireInvoices, (req, res) => {
    // Zonder interne velden (kostprijs per uur): facturen hebben die niet nodig.
    const profile = withoutInternal(settingsOf(req).get('quoteProfile'));
    const shop = ctx.shopOf ? ctx.shopOf(req) : {};
    res.json({
      settings: invoicingOf(req), profile: profile, groups: Core.GROUPS, rates: Core.VAT_RATES, shopStatuses: Core.SHOP_STATUSES,
      mail: ctx.mailConfigured ? ctx.mailConfigured(req) : false,
      shop: { url: shop.url || '', rest: shop.mode === 'rest', stockSynced: shopStockSynced(req), orders: shopOrders ? shopOrders.status(tenantOf(req)) : null },
    });
  });

  app.put('/api/invoices/settings', requireJson, requireInvoices, (req, res) => {
    const value = Core.sanitizeSettings(req.body);
    // Bestellingen ophalen aangezet zonder datum: vanaf vandaag (oudere zijn al gefactureerd).
    if (value.shopOrders.enabled && !value.shopOrders.since) value.shopOrders.since = Core.today();
    try {
      settingsOf(req).update({ invoicing: value }, req.user.id);
    } catch (error) {
      return res.status(400).json({ error: 'invalid_setting', field: error.field, message: error.message });
    }
    audit(req, 'instellingen_gewijzigd', { fields: ['invoicing'] });
    res.json({ settings: invoicingOf(req) });
  });

  app.get('/api/invoices/articles', requireInvoices, (req, res) => {
    res.json({ articles: ctx.articlesOf(tenantOf(req)) });
  });

  app.get('/api/invoices/export', requireInvoices, (req, res) => {
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if ((from && !Core.isDate(from)) || (to && !Core.isDate(to))) return res.status(400).json({ error: 'invalid_date', message: 'Ongeldige datum.' });
    const items = invoices.exportList(tenantOf(req), { from, to, onlyNew: req.query.new === '1' });
    res.json({ items, settings: invoicingOf(req), limit: EXPORT_LIMIT });
  });

  app.post('/api/invoices/export/mark', requireJson, requireInvoices, (req, res) => {
    const marked = invoices.markExported(tenantOf(req), req.body && req.body.ids);
    if (marked) audit(req, 'facturen_geexporteerd', { count: marked });
    res.json({ marked: marked });
  });

  // Webshopbestellingen nu ophalen (anders elke 10 minuten vanzelf).
  app.post('/api/invoices/shop-orders/sync', requireJson, requireInvoices, syncLimiter, wrapAsync(async (req, res) => {
    if (!shopOrders) return res.status(404).json({ error: 'not_found', message: 'Niet beschikbaar.' });
    try {
      const out = await shopOrders.run(tenantOf(req), { user: req.user });
      if (out.skipped === 'disabled') return res.status(409).json({ error: 'disabled', message: 'Zet eerst het ophalen van webshopbestellingen aan (Instellingen).' });
      if (out.skipped === 'not_configured') return res.status(409).json({ error: 'not_configured', message: 'Er is geen webshop gekoppeld (Beheer → Webshop).' });
      if (out.imported) audit(req, 'webshopbestellingen_gefactureerd', { count: out.imported });
      res.json({ ...out, status: shopOrders.status(tenantOf(req)) });
    } catch (error) {
      if (error instanceof SourceError) return res.status(error.status || 502).json({ error: error.code, message: error.message });
      throw error;
    }
  }));

  app.get('/api/invoices/:id', requireInvoices, (req, res) => {
    const invoice = invoices.get(tenantOf(req), req.params.id);
    if (!invoice) return notFound(res);
    res.json(invoice);
  });

  // Nieuw: { workOrderId } (uit de werkorder; force = ook als er al een is) of { data }.
  app.post('/api/invoices', requireJson, requireInvoices, (req, res) => {
    const body = req.body || {};
    const tenantId = tenantOf(req);
    const settings = invoicingOf(req);
    if (body.workOrderId) {
      const workOrder = invoices.workOrder(tenantId, String(body.workOrderId));
      if (!workOrder) return res.status(404).json({ error: 'not_found', message: 'Werkorder niet gevonden.' });
      const existing = invoices.list(tenantId, { workOrderId: workOrder.id }).filter((candidate) => candidate.kind === 'factuur');
      if (existing.length && !body.force) {
        return res.status(409).json({ error: 'exists', message: `Voor deze werkorder bestaat al factuur ${existing[0].number || '(concept)'}.`, invoiceId: existing[0].id });
      }
      const quote = workOrder.quoteId ? invoices.quote(tenantId, workOrder.quoteId) : null;
      const built = Core.fromWorkOrder(workOrder, {
        quote, logged: ctx.loggedOf(tenantId, workOrder.id), articles: ctx.articlesOf(tenantId), catalog: ctx.catalog(),
        hourlyRate: settingsOf(req).get('quoteProfile').hourlyRate, settings,
      });
      const created = invoices.create(tenantId, req.user, built.data, settings, { workOrderId: workOrder.id, quoteId: quote ? quote.id : null, customerId: (quote && quote.customerId) || workOrder.customerId || null });
      audit(req, 'factuur_aangemaakt', { invoiceId: created.id, workOrderId: workOrder.id });
      return res.status(201).json({ ...created, warnings: built.warnings });
    }
    if (body.data !== undefined && !validData(body.data)) return res.status(400).json({ error: 'invalid_invoice', message: 'Ongeldige factuur.' });
    const invoice = invoices.create(tenantId, req.user, body.data || {}, settings);
    audit(req, 'factuur_aangemaakt', { invoiceId: invoice.id });
    res.status(201).json(invoice);
  });

  app.put('/api/invoices/:id', requireJson, requireInvoices, (req, res) => {
    if (!validData(req.body && req.body.data)) return res.status(400).json({ error: 'invalid_invoice', message: 'Ongeldige factuur.' });
    const out = invoices.update(tenantOf(req), req.params.id, req.body.data, invoicingOf(req));
    if (!out) return notFound(res);
    if (out.locked) return res.status(409).json({ error: 'locked', message: 'Een definitieve factuur kan niet meer veranderen; maak een creditfactuur.' });
    res.json(out);
  });

  app.post('/api/invoices/:id/finalize', requireJson, requireInvoices, wrapAsync(async (req, res) => {
    const out = invoices.finalize(tenantOf(req), req.user, req.params.id, invoicingOf(req), { skipStock: shopStockSynced(req) });
    if (!out) return notFound(res);
    if (out.error) return fail(res, out);
    audit(req, 'factuur_definitief', { invoiceId: out.invoice.id, number: out.invoice.number, total: out.invoice.total });
    // Automatisch versturen (instelling); mislukt dat, dan staat dat op de factuur.
    const mail = sender ? await sender.autoSend(tenantOf(req), out.invoice.id) : { sent: false };
    if (mail.sent) audit(req, 'factuur_verstuurd', { invoiceId: out.invoice.id, number: out.invoice.number, auto: true });
    res.json({ ...invoices.get(tenantOf(req), out.invoice.id), autoSent: mail.sent });
  }));

  // De factuur als PDF (dezelfde als de bijlage van de e-mail).
  app.get('/api/invoices/:id/pdf', requireInvoices, (req, res) => {
    const invoice = invoices.get(tenantOf(req), req.params.id);
    if (!invoice || !sender) return notFound(res);
    const pdf = sender.pdfOf(tenantOf(req), invoice);
    const name = invoiceFileName(invoice);
    res.set({
      'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store',
      'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    res.send(pdf);
  });

  // Voorstel voor de e-mail (adres, onderwerp, tekst uit de instellingen).
  app.get('/api/invoices/:id/mail', requireInvoices, (req, res) => {
    const invoice = invoices.get(tenantOf(req), req.params.id);
    if (!invoice || !sender) return notFound(res);
    res.json({ ...sender.draft(tenantOf(req), invoice), configured: ctx.mailConfigured ? ctx.mailConfigured(req) : false });
  });

  // Versturen per e-mail met de PDF als bijlage.
  app.post('/api/invoices/:id/send', requireJson, requireInvoices, wrapAsync(async (req, res) => {
    if (!sender) return notFound(res);
    const body = req.body || {};
    const to = String(body.to || '').split(/[,;\s]+/).filter(Boolean);
    if (!to.length || to.length > 5 || !to.every(validEmail)) return res.status(400).json({ error: 'invalid_to', message: 'Vul een of meer geldige e-mailadressen in.' });
    try {
      const invoice = await sender.send(tenantOf(req), req.params.id, {
        to, subject: typeof body.subject === 'string' ? body.subject : '', message: typeof body.message === 'string' ? body.message : '', bcc: copyTo(req.user),
      });
      audit(req, 'factuur_verstuurd', { invoiceId: invoice.id, number: invoice.number, recipients: to.length });
      res.json(invoice);
    } catch (error) {
      if (error.code === 'not_found') return notFound(res);
      const status = { not_final: 409, not_configured: 409, invalid_to: 400, send_failed: 502 }[error.code];
      if (!status) throw error;
      res.status(status).json({ error: error.code, message: error.message });
    }
  }));

  app.post('/api/invoices/:id/paid', requireJson, requireInvoices, (req, res) => {
    const out = invoices.setPaid(tenantOf(req), req.params.id, req.body && req.body.paid !== false, req.body && req.body.date);
    if (!out) return notFound(res);
    if (out.error) return fail(res, out);
    res.json(out.invoice);
  });

  app.post('/api/invoices/:id/credit', requireJson, requireInvoices, (req, res) => {
    const out = invoices.credit(tenantOf(req), req.user, req.params.id, invoicingOf(req));
    if (!out) return notFound(res);
    if (out.error) return fail(res, out);
    if (!out.existing) audit(req, 'creditfactuur_aangemaakt', { invoiceId: out.invoice.id, creditOf: req.params.id });
    res.status(out.existing ? 200 : 201).json(out.invoice);
  });

  app.delete('/api/invoices/:id', requireInvoices, (req, res) => {
    const out = invoices.remove(tenantOf(req), req.params.id);
    if (!out) return notFound(res);
    if (out.error) return fail(res, out);
    audit(req, 'factuur_verwijderd', { invoiceId: req.params.id });
    res.json(out);
  });
}

module.exports = { createInvoiceStore, registerInvoiceRoutes, sanitizeInvoicing: Core.sanitizeSettings };
