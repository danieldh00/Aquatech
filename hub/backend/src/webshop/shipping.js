// Verzending in de eigen webshop: afhalen in Nunspeet (gratis) en bezorging door
// DPD, per pallet of met eigen transport, elk met tarieven per land en gewicht
// en gratis verzending boven een bedrag. Zuivere
// functies zonder database: de instelling `shopShipping` wordt hier gesaneerd
// en de opties voor een winkelwagen worden hier berekend. Alle prijzen zijn
// incl. btw; web-orders.js rekent de btw uit (tarief `vatRate`).

const { sanitizeLead, sanitizeDayType } = require('./delivery-times');

/** Btw-tarief waarmee verzendkosten worden berekend. */
const SHIPPING_VAT_RATE = 21;
/** Hoogstens zoveel landen en zoveel weegklassen per land. */
const MAX_ZONES = 30;
const MAX_TIERS = 20;
/** Gewicht (gram) van een artikel zonder ingevuld gewicht, tenzij de instelling anders zegt. */
const DEFAULT_WEIGHT_GRAMS = 1000;

/** Landen die bij de standaardinstelling horen, met hun postcodecontrole. */
const COUNTRY_NAMES = { NL: 'Nederland', BE: 'België', DE: 'Duitsland', LU: 'Luxemburg', FR: 'Frankrijk' };
/** Postcodecontrole per land (andere landen: 3 tot 10 tekens). */
const POSTCODE_PATTERNS = { NL: /^[0-9]{4}\s?[A-Z]{2}$/, BE: /^[0-9]{4}$/, DE: /^[0-9]{5}$/, LU: /^[0-9]{4}$/, FR: /^[0-9]{5}$/ };

/** De methodes met bezorging (elk met eigen tarieven per land en gewicht); `ophalen` is de enige zonder kosten en zonder adres. */
const CARRIERS = ['dpd', 'pallet', 'eigen'];
/** Alle verzendmethodes in de volgorde van de keuzelijst: bezorgen eerst, afhalen als laatste. */
const METHODS = [...CARRIERS, 'ophalen'];
/** Standaardnaam van de afhaaloptie. */
const DEFAULT_PICKUP_LABEL = 'Afhalen in Nunspeet';
/** Standaardnamen van de bezorgmethodes (aan te passen in Beheer). */
const CARRIER_LABELS = { dpd: 'Bezorging door DPD', pallet: 'Bezorging per pallet', eigen: 'Eigen transport' };

/** Indicatieve startwaarden (aan te passen in Beheer): DPD binnen Nederland; pallet en eigen transport staan uit tot er tarieven zijn. */
const DEFAULT_CONFIG = {
  pickup: { enabled: true, label: DEFAULT_PICKUP_LABEL, note: '', leadDays: { min: 0, max: 0 }, dayType: 'calendar' },
  defaultWeightGrams: DEFAULT_WEIGHT_GRAMS,
  dpd: {
    enabled: true,
    label: CARRIER_LABELS.dpd, leadDays: { min: 1, max: 2 }, dayType: 'calendar',
    zones: [{
      country: 'NL', name: 'Nederland', freeFrom: 150,
      tiers: [{ upToGrams: 2000, price: 6.95 }, { upToGrams: 5000, price: 8.95 }, { upToGrams: 10000, price: 11.95 }, { upToGrams: 23000, price: 15.95 }],
    }],
  },
  pallet: { enabled: false, label: CARRIER_LABELS.pallet, zones: [], leadDays: { min: 3, max: 5 }, dayType: 'working' },
  eigen: { enabled: false, label: CARRIER_LABELS.eigen, zones: [], leadDays: { min: 5, max: 10 }, dayType: 'working' },
};

/** Standaard levertijd en soort dagen per methode, voor een instelling zonder die velden. */
const DEFAULT_LEADS = {
  pickup: DEFAULT_CONFIG.pickup, dpd: DEFAULT_CONFIG.dpd, pallet: DEFAULT_CONFIG.pallet, eigen: DEFAULT_CONFIG.eigen,
};

/**
 * Rondt af op twee decimalen.
 * @param {*} value Het bedrag.
 * @returns {number} Het afgeronde bedrag.
 */
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Maakt een invoer tot getrimde tekst van hoogstens een bepaalde lengte.
 * @param {*} value De invoer.
 * @param {number} max Maximale lengte (tekens).
 * @returns {string} De opgeschoonde tekst.
 */
