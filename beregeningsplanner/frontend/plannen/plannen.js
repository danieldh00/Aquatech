// Plannenoverzicht: een tabel met de plannen en hun projectgegevens.
// Een klant ziet zijn eigen plannen (/api/plans); een installateur alle
// plannen van de organisatie (/api/plans?all=1); een beheerder daarbij ook
// verwijderde plannen en per plan de tijdlijn uit de historie
// (/api/admin/plans). De server bepaalt wat iemand mag zien.
(function () {
  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @param {ParentNode} root waarbinnen gezocht wordt (standaard het document)
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  /**
   * Maakt tekst veilig om in HTML te plaatsen.
   * @param {*} value tekst of waarde (null/undefined wordt leeg)
   * @returns {string} tekst met HTML-tekens vervangen door entiteiten
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Formatteert een getal in Nederlandse notatie.
   * @param {number} value het getal
   * @param {number} decimals aantal decimalen (standaard 1)
   * @returns {string} het getal als tekst, of '–' als het geen getal is
   */
  const formatNumber = (value, decimals = 1) => (value == null || !isFinite(value) ? '–' : Number(value).toLocaleString('nl-NL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  /**
   * Formatteert een tijdstip als datum met tijd.
   * @param {string} iso tijdstip in ISO-formaat
   * @returns {string} leesbare datum en tijd, of '–' als er geen tijdstip is
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  const ACTIONS = { aangemaakt: 'Aangemaakt', bijgewerkt: 'Bijgewerkt', verwijderd: 'Verwijderd' };
  /**
   * Geeft de naam van een vlaksoort uit de catalogus.
   * @param {string} type sleutel van de vlaksoort (bijv. 'lawn')
   * @returns {string} leesbare naam, of de sleutel zelf als die onbekend is
   */
  const areaLabel = (type) => (window.Catalog && window.Catalog.areaTypes[type] ? window.Catalog.areaTypes[type].label : type);
  /**
   * Geeft het aantal m² gazon van een plan.
   * @param {object} plan plan uit de lijst (met summary)
   * @returns {number} m² gazon (0 als onbekend)
   */
  const lawnM2 = (plan) => (plan.summary && plan.summary.m2ByType ? plan.summary.m2ByType.lawn || 0 : 0);
  // Controle: een plan van een klant is pas definitief na goedkeuring.
  const REVIEW = { concept: 'Concept', ter_controle: 'Ter controle', goedgekeurd: 'Goedgekeurd' };
  /**
   * Geeft de controlestatus van een plan.
   * @param {object} plan plan uit de lijst
   * @returns {string} 'concept', 'ter_controle' of 'goedgekeurd'
   */
  const reviewOf = (plan) => (plan.review ? plan.review.status : 'concept');
  /**
   * Maakt het statuslabel (pil) van een plan voor in de tabel.
   * @param {object} plan plan uit de lijst
   * @returns {string} HTML van het label
   */
  const reviewPill = (plan) => `<span class="pill rv-${esc(reviewOf(plan))}">${esc(REVIEW[reviewOf(plan)] || reviewOf(plan))}</span>${plan.review && plan.review.via === 'openbaar' ? '<span class="sub">zonder account</span>' : ''}`;

  const state = { me: null, admin: false, team: false, quotes: false, approver: false, plans: [], sort: { key: 'updatedAt', dir: -1 } };

  // Kolommen: key, kop, waarde (voor sorteren/Excel) en weergave.
  const COLUMNS = [
    { key: 'title', label: 'Projectnaam', value: (plan) => plan.title, html: (plan) => `<b>${esc(plan.title)}</b>${plan.customer ? `<span class="sub">${esc(plan.customer)}</span>` : ''}`, cls: 'wrap' },
    { key: 'address', label: 'Adres', value: (plan) => plan.address, html: (plan) => esc(plan.address || '–'), cls: 'wrap' },
    { key: 'owner', label: 'Gebruiker', team: true, value: (plan) => (plan.owner ? plan.owner.displayName : ''), html: (plan) => esc(plan.owner ? plan.owner.displayName : '–') },
    { key: 'review', label: 'Status', value: reviewOf, html: reviewPill },
    { key: 'lawn', label: 'Gazon m²', value: lawnM2, html: (plan) => formatNumber(lawnM2(plan)), cls: 'num' },
    { key: 'totalM2', label: 'Totaal m²', value: (plan) => plan.summary.totalM2, html: (plan) => formatNumber(plan.summary.totalM2), cls: 'num' },
    { key: 'areas', label: 'Vlakken', value: (plan) => plan.summary.areas, html: (plan) => plan.summary.areas, cls: 'num' },
    { key: 'sprinklers', label: 'Sproeiers', value: (plan) => plan.summary.sprinklers, html: (plan) => plan.summary.sprinklers, cls: 'num' },
    { key: 'zones', label: 'Zones', value: (plan) => plan.summary.zones, html: (plan) => plan.summary.zones, cls: 'num' },
    { key: 'createdAt', label: 'Aangemaakt', value: (plan) => plan.createdAt, html: (plan) => esc(when(plan.createdAt)) },
    { key: 'updatedAt', label: 'Laatst gewijzigd', value: (plan) => plan.updatedAt, html: (plan) => esc(when(plan.updatedAt)) },
    { key: 'historyCount', label: 'Aanvragen', admin: true, value: (plan) => plan.historyCount, html: (plan) => plan.historyCount ?? '–', cls: 'num' },
  ];
  /**
   * Geeft de kolommen die deze gebruiker te zien krijgt.
   * @returns {object[]} kolommen uit COLUMNS (zonder beheer-/teamkolommen als die niet gelden)
   */
  const columns = () => COLUMNS.filter((column) => (!column.admin || state.admin) && (!column.team || state.team));

  /**
   * Toont kort een melding onderin het scherm.
   * @param {string} message de tekst
   * @param {boolean} isError true voor een foutmelding (rood)
   */
  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast show${isError ? ' err' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = 'toast'; }, 3500);
  }

  /**
   * Haalt JSON op van de server, zonder cache.
   * @param {string} url adres van de API
   * @returns {Promise<object>} het antwoord; gooit een fout bij een foutstatus
   */
  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  /**
   * Laadt de plannen (eigen, van de organisatie of als beheerder), vult het
   * gebruikersfilter en tekent de tabel.
   * @returns {Promise<void>}
   */
  async function load() {
    const url = state.admin ? `../api/admin/plans${$('#f-deleted').checked ? '?deleted=1' : ''}` : `../api/plans${state.team ? '?all=1' : ''}`;
    try {
      state.plans = (await getJson(url)).items || [];
    } catch (error) {
      $('#p-table').innerHTML = `<tr><td class="empty">Kan de plannen niet laden (${esc(error.message)}).</td></tr>`;
      return;
    }
    if (state.team) {
      const select = $('#f-owner');
      const current = select.value;
      const owners = new Map(state.plans.filter((plan) => plan.owner).map((plan) => [plan.owner.id, plan.owner.displayName]));
      select.innerHTML = '<option value="">Alle gebruikers</option>' + [...owners].sort((left, right) => left[1].localeCompare(right[1]))
        .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
      select.value = owners.has(current) ? current : '';
    }
    render();
  }

  /**
   * Geeft de plannen die door de filters komen, gesorteerd op de gekozen kolom.
   * @returns {object[]} gefilterde en gesorteerde plannen
   */
  function visible() {
    const term = $('#f-search').value.trim().toLowerCase();
    const owner = $('#f-owner').value;
    const review = $('#f-review').value;
    const column = COLUMNS.find((candidate) => candidate.key === state.sort.key) || COLUMNS[0];
    return state.plans
      .filter((plan) => !owner || (plan.owner && plan.owner.id === owner))
      .filter((plan) => !review || reviewOf(plan) === review)
      .filter((plan) => !term || [plan.title, plan.customer, plan.address, plan.owner && plan.owner.displayName].some((value) => String(value || '').toLowerCase().includes(term)))
      .sort((left, right) => {
        const leftValue = column.value(left), rightValue = column.value(right);
        const comparison = typeof leftValue === 'number' || typeof rightValue === 'number' ? (leftValue || 0) - (rightValue || 0) : String(leftValue || '').localeCompare(String(rightValue || ''), 'nl');
        return comparison * state.sort.dir;
      });
  }

  /**
   * Tekent de tegels met totalen boven de tabel.
   * @param {object[]} items de zichtbare plannen
   */
  function renderStats(items) {
    /**
     * Telt een waarde op over alle zichtbare plannen.
     * @param {function(object): number} valueOf geeft de waarde van één plan
     * @returns {number} de som
     */
    const sum = (valueOf) => items.reduce((total, plan) => total + (Number(valueOf(plan)) || 0), 0);
    const owners = new Set(items.map((plan) => plan.owner && plan.owner.id).filter(Boolean)).size;
    const tiles = [
      [items.length, items.length === 1 ? 'plan' : 'plannen'],
      [formatNumber(sum(lawnM2), 0), 'm² gazon'],
      [formatNumber(sum((plan) => plan.summary.totalM2), 0), 'm² in totaal'],
      [sum((plan) => plan.summary.sprinklers), 'sproeiers'],
    ];
    if (state.team) tiles.push([owners, owners === 1 ? 'gebruiker' : 'gebruikers']);
    if (state.approver) tiles.push([items.filter((plan) => reviewOf(plan) === 'ter_controle').length, 'ter controle']);
    $('#stats').innerHTML = tiles.map(([value, label]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
    $('#stats').hidden = !state.plans.length;
  }

  /**
   * Tekent de tabel met plannen en koppelt sorteren, details en openen.
   */
  function render() {
    const items = visible();
    renderStats(items);
    const table = $('#p-table');
    if (!state.plans.length) {
      table.innerHTML = `<tr><td class="empty">Nog geen plannen. Een plan verschijnt hier zodra je in de <a href="../beregening/">beregeningsplanner</a> een vlak tekent.</td></tr>`;
      $('#p-count').textContent = '';
      return;
    }
    const visibleColumns = columns();
    const head = visibleColumns.map((column) => {
      const sorted = column.key === state.sort.key ? (state.sort.dir > 0 ? ' asc' : ' desc') : '';
      return `<th data-sort="${column.key}" class="${column.cls === 'num' ? 'num' : ''}${sorted}">${esc(column.label)}</th>`;
    }).join('');
    table.innerHTML = `<thead><tr>${head}<th></th></tr></thead><tbody>${items.map((plan) => `
      <tr data-id="${esc(plan.id)}" class="${plan.deletedAt ? 'deleted' : ''}">
        ${visibleColumns.map((column) => `<td class="${column.cls || ''}">${column.html(plan)}</td>`).join('')}
        <td>${plan.deletedAt ? '<span class="pill verwijderd">verwijderd</span>' : `<button class="btn small" data-open="${esc(plan.id)}">Openen</button>`}</td>
      </tr>`).join('')}</tbody>`;
    if (!items.length) table.querySelector('tbody').innerHTML = `<tr><td class="empty" colspan="${visibleColumns.length + 1}">Geen plannen gevonden.</td></tr>`;
    table.querySelectorAll('th[data-sort]').forEach((header) => {
      /**
       * Sorteert op deze kolom; nogmaals klikken draait de volgorde om.
       */
      header.onclick = () => {
        const key = header.dataset.sort;
        state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (['title', 'address', 'owner'].includes(key) ? 1 : -1) };
        render();
      };
    });
    table.querySelectorAll('tr[data-id]').forEach((row) => {
      /**
       * Toont de details van het plan (niet bij een klik op Openen).
       * @param {MouseEvent} event de klik
       */
      row.onclick = (event) => {
        if (event.target.closest('[data-open]')) return;
        showDetail(row.dataset.id);
      };
    });
    table.querySelectorAll('[data-open]').forEach((button) => {
      /**
       * Opent het plan in de planner.
       * @returns {Promise<void>}
       */
      button.onclick = () => openPlan(state.plans.find((plan) => plan.id === button.dataset.open));
    });
    $('#p-count').textContent = `${items.length} van ${state.plans.length} plannen`;
  }

  // Eigen plan: openen in de planner. Wie plannen goedkeurt opent ook het
  // plan van een ander zelf (om het te controleren). Anders als kopie, zodat
  // het origineel van de gebruiker niet wijzigt.
  /**
   * Opent een plan in de planner: zelf (eigen plan of als controleur) of als kopie.
   * @param {object} plan plan uit de lijst
   * @param {boolean} copy true om altijd een kopie te openen
   * @returns {Promise<void>}
   */
  async function openPlan(plan, copy = false) {
    const own = !plan.owner || !state.me.user || plan.owner.id === state.me.user.id;
    if (own || (state.approver && !copy)) { location.href = `../beregening/?plan=${encodeURIComponent(plan.id)}`; return; }
    try {
      const fullPlan = await getJson(`../api/plans/${encodeURIComponent(plan.id)}`);
      sessionStorage.setItem('aquatech-open-copy', JSON.stringify(fullPlan.data));
      location.href = '../beregening/?copy=1';
    } catch (error) {
      toast(`Kan plan niet openen: ${error.message}`, true);
    }
  }

  /**
   * Toont het detailvenster van een plan met knoppen (openen, goedkeuren,
   * wissen) en voor een beheerder de historie.
   * @param {string} id id van het plan
   * @returns {Promise<void>}
   */
  async function showDetail(id) {
    const plan = state.plans.find((candidate) => candidate.id === id);
    if (!plan) return;
    const summary = plan.summary || {};
    const m2 = Object.entries(summary.m2ByType || {}).map(([type, value]) => `${esc(areaLabel(type))}: ${formatNumber(value)} m²`).join('<br>');
    const own = !plan.owner || !state.me.user || plan.owner.id === state.me.user.id;
    const review = plan.review || { status: 'concept' };
    const contact = plan.owner && plan.owner.kind === 'gast' && (plan.owner.email || plan.owner.phone)
      ? `<dt>Contact</dt><dd>${plan.owner.email ? `<a href="mailto:${esc(plan.owner.email)}">${esc(plan.owner.email)}</a>` : ''}${plan.owner.email && plan.owner.phone ? '<br>' : ''}${plan.owner.phone ? `<a href="tel:${esc(plan.owner.phone)}">${esc(plan.owner.phone)}</a>` : ''}</dd>` : '';
    const approved = review.status === 'goedgekeurd';
    $('#detail-body').innerHTML = `
      <h2>${esc(plan.title)}</h2>
      ${plan.deletedAt ? '<span class="pill verwijderd">verwijderd</span>' : ''}
      <dl class="kv">
        <dt>Klant</dt><dd>${esc(plan.customer || '–')}</dd>
        <dt>Adres</dt><dd>${esc(plan.address || '–')}</dd>
        ${plan.owner ? `<dt>Gebruiker</dt><dd>${esc(plan.owner.displayName)}${plan.owner.kind === 'gast' ? ' (zonder account)' : ` (${esc(plan.owner.username)})`}</dd>` : ''}
        ${contact}
        <dt>Status</dt><dd><span class="pill rv-${esc(review.status)}">${esc(REVIEW[review.status] || review.status)}</span>${review.via === 'openbaar' ? ' ingediend zonder account' : ''}${approved && review.reviewedBy ? ` door ${esc(review.reviewedBy)} op ${esc(when(review.reviewedAt))}` : ''}${review.status === 'ter_controle' && review.requestedAt ? ` sinds ${esc(when(review.requestedAt))}` : ''}</dd>
        ${review.question ? `<dt>Vraag</dt><dd class="wrap">${esc(review.question)}</dd>` : ''}
        <dt>Vlakken</dt><dd>${summary.areas ?? 0} (${formatNumber(summary.totalM2)} m²)</dd>
        ${m2 ? `<dt>Per soort</dt><dd>${m2}</dd>` : ''}
        <dt>Sproeiers</dt><dd>${summary.sprinklers ?? 0}</dd>
        <dt>Zones</dt><dd>${summary.zones ?? 0}</dd>
        <dt>Elementen</dt><dd>${summary.elements ?? 0}</dd>
        <dt>Aangemaakt</dt><dd>${esc(when(plan.createdAt))}</dd>
        <dt>Laatst gewijzigd</dt><dd>${esc(when(plan.updatedAt))}</dd>
        ${plan.deletedAt ? `<dt>Verwijderd</dt><dd>${esc(when(plan.deletedAt))}</dd>` : ''}
      </dl>
      <div class="actions">${plan.deletedAt ? '' : `<button class="btn primary" id="d-open">${own || state.approver ? (review.status === 'ter_controle' && state.approver ? 'Controleren in de planner' : 'Openen in de planner') : 'Kopie openen in de planner'}</button>
        ${!own && state.approver ? '<button class="btn" id="d-copy">Kopie openen</button>' : ''}
        ${state.approver ? `<button class="btn" id="d-review">${approved ? 'Goedkeuring intrekken' : 'Goedkeuren'}</button>` : ''}
        ${state.quotes && approved ? `<a class="btn" href="../offertes/?plan=${encodeURIComponent(plan.id)}">Offerte maken</a>` : ''}`}
        ${state.admin ? '<button class="btn" id="d-purge">Definitief wissen</button>' : ''}</div>
      ${state.admin ? '<h3>Historie</h3><div id="d-history" class="muted small">Laden…</div>' : ''}`;
    const openButton = $('#d-open');
    if (openButton) {
      /**
       * Opent het plan in de planner.
       * @returns {Promise<void>}
       */
      openButton.onclick = () => openPlan(plan);
    }
    const copyButton = $('#d-copy');
    if (copyButton) {
      /**
       * Opent een kopie van het plan in de planner.
       * @returns {Promise<void>}
       */
      copyButton.onclick = () => openPlan(plan, true);
    }
    const reviewButton = $('#d-review');
    if (reviewButton) {
      /**
       * Keurt het plan goed of trekt de goedkeuring in.
       * @returns {Promise<void>}
       */
      reviewButton.onclick = async () => {
        reviewButton.disabled = true;
        try {
          const res = await fetch(`../api/plans/${encodeURIComponent(plan.id)}/review`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: approved ? 'reopen' : 'approve' }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
          plan.review = body.review;
          toast(approved ? 'Goedkeuring ingetrokken' : 'Plan goedgekeurd');
          render();
          showDetail(plan.id);
        } catch (error) {
          toast(`Lukt niet: ${error.message}`, true);
          reviewButton.disabled = false;
        }
      };
    }
    const purgeButton = $('#d-purge');
    if (purgeButton) {
      // AVG-verzoek: plan en de inhoud van de historie (kopieën, klant, adres) weg.
      /**
       * Wist het plan definitief na bevestiging (AVG-verzoek).
       * @returns {Promise<void>}
       */
      purgeButton.onclick = async () => {
        if (!confirm(`"${plan.title}" definitief wissen, inclusief klantgegevens en kopieën in de historie? Dit kan niet ongedaan worden gemaakt (oude back-ups bevatten het plan nog tot ze verlopen).`)) return;
        try {
          const res = await fetch(`../api/admin/plans/${encodeURIComponent(plan.id)}`, { method: 'DELETE', cache: 'no-store' });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
          $('#detail').hidden = true;
          toast('Plan definitief gewist');
          load();
        } catch (error) {
          toast(`Wissen mislukt: ${error.message}`, true);
        }
      };
    }
    $('#detail').hidden = false;
    if (!state.admin) return;
    try {
      const { items } = await getJson(`../api/admin/plans/${encodeURIComponent(plan.id)}/history`);
      $('#d-history').innerHTML = items.length ? `<ul class="timeline">${items.map((entry) => `
        <li><span class="pill ${esc(entry.action)}">${esc(ACTIONS[entry.action] || entry.action)}</span>
          ${entry.user ? esc(entry.user.displayName) : ''} · ${esc(entry.title)}
          <div class="when">${esc(when(entry.createdAt))}${entry.updatedAt !== entry.createdAt ? ` – ${esc(when(entry.updatedAt))}` : ''} · ${entry.summary.areas ?? 0} vlakken, ${entry.summary.sprinklers ?? 0} sproeiers</div></li>`).join('')}</ul>`
        : 'Geen historie.';
    } catch (error) {
      $('#d-history').textContent = `Kan de historie niet laden (${error.message}).`;
    }
  }

  /**
   * Exporteert de zichtbare plannen naar een Excel-bestand (.xlsx).
   * @returns {Promise<void>}
   */
  async function exportXlsx() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const items = visible();
    const exportButton = $('#f-export');
    exportButton.disabled = true;
    try {
      const types = [...new Set(items.flatMap((plan) => Object.keys(plan.summary.m2ByType || {})))];
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'AquaTech Service';
      workbook.created = new Date();
      const worksheet = workbook.addWorksheet('Plannen', { views: [{ state: 'frozen', ySplit: 1 }] });
      const dateFmt = { numFmt: 'dd-mm-yyyy hh:mm' };
      worksheet.columns = [
        { header: 'Projectnaam', key: 'title', width: 30 },
        { header: 'Klant', key: 'customer', width: 24 },
        { header: 'Adres', key: 'address', width: 30 },
        ...(state.team ? [{ header: 'Gebruiker', key: 'owner', width: 22 }] : []),
        { header: 'Status', key: 'review', width: 14 },
        { header: 'Vraag', key: 'question', width: 36 },
        { header: 'Vlakken', key: 'areas', width: 9 },
        { header: 'Totaal m²', key: 'totalM2', width: 11, style: { numFmt: '0.0' } },
        ...types.map((type) => ({ header: `${areaLabel(type)} m²`, key: `m2_${type}`, width: 14, style: { numFmt: '0.0' } })),
        { header: 'Sproeiers', key: 'sprinklers', width: 10 },
        { header: 'Zones', key: 'zones', width: 8 },
        { header: 'Elementen', key: 'elements', width: 10 },
        { header: 'Aangemaakt', key: 'createdAt', width: 18, style: dateFmt },
        { header: 'Laatst gewijzigd', key: 'updatedAt', width: 18, style: dateFmt },
        ...(state.admin ? [{ header: 'Aanvragen', key: 'historyCount', width: 11 }, { header: 'Verwijderd', key: 'deletedAt', width: 18, style: dateFmt }] : []),
      ];
      for (const plan of items) {
        const summary = plan.summary || {};
        const row = {
          title: plan.title, customer: plan.customer, address: plan.address, owner: plan.owner ? plan.owner.displayName : '',
          review: REVIEW[reviewOf(plan)] || reviewOf(plan), question: plan.review ? plan.review.question : '',
          areas: summary.areas, totalM2: summary.totalM2, sprinklers: summary.sprinklers, zones: summary.zones, elements: summary.elements,
          createdAt: new Date(plan.createdAt), updatedAt: new Date(plan.updatedAt), historyCount: plan.historyCount,
          deletedAt: plan.deletedAt ? new Date(plan.deletedAt) : null,
        };
        for (const type of types) row[`m2_${type}`] = (summary.m2ByType || {})[type];
        worksheet.addRow(row);
      }
      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
      worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: worksheet.columns.length } };
      const blob = new Blob([await workbook.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `plannen_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      toast(`${items.length} plannen geëxporteerd`);
    } catch (error) {
      toast(`Export mislukt: ${error.message}`, true);
    } finally {
      exportButton.disabled = false;
    }
  }

  /**
   * Start de pagina: rechten bepalen, teksten en filters instellen en de
   * plannen laden.
   * @returns {Promise<void>}
   */
  async function init() {
    state.me = await window.AquatechAccount.load('../');
    const rights = state.me.rights || [];
    state.admin = rights.includes('beheer');
    state.team = rights.includes('plannen.alle');
    state.quotes = rights.includes('offertes');
    state.approver = rights.includes('plannen.goedkeuren');
    $('#p-heading').textContent = state.team ? 'Alle plannen' : 'Mijn plannen';
    $('#p-intro').textContent = state.admin
      ? 'Alle plannen van alle gebruikers. Klik op een plan voor de details en de historie van de aanvragen.'
      : state.team
        ? 'Alle plannen van de organisatie. Klik op een plan voor de details, open het in de planner of maak er een offerte van.'
        : 'Je eigen beregeningsplannen. Klik op een plan voor de details of open het in de planner.';
    $('#f-owner').hidden = !state.team;
    $('#f-deleted-wrap').hidden = !state.admin;
    let searchTimer;
    /**
     * Tekent de tabel opnieuw kort nadat er gezocht is.
     */
    $('#f-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 150); };
    $('#f-owner').onchange = render;
    // Direct naar wat er te controleren is: ?review=ter_controle.
    const wanted = new URLSearchParams(location.search).get('review');
    if (wanted && REVIEW[wanted]) $('#f-review').value = wanted;
    $('#f-review').onchange = render;
    $('#f-deleted').onchange = load;
    $('#f-export').onclick = exportXlsx;
    /**
     * Sluit het detailvenster.
     */
    $('#detail-close').onclick = () => { $('#detail').hidden = true; };
    /**
     * Sluit het detailvenster bij een klik naast het venster.
     * @param {MouseEvent} event de klik
     */
    $('#detail').onclick = (event) => { if (event.target.id === 'detail') $('#detail').hidden = true; };
    if (!state.me.user && !state.me.guest) {
      $('#p-table').innerHTML = '<tr><td class="empty">Log eerst in om je plannen te zien. <a href="../login">Inloggen</a></td></tr>';
      return;
    }
    load();
  }

  init();
})();
