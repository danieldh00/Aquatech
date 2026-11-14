// Beheer > Documentopmaak: logo, kop, kleuren, lettertype en voettekst van de PDF-documenten (factuur, pakbon)
// van deze organisatie (API /api/admin/document-layout), met een voorbeeld dat de server als PDF maakt en
// pdf.js (lokaal, pas geladen bij gebruik) in dit scherm tekent. Er wordt niets opgeslagen voordat je op Opslaan klikt.
(function () {
  const Theme = window.AquatechTheme;
  const state = { data: null, built: false, kind: 'invoice', logo: '', previewRun: 0, previewTimer: null };
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
   * Roept de API van de documentopmaak aan.
   * @param {string} [suffix] Vervolg van het adres (bijv. '/preview').
   * @param {object} [options] Methode en inhoud (`body` wordt JSON); `blob: true` geeft het antwoord als bestand.
   * @returns {Promise<object|Blob>} Het antwoord; gooit een fout met de melding van de server.
   */
  async function api(suffix = '', options = {}) {
    const res = await fetch(`../api/admin/document-layout${suffix}`, {
      cache: 'no-store',
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || AquatechCommon.statusMessage(res.status));
    }
    return options.blob ? res.blob() : res.json();
  }

  /**
   * Leest de opmaak uit het formulier.
   * @returns {object} De opmaak zoals de server hem verwacht.
   */
  function currentLayout() {
    const form = $('#do-form');
    /**
     * De kleur uit een tekstveld.
     * @param {string} key Veldnaam (headerColor of accentColor).
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
      accentColor: hexOf('accentColor'),
      font: form.font.value,
      showCompanyInHeader: form.showCompanyInHeader.checked,
      footerCompanyInfo: form.footerCompanyInfo.checked,
      footerText: form.footerText.value,
      pageNumbers: form.pageNumbers.checked,
    };
  }

  /**
   * Controleert wat het formulier zelf kan controleren (kleuren, logo gekozen).
   * @returns {string} De eerste fout, of een lege tekst.
   */
  function problem() {
    const form = $('#do-form');
    for (const [key, label] of [['headerColor', 'Kopkleur'], ['accentColor', 'Accentkleur']]) {
      const typed = form.querySelector(`[data-hex="${key}"]`).value.trim();
      if (typed && !Theme.hex(typed)) return `${label}: geef een kleur als #rrggbb, of laat het veld leeg.`;
    }
    const headerColor = Theme.hex(form.querySelector('[data-hex="headerColor"]').value);
    if (headerColor && Theme.contrast(headerColor, '#ffffff') < 4.5) return 'De kopkleur is te licht: witte tekst moet er goed op leesbaar blijven.';
    if (form.logoMode.value === 'custom' && !state.logo) return 'Kies een logo, of kies het standaardlogo.';
    return '';
  }

  /** Toont of verbergt wat bij de gekozen waarden hoort (eigen logo, hoogte, positie) en werkt het logovak bij. */
  function syncControls() {
    const form = $('#do-form');
    const mode = form.logoMode.value;
    $('#do-logo-field').hidden = mode !== 'custom';
    form.logoHeight.disabled = mode === 'none';
    $('#do-logo-height-text').textContent = `${form.logoHeight.value} punten hoog (de eerste pagina; vervolgpagina's gebruiken een kleinere kop)`;
    $('#do-logo-img').hidden = !state.logo;
    $('#do-logo-none').hidden = Boolean(state.logo);
    if (state.logo) $('#do-logo-img').src = state.logo;
    // Het logovak toont de kleur van de kop, zodat een wit logo zichtbaar blijft.
    $('#do-logo-box').style.background = form.headerStyle.value === 'band' ? (Theme.hex(form.querySelector('[data-hex="headerColor"]').value) || 'var(--at-navy)') : '#ffffff';
    $('#do-err').textContent = problem();
    $('#do-save').disabled = Boolean(problem());
  }

  /** Vult het formulier met de opmaak van deze organisatie. */
  function fill() {
    const { layout } = state.data;
    const form = $('#do-form');
    state.logo = layout.logo;
    form.logoMode.value = layout.logoMode;
    form.logoPosition.value = layout.logoPosition;
    form.logoHeight.value = layout.logoHeight;
    form.headerStyle.value = layout.headerStyle;
    form.font.value = layout.font;
    form.showCompanyInHeader.checked = layout.showCompanyInHeader;
    form.footerCompanyInfo.checked = layout.footerCompanyInfo;
    form.pageNumbers.checked = layout.pageNumbers;
    form.footerText.value = layout.footerText;
    for (const key of ['headerColor', 'accentColor']) {
      form.querySelector(`[data-hex="${key}"]`).value = layout[key];
      form.querySelector(`[data-color="${key}"]`).value = layout[key] || (key === 'headerColor' ? Theme.DEFAULTS.navy : Theme.DEFAULTS.teal);
    }
    syncControls();
    renderPreview();
  }

  /**
   * Laadt pdf.js, de eerste keer dat het voorbeeld getekend wordt.
   * @returns {Promise<object>} De bibliotheek (pdfjsLib).
   */
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '../beregening/vendor/pdf.min.js';
      /** Stelt de werker van pdf.js in zodra het script er is. */
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = '../beregening/vendor/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      /** Meldt dat pdf.js niet te laden is. */
      script.onerror = () => { reject(new Error('Het voorbeeld kan niet worden geladen.')); };
      document.head.appendChild(script);
    });
  }

  /** Vraagt de server om een voorbeeld-PDF met de opmaak uit het formulier en tekent de eerste pagina. */
  async function renderPreview() {
    const run = ++state.previewRun;
    const note = $('#do-preview-note');
    if (problem()) { note.textContent = 'Los eerst de melding bij het formulier op.'; return; }
    try {
      const [blob, pdfjs] = await Promise.all([api('/preview', { method: 'POST', body: { layout: currentLayout(), kind: state.kind }, blob: true }), loadPdfJs()]);
      if (run !== state.previewRun) return;
      const pdfDocument = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
      const page = await pdfDocument.getPage(1);
      if (run !== state.previewRun) return;
      const canvas = $('#do-canvas');
      const scale = (2 * Math.max(320, canvas.parentElement.clientWidth)) / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      note.textContent = 'Het voorbeeld gebruikt je bedrijfsgegevens en voorbeeldregels; er wordt niets opgeslagen.';
    } catch (error) {
      if (run === state.previewRun) note.textContent = `Voorbeeld mislukt: ${error.message}`;
    }
  }

  /** Vernieuwt het voorbeeld kort na de laatste wijziging, zodat typen niet elke toets een PDF kost. */
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
    const maxBytes = state.data.limits.logoBytes;
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
          $('#do-form').logoMode.value = 'custom';
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
   * Slaat de opmaak op (met `layout` = null: de standaard terugzetten).
   * @param {object|null} layout De opmaak, of null.
   * @returns {Promise<void>}
   */
  async function save(layout) {
    try {
      state.data = await api('', { method: 'PUT', body: { layout: layout || state.data.defaults } });
      fill();
      toast(layout ? 'Documentopmaak opgeslagen' : 'Standaardopmaak teruggezet');
    } catch (error) { $('#do-err').textContent = error.message; }
  }

  /** Bouwt de koppelingen van het formulier één keer. */
  function build() {
    if (state.built) return;
    state.built = true;
    const form = $('#do-form');
    /**
     * Houdt kleurkiezer en tekstveld gelijk en vernieuwt het voorbeeld.
     * @param {InputEvent} event De invoer.
     */
    form.oninput = (event) => {
      const key = event.target.dataset.color || event.target.dataset.hex;
      if (event.target.dataset.color) form.querySelector(`[data-hex="${key}"]`).value = event.target.value;
      else if (key && Theme.hex(event.target.value)) form.querySelector(`[data-color="${key}"]`).value = Theme.hex(event.target.value);
      syncControls();
      schedulePreview();
    };
    /** Werkt de keuzes bij en vernieuwt het voorbeeld. */
    form.onchange = () => { syncControls(); schedulePreview(); };
    /** Opent de bestandskiezer voor het logo. */
    $('#do-logo-pick').onclick = () => { $('#do-logo-file').click(); };
    /**
     * Verwerkt het gekozen logobestand.
     * @param {Event} event De keuze.
     */
    $('#do-logo-file').onchange = (event) => {
      const [file] = event.target.files;
      event.target.value = '';
      if (file) chooseLogo(file);
    };
    /**
     * Slaat de opmaak op als het formulier klopt.
     * @param {SubmitEvent} event Het verzenden.
     */
    form.onsubmit = (event) => { event.preventDefault(); if (!problem()) save(currentLayout()); };
    /** Zet de standaardopmaak terug. */
    $('#do-reset').onclick = () => { save(null); };
    for (const button of document.querySelectorAll('.do-kinds [data-kind]')) {
      /** Wisselt tussen het voorbeeld van de factuur en de pakbon. */
      button.onclick = () => {
        state.kind = button.dataset.kind;
        for (const other of document.querySelectorAll('.do-kinds [data-kind]')) other.setAttribute('aria-pressed', String(other === button));
        renderPreview();
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

  window.BeheerDocumentopmaak = { init, load };
})();
