// Offertes: delen en versturen van een offerte: klantlink, versturen per mail, mailto-terugval en het bijwerken van de offerte met het serverantwoord.
// Het bestand zet een fabriek op window.Offertes; offertes.js geeft de gedeelde
// hulpfuncties en de stand (context) mee en gebruikt wat de fabriek teruggeeft.
(function () {
  window.Offertes = window.Offertes || {};

  /**
   * Bouwt de functies voor delen en versturen van een offerte: klantlink, versturen per mail, mailto-terugval en het bijwerken van de offerte met het serverantwoord.
   * @param {object} context gedeelde hulpfuncties en stand uit offertes.js: esc, date, QuoteView, state, toast, api, locked, save, $
   * @returns {object} de functies die offertes.js zelf nodig heeft: renderShare, shareAction, shareBase, sendQuote
   */
  window.Offertes.createShare = function (context) {
    const { esc, date, QuoteView, state, toast, api, locked, save, $ } = context;

    /** Toont het blok met de klantlink: link maken, kopiëren, versturen en intrekken. */
    function renderShare() {
      const quote = state.quote;
      const share = quote.share || {};
      const body = $('#sh-body');
      const answered = locked();
      if (!share.active) {
        // Verstuurd zonder link (bijv. alleen via het klantaccount): zeggen
        // waarom er geen adres staat.
        const noLink = quote.status !== 'concept' ? '<p class="notice warn small">Deze offerte heeft nog geen klantlink. Maak er een om de offerte zelf te openen zoals de klant hem ziet, of om het adres te delen.</p>' : '';
        body.innerHTML = `${noLink}<p class="muted small">Maak een link waarmee de klant de offerte online bekijkt, eventuele opties kiest en digitaal akkoord geeft met naam, handtekening en akkoord op de voorwaarden. Tijdstip en IP-adres worden vastgelegd${state.mail ? ' en de klant krijgt een bevestiging per e-mail' : ''}.</p>
          <div class="actions">${answered ? '' : `<button class="btn primary" data-sh="send">Versturen per e-mail</button>`}
          <button class="btn" data-sh="create">Link maken</button></div>
          ${quote.status === 'concept' && !answered ? '<p class="muted small">Met de link gaat de status naar <b>Verzonden</b>.</p>' : ''}`;
        return;
      }
      const stats = [
        share.sharedAt ? `Link gemaakt ${esc(QuoteView.dateTime(share.sharedAt))}` : '',
        share.sentAt ? `verstuurd naar <b>${esc(share.sentTo)}</b> op ${esc(QuoteView.dateTime(share.sentAt))}` : '',
        share.viewCount ? `<b>${share.viewCount}× bekeken</b>, eerst ${esc(QuoteView.dateTime(share.viewedAt))}${share.viewCount > 1 ? `, laatst ${esc(QuoteView.dateTime(share.lastViewedAt))}` : ''}` : 'nog niet bekeken',
      ].filter(Boolean).join(' · ');
      body.innerHTML = `
        <label class="link-label" for="sh-url">Klantlink <span class="muted">(dit adres krijgt de klant${share.sentTo ? ' in de e-mail' : ''})</span></label>
        <div class="link-row">
          <input id="sh-url" readonly value="${esc(share.url || '')}" aria-label="Link naar de digitale offerte">
          <button class="btn" data-sh="copy">Kopiëren</button>
          <button class="btn" data-sh="preview" title="Openen zoals de klant hem ziet; telt niet als bekeken door de klant">Openen</button>
        </div>
        <div class="actions">
          ${answered ? '' : '<button class="btn primary" data-sh="send">Versturen per e-mail</button>'}
          <button class="btn" data-sh="revoke">Link intrekken</button>
        </div>
        <p class="stats-line">${stats}</p>`;
    }

    /**
     * Voert een knop uit het blok met de klantlink uit.
     * @param {string} action 'create', 'copy', 'preview', 'revoke' of 'send'
     * @returns {Promise<void>}
     */
    async function shareAction(action) {
      const quote = state.quote;
      if (!quote) return;
      try {
        if (action === 'create') {
          await save();
          applyServer(await api(`quotes/${encodeURIComponent(quote.id)}/share`, { method: 'POST', body: { url: shareBase() } }));
          toast('Link gemaakt');
        } else if (action === 'copy') {
          const input = $('#sh-url');
          try { await navigator.clipboard.writeText(input.value); } catch (error) { input.select(); document.execCommand('copy'); }
          toast('Link gekopieerd');
        } else if (action === 'preview') {
          // Voorbeeld: telt niet als "bekeken" door de klant.
          window.open(`${quote.share.url}&voorbeeld=1`, '_blank', 'noopener');
        } else if (action === 'revoke') {
          if (!confirm('De link intrekken? De klant kan de offerte dan niet meer openen; een nieuwe link is daarna een ander adres.')) return;
          applyServer(await api(`quotes/${encodeURIComponent(quote.id)}/share`, { method: 'DELETE' }));
          toast('Link ingetrokken');
        } else if (action === 'send') {
          await save();
          openSend();
        }
      } catch (error) {
        toast(error.message, true);
      }
    }

    /**
     * Geeft het adres van de openbare offertepagina; volgt uit waar deze module draait (ook achter een padprefix), de server kent dat zelf niet.
     * @returns {string} absolute URL van openbaar/offerte.html
     */
    const shareBase = () => new URL('../openbaar/offerte.html', location.href).href;

    /**
     * Neemt status, link en akkoord van de server over zonder de invoer opnieuw op te bouwen.
     * @param {object} serverQuote de offerte zoals de server hem teruggeeft
     */
    function applyServer(serverQuote) {
      const quote = state.quote;
      if (!quote || serverQuote.id !== quote.id) return;
      quote.status = serverQuote.status;
      quote.share = serverQuote.share;
      quote.acceptance = serverQuote.acceptance;
      $('#e-status').value = quote.status;
      renderShare();
    }

    /** Opent het venster om de offerte per e-mail te versturen, met een voorgestelde tekst. */
    function openSend() {
      const quote = state.quote;
      const data = quote.data;
      const profile = state.profile;
      const form = $('#sf');
      form.to.value = data.customer.email || '';
      const link = $('#sf-link');
      link.hidden = !(quote.share && quote.share.url);
      link.innerHTML = link.hidden ? '' : `Link in de e-mail: <a href="${esc(`${quote.share.url}&voorbeeld=1`)}" target="_blank" rel="noopener">${esc(quote.share.url)}</a>`;
      const lang = window.DocText.clean(data.language);
      /**
       * Een vaste tekst in de documenttaal van de offerte.
       * @param {string} key Sleutel uit DocText.
       * @param {object} [values] Waarden voor {naam}.
       * @returns {string} De tekst.
       */
      const translate = (key, values) => window.DocText.text(lang, key, values);
      form.subject.value = `${translate('quote.title')} ${quote.number}${data.title ? ` – ${data.title}` : ''}`;
      form.message.value = [
        translate('mail.greeting', { name: data.customer.contact || data.customer.name || translate('mail.customer') }),
        translate('mail.quoteBody', { number: quote.number, about: data.title ? translate('mail.quoteAboutLower', { title: data.title.toLowerCase() }) : '', date: QuoteView.date(data.validUntil, lang) }),
        translate('mail.quoteQuestions'),
        `${translate('mail.closing')}\n${profile.companyName || ''}`,
      ].join('\n\n');
      $('#send').hidden = false;
      form.to.focus();
    }

    /**
     * Verstuurt de offerte per e-mail via de server (of via het eigen mailprogramma zonder mailserver).
     * @param {SubmitEvent} event het verzenden van het formulier
     * @returns {Promise<void>}
     */
    async function sendQuote(event) {
      event.preventDefault();
      const quote = state.quote;
      const form = $('#sf');
      const submitButton = form.querySelector('[type=submit]');
      if (!state.mail) return mailtoFallback();
      submitButton.disabled = true;
      try {
        applyServer(await api(`quotes/${encodeURIComponent(quote.id)}/send`, {
          method: 'POST', body: { to: form.to.value, subject: form.subject.value, message: form.message.value, url: shareBase() },
        }));
        $('#send').hidden = true;
        toast(`Offerte verstuurd naar ${form.to.value}`);
      } catch (error) {
        if (error.code === 'not_configured') { state.mail = false; return mailtoFallback(); }
        toast(error.message, true);
      } finally {
        submitButton.disabled = false;
      }
    }

    /**
     * Maakt zonder eigen mailserver de link en opent het bericht in het eigen mailprogramma.
     * @returns {Promise<void>}
     */
    async function mailtoFallback() {
      const quote = state.quote;
      const form = $('#sf');
      try {
        if (!quote.share || !quote.share.active) applyServer(await api(`quotes/${encodeURIComponent(quote.id)}/share`, { method: 'POST', body: { url: shareBase() } }));
        const body = `${form.message.value}\n\nOfferte bekijken en accorderen:\n${quote.share.url}`;
        location.href = `mailto:${encodeURIComponent(form.to.value.trim()).replace(/%40/g, '@').replace(/%2C/g, ',')}?subject=${encodeURIComponent(form.subject.value)}&body=${encodeURIComponent(body)}`;
        $('#send').hidden = true;
        toast('Er is geen mailserver ingesteld; het bericht staat klaar in je mailprogramma');
      } catch (error) {
        toast(error.message, true);
      }
    }

    return { renderShare, shareAction, shareBase, sendQuote };
  };
})();
