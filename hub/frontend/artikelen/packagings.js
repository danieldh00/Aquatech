// Blok Verpakkingen bij een artikel: grotere verkoopeenheden (doos, pallet) met aantal, eigen prijs, EAN en doelgroep.
(function () {
  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector De CSS-selector.
   * @param {ParentNode} [root] Waarin gezocht wordt.
   * @returns {Element|null} Het element.
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  const context = {};
  const state = { item: null, lines: [], loaded: false };
  const AUDIENCES = [['iedereen', 'Iedereen'], ['zakelijk', 'Zakelijk'], ['groothandel', 'Groothandel']];

  /**
   * Zet Bewaren en Toevoegen uit zolang de verpakkingen nog laden.
   * @param {boolean} busy true tijdens het laden
   */
  function setBusy(busy) {
    $('#d-packagings button[data-save]').disabled = busy;
    $('#pk-add').disabled = busy;
  }

  /**
   * Toont het blok bij een artikel (niet bij een hoofdartikel met varianten).
   * @param {object} item Het artikel.
   * @returns {Promise<void>}
   */
  async function showItem(item) {
    const section = $('#d-packagings');
    state.item = item;
    state.lines = [];
    state.loaded = false;
    $('#d-pk-table').innerHTML = '';
    setBusy(true);
    section.hidden = Boolean(item.hasVariants);
    $('.err', section).textContent = '';
    if (item.hasVariants) return;
    let result;
    try {
      result = await context.api(`stock/items/${encodeURIComponent(item.id)}/packagings`);
    } catch (error) {
      // Bewaren blijft uit: er is niets geladen om te bewaren.
      if (state.item && state.item.id === item.id) $('.err', section).textContent = error.message;
      return;
    }
    if (!state.item || state.item.id !== item.id) return;
    state.lines = result.items;
    state.loaded = true;
    setBusy(Boolean(item.archived));
    render();
  }

  /** Tekent de verpakkingsregels. */
  function render() {
    const { esc } = context;
    const item = state.item;
    $('#d-pk-table').innerHTML = state.lines.length ? `<thead><tr><th>Code</th><th>Naam</th><th class="num">Aantal (${esc(item.unit)})</th><th class="num">Prijs (€ excl.)</th><th class="num">Zakelijk (€ excl.)</th><th>EAN</th><th>Zichtbaar voor</th><th>Actief</th><th></th></tr></thead>
      <tbody>${state.lines.map((line, index) => `<tr data-line="${index}">
        <td><input data-field="code" value="${esc(line.code)}" maxlength="12" aria-label="Code"></td>
        <td><input data-field="name" value="${esc(line.name)}" maxlength="40" aria-label="Naam"></td>
        <td class="num"><input data-field="factor" type="number" min="2" step="1" inputmode="numeric" value="${esc(line.factor)}" aria-label="Aantal per verpakking"></td>
        <td class="num"><input data-field="salePrice" type="number" min="0" step="0.01" inputmode="decimal" value="${line.salePrice == null ? '' : line.salePrice}" placeholder="aantal × stukprijs" aria-label="Prijs"></td>
        <td class="num"><input data-field="businessPrice" type="number" min="0" step="0.01" inputmode="decimal" value="${line.businessPrice == null ? '' : line.businessPrice}" placeholder="zoals prijs" aria-label="Zakelijke prijs"></td>
        <td><input data-field="ean" value="${esc(line.ean || '')}" maxlength="14" inputmode="numeric" aria-label="EAN"></td>
        <td><select data-field="audience" aria-label="Zichtbaar voor">${AUDIENCES.map(([key, label]) => `<option value="${key}"${line.audience === key ? ' selected' : ''}>${label}</option>`).join('')}</select></td>
        <td><input type="checkbox" data-field="active" ${line.active ? 'checked' : ''} aria-label="Actief"></td>
        <td class="num"><button class="btn small danger" type="button" data-drop="${index}">Weghalen</button></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">Nog geen verpakkingen bij dit artikel.</td></tr></tbody>';
    $('#d-packagings .row').hidden = Boolean(item.archived);
  }

  /** Neemt de ingevulde velden over in de regels (voor weghalen of toevoegen). */
  function readLines() {
    document.querySelectorAll('#d-pk-table tr[data-line]').forEach((row) => {
      const line = state.lines[Number(row.dataset.line)];
      for (const field of ['code', 'name', 'factor', 'salePrice', 'businessPrice', 'ean', 'audience']) line[field] = row.querySelector(`[data-field=${field}]`).value;
      line.active = row.querySelector('[data-field=active]').checked;
    });
  }

  /**
   * Bewaart de verpakkingen van het artikel.
   * @returns {Promise<void>}
   */
  async function save() {
    if (!state.loaded) return;
    const errorBox = $('#d-packagings .err');
    errorBox.textContent = '';
    readLines();
    try {
      const result = await context.api(`stock/items/${encodeURIComponent(state.item.id)}/packagings`, { method: 'PUT', body: { packagings: state.lines } });
      state.lines = result.items;
      render();
      context.toast('Verpakkingen bewaard');
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  /**
   * Koppelt de knoppen.
   * @param {{ api: Function, toast: Function, esc: Function }} options Hulpfuncties van de pagina.
   */
  function setup(options) {
    Object.assign(context, options);
    /** Bewaart de verpakkingen. */
    $('#d-packagings button[data-save]').onclick = () => { save(); };
    /** Zet een lege regel bij (pas bewaard met Bewaren). */
    $('#pk-add').onclick = () => {
      readLines();
      state.lines.push({ code: '', name: '', factor: '', salePrice: null, businessPrice: null, ean: '', audience: 'iedereen', active: true });
      render();
    };
    /**
     * Haalt een regel weg (pas bewaard met Bewaren).
     * @param {MouseEvent} event de klik
     */
    $('#d-pk-table').onclick = (event) => {
      const button = event.target.closest('[data-drop]');
      if (!button) return;
      readLines();
      state.lines.splice(Number(button.dataset.drop), 1);
      render();
    };
  }

  window.ArtikelenPackagings = { setup, showItem };
})();
