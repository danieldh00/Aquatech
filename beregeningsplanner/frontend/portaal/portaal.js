// Klantportaal: wat er voor de klant klaarstaat (offertes om te beantwoorden,
// afspraken om te bevestigen), de werkzaamheden met voortgang, de offertes,
// de eigen plannen en per werkorder het opleverdossier met foto's.
// Alle gegevens komen uit api/portal; de server bepaalt wat de klant ziet.
(function () {
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
   * @returns {string} bijv. '€ 1.234,50'
   */
  const money = (value) => Number(value || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  /**
   * Formatteert een datum voluit, met de dag van de week.
   * @param {string} date datum als 'jjjj-mm-dd'
   * @returns {string} bijv. 'dinsdag 3 november 2026', of leeg zonder datum
   */
  const day = (date) => (date ? new Date(`${date}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '');
  /**
   * Formatteert een tijdstip als datum met tijd.
   * @param {string} iso tijdstip in ISO-formaat
   * @returns {string} leesbare datum en tijd, of leeg zonder tijdstip
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const QUOTE_STATUS = { concept: 'Concept', verzonden: 'Wacht op uw reactie', akkoord: 'Akkoord', afgewezen: 'Afgewezen' };
  const APPOINTMENT = { wacht: 'Wacht op uw bevestiging', bevestigd: 'Door u bevestigd', ander_moment: 'Ander moment gevraagd' };
  const KIND = { voor: 'Voor de aanleg', tijdens: 'Tijdens de aanleg', oplevering: 'Bij oplevering' };
  // Meldingen (storing, onderhoud): status in gewone taal en de kleur van het label.
  const REQ_STATUS = { nieuw: 'Ontvangen', in_behandeling: 'In behandeling', ingepland: 'Ingepland', afgehandeld: 'Afgehandeld', afgewezen: 'Niet in behandeling genomen', ingetrokken: 'Ingetrokken' };
  const REQ_PILL = { nieuw: 'open', in_behandeling: 'bezig', ingepland: 'gepland', afgehandeld: 'gereed', afgewezen: 'afgewezen', ingetrokken: 'geannuleerd' };
  const REQ_KIND = { storing: 'Storing', onderhoud: 'Onderhoud', overig: 'Vraag of verzoek' };
  const REQ_OPEN = ['nieuw', 'in_behandeling'];
  const MAX_REQ_PHOTOS = 6;

  const state = { data: null, detail: null, request: null, files: [] };

  /**
   * Toont kort een melding onderin het scherm.
   * @param {string} message de tekst
   * @param {boolean} isError true voor een foutmelding (rood)
   */
  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast show${isError ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { element.className = 'toast'; }, 3500);
  }

  /**
   * Roept de API aan en geeft de JSON terug.
   * @param {string} url adres van de API
   * @param {RequestInit} options extra fetch-opties (methode, kop, inhoud)
   * @returns {Promise<object>} het antwoord; gooit een fout met `status` bij een foutstatus
   */
  async function api(url, options = {}) {
    const res = await fetch(url, { cache: 'no-store', ...options });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(body.message || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return body;
  }

  /**
   * Moment van een werkorder in gewone taal: "dinsdag 3 november 2026, 08:00–16:00".
   * @param {object} workOrder werkorder uit het portaal
   * @returns {string} datum met tijden en aantal werkdagen, of leeg als hij niet gepland is
   */
  function moment(workOrder) {
    if (!workOrder.plannedDate) return '';
    const time = workOrder.startTime ? `, ${workOrder.startTime}${workOrder.endTime ? `–${workOrder.endTime}` : ''}` : '';
    const days = workOrder.days > 1 ? ` (${workOrder.days} werkdagen)` : '';
    return `${day(workOrder.plannedDate)}${time}${days}`;
  }

  /**
   * Zegt of de afspraak van een werkorder nog op bevestiging wacht.
   * @param {object} workOrder werkorder uit het portaal
   * @returns {boolean} true als de klant nog moet reageren
   */
  const waiting = (workOrder) => workOrder.appointment && workOrder.appointment.state === 'wacht';
  /**
   * Maakt het label met de stand van de afspraak.
   * @param {object} workOrder werkorder uit het portaal
   * @returns {string} HTML van het label, of leeg zonder afspraak
   */
  const appointmentPill = (workOrder) => (workOrder.appointment && APPOINTMENT[workOrder.appointment.state]
    ? `<span class="pill ${esc(workOrder.appointment.state)}">${esc(APPOINTMENT[workOrder.appointment.state])}</span>` : '');

  /**
   * Toont een melding boven het portaal; lege tekst verbergt hem.
   * @param {string} html de melding (HTML)
   */
  function message(html) {
    const messageBox = $('#p-message');
    messageBox.innerHTML = html;
    messageBox.hidden = !html;
  }

  /**
   * Laadt het portaal en tekent alle onderdelen; meldt het als de gebruiker niet mag.
   * @returns {Promise<void>}
   */
  async function load() {
    try {
      state.data = await api('../api/portal');
    } catch (error) {
      if (error.status === 401) message('Log in om uw portaal te zien. <a href="../login">Inloggen</a>');
      else if (error.status === 403) message('Het klantportaal is er voor klanten. Medewerkers vinden offertes en werkorders in hun eigen modules. <a href="../">Naar het overzicht</a>');
      else message(`Kan het portaal niet laden (${esc(error.message)}).`);
      return;
    }
    render();
  }

  /** Tekent alle onderdelen van het portaal. */
  function render() {
    const portal = state.data;
    const name = portal.user && portal.user.kind !== 'gast' ? portal.user.displayName : '';
    $('#p-welcome').textContent = name ? `Welkom, ${name}` : 'Mijn portaal';
    renderTodo(portal);
    renderRequests(portal);
    renderWork(portal);
    renderQuotes(portal);
    renderPlans(portal);
    renderContact(portal);
    if (!portal.quotes.length && !portal.workorders.length && !portal.plans.length && !(portal.requests || []).length) {
      message('Er staat nog niets voor u klaar. Zodra wij een offerte voor u hebben opgesteld of werkzaamheden hebben ingepland, ziet u die hier.');
    } else message('');
  }

  /**
   * Tekent het blok "Voor u klaar": offertes om te beantwoorden en afspraken om te bevestigen.
   * @param {object} portal gegevens uit api/portal
   */
  function renderTodo(portal) {
    const quotes = portal.quotes.filter((quote) => quote.status === 'verzonden');
    const work = portal.workorders.filter(waiting);
    $('#todo').innerHTML = [
      ...quotes.map((quote) => `
        <div class="card todo">
          <h3>Offerte ${esc(quote.number)}</h3>
          <div>${esc(quote.title || '')}</div>
          <div class="meta">${money(quote.totalIncl)} incl. btw${quote.validUntil ? ` · geldig tot ${esc(day(quote.validUntil))}` : ''}</div>
          <div class="actions"><a class="btn primary" href="../offertes/?id=${encodeURIComponent(quote.id)}">Bekijken en beantwoorden</a></div>
        </div>`),
      ...work.map((workOrder) => `
        <div class="card todo">
          <h3>Afspraak bevestigen</h3>
          <div>${esc(workOrder.title)}</div>
          <div class="meta when">${esc(moment(workOrder))}</div>
          <div class="actions"><button class="btn primary" data-open="${esc(workOrder.id)}">Bekijken en bevestigen</button></div>
        </div>`),
    ].join('');
    $('#s-todo').hidden = !quotes.length && !work.length;
  }

  // ---------- Meldingen ----------
  /**
   * Maakt het statuslabel van een melding (met Spoed als dat zo is).
   * @param {object} request de melding
   * @returns {string} HTML van het label
   */
  const reqPill = (request) => `<span class="pill ${esc(REQ_PILL[request.status] || '')}">${esc(REQ_STATUS[request.status] || request.status)}</span>${request.urgent ? ' <span class="pill spoed">Spoed</span>' : ''}`;

  /**
   * Tekent de kaarten met de meldingen van de klant.
   * @param {object} portal gegevens uit api/portal
   */
  function renderRequests(portal) {
    const list = portal.requests || [];
    $('#requests').innerHTML = list.map((request) => `
      <div class="card">
        <h3>${esc(request.subject)}</h3>
        <div>${reqPill(request)}</div>
        <div class="meta">${esc(REQ_KIND[request.kind] || request.kind)} · ${esc(request.number)} · gemeld ${esc(when(request.createdAt))}${request.photoCount ? ` · ${request.photoCount} foto${request.photoCount > 1 ? "'s" : ''}` : ''}</div>
        ${request.workOrder ? `<div class="meta">${request.workOrder.plannedDate ? `Ingepland op <span class="when">${esc(day(request.workOrder.plannedDate))}</span>` : 'Wij plannen de werkzaamheden in'}</div>` : ''}
        ${request.reply ? `<div class="meta">Onze reactie: ${esc(request.reply.length > 140 ? `${request.reply.slice(0, 140)}…` : request.reply)}</div>` : ''}
        <div class="actions"><button class="btn" data-req="${esc(request.id)}">Details</button></div>
      </div>`).join('');
    $('#s-requests').hidden = !(portal.features && portal.features.requests);
  }

  /**
   * Formulier: installaties van de klant om uit te kiezen, adres van de laatste.
   * @returns {HTMLFormElement} het meldingsformulier
   */
  const form = () => $('#r-form');
  /** Opent het formulier voor een nieuwe melding, vooraf ingevuld met installatie, adres en telefoon. */
  function openForm() {
    const portal = state.data;
    const formElement = form();
    formElement.reset();
    formElement.querySelector('.err').textContent = '';
    state.files = [];
    $('#r-previews').innerHTML = '';
    const installations = portal.workorders.filter((workOrder) => workOrder.quoteId || workOrder.status === 'gereed');
    formElement.installationId.innerHTML = `<option value="">Weet ik niet / niet van toepassing</option>${installations.map((workOrder) => `<option value="${esc(workOrder.id)}">${esc(workOrder.title)}${workOrder.address ? ` (${esc(workOrder.address)})` : ''}</option>`).join('')}`;
    if (installations.length === 1) formElement.installationId.value = installations[0].id;
    $('#r-inst-row').hidden = !installations.length;
    const last = portal.workorders.find((workOrder) => workOrder.address);
    formElement.address.value = last ? last.address : '';
    formElement.phone.value = (portal.user && portal.user.phone) || '';
    syncKind();
    $('#r-modal').hidden = false;
    formElement.subject.focus();
  }
  /** Toont de keuze Spoed alleen bij een storing of onderhoud. */
  function syncKind() {
    const kind = form().kind.value;
    $('#r-urgent-row').hidden = kind === 'overig';
  }
  /** Sluit het meldingsformulier. */
  function closeForm() { $('#r-modal').hidden = true; }

  /** Toont voorbeelden van de gekozen foto's. */
  function previews() {
    $('#r-previews').innerHTML = state.files.map((file, i) => `<figure><img src="${esc(URL.createObjectURL(file))}" alt="Foto ${i + 1}"></figure>`).join('');
  }

  /**
   * Foto's één voor één verkleinen en uploaden (net als bij een werkorder).
   * @param {string} id id van de melding
   * @param {File[]} files de foto's
   * @returns {Promise<number>} aantal geüploade foto's
   */
  async function uploadPhotos(id, files) {
    let uploaded = 0;
    for (const file of files) {
      try {
        const body = await window.WorkOrderPhotos.prepare(file);
        await api(`../api/portal/requests/${encodeURIComponent(id)}/photos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        uploaded++;
      } catch (error) {
        toast(`Foto ${file.name || ''} niet toegevoegd: ${error.message}`, true);
      }
    }
    return uploaded;
  }

  /**
   * Verstuurt een nieuwe melding met de foto's, na controle van de invoer.
   * @param {SubmitEvent} event het verzenden van het formulier
   * @returns {Promise<void>}
   */
  async function submitForm(event) {
    event.preventDefault();
    const formElement = form();
    const errorBox = formElement.querySelector('.err');
    errorBox.textContent = '';
    if (!formElement.subject.value.trim()) { errorBox.textContent = 'Geef een kort onderwerp.'; formElement.subject.focus(); return; }
    if (formElement.description.value.trim().length < 10) { errorBox.textContent = 'Beschrijf wat er aan de hand is.'; formElement.description.focus(); return; }
    const submitButton = formElement.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      const body = {
        kind: formElement.kind.value, urgent: formElement.urgent.checked, subject: formElement.subject.value, description: formElement.description.value,
        installationId: formElement.installationId.value || null, address: formElement.address.value, phone: formElement.phone.value, preferred: formElement.preferred.value,
      };
      const created = await api('../api/portal/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (state.files.length) {
        submitButton.textContent = 'Foto\'s uploaden…';
        await uploadPhotos(created.id, state.files);
      }
      closeForm();
      toast(`Melding ${created.number} is verstuurd. Wij nemen contact met u op.`);
      load();
    } catch (error) {
      errorBox.textContent = error.message;
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Melding versturen';
    }
  }

  /**
   * Opent het detailvenster van een melding.
   * @param {string} id id van de melding
   * @returns {Promise<void>}
   */
  async function openRequest(id) {
    try {
      state.request = await api(`../api/portal/requests/${encodeURIComponent(id)}`);
    } catch (error) {
      toast(`Kan de melding niet openen: ${error.message}`, true);
      return;
    }
    renderRequest();
    $('#detail').hidden = false;
  }

  /** Tekent het detailvenster van de geopende melding met foto's en knoppen. */
  function renderRequest() {
    const request = state.request;
    const open = REQ_OPEN.includes(request.status);
    const photos = request.photos || [];
    $('#detail-body').innerHTML = `
      <div class="dossier">
        <h2>Melding: ${esc(request.subject)}</h2>
        <div>${reqPill(request)}</div>
        <dl class="kv">
          <dt>Nummer</dt><dd>${esc(request.number)}</dd>
          <dt>Soort</dt><dd>${esc(REQ_KIND[request.kind] || request.kind)}</dd>
          <dt>Gemeld</dt><dd>${esc(when(request.createdAt))}</dd>
          ${request.installation ? `<dt>Installatie</dt><dd>${esc(request.installation.title)}</dd>` : ''}
          ${request.address ? `<dt>Adres</dt><dd>${esc(request.address)}</dd>` : ''}
          ${request.phone ? `<dt>Telefoon</dt><dd>${esc(request.phone)}</dd>` : ''}
          ${request.preferred ? `<dt>Voorkeur</dt><dd>${esc(request.preferred)}</dd>` : ''}
        </dl>
        <h3>Uw omschrijving</h3><div class="notes">${esc(request.description)}</div>
        ${request.reply ? `<h3>Onze reactie</h3><div class="reply">${esc(request.reply)}</div>` : ''}
        ${request.workOrder ? `<h3>Werkzaamheden</h3><p>${request.workOrder.plannedDate ? `Ingepland op <b>${esc(day(request.workOrder.plannedDate))}</b>.` : 'Wij plannen de werkzaamheden in en laten u weten wanneer we komen.'}</p>
          <div class="actions"><button class="btn" data-open="${esc(request.workOrder.id)}">Bekijk de werkzaamheden</button></div>` : ''}
        ${photos.length ? `<h3>Foto's</h3><div class="photos">${photos.map((photo, i) => `
          <figure><button type="button" data-rphoto="${i}" title="Vergroten"><img src="../${esc(photo.thumbUrl)}" alt="Foto ${i + 1}" loading="lazy"></button>
          ${open ? `<figcaption><button type="button" class="btn small" data-rdel="${esc(photo.id)}">Verwijderen</button></figcaption>` : ''}</figure>`).join('')}</div>` : ''}
        ${open ? `<div class="actions no-print" style="margin-top:16px">
          ${photos.length < MAX_REQ_PHOTOS ? `<label class="btn">Foto toevoegen<input type="file" id="r-add" accept="image/*" multiple hidden></label>` : ''}
          <button class="btn" id="r-withdraw">Melding intrekken</button></div>` : ''}
      </div>`;
    document.querySelectorAll('#detail-body [data-rphoto]').forEach((button) => {
      /** Toont de foto vergroot. */
      button.onclick = () => { const photo = photos[Number(button.dataset.rphoto)]; showPhoto({ url: photo.url, caption: `Foto bij melding ${request.number}` }); };
    });
    document.querySelectorAll('#detail-body [data-rdel]').forEach((button) => {
      /**
       * Verwijdert deze foto.
       * @returns {Promise<void>}
       */
      button.onclick = () => removeRequestPhoto(button.dataset.rdel);
    });
    const add = $('#r-add');
    if (add) {
      /**
       * Uploadt de gekozen foto's bij de melding en ververst het venster.
       * @returns {Promise<void>}
       */
      add.onchange = async () => {
        const files = [...add.files].slice(0, MAX_REQ_PHOTOS - photos.length);
        if (!files.length) return;
        if (await uploadPhotos(request.id, files)) toast('Foto toegevoegd.');
        openRequest(request.id);
        load();
      };
    }
    const withdrawButton = $('#r-withdraw');
    if (withdrawButton) {
      withdrawButton.onclick = withdraw;
    }
    document.querySelectorAll('#detail-body [data-open]').forEach((button) => {
      /**
       * Opent de werkzaamheden bij deze melding.
       * @returns {Promise<void>}
       */
      button.onclick = () => openDetail(button.dataset.open);
    });
  }

  /**
   * Verwijdert een foto van de geopende melding.
   * @param {string} photoId id van de foto
   * @returns {Promise<void>}
   */
  async function removeRequestPhoto(photoId) {
    try {
      await api(`../api/portal/requests/${encodeURIComponent(state.request.id)}/photos/${encodeURIComponent(photoId)}`, { method: 'DELETE' });
      openRequest(state.request.id);
      load();
    } catch (error) {
      toast(error.message, true);
    }
  }

  /**
   * Trekt de geopende melding in, na bevestiging.
   * @returns {Promise<void>}
   */
  async function withdraw() {
    if (!window.confirm('Weet u zeker dat u deze melding wilt intrekken?')) return;
    try {
      state.request = await api(`../api/portal/requests/${encodeURIComponent(state.request.id)}/withdraw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast('De melding is ingetrokken.');
      renderRequest();
      load();
    } catch (error) {
      toast(error.message, true);
    }
  }

  /**
   * Tekent de kaarten met de werkzaamheden en hun voortgang.
   * @param {object} portal gegevens uit api/portal
   */
  function renderWork(portal) {
    $('#work').innerHTML = portal.workorders.map((workOrder) => `
      <div class="card">
        <h3>${esc(workOrder.title)}</h3>
        <div><span class="pill ${esc(workOrder.status)}">${esc(workOrder.statusLabel)}</span> ${appointmentPill(workOrder)}</div>
        <div class="meta">${workOrder.plannedDate ? `<span class="when">${esc(moment(workOrder))}</span>` : 'Nog niet ingepland'}${workOrder.installer ? ` · monteur ${esc(workOrder.installer)}` : ''}</div>
        ${workOrder.address ? `<div class="meta">${esc(workOrder.address)}</div>` : ''}
        ${workOrder.status === 'gereed'
          ? `<div class="meta">Opgeleverd${workOrder.completedOn ? ` op ${esc(day(workOrder.completedOn))}` : ''}</div>`
          : workOrder.progress.steps ? `<div class="bar" title="${workOrder.progress.done} van ${workOrder.progress.steps} stappen klaar"><span style="width:${Number(workOrder.progress.pct) || 0}%"></span></div>
            <div class="meta">${workOrder.progress.done} van ${workOrder.progress.steps} stappen klaar</div>` : ''}
        <div class="actions"><button class="btn${waiting(workOrder) ? ' primary' : ''}" data-open="${esc(workOrder.id)}">${workOrder.status === 'gereed' ? 'Opleverdossier' : 'Details'}</button></div>
      </div>`).join('');
    $('#s-work').hidden = !portal.workorders.length;
  }

  /**
   * Tekent de tabel met offertes.
   * @param {object} portal gegevens uit api/portal
   */
  function renderQuotes(portal) {
    $('#quotes').innerHTML = `<thead><tr><th>Nummer</th><th>Omschrijving</th><th>Status</th><th class="num">Totaal incl. btw</th><th>Datum</th><th></th></tr></thead>
      <tbody>${portal.quotes.map((quote) => `
        <tr><td><b>${esc(quote.number)}</b></td><td class="wrap">${esc(quote.title || '')}</td>
          <td><span class="pill ${esc(quote.status)}">${esc(QUOTE_STATUS[quote.status] || quote.status)}</span></td>
          <td class="num">${money(quote.totalIncl)}</td><td>${esc(when(quote.updatedAt))}</td>
          <td><a class="btn small" href="../offertes/?id=${encodeURIComponent(quote.id)}">Openen</a></td></tr>`).join('')}</tbody>`;
    $('#s-quotes').hidden = !portal.quotes.length;
  }

  /**
   * Tekent tegels met de (maximaal zes) eigen plannen.
   * @param {object} portal gegevens uit api/portal
   */
  function renderPlans(portal) {
    $('#plans').innerHTML = portal.plans.slice(0, 6).map((plan) => `
      <a class="tile" href="../beregening/?plan=${encodeURIComponent(plan.id)}">
        <span class="tile-text">
          <span class="tile-title">${esc(plan.title)}</span>
          <span class="tile-desc">${plan.address ? `${esc(plan.address)} · ` : ''}${plan.summary ? `${plan.summary.areas} vlakken, ${plan.summary.sprinklers} sproeiers · ` : ''}gewijzigd ${esc(when(plan.updatedAt))}</span>
        </span>
      </a>`).join('');
    $('#s-plans').hidden = !portal.plans.length;
  }

  /**
   * Tekent de contactgegevens van het bedrijf.
   * @param {object} portal gegevens uit api/portal
   */
  function renderContact(portal) {
    const contact = portal.contact || {};
    const site = contact.website ? (/^https?:\/\//i.test(contact.website) ? contact.website : `https://${contact.website}`) : '';
    const rows = [
      contact.companyName ? `<b>${esc(contact.companyName)}</b>` : '',
      contact.address ? `<span>${esc(contact.address).replace(/\n/g, '<br>')}</span>` : '',
      contact.phone ? `<span>Telefoon: <a href="tel:${esc(contact.phone.replace(/[^\d+]/g, ''))}">${esc(contact.phone)}</a></span>` : '',
      contact.email ? `<span>E-mail: <a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a></span>` : '',
      site ? `<span>Website: <a href="${esc(site)}" target="_blank" rel="noopener">${esc(contact.website)}</a></span>` : '',
    ].filter(Boolean);
    $('#contact').innerHTML = rows.join('');
    $('#s-contact').hidden = rows.length < 2;
  }

  // ---------- Opleverdossier ----------
  /**
   * Opent het detailvenster (opleverdossier) van een werkorder.
   * @param {string} id id van de werkorder
   * @returns {Promise<void>}
   */
  async function openDetail(id) {
    try {
      state.detail = await api(`../api/portal/workorders/${encodeURIComponent(id)}`);
    } catch (error) {
      toast(`Kan de werkorder niet openen: ${error.message}`, true);
      return;
    }
    renderDetail();
    $('#detail').hidden = false;
  }

  /** Tekent het opleverdossier: gegevens, afspraak, foto's, installatie, zones, stappen en materialen. */
  function renderDetail() {
    const workOrder = state.detail;
    const design = workOrder.design;
    const photos = workOrder.photos || [];
    const appointment = workOrder.appointment;
    const answer = appointment && appointment.response ? `<p class="muted small">${appointment.response.answer === 'bevestigd' ? 'Bevestigd' : 'Ander moment gevraagd'} door ${esc(appointment.response.name)} op ${esc(when(appointment.response.at))}${appointment.response.reason ? `: “${esc(appointment.response.reason)}”` : ''}</p>` : '';
    $('#detail-body').innerHTML = `
      <div class="dossier">
        <h2>${workOrder.status === 'gereed' ? 'Opleverdossier' : 'Werkzaamheden'}: ${esc(workOrder.title)}</h2>
        <div><span class="pill ${esc(workOrder.status)}">${esc(workOrder.statusLabel)}</span> ${appointmentPill(workOrder)}</div>
        <dl class="kv">
          <dt>Werkorder</dt><dd>${esc(workOrder.number)}</dd>
          ${workOrder.quoteNumber ? `<dt>Offerte</dt><dd><a href="../offertes/?id=${encodeURIComponent(workOrder.quoteId)}">${esc(workOrder.quoteNumber)}</a></dd>` : ''}
          ${workOrder.address ? `<dt>Adres</dt><dd>${esc(workOrder.address)}</dd>` : ''}
          <dt>Gepland</dt><dd>${workOrder.plannedDate ? esc(moment(workOrder)) : 'Nog niet ingepland'}</dd>
          ${workOrder.installer ? `<dt>Monteur</dt><dd>${esc(workOrder.installer)}</dd>` : ''}
          ${workOrder.report.completedOn ? `<dt>Opgeleverd</dt><dd>${esc(day(workOrder.report.completedOn))}</dd>` : ''}
          ${workOrder.report.signedBy ? `<dt>Getekend door</dt><dd>${esc(workOrder.report.signedBy)}</dd>` : ''}
        </dl>
        ${appointment && appointment.state === 'wacht' ? `
          <div class="answer no-print">
            <b>Komt dit moment u uit?</b>
            <textarea id="a-reason" placeholder="Opmerking of een moment dat u beter uitkomt (optioneel)" maxlength="2000"></textarea>
            <div class="actions"><button class="btn primary" data-answer="bevestigd">Afspraak bevestigen</button><button class="btn" data-answer="ander_moment">Ander moment vragen</button></div>
          </div>` : answer}
        ${workOrder.report.notes ? `<h3>Opmerkingen bij de oplevering</h3><div class="notes">${esc(workOrder.report.notes)}</div>` : ''}
        ${photos.length ? `<h3>Foto's</h3><div class="photos">${photos.map((photo, i) => `
          <figure><button type="button" data-photo="${i}" title="Vergroten"><img src="../${esc(photo.thumbUrl || photo.url)}" alt="${esc(photo.caption || KIND[photo.kind] || 'Foto')}" loading="lazy"></button>
            <figcaption>${esc(photo.caption || KIND[photo.kind] || '')}${photo.takenAt ? ` · ${esc(when(photo.takenAt))}` : ''}</figcaption></figure>`).join('')}</div>` : ''}
        ${design ? `<h3>Uw installatie</h3><dl class="kv">
          ${design.lawnM2 ? `<dt>Gazon</dt><dd>${Math.round(design.lawnM2)} m²</dd>` : ''}
          ${design.zones ? `<dt>Zones</dt><dd>${design.zones}</dd>` : ''}
          ${design.sprinklers ? `<dt>Sproeiers</dt><dd>${design.sprinklers}</dd>` : ''}
          ${design.pressureBar ? `<dt>Waterdruk</dt><dd>${design.pressureBar} bar</dd>` : ''}
          ${design.flowM3h ? `<dt>Debiet</dt><dd>${design.flowM3h} m³/u</dd>` : ''}
          ${design.mainPipe ? `<dt>Hoofdleiding</dt><dd>${esc(design.mainPipe)}</dd>` : ''}</dl>` : ''}
        ${workOrder.zones.length ? `<h3>Zones</h3><div class="tablewrap"><table class="grid"><thead><tr><th>Zone</th><th>Soort</th><th>Onderdelen</th></tr></thead><tbody>
          ${workOrder.zones.map((zone) => `<tr><td>${esc(zone.name)}</td><td>${esc(zone.kind)}</td><td class="wrap">${esc(zone.parts)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${workOrder.steps.length ? `<h3>Werkzaamheden (${workOrder.progress.done} van ${workOrder.progress.steps} klaar)</h3><ul class="steps">
          ${workOrder.steps.map((step) => `<li class="${step.done ? 'done' : ''}"><span class="tick">${step.done ? '✓' : '○'}</span><span>${esc(step.title)}</span><span class="phase">${esc(step.phaseLabel)}</span></li>`).join('')}</ul>` : ''}
        ${workOrder.materials.length ? `<h3>Gebruikte materialen</h3><div class="tablewrap"><table class="grid"><thead><tr><th>Omschrijving</th><th class="num">Aantal</th><th>Eenheid</th></tr></thead><tbody>
          ${workOrder.materials.map((material) => `<tr><td class="wrap">${esc(material.description || material.code)}</td><td class="num">${Number(material.qty).toLocaleString('nl-NL')}</td><td>${esc(material.unit)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="actions no-print" style="margin-top:16px"><button class="btn" id="d-print">Afdrukken of opslaan als PDF</button></div>
      </div>`;
    /** Opent het afdrukvenster. */
    $('#d-print').onclick = () => { window.print(); };
    document.querySelectorAll('#detail-body [data-answer]').forEach((button) => {
      /**
       * Bevestigt de afspraak of vraagt een ander moment.
       * @returns {Promise<void>}
       */
      button.onclick = () => respond(button.dataset.answer);
    });
    document.querySelectorAll('#detail-body [data-photo]').forEach((button) => {
      /** Toont de foto vergroot. */
      button.onclick = () => { showPhoto(photos[Number(button.dataset.photo)]); };
    });
  }

  /**
   * Beantwoordt de afspraak van de geopende werkorder.
   * @param {string} answer 'bevestigd' of 'ander_moment'
   * @returns {Promise<void>}
   */
  async function respond(answer) {
    const reason = ($('#a-reason') || {}).value || '';
    if (answer === 'ander_moment' && !reason.trim()) { toast('Geef aan welk moment u beter uitkomt.', true); $('#a-reason').focus(); return; }
    document.querySelectorAll('#detail-body [data-answer]').forEach((button) => { button.disabled = true; });
    try {
      state.detail = { ...state.detail, ...(await api(`../api/portal/workorders/${encodeURIComponent(state.detail.id)}/appointment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer, reason }),
      })) };
      toast(answer === 'bevestigd' ? 'Afspraak bevestigd, bedankt!' : 'Uw verzoek is doorgegeven. Wij nemen contact met u op.');
      renderDetail();
      load();
    } catch (error) {
      toast(error.message, true);
      document.querySelectorAll('#detail-body [data-answer]').forEach((button) => { button.disabled = false; });
    }
  }

  /**
   * Toont een foto vergroot met onderschrift.
   * @param {object} photo foto met url, caption en kind
   */
  function showPhoto(photo) {
    if (!photo) return;
    $('#photo-img').src = `../${photo.url}`;
    $('#photo-img').alt = photo.caption || 'Foto';
    $('#photo-cap').textContent = photo.caption || KIND[photo.kind] || '';
    $('#photo').hidden = false;
  }

  /**
   * Start het portaal: knoppen en sneltoetsen koppelen, laden en zo nodig direct
   * een werkorder, melding of het meldingsformulier openen (via de #-link).
   * @returns {Promise<void>}
   */
  async function init() {
    // Kopbalk en portaal tegelijk laden (het portaal meldt zelf als je niet mag).
    const account = window.AquatechAccount.load('../');
    /** Sluit het detailvenster. */
    $('#detail-close').onclick = () => { $('#detail').hidden = true; };
    /**
     * Sluit het detailvenster bij een klik naast het venster.
     * @param {MouseEvent} event de klik
     */
    $('#detail').onclick = (event) => { if (event.target.id === 'detail') $('#detail').hidden = true; };
    /** Sluit de vergrote foto. */
    $('#photo').onclick = () => { $('#photo').hidden = true; };
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!$('#photo').hidden) $('#photo').hidden = true;
      else if (!$('#r-modal').hidden) closeForm();
      else $('#detail').hidden = true;
    });
    document.addEventListener('click', (event) => {
      const openButton = event.target.closest('main [data-open]');
      if (openButton) openDetail(openButton.dataset.open);
      const requestButton = event.target.closest('main [data-req]');
      if (requestButton) openRequest(requestButton.dataset.req);
    });
    $('#r-new').onclick = openForm;
    $('#r-close').onclick = closeForm;
    $('#r-cancel').onclick = closeForm;
    /**
     * Sluit het formulier bij een klik naast het venster.
     * @param {MouseEvent} event de klik
     */
    $('#r-modal').onclick = (event) => { if (event.target.id === 'r-modal') closeForm(); };
    form().addEventListener('submit', submitForm);
    form().addEventListener('change', (event) => {
      if (event.target.name === 'kind') syncKind();
      if (event.target.name === 'photos') {
        state.files = [...event.target.files].slice(0, MAX_REQ_PHOTOS);
        if (event.target.files.length > MAX_REQ_PHOTOS) toast(`Maximaal ${MAX_REQ_PHOTOS} foto's; de eerste ${MAX_REQ_PHOTOS} worden meegestuurd.`, true);
        previews();
      }
    });
    await Promise.all([account, load()]);
    // Terug via de knop Terug van de browser: opnieuw laden.
    if (window.AquatechCommon) window.AquatechCommon.onReturn(load);
    // Direct naar een werkorder of melding: portaal/#wo=<id> of #melding=<id>
    // (bijv. vanuit een e-mail); #melden opent het formulier.
    const workOrderMatch = /^#wo=([\w-]+)$/.exec(location.hash);
    if (workOrderMatch && state.data) openDetail(workOrderMatch[1]);
    const requestMatch = /^#melding=([\w-]+)$/.exec(location.hash);
    if (requestMatch && state.data) openRequest(requestMatch[1]);
    if (location.hash === '#melden' && state.data && state.data.features.requests) openForm();
  }

  init();
})();
