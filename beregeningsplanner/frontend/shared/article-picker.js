// Artikelkeuze voor werkorder en offerte: eerst het artikel kiezen, dan (bij
// een hoofdartikel met varianten) per kenmerk de waarde, bijv. de maat. De
// lijst komt uit api/stock/articles (voorraad van de omgeving, zonder
// inkoopprijs). window.ArticlePicker.open({ onPick }) geeft de gekozen variant
// of het gewone artikel terug als { code, name, unit, salePrice, vatRate }.
(function () {
  let items = null;
  let loading = null;
  let dialog = null;
  let current = { onPick: null, article: null };

  /**
   * Maakt tekst veilig om in HTML te plaatsen.
   * @param {*} value tekst of waarde (null/undefined wordt leeg)
   * @returns {string} tekst met HTML-tekens vervangen door entiteiten
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Formatteert een bedrag in euro's.
   * @param {number|null} value het bedrag
   * @returns {string} bijv. '€ 12,50', of leeg zonder bedrag
   */
  const eur = (value) => (value == null ? '' : Number(value).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' }));
  /**
   * Formatteert een aantal in Nederlandse notatie.
   * @param {number} value het aantal
   * @returns {string} het aantal als tekst
   */
  const nl = (value) => (Number(value) || 0).toLocaleString('nl-NL', { maximumFractionDigits: 3 });

  /**
   * Haalt de artikellijst op. Zonder refresh hergebruikt hij een al geladen
   * lijst; met refresh (bij elke opening van de keuze) haalt hij hem opnieuw,
   * zodat een intussen gearchiveerde variant niet meer te kiezen is. Zonder
   * recht of zonder verbinding komt er een lege lijst terug.
   * @param {string} [base] pad naar de app-root, bijv. '../'
   * @param {boolean} [refresh] true om de lijst opnieuw op te halen
   * @returns {Promise<object[]>} de artikelen (hoofdartikelen met variants)
   */
  function load(base = '../', refresh = false) {
    if (items && !refresh) return Promise.resolve(items);
    if (!loading) {
      loading = fetch(`${base}api/stock/articles`, { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then((result) => { items = Array.isArray(result.items) ? result.items : []; loading = null; return items; })
        .catch(() => { items = null; loading = null; return []; });
    }
    return loading;
  }

  /**
   * Het hoofdartikel met deze code (als de lijst al geladen is).
   * @param {string} code de artikelcode
   * @returns {object|null} het hoofdartikel met attributes en variants, of null
   */
  function parentOf(code) {
    const wanted = String(code || '').toUpperCase();
    return (items || []).find((article) => article.variants && article.code === wanted) || null;
  }

  /**
   * Maakt het keuzevenster (één keer per pagina).
   * @returns {HTMLDialogElement} het venster
   */
  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'ap-dialog';
    dialog.innerHTML = `<form method="dialog" class="ap-form" novalidate>
      <div class="ap-head"><h3 class="ap-title">Artikel kiezen</h3><button class="ap-close" value="cancel" title="Sluiten" aria-label="Sluiten">✕</button></div>
      <div class="ap-step1">
        <input class="ap-search" type="search" placeholder="Zoek op code of omschrijving" aria-label="Zoek artikel">
        <ul class="ap-list" role="listbox"></ul>
      </div>
      <div class="ap-step2" hidden>
        <div class="ap-attrs"></div>
        <p class="ap-result"></p>
        <div class="ap-actions"><button type="button" class="btn ap-back">← Ander artikel</button><button type="button" class="btn primary ap-add">Toevoegen</button></div>
      </div>
    </form>`;
    document.body.appendChild(dialog);
    const search = dialog.querySelector('.ap-search');
    search.oninput = renderList;
    /**
     * Kiest een artikel uit de lijst.
     * @param {MouseEvent} event de klik
     * @returns {void}
     */
    dialog.querySelector('.ap-list').onclick = (event) => {
      const button = event.target.closest('[data-code]');
      if (!button) return;
      const article = (items || []).find((candidate) => candidate.code === button.dataset.code);
      if (!article) return;
      // Een hoofdartikel (ook zonder actieve varianten) heeft geen eigen voorraad en is zelf niet te kiezen.
      if (article.variants) showVariants(article);
      else pick(article);
    };
    dialog.querySelector('.ap-attrs').onchange = renderResult;
    /** Terug naar de artikellijst. */
    dialog.querySelector('.ap-back').onclick = () => { showList(); };
    /** Voegt de gekozen variant toe. */
    dialog.querySelector('.ap-add').onclick = () => {
      const variant = chosenVariant();
      if (variant) pick({ ...variant, unit: variant.unit || current.article.unit });
    };
    return dialog;
  }

  /** Tekent de artikellijst (stap 1) met de zoekterm. */
  function renderList() {
    const term = dialog.querySelector('.ap-search').value.trim().toLowerCase();
    const found = (items || []).filter((article) => !term || `${article.code} ${article.name}`.toLowerCase().includes(term)).slice(0, 60);
    dialog.querySelector('.ap-list').innerHTML = found.map((article) => `<li><button type="button" data-code="${esc(article.code)}">
        <b class="code">${esc(article.code)}</b> ${esc(article.name)}
        <span class="ap-meta">${article.variants ? `${article.variants.length} varianten · kies daarna de ${esc((article.attributes || []).map((attribute) => attribute.name.toLowerCase()).join(' en ') || 'variant')}` : `${esc(eur(article.salePrice))} · ${esc(nl(article.available))} ${esc(article.unit)} beschikbaar`}</span>
      </button></li>`).join('') || `<li class="ap-empty">${items && items.length ? 'Niets gevonden.' : 'Geen voorraadartikelen beschikbaar (of geen verbinding).'}</li>`;
  }

  /** Toont stap 1: de artikellijst. */
  function showList() {
    current.article = null;
    dialog.querySelector('.ap-title').textContent = 'Artikel kiezen';
    dialog.querySelector('.ap-step1').hidden = false;
    dialog.querySelector('.ap-step2').hidden = true;
    renderList();
    dialog.querySelector('.ap-search').focus();
  }

  /**
   * Toont stap 2: per kenmerk de waarden waarvoor een variant bestaat.
   * @param {object} article het hoofdartikel
   * @param {string} [preferredCode] code van de variant die al gekozen is
   */
  function showVariants(article, preferredCode = '') {
    current.article = article;
    const preferred = article.variants.find((variant) => variant.code === String(preferredCode).toUpperCase()) || article.variants[0];
    dialog.querySelector('.ap-title').textContent = `${article.code} – ${article.name}`;
    dialog.querySelector('.ap-step1').hidden = true;
    dialog.querySelector('.ap-step2').hidden = false;
    dialog.querySelector('.ap-attrs').innerHTML = (article.attributes || []).map((attribute) => {
      const values = attribute.values.filter((value) => article.variants.some((variant) => variant.values && variant.values[attribute.name] === value));
      return `<label>${esc(attribute.name)}<select data-attr="${esc(attribute.name)}">${values.map((value) => `<option value="${esc(value)}"${preferred && preferred.values[attribute.name] === value ? ' selected' : ''}>${esc(value)}</option>`).join('')}</select></label>`;
    }).join('');
    renderResult();
    const first = dialog.querySelector('.ap-attrs select');
    if (first) first.focus();
  }

  /**
   * De variant die bij de gekozen waarden hoort.
   * @returns {object|null} de variant, of null als de combinatie niet bestaat
   */
  function chosenVariant() {
    const article = current.article;
    if (!article) return null;
    const wanted = {};
    dialog.querySelectorAll('.ap-attrs select').forEach((select) => { wanted[select.dataset.attr] = select.value; });
    return article.variants.find((variant) => Object.entries(wanted).every(([name, value]) => variant.values && variant.values[name] === value)) || null;
  }

  /** Toont code, prijs en beschikbaarheid van de gekozen variant. */
  function renderResult() {
    const variant = chosenVariant();
    dialog.querySelector('.ap-result').innerHTML = variant
      ? `<b class="code">${esc(variant.code)}</b> ${esc(variant.name)}<br>${esc(eur(variant.salePrice)) || 'geen prijs'} · ${esc(nl(variant.available))} ${esc(variant.unit || current.article.unit)} beschikbaar`
      : (current.article && !current.article.variants.length ? 'Dit hoofdartikel heeft geen actieve varianten. Maak ze aan in Artikelen.' : 'Deze combinatie bestaat niet.');
    dialog.querySelector('.ap-add').disabled = !variant;
  }

  /**
   * Geeft de keuze door en sluit het venster.
   * @param {object} article het gekozen artikel of de gekozen variant
   */
  function pick(article) {
    const onPick = current.onPick;
    dialog.close();
    if (onPick) onPick({ code: article.code, name: article.name, unit: article.unit, salePrice: article.salePrice, vatRate: article.vatRate });
  }

  /**
   * Opent de keuze. Met parentCode begint hij meteen bij de varianten van dat
   * hoofdartikel (maat kiezen voor een regel die al bestaat).
   * @param {{ onPick: Function, parentCode?: string, variantCode?: string, base?: string }} options aanroep met de keuze; hoofdartikel; huidige variant; pad naar de app-root
   * @returns {Promise<void>}
   */
  async function open({ onPick, parentCode = '', variantCode = '', base = '../' }) {
    ensureDialog();
    current = { onPick, article: null };
    dialog.querySelector('.ap-search').value = '';
    dialog.querySelector('.ap-list').innerHTML = '<li class="ap-empty">Laden…</li>';
    if (!dialog.open) dialog.showModal();
    await load(base, true);
    const parent = parentCode ? parentOf(parentCode) : null;
    if (parent) showVariants(parent, variantCode);
    else showList();
  }

  /**
   * Het hoofdartikel waar een variantcode onder valt.
   * @param {string} code de code van de variant
   * @returns {object|null} het hoofdartikel, of null
   */
  function parentOfVariant(code) {
    const wanted = String(code || '').toUpperCase();
    return (items || []).find((article) => (article.variants || []).some((variant) => variant.code === wanted)) || null;
  }

  window.ArticlePicker = { load, open, parentOf, parentOfVariant, loaded: () => Boolean(items) };
})();
