// Beheer > Kleuren: de kleuren van de app voor deze organisatie, met
// contrastcontrole en voorbeeld (API /api/admin/theme). Het thema van de
// hoofdtenant is de standaard voor organisaties zonder eigen thema; een
// testomgeving volgt zijn organisatie.
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
  /**
   * Contrastverhouding met een komma als decimaalteken.
   * @param {string} foreground Voorgrondkleur als #rrggbb.
   * @param {string} background Achtergrondkleur als #rrggbb.
   * @returns {string} Bijv. "7,3".
   */
  const ratio = (foreground, background) => Theme.contrast(foreground, background).toFixed(1).replace('.', ',');
  const Theme = window.AquatechTheme;
  const state = { data: null, built: false };
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};

  /**
   * Roept de thema-API aan.
   * @param {object} [options] Methode en inhoud (`body` wordt JSON).
   * @returns {Promise<object>} Het antwoord; gooit een fout met de melding van de server.
   */
  async function api(options = {}) {
    const res = await fetch('../api/admin/theme', {
      cache: 'no-store',
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || AquatechCommon.statusMessage(res.status));
    return body;
  }

  /**
   * Leest de kleuren uit het formulier.
   * @returns {object} Kleur per veld, zoals getypt.
   */
  function currentColors() {
    const result = {};
    for (const input of $('#th-form').querySelectorAll('[data-hex]')) result[input.dataset.hex] = Theme.hex(input.value) || input.value.trim();
    return result;
  }

  /**
   * Controleert de kleuren, toont het contrast per kleur en werkt het voorbeeld bij.
   * @returns {boolean} true als alle kleuren geldig en leesbaar zijn.
   */
  function preview() {
    const formElement = $('#th-form');
    const colors = currentColors();
    const valid = Object.values(colors).every((value) => Theme.hex(value));
    const problems = valid ? Theme.problems(colors) : [];
    for (const [key, definition] of Object.entries(Theme.FIELDS)) {
      const ratioElement = formElement.querySelector(`[data-ratio="${key}"]`);
      const hexInput = formElement.querySelector(`[data-hex="${key}"]`);
      const ok = Boolean(Theme.hex(colors[key]));
      hexInput.classList.toggle('invalid', !ok);
      if (!ok) { ratioElement.textContent = 'Geef een kleur als #rrggbb.'; ratioElement.className = 'th-ratio bad'; continue; }
      const contrast = Theme.contrast(colors[key], '#ffffff');
      const fail = problems.some((problem) => problem.field === key);
      ratioElement.textContent = definition.min
        ? `Contrast met wit ${ratio(colors[key], '#ffffff')}:1 ${fail ? `– te licht, minimaal ${String(definition.min).replace('.', ',')}:1` : contrast >= 4.5 ? '– goed leesbaar' : '– voldoende voor vette tekst'}`
        : `Contrast met wit ${ratio(colors[key], '#ffffff')}:1 (alleen accent)`;
      ratioElement.className = `th-ratio${fail ? ' bad' : contrast >= 4.5 || !definition.min ? ' ok' : ' warn'}`;
    }
    if (valid) for (const [name, value] of Object.entries(Theme.vars(colors))) $('#th-preview').style.setProperty(name, value);
    $('#th-err').textContent = !valid ? 'Niet alle kleuren zijn geldig.' : problems.length ? problems[0].message : '';
    $('#th-save').disabled = !valid || problems.length > 0;
    return valid && !problems.length;
  }

  /** Vult het formulier met het thema dat deze organisatie nu toont. */
  function fill() {
    const { data } = state;
    const own = Object.keys(data.theme).length > 0;
    const isMain = data.tenantId === data.mainTenantId;
    const colors = Theme.resolve(own ? data.theme : data.inherited);
    for (const [key, value] of Object.entries(colors)) {
      $('#th-form').querySelector(`[data-color="${key}"]`).value = value;
      $('#th-form').querySelector(`[data-hex="${key}"]`).value = value;
    }
    $('#th-note').textContent = isMain
      ? (own ? 'Dit is het standaardthema voor alle organisaties zonder eigen thema.' : 'Nu de huisstijl van AquaTech Service. Een keuze hier geldt voor alle organisaties zonder eigen thema.')
      : (own ? `${data.tenantName} heeft een eigen thema.` : `${data.tenantName} volgt nu het standaardthema; opslaan geeft een eigen thema.`);
    $('#th-reset').textContent = isMain ? 'Standaardkleuren terugzetten' : 'Eigen thema verwijderen';
    $('#th-reset').disabled = !own;
    preview();
    // Het standaardthema voor alle organisaties wijzigt bij meerdere organisaties alleen een hoofdbeheerder.
    if (!data.canEdit) {
      $('#th-note').textContent = 'Dit is het standaardthema voor alle organisaties. Alleen een hoofdbeheerder wijzigt het.';
      for (const input of $('#th-form').querySelectorAll('input, button')) input.disabled = true;
    } else {
      for (const input of $('#th-form').querySelectorAll('input')) input.disabled = false;
    }
  }

  /** Bouwt het formulier één keer en koppelt de knoppen. */
  function build() {
    if (state.built) return;
    state.built = true;
    $('#th-fields').innerHTML = Object.entries(Theme.FIELDS).map(([key, field]) => `
      <label class="th-field">${esc(field.label)}
        <span class="th-pick"><input type="color" data-color="${key}"><input type="text" data-hex="${key}" maxlength="7" spellcheck="false" autocomplete="off"></span>
        <span class="hint">${esc(field.help)}</span><span class="th-ratio" data-ratio="${key}"></span>
      </label>`).join('');
    /**
     * Houdt kleurkiezer en tekstveld gelijk en werkt het voorbeeld bij.
     * @param {InputEvent} event De invoer.
     */
    $('#th-form').oninput = (event) => {
      const key = event.target.dataset.color || event.target.dataset.hex;
      if (!key) return;
      if (event.target.dataset.color) $('#th-form').querySelector(`[data-hex="${key}"]`).value = event.target.value;
      else if (Theme.hex(event.target.value)) $('#th-form').querySelector(`[data-color="${key}"]`).value = Theme.hex(event.target.value);
      preview();
    };
    /**
     * Slaat de kleuren op als ze in orde zijn.
     * @param {SubmitEvent} event Het verzenden.
     */
    $('#th-form').onsubmit = (event) => { event.preventDefault(); if (preview()) save(currentColors()); };
    /**
     * Zet de standaardkleuren terug.
     * @returns {Promise<void>}
     */
    $('#th-reset').onclick = () => save(null);
  }

  /**
   * Slaat het thema op (null = terug naar standaard) en laadt het actieve thema op deze pagina opnieuw.
   * @param {object|null} colors De kleuren, of null om het eigen thema te verwijderen.
   * @returns {Promise<void>}
   */
  async function save(colors) {
    try {
      const result = await api({ method: 'PUT', body: { colors } });
      state.data.theme = result.theme;
      // De standaard van de hoofdtenant is meteen ook wat deze pagina als terugval toont.
      if (state.data.tenantId === state.data.mainTenantId) state.data.inherited = result.theme;
      const link = document.querySelector('link[href*="shared/theme.css"]');
      if (link) link.href = `../shared/theme.css?t=${Date.now()}`;
      fill();
      toast(colors ? 'Kleuren opgeslagen' : state.data.tenantId === state.data.mainTenantId ? 'Standaardkleuren teruggezet' : 'Eigen thema verwijderd');
    } catch (error) { $('#th-err').textContent = error.message; }
  }

  /**
   * Laadt het thema van deze organisatie en toont het.
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

  window.BeheerKleuren = { init, load };
})();
