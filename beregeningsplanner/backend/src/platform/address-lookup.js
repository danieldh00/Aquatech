// Adres opzoeken bij postcode en huisnummer via de PDOK Locatieserver (BAG,
// gratis, zonder sleutel). De browser vraagt het aan onze server (zodat de
// CSP dicht blijft); de server onthoudt uitkomsten, begrenst de wachttijd en
// geeft bij een storing een duidelijke fout in plaats van te blokkeren.

/** Basisadres van de PDOK Locatieserver (vast, geen invoer van een tenant). */
const PDOK_URL = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free';
/** Hoe lang een gevonden adres onthouden wordt (BAG-adressen veranderen zelden). */
const CACHE_MS = 24 * 60 * 60 * 1000;
/** Hoe lang "niets gevonden" onthouden wordt (nieuwbouw komt er snel bij). */
const CACHE_EMPTY_MS = 10 * 60 * 1000;
/** Maximum aantal onthouden uitkomsten, zodat het geheugen niet groeit. */
const CACHE_MAX = 2000;
/** Wachttijd op PDOK voordat we opgeven. */
const TIMEOUT_MS = 4000;

/**
 * Maakt een Nederlandse postcode schoon.
 * @param {*} value Wat de gebruiker intikte, bijvoorbeeld "1234 ab".
 * @returns {string} De postcode als "1234AB", of een lege tekst als het geen geldige postcode is.
 */
function normalizePostcode(value) {
  const compact = String(value || '').replace(/\s+/g, '').toUpperCase();
  return /^[1-9]\d{3}(?!SA|SD|SS)[A-Z]{2}$/.test(compact) ? compact : '';
}

/**
 * Maakt een huisnummer schoon.
 * @param {*} value Wat de gebruiker intikte, bijvoorbeeld "12".
 * @returns {string} Het huisnummer als cijfers (1 tot 99999), of een lege tekst.
 */
function normalizeHouseNumber(value) {
  const text = String(value || '').trim();
  return /^\d{1,5}$/.test(text) && Number(text) > 0 ? String(Number(text)) : '';
}

/**
 * Maakt een huisnummertoevoeging schoon (letter of cijfers, zoals "A" of "2").
 * @param {*} value Wat de gebruiker intikte.
 * @returns {string} De toevoeging in hoofdletters zonder spaties of streepjes (max. 6 tekens).
 */
function normalizeSuffix(value) {
  return String(value || '').replace(/[\s-]+/g, '').toUpperCase().slice(0, 6).replace(/[^A-Z0-9]/g, '');
}

/**
 * Maakt van de adresregels van PDOK de toevoeging zoals mensen hem schrijven.
 * @param {{ huisletter?: string, huisnummertoevoeging?: string }} doc Eén adres uit PDOK.
 * @returns {string} Bijvoorbeeld "A", "2" of "A2", in hoofdletters.
 */
function suffixOf(doc) {
  return `${doc.huisletter || ''}${doc.huisnummertoevoeging || ''}`.replace(/[\s-]+/g, '').toUpperCase();
}

/**
 * Zoekt in de uitkomst van PDOK het adres dat het best past.
 * @param {object[]} docs De adressen die PDOK teruggaf voor deze postcode en dit huisnummer.
 * @param {string} suffix De gevraagde toevoeging (mag leeg zijn).
 * @returns {{ doc: object, suffixRequired: boolean }|null} Het gekozen adres (suffixRequired = dit huisnummer heeft alleen adressen mét toevoeging), of niets als er geen past (ook als de gevraagde toevoeging niet bestaat).
 */
function pickAddress(docs, suffix) {
  if (!docs.length) return null;
  if (suffix) {
    const exact = docs.find((doc) => suffixOf(doc) === suffix);
    return exact ? { doc: exact, suffixRequired: false } : null;
  }
  const plain = docs.find((doc) => !suffixOf(doc));
  return { doc: plain || docs[0], suffixRequired: !plain };
}

/**
 * Maakt de opzoekdienst. Tests geven een eigen fetchImpl mee, zodat er nooit echt naar PDOK gebeld wordt.
 * @param {{ fetchImpl?: Function }} [options] fetchImpl vervangt fetch (alleen voor tests).
 * @returns {{ lookup: Function }} De dienst met lookup({ postcode, houseNumber, suffix }).
 */
