// Planning: weekagenda van de werkorders, per uitvoerder (rijen) en per dag
// (kolommen). Slepen naar een dag en uitvoerder plant een werkorder in of
// verplaatst hem (POST /api/workorders/:id/schedule); op een aanraakscherm
// eerst tikken op een werkorder uit "In te plannen" en dan op de dag. Een
// klus van meer werkdagen staat op elke dag. De stand van de afspraak met de
// klant (klantlink) is als gekleurde stip te zien. Alleen voor beheerders en
// installateurs (recht 'werkorders').
(function () {
  const W = window.WorkOrderCore;
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = (iso, opts) => new Date(`${iso}T12:00:00`).toLocaleDateString('nl-NL', opts);
  const pad = (n) => String(n).padStart(2, '0');
  const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => localIso(new Date());
  const weekday = (iso) => new Date(`${iso}T12:00:00`).getDay();
  const monday = (iso) => W.addDays(iso, -((weekday(iso) + 6) % 7));
  // ISO-weeknummer (de week van de donderdag).
  function weekNo(iso) {
    const thu = new Date(`${W.addDays(monday(iso), 3)}T12:00:00`);
    const jan1 = new Date(thu.getFullYear(), 0, 1, 12);
    return 1 + Math.floor((thu - jan1) / 864e5 / 7);
  }
  const FINISHED = ['gereed', 'geannuleerd'];
  const NOBODY = '';

  const state = { me: null, staff: [], items: [], week: monday(today()), weekend: false, mine: false, picked: null, dragging: null };

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast'; }, 4000);
  }

  async function api(url, { method = 'GET', body } = {}) {
    const res = await fetch(`../api/${url}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || `HTTP ${res.status}`);
    return out;
  }

  const days = () => Array.from({ length: state.weekend ? 7 : 5 }, (_, i) => W.addDays(state.week, i));
  const workDaysOf = (w) => W.workDays(w.plannedDate, w.days);

  function rows() {
    const list = state.staff.map((u) => ({ id: u.id, name: u.displayName, role: u.role }));
    // Uitvoerders die niet (meer) in de lijst staan, maar wel werk hebben.
    for (const w of state.items) {
      if (w.assignee && !list.some((r) => r.id === w.assigneeId)) list.push({ id: w.assigneeId, name: w.assignee.displayName, gone: true });
    }
    list.push({ id: NOBODY, name: 'Niet toegewezen' });
    return state.mine ? list.filter((r) => r.id === state.me.user.id) : list;
  }

  function itemsOn(date, who) {
    return state.items
      .filter((w) => w.plannedDate && w.status !== 'geannuleerd' && (w.assigneeId || NOBODY) === who && workDaysOf(w).includes(date))
      .sort((a, b) => (a.startTime || '99').localeCompare(b.startTime || '99') || a.number.localeCompare(b.number));
  }

  const place = (w) => {
    const a = String(w.address || '').split(',').map((x) => x.trim()).filter(Boolean);
    return a.length > 1 ? a[a.length - 1] : a[0] || '';
  };

  function card(w, date) {
    const ds = workDaysOf(w);
    const n = date ? ds.indexOf(date) + 1 : 0;
    const time = w.startTime ? `${w.startTime}${w.endTime ? `–${w.endTime}` : ''}` : '';
    const appt = w.appointment || { state: 'geen' };
    const label = W.APPOINTMENT[appt.state] || '';
    return `<a class="p-card st-${esc(w.status)}${state.picked === w.id ? ' picked' : ''}" draggable="true" data-id="${esc(w.id)}" href="../werkorders/?id=${encodeURIComponent(w.id)}"
      title="${esc(`${w.number} · ${w.title}\n${W.STATUSES[w.status] || w.status} · ${label}${appt.response && appt.response.reason && appt.state === 'ander_moment' ? `\n“${appt.response.reason}”` : ''}`)}">
      <span class="sub"><span class="dot appt-${esc(appt.state)}"></span>${time ? `<span class="t">${esc(time)}</span> · ` : ''}${esc(w.number)}${ds.length > 1 && n ? ` · dag ${n}/${ds.length}` : ''}</span>
      <b>${esc(w.customer || w.title || 'Werkorder')}</b>
      ${place(w) ? `<span class="sub">${esc(place(w))}</span>` : ''}
    </a>`;
  }

  function render() {
    const ds = days();
    const t = today();
    $('#p-week').textContent = `Week ${weekNo(state.week)} · ${day(ds[0], { day: 'numeric', month: 'short' })} – ${day(ds[ds.length - 1], { day: 'numeric', month: 'short', year: 'numeric' })}`;
    $('#p-date').value = state.week;
    const head = `<thead><tr><th class="who">Uitvoerder</th>${ds.map((d) => `<th class="${d === t ? 'today' : ''}">${esc(day(d, { weekday: 'long' }))}<span class="d">${esc(day(d, { day: 'numeric', month: 'long' }))}</span></th>`).join('')}</tr></thead>`;
    const body = rows().map((r) => `<tr><td class="who">${esc(r.name)}${r.gone ? '<span class="sub">uitgeschakeld</span>' : r.role ? `<span class="sub">${esc(r.role)}</span>` : ''}</td>
      ${ds.map((d) => `<td class="cell p-drop${d === t ? ' today' : ''}" data-date="${d}" data-who="${esc(r.id)}">${itemsOn(d, r.id).map((w) => card(w, d)).join('')}</td>`).join('')}</tr>`).join('');
    $('#p-grid').innerHTML = `${head}<tbody>${body}</tbody>`;

    const unplanned = state.items.filter((w) => !w.plannedDate && !FINISHED.includes(w.status) && (!state.mine || w.assigneeId === state.me.user.id));
    $('#p-unplanned').innerHTML = unplanned.map((w) => card(w, null)).join('') || '<p class="muted small">Alles is ingepland.</p>';

    const attention = state.items.filter((w) => w.appointment && w.appointment.state === 'ander_moment' && !FINISHED.includes(w.status));
    $('#p-attention').hidden = !attention.length;
    $('#p-attention').className = 'p-panel attention';
    $('#p-attention').innerHTML = attention.length ? `<h3>Klant vraagt ander moment</h3>
      ${attention.map((w) => `${card(w, null)}${w.appointment.response.reason ? `<p class="reason">“${esc(w.appointment.response.reason)}”</p>` : ''}`).join('')}` : '';

    const inWeek = state.items.filter((w) => w.plannedDate && w.status !== 'geannuleerd' && workDaysOf(w).some((d) => ds.includes(d)));
    const n = (st) => inWeek.filter((w) => w.appointment && w.appointment.state === st).length;
    $('#p-stats').innerHTML = [
      [inWeek.length, 'werkorders deze week'],
      [n('bevestigd'), 'bevestigd door de klant'],
      [n('wacht'), 'wachten op de klant'],
      [n('niet_gedeeld'), 'nog niet naar de klant'],
      [unplanned.length, 'nog in te plannen'],
    ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
    $('#p-stats').hidden = false;
    renderPick();
  }

  function renderPick() {
    const w = state.items.find((x) => x.id === state.picked);
    document.body.classList.toggle('p-pickmode', Boolean(w));
    $('#p-pick').hidden = !w;
    $('#p-pick').innerHTML = w ? `<b>${esc(w.number)} · ${esc(w.customer || w.title)}</b> gekozen: tik op een dag bij een uitvoerder om hem in te plannen.
      <a href="../werkorders/?id=${encodeURIComponent(w.id)}">Werkorder openen</a> · <a href="#" data-unpick>Annuleren</a>` : '';
  }

  function remember() {
    const q = new URLSearchParams(location.search);
    q.set('week', state.week);
    history.replaceState(null, '', `?${q}`);
  }

  function goWeek(iso) {
    state.week = monday(iso);
    remember();
    render();
  }

  // Inplannen of verplaatsen (date '' = terug naar In te plannen).
  async function move(id, date, who) {
    const w = state.items.find((x) => x.id === id);
    if (!w) return;
    const sameDay = w.plannedDate === date;
    if (sameDay && (w.assigneeId || NOBODY) === who) return;
    if (!sameDay && w.appointment && w.appointment.state === 'bevestigd'
      && !confirm(`De klant heeft ${w.number} bevestigd voor ${day(w.plannedDate, { weekday: 'long', day: 'numeric', month: 'long' })}. Toch verplaatsen? De klant moet het nieuwe moment dan opnieuw bevestigen.`)) return;
    const body = date ? { plannedDate: date, assigneeId: who || null } : { plannedDate: '' };
    try {
      const out = await api(`workorders/${encodeURIComponent(id)}/schedule`, { method: 'POST', body });
      delete out.data;
      state.items = state.items.map((x) => (x.id === id ? out : x));
      state.picked = null;
      render();
      if (!date) toast(`${out.number} staat weer bij In te plannen`);
      else {
        const shared = out.appointment && out.appointment.state === 'wacht';
        toast(`${out.number} ingepland op ${day(date, { weekday: 'long', day: 'numeric', month: 'long' })}${out.assignee ? ` voor ${out.assignee.displayName}` : ''}${shared && !sameDay ? '. Stuur de klant de nieuwe afspraak vanuit de werkorder.' : ''}`);
      }
    } catch (e) {
      toast(`Inplannen mislukt: ${e.message}`, true);
    }
  }

  function bind() {
    const root = $('.p-layout');
    root.addEventListener('dragstart', (e) => {
      const c = e.target.closest('.p-card');
      if (!c) return;
      state.dragging = c.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', c.dataset.id);
      c.classList.add('dragging');
    });
    root.addEventListener('dragend', (e) => {
      const c = e.target.closest('.p-card');
      if (c) c.classList.remove('dragging');
      state.dragging = null;
      root.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
    });
    root.addEventListener('dragover', (e) => {
      const drop = e.target.closest('.p-drop');
      if (!drop || !state.dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      root.querySelectorAll('.over').forEach((x) => { if (x !== drop) x.classList.remove('over'); });
      drop.classList.add('over');
    });
    root.addEventListener('drop', (e) => {
      const drop = e.target.closest('.p-drop');
      if (!drop) return;
      e.preventDefault();
      drop.classList.remove('over');
      const id = e.dataTransfer.getData('text/plain') || state.dragging;
      if (id) move(id, drop.dataset.date || '', drop.dataset.who || NOBODY);
    });
    root.addEventListener('click', (e) => {
      const c = e.target.closest('.p-card');
      // Werkorder zonder datum: tikken = kiezen (daarna op een dag tikken).
      if (c && c.closest('#p-unplanned')) {
        e.preventDefault();
        state.picked = state.picked === c.dataset.id ? null : c.dataset.id;
        render();
        return;
      }
      if (c) return;
      const cell = e.target.closest('td.cell');
      if (cell && state.picked) move(state.picked, cell.dataset.date, cell.dataset.who || NOBODY);
    });
    $('#p-pick').addEventListener('click', (e) => {
      if (!e.target.closest('[data-unpick]')) return;
      e.preventDefault();
      state.picked = null;
      render();
    });
    $('#p-prev').onclick = () => goWeek(W.addDays(state.week, -7));
    $('#p-next').onclick = () => goWeek(W.addDays(state.week, 7));
    $('#p-today').onclick = () => goWeek(today());
    $('#p-date').onchange = (e) => { if (W.isDate(e.target.value)) goWeek(e.target.value); };
    $('#p-weekend').onchange = (e) => { state.weekend = e.target.checked; render(); };
    $('#p-mine').onchange = (e) => { state.mine = e.target.checked; render(); };
    $('#p-export').onclick = exportWeek;
  }

  // ---------- Excel: de planning van de week ----------
  async function exportWeek() {
    if (!window.ExcelJS) { toast('Excel-export niet beschikbaar.', true); return; }
    const ds = days();
    try {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'AquaTech Service';
      wb.created = new Date();
      const ws = wb.addWorksheet(`Week ${weekNo(state.week)}`, { views: [{ state: 'frozen', ySplit: 1 }], pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      ws.columns = [
        { header: 'Datum', key: 'date', width: 12, style: { numFmt: 'ddd dd-mm-yyyy' } },
        { header: 'Tijd', key: 'time', width: 13 },
        { header: 'Uitvoerder', key: 'who', width: 22 },
        { header: 'Ploeg', key: 'crew', width: 22 },
        { header: 'Werkorder', key: 'number', width: 15 },
        { header: 'Dag', key: 'n', width: 7 },
        { header: 'Klant', key: 'customer', width: 26 },
        { header: 'Adres', key: 'address', width: 36 },
        { header: 'Omschrijving', key: 'title', width: 32 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Afspraak', key: 'appt', width: 24 },
      ];
      let count = 0;
      for (const d of ds) {
        for (const r of rows()) {
          for (const w of itemsOn(d, r.id)) {
            const all = workDaysOf(w);
            ws.addRow({
              date: new Date(`${d}T12:00:00`), time: w.startTime ? `${w.startTime}${w.endTime ? `–${w.endTime}` : ''}` : '', who: w.assignee ? w.assignee.displayName : '',
              crew: w.crew || '', number: w.number, n: all.length > 1 ? `${all.indexOf(d) + 1}/${all.length}` : '', customer: w.customer, address: w.address, title: w.title,
              status: W.STATUSES[w.status] || w.status, appt: W.APPOINTMENT[(w.appointment || {}).state] || '',
            });
            count++;
          }
        }
      }
      const head = ws.getRow(1);
      head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
      const blob = new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `planning_week${weekNo(state.week)}_${state.week}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(`${count} regels geëxporteerd`);
    } catch (e) {
      toast(`Export mislukt: ${e.message}`, true);
    }
  }

  async function init() {
    state.me = await window.AquatechAccount.load('../');
    const rights = state.me.rights || [];
    if (!state.me.user || !rights.includes('werkorders')) {
      $('.p-layout').innerHTML = state.me.user && state.me.user.kind !== 'gast'
        ? '<p class="notice">De planning is alleen voor beheerders en installateurs. <a href="../">Terug naar het overzicht</a></p>'
        : '<p class="notice">Log eerst in om de planning te bekijken. <a href="../login">Inloggen</a></p>';
      $('.p-toolbar').hidden = true;
      return;
    }
    const week = new URLSearchParams(location.search).get('week');
    if (W.isDate(week)) state.week = monday(week);
    bind();
    try {
      const [wos, staff] = await Promise.all([api('workorders'), api('workorder-staff')]);
      state.items = wos.items || [];
      state.staff = staff.items || [];
    } catch (e) {
      $('#p-grid').innerHTML = `<tr><td class="empty">Kan de planning niet laden (${esc(e.message)}).</td></tr>`;
      return;
    }
    render();
  }

  init();
})();
