// Artikelen: nieuw artikel toevoegen, artikelen uit de catalogus op voorraad nemen en alles uit de webshop overnemen.
// Staat los van artikelen.js; die geeft via setup() de gedeelde state en hulpfuncties mee.
(function () {
  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector CSS-selector
   * @param {ParentNode} root waarbinnen gezocht wordt (standaard het document)
   * @returns {Element|null} het gevonden element
   */
  const $ = (selector, root = document) => root.querySelector(selector);
  /**
   * Maakt tekst veilig om in HTML te plaatsen.
   * @param {*} value tekst of waarde (null/undefined wordt leeg)
   * @returns {string} tekst met HTML-tekens vervangen door entiteiten
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const Catalog = window.Catalog || { articles: {} };
  let state; let api; let toast; let num; let parseTiers; let load; let loadUnits; let fillUnits;

  /**
   * Geeft de module wat hij van de pagina nodig heeft (gedeelde state en hulpfuncties van artikelen.js).
   * @param {object} context state, api, toast, num, parseTiers, load, loadUnits en fillUnits uit artikelen.js
   * @returns {void}
   */
  function setup(context) {
    ({ state, api, toast, num, parseTiers, load, loadUnits, fillUnits } = context);
  }

  // ---------- Nieuw artikel en uit de catalogus ----------
  /** Opent het formulier voor een nieuw artikel (met codes uit de catalogus om te kiezen). */
  function openNew() {
    const formElement = $('#new-form');
    $('#import-form').hidden = true;
    $('#units-form').hidden = true;
    formElement.reset();
    fillUnits();
    if (state.units.some((unit) => unit.name === 'st')) formElement.unit.value = 'st';
    $('.err', formElement).textContent = '';
    showNewImage(null);
    const have = new Set(state.items.map((item) => item.code));
    $('#catalog-codes').innerHTML = Object.entries(Catalog.articles).filter(([code]) => !have.has(code)).map(([code, article]) => `<option value="${esc(code)}">${esc(article.name)}</option>`).join('');
    formElement.hidden = false;
    formElement.code.focus();
  }

  /**
   * Toont de gekozen afbeelding in het formulier voor een nieuw artikel (of leeg).
   * @param {{ name: string, data: string }|null} picked de klaargemaakte afbeelding, of null
   */
  function showNewImage(picked) {
    state.newImage = picked;
    $('#n-image-preview').innerHTML = picked ? `<img src="data:image/*;base64,${picked.data}" alt="">` : '<span class="muted small">Geen afbeelding</span>';
    $('#n-image-clear').hidden = !picked;
    if (!picked) $('#new-form').image.value = '';
  }

  /** Koppelt het formulier voor een nieuw artikel. */
  function setupNew() {
    const formElement = $('#new-form');
    /** Verkleint de gekozen afbeelding en toont hem. */
    formElement.image.onchange = async () => {
      const errorBox = $('.err', formElement);
      errorBox.textContent = '';
      const file = formElement.image.files && formElement.image.files[0];
      if (!file) { showNewImage(null); return; }
      try { showNewImage(await window.ItemImages.prepare(file)); } catch (error) { showNewImage(null); errorBox.textContent = error.message; }
    };
    /**
     * Haalt de gekozen afbeelding weer weg.
     * @returns {void}
     */
    $('#n-image-clear').onclick = () => showNewImage(null);
    /** Vult naam en eenheid in als de code in de catalogus staat. */
    formElement.code.oninput = () => {
      const article = Catalog.articles[formElement.code.value.trim().toUpperCase()];
      if (article && !formElement.name.value) {
        formElement.name.value = article.name;
        fillUnits(article.unit || 'st');
        formElement.unit.value = article.unit || 'st';
      }
    };
    setupCodeProposal(formElement);
    /** Sluit het formulier. */
    $('[data-cancel]', formElement).onclick = () => { formElement.hidden = true; };
    /**
     * Slaat het nieuwe artikel op.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      const errorBox = $('.err', formElement);
      errorBox.textContent = '';
      try {
        const item = await api('stock/items', { method: 'POST', body: {
          code: formElement.code.value, name: formElement.name.value, unit: formElement.unit.value, location: formElement.location.value,
          onHand: num(formElement.onHand.value), minQty: num(formElement.minQty.value), reorderQty: num(formElement.reorderQty.value), costPrice: num(formElement.costPrice.value),
          salePrice: num(formElement.salePrice.value), vatRate: Number(formElement.vatRate.value), weightGrams: num(formElement.weightGrams.value), businessPrice: num(formElement.businessPrice.value), revenueGroup: formElement.revenueGroup.value, shopSync: formElement.shopSync.checked,
          packSize: num(formElement.packSize.value), orderMinQty: num(formElement.orderMinQty.value), priceTiers: parseTiers(formElement.priceTiers.value), unitContent: num(formElement.unitContent.value), ean: formElement.ean.value,
          priceMode: formElement.priceMode.value, priceFactor: num(formElement.priceFactor.value), subGroupId: formElement.subGroupId.value || null,
        } });
        formElement.hidden = true;
        toast(`${item.code} toegevoegd`);
        if (state.newImage) await window.ItemImages.upload(item.id, state.newImage).catch((error) => toast(`${item.code} is toegevoegd, maar de afbeelding niet: ${error.message}`, true));
        await Promise.all([load(), loadUnits().catch((error) => toast(error.message, true))]);
      } catch (error) {
        errorBox.textContent = error.message;
        if (error.field && formElement[error.field]) formElement[error.field].focus();
      }
    };
  }

  /**
   * Koppelt de keuze van soort, diameter en draadmaat aan het codevoorstel: bij elke wijziging vraagt het formulier de server om een
   * vrije code en vult het codeveld, zolang de gebruiker de code niet zelf heeft getypt.
   * @param {HTMLFormElement} formElement Het formulier voor een nieuw artikel.
   * @returns {void}
   */
  function setupCodeProposal(formElement) {
    const hint = $('#n-code-hint');
    let loaded = false;
    let typedByHand = false;
    /**
     * Vult de keuzelijst met de soorten (eenmalig, pas als het formulier gebruikt wordt).
     * @returns {Promise<void>}
     */
    const loadKinds = async () => {
      if (loaded) return;
      loaded = true;
      try {
        const { mainGroups, subGroups } = await api('stock/code-groups');
        /**
         * Het merk van een soort, als voorvoegsel voor de keuzelijst.
         * @param {object} kind De soort.
         * @returns {string} Merkcode met scheidingsteken, of leeg zonder merk.
         */
        const brandOf = (kind) => { const brand = mainGroups.find((group) => group.id === kind.mainGroupId); return brand ? `${brand.code} · ` : ''; };
        formElement.subGroupId.innerHTML = `<option value="">Geen (eigen code)</option>${subGroups.map((kind) => `<option value="${esc(kind.id)}">${esc(brandOf(kind))}${esc(kind.code)} · ${esc(kind.name)}</option>`).join('')}`;
      } catch (error) {
        loaded = false;
      }
    };
    /**
     * Vraagt een codevoorstel en zet het in het codeveld.
     * @returns {Promise<void>}
     */
    const propose = async () => {
      hint.textContent = '';
      if (!formElement.subGroupId.value) return;
      const query = new URLSearchParams({ subGroupId: formElement.subGroupId.value, diameter: formElement.diameter.value.trim(), thread: formElement.thread.value.trim() });
      try {
        const result = await api(`stock/code-proposal?${query}`);
        hint.textContent = result.taken ? `${result.code} bestaat al als artikel.` : '';
        if (!typedByHand || !formElement.code.value) { formElement.code.value = result.code; typedByHand = false; }
      } catch (error) {
        hint.textContent = error.message;
      }
    };
    formElement.subGroupId.onfocus = loadKinds;
    formElement.subGroupId.onmousedown = loadKinds;
    formElement.subGroupId.onchange = propose;
    formElement.diameter.oninput = propose;
    formElement.thread.oninput = propose;
    formElement.code.addEventListener('input', (event) => { if (event.isTrusted) typedByHand = true; });
    formElement.addEventListener('reset', () => { typedByHand = false; hint.textContent = ''; });
    loadKinds();
  }

  // ---------- Uit de webshop ----------
  /**
   * Neemt alles uit de webshop over (volle synchronisatie) in een venster met
   * voortgangsbalk; artikelen die niet in de webshop staan worden gearchiveerd.
   * @returns {Promise<void>}
   */
  async function importShop() {
    const dialog = $('#shop-dialog');
    const button = $('#b-shop');
    const bar = $('#shop-bar');
    $('#shop-text').textContent = 'Producten ophalen uit de webshop en de voorraad bijwerken…';
    $('#shop-close').hidden = true;
    bar.removeAttribute('value');
    dialog.showModal();
    button.disabled = true;
    try {
      const result = await api('stock/import-shop', { method: 'POST', body: {} });
      bar.value = 1;
      $('#shop-text').textContent = `Klaar: ${result.created} nieuw, ${result.restored} teruggezet, ${result.archived} gearchiveerd (niet in de webshop)${result.skippedProducts ? `, ${result.skippedProducts} overgeslagen (geen geldige code)` : ''}.`;
      await Promise.all([load(), loadUnits().catch((error) => toast(error.message, true))]);
    } catch (error) {
      bar.value = 0;
      $('#shop-text').textContent = `Overnemen mislukt: ${error.message}`;
    } finally {
      button.disabled = false;
      $('#shop-close').hidden = false;
    }
  }

  /** Koppelt de knop om het venster te sluiten. */
  function setupShop() {
    /** Sluit het venster. */
    $('#shop-close').onclick = () => { $('#shop-dialog').close(); };
  }

  /**
   * Opent de lijst met catalogusartikelen om op voorraad te nemen.
   * @param {string[]} preselect codes die al aangevinkt zijn (bijv. vanuit een werkorder)
   */
  function openImport(preselect = []) {
    const formElement = $('#import-form');
    $('#new-form').hidden = true;
    $('.err', formElement).textContent = '';
    const have = new Set(state.items.map((item) => item.code));
    const preselected = new Set(preselect.map((code) => code.toUpperCase()));
    $('#i-list').innerHTML = Object.entries(Catalog.articles).map(([code, article]) => (have.has(code)
      ? `<label class="have"><input type="checkbox" disabled checked> <span><span class="code">${esc(code)}</span> ${esc(article.name)} (al op voorraad)</span></label>`
      : `<label data-s="${esc(`${code} ${article.name}`.toLowerCase())}"><input type="checkbox" value="${esc(code)}"${preselected.has(code) ? ' checked' : ''}> <span><span class="code">${esc(code)}</span> ${esc(article.name)}</span></label>`)).join('');
    $('#i-search').value = '';
    formElement.hidden = false;
    if (preselected.size) formElement.scrollIntoView();
  }

  /** Koppelt het formulier "Uit catalogus". */
  function setupImport() {
    const formElement = $('#import-form');
    /** Sluit het formulier. */
    $('[data-cancel]', formElement).onclick = () => { formElement.hidden = true; };
    /** Filtert de lijst op de zoekterm. */
    $('#i-search').oninput = () => {
      const term = $('#i-search').value.trim().toLowerCase();
      formElement.querySelectorAll('#i-list label[data-s]').forEach((label) => { label.hidden = Boolean(term) && !label.dataset.s.includes(term); });
    };
    /** Vinkt alle zichtbare artikelen aan. */
    $('#i-all').onclick = () => { formElement.querySelectorAll('#i-list label[data-s]:not([hidden]) input').forEach((input) => { input.checked = true; }); };
    /**
     * Neemt de gekozen catalogusartikelen op voorraad.
     * @param {SubmitEvent} event het verzenden
     * @returns {Promise<void>}
     */
    formElement.onsubmit = async (event) => {
      event.preventDefault();
      const codes = [...formElement.querySelectorAll('#i-list input:checked:not([disabled])')].map((input) => input.value);
      const errorBox = $('.err', formElement);
      if (!codes.length) { errorBox.textContent = 'Kies een of meer artikelen.'; return; }
      try {
        const result = await api('stock/import', { method: 'POST', body: { codes } });
        formElement.hidden = true;
        toast(`${result.created} artikel${result.created === 1 ? '' : 'en'} op voorraad genomen`);
        await Promise.all([load(), loadUnits().catch((error) => toast(error.message, true))]);
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
  }

  /** Koppelt alle formulieren en knoppen van dit onderdeel. */
  function setupAll() {
    setupNew();
    setupImport();
    setupShop();
  }

  window.ArtikelenNew = { setup, setupAll, openNew, openImport, importShop };
})();
