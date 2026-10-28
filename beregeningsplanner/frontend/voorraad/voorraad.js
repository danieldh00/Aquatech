// Voorraadbeheer: overzicht van de voorraad (stand, gereserveerd, beschikbaar),
// de reserveringen van open werkorders, het logboek met mutaties en per
// artikel (?id=) de gegevens, mutaties boeken (ontvangst, telling, correctie)
// en de geschiedenis. Gegevens uit /api/stock (recht 'voorraad'). Artikelcodes
// zijn die van de catalogus (window.Catalog), zodat stuklijst, offerte en
// werkorder vanzelf aan de voorraad gekoppeld zijn. Export als Excel.
(function () {
  const WorkOrderCore = window.WorkOrderCore;
  const Catalog = window.Catalog || { articles: {} };
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
   * Formatteert een aantal in Nederlandse notatie.
   * @param {number} value het aantal
   * @param {number} decimals maximaal aantal decimalen (standaard 3)
   * @returns {string} het aantal als tekst
   */
  const nl = (value, decimals = 3) => (Number(value) || 0).toLocaleString('nl-NL', { maximumFractionDigits: decimals });
  /**
   * Formatteert een bedrag in euro's.
   * @param {number|null} value het bedrag
   * @returns {string} bijv. '€ 12,50', of leeg zonder bedrag
   */
  const eur = (value) => (value == null ? '' : (Number(value) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' }));
  /**
   * Formatteert een tijdstip als datum met tijd.
   * @param {string} iso tijdstip in ISO-formaat
   * @returns {string} leesbare datum en tijd, of leeg
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  /**
   * Formatteert een datum kort.
   * @param {string} iso datum als 'jjjj-mm-dd'
   * @returns {string} bijv. '3 nov 2026', of leeg
   */
  const day = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  /**
   * Leest een getal uit een invoerveld (komma of punt).
   * @param {string} value de invoer
   * @returns {number|null} het getal, of null bij lege invoer
   */
  const num = (value) => (String(value).trim() === '' ? null : Number(String(value).replace(',', '.')));
  const KINDS = { ontvangst: 'Ontvangst', afboeking: 'Afboeking', retour: 'Retour', correctie: 'Correctie', telling: 'Telling' };

  const state = { items: [], reservations: [], moves: null, tab: 'stock', item: null };

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
   * Roept de API aan en geeft de JSON terug.
   * @param {string} url pad na '../api/'
   * @param {{method: string, body: object}} request methode en inhoud (standaard GET zonder inhoud)
   * @returns {Promise<object>} het antwoord; gooit een fout met code, field en status bij een foutstatus
   */
  async function api(url, { method = 'GET', body } = {}) {
    const res = await fetch(`../api/${url}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(result.message || `HTTP ${res.status}`), { code: result.error, field: result.field, status: res.status });
    return result;
  }

  /**
   * Maakt een link naar een werkorder.
   * @param {object} workOrder werkorder met id en number
   * @returns {string} HTML van de link, of leeg zonder werkorder
   */
  const woLink = (workOrder) => (workOrder && workOrder.id ? `<a href="../werkorders/?id=${encodeURIComponent(workOrder.id)}">${esc(workOrder.number || 'werkorder')}</a>` : '');
  /**
   * Stand van de webshopkoppeling per artikel.
   * @param {object} item het voorraadartikel
   * @returns {string} HTML van het label
   */
  const shopPill = (item) => {
    if (!item.shopSync) return '<span class="muted small">niet</span>';
    if (!item.shop.productId) return '<span class="muted small">niet gekoppeld</span>';
    if (item.shop.error) return `<span class="pill low" title="${esc(item.shop.error)}">Fout</span>`;
    if (item.shop.pending) return '<span class="pill">Wordt bijgewerkt</span>';
    return `<span class="pill ok" title="${esc(item.shop.syncedAt ? `Bijgewerkt ${when(item.shop.syncedAt)}` : '')}">Gekoppeld</span>`;
  };
  /**
   * Maakt het label van een soort mutatie.
   * @param {string} kind bijv. 'ontvangst' of 'telling'
   * @returns {string} HTML van het label
   */
  const kindPill = (kind) => `<span class="pill k-${esc(kind)}">${esc(KINDS[kind] || kind)}</span>`;

  // ---------- Overzicht ----------
  /**
   * Geeft de artikelen die door de zoekterm en het filter "onder minimum" komen.
   * @returns {object[]} de zichtbare artikelen
   */
  function visible() {
    const term = $('#f-search').value.trim().toLowerCase();
    const low = $('#f-low').checked;
    return state.items.filter((item) => (!low || item.low) && (!term || `${item.code} ${item.name} ${item.location}`.toLowerCase().includes(term)));
  }

  /** Tekent de tellers boven het overzicht. */
  function renderStats() {
    const live = state.items.filter((item) => !item.archived);
    const value = live.reduce((total, item) => total + (item.value || 0), 0);
    const orders = new Set(state.reservations.map((reservation) => reservation.workOrder.id)).size;
    $('#v-stats').innerHTML = [
      [live.length, 'artikelen op voorraad'],
      [live.filter((item) => item.low).length, 'onder de minimumvoorraad'],
      [live.filter((item) => item.available < 0).length, 'met tekort (meer gereserveerd dan er ligt)'],
      [orders, 'open werkorders met een reservering'],
      [eur(value), 'voorraadwaarde (inkoop)'],
    ].map(([value, label]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
    $('#t-reserved').textContent = state.reservations.length ? String(state.reservations.length) : '';
  }

  /** Tekent de voorraadtabel. */
  function renderStock() {
    const table = $('#s-table');
    if (!state.items.length) {
      table.innerHTML = '<tbody><tr><td class="empty">Nog geen voorraadartikelen. Kies <b>Uit catalogus</b> om artikelen uit de stuklijst op voorraad te nemen, of <b>+ Artikel</b> voor een eigen artikel.</td></tr></tbody>';
      return;
    }
    const items = visible();
    table.innerHTML = `<thead><tr><th>Artikel</th><th>Locatie</th><th class="num">Op voorraad</th><th class="num">Gereserveerd</th><th class="num">Beschikbaar</th><th class="num">Minimum</th><th class="num">Verkoopprijs</th><th>Webshop</th><th class="num">Waarde</th></tr></thead>
      <tbody>${items.map((item) => `<tr data-id="${esc(item.id)}" class="${item.low ? 'low' : ''}${item.archived ? ' arch' : ''}">
        <td class="wrap"><b class="code">${esc(item.code)}</b>${item.archived ? ' <span class="pill">Gearchiveerd</span>' : ''}<span class="sub">${esc(item.name)}</span></td>
        <td>${esc(item.location)}</td>
        <td class="num${item.onHand < 0 ? ' neg' : ''}">${esc(nl(item.onHand))} ${esc(item.unit)}</td>
        <td class="num">${item.reserved ? `${esc(nl(item.reserved))}<span class="sub">${item.orders} werkorder${item.orders === 1 ? '' : 's'}</span>` : ''}</td>
        <td class="num avail">${esc(nl(item.available))}${item.low ? ' <span class="pill low">Bijbestellen</span>' : ''}</td>
        <td class="num">${item.minQty ? esc(nl(item.minQty)) : ''}</td>
        <td class="num">${esc(eur(item.salePrice))}${item.salePrice != null && item.vatRate !== 21 ? `<span class="sub">${item.vatRate}% btw</span>` : ''}</td>
        <td>${shopPill(item)}</td>
        <td class="num">${esc(eur(item.value))}</td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">Niets gevonden.</td></tr>'}</tbody>`;
    table.querySelectorAll('tr[data-id]').forEach((row) => {
      /**
       * Opent het artikel.
       * @returns {Promise<void>}
       */
      row.onclick = () => openItem(row.dataset.id, true);
    });
  }

  /** Tekent de tabel met reserveringen van open werkorders. */
  function renderReserved() {
    const table = $('#r-table');
    if (!state.reservations.length) {
      table.innerHTML = '<tbody><tr><td class="empty">Er staat niets gereserveerd.</td></tr></tbody>';
      return;
    }
    table.innerHTML = `<thead><tr><th>Werkorder</th><th>Status</th><th>Gepland</th><th>Artikel</th><th class="num">Gereserveerd</th></tr></thead>
      <tbody>${state.reservations.map((reservation) => `<tr>
        <td class="wrap">${woLink(reservation.workOrder)}<span class="sub">${esc(reservation.workOrder.title)}${reservation.workOrder.customer ? ` · ${esc(reservation.workOrder.customer)}` : ''}</span></td>
        <td><span class="pill wo-${esc(reservation.workOrder.status)}">${esc((WorkOrderCore && WorkOrderCore.STATUSES[reservation.workOrder.status]) || reservation.workOrder.status)}</span></td>
        <td>${esc(day(reservation.workOrder.plannedDate)) || '<span class="muted">–</span>'}</td>
        <td class="wrap"><span class="code">${esc(reservation.code)}</span><span class="sub">${esc(reservation.name)}</span></td>
        <td class="num">${esc(nl(reservation.qty))} ${esc(reservation.unit)}</td>
      </tr>`).join('')}</tbody>`;
  }

  /**
   * Laadt de mutaties in de gekozen periode en tekent het logboek.
   * @returns {Promise<void>}
   */
  async function loadMoves() {
    const from = $('#m-from').value;
    const to = $('#m-to').value;
    try {
      state.moves = (await api(`stock/movements?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).items;
    } catch (error) {
      toast(error.message, true);
      state.moves = [];
    }
    renderMoves();
  }

  /**
   * Geeft de geladen mutaties, gefilterd op soort.
   * @returns {object[]} de mutaties
   */
  const movesShown = () => {
    const kind = $('#m-kind').value;
    return (state.moves || []).filter((movement) => !kind || movement.kind === kind);
  };

  /** Tekent het logboek met mutaties. */
  function renderMoves() {
    const table = $('#m-table');
    const items = movesShown();
    table.innerHTML = items.length ? `<thead><tr><th>Datum</th><th>Soort</th><th>Artikel</th><th class="num">Aantal</th><th class="num">Stand</th><th>Werkorder</th><th>Door</th><th>Opmerking</th></tr></thead>
      <tbody>${items.map((movement) => `<tr>
        <td>${esc(when(movement.createdAt))}</td><td>${kindPill(movement.kind)}</td>
        <td class="wrap"><span class="code">${esc(movement.code)}</span><span class="sub">${esc(movement.name)}</span></td>
        <td class="num${movement.qty < 0 ? ' neg' : ''}">${movement.qty > 0 ? '+' : ''}${esc(nl(movement.qty))} ${esc(movement.unit)}</td>
        <td class="num">${esc(nl(movement.balance))}</td>
        <td>${movement.workOrderId ? woLink({ id: movement.workOrderId, number: movement.workOrderNumber }) : ''}</td>
        <td>${esc(movement.userName)}</td><td class="wrap">${esc(movement.note)}</td>
      </tr>`).join('')}</tbody>` : '<tbody><tr><td class="empty">Geen mutaties in deze periode.</td></tr></tbody>';
  }

  /**
   * Toont een tabblad (voorraad, gereserveerd of mutaties) en zet het in de URL.
   * @param {string} name 'stock', 'reserved' of 'moves'
   */
  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
    for (const tabName of ['stock', 'reserved', 'moves']) $(`#tab-${tabName}`).hidden = tabName !== name;
    if (name === 'moves' && !state.moves) loadMoves();
    try { history.replaceState(null, '', `./#${name}`); } catch { /* file:// */ }
  }

  /**
   * Laadt de voorraad en de reserveringen en tekent het overzicht.
   * @returns {Promise<void>}
   */
  async function load() {
    const [stock, reservations] = await Promise.all([api(`stock${$('#f-archived').checked ? '?archived=1' : ''}`), api('stock/reservations')]);
    state.items = stock.items;
    state.reservations = reservations.items;
    renderStats();
    renderStock();
    renderReserved();
    if (state.moves) loadMoves();
  }

  // ---------- Nieuw artikel en uit de catalogus ----------
  /** Opent het formulier voor een nieuw artikel (met codes uit de catalogus om te kiezen). */
  function openNew() {
    const formElement = $('#new-form');
    $('#import-form').hidden = true;
    formElement.reset();
    $('.err', formElement).textContent = '';
    const have = new Set(state.items.map((item) => item.code));
    $('#catalog-codes').innerHTML = Object.entries(Catalog.articles).filter(([code]) => !have.has(code)).map(([code, article]) => `<option value="${esc(code)}">${esc(article.name)}</option>`).join('');
    formElement.hidden = false;
    formElement.code.focus();
  }

  /** Koppelt het formulier voor een nieuw artikel. */
  function setupNew() {
    const formElement = $('#new-form');
    /** Vult naam en eenheid in als de code in de catalogus staat. */
    formElement.code.oninput = () => {
      const article = Catalog.articles[formElement.code.value.trim().toUpperCase()];
      if (article && !formElement.name.value) { formElement.name.value = article.name; formElement.unit.value = article.unit || 'st'; }
    };
    /** Sluit het formulier. */
    $('[data-cancel]', formElement).onclick = () => { formElement.hidden = true; };
    /**
     * Slaat het nieuwe artikel op.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      const errorBox = $('.err', formElement);
      errorBox.textContent = '';
      try {
        const item = await api('stock/items', { method: 'POST', body: {
          code: formElement.code.value, name: formElement.name.value, unit: formElement.unit.value, location: formElement.location.value,
          onHand: num(formElement.onHand.value), minQty: num(formElement.minQty.value), reorderQty: num(formElement.reorderQty.value), costPrice: num(formElement.costPrice.value),
          salePrice: num(formElement.salePrice.value), vatRate: Number(formElement.vatRate.value), revenueGroup: formElement.revenueGroup.value, shopSync: formElement.shopSync.checked,
        } });
        formElement.hidden = true;
        toast(`${item.code} toegevoegd`);
        await load();
      } catch (error) {
        errorBox.textContent = error.message;
        if (error.field && formElement[error.field]) formElement[error.field].focus();
      }
    };
  }

  // ---------- Uit de webshop ----------
  /**
   * Opent de lijst met webshopproducten om op voorraad te nemen.
   * @returns {Promise<void>}
   */
  async function openShop() {
    const formElement = $('#shop-form');
    $('#new-form').hidden = true;
    $('#import-form').hidden = true;
    $('.err', formElement).textContent = '';
    $('#sh-search').value = '';
    $('#sh-list').innerHTML = '<p class="muted small">Laden…</p>';
    formElement.hidden = false;
    try {
      const items = (await api('stock/shop-products')).items;
      $('#sh-list').innerHTML = items.length ? items.map((product) => (product.code
        ? `<label data-s="${esc(`${product.code} ${product.name}`.toLowerCase())}"><input type="checkbox" value="${esc(product.id)}"> <span><span class="code">${esc(product.code)}</span> ${esc(product.name)} <span class="muted">${esc(eur(product.price))}</span></span></label>`
        : `<label class="have"><input type="checkbox" disabled> <span>${esc(product.name)} (geen SKU: vul die eerst in de webshop in)</span></label>`)).join('')
        : '<p class="muted small">Alle producten uit de webshop staan al in de voorraad, of er zijn nog geen producten opgehaald (Beheer → Webshop).</p>';
    } catch (error) {
      $('.err', formElement).textContent = error.message;
    }
  }

  /** Koppelt het formulier "Uit de webshop". */
  function setupShop() {
    const formElement = $('#shop-form');
    /** Sluit het formulier. */
    $('[data-cancel]', formElement).onclick = () => { formElement.hidden = true; };
    /** Filtert de lijst op de zoekterm. */
    $('#sh-search').oninput = () => {
      const term = $('#sh-search').value.trim().toLowerCase();
      formElement.querySelectorAll('#sh-list label[data-s]').forEach((label) => { label.hidden = Boolean(term) && !label.dataset.s.includes(term); });
    };
    /** Vinkt alle zichtbare producten aan. */
    $('#sh-all').onclick = () => { formElement.querySelectorAll('#sh-list label[data-s]:not([hidden]) input').forEach((input) => { input.checked = true; }); };
    /**
     * Neemt de gekozen webshopproducten op voorraad.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      const ids = [...formElement.querySelectorAll('#sh-list input:checked:not([disabled])')].map((input) => input.value);
      const errorBox = $('.err', formElement);
      if (!ids.length) { errorBox.textContent = 'Kies een of meer producten.'; return; }
      try {
        const result = await api('stock/import-shop', { method: 'POST', body: { ids } });
        formElement.hidden = true;
        toast(`${result.created} product${result.created === 1 ? '' : 'en'} overgenomen`);
        await load();
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
  }

  /**
   * Opent de lijst met catalogusartikelen om op voorraad te nemen.
   * @param {string[]} preselect codes die al aangevinkt zijn (bijv. vanuit een werkorder)
   */
  function openImport(preselect = []) {
    const formElement = $('#import-form');
    $('#new-form').hidden = true;
    $('#shop-form').hidden = true;
    $('.err', formElement).textContent = '';
    const have = new Set(state.items.map((item) => item.code));
    const preselected = new Set(preselect.map((code) => code.toUpperCase()));
    $('#i-list').innerHTML = Object.entries(Catalog.articles).map(([code, article]) => (have.has(code)
      ? `<label class="have"><input type="checkbox" disabled checked> <span><span class="code">${esc(code)}</span> ${esc(article.name)} (al op voorraad)</span></label>`
      : `<label data-s="${esc(`${code} ${article.name}`.toLowerCase())}"><input type="checkbox" value="${esc(code)}"${preselected.has(code) ? ' checked' : ''}> <span><span class="code">${esc(code)}</span> ${esc(article.name)}</span></label>`)).join('');
    $('#i-search').value = '';
    formElement.hidden = false;
    if (preselected.size) formElement.scrollIntoView();
  }

  /** Koppelt het formulier "Uit catalogus". */
  function setupImport() {
    const formElement = $('#import-form');
    /** Sluit het formulier. */
    $('[data-cancel]', formElement).onclick = () => { formElement.hidden = true; };
    /** Filtert de lijst op de zoekterm. */
    $('#i-search').oninput = () => {
      const term = $('#i-search').value.trim().toLowerCase();
      formElement.querySelectorAll('#i-list label[data-s]').forEach((label) => { label.hidden = Boolean(term) && !label.dataset.s.includes(term); });
    };
    /** Vinkt alle zichtbare artikelen aan. */
    $('#i-all').onclick = () => { formElement.querySelectorAll('#i-list label[data-s]:not([hidden]) input').forEach((input) => { input.checked = true; }); };
    /**
     * Neemt de gekozen catalogusartikelen op voorraad.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      const codes = [...formElement.querySelectorAll('#i-list input:checked:not([disabled])')].map((input) => input.value);
      const errorBox = $('.err', formElement);
      if (!codes.length) { errorBox.textContent = 'Kies een of meer artikelen.'; return; }
      try {
        const result = await api('stock/import', { method: 'POST', body: { codes } });
        formElement.hidden = true;
        toast(`${result.created} artikel${result.created === 1 ? '' : 'en'} op voorraad genomen`);
        await load();
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
  }

  // ---------- Artikel ----------
  /** Tekent het geopende artikel: tellers, formulier, webshop, reserveringen en mutaties. */
  function renderItem() {
    const item = state.item;
    $('#d-title').innerHTML = `<span class="code">${esc(item.code)}</span> ${esc(item.name)}${item.archived ? ' <span class="pill">Gearchiveerd</span>' : ''}`;
    document.title = `${item.code} – Voorraadbeheer`;
    $('#d-stats').innerHTML = [
      [`${nl(item.onHand)} ${item.unit}`, 'op voorraad'],
      [nl(item.reserved), `gereserveerd (${item.orders} werkorder${item.orders === 1 ? '' : 's'})`],
      [nl(item.available), item.low ? 'beschikbaar: onder het minimum' : 'beschikbaar'],
      [item.location || '–', 'locatie'],
      [eur(item.value) || '–', 'waarde (inkoop)'],
    ].map(([value, label]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
    const formElement = $('#edit-form');
    for (const key of ['code', 'name', 'unit', 'location', 'notes']) formElement[key].value = item[key] || '';
    formElement.minQty.value = item.minQty || '';
    formElement.reorderQty.value = item.reorderQty == null ? '' : item.reorderQty;
    formElement.costPrice.value = item.costPrice == null ? '' : item.costPrice;
    formElement.salePrice.value = item.salePrice == null ? '' : item.salePrice;
    formElement.vatRate.value = String(item.vatRate);
    formElement.revenueGroup.value = item.revenueGroup;
    formElement.shopSync.checked = item.shopSync;
    $('#d-shop').innerHTML = !item.shop.productId ? (item.shopSync ? 'Nog niet gekoppeld aan een webshopproduct (koppelen gaat op SKU = artikelcode).' : '')
      : item.shop.error ? `Webshop: <span class="err">${esc(item.shop.error)}</span>`
        : item.shop.pending ? 'Webshop: wijziging wordt binnen enkele seconden verstuurd.'
          : `Webshop: gekoppeld (product ${esc(item.shop.productId)})${item.shop.syncedAt ? `, bijgewerkt ${esc(when(item.shop.syncedAt))}` : ''}.`;
    $('#d-remove').hidden = item.archived;
    $('#d-restore').hidden = !item.archived;
    $('#move-form').hidden = item.archived;
    $('#d-res').innerHTML = item.reservations.length ? `<thead><tr><th>Werkorder</th><th>Status</th><th>Gepland</th><th class="num">Gereserveerd</th></tr></thead>
      <tbody>${item.reservations.map((reservation) => `<tr><td class="wrap">${woLink(reservation.workOrder)}<span class="sub">${esc(reservation.workOrder.title)}</span></td>
        <td><span class="pill wo-${esc(reservation.workOrder.status)}">${esc((WorkOrderCore && WorkOrderCore.STATUSES[reservation.workOrder.status]) || reservation.workOrder.status)}</span></td>
        <td>${esc(day(reservation.workOrder.plannedDate))}</td><td class="num">${esc(nl(reservation.qty))} ${esc(item.unit)}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Niet gereserveerd.</td></tr></tbody>';
    $('#d-moves').innerHTML = item.movements.length ? `<thead><tr><th>Datum</th><th>Soort</th><th class="num">Aantal</th><th class="num">Stand</th><th>Werkorder</th><th>Door</th><th>Opmerking</th></tr></thead>
      <tbody>${item.movements.map((movement) => `<tr><td>${esc(when(movement.createdAt))}</td><td>${kindPill(movement.kind)}</td>
        <td class="num${movement.qty < 0 ? ' neg' : ''}">${movement.qty > 0 ? '+' : ''}${esc(nl(movement.qty))}</td><td class="num">${esc(nl(movement.balance))}</td>
        <td>${movement.workOrderId ? woLink({ id: movement.workOrderId, number: movement.workOrderNumber }) : ''}</td><td>${esc(movement.userName)}</td><td class="wrap">${esc(movement.note)}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Nog geen mutaties.</td></tr></tbody>';
  }

  /**
   * Opent een artikel.
   * @param {string} id id van het artikel
   * @param {boolean} push true om het adres (?id=) in de geschiedenis te zetten
   * @param {Promise<object>|null} pending het al lopende verzoek om het artikel (of null)
   * @returns {Promise<void>}
   */
  async function openItem(id, push = false, pending = null) {
    try {
      state.item = await (pending || api(`stock/items/${encodeURIComponent(id)}`));
    } catch (error) {
      toast(error.status === 404 ? 'Artikel niet gevonden.' : error.message, true);
      showList();
      return;
    }
    if (push) history.pushState(null, '', `./?id=${encodeURIComponent(id)}`);
    $('#v-list').hidden = true;
    $('#v-item').hidden = false;
    renderItem();
    window.scrollTo(0, 0);
  }

  /** Toont het overzicht in plaats van het artikel. */
  function showList() {
    $('#v-item').hidden = true;
    $('#v-list').hidden = false;
    document.title = 'Voorraadbeheer – AquaTech Service';
  }

  /** Koppelt de knoppen en formulieren van het artikelscherm. */
  function setupItem() {
    const back = $('#d-back');
    const from = window.AquatechCommon ? window.AquatechCommon.origin() : null;
    if (from && new URLSearchParams(location.search).get('id')) {
      back.textContent = from.label;
      back.href = from.href;
      /**
       * Terug naar de pagina waar je vandaan kwam.
       * @param {MouseEvent} event de klik
       */
      back.onclick = (event) => { event.preventDefault(); from.go(); };
    } else {
      /**
       * Terug naar het overzicht.
       * @param {MouseEvent} event de klik
       */
      back.onclick = (event) => { event.preventDefault(); history.pushState(null, '', `./#${state.tab}`); showList(); load().catch(() => {}); };
    }
    const moveForm = $('#move-form');
    /** Een correctie mag negatief zijn, de andere soorten niet. */
    moveForm.kind.onchange = () => { moveForm.qty.min = moveForm.kind.value === 'correctie' ? '' : '0'; };
    /**
     * Boekt een mutatie op het artikel.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    moveForm.onsubmit = async (event) => {
      event.preventDefault();
      const errorBox = $('.err', moveForm);
      errorBox.textContent = '';
      const qty = num(moveForm.qty.value);
      if (qty === null || !Number.isFinite(qty)) { errorBox.textContent = 'Vul een aantal in.'; return; }
      try {
        state.item = await api(`stock/items/${encodeURIComponent(state.item.id)}/movements`, { method: 'POST', body: { kind: moveForm.kind.value, qty, note: moveForm.note.value } });
        moveForm.qty.value = '';
        moveForm.note.value = '';
        renderItem();
        toast('Geboekt');
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
    const editForm = $('#edit-form');
    /**
     * Slaat de gewijzigde artikelgegevens op.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    editForm.onsubmit = async (event) => {
      event.preventDefault();
      const errorBox = $('.err', editForm);
      errorBox.textContent = '';
      try {
        state.item = { ...state.item, ...await api(`stock/items/${encodeURIComponent(state.item.id)}`, { method: 'PUT', body: {
          code: editForm.code.value, name: editForm.name.value, unit: editForm.unit.value, location: editForm.location.value, notes: editForm.notes.value,
          minQty: num(editForm.minQty.value), reorderQty: num(editForm.reorderQty.value), costPrice: num(editForm.costPrice.value),
          salePrice: num(editForm.salePrice.value), vatRate: Number(editForm.vatRate.value), revenueGroup: editForm.revenueGroup.value, shopSync: editForm.shopSync.checked,
        } }) };
        renderItem();
        toast('Opgeslagen');
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
    /**
     * Verwijdert het artikel na bevestiging (met mutaties: archiveren).
     * @returns {Promise<void>}
     */
    $('#d-remove').onclick = async () => {
      const item = state.item;
      if (!confirm(`${item.code} verwijderen?\n\nHeeft het artikel al mutaties, dan wordt het gearchiveerd (het logboek blijft bewaard). Reserveringen op werkorders vervallen.`)) return;
      try {
        const result = await api(`stock/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        toast(result.archived ? `${item.code} gearchiveerd` : `${item.code} verwijderd`);
        history.pushState(null, '', './');
        showList();
        await load();
      } catch (error) {
        toast(error.message, true);
      }
    };
    /**
     * Zet een gearchiveerd artikel terug.
     * @returns {Promise<void>}
     */
    $('#d-restore').onclick = async () => {
      try {
        state.item = { ...state.item, ...await api(`stock/items/${encodeURIComponent(state.item.id)}`, { method: 'PUT', body: { archived: false } }) };
        renderItem();
        toast('Teruggezet');
      } catch (error) {
        toast(error.message, true);
      }
    };
  }

  // ---------- Excel ----------
  /**
   * Maakt een nieuwe Excel-werkmap (laadt ExcelJS zo nodig).
   * @returns {Promise<object|null>} de werkmap, of null als Excel niet beschikbaar is
   */
  async function workbook() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return null; }
    const excelWorkbook = new ExcelJS.Workbook();
    excelWorkbook.creator = 'AquaTech Service';
    excelWorkbook.created = new Date();
    return excelWorkbook;
  }

  /**
   * Voegt het blad Mutaties toe.
   * @param {object} excelWorkbook de werkmap
   * @param {object[]} items de mutaties
   */
  function movesSheet(excelWorkbook, items) {
    const worksheet = excelWorkbook.addWorksheet('Mutaties', { views: [{ state: 'frozen', ySplit: 1 }] });
    worksheet.columns = [
      { header: 'Datum', key: 'at', width: 18, style: { numFmt: 'dd-mm-yyyy hh:mm' } },
      { header: 'Soort', key: 'kind', width: 12 },
      { header: 'Artikelcode', key: 'code', width: 16 },
      { header: 'Omschrijving', key: 'name', width: 40 },
      { header: 'Aantal', key: 'qty', width: 10, style: { numFmt: '#,##0.###' } },
      { header: 'Eenheid', key: 'unit', width: 9 },
      { header: 'Stand na mutatie', key: 'balance', width: 16, style: { numFmt: '#,##0.###' } },
      { header: 'Werkorder', key: 'wo', width: 14 },
      { header: 'Door', key: 'user', width: 20 },
      { header: 'Opmerking', key: 'note', width: 40 },
    ];
    for (const movement of items) {
      worksheet.addRow({ at: new Date(movement.createdAt), kind: KINDS[movement.kind] || movement.kind, code: movement.code, name: movement.name, qty: movement.qty, unit: movement.unit, balance: movement.balance,
        wo: movement.workOrderNumber, user: movement.userName, note: movement.note });
    }
    worksheet.getRow(1).font = { bold: true };
    worksheet.autoFilter = { from: 'A1', to: 'J1' };
  }

  /**
   * Laat de werkmap downloaden.
   * @param {object} excelWorkbook de werkmap
   * @param {string} name bestandsnaam
   * @returns {Promise<void>}
   */
  async function save(excelWorkbook, name) {
    const buffer = await excelWorkbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  /**
   * Geeft de datum van vandaag voor in een bestandsnaam.
   * @returns {string} datum als 'jjjj-mm-dd'
   */
  const stamp = () => new Date().toISOString().slice(0, 10);

  /**
   * Exporteert de zichtbare voorraad en de reserveringen naar Excel.
   * @returns {Promise<void>}
   */
  async function exportStock() {
    const exportButton = $('#b-export');
    exportButton.disabled = true;
    try {
      const excelWorkbook = await workbook();
      if (!excelWorkbook) return;
      const worksheet = excelWorkbook.addWorksheet('Voorraad', { views: [{ state: 'frozen', ySplit: 1 }] });
      const quantityStyle = { numFmt: '#,##0.###' };
      worksheet.columns = [
        { header: 'Artikelcode', key: 'code', width: 16 },
        { header: 'Omschrijving', key: 'name', width: 44 },
        { header: 'Eenheid', key: 'unit', width: 9 },
        { header: 'Locatie', key: 'location', width: 18 },
        { header: 'Op voorraad', key: 'onHand', width: 13, style: quantityStyle },
        { header: 'Gereserveerd', key: 'reserved', width: 13, style: quantityStyle },
        { header: 'Beschikbaar', key: 'available', width: 13, style: quantityStyle },
        { header: 'Minimum', key: 'minQty', width: 11, style: quantityStyle },
        { header: 'Bestellen tot', key: 'reorderQty', width: 13, style: quantityStyle },
        { header: 'Bijbestellen', key: 'low', width: 12 },
        { header: 'Inkoopprijs', key: 'costPrice', width: 12, style: { numFmt: '€ #,##0.00' } },
        { header: 'Waarde', key: 'value', width: 12, style: { numFmt: '€ #,##0.00' } },
        { header: 'Verkoopprijs excl. btw', key: 'salePrice', width: 14, style: { numFmt: '€ #,##0.00' } },
        { header: 'Btw', key: 'vat', width: 7 },
        { header: 'Omzetgroep', key: 'group', width: 12 },
        { header: 'Webshop', key: 'shop', width: 16 },
        { header: 'Gearchiveerd', key: 'archived', width: 13 },
        { header: 'Notities', key: 'notes', width: 30 },
      ];
      const GROUPS = { producten: 'Producten', arbeid: 'Arbeid', overig: 'Overig' };
      const items = visible();
      for (const item of items) {
        worksheet.addRow({ ...item, low: item.low ? 'ja' : '', archived: item.archived ? 'ja' : '', costPrice: item.costPrice, value: item.value, salePrice: item.salePrice,
          vat: `${item.vatRate}%`, group: GROUPS[item.revenueGroup] || item.revenueGroup,
          shop: !item.shopSync ? 'niet' : item.shop.error ? 'fout' : item.shop.productId ? `product ${item.shop.productId}` : 'niet gekoppeld' });
      }
      worksheet.getRow(1).font = { bold: true };
      worksheet.autoFilter = `A1:R${items.length + 1}`;
      const reservedSheet = excelWorkbook.addWorksheet('Gereserveerd', { views: [{ state: 'frozen', ySplit: 1 }] });
      reservedSheet.columns = [
        { header: 'Werkorder', key: 'wo', width: 14 }, { header: 'Titel', key: 'title', width: 30 }, { header: 'Klant', key: 'customer', width: 24 },
        { header: 'Status', key: 'status', width: 14 }, { header: 'Gepland', key: 'date', width: 12 },
        { header: 'Artikelcode', key: 'code', width: 16 }, { header: 'Omschrijving', key: 'name', width: 40 },
        { header: 'Gereserveerd', key: 'qty', width: 13, style: quantityStyle }, { header: 'Eenheid', key: 'unit', width: 9 },
      ];
      for (const reservation of state.reservations) {
        reservedSheet.addRow({ wo: reservation.workOrder.number, title: reservation.workOrder.title, customer: reservation.workOrder.customer, status: (WorkOrderCore && WorkOrderCore.STATUSES[reservation.workOrder.status]) || reservation.workOrder.status,
          date: reservation.workOrder.plannedDate ? new Date(`${reservation.workOrder.plannedDate}T12:00:00`) : null, code: reservation.code, name: reservation.name, qty: reservation.qty, unit: reservation.unit });
      }
      reservedSheet.getColumn('date').numFmt = 'dd-mm-yyyy';
      reservedSheet.getRow(1).font = { bold: true };
      await save(excelWorkbook, `voorraad-${stamp()}.xlsx`);
    } finally {
      exportButton.disabled = false;
    }
  }

  /**
   * Exporteert de mutaties in beeld naar Excel.
   * @returns {Promise<void>}
   */
  async function exportMoves() {
    const exportButton = $('#m-export');
    exportButton.disabled = true;
    try {
      if (!state.moves) await loadMoves();
      const excelWorkbook = await workbook();
      if (!excelWorkbook) return;
      movesSheet(excelWorkbook, movesShown());
      await save(excelWorkbook, `voorraadmutaties-${$('#m-from').value || 'begin'}-${$('#m-to').value || stamp()}.xlsx`);
    } finally {
      exportButton.disabled = false;
    }
  }

  /**
   * Bestelvoorstel als Excel: per artikel onder het minimum hoeveel er bij
   * moet om aan te vullen tot "bestellen tot" (de server rekent het uit).
   * @returns {Promise<void>}
   */
  async function exportReorder() {
    const button = $('#b-reorder');
    button.disabled = true;
    try {
      const proposal = await api('stock/reorder');
      if (!proposal.items.length) { toast('Niets te bestellen: alle artikelen zitten op of boven de minimumvoorraad.'); return; }
      const excelWorkbook = await workbook();
      if (!excelWorkbook) return;
      const sheet = excelWorkbook.addWorksheet('Bestelvoorstel', { views: [{ state: 'frozen', ySplit: 1 }] });
      const quantity = { numFmt: '#,##0.###' };
      const euro = { numFmt: '€ #,##0.00' };
      sheet.columns = [
        { header: 'Artikelcode', key: 'code', width: 16 },
        { header: 'Omschrijving', key: 'name', width: 44 },
        { header: 'Eenheid', key: 'unit', width: 9 },
        { header: 'Locatie', key: 'location', width: 18 },
        { header: 'Op voorraad', key: 'onHand', width: 13, style: quantity },
        { header: 'Gereserveerd', key: 'reserved', width: 13, style: quantity },
        { header: 'Beschikbaar', key: 'available', width: 13, style: quantity },
        { header: 'Minimum', key: 'minQty', width: 11, style: quantity },
        { header: 'Bestellen tot', key: 'target', width: 13, style: quantity },
        { header: 'Te bestellen', key: 'orderQty', width: 13, style: quantity },
        { header: 'Inkoopprijs', key: 'costPrice', width: 12, style: euro },
        { header: 'Bedrag', key: 'amount', width: 12, style: euro },
      ];
      for (const item of proposal.items) sheet.addRow(item);
      const totalRow = sheet.addRow({ name: 'Totaal (artikelen met inkoopprijs)', amount: proposal.total });
      totalRow.font = { bold: true };
      sheet.getRow(1).font = { bold: true };
      // Filter over de kop en de artikelregels, zonder de totaalregel.
      sheet.autoFilter = `A1:L${proposal.items.length + 1}`;
      await save(excelWorkbook, `bestelvoorstel-${stamp()}.xlsx`);
    } finally {
      button.disabled = false;
    }
  }

  // ---------- Start ----------
  /**
   * Start de pagina: rechten controleren, knoppen koppelen en het overzicht of
   * het artikel uit de URL laden.
   * @returns {Promise<void>}
   */
  async function init() {
    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    // Het artikel zelf al ophalen terwijl de login-check loopt.
    const pendingItem = id ? api(`stock/items/${encodeURIComponent(id)}`) : null;
    if (pendingItem) pendingItem.catch(() => {});
    const me = await window.AquatechAccount.load('../');
    const rights = me.rights || [];
    if (!me.user || !rights.includes('voorraad')) {
      const deniedBox = $('#v-denied');
      deniedBox.hidden = false;
      deniedBox.innerHTML = me.user && me.user.kind !== 'gast'
        ? 'Je rol heeft geen toegang tot voorraadbeheer. <a href="../">Terug naar het overzicht</a>'
        : 'Log eerst in. <a href="../login">Inloggen</a>';
      return;
    }
    $('#m-kind').innerHTML += Object.entries(KINDS).map(([kind, label]) => `<option value="${kind}">${esc(label)}</option>`).join('');
    document.querySelectorAll('.tab').forEach((button) => {
      /** Toont dit tabblad. */
      button.onclick = () => { showTab(button.dataset.tab); };
    });
    $('#f-search').oninput = renderStock;
    $('#f-low').onchange = renderStock;
    /**
     * Laadt het overzicht opnieuw (met of zonder gearchiveerde artikelen).
     * @returns {Promise<void>}
     */
    $('#f-archived').onchange = () => load().catch((error) => toast(error.message, true));
    $('#b-new').onclick = openNew;
    /** Opent het formulier "Uit catalogus". */
    $('#b-import').onclick = () => { openImport(); };
    /**
     * Opent het formulier "Uit de webshop".
     * @returns {Promise<void>}
     */
    $('#b-shop').onclick = () => openShop();
    /**
     * Exporteert de voorraad.
     * @returns {Promise<void>}
     */
    $('#b-export').onclick = () => exportStock().catch((error) => toast(`Export mislukt: ${error.message}`, true));
    /**
     * Maakt het bestelvoorstel als Excel.
     * @returns {Promise<void>}
     */
    $('#b-reorder').onclick = () => exportReorder().catch((error) => toast(`Bestelvoorstel mislukt: ${error.message}`, true));
    /**
     * Exporteert de mutaties.
     * @returns {Promise<void>}
     */
    $('#m-export').onclick = () => exportMoves().catch((error) => toast(`Export mislukt: ${error.message}`, true));
    $('#m-from').onchange = loadMoves;
    $('#m-to').onchange = loadMoves;
    $('#m-kind').onchange = renderMoves;
    /**
     * Berekent de reserveringen van alle open werkorders opnieuw.
     * @returns {Promise<void>}
     */
    $('#b-resync').onclick = async () => {
      try {
        const result = await api('stock/resync', { method: 'POST', body: {} });
        toast(`Reserveringen van ${result.workOrders} werkorder${result.workOrders === 1 ? '' : 's'} bijgewerkt`);
        await load();
      } catch (error) { toast(error.message, true); }
    };
    setupNew();
    setupImport();
    setupShop();
    setupItem();
    window.addEventListener('popstate', () => {
      const itemId = new URLSearchParams(location.search).get('id');
      if (itemId) openItem(itemId); else { showList(); load().catch(() => {}); }
    });
    if (id) {
      await openItem(id, false, pendingItem);
      load().catch(() => {});
    } else {
      $('#v-list').hidden = false;
      try { await load(); } catch (error) { toast(error.message, true); }
      const hash = location.hash.slice(1);
      if (['stock', 'reserved', 'moves'].includes(hash)) showTab(hash);
      // Vanuit een werkorder: "Op voorraad nemen" met de ontbrekende codes.
      const codes = (params.get('codes') || '').split(',').map((code) => code.trim()).filter((code) => Catalog.articles[code.toUpperCase()]);
      if (codes.length) openImport(codes);
    }
    if (window.AquatechCommon) {
      window.AquatechCommon.onReturn(() => {
        if (state.item && !$('#v-item').hidden) openItem(state.item.id);
        else load().catch(() => {});
      });
    }
  }

  init();
})();
