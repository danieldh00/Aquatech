// Webshopbestellingen (Verkoop) > Zoektermen: wat bezoekers in de webshop zochten zonder iets te vinden, de meest gezochte eerst,
// met een Excel-export (API /api/admin/shop-search-misses, zie backend/src/webshop/search-misses.js).
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
   * Datum in het Nederlands.
   * @param {string} iso Datum of tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026" (– zonder datum).
   */
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('nl-NL', { dateStyle: 'medium' }) : '–');
  const state = { rows: [] };
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};

  /**
   * Haalt de zoektermen op en tekent de tabel.
   * @returns {Promise<void>}
   */
  async function load() {
    const table = $('#zt-table');
    try {
      const res = await fetch('../api/admin/shop-search-misses', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || AquatechCommon.statusMessage(res.status));
      state.rows = body.items || [];
      $('#zt-export').disabled = !state.rows.length;
      $('#zt-count').textContent = state.rows.length ? `${state.rows.length} termen` : '';
      table.innerHTML = !state.rows.length ? '<tr><td class="empty">Nog geen zoektermen zonder resultaat: bezoekers vonden tot nu toe wat ze zochten.</td></tr>'
        : `<thead><tr><th>Zoekterm</th><th class="num">Keer gezocht</th><th>Eerste keer</th><th>Laatste keer</th></tr></thead><tbody>${state.rows.map((row) => `
          <tr><td>${esc(row.term)}</td><td class="num">${esc(row.hits)}</td><td>${esc(day(row.firstAt))}</td><td>${esc(day(row.lastAt))}</td></tr>`).join('')}</tbody>`;
    } catch (error) {
      state.rows = [];
      table.innerHTML = `<tr><td class="empty">Kan de zoektermen niet laden (${esc(error.message)}).</td></tr>`;
    }
  }

  /**
   * Exporteert de zoektermen naar Excel.
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Aquatech';
    const sheet = workbook.addWorksheet('Zoektermen');
    sheet.columns = [
      { header: 'Zoekterm', key: 'term', width: 32 }, { header: 'Keer gezocht', key: 'hits', width: 14 },
      { header: 'Eerste keer', key: 'firstAt', width: 14, style: { numFmt: 'dd-mm-yyyy' } }, { header: 'Laatste keer', key: 'lastAt', width: 14, style: { numFmt: 'dd-mm-yyyy' } },
    ];
    // Een term die met = + - @ begint, zou in Excel als formule werken: een apostrof ervoor houdt het tekst.
    for (const row of state.rows) sheet.addRow({ ...row, term: /^[=+\-@]/.test(row.term) ? `'${row.term}` : row.term, firstAt: new Date(row.firstAt), lastAt: new Date(row.lastAt) });
    sheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    link.download = `zoektermen_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    toast(`${state.rows.length} zoektermen geëxporteerd`);
  }

  /**
   * Koppelt de exportknop (één keer, door Beheer).
   * @param {{ toast: Function }} options De melding van Beheer.
   * @returns {void}
   */
  function init(options) {
    toast = options.toast || toast;
    /**
     * Exporteert de getoonde zoektermen.
     * @returns {Promise<void>}
     */
    $('#zt-export').onclick = () => exportExcel().catch((error) => toast(`Export mislukt: ${error.message}`, true));
  }

  window.BeheerZoektermen = { init, load };
})();
