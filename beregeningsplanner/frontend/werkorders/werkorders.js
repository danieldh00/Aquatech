// Werkorders: overzicht, een werkorder maken uit een geaccordeerde offerte,
// bewerken (planning, toewijzing, werkstappen afvinken, materialen
// verzamelen, oplevering) en exporteren als werkbon (afdrukversie via de
// browser, opslaan als PDF) of Excel. De server bewaart alles (/api/workorders);
// alleen beheerders en installateurs (recht 'werkorders') komen hier.
(function () {
  const W = window.WorkOrderCore;
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nl = (v, d = 2) => (Number(v) || 0).toLocaleString('nl-NL', { maximumFractionDigits: d });
  const eur = (v) => (Number(v) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
  const date = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : '–');
  const shortDate = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL') : '');
  const hours = (h) => (h ? `${nl(h)} u` : '–');
  const today = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const LIB = () => ({ Catalog: window.Catalog, Hydraulics: window.Hydraulics });
  const FINISHED = ['gereed', 'geannuleerd'];

  const state = {
    me: null, admin: false, staff: [], profile: null, mail: false,
    items: [], sort: { key: 'plannedDate', dir: 1 },
    wo: null, saveT: null, saving: null, dirty: false, warnings: [],
  };

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast screen show${err ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast screen'; }, 3500);
  }

  async function api(url, { method = 'GET', body } = {}) {
    const res = await fetch(`../api/${url}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.message || `HTTP ${res.status}`), { code: out.error });
    return out;
  }

  const params = () => new URLSearchParams(location.search);
  function go(query) {
    history.pushState(null, '', query ? `?${query}` : './');
    route();
  }

  // ---------- Overzicht ----------
  const progressBar = (p) => `<span class="bar" title="${p.done} van ${p.steps} stappen klaar"><span style="width:${p.pct}%"></span></span><span class="sub">${p.done}/${p.steps} stappen</span>`;
  const COLUMNS = [
    { key: 'number', label: 'Nummer', value: (w) => w.number, html: (w) => `<b>${esc(w.number)}</b>${w.quoteNumber ? `<span class="sub">${esc(w.quoteNumber)}</span>` : ''}` },
    { key: 'title', label: 'Klant en klus', value: (w) => w.customer || w.title, html: (w) => `${esc(w.customer || '–')}<span class="sub">${esc(w.address || w.title)}</span>`, cls: 'wrap' },
    { key: 'plannedDate', label: 'Gepland', value: (w) => (w.plannedDate ? `${w.plannedDate} ${w.startTime}` : '9999'), html: (w) => (w.plannedDate ? `${esc(shortDate(w.plannedDate))}${w.startTime ? `<span class="sub">${esc(w.startTime)}${w.endTime ? `–${esc(w.endTime)}` : ''} uur${w.days > 1 ? ` · ${w.days} dagen` : ''}</span>` : ''}${w.appointment && ['wacht', 'bevestigd', 'ander_moment'].includes(w.appointment.state) ? `<span class="sub"><span class="pill appt-${esc(w.appointment.state)}">${esc(W.APPOINTMENT[w.appointment.state])}</span></span>` : ''}` : '<span class="muted">Nog niet</span>') },
    { key: 'assignee', label: 'Uitvoerder', value: (w) => (w.assignee ? w.assignee.displayName : ''), html: (w) => esc(w.assignee ? w.assignee.displayName : '–') },
    { key: 'status', label: 'Status', value: (w) => w.status, html: (w) => `<span class="pill wo-${esc(w.status)}">${esc(W.STATUSES[w.status] || w.status)}</span>` },
    { key: 'progress', label: 'Voortgang', value: (w) => w.progress.pct, html: (w) => progressBar(w.progress) },
    { key: 'hours', label: 'Uren', value: (w) => w.progress.hours, html: (w) => esc(hours(w.progress.hours)), cls: 'num' },
    { key: 'updatedAt', label: 'Laatst gewijzigd', value: (w) => w.updatedAt, html: (w) => esc(new Date(w.updatedAt).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' })) },
  ];

  async function loadList() {
    try {
      state.items = (await api('workorders')).items || [];
    } catch (e) {
      $('#l-table').innerHTML = `<tr><td class="empty">Kan de werkorders niet laden (${esc(e.message)}).</td></tr>`;
      return;
    }
    renderList();
  }

  function visible() {
    const q = $('#l-search').value.trim().toLowerCase();
    const st = $('#l-status').value;
    const mine = $('#l-mine').checked;
    const done = $('#l-done').checked || FINISHED.includes(st);
    const col = COLUMNS.find((c) => c.key === state.sort.key) || COLUMNS[0];
    return state.items
      .filter((x) => (st ? x.status === st : done || !FINISHED.includes(x.status)))
      .filter((x) => !mine || x.assigneeId === state.me.user.id)
      .filter((x) => !q || [x.number, x.title, x.customer, x.address, x.quoteNumber, x.assignee && x.assignee.displayName].some((v) => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => {
        const va = col.value(a), vb = col.value(b);
        const cmp = typeof va === 'number' || typeof vb === 'number' ? (va || 0) - (vb || 0) : String(va || '').localeCompare(String(vb || ''), 'nl');
        return cmp * state.sort.dir;
      });
  }

  function renderList() {
    const items = visible();
    const count = (s) => state.items.filter((x) => x.status === s).length;
    const week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const soon = state.items.filter((x) => !FINISHED.includes(x.status) && x.plannedDate && x.plannedDate >= today() && x.plannedDate <= week).length;
    $('#l-stats').innerHTML = [
      [count('open'), 'nieuw, nog niet gepland'],
      [count('gepland'), 'gepland'],
      [soon, 'de komende 7 dagen'],
      [count('bezig'), 'in uitvoering'],
      [count('gereed'), 'gereed'],
    ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
    $('#l-stats').hidden = !state.items.length;
    const tbl = $('#l-table');
    if (!state.items.length) {
      tbl.innerHTML = '<tr><td class="empty">Nog geen werkorders. Kies <b>Nieuwe werkorder uit offerte</b>, of open een geaccordeerde offerte en kies daar <b>Werkorder maken</b>.</td></tr>';
      $('#l-count').textContent = '';
      return;
    }
    const head = COLUMNS.map((c) => {
      const sorted = c.key === state.sort.key ? (state.sort.dir > 0 ? ' asc' : ' desc') : '';
      return `<th data-sort="${c.key}" class="${c.cls === 'num' ? 'num' : ''}${sorted}">${esc(c.label)}</th>`;
    }).join('');
    tbl.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${items.map((x) => `
      <tr data-id="${esc(x.id)}">${COLUMNS.map((c) => `<td class="${c.cls || ''}">${c.html(x)}</td>`).join('')}</tr>`).join('')
      || `<tr><td class="empty" colspan="${COLUMNS.length}">Geen werkorders gevonden.</td></tr>`}</tbody>`;
    tbl.querySelectorAll('th[data-sort]').forEach((th) => {
      th.onclick = () => {
        const key = th.dataset.sort;
        state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (['updatedAt', 'progress', 'hours'].includes(key) ? -1 : 1) };
        renderList();
      };
    });
    tbl.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => go(`id=${encodeURIComponent(tr.dataset.id)}`); });
    $('#l-count').textContent = `${items.length} van ${state.items.length} werkorders`;
  }

  // ---------- Nieuwe werkorder ----------
  async function loadPlan(planId) {
    if (!planId) return null;
    try {
      return await api(`plans/${encodeURIComponent(planId)}`);
    } catch (e) {
      return null;
    }
  }

  async function createFromQuote(quoteId) {
    let quote;
    try {
      quote = await api(`quotes/${encodeURIComponent(quoteId)}`);
    } catch (e) {
      toast(`Kan de offerte niet laden: ${e.message}`, true);
      return go('');
    }
    if (quote.status !== 'akkoord') {
      toast(`Offerte ${quote.number} heeft nog geen akkoord; een werkorder kan pas na akkoord.`, true);
      return go('');
    }
    const plan = await loadPlan(quote.data && quote.data.planId);
    const built = W.fromQuote(quote, plan && plan.data, plan ? LIB() : null);
    // JSON: delen komen uit de plannerbibliotheken (andere objecten dan gewone data).
    const data = JSON.parse(JSON.stringify(built.data));
    if (quote.data && quote.data.planId && !plan) built.warnings.unshift('Het plan bij deze offerte is niet meer te openen; de zone-indeling ontbreekt.');
    try {
      const wo = await api('workorders', { method: 'POST', body: { quoteId: quote.id, data } });
      state.warnings = built.warnings;
      history.replaceState(null, '', `?id=${encodeURIComponent(wo.id)}`);
      openWorkOrder(wo);
      toast(`Werkorder ${wo.number} aangemaakt uit offerte ${quote.number}`);
    } catch (e) {
      toast(`Werkorder aanmaken mislukt: ${e.message}`, true);
      go('');
    }
  }

  async function pickQuote() {
    const modal = $('#quote-picker');
    const list = $('#qp-list');
    list.innerHTML = '<p class="muted small">Laden…</p>';
    modal.hidden = false;
    let quotes = [];
    try {
      const [qs, wos] = await Promise.all([api('quotes?all=1'), api('workorders')]);
      state.items = wos.items || [];
      quotes = (qs.items || []).filter((q) => q.status === 'akkoord');
    } catch (e) {
      list.innerHTML = `<p class="err">Kan de offertes niet laden (${esc(e.message)}).</p>`;
      return;
    }
    const render = () => {
      const q = $('#qp-search').value.trim().toLowerCase();
      const items = quotes.filter((x) => !q || [x.number, x.title, x.customer].some((v) => String(v || '').toLowerCase().includes(q)));
      list.innerHTML = items.map((x) => {
        const has = state.items.filter((w) => w.quoteId === x.id);
        return `<button data-quote="${esc(x.id)}"${has.length ? ' class="has"' : ''}><b>${esc(x.number)} · ${esc(x.customer || 'Geen klant')}</b>
          <span class="sub">${esc(x.title)} · ${esc(eur(x.totalExcl))} excl. btw · akkoord, gewijzigd ${esc(shortDate(x.updatedAt))}</span>
          ${has.length ? `<span class="sub warn-text">Heeft al ${has.length === 1 ? 'werkorder' : 'werkorders'} ${esc(has.map((w) => w.number).join(', '))}</span>` : ''}
        </button>`;
      }).join('') || `<p class="muted">${quotes.length ? 'Geen offertes gevonden.' : 'Er zijn nog geen offertes met status Akkoord. Zet in de module <a href="../offertes/">Offertes</a> een offerte op Akkoord, of wacht op het akkoord van de klant.'}</p>`;
      list.querySelectorAll('[data-quote]').forEach((b) => {
        b.onclick = () => {
          if (b.classList.contains('has') && !confirm('Voor deze offerte bestaat al een werkorder. Toch een nieuwe maken (bijvoorbeeld voor een tweede fase)?')) return;
          modal.hidden = true;
          go(`quote=${encodeURIComponent(b.dataset.quote)}`);
        };
      });
    };
    $('#qp-search').value = '';
    $('#qp-search').oninput = render;
    render();
    $('#qp-search').focus();
  }

  // ---------- Bewerken ----------
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  function setPath(obj, path, v) {
    const ks = path.split('.');
    const last = ks.pop();
    const target = ks.reduce((o, k) => (o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}), obj);
    target[last] = v;
  }

  async function loadWorkOrder(id) {
    try {
      openWorkOrder(await api(`workorders/${encodeURIComponent(id)}`));
    } catch (e) {
      toast(`Kan de werkorder niet openen: ${e.message}`, true);
      go('');
    }
  }

  function openWorkOrder(wo) {
    wo.data = W.sanitize(wo.data);
    state.wo = wo;
    state.dirty = false;
    $('#list-view').hidden = true;
    $('#edit-view').hidden = false;
    $('#e-heading').textContent = `Werkorder ${wo.number}`;
    document.title = `Werkorder ${wo.number} – AquaTech Service`;
    $('#e-status').value = wo.status;
    $('#e-saved').textContent = '';
    renderAssignee(wo);
    document.querySelectorAll('#edit-view [data-f]').forEach((el) => {
      const v = getPath(wo.data, el.dataset.f);
      el.value = v == null ? '' : v;
    });
    const d = wo.data;
    $('#e-links').innerHTML = [
      d.quoteId ? `Uit offerte <a href="../offertes/?id=${encodeURIComponent(d.quoteId)}">${esc(d.quoteNumber || 'offerte')}</a>` : '',
      d.planId ? `plan <a href="../beregening/?plan=${encodeURIComponent(d.planId)}">${esc(d.planTitle || 'beregeningsplan')}</a>` : '',
    ].filter(Boolean).join(' · ');
    $('#e-menu [data-act=openquote]').hidden = !d.quoteId;
    $('#e-menu [data-act=openplan]').hidden = !d.planId;
    $('#e-menu [data-act=rezones]').hidden = !d.planId;
    $('#e-menu [data-act=rematerials]').hidden = !d.quoteId;
    $('#e-menu [data-act=purge]').hidden = !state.admin;
    renderRoute();
    renderAppt();
    renderWarnings();
    renderDesign();
    renderSteps();
    renderMaterials();
    renderProgress();
    if (window.WorkOrderPhotos) window.WorkOrderPhotos.open(wo, { toast, statusOf: () => $('#e-status').value });
    window.scrollTo(0, 0);
  }

  // Route naar het adres (opent de kaart van het apparaat).
  function renderRoute() {
    const a = state.wo.data.customer.address.trim();
    $('#e-route').innerHTML = a ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.replace(/\n/g, ', '))}" target="_blank" rel="noopener">Route naar dit adres</a>` : '';
  }

  function renderAssignee(wo) {
    const sel = $('#e-assignee');
    const opts = state.staff.slice();
    if (wo.assignee && !opts.some((u) => u.id === wo.assignee.id)) opts.push({ ...wo.assignee, gone: true });
    sel.innerHTML = '<option value="">Nog niet toegewezen</option>' + opts
      .map((u) => `<option value="${esc(u.id)}">${esc(u.displayName)}${u.gone ? ' – uitgeschakeld' : ''}</option>`).join('');
    sel.value = wo.assigneeId || '';
  }

  // ---------- Afspraak met de klant (klantlink) ----------
  const dateTime = (iso) => new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
  const apptPill = (a) => `<span class="pill appt-${esc(a.state)}">${esc(W.APPOINTMENT[a.state] || a.state)}</span>`;
  // Het adres van de openbare pagina volgt uit waar deze module draait (ook
  // achter een padprefix); de server kent dat zelf niet.
  const shareBase = () => new URL('../openbaar/afspraak.html', location.href).href;

  function renderAppt() {
    const wo = state.wo;
    const box = $('#e-appt');
    const a = wo.appointment || { state: 'geen', response: null };
    const s = wo.share || { active: false };
    const r = a.response;
    const resp = r ? `<p class="small">${r.answer === 'bevestigd' ? 'Bevestigd' : 'Ander moment gevraagd'} door <b>${esc(r.name)}</b> op ${esc(dateTime(r.at))}${r.current ? '' : ' <span class="muted">(voor een eerder moment)</span>'}${r.reason ? `<br><span class="quote-reason">“${esc(r.reason)}”</span>` : ''}</p>` : '';
    const stats = [s.sharedAt ? `Link gemaakt ${esc(dateTime(s.sharedAt))}` : '', s.sentAt ? `verstuurd naar <b>${esc(s.sentTo)}</b> op ${esc(dateTime(s.sentAt))}` : '',
      s.active ? (s.viewedAt ? `geopend ${esc(dateTime(s.viewedAt))}` : 'nog niet geopend') : ''].filter(Boolean).join(' · ');
    const planned = Boolean(wo.data.plannedDate);
    box.innerHTML = `<h4>Afspraak met de klant ${apptPill(a)}</h4>${resp}
      ${s.active && s.url ? `<div class="link-row"><input id="ap-url" readonly value="${esc(s.url)}" aria-label="Link naar de afspraak">
        <button class="btn small" data-ap="copy">Kopiëren</button><button class="btn small" data-ap="preview" title="Openen zoals de klant hem ziet">Openen</button></div>` : ''}
      <div class="actions">${planned ? `<button class="btn small primary" data-ap="send">${s.sentAt || r ? 'Opnieuw naar de klant' : 'Afspraak naar de klant'}</button>` : '<span class="muted small">Plan eerst een datum in; daarna kan de klant de afspraak via een link bevestigen.</span>'}
        ${s.active ? '<button class="btn small" data-ap="revoke">Link intrekken</button>' : ''}</div>
      ${stats ? `<p class="muted small">${stats}</p>` : ''}`;
  }

  async function apptAction(act) {
    const wo = state.wo;
    try {
      if (act === 'copy') {
        const input = $('#ap-url');
        try { await navigator.clipboard.writeText(input.value); } catch (e) { input.select(); document.execCommand('copy'); }
        toast('Link gekopieerd');
      } else if (act === 'preview') {
        window.open(`${wo.share.url}&voorbeeld=1`, '_blank', 'noopener');
      } else if (act === 'revoke') {
        if (!confirm('De link intrekken? De klant kan de afspraak dan niet meer openen; een nieuwe link is een ander adres.')) return;
        applyAppt(await api(`workorders/${encodeURIComponent(wo.id)}/share`, { method: 'DELETE' }));
        toast('Link ingetrokken');
      } else if (act === 'send') {
        await save();
        openApptSend();
      }
    } catch (e) {
      toast(e.message, true);
    }
  }

  function applyAppt(out) {
    if (!state.wo || out.id !== state.wo.id) return;
    state.wo.share = out.share;
    state.wo.appointment = out.appointment;
    renderAppt();
  }

  const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const momentLine = (d) => {
    const days = W.workDays(d.plannedDate, d.days);
    return `${longDate(d.plannedDate)}${d.startTime ? `, ${d.startTime}${d.endTime ? `–${d.endTime}` : ''} uur` : ''}${days.length > 1 ? ` (${days.length} werkdagen, t/m ${longDate(days[days.length - 1])})` : ''}`;
  };

  function openApptSend() {
    const wo = state.wo;
    const d = wo.data;
    const p = state.profile || {};
    $('#as-to').value = d.customer.email || '';
    $('#as-subject').value = `Afspraak ${d.title ? `${d.title.toLowerCase()} ` : ''}op ${longDate(d.plannedDate)}`;
    $('#as-message').value = [
      `Beste ${d.customer.contact || d.customer.name || 'klant'},`,
      `Wij hebben de werkzaamheden${d.title ? ` (${d.title})` : ''} ingepland op ${momentLine(d)}${d.customer.address ? `, op ${d.customer.address.replace(/\n/g, ', ')}` : ''}.`,
      'Wilt u via de knop hieronder laten weten of dit moment u past? Komt het niet goed uit, dan kunt u daar ook een ander moment voorstellen.',
      `Met vriendelijke groet,\n${p.companyName || ''}`,
    ].join('\n\n');
    $('#as-err').textContent = '';
    $('#as-send').hidden = !state.mail;
    $('#appt-send').hidden = false;
    $('#as-to').focus();
  }

  async function ensureShare() {
    const wo = state.wo;
    if (!wo.share || !wo.share.active || !wo.share.url) applyAppt(await api(`workorders/${encodeURIComponent(wo.id)}/share`, { method: 'POST', body: { url: shareBase() } }));
    return wo.share.url;
  }

  function bindApptSend() {
    $('#e-appt').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ap]');
      if (b) apptAction(b.dataset.ap);
    });
    $('#as-send').onclick = async () => {
      const wo = state.wo;
      const btn = $('#as-send');
      btn.disabled = true;
      try {
        applyAppt(await api(`workorders/${encodeURIComponent(wo.id)}/send`, {
          method: 'POST', body: { to: $('#as-to').value, subject: $('#as-subject').value, message: $('#as-message').value, url: shareBase() },
        }));
        $('#appt-send').hidden = true;
        toast(`Afspraak verstuurd naar ${$('#as-to').value}`);
      } catch (err) {
        if (err.code === 'not_configured') { state.mail = false; $('#as-send').hidden = true; }
        $('#as-err').textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    };
    // Zonder eigen mailserver: link maken en het bericht in het eigen mailprogramma openen.
    $('#as-mailto').onclick = async () => {
      try {
        const url = await ensureShare();
        const body = `${$('#as-message').value}\n\nAfspraak bekijken en bevestigen:\n${url}`;
        location.href = `mailto:${encodeURIComponent($('#as-to').value.trim()).replace(/%40/g, '@').replace(/%2C/g, ',')}?subject=${encodeURIComponent($('#as-subject').value)}&body=${encodeURIComponent(body)}`;
        $('#appt-send').hidden = true;
      } catch (err) {
        $('#as-err').textContent = err.message;
      }
    };
    $('#as-copy').onclick = async () => {
      try {
        const url = await ensureShare();
        try { await navigator.clipboard.writeText(url); } catch (e) { /* link staat ook in de werkorder */ }
        $('#appt-send').hidden = true;
        toast('Link gemaakt en gekopieerd');
      } catch (err) {
        $('#as-err').textContent = err.message;
      }
    };
  }

  function renderWarnings() {
    const w = state.warnings || [];
    $('#e-warnings').hidden = !w.length;
    $('#e-warnings').innerHTML = w.length ? `<b>Let op bij het plan:</b><ul>${w.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  }

  function designLine(g) {
    if (!g) return '';
    return [g.lawnM2 ? `${nl(g.lawnM2, 0)} m² gazon` : '', g.sprinklers ? `${g.sprinklers} sproeiers` : '', g.zones ? `${g.zones} zones` : '',
      g.pressureBar ? `waterdruk ${nl(g.pressureBar, 1)} bar` : '', g.flowM3h ? `debiet ${nl(g.flowM3h, 1)} m³/u` : '',
      g.mainPipe ? `hoofdleiding ${g.mainPipe}` : '', g.level ? `uitvoering ${g.level}` : ''].filter(Boolean).join(' · ');
  }

  function zonesTable(zones, cls) {
    if (!zones.length) return '';
    return `<table class="${cls}"><thead><tr><th>Zone</th><th>Soort</th><th>Onderdelen</th><th class="num">Debiet</th><th class="num">Leiding</th><th class="num">Druk laatste kop</th></tr></thead>
      <tbody>${zones.map((z) => `<tr${z.ok ? '' : ' class="bad"'}><td><b>${esc(z.name)}</b></td><td>${esc(z.kind)}</td><td>${esc(z.parts)}</td>
        <td class="num">${nl(z.flowLph / 1000, 2)} m³/u</td><td class="num">${nl(z.pipeM, 0)} m</td>
        <td class="num">${nl(z.pressureBar, 1)} bar${z.ok ? '' : ` (min. ${nl(z.requiredBar, 1)})`}</td></tr>`).join('')}</tbody></table>`;
  }

  function renderDesign() {
    const d = state.wo.data;
    const line = designLine(d.design);
    $('#e-design-card').hidden = !line && !d.zones.length;
    $('#e-design').innerHTML = `${line ? `<p class="design-line">${esc(line)}</p>` : ''}${zonesTable(d.zones, 'lines zones')}`;
  }

  function stepRow(s) {
    return `<tr class="line${s.done ? ' done' : ''}" data-step="${esc(s.id)}">
      <td class="c-chk"><input type="checkbox" data-s="done"${s.done ? ' checked' : ''} aria-label="Klaar"></td>
      <td class="c-desc"><input data-s="title" value="${esc(s.title)}" maxlength="300" placeholder="Werkstap">
        <input data-s="details" class="details" value="${esc(s.details)}" maxlength="2000" placeholder="Toelichting (optioneel)"></td>
      <td class="c-qty"><input data-s="hours" class="num" type="number" min="0" step="0.25" value="${s.hours || ''}" aria-label="Geplande uren" placeholder="–"></td>
      <td class="c-qty"><input data-s="actualHours" class="num" type="number" min="0" step="0.25" value="${s.actualHours ?? ''}" aria-label="Werkelijke uren" placeholder="–"></td>
      <td class="c-del"><button class="btn ghost icon" data-del-step title="Stap verwijderen">✕</button></td>
    </tr>`;
  }

  function renderSteps() {
    const d = state.wo.data;
    $('#e-steps').innerHTML = `<table class="lines steps">
      <thead><tr><th></th><th>Werkstap</th><th class="num">Gepland</th><th class="num">Werkelijk</th><th></th></tr></thead>
      <tbody>${Object.entries(W.PHASES).map(([key, label]) => `
        <tr class="section"><td colspan="5">${esc(label)}</td></tr>
        ${d.steps.filter((s) => s.phase === key).map(stepRow).join('')}
        <tr class="add"><td colspan="5"><button class="btn small" data-add-step="${key}">+ Stap ${esc(label.toLowerCase())}</button></td></tr>`).join('')}
      </tbody></table>`;
  }

  function materialRow(m) {
    return `<tr class="line${m.picked ? ' done' : ''}" data-mat="${esc(m.id)}">
      <td class="c-chk"><input type="checkbox" data-m="picked"${m.picked ? ' checked' : ''} aria-label="Verzameld"></td>
      <td class="c-desc"><input data-m="description" value="${esc(m.description)}" maxlength="500" placeholder="Omschrijving">${m.code ? `<span class="code">${esc(m.code)}</span>` : ''}</td>
      <td class="c-qty"><input data-m="qty" class="num" type="number" step="any" value="${m.qty}" aria-label="Aantal"></td>
      <td class="c-unit"><input data-m="unit" value="${esc(m.unit)}" maxlength="12" aria-label="Eenheid"></td>
      <td class="c-del"><button class="btn ghost icon" data-del-mat title="Regel verwijderen">✕</button></td>
    </tr>`;
  }

  function renderMaterials() {
    const d = state.wo.data;
    $('#e-materials').innerHTML = `<table class="lines mats">
      <thead><tr><th></th><th>Omschrijving</th><th class="num">Aantal</th><th>Eenh.</th><th></th></tr></thead>
      <tbody>${d.materials.map(materialRow).join('') || '<tr><td colspan="5" class="muted">Geen materialen.</td></tr>'}
        <tr class="add"><td colspan="5"><button class="btn small" data-add-mat>+ Materiaal</button>
          <button class="btn small" data-pick-all>Alles verzameld</button></td></tr>
      </tbody></table>`;
  }

  function renderProgress() {
    const p = W.progress(state.wo.data);
    $('#e-progress').innerHTML = `<div class="bar big"><span style="width:${p.pct}%"></span></div>
      <span class="muted small">${p.done} van ${p.steps} stappen klaar · ${p.picked} van ${p.materials} materialen verzameld</span>`;
    $('#e-hours').textContent = `Gepland ${hours(p.hours)} · werkelijk ${hours(p.actualHours)}`;
    $('#e-picked').textContent = `${p.picked} van ${p.materials} verzameld`;
  }

  function changed() {
    state.dirty = true;
    $('#e-saved').textContent = 'Wijzigingen…';
    clearTimeout(state.saveT);
    state.saveT = setTimeout(save, 1000);
  }

  async function save(extra = {}) {
    clearTimeout(state.saveT);
    const wo = state.wo;
    if (!wo) return;
    if (state.saving) await state.saving;
    if (!state.dirty && !Object.keys(extra).length) return;
    state.dirty = false;
    $('#e-saved').textContent = 'Opslaan…';
    state.saving = (async () => {
      try {
        const out = await api(`workorders/${encodeURIComponent(wo.id)}`, { method: 'PUT', body: { data: wo.data, ...extra } });
        if (state.wo === wo) {
          wo.status = out.status;
          wo.assigneeId = out.assigneeId;
          wo.assignee = out.assignee;
          wo.appointment = out.appointment;
          wo.share = out.share;
          renderAppt();
          $('#e-status').value = out.status;
          $('#e-saved').textContent = `Opgeslagen ${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`;
        }
      } catch (e) {
        state.dirty = true;
        $('#e-saved').textContent = 'Niet opgeslagen';
        toast(`Opslaan mislukt: ${e.message}`, true);
      } finally {
        state.saving = null;
      }
    })();
    return state.saving;
  }

  const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  function bindEditor() {
    const view = $('#edit-view');
    view.addEventListener('input', (e) => {
      const wo = state.wo;
      if (!wo) return;
      const t = e.target;
      if (t.dataset.f) {
        setPath(wo.data, t.dataset.f, t.dataset.f === 'days' ? Math.max(1, Math.min(W.MAX_DAYS, Math.round(Number(t.value) || 1))) : t.value);
        if (t.dataset.f === 'customer.address') renderRoute();
        // Een datum geven aan een nieuwe werkorder = ingepland.
        if (t.dataset.f === 'plannedDate' && t.value && wo.status === 'open') {
          $('#e-status').value = 'gepland';
          return save({ status: 'gepland' }).then(() => {});
        }
        return changed();
      }
      const tr = t.closest('[data-step], [data-mat]');
      if (!tr) return;
      if (t.dataset.s) {
        const s = wo.data.steps.find((x) => x.id === tr.dataset.step);
        if (!s) return;
        const k = t.dataset.s;
        if (k === 'done') { s.done = t.checked; tr.classList.toggle('done', s.done); }
        else if (k === 'hours') s.hours = Number(t.value) || 0;
        else if (k === 'actualHours') s.actualHours = t.value === '' ? null : Number(t.value) || 0;
        else s[k] = t.value;
        renderProgress();
        // Eerste afgevinkte stap: de klus is begonnen.
        if (k === 'done' && s.done && ['open', 'gepland'].includes(wo.status)) {
          $('#e-status').value = 'bezig';
          return save({ status: 'bezig' });
        }
        return changed();
      }
      if (t.dataset.m) {
        const m = wo.data.materials.find((x) => x.id === tr.dataset.mat);
        if (!m) return;
        const k = t.dataset.m;
        if (k === 'picked') { m.picked = t.checked; tr.classList.toggle('done', m.picked); }
        else if (k === 'qty') m.qty = Number(t.value) || 0;
        else m[k] = t.value;
        renderProgress();
        return changed();
      }
    });
    view.addEventListener('click', (e) => {
      const wo = state.wo;
      if (!wo) return;
      const addStep = e.target.closest('[data-add-step]');
      if (addStep) {
        const phase = addStep.dataset.addStep;
        const step = W.sanitizeStep({ id: newId('s'), phase });
        let at = -1;
        wo.data.steps.forEach((s, i) => { if (s.phase === phase) at = i; });
        wo.data.steps.splice(at < 0 ? wo.data.steps.length : at + 1, 0, step);
        renderSteps();
        renderProgress();
        const input = $(`[data-step="${step.id}"] [data-s=title]`);
        if (input) input.focus();
        return changed();
      }
      const delStep = e.target.closest('[data-del-step]');
      if (delStep) {
        const id = delStep.closest('[data-step]').dataset.step;
        wo.data.steps = wo.data.steps.filter((s) => s.id !== id);
        renderSteps();
        renderProgress();
        return changed();
      }
      if (e.target.closest('[data-add-mat]')) {
        const m = W.sanitizeMaterial({ id: newId('m'), qty: 1, unit: 'st' });
        wo.data.materials.push(m);
        renderMaterials();
        renderProgress();
        const input = $(`[data-mat="${m.id}"] [data-m=description]`);
        if (input) input.focus();
        return changed();
      }
      if (e.target.closest('[data-pick-all]')) {
        const all = wo.data.materials.every((m) => m.picked);
        wo.data.materials.forEach((m) => { m.picked = !all; });
        renderMaterials();
        renderProgress();
        return changed();
      }
      const delMat = e.target.closest('[data-del-mat]');
      if (delMat) {
        const id = delMat.closest('[data-mat]').dataset.mat;
        wo.data.materials = wo.data.materials.filter((m) => m.id !== id);
        renderMaterials();
        renderProgress();
        return changed();
      }
    });
    $('#e-status').onchange = (e) => {
      const wo = state.wo;
      if (e.target.value === 'gereed' && !wo.data.report.completedOn) {
        wo.data.report.completedOn = today();
        $('[data-f="report.completedOn"]').value = wo.data.report.completedOn;
        state.dirty = true;
      }
      save({ status: e.target.value });
    };
    $('#e-assignee').onchange = (e) => save({ assigneeId: e.target.value || null });
    $('#e-back').onclick = async () => { await save(); go(''); };
    $('#e-pdf').onclick = printWorkOrder;
    $('#e-xlsx').onclick = exportWorkOrderXlsx;
    $('#e-more').onclick = (e) => { e.stopPropagation(); $('#e-menu').hidden = !$('#e-menu').hidden; };
    document.addEventListener('click', () => { $('#e-menu').hidden = true; });
    $('#e-menu').onclick = (e) => {
      const act = e.target.dataset.act;
      if (act) menuAction(act);
    };
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) { save(); e.preventDefault(); e.returnValue = ''; }
    });
  }

  async function menuAction(act) {
    const wo = state.wo;
    if (!wo) return;
    const d = wo.data;
    if (act === 'openquote') {
      await save();
      location.href = `../offertes/?id=${encodeURIComponent(d.quoteId)}`;
    } else if (act === 'openplan') {
      await save();
      location.href = `../beregening/?plan=${encodeURIComponent(d.planId)}`;
    } else if (act === 'rezones') {
      const plan = await loadPlan(d.planId);
      if (!plan) return toast('Het plan is niet meer te openen.', true);
      try {
        const z = JSON.parse(JSON.stringify(W.zonesFromPlan(plan.data, LIB())));
        d.zones = z.zones;
        d.design = z.design || d.design;
        d.planTitle = plan.title;
        state.warnings = z.warnings;
        renderWarnings();
        renderDesign();
        changed();
        toast('Zone-indeling bijgewerkt uit het plan');
      } catch (e) {
        toast(`Zone-indeling mislukt: ${e.message}`, true);
      }
    } else if (act === 'rematerials') {
      if (!confirm('De materiaallijst opnieuw uit de offerte overnemen? Eigen wijzigingen en afvinkingen in de materialen gaan verloren.')) return;
      try {
        const quote = await api(`quotes/${encodeURIComponent(d.quoteId)}`);
        d.materials = W.fromQuote(quote).data.materials;
        renderMaterials();
        renderProgress();
        changed();
        toast('Materialen bijgewerkt uit de offerte');
      } catch (e) {
        toast(`Kan de offerte niet laden: ${e.message}`, true);
      }
    } else if (act === 'delete') {
      if (!confirm(`Werkorder ${wo.number} verwijderen?`)) return;
      try {
        await api(`workorders/${encodeURIComponent(wo.id)}`, { method: 'DELETE' });
        state.dirty = false;
        toast(`Werkorder ${wo.number} verwijderd`);
        go('');
      } catch (e) {
        toast(`Verwijderen mislukt: ${e.message}`, true);
      }
    } else if (act === 'purge') {
      if (!confirm(`Werkorder ${wo.number} definitief wissen, inclusief klantgegevens? Dit kan niet ongedaan worden gemaakt.`)) return;
      try {
        await api(`admin/workorders/${encodeURIComponent(wo.id)}`, { method: 'DELETE' });
        state.dirty = false;
        toast(`Werkorder ${wo.number} gewist`);
        go('');
      } catch (e) {
        toast(`Wissen mislukt: ${e.message}`, true);
      }
    }
  }

  // ---------- Werkbon (afdrukversie) ----------
  const box = (on) => `<span class="p-box">${on ? '✓' : ''}</span>`;

  function renderPrint() {
    const wo = state.wo;
    const d = wo.data;
    const p = state.profile || {};
    const c = d.customer;
    const pr = W.progress(d);
    const company = [p.address, [p.phone, p.email].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    const to = [c.name, c.contact ? `T.a.v. ${c.contact}` : '', c.address, c.phone ? `Tel. ${c.phone}` : ''].filter(Boolean).join('\n');
    const steps = Object.entries(W.PHASES).map(([key, label]) => {
      const list = d.steps.filter((s) => s.phase === key);
      if (!list.length) return '';
      return `<tr class="p-section"><td colspan="4">${esc(label)}</td></tr>${list.map((s) => `
        <tr><td class="chk">${box(s.done)}</td><td>${esc(s.title)}${s.details ? `<div class="p-small">${esc(s.details)}</div>` : ''}</td>
        <td class="num">${s.hours ? `${nl(s.hours)} u` : ''}</td><td class="num">${s.actualHours != null ? `${nl(s.actualHours)} u` : '<span class="p-fill"></span>'}</td></tr>`).join('')}`;
    }).join('');
    const mats = d.materials.map((m) => `<tr><td class="chk">${box(m.picked)}</td><td>${esc(m.description)}${m.code ? ` <span class="p-small">${esc(m.code)}</span>` : ''}</td>
      <td class="num">${nl(m.qty)}</td><td>${esc(m.unit)}</td></tr>`).join('');
    const line = designLine(d.design);
    const text = (title, v) => (v ? `<h2>${esc(title)}</h2><p class="p-text">${esc(v)}</p>` : '');
    $('#print').innerHTML = `
      <header class="p-head">
        <img src="../shared/logo-white.png" alt="${esc(p.companyName || 'AquaTech Service')}">
        <div class="p-company"><b>${esc(p.companyName || '')}</b>\n${esc(company)}</div>
      </header>
      <div class="p-meta">
        <div class="p-to"><div class="lbl">Klant en adres</div>${esc(to || '–')}</div>
        <div class="p-info"><table>
          <tr><td>Werkorder</td><td><b>${esc(wo.number)}</b></td></tr>
          ${d.quoteNumber ? `<tr><td>Offerte</td><td>${esc(d.quoteNumber)}</td></tr>` : ''}
          <tr><td>Datum</td><td>${esc(date(d.plannedDate))}${d.startTime ? `, ${esc(d.startTime)} uur` : ''}</td></tr>
          <tr><td>Uitvoerder</td><td>${esc(wo.assignee ? wo.assignee.displayName : '–')}</td></tr>
          ${d.crew ? `<tr><td>Ploeg</td><td>${esc(d.crew)}</td></tr>` : ''}
          <tr><td>Geplande uren</td><td>${esc(hours(pr.hours))}</td></tr>
        </table></div>
      </div>
      <h1>Werkbon</h1>
      <div class="p-sub">${esc(d.title)}</div>
      ${line ? `<div class="p-design"><b>Ontwerp${d.planTitle ? ` ${esc(d.planTitle)}` : ''}:</b> ${esc(line)}</div>` : ''}
      ${text('Werkinstructies', d.instructions)}
      ${text('Bijzonderheden locatie', d.siteNotes)}
      ${d.zones.length ? `<h2>Zone-indeling</h2>${zonesTable(d.zones, 'p-lines p-zones')}` : ''}
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
        <p class="p-text p-notes">${esc(d.report.notes || '')}</p>
        <div class="p-sign"><div>Uitvoerder (naam, datum)</div><div>Klant voor gezien${d.report.signedBy ? `: ${esc(d.report.signedBy)}` : ''}${d.report.completedOn ? `, ${esc(shortDate(d.report.completedOn))}` : ''}</div></div>
        <footer class="p-foot">${esc([p.companyName, p.website].filter(Boolean).join(' · '))}</footer>
      </div>`;
  }

  async function printWorkOrder() {
    await save();
    renderPrint();
    const old = document.title;
    const c = state.wo.data.customer.name;
    document.title = `Werkbon ${state.wo.number}${c ? ` ${c}` : ''}`;
    const img = $('#print img');
    if (img && !img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
    window.print();
    setTimeout(() => { document.title = old; }, 500);
  }

  // ---------- Excel ----------
  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const safeName = (s) => String(s || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const NAVY = 'FF172F5E';
  const headStyle = (row) => {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  };
  const asDate = (iso) => (iso ? new Date(`${iso}T12:00:00`) : null);

  async function exportWorkOrderXlsx() {
    if (!window.ExcelJS) { toast('Excel-export niet beschikbaar.', true); return; }
    await save();
    const wo = state.wo;
    const d = wo.data;
    try {
      const wb = new ExcelJS.Workbook();
      wb.creator = (state.profile && state.profile.companyName) || 'AquaTech Service';
      wb.created = new Date();
      const ws = wb.addWorksheet('Werkorder', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      ws.columns = [{ width: 16 }, { width: 60 }, { width: 12 }, { width: 12 }, { width: 10 }];
      ws.addRow([`Werkorder ${wo.number}`]).font = { bold: true, size: 14, color: { argb: NAVY } };
      const info = [
        ['Omschrijving', d.title], ['Offerte', d.quoteNumber], ['Status', W.STATUSES[wo.status]],
        ['Datum', asDate(d.plannedDate) || ''], ['Starttijd', d.startTime], ['Uitvoerder', wo.assignee ? wo.assignee.displayName : ''], ['Ploeg', d.crew],
        ['Klant', d.customer.name], ['Contactpersoon', d.customer.contact], ['Adres', d.customer.address.replace(/\n/g, ', ')],
        ['Telefoon', d.customer.phone], ['E-mail', d.customer.email], ['Ontwerp', designLine(d.design)],
        ['Werkinstructies', d.instructions], ['Bijzonderheden', d.siteNotes],
      ].filter(([, v]) => v !== '' && v != null);
      for (const [k, v] of info) {
        const r = ws.addRow([k, v]);
        r.getCell(1).font = { bold: true };
        r.getCell(2).alignment = { horizontal: 'left', wrapText: true, vertical: 'top' };
        if (v instanceof Date) r.getCell(2).numFmt = 'dd-mm-yyyy';
      }
      ws.addRow([]);
      headStyle(ws.addRow(['Fase', 'Werkstap', 'Gepland (u)', 'Werkelijk (u)', 'Klaar']));
      const first = ws.lastRow.number + 1;
      for (const [key, label] of Object.entries(W.PHASES)) {
        for (const s of d.steps.filter((x) => x.phase === key)) {
          ws.addRow([label, s.details ? `${s.title} – ${s.details}` : s.title, s.hours || null, s.actualHours, s.done ? 'ja' : 'nee']);
        }
      }
      const last = ws.lastRow.number;
      const tot = ws.addRow(['', 'Totaal', { formula: `SUM(C${first}:C${Math.max(first, last)})` }, { formula: `SUM(D${first}:D${Math.max(first, last)})` }]);
      tot.font = { bold: true };
      if (d.zones.length) {
        const zs = wb.addWorksheet('Zones', { views: [{ state: 'frozen', ySplit: 1 }] });
        zs.columns = [
          { header: 'Zone', key: 'name', width: 12 }, { header: 'Soort', key: 'kind', width: 24 }, { header: 'Onderdelen', key: 'parts', width: 50 },
          { header: 'Debiet (m³/u)', key: 'flow', width: 14, style: { numFmt: '0.00' } }, { header: 'Leiding (m)', key: 'pipe', width: 12, style: { numFmt: '0' } },
          { header: 'Druk laatste kop (bar)', key: 'p', width: 20, style: { numFmt: '0.0' } },
        ];
        for (const z of d.zones) zs.addRow({ name: z.name, kind: z.kind, parts: z.parts, flow: z.flowLph / 1000, pipe: z.pipeM, p: z.pressureBar });
        headStyle(zs.getRow(1));
      }
      const ms = wb.addWorksheet('Materialen', { views: [{ state: 'frozen', ySplit: 1 }] });
      ms.columns = [
        { header: 'Artikelcode', key: 'code', width: 16 }, { header: 'Omschrijving', key: 'description', width: 56 },
        { header: 'Aantal', key: 'qty', width: 10 }, { header: 'Eenheid', key: 'unit', width: 10 }, { header: 'Verzameld', key: 'picked', width: 11 },
      ];
      for (const m of d.materials) ms.addRow({ code: m.code, description: m.description, qty: m.qty, unit: m.unit, picked: m.picked ? 'ja' : 'nee' });
      headStyle(ms.getRow(1));
      ms.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 5 } };
      download(new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_TYPE }), `werkorder_${safeName(wo.number)}${d.customer.name ? `_${safeName(d.customer.name)}` : ''}.xlsx`);
    } catch (e) {
      console.error(e);
      toast(`Export mislukt: ${e.message}`, true);
    }
  }

  async function exportListXlsx() {
    if (!window.ExcelJS) { toast('Excel-export niet beschikbaar.', true); return; }
    const items = visible();
    try {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'AquaTech Service';
      wb.created = new Date();
      const ws = wb.addWorksheet('Werkorders', { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = [
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
      for (const x of items) {
        ws.addRow({
          number: x.number, quote: x.quoteNumber, title: x.title, customer: x.customer, address: x.address, date: asDate(x.plannedDate),
          time: x.startTime, assignee: x.assignee ? x.assignee.displayName : '', status: W.STATUSES[x.status] || x.status,
          done: x.progress.done, steps: x.progress.steps, hours: x.progress.hours, actual: x.progress.actualHours, updatedAt: new Date(x.updatedAt),
        });
      }
      headStyle(ws.getRow(1));
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
      download(new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_TYPE }), `werkorders_${today()}.xlsx`);
      toast(`${items.length} werkorders geëxporteerd`);
    } catch (e) {
      toast(`Export mislukt: ${e.message}`, true);
    }
  }

  // ---------- Navigatie ----------
  function showList() {
    state.wo = null;
    state.warnings = [];
    document.title = 'Werkorders – AquaTech Service';
    $('#edit-view').hidden = true;
    $('#list-view').hidden = false;
    loadList();
  }

  async function route() {
    const ps = params();
    if (state.wo && state.dirty) await save();
    if (ps.get('quote')) return createFromQuote(ps.get('quote'));
    if (ps.get('id')) return loadWorkOrder(ps.get('id'));
    showList();
  }

  async function init() {
    state.me = await window.AquatechAccount.load('../');
    const rights = state.me.rights || [];
    state.admin = rights.includes('beheer');
    if (!state.me.user || !rights.includes('werkorders')) {
      $('#l-new').hidden = true;
      $('#l-export').hidden = true;
      $('#l-table').innerHTML = state.me.user && state.me.user.kind !== 'gast'
        ? '<tr><td class="empty">Werkorders zijn alleen voor beheerders en installateurs. <a href="../">Terug naar het overzicht</a></td></tr>'
        : '<tr><td class="empty">Log eerst in om werkorders te bekijken. <a href="../login">Inloggen</a></td></tr>';
      return;
    }
    try {
      const out = await api('quote-profile');
      state.profile = out.profile;
      state.mail = Boolean(out.mail);
    } catch (e) { state.profile = { companyName: 'AquaTech Service' }; }
    try { state.staff = (await api('workorder-staff')).items || []; } catch (e) { state.staff = []; }
    $('#l-status').innerHTML = '<option value="">Openstaand</option>' + Object.entries(W.STATUSES)
      .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    $('#e-status').innerHTML = Object.entries(W.STATUSES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    let t;
    $('#l-search').oninput = () => { clearTimeout(t); t = setTimeout(renderList, 150); };
    $('#l-status').onchange = renderList;
    $('#l-mine').onchange = renderList;
    $('#l-done').onchange = renderList;
    $('#l-new').onclick = pickQuote;
    $('#l-export').onclick = exportListXlsx;
    document.querySelectorAll('.modal').forEach((m) => {
      m.onclick = (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; };
    });
    bindEditor();
    bindApptSend();
    window.addEventListener('popstate', route);
    route();
  }

  init();
})();
