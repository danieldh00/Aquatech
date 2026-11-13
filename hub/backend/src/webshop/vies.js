// Controle van een Europees btw-nummer bij VIES (de btw-database van de
// Europese Commissie), bevinding W-01 uit de audit van 1.7.3. De webshop
// verlegt de btw alleen met het btw-nummer dat een beheerder bij het
// zakelijke account heeft goedgekeurd én dat VIES op het moment van bestellen
// geldig noemt. De uitkomst (met het consultatienummer als het eigen
// btw-nummer bekend is) gaat mee in de bestelling als bewijs voor de
// Belastingdienst. Het adres is vast; er gaat alleen het btw-nummer heen.

/** Adres van de VIES REST-API (vast, geen invoer van een tenant). */
const VIES_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';
/** Hoe lang een uitkomst (geldig of ongeldig) onthouden wordt. */
const CACHE_MS = 6 * 60 * 60 * 1000;
/** Maximum aantal onthouden uitkomsten. */
const CACHE_MAX = 1000;
/** Wachttijd op VIES voordat we opgeven. */
const TIMEOUT_MS = 6000;

/**
 * Splitst een genormaliseerd btw-nummer in landcode en nummer.
 * @param {string} vatNumber Bijvoorbeeld BE0123456789.
 * @returns {{ countryCode: string, number: string }} Landvoorvoegsel (EL voor Griekenland) en de rest.
 */
function splitVatNumber(vatNumber) {
  const text = String(vatNumber || '');
  return { countryCode: text.slice(0, 2), number: text.slice(2) };
}

/**
 * Maakt de VIES-controle.
 * @param {{ fetchImpl?: Function, now?: Function }} [options] fetch (tests vervangen hiermee VIES) en de klok.
 * @returns {{ check: Function }} De controle.
 */
function createVies({ fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  const cache = new Map();

  /**
   * Controleert een btw-nummer bij VIES.
   * @param {string} vatNumber Het genormaliseerde btw-nummer van de klant.
   * @param {string} [requesterVatNumber] Het eigen btw-nummer (bedrijfsprofiel); dan geeft VIES een consultatienummer.
   * @returns {Promise<{ status: 'geldig'|'ongeldig'|'onbereikbaar', checkedAt: string, requestId: string, name: string }>} De uitkomst.
   */
  async function check(vatNumber, requesterVatNumber = '') {
    const key = `${vatNumber}|${requesterVatNumber}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.result;
    const customer = splitVatNumber(vatNumber);
    const requester = splitVatNumber(requesterVatNumber);
    const body = { countryCode: customer.countryCode, vatNumber: customer.number };
    if (requester.countryCode && requester.number) Object.assign(body, { requesterMemberStateCode: requester.countryCode, requesterNumber: requester.number });
    const checkedAt = new Date(now()).toISOString();
    let result;
    try {
      const response = await fetchImpl(VIES_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const answer = await response.json().catch(() => null);
      if (!response.ok || !answer || typeof answer.valid !== 'boolean') {
        result = { status: 'onbereikbaar', checkedAt, requestId: '', name: '' };
      } else {
        result = {
          status: answer.valid ? 'geldig' : 'ongeldig', checkedAt,
          requestId: String(answer.requestIdentifier || '').slice(0, 60), name: String(answer.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120),
        };
      }
    } catch (error) {
      result = { status: 'onbereikbaar', checkedAt, requestId: '', name: '' };
    }
    // Een storing niet onthouden: de volgende poging vraagt het opnieuw.
    if (result.status !== 'onbereikbaar') {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { result, expires: now() + CACHE_MS });
    }
    return result;
  }

  return { check };
}

module.exports = { createVies, splitVatNumber, VIES_URL };
