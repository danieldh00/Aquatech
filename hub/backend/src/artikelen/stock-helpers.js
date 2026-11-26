// Gedeelde hulpfuncties en constanten van het artikelenbestand (stock.js): invoer saneren,
// kenmerken en subartikelen, codes normaliseren en de materiaalbehoefte van een werkorder.
// Letterlijk uit stock.js verplaatst; geen eigen toestand.
const Wholesale = require('../webshop/wholesale');
const ItemDetails = require('./item-details');
const path = require('path');
const { FRONTEND_DIR } = require('../paths');
const Barcode = require(path.join(FRONTEND_DIR, 'shared', 'barcode.js'));
const PriceFactor = require('./price-factor');
const DeliveryRules = require('../webshop/delivery-rules');
const DeliveryTimes = require('../webshop/delivery-times');

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
/** Hoogstens zoveel id's per IN (...) bij bulkwijzigingen (ruim onder de parameterlimiet). */
const BATCH = 500;

/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * Rondt een aantal af op drie decimalen (leeg of ongeldig = 0).
 * @param {*} value Het aantal.
 * @returns {number} Het afgeronde aantal.
 */
const round3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;
/**
 * Maakt een artikelcode vergelijkbaar: getrimd en in hoofdletters.
 * @param {*} value De code.
 * @returns {string} De genormaliseerde code.
 */
const normalizeCode = (value) => String(value ?? '').trim().toUpperCase();
/**
 * De voorraadcode van een webshopproduct: aquatech_code, anders de sku, anders
 * WC-<product-id> (zodat ook producten zonder sku mee kunnen).
 * @param {{ id: *, code?: string, sku?: string }} product Het webshopproduct.
 * @returns {string} De code in hoofdletters.
 */
const shopCodeOf = (product) => normalizeCode(product.code) || normalizeCode(product.sku) || `WC-${String(product.id).trim()}`;

/**
 * Maakt van een waarde nette tekst zonder stuurtekens, getrimd en ingekort.
 * @param {*} value De invoer.
 * @param {number} maxLength Maximaal aantal tekens.
 * @returns {string} De tekst.
 */
const cleanText = (value, maxLength) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
/**
 * Is de waarde een datum als JJJJ-MM-DD?
 * @param {*} value De invoer.
 * @returns {boolean} true als het een datum is.
 */
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
/**
 * Telt de aantallen van rijen op.
 * @param {{ qty: number }[]} rows De rijen.
 * @returns {number} Het totaal.
 */
const sumQty = (rows) => rows.reduce((sum, row) => sum + row.qty, 0);
/** Eenheden die een nieuwe omgeving meekrijgt. */
const DEFAULT_UNITS = ['st', 'm', 'm²', 'rol', 'set', 'zak', 'kg', 'l', 'uur'];
/** Hoogstens zoveel kenmerken per artikelgroep, waarden per kenmerk en subartikelen. */
const MAX_ATTRIBUTES = 3;
const MAX_VALUES = 30;
const MAX_SUB_ITEMS = 200;

/**
 * Leest JSON uit een tekstkolom.
 * @param {string} text De opgeslagen tekst.
 * @param {*} fallback Wat terugkomt bij lege of ongeldige tekst.
 * @returns {*} De gelezen waarde.
 */
function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/**
 * Schoont de kenmerken van een artikelgroep op: hooguit drie kenmerken met
 * een naam en een of meer unieke waarden.
 * @param {*} raw De invoer: [{ name, values }] (values als lijst of tekst met komma's).
 * @returns {{ value?: { name: string, values: string[] }[], error?: string, field?: string }} De kenmerken, of een fout.
 */
