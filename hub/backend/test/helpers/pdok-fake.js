// Nagebootste PDOK Locatieserver voor tests: nooit echt naar PDOK bellen.
const assert = require('node:assert');

/**
 * Nagebootste PDOK Locatieserver met een paar adressen.
 * @returns {{ fetchImpl: Function, calls: string[], down: { on: boolean } }} fetchImpl voor createAddressLookup, de opgevraagde adressen en down.on om PDOK onbereikbaar te maken.
 */
function createPdokFake() {
  const calls = [];
  const down = { on: false };
  const documents = {
    '8071AB|1': [{ straatnaam: 'Tuinstraat', huisnummer: 1, postcode: '8071AB', woonplaatsnaam: 'Nunspeet' }],
    '8071AB|2': [{ straatnaam: 'Tuinstraat', huisnummer: 2, postcode: '8071AB', woonplaatsnaam: 'Nunspeet' }],
    '8071AB|3': [{ straatnaam: 'Tuinstraat', huisnummer: 3, postcode: '8071AB', woonplaatsnaam: 'Nunspeet' }],
    '8071AB|12': [
      { straatnaam: 'Tuinstraat', huisnummer: 12, huisletter: 'A', postcode: '8071AB', woonplaatsnaam: 'Nunspeet' },
      { straatnaam: 'Tuinstraat', huisnummer: 12, postcode: '8071AB', woonplaatsnaam: 'Nunspeet' },
      { straatnaam: 'Tuinstraat', huisnummer: 12, huisnummertoevoeging: '2', postcode: '8071AB', woonplaatsnaam: 'Nunspeet' },
    ],
  };
  /**
   * Doet alsof dit PDOK is.
   * @param {string} url Het opgevraagde adres.
   * @returns {Promise<{ ok: boolean, status: number, json: Function }>} Het antwoord.
   */
  const fetchImpl = async (url) => {
    calls.push(url);
    if (down.on) throw new Error('netwerk weg');
    const parsed = new URL(url);
    assert.strictEqual(parsed.origin + parsed.pathname, 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free');
    const filters = parsed.searchParams.getAll('fq');
    const postcode = filters.find((filter) => filter.startsWith('postcode:')).slice(9);
    const houseNumber = filters.find((filter) => filter.startsWith('huisnummer:')).slice(11);
    return { ok: true, status: 200, json: async () => ({ response: { docs: documents[`${postcode}|${houseNumber}`] || [] } }) };
  };
  return { fetchImpl, calls, down };
}

/** Een adres dat in de nagebootste PDOK bestaat, in de vorm waarin de app het invult (twee regels). */
const KNOWN_ADDRESS = 'Tuinstraat 1\n8071 AB Nunspeet';

module.exports = { createPdokFake, KNOWN_ADDRESS };