function createAddressLookup({ fetchImpl = (...args) => fetch(...args) } = {}) {
  const cache = new Map();
  // Lopende vragen aan PDOK per sleutel, zodat gelijktijdige verzoeken één aanroep delen.
  const pending = new Map();

  /**
   * Haalt de adressen bij een postcode en huisnummer op bij PDOK.
   * @param {string} postcode Genormaliseerde postcode.
   * @param {string} houseNumber Genormaliseerd huisnummer.
   * @returns {Promise<object[]>} De gevonden adressen (kan leeg zijn).
   */
  async function fetchDocs(postcode, houseNumber) {
    const params = new URLSearchParams({ q: `${postcode} ${houseNumber}`, rows: '100', fl: 'straatnaam,huisnummer,huisletter,huisnummertoevoeging,postcode,woonplaatsnaam' });
    params.append('fq', 'type:adres');
    params.append('fq', `postcode:${postcode}`);
    params.append('fq', `huisnummer:${houseNumber}`);
    const response = await fetchImpl(`${PDOK_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`PDOK gaf status ${response.status}`);
    const body = await response.json();
    return Array.isArray(body?.response?.docs) ? body.response.docs : [];
  }

  /**
   * Zoekt het adres bij een postcode en huisnummer.
   * @param {{ postcode: *, houseNumber: *, suffix?: * }} input De ingevoerde waarden.
   * @returns {Promise<{ found: boolean, street?: string, houseNumber?: string, suffix?: string, suffixRequired?: boolean, suffixUnknown?: boolean, postcode?: string, city?: string }>} Het adres, of found:false als de combinatie niet bestaat.
   * @throws {Error} Met code 'invalid' bij een ongeldige invoer en 'unavailable' als PDOK niet bereikbaar is.
   */
  async function lookup({ postcode, houseNumber, suffix = '' }) {
    const cleanPostcode = normalizePostcode(postcode);
    const cleanNumber = normalizeHouseNumber(houseNumber);
    const cleanSuffix = normalizeSuffix(suffix);
    if (!cleanPostcode || !cleanNumber) throw Object.assign(new Error('Ongeldige postcode of huisnummer.'), { code: 'invalid' });
    const key = `${cleanPostcode}|${cleanNumber}`;
    let entry = cache.get(key);
    if (!entry || entry.expires <= Date.now()) {
      let request = pending.get(key);
      if (!request) {
        request = fetchDocs(cleanPostcode, cleanNumber).finally(() => pending.delete(key));
        pending.set(key, request);
      }
      let docs;
      try {
        docs = await request;
      } catch (error) {
        throw Object.assign(new Error('Het opzoeken van het adres is niet gelukt.'), { code: 'unavailable', cause: error });
      }
      entry = { docs, expires: Date.now() + (docs.length ? CACHE_MS : CACHE_EMPTY_MS) };
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, entry);
    }
    const picked = pickAddress(entry.docs, cleanSuffix);
    if (!picked) return entry.docs.length && cleanSuffix ? { found: false, suffixUnknown: true } : { found: false };
    if (!picked.doc.straatnaam || !picked.doc.woonplaatsnaam) return { found: false };
    if (picked.suffixRequired) return { found: false, suffixRequired: true };
    return {
      found: true, street: picked.doc.straatnaam, houseNumber: cleanNumber, suffix: cleanSuffix,
      suffixRequired: picked.suffixRequired, postcode: `${cleanPostcode.slice(0, 4)} ${cleanPostcode.slice(4)}`, city: picked.doc.woonplaatsnaam,
    };
  }

  return { lookup };
}

/**
 * Zet een Express-route neer die een adres opzoekt: GET <pad>?postcode=&huisnummer=&toevoeging=.
 * @param {{ get: Function }} router De app of router waar de route op komt.
 * @param {string} routePath Het pad van de route.
 * @param {{ lookup: Function }} service De opzoekdienst (createAddressLookup).
 * @param {...Function} guards Middleware die vooraf draait: de login-controle en een rate limiter.
 * @returns {void}
 */
function registerAddressRoute(router, routePath, service, ...guards) {
  router.get(routePath, ...guards, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await service.lookup({ postcode: req.query.postcode, houseNumber: req.query.huisnummer, suffix: req.query.toevoeging }));
    } catch (error) {
      if (error.code === 'invalid') return res.status(400).json({ error: 'invalid', message: 'Vul een geldige postcode (1234 AB) en een huisnummer in.' });
      res.status(502).json({ error: 'unavailable', message: 'Het adres kon nu niet worden opgezocht. Vul het adres zelf in.' });
    }
  });
}

module.exports = { createAddressLookup, registerAddressRoute, normalizePostcode, normalizeHouseNumber, normalizeSuffix };
