// Adapter voor WooCommerce-webshops. Twee manieren om producten op te halen:
//  - 'store': de openbare Store API (/wp-json/wc/store/v1/products), geen
//    sleutels nodig; prijzen zoals de shop ze toont.
//  - 'rest':  de REST API v3 (/wp-json/wc/v3/products) met consumer key en
//    secret (alleen-lezen volstaat); geeft ook meta_data (aquatech_code).
// Variabele producten: via de REST API komen ook de variaties mee, elk als
// eigen product met parentId (het variabele product) en de gekozen waarden
// (attributes: [{ name, option }]). De Store API geeft geen variaties.
//
// Terugschrijven (updateProducts, alleen REST v3 met lees- en schrijfrechten):
// prijs en voorraad uit Aquatech naar de webshop (instelling shopSource.push,
// zie shop-sync.js); een variatie via /products/<id>/variations/batch.
// Aanmaken (createProduct, createVariations): een artikel of hoofdartikel met
// varianten uit Aquatech als nieuw product in de webshop.

const net = require('net');
const { publicAddress } = require('../beveiliging/netguard');
const { pinnedFetch, readLimited } = require('../beveiliging/pinned-fetch');

const PER_PAGE = 100;
const MAX_PAGES = 50;
const MAX_VARIATION_PAGES = 5;
const TIMEOUT_MS = 15000;
const MAX_BYTES = 10 * 1024 * 1024;

