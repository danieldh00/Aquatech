// Offerte omzetten naar bestelling (punt 7): een geaccordeerde offerte wordt een bestelling (web_orders, status nieuw) met de
// regels, prijzen, korting, btw-verlegging, betaaltermijn, documenttaal, klant en het afleveradres van de offerte. De offerte
// krijgt daarbij `order_id` (migratie 66); daarmee staat ze als Omgezet in de lijst en kan ze maar één keer worden omgezet.
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const { transaction, isPg } = require('../database/db');
const Roles = require(path.join(FRONTEND_DIR, 'shared', 'roles.js'));
const Core = require(path.join(FRONTEND_DIR, 'offertes', 'quote-core.js'));

/** Landnaam of -code in een adres van een offerte die niet Nederland is (derde regel). */
const COUNTRY_CODE = /^[A-Za-z]{2}$/;

/**
 * Zet het adres van een offerte (tekst met regels: straat, postcode en plaats, eventueel land) om naar een adres van een bestelling.
 * @param {string} text Het adres, regels gescheiden met een nieuwe regel.
 * @returns {{ street: string, postcode: string, city: string, country: string }} Het adres (leeg als er geen tekst is).
 */
function parseAddress(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { street: '', postcode: '', city: '', country: '' };
  const street = lines[0];
  const placeLine = lines[1] || '';
  const match = /^(\d{4}\s?[A-Za-z]{2})\s+(.+)$/.exec(placeLine);
  const postcode = match ? match[1].toUpperCase() : '';
  const city = match ? match[2].trim() : placeLine;
  const countryLine = lines[2] || '';
  const country = !countryLine ? 'NL' : COUNTRY_CODE.test(countryLine) ? countryLine.toUpperCase() : countryLine;
  return { street, postcode, city, country };
}

/**
 * Rekent een bedrag excl. btw om naar incl. btw voor een tarief.
 * @param {number} excl Het bedrag excl. btw.
 * @param {number} rate Het btw-tarief in procenten.
 * @returns {number} Het bedrag incl. btw, op centen.
 */
const inclOf = (excl, rate) => Core.round2(excl * (1 + rate / 100));

/**
 * De regels van de bestelling uit de meegetelde regels van de offerte, plus één kortingsregel per btw-tarief zodat het totaal
 * van de bestelling gelijk is aan dat van de offerte (Core.totals rekent de korting naar rato over de tarieven).
 * @param {object} data De offertegegevens.
 * @param {string} discountWord Het woord voor korting in de taal van het document.
 * @returns {object[]} De regels (code, name, unit, qty, unitExcl, vatRate, unitIncl, lineExcl, lineTotal).
 */
function orderLinesOf(data, discountWord) {
  const totals = Core.totals(data);
  const shifted = totals.shifted;
  const lines = data.lines.filter((line) => Core.included(line)).map((line) => {
    const vatRate = shifted ? 0 : Number(line.vat) || 0;
    const lineExcl = Core.lineTotal(line);
    return { code: line.code, name: line.description || line.code || '-', unit: line.unit, qty: line.qty, unitExcl: line.price, vatRate, unitIncl: inclOf(line.price, vatRate), lineExcl, lineTotal: inclOf(lineExcl, vatRate) };
  });
  // Per btw-tarief het verschil tussen de regels en de grondslag na korting: dat is de korting op dat tarief.
  const caption = Core.discountCaption(totals, discountWord, String(totals.discountPct));
  for (const entry of totals.vat) {
    const gross = Core.round2(lines.filter((line) => line.vatRate === entry.rate).reduce((sum, line) => sum + line.lineExcl, 0));
    const discount = Core.round2(entry.base - gross);
    if (!discount) continue;
    lines.push({ code: '', name: totals.vat.length > 1 ? `${caption} (${entry.rate}% btw)` : caption, unit: '', qty: 1, unitExcl: discount, vatRate: entry.rate, unitIncl: inclOf(discount, entry.rate), lineExcl: discount, lineTotal: inclOf(discount, entry.rate) });
  }
  return lines;
}

/**
 * De totalen van de bestelling: precies die van de offerte (Core.totals rekent de btw over het niet afgeronde bedrag na korting,
 * dus de regels van de bestelling kunnen een cent afwijken van de btw-opbouw; het totaal dat de klant accepteerde blijft leidend).
 * @param {object} data De offertegegevens.
 * @returns {{ total: number, byRate: { rate: number, excl: number, vat: number, incl: number }[] }} De totalen in het formaat van een bestelling.
 */
function orderTotalsOf(data) {
  const totals = Core.totals(data);
  return { total: totals.total, byRate: totals.vat.map((entry) => ({ rate: entry.rate, excl: entry.base, vat: entry.amount, incl: Core.round2(entry.base + entry.amount) })) };
}

/**
 * Maakt van de gegevens van de offerte de opdracht voor de bestelling (zie createFromQuote in web-orders.js).
 * Het interne notitieveld van de offerte en de notities per regel gaan nooit mee.
 * @param {{ id: string, number: string }} quoteRow De offerte.
 * @param {object} data De offertegegevens.
 * @param {?object} customer Het klantaccount (klantgroep), of null.
 * @param {string} by Wie de offerte omzet.
 * @returns {object} De opdracht.
 */
