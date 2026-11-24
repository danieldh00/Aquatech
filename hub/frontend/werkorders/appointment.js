// Werkorders: het blok Afspraak met de klant (klantlink, stand, reactie) en het
// verstuurvenster. Wordt door werkorders.js aangemaakt met createAppointment.
(function () {
  const WorkOrderCore = window.WorkOrderCore;
  const { $, esc, state, toast, api } = window.Werkorders.common;

  /**
   * Maakt het onderdeel Afspraak met de klant.
   * @param {object} deps functies uit werkorders.js die dit onderdeel nodig heeft: save
   * @returns {object} de functies: renderAppt, applyAppt, bindApptSend
   */
  window.Werkorders.createAppointment = function (deps) {
    const { save } = deps;
    // ---------- Afspraak met de klant (klantlink) ----------
    /**
     * Formatteert een tijdstip met datum en tijd.
     * @param {string} iso tijdstip in ISO-formaat
     * @returns {string} bijv. '3 nov 2026 14:05'
     */
    const dateTime = (iso) => new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
    /**
     * Maakt het label met de stand van de afspraak.
     * @param {{state: string}} appointment de afspraak
     * @returns {string} HTML van het label
     */
    const apptPill = (appointment) => `<span class="pill appt-${esc(appointment.state)}">${esc(WorkOrderCore.APPOINTMENT[appointment.state] || appointment.state)}</span>`;
    /**
     * Geeft het adres van de openbare afspraakpagina; volgt uit waar deze module draait (ook achter een padprefix), de server kent dat zelf niet.
     * @returns {string} absolute URL van openbaar/afspraak.html
     */
    const shareBase = () => new URL('../openbaar/afspraak.html', location.href).href;

    /** Toont het blok Afspraak met de klant: stand, reactie, link en knoppen. */
    function renderAppt() {
      const workOrder = state.workOrder;
      const box = $('#e-appt');
      // Afspraaklink uit (Beheer > Modules): het blok verdwijnt.
      box.hidden = !window.AquatechModuleTools.isOn(state.moduleFlags, 'afspraaklink');
      if (box.hidden) { box.innerHTML = ''; return; }
      const appointment = workOrder.appointment || { state: 'geen', response: null };
      const share = workOrder.share || { active: false };
      const response = appointment.response;
      const responseHtml = response ? `<p class="small">${response.answer === 'bevestigd' ? 'Bevestigd' : 'Ander moment gevraagd'} door <b>${esc(response.name)}</b> op ${esc(dateTime(response.at))}${response.current ? '' : ' <span class="muted">(voor een eerder moment)</span>'}${response.reason ? `<br><span class="quote-reason">“${esc(response.reason)}”</span>` : ''}</p>` : '';
      const stats = [share.sharedAt ? `Link gemaakt ${esc(dateTime(share.sharedAt))}` : '', share.sentAt ? `verstuurd naar <b>${esc(share.sentTo)}</b> op ${esc(dateTime(share.sentAt))}` : '',
        share.active ? (share.viewedAt ? `geopend ${esc(dateTime(share.viewedAt))}` : 'nog niet geopend') : ''].filter(Boolean).join(' · ');
      const planned = Boolean(workOrder.data.plannedDate);
      box.innerHTML = `<h4>Afspraak met de klant ${apptPill(appointment)}</h4>${responseHtml}
        ${share.active && share.url ? `<div class="link-row"><input id="ap-url" readonly value="${esc(share.url)}" aria-label="Link naar de afspraak">
          <button class="btn small" data-ap="copy">Kopiëren</button><button class="btn small" data-ap="preview" title="Openen zoals de klant hem ziet">Openen</button></div>` : ''}
        ${state.planning ? `<div class="actions">${planned ? `<button class="btn small primary" data-ap="send">${share.sentAt || response ? 'Opnieuw naar de klant' : 'Afspraak naar de klant'}</button>` : '<span class="muted small">Plan eerst een datum in; daarna kan de klant de afspraak via een link bevestigen.</span>'}
          ${share.active ? '<button class="btn small" data-ap="revoke">Link intrekken</button>' : ''}</div>` : ''}
        ${stats ? `<p class="muted small">${stats}</p>` : ''}`;
    }

    /**
     * Voert een knop uit het blok Afspraak uit.
     * @param {string} action 'copy', 'preview', 'revoke' of 'send'
     * @returns {Promise<void>}
     */
    async function apptAction(action) {
      const workOrder = state.workOrder;
      try {
        if (action === 'copy') {
          const input = $('#ap-url');
          try { await navigator.clipboard.writeText(input.value); } catch (error) { input.select(); document.execCommand('copy'); }
          toast('Link gekopieerd');
        } else if (action === 'preview') {
          window.open(`${workOrder.share.url}&voorbeeld=1`, '_blank', 'noopener');
        } else if (action === 'revoke') {
          if (!confirm('De link intrekken? De klant kan de afspraak dan niet meer openen; een nieuwe link is een ander adres.')) return;
          applyAppt(await api(`workorders/${encodeURIComponent(workOrder.id)}/share`, { method: 'DELETE' }));
          toast('Link ingetrokken');
        } else if (action === 'send') {
          await save();
          openApptSend();
        }
      } catch (error) {
        toast(error.message, true);
      }
    }

    /**
     * Neemt link en afspraak van de server over en toont het blok opnieuw.
     * @param {object} serverWorkOrder de werkorder zoals de server hem teruggeeft
     */
    function applyAppt(serverWorkOrder) {
      if (!state.workOrder || serverWorkOrder.id !== state.workOrder.id) return;
      state.workOrder.share = serverWorkOrder.share;
      state.workOrder.appointment = serverWorkOrder.appointment;
      renderAppt();
    }

    /**
     * Formatteert een datum voluit met weekdag.
     * @param {string} iso datum in ISO-formaat
     * @returns {string} bijv. 'dinsdag 3 november 2026'
     */
    const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    /**
     * Beschrijft het geplande moment van de werkorder in gewone taal.
     * @param {object} data gegevens van de werkorder
     * @returns {string} datum, tijd en eventueel het aantal werkdagen
     */
    const momentLine = (data) => {
      const days = WorkOrderCore.workDays(data.plannedDate, data.days);
      return `${longDate(data.plannedDate)}${data.startTime ? `, ${data.startTime}${data.endTime ? `–${data.endTime}` : ''} uur` : ''}${days.length > 1 ? ` (${days.length} werkdagen, t/m ${longDate(days[days.length - 1])})` : ''}`;
    };

    /** Opent het venster om de afspraak naar de klant te sturen, met een voorgestelde tekst. */
    function openApptSend() {
      const workOrder = state.workOrder;
      const data = workOrder.data;
      const profile = state.profile || {};
      $('#as-to').value = data.customer.email || '';
      $('#as-subject').value = `Afspraak ${data.title ? `${data.title.toLowerCase()} ` : ''}op ${longDate(data.plannedDate)}`;
      $('#as-message').value = [
        `Beste ${data.customer.contact || data.customer.name || 'klant'},`,
        `Wij hebben de werkzaamheden${data.title ? ` (${data.title})` : ''} ingepland op ${momentLine(data)}${data.customer.address ? `, op ${data.customer.address.replace(/\n/g, ', ')}` : ''}.`,
        'Wilt u via de knop hieronder laten weten of dit moment u past? Komt het niet goed uit, dan kunt u daar ook een ander moment voorstellen.',
        `Met vriendelijke groet,\n${profile.companyName || ''}`,
      ].join('\n\n');
      $('#as-err').textContent = '';
      $('#as-send').hidden = !state.mail;
      $('#appt-send').hidden = false;
      $('#as-to').focus();
    }

    /**
     * Maakt de klantlink als die er nog niet is.
     * @returns {Promise<string>} het adres van de link
     */
    async function ensureShare() {
      const workOrder = state.workOrder;
      if (!workOrder.share || !workOrder.share.active || !workOrder.share.url) applyAppt(await api(`workorders/${encodeURIComponent(workOrder.id)}/share`, { method: 'POST', body: { url: shareBase() } }));
      return workOrder.share.url;
    }

    /** Koppelt de knoppen van het blok Afspraak en van het verstuurvenster. */
    function bindApptSend() {
      $('#e-appt').addEventListener('click', (event) => {
        const button = event.target.closest('[data-ap]');
        if (button) apptAction(button.dataset.ap);
      });
      /**
       * Verstuurt de afspraak per e-mail via de server.
       * @returns {Promise<void>}
       */
      $('#as-send').onclick = async () => {
        const workOrder = state.workOrder;
        const button = $('#as-send');
        button.disabled = true;
        try {
          applyAppt(await api(`workorders/${encodeURIComponent(workOrder.id)}/send`, {
            method: 'POST', body: { to: $('#as-to').value, subject: $('#as-subject').value, message: $('#as-message').value, url: shareBase() },
          }));
          $('#appt-send').hidden = true;
          toast(`Afspraak verstuurd naar ${$('#as-to').value}`);
        } catch (error) {
          if (error.code === 'not_configured') { state.mail = false; $('#as-send').hidden = true; }
          $('#as-err').textContent = error.message;
        } finally {
          button.disabled = false;
        }
      };
      /**
       * Maakt zonder eigen mailserver de link en opent het bericht in het eigen mailprogramma.
       * @returns {Promise<void>}
       */
      $('#as-mailto').onclick = async () => {
        try {
          const url = await ensureShare();
          const body = `${$('#as-message').value}\n\nAfspraak bekijken en bevestigen:\n${url}`;
          location.href = `mailto:${encodeURIComponent($('#as-to').value.trim()).replace(/%40/g, '@').replace(/%2C/g, ',')}?subject=${encodeURIComponent($('#as-subject').value)}&body=${encodeURIComponent(body)}`;
          $('#appt-send').hidden = true;
        } catch (error) {
          $('#as-err').textContent = error.message;
        }
      };
      /**
       * Maakt de link en kopieert die.
       * @returns {Promise<void>}
       */
      $('#as-copy').onclick = async () => {
        try {
          const url = await ensureShare();
          try { await navigator.clipboard.writeText(url); } catch (error) { /* link staat ook in de werkorder */ }
          $('#appt-send').hidden = true;
          toast('Link gemaakt en gekopieerd');
        } catch (error) {
          $('#as-err').textContent = error.message;
        }
      };
    }

    return { renderAppt, applyAppt, bindApptSend };
  };
})();