class SourceError extends Error {
  /**
   * Fout bij het praten met de webshop, met een code voor de frontend en de HTTP-status.
   * @param {string} code Foutcode, bijv. 'unreachable' of 'invalid_url'.
   * @param {string} message Melding voor de gebruiker.
   * @param {number} [status] HTTP-status (standaard 502).
   */
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Interne en lokale adressen zijn geen webshop: voorkomt dat de server als
// doorgeefluik naar het eigen netwerk dient. Snelle controle op de naam bij
// het opslaan; bij het ophalen wordt de naam ook opgezocht (netguard.js).
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

/**
 * Of http en lokale adressen zijn toegestaan (SHOP_ALLOW_INSECURE=1: alleen
 * voor tests en ontwikkelen tegen een lokale webshop).
 * @returns {boolean} True als onveilige adressen mogen.
 */
const insecureAllowed = () => process.env.SHOP_ALLOW_INSECURE === '1';

/**
 * Controleert en normaliseert het webadres van een webshop: https en geen
 * intern adres (tenzij onveilig is toegestaan), zonder inloggegevens.
 * @param {string} raw Het ingevulde adres.
 * @param {{ allowInsecure?: boolean }} [options] Ook http en lokale adressen toestaan.
 * @returns {string} Herkomst + pad zonder slash aan het eind.
 */
function normalizeBaseUrl(raw, { allowInsecure = insecureAllowed() } = {}) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch (error) {
    throw new SourceError('invalid_url', 'Ongeldig webadres van de webshop.', 400);
  }
  if (url.username || url.password) throw new SourceError('invalid_url', 'Zet geen inloggegevens in het webadres.', 400);
  if (!allowInsecure) {
    if (url.protocol !== 'https:') throw new SourceError('invalid_url', 'De webshop moet via https bereikbaar zijn.', 400);
    if (PRIVATE_HOST.test(url.hostname)) throw new SourceError('invalid_url', 'Dit is geen openbaar webadres.', 400);
  } else if (!/^https?:$/.test(url.protocol)) {
    throw new SourceError('invalid_url', 'Ongeldig webadres van de webshop.', 400);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Vraagt JSON op bij de webshop (geen omleidingen, met time-out en groottegrens).
 * @param {string} url Het adres.
 * @param {object} headers Extra koppen (bijv. Authorization).
 * @param {Function} fetchImpl De fetch-functie.
 * @param {{ method?: string, body?: object }} [request] Methode en body.
 * @returns {Promise<{ body: *, totalPages: number }>} Het antwoord en het aantal pagina's (kop x-wp-totalpages).
 */
async function getJson(url, headers, fetchImpl, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const message = error.name === 'TimeoutError' ? 'De webshop reageert niet (time-out).' : 'De webshop is niet bereikbaar (of stuurt door naar een ander adres: vul het juiste adres in).';
    throw new SourceError('unreachable', message);
  }
  if (res.status === 401 || res.status === 403) {
    throw new SourceError('unauthorized', method === 'GET'
      ? 'De webshop weigert de toegang: controleer de API-sleutels (leesrechten).'
      : 'De webshop weigert het bijwerken: de API-sleutels moeten lees- en schrijfrechten hebben.');
  }
  if (res.status === 404) throw new SourceError('not_found', 'Geen WooCommerce-API gevonden op dit adres.');
  if (!res.ok) throw new SourceError('bad_status', `De webshop antwoordt met status ${res.status}.`);
  let text;
  try {
    // Met een grens in bytes ná het uitpakken: lezen stopt zodra het te veel wordt.
    text = await readLimited(res, MAX_BYTES);
  } catch (error) {
    if (error.code === 'too_large') throw new SourceError('too_large', 'Antwoord van de webshop is te groot.');
    throw new SourceError('unreachable', 'De webshop brak de verbinding af.');
  }
  try {
    return { body: JSON.parse(text), totalPages: Number(res.headers.get('x-wp-totalpages')) || 0 };
  } catch (error) {
    throw new SourceError('invalid_json', 'De webshop gaf geen geldige JSON terug.');
  }
}

/**
 * Leest een getal, ook met een komma.
 * @param {*} value De invoer.
 * @returns {number|null} Het getal, of null.
 */
const toNumber = (value) => {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};
/**
 * Rondt af op twee decimalen.
 * @param {number} value Het getal.
 * @returns {number} Afgerond.
 */
const round2 = (value) => Math.round(value * 100) / 100;
/**
 * Prijs exclusief btw (de webshop kan inclusief rekenen).
 * @param {number|null} price De prijs uit de webshop.
 * @param {object} shop De koppelinstelling (pricesIncludeTax, vatRate).
 * @returns {number|null} De prijs excl. btw.
 */
const exTax = (price, shop) => (price == null ? null : round2(shop.pricesIncludeTax ? price / (1 + shop.vatRate / 100) : price));

/**
 * Zet een product uit de Store API om naar het eigen formaat.
 * @param {object} product Het product.
 * @param {object} shop De koppelinstelling.
 * @returns {object} id, sku, name, price (excl. btw), currency, url, image, inStock, categories en code.
 */
function fromStoreApi(product, shop) {
  const prices = product.prices || {};
  const minor = Number.isInteger(prices.currency_minor_unit) ? prices.currency_minor_unit : 2;
  const raw = toNumber(prices.price);
  return {
    id: String(product.id),
    sku: String(product.sku || ''),
    name: String(product.name || ''),
    price: exTax(raw == null ? null : raw / 10 ** minor, shop),
    regularPrice: null,
    rawRegular: null,
    stockQty: null,
    currency: prices.currency_code || 'EUR',
    url: String(product.permalink || ''),
    image: product.images?.[0]?.src || '',
    inStock: product.is_in_stock !== false,
    categories: (product.categories || []).map((category) => category.name).filter(Boolean),
    code: '',
    type: 'simple',
    parentId: null,
    attributes: [],
  };
}

/**
 * Zet een product uit de REST API v3 om naar het eigen formaat, met normale prijs, voorraad en meta aquatech_code.
 * @param {object} product Het product.
 * @param {object} shop De koppelinstelling.
 * @returns {object} id, sku, name, price, regularPrice, rawRegular, stockQty, currency, url, image, inStock, categories en code.
 */
function fromRestV3(product, shop) {
  const meta = (product.meta_data || []).find((entry) => entry.key === 'aquatech_code');
  const regular = toNumber(product.regular_price);
  return {
    id: String(product.id),
    sku: String(product.sku || ''),
    name: String(product.name || ''),
    price: exTax(toNumber(product.price), shop),
    // Normale prijs (zonder actie) en voorraad zoals de webshop ze bijhoudt;
    // null = niet ingevuld of geen voorraadbeheer in de webshop.
    regularPrice: regular == null ? null : exTax(regular, shop),
    // Zoals de webshop hem opslaat (incl. of excl. btw), om te vergelijken.
    rawRegular: regular,
    stockQty: product.manage_stock && Number.isFinite(Number(product.stock_quantity)) ? Number(product.stock_quantity) : null,
    currency: 'EUR',
    url: String(product.permalink || ''),
    image: product.images?.[0]?.src || '',
    inStock: product.stock_status !== 'outofstock',
    categories: (product.categories || []).map((category) => category.name).filter(Boolean),
    code: meta ? String(meta.value || '').trim() : '',
    type: product.type === 'variable' ? 'variable' : 'simple',
    parentId: null,
    // Alle kenmerken zoals de webshop ze heeft (ook die niet voor variaties zijn), om bij het aanvullen niets te verliezen.
    attributes: (product.attributes || []).map((attribute) => ({
      id: attribute.id, name: String(attribute.name || ''), position: attribute.position, visible: attribute.visible !== false,
      variation: Boolean(attribute.variation), options: (attribute.options || []).map(String),
    })),
  };
}

/**
 * Zet een variatie uit de REST API v3 om naar het eigen formaat: een product
 * met parentId en de gekozen waarde per kenmerk.
 * @param {object} variation De variatie.
 * @param {object} parent Het variabele product erboven (zoals de webshop het stuurt; minstens id).
 * @param {object} shop De koppelinstelling.
 * @returns {object} Zoals fromRestV3, met type 'variation', parentId en attributes [{ name, option }].
 */
function fromRestV3Variation(variation, parent, shop) {
  const meta = (variation.meta_data || []).find((entry) => entry.key === 'aquatech_code');
  const regular = toNumber(variation.regular_price);
  const attributes = (variation.attributes || []).map((attribute) => ({ name: String(attribute.name || ''), option: String(attribute.option || '') }));
  const options = attributes.map((attribute) => attribute.option).filter(Boolean).join(', ');
  return {
    id: String(variation.id),
    sku: String(variation.sku || ''),
    name: `${String(parent.name || '')}${options ? ` – ${options}` : ''}`.trim(),
    price: exTax(toNumber(variation.price), shop),
    regularPrice: regular == null ? null : exTax(regular, shop),
    rawRegular: regular,
    stockQty: variation.manage_stock === true && Number.isFinite(Number(variation.stock_quantity)) ? Number(variation.stock_quantity) : null,
    currency: 'EUR',
    url: String(variation.permalink || parent.permalink || ''),
    image: variation.image?.src || parent.images?.[0]?.src || '',
    inStock: variation.stock_status !== 'outofstock',
    categories: (parent.categories || []).map((category) => category.name).filter(Boolean),
    code: meta ? String(meta.value || '').trim() : '',
    type: 'variation',
    parentId: String(parent.id),
    attributes,
  };
}

/**
 * Controleert het webadres en zoekt de naam op (geen intern adres). De
 * verbinding gaat daarna naar precies dat adres (pinned-fetch.js), zodat een
 * tweede DNS-antwoord niet alsnog naar het eigen netwerk wijst.
 * @param {object} shop De koppelinstelling (url).
 * @param {{ allowInsecure: boolean, resolveHost: Function, fetchImpl?: Function|null }} options Onveilige adressen toestaan, de functie die de naam opzoekt en een eigen fetch (tests).
 * @returns {Promise<{ base: string, send: Function }>} Het genormaliseerde adres en de fetch-functie voor deze webshop.
 */
async function connectionFor(shop, { allowInsecure, resolveHost, fetchImpl = null }) {
  const base = normalizeBaseUrl(shop.url, { allowInsecure });
  let address = null;
  if (!allowInsecure) {
    try {
      address = await resolveHost(new URL(base).hostname);
    } catch (error) {
      throw error.code === 'private_host'
        ? new SourceError('invalid_url', 'Dit is geen openbaar webadres.', 400)
        : new SourceError('unreachable', 'De webshop is niet gevonden: controleer het webadres.');
    }
  }
  const send = fetchImpl || (net.isIP(String(address || '')) ? pinnedFetch(address) : fetch);
  return { base, send };
}

/**
 * De kop Authorization voor de REST API.
 * @param {object} shop De koppelinstelling (consumerKey en consumerSecret).
 * @returns {{ Authorization: string }} De kop.
 */
function restAuth(shop) {
  if (!shop.consumerKey || !shop.consumerSecret) throw new SourceError('missing_keys', 'Vul de consumer key en secret van de WooCommerce REST API in.', 400);
  return { Authorization: `Basic ${Buffer.from(`${shop.consumerKey}:${shop.consumerSecret}`).toString('base64')}` };
}

/**
 * Haalt alle gepubliceerde producten op en zet ze om naar het eigen formaat.
 * @param {object} shop url, mode ('store'|'rest'), consumerKey, consumerSecret, pricesIncludeTax en vatRate.
 * @param {object} [options] fetchImpl, allowInsecure, resolveHost, ids (alleen deze producten, REST v3; bijv. vlak voor het terugschrijven) en variations ([{ id, parentId }]: alleen deze variaties).
 * @returns {Promise<object[]>} De producten (bij REST met de variaties van variabele producten).
 */
async function fetchProducts(shop, { fetchImpl = null, allowInsecure = insecureAllowed(), resolveHost = publicAddress, ids = null, variations = null } = {}) {
  const { base, send } = await connectionFor(shop, { allowInsecure, resolveHost, fetchImpl });
  const rest = shop.mode === 'rest';
  if ((ids || variations) && !rest) throw new SourceError('rest_required', 'Terugschrijven naar de webshop kan alleen via de REST API.', 400);
  const headers = rest ? restAuth(shop) : {};
  const apiPath = rest ? '/wp-json/wc/v3/products' : '/wp-json/wc/store/v1/products';
  const convert = rest ? fromRestV3 : fromStoreApi;
  const products = [];
  const rawProducts = [];
  if (ids || variations) {
    const productIds = ids || [];
    for (let i = 0; i < productIds.length; i += PER_PAGE) {
      const part = productIds.slice(i, i + PER_PAGE).map(String).filter((id) => /^\d{1,20}$/.test(id));
      if (!part.length) continue;
      const query = new URLSearchParams({ per_page: String(PER_PAGE), include: part.join(',') });
      const { body } = await getJson(`${base}${apiPath}?${query}`, headers, send);
      if (!Array.isArray(body)) throw new SourceError('invalid_json', 'Onverwacht antwoord van de webshop (geen productlijst).');
      products.push(...body.map((product) => convert(product, shop)));
    }
    // Variaties per product erboven ophalen (de productenlijst geeft ze niet).
    const byParent = new Map();
    for (const variation of variations || []) {
      if (!/^\d{1,20}$/.test(String(variation.parentId)) || !/^\d{1,20}$/.test(String(variation.id))) continue;
      if (!byParent.has(String(variation.parentId))) byParent.set(String(variation.parentId), []);
      byParent.get(String(variation.parentId)).push(String(variation.id));
    }
    for (const [parentId, variationIds] of byParent) {
      for (let i = 0; i < variationIds.length; i += PER_PAGE) {
        const query = new URLSearchParams({ per_page: String(PER_PAGE), include: variationIds.slice(i, i + PER_PAGE).join(',') });
        const { body } = await getJson(`${base}${apiPath}/${parentId}/variations?${query}`, headers, send);
        if (!Array.isArray(body)) throw new SourceError('invalid_json', 'Onverwacht antwoord van de webshop (geen variatielijst).');
        products.push(...body.map((variation) => fromRestV3Variation(variation, { id: parentId }, shop)));
      }
    }
    return products;
  }
  let complete = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) });
    if (rest) query.set('status', 'publish');
    const { body, totalPages } = await getJson(`${base}${apiPath}?${query}`, headers, send);
    if (!Array.isArray(body)) throw new SourceError('invalid_json', 'Onverwacht antwoord van de webshop (geen productlijst).');
    products.push(...body.map((product) => convert(product, shop)));
    rawProducts.push(...body);
    if (body.length < PER_PAGE || (totalPages && page >= totalPages)) { complete = true; break; }
  }
  if (!complete) throw new SourceError('too_many_products', `De webshop heeft meer dan ${MAX_PAGES * PER_PAGE} producten; ophalen is gestopt zodat er niets wordt gearchiveerd.`);
  if (rest) {
    // Variaties van variabele producten (per product een verzoek).
    const variableProducts = rawProducts.filter((product) => product.type === 'variable');
    for (const parent of variableProducts) products.push(...await fetchVariationsWith(base, headers, send, parent, shop));
  }
  return products;
}

