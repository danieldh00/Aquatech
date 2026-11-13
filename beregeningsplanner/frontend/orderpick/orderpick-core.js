// Rekenkern van de orderpick-app (UMD, ook door de tests geladen): codes vergelijken bij het scannen, de stand per regel
// bijhouden en de gepickte regels klaarzetten voor POST /api/orderpick/orders/:id/pick. Geen DOM, geen netwerk.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrderpickCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Maakt een gescande of ingetypte code vergelijkbaar: spaties en stuurtekens weg, hoofdletters.
   * @param {*} text De code.
   * @returns {string} De genormaliseerde code (leeg als er niets bruikbaars staat).
   */
  function normalizeCode(text) {
    return String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f\s]+/g, '').toUpperCase();
  }

  /**
   * Zoekt de regel die bij een gescande code hoort; een regel die nog gepickt moet worden gaat voor.
   * @param {{ index: number, scanCodes: string[] }[]} lines De regels van de bestelling.
   * @param {Object<string, { status: string }>} states De stand per regelindex.
   * @param {string} scanned De gescande code.
   * @param {number|null} [currentIndex] De regel die nu open staat: die wint als er meer regels bij de code horen.
   * @returns {{ line: object, open: boolean }|null} De regel (`open` = nog te picken) of null als de code bij geen enkele regel hoort.
   */
  function findLine(lines, states, scanned, currentIndex = null) {
    const code = normalizeCode(scanned);
    if (!code) return null;
    const matches = lines.filter((line) => (line.scanCodes || []).some((candidate) => normalizeCode(candidate) === code));
    if (!matches.length) return null;
    /**
     * Of de regel nog gepickt moet worden.
     * @param {{ index: number }} line De regel.
     * @returns {boolean} Waar als hij open staat.
     */
    const isOpen = (line) => Boolean(states[line.index]) && states[line.index].status === 'pending';
    const current = matches.find((line) => line.index === currentIndex && isOpen(line));
    const chosen = current || matches.find(isOpen) || matches[0];
    return { line: chosen, open: isOpen(chosen) };
  }

  /**
   * Zet het aantal binnen de grenzen: een geheel aantal van 0 tot het leverbare aantal (een leverbaar aantal met decimalen blijft als maximum mogelijk).
   * @param {*} quantity Het gewenste aantal.
   * @param {number} ready Het aantal dat de server leverbaar noemt.
   * @returns {number} Het aantal.
   */
  function clampQuantity(quantity, ready) {
    const wanted = Number(quantity);
    if (!Number.isFinite(wanted) || wanted < 0) return 0;
    const top = Math.max(0, Number(ready) || 0);
    if (wanted >= top) return top;
    return Math.floor(wanted);
  }

  /**
   * De beginstand: elke regel die nu leverbaar is staat open met het volledige aantal vooraf ingevuld; de rest wacht op voorraad.
   * @param {{ lines: object[] }} order De bestelling uit GET /api/orderpick/orders/:id.
   * @returns {Object<string, { status: string, qty: number, scanned: boolean }>} De stand per regelindex.
   */
  function initialStates(order) {
    const states = {};
    for (const line of order.lines) {
      if (line.ready > 0) states[line.index] = { status: 'pending', qty: line.ready, scanned: false };
    }
    return states;
  }

  /**
   * De regels die gepickt kunnen worden (leverbaar), in de volgorde van het magazijn (de server sorteert op locatie).
   * @param {{ lines: object[] }} order De bestelling.
   * @returns {object[]} De pickbare regels.
   */
  function pickableLines(order) {
    return order.lines.filter((line) => line.ready > 0);
  }

  /**
   * De volgende regel die nog open staat, vanaf een positie in de lijst en daarna van voren af.
   * @param {{ lines: object[] }} order De bestelling.
   * @param {Object<string, { status: string }>} states De stand per regelindex.
   * @param {number|null} [afterIndex] De regelindex waarna gezocht wordt (leeg = vanaf het begin).
   * @returns {object|null} De regel of null als alles klaar is.
   */
  function nextOpenLine(order, states, afterIndex = null) {
    const lines = pickableLines(order);
    /**
     * Of de regel nog gepickt moet worden.
     * @param {{ index: number }} line De regel.
     * @returns {boolean} Waar als hij open staat.
     */
    const isOpen = (line) => Boolean(states[line.index]) && states[line.index].status === 'pending';
    const position = afterIndex === null ? -1 : lines.findIndex((line) => line.index === afterIndex);
    return lines.slice(position + 1).find(isOpen) || lines.find(isOpen) || null;
  }

  /**
   * Telt de stand op voor het afrondscherm.
   * @param {{ lines: object[] }} order De bestelling.
   * @param {Object<string, { status: string, qty: number }>} states De stand per regelindex.
   * @returns {{ open: number, picked: number, absent: number, short: number, pieces: number, missingPieces: number }} Aantal open regels, gepickte regels, regels "niet aanwezig", regels met minder dan leverbaar (incl. niet aanwezig), gepickte stuks en het aantal stuks dat op backorder blijft.
   */
  function summarize(order, states) {
    const result = { open: 0, picked: 0, absent: 0, short: 0, pieces: 0, missingPieces: 0 };
    for (const line of pickableLines(order)) {
      const state = states[line.index];
      if (!state || state.status === 'pending') { result.open += 1; continue; }
      const quantity = state.status === 'absent' ? 0 : state.qty;
      if (state.status === 'absent') result.absent += 1; else result.picked += 1;
      result.pieces += quantity;
      if (quantity < line.ready) { result.short += 1; result.missingPieces += line.ready - quantity; }
    }
    return result;
  }

  /**
   * Of de bestelling afgemeld mag worden: niets meer open en minstens één stuk gepickt.
   * @param {{ lines: object[] }} order De bestelling.
   * @param {Object<string, { status: string, qty: number }>} states De stand per regelindex.
   * @returns {{ ok: boolean, reason: string }} `ok`, anders de reden in gewone taal.
   */
  function canFinish(order, states) {
    const total = summarize(order, states);
    if (total.open > 0) return { ok: false, reason: `Er staan nog ${total.open} regel${total.open === 1 ? '' : 's'} open.` };
    if (total.pieces <= 0) return { ok: false, reason: 'Er is niets gepickt: er is niets om te verzenden.' };
    return { ok: true, reason: '' };
  }

  /**
   * De inhoud van de pick-aanroep: alleen regels met minstens één gepickt stuk (de rest blijft op backorder) en het aantal zendingen dat de picker kent.
   * @param {{ lines: object[], shipmentCount: number }} order De bestelling.
   * @param {Object<string, { status: string, qty: number }>} states De stand per regelindex.
   * @returns {{ lines: { index: number, qty: number }[], shipmentCount: number }} De aanroep.
   */
  function pickBody(order, states) {
    const lines = [];
    for (const line of pickableLines(order)) {
      const state = states[line.index];
      if (state && state.status === 'picked' && state.qty > 0) lines.push({ index: line.index, qty: state.qty });
    }
    return { lines, shipmentCount: order.shipmentCount };
  }

  /**
   * Tekst voor een aantal met de eenheid van de regel (en de verpakking als die er is).
   * @param {object} line De regel.
   * @param {number} quantity Het aantal.
   * @returns {string} Bijvoorbeeld "3 stuks" of "2 × pallet".
   */
  function quantityText(line, quantity) {
    if (line.packaging) return `${quantity} × ${line.packaging.name || line.packaging.code}`;
    return `${quantity}${line.unit ? ` ${line.unit}` : ''}`;
  }

  return { normalizeCode, findLine, clampQuantity, initialStates, pickableLines, nextOpenLine, summarize, canFinish, pickBody, quantityText };
});
