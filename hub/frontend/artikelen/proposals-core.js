// Rekenkern van de automatische bestelvoorstellen (UMD, ook door de tests geladen): welke inkooporder een voorstel is,
// totalen per order en over alle voorstellen, en de teksten voor meldingen en de bevestiging. Geen DOM, geen netwerk.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProposalsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Geeft aan of een inkooporder een automatisch voorstel is: nog concept en door de achtergrondtaak gemaakt.
   * @param {{ status: string, origin: string }} order De order.
   * @returns {boolean} true als het een voorstel is.
   */
  function isProposal(order) {
    return Boolean(order) && order.status === 'concept' && order.origin === 'voorstel';
  }

  /**
   * Zet een bedrag om naar hele centen, zodat optellen geen afrondingsresten geeft.
   * @param {number} amount Het bedrag in euro's.
   * @returns {number} Het bedrag in centen.
   */
  const toCents = (amount) => Math.round(Number(amount) * 100);

  /**
   * Het bedrag van een regel: het bedrag van de server, anders aantal × inkoopprijs.
   * @param {{ amount: number|null, qty: number, unitCost: number|null }} line De regel.
   * @returns {number|null} Het bedrag, of null als de regel geen inkoopprijs heeft.
   */
  function lineAmount(line) {
    if (line.amount != null) return Number(line.amount);
    if (line.unitCost == null || line.unitCost === '') return null;
    return toCents(Number(line.qty) * Number(line.unitCost)) / 100;
  }

  /**
   * Telt de regels van één order op.
   * @param {{ lines: object[] }} order De order met regels.
   * @returns {{ lineCount: number, total: number|null, unpriced: number }} Aantal regels, totaal van de regels met prijs
   *   (null als geen enkele regel een prijs heeft) en het aantal regels zonder prijs.
   */
  function orderSummary(order) {
    const lines = order.lines || [];
    let cents = null;
    let unpriced = 0;
    for (const line of lines) {
      const amount = lineAmount(line);
      if (amount == null) unpriced += 1;
      else cents = (cents || 0) + toCents(amount);
    }
    return { lineCount: lines.length, total: cents == null ? null : cents / 100, unpriced };
  }

  /**
   * Maakt het overzicht van GET /api/purchase-orders/proposals: voorstellen op leveranciersnaam, totalen en de afgewezen artikelen.
   * @param {{ orders: object[], dismissed: object[], withoutSupplier: number, enabled: boolean }} result Het antwoord van de server.
   * @returns {{ orders: object[], count: number, lineCount: number, total: number|null, unpriced: number, dismissed: object[], withoutSupplier: number, enabled: boolean }}
   *   Het overzicht; elke order krijgt `summary` (uit orderSummary).
   */
  function overview(result) {
    const source = result || {};
    const orders = (source.orders || [])
      .map((order) => ({ ...order, summary: orderSummary(order) }))
      .sort((left, right) => String(left.supplierName || '').localeCompare(String(right.supplierName || ''), 'nl') || String(left.number || '').localeCompare(String(right.number || '')));
    let cents = null;
    let lineCount = 0;
    let unpriced = 0;
    for (const order of orders) {
      lineCount += order.summary.lineCount;
      unpriced += order.summary.unpriced;
      if (order.summary.total != null) cents = (cents || 0) + toCents(order.summary.total);
    }
    const dismissed = [...(source.dismissed || [])].sort((left, right) => String(left.name || left.code || '').localeCompare(String(right.name || right.code || ''), 'nl'));
    return {
      orders, count: orders.length, lineCount, total: cents == null ? null : cents / 100, unpriced, dismissed,
      withoutSupplier: Number(source.withoutSupplier) || 0, enabled: source.enabled !== false,
    };
  }

  /**
   * Kiest het enkelvoud of meervoud bij een aantal.
   * @param {number} count Het aantal.
   * @param {string} one Het woord bij 1.
   * @param {string} many Het woord bij 0 of meer dan 1.
   * @returns {string} Bijvoorbeeld '3 orders'.
   */
  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }

  /**
   * De vraag vóór Alles goedkeuren: het is een bestelling, dus één korte bevestiging met het totaal.
   * @param {{ count: number, lineCount: number, total: number|null, unpriced: number }} summary Het overzicht (uit overview).
   * @param {Function} formatMoney Maakt van een bedrag een tekst in euro's.
   * @returns {string} De vraag.
   */
  function approveQuestion(summary, formatMoney) {
    const amount = summary.total == null ? 'zonder bekend bedrag' : `voor ${formatMoney(summary.total)}`;
    const unpriced = summary.unpriced ? ` (${plural(summary.unpriced, 'regel', 'regels')} zonder inkoopprijs)` : '';
    return `${plural(summary.count, 'inkooporder', 'inkooporders')} met ${plural(summary.lineCount, 'regel', 'regels')} ${amount}${unpriced} bestellen?`;
  }

  /**
   * De melding na Nu vernieuwen.
   * @param {{ created: number, updated: number, removed: number, skipped: number, dismissedSkipped: number }} result Het antwoord van de server.
   * @returns {string} De melding.
   */
  function refreshMessage(result) {
    const source = result || {};
    const parts = [];
    if (source.created) parts.push(`${plural(source.created, 'voorstel', 'voorstellen')} gemaakt`);
    if (source.updated) parts.push(`${source.updated} bijgewerkt`);
    if (source.removed) parts.push(`${source.removed} vervallen`);
    const changed = parts.length ? `${parts.join(', ')}.` : 'Geen wijzigingen.';
    const notes = [];
    if (source.skipped) notes.push(`${plural(source.skipped, 'artikel', 'artikelen')} zonder voorkeursleverancier`);
    if (source.dismissedSkipped) notes.push(`${plural(source.dismissedSkipped, 'artikel', 'artikelen')} op Niet bestellen`);
    return notes.length ? `${changed} Overgeslagen: ${notes.join(' en ')}.` : changed;
  }

  /**
   * De melding na goedkeuren.
   * @param {{ placed: { number: string }[], failed: { message: string }[] }} result Het antwoord van de server.
   * @returns {{ message: string, isError: boolean }} De melding; isError als er iets niet is besteld.
   */
  function approveMessage(result) {
    const placed = (result && result.placed) || [];
    const failed = (result && result.failed) || [];
    const done = placed.length ? `Besteld: ${placed.map((order) => order.number).join(', ')}.` : '';
    const reasons = failed.map((entry) => String(entry.message || '').replace(/[.\s]+$/, '')).filter(Boolean).join('; ');
    const problems = failed.length ? `Niet besteld: ${reasons || plural(failed.length, 'order', 'orders')}.` : '';
    return { message: [done, problems].filter(Boolean).join(' ') || 'Niets besteld.', isError: failed.length > 0 };
  }

  /**
   * De hint over artikelen onder het minimum zonder voorkeursleverancier.
   * @param {number} count Het aantal artikelen.
   * @returns {string} De hint, of leeg bij 0.
   */
  function withoutSupplierHint(count) {
    if (!count) return '';
    return `${plural(count, 'artikel', 'artikelen')} onder het minimum ${count === 1 ? 'heeft' : 'hebben'} nog geen voorkeursleverancier en ${count === 1 ? 'komt' : 'komen'} daarom niet in een voorstel.`;
  }

  /**
   * De tekst in het tellerbolletje.
   * @param {number} count Het aantal voorstellen.
   * @returns {string} Leeg bij 0, '9+' boven de 9.
   */
  function countBadge(count) {
    if (!(count > 0)) return '';
    return count > 9 ? '9+' : String(count);
  }

  return { isProposal, lineAmount, orderSummary, overview, plural, approveQuestion, refreshMessage, approveMessage, withoutSupplierHint, countBadge };
});
