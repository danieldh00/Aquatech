// Gerelateerde artikelen (module Artikelen, tabblad Past bij): per artikel de koppelingen "Past bij" instellen (handmatig, of door de AI met reden en bron),
// "Vaak samen besteld" bekijken en de AI-ronde starten (specificaties opzoeken in porties, daarna koppelen met vaste regels).
// Handmatige koppelingen blijven altijd staan; een AI-koppeling is herkenbaar, per artikel te wissen en met één knop in één keer.
// Praat met /api/stock/related en /api/stock/related-ai (recht voorraad).
(function () {
  const context = { api: null, toast: null, esc: null };
  const state = { data: null, ai: null, openId: null, detail: null, busy: false, stop: false };

  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector) => document.querySelector(selector);

  /**
   * Maakt een webadres veilig voor een link: alleen https.
   * @param {string} url Het adres uit de bron.
   * @returns {string} Het adres, of leeg als het niet https is.
   */
  const safeUrl = (url) => (/^https:\/\/[^\s"'<>]+$/.test(String(url || '')) ? String(url) : '');

  /**
   * De domeinnaam van een adres, om bij de bronlink te tonen.
   * @param {string} url Het adres.
   * @returns {string} De domeinnaam, of het adres zelf bij een onleesbaar adres.
   */
  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url); }
  }

  /**
   * Zet een melding onder de AI-knoppen.
   * @param {string} text De tekst (leeg = niets).
   * @returns {void}
   */
  const progress = (text) => { $('#rl-progress').textContent = text; };

  /**
   * De filters als zoekopdracht voor de lijst.
   * @returns {string} Het query-gedeelte van het adres.
   */
  const queryOf = () => new URLSearchParams({ q: $('#rl-search').value.trim(), filter: $('#rl-filter').value }).toString();

  /**
   * Laadt de lijst met artikelen en tekent hem.
   * @returns {Promise<void>}
   */
  async function load() {
    state.data = await context.api(`stock/related?${queryOf()}`);
    state.ai = state.data.ai;
    renderList();
  }

  /** Tekent de melding over AI, de knoppen en de tabel. */
  function renderList() {
    const { data } = state;
    const notice = $('#rl-notice');
    if (!data.ai.enabled) notice.textContent = 'AI staat uit (Beheer → Integraties → AI-herkenning). Koppelen met de hand en Vaak samen besteld werken wel.';
    else if (!data.ai.configured) notice.textContent = 'Er is geen API-sleutel ingesteld (Beheer → Integraties → AI-herkenning). Zonder eigen sleutel kan de AI geen specificaties opzoeken.';
    else notice.textContent = '';
    notice.hidden = !notice.textContent;
    $('#rl-ai').disabled = state.busy || !data.ai.enabled || !data.ai.configured;
    const modelSelect = $('#rl-model');
    modelSelect.innerHTML = data.ai.models.map((model) => `<option value="${context.esc(model.id)}">${context.esc(model.label)}</option>`).join('');
    modelSelect.value = data.ai.model;
    $('#rl-count').textContent = `${data.total} artikel${data.total === 1 ? '' : 'en'}${data.truncated ? ` (eerste ${data.items.length} getoond: verfijn het filter)` : ''}`;
    $('#rl-table').innerHTML = data.items.length
      ? `<thead><tr><th>Code</th><th>Naam</th><th>Past bij (handmatig)</th><th>Past bij (AI)</th><th>Vaak samen besteld</th><th>Specificaties</th><th></th></tr></thead><tbody>${data.items.map((item) => `<tr>
          <td>${context.esc(item.code)}</td><td class="wrap">${context.esc(item.name)}</td>
          <td>${item.manual || '<span class="muted">0</span>'}</td><td>${item.ai || '<span class="muted">0</span>'}</td><td>${item.together || '<span class="muted">0</span>'}</td>
          <td>${item.specStatus === 'gevonden' ? '<span class="pill ok">Gevonden</span>' : item.specStatus === 'niet_gevonden' ? '<span class="pill warn">Niet gevonden</span>' : '<span class="muted">Nog niet opgezocht</span>'}</td>
          <td><button class="linkbtn" data-open="${context.esc(item.id)}" type="button">Bekijken</button></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Geen artikelen gevonden voor dit filter.</td></tr></tbody>';
  }

  /**
   * De bronnen van een AI-koppeling als links.
   * @param {object[]} evidence De bronnen (artikel, zin, adres).
   * @returns {string} HTML met de zinnen en bronlinks.
   */
  function evidenceHtml(evidence) {
    if (!evidence || !evidence.length) return '';
    return `<ul class="rl-evidence">${evidence.map((entry) => {
      const url = safeUrl(entry.url);
      return `<li>${context.esc(entry.of || '')}: “${context.esc(entry.quote)}” ${url ? `<a href="${context.esc(url)}" target="_blank" rel="noopener noreferrer">${context.esc(domainOf(url))}</a>` : ''}</li>`;
    }).join('')}</ul>`;
  }

  /**
   * Tekent het paneel van één artikel: koppelingen, partners en de zoekbalk voor een nieuwe koppeling.
   * @returns {void}
   */
  function renderDetail() {
    const panel = $('#rl-detail');
    const { detail } = state;
    if (!detail) { panel.hidden = true; return; }
    panel.hidden = false;
    $('#rl-detail-title').textContent = `${detail.item.name} (${detail.item.code})`;
    $('#rl-links').innerHTML = detail.links.length
      ? detail.links.map((link) => `<li><div><b>${context.esc(link.name)}</b> <span class="muted">${context.esc(link.code)}</span> <span class="pill ${link.source === 'ai' ? 'warn' : 'ok'}">${link.source === 'ai' ? 'AI' : 'Handmatig'}</span>
          ${link.reason ? `<div class="muted small">${context.esc(link.reason)}</div>${evidenceHtml(link.evidence)}` : ''}</div>
          <button class="linkbtn" data-remove="${context.esc(link.relatedId)}" type="button">Wissen</button></li>`).join('')
      : '<li class="muted">Nog geen koppelingen.</li>';
    $('#rl-together').innerHTML = detail.together.length
      ? detail.together.map((entry) => `<li><b>${context.esc(entry.name)}</b> <span class="muted">${context.esc(entry.code)} · samen in ${entry.ordersBoth} van ${entry.ordersItem} bestellingen · ${entry.lift}× vaker dan toeval</span></li>`).join('')
      : '<li class="muted">Nog geen duidelijke partners: er zijn te weinig bestellingen waarin dit artikel samen met een ander voorkomt.</li>';
    const specs = detail.specs;
    $('#rl-spec-info').textContent = !specs ? 'Specificaties zijn nog niet opgezocht.'
      : specs.status === 'gevonden' ? `Specificaties gevonden (${(specs.specs.connections || []).map((connection) => (connection.kind === 'draad' ? `${connection.gender}draad ${connection.size}` : `${connection.kind} ${connection.size}`)).join(', ')}).`
        : 'Geen betrouwbare specificaties gevonden: de AI koppelt dit artikel niet. Je kunt het met de hand koppelen.';
  }

  /**
   * Opent het paneel van een artikel.
   * @param {string} itemId Id van het artikel.
   * @returns {Promise<void>}
   */
  async function openItem(itemId) {
    state.openId = itemId;
    state.detail = await context.api(`stock/related/${encodeURIComponent(itemId)}`);
    $('#rl-add-search').value = '';
    $('#rl-add-results').innerHTML = '';
    renderDetail();
    $('#rl-detail').scrollIntoView({ block: 'nearest' });
  }

  /**
   * Zoekt artikelen om te koppelen en toont de uitkomst als knoppen.
   * @returns {Promise<void>}
   */
  async function searchToAdd() {
    const term = $('#rl-add-search').value.trim();
    const results = $('#rl-add-results');
    if (term.length < 2) { results.innerHTML = ''; return; }
    const found = await context.api(`stock/related?${new URLSearchParams({ q: term, filter: 'alle' })}`);
    const taken = new Set(state.detail.links.map((link) => link.relatedId));
    const options = found.items.filter((item) => item.id !== state.openId && !taken.has(item.id)).slice(0, 8);
    results.innerHTML = options.length
      ? options.map((item) => `<li><button class="linkbtn" data-add="${context.esc(item.id)}" type="button">${context.esc(item.name)} <span class="muted">${context.esc(item.code)}</span></button></li>`).join('')
      : '<li class="muted">Niets gevonden.</li>';
  }

  /**
   * Voegt een handmatige koppeling toe.
   * @param {string} relatedId Id van het te koppelen artikel.
   * @returns {Promise<void>}
   */
  async function addLink(relatedId) {
    const manual = state.detail.links.filter((link) => link.source === 'handmatig').map((link) => link.relatedId);
    state.detail = await context.api(`stock/related/${encodeURIComponent(state.openId)}`, { method: 'PUT', body: { relatedIds: [...manual, relatedId] } });
    $('#rl-add-search').value = '';
    $('#rl-add-results').innerHTML = '';
    renderDetail();
    await load();
  }

  /**
   * Wist één koppeling (handmatig of AI).
   * @param {string} relatedId Id van het gekoppelde artikel.
   * @returns {Promise<void>}
   */
  async function removeLink(relatedId) {
    await context.api(`stock/related/${encodeURIComponent(state.openId)}/${encodeURIComponent(relatedId)}`, { method: 'DELETE' });
    state.detail = await context.api(`stock/related/${encodeURIComponent(state.openId)}`);
    renderDetail();
    await load();
  }

  /**
   * Start de AI-ronde: laat alle artikelen zonder uitkomst opzoeken (in porties, met voortgang) en koppelt daarna met de vaste regels. Vraagt eerst
   * bevestiging met de geschatte kosten. Een fout die doorgaan zinloos maakt stopt de ronde; wat al gevonden is blijft bewaard.
   * @returns {Promise<void>}
   */
  async function runAi() {
    const again = $('#rl-again').checked;
    const todo = await context.api(`stock/related/ai/todo?again=${again ? '1' : '0'}`);
    if (todo.ids.length) {
      const question = `De AI zoekt de specificaties van ${todo.ids.length} artikelen op internet (model ${state.ai.modelLabel}). Geschatte kosten ongeveer € ${todo.estimateEur.toFixed(2).replace('.', ',')}; het echte verbruik zie je in Beheer > AI-kosten. Er wordt alleen gekoppeld als een bron de aansluiting noemt. Doorgaan?`;
      if (!window.confirm(question)) return;
    }
    state.busy = true;
    state.stop = false;
    $('#rl-ai').disabled = true;
    $('#rl-stop').hidden = false;
    const tally = { gevonden: 0, niet_gevonden: 0, error: 0 };
    let stopMessage = '';
    try {
      const size = state.ai.batchSize || 5;
      for (let start = 0; start < todo.ids.length && !stopMessage && !state.stop; start += size) {
        progress(`Specificaties opzoeken… ${start} van ${todo.ids.length}`);
        const out = await context.api('stock/related-ai/research', { method: 'POST', body: { itemIds: todo.ids.slice(start, start + size) } });
        for (const result of out.results) tally[result.status] = (tally[result.status] || 0) + 1;
        if (out.aborted) stopMessage = out.aborted.message;
      }
      progress('Artikelen koppelen…');
      const linked = await context.api('stock/related-ai/link', { method: 'POST', body: {} });
      progress(`${tally.gevonden} met specificaties gevonden, ${tally.niet_gevonden} zonder bron (niet gekoppeld)${tally.error ? `, ${tally.error} mislukt` : ''}. ${linked.links} koppelingen voor ${linked.items} artikelen.${state.stop ? ' Gestopt op verzoek.' : ''}${stopMessage ? ` ${stopMessage}` : ''}`);
      context.toast(stopMessage || `${linked.links} koppelingen gemaakt.`, Boolean(stopMessage));
    } catch (error) {
      progress(error.message);
      context.toast(error.message, true);
    }
    state.busy = false;
    $('#rl-stop').hidden = true;
    await load();
    if (state.openId) await openItem(state.openId);
  }

  /**
   * Wist alle AI-koppelingen (handmatige blijven staan).
   * @returns {Promise<void>}
   */
  async function clearAi() {
    if (!window.confirm('Alle koppelingen die door de AI zijn gemaakt wissen? Handmatige koppelingen blijven staan.')) return;
    const out = await context.api('stock/related-ai/clear', { method: 'POST', body: {} });
    context.toast(`${out.removed} AI-koppeling${out.removed === 1 ? '' : 'en'} gewist.`);
    await load();
    if (state.openId) await openItem(state.openId);
  }

  /**
   * Berekent Vaak samen besteld nu opnieuw uit de bestellingen.
   * @returns {Promise<void>}
   */
  async function refreshTogether() {
    const out = await context.api('stock/related/together/refresh', { method: 'POST', body: {} });
    context.toast(`${out.items} artikel${out.items === 1 ? '' : 'en'} met partners berekend.`);
    await load();
  }

  /**
   * Bewaart het gekozen model voor het opzoeken (vraagt recht beheer).
   * @returns {Promise<void>}
   */
  async function saveModel() {
    try {
      await context.api('stock/related-ai/model', { method: 'PUT', body: { model: $('#rl-model').value } });
      context.toast('Model bewaard.');
      await load();
    } catch (error) {
      context.toast(error.message, true);
      await load();
    }
  }

  /**
   * Koppelt de knoppen en velden van het tabblad.
   * @param {{ api: Function, toast: Function, esc: Function }} helpers Hulpfuncties van de pagina.
   * @returns {void}
   */
  function setup(helpers) {
    Object.assign(context, helpers);
    /**
     * Verpakt een handeling zodat een fout als melding verschijnt.
     * @param {Function} work De async handeling.
     * @returns {Function} De verpakte handeling.
     */
    const guarded = (work) => (...args) => work(...args).catch((error) => context.toast(error.message, true));
    let searchTimer = 0;
    $('#rl-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(guarded(load), 250); });
    $('#rl-filter').addEventListener('change', guarded(load));
    $('#rl-ai').addEventListener('click', guarded(runAi));
    $('#rl-stop').addEventListener('click', () => { state.stop = true; progress('Stoppen na de lopende portie…'); });
    $('#rl-clear').addEventListener('click', guarded(clearAi));
    $('#rl-together-refresh').addEventListener('click', guarded(refreshTogether));
    $('#rl-model').addEventListener('change', guarded(saveModel));
    $('#rl-table').addEventListener('click', (event) => {
      const button = event.target.closest('[data-open]');
      if (button) guarded(openItem)(button.dataset.open);
    });
    $('#rl-links').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove]');
      if (button) guarded(removeLink)(button.dataset.remove);
    });
    $('#rl-add-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(guarded(searchToAdd), 250); });
    $('#rl-add-results').addEventListener('click', (event) => {
      const button = event.target.closest('[data-add]');
      if (button) guarded(addLink)(button.dataset.add);
    });
    $('#rl-close').addEventListener('click', () => { state.openId = null; state.detail = null; renderDetail(); });
  }

  window.ArtikelenRelated = { setup, load };
})();