/**
 * Haalt alle variaties van één variabel product op.
 * @param {string} base Adres van de webshop.
 * @param {object} headers Koppen (Authorization).
 * @param {Function} send De fetch-functie.
 * @param {object} parent Het variabele product zoals de webshop het stuurt (id, name, permalink, images, categories).
 * @param {object} shop De koppelinstelling.
 * @returns {Promise<object[]>} De variaties (fromRestV3Variation).
 */
async function fetchVariationsWith(base, headers, send, parent, shop) {
  const out = [];
  for (let page = 1; page <= MAX_VARIATION_PAGES; page++) {
    const query = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) });
    const { body, totalPages } = await getJson(`${base}/wp-json/wc/v3/products/${Number(parent.id)}/variations?${query}`, headers, send);
    if (!Array.isArray(body)) throw new SourceError('invalid_json', 'Onverwacht antwoord van de webshop (geen variatielijst).');
    out.push(...body.map((variation) => fromRestV3Variation(variation, parent, shop)));
    if (body.length < PER_PAGE || (totalPages && page >= totalPages)) return out;
  }
  throw new SourceError('too_many_products', `Een product in de webshop heeft meer dan ${MAX_VARIATION_PAGES * PER_PAGE} variaties; ophalen is gestopt zodat er niets wordt gearchiveerd.`);
}