const text = (value, max) => Array.from(String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, max).join('');

/**
 * Saneert de weegklassen van een land: oplopend op gewicht, hoogstens MAX_TIERS.
 * @param {*} raw De invoer ([{ upToGrams, price }]).
 * @returns {{ upToGrams: number, price: number }[]} De klassen, of een lege lijst.
 */
function sanitizeTiers(raw) {
  const tiers = [];
  for (const entry of (Array.isArray(raw) ? raw : []).slice(0, MAX_TIERS)) {
    const upToGrams = Math.round(Number(entry && entry.upToGrams));
    const price = round2(entry && entry.price);
    if (!Number.isFinite(upToGrams) || upToGrams < 1 || upToGrams > 1000000 || !(Number(entry && entry.price) >= 0) || price > 1000) continue;
    tiers.push({ upToGrams, price });
  }
  return tiers.sort((left, right) => left.upToGrams - right.upToGrams).filter((tier, index, list) => index === 0 || tier.upToGrams !== list[index - 1].upToGrams);
}

/**
 * Saneert de aantalstaffel van een land (alleen pallet en eigen transport): oplopend op aantal, hoogstens MAX_TIERS.
 * @param {*} raw De invoer ([{ upToQty, price }]); het aantal is in de basiseenheid van de artikelen.
 * @returns {{ upToQty: number, price: number }[]} De klassen, of een lege lijst.
 */
function sanitizeQtyTiers(raw) {
  const tiers = [];
  for (const entry of (Array.isArray(raw) ? raw : []).slice(0, MAX_TIERS)) {
    const upToQty = Math.round(Number(entry && entry.upToQty));
    const price = round2(entry && entry.price);
    if (!Number.isFinite(upToQty) || upToQty < 1 || upToQty > 1000000 || !(Number(entry && entry.price) >= 0) || price > 10000) continue;
    tiers.push({ upToQty, price });
  }
  return tiers.sort((left, right) => left.upToQty - right.upToQty).filter((tier, index, list) => index === 0 || tier.upToQty !== list[index - 1].upToQty);
}

/**
 * Saneert de tarieven per land van één bezorgmethode.
 * @param {*} raw De invoer ([{ country, name, freeFrom, tiers, qtyTiers }]).
 * @param {boolean} [withQtyTiers] true bij pallet en eigen transport: dan telt ook de aantalstaffel `qtyTiers` (die gaat voor de weegklassen).
 * @returns {{ country: string, name: string, freeFrom: number, tiers: object[], qtyTiers: object[] }[]} De landen (hoogstens MAX_ZONES, elk land één keer).
 */
function sanitizeZones(raw, withQtyTiers = false) {
  const zones = [];
  for (const entry of (Array.isArray(raw) ? raw : []).slice(0, MAX_ZONES)) {
    const country = text(entry && entry.country, 2).toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || zones.some((zone) => zone.country === country)) continue;
    const freeFrom = Number(entry.freeFrom);
    zones.push({
      country, name: text(entry.name, 60) || COUNTRY_NAMES[country] || country,
      freeFrom: Number.isFinite(freeFrom) && freeFrom > 0 && freeFrom <= 100000 ? round2(freeFrom) : 0,
      tiers: sanitizeTiers(entry.tiers), ...(withQtyTiers ? { qtyTiers: sanitizeQtyTiers(entry.qtyTiers) } : {}),
    });
  }
  return zones;
}

/**
 * De levertijd en de soort dagen van een methode uit de invoer. Een ontbrekend veld geeft de standaard; een bewust leeg veld (null of lege min) betekent "levertijd onbekend".
 * @param {object} input De instelling van de methode.
 * @param {string} method De methode (pickup, dpd, pallet of eigen).
 * @returns {{ leadDays: ?{ min: number, max: number }, dayType: string }} Het bereik (null = onbekend) en 'calendar' of 'working'.
 */
function leadOf(input, method) {
  const standard = DEFAULT_LEADS[method];
  const given = input.leadDays;
  const leadDays = given === undefined ? standard.leadDays : (given === null || given.min === '' || given.min == null ? null : (sanitizeLead(given) || standard.leadDays));
  return { leadDays, dayType: sanitizeDayType(input.dayType, standard.dayType) };
}

