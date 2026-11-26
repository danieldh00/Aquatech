// Archieffilter voor lijstqueries: standaard zonder gearchiveerde stukken, met ?archief=toon ook die, met ?archief=alleen alleen het archief.

/**
 * Leest de archiefkeuze uit een queryparameter.
 * @param {*} value Waarde van `archief` (verberg, toon of alleen).
 * @returns {string} 'verberg' (standaard), 'toon' of 'alleen'.
 */
function archiveModeOf(value) {
  return value === 'toon' || value === 'alleen' ? value : 'verberg';
}

/**
 * SQL-voorwaarde voor de archiefkeuze, om aan een WHERE te plakken.
 * @param {string} column De kolom, bijvoorbeeld `q.archived_at`.
 * @param {string} [mode] verberg, toon of alleen.
 * @returns {string} Een voorwaarde met een voorafgaande ` AND `, of een lege tekst bij 'toon'.
 */
function archiveClause(column, mode = 'verberg') {
  if (mode === 'toon') return '';
  return mode === 'alleen' ? ` AND ${column} IS NOT NULL` : ` AND ${column} IS NULL`;
}

module.exports = { archiveModeOf, archiveClause };
