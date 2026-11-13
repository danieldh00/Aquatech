// Kleine cache in het geheugen voor afbeeldingen die vaak worden opgevraagd
// (artikelfoto's en afbeeldingen van de webshop). Zonder cache haalt elk
// verzoek de versleutelde afbeelding uit de database (bij PostgreSQL een
// rondgang over het netwerk die de server even blokkeert) en ontsleutelt hem.
// Begrensd op totale grootte (minst recent gebruikt eerst eruit) en op
// leeftijd. De opslag wist een afbeelding hier zelf zodra hij verwijderd of
// opgeruimd wordt; na het wissen van een hele omgeving (store.js) verdwijnt
// hij na de bewaartijd. Afbeeldingen veranderen nooit onder hetzelfde id.

/**
 * Maakt een cache met een grens op het aantal bytes en op de leeftijd.
 * @param {{ maxBytes?: number, maxEntryBytes?: number, ttlMs?: number }} [options] maxBytes = totaal, maxEntryBytes = grootste afbeelding die erin mag, ttlMs = hoe lang een afbeelding blijft.
 * @returns {{ get: Function, set: Function, remove: Function, clearTenant: Function, clear: Function, stats: Function }} De functies.
 */
function createImageCache({ maxBytes = 48 * 1024 * 1024, maxEntryBytes = 4 * 1024 * 1024, ttlMs = 10 * 60 * 1000 } = {}) {
  const entries = new Map();
  let totalBytes = 0;

  /**
   * De sleutel van een afbeelding.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} imageId Id van de afbeelding.
   * @returns {string} De sleutel.
   */
  const keyOf = (tenantId, imageId) => `${tenantId}\u0000${imageId}`;

  /**
   * Haalt een afbeelding weg en telt de bytes terug.
   * @param {string} key De sleutel.
   * @returns {void}
   */
  const drop = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    totalBytes -= entry.file.body.length;
    entries.delete(key);
  };

  return {
    /**
     * Een afbeelding uit de cache (en markeert hem als recent gebruikt).
     * @param {string} tenantId Id van de omgeving.
     * @param {string} imageId Id van de afbeelding.
     * @returns {{ mime: string, body: Buffer }|null} De afbeelding, of null als hij er niet (meer) in zit.
     */
    get(tenantId, imageId) {
      const key = keyOf(tenantId, imageId);
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.until <= Date.now()) { drop(key); return null; }
      entries.delete(key);
      entries.set(key, entry);
      return entry.file;
    },
    /**
     * Bewaart een afbeelding; de minst recent gebruikte gaan eruit als het totaal te groot wordt.
     * @param {string} tenantId Id van de omgeving.
     * @param {string} imageId Id van de afbeelding.
     * @param {{ mime: string, body: Buffer }} file De afbeelding.
     * @returns {void}
     */
    set(tenantId, imageId, file) {
      if (!file || !Buffer.isBuffer(file.body) || file.body.length > maxEntryBytes) return;
      const key = keyOf(tenantId, imageId);
      drop(key);
      entries.set(key, { file, until: Date.now() + ttlMs });
      totalBytes += file.body.length;
      for (const oldest of entries.keys()) {
        if (totalBytes <= maxBytes) break;
        drop(oldest);
      }
    },
    /**
     * Haalt één afbeelding uit de cache (na verwijderen in de database).
     * @param {string} tenantId Id van de omgeving.
     * @param {string} imageId Id van de afbeelding.
     * @returns {void}
     */
    remove(tenantId, imageId) { drop(keyOf(tenantId, imageId)); },
    /**
     * Haalt alle afbeeldingen van één omgeving uit de cache (na opruimen of wissen).
     * @param {string} tenantId Id van de omgeving.
     * @returns {void}
     */
    clearTenant(tenantId) {
      const prefix = `${tenantId}\u0000`;
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) drop(key);
    },
    /**
     * Leegt de hele cache.
     * @returns {void}
     */
    clear() { entries.clear(); totalBytes = 0; },
    /**
     * Hoeveel afbeeldingen en bytes er in de cache zitten (tests).
     * @returns {{ count: number, bytes: number }} Aantal en totaal.
     */
    stats: () => ({ count: entries.size, bytes: totalBytes }),
  };
}

module.exports = { createImageCache };
