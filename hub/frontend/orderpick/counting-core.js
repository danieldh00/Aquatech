// Rekenkern van het tellen in de orderpick-app (UMD, ook door de tests geladen): een gescande code bij een telregel zoeken, een ingevuld
// aantal binnen de grenzen zetten, de voortgang van een locatie optellen en de ingave klaarzetten voor
// POST /api/orderpick/counts/:id/lines/:lineId/count. De regels zijn blind: er komt nooit een verwacht aantal of een prijs in. Geen DOM, geen netwerk.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./orderpick-core'));
  else root.CountingCore = factory(root.OrderpickCore);
})(typeof self !== 'undefined' ? self : this, function (OrderpickCore) {
  const MAX_QTY = 1000000;

  /**
   * Zet een ingevuld aantal binnen de grenzen: 0 of een positief aantal tot het maximum, op drie decimalen.
   * @param {*} value Het ingevulde aantal (tekst of getal).
   * @returns {number|null} Het aantal, of null als er niets of iets ongeldigs is ingevuld (een lege invoer is niet 0).
   */
  function parseQuantity(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const wanted = Number(String(value).trim().replace(',', '.'));
    if (!Number.isFinite(wanted) || wanted < 0 || wanted > MAX_QTY) return null;
    return Math.round(wanted * 1000) / 1000;
  }

  /**
   * Zoekt de regel die bij een gescande code hoort (EAN of artikelcode); een regel die nog geteld moet worden gaat voor.
   * @param {{ id: string, code: string, ean: string, status: string }[]} lines De regels van de locatie.
   * @param {string} scanned De gescande of ingetypte code.
   * @returns {object|null} De regel of null als de code bij geen regel hoort.
   */
  function findLine(lines, scanned) {
    const code = OrderpickCore.normalizeCode(scanned);
    if (!code) return null;
    const matches = lines.filter((line) => [line.ean, line.code].some((own) => own && OrderpickCore.normalizeCode(own) === code));
    return matches.find((line) => line.status !== 'geteld') || matches[0] || null;
  }

  /**
   * De volgende regel die nog geteld moet worden (open of hertellen), vanaf een regel en daarna van voren af.
   * @param {object[]} lines De regels van de locatie.
   * @param {string|null} [afterId] Id van de regel waarna gezocht wordt.
   * @returns {object|null} De regel of null als alles geteld is.
   */
  function nextOpenLine(lines, afterId = null) {
    /**
     * Of de regel nog geteld moet worden.
     * @param {{ status: string }} line De regel.
     * @returns {boolean} Waar bij open of hertellen.
     */
    const needed = (line) => line.status !== 'geteld';
    const position = afterId === null ? -1 : lines.findIndex((line) => line.id === afterId);
    return lines.slice(position + 1).find(needed) || lines.find(needed) || null;
  }

  /**
   * Telt de voortgang van een locatie op.
   * @param {{ status: string }[]} lines De regels.
   * @returns {{ total: number, counted: number, open: number, recount: number }} Aantallen.
   */
  function summarize(lines) {
    const result = { total: lines.length, counted: 0, open: 0, recount: 0 };
    for (const line of lines) {
      if (line.status === 'geteld') result.counted += 1;
      else if (line.status === 'hertellen') result.recount += 1;
      else result.open += 1;
    }
    return result;
  }

  /**
   * De inhoud van een ingave: het aantal en de eigen sleutel waarmee een herhaalde verzending nooit dubbel telt.
   * @param {number} qty Het getelde aantal.
   * @param {string} clientId De sleutel (minstens 8 tekens).
   * @returns {{ qty: number, clientId: string }} De aanroep.
   */
  const countBody = (qty, clientId) => ({ qty, clientId });

  /**
   * Maakt een sleutel voor een ingave.
   * @param {{ randomUUID?: Function }} [cryptoApi] De crypto-hulp van de browser (voor tests een nagebootste).
   * @returns {string} Een sleutel van minstens 8 tekens.
   */
  function newClientId(cryptoApi) {
    if (cryptoApi && cryptoApi.randomUUID) return cryptoApi.randomUUID();
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }

  /**
   * Een korte naam voor een locatie.
   * @param {string} location De locatie (leeg = geen).
   * @returns {string} De locatie of "Geen locatie".
   */
  const locationName = (location) => location || 'Geen locatie';

  return { MAX_QTY, parseQuantity, findLine, nextOpenLine, summarize, countBody, newClientId, locationName };
});
