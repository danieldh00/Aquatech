// Artikelen importeren uit Excel (V-05): de velden van het bestand, de controle (wat is nieuw, wat wijzigt, wat klopt niet)
// en het verwerken. Een artikel wordt gevonden op de artikelcode. Een lege cel laat een bestaand artikel ongemoeid; de
// beginvoorraad geldt alleen voor nieuwe artikelen (voorraad wijzigen gaat via een boeking). Opslaan loopt via stock.create en
// stock.update, dus EAN-regels, inkoopprijshistorie en de prijsfactor werken zoals in het formulier.
const { sanitizeItem, normalizeCode, MAX_QTY, round3 } = require('./stock-helpers');
const { cellText, parseNumber, readTable, countStatuses } = require('../platform/excel-import');
const { createRateLimiter } = require('../beveiliging/rate-limit');
const { clientKey } = require('../beveiliging/auth');

/** Hoeveel artikelen een import hoogstens bevat. */
const MAX_ITEMS = 1000;

/** De velden van het artikelbestand: sleutel, kolomkop, synoniemen, soort (tekst of getal), voorbeeld en uitleg. */
const FIELDS = [
  { key: 'code', label: 'Artikelcode', aliases: ['code', 'artikelnummer', 'sku'], required: true, example: 'SPR-001', hint: 'Verplicht en uniek; hiermee wordt een bestaand artikel herkend.' },
  { key: 'name', label: 'Omschrijving', aliases: ['naam', 'artikelnaam', 'omschrijving artikel'], required: true, example: 'Sproeier 4 inch', hint: 'Verplicht.' },
  { key: 'unit', label: 'Eenheid', aliases: ['eenheid'], example: 'st', hint: 'Bijvoorbeeld st, m of rol (leeg = st).' },
  { key: 'location', label: 'Magazijnlocatie', aliases: ['locatie'], example: 'A-01', hint: '' },
  { key: 'minQty', label: 'Minimumvoorraad', aliases: ['minimum', 'min voorraad'], kind: 'number', example: '5', hint: '' },
  { key: 'reorderQty', label: 'Bestellen tot', aliases: ['bestelniveau'], kind: 'number', example: '20', hint: '' },
  { key: 'costPrice', label: 'Inkoopprijs', aliases: ['inkoop', 'kostprijs'], kind: 'number', example: '4,50', hint: 'Excl. btw. Een nieuwe prijs komt in de prijshistorie.' },
  { key: 'salePrice', label: 'Verkoopprijs', aliases: ['verkoop', 'prijs'], kind: 'number', example: '9,95', hint: 'Excl. btw.' },
  { key: 'businessPrice', label: 'Zakelijke prijs', aliases: ['prijs zakelijk'], kind: 'number', example: '', hint: 'Excl. btw; leeg = geen eigen zakelijke prijs.' },
  { key: 'vatRate', label: 'Btw', aliases: ['btw tarief', 'btw %'], kind: 'number', example: '21', hint: '21, 9 of 0 (leeg = 21 bij een nieuw artikel).' },
  { key: 'revenueGroup', label: 'Omzetgroep', aliases: ['omzetcategorie'], example: 'producten', hint: 'producten, arbeid of overig.' },
  { key: 'weightGrams', label: 'Gewicht (gram)', aliases: ['gewicht', 'gewicht gram'], kind: 'number', example: '120', hint: '' },
  { key: 'ean', label: 'EAN', aliases: ['barcode', 'ean code'], example: '', hint: '8 of 13 cijfers met kloppend controlecijfer.' },
  { key: 'priceMode', label: 'Prijsbepaling', aliases: ['prijsmodus'], example: 'vast', hint: 'vast of factor (verkoopprijs volgt de inkoopprijs × prijsfactor).' },
  { key: 'priceFactor', label: 'Prijsfactor', aliases: ['factor'], kind: 'number', example: '', hint: 'Eigen factor; leeg = volgens leverancier, categorie of standaard.' },
  { key: 'onHand', label: 'Beginvoorraad', aliases: ['voorraad', 'aantal op voorraad'], kind: 'number', example: '10', hint: 'Alleen voor nieuwe artikelen.' },
  { key: 'notes', label: 'Opmerking', aliases: ['notitie', 'opmerkingen'], example: '', hint: '' },
];

