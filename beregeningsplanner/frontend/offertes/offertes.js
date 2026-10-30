// Offertes: overzicht, een offerte opbouwen uit een beregeningsplan, bewerken
// (klant, regels, korting, btw, teksten), en exporteren als PDF (afdrukversie
// via de browser) of Excel. De server bewaart de offertes (/api/quotes) en
// rekent de totalen voor het overzicht zelf na met dezelfde rekenkern.
// Rollen (shared/roles.js): beheerders en installateurs stellen offertes op;
// een klant ziet alleen de verzonden offertes voor zijn account, als
// document, en geeft akkoord of wijst af.
// Digitale offerte: een link (openbaar/offerte.html#t=...) waarmee de klant
// zonder account bekijkt, opties kiest en accordeert met naam, handtekening en
// akkoord op de voorwaarden. Na een antwoord ligt de offerte vast.
(function () {
  const QuoteCore = window.QuoteCore;
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
   * Formatteert een bedrag in euro's.
   * @param {number} value het bedrag
   * @returns {string} bijv. '€ 12,50'
   */
  const eur = (value) => (Number(value) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  /**
   * Formatteert een getal op z'n Nederlands.
   * @param {number} value het getal
   * @param {number} digits maximaal aantal decimalen (standaard 2)
   * @returns {string} bijv. '12,5'
   */
  const nl = (value, digits = 2) => (Number(value) || 0).toLocaleString('nl-NL', { maximumFractionDigits: digits });
  /**
   * Formatteert een datum voluit.
   * @param {string} iso datum of tijdstip in ISO-formaat
   * @returns {string} bijv. '3 november 2026', of '–' zonder datum
   */
  const date = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '–');
  /**
   * Formatteert een datum kort.
   * @param {string} iso datum of tijdstip in ISO-formaat
   * @returns {string} bijv. '3-11-2026', of '–' zonder datum
   */
  const shortDate = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL') : '–');
  /**
   * Kijkt of een openstaande offerte over haar geldigheid heen is.
   * @param {object} quote de offerte
   * @returns {boolean} true als hij verlopen is
   */
  const expired = (quote) => quote.status !== 'akkoord' && quote.status !== 'afgewezen' && quote.validUntil && quote.validUntil < QuoteCore.today();
  /**
   * Geeft de status zoals de gebruiker hem ziet (inclusief 'verlopen').
   * @param {object} quote de offerte
   * @returns {string} statussleutel
   */
  const statusOf = (quote) => (expired(quote) ? 'verlopen' : quote.status);
  /**
   * Geeft het label bij een status.
   * @param {string} status statussleutel
   * @returns {string} label voor op het scherm
   */
  const statusLabel = (status) => (status === 'verlopen' ? 'Verlopen' : QuoteCore.STATUSES[status] || status);

  const QuoteView = window.QuoteView;
  const state = {
    me: null, admin: false, all: false, klant: false, customers: [], profile: null, canEdit: false, mail: false,
    items: [], sort: { key: 'updatedAt', dir: -1 },
    quote: null, saveTimer: null, saving: null, dirty: false, warnings: [],
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
   * Roept de API aan en geeft de JSON terug.
   * @param {string} url pad na '../api/'
   * @param {{method: string, body: object}} request methode en inhoud (standaard GET zonder inhoud)
   * @returns {Promise<object>} het antwoord; gooit een fout met code en status bij een foutstatus
   */
  async function api(url, { method = 'GET', body } = {}) {
    const response = await fetch(`../api/${url}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.message || `HTTP ${response.status}`), { code: result.error, status: response.status });
    return result;
  }

  /**
   * Leest de parameters uit het adres van de pagina.
   * @returns {URLSearchParams} de queryparameters
   */
  const params = () => new URLSearchParams(location.search);
  /**
   * Gaat naar een ander scherm binnen de module (overzicht, offerte of nieuw uit plan).
   * @param {string} query nieuwe query zonder '?', leeg = overzicht
   */
  function go(query) {
    history.pushState(null, '', query ? `?${query}` : './');
    route();
  }

  // ---------- Overzicht ----------
  const COLUMNS = [
    { key: 'number', label: 'Nummer', value: (quote) => quote.number, html: (quote) => `<b>${esc(quote.number)}</b>` },
    { key: 'title', label: 'Omschrijving', value: (quote) => quote.title, html: (quote) => `${esc(quote.title)}${quote.customer ? `<span class="sub">${esc(quote.customer)}</span>` : ''}`, cls: 'wrap' },
    { key: 'owner', label: 'Gebruiker', admin: true, value: (quote) => (quote.owner ? quote.owner.displayName : ''), html: (quote) => esc(quote.owner ? quote.owner.displayName : '–') },
    { key: 'status', label: 'Status', value: statusOf, html: (quote) => `<span class="pill ${esc(statusOf(quote))}">${esc(statusLabel(statusOf(quote)))}</span>${statusOf(quote) === 'verzonden' && quote.viewedAt ? '<span class="sub">bekeken</span>' : ''}` },
    { key: 'totalExcl', label: 'Excl. btw', value: (quote) => quote.totalExcl, html: (quote) => eur(quote.totalExcl), cls: 'num' },
    { key: 'totalIncl', label: 'Incl. btw', value: (quote) => quote.totalIncl, html: (quote) => eur(quote.totalIncl), cls: 'num' },
    { key: 'validUntil', label: 'Geldig tot', value: (quote) => quote.validUntil, html: (quote) => esc(shortDate(quote.validUntil)) },
    { key: 'updatedAt', label: 'Laatst gewijzigd', value: (quote) => quote.updatedAt, html: (quote) => esc(new Date(quote.updatedAt).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' })) },
  ];
  /**
   * Kijkt of de offertes van alle gebruikers worden getoond.
   * @returns {boolean} true als het recht er is en het vinkje aan staat
   */
  const showAll = () => state.all && $('#l-all').checked;
  /**
   * Geeft de kolommen die in het overzicht zichtbaar zijn.
   * @returns {object[]} kolomdefinities uit COLUMNS
   */
  const columns = () => COLUMNS.filter((column) => !column.admin || showAll());

  /**
   * Haalt de offertes op en toont het overzicht.
   * @returns {Promise<void>}
   */
  async function loadList() {
    try {
      state.items = (await api(`quotes${showAll() ? '?all=1' : ''}`)).items || [];
    } catch (error) {
      $('#l-table').innerHTML = `<tr><td class="empty">Kan de offertes niet laden (${esc(error.message)}).</td></tr>`;
      return;
    }
    renderList();
  }

  /**
   * Filtert en sorteert de offertes volgens zoekveld, status en gekozen kolom.
   * @returns {object[]} de zichtbare offertes
   */
  function visible() {
    const search = $('#l-search').value.trim().toLowerCase();
    const status = $('#l-status').value;
    const sortColumn = COLUMNS.find((column) => column.key === state.sort.key) || COLUMNS[0];
    return state.items
      .filter((quote) => !status || statusOf(quote) === status)
      .filter((quote) => !search || [quote.number, quote.title, quote.customer, quote.owner && quote.owner.displayName].some((value) => String(value || '').toLowerCase().includes(search)))
      .sort((left, right) => {
        const leftValue = sortColumn.value(left), rightValue = sortColumn.value(right);
        const comparison = typeof leftValue === 'number' || typeof rightValue === 'number' ? (leftValue || 0) - (rightValue || 0) : String(leftValue || '').localeCompare(String(rightValue || ''), 'nl');
        return comparison * state.sort.dir;
      });
  }

  /** Toont de tellers en de tabel van het overzicht. */
  function renderList() {
    const items = visible();
    const open = items.filter((quote) => ['concept', 'verzonden'].includes(statusOf(quote)));
    const won = items.filter((quote) => quote.status === 'akkoord');
    $('#l-stats').innerHTML = [
      [items.length, items.length === 1 ? 'offerte' : 'offertes'],
      [eur(open.reduce((sum, quote) => sum + quote.totalExcl, 0)), `openstaand (${open.length}), excl. btw`],
      [eur(won.reduce((sum, quote) => sum + quote.totalExcl, 0)), `akkoord (${won.length}), excl. btw`],
    ].map(([value, label]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
    $('#l-stats').hidden = !state.items.length;
    const table = $('#l-table');
    if (!state.items.length) {
      table.innerHTML = state.klant
        ? '<tr><td class="empty">Er staan nog geen offertes voor u klaar.</td></tr>'
        : '<tr><td class="empty">Nog geen offertes. Kies <b>Nieuwe offerte uit plan</b> om de stuklijst van een beregeningsplan over te nemen.</td></tr>';
      $('#l-count').textContent = '';
      return;
    }
    const visibleColumns = columns();
    const head = visibleColumns.map((column) => {
      const sorted = column.key === state.sort.key ? (state.sort.dir > 0 ? ' asc' : ' desc') : '';
      return `<th data-sort="${column.key}" class="${column.cls === 'num' ? 'num' : ''}${sorted}">${esc(column.label)}</th>`;
    }).join('');
    table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${items.map((quote) => `
      <tr data-id="${esc(quote.id)}">${visibleColumns.map((column) => `<td class="${column.cls || ''}">${column.html(quote)}</td>`).join('')}</tr>`).join('')
      || `<tr><td class="empty" colspan="${visibleColumns.length}">Geen offertes gevonden.</td></tr>`}</tbody>`;
    table.querySelectorAll('th[data-sort]').forEach((header) => {
      /** Sorteert op deze kolom (nogmaals klikken draait de volgorde om). */
      header.onclick = () => {
        const key = header.dataset.sort;
        state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (['number', 'title', 'owner', 'status'].includes(key) ? 1 : -1) };
        renderList();
      };
    });
    table.querySelectorAll('tr[data-id]').forEach((row) => {
      /** Opent de offerte. */
      row.onclick = () => { go(`id=${encodeURIComponent(row.dataset.id)}`); };
    });
    $('#l-count').textContent = `${items.length} van ${state.items.length} offertes`;
  }

  // ---------- Nieuwe offerte ----------
  /**
   * Maakt de standaardgegevens voor een nieuwe offerte uit het bedrijfsprofiel.
   * @param {object} extra velden die de standaard aanvullen of vervangen
   * @returns {object} gegevens voor een nieuwe offerte
   */
  function baseData(extra = {}) {
    const profile = state.profile;
    const today = QuoteCore.today();
    return { date: today, validUntil: QuoteCore.addDays(today, profile.validDays || 30), intro: profile.intro, terms: profile.terms, lines: [], ...extra };
  }

  /**
   * Geeft de plannerbibliotheken die nodig zijn om een stuklijst te berekenen.
   * @returns {{Catalog: object, Hydraulics: object, BOM: object}} de bibliotheken
   */
  const LIB = () => ({ Catalog: window.Catalog, Hydraulics: window.Hydraulics, BOM: window.BOM });

  /**
   * Maakt een nieuwe offerte uit een (goedgekeurd) beregeningsplan en opent die.
   * @param {string} planId id van het plan
   * @returns {Promise<void>}
   */
  async function createFromPlan(planId) {
    let plan;
    try {
      plan = await api(`plans/${encodeURIComponent(planId)}`);
    } catch (error) {
      toast(`Kan het plan niet laden: ${error.message}`, true);
      return go('');
    }
    // Alleen uit een goedgekeurd plan (de server controleert dat ook): anders
    // meteen naar het plan, om het te controleren en goed te keuren.
    if (plan.review && plan.review.status !== 'goedgekeurd') {
      toast('Dit plan is nog niet goedgekeurd. Keur het eerst goed in de planner.', true);
      setTimeout(() => { location.href = `../beregening/?plan=${encodeURIComponent(plan.id)}`; }, 1200);
      return;
    }
    let built;
    try {
      built = QuoteCore.fromPlan(plan.data, LIB(), state.profile);
    } catch (error) {
      console.error(error);
      built = { lines: [], summary: null, warnings: [`De stuklijst kon niet worden berekend (${error.message}).`] };
    }
    const meta = plan.data.meta || {};
    const data = baseData({
      title: `Aanleg automatische beregening${plan.title ? ` – ${plan.title}` : ''}`,
      customer: { name: meta.customer || '', address: meta.address || '' },
      planId: plan.id, planTitle: plan.title, planSummary: built.summary, lines: built.lines,
    });
    try {
      const quote = await api('quotes', { method: 'POST', body: { data } });
      state.warnings = built.warnings;
      history.replaceState(null, '', `?id=${encodeURIComponent(quote.id)}`);
      openQuote(quote);
      toast(`Offerte ${quote.number} aangemaakt uit "${plan.title}"`);
    } catch (error) {
      toast(`Offerte aanmaken mislukt: ${error.message}`, true);
      go('');
    }
  }

  /**
   * Maakt een nieuwe offerte en opent die.
   * @param {object} data gegevens van de offerte (standaard een lege offerte)
   * @returns {Promise<void>}
   */
  async function createEmpty(data = baseData({ title: 'Offerte' })) {
    try {
      const quote = await api('quotes', { method: 'POST', body: { data } });
      state.warnings = [];
      go(`id=${encodeURIComponent(quote.id)}`);
    } catch (error) {
      toast(`Offerte aanmaken mislukt: ${error.message}`, true);
    }
  }

  /**
   * Toont het venster om een plan te kiezen voor een nieuwe offerte.
   * @returns {Promise<void>}
   */
  async function pickPlan() {
    const modal = $('#plan-picker');
    const list = $('#pp-list');
    list.innerHTML = '<p class="muted small">Laden…</p>';
    modal.hidden = false;
    let plans = [];
    try {
      plans = (await api(state.all ? 'plans?all=1' : 'plans')).items || [];
    } catch (error) {
      list.innerHTML = `<p class="err">Kan de plannen niet laden (${esc(error.message)}).</p>`;
      return;
    }
    /** Toont de plannen die bij de zoekterm passen. */
    const render = () => {
      const search = $('#pp-search').value.trim().toLowerCase();
      const items = plans.filter((plan) => !search || [plan.title, plan.customer, plan.address, plan.owner && plan.owner.displayName].some((value) => String(value || '').toLowerCase().includes(search)));
      list.innerHTML = items.map((plan) => `
        <button data-plan="${esc(plan.id)}"${plan.review && plan.review.status !== 'goedgekeurd' ? ' disabled title="Nog niet goedgekeurd"' : ''}><b>${esc(plan.title)}</b>${plan.review && plan.review.status !== 'goedgekeurd' ? ` <span class="sub">${plan.review.status === 'ter_controle' ? 'Ter controle' : 'Concept'}: eerst goedkeuren</span>` : ''}
          <span class="sub">${esc([plan.customer, plan.address].filter(Boolean).join(' · ') || 'Geen klant ingevuld')}</span>
          <span class="sub">${plan.summary ? `${plan.summary.sprinklers} sproeiers · ${plan.summary.zones} zones · ${nl(plan.summary.totalM2, 0)} m²` : ''}${plan.owner && state.all ? ` · ${esc(plan.owner.displayName)}` : ''} · gewijzigd ${esc(shortDate(plan.updatedAt))}</span>
        </button>`).join('') || `<p class="muted">${plans.length ? 'Geen plannen gevonden.' : 'Nog geen plannen. Teken eerst een tuin in de <a href="../beregening/">beregeningsplanner</a>.'}</p>`;
      list.querySelectorAll('[data-plan]').forEach((button) => {
        /** Sluit het venster en maakt de offerte uit dit plan. */
        button.onclick = () => { modal.hidden = true; go(`plan=${encodeURIComponent(button.dataset.plan)}`); };
      });
    };
    $('#pp-search').value = '';
    $('#pp-search').oninput = render;
    render();
    $('#pp-search').focus();
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
   * Laat een offerte zien: als document voor een klant, anders in de editor.
   * @param {string} id id van de offerte
   * @returns {Promise<void>}
   */
  async function loadQuote(id) {
    try {
      const prefetched = state.prefetch && state.prefetch.id === id ? state.prefetch.request : null;
      state.prefetch = null;
      const quote = await (prefetched || api(`quotes/${encodeURIComponent(id)}`));
      if (state.klant) return viewQuote(quote);
      openQuote(quote);
    } catch (error) {
      toast(`Kan de offerte niet openen: ${error.message}`, true);
      go('');
    }
  }

  /**
   * Opent een offerte in de editor.
   * @param {object} quote de offerte van de server
   */
  function openQuote(quote) {
    quote.data = QuoteCore.sanitize(quote.data);
    state.quote = quote;
    state.dirty = false;
    $('#list-view').hidden = true;
    $('#edit-view').hidden = false;
    $('#e-heading').textContent = `Offerte ${quote.number}`;
    $('#e-number').value = quote.number;
    document.title = `Offerte ${quote.number} – AquaTech Service`;
    $('#e-status').value = quote.status;
    renderAccount(quote);
    $('#e-saved').textContent = '';
    document.querySelectorAll('#edit-view [data-f]').forEach((field) => {
      const value = getPath(quote.data, field.dataset.f);
      field.value = value == null ? '' : value;
    });
    const data = quote.data;
    $('#e-plan').innerHTML = data.planId
      ? `Opgebouwd uit plan <a href="../beregening/?plan=${encodeURIComponent(data.planId)}">${esc(data.planTitle || 'beregeningsplan')}</a>${data.planSummary ? ` · ${data.planSummary.sprinklers} sproeiers, ${data.planSummary.zones} zones, ${nl(data.planSummary.lawnM2, 0)} m² gazon` : ''}`
      : 'Niet gekoppeld aan een plan.';
    $('#e-menu [data-act=replan]').hidden = !data.planId;
    $('#e-menu [data-act=openplan]').hidden = !data.planId;
    $('#e-menu [data-act=purge]').hidden = !state.admin;
    renderWorkOrder(quote);
    renderWarnings();
    renderLines();
    renderLock();
    renderShare();
    window.scrollTo(0, 0);
  }

  // ---------- Digitale offerte: akkoord, vastleggen en de link ----------
  /**
   * Kijkt of de open offerte vastligt na een antwoord van de klant.
   * @returns {boolean} true als er een akkoord of afwijzing is
   */
  const locked = () => Boolean(state.quote && state.quote.acceptance);

  /**
   * Maakt de tekst over het akkoord of de afwijzing van de klant.
   * @param {object} acceptance het vastgelegde antwoord
   * @returns {string} HTML voor de melding
   */
  function acceptanceHtml(acceptance) {
    if (acceptance.answer === 'akkoord') {
      return `<b>Digitaal geaccordeerd</b> door ${esc(acceptance.name)} op ${esc(QuoteView.dateTime(acceptance.at))}, voor ${eur(acceptance.totalIncl)} incl. btw
        (${acceptance.via === 'account' ? 'via het klantaccount' : 'via de offertelink'}${acceptance.ip ? `, IP ${esc(acceptance.ip)}` : ''}).
        ${acceptance.options && acceptance.options.length ? `Gekozen opties: ${acceptance.options.length}.` : ''}
        De offerte ligt vast; maak via ⋯ een kopie om iets te wijzigen.
        ${acceptance.signature ? `<img src="${esc(acceptance.signature)}" alt="Handtekening">` : ''}`;
    }
    return `<b>Afgewezen</b>${acceptance.name ? ` door ${esc(acceptance.name)}` : ''} op ${esc(QuoteView.dateTime(acceptance.at))}.${acceptance.reason ? ` Reden: ${esc(acceptance.reason)}` : ''}
      De offerte ligt vast; maak via ⋯ een kopie voor een aangepaste offerte.`;
  }

  /** Toont of de offerte vastligt en zet de invoer dan uit. */
  function renderLock() {
    const quote = state.quote;
    const isLocked = locked();
    const box = $('#e-locked');
    box.hidden = !isLocked;
    box.className = `notice ok${isLocked && quote.acceptance.answer !== 'akkoord' ? ' rejected' : ''}`;
    box.innerHTML = isLocked ? acceptanceHtml(quote.acceptance) : '';
    $('#edit-view').classList.toggle('locked', isLocked);
    document.querySelectorAll('#edit-view .cols input, #edit-view .cols textarea, #edit-view .cols select, #edit-view [data-f], #e-lines input, #e-lines select, #e-lines button, #e-status')
      .forEach((field) => { if (field.id !== 'e-number') field.disabled = isLocked; });
  }

  /** Toont het blok met de klantlink: link maken, kopiëren, versturen en intrekken. */
  function renderShare() {
    const quote = state.quote;
    const share = quote.share || {};
    const body = $('#sh-body');
    const answered = locked();
    if (!share.active) {
      // Verstuurd zonder link (bijv. alleen via het klantaccount): zeggen
      // waarom er geen adres staat.
      const noLink = quote.status !== 'concept' ? '<p class="notice warn small">Deze offerte heeft nog geen klantlink. Maak er een om de offerte zelf te openen zoals de klant hem ziet, of om het adres te delen.</p>' : '';
      body.innerHTML = `${noLink}<p class="muted small">Maak een link waarmee de klant de offerte online bekijkt, eventuele opties kiest en digitaal akkoord geeft met naam, handtekening en akkoord op de voorwaarden. Tijdstip en IP-adres worden vastgelegd${state.mail ? ' en de klant krijgt een bevestiging per e-mail' : ''}.</p>
        <div class="actions">${answered ? '' : `<button class="btn primary" data-sh="send">Versturen per e-mail</button>`}
        <button class="btn" data-sh="create">Link maken</button></div>
        ${quote.status === 'concept' && !answered ? '<p class="muted small">Met de link gaat de status naar <b>Verzonden</b>.</p>' : ''}`;
      return;
    }
    const stats = [
      share.sharedAt ? `Link gemaakt ${esc(QuoteView.dateTime(share.sharedAt))}` : '',
      share.sentAt ? `verstuurd naar <b>${esc(share.sentTo)}</b> op ${esc(QuoteView.dateTime(share.sentAt))}` : '',
      share.viewCount ? `<b>${share.viewCount}× bekeken</b>, eerst ${esc(QuoteView.dateTime(share.viewedAt))}${share.viewCount > 1 ? `, laatst ${esc(QuoteView.dateTime(share.lastViewedAt))}` : ''}` : 'nog niet bekeken',
    ].filter(Boolean).join(' · ');
    body.innerHTML = `
      <label class="link-label" for="sh-url">Klantlink <span class="muted">(dit adres krijgt de klant${share.sentTo ? ' in de e-mail' : ''})</span></label>
      <div class="link-row">
        <input id="sh-url" readonly value="${esc(share.url || '')}" aria-label="Link naar de digitale offerte">
        <button class="btn" data-sh="copy">Kopiëren</button>
        <button class="btn" data-sh="preview" title="Openen zoals de klant hem ziet; telt niet als bekeken door de klant">Openen</button>
      </div>
      <div class="actions">
        ${answered ? '' : '<button class="btn primary" data-sh="send">Versturen per e-mail</button>'}
        <button class="btn" data-sh="revoke">Link intrekken</button>
      </div>
      <p class="stats-line">${stats}</p>`;
  }

  /**
   * Voert een knop uit het blok met de klantlink uit.
   * @param {string} action 'create', 'copy', 'preview', 'revoke' of 'send'
   * @returns {Promise<void>}
   */
  async function shareAction(action) {
    const quote = state.quote;
    if (!quote) return;
    try {
      if (action === 'create') {
        await save();
        applyServer(await api(`quotes/${encodeURIComponent(quote.id)}/share`, { method: 'POST', body: { url: shareBase() } }));
        toast('Link gemaakt');
      } else if (action === 'copy') {
        const input = $('#sh-url');
        try { await navigator.clipboard.writeText(input.value); } catch (error) { input.select(); document.execCommand('copy'); }
        toast('Link gekopieerd');
      } else if (action === 'preview') {
        // Voorbeeld: telt niet als "bekeken" door de klant.
        window.open(`${quote.share.url}&voorbeeld=1`, '_blank', 'noopener');
      } else if (action === 'revoke') {
        if (!confirm('De link intrekken? De klant kan de offerte dan niet meer openen; een nieuwe link is daarna een ander adres.')) return;
        applyServer(await api(`quotes/${encodeURIComponent(quote.id)}/share`, { method: 'DELETE' }));
        toast('Link ingetrokken');
      } else if (action === 'send') {
        await save();
        openSend();
      }
    } catch (error) {
      toast(error.message, true);
    }
  }

  /**
   * Geeft het adres van de openbare offertepagina; volgt uit waar deze module draait (ook achter een padprefix), de server kent dat zelf niet.
   * @returns {string} absolute URL van openbaar/offerte.html
   */
  const shareBase = () => new URL('../openbaar/offerte.html', location.href).href;

  /**
   * Neemt status, link en akkoord van de server over zonder de invoer opnieuw op te bouwen.
   * @param {object} serverQuote de offerte zoals de server hem teruggeeft
   */
  function applyServer(serverQuote) {
    const quote = state.quote;
    if (!quote || serverQuote.id !== quote.id) return;
    quote.status = serverQuote.status;
    quote.share = serverQuote.share;
    quote.acceptance = serverQuote.acceptance;
    $('#e-status').value = quote.status;
    renderShare();
  }

  /** Opent het venster om de offerte per e-mail te versturen, met een voorgestelde tekst. */
  function openSend() {
    const quote = state.quote;
    const data = quote.data;
    const profile = state.profile;
    const form = $('#sf');
    form.to.value = data.customer.email || '';
    const link = $('#sf-link');
    link.hidden = !(quote.share && quote.share.url);
    link.innerHTML = link.hidden ? '' : `Link in de e-mail: <a href="${esc(`${quote.share.url}&voorbeeld=1`)}" target="_blank" rel="noopener">${esc(quote.share.url)}</a>`;
    form.subject.value = `Offerte ${quote.number}${data.title ? ` – ${data.title}` : ''}`;
    form.message.value = [
      `Beste ${data.customer.contact || data.customer.name || 'klant'},`,
      `Hierbij ontvangt u onze offerte ${quote.number}${data.title ? ` voor ${data.title.toLowerCase()}` : ''}. Via de knop hieronder bekijkt u de offerte online en kunt u direct digitaal akkoord geven. De offerte is geldig tot ${date(data.validUntil)}.`,
      'Heeft u vragen, neem dan gerust contact met ons op.',
      `Met vriendelijke groet,\n${profile.companyName || ''}`,
    ].join('\n\n');
    $('#send').hidden = false;
    form.to.focus();
  }

  /**
   * Verstuurt de offerte per e-mail via de server (of via het eigen mailprogramma zonder mailserver).
   * @param {SubmitEvent} event het verzenden van het formulier
   * @returns {Promise<void>}
   */
  async function sendQuote(event) {
    event.preventDefault();
    const quote = state.quote;
    const form = $('#sf');
    const submitButton = form.querySelector('[type=submit]');
    if (!state.mail) return mailtoFallback();
    submitButton.disabled = true;
    try {
      applyServer(await api(`quotes/${encodeURIComponent(quote.id)}/send`, {
        method: 'POST', body: { to: form.to.value, subject: form.subject.value, message: form.message.value, url: shareBase() },
      }));
      $('#send').hidden = true;
      toast(`Offerte verstuurd naar ${form.to.value}`);
    } catch (error) {
      if (error.code === 'not_configured') { state.mail = false; return mailtoFallback(); }
      toast(error.message, true);
    } finally {
      submitButton.disabled = false;
    }
  }

  /**
   * Maakt zonder eigen mailserver de link en opent het bericht in het eigen mailprogramma.
   * @returns {Promise<void>}
   */
  async function mailtoFallback() {
    const quote = state.quote;
    const form = $('#sf');
    try {
      if (!quote.share || !quote.share.active) applyServer(await api(`quotes/${encodeURIComponent(quote.id)}/share`, { method: 'POST', body: { url: shareBase() } }));
      const body = `${form.message.value}\n\nOfferte bekijken en accorderen:\n${quote.share.url}`;
      location.href = `mailto:${encodeURIComponent(form.to.value.trim()).replace(/%40/g, '@').replace(/%2C/g, ',')}?subject=${encodeURIComponent(form.subject.value)}&body=${encodeURIComponent(body)}`;
      $('#send').hidden = true;
      toast('Er is geen mailserver ingesteld; het bericht staat klaar in je mailprogramma');
    } catch (error) {
      toast(error.message, true);
    }
  }

  /**
   * Vult de keuzelijst met het klantaccount waaraan de offerte hangt (de klant ziet hem dan zelf).
   * @param {object} quote de offerte
   */
  function renderAccount(quote) {
    const select = $('#e-account');
    const options = state.customers.slice();
    if (quote.customerAccount && !options.some((customer) => customer.id === quote.customerAccount.id)) options.push({ ...quote.customerAccount, gone: true });
    select.innerHTML = '<option value="">Geen (alleen intern)</option>' + options
      .map((customer) => `<option value="${esc(customer.id)}">${esc(customer.displayName)}${customer.username ? ` (${esc(customer.username)})` : ''}${customer.gone ? ' – uitgeschakeld' : ''}</option>`).join('');
    select.value = quote.customerId || '';
  }

  /**
   * Toont de knop naar de werkorder (alleen bij een offerte met status akkoord).
   * @param {object} quote de offerte
   * @returns {Promise<void>}
   */
  async function renderWorkOrder(quote) {
    const button = $('#e-wo');
    button.hidden = !state.werkorders || quote.status !== 'akkoord';
    if (button.hidden) return;
    button.textContent = 'Werkorder maken';
    /** Maakt een werkorder uit deze offerte. */
    button.onclick = () => { location.href = `../werkorders/?quote=${encodeURIComponent(quote.id)}`; };
    try {
      const items = (await api(`workorders?quote=${encodeURIComponent(quote.id)}`)).items || [];
      if (items.length && state.quote === quote) {
        button.textContent = `Werkorder ${items[0].number}`;
        /** Opent de bestaande werkorder. */
        button.onclick = () => { location.href = `../werkorders/?id=${encodeURIComponent(items[0].id)}`; };
      }
    } catch (error) { /* knop blijft "Werkorder maken" */ }
  }

  // ---------- Klant: offerte bekijken en akkoord geven ----------
  /**
   * Toont de offerte als document voor de klant, met opties en het akkoordformulier.
   * @param {object} quote de offerte van de server
   */
  function viewQuote(quote) {
    quote.data = QuoteCore.sanitize(quote.data);
    state.quote = quote;
    $('#list-view').hidden = true;
    $('#view-view').hidden = false;
    document.body.classList.add('view-doc');
    $('#print').removeAttribute('aria-hidden');
    $('#v-heading').textContent = `Offerte ${quote.number}`;
    document.title = `Offerte ${quote.number} – AquaTech Service`;
    const status = statusOf(quote);
    $('#v-status').className = `pill ${status}`;
    $('#v-status').textContent = statusLabel(status);
    const open = status === 'verzonden' && !quote.acceptance;
    const notice = {
      verzonden: `Deze offerte is geldig tot ${date(quote.data.validUntil)}. Gaat u akkoord, dan nemen wij contact met u op om de werkzaamheden in te plannen.`,
      akkoord: 'U heeft deze offerte geaccepteerd. Wij nemen contact met u op om de werkzaamheden in te plannen.',
      afgewezen: 'U heeft deze offerte afgewezen. Neem gerust contact op als u een aangepaste offerte wilt.',
      verlopen: 'Deze offerte is verlopen. Neem contact op voor een nieuwe offerte.',
    }[status];
    $('#v-notice').textContent = notice || '';
    $('#v-notice').hidden = !notice;
    $('#print').innerHTML = QuoteView.documentHtml(quote, state.profile, { interactive: open });
    $('#v-sign').hidden = !open;
    if (open) {
      /**
       * Rekent het totaal opnieuw uit als de klant een optie aan- of uitvinkt.
       * @param {Event} event de wijziging
       */
      $('#print').onchange = (event) => {
        const id = event.target.dataset && event.target.dataset.opt;
        const line = id && quote.data.lines.find((candidate) => candidate.id === id);
        if (!line) return;
        line.selected = event.target.checked;
        const scrollPosition = window.scrollY;
        $('#print').innerHTML = QuoteView.documentHtml(quote, state.profile, { interactive: true });
        window.scrollTo(0, scrollPosition);
        form.update();
      };
      const form = QuoteView.signForm($('#v-sign'), {
        termsLink: Boolean(quote.data.terms),
        total: () => QuoteView.totalsOf(quote).total,
        onRespond: async (payload) => {
          const updated = await api(`quotes/${encodeURIComponent(quote.id)}/respond`, { method: 'POST', body: { ...payload, options: QuoteView.selectedOptions(quote) } });
          viewQuote(updated);
          toast(payload.answer === 'akkoord' ? 'Bedankt, de offerte is geaccordeerd' : 'De offerte is afgewezen');
        },
      });
    } else {
      $('#print').onchange = null;
      $('#v-sign').innerHTML = '';
    }
    window.scrollTo(0, 0);
  }

  /** Toont de waarschuwingen bij het opbouwen uit het plan. */
  function renderWarnings() {
    const warnings = state.warnings || [];
    $('#e-warnings').hidden = !warnings.length;
    $('#e-warnings').innerHTML = warnings.length ? `<b>Let op bij het plan:</b><ul>${warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul>` : '';
  }

  /**
   * Maakt de tabelregel voor een offerteregel.
   * @param {object} line de offerteregel
   * @returns {string} HTML van de regel
   */
  function lineRow(line) {
    const vat = QuoteCore.VAT_RATES.map((rate) => `<option value="${rate}"${rate === line.vat ? ' selected' : ''}>${rate}%</option>`).join('');
    const kind = line.optional ? (line.selected ? 'aan' : 'optie') : 'vast';
    const kinds = [['vast', 'Vast'], ['optie', 'Optie'], ['aan', 'Optie (aan)']]
      .map(([key, label]) => `<option value="${key}"${key === kind ? ' selected' : ''}>${label}</option>`).join('');
    // Code van een hoofdartikel: eerst een maat (variant) kiezen; bij een variant kan een andere maat.
    const picker = window.ArticlePicker;
    const parent = picker && line.code ? picker.parentOf(line.code) : null;
    const variantOf = picker && line.code && !parent ? picker.parentOfVariant(line.code) : null;
    const choose = parent ? '<button class="btn small primary ap-variant" data-pick-variant title="Dit artikel heeft varianten: kies de maat">Kies maat</button>'
      : variantOf ? '<button class="btn small ghost ap-variant" data-pick-variant title="Een andere variant van dit artikel kiezen">Andere maat</button>' : '';
    return `<tr class="line${line.optional ? ` opt${line.selected ? '' : ' off'}` : ''}" data-line="${esc(line.id)}">
      <td class="c-desc"><input data-l="description" value="${esc(line.description)}" maxlength="500" placeholder="Omschrijving">${line.code ? `<span class="code">${esc(line.code)}</span>` : ''}${choose}</td>
      <td class="c-qty"><input data-l="qty" class="num" type="number" step="any" value="${line.qty}" aria-label="Aantal"></td>
      <td class="c-unit"><input data-l="unit" value="${esc(line.unit)}" maxlength="12" aria-label="Eenheid"></td>
      <td class="c-price"><input data-l="price" class="num" type="number" step="0.01" value="${Number(line.price).toFixed(2)}" aria-label="Prijs per eenheid"></td>
      <td class="c-vat"><select data-l="vat" aria-label="Btw">${vat}</select></td>
      <td class="c-kind"><select data-l="kind" aria-label="Soort regel" title="Een optie kiest de klant zelf; 'Optie (aan)' staat standaard aangevinkt">${kinds}</select></td>
      <td class="c-total num" data-total>${eur(QuoteCore.lineTotal(line))}</td>
      <td class="c-del"><button class="btn ghost icon" data-del title="Regel verwijderen">✕</button></td>
    </tr>`;
  }

  /** Toont alle regels per onderdeel en de totalen. */
  function renderLines() {
    const data = state.quote.data;
    const totals = QuoteCore.totals(data);
    // De artikellijst (voor "Uit voorraad" en "Kies maat") één keer ophalen; daarna de regels opnieuw tekenen.
    if (window.ArticlePicker && !state.articlesRequested) {
      state.articlesRequested = true;
      window.ArticlePicker.load('../').then((articles) => { if (articles.length && state.quote) renderLines(); });
    }
    $('#e-lines').innerHTML = `<table class="lines">
      <thead><tr><th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th><th class="num">Prijs</th><th>Btw</th><th>Soort</th><th class="num">Totaal</th><th></th></tr></thead>
      <tbody>${Object.entries(QuoteCore.SECTIONS).map(([key, label]) => `
        <tr class="section"><td colspan="8">${esc(label)}<span class="sum" data-sum="${key}">${eur(totals.bySection[key] || 0)}</span></td></tr>
        ${data.lines.filter((line) => line.section === key).map(lineRow).join('')}
        <tr class="add"><td colspan="8"><button class="btn small" data-add="${key}">+ Regel ${esc(label.toLowerCase())}</button>${key === 'materiaal' && window.ArticlePicker ? ' <button class="btn small" data-pick-article title="Kies een artikel uit de voorraad, daarna de maat">+ Uit voorraad</button>' : ''}</td></tr>`).join('')}
      </tbody></table>`;
    renderTotals();
  }

  /** Werkt de subtotalen per onderdeel en de totalen bij. */
  function renderTotals() {
    const data = state.quote.data;
    const totals = QuoteCore.totals(data);
    for (const key of Object.keys(QuoteCore.SECTIONS)) {
      const element = $(`[data-sum="${key}"]`);
      if (element) element.textContent = eur(totals.bySection[key] || 0);
    }
    $('#e-totals').innerHTML = `
      <tr><td>Subtotaal</td><td class="num">${eur(totals.subtotal)}</td></tr>
      ${totals.discount ? `<tr><td>Korting ${nl(totals.discountPct)}%</td><td class="num">− ${eur(totals.discount)}</td></tr><tr><td>Totaal excl. btw</td><td class="num">${eur(totals.net)}</td></tr>` : ''}
      ${totals.vat.filter((vatRow) => vatRow.base).map((vatRow) => `<tr><td>Btw ${vatRow.rate}% over ${eur(vatRow.base)}</td><td class="num">${eur(vatRow.amount)}</td></tr>`).join('')}
      <tr class="grand"><td>Totaal incl. btw</td><td class="num">${eur(totals.total)}</td></tr>`;
  }

  /** Markeert de offerte als gewijzigd en slaat na een korte pauze op. */
  function changed() {
    state.dirty = true;
    $('#e-saved').textContent = 'Wijzigingen…';
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(save, 1200);
  }

  /**
   * Slaat de offerte op (wacht op een lopende opslag).
   * @param {object} extra extra velden voor de server, zoals status of customerId
   * @returns {Promise<void>|undefined} de lopende opslag
   */
  async function save(extra = {}) {
    clearTimeout(state.saveTimer);
    const quote = state.quote;
    if (!quote || locked()) { state.dirty = false; return; }
    if (state.saving) await state.saving;
    if (!state.dirty && !Object.keys(extra).length) return;
    state.dirty = false;
    $('#e-saved').textContent = 'Opslaan…';
    state.saving = (async () => {
      try {
        const result = await api(`quotes/${encodeURIComponent(quote.id)}`, { method: 'PUT', body: { data: quote.data, ...extra } });
        if (state.quote === quote) {
          quote.status = result.status;
          quote.totalIncl = result.totalIncl;
          quote.share = result.share;
          $('#e-saved').textContent = `Opgeslagen ${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`;
        }
      } catch (error) {
        if (error.code === 'locked') {
          // Inmiddels beantwoord door de klant: de serverversie tonen.
          $('#e-saved').textContent = '';
          toast(error.message, true);
          loadQuote(quote.id);
          return;
        }
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
   * Maakt een nieuwe lege regel voor een onderdeel.
   * @param {string} section 'materiaal', 'arbeid' of 'overig'
   * @returns {object} de nieuwe regel
   */
  function newLine(section) {
    const profile = state.profile;
    const labor = section === 'arbeid';
    return QuoteCore.sanitizeLine({
      id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, section,
      qty: 1, unit: labor ? 'uur' : section === 'overig' ? 'post' : 'st', price: labor ? profile.hourlyRate : 0, vat: profile.vatRate,
    });
  }

  /** Koppelt de invoer, knoppen en het menu van de editor. */
  function bindEditor() {
    const view = $('#edit-view');
    view.addEventListener('input', (event) => {
      const quote = state.quote;
      if (!quote || locked()) return;
      const field = event.target.dataset.f;
      if (field) {
        let value = event.target.value;
        if (field === 'discountPct') value = Math.min(100, Math.max(0, Number(value) || 0));
        setPath(quote.data, field, value);
        if (field === 'discountPct') renderTotals();
        return changed();
      }
      const key = event.target.dataset.l;
      const row = event.target.closest('[data-line]');
      if (!key || !row) return;
      const line = quote.data.lines.find((candidate) => candidate.id === row.dataset.line);
      if (!line) return;
      if (key === 'kind') {
        line.optional = event.target.value !== 'vast';
        line.selected = event.target.value === 'aan';
        row.className = `line${line.optional ? ` opt${line.selected ? '' : ' off'}` : ''}`;
      } else {
        line[key] = ['qty', 'price', 'vat'].includes(key) ? Number(event.target.value) || 0 : event.target.value;
      }
      $('[data-total]', row).textContent = eur(QuoteCore.lineTotal(line));
      renderTotals();
      changed();
    });
    // Datums en keuzelijsten melden zich soms alleen met 'change'.
    view.addEventListener('change', (event) => {
      if (event.target.matches('select[data-l], select[data-f], input[type=date]')) event.target.dispatchEvent(new Event('input', { bubbles: true }));
    });
    view.addEventListener('click', (event) => {
      const quote = state.quote;
      const shareButton = event.target.closest('[data-sh]');
      if (shareButton) return shareAction(shareButton.dataset.sh);
      if (locked()) return;
      const addButton = event.target.closest('[data-add]');
      if (addButton && quote) {
        const section = addButton.dataset.add;
        const line = newLine(section);
        // Na de laatste regel van dezelfde sectie invoegen.
        let at = -1;
        quote.data.lines.forEach((existing, i) => { if (existing.section === section) at = i; });
        quote.data.lines.splice(at < 0 ? quote.data.lines.length : at + 1, 0, line);
        renderLines();
        const input = $(`[data-line="${line.id}"] [data-l=description]`);
        if (input) input.focus();
        return changed();
      }
      if (event.target.closest('[data-pick-article]') && quote) {
        window.ArticlePicker.open({
          base: '../',
          /**
           * Zet het gekozen artikel (of de gekozen variant) als materiaalregel met verkoopprijs en btw.
           * @param {object} article code, name, unit, salePrice en vatRate
           */
          onPick: (article) => {
            if (state.quote !== quote || locked()) return;
            const line = QuoteCore.sanitizeLine({ ...newLine('materiaal'), code: article.code, description: article.name, unit: article.unit || 'st',
              price: article.salePrice == null ? 0 : article.salePrice, vat: article.vatRate == null ? state.profile.vatRate : article.vatRate });
            let at = -1;
            quote.data.lines.forEach((existing, i) => { if (existing.section === 'materiaal') at = i; });
            quote.data.lines.splice(at < 0 ? quote.data.lines.length : at + 1, 0, line);
            renderLines();
            changed();
          },
        });
        return undefined;
      }
      const pickVariant = event.target.closest('[data-pick-variant]');
      if (pickVariant && quote) {
        const line = quote.data.lines.find((candidate) => candidate.id === pickVariant.closest('[data-line]').dataset.line);
        if (!line) return undefined;
        const parent = window.ArticlePicker.parentOf(line.code) || window.ArticlePicker.parentOfVariant(line.code);
        window.ArticlePicker.open({
          base: '../', parentCode: parent ? parent.code : '', variantCode: line.code,
          /**
           * Vervangt de regel door de gekozen variant: code, omschrijving en (als bekend) prijs; aantal blijft.
           * @param {object} article code, name, unit, salePrice en vatRate
           */
          onPick: (article) => {
            if (state.quote !== quote || locked()) return;
            line.code = article.code;
            line.description = article.name;
            if (article.unit) line.unit = article.unit;
            if (article.salePrice != null) line.price = article.salePrice;
            if (article.vatRate != null) line.vat = article.vatRate;
            renderLines();
            changed();
          },
        });
        return undefined;
      }
      const deleteButton = event.target.closest('[data-del]');
      if (deleteButton && quote) {
        const id = deleteButton.closest('[data-line]').dataset.line;
        quote.data.lines = quote.data.lines.filter((line) => line.id !== id);
        renderLines();
        return changed();
      }
    });
    /**
     * Slaat een andere status op en werkt de werkorderknop bij.
     * @param {Event} event de wijziging
     * @returns {Promise<void>}
     */
    $('#e-status').onchange = async (event) => {
      await save({ status: event.target.value });
      if (state.quote) renderWorkOrder(state.quote);
    };
    /**
     * Koppelt de offerte aan een ander klantaccount.
     * @param {Event} event de wijziging
     * @returns {Promise<void>}
     */
    $('#e-account').onchange = async (event) => {
      const quote = state.quote;
      await save({ customerId: event.target.value || null });
      if (state.quote === quote) quote.customerId = event.target.value || null;
    };
    /**
     * Slaat op en gaat terug naar de herkomst of het overzicht.
     * @returns {Promise<void>}
     */
    $('#e-back').onclick = async () => { await save(); if (state.back) state.back.go(); else go(''); };
    $('#e-pdf').onclick = printQuote;
    $('#e-xlsx').onclick = exportQuoteXlsx;
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
   * @param {string} action 'replan', 'openplan', 'duplicate', 'delete' of 'purge'
   * @returns {Promise<void>}
   */
  async function menuAction(action) {
    const quote = state.quote;
    if (!quote) return;
    if (action === 'replan') {
      if (!confirm('De regels voor materialen en arbeid opnieuw uit het plan overnemen? Aangepaste prijzen en aantallen in die onderdelen gaan verloren; regels onder "Overig" blijven staan.')) return;
      try {
        const plan = await api(`plans/${encodeURIComponent(quote.data.planId)}`);
        const built = QuoteCore.fromPlan(plan.data, LIB(), state.profile);
        const keep = quote.data.lines.filter((line) => line.section === 'overig');
        const extra = built.lines.filter((line) => line.section === 'overig' && !keep.some((kept) => kept.description === line.description));
        quote.data.lines = [...built.lines.filter((line) => line.section !== 'overig'), ...keep, ...extra].map((line, i) => ({ ...line, id: `r${Date.now().toString(36)}${i}` }));
        quote.data.planTitle = plan.title;
        quote.data.planSummary = built.summary;
        state.warnings = built.warnings;
        openQuote(quote);
        changed();
        toast('Regels bijgewerkt uit het plan');
      } catch (error) {
        toast(`Kan het plan niet laden: ${error.message}`, true);
      }
    } else if (action === 'openplan') {
      await save();
      location.href = `../beregening/?plan=${encodeURIComponent(quote.data.planId)}`;
    } else if (action === 'duplicate') {
      await save();
      const today = QuoteCore.today();
      createEmpty({ ...JSON.parse(JSON.stringify(quote.data)), date: today, validUntil: QuoteCore.addDays(today, state.profile.validDays || 30) });
    } else if (action === 'delete') {
      const body = acceptedConfirm(quote, 'verwijderen');
      if (body === null) return;
      if (!body && !confirm(`Offerte ${quote.number} verwijderen?`)) return;
      try {
        await api(`quotes/${encodeURIComponent(quote.id)}`, { method: 'DELETE', body: body || undefined });
        state.dirty = false;
        toast(`Offerte ${quote.number} verwijderd`);
        go('');
      } catch (error) {
        toast(`Verwijderen mislukt: ${error.message}`, true);
      }
    } else if (action === 'purge') {
      const body = acceptedConfirm(quote, 'definitief wissen');
      if (body === null) return;
      if (!body && !confirm(`Offerte ${quote.number} definitief wissen, inclusief klantgegevens? Dit kan niet ongedaan worden gemaakt.`)) return;
      try {
        await api(`admin/quotes/${encodeURIComponent(quote.id)}`, { method: 'DELETE', body: body || undefined });
        state.dirty = false;
        toast(`Offerte ${quote.number} gewist`);
        go('');
      } catch (error) {
        toast(`Wissen mislukt: ${error.message}`, true);
      }
    }
  }

  /**
   * Vraagt bij een geaccordeerde offerte om het offertenummer over te typen.
   * @param {object} quote de offerte
   * @param {string} action wat er gebeurt, voor in de vraag
   * @returns {{confirm: string}|false|null} de bevestiging, false als die niet nodig is, null bij afbreken of vertypen
   */
  function acceptedConfirm(quote, action) {
    if (quote.status !== 'akkoord') return false;
    const typed = prompt(`Offerte ${quote.number} is geaccordeerd door de klant${quote.acceptance?.name ? ` (${quote.acceptance.name})` : ''}.\n\nWeet je zeker dat je deze offerte wilt ${action}? Gekoppelde werkorders blijven bestaan. Dit kan niet ongedaan worden gemaakt.\n\nTyp ter bevestiging het offertenummer "${quote.number}":`);
    if (typed == null) return null;
    if (typed.trim() !== quote.number) { toast('Het offertenummer klopt niet; er is niets verwijderd.', true); return null; }
    return { confirm: typed.trim() };
  }

  // ---------- PDF (afdrukversie) ----------
  /** Zet de afdrukversie van de offerte klaar. */
  function renderPrint() {
    $('#print').innerHTML = QuoteView.documentHtml(state.quote, state.profile);
  }

  /**
   * Slaat op en opent het afdrukvenster (ook voor Opslaan als PDF).
   * @returns {Promise<void>}
   */
  async function printQuote() {
    await save();
    renderPrint();
    // De bestandsnaam van "Opslaan als PDF" volgt de paginatitel.
    const oldTitle = document.title;
    const customerName = state.quote.data.customer.name;
    document.title = `Offerte ${state.quote.number}${customerName ? ` ${customerName}` : ''}`;
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
   * Exporteert de open offerte als Excel-bestand met formules voor de totalen.
   * @returns {Promise<void>}
   */
  async function exportQuoteXlsx() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    await save();
    const quote = state.quote;
    const data = quote.data;
    const profile = state.profile;
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = profile.companyName || 'AquaTech Service';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Offerte', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      sheet.columns = [{ width: 14 }, { width: 58 }, { width: 10 }, { width: 8 }, { width: 13 }, { width: 8 }, { width: 14 }];
      const eurFmt = '€ #,##0.00';
      const bold = { bold: true };
      sheet.addRow([profile.companyName]).font = { bold: true, size: 14, color: { argb: NAVY } };
      for (const infoLine of [profile.address, [profile.phone, profile.email].filter(Boolean).join(' · '), [profile.kvk && `KvK ${profile.kvk}`, profile.vatNumber && `Btw ${profile.vatNumber}`, profile.iban && `IBAN ${profile.iban}`].filter(Boolean).join(' · ')]) {
        if (infoLine) sheet.addRow([infoLine.replace(/\n/g, ', ')]);
      }
      sheet.addRow([]);
      const info = [
        ['Offerte', quote.number], ['Datum', data.date ? new Date(`${data.date}T12:00:00`) : ''], ['Geldig tot', data.validUntil ? new Date(`${data.validUntil}T12:00:00`) : ''],
        ['Klant', data.customer.name], ['T.a.v.', data.customer.contact], ['Adres', data.customer.address.replace(/\n/g, ', ')],
        ['E-mail', data.customer.email], ['Telefoon', data.customer.phone], ['Uw referentie', data.reference], ['Omschrijving', data.title],
        ['Status', statusLabel(statusOf({ ...quote, validUntil: data.validUntil }))],
      ].filter(([, value]) => value !== '');
      for (const [label, value] of info) {
        const row = sheet.addRow([label, value]);
        row.getCell(1).font = bold;
        if (value instanceof Date) row.getCell(2).numFmt = 'dd-mm-yyyy';
        row.getCell(2).alignment = { horizontal: 'left' };
      }
      sheet.addRow([]);
      const head = sheet.addRow(['Artikelcode', 'Omschrijving', 'Aantal', 'Eenheid', 'Prijs', 'Btw %', 'Totaal']);
      head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      const firstRow = head.number + 1;
      const subtotalCells = [];
      for (const [key, label] of Object.entries(QuoteCore.SECTIONS)) {
        const lines = data.lines.filter((line) => line.section === key);
        if (!lines.length) continue;
        const sectionRow = sheet.addRow(['', label]);
        sectionRow.font = { bold: true, color: { argb: NAVY } };
        const start = sectionRow.number + 1;
        for (const line of lines) {
          const notChosen = !QuoteCore.included(line);
          const row = sheet.addRow([line.code, `${line.description}${line.optional ? (notChosen ? ' (optie, niet gekozen)' : ' (optie)') : ''}`, line.qty, line.unit, line.price, line.vat]);
          // Een niet gekozen optie telt niet mee in de totalen.
          row.getCell(7).value = notChosen ? 0 : { formula: `C${row.number}*E${row.number}` };
          if (notChosen) row.font = { italic: true, color: { argb: 'FF8A96A3' } };
          row.getCell(5).numFmt = eurFmt;
          row.getCell(7).numFmt = eurFmt;
        }
        const end = sheet.lastRow.number;
        const sumRow = sheet.addRow(['', `Totaal ${label.toLowerCase()}`]);
        sumRow.getCell(7).value = { formula: `SUM(G${start}:G${end})` };
        sumRow.getCell(7).numFmt = eurFmt;
        sumRow.font = bold;
        subtotalCells.push(`G${sumRow.number}`);
      }
      const lastRow = sheet.lastRow.number;
      sheet.addRow([]);
      /**
       * Voegt een regel onder de totalen toe.
       * @param {string} label tekst voor de regel
       * @param {object|number} formula formule of waarde
       * @param {string} numberFormat celopmaak (standaard euro)
       * @returns {number} rijnummer van de nieuwe regel
       */
      const addTotalRow = (label, formula, numberFormat = eurFmt) => {
        const row = sheet.addRow(['', '', '', '', '', label]);
        row.getCell(7).value = formula;
        row.getCell(7).numFmt = numberFormat;
        row.getCell(6).alignment = { horizontal: 'right' };
        row.getCell(6).font = bold;
        row.getCell(7).font = bold;
        return row.number;
      };
      const subtotalRow = addTotalRow('Subtotaal', { formula: subtotalCells.length ? subtotalCells.join('+') : '0' });
      const discountRow = addTotalRow('Korting %', data.discountPct / 100, '0.0%');
      const netRow = addTotalRow('Excl. btw', { formula: `G${subtotalRow}*(1-G${discountRow})` });
      const vatRows = [];
      // Btw per tarief: de regels met dat tarief, na korting.
      for (const rate of QuoteCore.VAT_RATES) {
        if (!data.lines.some((line) => line.vat === rate && QuoteCore.included(line))) continue;
        vatRows.push(addTotalRow(`Btw ${rate}%`, { formula: `SUMIF(F${firstRow}:F${lastRow},${rate},G${firstRow}:G${lastRow})*(1-G${discountRow})*${rate / 100}` }));
      }
      const grand = addTotalRow('Totaal incl. btw', { formula: `G${netRow}${vatRows.map((rowNumber) => `+G${rowNumber}`).join('')}` });
      sheet.getRow(grand).getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF19924F' } };
      sheet.getRow(grand).getCell(7).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      for (const [title, text] of [['Inleiding', data.intro], ['Voorwaarden', data.terms]]) {
        if (!text) continue;
        sheet.addRow([]);
        sheet.addRow([title]).font = bold;
        const row = sheet.addRow(['', text]);
        row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
        row.height = Math.min(400, 15 * Math.ceil(text.length / 80 + (text.match(/\n/g) || []).length));
      }
      download(new Blob([await workbook.xlsx.writeBuffer()], { type: XLSX_TYPE }), `offerte_${safeName(quote.number)}${data.customer.name ? `_${safeName(data.customer.name)}` : ''}.xlsx`);
    } catch (error) {
      console.error(error);
      toast(`Export mislukt: ${error.message}`, true);
    }
  }

  /**
   * Exporteert de zichtbare offertes als Excel-bestand.
   * @returns {Promise<void>}
   */
  async function exportListXlsx() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const items = visible();
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'AquaTech Service';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Offertes', { views: [{ state: 'frozen', ySplit: 1 }] });
      sheet.columns = [
        { header: 'Nummer', key: 'number', width: 16 },
        { header: 'Omschrijving', key: 'title', width: 40 },
        { header: 'Klant', key: 'customer', width: 28 },
        ...(showAll() ? [{ header: 'Gebruiker', key: 'owner', width: 20 }] : []),
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Excl. btw', key: 'totalExcl', width: 14, style: { numFmt: '€ #,##0.00' } },
        { header: 'Incl. btw', key: 'totalIncl', width: 14, style: { numFmt: '€ #,##0.00' } },
        { header: 'Geldig tot', key: 'validUntil', width: 13, style: { numFmt: 'dd-mm-yyyy' } },
        { header: 'Aangemaakt', key: 'createdAt', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
        { header: 'Laatst gewijzigd', key: 'updatedAt', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
      ];
      for (const quote of items) {
        sheet.addRow({
          number: quote.number, title: quote.title, customer: quote.customer, owner: quote.owner ? quote.owner.displayName : '', status: statusLabel(statusOf(quote)),
          totalExcl: quote.totalExcl, totalIncl: quote.totalIncl, validUntil: quote.validUntil ? new Date(`${quote.validUntil}T12:00:00`) : null,
          createdAt: new Date(quote.createdAt), updatedAt: new Date(quote.updatedAt),
        });
      }
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
      download(new Blob([await workbook.xlsx.writeBuffer()], { type: XLSX_TYPE }), `offertes_${QuoteCore.today()}.xlsx`);
      toast(`${items.length} offertes geëxporteerd`);
    } catch (error) {
      toast(`Export mislukt: ${error.message}`, true);
    }
  }

  // ---------- Bedrijfsgegevens ----------
  /** Opent het venster met de bedrijfsgegevens. */
  function openProfile() {
    const form = $('#pf');
    for (const field of form.elements) if (field.name) field.value = state.profile[field.name] ?? '';
    $('#profile').hidden = false;
  }

  /**
   * Slaat de bedrijfsgegevens op.
   * @param {SubmitEvent} event het verzenden van het formulier
   * @returns {Promise<void>}
   */
  async function saveProfile(event) {
    event.preventDefault();
    const form = $('#pf');
    const profile = {};
    for (const field of form.elements) {
      if (!field.name) continue;
      profile[field.name] = field.type === 'number' || field.name === 'vatRate' ? Number(field.value) : field.value;
    }
    try {
      state.profile = (await api('quote-profile', { method: 'PUT', body: { profile } })).profile;
      $('#profile').hidden = true;
      toast('Bedrijfsgegevens opgeslagen');
    } catch (error) {
      toast(`Opslaan mislukt: ${error.message}`, true);
    }
  }

  // ---------- Navigatie ----------
  /** Toont het overzicht en laadt de offertes opnieuw. */
  function showList() {
    state.quote = null;
    state.warnings = [];
    document.title = `${state.klant ? 'Mijn offertes' : 'Offertes'} – AquaTech Service`;
    document.body.classList.remove('view-doc');
    $('#print').setAttribute('aria-hidden', 'true');
    $('#view-view').hidden = true;
    $('#v-sign').hidden = true;
    $('#edit-view').hidden = true;
    $('#list-view').hidden = false;
    loadList();
  }

  /**
   * Toont het scherm dat bij het adres hoort (nieuw uit plan, offerte of overzicht).
   * @returns {Promise<void>}
   */
  async function route() {
    const query = params();
    if (state.quote && state.dirty) await save();
    if (query.get('plan') && !state.klant) return createFromPlan(query.get('plan'));
    if (query.get('id')) return loadQuote(query.get('id'));
    showList();
  }

  /**
   * Start de pagina: rechten, bedrijfsprofiel en klanten ophalen en knoppen koppelen.
   * @returns {Promise<void>}
   */
  async function init() {
    const query = params();
    const direct = query.get('id') || query.get('plan');
    // Rechtstreeks naar een offerte (vanuit portaal, dossier, werkorder of
    // planner): het overzicht niet eerst laten zien, en de terugknop gaat
    // terug naar waar je vandaan kwam.
    if (direct) $('#list-view').hidden = true;
    const from = direct && window.AquatechCommon ? window.AquatechCommon.origin() : null;
    if (from) {
      state.back = from;
      $('#e-back').textContent = from.label;
      $('#v-back').textContent = from.label;
    }
    // De offerte alvast ophalen, tegelijk met api/me.
    if (query.get('id') && !query.get('plan') && location.protocol !== 'file:') {
      const request = api(`quotes/${encodeURIComponent(query.get('id'))}`);
      request.catch(() => {});
      state.prefetch = { id: query.get('id'), request };
    }
    // Webshopprijzen (als de organisatie een webshop heeft gekoppeld) vóór het opbouwen uit een plan.
    const shop = window.ShopCatalog ? window.ShopCatalog.load() : null;
    state.me = await window.AquatechAccount.load('../');
    const rights = state.me.rights || [];
    state.admin = rights.includes('beheer');
    state.all = rights.includes('offertes.alle');
    state.klant = !rights.includes('offertes') && rights.includes('offertes.klant');
    state.werkorders = rights.includes('werkorders');
    if (!state.me.user && !state.me.guest) {
      $('#list-view').hidden = false;
      $('#l-table').innerHTML = '<tr><td class="empty">Log eerst in om offertes te maken. <a href="../login">Inloggen</a></td></tr>';
      return;
    }
    // Bedrijfsprofiel, klanten en webshopprijzen tegelijk.
    const [profileResult, customers] = await Promise.all([
      api('quote-profile').catch(() => null),
      state.klant ? null : api('quote-customers').catch(() => null),
      shop,
    ]);
    if (profileResult) {
      state.profile = profileResult.profile;
      state.canEdit = profileResult.canEdit;
      state.mail = Boolean(profileResult.mail);
    } else {
      // Gast zonder account (nog niets bewaard): standaardwaarden van de server ontbreken.
      state.profile = { companyName: 'AquaTech Service', hourlyRate: 55, hourlyCost: 0, validDays: 30, vatRate: 21, markupPct: 0, callOutFee: 0, intro: '', terms: '' };
    }
    $('#l-status').innerHTML = '<option value="">Alle statussen</option>' + [...Object.keys(QuoteCore.STATUSES), 'verlopen']
      .map((status) => `<option value="${status}">${esc(statusLabel(status))}</option>`).join('');
    $('#e-status').innerHTML = Object.entries(QuoteCore.STATUSES).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('');
    $('#l-all-wrap').hidden = !state.all;
    $('#l-profile').hidden = !state.canEdit;
    if (state.klant) {
      $('.brand-name').textContent = 'Mijn offertes';
      $('#l-heading').textContent = 'Mijn offertes';
      $('#l-intro').textContent = 'De offertes die voor u klaarstaan. Open een offerte om die te bekijken, af te drukken en akkoord te geven of af te wijzen.';
      for (const id of ['#l-new-plan', '#l-new-empty', '#l-profile']) $(id).hidden = true;
      $('#l-status').innerHTML = '<option value="">Alle statussen</option>' + ['verzonden', 'akkoord', 'afgewezen', 'verlopen']
        .map((status) => `<option value="${status}">${esc(statusLabel(status))}</option>`).join('');
    } else {
      state.customers = (customers && customers.items) || [];
    }
    /** Gaat terug naar de herkomst of het overzicht. */
    $('#v-back').onclick = () => { if (state.back) state.back.go(); else go(''); };
    /** Opent het afdrukvenster. */
    $('#v-pdf').onclick = () => { window.print(); };
    let searchTimer;
    /** Filtert het overzicht kort na het typen. */
    $('#l-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 150); };
    $('#l-status').onchange = renderList;
    $('#l-all').onchange = loadList;
    $('#l-new-plan').onclick = pickPlan;
    /** Maakt een lege offerte. */
    $('#l-new-empty').onclick = () => { createEmpty(); };
    $('#l-profile').onclick = openProfile;
    $('#l-export').onclick = exportListXlsx;
    $('#pf').onsubmit = saveProfile;
    $('#sf').onsubmit = sendQuote;
    document.querySelectorAll('.modal').forEach((modal) => {
      /**
       * Sluit het venster bij een klik naast het venster of op een sluitknop.
       * @param {MouseEvent} event de klik
       */
      modal.onclick = (event) => { if (event.target === modal || event.target.closest('[data-close]')) modal.hidden = true; };
    });
    bindEditor();
    window.addEventListener('popstate', route);
    // Terug via de knop Terug van de browser: het overzicht opnieuw laden.
    if (window.AquatechCommon) window.AquatechCommon.onReturn(() => { if (!state.quote) loadList(); });
    route();
  }

  init();
})();
