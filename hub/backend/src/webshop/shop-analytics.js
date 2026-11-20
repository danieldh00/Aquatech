// Google Analytics (GA4) en Microsoft Clarity voor de webshop: de instellingen `shopAnalytics` (aan/uit en meet-ID) en `shopClarity` (aan/uit en project-ID), de uitgebreide
// Content-Security-Policy en de gebeurtenissen van de koopfunnel (view_item, add_to_cart, begin_checkout, purchase, ...).
// De server zet alleen gegevens in de pagina; het script `analytiek.js` laadt Google pas na toestemming van de bezoeker
// (Consent Mode v2, standaard geweigerd). Zonder geldig meet-ID of met de instelling uit staat er niets van dit alles in de pagina.

/** Een GA4-meet-ID: "G-" met 4 tot 14 hoofdletters of cijfers. */
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,14}$/;

/** Een Microsoft Clarity-project-ID: 6 tot 16 kleine letters of cijfers (bijv. "abcde1fgh2"). */
const CLARITY_ID_PATTERN = /^[a-z0-9]{6,16}$/;

/** Het hoogste aantal artikelen in één gebeurtenis (de rest valt weg; Google verwerkt er toch maar 200). */
const MAX_EVENT_ITEMS = 50;

/**
 * Maakt van een ingetikt meet-ID een schone waarde.
 * @param {*} raw Wat de beheerder invulde.
 * @returns {string} Het ID in hoofdletters (bijv. "G-ABC123XYZ"), of leeg als het geen geldig GA4-meet-ID is.
 */
function cleanMeasurementId(raw) {
  const id = String(raw == null ? '' : raw).trim().toUpperCase();
  return MEASUREMENT_ID_PATTERN.test(id) ? id : '';
}

/**
 * Saneert de instelling `shopAnalytics`. Lege of onbruikbare invoer geeft de standaard (uit, geen ID).
 * @param {*} raw De ingevoerde instelling.
 * @returns {{ enabled: boolean, measurementId: string }} De gesaneerde instelling.
 */
function sanitizeAnalytics(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { enabled: input.enabled === true, measurementId: cleanMeasurementId(input.measurementId) };
}

/**
 * Het meet-ID dat de shop mag gebruiken: alleen als de instelling aan staat én het ID geldig is.
 * @param {*} setting De opgeslagen instelling `shopAnalytics`.
 * @returns {string} Het meet-ID, of leeg als er niet gemeten mag worden.
 */
function activeMeasurementId(setting) {
  const clean = sanitizeAnalytics(setting);
  return clean.enabled ? clean.measurementId : '';
}

/**
 * Maakt van een ingetikt Clarity-project-ID een schone waarde.
 * @param {*} raw Wat de beheerder invulde.
 * @returns {string} Het ID in kleine letters, of leeg als het geen geldig project-ID is.
 */
function cleanClarityId(raw) {
  const id = String(raw == null ? '' : raw).trim().toLowerCase();
  return CLARITY_ID_PATTERN.test(id) ? id : '';
}

/**
 * Saneert de instelling `shopClarity`. Lege of onbruikbare invoer geeft de standaard (uit, geen ID).
 * @param {*} raw De ingevoerde instelling.
 * @returns {{ enabled: boolean, projectId: string }} De gesaneerde instelling.
 */
function sanitizeClarity(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { enabled: input.enabled === true, projectId: cleanClarityId(input.projectId) };
}

/**
 * Het Clarity-project dat de shop mag gebruiken: alleen als de instelling aan staat én het ID geldig is.
 * @param {*} setting De opgeslagen instelling `shopClarity`.
 * @returns {string} Het project-ID, of leeg als Clarity niet mag laden.
 */
function activeClarityId(setting) {
  const clean = sanitizeClarity(setting);
  return clean.enabled ? clean.projectId : '';
}

/**
 * De Content-Security-Policy van de shop, met de adressen van Google Analytics en/of Microsoft Clarity erbij zodra
 * die actief zijn. Zonder beide blijft de policy exact zoals hij was. Er komen geen inline scripts bij.
 * @param {string} baseCsp De standaardpolicy van de shop.
 * @param {string} measurementId Het actieve GA4-meet-ID (leeg = niet meten).
 * @param {string} [clarityId] Het actieve Clarity-project-ID (leeg = geen Clarity).
 * @returns {string} De policy voor dit verzoek.
 */