/** Veld → kolomkop, voor het overzicht van wijzigingen. */
const LABELS = Object.fromEntries(FIELDS.map((field) => [field.key, field.label]));
/** De velden die met een bestaand artikel worden vergeleken. */
const COMPARED = ['name', 'unit', 'location', 'minQty', 'reorderQty', 'costPrice', 'salePrice', 'businessPrice', 'vatRate', 'revenueGroup', 'weightGrams', 'ean', 'priceMode', 'priceFactor', 'notes'];

/**
 * Zet de cellen van één regel om naar het formaat van het artikelformulier; alleen gevulde cellen komen mee.
 * @param {object} values De ruwe cellen per veld.
 * @returns {{ raw: object, problems: string[] }} De invoer voor sanitizeItem en de problemen met getallen.
 */
function rawOf(values) {
  const raw = {};
  const problems = [];
  for (const field of FIELDS) {
    if (field.key === 'code' || !cellText(values[field.key])) continue;
    if (field.kind === 'number') {
      const number = parseNumber(values[field.key]);
      if (number === undefined) problems.push(`${field.label} is geen getal.`);
      else raw[field.key] = number;
    } else raw[field.key] = cellText(values[field.key]);
  }
  if (raw.revenueGroup) raw.revenueGroup = String(raw.revenueGroup).toLowerCase();
  if (raw.priceMode) raw.priceMode = String(raw.priceMode).toLowerCase();
  if (raw.ean !== undefined) raw.ean = String(raw.ean).replace(/\s/g, '').replace(/\.0$/, '');
  return { raw, problems };
}

/**
 * Vergelijkt de gevulde cellen met een bestaand artikel.
 * @param {object} fields De gesaneerde velden (uit sanitizeItem, alleen de meegegeven).
 * @param {object} existing Het bestaande artikel (zoals de API het geeft).
 * @returns {{ changes: object[], warnings: string[] }} De verschillen en opmerkingen.
 */
function diffItem(fields, existing) {
  const changes = [];
  const warnings = [];
  for (const key of COMPARED) {
    if (fields[key] === undefined) continue;
    if (key === 'salePrice' && existing.priceMode === 'factor' && (fields.priceMode === undefined || fields.priceMode === 'factor')) {
      if (Number(fields[key]) !== Number(existing[key])) warnings.push('De verkoopprijs volgt de prijsfactor van dit artikel en wordt niet overgenomen.');
      continue;
    }
    const next = fields[key] === null ? '' : String(fields[key]);
    const current = existing[key] === null || existing[key] === undefined ? '' : String(existing[key]);
    if (next !== current && !(Number(next) === Number(current) && next !== '' && current !== '')) changes.push({ field: key, label: LABELS[key] || key, from: current, to: next });
  }
  return { changes, warnings };
}

/**
 * Controleert een artikelbestand tegen de bestaande artikelen: per regel nieuw, wijzigt, ongewijzigd of fout. Schrijft niets.
 * @param {{ stock: object, tenantId: string, body: object }} options De voorraadopslag, de omgeving en het verzoek ({ headers, rows }).
 * @returns {{ error: string }|{ unknown: string[], results: object[], counts: object }} De controle of een melding.
 */
function planItemImport({ stock, tenantId, body }) {
  const table = readTable(body, FIELDS);
  if (table.error) return table;
  if (table.rows.length > MAX_ITEMS) return { error: `Hoogstens ${MAX_ITEMS} artikelen per keer.` };
  const items = stock.list(tenantId, { archived: true });
  const byCode = new Map(items.map((item) => [item.code, item]));
  const eanOwner = new Map(items.filter((item) => item.ean).map((item) => [item.ean, item.code]));
  const seenCodes = new Set();
  const seenEans = new Map();
  const results = table.rows.map(({ line, values }) => {
    const code = normalizeCode(cellText(values.code));
    const problems = [];
    const warnings = [];
    const existing = byCode.get(code) || null;
    const { raw, problems: numberProblems } = rawOf(values);
    problems.push(...numberProblems);
    if (!code) problems.push('Artikelcode ontbreekt.');
    else if (seenCodes.has(code)) problems.push('Deze artikelcode staat al eerder in het bestand.');
    seenCodes.add(code);
    let changes = [];
    if (!problems.length) {
      const checked = sanitizeItem({ ...raw, code }, { partial: Boolean(existing) });
      if (checked.error) problems.push(checked.error);
      else if (existing) {
        if (existing.archived) problems.push('Dit artikel is gearchiveerd; zet het eerst terug uit het archief.');
        else if (existing.hasVariants) problems.push('Een hoofdartikel met varianten wijzig je niet via de import; importeer de varianten zelf.');
        else {
          const diff = diffItem(checked.value, existing);
          changes = diff.changes;
          warnings.push(...diff.warnings);
          if (raw.onHand !== undefined) warnings.push('De beginvoorraad geldt alleen voor nieuwe artikelen; wijzig voorraad met een boeking.');
        }
      } else if (!cellText(values.name)) problems.push('Omschrijving ontbreekt.');
      else if (raw.onHand !== undefined && !(raw.onHand >= 0 && raw.onHand <= MAX_QTY)) problems.push('Ongeldige beginvoorraad.');
      const ean = checked.value && checked.value.ean;
      if (ean) {
        if (seenEans.has(ean)) problems.push(`Deze EAN staat al bij artikelcode ${seenEans.get(ean)} in het bestand.`);
        else if (eanOwner.has(ean) && eanOwner.get(ean) !== code) problems.push(`Deze EAN hoort al bij artikel ${eanOwner.get(ean)}.`);
        seenEans.set(ean, code);
      }
    }
    const status = problems.length ? 'fout' : (!existing ? 'nieuw' : (changes.length ? 'wijzigt' : 'ongewijzigd'));
    return { line, code, name: cellText(values.name) || (existing && existing.name) || '', status, problems, warnings, changes, plan: { existing, raw: { ...raw, code } } };
  });
  return { unknown: table.unknown, results, counts: countStatuses(results) };
}

