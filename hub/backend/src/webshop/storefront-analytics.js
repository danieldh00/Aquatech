// Meting met Google Analytics (GA4) in de webshop, alleen na toestemming van de bezoeker. Zonder toestemming wordt er niets
// van Google geladen (geen script, geen cookie, geen verbinding): de toestemmingsbalk bepaalt alles. Consent Mode v2 staat
// standaard op "geweigerd"; alleen analytics_storage gaat bij Accepteren op "toegestaan", advertentie-opslag nooit.
// De pagina geeft meet-ID, klantgroep en de gebeurtenissen van de pagina mee als data-attributen op <body> (shop-analytics.js);
// kliks (select_item, add_to_cart, remove_from_cart) en het verzenden van het afrekenformulier meet dit script zelf.
// Zonder cookies of opslag in de browser vraagt de balk op elke pagina opnieuw.

/** Sleutel in localStorage voor de keuze van de bezoeker ("granted" of "denied"). */
const CONSENT_KEY = 'aquatech_shop_consent';
/** Sleutel in localStorage voor de bestelnummers waarvoor de aankoop al is doorgegeven (tegen dubbel tellen na een herlading). */
const PURCHASED_KEY = 'aquatech_shop_purchased';
/** Hoeveel bestelnummers `PURCHASED_KEY` onthoudt. */
const PURCHASED_KEEP = 20;
/** Toegestane namen van gebeurtenissen (GA4: letters, cijfers en onderstrepingen). */
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Geeft de opslag van de browser terug, of null als die niet beschikbaar is (privévenster, geblokkeerd).
 * @param {Window} win Het venster.
 * @returns {?Storage} localStorage, of null.
 */
function safeStorage(win) {
  try {
    const storage = win.localStorage;
    storage.getItem(CONSENT_KEY);
    return storage;
  } catch (error) {
    return null;
  }
}

/**
 * Leest de eerder gekozen toestemming.
 * @param {?Storage} storage De opslag van de browser.
 * @returns {?string} "granted", "denied" of null als de bezoeker nog niet koos.
 */
