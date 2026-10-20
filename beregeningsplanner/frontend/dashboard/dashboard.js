// Startpagina: tegels per module uit modules.js, het laatst bewerkte
// beregeningsplan en de versie. Alle URL's relatief (werkt ook onder een padprefix).
(function () {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const { icon } = window.AquatechModuleTools;

  // Modules die een beheerder bij Beheer > Instellingen heeft uitgezet.
  let disabledModules = {};

  function renderModules(me) {
    // Rechten komen van de server (api/me, zie shared/roles.js).
    const rights = (me && me.rights) || [];
    // Beheerders hebben de zijbalk (shared/sidebar.js); geen tegels dubbel.
    // Zolang api/me nog niet binnen is, geldt wat de zijbalk uit de cache koos.
    const sidebar = me ? window.AquatechModuleTools.usesSidebar(rights) : document.body.classList.contains('has-nav');
    $('#modules-section').hidden = sidebar;
    $('#intro-text').textContent = sidebar ? 'Kies links een onderdeel om mee te werken.' : 'Kies een onderdeel om mee te werken.';
    if (sidebar) return;
    const html = window.AquatechModuleTools.visible(rights, disabledModules)
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
    try { data = JSON.parse(localStorage.getItem(`aquatech-beregeningsplanner-v1${window.AquatechEnv ? window.AquatechEnv.storageSuffix() : ''}`) || 'null'); } catch (e) { /* geen opslag */ }
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
    window.AquatechSupport.load(me);
  });
})();
