// Selectie en bulkacties in de voorraadlijst (module Artikelen): meerdere artikelen tegelijk archiveren of etiketten printen.
// De lijst zelf staat in artikelen.js; dit bestand tekent het vinkje per rij en de balk, en praat met bestaande routes
// (PUT stock/items/:id voor archiveren, ItemLabels.print voor etiketten).
(function () {
  const selected = new Set();
  let context = null;
  let visibleItems = [];
  let templatesReady = false;
  /** Hoeveel artikelen in één keer gearchiveerd mogen worden (elk een eigen verzoek). */
  const MAX_ARCHIVE = 100;

  /**
   * Zoekt een element op id binnen de pagina.
   * @param {string} id Het id zonder #.
   * @returns {HTMLElement|null} Het element.
   */
  const byId = (id) => document.getElementById(id);

  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} text De tekst.
   * @returns {string} De tekst met &, <, > en " als entiteit.
   */
  const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));

  /**
   * Geeft de geselecteerde artikelen die nu in het overzicht staan: wat je ziet is wat er gebeurt.
   * @returns {object[]} De geselecteerde zichtbare artikelen.
   */
  const chosenItems = () => visibleItems.filter((item) => selected.has(item.id));

  /**
   * Of een artikel gearchiveerd kan worden (nog niet gearchiveerd).
   * @param {object} item Het artikel.
   * @returns {boolean} true als archiveren zin heeft.
   */
  const archivable = (item) => !item.archived;

  /**
   * Of er etiketten voor een artikel kunnen worden afgedrukt (geen hoofdartikel en niet gearchiveerd).
   * @param {object} item Het artikel.
   * @returns {boolean} true als het artikel een eigen etiket kan krijgen.
   */
  const labelable = (item) => !item.hasVariants && !item.archived;

  /**
   * Geeft de koppcel van de selectiekolom (alles selecteren voor de zichtbare rijen).
   * @param {object[]} rows De zichtbare rijen ({ item }).
   * @returns {string} De HTML van de kopcel.
   */
  function headerCell(rows) {
    const items = rows.map((row) => row.item);
    const allChecked = items.length > 0 && items.every((item) => selected.has(item.id));
    return `<th class="c-select"><input type="checkbox" data-select-all aria-label="Alle zichtbare artikelen selecteren"${allChecked ? ' checked' : ''}></th>`;
  }

  /**
   * Geeft de cel met het vinkje van één artikel.
   * @param {object} item Het artikel.
   * @returns {string} De HTML van de cel.
   */
  function cell(item) {
    return `<td class="c-select"><input type="checkbox" data-select aria-label="Artikel ${escapeHtml(item.code)} selecteren"${selected.has(item.id) ? ' checked' : ''}></td>`;
  }

  /**
   * Toont of verbergt de balk en werkt de tellers bij; selecties die niet meer zichtbaar zijn vallen weg.
   * @returns {void}
   */
  function renderBar() {
    const shownIds = new Set(visibleItems.map((item) => item.id));
    for (const id of [...selected]) if (!shownIds.has(id)) selected.delete(id);
    const chosen = chosenItems();
    byId('s-bulk').hidden = !chosen.length;
    byId('s-bulk-count').textContent = `${chosen.length} geselecteerd`;
    const toArchive = chosen.filter(archivable);
    const toLabel = chosen.filter(labelable);
    byId('s-bulk-archive').disabled = !toArchive.length;
    byId('s-bulk-archive').textContent = `Archiveren (${toArchive.length})`;
    byId('s-bulk-labels').disabled = !toLabel.length || !templatesReady;
    byId('s-bulk-labels').textContent = `Etiketten printen (${toLabel.length})`;
  }

  /**
   * Koppelt de vinkjes in de zojuist getekende tabel en toont de balk.
   * @param {HTMLElement} table De tabel.
   * @param {object[]} rows De zichtbare rijen ({ item }).
   * @returns {void}
   */
  function bind(table, rows) {
    visibleItems = rows.map((row) => row.item);
    table.querySelectorAll('input[data-select]').forEach((box) => {
      /**
       * Voorkomt dat een klik op het vinkje het artikel opent.
       * @param {MouseEvent} event De klik.
       * @returns {void}
       */
      box.onclick = (event) => { event.stopPropagation(); };
      /**
       * Zet het artikel in of uit de selectie.
       * @returns {void}
       */
      box.onchange = () => {
        const row = box.closest('tr');
        if (box.checked) selected.add(row.dataset.id); else selected.delete(row.dataset.id);
        row.classList.toggle('picked', box.checked);
        renderBar();
      };
    });
    const all = table.querySelector('input[data-select-all]');
    if (all) {
      /**
       * Voorkomt dat een klik op het vinkje iets anders doet.
       * @param {MouseEvent} event De klik.
       * @returns {void}
       */
      all.onclick = (event) => { event.stopPropagation(); };
      /**
       * Selecteert alle zichtbare artikelen of heft de selectie op.
       * @returns {void}
       */
      all.onchange = () => {
        for (const item of visibleItems) { if (all.checked) selected.add(item.id); else selected.delete(item.id); }
        context.rerender();
      };
    }
    renderBar();
  }

  /**
   * Maakt de selectie leeg en tekent het overzicht opnieuw.
   * @returns {void}
   */
  function clear() {
    selected.clear();
    context.rerender();
  }

  /**
   * Archiveert de geselecteerde artikelen na één bevestiging; een artikel dat nog op een open bestelling of werkorder staat blijft staan en wordt gemeld.
   * @returns {Promise<void>}
   */
  async function archiveSelected() {
    const items = chosenItems().filter(archivable);
    if (!items.length) return;
    if (items.length > MAX_ARCHIVE) { context.toast(`Hoogstens ${MAX_ARCHIVE} artikelen per keer archiveren; je hebt er ${items.length} gekozen.`, true); return; }
    const selectedIds = new Set(items.map((item) => item.id));
    const variantCount = context.items().filter((item) => item.parentId && !item.archived && !selectedIds.has(item.id) && selectedIds.has(item.parentId)).length;
    const variantText = variantCount ? ` Van de gekozen hoofdartikelen worden ook ${variantCount} ${variantCount === 1 ? 'variant' : 'varianten'} gearchiveerd.` : '';
    if (!confirm(`${items.length} ${items.length === 1 ? 'artikel' : 'artikelen'} archiveren?${variantText} Het logboek blijft bewaard en je kunt een artikel per stuk weer terugzetten. Een artikel op een open bestelling of werkorder blijft staan.`)) return;
    const button = byId('s-bulk-archive');
    button.disabled = true;
    const skipped = [];
    let done = 0;
    try {
      for (const item of items) {
        try {
          await context.api(`stock/items/${encodeURIComponent(item.id)}`, { method: 'PUT', body: { archived: true } });
          selected.delete(item.id);
          done += 1;
        } catch (error) {
          skipped.push(`${item.code}: ${error.message}`);
        }
      }
      try { await context.reload(); } catch (error) { skipped.push(`overzicht verversen mislukt: ${error.message}`); }
      context.toast(`${done} ${done === 1 ? 'artikel' : 'artikelen'} gearchiveerd${skipped.length ? `; niet gelukt: ${skipped.join('; ')}` : ''}`, skipped.length > 0);
    } catch (error) {
      context.toast(error.message, true);
      renderBar();
    }
  }

  /**
   * Drukt etiketten voor de geselecteerde artikelen (het gekozen aantal per artikel, gekozen sjabloon).
   * @returns {Promise<void>}
   */
  async function printSelected() {
    const items = chosenItems().filter(labelable);
    if (!items.length) return;
    const qty = Math.floor(Number(byId('s-bulk-qty').value));
    if (!(qty >= 1 && qty <= 500)) { context.toast('Kies een aantal van 1 tot 500 per artikel.', true); return; }
    if (qty * items.length > 500) { context.toast(`Hoogstens 500 etiketten per keer; je vraagt er ${qty * items.length}.`, true); return; }
    const button = byId('s-bulk-labels');
    button.disabled = true;
    try {
      await window.ItemLabels.print(items.map((item) => ({ id: item.id, qty })), byId('s-bulk-template').value);
    } catch (error) {
      context.toast(error.message, true);
    } finally {
      renderBar();
    }
  }

  /**
   * Vult de keuzelijst met etiketsjablonen; zonder sjablonen blijft de knop voor etiketten uit en staat de fout in de keuzelijst.
   * @returns {Promise<void>}
   */
  async function loadTemplates() {
    const select = byId('s-bulk-template');
    try {
      const config = await window.ItemLabels.templates();
      select.innerHTML = config.templates.map((template) => `<option value="${escapeHtml(template.key)}">${escapeHtml(template.name)}</option>`).join('');
      select.value = config.defaultKey;
      templatesReady = config.templates.length > 0;
    } catch (error) {
      templatesReady = false;
      select.innerHTML = `<option value="">${escapeHtml(error.message)}</option>`;
    }
    renderBar();
  }

  /**
   * Koppelt de knoppen van de balk.
   * @param {{ api: Function, toast: Function, reload: Function, rerender: Function, items: Function }} given De hulpfuncties van de pagina.
   * @returns {void}
   */
  function init(given) {
    context = given;
    byId('s-bulk-archive').onclick = archiveSelected;
    byId('s-bulk-labels').onclick = printSelected;
    byId('s-bulk-clear').onclick = clear;
    loadTemplates();
  }

  window.StockBulk = { init, headerCell, cell, bind, selected };
}());
