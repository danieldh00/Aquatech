// Openbare afspraakpagina: de klant opent de link uit de e-mail, ziet wanneer
// de werkzaamheden gepland staan en bevestigt de afspraak of vraagt een ander
// moment. Geen account nodig. Het token staat in het fragment (#t=...) en gaat
// alleen in een kop naar de server, zodat het niet in logboeken terechtkomt.
(function () {
  const W = window.WorkOrderCore;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get('t') || '';
  const preview = hash.get('voorbeeld') === '1';
  const state = { a: null, profile: null };

  const day = (iso, opts) => new Date(`${iso}T12:00:00`).toLocaleDateString('nl-NL', opts);
  const longDate = (iso) => day(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const dateTime = (iso) => new Date(iso).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });
  const timeText = (a) => (a.startTime ? `${a.startTime}${a.endTime ? ` – ${a.endTime}` : ''} uur` : 'Tijd volgt nog');

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

  const message = (text) => { $('#a-message').textContent = text; };
  function status(text, cls) {
    const el = $('#a-status');
    el.textContent = text || '';
    el.className = `o-status${cls ? ` ${cls}` : ''}`;
    el.hidden = !text;
  }

  // Agendabestand (.ics) voor de eigen agenda van de klant.
  function icsFile(a, p) {
    const stamp = (d, t) => `${d.replace(/-/g, '')}T${t.replace(':', '')}00`;
    const last = a.dates[a.dates.length - 1];
    const allDay = !a.startTime;
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AquaTech//Afspraak//NL', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
      `UID:${a.number}-${a.plannedDate}@aquatech`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      allDay ? `DTSTART;VALUE=DATE:${a.plannedDate.replace(/-/g, '')}` : `DTSTART;TZID=Europe/Amsterdam:${stamp(a.plannedDate, a.startTime)}`,
      allDay ? `DTEND;VALUE=DATE:${W.addDays(last, 1).replace(/-/g, '')}` : `DTEND;TZID=Europe/Amsterdam:${stamp(last, a.endTime || a.startTime)}`,
      `SUMMARY:${(p.companyName ? `${p.companyName}: ` : '')}${a.title}`.replace(/[,;]/g, (c) => `\\${c}`),
      a.address ? `LOCATION:${a.address.replace(/\n/g, ', ').replace(/[,;]/g, (c) => `\\${c}`)}` : '',
      'END:VEVENT', 'END:VCALENDAR',
    ].filter(Boolean);
    return new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  }

  function render() {
    const a = state.a;
    const p = state.profile || {};
    document.title = `Afspraak ${a.number}${p.companyName ? ` – ${p.companyName}` : ''}`;
    $('#a-company').textContent = p.companyName || 'Afspraak';
    message('');
    const st = a.appointment.state;
    const r = a.appointment.response;
    const past = a.plannedDate && a.plannedDate < a.today;
    const open = Boolean(a.plannedDate) && ['open', 'gepland'].includes(a.status) && !past && !(r && r.current);
    if (a.status === 'geannuleerd') status('Deze afspraak is geannuleerd. Neem contact met ons op als u vragen heeft.', 'bad');
    else if (a.status === 'gereed') status('De werkzaamheden zijn uitgevoerd. Bedankt voor uw vertrouwen!', 'ok');
    else if (!a.plannedDate) status('Er is nog geen datum gepland. U hoort van ons zodra de afspraak vaststaat.', 'warn');
    else if (st === 'bevestigd') status(`U heeft deze afspraak bevestigd op ${dateTime(r.at)}. Tot dan!`, 'ok');
    else if (st === 'ander_moment') status(`U heeft op ${dateTime(r.at)} om een ander moment gevraagd. Wij nemen contact met u op en sturen u een nieuwe afspraak.`, 'warn');
    else if (past) status('Deze afspraak ligt in het verleden.', 'warn');
    else status(`${r && !r.current ? 'De afspraak is gewijzigd. ' : ''}Controleer het moment hieronder en bevestig de afspraak, of vraag een ander moment.${preview ? ' (Voorbeeld: het openen telt niet als bekeken.)' : ''}`);

    const when = a.plannedDate ? `
      <div class="a-when">
        <div class="cal"><span class="m">${esc(day(a.plannedDate, { month: 'short' }).replace('.', ''))}</span><span class="d">${esc(day(a.plannedDate, { day: 'numeric' }))}</span></div>
        <div class="txt"><b>${esc(longDate(a.plannedDate))}</b><span>${esc(timeText(a))}${a.days > 1 ? ` · ${a.days} werkdagen, t/m ${esc(longDate(a.dates[a.dates.length - 1]))}` : ''}</span></div>
      </div>` : '';
    const contact = [p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a>` : '', p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ''].filter(Boolean).join(' · ');
    $('#a-card').innerHTML = `
      <h1>${esc(a.title || 'Werkzaamheden')}</h1>
      <p class="sub">Werkorder ${esc(a.number)}${a.quoteNumber ? ` · bij offerte ${esc(a.quoteNumber)}` : ''}</p>
      ${when}
      <table class="a-facts">
        ${a.customer ? `<tr><td>Voor</td><td>${esc(a.customer)}</td></tr>` : ''}
        ${a.address ? `<tr><td>Adres</td><td>${esc(a.address).replace(/\n/g, '<br>')}</td></tr>` : ''}
        ${a.days > 1 ? `<tr><td>Werkdagen</td><td><ul class="a-days">${a.dates.map((d) => `<li>${esc(longDate(d))}</li>`).join('')}</ul></td></tr>` : ''}
      </table>
      ${a.plannedDate && !['geannuleerd', 'gereed'].includes(a.status) && !past ? '<div class="a-actions"><button type="button" class="btn" id="a-ics">Zet in mijn agenda</button></div>' : ''}
      ${contact ? `<p class="a-contact">Vragen? Neem contact op met ${esc(p.companyName || 'ons')}: ${contact}</p>` : ''}`;
    $('#a-card').hidden = false;
    const ics = $('#a-ics');
    if (ics) {
      ics.onclick = () => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(icsFile(a, p));
        link.download = `afspraak-${a.number}.ics`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      };
    }
    $('#a-form').hidden = !open;
    if (open && r && !$('#a-name').value) $('#a-name').value = r.name;
  }

  async function respond(answer) {
    const err = (m) => { $('#a-err').textContent = m || ''; };
    const name = $('#a-name').value.trim();
    const reason = $('#a-reason').value.trim();
    if (name.length < 2) return err('Vul uw naam in.');
    if (answer === 'ander_moment' && reason.length < 3) return err('Laat weten welk moment u beter uitkomt.');
    err('');
    const buttons = document.querySelectorAll('#a-form button');
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const out = await api('appointment/respond', { answer, name, reason });
      state.a = out.appointment;
      render();
      window.scrollTo(0, 0);
    } catch (e) {
      err(e.message);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  async function init() {
    $('#a-confirm').onclick = () => respond('bevestigd');
    $('#a-other-open').onclick = () => { $('#a-other').hidden = !$('#a-other').hidden; if (!$('#a-other').hidden) $('#a-reason').focus(); };
    $('#a-other-send').onclick = () => respond('ander_moment');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
      message('Deze link is niet compleet. Open de link uit de e-mail opnieuw, of neem contact op met de afzender.');
      return;
    }
    try {
      const out = await api('appointment');
      state.a = out.appointment;
      state.profile = out.profile;
      if (window.AquatechTheme) window.AquatechTheme.apply(out.theme);
      render();
    } catch (e) {
      message(e.status === 429 ? 'Te veel verzoeken. Probeer het later opnieuw.' : e.message);
    }
  }

  init();
})();
