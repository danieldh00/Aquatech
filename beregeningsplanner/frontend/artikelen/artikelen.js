// Artikelen: overzicht van de voorraad (stand, gereserveerd, beschikbaar),
// de reserveringen van open werkorders, het logboek met mutaties en per
// artikel (?id=) de gegevens, mutaties boeken (ontvangst, telling, correctie)
// en de geschiedenis. Gegevens uit /api/stock (recht 'voorraad'). Artikelcodes
// zijn die van de catalogus (window.Catalog), zodat stuklijst, offerte en
// werkorder vanzelf aan de voorraad gekoppeld zijn. Export als Excel.
// Een hoofdartikel met varianten (bijv. per maat) staat als één regel in de
// lijst en klapt uit naar zijn varianten; op het hoofdartikel beheer je de
// kenmerken, elke variant heeft een eigen code, prijs en voorraad.
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
  /**
   * Prijs per eenheid in euro's (tot vier decimalen).
   * @param {?number} value De prijs.
   * @returns {string} Bijv. "€ 0,1234" (leeg zonder prijs).
   */
  const unitEur = (value) => (value == null ? '' : (Number(value) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 4 }));
  /** Waar een voorraadlaag vandaan komt, in gewone woorden. */
  const LAYER_SOURCES = { ontvangst: 'Ontvangst', retour: 'Retour', correctie: 'Correctie', telling: 'Telling', beginstand: 'Beginstand' };
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15".
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
  /**
   * Leest de staffelkorting uit het invoerveld: "50:10, 100:15" wordt vanaf 50 stuks 10% en vanaf 100 stuks 15%.
   * @param {string} text de ingevoerde tekst
   * @returns {{ minQty: number, discountPct: number }[]} de staffels (leeg bij een leeg veld)
   */
  const parseTiers = (text) => String(text).split(/[,;\n]/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = /^(\d+)\s*[:=\s]\s*(\d+(?:[.,]\d+)?)\s*%?$/.exec(part);
    if (!match) throw new Error('Staffelkorting: gebruik de vorm aantal:korting, bijvoorbeeld 50:10, 100:15.');
    return { minQty: Number(match[1]), discountPct: Number(match[2].replace(',', '.')) };
  });
  /**
   * Maakt van de staffels de tekst voor het invoerveld.
   * @param {{ minQty: number, discountPct: number }[]} tiers de staffels van het artikel
   * @returns {string} bijvoorbeeld "50:10, 100:15"
   */
  const tiersText = (tiers) => (tiers || []).map((tier) => `${tier.minQty}:${tier.discountPct}`).join(', ');
  /**
   * Specificaties als tekst voor het invulveld: per regel "naam: waarde".
   * @param {{ name: string, value: string }[]} specifications De specificaties.
   * @returns {string} De tekst.
   */
  const specificationsText = (specifications) => (specifications || []).map((entry) => `${entry.name}: ${entry.value}`).join('\n');
  /**
   * Vult omschrijving en specificaties in het artikelformulier en toont wat de oude webshop heeft (12): zolang het
   * artikel zelf niets heeft, toont de shop die tekst; met de knop neem je hem over om aan te passen.
   * @param {HTMLFormElement} formElement Het formulier.
   * @param {object} item Het artikel (description, specifications, shopDescription, shopSpecifications).
   * @returns {void}
   */
  const renderDetails = (formElement, item) => {
    formElement.description.value = item.description || '';
    formElement.specifications.value = specificationsText(item.specifications);
    const hasShop = Boolean(item.shopDescription) || Boolean((item.shopSpecifications || []).length);
    const note = $('#d-details-shop');
    note.hidden = !hasShop;
    if (!hasShop) return;
    $('span', note).textContent = !item.description && !(item.specifications || []).length
      ? 'Leeg: de shop toont de omschrijving en specificaties uit de oude webshop.'
      : 'De oude webshop heeft ook een omschrijving en/of specificaties.';
    /** Neemt de omschrijving en specificaties uit de oude webshop over in de velden (nog niet opgeslagen). */
    $('#d-details-copy').onclick = () => {
      if (item.shopDescription) formElement.description.value = item.shopDescription;
      if ((item.shopSpecifications || []).length) formElement.specifications.value = specificationsText(item.shopSpecifications);
    };
  };
  const KINDS = { ontvangst: 'Ontvangst', afboeking: 'Afboeking', retour: 'Retour', correctie: 'Correctie', telling: 'Telling' };

  const state = { items: [], reservations: [], moves: null, tab: 'stock', item: null, units: [], open: new Set(), newImage: null, media: null };

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
    if (!res.ok) throw Object.assign(new Error(result.message || AquatechCommon.statusMessage(res.status)), { code: result.error, field: result.field, status: res.status });
    return result;
  }

  /**
   * Maakt een link naar een werkorder.
   * @param {object} workOrder werkorder met id en number
   * @returns {string} HTML van de link, of leeg zonder werkorder
   */
  const woLink = (workOrder) => (workOrder && String(workOrder.id).startsWith('order:') ? esc(workOrder.number) : workOrder && workOrder.id ? `<a href="../werkorders/?id=${encodeURIComponent(workOrder.id)}">${esc(workOrder.number || 'werkorder')}</a>` : '');
  /**
   * Stand van de webshopkoppeling per artikel.
   * @param {object} item het voorraadartikel
   * @returns {string} HTML van het label
   */
  const shopPill = (item) => {
    if (!item.shopSync) return '<span class="muted small">niet</span>';
    if (item.shop.error) return `<span class="pill low" title="${esc(item.shop.error)}">Fout</span>`;
    if (!item.shop.productId) return '<span class="muted small">niet gekoppeld</span>';
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

  /**
   * De regels van de voorraadtabel: gewone artikelen en hoofdartikelen, met
   * de varianten eronder als het hoofdartikel open is (of als de zoekterm of
   * het filter een variant vindt).
   * @returns {{ item: object, variant?: boolean, open?: boolean, count?: number }[]} De regels in volgorde.
   */
  function stockRows() {
    const term = $('#f-search').value.trim().toLowerCase();
    const low = $('#f-low').checked;
    /**
     * Past een artikel bij de zoekterm en het filter?
     * @param {object} item het artikel
     * @returns {boolean} true als het in beeld moet
     */
    const matches = (item) => (!low || item.low) && (!term || `${item.code} ${item.name} ${item.location}`.toLowerCase().includes(term));
    const parentIds = new Set(state.items.filter((item) => item.hasVariants).map((item) => item.id));
    const variantsOf = new Map();
    for (const item of state.items) {
      if (!item.parentId || !parentIds.has(item.parentId)) continue;
      if (!variantsOf.has(item.parentId)) variantsOf.set(item.parentId, []);
      variantsOf.get(item.parentId).push(item);
    }
    const rows = [];
    for (const item of state.items) {
      if (item.parentId && parentIds.has(item.parentId)) continue;
      if (!item.hasVariants) {
        if (matches(item)) rows.push({ item });
        continue;
      }
      const variants = variantsOf.get(item.id) || [];
      const found = variants.filter(matches);
      const filtered = Boolean(term || low);
      if (!matches(item) && !found.length) continue;
      const open = state.open.has(item.id) || (filtered && found.length > 0);
      rows.push({ item, open, count: variants.filter((variant) => !variant.archived).length });
      if (open) rows.push(...(filtered && found.length ? found : variants).map((variant) => ({ item: variant, variant: true })));
    }
    return rows;
  }

  /**
   * De waarden van een variant als tekst.
   * @param {object} item de variant (values)
   * @returns {string} bijv. 'Maat: 16 mm'
   */
  const valuesText = (item) => Object.entries(item.values || {}).map(([name, value]) => `${name}: ${value}`).join(' · ');

  /** Tekent de tellers boven het overzicht. */
  function renderStats() {
    const live = state.items.filter((item) => !item.archived && !item.hasVariants);
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
    const rows = stockRows();
    table.innerHTML = `<thead><tr><th>Artikel</th><th>Locatie</th><th class="num">Op voorraad</th><th class="num">Gereserveerd</th><th class="num">Beschikbaar</th><th class="num">Minimum</th><th class="num">Verkoopprijs</th><th>Webshop</th><th class="num">Waarde</th></tr></thead>
      <tbody>${rows.map(({ item, variant, open, count }) => `<tr data-id="${esc(item.id)}" class="${item.low ? 'low' : ''}${item.archived ? ' arch' : ''}${variant ? ' variant' : ''}${item.hasVariants ? ' parent' : ''}">
        <td class="wrap">${item.hasVariants ? `<button class="toggle" data-toggle="${esc(item.id)}" aria-expanded="${open ? 'true' : 'false'}" title="${open ? 'Varianten verbergen' : 'Varianten tonen'}">${open ? '▾' : '▸'}</button>` : ''}<b class="code">${esc(item.code)}</b>${item.hasVariants ? ` <span class="pill">${count} variant${count === 1 ? '' : 'en'}</span>` : ''}${item.archived ? ' <span class="pill">Gearchiveerd</span>' : ''}<span class="sub">${esc(variant && valuesText(item) ? valuesText(item) : item.name)}</span></td>
        <td>${esc(item.location)}</td>
        <td class="num${item.onHand < 0 ? ' neg' : ''}">${esc(nl(item.onHand))} ${esc(item.unit)}</td>
        <td class="num">${item.reserved ? `${esc(nl(item.reserved))}<span class="sub">${item.orders} werkorder${item.orders === 1 ? '' : 's'}</span>` : ''}</td>
        <td class="num avail">${esc(nl(item.available))}${item.low ? ' <span class="pill low">Bijbestellen</span>' : ''}</td>
        <td class="num">${item.minQty && !item.hasVariants ? esc(nl(item.minQty)) : ''}</td>
        <td class="num">${item.hasVariants ? '' : `${esc(eur(item.salePrice))}${item.salePrice != null && item.vatRate !== 21 ? `<span class="sub">${item.vatRate}% btw</span>` : ''}`}</td>
        <td>${shopPill(item)}</td>
        <td class="num">${esc(eur(item.value))}</td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">Niets gevonden.</td></tr>'}</tbody>`;
    table.querySelectorAll('tr[data-id]').forEach((row) => {
      /**
       * Opent het artikel, of klapt bij het pijltje de varianten uit of in.
       * @param {MouseEvent} event de klik
       * @returns {Promise<void>|undefined}
       */
      row.onclick = (event) => {
        const toggle = event.target.closest('[data-toggle]');
        if (!toggle) return openItem(row.dataset.id, true);
        if (state.open.has(toggle.dataset.toggle)) state.open.delete(toggle.dataset.toggle); else state.open.add(toggle.dataset.toggle);
        renderStock();
        return undefined;
      };
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
    for (const tabName of ['stock', 'reserved', 'moves', 'suppliers', 'media']) $(`#tab-${tabName}`).hidden = tabName !== name;
    if (name === 'moves' && !state.moves) loadMoves();
    if (name === 'suppliers') window.ArtikelenSuppliers.load().catch((error) => toast(error.message, true));
    if (name === 'media') loadMedia().catch((error) => toast(error.message, true));
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

  // ---------- Eenheden ----------
  /**
   * Vult de keuzelijsten Eenheid met de eenheden; een eenheid die een artikel al
   * heeft maar niet (meer) in de lijst staat blijft keuzemogelijk, net als de
   * eenheid die op dat moment in een zichtbare keuzelijst gekozen is (verborgen
   * formulieren beginnen opnieuw, zodat een verwijderde eenheid niet terugkomt).
   * @param {string} extra eenheid die altijd in de lijst moet staan (bijv. die van het geopende artikel)
   */
  function fillUnits(extra = '') {
    const names = state.units.map((unit) => unit.name);
    if (extra && !names.includes(extra)) names.push(extra);
    document.querySelectorAll('select[data-units]').forEach((select) => {
      const keep = select.offsetParent === null ? '' : select.value;
      const options = keep && !names.includes(keep) ? [...names, keep] : names;
      select.innerHTML = options.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
      select.value = options.includes(keep) ? keep : (options.includes('st') ? 'st' : options[0] || '');
    });
  }

  /**
   * Laadt de eenheden en vult de keuzelijsten en het beheerscherm.
   * @returns {Promise<void>}
   */
  async function loadUnits() {
    state.units = (await api('stock/units')).items;
    fillUnits(state.item ? state.item.unit : '');
    renderUnits();
  }

  /** Tekent de eenheden als labels met een verwijderknop (uitgeschakeld zolang een artikel de eenheid gebruikt). */
  function renderUnits() {
    $('#u-list').innerHTML = state.units.map((unit) => `<span class="chip">${esc(unit.name)}${unit.items ? ` <small>${unit.items}×</small>` : ''}
      <button type="button" data-id="${esc(unit.id)}" aria-label="${esc(unit.name)} verwijderen" title="${unit.items ? 'In gebruik door artikelen' : 'Verwijderen'}"${unit.items ? ' disabled' : ''}>×</button></span>`).join('');
  }

  /** Koppelt het formulier om eenheden aan te maken en te verwijderen. */
  function setupUnits() {
    const formElement = $('#units-form');
    /** Opent of sluit het scherm met eenheden. */
    $('#b-units').onclick = () => {
      formElement.hidden = !formElement.hidden;
      if (!formElement.hidden) { $('#new-form').hidden = true; $('#import-form').hidden = true; formElement.name.focus(); }
    };
    /** Sluit het scherm. */
    $('[data-cancel]', formElement).onclick = () => { formElement.hidden = true; };
    /**
     * Voegt de ingevulde eenheid toe.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      const errorBox = $('.err', formElement);
      errorBox.textContent = '';
      try {
        const unit = await api('stock/units', { method: 'POST', body: { name: formElement.name.value } });
        formElement.name.value = '';
        await loadUnits();
        toast(`Eenheid ${unit.name} toegevoegd`);
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
    /**
     * Verwijdert een eenheid.
     * @param {MouseEvent} event de klik op een verwijderknop
     * @returns {Promise<void>}
     */
    $('#u-list').onclick = async (event) => {
      const button = event.target.closest('button[data-id]');
      if (!button) return;
      try {
        await api(`stock/units/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
        await loadUnits();
      } catch (error) {
        $('.err', formElement).textContent = error.message;
      }
    };
  }

  // ---------- Nieuw artikel en uit de catalogus ----------
  /** Opent het formulier voor een nieuw artikel (met codes uit de catalogus om te kiezen). */
  function openNew() {
    const formElement = $('#new-form');
    $('#import-form').hidden = true;
    $('#units-form').hidden = true;
    formElement.reset();
    fillUnits();
    if (state.units.some((unit) => unit.name === 'st')) formElement.unit.value = 'st';
    $('.err', formElement).textContent = '';
    showNewImage(null);
    const have = new Set(state.items.map((item) => item.code));
    $('#catalog-codes').innerHTML = Object.entries(Catalog.articles).filter(([code]) => !have.has(code)).map(([code, article]) => `<option value="${esc(code)}">${esc(article.name)}</option>`).join('');
    formElement.hidden = false;
    formElement.code.focus();
  }

  /**
   * Toont de gekozen afbeelding in het formulier voor een nieuw artikel (of leeg).
   * @param {{ name: string, data: string }|null} picked de klaargemaakte afbeelding, of null
   */
  function showNewImage(picked) {
    state.newImage = picked;
    $('#n-image-preview').innerHTML = picked ? `<img src="data:image/*;base64,${picked.data}" alt="">` : '<span class="muted small">Geen afbeelding</span>';
    $('#n-image-clear').hidden = !picked;
    if (!picked) $('#new-form').image.value = '';
  }

  /** Koppelt het formulier voor een nieuw artikel. */
  function setupNew() {
    const formElement = $('#new-form');
    /** Verkleint de gekozen afbeelding en toont hem. */
    formElement.image.onchange = async () => {
      const errorBox = $('.err', formElement);
      errorBox.textContent = '';
      const file = formElement.image.files && formElement.image.files[0];
      if (!file) { showNewImage(null); return; }
      try { showNewImage(await window.ItemImages.prepare(file)); } catch (error) { showNewImage(null); errorBox.textContent = error.message; }
    };
    /**
     * Haalt de gekozen afbeelding weer weg.
     * @returns {void}
     */
    $('#n-image-clear').onclick = () => showNewImage(null);
    /** Vult naam en eenheid in als de code in de catalogus staat. */
    formElement.code.oninput = () => {
      const article = Catalog.articles[formElement.code.value.trim().toUpperCase()];
      if (article && !formElement.name.value) {
        formElement.name.value = article.name;
        fillUnits(article.unit || 'st');
        formElement.unit.value = article.unit || 'st';
      }
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
          salePrice: num(formElement.salePrice.value), vatRate: Number(formElement.vatRate.value), weightGrams: num(formElement.weightGrams.value), businessPrice: num(formElement.businessPrice.value), revenueGroup: formElement.revenueGroup.value, shopSync: formElement.shopSync.checked,
          packSize: num(formElement.packSize.value), orderMinQty: num(formElement.orderMinQty.value), priceTiers: parseTiers(formElement.priceTiers.value), unitContent: num(formElement.unitContent.value),
        } });
        formElement.hidden = true;
        toast(`${item.code} toegevoegd`);
        if (state.newImage) await window.ItemImages.upload(item.id, state.newImage).catch((error) => toast(`${item.code} is toegevoegd, maar de afbeelding niet: ${error.message}`, true));
        await Promise.all([load(), loadUnits().catch((error) => toast(error.message, true))]);
      } catch (error) {
        errorBox.textContent = error.message;
        if (error.field && formElement[error.field]) formElement[error.field].focus();
      }
    };
  }

  // ---------- Uit de webshop ----------
  /**
   * Neemt alles uit de webshop over (volle synchronisatie) in een venster met
   * voortgangsbalk; artikelen die niet in de webshop staan worden gearchiveerd.
   * @returns {Promise<void>}
   */
  async function importShop() {
    const dialog = $('#shop-dialog');
    const button = $('#b-shop');
    const bar = $('#shop-bar');
    $('#shop-text').textContent = 'Producten ophalen uit de webshop en de voorraad bijwerken…';
    $('#shop-close').hidden = true;
    bar.removeAttribute('value');
    dialog.showModal();
    button.disabled = true;
    try {
      const result = await api('stock/import-shop', { method: 'POST', body: {} });
      bar.value = 1;
      $('#shop-text').textContent = `Klaar: ${result.created} nieuw, ${result.restored} teruggezet, ${result.archived} gearchiveerd (niet in de webshop)${result.skippedProducts ? `, ${result.skippedProducts} overgeslagen (geen geldige code)` : ''}.`;
      await Promise.all([load(), loadUnits().catch((error) => toast(error.message, true))]);
    } catch (error) {
      bar.value = 0;
      $('#shop-text').textContent = `Overnemen mislukt: ${error.message}`;
    } finally {
      button.disabled = false;
      $('#shop-close').hidden = false;
    }
  }

  /** Koppelt de knop om het venster te sluiten. */
  function setupShop() {
    /** Sluit het venster. */
    $('#shop-close').onclick = () => { $('#shop-dialog').close(); };
  }

  /**
   * Opent de lijst met catalogusartikelen om op voorraad te nemen.
   * @param {string[]} preselect codes die al aangevinkt zijn (bijv. vanuit een werkorder)
   */
  function openImport(preselect = []) {
    const formElement = $('#import-form');
    $('#new-form').hidden = true;
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
        await Promise.all([load(), loadUnits().catch((error) => toast(error.message, true))]);
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
    document.title = `${item.code} – Artikelen`;
    $('#d-stats').innerHTML = [
      [`${nl(item.onHand)} ${item.unit}`, 'op voorraad'],
      [nl(item.reserved), `gereserveerd (${item.orders} werkorder${item.orders === 1 ? '' : 's'})`],
      [nl(item.available), item.low ? 'beschikbaar: onder het minimum' : 'beschikbaar'],
      [item.location || '–', 'locatie'],
      [eur(item.value) || '–', 'waarde (inkoop)'],
    ].map(([value, label]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
    const formElement = $('#edit-form');
    fillUnits(item.unit);
    for (const key of ['code', 'name', 'unit', 'location', 'notes']) formElement[key].value = item[key] || '';
    formElement.minQty.value = item.minQty || '';
    formElement.reorderQty.value = item.reorderQty == null ? '' : item.reorderQty;
    formElement.costPrice.value = item.costPrice == null ? '' : item.costPrice;
    formElement.salePrice.value = item.salePrice == null ? '' : item.salePrice;
    formElement.vatRate.value = String(item.vatRate);
    formElement.weightGrams.value = item.weightGrams == null ? '' : item.weightGrams;
    formElement.businessPrice.value = item.businessPrice == null ? '' : item.businessPrice;
    formElement.revenueGroup.value = item.revenueGroup;
    formElement.shopSync.checked = item.shopSync;
    formElement.packSize.value = item.packSize > 1 ? item.packSize : '';
    formElement.unitContent.value = item.unitContent == null ? '' : item.unitContent;
    formElement.orderMinQty.value = item.orderMinQty > 1 ? item.orderMinQty : '';
    formElement.priceTiers.value = tiersText(item.priceTiers);
    renderDetails(formElement, item);
    $('#d-shop').innerHTML = item.shop.error ? `Webshop: <span class="err">${esc(item.shop.error)}</span>`
      : !item.shop.productId ? (item.shopSync ? 'Nog niet gekoppeld aan een webshopproduct (koppelen gaat op SKU = artikelcode).' : '')
        : item.shop.pending ? 'Webshop: wijziging wordt binnen enkele seconden verstuurd.'
          : `Webshop: gekoppeld (product ${esc(item.shop.productId)})${item.shop.syncedAt ? `, bijgewerkt ${esc(when(item.shop.syncedAt))}` : ''}.`;
    renderImage();
    $('#d-remove').hidden = item.archived;
    $('#d-restore').hidden = !item.archived;
    $('#move-form').hidden = item.archived || item.hasVariants;
    $('#d-parent-note').hidden = !item.hasVariants;
    $('#d-publish').hidden = Boolean(item.shop.productId || !item.shopSync || item.parentId || item.archived);
    $('#d-res-card').hidden = item.hasVariants;
    $('#d-moves-card').hidden = item.hasVariants;
    const variantOf = $('#d-variant-of');
    variantOf.hidden = !item.parent;
    variantOf.innerHTML = item.parent ? `Variant van <a href="./?id=${encodeURIComponent(item.parent.id)}" data-open="${esc(item.parent.id)}">${esc(item.parent.code)} ${esc(item.parent.name)}</a>${valuesText(item) ? ` · ${esc(valuesText(item))}` : ''}` : '';
    renderVariants();
    renderCosts();
    window.ArtikelenSuppliers.showItem(item).catch((error) => toast(error.message, true));
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
   * Tekent de prijshistorie en de voorraadlagen (FIFO) van het artikel; een laag
   * met een onbekende prijs (of de beginstand) krijgt een veld om de prijs in te vullen.
   * @returns {void}
   */
  function renderCosts() {
    const item = state.item;
    const section = $('#d-costs');
    section.hidden = item.hasVariants;
    if (item.hasVariants) return;
    $('#cost-form').hidden = item.archived;
    const prices = item.costPrices || [];
    $('#d-prices').innerHTML = prices.length ? `<thead><tr><th>Geldig vanaf</th><th class="num">Prijs</th><th class="num">Verschil</th><th>Door</th><th>Opmerking</th></tr></thead>
      <tbody>${prices.map((price, index) => {
    const older = prices[index + 1];
    const change = older && older.price ? ((price.price - older.price) / older.price) * 100 : null;
    return `<tr><td>${esc(day(price.validFrom))}</td><td class="num">${esc(unitEur(price.price))}</td>
          <td class="num${change > 0 ? ' neg' : ''}">${change == null ? '' : `${change > 0 ? '+' : ''}${esc(nl(change, 1))}%`}</td><td>${esc(price.userName)}</td><td class="wrap">${esc(price.note)}</td></tr>`;
  }).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Nog geen inkoopprijs.</td></tr></tbody>';
    const layers = item.layers || [];
    $('#d-layers').innerHTML = layers.length ? `<thead><tr><th>Ontvangen</th><th>Soort</th><th class="num">Over</th><th class="num">Inkoopprijs</th><th class="num">Waarde</th></tr></thead>
      <tbody>${layers.map((layer) => `<tr><td>${esc(day(String(layer.receivedAt).slice(0, 10)))}</td><td>${esc(LAYER_SOURCES[layer.source] || layer.source)}</td>
        <td class="num">${esc(nl(layer.remaining))} <span class="muted">van ${esc(nl(layer.qty))}</span></td>
        <td class="num">${layer.unitCost == null ? '<span class="pill k-correctie">onbekend</span>' : esc(unitEur(layer.unitCost))}${layer.editable && !item.archived
    ? `<form class="layer-cost" data-layer="${esc(layer.id)}" novalidate><input name="unitCost" type="number" min="0" step="0.0001" inputmode="decimal" aria-label="Inkoopprijs van deze laag" placeholder="${layer.unitCost == null ? 'prijs' : 'wijzig'}"><button class="btn small" type="submit">${layer.unitCost == null ? 'Invullen' : 'Wijzigen'}</button></form>` : ''}</td>
        <td class="num">${layer.value == null ? '–' : esc(eur(layer.value))}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Niets op voorraad.</td></tr></tbody>';
  }

  // ---------- Mediabibliotheek ----------
  /**
   * Haalt de mediabibliotheek op en tekent hem.
   * @returns {Promise<void>}
   */
  async function loadMedia() {
    state.media = await api('stock/images');
    renderMedia();
  }

  /** Tekent de mediabibliotheek: een raster met alle afbeeldingen (gefilterd op de zoekterm) of de lijst met artikelen zonder afbeelding. */
  function renderMedia() {
    if (!state.media) return;
    const term = $('#m-search').value.trim().toLowerCase();
    const onlyMissing = $('#m-missing').checked;
    /**
     * Of een tekst de zoekterm bevat.
     * @param {string} text de tekst
     * @returns {boolean} true bij een treffer
     */
    const matches = (text) => String(text).toLowerCase().includes(term);
    const images = state.media.images.filter((image) => !term || matches(image.name) || image.items.some((item) => matches(item.code) || matches(item.name)));
    const missing = state.media.missing.filter((item) => !term || matches(item.code) || matches(item.name));
    $('#m-grid').hidden = onlyMissing;
    $('#m-missing-table').hidden = !onlyMissing;
    $('#m-count').textContent = onlyMissing ? `${missing.length} artikel${missing.length === 1 ? '' : 'en'} zonder afbeelding` : `${images.length} afbeelding${images.length === 1 ? '' : 'en'} · ${state.media.missing.length} artikel${state.media.missing.length === 1 ? '' : 'en'} zonder`;
    $('#m-grid').innerHTML = images.length ? images.map((image) => {
      const first = image.items[0];
      const label = image.items.length ? `${esc(first.code)}${image.items.length > 1 ? ` +${image.items.length - 1}` : ''}` : 'Niet in gebruik';
      return `<figure class="media-card"><a href="${first ? `./?id=${encodeURIComponent(first.id)}` : '#'}" ${first ? `data-open="${esc(first.id)}"` : ''}><img src="${esc(window.ItemImages.src(image.id))}" alt="" loading="lazy"></a>
        <figcaption><b title="${esc(image.items.map((item) => `${item.code} ${item.name}`).join('\n'))}">${label}</b><span class="muted small">${esc(image.width)}×${esc(image.height)} · ${esc(Math.round(image.size / 1024))} kB</span>${image.sourceUrl ? `<span class="muted small" title="${esc(image.sourceUrl)}">van oude webshop</span>` : ''}</figcaption></figure>`;
    }).join('') : '<p class="muted">Nog geen afbeeldingen. Upload ze bij een artikel of neem ze over uit de webshop.</p>';
    $('#m-missing-table').innerHTML = missing.length ? `<thead><tr><th>Code</th><th>Omschrijving</th></tr></thead><tbody>${missing.map((item) => `<tr data-id="${esc(item.id)}"><td class="code"><a href="./?id=${encodeURIComponent(item.id)}">${esc(item.code)}</a></td><td class="wrap">${esc(item.name)}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Alle artikelen hebben een afbeelding.</td></tr></tbody>';
  }

  /** Koppelt de zoekbalk, het filter en het openen van een artikel in de mediabibliotheek. */
  function setupMedia() {
    $('#m-search').oninput = renderMedia;
    $('#m-missing').onchange = renderMedia;
    /**
     * Opent het artikel bij een klik op een afbeelding of een regel zonder afbeelding.
     * @param {MouseEvent} event de klik
     */
    $('#tab-media').onclick = (event) => {
      const target = event.target.closest('[data-open], tr[data-id]');
      if (!target || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      openItem(target.dataset.open || target.dataset.id, true);
    };
  }

  /** Tekent het blok Afbeelding van het geopende artikel. */
  function renderImage() {
    const item = state.item;
    $('#d-image-view').innerHTML = item.imageId ? `<img src="${esc(window.ItemImages.src(item.imageId))}" alt="">` : '<span class="muted small">Geen afbeelding</span>';
    $('#d-image-remove').hidden = !item.imageId;
    $('#d-image-file').value = '';
    $('.err', $('#d-image')).textContent = '';
  }

  /** Koppelt het uploaden en verwijderen van de afbeelding van een artikel. */
  function setupImage() {
    const errorBox = $('.err', $('#d-image'));
    /** Verkleint en uploadt de gekozen afbeelding. */
    $('#d-image-file').onchange = async () => {
      const file = $('#d-image-file').files && $('#d-image-file').files[0];
      if (!file) return;
      errorBox.textContent = '';
      try {
        state.item.imageId = await window.ItemImages.upload(state.item.id, await window.ItemImages.prepare(file));
        toast('Afbeelding opgeslagen');
      } catch (error) { errorBox.textContent = error.message; }
      renderImage();
    };
    /** Haalt de afbeelding weg. */
    $('#d-image-remove').onclick = async () => {
      errorBox.textContent = '';
      try {
        await window.ItemImages.remove(state.item.id);
        state.item.imageId = null;
        toast('Afbeelding verwijderd');
      } catch (error) { errorBox.textContent = error.message; }
      renderImage();
    };
  }

  // ---------- Afbeeldingen uit de webshop ----------
  /** Opent het venster om de afbeeldingen van de webshop over te nemen en toont hoeveel er nog te doen is. */
  async function openImagesImport() {
    const dialog = $('#images-dialog');
    $('#images-failed').hidden = true;
    $('#images-bar').value = 0;
    $('#images-start').hidden = true;
    $('#images-text').textContent = 'Controleren…';
    dialog.showModal();
    try {
      const pendingCount = await window.ItemImages.pending();
      $('#images-text').textContent = pendingCount
        ? `${pendingCount} artikel${pendingCount === 1 ? '' : 'en'} gebruik${pendingCount === 1 ? 't' : 'en'} nog de afbeelding van de oude webshop. Overnemen bewaart ze in dit systeem; opnieuw uitvoeren neemt alleen over wat nog ontbreekt.`
        : 'Alle afbeeldingen van gekoppelde webshopproducten staan al in dit systeem.';
      $('#images-start').hidden = !pendingCount;
      $('#images-start').dataset.total = String(pendingCount);
    } catch (error) {
      $('#images-text').textContent = `Controleren mislukt: ${error.message}`;
    }
  }

  /** Koppelt de knoppen van het venster Afbeeldingen uit de webshop. */
  function setupImagesImport() {
    /** Sluit het venster. */
    $('#images-close').onclick = () => { $('#images-dialog').close(); };
    /** Neemt de afbeeldingen over met een voortgangsbalk. */
    $('#images-start').onclick = async () => {
      const total = Number($('#images-start').dataset.total) || 1;
      $('#images-start').hidden = true;
      $('#images-close').disabled = true;
      try {
        const totals = await window.ItemImages.importAll((progress) => {
          $('#images-bar').value = Math.min(1, (total - progress.pending) / total);
          $('#images-text').textContent = `${progress.imported + progress.reused} artikelen gekoppeld, ${progress.stored} afbeeldingen bewaard…`;
        });
        $('#images-bar').value = 1;
        const linked = totals.imported + totals.reused;
        $('#images-text').textContent = `Klaar: ${linked} artikel${linked === 1 ? '' : 'en'} gekoppeld; ${totals.stored} nieuwe afbeelding${totals.stored === 1 ? '' : 'en'} bewaard, bestaande foto\'s zijn hergebruikt${totals.failed.length ? `. ${totals.failed.length} niet gelukt` : ''}.`;
        if (totals.failed.length) {
          $('#images-failed').hidden = false;
          $('#images-failed').innerHTML = `Niet gelukt (opnieuw uitvoeren probeert ze nog eens):<br>${totals.failed.slice(0, 20).map((failure) => `${esc(failure.code)}: ${esc(failure.reason)}`).join('<br>')}${totals.failed.length > 20 ? `<br>… en ${totals.failed.length - 20} meer` : ''}`;
        }
        await load();
      } catch (error) {
        $('#images-text').textContent = `Overnemen mislukt: ${error.message}`;
        $('#images-start').hidden = false;
      } finally {
        $('#images-close').disabled = false;
      }
    };
  }

  /**
   * Een regel van het kenmerkenformulier.
   * @param {{ name: string, values: string[] }} attribute het kenmerk (leeg voor een nieuw)
   * @returns {string} HTML van de regel
   */
  const attributeRow = (attribute) => `<div class="row v-attr">
      <label>Kenmerk<input data-a="name" maxlength="40" value="${esc(attribute.name)}" placeholder="Bijv. Maat"></label>
      <label class="grow">Waarden (met komma's)<input data-a="values" value="${esc(attribute.values.join(', '))}" placeholder="Bijv. 16 mm, 20 mm, 25 mm"></label>
      <button class="btn ghost icon" type="button" data-del-attr title="Kenmerk weghalen">✕</button>
    </div>`;

  /** Tekent het blok Varianten: de kenmerken en de varianten van een hoofdartikel (niet bij een variant). */
  function renderVariants() {
    const item = state.item;
    const card = $('#d-variants');
    card.hidden = Boolean(item.parentId) || (item.archived && !item.hasVariants);
    if (card.hidden) return;
    const variants = item.variants || [];
    $('#v-hint').textContent = item.hasVariants
      ? 'Voeg waarden toe om nieuwe varianten te maken. Een variant weghalen doe je op de variant zelf.'
      : 'Heeft dit artikel maten, kleuren of lengtes? Geef de kenmerken op; elke combinatie wordt een variant met een eigen code, prijs en voorraad. Kan alleen zolang dit artikel zelf geen voorraad of boekingen heeft.';
    $('#v-unmerge-row').hidden = !item.hasVariants;
    $('#v-attrs').innerHTML = (item.attributes.length ? item.attributes : [{ name: '', values: [] }]).map(attributeRow).join('');
    $('#d-var-table').innerHTML = variants.length ? `<thead><tr><th>Variant</th><th class="num">Op voorraad</th><th class="num">Gereserveerd</th><th class="num">Beschikbaar</th><th class="num">Minimum</th><th class="num">Inkoopprijs</th><th class="num">Verkoopprijs</th><th>Webshop</th></tr></thead>
      <tbody>${variants.map((variant) => `<tr data-id="${esc(variant.id)}" class="${variant.low ? 'low' : ''}${variant.archived ? ' arch' : ''}">
        <td class="wrap"><a class="code variant-link" href="./?id=${esc(encodeURIComponent(variant.id))}">${esc(variant.code)}</a>${variant.archived ? ' <span class="pill">Gearchiveerd</span>' : ''}<span class="sub">${esc(valuesText(variant))}</span></td>
        <td class="num${variant.onHand < 0 ? ' neg' : ''}">${esc(nl(variant.onHand))} ${esc(variant.unit)}</td>
        <td class="num">${variant.reserved ? esc(nl(variant.reserved)) : ''}</td>
        <td class="num avail">${esc(nl(variant.available))}${variant.low ? ' <span class="pill low">Bijbestellen</span>' : ''}</td>
        <td class="num">${variant.minQty ? esc(nl(variant.minQty)) : ''}</td>
        <td class="num">${esc(eur(variant.costPrice))}</td>
        <td class="num">${esc(eur(variant.salePrice))}</td>
        <td>${shopPill(variant)}</td></tr>`).join('')}</tbody>` : '';
    $('#d-var-table').querySelectorAll('tr[data-id]').forEach((row) => {
      /**
       * Opent de variant.
       * @returns {Promise<void>}
       */
      row.onclick = () => openItem(row.dataset.id, true);
    });
    $('#d-var-table').querySelectorAll('.variant-link').forEach((link) => {
      /**
       * Opent de variant via de link (ook met het toetsenbord), zonder de pagina te herladen.
       * @param {MouseEvent} event de klik
       * @returns {void}
       */
      link.onclick = (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) { event.stopPropagation(); return; }
        event.preventDefault();
        event.stopPropagation();
        openItem(link.closest('tr').dataset.id, true, null, { focus: true });
      };
    });
  }

  /**
   * Opent een artikel.
   * @param {string} id id van het artikel
   * @param {boolean} push true om het adres (?id=) in de geschiedenis te zetten
   * @param {Promise<object>|null} pending het al lopende verzoek om het artikel (of null)
   * @param {{ focus?: boolean }} [options] focus: de focus naar de titel van het artikel (na een toetsenbord- of linkactie)
   * @returns {Promise<void>}
   */
  async function openItem(id, push = false, pending = null, { focus = false } = {}) {
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
    const heading = focus ? $('#d-title') : null;
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }

  /** Toont het overzicht in plaats van het artikel. */
  function showList() {
    $('#v-item').hidden = true;
    $('#v-list').hidden = false;
    document.title = 'Artikelen – AquaTech Service';
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
    moveForm.kind.onchange = () => {
      moveForm.qty.min = moveForm.kind.value === 'correctie' ? '' : '0';
      $('[data-receipt-only]', moveForm).hidden = moveForm.kind.value !== 'ontvangst';
    };
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
        const unitCost = moveForm.kind.value === 'ontvangst' ? num(moveForm.unitCost.value) : null;
        state.item = await api(`stock/items/${encodeURIComponent(state.item.id)}/movements`, { method: 'POST', body: { kind: moveForm.kind.value, qty, note: moveForm.note.value, ...(unitCost === null ? {} : { unitCost }) } });
        moveForm.qty.value = '';
        moveForm.note.value = '';
        moveForm.unitCost.value = '';
        renderItem();
        toast('Geboekt');
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
    const costForm = $('#cost-form');
    /**
     * Voegt een nieuwe inkoopprijs toe (de oude blijft in de historie).
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    costForm.onsubmit = async (event) => {
      event.preventDefault();
      const errorBox = $('#cost-err');
      errorBox.textContent = '';
      const price = num(costForm.price.value);
      if (price === null || !Number.isFinite(price)) { errorBox.textContent = 'Vul een inkoopprijs in.'; return; }
      try {
        state.item = await api(`stock/items/${encodeURIComponent(state.item.id)}/cost-prices`, { method: 'POST', body: { price, validFrom: costForm.validFrom.value, note: costForm.note.value } });
        costForm.reset();
        renderItem();
        toast('Inkoopprijs toegevoegd');
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
    /**
     * Vult de inkoopprijs in van een voorraadlaag (formulier in de tabel met lagen).
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    $('#d-layers').onsubmit = async (event) => {
      const layerForm = event.target.closest('form.layer-cost');
      if (!layerForm) return;
      event.preventDefault();
      const errorBox = $('#cost-err');
      errorBox.textContent = '';
      const unitCost = num(layerForm.unitCost.value);
      if (unitCost === null || !Number.isFinite(unitCost)) { errorBox.textContent = 'Vul de inkoopprijs van deze laag in.'; return; }
      try {
        state.item = await api(`stock/items/${encodeURIComponent(state.item.id)}/layers/${encodeURIComponent(layerForm.dataset.layer)}`, { method: 'PUT', body: { unitCost } });
        renderItem();
        toast('Inkoopprijs van de laag ingevuld');
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
          salePrice: num(editForm.salePrice.value), vatRate: Number(editForm.vatRate.value), weightGrams: num(editForm.weightGrams.value), businessPrice: num(editForm.businessPrice.value), revenueGroup: editForm.revenueGroup.value, shopSync: editForm.shopSync.checked,
          packSize: num(editForm.packSize.value), orderMinQty: num(editForm.orderMinQty.value), priceTiers: parseTiers(editForm.priceTiers.value), unitContent: num(editForm.unitContent.value),
          description: editForm.description.value, specifications: editForm.specifications.value,
        } }) };
        toast('Opgeslagen');
        await loadUnits().catch((error) => toast(error.message, true));
        renderItem();
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
      if (!confirm(`${item.code} verwijderen?\n\nHeeft het artikel al mutaties, dan wordt het gearchiveerd (het logboek blijft bewaard). Reserveringen op werkorders vervallen. Staat het artikel op een open webshopbestelling, dan kan het niet weg.`)) return;
      try {
        const result = await api(`stock/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        toast(result.archived ? `${item.code} gearchiveerd` : `${item.code} verwijderd`);
        history.pushState(null, '', './');
        showList();
        await Promise.all([load(), loadUnits().catch((error) => toast(error.message, true))]);
      } catch (error) {
        toast(error.message, true);
      }
    };
    /**
     * Draait het samenvoegen terug na bevestiging: de varianten worden weer losse artikelen.
     * @returns {Promise<void>}
     */
    $('#v-unmerge').onclick = async () => {
      const item = state.item;
      const button = $('#v-unmerge');
      button.disabled = true;
      try {
        const preview = await api(`stock/items/${encodeURIComponent(item.id)}/unmerge`);
        if (preview.blocked) { toast(preview.blocked, true); return; }
        const outcomeText = { weg: ' (na het samenvoegen bijgemaakt: wordt verwijderd)', gearchiveerd: ' (na het samenvoegen bijgemaakt, heeft boekingen: wordt gearchiveerd)' };
        const codes = preview.variants.map((variant) => `• ${variant.code} ${variant.name}${outcomeText[variant.outcome] || ''}`).join('\n');
        const looseCount = preview.variants.filter((variant) => variant.outcome === 'los').length;
        const origin = preview.logged
          ? `Samengevoegd op ${new Date(preview.mergedAt).toLocaleDateString('nl-NL')}. ${preview.restoresLinks ? `${preview.restoresLinks} webshopkoppeling${preview.restoresLinks === 1 ? '' : 'en'} komt terug.` : ''}`
          : 'Van deze samenvoeging is geen momentopname (gemaakt vóór deze functie): de varianten worden losgemaakt, eerdere webshopkoppelingen komen niet terug.';
        if (!confirm(`${item.code} ongedaan maken?\n\n${looseCount} ${looseCount === 1 ? 'artikel wordt' : 'artikelen worden'} weer los en ${item.code} verdwijnt:\n${codes}\n\nCode, omschrijving, prijzen, voorraad (ook boekingen sinds het samenvoegen) en afbeelding blijven zoals ze nu zijn. ${origin}`)) return;
        const result = await api(`stock/items/${encodeURIComponent(item.id)}/unmerge`, { method: 'POST', body: {} });
        toast(`${result.restored} artikelen weer los${result.linksRestored ? `, ${result.linksRestored} webshopkoppeling${result.linksRestored === 1 ? '' : 'en'} hersteld` : ''}`);
        history.pushState(null, '', './');
        showList();
        await load();
      } catch (error) {
        toast(error.message, true);
      } finally {
        button.disabled = false;
      }
    };
    /**
     * Opent het hoofdartikel vanaf een variant.
     * @param {MouseEvent} event de klik
     */
    $('#d-variant-of').onclick = (event) => {
      const link = event.target.closest('[data-open]');
      if (!link) return;
      event.preventDefault();
      openItem(link.dataset.open, true);
    };
    const variantsForm = $('#variants-form');
    /** Voegt een lege regel voor een kenmerk toe (hooguit drie). */
    $('#v-add-attr').onclick = () => {
      if ($('#v-attrs').children.length >= 3) { toast('Hooguit drie kenmerken per artikel.', true); return; }
      $('#v-attrs').insertAdjacentHTML('beforeend', attributeRow({ name: '', values: [] }));
    };
    /**
     * Haalt een kenmerk weg uit het formulier.
     * @param {MouseEvent} event de klik
     */
    $('#v-attrs').onclick = (event) => {
      const button = event.target.closest('[data-del-attr]');
      if (button) button.closest('.v-attr').remove();
    };
    /**
     * Slaat de kenmerken op; de server maakt de ontbrekende varianten aan.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    variantsForm.onsubmit = async (event) => {
      event.preventDefault();
      const errorBox = $('.err', variantsForm);
      errorBox.textContent = '';
      const attributes = [...variantsForm.querySelectorAll('.v-attr')].map((row) => ({
        name: $('[data-a="name"]', row).value, values: $('[data-a="values"]', row).value.split(','),
      })).filter((attribute) => attribute.name.trim() || attribute.values.some((value) => value.trim()));
      if (!state.item.hasVariants && !attributes.length) { errorBox.textContent = 'Geef minstens één kenmerk met waarden op.'; return; }
      try {
        const result = await api(`stock/items/${encodeURIComponent(state.item.id)}/variants`, { method: 'PUT', body: { attributes } });
        state.item = result;
        renderItem();
        toast(result.created || result.restored ? `${result.created} variant${result.created === 1 ? '' : 'en'} aangemaakt${result.restored ? `, ${result.restored} teruggezet` : ''}` : 'Opgeslagen');
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
    /**
     * Zet het artikel (met varianten) als nieuw product in de webshop.
     * @returns {Promise<void>}
     */
    $('#d-publish').onclick = async () => {
      const item = state.item;
      if (!confirm(`${item.code} als nieuw product in de webshop zetten${item.hasVariants ? ' (met alle varianten)' : ''}? Het product is daarna meteen zichtbaar in de webshop.`)) return;
      const button = $('#d-publish');
      button.disabled = true;
      try {
        state.item = await api(`stock/items/${encodeURIComponent(item.id)}/publish`, { method: 'POST', body: {} });
        renderItem();
        const warning = state.item.published && state.item.published.warning;
        toast(warning || 'In de webshop gezet', Boolean(warning));
      } catch (error) {
        toast(error.message, true);
      } finally {
        button.disabled = false;
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
        { header: 'Hoofdartikel', key: 'parent', width: 16 },
        { header: 'Variant', key: 'variant', width: 22 },
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
      // Hoofdartikelen hebben geen eigen voorraad: alleen de varianten (met hun hoofdartikel) komen erin.
      const codeOf = new Map(state.items.map((item) => [item.id, item.code]));
      // Past het hoofdartikel bij de zoekterm, dan gaan al zijn varianten mee (zoals in het overzicht).
      const matched = visible();
      const matchedParents = new Set(matched.filter((item) => item.hasVariants).map((item) => item.id));
      const matchedIds = new Set(matched.map((item) => item.id));
      // Met "Alleen onder minimum" telt per variant het eigen minimum (zoals in het overzicht).
      const lowOnly = $('#f-low').checked;
      const items = state.items.filter((item) => !item.hasVariants && (matchedIds.has(item.id) || (item.parentId && matchedParents.has(item.parentId) && (!lowOnly || item.low))));
      for (const item of items) {
        worksheet.addRow({ ...item, parent: item.parentId ? codeOf.get(item.parentId) || '' : '', variant: valuesText(item), low: item.low ? 'ja' : '', archived: item.archived ? 'ja' : '', costPrice: item.costPrice, value: item.value, salePrice: item.salePrice,
          vat: `${item.vatRate}%`, group: GROUPS[item.revenueGroup] || item.revenueGroup,
          shop: !item.shopSync ? 'niet' : item.shop.error ? 'fout' : item.shop.productId ? `product ${item.shop.productId}` : 'niet gekoppeld' });
      }
      worksheet.getRow(1).font = { bold: true };
      worksheet.autoFilter = `A1:T${items.length + 1}`;
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
        { header: 'Leverancier', key: 'supplierName', width: 24 },
        { header: 'Artikelcode', key: 'code', width: 16 },
        { header: 'Art.nr. leverancier', key: 'supplierSku', width: 18 },
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
      // Per leverancier bij elkaar (op naam, zonder leverancier als laatste), zoals de server de groepen geeft.
      const groupOrder = new Map(proposal.suppliers.map((group, index) => [group.supplierId, index]));
      const sorted = [...proposal.items].sort((left, right) => groupOrder.get(left.supplierId) - groupOrder.get(right.supplierId));
      for (const item of sorted) sheet.addRow({ ...item, supplierName: item.supplierName || 'Zonder leverancier' });
      const totalRow = sheet.addRow({ name: 'Totaal (artikelen met inkoopprijs)', amount: proposal.total });
      totalRow.font = { bold: true };
      sheet.getRow(1).font = { bold: true };
      // Filter over de kop en de artikelregels, zonder de totaalregel.
      sheet.autoFilter = `A1:N${proposal.items.length + 1}`;
      const summary = excelWorkbook.addWorksheet('Per leverancier', { views: [{ state: 'frozen', ySplit: 1 }] });
      summary.columns = [
        { header: 'Leverancier', key: 'supplierName', width: 28 },
        { header: 'Regels', key: 'count', width: 10 },
        { header: 'Bedrag (artikelen met inkoopprijs)', key: 'total', width: 34, style: euro },
      ];
      for (const group of proposal.suppliers) summary.addRow({ ...group, supplierName: group.supplierName || 'Zonder leverancier' });
      summary.getRow(1).font = { bold: true };
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
        ? 'Je rol heeft geen toegang tot Artikelen. <a href="../">Terug naar het overzicht</a>'
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
    $('#b-shop').onclick = () => importShop();
    /** Opent het venster om de afbeeldingen van de webshop over te nemen. */
    $('#b-images').onclick = () => { openImagesImport(); };
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
    setupUnits();
    setupNew();
    setupImport();
    window.ArtikelenMerge.setup({
      api, toast, esc, eur, nl, getItems: () => state.items,
      /**
       * Na het samenvoegen: de lijst verversen en het nieuwe hoofdartikel openen.
       * @param {object} parent het nieuwe hoofdartikel
       * @returns {Promise<void>}
       */
      onMerged: async (parent) => { state.open.add(parent.id); await load(); await openItem(parent.id, true); },
    });
    window.ArtikelenSuppliers.setup({ api, toast, esc, nl, eur });
    loadUnits().catch((error) => toast(error.message, true));
    setupShop();
    setupMedia();
    setupImagesImport();
    setupImage();
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
      if (['stock', 'reserved', 'moves', 'suppliers', 'media'].includes(hash)) showTab(hash);
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
