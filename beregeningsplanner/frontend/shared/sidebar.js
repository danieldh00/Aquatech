// Vaste zijbalk met de modules voor beheerders en hoofdbeheerders, op elke
// pagina (in plaats van het tegeldashboard). Vereist dashboard/modules.js.
// Wie de zijbalk krijgt en welke modules erin staan volgt uit de rechten
// (api/me, shared/roles.js) en de uitgezette modules (api/config), net als
// de tegels. Om verspringen te voorkomen tekent de zijbalk eerst uit de
// laatste stand (localStorage) en daarna opnieuw met wat de server zegt.
//
// - Breed scherm: vast links, in te klappen tot een smalle iconenbalk
//   (per browser onthouden). Pagina's met <body data-nav-compact> (de
//   planner) beginnen ingeklapt.
// - Smal scherm (< 900px): lade van links via de menuknop in de kopbalk.
(function (root) {
  const tools = root.AquatechModuleTools;
  if (!tools || location.protocol === 'file:') return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Relatief pad naar de app-root, afgeleid van dit script ('' of '../').
  const script = document.currentScript;
  const base = script ? (script.getAttribute('src') || '').replace(/shared\/sidebar\.js(\?.*)?$/, '') : '';
  const CACHE = 'aquatech_nav';
  const COMPACT = 'aquatech_nav_compact';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* geen opslag */ } },
  };

  const body = document.body;
  let nav = null;

  function isCompact() {
    const saved = store.get(COMPACT);
    return saved == null ? body.hasAttribute('data-nav-compact') : saved === '1';
  }

  // Huidige module: de langste module-URL waar dit pad mee begint.
  function currentId(items) {
    const here = location.pathname;
    let best = null;
    let len = -1;
    for (const m of items) {
      const p = new URL(m.href, location.href).pathname;
      if ((here === p || here.startsWith(p)) && p.length > len) { best = m.id; len = p.length; }
    }
    return best;
  }

  function render(data) {
    // Alleen modules die er al zijn; geplande modules staan in Beheer >
    // Instellingen en komen pas in de zijbalk als ze klaar zijn.
    const items = [{ id: '', title: 'Overzicht', icon: 'home', status: 'actief', href: base || './' }]
      .concat(tools.visible(data.rights, data.disabled).filter((m) => m.status === 'actief' && m.href).map((m) => ({ ...m, href: m.href ? base + m.href : '' })));
    const profile = { id: 'profiel', href: `${base}profiel/` };
    const active = currentId(items.filter((m) => m.href).concat(data.profile ? [profile] : []));
    const link = (m) => {
      const label = `<span class="at-nav-ico">${tools.icon(m.icon)}</span><span class="at-nav-label">${esc(m.title)}</span>`;
      const cur = m.id === active ? ' aria-current="page"' : '';
      return `<a class="at-nav-item" href="${esc(m.href)}" title="${esc(m.title)}"${cur}>${label}</a>`;
    };
    const section = (title, list) => (list.length
      ? `<div class="at-nav-list">${title ? `<div class="at-nav-group">${esc(title)}</div>` : ''}${list.map(link).join('')}</div>`
      : '');
    if (!nav) {
      nav = document.createElement('nav');
      nav.className = 'at-nav';
      nav.id = 'at-nav';
      nav.setAttribute('aria-label', 'Modules');
      body.insertBefore(nav, body.firstChild);
      const backdrop = document.createElement('div');
      backdrop.className = 'at-nav-backdrop';
      backdrop.onclick = () => setOpen(false);
      body.insertBefore(backdrop, nav.nextSibling);
      addToggle();
      syncTopbarHeight();
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && body.classList.contains('nav-open')) setOpen(false); });
    }
    nav.innerHTML = `
      <div class="at-nav-head">
        <a class="at-nav-brand" href="${esc(base || './')}" title="Overzicht">
          <img class="at-nav-logo" src="${esc(base)}shared/logo-white.png" alt="AquaTech Service">
          <img class="at-nav-mark" src="${esc(base)}shared/schild-white.png" alt="AquaTech Service">
        </a>
        <button type="button" class="at-nav-close" aria-label="Menu sluiten" title="Menu sluiten">✕</button>
      </div>
      ${section('', items.filter((m) => m.status === 'actief' && m.group !== 'beheer'))}
      ${section('Beheer', items.filter((m) => m.status === 'actief' && m.group === 'beheer'))}
      ${data.profile ? `<div class="at-nav-list at-nav-foot">${link({ id: 'profiel', title: 'Mijn profiel', icon: 'user', status: 'actief', href: `${base}profiel/` })}</div>` : ''}
      <button type="button" class="at-nav-collapse" title="Zijbalk in- of uitklappen" aria-label="Zijbalk in- of uitklappen">
        <span class="at-nav-ico"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg></span><span class="at-nav-label">Inklappen</span>
      </button>`;
    nav.querySelector('.at-nav-close').onclick = () => setOpen(false);
    nav.querySelector('.at-nav-collapse').onclick = () => {
      const next = !body.classList.contains('nav-compact');
      body.classList.toggle('nav-compact', next);
      store.set(COMPACT, next ? '1' : '0');
      // Canvas-pagina's (planner) passen zich aan bij een resize.
      root.dispatchEvent(new Event('resize'));
    };
    body.classList.add('has-nav');
    body.classList.toggle('nav-compact', isCompact());
  }

  // De kop van de zijbalk volgt de hoogte van de kopbalk (die verschilt per
  // pagina en verandert bij een andere schermbreedte).
  function syncTopbarHeight() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const apply = () => document.documentElement.style.setProperty('--at-topbar-h', `${bar.getBoundingClientRect().height}px`);
    apply();
    if (root.ResizeObserver) new ResizeObserver(apply).observe(bar);
    else root.addEventListener('resize', apply);
  }

  // Menuknop vooraan in de kopbalk (alleen zichtbaar op een smal scherm).
  function addToggle() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'at-nav-toggle';
    btn.setAttribute('aria-label', 'Modules');
    btn.setAttribute('aria-controls', 'at-nav');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Modules';
    btn.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
    btn.onclick = () => setOpen(!body.classList.contains('nav-open'));
    bar.insertBefore(btn, bar.firstChild);
  }

  function setOpen(open) {
    body.classList.toggle('nav-open', open);
    const btn = document.querySelector('.at-nav-toggle');
    if (btn) btn.setAttribute('aria-expanded', String(open));
  }

  function remove() {
    if (nav) nav.remove();
    document.querySelectorAll('.at-nav-backdrop, .at-nav-toggle').forEach((el) => el.remove());
    nav = null;
    body.classList.remove('has-nav', 'nav-compact', 'nav-open');
  }

  // 1. Direct uit de cache (geen verspringen bij het laden van een pagina).
  let cached = null;
  try { cached = JSON.parse(store.get(CACHE) || 'null'); } catch (e) { /* kapotte cache */ }
  if (cached && tools.usesSidebar(cached.rights)) render(cached);

  // 2. Opnieuw met de echte rechten en instellingen.
  const getJson = (url) => fetch(base + url, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  Promise.all([getJson('api/me'), getJson('api/config')]).then(([me, config]) => {
    if (!me) return; // offline: laat de laatste stand staan
    // Mijn profiel alleen met een eigen account (niet met de toegangscode).
    const data = { rights: me.rights || [], disabled: (config && config.modules) || {}, profile: Boolean(me.preferences) };
    if (tools.usesSidebar(data.rights)) {
      store.set(CACHE, JSON.stringify(data));
      render(data);
    } else {
      store.set(CACHE, null);
      remove();
    }
  });

  root.AquatechNav = { open: () => setOpen(true), close: () => setOpen(false) };
})(window);
