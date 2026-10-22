// Beheer > AI-kosten: verbruik en kosten van AI-verzoeken per periode,
// gebruiker, functie en model, plus de losse verzoeken en een Excel-export
// (API /api/admin/ai-usage, zie backend/src/platform/ai-usage.js). Een hoofdbeheerder
// kan ook alle organisaties samen bekijken.
(function () {
  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @param {ParentNode} [root] Waarbinnen gezocht wordt (standaard de pagina).
   * @returns {Element|null} Het element.
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15" (– zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  /**
   * Geheel getal met punten voor de duizendtallen.
   * @param {*} value Het getal.
   * @returns {string} Bijv. "12.345".
   */
  const formatInteger = (value) => Number(value || 0).toLocaleString('nl-NL');
  /**
   * Bedrag in euro's met een vast aantal decimalen.
   * @param {*} value Het bedrag.
   * @param {number} [decimals] Aantal decimalen.
   * @returns {string} Bijv. "€ 1,23".
   */
  const formatEuro = (value, decimals = 2) => `€ ${Number(value || 0).toLocaleString('nl-NL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  /**
   * Bedrag in euro's; kleine bedragen (losse verzoeken) met meer decimalen.
   * @param {number} value Het bedrag.
   * @returns {string} Bijv. "€ 0,0123".
   */
  const formatEuroFine = (value) => formatEuro(value, Math.abs(value) < 1 ? 4 : 2);
  /**
   * Duur in seconden.
   * @param {number} ms Duur in milliseconden.
   * @returns {string} Bijv. "2,4 s".
   */
  const formatSeconds = (ms) => `${(Number(ms || 0) / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} s`;
  const AiModels = window.AquatechAiModels;
  const STATUS = {
    ok: 'Gelukt', refusal: 'Geweigerd', too_long: 'Te lang', invalid_output: 'Onleesbaar antwoord', auth: 'Sleutel geweigerd',
    permission: 'Geen toegang', not_found: 'Model niet beschikbaar', rate_limited: 'Overbelast', no_credit: 'Tegoed op',
    bad_request: 'Verzoek geweigerd', api_error: 'Fout bij AI-dienst', error: 'Fout',
  };
  const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const PAGE = 100;
  const state = { offset: 0, loaded: false, data: null };
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};

  /**
   * Haalt gegevens op bij de beheer-API.
   * @param {string} path Pad onder api/admin/.
   * @returns {Promise<object>} Het antwoord (fout = Error met de melding van de server).
   */
  async function api(path) {
    const res = await fetch(`../api/admin/${path}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  /**
   * Datum als JJJJ-MM-DD in lokale tijd.
   * @param {Date} date De datum.
   * @returns {string} De datum.
   */
  const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  /**
   * Zet de datumvelden voor een gekozen periode (laatste 30 dagen, deze of vorige maand, dit jaar).
   * @param {string} kind "30", "month", "prev", "year" of "custom" (niets aanpassen).
   */
  function setRange(kind) {
    const now = new Date();
    let from = new Date(now.getTime() - 29 * 86400000);
    let to = now;
    if (kind === 'month') from = new Date(now.getFullYear(), now.getMonth(), 1);
    if (kind === 'prev') { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 0); }
    if (kind === 'year') from = new Date(now.getFullYear(), 0, 1);
    if (kind === 'custom') return;
    $('#ai-from').value = isoDate(from);
    $('#ai-to').value = isoDate(to);
    $('#ai-period').value = kind === 'year' ? 'month' : 'day';
  }

  /**
   * Zoekvraag uit de filters (periode, gebruiker, functie, organisaties).
   * @param {object} [extra] Extra parameters, bijv. { limit, offset }.
   * @returns {URLSearchParams} De parameters.
   */
  function query(extra = {}) {
    const params = new URLSearchParams({ from: $('#ai-from').value, to: $('#ai-to').value, period: $('#ai-period').value });
    if ($('#ai-user').value) params.set('user', $('#ai-user').value);
    if ($('#ai-feature').value) params.set('feature', $('#ai-feature').value);
    if ($('#ai-scope').value) params.set('scope', $('#ai-scope').value);
    for (const [name, value] of Object.entries(extra)) params.set(name, value);
    return params;
  }

  /**
   * Naam van een periode: maand ("okt 2026") of dag ("do 22 okt").
   * @param {string} key JJJJ-MM of JJJJ-MM-DD.
   * @returns {string} De naam.
   */
  const periodLabel = (key) => (key.length === 7 ? `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`
    : new Date(`${key}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' }));
  /**
   * Naam van een gebruiker met gebruikersnaam.
   * @param {object} user De gebruiker.
   * @returns {string} Bijv. "Bea Beheer (bea)".
   */
  const userName = (user) => (user.username ? `${user.displayName} (${user.username})` : user.displayName);
  /**
   * Naam van een organisatie (met "(test)" voor een testomgeving).
   * @param {object} tenant De organisatie.
   * @returns {string} De naam.
   */
  const tenantName = (tenant) => `${tenant.name}${tenant.environment === 'test' ? ' (test)' : ''}`;

  /**
   * Tabel met totalen per groep en een balkje naar verhouding van de kosten.
   * @param {HTMLTableElement} table De tabel.
   * @param {object[]} rows Totalen per groep.
   * @param {string} firstHead Kop van de eerste kolom.
   * @param {Function} labelOf Geeft de tekst van de eerste kolom voor een rij.
   */
  function groupTable(table, rows, firstHead, labelOf) {
    if (!rows.length) { table.innerHTML = '<tr><td class="empty">Geen verzoeken in deze periode.</td></tr>'; return; }
    const max = Math.max(...rows.map((row) => row.costEur), 0.000001);
    table.innerHTML = `<thead><tr><th>${esc(firstHead)}</th><th class="num">Verzoeken</th><th class="num">Tokens in</th><th class="num">Tokens uit</th><th class="num">Kosten</th><th></th></tr></thead>
      <tbody>${rows.map((row) => `<tr><td>${esc(labelOf(row))}</td><td class="num">${formatInteger(row.requests)}${row.failed ? ` <span class="muted small">(${formatInteger(row.failed)} mislukt)</span>` : ''}</td>
        <td class="num">${formatInteger(row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens)}</td><td class="num">${formatInteger(row.outputTokens)}</td><td class="num">${esc(formatEuro(row.costEur))}</td>
        <td><span class="bar" style="width:${Math.round((row.costEur / max) * 60)}px"></span></td></tr>`).join('')}</tbody>`;
  }

  /**
   * Tekent de kerncijfers, de tabellen per periode/gebruiker/functie/model/organisatie en de keuzelijsten.
   * @param {object} summary Antwoord van api/admin/ai-usage.
   */
  function renderSummary(summary) {
    const totals = summary.totals;
    $('#ai-stats').innerHTML = [
      [formatEuro(totals.costEur), 'Kosten (geschat)'],
      [formatInteger(totals.requests), `Verzoeken${totals.failed ? ` (${formatInteger(totals.failed)} mislukt)` : ''}`],
      [totals.requests ? formatEuroFine(totals.costEur / totals.requests) : '–', 'Gemiddeld per verzoek'],
      [formatInteger(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens), 'Tokens in (afbeelding + opdracht)'],
      [formatInteger(totals.outputTokens), 'Tokens uit (antwoord + denkwerk)'],
      [totals.requests ? formatSeconds(totals.durationMs / totals.requests) : '–', 'Gemiddelde duur'],
    ].map(([value, label]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
    groupTable($('#ai-by-period'), summary.byPeriod, summary.filter.period === 'month' ? 'Maand' : 'Dag', (row) => periodLabel(row.key));
    groupTable($('#ai-by-user'), summary.byUser, 'Gebruiker', (row) => userName(row.user));
    groupTable($('#ai-by-feature'), summary.byFeature, 'Functie', (row) => row.label);
    groupTable($('#ai-by-model'), summary.byModel, 'Model', (row) => row.label);
    $('#ai-tenant-wrap').hidden = !summary.byTenant;
    if (summary.byTenant) groupTable($('#ai-by-tenant'), summary.byTenant, 'Organisatie', (row) => tenantName(row.tenant));
    $('#ai-note').textContent = `Elk verzoek aan de AI-dienst (zoals een plan laten herkennen) met het verbruik in tokens, de duur en de geschatte kosten. `
      + `Kosten zijn berekend met de prijzen van Anthropic op het moment van het verzoek en omgerekend met ${summary.eurCentsPerUsd} eurocent per dollar (Instellingen); `
      + `de factuur van Anthropic is leidend. Huidig model: ${AiModels.label(summary.model)}. Regels blijven ${summary.retentionDays} dagen bewaard.`;
    // Keuzelijsten: gebruikers en functies uit de periode (zonder filter erop).
    fillSelect($('#ai-user'), 'Alle gebruikers', summary.byUser.filter((row) => row.key).map((row) => [row.key, userName(row.user)]));
    fillSelect($('#ai-feature'), 'Alle functies', Object.entries(AiModels.FEATURES));
  }

  /**
   * Vult een keuzelijst en houdt de huidige keuze vast (ook als die er niet meer in staat).
   * @param {HTMLSelectElement} select De keuzelijst.
   * @param {string} allLabel Tekst van de lege keuze.
   * @param {Array<[string, string]>} options [waarde, tekst].
   */
  function fillSelect(select, allLabel, options) {
    const current = select.value;
    const choices = options.slice();
    if (current && !choices.some(([key]) => key === current)) choices.push([current, current]);
    select.innerHTML = `<option value="">${esc(allLabel)}</option>${choices.map(([key, label]) => `<option value="${esc(key)}"${key === current ? ' selected' : ''}>${esc(label)}</option>`).join('')}`;
  }

  /**
   * Tekent de tabel met losse verzoeken en de bladerknoppen.
   * @param {object} page { total, items } van api/admin/ai-usage/requests.
   */
  function renderRequests({ total, items }) {
    const table = $('#ai-requests');
    const allTenants = $('#ai-scope').value === 'all';
    state.items = items;
    table.innerHTML = !items.length ? '<tr><td class="empty">Geen verzoeken in deze periode.</td></tr>'
      : `<thead><tr><th>Tijdstip</th>${allTenants ? '<th>Organisatie</th>' : ''}<th>Gebruiker</th><th>Functie</th><th>Model</th><th>Resultaat</th>
          <th class="num">Tokens in</th><th class="num">Tokens uit</th><th class="num">Duur</th><th class="num">Kosten</th></tr></thead>
        <tbody>${items.map((request, index) => `<tr data-id="${index}"><td>${esc(when(request.createdAt))}</td>${allTenants ? `<td>${esc(tenantName(request.tenant))}</td>` : ''}
          <td>${esc(request.user.displayName)}</td><td>${esc(request.featureLabel)}</td><td>${esc(request.modelLabel)}</td>
          <td><span class="pill ${request.status === 'ok' ? 'aangemaakt' : 'verwijderd'}">${esc(STATUS[request.status] || request.status)}</span></td>
          <td class="num">${formatInteger(request.inputTokens + request.cacheReadTokens + request.cacheWriteTokens)}</td><td class="num">${formatInteger(request.outputTokens)}</td>
          <td class="num">${esc(formatSeconds(request.durationMs))}</td><td class="num">${esc(formatEuroFine(request.costEur))}</td></tr>`).join('')}</tbody>`;
    table.querySelectorAll('tr[data-id]').forEach((row) => {
      /**
       * Toont de details van dit verzoek.
       * @returns {void}
       */
      row.onclick = () => showRequest(state.items[Number(row.dataset.id)]);
    });
    const from = total ? state.offset + 1 : 0;
    $('#ai-info').textContent = `${from}–${Math.min(total, state.offset + PAGE)} van ${formatInteger(total)}`;
    $('#ai-prev').disabled = state.offset === 0;
    $('#ai-next').disabled = state.offset + PAGE >= total;
  }

  /**
   * Toont de details van één verzoek met de berekening van de kosten.
   * @param {object} request Het verzoek.
   */
  function showRequest(request) {
    const detail = request.detail || {};
    const prices = AiModels.priceOf(request.model);
    const rows = [
      ['Tijdstip', when(request.createdAt)],
      ['Organisatie', tenantName(request.tenant)],
      ['Gebruiker', userName(request.user)],
      ['Functie', request.featureLabel],
      ['Model', `${request.modelLabel}${request.model && request.model !== request.modelLabel ? ` (${request.model})` : ''}`],
      ['Resultaat', STATUS[request.status] || request.status],
      ['Duur', formatSeconds(request.durationMs)],
      ['Tokens in', `${formatInteger(request.inputTokens)} × $ ${prices.input} per miljoen`],
      ['Tokens uit (incl. denkwerk)', `${formatInteger(request.outputTokens)} × $ ${prices.output} per miljoen`],
      ...(request.cacheReadTokens ? [['Uit cache gelezen', `${formatInteger(request.cacheReadTokens)} × $ ${prices.cacheRead} per miljoen`]] : []),
      ...(request.cacheWriteTokens ? [['Naar cache geschreven', `${formatInteger(request.cacheWriteTokens)} × $ ${prices.cacheWrite} per miljoen`]] : []),
      ['Kosten', `${formatEuroFine(request.costEur)} ($ ${request.costUsd.toLocaleString('nl-NL', { maximumFractionDigits: 4 })})${detail.prijsGeschat ? ' – geschat: onbekend model' : ''}`],
      ...(detail.width ? [['Afbeelding', `${formatInteger(detail.width)} × ${formatInteger(detail.height)} pixels`]] : []),
      ...(detail.areas != null ? [['Herkende vlakken', formatInteger(detail.areas)]] : []),
      ...(detail.elements != null ? [['Herkende elementen', formatInteger(detail.elements)]] : []),
    ];
    $('#detail-body').innerHTML = `<h2>AI-verzoek</h2><p class="muted small">Alleen verbruik en kosten worden bewaard, niet de afbeelding of het antwoord.</p>
      <dl class="kv">${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
    $('#detail').hidden = false;
  }

  /**
   * Laadt samenvatting en verzoeken tegelijk en tekent ze.
   * @returns {Promise<void>}
   */
  async function load() {
    try {
      const [summary, requests] = await Promise.all([api(`ai-usage?${query()}`), api(`ai-usage/requests?${query({ limit: PAGE, offset: state.offset })}`)]);
      state.data = summary;
      $('#ai-scope').hidden = !summary.platformAdmin;
      renderSummary(summary);
      renderRequests(requests);
    } catch (error) {
      $('#ai-stats').innerHTML = '';
      $('#ai-requests').innerHTML = `<tr><td class="empty">Kan de AI-kosten niet laden (${esc(error.message)}).</td></tr>`;
    }
  }

  /**
   * Laadt alleen de verzoeken opnieuw (bladeren).
   * @returns {Promise<void>}
   */
  async function loadRequests() {
    try { renderRequests(await api(`ai-usage/requests?${query({ limit: PAGE, offset: state.offset })}`)); } catch (error) { toast(error.message, true); }
  }

  // ---------- Excel ----------
  /**
   * Voegt een werkblad toe met een vette kopregel, vaste eerste rij en filter.
   * @param {object} workbook ExcelJS-werkmap.
   * @param {string} name Naam van het werkblad.
   * @param {object[]} columns Kolommen (header, key, width).
   * @param {object[]} rows De rijen.
   * @returns {object} Het werkblad.
   */
  function sheet(workbook, name, columns, rows) {
    const worksheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    worksheet.columns = columns;
    rows.forEach((row) => worksheet.addRow(row));
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
    if (columns.length) worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return worksheet;
  }
  const TOTAL_COLS = [
    { header: 'Verzoeken', key: 'requests', width: 11 },
    { header: 'Mislukt', key: 'failed', width: 9 },
    { header: 'Tokens in', key: 'inputTokens', width: 12, style: { numFmt: '#,##0' } },
    { header: 'Tokens uit', key: 'outputTokens', width: 12, style: { numFmt: '#,##0' } },
    { header: 'Cache gelezen', key: 'cacheReadTokens', width: 13, style: { numFmt: '#,##0' } },
    { header: 'Cache geschreven', key: 'cacheWriteTokens', width: 15, style: { numFmt: '#,##0' } },
    { header: 'Duur (s)', key: 'durationS', width: 10, style: { numFmt: '0.0' } },
    { header: 'Kosten ($)', key: 'costUsd', width: 12, style: { numFmt: '0.0000' } },
    { header: 'Kosten (€)', key: 'costEur', width: 12, style: { numFmt: '€ #,##0.0000' } },
  ];
  /**
   * Totaalrij voor Excel (duur in seconden).
   * @param {object} row Totalen van een groep.
   * @returns {object} De rij met durationS.
   */
  const totalRow = (row) => ({ ...row, durationS: row.durationMs / 1000 });

  /**
   * Exporteert samenvatting, totalen per groep en alle verzoeken van de periode naar Excel.
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    const button = $('#ai-export');
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    button.disabled = true;
    button.textContent = 'Bezig…';
    try {
      const summary = await api(`ai-usage?${query()}`);
      const items = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await api(`ai-usage/requests?${query({ limit: 1000, offset })}`);
        items.push(...page.items);
        if (items.length >= page.total || !page.items.length) break;
      }
      const filter = summary.filter;
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Aquatech';
      workbook.created = new Date();
      const totals = summary.totals;
      sheet(workbook, 'Samenvatting', [{ header: 'Onderdeel', key: 'k', width: 34 }, { header: 'Waarde', key: 'v', width: 40 }], [
        { k: 'Periode', v: `${filter.from} t/m ${filter.to}` },
        { k: 'Organisaties', v: summary.scope === 'all' ? 'Alle organisaties' : 'Deze omgeving' },
        { k: 'Verzoeken', v: totals.requests },
        { k: 'Waarvan mislukt', v: totals.failed },
        { k: 'Tokens in', v: totals.inputTokens },
        { k: 'Tokens uit (incl. denkwerk)', v: totals.outputTokens },
        { k: 'Tokens uit cache gelezen', v: totals.cacheReadTokens },
        { k: 'Tokens naar cache geschreven', v: totals.cacheWriteTokens },
        { k: 'Kosten in dollar', v: Number(totals.costUsd.toFixed(4)) },
        { k: 'Kosten in euro (geschat)', v: Number(totals.costEur.toFixed(4)) },
        { k: 'Koers (eurocent per dollar)', v: summary.eurCentsPerUsd },
        { k: 'Huidig model', v: AiModels.label(summary.model) },
      ]);
      sheet(workbook, filter.period === 'month' ? 'Per maand' : 'Per dag', [{ header: filter.period === 'month' ? 'Maand' : 'Dag', key: 'k', width: 14 }, ...TOTAL_COLS],
        summary.byPeriod.map((row) => ({ k: row.key, ...totalRow(row) })));
      sheet(workbook, 'Per gebruiker', [{ header: 'Gebruiker', key: 'k', width: 30 }, { header: 'Gebruikersnaam', key: 'u', width: 22 }, ...TOTAL_COLS],
        summary.byUser.map((row) => ({ k: row.user.displayName, u: row.user.username, ...totalRow(row) })));
      sheet(workbook, 'Per functie', [{ header: 'Functie', key: 'k', width: 24 }, ...TOTAL_COLS], summary.byFeature.map((row) => ({ k: row.label, ...totalRow(row) })));
      sheet(workbook, 'Per model', [{ header: 'Model', key: 'k', width: 22 }, ...TOTAL_COLS], summary.byModel.map((row) => ({ k: row.label, ...totalRow(row) })));
      if (summary.byTenant) {
        sheet(workbook, 'Per organisatie', [{ header: 'Organisatie', key: 'k', width: 30 }, ...TOTAL_COLS], summary.byTenant.map((row) => ({ k: tenantName(row.tenant), ...totalRow(row) })));
      }
      sheet(workbook, 'Verzoeken', [
        { header: 'Tijdstip', key: 'at', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm:ss' } },
        { header: 'Organisatie', key: 'tenant', width: 24 },
        { header: 'Gebruiker', key: 'user', width: 26 },
        { header: 'Gebruikersnaam', key: 'username', width: 20 },
        { header: 'Functie', key: 'feature', width: 18 },
        { header: 'Model', key: 'model', width: 20 },
        { header: 'Resultaat', key: 'status', width: 18 },
        { header: 'Tokens in', key: 'inputTokens', width: 11, style: { numFmt: '#,##0' } },
        { header: 'Tokens uit', key: 'outputTokens', width: 11, style: { numFmt: '#,##0' } },
        { header: 'Cache gelezen', key: 'cacheReadTokens', width: 13, style: { numFmt: '#,##0' } },
        { header: 'Cache geschreven', key: 'cacheWriteTokens', width: 15, style: { numFmt: '#,##0' } },
        { header: 'Duur (s)', key: 'durationS', width: 10, style: { numFmt: '0.0' } },
        { header: 'Kosten ($)', key: 'costUsd', width: 12, style: { numFmt: '0.0000' } },
        { header: 'Kosten (€)', key: 'costEur', width: 12, style: { numFmt: '€ #,##0.0000' } },
        { header: 'Afbeelding (px)', key: 'size', width: 15 },
        { header: 'Vlakken', key: 'areas', width: 9 },
      ], items.map((request) => ({
        at: new Date(request.createdAt), tenant: tenantName(request.tenant), user: request.user.displayName, username: request.user.username, feature: request.featureLabel,
        model: request.modelLabel, status: STATUS[request.status] || request.status, inputTokens: request.inputTokens, outputTokens: request.outputTokens,
        cacheReadTokens: request.cacheReadTokens, cacheWriteTokens: request.cacheWriteTokens, durationS: request.durationMs / 1000, costUsd: request.costUsd, costEur: request.costEur,
        size: request.detail && request.detail.width ? `${request.detail.width} × ${request.detail.height}` : '', areas: request.detail ? request.detail.areas : undefined,
      })));
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `ai-kosten_${filter.from}_${filter.to}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      toast(`${items.length} AI-verzoeken geëxporteerd`);
    } catch (error) {
      toast(`Export mislukt: ${error.message}`, true);
    } finally {
      button.disabled = false;
      button.textContent = 'Exporteer naar Excel';
    }
  }

  /**
   * Koppelt de filters, bladerknoppen en export (één keer, door Beheer).
   * @param {object} options { toast }.
   */
  function init(options) {
    toast = options.toast || toast;
    setRange('30');
    /**
     * Laadt opnieuw vanaf de eerste pagina.
     * @returns {void}
     */
    const reload = () => { state.offset = 0; load(); };
    /** Kiest een periode. */
    $('#ai-range').onchange = () => { setRange($('#ai-range').value); reload(); };
    $('#ai-from').onchange = $('#ai-to').onchange = () => { $('#ai-range').value = 'custom'; reload(); };
    $('#ai-period').onchange = $('#ai-user').onchange = $('#ai-feature').onchange = reload;
    /** Wisselt tussen deze omgeving en alle organisaties. */
    $('#ai-scope').onchange = () => { $('#ai-user').value = ''; reload(); };
    /** Vorige pagina met verzoeken. */
    $('#ai-prev').onclick = () => { state.offset = Math.max(0, state.offset - PAGE); loadRequests(); };
    /** Volgende pagina met verzoeken. */
    $('#ai-next').onclick = () => { state.offset += PAGE; loadRequests(); };
    $('#ai-export').onclick = exportExcel;
  }

  window.BeheerAiKosten = { init, load };
})();