/**
 * Verwerkt de nieuwe en gewijzigde regels van een gecontroleerd bestand.
 * @param {{ stock: object, tenantId: string, user: object, results: object[] }} options De voorraadopslag, omgeving, gebruiker en de uitkomst van planItemImport.
 * @returns {{ created: number, updated: number, failed: { line: number, code: string, message: string }[] }} De aantallen.
 */
function applyItemImport({ stock, tenantId, user, results }) {
  let created = 0;
  let updated = 0;
  const failed = [];
  for (const result of results) {
    if (!['nieuw', 'wijzigt'].includes(result.status)) continue;
    const { existing, raw } = result.plan;
    const out = existing
      ? stock.update(tenantId, existing.id, Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'onHand' && key !== 'code')), user)
      : stock.create(tenantId, user, { ...raw, onHand: raw.onHand === undefined ? 0 : round3(raw.onHand) });
    if (out.error) failed.push({ line: result.line, code: result.code, message: out.error });
    else if (existing) updated += 1;
    else created += 1;
  }
  return { created, updated, failed };
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
 * Registreert de routes van de artikelimport: de velden (voor het voorbeeldbestand) en de controle/verwerking.
 * @param {object} app De Express-app.
 * @param {{ stock: object, requireRight: Function, requireJson: Function, audit: Function }} ctx De afhankelijkheden van registerStockRoutes.
 * @returns {void}
 */
function registerItemImportRoutes(app, ctx) {
  const { stock, requireRight, requireJson, audit } = ctx;
  const requireStock = requireRight('voorraad');
  const perUser = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `artikelimport:${req.user?.id || clientKey(req)}` });

  app.get('/api/stock/import-excel/fields', requireStock, (req, res) => {
    res.json({ max: MAX_ITEMS, fields: FIELDS.map(({ key, label, required, example, hint }) => ({ key, label, required: Boolean(required), example, hint })) });
  });

  app.post('/api/stock/import-excel', requireJson, requireStock, perUser, (req, res, next) => {
    try {
      const body = req.body || {};
      const tenantId = req.tenantId || req.user.tenant_id;
      const plan = planItemImport({ stock, tenantId, body });
      if (plan.error) return res.status(400).json({ error: 'invalid_import', message: plan.error });
      if (body.apply !== true) return res.json(previewOf(plan));
      if (plan.counts.fout && body.skipErrors !== true) return res.status(409).json({ error: 'has_errors', message: 'Het bestand bevat regels met fouten. Herstel ze, of verwerk alleen de goede regels.', ...previewOf(plan) });
      const done = applyItemImport({ stock, tenantId, user: req.user, results: plan.results });
      audit(req, 'voorraad_artikelen_geimporteerd', { aangemaakt: done.created, gewijzigd: done.updated, overgeslagen: plan.counts.fout, mislukt: done.failed.length });
      return res.json({ ...done, skipped: plan.counts.fout, unchanged: plan.counts.ongewijzigd });
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = { FIELDS, MAX_ITEMS, planItemImport, applyItemImport, previewOf, registerItemImportRoutes };
