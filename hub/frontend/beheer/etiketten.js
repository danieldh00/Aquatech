// Beheer > Webshop: de editor voor etiketsjablonen (instelling labelTemplates): invullen, knoppen bijwerken en uitlezen.
// Het opslaan zelf doet beheer.js; de afdruk zelf staat in backend/src/artikelen/labels.js.
(function () {
  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector.
   * @param {ParentNode} [root] Waarbinnen gezocht wordt (standaard de pagina).
   * @returns {Element|null} Het element.
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  /** Hoogstens zoveel etiketsjablonen (gelijk aan de server). */
  const MAX_LABEL_TEMPLATES = 10;
  /**
   * Eén sjabloon in het formulier Etiketten.
   * @param {object} template Het sjabloon (key leeg = nieuw).
   * @param {boolean} isDefault true als dit het standaardsjabloon is.
   * @returns {string} De HTML.
   */
  function labelTemplateHtml(template, isDefault) {
    /**
     * Een keuze in een keuzelijst.
     * @param {string} value De waarde.
     * @param {string} label De tekst.
     * @param {string} current De gekozen waarde.
     * @returns {string} De HTML.
     */
    const option = (value, label, current) => `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`;
    /**
     * Een vinkje voor een veld van het sjabloon (standaard aan).
     * @param {string} name Het veld.
     * @param {string} label De tekst.
     * @returns {string} De HTML.
     */
    const check = (name, label) => `<label class="chk"><input type="checkbox" name="${name}"${template[name] !== false ? ' checked' : ''}> ${label}</label>`;
    return `
      <fieldset class="season-item label-template" data-key="${esc(template.key || '')}">
        <div class="row">
          <label class="grow">Naam<input name="name" maxlength="60" required value="${esc(template.name || '')}" placeholder="Bijv. Zebra 57 × 32 mm"></label>
          <label>Breedte (mm)<input name="widthMm" type="number" min="15" max="150" step="0.5" required value="${template.widthMm}"></label>
          <label>Hoogte (mm)<input name="heightMm" type="number" min="15" max="150" step="0.5" required value="${template.heightMm}"></label>
          <label>Streepjescode<select name="barcode">${option('auto', 'Automatisch', template.barcode)}${option('ean', 'Alleen EAN', template.barcode)}${option('code128', 'Artikelcode (Code 128)', template.barcode)}</select></label>
          <label>Prijs<select name="price">${option('incl', 'Incl. btw', template.price)}${option('excl', 'Excl. btw', template.price)}</select></label>
        </div>
        <div class="row">
          ${check('showName', 'Omschrijving')}
          ${check('showCode', 'Artikelcode')}
          ${check('showPrice', 'Prijs')}
          <label class="chk"><input type="radio" name="labelDefault"${isDefault ? ' checked' : ''}> Standaard</label>
          <button class="btn small danger" type="button" data-remove-label>Verwijderen</button>
        </div>
      </fieldset>`;
  }

  /**
   * Vult het formulier Etiketten met de sjablonen.
   * @param {{ templates: object[], defaultKey: string }} config De instelling labelTemplates.
   * @returns {void}
   */
  function renderLabelTemplates(config) {
    $('#s-labels-list').innerHTML = config.templates.map((template) => labelTemplateHtml(template, template.key === config.defaultKey)).join('');
    updateLabelButtons();
  }

  /**
   * Zet de knoppen Toevoegen en Verwijderen aan of uit (minstens één, hoogstens tien sjablonen).
   * @returns {void}
   */
  function updateLabelButtons() {
    const count = $('#s-labels-list').querySelectorAll('.label-template').length;
    $('#s-labels-add').disabled = count >= MAX_LABEL_TEMPLATES;
    $('#s-labels-list').querySelectorAll('[data-remove-label]').forEach((button) => { button.disabled = count <= 1; });
  }

  /**
   * Leest het formulier Etiketten uit.
   * @returns {{ templates: object[], defaultIndex: number }} De instelling labelTemplates.
   */
  function readLabelTemplates() {
    const fieldsets = [...$('#s-labels-list').querySelectorAll('.label-template')];
    /**
     * Een veld binnen een sjabloon.
     * @param {HTMLElement} fieldset Het sjabloon.
     * @param {string} name De veldnaam.
     * @returns {HTMLInputElement} Het veld.
     */
    const field = (fieldset, name) => fieldset.querySelector(`[name="${name}"]`);
    const templates = fieldsets.map((fieldset) => ({
      ...(fieldset.dataset.key ? { key: fieldset.dataset.key } : {}),
      name: field(fieldset, 'name').value.trim(),
      widthMm: Number(field(fieldset, 'widthMm').value),
      heightMm: Number(field(fieldset, 'heightMm').value),
      barcode: field(fieldset, 'barcode').value,
      price: field(fieldset, 'price').value,
      showName: field(fieldset, 'showName').checked,
      showCode: field(fieldset, 'showCode').checked,
      showPrice: field(fieldset, 'showPrice').checked,
    }));
    const defaultIndex = Math.max(0, fieldsets.findIndex((fieldset) => field(fieldset, 'labelDefault').checked));
    return { templates, defaultIndex };
  }

  window.BeheerEtiketten = { labelTemplateHtml, renderLabelTemplates, updateLabelButtons, readLabelTemplates };
})();
