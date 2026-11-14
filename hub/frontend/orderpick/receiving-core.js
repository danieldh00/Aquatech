// Rekenkern van de goederenontvangst in de orderpick-app (UMD, ook door de tests geladen): de stand per regel bijhouden, aantallen binnen
// de grenzen zetten en de ontvangen regels klaarzetten voor POST /api/orderpick/receipts/:id/receive. Geen DOM, geen netwerk.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./orderpick-core'));
  else root.ReceivingCore = factory(root.OrderpickCore);
})(typeof self !== 'undefined' ? self : this, function (OrderpickCore) {
  const MAX_QTY = 1000000;

  /**
   * Rondt een aantal af op drie decimalen (zoals de server rekent).
   * @param {number} value Het aantal.
   * @returns {number} Het afgeronde aantal.
   */
  const round3 = (value) => Math.round(value * 1000) / 1000;

  /**
   * Geeft elke regel een volgnummer (`index`), zodat de scanhulp van de orderpick-kern ze kan vinden.
   * @param {{ lines: object[] }} order De order uit GET /api/orderpick/receipts/:id.
   * @returns {object[]} De regels met `index` (de plek in de lijst).
   */
  function indexedLines(order) {
    return order.lines.map((line, index) => ({ ...line, index }));
  }

  /**
   * De regels waar nog iets van binnen moet komen.
   * @param {{ lines: object[] }} order De order.
   * @returns {object[]} De regels met een openstaand aantal (met `index`).
   */
  function receivableLines(order) {
    return indexedLines(order).filter((line) => line.openQty > 0);
  }

  /**
   * De beginstand: elke regel die nog openstaat is open met het volledige openstaande aantal vooraf ingevuld.
   * @param {{ lines: object[] }} order De order.
   * @returns {Object<string, { status: string, qty: number, scanned: boolean }>} De stand per regelindex.
   */
  function initialStates(order) {
    const states = {};
    for (const line of receivableLines(order)) states[line.index] = { status: 'pending', qty: line.openQty, scanned: false };
    return states;
  }

  /**
   * Zet een ingevuld aantal binnen de grenzen: 0 of een positief aantal tot het maximum, op drie decimalen. Meer dan openstaat mag (een leverancier die méér stuurt).
   * @param {*} quantity Het ingevulde aantal.
   * @returns {number} Het aantal (0 bij een ongeldige invoer).
   */
  function clampQuantity(quantity) {
    const wanted = Number(quantity);
    if (!Number.isFinite(wanted) || wanted <= 0) return 0;
    return round3(Math.min(wanted, MAX_QTY));
  }

  /**
   * Zoekt de regel die bij een gescande code hoort; een regel die nog open staat gaat voor.
   * @param {{ lines: object[] }} order De order.
   * @param {Object<string, { status: string }>} states De stand per regelindex.
   * @param {string} scanned De gescande code.
   * @param {number|null} [currentIndex] De regel die nu open staat.
   * @returns {{ line: object, open: boolean }|null} De regel (`open` = nog te behandelen) of null als de code bij geen regel hoort.
   */
  function findLine(order, states, scanned, currentIndex = null) {
    return OrderpickCore.findLine(receivableLines(order), states, scanned, currentIndex);
  }

  /**
   * De volgende regel die nog open staat, vanaf een positie en daarna van voren af.
   * @param {{ lines: object[] }} order De order.
   * @param {Object<string, { status: string }>} states De stand per regelindex.
   * @param {number|null} [afterIndex] De regelindex waarna gezocht wordt.
   * @returns {object|null} De regel of null als alles klaar is.
   */
  function nextOpenLine(order, states, afterIndex = null) {
    const lines = receivableLines(order);
    /**
     * Of de regel nog behandeld moet worden.
     * @param {{ index: number }} line De regel.
     * @returns {boolean} Waar als hij open staat.
     */
    const isOpen = (line) => Boolean(states[line.index]) && states[line.index].status === 'pending';
    const position = afterIndex === null ? -1 : lines.findIndex((line) => line.index === afterIndex);
    return lines.slice(position + 1).find(isOpen) || lines.find(isOpen) || null;
  }

  /**
   * Telt de stand op voor het afrondscherm.
   * @param {{ lines: object[] }} order De order.
   * @param {Object<string, { status: string, qty: number }>} states De stand per regelindex.
   * @returns {{ open: number, received: number, skipped: number, pieces: number, shortPieces: number, overLines: number, overPieces: number }} Open regels, ontvangen regels, regels "niet geleverd", ontvangen stuks, stuks die nog moeten komen, regels met meer dan openstond en het teveel in stuks.
   */
  function summarize(order, states) {
    const result = { open: 0, received: 0, skipped: 0, pieces: 0, shortPieces: 0, overLines: 0, overPieces: 0 };
    for (const line of receivableLines(order)) {
      const state = states[line.index];
      if (!state || state.status === 'pending') { result.open += 1; continue; }
      const quantity = state.status === 'skipped' ? 0 : state.qty;
      if (state.status === 'skipped') result.skipped += 1; else result.received += 1;
      result.pieces = round3(result.pieces + quantity);
      if (quantity < line.openQty) result.shortPieces = round3(result.shortPieces + line.openQty - quantity);
      if (quantity > line.openQty) { result.overLines += 1; result.overPieces = round3(result.overPieces + quantity - line.openQty); }
    }
    return result;
  }

  /**
   * Of de ontvangst geboekt mag worden: niets meer open en minstens één stuk ontvangen.
   * @param {{ lines: object[] }} order De order.
   * @param {Object<string, { status: string, qty: number }>} states De stand per regelindex.
   * @returns {{ ok: boolean, reason: string }} `ok`, anders de reden in gewone taal.
   */
  function canFinish(order, states) {
    const total = summarize(order, states);
    if (total.open > 0) return { ok: false, reason: `Er staan nog ${total.open} regel${total.open === 1 ? '' : 's'} open.` };
    if (total.pieces <= 0) return { ok: false, reason: 'Er is niets ontvangen: er is niets om in te boeken.' };
    return { ok: true, reason: '' };
  }

  /**
   * De inhoud van de ontvangst-aanroep: alleen regels met minstens één ontvangen stuk, met het eerder ontvangen aantal dat het scherm kende (de server weigert bij een afwijking) en of er meer is ontvangen dan besteld.
   * @param {{ lines: object[] }} order De order.
   * @param {Object<string, { status: string, qty: number }>} states De stand per regelindex.
   * @returns {{ lines: { lineId: string, qty: number, seen: number }[], allowOver: boolean }} De aanroep.
   */
  function receiveBody(order, states) {
    const lines = [];
    let allowOver = false;
    for (const line of receivableLines(order)) {
      const state = states[line.index];
      if (!state || state.status !== 'received' || !(state.qty > 0)) continue;
      lines.push({ lineId: line.id, qty: state.qty, seen: line.received });
      if (state.qty > line.openQty) allowOver = true;
    }
    return { lines, allowOver };
  }

  /**
   * Tekst voor een aantal met de eenheid van de regel.
   * @param {object} line De regel.
   * @param {number} quantity Het aantal.
   * @returns {string} Bijvoorbeeld "3 stuks".
   */
  function quantityText(line, quantity) {
    return `${quantity}${line.unit ? ` ${line.unit}` : ''}`;
  }

  return { indexedLines, receivableLines, initialStates, clampQuantity, findLine, nextOpenLine, summarize, canFinish, receiveBody, quantityText };
});
