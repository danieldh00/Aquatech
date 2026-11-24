// Prijslijst van de leverancier inlezen (V-30): een Excel-bestand met inkoopprijzen wordt gekoppeld aan de artikelen op het
// artikelnummer van de leverancier, de EAN of de eigen artikelcode, met eerst een controle (nieuw, wijzigt, ongewijzigd,
// niet gevonden, fout). De prijs van de leverancier komt bij de koppeling te staan; bij de voorkeursleverancier (of een artikel
// zonder leverancier) wordt het ook de inkoopprijs van het artikel, waarna de verkoopprijs via de prijsfactor vanzelf volgt.
// Een backup-leverancier verandert nooit de prijs van het artikel. Artikelen die niet in het assortiment staan worden overgeslagen.
const { normalizeCode } = require('./stock-helpers');
const { cellText, parseNumber, readTable, countStatuses } = require('../platform/excel-import');
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { clientKey } = require('../beveiliging/auth');

/** Hoeveel regels een prijslijst per keer hoogstens bevat. */
const MAX_LINES = 2000;

/** De velden van het prijslijstbestand. */
const FIELDS = [
  { key: 'supplierSku', label: 'Artikelnummer leverancier', aliases: ['artikelnummer', 'leveranciersnummer', 'bestelnummer', 'sku', 'artikelnr'], example: 'RB-4000', hint: 'Hiermee wordt het artikel herkend (eerste keuze).' },
  { key: 'ean', label: 'EAN', aliases: ['barcode', 'ean code'], example: '', hint: 'Tweede keuze om het artikel te herkennen.' },
  { key: 'code', label: 'Artikelcode', aliases: ['eigen artikelcode', 'eigen code'], example: '', hint: 'Derde keuze: de code in je eigen artikelbestand.' },
  { key: 'costPrice', label: 'Inkoopprijs', aliases: ['prijs', 'nettoprijs', 'netto prijs', 'netto inkoopprijs', 'prijs excl btw'], required: true, example: '4,50', hint: 'Excl. btw, per eenheid (verplicht).' },
  { key: 'orderQty', label: 'Bestelhoeveelheid', aliases: ['verpakkingseenheid', 'minimale afname', 'bestelmultiple'], example: '', hint: 'Bestellen in veelvouden van dit aantal; leeg = ongewijzigd.' },
  { key: 'leadDays', label: 'Levertijd (dagen)', aliases: ['levertijd'], example: '', hint: 'Heel aantal kalenderdagen; leeg = ongewijzigd.' },
  { key: 'name', label: 'Omschrijving', aliases: ['naam', 'artikelomschrijving'], example: 'Rain Bird 4000', hint: 'Alleen ter herkenning in de controle.' },
];

/**
 * Maakt de zoeklijsten van de artikelen: op EAN, op eigen code en op het artikelnummer van de leverancier.
 * @param {object[]} items Alle artikelen van de omgeving.
 * @param {Map<string, object>} links De koppelingen van deze leverancier, per artikel-id.
 * @returns {{ byCode: Map<string, object>, byEan: Map<string, object>, bySku: Map<string, object[]> }} De lijsten.
 */
function indexItems(items, links) {
  const byCode = new Map(items.map((item) => [item.code, item]));
  const byEan = new Map(items.filter((item) => item.ean).map((item) => [item.ean, item]));
  const byId = new Map(items.map((item) => [item.id, item]));
  const bySku = new Map();
  for (const [itemId, link] of links) {
    const item = byId.get(itemId);
    if (!item || !link.supplierSku) continue;
    const key = link.supplierSku.toLowerCase();
    bySku.set(key, [...(bySku.get(key) || []), item]);
  }
  return { byCode, byEan, bySku };
}

/**
 * Zoekt het artikel bij een regel: eerst het artikelnummer van de leverancier, dan de EAN, dan de eigen code.
 * @param {object} values De cellen van de regel.
 * @param {{ byCode: Map, byEan: Map, bySku: Map }} index De zoeklijsten.
 * @returns {{ item?: object, problem?: string }} Het artikel, of een probleem (leeg = niet gevonden).
 */