/**
 * Haalt de variaties van één product op (REST v3), bijv. om vóór het
 * aanmaken te zien welke er al zijn.
 * @param {object} shop De koppelinstelling.
 * @param {string} productId Id van het variabele product.
 * @param {object} [options] fetchImpl, allowInsecure en resolveHost.
 * @returns {Promise<{ product: object, variations: object[] }>} Het product (fromRestV3) en zijn variaties.
 */
async function fetchProductWithVariations(shop, productId, { fetchImpl = null, allowInsecure = insecureAllowed(), resolveHost = publicAddress } = {}) {
  if (shop.mode !== 'rest') throw new SourceError('rest_required', 'Dit kan alleen via de REST API.', 400);
  if (!/^\d{1,20}$/.test(String(productId))) throw new SourceError('invalid_id', 'Ongeldig product-id.', 400);
  const { base, send } = await connectionFor(shop, { allowInsecure, resolveHost, fetchImpl });
  const headers = restAuth(shop);
  const { body } = await getJson(`${base}/wp-json/wc/v3/products/${productId}`, headers, send);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SourceError('invalid_json', 'Onverwacht antwoord van de webshop (geen product).');
  return { product: fromRestV3(body, shop), variations: body.type === 'variable' ? await fetchVariationsWith(base, headers, send, body, shop) : [] };
}

