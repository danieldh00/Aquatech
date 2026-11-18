// Producttekst door de AI (module Artikelen, tabblad Teksten): artikelen kiezen, concepten laten schrijven (in porties,
// met voortgang), de bronvelden en de feitencontrole bekijken, een concept aanpassen en goedkeuren of afwijzen.
// Niets gaat live zonder goedkeuring; een concept met waarschuwingen vraagt een uitdrukkelijke bevestiging.
// Praat met /api/stock/item-texts (recht voorraad).
(function () {
  const context = { api: null, toast: null, esc: null };
  const state = { data: null, selected: new Set(), openId: null, detail: null, busy: false };
  const FIELDS = ['description', 'seoTitle', 'seoDescription'];
  const FIELD_NAMES = { description: 'Omschrijving', seoTitle: 'Titel voor zoekmachines', seoDescription: 'Omschrijving voor zoekmachines' };

  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector) => document.querySelector(selector);

  /**
   * De filters als zoekopdracht voor de lijst.
   * @returns {string} Het query-gedeelte van het adres.
   */
  function queryOf() {
    const params = new URLSearchParams({ q: $('#tx-search').value.trim(), filter: $('#tx-filter').value, category: $('#tx-category').value });
    return params.toString();
  }

  /**
   * Laadt de lijst met artikelen en tekent hem.
   * @returns {Promise<void>}
   */
  async function load() {
    state.data = await context.api(`stock/item-texts?${queryOf()}`);
    const present = new Set(state.data.items.map((item) => item.id));
    state.selected = new Set([...state.selected].filter((id) => present.has(id)));
    renderList();
  }

  /** Tekent de melding over AI, de categorielijst en de tabel. */
  function renderList() {
    const { data } = state;
    const notice = $('#tx-notice');
    if (!data.ai.enabled) notice.textContent = 'AI staat uit (Beheer → Integraties → AI-herkenning). Concepten schrijven kan pas als AI aanstaat; bestaande concepten kun je wel beoordelen.';
    else if (!data.ai.configured) notice.textContent = 'Er is geen API-sleutel ingesteld (Beheer → Integraties → AI-herkenning). Zonder eigen sleutel kunnen er geen concepten worden geschreven.';
    else notice.textContent = '';
    notice.hidden = !notice.textContent;
    $('#tx-write').disabled = state.busy || !data.ai.enabled || !data.ai.configured;
    const category = $('#tx-category');
    const chosen = category.value;
    category.innerHTML = `<option value="">Alle categorieën</option>${data.categories.map((name) => `<option value="${context.esc(name)}">${context.esc(name)}</option>`).join('')}`;
    category.value = data.categories.includes(chosen) ? chosen : '';
    const drafts = data.items.filter((item) => item.draft).length;
    $('#t-texts').textContent = drafts ? String(drafts) : '';
    $('#tx-count').textContent = `${data.total} artikel${data.total === 1 ? '' : 'en'}${data.truncated ? ` (eerste ${data.items.length} getoond: verfijn het filter)` : ''} · nog ${data.ai.remainingToday} AI-verzoeken vandaag`;
    $('#tx-table').innerHTML = data.items.length
      ? `<thead><tr><th><input type="checkbox" id="tx-all" aria-label="Alles kiezen"></th><th>Code</th><th>Naam</th><th>Categorie</th><th>Tekst nu</th><th>Concept</th><th></th></tr></thead><tbody>${data.items.map((item) => `<tr>
          <td><input type="checkbox" data-pick="${context.esc(item.id)}" ${state.selected.has(item.id) ? 'checked' : ''} aria-label="Kies ${context.esc(item.code)}"></td>
          <td>${context.esc(item.code)}</td><td class="wrap">${context.esc(item.name)}</td><td>${context.esc(item.category)}</td>
          <td>${item.hasDescription ? 'Omschrijving' : '<span class="muted">Geen omschrijving</span>'}${item.hasSeo ? '' : ' <span class="muted">· zoektekst ontbreekt</span>'}</td>
          <td>${item.draft ? `<span class="pill ${item.draft.warnings ? 'warn' : 'ok'}">${item.draft.warnings ? `Concept · ${item.draft.warnings} ${item.draft.warnings === 1 ? 'punt' : 'punten'}` : 'Concept'}</span>` : ''}</td>
          <td><button class="linkbtn" data-open="${context.esc(item.id)}" type="button">${item.draft ? 'Beoordelen' : 'Bekijken'}</button></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Geen artikelen gevonden voor dit filter.</td></tr></tbody>';
    const all = $('#tx-all');
    if (all) all.checked = data.items.length > 0 && data.items.every((item) => state.selected.has(item.id));
  }

  /**
   * Zet een melding over de voortgang onder de knoppen.
   * @param {string} text De tekst (leeg = niets).
   */
  const progress = (text) => { $('#tx-progress').textContent = text; };

  /**
   * Laat concepten schrijven voor de gekozen artikelen, in porties van de grootte die de server noemt.
   * Bestaande concepten blijven staan (die kun je per artikel opnieuw laten schrijven). Een fout die doorgaan zinloos maakt stopt de rest.
   * @returns {Promise<void>}
   */
  async function writeSelected() {
    const ids = [...state.selected];
    if (!ids.length) { context.toast('Kies eerst de artikelen.', true); return; }
    state.busy = true;
    $('#tx-write').disabled = true;
    const tally = { ok: 0, skipped: 0, error: 0 };
    let stopMessage = '';
    try {
      const size = state.data.ai.batchSize || 5;
      for (let start = 0; start < ids.length && !stopMessage; start += size) {
        progress(`Schrijven… ${Math.min(start, ids.length)} van ${ids.length}`);
        const out = await context.api('stock/item-texts/generate', { method: 'POST', body: { itemIds: ids.slice(start, start + size), skipExisting: true } });
        for (const result of out.results) tally[result.status] += 1;
        if (out.aborted) stopMessage = out.aborted.message;
        else if (out.results.some((result) => result.code === 'daily_limit')) stopMessage = 'Het dagelijkse maximum voor AI-verzoeken is bereikt.';
      }
    } catch (error) {
      stopMessage = error.message;
    }
    state.busy = false;
    progress(`${tally.ok} concept${tally.ok === 1 ? '' : 'en'} geschreven${tally.skipped ? `, ${tally.skipped} overgeslagen` : ''}${tally.error ? `, ${tally.error} mislukt` : ''}.${stopMessage ? ` ${stopMessage}` : ''}`);
    context.toast(stopMessage || `${tally.ok} concept${tally.ok === 1 ? '' : 'en'} geschreven.`, Boolean(stopMessage) || tally.error > 0);
    await load();
    if (state.openId) await openDetail(state.openId);
  }

  /**
   * Zet de waarschuwingen van een concept op het scherm.
   * @param {object[]} warnings De waarschuwingen van de server.
   */
  function renderWarnings(warnings) {
    const box = $('#tx-warnings');
    if (!state.detail.draft) { box.innerHTML = ''; return; }
    box.innerHTML = warnings.length
      ? `<div class="tx-warn" role="alert"><b>Controleer deze punten voordat je goedkeurt</b><ul>${warnings.map((warning) => `<li><b>${context.esc(FIELD_NAMES[warning.field] || warning.field)}:</b> ${context.esc(warning.message)}</li>`).join('')}</ul></div>`
      : '<div class="tx-ok">Alle getallen, eenheden en beweringen in het concept staan in de artikelgegevens.</div>';
    $('#tx-ack-row').hidden = !warnings.length;
    if (!warnings.length) $('#tx-ack').checked = false;
  }

  /**
   * Opent een artikel met zijn gegevens, de live tekst en het concept.
   * @param {string} itemId Het artikel.
   * @returns {Promise<void>}
   */
  async function openDetail(itemId) {
    const detail = await context.api(`stock/item-texts/${encodeURIComponent(itemId)}`);
    state.openId = itemId;
    state.detail = detail;
    $('#tx-detail').hidden = false;
    $('#tx-detail-title').textContent = `${detail.item.code} · ${detail.item.name}`;
    $('#tx-facts').innerHTML = detail.facts.map((field) => `<dt>${context.esc(field.label)}</dt><dd>${context.esc(field.value)}</dd>`).join('');
    for (const field of FIELDS) {
      $(`#tx-live-${field}`).value = detail.live[field];
      $(`#tx-${field}`).value = detail.draft ? detail.draft[field] : '';
      $(`#tx-${field}`).disabled = !detail.draft;
    }
    $('#tx-notes').textContent = detail.draft && detail.draft.notes ? `Opmerking van de AI: ${detail.draft.notes}` : detail.draft ? '' : 'Dit artikel heeft nog geen concept. Kies het in de lijst en klik op Concepten schrijven, of klik hieronder op Opnieuw schrijven.';
    $('#tx-over-row').hidden = true;
    $('#tx-over').checked = false;
    $('#tx-ack').checked = false;
    $('#tx-ack-row').hidden = true;
    for (const id of ['tx-save', 'tx-publish', 'tx-discard']) $(`#${id}`).hidden = !detail.draft;
    $('#tx-redo').textContent = detail.draft ? 'Opnieuw schrijven' : 'Concept schrijven';
    $('#tx-redo').disabled = !state.data.ai.enabled || !state.data.ai.configured;
    renderWarnings(detail.draft ? detail.draft.warnings : []);
    if (detail.thin && !detail.draft) $('#tx-notes').textContent += ' Let op: er zijn weinig gegevens; de tekst wordt kort.';
    $('#tx-detail').scrollIntoView({ block: 'nearest' });
  }

  /**
   * De teksten uit de velden van het concept.
   * @returns {object} description, seoTitle en seoDescription.
   */
  const draftFromForm = () => Object.fromEntries(FIELDS.map((field) => [field, $(`#tx-${field}`).value]));

  /**
   * Bewaart een wijziging van het concept; de server controleert opnieuw.
   * @returns {Promise<boolean>} true als het gelukt is.
   */
  async function saveDraft() {
    try {
      const out = await context.api(`stock/item-texts/${encodeURIComponent(state.openId)}`, { method: 'PUT', body: draftFromForm() });
      state.detail.draft = out.draft;
      renderWarnings(out.draft.warnings);
      return true;
    } catch (error) {
      context.toast(error.message, true);
      return false;
    }
  }

  /**
   * Keurt de gegeven concepten goed en meldt per uitkomst wat er gebeurde.
   * @param {string[]} ids De artikelen.
   * @param {{ acknowledgeWarnings?: boolean, overwrite?: boolean }} [flags] Bevestigingen van de gebruiker.
   * @returns {Promise<object[]>} De uitkomsten per artikel.
   */
  async function approve(ids, flags = {}) {
    const out = await context.api('stock/item-texts/approve', { method: 'POST', body: { itemIds: ids, ...flags } });
    /**
     * Telt de uitkomsten met een status.
     * @param {string} status De status.
     * @returns {number} Het aantal.
     */
    const count = (status) => out.results.filter((result) => result.status === status).length;
    const parts = [];
    if (count('approved')) parts.push(`${count('approved')} goedgekeurd en geplaatst`);
    if (count('warnings')) parts.push(`${count('warnings')} met waarschuwingen: open ze en bevestig dat je ze gecontroleerd hebt`);
    if (count('changed')) parts.push(`${count('changed')} met een intussen gewijzigde tekst: open ze en kies overschrijven`);
    if (count('not_found') + count('unavailable') + count('error')) parts.push(`${count('not_found') + count('unavailable') + count('error')} overgeslagen`);
    context.toast(parts.join(', ') || 'Niets goedgekeurd.', !count('approved'));
    return out.results;
  }

  /**
   * Koppelt de knoppen, filters en de tabel.
   * @param {object} options api, toast en esc van de pagina.
   */
  function setup(options) {
    Object.assign(context, options);
    let timer = null;
    $('#tx-search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { load().catch((error) => context.toast(error.message, true)); }, 250); });
    for (const id of ['#tx-category', '#tx-filter']) $(id).addEventListener('change', () => { load().catch((error) => context.toast(error.message, true)); });
    $('#tx-table').addEventListener('change', (event) => {
      if (event.target.id === 'tx-all') {
        for (const item of state.data.items) { if (event.target.checked) state.selected.add(item.id); else state.selected.delete(item.id); }
        renderList();
        return;
      }
      const id = event.target.dataset && event.target.dataset.pick;
      if (!id) return;
      if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
      renderList();
    });
    $('#tx-table').addEventListener('click', (event) => {
      const id = event.target.dataset && event.target.dataset.open;
      if (id) openDetail(id).catch((error) => context.toast(error.message, true));
    });
    $('#tx-write').addEventListener('click', () => { writeSelected(); });
    $('#tx-approve').addEventListener('click', async () => {
      const ids = state.data.items.filter((item) => item.draft && state.selected.has(item.id)).map((item) => item.id);
      if (!ids.length) { context.toast('Kies artikelen met een concept.', true); return; }
      try { await approve(ids); await load(); } catch (error) { context.toast(error.message, true); }
    });
    $('#tx-reject').addEventListener('click', async () => {
      const ids = state.data.items.filter((item) => item.draft && state.selected.has(item.id)).map((item) => item.id);
      if (!ids.length) { context.toast('Kies artikelen met een concept.', true); return; }
      try {
        const out = await context.api('stock/item-texts/reject', { method: 'POST', body: { itemIds: ids } });
        context.toast(`${out.rejected} concept${out.rejected === 1 ? '' : 'en'} afgewezen.`);
        await load();
      } catch (error) { context.toast(error.message, true); }
    });
    $('#tx-close').addEventListener('click', () => { $('#tx-detail').hidden = true; state.openId = null; });
    $('#tx-save').addEventListener('click', async () => { if (await saveDraft()) { context.toast('Concept bewaard.'); await load(); } });
    $('#tx-publish').addEventListener('click', async () => {
      try {
        if (!(await saveDraft())) return;
        const warnings = state.detail.draft.warnings;
        const ack = $('#tx-ack').checked;
        if (warnings.length && !ack) { context.toast('Vink eerst aan dat je de gemarkeerde punten hebt gecontroleerd.', true); return; }
        const [result] = await approve([state.openId], { acknowledgeWarnings: ack, overwrite: $('#tx-over').checked });
        if (result.status === 'changed') $('#tx-over-row').hidden = false;
        await load();
        if (result.status === 'approved') await openDetail(state.openId);
      } catch (error) { context.toast(error.message, true); }
    });
    $('#tx-discard').addEventListener('click', async () => {
      try {
        await context.api(`stock/item-texts/${encodeURIComponent(state.openId)}`, { method: 'DELETE' });
        context.toast('Concept afgewezen.');
        await load();
        await openDetail(state.openId);
      } catch (error) { context.toast(error.message, true); }
    });
    $('#tx-redo').addEventListener('click', async () => {
      if (state.busy) return;
      state.busy = true;
      progress('Schrijven…');
      try {
        const out = await context.api('stock/item-texts/generate', { method: 'POST', body: { itemIds: [state.openId] } });
        const [result] = out.results;
        if (result.status !== 'ok') context.toast(result.message || 'Schrijven is niet gelukt.', true);
        else context.toast('Nieuw concept geschreven.');
      } catch (error) { context.toast(error.message, true); }
      state.busy = false;
      progress('');
      await load();
      await openDetail(state.openId);
    });
  }

  window.ArtikelenTexts = { setup, load };
})();