function specOf(quoteRow, data, customer, by) {
  const language = data.language === 'en' ? 'en' : 'nl';
  const lines = orderLinesOf(data, language === 'en' ? 'Discount' : 'Korting');
  const billing = parseAddress(data.customer.address);
  const separate = data.delivery && data.delivery.same === false && String(data.delivery.address || '').trim();
  const contact = data.customer.contact.trim();
  const quoteTotals = Core.totals(data);
  const vat = data.vatShift && data.vatShift.on ? { number: data.vatShift.number, shifted: quoteTotals.shifted, ...(quoteTotals.shifted ? { vies: { status: data.vatShift.status, checkedAt: data.vatShift.checkedAt, requestId: data.vatShift.requestId, name: data.vatShift.name } } : {}) } : null;
  const customerGroup = vat || (customer && customer.customerGroup === 'zakelijk') ? 'zakelijk' : '';
  return {
    userId: quoteRow.customer_id || null,
    customer: contact ? { name: contact, company: data.customer.name, email: data.customer.email, phone: data.customer.phone } : { name: data.customer.name, company: '', email: data.customer.email, phone: data.customer.phone },
    address: separate ? parseAddress(data.delivery.address) : billing,
    billingAddress: separate ? billing : null,
    deliverySame: !separate,
    lines, totals: orderTotalsOf(data), customerGroup, vat, paymentDays: data.paymentDays === undefined ? null : data.paymentDays, language,
    quote: { id: quoteRow.id, number: quoteRow.number }, by,
  };
}

/**
 * Maakt de functies voor het omzetten van een offerte.
 * @param {object} db De database.
 * @param {{ orders: object }} deps De bestellingen (web-orders.js).
 * @returns {{ convert: Function, orderIdOf: Function }} convert(user, id, customer) en orderIdOf(tenantId, id).
 */
function createQuoteOrders(db, { orders }) {
  /**
   * Zet een geaccordeerde offerte om in een bestelling, in één transactie: de offerte wordt vergrendeld, gecontroleerd en pas
   * daarna gekoppeld, zodat twee gelijktijdige verzoeken nooit twee bestellingen geven.
   * @param {object} user De medewerker die omzet (tenant_id = omgeving van de offerte).
   * @param {string} id Id van de offerte.
   * @param {(customerId: string) => ?object} customerOf Zoekt het klantaccount bij een klant-id.
   * @returns {{ order?: object, shortages?: object[], error?: string, status?: number, message?: string }} De bestelling en eventuele voorraadtekorten, of een fout.
   */
  function convert(user, id, customerOf) {
    return transaction(db, () => {
      const quoteRow = db.prepare(`SELECT id, number, status, customer_id, data, order_id, deleted_at FROM quotes WHERE tenant_id = ? AND id = ?${isPg(db) ? ' FOR UPDATE' : ''}`).get(user.tenant_id, String(id));
      if (!quoteRow || quoteRow.deleted_at) return { error: 'not_found', status: 404, message: 'Offerte niet gevonden.' };
      if (quoteRow.order_id) return { error: 'already_converted', status: 409, message: 'Deze offerte is al omgezet naar een bestelling.' };
      if (quoteRow.status !== 'akkoord') return { error: 'not_accepted', status: 409, message: 'Alleen een geaccordeerde offerte kan worden omgezet naar een bestelling.' };
      const data = Core.sanitize(JSON.parse(quoteRow.data));
      if (!data.lines.some((line) => Core.included(line))) return { error: 'empty', status: 409, message: 'Deze offerte heeft geen regels om te bestellen.' };
      const customer = quoteRow.customer_id ? customerOf(quoteRow.customer_id) : null;
      const out = orders.createFromQuote(user.tenant_id, specOf(quoteRow, data, customer, user.display_name || user.displayName || ''));
      const timestamp = new Date().toISOString();
      const linked = db.prepare('UPDATE quotes SET order_id = ?, converted_at = ? WHERE tenant_id = ? AND id = ? AND order_id IS NULL').run(out.order.id, timestamp, user.tenant_id, quoteRow.id);
      if (!linked.changes) throw new Error('Offerte is intussen omgezet.');
      return { order: out.order, shortages: out.shortages, quote: { id: quoteRow.id, number: quoteRow.number } };
    });
  }

  return { convert };
}

/**
 * Registreert de route om een offerte om te zetten naar een bestelling (alleen beheerders met het recht offertes).
 * @param {object} app De Express-app.
 * @param {{ quoteOrders: object, requireRight: Function, audit: Function, customerOf: Function }} deps De functies uit createQuoteOrders, de rechtencontrole, het auditlog en de klantzoeker (req, id).
 * @returns {void}
 */
function registerQuoteOrderRoutes(app, { quoteOrders, requireRight, audit, customerOf }) {
  app.post('/api/quotes/:id/convert', requireRight('offertes'), (req, res) => {
    if (!Roles.can(req.user, 'beheer')) return res.status(403).json({ error: 'forbidden', message: 'Alleen een beheerder kan een offerte omzetten naar een bestelling.' });
    const out = quoteOrders.convert(req.user, req.params.id, (customerId) => customerOf(req, customerId));
    if (out.error) return res.status(out.status || 400).json({ error: out.error, message: out.message });
    audit(req, 'offerte_omgezet', { quoteId: out.quote.id, number: out.quote.number, order: out.order.number });
    res.status(201).json({ order: { id: out.order.id, number: out.order.number, status: out.order.status, total: out.order.total }, shortages: out.shortages });
  });
}

module.exports = { createQuoteOrders, registerQuoteOrderRoutes, parseAddress, orderLinesOf, orderTotalsOf };