/**
 * Prijs voor de webshop: excl. btw uit Aquatech, incl. als de webshop zo rekent.
 * @param {number} priceExcl Prijs excl. btw.
 * @param {number} vatRate Btw-tarief in procenten.
 * @param {object} shop De koppelinstelling (pricesIncludeTax).
 * @returns {number} De prijs voor de webshop.
 */
function shopPrice(priceExcl, vatRate, shop) {
  return round2(shop.pricesIncludeTax ? priceExcl * (1 + (Number(vatRate) || 0) / 100) : priceExcl);
}

/**
 * Schrijft prijs en/of voorraad terug (REST v3, batch van hooguit 100); een
 * veld dat ontbreekt blijft in de webshop zoals het is.
 * @param {object} shop De koppelinstelling.
 * @param {{ id: string, price?: number, vatRate?: number, stockQty?: number }[]} updates Wijzigingen per product (prijs excl. btw).
 * @param {object} [options] fetchImpl, allowInsecure en resolveHost.
 * @returns {Promise<{ id: string, ok: boolean, error?: string }[]>} Uitkomst per product.
 */
async function updateProducts(shop, updates, { fetchImpl = null, allowInsecure = insecureAllowed(), resolveHost = publicAddress } = {}) {
  if (shop.mode !== 'rest') throw new SourceError('rest_required', 'Terugschrijven naar de webshop kan alleen via de REST API.', 400);
  const { base, send } = await connectionFor(shop, { allowInsecure, resolveHost, fetchImpl });
  const headers = restAuth(shop);
  const out = [];
  // Producten samen via /products/batch, variaties per product erboven.
  const groups = new Map();
  for (const update of updates) {
    const key = update.parentId && /^\d{1,20}$/.test(String(update.parentId)) ? String(update.parentId) : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(update);
  }
  for (const [parentId, group] of groups) {
    const batchPath = parentId ? `/wp-json/wc/v3/products/${parentId}/variations/batch` : '/wp-json/wc/v3/products/batch';
    for (let i = 0; i < group.length; i += PER_PAGE) {
      const part = group.slice(i, i + PER_PAGE).map((update) => {
        const change = { id: Number(update.id) };
        if (update.price != null) change.regular_price = shopPrice(update.price, update.vatRate, shop).toFixed(2);
        if (update.stockQty != null) { change.manage_stock = true; change.stock_quantity = Math.max(0, Math.floor(update.stockQty)); }
        return change;
      });
      const { body } = await getJson(`${base}${batchPath}`, headers, send, { method: 'POST', body: { update: part } });
      out.push(...batchResults(part, body && body.update));
    }
  }
  return out;
}

