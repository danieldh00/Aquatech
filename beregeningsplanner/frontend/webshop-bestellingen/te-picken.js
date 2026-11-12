// Webshopbestellingen (Verkoop) > Te picken: de bestellingen die klaarstaan om uit het magazijn te pakken (status Nieuw,
// bij online betalen alleen de betaalde) met één knop om alle pakbonnen in één PDF af te drukken
// (API /api/admin/web-orders/to-pick en /packing-slips, zie backend/src/webshop/packing-slips.js).
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
  /**
   * Datum en tijd in het Nederlands.
   * @param {string} iso Tijdstip als ISO-tekst.
   * @returns {string} Bijv. "22 okt 2026 10:15" (– zonder tijdstip).
   */
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  /** Hoogstens zoveel pakbonnen in één PDF (gelijk aan de server). */
  const MAX_SLIPS = 50;
  const state = { items: [], selected: new Set(), truncated: false };
  /** Toont een melding; wordt door init vervangen door die van Beheer. */
  let toast = () => {};

  /**
   * Haalt een PDF op bij de server en biedt hem als download aan.
   * @param {string} path Pad onder api/admin/web-orders.
   * @param {object} [requestOptions] Opties voor fetch; `body` wordt als JSON verstuurd.
   * @returns {Promise<void>} Klaar als de download is gestart (fout = Error met de melding van de server).
   */
  async function downloadPdf(path, requestOptions = {}) {
    const res = await fetch(`../api/admin/web-orders${path}`, {
      cache: 'no-store', ...requestOptions,
      headers: requestOptions.body ? { 'Content-Type': 'application/json' } : undefined,
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || AquatechCommon.statusMessage(res.status));
    }
    const blob = await res.blob();
    const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = match ? match[1] : 'Pakbonnen.pdf';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  }

  /**
   * Werkt de knoppen en de teller bij op de gekozen bestellingen.
   * @returns {void}
   */
  function renderSelection() {
    const count = state.selected.size;
    $('#tp-print').disabled = count === 0;
    $('#tp-print').textContent = count && count === state.items.length ? `Alles afdrukken (${count})` : `Afdrukken (${count})`;
    $('#tp-count').textContent = state.items.length ? `${state.items.length} te picken · ${count} gekozen${state.truncated ? ` · alleen de oudste ${state.items.length} worden getoond; druk deze af en ververs daarna` : ''}` : '';
    const all = $('#tp-all');
    if (all) all.checked = count > 0 && count === state.items.length;
  }

  /**
   * Haalt de lijst op en tekent hem; alles staat standaard gekozen (hoogstens MAX_SLIPS tegelijk).
   * @returns {Promise<void>}
   */
  async function load() {
    const table = $('#tp-table');
    try {
      const res = await fetch('../api/admin/web-orders/to-pick', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || AquatechCommon.statusMessage(res.status));
      const known = new Set(state.items.map((item) => item.id));
      state.items = body.items;
      state.truncated = !!body.truncated;
      const ids = new Set(state.items.map((item) => item.id));
      // Nieuwe bestellingen worden gekozen; een eerdere keuze blijft staan zolang de bestelling er nog is.
      const next = new Set();
      for (const item of state.items) if (next.size < MAX_SLIPS && (state.selected.has(item.id) || !known.has(item.id))) next.add(item.id);
      state.selected = new Set(Array.from(next).filter((id) => ids.has(id)));
      table.innerHTML = !state.items.length ? '<tr><td class="empty">Niets te picken: er zijn geen nieuwe bestellingen die klaarstaan.</td></tr>'
        : `<thead><tr><th><input type="checkbox" id="tp-all" aria-label="Alles kiezen"></th><th>Nummer</th><th>Besteld</th><th>Klant</th><th>Aflevering</th><th class="num">Regels</th><th class="num">Stuks</th><th>Pakbon</th></tr></thead><tbody>${state.items.map((item) => `
          <tr data-id="${esc(item.id)}"><td><input type="checkbox" data-pick aria-label="Kies ${esc(item.number)}"${state.selected.has(item.id) ? ' checked' : ''}></td><td><a href="?id=${encodeURIComponent(item.id)}#bestellingen">${esc(item.number)}</a>${item.note ? ' <span class="pill analyse" title="Er staat een opmerking van de klant op de pakbon.">Opmerking</span>' : ''}</td><td>${esc(when(item.createdAt))}</td><td>${esc(item.customerName)}</td><td>${item.pickup ? 'Ophalen' : esc(item.shippingLabel)}${!item.pickup && item.address ? `<br><span class="muted small">${esc(item.address)}</span>` : ''}</td><td class="num">${item.lineCount}</td><td class="num">${esc(String(Math.round(item.pieces * 100) / 100))}</td><td>${item.printedAt ? `<span class="muted small">afgedrukt ${esc(when(item.printedAt))}</span>` : '<span class="pill nieuw">nog niet</span>'}</td></tr>`).join('')}</tbody>`;
      for (const box of table.querySelectorAll('[data-pick]')) {
        /**
         * Kiest of ontkiest de bestelling in deze regel (hoogstens MAX_SLIPS tegelijk).
         * @returns {void}
         */
        box.onchange = () => {
          const id = box.closest('tr').dataset.id;
          if (!box.checked) state.selected.delete(id);
          else if (state.selected.size >= MAX_SLIPS) { box.checked = false; toast(`Hoogstens ${MAX_SLIPS} pakbonnen tegelijk.`, true); } else state.selected.add(id);
          renderSelection();
        };
      }
      const all = $('#tp-all');
      if (all) {
        /**
         * Kiest alle bestellingen (de eerste MAX_SLIPS) of ontkiest ze.
         * @returns {void}
         */
        all.onchange = () => {
          state.selected = all.checked ? new Set(state.items.slice(0, MAX_SLIPS).map((item) => item.id)) : new Set();
          for (const box of table.querySelectorAll('[data-pick]')) box.checked = state.selected.has(box.closest('tr').dataset.id);
          renderSelection();
        };
      }
      renderSelection();
    } catch (error) {
      state.items = [];
      state.selected = new Set();
      table.innerHTML = `<tr><td class="empty">Kan de lijst niet laden (${esc(error.message)}).</td></tr>`;
      renderSelection();
    }
  }

  /**
   * Koppelt de knop Afdrukken (één keer, door Beheer).
   * @param {{ toast: Function }} options De melding van Beheer.
   * @returns {void}
   */
  function init(options) {
    toast = options.toast || toast;
    /**
     * Maakt één PDF met de pakbonnen van de gekozen bestellingen en ververst daarna de lijst (de pakbon staat dan als afgedrukt).
     * @returns {Promise<void>}
     */
    $('#tp-print').onclick = async () => {
      const button = $('#tp-print');
      button.disabled = true;
      try {
        await downloadPdf('/packing-slips', { method: 'POST', body: { ids: Array.from(state.selected) } });
        toast('Pakbonnen gemaakt');
        await load();
      } catch (error) { toast(error.message, true); renderSelection(); }
    };
  }

  window.BeheerTePicken = { init, load, downloadPdf };
})();
