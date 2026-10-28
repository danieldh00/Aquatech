// Werkorders: overzicht, een werkorder maken uit een geaccordeerde offerte,
// bewerken (planning, toewijzing, werkstappen afvinken, materialen
// verzamelen, oplevering) en exporteren als werkbon (afdrukversie via de
// browser, opslaan als PDF) of Excel. De server bewaart alles (/api/workorders);
// alleen beheerders en installateurs (recht 'werkorders') komen hier.
(function () {
  const WorkOrderCore = window.WorkOrderCore;
  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @param {ParentNode} root waarbinnen gezocht wordt (standaard het document)
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  /**
   * Maakt tekst veilig om in HTML te plaatsen.
   * @param {*} value tekst of waarde (null/undefined wordt leeg)
   * @returns {string} tekst met HTML-tekens vervangen door entiteiten
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Formatteert een getal op z'n Nederlands.
   * @param {number} value het getal
   * @param {number} digits maximaal aantal decimalen (standaard 2)
   * @returns {string} bijv. '12,5'
   */
  const nl = (value, digits = 2) => (Number(value) || 0).toLocaleString('nl-NL', { maximumFractionDigits: digits });
  /**
   * Formatteert een bedrag in euro's.
   * @param {number} value het bedrag
   * @returns {string} bijv. '€ 12,50'
   */
  const eur = (value) => (Number(value) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  /**
   * Formatteert een datum voluit met weekdag.
   * @param {string} iso datum of tijdstip in ISO-formaat
   * @returns {string} bijv. 'di 3 november 2026', of '–' zonder datum
   */
  const date = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : '–');
  /**
   * Formatteert een datum kort.
   * @param {string} iso datum of tijdstip in ISO-formaat
   * @returns {string} bijv. '3-11-2026', of leeg zonder datum
   */
  const shortDate = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL') : '');
  /**
   * Formatteert een aantal uren.
   * @param {number} hourCount aantal uren
   * @returns {string} bijv. '2,5 u', of '–' zonder uren
   */
  const hours = (hourCount) => (hourCount ? `${nl(hourCount)} u` : '–');
  /**
   * Geeft de datum van vandaag (lokale tijd).
   * @returns {string} datum als 'jjjj-mm-dd'
   */
  const today = () => {
    const now = new Date();
    /**
     * Vult een getal aan tot twee cijfers.
     * @param {number} number het getal
     * @returns {string} bijv. '07'
     */
    const pad = (number) => String(number).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };
  /**
   * Geeft de plannerbibliotheken die nodig zijn om de zones uit een plan te halen.
   * @returns {{Catalog: object, Hydraulics: object}} de bibliotheken
   */
  const LIB = () => ({ Catalog: window.Catalog, Hydraulics: window.Hydraulics });
  const FINISHED = ['gereed', 'geannuleerd'];

  const state = {
    me: null, admin: false, staff: [], profile: null, mail: false,
    items: [], sort: { key: 'plannedDate', dir: 1 },
    workOrder: null, saveTimer: null, saving: null, dirty: false, warnings: [],
  };

  /**
   * Toont kort een melding onderin het scherm.
   * @param {string} message de tekst
   * @param {boolean} isError true voor een foutmelding (rood)
   */
  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast screen show${isError ? ' err' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = 'toast screen'; }, 3500);
  }

  /**
   * Roept de API aan en geeft de JSON terug. Met `offline` mag de wijziging zonder verbinding in de wachtrij (zie shared/offline.js); het antwoord is dan { queued: true }.
   * @param {string} url pad na '../api/'
   * @param {{method: string, body: object, offline: object}} request methode, inhoud en eventueel de gegevens voor de offline wachtrij
   * @returns {Promise<object>} het antwoord (met cachedAt als het uit de offline cache komt); gooit een fout met code bij een foutstatus
   */
  async function api(url, { method = 'GET', body, offline } = {}) {
    const extra = offline && window.AquatechOffline ? window.AquatechOffline.headers(offline) : {};
    const response = await fetch(`../api/${url}`, {
      method, cache: 'no-store',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.message || `HTTP ${response.status}`), { code: result.error });
    // Zonder verbinding uit de offline cache: van wanneer de gegevens zijn.
    const cachedAt = response.headers.get('X-Aquatech-Cached-At');
    if (cachedAt && result && typeof result === 'object') Object.defineProperty(result, 'cachedAt', { value: cachedAt, enumerable: false });
    return result;
  }
  /**
   * Formatteert de tijd van een tijdstip.
   * @param {string} iso tijdstip in ISO-formaat
   * @returns {string} bijv. '14:05'
   */
  const clock = (iso) => new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

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
    { key: 'title', label: 'Klant en klus', value: (workOrder) => workOrder.customer || workOrder.title, html: (workOrder) => `${esc(workOrder.customer || '–')}<span class="sub">${esc(workOrder.address || workOrder.title)}</span>`, cls: 'wrap' },
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
      state.items = (await take('list', 'workorders')).items || [];
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
    const done = $('#l-done').checked || FINISHED.includes(status);
    const sortColumn = COLUMNS.find((column) => column.key === state.sort.key) || COLUMNS[0];
    return state.items
      .filter((workOrder) => (status ? workOrder.status === status : done || !FINISHED.includes(workOrder.status)))
      .filter((workOrder) => !mine || workOrder.assigneeId === state.me.user.id)
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
    if (window.WorkOrderCosting) window.WorkOrderCosting.open(workOrder, { toast, allowed: (state.me.rights || []).includes('nacalculatie') });
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

  // ---------- Afspraak met de klant (klantlink) ----------
  /**
   * Formatteert een tijdstip met datum en tijd.
   * @param {string} iso tijdstip in ISO-formaat
   * @returns {string} bijv. '3 nov 2026 14:05'
   */
  const dateTime = (iso) => new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
  /**
   * Maakt het label met de stand van de afspraak.
   * @param {{state: string}} appointment de afspraak
   * @returns {string} HTML van het label
   */
  const apptPill = (appointment) => `<span class="pill appt-${esc(appointment.state)}">${esc(WorkOrderCore.APPOINTMENT[appointment.state] || appointment.state)}</span>`;
  /**
   * Geeft het adres van de openbare afspraakpagina; volgt uit waar deze module draait (ook achter een padprefix), de server kent dat zelf niet.
   * @returns {string} absolute URL van openbaar/afspraak.html
   */
  const shareBase = () => new URL('../openbaar/afspraak.html', location.href).href;

  /** Toont het blok Afspraak met de klant: stand, reactie, link en knoppen. */
  function renderAppt() {
    const workOrder = state.workOrder;
    const box = $('#e-appt');
    const appointment = workOrder.appointment || { state: 'geen', response: null };
    const share = workOrder.share || { active: false };
    const response = appointment.response;
    const responseHtml = response ? `<p class="small">${response.answer === 'bevestigd' ? 'Bevestigd' : 'Ander moment gevraagd'} door <b>${esc(response.name)}</b> op ${esc(dateTime(response.at))}${response.current ? '' : ' <span class="muted">(voor een eerder moment)</span>'}${response.reason ? `<br><span class="quote-reason">“${esc(response.reason)}”</span>` : ''}</p>` : '';
    const stats = [share.sharedAt ? `Link gemaakt ${esc(dateTime(share.sharedAt))}` : '', share.sentAt ? `verstuurd naar <b>${esc(share.sentTo)}</b> op ${esc(dateTime(share.sentAt))}` : '',
      share.active ? (share.viewedAt ? `geopend ${esc(dateTime(share.viewedAt))}` : 'nog niet geopend') : ''].filter(Boolean).join(' · ');
    const planned = Boolean(workOrder.data.plannedDate);
    box.innerHTML = `<h4>Afspraak met de klant ${apptPill(appointment)}</h4>${responseHtml}
      ${share.active && share.url ? `<div class="link-row"><input id="ap-url" readonly value="${esc(share.url)}" aria-label="Link naar de afspraak">
        <button class="btn small" data-ap="copy">Kopiëren</button><button class="btn small" data-ap="preview" title="Openen zoals de klant hem ziet">Openen</button></div>` : ''}
      ${state.planning ? `<div class="actions">${planned ? `<button class="btn small primary" data-ap="send">${share.sentAt || response ? 'Opnieuw naar de klant' : 'Afspraak naar de klant'}</button>` : '<span class="muted small">Plan eerst een datum in; daarna kan de klant de afspraak via een link bevestigen.</span>'}
        ${share.active ? '<button class="btn small" data-ap="revoke">Link intrekken</button>' : ''}</div>` : ''}
      ${stats ? `<p class="muted small">${stats}</p>` : ''}`;
  }

  /**
   * Voert een knop uit het blok Afspraak uit.
   * @param {string} action 'copy', 'preview', 'revoke' of 'send'
   * @returns {Promise<void>}
   */
  async function apptAction(action) {
    const workOrder = state.workOrder;
    try {
      if (action === 'copy') {
        const input = $('#ap-url');
        try { await navigator.clipboard.writeText(input.value); } catch (error) { input.select(); document.execCommand('copy'); }
        toast('Link gekopieerd');
      } else if (action === 'preview') {
        window.open(`${workOrder.share.url}&voorbeeld=1`, '_blank', 'noopener');
      } else if (action === 'revoke') {
        if (!confirm('De link intrekken? De klant kan de afspraak dan niet meer openen; een nieuwe link is een ander adres.')) return;
        applyAppt(await api(`workorders/${encodeURIComponent(workOrder.id)}/share`, { method: 'DELETE' }));
        toast('Link ingetrokken');
      } else if (action === 'send') {
        await save();
        openApptSend();
      }
    } catch (error) {
      toast(error.message, true);
    }
  }

  /**
   * Neemt link en afspraak van de server over en toont het blok opnieuw.
   * @param {object} serverWorkOrder de werkorder zoals de server hem teruggeeft
   */
  function applyAppt(serverWorkOrder) {
    if (!state.workOrder || serverWorkOrder.id !== state.workOrder.id) return;
    state.workOrder.share = serverWorkOrder.share;
    state.workOrder.appointment = serverWorkOrder.appointment;
    renderAppt();
  }

  /**
   * Formatteert een datum voluit met weekdag.
   * @param {string} iso datum in ISO-formaat
   * @returns {string} bijv. 'dinsdag 3 november 2026'
   */
  const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  /**
   * Beschrijft het geplande moment van de werkorder in gewone taal.
   * @param {object} data gegevens van de werkorder
   * @returns {string} datum, tijd en eventueel het aantal werkdagen
   */
  const momentLine = (data) => {
    const days = WorkOrderCore.workDays(data.plannedDate, data.days);
    return `${longDate(data.plannedDate)}${data.startTime ? `, ${data.startTime}${data.endTime ? `–${data.endTime}` : ''} uur` : ''}${days.length > 1 ? ` (${days.length} werkdagen, t/m ${longDate(days[days.length - 1])})` : ''}`;
  };

  /** Opent het venster om de afspraak naar de klant te sturen, met een voorgestelde tekst. */
  function openApptSend() {
    const workOrder = state.workOrder;
    const data = workOrder.data;
    const profile = state.profile || {};
    $('#as-to').value = data.customer.email || '';
    $('#as-subject').value = `Afspraak ${data.title ? `${data.title.toLowerCase()} ` : ''}op ${longDate(data.plannedDate)}`;
    $('#as-message').value = [
      `Beste ${data.customer.contact || data.customer.name || 'klant'},`,
      `Wij hebben de werkzaamheden${data.title ? ` (${data.title})` : ''} ingepland op ${momentLine(data)}${data.customer.address ? `, op ${data.customer.address.replace(/\n/g, ', ')}` : ''}.`,
      'Wilt u via de knop hieronder laten weten of dit moment u past? Komt het niet goed uit, dan kunt u daar ook een ander moment voorstellen.',
      `Met vriendelijke groet,\n${profile.companyName || ''}`,
    ].join('\n\n');
    $('#as-err').textContent = '';
    $('#as-send').hidden = !state.mail;
    $('#appt-send').hidden = false;
    $('#as-to').focus();
  }

  /**
   * Maakt de klantlink als die er nog niet is.
   * @returns {Promise<string>} het adres van de link
   */
  async function ensureShare() {
    const workOrder = state.workOrder;
    if (!workOrder.share || !workOrder.share.active || !workOrder.share.url) applyAppt(await api(`workorders/${encodeURIComponent(workOrder.id)}/share`, { method: 'POST', body: { url: shareBase() } }));
    return workOrder.share.url;
  }

  /** Koppelt de knoppen van het blok Afspraak en van het verstuurvenster. */
  function bindApptSend() {
    $('#e-appt').addEventListener('click', (event) => {
      const button = event.target.closest('[data-ap]');
      if (button) apptAction(button.dataset.ap);
    });
    /**
     * Verstuurt de afspraak per e-mail via de server.
     * @returns {Promise<void>}
     */
    $('#as-send').onclick = async () => {
      const workOrder = state.workOrder;
      const button = $('#as-send');
      button.disabled = true;
      try {
        applyAppt(await api(`workorders/${encodeURIComponent(workOrder.id)}/send`, {
          method: 'POST', body: { to: $('#as-to').value, subject: $('#as-subject').value, message: $('#as-message').value, url: shareBase() },
        }));
        $('#appt-send').hidden = true;
        toast(`Afspraak verstuurd naar ${$('#as-to').value}`);
      } catch (error) {
        if (error.code === 'not_configured') { state.mail = false; $('#as-send').hidden = true; }
        $('#as-err').textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
    /**
     * Maakt zonder eigen mailserver de link en opent het bericht in het eigen mailprogramma.
     * @returns {Promise<void>}
     */
    $('#as-mailto').onclick = async () => {
      try {
        const url = await ensureShare();
        const body = `${$('#as-message').value}\n\nAfspraak bekijken en bevestigen:\n${url}`;
        location.href = `mailto:${encodeURIComponent($('#as-to').value.trim()).replace(/%40/g, '@').replace(/%2C/g, ',')}?subject=${encodeURIComponent($('#as-subject').value)}&body=${encodeURIComponent(body)}`;
        $('#appt-send').hidden = true;
      } catch (error) {
        $('#as-err').textContent = error.message;
      }
    };
    /**
     * Maakt de link en kopieert die.
     * @returns {Promise<void>}
     */
    $('#as-copy').onclick = async () => {
      try {
        const url = await ensureShare();
        try { await navigator.clipboard.writeText(url); } catch (error) { /* link staat ook in de werkorder */ }
        $('#appt-send').hidden = true;
        toast('Link gemaakt en gekopieerd');
      } catch (error) {
        $('#as-err').textContent = error.message;
      }
    };
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
    return `<tr class="line${material.picked ? ' done' : ''}" data-mat="${esc(material.id)}">
      <td class="c-chk"><input type="checkbox" data-m="picked"${material.picked ? ' checked' : ''} aria-label="Verzameld"></td>
      <td class="c-desc"><input data-m="description" value="${esc(material.description)}" maxlength="500" placeholder="Omschrijving">${material.code ? `<span class="code">${esc(material.code)}</span>` : ''}</td>
      <td class="c-qty"><input data-m="qty" class="num" type="number" step="any" value="${material.qty}" aria-label="Aantal"></td>
      <td class="c-unit"><input data-m="unit" value="${esc(material.unit)}" maxlength="12" aria-label="Eenheid"></td>
      <td class="c-del"><button class="btn ghost icon" data-del-mat title="Regel verwijderen">✕</button></td>
    </tr>`;
  }

  /** Toont de materiaallijst. */
  function renderMaterials() {
    const data = state.workOrder.data;
    $('#e-materials').innerHTML = `<table class="lines mats">
      <thead><tr><th></th><th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th><th></th></tr></thead>
      <tbody>${data.materials.map(materialRow).join('') || '<tr><td colspan="5" class="muted">Geen materialen.</td></tr>'}
        <tr class="add"><td colspan="5"><button class="btn small" data-add-mat>+ Materiaal</button>
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
        if (answer.status !== 201) return toast(answer.body.message || `Factuur maken mislukt (HTTP ${answer.status})`, true);
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

  // ---------- Werkbon (afdrukversie) ----------
  /**
   * Maakt een afvinkvakje voor de werkbon.
   * @param {boolean} checked true = met vinkje
   * @returns {string} HTML van het vakje
   */
  const box = (checked) => `<span class="p-box">${checked ? '✓' : ''}</span>`;

  /** Zet de werkbon (afdrukversie) van de open werkorder klaar. */
  function renderPrint() {
    const workOrder = state.workOrder;
    const data = workOrder.data;
    const profile = state.profile || {};
    const customer = data.customer;
    const progress = WorkOrderCore.progress(data);
    const company = [profile.address, [profile.phone, profile.email].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    const to = [customer.name, customer.contact ? `T.a.v. ${customer.contact}` : '', customer.address, customer.phone ? `Tel. ${customer.phone}` : ''].filter(Boolean).join('\n');
    const steps = Object.entries(WorkOrderCore.PHASES).map(([key, label]) => {
      const list = data.steps.filter((step) => step.phase === key);
      if (!list.length) return '';
      return `<tr class="p-section"><td colspan="4">${esc(label)}</td></tr>${list.map((step) => `
        <tr><td class="chk">${box(step.done)}</td><td>${esc(step.title)}${step.details ? `<div class="p-small">${esc(step.details)}</div>` : ''}</td>
        <td class="num">${step.hours ? `${nl(step.hours)} u` : ''}</td><td class="num">${step.actualHours != null ? `${nl(step.actualHours)} u` : '<span class="p-fill"></span>'}</td></tr>`).join('')}`;
    }).join('');
    const mats = data.materials.map((material) => `<tr><td class="chk">${box(material.picked)}</td><td>${esc(material.description)}${material.code ? ` <span class="p-small">${esc(material.code)}</span>` : ''}</td>
      <td class="num">${nl(material.qty)}</td><td>${esc(material.unit)}</td></tr>`).join('');
    const line = designLine(data.design);
    /**
     * Maakt een kop met tekstblok voor de werkbon.
     * @param {string} title de kop
     * @param {string} content de tekst
     * @returns {string} HTML, of leeg zonder tekst
     */
    const text = (title, content) => (content ? `<h2>${esc(title)}</h2><p class="p-text">${esc(content)}</p>` : '');
    $('#print').innerHTML = `
      <header class="p-head">
        <img src="../shared/logo-white.png" alt="${esc(profile.companyName || 'AquaTech Service')}">
        <div class="p-company"><b>${esc(profile.companyName || '')}</b>\n${esc(company)}</div>
      </header>
      <div class="p-meta">
        <div class="p-to"><div class="lbl">Klant en adres</div>${esc(to || '–')}</div>
        <div class="p-info"><table>
          <tr><td>Werkorder</td><td><b>${esc(workOrder.number)}</b></td></tr>
          ${data.quoteNumber ? `<tr><td>Offerte</td><td>${esc(data.quoteNumber)}</td></tr>` : ''}
          <tr><td>Datum</td><td>${esc(date(data.plannedDate))}${data.startTime ? `, ${esc(data.startTime)} uur` : ''}</td></tr>
          <tr><td>Uitvoerder</td><td>${esc(workOrder.assignee ? workOrder.assignee.displayName : '–')}</td></tr>
          ${data.crew ? `<tr><td>Ploeg</td><td>${esc(data.crew)}</td></tr>` : ''}
          <tr><td>Geplande uren</td><td>${esc(hours(progress.hours))}</td></tr>
        </table></div>
      </div>
      <h1>Werkbon</h1>
      <div class="p-sub">${esc(data.title)}</div>
      ${line ? `<div class="p-design"><b>Ontwerp${data.planTitle ? ` ${esc(data.planTitle)}` : ''}:</b> ${esc(line)}</div>` : ''}
      ${text('Werkinstructies', data.instructions)}
      ${text('Bijzonderheden locatie', data.siteNotes)}
      ${data.zones.length ? `<h2>Zone-indeling</h2>${zonesTable(data.zones, 'p-lines p-zones')}` : ''}
      ${(data.heads || []).length ? `<h2>Afstelling sproeikoppen</h2><p class="p-note">Linkerrand = begin van de sproeihoek op de tekening (0° = rechts, met de klok mee).</p>${headsTable(data.heads, 'p-lines p-heads')}` : ''}
      <h2>Werkstappen</h2>
      <table class="p-lines p-check">
        <thead><tr><th></th><th>Werkstap</th><th class="num">Gepland</th><th class="num">Werkelijk</th></tr></thead>
        <tbody>${steps || '<tr><td colspan="4">Geen werkstappen.</td></tr>'}</tbody>
      </table>
      <h2>Materialen</h2>
      <table class="p-lines p-check">
        <thead><tr><th></th><th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th></tr></thead>
        <tbody>${mats || '<tr><td colspan="4">Geen materialen.</td></tr>'}</tbody>
      </table>
      <div class="p-end">
        <h2>Oplevering</h2>
        <p class="p-text p-notes">${esc(data.report.notes || '')}</p>
        <div class="p-sign"><div>Uitvoerder (naam, datum)</div><div>Klant voor gezien${data.report.signedBy ? `: ${esc(data.report.signedBy)}` : ''}${data.report.completedOn ? `, ${esc(shortDate(data.report.completedOn))}` : ''}</div></div>
        <footer class="p-foot">${esc([profile.companyName, profile.website].filter(Boolean).join(' · '))}</footer>
      </div>`;
  }

  /**
   * Slaat op en opent het afdrukvenster voor de werkbon (ook voor Opslaan als PDF).
   * @returns {Promise<void>}
   */
  async function printWorkOrder() {
    await save();
    renderPrint();
    const oldTitle = document.title;
    const customerName = state.workOrder.data.customer.name;
    document.title = `Werkbon ${state.workOrder.number}${customerName ? ` ${customerName}` : ''}`;
    const logo = $('#print img');
    if (logo && !logo.complete) await new Promise((resolve) => { logo.onload = resolve; logo.onerror = resolve; });
    window.print();
    setTimeout(() => { document.title = oldTitle; }, 500);
  }

  // ---------- Excel ----------
  /**
   * Laat de browser een bestand downloaden.
   * @param {Blob} blob de inhoud
   * @param {string} filename de bestandsnaam
   */
  function download(blob, filename) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }
  /**
   * Maakt tekst geschikt voor een bestandsnaam.
   * @param {string} text de tekst
   * @returns {string} alleen letters, cijfers, - en _
   */
  const safeName = (text) => String(text || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const NAVY = 'FF172F5E';
  /**
   * Geeft een kopregel in Excel de huisstijl (wit op navy, vet).
   * @param {object} row ExcelJS-rij
   */
  const headStyle = (row) => {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  };
  /**
   * Maakt van een ISO-datum een datum voor Excel.
   * @param {string} iso datum als 'jjjj-mm-dd'
   * @returns {Date|null} de datum (midden op de dag), of null
   */
  const asDate = (iso) => (iso ? new Date(`${iso}T12:00:00`) : null);

  /**
   * Exporteert de open werkorder als Excel-bestand (werkstappen, zones, koppen, materialen en geboekte uren).
   * @returns {Promise<void>}
   */
  async function exportWorkOrderXlsx() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    await save();
    const workOrder = state.workOrder;
    const data = workOrder.data;
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = (state.profile && state.profile.companyName) || 'AquaTech Service';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Werkorder', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      sheet.columns = [{ width: 16 }, { width: 60 }, { width: 12 }, { width: 12 }, { width: 10 }];
      sheet.addRow([`Werkorder ${workOrder.number}`]).font = { bold: true, size: 14, color: { argb: NAVY } };
      const info = [
        ['Omschrijving', data.title], ['Offerte', data.quoteNumber], ['Status', WorkOrderCore.STATUSES[workOrder.status]],
        ['Datum', asDate(data.plannedDate) || ''], ['Starttijd', data.startTime], ['Uitvoerder', workOrder.assignee ? workOrder.assignee.displayName : ''], ['Ploeg', data.crew],
        ['Klant', data.customer.name], ['Contactpersoon', data.customer.contact], ['Adres', data.customer.address.replace(/\n/g, ', ')],
        ['Telefoon', data.customer.phone], ['E-mail', data.customer.email], ['Ontwerp', designLine(data.design)],
        ['Werkinstructies', data.instructions], ['Bijzonderheden', data.siteNotes],
      ].filter(([, value]) => value !== '' && value != null);
      for (const [label, value] of info) {
        const row = sheet.addRow([label, value]);
        row.getCell(1).font = { bold: true };
        row.getCell(2).alignment = { horizontal: 'left', wrapText: true, vertical: 'top' };
        if (value instanceof Date) row.getCell(2).numFmt = 'dd-mm-yyyy';
      }
      sheet.addRow([]);
      headStyle(sheet.addRow(['Fase', 'Werkstap', 'Gepland (u)', 'Werkelijk (u)', 'Klaar']));
      const firstRow = sheet.lastRow.number + 1;
      for (const [key, label] of Object.entries(WorkOrderCore.PHASES)) {
        for (const step of data.steps.filter((candidate) => candidate.phase === key)) {
          sheet.addRow([label, step.details ? `${step.title} – ${step.details}` : step.title, step.hours || null, step.actualHours, step.done ? 'ja' : 'nee']);
        }
      }
      const lastRow = sheet.lastRow.number;
      const totalRow = sheet.addRow(['', 'Totaal', { formula: `SUM(C${firstRow}:C${Math.max(firstRow, lastRow)})` }, { formula: `SUM(D${firstRow}:D${Math.max(firstRow, lastRow)})` }]);
      totalRow.font = { bold: true };
      if (data.zones.length) {
        const zoneSheet = workbook.addWorksheet('Zones', { views: [{ state: 'frozen', ySplit: 1 }] });
        zoneSheet.columns = [
          { header: 'Zone', key: 'name', width: 12 }, { header: 'Soort', key: 'kind', width: 24 }, { header: 'Onderdelen', key: 'parts', width: 50 },
          { header: 'Debiet (m³/u)', key: 'flow', width: 14, style: { numFmt: '0.00' } }, { header: 'Leiding (m)', key: 'pipe', width: 12, style: { numFmt: '0' } },
          { header: 'Druk laatste kop (bar)', key: 'p', width: 20, style: { numFmt: '0.0' } },
        ];
        for (const zone of data.zones) zoneSheet.addRow({ name: zone.name, kind: zone.kind, parts: zone.parts, flow: zone.flowLph / 1000, pipe: zone.pipeM, p: zone.pressureBar });
        headStyle(zoneSheet.getRow(1));
      }
      if ((data.heads || []).length) {
        const headSheet = workbook.addWorksheet('Afstelling koppen', { views: [{ state: 'frozen', ySplit: 1 }] });
        headSheet.columns = [
          { header: 'Nr', key: 'nr', width: 6 }, { header: 'Zone', key: 'zone', width: 12 }, { header: 'Kop', key: 'nozzle', width: 14 },
          { header: 'Behuizing', key: 'body', width: 30 }, { header: 'Sector', key: 'sector', width: 10 }, { header: 'Sproeihoek (°)', key: 'arc', width: 14 },
          { header: 'Worp (m)', key: 'r', width: 10, style: { numFmt: '0.0' } }, { header: 'Linkerrand', key: 'left', width: 20 },
          { header: 'X (m)', key: 'x', width: 9, style: { numFmt: '0.00' } }, { header: 'Y (m)', key: 'y', width: 9, style: { numFmt: '0.00' } },
        ];
        for (const head of data.heads) headSheet.addRow({ nr: head.nr, zone: head.zone, nozzle: head.nozzle || head.kind, body: head.body || '', sector: head.sector, arc: head.arc || null, r: head.r, left: head.leftText, x: head.x, y: head.y });
        headStyle(headSheet.getRow(1));
      }
      const materialSheet = workbook.addWorksheet('Materialen', { views: [{ state: 'frozen', ySplit: 1 }] });
      materialSheet.columns = [
        { header: 'Artikelcode', key: 'code', width: 16 }, { header: 'Omschrijving', key: 'description', width: 56 },
        { header: 'Aantal', key: 'qty', width: 10 }, { header: 'Eenheid', key: 'unit', width: 10 }, { header: 'Verzameld', key: 'picked', width: 11 },
      ];
      for (const material of data.materials) materialSheet.addRow({ code: material.code, description: material.description, qty: material.qty, unit: material.unit, picked: material.picked ? 'ja' : 'nee' });
      headStyle(materialSheet.getRow(1));
      materialSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 5 } };
      // Geboekte uren en materiaalverbruik (worklog.js).
      if (window.WorkLog) await window.WorkLog.addSheets(workbook, { headStyle });
      download(new Blob([await workbook.xlsx.writeBuffer()], { type: XLSX_TYPE }), `werkorder_${safeName(workOrder.number)}${data.customer.name ? `_${safeName(data.customer.name)}` : ''}.xlsx`);
    } catch (error) {
      console.error(error);
      toast(`Export mislukt: ${error.message}`, true);
    }
  }

  /**
   * Exporteert de zichtbare werkorders als Excel-bestand.
   * @returns {Promise<void>}
   */
  async function exportListXlsx() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const items = visible();
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'AquaTech Service';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Werkorders', { views: [{ state: 'frozen', ySplit: 1 }] });
      sheet.columns = [
        { header: 'Nummer', key: 'number', width: 16 },
        { header: 'Offerte', key: 'quote', width: 16 },
        { header: 'Omschrijving', key: 'title', width: 40 },
        { header: 'Klant', key: 'customer', width: 28 },
        { header: 'Adres', key: 'address', width: 36 },
        { header: 'Datum', key: 'date', width: 12, style: { numFmt: 'dd-mm-yyyy' } },
        { header: 'Starttijd', key: 'time', width: 10 },
        { header: 'Uitvoerder', key: 'assignee', width: 22 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Stappen klaar', key: 'done', width: 13 },
        { header: 'Stappen', key: 'steps', width: 10 },
        { header: 'Uren gepland', key: 'hours', width: 13, style: { numFmt: '0.00' } },
        { header: 'Uren werkelijk', key: 'actual', width: 14, style: { numFmt: '0.00' } },
        { header: 'Laatst gewijzigd', key: 'updatedAt', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
      ];
      for (const workOrder of items) {
        sheet.addRow({
          number: workOrder.number, quote: workOrder.quoteNumber, title: workOrder.title, customer: workOrder.customer, address: workOrder.address, date: asDate(workOrder.plannedDate),
          time: workOrder.startTime, assignee: workOrder.assignee ? workOrder.assignee.displayName : '', status: WorkOrderCore.STATUSES[workOrder.status] || workOrder.status,
          done: workOrder.progress.done, steps: workOrder.progress.steps, hours: workOrder.progress.hours, actual: workOrder.progress.actualHours, updatedAt: new Date(workOrder.updatedAt),
        });
      }
      headStyle(sheet.getRow(1));
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
      download(new Blob([await workbook.xlsx.writeBuffer()], { type: XLSX_TYPE }), `werkorders_${today()}.xlsx`);
      toast(`${items.length} werkorders geëxporteerd`);
    } catch (error) {
      toast(`Export mislukt: ${error.message}`, true);
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

  // ---------- Urenstaat (worklog.js) ----------
  /** Opent het venster voor de urenstaat, met standaard deze maand tot vandaag. */
  function openHoursExport() {
    const now = new Date();
    /**
     * Vult een getal aan tot twee cijfers.
     * @param {number} number het getal
     * @returns {string} bijv. '07'
     */
    const pad = (number) => String(number).padStart(2, '0');
    if (!$('#he-from').value) $('#he-from').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    if (!$('#he-to').value) $('#he-to').value = today();
    // Met het recht planning: de urenstaat van iedereen of één medewerker; anders alleen je eigen uren.
    $('#he-user-row').hidden = !state.planning;
    if (state.planning) {
      const current = $('#he-user').value;
      $('#he-user').innerHTML = '<option value="">Iedereen</option>' + state.staff.map((user) => `<option value="${esc(user.id)}"${user.id === current ? ' selected' : ''}>${esc(user.displayName)}</option>`).join('');
    }
    $('#he-err').textContent = '';
    $('#hours-export').hidden = false;
  }

  /**
   * Exporteert de urenstaat over de gekozen periode als Excel-bestand (worklog.js).
   * @returns {Promise<void>}
   */
  async function runHoursExport() {
    const from = $('#he-from').value;
    const to = $('#he-to').value;
    if (!from || !to || from > to) { $('#he-err').textContent = 'Kies een geldige periode.'; return; }
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    $('#he-go').disabled = true;
    try {
      const counts = await window.WorkLog.exportPeriod({ from, to, userId: state.planning ? $('#he-user').value : '', headStyle, download, companyName: state.profile && state.profile.companyName });
      $('#hours-export').hidden = true;
      toast(`Urenstaat met ${counts.hours} urenregel${counts.hours === 1 ? '' : 's'} en ${counts.materials} materiaalregel${counts.materials === 1 ? '' : 's'}`);
    } catch (error) {
      $('#he-err').textContent = `Export mislukt: ${error.message}`;
    } finally {
      $('#he-go').disabled = false;
    }
  }

  /** Toont het overzicht en laadt de werkorders opnieuw. */
  function showList() {
    state.workOrder = null;
    state.warnings = [];
    document.title = 'Werkorders – AquaTech Service';
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
