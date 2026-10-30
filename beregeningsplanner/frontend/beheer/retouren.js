// Beheer > Retouren: retouren uit de eigen webshop met hun status, het detail
// (regels, reden, verloop), goedkeuren of afwijzen, afronden (artikelen terug op
// voorraad) en de creditnota (API /api/admin/web-returns, zie
// backend/src/webshop/web-returns.js).
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
  const PAGE = 50;
  const state = { status: '', offset: 0, statuses: {} };
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};

  /**
   * Roept de beheer-API aan.
   * @param {string} path Pad onder api/admin/web-returns.
   * @param {object} [requestOptions] Opties voor fetch; `body` wordt als JSON verstuurd.
   * @returns {Promise<object>} Het antwoord (fout = Error met de melding van de server).
   */
  async function api(path, requestOptions = {}) {
    const res = await fetch(`../api/admin/web-returns${path}`, {
      cache: 'no-store', ...requestOptions,
      headers: requestOptions.body ? { 'Content-Type': 'application/json' } : undefined,
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  /**
   * Voert een actie op de geopende retour uit en tekent het detail opnieuw.
   * @param {object} record De retour.
   * @param {string} action Het pad onder de retour (decision, complete of credit).
   * @param {object} body De invoer voor de actie.
   * @param {string} done De melding bij succes.
   * @param {HTMLButtonElement} button De knop (wordt uitgezet tijdens het wachten).
   * @returns {Promise<void>}
   */
  async function act(record, action, body, done, button) {
    button.disabled = true;
    try {
      const out = await api(`/${encodeURIComponent(record.id)}/${action}`, { method: 'POST', body });
      toast(done);
      renderDetail(out.return);
      load();
    } catch (error) { toast(error.message, true); button.disabled = false; }
  }

  /**
   * Tekent het detail van een retour met de knoppen die bij zijn status horen.
   * @param {object} record De retour (met regels, reden en verloop).
   * @returns {void}
   */
  function renderDetail(record) {
    const box = $('#wr-detail');
    const lines = record.lines.map((line) => `<tr><td>${esc(line.name)}<span class="sub">${esc(line.code)}</span></td><td class="num">${line.qty}</td></tr>`).join('');
    const credit = record.credit ? `<p>Creditnota: <a href="../facturen/?id=${encodeURIComponent(record.credit.invoiceId)}">${esc(record.credit.number || 'concept')}</a> (${esc(record.credit.status)})</p>`
      : record.status === 'afgerond' ? `<p>${record.creditError ? `${esc(record.creditError)} ` : 'Er is nog geen creditnota. '}<button class="btn" id="wr-credit">Creditnota maken</button></p>` : '';
    const resend = record.status === 'afgerond' && !(record.mail && record.mail.kind === 'afgerond' && record.mail.sent) ? ' <button class="btn" id="wr-resend">Mail opnieuw versturen</button>' : '';
    const mail = (record.mail ? (record.mail.sent ? `Laatste mail (${esc(record.mail.kind)}) verstuurd ${when(record.mail.at)}` : `Laatste mail (${esc(record.mail.kind)}) niet verstuurd: ${esc(record.mail.error)}`) : 'Nog geen mail verstuurd') + resend;
    let actions = '';
    if (record.status === 'aangevraagd') {
      actions = `<label class="form-field"><span>Toelichting voor de klant (verplicht bij afwijzen)</span><textarea id="wr-note" rows="2" maxlength="1000"></textarea></label>
        <p><button class="btn primary" id="wr-approve">Goedkeuren</button> <button class="btn danger" id="wr-reject">Afwijzen</button></p>`;
    } else if (record.status === 'goedgekeurd') {
      actions = `<p><label><input type="checkbox" id="wr-restock" checked> Artikelen terug op voorraad (niet aanvinken bij beschadigde artikelen)</label></p>
        <p><button class="btn primary" id="wr-complete">Retour ontvangen en afronden</button></p>`;
    }
    box.innerHTML = `<h3>${esc(record.number)} <span class="pill ${esc(record.status)}">${esc(record.statusLabel)}</span></h3>
      <p>Bestelling ${esc(record.orderNumber)} · ${esc(record.customerName)} · <a href="mailto:${esc(record.email)}">${esc(record.email)}</a></p>
      <div class="tablewrap"><table class="grid"><thead><tr><th>Artikel</th><th class="num">Terug</th></tr></thead><tbody>${lines}</tbody></table></div>
      <p><b>Reden:</b> ${esc(record.reasonLabel)}${record.note ? `<br><b>Toelichting klant:</b> ${esc(record.note)}` : ''}${record.decisionNote ? `<br><b>Jouw toelichting:</b> ${esc(record.decisionNote)}` : ''}</p>
      ${record.status === 'afgerond' ? `<p>${record.restock ? 'De artikelen zijn teruggeboekt op voorraad.' : 'De artikelen zijn niet teruggeboekt op voorraad.'}</p>` : ''}
      ${credit}
      <p class="muted small">${mail}<br>Verloop: ${record.history.map((step) => `${esc(state.statuses[step.status] || step.status)} (${when(step.at)})`).join(' → ')}</p>
      ${actions}
      <p><button class="btn" id="wr-close">Sluiten</button></p>`;
    box.hidden = false;
    /** Sluit het detail. */
    $('#wr-close').onclick = () => { box.hidden = true; };
    const approve = $('#wr-approve');
    if (approve) {
      /**
       * Keurt de retour goed.
       * @returns {Promise<void>}
       */
      approve.onclick = () => act(record, 'decision', { approve: true, note: $('#wr-note').value }, 'Retour goedgekeurd', approve);
      const reject = $('#wr-reject');
      /**
       * Wijst de retour af (de toelichting is verplicht).
       * @returns {Promise<void>}
       */
      reject.onclick = () => act(record, 'decision', { approve: false, note: $('#wr-note').value }, 'Retour afgewezen', reject);
    }
    const complete = $('#wr-complete');
    if (complete) {
      /**
       * Rondt de retour af, met of zonder voorraad terug te boeken.
       * @returns {Promise<void>}
       */
      complete.onclick = () => act(record, 'complete', { restock: $('#wr-restock').checked }, 'Retour afgerond', complete);
    }
    const resendMail = $('#wr-resend');
    if (resendMail) {
      /**
       * Verstuurt de mail over de afgeronde retour opnieuw.
       * @returns {Promise<void>}
       */
      resendMail.onclick = () => act(record, 'completion-mail', {}, 'Mail verstuurd', resendMail);
    }
    const makeCredit = $('#wr-credit');
    if (makeCredit) {
      /**
       * Maakt (opnieuw) de creditnota van deze retour.
       * @returns {Promise<void>}
       */
      makeCredit.onclick = () => act(record, 'credit', {}, 'Creditnota gemaakt', makeCredit);
    }
  }

  /**
   * Opent het detail van een retour.
   * @param {string} id Id van de retour.
   * @returns {Promise<void>}
   */
  async function open(id) {
    try { const out = await api(`/${encodeURIComponent(id)}`); renderDetail(out.return); $('#wr-detail').scrollIntoView({ block: 'nearest' }); } catch (error) { toast(error.message, true); }
  }

  /**
   * Laadt de lijst met het gekozen filter en tekent hem.
   * @returns {Promise<void>}
   */
  async function load() {
    const table = $('#wr-table');
    try {
      const out = await api(`?status=${encodeURIComponent(state.status)}&limit=${PAGE}&offset=${state.offset}`);
      state.statuses = out.statuses;
      const select = $('#wr-status');
      if (!select.options.length) select.innerHTML = `<option value="">Alle statussen</option>${Object.entries(out.statuses).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('')}`;
      select.value = state.status;
      table.innerHTML = !out.items.length ? '<tr><td class="empty">Geen retouren.</td></tr>'
        : `<thead><tr><th>Retour</th><th>Aangevraagd</th><th>Bestelling</th><th>Klant</th><th>Reden</th><th>Status</th></tr></thead><tbody>${out.items.map((record) => `
          <tr data-id="${esc(record.id)}" class="clickable"><td><a href="#retouren" data-open>${esc(record.number)}</a></td><td>${esc(when(record.createdAt))}</td><td>${esc(record.orderNumber)}</td><td>${esc(record.customerName)}</td><td>${esc(record.reasonLabel)}</td><td><span class="pill ${esc(record.status)}">${esc(record.statusLabel)}</span></td></tr>`).join('')}</tbody>`;
      for (const link of table.querySelectorAll('[data-open]')) {
        /**
         * Opent het detail van de retour in deze regel.
         * @param {MouseEvent} event De klik.
         * @returns {void}
         */
        link.onclick = (event) => { event.preventDefault(); open(link.closest('tr').dataset.id); };
      }
      $('#wr-info').textContent = `${out.total ? state.offset + 1 : 0}–${Math.min(out.total, state.offset + PAGE)} van ${out.total}`;
      $('#wr-prev').disabled = state.offset === 0;
      $('#wr-next').disabled = state.offset + PAGE >= out.total;
    } catch (error) {
      table.innerHTML = `<tr><td class="empty">Kan de retouren niet laden (${esc(error.message)}).</td></tr>`;
    }
  }

  /**
   * Exporteert de retouren (met het gekozen filter) naar Excel: één rij per teruggestuurde regel.
   * @returns {Promise<void>}
   */
  async function exportExcel() {
    const button = $('#wr-export');
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    button.disabled = true;
    try {
      const { status } = state;
      const items = [];
      let expectedTotal = null;
      for (;;) {
        const page = await api(`?status=${encodeURIComponent(status)}&limit=200&offset=${items.length}`);
        if (expectedTotal === null) expectedTotal = page.total;
        if (page.total !== expectedTotal) { toast('De retouren zijn tijdens het exporteren gewijzigd. Start de export opnieuw.', true); return; }
        items.push(...page.items);
        if (items.length >= page.total || !page.items.length) break;
      }
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Aquatech';
      const sheet = workbook.addWorksheet('Retouren');
      sheet.columns = [
        { header: 'Retour', key: 'number', width: 18 }, { header: 'Aangevraagd', key: 'at', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } }, { header: 'Status', key: 'status', width: 13 },
        { header: 'Bestelling', key: 'order', width: 16 }, { header: 'Klant', key: 'name', width: 26 }, { header: 'E-mail', key: 'email', width: 28 }, { header: 'Reden', key: 'reason', width: 22 },
        { header: 'Artikelnummer', key: 'code', width: 18 }, { header: 'Omschrijving', key: 'article', width: 40 }, { header: 'Aantal', key: 'qty', width: 9 },
        { header: 'Prijs excl. btw', key: 'unitExcl', width: 15, style: { numFmt: '€ #,##0.00' } }, { header: 'Terug op voorraad', key: 'restock', width: 17 }, { header: 'Creditnota', key: 'credit', width: 16 },
      ];
      for (const record of items) {
        for (const line of record.lines) {
          sheet.addRow({
            number: record.number, at: new Date(record.createdAt), status: record.statusLabel, order: record.orderNumber, name: record.customerName, email: record.email, reason: record.reasonLabel,
            code: line.code, article: line.name, qty: line.qty, unitExcl: line.unitExcl, restock: record.status === 'afgerond' ? (record.restock ? 'ja' : 'nee') : '', credit: record.credit ? record.credit.number : '',
          });
        }
      }
      sheet.getRow(1).font = { bold: true };
      const buffer = await workbook.xlsx.writeBuffer();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      link.download = `webshop-retouren_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      toast(`${items.length} retouren geëxporteerd`);
    } catch (error) {
      toast(`Export mislukt: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Koppelt het filter, de bladerknoppen en de export (één keer, door Beheer).
   * @param {{ toast: Function }} options De melding van Beheer.
   * @returns {void}
   */
  function init(options) {
    toast = options.toast || toast;
    /** Filtert op status. */
    $('#wr-status').onchange = () => { state.status = $('#wr-status').value; state.offset = 0; load(); };
    /** Vorige pagina. */
    $('#wr-prev').onclick = () => { state.offset = Math.max(0, state.offset - PAGE); load(); };
    /** Volgende pagina. */
    $('#wr-next').onclick = () => { state.offset += PAGE; load(); };
    $('#wr-export').onclick = exportExcel;
  }

  window.BeheerRetouren = { init, load };
})();
