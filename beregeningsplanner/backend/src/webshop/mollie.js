// Koppeling met Mollie voor online betalen in de eigen webshop (iDEAL, kaart
// en wat de beheerder in Mollie aanzet): een betaling aanmaken en opvragen via
// de Mollie API v2, en de instelling `shopPayment` (aan/uit, webadres van de
// webshop, op rekening, bewaartijd). De API-sleutel staat versleuteld in de
// instelling `mollieApiKey` en gaat nooit naar de browser. De klant betaalt op
// de pagina van Mollie; de uitkomst halen we altijd zelf bij Mollie op
// (nooit uit het verzoek van de klant of de webhook).

/** Basisadres van de Mollie API. */
const API = 'https://api.mollie.com/v2';
/** Wie op rekening mag bestellen als dat aan staat. */
const ON_ACCOUNT = ['iedereen', 'zakelijk', 'nooit'];
/** Standaard aantal uren dat een onbetaalde bestelling de voorraad vasthoudt. */
const DEFAULT_HOLD_HOURS = 24;
/** Hoe lang we op Mollie wachten (milliseconden). */
const TIMEOUT_MS = 15000;

/**
 * Een fout van Mollie of bij het bereiken van Mollie.
 */
class MollieError extends Error {
  /**
   * Maakt de fout.
   * @param {string} message De melding (nooit de sleutel).
   * @param {number} [status] De HTTP-status van Mollie (0 als Mollie niet bereikbaar was).
   */
  constructor(message, status = 0) {
    super(message);
    this.name = 'MollieError';
    this.status = status;
  }
}

/**
 * Maakt van het ingevulde webadres van de webshop een adres met slash achteraan.
 * Alleen https; http alleen voor localhost (tests en ontwikkeling).
 * @param {*} raw Het ingevulde adres.
 * @returns {string} Het gesaneerde adres, of een lege tekst.
 */
function cleanPublicUrl(raw) {
  let url;
  try { url = new URL(String(raw == null ? '' : raw).trim().slice(0, 200)); } catch { return ''; }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return '';
  if (url.username || url.password) return '';
  const pathName = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `${url.origin}${pathName}`;
}

/**
 * Saneert de instelling `shopPayment`. Lege of onbruikbare invoer geeft de standaardwaarden.
 * @param {*} raw De ingevoerde instelling.
 * @returns {{ online: boolean, publicUrl: string, onAccount: string, holdHours: number }} De gesaneerde instelling.
 */
function sanitizePayment(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const hours = Math.floor(Number(input.holdHours));
  return {
    online: input.online === true,
    publicUrl: cleanPublicUrl(input.publicUrl),
    onAccount: ON_ACCOUNT.includes(input.onAccount) ? input.onAccount : 'iedereen',
    holdHours: Number.isFinite(hours) && hours >= 1 && hours <= 168 ? hours : DEFAULT_HOLD_HOURS,
  };
}

/**
 * Of een tekst de vorm van een Mollie-API-sleutel heeft (test_ of live_ plus tekens).
 * @param {*} value De sleutel.
 * @returns {boolean} true bij een sleutel die Mollie kan accepteren.
 */
const validApiKey = (value) => /^(test|live)_[A-Za-z0-9]{8,}$/.test(String(value || ''));

/**
 * De betaalinstelling van een omgeving, met bepaald of online betalen kan.
 * @param {object} settings De instellingen van de omgeving (settingsFor).
 * @returns {{ online: boolean, wanted: boolean, apiKey: string, publicUrl: string, onAccount: string, holdHours: number, mode: string }} online is alleen waar als het aan staat, de sleutel de vorm test_/live_ heeft en het webadres klopt; wanted is of de beheerder online betalen heeft aangezet (ook als de sleutel of het webadres niet klopt); mode is test of live (naar de sleutel).
 */
function configOf(settings) {
  const config = sanitizePayment(settings.get('shopPayment'));
  const apiKey = String(settings.get('mollieApiKey') || '');
  return { ...config, apiKey, wanted: config.online, online: config.online && validApiKey(apiKey) && Boolean(config.publicUrl), mode: apiKey.startsWith('live_') ? 'live' : 'test' };
}

