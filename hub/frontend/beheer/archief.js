// Beheer > Systeem > Archief: plannen, offertes, werkorders, facturen, webshopbestellingen en klanten uit het zicht halen zonder ze
// te wissen (API /api/admin/archive, zie backend/src/platform/archive.js). Tellingen, in bulk archiveren met een voorbeeld, het archief
// bekijken en terughalen, en het archief definitief verwijderen (facturen zeven jaar bewaren; planner-leerdata blijft altijd staan).
(function () {
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
  /**
   * Datum in het Nederlands.
   * @param {string|null} iso Tijdstip als tekst.
   * @returns {string} Bijv. "26 nov 2026", of een streepje.
   */
  const day = (iso) => (iso ? new Date(String(iso).replace(' ', 'T')).toLocaleDateString('nl-NL', { dateStyle: 'medium' }) : '–');
  /** Het woord dat getypt moet worden voor definitief verwijderen (zelfde als de server). */
  const PURGE_WORD = 'VERWIJDEREN';
  /** Hoeveel regels het archief per keer toont. */
  const PAGE = 50;

  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};
  /** Soorten (sleutel → naam) uit de laatste telling. */
  let kinds = {};
  /** Of de knoppen al gekoppeld zijn. */
  let bound = false;
  /** Stand van het archiefoverzicht (soort en aantal getoonde regels). */
  const view = { kind: '', shown: 0 };

  /**
   * Roept de API aan.
   * @param {string} path Pad na /api/admin/archive.
   * @param {object} [body] Inhoud (verzoek wordt dan een POST).
   * @returns {Promise<object>} Het antwoord; gooit een fout met de melding van de server.
   */
  async function api(path, body) {
    const res = await fetch(`../api/admin/archive${path}`, {
      cache: 'no-store',
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || AquatechCommon.statusMessage(res.status));
    return out;
  }

  /**
   * De gekozen soorten, datum en zoekterm van een formulierdeel.
   * @param {string} prefix Voorvoegsel van de veld-id's (`ar-bulk` of `ar-purge`).
   * @returns {{ kinds: string[], before: string, query: string }} De selectie.
   */
  function selectionOf(prefix) {
    return {
      kinds: [...document.querySelectorAll(`#${prefix}-kinds input:checked`)].map((input) => input.value),
      before: $(`#${prefix}-before`).value,
      query: $(`#${prefix}-query`).value.trim(),
    };
  }

  /**
   * Zet de soortkeuzes (vinkjes) klaar.
   * @returns {void}
   */
  function renderKindChecks() {
    for (const prefix of ['ar-bulk', 'ar-purge']) {
      const box = $(`#${prefix}-kinds`);
      if (box.dataset.ready) continue;
      box.innerHTML = Object.keys(kinds).map((kind) => `<label class="chk"><input type="checkbox" value="${esc(kind)}" checked> ${esc(kinds[kind])}</label>`).join('');
      box.dataset.ready = '1';
    }
    $('#ar-list-kind').innerHTML = Object.keys(kinds).map((kind) => `<option value="${esc(kind)}">${esc(kinds[kind])}</option>`).join('');
    if (!view.kind) view.kind = Object.keys(kinds)[0] || '';
    $('#ar-list-kind').value = view.kind;
  }

  /**
   * Haalt de tellingen op en toont ze.
   * @returns {Promise<void>} Klaar als de tabel getekend is.
   */
  async function loadCounts() {
    const out = await api('');
    kinds = Object.fromEntries(Object.entries(out.counts).map(([kind, entry]) => [kind, entry.label]));
    $('#ar-counts').innerHTML = `<tr><th>Soort</th><th class="num">Actief</th><th class="num">In archief</th></tr>${Object.values(out.counts)
      .map((entry) => `<tr><td>${esc(entry.label)}</td><td class="num">${entry.active}</td><td class="num">${entry.archived}</td></tr>`).join('')}`;
    renderKindChecks();
  }

  /**
   * Toont het voorbeeld van een selectie.
   * @param {object} out Antwoord van /preview.
   * @param {string} target Selector van het vak.
   * @returns {void}
   */
  function renderPreview(out, target) {
    const rows = Object.values(out.kinds).filter((entry) => entry.count > 0);
    $(target).innerHTML = out.total === 0 ? '<p class="muted">Niets gevonden bij deze selectie.</p>'
      : `<p><strong>${out.total}</strong> stuk${out.total === 1 ? '' : 's'}: ${rows.map((entry) => `${esc(entry.label)} ${entry.count}`).join(', ')}</p>
        <div class="table-wrap"><table class="list"><tr><th>Soort</th><th>Nummer</th><th>Omschrijving</th><th>Klant</th><th>Aangemaakt</th></tr>${rows
    .flatMap((entry) => entry.sample.map((item) => `<tr><td>${esc(entry.label)}</td><td>${esc(item.number)}</td><td>${esc(item.title)}</td><td>${esc(item.customer)}</td><td>${day(item.created_at)}</td></tr>`)).join('')}</table></div>
        ${rows.some((entry) => entry.count > entry.sample.length) ? '<p class="muted small">Alleen de eerste regels per soort staan hier; de actie geldt voor alles in de selectie.</p>' : ''}`;
  }

  /**
   * Laadt (een deel van) het archiefoverzicht.
   * @param {boolean} more True = de volgende regels erbij, false = opnieuw beginnen.
   * @returns {Promise<void>} Klaar als de regels getekend zijn.
   */
  async function loadList(more) {
    view.kind = $('#ar-list-kind').value;
    if (!more) view.shown = 0;
    const query = new URLSearchParams({ kind: view.kind, query: $('#ar-list-query').value.trim(), limit: String(PAGE), offset: String(view.shown) });
    const out = await api(`/list?${query}`);
    const rows = out.items.map((item) => `<tr><td>${esc(item.number)}</td><td>${esc(item.title)}</td><td>${esc(item.customer)}</td><td>${day(item.archived_at)}</td><td><button class="btn" type="button" data-restore="${esc(item.id)}">Terughalen</button></td></tr>`).join('');
    if (!more) $('#ar-list').innerHTML = '';
    $('#ar-list').insertAdjacentHTML('beforeend', rows);
    view.shown += out.items.length;
    $('#ar-list-empty').hidden = view.shown > 0;
    $('#ar-list-more').hidden = view.shown >= out.total;
  }

  /**
   * Toont het resultaat van het definitief verwijderen.
   * @param {object} out Antwoord van /purge.
   * @returns {void}
   */
  function renderPurgeResult(out) {
    const done = Object.entries(out.deleted).filter(([, count]) => count > 0).map(([kind, count]) => `${esc(kinds[kind] || kind)} ${count}`).join(', ') || 'niets';
    $('#ar-purge-result').innerHTML = `<p>Verwijderd: ${done}.${out.truncated ? ' Er is een maximum per keer; voer de actie nog een keer uit voor de rest.' : ''}</p>${out.blocked.length
      ? `<p><strong>${out.blocked.length} niet verwijderd:</strong></p><ul>${out.blocked.slice(0, 50).map((item) => `<li>${esc(item.label)} ${esc(item.number)}: ${esc(item.reason)}</li>`).join('')}</ul>` : ''}`;
  }

  /**
   * Koppelt de knoppen, één keer.
   * @returns {void}
   */
  function bind() {
    if (bound) return;
    bound = true;
    $('#ar-bulk-preview').addEventListener('click', async () => {
      $('#ar-bulk-err').textContent = '';
      try {
        renderPreview(await api('/preview', selectionOf('ar-bulk')), '#ar-bulk-result');
        $('#ar-bulk-run').disabled = false;
      } catch (error) { $('#ar-bulk-err').textContent = error.message; }
    });
    $('#ar-bulk-run').addEventListener('click', async () => {
      $('#ar-bulk-err').textContent = '';
      try {
        const out = await api('/archive', selectionOf('ar-bulk'));
        const total = Object.values(out.archived).reduce((sum, count) => sum + count, 0);
        toast(`${total} gearchiveerd`);
        $('#ar-bulk-result').innerHTML = '';
        $('#ar-bulk-run').disabled = true;
        await Promise.all([loadCounts(), loadList(false)]);
      } catch (error) { $('#ar-bulk-err').textContent = error.message; }
    });
    $('#ar-list-kind').addEventListener('change', () => loadList(false).catch((error) => { $('#ar-list-err').textContent = error.message; }));
    $('#ar-list-search').addEventListener('click', () => loadList(false).catch((error) => { $('#ar-list-err').textContent = error.message; }));
    $('#ar-list-more').addEventListener('click', () => loadList(true).catch((error) => { $('#ar-list-err').textContent = error.message; }));
    $('#ar-list').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-restore]');
      if (!button) return;
      button.disabled = true;
      try {
        await api('/restore', { kind: view.kind, ids: [button.dataset.restore] });
        toast('Teruggehaald');
        await Promise.all([loadCounts(), loadList(false)]);
      } catch (error) { $('#ar-list-err').textContent = error.message; button.disabled = false; }
    });
    $('#ar-purge-preview').addEventListener('click', async () => {
      $('#ar-purge-err').textContent = '';
      try { renderPreview(await api('/preview', { ...selectionOf('ar-purge'), state: 'archief' }), '#ar-purge-result'); } catch (error) { $('#ar-purge-err').textContent = error.message; }
    });
    $('#ar-purge-run').addEventListener('click', async () => {
      $('#ar-purge-err').textContent = '';
      if ($('#ar-purge-confirm').value.trim() !== PURGE_WORD) { $('#ar-purge-err').textContent = `Typ ${PURGE_WORD} om te bevestigen.`; return; }
      try {
        renderPurgeResult(await api('/purge', { ...selectionOf('ar-purge'), confirm: PURGE_WORD }));
        $('#ar-purge-confirm').value = '';
        await Promise.all([loadCounts(), loadList(false)]);
      } catch (error) { $('#ar-purge-err').textContent = error.message; }
    });
  }

  /**
   * Bewaart de meldingsfunctie van Beheer.
   * @param {{ toast: function }} deps De afhankelijkheden van de pagina.
   * @returns {void}
   */
  function init(deps) { toast = deps.toast || toast; }

  /**
   * Laadt het scherm (bij openen van de sectie).
   * @returns {Promise<void>} Klaar als alles getekend is.
   */
  async function load() {
    bind();
    try {
      await loadCounts();
      await loadList(false);
    } catch (error) { $('#ar-list-err').textContent = `Kan het archief niet laden: ${error.message}`; }
  }

  window.BeheerArchief = { init, load };
})();
