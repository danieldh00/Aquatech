// Support op afstand: de gebruiker geeft een hoofdbeheerder van het platform
// tijdelijk toestemming om in live als hem mee te kijken en te helpen
// (impersonatie). Hier staat ook wie er onlangs heeft meegekeken.
(function (root) {
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst.
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15" (leeg zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  /**
   * Duur in uren of dagen.
   * @param {number} count Aantal uren.
   * @returns {string} Bijv. "8 uur" of "2 dagen".
   */
  const hours = (count) => (count % 24 === 0 ? `${count / 24} ${count === 24 ? 'dag' : 'dagen'}` : `${count} uur`);

  /**
   * Roept api/support aan.
   * @param {string} method GET, POST of DELETE.
   * @param {object} [body] JSON-body.
   * @returns {Promise<object>} Het antwoord (fout = Error met de melding van de server).
   */
  async function call(method, body) {
    const res = await fetch('api/support', {
      method, cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || `HTTP ${res.status}`);
    return out;
  }

  /**
   * Laat het blok Support op afstand zien voor een eigen account (niet voor een hoofdbeheerder of tijdens impersonatie).
   * @param {object} me Antwoord van api/me.
   * @returns {Promise<void>}
   */
  async function load(me) {
    const container = document.getElementById('support');
    if (!container || location.protocol === 'file:') return;
    if (!me || !me.user || me.user.kind !== 'account' || me.platformAdmin || me.impersonation) return;
    let data;
    try { data = await call('GET'); } catch (error) { return; }
    if (!data.applicable) return;
    render(container, data, me);
  }

  /**
   * Tekent het blok: toestemming geven of intrekken en wie er onlangs meekeek.
   * @param {HTMLElement} container Het element #support.
   * @param {object} data Antwoord van api/support.
   * @param {object} me Antwoord van api/me.
   */
  function render(container, data, me) {
    const grant = data.grant;
    const recent = (data.recent || []).slice(0, 5).map((visit) => `<li>${esc(visit.by)} · ${esc(visit.environment)} · ${esc(when(visit.startedAt))}${visit.endedAt ? ` – ${esc(when(visit.endedAt))}` : ' · <b>nu bezig</b>'}</li>`).join('');
    container.innerHTML = `
      <h2>Support op afstand</h2>
      <div class="support-card">
        <p>${grant
          ? `Support mag als jou meekijken tot <b>${esc(when(grant.expiresAt))}</b>. Intrekken stopt dat meteen.`
          : 'Heb je hulp nodig? Geef support tijdelijk toestemming om als jou in te loggen en mee te kijken. Alles wat support doet wordt vastgelegd.'}</p>
        <div class="support-actions">
          ${grant ? '' : `<select id="support-hours" aria-label="Hoe lang">${data.options.map((option) => `<option value="${option}"${option === data.defaultHours ? ' selected' : ''}>${esc(hours(option))}</option>`).join('')}</select>`}
          <button type="button" class="btn ${grant ? '' : 'primary'}" id="support-btn">${grant ? 'Toestemming intrekken' : 'Toestemming geven'}</button>
        </div>
        <div class="err" role="alert"></div>
        ${recent ? `<details class="support-recent"><summary>Wie heeft er meegekeken?</summary><ul>${recent}</ul></details>` : ''}
      </div>`;
    container.hidden = false;
    /**
     * Geeft of trekt de toestemming in en tekent het blok opnieuw.
     * @param {Event} event De klik.
     * @returns {Promise<void>}
     */
    container.querySelector('#support-btn').onclick = async (event) => {
      event.currentTarget.disabled = true;
      try {
        if (grant) await call('DELETE');
        else await call('POST', { hours: Number(container.querySelector('#support-hours').value) });
        load(me);
      } catch (error) {
        container.querySelector('.err').textContent = error.message;
        event.currentTarget.disabled = false;
      }
    };
  }

  root.AquatechSupport = { load };
})(window);
