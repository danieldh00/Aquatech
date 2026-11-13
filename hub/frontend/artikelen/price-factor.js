// Prijsfactor (module Artikelen, tabblad Prijsfactor): de standaardfactor, de afronding en de factoren per categorie
// en leverancier instellen (alleen beheerders), en een voorbeeld van de herberekening van alle artikelen met prijs
// volgens factor: huidige en nieuwe prijs, factor en bron, marge. Dit zijn de prijsvoorstellen: goedkeuren (doorvoeren) of afwijzen per artikel of voor de aangevinkte artikelen.
// Praat met /api/stock/price-factors (lezen: recht voorraad; opslaan en doorvoeren: recht beheer).
(function () {
  const context = { api: null, toast: null, esc: null, nl: null, eur: null, workbook: null, save: null, stamp: null };
  const state = { data: null, categories: [], suppliers: [], onlyChanged: true, selected: new Set() };
  const SOURCE_LABELS = { artikel: 'Artikel', leverancier: 'Leverancier', categorie: 'Categorie', standaard: 'Standaard' };

  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @param {ParentNode} scope waarbinnen gezocht wordt (standaard het document)
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector, scope = document) => scope.querySelector(selector);

  /**
   * Een percentage als tekst, bijvoorbeeld "44,3%".
   * @param {?number} value Het percentage.
   * @returns {string} De tekst, of een streepje zonder waarde.
   */
  const pct = (value) => (value == null ? '–' : `${context.nl(value)}%`);

  /**
   * Is dit een open prijsvoorstel (de prijs wijkt af en is niet afgewezen)?
   * @param {object} row Een regel van het voorbeeld.
   * @returns {boolean} true bij een open voorstel.
   */
  const isOpen = (row) => row.changed && !row.rejected;

  /**
   * Laadt de instelling en het voorbeeld en tekent het tabblad.
   * @returns {Promise<void>}
   */
  async function load() {
    state.data = await context.api('stock/price-factors');
    state.categories = state.data.config.categories.map((rule) => ({ ...rule }));
    state.suppliers = state.data.config.suppliers.map((rule) => ({ ...rule }));
    state.selected = new Set(state.data.preview.filter(isOpen).map((row) => row.id));
    renderSettings();
    renderPreview();
  }

  /**
   * Tekent een lijst met factoren per categorie of leverancier.
   * @param {string} kind 'categories' of 'suppliers'.
   * @returns {string} De regels als html.
   */
  function rulesHtml(kind) {
    const { esc } = context;
    const isCategory = kind === 'categories';
    const options = isCategory ? state.data.categories : state.data.suppliers;
    const key = isCategory ? 'categorySlug' : 'supplierId';
    return state[kind].map((rule, index) => `<div class="pf-rule">
      <select data-rule="${kind}" data-index="${index}" data-field="${key}" aria-label="${isCategory ? 'Categorie' : 'Leverancier'}">${options.map((option) => {
        const value = isCategory ? option.slug : option.id;
        const label = isCategory ? `${'– '.repeat(option.depth)}${option.name}` : option.name;
        return `<option value="${esc(value)}"${rule[key] === value ? ' selected' : ''}>${esc(label)}</option>`;
      }).join('')}</select>
      <input type="number" min="0.1" max="50" step="0.01" inputmode="decimal" value="${esc(rule.factor)}" data-rule="${kind}" data-index="${index}" data-field="factor" aria-label="Factor">
      <button class="btn small" type="button" data-remove="${kind}" data-index="${index}" aria-label="Regel verwijderen">✕</button></div>`).join('')
      || `<p class="muted small">Nog geen ${isCategory ? 'categorieën' : 'leveranciers'} met een eigen factor.</p>`;
  }

  /** Tekent het formulier met de instelling. */
  function renderSettings() {
    const form = $('#pf-form');
    const { config, roundingModes, directions } = state.data;
    form.defaultFactor.value = config.defaultFactor == null ? '' : config.defaultFactor;
    form.roundingMode.innerHTML = roundingModes.map((mode) => `<option value="${context.esc(mode.mode)}">${context.esc(mode.label)}</option>`).join('');
    form.roundingMode.value = config.rounding.mode;
    form.roundingDirection.innerHTML = directions.map((direction) => `<option value="${context.esc(direction)}">${direction === 'omhoog' ? 'Naar boven' : 'Naar het dichtstbijzijnde'}</option>`).join('');
    form.roundingDirection.value = config.rounding.direction;
    $('#pf-categories').innerHTML = rulesHtml('categories');
    $('#pf-suppliers').innerHTML = rulesHtml('suppliers');
    $('#pf-add-category').disabled = !state.data.categories.length;
    $('#pf-add-supplier').disabled = !state.data.suppliers.length;
    $('.err', form).textContent = '';
  }

  /**
   * De regels van het voorbeeld die nu zichtbaar zijn.
   * @returns {object[]} De rijen.
   */
  function visibleRows() {
    return state.data.preview.filter((row) => !state.onlyChanged || row.changed || row.problem);
  }

  /** Tekent het voorbeeld van de herberekening. */
  function renderPreview() {
    const { esc, eur } = context;
    const rows = visibleRows();
    const applicable = rows.filter(isOpen);
    const picked = [...state.selected].filter((id) => applicable.some((row) => row.id === id)).length;
    const { changedCount, rejectedCount } = state.data;
    $('#pf-count').textContent = `${changedCount} prijsvoorstel${changedCount === 1 ? '' : 'len'} wacht${changedCount === 1 ? '' : 'en'} op goedkeuring${rejectedCount ? `, ${rejectedCount} afgewezen` : ''} (${state.data.preview.length} artikel${state.data.preview.length === 1 ? '' : 'en'} met prijs volgens factor).`;
    $('#pf-apply').textContent = `Goedkeuren (${picked})`;
    $('#pf-apply').disabled = !picked;
    $('#pf-reject').textContent = `Afwijzen (${picked})`;
    $('#pf-reject').disabled = !picked;
    $('#pf-all').checked = applicable.length > 0 && applicable.every((row) => state.selected.has(row.id));
    $('#pf-all').disabled = !applicable.length;
    $('#pf-table').innerHTML = rows.length ? `<thead><tr><th></th><th>Artikel</th><th class="num">Inkoop</th><th>Factor</th><th class="num">Huidige prijs</th><th class="num">Nieuwe prijs</th><th class="num">Marge nu</th><th class="num">Marge nieuw</th><th></th></tr></thead>
      <tbody>${rows.map((row) => `<tr class="${row.problem || row.rejected ? 'arch' : ''}">
        <td>${isOpen(row) ? `<input type="checkbox" data-pick="${esc(row.id)}"${state.selected.has(row.id) ? ' checked' : ''} aria-label="${esc(row.code)} goedkeuren">` : ''}</td>
        <td class="wrap"><b class="code">${esc(row.code)}</b><span class="sub">${esc(row.name)}</span></td>
        <td class="num">${row.costPrice == null ? '' : esc(eur(row.costPrice))}</td>
        <td>${row.factor == null ? '' : `${esc(context.nl(row.factor))}<span class="sub">${esc(SOURCE_LABELS[row.source] || '')}</span>`}</td>
        <td class="num">${row.oldPrice == null ? '' : esc(eur(row.oldPrice))}</td>
        <td class="num">${row.problem ? `<span class="muted">${esc(row.problem)}</span>` : `<b>${esc(eur(row.newPrice))}</b>`}</td>
        <td class="num">${esc(pct(row.marginOld))}</td>
        <td class="num${row.marginNew != null && row.marginNew < 0 ? ' neg' : ''}">${esc(pct(row.marginNew))}</td>
        <td class="num">${isOpen(row) ? `<button class="btn small" type="button" data-reject="${esc(row.id)}">Afwijzen</button>` : row.rejected ? `<span class="muted">Afgewezen</span> <button class="btn small" type="button" data-reopen="${esc(row.id)}">Heropenen</button>` : ''}</td></tr>`).join('')}</tbody>`
      : `<tbody><tr><td class="empty">${state.data.preview.length ? 'Alle prijzen volgen de instelling.' : 'Geen artikelen met prijs volgens factor. Kies bij een artikel Prijsbepaling: inkoopprijs × factor.'}</td></tr></tbody>`;
  }

  /**
   * Leest de instelling uit het formulier.
   * @returns {object} De instelling voor de API.
   */
  function readSettings() {
    const form = $('#pf-form');
    const factor = form.defaultFactor.value;
    return {
      defaultFactor: factor === '' ? null : Number(factor),
      rounding: { mode: form.roundingMode.value, direction: form.roundingDirection.value },
      categories: state.categories, suppliers: state.suppliers,
    };
  }

  /**
   * Bewaart de instelling en ververst het voorbeeld.
   * @param {SubmitEvent} event het verzenden
   * @returns {Promise<void>}
   */
  async function submitSettings(event) {
    event.preventDefault();
    const form = $('#pf-form');
    $('.err', form).textContent = '';
    try {
      state.data = await context.api('stock/price-factors', { method: 'PUT', body: readSettings() });
      state.selected = new Set(state.data.preview.filter(isOpen).map((row) => row.id));
      context.toast('Prijsfactor opgeslagen');
      renderSettings();
      renderPreview();
    } catch (error) {
      $('.err', form).textContent = error.message;
    }
  }

  /**
   * Voert de nieuwe prijzen van de aangevinkte artikelen door.
   * @returns {Promise<void>}
   */
  async function applySelected() {
    const items = state.data.preview.filter((row) => isOpen(row) && state.selected.has(row.id)).map((row) => ({ id: row.id, newPrice: row.newPrice }));
    if (!items.length) return;
    const applyButton = $('#pf-apply');
    applyButton.disabled = true;
    try {
      const result = await context.api('stock/price-factors/apply', { method: 'POST', body: { items } });
      context.toast(`${result.updated} prijs${result.updated === 1 ? '' : 'zen'} goedgekeurd en doorgevoerd${result.skipped ? `, ${result.skipped} overgeslagen (intussen gewijzigd)` : ''}`, result.skipped > 0);
      await load();
    } catch (error) {
      context.toast(error.message, true);
      applyButton.disabled = false;
    }
  }

  /**
   * Wijst voorstellen af (de gekozen, of één regel) of opent een afgewezen voorstel weer.
   * @param {'reject'|'reopen'} action Wat er gebeurt.
   * @param {string[]} ids De artikelen.
   * @returns {Promise<void>}
   */
  async function decide(action, ids) {
    const items = state.data.preview.filter((row) => ids.includes(row.id)).map((row) => ({ id: row.id, newPrice: row.newPrice }));
    if (!items.length) return;
    try {
      if (action === 'reject') {
        const result = await context.api('stock/price-factors/reject', { method: 'POST', body: { items } });
        context.toast(`${result.rejected} voorstel${result.rejected === 1 ? '' : 'len'} afgewezen${result.skipped ? `, ${result.skipped} overgeslagen (intussen gewijzigd)` : ''}`, result.skipped > 0);
      } else {
        await context.api('stock/price-factors/reopen', { method: 'POST', body: { ids } });
        context.toast('Voorstel heropend');
      }
      await load();
    } catch (error) {
      context.toast(error.message, true);
    }
  }

  /**
   * Exporteert het voorbeeld naar Excel.
   * @returns {Promise<void>}
   */
  async function exportPreview() {
    const excelWorkbook = await context.workbook();
    if (!excelWorkbook) return;
    const sheet = excelWorkbook.addWorksheet('Prijsfactor');
    sheet.columns = [
      { header: 'Code', key: 'code', width: 16 }, { header: 'Omschrijving', key: 'name', width: 42 },
      { header: 'Inkoopprijs', key: 'costPrice', width: 12, style: { numFmt: '€ #,##0.00##' } }, { header: 'Factor', key: 'factor', width: 9 }, { header: 'Bron', key: 'source', width: 13 },
      { header: 'Huidige prijs excl. btw', key: 'oldPrice', width: 16, style: { numFmt: '€ #,##0.00' } }, { header: 'Nieuwe prijs excl. btw', key: 'newPrice', width: 16, style: { numFmt: '€ #,##0.00' } },
      { header: 'Marge nu %', key: 'marginOld', width: 11 }, { header: 'Marge nieuw %', key: 'marginNew', width: 13 }, { header: 'Afwijkend', key: 'changed', width: 10 }, { header: 'Opmerking', key: 'problem', width: 22 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const row of state.data.preview) sheet.addRow({ ...row, source: SOURCE_LABELS[row.source] || '', changed: row.rejected ? 'afgewezen' : row.changed ? 'ja' : '' });
    await context.save(excelWorkbook, `prijsfactor-${context.stamp()}.xlsx`);
  }

  /**
   * Hangt de gebeurtenissen aan het tabblad.
   * @param {{ api: Function, toast: Function, esc: Function, nl: Function, eur: Function, workbook: Function, save: Function, stamp: Function }} options Hulpfuncties van de pagina.
   * @returns {void}
   */
  function setup(options) {
    Object.assign(context, options);
    $('#pf-form').onsubmit = submitSettings;
    /** Voegt een categorie met een eigen factor toe (de eerste die nog geen regel heeft). */
    $('#pf-add-category').onclick = () => {
      const used = new Set(state.categories.map((rule) => rule.categorySlug));
      const free = state.data.categories.find((category) => !used.has(category.slug));
      if (!free) return;
      state.categories.push({ categorySlug: free.slug, factor: state.data.config.defaultFactor || 2 });
      $('#pf-categories').innerHTML = rulesHtml('categories');
    };
    /** Voegt een leverancier met een eigen factor toe (de eerste die nog geen regel heeft). */
    $('#pf-add-supplier').onclick = () => {
      const used = new Set(state.suppliers.map((rule) => rule.supplierId));
      const free = state.data.suppliers.find((supplier) => !used.has(supplier.id));
      if (!free) return;
      state.suppliers.push({ supplierId: free.id, factor: state.data.config.defaultFactor || 2 });
      $('#pf-suppliers').innerHTML = rulesHtml('suppliers');
    };
    $('#pf-form').addEventListener('input', (event) => {
      const target = event.target;
      if (!target.dataset || !target.dataset.rule) return;
      const rule = state[target.dataset.rule][Number(target.dataset.index)];
      if (rule) rule[target.dataset.field] = target.dataset.field === 'factor' ? Number(target.value) : target.value;
    });
    $('#pf-form').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove]');
      if (!button) return;
      state[button.dataset.remove].splice(Number(button.dataset.index), 1);
      $(`#pf-${button.dataset.remove}`).innerHTML = rulesHtml(button.dataset.remove);
    });
    /**
     * Toont alleen de afwijkende artikelen, of alle.
     * @param {Event} event de wijziging van het vinkje
     */
    $('#pf-only').onchange = (event) => { state.onlyChanged = event.target.checked; renderPreview(); };
    /**
     * Kiest alle zichtbare afwijkende artikelen, of geen.
     * @param {Event} event de wijziging van het vinkje
     */
    $('#pf-all').onchange = (event) => {
      for (const row of visibleRows().filter(isOpen)) {
        if (event.target.checked) state.selected.add(row.id); else state.selected.delete(row.id);
      }
      renderPreview();
    };
    /** Wijst de aangevinkte voorstellen af. */
    $('#pf-reject').onclick = () => { decide('reject', [...state.selected]); };
    $('#pf-table').addEventListener('click', (event) => {
      const rejectId = event.target.dataset && event.target.dataset.reject;
      const reopenId = event.target.dataset && event.target.dataset.reopen;
      if (rejectId) decide('reject', [rejectId]);
      if (reopenId) decide('reopen', [reopenId]);
    });
    $('#pf-table').addEventListener('change', (event) => {
      const id = event.target.dataset && event.target.dataset.pick;
      if (!id) return;
      if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
      renderPreview();
    });
    /** Voert de aangevinkte prijzen door. */
    $('#pf-apply').onclick = () => { applySelected(); };
    /** Exporteert het voorbeeld naar Excel. */
    $('#pf-export').onclick = () => { exportPreview().catch((error) => context.toast(error.message, true)); };
  }

  window.ArtikelenPriceFactor = { setup, load };
})();