function sanitizeAttributes(raw) {
  if (!Array.isArray(raw)) return { error: 'Geef de kenmerken op (bijv. Maat met de waarden 16 mm, 20 mm).', field: 'attributes' };
  const out = [];
  const names = new Set();
  for (const entry of raw) {
    const name = cleanText(entry && entry.name, 40);
    const rawValues = Array.isArray(entry && entry.values) ? entry.values : String((entry && entry.values) ?? '').split(',');
    const values = [];
    const seen = new Set();
    for (const rawValue of rawValues) {
      const value = cleanText(rawValue, 40);
      if (!value || seen.has(value.toLowerCase())) continue;
      seen.add(value.toLowerCase());
      values.push(value);
    }
    if (!name && !values.length) continue;
    if (!name) return { error: 'Geef elk kenmerk een naam (bijv. Maat of Kleur).', field: 'attributes' };
    if (names.has(name.toLowerCase())) return { error: `Het kenmerk ${name} staat er twee keer in.`, field: 'attributes' };
    if (!values.length) return { error: `Geef het kenmerk ${name} een of meer waarden.`, field: 'attributes' };
    if (values.length > MAX_VALUES) return { error: `Hooguit ${MAX_VALUES} waarden per kenmerk.`, field: 'attributes' };
    names.add(name.toLowerCase());
    out.push({ name, values });
  }
  if (out.length > MAX_ATTRIBUTES) return { error: `Hooguit ${MAX_ATTRIBUTES} kenmerken per artikel.`, field: 'attributes' };
  if (out.reduce((total, attribute) => total * attribute.values.length, out.length ? 1 : 0) > MAX_SUB_ITEMS) return { error: `Dat worden meer dan ${MAX_SUB_ITEMS} subartikelen.`, field: 'attributes' };
  return { value: out };
}

/**
 * Alle combinaties van de waarden van de kenmerken.
 * @param {{ name: string, values: string[] }[]} attributes De kenmerken.
 * @returns {Object<string, string>[]} Per combinatie de waarde per kenmerk.
 */
function combinations(attributes) {
  return attributes.reduce((partial, attribute) => partial.flatMap((combination) => attribute.values.map((value) => ({ ...combination, [attribute.name]: value }))), attributes.length ? [{}] : []);
}

/**
 * De kenmerken van een variabel webshopproduct (alleen die voor variaties) in
 * het formaat van de artikelgroep.
 * @param {{ attributes?: { name: string, options?: string[], variation?: boolean }[] }} product Het webshopproduct.
 * @returns {{ name: string, values: string[] }[]} De kenmerken.
 */
function shopAttributesOf(product) {
  const raw = (product.attributes || []).filter((attribute) => attribute && attribute.variation !== false && Array.isArray(attribute.options))
    .map((attribute) => ({ name: attribute.name, values: attribute.options.slice(0, MAX_VALUES) }));
  const checked = sanitizeAttributes(raw.slice(0, MAX_ATTRIBUTES));
  return checked.error ? [] : checked.value;
}

/**
 * Voegt de waarden van kenmerken uit de webshop toe aan die van de artikelgroep (niets valt weg).
 * @param {{ name: string, values: string[] }[]} current De kenmerken in Aquatech.
 * @param {{ name: string, values: string[] }[]} incoming De kenmerken uit de webshop.
 * @returns {{ name: string, values: string[] }[]} De samengevoegde kenmerken.
 */
function mergeAttributes(current, incoming) {
  const out = current.map((attribute) => ({ name: attribute.name, values: [...attribute.values] }));
  for (const attribute of incoming) {
    const found = out.find((existing) => existing.name.toLowerCase() === attribute.name.toLowerCase());
    if (!found) {
      if (out.length < MAX_ATTRIBUTES) out.push({ name: attribute.name, values: [...attribute.values] });
      continue;
    }
    for (const value of attribute.values) {
      if (found.values.length < MAX_VALUES && !found.values.some((known) => known.toLowerCase() === value.toLowerCase())) found.values.push(value);
    }
  }
  return out;
}

/**
 * Een vaste sleutel voor de waarden van een subartikel (hoofdletterongevoelig, op naam van het kenmerk).
 * @param {Object<string, string>} values Waarde per kenmerk.
 * @returns {string} De sleutel.
 */
function valuesKey(values) {
  return Object.entries(values || {}).map(([name, value]) => `${String(name).toLowerCase()}=${String(value).toLowerCase()}`).sort().join('|');
}

