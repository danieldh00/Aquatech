// Beheer > Instellingen > E-mail: mailserver (SMTP, Exchange-connector of Microsoft Graph) instellen, testmail versturen en het
// WAN-IP tonen. API /api/admin/mail en /api/admin/wan-ip, zie backend/src/verkoop/quotes.js en platform/wan-ip.js.
(function () {
  /**
   * Zoekt het eerste element dat bij de selector past.
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
  /**
   * Datum en tijd in het Nederlands.
   * @param {string|null} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "13 nov 2026 10:15", of – zonder tijdstip.
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};
  /** Het laatst opgehaalde WAN-IP van de server (null = nog niet opgehaald). */
  let wanIp = null;

  /**
   * Roept de beheer-API aan en geeft de JSON terug.
   * @param {string} path Pad na '../api/admin/'.
   * @param {RequestInit} [options] fetch-opties; `body` als object.
   * @returns {Promise<object>} Het antwoord; gooit een fout bij een foutstatus.
   */
  async function api(path, options = {}) {
    const res = await fetch(`../api/admin/${path}`, {
      cache: 'no-store',
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || window.AquatechCommon.statusMessage(res.status)), { status: res.status });
    return body;
  }

  /**
   * Laadt de e-mailinstellingen in het formulier.
   * @returns {Promise<boolean>} true als het laden lukte.
   */
  async function load() {
    const formElement = $('#s-mail');
    try {
      const result = await api('mail');
      const config = result.config;
      for (const key of ['host', 'port', 'user', 'from', 'replyTo', 'graphTenantId', 'graphClientId']) formElement[key].value = config[key] ?? '';
      formElement.mode.value = config.mode || 'smtp';
      formElement.secure.value = String(Boolean(config.secure));
      formElement.password.value = '';
      formElement.password.placeholder = result.passwordSet ? '•••••••• (ingesteld; leeg = ongewijzigd)' : '';
      formElement.graphSecret.value = '';
      formElement.graphSecret.placeholder = result.graphSecretSet ? '•••••••• (ingesteld; leeg = ongewijzigd)' : '';
      const ok = config.mode === 'graph'
        ? Boolean(config.graphTenantId && config.graphClientId && config.from && result.graphSecretSet)
        : Boolean(config.host && config.from);
      $('#m-state').textContent = ok ? 'De mailserver is ingesteld.' : 'Nog geen mailserver ingesteld.';
      $('#m-state').className = `state ${ok ? 'ok' : 'off'}`;
      mailMode();
      return true;
    } catch (error) {
      $('#m-state').textContent = `Kan de e-mailinstellingen niet laden: ${error.message}`;
      return false;
    }
  }

  /**
   * Connector: geen inlog, poort 25; het WAN-IP pas ophalen als het nodig is.
   * @param {boolean} changed true als de soort net is gewijzigd (poort en host invullen)
   */
  function mailMode(changed) {
    const formElement = $('#s-mail');
    const connector = formElement.mode.value === 'connector';
    const graph = formElement.mode.value === 'graph';
    $('[data-connector]', formElement).hidden = !connector;
    $('[data-login]', formElement).hidden = connector || graph;
    $('[data-smtp]', formElement).hidden = graph;
    $('[data-graph]', formElement).hidden = !graph;
    if (changed && !graph) {
      formElement.port.value = connector ? 25 : 587;
      formElement.secure.value = 'false';
      const domain = (formElement.from.value.match(/@([^>\s]+)/) || [])[1];
      if (connector && !formElement.host.value && domain) formElement.host.value = `${domain.replace(/\./g, '-')}.mail.protection.outlook.com`;
    }
    if (connector && !wanIp) loadWanIp(false);
  }

  /**
   * Haalt het WAN-IP van de server op en toont het.
   * @param {boolean} refresh true om niet de bewaarde waarde te gebruiken
   * @returns {Promise<void>}
   */
  async function loadWanIp(refresh) {
    const ipElement = $('#m-wanip');
    const note = $('#m-wanip-note');
    ipElement.textContent = 'Bezig…';
    try {
      wanIp = await api(`wan-ip${refresh ? '?refresh=1' : ''}`);
      ipElement.textContent = wanIp.ip;
      note.textContent = wanIp.source === 'omgeving'
        ? 'Vast ingesteld (WAN_IP in de Docker-omgeving). Dit adres geef je vrij in de connector van Office 365.'
        : `Opgezocht ${when(wanIp.checkedAt)}. Dit adres geef je vrij in de connector van Office 365.`;
    } catch (error) {
      wanIp = null;
      ipElement.textContent = 'onbekend';
      note.textContent = error.message;
    }
  }

  /**
   * Slaat de e-mailinstellingen op en laadt ze opnieuw.
   * @returns {Promise<void>}
   */
  async function saveMail() {
    const formElement = $('#s-mail');
    const connector = formElement.mode.value === 'connector';
    const graph = formElement.mode.value === 'graph';
    const body = {
      config: { graphTenantId: formElement.graphTenantId.value.trim(), graphClientId: formElement.graphClientId.value.trim(), mode: formElement.mode.value, host: formElement.host.value.trim(), port: Number(formElement.port.value) || (connector ? 25 : 587), secure: formElement.secure.value === 'true', user: connector || graph ? '' : formElement.user.value.trim(), from: formElement.from.value.trim(), replyTo: formElement.replyTo.value.trim() },
    };
    if (!connector && !graph && formElement.password.value) body.password = formElement.password.value;
    if (graph && formElement.graphSecret.value) body.graphSecret = formElement.graphSecret.value;
    await api('mail', { method: 'PUT', body });
    await load();
  }

  /**
   * Koppelt het e-mailformulier en de knoppen.
   * @returns {void}
   */
  function bindForm() {
    const formElement = $('#s-mail');
    /** Past het formulier aan de gekozen soort aan. */
    formElement.mode.onchange = () => { mailMode(true); };
    /**
     * Slaat de e-mailinstellingen op.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      $('.err', formElement).textContent = '';
      try { await saveMail(); toast('E-mailinstellingen opgeslagen'); } catch (error) { $('.err', formElement).textContent = error.message; }
    };
    /**
     * Slaat op en verstuurt een testmail.
     * @returns {Promise<void>}
     */
    $('#m-test').onclick = async () => {
      const testButton = $('#m-test');
      $('.err', formElement).textContent = '';
      testButton.disabled = true;
      try {
        await saveMail();
        await api('mail/test', { method: 'POST', body: { to: formElement.testTo.value } });
        toast(`Testmail verstuurd naar ${formElement.testTo.value}`);
      } catch (error) {
        $('.err', formElement).textContent = error.message;
      } finally {
        testButton.disabled = false;
      }
    };
    /**
     * Zoekt het WAN-IP opnieuw op.
     * @returns {Promise<void>}
     */
    $('#m-refresh').onclick = () => loadWanIp(true);
    /**
     * Kopieert het WAN-IP naar het klembord.
     * @returns {Promise<void>}
     */
    $('#m-copy').onclick = async () => {
      if (!wanIp) return;
      try { await navigator.clipboard.writeText(wanIp.ip); toast('WAN-IP gekopieerd'); } catch (error) { toast('Kopiëren lukt niet; selecteer het adres zelf', true); }
    };
  }

  window.BeheerMail = { init: (options) => { toast = options.toast; bindForm(); }, load };
})();
