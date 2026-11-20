// Zet de typeparsers van de pg-driver zo dat de code gelijk blijft als kolommen later van type veranderen
// (opzet-timestamptz-uuid.md, stap 1): de rest van de app ziet dezelfde JavaScript-waarden als bij de huidige tekstkolommen.
const { types } = require('pg');

/** Typenummers van PostgreSQL (pg_type.oid). */
const OID = { BOOL: 16, INT8: 20, TIMESTAMP: 1114, TIMESTAMPTZ: 1184, NUMERIC: 1700, JSONB: 3802 };

/**
 * Zet een tijdstip uit PostgreSQL om naar de ISO-tekst met milliseconden en Z (UTC), zoals de app die tot nu toe bewaart.
 * Zo blijven vergelijkingen op tekst (`created_at < ?`) en sorteren gelijk.
 * @param {string} text Het tijdstip zoals PostgreSQL het teruggeeft.
 * @param {boolean} withZone Of de tekst een tijdzone bevat (timestamptz); zonder wordt UTC aangenomen.
 * @returns {string} ISO-tekst, bijvoorbeeld 2026-11-20T17:58:05.283Z.
 */
function isoOf(text, withZone) {
  const date = new Date(withZone ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

/**
 * Registreert de parsers in de pg-driver van deze thread (elke werkthread en de pool roepen dit zelf aan).
 * BIGINT en NUMERIC komen als gewoon getal, tijdstippen als ISO-tekst, jsonb als JSON-tekst en een boolean als 1 of 0
 * (de vlaggen in de app zijn getallen).
 */
function registerTypeParsers() {
  types.setTypeParser(OID.INT8, (text) => Number(text));
  types.setTypeParser(OID.NUMERIC, (text) => Number(text));
  types.setTypeParser(OID.TIMESTAMPTZ, (text) => isoOf(text, true));
  types.setTypeParser(OID.TIMESTAMP, (text) => isoOf(text, false));
  types.setTypeParser(OID.JSONB, (text) => text);
  types.setTypeParser(OID.BOOL, (text) => (text === 't' ? 1 : 0));
}

module.exports = { registerTypeParsers, isoOf, OID };