/**
 * Een stukje artikelcode uit een waarde: hoofdletters, cijfers en . / +, zonder accenten.
 * @param {string} value De waarde, bijv. '16 mm'.
 * @returns {string} Bijv. '16MM'.
 */
const codePart = (value) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9./+]/g, '') || 'X';

/**
 * De omschrijving van een subartikel: artikelgroep met de waarden erachter.
 * @param {string} groupName Omschrijving van de artikelgroep.
 * @param {Object<string, string>} values Waarde per kenmerk.
 * @returns {string} Bijv. 'PE-buis 16 mm'.
 */
const subItemName = (groupName, values) => cleanText(`${groupName} ${Object.values(values).join(' / ')}`, 200);

/**
 * Vraagtekens voor een SQL IN (...)-lijst.
 * @param {number} count Aantal waarden.
 * @returns {string} Bijv. "?,?,?".
 */
const placeholders = (count) => Array.from({ length: count }, () => '?').join(',');

/**
 * Schoont een voorraadartikel op.
 * @param {object} raw De invoer.
 * @param {{ partial?: boolean }} [options] partial: alleen de meegestuurde velden (wijzigen).
 * @returns {{ value?: object, error?: string, field?: string }} De opgeschoonde velden, of een fout met het veld.
 */
function sanitizeItem(raw, { partial = false } = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  if (!partial || input.code !== undefined) {
    const code = normalizeCode(input.code);
    if (!code) return { error: 'Vul een artikelcode in.', field: 'code' };
    if (code.length > 40 || !/^[A-Z0-9][A-Z0-9 ._\-/+]*$/.test(code)) return { error: 'Een artikelcode bestaat uit letters, cijfers en - . _ / + (max. 40 tekens).', field: 'code' };
    out.code = code;
  }
  if (!partial || input.name !== undefined) {
    const name = cleanText(input.name, 200);
    if (!name) return { error: 'Vul een omschrijving in.', field: 'name' };
    out.name = name;
  }
  if (!partial || input.unit !== undefined) out.unit = cleanText(input.unit, 12) || 'st';
  if (!partial || input.location !== undefined) out.location = cleanText(input.location, 60);
  if (!partial || input.notes !== undefined) out.notes = cleanText(input.notes, 1000);
  if (!partial || input.minQty !== undefined) {
    const minQty = input.minQty === '' || input.minQty == null ? 0 : Number(input.minQty);
    if (!Number.isFinite(minQty) || minQty < 0 || minQty > MAX_QTY) return { error: 'Ongeldige minimumvoorraad.', field: 'minQty' };
    out.minQty = round3(minQty);
  }
  if (!partial || input.reorderQty !== undefined) {
    const reorderQty = input.reorderQty === '' || input.reorderQty == null ? null : Number(input.reorderQty);
    if (reorderQty !== null && (!Number.isFinite(reorderQty) || reorderQty < 0 || reorderQty > MAX_QTY)) return { error: 'Ongeldig aantal bij Bestellen tot.', field: 'reorderQty' };
    out.reorderQty = reorderQty === null ? null : round3(reorderQty);
  }
  if (!partial || input.costPrice !== undefined) {
    const costPrice = input.costPrice === '' || input.costPrice == null ? null : Number(input.costPrice);
    if (costPrice !== null && (!Number.isFinite(costPrice) || costPrice < 0 || costPrice > MAX_QTY)) return { error: 'Ongeldige inkoopprijs.', field: 'costPrice' };
    // Vier decimalen, net als de prijshistorie en de voorraadlagen (stock-costs.js).
    out.costPrice = costPrice === null ? null : Math.round(costPrice * 10000) / 10000;
  }
  if (!partial || input.salePrice !== undefined) {
    const salePrice = input.salePrice === '' || input.salePrice == null ? null : Number(input.salePrice);
    if (salePrice !== null && (!Number.isFinite(salePrice) || salePrice < 0 || salePrice > MAX_QTY)) return { error: 'Ongeldige verkoopprijs.', field: 'salePrice' };
    out.salePrice = salePrice === null ? null : Math.round(salePrice * 100) / 100;
  }
  if (!partial || input.businessPrice !== undefined) {
    const businessPrice = input.businessPrice === '' || input.businessPrice == null ? null : Number(input.businessPrice);
    if (businessPrice !== null && (!Number.isFinite(businessPrice) || businessPrice < 0 || businessPrice > MAX_QTY)) return { error: 'Ongeldige zakelijke prijs.', field: 'businessPrice' };
    out.businessPrice = businessPrice === null ? null : Math.round(businessPrice * 100) / 100;
  }
  if (!partial || input.vatRate !== undefined) {
    const vatRate = input.vatRate === undefined || input.vatRate === '' || input.vatRate === null ? 21 : Number(input.vatRate);
    if (!VAT_RATES.includes(vatRate)) return { error: 'Kies een btw-tarief van 21, 9 of 0%.', field: 'vatRate' };
    out.vatRate = vatRate;
  }
  if (!partial || input.revenueGroup !== undefined) {
    const group = input.revenueGroup === undefined || input.revenueGroup === '' ? 'producten' : String(input.revenueGroup);
    if (!GROUPS[group]) return { error: 'Onbekende omzetgroep.', field: 'revenueGroup' };
    out.revenueGroup = group;
  }
  if (!partial || input.weightGrams !== undefined) {
    const weightGrams = input.weightGrams === '' || input.weightGrams == null ? null : Number(input.weightGrams);
    if (weightGrams !== null && (!Number.isFinite(weightGrams) || weightGrams < 0 || weightGrams > 1000000)) return { error: 'Ongeldig gewicht (gram, hoogstens 1.000.000).', field: 'weightGrams' };
    out.weightGrams = weightGrams === null ? null : Math.round(weightGrams);
  }
  if (!partial || input.shopSync !== undefined) out.shopSync = input.shopSync !== false;
  // Groothandelsvoorwaarden: verpakkingseenheid en minimale afname horen bij elkaar (de minimale afname is een veelvoud van de eenheid).
  if (!partial || input.packSize !== undefined || input.orderMinQty !== undefined) {
    const terms = Wholesale.sanitizeTerms(input);
    if (terms.error) return terms;
    if (!partial || input.packSize !== undefined) out.packSize = terms.packSize;
    if (!partial || input.orderMinQty !== undefined) out.orderMinQty = terms.orderMinQty;
  }
  // EAN van de fabrikant (8 of 13 cijfers met een kloppend controlecijfer, UPC-A wordt EAN-13); leeg = geen.
  if (!partial || input.ean !== undefined) {
    const given = String(input.ean == null ? '' : input.ean).trim();
    const ean = given ? Barcode.cleanEan(given) : null;
    if (given && !ean) return { error: 'Ongeldige EAN: 8 of 13 cijfers met een kloppend controlecijfer.', field: 'ean' };
    out.ean = ean;
  }
  // Inhoud per verkoopeenheid in de eenheid van de planner (bijv. 50 voor een rol van 50 m); leeg = geen omrekening.
  if (!partial || input.unitContent !== undefined) {
    const unitContent = input.unitContent === '' || input.unitContent == null ? null : Number(input.unitContent);
    if (unitContent !== null && (!Number.isFinite(unitContent) || unitContent <= 0 || unitContent > 100000)) return { error: 'Ongeldige inhoud per eenheid (groter dan 0, hoogstens 100.000).', field: 'unitContent' };
    out.unitContent = unitContent === null ? null : Math.round(unitContent * 1000) / 1000;
  }
  // Prijsbepaling: vaste verkoopprijs of inkoopprijs × factor (price-factor.js); een eigen factor is leeg = die van leverancier, categorie of standaard.
  if (!partial || input.priceMode !== undefined) {
    if (input.priceMode !== undefined && input.priceMode !== 'vast' && input.priceMode !== 'factor') return { error: 'Kies een vaste prijs of een prijs volgens factor.', field: 'priceMode' };
    out.priceMode = input.priceMode === 'factor' ? 'factor' : 'vast';
  }
  if (!partial || input.priceFactor !== undefined) {
    const priceFactor = input.priceFactor === '' || input.priceFactor == null ? null : PriceFactor.cleanFactor(input.priceFactor);
    if (priceFactor === null && input.priceFactor !== '' && input.priceFactor != null) return { error: `De factor is een getal van ${PriceFactor.MIN_FACTOR} tot en met ${PriceFactor.MAX_FACTOR}.`, field: 'priceFactor' };
    out.priceFactor = priceFactor;
  }
  // Omschrijving en specificaties voor de productpagina en de feed (12); los opgeslagen, niet in de overzichten.
  if (!partial || input.description !== undefined) out.description = ItemDetails.sanitizeDescription(input.description);
  if (!partial || input.specifications !== undefined) out.specifications = ItemDetails.sanitizeSpecifications(input.specifications);
  // Eigen titel en omschrijving voor zoekmachines en het merk (leeg = automatisch), zie webshop/seo.js.
  if (!partial || input.seoTitle !== undefined) out.seoTitle = ItemDetails.sanitizeSeoTitle(input.seoTitle);
  if (!partial || input.seoDescription !== undefined) out.seoDescription = ItemDetails.sanitizeSeoDescription(input.seoDescription);
  if (!partial || input.brand !== undefined) out.brand = ItemDetails.sanitizeBrand(input.brand);
  // Levermethoderegels en levertijd per artikel (webshop/delivery-rules.js, delivery-times.js); los opgeslagen zoals de omschrijving.
  if (!partial || input.deliveryRules !== undefined) {
    const problem = input.deliveryRules === undefined ? '' : DeliveryRules.checkRules(input.deliveryRules);
    if (problem) return { error: problem, field: 'deliveryRules' };
    out.deliveryRules = DeliveryRules.sanitizeRules(input.deliveryRules);
  }
  if (!partial || input.leadDays !== undefined) {
    const lead = input.leadDays === undefined || input.leadDays === null ? null : DeliveryTimes.sanitizeLead(input.leadDays);
    if (input.leadDays && input.leadDays.min !== '' && input.leadDays.min != null && !lead) return { error: `De levertijd is een bereik in hele dagen van 0 tot en met ${DeliveryTimes.MAX_LEAD_DAYS}.`, field: 'leadDays' };
    out.leadDays = lead;
  }
  if (!partial || input.priceTiers !== undefined) {
    const tiers = Wholesale.sanitizeTiers(input.priceTiers);
    if (tiers.error) return { error: tiers.error, field: 'priceTiers' };
    out.priceTiers = tiers.tiers;
  }
  return { value: out };
}

