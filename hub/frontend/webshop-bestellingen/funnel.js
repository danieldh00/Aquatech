// Webshopbestellingen (Verkoop) > Funnel: hoe ver bezoekers van de webshop komen, van productpagina tot bestelling, per gekozen
// periode, met een Excel-export (API /api/admin/shop-funnel, zie backend/src/webshop/funnel.js).
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
   * Een getal in Nederlandse notatie.
   * @param {number} value Het getal.
   * @returns {string} Bijv. "1.234".
   */
  const number = (value) => Number(value || 0).toLocaleString('nl-NL');
  const state = { report: null };
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};

  /**
   * Haalt het overzicht van de gekozen periode op en tekent de tabellen.
   * @returns {Promise<void>}
   */
  async function load() {
    const table = $('#fn-table');
    const extra = $('#fn-extra');
    try {
      const res = await fetch(`../api/admin/shop-funnel?days=${encodeURIComponent($('#fn-days').value)}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || AquatechCommon.statusMessage(res.status));
      state.report = body;
      const total = body.steps.reduce((sum, step) => sum + step.count, 0) + body.extra.reduce((sum, step) => sum + step.count, 0);
      $('#fn-export').disabled = !total;
      $('#fn-count').textContent = `${body.from} t/m ${body.to}`;
      if (!total) {
        table.innerHTML = '<tr><td class="empty">Nog niets geteld in deze periode. De telling begint zodra bezoekers de webshop gebruiken.</td></tr>';
        extra.innerHTML = '';
        return;
      }
      table.innerHTML = `<thead><tr><th>Stap</th><th class="num">Aantal</th><th class="num">Ten opzichte van de vorige stap</th></tr></thead><tbody>${body.steps.map((step) => `
        <tr><td>${esc(step.label)}</td><td class="num">${esc(number(step.count))}</td><td class="num">${step.ofPrevious == null ? '–' : `${esc(String(step.ofPrevious).replace('.', ','))}%`}</td></tr>`).join('')}</tbody>`;
      extra.innerHTML = `<thead><tr><th>Ook geteld</th><th class="num">Aantal</th></tr></thead><tbody>${body.extra.map((step) => `
        <tr><td>${esc(step.label)}</td><td class="num">${esc(number(step.count))}</td></tr>`).join('')}</tbody>`;
    } catch (error) {
      state.report = null;
      $('#fn-export').disabled = true;
      table.innerHTML = `<tr><td class="empty">Kan de funnel niet laden (${esc(error.message)}).</td></tr>`;
      extra.innerHTML = '';
    }
  }

  /**
   * Exporteert het overzicht naar Excel: een blad met de stappen en een blad met de aantallen per dag.
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    const report = state.report;
    if (!report) return;
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Aquatech';
    const steps = workbook.addWorksheet('Funnel');
    steps.columns = [{ header: 'Stap', key: 'label', width: 36 }, { header: 'Aantal', key: 'count', width: 12 }, { header: 'Ten opzichte van de vorige stap (%)', key: 'ofPrevious', width: 34 }];
    for (const step of [...report.steps, ...report.extra]) steps.addRow({ label: step.label, count: step.count, ofPrevious: step.ofPrevious == null ? null : step.ofPrevious });
    steps.getRow(1).font = { bold: true };
    const days = workbook.addWorksheet('Per dag');
    const keys = [...report.steps, ...report.extra];
    days.columns = [{ header: 'Dag', key: 'day', width: 14 }, ...keys.map((step) => ({ header: step.label, key: step.key, width: 24 }))];
    for (const row of report.perDay) days.addRow(row);
    days.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    link.download = `funnel_${report.from}_${report.to}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    toast('Funnel geëxporteerd');
  }

  /**
   * Koppelt de periodekeuze en de exportknop (één keer, door Beheer).
   * @param {{ toast: Function }} options De melding van Beheer.
   * @returns {void}
   */
  function init(options) {
    toast = options.toast || toast;
    /**
     * Haalt het overzicht opnieuw op na een andere periodekeuze.
     * @returns {Promise<void>}
     */
    $('#fn-days').onchange = () => load();
    /**
     * Exporteert het getoonde overzicht.
     * @returns {Promise<void>}
     */
    $('#fn-export').onclick = () => exportExcel().catch((error) => toast(`Export mislukt: ${error.message}`, true));
  }

  window.BeheerFunnel = { init, load };
})();
