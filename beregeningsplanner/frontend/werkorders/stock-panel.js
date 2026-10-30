// Voorraad bij een werkorder: per artikel uit de materiaallijst wat nodig is,
// wat er gereserveerd en afgeboekt staat en wat er nog beschikbaar is
// (/api/stock/workorders/:id). Reserveren gaat vanzelf bij elke wijziging van
// de werkorder; afboeken vanzelf als hij Gereed wordt, of hier met de hand
// (alles wat gereserveerd staat, of per regel een aantal; negatief = retour).
(function () {
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Getal in Nederlandse notatie (hoogstens 3 decimalen).
   * @param {*} value Het getal.
   * @returns {string} Bijv. "1.234,5".
   */
  const formatNumber = (value) => (Number(value) || 0).toLocaleString('nl-NL', { maximumFractionDigits: 3 });
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15" (leeg zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const KINDS = { ontvangst: 'Ontvangst', afboeking: 'Afboeking', retour: 'Retour', correctie: 'Correctie', telling: 'Telling' };
  const state = { workOrder: null, data: null, options: {}, seq: 0 };
  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);

  /**
   * Roept de API aan (relatief vanaf werkorders/).
   * @param {string} path Pad onder api/.
   * @param {object} [options] { method, body }; body gaat als JSON.
   * @returns {Promise<object>} Het antwoord (fout = Error met `code`).
   */
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`../api/${path}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.message || `HTTP ${res.status}`), { code: out.error });
    return out;
  }
  /**
   * Toont een melding via de werkorderpagina (als die een toast meegaf).
   * @param {string} message De melding.
   * @param {boolean} [isError] true = foutmelding.
   * @returns {*} Wat de toast teruggeeft (null zonder toast).
   */
  const toast = (message, isError) => (state.options.toast ? state.options.toast(message, isError) : null);

  /**
   * Statuslabel van een artikelregel: tekort, afgeboekt, gereserveerd of extra.
   * @param {object} line Artikelregel uit de voorraad-API.
   * @returns {string} HTML van het label.
   */
  function statusOf(line) {
    if (line.shortage > 0) return `<span class="pill st-short">Tekort ${esc(formatNumber(line.shortage))}</span>`;
    if (line.needed > 0 && line.issued >= line.needed) return '<span class="pill st-done">Afgeboekt</span>';
    if (line.reserved > 0) return '<span class="pill st-ok">Gereserveerd</span>';
    if (!line.needed && line.issued) return '<span class="pill">Extra</span>';
    return '<span class="pill">–</span>';
  }

  /** Tekent de artikelregels, de ontbrekende artikelen en de boekingen op deze werkorder. */
  function render() {
    const container = $('#st-body');
    const stock = state.data;
    if (!container || !stock) return;
    const stockLink = state.options.manage ? '../artikelen/' : null;
    const open = ['open', 'gepland', 'bezig'].includes(stock.workOrder.status);
    const reserved = stock.lines.reduce((count, line) => count + (line.reserved > 0 ? 1 : 0), 0);
    const shortCount = stock.lines.filter((line) => line.shortage > 0).length;
    $('#st-summary').textContent = stock.lines.length
      ? `${reserved} van ${stock.lines.length} artikelen gereserveerd${shortCount ? ` · tekort bij ${shortCount}` : ''}`
      : '';
    const rows = stock.lines.map((line) => `<tr data-code="${esc(line.code)}"${line.shortage > 0 ? ' class="bad"' : ''}>
      <td><b>${esc(line.code)}</b><span class="sub">${esc(line.name)}${line.location ? ` · ${esc(line.location)}` : ''}</span></td>
      <td class="num">${esc(formatNumber(line.needed))} ${esc(line.unit)}</td>
      <td class="num">${esc(formatNumber(line.issued))}</td>
      <td class="num">${esc(formatNumber(line.reserved))}</td>
      <td class="num">${esc(formatNumber(line.onHand))}<span class="sub">vrij ${esc(formatNumber(line.available))}</span></td>
      <td>${statusOf(line)}</td>
      <td class="st-act"><input type="number" step="any" inputmode="decimal" aria-label="Aantal" placeholder="${line.needed > line.issued ? esc(formatNumber(line.needed - line.issued)) : ''}">
        <button class="btn small" data-issue>Afboeken</button><button class="btn small ghost" data-return title="Terug op voorraad">Retour</button></td>
    </tr>`).join('');
    const missing = stock.notInStock.length
      ? `<p class="muted small">Niet op voorraad bijgehouden: ${stock.notInStock.map((material) => `<span class="code">${esc(material.code)}</span>`).join(' ')}${stockLink ? ` · <a href="${stockLink}?codes=${encodeURIComponent(stock.notInStock.map((material) => material.code).join(','))}">Op voorraad nemen</a>` : ''}</p>`
      : '';
    const moves = stock.movements.length ? `<details class="st-moves"><summary>Geboekt op deze werkorder (${stock.movements.length})</summary>
      <table class="grid"><tbody>${stock.movements.map((movement) => `<tr><td>${esc(when(movement.createdAt))}</td><td>${esc(KINDS[movement.kind] || movement.kind)}</td>
        <td><span class="code">${esc(movement.code)}</span> ${esc(movement.name)}</td><td class="num">${esc(formatNumber(-movement.qty))} ${esc(movement.unit)}</td><td class="muted">${esc(movement.userName)}${movement.note ? ` · ${esc(movement.note)}` : ''}</td></tr>`).join('')}</tbody></table></details>` : '';
    container.innerHTML = stock.lines.length || stock.notInStock.length ? `${stock.lines.length ? `<div class="tablewrap"><table class="grid st-lines">
        <thead><tr><th>Artikel</th><th class="num">Nodig</th><th class="num">Afgeboekt</th><th class="num">Gereserveerd</th><th class="num">Op voorraad</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : ''}
      ${missing}
      ${stock.usage ? '<p class="muted small">Het geregistreerde materiaalverbruik wordt van de voorraad afgeboekt; bij Gereed vervalt de rest van de reservering.</p>'
        : open && reserved ? '<p class="muted small">Wordt de werkorder Gereed, dan wordt wat nog gereserveerd staat vanzelf afgeboekt.</p>' : ''}
      ${reserved ? '<div class="row"><button class="btn" data-issue-all>Alles afboeken wat gereserveerd staat</button></div>' : ''}
      ${moves}`
      : `<p class="muted small">Geen materialen met een artikelcode op deze werkorder.${stockLink ? ' Voorraad bijhouden doe je in <a href="../artikelen/">Artikelen</a>.' : ''}</p>`;
    container.querySelectorAll('tr[data-code]').forEach((row) => {
      const input = row.querySelector('input');
      /**
       * Boekt het ingevulde (of voorgestelde) aantal af of terug.
       * @param {number} sign 1 = afboeken, -1 = retour.
       */
      const book = (sign) => {
        const quantity = Number(String(input.value || input.placeholder).replace(',', '.'));
        if (!(quantity > 0)) { toast('Vul een aantal in.', true); return; }
        issue([{ code: row.dataset.code, qty: sign * quantity }], sign > 0 ? 'Afgeboekt' : 'Retour geboekt');
      };
      /**
       * Boekt het aantal af.
       * @returns {void}
       */
      row.querySelector('[data-issue]').onclick = () => book(1);
      /**
       * Boekt het aantal terug (retour).
       * @returns {void}
       */
      row.querySelector('[data-return]').onclick = () => book(-1);
    });
    const issueAllButton = container.querySelector('[data-issue-all]');
    if (issueAllButton) {
      /**
       * Boekt alles af wat gereserveerd staat.
       * @returns {Promise<void>}
       */
      issueAllButton.onclick = () => issue(undefined, 'Gereserveerde materialen afgeboekt');
    }
  }

  /**
   * Boekt materialen af (of retour) en tekent het blok opnieuw.
   * @param {object[]} [lines] [{ code, qty }]; zonder lines alles wat gereserveerd staat.
   * @param {string} doneMessage Melding na gelukt boeken.
   * @returns {Promise<void>}
   */
  async function issue(lines, doneMessage) {
    try {
      state.data = await api(`stock/workorders/${encodeURIComponent(state.workOrder.id)}/issue`, { method: 'POST', body: lines ? { lines } : {} });
      render();
      toast(doneMessage);
    } catch (error) {
      toast(error.message, true);
    }
  }

  /**
   * Haalt de voorraad van de werkorder opnieuw op; een ouder antwoord wordt genegeerd.
   * @param {object} [workOrder] De werkorder (standaard de huidige).
   * @returns {Promise<void>}
   */
  async function refresh(workOrder = state.workOrder) {
    if (!workOrder || !$('#st-card')) return;
    state.workOrder = workOrder;
    const requestNumber = ++state.seq;
    try {
      const data = await api(`stock/workorders/${encodeURIComponent(workOrder.id)}`);
      if (requestNumber !== state.seq) return;
      state.data = data;
      $('#st-card').hidden = false;
      render();
    } catch (error) {
      if (requestNumber === state.seq) $('#st-card').hidden = true;
    }
  }

  /**
   * Opent het voorraadblok voor een werkorder.
   * @param {object} workOrder De werkorder.
   * @param {object} [options] { toast, manage (recht 'voorraad': link naar Artikelen) }.
   */
  function open(workOrder, options = {}) {
    state.options = options;
    state.data = null;
    const body = $('#st-body');
    if (body) body.innerHTML = '<p class="muted small">Voorraad laden…</p>';
    refresh(workOrder);
  }

  window.WorkOrderStock = { open, refresh };
})();
