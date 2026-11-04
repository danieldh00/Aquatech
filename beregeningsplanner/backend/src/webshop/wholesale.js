// Groothandelsvoorwaarden in de eigen webshop: verpakkingseenheid en minimale
// afname per artikel, staffelkorting per artikel, een vaste korting per klant,
// en het inlezen van een geplakte bestellijst (artikelcode + aantal, bijvoorbeeld
// uit Excel). Zuivere functies zonder database, gedeeld door de prijsberekening
// (web-orders.js), de groothandelspagina's en de artikelopslag (stock.js).

/** Hoogste aantal staffels per artikel. */
const MAX_TIERS = 5;
/** Hoogste korting (%) in een staffel. */
const MAX_TIER_DISCOUNT = 90;
/** Hoogste aantal per winkelwagenregel (gelijk aan MAX_QTY in web-orders.js). */
const MAX_ORDER_QTY = 9999;
/** Hoogste verpakkingseenheid of minimale afname. */
const MAX_TERM = 100000;
/** Langste regel (tekens) van een geplakte lijst die we nog inlezen; langere regels slaan we over (beschermt de reguliere expressie tegen enorme regels). */
const MAX_LINE_LENGTH = 200;
/** Hoeveel regels van een geplakte lijst we hoogstens inlezen. */
const MAX_PASTE_LINES = 300;

/**
 * Rondt een bedrag af op hele centen.
 * @param {number} amount Het bedrag.
 * @returns {number} Het afgeronde bedrag.
 */
function round2(amount) {
  return Math.round(amount * 100) / 100;
}

/**
 * Controleert en normaliseert de staffels van een artikel: elke staffel begint bij
 * een heel aantal vanaf 2 (elk aantal één keer), met een korting boven 0 en hoogstens 90%.
 * De staffels komen oplopend op aantal terug.
 * @param {*} raw De ingevoerde staffels: een lijst van { minQty, discountPct } of de opgeslagen JSON-tekst.
 * @returns {{ tiers: { minQty: number, discountPct: number }[] }|{ error: string }} De staffels (oplopend op aantal) of een foutmelding.
 */
function sanitizeTiers(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw || '[]'); } catch { return { error: 'Ongeldige staffelkorting.' }; }
  }
  if (list === undefined || list === null || list === '') return { tiers: [] };
  if (!Array.isArray(list)) return { error: 'Ongeldige staffelkorting.' };
  if (list.length > MAX_TIERS) return { error: `Maximaal ${MAX_TIERS} staffels per artikel.` };
  const tiers = [];
  for (const entry of list) {
    const minQty = Number(entry && entry.minQty);
    const discountPct = Number(entry && entry.discountPct);
    if (!Number.isInteger(minQty) || minQty < 2 || minQty > MAX_ORDER_QTY) return { error: 'Een staffel begint bij een heel aantal van minimaal 2.' };
    if (!Number.isFinite(discountPct) || discountPct <= 0 || discountPct > MAX_TIER_DISCOUNT) return { error: `De korting van een staffel is een percentage boven 0 tot en met ${MAX_TIER_DISCOUNT}.` };
    if (tiers.some((tier) => tier.minQty === minQty)) return { error: `Het aantal ${minQty} komt twee keer voor in de staffels.` };
    tiers.push({ minQty, discountPct: Math.round(discountPct * 100) / 100 });
  }
  tiers.sort((left, right) => left.minQty - right.minQty);
  return { tiers };
}

/**
 * Leest de opgeslagen staffels (JSON) van een artikel; ongeldige inhoud geeft geen staffels.
 * @param {*} json De opgeslagen tekst.
 * @returns {{ minQty: number, discountPct: number }[]} De staffels, oplopend op aantal.
 */
function tiersOf(json) {
  const checked = sanitizeTiers(json);
  return checked.tiers || [];
}

/**
 * Maakt van de ingevulde afnamevoorwaarden van een artikel een geldig stel: de
 * verpakkingseenheid is een heel aantal vanaf 1 en de minimale afname een
 * veelvoud daarvan (naar boven afgerond).
 * @param {{ packSize?: *, orderMinQty?: * }} input De ingevulde waarden (leeg = 1).
 * @returns {{ packSize: number, orderMinQty: number }|{ error: string, field: string }} De waarden of een foutmelding met het veld.
 */
