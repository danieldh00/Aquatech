// Artikelen: de mediabibliotheek, de afbeelding van een artikel en het overnemen van afbeeldingen uit de webshop.
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
  let state; let toast; let load; let openItem;

  /**
   * Geeft de module wat hij van de pagina nodig heeft (gedeelde state en hulpfuncties van artikelen.js).
   * @param {object} context state, toast, load en openItem uit artikelen.js
   * @returns {void}
   */
  function setup(context) {
    ({ state, toast, load, openItem } = context);
  }

  // ---------- Mediabibliotheek ----------
  /**
   * Haalt de mediabibliotheek op en tekent hem.
   * @returns {Promise<void>}
   */
  async function loadMedia() {
    state.media = await api('stock/images');
    renderMedia();
  }

  /** Tekent de mediabibliotheek: een raster met alle afbeeldingen (gefilterd op de zoekterm) of de lijst met artikelen zonder afbeelding. */
  function renderMedia() {
    if (!state.media) return;
    const term = $('#m-search').value.trim().toLowerCase();
    const onlyMissing = $('#m-missing').checked;
    /**
     * Of een tekst de zoekterm bevat.
     * @param {string} text de tekst
     * @returns {boolean} true bij een treffer
     */
    const matches = (text) => String(text).toLowerCase().includes(term);
    const images = state.media.images.filter((image) => !term || matches(image.name) || image.items.some((item) => matches(item.code) || matches(item.name)));
    const missing = state.media.missing.filter((item) => !term || matches(item.code) || matches(item.name));
    $('#m-grid').hidden = onlyMissing;
    $('#m-missing-table').hidden = !onlyMissing;
    $('#m-count').textContent = onlyMissing ? `${missing.length} artikel${missing.length === 1 ? '' : 'en'} zonder afbeelding` : `${images.length} afbeelding${images.length === 1 ? '' : 'en'} · ${state.media.missing.length} artikel${state.media.missing.length === 1 ? '' : 'en'} zonder`;
    $('#m-grid').innerHTML = images.length ? images.map((image) => {
      const first = image.items[0];
      const label = image.items.length ? `${esc(first.code)}${image.items.length > 1 ? ` +${image.items.length - 1}` : ''}` : 'Niet in gebruik';
      return `<figure class="media-card"><a href="${first ? `./?id=${encodeURIComponent(first.id)}` : '#'}" ${first ? `data-open="${esc(first.id)}"` : ''}><img src="${esc(window.ItemImages.src(image.id))}" alt="" loading="lazy"></a>
        <figcaption><b title="${esc(image.items.map((item) => `${item.code} ${item.name}`).join('\n'))}">${label}</b><span class="muted small">${esc(image.width)}×${esc(image.height)} · ${esc(Math.round(image.size / 1024))} kB</span>${image.sourceUrl ? `<span class="muted small" title="${esc(image.sourceUrl)}">van oude webshop</span>` : ''}</figcaption></figure>`;
    }).join('') : '<p class="muted">Nog geen afbeeldingen. Upload ze bij een artikel of neem ze over uit de webshop.</p>';
    $('#m-missing-table').innerHTML = missing.length ? `<thead><tr><th>Code</th><th>Omschrijving</th></tr></thead><tbody>${missing.map((item) => `<tr data-id="${esc(item.id)}"><td class="code"><a href="./?id=${encodeURIComponent(item.id)}">${esc(item.code)}</a></td><td class="wrap">${esc(item.name)}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Alle artikelen hebben een afbeelding.</td></tr></tbody>';
  }

  /** Koppelt de zoekbalk, het filter en het openen van een artikel in de mediabibliotheek. */
  function setupMedia() {
    $('#m-search').oninput = renderMedia;
    $('#m-missing').onchange = renderMedia;
    /**
     * Opent het artikel bij een klik op een afbeelding of een regel zonder afbeelding.
     * @param {MouseEvent} event de klik
     */
    $('#tab-media').onclick = (event) => {
      const target = event.target.closest('[data-open], tr[data-id]');
      if (!target || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      openItem(target.dataset.open || target.dataset.id, true);
    };
  }

  /** Tekent het blok Afbeelding van het geopende artikel. */
  function renderImage() {
    const item = state.item;
    $('#d-image-view').innerHTML = item.imageId ? `<img src="${esc(window.ItemImages.src(item.imageId))}" alt="">` : '<span class="muted small">Geen afbeelding</span>';
    $('#d-image-remove').hidden = !item.imageId;
    $('#d-image-file').value = '';
    $('.err', $('#d-image')).textContent = '';
  }

  /** Koppelt het uploaden en verwijderen van de afbeelding van een artikel. */
  function setupImage() {
    const errorBox = $('.err', $('#d-image'));
    /** Verkleint en uploadt de gekozen afbeelding. */
    $('#d-image-file').onchange = async () => {
      const file = $('#d-image-file').files && $('#d-image-file').files[0];
      if (!file) return;
      errorBox.textContent = '';
      try {
        state.item.imageId = await window.ItemImages.upload(state.item.id, await window.ItemImages.prepare(file));
        toast('Afbeelding opgeslagen');
      } catch (error) { errorBox.textContent = error.message; }
      renderImage();
    };
    /** Haalt de afbeelding weg. */
    $('#d-image-remove').onclick = async () => {
      errorBox.textContent = '';
      try {
        await window.ItemImages.remove(state.item.id);
        state.item.imageId = null;
        toast('Afbeelding verwijderd');
      } catch (error) { errorBox.textContent = error.message; }
      renderImage();
    };
  }

  // ---------- Afbeeldingen uit de webshop ----------
  /** Opent het venster om de afbeeldingen van de webshop over te nemen en toont hoeveel er nog te doen is. */
  async function openImagesImport() {
    const dialog = $('#images-dialog');
    $('#images-failed').hidden = true;
    $('#images-bar').value = 0;
    $('#images-start').hidden = true;
    $('#images-text').textContent = 'Controleren…';
    dialog.showModal();
    try {
      const [pendingCount, thumbCount] = await Promise.all([window.ItemImages.pending(), window.ItemImages.thumbsPending()]);
      const lines = [];
      if (pendingCount) lines.push(`${pendingCount} artikel${pendingCount === 1 ? '' : 'en'} gebruik${pendingCount === 1 ? 't' : 'en'} nog de afbeelding van de oude webshop. Overnemen bewaart ze in dit systeem; opnieuw uitvoeren neemt alleen over wat nog ontbreekt.`);
      if (thumbCount) lines.push(`${thumbCount} afbeelding${thumbCount === 1 ? '' : 'en'} ${thumbCount === 1 ? 'heeft' : 'hebben'} nog geen miniatuur. Miniaturen maken de webshop op telefoons en bij veel producten sneller; ze worden hier in uw browser gemaakt.`);
      $('#images-text').textContent = lines.length ? lines.join(' ') : 'Alle afbeeldingen staan in dit systeem en hebben een miniatuur.';
      $('#images-start').hidden = !lines.length;
      $('#images-start').dataset.total = String(pendingCount);
      $('#images-start').dataset.thumbs = String(thumbCount);
    } catch (error) {
      $('#images-text').textContent = `Controleren mislukt: ${error.message}`;
    }
  }

  /** Koppelt de knoppen van het venster Afbeeldingen uit de webshop. */
  function setupImagesImport() {
    /** Sluit het venster. */
    $('#images-close').onclick = () => { $('#images-dialog').close(); };
    /** Neemt de afbeeldingen over met een voortgangsbalk. */
    $('#images-start').onclick = async () => {
      const total = Number($('#images-start').dataset.total) || 0;
      $('#images-start').hidden = true;
      $('#images-close').disabled = true;
      try {
        const totals = total ? await window.ItemImages.importAll((progress) => {
          $('#images-bar').value = Math.min(1, (total - progress.pending) / total);
          $('#images-text').textContent = `${progress.imported + progress.reused} artikelen gekoppeld, ${progress.stored} afbeeldingen bewaard…`;
        }) : { imported: 0, reused: 0, stored: 0, failed: [] };
        // Daarna de miniaturen (ook voor de zojuist overgenomen afbeeldingen).
        const thumbTotal = await window.ItemImages.thumbsPending();
        $('#images-bar').value = 0;
        const thumbs = thumbTotal ? await window.ItemImages.thumbsAll((progress) => {
          $('#images-bar').value = Math.min(1, (progress.done + progress.failed) / thumbTotal);
          $('#images-text').textContent = `Miniaturen maken: ${progress.done} van ${thumbTotal}…`;
        }) : { done: 0, failed: 0 };
        $('#images-bar').value = 1;
        const linked = totals.imported + totals.reused;
        $('#images-text').textContent = `Klaar: ${linked} artikel${linked === 1 ? '' : 'en'} gekoppeld; ${totals.stored} nieuwe afbeelding${totals.stored === 1 ? '' : 'en'} bewaard; ${thumbs.done} miniatuur${thumbs.done === 1 ? '' : 'en'} gemaakt${totals.failed.length || thumbs.failed ? `. ${totals.failed.length + thumbs.failed} niet gelukt (opnieuw uitvoeren probeert ze nog eens)` : ''}.`;
        if (totals.failed.length) {
          $('#images-failed').hidden = false;
          $('#images-failed').innerHTML = `Niet gelukt (opnieuw uitvoeren probeert ze nog eens):<br>${totals.failed.slice(0, 20).map((failure) => `${esc(failure.code)}: ${esc(failure.reason)}`).join('<br>')}${totals.failed.length > 20 ? `<br>… en ${totals.failed.length - 20} meer` : ''}`;
        }
        await load();
      } catch (error) {
        $('#images-text').textContent = `Overnemen mislukt: ${error.message}`;
        $('#images-start').hidden = false;
      } finally {
        $('#images-close').disabled = false;
      }
    };
  }

  /** Koppelt de bediening van de mediabibliotheek, de afbeelding van een artikel en het overnemen uit de webshop. */
  function setupAll() {
    setupMedia();
    setupImagesImport();
    setupImage();
  }

  window.ArtikelenMedia = { setup, setupAll, loadMedia, renderMedia, renderImage, openImagesImport };
})();