function cspWith(baseCsp, measurementId, clarityId = '') {
  if (!measurementId && !clarityId) return baseCsp;
  const additions = { 'script-src': [], 'connect-src': [] };
  if (measurementId) {
    additions['script-src'].push('https://www.googletagmanager.com');
    additions['connect-src'].push('https://www.googletagmanager.com', 'https://*.google-analytics.com', 'https://*.analytics.google.com');
  }
  if (clarityId) {
    additions['script-src'].push('https://www.clarity.ms', 'https://scripts.clarity.ms');
    additions['connect-src'].push('https://*.clarity.ms', 'https://c.bing.com');
  }
  const directives = baseCsp.split('; ').map((directive) => {
    const [name] = directive.split(' ');
    return additions[name] && additions[name].length ? `${directive} ${additions[name].join(' ')}` : directive;
  });
  // Clarity maakt voor het opnemen een werker uit een blob; zonder worker-src zou default-src 'none' die blokkeren.
  if (clarityId) directives.push('worker-src blob:');
  return directives.join('; ');
}

/**
 * Rondt een bedrag af op centen voor een gebeurtenis.
 * @param {*} amount Het bedrag.
 * @returns {number} Het bedrag met twee decimalen, 0 bij onzin.
 */
function money(amount) {
  const number = Number(amount);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

/**
 * Een artikel zoals GA4 het wil: artikelcode als item_id, nooit persoonsgegevens.
 * @param {{ id: string, name: string, category?: string, variant?: string, price?: number, quantity?: number, listName?: string, index?: number, pack?: string }} source Het artikel.
 * @returns {object} Het GA4-artikel (lege velden weggelaten).
 */
function itemOf(source) {
  const item = { item_id: String(source.id || '').slice(0, 100), item_name: String(source.name || '').slice(0, 100) };
  if (source.category) item.item_category = String(source.category).slice(0, 100);
  if (source.variant) item.item_variant = String(source.variant).slice(0, 100);
  if (source.price !== undefined) item.price = money(source.price);
  if (source.quantity !== undefined) item.quantity = Math.max(1, Math.floor(Number(source.quantity)) || 1);
  if (source.listName) item.item_list_name = String(source.listName).slice(0, 100);
  if (source.index !== undefined) item.index = Math.max(0, Math.floor(Number(source.index)) || 0);
  return item;
}

/**
 * Een catalogusproduct als GA4-artikel.
 * @param {object} product Een product of variant uit de catalogus (code, name, categoryName).
 * @param {number} price De getoonde prijs (incl. btw, of excl. voor een zakelijke klant).
 * @param {{ listName?: string, index?: number, quantity?: number, variant?: string }} [extra] Lijstnaam, plek in de lijst, aantal en de variant.
 * @returns {object} Het GA4-artikel.
 */
function itemOfProduct(product, price, extra = {}) {
  return itemOf({ id: product.code, name: product.name, category: product.categoryName, price, ...extra });
}

/**
 * De gebeurtenis bij een lijst met producten (categorie, groep of zoekresultaat): view_item_list, bij een zoekopdracht
 * ook view_search_results en bij nul resultaten search_no_results.
 * @param {{ listName: string, items: object[], searchTerm?: string, resultCount?: number }} input De lijst en eventueel de zoekopdracht.
 * @returns {object[]} De gebeurtenissen ({ name, params }).
 */
function listEvents({ listName, items, searchTerm = '', resultCount = items.length }) {
  const events = [];
  if (searchTerm) {
    const term = String(searchTerm).slice(0, 80);
    events.push({ name: 'view_search_results', params: { search_term: term, result_count: resultCount } });
    if (!resultCount) events.push({ name: 'search_no_results', params: { search_term: term } });
  }
  if (items.length) events.push({ name: 'view_item_list', params: { item_list_id: listName.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60), item_list_name: listName.slice(0, 100), items: items.slice(0, MAX_EVENT_ITEMS) } });
  return events;
}

/**
 * De gebeurtenis voor het bekijken van één product.
 * @param {object} item Het GA4-artikel.
 * @param {{ inStock: boolean }} stock De voorraadstand van het getoonde artikel.
 * @returns {object[]} De gebeurtenissen.
 */
function viewItemEvents(item, { inStock }) {
  return [{ name: 'view_item', params: { currency: 'EUR', value: item.price || 0, in_stock: inStock ? 'ja' : 'nee', items: [item] } }];
}

