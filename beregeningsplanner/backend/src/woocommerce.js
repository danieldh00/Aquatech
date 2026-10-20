// Adapter voor WooCommerce-webshops. Twee manieren om producten op te halen:
//  - 'store': de openbare Store API (/wp-json/wc/store/v1/products), geen
//    sleutels nodig; prijzen zoals de shop ze toont.
//  - 'rest':  de REST API v3 (/wp-json/wc/v3/products) met consumer key en
//    secret (alleen-lezen volstaat); geeft ook meta_data (aquatech_code).
// Variaties van variabele producten worden in dit prototype niet opgehaald.

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

async function getJson(url, headers, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'De webshop reageert niet (time-out).' : 'De webshop is niet bereikbaar (of stuurt door naar een ander adres: vul het juiste adres in).';
    throw new SourceError('unreachable', msg);
  }
  if (res.status === 401 || res.status === 403) throw new SourceError('unauthorized', 'De webshop weigert de toegang: controleer de API-sleutels (leesrechten).');
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
  return {
    id: String(p.id),
    sku: String(p.sku || ''),
    name: String(p.name || ''),
    price: exTax(num(p.price), cfg),
    currency: 'EUR',
    url: String(p.permalink || ''),
    image: p.images?.[0]?.src || '',
    inStock: p.stock_status !== 'outofstock',
    categories: (p.categories || []).map((c) => c.name).filter(Boolean),
    code: meta ? String(meta.value || '').trim() : '',
  };
}

/**
 * Haalt alle gepubliceerde producten op en zet ze om naar het eigen formaat.
 * @param cfg {url, mode: 'store'|'rest', consumerKey, consumerSecret, pricesIncludeTax, vatRate}
 */
async function fetchProducts(cfg, { fetchImpl = fetch, allowInsecure = insecureAllowed(), resolveHost = publicAddress } = {}) {
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
  const rest = cfg.mode === 'rest';
  const headers = {};
  if (rest) {
    if (!cfg.consumerKey || !cfg.consumerSecret) throw new SourceError('missing_keys', 'Vul de consumer key en secret van de WooCommerce REST API in.', 400);
    headers.Authorization = `Basic ${Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64')}`;
  }
  const path = rest ? '/wp-json/wc/v3/products' : '/wp-json/wc/store/v1/products';
  const map = rest ? fromRestV3 : fromStoreApi;
  const products = [];
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
    mapping,
  };
}

module.exports = { fetchProducts, normalizeBaseUrl, sanitizeShop, SourceError };
