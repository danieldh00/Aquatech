// Paginering voor alle lange tabellen: één gedeeld onderdeel met dezelfde keuzes (25/50/100/300/Alles) en één bewaarde instelling.
// Twee manieren: (1) automatisch voor elke `table.grid` (rijen buiten de pagina worden verborgen, de balken komen boven en onder de
// tabel; een tabel met 25 rijen of minder houdt de balken weg) en (2) `AquatechPager.attach` voor een lijst die zelf in porties tekent.
// Een rij met klasse `sub-item` (of `data-pager-join`) hoort bij de rij erboven en blijft op dezelfde pagina. Een tabel die geen
// paginering wil krijgt `data-no-pager`.
(function (root) {
  /** De keuzes voor het aantal per pagina (0 = alles). */
  const PAGE_SIZES = [25, 50, 100, 300, 0];
  /** De bewaarsleutel; gelijk aan die van de artikellijst, zodat de keuze overal hetzelfde is. */
  const PAGE_SIZE_KEY = 'aquatech_artikelen_paginagrootte';
  /** Het aantal per pagina als er niets bewaard is. */
  const DEFAULT_SIZE = 50;

  /**
   * Leest de bewaarde paginagrootte (0 = alles); een ongeldige of ontbrekende waarde geeft de standaard.
   * @returns {number} Het aantal regels per pagina.
   */
  function storedSize() {
    try {
      const raw = root.localStorage.getItem(PAGE_SIZE_KEY);
      const value = Number(raw);
      if (raw !== null && PAGE_SIZES.includes(value)) return value;
    } catch (_) { /* opslag niet beschikbaar: standaard */ }
    return DEFAULT_SIZE;
  }

  /**
   * Bewaart de gekozen paginagrootte voor alle lijsten.
   * @param {number} size Het aantal regels per pagina (0 = alles).
   */
  function storeSize(size) {
    try { root.localStorage.setItem(PAGE_SIZE_KEY, String(size)); } catch (_) { /* niet bewaard */ }
  }

  /**
   * Rekent uit welk deel van de lijst op de pagina staat; een pagina buiten bereik wordt teruggebracht.
   * @param {number} total Het aantal eenheden (rijen of groepen) in de lijst.
   * @param {number} page De gewenste pagina (vanaf 1).
   * @param {number} size Het aantal per pagina (0 = alles).
   * @returns {{ page: number, pages: number, start: number, end: number }} De pagina, het aantal pagina's en het bereik [start, end).
   */
  function windowOf(total, page, size) {
    const perPage = size || total || 1;
    const pages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
    const start = (current - 1) * perPage;
    return { page: current, pages, start, end: Math.min(total, start + perPage) };
  }

  /**
   * Zet opeenvolgende rijen in groepen: een rij die bij de vorige hoort (`joins`) gaat in dezelfde groep.
   * @param {object[]} rows De rijen.
   * @param {Function} joins Geeft true als een rij bij de vorige hoort.
   * @returns {object[][]} De groepen.
   */
  function groupRows(rows, joins) {
    const groups = [];
    for (const row of rows) {
      if (groups.length && joins(row)) groups[groups.length - 1].push(row); else groups.push([row]);
    }
    return groups;
  }

  /**
   * Maakt de HTML van de bediening: aantal per pagina, teller en vorige/volgende.
   * @param {{ page: number, pages: number, start: number, end: number }} view Het bereik uit `windowOf`.
   * @param {number} total Het aantal eenheden.
   * @param {number} size Het gekozen aantal per pagina.
   * @param {string} noun Het meervoud van wat er staat (bijvoorbeeld 'artikelen').
   * @returns {string} De HTML van de balk.
   */
  function barHtml(view, total, size, noun) {
    const options = PAGE_SIZES.map((option) => `<option value="${option}"${option === size ? ' selected' : ''}>${option || 'Alles'}</option>`).join('');
    return `<label class="pager-size">Per pagina <select data-pager-size>${options}</select></label>
      <span class="muted small pager-count">${total ? `${view.start + 1}–${view.end} van ${total}` : `Geen ${noun}`}</span>
      <span class="pager-nav"><button class="btn" type="button" data-pager="prev"${view.page <= 1 ? ' disabled' : ''}>‹ Vorige</button><span class="small">Pagina ${view.page} van ${view.pages}</span><button class="btn" type="button" data-pager="next"${view.page >= view.pages ? ' disabled' : ''}>Volgende ›</button></span>`;
  }

  /**
   * Tekent de bediening in een of meer balken en koppelt de knoppen.
   * @param {HTMLElement[]} bars De elementen waarin de bediening komt (boven en onder de tabel).
   * @param {{ page: number, pages: number, start: number, end: number }} view Het bereik uit `windowOf`.
   * @param {number} total Het aantal eenheden.
   * @param {number} size Het gekozen aantal per pagina.
   * @param {string} noun Het meervoud van wat er staat.
   * @param {{ onSize: Function, onPage: Function }} handlers `onSize(size)` bij een andere grootte, `onPage(delta, fromBottom)` bij vorige/volgende.
   */
  function drawBars(bars, view, total, size, noun, handlers) {
    bars.forEach((bar, index) => {
      bar.innerHTML = barHtml(view, total, size, noun);
      /**
       * Past het aantal per pagina aan.
       * @param {Event} event de wijziging van de keuzelijst
       */
      bar.querySelector('[data-pager-size]').onchange = (event) => { handlers.onSize(Number(event.target.value)); };
      bar.querySelectorAll('[data-pager]').forEach((button) => {
        /** Gaat een pagina terug of vooruit. */
        button.onclick = () => { handlers.onPage(button.dataset.pager === 'next' ? 1 : -1, index === bars.length - 1 && bars.length > 1); };
      });
    });
  }

  /**
   * Koppelt de bediening aan een lijst die zelf in porties tekent (zoals de artikellijst).
   * @param {{ bars: HTMLElement[], noun?: string, onChange: Function }} options De balken, het meervoud en de functie die de lijst opnieuw tekent.
   * @returns {{ view: Function, reset: Function }} `view(total)` geeft het bereik en tekent de balken; `reset()` gaat terug naar pagina 1.
   */
  function attach(options) {
    const state = { page: 1, size: storedSize() };
    const noun = options.noun || 'artikelen';
    return {
      /**
       * Geeft het bereik van de huidige pagina en tekent de balken.
       * @param {number} total Het aantal eenheden in de lijst.
       * @returns {{ page: number, pages: number, start: number, end: number }} Het bereik [start, end).
       */
      view(total) {
        const view = windowOf(total, state.page, state.size);
        state.page = view.page;
        options.bars.forEach((bar) => { bar.hidden = !total; });
        drawBars(options.bars, view, total, state.size, noun, {
          onSize(size) { state.size = size; state.page = 1; storeSize(size); options.onChange(); },
          onPage(delta, fromBottom) {
            state.page += delta;
            options.onChange();
            if (fromBottom) options.bars[0].scrollIntoView({ block: 'start' });
          },
        });
        return view;
      },
      /** Gaat terug naar pagina 1 (na een ander zoekwoord of filter). */
      reset() { state.page = 1; },
    };
  }

  /**
   * Geeft de id's (`data-id`) van de rijen die nu op de pagina staan; voor "alles selecteren", dat alleen de zichtbare rijen mag raken.
   * @param {Element} table De tabel.
   * @returns {string[]} De id's van de rijen buiten de verborgen pagina's.
   */
  function shownIds(table) {
    return Array.from(table.querySelectorAll(':scope > tbody > tr[data-id]')).filter((row) => !row.classList.contains('pager-off') && !row.hidden).map((row) => row.getAttribute('data-id'));
  }

  /** Het aantal rijen waarboven de balken verschijnen bij automatische paginering. */
  const AUTO_MIN_ROWS = 25;

  /** Per tabel de stand van de automatische paginering. */
  const tables = typeof WeakMap === 'function' ? new WeakMap() : null;

  /**
   * Bepaalt of een tabel automatisch gepagineerd moet worden.
   * @param {Element} table Het tabelelement.
   * @returns {boolean} True voor `table.grid` zonder `data-no-pager` of `.mini`.
   */
  function isPaged(table) {
    return table.classList.contains('grid') && !table.classList.contains('mini') && !table.closest('[data-no-pager]') && !table.hasAttribute('data-no-pager');
  }

  /**
   * Zoekt de rijen van de tabel waarop de paginering werkt: de rijen van de eerste tbody die niet door de pagina zelf verborgen zijn.
   * @param {HTMLTableElement} table De tabel.
   * @returns {HTMLTableRowElement[]} De zichtbare rijen.
   */
  function bodyRows(table) {
    return Array.from(table.querySelectorAll(':scope > tbody > tr')).filter((row) => !row.hidden);
  }

  /**
   * Maakt een balk en zet hem in de pagina vóór of na de tabel (of de omhullende `.tablewrap`).
   * @param {Element} table De tabel.
   * @param {boolean} before True voor boven de tabel.
   * @returns {HTMLElement} De nieuwe balk.
   */
  function insertBar(table, before) {
    const bar = root.document.createElement('div');
    bar.className = 'pager';
    bar.setAttribute('data-pager-auto', '');
    const anchor = table.closest('.tablewrap') || table;
    anchor.insertAdjacentElement(before ? 'beforebegin' : 'afterend', bar);
    return bar;
  }

  /**
   * Past de paginering toe op één tabel: verbergt de rijen buiten de pagina en tekent de balken (of haalt ze weg bij een korte tabel).
   * @param {HTMLTableElement} table De tabel.
   */
  function applyTable(table) {
    if (!isPaged(table)) return;
    let info = tables.get(table);
    if (!info) { info = { page: 1, size: storedSize(), count: -1, bars: null }; tables.set(table, info); }
    const rows = bodyRows(table);
    const groups = groupRows(rows, (row) => row.classList.contains('sub-item') || row.hasAttribute('data-pager-join'));
    if (rows.length !== info.count) { info.page = 1; info.count = rows.length; }
    const view = windowOf(groups.length, info.page, info.size);
    info.page = view.page;
    groups.forEach((group, index) => {
      const off = index < view.start || index >= view.end;
      group.forEach((row) => row.classList.toggle('pager-off', off));
    });
    const needed = groups.length > AUTO_MIN_ROWS;
    if (!needed) {
      if (info.bars) { info.bars.forEach((bar) => bar.remove()); info.bars = null; }
      return;
    }
    if (!info.bars || !info.bars.every((bar) => bar.isConnected)) {
      if (info.bars) info.bars.forEach((bar) => bar.remove());
      info.bars = [insertBar(table, true), insertBar(table, false)];
    }
    drawBars(info.bars, view, groups.length, info.size, 'rijen', {
      onSize(size) { info.size = size; info.page = 1; storeSize(size); applyTable(table); },
      onPage(delta, fromBottom) {
        info.page += delta;
        applyTable(table);
        if (fromBottom) info.bars[0].scrollIntoView({ block: 'start' });
      },
    });
  }

  /** Tabellen die nog aan de beurt zijn (gebundeld in één frame). */
  const pending = new Set();
  let scheduled = false;

  /**
   * Plant een tabel in voor het bijwerken van de paginering; meerdere wijzigingen in één frame tellen als één.
   * @param {Element} table De tabel.
   */
  function schedule(table) {
    pending.add(table);
    if (scheduled) return;
    scheduled = true;
    root.setTimeout(() => {
      scheduled = false;
      const list = Array.from(pending);
      pending.clear();
      list.forEach((item) => { if (item.isConnected) applyTable(item); });
    }, 0);
  }

  /**
   * Verwerkt wijzigingen in de pagina: een tabel die verschijnt of waarvan de rijen vervangen worden komt aan de beurt.
   * @param {MutationRecord[]} records De wijzigingen.
   */
  function onMutations(records) {
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const own = target && target.closest && target.closest('[data-pager-auto]');
      if (own) continue;
      const table = target && target.closest ? target.closest('table') : null;
      if (table && isPaged(table)) schedule(table);
      record.addedNodes.forEach((node) => {
        if (node.nodeType !== 1 || node.hasAttribute('data-pager-auto')) return;
        if (node.matches('table')) schedule(node);
        node.querySelectorAll('table.grid').forEach(schedule);
      });
    }
  }

  /** Start de automatische paginering: bestaande tabellen en alles wat er later bijkomt. */
  function start() {
    if (!tables || !root.MutationObserver) return;
    root.document.querySelectorAll('table.grid').forEach(schedule);
    new root.MutationObserver(onMutations).observe(root.document.body, { childList: true, subtree: true });
  }

  const api = { PAGE_SIZES, PAGE_SIZE_KEY, storedSize, windowOf, groupRows, attach, shownIds };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root.document) {
    root.AquatechPager = api;
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start); else start();
  }
}(typeof window !== 'undefined' ? window : globalThis));
