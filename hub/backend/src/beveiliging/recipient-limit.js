// Beperkt hoeveel mails per ontvanger (e-mailadres) per tijdvenster via een route mogen gaan, zodat één adres
// niet met offertemails overspoeld kan worden, ook niet door meerdere medewerkers samen. Telling in het geheugen
// (één container), per organisatie apart.

/**
 * Maakt een teller per ontvanger.
 * @param {{ windowMs?: number, max?: number }} [options] Lengte van het venster in ms en het maximum aantal mails per adres.
 * @returns {{ take: Function }} Object met take(tenantId, addresses): true als alle adressen nog ruimte hebben.
 */
function createRecipientLimit({ windowMs = 60 * 60 * 1000, max = 5 } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  timer.unref();

  /**
   * Telt één mail per adres mee en meldt of dat binnen de limiet past. Past een adres niet, dan wordt er niets geteld.
   * @param {string} tenantId De organisatie.
   * @param {string[]} addresses De ontvangers van de mail.
   * @returns {boolean} True als elk adres onder de limiet blijft.
   */
  function take(tenantId, addresses) {
    const now = Date.now();
    const keys = [...new Set(addresses.map((address) => `${tenantId}|${String(address).trim().toLowerCase()}`))];
    const entries = keys.map((key) => {
      let entry = hits.get(key);
      if (!entry || entry.reset <= now) entry = { count: 0, reset: now + windowMs };
      return [key, entry];
    });
    if (entries.some(([, entry]) => entry.count >= max)) return false;
    for (const [key, entry] of entries) {
      entry.count += 1;
      hits.set(key, entry);
    }
    return true;
  }

  return { take };
}

module.exports = { createRecipientLimit };
