// Mijn profiel, blok AI-koppeling: het adres om in Claude of ChatGPT toe te voegen en de apps die nu gekoppeld zijn,
// met een knop om er een in te trekken. API: api/account/connections[/<id>] (backend/src/mcp/oauth-server.js).
(function () {
  /**
   * Zoekt een element op id.
   * @param {string} id Het id.
   * @returns {HTMLElement|null} Het element.
   */
  const $ = (id) => document.getElementById(id);

  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst.
   * @returns {string} De ontsnapte tekst.
   */
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  /**
   * Een datum als "11 nov. 2026".
   * @param {string|null} iso Het tijdstip.
   * @returns {string} De datum, of een streepje.
   */
  const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');

  /**
   * Toont een melding in het blok.
   * @param {string} text De melding.
   * @returns {void}
   */
  const say = (text) => { $('ai-msg').textContent = text; };

  /**
   * Roept de API aan (relatief vanaf profiel/).
   * @param {string} path Pad onder api/.
   * @param {string} [method] HTTP-methode.
   * @returns {Promise<object>} Het antwoord (fout = Error).
   */
  async function api(path, method = 'GET') {
    const res = await fetch(`../api/${path}`, { method, cache: 'no-store' });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(answer.message || window.AquatechCommon.statusMessage(res.status));
    return answer;
  }

  /**
   * Toont de gekoppelde apps.
   * @param {object[]} items De koppelingen.
   * @returns {void}
   */
  function renderList(items) {
    const list = $('ai-list');
    if (!items.length) {
      list.innerHTML = '<li class="empty">Nog geen app gekoppeld.</li>';
      return;
    }
    list.innerHTML = items.map((item) => `<li data-id="${escapeHtml(item.id)}">
      <span><strong>${escapeHtml(item.app || item.host)}</strong>
        <span class="ai-meta">${escapeHtml(item.environment)} · gekoppeld ${escapeHtml(formatDate(item.createdAt))} · laatst gebruikt ${escapeHtml(formatDate(item.lastUsedAt))}</span></span>
      <button class="btn" type="button" data-revoke>Intrekken</button></li>`).join('');
  }

  /**
   * Haalt de koppelingen op en toont het blok (alleen als de koppeling aan staat of er nog apps gekoppeld zijn).
   * @returns {Promise<void>}
   */
  async function load() {
    let answer;
    try {
      answer = await api('account/connections');
    } catch {
      return;
    }
    if (!answer.available && !answer.items.length) return;
    $('f-ai').hidden = false;
    $('ai-setup').hidden = !answer.available;
    $('ai-off').hidden = Boolean(answer.available);
    $('ai-url').value = answer.url || new URL('../mcp', location.href).href;
    renderList(answer.items);
  }

  $('ai-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('ai-url').value);
      say('Adres gekopieerd.');
    } catch {
      $('ai-url').select();
      say('Kopieer het adres met Ctrl+C.');
    }
  });

  $('ai-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-revoke]');
    if (!button) return;
    const id = button.closest('[data-id]').dataset.id;
    button.disabled = true;
    try {
      await api(`account/connections/${encodeURIComponent(id)}`, 'DELETE');
      say('Koppeling ingetrokken. De app kan niet meer namens jou werken.');
      await load();
    } catch (error) {
      button.disabled = false;
      say(error.message);
    }
  });

  load();
})();
