// Beheer > Webshop: koppeling met de webshop van de organisatie instellen en
// producten ophalen (API /api/admin/shop, zie backend/src/webshop/shop.js).
(function () {
  /**
   * Zoekt het eerste element bij een CSS-selector.
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
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15" (– zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};

  /**
   * Roept de beheer-API aan.
   * @param {string} path Pad onder api/admin/, bijv. "shop".
   * @param {object} [requestOptions] Opties voor fetch; `body` wordt als JSON verstuurd.
   * @returns {Promise<object>} Het antwoord (fout = Error met de melding van de server).
   */
  async function api(path, requestOptions = {}) {
    const res = await fetch(`../api/admin/${path}`, {
      cache: 'no-store',
      ...requestOptions,
      headers: requestOptions.body ? { 'Content-Type': 'application/json' } : undefined,
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  /**
   * Vult het formulier en de status van de webshopkoppeling.
   * @param {object} view Antwoord van api/admin/shop (source, status, sleutels, koppeltellingen).
   */
  function render(view) {
    const form = $('#w-form');
    const source = view.source || {};
    form.url.value = source.url || '';
    form.mode.value = source.mode || 'store';
    form.pricesIncludeTax.checked = source.pricesIncludeTax !== false;
    form.vatRate.value = String(source.vatRate ?? 21);
    form.mapping.value = Object.entries(source.mapping || {}).map(([code, sku]) => `${code}=${sku}`).join('\n');
    form.consumerKey.value = '';
    form.consumerSecret.value = '';
    form.push.checked = Boolean(source.push);
    form.pushStock.checked = source.pushStock !== false;
    /** Toont de sleutelvelden en het pushblok alleen bij de REST-koppeling. */
    const toggleRestFields = () => { $('#w-keys').style.display = form.mode.value === 'rest' ? '' : 'none'; $('#w-push-box').style.display = form.mode.value === 'rest' ? '' : 'none'; form.pushStock.disabled = !form.push.checked; };
    toggleRestFields();
    const keys = view.consumerKey && view.consumerKey.set && view.consumerSecret && view.consumerSecret.set;
    $('#w-key-state').textContent = keys ? `Ingesteld${view.consumerKey.hint ? ` (key eindigt op ${view.consumerKey.hint.replace('…', '')})` : ''}` : 'Nog niet ingesteld.';
    $('#w-key-state').className = `state ${keys ? 'ok' : 'off'}`;
    $('#w-sync').disabled = !source.url;
    $('#w-off').disabled = !source.url;
    const syncStatus = view.status;
    const statusBox = $('#w-status');
    if (!source.url) { statusBox.textContent = 'Geen webshop gekoppeld: de planner en offertes gebruiken de indicatieve standaardprijzen.'; return; }
    statusBox.innerHTML = `
      ${syncStatus && syncStatus.syncedAt ? `<p>Laatst opgehaald: <b>${esc(when(syncStatus.syncedAt))}</b> · ${syncStatus.productCount} producten · <b>${view.matchedCount} van ${view.articleCount}</b> artikelen van de planner gekoppeld.</p>` : '<p>Nog geen producten opgehaald.</p>'}
      ${source.push ? '<p>Prijzen' + (source.pushStock !== false ? ' en voorraad' : '') + ' gaan vanuit Voorraadbeheer naar de webshop. Per artikel zie je de stand in <a href="../voorraad/">Voorraadbeheer</a>.</p>' : ''}
      ${view.stockSync && !view.stockSync.skipped ? `<p>Voorraadartikelen: ${view.stockSync.linked} nieuw gekoppeld, ${view.stockSync.updated} bijgewerkt in de webshop, ${view.stockSync.pricesFromShop} prijzen uit de webshop overgenomen, ${view.stockSync.soldInShop} verkocht via de webshop afgeboekt${view.stockSync.failed ? `, <b>${view.stockSync.failed} mislukt</b>` : ''}.</p>` : ''}
      ${syncStatus && syncStatus.lastError ? `<p class="err">Laatste poging (${esc(when(syncStatus.lastAttemptAt))}) mislukt: ${esc(syncStatus.lastError)}</p>` : ''}
      ${view.unmatched && view.unmatched.length && syncStatus && syncStatus.syncedAt ? `<details><summary>Nog niet gekoppeld (${view.unmatched.length})</summary><p class="small">${view.unmatched.map(esc).join(', ')}</p></details>` : ''}`;
  }

  /**
   * Laadt de koppeling en tekent hem.
   * @returns {Promise<void>}
   */
  async function load() {
    try { render(await api('shop')); } catch (error) { toast(`Kan de webshopkoppeling niet laden: ${error.message}`, true); }
  }

  /**
   * Haalt de producten opnieuw op uit de webshop en toont het resultaat.
   * @returns {Promise<void>}
   */
  async function sync() {
    const button = $('#w-sync');
    button.disabled = true;
    button.textContent = 'Bezig…';
    try {
      const view = await api('shop/sync', { method: 'POST' });
      render(view);
      toast(`${view.status.productCount} producten opgehaald, ${view.matchedCount} artikelen gekoppeld`);
    } catch (error) {
      $('.err', $('#w-form')).textContent = error.message;
      load();
    } finally {
      button.textContent = 'Opnieuw ophalen';
    }
  }

  /**
   * Koppelt het formulier en de knoppen (één keer, door Beheer).
   * @param {object} options { toast } = functie voor meldingen.
   */
  function init(options) {
    toast = options.toast;
    const form = $('#w-form');
    /** Toont de sleutelvelden en het pushblok alleen bij de REST-koppeling. */
    const toggleRestFields = () => { $('#w-keys').style.display = form.mode.value === 'rest' ? '' : 'none'; $('#w-push-box').style.display = form.mode.value === 'rest' ? '' : 'none'; form.pushStock.disabled = !form.push.checked; };
    form.mode.onchange = toggleRestFields;
    form.push.onchange = toggleRestFields;
    /**
     * Slaat de koppeling op en haalt daarna de producten op.
     * @param {SubmitEvent} event Het verzenden.
     * @returns {Promise<void>}
     */
    form.onsubmit = async (event) => {
      event.preventDefault();
      const errorBox = $('.err', form);
      errorBox.textContent = '';
      const mapping = {};
      for (const line of form.mapping.value.split('\n')) {
        const [code, sku] = line.split('=').map((part) => (part || '').trim());
        if (code && sku) mapping[code.toUpperCase()] = sku;
      }
      const body = { url: form.url.value.trim(), mode: form.mode.value, pricesIncludeTax: form.pricesIncludeTax.checked, vatRate: Number(form.vatRate.value), mapping, push: form.push.checked, pushStock: form.pushStock.checked };
      if (form.consumerKey.value.trim()) body.consumerKey = form.consumerKey.value.trim();
      if (form.consumerSecret.value.trim()) body.consumerSecret = form.consumerSecret.value.trim();
      try {
        render(await api('shop', { method: 'PUT', body }));
        if (body.url) await sync();
      } catch (error) {
        errorBox.textContent = error.message;
      }
    };
    $('#w-sync').onclick = sync;
    /**
     * Verwijdert de koppeling na bevestiging.
     * @returns {Promise<void>}
     */
    $('#w-off').onclick = async () => {
      if (!confirm('Webshopkoppeling verwijderen? De planner en offertes gebruiken daarna weer de standaardprijzen.')) return;
      try { render(await api('shop', { method: 'PUT', body: { url: '', clearKeys: true } })); toast('Koppeling verwijderd'); } catch (error) { toast(error.message, true); }
    };
  }

  window.BeheerWebshop = { init, load };
})();
