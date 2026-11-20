// Kleine hulpfuncties van de gegevenslaag: tijdstip en nieuw id.
const crypto = require('crypto');

/**
 * Huidig tijdstip als ISO-tekst.
 * @returns {string} Tijdstip in ISO 8601.
 */
const currentTimestamp = () => new Date().toISOString();
/**
 * Nieuw willekeurig id (UUID).
 * @returns {string} Het id.
 */
const newId = () => crypto.randomUUID();

module.exports = { currentTimestamp, newId };
