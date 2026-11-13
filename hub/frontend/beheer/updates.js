// Beheer > Systeem > Updates: welke versie draait en welke klaarstaat (met wat er nieuw is), de knop "Nu updaten"
// (met het eigen wachtwoord ter bevestiging) en automatisch bijwerken aan/uit. API /api/admin/system-update, zie
// backend/src/platform/system-update.js. Tijdens een update vraagt de pagina elke paar seconden de stand op; de server
// is dan even weg, dat is normaal.
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

  const STEP_TEXT = {
    ophalen: 'Nieuwe versie ophalen…',
    onderhoud: 'Onderhoudsmodus aan, lopende acties afronden…',
    'back-up': 'Back-up maken…',
    herstarten: 'Nieuwe versie starten…',
    controleren: 'Controleren of alles goed draait…',
    terugzetten: 'De nieuwe versie startte niet goed; terug naar de vorige versie…',
  };
  const POLL_MS = 4000;

  let pollTimer = null;
  let started = false;
  let loadedVersion = null;
  let current = null;
  // De eigen aanvraag die nog niet is afgerond: tot de host hem oppakt en afrondt blijft de pagina volgen (hoogstens 20 minuten).
  let awaiting = null;

  /**
   * Haalt de stand op bij de server.
   * @returns {Promise<object>} De stand (zie system-update.js view()).
   */
  async function fetchView() {
    const response = await fetch('api/admin/system-update', { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || window.AquatechCommon.statusMessage(response.status));
    return body;
  }

  /**
   * Is er nu iets gaande waarvoor de pagina de stand moet blijven volgen?
   * @param {object} view De stand.
   * @returns {boolean} true bij een openstaande aanvraag, een lopende uitrol of de onderhoudsmodus.
   */
  const busy = (view) => {
    const status = view.status || {};
    if (awaiting && ((status.requestId === awaiting.id && status.state !== 'bezig') || Date.now() - awaiting.at > 20 * 60 * 1000)) awaiting = null;
    return Boolean(awaiting || view.pending || status.state === 'bezig' || (view.maintenance && view.maintenance.active));
  };

  /**
   * De regel onder de versies: wat er nu gebeurt of hoe de laatste update afliep.
   * @param {object} view De stand.
   * @returns {string} De tekst.
   */
  function stateText(view) {
    const status = view.status || {};
    if (awaiting && !view.pending && status.state !== 'bezig') return 'De server pakt de update op…';
    if (view.pending) return `Update naar ${view.pending.version} aangevraagd${view.pending.by ? ` door ${view.pending.by}` : ''}. De server begint zo.`;
    if (status.state === 'bezig') return STEP_TEXT[status.step] || 'Bezig met de update…';
    if (loadedVersion && view.running !== loadedVersion) return `Bijgewerkt naar ${view.running}. Vernieuw de pagina om de nieuwe versie te gebruiken.`;
    if (status.finishedAt && ['geslaagd', 'mislukt', 'geweigerd'].includes(status.state)) {
      const label = { geslaagd: 'Laatste update geslaagd', mislukt: 'Laatste update mislukt', geweigerd: 'Laatste aanvraag niet uitgevoerd' }[status.state];
      return `${label} (${when(status.finishedAt)}${status.automatic ? ', automatisch' : ''}). ${status.message || ''}`.trim();
    }
    return view.newer ? '' : 'Je hebt de nieuwste versie.';
  }

  /**
   * Toont de releasenotes van de versies die de update meebrengt.
   * @param {object[]} releases Versies (nieuwste eerst) met title, date en items.
   * @returns {string} HTML.
   */
  function notesHtml(releases) {
    if (!releases || !releases.length) return '<p class="muted small">Geen nieuwe versie, of de releasenotes zijn er (nog) niet.</p>';
    return releases.map((release) => `<article class="up-release"><h4>${esc(release.version)} · ${esc(release.title)}${release.date ? ` <span class="muted small">(${esc(release.date)})</span>` : ''}</h4>`
      + `<ul>${release.items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></article>`).join('');
  }

  /**
   * Zet de stand op het scherm.
   * @param {object} view De stand.
   * @returns {void}
   */
  function render(view) {
    current = view;
    if (!loadedVersion) loadedVersion = view.running;
    const following = busy(view); // ruimt ook een afgeronde eigen aanvraag op, vóór de tekst hieronder
    byId('up-none').hidden = view.configured !== false;
    byId('up-main').hidden = view.configured === false;
    if (view.configured === false) return;
    byId('up-running').textContent = view.running || '–';
    byId('up-available').textContent = view.available ? `${view.available}${view.newer ? ' (nieuw)' : ''}` : '–';
    byId('up-checked').textContent = when(view.status && view.status.checkedAt);
    byId('up-state').textContent = stateText(view);
    byId('up-form').hidden = !view.newer || following;
    byId('up-pending-actions').hidden = !view.pending;
    byId('up-auto').checked = view.auto !== false;
    byId('up-notes').innerHTML = notesHtml(view.releases);
  }

  /**
   * Vraagt de stand op en plant de volgende vraag zolang er iets gaande is. Tijdens het herstarten is de server
   * even weg: dan blijft de pagina het proberen.
   * @returns {Promise<void>}
   */
  async function refresh() {
    clearTimeout(pollTimer);
    try {
      const view = await fetchView();
      byId('up-err').textContent = '';
      render(view);
      if (started && busy(view)) pollTimer = setTimeout(refresh, POLL_MS);
    } catch (error) {
      if (current && busy(current)) {
        byId('up-state').textContent = 'De server start opnieuw, even geduld…';
        if (started) pollTimer = setTimeout(refresh, POLL_MS);
      } else {
        byId('up-err').textContent = error.message;
      }
    }
  }

  /**
   * Stuurt de aanvraag "Nu updaten" met het wachtwoord.
   * @param {Event} event Het submit-event.
   * @returns {Promise<void>}
   */
  async function startUpdate(event) {
    event.preventDefault();
    const password = byId('up-password');
    byId('up-err').textContent = '';
    if (!password.value) { byId('up-err').textContent = 'Vul je wachtwoord in.'; password.focus(); return; }
    const button = byId('up-start');
    button.disabled = true;
    try {
      const response = await fetch('api/admin/system-update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: current && current.available, password: password.value }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || window.AquatechCommon.statusMessage(response.status));
      password.value = '';
      awaiting = body.pending ? { id: body.pending.id, at: Date.now() } : null;
      render(body);
      pollTimer = setTimeout(refresh, POLL_MS);
    } catch (error) {
      byId('up-err').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Trekt een aanvraag in die de server nog niet heeft opgepakt.
   * @returns {Promise<void>}
   */
  async function cancelUpdate() {
    byId('up-err').textContent = '';
    try {
      const response = await fetch('api/admin/system-update/request', { method: 'DELETE' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || window.AquatechCommon.statusMessage(response.status));
      awaiting = null;
      render(body);
    } catch (error) {
      byId('up-err').textContent = error.message;
      refresh();
    }
  }

  /**
   * Zet automatisch bijwerken aan of uit.
   * @param {Event} event Het change-event van het vinkje.
   * @returns {Promise<void>}
   */
  async function saveAuto(event) {
    const box = event.target;
    byId('up-auto-err').textContent = '';
    box.disabled = true;
    try {
      const response = await fetch('api/admin/system-update/auto', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto: box.checked }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || window.AquatechCommon.statusMessage(response.status));
      render(body);
    } catch (error) {
      box.checked = !box.checked;
      byId('up-auto-err').textContent = error.message;
    } finally {
      box.disabled = false;
    }
  }

  let bound = false;
  /**
   * Opent de sectie: knoppen koppelen (één keer) en de stand laden.
   * @returns {void}
   */
  function load() {
    if (!bound) {
      bound = true;
      byId('up-form').addEventListener('submit', startUpdate);
      byId('up-cancel').addEventListener('click', cancelUpdate);
      byId('up-auto').addEventListener('change', saveAuto);
    }
    started = true;
    refresh();
  }

  /**
   * Weg uit de sectie: niet meer opvragen.
   * @returns {void}
   */
  function stop() {
    started = false;
    clearTimeout(pollTimer);
  }

  window.BeheerUpdates = { load, stop };
})();