function findItem(values, index) {
  const found = [];
  const sku = cellText(values.supplierSku).toLowerCase();
  if (sku) {
    const matches = index.bySku.get(sku) || [];
    if (matches.length > 1) return { problem: 'Dit artikelnummer van de leverancier staat bij meerdere artikelen.' };
    if (matches[0]) found.push(matches[0]);
  }
  const ean = cellText(values.ean).replace(/\s/g, '').replace(/\.0$/, '');
  if (ean && index.byEan.get(ean)) found.push(index.byEan.get(ean));
  const code = normalizeCode(cellText(values.code));
  if (code && index.byCode.get(code)) found.push(index.byCode.get(code));
  if (new Set(found.map((item) => item.id)).size > 1) return { problem: 'Het artikelnummer, de EAN en de artikelcode wijzen naar verschillende artikelen.' };
  return { item: found[0] };
}

/**
 * Saneert de getallen van een regel.
 * @param {object} values De cellen.
 * @returns {{ price?: number, orderQty?: number|null, leadDays?: number|null, problems: string[] }} De waarden en problemen.
 */
function numbersOf(values) {
  const problems = [];
  const price = parseNumber(values.costPrice);
  if (price === undefined || price === null || price < 0 || price > 1000000) problems.push('Inkoopprijs ontbreekt of is geen geldig bedrag.');
  const orderQty = parseNumber(values.orderQty);
  if (orderQty === undefined || (orderQty !== null && !(orderQty > 0 && orderQty <= 1000000))) problems.push('Bestelhoeveelheid moet groter zijn dan 0.');
  const leadDays = parseNumber(values.leadDays);
  if (leadDays === undefined || (leadDays !== null && (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 365))) problems.push('Levertijd is een heel aantal dagen van 0 tot en met 365.');
  return { price: price === undefined || price === null ? undefined : Math.round(price * 10000) / 10000, orderQty, leadDays, problems };
}

/**
 * Controleert een prijslijst tegen de artikelen: per regel nieuw, wijzigt, ongewijzigd, niet gevonden of fout. Schrijft niets.
 * @param {{ stock: object, suppliers: object, tenantId: string, supplierId: string, body: object }} options De opslagen, omgeving, leverancier en het verzoek ({ headers, rows }).
 * @returns {{ error: string }|{ unknown: string[], results: object[], entriesByItem: Map, counts: object }} De controle of een melding.
 */
