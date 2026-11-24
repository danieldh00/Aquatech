// Werkorders: overzicht, een werkorder maken uit een geaccordeerde offerte,
// bewerken (planning, toewijzing, werkstappen afvinken, materialen
// verzamelen, oplevering) en exporteren als werkbon (afdrukversie via de
// browser, opslaan als PDF) of Excel. De server bewaart alles (/api/workorders);
// alleen beheerders en installateurs (recht 'werkorders') komen hier.
(function () {
  const WorkOrderCore = window.WorkOrderCore;
  const { $, esc, nl, eur, date, shortDate, hours, today, clock, LIB, FINISHED, state, toast, api } = window.Werkorders.common;
  const { printWorkOrder, exportWorkOrderXlsx, exportListXlsx, openHoursExport, runHoursExport } = window.Werkorders.createExports({ save: (extra) => save(extra), visible: () => visible(), designLine: (design) => designLine(design), zonesTable: (zones, className) => zonesTable(zones, className), headsTable: (heads, className) => headsTable(heads, className) });
  const { renderAppt, bindApptSend } = window.Werkorders.createAppointment({ save: (extra) => save(extra) });

  /**
   * Leest de parameters uit het adres van de pagina.
   * @returns {URLSearchParams} de queryparameters
   */
  const params = () => new URLSearchParams(location.search);
  /**
   * Gaat naar een ander scherm binnen de module (overzicht, werkorder of nieuw uit offerte).
   * @param {string} query nieuwe query zonder '?', leeg = overzicht
   */
  function go(query) {
    history.pushState(null, '', query ? `?${query}` : './');
    route();
  }

  // ---------- Overzicht ----------
  /**
   * Maakt de voortgangsbalk voor in het overzicht.
   * @param {{done: number, steps: number, pct: number}} progress voortgang van de werkstappen
   * @returns {string} HTML van de balk met teller
   */
  const progressBar = (progress) => `<span class="bar" title="${progress.done} van ${progress.steps} stappen klaar"><span style="width:${progress.pct}%"></span></span><span class="sub">${progress.done}/${progress.steps} stappen</span>`;
  const COLUMNS = [
    { key: 'number', label: 'Nummer', value: (workOrder) => workOrder.number, html: (workOrder) => `<b>${esc(workOrder.number)}</b>${workOrder.quoteNumber ? `<span class="sub">${esc(workOrder.quoteNumber)}</span>` : ''}` },
    { key: 'title', label: 'Klant en klus', value: (workOrder) => workOrder.customer || workOrder.title, html: (workOrder) => `${esc(workOrder.customer || '–')}${workOrder.customerId || FINISHED.includes(workOrder.status) ? '' : ' <span class="unlinked-mark">Niet gekoppeld</span>'}<span class="sub">${esc(workOrder.address || workOrder.title)}</span>`, cls: 'wrap' },
    { key: 'plannedDate', label: 'Gepland', value: (workOrder) => (workOrder.plannedDate ? `${workOrder.plannedDate} ${workOrder.startTime}` : '9999'), html: (workOrder) => (workOrder.plannedDate ? `${esc(shortDate(workOrder.plannedDate))}${workOrder.startTime ? `<span class="sub">${esc(workOrder.startTime)}${workOrder.endTime ? `–${esc(workOrder.endTime)}` : ''} uur${workOrder.days > 1 ? ` · ${workOrder.days} dagen` : ''}</span>` : ''}${workOrder.appointment && ['wacht', 'bevestigd', 'ander_moment'].includes(workOrder.appointment.state) ? `<span class="sub"><span class="pill appt-${esc(workOrder.appointment.state)}">${esc(WorkOrderCore.APPOINTMENT[workOrder.appointment.state])}</span></span>` : ''}` : '<span class="muted">Nog niet</span>') },
    { key: 'assignee', label: 'Uitvoerder', value: (workOrder) => (workOrder.assignee ? workOrder.assignee.displayName : ''), html: (workOrder) => esc(workOrder.assignee ? workOrder.assignee.displayName : '–') },
    { key: 'status', label: 'Status', value: (workOrder) => workOrder.status, html: (workOrder) => `<span class="pill wo-${esc(workOrder.status)}">${esc(WorkOrderCore.STATUSES[workOrder.status] || workOrder.status)}</span>${outsourcedLabel(workOrder)}` },
    { key: 'progress', label: 'Voortgang', value: (workOrder) => workOrder.progress.pct, html: (workOrder) => progressBar(workOrder.progress) },
    { key: 'hours', label: 'Uren', value: (workOrder) => workOrder.progress.hours, cls: 'num',
      html: (workOrder) => `${esc(hours(workOrder.progress.hours))}${workOrder.logged && workOrder.logged.minutes ? `<span class="sub" title="Geboekt door de ploeg">${esc(nl(workOrder.logged.minutes / 60))} u geboekt</span>` : ''}` },
    { key: 'updatedAt', label: 'Laatst gewijzigd', value: (workOrder) => workOrder.updatedAt, html: (workOrder) => esc(new Date(workOrder.updatedAt).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' })) },
  ];

  /**
   * Maakt de korte regel onder de status bij een uitbestede of aangenomen werkorder.
   * @param {object} workOrder de werkorder uit het overzicht
   * @returns {string} HTML, of leeg als hij niet is uitbesteed
   */
  function outsourcedLabel(workOrder) {
    const outsourcing = workOrder.outsourcing;
    if (!outsourcing) return '';
    const text = outsourcing.role === 'aangenomen' ? `Van ${outsourcing.partner}` : outsourcing.status === 'geaccepteerd' ? `Uitbesteed aan ${outsourcing.partner}` : 'Aangeboden aan anderen';
    return `<span class="sub">${esc(text)}</span>`;
  }

  /**
   * Geeft het verzoek dat init() al vooruit heeft gestart (tegelijk met api/me), of start het nu.
   * @param {string} key sleutel van het vooruit gestarte verzoek
   * @param {string} url pad na '../api/' als er niets klaarstaat
   * @returns {Promise<object>} het antwoord van de API
   */
  function take(key, url) {
    const prefetched = state.prefetch && state.prefetch[key];
    if (prefetched) { delete state.prefetch[key]; return prefetched; }
    return api(url);
  }

  /**
   * Haalt de werkorders op en toont het overzicht.
   * @returns {Promise<void>}
   */
  async function loadList() {
    try {
      const result = await take('list', 'workorders');
      state.items = result.items || [];
      if (window.AquatechCommon) window.AquatechCommon.truncationNotice(result, 'werkorders');
    } catch (error) {
      $('#l-table').innerHTML = `<tr><td class="empty">Kan de werkorders niet laden (${esc(error.message)}).</td></tr>`;
      return;
    }
    renderList();
  }

  /**
   * Filtert en sorteert de werkorders volgens zoekveld, status, vinkjes en gekozen kolom.
   * @returns {object[]} de zichtbare werkorders
   */
  function visible() {
    const search = $('#l-search').value.trim().toLowerCase();
    const status = $('#l-status').value;
    const mine = $('#l-mine').checked;
    const unlinkedOnly = $('#l-unlinked').checked;
    const done = $('#l-done').checked || FINISHED.includes(status);
    const sortColumn = COLUMNS.find((column) => column.key === state.sort.key) || COLUMNS[0];
    return state.items
      .filter((workOrder) => (status ? workOrder.status === status : done || !FINISHED.includes(workOrder.status)))
      .filter((workOrder) => !mine || workOrder.assigneeId === state.me.user.id)
      .filter((workOrder) => !unlinkedOnly || (!workOrder.customerId && workOrder.status !== 'geannuleerd'))
      .filter((workOrder) => !search || [workOrder.number, workOrder.title, workOrder.customer, workOrder.address, workOrder.quoteNumber, workOrder.assignee && workOrder.assignee.displayName].some((value) => String(value || '').toLowerCase().includes(search)))
      .sort((left, right) => {
        const leftValue = sortColumn.value(left), rightValue = sortColumn.value(right);
        const comparison = typeof leftValue === 'number' || typeof rightValue === 'number' ? (leftValue || 0) - (rightValue || 0) : String(leftValue || '').localeCompare(String(rightValue || ''), 'nl');
        return comparison * state.sort.dir;
      });
  }

  /** Toont de tellers en de tabel van het overzicht. */
  function renderList() {
    const items = visible();
    /**
     * Telt de werkorders met een status.
     * @param {string} status statussleutel
     * @returns {number} aantal
     */
    const count = (status) => state.items.filter((workOrder) => workOrder.status === status).length;
    const week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const soon = state.items.filter((workOrder) => !FINISHED.includes(workOrder.status) && workOrder.plannedDate && workOrder.plannedDate >= today() && workOrder.plannedDate <= week).length;
    $('#l-stats').innerHTML = [
      [count('open'), 'nieuw, nog niet gepland'],
      [count('gepland'), 'gepland'],
      [soon, 'de komende 7 dagen'],
      [count('bezig'), 'in uitvoering'],
      [count('gereed'), 'gereed'],
    ].map(([value, label]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
    $('#l-stats').hidden = !state.items.length;
    // Werkorders zonder klantrecord zichtbaar maken (alleen voor wie klanten mag koppelen).
    const unlinked = state.items.filter((workOrder) => !workOrder.customerId && workOrder.status !== 'geannuleerd').length;
    const canLink = (state.me.rights || []).includes('klanten');
    $('#l-unlinked-wrap').hidden = !unlinked;
    $('#l-unlinked-count').textContent = unlinked;
    if (!unlinked) $('#l-unlinked').checked = false;
    $('#l-link').hidden = !unlinked || !canLink;
    const table = $('#l-table');
    if (!state.items.length) {
      table.innerHTML = '<tr><td class="empty">Nog geen werkorders. Kies <b>Nieuwe werkorder uit offerte</b>, of open een geaccordeerde offerte en kies daar <b>Werkorder maken</b>.</td></tr>';
      $('#l-count').textContent = '';
      return;
    }
    const head = COLUMNS.map((column) => {
      const sorted = column.key === state.sort.key ? (state.sort.dir > 0 ? ' asc' : ' desc') : '';
      return `<th data-sort="${column.key}" class="${column.cls === 'num' ? 'num' : ''}${sorted}">${esc(column.label)}</th>`;
    }).join('');
    table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${items.map((workOrder) => `
      <tr data-id="${esc(workOrder.id)}">${COLUMNS.map((column) => `<td class="${column.cls || ''}">${column.html(workOrder)}</td>`).join('')}</tr>`).join('')
      || `<tr><td class="empty" colspan="${COLUMNS.length}">Geen werkorders gevonden.</td></tr>`}</tbody>`;
    table.querySelectorAll('th[data-sort]').forEach((header) => {
      /** Sorteert op deze kolom (nogmaals klikken draait de volgorde om). */
      header.onclick = () => {
        const key = header.dataset.sort;
        state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (['updatedAt', 'progress', 'hours'].includes(key) ? -1 : 1) };
        renderList();
      };
    });
    table.querySelectorAll('tr[data-id]').forEach((row) => {
      /** Opent de werkorder. */
      row.onclick = () => { go(`id=${encodeURIComponent(row.dataset.id)}`); };
    });
    $('#l-count').textContent = `${items.length} van ${state.items.length} werkorders`;
  }

  // ---------- Nieuwe werkorder ----------
  /**
   * Haalt een plan op voor de zones van de werkorder.
   * @param {string} planId id van het plan
   * @returns {Promise<object|null>} het plan, of null als het er niet (meer) is
   */
  async function loadPlan(planId) {
    if (!planId) return null;
    try {
      return await api(`plans/${encodeURIComponent(planId)}`);
    } catch (error) {
      return null;
    }
  }

  /**
   * Maakt een nieuwe werkorder uit een geaccordeerde offerte en opent die.
   * @param {string} quoteId id van de offerte
   * @returns {Promise<void>}
   */
  async function createFromQuote(quoteId) {
    let quote;
    try {
      quote = await api(`quotes/${encodeURIComponent(quoteId)}`);
    } catch (error) {
      toast(`Kan de offerte niet laden: ${error.message}`, true);
      return go('');
    }
    if (quote.status !== 'akkoord') {
      toast(`Offerte ${quote.number} heeft nog geen akkoord; een werkorder kan pas na akkoord.`, true);
      return go('');
    }
    const plan = await loadPlan(quote.data && quote.data.planId);
    const built = WorkOrderCore.fromQuote(quote, plan && plan.data, plan ? LIB() : null);
    // JSON: delen komen uit de plannerbibliotheken (andere objecten dan gewone data).
    const data = JSON.parse(JSON.stringify(built.data));
    if (quote.data && quote.data.planId && !plan) built.warnings.unshift('Het plan bij deze offerte is niet meer te openen; de zone-indeling ontbreekt.');
    try {
      const workOrder = await api('workorders', { method: 'POST', body: { quoteId: quote.id, data } });
      state.warnings = built.warnings;
      history.replaceState(null, '', `?id=${encodeURIComponent(workOrder.id)}`);
      openWorkOrder(workOrder);
      toast(`Werkorder ${workOrder.number} aangemaakt uit offerte ${quote.number}`);
    } catch (error) {
      toast(`Werkorder aanmaken mislukt: ${error.message}`, true);
      go('');
    }
  }

  /**
   * Toont het venster om een geaccordeerde offerte te kiezen voor een nieuwe werkorder.
   * @returns {Promise<void>}
   */
  async function pickQuote() {
    const modal = $('#quote-picker');
    const list = $('#qp-list');
    list.innerHTML = '<p class="muted small">Laden…</p>';
    modal.hidden = false;
    let quotes = [];
    try {
      const [quoteResult, workOrderResult] = await Promise.all([api('quotes?all=1'), api('workorders')]);
      state.items = workOrderResult.items || [];
      quotes = (quoteResult.items || []).filter((quote) => quote.status === 'akkoord');
    } catch (error) {
      list.innerHTML = `<p class="err">Kan de offertes niet laden (${esc(error.message)}).</p>`;
      return;
    }
    /** Toont de offertes die bij de zoekterm passen. */
    const render = () => {
      const search = $('#qp-search').value.trim().toLowerCase();
      const items = quotes.filter((quote) => !search || [quote.number, quote.title, quote.customer].some((value) => String(value || '').toLowerCase().includes(search)));
      list.innerHTML = items.map((quote) => {
        const has = state.items.filter((workOrder) => workOrder.quoteId === quote.id);
        return `<button data-quote="${esc(quote.id)}"${has.length ? ' class="has"' : ''}><b>${esc(quote.number)} · ${esc(quote.customer || 'Geen klant')}</b>
          <span class="sub">${esc(quote.title)} · ${esc(eur(quote.totalExcl))} excl. btw · akkoord, gewijzigd ${esc(shortDate(quote.updatedAt))}</span>
          ${has.length ? `<span class="sub warn-text">Heeft al ${has.length === 1 ? 'werkorder' : 'werkorders'} ${esc(has.map((workOrder) => workOrder.number).join(', '))}</span>` : ''}
        </button>`;
      }).join('') || `<p class="muted">${quotes.length ? 'Geen offertes gevonden.' : 'Er zijn nog geen offertes met status Akkoord. Zet in de module <a href="../offertes/">Offertes</a> een offerte op Akkoord, of wacht op het akkoord van de klant.'}</p>`;
      list.querySelectorAll('[data-quote]').forEach((button) => {
        /** Sluit het venster en maakt de werkorder uit deze offerte (na een vraag als er al een is). */
        button.onclick = () => {
          if (button.classList.contains('has') && !confirm('Voor deze offerte bestaat al een werkorder. Toch een nieuwe maken (bijvoorbeeld voor een tweede fase)?')) return;
          modal.hidden = true;
          go(`quote=${encodeURIComponent(button.dataset.quote)}`);
        };
      });
    };
    $('#qp-search').value = '';
    $('#qp-search').oninput = render;
    render();
    $('#qp-search').focus();
  }

  // ---------- Bewerken ----------
  /**
   * Leest een waarde uit een object via een pad met punten.
   * @param {object} obj het object
   * @param {string} path bijv. 'customer.name'
   * @returns {*} de waarde, of undefined als een deel ontbreekt
   */
  const getPath = (obj, path) => path.split('.').reduce((current, key) => (current == null ? current : current[key]), obj);
  /**
   * Zet een waarde in een object via een pad met punten (tussenobjecten worden aangemaakt).
   * @param {object} obj het object
   * @param {string} path bijv. 'customer.name'
   * @param {*} value de nieuwe waarde
   */
  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((current, key) => (current[key] = current[key] && typeof current[key] === 'object' ? current[key] : {}), obj);
    target[last] = value;
  }

  /**
   * Opent een werkorder in de editor.
   * @param {string} id id van de werkorder
   * @returns {Promise<void>}
   */
  async function loadWorkOrder(id) {
    try {
      openWorkOrder(await take(`wo:${id}`, `workorders/${encodeURIComponent(id)}`));
    } catch (error) {
      toast(`Kan de werkorder niet openen: ${error.message}`, true);
      go('');
    }
  }

  /** Toont of de werkorder is uitbesteed aan of aangenomen van een andere organisatie (zie ../uitbesteden/). */
  function renderOutsourcing() {
    const workOrder = state.workOrder;
    const outsourcing = workOrder.outsourcing;
    const element = $('#e-outsourced');
    const link = state.outsource ? ' <a href="../uitbesteden/">Naar Uitbesteden</a>' : '';
    let html = '';
    if (outsourcing && outsourcing.role === 'aangenomen') {
      html = `<b>Aangenomen van ${esc(outsourcing.partner)}.</b> ${esc(outsourcing.partner)} ziet de status, de planning en de afgevinkte stappen van deze werkorder.${outsourcing.fee != null ? ` Afgesproken vergoeding: ${esc(eur(outsourcing.fee))} excl. btw.` : ''}${outsourcing.message ? `<br><span class="muted">“${esc(outsourcing.message)}”</span>` : ''}${link}`;
    } else if (outsourcing && outsourcing.status === 'geaccepteerd') {
      const execution = outsourcing.execution;
      const stand = !execution ? '' : execution.removed ? ' De werkorder is daar verwijderd.' : ` Daar: ${esc(WorkOrderCore.STATUSES[execution.status] || execution.status)}${execution.plannedDate ? `, gepland ${esc(date(execution.plannedDate))}` : ''}, ${execution.progress.done}/${execution.progress.steps} stappen klaar${execution.completedOn ? `, opgeleverd ${esc(date(execution.completedOn))}` : ''}.`;
      html = `<b>Uitbesteed aan ${esc(outsourcing.partner)}.</b>${stand}${link}`;
    } else if (outsourcing) {
      html = `<b>Aangeboden${outsourcing.direct && outsourcing.partner ? ` aan ${esc(outsourcing.partner)}` : ' aan andere organisaties'}</b>, nog niet aangenomen.${link}`;
    }
    element.innerHTML = html;
    element.hidden = !html;
    $('#e-menu [data-act=outsource]').hidden = !state.outsource || Boolean(outsourcing) || !['open', 'gepland'].includes(workOrder.status);
  }

  /**
   * Opent een werkorder in de editor en vult alle onderdelen.
   * @param {object} workOrder de werkorder van de server
   */
  function openWorkOrder(workOrder) {
    workOrder.data = WorkOrderCore.sanitize(workOrder.data);
    state.workOrder = workOrder;
    state.dirty = false;
    $('#list-view').hidden = true;
    $('#edit-view').hidden = false;
    $('#e-heading').textContent = `Werkorder ${workOrder.number}`;
    document.title = `Werkorder ${workOrder.number} – AquaTech Service`;
    $('#e-status').value = workOrder.status;
    $('#e-saved').textContent = workOrder.cachedAt ? `Offline · gegevens van ${new Date(workOrder.cachedAt).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })}` : '';
    renderAssignee(workOrder);
    renderCustomer(workOrder);
    document.querySelectorAll('#edit-view [data-f]').forEach((field) => {
      const value = getPath(workOrder.data, field.dataset.f);
      field.value = value == null ? '' : value;
    });
    const data = workOrder.data;
    $('#e-links').innerHTML = [
      data.quoteId ? `Uit offerte <a href="../offertes/?id=${encodeURIComponent(data.quoteId)}">${esc(data.quoteNumber || 'offerte')}</a>` : '',
      data.planId ? `plan <a href="../beregening/?plan=${encodeURIComponent(data.planId)}">${esc(data.planTitle || 'beregeningsplan')}</a>` : '',
    ].filter(Boolean).join(' · ');
    $('#e-menu [data-act=openquote]').hidden = !data.quoteId;
    $('#e-menu [data-act=invoice]').hidden = !state.invoices || workOrder.status === 'geannuleerd';
    $('#e-menu [data-act=openplan]').hidden = !data.planId;
    $('#e-menu [data-act=rezones]').hidden = !data.planId;
    $('#e-menu [data-act=rematerials]').hidden = !data.quoteId;
    $('#e-menu [data-act=purge]').hidden = !state.admin;
    renderOutsourcing();
    renderRoute();
    renderAppt();
    renderWarnings();
    renderDesign();
    renderSteps();
    renderMaterials();
    renderProgress();
    if (window.WorkOrderPhotos) window.WorkOrderPhotos.open(workOrder, { toast, statusOf: () => $('#e-status').value });
    if (window.WorkOrderStock) window.WorkOrderStock.open(workOrder, { toast, manage: (state.me.rights || []).includes('voorraad') });
    if (window.WorkLog) window.WorkLog.open(workOrder, { toast, staff: () => state.staff });
    if (window.WorkOrderCosting) window.WorkOrderCosting.open(workOrder, { toast, allowed: (state.me.rights || []).includes('nacalculatie') && window.AquatechModuleTools.isOn(state.moduleFlags, 'nacalculatie') });
    // ?id=…#fotos (startscherm): meteen naar de foto's.
    if (location.hash === '#fotos') $('#ph-card').scrollIntoView();
    else window.scrollTo(0, 0);
  }

  /** Toont de link met de route naar het adres (opent de kaart van het apparaat). */
  function renderRoute() {
    const address = state.workOrder.data.customer.address.trim();
    $('#e-route').innerHTML = address ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.replace(/\n/g, ', '))}" target="_blank" rel="noopener">Route naar dit adres</a>` : '';
  }

  /**
   * Vult de keuzelijst met de uitvoerder.
   * @param {object} workOrder de werkorder
   */
  function renderAssignee(workOrder) {
    const select = $('#e-assignee');
    const options = state.staff.slice();
    if (workOrder.assignee && !options.some((user) => user.id === workOrder.assignee.id)) options.push({ ...workOrder.assignee, gone: true });
    select.innerHTML = '<option value="">Nog niet toegewezen</option>' + options
      .map((user) => `<option value="${esc(user.id)}">${esc(user.displayName)}${user.gone ? ' – uitgeschakeld' : ''}</option>`).join('');
    select.value = workOrder.assigneeId || '';
  }

  // ---------- Klantrecord koppelen ----------
  /**
   * Toont de klantkeuze (alleen met het recht klanten) en welke klant er gekoppeld is.
   * @param {object} workOrder de werkorder
   */
  function renderCustomer(workOrder) {
    const allowed = (state.me.rights || []).includes('klanten');
    $('#e-cust-pick').hidden = !allowed;
    if (!allowed) return;
    const account = workOrder.customerAccount;
    $('#e-cust-chosen').hidden = !account;
    $('#e-cust-none').hidden = Boolean(account);
    $('#e-cust-search').value = '';
    $('#e-cust-list').hidden = true;
    if (account) {
      $('#e-cust-name').textContent = account.companyName || account.displayName;
      $('#e-cust-card').href = `../klanten/?id=${encodeURIComponent(account.id)}`;
    }
  }

  /**
   * Zoekt klanten op de server en toont de eerste 20 onder het zoekveld.
   * @returns {Promise<void>}
   */
  async function searchCustomers() {
    const search = $('#e-cust-search').value.trim();
    const ticket = (state.customerTicket = (state.customerTicket || 0) + 1);
    let items = [];
    try {
      items = ((await api(`workorder-customers?q=${encodeURIComponent(search)}`)) || {}).items || [];
    } catch (error) {
      toast(error.message, true);
      return;
    }
    if (ticket !== state.customerTicket) return;
    state.customerHits = items;
    const list = $('#e-cust-list');
    list.innerHTML = items.length
      ? items.map((customer, index) => `<li role="option" data-i="${index}"><b>${esc(customer.companyName || customer.displayName)}</b>`
        + `<span class="sub">${esc([customer.companyName ? customer.displayName : '', (customer.address || '').replace(/\n/g, ', '), customer.email].filter(Boolean).join(' · ') || customer.username)}</span></li>`).join('')
      : '<li class="none">Geen klanten gevonden.</li>';
    list.hidden = false;
    $('#e-cust-search').setAttribute('aria-expanded', 'true');
  }

  /**
   * Koppelt de werkorder aan de gekozen klant en vult naam, contactpersoon, adres, e-mail en telefoon in.
   * @param {object} customer de gekozen klant uit de zoekresultaten
   * @returns {Promise<void>}
   */
  async function pickCustomer(customer) {
    const workOrder = state.workOrder;
    if (!workOrder || !customer) return;
    const fields = {
      'customer.name': customer.companyName || customer.displayName,
      'customer.contact': customer.companyName ? customer.displayName : '',
      'customer.address': customer.address || '',
      'customer.email': customer.email || '',
      'customer.phone': customer.phone || '',
    };
    for (const [path, value] of Object.entries(fields)) {
      setPath(workOrder.data, path, value);
      const input = document.querySelector(`#edit-view [data-f="${path}"]`);
      if (input) input.value = value;
    }
    workOrder.customerId = customer.id;
    workOrder.customerAccount = { id: customer.id, displayName: customer.displayName, companyName: customer.companyName || '' };
    state.dirty = true;
    renderCustomer(workOrder);
    renderRoute();
    await save({ customerId: customer.id });
  }

  /** Toont de waarschuwingen bij het opbouwen uit het plan. */
  function renderWarnings() {
    const warnings = state.warnings || [];
    $('#e-warnings').hidden = !warnings.length;
    $('#e-warnings').innerHTML = warnings.length ? `<b>Let op bij het plan:</b><ul>${warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul>` : '';
  }

  /**
   * Vat het ontwerp samen in één regel.
   * @param {object} design ontwerpgegevens (gazon, sproeiers, zones, druk, debiet, leiding, uitvoering)
   * @returns {string} de samenvatting, of leeg
   */
  function designLine(design) {
    if (!design) return '';
    return [design.lawnM2 ? `${nl(design.lawnM2, 0)} m² gazon` : '', design.sprinklers ? `${design.sprinklers} sproeiers` : '', design.zones ? `${design.zones} zones` : '',
      design.pressureBar ? `waterdruk ${nl(design.pressureBar, 1)} bar` : '', design.flowM3h ? `debiet ${nl(design.flowM3h, 1)} m³/u` : '',
      design.mainPipe ? `hoofdleiding ${design.mainPipe}` : '', design.level ? `uitvoering ${design.level}` : ''].filter(Boolean).join(' · ');
  }

  /**
   * Maakt de tabel met de zone-indeling.
   * @param {object[]} zones de zones
   * @param {string} className CSS-klassen van de tabel
   * @returns {string} HTML van de tabel, of leeg zonder zones
   */
  function zonesTable(zones, className) {
    if (!zones.length) return '';
    return `<table class="${className}"><thead><tr><th>Zone</th><th>Soort</th><th>Onderdelen</th><th class="num">Debiet</th><th class="num">Leiding</th><th class="num">Druk laatste kop</th></tr></thead>
      <tbody>${zones.map((zone) => `<tr${zone.ok ? '' : ' class="bad"'}><td><b>${esc(zone.name)}</b></td><td>${esc(zone.kind)}</td><td>${esc(zone.parts)}</td>
        <td class="num">${nl(zone.flowLph / 1000, 2)} m³/u</td><td class="num">${nl(zone.pipeM, 0)} m</td>
        <td class="num">${nl(zone.pressureBar, 1)} bar${zone.ok ? '' : ` (min. ${nl(zone.requiredBar, 1)})`}</td></tr>`).join('')}</tbody></table>`;
  }

  /**
   * Maakt de tabel met de afstelling per sproeikop: zo regelt de installateur elke kop in zoals ontworpen.
   * @param {object[]} heads de sproeikoppen
   * @param {string} className CSS-klassen van de tabel
   * @returns {string} HTML van de tabel, of leeg zonder koppen
   */
  function headsTable(heads, className) {
    if (!heads || !heads.length) return '';
    return `<table class="${className}"><thead><tr><th class="num">Nr</th><th>Zone</th><th>Kop</th><th>Sector</th><th class="num">Sproeihoek</th><th class="num">Worp</th><th>Linkerrand</th><th class="num">Plek (x, y)</th></tr></thead>
      <tbody>${heads.map((head) => `<tr><td class="num">${head.nr}</td><td>${esc(head.zone)}</td><td>${esc(head.nozzle || head.kind)}${head.body ? `<br><span class="small">${esc(head.body)}</span>` : ''}</td><td>${esc(head.sector)}</td>
        <td class="num">${head.kind === 'Strook' || !head.arc ? '' : `${head.arc}°`}</td><td class="num">${head.nozzle === 'Strook' ? '' : `${nl(head.r, 1)} m`}</td><td>${esc(head.leftText)}</td>
        <td class="num">${nl(head.x, 1)}; ${nl(head.y, 1)} m</td></tr>`).join('')}</tbody></table>`;
  }

  /** Toont het ontwerp: samenvatting, zones en afstelling van de koppen. */
  function renderDesign() {
    const data = state.workOrder.data;
    const line = designLine(data.design);
    $('#e-design-card').hidden = !line && !data.zones.length && !(data.heads || []).length;
    $('#e-design').innerHTML = `${line ? `<p class="design-line">${esc(line)}</p>` : ''}${zonesTable(data.zones, 'lines zones')}`
      + ((data.heads || []).length ? `<h3>Afstelling sproeikoppen</h3><p class="hint small">Linkerrand = begin van de sproeihoek op de tekening (0° = rechts, met de klok mee); de sector loopt vandaar met de klok mee. Nummers zoals in de stuklijst van het plan.</p>${headsTable(data.heads, 'lines heads')}` : '');
  }

  /**
   * Maakt de tabelregel voor een werkstap.
   * @param {object} step de werkstap
   * @returns {string} HTML van de regel
   */
  function stepRow(step) {
    return `<tr class="line${step.done ? ' done' : ''}" data-step="${esc(step.id)}">
      <td class="c-chk"><input type="checkbox" data-s="done"${step.done ? ' checked' : ''} aria-label="Klaar"></td>
      <td class="c-desc"><input data-s="title" value="${esc(step.title)}" maxlength="300" placeholder="Werkstap">
        <input data-s="details" class="details" value="${esc(step.details)}" maxlength="2000" placeholder="Toelichting (optioneel)"></td>
      <td class="c-qty"><input data-s="hours" class="num" type="number" min="0" step="0.25" value="${step.hours || ''}" aria-label="Geplande uren" placeholder="–"></td>
      <td class="c-qty"><input data-s="actualHours" class="num" type="number" min="0" step="0.25" value="${step.actualHours ?? ''}" aria-label="Werkelijke uren" placeholder="–"></td>
      <td class="c-del"><button class="btn ghost icon" data-del-step title="Stap verwijderen">✕</button></td>
    </tr>`;
  }

  /** Toont de werkstappen per fase. */
  function renderSteps() {
    const data = state.workOrder.data;
    $('#e-steps').innerHTML = `<table class="lines steps">
      <thead><tr><th></th><th>Werkstap</th><th class="num">Gepland</th><th class="num">Werkelijk</th><th></th></tr></thead>
      <tbody>${Object.entries(WorkOrderCore.PHASES).map(([key, label]) => `
        <tr class="section"><td colspan="5">${esc(label)}</td></tr>
        ${data.steps.filter((step) => step.phase === key).map(stepRow).join('')}
        <tr class="add"><td colspan="5"><button class="btn small" data-add-step="${key}">+ Stap ${esc(label.toLowerCase())}</button></td></tr>`).join('')}
      </tbody></table>`;
  }

  /**
   * Maakt de tabelregel voor een materiaal.
   * @param {object} material het materiaal
   * @returns {string} HTML van de regel
   */
  function materialRow(material) {
    // Code van een hoofdartikel: eerst een maat (variant) kiezen; bij een variant kan een andere maat.
    const picker = window.ArticlePicker;
    const parent = picker && material.code ? picker.parentOf(material.code) : null;
    const variantOf = picker && material.code && !parent ? picker.parentOfVariant(material.code) : null;
    const choose = parent ? '<button class="btn small primary ap-variant" data-pick-variant title="Dit artikel heeft varianten: kies de maat">Kies maat</button>'
      : variantOf ? '<button class="btn small ghost ap-variant" data-pick-variant title="Een andere variant van dit artikel kiezen">Andere maat</button>' : '';
    return `<tr class="line${material.picked ? ' done' : ''}" data-mat="${esc(material.id)}">
      <td class="c-chk"><input type="checkbox" data-m="picked"${material.picked ? ' checked' : ''} aria-label="Verzameld"></td>
      <td class="c-desc"><input data-m="description" value="${esc(material.description)}" maxlength="500" placeholder="Omschrijving">${material.code ? `<span class="code">${esc(material.code)}</span>` : ''}${choose}</td>
      <td class="c-qty"><input data-m="qty" class="num" type="number" step="any" value="${material.qty}" aria-label="Aantal"></td>
      <td class="c-unit"><input data-m="unit" value="${esc(material.unit)}" maxlength="12" aria-label="Eenheid"></td>
      <td class="c-del"><button class="btn ghost icon" data-del-mat title="Regel verwijderen">✕</button></td>
    </tr>`;
  }

  /** Toont de materiaallijst. */
  function renderMaterials() {
    const data = state.workOrder.data;
    // De artikellijst (voor "Kies maat") één keer ophalen; daarna de lijst opnieuw tekenen.
    if (window.ArticlePicker && !state.articlesRequested) {
      state.articlesRequested = true;
      window.ArticlePicker.load('../').then((articles) => { if (articles.length && state.workOrder) renderMaterials(); });
    }
    $('#e-materials').innerHTML = `<table class="lines mats">
      <thead><tr><th></th><th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th><th></th></tr></thead>
      <tbody>${data.materials.map(materialRow).join('') || '<tr><td colspan="5" class="muted">Geen materialen.</td></tr>'}
        <tr class="add"><td colspan="5"><button class="btn small" data-add-mat>+ Materiaal</button>
          ${window.ArticlePicker ? '<button class="btn small" data-pick-article title="Kies een artikel uit de voorraad, daarna de maat">+ Uit voorraad</button>' : ''}
          <button class="btn small" data-pick-all>Alles verzameld</button></td></tr>
      </tbody></table>`;
  }

  /** Toont de voortgang van stappen, uren en materialen. */
  function renderProgress() {
    const progress = WorkOrderCore.progress(state.workOrder.data);
    $('#e-progress').innerHTML = `<div class="bar big"><span style="width:${progress.pct}%"></span></div>
      <span class="muted small">${progress.done} van ${progress.steps} stappen klaar · ${progress.picked} van ${progress.materials} materialen verzameld</span>`;
    $('#e-hours').textContent = `Gepland ${hours(progress.hours)} · werkelijk ${hours(progress.actualHours)}`;
    $('#e-picked').textContent = `${progress.picked} van ${progress.materials} verzameld`;
  }

  /** Markeert de werkorder als gewijzigd en slaat na een korte pauze op. */
  function changed() {
    state.dirty = true;
    $('#e-saved').textContent = 'Wijzigingen…';
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(save, 1000);
  }

  /**
   * Slaat de werkorder op (wacht op een lopende opslag); zonder verbinding komt de wijziging in de wachtrij.
   * @param {object} extra extra velden voor de server, zoals status of assigneeId
   * @returns {Promise<void>|undefined} de lopende opslag
   */
  async function save(extra = {}) {
    clearTimeout(state.saveTimer);
    const workOrder = state.workOrder;
    if (!workOrder) return;
    if (state.saving) await state.saving;
    if (!state.dirty && !Object.keys(extra).length) return;
    state.dirty = false;
    $('#e-saved').textContent = 'Opslaan…';
    state.saving = (async () => {
      try {
        const result = await api(`workorders/${encodeURIComponent(workOrder.id)}`, {
          method: 'PUT', body: { data: workOrder.data, ...extra },
          // Op locatie zonder bereik: bewaren op het toestel en later versturen.
          offline: { key: `wo:${workOrder.id}`, label: `Werkorder ${workOrder.number}`, base: workOrder.updatedAt, patch: true },
        });
        if (result.queued) {
          if (state.workOrder === workOrder) {
            if (extra.status) workOrder.status = extra.status;
            $('#e-saved').textContent = 'Bewaard op dit toestel · wordt verstuurd zodra er verbinding is';
          }
          return;
        }
        if (state.workOrder === workOrder) {
          workOrder.updatedAt = result.updatedAt;
          workOrder.status = result.status;
          workOrder.assigneeId = result.assigneeId;
          workOrder.assignee = result.assignee;
          workOrder.customerId = result.customerId;
          workOrder.customerAccount = result.customerAccount;
          renderCustomer(workOrder);
          workOrder.appointment = result.appointment;
          workOrder.share = result.share;
          renderAppt();
          $('#e-status').value = result.status;
          // Reservering en afboeking volgen de materiaallijst en de status.
          if (window.WorkOrderStock) window.WorkOrderStock.refresh(workOrder);
          $('#e-saved').textContent = `Opgeslagen ${clock(new Date().toISOString())}`;
        }
      } catch (error) {
        state.dirty = true;
        $('#e-saved').textContent = 'Niet opgeslagen';
        toast(`Opslaan mislukt: ${error.message}`, true);
      } finally {
        state.saving = null;
      }
    })();
    return state.saving;
  }

  /**
   * Maakt een nieuw, uniek id voor een stap of materiaal.
   * @param {string} prefix eerste letter ('s' of 'm')
   * @returns {string} het id
   */
  const newId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /** Koppelt de invoer, knoppen en het menu van de editor. */
  function bindEditor() {
    const view = $('#edit-view');
    view.addEventListener('input', (event) => {
      const workOrder = state.workOrder;
      if (!workOrder) return;
      const target = event.target;
      if (target.dataset.f) {
        setPath(workOrder.data, target.dataset.f, target.dataset.f === 'days' ? Math.max(1, Math.min(WorkOrderCore.MAX_DAYS, Math.round(Number(target.value) || 1))) : target.value);
        if (target.dataset.f === 'customer.address') renderRoute();
        // Starttijd zonder eindtijd: het blok volgt uit de geplande uren
        // (meer dan een werkdag = verdeeld over meer werkdagen).
        if (target.dataset.f === 'startTime' && target.value && !workOrder.data.endTime) {
          const fit = WorkOrderCore.fitHours(target.value, WorkOrderCore.progress(workOrder.data).hours);
          if (fit) {
            workOrder.data.endTime = fit.endTime;
            workOrder.data.days = fit.days;
            $('[data-f="endTime"]').value = fit.endTime;
            $('[data-f="days"]').value = fit.days;
          }
        }
        // Een datum geven aan een nieuwe werkorder = ingepland.
        if (target.dataset.f === 'plannedDate' && target.value && workOrder.status === 'open') {
          $('#e-status').value = 'gepland';
          return save({ status: 'gepland' }).then(() => {});
        }
        return changed();
      }
      const row = target.closest('[data-step], [data-mat]');
      if (!row) return;
      if (target.dataset.s) {
        const step = workOrder.data.steps.find((candidate) => candidate.id === row.dataset.step);
        if (!step) return;
        const key = target.dataset.s;
        if (key === 'done') { step.done = target.checked; row.classList.toggle('done', step.done); }
        else if (key === 'hours') step.hours = Number(target.value) || 0;
        else if (key === 'actualHours') step.actualHours = target.value === '' ? null : Number(target.value) || 0;
        else step[key] = target.value;
        renderProgress();
        // Eerste afgevinkte stap: de klus is begonnen.
        if (key === 'done' && step.done && ['open', 'gepland'].includes(workOrder.status)) {
          $('#e-status').value = 'bezig';
          return save({ status: 'bezig' });
        }
        return changed();
      }
      if (target.dataset.m) {
        const material = workOrder.data.materials.find((candidate) => candidate.id === row.dataset.mat);
        if (!material) return;
        const key = target.dataset.m;
        if (key === 'picked') { material.picked = target.checked; row.classList.toggle('done', material.picked); }
        else if (key === 'qty') material.qty = Number(target.value) || 0;
        else material[key] = target.value;
        renderProgress();
        return changed();
      }
    });
    view.addEventListener('click', (event) => {
      const workOrder = state.workOrder;
      if (!workOrder) return;
      const addStep = event.target.closest('[data-add-step]');
      if (addStep) {
        const phase = addStep.dataset.addStep;
        const step = WorkOrderCore.sanitizeStep({ id: newId('s'), phase });
        let at = -1;
        workOrder.data.steps.forEach((existing, i) => { if (existing.phase === phase) at = i; });
        workOrder.data.steps.splice(at < 0 ? workOrder.data.steps.length : at + 1, 0, step);
        renderSteps();
        renderProgress();
        const input = $(`[data-step="${step.id}"] [data-s=title]`);
        if (input) input.focus();
        return changed();
      }
      const delStep = event.target.closest('[data-del-step]');
      if (delStep) {
        const id = delStep.closest('[data-step]').dataset.step;
        workOrder.data.steps = workOrder.data.steps.filter((step) => step.id !== id);
        renderSteps();
        renderProgress();
        return changed();
      }
      if (event.target.closest('[data-add-mat]')) {
        const material = WorkOrderCore.sanitizeMaterial({ id: newId('m'), qty: 1, unit: 'st' });
        workOrder.data.materials.push(material);
        renderMaterials();
        renderProgress();
        const input = $(`[data-mat="${material.id}"] [data-m=description]`);
        if (input) input.focus();
        return changed();
      }
      if (event.target.closest('[data-pick-article]')) {
        window.ArticlePicker.open({
          base: '../',
          /**
           * Zet het gekozen artikel (of de gekozen variant) als materiaal op de werkorder.
           * @param {object} article code, name en unit
           */
          onPick: (article) => {
            if (state.workOrder !== workOrder) return;
            workOrder.data.materials.push(WorkOrderCore.sanitizeMaterial({ id: newId('m'), code: article.code, description: article.name, qty: 1, unit: article.unit || 'st' }));
            renderMaterials();
            renderProgress();
            changed();
          },
        });
        return undefined;
      }
      const pickVariant = event.target.closest('[data-pick-variant]');
      if (pickVariant) {
        const material = workOrder.data.materials.find((candidate) => candidate.id === pickVariant.closest('[data-mat]').dataset.mat);
        if (!material) return undefined;
        const parent = window.ArticlePicker.parentOf(material.code) || window.ArticlePicker.parentOfVariant(material.code);
        window.ArticlePicker.open({
          base: '../', parentCode: parent ? parent.code : '', variantCode: material.code,
          /**
           * Vervangt de regel door de gekozen variant (aantal blijft).
           * @param {object} article code, name en unit
           */
          onPick: (article) => {
            if (state.workOrder !== workOrder) return;
            // Een andere maat is een ander artikel: het is nog niet verzameld.
            if (material.code !== article.code) material.picked = false;
            material.code = article.code;
            material.description = article.name;
            if (article.unit) material.unit = article.unit;
            renderMaterials();
            renderProgress();
            changed();
          },
        });
        return undefined;
      }
      if (event.target.closest('[data-pick-all]')) {
        const all = workOrder.data.materials.every((material) => material.picked);
        workOrder.data.materials.forEach((material) => { material.picked = !all; });
        renderMaterials();
        renderProgress();
        return changed();
      }
      const delMat = event.target.closest('[data-del-mat]');
      if (delMat) {
        const id = delMat.closest('[data-mat]').dataset.mat;
        workOrder.data.materials = workOrder.data.materials.filter((material) => material.id !== id);
        renderMaterials();
        renderProgress();
        return changed();
      }
    });
    /**
     * Slaat een andere status op; bij Gereed wordt de opleverdatum ingevuld.
     * @param {Event} event de wijziging
     */
    $('#e-status').onchange = (event) => {
      const workOrder = state.workOrder;
      if (event.target.value === 'gereed' && !workOrder.data.report.completedOn) {
        workOrder.data.report.completedOn = today();
        $('[data-f="report.completedOn"]').value = workOrder.data.report.completedOn;
        state.dirty = true;
      }
      save({ status: event.target.value });
    };
    /**
     * Slaat de gekozen uitvoerder op.
     * @param {Event} event de wijziging
     */
    $('#e-assignee').onchange = (event) => { save({ assigneeId: event.target.value || null }); };
    /**
     * Slaat op en gaat terug naar de herkomst of het overzicht.
     * @returns {Promise<void>}
     */
    $('#e-back').onclick = async () => { await save(); if (state.back) state.back.go(); else go(''); };
    $('#e-pdf').onclick = printWorkOrder;
    $('#e-xlsx').onclick = exportWorkOrderXlsx;
    /**
     * Opent of sluit het menu ⋯.
     * @param {MouseEvent} event de klik
     */
    $('#e-more').onclick = (event) => { event.stopPropagation(); $('#e-menu').hidden = !$('#e-menu').hidden; };
    document.addEventListener('click', () => { $('#e-menu').hidden = true; });
    /**
     * Voert de gekozen menukeuze uit.
     * @param {MouseEvent} event de klik
     */
    $('#e-menu').onclick = (event) => {
      const action = event.target.dataset.act;
      if (action) menuAction(action);
    };
    window.addEventListener('beforeunload', (event) => {
      if (state.dirty) { save(); event.preventDefault(); event.returnValue = ''; }
    });
  }

  /**
   * Voert een keuze uit het menu ⋯ uit.
   * @param {string} action 'invoice', 'openquote', 'openplan', 'rezones', 'rematerials', 'outsource', 'delete' of 'purge'
   * @returns {Promise<void>}
   */
  async function menuAction(action) {
    const workOrder = state.workOrder;
    if (!workOrder) return;
    const data = workOrder.data;
    if (action === 'invoice') {
      // Factuur uit deze werkorder (offerteregels + meerwerk, of geboekt materiaal en uren).
      await save();
      /**
       * Vraagt de server een factuur uit deze werkorder te maken.
       * @param {boolean} force true = ook als er al een factuur is
       * @returns {Promise<{status: number, body: object}>} HTTP-status en antwoord
       */
      const post = (force) => fetch('../api/invoices', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workOrderId: workOrder.id, force }) })
        .then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
      try {
        let answer = await post(false);
        if (answer.status === 409 && answer.body.invoiceId) {
          if (!confirm(`${answer.body.message}\n\nOK = nog een factuur maken, Annuleren = de bestaande openen.`)) {
            location.href = `../facturen/?id=${encodeURIComponent(answer.body.invoiceId)}`;
            return;
          }
          answer = await post(true);
        }
        if (answer.status !== 201) return toast(answer.body.message || `Factuur maken mislukt: ${AquatechCommon.statusMessage(answer.status)}`, true);
        location.href = `../facturen/?id=${encodeURIComponent(answer.body.id)}`;
      } catch (error) {
        toast(`Factuur maken mislukt: ${error.message}`, true);
      }
    } else if (action === 'openquote') {
      await save();
      location.href = `../offertes/?id=${encodeURIComponent(data.quoteId)}`;
    } else if (action === 'openplan') {
      await save();
      location.href = `../beregening/?plan=${encodeURIComponent(data.planId)}`;
    } else if (action === 'rezones') {
      const plan = await loadPlan(data.planId);
      if (!plan) return toast('Het plan is niet meer te openen.', true);
      try {
        const zoning = JSON.parse(JSON.stringify(WorkOrderCore.zonesFromPlan(plan.data, LIB())));
        data.zones = zoning.zones;
        data.heads = zoning.heads || [];
        data.design = zoning.design || data.design;
        data.planTitle = plan.title;
        state.warnings = zoning.warnings;
        renderWarnings();
        renderDesign();
        changed();
        toast('Zone-indeling bijgewerkt uit het plan');
      } catch (error) {
        toast(`Zone-indeling mislukt: ${error.message}`, true);
      }
    } else if (action === 'rematerials') {
      if (!confirm('De materiaallijst opnieuw uit de offerte overnemen? Eigen wijzigingen en afvinkingen in de materialen gaan verloren.')) return;
      try {
        const quote = await api(`quotes/${encodeURIComponent(data.quoteId)}`);
        data.materials = WorkOrderCore.fromQuote(quote).data.materials;
        renderMaterials();
        renderProgress();
        changed();
        toast('Materialen bijgewerkt uit de offerte');
      } catch (error) {
        toast(`Kan de offerte niet laden: ${error.message}`, true);
      }
    } else if (action === 'outsource') {
      await save();
      location.href = `../uitbesteden/?wo=${encodeURIComponent(workOrder.id)}`;
    } else if (action === 'delete') {
      if (!confirm(`Werkorder ${workOrder.number} verwijderen?`)) return;
      try {
        await api(`workorders/${encodeURIComponent(workOrder.id)}`, { method: 'DELETE' });
        state.dirty = false;
        toast(`Werkorder ${workOrder.number} verwijderd`);
        go('');
      } catch (error) {
        toast(`Verwijderen mislukt: ${error.message}`, true);
      }
    } else if (action === 'purge') {
      if (!confirm(`Werkorder ${workOrder.number} definitief wissen, inclusief klantgegevens? Dit kan niet ongedaan worden gemaakt.`)) return;
      try {
        await api(`admin/workorders/${encodeURIComponent(workOrder.id)}`, { method: 'DELETE' });
        state.dirty = false;
        toast(`Werkorder ${workOrder.number} gewist`);
        go('');
      } catch (error) {
        toast(`Wissen mislukt: ${error.message}`, true);
      }
    }
  }

  // ---------- Navigatie ----------
  /** Werkt de open werkorder bij als offline gemaakte wijzigingen later zijn verstuurd (nieuwe basis voor de volgende wijziging); weggegooid of een conflict opgelost: opnieuw laden van de server. */
  function bindOffline() {
    const offlineApi = window.AquatechOffline;
    if (!offlineApi) return;
    offlineApi.on('synced', (message) => {
      const workOrder = state.workOrder;
      if (!workOrder) { if (!message.discarded) loadList(); return; }
      if (message.discarded) { if (!state.dirty) loadWorkOrder(workOrder.id); return; }
      if (!message.item || message.item.key !== `wo:${workOrder.id}` || !message.body) return;
      workOrder.updatedAt = message.body.updatedAt;
      workOrder.appointment = message.body.appointment;
      renderAppt();
      if (!state.dirty) {
        workOrder.status = message.body.status;
        $('#e-status').value = message.body.status;
        $('#e-saved').textContent = `Verstuurd ${clock(new Date().toISOString())}`;
      }
    });
  }

  /** Toont het overzicht en laadt de werkorders opnieuw. */
  function showList() {
    state.workOrder = null;
    state.warnings = [];
    document.title = 'Werkorders – AquaTech Hub';
    $('#edit-view').hidden = true;
    $('#list-view').hidden = false;
    loadList();
  }

  /**
   * Toont het scherm dat bij het adres hoort (nieuw uit offerte, werkorder of overzicht).
   * @returns {Promise<void>}
   */
  async function route() {
    const query = params();
    if (state.workOrder && state.dirty) await save();
    if (query.get('quote')) return createFromQuote(query.get('quote'));
    if (query.get('id')) return loadWorkOrder(query.get('id'));
    showList();
  }

  /**
   * Start de pagina: rechten, bedrijfsprofiel en medewerkers ophalen en knoppen koppelen.
   * @returns {Promise<void>}
   */
  async function init() {
    // Rechtstreeks naar een werkorder (vanuit planning, startscherm, dossier):
    // het overzicht niet eerst laten zien terwijl de rest laadt.
    const query = params();
    const direct = query.get('id') || query.get('quote');
    if (direct) $('#list-view').hidden = true;
    // Terugknop gaat terug naar waar je vandaan kwam (planning, dossier, startscherm).
    const from = direct && window.AquatechCommon ? window.AquatechCommon.origin() : null;
    if (from) {
      state.back = from;
      $('#e-back').textContent = from.label;
    }
    // De werkorder (of het overzicht) alvast ophalen, tegelijk met api/me.
    const first = query.get('quote') ? null : query.get('id') ? [`wo:${query.get('id')}`, `workorders/${encodeURIComponent(query.get('id'))}`] : ['list', 'workorders'];
    if (first && location.protocol !== 'file:') {
      const request = api(first[1]);
      request.catch(() => {});
      state.prefetch = { [first[0]]: request };
    }
    state.me = await window.AquatechAccount.load('../');
    // Onderdelen die in Beheer > Modules uit staan (nacalculatie, afspraaklink) verdwijnen van de werkorder.
    state.moduleFlags = ((await window.AquatechCommon.getJson('api/config').catch(() => null)) || {}).modules || {};
    const rights = state.me.rights || [];
    state.admin = rights.includes('beheer');
    // Afspraak met de klant regelen hoort bij het recht planning.
    state.planning = rights.includes('planning');
    state.outsource = rights.includes('uitbesteden');
    state.invoices = rights.includes('facturen');
    if (!state.me.user || !rights.includes('werkorders')) {
      $('#list-view').hidden = false;
      $('#l-new').hidden = true;
      $('#l-export').hidden = true;
      $('#l-hours').hidden = true;
      $('#l-table').innerHTML = state.me.user && state.me.user.kind !== 'gast'
        ? '<tr><td class="empty">Je rol heeft geen toegang tot werkorders. <a href="../">Terug naar het overzicht</a></td></tr>'
        : '<tr><td class="empty">Log eerst in om werkorders te bekijken. <a href="../login">Inloggen</a></td></tr>';
      return;
    }
    const [profileResult, staff] = await Promise.all([api('quote-profile').catch(() => null), api('workorder-staff').catch(() => null)]);
    state.profile = profileResult ? profileResult.profile : { companyName: 'AquaTech Service' };
    state.documentLayout = (profileResult && profileResult.documentLayout) || null;
    state.mail = Boolean(profileResult && profileResult.mail);
    state.staff = (staff && staff.items) || [];
    $('#l-status').innerHTML = '<option value="">Openstaand</option>' + Object.entries(WorkOrderCore.STATUSES)
      .map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('');
    $('#e-status').innerHTML = Object.entries(WorkOrderCore.STATUSES).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('');
    let searchTimer;
    /** Filtert het overzicht kort na het typen. */
    $('#l-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 150); };
    $('#l-status').onchange = renderList;
    $('#l-mine').onchange = renderList;
    $('#l-done').onchange = renderList;
    $('#l-unlinked').onchange = renderList;
    /** Koppelt werkorders aan klanten waar de naam eenduidig is en ververst de lijst. */
    $('#l-link').onclick = async () => {
      try {
        const result = await api('workorders/link-customers', { method: 'POST' });
        state.items = ((await api('workorders')) || {}).items || [];
        renderList();
        toast(result.linked ? `${result.linked} werkorder(s) gekoppeld. ${result.ambiguous} met meerdere klanten van dezelfde naam, ${result.unmatched} zonder passende klant: die koppel je zelf in de werkorder.` : 'Geen werkorder gevonden met een eenduidige klantnaam. Koppel ze zelf in de werkorder.');
      } catch (error) {
        toast(error.message, true);
      }
    };
    let customerTimer = null;
    document.addEventListener('click', (event) => { if (!event.target.closest('#e-cust-pick')) $('#e-cust-list').hidden = true; });
    $('#e-cust-search').addEventListener('input', () => { clearTimeout(customerTimer); customerTimer = setTimeout(searchCustomers, 200); });
    $('#e-cust-search').addEventListener('focus', searchCustomers);
    $('#e-cust-list').addEventListener('click', (event) => {
      const item = event.target.closest('li[data-i]');
      if (item) { $('#e-cust-list').hidden = true; pickCustomer((state.customerHits || [])[Number(item.dataset.i)]); }
    });
    /** Ontkoppelt de werkorder van het klantrecord (naam en adres blijven als tekst staan). */
    $('#e-cust-clear').onclick = async () => {
      const workOrder = state.workOrder;
      if (!workOrder) return;
      workOrder.customerId = null;
      workOrder.customerAccount = null;
      renderCustomer(workOrder);
      await save({ customerId: null });
    };
    $('#l-new').onclick = pickQuote;
    $('#l-export').onclick = exportListXlsx;
    $('#l-hours').onclick = openHoursExport;
    $('#he-go').onclick = runHoursExport;
    document.querySelectorAll('.modal').forEach((modal) => {
      /**
       * Sluit het venster bij een klik naast het venster of op een sluitknop.
       * @param {MouseEvent} event de klik
       */
      modal.onclick = (event) => { if (event.target === modal || event.target.closest('[data-close]')) modal.hidden = true; };
    });
    bindEditor();
    bindApptSend();
    window.addEventListener('popstate', route);
    bindOffline();
    // Terug via de knop Terug van de browser: het overzicht opnieuw laden.
    if (window.AquatechCommon) window.AquatechCommon.onReturn(() => { if (!state.workOrder) loadList(); });
    route();
  }

  init();
})();
