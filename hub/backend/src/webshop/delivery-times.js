// Levertijden van de webshop: het bereik per bezorgmethode (kalender- of werkdagen), de overschrijving per artikel en de
// afleiding uit inkoop (verwachte datum van een openstaande inkooporder, anders de levertijd van de leverancier).
// Zuivere functies zonder database; de uitkomst is altijd indicatief (we zijn afhankelijk van externe partijen).

/** De twee soorten dagen waarin een levertijd staat. */
const DAY_TYPES = ['calendar', 'working'];
/** Hoogste levertijd (dagen) die we accepteren. */
const MAX_LEAD_DAYS = 365;
/** De tekst als er geen levertijd bekend is. */
const UNKNOWN_TEXT = 'Levertijd op aanvraag';

/**
 * Maakt van een invoer een bruikbaar bereik: hele dagen van 0 tot en met 365, met min niet boven max.
 * @param {*} raw De invoer: { min, max } (max leeg = gelijk aan min).
 * @returns {?{ min: number, max: number }} Het bereik, of null als de invoer leeg of onbruikbaar is.
 */
function sanitizeLead(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.min === '' || raw.min == null) return null;
  const min = Math.round(Number(raw.min));
  const max = raw.max === '' || raw.max == null ? min : Math.round(Number(raw.max));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > MAX_LEAD_DAYS) return null;
  return { min, max };
}

/**
 * Leest een soort dagen.
 * @param {*} raw De invoer.
 * @param {string} fallback De waarde als de invoer niet klopt.
 * @returns {string} 'calendar' of 'working'.
 */
function sanitizeDayType(raw, fallback) {
  return DAY_TYPES.includes(raw) ? raw : fallback;
}

/**
 * Rekent een aantal kalenderdagen om naar werkdagen (afgerond naar boven, vijf van de zeven dagen).
 * @param {number} days Kalenderdagen.
 * @returns {number} Werkdagen.
 */
function calendarToWorking(days) {
  return Math.ceil((days * 5) / 7);
}

/**
 * Het aantal hele dagen van vandaag tot een datum (nooit negatief).
 * @param {string} date De datum (JJJJ-MM-DD).
 * @param {Date} today Vandaag.
 * @returns {?number} Het aantal kalenderdagen, of null als de datum niet te lezen is.
 */
function daysUntil(date, today) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  if (!match) return null;
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.round((target - start) / 86400000));
}

/**
 * Bepaalt de levertijd van een artikel bij een bezorgmethode.
 * Rangorde: de overschrijving van het artikel; op voorraad = het bereik van de methode; niet op voorraad = de aanlevertijd
 * (verwachte datum van een inkooporder, anders de levertijd van de leverancier) plus het bereik van de methode.
 * Zonder bruikbare gegevens is er geen levertijd (null).
 * @param {{ override?: ?{ min: number, max: number }, inStock: boolean, methodLead: ?{ min: number, max: number }, dayType: string, expectedDate?: string, supplierLeadDays?: ?number, today?: Date }} input De gegevens; dayType is de soort dagen van de methode.
 * @returns {?{ min: number, max: number, dayType: string, source: string }} Het bereik, de soort dagen en waar het vandaan komt (artikel, voorraad, inkoop of leverancier).
 */
function leadFor({ override = null, inStock, methodLead, dayType, expectedDate = '', supplierLeadDays = null, today = new Date() }) {
  const type = sanitizeDayType(dayType, 'calendar');
  if (override) return { min: override.min, max: override.max, dayType: type, source: 'artikel' };
  if (!methodLead) return null;
  if (inStock) return { ...methodLead, dayType: type, source: 'voorraad' };
  const expectedDays = expectedDate ? daysUntil(expectedDate, today) : null;
  const supplyCalendarDays = expectedDays != null ? expectedDays : (Number.isFinite(Number(supplierLeadDays)) && supplierLeadDays != null && supplierLeadDays !== '' ? Math.max(0, Math.round(Number(supplierLeadDays))) : null);
  if (supplyCalendarDays == null) return null;
  const supplyDays = type === 'working' ? calendarToWorking(supplyCalendarDays) : supplyCalendarDays;
  return { min: methodLead.min + supplyDays, max: methodLead.max + supplyDays, dayType: type, source: expectedDays != null ? 'inkoop' : 'leverancier' };
}

