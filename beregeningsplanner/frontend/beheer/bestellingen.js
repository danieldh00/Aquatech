// Beheer > Bestellingen: bestellingen uit de eigen webshop met hun status, het
// detail (regels, adres, mailstatus), statuswijzigingen en een Excel-export
// (API /api/admin/web-orders, zie backend/src/webshop/web-orders.js).
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
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15" (– zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  /**
   * Bedrag in euro's.
   * @param {*} value Het bedrag.
   * @returns {string} Bijv. "€ 1.234,50".
   */
  const euro = (value) => `€ ${Number(value || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  /** Welke status op welke mag volgen, met de tekst van de knop. */
  const NEXT = { nieuw: [['verzonden', 'Markeer als verzonden'], ['geannuleerd', 'Annuleren']], verzonden: [['afgerond', 'Markeer als afgerond']] };
  const PAGE = 50;
  const state = { status: '', query: '', offset: 0, statuses: {}, openId: null };
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};

  /**
   * Roept de beheer-API aan.
   * @param {string} path Pad onder api/admin/web-orders.
   * @param {object} [requestOptions] Opties voor fetch; `body` wordt als JSON verstuurd.
   * @returns {Promise<object>} Het antwoord (fout = Error met de melding van de server).
   */
  async function api(path, requestOptions = {}) {
    const res = await fetch(`../api/admin/web-orders${path}`, {
      cache: 'no-store', ...requestOptions,
      headers: requestOptions.body ? { 'Content-Type': 'application/json' } : undefined,
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  /**
   * Tekent het detail van een bestelling met knoppen voor de volgende status.
   * @param {object} order De bestelling (met regels, adres en verloop).
   * @param {?{ id: string, number: string, status: string }} [invoice] De factuur van de bestelling, als die er is.
   * @returns {void}
   */
  function renderDetail(order, invoice = null) {
    const box = $('#wo-detail');
    const lines = order.lines.map((line) => `<tr><td>${esc(line.name)}<span class="sub">${esc(line.code)}</span></td><td class="num">${line.qty}</td><td class="num">${euro(line.unitIncl)}</td><td class="num">${euro(line.lineTotal)}</td></tr>`).join('');
    const vat = order.totals.byRate.map((row) => `<tr><td colspan="3">Waarvan ${row.rate}% btw over ${euro(row.excl)}</td><td class="num">${euro(row.vat)}</td></tr>`).join('');
    const buttons = (NEXT[order.status] || []).map(([status, label]) => `<button class="btn ${status === 'geannuleerd' ? 'danger' : 'primary'}" data-status="${status}">${label}</button>`).join(' ');
    const shipping = order.shipping;
    const shippingRow = shipping ? `<tr><td colspan="3">${esc(shipping.label)}</td><td class="num">${shipping.price > 0 ? euro(shipping.price) : 'Gratis'}</td></tr>` : '';
    const canTrack = shipping && shipping.method === 'dpd' && ['verzonden', 'afgerond'].includes(order.status);
    const trackingForm = shipping && shipping.method === 'dpd' ? `<p>${shipping.tracking ? `Volgcode: <a href="${esc(shipping.tracking.url)}" target="_blank" rel="noopener">${esc(shipping.tracking.code)}</a> ` : 'Nog geen volgcode. '}${order.status === 'nieuw' ? '<input id="wo-tracking" placeholder="Volgcode DPD (optioneel)" maxlength="40"> <span class="muted small">wordt bij Verzonden vastgelegd</span>' : canTrack ? `<input id="wo-tracking" placeholder="Volgcode DPD" maxlength="40" value="${esc(shipping.tracking ? shipping.tracking.code : '')}"> <button class="btn" id="wo-tracking-save">Volgcode opslaan</button>` : ''}</p>` : '';
    const mail = order.mail ? (order.mail.sent ? `Bevestiging verstuurd (${when(order.mail.at)})` : `Bevestiging niet verstuurd: ${esc(order.mail.error)}`) : 'Bevestiging nog niet verstuurd';
    const needsInvoice = ['verzonden', 'afgerond'].includes(order.status) && !invoice;
    const invoiceLine = invoice ? `<p>Factuur: <a href="../facturen/?id=${encodeURIComponent(invoice.id)}">${esc(invoice.number || 'concept')}</a> (${esc(invoice.status)}${invoice.paidAt ? ', betaald' : ''})</p>`
      : needsInvoice ? `<p>${order.invoiceError ? `Er is nog geen factuur: ${esc(order.invoiceError)} ` : 'Er is nog geen factuur. '}<button class="btn" id="wo-invoice">Factuur maken</button></p>` : '';
    box.innerHTML = `<h3>${esc(order.number)} <span class="pill ${esc(order.status)}">${esc(order.statusLabel)}</span></h3>
      <p>${esc(order.customer.company ? `${order.customer.company} – ` : '')}${esc(order.customer.name)} · <a href="mailto:${esc(mailtoAddress(order.email))}">${esc(order.email)}</a>${order.customer.phone ? ` · ${esc(order.customer.phone)}` : ''}<br>
      ${shipping && shipping.method === 'ophalen' ? 'Wordt opgehaald' : `${esc(order.address.street)}, ${esc(order.address.postcode)} ${esc(order.address.city)}${order.address.country && order.address.country !== 'NL' ? ` (${esc(order.address.country)})` : ''}`}</p>
      ${order.customerGroup === 'zakelijk' ? `<p><b>Zakelijke klant</b>${order.vat && order.vat.number ? ` · btw-nummer ${esc(order.vat.number)}` : ''}${order.vat && order.vat.shifted ? ' · <b>btw verlegd</b> (factureren zonder btw)' : ''}. Bedragen hieronder zijn incl. btw, behalve bij verlegging.</p>` : ''}
      ${order.note ? `<p><b>Opmerking:</b> ${esc(order.note)}</p>` : ''}
      <div class="tablewrap"><table class="grid"><thead><tr><th>Artikel</th><th class="num">Aantal</th><th class="num">Prijs</th><th class="num">Totaal</th></tr></thead><tbody>${lines}${shippingRow}${vat}
        <tr><th colspan="3">${order.vat && order.vat.shifted ? 'Totaal (btw verlegd)' : 'Totaal incl. btw'}</th><td class="num"><b>${euro(order.totals.total)}</b></td></tr></tbody></table></div>
      ${trackingForm}
      ${invoiceLine}
      <p class="muted small">Betaling: op rekening · ${mail}<br>Verloop: ${order.history.map((step) => `${esc(state.statuses[step.status] || step.status)} (${when(step.at)})`).join(' → ')}</p>
      <p>${buttons} <button class="btn" id="wo-close">Sluiten</button></p>`;
    box.hidden = false;
    /** Sluit het detail. */
    $('#wo-close').onclick = () => { box.hidden = true; state.openId = null; };
    const makeInvoice = $('#wo-invoice');
    if (makeInvoice) {
      /**
       * Maakt (opnieuw) de factuur van deze bestelling.
       * @returns {Promise<void>}
       */
      makeInvoice.onclick = async () => {
        makeInvoice.disabled = true;
        try {
          const out = await api(`/${encodeURIComponent(order.id)}/invoice`, { method: 'POST', body: {} });
          toast('Factuur gemaakt');
          open(order.id);
        } catch (error) { toast(error.message, true); makeInvoice.disabled = false; }
      };
    }
    const saveTracking = $('#wo-tracking-save');
    if (saveTracking) {
      /**
       * Legt de ingevulde volgcode vast bij de bestelling.
       * @returns {Promise<void>}
       */
      saveTracking.onclick = async () => {
        saveTracking.disabled = true;
        try {
          const out = await api(`/${encodeURIComponent(order.id)}/tracking`, { method: 'POST', body: { trackingCode: $('#wo-tracking').value } });
          toast('Volgcode opgeslagen');
          open(order.id);
        } catch (error) { toast(error.message, true); saveTracking.disabled = false; }
      };
    }
    for (const button of box.querySelectorAll('[data-status]')) {
      /**
       * Zet de bestelling op de status van deze knop (annuleren na bevestiging).
       * @returns {Promise<void>}
       */
      button.onclick = async () => {
        if (button.dataset.status === 'geannuleerd' && !confirm('Bestelling annuleren? De reservering vervalt.')) return;
        button.disabled = true;
        try {
          const trackingInput = $('#wo-tracking');
          const out = await api(`/${encodeURIComponent(order.id)}/status`, { method: 'POST', body: { status: button.dataset.status, trackingCode: button.dataset.status === 'verzonden' && trackingInput ? trackingInput.value : '' } });
          toast(`Bestelling ${out.order.number} is ${out.order.statusLabel.toLowerCase()}`);
          renderDetail(out.order, out.invoice);
          load();
        } catch (error) { toast(error.message, true); button.disabled = false; }
      };
    }
  }

  /**
   * Opent het detail van een bestelling.
   * @param {string} id Id van de bestelling.
   * @returns {Promise<void>}
   */
  async function open(id) {
    try { state.openId = id; const out = await api(`/${encodeURIComponent(id)}`); renderDetail(out.order, out.invoice); $('#wo-detail').scrollIntoView({ block: 'nearest' }); } catch (error) { toast(error.message, true); }
  }

  /**
   * Laadt de lijst met het gekozen filter en tekent hem.
   * @returns {Promise<void>}
   */
  async function load() {
    const table = $('#wo-table');
    try {
      const out = await api(`?status=${encodeURIComponent(state.status)}&q=${encodeURIComponent(state.query)}&limit=${PAGE}&offset=${state.offset}`);
      state.statuses = out.statuses;
      const select = $('#wo-status');
      if (!select.options.length) select.innerHTML = `<option value="">Alle statussen</option>${Object.entries(out.statuses).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('')}`;
      select.value = state.status;
      $('#wo-counts').textContent = Object.entries(out.counts).map(([key, count]) => `${out.statuses[key]}: ${count}`).join(' · ');
      table.innerHTML = !out.items.length ? '<tr><td class="empty">Geen bestellingen.</td></tr>'
        : `<thead><tr><th>Nummer</th><th>Besteld</th><th>Klant</th><th>E-mail</th><th class="num">Totaal</th><th>Status</th></tr></thead><tbody>${out.items.map((order) => `
          <tr data-id="${esc(order.id)}" class="clickable"><td><a href="#bestellingen" data-open>${esc(order.number)}</a></td><td>${esc(when(order.createdAt))}</td><td>${esc(order.customerName)}</td><td>${esc(order.email)}</td><td class="num">${euro(order.total)}</td><td><span class="pill ${esc(order.status)}">${esc(order.statusLabel)}</span></td></tr>`).join('')}</tbody>`;
      for (const link of table.querySelectorAll('[data-open]')) {
        /**
         * Opent het detail van de bestelling in deze regel.
         * @param {MouseEvent} event De klik.
         * @returns {void}
         */
        link.onclick = (event) => { event.preventDefault(); open(link.closest('tr').dataset.id); };
      }
      $('#wo-info').textContent = `${out.total ? state.offset + 1 : 0}–${Math.min(out.total, state.offset + PAGE)} van ${out.total}`;
      $('#wo-prev').disabled = state.offset === 0;
      $('#wo-next').disabled = state.offset + PAGE >= out.total;
    } catch (error) {
      table.innerHTML = `<tr><td class="empty">Kan de bestellingen niet laden (${esc(error.message)}).</td></tr>`;
    }
  }

  /**
   * Het adres voor een mailto-link: lokaal deel en domein afzonderlijk URI-gecodeerd, met een letterlijk @ ertussen (RFC 6068).
   * @param {string} email Het e-mailadres.
   * @returns {string} Het gecodeerde adres.
   */
  function mailtoAddress(email) {
    const at = String(email).lastIndexOf('@');
    if (at < 0) return encodeURIComponent(email);
    return `${encodeURIComponent(email.slice(0, at))}@${encodeURIComponent(email.slice(at + 1))}`;
  }

  /**
   * Exporteert de bestellingen (met het gekozen filter) naar Excel: een blad met bestellingen en een blad met regels.
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    const button = $('#wo-export');
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    button.disabled = true;
    try {
      // Filter vastleggen en tijdens het ophalen controleren dat de dataset gelijk blijft (anders verschuift de offset).
      const { status, query } = state;
      const items = [];
      const seen = new Set();
      let expectedTotal = null;
      for (;;) {
        const page = await api(`?status=${encodeURIComponent(status)}&q=${encodeURIComponent(query)}&lines=1&limit=500&offset=${items.length}`);
        if (expectedTotal === null) expectedTotal = page.total;
        if (page.total !== expectedTotal || page.items.some((order) => seen.has(order.id))) {
          toast('De bestellingen zijn tijdens het exporteren gewijzigd. Start de export opnieuw.', true);
          return;
        }
        for (const order of page.items) seen.add(order.id);
        items.push(...page.items);
        if (items.length >= page.total || !page.items.length) break;
      }
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Aquatech';
      const orders = workbook.addWorksheet('Bestellingen');
      orders.columns = [
        { header: 'Nummer', key: 'number', width: 16 }, { header: 'Besteld', key: 'at', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } }, { header: 'Status', key: 'status', width: 13 },
        { header: 'Klant', key: 'name', width: 26 }, { header: 'Bedrijf', key: 'company', width: 24 }, { header: 'E-mail', key: 'email', width: 28 }, { header: 'Telefoon', key: 'phone', width: 16 },
        { header: 'Adres', key: 'street', width: 28 }, { header: 'Postcode', key: 'postcode', width: 10 }, { header: 'Plaats', key: 'city', width: 18 },
        { header: 'Totaal excl. btw', key: 'excl', width: 15, style: { numFmt: '€ #,##0.00' } }, { header: 'Btw', key: 'vat', width: 11, style: { numFmt: '€ #,##0.00' } }, { header: 'Totaal (incl. btw; excl. bij verlegging)', key: 'total', width: 40, style: { numFmt: '€ #,##0.00' } },
        { header: 'Klantgroep', key: 'group', width: 12 }, { header: 'Btw-nummer', key: 'vatNumber', width: 18 }, { header: 'Btw verlegd', key: 'shifted', width: 11 }, { header: 'Verzending', key: 'shipping', width: 26 }, { header: 'Verzendkosten (incl. btw; excl. bij verlegging)', key: 'shippingPrice', width: 46, style: { numFmt: '€ #,##0.00' } }, { header: 'Volgcode', key: 'tracking', width: 20 },
        { header: 'Opmerking', key: 'note', width: 30 },
      ];
      const lines = workbook.addWorksheet('Regels');
      lines.columns = [
        { header: 'Nummer', key: 'number', width: 16 }, { header: 'Artikelnummer', key: 'code', width: 18 }, { header: 'Omschrijving', key: 'name', width: 40 }, { header: 'Aantal', key: 'qty', width: 9 },
        { header: 'Prijs excl. btw', key: 'unitExcl', width: 15, style: { numFmt: '€ #,##0.00' } }, { header: 'Btw %', key: 'vatRate', width: 8 },
        { header: 'Prijs (incl. btw; excl. bij verlegging)', key: 'unitIncl', width: 38, style: { numFmt: '€ #,##0.00' } }, { header: 'Totaal (incl. btw; excl. bij verlegging)', key: 'lineTotal', width: 40, style: { numFmt: '€ #,##0.00' } },
      ];
      for (const order of items) {
        const vat = order.totals.byRate.reduce((sum, row) => sum + row.vat, 0);
        orders.addRow({
          number: order.number, at: new Date(order.createdAt), status: order.statusLabel, name: order.customer.name, company: order.customer.company, email: order.email, phone: order.customer.phone,
          street: order.address.street, postcode: order.address.postcode, city: order.address.city, excl: Math.round((order.total - vat) * 100) / 100, vat: Math.round(vat * 100) / 100, total: order.total, group: order.customerGroup === 'zakelijk' ? 'zakelijk' : 'particulier', vatNumber: order.vat ? order.vat.number : '', shifted: order.vat && order.vat.shifted ? 'ja' : '', shipping: order.shipping ? order.shipping.label : '', shippingPrice: order.shipping ? order.shipping.price : 0,
          tracking: order.shipping && order.shipping.tracking ? order.shipping.tracking.code : '', note: order.note,
        });
        for (const line of order.lines) lines.addRow({ number: order.number, code: line.code, name: line.name, qty: line.qty, unitExcl: line.unitExcl, vatRate: line.vatRate, unitIncl: line.unitIncl, lineTotal: line.lineTotal });
      }
      for (const sheet of [orders, lines]) sheet.getRow(1).font = { bold: true };
      const buffer = await workbook.xlsx.writeBuffer();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      link.download = `webshop-bestellingen_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      toast(`${items.length} bestellingen geëxporteerd`);
    } catch (error) {
      toast(`Export mislukt: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Koppelt de filters, bladerknoppen en export (één keer, door Beheer).
   * @param {{ toast: Function }} options De melding van Beheer.
   * @returns {void}
   */
  function init(options) {
    toast = options.toast || toast;
    let timer = null;
    /** Filtert op status. */
    $('#wo-status').onchange = () => { state.status = $('#wo-status').value; state.offset = 0; load(); };
    /** Zoekt (kort na het typen) op nummer, naam of e-mail. */
    $('#wo-search').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { state.query = $('#wo-search').value.trim(); state.offset = 0; load(); }, 300); };
    /** Vorige pagina. */
    $('#wo-prev').onclick = () => { state.offset = Math.max(0, state.offset - PAGE); load(); };
    /** Volgende pagina. */
    $('#wo-next').onclick = () => { state.offset += PAGE; load(); };
    $('#wo-export').onclick = exportExcel;
  }

  window.BeheerBestellingen = { init, load };
})();
