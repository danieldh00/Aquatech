// Metingen in de webshop (Google Analytics GA4 en Microsoft Clarity), alleen na toestemming van de bezoeker voor de categorie
// Analytisch. Zonder toestemming wordt er niets van die diensten geladen (geen script, geen cookie, geen verbinding): de
// toestemmingsbalk bepaalt alles. De keuze wordt met datum en versie van de tekst bewaard en is altijd te wijzigen of in te trekken. Consent Mode v2 staat
// standaard op "geweigerd"; alleen analytics_storage gaat bij Accepteren op "toegestaan", advertentie-opslag nooit.
// De pagina geeft meet-ID, klantgroep en de gebeurtenissen van de pagina mee als data-attributen op <body> (shop-analytics.js);
// kliks (select_item, add_to_cart, remove_from_cart) en het verzenden van het afrekenformulier meet dit script zelf.
// Zonder cookies of opslag in de browser vraagt de balk op elke pagina opnieuw.
// Let op (besluit Daniël 2026-11-20): in het instellingenvenster staat Analytisch vooraf aan zolang er geen eerdere keuze is; er wordt pas iets
// geladen na een klik. Een vooraf aangevinkt vakje is volgens de AVG (Planet49) geen geldige toestemming: opnieuw beoordelen vóór go-live.

/** Sleutel in localStorage voor de keuze van de bezoeker (JSON met versie, keuze en datum). */
const CONSENT_KEY = 'aquatech_shop_consent';
/** Versie van de toestemmingstekst en de categorieën; een andere versie in de opslag telt als geen keuze en vraagt opnieuw. */
const CONSENT_VERSION = 1;
/** Cookies van Clarity (eigen domein) die bij weigeren of intrekken worden gewist. */
const CLARITY_COOKIES = ['_clck', '_clsk', 'CLID', 'ANONCHK', 'MR', 'SM', 'MUID'];
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
 * Leest de eerder vastgelegde keuze met de datum waarop die is gemaakt.
 * @param {?Storage} storage De opslag van de browser.
 * @returns {?{ decision: string, at: string }} De keuze ("granted" of "denied") en het tijdstip (ISO), of null als de bezoeker nog niet koos of de versie niet meer klopt.
 */
