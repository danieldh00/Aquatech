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
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');

  // ---------- Vergroting ----------
  const Viewer = {
    el: null, list: [], i: 0,
    build() {
      if (this.el) return;
      const el = document.createElement('div');
      el.className = 'ph-viewer';
      el.hidden = true;
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Foto');
      el.innerHTML = '<a class="ph-open" target="_blank" rel="noopener">Origineel openen</a><button class="ph-close" title="Sluiten (Esc)">✕</button><button class="ph-prev" title="Vorige">‹</button><button class="ph-next" title="Volgende">›</button><img alt=""><div class="ph-vcap"></div>';
      document.body.appendChild(el);
      el.querySelector('.ph-close').onclick = () => this.hide();
      el.querySelector('.ph-prev').onclick = () => this.step(-1);
      el.querySelector('.ph-next').onclick = () => this.step(1);
      el.onclick = (e) => { if (e.target === el) this.hide(); };
      document.addEventListener('keydown', (e) => {
        if (el.hidden) return;
        if (e.key === 'Escape') this.hide();
        if (e.key === 'ArrowLeft') this.step(-1);
        if (e.key === 'ArrowRight') this.step(1);
      });
      // Vegen op een telefoon.
      let x0 = null;
      el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
      el.addEventListener('touchend', (e) => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0;
        if (Math.abs(dx) > 50) this.step(dx < 0 ? 1 : -1);
        x0 = null;
      });
      this.el = el;
    },
    /** list: [{ src, caption, sub }] */
    show(list, i = 0) {
      this.build();
      this.list = list;
      this.i = i;
      this.el.hidden = false;
      this.render();
    },
    step(d) {
      if (!this.list.length) return;
      this.i = (this.i + d + this.list.length) % this.list.length;
      this.render();
    },
    render() {
      const p = this.list[this.i];
      this.el.querySelector('img').src = p.src;
      this.el.querySelector('a.ph-open').href = p.src;
      this.el.querySelector('.ph-vcap').innerHTML = `${esc(p.caption || '')}<span class="sub">${esc(p.sub || '')}${this.list.length > 1 ? ` · ${this.i + 1} van ${this.list.length}` : ''}</span>`;
      const multi = this.list.length > 1;
      this.el.querySelector('.ph-prev').hidden = !multi;
      this.el.querySelector('.ph-next').hidden = !multi;
    },
    hide() { if (this.el) { this.el.hidden = true; this.el.querySelector('img').removeAttribute('src'); } },
  };

  // ---------- Verkleinen ----------
  async function decode(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* val terug op <img> */ }
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

  function encode(src, side, quality) {
    const w0 = src.width, h0 = src.height;
    const k = Math.min(1, side / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * k));
    c.height = Math.max(1, Math.round(h0 * k));
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality).split(',')[1];
  }

  /** Bestand → { image, thumb } (base64 JPEG), klein genoeg voor de server. */
  async function prepare(file) {
    const src = await decode(file);
    let quality = 0.85;
    let image = encode(src, MAX_SIDE, quality);
    while (image.length * 0.75 > MAX_BYTES && quality > 0.4) {
      quality -= 0.15;
      image = encode(src, MAX_SIDE * (quality < 0.6 ? 0.75 : 1), quality);
    }
    const thumb = encode(src, THUMB_SIDE, 0.75);
    if (src.close) src.close();
    return { image, thumb };
  }

  // ---------- Galerij bij een werkorder ----------
  const state = { wo: null, items: [], max: 100, opts: {}, busy: false };
  const $ = (sel) => document.querySelector(sel);
  const base = () => state.opts.base || '../';
  const toast = (msg, err) => (state.opts.toast ? state.opts.toast(msg, err) : console[err ? 'error' : 'log'](msg));

  async function call(url, { method = 'GET', body } = {}) {
    const res = await fetch(`${base()}${url}`, {
      method, cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || (res.status === 413 ? 'De foto is te groot.' : `HTTP ${res.status}`));
    return out;
  }

  // Standaardfase volgt de status van de werkorder.
  function defaultKind() {
    const st = state.opts.statusOf ? state.opts.statusOf() : (state.wo && state.wo.status);
    return st === 'gereed' ? 'oplevering' : st === 'bezig' ? 'tijdens' : 'voor';
  }

  function tile(p) {
    const opts = Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === p.kind ? ' selected' : ''}>${v}</option>`).join('');
    return `<div class="ph-tile${p.customerVisible ? '' : ' hidden-for-customer'}" data-id="${esc(p.id)}">
      <span class="ph-badge${p.customerVisible ? '' : ' off'}">${p.customerVisible ? 'Klant ziet dit' : 'Alleen intern'}</span>
      <button class="ph-img" type="button" title="Vergroten"><img loading="lazy" src="${esc(base() + p.thumbUrl)}" alt="${esc(p.caption || KINDS[p.kind])}"></button>
      <div class="ph-meta">
        <input class="cap" maxlength="300" placeholder="Bijschrift" value="${esc(p.caption)}">
        <div class="ph-row">
          <select class="kind" title="Fase">${opts}</select>
          <button class="btn small ghost del danger" type="button" title="Foto verwijderen">🗑</button>
        </div>
        <label class="ph-vis" title="Zichtbaar in het klantportaal en in het opleverrapport voor de klant"><input type="checkbox" class="vis"${p.customerVisible ? ' checked' : ''}> Zichtbaar voor de klant</label>
        <span>${esc(when(p.takenAt || p.createdAt))}${p.uploadedBy ? ` · ${esc(p.uploadedBy.displayName)}` : ''}</span>
      </div>
    </div>`;
  }

  function render() {
    const box = $('#ph-gallery');
    if (!box) return;
    $('#ph-count').textContent = state.items.length ? `${state.items.length} foto${state.items.length === 1 ? '' : "'s"}` : '';
    if (!state.items.length) {
      box.innerHTML = '<p class="ph-empty">Nog geen foto\'s. Leg vast hoe de tuin eruitzag, hoe de leidingen liggen en hoe de installatie is opgeleverd.</p>';
      return;
    }
    box.innerHTML = Object.entries(KINDS).map(([k, label]) => {
      const list = state.items.filter((p) => p.kind === k);
      return list.length ? `<div class="ph-group">${label} (${list.length})</div><div class="ph-grid">${list.map(tile).join('')}</div>` : '';
    }).join('');
  }

  const ordered = () => Object.keys(KINDS).flatMap((k) => state.items.filter((p) => p.kind === k));

  async function load() {
    const wo = state.wo;
    try {
      const out = await call(`api/workorders/${encodeURIComponent(wo.id)}/photos`);
      if (state.wo !== wo) return;
      state.items = out.items || [];
      state.max = out.max || 100;
    } catch (e) {
      state.items = [];
      toast(`Foto's laden mislukt: ${e.message}`, true);
    }
    render();
  }

  async function upload(files) {
    const list = [...files].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!list.length || !state.wo) return;
    const wo = state.wo;
    const kind = $('#ph-kind').value;
    const visible = $('#ph-visible').checked;
    const status = $('#ph-status');
    let ok = 0;
    state.busy = true;
    for (let i = 0; i < list.length; i++) {
      if (state.items.length >= state.max) { toast(`Maximaal ${state.max} foto's per werkorder.`, true); break; }
      status.textContent = `Foto ${i + 1} van ${list.length} verwerken…`;
      try {
        const { image, thumb } = await prepare(list[i]);
        status.textContent = `Foto ${i + 1} van ${list.length} uploaden…`;
        const p = await call(`api/workorders/${encodeURIComponent(wo.id)}/photos`, { method: 'POST', body: {
          image, thumb, kind, customerVisible: visible, takenAt: list[i].lastModified ? new Date(list[i].lastModified).toISOString() : undefined,
        } });
        if (state.wo === wo) { state.items.push(p); render(); }
        ok++;
      } catch (e) {
        toast(`${list[i].name || 'Foto'}: ${/decode|source image|EncodingError/i.test(e.message) ? 'dit formaat kan de browser niet lezen' : e.message}`, true);
      }
    }
    state.busy = false;
    status.textContent = '';
    if (ok) toast(`${ok} foto${ok === 1 ? '' : "'s"} toegevoegd`);
  }

  async function patch(id, body) {
    try {
      const p = await call(`api/workorders/${encodeURIComponent(state.wo.id)}/photos/${encodeURIComponent(id)}`, { method: 'PATCH', body });
      const i = state.items.findIndex((x) => x.id === id);
      if (i >= 0) state.items[i] = p;
      if (body.kind !== undefined || body.customerVisible !== undefined) render();
    } catch (e) {
      toast(`Opslaan mislukt: ${e.message}`, true);
    }
  }

  function bind() {
    if (bind.done) return;
    bind.done = true;
    $('#ph-kind').innerHTML = Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    $('#ph-camera').onclick = () => $('#ph-file-camera').click();
    $('#ph-pick').onclick = () => $('#ph-file-pick').click();
    for (const id of ['#ph-file-camera', '#ph-file-pick']) {
      $(id).onchange = async (e) => { const files = [...e.target.files]; e.target.value = ''; await upload(files); };
    }
    const box = $('#ph-gallery');
    box.addEventListener('click', (e) => {
      const t = e.target.closest('.ph-tile');
      if (!t) return;
      const id = t.dataset.id;
      if (e.target.closest('.ph-img')) {
        const list = ordered();
        Viewer.show(list.map((p) => ({ src: base() + p.url, caption: p.caption || KINDS[p.kind], sub: [KINDS[p.kind], when(p.takenAt || p.createdAt), p.customerVisible ? 'zichtbaar voor de klant' : 'alleen intern'].filter(Boolean).join(' · ') })),
          list.findIndex((p) => p.id === id));
      } else if (e.target.closest('.del')) {
        if (!confirm('Deze foto verwijderen? Dit kan niet ongedaan worden gemaakt.')) return;
        call(`api/workorders/${encodeURIComponent(state.wo.id)}/photos/${encodeURIComponent(id)}`, { method: 'DELETE' })
          .then(() => { state.items = state.items.filter((p) => p.id !== id); render(); toast('Foto verwijderd'); })
          .catch((err) => toast(`Verwijderen mislukt: ${err.message}`, true));
      }
    });
    box.addEventListener('change', (e) => {
      const t = e.target.closest('.ph-tile');
      if (!t) return;
      if (e.target.classList.contains('cap')) patch(t.dataset.id, { caption: e.target.value });
      if (e.target.classList.contains('kind')) patch(t.dataset.id, { kind: e.target.value });
      if (e.target.classList.contains('vis')) patch(t.dataset.id, { customerVisible: e.target.checked });
    });
    const st = document.querySelector('#e-status');
    if (st) st.addEventListener('change', () => { $('#ph-kind').value = defaultKind(); });
    // Slepen van foto's op de kaart (computer).
    const card = $('#ph-card');
    card.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    card.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); upload(e.dataTransfer.files); } });
  }

  /** Werkorder geopend: galerij laden. opts: { base, toast, statusOf } */
  function open(wo, opts = {}) {
    if (!$('#ph-gallery')) return;
    state.opts = opts;
    state.wo = wo;
    state.items = [];
    bind();
    $('#ph-kind').value = defaultKind();
    $('#ph-visible').checked = true;
    $('#ph-gallery').innerHTML = '<p class="ph-empty">Foto\'s laden…</p>';
    load();
  }

  window.WorkOrderPhotos = { open, prepare, KINDS, busy: () => state.busy };
  window.PhotoViewer = Viewer;
})();
