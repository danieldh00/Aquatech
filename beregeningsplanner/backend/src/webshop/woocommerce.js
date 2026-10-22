// Adapter voor WooCommerce-webshops. Twee manieren om producten op te halen:
//  - 'store': de openbare Store API (/wp-json/wc/store/v1/products), geen
//    sleutels nodig; prijzen zoals de shop ze toont.
//  - 'rest':  de REST API v3 (/wp-json/wc/v3/products) met consumer key en
//    secret (alleen-lezen volstaat); geeft ook meta_data (aquatech_code).
// Variaties van variabele producten worden in dit prototype niet opgehaald.
//
// Terugschrijven (updateProducts, alleen REST v3 met lees- en schrijfrechten):
// prijs en voorraad uit Aquatech naar de webshop (instelling shopSource.push,
// zie shop.js syncStock).

const { publicAddress } = require('../beveiliging/netguard');

const PER_PAGE = 100;
const MAX_PAGES = 50;
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
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new SourceError('too_large', 'Antwoord van de webshop is te groot.');
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
  };
}

/**
 * Controleert het webadres en zoekt de naam op (geen intern adres).
 * @param {object} shop De koppelinstelling (url).
 * @param {{ allowInsecure: boolean, resolveHost: Function }} options Onveilige adressen toestaan en de functie die de naam opzoekt.
 * @returns {Promise<string>} Het genormaliseerde adres.
 */
async function checkedBase(shop, { allowInsecure, resolveHost }) {
  const base = normalizeBaseUrl(shop.url, { allowInsecure });
  if (!allowInsecure) {
    try {
      await resolveHost(new URL(base).hostname);
    } catch (error) {
      throw error.code === 'private_host'
        ? new SourceError('invalid_url', 'Dit is geen openbaar webadres.', 400)
        : new SourceError('unreachable', 'De webshop is niet gevonden: controleer het webadres.');
    }
  }
  return base;
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
 * @param {object} [options] fetchImpl, allowInsecure, resolveHost en ids (alleen deze producten, REST v3; bijv. vlak voor het terugschrijven).
 * @returns {Promise<object[]>} De producten.
 */
async function fetchProducts(shop, { fetchImpl = fetch, allowInsecure = insecureAllowed(), resolveHost = publicAddress, ids = null } = {}) {
  const base = await checkedBase(shop, { allowInsecure, resolveHost });
  const rest = shop.mode === 'rest';
  if (ids && !rest) throw new SourceError('rest_required', 'Terugschrijven naar de webshop kan alleen via de REST API.', 400);
  const headers = rest ? restAuth(shop) : {};
  const apiPath = rest ? '/wp-json/wc/v3/products' : '/wp-json/wc/store/v1/products';
  const convert = rest ? fromRestV3 : fromStoreApi;
  const products = [];
  if (ids) {
    for (let i = 0; i < ids.length; i += PER_PAGE) {
      const part = ids.slice(i, i + PER_PAGE).map(String).filter((id) => /^\d{1,20}$/.test(id));
      if (!part.length) continue;
      const query = new URLSearchParams({ per_page: String(PER_PAGE), include: part.join(',') });
      const { body } = await getJson(`${base}${apiPath}?${query}`, headers, fetchImpl);
      if (!Array.isArray(body)) throw new SourceError('invalid_json', 'Onverwacht antwoord van de webshop (geen productlijst).');
      products.push(...body.map((product) => convert(product, shop)));
    }
    return products;
  }
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) });
    if (rest) query.set('status', 'publish');
    const { body, totalPages } = await getJson(`${base}${apiPath}?${query}`, headers, fetchImpl);
    if (!Array.isArray(body)) throw new SourceError('invalid_json', 'Onverwacht antwoord van de webshop (geen productlijst).');
    products.push(...body.map((product) => convert(product, shop)));
    if (body.length < PER_PAGE || (totalPages && page >= totalPages)) break;
  }
  return products;
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
async function updateProducts(shop, updates, { fetchImpl = fetch, allowInsecure = insecureAllowed(), resolveHost = publicAddress } = {}) {
  if (shop.mode !== 'rest') throw new SourceError('rest_required', 'Terugschrijven naar de webshop kan alleen via de REST API.', 400);
  const base = await checkedBase(shop, { allowInsecure, resolveHost });
  const headers = restAuth(shop);
  const out = [];
  for (let i = 0; i < updates.length; i += PER_PAGE) {
    const part = updates.slice(i, i + PER_PAGE).map((update) => {
      const change = { id: Number(update.id) };
      if (update.price != null) change.regular_price = shopPrice(update.price, update.vatRate, shop).toFixed(2);
      if (update.stockQty != null) { change.manage_stock = true; change.stock_quantity = Math.max(0, Math.floor(update.stockQty)); }
      return change;
    });
    const { body } = await getJson(`${base}/wp-json/wc/v3/products/batch`, headers, fetchImpl, { method: 'POST', body: { update: part } });
    const done = new Map((Array.isArray(body && body.update) ? body.update : []).map((product) => [String(product.id), product]));
    for (const change of part) {
      const result = done.get(String(change.id));
      out.push(result && !result.error ? { id: String(change.id), ok: true } : { id: String(change.id), ok: false, error: String((result && result.error && result.error.message) || 'niet bijgewerkt').slice(0, 200) });
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
async function fetchOrders(shop, { status = 'completed', after = '', fetchImpl = fetch, allowInsecure = insecureAllowed(), resolveHost = publicAddress, maxPages = 10 } = {}) {
  if (shop.mode !== 'rest') throw new SourceError('rest_required', 'Bestellingen ophalen kan alleen via de REST API (met API-sleutels).', 400);
  const base = await checkedBase(shop, { allowInsecure, resolveHost });
  const headers = restAuth(shop);
  const orders = [];
  for (let page = 1; page <= maxPages; page++) {
    const query = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page), status, orderby: 'modified', order: 'asc', dates_are_gmt: 'true' });
    if (after) query.set('modified_after', after);
    const { body, totalPages } = await getJson(`${base}/wp-json/wc/v3/orders?${query}`, headers, fetchImpl);
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
    mapping,
  };
}

module.exports = { fetchProducts, fetchOrders, updateProducts, shopPrice, normalizeBaseUrl, sanitizeShop, SourceError };
