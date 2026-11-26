// Ondergrens voor documentnummers: bij het definitief verwijderen van het archief wordt het hoogste volgnummer per voorvoegsel vastgelegd,
// zodat een nummer nooit opnieuw wordt uitgegeven (offertes, werkorders, facturen en webshopbestellingen).

/**
 * Splitst een documentnummer in voorvoegsel (met streepje) en volgnummer.
 * @param {string} number Bijvoorbeeld `O2026-0007`.
 * @returns {{ head: string, sequence: number }|null} Voorvoegsel en volgnummer, of null als het geen gewoon volgnummer is.
 */
function splitNumber(number) {
  const text = String(number || '');
  const dash = text.lastIndexOf('-');
  if (dash < 0) return null;
  const sequence = Number(text.slice(dash + 1));
  return Number.isInteger(sequence) && sequence > 0 ? { head: text.slice(0, dash + 1), sequence } : null;
}

/**
 * Legt vast dat een nummer is uitgegeven, zodat het nooit terugkomt.
 * @param {function(string): object} prepare De database-prepare.
 * @param {string} tenantId Id van de omgeving.
 * @param {string} kind offertes, werkorders, facturen of bestellingen.
 * @param {string} number Het nummer.
 * @returns {void}
 */
function recordFloor(prepare, tenantId, kind, number) {
  const parts = splitNumber(number);
  if (!parts) return;
  prepare(`INSERT INTO number_floors (tenant_id, kind, head, floor) VALUES (?, ?, ?, ?)
    ON CONFLICT (tenant_id, kind, head) DO UPDATE SET floor = GREATEST(number_floors.floor, EXCLUDED.floor)`).run(tenantId, kind, parts.head, parts.sequence);
}

/**
 * De hoogste vastgelegde volgnummer voor een voorvoegsel.
 * @param {function(string): object} prepare De database-prepare.
 * @param {string} tenantId Id van de omgeving.
 * @param {string} kind offertes, werkorders, facturen of bestellingen.
 * @param {string} head Voorvoegsel met streepje, bijvoorbeeld `O2026-`.
 * @returns {number} Het hoogste uitgegeven volgnummer (0 als er niets vastligt).
 */
function floorOf(prepare, tenantId, kind, head) {
  const row = prepare('SELECT floor FROM number_floors WHERE tenant_id = ? AND kind = ? AND head = ?').get(tenantId, kind, head);
  return row ? Number(row.floor) : 0;
}

module.exports = { recordFloor, floorOf, splitNumber };