/**
 * De gebeurtenissen voor de winkelwagen: view_cart, en na "in winkelwagen" vanuit de planner ook planner_to_cart.
 * @param {{ items: object[], value: number, fromPlanner?: number }} input Artikelen, totaalbedrag en het aantal artikelen uit de planner.
 * @returns {object[]} De gebeurtenissen.
 */
function cartEvents({ items, value, fromPlanner = 0 }) {
  const events = [];
  if (fromPlanner > 0) events.push({ name: 'planner_to_cart', params: { item_count: fromPlanner } });
  if (items.length) events.push({ name: 'view_cart', params: { currency: 'EUR', value: money(value), items: items.slice(0, MAX_EVENT_ITEMS) } });
  return events;
}

/**
 * De gebeurtenissen voor afrekenen: begin_checkout, en bij de loginmuur ook checkout_login_wall; een foutmelding in het
 * formulier is alleen checkout_error.
 * @param {{ items: object[], value: number, loggedIn: boolean, guestForm?: boolean, error?: string }} input Artikelen, totaalbedrag, inlogstatus, of dit het afrekenformulier voor een gast (zonder account) is en de melding.
 * @returns {object[]} De gebeurtenissen.
 */
function checkoutEvents({ items, value, loggedIn, guestForm = false, error = '' }) {
  // Na een fout toont de server het formulier opnieuw: dat is geen nieuw begin van het afrekenen.
  if (error) return [{ name: 'checkout_error', params: { type: errorTypeOf(error) } }];
  // De keuze om als gast te bestellen (op de loginmuur) is al begin_checkout geweest; het formulier meldt alleen de keuze.
  if (guestForm) return [{ name: 'checkout_guest', params: { currency: 'EUR', value: money(value) } }];
  const events = [{ name: 'begin_checkout', params: { currency: 'EUR', value: money(value), login_status: loggedIn ? 'ingelogd' : 'gast', items: items.slice(0, MAX_EVENT_ITEMS) } }];
  if (!loggedIn) events.push({ name: 'checkout_login_wall', params: {} });
  return events;
}

/**
 * Het soort fout in afrekenen, zonder de tekst zelf (die kan een adres of naam bevatten).
 * @param {string} message De foutmelding uit het afrekenformulier.
 * @returns {string} stock, total_changed, address_not_found, vat_invalid, terms of other.
 */
function errorTypeOf(message) {
  const text = String(message || '').toLowerCase();
  if (/voorraad|beschikbaar/.test(text)) return 'stock';
  if (/totaal|prijs.*gewijzigd|bedrag/.test(text)) return 'total_changed';
  if (/adres|postcode|huisnummer/.test(text)) return 'address_not_found';
  if (/btw/.test(text)) return 'vat_invalid';
  if (/voorwaarden/.test(text)) return 'terms';
  return 'other';
}

/**
 * De gebeurtenis voor een geplaatste en (bij online betalen) betaalde bestelling. De pagina vermeldt het bestelnummer als
 * transaction_id, zodat Google en `analytiek.js` een herlading niet dubbel tellen.
 * @param {{ number: string, total: number, tax: number, shipping: number, items: object[], payment: string, guest?: boolean }} order De bestelling (guest = besteld zonder account).
 * @returns {object[]} De gebeurtenissen.
 */
function purchaseEvents(order) {
  return [{ name: 'purchase', params: { transaction_id: String(order.number).slice(0, 60), currency: 'EUR', value: money(order.total), tax: money(order.tax), shipping: money(order.shipping), payment_type: order.payment === 'online' ? 'online' : 'rekening', checkout_type: order.guest ? 'gast' : 'account', items: order.items.slice(0, MAX_EVENT_ITEMS) } }];
}

/**
 * De JSON van gebeurtenissen voor in een HTML-attribuut (data-shop-events); de pagina ontsnapt het nog met escapeHtml.
 * @param {object[]} events De gebeurtenissen.
 * @returns {string} JSON, of leeg zonder gebeurtenissen.
 */
function eventsJson(events) {
  return events && events.length ? JSON.stringify(events) : '';
}

module.exports = { MEASUREMENT_ID_PATTERN, cleanMeasurementId, sanitizeAnalytics, activeMeasurementId, CLARITY_ID_PATTERN, cleanClarityId, sanitizeClarity, activeClarityId, cspWith, itemOf, itemOfProduct, listEvents, viewItemEvents, cartEvents, checkoutEvents, errorTypeOf, purchaseEvents, eventsJson, money };
