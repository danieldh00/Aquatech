// Planning: agenda van de werkorders in drie weergaven.
// - Dag: tijd verticaal, de uitvoerders als kolommen naast elkaar.
// - Werkweek: tijd verticaal, de dagen als kolommen (kleur = uitvoerder).
// - Maand: maandrooster; een dag aantikken opent die dag.
// Slepen naar een tijdstip of dag plant een werkorder in of verplaatst hem
// (POST /api/workorders/:id/schedule); op een aanraakscherm eerst tikken op een
// werkorder uit "In te plannen" en dan op het tijdstip. Een klus van meer
// werkdagen staat op elke werkdag. De stand van de afspraak met de klant
// (klantlink) is als gekleurde stip te zien. Alleen voor beheerders en
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
  const isWeekend = (iso) => weekday(iso) === 0 || weekday(iso) === 6;
  const monday = (iso) => W.addDays(iso, -((weekday(iso) + 6) % 7));
  // ISO-weeknummer (de week van de donderdag).
  function weekNo(iso) {
    const thu = new Date(`${W.addDays(monday(iso), 3)}T12:00:00`);
    const jan1 = new Date(thu.getFullYear(), 0, 1, 12);
    return 1 + Math.floor((thu - jan1) / 864e5 / 7);
  }
  const toMin = (t) => (W.isTime(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);
  const toTime = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const FINISHED = ['gereed', 'geannuleerd'];
  const NOBODY = '';
  const VIEWS = ['dag', 'week', 'maand'];
  const COLORS = ['#2cb0c0', '#7e57c2', '#ef6c00', '#1e88e5', '#c2185b', '#19924f', '#6d4c41', '#00897b', '#5c6bc0', '#f9a825'];
  const HOUR = 56; // pixels per uur in het tijdrooster
  const SNAP = 15; // minuten
  const DEFAULT_LEN = 120; // zonder eindtijd: zo lang tekenen (minuten)
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* geen opslag */ } },
  };

  const state = {
    me: null, staff: [], items: [], view: 'week', date: today(), who: '*', weekend: false,
    picked: null, dragging: null, grabY: 0, range: { start: 7 * 60, end: 18 * 60 },
  };

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

  // ---------- Gegevens ----------
  const workDaysOf = (w) => W.workDays(w.plannedDate, w.days);

  // Uitvoerders (met vaste kleur), plus wie niet meer in de lijst staat maar
  // wel werk heeft, en "Niet toegewezen".
  function people() {
    const list = state.staff.map((u) => ({ id: u.id, name: u.displayName, role: u.role }));
    for (const w of state.items) {
      if (w.assignee && !list.some((r) => r.id === w.assigneeId)) list.push({ id: w.assigneeId, name: w.assignee.displayName, gone: true });
    }
    list.forEach((r, i) => { r.color = COLORS[i % COLORS.length]; });
    list.push({ id: NOBODY, name: 'Niet toegewezen', color: '#90a4ae' });
    return list;
  }
  const colorOf = (id) => (people().find((p) => p.id === (id || NOBODY)) || {}).color || '#90a4ae';
  const whoMatches = (w) => state.who === '*' || (w.assigneeId || NOBODY) === state.who;

  function itemsOn(date, who) {
    return state.items
      .filter((w) => w.plannedDate && w.status !== 'geannuleerd' && workDaysOf(w).includes(date))
      .filter((w) => (who === undefined ? whoMatches(w) : (w.assigneeId || NOBODY) === who))
      .sort((a, b) => (a.startTime || '99').localeCompare(b.startTime || '99') || a.number.localeCompare(b.number));
  }

  // De dagen in beeld.
  function visibleDays() {
    if (state.view === 'dag') return [state.date];
    if (state.view === 'week') return Array.from({ length: state.weekend ? 7 : 5 }, (_, i) => W.addDays(monday(state.date), i));
    const first = `${state.date.slice(0, 8)}01`;
    const out = [];
    for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = W.addDays(d, 1)) out.push(d);
    return out;
  }

  const place = (w) => {
    const a = String(w.address || '').split(',').map((x) => x.trim()).filter(Boolean);
    return a.length > 1 ? a[a.length - 1] : a[0] || '';
  };
  const timeText = (w) => (w.startTime ? `${w.startTime}${w.endTime ? `–${w.endTime}` : ''}` : '');
  // Geplande uren (werkstappen, uit de arbeid van de offerte).
  const hoursOf = (w) => (w.progress && w.progress.hours) || 0;
  const hoursText = (w) => (hoursOf(w) ? `${String(Math.round(hoursOf(w) * 100) / 100).replace('.', ',')} u` : '');
  // Lengte van een blok zonder eindtijd: de uren per dag, anders 2 uur.
  const lengthOf = (w, s) => {
    const e = toMin(w.endTime);
    if (e > s) return e - s;
    const fit = W.fitHours(w.startTime, hoursOf(w));
    return fit ? toMin(fit.endTime) - s : DEFAULT_LEN;
  };

  function card(w, { date = null, style = '', compact = false, cls = '' } = {}) {
    const ds = workDaysOf(w);
    const n = date ? ds.indexOf(date) + 1 : 0;
    const appt = w.appointment || { state: 'geen' };
    const label = W.APPOINTMENT[appt.state] || '';
    const title = `${w.number} · ${w.title}${w.summary ? `\n${w.summary}` : ''}\n${w.customer || ''}${w.address ? `, ${w.address}` : ''}\n${timeText(w) ? `${timeText(w)} uur · ` : ''}${hoursText(w) ? `${hoursText(w)} gepland · ` : ''}${w.assignee ? w.assignee.displayName : 'Niet toegewezen'}\n${W.STATUSES[w.status] || w.status} · ${label}${appt.response && appt.response.reason && appt.state === 'ander_moment' ? `\n“${appt.response.reason}”` : ''}`;
    const head = `<span class="dot appt-${esc(appt.state)}"></span>`;
    const inner = compact
      ? `${head}${w.startTime ? `<span class="t ct">${esc(w.startTime)}</span> ` : ''}${esc(w.customer || w.title || w.number)}`
      : `<span class="sub">${head}${timeText(w) ? `<span class="t">${esc(timeText(w))}</span> · ` : ''}${esc(w.number)}${ds.length > 1 && n ? ` · dag ${n}/${ds.length}` : ''}${hoursText(w) ? ` · ${hoursText(w)}` : ''}</span>
        <b>${esc(w.customer || w.title || 'Werkorder')}</b>
        ${w.summary ? `<span class="desc">${esc(w.summary)}</span>` : ''}
        ${place(w) ? `<span class="sub">${esc(place(w))}${state.view !== 'dag' && w.assignee ? ` · ${esc(w.assignee.displayName)}` : ''}</span>` : ''}`;
    return `<a class="p-card st-${esc(w.status)}${state.picked === w.id ? ' picked' : ''}${cls ? ` ${cls}` : ''}" draggable="true" data-id="${esc(w.id)}"
      href="../werkorders/?id=${encodeURIComponent(w.id)}" title="${esc(title)}" style="--who:${colorOf(w.assigneeId)};${style}">${inner}</a>`;
  }

  // ---------- Tijdrooster ----------
  // Uren in beeld: standaard 07–18 uur, ruimer als er werk buiten valt.
  function timeRange(items) {
    let start = 7 * 60, end = 18 * 60;
    for (const w of items) {
      const s = toMin(w.startTime);
      if (s == null) continue;
      const e = s + lengthOf(w, s);
      start = Math.min(start, Math.floor(s / 60) * 60);
      end = Math.max(end, Math.min(24 * 60, Math.ceil(e / 60) * 60));
    }
    return { start, end };
  }

  // Overlappende klussen naast elkaar in een kolom (banen per groep overlap).
  function layout(items) {
    const ev = items.map((w) => {
      const s = toMin(w.startTime);
      return { w, s, e: s + lengthOf(w, s) };
    }).sort((a, b) => a.s - b.s || a.e - b.e);
    let group = [], groupEnd = -1;
    const lanes = [];
    const flush = () => {
      const n = Math.max(1, ...group.map((g) => g.lane + 1));
      group.forEach((g) => { g.lanes = n; });
      group = [];
      lanes.length = 0;
    };
    for (const x of ev) {
      if (x.s >= groupEnd && group.length) flush();
      let lane = lanes.findIndex((end) => end <= x.s);
      if (lane < 0) { lane = lanes.length; lanes.push(x.e); } else lanes[lane] = x.e;
      x.lane = lane;
      group.push(x);
      groupEnd = Math.max(groupEnd, x.e);
    }
    if (group.length) flush();
    return ev;
  }

  // Kolommen: { key, date, who (undefined = uitvoerder ongewijzigd), head }.
  function timeGrid(cols) {
    const all = cols.flatMap((c) => itemsOn(c.date, c.who));
    const r = timeRange(all);
    state.range = r;
    const px = (m) => ((m - r.start) / 60) * HOUR;
    const height = px(r.end);
    const t = today();
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const attrs = (c) => `data-date="${c.date}"${c.who !== undefined ? ` data-who="${esc(c.who)}"` : ''}`;
    const hours = [];
    for (let m = r.start; m < r.end; m += 60) hours.push(`<span style="top:${px(m)}px">${toTime(m)}</span>`);
    let html = `<div class="tg-h tg-corner"></div>${cols.map((c) => `<div class="tg-h${c.date === t && state.view !== 'dag' ? ' today' : ''}">${c.head}</div>`).join('')}`;
    html += `<div class="tg-lbl">Geen tijd</div>${cols.map((c) => `<div class="tg-allday p-drop" ${attrs(c)}>${itemsOn(c.date, c.who).filter((w) => !w.startTime).map((w) => card(w, { date: c.date })).join('')}</div>`).join('')}`;
    html += `<div class="tg-times" style="height:${height}px">${hours.join('')}</div>`;
    html += cols.map((c) => {
      const timed = layout(itemsOn(c.date, c.who).filter((w) => w.startTime));
      const now = c.date === t && nowMin >= r.start && nowMin <= r.end ? `<div class="tg-now" style="top:${px(nowMin)}px"></div>` : '';
      return `<div class="tg-col p-drop slot${c.date === t ? ' today' : ''}" ${attrs(c)} style="height:${height}px;--hour:${HOUR}px;background-position:0 ${-px(r.start) % HOUR}px">${now}${timed.map((x) => card(x.w, {
        date: c.date, cls: toMin(x.w.endTime) > x.s ? '' : 'notime',
        style: `top:${px(x.s) + 1}px;height:${Math.max(26, px(x.e) - px(x.s) - 2)}px;--lane:${x.lane};--lanes:${x.lanes};`,
      })).join('')}</div>`;
    }).join('');
    return `<div class="tg-scroll"><div class="tg" style="--cols:${cols.length}">${html}</div></div>`;
  }

  function renderDay() {
    const ps = people().filter((p) => state.who === '*' || p.id === state.who);
    // "Niet toegewezen" alleen als daar die dag iets staat (of als filter).
    const cols = ps.filter((p) => p.id !== NOBODY || state.who === NOBODY || itemsOn(state.date, NOBODY).length)
      .map((p) => ({ date: state.date, who: p.id, head: `<span class="n"><span class="sw" style="--who:${p.color}"></span>${esc(p.name)}</span><span class="d">${esc(p.gone ? 'uitgeschakeld' : p.role || '')} · ${itemsOn(state.date, p.id).length} klus${itemsOn(state.date, p.id).length === 1 ? '' : 'sen'}</span>` }));
    return timeGrid(cols.length ? cols : [{ date: state.date, who: NOBODY, head: 'Niet toegewezen' }]);
  }

  function renderWeek() {
    return timeGrid(visibleDays().map((d) => ({ date: d, who: undefined, head: `<span class="n">${esc(day(d, { weekday: 'long' }))}</span><span class="d">${esc(day(d, { day: 'numeric', month: 'long' }))} · ${itemsOn(d).length}</span>` })));
  }

  function renderMonth() {
    const ds = visibleDays();
    const start = monday(ds[0]);
    const end = W.addDays(monday(ds[ds.length - 1]), 6);
    const t = today();
    // Op een telefoon: per klus een gekleurde stip (kleur = uitvoerder).
    const small = window.innerWidth < 700;
    const MAX = 4;
    let html = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map((d) => `<div class="mg-h">${d}</div>`).join('');
    for (let d = start; d <= end; d = W.addDays(d, 1)) {
      const items = itemsOn(d);
      const out = d.slice(0, 7) !== state.date.slice(0, 7);
      html += `<div class="mg-day p-drop${out ? ' out' : ''}${isWeekend(d) ? ' wkend' : ''}${d === t ? ' today' : ''}" data-date="${d}" data-day="${d}">
        <span class="num">${Number(d.slice(8))}</span>
        ${small ? `<div class="mdots">${items.map((w) => `<span class="mdot" style="--who:${colorOf(w.assigneeId)}" title="${esc(`${w.startTime ? `${w.startTime} ` : ''}${w.customer || w.number}`)}"></span>`).join('')}</div>`
    : `${items.slice(0, MAX).map((w) => card(w, { date: d, compact: true })).join('')}${items.length > MAX ? `<div class="more">+${items.length - MAX} meer</div>` : ''}`}</div>`;
    }
    return `<div class="mg">${html}</div>`;
  }

  function title() {
    const ds = visibleDays();
    if (state.view === 'dag') return day(state.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (state.view === 'week') return `Week ${weekNo(state.date)} · ${day(ds[0], { day: 'numeric', month: 'short' })} – ${day(ds[ds.length - 1], { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const m = day(state.date, { month: 'long', year: 'numeric' });
    return m.charAt(0).toUpperCase() + m.slice(1);
  }

  function render() {
    const scroller = $('.tg-scroll');
    const keep = scroller ? { x: scroller.scrollLeft, y: scroller.scrollTop, view: state.view } : null;
    document.querySelectorAll('.seg [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
    $('#p-title').textContent = title();
    $('#p-date').value = state.date;
    // (.chk heeft een eigen display, dus niet via hidden)
    $('#p-weekend').closest('label').style.display = state.view === 'maand' ? 'none' : '';
    $('#p-cal').innerHTML = state.view === 'dag' ? renderDay() : state.view === 'week' ? renderWeek() : renderMonth();
    const sc = $('.tg-scroll');
    if (sc) {
      if (keep && keep.view === state.view) { sc.scrollLeft = keep.x; sc.scrollTop = keep.y; }
      else {
        // Begin bij 7 uur (of het eerste werk) in beeld.
        sc.scrollTop = Math.max(0, ((7 * 60 - state.range.start) / 60) * HOUR - 8);
      }
    }

    const unplanned = state.items.filter((w) => !w.plannedDate && !FINISHED.includes(w.status) && whoMatches(w));
    $('#p-unplanned').innerHTML = unplanned.map((w) => card(w)).join('') || '<p class="muted small">Alles is ingepland.</p>';

    const attention = state.items.filter((w) => w.appointment && w.appointment.state === 'ander_moment' && !FINISHED.includes(w.status));
    $('#p-attention').hidden = !attention.length;
    $('#p-attention').innerHTML = attention.length ? `<h3>Klant vraagt ander moment</h3>
      ${attention.map((w) => `${card(w)}${w.appointment.response.reason ? `<p class="reason">“${esc(w.appointment.response.reason)}”</p>` : ''}`).join('')}` : '';

    const ds = visibleDays();
    const inView = state.items.filter((w) => w.plannedDate && w.status !== 'geannuleerd' && whoMatches(w) && workDaysOf(w).some((d) => ds.includes(d)));
    const n = (st) => inView.filter((w) => w.appointment && w.appointment.state === st).length;
    const span = state.view === 'dag' ? 'vandaag in beeld' : state.view === 'week' ? 'deze week' : 'deze maand';
    $('#p-stats').innerHTML = [
      [inView.length, `werkorders ${span}`],
      [n('bevestigd'), 'bevestigd door de klant'],
      [n('wacht'), 'wachten op de klant'],
      [n('niet_gedeeld'), 'nog niet naar de klant'],
      [unplanned.length, 'nog in te plannen'],
    ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
    $('#p-stats').hidden = false;
    renderPick();
    remember();
  }

  function renderPick() {
    const w = state.items.find((x) => x.id === state.picked);
    document.body.classList.toggle('p-pickmode', Boolean(w));
    $('#p-pick').hidden = !w;
    $('#p-pick').innerHTML = w ? `<b>${esc(w.number)} · ${esc(w.customer || w.title)}</b> gekozen: tik op een tijdstip (of in de maand op een dag) om hem in te plannen.
      <a href="../werkorders/?id=${encodeURIComponent(w.id)}">Werkorder openen</a> · <a href="#" data-unpick>Annuleren</a>` : '';
  }

  function remember() {
    const q = new URLSearchParams(location.search);
    q.set('view', state.view);
    q.set('datum', state.date);
    q.delete('week');
    history.replaceState(null, '', `?${q}`);
    store.set('aquatech_planning_view', state.view);
  }

  // ---------- Navigeren ----------
  function shift(dir) {
    if (state.view === 'dag') {
      let d = W.addDays(state.date, dir);
      while (!state.weekend && isWeekend(d)) d = W.addDays(d, dir);
      state.date = d;
    } else if (state.view === 'week') {
      state.date = W.addDays(state.date, 7 * dir);
    } else {
      const dt = new Date(`${state.date.slice(0, 8)}01T12:00:00`);
      dt.setMonth(dt.getMonth() + dir);
      state.date = localIso(dt);
    }
    render();
  }

  function setView(v, date) {
    if (!VIEWS.includes(v)) return;
    state.view = v;
    if (date) state.date = date;
    if (v === 'dag' && !state.weekend && isWeekend(state.date)) state.weekend = true;
    $('#p-weekend').checked = state.weekend;
    render();
  }

  // ---------- Inplannen en verplaatsen ----------
  // Tijdstip in een kolom van het tijdrooster, afgerond op 15 minuten.
  function minuteAt(col, clientY) {
    const y = clientY - col.getBoundingClientRect().top;
    const m = state.range.start + Math.round(((y / HOUR) * 60) / SNAP) * SNAP;
    return Math.max(0, Math.min(24 * 60 - SNAP, m));
  }

  // target: { date ('' = terug naar In te plannen), who (undefined = ongewijzigd), minute (undefined = tijden houden, null = zonder tijd) }
  async function move(id, target) {
    const w = state.items.find((x) => x.id === id);
    if (!w) return;
    const body = {};
    if (!target.date) body.plannedDate = '';
    else {
      body.plannedDate = target.date;
      if (target.who !== undefined) body.assigneeId = target.who || null;
      if (target.minute === null) { body.startTime = ''; body.endTime = ''; }
      else if (target.minute !== undefined) {
        const s = toMin(w.startTime), e = toMin(w.endTime);
        body.startTime = toTime(target.minute);
        if (s != null && e > s) {
          // Al een blok: zelfde lengte op het nieuwe tijdstip.
          body.endTime = toTime(Math.min(24 * 60 - 1, target.minute + (e - s)));
        } else {
          // Nog geen eindtijd: de geplande uren uit de offerte bepalen het blok
          // (meer dan een werkdag = verdeeld over meer werkdagen).
          const fit = W.fitHours(body.startTime, hoursOf(w));
          body.endTime = fit ? fit.endTime : '';
          if (fit) body.days = fit.days;
        }
      }
    }
    const same = body.plannedDate === w.plannedDate && (body.assigneeId === undefined || (body.assigneeId || NOBODY) === (w.assigneeId || NOBODY))
      && (body.startTime === undefined || body.startTime === w.startTime) && (body.endTime === undefined || body.endTime === w.endTime)
      && (body.days === undefined || body.days === w.days);
    if (same) return;
    const momentChanges = body.plannedDate !== w.plannedDate || (body.startTime !== undefined && body.startTime !== w.startTime) || (body.endTime !== undefined && body.endTime !== w.endTime) || (body.days !== undefined && body.days !== w.days);
    if (momentChanges && w.appointment && w.appointment.state === 'bevestigd'
      && !confirm(`De klant heeft ${w.number} bevestigd voor ${day(w.plannedDate, { weekday: 'long', day: 'numeric', month: 'long' })}${w.startTime ? ` om ${w.startTime}` : ''}. Toch verplaatsen? De klant moet het nieuwe moment dan opnieuw bevestigen.`)) return;
    try {
      const out = await api(`workorders/${encodeURIComponent(id)}/schedule`, { method: 'POST', body });
      delete out.data;
      state.items = state.items.map((x) => (x.id === id ? out : x));
      state.picked = null;
      render();
      if (!out.plannedDate) toast(`${out.number} staat weer bij In te plannen`);
      else {
        const waits = out.appointment && out.appointment.state === 'wacht' && momentChanges;
        toast(`${out.number}: ${day(out.plannedDate, { weekday: 'long', day: 'numeric', month: 'long' })}${out.startTime ? ` ${out.startTime}` : ''}${out.assignee ? `, ${out.assignee.displayName}` : ''}${waits ? '. Stuur de klant de nieuwe afspraak vanuit de werkorder.' : ''}`);
      }
    } catch (e) {
      toast(`Inplannen mislukt: ${e.message}`, true);
    }
  }

  function targetOf(el, clientY, grabbed = 0) {
    const drop = el.closest('.p-drop');
    if (!drop) return null;
    const t = { date: drop.dataset.date || '' };
    if (drop.dataset.who !== undefined) t.who = drop.dataset.who;
    if (drop.classList.contains('slot')) t.minute = minuteAt(drop, clientY - grabbed);
    else if (drop.classList.contains('tg-allday')) t.minute = null;
    return t;
  }

  function bind() {
    const root = $('.p-layout');
    root.addEventListener('dragstart', (e) => {
      const c = e.target.closest('.p-card');
      if (!c) return;
      state.dragging = c.dataset.id;
      // Waar de kaart is vastgepakt: de bovenkant valt op het tijdstip.
      state.grabY = c.closest('.tg-col') ? e.clientY - c.getBoundingClientRect().top : 0;
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
      const t = targetOf(e.target, e.clientY, state.grabY);
      if (!t) return;
      e.preventDefault();
      root.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
      const id = e.dataTransfer.getData('text/plain') || state.dragging;
      if (id) move(id, t);
    });
    root.addEventListener('click', (e) => {
      const c = e.target.closest('.p-card');
      // Werkorder zonder datum: tikken = kiezen (daarna op een tijdstip tikken).
      if (c && c.closest('#p-unplanned, #p-attention')) {
        e.preventDefault();
        state.picked = state.picked === c.dataset.id ? null : c.dataset.id;
        render();
        return;
      }
      if (c) return;
      if (state.picked) {
        const t = targetOf(e.target, e.clientY);
        if (t && t.date) move(state.picked, t);
        return;
      }
      // Maand: een dag aantikken opent die dag.
      const d = e.target.closest('.mg-day');
      if (d) setView('dag', d.dataset.day);
    });
    $('#p-pick').addEventListener('click', (e) => {
      if (!e.target.closest('[data-unpick]')) return;
      e.preventDefault();
      state.picked = null;
      render();
    });
    document.querySelectorAll('.seg [data-view]').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
    $('#p-prev').onclick = () => shift(-1);
    $('#p-next').onclick = () => shift(1);
    $('#p-today').onclick = () => { state.date = today(); render(); };
    $('#p-date').onchange = (e) => { if (W.isDate(e.target.value)) { state.date = e.target.value; render(); } };
    $('#p-weekend').onchange = (e) => { state.weekend = e.target.checked; render(); };
    $('#p-who').onchange = (e) => { state.who = e.target.value; store.set('aquatech_planning_who', state.who); render(); };
    $('#p-export').onclick = exportRange;
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (state.view === 'maand') render(); }, 200); });
    // De rode lijn van "nu" schuift mee.
    setInterval(() => { if (!state.dragging && state.view !== 'maand' && visibleDays().includes(today())) render(); }, 5 * 60 * 1000);
  }

  function fillWho() {
    const me = state.me.user.id;
    $('#p-who').innerHTML = '<option value="*">Alle uitvoerders</option>' + people()
      .map((p) => `<option value="${esc(p.id)}">${p.id === me ? 'Mijn klussen' : esc(p.name)}</option>`).join('');
    if (![...$('#p-who').options].some((o) => o.value === state.who)) state.who = '*';
    $('#p-who').value = state.who;
  }

  // ---------- Excel: de planning in beeld ----------
  async function exportRange() {
    if (!window.ExcelJS) { toast('Excel-export niet beschikbaar.', true); return; }
    const ds = visibleDays();
    try {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'AquaTech Service';
      wb.created = new Date();
      const name = state.view === 'dag' ? ds[0] : state.view === 'week' ? `Week ${weekNo(state.date)}` : state.date.slice(0, 7);
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }], pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      ws.columns = [
        { header: 'Datum', key: 'date', width: 14, style: { numFmt: 'ddd dd-mm-yyyy' } },
        { header: 'Van', key: 'from', width: 8 },
        { header: 'Tot', key: 'to', width: 8 },
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
        for (const w of itemsOn(d)) {
          const all = workDaysOf(w);
          ws.addRow({
            date: new Date(`${d}T12:00:00`), from: w.startTime, to: w.endTime, who: w.assignee ? w.assignee.displayName : '',
            crew: w.crew || '', number: w.number, n: all.length > 1 ? `${all.indexOf(d) + 1}/${all.length}` : '', customer: w.customer, address: w.address, title: w.title,
            status: W.STATUSES[w.status] || w.status, appt: W.APPOINTMENT[(w.appointment || {}).state] || '',
          });
          count++;
        }
      }
      const head = ws.getRow(1);
      head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
      const blob = new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `planning_${state.view}_${ds[0]}.xlsx`;
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
    // Weergave: uit de URL, anders de laatst gekozen, anders dag op een telefoon en werkweek op een groot scherm.
    const q = new URLSearchParams(location.search);
    const saved = store.get('aquatech_planning_view');
    state.view = VIEWS.includes(q.get('view')) ? q.get('view') : VIEWS.includes(saved) ? saved : window.innerWidth < 700 ? 'dag' : 'week';
    const date = q.get('datum') || q.get('week');
    if (W.isDate(date)) state.date = date;
    if (state.view === 'dag' && isWeekend(state.date)) state.weekend = true;
    $('#p-weekend').checked = state.weekend;
    state.who = store.get('aquatech_planning_who') || '*';
    bind();
    try {
      const [wos, staff] = await Promise.all([api('workorders'), api('workorder-staff')]);
      state.items = wos.items || [];
      state.staff = staff.items || [];
    } catch (e) {
      $('#p-cal').innerHTML = `<p class="notice">Kan de planning niet laden (${esc(e.message)}).</p>`;
      return;
    }
    fillWho();
    render();
  }

  init();
})();