/**
 * Saneert de instelling `shopShipping`. Een lege of onbruikbare invoer geeft de standaardwaarden.
 * @param {*} raw De ingevoerde instelling.
 * @returns {{ pickup: object, defaultWeightGrams: number, dpd: object, pallet: object, eigen: object }} De gesaneerde instelling.
 */
function sanitizeShipping(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!input || !['pickup', ...CARRIERS].some((key) => input[key] !== undefined)) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const pickupInput = input.pickup && typeof input.pickup === 'object' ? input.pickup : {};
  const dpdInput = input.dpd && typeof input.dpd === 'object' ? input.dpd : {};
  const weightInput = input.defaultWeightGrams !== undefined ? input.defaultWeightGrams : dpdInput.defaultWeightGrams;
  const defaultWeight = Math.round(Number(weightInput));
  const config = {
    pickup: { enabled: pickupInput.enabled !== false, label: text(pickupInput.label, 60) || DEFAULT_PICKUP_LABEL, note: text(pickupInput.note, 300), ...leadOf(pickupInput, 'pickup') },
    defaultWeightGrams: Number.isFinite(defaultWeight) && defaultWeight >= 0 && defaultWeight <= 100000 ? defaultWeight : DEFAULT_WEIGHT_GRAMS,
  };
  for (const carrier of CARRIERS) {
    const carrierInput = input[carrier] && typeof input[carrier] === 'object' ? input[carrier] : {};
    // DPD staat standaard aan; pallet en eigen transport alleen als de beheerder ze aanzet.
    const enabled = carrier === 'dpd' ? carrierInput.enabled !== false : carrierInput.enabled === true;
    config[carrier] = { enabled, label: text(carrierInput.label, 60) || CARRIER_LABELS[carrier], zones: sanitizeZones(carrierInput.zones, carrier !== 'dpd'), ...leadOf(carrierInput, carrier) };
  }
  return config;
}

/**
 * Het totale gewicht van de regels van een winkelwagen.
 * @param {{ qty: number, weightGrams: number|null }[]} lines De regels (weightGrams leeg = onbekend).
 * @param {{ defaultWeightGrams: number }} config De instelling.
 * @returns {number} Gewicht in gram.
 */
function weightOf(lines, config) {
  return lines.reduce((sum, line) => sum + line.qty * (line.weightGrams == null ? config.defaultWeightGrams : line.weightGrams), 0);
}

/**
 * Het totale aantal artikelen van een winkelwagen in de basiseenheid (een verpakking telt als haar factor).
 * @param {{ qty: number, stockPer?: number }[]} lines De regels.
 * @returns {number} Het aantal.
 */
function quantityOf(lines) {
  return lines.reduce((sum, line) => sum + line.qty * (line.stockPer || 1), 0);
}

/**
 * De landen waarnaar bezorgd kan worden.
 * @param {object} config De instelling.
 * @returns {{ code: string, name: string }[]} De landen met minstens één weegklasse bij een methode die aan staat (leeg als er alleen afhalen is); elk land één keer.
 */
function countriesOf(config) {
  const countries = [];
  for (const carrier of CARRIERS) {
    if (!config[carrier].enabled) continue;
    for (const zone of config[carrier].zones) {
      if ((zone.tiers.length || (zone.qtyTiers || []).length) && !countries.some((entry) => entry.code === zone.country)) countries.push({ code: zone.country, name: zone.name });
    }
  }
  return countries;
}

/**
 * De optie van één bezorgmethode voor een winkelwagen en een land.
 * @param {string} carrier De methode (dpd, pallet of eigen).
 * @param {object} config De instelling.
 * @param {{ country: string, weightGrams: number, subtotal: number, quantity?: number, blocked?: Object<string, string> }} basket Het land, het gewicht, het bedrag van de artikelen incl. btw, het aantal (basiseenheid) en de methodes die de artikelregels uitsluiten (methode → reden).
 * @returns {object} De optie (zie optionsFor).
 */
