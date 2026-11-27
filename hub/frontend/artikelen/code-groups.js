// Merken en soorten (module Artikelen): het tabblad Merken & soorten met de hoofdgroepen (merk, bijvoorbeeld UD) en subgroepen (soort,
// bijvoorbeeld KBI) waaruit de sprekende artikelcodes MERK.SOORT.DIAMETER.DRAADMAAT worden opgebouwd, en een kaart om een codevoorstel te
// proberen. Praat met /api/stock/code-groups, /api/stock/main-groups, /api/stock/sub-groups en /api/stock/code-proposal (recht 'voorraad').
(function () {
  const context = { api: null, toast: null, esc: null };
  const state = { mainGroups: [], subGroups: [], editingMain: null, editingSub: null };

  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @param {ParentNode} scope waarbinnen gezocht wordt (standaard het document)
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector, scope = document) => scope.querySelector(selector);

  /**
   * Laadt de merken en soorten (met de gearchiveerde als dat is aangevinkt) en tekent alles opnieuw.
   * @returns {Promise<void>}
   */
  async function load() {
    const result = await context.api(`stock/code-groups${$('#cg-archived').checked ? '?archived=1' : ''}`);
    state.mainGroups = result.mainGroups;
    state.subGroups = result.subGroups;
    renderMain();
    renderSub();
    renderChoices();
  }

  /** Tekent de tabel met merken. */
  function renderMain() {
    const esc = context.esc;
    $('#mg-table').innerHTML = state.mainGroups.length ? `<thead><tr><th>Code</th><th>Naam</th><th class="num">Artikelen</th><th></th></tr></thead>
      <tbody>${state.mainGroups.map((group) => `<tr class="${group.archived ? 'arch' : ''}"><td><b>${esc(group.code)}</b></td>
        <td class="wrap">${esc(group.name)}${group.archived ? ' <span class="pill">Gearchiveerd</span>' : ''}</td><td class="num">${group.itemCount}</td>
        <td class="num"><button class="btn small" type="button" data-edit-main="${esc(group.id)}">Wijzigen</button></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">Nog geen merken. Voeg er een toe, of maak soorten zonder merk.</td></tr></tbody>';
  }

  /**
   * De naam van het merk bij een soort.
   * @param {object} subGroup De soort.
   * @returns {string} Merkcode, of een streepje bij een soort zonder merk.
   */
  function brandCodeOf(subGroup) {
    const brand = state.mainGroups.find((group) => group.id === subGroup.mainGroupId);
    return brand ? brand.code : '–';
  }

  /** Tekent de tabel met soorten. */
  function renderSub() {
    const esc = context.esc;
    $('#sg-table').innerHTML = state.subGroups.length ? `<thead><tr><th>Merk</th><th>Soort</th><th>Naam</th><th class="num">Artikelen</th><th></th></tr></thead>
      <tbody>${state.subGroups.map((group) => `<tr class="${group.archived ? 'arch' : ''}"><td>${esc(brandCodeOf(group))}</td><td><b>${esc(group.code)}</b></td>
        <td class="wrap">${esc(group.name)}${group.archived ? ' <span class="pill">Gearchiveerd</span>' : ''}</td><td class="num">${group.itemCount}</td>
        <td class="num"><button class="btn small" type="button" data-edit-sub="${esc(group.id)}">Wijzigen</button></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">Nog geen soorten.</td></tr></tbody>';
  }

  /** Vult de keuzelijsten: het merk bij een soort (ook zonder merk) en de soort bij het codevoorstel. */
  function renderChoices() {
    const esc = context.esc;
    const activeMain = state.mainGroups.filter((group) => !group.archived || (state.editingSub && state.editingSub.mainGroupId === group.id));
    const form = $('#sg-form');
    const selectedMain = form.mainGroupId.value;
    form.mainGroupId.innerHTML = `<option value="">Zonder merk</option>${activeMain.map((group) => `<option value="${esc(group.id)}">${esc(group.code)} · ${esc(group.name)}</option>`).join('')}`;
    form.mainGroupId.value = selectedMain;
    const proposal = $('#cp-form');
    const selectedSub = proposal.subGroupId.value;
    proposal.subGroupId.innerHTML = `<option value="">Kies een soort</option>${state.subGroups.filter((group) => !group.archived).map((group) => `<option value="${esc(group.id)}">${esc(brandCodeOf(group) === '–' ? '' : `${brandCodeOf(group)} · `)}${esc(group.code)} · ${esc(group.name)}</option>`).join('')}`;
    proposal.subGroupId.value = selectedSub;
  }

  /**
   * Zet een formulier voor een merk of soort klaar om te wijzigen of om een nieuwe te maken.
   * @param {'main'|'sub'} kind Merk of soort.
   * @param {object|null} group De groep om te wijzigen, of null voor een nieuwe.
   */
  function openForm(kind, group) {
    const form = $(kind === 'main' ? '#mg-form' : '#sg-form');
    const prefix = kind === 'main' ? 'mg' : 'sg';
    if (kind === 'main') state.editingMain = group; else state.editingSub = group;
    form.code.value = group ? group.code : '';
    form.name.value = group ? group.name : '';
    if (kind === 'sub') { renderChoices(); form.mainGroupId.value = group ? group.mainGroupId || '' : ''; }
    form.code.readOnly = Boolean(group && group.itemCount);
    if (kind === 'sub') form.mainGroupId.disabled = Boolean(group);
    $('[data-cancel]', form).hidden = !group;
    $(`#${prefix}-remove`).hidden = !group || group.archived;
    $(`#${prefix}-restore`).hidden = !group || !group.archived;
    $('.err', form).textContent = '';
    form.code.focus();
  }

  /**
   * Bewaart het merk of de soort uit het formulier.
   * @param {'main'|'sub'} kind Merk of soort.
   * @param {SubmitEvent} event het verzenden
   * @returns {Promise<void>}
   */
  async function submit(kind, event) {
    event.preventDefault();
    const form = event.target;
    const errorBox = $('.err', form);
    errorBox.textContent = '';
    const editing = kind === 'main' ? state.editingMain : state.editingSub;
    const path = kind === 'main' ? 'stock/main-groups' : 'stock/sub-groups';
    const body = { code: form.code.value, name: form.name.value };
    if (kind === 'sub' && !editing) body.mainGroupId = form.mainGroupId.value || null;
    try {
      if (editing) await context.api(`${path}/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body });
      else await context.api(path, { method: 'POST', body });
      if (kind === 'main') state.editingMain = null; else state.editingSub = null;
      await load();
      openForm(kind, null);
      context.toast(kind === 'main' ? 'Merk bewaard' : 'Soort bewaard');
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  /**
   * Verwijdert (of archiveert) of zet het merk of de soort uit het formulier terug.
   * @param {'main'|'sub'} kind Merk of soort.
   * @param {boolean} restore true om een gearchiveerde groep terug te zetten
   * @returns {Promise<void>}
   */
  async function removeOrRestore(kind, restore) {
    const form = $(kind === 'main' ? '#mg-form' : '#sg-form');
    const errorBox = $('.err', form);
    errorBox.textContent = '';
    const editing = kind === 'main' ? state.editingMain : state.editingSub;
    const path = `${kind === 'main' ? 'stock/main-groups' : 'stock/sub-groups'}/${encodeURIComponent(editing.id)}`;
    try {
      if (restore) await context.api(path, { method: 'PATCH', body: { archived: false } });
      else {
        const result = await context.api(path, { method: 'DELETE' });
        context.toast(result.archived ? 'Gearchiveerd (er hangen nog artikelen of soorten aan)' : 'Verwijderd');
      }
      if (kind === 'main') state.editingMain = null; else state.editingSub = null;
      await load();
      openForm(kind, null);
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  /** Vraagt een codevoorstel op bij de gekozen soort, diameter en draadmaat en toont het resultaat. */
  async function proposeCode() {
    const form = $('#cp-form');
    const result = $('#cp-result');
    if (!form.subGroupId.value) { result.textContent = ''; return; }
    const query = new URLSearchParams({ subGroupId: form.subGroupId.value, diameter: form.diameter.value.trim(), thread: form.thread.value.trim() });
    try {
      const proposal = await context.api(`stock/code-proposal?${query}`);
      result.textContent = proposal.taken ? `${proposal.code} bestaat al als artikel.` : `Voorstel: ${proposal.code}`;
      result.classList.toggle('bad', Boolean(proposal.taken));
    } catch (error) {
      result.textContent = error.message;
      result.classList.add('bad');
    }
  }

  /**
   * Koppelt de formulieren en knoppen van het tabblad.
   * @param {{ api: Function, toast: Function, esc: Function }} options De hulpfuncties van de pagina.
   * @returns {void}
   */
  function setup(options) {
    Object.assign(context, options);
    for (const [kind, formId, prefix] of [['main', '#mg-form', 'mg'], ['sub', '#sg-form', 'sg']]) {
      /**
       * Bewaart het formulier.
       * @param {SubmitEvent} event het verzenden
       */
      $(formId).onsubmit = (event) => { submit(kind, event); };
      /** Stopt met wijzigen en maakt het formulier leeg. */
      $(`${formId} [data-cancel]`).onclick = () => { openForm(kind, null); };
      /** Verwijdert of archiveert de groep. */
      $(`#${prefix}-remove`).onclick = () => { removeOrRestore(kind, false); };
      /** Zet de groep terug uit het archief. */
      $(`#${prefix}-restore`).onclick = () => { removeOrRestore(kind, true); };
    }
    /**
     * Opent het merk waarop is geklikt.
     * @param {MouseEvent} event de klik
     */
    $('#mg-table').onclick = (event) => {
      const button = event.target.closest('[data-edit-main]');
      if (button) openForm('main', state.mainGroups.find((group) => group.id === button.dataset.editMain) || null);
    };
    /**
     * Opent de soort waarop is geklikt.
     * @param {MouseEvent} event de klik
     */
    $('#sg-table').onclick = (event) => {
      const button = event.target.closest('[data-edit-sub]');
      if (button) openForm('sub', state.subGroups.find((group) => group.id === button.dataset.editSub) || null);
    };
    /** Laadt de lijsten opnieuw met of zonder gearchiveerde groepen. */
    $('#cg-archived').onchange = () => { load().catch((error) => context.toast(error.message, true)); };
    /** Werkt het codevoorstel bij zodra een keuze of invoer verandert. */
    $('#cp-form').oninput = () => { proposeCode(); };
    /**
     * Voorkomt dat het formulier de pagina ververst en vraagt het voorstel op.
     * @param {SubmitEvent} event het verzenden
     */
    $('#cp-form').onsubmit = (event) => { event.preventDefault(); proposeCode(); };
  }

  window.ArtikelenCodeGroups = { setup, load };
}());
