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
  const sw = navigator.serviceWorker;
  const supported = Boolean(sw && root.isSecureContext && common && common.offline && Core && location.protocol !== 'file:');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const listeners = { status: [], synced: [] };
  const state = { status: null, open: false, el: null, timer: null };

  function headers({ key, label, base, patch } = {}) {
    if (!supported || !Core) return {};
    const H = Core.HEADERS;
    const out = { [H.queue]: '1' };
    if (key) out[H.key] = String(key);
    if (label) out[H.label] = encodeURIComponent(String(label).slice(0, 200));
    if (base) out[H.base] = String(base);
    if (patch) out[H.patch] = 'merge';
    return out;
  }

  const ask = (msg) => (supported ? common.offline(msg) : Promise.resolve(null));
  const on = (type, fn) => { if (listeners[type]) listeners[type].push(fn); };
  const emit = (type, v) => listeners[type].forEach((fn) => { try { fn(v); } catch (e) { console.error(e); } });

  async function refresh() {
    const st = await ask({ type: 'status' });
    if (st && !st.error) setStatus(st);
    return st;
  }
  async function flush() {
    if (!navigator.onLine) return refresh();
    const st = await ask({ type: 'flush' });
    if (st && !st.error) setStatus(st);
    return st;
  }
  async function list(filter = {}) {
    const out = await ask({ type: 'list', ...filter });
    return (out && out.items) || [];
  }

  /**
   * Gegevens alvast ophalen zodat ze offline klaarstaan (de service worker
   * bewaart ze). Alleen met verbinding en als offline werken mag.
   */
  async function prefetch(urls, base = '') {
    if (!supported || !navigator.onLine) return;
    const st = state.status || await refresh();
    if (!st || !st.allowed) return;
    for (const u of [...new Set(urls)].slice(0, 40)) {
      try { await fetch(`${base}${u}`, { cache: 'no-store' }); } catch (e) { return; }
    }
  }

  // ---------- Knopje en lijst ----------
  function build() {
    if (state.el || !document.body) return;
    const el = document.createElement('div');
    el.className = 'offline-box';
    el.hidden = true;
    el.innerHTML = '<button type="button" class="offline-pill" aria-expanded="false"></button><div class="offline-panel" hidden role="dialog" aria-label="Offline wijzigingen"></div>';
    document.body.appendChild(el);
    el.querySelector('.offline-pill').onclick = () => toggle(!state.open);
    el.querySelector('.offline-panel').addEventListener('click', onPanelClick);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open) toggle(false); });
    state.el = el;
  }

  function toggle(open) {
    state.open = open;
    if (!state.el) return;
    state.el.querySelector('.offline-panel').hidden = !open;
    state.el.querySelector('.offline-pill').setAttribute('aria-expanded', String(open));
    if (open) renderPanel();
  }

  const n = (k, one, more) => `${k} ${k === 1 ? one : more}`;

  function render() {
    build();
    if (!state.el) return;
    const st = state.status || { pending: 0, problems: 0, items: [] };
    const offline = !navigator.onLine;
    const pill = state.el.querySelector('.offline-pill');
    let text = '';
    let cls = '';
    if (st.problems) { text = `${n(st.problems, 'wijziging vraagt', 'wijzigingen vragen')} aandacht`; cls = 'warn'; }
    else if (st.needsLogin && st.pending) { text = `Log opnieuw in om ${n(st.pending, 'wijziging', 'wijzigingen')} te versturen`; cls = 'warn'; }
    else if (offline && st.pending) { text = `Offline · ${n(st.pending, 'wijziging wacht', 'wijzigingen wachten')}`; cls = 'off'; }
    else if (offline) { text = 'Offline · wijzigingen worden bewaard'; cls = 'off'; }
    else if (st.pending) { text = `${n(st.pending, 'wijziging', 'wijzigingen')} versturen…`; cls = 'busy'; }
    state.el.hidden = !text;
    pill.className = `offline-pill ${cls}`;
    pill.textContent = text;
    if (!text) toggle(false);
    else if (state.open) renderPanel();
  }

  function renderPanel() {
    const panel = state.el.querySelector('.offline-panel');
    const st = state.status || { items: [] };
    const when = (t) => new Date(t).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' });
    const STATE = { pending: 'Wacht op verbinding', conflict: 'Intussen door een ander gewijzigd', failed: 'Geweigerd' };
    const rows = st.items.map((it) => `<li class="offline-item ${esc(it.state)}">
        <b>${esc(it.label)}</b>
        <span class="muted small">${esc(STATE[it.state] || it.state)} · ${esc(when(it.createdAt))}</span>
        ${it.error ? `<span class="small">${esc(it.error)}${it.conflicts && it.conflicts.length ? ` Beiden wijzigden: ${esc(Core.fieldNames(it.conflicts).join(', '))}.` : ''}</span>` : ''}
        ${openLink(it)}
        ${it.state === 'conflict' ? `<span class="offline-actions"><button class="btn small" data-act="force" data-id="${esc(it.id)}">Mijn versie toch opslaan</button><button class="btn small ghost" data-act="discard" data-id="${esc(it.id)}">Weggooien</button></span>` : ''}
        ${it.state === 'failed' ? `<span class="offline-actions"><button class="btn small" data-act="retry" data-id="${esc(it.id)}">Opnieuw proberen</button><button class="btn small ghost" data-act="discard" data-id="${esc(it.id)}">Weggooien</button></span>` : ''}
      </li>`).join('');
    const intro = !navigator.onLine
      ? 'Je bent offline. Wat je wijzigt wordt op dit toestel bewaard en verstuurd zodra er weer verbinding is. Werkorders die je eerder met verbinding opende, kun je gewoon openen.'
      : st.needsLogin ? `Je sessie is verlopen. <a href="${esc(appHref('login'))}">Log opnieuw in</a> om de wijzigingen te versturen.`
        : st.pending ? 'Deze wijzigingen worden verstuurd.'
          : 'Deze wijzigingen konden niet worden opgeslagen. Kies per wijziging wat er moet gebeuren.';
    panel.innerHTML = `<p class="small">${intro}</p>${rows ? `<ul class="offline-list">${rows}</ul>` : ''}${navigator.onLine && st.pending ? '<button class="btn small primary" data-act="flush">Nu versturen</button>' : ''}`;
  }

  // Adres binnen de app (vanaf de app-root, ook onder een padprefix).
  function appHref(rel) {
    const s = document.querySelector('script[src*="shared/offline.js"]');
    return s ? new URL(`../${rel}`, s.src).href : rel;
  }

  // Link naar het item waar de wijziging bij hoort (werkorder).
  function openLink(it) {
    const m = String(it.url || '').match(/^api\/workorders\/([A-Za-z0-9-]+)/);
    if (!m || it.state === 'pending') return '';
    return `<a class="small" href="${esc(appHref(`werkorders/?id=${encodeURIComponent(m[1])}`))}">Werkorder openen</a>`;
  }

  async function onPanelClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'flush') return flush();
    if (act === 'discard' && !confirm('Deze wijziging weggooien? Ze wordt dan niet verstuurd.')) return;
    if (act === 'force' && !confirm('Je versie overschrijft wat een ander intussen heeft gewijzigd. Toch opslaan?')) return;
    b.disabled = true;
    const st = await ask(act === 'discard' ? { type: 'discard', id: b.dataset.id } : { type: 'retry', id: b.dataset.id, force: act === 'force' });
    if (st && !st.error) setStatus(st);
    // Weggegooid: de pagina toont misschien nog de weggegooide versie.
    if (act === 'discard') emit('synced', { discarded: true, id: b.dataset.id });
  }

  function setStatus(st) {
    state.status = st;
    render();
    emit('status', st);
    // Zolang er iets wacht en er verbinding is: elke 30 s opnieuw proberen.
    clearInterval(state.timer);
    if (st.pending && !st.needsLogin) state.timer = setInterval(() => { if (navigator.onLine) flush(); }, 30000);
  }

  if (supported) {
    sw.addEventListener('message', (e) => {
      const msg = e.data || {};
      if (msg.type === 'status' && msg.status) setStatus(msg.status);
      if (msg.type === 'synced') emit('synced', msg);
    });
    root.addEventListener('online', () => { render(); flush(); });
    root.addEventListener('offline', render);
    const start = () => { render(); sw.ready.then(() => flush()); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  root.AquatechOffline = { supported, headers, status: refresh, flush, list, prefetch, on };
})(window);