/**
 * Uitkomst per regel van een batchverzoek (op volgorde, of op id als de webshop dat teruggeeft).
 * @param {object[]} part De verstuurde regels (met id bij wijzigen).
 * @param {*} results Wat de webshop teruggaf (lijst).
 * @returns {{ id: string, ok: boolean, error?: string }[]} Uitkomst per regel.
 */
function batchResults(part, results) {
  const list = Array.isArray(results) ? results : [];
  const done = new Map(list.map((result) => [String(result.id), result]));
  return part.map((change, index) => {
    const result = change.id != null ? done.get(String(change.id)) : list[index];
    const id = String(change.id ?? (result && result.id) ?? '');
    return result && !result.error && result.id ? { id: String(result.id), ok: true } : { id, ok: false, error: String((result && result.error && result.error.message) || 'niet bijgewerkt').slice(0, 200) };
  });
}

/**
 * Maakt een nieuw product in de webshop (REST v3, schrijfrechten).
 * @param {object} shop De koppelinstelling.
 * @param {object} product Het product zoals WooCommerce het verwacht (name, type, sku, regular_price, attributes, ...).
 * @param {object} [options] fetchImpl, allowInsecure en resolveHost.
 * @returns {Promise<object>} Het aangemaakte product (fromRestV3).
 */
