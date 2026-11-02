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
      res.status(502).json({ error: 'unavailable', message: 'Het adres kon nu niet worden opgezocht. Probeer het later opnieuw.' });
    }
  });
}

/** Postcode in een vrije adrestekst (vier cijfers en twee letters, met of zonder spatie). */
const POSTCODE_IN_TEXT = /(?<![0-9A-Za-z])([1-9]\d{3})\s?([A-Za-z]{2})(?![0-9A-Za-z])/;

/**
 * Haalt uit een adrestekst de mogelijke combinaties van postcode, huisnummer en toevoeging.
 * Het deel vóór de postcode eindigt op huisnummer en toevoeging ("Tuinstraat 12A"); omdat een toevoeging met cijfers
 * ("12" + "2" = "122") dubbelzinnig is, komen alle verdelingen terug.
 * @param {*} text De adrestekst, bijvoorbeeld "Tuinstraat 12A\n8071 AB Nunspeet".
 * @returns {{ postcode: string, houseNumber: string, suffix: string }[]} De mogelijke combinaties (leeg als er geen postcode of huisnummer in staat).
 */
function addressCandidates(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const match = POSTCODE_IN_TEXT.exec(flat);
  if (!match) return [];
  const postcode = normalizePostcode(`${match[1]}${match[2]}`);
  if (!postcode) return [];
  const street = flat.slice(0, match.index).replace(/[\s,]+$/, '');
  // Het huisnummer staat in de laatste component van de straatregel (cijfers in de straatnaam, zoals "Plein 1940-1945", tellen niet mee);
  // een losse toevoeging ("12 A" of "12 2") hoort bij het component ervoor, dus beide lezingen worden geprobeerd.
  const parts = street.split(' ');
  const last = parts[parts.length - 1] || '';
  const previous = parts.length > 1 ? parts[parts.length - 2] : '';
  const readings = /^\d/.test(last) ? [last] : [];
  if (/^\d/.test(previous) && last) readings.push(`${previous}${last}`);
  const candidates = [];
  for (const reading of readings) {
    const compact = reading.replace(/-+/g, '');
    const digitsMatch = /^\d+/.exec(compact);
    if (!digitsMatch) continue;
    const digits = digitsMatch[0].slice(0, 5);
    for (let length = digits.length; length >= 1; length -= 1) {
      candidates.push({ postcode, houseNumber: normalizeHouseNumber(compact.slice(0, length)), suffix: normalizeSuffix(compact.slice(length, length + 6)) });
    }
  }
  return candidates.filter((candidate) => candidate.houseNumber).slice(0, 6);
}

/**
 * Maakt een adrestekst vergelijkbaar: kleine letters, zonder spaties, komma's en streepjes.
 * @param {*} text De adrestekst.
 * @returns {string} De vergelijkbare vorm.
 */
function comparable(text) {
  return String(text || '').toLowerCase().replace(/[\s,-]+/g, '');
}

/**
 * Maakt de adrescontrole voor de server: een adres dat een klant of medewerker opstuurt moet precies het adres zijn
 * dat PDOK bij de postcode en het huisnummer geeft. De server vertrouwt dus nooit een straat of plaats uit de browser.
 * @param {{ lookup: Function }} service De opzoekdienst (createAddressLookup).
 * @returns {{ verify: Function, resolveParts: Function }} De controle.
 */
