// Controle op tijdstippen uit een zoekopdracht of cursor: alleen echte datums gaan naar een TIMESTAMPTZ-kolom.

/**
 * Is dit tekst die als bestaand ISO-tijdstip te lezen is? Een onmogelijke datum zoals 31 februari valt af,
 * want JavaScript rekent die door naar maart maar PostgreSQL weigert hem.
 * @param {*} text De waarde uit de zoekopdracht of cursor.
 * @returns {boolean} Waar bij een bestaande ISO-datum, eventueel met tijd.
 */
function isInstant(text) {
  if (typeof text !== 'string' || text.length > 40) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}.*)?$/.exec(text);
  if (!match) return false;
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return false;
  const check = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return check.getUTCFullYear() === Number(match[1]) && check.getUTCMonth() === Number(match[2]) - 1 && check.getUTCDate() === Number(match[3]);
}

module.exports = { isInstant };