async function createProduct(shop, product, { fetchImpl = null, allowInsecure = insecureAllowed(), resolveHost = publicAddress } = {}) {
  if (shop.mode !== 'rest') throw new SourceError('rest_required', 'Aanmaken in de webshop kan alleen via de REST API.', 400);
  const { base, send } = await connectionFor(shop, { allowInsecure, resolveHost, fetchImpl });
  const { body } = await getJson(`${base}/wp-json/wc/v3/products`, restAuth(shop), send, { method: 'POST', body: product });
  if (!body || !body.id) throw new SourceError('invalid_json', 'De webshop heeft het product niet aangemaakt.');
  return fromRestV3(body, shop);
}

/**
 * Wijzigt de kenmerken van een product (bijv. nieuwe waarden voor nieuwe variaties).
 * @param {object} shop De koppelinstelling.
 * @param {string} productId Id van het product.
 * @param {object[]} attributes De kenmerken zoals WooCommerce ze verwacht ({ id?, name, options, visible, variation, position }).
 * @param {object} [options] fetchImpl, allowInsecure en resolveHost.
 * @returns {Promise<void>}
 */
async function updateAttributes(shop, productId, attributes, { fetchImpl = null, allowInsecure = insecureAllowed(), resolveHost = publicAddress } = {}) {
  if (!/^\d{1,20}$/.test(String(productId))) throw new SourceError('invalid_id', 'Ongeldig product-id.', 400);
  const { base, send } = await connectionFor(shop, { allowInsecure, resolveHost, fetchImpl });
  await getJson(`${base}/wp-json/wc/v3/products/${productId}`, restAuth(shop), send, { method: 'PUT', body: { attributes } });
}

/**
 * Maakt variaties onder een variabel product (batch van hooguit 100).
 * @param {object} shop De koppelinstelling.
 * @param {string} productId Id van het variabele product.
 * @param {{ sku: string, code: string, price?: number|null, vatRate?: number, stockQty?: number|null, values: Object<string, string> }[]} variations De nieuwe variaties (prijs excl. btw).
 * @param {object} [options] fetchImpl, allowInsecure en resolveHost.
 * @returns {Promise<{ id: string, ok: boolean, error?: string }[]>} Per variatie (zelfde volgorde) het nieuwe id of de fout.
 */
async function createVariations(shop, productId, variations, { fetchImpl = null, allowInsecure = insecureAllowed(), resolveHost = publicAddress } = {}) {
  if (shop.mode !== 'rest') throw new SourceError('rest_required', 'Aanmaken in de webshop kan alleen via de REST API.', 400);
  if (!/^\d{1,20}$/.test(String(productId))) throw new SourceError('invalid_id', 'Ongeldig product-id.', 400);
  const { base, send } = await connectionFor(shop, { allowInsecure, resolveHost, fetchImpl });
  const headers = restAuth(shop);
  const out = [];
  for (let i = 0; i < variations.length; i += PER_PAGE) {
    const part = variations.slice(i, i + PER_PAGE).map((variation) => {
      const create = {
        sku: variation.sku,
        attributes: Object.entries(variation.values).map(([name, option]) => ({ name, option })),
        meta_data: [{ key: 'aquatech_code', value: variation.code }],
      };
      if (variation.price != null) create.regular_price = shopPrice(variation.price, variation.vatRate, shop).toFixed(2);
      if (variation.stockQty != null) { create.manage_stock = true; create.stock_quantity = Math.max(0, Math.floor(variation.stockQty)); }
      return create;
    });
    try {
      const { body } = await getJson(`${base}/wp-json/wc/v3/products/${productId}/variations/batch`, headers, send, { method: 'POST', body: { create: part } });
      out.push(...batchResults(part, body && body.create));
    } catch (error) {
      // Mislukt een latere batch, dan blijven de eerdere resultaten bewaard en krijgt deze batch een fout per variatie.
      if (!(error instanceof SourceError) || !out.length) throw error;
      out.push(...part.map(() => ({ id: '', ok: false, error: String(error.message || 'niet aangemaakt').slice(0, 200) })));
    }
  }
  return out;
}

