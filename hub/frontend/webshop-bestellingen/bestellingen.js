// Webshopbestellingen (Verkoop) > Bestellingen: bestellingen uit de eigen webshop met hun status, het
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
    if (!res.ok) throw new Error(body.message || AquatechCommon.statusMessage(res.status));
    return body;
  }

  /** Betaalstatus van een online bestelling in gewone woorden. */
  const PAY_LABELS = { open: 'wacht op betaling', betaald: 'betaald', mislukt: 'betaling niet gelukt', verlopen: 'niet betaald, vervallen' };
  /** Namen van de betaalmethoden van Mollie. */
  const PAY_METHODS = { ideal: 'iDEAL', creditcard: 'creditcard', bancontact: 'Bancontact', paypal: 'PayPal', applepay: 'Apple Pay', banktransfer: 'overboeking' };

  /**
   * De stand van de voorraadreservering van een nieuwe bestelling (8): tot wanneer hij vastligt of dat hij is vrijgegeven.
   * @param {object} order De bestelling.
   * @returns {string} HTML-tekst (met een regelafbreking vooraf), leeg als er niets te melden is.
   */
  const reservationText = (order) => {
    if (order.status !== 'nieuw') return '';
    if (order.reservationReleasedAt) return `<br><strong>Reservering vervallen</strong> op ${when(order.reservationReleasedAt)}: de voorraad is weer vrij. Verzenden kan nog, mits er voorraad is.`;
    // Een betaalde online bestelling houdt haar voorraad tot verzenden of annuleren; de betaaltermijn speelt dan niet meer.
    if (order.payment === 'online' && order.pay && order.pay.status === 'betaald') return '<br>Voorraad gereserveerd tot verzenden of annuleren.';
    if (order.reservedUntil) return `<br>Voorraad gereserveerd tot ${when(order.reservedUntil)}.`;
    return '';
  };
  /**
   * De betaling van een bestelling als tekst voor het detail.
   * @param {object} order De bestelling (payment en pay).
   * @returns {string} Bijv. "online betaald op 1 nov 2026 (iDEAL)" of "op rekening".
   */
  function paymentText(order) {
    if (order.payment !== 'online' || !order.pay) return 'op rekening';
    const pay = order.pay;
    const method = PAY_METHODS[pay.method] || pay.method;
    const refund = pay.refundNeeded ? ' · <b>betaald en geannuleerd: nog terugbetalen</b>' : '';
    const refunds = (pay.refunds || []).map((entry) => ` · terugbetaald ${euro(entry.amount)} (${when(entry.at)})`).join('');
    const outsideRefund = Number(pay.refundedTotal) > (pay.refunds || []).reduce((sum, entry) => sum + Number(entry.amount || 0), 0) + 0.005 ? ` · volgens Mollie in totaal ${euro(pay.refundedTotal)} terugbetaald` : '';
    const chargeback = Number(pay.chargedBack) > 0 ? ` · <b>teruggeboekt door de bank (chargeback): ${euro(pay.chargedBack)}</b>` : '';
    return `online via Mollie, ${esc(PAY_LABELS[pay.status] || pay.status)}${pay.status === 'betaald' ? ` op ${when(pay.paidAt)}${method ? ` (${esc(method)})` : ''}` : ''}${pay.mode === 'test' ? ' · testbetaling' : ''}${refund}${refunds}${outsideRefund}${chargeback}`;
  }

  /**
   * Tekent het detail van een bestelling met knoppen voor de volgende status.
   * @param {object} order De bestelling (met regels, adres en verloop).
   * @param {?{ id: string, number: string, status: string }} [invoice] De factuur van de bestelling, als die er is.
   * @returns {void}
   */
  function renderDetail(order, invoice = null) {
    const box = $('#wo-detail');
    // Bij een deellevering of tekort: per regel besteld, geleverd, leverbaar en backorder, met een veld voor wat nu wordt verzonden.
    const plan = order.fulfilment && (order.fulfilment.backorder || order.shipments.length) ? order.fulfilment : null;
    const lines = order.lines.map((line, index) => {
      const status = plan ? plan.lines[index] : null;
      const extra = status ? `<td class="num">${status.shipped}</td><td class="num">${status.ready}</td><td class="num">${status.backorder > 0 ? `<b>${status.backorder}</b>${status.expected ? `<span class="sub">verwacht ${esc(status.expected.slice(0, 10))}</span>` : ''}` : '0'}</td><td class="num">${status.remaining > 0 ? `<input type="number" class="qty-now" data-line="${index}" min="0" max="${status.remaining}" step="${Number(line.stockPer) > 1 ? 1 : 'any'}" value="${status.ready}" aria-label="Nu verzenden: ${esc(line.name)}">` : '–'}</td>` : '';
      return `<tr><td>${esc(line.name)}<span class="sub">${esc(line.code)}</span></td><td class="num">${line.qty}</td>${extra}<td class="num">${euro(line.unitIncl)}</td><td class="num">${euro(line.lineTotal)}</td></tr>`;
    }).join('');
    const extraHead = plan ? '<th class="num">Geleverd</th><th class="num">Leverbaar</th><th class="num">Backorder</th><th class="num">Nu verzenden</th>' : '';
    const extraCols = plan ? 4 : 0;
    const partialBox = order.status === 'nieuw' && order.fulfilment ? `<p class="partial"><label><input type="checkbox" id="wo-partial"${order.allowPartial ? ' checked' : ''}> Deellevering toestaan</label> <span class="muted small">${order.allowPartial ? 'Wat op voorraad is kan alvast mee; de rest staat op backorder.' : 'De bestelling wordt pas verzonden als alles leverbaar is.'}</span>${order.backorderReadyAt ? ` <span class="pill verzonden">Backorder klaar sinds ${esc(when(order.backorderReadyAt))}</span>` : ''}</p>` : '';
    const shipmentsText = order.shipments.length > 1 || (order.shipments.length === 1 && order.status === 'nieuw')
      ? `<p class="muted small">Zendingen: ${order.shipments.map((shipment) => `${esc(when(shipment.at))} (${shipment.lines.map((entry) => `${entry.qty} × ${esc(order.lines[entry.index] ? order.lines[entry.index].name : '')}`).join(', ')}${shipment.tracking ? `, volgcode ${esc(shipment.tracking)}` : ''})`).join(' → ')}</p>` : '';
    const vat = order.totals.byRate.map((row) => `<tr><td colspan="3">Waarvan ${row.rate}% btw over ${euro(row.excl)}</td><td class="num">${euro(row.vat)}</td></tr>`).join('');
    const unpaid = order.payment === 'online' && !(order.pay && order.pay.status === 'betaald');
    const shipPart = plan && order.fulfilment.canShip && !unpaid ? '<button class="btn primary" id="wo-ship-part">Verzend gekozen aantallen</button> ' : '';
    const buttons = shipPart + (NEXT[order.status] || []).filter(([status]) => !(status === 'verzonden' && unpaid) && !(status === 'geannuleerd' && order.shipments.length)).map(([status, label]) => `<button class="btn ${status === 'geannuleerd' ? 'danger' : status === 'verzonden' && plan ? '' : 'primary'}" data-status="${status}">${status === 'verzonden' && plan ? 'Markeer rest als verzonden' : label}</button>`).join(' ');
    // Een geannuleerde, online betaalde bestelling kan in één keer via Mollie worden terugbetaald (W-05).
    const canRefund = order.status === 'geannuleerd' && order.payment === 'online' && order.pay && order.pay.status === 'betaald' && !(order.pay.refunds || []).some((entry) => entry.key === 'annulering');
    const shipping = order.shipping;
    const shippingRow = shipping ? `<tr><td colspan="3">${esc(shipping.label)}</td><td class="num">${shipping.price > 0 ? euro(shipping.price) : 'Gratis'}</td></tr>` : '';
    const canTrack = shipping && shipping.method === 'dpd' && ['verzonden', 'afgerond'].includes(order.status);
    const trackingForm = shipping && shipping.method === 'dpd' ? `<p>${shipping.tracking ? `Volgcode: <a href="${esc(shipping.tracking.url)}" target="_blank" rel="noopener">${esc(shipping.tracking.code)}</a> ` : 'Nog geen volgcode. '}${order.status === 'nieuw' ? '<input id="wo-tracking" placeholder="Volgcode DPD (optioneel)" maxlength="40"> <span class="muted small">wordt bij Verzonden vastgelegd</span>' : canTrack ? `<input id="wo-tracking" placeholder="Volgcode DPD" maxlength="40" value="${esc(shipping.tracking ? shipping.tracking.code : '')}"> <button class="btn" id="wo-tracking-save">Volgcode opslaan</button>` : ''}</p>` : '';
    const shipMail = order.shipMail ? (order.shipMail.sent ? `Verzendmail verstuurd${order.shipMail.tracking ? ` met volgcode ${esc(order.shipMail.tracking)}` : ''} (${when(order.shipMail.at)})` : `Verzendmail niet verstuurd: ${esc(order.shipMail.error)}`) : '';
    const mail = order.mail ? (order.mail.sent ? `Bevestiging verstuurd (${when(order.mail.at)})` : `Bevestiging niet verstuurd: ${esc(order.mail.error)}`) : 'Bevestiging nog niet verstuurd';
    const billing = order.deliverySame === false ? order.billingAddress : null;
    const billingLine = billing && billing.street ? `<br>${esc(billing.street)}, ${esc(billing.postcode)} ${esc(billing.city)}${billing.country && billing.country !== 'NL' ? ` (${esc(billing.country)})` : ''} <span class="muted small">(factuuradres)</span>${billing.unverified ? ' <span class="pill analyse" title="De klant vulde dit adres zelf in zonder opzoeking op postcode.">Adres niet gecontroleerd</span>' : ''}` : '';
    const needsInvoice = ['verzonden', 'afgerond'].includes(order.status) && !invoice;
    const invoiceLine = invoice ? `<p>Factuur: <a href="../facturen/?id=${encodeURIComponent(invoice.id)}">${esc(invoice.number || 'concept')}</a> (${esc(invoice.status)}${invoice.paidAt ? ', betaald' : ''})${order.creditNote ? (order.creditNote.invoiceId ? ` · creditnota ${esc(order.creditNote.number || 'concept')} (${esc(order.creditNote.status)})` : ' · de factuur was al gecrediteerd') : ''}${order.invoiceError ? ` <span class="muted small">${esc(order.invoiceError)}</span>` : ''}</p>`
      : needsInvoice ? `<p>${order.invoiceError ? `Er is nog geen factuur: ${esc(order.invoiceError)} ` : 'Er is nog geen factuur. '}<button class="btn" id="wo-invoice">Factuur maken</button></p>` : '';
    box.innerHTML = `<h3>${esc(order.number)} <span class="pill ${esc(order.status)}">${esc(order.statusLabel)}</span></h3>
      <p>${esc(order.customer.company ? `${order.customer.company} – ` : '')}${esc(order.customer.name)} · <a href="mailto:${esc(mailtoAddress(order.email))}">${esc(order.email)}</a>${order.customer.phone ? ` · ${esc(order.customer.phone)}` : ''}<br>
      ${shipping && shipping.method === 'ophalen' ? 'Wordt opgehaald' : `${esc(order.address.street)}, ${esc(order.address.postcode)} ${esc(order.address.city)}${order.address.country && order.address.country !== 'NL' ? ` (${esc(order.address.country)})` : ''}${order.address.unverified ? ' <span class="pill analyse" title="De klant vond zijn adres niet bij het opzoeken op postcode (of het opzoeken werkte niet) en heeft het zelf ingevuld.">Adres niet gecontroleerd</span>' : ''}`}${(!shipping || shipping.method !== 'ophalen') && order.deliverySame === false ? ' <span class="muted small">(afleveradres)</span>' : ''}${billingLine}</p>
      ${order.customerGroup === 'zakelijk' ? `<p><b>Zakelijke klant</b>${order.vat && order.vat.number ? ` · btw-nummer ${esc(order.vat.number)}` : ''}${order.vat && order.vat.shifted ? ' · <b>btw verlegd</b> (factureren zonder btw)' : ''}${order.vat && order.vat.vies ? ` · VIES ${esc(order.vat.vies.status)} op ${esc(String(order.vat.vies.checkedAt || '').slice(0, 10))}${order.vat.vies.requestId ? ` (consultatienummer ${esc(order.vat.vies.requestId)})` : ''}` : ''}. Bedragen hieronder zijn incl. btw, behalve bij verlegging.</p>` : ''}
      ${order.quote ? `<p>Uit offerte <a href="../offertes/?id=${encodeURIComponent(order.quote.id)}">${esc(order.quote.number)}</a>${order.paymentDays !== null && order.paymentDays !== undefined ? ` · betaaltermijn ${esc(String(order.paymentDays))} dagen` : ''}${order.language === 'en' ? ' · documenten in het Engels' : ''}</p>` : ''}
      ${order.note ? `<p><b>Opmerking:</b> ${esc(order.note)}</p>` : ''}
      ${order.dropshipping ? `<p><b>Dropshipping:</b> afleverbewijs naar ${esc(order.dropshipping.proofEmail)} · ${order.dropshipping.slip ? `pakbon van de klant ontvangen (${order.dropshipping.slip.pages} p.)` : '<span class="pill nieuw">pakbon van de klant ontbreekt</span>'}</p>` : ''}
      <div class="tablewrap"><table class="grid"><thead><tr><th>Artikel</th><th class="num">Besteld</th>${extraHead}<th class="num">Prijs</th><th class="num">Totaal</th></tr></thead><tbody>${lines}${shippingRow.replace('colspan="3"', `colspan="${3 + extraCols}"`)}${vat.replace(/colspan="3"/g, `colspan="${3 + extraCols}"`)}
        <tr><th colspan="${3 + extraCols}">${order.vat && order.vat.shifted ? 'Totaal (btw verlegd)' : 'Totaal incl. btw'}</th><td class="num"><b>${euro(order.totals.total)}</b></td></tr></tbody></table></div>
      ${partialBox}${shipmentsText}
      ${trackingForm}
      ${invoiceLine}
      <p class="muted small">Betaling: ${paymentText(order)} · ${mail}${shipMail ? ` · ${shipMail}` : ''}<br>Verloop: ${order.history.map((step) => `${esc(state.statuses[step.status] || step.status)} (${when(step.at)})${step.note ? `: ${esc(step.note)}` : ''}`).join(' → ')}${reservationText(order)}</p>
      <p>${buttons}${canRefund ? ' <button class="btn primary" id="wo-refund">Terugbetalen via Mollie</button>' : ''} ${order.status !== 'geannuleerd' && !(order.status === 'nieuw' && unpaid) ? '<button class="btn" id="wo-slip">Pakbon</button> ' : ''}<button class="btn" id="wo-close">Sluiten</button></p>`;
    box.hidden = false;
    /** Sluit het detail. */
    $('#wo-close').onclick = () => { box.hidden = true; state.openId = null; };
    const partialToggle = $('#wo-partial');
    if (partialToggle) {
      /**
       * Zet Deellevering toestaan aan of uit en tekent het detail opnieuw.
       * @returns {Promise<void>}
       */
      partialToggle.onchange = async () => {
        partialToggle.disabled = true;
        try {
          const out = await api(`/${encodeURIComponent(order.id)}/allow-partial`, { method: 'POST', body: { allow: partialToggle.checked } });
          renderDetail(out.order, invoice);
          load();
        } catch (error) { toast(error.message, true); partialToggle.checked = !partialToggle.checked; partialToggle.disabled = false; }
      };
    }
    const shipPartButton = $('#wo-ship-part');
    if (shipPartButton) {
      /**
       * Verzendt de ingevulde aantallen; wat minder is dan besteld blijft op backorder.
       * @returns {Promise<void>}
       */
      shipPartButton.onclick = async () => {
        const chosen = Array.from(box.querySelectorAll('.qty-now')).map((input) => ({ index: Number(input.dataset.line), qty: Number(input.value) || 0 }));
        shipPartButton.disabled = true;
        try {
          const trackingInput = $('#wo-tracking');
          const out = await api(`/${encodeURIComponent(order.id)}/ship`, { method: 'POST', body: { lines: chosen, trackingCode: trackingInput ? trackingInput.value : '' } });
          toast(out.complete ? `Bestelling ${out.order.number} is helemaal verzonden` : `Deellevering van ${out.order.number} verzonden; de rest staat op backorder`);
          open(order.id);
          load();
        } catch (error) { toast(error.message, true); shipPartButton.disabled = false; }
      };
    }
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
    const refundButton = $('#wo-refund');
    if (refundButton) {
      /**
       * Betaalt de geannuleerde bestelling terug via Mollie (na bevestiging; geld gaat echt terug).
       * @returns {Promise<void>}
       */
      refundButton.onclick = async () => {
        if (!confirm(`Bestelling ${order.number} via Mollie terugbetalen aan de klant? Dit kan niet ongedaan worden gemaakt.`)) return;
        refundButton.disabled = true;
        try {
          const out = await api(`/${encodeURIComponent(order.id)}/refund`, { method: 'POST', body: {} });
          toast(`Terugbetaald: ${euro(out.refund.amount)}`);
          open(order.id);
        } catch (error) { toast(error.message, true); refundButton.disabled = false; }
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
    const slipButton = $('#wo-slip');
    if (slipButton) {
      /**
       * Downloadt de pakbon van deze bestelling als PDF.
       * @returns {Promise<void>}
       */
      slipButton.onclick = async () => {
        slipButton.disabled = true;
        try { await window.BeheerTePicken.downloadPdf(`/${encodeURIComponent(order.id)}/packing-slip`, { method: 'POST', body: {} }); } catch (error) { toast(error.message, true); }
        slipButton.disabled = false;
      };
    }
    for (const button of box.querySelectorAll('[data-status]')) {
      /**
       * Zet de bestelling op de status van deze knop (annuleren na bevestiging).
       * @returns {Promise<void>}
       */
      button.onclick = async () => {
        if (button.dataset.status === 'geannuleerd' && !confirm(order.pay && order.pay.status === 'betaald' ? 'Bestelling annuleren? De reservering vervalt. Daarna kun je de betaling hier via Mollie terugbetalen.' : 'Bestelling annuleren? De reservering vervalt.')) return;
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
          <tr data-id="${esc(order.id)}" class="clickable"><td><a href="#bestellingen" data-open>${esc(order.number)}</a></td><td>${esc(when(order.createdAt))}</td><td>${esc(order.customerName)}</td><td>${esc(order.email)}</td><td class="num">${euro(order.total)}</td><td><span class="pill ${esc(order.status)}">${esc(order.statusLabel)}</span>${order.payStatus && order.payStatus !== 'betaald' && order.status === 'nieuw' ? ` <span class="muted small">${esc(PAY_LABELS[order.payStatus] || order.payStatus)}</span>` : ''}</td></tr>`).join('')}</tbody>`;
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
        { header: 'Afleveradres', key: 'street', width: 28 }, { header: 'Postcode', key: 'postcode', width: 10 }, { header: 'Plaats', key: 'city', width: 18 }, { header: 'Factuuradres (indien afwijkend)', key: 'billing', width: 40 },
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
          billing: order.deliverySame === false && order.billingAddress ? [order.billingAddress.street, `${order.billingAddress.postcode} ${order.billingAddress.city}`].filter(Boolean).join(', ') : '', street: order.address.street, postcode: order.address.postcode, city: order.address.city, excl: Math.round((order.total - vat) * 100) / 100, vat: Math.round(vat * 100) / 100, total: order.total, group: order.customerGroup === 'zakelijk' ? 'zakelijk' : 'particulier', vatNumber: order.vat ? order.vat.number : '', shifted: order.vat && order.vat.shifted ? 'ja' : '', shipping: order.shipping ? order.shipping.label : '', shippingPrice: order.shipping ? order.shipping.price : 0,
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
    // Een link naar één bestelling (bijvoorbeeld vanuit een omgezette offerte) opent direct het detail.
    const directId = new URLSearchParams(location.search).get('id');
    if (directId) open(directId);
  }

  window.BeheerBestellingen = { init, load };
})();
