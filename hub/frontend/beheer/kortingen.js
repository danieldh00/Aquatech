// Beheer > Webshop > Zakelijke kortingen: een kortingspercentage per productcategorie voor zakelijke
// klanten (API /api/admin/category-discounts, zie backend/src/webshop/category-discounts.js).
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
  /** Hoogste korting die de server toestaat. */
  const MAX_DISCOUNT = 90;
  /** Alle categorieën van het menu (slug, name, depth, path), in menuvolgorde. */
  let categories = [];
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};

  /**
   * Roept de API aan.
   * @param {object} [options] Methode en inhoud (`body` wordt JSON).
   * @returns {Promise<object>} Het antwoord; gooit een fout met de melding van de server.
   */
  async function api(options = {}) {
    const res = await fetch('../api/admin/category-discounts', {
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
   * Eén regel van de lijst: een categorie kiezen en een percentage invullen.
   * @param {string} selectedSlug De gekozen categorie ('' = nog niets gekozen).
   * @param {number|string} discountPct Het percentage.
   * @returns {string} De HTML van de regel.
   */
  function ruleHtml(selectedSlug, discountPct) {
    const options = categories.map((category) => `<option value="${esc(category.slug)}"${category.slug === selectedSlug ? ' selected' : ''}>${esc(category.path)}</option>`).join('');
    return `<div class="kd-rule">
      <label>Categorie<select name="categorySlug"><option value="">Kies een categorie…</option>${options}</select></label>
      <label>Korting (%)<input name="discountPct" type="number" min="0.01" max="${MAX_DISCOUNT}" step="0.01" inputmode="decimal" value="${esc(discountPct)}"></label>
      <button class="btn" type="button" data-remove-rule>Verwijderen</button>
    </div>`;
  }

  /**
   * Tekent de lijst met kortingen.
   * @param {{ rules: object[], categories: object[] }} view Het antwoord van de server.
   * @returns {void}
   */
  function render(view) {
    categories = view.categories;
    $('#kd-list').innerHTML = view.rules.map((rule) => ruleHtml(rule.categorySlug, rule.discountPct)).join('');
    $('#kd-empty').hidden = view.rules.length > 0;
    $('#kd-add').disabled = !categories.length;
  }

  /**
   * Leest de regels uit het formulier; lege regels worden overgeslagen.
   * @returns {{ rules: object[] }} De kortingen zoals de server ze verwacht.
   */
  function collect() {
    const rules = [];
    for (const rule of $('#kd-list').querySelectorAll('.kd-rule')) {
      const categorySlug = rule.querySelector('[name="categorySlug"]').value;
      const discountPct = rule.querySelector('[name="discountPct"]').value.trim().replace(',', '.');
      if (!categorySlug && !discountPct) continue;
      rules.push({ categorySlug, discountPct: Number(discountPct) });
    }
    return { rules };
  }

  /**
   * Laadt de kortingen en de categorieën van het menu.
   * @returns {Promise<void>}
   */
  async function load() {
    $('#kd-err').textContent = '';
    try { render(await api()); } catch (error) { $('#kd-err').textContent = `Kan de kortingen niet laden: ${error.message}`; }
  }

  /**
   * Koppelt het formulier en de knoppen (één keer, door Beheer).
   * @param {{ toast: Function }} options toast = functie voor meldingen.
   * @returns {void}
   */
  function init(options) {
    toast = options.toast;
    const form = $('#kd-form');
    /**
     * Voegt een lege regel toe en zet de cursor in de keuzelijst.
     * @returns {void}
     */
    $('#kd-add').onclick = () => {
      $('#kd-list').insertAdjacentHTML('beforeend', ruleHtml('', ''));
      $('#kd-empty').hidden = true;
      $('#kd-list').lastElementChild.querySelector('select').focus();
    };
    /**
     * Verwijdert een regel uit de lijst (pas bij opslaan definitief).
     * @param {MouseEvent} event De klik.
     * @returns {void}
     */
    $('#kd-list').onclick = (event) => {
      const button = event.target.closest('[data-remove-rule]');
      if (!button) return;
      button.closest('.kd-rule').remove();
      $('#kd-empty').hidden = $('#kd-list').children.length > 0;
    };
    /**
     * Slaat de kortingen op.
     * @param {SubmitEvent} event Het verzenden.
     * @returns {Promise<void>}
     */
    form.onsubmit = async (event) => {
      event.preventDefault();
      $('#kd-err').textContent = '';
      const body = collect();
      if (body.rules.some((rule) => !rule.categorySlug)) { $('#kd-err').textContent = 'Kies bij elke korting een categorie.'; return; }
      if (body.rules.some((rule) => !(rule.discountPct > 0 && rule.discountPct <= MAX_DISCOUNT))) { $('#kd-err').textContent = `Vul een korting in boven 0 tot en met ${MAX_DISCOUNT}%.`; return; }
      try {
        render(await api({ method: 'PUT', body }));
        toast('Kortingen opgeslagen');
      } catch (error) {
        $('#kd-err').textContent = error.message;
      }
    };
  }

  window.BeheerKortingen = { init, load };
})();
