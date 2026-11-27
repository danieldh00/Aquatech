// TIJDELIJK (alleen zolang WooCommerce nog draait): venster bij Artikelen dat de achtergrondtaak "Ontbrekende uit webshop toevoegen" start en de voortgang
// en de lijst van binnengehaalde artikelen toont. Staat los van de rest, zodat het samen met de WooCommerce-koppeling weg kan.
(function () {
  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector) => document.querySelector(selector);
  /**
   * Maakt tekst veilig om in HTML te plaatsen.
   * @param {*} value tekst of waarde
   * @returns {string} tekst met HTML-tekens vervangen door entiteiten
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /** Hoeveel regels de lijst in het venster toont (de nieuwste); alles staat in de Excel. */
  const SHOWN = 300;
  let api; let toast; let load; let timer = null; let last = null;

  /**
   * Geeft de module wat hij van de pagina nodig heeft.
   * @param {object} context api, toast en load (lijst verversen) uit artikelen.js
   * @returns {void}
   */
  function setup(context) {
    ({ api, toast, load } = context);
    $('#shop-missing-dialog').addEventListener('close', stopPolling);
    /** Sluit het venster; de taak op de server loopt door. */
    $('#sm-close').onclick = () => { stopPolling(); $('#shop-missing-dialog').close(); };
    /**
     * Downloadt de lijst als Excel.
     * @returns {Promise<void>}
     */
    $('#sm-excel').onclick = () => downloadExcel().catch((error) => toast(`Export mislukt: ${error.message}`, true));
  }

  /** Stopt het ophalen van de voortgang. */
  function stopPolling() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /**
   * Toont de stand van de taak: tekst, balk en lijst.
   * @param {object} state De stand van de server.
   * @returns {void}
   */
  function render(state) {
    last = state;
    const bar = $('#sm-bar');
    $('#sm-text').textContent = state.message || (state.phase === 'idle' ? 'Geen taak actief (de server is mogelijk herstart). Start hem opnieuw.' : '');
    if (state.phase === 'variaties' && state.variationsTotal) bar.value = state.variationsDone / state.variationsTotal;
    else if (state.phase === 'toevoegen' && state.total) bar.value = state.created / state.total;
    else if (!state.running) bar.value = state.error ? 0 : 1;
    else bar.removeAttribute('value');
    const list = $('#sm-list');
    const skippedItems = state.skippedItems || [];
    const restoredItems = state.restoredItems || [];
    list.hidden = !state.added.length && !skippedItems.length && !restoredItems.length;
    const shown = state.added.slice(-SHOWN).reverse();
    list.innerHTML = `${restoredItems.length ? `<div><strong>Teruggezet of gekoppeld: ${restoredItems.length}</strong> (zie tabblad Teruggezet in de Excel)</div>` : ''}${skippedReasons(skippedItems)}${state.added.length > SHOWN ? `<div class="muted">Laatste ${SHOWN} van ${state.added.length} binnengehaald; alles staat in de Excel.</div>` : ''}${shown.map((item) => `<div><code>${esc(item.code)}</code> ${esc(item.name)}</div>`).join('')}`;
    $('#sm-excel').hidden = !state.added.length && !skippedItems.length && !restoredItems.length;
  }

  /**
   * Telt de overgeslagen artikelen per reden, zodat in het venster te zien is waarom ze niet zijn toegevoegd.
   * @param {object[]} skippedItems De overgeslagen artikelen met reden.
   * @returns {string} HTML met één regel per reden, of leeg.
   */
  function skippedReasons(skippedItems) {
    if (!skippedItems.length) return '';
    const counts = new Map();
    for (const item of skippedItems) {
      const group = String(item.reason).replace(/«.*»/, '…').replace(/\(\d+\)/, '').trim();
      counts.set(group, (counts.get(group) || 0) + 1);
    }
    return `<div><strong>Overgeslagen: ${skippedItems.length}</strong> (per artikel met reden in de Excel)</div>${[...counts].map(([group, count]) => `<div class="muted">${count}× ${esc(group)}</div>`).join('')}`;
  }

  /**
   * Haalt de stand elke twee seconden op tot de taak klaar is en ververst daarna de artikellijst.
   * @returns {Promise<void>}
   */
  async function poll() {
    try {
      const state = await api('stock/import-shop-missing');
      render(state);
      if (state.running) { timer = setTimeout(poll, 2000); return; }
      timer = null;
      if (state.created) await load();
    } catch (error) {
      $('#sm-text').textContent = `Voortgang ophalen mislukt: ${error.message}`;
      timer = setTimeout(poll, 5000);
    }
  }

  /**
   * Opent het venster en start de taak (of laat de lopende taak zien).
   * @returns {Promise<void>}
   */
  async function open() {
    const dialog = $('#shop-missing-dialog');
    stopPolling();
    $('#sm-text').textContent = 'Starten…';
    $('#sm-bar').removeAttribute('value');
    $('#sm-list').hidden = true;
    $('#sm-excel').hidden = true;
    dialog.showModal();
    try {
      const state = await api('stock/import-shop-missing', { method: 'POST', body: {} });
      render(state);
      if (state.running) timer = setTimeout(poll, 2000);
      else if (state.created) await load();
    } catch (error) {
      $('#sm-text').textContent = `Starten mislukt: ${error.message}`;
    }
  }

  /**
   * Zet de lijst van binnengehaalde artikelen in een Excel-bestand.
   * @returns {Promise<void>}
   */
  async function downloadExcel() {
    if (!last || (!last.added.length && !(last.skippedItems || []).length && !(last.restoredItems || []).length)) return;
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const excelWorkbook = new ExcelJS.Workbook();
    const worksheet = excelWorkbook.addWorksheet('Binnengehaald', { views: [{ state: 'frozen', ySplit: 1 }] });
    worksheet.columns = [{ header: 'Artikelcode', key: 'code', width: 24 }, { header: 'Omschrijving', key: 'name', width: 70 }];
    for (const item of last.added) worksheet.addRow({ code: item.code, name: item.name });
    worksheet.getRow(1).font = { bold: true };
    const restoredSheet = excelWorkbook.addWorksheet('Teruggezet', { views: [{ state: 'frozen', ySplit: 1 }] });
    restoredSheet.columns = [{ header: 'Artikelcode', key: 'code', width: 28 }, { header: 'Omschrijving', key: 'name', width: 70 }, { header: 'Webshop-id', key: 'productId', width: 12 }, { header: 'Soort', key: 'kind', width: 36 }];
    for (const item of last.restoredItems || []) restoredSheet.addRow(item);
    restoredSheet.getRow(1).font = { bold: true };
    const skippedSheet = excelWorkbook.addWorksheet('Overgeslagen', { views: [{ state: 'frozen', ySplit: 1 }] });
    skippedSheet.columns = [{ header: 'Webshop-id', key: 'productId', width: 12 }, { header: 'Sku', key: 'sku', width: 28 }, { header: 'Voorgestelde code', key: 'code', width: 28 }, { header: 'Omschrijving', key: 'name', width: 60 }, { header: 'Reden', key: 'reason', width: 70 }, { header: 'Webshopadres', key: 'url', width: 60 }];
    for (const item of last.skippedItems || []) skippedSheet.addRow(item);
    skippedSheet.getRow(1).font = { bold: true };
    const buffer = await excelWorkbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    link.download = `webshop-binnengehaald-${new Date().toISOString().slice(0, 10)}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  window.ArtikelenShopMissing = { setup, open };
})();
