// Leesfuncties voor de AI-koppeling (mcp-tools.js): de status van een document op nummer en de openstaande facturen.
// Alles alleen-lezen, per omgeving (tenant_id) en zonder grote kolommen in overzichten. Welke soort iemand mag opvragen,
// bepaalt mcp-tools.js met de rechten van de rol.
const { jsonField, isPg } = require('../database/db');

/** Hoeveel openstaande facturen hoogstens worden opgehaald (de rest telt niet mee; de AI krijgt dan een waarschuwing). */
const OPEN_INVOICE_LIMIT = 2000;
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
 * @returns {{ documentStatus: Function, openInvoices: Function, customerBalance: Function }} De functies.
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
   * @returns {object|null} De status (id en de velden voor de AI), of null als hij er niet is.
   */
  function documentStatus(tenantId, kind, number) {
    const candidates = numberCandidates(number);
    if (!candidates.length) return null;
    if (kind === 'offerte') {
      const row = prepare(`SELECT id, number, status, title, customer, total_excl, total_incl, sent_at, viewed_at, responded_at, ${jsonField(db, 'data', 'validUntil')} AS valid_until
        FROM quotes WHERE tenant_id = ? AND number IN (${marks(candidates)}) AND deleted_at IS NULL`).get(tenantId, ...candidates);
      if (!row) return null;
      const workOrders = prepare(`SELECT number, status FROM work_orders WHERE tenant_id = ? AND quote_id = ? AND deleted_at IS NULL ORDER BY created_at, id LIMIT 5`).all(tenantId, row.id);
      return { id: row.id, nummer: row.number, status: row.status, titel: row.title, klant: row.customer, totaalExclBtw: amountOf(row.total_excl), totaalInclBtw: amountOf(row.total_incl),
        geldigTot: row.valid_until || null, verstuurdOp: row.sent_at || null, bekekenOp: row.viewed_at || null, gereageerdOp: row.responded_at || null,
        werkorders: workOrders.map((order) => ({ nummer: order.number, status: order.status })) };
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
   * De openstaande facturen (definitief, nog niet betaald) van een omgeving per debiteur, grootste bedrag eerst.
   * @param {string} tenantId De omgeving.
   * @param {{ onlyLate?: boolean, limit?: number }} [options] Alleen debiteuren met een factuur over de vervaldatum; hoeveel debiteuren.
   * @returns {{ debiteuren: object[], aantalDebiteuren: number, totaalOpenstaand: number, totaalTeLaat: number, onvolledig: boolean }} Het overzicht.
   */
  function openInvoices(tenantId, { onlyLate = false, limit = 20 } = {}) {
    const day = today();
    const rows = prepare(`SELECT number, status, kind, customer_id, debtor_id, customer_name, invoice_date, due_date, total FROM invoices
      WHERE tenant_id = ? AND status = 'definitief' ORDER BY invoice_date, id LIMIT ${OPEN_INVOICE_LIMIT + 1}`).all(tenantId);
    const incomplete = rows.length > OPEN_INVOICE_LIMIT;
    const groups = new Map();
    for (const row of rows.slice(0, OPEN_INVOICE_LIMIT)) {
      const key = row.customer_id ? `k:${row.customer_id}` : row.debtor_id ? `d:${row.debtor_id}` : `n:${String(row.customer_name || '').toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, { naam: row.customer_name || '', klantId: row.customer_id || null, openstaand: 0, teLaat: 0, aantalFacturen: 0, oudsteVervaldatum: null, facturen: [] });
      const group = groups.get(key);
      const view = invoiceView(row, day);
      group.openstaand = amountOf(group.openstaand + view.bedragInclBtw);
      if (view.dagenTeLaat > 0) group.teLaat = amountOf(group.teLaat + view.bedragInclBtw);
      group.aantalFacturen += 1;
      if (row.kind === 'factuur' && row.due_date && (!group.oudsteVervaldatum || row.due_date < group.oudsteVervaldatum)) group.oudsteVervaldatum = row.due_date;
      if (group.facturen.length < 10) group.facturen.push(view);
    }
    const all = [...groups.values()].filter((group) => Math.abs(group.openstaand) >= 0.005 && (!onlyLate || group.teLaat > 0));
    all.sort((left, right) => right.openstaand - left.openstaand || left.naam.localeCompare(right.naam));
    return {
      debiteuren: all.slice(0, limit), aantalDebiteuren: all.length,
      totaalOpenstaand: amountOf(all.reduce((sum, group) => sum + group.openstaand, 0)), totaalTeLaat: amountOf(all.reduce((sum, group) => sum + group.teLaat, 0)), onvolledig: incomplete,
    };
  }

  /**
   * Wat een klant nog moet betalen (definitieve, onbetaalde facturen in deze omgeving).
   * @param {string} tenantId De omgeving.
   * @param {string} customerId Id van de klant.
   * @returns {{ openstaand: number, teLaat: number, aantalFacturen: number, facturen: object[] }} Het saldo.
   */
  function customerBalance(tenantId, customerId) {
    const day = today();
    const rows = prepare(`SELECT number, status, kind, customer_name, invoice_date, due_date, total FROM invoices
      WHERE tenant_id = ? AND customer_id = ? AND status = 'definitief' ORDER BY invoice_date, id LIMIT 200`).all(tenantId, String(customerId));
    const views = rows.map((row) => invoiceView(row, day));
    return {
      openstaand: amountOf(views.reduce((sum, view) => sum + view.bedragInclBtw, 0)),
      teLaat: amountOf(views.filter((view) => view.dagenTeLaat > 0).reduce((sum, view) => sum + view.bedragInclBtw, 0)),
      aantalFacturen: views.length, facturen: views.slice(0, 10),
    };
  }

  return { documentStatus, openInvoices, customerBalance };
}

module.exports = { createMcpLookups, DOCUMENT_KINDS, daysLate, numberCandidates };
