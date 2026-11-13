// Verlopen van openbare klantlinks (offerte en afspraak, bevinding G-02 uit de
// audit van 1.7.3). Een link werkt tot 180 dagen na het delen, en in elk geval
// tot 90 dagen na de datum waar hij over gaat (geldig-tot van de offerte,
// geplande datum van de werkorder). Daarna geeft de link 404 en moet de
// afzender hem opnieuw delen. Zo geeft een doorgestuurde of gelekte mail niet
// blijvend inzage in naam, adres en bedragen.

/** Dagen na het delen dat een link in elk geval werkt. */
const DAYS_AFTER_SHARING = 180;
/** Dagen na de datum van de offerte of afspraak dat een link nog werkt. */
const DAYS_AFTER_REFERENCE = 90;
const DAY_MS = 86400000;

/**
 * Leest een datum of tijdstip als milliseconden.
 * @param {string|null|undefined} value ISO-datum of -tijdstip.
 * @returns {number|null} Milliseconden sinds 1970, of null als er niets bruikbaars staat.
 */
function timeOf(value) {
  if (!value) return null;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : null;
}

/**
 * Is een openbare link verlopen?
 * @param {{ sharedAt?: string|null, referenceDate?: string|null }} link Moment van delen en de datum waar de link over gaat.
 * @param {number} [now] Huidig moment in milliseconden (tests).
 * @returns {boolean} true als de link niet meer mag werken.
 */
function linkExpired({ sharedAt, referenceDate }, now = Date.now()) {
  const shared = timeOf(sharedAt);
  const reference = timeOf(referenceDate);
  const limits = [];
  if (shared !== null) limits.push(shared + DAYS_AFTER_SHARING * DAY_MS);
  if (reference !== null) limits.push(reference + DAYS_AFTER_REFERENCE * DAY_MS);
  // Zonder enig moment (zou niet voorkomen) niet stil laten verlopen.
  if (!limits.length) return false;
  return now > Math.max(...limits);
}

module.exports = { linkExpired, DAYS_AFTER_SHARING, DAYS_AFTER_REFERENCE };
