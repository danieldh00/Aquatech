// Nagebootste VIES-API (webshop/vies.js) voor tests: geen echte aanroepen naar de EU.

/**
 * Maakt een nep-VIES.
 * @param {{ valid?: string[], down?: boolean }} [options] De btw-nummers die geldig zijn en of VIES onbereikbaar is.
 * @returns {{ fetchImpl: Function, calls: object[] }} fetch voor createApp({ viesFetch }) en de ontvangen verzoeken.
 */
function createViesFake({ valid = [], down = false } = {}) {
  const calls = [];
  const state = { down };
  /**
   * Beantwoordt een controle zoals de VIES REST-API.
   * @param {string} url Het adres.
   * @param {{ body: string }} init De aanvraag.
   * @returns {Promise<object>} Een antwoord met ok, status en json().
   */
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (state.down) return { ok: false, status: 503, json: async () => ({ actionSucceed: false }) };
    const isValid = valid.includes(`${body.countryCode}${body.vatNumber}`);
    return { ok: true, status: 200, json: async () => ({ valid: isValid, requestIdentifier: body.requesterNumber ? 'WAPIAAAAW1234567' : '', name: isValid ? 'BAKKER TUINEN BV' : '---' }) };
  };
  return { fetchImpl, calls, state };
}

module.exports = { createViesFake };