/**
 * Benodigd per artikelcode uit de materiaallijst van een werkorder.
 * @param {object[]} materials De materiaallijst (code, qty, description, unit).
 * @returns {Map<string, { qty: number, description: string, unit: string }>} Per genormaliseerde code het totaal.
 */
function needsOf(materials) {
  const need = new Map();
  for (const material of Array.isArray(materials) ? materials : []) {
    const code = normalizeCode(material && material.code);
    const qty = Number(material && material.qty);
    if (!code || !(qty > 0)) continue;
    const total = need.get(code) || { qty: 0, description: '', unit: '' };
    total.qty = round3(total.qty + qty);
    total.description = total.description || cleanText(material.description, 200);
    total.unit = total.unit || cleanText(material.unit, 12);
    need.set(code, total);
  }
  return need;
}


module.exports = {
  KINDS,
  MANUAL,
  OPEN,
  MAX_QTY,
  LIST_LIMIT,
  GROUPS,
  VAT_RATES,
  EXPORT_LIMIT,
  BATCH,
  currentTimestamp,
  round3,
  normalizeCode,
  shopCodeOf,
  cleanText,
  isDate,
  sumQty,
  DEFAULT_UNITS,
  MAX_ATTRIBUTES,
  MAX_VALUES,
  MAX_SUB_ITEMS,
  parseJson,
  sanitizeAttributes,
  combinations,
  shopAttributesOf,
  mergeAttributes,
  valuesKey,
  codePart,
  subItemName,
  placeholders,
  sanitizeItem,
  needsOf,
};