function planPriceList({ stock, suppliers, tenantId, supplierId, body }) {
  const table = readTable(body, FIELDS, { maxRows: MAX_LINES });
  if (table.error) return table;
  if (!['supplierSku', 'ean', 'code'].some((key) => table.columns[key] !== undefined)) return { error: 'Kolom ontbreekt: Artikelnummer leverancier, EAN of Artikelcode. Gebruik het voorbeeldbestand als begin.' };
  const context = suppliers.priceListContext(tenantId, supplierId);
  const items = stock.list(tenantId, { archived: true });
  const index = indexItems(items, context.links);
  const seenItems = new Set();
  const results = table.rows.map(({ line, values }) => {
    const name = cellText(values.name);
    const label = cellText(values.supplierSku) || cellText(values.ean) || cellText(values.code);
    const base = { line, code: label, name, problems: [], warnings: [], changes: [], plan: null };
    const numbers = numbersOf(values);
    if (numbers.problems.length) return { ...base, status: 'fout', problems: numbers.problems };
    const match = findItem(values, index);
    if (match.problem) return { ...base, status: 'fout', problems: [match.problem] };
    const item = match.item;
    if (!item) return { ...base, status: 'onbekend', warnings: ['Geen artikel gevonden; deze regel wordt overgeslagen.'] };
    const itemLabel = { code: `${item.code}`, name: item.name };
    if (item.archived) return { ...base, ...itemLabel, status: 'fout', problems: ['Dit artikel is gearchiveerd.'] };
    if (item.hasVariants) return { ...base, ...itemLabel, status: 'fout', problems: ['Een hoofdartikel heeft geen eigen prijs; gebruik het nummer of de EAN van de variant.'] };
    if (seenItems.has(item.id)) return { ...base, ...itemLabel, status: 'fout', problems: ['Dit artikel staat al eerder in de prijslijst.'] };
    seenItems.add(item.id);
    const link = context.links.get(item.id) || null;
    const changes = [];
    /**
     * Voegt een verschil toe.
     * @param {string} label Naam van het onderdeel.
     * @param {*} from Huidige waarde.
     * @param {*} to Nieuwe waarde.
     * @returns {void}
     */
    const change = (label, from, to) => changes.push({ label, from: from == null ? '' : String(from), to: to == null ? '' : String(to) });
    const warnings = [];
    if (!link) change('Koppeling met leverancier', '', context.linked.has(item.id) ? 'nieuw (backup)' : 'nieuw (voorkeur)');
    if (!link || link.costPrice !== numbers.price) change('Inkoopprijs leverancier', link ? link.costPrice : '', numbers.price);
    if (numbers.orderQty !== null && (!link || link.orderQty !== numbers.orderQty)) change('Bestelhoeveelheid', link ? link.orderQty : '', numbers.orderQty);
    if (numbers.leadDays !== null && (!link || link.leadDays !== numbers.leadDays)) change('Levertijd (dagen)', link ? link.leadDays : '', numbers.leadDays);
    const sku = cellText(values.supplierSku);
    if (sku && (!link || link.supplierSku !== sku)) change('Artikelnummer leverancier', link ? link.supplierSku : '', sku);
    const followsPrice = link ? link.preferred : !context.linked.has(item.id);
    if (followsPrice && (item.costPrice === null || Math.abs(item.costPrice - numbers.price) > 0.00005)) {
      change('Inkoopprijs artikel', item.costPrice, numbers.price);
      if (item.priceMode === 'factor') warnings.push('De verkoopprijs volgt hierna de prijsfactor.');
    } else if (!followsPrice) warnings.push('Backup-leverancier: de inkoopprijs van het artikel verandert niet.');
    const status = !link ? 'nieuw' : (changes.length ? 'wijzigt' : 'ongewijzigd');
    return { ...base, ...itemLabel, status, warnings, changes, plan: { item, link, followsPrice, price: numbers.price, orderQty: numbers.orderQty, leadDays: numbers.leadDays, sku } };
  });
  return { unknown: table.unknown, results, entriesByItem: context.entriesByItem, counts: { onbekend: 0, ...countStatuses(results) } };
}

/** Een fout bij het verwerken van één regel: draait de transactie van die regel terug. */
class LineError extends Error {}

/**
 * Verwerkt de nieuwe en gewijzigde regels van een gecontroleerde prijslijst. Elke regel is één transactie (koppeling en
 * inkoopprijs samen of niet); een mislukte regel komt in `failed` en de rest gaat door. De bestaande koppelingen komen
 * uit de controle (`entriesByItem`), dus er is geen query per regel om ze op te halen.
 * @param {{ stock: object, suppliers: object, tenantId: string, supplier: object, user: object, results: object[], entriesByItem: Map<string, object[]> }} options De opslagen, omgeving, leverancier, gebruiker, de uitkomst van planPriceList en de koppelingen per artikel.
 * @returns {{ created: number, updated: number, itemPrices: number, failed: { line: number, message: string }[] }} De aantallen.
 */
