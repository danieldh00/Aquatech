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
   * Formatteert een datum met de gegeven opties.
   * @param {string} iso datum als 'jjjj-mm-dd'
   * @param {Intl.DateTimeFormatOptions} options opmaak (bijv. { weekday: 'long' })
   * @returns {string} de datum als tekst
   */
  const day = (iso, options) => new Date(`${iso}T12:00:00`).toLocaleDateString('nl-NL', options);
  /**
   * Vult een getal aan tot twee cijfers.
   * @param {number} number het getal
   * @returns {string} bijv. '07'
   */
  const pad = (number) => String(number).padStart(2, '0');
  /**
   * Geeft een Date als lokale datum.
   * @param {Date} date de datum
   * @returns {string} datum als 'jjjj-mm-dd'
   */
  const localIso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  /**
   * Geeft de datum van vandaag op dit toestel.
   * @returns {string} datum als 'jjjj-mm-dd'
   */
  const today = () => localIso(new Date());
  /**
   * Geeft de dag van de week.
   * @param {string} iso datum als 'jjjj-mm-dd'
   * @returns {number} 0 = zondag … 6 = zaterdag
   */
  const weekday = (iso) => new Date(`${iso}T12:00:00`).getDay();
  /**
   * Zegt of een datum in het weekend valt.
   * @param {string} iso datum als 'jjjj-mm-dd'
   * @returns {boolean} true op zaterdag en zondag
   */
  const isWeekend = (iso) => weekday(iso) === 0 || weekday(iso) === 6;
  /**
   * Geeft de maandag van de week van een datum.
   * @param {string} iso datum als 'jjjj-mm-dd'
   * @returns {string} de maandag als 'jjjj-mm-dd'
   */
  const monday = (iso) => WorkOrderCore.addDays(iso, -((weekday(iso) + 6) % 7));
  /**
   * ISO-weeknummer (de week van de donderdag).
   * @param {string} iso datum als 'jjjj-mm-dd'
   * @returns {number} het weeknummer
   */
  function weekNo(iso) {
    const thursday = new Date(`${WorkOrderCore.addDays(monday(iso), 3)}T12:00:00`);
    const januaryFirst = new Date(thursday.getFullYear(), 0, 1, 12);
    return 1 + Math.floor((thursday - januaryFirst) / 864e5 / 7);
  }
  /**
   * Rekent een tijd om naar minuten na middernacht.
   * @param {string} time tijd als 'uu:mm'
   * @returns {number|null} minuten, of null als het geen geldige tijd is
   */
  const toMin = (time) => (WorkOrderCore.isTime(time) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : null);
  /**
   * Rekent minuten na middernacht om naar een tijd.
   * @param {number} minutes minuten na middernacht
   * @returns {string} tijd als 'uu:mm'
   */
  const toTime = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  const FINISHED = ['gereed', 'geannuleerd'];
  const NOBODY = '';
  const VIEWS = ['dag', 'week', 'maand'];
  const COLORS = ['#2cb0c0', '#7e57c2', '#ef6c00', '#1e88e5', '#c2185b', '#19924f', '#6d4c41', '#00897b', '#5c6bc0', '#f9a825'];
  const HOUR = 56; // pixels per uur in het tijdrooster
  const SNAP = 15; // minuten
  const DEFAULT_LEN = 120; // zonder eindtijd: zo lang tekenen (minuten)
  const store = {
    /**
     * Leest een waarde uit localStorage.
     * @param {string} key sleutel
     * @returns {string|null} de waarde, of null (ook als opslag niet kan)
     */
    get(key) { try { return localStorage.getItem(key); } catch (error) { return null; } },
    /**
     * Schrijft een waarde in localStorage (stil als opslag niet kan).
     * @param {string} key sleutel
     * @param {string} value waarde
     */
    set(key, value) { try { localStorage.setItem(key, value); } catch (error) { /* geen opslag */ } },
  };

  const state = {
    me: null, staff: [], items: [], view: 'week', date: today(), who: '*', weekend: false,
    picked: null, dragging: null, grabY: 0, range: { start: 7 * 60, end: 18 * 60 },
  };

  /**
   * Toont kort een melding onderin het scherm.
   * @param {string} message de tekst
   * @param {boolean} isError true voor een foutmelding (rood)
   */
  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast show${isError ? ' err' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = 'toast'; }, 4000);
  }

  /**
   * Roept de API aan en geeft de JSON terug.
   * @param {string} url pad na '../api/'
   * @param {{method: string, body: object}} request methode en inhoud (standaard GET zonder inhoud)
   * @returns {Promise<object>} het antwoord; gooit een fout bij een foutstatus
   */
  async function api(url, { method = 'GET', body } = {}) {
    const res = await fetch(`../api/${url}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.message || `HTTP ${res.status}`);
    return result;
  }

  // ---------- Gegevens ----------
  /**
   * Geeft de werkdagen waarop een werkorder staat.
   * @param {object} workOrder de werkorder
   * @returns {string[]} datums als 'jjjj-mm-dd'
   */
  const workDaysOf = (workOrder) => WorkOrderCore.workDays(workOrder.plannedDate, workOrder.days);

  /**
   * Uitvoerders (met vaste kleur), plus wie niet meer in de lijst staat maar
   * wel werk heeft, en "Niet toegewezen".
   * @returns {object[]} personen met id, name, color en eventueel role/gone
   */
  function people() {
    const list = state.staff.map((user) => ({ id: user.id, name: user.displayName, role: user.role }));
    for (const workOrder of state.items) {
      if (workOrder.assignee && !list.some((person) => person.id === workOrder.assigneeId)) list.push({ id: workOrder.assigneeId, name: workOrder.assignee.displayName, gone: true });
    }
    list.forEach((person, i) => { person.color = COLORS[i % COLORS.length]; });
    list.push({ id: NOBODY, name: 'Niet toegewezen', color: '#90a4ae' });
    return list;
  }
  /**
   * Geeft de kleur van een uitvoerder.
   * @param {string} id id van de uitvoerder (leeg = niet toegewezen)
   * @returns {string} CSS-kleur
   */
  const colorOf = (id) => (people().find((person) => person.id === (id || NOBODY)) || {}).color || '#90a4ae';
  /**
   * Zegt of een werkorder bij het filter op uitvoerder past.
   * @param {object} workOrder de werkorder
   * @returns {boolean} true als hij getoond wordt
   */
  const whoMatches = (workOrder) => state.who === '*' || (workOrder.assigneeId || NOBODY) === state.who;

  /**
   * Geeft de werkorders op een dag, gesorteerd op begintijd en nummer.
   * @param {string} date datum als 'jjjj-mm-dd'
   * @param {string} who id van de uitvoerder; undefined = het filter bovenaan gebruiken
   * @returns {object[]} de werkorders
   */
  function itemsOn(date, who) {
    return state.items
      .filter((workOrder) => workOrder.plannedDate && workOrder.status !== 'geannuleerd' && workDaysOf(workOrder).includes(date))
      .filter((workOrder) => (who === undefined ? whoMatches(workOrder) : (workOrder.assigneeId || NOBODY) === who))
      .sort((left, right) => (left.startTime || '99').localeCompare(right.startTime || '99') || left.number.localeCompare(right.number));
  }

  /**
   * Geeft de dagen in beeld (dag, werkweek of hele maand).
   * @returns {string[]} datums als 'jjjj-mm-dd'
   */
  function visibleDays() {
    if (state.view === 'dag') return [state.date];
    if (state.view === 'week') return Array.from({ length: state.weekend ? 7 : 5 }, (_, i) => WorkOrderCore.addDays(monday(state.date), i));
    const first = `${state.date.slice(0, 8)}01`;
    const result = [];
    for (let date = first; date.slice(0, 7) === first.slice(0, 7); date = WorkOrderCore.addDays(date, 1)) result.push(date);
    return result;
  }

  /**
   * Geeft de plaats uit het adres (het laatste deel na een komma).
   * @param {object} workOrder de werkorder
   * @returns {string} de plaats, of leeg
   */
  const place = (workOrder) => {
    const parts = String(workOrder.address || '').split(',').map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
  };
  /**
   * Geeft de begin- en eindtijd als tekst.
   * @param {object} workOrder de werkorder
   * @returns {string} bijv. '08:00–12:00', of leeg zonder tijd
   */
  const timeText = (workOrder) => (workOrder.startTime ? `${workOrder.startTime}${workOrder.endTime ? `–${workOrder.endTime}` : ''}` : '');
  /**
   * Geplande uren (werkstappen, uit de arbeid van de offerte).
   * @param {object} workOrder de werkorder
   * @returns {number} aantal uren (0 als onbekend)
   */
  const hoursOf = (workOrder) => (workOrder.progress && workOrder.progress.hours) || 0;
  /**
   * Geeft de geplande uren als tekst.
   * @param {object} workOrder de werkorder
   * @returns {string} bijv. '6,5 u', of leeg
   */
  const hoursText = (workOrder) => (hoursOf(workOrder) ? `${String(Math.round(hoursOf(workOrder) * 100) / 100).replace('.', ',')} u` : '');
  /**
   * Lengte van een blok zonder eindtijd: de uren per dag, anders 2 uur.
   * @param {object} workOrder de werkorder
   * @param {number} start begin in minuten na middernacht
   * @returns {number} lengte in minuten
   */
  const lengthOf = (workOrder, start) => {
    const end = toMin(workOrder.endTime);
    if (end > start) return end - start;
    const fit = WorkOrderCore.fitHours(workOrder.startTime, hoursOf(workOrder));
    return fit ? toMin(fit.endTime) - start : DEFAULT_LEN;
  };

  /**
   * Maakt de kaart van een werkorder in de agenda.
   * @param {object} workOrder de werkorder
   * @param {object} display date (dag van een meerdaagse klus), style, compact (maandweergave) en cls (extra CSS-klasse)
   * @returns {string} HTML van de kaart (link naar de werkorder)
   */
  function card(workOrder, { date = null, style = '', compact = false, cls = '' } = {}) {
    const days = workDaysOf(workOrder);
    const dayNumber = date ? days.indexOf(date) + 1 : 0;
    const appointment = workOrder.appointment || { state: 'geen' };
    const label = WorkOrderCore.APPOINTMENT[appointment.state] || '';
    const title = `${workOrder.number} · ${workOrder.title}${workOrder.summary ? `\n${workOrder.summary}` : ''}\n${workOrder.customer || ''}${workOrder.address ? `, ${workOrder.address}` : ''}\n${timeText(workOrder) ? `${timeText(workOrder)} uur · ` : ''}${hoursText(workOrder) ? `${hoursText(workOrder)} gepland · ` : ''}${workOrder.assignee ? workOrder.assignee.displayName : 'Niet toegewezen'}\n${WorkOrderCore.STATUSES[workOrder.status] || workOrder.status} · ${label}${appointment.response && appointment.response.reason && appointment.state === 'ander_moment' ? `\n“${appointment.response.reason}”` : ''}`;
    const head = `<span class="dot appt-${esc(appointment.state)}"></span>`;
    const inner = compact
      ? `${head}${workOrder.startTime ? `<span class="t ct">${esc(workOrder.startTime)}</span> ` : ''}${esc(workOrder.customer || workOrder.title || workOrder.number)}`
      : `<span class="sub">${head}${timeText(workOrder) ? `<span class="t">${esc(timeText(workOrder))}</span> · ` : ''}${esc(workOrder.number)}${days.length > 1 && dayNumber ? ` · dag ${dayNumber}/${days.length}` : ''}${hoursText(workOrder) ? ` · ${hoursText(workOrder)}` : ''}</span>
        <b>${esc(workOrder.customer || workOrder.title || 'Werkorder')}</b>
        ${workOrder.summary ? `<span class="desc">${esc(workOrder.summary)}</span>` : ''}
        ${place(workOrder) ? `<span class="sub">${esc(place(workOrder))}${state.view !== 'dag' && workOrder.assignee ? ` · ${esc(workOrder.assignee.displayName)}` : ''}</span>` : ''}`;
    return `<a class="p-card st-${esc(workOrder.status)}${state.picked === workOrder.id ? ' picked' : ''}${cls ? ` ${cls}` : ''}" draggable="true" data-id="${esc(workOrder.id)}"
      href="../werkorders/?id=${encodeURIComponent(workOrder.id)}" title="${esc(title)}" style="--who:${colorOf(workOrder.assigneeId)};${style}">${inner}</a>`;
  }

  // ---------- Tijdrooster ----------
  /**
   * Uren in beeld: standaard 07–18 uur, ruimer als er werk buiten valt.
   * @param {object[]} items de werkorders in beeld
   * @returns {{start: number, end: number}} begin en eind in minuten na middernacht
   */
  function timeRange(items) {
    let start = 7 * 60, end = 18 * 60;
    for (const workOrder of items) {
      const itemStart = toMin(workOrder.startTime);
      if (itemStart == null) continue;
      const itemEnd = itemStart + lengthOf(workOrder, itemStart);
      start = Math.min(start, Math.floor(itemStart / 60) * 60);
      end = Math.max(end, Math.min(24 * 60, Math.ceil(itemEnd / 60) * 60));
    }
    return { start, end };
  }

  /**
   * Overlappende klussen naast elkaar in een kolom (banen per groep overlap).
   * @param {object[]} items de werkorders met een begintijd
   * @returns {object[]} per werkorder { workOrder, start, end, lane, lanes }
   */
  function layout(items) {
    const events = items.map((workOrder) => {
      const start = toMin(workOrder.startTime);
      return { workOrder, start, end: start + lengthOf(workOrder, start) };
    }).sort((left, right) => left.start - right.start || left.end - right.end);
    let group = [], groupEnd = -1;
    const lanes = [];
    /** Sluit een groep overlappende klussen af: elke klus krijgt het aantal banen. */
    const closeGroup = () => {
      const laneCount = Math.max(1, ...group.map((event) => event.lane + 1));
      group.forEach((event) => { event.lanes = laneCount; });
      group = [];
      lanes.length = 0;
    };
    for (const event of events) {
      if (event.start >= groupEnd && group.length) closeGroup();
      let lane = lanes.findIndex((laneEnd) => laneEnd <= event.start);
      if (lane < 0) { lane = lanes.length; lanes.push(event.end); } else lanes[lane] = event.end;
      event.lane = lane;
      group.push(event);
      groupEnd = Math.max(groupEnd, event.end);
    }
    if (group.length) closeGroup();
    return events;
  }

  /**
   * Maakt het tijdrooster. Kolommen: { key, date, who (undefined = uitvoerder ongewijzigd), head }.
   * @param {object[]} columns de kolommen
   * @returns {string} HTML van het rooster
   */
  function timeGrid(columns) {
    const allItems = columns.flatMap((column) => itemsOn(column.date, column.who));
    const range = timeRange(allItems);
    state.range = range;
    /**
     * Rekent een tijdstip om naar pixels vanaf de bovenkant van het rooster.
     * @param {number} minutes minuten na middernacht
     * @returns {number} afstand in pixels
     */
    const toPixels = (minutes) => ((minutes - range.start) / 60) * HOUR;
    const height = toPixels(range.end);
    const todayIso = today();
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    /**
     * Geeft de data-attributen van een kolom waarop je kunt neerzetten.
     * @param {object} column de kolom
     * @returns {string} HTML-attributen
     */
    const dropAttributes = (column) => `data-date="${column.date}"${column.who !== undefined ? ` data-who="${esc(column.who)}"` : ''}`;
    const hours = [];
    for (let minutes = range.start; minutes < range.end; minutes += 60) hours.push(`<span style="top:${toPixels(minutes)}px">${toTime(minutes)}</span>`);
    let html = `<div class="tg-h tg-corner"></div>${columns.map((column) => `<div class="tg-h${column.date === todayIso && state.view !== 'dag' ? ' today' : ''}">${column.head}</div>`).join('')}`;
    html += `<div class="tg-lbl">Geen tijd</div>${columns.map((column) => `<div class="tg-allday p-drop" ${dropAttributes(column)}>${itemsOn(column.date, column.who).filter((workOrder) => !workOrder.startTime).map((workOrder) => card(workOrder, { date: column.date })).join('')}</div>`).join('')}`;
    html += `<div class="tg-times" style="height:${height}px">${hours.join('')}</div>`;
    html += columns.map((column) => {
      const timed = layout(itemsOn(column.date, column.who).filter((workOrder) => workOrder.startTime));
      const now = column.date === todayIso && nowMin >= range.start && nowMin <= range.end ? `<div class="tg-now" style="top:${toPixels(nowMin)}px"></div>` : '';
      return `<div class="tg-col p-drop slot${column.date === todayIso ? ' today' : ''}" ${dropAttributes(column)} style="height:${height}px;--hour:${HOUR}px;background-position:0 ${-toPixels(range.start) % HOUR}px">${now}${timed.map((event) => card(event.workOrder, {
        date: column.date, cls: toMin(event.workOrder.endTime) > event.start ? '' : 'notime',
        style: `top:${toPixels(event.start) + 1}px;height:${Math.max(26, toPixels(event.end) - toPixels(event.start) - 2)}px;--lane:${event.lane};--lanes:${event.lanes};`,
      })).join('')}</div>`;
    }).join('');
    return `<div class="tg-scroll"><div class="tg" style="--cols:${columns.length}">${html}</div></div>`;
  }

  /**
   * Tekent de dagweergave: per uitvoerder een kolom.
   * @returns {string} HTML van het rooster
   */
  function renderDay() {
    const shownPeople = people().filter((person) => state.who === '*' || person.id === state.who);
    // "Niet toegewezen" alleen als daar die dag iets staat (of als filter).
    const columns = shownPeople.filter((person) => person.id !== NOBODY || state.who === NOBODY || itemsOn(state.date, NOBODY).length)
      .map((person) => ({ date: state.date, who: person.id, head: `<span class="n"><span class="sw" style="--who:${person.color}"></span>${esc(person.name)}</span><span class="d">${esc(person.gone ? 'uitgeschakeld' : person.role || '')} · ${itemsOn(state.date, person.id).length} klus${itemsOn(state.date, person.id).length === 1 ? '' : 'sen'}</span>` }));
    return timeGrid(columns.length ? columns : [{ date: state.date, who: NOBODY, head: 'Niet toegewezen' }]);
  }

  /**
   * Tekent de werkweek: per dag een kolom.
   * @returns {string} HTML van het rooster
   */
  function renderWeek() {
    return timeGrid(visibleDays().map((date) => ({ date, who: undefined, head: `<span class="n">${esc(day(date, { weekday: 'long' }))}</span><span class="d">${esc(day(date, { day: 'numeric', month: 'long' }))} · ${itemsOn(date).length}</span>` })));
  }

  /**
   * Tekent het maandrooster (op een telefoon met stippen per klus).
   * @returns {string} HTML van het rooster
   */
  function renderMonth() {
    const days = visibleDays();
    const start = monday(days[0]);
    const end = WorkOrderCore.addDays(monday(days[days.length - 1]), 6);
    const todayIso = today();
    // Op een telefoon: per klus een gekleurde stip (kleur = uitvoerder).
    const small = window.innerWidth < 700;
    const MAX = 4;
    let html = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map((label) => `<div class="mg-h">${label}</div>`).join('');
    for (let date = start; date <= end; date = WorkOrderCore.addDays(date, 1)) {
      const items = itemsOn(date);
      const outsideMonth = date.slice(0, 7) !== state.date.slice(0, 7);
      html += `<div class="mg-day p-drop${outsideMonth ? ' out' : ''}${isWeekend(date) ? ' wkend' : ''}${date === todayIso ? ' today' : ''}" data-date="${date}" data-day="${date}">
        <span class="num">${Number(date.slice(8))}</span>
        ${small ? `<div class="mdots">${items.map((workOrder) => `<span class="mdot" style="--who:${colorOf(workOrder.assigneeId)}" title="${esc(`${workOrder.startTime ? `${workOrder.startTime} ` : ''}${workOrder.customer || workOrder.number}`)}"></span>`).join('')}</div>`
    : `${items.slice(0, MAX).map((workOrder) => card(workOrder, { date, compact: true })).join('')}${items.length > MAX ? `<div class="more">+${items.length - MAX} meer</div>` : ''}`}</div>`;
    }
    return `<div class="mg">${html}</div>`;
  }

  /**
   * Geeft de titel boven de agenda (dag, week met nummer of maand).
   * @returns {string} de titel
   */
  function title() {
    const days = visibleDays();
    if (state.view === 'dag') return day(state.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (state.view === 'week') return `Week ${weekNo(state.date)} · ${day(days[0], { day: 'numeric', month: 'short' })} – ${day(days[days.length - 1], { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const monthName = day(state.date, { month: 'long', year: 'numeric' });
    return monthName.charAt(0).toUpperCase() + monthName.slice(1);
  }

  /**
   * Tekent de agenda, "In te plannen", de aandachtspunten en de tellers, en
   * houdt de scrollpositie vast.
   */
  function render() {
    const scroller = $('.tg-scroll');
    const keep = scroller ? { x: scroller.scrollLeft, y: scroller.scrollTop, view: state.view } : null;
    document.querySelectorAll('.seg [data-view]').forEach((button) => button.classList.toggle('on', button.dataset.view === state.view));
    $('#p-title').textContent = title();
    $('#p-date').value = state.date;
    // (.chk heeft een eigen display, dus niet via hidden)
    $('#p-weekend').closest('label').style.display = state.view === 'maand' ? 'none' : '';
    $('#p-cal').innerHTML = state.view === 'dag' ? renderDay() : state.view === 'week' ? renderWeek() : renderMonth();
    const newScroller = $('.tg-scroll');
    if (newScroller) {
      if (keep && keep.view === state.view) { newScroller.scrollLeft = keep.x; newScroller.scrollTop = keep.y; }
      else {
        // Begin bij 7 uur (of het eerste werk) in beeld.
        newScroller.scrollTop = Math.max(0, ((7 * 60 - state.range.start) / 60) * HOUR - 8);
      }
    }

    const unplanned = state.items.filter((workOrder) => !workOrder.plannedDate && !FINISHED.includes(workOrder.status) && whoMatches(workOrder));
    $('#p-unplanned').innerHTML = unplanned.map((workOrder) => card(workOrder)).join('') || '<p class="muted small">Alles is ingepland.</p>';

    const attention = state.items.filter((workOrder) => workOrder.appointment && workOrder.appointment.state === 'ander_moment' && !FINISHED.includes(workOrder.status));
    $('#p-attention').hidden = !attention.length;
    $('#p-attention').innerHTML = attention.length ? `<h3>Klant vraagt ander moment</h3>
      ${attention.map((workOrder) => `${card(workOrder)}${workOrder.appointment.response.reason ? `<p class="reason">“${esc(workOrder.appointment.response.reason)}”</p>` : ''}`).join('')}` : '';

    const days = visibleDays();
    const inView = state.items.filter((workOrder) => workOrder.plannedDate && workOrder.status !== 'geannuleerd' && whoMatches(workOrder) && workDaysOf(workOrder).some((date) => days.includes(date)));
    /**
     * Telt de werkorders in beeld met een bepaalde stand van de afspraak.
     * @param {string} appointmentState bijv. 'bevestigd' of 'wacht'
     * @returns {number} het aantal
     */
    const countWithState = (appointmentState) => inView.filter((workOrder) => workOrder.appointment && workOrder.appointment.state === appointmentState).length;
    const span = state.view === 'dag' ? 'vandaag in beeld' : state.view === 'week' ? 'deze week' : 'deze maand';
    $('#p-stats').innerHTML = [
      [inView.length, `werkorders ${span}`],
      [countWithState('bevestigd'), 'bevestigd door de klant'],
      [countWithState('wacht'), 'wachten op de klant'],
      [countWithState('niet_gedeeld'), 'nog niet naar de klant'],
      [unplanned.length, 'nog in te plannen'],
    ].map(([value, label]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
    $('#p-stats').hidden = false;
    renderPick();
    remember();
  }

  /** Toont de balk van de gekozen werkorder (inplannen met tikken). */
  function renderPick() {
    const workOrder = state.items.find((item) => item.id === state.picked);
    document.body.classList.toggle('p-pickmode', Boolean(workOrder));
    $('#p-pick').hidden = !workOrder;
    $('#p-pick').innerHTML = workOrder ? `<b>${esc(workOrder.number)} · ${esc(workOrder.customer || workOrder.title)}</b> gekozen: tik op een tijdstip (of in de maand op een dag) om hem in te plannen.
      <a href="../werkorders/?id=${encodeURIComponent(workOrder.id)}">Werkorder openen</a> · <a href="#" data-unpick>Annuleren</a>` : '';
  }

  /** Zet weergave en datum in de URL en onthoudt de weergave. */
  function remember() {
    const query = new URLSearchParams(location.search);
    query.set('view', state.view);
    query.set('datum', state.date);
    query.delete('week');
    history.replaceState(null, '', `?${query}`);
    store.set('aquatech_planning_view', state.view);
  }

  // ---------- Navigeren ----------
  /**
   * Gaat een dag, week of maand verder of terug.
   * @param {number} direction 1 = verder, -1 = terug
   */
  function shift(direction) {
    if (state.view === 'dag') {
      let date = WorkOrderCore.addDays(state.date, direction);
      while (!state.weekend && isWeekend(date)) date = WorkOrderCore.addDays(date, direction);
      state.date = date;
    } else if (state.view === 'week') {
      state.date = WorkOrderCore.addDays(state.date, 7 * direction);
    } else {
      const monthStart = new Date(`${state.date.slice(0, 8)}01T12:00:00`);
      monthStart.setMonth(monthStart.getMonth() + direction);
      state.date = localIso(monthStart);
    }
    render();
  }

  /**
   * Kiest een weergave, eventueel op een datum.
   * @param {string} view 'dag', 'week' of 'maand'
   * @param {string} date datum als 'jjjj-mm-dd' (optioneel)
   */
  function setView(view, date) {
    if (!VIEWS.includes(view)) return;
    state.view = view;
    if (date) state.date = date;
    if (view === 'dag' && !state.weekend && isWeekend(state.date)) state.weekend = true;
    $('#p-weekend').checked = state.weekend;
    render();
  }

  // ---------- Inplannen en verplaatsen ----------
  /**
   * Tijdstip in een kolom van het tijdrooster, afgerond op 15 minuten.
   * @param {Element} column de kolom
   * @param {number} clientY verticale positie van de muis of vinger
   * @returns {number} minuten na middernacht
   */
  function minuteAt(column, clientY) {
    const offset = clientY - column.getBoundingClientRect().top;
    const minute = state.range.start + Math.round(((offset / HOUR) * 60) / SNAP) * SNAP;
    return Math.max(0, Math.min(24 * 60 - SNAP, minute));
  }

  /**
   * Plant een werkorder in of verplaatst hem (na bevestiging als de klant het
   * moment al had bevestigd).
   * @param {string} id id van de werkorder
   * @param {object} target { date ('' = terug naar In te plannen), who (undefined = ongewijzigd), minute (undefined = tijden houden, null = zonder tijd) }
   * @returns {Promise<void>}
   */
  async function move(id, target) {
    const workOrder = state.items.find((item) => item.id === id);
    if (!workOrder) return;
    const body = {};
    if (!target.date) body.plannedDate = '';
    else {
      body.plannedDate = target.date;
      if (target.who !== undefined) body.assigneeId = target.who || null;
      if (target.minute === null) { body.startTime = ''; body.endTime = ''; }
      else if (target.minute !== undefined) {
        const start = toMin(workOrder.startTime), end = toMin(workOrder.endTime);
        body.startTime = toTime(target.minute);
        if (start != null && end > start) {
          // Al een blok: zelfde lengte op het nieuwe tijdstip.
          body.endTime = toTime(Math.min(24 * 60 - 1, target.minute + (end - start)));
        } else {
          // Nog geen eindtijd: de geplande uren uit de offerte bepalen het blok
          // (meer dan een werkdag = verdeeld over meer werkdagen).
          const fit = WorkOrderCore.fitHours(body.startTime, hoursOf(workOrder));
          body.endTime = fit ? fit.endTime : '';
          if (fit) body.days = fit.days;
        }
      }
    }
    const same = body.plannedDate === workOrder.plannedDate && (body.assigneeId === undefined || (body.assigneeId || NOBODY) === (workOrder.assigneeId || NOBODY))
      && (body.startTime === undefined || body.startTime === workOrder.startTime) && (body.endTime === undefined || body.endTime === workOrder.endTime)
      && (body.days === undefined || body.days === workOrder.days);
    if (same) return;
    const momentChanges = body.plannedDate !== workOrder.plannedDate || (body.startTime !== undefined && body.startTime !== workOrder.startTime) || (body.endTime !== undefined && body.endTime !== workOrder.endTime) || (body.days !== undefined && body.days !== workOrder.days);
    if (momentChanges && workOrder.appointment && workOrder.appointment.state === 'bevestigd'
      && !confirm(`De klant heeft ${workOrder.number} bevestigd voor ${day(workOrder.plannedDate, { weekday: 'long', day: 'numeric', month: 'long' })}${workOrder.startTime ? ` om ${workOrder.startTime}` : ''}. Toch verplaatsen? De klant moet het nieuwe moment dan opnieuw bevestigen.`)) return;
    try {
      const updated = await api(`workorders/${encodeURIComponent(id)}/schedule`, { method: 'POST', body });
      delete updated.data;
      state.items = state.items.map((item) => (item.id === id ? updated : item));
      state.picked = null;
      render();
      if (!updated.plannedDate) toast(`${updated.number} staat weer bij In te plannen`);
      else {
        const waits = updated.appointment && updated.appointment.state === 'wacht' && momentChanges;
        toast(`${updated.number}: ${day(updated.plannedDate, { weekday: 'long', day: 'numeric', month: 'long' })}${updated.startTime ? ` ${updated.startTime}` : ''}${updated.assignee ? `, ${updated.assignee.displayName}` : ''}${waits ? '. Stuur de klant de nieuwe afspraak vanuit de werkorder.' : ''}`);
      }
    } catch (error) {
      toast(`Inplannen mislukt: ${error.message}`, true);
    }
  }

  /**
   * Bepaalt waar een werkorder wordt neergezet: dag, uitvoerder en tijdstip.
   * @param {Element} element waar is losgelaten of getikt
   * @param {number} clientY verticale positie van de muis of vinger
   * @param {number} grabbed waar de kaart is vastgepakt (pixels vanaf de bovenkant)
   * @returns {object|null} het doel voor move(), of null buiten de agenda
   */
  function targetOf(element, clientY, grabbed = 0) {
    const drop = element.closest('.p-drop');
    if (!drop) return null;
    const target = { date: drop.dataset.date || '' };
    if (drop.dataset.who !== undefined) target.who = drop.dataset.who;
    if (drop.classList.contains('slot')) target.minute = minuteAt(drop, clientY - grabbed);
    else if (drop.classList.contains('tg-allday')) target.minute = null;
    return target;
  }

  /** Koppelt slepen, tikken, navigeren, filters en export aan de pagina. */
  function bind() {
    const root = $('.p-layout');
    root.addEventListener('dragstart', (event) => {
      const cardElement = event.target.closest('.p-card');
      if (!cardElement) return;
      state.dragging = cardElement.dataset.id;
      // Waar de kaart is vastgepakt: de bovenkant valt op het tijdstip.
      state.grabY = cardElement.closest('.tg-col') ? event.clientY - cardElement.getBoundingClientRect().top : 0;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', cardElement.dataset.id);
      cardElement.classList.add('dragging');
    });
    root.addEventListener('dragend', (event) => {
      const cardElement = event.target.closest('.p-card');
      if (cardElement) cardElement.classList.remove('dragging');
      state.dragging = null;
      root.querySelectorAll('.over').forEach((element) => element.classList.remove('over'));
    });
    root.addEventListener('dragover', (event) => {
      const drop = event.target.closest('.p-drop');
      if (!drop || !state.dragging) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      root.querySelectorAll('.over').forEach((element) => { if (element !== drop) element.classList.remove('over'); });
      drop.classList.add('over');
    });
    root.addEventListener('drop', (event) => {
      const target = targetOf(event.target, event.clientY, state.grabY);
      if (!target) return;
      event.preventDefault();
      root.querySelectorAll('.over').forEach((element) => element.classList.remove('over'));
      const id = event.dataTransfer.getData('text/plain') || state.dragging;
      if (id) move(id, target);
    });
    root.addEventListener('click', (event) => {
      const cardElement = event.target.closest('.p-card');
      // Werkorder zonder datum: tikken = kiezen (daarna op een tijdstip tikken).
      if (cardElement && cardElement.closest('#p-unplanned, #p-attention')) {
        event.preventDefault();
        state.picked = state.picked === cardElement.dataset.id ? null : cardElement.dataset.id;
        render();
        return;
      }
      if (cardElement) return;
      if (state.picked) {
        const target = targetOf(event.target, event.clientY);
        if (target && target.date) move(state.picked, target);
        return;
      }
      // Maand: een dag aantikken opent die dag.
      const dayCell = event.target.closest('.mg-day');
      if (dayCell) setView('dag', dayCell.dataset.day);
    });
    $('#p-pick').addEventListener('click', (event) => {
      if (!event.target.closest('[data-unpick]')) return;
      event.preventDefault();
      state.picked = null;
      render();
    });
    document.querySelectorAll('.seg [data-view]').forEach((button) => {
      /** Kiest deze weergave. */
      button.onclick = () => { setView(button.dataset.view); };
    });
    /** Gaat terug in de tijd. */
    $('#p-prev').onclick = () => { shift(-1); };
    /** Gaat verder in de tijd. */
    $('#p-next').onclick = () => { shift(1); };
    /** Springt naar vandaag. */
    $('#p-today').onclick = () => { state.date = today(); render(); };
    /**
     * Springt naar de gekozen datum.
     * @param {Event} event de wijziging
     */
    $('#p-date').onchange = (event) => { if (WorkOrderCore.isDate(event.target.value)) { state.date = event.target.value; render(); } };
    /**
     * Toont of verbergt het weekend.
     * @param {Event} event de wijziging
     */
    $('#p-weekend').onchange = (event) => { state.weekend = event.target.checked; render(); };
    /**
     * Filtert op uitvoerder en onthoudt de keuze.
     * @param {Event} event de wijziging
     */
    $('#p-who').onchange = (event) => { state.who = event.target.value; store.set('aquatech_planning_who', state.who); render(); };
    $('#p-export').onclick = exportRange;
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.view === 'maand') render(); }, 200); });
    // De rode lijn van "nu" schuift mee.
    setInterval(() => { if (!state.dragging && state.view !== 'maand' && visibleDays().includes(today())) render(); }, 5 * 60 * 1000);
  }

  /** Vult de keuzelijst met uitvoerders. */
  function fillWho() {
    const myId = state.me.user.id;
    $('#p-who').innerHTML = '<option value="*">Alle uitvoerders</option>' + people()
      .map((person) => `<option value="${esc(person.id)}">${person.id === myId ? 'Mijn klussen' : esc(person.name)}</option>`).join('');
    if (![...$('#p-who').options].some((option) => option.value === state.who)) state.who = '*';
    $('#p-who').value = state.who;
  }

  // ---------- Excel: de planning in beeld ----------
  /**
   * Exporteert de werkorders in beeld naar Excel (.xlsx).
   * @returns {Promise<void>}
   */
  async function exportRange() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const days = visibleDays();
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'AquaTech Service';
      workbook.created = new Date();
      const name = state.view === 'dag' ? days[0] : state.view === 'week' ? `Week ${weekNo(state.date)}` : state.date.slice(0, 7);
      const worksheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }], pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      worksheet.columns = [
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
      for (const date of days) {
        for (const workOrder of itemsOn(date)) {
          const allDays = workDaysOf(workOrder);
          worksheet.addRow({
            date: new Date(`${date}T12:00:00`), from: workOrder.startTime, to: workOrder.endTime, who: workOrder.assignee ? workOrder.assignee.displayName : '',
            crew: workOrder.crew || '', number: workOrder.number, n: allDays.length > 1 ? `${allDays.indexOf(date) + 1}/${allDays.length}` : '', customer: workOrder.customer, address: workOrder.address, title: workOrder.title,
            status: WorkOrderCore.STATUSES[workOrder.status] || workOrder.status, appt: WorkOrderCore.APPOINTMENT[(workOrder.appointment || {}).state] || '',
          });
          count++;
        }
      }
      const head = worksheet.getRow(1);
      head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
      worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: worksheet.columns.length } };
      const blob = new Blob([await workbook.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `planning_${state.view}_${days[0]}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      toast(`${count} regels geëxporteerd`);
    } catch (error) {
      toast(`Export mislukt: ${error.message}`, true);
    }
  }

  /**
   * Start de planning: rechten controleren, weergave kiezen en de werkorders laden.
   * @returns {Promise<void>}
   */
  async function init() {
    state.me = await window.AquatechAccount.load('../');
    const rights = state.me.rights || [];
    if (!state.me.user || !rights.includes('planning')) {
      $('.p-layout').innerHTML = state.me.user && state.me.user.kind !== 'gast'
        ? '<p class="notice">Je rol heeft geen toegang tot de planning. <a href="../">Terug naar het overzicht</a></p>'
        : '<p class="notice">Log eerst in om de planning te bekijken. <a href="../login">Inloggen</a></p>';
      $('.p-toolbar').hidden = true;
      return;
    }
    // Weergave: uit de URL, anders de laatst gekozen, anders dag op een telefoon en werkweek op een groot scherm.
    const query = new URLSearchParams(location.search);
    const saved = store.get('aquatech_planning_view');
    state.view = VIEWS.includes(query.get('view')) ? query.get('view') : VIEWS.includes(saved) ? saved : window.innerWidth < 700 ? 'dag' : 'week';
    const date = query.get('datum') || query.get('week');
    if (WorkOrderCore.isDate(date)) state.date = date;
    if (state.view === 'dag' && isWeekend(state.date)) state.weekend = true;
    $('#p-weekend').checked = state.weekend;
    state.who = store.get('aquatech_planning_who') || '*';
    bind();
    try {
      const [workOrders, staff] = await Promise.all([api('workorders'), api('workorder-staff')]);
      state.items = workOrders.items || [];
      state.staff = staff.items || [];
    } catch (error) {
      $('#p-cal').innerHTML = `<p class="notice">Kan de planning niet laden (${esc(error.message)}).</p>`;
      return;
    }
    fillWho();
    render();
    // Terug uit een werkorder via de knop Terug: de planning opnieuw ophalen,
    // zodat een gewijzigde status of tijd meteen klopt.
    if (window.AquatechCommon) {
      window.AquatechCommon.onReturn(async () => {
        try {
          state.items = (await api('workorders')).items || [];
          render();
        } catch (error) { /* laat de laatste stand staan */ }
      });
    }
  }

  init();
})();
