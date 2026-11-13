// Automatische bestelvoorstellen (module Artikelen, tabblad Bestelvoorstel): per leverancier een kaart met de regels
// die de achtergrondtaak heeft klaargezet, met Goedkeuren (bestellen), Niet bestellen per regel of per order, Aanpassen
// in het orderscherm van Inkooporders, Alles goedkeuren, Nu vernieuwen en de lijst Niet bestellen met Herstel.
// Praat met /api/purchase-orders/proposals (recht 'voorraad'); de server rekent en controleert alles.
(function () {
  const context = { api: null, toast: null, esc: null, nl: null, eur: null, openOrder: null };
  const state = { overview: null, busy: false, tab: '' };
  const Core = window.ProposalsCore;

  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @param {ParentNode} scope waarbinnen gezocht wordt (standaard het document)
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector, scope = document) => scope.querySelector(selector);

  /**
   * Haalt de voorstellen op en tekent het blok en de teller.
   * @returns {Promise<void>}
   */
  async function load() {
    const result = await context.api('purchase-orders/proposals');
    state.overview = Core.overview(result);
    render();
  }

  /**
   * Haalt alleen de voorstellen op voor de teller (bij het openen van de pagina); een fout blijft stil.
   * @returns {Promise<void>}
   */
  async function loadCount() {
    try { await load(); } catch { /* de teller is een extraatje; het tabblad zelf toont de fout */ }
  }

  /**
   * Eén regel van een voorstel.
   * @param {object} order De order.
   * @param {object} line De regel.
   * @returns {string} HTML van de regel.
   */
  function lineHtml(order, line) {
    const { esc, nl, eur } = context;
    const amount = Core.lineAmount(line);
    const price = line.unitCost == null ? '<span class="muted">geen inkoopprijs</span>' : `× ${esc(eur(line.unitCost))}`;
    const sku = line.supplierSku ? ` · ${esc(line.supplierSku)}` : '';
    return `<li class="pp-line">
      <span class="pp-name">${esc(line.name || line.code)}<span class="sub"><span class="code">${esc(line.code)}</span>${sku}</span></span>
      <span class="pp-amount">${amount == null ? '' : esc(eur(amount))}</span>
      <span class="pp-qty"><b>${esc(nl(line.qty))}</b> ${esc(line.unit)} ${price}</span>
      <button class="linkbtn pp-drop" type="button" data-dismiss-line="${esc(line.itemId)}" data-order="${esc(order.id)}">Niet bestellen</button>
    </li>`;
  }

  /**
   * De kaart van één voorstel (één leverancier).
   * @param {object} order De order met `summary`.
   * @returns {string} HTML van de kaart.
   */
  function cardHtml(order) {
    const { esc, eur } = context;
    const { summary } = order;
    const unpriced = summary.unpriced ? `<span class="sub">${esc(Core.plural(summary.unpriced, 'regel', 'regels'))} zonder inkoopprijs</span>` : '';
    return `<article class="card pp-card" data-order-id="${esc(order.id)}">
      <h3><span>${esc(order.supplierName || 'Leverancier')}</span><span class="muted small">${esc(order.number)}</span></h3>
      <ul class="pp-lines">${order.lines.map((line) => lineHtml(order, line)).join('')}</ul>
      <div class="pp-total"><span>Totaal <span class="muted small">(${esc(Core.plural(summary.lineCount, 'regel', 'regels'))})</span>${unpriced}</span><b>${summary.total == null ? '–' : esc(eur(summary.total))}</b></div>
      <div class="form-actions">
        <button class="btn primary" type="button" data-approve="${esc(order.id)}">Goedkeuren (bestellen)</button>
        <a class="btn" href="./?order=${encodeURIComponent(order.id)}#orders" data-edit="${esc(order.id)}">Aanpassen</a>
        <span class="spacer"></span>
        <button class="linkbtn" type="button" data-dismiss-order="${esc(order.id)}">Hele order niet bestellen</button>
      </div>
    </article>`;
  }

  /** Tekent de lijst afgewezen artikelen (inklapbaar) met Herstel. */
  function renderDismissed() {
    const { esc } = context;
    const { dismissed } = state.overview;
    const box = $('#pp-dismissed');
    box.hidden = !dismissed.length;
    if (!dismissed.length) return;
    $('#pp-dismissed-count').textContent = String(dismissed.length);
    $('#pp-dismissed-list').innerHTML = dismissed.map((entry) => `<li>
      <span class="pp-name">${esc(entry.name || entry.code)}<span class="sub"><span class="code">${esc(entry.code)}</span>${entry.dismissedAt ? ` · sinds ${esc(new Date(entry.dismissedAt).toLocaleDateString('nl-NL'))}` : ''}</span></span>
      <button class="btn small" type="button" data-restore="${esc(entry.itemId)}">Herstel</button>
    </li>`).join('');
    $('#pp-restore-all').hidden = dismissed.length < 2;
  }

  /** Tekent het blok Automatische voorstellen, de hints en de teller. */
  function render() {
    const { esc, eur } = context;
    const summary = state.overview;
    $('#pp-off').hidden = summary.enabled;
    const hint = Core.withoutSupplierHint(summary.withoutSupplier);
    $('#pp-without').hidden = !hint;
    $('#pp-without-text').textContent = hint;
    $('#pp-summary').textContent = summary.count
      ? `${Core.plural(summary.count, 'voorstel', 'voorstellen')} met ${Core.plural(summary.lineCount, 'regel', 'regels')}${summary.total == null ? '' : `, samen ${eur(summary.total)}`}.`
      : '';
    $('#pp-approve-all').hidden = summary.count < 2;
    $('#pp-cards').innerHTML = summary.count
      ? summary.orders.map(cardHtml).join('')
      : `<p class="muted pp-empty">${esc(summary.enabled ? 'Geen voorstellen: alles wat onder het minimum zit, is al besteld of staat op Niet bestellen.' : 'Geen voorstellen: automatisch voorstellen staat uit.')}</p>`;
    renderDismissed();
    renderCount();
  }

  /** Zet de teller op het tabblad en de melding boven de tabbladen (die alleen buiten dit tabblad). */
  function renderCount() {
    const count = state.overview ? state.overview.count : 0;
    $('#t-reorder').textContent = Core.countBadge(count);
    const notice = $('#pp-pending');
    notice.hidden = !count || state.tab === 'reorder';
    $('#pp-pending-text').textContent = count ? `${Core.plural(count, 'automatisch bestelvoorstel wacht', 'automatische bestelvoorstellen wachten')} op goedkeuring.` : '';
  }

  /**
   * Volgt het open tabblad (voor de melding boven de tabbladen).
   * @param {string} name Het tabblad.
   */
  function setTab(name) {
    state.tab = name;
    renderCount();
  }

  /**
   * Voert een actie uit met alle knoppen van het blok uit, meldt de uitkomst en haalt de voorstellen opnieuw op.
   * @param {Function} action Doet de aanroep en geeft { message, isError } terug.
   * @returns {Promise<void>}
   */
  async function run(action) {
    if (state.busy) return;
    state.busy = true;
    const block = $('#pp-block');
    block.classList.add('busy');
    for (const button of block.querySelectorAll('button')) button.disabled = true;
    try {
      const outcome = await action();
      await load();
      if (outcome && outcome.message) context.toast(outcome.message, Boolean(outcome.isError));
    } catch (error) {
      context.toast(error.message, true);
      // Het voorstel kan intussen gewijzigd zijn (409): de actuele stand tonen.
      await load().catch(() => {});
    } finally {
      state.busy = false;
      block.classList.remove('busy');
      for (const button of block.querySelectorAll('button')) button.disabled = false;
    }
  }

  /**
   * Keurt voorstellen goed: de server bestelt ze.
   * @param {string[]} ids De order-id's.
   * @returns {Promise<void>}
   */
  function approve(ids) {
    return run(async () => Core.approveMessage(await context.api('purchase-orders/proposals/approve', { method: 'POST', body: { ids } })));
  }

  /** Keurt alle voorstellen goed, na één korte bevestiging met het totaal (het is een bestelling). */
  function approveAll() {
    const summary = state.overview;
    if (!summary || !summary.count) return;
    if (!window.confirm(Core.approveQuestion(summary, context.eur))) return;
    approve(summary.orders.map((order) => order.id));
  }

  /**
   * Haalt regels of de hele order uit het voorstel (komt terug via Herstel, dus zonder vraag).
   * @param {string} orderId De order.
   * @param {string[]|null} itemIds De artikelen, of null voor de hele order.
   * @returns {Promise<void>}
   */
  function dismiss(orderId, itemIds) {
    const body = itemIds ? { orderId, itemIds } : { orderId };
    return run(async () => {
      await context.api('purchase-orders/proposals/dismiss', { method: 'POST', body });
      return { message: itemIds ? 'Regel staat op Niet bestellen' : 'Order staat op Niet bestellen' };
    });
  }

  /**
   * Zet afgewezen artikelen terug, zodat ze weer in een voorstel kunnen komen.
   * @param {string[]} itemIds De artikelen.
   * @returns {Promise<void>}
   */
  function restore(itemIds) {
    return run(async () => {
      await context.api('purchase-orders/proposals/restore', { method: 'POST', body: { itemIds } });
      return { message: `${Core.plural(itemIds.length, 'artikel', 'artikelen')} hersteld; ze komen bij het volgende vernieuwen weer in een voorstel als ze nog onder het minimum zitten.` };
    });
  }

  /**
   * Laat de server de voorstellen nu opnieuw opbouwen.
   * @returns {Promise<void>}
   */
  function refresh() {
    return run(async () => ({ message: Core.refreshMessage(await context.api('purchase-orders/proposals/refresh', { method: 'POST' })) }));
  }

  /**
   * Handelt de knoppen in het blok af (één luisteraar voor alle kaarten).
   * @param {MouseEvent} event de klik
   */
  function onClick(event) {
    const target = event.target.closest('[data-approve], [data-edit], [data-dismiss-line], [data-dismiss-order], [data-restore]');
    if (!target || state.busy) return;
    if (target.dataset.approve) approve([target.dataset.approve]);
    else if (target.dataset.edit) {
      // Een gewone klik opent de order hier; met Ctrl/Cmd of de middelste knop opent de link een nieuw tabblad.
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      context.openOrder(target.dataset.edit);
    } else if (target.dataset.dismissLine) dismiss(target.dataset.order, [target.dataset.dismissLine]);
    else if (target.dataset.dismissOrder) dismiss(target.dataset.dismissOrder, null);
    else if (target.dataset.restore) restore([target.dataset.restore]);
  }

  /**
   * Koppelt de knoppen.
   * @param {{ api: Function, toast: Function, esc: Function, nl: Function, eur: Function, openOrder: Function, showReorder: Function }} options Hulpfuncties van de pagina.
   */
  function setup(options) {
    Object.assign(context, options);
    $('#pp-block').addEventListener('click', onClick);
    /** Bouwt de voorstellen nu opnieuw op. */
    $('#pp-refresh').onclick = () => { refresh(); };
    /** Keurt alle voorstellen goed. */
    $('#pp-approve-all').onclick = approveAll;
    /** Zet alle afgewezen artikelen terug. */
    $('#pp-restore-all').onclick = () => { if (state.overview) restore(state.overview.dismissed.map((entry) => entry.itemId)); };
    /** Springt vanuit de melding naar het tabblad Bestelvoorstel. */
    $('#pp-pending-open').onclick = () => { context.showReorder(); };
  }

  window.ArtikelenProposals = { setup, load, loadCount, setTab };
})();
