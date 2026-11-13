// Beheer > Systeem > Back-ups naar Google Drive: Google-app invullen, verbinden, automatisch kopiëren aan/uit, handmatig
// uploaden, de bestanden op Drive en het logboek. API /api/admin/backups/drive, zie backend/src/platform/drive-backup.js.
(function () {
  /**
   * Zoekt een element op id.
   * @param {string} id Het id.
   * @returns {HTMLElement|null} Het element.
   */
  const byId = (id) => document.getElementById(id);
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
  /**
   * Formatteert een bestandsgrootte.
   * @param {number} bytes Aantal bytes.
   * @returns {string} Bijv. "12,5 MB".
   */
  const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} MB` : `${Math.round(bytes / 1024).toLocaleString('nl-NL')} kB`);

  const REASONS = {
    geweigerd: 'Je hebt de toegang in Google geweigerd.',
    fout: 'Verbinden is mislukt.',
  };
  let lastStatus = null;

  /**
   * Roept de Drive-API aan.
   * @param {string} path Pad na api/admin/backups/drive.
   * @param {object} [options] Methode en body (object).
   * @returns {Promise<object>} Het antwoord; gooit een fout met de melding van de server.
   */
  async function call(path, options = {}) {
    const response = await fetch(`../api/admin/backups/drive${path}`, {
      cache: 'no-store',
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : (options.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined),
      body: options.body ? JSON.stringify(options.body) : (options.method === 'POST' ? '{}' : undefined),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || window.AquatechCommon.statusMessage(response.status));
    return body;
  }

  /**
   * Toont een melding onder de knoppen.
   * @param {string} text De melding.
   * @param {boolean} [isError] Als fout tonen.
   */
  function say(text, isError = false) {
    const element = byId('d-msg');
    element.textContent = text;
    element.className = isError ? 'err small' : 'muted small';
  }

  /**
   * Tekent het formulier, de knoppen en de lijsten met de stand van de server.
   * @param {object} status Het antwoord van GET /api/admin/backups/drive.
   */
  function render(status) {
    lastStatus = status;
    const form = byId('s-backup-drive');
    const { config } = status;
    for (const name of ['clientId', 'folderName', 'keepCount']) form.elements[name].value = config[name] == null ? '' : config[name];
    form.elements.redirectUri.value = config.redirectUri || status.suggestedRedirect || '';
    form.elements.enabled.checked = Boolean(config.enabled);
    form.elements.clientSecret.value = '';
    byId('d-secret-set').textContent = status.secretSet ? '(ingesteld)' : '';
    const locked = status.connected;
    for (const name of ['clientId', 'clientSecret', 'redirectUri']) form.elements[name].disabled = locked;
    byId('d-connect').hidden = status.connected;
    byId('d-connect').disabled = !status.configured;
    for (const id of ['d-sync', 'd-test', 'd-disconnect']) byId(id).hidden = !status.connected;
    byId('d-sync').disabled = status.running;
    form.elements.enabled.disabled = !status.connected;
    byId('d-state').textContent = status.connected
      ? `Verbonden met ${status.account || 'Google Drive'}. Laatste geslaagde upload: ${when(status.lastOkAt)}.`
      : (status.configured ? 'Niet verbonden. Klik op Verbinden met Google Drive.' : 'Niet verbonden. Vul eerst de gegevens van de Google-app in en sla op.');
    const warn = byId('d-warn');
    const warnings = [];
    if (status.needsReconnect) warnings.push('Google heeft de toegang ingetrokken of laten verlopen. Verbind opnieuw om weer te kopiëren.');
    else if (status.stale) warnings.push(`Er is al meer dan 36 uur geen back-up naar Drive gekopieerd (laatste: ${when(status.lastOkAt)}). Bekijk het logboek.`);
    warn.hidden = !warnings.length;
    warn.textContent = warnings.join(' ');
    const events = status.events || [];
    byId('d-events').innerHTML = events.length
      ? `<ul class="timeline">${events.map((event) => `<li>${esc(when(event.at))} · ${event.ok ? 'gelukt' : 'mislukt'} · ${esc(event.source || '')} · ${esc(event.message)}</li>`).join('')}</ul>`
      : 'Nog niets gebeurd.';
    renderRemote(status);
  }

  /**
   * Tekent de lijst met bestanden die op Drive staan (alleen als de server die heeft meegestuurd).
   * @param {object} status De stand met eventueel `remote` of `remoteError`.
   */
  function renderRemote(status) {
    const element = byId('d-remote');
    if (!status.connected) { element.textContent = 'Niet verbonden.'; return; }
    if (status.remoteError) { element.textContent = `Kan Drive niet lezen: ${status.remoteError}`; return; }
    const files = status.remote || [];
    element.innerHTML = files.length
      ? `<ul class="timeline">${files.map((file) => `<li>${esc(file.name)} · ${esc(when(file.createdTime || file.at))} · ${esc(size(Number(file.size) || 0))}</li>`).join('')}</ul>`
      : 'Nog geen bestanden op Drive.';
  }

  /**
   * Haalt de stand op (met de bestanden op Drive) en tekent hem; bij terugkeer uit Google toont het de uitkomst.
   * @returns {Promise<void>}
   */
  async function load() {
    try {
      render(await call('?remote=1'));
    } catch (error) {
      say(`Kan Google Drive niet laden: ${error.message}`, true);
      return;
    }
    const params = new URLSearchParams(location.search);
    const result = params.get('drive');
    if (result) {
      if (result === 'verbonden') say('Verbonden met Google Drive. De eerste upload loopt op de achtergrond.');
      else say(`${REASONS[result] || 'Verbinden is mislukt.'}${params.get('reden') ? ` (${params.get('reden')})` : ''}`, true);
      history.replaceState(null, '', `${location.pathname}${location.hash}`);
    }
  }

  /**
   * Voert een knopactie uit: knop uit, melding tonen, daarna de stand verversen.
   * @param {HTMLButtonElement} button De knop.
   * @param {Function} action De actie; geeft eventueel een melding terug.
   * @returns {Promise<void>}
   */
  async function run(button, action) {
    button.disabled = true;
    say('Bezig…');
    try {
      const message = await action();
      await load();
      if (message) say(message, false);
    } catch (error) {
      say(error.message, true);
      button.disabled = false;
    }
  }

  /** Koppelt de formulierknoppen één keer. */
  function init() {
    const form = byId('s-backup-drive');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = {
        clientId: form.elements.clientId.value.trim(),
        redirectUri: form.elements.redirectUri.value.trim(),
        folderName: form.elements.folderName.value.trim(),
        keepCount: Number(form.elements.keepCount.value),
        enabled: form.elements.enabled.checked,
      };
      const secret = form.elements.clientSecret.value.trim();
      if (secret) body.clientSecret = secret;
      await run(form.querySelector('[type=submit]'), async () => { await call('', { method: 'PUT', body }); return 'Opgeslagen.'; });
      form.querySelector('[type=submit]').disabled = false;
    });
    byId('d-connect').addEventListener('click', (event) => run(event.currentTarget, async () => {
      const { url } = await call('/connect', { method: 'POST' });
      location.href = url;
      return 'Je gaat naar Google…';
    }));
    byId('d-sync').addEventListener('click', (event) => run(event.currentTarget, async () => {
      const out = await call('/sync', { method: 'POST' });
      return out.error ? `Mislukt: ${out.error}` : `Klaar: ${out.uploaded.length} geüpload, ${out.removed.length} opgeruimd op Drive.`;
    }));
    byId('d-test').addEventListener('click', (event) => run(event.currentTarget, async () => (await call('/test', { method: 'POST' })).message));
    byId('d-disconnect').addEventListener('click', (event) => {
      if (!confirm('Verbinding met Google Drive verbreken?\n\nDe bestanden op Drive blijven staan; er wordt niets meer gekopieerd.')) return;
      run(event.currentTarget, async () => { await call('/disconnect', { method: 'POST' }); return 'Verbinding verbroken.'; });
    });
  }

  init();
  window.BeheerDrive = { load, status: () => lastStatus };
})();
