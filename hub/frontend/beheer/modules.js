// Beheer > Modules: elke niet-essentiële functie aan of uit, per categorie, met de onderdelen per module.
// De indeling komt uit het moduleregister (dashboard/modules.js, `switchTree`); de standen en wat in deze omgeving
// op slot staat komen van de server (GET|PUT /api/admin/modules, zie backend/src/platform/module-switches.js).
(function () {
  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  /** De standen zoals de server ze kent (id → false = uit), de keuzes op het scherm en wat op slot staat. */
  const state = { saved: {}, wanted: {}, locked: {}, filter: 'alles', search: '' };
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};
  /** Wordt na het opslaan aangeroepen met de nieuwe vlaggen (Beheer bouwt het menu opnieuw op). */
  let onSaved = () => {};

  /**
   * Roept de API van Beheer > Modules aan.
   * @param {object} [options] Methode en inhoud (`body` wordt JSON).
   * @returns {Promise<object>} Het antwoord; gooit een fout met de melding van de server.
   */
  async function api(options = {}) {
    const response = await fetch('../api/admin/modules', {
      cache: 'no-store',
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || window.AquatechCommon.statusMessage(response.status));
    return body;
  }

  /**
   * De indeling uit het moduleregister.
   * @returns {object[]} De categorieën met kaarten en onderdelen.
   */
  const tree = () => window.AquatechModuleTools.switchTree();

  /**
   * Staat een schakelaar op het scherm aan (de eigen keuze, los van de module waar hij bij hoort)?
   * @param {string} id Id van de kaart of het onderdeel.
   * @returns {boolean} true als hij aan staat.
   */
  const chosen = (id) => state.wanted[id] !== false;

  /**
   * Werkt de kaart: zelf aan, niet op slot en de module die hij nodig heeft staat aan.
   * @param {object} card De kaart uit de indeling.
   * @returns {boolean} true als de kaart aan staat.
   */
  const cardOn = (card) => chosen(card.id) && (!card.needs || chosen(card.needs));

  /**
   * De schakelaars die anders staan dan bij de server.
   * @returns {object} Id → gewenste stand, alleen voor gewijzigde schakelaars.
   */
  function changes() {
    const out = {};
    for (const id of window.AquatechModuleTools.switchIds()) if (chosen(id) !== (state.saved[id] !== false)) out[id] = chosen(id);
    return out;
  }

  /**
   * De HTML van één schakelaar (een echte checkbox, zodat toetsenbord en schermlezer werken).
   * @param {string} id Id van de kaart of het onderdeel.
   * @param {string} label Naam voor de schermlezer.
   * @param {boolean} checked Aan of uit.
   * @param {boolean} disabled Niet te bedienen.
   * @param {boolean} small Kleine uitvoering (onderdeel).
   * @returns {string} De HTML.
   */
  function switchHtml(id, label, checked, disabled, small) {
    return `<label class="md-switch${small ? ' small' : ''}"><input type="checkbox" role="switch" data-switch="${esc(id)}" aria-label="${esc(label)}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span aria-hidden="true"></span></label>`;
  }

  /**
   * De HTML van één kaart met haar onderdelen.
   * @param {object} card De kaart uit de indeling.
   * @returns {string} De HTML.
   */
  function cardHtml(card) {
    const Tools = window.AquatechModuleTools;
    const on = cardOn(card);
    const missing = card.needs && !chosen(card.needs);
    const tags = `${card.needs ? `<span class="md-tag needs">Nodig: ${esc(Tools.titleOf(card.needs))}</span>` : ''}${state.locked[card.id] ? `<span class="md-tag locked">${esc(state.locked[card.id])}</span>` : ''}`;
    const parts = card.parts.map((part) => {
      const entry = Tools.entryOf(part.id) || {};
      const link = entry.section && on && chosen(part.id) ? `<a class="md-link" href="#${esc(entry.section)}">Instellen</a>` : '';
      return `<div class="md-part"><span>${esc(part.title)}${state.locked[part.id] && !state.locked[card.id] ? `<span class="md-tag locked">${esc(state.locked[part.id])}</span>` : ''}</span>${link}
        ${switchHtml(part.id, `${card.title}: ${part.title}`, on && chosen(part.id), !on || Boolean(state.locked[part.id]), true)}</div>`;
    }).join('');
    const own = Tools.entryOf(card.id) || {};
    const cardLink = own.section && on ? `<a class="md-link" href="#${esc(own.section)}">Instellen</a>` : '';
    return `<article class="md-card${on ? '' : ' off'}" data-card="${esc(card.id)}">
      <div class="md-head"><h4>${esc(card.title)}</h4>${switchHtml(card.id, card.title, on, Boolean(state.locked[card.id]) || Boolean(missing), false)}<p>${esc(card.summary)} ${cardLink}</p>${tags ? `<div class="md-tags">${tags}</div>` : ''}</div>
      ${parts ? `<div class="md-parts">${parts}</div>` : ''}
    </article>`;
  }

  /**
   * Past de kaart bij het zoekwoord en het filter Alles/Aan/Uit?
   * @param {object} card De kaart uit de indeling.
   * @returns {boolean} true als de kaart getoond wordt.
   */
  function matches(card) {
    const text = `${card.title} ${card.summary} ${card.parts.map((part) => part.title).join(' ')}`.toLowerCase();
    if (state.search && !text.includes(state.search)) return false;
    const on = cardOn(card);
    if (state.filter === 'aan') return on;
    if (state.filter === 'uit') return !on || card.parts.some((part) => !chosen(part.id));
    return true;
  }

  /**
   * Tekent de categorieën, de teller en de knoppen opnieuw.
   * @returns {void}
   */
  function render() {
    let total = 0;
    let active = 0;
    for (const category of tree()) {
      for (const card of category.cards) {
        const on = cardOn(card);
        total += 1 + card.parts.length;
        active += (on ? 1 : 0) + (on ? card.parts.filter((part) => chosen(part.id)).length : 0);
      }
    }
    const shown = tree().map((category) => ({ ...category, shown: category.cards.filter(matches) })).filter((category) => category.shown.length);
    $('#md-categories').innerHTML = shown.map((category) => {
      const onCount = category.cards.filter(cardOn).length;
      const free = category.cards.filter((card) => !state.locked[card.id]);
      const anyOn = free.some((card) => chosen(card.id));
      return `<section class="md-category" id="md-${esc(category.key)}">
        <div class="md-category-head"><h3>${esc(category.title)}</h3><span class="muted small">${onCount} van ${category.cards.length} aan</span><span class="md-rule"></span>
          ${free.length ? `<button type="button" class="md-all" data-all="${esc(category.key)}" data-to="${anyOn ? 'uit' : 'aan'}">Alles ${anyOn ? 'uit' : 'aan'}</button>` : ''}</div>
        <div class="md-grid">${category.shown.map(cardHtml).join('')}</div>
      </section>`;
    }).join('');
    $('#md-none').hidden = shown.length > 0;
    $('#md-count').innerHTML = `<b>${active}</b> van ${total} aan`;
    $('#md-jump').innerHTML = tree().map((category) => `<a href="#md-${esc(category.key)}" data-jump="${esc(category.key)}">${esc(category.title)} <i>${category.cards.length}</i></a>`).join('');
    const dirty = Object.keys(changes()).length;
    $('#md-save').disabled = !dirty;
    $('#md-dirty').textContent = dirty ? `${dirty} ${dirty === 1 ? 'wijziging' : 'wijzigingen'} nog niet opgeslagen` : '';
    document.querySelectorAll('#md-filter [data-filter]').forEach((button) => {
      button.classList.toggle('active', button.dataset.filter === state.filter);
      button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
    });
  }

  /**
   * Neemt de standen van de server over als uitgangspunt.
   * @param {{ flags: object, locked: object }} view Het antwoord van de server.
   * @returns {void}
   */
  function adopt(view) {
    state.saved = view.flags || {};
    state.locked = view.locked || {};
    state.wanted = { ...state.saved };
  }

  /**
   * Laadt de standen en tekent het scherm.
   * @returns {Promise<void>}
   */
  async function load() {
    $('#md-err').textContent = '';
    $('#md-always').innerHTML = window.AquatechModuleTools.ALWAYS_ON.map((name) => `<li>${esc(name)}</li>`).join('');
    try {
      adopt(await api());
      render();
    } catch (error) {
      $('#md-err').textContent = error.message;
    }
  }

  /**
   * Slaat de gewijzigde schakelaars op.
   * @returns {Promise<void>}
   */
  async function save() {
    const flags = changes();
    if (!Object.keys(flags).length) return;
    $('#md-err').textContent = '';
    $('#md-save').disabled = true;
    try {
      const view = await api({ method: 'PUT', body: { flags } });
      adopt(view);
      render();
      toast('Modules opgeslagen');
      onSaved(view.flags);
    } catch (error) {
      $('#md-err').textContent = error.message;
      render();
    }
  }

  /**
   * Koppelt de knoppen en velden van het scherm.
   * @param {{ toast: Function, onSaved: Function }} options toast = functie voor meldingen, onSaved = na het opslaan (met de nieuwe vlaggen).
   * @returns {void}
   */
  function init(options) {
    toast = options.toast;
    onSaved = options.onSaved || onSaved;
    const pane = $('#tab-modules');
    /**
     * Een schakelaar is omgezet: de keuze onthouden en opnieuw tekenen (onderdelen volgen hun module).
     * @param {Event} event De wijziging.
     */
    pane.onchange = (event) => {
      const input = event.target.closest('[data-switch]');
      if (!input) return;
      state.wanted[input.dataset.switch] = input.checked;
      render();
      const again = pane.querySelector(`[data-switch="${input.dataset.switch}"]`);
      if (again) again.focus();
    };
    /**
     * Klikken op het filter, op Alles aan/uit van een categorie of op een categorie in de snelkeuze.
     * @param {MouseEvent} event De klik.
     */
    pane.onclick = (event) => {
      const filter = event.target.closest('[data-filter]');
      if (filter) { state.filter = filter.dataset.filter; render(); return; }
      const all = event.target.closest('[data-all]');
      if (all) {
        const category = tree().find((candidate) => candidate.key === all.dataset.all);
        for (const card of category.cards) if (!state.locked[card.id]) state.wanted[card.id] = all.dataset.to === 'aan';
        render();
        return;
      }
      const jump = event.target.closest('[data-jump]');
      if (jump) {
        event.preventDefault();
        const target = document.getElementById(`md-${jump.dataset.jump}`);
        if (target) target.scrollIntoView({ block: 'start' });
      }
    };
    /** Zoekt terwijl de gebruiker typt. */
    $('#md-search').oninput = () => { state.search = $('#md-search').value.trim().toLowerCase(); render(); };
    /** Slaat de wijzigingen op. */
    $('#md-save').onclick = () => { save(); };
  }

  window.BeheerModules = { init, load };
})();
