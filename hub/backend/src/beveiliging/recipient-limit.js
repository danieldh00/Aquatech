// Beperkt hoeveel mails per ontvanger (e-mailadres) per tijdvenster via een route mogen gaan, zodat één adres
// niet met offertemails overspoeld kan worden, ook niet door meerdere medewerkers samen. Telling in het geheugen
// (één container), per organisatie apart.

/**
 * Maakt een teller per ontvanger.
 * @param {{ windowMs?: number, max?: number }} [options] Lengte van het venster in ms en het maximum aantal mails per adres.
 * @returns {{ allowed: Function, record: Function }} allowed(tenantId, addresses) controleert zonder te tellen, record(tenantId, addresses) telt een verstuurde mail.
 */
function createRecipientLimit({ windowMs = 60 * 60 * 1000, max = 5 } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  timer.unref();

  /**
   * Zoekt per adres de teller van het lopende venster (nieuw en leeg als er nog geen is of het venster voorbij is).
   * @param {string} tenantId De organisatie.
   * @param {string[]} addresses De ontvangers van de mail.
   * @returns {Array} Paren [sleutel, teller] zonder dubbele adressen.
   */
  function entriesOf(tenantId, addresses) {
    const now = Date.now();
    const keys = [...new Set(addresses.map((address) => `${tenantId}|${String(address).trim().toLowerCase()}`))];
    return keys.map((key) => {
      const entry = hits.get(key);
      return [key, !entry || entry.reset <= now ? { count: 0, reset: now + windowMs } : entry];
    });
  }

  /**
   * Meldt of er nog een mail naar elk van deze adressen mag, zonder iets te tellen.
   * @param {string} tenantId De organisatie.
   * @param {string[]} addresses De ontvangers van de mail.
   * @returns {boolean} True als elk adres onder de limiet blijft.
   */
  function allowed(tenantId, addresses) {
    return entriesOf(tenantId, addresses).every(([, entry]) => entry.count < max);
  }

  /**
   * Telt één verstuurde mail per adres mee. Aanroepen na een geslaagde verzending.
   * @param {string} tenantId De organisatie.
   * @param {string[]} addresses De ontvangers van de mail.
   * @returns {void}
   */
  function record(tenantId, addresses) {
    for (const [key, entry] of entriesOf(tenantId, addresses)) {
      entry.count += 1;
      hits.set(key, entry);
    }
  }

  return { allowed, record };
}

module.exports = { createRecipientLimit };
