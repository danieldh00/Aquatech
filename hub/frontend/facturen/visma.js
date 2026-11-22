// Facturen: de koppeling met Visma eAccounting (Facturen > Visma): verbinden, app-gegevens, bediening, overzicht en logboek.
// Het bestand zet een fabriek op window.Facturen; facturen.js geeft de gedeelde hulpfuncties en de stand (context) mee
// en gebruikt de drie functies die de fabriek teruggeeft.
(function () {
  window.Facturen = window.Facturen || {};

  /**
   * Bouwt de functies van het Visma-scherm.
   * @param {object} context gedeelde hulpfuncties en stand uit facturen.js: InvoiceCore, state, api, toast, esc, day, when, warn, load, $
   * @returns {object} de functies die facturen.js zelf nodig heeft: loadVisma, setupVisma, vismaReturn
   */
  window.Facturen.createVisma = function (context) {
    const { InvoiceCore, state, api, toast, esc, day, when, warn, load, $ } = context;

    const ENVS = { sandbox: 'sandbox', production: 'productie' };

    /**
     * Laadt de stand van de Visma-koppeling.
     * @param {boolean} withOptions true om ook de artikelen en termijnen uit Visma op te halen
     * @returns {Promise<void>}
     */
    async function loadVisma(withOptions = false) {
      const [status, appData] = await Promise.all([api('visma'), api('visma/app')]);
      state.visma = status;
      renderVismaApp(appData);
      renderVisma();
      loadVismaLog(true).catch((error) => toast(error.message, true));
      if (withOptions && state.visma.connected && !state.vismaOptions) await loadVismaOptions();
    }

    /**
     * Haalt een pagina van het Visma-logboek op: de eerste (nieuwste) of de volgende.
     * @param {boolean} reset true om opnieuw te beginnen, false voor de volgende pagina
     * @returns {Promise<void>}
     */
    async function loadVismaLog(reset) {
      const log = state.vismaLog;
      if (log.loading && !reset) return;
      const query = new URLSearchParams({ limit: '50' });
      if (log.onlyErrors) query.set('errors', '1');
      if (!reset && log.next) query.set('before', log.next);
      // Elk verzoek krijgt een volgnummer: een verouderd antwoord (bijv. van Meer laden na het aanzetten van het filter) wordt weggegooid.
      const requestId = (log.requestId || 0) + 1;
      log.requestId = requestId;
      log.loading = true;
      try {
        const page = await api(`visma/log?${query}`);
        if (requestId !== log.requestId) return;
        log.items = reset ? page.items : log.items.concat(page.items);
        log.next = page.next;
        renderVismaLog();
      } finally {
        if (requestId === log.requestId) log.loading = false;
      }
    }

    const LOG_KINDS = { verbonden: 'Verbonden', verbroken: 'Verbroken', klant: 'Klant', factuur: 'Factuur', opties: 'Artikelen en termijnen', aanmelding: 'Aanmelding', instelling: 'Bediening' };
    const LOG_DIRECTIONS = { naar: 'Aquatech → Visma', van: 'Visma → Aquatech' };
    /**
     * Zegt wanneer een onderdeel van de koppeling gebeurt.
     * @param {string} key sleutel van het onderdeel (customers, invoices, options of company)
     * @param {object} settings de Visma-instellingen (autoSync en since)
     * @returns {string} de uitleg
     */
    function partWhen(key, settings) {
      if (key === 'customers') return 'Bij de eerste factuur van de debiteur.';
      if (key === 'options') return 'Als je dit scherm opent of op Artikelen opnieuw ophalen klikt.';
      if (key === 'company') return 'Bij het verbinden.';
      if (!settings.autoSync) return 'Alleen met de knop Nu doorsturen of de knop op een factuur.';
      return `Vanzelf zodra een factuur definitief is (en elke 10 minuten als vangnet)${settings.since ? `, vanaf factuurdatum ${day(settings.since)}` : ''}; ook met de knop.`;
    }

    /** Toont de bediening: pauzeren of hervatten en welke onderdelen aan staan. */
    function renderVismaControls() {
      const visma = state.visma;
      $('#vi-controls').hidden = !(visma && visma.connected);
      if (!visma || !visma.connected) return;
      const settings = visma.settings;
      $('#vi-controls-state').textContent = settings.paused
        ? 'De koppeling staat op pauze: er gaat niets naar Visma, ook niet met de knop Nu doorsturen.'
        : 'De koppeling is actief.';
      $('#vi-pause').textContent = settings.paused ? 'Hervatten' : 'Pauzeren';
      $('#vi-pause').classList.toggle('primary', Boolean(settings.paused));
      $('#vi-controls').querySelectorAll('[data-part]').forEach((checkbox) => { checkbox.checked = settings.parts[checkbox.dataset.part] !== false; });
    }

    /** Wachtrij van de bediening: wijzigingen gaan één voor één naar de server. */
    let vismaControlsQueue = Promise.resolve();

    /**
     * Slaat een wijziging van de bediening op en ververst de stand en het logboek.
     * @param {object|Function} build paused (boolean) en/of parts (object met booleans), of een functie die dat object maakt
     *   op het moment dat het verzoek aan de beurt is (zodat een wisselknop de actuele stand gebruikt)
     * @returns {Promise<void>}
     */
    function saveVismaControls(build) {
      // Na elkaar versturen: een ouder antwoord mag de vinkjes niet terugzetten naar een verouderde stand.
      const run = vismaControlsQueue.then(async () => {
        try {
          const change = typeof build === 'function' ? build() : build;
          state.visma = await api('visma/controls', { method: 'PUT', body: change });
          renderVisma();
          loadVismaLog(true).catch(() => {});
        } catch (error) {
          toast(error.message, true);
          renderVismaControls();
        }
      });
      vismaControlsQueue = run.catch(() => {});
      return run;
    }

    /** Toont de toestemmingen en de onderdelen van de koppeling in gewone taal. */
    function renderVismaOverview() {
      const visma = state.visma;
      const overview = visma && visma.overview;
      $('#vi-overview').hidden = !overview;
      if (!overview) return;
      $('#vi-scopes-title').textContent = visma.connected ? 'Toestemmingen die Visma gaf' : 'Toestemmingen die bij het verbinden worden gevraagd';
      $('#vi-scopes').innerHTML = overview.scopes.map((scope) => `<li><b>${esc(scope.title)}</b> <span class="code">${esc(scope.key)}</span><span class="sub">${esc(scope.text)}</span></li>`).join('');
      $('#vi-parts').innerHTML = `<thead><tr><th>Onderdeel</th><th>Wat gebeurt er</th></tr></thead><tbody>${
        overview.parts.map((part) => `<tr><td><b>${esc(part.title)}</b><span class="sub">${esc(LOG_DIRECTIONS[part.direction])}</span></td><td class="wrap">${esc(part.text)}<span class="sub">${esc(partWhen(part.key, visma.settings))}</span></td></tr>`).join('')}</tbody>`;
      $('#vi-notdone').textContent = overview.notDone;
    }

    /** Toont de geladen regels van het Visma-logboek. */
    function renderVismaLog() {
      const log = state.vismaLog;
      $('#vi-logcard').hidden = !(state.visma && state.visma.configured);
      $('#vi-log-empty').hidden = log.items.length > 0;
      $('#vi-log-empty').textContent = log.onlyErrors ? 'Geen fouten in het logboek.' : 'Nog niets in het logboek.';
      $('#vi-log').innerHTML = log.items.length ? `<thead><tr><th>Wanneer</th><th>Wat</th><th>Uitkomst</th></tr></thead><tbody>${log.items.map((entry) => `<tr>
        <td class="nowrap">${esc(when(entry.at))}${entry.count > 1 ? `<span class="sub">laatst ${esc(when(entry.lastAt))}</span>` : ''}</td>
        <td><b>${esc(LOG_KINDS[entry.kind] || entry.kind)}</b>${entry.reference ? ` ${esc(entry.reference)}` : ''}<span class="sub">${esc(LOG_DIRECTIONS[entry.direction] || '')}${entry.direction ? ' · ' : ''}${entry.source === 'handmatig' ? `handmatig${entry.actor ? ` door ${esc(entry.actor)}` : ''}` : 'automatisch'}</span></td>
        <td class="wrap">${entry.ok ? '<span class="pill ok">gelukt</span>' : '<span class="pill overdue">fout</span>'} ${esc(entry.message)}${entry.count > 1 ? ` <span class="muted">(${esc(entry.count)}×)</span>` : ''}</td>
      </tr>`).join('')}</tbody>` : '';
      $('#vi-log-more').hidden = !log.next;
    }

    /**
     * Haalt de artikelen en betalingstermijnen uit Visma op.
     * @returns {Promise<void>}
     */
    async function loadVismaOptions() {
      try {
        state.vismaOptions = await api('visma/options');
      } catch (error) {
        state.vismaOptions = null;
        $('.err', $('#vi-form')).textContent = error.message;
        return;
      }
      renderVismaForm();
    }

    /**
     * Vult het formulier met de app-gegevens van Visma (het secret zelf komt nooit terug).
     * @param {{ app: object, secretSet: boolean, defaultRedirect: string }} data Het antwoord van de server.
     */
    function renderVismaApp(data) {
      const formElement = $('#vi-app');
      formElement.clientId.value = data.app.clientId || '';
      formElement.environment.value = data.app.environment || 'sandbox';
      formElement.redirectUri.value = data.app.redirectUri || data.defaultRedirect;
      formElement.clientSecret.value = '';
      formElement.clientSecret.placeholder = data.secretSet ? 'Ingevuld; laat leeg om te behouden' : 'Nog niet ingevuld';
      formElement.clearSecret.checked = false;
      $('#vi-app-clear').hidden = !data.secretSet;
      $('#vi-app-hint').textContent = `Registreer precies deze redirect URI bij Visma (standaard ${data.defaultRedirect}). Andere adressen moeten met https beginnen en op /api/visma/callback eindigen.`;
    }

    /** Toont de stand van de Visma-koppeling en de knoppen die erbij horen. */
    function renderVisma() {
      const visma = state.visma;
      if (!visma) return;
      const settings = visma.settings;
      let html;
      if (!visma.configured) html = '<p class="notice warn">Vul hieronder de app-gegevens van Visma in. Daarna kun je hier je administratie verbinden.</p>';
      else if (!visma.connected) html = `<p>Nog niet verbonden. Met <b>Verbinden met Visma</b> log je in bij Visma (${esc(ENVS[visma.environment])}) en kies je de administratie.</p>`;
      else {
        html = `<p><span class="pill st-betaald">Verbonden</span>${settings.paused ? ' <span class="pill overdue">Gepauzeerd</span>' : ''} ${esc(settings.companyName || 'Visma-administratie')}${settings.environment === 'sandbox' ? ' <span class="pill">sandbox</span>' : ''}`
          + `${settings.connectedAt ? ` <span class="muted small">sinds ${esc(when(settings.connectedAt))}${settings.connectedBy ? ` door ${esc(settings.connectedBy)}` : ''}</span>` : ''}</p>`
          + `<p class="muted small">${settings.autoSync ? 'Automatisch doorsturen staat aan' : 'Automatisch doorsturen staat uit; gebruik <b>Nu doorsturen</b> of de knop op een factuur'}${settings.since ? `, facturen vanaf ${esc(day(settings.since))}` : ''}. `
          + `${visma.pending ? `<b>${esc(visma.pending)}</b> ${visma.pending === 1 ? 'factuur wacht' : 'facturen wachten'}${visma.failed ? `, waarvan <span class="fail">${esc(visma.failed)} met een fout</span> (zie de factuur)` : ''}.` : (visma.held ? '' : 'Alles is doorgestuurd.')}${visma.held ? ` <b>${esc(visma.held)}</b> ${visma.held === 1 ? 'factuur wacht' : 'facturen wachten'} omdat een onderdeel uit staat (zie Bediening).` : ''}</p>`;
      }
      $('#vi-status').innerHTML = html;
      $('#vi-connect').hidden = !visma.configured || visma.connected;
      $('#vi-sync').hidden = !visma.connected;
      $('#vi-sync').disabled = Boolean(settings.paused);
      renderVismaControls();
      $('#vi-disconnect').hidden = !visma.connected;
      $('#vi-form').hidden = !visma.connected;
      renderVismaOverview();
      if (visma.connected) renderVismaForm();
    }

    /** Vult het formulier met de Visma-instellingen (artikel per omzetcategorie, termijn). */
    function renderVismaForm() {
      const visma = state.visma;
      const settings = visma.settings;
      const options = state.vismaOptions || { articles: [], terms: [] };
      const formElement = $('#vi-form');
      const known = new Set(options.articles.map((article) => article.id));
      /**
       * Maakt de keuzelijst met Visma-artikelen.
       * @param {string} current het gekozen artikel
       * @returns {string} HTML met option-elementen
       */
      const articleOptions = (current) => `<option value="">– geen –</option>${options.articles.map((article) => `<option value="${esc(article.id)}"${article.id === current ? ' selected' : ''}>${esc(article.number)} · ${esc(article.name)}</option>`).join('')}`
        + (current && !known.has(current) ? `<option value="${esc(current)}" selected>(gekozen artikel${state.vismaOptions ? ' bestaat niet meer' : ''})</option>` : '');
      const categories = state.settings ? state.settings.categories : {};
      $('#vi-arts').innerHTML = `<thead><tr><th>Omzetcategorie</th><th>Grootboek (export)</th><th>Artikel in Visma</th></tr></thead><tbody>${
        Object.keys(InvoiceCore.GROUPS).flatMap((group) => InvoiceCore.VAT_RATES.map((rate) => {
          const key = InvoiceCore.catKey(group, rate);
          const category = categories[key] || {};
          return `<tr><td>${esc(category.name || key)}</td><td>${esc(category.account || '–')}</td><td><select data-k="${esc(key)}" aria-label="Artikel voor ${esc(category.name || key)}">${articleOptions(settings.articles[key])}</select></td></tr>`;
        })).join('')}</tbody>`;
      const knownTerm = options.terms.some((term) => term.id === settings.termsOfPaymentId);
      formElement.terms.innerHTML = `<option value="">– kies –</option>${options.terms.map((term) => `<option value="${esc(term.id)}"${term.id === settings.termsOfPaymentId ? ' selected' : ''}>${esc(term.name)}</option>`).join('')}`
        + (settings.termsOfPaymentId && !knownTerm ? `<option value="${esc(settings.termsOfPaymentId)}" selected>(gekozen termijn)</option>` : '');
      formElement.autoSync.checked = settings.autoSync;
      formElement.since.value = settings.since;
    }

    /** Koppelt de knoppen en het formulier van Visma. */
    function setupVisma() {
      const formElement = $('#vi-form');
      /**
       * Slaat de app-gegevens op; een andere app of omgeving betekent opnieuw verbinden.
       * @param {SubmitEvent} event het verzenden
       * @returns {Promise<void>}
       */
      $('#vi-app').onsubmit = async (event) => {
        event.preventDefault();
        const appForm = $('#vi-app');
        const errorBox = $('.err', appForm);
        errorBox.textContent = '';
        try {
          const saved = await api('visma/app', { method: 'PUT', body: {
            clientId: appForm.clientId.value.trim(), environment: appForm.environment.value, redirectUri: appForm.redirectUri.value.trim(),
            clientSecret: appForm.clientSecret.value, clearSecret: appForm.clearSecret.checked,
          } });
          renderVismaApp(saved);
          state.visma = await api('visma');
          renderVisma();
          toast('App-gegevens opgeslagen');
        } catch (error) { errorBox.textContent = error.message; }
      };
      /**
       * Start het verbinden met Visma (doorsturen naar de aanmelding).
       * @returns {Promise<void>}
       */
      $('#vi-connect').onclick = async () => {
        try {
          const result = await api('visma/connect', { method: 'POST', body: {} });
          location.href = result.url;
        } catch (error) { toast(error.message, true); }
      };
      /**
       * Verbreekt de verbinding na bevestiging.
       * @returns {Promise<void>}
       */
      $('#vi-disconnect').onclick = async () => {
        if (!confirm('De verbinding met Visma verbreken? Aquatech trekt de toegang in bij Visma en wist de tokens. Facturen gaan dan niet meer naar Visma tot je opnieuw verbindt. Wat al in Visma staat, blijft daar.')) return;
        try {
          const result = await api('visma/disconnect', { method: 'POST', body: {} });
          state.visma = result;
          state.vismaOptions = null;
          renderVisma();
          loadVismaLog(true).catch(() => {});
          if (result.revoked) toast('Verbinding verbroken en de toegang is bij Visma ingetrokken');
          else toast('Verbroken in Aquatech, maar intrekken bij Visma lukte niet: trek de toegang zo nodig zelf in via Visma.', true);
        } catch (error) { toast(error.message, true); }
      };
      /**
       * Stuurt de wachtende facturen nu naar Visma.
       * @returns {Promise<void>}
       */
      $('#vi-sync').onclick = async () => {
        const syncButton = $('#vi-sync');
        syncButton.disabled = true;
        try {
          const result = await api('visma/sync', { method: 'POST', body: {} });
          state.visma = result.status;
          renderVisma();
          const message = `${result.sent} ${result.sent === 1 ? 'factuur' : 'facturen'} naar Visma${result.failed ? `, ${result.failed} mislukt: ${result.errors[0] || ''}` : ''}`;
          toast(message, Boolean(result.failed));
          load().catch(() => {});
        } catch (error) {
          toast(error.message, true);
        } finally {
          syncButton.disabled = false;
        }
      };
      /**
       * Bediening: pauzeren of hervatten.
       * @returns {Promise<void>}
       */
      $('#vi-pause').onclick = () => saveVismaControls(() => ({ paused: !state.visma.settings.paused }));
      /**
       * Bediening: een onderdeel aan of uit.
       * @param {Event} event het wijzigen van een vinkje
       * @returns {Promise<void>|undefined}
       */
      $('#vi-controls').onchange = (event) => {
        const part = event.target.dataset && event.target.dataset.part;
        if (part) return saveVismaControls({ parts: { [part]: event.target.checked } });
        return undefined;
      };
      /**
       * Logboek: alleen fouten tonen of niet.
       * @param {Event} event het wijzigen van het vinkje
       */
      $('#vi-log-errors').onchange = (event) => { state.vismaLog.onlyErrors = event.target.checked; loadVismaLog(true).catch((error) => toast(error.message, true)); };
      /**
       * Logboek vernieuwen.
       * @returns {Promise<void>}
       */
      $('#vi-log-refresh').onclick = () => loadVismaLog(true).catch((error) => toast(error.message, true));
      /**
       * Logboek: de volgende pagina laden.
       * @returns {Promise<void>}
       */
      $('#vi-log-more').onclick = () => loadVismaLog(false).catch((error) => toast(error.message, true));
      /** Haalt de artikelen en termijnen opnieuw uit Visma. */
      $('#vi-reload').onclick = () => { state.vismaOptions = null; $('.err', formElement).textContent = ''; loadVismaOptions(); };
      /**
       * Slaat de Visma-instellingen op.
       * @param {SubmitEvent} event het verzenden
       * @returns {Promise<void>}
       */
      formElement.onsubmit = async (event) => {
        event.preventDefault();
        const errorBox = $('.err', formElement);
        errorBox.textContent = '';
        const articles = {};
        formElement.querySelectorAll('#vi-arts select').forEach((select) => { if (select.value) articles[select.dataset.k] = select.value; });
        try {
          state.visma = await api('visma/settings', { method: 'PUT', body: { articles, termsOfPaymentId: formElement.terms.value, autoSync: formElement.autoSync.checked, since: formElement.since.value } });
          renderVisma();
          toast('Visma-instellingen opgeslagen');
        } catch (error) {
          errorBox.textContent = error.message;
        }
      };
    }

    /**
     * Terug van Visma na het verbinden (?visma=…): melding, adres opschonen.
     * @param {URLSearchParams} params de querystring van de pagina
     * @returns {boolean} true als de pagina terugkwam van Visma
     */
    function vismaReturn(params) {
      const result = params.get('visma');
      if (!result) return false;
      const reasons = {
        invalid_state: 'de aanmelding was verlopen; probeer het opnieuw',
        token_failed: 'Visma weigerde de aanmelding (controleer de app-gegevens in Hoofdbeheer)',
        not_configured: 'de koppeling is nog niet ingesteld',
        unreachable: 'Visma was niet bereikbaar',
      };
      if (result === 'verbonden') toast('Verbonden met Visma');
      else if (result === 'geweigerd') toast('Verbinden met Visma is afgebroken.', true);
      else toast(`Verbinden met Visma mislukt: ${reasons[params.get('reden')] || 'onbekende fout'}.`, true);
      try { history.replaceState(null, '', './#visma'); } catch { /* file:// */ }
      return true;
    }

    return { loadVisma, setupVisma, vismaReturn };
  };
})();
