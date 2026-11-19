// Het overzicht in Beheer bij een artikel: welke levermethodes de webshop voor dit artikel toont, bij welke aantallen en met welke
// indicatieve levertijd (op voorraad en niet op voorraad). Alleen lezen; de regels en de eigen levertijd bewerk je in het artikelformulier.

const Shipping = require('./shipping');
const DeliveryRules = require('./delivery-rules');
const DeliveryTimes = require('./delivery-times');

/**
 * De korte tekst bij een levertijd.
 * @param {?{ min: number, max: number, dayType: string }} lead De levertijd (null = onbekend).
 * @returns {string} Bijvoorbeeld "1-2 dagen", "direct" of "op aanvraag".
 */
function leadShort(lead) {
  if (!lead) return 'op aanvraag';
  return lead.max === 0 ? 'direct' : DeliveryTimes.leadText(lead);
}

/**
 * Bij welke aantallen een methode voor dit artikel mag, in gewone taal.
 * @param {?object[]} rules De geldende regels van het artikel (null = geen beperking).
 * @param {string} method De methode (dpd, eigen of pallet).
 * @param {string} unit De eenheid van het artikel.
 * @param {(method: string) => string} labelOf De naam van een methode.
 * @returns {string} De tekst.
 */
function quantitiesText(rules, method, unit, labelOf) {
  if (!rules || !rules.length) return 'In elk aantal';
  const own = rules.filter((rule) => rule.method === method);
  if (own.length) return DeliveryRules.describeRules(own, () => '', unit);
  const heaviest = Math.max(...rules.map((rule) => DeliveryRules.RULE_METHODS.indexOf(rule.method)));
  return DeliveryRules.RULE_METHODS.indexOf(method) > heaviest ? 'In elk aantal (zwaarder dan de regels)' : `Niet toegestaan (zie ${labelOf(rules[0].method)})`;
}

/**
 * Bouwt het overzicht van een artikel.
 * @param {{ code: string, unit: string }} item Het artikel.
 * @param {{ shipping: object, rules: ?object[], rulesSource: string, info: ?object, today?: Date }} context De verzendinstelling, de geldende regels met hun herkomst en de levertijdgegevens (storefront-data.leadInfoOf).
 * @returns {{ rulesSource: string, methods: { method: string, label: string, quantities: string, leadInStock: string, leadOutOfStock: string }[] }} Het overzicht.
 */
function previewOf(item, { shipping, rules, rulesSource, info, today = new Date() }) {
  const given = info || { override: null, supplierLeadDays: null, expectedDate: '' };
  /**
   * De naam van een methode.
   * @param {string} method De methode.
   * @returns {string} De naam uit de verzendinstelling.
   */
  const labelOf = (method) => (shipping[method] ? shipping[method].label : method);
  const methods = [];
  for (const method of [...Shipping.CARRIERS, 'pickup']) {
    const config = shipping[method];
    if (!config || !config.enabled) continue;
    /**
     * De levertijd van dit artikel bij deze methode.
     * @param {boolean} inStock Of het artikel op voorraad is.
     * @returns {?object} De levertijd (null = onbekend).
     */
    const leadFor = (inStock) => DeliveryTimes.leadFor({ override: given.override, inStock, methodLead: config.leadDays, dayType: config.dayType, expectedDate: given.expectedDate, supplierLeadDays: given.supplierLeadDays, today });
    methods.push({
      method: method === 'pickup' ? 'ophalen' : method, label: config.label,
      quantities: method === 'pickup' ? 'In elk aantal' : quantitiesText(rules, method, item.unit, labelOf),
      leadInStock: leadShort(leadFor(true)), leadOutOfStock: leadShort(leadFor(false)),
    });
  }
  return { rulesSource, methods };
}

/**
 * Registreert de leesroute `GET /api/stock/items/:id/delivery-preview` (recht voorraad).
 * @param {object} app De Express-app.
 * @param {{ db: object, requireRight: Function, settingsFor: Function, deliveryRulesOf: Function, leadInfoOf: Function }} ctx De database, de rechtencontrole, settingsFor(tenantId), deliveryRulesOf(tenantId) (regels per categorie) en leadInfoOf(tenantId, codes) (storefront-data.js).
 * @returns {void}
 */
function registerDeliveryPreviewRoutes(app, { db, requireRight, settingsFor, deliveryRulesOf, leadInfoOf }) {
  app.get('/api/stock/items/:id/delivery-preview', requireRight('voorraad'), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const item = db.prepare('SELECT code, unit FROM stock_items WHERE tenant_id = ? AND id = ?').get(req.tenantId, String(req.params.id));
    if (!item) return res.status(404).json({ error: 'not_found', message: 'Artikel niet gevonden.' });
    const info = leadInfoOf(req.tenantId, [item.code], { fresh: true }).get(item.code) || null;
    const itemRules = info ? DeliveryRules.sanitizeRules(info.itemRules) : [];
    const parentRules = info ? DeliveryRules.sanitizeRules(info.parentRules) : [];
    const categoryRules = deliveryRulesOf(req.tenantId).get(item.code) || [];
    const rules = DeliveryRules.effectiveRules(itemRules, parentRules, categoryRules);
    const rulesSource = itemRules.length ? 'regels van dit artikel' : parentRules.length ? 'regels van het hoofdartikel' : categoryRules.length ? 'regels van de categorie' : 'geen beperkingen';
    const shipping = Shipping.sanitizeShipping(settingsFor(req.tenantId).get('shopShipping'));
    res.json(previewOf(item, { shipping, rules, rulesSource, info }));
  });
}

module.exports = { previewOf, registerDeliveryPreviewRoutes };
