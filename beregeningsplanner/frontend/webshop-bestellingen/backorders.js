// Webshopbestellingen (Verkoop) > Backorders: de open bestellingen waarvan (een deel van) de regels nog niet leverbaar is, per regel
// met besteld, geleverd, nu leverbaar, backorder en de verwachte datum uit inkoop, plus een Excel-export
// (API /api/admin/web-orders/backorders, zie backend/src/webshop/fulfilment.js).
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
  const state = { rows: [], truncated: false };
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};

  /**
   * Zet de bestellingen om naar één rij per regel met een backorder.
   * @param {object[]} orders De bestellingen met leverstatus.
   * @returns {object[]} De rijen: bestelling, klant, artikel, aantallen, verwachte datum en of de bestelling nu iets kan verzenden.
   */
  function rowsOf(orders) {
    const rows = [];
    for (const order of orders) {
      for (const status of order.fulfilment.lines) {
        if (status.backorder <= 0) continue;
        const line = order.lines[status.index];
        rows.push({
          id: order.id, number: order.number, createdAt: order.createdAt, customer: order.customerName, name: line.name, code: line.code, unit: line.unit || '',
          ordered: status.ordered, shipped: status.shipped, ready: status.ready, backorder: status.backorder, expected: status.expected, canShip: order.fulfilment.canShip, allowPartial: order.allowPartial,
        });
      }
    }
    return rows;
  }

  /**
   * Haalt de backorders op en tekent de tabel.
   * @returns {Promise<void>}
   */
  async function load() {
    const table = $('#bo-table');
    try {
      const res = await fetch('../api/admin/web-orders/backorders', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || AquatechCommon.statusMessage(res.status));
      state.rows = rowsOf(body.items);
      state.truncated = !!body.truncated;
      $('#bo-export').disabled = !state.rows.length;
      $('#bo-count').textContent = state.rows.length ? `${new Set(state.rows.map((row) => row.id)).size} bestellingen · ${state.rows.length} regels${state.truncated ? ' · alleen de oudste bestellingen worden getoond' : ''}` : '';
      table.innerHTML = !state.rows.length ? '<tr><td class="empty">Geen backorders: alles wat besteld is, is leverbaar.</td></tr>'
        : `<thead><tr><th>Bestelling</th><th>Klant</th><th>Artikel</th><th class="num">Besteld</th><th class="num">Geleverd</th><th class="num">Leverbaar</th><th class="num">Backorder</th><th>Verwacht</th><th>Status</th></tr></thead><tbody>${state.rows.map((row) => `
          <tr><td><a href="?id=${encodeURIComponent(row.id)}#bestellingen">${esc(row.number)}</a><span class="sub">${esc(day(row.createdAt))}</span></td><td>${esc(row.customer)}</td><td>${esc(row.name)}<span class="sub">${esc(row.code)}</span></td><td class="num">${row.ordered}</td><td class="num">${row.shipped}</td><td class="num">${row.ready}</td><td class="num"><b>${row.backorder}</b></td><td>${row.expected ? esc(day(row.expected)) : '<span class="muted">onbekend</span>'}</td><td>${row.canShip ? '<span class="pill verzonden">Kan (deels) mee</span>' : row.allowPartial ? '<span class="pill nieuw">Wacht op voorraad</span>' : '<span class="pill nieuw" title="Deellevering is uit voor deze bestelling.">Wacht op alles</span>'}</td></tr>`).join('')}</tbody>`;
    } catch (error) {
      state.rows = [];
      table.innerHTML = `<tr><td class="empty">Kan de backorders niet laden (${esc(error.message)}).</td></tr>`;
    }
  }

  /**
   * Exporteert de backorders naar Excel (één rij per regel).
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Aquatech';
    const sheet = workbook.addWorksheet('Backorders');
    sheet.columns = [
      { header: 'Bestelling', key: 'number', width: 16 }, { header: 'Besteld op', key: 'createdAt', width: 14, style: { numFmt: 'dd-mm-yyyy' } }, { header: 'Klant', key: 'customer', width: 28 },
      { header: 'Artikelnummer', key: 'code', width: 18 }, { header: 'Omschrijving', key: 'name', width: 40 }, { header: 'Eenheid', key: 'unit', width: 9 },
      { header: 'Besteld', key: 'ordered', width: 9 }, { header: 'Geleverd', key: 'shipped', width: 9 }, { header: 'Leverbaar', key: 'ready', width: 10 }, { header: 'Backorder', key: 'backorder', width: 10 },
      { header: 'Verwacht', key: 'expected', width: 13, style: { numFmt: 'dd-mm-yyyy' } }, { header: 'Deellevering toegestaan', key: 'allowPartial', width: 22 },
    ];
    for (const row of state.rows) sheet.addRow({ ...row, createdAt: new Date(row.createdAt), expected: row.expected ? new Date(row.expected) : null, allowPartial: row.allowPartial ? 'ja' : 'nee' });
    sheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    link.download = `backorders_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    toast(`${state.rows.length} backorderregels geëxporteerd`);
  }

  /**
   * Koppelt de exportknop (één keer, door Beheer).
   * @param {{ toast: Function }} options De melding van Beheer.
   * @returns {void}
   */
  function init(options) {
    toast = options.toast || toast;
    /**
     * Exporteert de getoonde backorders.
     * @returns {Promise<void>}
     */
    $('#bo-export').onclick = () => exportExcel().catch((error) => toast(`Export mislukt: ${error.message}`, true));
  }

  window.BeheerBackorders = { init, load };
})();
