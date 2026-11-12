// Leveranciers (module Artikelen): het tabblad Leveranciers (lijst, aanmaken, wijzigen, archiveren)
// en per artikel het blok Leveranciers (welke leverancier levert dit artikel, met artikelnummer van de
// leverancier, eigen inkoopprijs, bestelhoeveelheid en de voorkeur). Praat met /api/suppliers en
// /api/stock/items/:id/suppliers (recht 'voorraad').
(function () {
  const context = { api: null, toast: null, esc: null, nl: null, eur: null };
  const state = { suppliers: [], editing: null, item: null, lines: [] };

  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector) => document.querySelector(selector);

  /**
   * Laadt de leveranciers (met de gearchiveerde als dat is aangevinkt) en tekent de lijst.
   * @returns {Promise<void>}
   */
  async function load() {
    const result = await context.api(`suppliers${$('#sup-archived').checked ? '?archived=1' : ''}`);
    state.suppliers = result.items;
    renderList();
  }

  /** Tekent de tabel met leveranciers. */
  function renderList() {
    const esc = context.esc;
    $('#sup-table').innerHTML = state.suppliers.length ? `<thead><tr><th>Naam</th><th>Contact</th><th>E-mail</th><th>Telefoon</th><th class="num">Artikelen</th><th></th></tr></thead>
      <tbody>${state.suppliers.map((supplier) => `<tr class="${supplier.archived ? 'arch' : ''}">
        <td class="wrap">${esc(supplier.name)}${supplier.archived ? ' <span class="pill">Gearchiveerd</span>' : ''}</td><td>${esc(supplier.contactName)}</td>
        <td>${supplier.email ? `<a href="mailto:${esc(supplier.email)}">${esc(supplier.email)}</a>` : ''}</td><td>${esc(supplier.phone)}</td><td class="num">${supplier.itemCount}</td>
        <td class="num"><button class="btn small" type="button" data-edit="${esc(supplier.id)}">Wijzigen</button></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">Nog geen leveranciers.</td></tr></tbody>';
  }

  /**
   * Opent het formulier voor een nieuwe of bestaande leverancier.
   * @param {object|null} supplier De leverancier om te wijzigen, of null voor een nieuwe.
   */
  function openForm(supplier) {
    const form = $('#supplier-form');
    state.editing = supplier;
    form.reset();
    $('h3', form).textContent = supplier ? `Leverancier ${supplier.name}` : 'Nieuwe leverancier';
    for (const field of ['name', 'contactName', 'email', 'phone', 'address', 'notes']) form[field].value = supplier ? supplier[field] : '';
    $('#sup-remove').hidden = !supplier || supplier.archived;
    $('#sup-restore').hidden = !supplier || !supplier.archived;
    $('.err', form).textContent = '';
    form.hidden = false;
    form.name.focus();
  }

  /**
   * Bewaart de leverancier uit het formulier.
   * @param {SubmitEvent} event het verzenden
   * @returns {Promise<void>}
   */
  async function submitForm(event) {
    event.preventDefault();
    const form = event.target;
    const errorBox = $('.err', form);
    errorBox.textContent = '';
    const body = {};
    for (const field of ['name', 'contactName', 'email', 'phone', 'address', 'notes']) body[field] = form[field].value;
    try {
      if (state.editing) await context.api(`suppliers/${encodeURIComponent(state.editing.id)}`, { method: 'PATCH', body });
      else await context.api('suppliers', { method: 'POST', body });
      form.hidden = true;
      await load();
      context.toast('Leverancier bewaard');
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  /**
   * Verwijdert (of archiveert) of zet de leverancier uit het formulier terug.
   * @param {boolean} restore true om een gearchiveerde leverancier terug te zetten
   * @returns {Promise<void>}
   */
  async function removeOrRestore(restore) {
    const errorBox = $('#supplier-form .err');
    errorBox.textContent = '';
    try {
      const id = encodeURIComponent(state.editing.id);
      if (restore) await context.api(`suppliers/${id}`, { method: 'PATCH', body: { archived: false } });
      else {
        const result = await context.api(`suppliers/${id}`, { method: 'DELETE' });
        context.toast(result.archived ? 'Leverancier gearchiveerd (hij levert nog artikelen)' : 'Leverancier verwijderd');
      }
      $('#supplier-form').hidden = true;
      await load();
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  // ---------- Per artikel ----------

  /**
   * Toont het blok Leveranciers bij een artikel (niet bij een hoofdartikel met varianten).
   * @param {object} item Het artikel.
   * @returns {Promise<void>}
   */
  async function showItem(item) {
    const section = $('#d-suppliers');
    state.item = item;
    section.hidden = Boolean(item.hasVariants);
    $('.err', section).textContent = '';
    if (item.hasVariants) return;
    const [lines, suppliers] = await Promise.all([context.api(`stock/items/${encodeURIComponent(item.id)}/suppliers`), context.api('suppliers')]);
    if (!state.item || state.item.id !== item.id) return;
    state.suppliers = suppliers.items;
    state.lines = lines.items;
    renderLines();
  }

  /** Tekent de leveranciersregels van het artikel en de keuzelijst om er een bij te zetten. */
  function renderLines() {
    const { esc } = context;
    const item = state.item;
    const archivedItem = Boolean(item && item.archived);
    $('#d-sup-table').innerHTML = state.lines.length ? `<thead><tr><th>Leverancier</th><th>Artikelnummer leverancier</th><th class="num">Inkoopprijs (€)</th><th class="num">Bestelhoeveelheid (${esc(item.unit)})</th><th>Voorkeur</th><th></th></tr></thead>
      <tbody>${state.lines.map((line, index) => `<tr data-line="${index}">
        <td class="wrap">${esc(line.supplierName)}${line.supplierArchived ? ' <span class="pill">Gearchiveerd</span>' : ''}</td>
        <td><input data-field="supplierSku" value="${esc(line.supplierSku)}" maxlength="80" aria-label="Artikelnummer van de leverancier"></td>
        <td class="num"><input data-field="costPrice" type="number" min="0" step="0.0001" inputmode="decimal" value="${line.costPrice == null ? '' : line.costPrice}" placeholder="van het artikel" aria-label="Inkoopprijs"></td>
        <td class="num"><input data-field="orderQty" type="number" min="0" step="any" inputmode="decimal" value="${line.orderQty}" aria-label="Bestelhoeveelheid"></td>
        <td><input type="radio" name="sup-preferred" data-field="preferred" ${line.preferred ? 'checked' : ''} aria-label="Voorkeursleverancier"></td>
        <td class="num"><button class="btn small danger" type="button" data-drop="${index}">Weghalen</button></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">Nog geen leverancier bij dit artikel.</td></tr></tbody>';
    const used = new Set(state.lines.map((line) => line.supplierId));
    const free = state.suppliers.filter((supplier) => !used.has(supplier.id));
    $('#sup-add-select').innerHTML = `<option value="">Kies een leverancier…</option>${free.map((supplier) => `<option value="${esc(supplier.id)}">${esc(supplier.name)}</option>`).join('')}`;
    $('#d-suppliers .row').hidden = archivedItem;
  }

  /** Neemt de ingevulde velden uit de tabel over in de regels (voor weghalen of toevoegen). */
  function readLines() {
    document.querySelectorAll('#d-sup-table tr[data-line]').forEach((row) => {
      const line = state.lines[Number(row.dataset.line)];
      line.supplierSku = row.querySelector('[data-field=supplierSku]').value;
      line.costPrice = row.querySelector('[data-field=costPrice]').value;
      line.orderQty = row.querySelector('[data-field=orderQty]').value;
      line.preferred = row.querySelector('[data-field=preferred]').checked;
    });
  }

  /**
   * Bewaart de leveranciers van het artikel.
   * @returns {Promise<void>}
   */
  async function saveLines() {
    const errorBox = $('#d-suppliers .err');
    errorBox.textContent = '';
    readLines();
    try {
      const body = { suppliers: state.lines.map((line) => ({ supplierId: line.supplierId, supplierSku: line.supplierSku, costPrice: line.costPrice, orderQty: line.orderQty, preferred: line.preferred })) };
      const result = await context.api(`stock/items/${encodeURIComponent(state.item.id)}/suppliers`, { method: 'PUT', body });
      state.lines = result.items;
      renderLines();
      context.toast('Leveranciers bewaard');
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  /**
   * Koppelt de knoppen en formulieren.
   * @param {{ api: Function, toast: Function, esc: Function, nl: Function, eur: Function }} options Hulpfuncties van de pagina.
   */
  function setup(options) {
    Object.assign(context, options);
    /** Opent het formulier voor een nieuwe leverancier. */
    $('#b-sup-new').onclick = () => { openForm(null); };
    /** Laadt de lijst opnieuw met of zonder gearchiveerde leveranciers. */
    $('#sup-archived').onchange = () => { load().catch((error) => context.toast(error.message, true)); };
    $('#supplier-form').onsubmit = submitForm;
    /** Sluit het formulier. */
    $('#supplier-form [data-cancel]').onclick = () => { $('#supplier-form').hidden = true; };
    /** Verwijdert of archiveert de leverancier. */
    $('#sup-remove').onclick = () => { removeOrRestore(false); };
    /** Zet de leverancier terug uit het archief. */
    $('#sup-restore').onclick = () => { removeOrRestore(true); };
    /**
     * Opent het formulier van de leverancier waarop is geklikt.
     * @param {MouseEvent} event de klik
     */
    $('#sup-table').onclick = (event) => {
      const button = event.target.closest('[data-edit]');
      if (button) openForm(state.suppliers.find((supplier) => supplier.id === button.dataset.edit) || null);
    };
    /** Bewaart de leveranciers van het artikel. */
    $('#d-suppliers button[data-save]').onclick = () => { saveLines(); };
    /**
     * Haalt een regel weg (pas bewaard met Bewaren).
     * @param {MouseEvent} event de klik
     */
    $('#d-sup-table').onclick = (event) => {
      const button = event.target.closest('[data-drop]');
      if (!button) return;
      readLines();
      state.lines.splice(Number(button.dataset.drop), 1);
      if (state.lines.length && !state.lines.some((line) => line.preferred)) state.lines[0].preferred = true;
      renderLines();
    };
    /** Zet de gekozen leverancier als nieuwe regel bij het artikel (pas bewaard met Bewaren). */
    $('#sup-add-select').onchange = () => {
      const id = $('#sup-add-select').value;
      const supplier = state.suppliers.find((candidate) => candidate.id === id);
      if (!supplier) return;
      readLines();
      state.lines.push({ supplierId: supplier.id, supplierName: supplier.name, supplierArchived: supplier.archived, supplierSku: '', costPrice: '', orderQty: 1, preferred: !state.lines.length });
      renderLines();
    };
  }

  window.ArtikelenSuppliers = { setup, load, showItem };
})();
