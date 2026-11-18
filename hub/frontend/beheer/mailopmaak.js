// Beheer > Mail-opmaak: logo, kop, kleuren en voet van de e-mails van deze organisatie en per mailtype een eigen
// onderwerp en tekst met invulvelden (API /api/admin/mail-layout), met een voorbeeld dat de server maakt en een
// testmail naar jezelf. Er wordt niets opgeslagen voordat je op Opslaan klikt.
(function () {
  const Theme = window.AquatechTheme;
  const state = { data: null, built: false, logo: '', templates: {}, typeKey: '', previewRun: 0, previewTimer: null };
  /** Het logo mag hoogstens zo breed en zo hoog zijn (pixels) voordat het wordt opgeslagen. */
  const LOGO_MAX = { width: 900, height: 300 };
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};

  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);

  /**
   * Roept de API van de mailopmaak aan.
   * @param {string} [suffix] Vervolg van het adres (bijv. '/preview').
   * @param {object} [options] Methode en inhoud (`body` wordt JSON).
   * @returns {Promise<object>} Het antwoord; gooit een fout met de melding van de server.
   */
  async function api(suffix = '', options = {}) {
    const res = await fetch(`../api/admin/mail-layout${suffix}`, {
      cache: 'no-store',
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || AquatechCommon.statusMessage(res.status));
    }
    return res.json();
  }

  /**
   * Het mailtype dat nu in de teksteditor staat.
   * @returns {object} Het type uit de lijst van de server.
   */
  const currentType = () => state.data.types.find((type) => type.key === state.typeKey) || state.data.types[0];

  /**
   * Leest de opmaak uit het formulier.
   * @returns {object} De opmaak zoals de server hem verwacht.
   */
  function currentLayout() {
    const form = $('#ml-form');
    /**
     * De kleur uit een tekstveld.
     * @param {string} key Veldnaam (headerColor, buttonColor of accentColor).
     * @returns {string} De kleur als #rrggbb, of leeg.
     */
    const hexOf = (key) => Theme.hex(form.querySelector(`[data-hex="${key}"]`).value) || '';
    return {
      logoMode: form.logoMode.value,
      logo: state.logo,
      logoPosition: form.logoPosition.value,
      logoHeight: Number(form.logoHeight.value),
      headerStyle: form.headerStyle.value,
      headerColor: hexOf('headerColor'),
      buttonColor: hexOf('buttonColor'),
      accentColor: hexOf('accentColor'),
      showCompanyInFooter: form.showCompanyInFooter.checked,
      footerText: form.footerText.value,
      templates: state.templates,
    };
  }

  /**
   * Controleert wat het formulier zelf kan controleren (kleuren, logo gekozen, verplichte velden in de tekst).
   * @returns {string} De eerste fout, of een lege tekst.
   */
  function problem() {
    const form = $('#ml-form');
    for (const [key, label] of [['headerColor', 'Kopkleur'], ['buttonColor', 'Knopkleur'], ['accentColor', 'Accentkleur']]) {
      const typed = form.querySelector(`[data-hex="${key}"]`).value.trim();
      if (!typed) continue;
      const hex = Theme.hex(typed);
      if (!hex) return `${label}: geef een kleur als #rrggbb, of laat het veld leeg.`;
      if (key !== 'accentColor' && Theme.contrast(hex, '#ffffff') < (key === 'buttonColor' ? 3 : 4.5)) return `${label} is te licht: witte tekst moet er goed op leesbaar blijven.`;
    }
    if (form.logoMode.value === 'custom' && !state.logo) return 'Kies een logo, of kies het logo van de documentopmaak.';
    const type = currentType();
    const body = $('#ml-body').value;
    const missing = type.required.filter((name) => !body.includes(`{${name}}`));
    if (missing.length) return `De tekst van "${type.label}" moet ${missing.map((name) => `{${name}}`).join(', ')} bevatten, anders kan de klant niets met de mail.`;
    return '';
  }

  /** Toont of verbergt wat bij de gekozen waarden hoort en zet de foutmelding en de knoppen goed. */
  function syncControls() {
    const form = $('#ml-form');
    const mode = form.logoMode.value;
    $('#ml-logo-field').hidden = mode !== 'custom';
    form.logoHeight.disabled = mode === 'none';
    $('#ml-logo-height-text').textContent = `${form.logoHeight.value} pixels hoog`;
    $('#ml-logo-img').hidden = !state.logo;
    $('#ml-logo-none').hidden = Boolean(state.logo);
    if (state.logo) $('#ml-logo-img').src = state.logo;
    $('#ml-logo-box').style.background = form.headerStyle.value === 'band' ? (Theme.hex(form.querySelector('[data-hex="headerColor"]').value) || 'var(--at-navy)') : '#ffffff';
    const message = problem();
    $('#ml-err').textContent = message;
    $('#ml-save').disabled = Boolean(message);
    $('#ml-test').disabled = Boolean(message);
  }

  /** Vult de teksteditor met het gekozen mailtype (eigen tekst, anders de standaard) en de beschikbare velden. */
  function fillTemplate() {
    const type = currentType();
    const override = state.templates[type.key] || {};
    $('#ml-subject').value = override.subject || type.subject;
    $('#ml-body').value = override.body || type.body;
    $('#ml-note').textContent = type.note;
    $('#ml-note').hidden = !type.note;
    const chips = $('#ml-fields');
    chips.textContent = '';
    for (const field of type.fields) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'btn small';
      chip.textContent = `{${field.name}}`;
      chip.title = `${field.hint}${type.required.includes(field.name) ? ' (verplicht)' : ''}`;
      chip.dataset.field = field.name;
      chips.appendChild(chip);
    }
    $('#ml-type-state').textContent = state.templates[type.key] ? 'Eigen tekst' : 'Standaardtekst';
  }

  /** Bewaart de tekst uit de editor als eigen tekst, of haalt hem weg als hij gelijk is aan de standaard. */
  function storeTemplate() {
    const type = currentType();
    const override = {};
    if ($('#ml-subject').value.trim() && $('#ml-subject').value.trim() !== type.subject) override.subject = $('#ml-subject').value;
    if ($('#ml-body').value.trim() && $('#ml-body').value.trim() !== type.body) override.body = $('#ml-body').value;
    if (Object.keys(override).length) state.templates[type.key] = override;
    else delete state.templates[type.key];
    $('#ml-type-state').textContent = state.templates[type.key] ? 'Eigen tekst' : 'Standaardtekst';
  }

  /** Vult het formulier met de opmaak van deze organisatie. */
  function fill() {
    const { layout, effective } = state.data;
    const form = $('#ml-form');
    state.logo = layout.logo;
    state.templates = JSON.parse(JSON.stringify(layout.templates));
    form.logoMode.value = layout.logoMode;
    form.logoPosition.value = layout.logoPosition;
    form.logoHeight.value = layout.logoHeight;
    form.headerStyle.value = layout.headerStyle;
    form.showCompanyInFooter.checked = layout.showCompanyInFooter;
    form.footerText.value = layout.footerText;
    const fallbacks = { headerColor: effective.headerColor, buttonColor: effective.buttonColor, accentColor: effective.accentColor };
    for (const key of Object.keys(fallbacks)) {
      form.querySelector(`[data-hex="${key}"]`).value = layout[key];
      form.querySelector(`[data-color="${key}"]`).value = layout[key] || fallbacks[key];
    }
    if (!state.typeKey) state.typeKey = state.data.types[0].key;
    const select = $('#ml-type');
    if (!select.options.length) {
      const groups = new Map();
      for (const type of state.data.types) {
        if (!groups.has(type.group)) {
          const group = document.createElement('optgroup');
          group.label = type.group;
          select.appendChild(group);
          groups.set(type.group, group);
        }
        const option = document.createElement('option');
        option.value = type.key;
        option.textContent = type.label;
        groups.get(type.group).appendChild(option);
      }
    }
    select.value = state.typeKey;
    fillTemplate();
    syncControls();
    renderPreview();
  }

  /** Vraagt de server om het voorbeeld van het gekozen mailtype met de opmaak uit het formulier. */
  async function renderPreview() {
    const run = ++state.previewRun;
    const note = $('#ml-preview-note');
    if (problem()) { note.textContent = 'Los eerst de melding bij het formulier op.'; return; }
    try {
      const result = await api('/preview', { method: 'POST', body: { layout: currentLayout(), type: state.typeKey } });
      if (run !== state.previewRun) return;
      $('#ml-preview-subject').textContent = result.subject;
      $('#ml-frame').srcdoc = result.html;
      note.textContent = 'Het voorbeeld gebruikt voorbeeldgegevens; er wordt niets opgeslagen of verstuurd.';
    } catch (error) {
      if (run === state.previewRun) note.textContent = `Voorbeeld mislukt: ${error.message}`;
    }
  }

  /** Vernieuwt het voorbeeld kort na de laatste wijziging, zodat typen niet elke toets een verzoek kost. */
  function schedulePreview() {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(renderPreview, 350);
  }

  /**
   * Maakt van een gekozen afbeelding een PNG (hoogstens 900 × 300 pixels, transparantie blijft) en onthoudt die als logo.
   * @param {File} file Het gekozen bestand.
   * @returns {Promise<void>}
   */
  async function chooseLogo(file) {
    const maxBytes = 300 * 1024;
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      let factor = Math.min(1, LOGO_MAX.width / image.naturalWidth, LOGO_MAX.height / image.naturalHeight);
      for (let attempt = 0; attempt < 5; attempt++) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((image.naturalWidth || LOGO_MAX.width) * factor));
        canvas.height = Math.max(1, Math.round((image.naturalHeight || LOGO_MAX.height) * factor));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png');
        if ((dataUrl.length - 22) * 0.75 <= maxBytes) {
          state.logo = dataUrl;
          $('#ml-form').logoMode.value = 'custom';
          syncControls();
          renderPreview();
          return;
        }
        factor *= 0.7;
      }
      throw new Error('Dit logo blijft te groot. Kies een eenvoudiger afbeelding.');
    } catch (error) {
      toast(error.name === 'EncodingError' ? 'Deze afbeelding kan niet worden gelezen.' : error.message, true);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Slaat de opmaak op (met `layout` = null: alles terugzetten naar de standaard).
   * @param {object|null} layout De opmaak, of null.
   * @returns {Promise<void>}
   */
  async function save(layout) {
    try {
      state.data = await api('', { method: 'PUT', body: { layout: layout || state.data.defaults } });
      fill();
      toast(layout ? 'Mail-opmaak opgeslagen' : 'Standaardopmaak teruggezet');
    } catch (error) { $('#ml-err').textContent = error.message; }
  }

  /** Stuurt een testmail met de opmaak uit het formulier naar het adres van de ingelogde beheerder. */
  async function sendTest() {
    $('#ml-test').disabled = true;
    try {
      const result = await api('/test', { method: 'POST', body: { layout: currentLayout(), type: state.typeKey } });
      toast(`Testmail verstuurd naar ${result.to}`);
    } catch (error) { toast(error.message, true); } finally { syncControls(); }
  }

  /** Bouwt de koppelingen van het formulier één keer. */
  function build() {
    if (state.built) return;
    state.built = true;
    const form = $('#ml-form');
    /**
     * Houdt kleurkiezer en tekstveld gelijk en vernieuwt het voorbeeld.
     * @param {InputEvent} event De invoer.
     */
    form.oninput = (event) => {
      const key = event.target.dataset.color || event.target.dataset.hex;
      if (event.target.dataset.color) form.querySelector(`[data-hex="${key}"]`).value = event.target.value;
      else if (key && Theme.hex(event.target.value)) form.querySelector(`[data-color="${key}"]`).value = Theme.hex(event.target.value);
      if (event.target.id === 'ml-subject' || event.target.id === 'ml-body') storeTemplate();
      syncControls();
      schedulePreview();
    };
    /**
     * Werkt de keuzes bij (ook het gekozen mailtype) en vernieuwt het voorbeeld.
     * @param {Event} event De wijziging.
     */
    form.onchange = (event) => {
      if (event.target.id === 'ml-type') { state.typeKey = event.target.value; fillTemplate(); }
      syncControls();
      schedulePreview();
    };
    /**
     * Zet een invulveld op de plek van de cursor in de tekst.
     * @param {MouseEvent} event De klik.
     */
    $('#ml-fields').onclick = (event) => {
      const chip = event.target.closest('[data-field]');
      if (!chip) return;
      const body = $('#ml-body');
      const text = `{${chip.dataset.field}}`;
      body.setRangeText(text, body.selectionStart, body.selectionEnd, 'end');
      body.focus();
      storeTemplate();
      syncControls();
      schedulePreview();
    };
    /** Zet de tekst van dit mailtype terug naar de standaard. */
    $('#ml-type-reset').onclick = () => {
      delete state.templates[state.typeKey];
      fillTemplate();
      syncControls();
      schedulePreview();
    };
    /** Opent de bestandskiezer voor het logo. */
    $('#ml-logo-pick').onclick = () => { $('#ml-logo-file').click(); };
    /**
     * Verwerkt het gekozen logobestand.
     * @param {Event} event De keuze.
     */
    $('#ml-logo-file').onchange = (event) => {
      const [file] = event.target.files;
      event.target.value = '';
      if (file) chooseLogo(file);
    };
    /**
     * Slaat de opmaak op als het formulier klopt.
     * @param {SubmitEvent} event Het verzenden.
     */
    form.onsubmit = (event) => { event.preventDefault(); if (!problem()) save(currentLayout()); };
    /** Zet alles terug naar de standaard (opmaak en alle eigen teksten). */
    $('#ml-reset').onclick = () => { save(null); };
    /** Stuurt de testmail. */
    $('#ml-test').onclick = sendTest;
    for (const button of document.querySelectorAll('.ml-widths [data-width]')) {
      /** Wisselt het voorbeeld tussen de breedte van een computer en van een telefoon. */
      button.onclick = () => {
        $('#ml-frame').style.maxWidth = button.dataset.width;
        for (const other of document.querySelectorAll('.ml-widths [data-width]')) other.setAttribute('aria-pressed', String(other === button));
      };
    }
  }

  /**
   * Laadt de opmaak van deze organisatie en toont het formulier.
   * @returns {Promise<void>}
   */
  async function load() {
    build();
    try {
      state.data = await api();
      fill();
    } catch (error) { toast(error.message, true); }
  }

  /**
   * Koppelt de meldingen van Beheer.
   * @param {{ toast: function(string, boolean): void }} options De meldingsfunctie van Beheer.
   * @returns {void}
   */
  function init(options) { toast = options.toast; }

  window.BeheerMailopmaak = { init, load };
})();