function sanitizeTerms(input) {
  const packSize = input.packSize === undefined || input.packSize === '' || input.packSize === null ? 1 : Number(input.packSize);
  if (!Number.isInteger(packSize) || packSize < 1 || packSize > MAX_TERM) return { error: 'De verpakkingseenheid is een heel aantal vanaf 1.', field: 'packSize' };
  const orderMinQty = input.orderMinQty === undefined || input.orderMinQty === '' || input.orderMinQty === null ? 1 : Number(input.orderMinQty);
  if (!Number.isInteger(orderMinQty) || orderMinQty < 1 || orderMinQty > MAX_TERM) return { error: 'De minimale afname is een heel aantal vanaf 1.', field: 'orderMinQty' };
  const roundedMinQty = Math.ceil(orderMinQty / packSize) * packSize;
  if (roundedMinQty > MAX_ORDER_QTY) return { error: `De minimale afname, afgerond op de verpakkingseenheid, is hoogstens ${MAX_ORDER_QTY}.`, field: 'orderMinQty' };
  return { packSize, orderMinQty: roundedMinQty };
}

/**
 * Het kleinste aantal dat een groothandelsklant van een artikel kan bestellen.
 * @param {{ packSize?: number, orderMinQty?: number }} terms De voorwaarden van het artikel.
 * @returns {number} Het minimum (een veelvoud van de verpakkingseenheid).
 */
function minimumOf(terms) {
  const packSize = Math.max(1, Number(terms.packSize) || 1);
  return Math.ceil(Math.max(1, Number(terms.orderMinQty) || 1) / packSize) * packSize;
}

/**
 * Rondt een gewenst aantal naar boven af op wat bestelbaar is: minimaal de minimale afname, anders het volgende veelvoud van de verpakkingseenheid.
 * @param {number} qty Het gewenste aantal.
 * @param {{ packSize?: number, orderMinQty?: number }} terms De voorwaarden van het artikel.
 * @returns {number} Het bestelbare aantal.
 */
function roundUpQty(qty, terms) {
  const packSize = Math.max(1, Number(terms.packSize) || 1);
  const wanted = Math.max(Math.floor(Number(qty)) || 0, minimumOf(terms));
  return Math.ceil(wanted / packSize) * packSize;
}

/**
 * Of een aantal voldoet aan de voorwaarden van het artikel, met een uitleg als dat niet zo is.
 * @param {number} qty Het aantal.
 * @param {{ packSize?: number, orderMinQty?: number }} terms De voorwaarden van het artikel.
 * @returns {string} Een uitleg voor de klant, of een lege tekst als het aantal klopt.
 */
function quantityProblem(qty, terms) {
  const packSize = Math.max(1, Number(terms.packSize) || 1);
  const minimum = minimumOf(terms);
  if (qty < minimum) return packSize > 1 ? `Minimaal ${minimum} stuks, en alleen per ${packSize}` : `Minimaal ${minimum} stuks`;
  if (qty % packSize !== 0) return `Alleen per ${packSize} stuks`;
  return '';
}

/**
 * De korting (%) die voor een aantal geldt: de hoogste staffel waarvan het aantal gehaald is.
 * @param {{ minQty: number, discountPct: number }[]} tiers De staffels van het artikel.
 * @param {number} qty Het aantal.
 * @returns {number} Het kortingspercentage, 0 zonder staffel.
 */
function tierDiscount(tiers, qty) {
  let discount = 0;
  for (const tier of tiers) if (qty >= tier.minQty && tier.discountPct > discount) discount = tier.discountPct;
  return discount;
}

/**
 * De stukprijs excl. btw voor een groothandelsklant: de basisprijs min de grootste
 * van de staffelkorting voor dit aantal en de vaste korting van de klant. De kortingen
 * tellen dus niet op elkaar op.
 * @param {number} baseExcl De zakelijke prijs per stuk excl. btw.
 * @param {number} qty Het aantal.
 * @param {{ minQty: number, discountPct: number }[]} tiers De staffels van het artikel.
 * @param {number} customerDiscount De vaste korting (%) van de klant.
 * @returns {{ unitExcl: number, discountPct: number, source: string }} De stukprijs, de toegepaste korting en waar die vandaan komt ('staffel', 'klant' of '').
 */
