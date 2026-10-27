// Blok Nacalculatie op de werkorder (recht nacalculatie): begroot (offerte)
// tegenover werkelijk (geboekte uren en materiaal), kosten, opbrengst en
// marge, uit /api/workorders/:id/costing (rekenwerk in costing-core.js).
// De knop Excel maakt een werkmap met een samenvatting en de materiaalregels.
(function () {
  const state = { workOrder: null, data: null, options: {}, seq: 0 };
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const NAVY = 'FF172F5E';
  const EURO = '"€" #,##0.00;[Red]-"€" #,##0.00';
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
   * Bedrag in euro's in Nederlandse notatie.
   * @param {*} value Het bedrag.
   * @returns {string} Bijv. "€ 1.234,50".
   */
  const formatEuro = (value) => (Number(value) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  /**
   * Getal in Nederlandse notatie (hoogstens 2 decimalen).
   * @param {*} value Het getal.
   * @returns {string} Bijv. "12,5".
   */
  const formatNumber = (value) => (Number(value) || 0).toLocaleString('nl-NL', { maximumFractionDigits: 2 });
  /**
   * Verschil met teken en kleur: meer dan begroot = rood, minder = groen.
   * @param {number} difference Het verschil (werkelijk − begroot).
   * @param {Function} format Opmaak van het getal.
   * @param {boolean} [moreIsGood] true als meer juist gunstig is (opbrengst).
   * @returns {string} HTML van het verschil.
   */
  const diffCell = (difference, format, moreIsGood = false) => {
    const rounded = Math.round((Number(difference) || 0) * 100) / 100;
    if (!rounded) return '<td class="num muted">0</td>';
    const good = moreIsGood ? rounded > 0 : rounded < 0;
    return `<td class="num ${good ? 'nc-good' : 'nc-bad'}">${rounded > 0 ? '+' : ''}${esc(format(rounded))}</td>`;
  };
  /**
   * Toont een melding via de werkorderpagina (als die een toast meegaf).
   * @param {string} message De melding.
   * @param {boolean} [isError] true = foutmelding.
   * @returns {*} Wat de toast teruggeeft (null zonder toast).
   */
  const toast = (message, isError) => (state.options.toast ? state.options.toast(message, isError) : null);

  /** Tekent de samenvatting, de materiaalregels en de waarschuwingen. */
  function render() {
    const container = $('#nc-body');
    const costing = state.data;
    if (!container || !costing) return;
    const { labour, budget, actual, cost } = costing;
    $('#nc-summary').textContent = `Marge ${formatEuro(costing.margin)}${costing.marginPct == null ? '' : ` (${formatNumber(costing.marginPct)}%)`}`;
    const discountRow = costing.discountPct ? `<tr><td>Korting ${esc(formatNumber(costing.discountPct))}%</td><td class="num">−${esc(formatEuro(budget.discount))}</td><td class="num">−${esc(formatEuro(actual.discount))}</td>${diffCell(budget.discount - actual.discount, formatEuro, true)}</tr>` : '';
    const materialRows = costing.materials.map((material) => `<tr${material.extra ? ' class="nc-extra"' : ''}>
      <td>${material.code ? `<span class="code">${esc(material.code)}</span> ` : ''}${esc(material.description)}${material.extra ? ' <span class="pill">Extra</span>' : ''}</td>
      <td class="num">${esc(formatNumber(material.plannedQty))} ${esc(material.unit)}</td>
      <td class="num">${esc(formatNumber(material.usedQty))}</td>
      ${diffCell(material.diffQty, formatNumber)}
      <td class="num">${esc(formatEuro(material.usedAmount))}</td>
      <td class="num">${material.usedCost == null ? '<span class="muted">–</span>' : esc(formatEuro(material.usedCost))}</td>
    </tr>`).join('');
    const revenueLabel = costing.revenueSource === 'factuur'
      ? `Gefactureerd (${esc(costing.invoiced.numbers.join(', ') || costing.invoiced.count)})`
      : 'Opbrengst volgens offerte (nog niet gefactureerd)';
    container.innerHTML = `<div class="tablewrap"><table class="grid nc-table">
        <thead><tr><th></th><th class="num">Begroot</th><th class="num">Werkelijk</th><th class="num">Verschil</th></tr></thead>
        <tbody>
          <tr><td>Uren</td><td class="num">${esc(formatNumber(labour.plannedHours))}</td><td class="num">${esc(formatNumber(labour.actualHours))}</td>${diffCell(labour.diffHours, formatNumber)}</tr>
          <tr><td>Arbeid (à ${esc(formatEuro(labour.hourlyRate))})</td><td class="num">${esc(formatEuro(budget.labour))}</td><td class="num">${esc(formatEuro(actual.labour))}</td>${diffCell(actual.labour - budget.labour, formatEuro)}</tr>
          <tr><td>Materiaal</td><td class="num">${esc(formatEuro(budget.materials))}</td><td class="num">${esc(formatEuro(actual.materials))}</td>${diffCell(actual.materials - budget.materials, formatEuro)}</tr>
          ${budget.other ? `<tr><td>Overig</td><td class="num">${esc(formatEuro(budget.other))}</td><td class="num">${esc(formatEuro(actual.other))}</td><td class="num muted">0</td></tr>` : ''}
          ${discountRow}
          <tr class="nc-total"><td>Waarde (excl. btw)</td><td class="num">${esc(formatEuro(budget.net))}</td><td class="num">${esc(formatEuro(actual.net))}</td>${diffCell(actual.net - budget.net, formatEuro)}</tr>
        </tbody></table></div>
      <div class="tablewrap"><table class="grid nc-table nc-result"><tbody>
        <tr><td>${revenueLabel}</td><td class="num">${esc(formatEuro(costing.revenue))}</td></tr>
        <tr><td>Kosten arbeid (${esc(formatNumber(labour.actualHours))} u × ${esc(formatEuro(labour.hourlyCost))})</td><td class="num">−${esc(formatEuro(cost.labour))}</td></tr>
        <tr><td>Kosten materiaal (inkoopprijs)</td><td class="num">−${esc(formatEuro(cost.materials))}</td></tr>
        <tr class="nc-total"><td>Marge${cost.complete ? '' : ' <span class="muted small">(kosten onvolledig)</span>'}</td><td class="num ${costing.margin < 0 ? 'nc-bad' : 'nc-good'}">${esc(formatEuro(costing.margin))}${costing.marginPct == null ? '' : ` · ${esc(formatNumber(costing.marginPct))}%`}</td></tr>
      </tbody></table></div>
      ${costing.materials.length ? `<details class="nc-materials"><summary>Materiaal per artikel (${costing.materials.length})</summary><div class="tablewrap"><table class="grid">
        <thead><tr><th>Artikel</th><th class="num">Begroot</th><th class="num">Verbruikt</th><th class="num">Verschil</th><th class="num">Waarde</th><th class="num">Kosten</th></tr></thead>
        <tbody>${materialRows}</tbody></table></div></details>` : ''}
      ${costing.warnings.map((warning) => `<p class="muted small warn-text">${esc(warning)}</p>`).join('')}
      <div class="row"><button class="btn" data-nc-excel>Excel</button><button class="btn ghost" data-nc-refresh>Vernieuwen</button></div>`;
    /**
     * Exporteert de nacalculatie naar Excel.
     * @returns {Promise<void>}
     */
    container.querySelector('[data-nc-excel]').onclick = () => exportXlsx();
    /**
     * Haalt de nacalculatie opnieuw op (na nieuwe boekingen).
     * @returns {Promise<void>}
     */
    container.querySelector('[data-nc-refresh]').onclick = () => load();
  }

  /**
   * Haalt de nacalculatie van de geopende werkorder op en tekent hem.
   * @returns {Promise<void>}
   */
  async function load() {
    const seq = ++state.seq;
    const workOrder = state.workOrder;
    try {
      const res = await fetch(`../api/workorders/${encodeURIComponent(workOrder.id)}/costing`, { cache: 'no-store' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message || `HTTP ${res.status}`);
      if (seq !== state.seq) return;
      state.data = out;
      render();
    } catch (error) {
      if (seq !== state.seq) return;
      $('#nc-body').innerHTML = `<p class="muted small">Nacalculatie laden mislukt: ${esc(error.message)}</p>`;
    }
  }

  /**
   * Bestandsnaam zonder vreemde tekens.
   * @param {string} text De tekst.
   * @returns {string} Alleen letters, cijfers, - en _.
   */
  const safeName = (text) => String(text || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
  /**
   * Maakt de kopregel van een werkblad navy met witte letters.
   * @param {object} row ExcelJS-rij.
   * @returns {void}
   */
  const headStyle = (row) => {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  };

  /**
   * Maakt een Excel-werkmap van de nacalculatie (samenvatting + materiaal) en downloadt hem.
   * @returns {Promise<void>}
   */
  async function exportXlsx() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const costing = state.data;
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'AquaTech Service';
      workbook.created = new Date();
      const summary = workbook.addWorksheet('Nacalculatie');
      summary.columns = [
        { header: 'Onderdeel', key: 'part', width: 38 },
        { header: 'Begroot', key: 'budget', width: 15 },
        { header: 'Werkelijk', key: 'actual', width: 15 },
        { header: 'Verschil', key: 'diff', width: 15 },
      ];
      headStyle(summary.getRow(1));
      /**
       * Voegt een regel met begroot, werkelijk en verschil toe.
       * @param {string} part Omschrijving.
       * @param {number} budgetValue Begroot.
       * @param {number} actualValue Werkelijk.
       * @param {string} [numFmt] Getalnotatie (standaard euro).
       * @returns {object} De ExcelJS-rij.
       */
      const addRow = (part, budgetValue, actualValue, numFmt = EURO) => {
        const row = summary.addRow({ part, budget: budgetValue, actual: actualValue, diff: Math.round((actualValue - budgetValue) * 100) / 100 });
        ['budget', 'actual', 'diff'].forEach((key) => { row.getCell(key).numFmt = numFmt; });
        return row;
      };
      const { labour, budget, actual, cost } = costing;
      addRow('Uren', labour.plannedHours, labour.actualHours, '0.00');
      addRow(`Arbeid (uurtarief ${labour.hourlyRate})`, budget.labour, actual.labour);
      addRow('Materiaal', budget.materials, actual.materials);
      if (budget.other) addRow('Overig', budget.other, actual.other);
      if (costing.discountPct) addRow(`Korting ${costing.discountPct}%`, -budget.discount, -actual.discount);
      addRow('Waarde (excl. btw)', budget.net, actual.net).font = { bold: true };
      summary.addRow({});
      /**
       * Voegt een regel met één bedrag toe (opbrengst, kosten, marge).
       * @param {string} part Omschrijving.
       * @param {number} amount Bedrag.
       * @returns {object} De ExcelJS-rij.
       */
      const addAmount = (part, amount) => {
        const row = summary.addRow({ part, actual: amount });
        row.getCell('actual').numFmt = EURO;
        return row;
      };
      addAmount(costing.revenueSource === 'factuur' ? `Gefactureerd (${costing.invoiced.numbers.join(', ')})` : 'Opbrengst volgens offerte', costing.revenue);
      addAmount(`Kosten arbeid (${labour.actualHours} u × ${labour.hourlyCost})`, -cost.labour);
      addAmount('Kosten materiaal (inkoopprijs)', -cost.materials);
      addAmount(cost.complete ? 'Marge' : 'Marge (kosten onvolledig)', costing.margin).font = { bold: true };
      if (costing.marginPct != null) summary.addRow({ part: 'Marge %', actual: costing.marginPct / 100 }).getCell('actual').numFmt = '0.0%';
      summary.addRow({});
      summary.addRow({ part: `Werkorder ${costing.workOrder.number}${costing.quote ? ` · offerte ${costing.quote.number}` : ''}` });
      if (costing.workOrder.customer) summary.addRow({ part: costing.workOrder.customer });
      costing.warnings.forEach((warning) => summary.addRow({ part: warning }));

      const sheet = workbook.addWorksheet('Materiaal', { views: [{ state: 'frozen', ySplit: 1 }] });
      sheet.columns = [
        { header: 'Code', key: 'code', width: 14 },
        { header: 'Omschrijving', key: 'description', width: 40 },
        { header: 'Eenheid', key: 'unit', width: 9 },
        { header: 'Begroot', key: 'plannedQty', width: 10, style: { numFmt: '0.##' } },
        { header: 'Verbruikt', key: 'usedQty', width: 10, style: { numFmt: '0.##' } },
        { header: 'Verschil', key: 'diffQty', width: 10, style: { numFmt: '0.##' } },
        { header: 'Prijs', key: 'price', width: 12, style: { numFmt: EURO } },
        { header: 'Inkoopprijs', key: 'costPrice', width: 12, style: { numFmt: EURO } },
        { header: 'Waarde begroot', key: 'plannedAmount', width: 15, style: { numFmt: EURO } },
        { header: 'Waarde verbruikt', key: 'usedAmount', width: 16, style: { numFmt: EURO } },
        { header: 'Kosten verbruikt', key: 'usedCost', width: 16, style: { numFmt: EURO } },
      ];
      headStyle(sheet.getRow(1));
      costing.materials.forEach((material) => sheet.addRow(material));
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 11 } };

      const blob = new Blob([await workbook.xlsx.writeBuffer()], { type: XLSX_TYPE });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `nacalculatie_${safeName(costing.workOrder.number)}${costing.workOrder.customer ? `_${safeName(costing.workOrder.customer)}` : ''}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    } catch (error) {
      console.error(error);
      toast(`Export mislukt: ${error.message}`, true);
    }
  }

  window.WorkOrderCosting = {
    /**
     * Toont het blok voor een geopende werkorder (alleen met het recht nacalculatie).
     * @param {object} workOrder De werkorder (id).
     * @param {object} [options] { toast, allowed }.
     * @returns {void}
     */
    open(workOrder, options = {}) {
      state.workOrder = workOrder;
      state.options = options;
      state.data = null;
      const card = $('#nc-card');
      if (!card) return;
      card.hidden = !options.allowed;
      if (!options.allowed) { state.seq++; return; }
      $('#nc-summary').textContent = '';
      $('#nc-body').innerHTML = '<p class="muted small">Laden…</p>';
      load();
    },
  };
})();