function readConsent(storage) {
  try {
    const value = storage && storage.getItem(CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch (error) {
    return null;
  }
}

/**
 * Bewaart de keuze van de bezoeker; lukt dat niet, dan geldt hij alleen voor deze pagina.
 * @param {?Storage} storage De opslag van de browser.
 * @param {string} decision "granted" of "denied".
 * @returns {void}
 */
function writeConsent(storage, decision) {
  try { if (storage) storage.setItem(CONSENT_KEY, decision); } catch (error) { /* niet bewaren kan; de balk komt dan terug */ }
}

/**
 * Leest de gebeurtenissen die de server in de pagina zette en gooit alles weg wat er niet uitziet als een gebeurtenis.
 * @param {?string} text De JSON uit data-shop-events.
 * @returns {{ name: string, params: object }[]} De bruikbare gebeurtenissen.
 */
function parseEvents(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((event) => event && typeof event.name === 'string' && EVENT_NAME_PATTERN.test(event.name) && event.params && typeof event.params === 'object' && !Array.isArray(event.params)) : [];
  } catch (error) {
    return [];
  }
}

/**
 * Laat de bestelnummers weg waarvoor de aankoop al is doorgegeven en onthoudt de nieuwe.
 * @param {?Storage} storage De opslag van de browser.
 * @param {{ name: string, params: object }[]} events De te versturen gebeurtenissen.
 * @returns {{ name: string, params: object }[]} De gebeurtenissen zonder dubbele aankopen.
 */
function withoutRepeatedPurchases(storage, events) {
  let known = [];
  try { known = JSON.parse((storage && storage.getItem(PURCHASED_KEY)) || '[]'); } catch (error) { known = []; }
  if (!Array.isArray(known)) known = [];
  const fresh = [];
  for (const event of events) {
    if (event.name !== 'purchase') { fresh.push(event); continue; }
    const id = String(event.params.transaction_id || '');
    if (!id || known.includes(id)) continue;
    known.push(id);
    fresh.push(event);
  }
  try { if (storage) storage.setItem(PURCHASED_KEY, JSON.stringify(known.slice(-PURCHASED_KEEP))); } catch (error) { /* niet bewaren kan */ }
  return fresh;
}

/**
 * Het artikel van een bestelformulier: de gegevens van de server, met de nu gekozen uitvoering en het gekozen aantal.
 * @param {HTMLFormElement} form Een formulier met data-item (productkaart of productpagina).
 * @returns {?{ item: object, quantity: number }} Het artikel (met aantal) en het aantal, of null als het formulier geen artikel bevat.
 */
function itemFromForm(form) {
  let item;
  try { item = JSON.parse(form.getAttribute('data-item')); } catch (error) { return null; }
  if (!item || typeof item !== 'object') return null;
  const codeField = form.querySelector('[data-order-code]');
  if (codeField && codeField.value) item.item_id = codeField.value;
  const card = form.closest('[data-variant-row]');
  const select = card && card.querySelector('[data-variant-select]');
  const option = select && select.options[select.selectedIndex];
  if (option) {
    const price = Number(option.getAttribute('data-value'));
    if (Number.isFinite(price)) item.price = price;
    if (option.getAttribute('data-label')) item.item_variant = option.getAttribute('data-label');
  }
  const amount = form.querySelector('input[name="qty"]');
  const quantity = Math.max(1, Math.floor(Number(amount && amount.value)) || 1);
  item.quantity = quantity;
  return { item, quantity };
}

/**
 * Bouwt de gtag-functie: zet alle aanroepen in de dataLayer, zoals Google het verwacht (het object arguments, geen lijst).
 * @param {Window} win Het venster.
 * @returns {Function} De functie gtag(...).
 */
function createGtag(win) {
  win.dataLayer = win.dataLayer || [];
  return function gtag() { win.dataLayer.push(arguments); };
}

/**
 * De meting van deze pagina: houdt bij of er toestemming is, laadt Google pas na Accepteren en verstuurt gebeurtenissen.
 * @param {{ window: Window, document: Document, storage: ?Storage, measurementId: string, customerGroup: string, internal: boolean }} environment De browseromgeving en de instellingen van de pagina.
 * @returns {{ grant: Function, deny: Function, track: Function, isGranted: Function, isLoaded: Function }} De bediening.
 */
function createTracker({ window: win, document: doc, storage, measurementId, customerGroup, internal }) {
  const gtag = createGtag(win);
  let granted = false;
  let loaded = false;
  // Consent Mode v2: alles geweigerd tot de bezoeker kiest. Dit zet alleen een regel in de dataLayer; er wordt niets geladen.
  gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied', wait_for_update: 500 });

  /**
   * Laadt het Google-script (één keer) en stelt de meting in zonder advertentiefuncties.
   * @returns {void}
   */
  function load() {
    if (loaded) return;
    loaded = true;
    const script = doc.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    doc.head.appendChild(script);
    gtag('js', new Date());
    gtag('set', 'user_properties', { customer_group: customerGroup });
    const config = { allow_google_signals: false, allow_ad_personalization_signals: false };
    if (internal) config.traffic_type = 'internal';
    gtag('config', measurementId, config);
  }

  /**
   * Verwijdert de cookies van Google Analytics (_ga en _ga_*) van deze site, op alle paden en de bovenliggende domeinen.
   * @returns {void}
   */
  function clearCookies() {
    const names = String(doc.cookie || '').split(';').map((part) => part.split('=')[0].trim()).filter((name) => name === '_ga' || name.indexOf('_ga_') === 0);
    const host = (win.location && win.location.hostname) || '';
    const domains = ['', host, `.${host}`];
    for (const name of names) for (const domain of domains) doc.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain ? `; domain=${domain}` : ''}`;
  }

  return {
    /**
     * De bezoeker staat meten toe: Google laden (alleen analytics_storage) en de meting starten.
     * @returns {void}
     */
    grant() {
      granted = true;
      win[`ga-disable-${measurementId}`] = false;
      gtag('consent', 'update', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
      load();
    },
    /**
     * De bezoeker weigert of trekt de toestemming in: niets meer sturen en de cookies van Google weghalen.
     * @returns {void}
     */
    deny() {
      granted = false;
      if (loaded) {
        win[`ga-disable-${measurementId}`] = true;
        gtag('consent', 'update', { analytics_storage: 'denied' });
        clearCookies();
      }
    },
    /**
     * Verstuurt een gebeurtenis, alleen met toestemming.
     * @param {string} name De GA4-naam, bijvoorbeeld "add_to_cart".
     * @param {object} params De velden van de gebeurtenis.
     * @returns {boolean} true als de gebeurtenis is doorgegeven.
     */
    track(name, params) {
      if (!granted || !loaded || !EVENT_NAME_PATTERN.test(name)) return false;
      gtag('event', name, params || {});
      return true;
    },
    /**
     * Of de bezoeker op dit moment toestemming heeft gegeven.
     * @returns {boolean} true zolang de bezoeker toestemming gaf.
     */
    isGranted() { return granted; },
    /**
     * Of het Google-script is gevraagd (alleen na toestemming).
     * @returns {boolean} true als het Google-script is gevraagd.
     */
    isLoaded() { return loaded; },
  };
}

/**
 * Bouwt of toont de toestemmingsbalk. Accepteren en Weigeren zijn even duidelijk (zelfde knopstijl).
 * @param {Document} doc Het document.
 * @param {{ privacyUrl: string, onChoice: Function }} options Het adres van de privacyverklaring en wat er bij een keuze gebeurt.
 * @returns {void}
 */
function showConsentBanner(doc, { privacyUrl, onChoice }) {
  const existing = doc.querySelector('[data-consent-banner]');
  if (existing) existing.remove();
  const banner = doc.createElement('section');
  banner.className = 'consent-banner';
  banner.setAttribute('data-consent-banner', '');
  banner.setAttribute('aria-label', 'Cookies en meten');
  const text = doc.createElement('p');
  text.appendChild(doc.createTextNode('We willen graag anoniem meten hoe de webshop wordt gebruikt, met Google Analytics, om de shop te verbeteren. Dat gebeurt alleen met jouw toestemming; zonder toestemming plaatsen we geen meetcookies. '));
  const link = doc.createElement('a');
  link.setAttribute('href', privacyUrl);
  link.textContent = 'Lees de privacyverklaring';
  text.appendChild(link);
  banner.appendChild(text);
  const actions = doc.createElement('div');
  actions.className = 'consent-actions';
  for (const [label, decision] of [['Accepteren', 'granted'], ['Weigeren', 'denied']]) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'button';
    button.textContent = label;
    button.addEventListener('click', () => { banner.remove(); onChoice(decision); });
    actions.appendChild(button);
  }
  banner.appendChild(actions);
  doc.body.appendChild(banner);
}

/**
 * Start de meting op deze pagina: toestemming lezen, de balk tonen als de bezoeker nog niet koos, gebeurtenissen van de
 * pagina versturen en kliks en formulieren volgen.
 * @param {{ window: Window, document: Document, storage: ?Storage }} environment De browseromgeving.
 * @returns {?object} De bediening van de meting, of null als de pagina geen meting vraagt (geen data-shop-analytics).
 */
function startAnalytics({ window: win, document: doc, storage }) {
  const body = doc.body;
  const measurementId = body && body.getAttribute('data-shop-analytics');
  if (!measurementId) return null;
  const tracker = createTracker({ window: win, document: doc, storage, measurementId, customerGroup: body.getAttribute('data-customer-group') || 'particulier', internal: body.getAttribute('data-internal') === '1' });
  const pageEvents = parseEvents(body.getAttribute('data-shop-events'));
  const listItems = new Map();
  const cartItems = new Map();
  let checkoutEvent = null;
  for (const event of pageEvents) {
    const items = Array.isArray(event.params.items) ? event.params.items : [];
    if (event.name === 'view_item_list') for (const item of items) listItems.set(item.item_id, item);
    if (event.name === 'view_cart') for (const item of items) cartItems.set(item.item_id, item);
    if (event.name === 'begin_checkout') checkoutEvent = event;
  }
  let pageEventsSent = false;

  /**
   * Verstuurt de gebeurtenissen van deze pagina, één keer.
   * @returns {void}
   */
  function sendPageEvents() {
    if (pageEventsSent) return;
    pageEventsSent = true;
    for (const event of withoutRepeatedPurchases(storage, pageEvents)) tracker.track(event.name, event.params);
  }

  /**
   * Verwerkt een keuze van de bezoeker: bewaren, de meting aan- of uitzetten en bij toestemming de gebeurtenissen sturen.
   * @param {string} decision "granted" of "denied".
   * @returns {void}
   */
  function choose(decision) {
    writeConsent(storage, decision);
    if (decision === 'granted') { tracker.grant(); sendPageEvents(); } else tracker.deny();
  }

  /**
   * Toont de balk, met het adres van de privacyverklaring uit de pagina.
   * @returns {void}
   */
  function askConsent() {
    showConsentBanner(doc, { privacyUrl: body.getAttribute('data-privacy-url') || '#', onChoice: choose });
  }

  const earlier = readConsent(storage);
  if (earlier === 'granted') { tracker.grant(); sendPageEvents(); } else if (earlier === null) askConsent();

  doc.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    if (target.closest('[data-consent-settings]')) { askConsent(); return; }
    const link = target.closest('.product-card a.product-name, .product-card a.product-image');
    if (!link) return;
    const form = link.closest('.product-card').querySelector('form[data-item]');
    const read = form ? itemFromForm(form) : null;
    if (!read) return;
    const listed = listItems.get(read.item.item_id);
    const item = { ...read.item, ...(listed ? { item_list_name: listed.item_list_name, index: listed.index } : {}) };
    delete item.quantity;
    tracker.track('select_item', { item_list_name: item.item_list_name, items: [item] });
  });

  doc.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form || !form.closest) return;
    const action = form.querySelector('input[name="action"]');
    if (form.hasAttribute('data-item') && action && action.value === 'add') {
      const read = itemFromForm(form);
      if (read) tracker.track('add_to_cart', { currency: 'EUR', value: Math.round((read.item.price || 0) * read.quantity * 100) / 100, placement: form.classList.contains('product-order') ? 'productpagina' : 'kaart', items: [read.item], transport_type: 'beacon' });
    } else if (action && action.value === 'remove') {
      const code = form.querySelector('input[name="code"]');
      const known = code && cartItems.get(code.value);
      if (known) tracker.track('remove_from_cart', { currency: 'EUR', value: Math.round((known.price || 0) * (known.quantity || 1) * 100) / 100, items: [known], transport_type: 'beacon' });
    } else if (form.hasAttribute('data-shop-checkout') && checkoutEvent) {
      const shipping = form.querySelector('[name="shippingMethod"]');
      const payment = form.querySelector('input[name="paymentMethod"]:checked') || form.querySelector('input[name="paymentMethod"]');
      const base = { currency: 'EUR', value: checkoutEvent.params.value, items: checkoutEvent.params.items };
      if (shipping && shipping.value) tracker.track('add_shipping_info', { ...base, shipping_tier: shipping.value, transport_type: 'beacon' });
      if (payment && payment.value) tracker.track('add_payment_info', { ...base, payment_type: payment.value, transport_type: 'beacon' });
    }
  });
  return tracker;
}

if (typeof document !== 'undefined' && document.body) startAnalytics({ window, document, storage: safeStorage(window) });
