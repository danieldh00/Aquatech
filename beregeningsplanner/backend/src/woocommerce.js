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

const { publicAddress } = require('./netguard');

const PER_PAGE = 100;
const MAX_PAGES = 50;
const TIMEOUT_MS = 15000;
const MAX_BYTES = 10 * 1024 * 1024;

class SourceError extends Error {
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

// SHOP_ALLOW_INSECURE=1 staat ook http en lokale adressen toe: alleen voor
// tests en ontwikkelen tegen een lokale webshop.
const insecureAllowed = () => process.env.SHOP_ALLOW_INSECURE === '1';

function normalizeBaseUrl(raw, { allowInsecure = insecureAllowed() } = {}) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch (err) {
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

async function getJson(url, headers, fetchImpl, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'De webshop reageert niet (time-out).' : 'De webshop is niet bereikbaar (of stuurt door naar een ander adres: vul het juiste adres in).';
    throw new SourceError('unreachable', msg);
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
  } catch (err) {
    throw new SourceError('invalid_json', 'De webshop gaf geen geldige JSON terug.');
  }
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => Math.round(n * 100) / 100;
const exTax = (price, cfg) => (price == null ? null : round2(cfg.pricesIncludeTax ? price / (1 + cfg.vatRate / 100) : price));

function fromStoreApi(p, cfg) {
  const pr = p.prices || {};
  const minor = Number.isInteger(pr.currency_minor_unit) ? pr.currency_minor_unit : 2;
  const raw = num(pr.price);
  return {
    id: String(p.id),
    sku: String(p.sku || ''),
    name: String(p.name || ''),
    price: exTax(raw == null ? null : raw / 10 ** minor, cfg),
    regularPrice: null,
    rawRegular: null,
    stockQty: null,
    currency: pr.currency_code || 'EUR',
    url: String(p.permalink || ''),
    image: p.images?.[0]?.src || '',
    inStock: p.is_in_stock !== false,
    categories: (p.categories || []).map((c) => c.name).filter(Boolean),
    code: '',
  };
}

function fromRestV3(p, cfg) {
  const meta = (p.meta_data || []).find((m) => m.key === 'aquatech_code');
  const regular = num(p.regular_price);
  return {
    id: String(p.id),
    sku: String(p.sku || ''),
    name: String(p.name || ''),
    price: exTax(num(p.price), cfg),
    // Normale prijs (zonder actie) en voorraad zoals de webshop ze bijhoudt;
    // null = niet ingevuld of geen voorraadbeheer in de webshop.
    regularPrice: regular == null ? null : exTax(regular, cfg),
    // Zoals de webshop hem opslaat (incl. of excl. btw), om te vergelijken.
    rawRegular: regular,
    stockQty: p.manage_stock && Number.isFinite(Number(p.stock_quantity)) ? Number(p.stock_quantity) : null,
    currency: 'EUR',
    url: String(p.permalink || ''),
    image: p.images?.[0]?.src || '',
    inStock: p.stock_status !== 'outofstock',
    categories: (p.categories || []).map((c) => c.name).filter(Boolean),
    code: meta ? String(meta.value || '').trim() : '',
  };
}

// Webadres controleren en opzoeken (geen intern adres).
async function checkedBase(cfg, { allowInsecure, resolveHost }) {
  const base = normalizeBaseUrl(cfg.url, { allowInsecure });
  if (!allowInsecure) {
    try {
      await resolveHost(new URL(base).hostname);
    } catch (err) {
      throw err.code === 'private_host'
        ? new SourceError('invalid_url', 'Dit is geen openbaar webadres.', 400)
        : new SourceError('unreachable', 'De webshop is niet gevonden: controleer het webadres.');
    }
  }
  return base;
}

function restAuth(cfg) {
  if (!cfg.consumerKey || !cfg.consumerSecret) throw new SourceError('missing_keys', 'Vul de consumer key en secret van de WooCommerce REST API in.', 400);
  return { Authorization: `Basic ${Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64')}` };
}

/**
 * Haalt alle gepubliceerde producten op en zet ze om naar het eigen formaat.
 * @param cfg {url, mode: 'store'|'rest', consumerKey, consumerSecret, pricesIncludeTax, vatRate}
 * ids: alleen deze producten (REST v3), bijv. vlak voor het terugschrijven.
 */
async function fetchProducts(cfg, { fetchImpl = fetch, allowInsecure = insecureAllowed(), resolveHost = publicAddress, ids = null } = {}) {
  const base = await checkedBase(cfg, { allowInsecure, resolveHost });
  const rest = cfg.mode === 'rest';
  if (ids && !rest) throw new SourceError('rest_required', 'Terugschrijven naar de webshop kan alleen via de REST API.', 400);
  const headers = rest ? restAuth(cfg) : {};
  const path = rest ? '/wp-json/wc/v3/products' : '/wp-json/wc/store/v1/products';
  const map = rest ? fromRestV3 : fromStoreApi;
  const products = [];
  if (ids) {
    for (let i = 0; i < ids.length; i += PER_PAGE) {
      const part = ids.slice(i, i + PER_PAGE).map(String).filter((v) => /^\d{1,20}$/.test(v));
      if (!part.length) continue;
      const qs = new URLSearchParams({ per_page: String(PER_PAGE), include: part.join(',') });
      const { body } = await getJson(`${base}${path}?${qs}`, headers, fetchImpl);
      if (!Array.isArray(body)) throw new SourceError('invalid_json', 'Onverwacht antwoord van de webshop (geen productlijst).');
      products.push(...body.map((p) => map(p, cfg)));
    }
    return products;
  }
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) });
    if (rest) qs.set('status', 'publish');
    const { body, totalPages } = await getJson(`${base}${path}?${qs}`, headers, fetchImpl);
    if (!Array.isArray(body)) throw new SourceError('invalid_json', 'Onverwacht antwoord van de webshop (geen productlijst).');
    products.push(...body.map((p) => map(p, cfg)));
    if (body.length < PER_PAGE || (totalPages && page >= totalPages)) break;
  }
  return products;
}