function wholesalePrice(baseExcl, qty, tiers, customerDiscount) {
  const fromTier = tierDiscount(tiers, qty);
  const fromCustomer = Math.max(0, Number(customerDiscount) || 0);
  const discountPct = Math.max(fromTier, fromCustomer);
  return { unitExcl: discountPct > 0 ? round2(baseExcl * (1 - discountPct / 100)) : round2(baseExcl), discountPct, source: discountPct <= 0 ? '' : fromTier >= fromCustomer ? 'staffel' : 'klant' };
}

/** Eerste regel van een geplakte lijst die een kopregel is ("Artikelcode;Aantal") en dus wordt overgeslagen. */
const HEADER_WORDS = new Set(['artikel', 'artikelnr', 'artikelnummer', 'artikelcode', 'nr', 'nummer', 'no', 'code', 'sku', 'item', 'aantal', 'qty', 'quantity', 'stuks', 'hoeveelheid']);

/**
 * Of een regel een kopregel is: alleen woorden als artikelcode en aantal, geen echte code.
 * @param {string} line De regel.
 * @returns {boolean} true bij een kopregel.
 */
function isHeaderLine(line) {
  const words = line.toLowerCase().split(/[\s;,:=\t]+/).filter(Boolean);
  return words.length > 1 && HEADER_WORDS.has(words[0]) && words.every((word) => HEADER_WORDS.has(word));
}
/** Een regel met een artikelcode, een scheidingsteken en een aantal ("CODE 50", "CODE;50", "CODE\t50", "CODE x 50"). */
const ENTRY_LINE = /^(.*?)[\s;,:=×]+x?\s*(\d{1,6})\s*$/i;

/**
 * Leest een geplakte bestellijst: per regel een artikelcode en een aantal, gescheiden
 * door een tab (uit Excel), puntkomma, komma, dubbele punt, = of spatie. Een regel
 * met alleen een code telt als aantal 1; een kopregel en lege regels worden overgeslagen.
 * Dezelfde code twee keer wordt opgeteld.
 * @param {*} text De geplakte tekst.
 * @returns {{ entries: { code: string, qty: number }[], problems: { line: number, text: string, message: string }[], truncated: boolean, rows: { line: number, code: string }[], stoppedAt: number }} De regels, de regels die niet te lezen waren (met regelnummer), of de lijst te lang was, per gelezen regel de code (met regelnummer) en de index van de eerste regel die niet meer gelezen is.
 */
function parseOrderList(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const entries = [];
  const problems = [];
  const byCode = new Map();
  const rows = [];
  let read = 0;
  let truncated = false;
  let stoppedAt = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw) continue;
    if (index === 0 && isHeaderLine(raw)) continue;
    if (read >= MAX_PASTE_LINES) { truncated = true; stoppedAt = index; break; }
    read += 1;
    if (raw.length > MAX_LINE_LENGTH) { problems.push({ line: index + 1, text: `${raw.slice(0, 40)}…`, message: `De regel is te lang (hoogstens ${MAX_LINE_LENGTH} tekens).` }); continue; }
    const match = ENTRY_LINE.exec(raw);
    const code = (match ? match[1] : raw).replace(/^["']|["']$/g, '').trim().toUpperCase();
    const qty = match ? Number(match[2]) : 1;
    if (!code || code.length > 60) { problems.push({ line: index + 1, text: raw.slice(0, 80), message: 'Geen artikelcode gevonden.' }); continue; }
    if (!(qty >= 1)) { problems.push({ line: index + 1, text: raw.slice(0, 80), message: 'Het aantal moet minimaal 1 zijn.' }); continue; }
    rows.push({ line: index + 1, code });
    const existing = byCode.get(code);
    if (existing) existing.qty += qty;
    else { const entry = { code, qty }; byCode.set(code, entry); entries.push(entry); }
  }
  return { entries, problems, truncated, rows, stoppedAt };
}

module.exports = { sanitizeTiers, tiersOf, sanitizeTerms, minimumOf, roundUpQty, quantityProblem, tierDiscount, wholesalePrice, parseOrderList, MAX_TIERS, MAX_PASTE_LINES };
