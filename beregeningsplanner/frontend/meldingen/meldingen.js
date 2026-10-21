// Meldingen: storingen en onderhoudsverzoeken van klanten (uit het
// klantportaal). Medewerkers (recht 'werkorders') zien het overzicht, openen
// een melding (?id=<id>), sturen de klant een reactie, houden een interne
// notitie bij en maken er een werkorder van. Gegevens uit /api/service-requests.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const KINDS = { storing: 'Storing', onderhoud: 'Onderhoud', overig: 'Vraag of verzoek' };
  const STATUSES = { nieuw: 'Nieuw', in_behandeling: 'In behandeling', ingepland: 'Werkorder gemaakt', afgehandeld: 'Afgehandeld', afgewezen: 'Afgewezen', ingetrokken: 'Ingetrokken door klant' };
  const OPEN = ['nieuw', 'in_behandeling'];

  const state = { items: [], item: null, staff: null };

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  async function api(url, { method = 'GET', body } = {}) {
    const res = await fetch(`../api/${url}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.message || `HTTP ${res.status}`), { status: res.status, code: out.error });
    return out;
  }

  const pill = (r) => `<span class="pill st-${esc(r.status)}">${esc(STATUSES[r.status] || r.status)}</span>${r.urgent ? ' <span class="pill spoed">Spoed</span>' : ''}`;

  // ---------- Overzicht ----------
  async function load() {
    const all = $('#m-all').checked;
    state.items = (await api(`service-requests${all ? '' : '?open=1'}`)).items;
    render();
  }

  function render() {
    const rows = state.items.map((r) => `
      <tr data-id="${esc(r.id)}" class="st-${esc(r.status)}">
        <td><b>${esc(r.number)}</b><span class="sub">${esc(when(r.createdAt))}</span></td>
        <td>${esc(r.customer.name)}<span class="sub">${esc(r.address)}</span></td>
        <td>${esc(KINDS[r.kind] || r.kind)}</td>
        <td class="wrap">${esc(r.subject)}${r.photoCount ? `<span class="sub">${r.photoCount} foto${r.photoCount > 1 ? "'s" : ''}</span>` : ''}</td>
        <td>${pill(r)}${r.workOrder ? `<span class="sub">${esc(r.workOrder.number)}${r.workOrder.plannedDate ? ` · ${esc(day(r.workOrder.plannedDate))}` : ''}</span>` : ''}</td>
      </tr>`).join('');
    $('#m-table').innerHTML = `<thead><tr><th>Melding</th><th>Klant</th><th>Soort</th><th>Onderwerp</th><th>Status</th></tr></thead><tbody>${rows}</tbody>`;
    $('#m-table').hidden = !state.items.length;
    $('#m-empty').hidden = Boolean(state.items.length);
  }

  // ---------- Detail ----------
  async function open(id, preloaded) {
    try {
      state.item = preloaded || await api(`service-requests/${encodeURIComponent(id)}`);
    } catch (e) {
      toast(e.status === 404 ? 'Deze melding bestaat niet (meer).' : `Kan de melding niet openen: ${e.message}`, true);
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('id', state.item.id);
    history.replaceState(null, '', url);
    renderDetail();
    $('#detail').hidden = false;
  }

  function close() {
    $('#detail').hidden = true;
    const url = new URL(location.href);
    url.searchParams.delete('id');
    history.replaceState(null, '', url);
  }

  async function staff() {
    if (!state.staff) state.staff = (await api('workorder-staff')).items;
    return state.staff;
  }

  function renderDetail() {
    const r = state.item;
    const photos = r.photos || [];
    const canConvert = !r.workOrder && r.status !== 'afgewezen' && r.status !== 'ingetrokken';
    const statuses = r.workOrder ? ['afgehandeld'] : ['nieuw', 'in_behandeling', 'afgehandeld', 'afgewezen'];
    $('#detail-body').innerHTML = `
      <div class="req">
        <h2>${esc(r.number)}: ${esc(r.subject)}</h2>
        <div>${pill(r)}</div>
        <dl class="kv">
          <dt>Soort</dt><dd>${esc(KINDS[r.kind] || r.kind)}${r.urgent ? ' (spoed)' : ''}</dd>
          <dt>Gemeld</dt><dd>${esc(when(r.createdAt))}</dd>
          <dt>Klant</dt><dd>${esc(r.customer.name)}</dd>
          ${r.address ? `<dt>Adres</dt><dd>${esc(r.address)}</dd>` : ''}
          ${r.phone ? `<dt>Telefoon</dt><dd><a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a></dd>` : ''}
          ${r.email ? `<dt>E-mail</dt><dd><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></dd>` : ''}
          ${r.preferred ? `<dt>Voorkeur</dt><dd>${esc(r.preferred)}</dd>` : ''}
          ${r.installation ? `<dt>Installatie</dt><dd><a href="../werkorders/?id=${encodeURIComponent(r.installation.id)}">${esc(r.installation.number)}</a> ${esc(r.installation.title)}</dd>` : ''}
          ${r.workOrder ? `<dt>Werkorder</dt><dd><a href="../werkorders/?id=${encodeURIComponent(r.workOrder.id)}">${esc(r.workOrder.number)}</a>${r.workOrder.plannedDate ? `, gepland ${esc(day(r.workOrder.plannedDate))}` : ', nog niet ingepland'}</dd>` : ''}
          ${r.handledBy ? `<dt>Behandeld door</dt><dd>${esc(r.handledBy)} (${esc(when(r.updatedAt))})</dd>` : ''}
        </dl>
        <h3>Omschrijving van de klant</h3><div class="text">${esc(r.description)}</div>
        ${photos.length ? `<h3>Foto's van de klant</h3><div class="photos">${photos.map((p, i) => `
          <button type="button" data-photo="${i}" title="Vergroten"><img src="../${esc(p.thumbUrl)}" alt="Foto ${i + 1}" loading="lazy"></button>`).join('')}</div>` : ''}
        ${canConvert ? `<div class="box">
          <h3>Werkorder maken</h3>
          <p class="small muted">Klantgegevens, omschrijving${r.installation ? ', ontwerp en zones van de installatie' : ''} en de foto's gaan mee. De klant ziet de werkorder en de afspraak in zijn portaal.</p>
          <div class="row"><label>Uitvoerder<select id="d-assignee"><option value="">Nog niet toewijzen</option></select></label>
            <button class="btn primary" id="d-convert" type="button">Werkorder maken</button></div>
        </div>` : ''}
        <form id="d-form" novalidate>
          <h3>Reactie en status</h3>
          <label>Reactie aan de klant (ziet hij in zijn portaal en per e-mail)<textarea name="reply" rows="3" maxlength="4000">${esc(r.reply)}</textarea></label>
          <label>Interne notitie (alleen voor medewerkers)<textarea name="note" rows="2" maxlength="4000">${esc(r.note)}</textarea></label>
          <div class="row">
            <label>Status<select name="status">${(statuses.includes(r.status) ? statuses : [r.status, ...statuses])
              .map((s) => `<option value="${s}"${s === r.status ? ' selected' : ''}${s === 'ingepland' || s === 'ingetrokken' ? ' disabled' : ''}>${esc(STATUSES[s])}</option>`).join('')}</select></label>
            <button class="btn primary" type="submit">Opslaan</button>
          </div>
          <div class="err" role="alert"></div>
        </form>
      </div>`;
    document.querySelectorAll('#detail-body [data-photo]').forEach((b) => {
      b.onclick = () => window.PhotoViewer.show(photos.map((p, i) => ({ src: `../${p.url}`, caption: `Foto ${i + 1} van de klant`, sub: r.number })), Number(b.dataset.photo));
    });
    $('#d-form').addEventListener('submit', save);
    const conv = $('#d-convert');
    if (conv) {
      conv.onclick = convert;
      staff().then((list) => {
        const sel = $('#d-assignee');
        if (sel) sel.insertAdjacentHTML('beforeend', list.map((u) => `<option value="${esc(u.id)}">${esc(u.displayName)}</option>`).join(''));
      }).catch(() => {});
    }
  }

  async function save(e) {
    e.preventDefault();
    const f = e.target;
    const body = { reply: f.reply.value, note: f.note.value };
    if (f.status.value !== state.item.status) body.status = f.status.value;
    try {
      state.item = await api(`service-requests/${encodeURIComponent(state.item.id)}`, { method: 'PUT', body });
      toast('Opgeslagen.');
      renderDetail();
      load();
    } catch (ex) {
      f.querySelector('.err').textContent = ex.message;
    }
  }

  async function convert() {
    const btn = $('#d-convert');
    btn.disabled = true;
    try {
      const out = await api(`service-requests/${encodeURIComponent(state.item.id)}/workorder`, { method: 'POST', body: { assigneeId: $('#d-assignee').value || null } });
      state.item = out.item;
      toast(`Werkorder ${out.workOrder.number} gemaakt.`);
      // Direct door naar de werkorder om hem in te vullen en in te plannen.
      location.href = `../werkorders/?id=${encodeURIComponent(out.workOrder.id)}`;
    } catch (ex) {
      btn.disabled = false;
      toast(ex.message, true);
    }
  }

  async function init() {
    const id = new URLSearchParams(location.search).get('id');
    // Melding en overzicht al ophalen terwijl de login-check loopt.
    const item = id ? api(`service-requests/${encodeURIComponent(id)}`).catch((e) => e) : null;
    const me = await window.AquatechAccount.load('../');
    if (!me.user || !(me.rights || []).includes('werkorders')) {
      const d = $('#m-denied');
      d.hidden = false;
      d.innerHTML = me.user && me.user.kind !== 'gast'
        ? 'Meldingen zijn er voor medewerkers. Als klant meldt u een storing in <a href="../portaal/#melden">Mijn portaal</a>.'
        : 'Log eerst in. <a href="../login">Inloggen</a>';
      return;
    }
    $('#m-app').hidden = false;
    $('#m-all').onchange = () => load().catch((e) => toast(e.message, true));
    $('#detail-close').onclick = close;
    $('#detail').onclick = (e) => { if (e.target.id === 'detail') close(); };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#detail').hidden && (!document.querySelector('.ph-viewer') || document.querySelector('.ph-viewer').hidden)) close();
    });
    $('#m-table').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) open(tr.dataset.id);
    });
    await Promise.all([
      load().catch((e) => toast(`Kan de meldingen niet laden: ${e.message}`, true)),
      item ? item.then((r) => (r instanceof Error ? toast(r.status === 404 ? 'Deze melding bestaat niet (meer).' : r.message, true) : open(r.id, r))) : null,
    ]);
    if (window.AquatechCommon) window.AquatechCommon.onReturn(() => load().catch(() => {}));
  }

  init();
})();
