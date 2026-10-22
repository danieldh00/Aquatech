// Startscherm "Vandaag": wat er vandaag voor de ingelogde medewerker gepland
// staat (api/my-day), mobiel-eerst. Per klus de tijd, het adres met route, de
// klant (bellen), notities, voortgang en directe links naar de werkorder en
// de foto's. Bladeren per dag; "Hele ploeg" toont de klussen van iedereen.
// Alleen voor wie het recht 'werkorders' heeft (installateur, beheerder).
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
  const STATUSES = { open: 'Nieuw', gepland: 'Gepland', bezig: 'In uitvoering', gereed: 'Gereed', geannuleerd: 'Geannuleerd' };
  const APPOINTMENT_STATES = { wacht: 'Wacht op klant', bevestigd: 'Bevestigd door klant', ander_moment: 'Klant vraagt ander moment' };
  const ALL_KEY = 'aquatech_today_all';

  const state = { date: '', today: '', all: false, container: null, loading: 0 };

  /**
   * Getal met een voorloopnul tot twee cijfers.
   * @param {number} number Het getal.
   * @returns {string} Bijv. "07".
   */
  const padTwo = (number) => String(number).padStart(2, '0');
  /**
   * Telt dagen op bij een datum.
   * @param {string} date Datum als JJJJ-MM-DD.
   * @param {number} count Aantal dagen (negatief = terug).
   * @returns {string} De nieuwe datum als JJJJ-MM-DD.
   */
  function addDays(date, count) {
    const moment = new Date(`${date}T00:00:00Z`);
    moment.setUTCDate(moment.getUTCDate() + count);
    return `${moment.getUTCFullYear()}-${padTwo(moment.getUTCMonth() + 1)}-${padTwo(moment.getUTCDate())}`;
  }
  /**
   * Datum voluit, bijv. "donderdag 22 oktober".
   * @param {string} date Datum als JJJJ-MM-DD.
   * @returns {string} De datum voluit.
   */
  const longDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  /**
   * Datum kort, bijv. "do 22 okt".
   * @param {string} date Datum als JJJJ-MM-DD.
   * @returns {string} De datum kort.
   */
  const shortDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  /**
   * Kopje voor een dag: Vandaag, Morgen, Gisteren of de datum voluit.
   * @param {string} date Datum als JJJJ-MM-DD.
   * @returns {string} Het kopje.
   */
  function dayLabel(date) {
    if (date === state.today) return 'Vandaag';
    if (date === addDays(state.today, 1)) return 'Morgen';
    if (date === addDays(state.today, -1)) return 'Gisteren';
    return longDate(date).replace(/^./, (character) => character.toUpperCase());
  }
  /**
   * Link naar Google Maps voor een adres.
   * @param {string} address Het adres.
   * @returns {string} De URL.
   */
  const mapsUrl = (address) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  /**
   * Tijd van een klus als tekst.
   * @param {object} job Klus uit api/my-day.
   * @returns {string} Bijv. "08:00–12:00" of "Hele dag".
   */
  const timeOf = (job) => (job.startTime ? `${job.startTime}${job.endTime ? `–${job.endTime}` : ''}` : 'Hele dag');

  /**
   * Kaart voor één klus: tijd, status, klant, adres, notities, voortgang en knoppen.
   * @param {object} job Klus uit api/my-day.
   * @returns {string} HTML van de kaart.
   */
  function card(job) {
    const workOrderHref = `werkorders/?id=${encodeURIComponent(job.id)}`;
    const progress = job.progress || { steps: 0, done: 0, pct: 0 };
    const appointmentLabel = job.appointment && APPOINTMENT_STATES[job.appointment.state];
    const subtitle = [
      esc(job.number),
      job.totalDays > 1 ? `dag ${job.dayNumber} van ${job.totalDays}` : '',
      state.all ? esc(job.assignee ? job.assignee.displayName : 'Nog niet toegewezen') : '',
    ].filter(Boolean).join(' · ');
    const notes = [job.siteNotes, job.instructions || job.summary].filter(Boolean);
    return `
      <article class="job st-${esc(job.status)}">
        <div class="job-head">
          <span class="job-time">${esc(timeOf(job))}</span>
          <span class="pill wo-${esc(job.status)}">${esc(STATUSES[job.status] || job.status)}</span>
        </div>
        <div class="job-title">${esc(job.customer || job.title || 'Werkorder')}</div>
        <div class="job-sub">${subtitle}</div>
        ${job.address ? `<a class="job-addr" href="${esc(mapsUrl(job.address))}" target="_blank" rel="noopener">${esc(job.address)}</a>` : ''}
        ${job.contact || job.phone ? `<div class="job-contact">${esc(job.contact)}${job.contact && job.phone ? ' · ' : ''}${job.phone ? `<a href="tel:${esc(job.phone.replace(/[^\d+]/g, ''))}">${esc(job.phone)}</a>` : ''}</div>` : ''}
        ${appointmentLabel ? `<div><span class="pill appt-${esc(job.appointment.state)}">${esc(appointmentLabel)}</span></div>` : ''}
        ${notes.map((note) => `<p class="job-note">${esc(note)}</p>`).join('')}
        ${progress.steps ? `<div class="job-progress"><span class="bar"><span style="width:${Number(progress.pct) || 0}%"></span></span><span>${progress.done}/${progress.steps} stappen</span></div>` : ''}
        <div class="job-actions">
          <a class="btn primary" href="${workOrderHref}">Werkorder openen</a>
          <a class="btn" href="${workOrderHref}#fotos">Foto's${job.photos ? ` (${job.photos})` : ''}</a>
          ${job.address ? `<a class="btn" href="${esc(mapsUrl(job.address))}" target="_blank" rel="noopener">Route</a>` : ''}
          ${job.phone ? `<a class="btn" href="tel:${esc(job.phone.replace(/[^\d+]/g, ''))}">Bellen</a>` : ''}
        </div>
      </article>`;
  }

  /**
   * Tekent het blok voor de gekozen dag.
   * @param {object} data Antwoord van api/my-day (items, next).
   */
  function render(data) {
    const container = state.container;
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
    container.innerHTML = `
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
    container.hidden = false;
  }

  /**
   * Haalt de klussen van de gekozen dag op en tekent ze; een ouder antwoord wordt genegeerd.
   * @returns {Promise<void>}
   */
  async function load() {
    const requestNumber = ++state.loading;
    const query = new URLSearchParams();
    if (state.date) query.set('date', state.date);
    if (state.all) query.set('all', '1');
    let data;
    try {
      const res = await fetch(`api/my-day?${query}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (error) {
      if (requestNumber !== state.loading) return;
      state.container.innerHTML = '<h2>Vandaag</h2><p class="muted">Kan de planning nu niet laden.</p>';
      state.container.hidden = false;
      return;
    }
    if (requestNumber !== state.loading) return;
    state.today = data.today;
    if (!state.date) state.date = data.date;
    render(data);
    keepOffline(data, query);
  }

  /**
   * Klussen van vandaag (en de volgende) alvast op het toestel zetten, zodat
   * de installateur ze op locatie ook zonder bereik kan openen (shared/offline.js).
   * @param {object} data Antwoord van api/my-day.
   * @param {URLSearchParams} query De vraag van dit antwoord.
   */
  function keepOffline(data, query) {
    const offline = window.AquatechOffline;
    if (!offline || !offline.supported || state.kept === data.date) return;
    state.kept = data.date;
    const ids = (data.items || []).map((job) => job.id).concat(data.next ? [data.next.id] : []);
    const nextQuery = new URLSearchParams(query);
    nextQuery.set('date', addDays(data.date, 1));
    offline.prefetch([
      'api/workorders', 'api/workorder-staff', 'api/quote-profile', `api/my-day?${nextQuery}`,
      ...ids.flatMap((id) => [`api/workorders/${encodeURIComponent(id)}`, `api/workorders/${encodeURIComponent(id)}/photos`, `api/workorders/${encodeURIComponent(id)}/worklog`]),
    ]);
  }

  /** Koppelt bladeren per dag, "Hele ploeg" en verversen als de telefoon weer opengaat. */
  function bind() {
    state.container.addEventListener('click', (event) => {
      const button = event.target.closest('[data-day]');
      if (!button) return;
      const step = Number(button.dataset.day);
      state.date = step === 0 ? state.today : addDays(state.date, step);
      load();
    });
    state.container.addEventListener('change', (event) => {
      if (!event.target.matches('[data-all]')) return;
      state.all = event.target.checked;
      try { localStorage.setItem(ALL_KEY, state.all ? '1' : '0'); } catch (error) { /* geen opslag */ }
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
   * @param {object} me Antwoord van api/me.
   * @returns {boolean} true als het blok getoond wordt.
   */
  function start(me) {
    const rights = (me && me.rights) || [];
    state.container = document.getElementById('today');
    if (!state.container || !me || !me.user || !rights.includes('werkorders') || location.protocol === 'file:') return false;
    let saved = null;
    try { saved = localStorage.getItem(ALL_KEY); } catch (error) { /* geen opslag */ }
    // Wie zelf niet uitvoert (zoals een planner) ziet standaard de hele ploeg.
    state.all = saved === null ? rights.includes('beheer') || !rights.includes('uitvoerder') : saved === '1';
    bind();
    state.bound = true;
    load();
    return true;
  }

  /**
   * Opnieuw laden (terug op het dashboard via de knop Terug van de browser).
   * @returns {void}
   */
  const refresh = () => { if (state.container && state.bound) load(); };

  window.AquatechToday = { start, refresh };
})();