function readConsentRecord(storage) {
  try {
    const parsed = JSON.parse((storage && storage.getItem(CONSENT_KEY)) || 'null');
    if (!parsed || parsed.v !== CONSENT_VERSION || typeof parsed.analytics !== 'boolean') return null;
    return { decision: parsed.analytics ? 'granted' : 'denied', at: typeof parsed.at === 'string' ? parsed.at : '' };
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
  const record = readConsentRecord(storage);
  return record ? record.decision : null;
}

/**
 * Legt de keuze van de bezoeker vast met versie en datum; lukt dat niet, dan geldt hij alleen voor deze pagina.
 * @param {?Storage} storage De opslag van de browser.
 * @param {string} decision "granted" of "denied".
 * @returns {void}
 */
function writeConsent(storage, decision) {
  try { if (storage) storage.setItem(CONSENT_KEY, JSON.stringify({ v: CONSENT_VERSION, analytics: decision === 'granted', at: new Date().toISOString() })); } catch (error) { /* niet bewaren kan; de balk komt dan terug */ }
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
  const card = form.closest('[data-sub-item-row]');
  const select = card && card.querySelector('[data-sub-item-select]');
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
 * Wist cookies van deze site waarvan de naam bij de test past, op alle paden en de bovenliggende domeinen.
 * @param {Window} win Het venster.
 * @param {Document} doc Het document.
 * @param {Function} matches Krijgt een cookienaam en geeft terug of die gewist moet worden.
 * @returns {void}
 */
function clearCookiesWhere(win, doc, matches) {
  const names = String(doc.cookie || '').split(';').map((part) => part.split('=')[0].trim()).filter((name) => name && matches(name));
  const host = (win.location && win.location.hostname) || '';
  const domains = ['', host, `.${host}`];
  for (const name of names) for (const domain of domains) doc.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain ? `; domain=${domain}` : ''}`;
}

/**
 * Microsoft Clarity: het script wordt pas bij toestemming geladen; invoervelden en formulieren worden gemaskeerd.
 * Bij weigeren of intrekken wordt Clarity gestopt en worden de cookies gewist.
 * @param {{ window: Window, document: Document, projectId: string }} environment De browseromgeving en het project-ID.
 * @returns {{ grant: Function, deny: Function, isLoaded: Function }} De bediening.
 */
function createClarity({ window: win, document: doc, projectId }) {
  let loaded = false;
  let watching = false;

  /**
   * Zet de wachtrij van Clarity klaar (zoals het standaardscript doet) en laadt het script één keer.
   * @returns {void}
   */
  function load() {
    if (loaded) return;
    loaded = true;
    win.clarity = win.clarity || function clarity() { (win.clarity.q = win.clarity.q || []).push(arguments); };
    const script = doc.createElement('script');
    script.async = true;
    script.src = `https://www.clarity.ms/tag/${encodeURIComponent(projectId)}`;
    doc.head.appendChild(script);
  }

  /**
   * Zet alle invoervelden en formulieren op gemaskeerd, zodat Clarity nooit wat iemand typt opneemt.
   * @returns {void}
   */
  function maskInputs() {
    if (!doc.querySelectorAll) return;
    for (const element of doc.querySelectorAll('input, textarea, select, form')) element.setAttribute('data-clarity-mask', 'True');
  }

  /**
   * Maskeert ook velden die later in de pagina komen (bijvoorbeeld het adres van de postcodezoeker of een bijgewerkt formulier).
   * @returns {void}
   */
  function watchNewInputs() {
    if (watching || typeof win.MutationObserver !== 'function' || !doc.body) return;
    watching = true;
    new win.MutationObserver(maskInputs).observe(doc.body, { childList: true, subtree: true });
  }

  return {
    /**
     * De bezoeker staat meten toe: Clarity laden (alleen analytische opslag, nooit advertenties) en de velden maskeren.
     * @returns {void}
     */
    grant() {
      maskInputs();
      watchNewInputs();
      load();
      win.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' });
    },
    /**
     * De bezoeker weigert of trekt in: Clarity stoppen en de cookies wissen.
     * @returns {void}
     */
    deny() {
      if (loaded) {
        win.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' });
        win.clarity('stop');
      }
      clearCookiesWhere(win, doc, (name) => CLARITY_COOKIES.includes(name));
    },
    /**
     * Of het Clarity-script is gevraagd (alleen na toestemming).
     * @returns {boolean} true als het script is gevraagd.
     */
    isLoaded() { return loaded; },
  };
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
    clearCookiesWhere(win, doc, (name) => name === '_ga' || name.indexOf('_ga_') === 0);
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
 * Maakt een element met een klasse en tekst.
 * @param {Document} doc Het document.
 * @param {string} tag De tagnaam.
 * @param {string} className De klasse (leeg = geen).
 * @param {string} text De tekst (leeg = geen).
 * @returns {Element} Het nieuwe element.
 */
function makeElement(doc, tag, className, text) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

/**
 * Maakt een knop. Accepteren en Weigeren krijgen dezelfde stijl en grootte (gelijkwaardig); Instellingen is een tekstlink.
 * @param {Document} doc Het document.
 * @param {string} label Het opschrift.
 * @param {string} className De klasse(n) van de knop.
 * @param {Function} onClick Wat er bij een klik gebeurt.
 * @returns {Element} De knop.
 */
function makeButton(doc, label, className, onClick) {
  const button = makeElement(doc, 'button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

/**
 * Toont het instellingenvenster: Noodzakelijk (altijd aan) en Analytisch (aan of uit; vooraf aan zolang er geen eerdere keuze is), met de datum van de vorige keuze.
 * @param {Document} doc Het document.
 * @param {{ privacyUrl: string, current: ?{ decision: string, at: string }, onChoice: Function }} options De privacyverklaring, de huidige keuze en wat er bij een keuze gebeurt.
 * @returns {void}
 */
function showConsentSettings(doc, { privacyUrl, current, onChoice }) {
  const existing = doc.querySelector('[data-consent-settings-dialog]');
  if (existing) existing.remove();
  const overlay = makeElement(doc, 'div', 'consent-overlay');
  overlay.setAttribute('data-consent-settings-dialog', '');
  const dialog = makeElement(doc, 'div', 'consent-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'consent-dialog-title');
  const title = makeElement(doc, 'h2', '', 'Cookie-instellingen');
  title.id = 'consent-dialog-title';
  dialog.appendChild(title);
  dialog.appendChild(makeElement(doc, 'p', 'consent-lead', 'Kies zelf welke cookies we mogen gebruiken. Je kunt dit altijd wijzigen via Cookie-instellingen onderaan de pagina.'));

  const necessary = makeElement(doc, 'div', 'consent-category');
  const necessaryText = makeElement(doc, 'div', 'consent-category-text');
  necessaryText.appendChild(makeElement(doc, 'strong', '', 'Noodzakelijk'));
  necessaryText.appendChild(makeElement(doc, 'span', '', 'Winkelwagen, inloggen en veiligheid. Altijd aan, hier is geen toestemming voor nodig.'));
  necessary.appendChild(necessaryText);
  necessary.appendChild(makeElement(doc, 'span', 'consent-always', 'Altijd aan'));
  dialog.appendChild(necessary);

  const analytical = makeElement(doc, 'label', 'consent-category');
  const analyticalText = makeElement(doc, 'div', 'consent-category-text');
  analyticalText.appendChild(makeElement(doc, 'strong', '', 'Analytisch'));
  analyticalText.appendChild(makeElement(doc, 'span', '', 'Anonieme statistieken en schermopnames om de webshop te verbeteren. Invoervelden worden gemaskeerd.'));
  analytical.appendChild(analyticalText);
  const toggle = makeElement(doc, 'input', 'consent-toggle');
  toggle.type = 'checkbox';
  toggle.setAttribute('data-consent-analytics', '');
  // Besluit Daniël 2026-11-20: zonder eerdere keuze staat Analytisch vooraf aangevinkt; een eerdere keuze blijft zoals bezoekers die kozen.
  toggle.checked = current ? current.decision === 'granted' : true;
  analytical.appendChild(toggle);
  dialog.appendChild(analytical);

  const note = makeElement(doc, 'p', 'consent-note');
  if (current && current.at) note.appendChild(doc.createTextNode(`Je keuze is opgeslagen op ${current.at.slice(0, 10).split('-').reverse().join('-')}. `));
  const link = makeElement(doc, 'a', '', 'Privacyverklaring');
  link.setAttribute('href', privacyUrl);
  note.appendChild(link);
  dialog.appendChild(note);

  const actions = makeElement(doc, 'div', 'consent-actions');
  /**
   * Verwerkt de keuze: venster en balk sluiten en de keuze doorgeven.
   * @param {string} decision "granted" of "denied".
   * @returns {void}
   */
  const choose = (decision) => { overlay.remove(); const banner = doc.querySelector('[data-consent-banner]'); if (banner) banner.remove(); onChoice(decision); };
  actions.appendChild(makeButton(doc, 'Alles accepteren', 'button', () => choose('granted')));
  actions.appendChild(makeButton(doc, 'Alles weigeren', 'button', () => choose('denied')));
  actions.appendChild(makeButton(doc, 'Keuze opslaan', 'button', () => choose(toggle.checked ? 'granted' : 'denied')));
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') overlay.remove(); });
  doc.body.appendChild(overlay);
  if (toggle.focus) toggle.focus();
}

/**
 * Bouwt of toont de toestemmingsbalk. Accepteren en Weigeren zijn even duidelijk (zelfde knopstijl); Instellingen opent het venster per categorie.
 * @param {Document} doc Het document.
 * @param {{ privacyUrl: string, current: ?{ decision: string, at: string }, onChoice: Function }} options Het adres van de privacyverklaring, de huidige keuze en wat er bij een keuze gebeurt.
 * @returns {void}
 */
function showConsentBanner(doc, { privacyUrl, current, onChoice }) {
  const existing = doc.querySelector('[data-consent-banner]');
  if (existing) existing.remove();
  const banner = makeElement(doc, 'section', 'consent-banner');
  banner.setAttribute('data-consent-banner', '');
  banner.setAttribute('aria-label', 'Cookies');
  const text = makeElement(doc, 'div', 'consent-text');
  text.appendChild(makeElement(doc, 'h2', '', 'Cookies op AquaTech Shop'));
  const paragraph = makeElement(doc, 'p', '');
  paragraph.appendChild(doc.createTextNode('We gebruiken noodzakelijke cookies voor je winkelwagen en inloggen. Met jouw toestemming meten we ook anoniem hoe de webshop wordt gebruikt om hem te verbeteren. '));
  const link = makeElement(doc, 'a', '', 'Privacyverklaring');
  link.setAttribute('href', privacyUrl);
  paragraph.appendChild(link);
  text.appendChild(paragraph);
  banner.appendChild(text);
  const actions = makeElement(doc, 'div', 'consent-actions');
  /**
   * Verwerkt de keuze: de balk sluiten en de keuze doorgeven.
   * @param {string} decision "granted" of "denied".
   * @returns {void}
   */
  const choose = (decision) => { banner.remove(); onChoice(decision); };
  actions.appendChild(makeButton(doc, 'Accepteren', 'button', () => choose('granted')));
  actions.appendChild(makeButton(doc, 'Weigeren', 'button button-secondary', () => choose('denied')));
  actions.appendChild(makeButton(doc, 'Instellingen', 'link-button', () => showConsentSettings(doc, { privacyUrl, current, onChoice })));
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
  const clarityId = body && body.getAttribute('data-shop-clarity');
  if (!measurementId && !clarityId) return null;
  const internal = body.getAttribute('data-internal') === '1';
  const analyticsTracker = measurementId ? createTracker({ window: win, document: doc, storage, measurementId, customerGroup: body.getAttribute('data-customer-group') || 'particulier', internal }) : null;
  // Medewerkers worden niet opgenomen: Clarity laadt alleen voor bezoekers.
  const clarity = clarityId && !internal ? createClarity({ window: win, document: doc, projectId: clarityId }) : null;
  let analyticsGranted = false;
  const tracker = {
    /**
     * De bezoeker staat analytisch toe: elke actieve dienst starten.
     * @returns {void}
     */
    grant() { analyticsGranted = true; if (analyticsTracker) analyticsTracker.grant(); if (clarity) clarity.grant(); },
    /**
     * De bezoeker weigert of trekt in: elke dienst stoppen en de cookies wissen.
     * @returns {void}
     */
    deny() { analyticsGranted = false; if (analyticsTracker) analyticsTracker.deny(); if (clarity) clarity.deny(); },
    /**
     * Verstuurt een gebeurtenis naar Google Analytics, alleen met toestemming.
     * @param {string} name De GA4-naam.
     * @param {object} params De velden van de gebeurtenis.
     * @returns {boolean} true als de gebeurtenis is doorgegeven.
     */
    track(name, params) { return analyticsTracker ? analyticsTracker.track(name, params) : false; },
    /**
     * Of de bezoeker op dit moment analytisch toestaat.
     * @returns {boolean} true zolang de bezoeker toestemming gaf.
     */
    isGranted() { return analyticsGranted; },
    /**
     * Of het Google-script is gevraagd (alleen na toestemming).
     * @returns {boolean} true als het Google-script is gevraagd.
     */
    isLoaded() { return Boolean(analyticsTracker && analyticsTracker.isLoaded()); },
    /**
     * Of het Clarity-script is gevraagd (alleen na toestemming, nooit voor medewerkers).
     * @returns {boolean} true als het Clarity-script is gevraagd.
     */
    isClarityLoaded() { return Boolean(clarity && clarity.isLoaded()); },
  };
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
    showConsentBanner(doc, { privacyUrl: body.getAttribute('data-privacy-url') || '#', current: readConsentRecord(storage), onChoice: choose });
  }

  const earlier = readConsent(storage);
  if (earlier === 'granted') { tracker.grant(); sendPageEvents(); } else if (earlier === null) askConsent();

  doc.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    if (target.closest('[data-consent-settings]')) { showConsentSettings(doc, { privacyUrl: body.getAttribute('data-privacy-url') || '#', current: readConsentRecord(storage), onChoice: choose }); return; }
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
