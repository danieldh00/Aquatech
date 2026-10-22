// Beheer > AI-kosten: verbruik en kosten van AI-verzoeken per periode,
// gebruiker, functie en model, plus de losse verzoeken en een Excel-export
// (API /api/admin/ai-usage, zie backend/src/platform/ai-usage.js). Een hoofdbeheerder
// kan ook alle organisaties samen bekijken.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  const int = (n) => Number(n || 0).toLocaleString('nl-NL');
  const eur = (n, d = 2) => `€ ${Number(n || 0).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  // Kleine bedragen (losse verzoeken) met meer decimalen.
  const eurFine = (n) => eur(n, Math.abs(n) < 1 ? 4 : 2);
  const secs = (ms) => `${(Number(ms || 0) / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} s`;
  const M = window.AquatechAiModels;
  const STATUS = {
    ok: 'Gelukt', refusal: 'Geweigerd', too_long: 'Te lang', invalid_output: 'Onleesbaar antwoord', auth: 'Sleutel geweigerd',
    permission: 'Geen toegang', not_found: 'Model niet beschikbaar', rate_limited: 'Overbelast', no_credit: 'Tegoed op',
    bad_request: 'Verzoek geweigerd', api_error: 'Fout bij AI-dienst', error: 'Fout',
  };
  const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const PAGE = 100;
  const state = { offset: 0, loaded: false, data: null };
  let toast = () => {};

  async function api(path) {
    const res = await fetch(`../api/admin/${path}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function setRange(kind) {
    const now = new Date();
    let from = new Date(now.getTime() - 29 * 86400000);
    let to = now;
    if (kind === 'month') from = new Date(now.getFullYear(), now.getMonth(), 1);
    if (kind === 'prev') { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 0); }
    if (kind === 'year') from = new Date(now.getFullYear(), 0, 1);
    if (kind === 'custom') return;
    $('#ai-from').value = iso(from);
    $('#ai-to').value = iso(to);
    $('#ai-period').value = kind === 'year' ? 'month' : 'day';
  }

  function query(extra = {}) {
    const p = new URLSearchParams({ from: $('#ai-from').value, to: $('#ai-to').value, period: $('#ai-period').value });
    if ($('#ai-user').value) p.set('user', $('#ai-user').value);
    if ($('#ai-feature').value) p.set('feature', $('#ai-feature').value);
    if ($('#ai-scope').value) p.set('scope', $('#ai-scope').value);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }

  const periodLabel = (k) => (k.length === 7 ? `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`
    : new Date(`${k}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' }));
  const userName = (u) => (u.username ? `${u.displayName} (${u.username})` : u.displayName);
  const tenantName = (t) => `${t.name}${t.environment === 'test' ? ' (test)' : ''}`;

  // Tabel met totalen per groep en een balkje naar verhouding van de kosten.
  function groupTable(el, rows, firstHead, first) {
    if (!rows.length) { el.innerHTML = '<tr><td class="empty">Geen verzoeken in deze periode.</td></tr>'; return; }
    const max = Math.max(...rows.map((r) => r.costEur), 0.000001);
    el.innerHTML = `<thead><tr><th>${esc(firstHead)}</th><th class="num">Verzoeken</th><th class="num">Tokens in</th><th class="num">Tokens uit</th><th class="num">Kosten</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(first(r))}</td><td class="num">${int(r.requests)}${r.failed ? ` <span class="muted small">(${int(r.failed)} mislukt)</span>` : ''}</td>
        <td class="num">${int(r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens)}</td><td class="num">${int(r.outputTokens)}</td><td class="num">${esc(eur(r.costEur))}</td>
        <td><span class="bar" style="width:${Math.round((r.costEur / max) * 60)}px"></span></td></tr>`).join('')}</tbody>`;
  }

  function renderSummary(d) {
    const t = d.totals;
    $('#ai-stats').innerHTML = [
      [eur(t.costEur), 'Kosten (geschat)'],
      [int(t.requests), `Verzoeken${t.failed ? ` (${int(t.failed)} mislukt)` : ''}`],
      [t.requests ? eurFine(t.costEur / t.requests) : '–', 'Gemiddeld per verzoek'],
      [int(t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens), 'Tokens in (afbeelding + opdracht)'],
      [int(t.outputTokens), 'Tokens uit (antwoord + denkwerk)'],
      [t.requests ? secs(t.durationMs / t.requests) : '–', 'Gemiddelde duur'],
    ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
    groupTable($('#ai-by-period'), d.byPeriod, d.filter.period === 'month' ? 'Maand' : 'Dag', (r) => periodLabel(r.key));
    groupTable($('#ai-by-user'), d.byUser, 'Gebruiker', (r) => userName(r.user));
    groupTable($('#ai-by-feature'), d.byFeature, 'Functie', (r) => r.label);
    groupTable($('#ai-by-model'), d.byModel, 'Model', (r) => r.label);
    $('#ai-tenant-wrap').hidden = !d.byTenant;
    if (d.byTenant) groupTable($('#ai-by-tenant'), d.byTenant, 'Organisatie', (r) => tenantName(r.tenant));
    $('#ai-note').textContent = `Elk verzoek aan de AI-dienst (zoals een plan laten herkennen) met het verbruik in tokens, de duur en de geschatte kosten. `
      + `Kosten zijn berekend met de prijzen van Anthropic op het moment van het verzoek en omgerekend met ${d.eurCentsPerUsd} eurocent per dollar (Instellingen); `
      + `de factuur van Anthropic is leidend. Huidig model: ${M.label(d.model)}. Regels blijven ${d.retentionDays} dagen bewaard.`;
    // Keuzelijsten: gebruikers en functies uit de periode (zonder filter erop).
    fillSelect($('#ai-user'), 'Alle gebruikers', d.byUser.filter((r) => r.key).map((r) => [r.key, userName(r.user)]));
    fillSelect($('#ai-feature'), 'Alle functies', Object.entries(M.FEATURES));
  }

  function fillSelect(sel, all, options) {
    const cur = sel.value;
    const opts = options.slice();
    if (cur && !opts.some(([k]) => k === cur)) opts.push([cur, cur]);
    sel.innerHTML = `<option value="">${esc(all)}</option>${opts.map(([k, l]) => `<option value="${esc(k)}"${k === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}`;
  }

  function renderRequests({ total, items }) {
    const tbl = $('#ai-requests');
    const all = $('#ai-scope').value === 'all';
    state.items = items;
    tbl.innerHTML = !items.length ? '<tr><td class="empty">Geen verzoeken in deze periode.</td></tr>'
      : `<thead><tr><th>Tijdstip</th>${all ? '<th>Organisatie</th>' : ''}<th>Gebruiker</th><th>Functie</th><th>Model</th><th>Resultaat</th>
          <th class="num">Tokens in</th><th class="num">Tokens uit</th><th class="num">Duur</th><th class="num">Kosten</th></tr></thead>
        <tbody>${items.map((r, i) => `<tr data-id="${i}"><td>${esc(when(r.createdAt))}</td>${all ? `<td>${esc(tenantName(r.tenant))}</td>` : ''}
          <td>${esc(r.user.displayName)}</td><td>${esc(r.featureLabel)}</td><td>${esc(r.modelLabel)}</td>
          <td><span class="pill ${r.status === 'ok' ? 'aangemaakt' : 'verwijderd'}">${esc(STATUS[r.status] || r.status)}</span></td>
          <td class="num">${int(r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens)}</td><td class="num">${int(r.outputTokens)}</td>
          <td class="num">${esc(secs(r.durationMs))}</td><td class="num">${esc(eurFine(r.costEur))}</td></tr>`).join('')}</tbody>`;
    tbl.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => showRequest(state.items[Number(tr.dataset.id)]); });
    const from = total ? state.offset + 1 : 0;
    $('#ai-info').textContent = `${from}–${Math.min(total, state.offset + PAGE)} van ${int(total)}`;
    $('#ai-prev').disabled = state.offset === 0;
    $('#ai-next').disabled = state.offset + PAGE >= total;
  }

  function showRequest(r) {
    const d = r.detail || {};
    const p = M.priceOf(r.model);
    const rows = [
      ['Tijdstip', when(r.createdAt)],
      ['Organisatie', tenantName(r.tenant)],
      ['Gebruiker', userName(r.user)],
      ['Functie', r.featureLabel],
      ['Model', `${r.modelLabel}${r.model && r.model !== r.modelLabel ? ` (${r.model})` : ''}`],
      ['Resultaat', STATUS[r.status] || r.status],
      ['Duur', secs(r.durationMs)],
      ['Tokens in', `${int(r.inputTokens)} × $ ${p.input} per miljoen`],
      ['Tokens uit (incl. denkwerk)', `${int(r.outputTokens)} × $ ${p.output} per miljoen`],
      ...(r.cacheReadTokens ? [['Uit cache gelezen', `${int(r.cacheReadTokens)} × $ ${p.cacheRead} per miljoen`]] : []),
      ...(r.cacheWriteTokens ? [['Naar cache geschreven', `${int(r.cacheWriteTokens)} × $ ${p.cacheWrite} per miljoen`]] : []),
      ['Kosten', `${eurFine(r.costEur)} ($ ${r.costUsd.toLocaleString('nl-NL', { maximumFractionDigits: 4 })})${d.prijsGeschat ? ' – geschat: onbekend model' : ''}`],
      ...(d.width ? [['Afbeelding', `${int(d.width)} × ${int(d.height)} pixels`]] : []),
      ...(d.areas != null ? [['Herkende vlakken', int(d.areas)]] : []),
      ...(d.elements != null ? [['Herkende elementen', int(d.elements)]] : []),
    ];
    $('#detail-body').innerHTML = `<h2>AI-verzoek</h2><p class="muted small">Alleen verbruik en kosten worden bewaard, niet de afbeelding of het antwoord.</p>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    $('#detail').hidden = false;
  }

  async function load() {
    try {
      const [summary, requests] = await Promise.all([api(`ai-usage?${query()}`), api(`ai-usage/requests?${query({ limit: PAGE, offset: state.offset })}`)]);
      state.data = summary;
      $('#ai-scope').hidden = !summary.platformAdmin;
      renderSummary(summary);
      renderRequests(requests);
    } catch (e) {
      $('#ai-stats').innerHTML = '';
      $('#ai-requests').innerHTML = `<tr><td class="empty">Kan de AI-kosten niet laden (${esc(e.message)}).</td></tr>`;
    }
  }

  async function loadRequests() {
    try { renderRequests(await api(`ai-usage/requests?${query({ limit: PAGE, offset: state.offset })}`)); } catch (e) { toast(e.message, true); }
  }

  // ---------- Excel ----------
  function sheet(wb, name, columns, rows) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns;
    rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
    if (columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return ws;
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
  const totalRow = (r) => ({ ...r, durationS: r.durationMs / 1000 });

  async function exportExcel() {
    const btn = $('#ai-export');
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    btn.disabled = true;
    btn.textContent = 'Bezig…';
    try {
      const summary = await api(`ai-usage?${query()}`);
      const items = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await api(`ai-usage/requests?${query({ limit: 1000, offset })}`);
        items.push(...page.items);
        if (items.length >= page.total || !page.items.length) break;
      }
      const f = summary.filter;
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Aquatech';
      wb.created = new Date();
      const t = summary.totals;
      sheet(wb, 'Samenvatting', [{ header: 'Onderdeel', key: 'k', width: 34 }, { header: 'Waarde', key: 'v', width: 40 }], [
        { k: 'Periode', v: `${f.from} t/m ${f.to}` },
        { k: 'Organisaties', v: summary.scope === 'all' ? 'Alle organisaties' : 'Deze omgeving' },
        { k: 'Verzoeken', v: t.requests },
        { k: 'Waarvan mislukt', v: t.failed },
        { k: 'Tokens in', v: t.inputTokens },
        { k: 'Tokens uit (incl. denkwerk)', v: t.outputTokens },
        { k: 'Tokens uit cache gelezen', v: t.cacheReadTokens },
        { k: 'Tokens naar cache geschreven', v: t.cacheWriteTokens },
        { k: 'Kosten in dollar', v: Number(t.costUsd.toFixed(4)) },
        { k: 'Kosten in euro (geschat)', v: Number(t.costEur.toFixed(4)) },
        { k: 'Koers (eurocent per dollar)', v: summary.eurCentsPerUsd },
        { k: 'Huidig model', v: M.label(summary.model) },
      ]);
      sheet(wb, f.period === 'month' ? 'Per maand' : 'Per dag', [{ header: f.period === 'month' ? 'Maand' : 'Dag', key: 'k', width: 14 }, ...TOTAL_COLS],
        summary.byPeriod.map((r) => ({ k: r.key, ...totalRow(r) })));
      sheet(wb, 'Per gebruiker', [{ header: 'Gebruiker', key: 'k', width: 30 }, { header: 'Gebruikersnaam', key: 'u', width: 22 }, ...TOTAL_COLS],
        summary.byUser.map((r) => ({ k: r.user.displayName, u: r.user.username, ...totalRow(r) })));
      sheet(wb, 'Per functie', [{ header: 'Functie', key: 'k', width: 24 }, ...TOTAL_COLS], summary.byFeature.map((r) => ({ k: r.label, ...totalRow(r) })));
      sheet(wb, 'Per model', [{ header: 'Model', key: 'k', width: 22 }, ...TOTAL_COLS], summary.byModel.map((r) => ({ k: r.label, ...totalRow(r) })));
      if (summary.byTenant) {
        sheet(wb, 'Per organisatie', [{ header: 'Organisatie', key: 'k', width: 30 }, ...TOTAL_COLS], summary.byTenant.map((r) => ({ k: tenantName(r.tenant), ...totalRow(r) })));
      }
      sheet(wb, 'Verzoeken', [
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
      ], items.map((r) => ({
        at: new Date(r.createdAt), tenant: tenantName(r.tenant), user: r.user.displayName, username: r.user.username, feature: r.featureLabel,
        model: r.modelLabel, status: STATUS[r.status] || r.status, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, durationS: r.durationMs / 1000, costUsd: r.costUsd, costEur: r.costEur,
        size: r.detail && r.detail.width ? `${r.detail.width} × ${r.detail.height}` : '', areas: r.detail ? r.detail.areas : undefined,
      })));
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ai-kosten_${f.from}_${f.to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(`${items.length} AI-verzoeken geëxporteerd`);
    } catch (e) {
      toast(`Export mislukt: ${e.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Exporteer naar Excel';
    }
  }

  function init(opts) {
    toast = opts.toast || toast;
    setRange('30');
    const reload = () => { state.offset = 0; load(); };
    $('#ai-range').onchange = () => { setRange($('#ai-range').value); reload(); };
    $('#ai-from').onchange = $('#ai-to').onchange = () => { $('#ai-range').value = 'custom'; reload(); };
    $('#ai-period').onchange = $('#ai-user').onchange = $('#ai-feature').onchange = reload;
    $('#ai-scope').onchange = () => { $('#ai-user').value = ''; reload(); };
    $('#ai-prev').onclick = () => { state.offset = Math.max(0, state.offset - PAGE); loadRequests(); };
    $('#ai-next').onclick = () => { state.offset += PAGE; loadRequests(); };
    $('#ai-export').onclick = exportExcel;
  }

  window.BeheerAiKosten = { init, load };
})();