/** Prijs voor de webshop: excl. btw uit Aquatech, incl. als de webshop zo rekent. */
function shopPrice(priceExcl, vatRate, cfg) {
  return round2(cfg.pricesIncludeTax ? priceExcl * (1 + (Number(vatRate) || 0) / 100) : priceExcl);
}

/**
 * Schrijft prijs en/of voorraad terug (REST v3, batch van hooguit 100).
 * updates: [{ id, price (excl. btw), vatRate, stockQty }]; een veld dat
 * ontbreekt blijft in de webshop zoals het is. Geeft per product { id, ok,
 * error }.
 */
async function updateProducts(cfg, updates, { fetchImpl = fetch, allowInsecure = insecureAllowed(), resolveHost = publicAddress } = {}) {
  if (cfg.mode !== 'rest') throw new SourceError('rest_required', 'Terugschrijven naar de webshop kan alleen via de REST API.', 400);
  const base = await checkedBase(cfg, { allowInsecure, resolveHost });
  const headers = restAuth(cfg);
  const out = [];
  for (let i = 0; i < updates.length; i += PER_PAGE) {
    const part = updates.slice(i, i + PER_PAGE).map((u) => {
      const p = { id: Number(u.id) };
      if (u.price != null) p.regular_price = shopPrice(u.price, u.vatRate, cfg).toFixed(2);
      if (u.stockQty != null) { p.manage_stock = true; p.stock_quantity = Math.max(0, Math.floor(u.stockQty)); }
      return p;
    });
    const { body } = await getJson(`${base}/wp-json/wc/v3/products/batch`, headers, fetchImpl, { method: 'POST', body: { update: part } });
    const done = new Map((Array.isArray(body && body.update) ? body.update : []).map((p) => [String(p.id), p]));
    for (const p of part) {
      const r = done.get(String(p.id));
      out.push(r && !r.error ? { id: String(p.id), ok: true } : { id: String(p.id), ok: false, error: String((r && r.error && r.error.message) || 'niet bijgewerkt').slice(0, 200) });
    }
  }
  return out;
}

/**
 * Bestellingen met een bepaalde status die sinds `after` (ISO-tijd) zijn
 * gewijzigd, oudste wijziging eerst (REST v3, leesrechten). Geeft de
 * bestellingen zoals WooCommerce ze stuurt; shoporders.js zet ze om.
 */
async function fetchOrders(cfg, { status = 'completed', after = '', fetchImpl = fetch, allowInsecure = insecureAllowed(), resolveHost = publicAddress, maxPages = 10 } = {}) {
  if (cfg.mode !== 'rest') throw new SourceError('rest_required', 'Bestellingen ophalen kan alleen via de REST API (met API-sleutels).', 400);
  const base = await checkedBase(cfg, { allowInsecure, resolveHost });
  const headers = restAuth(cfg);
  const orders = [];
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page), status, orderby: 'modified', order: 'asc', dates_are_gmt: 'true' });
    if (after) qs.set('modified_after', after);
    const { body, totalPages } = await getJson(`${base}/wp-json/wc/v3/orders?${qs}`, headers, fetchImpl);
    if (!Array.isArray(body)) throw new SourceError('invalid_json', 'Onverwacht antwoord van de webshop (geen bestellingen).');
    orders.push(...body);
    if (body.length < PER_PAGE || (totalPages && page >= totalPages)) break;
  }
  return orders;
}

/** Koppelinstelling (instelling shopSource) zonder sleutels; die staan apart en versleuteld. */
function sanitizeShop(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let url = '';
  try { url = r.url ? normalizeBaseUrl(r.url) : ''; } catch { url = ''; }
  const vat = Number(r.vatRate);
  const mapping = {};
  if (r.mapping && typeof r.mapping === 'object' && !Array.isArray(r.mapping)) {
    for (const [code, sku] of Object.entries(r.mapping).slice(0, 500)) {
      if (/^[A-Z0-9-]{1,40}$/.test(code) && typeof sku === 'string' && sku.trim()) mapping[code] = sku.trim().slice(0, 100);
    }
  }
  return {
    type: 'woocommerce',
    url,
    mode: r.mode === 'rest' ? 'rest' : 'store',
    pricesIncludeTax: r.pricesIncludeTax !== false,
    vatRate: [0, 9, 21].includes(vat) ? vat : 21,
    // Prijzen en voorraad uit Aquatech naar de webshop sturen (REST API met
    // schrijfrechten); uit = de webshop blijft leidend voor de prijzen.
    push: r.mode === 'rest' && r.push === true,
    pushStock: r.pushStock !== false,
    mapping,
  };
}

module.exports = { fetchProducts, fetchOrders, updateProducts, shopPrice, normalizeBaseUrl, sanitizeShop, SourceError };
