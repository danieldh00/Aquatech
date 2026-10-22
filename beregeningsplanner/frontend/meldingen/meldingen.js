// Meldingen: storingen en onderhoudsverzoeken van klanten (uit het
// klantportaal). Medewerkers (recht 'werkorders') zien het overzicht, openen
// een melding (?id=<id>), sturen de klant een reactie, houden een interne
// notitie bij en maken er een werkorder van. Gegevens uit /api/service-requests.
(function () {
  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @param {ParentNode} [root] Waarbinnen gezocht wordt (standaard de pagina).
   * @returns {Element|null} Het element.
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Datum met weekdag in het Nederlands.
   * @param {string} date Datum als JJJJ-MM-DD.
   * @returns {string} Bijv. "do 22 oktober 2026" (leeg zonder datum).
   */
  const day = (date) => (date ? new Date(`${date}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : '');
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15" (leeg zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const KINDS = { storing: 'Storing', onderhoud: 'Onderhoud', overig: 'Vraag of verzoek' };
  const STATUSES = { nieuw: 'Nieuw', in_behandeling: 'In behandeling', ingepland: 'Werkorder gemaakt', afgehandeld: 'Afgehandeld', afgewezen: 'Afgewezen', ingetrokken: 'Ingetrokken door klant' };
  const OPEN = ['nieuw', 'in_behandeling'];

  const state = { items: [], item: null, staff: null };

  /**
   * Toont een melding onderin beeld (3,5 s).
   * @param {string} message De melding.
   * @param {boolean} [isError] true = foutmelding.
   */
  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast show${isError ? ' err' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = 'toast'; }, 3500);
  }

  /**
   * Roept de API aan (relatief vanaf meldingen/).
   * @param {string} path Pad onder api/.
   * @param {object} [options] { method, body }; body gaat als JSON.
   * @returns {Promise<object>} Het antwoord (fout = Error met `status` en `code`).
   */
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`../api/${path}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.message || `HTTP ${res.status}`), { status: res.status, code: out.error });
    return out;
  }

  /**
   * Statuslabel van een melding (met "Spoed" als dat zo is).
   * @param {object} request De melding.
   * @returns {string} HTML van het label.
   */
  const pill = (request) => `<span class="pill st-${esc(request.status)}">${esc(STATUSES[request.status] || request.status)}</span>${request.urgent ? ' <span class="pill spoed">Spoed</span>' : ''}`;

  // ---------- Overzicht ----------
  /**
   * Haalt de meldingen op (alleen open, of alle) en tekent het overzicht.
   * @returns {Promise<void>}
   */
  async function load() {
    const showAll = $('#m-all').checked;
    state.items = (await api(`service-requests${showAll ? '' : '?open=1'}`)).items;
    render();
  }

  /** Tekent de tabel met meldingen. */
  function render() {
    const rows = state.items.map((request) => `
      <tr data-id="${esc(request.id)}" class="st-${esc(request.status)}">
        <td><b>${esc(request.number)}</b><span class="sub">${esc(when(request.createdAt))}</span></td>
        <td>${esc(request.customer.name)}<span class="sub">${esc(request.address)}</span></td>
        <td>${esc(KINDS[request.kind] || request.kind)}</td>
        <td class="wrap">${esc(request.subject)}${request.photoCount ? `<span class="sub">${request.photoCount} foto${request.photoCount > 1 ? "'s" : ''}</span>` : ''}</td>
        <td>${pill(request)}${request.workOrder ? `<span class="sub">${esc(request.workOrder.number)}${request.workOrder.plannedDate ? ` · ${esc(day(request.workOrder.plannedDate))}` : ''}</span>` : ''}</td>
      </tr>`).join('');
    $('#m-table').innerHTML = `<thead><tr><th>Melding</th><th>Klant</th><th>Soort</th><th>Onderwerp</th><th>Status</th></tr></thead><tbody>${rows}</tbody>`;
    $('#m-table').hidden = !state.items.length;
    $('#m-empty').hidden = Boolean(state.items.length);
  }

  // ---------- Detail ----------
  /**
   * Opent een melding in het detailvenster en zet ?id= in de adresbalk.
   * @param {string} id Id van de melding.
   * @param {object} [preloaded] De melding als die al is opgehaald.
   * @returns {Promise<void>}
   */
  async function open(id, preloaded) {
    try {
      state.item = preloaded || await api(`service-requests/${encodeURIComponent(id)}`);
    } catch (error) {
      toast(error.status === 404 ? 'Deze melding bestaat niet (meer).' : `Kan de melding niet openen: ${error.message}`, true);
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('id', state.item.id);
    history.replaceState(null, '', url);
    renderDetail();
    $('#detail').hidden = false;
  }

  /** Sluit het detailvenster en haalt ?id= uit de adresbalk. */
  function close() {
    $('#detail').hidden = true;
    const url = new URL(location.href);
    url.searchParams.delete('id');
    history.replaceState(null, '', url);
  }

  /**
   * Medewerkers aan wie een werkorder toegewezen kan worden (één keer opgehaald).
   * @returns {Promise<object[]>} De medewerkers.
   */
  async function staff() {
    if (!state.staff) state.staff = (await api('workorder-staff')).items;
    return state.staff;
  }

  /** Tekent het detailvenster: gegevens, foto's, werkorder maken en het formulier voor reactie en status. */
  function renderDetail() {
    const request = state.item;
    const photos = request.photos || [];
    const canConvert = !request.workOrder && request.status !== 'afgewezen' && request.status !== 'ingetrokken';
    const statuses = request.workOrder ? ['afgehandeld'] : ['nieuw', 'in_behandeling', 'afgehandeld', 'afgewezen'];
    $('#detail-body').innerHTML = `
      <div class="req">
        <h2>${esc(request.number)}: ${esc(request.subject)}</h2>
        <div>${pill(request)}</div>
        <dl class="kv">
          <dt>Soort</dt><dd>${esc(KINDS[request.kind] || request.kind)}${request.urgent ? ' (spoed)' : ''}</dd>
          <dt>Gemeld</dt><dd>${esc(when(request.createdAt))}</dd>
          <dt>Klant</dt><dd>${esc(request.customer.name)}</dd>
          ${request.address ? `<dt>Adres</dt><dd>${esc(request.address)}</dd>` : ''}
          ${request.phone ? `<dt>Telefoon</dt><dd><a href="tel:${esc(request.phone.replace(/[^\d+]/g, ''))}">${esc(request.phone)}</a></dd>` : ''}
          ${request.email ? `<dt>E-mail</dt><dd><a href="mailto:${esc(request.email)}">${esc(request.email)}</a></dd>` : ''}
          ${request.preferred ? `<dt>Voorkeur</dt><dd>${esc(request.preferred)}</dd>` : ''}
          ${request.installation ? `<dt>Installatie</dt><dd><a href="../werkorders/?id=${encodeURIComponent(request.installation.id)}">${esc(request.installation.number)}</a> ${esc(request.installation.title)}</dd>` : ''}
          ${request.workOrder ? `<dt>Werkorder</dt><dd><a href="../werkorders/?id=${encodeURIComponent(request.workOrder.id)}">${esc(request.workOrder.number)}</a>${request.workOrder.plannedDate ? `, gepland ${esc(day(request.workOrder.plannedDate))}` : ', nog niet ingepland'}</dd>` : ''}
          ${request.handledBy ? `<dt>Behandeld door</dt><dd>${esc(request.handledBy)} (${esc(when(request.updatedAt))})</dd>` : ''}
        </dl>
        <h3>Omschrijving van de klant</h3><div class="text">${esc(request.description)}</div>
        ${photos.length ? `<h3>Foto's van de klant</h3><div class="photos">${photos.map((photo, i) => `
          <button type="button" data-photo="${i}" title="Vergroten"><img src="../${esc(photo.thumbUrl)}" alt="Foto ${i + 1}" loading="lazy"></button>`).join('')}</div>` : ''}
        ${canConvert ? `<div class="box">
          <h3>Werkorder maken</h3>
          <p class="small muted">Klantgegevens, omschrijving${request.installation ? ', ontwerp en zones van de installatie' : ''} en de foto's gaan mee. De klant ziet de werkorder en de afspraak in zijn portaal.</p>
          <div class="row"><label>Uitvoerder<select id="d-assignee"><option value="">Nog niet toewijzen</option></select></label>
            <button class="btn primary" id="d-convert" type="button">Werkorder maken</button></div>
        </div>` : ''}
        <form id="d-form" novalidate>
          <h3>Reactie en status</h3>
          <label>Reactie aan de klant (ziet hij in zijn portaal en per e-mail)<textarea name="reply" rows="3" maxlength="4000">${esc(request.reply)}</textarea></label>
          <label>Interne notitie (alleen voor medewerkers)<textarea name="note" rows="2" maxlength="4000">${esc(request.note)}</textarea></label>
          <div class="row">
            <label>Status<select name="status">${(statuses.includes(request.status) ? statuses : [request.status, ...statuses])
              .map((status) => `<option value="${status}"${status === request.status ? ' selected' : ''}${status === 'ingepland' || status === 'ingetrokken' ? ' disabled' : ''}>${esc(STATUSES[status])}</option>`).join('')}</select></label>
            <button class="btn primary" type="submit">Opslaan</button>
          </div>
          <div class="err" role="alert"></div>
        </form>
      </div>`;
    document.querySelectorAll('#detail-body [data-photo]').forEach((button) => {
      /**
       * Opent de foto's van de klant groot.
       * @returns {void}
       */
      button.onclick = () => window.PhotoViewer.show(photos.map((photo, i) => ({ src: `../${photo.url}`, caption: `Foto ${i + 1} van de klant`, sub: request.number })), Number(button.dataset.photo));
    });
    $('#d-form').addEventListener('submit', save);
    const conv = $('#d-convert');
    if (conv) {
      conv.onclick = convert;
      staff().then((list) => {
        const sel = $('#d-assignee');
        if (sel) sel.insertAdjacentHTML('beforeend', list.map((user) => `<option value="${esc(user.id)}">${esc(user.displayName)}</option>`).join(''));
      }).catch(() => {});
    }
  }

  /**
   * Slaat reactie, notitie en status op.
   * @param {SubmitEvent} event Het verzenden.
   * @returns {Promise<void>}
   */
  async function save(event) {
    event.preventDefault();
    const form = event.target;
    const body = { reply: form.reply.value, note: form.note.value };
    if (form.status.value !== state.item.status) body.status = form.status.value;
    try {
      state.item = await api(`service-requests/${encodeURIComponent(state.item.id)}`, { method: 'PUT', body });
      toast('Opgeslagen.');
      renderDetail();
      load();
    } catch (error) {
      form.querySelector('.err').textContent = error.message;
    }
  }

  /**
   * Maakt een werkorder van de melding en gaat er direct heen.
   * @returns {Promise<void>}
   */
  async function convert() {
    const button = $('#d-convert');
    button.disabled = true;
    try {
      const out = await api(`service-requests/${encodeURIComponent(state.item.id)}/workorder`, { method: 'POST', body: { assigneeId: $('#d-assignee').value || null } });
      state.item = out.item;
      toast(`Werkorder ${out.workOrder.number} gemaakt.`);
      // Direct door naar de werkorder om hem in te vullen en in te plannen.
      location.href = `../werkorders/?id=${encodeURIComponent(out.workOrder.id)}`;
    } catch (error) {
      button.disabled = false;
      toast(error.message, true);
    }
  }

  /**
   * Controleert de login, koppelt de knoppen en laadt overzicht en (met ?id=) de melding tegelijk.
   * @returns {Promise<void>}
   */
  async function init() {
    const id = new URLSearchParams(location.search).get('id');
    // Melding en overzicht al ophalen terwijl de login-check loopt.
    const item = id ? api(`service-requests/${encodeURIComponent(id)}`).catch((error) => error) : null;
    const me = await window.AquatechAccount.load('../');
    if (!me.user || !(me.rights || []).includes('werkorders')) {
      const denied = $('#m-denied');
      denied.hidden = false;
      denied.innerHTML = me.user && me.user.kind !== 'gast'
        ? 'Meldingen zijn er voor medewerkers. Als klant meldt u een storing in <a href="../portaal/#melden">Mijn portaal</a>.'
        : 'Log eerst in. <a href="../login">Inloggen</a>';
      return;
    }
    $('#m-app').hidden = false;
    /**
     * Toont alle meldingen of alleen de open meldingen.
     * @returns {Promise<void>}
     */
    $('#m-all').onchange = () => load().catch((error) => toast(error.message, true));
    $('#detail-close').onclick = close;
    /**
     * Sluit het detailvenster bij een klik naast het venster.
     * @param {MouseEvent} event De klik.
     */
    $('#detail').onclick = (event) => { if (event.target.id === 'detail') close(); };
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('#detail').hidden && (!document.querySelector('.ph-viewer') || document.querySelector('.ph-viewer').hidden)) close();
    });
    $('#m-table').addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-id]');
      if (row) open(row.dataset.id);
    });
    await Promise.all([
      load().catch((error) => toast(`Kan de meldingen niet laden: ${error.message}`, true)),
      item ? item.then((loaded) => (loaded instanceof Error ? toast(loaded.status === 404 ? 'Deze melding bestaat niet (meer).' : loaded.message, true) : open(loaded.id, loaded))) : null,
    ]);
    if (window.AquatechCommon) window.AquatechCommon.onReturn(() => load().catch(() => {}));
  }

  init();
})();
