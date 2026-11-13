// Offline werken op de pagina: de wachtrij van de service worker (../sw.js)
// gebruiken en laten zien wat er nog moet worden verstuurd.
//
// AquatechOffline.headers({ key, label, base, patch }) geeft de koppen voor
// een wijziging die zonder verbinding in de wachtrij mag (zie offline-core.js);
// het antwoord is dan 202 { queued: true }. Elke module kan dat gebruiken
// (werkorders, foto's, en later uren en materiaal).
//
// Rechtsonder verschijnt een knopje zodra je offline bent of er iets wacht;
// erop tikken toont de lijst, met bij een conflict of fout de keuze om het
// toch te versturen of weg te gooien.
(function (root) {
  const Core = root.AquatechOfflineCore;
  const common = root.AquatechCommon;
  const serviceWorker = navigator.serviceWorker;
  const supported = Boolean(serviceWorker && root.isSecureContext && common && common.offline && Core && location.protocol !== 'file:');
  /**
   * Maakt tekst veilig voor HTML.
   * @param {*} value De tekst (null/undefined = leeg).
   * @returns {string} De tekst met &, <, >, " en ' als entiteit.
   */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const listeners = { status: [], synced: [] };
  const state = { status: null, open: false, box: null, timer: null };

  /**
   * Koppen voor een wijziging die zonder verbinding in de wachtrij mag (zie offline-core.js).
   * @param {object} [options] { key, label, base, patch }: idempotentiesleutel, omschrijving in de lijst, basisversie voor conflictcontrole, patch = samenvoegen.
   * @returns {object} De koppen (leeg als offline werken niet kan).
   */
  function headers({ key, label, base, patch } = {}) {
    if (!supported || !Core) return {};
    const HEADERS = Core.HEADERS;
    const out = { [HEADERS.queue]: '1' };
    if (key) out[HEADERS.key] = String(key);
    if (label) out[HEADERS.label] = encodeURIComponent(String(label).slice(0, 200));
    if (base) out[HEADERS.base] = String(base);
    if (patch) out[HEADERS.patch] = 'merge';
    return out;
  }

  /**
   * Stelt de service worker een vraag.
   * @param {object} question Bijv. { type: 'status' }.
   * @returns {Promise<object|null>} Het antwoord (null zonder service worker).
   */
  const ask = (question) => (supported ? common.offline(question) : Promise.resolve(null));
  /**
   * Meldt een luisteraar aan voor 'status' of 'synced'.
   * @param {string} type Soort gebeurtenis.
   * @param {Function} listener Wordt aangeroepen met de gegevens.
   * @returns {void}
   */
  const on = (type, listener) => { if (listeners[type]) listeners[type].push(listener); };
  /**
   * Roept de luisteraars van een gebeurtenis aan (een fout in een luisteraar stopt de rest niet).
   * @param {string} type Soort gebeurtenis.
   * @param {*} value De gegevens.
   * @returns {void}
   */
  const emit = (type, value) => listeners[type].forEach((listener) => { try { listener(value); } catch (error) { console.error(error); } });

  /**
   * Vraagt de stand van de wachtrij op en toont die.
   * @returns {Promise<object|null>} De stand.
   */
  async function refresh() {
    const queueStatus = await ask({ type: 'status' });
    if (queueStatus && !queueStatus.error) setStatus(queueStatus);
    return queueStatus;
  }
  /**
   * Verstuurt de wachtrij nu (zonder verbinding alleen de stand opvragen).
   * @returns {Promise<object|null>} De stand.
   */
  async function flush() {
    if (!navigator.onLine) return refresh();
    const queueStatus = await ask({ type: 'flush' });
    if (queueStatus && !queueStatus.error) setStatus(queueStatus);
    return queueStatus;
  }
  /**
   * Wijzigingen in de wachtrij.
   * @param {object} [filter] Extra velden voor de vraag aan de service worker.
   * @returns {Promise<object[]>} De items.
   */
  async function list(filter = {}) {
    const out = await ask({ type: 'list', ...filter });
    return (out && out.items) || [];
  }

  /**
   * Gegevens alvast ophalen zodat ze offline klaarstaan (de service worker
   * bewaart ze). Alleen met verbinding en als offline werken mag.
   * @param {string[]} urls Adressen om op te halen (hoogstens 40).
   * @param {string} [base] Relatief pad naar de app-root.
   * @returns {Promise<void>}
   */
  async function prefetch(urls, base = '') {
    if (!supported || !navigator.onLine) return;
    const queueStatus = state.status || await refresh();
    if (!queueStatus || !queueStatus.allowed) return;
    for (const url of [...new Set(urls)].slice(0, 40)) {
      try { await fetch(`${base}${url}`, { cache: 'no-store' }); } catch (error) { return; }
    }
  }

  // ---------- Knopje en lijst ----------
  /** Maakt het knopje rechtsonder en het paneel (één keer). */
  function build() {
    if (state.box || !document.body) return;
    const box = document.createElement('div');
    box.className = 'offline-box';
    box.hidden = true;
    box.innerHTML = '<button type="button" class="offline-pill" aria-expanded="false"></button><div class="offline-panel" hidden role="dialog" aria-label="Offline wijzigingen"></div>';
    document.body.appendChild(box);
    /**
     * Opent of sluit de lijst.
     * @returns {void}
     */
    box.querySelector('.offline-pill').onclick = () => toggle(!state.open);
    box.querySelector('.offline-panel').addEventListener('click', onPanelClick);
    /**
     * Sluit de lijst met Escape.
     * @param {KeyboardEvent} event De toets.
     */
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.open) toggle(false); });
    state.box = box;
  }

  /**
   * Opent of sluit de lijst met wijzigingen.
   * @param {boolean} open true = openen.
   */
  function toggle(open) {
    state.open = open;
    if (!state.box) return;
    state.box.querySelector('.offline-panel').hidden = !open;
    state.box.querySelector('.offline-pill').setAttribute('aria-expanded', String(open));
    if (open) renderPanel();
  }

  /**
   * Aantal met enkelvoud of meervoud.
   * @param {number} count Het aantal.
   * @param {string} one Tekst bij 1.
   * @param {string} more Tekst bij meer.
   * @returns {string} Bijv. "2 wijzigingen".
   */
  const plural = (count, one, more) => `${count} ${count === 1 ? one : more}`;

  /** Tekent het knopje: offline, wachtend, versturen of aandacht nodig (verborgen als er niets is). */
  function render() {
    build();
    if (!state.box) return;
    const queueStatus = state.status || { pending: 0, problems: 0, items: [] };
    const offline = !navigator.onLine;
    const pill = state.box.querySelector('.offline-pill');
    let text = '';
    let kind = '';
    if (queueStatus.problems) { text = `${plural(queueStatus.problems, 'wijziging vraagt', 'wijzigingen vragen')} aandacht`; kind = 'warn'; }
    else if (queueStatus.needsLogin && queueStatus.pending) { text = `Log opnieuw in om ${plural(queueStatus.pending, 'wijziging', 'wijzigingen')} te versturen`; kind = 'warn'; }
    else if (offline && queueStatus.pending) { text = `Offline · ${plural(queueStatus.pending, 'wijziging wacht', 'wijzigingen wachten')}`; kind = 'off'; }
    else if (offline) { text = 'Offline · wijzigingen worden bewaard'; kind = 'off'; }
    else if (queueStatus.pending) { text = `${plural(queueStatus.pending, 'wijziging', 'wijzigingen')} versturen…`; kind = 'busy'; }
    state.box.hidden = !text;
    pill.className = `offline-pill ${kind}`;
    pill.textContent = text;
    if (!text) toggle(false);
    else if (state.open) renderPanel();
  }

  /** Tekent de lijst met wijzigingen, met knoppen bij een conflict of fout. */
  function renderPanel() {
    const panel = state.box.querySelector('.offline-panel');
    const queueStatus = state.status || { items: [] };
    /**
     * Datum en tijd kort in het Nederlands.
     * @param {string} timestamp Tijdstip.
     * @returns {string} Bijv. "22-10-2026 10:15".
     */
    const when = (timestamp) => new Date(timestamp).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' });
    const STATE = { pending: 'Wacht op verbinding', conflict: 'Intussen door een ander gewijzigd', failed: 'Geweigerd' };
    const rows = queueStatus.items.map((item) => `<li class="offline-item ${esc(item.state)}">
        <b>${esc(item.label)}</b>
        <span class="muted small">${esc(STATE[item.state] || item.state)} · ${esc(when(item.createdAt))}</span>
        ${item.error ? `<span class="small">${esc(item.error)}${item.conflicts && item.conflicts.length ? ` Beiden wijzigden: ${esc(Core.fieldNames(item.conflicts).join(', '))}.` : ''}</span>` : ''}
        ${openLink(item)}
        ${item.state === 'conflict' ? `<span class="offline-actions"><button class="btn small" data-act="force" data-id="${esc(item.id)}">Mijn versie toch opslaan</button><button class="btn small ghost" data-act="discard" data-id="${esc(item.id)}">Weggooien</button></span>` : ''}
        ${item.state === 'failed' ? `<span class="offline-actions"><button class="btn small" data-act="retry" data-id="${esc(item.id)}">Opnieuw proberen</button><button class="btn small ghost" data-act="discard" data-id="${esc(item.id)}">Weggooien</button></span>` : ''}
      </li>`).join('');
    const intro = !navigator.onLine
      ? 'Je bent offline. Wat je wijzigt wordt op dit toestel bewaard en verstuurd zodra er weer verbinding is. Werkorders die je eerder met verbinding opende, kun je gewoon openen.'
      : queueStatus.needsLogin ? `Je sessie is verlopen. <a href="${esc(appHref('login'))}">Log opnieuw in</a> om de wijzigingen te versturen.`
        : queueStatus.pending ? 'Deze wijzigingen worden verstuurd.'
          : 'Deze wijzigingen konden niet worden opgeslagen. Kies per wijziging wat er moet gebeuren.';
    panel.innerHTML = `<p class="small">${intro}</p>${rows ? `<ul class="offline-list">${rows}</ul>` : ''}${navigator.onLine && queueStatus.pending ? '<button class="btn small primary" data-act="flush">Nu versturen</button>' : ''}`;
  }

  /**
   * Adres binnen de app (vanaf de app-root, ook onder een padprefix).
   * @param {string} relativePath Pad vanaf de app-root.
   * @returns {string} De volledige URL.
   */
  function appHref(relativePath) {
    const scriptTag = document.querySelector('script[src*="shared/offline.js"]');
    return scriptTag ? new URL(`../${relativePath}`, scriptTag.src).href : relativePath;
  }

  /**
   * Link naar het item waar de wijziging bij hoort (werkorder).
   * @param {object} item Wijziging uit de wachtrij.
   * @returns {string} HTML van de link (leeg als er geen is of de wijziging nog wacht).
   */
  function openLink(item) {
    const match = String(item.url || '').match(/^api\/workorders\/([A-Za-z0-9-]+)/);
    if (!match || item.state === 'pending') return '';
    return `<a class="small" href="${esc(appHref(`werkorders/?id=${encodeURIComponent(match[1])}`))}">Werkorder openen</a>`;
  }

  /**
   * Knoppen in het paneel: nu versturen, opnieuw proberen, toch opslaan of weggooien.
   * @param {MouseEvent} event De klik.
   * @returns {Promise<void>}
   */
  async function onPanelClick(event) {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const action = button.dataset.act;
    if (action === 'flush') return flush();
    if (action === 'discard' && !confirm('Deze wijziging weggooien? Ze wordt dan niet verstuurd.')) return;
    if (action === 'force' && !confirm('Je versie overschrijft wat een ander intussen heeft gewijzigd. Toch opslaan?')) return;
    button.disabled = true;
    const queueStatus = await ask(action === 'discard' ? { type: 'discard', id: button.dataset.id } : { type: 'retry', id: button.dataset.id, force: action === 'force' });
    if (queueStatus && !queueStatus.error) setStatus(queueStatus);
    // Weggegooid: de pagina toont misschien nog de weggegooide versie.
    if (action === 'discard') emit('synced', { discarded: true, id: button.dataset.id });
  }

  /**
   * Onthoudt en toont de stand van de wachtrij; zolang er iets wacht elke 30 s opnieuw proberen.
   * @param {object} queueStatus De stand van de service worker.
   */
  function setStatus(queueStatus) {
    state.status = queueStatus;
    render();
    emit('status', queueStatus);
    // Zolang er iets wacht en er verbinding is: elke 30 s opnieuw proberen.
    clearInterval(state.timer);
    if (queueStatus.pending && !queueStatus.needsLogin) state.timer = setInterval(() => { if (navigator.onLine) flush(); }, 30000);
  }

  if (supported) {
    serviceWorker.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'status' && message.status) setStatus(message.status);
      if (message.type === 'synced') emit('synced', message);
    });
    root.addEventListener('online', () => { render(); flush(); });
    root.addEventListener('offline', render);
    /**
     * Tekent het knopje en verstuurt wat wacht zodra de service worker klaar is.
     * @returns {void}
     */
    const start = () => { render(); serviceWorker.ready.then(() => flush()); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  root.AquatechOffline = { supported, headers, status: refresh, flush, list, prefetch, on };
})(window);
