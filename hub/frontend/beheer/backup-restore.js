// Beheer > Systeem > Terugzetten uit back-up: back-up en soort kiezen, zoeken, voorbeeld per record met de te kiezen velden,
// en terugzetten na bevestiging met het eigen wachtwoord. API /api/admin/backups/restore, zie
// backend/src/platform/backup-restore.js.
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
   * Een waarde kort leesbaar maken (JSON ingekort).
   * @param {*} value De waarde.
   * @returns {string} Tekst van hoogstens 160 tekens.
   */
  function shown(value) {
    if (value === null || value === undefined) return '(leeg)';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  }

  const STATE_TEXT = { ontbreekt: 'Verwijderd', gewijzigd: 'Gewijzigd', gelijk: 'Gelijk aan nu' };
  const STATUS_TEXT = { hersteld: 'Teruggezet', bijgewerkt: 'Bijgewerkt', overgeslagen: 'Overgeslagen', geblokkeerd: 'Geblokkeerd' };
  let loaded = false;
  let previews = [];
  let kind = '';

  /**
   * Roept de API aan.
   * @param {string} path Pad na api/admin/backups/restore.
   * @param {object} [options] Methode en body (object).
   * @returns {Promise<object>} Het antwoord; gooit een fout met de melding van de server.
   */
  async function call(path, options = {}) {
    const response = await fetch(`../api/admin/backups/restore${path}`, {
      cache: 'no-store',
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
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
    const element = byId('r-result');
    element.textContent = text;
    element.className = isError ? 'err small' : 'muted small';
  }

  /** Laadt de keuzelijsten (back-ups en soorten) één keer per paginabezoek, en elke keer de lijst met back-ups opnieuw. */
  async function load() {
    try {
      const [kinds, backups] = await Promise.all([loaded ? null : call('/kinds'), fetch('../api/admin/backups', { cache: 'no-store' }).then((response) => response.json())]);
      if (kinds) {
        byId('r-kind').innerHTML = kinds.kinds.map((entry) => `<option value="${esc(entry.kind)}">${esc(entry.label)}</option>`).join('');
        loaded = true;
      }
      const selected = byId('r-backup').value;
      byId('r-backup').innerHTML = backups.items.length
        ? backups.items.map((item) => `<option value="${esc(item.name)}">${esc(when(item.createdAt))} · ${esc(item.name)}</option>`).join('')
        : '<option value="">Geen back-ups</option>';
      if (selected) byId('r-backup').value = selected;
    } catch (error) {
      say(`Kan de gegevens niet laden: ${error.message}`, true);
    }
  }

  /** Zoekt records in de gekozen back-up en toont de lijst met keuzevakjes. */
  async function search() {
    const backup = byId('r-backup').value;
    kind = byId('r-kind').value;
    byId('r-preview').innerHTML = '';
    byId('r-confirm').hidden = true;
    previews = [];
    if (!backup) { byId('r-list').textContent = 'Er zijn geen back-ups.'; return; }
    byId('r-list').textContent = 'Back-up openen…';
    try {
      const query = new URLSearchParams({ backup, kind, q: byId('r-query').value.trim() });
      const found = await call(`/records?${query}`);
      byId('r-list').innerHTML = found.items.length
        ? `<table class="list"><thead><tr><th></th><th>Record</th><th>Aangemaakt</th><th>Nu</th></tr></thead><tbody>${found.items.map((item) => `<tr><td><input type="checkbox" data-record="${esc(item.id)}"${item.state === 'gelijk' ? ' disabled' : ''}></td><td>${esc(item.label)}</td><td>${esc(when(item.createdAt))}</td><td>${esc(STATE_TEXT[item.state] || item.state)}</td></tr>`).join('')}</tbody></table>${found.hasMore ? '<p class="muted small">Er zijn meer records: verfijn je zoekopdracht.</p>' : ''}<div class="form-actions"><button type="button" class="btn" id="r-show">Voorbeeld van de gekozen records</button></div>`
        : 'Niets gevonden in deze back-up.';
      const show = byId('r-show');
      if (show) show.addEventListener('click', showPreview);
    } catch (error) {
      byId('r-list').textContent = error.message;
    }
  }

  /** Haalt het voorbeeld op van de aangevinkte records en toont per record wat er zou veranderen. */
  async function showPreview() {
    const ids = [...document.querySelectorAll('#r-list [data-record]:checked')].map((box) => box.dataset.record);
    if (!ids.length) { say('Vink eerst een of meer records aan.', true); return; }
    say('Voorbeeld ophalen…');
    try {
      previews = (await call('/preview', { method: 'POST', body: { backup: byId('r-backup').value, kind, ids } })).previews;
      byId('r-preview').innerHTML = previews.map((plan, index) => {
        const children = plan.children.filter((child) => child.inBackup).map((child) => `${child.missing} van ${child.inBackup} ${esc(child.table)}`).join(', ');
        let body;
        if (plan.blocked) body = `<p class="err small">${esc(plan.blocked)}</p>`;
        else if (plan.state === 'ontbreekt') body = `<p class="small">Wordt teruggezet${children ? `, met ${esc(children)}` : ''}.</p>`;
        else body = `<table class="list"><thead><tr><th></th><th>Veld</th><th>Nu</th><th>In de back-up</th></tr></thead><tbody>${plan.diffs.map((diff) => `<tr><td><input type="checkbox" data-plan="${index}" data-field="${esc(diff.field)}"></td><td>${esc(diff.field)}</td><td>${esc(shown(diff.current))}</td><td>${esc(shown(diff.backup))}</td></tr>`).join('')}</tbody></table>`;
        return `<div class="card"><h4>${esc(plan.label)} <span class="muted small">(${esc(STATE_TEXT[plan.state] || plan.state)})</span></h4>${body}</div>`;
      }).join('');
      byId('r-confirm').hidden = !previews.some((plan) => !plan.blocked);
      say('');
    } catch (error) {
      say(error.message, true);
    }
  }

  /** Zet de records terug na het wachtwoord, en toont per record wat er gebeurde. */
  async function apply() {
    const items = previews.filter((plan) => !plan.blocked).map((plan) => ({
      id: plan.id,
      fields: [...document.querySelectorAll(`#r-preview [data-plan="${previews.indexOf(plan)}"]:checked`)].map((box) => box.dataset.field),
    }));
    if (!items.length) { say('Er is niets om terug te zetten.', true); return; }
    const button = byId('r-apply');
    button.disabled = true;
    say('Back-up maken en terugzetten…');
    try {
      const out = await call('/apply', { method: 'POST', body: { backup: byId('r-backup').value, kind, items, password: byId('r-password').value } });
      byId('r-password').value = '';
      byId('r-preview').innerHTML = `<ul class="timeline">${out.results.map((result) => `<li>${esc(result.label || result.id)} · ${esc(STATUS_TEXT[result.status] || result.status)} · ${esc(result.message)}</li>`).join('')}</ul>`;
      byId('r-confirm').hidden = true;
      say(`Klaar. Vooraf is een back-up gemaakt (${out.safetyBackup}).`);
      byId('r-list').innerHTML = '';
    } catch (error) {
      say(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  /** Koppelt de knoppen één keer. */
  function init() {
    if (!byId('s-restore')) return;
    byId('r-search').addEventListener('click', search);
    byId('r-query').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
    byId('r-apply').addEventListener('click', apply);
  }

  init();
  window.BeheerRestore = { load };
})();
