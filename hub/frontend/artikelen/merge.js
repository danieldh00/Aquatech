// Artikelen samenvoegen (module Artikelen): losse artikelen die eigenlijk maten of
// kleuren van één product zijn, omzetten naar één artikelgroep. Stap 1: kies een
// voorstel van het systeem of kies zelf artikelen. Stap 2: controleer code, omschrijving
// en de waarde per artikel; daar staat ook wat er verandert en wat gelijk blijft.
// Praat met /api/stock/merge-suggestions en /api/stock/merge (recht 'voorraad').
(function () {
  /** Hoogstens zoveel artikelen per keer (gelijk aan de grens op de server). */
  const MAX_ITEMS = 30;
  const context = { api: null, toast: null, getItems: null, onMerged: null, onMergedAll: null, esc: null, eur: null, nl: null };
  /** shop: wat het samenvoegen met de webshop doet (publishes = Aquatech zet de artikelgroep zelf in de webshop; blocked = de webshop bepaalt de lijst maar schrijven staat uit). */
  const state = { groups: [], chosen: [], shop: { publishes: false, blocked: false }, running: false };

  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector) => document.querySelector(selector);

  /**
   * De losse artikelen waaruit gekozen kan worden: niet gearchiveerd en geen artikelgroep of subartikel.
   * @returns {object[]} De artikelen, op code.
   */
  function looseItems() {
    return context.getItems().filter((item) => !item.archived && !item.isGroup && !item.groupId);
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

  /**
   * De uitleg over de webshop bij het samenvoegen van artikelen die aan een webshopproduct hangen.
   * @param {number} linked Aantal artikelen (of groepen) dat aan een webshopproduct gekoppeld is.
   * @param {{ publishes: boolean, blocked: boolean }} shop Wat de webshopkoppeling toestaat.
   * @returns {string} Een lijstitem (HTML), leeg als er niets gekoppeld is.
   */
  function webshopNote(linked, shop) {
    if (!linked) return '';
    if (shop.publishes) return `<li>${linked} gekoppeld${linked === 1 ? '' : 'e'} webshopproduct${linked === 1 ? '' : 'en'}: Aquatech zet de artikelgroep zelf als één variabel product in de webshop (met een variatie per maat) en zet de oude losse producten op concept. Ze worden niet verwijderd en zijn in de webshop terug te zetten. Lukt het niet in de webshop, dan wordt er niets samengevoegd.</li>`;
    if (shop.blocked) return `<li class="bad">De webshop bepaalt de artikellijst en Aquatech mag niet naar de webshop schrijven. Zet in Beheer → Integraties → Webshop de REST API aan met "Aquatech is de bron"; daarna kun je deze artikelen samenvoegen.</li>`;
    return `<li>${linked} gekoppeld${linked === 1 ? '' : 'e'} webshopproduct${linked === 1 ? '' : 'en'}: de koppeling vervalt. Zet daarna de artikelgroep in de webshop (knop <i>In webshop zetten</i>) als één variabel product; de oude producten blijven in de webshop staan tot je ze daar weghaalt.</li>`;
  }

  /**
   * De uitleg over de webshop bij Alles samenvoegen.
   * @param {number} linkedGroups Aantal voorstellen met aan een webshopproduct gekoppelde artikelen die nu kunnen.
   * @param {number} blockedGroups Aantal voorstellen met gekoppelde artikelen dat niet kan omdat Aquatech niet naar de webshop mag schrijven.
   * @returns {string} Lijstitems (HTML), leeg als er niets met de webshop gebeurt.
   */
  function bulkWebshopNote(linkedGroups, blockedGroups) {
    const parts = [];
    if (linkedGroups) {
      parts.push(state.shop.publishes
        ? `<li>${linkedGroups} ${linkedGroups === 1 ? 'groep heeft' : 'groepen hebben'} artikelen met een webshopproduct: Aquatech zet daarvan de artikelgroep zelf als één variabel product in de webshop en zet de oude losse producten op concept (niet verwijderd, in de webshop terug te zetten). Lukt het in de webshop niet, dan wordt die groep niet samengevoegd.</li>`
        : `<li>${linkedGroups} ${linkedGroups === 1 ? 'groep heeft' : 'groepen hebben'} artikelen met een webshopproduct: die koppeling vervalt. Zet daarna de artikelgroep in de webshop (knop <i>In webshop zetten</i>); de oude producten blijven daar staan tot je ze weghaalt.</li>`);
    }
    if (blockedGroups) parts.push(`<li class="bad">${blockedGroups} ${blockedGroups === 1 ? 'groep kan' : 'groepen kunnen'} niet: de webshop bepaalt de artikellijst en Aquatech mag niet naar de webshop schrijven. Zet in Beheer → Integraties → Webshop de REST API aan met "Aquatech is de bron".</li>`);
    return parts.join('');
  }

  /** Leest de voorstellen van de server en tekent ze. */
  async function loadSuggestions() {
    $('#mg-groups').innerHTML = '<p class="muted small">Voorstellen zoeken…</p>';
    try {
      const reply = await context.api('stock/merge-suggestions');
      state.groups = reply.groups;
      state.shop = reply.shop || { publishes: false, blocked: false };
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
    $('#mg-all-bar').hidden = state.groups.length < 1;
    $('#mg-all').textContent = `Alles samenvoegen (${state.groups.length} ${state.groups.length === 1 ? 'voorstel' : 'voorstellen'})…`;
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
        <td>${item.shop.productId ? `<span class="pill">${state.shop.publishes ? 'Wordt één product' : 'Koppeling vervalt'}</span>` : ''}</td></tr>`).join('');
    const linked = items.filter((item) => item.shop.productId).length;
    // Zelfde keuze als de server: het artikel met de laagste code levert eenheid, btw, omzetgroep en prijs.
    const first = [...items].sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))[0];
    const mixed = items.some((item) => item.unit !== first.unit || item.vatRate !== first.vatRate || item.revenueGroup !== first.revenueGroup);
    $('#mg-notes').innerHTML = `<li>${items.length} artikelen worden subartikelen van één nieuw artikelgroep. Code, voorraad, prijzen, minimum, afbeelding, boekingen en reserveringen van elk artikel blijven zoals ze zijn; werkorders, offertes, facturen en bestellingen verwijzen nog naar dezelfde artikelcodes.</li>
      <li>De artikelgroep heeft zelf geen voorraad: het telt de subartikelen op. Het neemt eenheid, btw, omzetgroep en prijs van ${esc(first.code)} over.</li>
      ${webshopNote(linked, state.shop)}
      ${mixed ? '<li class="bad">Deze artikelen hebben niet dezelfde eenheid, btw en omzetgroep. Pas die eerst aan, anders kunnen ze niet samen.</li>' : ''}`;
    $('#mg-submit').disabled = mixed || (linked > 0 && state.shop.blocked);
    $('#merge-form > .err').textContent = '';
    $('#mg-step1').hidden = true;
    $('#mg-step2').hidden = false;
    $('#mg-step3').hidden = true;
  }

  /** Terug naar de keuze van de artikelen. */
  function showPick() {
    $('#mg-step1').hidden = false;
    $('#mg-step2').hidden = true;
    $('#mg-step3').hidden = true;
    $('#merge-form > .err').textContent = '';
  }

  /**
   * Voert het samenvoegen uit met wat in de controlestap staat.
   * @returns {Promise<void>}
   */
  async function submit() {
    const errorBox = $('#merge-form > .err');
    const values = {};
    document.querySelectorAll('#mg-rows tr').forEach((row) => { values[row.dataset.id] = row.querySelector('.mg-value').value.trim(); });
    $('#mg-submit').disabled = true;
    try {
      const result = await context.api('stock/merge', { method: 'POST', body: {
        ids: state.chosen.map((item) => item.id), code: $('#mg-code').value, name: $('#mg-name').value, attributeName: $('#mg-attribute').value, values,
      } });
      $('#merge-form').hidden = true;
      context.toast(`${result.merged} artikelen samengevoegd tot ${result.item.code}${result.shop ? `; in de webshop: ${result.shop.hidden} oude ${result.shop.hidden === 1 ? 'product' : 'producten'} op concept` : ''}`);
      if (result.shop && result.shop.warning) context.toast(result.shop.warning, true);
      await context.onMerged(result.item);
    } catch (error) {
      errorBox.textContent = error.message;
      $('#mg-submit').disabled = false;
    }
  }

  /**
   * De voorstellen die in Alles samenvoegen kunnen: alle artikelen zijn nog los aanwezig en het aantal past.
   * @returns {{ group: object, items: object[], linked: number, tooBig: boolean }[]} Per voorstel de artikelen uit de lijst.
   */
  function mergeableGroups() {
    const byId = new Map(looseItems().map((item) => [item.id, item]));
    return state.groups.map((group) => {
      const items = group.items.map((entry) => byId.get(entry.id)).filter(Boolean);
      return { group, items, linked: items.filter((item) => item.shop.productId).length, tooBig: group.items.length > MAX_ITEMS };
    }).filter((entry) => entry.items.length === entry.group.items.length);
  }

  /** Toont het overzicht ter bevestiging van alle voorstellen (stap 3). */
  function showAll() {
    const esc = context.esc;
    const groups = mergeableGroups();
    state.running = false;
    $('#mga-intro').textContent = `${groups.length} ${groups.length === 1 ? 'voorstel' : 'voorstellen'}. Vink af wat je niet wilt samenvoegen; de code kun je hier aanpassen. Elk voorstel wordt apart uitgevoerd: lukt er één niet, dan gaan de andere gewoon door.`;
    $('#mga-rows').innerHTML = groups.map((entry, index) => {
      const blocked = entry.tooBig || (entry.linked > 0 && state.shop.blocked);
      const webshop = !entry.linked ? '' : blocked ? 'Kan niet (zie hieronder)' : state.shop.publishes ? `${entry.linked} oud ${entry.linked === 1 ? 'product' : 'producten'} → één variabel product` : `${entry.linked} ${entry.linked === 1 ? 'koppeling vervalt' : 'koppelingen vervallen'}`;
      return `<tr data-index="${index}">
        <td><input type="checkbox" class="mga-pick" aria-label="Voeg ${esc(entry.group.name)} samen"${blocked ? ' disabled' : ' checked'}></td>
        <td class="wrap"><b>${esc(entry.group.name)}</b> <span class="pill">${entry.items.length} artikelen</span>
          <span class="sub">${esc(entry.group.items.map((member) => member.code).join(', '))}</span></td>
        <td><input class="mga-code" maxlength="40" aria-label="Code voor ${esc(entry.group.name)}" value="${esc(entry.group.code)}"></td>
        <td class="wrap">${esc(entry.group.attributeName)}: ${esc(entry.group.items.map((member) => member.value).join(' · '))}</td>
        <td class="wrap">${esc(webshop)}</td>
        <td class="wrap mga-status"></td></tr>`;
    }).join('');
    const total = groups.filter((entry) => !entry.tooBig && !(entry.linked > 0 && state.shop.blocked));
    const linkedGroups = total.filter((entry) => entry.linked > 0).length;
    $('#mga-notes').innerHTML = `<li>${total.reduce((sum, entry) => sum + entry.items.length, 0)} artikelen in ${total.length} groepen worden subartikelen van een nieuw artikelgroep. Code, voorraad, prijzen, minimum, afbeelding, boekingen en reserveringen van elk artikel blijven zoals ze zijn; werkorders, offertes, facturen en bestellingen verwijzen nog naar dezelfde artikelcodes.</li>
      ${bulkWebshopNote(linkedGroups, groups.filter((entry) => entry.linked > 0 && state.shop.blocked).length)}
      ${groups.some((entry) => entry.tooBig) ? `<li class="bad">Een voorstel met meer dan ${MAX_ITEMS} artikelen kan niet in één keer; kies die artikelen zelf in twee delen.</li>` : ''}
      ${state.shop.publishes && linkedGroups ? '<li>Per groep met webshopproducten duurt het enkele seconden; blijf op deze pagina tot alles klaar is.</li>' : ''}`;
    $('#mga-toggle').checked = true;
    $('#mga-submit').hidden = false;
    $('#mga-submit').disabled = !total.length;
    $('#mga-back').hidden = false;
    $('#mga-cancel').textContent = 'Annuleren';
    $('#merge-form > .err').textContent = '';
    $('#mg-step1').hidden = true;
    $('#mg-step2').hidden = true;
    $('#mg-step3').hidden = false;
    state.allGroups = groups;
  }

  /**
   * Voert alle aangevinkte voorstellen één voor één uit en toont per voorstel de uitkomst.
   * Een voorstel dat mislukt (bijv. een code die al bestaat) stopt de rest niet.
   * @returns {Promise<void>}
   */
  async function submitAll() {
    if (state.running) return;
    const rows = [...document.querySelectorAll('#mga-rows tr')].filter((row) => row.querySelector('.mga-pick').checked);
    if (!rows.length) { context.toast('Vink minstens één voorstel aan.', true); return; }
    state.running = true;
    $('#mga-submit').disabled = true;
    $('#mga-back').hidden = true;
    document.querySelectorAll('#mga-rows input').forEach((input) => { input.disabled = true; });
    $('#mga-toggle').disabled = true;
    let done = 0;
    let failed = 0;
    for (const row of rows) {
      const entry = state.allGroups[Number(row.dataset.index)];
      const status = row.querySelector('.mga-status');
      status.className = 'wrap mga-status';
      status.textContent = 'Bezig…';
      try {
        const result = await context.api('stock/merge', { method: 'POST', body: {
          ids: entry.items.map((item) => item.id), code: row.querySelector('.mga-code').value, name: entry.group.name,
          attributeName: entry.group.attributeName, values: Object.fromEntries(entry.group.items.map((member) => [member.id, member.value])),
        } });
        done++;
        status.className = 'wrap mga-status ok';
        status.textContent = `Samengevoegd tot ${result.item.code}${result.shop && result.shop.warning ? `. Let op: ${result.shop.warning}` : ''}`;
      } catch (error) {
        failed++;
        status.className = 'wrap mga-status bad';
        status.textContent = error.message;
      }
    }
    state.running = false;
    $('#mga-submit').hidden = true;
    $('#mga-cancel').textContent = 'Sluiten';
    context.toast(`${done} ${done === 1 ? 'voorstel' : 'voorstellen'} samengevoegd${failed ? `, ${failed} niet gelukt (zie het overzicht)` : ''}`, failed > 0 && done === 0);
    if (context.onMergedAll) await context.onMergedAll();
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
   * @param {{ api: Function, toast: Function, getItems: Function, onMerged: Function, esc: Function, eur: Function, nl: Function }} options Hulpfuncties van de pagina; getItems geeft de artikellijst, onMerged wordt aangeroepen met de nieuwe artikelgroep.
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
    $('#mg-all').onclick = showAll;
    $('#mga-back').onclick = showPick;
    $('#mga-submit').onclick = submitAll;
    /** Zet alle voorstellen die kunnen aan of uit. */
    $('#mga-toggle').onchange = () => {
      document.querySelectorAll('#mga-rows .mga-pick:not(:disabled)').forEach((box) => { box.checked = $('#mga-toggle').checked; });
    };
    /**
     * Voert het samenvoegen uit.
     * @param {SubmitEvent} event het verzenden
     */
    $('#merge-form').onsubmit = (event) => { event.preventDefault(); if (!$('#mg-step2').hidden) submit(); else if (!$('#mg-step3').hidden) submitAll(); };
  }

  window.ArtikelenMerge = { setup, diffNames, commonCodePrefix };
})();
