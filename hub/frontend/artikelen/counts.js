// Voorraadtelling (module Artikelen): het tabblad Telling met de lijst van tellingen, een telling starten, de voortgang per locatie, de regels met
// verschillen, hertellen, afsluiten (met wachtwoord) en annuleren, en een Excel met samenvatting, regels en ingaven. Praat met /api/stock-counts
// (recht 'voorraad'); de tellers tellen blind in de orderpick-app.
(function () {
  const context = { api: null, toast: null, esc: null, nl: null, eur: null, workbook: null, save: null, stamp: null };
  const PAGE = 100;
  const KIND_NAMES = { jaar: 'Jaartelling', tussentijds: 'Tussentijds' };
  const STATUS_NAMES = { tellen: 'Loopt', afgesloten: 'Afgesloten', geannuleerd: 'Geannuleerd' };
  const LINE_STATUS_NAMES = { open: 'Niet geteld', geteld: 'Geteld', hertellen: 'Hertellen' };
  const state = { counts: [], current: null, lines: [], total: 0, run: 0 };

  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @param {ParentNode} scope waarbinnen gezocht wordt (standaard het document)
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector, scope = document) => scope.querySelector(selector);

  /**
   * Maakt een datum leesbaar (jjjj-mm-dd naar dd-mm-jjjj).
   * @param {string} value Een datum of tijdstip als ISO-tekst.
   * @returns {string} De datum, of leeg.
   */
  function dateText(value) {
    return value ? String(value).slice(0, 10).split('-').reverse().join('-') : '';
  }

  /**
   * Laadt de tellingen en tekent de lijst.
   * @returns {Promise<void>}
   */
  async function load() {
    const result = await context.api('stock-counts');
    state.counts = result.counts;
    showList();
  }

  /** Toont de lijst van tellingen en verbergt het detail. */
  function showList() {
    state.current = null;
    $('#ct-detail').hidden = true;
    $('#ct-list').hidden = false;
    const esc = context.esc;
    $('#ct-table').innerHTML = state.counts.length ? `<thead><tr><th>Nummer</th><th>Soort</th><th>Peildatum</th><th>Status</th><th>Gestart door</th><th>Afgesloten</th><th></th></tr></thead>
      <tbody>${state.counts.map((count) => `<tr>
        <td>${esc(count.number)}</td><td>${esc(KIND_NAMES[count.kind] || count.kind)}</td><td>${esc(dateText(count.referenceDate))}</td>
        <td>${esc(STATUS_NAMES[count.status] || count.status)}</td><td>${esc(count.createdBy)}</td><td>${esc(dateText(count.closedAt))}</td>
        <td class="num"><button class="btn small" type="button" data-open="${esc(count.id)}">Openen</button></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">Nog geen tellingen.</td></tr></tbody>';
  }

  /**
   * Opent het formulier voor een nieuwe telling.
   */
  function openStartForm() {
    const form = $('#ct-form');
    form.reset();
    form.referenceDate.value = new Date().toISOString().slice(0, 10);
    $('.err', form).textContent = '';
    form.hidden = false;
  }

  /**
   * Start de telling uit het formulier.
   * @param {SubmitEvent} event het verzenden
   * @returns {Promise<void>}
   */
  async function submitStart(event) {
    event.preventDefault();
    const form = event.target;
    const errorBox = $('.err', form);
    errorBox.textContent = '';
    const body = {
      kind: form.kind.value, referenceDate: form.referenceDate.value, note: form.note.value,
      threshold: { amount: Number(form.amount.value), pct: Number(form.pct.value) },
    };
    if (form.kind.value === 'tussentijds') body.locations = form.locations.value.split(',').map((text) => text.trim()).filter(Boolean);
    try {
      const result = await context.api('stock-counts', { method: 'POST', body });
      form.hidden = true;
      context.toast(`Telling ${result.count.number} gestart`);
      await openCount(result.count.id);
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  /**
   * Opent een telling: het overzicht, de voortgang per locatie en de eerste regels.
   * @param {string} id Id van de telling.
   * @returns {Promise<void>}
   */
  async function openCount(id) {
    const result = await context.api(`stock-counts/${encodeURIComponent(id)}`);
    state.current = result.count;
    $('#ct-list').hidden = true;
    $('#ct-detail').hidden = false;
    $('#ct-close-form').hidden = true;
    $('#ct-filter').value = 'alle';
    state.lines = [];
    $('#b-ct-more').hidden = true;
    renderHeader();
    await loadLines(false);
  }

  /** Tekent de kop, de tellers, de knoppen en de voortgang per locatie van de geopende telling. */
  function renderHeader() {
    const { esc, nl, eur } = context;
    const count = state.current;
    const totals = count.totals || {};
    const running = count.status === 'tellen';
    $('#ct-title').textContent = `${count.number} · ${KIND_NAMES[count.kind] || count.kind} · peildatum ${dateText(count.referenceDate)} · ${STATUS_NAMES[count.status] || count.status}`;
    for (const id of ['b-ct-recount', 'b-ct-cancel', 'b-ct-close']) $(`#${id}`).hidden = !running;
    const base = `api/stock-counts/${encodeURIComponent(count.id)}`;
    $('#b-ct-pdf').href = `${base}/telstaat.pdf`;
    $('#b-ct-pdf-diff').href = `${base}/telstaat.pdf?alleen=verschillen`;
    $('#b-ct-form').href = `${base}/telformulier.pdf`;
    $('#b-ct-form').hidden = !running;
    $('#ct-stats').innerHTML = [
      [`${totals.counted || 0} / ${totals.lines || 0}`, 'regels geteld'],
      [totals.open || 0, 'nog niet geteld'],
      [totals.recount || 0, 'staan op hertellen'],
      [totals.recountNeeded || 0, `boven de drempel (${eur(count.threshold.amount)} of ${nl(count.threshold.pct)}%)`],
      [totals.withDifference || 0, 'regels met verschil'],
      [eur(totals.differenceValue || 0), 'waarde van de verschillen'],
      [eur(totals.valueBefore || 0), 'voorraadwaarde vóór de telling'],
      [totals.noCostWithStock || 0, 'regels met voorraad maar zonder prijs'],
    ].map(([value, label]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
    const progress = count.progress || [];
    $('#ct-progress').innerHTML = progress.length ? `<thead><tr><th>Locatie</th><th class="num">Regels</th><th class="num">Geteld</th><th class="num">Hertellen</th></tr></thead>
      <tbody>${progress.map((row) => `<tr><td>${esc(row.location || 'Geen locatie')}</td><td class="num">${row.total}</td><td class="num">${row.counted}</td><td class="num">${row.recount || ''}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">Geen regels.</td></tr></tbody>';
    $('#ct-location').innerHTML = `<option value="">Alle locaties</option>${progress.map((row) => `<option value="${esc(row.location)}">${esc(row.location || 'Geen locatie')}</option>`).join('')}`;
  }

  /**
   * Haalt regels op volgens het filter en tekent ze (de volgende pagina komt eronder).
   * @param {boolean} append true om de volgende pagina toe te voegen
   * @returns {Promise<void>}
   */
  async function loadLines(append) {
    const run = ++state.run;
    const params = new URLSearchParams({ filter: $('#ct-filter').value, limit: String(PAGE), offset: String(append ? state.lines.length : 0) });
    // Eerste optie = alle locaties; een andere optie (ook "Geen locatie" met lege waarde) filtert op die locatie.
    if ($('#ct-location').selectedIndex > 0) params.set('location', $('#ct-location').value);
    const result = await context.api(`stock-counts/${encodeURIComponent(state.current.id)}/lines?${params}`);
    if (run !== state.run) return; // een nieuwer verzoek (ander filter of locatie) is al onderweg
    state.lines = append ? state.lines.concat(result.lines) : result.lines;
    state.total = result.total;
    renderLines();
  }

  /** Tekent de tabel met regels van de geopende telling. */
  function renderLines() {
    const { esc, nl, eur } = context;
    $('#ct-lines').innerHTML = state.lines.length ? `<thead><tr><th>Locatie</th><th>Code</th><th>Omschrijving</th><th class="num">Verwacht</th><th class="num">Geteld</th><th class="num">Verschil</th><th class="num">Waarde</th><th>Status</th></tr></thead>
      <tbody>${state.lines.map((line) => `<tr>
        <td>${esc(line.location)}</td><td><span class="code">${esc(line.code)}</span></td><td class="wrap">${esc(line.name)}</td>
        <td class="num">${esc(nl(line.expectedAtCount == null ? line.expectedQty : line.expectedAtCount))} ${esc(line.unit)}</td>
        <td class="num">${line.countedQty == null ? '' : `${esc(nl(line.countedQty))} ${esc(line.unit)}`}</td>
        <td class="num${line.difference < 0 ? ' neg' : ''}">${line.difference ? `${line.difference > 0 ? '+' : ''}${esc(nl(line.difference))}` : ''}</td>
        <td class="num">${line.unitCost == null ? '<span class="muted">geen prijs</span>' : line.difference ? esc(eur(line.differenceValue)) : ''}</td>
        <td>${esc(LINE_STATUS_NAMES[line.status] || line.status)}${line.recountNeeded ? ' <span class="pill">Boven drempel</span>' : ''}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Geen regels voor dit filter.</td></tr></tbody>';
    $('#b-ct-more').hidden = state.lines.length >= state.total;
  }

  /**
   * Zet de regels boven de drempel terug naar de tellers.
   * @returns {Promise<void>}
   */
  async function recount() {
    const result = await context.api(`stock-counts/${encodeURIComponent(state.current.id)}/recount`, { method: 'POST', body: { overThreshold: true } });
    context.toast(result.marked ? `${result.marked} regels staan weer klaar om te hertellen` : 'Geen regels boven de drempel');
    await openCount(state.current.id);
  }

  /**
   * Annuleert de geopende telling na bevestiging (er wordt niets geboekt).
   * @returns {Promise<void>}
   */
  async function cancel() {
    if (!confirm(`Telling ${state.current.number} annuleren? Er wordt niets geboekt; de tellers kunnen niet meer verder.`)) return;
    await context.api(`stock-counts/${encodeURIComponent(state.current.id)}/cancel`, { method: 'POST', body: {} });
    context.toast('Telling geannuleerd');
    await load();
  }

  /**
   * Sluit de telling af met het ingevulde wachtwoord en de gekozen afhandeling van open regels.
   * @param {SubmitEvent} event het verzenden
   * @returns {Promise<void>}
   */
  async function submitClose(event) {
    event.preventDefault();
    const form = event.target;
    const errorBox = $('.err', form);
    errorBox.textContent = '';
    try {
      const result = await context.api(`stock-counts/${encodeURIComponent(state.current.id)}/close`, {
        method: 'POST', body: { password: form.password.value, open: form.open.value, acceptRecounts: form.acceptRecounts.value === 'ja' },
      });
      form.reset();
      form.hidden = true;
      context.toast(`Telling afgesloten: ${result.booked} correcties geboekt`);
      await openCount(result.count.id);
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  /**
   * Maakt de Excel van de geopende telling: samenvatting, alle regels en het logboek van de ingaven.
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    const report = await context.api(`stock-counts/${encodeURIComponent(state.current.id)}/report`);
    const excelWorkbook = await context.workbook();
    if (!excelWorkbook) return;
    const count = report.count;
    const summary = excelWorkbook.addWorksheet('Samenvatting');
    summary.columns = [{ header: 'Onderdeel', key: 'label', width: 40 }, { header: 'Waarde', key: 'value', width: 24 }];
    const totals = count.totals || {};
    for (const [label, value] of [
      ['Telling', count.number], ['Soort', KIND_NAMES[count.kind] || count.kind], ['Status', STATUS_NAMES[count.status] || count.status], ['Peildatum', count.referenceDate],
      ['Gestart door', count.createdBy], ['Afgesloten door', count.closedBy || ''], ['Regels', totals.lines], ['Geteld', totals.counted], ['Regels met verschil', totals.withDifference],
      ['Voorraadwaarde vóór de telling', totals.valueBefore], ['Waarde van de verschillen', totals.differenceValue], ['Regels met voorraad zonder prijs', totals.noCostWithStock],
    ]) summary.addRow({ label, value });
    summary.getRow(1).font = { bold: true };
    const sheet = excelWorkbook.addWorksheet('Regels', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Locatie', key: 'location', width: 14 }, { header: 'Artikelcode', key: 'code', width: 16 }, { header: 'Omschrijving', key: 'name', width: 40 },
      { header: 'Eenheid', key: 'unit', width: 9 }, { header: 'Verwacht bij bevriezen', key: 'expectedQty', width: 14, style: { numFmt: '#,##0.###' } },
      { header: 'Verwacht op telmoment', key: 'expectedAtCount', width: 14, style: { numFmt: '#,##0.###' } }, { header: 'Geteld', key: 'countedQty', width: 10, style: { numFmt: '#,##0.###' } },
      { header: 'Verschil', key: 'difference', width: 10, style: { numFmt: '#,##0.###' } }, { header: 'Prijs per eenheid', key: 'unitCost', width: 12, style: { numFmt: '#,##0.00' } },
      { header: 'Waarde verschil', key: 'differenceValue', width: 14, style: { numFmt: '#,##0.00' } }, { header: 'Status', key: 'status', width: 12 }, { header: 'Afhandeling', key: 'resolution', width: 14 },
      { header: 'Geteld door', key: 'countedBy', width: 20 },
    ];
    for (const line of report.lines) sheet.addRow({ ...line, status: LINE_STATUS_NAMES[line.status] || line.status, resolution: line.resolution || '' });
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = { from: 'A1', to: 'M1' };
    const log = excelWorkbook.addWorksheet('Ingaven', { views: [{ state: 'frozen', ySplit: 1 }] });
    log.columns = [
      { header: 'Tijdstip', key: 'countedAt', width: 20, style: { numFmt: 'dd-mm-yyyy hh:mm' } }, { header: 'Locatie', key: 'location', width: 14 }, { header: 'Artikelcode', key: 'code', width: 16 },
      { header: 'Geteld', key: 'qty', width: 10, style: { numFmt: '#,##0.###' } }, { header: 'Door', key: 'countedBy', width: 20 },
    ];
    for (const entry of report.entries) log.addRow({ ...entry, countedAt: new Date(entry.countedAt) });
    log.getRow(1).font = { bold: true };
    await context.save(excelWorkbook, `voorraadtelling-${count.number}-${context.stamp()}.xlsx`);
  }

  /**
   * Koppelt de knoppen en formulieren en bewaart de hulpfuncties van de pagina.
   * @param {object} helpers api, toast, esc, nl, eur, workbook, save en stamp van de pagina
   */
  function setup(helpers) {
    Object.assign(context, helpers);
    /**
     * Maakt van een async actie een klikafhandeling die fouten als melding toont.
     * @param {Function} action De async actie.
     * @returns {Function} De afhandeling.
     */
    const guard = (action) => () => { action().catch((error) => context.toast(error.message, true)); };
    $('#b-ct-new').addEventListener('click', openStartForm);
    $('#ct-form').addEventListener('submit', submitStart);
    $('#ct-form [data-cancel]').addEventListener('click', () => { $('#ct-form').hidden = true; });
    $('#ct-table').addEventListener('click', (event) => {
      const button = event.target.closest('[data-open]');
      if (button) guard(() => openCount(button.dataset.open))();
    });
    $('#b-ct-back').addEventListener('click', guard(load));
    $('#b-ct-excel').addEventListener('click', guard(exportExcel));
    $('#b-ct-recount').addEventListener('click', guard(recount));
    $('#b-ct-cancel').addEventListener('click', guard(cancel));
    $('#b-ct-close').addEventListener('click', () => { $('#ct-close-form').hidden = false; $('#ct-close-form').password.focus(); });
    $('#ct-close-form').addEventListener('submit', submitClose);
    $('#ct-close-form [data-cancel]').addEventListener('click', () => { $('#ct-close-form').hidden = true; });
    $('#ct-filter').addEventListener('change', guard(() => loadLines(false)));
    $('#ct-location').addEventListener('change', guard(() => loadLines(false)));
    $('#b-ct-more').addEventListener('click', guard(() => loadLines(true)));
  }

  window.ArtikelenCounts = { setup, load };
})();
