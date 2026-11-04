// Artikelen samenvoegen (module Artikelen): losse artikelen die eigenlijk maten of
// kleuren van één product zijn, omzetten naar één variabel artikel. Stap 1: kies een
// voorstel van het systeem of kies zelf artikelen. Stap 2: controleer code, omschrijving
// en de waarde per artikel; daar staat ook wat er verandert en wat gelijk blijft.
// Praat met /api/stock/merge-suggestions en /api/stock/merge (recht 'voorraad').
(function () {
  /** Hoogstens zoveel artikelen per keer (gelijk aan de grens op de server). */
  const MAX_ITEMS = 30;
  const context = { api: null, toast: null, getItems: null, onMerged: null, esc: null, eur: null, nl: null };
  const state = { groups: [], chosen: [] };

  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector) => document.querySelector(selector);

  /**
   * De losse artikelen waaruit gekozen kan worden: niet gearchiveerd en geen hoofdartikel of variant.
   * @returns {object[]} De artikelen, op code.
   */
  function looseItems() {
    return context.getItems().filter((item) => !item.archived && !item.hasVariants && !item.parentId);
  }

  /**
   * Het gemeenschappelijke begin van artikelcodes, zonder scheidingstekens aan het eind.
   * @param {string[]} codes De codes.
   * @returns {string} Bijv. 'PE-BUIS'; leeg als er geen is van minstens 2 tekens.
   */
  function commonCodePrefix(codes) {
    if (!codes.length) return '';
    let prefix = codes[0];
    codes.forEach((code) => {
      let length = 0;
      while (length < prefix.length && length < code.length && prefix[length] === code[length]) length++;
      prefix = prefix.slice(0, length);
    });
    prefix = prefix.replace(/[-_. /+]+$/, '');
    return prefix.length >= 2 ? prefix : '';
  }

  /**
   * Haalt uit een paar omschrijvingen de gedeelde woorden (begin en eind) en de waarde die per
   * artikel verschilt, voor als de gebruiker zelf artikelen kiest.
   * @param {string[]} names De omschrijvingen.
   * @returns {{ base: string, values: string[] }} De gedeelde omschrijving en per artikel het verschil (leeg als er geen is).
   */
  function diffNames(names) {
    const split = names.map((name) => name.trim().split(/\s+/));
    const shortest = Math.min(...split.map((words) => words.length));
    let start = 0;
    while (start < shortest - 1 && split.every((words) => words[start].toLowerCase() === split[0][start].toLowerCase())) start++;
    let end = 0;
    while (end < shortest - start - 1 && split.every((words) => words[words.length - 1 - end].toLowerCase() === split[0][split[0].length - 1 - end].toLowerCase())) end++;
    const base = [...split[0].slice(0, start), ...split[0].slice(split[0].length - end)].join(' ');
    return { base, values: split.map((words) => words.slice(start, words.length - end).join(' ')) };
  }

  /** Leest de voorstellen van de server en tekent ze. */
  async function loadSuggestions() {
    $('#mg-groups').innerHTML = '<p class="muted small">Voorstellen zoeken…</p>';
    try {
      state.groups = (await context.api('stock/merge-suggestions')).groups;
    } catch (error) {
      state.groups = [];
      $('#mg-groups').innerHTML = `<p class="err">${context.esc(error.message)}</p>`;
      return;
    }
    renderGroups();
  }

  /** Tekent de voorstellen: per groep de omschrijving, de waarden en een knop. */
  function renderGroups() {
    const esc = context.esc;
    $('#mg-groups').innerHTML = state.groups.length
      ? state.groups.map((group, index) => `<div class="merge-group">
          <div><b>${esc(group.name)}</b> <span class="pill">${group.items.length} artikelen</span>
            <span class="sub">${esc(group.attributeName)}: ${esc(group.items.map((entry) => entry.value).join(' · '))}</span>
            <span class="sub code">${esc(group.items.map((entry) => entry.code).join(', '))}</span></div>
          <button type="button" class="btn small primary" data-group="${index}">Samenvoegen…</button>
        </div>`).join('')
      : '<p class="muted small">Geen voorstellen: er zijn geen losse artikelen met dezelfde omschrijving die alleen in maat of kleur verschillen. Kies hieronder zelf artikelen.</p>';
    $('#mg-groups').querySelectorAll('[data-group]').forEach((button) => {
      /** Gaat met dit voorstel naar de controle. */
      button.onclick = () => {
        const group = state.groups[Number(button.dataset.group)];
        const byId = new Map(looseItems().map((item) => [item.id, item]));
        showConfirm(group.items.map((entry) => byId.get(entry.id)).filter(Boolean), {
          code: group.code, name: group.name, attributeName: group.attributeName, values: Object.fromEntries(group.items.map((entry) => [entry.id, entry.value])),
        });
      };
    });
  }

  /** Tekent de lijst om zelf artikelen te kiezen, gefilterd op de zoekterm. */
  function renderManual() {
    const term = $('#mg-search').value.trim().toLowerCase();
    const esc = context.esc;
    const checked = new Set([...document.querySelectorAll('#mg-list input:checked')].map((input) => input.value));
    $('#mg-list').innerHTML = looseItems().filter((item) => checked.has(item.id) || !term || `${item.code} ${item.name}`.toLowerCase().includes(term))
      .slice(0, 400).map((item) => `<label><input type="checkbox" value="${esc(item.id)}"${checked.has(item.id) ? ' checked' : ''}> <span><span class="code">${esc(item.code)}</span> ${esc(item.name)}</span></label>`).join('')
      || '<span class="muted small">Niets gevonden.</span>';
    updateManualButton();
  }

  /** Zet de knop "Verder" aan als er minstens twee artikelen zijn aangevinkt. */
  function updateManualButton() {
    const count = document.querySelectorAll('#mg-list input:checked').length;
    $('#mg-next').disabled = count < 2;
    $('#mg-next').textContent = count >= 2 ? `Verder met ${count} artikelen` : 'Kies minstens twee artikelen';
  }

  /**
   * Toont de controlestap: de gekozen artikelen met een waarde per artikel, en wat er verandert.
   * @param {object[]} items De gekozen artikelen (zoals de lijst ze geeft).
   * @param {{ code?: string, name?: string, attributeName?: string, values?: Object<string, string> }} [preset] Voorgestelde gegevens.
   */
  function showConfirm(items, preset = {}) {
    const esc = context.esc;
    if (items.length < 2 || items.length > MAX_ITEMS) { context.toast(`Kies tussen 2 en ${MAX_ITEMS} artikelen.`, true); return; }
    state.chosen = items;
    const guessed = diffNames(items.map((item) => item.name));
    $('#mg-code').value = preset.code || commonCodePrefix(items.map((item) => item.code)) || '';
    $('#mg-name').value = preset.name || guessed.base || items[0].name;
    $('#mg-attribute').value = preset.attributeName || 'Maat';
    $('#mg-rows').innerHTML = items.map((item, index) => `<tr data-id="${esc(item.id)}">
        <td class="code">${esc(item.code)}</td><td class="wrap">${esc(item.name)}</td>
        <td><input class="mg-value" maxlength="40" aria-label="Waarde voor ${esc(item.code)}" value="${esc(preset.values ? preset.values[item.id] || '' : guessed.values[index])}"></td>
        <td class="num">${esc(context.nl(item.onHand))} ${esc(item.unit)}</td>
        <td class="num">${esc(context.eur(item.salePrice))}</td>
        <td>${item.shop.productId ? '<span class="pill">Koppeling vervalt</span>' : ''}</td></tr>`).join('');
    const linked = items.filter((item) => item.shop.productId).length;
    const first = items[0];
    const mixed = items.some((item) => item.unit !== first.unit || item.vatRate !== first.vatRate || item.revenueGroup !== first.revenueGroup);
    $('#mg-notes').innerHTML = `<li>${items.length} artikelen worden varianten van één nieuw hoofdartikel. Code, voorraad, prijzen, minimum, afbeelding, boekingen en reserveringen van elk artikel blijven zoals ze zijn; werkorders, offertes, facturen en bestellingen verwijzen nog naar dezelfde artikelcodes.</li>
      <li>Het hoofdartikel heeft zelf geen voorraad: het telt de varianten op. Het neemt eenheid, btw, omzetgroep en prijs van ${esc(first.code)} over.</li>
      ${linked ? `<li>${linked} artikel${linked === 1 ? ' is' : 'en zijn'} apart aan een webshopproduct gekoppeld. Die koppeling vervalt; zet daarna het hoofdartikel in de webshop (knop <i>In webshop zetten</i>) als één variabel product. Het oude webshopproduct blijft in de webshop staan tot je het daar weghaalt.</li>` : ''}
      ${mixed ? '<li class="bad">Deze artikelen hebben niet dezelfde eenheid, btw en omzetgroep. Pas die eerst aan, anders kunnen ze niet samen.</li>' : ''}`;
    $('#mg-submit').disabled = mixed;
    $('.err', $('#merge-form')).textContent = '';
    $('#mg-step1').hidden = true;
    $('#mg-step2').hidden = false;
  }

  /** Terug naar de keuze van de artikelen. */
  function showPick() {
    $('#mg-step1').hidden = false;
    $('#mg-step2').hidden = true;
    $('.err', $('#merge-form')).textContent = '';
  }

  /**
   * Voert het samenvoegen uit met wat in de controlestap staat.
   * @returns {Promise<void>}
   */
  async function submit() {
    const errorBox = $('.err', $('#merge-form'));
    const values = {};
    document.querySelectorAll('#mg-rows tr').forEach((row) => { values[row.dataset.id] = row.querySelector('.mg-value').value.trim(); });
    $('#mg-submit').disabled = true;
    try {
      const result = await context.api('stock/merge', { method: 'POST', body: {
        ids: state.chosen.map((item) => item.id), code: $('#mg-code').value, name: $('#mg-name').value, attributeName: $('#mg-attribute').value, values,
      } });
      $('#merge-form').hidden = true;
      context.toast(`${result.merged} artikelen samengevoegd tot ${result.item.code}`);
      await context.onMerged(result.item);
    } catch (error) {
      errorBox.textContent = error.message;
      $('#mg-submit').disabled = false;
    }
  }

  /** Opent het formulier op de eerste stap. */
  function open() {
    ['#new-form', '#import-form', '#units-form'].forEach((selector) => { if ($(selector)) $(selector).hidden = true; });
    $('#merge-form').hidden = false;
    $('#mg-search').value = '';
    showPick();
    renderManual();
    loadSuggestions();
    $('#merge-form').scrollIntoView();
  }

  /**
   * Koppelt de knop en het formulier.
   * @param {{ api: Function, toast: Function, getItems: Function, onMerged: Function, esc: Function, eur: Function, nl: Function }} options Hulpfuncties van de pagina; getItems geeft de artikellijst, onMerged wordt aangeroepen met het nieuwe hoofdartikel.
   */
  function setup(options) {
    Object.assign(context, options);
    $('#b-merge').onclick = open;
    document.querySelectorAll('#merge-form [data-cancel]').forEach((button) => {
      /** Sluit het formulier. */
      button.onclick = () => { $('#merge-form').hidden = true; };
    });
    $('#mg-search').oninput = renderManual;
    $('#mg-list').onchange = updateManualButton;
    /** Gaat met de aangevinkte artikelen naar de controle. */
    $('#mg-next').onclick = () => {
      const chosenIds = new Set([...document.querySelectorAll('#mg-list input:checked')].map((input) => input.value));
      showConfirm(looseItems().filter((item) => chosenIds.has(item.id)));
    };
    $('#mg-back').onclick = showPick;
    /**
     * Voert het samenvoegen uit.
     * @param {SubmitEvent} event het verzenden
     */
    $('#merge-form').onsubmit = (event) => { event.preventDefault(); if (!$('#mg-step2').hidden) submit(); };
  }

  window.ArtikelenMerge = { setup, diffNames, commonCodePrefix };
})();
