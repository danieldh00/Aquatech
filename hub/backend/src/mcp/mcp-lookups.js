// Leesfuncties voor de AI-koppeling (mcp-tools.js): de status van een document op nummer en de openstaande facturen.
// Alles alleen-lezen, per omgeving (tenant_id) en zonder grote kolommen in overzichten. Welke soort iemand mag opvragen,
// bepaalt mcp-tools.js met de rechten van de rol.
const { jsonField, isPg } = require('../database/db');

/** Hoeveel facturen per getoonde debiteur meekomen (de totalen telt de database altijd volledig). */
const INVOICES_PER_DEBTOR = 10;
/** Per debiteur groeperen: op klant, anders op debiteur, anders op naam (zoals een losse factuur zonder klant). */
const GROUP_KEY = "(CASE WHEN customer_id IS NOT NULL THEN 'k:' || customer_id WHEN debtor_id IS NOT NULL THEN 'd:' || debtor_id ELSE 'n:' || lower(customer_name) END)";
/** De soorten documenten die de AI op nummer kan opvragen. */
const DOCUMENT_KINDS = ['offerte', 'werkorder', 'factuur', 'bestelling'];

/**
 * Een getal als bedrag (twee decimalen).
 * @param {*} value De waarde uit de database.
 * @returns {number} Het bedrag.
 */
const amountOf = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Het aantal dagen dat een vervaldatum voorbij is (0 als hij nog niet verlopen is).
 * @param {string} dueDate Vervaldatum (JJJJ-MM-DD).
 * @param {string} today Vandaag (JJJJ-MM-DD).
 * @returns {number} De dagen te laat.
 */
function daysLate(dueDate, today) {
  if (!dueDate || dueDate >= today) return 0;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86400000);
}

/**
 * Een document-nummer uit de invoer: zoals gegeven en in hoofdletters (nummers als OF-2026-0001 staan in hoofdletters).
 * @param {*} value De invoer.
 * @returns {string[]} De kandidaten (leeg bij geen nummer).
 */
function numberCandidates(value) {
  const number = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  if (!number) return [];
  return [...new Set([number, number.toUpperCase()])];
}

/**
 * Maakt de leesfuncties.
 * @param {object} db De database.
 * @param {{ today?: Function }} [options] today() geeft de datum van vandaag (JJJJ-MM-DD; tests).
 * @returns {{ documentStatus: Function, openInvoices: Function, customerBalance: Function, workOrderByNumber: Function }} De functies.
 */