function carrierOption(carrier, config, { country, weightGrams, subtotal, quantity = 0, blocked = {} }) {
  const zone = config[carrier].zones.find((entry) => entry.country === country && (entry.tiers.length || (entry.qtyTiers || []).length));
  const option = { method: carrier, label: config[carrier].label, price: 0, free: false, freeFrom: 0, available: false, reason: '', note: '', leadDays: config[carrier].leadDays, dayType: config[carrier].dayType };
  if (blocked[carrier]) option.reason = blocked[carrier];
  else if (!zone) option.reason = 'Bezorging naar dit land is niet mogelijk.';
  else {
    // Een aantalstaffel (pallet, eigen transport) gaat voor de weegklassen.
    const byQuantity = (zone.qtyTiers || []).length > 0;
    const tier = byQuantity ? zone.qtyTiers.find((entry) => quantity <= entry.upToQty) : zone.tiers.find((entry) => weightGrams <= entry.upToGrams);
    if (!tier) option.reason = byQuantity ? `Dit aantal valt buiten de tarieven van deze methode (${config[carrier].label}).` : `Deze bestelling is te zwaar voor deze methode (${config[carrier].label}).`;
    else {
      option.available = true;
      option.freeFrom = zone.freeFrom > 0 ? zone.freeFrom : 0;
      option.free = zone.freeFrom > 0 && subtotal >= zone.freeFrom;
      option.price = option.free ? 0 : tier.price;
      if (zone.freeFrom > 0 && !option.free) option.note = `Gratis bezorging vanaf ${new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(zone.freeFrom)}.`;
    }
  }
  return option;
}

/**
 * De verzendopties voor een winkelwagen en een land, in de volgorde van de keuzelijst: bezorgmethodes die aan staan, afhalen als laatste.
 * @param {object} config De instelling.
 * @param {{ country: string, weightGrams: number, subtotal: number, quantity?: number, blocked?: Object<string, string> }} basket Het land, het gewicht (gram), het bedrag van de artikelen incl. btw, het aantal en de uitgesloten methodes (delivery-rules.js, blockedMethods).
 * @returns {{ method: string, label: string, price: number, free: boolean, freeFrom: number, available: boolean, reason: string, note: string, leadDays: ?object, dayType: string }[]} De opties.
 */
function optionsFor(config, basket) {
  const options = CARRIERS.filter((carrier) => config[carrier].enabled).map((carrier) => carrierOption(carrier, config, basket));
  if (config.pickup.enabled) options.push({ method: 'ophalen', label: config.pickup.label, price: 0, free: true, freeFrom: 0, available: true, reason: '', note: config.pickup.note, leadDays: config.pickup.leadDays, dayType: config.pickup.dayType });
  return options;
}

/**
 * Welke methode de keuzelijst vooraf kiest: de gevraagde als die beschikbaar is, anders de eerste bezorgmethode die kan; afhalen alleen als er niets anders is.
 * @param {{ method: string, available: boolean }[]} options De opties (optionsFor).
 * @param {string} [asked] De methode die de klant al koos.
 * @returns {string} De methode, of leeg als niets beschikbaar is.
 */
function defaultMethod(options, asked = '') {
  const available = options.filter((option) => option.available);
  if (available.some((option) => option.method === asked)) return asked;
  const delivery = available.find((option) => option.method !== 'ophalen');
  return delivery ? delivery.method : available.length ? available[0].method : '';
}

/**
 * Of een postcode bij een land past.
 * @param {string} country Landcode (NL, BE, ...).
 * @param {string} postcode De postcode (hoofdletters).
 * @returns {boolean} true als de postcode geldig lijkt.
 */
function validPostcode(country, postcode) {
  const pattern = POSTCODE_PATTERNS[country];
  return pattern ? pattern.test(postcode) : postcode.length >= 3 && postcode.length <= 10;
}

/**
 * De volgcode (track & trace) van een zending, en de pagina van DPD waar de klant hem volgt.
 * @param {*} raw De ingevoerde volgcode.
 * @returns {{ code: string, url: string }|null} De code met link, of null als er niets (bruikbaars) is ingevuld.
 */
function trackingOf(raw) {
  const code = text(raw, 40).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9-]{6,40}$/.test(code)) return null;
  return { code, url: `https://tracking.dpd.de/status/nl_NL/parcel/${encodeURIComponent(code)}` };
}

module.exports = { sanitizeShipping, weightOf, quantityOf, countriesOf, optionsFor, defaultMethod, METHODS, CARRIERS, validPostcode, trackingOf, SHIPPING_VAT_RATE, DEFAULT_CONFIG, COUNTRY_NAMES };
