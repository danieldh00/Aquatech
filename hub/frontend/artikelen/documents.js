// Blok PDF's bij een artikel: productinformatie van de leverancier uploaden, laten tonen als download op de productpagina of verbergen, en weghalen.
(function () {
  /**
   * Zoekt het eerste element dat bij de selector past.
   * @param {string} selector De CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (selector) => document.querySelector(selector);
  const context = {};
  const state = { item: null, documents: [] };
  const MAX_BYTES = 10 * 1024 * 1024;

  /**
   * Maakt van een aantal bytes een leesbare grootte.
   * @param {number} bytes Aantal bytes.
   * @returns {string} Bijvoorbeeld "340 kB" of "1,2 MB".
   */
  function sizeText(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
  }

  /**
   * Roept de API aan en geeft de JSON terug.
   * @param {string} path Pad na `api/`.
   * @param {RequestInit} [init] Opties voor fetch.
   * @returns {Promise<object>} Het antwoord; gooit een fout met de melding van de server.
   */
  async function call(path, init = {}) {
    const response = await fetch(`../api/${path}`, { cache: 'no-store', ...init });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || AquatechCommon.statusMessage(response.status));
    return result;
  }

  /** Tekent de lijst met PDF's van het artikel. */
  function render() {
    const { esc } = context;
    const archived = Boolean(state.item && state.item.archived);
    $('#d-doc-table').innerHTML = state.documents.length ? `<thead><tr><th>Bestand</th><th class="num">Pagina's</th><th class="num">Grootte</th><th>Op de productpagina</th><th></th></tr></thead>
      <tbody>${state.documents.map((document_) => `<tr>
        <td class="wrap"><a href="../api/stock/documents/${encodeURIComponent(document_.id)}" target="_blank" rel="noopener">${esc(document_.name)}</a></td>
        <td class="num">${esc(document_.pages)}</td><td class="num">${esc(sizeText(document_.size))}</td>
        <td><label><input type="checkbox" data-public="${esc(document_.id)}" ${document_.public ? 'checked' : ''} ${archived ? 'disabled' : ''} aria-label="Tonen als download op de productpagina"> Downloaden</label></td>
        <td class="num"><button class="btn small danger" type="button" data-drop="${esc(document_.id)}" ${archived ? 'disabled' : ''}>Weghalen</button></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">Nog geen PDF bij dit artikel.</td></tr></tbody>';
    $('#d-doc-add').hidden = archived || state.documents.length >= 5;
  }

  /**
   * Laadt de PDF's van een artikel en toont het blok (niet bij een artikelgroep).
   * @param {object} item Het artikel.
   * @returns {Promise<void>}
   */
  async function showItem(item) {
    const section = $('#d-documents');
    state.item = item;
    state.documents = [];
    $('#d-doc-table').innerHTML = '';
    $('.err', section).textContent = '';
    section.hidden = Boolean(item.isGroup);
    if (item.isGroup) return;
    let result;
    try {
      result = await call(`stock/items/${encodeURIComponent(item.id)}/documents`);
    } catch (error) {
      if (state.item && state.item.id === item.id) $('.err', section).textContent = error.message;
      return;
    }
    if (!state.item || state.item.id !== item.id) return;
    state.documents = result.documents;
    render();
  }

  /**
   * Uploadt de gekozen PDF.
   * @param {File} file Het gekozen bestand.
   * @returns {Promise<void>}
   */
  async function upload(file) {
    const errorBox = $('#d-documents .err');
    errorBox.textContent = '';
    if (!file) return;
    if (file.size > MAX_BYTES) { errorBox.textContent = 'De PDF is te groot (hoogstens 10 MB).'; return; }
    const item = state.item;
    try {
      await call(`stock/items/${encodeURIComponent(item.id)}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Bestandsnaam': encodeURIComponent(file.name) }, body: file });
      context.toast('PDF toegevoegd');
    } catch (error) {
      errorBox.textContent = error.message;
    }
    if (state.item && state.item.id === item.id) await showItem(item);
  }

  /**
   * Koppelt de knoppen.
   * @param {{ toast: Function, esc: Function }} options Hulpfuncties van de pagina.
   */
  function setup(options) {
    Object.assign(context, options);
    /**
     * Uploadt het gekozen bestand en maakt de keuze weer leeg.
     * @param {Event} event De wijziging van het bestandsveld.
     */
    $('#d-doc-file').onchange = (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      upload(file);
    };
    /**
     * Zet een PDF aan of uit voor de productpagina, of haalt hem weg.
     * @param {Event} event De wijziging of klik.
     * @returns {Promise<void>}
     */
    const act = async (event) => {
      const errorBox = $('#d-documents .err');
      const toggle = event.target.closest('[data-public]');
      const drop = event.target.closest('[data-drop]');
      if (!toggle && !drop) return;
      if (drop && event.type !== 'click') return;
      if (toggle && event.type !== 'change') return;
      errorBox.textContent = '';
      try {
        if (toggle) await call(`stock/documents/${encodeURIComponent(toggle.dataset.public)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public: toggle.checked }) });
        else await call(`stock/documents/${encodeURIComponent(drop.dataset.drop)}`, { method: 'DELETE' });
      } catch (error) {
        errorBox.textContent = error.message;
      }
      if (state.item) await showItem(state.item);
    };
    $('#d-doc-table').addEventListener('change', act);
    $('#d-doc-table').addEventListener('click', act);
  }

  window.ArtikelenDocuments = { setup, showItem };
})();
