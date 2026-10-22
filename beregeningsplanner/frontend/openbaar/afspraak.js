// Openbare afspraakpagina: de klant opent de link uit de e-mail, ziet wanneer
// de werkzaamheden gepland staan en bevestigt de afspraak of vraagt een ander
// moment. Geen account nodig. Het token staat in het fragment (#t=...) en gaat
// alleen in een kop naar de server, zodat het niet in logboeken terechtkomt.
(function () {
  const WorkOrderCore = window.WorkOrderCore;
  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get('t') || '';
  const preview = hash.get('voorbeeld') === '1';
  const state = { appointment: null, profile: null };

  /**
   * Datum (JJJJ-MM-DD) als Nederlandse tekst.
   * @param {string} iso Datum als JJJJ-MM-DD.
   * @param {object} formatOptions Opties voor toLocaleDateString.
   * @returns {string} De opgemaakte datum.
   */
  const day = (iso, formatOptions) => new Date(`${iso}T12:00:00`).toLocaleDateString('nl-NL', formatOptions);
  /**
   * Datum voluit, bijv. "donderdag 22 oktober 2026".
   * @param {string} iso Datum als JJJJ-MM-DD.
   * @returns {string} De datum voluit.
   */
  const longDate = (iso) => day(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  /**
   * Datum en tijd voluit.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 oktober 2026 om 10:15".
   */
  const dateTime = (iso) => new Date(iso).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });
  /**
   * Tijd van de afspraak als tekst.
   * @param {object} appointment De afspraak.
   * @returns {string} Bijv. "08:00 – 12:00 uur" of "Tijd volgt nog".
   */
  const timeText = (appointment) => (appointment.startTime ? `${appointment.startTime}${appointment.endTime ? ` – ${appointment.endTime}` : ''} uur` : 'Tijd volgt nog');

  /**
   * Roept de openbare afspraak-API aan met het token als kop.
   * @param {string} path Pad onder api/public/, bijv. "appointment".
   * @param {object} [body] JSON-body; met body een POST, anders een GET.
   * @returns {Promise<object>} Het antwoord (fout = Error met status).
   */
  async function api(path, body) {
    const res = await fetch(`../api/public/${path}${preview && !body ? '?preview=1' : ''}`, {
      method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit',
      headers: { 'X-Afspraak-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.message || `Er ging iets mis (${res.status}).`), { status: res.status });
    return out;
  }

  /**
   * Toont een melding in plaats van de afspraak.
   * @param {string} text De melding (leeg = weg).
   */
  const message = (text) => { $('#a-message').textContent = text; };
  /**
   * Toont of verbergt de statusbalk boven de afspraak.
   * @param {string} text De tekst (leeg = verbergen).
   * @param {string} [kind] Extra klasse: ok, bad of warn.
   */
  function status(text, kind) {
    const banner = $('#a-status');
    banner.textContent = text || '';
    banner.className = `o-status${kind ? ` ${kind}` : ''}`;
    banner.hidden = !text;
  }

  /**
   * Agendabestand (.ics) voor de eigen agenda van de klant.
   * @param {object} appointment De afspraak.
   * @param {object} profile Bedrijfsprofiel (naam).
   * @returns {Blob} Het .ics-bestand.
   */
  function icsFile(appointment, profile) {
    /**
     * Datum en tijd in het formaat van iCalendar.
     * @param {string} date Datum als JJJJ-MM-DD.
     * @param {string} time Tijd als UU:MM.
     * @returns {string} Bijv. "20261022T080000".
     */
    const stamp = (date, time) => `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
    const lastDate = appointment.dates[appointment.dates.length - 1];
    const allDay = !appointment.startTime;
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AquaTech//Afspraak//NL', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
      `UID:${appointment.number}-${appointment.plannedDate}@aquatech`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      allDay ? `DTSTART;VALUE=DATE:${appointment.plannedDate.replace(/-/g, '')}` : `DTSTART;TZID=Europe/Amsterdam:${stamp(appointment.plannedDate, appointment.startTime)}`,
      allDay ? `DTEND;VALUE=DATE:${WorkOrderCore.addDays(lastDate, 1).replace(/-/g, '')}` : `DTEND;TZID=Europe/Amsterdam:${stamp(lastDate, appointment.endTime || appointment.startTime)}`,
      `SUMMARY:${(profile.companyName ? `${profile.companyName}: ` : '')}${appointment.title}`.replace(/[,;]/g, (character) => `\\${character}`),
      appointment.address ? `LOCATION:${appointment.address.replace(/\n/g, ', ').replace(/[,;]/g, (character) => `\\${character}`)}` : '',
      'END:VEVENT', 'END:VCALENDAR',
    ].filter(Boolean);
    return new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  }

  /** Tekent de afspraak, de statusbalk en (als het nog kan) het formulier om te reageren. */
  function render() {
    const appointment = state.appointment;
    const profile = state.profile || {};
    document.title = `Afspraak ${appointment.number}${profile.companyName ? ` – ${profile.companyName}` : ''}`;
    $('#a-company').textContent = profile.companyName || 'Afspraak';
    message('');
    const appointmentState = appointment.appointment.state;
    const response = appointment.appointment.response;
    const past = appointment.plannedDate && appointment.plannedDate < appointment.today;
    const open = Boolean(appointment.plannedDate) && ['open', 'gepland'].includes(appointment.status) && !past && !(response && response.current);
    if (appointment.status === 'geannuleerd') status('Deze afspraak is geannuleerd. Neem contact met ons op als u vragen heeft.', 'bad');
    else if (appointment.status === 'gereed') status('De werkzaamheden zijn uitgevoerd. Bedankt voor uw vertrouwen!', 'ok');
    else if (!appointment.plannedDate) status('Er is nog geen datum gepland. U hoort van ons zodra de afspraak vaststaat.', 'warn');
    else if (appointmentState === 'bevestigd') status(`U heeft deze afspraak bevestigd op ${dateTime(response.at)}. Tot dan!`, 'ok');
    else if (appointmentState === 'ander_moment') status(`U heeft op ${dateTime(response.at)} om een ander moment gevraagd. Wij nemen contact met u op en sturen u een nieuwe afspraak.`, 'warn');
    else if (past) status('Deze afspraak ligt in het verleden.', 'warn');
    else status(`${response && !response.current ? 'De afspraak is gewijzigd. ' : ''}Controleer het moment hieronder en bevestig de afspraak, of vraag een ander moment.${preview ? ' (Voorbeeld: het openen telt niet als bekeken.)' : ''}`);

    const whenHtml = appointment.plannedDate ? `
      <div class="a-when">
        <div class="cal"><span class="m">${esc(day(appointment.plannedDate, { month: 'short' }).replace('.', ''))}</span><span class="d">${esc(day(appointment.plannedDate, { day: 'numeric' }))}</span></div>
        <div class="txt"><b>${esc(longDate(appointment.plannedDate))}</b><span>${esc(timeText(appointment))}${appointment.days > 1 ? ` · ${appointment.days} werkdagen, t/m ${esc(longDate(appointment.dates[appointment.dates.length - 1]))}` : ''}</span></div>
      </div>` : '';
    const contact = [profile.phone ? `<a href="tel:${esc(profile.phone.replace(/[^\d+]/g, ''))}">${esc(profile.phone)}</a>` : '', profile.email ? `<a href="mailto:${esc(profile.email)}">${esc(profile.email)}</a>` : ''].filter(Boolean).join(' · ');
    $('#a-card').innerHTML = `
      <h1>${esc(appointment.title || 'Werkzaamheden')}</h1>
      <p class="sub">Werkorder ${esc(appointment.number)}${appointment.quoteNumber ? ` · bij offerte ${esc(appointment.quoteNumber)}` : ''}</p>
      ${whenHtml}
      <table class="a-facts">
        ${appointment.customer ? `<tr><td>Voor</td><td>${esc(appointment.customer)}</td></tr>` : ''}
        ${appointment.address ? `<tr><td>Adres</td><td>${esc(appointment.address).replace(/\n/g, '<br>')}</td></tr>` : ''}
        ${appointment.days > 1 ? `<tr><td>Werkdagen</td><td><ul class="a-days">${appointment.dates.map((date) => `<li>${esc(longDate(date))}</li>`).join('')}</ul></td></tr>` : ''}
      </table>
      ${appointment.plannedDate && !['geannuleerd', 'gereed'].includes(appointment.status) && !past ? '<div class="a-actions"><button type="button" class="btn" id="a-ics">Zet in mijn agenda</button></div>' : ''}
      ${contact ? `<p class="a-contact">Vragen? Neem contact op met ${esc(profile.companyName || 'ons')}: ${contact}</p>` : ''}`;
    $('#a-card').hidden = false;
    const icsButton = $('#a-ics');
    if (icsButton) {
      /** Downloadt het agendabestand. */
      icsButton.onclick = () => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(icsFile(appointment, profile));
        link.download = `afspraak-${appointment.number}.ics`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      };
    }
    $('#a-form').hidden = !open;
    if (open && response && !$('#a-name').value) $('#a-name').value = response.name;
  }

  /**
   * Verstuurt de reactie van de klant (bevestigd of ander moment) en tekent opnieuw.
   * @param {string} answer "bevestigd" of "ander_moment".
   * @returns {Promise<void>}
   */
  async function respond(answer) {
    /**
     * Toont een foutmelding bij het formulier.
     * @param {string} text De melding (leeg = weg).
     * @returns {void}
     */
    const showError = (text) => { $('#a-err').textContent = text || ''; };
    const name = $('#a-name').value.trim();
    const reason = $('#a-reason').value.trim();
    if (name.length < 2) return showError('Vul uw naam in.');
    if (answer === 'ander_moment' && reason.length < 3) return showError('Laat weten welk moment u beter uitkomt.');
    showError('');
    const buttons = document.querySelectorAll('#a-form button');
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const out = await api('appointment/respond', { answer, name, reason });
      state.appointment = out.appointment;
      render();
      window.scrollTo(0, 0);
    } catch (error) {
      showError(error.message);
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  /**
   * Koppelt de knoppen, haalt de afspraak op bij het token en tekent hem.
   * @returns {Promise<void>}
   */
  async function init() {
    /**
     * Bevestigt de afspraak.
     * @returns {Promise<void>}
     */
    $('#a-confirm').onclick = () => respond('bevestigd');
    /** Toont of verbergt het veld voor een ander moment. */
    $('#a-other-open').onclick = () => { $('#a-other').hidden = !$('#a-other').hidden; if (!$('#a-other').hidden) $('#a-reason').focus(); };
    /**
     * Vraagt een ander moment.
     * @returns {Promise<void>}
     */
    $('#a-other-send').onclick = () => respond('ander_moment');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
      message('Deze link is niet compleet. Open de link uit de e-mail opnieuw, of neem contact op met de afzender.');
      return;
    }
    try {
      const out = await api('appointment');
      state.appointment = out.appointment;
      state.profile = out.profile;
      if (window.AquatechTheme) window.AquatechTheme.apply(out.theme);
      render();
    } catch (error) {
      message(error.status === 429 ? 'Te veel verzoeken. Probeer het later opnieuw.' : error.message);
    }
  }

  init();
})();
