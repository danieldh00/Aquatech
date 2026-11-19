// Prijsfactor (module Artikelen, tabblad Prijsfactor): de standaardfactor, de afronding en de factoren per categorie
// en leverancier instellen (alleen beheerders), en een overzicht van alle artikelen met prijs volgens factor: inkoopprijs,
// factor en bron, verkoopprijs en marge. De verkoopprijzen volgen de instelling en de inkoopprijs vanzelf, zonder goedkeuring.
// Praat met /api/stock/price-factors (lezen: recht voorraad; opslaan: recht beheer).
(function () {
  const context = { api: null, toast: null, esc: null, nl: null, eur: null, workbook: null, save: null, stamp: null };
  const state = { data: null, categories: [], suppliers: [], onlyProblems: true };
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
   * Laadt de instelling en het overzicht en tekent het tabblad.
   * @returns {Promise<void>}
   */
  async function load() {
    state.data = await context.api('stock/price-factors');
    state.categories = state.data.config.categories.map((rule) => ({ ...rule }));
    state.suppliers = state.data.config.suppliers.map((rule) => ({ ...rule }));
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
    return state.data.preview.filter((row) => !state.onlyProblems || row.problem);
  }

  /** Tekent het overzicht van de artikelen met prijs volgens factor. */
  function renderPreview() {
    const { esc, eur } = context;
    const rows = visibleRows();
    const total = state.data.preview.length;
    $('#pf-count').textContent = `${total} artikel${total === 1 ? '' : 'en'} met prijs volgens factor; de verkoopprijs volgt de inkoopprijs en de instelling automatisch.`;
    $('#pf-table').innerHTML = rows.length ? `<thead><tr><th>Artikel</th><th class="num">Inkoop</th><th>Factor</th><th class="num">Verkoopprijs</th><th class="num">Marge</th><th>Opmerking</th></tr></thead>
      <tbody>${rows.map((row) => `<tr class="${row.problem ? 'arch' : ''}">
        <td class="wrap"><b class="code">${esc(row.code)}</b><span class="sub">${esc(row.name)}</span></td>
        <td class="num">${row.costPrice == null ? '' : esc(eur(row.costPrice))}</td>
        <td>${row.factor == null ? '' : `${esc(context.nl(row.factor))}<span class="sub">${esc(SOURCE_LABELS[row.source] || '')}</span>`}</td>
        <td class="num">${row.oldPrice == null ? '' : `<b>${esc(eur(row.oldPrice))}</b>`}</td>
        <td class="num${row.marginOld != null && row.marginOld < 0 ? ' neg' : ''}">${esc(pct(row.marginOld))}</td>
        <td>${row.problem ? `<span class="muted">${esc(row.problem)}</span>` : ''}</td></tr>`).join('')}</tbody>`
      : `<tbody><tr><td class="empty">${total ? 'Alle artikelen hebben een prijs volgens de instelling.' : 'Geen artikelen met prijs volgens factor. Kies bij een artikel Prijsbepaling: inkoopprijs × factor.'}</td></tr></tbody>`;
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
        context.toast('Prijsfactor opgeslagen');
      renderSettings();
      renderPreview();
    } catch (error) {
      $('.err', form).textContent = error.message;
    }
  }

  /**
   * Exporteert het overzicht naar Excel.
   * @returns {Promise<void>}
   */
  async function exportPreview() {
    const excelWorkbook = await context.workbook();
    if (!excelWorkbook) return;
    const sheet = excelWorkbook.addWorksheet('Prijsfactor');
    sheet.columns = [
      { header: 'Code', key: 'code', width: 16 }, { header: 'Omschrijving', key: 'name', width: 42 },
      { header: 'Inkoopprijs', key: 'costPrice', width: 12, style: { numFmt: '€ #,##0.00##' } }, { header: 'Factor', key: 'factor', width: 9 }, { header: 'Bron', key: 'source', width: 13 },
      { header: 'Verkoopprijs excl. btw', key: 'oldPrice', width: 16, style: { numFmt: '€ #,##0.00' } },
      { header: 'Marge %', key: 'marginOld', width: 11 }, { header: 'Opmerking', key: 'problem', width: 22 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const row of state.data.preview) sheet.addRow({ ...row, source: SOURCE_LABELS[row.source] || '' });
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
     * Toont alleen de artikelen met een opmerking, of alle.
     * @param {Event} event de wijziging van het vinkje
     */
    $('#pf-only').onchange = (event) => { state.onlyProblems = event.target.checked; renderPreview(); };
    /** Exporteert het overzicht naar Excel. */
    $('#pf-export').onclick = () => { exportPreview().catch((error) => context.toast(error.message, true)); };
  }

  window.ArtikelenPriceFactor = { setup, load };
})();