/**
 * Of een tekst een Mollie-betaling-id is.
 * @param {*} value De tekst.
 * @returns {boolean} true bij een geldig id (tr_…).
 */
const validPaymentId = (value) => /^tr_[A-Za-z0-9]{4,40}$/.test(String(value || ''));

/**
 * Maakt de Mollie-client.
 * @param {{ fetchImpl?: Function }} [options] fetchImpl vervangt de netwerkaanroep (tests).
 * @returns {{ createPayment: Function, getPayment: Function }} De functies.
 */
function createMollie({ fetchImpl = fetch } = {}) {
  /**
   * Doet een aanroep naar Mollie en geeft het antwoord als object.
   * @param {string} apiKey De API-sleutel.
   * @param {string} method GET of POST.
   * @param {string} apiPath Het pad onder /v2.
   * @param {{ body?: object, idempotencyKey?: string }} [options] De inhoud en de sleutel tegen dubbel aanmaken.
   * @returns {Promise<object>} Het antwoord van Mollie.
   */
  async function call(apiKey, method, apiPath, { body, idempotencyKey } = {}) {
    let response;
    try {
      response = await fetchImpl(`${API}${apiPath}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new MollieError(`Mollie is niet bereikbaar: ${error.message}`);
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const detail = payload && (payload.detail || payload.title) ? String(payload.detail || payload.title).slice(0, 200) : `HTTP ${response.status}`;
      throw new MollieError(`Mollie weigert het verzoek: ${detail}`, response.status);
    }
    return payload || {};
  }

  /**
   * Maakt een betaling aan.
   * @param {string} apiKey De API-sleutel.
   * @param {{ amount: number, description: string, redirectUrl: string, webhookUrl: string, metadata: object, idempotencyKey: string }} payment Bedrag in euro, omschrijving, waar de klant na het betalen heen gaat, de webhook, gegevens die Mollie terugstuurt en de sleutel tegen dubbel aanmaken.
   * @returns {Promise<{ id: string, status: string, checkoutUrl: string, mode: string }>} Het id, de status en het adres van de betaalpagina.
   */
  async function createPayment(apiKey, { amount, description, redirectUrl, webhookUrl, metadata, idempotencyKey }) {
    const out = await call(apiKey, 'POST', '/payments', {
      idempotencyKey,
      body: { amount: { currency: 'EUR', value: (Math.round(amount * 100) / 100).toFixed(2) }, description: String(description).slice(0, 255), redirectUrl, webhookUrl, locale: 'nl_NL', metadata },
    });
    const checkoutUrl = out._links && out._links.checkout && out._links.checkout.href;
    if (!validPaymentId(out.id) || !checkoutUrl) throw new MollieError('Mollie gaf geen betaalpagina terug.');
    return { id: out.id, status: String(out.status || 'open'), checkoutUrl: String(checkoutUrl), mode: String(out.mode || '') };
  }

  /**
   * Vraagt een betaling op.
   * @param {string} apiKey De API-sleutel.
   * @param {string} id Het Mollie-betaling-id (tr_…).
   * @returns {Promise<{ id: string, status: string, method: string, paidAt: ?string, amount: number, orderId: string, checkoutUrl: string, mode: string }>} De stand van de betaling.
   */
  async function getPayment(apiKey, id) {
    if (!validPaymentId(id)) throw new MollieError('Ongeldig betaling-id.', 422);
    const out = await call(apiKey, 'GET', `/payments/${id}`);
    const checkout = out._links && out._links.checkout && out._links.checkout.href;
    return {
      id: String(out.id || id), status: String(out.status || ''), method: String(out.method || ''), paidAt: out.paidAt ? String(out.paidAt) : null,
      amount: out.amount ? Number(out.amount.value) : NaN, orderId: out.metadata && typeof out.metadata === 'object' ? String(out.metadata.orderId || '') : '',
      checkoutUrl: checkout ? String(checkout) : '', mode: String(out.mode || ''),
    };
  }

  return { createPayment, getPayment };
}

module.exports = { createMollie, MollieError, sanitizePayment, configOf, validPaymentId, cleanPublicUrl, ON_ACCOUNT, DEFAULT_HOLD_HOURS };
