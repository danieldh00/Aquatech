// Klantportaal: wat er voor de klant klaarstaat (offertes om te beantwoorden,
// afspraken om te bevestigen), de werkzaamheden met voortgang, de offertes,
// de eigen plannen en per werkorder het opleverdossier met foto's.
// Alle gegevens komen uit api/portal; de server bepaalt wat de klant ziet.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v) => Number(v || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  const day = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '');
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

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, { cache: 'no-store', ...opts });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(body.message || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return body;
  }

  // Moment van een werkorder in gewone taal: "dinsdag 3 november 2026, 08:00–16:00".
  function moment(w) {
    if (!w.plannedDate) return '';
    const time = w.startTime ? `, ${w.startTime}${w.endTime ? `–${w.endTime}` : ''}` : '';
    const days = w.days > 1 ? ` (${w.days} werkdagen)` : '';
    return `${day(w.plannedDate)}${time}${days}`;
  }

  const waiting = (w) => w.appointment && w.appointment.state === 'wacht';
  const appointmentPill = (w) => (w.appointment && APPOINTMENT[w.appointment.state]
    ? `<span class="pill ${esc(w.appointment.state)}">${esc(APPOINTMENT[w.appointment.state])}</span>` : '');

  function message(html) {
    const el = $('#p-message');
    el.innerHTML = html;
    el.hidden = !html;
  }

  async function load() {
    try {
      state.data = await api('../api/portal');
    } catch (e) {
      if (e.status === 401) message('Log in om uw portaal te zien. <a href="../login">Inloggen</a>');
      else if (e.status === 403) message('Het klantportaal is er voor klanten. Medewerkers vinden offertes en werkorders in hun eigen modules. <a href="../">Naar het overzicht</a>');
      else message(`Kan het portaal niet laden (${esc(e.message)}).`);
      return;
    }
    render();
  }

  function render() {
    const d = state.data;
    const name = d.user && d.user.kind !== 'gast' ? d.user.displayName : '';
    $('#p-welcome').textContent = name ? `Welkom, ${name}` : 'Mijn portaal';
    renderSeason(d);
    renderTodo(d);
    renderRequests(d);
    renderWork(d);
    renderQuotes(d);
    renderPlans(d);
    renderContact(d);
    if (!d.quotes.length && !d.workorders.length && !d.plans.length && !(d.requests || []).length) {
      message('Er staat nog niets voor u klaar. Zodra wij een offerte voor u hebben opgesteld of werkzaamheden hebben ingepland, ziet u die hier.');
    } else message('');
  }

  /**
   * Toont de lopende seizoensherinneringen (voorjaar opstarten, najaar
   * winterklaar) met een knop om onderhoud aan te vragen, en het vinkje voor de mails.
   * @param {object} portal Het overzicht uit api/portal.
   * @returns {void}
   */
  function renderSeason(portal) {
    const reminders = portal.reminders || [];
    const canRequest = Boolean(portal.features && portal.features.requests);
    $('#season').innerHTML = reminders.map((reminder) => `
      <div class="card season">
        <h3>${esc(reminder.title)}</h3>
        <div>${esc(reminder.text)}</div>
        ${canRequest ? `<div class="actions"><button class="btn primary" data-season="${esc(reminder.key)}">Afspraak aanvragen</button></div>` : ''}
      </div>`).join('');
    // Een eerder gestart GET mag een net opgeslagen of nog lopende keuze niet terugzetten.
    if (state.seasonMail !== undefined) portal.reminderMails = state.seasonMail;
    $('#season-mail').checked = portal.reminderMails === true;
    $('#season-mail-row').hidden = !portal.user || portal.user.kind !== 'account';
    $('#s-season').hidden = !portal.remindersEnabled || (!reminders.length && $('#season-mail-row').hidden);
  }

  /**
   * Opent het meldformulier als onderhoudsverzoek voor een seizoensherinnering.
   * Loopt de herinnering niet meer (oude link uit een mail), dan opent het
   * gewone onderhoudsformulier met een melding.
   * @param {string} key Sleutel van de herinnering.
   * @returns {void}
   */
  function requestSeasonService(key) {
    if (!state.data.features.requests) return;
    const reminder = (state.data.reminders || []).find((item) => item.key === key);
    if (!reminder) toast('Deze herinnering loopt niet meer. U kunt hier gewoon onderhoud aanvragen.');
    openForm();
    const requestForm = form();
    requestForm.kind.value = 'onderhoud';
    requestForm.subject.value = reminder ? reminder.title : '';
    syncKind();
    requestForm.description.focus();
  }

  /**
   * Zet de seizoensherinneringen per mail aan of uit (voorkeur in het profiel).
   * @param {boolean} wanted true = wel mails.
   * @returns {Promise<void>}
   */
  async function saveSeasonMail(wanted) {
    const checkbox = $('#season-mail');
    // Eén wijziging tegelijk, zodat de laatste klik ook de opgeslagen stand is.
    checkbox.disabled = true;
    state.seasonMail = wanted;
    try {
      await api('../api/account/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: { seasonReminders: wanted } }) });
      state.data.reminderMails = wanted;
      checkbox.checked = wanted;
      toast(wanted ? 'U krijgt de herinneringen per e-mail.' : 'U krijgt geen herinneringen meer per e-mail.');
    } catch (error) {
      // Onzeker of de server het toch opsloeg: de opgeslagen stand opnieuw ophalen.
      delete state.seasonMail;
      try {
        const profile = await api('../api/account/profile');
        state.data.reminderMails = profile.preferences.seasonReminders !== false;
      } catch (reloadError) {
        state.data.reminderMails = !wanted;
      }
      checkbox.checked = state.data.reminderMails;
      toast(`Opslaan mislukt (${error.message}).`, true);
    } finally {
      checkbox.disabled = false;
    }
  }

  function renderTodo(d) {
    const quotes = d.quotes.filter((q) => q.status === 'verzonden');
    const work = d.workorders.filter(waiting);
    $('#todo').innerHTML = [
      ...quotes.map((q) => `
        <div class="card todo">
          <h3>Offerte ${esc(q.number)}</h3>
          <div>${esc(q.title || '')}</div>
          <div class="meta">${money(q.totalIncl)} incl. btw${q.validUntil ? ` · geldig tot ${esc(day(q.validUntil))}` : ''}</div>
          <div class="actions"><a class="btn primary" href="../offertes/?id=${encodeURIComponent(q.id)}">Bekijken en beantwoorden</a></div>
        </div>`),
      ...work.map((w) => `
        <div class="card todo">
          <h3>Afspraak bevestigen</h3>
          <div>${esc(w.title)}</div>
          <div class="meta when">${esc(moment(w))}</div>
          <div class="actions"><button class="btn primary" data-open="${esc(w.id)}">Bekijken en bevestigen</button></div>
        </div>`),
    ].join('');
    $('#s-todo').hidden = !quotes.length && !work.length;
  }

  // ---------- Meldingen ----------
  const reqPill = (r) => `<span class="pill ${esc(REQ_PILL[r.status] || '')}">${esc(REQ_STATUS[r.status] || r.status)}</span>${r.urgent ? ' <span class="pill spoed">Spoed</span>' : ''}`;

  function renderRequests(d) {
    const list = d.requests || [];
    $('#requests').innerHTML = list.map((r) => `
      <div class="card">
        <h3>${esc(r.subject)}</h3>
        <div>${reqPill(r)}</div>
        <div class="meta">${esc(REQ_KIND[r.kind] || r.kind)} · ${esc(r.number)} · gemeld ${esc(when(r.createdAt))}${r.photoCount ? ` · ${r.photoCount} foto${r.photoCount > 1 ? "'s" : ''}` : ''}</div>
        ${r.workOrder ? `<div class="meta">${r.workOrder.plannedDate ? `Ingepland op <span class="when">${esc(day(r.workOrder.plannedDate))}</span>` : 'Wij plannen de werkzaamheden in'}</div>` : ''}
        ${r.reply ? `<div class="meta">Onze reactie: ${esc(r.reply.length > 140 ? `${r.reply.slice(0, 140)}…` : r.reply)}</div>` : ''}
        <div class="actions"><button class="btn" data-req="${esc(r.id)}">Details</button></div>
      </div>`).join('');
    $('#s-requests').hidden = !(d.features && d.features.requests);
  }

  // Formulier: installaties van de klant om uit te kiezen, adres van de laatste.
  const form = () => $('#r-form');
  function openForm() {
    const d = state.data;
    const f = form();
    f.reset();
    f.querySelector('.err').textContent = '';
    state.files = [];
    $('#r-previews').innerHTML = '';
    const inst = d.workorders.filter((w) => w.quoteId || w.status === 'gereed');
    f.installationId.innerHTML = `<option value="">Weet ik niet / niet van toepassing</option>${inst.map((w) => `<option value="${esc(w.id)}">${esc(w.title)}${w.address ? ` (${esc(w.address)})` : ''}</option>`).join('')}`;
    if (inst.length === 1) f.installationId.value = inst[0].id;
    $('#r-inst-row').hidden = !inst.length;
    const last = d.workorders.find((w) => w.address);
    f.address.value = last ? last.address : '';
    f.phone.value = (d.user && d.user.phone) || '';
    syncKind();
    $('#r-modal').hidden = false;
    f.subject.focus();
  }
  function syncKind() {
    const kind = form().kind.value;
    $('#r-urgent-row').hidden = kind === 'overig';
  }
  function closeForm() { $('#r-modal').hidden = true; }

  function previews() {
    $('#r-previews').innerHTML = state.files.map((file, i) => `<figure><img src="${esc(URL.createObjectURL(file))}" alt="Foto ${i + 1}"></figure>`).join('');
  }

  // Foto's één voor één verkleinen en uploaden (net als bij een werkorder).
  async function uploadPhotos(id, files) {
    let ok = 0;
    for (const file of files) {
      try {
        const body = await window.WorkOrderPhotos.prepare(file);
        await api(`../api/portal/requests/${encodeURIComponent(id)}/photos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        ok++;
      } catch (e) {
        toast(`Foto ${file.name || ''} niet toegevoegd: ${e.message}`, true);
      }
    }
    return ok;
  }

  async function submitForm(e) {
    e.preventDefault();
    const f = form();
    const err = f.querySelector('.err');
    err.textContent = '';
    if (!f.subject.value.trim()) { err.textContent = 'Geef een kort onderwerp.'; f.subject.focus(); return; }
    if (f.description.value.trim().length < 10) { err.textContent = 'Beschrijf wat er aan de hand is.'; f.description.focus(); return; }
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const body = {
        kind: f.kind.value, urgent: f.urgent.checked, subject: f.subject.value, description: f.description.value,
        installationId: f.installationId.value || null, address: f.address.value, phone: f.phone.value, preferred: f.preferred.value,
      };
      const r = await api('../api/portal/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (state.files.length) {
        btn.textContent = 'Foto\'s uploaden…';
        await uploadPhotos(r.id, state.files);
      }
      closeForm();
      toast(`Melding ${r.number} is verstuurd. Wij nemen contact met u op.`);
      load();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Melding versturen';
    }
  }

  async function openRequest(id) {
    try {
      state.request = await api(`../api/portal/requests/${encodeURIComponent(id)}`);
    } catch (e) {
      toast(`Kan de melding niet openen: ${e.message}`, true);
      return;
    }
    renderRequest();
    $('#detail').hidden = false;
  }

  function renderRequest() {
    const r = state.request;
    const open = REQ_OPEN.includes(r.status);
    const photos = r.photos || [];
    $('#detail-body').innerHTML = `
      <div class="dossier">
        <h2>Melding: ${esc(r.subject)}</h2>
        <div>${reqPill(r)}</div>
        <dl class="kv">
          <dt>Nummer</dt><dd>${esc(r.number)}</dd>
          <dt>Soort</dt><dd>${esc(REQ_KIND[r.kind] || r.kind)}</dd>
          <dt>Gemeld</dt><dd>${esc(when(r.createdAt))}</dd>
          ${r.installation ? `<dt>Installatie</dt><dd>${esc(r.installation.title)}</dd>` : ''}
          ${r.address ? `<dt>Adres</dt><dd>${esc(r.address)}</dd>` : ''}
          ${r.phone ? `<dt>Telefoon</dt><dd>${esc(r.phone)}</dd>` : ''}
          ${r.preferred ? `<dt>Voorkeur</dt><dd>${esc(r.preferred)}</dd>` : ''}
        </dl>
        <h3>Uw omschrijving</h3><div class="notes">${esc(r.description)}</div>
        ${r.reply ? `<h3>Onze reactie</h3><div class="reply">${esc(r.reply)}</div>` : ''}
        ${r.workOrder ? `<h3>Werkzaamheden</h3><p>${r.workOrder.plannedDate ? `Ingepland op <b>${esc(day(r.workOrder.plannedDate))}</b>.` : 'Wij plannen de werkzaamheden in en laten u weten wanneer we komen.'}</p>
          <div class="actions"><button class="btn" data-open="${esc(r.workOrder.id)}">Bekijk de werkzaamheden</button></div>` : ''}
        ${photos.length ? `<h3>Foto's</h3><div class="photos">${photos.map((p, i) => `
          <figure><button type="button" data-rphoto="${i}" title="Vergroten"><img src="../${esc(p.thumbUrl)}" alt="Foto ${i + 1}" loading="lazy"></button>
          ${open ? `<figcaption><button type="button" class="btn small" data-rdel="${esc(p.id)}">Verwijderen</button></figcaption>` : ''}</figure>`).join('')}</div>` : ''}
        ${open ? `<div class="actions no-print" style="margin-top:16px">
          ${photos.length < MAX_REQ_PHOTOS ? `<label class="btn">Foto toevoegen<input type="file" id="r-add" accept="image/*" multiple hidden></label>` : ''}
          <button class="btn" id="r-withdraw">Melding intrekken</button></div>` : ''}
      </div>`;
    document.querySelectorAll('#detail-body [data-rphoto]').forEach((b) => { b.onclick = () => { const p = photos[Number(b.dataset.rphoto)]; showPhoto({ url: p.url, caption: `Foto bij melding ${r.number}` }); }; });
    document.querySelectorAll('#detail-body [data-rdel]').forEach((b) => { b.onclick = () => removeRequestPhoto(b.dataset.rdel); });
    const add = $('#r-add');
    if (add) add.onchange = async () => {
      const files = [...add.files].slice(0, MAX_REQ_PHOTOS - photos.length);
      if (!files.length) return;
      if (await uploadPhotos(r.id, files)) toast('Foto toegevoegd.');
      openRequest(r.id);
      load();
    };
    const w = $('#r-withdraw');
    if (w) w.onclick = withdraw;
    document.querySelectorAll('#detail-body [data-open]').forEach((b) => { b.onclick = () => openDetail(b.dataset.open); });
  }

  async function removeRequestPhoto(pid) {
    try {
      await api(`../api/portal/requests/${encodeURIComponent(state.request.id)}/photos/${encodeURIComponent(pid)}`, { method: 'DELETE' });
      openRequest(state.request.id);
      load();
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function withdraw() {
    if (!window.confirm('Weet u zeker dat u deze melding wilt intrekken?')) return;
    try {
      state.request = await api(`../api/portal/requests/${encodeURIComponent(state.request.id)}/withdraw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast('De melding is ingetrokken.');
      renderRequest();
      load();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderWork(d) {
    $('#work').innerHTML = d.workorders.map((w) => `
      <div class="card">
        <h3>${esc(w.title)}</h3>
        <div><span class="pill ${esc(w.status)}">${esc(w.statusLabel)}</span> ${appointmentPill(w)}</div>
        <div class="meta">${w.plannedDate ? `<span class="when">${esc(moment(w))}</span>` : 'Nog niet ingepland'}${w.installer ? ` · monteur ${esc(w.installer)}` : ''}</div>
        ${w.address ? `<div class="meta">${esc(w.address)}</div>` : ''}
        ${w.status === 'gereed'
          ? `<div class="meta">Opgeleverd${w.completedOn ? ` op ${esc(day(w.completedOn))}` : ''}</div>`
          : w.progress.steps ? `<div class="bar" title="${w.progress.done} van ${w.progress.steps} stappen klaar"><span style="width:${Number(w.progress.pct) || 0}%"></span></div>
            <div class="meta">${w.progress.done} van ${w.progress.steps} stappen klaar</div>` : ''}
        <div class="actions"><button class="btn${waiting(w) ? ' primary' : ''}" data-open="${esc(w.id)}">${w.status === 'gereed' ? 'Opleverdossier' : 'Details'}</button></div>
      </div>`).join('');
    $('#s-work').hidden = !d.workorders.length;
  }

  function renderQuotes(d) {
    $('#quotes').innerHTML = `<thead><tr><th>Nummer</th><th>Omschrijving</th><th>Status</th><th class="num">Totaal incl. btw</th><th>Datum</th><th></th></tr></thead>
      <tbody>${d.quotes.map((q) => `
        <tr><td><b>${esc(q.number)}</b></td><td class="wrap">${esc(q.title || '')}</td>
          <td><span class="pill ${esc(q.status)}">${esc(QUOTE_STATUS[q.status] || q.status)}</span></td>
          <td class="num">${money(q.totalIncl)}</td><td>${esc(when(q.updatedAt))}</td>
          <td><a class="btn small" href="../offertes/?id=${encodeURIComponent(q.id)}">Openen</a></td></tr>`).join('')}</tbody>`;
    $('#s-quotes').hidden = !d.quotes.length;
  }

  function renderPlans(d) {
    $('#plans').innerHTML = d.plans.slice(0, 6).map((p) => `
      <a class="tile" href="../beregening/?plan=${encodeURIComponent(p.id)}">
        <span class="tile-text">
          <span class="tile-title">${esc(p.title)}</span>
          <span class="tile-desc">${p.address ? `${esc(p.address)} · ` : ''}${p.summary ? `${p.summary.areas} vlakken, ${p.summary.sprinklers} sproeiers · ` : ''}gewijzigd ${esc(when(p.updatedAt))}</span>
        </span>
      </a>`).join('');
    $('#s-plans').hidden = !d.plans.length;
  }

  function renderContact(d) {
    const c = d.contact || {};
    const site = c.website ? (/^https?:\/\//i.test(c.website) ? c.website : `https://${c.website}`) : '';
    const rows = [
      c.companyName ? `<b>${esc(c.companyName)}</b>` : '',
      c.address ? `<span>${esc(c.address).replace(/\n/g, '<br>')}</span>` : '',
      c.phone ? `<span>Telefoon: <a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a></span>` : '',
      c.email ? `<span>E-mail: <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></span>` : '',
      site ? `<span>Website: <a href="${esc(site)}" target="_blank" rel="noopener">${esc(c.website)}</a></span>` : '',
    ].filter(Boolean);
    $('#contact').innerHTML = rows.join('');
    $('#s-contact').hidden = rows.length < 2;
  }

  // ---------- Opleverdossier ----------
  async function openDetail(id) {
    try {
      state.detail = await api(`../api/portal/workorders/${encodeURIComponent(id)}`);
    } catch (e) {
      toast(`Kan de werkorder niet openen: ${e.message}`, true);
      return;
    }
    renderDetail();
    $('#detail').hidden = false;
  }

  function renderDetail() {
    const w = state.detail;
    const g = w.design;
    const photos = w.photos || [];
    const a = w.appointment;
    const answer = a && a.response ? `<p class="muted small">${a.response.answer === 'bevestigd' ? 'Bevestigd' : 'Ander moment gevraagd'} door ${esc(a.response.name)} op ${esc(when(a.response.at))}${a.response.reason ? `: “${esc(a.response.reason)}”` : ''}</p>` : '';
    $('#detail-body').innerHTML = `
      <div class="dossier">
        <h2>${w.status === 'gereed' ? 'Opleverdossier' : 'Werkzaamheden'}: ${esc(w.title)}</h2>
        <div><span class="pill ${esc(w.status)}">${esc(w.statusLabel)}</span> ${appointmentPill(w)}</div>
        <dl class="kv">
          <dt>Werkorder</dt><dd>${esc(w.number)}</dd>
          ${w.quoteNumber ? `<dt>Offerte</dt><dd><a href="../offertes/?id=${encodeURIComponent(w.quoteId)}">${esc(w.quoteNumber)}</a></dd>` : ''}
          ${w.address ? `<dt>Adres</dt><dd>${esc(w.address)}</dd>` : ''}
          <dt>Gepland</dt><dd>${w.plannedDate ? esc(moment(w)) : 'Nog niet ingepland'}</dd>
          ${w.installer ? `<dt>Monteur</dt><dd>${esc(w.installer)}</dd>` : ''}
          ${w.report.completedOn ? `<dt>Opgeleverd</dt><dd>${esc(day(w.report.completedOn))}</dd>` : ''}
          ${w.report.signedBy ? `<dt>Getekend door</dt><dd>${esc(w.report.signedBy)}</dd>` : ''}
        </dl>
        ${a && a.state === 'wacht' ? `
          <div class="answer no-print">
            <b>Komt dit moment u uit?</b>
            <textarea id="a-reason" placeholder="Opmerking of een moment dat u beter uitkomt (optioneel)" maxlength="2000"></textarea>
            <div class="actions"><button class="btn primary" data-answer="bevestigd">Afspraak bevestigen</button><button class="btn" data-answer="ander_moment">Ander moment vragen</button></div>
          </div>` : answer}
        ${w.report.notes ? `<h3>Opmerkingen bij de oplevering</h3><div class="notes">${esc(w.report.notes)}</div>` : ''}
        ${photos.length ? `<h3>Foto's</h3><div class="photos">${photos.map((p, i) => `
          <figure><button type="button" data-photo="${i}" title="Vergroten"><img src="../${esc(p.thumbUrl || p.url)}" alt="${esc(p.caption || KIND[p.kind] || 'Foto')}" loading="lazy"></button>
            <figcaption>${esc(p.caption || KIND[p.kind] || '')}${p.takenAt ? ` · ${esc(when(p.takenAt))}` : ''}</figcaption></figure>`).join('')}</div>` : ''}
        ${g ? `<h3>Uw installatie</h3><dl class="kv">
          ${g.lawnM2 ? `<dt>Gazon</dt><dd>${Math.round(g.lawnM2)} m²</dd>` : ''}
          ${g.zones ? `<dt>Zones</dt><dd>${g.zones}</dd>` : ''}
          ${g.sprinklers ? `<dt>Sproeiers</dt><dd>${g.sprinklers}</dd>` : ''}
          ${g.pressureBar ? `<dt>Waterdruk</dt><dd>${g.pressureBar} bar</dd>` : ''}
          ${g.flowM3h ? `<dt>Debiet</dt><dd>${g.flowM3h} m³/u</dd>` : ''}
          ${g.mainPipe ? `<dt>Hoofdleiding</dt><dd>${esc(g.mainPipe)}</dd>` : ''}</dl>` : ''}
        ${w.zones.length ? `<h3>Zones</h3><div class="tablewrap"><table class="grid"><thead><tr><th>Zone</th><th>Soort</th><th>Onderdelen</th></tr></thead><tbody>
          ${w.zones.map((z) => `<tr><td>${esc(z.name)}</td><td>${esc(z.kind)}</td><td class="wrap">${esc(z.parts)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${w.steps.length ? `<h3>Werkzaamheden (${w.progress.done} van ${w.progress.steps} klaar)</h3><ul class="steps">
          ${w.steps.map((s) => `<li class="${s.done ? 'done' : ''}"><span class="tick">${s.done ? '✓' : '○'}</span><span>${esc(s.title)}</span><span class="phase">${esc(s.phaseLabel)}</span></li>`).join('')}</ul>` : ''}
        ${w.materials.length ? `<h3>Gebruikte materialen</h3><div class="tablewrap"><table class="grid"><thead><tr><th>Omschrijving</th><th class="num">Aantal</th><th>Eenheid</th></tr></thead><tbody>
          ${w.materials.map((m) => `<tr><td class="wrap">${esc(m.description || m.code)}</td><td class="num">${Number(m.qty).toLocaleString('nl-NL')}</td><td>${esc(m.unit)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="actions no-print" style="margin-top:16px"><button class="btn" id="d-print">Afdrukken of opslaan als PDF</button></div>
      </div>`;
    $('#d-print').onclick = () => window.print();
    document.querySelectorAll('#detail-body [data-answer]').forEach((b) => { b.onclick = () => respond(b.dataset.answer); });
    document.querySelectorAll('#detail-body [data-photo]').forEach((b) => { b.onclick = () => showPhoto(photos[Number(b.dataset.photo)]); });
  }

  async function respond(answer) {
    const reason = ($('#a-reason') || {}).value || '';
    if (answer === 'ander_moment' && !reason.trim()) { toast('Geef aan welk moment u beter uitkomt.', true); $('#a-reason').focus(); return; }
    document.querySelectorAll('#detail-body [data-answer]').forEach((b) => { b.disabled = true; });
    try {
      state.detail = { ...state.detail, ...(await api(`../api/portal/workorders/${encodeURIComponent(state.detail.id)}/appointment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer, reason }),
      })) };
      toast(answer === 'bevestigd' ? 'Afspraak bevestigd, bedankt!' : 'Uw verzoek is doorgegeven. Wij nemen contact met u op.');
      renderDetail();
      load();
    } catch (e) {
      toast(e.message, true);
      document.querySelectorAll('#detail-body [data-answer]').forEach((b) => { b.disabled = false; });
    }
  }

  function showPhoto(p) {
    if (!p) return;
    $('#photo-img').src = `../${p.url}`;
    $('#photo-img').alt = p.caption || 'Foto';
    $('#photo-cap').textContent = p.caption || KIND[p.kind] || '';
    $('#photo').hidden = false;
  }

  async function init() {
    // Kopbalk en portaal tegelijk laden (het portaal meldt zelf als je niet mag).
    const account = window.AquatechAccount.load('../');
    $('#detail-close').onclick = () => { $('#detail').hidden = true; };
    $('#detail').onclick = (e) => { if (e.target.id === 'detail') $('#detail').hidden = true; };
    $('#photo').onclick = () => { $('#photo').hidden = true; };
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#photo').hidden) $('#photo').hidden = true;
      else if (!$('#r-modal').hidden) closeForm();
      else $('#detail').hidden = true;
    });
    document.addEventListener('click', (e) => {
      const b = e.target.closest('main [data-open]');
      if (b) openDetail(b.dataset.open);
      const r = e.target.closest('main [data-req]');
      if (r) openRequest(r.dataset.req);
      const season = e.target.closest('main [data-season]');
      if (season) requestSeasonService(season.dataset.season);
    });
    $('#season-mail').onchange = (event) => saveSeasonMail(event.target.checked);
    $('#r-new').onclick = openForm;
    $('#r-close').onclick = closeForm;
    $('#r-cancel').onclick = closeForm;
    $('#r-modal').onclick = (e) => { if (e.target.id === 'r-modal') closeForm(); };
    form().addEventListener('submit', submitForm);
    form().addEventListener('change', (e) => {
      if (e.target.name === 'kind') syncKind();
      if (e.target.name === 'photos') {
        state.files = [...e.target.files].slice(0, MAX_REQ_PHOTOS);
        if (e.target.files.length > MAX_REQ_PHOTOS) toast(`Maximaal ${MAX_REQ_PHOTOS} foto's; de eerste ${MAX_REQ_PHOTOS} worden meegestuurd.`, true);
        previews();
      }
    });
    await Promise.all([account, load()]);
    // Terug via de knop Terug van de browser: opnieuw laden.
    if (window.AquatechCommon) window.AquatechCommon.onReturn(load);
    // Direct naar een werkorder of melding: portaal/#wo=<id> of #melding=<id>
    // (bijv. vanuit een e-mail); #melden opent het formulier.
    const m = /^#wo=([\w-]+)$/.exec(location.hash);
    if (m && state.data) openDetail(m[1]);
    const mr = /^#melding=([\w-]+)$/.exec(location.hash);
    if (mr && state.data) openRequest(mr[1]);
    if (location.hash === '#melden' && state.data && state.data.features.requests) openForm();
    // Vanuit de mail met een seizoensherinnering: ?herinnering=<sleutel>.
    const seasonKey = new URLSearchParams(location.search).get('herinnering');
    if (seasonKey && state.data) requestSeasonService(seasonKey);
  }

  init();
})();