/**
 * Bestellingen met een bepaalde status die sinds `after` zijn gewijzigd,
 * oudste wijziging eerst (REST v3, leesrechten). shop-orders.js zet ze om.
 * @param {object} shop De koppelinstelling.
 * @param {object} [options] status, after (ISO-tijd), fetchImpl, allowInsecure, resolveHost en maxPages.
 * @returns {Promise<object[]>} De bestellingen zoals WooCommerce ze stuurt.
 */
async function fetchOrders(shop, { status = 'completed', after = '', fetchImpl = null, allowInsecure = insecureAllowed(), resolveHost = publicAddress, maxPages = 10 } = {}) {
  if (shop.mode !== 'rest') throw new SourceError('rest_required', 'Bestellingen ophalen kan alleen via de REST API (met API-sleutels).', 400);
  const { base, send } = await connectionFor(shop, { allowInsecure, resolveHost, fetchImpl });
  const headers = restAuth(shop);
  const orders = [];
  for (let page = 1; page <= maxPages; page++) {
    const query = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page), status, orderby: 'modified', order: 'asc', dates_are_gmt: 'true' });
    if (after) query.set('modified_after', after);
    const { body, totalPages } = await getJson(`${base}/wp-json/wc/v3/orders?${query}`, headers, send);
    if (!Array.isArray(body)) throw new SourceError('invalid_json', 'Onverwacht antwoord van de webshop (geen bestellingen).');
    orders.push(...body);
    if (body.length < PER_PAGE || (totalPages && page >= totalPages)) break;
  }
  return orders;
}

/**
 * Schoont de koppelinstelling (shopSource) op, zonder sleutels; die staan apart en versleuteld.
 * @param {object} raw De invoer.
 * @returns {object} type, url, mode, pricesIncludeTax, vatRate, push, pushStock en mapping.
 */
function sanitizeShop(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let url = '';
  try { url = input.url ? normalizeBaseUrl(input.url) : ''; } catch { url = ''; }
  const vat = Number(input.vatRate);
  const mapping = {};
  if (input.mapping && typeof input.mapping === 'object' && !Array.isArray(input.mapping)) {
    for (const [code, sku] of Object.entries(input.mapping).slice(0, 500)) {
      if (/^[A-Z0-9-]{1,40}$/.test(code) && typeof sku === 'string' && sku.trim()) mapping[code] = sku.trim().slice(0, 100);
    }
  }
  return {
    type: 'woocommerce',
    url,
    mode: input.mode === 'rest' ? 'rest' : 'store',
    pricesIncludeTax: input.pricesIncludeTax !== false,
    vatRate: [0, 9, 21].includes(vat) ? vat : 21,
    // Prijzen en voorraad uit Aquatech naar de webshop sturen (REST API met
    // schrijfrechten); uit = de webshop blijft leidend voor de prijzen.
    push: input.mode === 'rest' && input.push === true,
    pushStock: input.pushStock !== false,
    // De webshop bepaalt welke artikelen er zijn (nieuwe producten worden artikel,
    // ontbrekende worden gearchiveerd). Uit = Aquatech is de bron van de artikellijst.
    mirror: input.mirror !== false,
    mapping,
  };
}

module.exports = { fetchProducts, fetchProductWithVariations, fetchOrders, updateProducts, createProduct, updateAttributes, createVariations, shopPrice, normalizeBaseUrl, sanitizeShop, SourceError };
