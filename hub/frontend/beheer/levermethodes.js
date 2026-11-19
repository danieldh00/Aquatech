// Beheer > Webshop > Levermethodes: welke bezorgmethodes per productcategorie mogen, met aantalgrenzen
// (API /api/admin/delivery-rules, zie backend/src/webshop/delivery-rules.js). Een regel van het artikel zelf gaat voor.
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
    const res = await fetch('../api/admin/delivery-rules', {
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
   * Zet regels om naar de invoertekst, bijvoorbeeld "dpd:1-99, pallet:100-".
   * @param {{ method: string, minQty: number, maxQty: ?number }[]} rules De regels.
   * @returns {string} De tekst.
   */
  const rulesText = (rules) => (rules || []).map((rule) => `${rule.method}:${rule.minQty}-${rule.maxQty == null ? '' : rule.maxQty}`).join(', ');

  /**
   * Leest de invoertekst met regels; een regel die niet te lezen is krijgt een lege methode, zodat de server hem met een melding weigert.
   * @param {string} text De tekst.
   * @returns {{ method: string, minQty: string, maxQty: string }[]} De regels.
   */
  const parseRules = (text) => String(text).split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = /^([a-z]+)\s*:\s*(\d*)\s*-?\s*(\d*)$/i.exec(part);
    return match ? { method: match[1].toLowerCase(), minQty: match[2], maxQty: match[3] } : { method: '', minQty: '', maxQty: '' };
  });

  /**
   * Eén regel van de lijst: een categorie kiezen en de regels invullen.
   * @param {string} selectedSlug De gekozen categorie ('' = nog niets gekozen).
   * @param {string} text De regels als tekst.
   * @returns {string} De HTML van de regel.
   */
  function rowHtml(selectedSlug, text) {
    const options = categories.map((category) => `<option value="${esc(category.slug)}"${category.slug === selectedSlug ? ' selected' : ''}>${esc(category.path)}</option>`).join('');
    return `<div class="kd-rule">
      <label>Categorie<select name="categorySlug"><option value="">Kies een categorie…</option>${options}</select></label>
      <label>Toegestane methodes<input name="rules" maxlength="300" autocomplete="off" value="${esc(text)}" placeholder="bijv. dpd:1-99, pallet:100-"></label>
      <button class="btn" type="button" data-remove-rule>Verwijderen</button>
    </div>`;
  }

  /**
   * Tekent de lijst met regels.
   * @param {{ categories: object[], menu: object[] }} view Het antwoord van de server.
   * @returns {void}
   */
  function render(view) {
    categories = view.menu;
    $('#dr-list').innerHTML = view.categories.map((entry) => rowHtml(entry.categorySlug, rulesText(entry.rules))).join('');
    $('#dr-empty').hidden = view.categories.length > 0;
    $('#dr-add').disabled = !categories.length;
  }

  /**
   * Leest de regels uit het formulier; lege regels worden overgeslagen.
   * @returns {{ categories: object[] }} De regels zoals de server ze verwacht.
   */
  function collect() {
    const entries = [];
    for (const row of $('#dr-list').querySelectorAll('.kd-rule')) {
      const categorySlug = row.querySelector('[name="categorySlug"]').value;
      const text = row.querySelector('[name="rules"]').value.trim();
      if (!categorySlug && !text) continue;
      entries.push({ categorySlug, rules: parseRules(text) });
    }
    return { categories: entries };
  }

  /**
   * Laadt de regels en de categorieën van het menu.
   * @returns {Promise<void>}
   */
  async function load() {
    $('#dr-err').textContent = '';
    try { render(await api()); } catch (error) { $('#dr-err').textContent = `Kan de regels niet laden: ${error.message}`; }
  }

  /**
   * Koppelt het formulier en de knoppen (één keer, door Beheer).
   * @param {{ toast: Function }} options toast = functie voor meldingen.
   * @returns {void}
   */
  function init(options) {
    toast = options.toast;
    /**
     * Voegt een lege regel toe en zet de cursor in de keuzelijst.
     * @returns {void}
     */
    $('#dr-add').onclick = () => {
      $('#dr-list').insertAdjacentHTML('beforeend', rowHtml('', ''));
      $('#dr-empty').hidden = true;
      $('#dr-list').lastElementChild.querySelector('select').focus();
    };
    /**
     * Verwijdert een regel uit de lijst (pas bij opslaan definitief).
     * @param {MouseEvent} event De klik.
     * @returns {void}
     */
    $('#dr-list').onclick = (event) => {
      const button = event.target.closest('[data-remove-rule]');
      if (!button) return;
      button.closest('.kd-rule').remove();
      $('#dr-empty').hidden = $('#dr-list').children.length > 0;
    };
    /**
     * Slaat de regels op.
     * @param {SubmitEvent} event Het verzenden.
     * @returns {Promise<void>}
     */
    $('#dr-form').onsubmit = async (event) => {
      event.preventDefault();
      $('#dr-err').textContent = '';
      const body = collect();
      if (body.categories.some((entry) => !entry.categorySlug)) { $('#dr-err').textContent = 'Kies bij elke regel een categorie.'; return; }
      if (body.categories.some((entry) => !entry.rules.length)) { $('#dr-err').textContent = 'Vul bij elke categorie minstens één regel in, bijvoorbeeld dpd:1-99.'; return; }
      try {
        render(await api({ method: 'PUT', body }));
        toast('Levermethoderegels opgeslagen');
      } catch (error) {
        $('#dr-err').textContent = error.message;
      }
    };
  }

  window.BeheerLevermethodes = { init, load };
})();
