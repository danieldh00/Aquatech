// Beperkt hoeveel mails per ontvanger (e-mailadres) per tijdvenster via een route mogen gaan, zodat één adres
// niet met offertemails overspoeld kan worden, ook niet door meerdere medewerkers samen. Telling in het geheugen
// (één container), per organisatie apart.

/**
 * Maakt een teller per ontvanger.
 * @param {{ windowMs?: number, max?: number }} [options] Lengte van het venster in ms en het maximum aantal mails per adres.
 * @returns {{ take: Function, release: Function }} take(tenantId, addresses) reserveert een plek per adres, release(tenantId, addresses) geeft die terug.
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
   * Reserveert in één stap een plek per adres (er zit geen await tussen controle en telling, dus parallelle verzoeken
   * kunnen er niet langs). Past een adres niet, dan wordt er niets gereserveerd.
   * @param {string} tenantId De organisatie.
   * @param {string[]} addresses De ontvangers van de mail.
   * @returns {boolean} True als elk adres nog ruimte had en de plekken zijn gereserveerd.
   */
  function take(tenantId, addresses) {
    const entries = entriesOf(tenantId, addresses);
    if (entries.some(([, entry]) => entry.count >= max)) return false;
    for (const [key, entry] of entries) {
      entry.count += 1;
      hits.set(key, entry);
    }
    return true;
  }

  /**
   * Geeft de plekken van een eerdere take terug, voor een mail die uiteindelijk niet is verstuurd.
   * @param {string} tenantId De organisatie.
   * @param {string[]} addresses De ontvangers van de mail.
   * @returns {void}
   */
  function release(tenantId, addresses) {
    const now = Date.now();
    for (const [key] of entriesOf(tenantId, addresses)) {
      const entry = hits.get(key);
      if (entry && entry.reset > now && entry.count > 0) entry.count -= 1;
    }
  }

  return { take, release };
}

module.exports = { createRecipientLimit };
