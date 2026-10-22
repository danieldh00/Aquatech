// Foto's bij een werkorder: maken met de camera van de telefoon of kiezen uit
// de galerij, verkleinen in de browser (max. 2048 px, JPEG; daarmee vallen ook
// EXIF en GPS-locatie weg), uploaden naar /api/workorders/:id/photos en tonen
// per fase (voor, tijdens, oplevering). Per foto een bijschrift en of de klant
// hem in het klantportaal ziet. PhotoViewer (vergroting met vorige/volgende)
// gebruikt ook de module Klantdossier.
(function () {
  const KINDS = { voor: 'Voor', tijdens: 'Tijdens', oplevering: 'Oplevering' };
  const MAX_SIDE = 2048;
  const THUMB_SIDE = 480;
  const MAX_BYTES = 3.8 * 1024 * 1024;
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15" (leeg zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');

  // ---------- Vergroting ----------
  const Viewer = {
    overlay: null, list: [], index: 0,
    /** Maakt het vergrotingsvenster (één keer), met knoppen, toetsen en vegen. */
    build() {
      if (this.overlay) return;
      const overlay = document.createElement('div');
      overlay.className = 'ph-viewer';
      overlay.hidden = true;
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Foto');
      overlay.innerHTML = '<a class="ph-open" target="_blank" rel="noopener">Origineel openen</a><button class="ph-close" title="Sluiten (Esc)">✕</button><button class="ph-prev" title="Vorige">‹</button><button class="ph-next" title="Volgende">›</button><img alt=""><div class="ph-vcap"></div>';
      document.body.appendChild(overlay);
      /**
       * Sluit de vergroting.
       * @returns {void}
       */
      overlay.querySelector('.ph-close').onclick = () => this.hide();
      /**
       * Vorige foto.
       * @returns {void}
       */
      overlay.querySelector('.ph-prev').onclick = () => this.step(-1);
      /**
       * Volgende foto.
       * @returns {void}
       */
      overlay.querySelector('.ph-next').onclick = () => this.step(1);
      /**
       * Sluit bij een klik naast de foto.
       * @param {MouseEvent} event De klik.
       */
      overlay.onclick = (event) => { if (event.target === overlay) this.hide(); };
      document.addEventListener('keydown', (event) => {
        if (overlay.hidden) return;
        if (event.key === 'Escape') this.hide();
        if (event.key === 'ArrowLeft') this.step(-1);
        if (event.key === 'ArrowRight') this.step(1);
      });
      // Vegen op een telefoon.
      let touchStartX = null;
      overlay.addEventListener('touchstart', (event) => { touchStartX = event.touches[0].clientX; }, { passive: true });
      overlay.addEventListener('touchend', (event) => {
        if (touchStartX === null) return;
        const distance = event.changedTouches[0].clientX - touchStartX;
        if (Math.abs(distance) > 50) this.step(distance < 0 ? 1 : -1);
        touchStartX = null;
      });
      this.overlay = overlay;
    },
    /**
     * Toont de vergroting.
     * @param {Array<{src: string, caption: string, sub: string}>} list De foto's.
     * @param {number} [index] Welke foto eerst.
     */
    show(list, index = 0) {
      this.build();
      this.list = list;
      this.index = index;
      this.overlay.hidden = false;
      this.render();
    },
    /**
     * Bladert naar de vorige of volgende foto (rondom).
     * @param {number} direction -1 = vorige, 1 = volgende.
     */
    step(direction) {
      if (!this.list.length) return;
      this.index = (this.index + direction + this.list.length) % this.list.length;
      this.render();
    },
    /** Toont de huidige foto met bijschrift en teller. */
    render() {
      const photo = this.list[this.index];
      this.overlay.querySelector('img').src = photo.src;
      this.overlay.querySelector('a.ph-open').href = photo.src;
      this.overlay.querySelector('.ph-vcap').innerHTML = `${esc(photo.caption || '')}<span class="sub">${esc(photo.sub || '')}${this.list.length > 1 ? ` · ${this.index + 1} van ${this.list.length}` : ''}</span>`;
      const hasMore = this.list.length > 1;
      this.overlay.querySelector('.ph-prev').hidden = !hasMore;
      this.overlay.querySelector('.ph-next').hidden = !hasMore;
    },
    /** Sluit de vergroting en laat de afbeelding los. */
    hide() { if (this.overlay) { this.overlay.hidden = true; this.overlay.querySelector('img').removeAttribute('src'); } },
  };

  // ---------- Verkleinen ----------
  /**
   * Leest een afbeeldingsbestand in (met de juiste draaiing als de browser dat kan).
   * @param {File} file Het bestand.
   * @returns {Promise<ImageBitmap|HTMLImageElement>} De afbeelding.
   */
  async function decode(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (error) { /* val terug op <img> */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  /**
   * Verkleint een afbeelding tot hoogstens side pixels en maakt er een JPEG van (op wit).
   * @param {ImageBitmap|HTMLImageElement} source De afbeelding.
   * @param {number} side Maximale lengte van de langste zijde.
   * @param {number} quality JPEG-kwaliteit (0–1).
   * @returns {string} De JPEG als base64 (zonder data:-voorvoegsel).
   */
  function encode(source, side, quality) {
    const width = source.width, height = source.height;
    const scale = Math.min(1, side / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality).split(',')[1];
  }

  /**
   * Bestand → { image, thumb } (base64 JPEG), klein genoeg voor de server.
   * @param {File} file Het bestand.
   * @returns {Promise<{image: string, thumb: string}>} Foto en miniatuur.
   */
  async function prepare(file) {
    const source = await decode(file);
    let quality = 0.85;
    let image = encode(source, MAX_SIDE, quality);
    while (image.length * 0.75 > MAX_BYTES && quality > 0.4) {
      quality -= 0.15;
      image = encode(source, MAX_SIDE * (quality < 0.6 ? 0.75 : 1), quality);
    }
    const thumb = encode(source, THUMB_SIDE, 0.75);
    if (source.close) source.close();
    return { image, thumb };
  }

  // ---------- Galerij bij een werkorder ----------
  // pending: foto's die offline zijn gemaakt en nog in de wachtrij staan
  // ({ queueId, thumb (data-URL), kind, customerVisible, takenAt }).
  const state = { workOrder: null, items: [], pending: [], max: 100, options: {}, busy: false };
  /**
   * De offline-API van shared/offline.js (als die geladen is).
   * @returns {object|undefined} window.AquatechOffline.
   */
  const offlineApi = () => window.AquatechOffline;
  /**
   * Zoekt het eerste element bij een CSS-selector.
   * @param {string} selector CSS-selector.
   * @returns {Element|null} Het element.
   */
  const $ = (sel) => document.querySelector(sel);
  /**
   * Relatief pad naar de app-root.
   * @returns {string} Bijv. "../".
   */
  const base = () => state.options.base || '../';
  /**
   * Toont een melding via de pagina (of in de console).
   * @param {string} message De melding.
   * @param {boolean} [isError] true = foutmelding.
   * @returns {*} Wat de toast teruggeeft.
   */
  const toast = (message, isError) => (state.options.toast ? state.options.toast(message, isError) : console[isError ? 'error' : 'log'](message));

  /**
   * Roept de API aan; met `offline` mag de wijziging zonder verbinding in de wachtrij.
   * @param {string} path Pad vanaf de app-root.
   * @param {object} [options] { method, body, offline }.
   * @returns {Promise<object>} Het antwoord (202 { queued } als het in de wachtrij staat).
   */
  async function call(path, { method = 'GET', body, offline } = {}) {
    const offlineHeaders = offline && offlineApi() ? offlineApi().headers(offline) : {};
    const res = await fetch(`${base()}${path}`, {
      method, cache: 'no-store',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...offlineHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || (res.status === 413 ? 'De foto is te groot.' : `HTTP ${res.status}`));
    return out;
  }

  /**
   * Standaardfase volgt de status van de werkorder.
   * @returns {string} "voor", "tijdens" of "oplevering".
   */
  function defaultKind() {
    const status = state.options.statusOf ? state.options.statusOf() : (state.workOrder && state.workOrder.status);
    return status === 'gereed' ? 'oplevering' : status === 'bezig' ? 'tijdens' : 'voor';
  }

  /**
   * Tegel voor een foto met bijschrift, fase, zichtbaarheid en verwijderen.
   * @param {object} photo De foto.
   * @returns {string} HTML.
   */
  function tile(photo) {
    const optionsHtml = Object.entries(KINDS).map(([key, label]) => `<option value="${key}"${key === photo.kind ? ' selected' : ''}>${label}</option>`).join('');
    return `<div class="ph-tile${photo.customerVisible ? '' : ' hidden-for-customer'}" data-id="${esc(photo.id)}">
      <span class="ph-badge${photo.customerVisible ? '' : ' off'}">${photo.customerVisible ? 'Klant ziet dit' : 'Alleen intern'}</span>
      <button class="ph-img" type="button" title="Vergroten"><img loading="lazy" src="${esc(base() + photo.thumbUrl)}" alt="${esc(photo.caption || KINDS[photo.kind])}"></button>
      <div class="ph-meta">
        <input class="cap" maxlength="300" placeholder="Bijschrift" value="${esc(photo.caption)}">
        <div class="ph-row">
          <select class="kind" title="Fase">${optionsHtml}</select>
          <button class="btn small ghost del danger" type="button" title="Foto verwijderen">🗑</button>
        </div>
        <label class="ph-vis" title="Zichtbaar in het klantportaal en in het opleverrapport voor de klant"><input type="checkbox" class="vis"${photo.customerVisible ? ' checked' : ''}> Zichtbaar voor de klant</label>
        <span>${esc(when(photo.takenAt || photo.createdAt))}${photo.uploadedBy ? ` · ${esc(photo.uploadedBy.displayName)}` : ''}</span>
      </div>
    </div>`;
  }

  /**
   * Tegel voor een offline gemaakte foto die nog niet verstuurd is (alleen tonen).
   * @param {object} photo { queueId, thumb, kind, customerVisible, takenAt }.
   * @returns {string} HTML.
   */
  function pendingTile(photo) {
    return `<div class="ph-tile pending" data-queue="${esc(photo.queueId)}">
      <span class="ph-badge wait">Wacht op verbinding</span>
      <span class="ph-img"><img src="${esc(photo.thumb)}" alt="${esc(KINDS[photo.kind] || 'Foto')}"></span>
      <div class="ph-meta"><span>${esc(KINDS[photo.kind] || '')} · ${esc(when(photo.takenAt))}${photo.customerVisible ? ' · zichtbaar voor de klant' : ' · alleen intern'}</span></div>
    </div>`;
  }

  /** Tekent de galerij per fase, met de nog te versturen foto's erachter. */
  function render() {
    const box = $('#ph-gallery');
    if (!box) return;
    const total = state.items.length + state.pending.length;
    $('#ph-count').textContent = total ? `${total} foto${total === 1 ? '' : "'s"}${state.pending.length ? ` (${state.pending.length} nog te versturen)` : ''}` : '';
    const waiting = state.pending.length ? `<div class="ph-group">Nog te versturen (${state.pending.length})</div><div class="ph-grid">${state.pending.map(pendingTile).join('')}</div>` : '';
    if (!state.items.length) {
      if (waiting) { box.innerHTML = waiting; return; }
      box.innerHTML = '<p class="ph-empty">Nog geen foto\'s. Leg vast hoe de tuin eruitzag, hoe de leidingen liggen en hoe de installatie is opgeleverd.</p>';
      return;
    }
    box.innerHTML = Object.entries(KINDS).map(([key, label]) => {
      const list = state.items.filter((photo) => photo.kind === key);
      return list.length ? `<div class="ph-group">${label} (${list.length})</div><div class="ph-grid">${list.map(tile).join('')}</div>` : '';
    }).join('') + waiting;
  }

  /**
   * Foto's in de volgorde van de galerij (per fase).
   * @returns {object[]} De foto's.
   */
  const ordered = () => Object.keys(KINDS).flatMap((key) => state.items.filter((photo) => photo.kind === key));

  /**
   * API-pad van de foto's van een werkorder.
   * @param {object} workOrder De werkorder.
   * @returns {string} Het pad.
   */
  const photosUrl = (workOrder) => `api/workorders/${encodeURIComponent(workOrder.id)}/photos`;

  /**
   * Haalt de foto's en de wachtende uploads op en tekent de galerij.
   * @returns {Promise<void>}
   */
  async function load() {
    const workOrder = state.workOrder;
    const [out, queued] = await Promise.all([
      call(photosUrl(workOrder)).catch((error) => ({ error })),
      offlineApi() ? offlineApi().list({ prefix: photosUrl(workOrder), method: 'POST' }) : [],
    ]);
    if (state.workOrder !== workOrder) return;
    if (out.error) {
      state.items = [];
      if (navigator.onLine) toast(`Foto's laden mislukt: ${out.error.message}`, true);
    } else {
      state.items = out.items || [];
      state.max = out.max || 100;
    }
    state.pending = queued.filter((item) => item.url === photosUrl(workOrder)).map(fromQueue).filter(Boolean);
    render();
  }

  /**
   * Wachtende upload uit de offline wachtrij als tegel.
   * @param {object} item Wijziging uit de wachtrij.
   * @returns {object|null} { queueId, thumb, kind, customerVisible, takenAt }, of null bij een kapotte body.
   */
  function fromQueue(item) {
    try {
      const body = JSON.parse(item.body);
      return { queueId: item.id, thumb: `data:image/jpeg;base64,${body.thumb}`, kind: body.kind, customerVisible: body.customerVisible !== false, takenAt: body.takenAt || new Date(item.createdAt).toISOString() };
    } catch (error) { return null; }
  }

  /**
   * Verkleint en uploadt gekozen foto's één voor één (zonder bereik in de wachtrij).
   * @param {FileList|File[]} files De bestanden.
   * @returns {Promise<void>}
   */
  async function upload(files) {
    const list = [...files].filter((file) => /^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name));
    if (!list.length || !state.workOrder) return;
    const workOrder = state.workOrder;
    const kind = $('#ph-kind').value;
    const visible = $('#ph-visible').checked;
    const status = $('#ph-status');
    let uploaded = 0;
    let queuedCount = 0;
    state.busy = true;
    for (let i = 0; i < list.length; i++) {
      if (state.items.length + state.pending.length >= state.max) { toast(`Maximaal ${state.max} foto's per werkorder.`, true); break; }
      status.textContent = `Foto ${i + 1} van ${list.length} verwerken…`;
      try {
        const { image, thumb } = await prepare(list[i]);
        status.textContent = `Foto ${i + 1} van ${list.length} uploaden…`;
        const takenAt = list[i].lastModified ? new Date(list[i].lastModified).toISOString() : undefined;
        const photo = await call(photosUrl(workOrder), {
          method: 'POST', body: { image, thumb, kind, customerVisible: visible, takenAt },
          // Zonder bereik: op het toestel bewaren en later versturen.
          offline: { label: `Foto bij ${workOrder.number || 'werkorder'}` },
        });
        if (photo.queued) {
          queuedCount++;
          if (state.workOrder === workOrder) { state.pending.push({ queueId: photo.id, thumb: `data:image/jpeg;base64,${thumb}`, kind, customerVisible: visible, takenAt: takenAt || new Date().toISOString() }); render(); }
          continue;
        }
        if (state.workOrder === workOrder) { state.items.push(photo); render(); }
        uploaded++;
      } catch (error) {
        toast(`${list[i].name || 'Foto'}: ${/decode|source image|EncodingError/i.test(error.message) ? 'dit formaat kan de browser niet lezen' : error.message}`, true);
      }
    }
    state.busy = false;
    status.textContent = '';
    if (uploaded) toast(`${uploaded} foto${uploaded === 1 ? '' : "'s"} toegevoegd`);
    if (queuedCount) toast(`${queuedCount} foto${queuedCount === 1 ? '' : "'s"} bewaard op dit toestel; ${queuedCount === 1 ? 'wordt' : 'worden'} verstuurd zodra er verbinding is`);
  }

  /**
   * Slaat bijschrift, fase of zichtbaarheid van een foto op.
   * @param {string} id Id van de foto.
   * @param {object} body De gewijzigde velden.
   * @returns {Promise<void>}
   */
  async function patch(id, body) {
    try {
      const updated = await call(`api/workorders/${encodeURIComponent(state.workOrder.id)}/photos/${encodeURIComponent(id)}`, {
        method: 'PATCH', body, offline: { key: `photo:${id}`, label: `Foto bij ${state.workOrder.number || 'werkorder'} (bijschrift/fase)` },
      });
      const index = state.items.findIndex((photo) => photo.id === id);
      if (index >= 0) state.items[index] = updated.queued ? { ...state.items[index], ...body } : updated;
      if (body.kind !== undefined || body.customerVisible !== undefined) render();
    } catch (error) {
      toast(`Opslaan mislukt: ${error.message}`, true);
    }
  }

  /** Koppelt knoppen, bestandsvelden, klikken in de galerij en slepen (één keer). */
  function bind() {
    if (bind.done) return;
    bind.done = true;
    $('#ph-kind').innerHTML = Object.entries(KINDS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
    /**
     * Opent de camera.
     * @returns {void}
     */
    $('#ph-camera').onclick = () => $('#ph-file-camera').click();
    /**
     * Opent de galerij van het toestel.
     * @returns {void}
     */
    $('#ph-pick').onclick = () => $('#ph-file-pick').click();
    for (const id of ['#ph-file-camera', '#ph-file-pick']) {
      /**
       * Uploadt de gekozen bestanden en maakt het veld leeg.
       * @param {Event} event De wijziging.
       * @returns {Promise<void>}
       */
      $(id).onchange = async (event) => { const files = [...event.target.files]; event.target.value = ''; await upload(files); };
    }
    const box = $('#ph-gallery');
    box.addEventListener('click', (event) => {
      const tile = event.target.closest('.ph-tile');
      if (!tile) return;
      const id = tile.dataset.id;
      if (event.target.closest('.ph-img')) {
        const list = ordered();
        Viewer.show(list.map((photo) => ({ src: base() + photo.url, caption: photo.caption || KINDS[photo.kind], sub: [KINDS[photo.kind], when(photo.takenAt || photo.createdAt), photo.customerVisible ? 'zichtbaar voor de klant' : 'alleen intern'].filter(Boolean).join(' · ') })),
          list.findIndex((photo) => photo.id === id));
      } else if (event.target.closest('.del')) {
        if (!confirm('Deze foto verwijderen? Dit kan niet ongedaan worden gemaakt.')) return;
        call(`api/workorders/${encodeURIComponent(state.workOrder.id)}/photos/${encodeURIComponent(id)}`, { method: 'DELETE' })
          .then(() => { state.items = state.items.filter((photo) => photo.id !== id); render(); toast('Foto verwijderd'); })
          .catch((error) => toast(`Verwijderen mislukt: ${error.message}`, true));
      }
    });
    box.addEventListener('change', (event) => {
      const tile = event.target.closest('.ph-tile');
      if (!tile) return;
      if (event.target.classList.contains('cap')) patch(tile.dataset.id, { caption: event.target.value });
      if (event.target.classList.contains('kind')) patch(tile.dataset.id, { kind: event.target.value });
      if (event.target.classList.contains('vis')) patch(tile.dataset.id, { customerVisible: event.target.checked });
    });
    const statusSelect = document.querySelector('#e-status');
    if (statusSelect) statusSelect.addEventListener('change', () => { $('#ph-kind').value = defaultKind(); });
    // Slepen van foto's op de kaart (computer).
    const card = $('#ph-card');
    card.addEventListener('dragover', (event) => { if (event.dataTransfer && [...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
    card.addEventListener('drop', (event) => { if (event.dataTransfer && event.dataTransfer.files.length) { event.preventDefault(); upload(event.dataTransfer.files); } });
  }

  /**
   * Werkorder geopend: galerij laden.
   * @param {object} workOrder De werkorder.
   * @param {object} [options] { base, toast, statusOf }.
   */
  function open(workOrder, options = {}) {
    if (!$('#ph-gallery')) return;
    state.options = options;
    state.workOrder = workOrder;
    state.items = [];
    state.pending = [];
    bind();
    $('#ph-kind').value = defaultKind();
    $('#ph-visible').checked = true;
    $('#ph-gallery').innerHTML = '<p class="ph-empty">Foto\'s laden…</p>';
    load();
  }

  // Offline gemaakte foto verstuurd: uit "nog te versturen" naar de galerij.
  if (window.AquatechOffline) {
    window.AquatechOffline.on('synced', (message) => {
      const workOrder = state.workOrder;
      const queueId = message.item ? message.item.id : message.id;
      if (!workOrder || !queueId) return;
      const index = state.pending.findIndex((photo) => photo.queueId === queueId);
      if (index < 0) return;
      state.pending.splice(index, 1);
      if (!message.discarded && message.body && message.body.id && !state.items.some((photo) => photo.id === message.body.id)) state.items.push(message.body);
      render();
    });
  }

  window.WorkOrderPhotos = { open, prepare, KINDS, busy: () => state.busy };
  window.PhotoViewer = Viewer;
})();