function createMcpLookups(db, { today = () => new Date().toISOString().slice(0, 10) } = {}) {
  /**
   * Bereidt een SQL-opdracht voor.
   * @param {string} sql De opdracht.
   * @returns {object} Het voorbereide statement.
   */
  const prepare = (sql) => db.prepare(sql);
  /**
   * Plaatshouders voor een lijst waarden.
   * @param {Array} values De waarden.
   * @returns {string} Bijvoorbeeld "?, ?".
   */
  const marks = (values) => values.map(() => '?').join(', ');

  /**
   * Een factuurrij zoals de AI hem ziet.
   * @param {object} row Rij met number, status, kind, customer_name, invoice_date, due_date, total en paid_at.
   * @param {string} day Vandaag.
   * @returns {object} De factuur.
   */
  const invoiceView = (row, day) => ({
    nummer: row.number || '', soort: row.kind === 'credit' ? 'creditnota' : 'factuur', klant: row.customer_name || '', datum: row.invoice_date, vervaldatum: row.due_date || null,
    bedragInclBtw: amountOf(row.total), dagenTeLaat: row.status === 'definitief' && row.kind === 'factuur' ? daysLate(row.due_date, day) : 0,
  });

  /**
   * De status van één document op nummer.
   * @param {string} tenantId De omgeving.
   * @param {string} kind offerte, werkorder, factuur of bestelling.
   * @param {string} number Het nummer.
   * @param {{ withWorkOrders?: boolean }} [options] Bij een offerte ook de werkorders (alleen als de gebruiker werkorders mag zien).
   * @returns {object|null} De status (id en de velden voor de AI), of null als hij er niet is.
   */
  function documentStatus(tenantId, kind, number, { withWorkOrders = false } = {}) {
    const candidates = numberCandidates(number);
    if (!candidates.length) return null;
    if (kind === 'offerte') {
      const row = prepare(`SELECT id, number, status, title, customer, total_excl, total_incl, sent_at, viewed_at, responded_at, ${jsonField(db, 'data', 'validUntil')} AS valid_until
        FROM quotes WHERE tenant_id = ? AND number IN (${marks(candidates)}) AND deleted_at IS NULL`).get(tenantId, ...candidates);
      if (!row) return null;
      const workOrders = withWorkOrders
        ? prepare(`SELECT number, status FROM work_orders WHERE tenant_id = ? AND quote_id = ? AND deleted_at IS NULL ORDER BY created_at, id LIMIT 5`).all(tenantId, row.id) : null;
      return { id: row.id, nummer: row.number, status: row.status, titel: row.title, klant: row.customer, totaalExclBtw: amountOf(row.total_excl), totaalInclBtw: amountOf(row.total_incl),
        geldigTot: row.valid_until || null, verstuurdOp: row.sent_at || null, bekekenOp: row.viewed_at || null, gereageerdOp: row.responded_at || null,
        ...(workOrders ? { werkorders: workOrders.map((order) => ({ nummer: order.number, status: order.status })) } : {}) };
    }
    if (kind === 'werkorder') {
      const row = prepare(`SELECT id, number, status, title, customer, planned_date FROM work_orders
        WHERE tenant_id = ? AND number IN (${marks(candidates)}) AND deleted_at IS NULL`).get(tenantId, ...candidates);
      if (!row) return null;
      return { id: row.id, nummer: row.number, status: row.status, titel: row.title, klant: row.customer, geplandOp: row.planned_date || null };
    }
    if (kind === 'factuur') {
      const row = prepare(`SELECT id, number, status, kind, customer_name, invoice_date, due_date, total, paid_at FROM invoices
        WHERE tenant_id = ? AND number IN (${marks(candidates)})`).get(tenantId, ...candidates);
      if (!row) return null;
      return { id: row.id, ...invoiceView(row, today()), status: row.status, betaaldOp: row.paid_at || null };
    }
    if (kind === 'bestelling') {
      const row = prepare(`SELECT id, number, status, customer_name, total, created_at, ${jsonField(db, 'data', 'payment')} AS payment,
          ${isPg(db) ? "((data)::jsonb -> 'pay' ->> 'status')" : "json_extract(data, '$.pay.status')"} AS pay_status
        FROM web_orders WHERE tenant_id = ? AND number IN (${marks(candidates)})`).get(tenantId, ...candidates);
      if (!row) return null;
      return { id: row.id, nummer: row.number, status: row.status, klant: row.customer_name, totaalInclBtw: amountOf(row.total), besteldOp: row.created_at,
        betaling: row.payment || 'op rekening', ...(row.pay_status ? { betaalstatus: row.pay_status } : {}) };
    }
    return null;
  }

  /**
   * Een werkorder op nummer (om er uren of materiaal op te boeken).
   * @param {string} tenantId De omgeving.
   * @param {string} number Het nummer (bijv. WO-2026-0003).
   * @returns {{ id: string, number: string, status: string, title: string, customer: string }|null} De werkorder, of null.
   */
  function workOrderByNumber(tenantId, number) {
    const candidates = numberCandidates(number);
    if (!candidates.length) return null;
    const row = prepare(`SELECT id, number, status, title, customer FROM work_orders
      WHERE tenant_id = ? AND number IN (${marks(candidates)}) AND deleted_at IS NULL`).get(tenantId, ...candidates);
    return row ? { id: row.id, number: row.number, status: row.status, title: row.title || '', customer: row.customer || '' } : null;
  }

  /**
   * De openstaande facturen (definitief, nog niet betaald) van een omgeving per debiteur, grootste bedrag eerst. De database
   * telt per debiteur op (alle facturen tellen mee); alleen van de getoonde debiteuren komen de facturen zelf mee.
   * @param {string} tenantId De omgeving.
   * @param {{ onlyLate?: boolean, limit?: number }} [options] Alleen debiteuren met een factuur over de vervaldatum; hoeveel debiteuren.
   * @returns {{ debiteuren: object[], aantalGetoond: number, aantalGevonden: number, aantalDebiteuren: number, aantalTeLaat: number, totaalOpenstaand: number, totaalTeLaat: number }} Het overzicht: de getoonde debiteuren (met hoogstens tien facturen), hoeveel er aan het filter voldoen, en de aantallen en totalen over alle debiteuren.
   */
  function openInvoices(tenantId, { onlyLate = false, limit = 20 } = {}) {
    const day = today();
    const all = prepare(`SELECT ${GROUP_KEY} AS group_key, MAX(customer_id) AS customer_id, MAX(customer_name) AS customer_name, COUNT(*) AS invoice_count,
        SUM(total) AS open_total, SUM(CASE WHEN kind = 'factuur' AND due_date < ? THEN total ELSE 0 END) AS late_total,
        MIN(CASE WHEN kind = 'factuur' THEN due_date END) AS oldest_due
      FROM invoices WHERE tenant_id = ? AND status = 'definitief' GROUP BY ${GROUP_KEY}`).all(day, tenantId)
      .map((row) => ({ key: row.group_key, naam: row.customer_name || '', klantId: row.customer_id || null, openstaand: amountOf(row.open_total), teLaat: amountOf(row.late_total),
        aantalFacturen: Number(row.invoice_count) || 0, oudsteVervaldatum: row.oldest_due || null }))
      .filter((group) => Math.abs(group.openstaand) >= 0.005);
    const late = all.filter((group) => group.teLaat > 0);
    const groups = onlyLate ? late : all;
    groups.sort((left, right) => right.openstaand - left.openstaand || left.naam.localeCompare(right.naam));
    const shown = groups.slice(0, limit);
    const invoicesByGroup = new Map(shown.map((group) => [group.key, []]));
    if (shown.length) {
      // Per debiteur de tien oudste facturen, in één query (ROW_NUMBER werkt in SQLite en PostgreSQL).
      const keys = shown.map((group) => group.key);
      const rows = prepare(`SELECT group_key, number, status, kind, customer_name, invoice_date, due_date, total FROM (
          SELECT ${GROUP_KEY} AS group_key, number, status, kind, customer_name, invoice_date, due_date, total,
            ROW_NUMBER() OVER (PARTITION BY ${GROUP_KEY} ORDER BY invoice_date, id) AS position
          FROM invoices WHERE tenant_id = ? AND status = 'definitief' AND ${GROUP_KEY} IN (${marks(keys)})) ranked
        WHERE position <= ${INVOICES_PER_DEBTOR} ORDER BY group_key, position`).all(tenantId, ...keys);
      for (const row of rows) {
        const list = invoicesByGroup.get(row.group_key);
        if (list) list.push(invoiceView(row, day));
      }
    }
    return {
      debiteuren: shown.map(({ key, ...group }) => ({ ...group, facturen: invoicesByGroup.get(key), facturenGetoond: invoicesByGroup.get(key).length })),
      aantalGetoond: shown.length, aantalGevonden: groups.length,
      // De totalen gelden altijd voor alle debiteuren, ook met alleenTeLaat.
      aantalDebiteuren: all.length, aantalTeLaat: late.length,
      totaalOpenstaand: amountOf(all.reduce((sum, group) => sum + group.openstaand, 0)), totaalTeLaat: amountOf(all.reduce((sum, group) => sum + group.teLaat, 0)),
    };
  }

  /**
   * Alle definitieve, onbetaalde facturen en creditnota's als losse regels (voor het Excel-rapport), op klant en datum.
   * @param {string} tenantId De omgeving.
   * @param {number} [limit] Hoeveel regels hoogstens.
   * @returns {object[]} De facturen zoals de AI ze ziet (invoiceView).
   */
  function openInvoiceRows(tenantId, limit = 5000) {
    const day = today();
    return prepare(`SELECT number, status, kind, customer_name, invoice_date, due_date, total FROM invoices
      WHERE tenant_id = ? AND status = 'definitief' ORDER BY customer_name, invoice_date, id LIMIT ?`).all(tenantId, limit).map((row) => invoiceView(row, day));
  }

  /**
   * Wat een klant nog moet betalen (definitieve, onbetaalde facturen in deze omgeving). De database telt alles op; de
   * tien oudste facturen komen mee als voorbeeld.
   * @param {string} tenantId De omgeving.
   * @param {string} customerId Id van de klant.
   * @returns {{ openstaand: number, teLaat: number, aantalFacturen: number, facturen: object[] }} Het saldo.
   */
  function customerBalance(tenantId, customerId) {
    const day = today();
    const sums = prepare(`SELECT COUNT(*) AS invoice_count, SUM(total) AS open_total, SUM(CASE WHEN kind = 'factuur' AND due_date < ? THEN total ELSE 0 END) AS late_total
      FROM invoices WHERE tenant_id = ? AND customer_id = ? AND status = 'definitief'`).get(day, tenantId, String(customerId));
    const rows = prepare(`SELECT number, status, kind, customer_name, invoice_date, due_date, total FROM invoices
      WHERE tenant_id = ? AND customer_id = ? AND status = 'definitief' ORDER BY invoice_date, id LIMIT 10`).all(tenantId, String(customerId));
    return {
      openstaand: amountOf(sums && sums.open_total), teLaat: amountOf(sums && sums.late_total),
      aantalFacturen: Number(sums && sums.invoice_count) || 0, facturen: rows.map((row) => invoiceView(row, day)),
    };
  }

  return { documentStatus, openInvoices, openInvoiceRows, customerBalance, workOrderByNumber };
}

module.exports = { createMcpLookups, DOCUMENT_KINDS, daysLate, numberCandidates };
