// Startscherm "Vandaag": wat er vandaag voor de ingelogde medewerker gepland
// staat (api/my-day), mobiel-eerst. Per klus de tijd, het adres met route, de
// klant (bellen), notities, voortgang en directe links naar de werkorder en
// de foto's. Bladeren per dag; "Hele ploeg" toont de klussen van iedereen.
// Alleen voor wie het recht 'werkorders' heeft (installateur, beheerder).
(function () {
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUSES = { open: 'Nieuw', gepland: 'Gepland', bezig: 'In uitvoering', gereed: 'Gereed', geannuleerd: 'Geannuleerd' };
  const APPT = { wacht: 'Wacht op klant', bevestigd: 'Bevestigd door klant', ander_moment: 'Klant vraagt ander moment' };
  const ALL_KEY = 'aquatech_today_all';

  const state = { date: '', today: '', all: false, el: null, loading: 0 };

  const pad = (n) => String(n).padStart(2, '0');
  function addDays(date, n) {
    const dt = new Date(`${date}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + n);
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }
  const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const shortDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  function dayLabel(d) {
    if (d === state.today) return 'Vandaag';
    if (d === addDays(state.today, 1)) return 'Morgen';
    if (d === addDays(state.today, -1)) return 'Gisteren';
    return longDate(d).replace(/^./, (c) => c.toUpperCase());
  }
  const mapsUrl = (a) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;
  const timeOf = (w) => (w.startTime ? `${w.startTime}${w.endTime ? `–${w.endTime}` : ''}` : 'Hele dag');

  function card(w) {
    const open = `werkorders/?id=${encodeURIComponent(w.id)}`;
    const p = w.progress || { steps: 0, done: 0, pct: 0 };
    const appt = w.appointment && APPT[w.appointment.state];
    const sub = [
      esc(w.number),
      w.totalDays > 1 ? `dag ${w.dayNumber} van ${w.totalDays}` : '',
      state.all ? esc(w.assignee ? w.assignee.displayName : 'Nog niet toegewezen') : '',
    ].filter(Boolean).join(' · ');
    const notes = [w.siteNotes, w.instructions || w.summary].filter(Boolean);
    return `
      <article class="job st-${esc(w.status)}">
        <div class="job-head">
          <span class="job-time">${esc(timeOf(w))}</span>
          <span class="pill wo-${esc(w.status)}">${esc(STATUSES[w.status] || w.status)}</span>
        </div>
        <div class="job-title">${esc(w.customer || w.title || 'Werkorder')}</div>
        <div class="job-sub">${sub}</div>
        ${w.address ? `<a class="job-addr" href="${esc(mapsUrl(w.address))}" target="_blank" rel="noopener">${esc(w.address)}</a>` : ''}
        ${w.contact || w.phone ? `<div class="job-contact">${esc(w.contact)}${w.contact && w.phone ? ' · ' : ''}${w.phone ? `<a href="tel:${esc(w.phone.replace(/[^\d+]/g, ''))}">${esc(w.phone)}</a>` : ''}</div>` : ''}
        ${appt ? `<div><span class="pill appt-${esc(w.appointment.state)}">${esc(appt)}</span></div>` : ''}
        ${notes.map((n) => `<p class="job-note">${esc(n)}</p>`).join('')}
        ${p.steps ? `<div class="job-progress"><span class="bar"><span style="width:${Number(p.pct) || 0}%"></span></span><span>${p.done}/${p.steps} stappen</span></div>` : ''}
        <div class="job-actions">
          <a class="btn primary" href="${open}">Werkorder openen</a>
          <a class="btn" href="${open}#fotos">Foto's${w.photos ? ` (${w.photos})` : ''}</a>
          ${w.address ? `<a class="btn" href="${esc(mapsUrl(w.address))}" target="_blank" rel="noopener">Route</a>` : ''}
          ${w.phone ? `<a class="btn" href="tel:${esc(w.phone.replace(/[^\d+]/g, ''))}">Bellen</a>` : ''}
        </div>
      </article>`;
  }

  function render(data) {
    const el = state.el;
    const items = data.items || [];
    const label = dayLabel(state.date);
    const named = ['Vandaag', 'Morgen', 'Gisteren'].includes(label);
    let body;
    if (items.length) {
      body = `<div class="jobs">${items.map(card).join('')}</div>`;
    } else {
      const who = state.all ? 'Er staat niets gepland' : 'Er staat niets op je naam';
      const next = data.next
        ? `<a class="tile job-next" href="werkorders/?id=${encodeURIComponent(data.next.id)}">
             <span class="tile-text"><span class="tile-title">Volgende klus: ${esc(shortDate(data.next.plannedDate))}${data.next.startTime ? `, ${esc(data.next.startTime)}` : ''}</span>
             <span class="tile-desc">${esc([data.next.customer || data.next.title, data.next.address].filter(Boolean).join(' · '))}</span></span></a>`
        : '';
      body = `<div class="job-empty"><p>${who} ${named ? label.toLowerCase() : `op ${esc(longDate(state.date))}`}.</p>${next}</div>`;
    }
    el.innerHTML = `
      <div class="today-head">
        <h2>${esc(label)}${named ? ` <span class="today-date">${esc(longDate(state.date))}</span>` : ''}</h2>
        <div class="today-nav">
          <button type="button" class="btn" data-day="-1" aria-label="Vorige dag">‹</button>
          <button type="button" class="btn" data-day="0"${state.date === state.today ? ' disabled' : ''}>Vandaag</button>
          <button type="button" class="btn" data-day="1" aria-label="Volgende dag">›</button>
        </div>
      </div>
      <div class="today-tools">
        <label class="chk"><input type="checkbox" data-all${state.all ? ' checked' : ''}> Hele ploeg</label>
        <span class="muted">${items.length ? `${items.length} klus${items.length === 1 ? '' : 'sen'}` : ''}</span>
        <a class="today-link" href="planning/">Planning →</a>
      </div>
      ${body}`;
    el.hidden = false;
  }

  async function load() {
    const n = ++state.loading;
    const qs = new URLSearchParams();
    if (state.date) qs.set('date', state.date);
    if (state.all) qs.set('all', '1');
    let data;
    try {
      const res = await fetch(`api/my-day?${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      if (n !== state.loading) return;
      state.el.innerHTML = '<h2>Vandaag</h2><p class="muted">Kan de planning nu niet laden.</p>';
      state.el.hidden = false;
      return;
    }
    if (n !== state.loading) return;
    state.today = data.today;
    if (!state.date) state.date = data.date;
    render(data);
    keepOffline(data, qs);
  }

  // Klussen van vandaag (en de volgende) alvast op het toestel zetten, zodat
  // de installateur ze op locatie ook zonder bereik kan openen (shared/offline.js).
  function keepOffline(data, qs) {
    const off = window.AquatechOffline;
    if (!off || !off.supported || state.kept === data.date) return;
    state.kept = data.date;
    const ids = (data.items || []).map((w) => w.id).concat(data.next ? [data.next.id] : []);
    const next = new URLSearchParams(qs);
    next.set('date', addDays(data.date, 1));
    off.prefetch([
      'api/workorders', 'api/workorder-staff', 'api/quote-profile', `api/my-day?${next}`,
      ...ids.flatMap((id) => [`api/workorders/${encodeURIComponent(id)}`, `api/workorders/${encodeURIComponent(id)}/photos`]),
    ]);
  }

  function bind() {
    state.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-day]');
      if (!b) return;
      const d = Number(b.dataset.day);
      state.date = d === 0 ? state.today : addDays(state.date, d);
      load();
    });
    state.el.addEventListener('change', (e) => {
      if (!e.target.matches('[data-all]')) return;
      state.all = e.target.checked;
      try { localStorage.setItem(ALL_KEY, state.all ? '1' : '0'); } catch (err) { /* geen opslag */ }
      load();
    });
    // Telefoon die 's ochtends weer opengaat: verse planning (en een nieuwe dag).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (state.date === state.today) state.date = '';
      load();
    });
  }

  /**
   * Toont het blok voor wie werkorders heeft. Installateurs zien standaard hun
   * eigen klussen, beheerders (die plannen) de hele ploeg.
   */
  function start(me) {
    const rights = (me && me.rights) || [];
    state.el = document.getElementById('today');
    if (!state.el || !me || !me.user || !rights.includes('werkorders') || location.protocol === 'file:') return false;
    let saved = null;
    try { saved = localStorage.getItem(ALL_KEY); } catch (e) { /* geen opslag */ }
    // Wie zelf niet uitvoert (zoals een planner) ziet standaard de hele ploeg.
    state.all = saved === null ? rights.includes('beheer') || !rights.includes('uitvoerder') : saved === '1';
    bind();
    state.bound = true;
    load();
    return true;
  }

  // Opnieuw laden (terug op het dashboard via de knop Terug van de browser).
  const refresh = () => { if (state.el && state.bound) load(); };

  window.AquatechToday = { start, refresh };
})();
