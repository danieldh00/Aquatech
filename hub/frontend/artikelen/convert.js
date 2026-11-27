// Bestaande omzetten (module Artikelen): het tabblad waarmee bestaande artikelen hun sprekende code krijgen (MERK.SOORT.DIAMETER.DRAADMAAT).
// Per artikel staat een voorstel (soort, diameter, draadmaat, nieuwe code); je past aan wat niet klopt, vinkt aan en zet om. De oude code
// blijft als zoeknaam bestaan. Praat met /api/stock/code-conversion en /api/stock/code-conversion/apply (recht 'voorraad').
(function () {
  const BATCH_SIZE = 200;
  const context = { api: null, toast: null, esc: null };
  const state = { rows: [], mainGroups: [], subGroups: [], converted: 0, busy: false };

  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @param {ParentNode} scope waarbinnen gezocht wordt (standaard het document)
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector, scope = document) => scope.querySelector(selector);

  /**
   * De nieuwe code van een regel, zoals hij uit de gekozen soort, diameter en draadmaat volgt.
   * @param {object} row De regel.
   * @returns {string} De code, of leeg als er (nog) geen geldige code uit komt.
   */
  function codeOf(row) {
    const sub = state.subGroups.find((group) => group.id === row.subGroupId);
    if (!sub) return '';
    const main = sub.main_group_id ? state.mainGroups.find((group) => group.id === sub.main_group_id) : null;
    const thread = window.ArticleCode.threadCode(row.thread);
    if (thread.error) return '';
    const parts = { brand: main ? main.code : '', kind: sub.code };
    if (!row.isGroup) {
      if (!row.diameter) return '';
      Object.assign(parts, { diameter: String(row.diameter).trim(), thread: thread.code });
    }
    return window.ArticleCode.buildCode(parts).code || '';
  }

  /**
   * De leesbare naam van een soort in de keuzelijst: merk, soortcode en naam.
   * @param {object} sub De soort.
   * @returns {string} De tekst.
   */
  function subLabel(sub) {
    const main = sub.main_group_id ? state.mainGroups.find((group) => group.id === sub.main_group_id) : null;
    return `${main ? `${main.code}.` : ''}${sub.code} · ${sub.name}`;
  }

  /**
   * Of een regel nog omgezet moet worden en door het filter komt.
   * @param {object} row De regel.
   * @returns {boolean} true als de regel getoond wordt.
   */
  function visible(row) {
    const filter = $('#cv-filter').value;
    if (filter === 'klaar') return row.status === 'klaar' || row.status === 'aangepast';
    if (filter === 'aandacht') return !['klaar', 'aangepast', 'omgezet'].includes(row.status);
    return true;
  }

  /** Tekent de samenvatting boven de tabel. */
  function renderSummary() {
    const open = state.rows.filter((row) => row.status !== 'omgezet');
    const ready = open.filter((row) => codeOf(row)).length;
    $('#cv-summary').textContent = `${open.length} artikelen zonder sprekende code, waarvan ${ready} met een geldig voorstel. Al omgezet: ${state.converted + state.rows.length - open.length}.`;
    $('#cv-apply').disabled = state.busy || !state.rows.some((row) => row.selected && row.status !== 'omgezet' && codeOf(row));
  }

  /** Tekent de tabel met voorstellen. */
  function renderTable() {
    const esc = context.esc;
    const options = `<option value="">(kies een soort)</option>${state.subGroups.map((sub) => `<option value="${esc(sub.id)}">${esc(subLabel(sub))}</option>`).join('')}`;
    const rows = state.rows.filter(visible);
    $('#cv-table').innerHTML = rows.length ? `<thead><tr><th></th><th>Oude code</th><th>Naam</th><th>Soort</th><th>Diameter</th><th>Draadmaat</th><th>Nieuwe code</th><th>Opmerking</th></tr></thead>
      <tbody>${rows.map((row) => {
    const done = row.status === 'omgezet';
    const code = done ? row.newCode : codeOf(row);
    return `<tr data-id="${esc(row.id)}" class="${done ? 'arch' : ''}"><td><input type="checkbox" data-select ${row.selected && !done ? 'checked' : ''} ${done || !code ? 'disabled' : ''} aria-label="Omzetten"></td>
        <td><b>${esc(row.code)}</b></td><td class="wrap">${esc(row.name)}${row.isGroup ? ' <span class="pill">Artikelgroep</span>' : ''}</td>
        <td><select data-field="subGroupId" ${done ? 'disabled' : ''}>${options.replace(`value="${esc(row.subGroupId)}"`, `value="${esc(row.subGroupId)}" selected`)}</select></td>
        <td><input data-field="diameter" size="4" inputmode="numeric" value="${esc(row.diameter)}" ${done || row.isGroup ? 'disabled' : ''}></td>
        <td><input data-field="thread" size="6" value="${esc(row.thread)}" ${done || row.isGroup ? 'disabled' : ''}></td>
        <td data-code><b>${esc(code)}</b></td><td class="small ${done ? '' : 'muted'}" data-note>${esc(done ? row.note || 'Omgezet' : row.note)}</td></tr>`;
  }).join('')}</tbody>`
      : '<tbody><tr><td class="muted">Geen artikelen om te tonen.</td></tr></tbody>';
    renderSummary();
  }

  /**
   * Laadt de voorstellen van de server en tekent ze.
   * @returns {Promise<void>}
   */
  async function load() {
    const result = await context.api('stock/code-conversion');
    state.mainGroups = result.groups.mainGroups;
    state.subGroups = result.groups.subGroups;
    state.converted = result.converted;
    state.rows = result.items.map((item) => ({ ...item, selected: item.status === 'klaar' }));
    renderTable();
  }

  /**
   * Werkt één regel bij nadat de gebruiker een veld heeft gewijzigd en toont de nieuwe code.
   * @param {HTMLElement} rowElement De tabelrij.
   * @param {object} row De regel.
   */
  function refreshRow(rowElement, row) {
    const code = codeOf(row);
    $('[data-code]', rowElement).innerHTML = `<b>${context.esc(code)}</b>`;
    $('[data-note]', rowElement).textContent = code ? '' : 'Kies een soort en vul de diameter in.';
    row.note = code ? '' : 'Kies een soort en vul de diameter in.';
    row.status = code ? 'aangepast' : 'geen_soort';
    const checkbox = $('[data-select]', rowElement);
    checkbox.disabled = !code;
    if (!code) { checkbox.checked = false; row.selected = false; }
    renderSummary();
  }

  /**
   * Zet de aangevinkte regels om, in porties, en verwerkt de uitkomst per regel.
   * @returns {Promise<void>}
   */
  async function apply() {
    const chosen = state.rows.filter((row) => row.selected && row.status !== 'omgezet' && codeOf(row));
    if (!chosen.length || state.busy) return;
    state.busy = true;
    renderSummary();
    let converted = 0;
    let rejected = 0;
    try {
      for (let start = 0; start < chosen.length; start += BATCH_SIZE) {
        const batch = chosen.slice(start, start + BATCH_SIZE);
        const result = await context.api('stock/code-conversion/apply', { method: 'POST', body: { rows: batch.map((row) => ({ id: row.id, subGroupId: row.subGroupId, diameter: row.diameter, thread: row.thread })) } });
        for (const outcome of result.results) {
          const row = state.rows.find((entry) => entry.id === outcome.id);
          if (!row) continue;
          if (outcome.ok) Object.assign(row, { status: 'omgezet', newCode: outcome.code, selected: false, note: outcome.warning || '' });
          else Object.assign(row, { status: outcome.status || 'fout', note: outcome.error, selected: false });
        }
        converted += result.converted;
        rejected += result.results.length - result.converted;
      }
      context.toast(`${converted} artikelen omgezet${rejected ? `, ${rejected} niet (zie de opmerking)` : ''}.`, rejected > 0);
    } catch (error) {
      context.toast(error.message, true);
    } finally {
      state.busy = false;
      renderTable();
    }
  }

  /**
   * Zet de lijst zoals hij nu op het scherm staat in een Excel-bestand.
   * @returns {Promise<void>}
   */
  async function downloadExcel() {
    if (!state.rows.length) return;
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { context.toast('Excel-export niet beschikbaar.', true); return; }
    const excelWorkbook = new ExcelJS.Workbook();
    const worksheet = excelWorkbook.addWorksheet('Omzetten', { views: [{ state: 'frozen', ySplit: 1 }] });
    worksheet.columns = [{ header: 'Oude code', key: 'oldCode', width: 24 }, { header: 'Naam', key: 'name', width: 70 }, { header: 'Soort', key: 'kind', width: 36 },
      { header: 'Diameter', key: 'diameter', width: 10 }, { header: 'Draadmaat', key: 'thread', width: 12 }, { header: 'Nieuwe code', key: 'newCode', width: 24 }, { header: 'Status', key: 'status', width: 40 }];
    for (const row of state.rows) {
      const sub = state.subGroups.find((group) => group.id === row.subGroupId);
      worksheet.addRow({ oldCode: row.code, name: row.name, kind: sub ? subLabel(sub) : '', diameter: row.diameter, thread: row.thread, newCode: row.status === 'omgezet' ? row.newCode : codeOf(row), status: row.status === 'omgezet' ? 'Omgezet' : row.note || 'Voorstel' });
    }
    worksheet.getRow(1).font = { bold: true };
    const buffer = await excelWorkbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    link.download = `artikelcodes-omzetten-${new Date().toISOString().slice(0, 10)}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  /**
   * Koppelt de knoppen en de tabel.
   * @param {{ api: Function, toast: Function, esc: Function }} tools De hulpfuncties van de pagina.
   */
  function setup(tools) {
    Object.assign(context, tools);
    /** Past de lijst aan het gekozen filter aan. */
    $('#cv-filter').onchange = () => { renderTable(); };
    /** Vinkt alle regels met een geldig voorstel aan. */
    $('#cv-select-ready').onclick = () => {
      for (const row of state.rows) if (row.status !== 'omgezet') row.selected = Boolean(codeOf(row));
      renderTable();
    };
    /** Zet de aangevinkte regels om. */
    $('#cv-apply').onclick = () => { apply(); };
    /** Bewaart de lijst als Excel. */
    $('#cv-excel').onclick = () => { downloadExcel().catch((error) => context.toast(error.message, true)); };
    /**
     * Onthoudt een (de)selectie.
     * @param {Event} event de wijziging
     */
    $('#cv-table').onchange = (event) => {
      const rowElement = event.target.closest('tr[data-id]');
      const row = rowElement && state.rows.find((entry) => entry.id === rowElement.dataset.id);
      if (!row) return;
      if (event.target.matches('[data-select]')) { row.selected = event.target.checked; renderSummary(); return; }
      if (event.target.matches('[data-field]')) { row[event.target.dataset.field] = event.target.value; refreshRow(rowElement, row); }
    };
    /**
     * Werkt de nieuwe code bij tijdens het typen van diameter of draadmaat.
     * @param {Event} event de invoer
     */
    $('#cv-table').oninput = (event) => {
      const rowElement = event.target.closest('tr[data-id]');
      const row = rowElement && state.rows.find((entry) => entry.id === rowElement.dataset.id);
      if (!row || !event.target.matches('input[data-field]')) return;
      row[event.target.dataset.field] = event.target.value;
      refreshRow(rowElement, row);
    };
  }

  window.ArtikelenConvert = { setup, load };
}());
