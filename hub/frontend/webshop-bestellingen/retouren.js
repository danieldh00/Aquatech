// Webshopbestellingen (Verkoop) > Retouren: retouren uit de eigen webshop met hun status, het detail
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
  /**
   * Bedrag in euro's.
   * @param {*} value Het bedrag.
   * @returns {string} Bijv. "€ 1.234,50".
   */
  const euro = (value) => `€ ${Number(value || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
    if (!res.ok) throw new Error(body.message || AquatechCommon.statusMessage(res.status));
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
      // Met de instelling "creditfactuur direct bij goedkeuren" kan de creditnota mislukken of overgeslagen zijn: dat mag de beheerder niet ontgaan.
      const creditProblem = out.credit && (out.credit.error || out.credit.skipped);
      if (creditProblem) toast(`${done}, maar de creditfactuur is niet gemaakt: ${creditProblem}`, true); else toast(done);
      await open(out.return.id);
      load();
    } catch (error) { toast(error.message, true); button.disabled = false; }
  }

  /**
   * Tekent het detail van een retour met de knoppen die bij zijn status horen.
   * @param {object} record De retour (met regels, reden en verloop).
   * @param {?{ orderId: string, refunded: ?object }} [refund] Of de bestelling online is betaald en of deze retour al is terugbetaald.
   * @returns {void}
   */
  function renderDetail(record, refund = null) {
    const box = $('#wr-detail');
    const asked = record.status === 'aangevraagd';
    const approvedOf = new Map(record.lines.map((line) => [line.code, line.qty]));
    const sources = record.requested || record.lines;
    /**
     * De stukprijs van een regel excl. btw.
     * @param {object} line De regel van de retour.
     * @returns {number} De prijs, 0 als die ontbreekt.
     */
    const unit = (line) => Number(line.unitExcl) || 0;
    const lines = asked
      ? record.lines.map((line) => `<tr data-line="${esc(line.code)}" data-asked="${line.qty}" data-unit="${unit(line)}"><td>${esc(line.name)}<span class="sub">${esc(line.code)}</span></td><td class="num">${line.qty}</td>
          <td><select class="wr-decision" aria-label="Besluit voor ${esc(line.name)}"><option value="ja">Goedkeuren</option><option value="nee">Afwijzen</option></select></td>
          <td class="num"><input type="number" class="wr-qty" min="0" max="${line.qty}" step="1" value="${line.qty}" aria-label="Goedgekeurd aantal van ${esc(line.name)}"></td>
          <td class="num wr-credit-excl">${euro(line.qty * unit(line))}</td></tr>`).join('')
      : sources.map((line) => {
        const approved = approvedOf.get(line.code) || 0;
        return `<tr><td>${esc(line.name)}<span class="sub">${esc(line.code)}</span></td><td class="num">${line.qty}</td>${record.partial ? `<td class="num">${approved}</td>` : ''}</tr>`;
      }).join('');
    const head = asked ? '<tr><th>Artikel</th><th class="num">Gevraagd</th><th>Besluit</th><th class="num">Goedgekeurd aantal</th><th class="num">Credit (excl.)</th></tr>'
      : `<tr><th>Artikel</th><th class="num">${record.partial ? 'Gevraagd' : 'Terug'}</th>${record.partial ? '<th class="num">Goedgekeurd</th>' : ''}</tr>`;
    const credit = record.credit ? `<p>Creditnota: <a href="../facturen/?id=${encodeURIComponent(record.credit.invoiceId)}">${esc(record.credit.number || 'concept')}</a> (${esc(record.credit.status)})</p>`
      : record.status === 'afgerond' ? `<p>${record.creditError ? `${esc(record.creditError)} ` : 'Er is nog geen creditnota. '}<button class="btn" id="wr-credit">Creditnota maken</button></p>` : '';
    // Online betaald: het bedrag van de definitieve creditnota via Mollie terugbetalen (één keer per retour).
    const refundLine = refund && record.credit && record.credit.status !== 'concept'
      ? `<p>${refund.refunded ? `Terugbetaald via Mollie: ${euro(refund.refunded.amount)} (${when(refund.refunded.at)})` : '<button class="btn primary" id="wr-refund">Terugbetalen via Mollie</button> <span class="muted small">het bedrag van de creditnota</span>'}</p>` : '';
    const resend = record.status === 'afgerond' && !(record.mail && record.mail.kind === 'afgerond' && record.mail.sent) ? ' <button class="btn" id="wr-resend">Mail opnieuw versturen</button>' : '';
    const mail = (record.mail ? (record.mail.sent ? `Laatste mail (${esc(record.mail.kind)}) verstuurd ${when(record.mail.at)}` : `Laatste mail (${esc(record.mail.kind)}) niet verstuurd: ${esc(record.mail.error)}`) : 'Nog geen mail verstuurd') + resend;
    let actions = '';
    if (record.status === 'aangevraagd') {
      actions = `<label>Toelichting voor de klant (verplicht zodra je iets niet volledig goedkeurt)<textarea id="wr-note" rows="3" maxlength="1000"></textarea></label>
        <div class="row actions"><button class="btn primary" id="wr-approve">Goedkeuren</button><button class="btn danger" id="wr-reject">Alles afwijzen</button></div>`;
    } else if (record.status === 'goedgekeurd') {
      actions = `<p><label><input type="checkbox" id="wr-restock" checked> Artikelen terug op voorraad (niet aanvinken bij beschadigde artikelen)</label></p>
        <div class="row actions"><button class="btn primary" id="wr-complete">Retour ontvangen en afronden</button></div>`;
    }
    box.innerHTML = `<h3>${esc(record.number)} <span class="pill ${esc(record.status)}">${esc(record.statusLabel)}</span></h3>
      <p>Bestelling ${esc(record.orderNumber)} · ${esc(record.customerName)} · <a href="mailto:${esc(record.email)}">${esc(record.email)}</a></p>
      <div class="tablewrap"><table class="grid"><thead>${head}</thead><tbody>${lines}</tbody></table></div>
      ${asked ? '<p class="sum" id="wr-sum"></p>' : ''}
      <p><b>Reden:</b> ${esc(record.reasonLabel)}${record.note ? `<br><b>Toelichting klant:</b> ${esc(record.note)}` : ''}${record.decisionNote ? `<br><b>Jouw toelichting:</b> ${esc(record.decisionNote)}` : ''}</p>
      ${record.status === 'afgerond' ? `<p>${record.restock ? 'De artikelen zijn teruggeboekt op voorraad.' : 'De artikelen zijn niet teruggeboekt op voorraad.'}</p>` : ''}
      ${credit}
      ${refundLine}
      <p class="muted small">${mail}<br>Verloop: ${record.history.map((step) => `${esc(state.statuses[step.status] || step.status)} (${when(step.at)})`).join(' → ')}</p>
      ${actions}
      <div class="row actions"><button class="btn" id="wr-close">Sluiten</button></div>`;
    box.hidden = false;
    /** Sluit het detail. */
    $('#wr-close').onclick = () => { box.hidden = true; };
    const approve = $('#wr-approve');
    /**
     * De goedgekeurde aantallen uit het formulier (afwijzen of een leeg aantal telt als 0).
     * @returns {{ code: string, qty: number }[]} Per regel het goedgekeurde aantal.
     */
    const decisionLines = () => [...box.querySelectorAll('tr[data-line]')].map((row) => ({
      code: row.dataset.line,
      qty: row.querySelector('.wr-decision').value === 'nee' ? 0 : Math.max(0, Math.min(Number(row.dataset.asked), Math.floor(Number(row.querySelector('.wr-qty').value) || 0))),
    }));
    /**
     * Werkt het goedgekeurde aantal, het credit-bedrag, de samenvatting en de knoptekst bij.
     * @returns {void}
     */
    const refreshDecision = () => {
      const rows = [...box.querySelectorAll('tr[data-line]')];
      if (!rows.length) return;
      let credit = 0;
      let approvedLines = 0;
      let declinedLines = 0;
      let anyShort = false;
      for (const row of rows) {
        const qty = decisionLines().find((entry) => entry.code === row.dataset.line).qty;
        const input = row.querySelector('.wr-qty');
        input.disabled = row.querySelector('.wr-decision').value === 'nee';
        if (input.disabled) input.value = 0;
        row.querySelector('.wr-credit-excl').textContent = euro(qty * Number(row.dataset.unit));
        credit += qty * Number(row.dataset.unit);
        if (qty > 0) approvedLines += 1; else declinedLines += 1;
        if (qty < Number(row.dataset.asked)) anyShort = true;
      }
      const label = approvedLines === 0 ? 'Alles afwijzen' : anyShort ? 'Deels goedkeuren' : 'Alles goedkeuren';
      $('#wr-sum').innerHTML = approvedLines === 0 ? 'Er is niets goedgekeurd: de retour wordt afgewezen en er komt geen creditfactuur.'
        : `<b>${approvedLines} van ${rows.length} regels</b> goedgekeurd${declinedLines ? `, ${declinedLines} afgewezen` : ''}. Creditfactuur: <b>${euro(credit)} excl. btw</b>, alleen voor de goedgekeurde aantallen.`;
      approve.textContent = label;
      approve.disabled = approvedLines === 0;
    };
    for (const control of box.querySelectorAll('.wr-decision, .wr-qty')) {
      /**
       * Past het besluit en het aantal van de regel op elkaar aan en werkt de samenvatting bij.
       * @returns {void}
       */
      control.oninput = () => {
        if (control.classList.contains('wr-qty')) control.closest('tr').querySelector('.wr-decision').value = Number(control.value) > 0 ? 'ja' : 'nee';
        refreshDecision();
      };
    }
    if (approve) refreshDecision();
    if (approve) {
      /**
       * Keurt de retour goed.
       * @returns {Promise<void>}
       */
      approve.onclick = () => act(record, 'decision', { approve: true, note: $('#wr-note').value, lines: decisionLines() }, 'Besluit vastgelegd', approve);
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
    const refundButton = $('#wr-refund');
    if (refundButton) {
      /**
       * Betaalt het bedrag van de creditnota terug via Mollie (na bevestiging; geld gaat echt terug).
       * @returns {Promise<void>}
       */
      refundButton.onclick = async () => {
        if (!confirm('Het bedrag van de creditnota via Mollie terugbetalen aan de klant? Dit kan niet ongedaan worden gemaakt.')) return;
        refundButton.disabled = true;
        try {
          const res = await fetch(`../api/admin/web-orders/${encodeURIComponent(refund.orderId)}/refund`, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnId: record.id }) });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.message || AquatechCommon.statusMessage(res.status));
          toast(`Terugbetaald: ${euro(body.refund.amount)}`);
          await open(record.id);
        } catch (error) { toast(error.message, true); refundButton.disabled = false; }
      };
    }
  }

  /**
   * Opent het detail van een retour.
   * @param {string} id Id van de retour.
   * @returns {Promise<void>}
   */
  async function open(id) {
    try { const out = await api(`/${encodeURIComponent(id)}`); renderDetail(out.return, out.refund); $('#wr-detail').scrollIntoView({ block: 'nearest' }); } catch (error) { toast(error.message, true); }
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