/**
 * De tekst bij een levertijd, in gewone taal.
 * @param {?{ min: number, max: number, dayType: string }} lead Het bereik (leadFor); null = onbekend.
 * @returns {string} Bijvoorbeeld "1-2 dagen", "3-5 werkdagen", "Direct" of "Levertijd op aanvraag".
 */
function leadText(lead) {
  if (!lead) return UNKNOWN_TEXT;
  if (lead.max === 0) return 'Direct';
  const unit = lead.dayType === 'working' ? (lead.max === 1 ? 'werkdag' : 'werkdagen') : (lead.max === 1 ? 'dag' : 'dagen');
  return lead.min === lead.max ? `${lead.max} ${unit}` : `${lead.min}-${lead.max} ${unit}`;
}

/**
 * De korte tekst bij de levertijd die op een bestelling is vastgelegd (data.shipping.eta).
 * @param {?{ text?: string, min?: ?number, max?: ?number }} eta De momentopname; oudere bestellingen hebben er geen.
 * @returns {string} "ca. 1-2 dagen", "direct" of "op aanvraag"; leeg zonder momentopname.
 */
function etaPhrase(eta) {
  if (!eta || typeof eta !== 'object') return '';
  if (eta.min == null || eta.max == null) return 'op aanvraag';
  return eta.max === 0 ? 'direct' : `ca. ${String(eta.text || '').trim()}`.trim();
}

/**
 * De zin over de verwachte levertijd van een bestelling, altijd als indicatie en nooit als belofte. Afhalen heeft geen levertijd (leeg).
 * @param {?{ method?: string, eta?: object }} shipping De verzending van de bestelling (data.shipping).
 * @returns {string} De zin, of leeg bij afhalen of zonder vastgelegde levertijd.
 */
function etaSentence(shipping) {
  if (!shipping || shipping.method === 'ophalen' || !shipping.eta) return '';
  if (shipping.eta.min == null || shipping.eta.max == null) return 'Levertijd op aanvraag: we laten je weten wanneer je bestelling geleverd kan worden.';
  const unitText = shipping.eta.max === 0 ? 'Je bestelling kan direct worden verzonden' : `Verwachte levertijd: ${etaPhrase(shipping.eta)}`;
  return `${unitText}. Dit is een indicatie en geen toezegging: we zijn afhankelijk van externe partijen.`;
}

/**
 * De langste van meerdere levertijden (de bestelling is zo snel als het langzaamste artikel). Eén onbekende levertijd maakt het geheel onbekend.
 * @param {(?{ min: number, max: number, dayType: string })[]} leads De levertijden per artikel (null = onbekend).
 * @returns {?{ min: number, max: number, dayType: string }} De langste, of null als er niets is of één onbekend is.
 */
function slowestOf(leads) {
  if (!leads.length || leads.some((lead) => !lead)) return null;
  // Werkdagen zijn bij gelijk getal langer dan kalenderdagen; vergelijk daarom in kalenderdagen.
  /**
   * De langste duur van een bereik in kalenderdagen.
   * @param {{ max: number, dayType: string }} lead Het bereik.
   * @returns {number} Kalenderdagen.
   */
  const calendarMax = (lead) => (lead.dayType === 'working' ? Math.ceil((lead.max * 7) / 5) : lead.max);
  return leads.reduce((slowest, lead) => (calendarMax(lead) > calendarMax(slowest) ? lead : slowest));
}

module.exports = { etaPhrase, etaSentence, DAY_TYPES, MAX_LEAD_DAYS, UNKNOWN_TEXT, sanitizeLead, sanitizeDayType, leadFor, leadText, slowestOf, daysUntil };
