// Webshopbestellingen (Verkoop) > Rapportage: omzet, inkoopwaarde en marge van de
// eigen webshop over een gekozen periode, met het verloop in de tijd, de artikelen
// met de meeste marge, de marge per categorie en een Excel-export (API
// /api/admin/webshop-report, zie backend/src/webshop/web-sales.js). De inkoopwaarde
// komt uit de voorraadlagen (FIFO): een verkoop houdt de inkoopprijs van de laag
// waaruit hij kwam, ook als de inkoopprijs later is gestegen.
(function () {
  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Bedrag in euro's.
   * @param {*} value Het bedrag.
   * @param {number} [decimals] Aantal decimalen (standaard 2).
   * @returns {string} Bijv. "€ 1.234,50".
   */
  const euro = (value, decimals = 2) => `€ ${Number(value || 0).toLocaleString('nl-NL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  /**
   * Percentage met één decimaal.
   * @param {?number} value Het percentage.
   * @returns {string} Bijv. "38,5%" (– zonder waarde).
   */
  const percent = (value) => (value == null ? '–' : `${Number(value).toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);
  /**
   * Aantal in het Nederlands.
   * @param {number} value Het aantal.
   * @returns {string} Bijv. "1.250,5".
   */
  const amount = (value) => Number(value || 0).toLocaleString('nl-NL', { maximumFractionDigits: 3 });
  /**
   * Datum als JJJJ-MM-DD (lokale tijd).
   * @param {Date} date De datum.
   * @returns {string} Bijv. "2026-11-05".
   */
  const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  /**
   * Korte naam van een periode in de grafiek.
   * @param {string} start Begindatum (JJJJ-MM-DD).
   * @param {string} interval 'day', 'week' of 'month'.
   * @returns {string} Bijv. "5 nov", "wk 3 nov" of "nov 2026".
   */
  function periodLabel(start, interval) {
    const [year, month, day] = start.split('-').map(Number);
    if (interval === 'month') return `${MONTHS[month - 1]} ${year}`;
    return `${interval === 'week' ? 'wk ' : ''}${day} ${MONTHS[month - 1]}`;
  }
  /** Indeling van de grafiek in gewone woorden. */
  const INTERVAL_LABELS = { day: 'per dag', week: 'per week', month: 'per maand' };
  /** Hoeveel artikelen en categorieën de staafdiagrammen tonen. */
  const TOP = 10;
  const state = { report: null, preset: 'jaar' };
  /** Toont een melding; wordt door init vervangen door die van de pagina. */
  let toast = () => {};

  /**
   * De datums van een vaste periode.
   * @param {string} preset 'maand', 'vorige-maand', '30', 'kwartaal', 'jaar', 'vorig-jaar' of '12'.
   * @returns {{ from: string, to: string }} Begin- en einddatum.
   */
  function presetRange(preset) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const ranges = {
      maand: [new Date(year, month, 1), now],
      'vorige-maand': [new Date(year, month - 1, 1), new Date(year, month, 0)],
      30: [new Date(year, month, now.getDate() - 29), now],
      kwartaal: [new Date(year, Math.floor(month / 3) * 3, 1), now],
      jaar: [new Date(year, 0, 1), now],
      'vorig-jaar': [new Date(year - 1, 0, 1), new Date(year - 1, 11, 31)],
      12: [new Date(year, month - 11, 1), now],
    };
    const [from, to] = ranges[preset] || ranges.jaar;
    return { from: isoDate(from), to: isoDate(to) };
  }

  /**
   * Haalt de rapportage op.
   * @param {boolean} [withLines] Ook de losse verkoopregels (voor Excel).
   * @returns {Promise<object>} De rapportage (fout = Error met de melding van de server).
   */
  async function fetchReport(withLines = false) {
    const params = new URLSearchParams({ from: $('#rp-from').value, to: $('#rp-to').value });
    if ($('#rp-interval').value) params.set('interval', $('#rp-interval').value);
    if (withLines) params.set('lines', '1');
    const res = await fetch(`../api/admin/webshop-report?${params}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || AquatechCommon.statusMessage(res.status));
    return body;
  }

  /**
   * Haalt de rapportage op en tekent hem.
   * @returns {Promise<void>}
   */
  async function load() {
    const box = $('#rp-body');
    box.setAttribute('aria-busy', 'true');
    try {
      state.report = await fetchReport();
      render();
    } catch (error) {
      $('#rp-tiles').innerHTML = `<p class="err">${esc(error.message)}</p>`;
    } finally {
      box.removeAttribute('aria-busy');
    }
  }

  /**
   * Tekent de tegels met de kerncijfers.
   * @param {object} report De rapportage.
   * @returns {void}
   */
  function renderTiles(report) {
    const totals = report.totals;
    const stock = report.stock;
    const tiles = [
      [euro(totals.revenue), 'Omzet artikelen (excl. btw)', `${totals.orders} bestelling${totals.orders === 1 ? '' : 'en'}${totals.returnLines ? ` · ${totals.returnLines} retourregel${totals.returnLines === 1 ? '' : 's'}` : ''}`],
      [euro(totals.cost), 'Inkoopwaarde (FIFO)', 'tegen de inkoopprijs van het moment van inkoop'],
      [euro(totals.margin), 'Brutowinst', 'omzet min inkoop'],
      [percent(totals.marginPct), 'Marge', 'brutowinst als deel van de omzet'],
    ];
    if (stock) tiles.push([euro(stock.value, 0), 'Voorraadwaarde nu (FIFO)', stock.unknownItems ? `${stock.unknownItems} artikel${stock.unknownItems === 1 ? '' : 'en'} zonder inkoopprijs` : 'alle lagen met inkoopprijs']);
    $('#rp-tiles').innerHTML = tiles.map(([value, label, sub]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span><small>${esc(sub)}</small></div>`).join('');
    const notes = [];
    if (totals.unknownQty) {
      notes.push(`Van ${amount(Math.abs(totals.unknownQty))} verkochte eenheden (omzet ${euro(totals.unknownRevenue)}) is de inkoopprijs onbekend. Die tellen niet mee in de brutowinst en de marge. Vul de inkoopprijs in bij het artikel (Artikelen &gt; artikel &gt; Inkoopprijs en voorraadlagen).`);
    }
    if (report.truncated) notes.push('Er zijn meer verkoopregels dan de rapportage in één keer toont; kies een kortere periode.');
    $('#rp-notes').innerHTML = notes.map((note) => `<p class="notice small">${note}</p>`).join('');
  }

  /**
   * Tekent het verloop in de tijd: per periode een staaf met de inkoop en de brutowinst erop (samen de omzet).
   * @param {object} report De rapportage.
   * @returns {void}
   */
  function renderTrend(report) {
    const series = report.series;
    $('#rp-trend-title').textContent = `Omzet, inkoop en brutowinst ${INTERVAL_LABELS[report.interval]}`;
    if (!series.some((period) => period.revenue || period.cost)) {
      $('#rp-trend').innerHTML = '<p class="muted empty-chart">Geen verkopen in deze periode.</p>';
      return;
    }
    // Zo breed als het vak (min. 320 px); bij veel perioden scrollt de grafiek opzij.
    const width = Math.max(320, ($('#rp-trend').clientWidth || 0) - 2, series.length * 22 + 60);
    const height = 220;
    const left = 56;
    const bottom = 24;
    const top = 8;
    const plotHeight = height - top - bottom;
    const max = Math.max(...series.map((period) => Math.max(period.revenue, period.cost + Math.max(0, period.margin))), 1);
    const min = Math.min(0, ...series.map((period) => Math.min(period.margin, period.revenue)));
    const span = max - min;
    /**
     * Y-positie van een bedrag.
     * @param {number} value Het bedrag.
     * @returns {number} De y in pixels.
     */
    const yOf = (value) => top + ((max - value) / span) * plotHeight;
    const slot = (width - left - 8) / series.length;
    const barWidth = Math.max(4, Math.min(28, slot * 0.6));
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => min + span * fraction);
    const grid = ticks.map((tick) => `<line class="grid" x1="${left}" x2="${width - 8}" y1="${yOf(tick)}" y2="${yOf(tick)}"/><text class="axis" x="${left - 6}" y="${yOf(tick) + 4}" text-anchor="end">${esc(euro(tick, 0))}</text>`).join('');
    const labelEvery = Math.ceil(series.length / Math.max(1, Math.floor((width - left) / 64)));
    const bars = series.map((period, index) => {
      const x = left + index * slot + (slot - barWidth) / 2;
      const cost = Math.max(0, period.cost);
      const profit = period.margin;
      const costTop = yOf(cost);
      const parts = [];
      if (cost > 0) parts.push(`<rect class="bar-cost" x="${x}" y="${costTop}" width="${barWidth}" height="${Math.max(0, yOf(0) - costTop)}" rx="2"/>`);
      if (profit > 0) parts.push(`<rect class="bar-profit" x="${x}" y="${yOf(cost + profit)}" width="${barWidth}" height="${Math.max(0, costTop - yOf(cost + profit) - 2)}" rx="2"/>`);
      if (profit < 0) parts.push(`<rect class="bar-loss" x="${x}" y="${yOf(0)}" width="${barWidth}" height="${Math.max(0, yOf(profit) - yOf(0))}" rx="2"/>`);
      const label = index % labelEvery === 0 ? `<text class="axis" x="${x + barWidth / 2}" y="${height - 6}" text-anchor="middle">${esc(periodLabel(period.start, report.interval))}</text>` : '';
      const tip = `${periodLabel(period.start, report.interval)}\nOmzet ${euro(period.revenue)}\nInkoop ${euro(period.cost)}\nBrutowinst ${euro(period.margin)} (${percent(period.marginPct)})${period.unknownQty ? `\nInkoop onbekend: ${amount(Math.abs(period.unknownQty))} st.` : ''}`;
      return `<g class="period" tabindex="0" data-tip="${esc(tip)}"><rect class="hit" x="${left + index * slot}" y="${top}" width="${slot}" height="${plotHeight}"/>${parts.join('')}${label}</g>`;
    }).join('');
    $('#rp-trend').innerHTML = `<div class="legend"><span><i class="sw-cost"></i>Inkoop</span><span><i class="sw-profit"></i>Brutowinst</span><span class="muted">samen de omzet</span></div>
      <div class="chart-scroll"><svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Omzet, inkoop en brutowinst ${esc(INTERVAL_LABELS[report.interval])}">
        ${grid}<line class="baseline" x1="${left}" x2="${width - 8}" y1="${yOf(0)}" y2="${yOf(0)}"/>${bars}</svg></div>`;
  }

  /**
   * Tekent een liggend staafdiagram van de brutowinst (artikelen of categorieën).
   * @param {Element} target Waar het diagram komt.
   * @param {object[]} rows De regels (margin, marginPct, revenue, cost en een naam).
   * @param {Function} nameOf Geeft de naam van een regel als HTML.
   * @returns {void}
   */
  function renderBars(target, rows, nameOf) {
    const shown = rows.filter((row) => row.revenue || row.cost).slice(0, TOP);
    if (!shown.length) { target.innerHTML = '<p class="muted empty-chart">Geen verkopen in deze periode.</p>'; return; }
    const max = Math.max(...shown.map((row) => Math.abs(row.margin)), 1);
    target.innerHTML = `<ol class="hbars">${shown.map((row) => {
      const tip = `Omzet ${euro(row.revenue)}\nInkoop ${euro(row.cost)}\nBrutowinst ${euro(row.margin)} (${percent(row.marginPct)})${row.unknownQty ? `\nInkoop onbekend: ${amount(Math.abs(row.unknownQty))} st.` : ''}`;
      return `<li tabindex="0" data-tip="${esc(tip)}"><span class="hbar-name">${nameOf(row)}</span>
        <span class="hbar-track"><span class="hbar ${row.margin < 0 ? 'loss' : ''}" style="width:${Math.max(1, (Math.abs(row.margin) / max) * 100)}%"></span></span>
        <span class="hbar-value">${esc(euro(row.margin, 0))} <small>${esc(percent(row.marginPct))}</small>${row.unknownQty ? ' <small class="warn" title="Inkoopprijs deels onbekend">*</small>' : ''}</span></li>`;
    }).join('')}</ol>`;
  }

  /**
   * Tekent de tabel met alle artikelen (de tabelweergave van de diagrammen).
   * @param {object} report De rapportage.
   * @returns {void}
   */
  function renderTable(report) {
    $('#rp-table').innerHTML = report.items.length ? `<thead><tr><th>Artikel</th><th>Categorie</th><th class="num">Aantal</th><th class="num">Omzet</th><th class="num">Inkoop</th><th class="num">Brutowinst</th><th class="num">Marge</th></tr></thead>
      <tbody>${report.items.map((item) => `<tr><td class="wrap">${item.itemId ? `<a href="../artikelen/?id=${encodeURIComponent(item.itemId)}">${esc(item.name)}</a>` : esc(item.name)}<span class="sub">${esc(item.code)}</span></td>
        <td>${esc(item.category)}</td><td class="num">${esc(amount(item.qty))}</td><td class="num">${esc(euro(item.revenue))}</td>
        <td class="num">${esc(euro(item.cost))}${item.unknownQty ? `<span class="sub warn">${esc(amount(Math.abs(item.unknownQty)))} st. onbekend</span>` : ''}</td>
        <td class="num${item.margin < 0 ? ' neg' : ''}">${esc(euro(item.margin))}</td><td class="num">${esc(percent(item.marginPct))}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Geen verkopen in deze periode.</td></tr></tbody>';
  }

  /**
   * Tekent de hele rapportage.
   * @returns {void}
   */
  function render() {
    const report = state.report;
    $('#rp-period').textContent = `${new Date(`${report.from}T12:00:00`).toLocaleDateString('nl-NL', { dateStyle: 'long' })} t/m ${new Date(`${report.to}T12:00:00`).toLocaleDateString('nl-NL', { dateStyle: 'long' })}`;
    renderTiles(report);
    renderTrend(report);
    renderBars($('#rp-items'), report.items, (item) => esc(item.name));
    renderBars($('#rp-categories'), report.categories, (category) => esc(category.name));
    renderTable(report);
  }

  /**
   * Toont de toelichting bij een staaf (muis of toetsenbord).
   * @param {Event} event De gebeurtenis.
   * @returns {void}
   */
  function showTip(event) {
    const target = event.target.closest('[data-tip]');
    const tip = $('#rp-tip');
    if (!target) { tip.hidden = true; return; }
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const box = target.getBoundingClientRect();
    const x = event.clientX || box.left + box.width / 2;
    const y = event.clientY || box.top;
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, x + 12))}px`;
    tip.style.top = `${Math.max(8, y - tip.offsetHeight - 12)}px`;
  }

  /**
   * Exporteert de rapportage naar Excel: overzicht, per periode, per artikel, per categorie en de verkoopregels.
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    const button = $('#rp-export');
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    button.disabled = true;
    try {
      const report = await fetchReport(true);
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Aquatech';
      const money = { numFmt: '€ #,##0.00' };
      const pct = { numFmt: '0.0"%"' };
      const overview = workbook.addWorksheet('Overzicht');
      overview.columns = [{ header: 'Webshoprapportage', key: 'label', width: 42 }, { header: '', key: 'value', width: 20 }];
      const totals = report.totals;
      const rows = [
        ['Periode', `${report.from} t/m ${report.to}`], ['Bestellingen', totals.orders], ['Retourregels', totals.returnLines],
        ['Omzet artikelen (excl. btw)', totals.revenue, money], ['Inkoopwaarde (FIFO)', totals.cost, money], ['Brutowinst', totals.margin, money], ['Marge (%)', totals.marginPct, pct],
        ['Eenheden met onbekende inkoopprijs', Math.abs(totals.unknownQty)], ['Omzet met onbekende inkoopprijs', totals.unknownRevenue, money],
      ];
      if (report.stock) rows.push(['Voorraadwaarde nu (FIFO)', report.stock.value, money], ['Eenheden op voorraad zonder inkoopprijs', report.stock.unknownQty]);
      for (const [label, value, style] of rows) {
        const row = overview.addRow({ label, value });
        if (style) row.getCell('value').numFmt = style.numFmt;
      }
      overview.addRow({});
      overview.addRow({ label: 'Omzet excl. btw en zonder verzendkosten. Inkoop volgens de voorraadlagen (FIFO); de marge rekent alleen met verkopen waarvan de inkoopprijs bekend is.' });
      const columns = [
        { header: 'Omzet', key: 'revenue', width: 14, style: money }, { header: 'Inkoop', key: 'cost', width: 14, style: money },
        { header: 'Brutowinst', key: 'margin', width: 14, style: money }, { header: 'Marge %', key: 'marginPct', width: 10, style: pct },
        { header: 'Aantal', key: 'qty', width: 10 }, { header: 'Inkoop onbekend (st.)', key: 'unknownQty', width: 20 },
      ];
      const periods = workbook.addWorksheet('Per periode');
      periods.columns = [{ header: `Periode (${INTERVAL_LABELS[report.interval]})`, key: 'label', width: 20 }, { header: 'Vanaf', key: 'start', width: 12 }, ...columns];
      for (const period of report.series) periods.addRow({ ...period, label: periodLabel(period.start, report.interval), unknownQty: Math.abs(period.unknownQty) });
      const items = workbook.addWorksheet('Per artikel');
      items.columns = [{ header: 'Artikelnummer', key: 'code', width: 18 }, { header: 'Omschrijving', key: 'name', width: 40 }, { header: 'Categorie', key: 'category', width: 22 }, ...columns];
      for (const item of report.items) items.addRow({ ...item, unknownQty: Math.abs(item.unknownQty) });
      const categories = workbook.addWorksheet('Per categorie');
      categories.columns = [{ header: 'Categorie', key: 'name', width: 26 }, ...columns];
      for (const category of report.categories) categories.addRow({ ...category, unknownQty: Math.abs(category.unknownQty) });
      const lines = workbook.addWorksheet('Verkoopregels');
      lines.columns = [
        { header: 'Datum', key: 'date', width: 12 }, { header: 'Soort', key: 'kind', width: 10 }, { header: 'Nummer', key: 'reference', width: 16 },
        { header: 'Artikelnummer', key: 'code', width: 18 }, { header: 'Omschrijving', key: 'name', width: 40 }, { header: 'Categorie', key: 'category', width: 22 },
        { header: 'Aantal', key: 'qty', width: 9 }, { header: 'Omzet', key: 'revenue', width: 14, style: money }, { header: 'Inkoop', key: 'cost', width: 14, style: money },
        { header: 'Brutowinst', key: 'margin', width: 14, style: money }, { header: 'Inkoop onbekend (st.)', key: 'unknownQty', width: 20 },
      ];
      for (const line of report.lines || []) lines.addRow({ ...line, kind: line.kind === 'retour' ? 'Retour' : 'Verkoop', unknownQty: Math.abs(line.unknownQty) || null });
      for (const sheet of [overview, periods, items, categories, lines]) sheet.getRow(1).font = { bold: true };
      const buffer = await workbook.xlsx.writeBuffer();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      link.download = `webshop-rapportage_${report.from}_${report.to}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      toast('Rapportage geëxporteerd');
    } catch (error) {
      toast(`Export mislukt: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Koppelt de bediening (periode, indeling, export, toelichtingen).
   * @param {{ toast: Function }} options De melding van de pagina.
   * @returns {void}
   */
  function init(options) {
    toast = options.toast;
    const range = presetRange(state.preset);
    $('#rp-from').value = range.from;
    $('#rp-to').value = range.to;
    /** Een vaste periode gekozen: datums invullen en opnieuw ophalen. */
    $('#rp-preset').onchange = () => {
      if ($('#rp-preset').value === 'eigen') return;
      const chosen = presetRange($('#rp-preset').value);
      $('#rp-from').value = chosen.from;
      $('#rp-to').value = chosen.to;
      load();
    };
    for (const field of ['#rp-from', '#rp-to']) {
      /** Een eigen datum gekozen: periode op Eigen en opnieuw ophalen. */
      $(field).onchange = () => { $('#rp-preset').value = 'eigen'; load(); };
    }
    $('#rp-interval').onchange = load;
    $('#rp-export').onclick = exportExcel;
    const body = $('#rp-body');
    // Andere schermbreedte: de grafiek opnieuw op de breedte van het vak tekenen.
    window.addEventListener('resize', () => {
      clearTimeout(init.resizeTimer);
      init.resizeTimer = setTimeout(() => { if (state.report && !$('#tab-rapportage').hidden) renderTrend(state.report); }, 150);
    });
        body.addEventListener('mousemove', showTip);
    body.addEventListener('focusin', showTip);
    body.addEventListener('mouseleave', () => { $('#rp-tip').hidden = true; });
    body.addEventListener('focusout', () => { $('#rp-tip').hidden = true; });
  }

  window.BeheerRapportage = { init, load };
})();