function applyPriceList({ stock, suppliers, tenantId, supplier, user, results, entriesByItem }) {
  let created = 0;
  let updated = 0;
  let itemPrices = 0;
  const failed = [];
  for (const result of results) {
    if (!['nieuw', 'wijzigt'].includes(result.status)) continue;
    const { item, link, followsPrice, price, orderQty, leadDays, sku } = result.plan;
    const entries = (entriesByItem.get(item.id) || []).map((entry) => ({ ...entry }));
    const entry = entries.find((candidate) => candidate.supplierId === supplier.id);
    if (entry) {
      entry.costPrice = price;
      if (orderQty !== null) entry.orderQty = orderQty;
      if (leadDays !== null) entry.leadDays = leadDays;
      if (sku) entry.supplierSku = sku;
    } else {
      entries.push({ supplierId: supplier.id, supplierSku: sku, costPrice: price, orderQty: orderQty === null ? 1 : orderQty, leadDays, stockStatus: '', preferred: !entries.length });
    }
    const itemChange = followsPrice && result.changes.some((change) => change.label === 'Inkoopprijs artikel');
    try {
      suppliers.atomically(() => {
        const saved = suppliers.setForItem(tenantId, item.id, entries, { nested: true });
        if (saved.error) throw new LineError(saved.error);
        if (!itemChange) return;
        const out = stock.addCostPrice(tenantId, user, item.id, { price, note: `Prijslijst ${supplier.name}` }, { nested: true });
        if (out.error) throw new LineError(`De inkoopprijs van het artikel kon niet worden bijgewerkt: ${out.error}`);
      });
    } catch (error) {
      if (!(error instanceof LineError)) throw error;
      failed.push({ line: result.line, message: error.message });
      continue;
    }
    if (link) updated += 1; else created += 1;
    if (itemChange) itemPrices += 1;
  }
  return { created, updated, itemPrices, failed };
}

/**
 * Maakt van de uitkomst van de controle het antwoord voor de browser (zonder de interne plannen).
 * @param {{ unknown: string[], results: object[], counts: object }} plan De controle.
 * @returns {object} { unknown, counts, rows }.
 */
function previewOf(plan) {
  return { unknown: plan.unknown, counts: plan.counts, rows: plan.results.map(({ line, status, code, name, problems, warnings, changes }) => ({ line, status, code, name, problems, warnings, changes })) };
}

/**
 * Registreert de routes van de prijslijstimport: de velden (voor het voorbeeldbestand) en de controle/verwerking per leverancier.
 * @param {object} app De Express-app.
 * @param {{ stock: object, suppliers: object, requireRight: Function, requireJson: Function, audit: Function }} ctx De afhankelijkheden van registerStockRoutes.
 * @returns {void}
 */
function registerPriceListRoutes(app, ctx) {
  const { stock, suppliers, requireRight, requireJson, audit } = ctx;
  const requireStock = requireRight('voorraad');
  const perUser = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `prijslijst:${req.user?.id || clientKey(req)}` });

  app.get('/api/stock/price-lists/fields', requireStock, (req, res) => {
    res.json({ max: MAX_LINES, fields: FIELDS.map(({ key, label, required, example, hint }) => ({ key, label, required: Boolean(required), example, hint })) });
  });

  app.post('/api/stock/price-lists/:supplierId', requireJson, requireStock, perUser, (req, res, next) => {
    try {
      const body = req.body || {};
      const tenantId = req.tenantId || req.user.tenant_id;
      const supplier = suppliers.get(tenantId, req.params.supplierId);
      if (!supplier) return res.status(404).json({ error: 'not_found', message: 'Leverancier niet gevonden.' });
      if (supplier.archived) return res.status(409).json({ error: 'supplier_archived', message: 'Deze leverancier is gearchiveerd; zet hem eerst terug uit het archief.' });
      const plan = planPriceList({ stock, suppliers, tenantId, supplierId: supplier.id, body });
      if (plan.error) return res.status(400).json({ error: 'invalid_import', message: plan.error });
      if (body.apply !== true) return res.json(previewOf(plan));
      if (plan.counts.fout && body.skipErrors !== true) return res.status(409).json({ error: 'has_errors', message: 'De prijslijst bevat regels met fouten. Herstel ze, of verwerk alleen de goede regels.', ...previewOf(plan) });
      const done = applyPriceList({ stock, suppliers, tenantId, supplier, user: req.user, results: plan.results, entriesByItem: plan.entriesByItem });
      audit(req, 'leverancier_prijslijst_ingelezen', { leverancier: supplier.name, nieuw: done.created, gewijzigd: done.updated, artikelprijzen: done.itemPrices, onbekend: plan.counts.onbekend, overgeslagen: plan.counts.fout, mislukt: done.failed.length });
      return res.json({ ...done, skipped: plan.counts.fout + plan.counts.onbekend, unchanged: plan.counts.ongewijzigd });
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = { FIELDS, MAX_LINES, planPriceList, applyPriceList, registerPriceListRoutes };
