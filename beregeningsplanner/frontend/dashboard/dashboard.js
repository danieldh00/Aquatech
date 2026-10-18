// Startpagina: tegels per module uit modules.js, het laatst bewerkte
// beregeningsplan en de versie. Alle URL's relatief (ingress).
(function () {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICONS = {
    sprinkler: '<path d="M12 21v-6"/><path d="M8 21h8"/><circle cx="12" cy="12" r="3"/><path d="M5 9c1.5-2 4-3.5 7-3.5S17.5 7 19 9"/><path d="M2.5 6C5 3.5 8.3 2 12 2s7 1.5 9.5 4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
    box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5"/><path d="M12 12v9"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M3 14h18"/><path d="M9 9v11"/>',
    shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    module: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  };
  const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.module}</svg>`;

  // Modules die een beheerder bij Beheer > Instellingen heeft uitgezet.
  let disabledModules = {};

  function renderModules(me) {
    const role = me && me.user ? me.user.role : null;
    const html = (window.AquatechModules || [])
      .filter((m) => (!m.role || m.role === role) && (m.id === 'beheer' || disabledModules[m.id] !== false))
      .map((m) => {
      const active = m.status === 'actief' && m.href;
      const body = `
        <span class="tile-icon">${icon(m.icon)}</span>
        <span class="tile-text">
          <span class="tile-title">${esc(m.title)}${active ? '' : ' <span class="badge">Binnenkort</span>'}</span>
          <span class="tile-desc">${esc(m.description || '')}</span>
        </span>`;
      return active
        ? `<a class="tile" href="${esc(m.href)}" data-module="${esc(m.id)}">${body}</a>`
        : `<div class="tile disabled" aria-disabled="true" data-module="${esc(m.id)}">${body}</div>`;
    }).join('');
    $('#modules').innerHTML = html;
  }

  // Het laatst bewerkte plan staat (per browser) in localStorage van de planner.
  function renderRecent() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem('aquatech-beregeningsplanner-v1') || 'null'); } catch (e) { /* geen opslag */ }
    if (!data || !data.meta) return;
    const areas = (data.areas || []).length;
    const sprinklers = (data.sprinklers || []).length;
    if (!areas && !sprinklers) return;
    const sub = [data.meta.customer, data.meta.address].filter(Boolean).map(esc).join(' · ');
    const el = $('#recent');
    el.innerHTML = `
      <h2>Verder werken</h2>
      <a class="tile recent-tile" href="beregening/">
        <span class="tile-icon">${icon('sprinkler')}</span>
        <span class="tile-text">
          <span class="tile-title">${esc(data.meta.name || 'Beregeningsplan')}</span>
          <span class="tile-desc">${sub ? sub + ' · ' : ''}${areas} vlak${areas === 1 ? '' : 'ken'}, ${sprinklers} sproeier${sprinklers === 1 ? '' : 's'}</span>
        </span>
      </a>`;
    el.hidden = false;
  }

  // De eigen plannen op de server (alleen die van deze gebruiker).
  async function renderMyPlans(me) {
    if (!me || !me.user || location.protocol === 'file:') return;
    let items = [];
    try {
      const res = await fetch('api/plans', { cache: 'no-store' });
      if (res.ok) items = (await res.json()).items || [];
    } catch (e) { return; }
    if (!items.length) return;
    const when = (iso) => new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
    $('#myplans-list').innerHTML = items.slice(0, 6).map((p) => `
      <a class="tile" href="beregening/?plan=${encodeURIComponent(p.id)}">
        <span class="tile-icon">${icon('sprinkler')}</span>
        <span class="tile-text">
          <span class="tile-title">${esc(p.title)}</span>
          <span class="tile-desc">${[p.customer, p.address].filter(Boolean).map(esc).join(' · ')}${p.customer || p.address ? ' · ' : ''}gewijzigd ${esc(when(p.updatedAt))}</span>
        </span>
      </a>`).join('');
    $('#myplans').hidden = false;
  }

  function showVersion() {
    if (location.protocol === 'file:') return;
    fetch('api/health', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && d.version) $('#version').textContent = `versie ${d.version}`; })
      .catch(() => {});
  }

  function loadConfig() {
    if (location.protocol === 'file:') return Promise.resolve();
    return fetch('api/config', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (c && c.modules) disabledModules = c.modules; })
      .catch(() => {});
  }

  renderModules(null);
  renderRecent();
  showVersion();
  Promise.all([window.AquatechAccount.load(''), loadConfig()]).then(([me]) => {
    renderModules(me);
    renderMyPlans(me);
  });
})();
