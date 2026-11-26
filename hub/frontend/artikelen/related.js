// Gerelateerde artikelen (module Artikelen, tabblad Past bij): per artikel de koppelingen "Past bij" instellen (handmatig, of door de AI met reden en bron),
// "Vaak samen besteld" bekijken en de AI-ronde starten (specificaties opzoeken in porties, daarna koppelen met vaste regels).
// Handmatige koppelingen blijven altijd staan; een AI-koppeling is herkenbaar, per artikel te wissen en met één knop in één keer.
// Praat met /api/stock/related en /api/stock/related-ai (recht voorraad).
(function () {
  const context = { api: null, toast: null, esc: null };
<<<<<<< HEAD
  const state = { data: null, ai: null, openId: null, detail: null, busy: false, polling: false, seen: false };
=======
  const state = { data: null, ai: null, openId: null, detail: null, busy: false, stop: false, wp: null, wpPick: null, wpTimer: 0 };
>>>>>>> 47b9a05 (WordPress-orderhistorie voor Vaak samen besteld (WIP))

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
<<<<<<< HEAD
    followAi().catch(() => {});
=======
    await loadWp();
  }

  /**
   * Laadt de stand van de WordPress-orderhistorie en tekent het paneel; zolang het ophalen loopt wordt elke 3 seconden ververst.
   * @returns {Promise<void>}
   */
  async function loadWp() {
    clearTimeout(state.wpTimer);
    state.wp = await context.api('stock/related/wp-orders');
    renderWp();
    if (state.wp.status.running) state.wpTimer = setTimeout(() => loadWp().catch(() => {}), 3000);
  }

  /** Tekent de stand, de knoppen en de lijst met producten zonder artikel. */
  function renderWp() {
    const { status, unmatched } = state.wp;
    /**
     * Zet een tijdstip om naar een Nederlandse datum.
     * @param {string} value ISO-tijd.
     * @returns {string} De datum, of leeg.
     */
    const date = (value) => (value ? new Date(value).toLocaleDateString('nl-NL') : '');
    const parts = [];
    if (status.running) parts.push('Bezig met ophalen… dit gaat door als je dit venster sluit.');
    if (status.lines) parts.push(`${status.orders} bestellingen (${date(status.from)} t/m ${date(status.to)}), ${status.lines} regels, waarvan ${status.matched} aan een artikel gekoppeld${status.unmatched ? ` en ${status.unmatched} nog niet` : ''}.`);
    else if (!status.running) parts.push('Nog niets opgehaald.');
    if (status.customers) parts.push(`${status.customers} klant${status.customers === 1 ? '' : 'en'} aangemaakt.`);
    if (status.enabled && !status.running) parts.push('Wordt elk uur bijgewerkt.');
    if (status.finishedAt && !status.running) parts.push(`Laatst klaar: ${new Date(status.finishedAt).toLocaleString('nl-NL')}.`);
    if (status.error) parts.push(`Laatste fout: ${status.error}`);
    $('#rl-wp-status').textContent = parts.join(' ');
    $('#rl-wp-start').disabled = status.running;
    $('#rl-wp-stop').hidden = !status.enabled;
    $('#rl-wp-months').value = status.months;
    $('#rl-wp-table').innerHTML = unmatched.length
      ? `<thead><tr><th>Product</th><th>SKU</th><th>Bestellingen</th><th></th></tr></thead><tbody>${unmatched.map((group, index) => `<tr>
          <td class="wrap">${context.esc(group.name || '(zonder naam)')}</td><td>${context.esc(group.sku)}</td><td>${group.orders}</td>
          <td><button class="linkbtn" data-wp-pick="${index}" type="button">Koppelen</button></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Alle opgehaalde producten zijn gekoppeld.</td></tr></tbody>';
  }

  /**
   * Start het ophalen van de WordPress-orders (serverjob).
   * @returns {Promise<void>}
   */
  async function startWp() {
    const months = Number($('#rl-wp-months').value) || 24;
    const out = await context.api('stock/related/wp-orders/start', { method: 'POST', body: { months } });
    context.toast(out.started ? 'Ophalen gestart.' : 'Er loopt al een ronde.');
    await loadWp();
  }

  /**
   * Zet het uurlijks bijwerken uit.
   * @returns {Promise<void>}
   */
  async function stopWp() {
    await context.api('stock/related/wp-orders/stop', { method: 'POST', body: {} });
    context.toast('Uurlijks bijwerken staat uit.');
    await loadWp();
  }

  /**
   * Zoekt artikelen om een product uit de oude orders aan te koppelen.
   * @returns {Promise<void>}
   */
  async function searchWpItems() {
    const term = $('#rl-wp-search').value.trim();
    if (term.length < 2) { $('#rl-wp-results').innerHTML = ''; return; }
    const data = await context.api(`stock/related?${new URLSearchParams({ q: term, filter: 'alle' })}`);
    $('#rl-wp-results').innerHTML = data.items.slice(0, 8).map((item) => `<li><div><b>${context.esc(item.name)}</b> <span class="muted">${context.esc(item.code)}</span></div>
      <button class="linkbtn" data-wp-link="${context.esc(item.id)}" type="button">Koppelen</button></li>`).join('') || '<li class="muted">Niets gevonden.</li>';
  }

  /**
   * Koppelt de gekozen groep aan een artikel.
   * @param {string} itemId Id van het artikel.
   * @returns {Promise<void>}
   */
  async function linkWp(itemId) {
    const group = state.wpPick;
    if (!group) return;
    const out = await context.api('stock/related/wp-orders/link', { method: 'POST', body: { ...group, itemId } });
    context.toast(`${out.updated} regel${out.updated === 1 ? '' : 's'} gekoppeld. Vaak samen besteld wordt bij de volgende ronde bijgewerkt.`);
    state.wpPick = null; $('#rl-wp-pick').hidden = true; $('#rl-wp-results').innerHTML = ''; $('#rl-wp-search').value = '';
    await loadWp();
>>>>>>> 47b9a05 (WordPress-orderhistorie voor Vaak samen besteld (WIP))
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
   * Volgt de achtergrondtaak op de server: vraagt elke paar seconden de stand op tot de taak klaar is en ververst dan de lijst. Zonder lopende taak gebeurt er niets.
   * @returns {Promise<void>}
   */
  async function followAi() {
    if (state.polling) return;
    state.polling = true;
    let wasRunning = false;
    try {
      let job = await context.api('stock/related-ai/job');
      while (job.running && document.body.contains($('#rl-ai'))) {
        wasRunning = true;
        state.busy = true;
        $('#rl-ai').disabled = true;
        $('#rl-stop').hidden = false;
        const tally = job.tally || {};
        progress(`Loopt op de server (je mag dit venster sluiten): ${job.processed} van ${job.total} artikelen opgezocht, ${tally.gevonden || 0} met specificaties.${job.stopRequested ? ' Stopt na de lopende portie…' : ''}`);
        await new Promise((resolve) => { setTimeout(resolve, 3000); });
        job = await context.api('stock/related-ai/job');
      }
      if (job.startedAt && (wasRunning || !state.seen)) {
        const tally = job.tally || {};
        const extra = job.extra ? ` ${job.extra.links} koppelingen voor ${job.extra.items} artikelen.` : '';
        progress(`${tally.gevonden || 0} met specificaties gevonden, ${tally.niet_gevonden || 0} zonder bron (niet gekoppeld)${tally.error ? `, ${tally.error} mislukt` : ''}.${extra} ${job.message || ''}`.trim());
      }
      state.seen = true;
      if (wasRunning) context.toast(job.aborted ? job.message : 'Opzoeken klaar.', Boolean(job.aborted));
    } catch (error) {
      progress(error.message);
      context.toast(error.message, true);
    } finally {
      state.busy = false;
      state.polling = false;
      $('#rl-stop').hidden = true;
    }
    if (wasRunning) {
      await load();
      if (state.openId) await openItem(state.openId);
    }
  }

  /**
   * Start de AI-ronde als achtergrondtaak op de server: alle artikelen zonder uitkomst worden opgezocht en daarna gekoppeld met de vaste regels, ook als dit venster
   * sluit. Vraagt eerst bevestiging met de geschatte kosten; wat al gevonden is blijft bewaard.
   * @returns {Promise<void>}
   */
  async function runAi() {
    const again = $('#rl-again').checked;
    const todo = await context.api(`stock/related/ai/todo?again=${again ? '1' : '0'}`);
    if (todo.ids.length) {
      const question = `De AI zoekt de specificaties van ${todo.ids.length} artikelen op internet (model ${state.ai.modelLabel}). Geschatte kosten ongeveer € ${todo.estimateEur.toFixed(2).replace('.', ',')}; het echte verbruik zie je in Beheer > AI-kosten. Er wordt alleen gekoppeld als een bron de aansluiting noemt. Dit loopt op de server door, ook als je het venster sluit. Doorgaan?`;
      if (!window.confirm(question)) return;
    }
    await context.api('stock/related-ai/job', { method: 'POST', body: { again } });
    await followAi();
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
    $('#rl-stop').addEventListener('click', guarded(async () => { await context.api('stock/related-ai/job/stop', { method: 'POST', body: {} }); }));
    $('#rl-clear').addEventListener('click', guarded(clearAi));
    $('#rl-together-refresh').addEventListener('click', guarded(refreshTogether));
    $('#rl-model').addEventListener('change', guarded(saveModel));
    $('#rl-wp-start').addEventListener('click', guarded(startWp));
    $('#rl-wp-stop').addEventListener('click', guarded(stopWp));
    $('#rl-wp-table').addEventListener('click', (event) => {
      const button = event.target.closest('[data-wp-pick]');
      if (!button) return;
      state.wpPick = state.wp.unmatched[Number(button.dataset.wpPick)] || null;
      if (!state.wpPick) return;
      $('#rl-wp-pick-name').textContent = state.wpPick.name || state.wpPick.sku || 'product';
      $('#rl-wp-pick').hidden = false;
      $('#rl-wp-search').focus();
    });
    $('#rl-wp-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(guarded(searchWpItems), 250); });
    $('#rl-wp-results').addEventListener('click', (event) => {
      const button = event.target.closest('[data-wp-link]');
      if (button) guarded(linkWp)(button.dataset.wpLink);
    });
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