function createAddressGuard(service) {
  /**
   * Zoekt de verdeling van een adrestekst die bij PDOK exact klopt.
   * @param {*} text De adrestekst.
   * @returns {Promise<{ found: boolean, address?: object }>} Het gevonden adres, of found:false als geen enkele verdeling klopt.
   * @throws {Error} Met code 'unavailable' als PDOK niet bereikbaar is.
   */
  async function match(text) {
    const wanted = comparable(text);
    for (const candidate of addressCandidates(text)) {
      const found = await service.lookup(candidate);
      if (!found.found) continue;
      const line = `${found.street}${found.houseNumber}${found.suffix}${found.postcode}${found.city}`;
      if (comparable(line) === wanted) return { found: true, address: found };
    }
    return { found: false };
  }

  /**
   * Controleert een adrestekst die in een formulier is ingevuld.
   * @param {*} text Het opgestuurde adres (leeg mag: dan is er geen adres).
   * @param {{ previous?: Function }} [options] previous() geeft het adres (of de adressen) zoals ze nu zijn opgeslagen; een ongewijzigd (ouder) adres blijft altijd geldig.
   * @returns {Promise<{ ok: true }|{ ok: false, status: number, error: string, message: string }>} De uitkomst.
   */
  async function verify(text, { previous = () => '' } = {}) {
    if (!String(text || '').trim()) return { ok: true };
    let failure = { status: 400, error: 'invalid_address', message: 'Het adres klopt niet met de postcode en het huisnummer. Vul postcode en huisnummer in; het adres wordt dan automatisch ingevuld.' };
    try {
      if ((await match(text)).found) return { ok: true };
    } catch (error) {
      if (error.code !== 'unavailable') throw error;
      failure = { status: 503, error: 'address_unavailable', message: 'Het adres kon nu niet worden gecontroleerd. Probeer het later opnieuw.' };
    }
    // Een bestaand record met een ouder adres (zonder postcode of niet meer in de BAG) blijft ongewijzigd opgeslagen kunnen worden.
    const stored = [].concat(await previous());
    if (stored.some((address) => comparable(address) === comparable(text))) return { ok: true };
    return { ok: false, ...failure };
  }

  /**
   * Zoekt voor het afrekenen straat en plaats bij een Nederlandse postcode.
   * @param {{ street: *, postcode: *, city?: * }} parts De ingevulde straat (met huisnummer), postcode en plaats.
   * @returns {Promise<{ ok: true, street: string, postcode: string, city: string }|{ ok: false, status: number, error: string, message: string }>} Het adres zoals PDOK het geeft, of de fout.
   */
  async function resolveParts({ street, postcode }) {
    if (!normalizePostcode(postcode)) return { ok: false, status: 400, error: 'invalid_address', message: 'Vul een geldige postcode in, bijvoorbeeld 8071 AB.' };
    if (street.length < 3) return { ok: false, status: 400, error: 'invalid_address', message: 'Vul je straat en huisnummer in.' };
    const text = `${street}, ${postcode}`;
    for (const candidate of addressCandidates(text)) {
      let found;
      try {
        found = await service.lookup(candidate);
      } catch (error) {
        if (error.code !== 'unavailable') throw error;
        return { ok: false, status: 503, error: 'address_unavailable', message: 'Het adres kon nu niet worden gecontroleerd. Probeer het later opnieuw.' };
      }
      if (found.found && comparable(`${found.street}${found.houseNumber}${found.suffix}`) === comparable(street)) {
        return { ok: true, street: `${found.street} ${found.houseNumber}${found.suffix}`, postcode: found.postcode, city: found.city };
      }
    }
    return { ok: false, status: 400, error: 'invalid_address', message: 'Het adres klopt niet met de postcode en het huisnummer. Vul postcode en huisnummer in; straat en woonplaats worden dan automatisch ingevuld.' };
  }

  return { verify, resolveParts };
}

/**
 * Maakt een Express-middleware die het adres in een verzoek controleert voordat de route het opslaat.
 * @param {{ verify: Function }} guard De adrescontrole (createAddressGuard).
 * @param {Function} addressOf (req) => het opgestuurde adres, of niets als dit verzoek geen adres meestuurt.
 * @param {Function} [previousOf] (req) => functie die het opgeslagen adres geeft (alleen aangeroepen als het adres niet klopt).
 * @returns {Function} De middleware.
 */
function requireVerifiedAddress(guard, addressOf, previousOf = () => () => '') {
  return async (req, res, next) => {
    try {
      const text = addressOf(req);
      if (text === undefined || text === null) return next();
      if (typeof text !== 'string') return res.status(400).json({ error: 'invalid_address', field: 'address', message: 'Het adres moet tekst zijn.' });
      if (!text.trim()) return next();
      const out = await guard.verify(text, { previous: previousOf(req) });
      if (!out.ok) return res.status(out.status).json({ error: out.error, field: 'address', message: out.message });
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { createAddressGuard, requireVerifiedAddress, addressCandidates, createAddressLookup, registerAddressRoute, normalizePostcode, normalizeHouseNumber, normalizeSuffix };
